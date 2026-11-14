#!/usr/bin/env node
// make-voices.mjs — ボイスキーホルダーモードの音声（voices 区画の中身）を作る。USB で本体へ書くこともできる。
// 入れ物の形と本体側の展開は devices/mcu/esp32_s3/toytalker_mini_v0.7/VoiceKeyholder.h。
//
// 使い方（リポジトリルートから。ffmpeg が要る。--flash には Arduino の esp32 コアに入っている esptool を使う）:
//   node devices/mcu/esp32_s3/tools/make-voices.mjs a.mp3 b.wav c.m4a            # voices.bin を作る（既定は .local/voices/voices.bin）
//   node devices/mcu/esp32_s3/tools/make-voices.mjs *.mp3 --out my.bin           # 出力先を変える
//   node devices/mcu/esp32_s3/tools/make-voices.mjs *.mp3 --flash COM12          # 作って、そのまま本体の voices 区画へ書く
//   node devices/mcu/esp32_s3/tools/make-voices.mjs --erase --flash COM12        # voices 区画を空にする（声なしに戻す）
//
// 音声は 24kHz モノラルにそろえ、前後の無音を落とし、山を PEAK にそろえてから IMA ADPCM（4bit）にする。
// 24kHz で 1 秒 12KB。区画（partitions.csv の voices）に入らなければ止まる。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SAMPLE_RATE = 24000;   // 本体の再生（SAMPLE_RATE_TTS）と同じ。違う件は本体が鳴らさない
const PEAK = 16000;          // 山の高さ。会話の音声（Cartesia の山 13000〜17000）にそろえる。音量は本体側で上げる
const SILENCE = 300;         // これより小さい音は、前後の無音として落とす
const KEEP_MS = 30;          // 落とした無音の内側に残す長さ
const FADE_MS = 8;           // 先頭と末尾のフェード（プチッという音を防ぐ）
const MAX_CLIPS = 16;
const HEADER_BYTES = 16, ENTRY_BYTES = 16;
const CODEC_ADPCM = 1;

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767];
const INDEX_MOVES = [-1, -1, -1, -1, 2, 4, 6, 8];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// IMA ADPCM。予測値 0・段 0 から始め、1 バイトに下位 → 上位の順で 2 サンプル（VoiceKeyholder.h の AdpcmDecoder と対）
function encodeAdpcm(pcm) {
  const out = new Uint8Array(Math.ceil(pcm.length / 2));
  let predicted = 0, index = 0;
  for (let i = 0; i < pcm.length; i++) {
    const step = STEPS[index];
    let diff = pcm[i] - predicted, nibble = 0, moved = step >> 3;
    if (diff < 0) { nibble = 8; diff = -diff; }
    if (diff >= step) { nibble |= 4; diff -= step; moved += step; }
    if (diff >= step >> 1) { nibble |= 2; diff -= step >> 1; moved += step >> 1; }
    if (diff >= step >> 2) { nibble |= 1; moved += step >> 2; }
    predicted = clamp(predicted + (nibble & 8 ? -moved : moved), -32768, 32767);
    index = clamp(index + INDEX_MOVES[nibble & 7], 0, 88);
    out[i >> 1] |= i & 1 ? nibble << 4 : nibble;
  }
  return out;
}

function decodeAdpcm(bytes, samples) {
  const out = new Int16Array(samples);
  let predicted = 0, index = 0;
  for (let i = 0; i < samples; i++) {
    const nibble = i & 1 ? bytes[i >> 1] >> 4 : bytes[i >> 1] & 0x0f;
    const step = STEPS[index];
    let diff = step >> 3;
    if (nibble & 1) diff += step >> 2;
    if (nibble & 2) diff += step >> 1;
    if (nibble & 4) diff += step;
    predicted = clamp(predicted + (nibble & 8 ? -diff : diff), -32768, 32767);
    index = clamp(index + INDEX_MOVES[nibble & 7], 0, 88);
    out[i] = predicted;
  }
  return out;
}

// zlib と同じ CRC32
function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (~crc) >>> 0;
}

function loadPcm(file) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"],
    { maxBuffer: 256 * 1024 * 1024 });
  let pcm = new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1);
  // 前後の無音を落とす
  const keep = Math.round(SAMPLE_RATE * KEEP_MS / 1000);
  let first = 0, last = pcm.length - 1;
  while (first < pcm.length && Math.abs(pcm[first]) < SILENCE) first++;
  while (last > first && Math.abs(pcm[last]) < SILENCE) last--;
  if (first >= pcm.length) throw new Error(`${file}: 音が入っていない`);
  pcm = Int16Array.from(pcm.subarray(Math.max(0, first - keep), Math.min(pcm.length, last + 1 + keep)));
  // 山をそろえ、先頭と末尾をフェードする
  let peak = 1;
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  const scale = PEAK / peak, fade = Math.min(Math.round(SAMPLE_RATE * FADE_MS / 1000), pcm.length >> 1);
  for (let i = 0; i < pcm.length; i++) {
    const edge = Math.min(i, pcm.length - 1 - i);
    pcm[i] = Math.round(pcm[i] * scale * (edge < fade ? edge / fade : 1));
  }
  return pcm;
}

