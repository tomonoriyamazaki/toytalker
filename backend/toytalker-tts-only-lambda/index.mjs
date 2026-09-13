// Node.js 18+ / ESM（index.mjs）
// Handler: index.handler
// 用途: テキストを受け取り、選択ボイスのTTSだけで音声化して直接ストリーミング返却する（LLM/STT/相槌なし）。
//       アプリの「読み上げ」専用機能のためのLambda。音声はサーバー側に保存しない。
// 入力: { text, voice_id, owner_id? }
// 出力: mp3 音声バイナリ（Content-Type: audio/mpeg, ヘッダ X-Audio-Format=mp3。全プロバイダーmp3統一）
// Env: OPENAI_API_KEY, GOOGLE_API_KEY, ELEVENLABS_API_KEY, FISHAUDIO_API_KEY, SAKURA_API_KEY, ZAKICORP_API_KEY, ZAKICORP_TTS_URL,
//      CARTESIA_API_KEY, CARTESIA_DEFAULT_VOICE_ID (任意: CARTESIA_LANGUAGE 既定 "ja")
import OpenAI from "openai";
import { Mp3Encoder } from "@breezystack/lamejs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";

const ddbClient = new DynamoDBClient({ region: "ap-northeast-1" });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const VOICES_TABLE         = "toytalker-voices";
const USAGE_TABLE          = "toytalker-usage";
const UNIT_PRICES_TABLE    = "toytalker-api-unit-prices";
const EXCHANGE_RATES_TABLE = "toytalker-exchange-rates";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const TTS_DEFAULT   = "OpenAI";
const VOICE_DEFAULT = "alloy";
const TTS_TABLE = {
  OpenAI:     { ttsVendor: "openai",     ttsModel: "gpt-4o-mini-tts" },
  Google:     { ttsVendor: "google",     ttsModel: "google-tts" },
  Gemini:     { ttsVendor: "gemini",     ttsModel: "gemini-2.5-flash-preview-tts" },
  ElevenLabs: { ttsVendor: "elevenlabs", ttsModel: "eleven_turbo_v2_5" },
  Cartesia:   { ttsVendor: "cartesia",   ttsModel: "sonic-3.6" },
  FishAudio:  { ttsVendor: "fishaudio",  ttsModel: "fishaudio" },
  Sakura:     { ttsVendor: "sakura",     ttsModel: "sakura" },
  ZakiCorp:   { ttsVendor: "zakicorp",   ttsModel: "zakicorp-tts" },
};

function normalizeModelKey(k) {
  if (!k) return undefined;
  const s = String(k).toLowerCase();
  if (s.includes("openai"))      return "OpenAI";
  if (s.includes("google"))      return "Google";
  if (s.includes("gemini"))      return "Gemini";
  if (s.includes("elevenlabs"))  return "ElevenLabs";
  if (s.includes("cartesia"))    return "Cartesia";
  if (s.includes("fishaudio") || s.includes("fish")) return "FishAudio";
  if (s.includes("sakura"))      return "Sakura";
  if (s.includes("zakicorp") || s.includes("qwen")) return "ZakiCorp";
  return undefined;
}

// 改行を「文の区切り（長めのポーズ）」として扱う。
// TTSは改行で間を取らないため、各行末に句点を補い全プロバイダー共通でポーズを作る。
// 既に文末記号で終わる行はそのまま、空行は除去。
function applyLineBreakPauses(raw) {
  const lines = String(raw)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (lines.length <= 1) return lines[0] ?? "";
  return lines
    .map((s) => (/[。．.！!？?…」』）)]$/.test(s) ? s : s + "。"))
    .join("\n");
}

// ===== TTS プロバイダー（toytalk-stream-handler-lambda から流用。base64返却）=====

// 全プロバイダーで出力をmp3に統一する。
// ネイティブmp3対応(OpenAI/Google/ElevenLabs/Cartesia/FishAudio)は直接mp3を要求し、
// PCM/WAVのみ(Gemini/ZakiCorp/Sakura)は lamejs でmp3エンコードする。
const MP3_KBPS = 128;

