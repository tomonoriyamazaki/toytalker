#!/usr/bin/env node
// make-voices.mjs — ボイスキーホルダーモードの音声（voices 区画の中身）を作る。USB で本体へ書くこともできる。
// 入れ物の形と本体側の展開は devices/mcu/esp32_s3/toytalker_mini_v0.7/VoiceKeyholder.h。
//
// 使い方（リポジトリルートから。ffmpeg が要る。--flash には Arduino の esp32 コアに入っている esptool を使う）:
//   node devices/mcu/esp32_s3/tools/make-voices.mjs a.mp3 b.wav c.m4a            # voices.bin を作る（既定は .local/voices/voices.bin）
//   node devices/mcu/esp32_s3/tools/make-voices.mjs *.mp3 --out my.bin           # 出力先を変える
//   node devices/mcu/esp32_s3/tools/make-voices.mjs *.mp3 --flash COM12          # 作って、そのまま本体の voices 区画へ書く
//   node devices/mcu/esp32_s3/tools/make-voices.mjs --image voices.bin --flash /dev/cu.usbmodem101   # 作ってある voices.bin を書くだけ（ffmpeg 不要）
//   node devices/mcu/esp32_s3/tools/make-voices.mjs --erase --flash COM12        # voices 区画を空にする（声なしに戻す）
//
// 音声は 24kHz モノラルにそろえ、前後の無音を落とし、山をそろえてから IMA ADPCM（4bit）にする。
// 24kHz で 1 秒 12KB。区画（partitions.csv の voices）に入らなければ止まる。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { SAMPLE_RATE, MAX_CLIPS, encodeAdpcm, decodeAdpcm, shapePcm, buildImage, isValidImage } from "../../../../backend/shared/voice-image.mjs";

// 音声の整え方（無音落とし・山そろえ・フェード）、ADPCM、入れ物の組み立ては backend/shared/voice-image.mjs（アプリから声を足す Lambda と同じもの）
function loadPcm(file) {
  const raw = execFileSync("ffmpeg", ["-v", "error", "-i", file, "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-"],
    { maxBuffer: 256 * 1024 * 1024 });
  const pcm = shapePcm(new Int16Array(raw.buffer, raw.byteOffset, raw.byteLength >> 1));
  if (!pcm) throw new Error(`${file}: 音が入っていない`);
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
let out = join(repoRoot, ".local/voices/voices.bin"), port = null, erase = false, prebuilt = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--out") out = resolve(args[++i]);
  else if (args[i] === "--image") prebuilt = resolve(args[++i]);
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
} else if (prebuilt) {
  // 作ってある voices.bin をそのまま書く（別の PC で作ったものを持ってきたとき）。形と CRC だけ確かめる
  if (!port || inputs.length > 0) { console.error("--image は --flash <ポート> と一緒に、音声ファイルなしで使う"); process.exit(2); }
  image = readFileSync(prebuilt);
  const ok = isValidImage(image, partition.size);
  if (!ok) { console.error(`❌ ${prebuilt} は voices の中身ではない（先頭・大きさ・CRC のどれかが合わない）`); process.exit(1); }
  out = prebuilt;
  console.log(`${prebuilt}: ${image.readUInt8(5)} 件 ${image.length} バイト（区画 ${partition.size} バイトの ${(image.length * 100 / partition.size).toFixed(0)}%）`);
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
  image = buildImage(clips);
  const total = image.length;
  clips.forEach((c, i) => {
    console.log(`${String(i).padStart(2)}  ${(c.samples / SAMPLE_RATE).toFixed(2).padStart(6)} 秒  ${String(c.data.length).padStart(7)} バイト  SNR ${c.snr.toFixed(1)} dB  ${c.file}`);
  });
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
