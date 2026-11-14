// voice-image.mjs — ボイスキーホルダーモードの音声の入れ物（本体の voices 区画の中身）を作る。
// 使うのは、読み上げ Lambda（アプリから声を足す。backend/toytalker-tts-only-lambda/keyholder.mjs）と、
// PC から USB で書く道具（devices/mcu/esp32_s3/tools/make-voices.mjs）。
// 入れ物の形と本体側の展開は devices/mcu/esp32_s3/toytalker_mini_v0.7/VoiceKeyholder.h（形を変えるときは両方を直す）。

export const SAMPLE_RATE = 24000;   // 本体の再生（SAMPLE_RATE_TTS）と同じ。違う件は本体が鳴らさない
export const MAX_CLIPS = 16;
export const HEADER_BYTES = 16;
export const ENTRY_BYTES = 16;
export const CODEC_ADPCM = 1;
export const FORMAT_VERSION = 1;

const PEAK = 16000;          // 山の高さ。会話の音声（Cartesia の山 13000〜17000）にそろえる。音量は本体側で上げる
const SILENCE = 300;         // これより小さい音は、前後の無音として落とす
const KEEP_MS = 30;          // 落とした無音の内側に残す長さ
const FADE_MS = 8;           // 先頭と末尾のフェード（プチッという音を防ぐ）

const STEPS = [
  7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
  118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
  1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
  6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
  32767];
const INDEX_MOVES = [-1, -1, -1, -1, 2, 4, 6, 8];
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// IMA ADPCM。予測値 0・段 0 から始め、1 バイトに下位 → 上位の順で 2 サンプル（VoiceKeyholder.h の AdpcmDecoder と対）
export function encodeAdpcm(pcm) {
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

export function decodeAdpcm(bytes, samples) {
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
export function crc32(buf) {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i];
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (~crc) >>> 0;
}

// 24kHz モノラルの PCM（Int16Array）の前後の無音を落とし、山を PEAK にそろえ、先頭と末尾をフェードする。
// 音が入っていなければ null
export function shapePcm(input) {
  const keep = Math.round(SAMPLE_RATE * KEEP_MS / 1000);
  let first = 0, last = input.length - 1;
  while (first < input.length && Math.abs(input[first]) < SILENCE) first++;
  while (last > first && Math.abs(input[last]) < SILENCE) last--;
  if (first >= input.length) return null;
  const pcm = Int16Array.from(input.subarray(Math.max(0, first - keep), Math.min(input.length, last + 1 + keep)));
  let peak = 1;
  for (const v of pcm) peak = Math.max(peak, Math.abs(v));
  const scale = PEAK / peak, fade = Math.min(Math.round(SAMPLE_RATE * FADE_MS / 1000), pcm.length >> 1);
  for (let i = 0; i < pcm.length; i++) {
    const edge = Math.min(i, pcm.length - 1 - i);
    pcm[i] = Math.round(pcm[i] * scale * (edge < fade ? edge / fade : 1));
  }
  return pcm;
}

// 入れ物の大きさ（件ごとの ADPCM のバイト数から）
export function imageBytes(clipByteLengths) {
  return HEADER_BYTES + clipByteLengths.length * ENTRY_BYTES + clipByteLengths.reduce((sum, n) => sum + n, 0);
}

// clips: [{ data: Uint8Array（ADPCM）, samples }] → voices 区画に書くバイト列。0 件でも作れる（本体は「声なし」と見る）
export function buildImage(clips) {
  if (clips.length > MAX_CLIPS) throw new Error(`too many clips: ${clips.length}`);
  const tableEnd = HEADER_BYTES + clips.length * ENTRY_BYTES;
  const total = imageBytes(clips.map((c) => c.data.length));
  const image = Buffer.alloc(total);
  let offset = tableEnd;
  clips.forEach((c, i) => {
    const e = HEADER_BYTES + i * ENTRY_BYTES;
    image.writeUInt32LE(offset, e);
    image.writeUInt32LE(c.data.length, e + 4);
    image.writeUInt8(CODEC_ADPCM, e + 8);
    image.writeUInt16LE(SAMPLE_RATE, e + 10);
    image.writeUInt32LE(c.samples, e + 12);
    image.set(c.data, offset);
    offset += c.data.length;
  });
  image.write("TTVK", 0, "latin1");
  image.writeUInt8(FORMAT_VERSION, 4);
  image.writeUInt8(clips.length, 5);
  image.writeUInt32LE(total, 8);
  image.writeUInt32LE(crc32(image.subarray(HEADER_BYTES)), 12);
  return image;
}

// 入れ物の CRC（先頭の表に書いてある値）を、本体が鍵取得で名乗るのと同じ 8 桁の 16 進にする
export const imageCrcHex = (image) => image.readUInt32LE(12).toString(16).padStart(8, "0");

// voices.bin として正しいか（先頭・大きさ・CRC）
export function isValidImage(image, maxBytes) {
  return image.length >= HEADER_BYTES && image.toString("latin1", 0, 4) === "TTVK" && image.readUInt32LE(8) === image.length
    && image.length <= maxBytes && crc32(image.subarray(HEADER_BYTES)) === image.readUInt32LE(12);
}