// PCM16(LE, mono想定)のクリーンアップ: DCオフセット除去 + 端のフェード + 先頭無音パッド
// （元のWAVラップ処理が持っていた冒頭クリック音対策を維持する）
function cleanupPcm16(pcmIn, sampleRate) {
  let pcm = Buffer.from(pcmIn);
  const totalSamples = Math.floor(pcm.length / 2);
  if (totalSamples === 0) return pcm;

  let sum = 0;
  for (let i = 0; i < totalSamples; i++) sum += pcm.readInt16LE(i * 2);
  const mean = sum / totalSamples;
  for (let i = 0; i < totalSamples; i++) {
    const v = pcm.readInt16LE(i * 2) - mean;
    pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }

  const fadeMs = 12;
  const fadeSamples = Math.min(Math.floor(sampleRate * fadeMs / 1000), Math.floor(totalSamples / 4));
  for (let i = 0; i < fadeSamples; i++) {
    const wIn  = 0.5 * (1 - Math.cos(Math.PI * i / fadeSamples));
    const wOut = 0.5 * (1 - Math.cos(Math.PI * (fadeSamples - i) / fadeSamples));
    const vi = pcm.readInt16LE(i * 2);
    pcm.writeInt16LE(Math.round(vi * wIn), i * 2);
    const idx = (totalSamples - 1 - i) * 2;
    const vo = pcm.readInt16LE(idx);
    pcm.writeInt16LE(Math.round(vo * wOut), idx);
  }

  const padHeadMs = 40;
  const padSamples = Math.max(1, Math.floor(sampleRate * padHeadMs / 1000));
  const pad = Buffer.alloc(padSamples * 2, 0);
  return Buffer.concat([pad, pcm]);
}

// 生PCM16(mono)バッファ → mp3 base64
function pcm16ToMp3Base64(pcmBuf, sampleRate = 24000) {
  const pcm = cleanupPcm16(pcmBuf, sampleRate);
  const n = Math.floor(pcm.length / 2);
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = pcm.readInt16LE(i * 2);

  const enc = new Mp3Encoder(1, sampleRate, MP3_KBPS);
  const blockSize = 1152;
  const chunks = [];
  for (let i = 0; i < samples.length; i += blockSize) {
    const slice = samples.subarray(i, i + blockSize);
    const buf = enc.encodeBuffer(slice);
    if (buf.length > 0) chunks.push(Buffer.from(buf));
  }
  const end = enc.flush();
  if (end.length > 0) chunks.push(Buffer.from(end));
  return Buffer.concat(chunks).toString("base64");
}

// WAVバッファをパースして {pcm, sampleRate} を返す（'data'チャンクを走査）
function parseWav(wavBuf) {
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

async function ttsToBase64OpenAI(text, voice, ttsModel) {
  const tts = await openai.audio.speech.create({ model: ttsModel, input: text, voice, format: "mp3" });
  const buf = Buffer.from(await tts.arrayBuffer());
  return buf.toString("base64");
}

async function ttsToBase64Google(text, { voiceName = "ja-JP-Neural2-B", speakingRate = 1.3, pitch = 3.0, sampleRateHertz = 24000 } = {}) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set");
  const parts = String(voiceName).split("-");
  const languageCode = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : "ja-JP";
  const resp = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input: { text },
      voice: { languageCode, name: voiceName },
      audioConfig: { audioEncoding: "MP3", speakingRate, pitch, sampleRateHertz },
    }),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.message || "Google TTS failed");
  // audioContent は MP3 の base64（そのまま返す）
  return json.audioContent;
}

