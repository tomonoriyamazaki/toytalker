// keyholder.mjs — ボイスキーホルダーモードの声を、アプリから機器ごとに足す・消す（docs/esp32-firmware.md の「ボイスキーホルダーモード」）。
// 読み上げ Lambda の入口（index.mjs）が、本文に keyholder があるときここへ渡す。
//
//   { keyholder: { action: "list",    device_id } }                       いまの一覧と空き
//   { keyholder: { action: "add",     device_id, text, voice_id } }       文を声にして足す（費用は読み上げと同じ記録）。試聴用の WAV も返す
//   { keyholder: { action: "remove",  device_id, clip_id } }              1件消す
//   { keyholder: { action: "preview", device_id, clip_id } }              入っている声を WAV で返す（作り直さないので無料）
//
// 置き場（ファーム配布のバケット。本体は OTA と同じく署名付き URL で直接取る）:
//   esp32s3/voices/<機器>/clips/<clip_id>.adpcm   1件ぶんの ADPCM（本体が鳴らすのと同じデータ。試聴もここから展開する）
//   esp32s3/voices/<機器>/voices.bin              本体の voices 区画に入れるイメージ（足す・消すたびに組み直す）
// 設定は devices の行の keyholder（rev・lines・image）。本体へ渡すのは鍵発行 Lambda（toytalk-soniox-stt-lambda）で、
// 本体が名乗る印（vk）が image.crc と違えば voices.bin の URL を返す。
import { createHash, randomBytes } from "node:crypto";
import { GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { tableName } from "../shared/tables.mjs";
import { ownerGate } from "../shared/auth.mjs";
import { checkBalance, NO_BALANCE } from "../shared/wallet.mjs";
import { errorStatus } from "../shared/trace.mjs";
import {
  SAMPLE_RATE, MAX_CLIPS, ENTRY_BYTES, encodeAdpcm, decodeAdpcm, shapePcm, buildImage, imageBytes, imageCrcHex,
} from "../shared/voice-image.mjs";
import { synthesizePcm } from "./pcm-tts.mjs";

const s3 = new S3Client({ region: "ap-northeast-1" });
const BUCKET = process.env.FIRMWARE_BUCKET || "toytalker-firmware";
const DEVICES_TABLE = tableName("devices");
const VOICES_TABLE = tableName("voices");

// 本体の voices 区画の大きさ（devices/mcu/esp32_s3/toytalker_mini_v0.7/partitions.csv の voices）。これを超えるイメージは本体が受け取らない
const VOICES_PARTITION_BYTES = 0x60000;
const ADPCM_BYTES_PER_SEC = SAMPLE_RATE / 2;
const MAX_TEXT_CHARS = 80;
const MIN_ROOM_BYTES = ADPCM_BYTES_PER_SEC / 2;  // 空きが 0.5 秒ぶんも無ければ、作る前に断る（作ってから入らないと費用だけかかる）

const prefix = (deviceId) => `esp32s3/voices/${deviceId.replace(/[^A-Za-z0-9]/g, "")}`;
const clipKey = (deviceId, clipId) => `${prefix(deviceId)}/clips/${clipId}.adpcm`;
const imageKey = (deviceId) => `${prefix(deviceId)}/voices.bin`;

const reply = (statusCode, body) => ({ statusCode, body: typeof body === "string" ? { error: body } : body });

function wavBase64(pcm) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const head = Buffer.alloc(44);
  head.write("RIFF", 0, "ascii"); head.writeUInt32LE(36 + data.length, 4); head.write("WAVEfmt ", 8, "ascii");
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22);
  head.writeUInt32LE(SAMPLE_RATE, 24); head.writeUInt32LE(SAMPLE_RATE * 2, 28); head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34);
  head.write("data", 36, "ascii"); head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]).toString("base64");
}

const linesOf = (row) => (Array.isArray(row.keyholder?.lines) ? row.keyholder.lines : []);
const usedBytes = (lines) => imageBytes(lines.map((l) => l.bytes));

