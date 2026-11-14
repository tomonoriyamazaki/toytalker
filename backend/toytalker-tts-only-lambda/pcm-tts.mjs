// pcm-tts.mjs — 文を 24kHz・モノラル・16bit の PCM にする（ボイスキーホルダーの声を作る用。keyholder.mjs）。
// 読み上げ（index.mjs）は mp3 で返すが、本体に入れる声は ADPCM に圧縮するので、mp3 を経ずに各社へ PCM を頼む。
// 頼み方は ESP32 用の会話 Lambda（backend/toytalk-api-stream-for-esp32-lambda）と同じ。
// 主の声が失敗しても別の声では作らない（本体に残り続ける声なので、失敗として返す）。
import { secret } from "../shared/secrets.mjs";
import { SAMPLE_RATE } from "../shared/voice-image.mjs";

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

async function google(text, voiceName) {
  const key = secret("GOOGLE_API_KEY");
  if (!key) throw new Error("GOOGLE_API_KEY is not set");
  const parts = String(voiceName).split("-");
  const languageCode = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : "ja-JP";
  const resp = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // 速さと高さは読み上げ（index.mjs の ttsToBase64Google）と同じ
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, name: voiceName },
      audioConfig: { audioEncoding: "LINEAR16", speakingRate: 1.3, pitch: 3.0, sampleRateHertz: 24000 },
    }),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.message || "Google TTS failed");
  const { pcm, sampleRate } = parseWav(Buffer.from(json.audioContent, "base64"));  // LINEAR16 は WAV の頭が付く
  return { buf: pcm, rate: sampleRate };
}

async function gemini(text, voiceName, model) {
  const key = secret("GOOGLE_API_KEY");
  if (!key) throw new Error("GOOGLE_API_KEY is not set");
  for (let attempt = 0; attempt < 3; attempt++) {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Read the following text aloud: ${text}` }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
          model,
        }),
      },
    );
    const json = await resp.json();
    if (!resp.ok) throw new Error(json?.error?.message || "Gemini TTS failed");
    const b64 = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || "";
    if (b64) return { buf: Buffer.from(b64, "base64"), rate: 24000 };
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

/**
 * vendor は index.mjs の TTS_TABLE の ttsVendor、voice は toytalker-voices の vendor_id。
 * 戻り値は 24kHz・モノラルの Int16Array
 */
export async function synthesizePcm({ vendor, model, voice, text }) {
  let r;
  if (vendor === "openai") r = await openai(text, voice, model);
  else if (vendor === "google") r = await google(text, voice);
  else if (vendor === "gemini") r = await gemini(text, voice, model);
  else if (vendor === "elevenlabs") r = await elevenlabs(text, voice, model);
  else if (vendor === "cartesia") r = await cartesia(text, voice, model);
  else if (vendor === "fishaudio") r = await fishaudio(text, voice);
  else if (vendor === "sakura") r = await sakura(text, voice === "default" ? "zundamon" : voice);
  else if (vendor === "zakicorp") r = await zakicorp(text, voice === "default" ? "vivian" : voice);
  else throw new Error("Unknown ttsVendor");
  return resample(toInt16(r.buf), r.rate);
}