async function ttsToBase64Gemini(text, { model = "gemini-2.5-flash-preview-tts", voiceName = "leda" } = {}) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set");
  const ttsPrompt = `Read the following text aloud: ${text}`;
  const maxRetries = 2;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: "POST",
        headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: ttsPrompt }] }],
          generationConfig: { responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } } },
          model,
        }),
      }
    );
    const json = await resp.json();
    if (!resp.ok) throw new Error(json?.error?.message || "Gemini TTS failed");
    const b64Pcm = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || "";
    if (b64Pcm) {
      const audioTokens = json?.usageMetadata?.candidatesTokenCount ?? 0;
      return { b64: pcm16ToMp3Base64(Buffer.from(b64Pcm, "base64"), 24000), audioTokens };
    }
  }
  throw new Error("Gemini TTS: empty audio after retries");
}

async function ttsToBase64ElevenLabs(text, { model = "eleven_turbo_v2_5", voiceId = "hMK7c1GPJmptCzI4bQIu" } = {}) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=mp3_44100_128&optimize_streaming_latency=0`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    }
  );
  if (!resp.ok) throw new Error(`ElevenLabs TTS failed: ${resp.status} ${await resp.text()}`);
  // mp3 バイナリをそのまま base64 化
  return Buffer.from(await resp.arrayBuffer()).toString("base64");
}

// Cartesia TTS → base64(mp3) ネイティブmp3出力を要求
const CARTESIA_API_VERSION = "2026-08-14";
async function ttsToBase64Cartesia(text, { model = "sonic-3.6", voiceId } = {}) {
  const key = process.env.CARTESIA_API_KEY;
  if (!key) throw new Error("CARTESIA_API_KEY is not set");
  const id = voiceId || process.env.CARTESIA_DEFAULT_VOICE_ID;
  if (!id) throw new Error("Cartesia voice ID is not set (CARTESIA_DEFAULT_VOICE_ID)");
  const resp = await fetch("https://api.cartesia.ai/tts/bytes", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Cartesia-Version": CARTESIA_API_VERSION, "Content-Type": "application/json" },
    body: JSON.stringify({
      model_id: model, transcript: text, voice: { id },
      language: process.env.CARTESIA_LANGUAGE || "ja",
      output_format: { container: "mp3", sample_rate: 44100, bit_rate: MP3_KBPS * 1000 },
    }),
  });
  if (!resp.ok) throw new Error(`Cartesia TTS failed: ${resp.status} ${await resp.text()}`);
  return Buffer.from(await resp.arrayBuffer()).toString("base64");
}

async function ttsToBase64FishAudio(text, { referenceId = "6fdaebea7db042129f03ecb0a57ea7b6" } = {}) {
  const key = process.env.FISHAUDIO_API_KEY;
  if (!key) throw new Error("FISHAUDIO_API_KEY is not set");
  const resp = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text, reference_id: referenceId, format: "mp3", latency: "low" }),
  });
  if (!resp.ok) throw new Error(`Fish Audio TTS failed: ${resp.status} ${await resp.text()}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  return buf.toString("base64");
}

async function ttsToBase64Sakura(text, { model = "zundamon", style = "normal" } = {}) {
  const key = process.env.SAKURA_API_KEY;
  if (!key) throw new Error("SAKURA_API_KEY is not set");
  const resp = await fetch("https://api.ai.sakura.ad.jp/v1/audio/speech", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json", "Accept": "audio/wav" },
    body: JSON.stringify({ model, input: text, voice: style, response_format: "wav" }),
  });
  if (!resp.ok) throw new Error(`Sakura TTS failed: ${resp.status} ${await resp.text()}`);
  const wavBuffer = Buffer.from(await resp.arrayBuffer());
  const { pcm, sampleRate } = parseWav(wavBuffer);
  return pcm16ToMp3Base64(pcm, sampleRate);
}

