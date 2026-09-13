// Node.js 18+ / ESM（index.mjs）
// Handler: index.handler
// ESP32向け相槌Lambda: raw PCMバイナリをレスポンスボディで返す
// ヘッダ X-Backchannel-Text に相槌テキストを格納
// Env: GOOGLE_API_KEY, OPENAI_API_KEY, SAKURA_API_KEY, ELEVENLABS_API_KEY, FISHAUDIO_API_KEY, ZAKICORP_API_KEY, ZAKICORP_TTS_URL,
//      CARTESIA_API_KEY, CARTESIA_DEFAULT_VOICE_ID (任意: CARTESIA_LANGUAGE 既定 "ja")
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
import { Agent, setGlobalDispatcher } from "undici";

// ---- fetchのkeep-alive延長（デフォルト4秒→60秒） ----
// 会話の間が空くとLLM/TTSへのTLS接続が閉じられ、次の相槌でハンドシェイクからやり直しになる
try {
  setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 }));
} catch (e) {
  console.log("[KeepAlive] setGlobalDispatcher failed:", e?.message);
}

// ---- 外部APIへの接続を事前確立（deep warmup） ----
const PREWARM_ORIGINS = ["https://generativelanguage.googleapis.com", "https://api.ai.sakura.ad.jp"];
const prewarmConnections = async (waitMs = 0) => {
  const jobs = PREWARM_ORIGINS.map(o =>
    fetch(o, { method: "HEAD", signal: AbortSignal.timeout(1500) }).catch(() => {})
  );
  if (waitMs > 0) await Promise.race([Promise.allSettled(jobs), new Promise(r => setTimeout(r, waitMs))]);
};

// ---- 予備インスタンスの事前ウォームアップ ----
// 本リクエスト処理中（=このインスタンスがビジー中）に自分自身へwarmup pingを非同期送信すると、
// 別のコールドなインスタンスに着弾して初期化されるため、2人目の同時利用時のコールドスタートを防げる
const lambdaSelfClient = new LambdaClient({});
function prewarmSpareInstance() {
  lambdaSelfClient.send(new InvokeCommand({
    FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    InvocationType: "Event",
    Payload: Buffer.from(JSON.stringify({ body: '{"warmup":true}' })),
  })).catch(() => {});
}

const ddbClient = new DynamoDBClient({ region: "ap-northeast-1" });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const DEVICES_TABLE    = "toytalker-devices";
const CHARACTERS_TABLE = "toytalker-characters";
const VOICES_TABLE     = "toytalker-voices";

// ---- TTS設定 ----
const TTS_TABLE = {
  OpenAI:     { ttsVendor: "openai",     ttsModel: "gpt-4o-mini-tts" },
  Google:     { ttsVendor: "google",     ttsModel: "google" },
  Gemini:     { ttsVendor: "gemini",     ttsModel: "gemini-2.5-flash-preview-tts" },
  ElevenLabs: { ttsVendor: "elevenlabs", ttsModel: "eleven_turbo_v2_5" },
  Cartesia:   { ttsVendor: "cartesia",   ttsModel: "sonic-3.6" },
  FishAudio:  { ttsVendor: "fishaudio",  ttsModel: "fishaudio" },
  Sakura:     { ttsVendor: "sakura",     ttsModel: "sakura" },
  ZakiCorp:   { ttsVendor: "zakicorp",   ttsModel: "zakicorp-tts" },
};
const TTS_DEFAULT = "Sakura";

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

// ---- device_idからキャラクター解決（ESP用） ----
async function resolveCharacterFromDevice(deviceId) {
  try {
    const deviceRes = await ddb.send(new GetCommand({
      TableName: DEVICES_TABLE,
      Key: { device_id: deviceId },
    }));
    const device = deviceRes.Item;
    if (!device) return null;

    if (device.character_id) {
      return resolveCharacter(device.character_id);
    }
    return null;
  } catch (e) {
    console.error("[resolveCharacterFromDevice] error:", e);
    return null;
  }
}