function snrDb(a, b) {
  let signal = 0, noise = 0;
  for (let i = 0; i < a.length; i++) { signal += a[i] * a[i]; noise += (a[i] - b[i]) ** 2; }
  return noise === 0 ? Infinity : 10 * Math.log10(signal / noise);
}

function voicesPartition(repoRoot) {
  const csv = readFileSync(join(repoRoot, "devices/mcu/esp32_s3/toytalker_mini_v0.7/partitions.csv"), "utf8");
  for (const line of csv.split(/\r?\n/)) {
    const cols = line.split(",").map((c) => c.trim());
    if (cols[0] === "voices") return { offset: Number(cols[3]), size: Number(cols[4]) };
  }
  throw new Error("partitions.csv に voices が無い");
}

function findEsptool() {
  const base = join(process.env.LOCALAPPDATA || join(process.env.HOME || "", "Library"), "Arduino15/packages/esp32/tools/esptool_py");
  if (!existsSync(base)) throw new Error(`esptool が見つからない: ${base}`);
  for (const version of readdirSync(base).sort().reverse()) {
    for (const name of ["esptool.exe", "esptool"]) {
      if (existsSync(join(base, version, name))) return join(base, version, name);
    }
  }
  throw new Error(`esptool が見つからない: ${base}`);
}

// ---- main ----
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
const args = process.argv.slice(2);
const inputs = [];
let out = join(repoRoot, ".local/voices/voices.bin"), port = null, erase = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") out = resolve(args[++i]);
  else if (args[i] === "--flash") port = args[++i];
  else if (args[i] === "--erase") erase = true;
  else if (args[i].startsWith("--")) { console.error(`unknown option: ${args[i]}`); process.exit(2); }
  else inputs.push(args[i]);
}
const partition = voicesPartition(repoRoot);

let image;
if (erase) {
  if (!port) { console.error("--erase は --flash <ポート> と一緒に使う"); process.exit(2); }
  image = Buffer.alloc(4096, 0xff);  // 先頭のセクタを消せば、本体は「声なし」と見る
  console.log("voices 区画の先頭を空にする");
} else {
  if (inputs.length === 0 || inputs.length > MAX_CLIPS) {
    console.error(`音声ファイルを 1〜${MAX_CLIPS} 個渡す（usage はこのファイルの先頭）`);
    process.exit(2);
  }
  const clips = inputs.map((file) => {
    const pcm = loadPcm(file);
    const data = encodeAdpcm(pcm);
    return { file, samples: pcm.length, data, snr: snrDb(pcm, decodeAdpcm(data, pcm.length)) };
  });
  const tableEnd = HEADER_BYTES + clips.length * ENTRY_BYTES;
  const total = tableEnd + clips.reduce((sum, c) => sum + c.data.length, 0);
  image = Buffer.alloc(total);
  let offset = tableEnd;
  clips.forEach((c, i) => {
    const e = HEADER_BYTES + i * ENTRY_BYTES;
    image.writeUInt32LE(offset, e);
    image.writeUInt32LE(c.data.length, e + 4);
    image.writeUInt8(CODEC_ADPCM, e + 8);
    image.writeUInt16LE(SAMPLE_RATE, e + 10);
    image.writeUInt32LE(c.samples, e + 12);
    image.set(c.data, offset);
    console.log(`${String(i).padStart(2)}  ${(c.samples / SAMPLE_RATE).toFixed(2).padStart(6)} 秒  ${String(c.data.length).padStart(7)} バイト  SNR ${c.snr.toFixed(1)} dB  ${c.file}`);
    offset += c.data.length;
  });
  image.write("TTVK", 0, "latin1");
  image.writeUInt8(1, 4);
  image.writeUInt8(clips.length, 5);
  image.writeUInt32LE(total, 8);
  image.writeUInt32LE(crc32(image.subarray(HEADER_BYTES)), 12);
  const seconds = clips.reduce((sum, c) => sum + c.samples, 0) / SAMPLE_RATE;
  console.log(`合計 ${clips.length} 件 ${seconds.toFixed(1)} 秒 ${total} バイト（区画 ${partition.size} バイトの ${(total * 100 / partition.size).toFixed(0)}%）`);
  if (total > partition.size) {
    console.error(`❌ 区画に入らない（${total - partition.size} バイト超過）。件数か長さを減らす`);
    process.exit(1);
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, image);
  console.log(`書き出し: ${out}`);
}

if (port) {
  let file = out;
  if (erase) {
    file = join(repoRoot, ".local/voices/erase.bin");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, image);
  }
  const offsetHex = "0x" + partition.offset.toString(16);
  console.log(`本体（${port}）の ${offsetHex} へ書く...`);
  execFileSync(findEsptool(), ["--chip", "esp32s3", "--port", port, "--baud", "921600", "write_flash", offsetHex, file],
    { stdio: "inherit" });
}