async function ttsToBase64ZakiCorp(text, { speaker = "vivian", language = "Japanese" } = {}) {
  const key = process.env.ZAKICORP_API_KEY;
  const baseUrl = process.env.ZAKICORP_TTS_URL;
  if (!key || !baseUrl) throw new Error("ZAKICORP_API_KEY or ZAKICORP_TTS_URL is not set");
  const resp = await fetch(`${baseUrl}/v1/tts/stream`, {
    method: "POST",
    // X-Zakicorp-Edge-Key: Cloudflareの拠点で検査する合言葉（WAFカスタムルール）。未設定なら送らない
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json",
               ...(process.env.ZAKICORP_EDGE_KEY ? { "X-Zakicorp-Edge-Key": process.env.ZAKICORP_EDGE_KEY } : {}) },
    body: JSON.stringify({ text, language, speaker }),
  });
  if (!resp.ok) throw new Error(`ZakiCorp TTS failed: ${resp.status} ${await resp.text()}`);
  const sampleRate = parseInt(resp.headers.get("X-Sample-Rate") || "24000");
  const pcmBuf = Buffer.from(await resp.arrayBuffer());
  return pcm16ToMp3Base64(pcmBuf, sampleRate);
}

// ===== ボイス解決（voice_id → toytalker-voices → {provider, vendor_id}）=====
async function resolveVoiceFromDynamo(voiceId) {
  try {
    const res = await ddb.send(new GetCommand({ TableName: VOICES_TABLE, Key: { voice_id: voiceId } }));
    if (!res.Item) return null;
    return { provider: res.Item.provider, vendorId: res.Item.vendor_id };
  } catch (e) {
    console.error("[DynamoDB] resolveVoiceFromDynamo error:", e);
    return null;
  }
}

// ===== コスト計算 + usage 書き込み（TTS分のみ。stream-handler から流用）=====
let cachedPrices = null, cachedMargin = null, cachedRates = {}, cacheLoadedAt = 0;
const CACHE_TTL_MS = 3600_000;

async function loadPricingCache() {
  if (cachedPrices && (Date.now() - cacheLoadedAt) < CACHE_TTL_MS) return;
  try {
    const result = await ddb.send(new ScanCommand({
      TableName: UNIT_PRICES_TABLE,
      FilterExpression: "version = :v",
      ExpressionAttributeValues: { ":v": "current" },
    }));
    const prices = {};
    for (const item of (result.Items ?? [])) {
      const pk = item["provider#api_type"];
      if (pk === "service#margin") cachedMargin = Number(item.margin) || 1.5;
      else prices[pk] = item;
    }
    cachedPrices = prices;
    cacheLoadedAt = Date.now();
  } catch (e) {
    console.error("[Pricing] cache load error:", e);
  }
}

async function getExchangeRate(month, currency = "JPY") {
  const cacheKey = `${month}#${currency}`;
  if (cachedRates[cacheKey]) return cachedRates[cacheKey];
  try {
    const result = await ddb.send(new GetCommand({ TableName: EXCHANGE_RATES_TABLE, Key: { month, currency } }));
    const rate = Number(result.Item?.rate) || 150;
    cachedRates[cacheKey] = rate;
    return rate;
  } catch (e) {
    console.error("[ExchangeRate] error:", e);
    return 150;
  }
}

function calcTtsCostJpy({ providerApiType, characters, utf8Bytes, mora, pcmBytes, audioTokens, usdJpyRate }) {
  const price = cachedPrices?.[providerApiType];
  if (!price) {
    // 単価行が無いと記録されない。月次の運用Lambdaがこのログを拾って知らせる
    console.warn(`[Pricing] missing price for ${providerApiType}`);
    return null;
  }
  const margin = cachedMargin || 1.5;

  if (price.currency === "JPY") {
    const inputCost = (mora ?? 0) * Number(price.unit_price_input);
    return { costJpy: inputCost * margin, costUsd: null, usdJpyRate: null, unitPriceUsd: null, margin };
  }

  const inputUnit = price.input_unit_type;
  const outputUnit = price.output_unit_type;
  let costUsd = 0;
  if (inputUnit === "tokens") {
    costUsd += (characters ?? 0) * Number(price.unit_price_input);
    if (outputUnit === "audio_tokens") costUsd += (audioTokens ?? 0) * Number(price.unit_price_output);
  } else if (inputUnit === "characters") {
    costUsd += (characters ?? 0) * Number(price.unit_price_input);
    if (outputUnit === "audio_tokens" && pcmBytes) {
      const durationSec = pcmBytes / (24000 * 2);
      const at = Math.round((durationSec / 60) * 800);
      costUsd += at * Number(price.unit_price_output);
    }
  } else if (inputUnit === "utf8_bytes") {
    costUsd += (utf8Bytes ?? 0) * Number(price.unit_price_input);
  }
  const costJpy = costUsd * usdJpyRate * margin;
  return { costJpy, costUsd, usdJpyRate, unitPriceUsd: Number(price.unit_price_input), margin };
}