// ---- キャラクター解決 ----
async function resolveCharacter(characterId) {
  try {
    const charRes = await ddb.send(new GetCommand({
      TableName: CHARACTERS_TABLE,
      Key: { character_id: characterId },
    }));
    if (!charRes.Item) return null;

    const voiceId = charRes.Item.voice_id;
    const personalityPrompt = charRes.Item.personality_prompt || null;
    if (!voiceId) return null;

    const voiceRes = await ddb.send(new GetCommand({
      TableName: VOICES_TABLE,
      Key: { voice_id: voiceId },
    }));
    if (!voiceRes.Item) return null;

    return {
      provider: voiceRes.Item.provider,
      vendorId: voiceRes.Item.vendor_id,
      personalityPrompt,
    };
  } catch (e) {
    console.error("[resolveCharacter] error:", e);
    return null;
  }
}

// ---- LLM (相槌生成 - Gemini Flash) ----
async function generateBackchannel(partialText, personalityPrompt, history = [], pastBackchannels = []) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set");

  const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour: "numeric", minute: "numeric" });
  const isFirstTurn = history.length === 0;

  const historyContext = history.length > 0
    ? "\n直前の会話:\n" + history.map(h => `${h.role === "user" ? "ユーザー" : "あなた"}: ${h.content}`).join("\n") + "\n"
    : "";

  const firstTurnHint = isFirstTurn
    ? `\n- 会話の最初なので、時間帯（現在${now}）に合った挨拶で返してもよい（必須ではない）`
    : "";

  const avoidHint = pastBackchannels.length > 0
    ? `\n- 過去に使った相槌: ${pastBackchannels.join("、")}。これらとは違う表現を使うこと`
    : "";

  const systemPrompt = `あなたは会話相手で、相槌を打つ役割です。${personalityPrompt ? "あなたの性格: " + personalityPrompt + "\n" : ""}${historyContext}ユーザーが今まさに話している途中です。聞こえている部分と会話の流れに合った、自然な相槌を一言だけ返してください。
ルール:
- 相槌とは「聞いているよ」「わかるよ」という短い反応のこと
- 1〜15文字程度
- 句読点不要
- 話題の内容や感情に合った相槌を自分で考えて返す（楽しい・困っている・驚き・共感など）
- 会話の流れを見て、毎回違う表現を使う${firstTurnHint}${avoidHint}
- キャラの口調は使わず、自然な日本語の相槌にする
- 絶対に質問・返答・感想・コメントはしない。相槌のみ`;

  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: `（話し中）${partialText}` }] }],
        generationConfig: { maxOutputTokens: 20, temperature: 0.9, thinkingConfig: { thinkingBudget: 0 } },
      }),
    }
  );
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini failed: ${resp.status} ${errText}`);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "うん";
  return text.trim();
}

// ---- TTS functions (raw PCM Buffer) ----

async function ttsPcmOpenAI(text, { model = "gpt-4o-mini-tts", voice = "alloy" } = {}) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("OPENAI_API_KEY is not set");
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text, voice, response_format: "pcm" }),
  });
  if (!resp.ok) throw new Error(`OpenAI TTS failed: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function ttsPcmGoogle(text, { voiceName = "ja-JP-Neural2-B", sampleRateHertz = 24000 } = {}) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set");
  const parts = String(voiceName).split("-");
  const languageCode = parts.length >= 2 ? `${parts[0]}-${parts[1]}` : "ja-JP";
  const resp = await fetch(
    `https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        input: { text },
        voice: { languageCode, name: voiceName },
        audioConfig: { audioEncoding: "LINEAR16", speakingRate: 1.2, pitch: 3.0, sampleRateHertz },
      }),
    }
  );
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.message || "Google TTS failed");
  return Buffer.from(json.audioContent, "base64");
}

async function ttsPcmGemini(text, { model = "gemini-2.5-flash-preview-tts", voiceName = "Kore" } = {}) {
  const key = process.env.GOOGLE_API_KEY;
  if (!key) throw new Error("GOOGLE_API_KEY is not set");
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ["AUDIO"],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } },
        },
        model,
      }),
    }
  );
  const json = await resp.json();
  if (!resp.ok) throw new Error(json?.error?.message || "Gemini TTS failed");
  const b64Pcm = json?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || "";
  if (!b64Pcm) throw new Error("Gemini TTS: empty audio");
  return Buffer.from(b64Pcm, "base64");
}

async function ttsPcmElevenLabs(text, { model = "eleven_turbo_v2_5", voiceId = "hMK7c1GPJmptCzI4bQIu" } = {}) {
  const key = process.env.ELEVENLABS_API_KEY;
  if (!key) throw new Error("ELEVENLABS_API_KEY is not set");
  const resp = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000&optimize_streaming_latency=0`,
    {
      method: "POST",
      headers: { "xi-api-key": key, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: model, voice_settings: { stability: 0.5, similarity_boost: 0.75 } }),
    }
  );
  if (!resp.ok) throw new Error(`ElevenLabs TTS failed: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

// Cartesia TTS → raw PCM Buffer (24kHz/16bit/mono)
const CARTESIA_API_VERSION = "2026-08-14";
async function ttsPcmCartesia(text, { model = "sonic-3.6", voiceId } = {}) {
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
      output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
    }),
  });
  if (!resp.ok) throw new Error(`Cartesia TTS failed: ${resp.status} ${await resp.text()}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function ttsPcmFishAudio(text, { referenceId = "e58b0d7efca34eb38d5c4985e9e1e3e6" } = {}) {
  const key = process.env.FISHAUDIO_API_KEY;
  if (!key) throw new Error("FISHAUDIO_API_KEY is not set");
  const resp = await fetch("https://api.fish.audio/v1/tts", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text, reference_id: referenceId, format: "pcm", sample_rate: 24000, latency: "normal" }),
  });
  if (!resp.ok) throw new Error(`FishAudio TTS failed: ${resp.status}`);
  return Buffer.from(await resp.arrayBuffer());
}

