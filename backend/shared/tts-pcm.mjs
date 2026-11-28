// tts-pcm.mjs — 文を 24kHz・モノラル・16bit の PCM にする（1文を丸ごと作って返す。ストリーミングはしない）。
// 使うのは相槌（backchannel.mjs。App 用は WAV に包み、ESP32 用は PCM のまま返す）と、
// ボイスキーホルダーの声（backend/toytalker-tts-only-lambda/keyholder.mjs。ADPCM に圧縮して本体に入れる）。
// 頼み方は ESP32 用の会話 Lambda（backend/toytalk-api-stream-for-esp32-lambda）と同じ。
// ここでは別の声へ切り替えない（失敗は投げる。ずんだもんへ切り替えるかは呼ぶ側が決める）。
import { secret } from "./secrets.mjs";
import { SAMPLE_RATE } from "./voice-image.mjs";

// WAVバッファをパースして {pcm, sampleRate} を返す（'data'チャンクを走査）
export function parseWav(wavBuf) {
  if (wavBuf.length < 44 || wavBuf.toString("ascii", 0, 4) !== "RIFF") {
    throw new Error("invalid WAV");
  }
  const sampleRate = wavBuf.readUInt32LE(24);
  let off = 12;
  while (off + 8 <= wavBuf.length) {
    const id = wavBuf.toString("ascii", off, off + 4);
    const size = wavBuf.readUInt32LE(off + 4);
    if (id === "data") {
      return { pcm: wavBuf.subarray(off + 8, off + 8 + size), sampleRate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("WAV data chunk not found");
}

function toInt16(buf) {
  const n = buf.length >> 1;
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2);
  return out;
}

// サンプルレートを変える（直線補間。下げるときは先に、比に合わせた幅で平均して折り返しを抑える）。
// 各社とも 24kHz で頼めるので、通るのは WAV で返る声（Sakura）と自前の声（ZakiCorp）が別のレートだったときだけ
export function resample(pcm, from, to = SAMPLE_RATE) {
  if (from === to || pcm.length === 0) return pcm;
  let src = pcm;
  if (from > to) {
    const width = Math.max(1, Math.round(from / to));
    src = new Int16Array(pcm.length);
    let sum = 0;
    for (let i = 0; i < pcm.length; i++) {
      sum += pcm[i];
      if (i >= width) sum -= pcm[i - width];
      src[i] = Math.round(sum / Math.min(i + 1, width));
    }
  }
  const out = new Int16Array(Math.floor(src.length * to / from));
  for (let i = 0; i < out.length; i++) {
    const pos = i * from / to, k = Math.floor(pos), frac = pos - k;
    const a = src[k], b = src[Math.min(k + 1, src.length - 1)];
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

async function failed(name, resp) {
  const err = new Error(`${name} TTS failed: ${resp.status} ${(await resp.text()).slice(0, 300)}`);
  err.status = resp.status;
  return err;
}

async function openai(text, voice, model) {
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Authorization": `Bearer ${secret("OPENAI_API_KEY")}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text, voice, response_format: "pcm" }),
  });
  if (!resp.ok) throw await failed("OpenAI", resp);
  return { buf: Buffer.from(await resp.arrayBuffer()), rate: 24000 };
}

async function google(text, voiceName, { speakingRate = 1.3, pitch = 3.0 } = {}) {
  const key = secret("GOOGLE_API_KEY");
  if (!key) throw new Error("GOOGLE_API_KEY is not set");
  const parts = String(voiceName).split("-");
  const languageCode = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : "ja-JP";
  const resp = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // 速さと高さの既定は読み上げ（backend/toytalker-tts-only-lambda/index.mjs の ttsToBase64Google）と同じ
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, name: voiceName },
      audioConfig: { audioEncoding: "LINEAR16", speakingRate, pitch, sampleRateHertz: 24000 },
    }),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.message || "Google TTS failed");
  const { pcm, sampleRate } = parseWav(Buffer.from(json.audioContent, "base64"));  // LINEAR16 は WAV の頭が付く
  return { buf: pcm, rate: sampleRate };
}