// アプリへ返す形。installed は「本体が最後に名乗った印が、いまのイメージと同じか」（イメージが無ければ null）
function publicState(row) {
  const lines = linesOf(row);
  const used = usedBytes(lines);
  const image = row.keyholder?.image ?? null;
  return {
    lines: lines.map((l) => ({
      clip_id: l.clip_id, text: l.text, voice_id: l.voice_id, voice_label: l.voice_label,
      seconds: Math.round(l.samples / SAMPLE_RATE * 10) / 10,
    })),
    used_bytes: used,
    capacity_bytes: VOICES_PARTITION_BYTES,
    seconds_left: Math.max(0, Math.floor((VOICES_PARTITION_BYTES - used - ENTRY_BYTES) / ADPCM_BYTES_PER_SEC * 10) / 10),
    max_lines: MAX_CLIPS,
    // 本体が声の置き場を持つ版（0.7.33 以降＋新しい区画）で起動したことがあるか。無ければ、足しても本体には入らない
    device_ready: typeof row.voices_crc === "string",
    // 本体に、いまの一覧とは別の声が入っている（USB で書いた声など）。一覧が空のときにアプリが「足すと置き換わる」と知らせる
    device_has_voices: typeof row.voices_crc === "string" && row.voices_crc !== "none" && row.voices_crc !== "00000000",
    installed: image ? row.voices_crc === image.crc : null,
    updated_at: image?.updated_at ?? null,
  };
}

async function loadClip(deviceId, line) {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: clipKey(deviceId, line.clip_id) }));
  const data = await res.Body.transformToByteArray();
  if (data.length !== line.bytes) throw new Error(`clip ${line.clip_id}: size mismatch`);
  return { data, samples: line.samples };
}

// イメージを組み直して置き、devices の行を書き換える。他の端末が同時に書き換えていたら false（rev が合わない）
async function saveLines(ddb, row, lines, clips) {
  const deviceId = row.device_id;
  const image = buildImage(clips);
  await s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: imageKey(deviceId), Body: image, ContentType: "application/octet-stream" }));
  const prev = row.keyholder?.rev ?? 0;
  const keyholder = {
    rev: prev + 1,
    lines,
    image: {
      key: imageKey(deviceId), size: image.length, count: clips.length, crc: imageCrcHex(image),
      sha256: createHash("sha256").update(image).digest("hex"), updated_at: new Date().toISOString(),
    },
  };
  try {
    await ddb.send(new UpdateCommand({
      TableName: DEVICES_TABLE,
      Key: { device_id: deviceId },
      UpdateExpression: "SET #k = :k",
      ConditionExpression: "attribute_exists(device_id) AND (attribute_not_exists(#k) OR #k.#r = :prev)",
      ExpressionAttributeNames: { "#k": "keyholder", "#r": "rev" },
      ExpressionAttributeValues: { ":k": keyholder, ":prev": prev },
    }));
  } catch (e) {
    if (e.name === "ConditionalCheckFailedException") return null;
    throw e;
  }
  return { ...row, keyholder };
}