async function ttsPcmSakura(text, { model = "zundamon", style = "normal" } = {}) {
  const key = process.env.SAKURA_API_KEY;
  if (!key) throw new Error("SAKURA_API_KEY is not set");
  const resp = await fetch("https://api.ai.sakura.ad.jp/v1/audio/speech", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
      "Accept": "audio/wav",
    },
    body: JSON.stringify({ model, input: text, voice: style, response_format: "wav" }),
  });
  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`Sakura TTS failed: ${resp.status} ${errorText}`);
  }
  const wavBuffer = Buffer.from(await resp.arrayBuffer());
  return wavBuffer.slice(44); // WAVヘッダ(44bytes)をスキップ
}

// ZakiCorp TTS (clone voice via local GPU) → raw PCM Buffer
async function ttsPcmZakiCorp(text, { speaker = "vivian", language = "Japanese" } = {}) {
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
  return Buffer.from(await resp.arrayBuffer());
}

// ---- TTS音声の先頭/末尾の無音トリミング（24kHz/16bit/mono前提） ----
// 相槌は速さが命なので、TTSが付ける前後の無音を削って体感を詰める
function trimSilence(pcm, { threshold = 512, padMs = 80, sampleRate = 24000 } = {}) {
  const total = Math.floor(pcm.length / 2);
  if (total === 0) return pcm;
  let start = 0, end = total - 1;
  while (start < total && Math.abs(pcm.readInt16LE(start * 2)) < threshold) start++;
  while (end > start && Math.abs(pcm.readInt16LE(end * 2)) < threshold) end--;
  if (start >= end) return pcm;  // 全体が無音なら触らない
  const pad = Math.round(sampleRate * padMs / 1000);
  const headCut = Math.max(0, start - pad);
  const tailCut = Math.min(total - 1, end + pad);
  const trimmed = pcm.slice(headCut * 2, (tailCut + 1) * 2);
  const cutMs = Math.round(((total - (tailCut - headCut + 1)) / sampleRate) * 1000);
  if (cutMs > 0) {
    console.log(`[TrimSilence] cut ${cutMs}ms (head ${Math.round(headCut / sampleRate * 1000)}ms, tail ${Math.round((total - 1 - tailCut) / sampleRate * 1000)}ms)`);
  }
  return trimmed;
}