// Gemini はたまに音声の無い応答を返す（短い文で起きやすい。2026-11-03）ので、空ならやり直す（attempts 回まで）
async function gemini(text, voiceName, model, { attempts = 3, readAloudPrompt = true } = {}) {
  const key = secret("GOOGLE_API_KEY");
  if (!key) throw new Error("GOOGLE_API_KEY is not set");
  for (let attempt = 0; attempt < attempts; attempt++) {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: readAloudPrompt ? `Read the following text aloud: ${text}` : text }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
          model,
        }),
      },
    );
    const json = await resp.json();
    if (!resp.ok) throw new Error(json?.error?.message || "Gemini TTS failed");
    const b64 = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || "";
    // audioTokens は原価の計算に使う（backend/shared/cost.mjs の calcTtsCost）
    if (b64) return { buf: Buffer.from(b64, "base64"), rate: 24000, audioTokens: json?.usageMetadata?.candidatesTokenCount ?? 0 };
  }
  throw new Error("Gemini TTS: empty audio after retries");
}

async function elevenlabs(text, voiceId, model) {
  const key = secret("ELEVENLABS_API_KEY");
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000&optimize_streaming_latency=0`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    },
  );
  if (!resp.ok) throw await failed("ElevenLabs", resp);
  return { buf: Buffer.from(await resp.arrayBuffer()), rate: 24000 };
}

const CARTESIA_API_VERSION = "2026-08-14";
async function cartesia(text, voiceId, model) {
  const key = secret("CARTESIA_API_KEY");
  if (!key) throw new Error("CARTESIA_API_KEY is not set");
  const id = (voiceId && voiceId !== "default") ? voiceId : process.env.CARTESIA_DEFAULT_VOICE_ID;
  if (!id) throw new Error("Cartesia voice ID is not set (CARTESIA_DEFAULT_VOICE_ID)");
  const resp = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Cartesia-Version": CARTESIA_API_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: model, transcript: text, voice: { id },
      language: process.env.CARTESIA_LANGUAGE || "ja",
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
    }),
  });
  if (!resp.ok) throw await failed("Cartesia", resp);
  return { buf: Buffer.from(await resp.arrayBuffer()), rate: 24000 };
}

async function fishaudio(text, referenceId) {
  const key = secret("FISHAUDIO_API_KEY");
  if (!key) throw new Error("FISHAUDIO_API_KEY is not set");
  const resp = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text, reference_id: referenceId, format: "pcm", sample_rate: 24000, latency: "normal" }),
  });
  if (!resp.ok) throw await failed("FishAudio", resp);
  return { buf: Buffer.from(await resp.arrayBuffer()), rate: 24000 };
}

async function sakura(text, model) {
  const key = secret("SAKURA_API_KEY");
  if (!key) throw new Error("SAKURA_API_KEY is not set");
  const resp = await fetch("https://api.ai.sakura.ad.jp/v1/audio/speech", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Accept": "audio/wav" },
    body: JSON.stringify({ model, input: text, voice: "normal", response_format: "wav" }),
  });
  if (!resp.ok) throw await failed("Sakura", resp);
  const { pcm, sampleRate } = parseWav(Buffer.from(await resp.arrayBuffer()));
  return { buf: pcm, rate: sampleRate };
}

async function zakicorp(text, speaker) {
  const key = secret("ZAKICORP_API_KEY");
  const baseUrl = process.env.ZAKICORP_TTS_URL;
  if (!key || !baseUrl) throw new Error("ZAKICORP_API_KEY or ZAKICORP_TTS_URL is not set");
  const resp = await fetch(`${baseUrl}/v1/tts/stream`, {
    method: "POST",
    // X-Zakicorp-Edge-Key: Cloudflareの拠点で検査する合言葉（WAFカスタムルール）。未設定なら送らない
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json",
               ...(secret("ZAKICORP_EDGE_KEY") ? { "X-Zakicorp-Edge-Key": secret("ZAKICORP_EDGE_KEY") } : {}) },
    body: JSON.stringify({ text, language: "Japanese", speaker }),
  });
  if (!resp.ok) throw await failed("ZakiCorp", resp);
  const rate = parseInt(resp.headers.get("X-Sample-Rate") || "24000");
  return { buf: Buffer.from(await resp.arrayBuffer()), rate };
}

// 声（toytalker-voices の vendor_id）が無い・"default" のときに使う声
const DEFAULT_VOICES = {
  openai: "alloy",
  google: "ja-JP-Neural2-B",
  gemini: "Kore",
  elevenlabs: "hMK7c1GPJmptCzI4bQIu",
  cartesia: "default", // cartesia() が環境変数 CARTESIA_DEFAULT_VOICE_ID に読み替える
  fishaudio: "e58b0d7efca34eb38d5c4985e9e1e3e6",
  sakura: "zundamon",
  zakicorp: "vivian",
};

/**
 * 各社へ頼んで、返ってきたままの PCM を返す（サンプルレートは会社による）。
 * @param {object} p
 * @param {string} p.vendor  TTS_TABLE の ttsVendor
 * @param {string} p.model   TTS_TABLE の ttsModel
 * @param {string} [p.voice] toytalker-voices の vendor_id。無い・"default" なら DEFAULT_VOICES
 * @param {string} p.text
 * @param {{ google?: { speakingRate?: number, pitch?: number }, gemini?: { attempts?: number, readAloudPrompt?: boolean } }} [p.options]
 * @returns {Promise<{ buf: Buffer, rate: number, audioTokens?: number }>}
 */
async function request({ vendor, model, voice, text, options = {} }) {
  if (!(vendor in DEFAULT_VOICES)) throw new Error("Unknown ttsVendor");
  const v = voice && voice !== "default" ? voice : DEFAULT_VOICES[vendor];
  if (vendor === "openai") return openai(text, v, model);
  if (vendor === "google") return google(text, v, options.google);
  if (vendor === "gemini") return gemini(text, v, model, options.gemini);
  if (vendor === "elevenlabs") return elevenlabs(text, v, model);
  if (vendor === "cartesia") return cartesia(text, v, model);
  if (vendor === "fishaudio") return fishaudio(text, v);
  if (vendor === "sakura") return sakura(text, v);
  return zakicorp(text, v);
}

/** 24kHz・モノラルの Int16Array（ボイスキーホルダー用） */
export async function synthesizePcm(args) {
  const r = await request(args);
  return resample(toInt16(r.buf), r.rate);
}

/**
 * 24kHz・モノラル・16bit の PCM を Buffer で（相槌用）。24kHz で返る会社はそのまま返し、違うときだけ変換する。
 * @returns {Promise<{ pcm: Buffer, audioTokens: number|null }>} audioTokens は Gemini だけ（応答の usageMetadata）
 */
export async function synthesizePcmBuffer(args) {
  const r = await request(args);
  let pcm = r.buf;
  if (r.rate !== SAMPLE_RATE) {
    const out = resample(toInt16(r.buf), r.rate);
    pcm = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  }
  return { pcm, audioTokens: r.audioTokens ?? null };
}

/**
 * 先頭/末尾の無音を削る（24kHz・16bit・モノラルの PCM。ESP32 用の本文と相槌が使う）。
 * TTSは前後に数百msの無音を含むことが多く、これを削ると「喋り終わり→録音再開」の体感切替がその分速くなる（先頭側は応答体感の改善）
 */
export function trimSilence(pcm, { threshold = 512, padMs = 80, sampleRate = SAMPLE_RATE } = {}) {
  const total = Math.floor(pcm.length / 2);
  if (total === 0) return pcm;
  let start = 0, end = total - 1;
  while (start < total && Math.abs(pcm.readInt16LE(start * 2)) < threshold) start++;
  while (end > start && Math.abs(pcm.readInt16LE(end * 2)) < threshold) end--;
  if (start >= end) return pcm;  // 全体が無音なら触らない
  const pad = Math.round(sampleRate * padMs / 1000);
  const headCut = Math.max(0, start - pad);
  const tailCut = Math.min(total - 1, end + pad);
  return pcm.slice(headCut * 2, (tailCut + 1) * 2);
}

/** 24kHz・モノラル・16bit の PCM に WAV の頭（44バイト）を付ける */
export function pcmToWav(pcm, sampleRate = SAMPLE_RATE) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(1, 22);            // モノラル
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