async function addUsage({ ownerId, deviceId, date, provider, model, costJpy, costUsd, ttsCharacters, usdJpyRate, unitPriceUsd, margin }) {
  if (!costJpy || costJpy <= 0) return;
  const sk = `${date}#${deviceId}#tts`;
  try {
    // cost_usd はマージン前のUSD実費（請求額との突き合わせ用）
    await ddb.send(new UpdateCommand({
      TableName: USAGE_TABLE,
      Key: { owner_id: ownerId, "date#device_id#api_type": sk },
      UpdateExpression: "ADD cost_jpy :cost, cost_usd :usd, requests :one, tts_characters :ttsc SET provider = :p, model = :m, usd_jpy_rate = :r, unit_price_usd = :u, margin = :mg",
      ExpressionAttributeValues: {
        ":cost": costJpy, ":usd": costUsd ?? 0, ":one": 1, ":ttsc": ttsCharacters,
        ":p": provider, ":m": model, ":r": usdJpyRate ?? 0, ":u": unitPriceUsd ?? 0, ":mg": margin,
      },
    }));
  } catch (e) {
    console.error("[addUsage] error:", e);
  }
}

async function trackTtsCost({ ownerId, ttsVendor, ttsModel, text, b64Len }) {
  try {
    await loadPricingCache();
    const ts = new Date().toISOString();
    const date = ts.slice(0, 10);
    const month = ts.slice(0, 7);
    const usdJpyRate = await getExchangeRate(month);
    const chars = [...text].length;
    const priceKey = `${ttsVendor}#tts`;
    let cost;
    if (ttsVendor === "openai") {
      // 出力はmp3(128kbps)。mp3バイト数から再生秒数→PCM相当バイト数を概算
      const mp3Bytes = Math.round(b64Len * 3 / 4);
      const durationSec = (mp3Bytes * 8) / (MP3_KBPS * 1000);
      const pcmBytes = Math.round(durationSec * 24000 * 2);
      cost = calcTtsCostJpy({ providerApiType: priceKey, characters: chars, pcmBytes, usdJpyRate });
    } else if (ttsVendor === "fishaudio") {
      cost = calcTtsCostJpy({ providerApiType: priceKey, utf8Bytes: Buffer.byteLength(text, "utf8"), usdJpyRate });
    } else if (ttsVendor === "sakura") {
      cost = calcTtsCostJpy({ providerApiType: priceKey, mora: chars, usdJpyRate });
    } else {
      cost = calcTtsCostJpy({ providerApiType: priceKey, characters: chars, usdJpyRate });
    }
    if (cost) {
      await addUsage({
        ownerId, deviceId: "app", date, provider: ttsVendor, model: ttsModel,
        costJpy: cost.costJpy, costUsd: cost.costUsd, ttsCharacters: chars,
        usdJpyRate: cost.usdJpyRate, unitPriceUsd: cost.unitPriceUsd, margin: cost.margin,
      });
    }
  } catch (e) {
    console.error("[trackTtsCost] error:", e);
  }
}