// ---- TTS ルーティング ----
async function generateTTSPcm(text, vendor, voice) {
  switch (vendor) {
    case "sakura":     return ttsPcmSakura(text, { model: voice || "zundamon" });
    case "openai":     return ttsPcmOpenAI(text, { voice: voice || "alloy" });
    case "google":     return ttsPcmGoogle(text, { voiceName: voice });
    case "gemini":     return ttsPcmGemini(text, { voiceName: voice || "Kore" });
    case "elevenlabs": return ttsPcmElevenLabs(text, { voiceId: voice });
    case "cartesia":   return ttsPcmCartesia(text, { voiceId: voice });
    case "fishaudio":  return ttsPcmFishAudio(text, { referenceId: voice });
    case "zakicorp":   return ttsPcmZakiCorp(text, { speaker: voice || "vivian" });
    default:           return ttsPcmSakura(text, { model: "zundamon" });
  }
}

// ---- Handler (BUFFEREDモード - isBase64Encodedでバイナリ返却) ----
export const handler = async (event) => {
  const start = Date.now();
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    if (body.warmup) return { statusCode: 200, body: "warm" };  // EventBridgeウォームアップping
    prewarmSpareInstance();  // 処理中に予備インスタンスを温める（同時2人目対策）
    prewarmConnections();    // LLM/TTS接続を先行確立（keep-alive切れ時の保険、非同期）
    const partialText = body.partial_text ?? "";
    const deviceId = body.device_id ?? null;
    const characterId = body.character_id ?? null;
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
    const pastBackchannels = Array.isArray(body.past_backchannels) ? body.past_backchannels.slice(-10) : [];

    if (!partialText) {
      return { statusCode: 400, body: JSON.stringify({ error: "partial_text is required" }) };
    }

    // キャラクター設定を解決（device_id優先、なければcharacter_id）
    let ttsVendor = "sakura";
    let ttsVoice = "zundamon";
    let personalityPrompt = null;

    let charConfig = null;
    if (deviceId) {
      charConfig = await resolveCharacterFromDevice(deviceId);
    }
    if (!charConfig && characterId) {
      charConfig = await resolveCharacter(characterId);
    }
    if (charConfig) {
      const ttsKey = normalizeModelKey(charConfig.provider) ?? TTS_DEFAULT;
      const cfg = TTS_TABLE[ttsKey] ?? TTS_TABLE[TTS_DEFAULT];
      ttsVendor = cfg.ttsVendor;
      ttsVoice = charConfig.vendorId ?? ttsVoice;
      personalityPrompt = charConfig.personalityPrompt;
    }

    // LLM生成
    const backchannelText = await generateBackchannel(partialText, personalityPrompt, history, pastBackchannels);
    console.log(`[Backchannel] "${partialText}" → "${backchannelText}" (${Date.now() - start}ms) history=${history.length}turns`);

    // TTS生成 (raw PCM)
    const ttsStart = Date.now();
    const pcmBuffer = trimSilence(await generateTTSPcm(backchannelText, ttsVendor, ttsVoice));
    console.log(`[TTS] ${ttsVendor}/${ttsVoice} pcm=${pcmBuffer.length}bytes (${Date.now() - ttsStart}ms)`);
    console.log(`[Total] ${Date.now() - start}ms`);

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Backchannel-Text": encodeURIComponent(backchannelText),
        "X-Pcm-Length": String(pcmBuffer.length),
        "X-Latency-Ms": String(Date.now() - start),
      },
      body: pcmBuffer.toString("base64"),
      isBase64Encoded: true,
    };
  } catch (err) {
    console.error("[Backchannel] error:", err);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  }
};