async function add({ req, row, identity, ownerId, trace, ddb, deps }) {
  const deviceId = row.device_id;
  const text = typeof req.text === "string" ? req.text.replace(/\s+/g, " ").trim() : "";
  const voiceId = typeof req.voice_id === "string" ? req.voice_id : "";
  const chars = [...text].length;
  trace.set({ voice_id: voiceId || null, text_chars: chars });
  if (!text) return reply(400, "text is required");
  if (chars > MAX_TEXT_CHARS) return reply(400, "text_too_long");
  if (!voiceId) return reply(400, "voice_id is required");

  const lines = linesOf(row);
  if (lines.length >= MAX_CLIPS) return reply(409, "full");
  const room = VOICES_PARTITION_BYTES - usedBytes(lines) - ENTRY_BYTES;
  if (room < MIN_ROOM_BYTES) return reply(409, "full");
  // 残高が0以下なら作らない（読み上げと同じ。docs/pricing-and-cost-model.md 11.3）
  if (!(await checkBalance(ownerId)).ok) return reply(402, NO_BALANCE);

  const voice = (await ddb.send(new GetCommand({ TableName: VOICES_TABLE, Key: { voice_id: voiceId } }))).Item;
  if (!voice) return reply(404, "voice_not_found");
  // 他人のクローンボイスは使えない。system 製と所有者なしの行は誰でも（index.mjs の読み上げと同じ）
  if (identity.auth === "user" && voice.owner_id && voice.owner_id !== "system" && voice.owner_id !== ownerId) return reply(403, "not_owner");
  const cfg = deps.ttsConfigFor(voice.provider);
  trace.set({ tts: cfg.ttsVendor });

  let raw;
  try {
    raw = await synthesizePcm({ vendor: cfg.ttsVendor, model: cfg.ttsModel, voice: voice.vendor_id ?? "default", text });
  } catch (e) {
    trace.ext(cfg.ttsVendor, { status: errorStatus(e), error: true });
    trace.error("tts_primary", e);
    return reply(502, "tts_failed");
  }
  trace.mark("tts_done");
  // 作った時点で費用はかかっているので、この後で入らなくても記録する
  await deps.trackTtsCost({ ownerId, ttsVendor: cfg.ttsVendor, ttsModel: cfg.ttsModel, text, pcmBytes: raw.length * 2 });
  trace.mark("usage_saved");

  const pcm = shapePcm(raw);
  if (!pcm) return reply(502, "no_sound");
  const data = encodeAdpcm(pcm);
  trace.set({ clip_bytes: data.length });
  if (data.length > room) {
    return reply(409, { error: "too_long", seconds: Math.round(pcm.length / SAMPLE_RATE * 10) / 10, state: publicState(row) });
  }

  const clipId = randomBytes(8).toString("hex");
  const [existing] = await Promise.all([
    Promise.all(lines.map((l) => loadClip(deviceId, l))),
    s3.send(new PutObjectCommand({ Bucket: BUCKET, Key: clipKey(deviceId, clipId), Body: data, ContentType: "application/octet-stream" })),
  ]);
  const line = {
    clip_id: clipId, text, voice_id: voiceId, voice_label: String(voice.label ?? voiceId).slice(0, 64),
    samples: pcm.length, bytes: data.length,
  };
  const saved = await saveLines(ddb, row, [...lines, line], [...existing, { data, samples: pcm.length }]);
  if (!saved) return reply(409, "conflict");
  // 試聴は ADPCM を展開した音（本体が鳴らすのと同じ）
  return reply(200, { ok: true, clip_id: clipId, audio_b64: wavBase64(decodeAdpcm(data, pcm.length)), state: publicState(saved) });
}

async function remove({ req, row, ddb }) {
  const deviceId = row.device_id;
  const lines = linesOf(row);
  const rest = lines.filter((l) => l.clip_id !== req.clip_id);
  if (rest.length === lines.length) return reply(404, "clip_not_found");
  const clips = await Promise.all(rest.map((l) => loadClip(deviceId, l)));
  const saved = await saveLines(ddb, row, rest, clips);
  if (!saved) return reply(409, "conflict");
  // 行から外れた後で消す（失敗しても一覧には出ない。残るのは使われない小さなファイルだけ）
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: clipKey(deviceId, req.clip_id) }))
    .catch((e) => console.warn(`[keyholder] clip delete failed: ${e.name}`));
  return reply(200, { ok: true, state: publicState(saved) });
}

async function preview({ req, row }) {
  const line = linesOf(row).find((l) => l.clip_id === req.clip_id);
  if (!line) return reply(404, "clip_not_found");
  const clip = await loadClip(row.device_id, line);
  return reply(200, { ok: true, clip_id: line.clip_id, audio_b64: wavBase64(decodeAdpcm(clip.data, clip.samples)) });
}

/**
 * 戻り値は { statusCode, body }（body は JSON にするオブジェクト）。
 * deps: { ttsConfigFor(provider) → { ttsVendor, ttsModel }, trackTtsCost({ ownerId, ttsVendor, ttsModel, text, pcmBytes }) }
 */
export async function handleKeyholder({ req, identity, ownerId, trace, ddb, deps }) {
  const action = typeof req?.action === "string" ? req.action : "";
  const deviceId = typeof req?.device_id === "string" ? req.device_id.slice(0, 64) : "";
  trace.set({ keyholder: action.slice(0, 16), device_id: deviceId || null });
  if (!deviceId) return reply(400, "device_id is required");
  if (!["list", "add", "remove", "preview"].includes(action)) return reply(400, "unknown action");

  const row = (await ddb.send(new GetCommand({ TableName: DEVICES_TABLE, Key: { device_id: deviceId } }))).Item;
  if (!row) return reply(404, "device_not_found");
  const gate = ownerGate(identity, ownerId, row, { requireClaim: true });
  if (gate) return reply(gate.statusCode, gate.error);

  if (action === "list") return reply(200, { ok: true, state: publicState(row) });
  if (action === "add") return add({ req, row, identity, ownerId, trace, ddb, deps });
  if (action === "remove") return remove({ req, row, ddb });
  return preview({ req, row });
}