// ===== ハンドラ =====
export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    body = {};
  }

  const text    = typeof body.text === "string" ? body.text.trim() : "";
  const voiceId = typeof body.voice_id === "string" ? body.voice_id : null;
  const ownerId = typeof body.owner_id === "string" ? body.owner_id : "user_123";

  const fail = (statusCode, message) => {
    const s = awslambda.HttpResponseStream.from(responseStream, {
      statusCode,
      headers: { "Content-Type": "application/json" },
    });
    s.write(JSON.stringify({ error: message }));
    s.end();
  };

  if (!text)    return fail(400, "text is required");
  if (!voiceId) return fail(400, "voice_id is required");

  // ボイス解決
  let ttsKey = TTS_DEFAULT;
  let voice  = VOICE_DEFAULT;
  const v = await resolveVoiceFromDynamo(voiceId);
  if (!v) return fail(404, `voice_id not found: ${voiceId}`);
  ttsKey = normalizeModelKey(v.provider) ?? TTS_DEFAULT;
  voice  = v.vendorId ?? VOICE_DEFAULT;
  const cfg = TTS_TABLE[ttsKey] ?? TTS_TABLE[TTS_DEFAULT];

  // 改行を文区切り（長めのポーズ）に変換してから合成
  const ttsText = applyLineBreakPauses(text);

  // TTS 実行（出力は全プロバイダーmp3に統一）
  // 主プロバイダーが失敗（同時接続上限など）したらずんだもんで生成し、ヘッダーで知らせる
  let b64;
  let usedVendor = cfg.ttsVendor;
  const fmt = "mp3";
  const synthesizePrimary = async () => {
    if (cfg.ttsVendor === "openai") {
      b64 = await ttsToBase64OpenAI(ttsText, voice, cfg.ttsModel);
    } else if (cfg.ttsVendor === "google") {
      b64 = await ttsToBase64Google(ttsText, { voiceName: voice });
    } else if (cfg.ttsVendor === "gemini") {
      const result = await ttsToBase64Gemini(ttsText, { model: cfg.ttsModel, voiceName: voice });
      b64 = result.b64;
    } else if (cfg.ttsVendor === "elevenlabs") {
      b64 = await ttsToBase64ElevenLabs(ttsText, { model: cfg.ttsModel, voiceId: voice });
    } else if (cfg.ttsVendor === "cartesia") {
      b64 = await ttsToBase64Cartesia(ttsText, { model: cfg.ttsModel, voiceId: voice === "default" ? undefined : voice });
    } else if (cfg.ttsVendor === "fishaudio") {
      b64 = await ttsToBase64FishAudio(ttsText, { referenceId: voice });
    } else if (cfg.ttsVendor === "sakura") {
      b64 = await ttsToBase64Sakura(ttsText, { model: voice === "default" ? "zundamon" : voice });
    } else if (cfg.ttsVendor === "zakicorp") {
      b64 = await ttsToBase64ZakiCorp(ttsText, { speaker: voice === "default" ? "vivian" : voice });
    } else {
      throw new Error("Unknown ttsVendor");
    }
  };
  try {
    await synthesizePrimary();
  } catch (e) {
    if (cfg.ttsVendor === "sakura") return fail(502, `TTS failed: ${e?.message || e}`);
    console.warn(`[TTS] ${cfg.ttsVendor} unavailable -> fallback sakura: ${e?.message || e}`);
    try {
      b64 = await ttsToBase64Sakura(ttsText, { model: "zundamon" });
      usedVendor = "sakura";
    } catch (e2) {
      return fail(502, `TTS failed: ${e2?.message || e2}`);
    }
  }

  // コスト記録（レスポンスとは独立、失敗しても無視。フォールバック時は実際に使った声で記録）
  trackTtsCost({ ownerId, ttsVendor: usedVendor, ttsModel: usedVendor === "sakura" ? "zundamon" : cfg.ttsModel, text: ttsText, b64Len: b64.length });

  // 音声バイナリを直接ストリーミング返却（S3に保存しない）
  const audioBuf = Buffer.from(b64, "base64");
  const mime = fmt === "mp3" ? "audio/mpeg" : "audio/wav";
  const out = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      "Content-Type": mime,
      "X-Audio-Format": fmt,
      ...(usedVendor !== cfg.ttsVendor ? { "X-TTS-Fallback": usedVendor } : {}),
      "Content-Disposition": `attachment; filename="toytalker-tts.${fmt}"`,
    },
  });
  out.write(audioBuf);
  out.end();
});
