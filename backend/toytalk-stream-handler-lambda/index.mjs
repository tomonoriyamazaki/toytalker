  // Node.js 18+ / ESM（index.mjs）
  // Handler: index.handler
  // Env: OPENAI_API_KEY, GOOGLE_API_KEY, ELEVENLABS_API_KEY, FISHAUDIO_API_KEY, ZAKICORP_API_KEY, ZAKICORP_TTS_URL,
  //      CARTESIA_API_KEY, CARTESIA_DEFAULT_VOICE_ID (任意: CARTESIA_LANGUAGE 既定 "ja")
  import OpenAI from "openai";
  import { createHash } from "node:crypto";
  import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
  import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
  import { ensureSecrets, secret } from "../shared/secrets.mjs";
  import { tableName } from "../shared/tables.mjs";
  import { checkBalance, NO_BALANCE } from "../shared/wallet.mjs";
  import { chatStream, toolRoundMessages, searchWeb, WEB_SEARCH_TOOL, TOOL_RESULT_INSTRUCTION, SEARCH_TOOL_HINT, searchCallArgs, isSearchPreface, isSearchPromiseOnly, inlineLastToolRound, loadDefaultLlm } from "../shared/llm.mjs";
  import { startTrace, describeClient, describePrevTurn, errorStatus } from "../shared/trace.mjs";
import { authenticate, authGate, describeAuth, resolveOwner } from "../shared/auth.mjs";
import { chatLogEnabled } from "../shared/chat-log.mjs";
import { loadPricingCache } from "../shared/cost.mjs";
import { recordTurn } from "../shared/turn-record.mjs";
import { saveChatLog } from "../shared/chat-log.mjs";
import { prewarmSpareInstance } from "../shared/warm.mjs";
import { normalizeModelKey } from "../shared/tts-vendors.mjs";

  const ddbClient = new DynamoDBClient({ region: "ap-northeast-1" });
  const ddb = DynamoDBDocumentClient.from(ddbClient);
  const CHARACTERS_TABLE    = tableName("characters");
  const VOICES_TABLE        = tableName("voices");
  const LLMS_TABLE          = tableName("llms");

  // 鍵はSSMから実行時に取るので、クライアントは最初に使うときに作る（鍵が変わったら作り直す）
  let openaiClient = null;
  let openaiClientKey = null;
  function getOpenAI() {
    const key = secret("OPENAI_API_KEY");
    if (!openaiClient || key !== openaiClientKey) {
      openaiClient = new OpenAI({ apiKey: key });
      openaiClientKey = key;
    }
    return openaiClient;
  }

  // ---- チューニング定数 ----
  const HEAD_MIN_CHARS = 24;      // 今回は使わない（ヘッドTTS無効）
  const SEG_MAX_CHARS  = 100;     // 文末で自然に区切るため増加（安全網として残す）
  const TTS_FORMAT     = "wav";
  const VOICE_DEFAULT  = "alloy";
  const DEBUG          = false;
  const DEBUG_TIME     = process.env.DEBUG_TIME === "true";

  const send  = (res, ev, data)=>res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
  const sha1  = (s)=>createHash("sha1").update(s).digest("hex");

  // ---- TTS設定（プロバイダーごと）----
  const TTS_DEFAULT = "OpenAI";
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

  // 既定の LLM（キャラクターに llm_id が無いとき）は backend/shared/llm.mjs の loadDefaultLlm



  // 文末かどうか（簡易）
  function endsWithSentence(s) {
    return /[。！？!?]\s*$/.test(s);
  }

  // OpenAI TTS → base64
  async function ttsToBase64OpenAI(text, voice, ttsModel) {
    const tts = await getOpenAI().audio.speech.create({
      model: ttsModel,
      input: text,
      voice,
      format: TTS_FORMAT
    });
    const buf = Buffer.from(await tts.arrayBuffer());
    return buf.toString("base64");
  }

  // PCM16 (LINEAR16) を WAV へラップして base64 を返す
  function pcm16ToWavBase64(pcmB64, sampleRate = 24000, channels = 1) {
    // 入力: Google TTS の LINEAR16 base64（LE, signed）
    let pcm = Buffer.from(pcmB64, "base64");

    const bytesPerSample = 2;
    const totalSamples = pcm.length / bytesPerSample;

    // --- DCオフセット除去（平均値を0に寄せる） ---
    let sum = 0;
    for (let i = 0; i < totalSamples; i++) sum += pcm.readInt16LE(i * 2);
    const mean = sum / totalSamples;
    for (let i = 0; i < totalSamples; i++) {
      const v = pcm.readInt16LE(i * 2) - mean;
      pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
    }

    // --- 先頭/末尾 をハニング窓でフェード（Google TTSの冒頭クリック音潰し） ---
    const fadeMs = 12;
    const fadeSamples = Math.min(
      Math.floor(sampleRate * fadeMs / 1000),
      Math.floor(totalSamples / 4)
    );
    for (let i = 0; i < fadeSamples; i++) {
      const wIn  = 0.5 * (1 - Math.cos(Math.PI * i / fadeSamples));                 // 0→1
      const wOut = 0.5 * (1 - Math.cos(Math.PI * (fadeSamples - i) / fadeSamples)); // 1→0
      // in
      const vi = pcm.readInt16LE(i * 2);
      pcm.writeInt16LE(Math.round(vi * wIn), i * 2);
      // out
      const idx = (totalSamples - 1 - i) * 2;
      const vo = pcm.readInt16LE(idx);
      pcm.writeInt16LE(Math.round(vo * wOut), idx);
    }

    // --- 先頭の無音パッド（Google TTSの冒頭クリック音吸収）---
    const padHeadMs = 40;
    const padSamples = Math.max(1, Math.floor(sampleRate * padHeadMs / 1000));
    const pad = Buffer.alloc(padSamples * bytesPerSample, 0);
    pcm = Buffer.concat([pad, pcm]);

    // --- WAV ラップ ---
    const byteRate   = sampleRate * channels * 2;
    const blockAlign = channels * 2;
    const dataSize   = pcm.length;
    const headerSize = 44;
    const buf = Buffer.alloc(headerSize + dataSize);
    buf.write("RIFF", 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write("WAVE", 8);
    buf.write("fmt ", 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(byteRate, 28);
    buf.writeUInt16LE(blockAlign, 32);
    buf.writeUInt16LE(16, 34);
    buf.write("data", 36);
    buf.writeUInt32LE(dataSize, 40);
    pcm.copy(buf, 44);
    return buf.toString("base64");
  }

  function resolveGoogleTtsFromBody(body) {
    const t = body?.tts || {};
    // Googleのvoice形式だけ通す（alloy等が入っても安全に既定へ）
    const cand = t.voice || body?.voice;
    const isGoogleVoice = typeof cand === "string" && /^[a-z]{2}-[A-Z]{2}-/.test(cand);
    const voiceName = isGoogleVoice ? cand : "ja-JP-Neural2-B";

    return {
     voiceName,
     // ← 未指定は "入れない"（= undefined を返す）
     speakingRate: (typeof t.speakingRate === "number") ? t.speakingRate : undefined,
     pitch:        (typeof t.pitch        === "number") ? t.pitch        : undefined,
     sampleRateHertz: (typeof t.sampleRateHertz === "number") ? t.sampleRateHertz : undefined,
      audioEncoding: "LINEAR16", // ★ WAV固定（LINEAR16→WAVラップ）
    };
  }

  // Google Cloud Text-to-Speech (API Key) → base64(WAV)
  async function ttsToBase64Google(
    text,
    {
      voiceName,
      speakingRate = 1.3,
      pitch = 3.0,
      sampleRateHertz = 24000,
      audioEncoding = "LINEAR16", // ← WAVに包む前提
    } = {}
  ) {
    const key = secret("GOOGLE_API_KEY");
    if (!key) throw new Error("GOOGLE_API_KEY is not set");
    // 例: "ja-JP-Neural2-B" → "ja-JP"
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
          audioConfig: {
            audioEncoding,
            speakingRate,
            pitch,
            sampleRateHertz,
          },
        }),
      }
    );
    const json = await resp.json();
    if (!resp.ok) {
      const msg = json?.error?.message || "Google TTS failed";
      throw new Error(msg);
    }
    // json.audioContent は PCM16 (raw)。→ WAV に包んで返す
    return pcm16ToWavBase64(json.audioContent, sampleRateHertz, 1);
  }


  // Gemini 用の voice 解決（アプリから "Lede"/"Puck" などが来る想定）
  function resolveGeminiTtsFromBody(body, cfg) {
    const t = body?.tts || {};
    const cand = t.voice || body?.voice;
    const looksGoogle = typeof cand === "string" && /^[a-z]{2}-[A-Z]{2}-/.test(cand);
    const looksGemini = typeof cand === "string"
      && /^[A-Za-z][A-Za-z0-9_-]{1,40}$/.test(cand)   // 英数/アンダースコア/ハイフン可
      && !looksGoogle;                                 // Google 形式は除外
    const voiceName = looksGemini ? cand : "leda";     // 既定は Kore（Lede/Puck 等でもOK）
    return { model: cfg.ttsModel, voiceName };
  }

  // Gemini Speech Generation → { b64, audioTokens } （APIキーは GOOGLE_API_KEY を共用）
  async function ttsToBase64Gemini(text, { model = "gemini-2.5-flash-preview-tts", voiceName = "Kore" } = {}) {
    const key = secret("GOOGLE_API_KEY");
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
      if (b64Pcm) {
        const audioTokens = json?.usageMetadata?.candidatesTokenCount ?? 0;
        return { b64: pcm16ToWavBase64(b64Pcm, 24000, 1), audioTokens };
      }
      console.log(`[Gemini TTS] empty audio, retry ${attempt + 1}/${maxRetries + 1}`);
    }
    throw new Error("Gemini TTS: empty audio after retries");
  }

  // ElevenLabs TTS → base64(WAV)
  async function ttsToBase64ElevenLabs(text, { model = "eleven_turbo_v2_5", voiceId = "hMK7c1GPJmptCzI4bQIu" } = {}) {
    const key = secret("ELEVENLABS_API_KEY");
    if (!key) throw new Error("ELEVENLABS_API_KEY is not set");

    const resp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream?output_format=pcm_24000&optimize_streaming_latency=0`,
      {
        method: "POST",
        headers: {
          "xi-api-key": key,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          text,
          model_id: model,
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.75
          }
        })
      }
    );

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`ElevenLabs TTS failed: ${resp.status} ${errorText}`);
    }

    // PCMバイナリデータを取得
    const pcmBuffer = Buffer.from(await resp.arrayBuffer());

    // PCM16 → WAV base64 に変換
    const pcmB64 = pcmBuffer.toString("base64");
    return pcm16ToWavBase64(pcmB64, 24000, 1);
  }

  // Cartesia TTS 共通: /tts/bytes を呼び、要求した形式の音声バイナリをBufferで返す
  const CARTESIA_API_VERSION = "2026-08-14";
  async function ttsBytesCartesia(text, { model, voiceId, outputFormat }) {
    const key = secret("CARTESIA_API_KEY");
    if (!key) throw new Error("CARTESIA_API_KEY is not set");
    const id = voiceId || process.env.CARTESIA_DEFAULT_VOICE_ID;
    if (!id) throw new Error("Cartesia voice ID is not set (CARTESIA_DEFAULT_VOICE_ID)");

    const resp = await fetch("https://api.cartesia.ai/tts/bytes", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Cartesia-Version": CARTESIA_API_VERSION,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model_id: model,
        transcript: text,
        voice: { id },
        language: process.env.CARTESIA_LANGUAGE || "ja",
        output_format: outputFormat,
      }),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Cartesia TTS failed: ${resp.status} ${errorText}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  // Cartesia TTS → base64(WAV)
  async function ttsToBase64Cartesia(text, { model = "sonic-3.6", voiceId } = {}) {
    const pcmBuffer = await ttsBytesCartesia(text, {
      model, voiceId,
      outputFormat: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
    });
    return pcm16ToWavBase64(pcmBuffer.toString("base64"), 24000, 1);
  }

  // ---- TTSフォールバック ----
  // 主プロバイダーが 429（同時接続上限）や 5xx で失敗したら短く再試行し、だめならずんだもん（Sakura）で続ける。
  // 主プロバイダーが遅いとき（1文の合成が TTS_SLOW_MS を超えた）も、待たずにずんだもんへ切り替える（再試行はしない）。
  // ふだんは Cartesia で最大2秒程度（2026-10の実測）。Gemini はふだんから数秒かかるので対象外。
  // 長い文ほど合成に時間がかかるので、待つ時間は TTS_SLOW_MS ＋ 1文字あたりの上乗せ（声ごと）。
  // 上乗せの根拠（声ごとの実測）は docs/tts-fallback-and-notifications.md の第2節。
  // 一度切り替えたらその返答の残りはずんだもんのまま。仕様: docs/tts-fallback-and-notifications.md
  const TTS_RETRY_WAITS_MS = [300, 600];
  const TTS_FALLBACK_NOTICE = "いまはこんでいるから、べつのこえでおはなしするね。";
  const ttsErrorStatus = errorStatus;
  function isRetryableTtsError(e) {
    const s = ttsErrorStatus(e);
    return s === 429 || s === 408 || (s !== null && s >= 500);
  }
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));
  const TTS_SLOW_MS = 3000;
  const TTS_SLOW_MS_PER_CHAR = { cartesia: 15, openai: 15, fishaudio: 50, zakicorp: 50 };
  const TTS_SLOW_MS_PER_CHAR_DEFAULT = 30;
  const ttsSlowMs = (vendor, text) => TTS_SLOW_MS + (TTS_SLOW_MS_PER_CHAR[vendor] ?? TTS_SLOW_MS_PER_CHAR_DEFAULT) * Array.from(text ?? "").length;
  const TTS_SLOW_EXEMPT = new Set(["sakura", "gemini"]);
  class TtsSlowError extends Error {
    constructor(ms) { super(`TTS slower than ${ms}ms`); this.name = "TtsSlowError"; this.slow = true; }
  }
  // 打ち切った呼び出しは裏で走り切るが、結果は捨てる（その分の主プロバイダーの費用は記録されない）
  function withTtsDeadline(promise, ms) {
    let timer;
    const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new TtsSlowError(ms)), ms); });
    promise.catch(() => {});
    return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
  }

  // Fish Audio TTS → base64(WAV)
  async function ttsToBase64FishAudio(text, { referenceId = "6fdaebea7db042129f03ecb0a57ea7b6" } = {}) {
    const key = secret("FISHAUDIO_API_KEY");
    if (!key) throw new Error("FISHAUDIO_API_KEY is not set");

    const resp = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        text,
        reference_id: referenceId,
        format: "mp3",
        latency: "low",
      }),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Fish Audio TTS failed: ${resp.status} ${errorText}`);
    }

    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.toString("base64");
  }

  // Fish Audio reference ID 解決
  function resolveFishAudioTtsFromBody(body) {
    const t = body?.tts || {};
    const cand = t.referenceId || body?.voice;
    const isFishVoiceId = typeof cand === "string" && /^[a-f0-9]{32}$/.test(cand);
    const referenceId = isFishVoiceId ? cand : "6fdaebea7db042129f03ecb0a57ea7b6";
    return { referenceId };
  }

  // ElevenLabs voice ID 解決
  function resolveElevenLabsTtsFromBody(body, cfg) {
    const t = body?.tts || {};
    const cand = t.voiceId || body?.voiceId || body?.voice;
    // ElevenLabsのvoiceIdは英数字とハイフンで構成される
    const isElevenLabsVoiceId = typeof cand === "string" && /^[a-zA-Z0-9]{20,}$/.test(cand);
    const voiceId = isElevenLabsVoiceId ? cand : "hMK7c1GPJmptCzI4bQIu"; // デフォルト: Sameno
    return { model: cfg.ttsModel, voiceId };
  }

  // Cartesia voice ID 解決
  function resolveCartesiaTtsFromBody(body, cfg) {
    const t = body?.tts || {};
    const cand = t.voiceId || body?.voiceId || body?.voice;
    // CartesiaのvoiceIdはUUID形式
    const isCartesiaVoiceId = typeof cand === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cand);
    const voiceId = isCartesiaVoiceId ? cand : undefined; // 未指定時は環境変数 CARTESIA_DEFAULT_VOICE_ID を使う
    return { model: cfg.ttsModel, voiceId };
  }

  // Sakura Internet TTS (VOICEVOX) → base64(WAV)
  async function ttsToBase64Sakura(text, { model = "zundamon", style = "normal" } = {}) {
    const key = secret("SAKURA_API_KEY");
    if (!key) throw new Error("SAKURA_API_KEY is not set");
    const resp = await fetch("https://api.ai.sakura.ad.jp/v1/audio/speech", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "Accept": "audio/wav",
      },
      body: JSON.stringify({
        model,
        input: text,
        voice: style,
        response_format: "wav",
      }),
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Sakura TTS failed: ${resp.status} ${errorText}`);
    }
    const wavBuffer = Buffer.from(await resp.arrayBuffer());
    return wavBuffer.toString("base64");
  }

  function pcmToWavBase64(pcmBuf, sampleRate = 24000, channels = 1) {
    const wav = Buffer.alloc(44 + pcmBuf.length);
    wav.write("RIFF", 0);
    wav.writeUInt32LE(36 + pcmBuf.length, 4);
    wav.write("WAVE", 8);
    wav.write("fmt ", 12);
    wav.writeUInt32LE(16, 16);
    wav.writeUInt16LE(1, 20);
    wav.writeUInt16LE(channels, 22);
    wav.writeUInt32LE(sampleRate, 24);
    wav.writeUInt32LE(sampleRate * channels * 2, 28);
    wav.writeUInt16LE(channels * 2, 32);
    wav.writeUInt16LE(16, 34);
    wav.write("data", 36);
    wav.writeUInt32LE(pcmBuf.length, 40);
    pcmBuf.copy(wav, 44);
    return wav.toString("base64");
  }

  // ZakiCorp TTS (clone voice via local GPU) — streaming chunks
  async function ttsToBase64ZakiCorp(text, { speaker = "vivian", language = "Japanese" } = {}) {
    const key = secret("ZAKICORP_API_KEY");
    const baseUrl = process.env.ZAKICORP_TTS_URL;
    if (!key || !baseUrl) throw new Error("ZAKICORP_API_KEY or ZAKICORP_TTS_URL is not set");
    const resp = await fetch(`${baseUrl}/v1/tts/stream`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        // Cloudflareの拠点で検査する合言葉（WAFカスタムルール）。未設定なら送らない
        ...(secret("ZAKICORP_EDGE_KEY") ? { "X-Zakicorp-Edge-Key": secret("ZAKICORP_EDGE_KEY") } : {}),
      },
      body: JSON.stringify({ text, language, speaker }),
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`ZakiCorp TTS failed: ${resp.status} ${errorText}`);
    }
    const sampleRate = parseInt(resp.headers.get("X-Sample-Rate") || "24000");
    const channels = parseInt(resp.headers.get("X-Channels") || "1");
    const pcmBuf = Buffer.from(await resp.arrayBuffer());
    return pcmToWavBase64(pcmBuf, sampleRate, channels);
  }

  async function resolveCharacterFromDynamo(characterId) {
    try {
      const charRes = await ddb.send(new GetCommand({
        TableName: CHARACTERS_TABLE,
        Key: { character_id: characterId },
      }));
      if (!charRes.Item) return null;

      const voiceId = charRes.Item.voice_id;
      const personalityPrompt = charRes.Item.personality_prompt || null;
      const llmId = charRes.Item.llm_id ?? null;
      if (!voiceId) return null;

      const voiceRes = await ddb.send(new GetCommand({
        TableName: VOICES_TABLE,
        Key: { voice_id: voiceId },
      }));
      if (!voiceRes.Item) return null;

      let llmProvider = null;
      let llmModelId  = null;
      if (llmId) {
        const llmRes = await ddb.send(new GetCommand({
          TableName: LLMS_TABLE,
          Key: { llm_id: llmId },
        }));
        if (llmRes.Item) {
          llmProvider = llmRes.Item.provider;
          llmModelId  = llmRes.Item.model_id;
        }
      }

      return {
        provider: voiceRes.Item.provider,
        vendorId: voiceRes.Item.vendor_id,
        personalityPrompt,
        llmProvider,
        llmModelId,
        ownerId: charRes.Item.owner_id ?? null,
      };
    } catch (e) {
      console.error("[DynamoDB] resolveCharacterFromDynamo error:", e);
      return null;
    }
  }

  export const handler = awslambda.streamifyResponse(async (event, res, context) => {
    const requestAt = Date.now();
    res.setContentType("text/event-stream");
    await ensureSecrets();

    const body      = event.body ? JSON.parse(event.body) : {};
    if (body.warmup) { res.end(); return; }  // EventBridgeウォームアップping（コールドスタート対策）
    // 切り分け用のログ。1リクエスト1行のJSONで、会話の文章は書かない（backend/shared/trace.mjs）
    const trace = startTrace("turn", { event, context, t0: requestAt });
    trace.mark("secrets");
    trace.set(describeClient(event, body)); // 拒否するときもログに出どころ（edge / ua / app_version）を残す
    // 拒否応答（401/403）。ストリームを開く前に JSON 1つで返す。LLM も TTS も走らない
    const reject = (gate) => {
      trace.set({ status: gate.statusCode, reason: gate.error });
      trace.finish();
      const s = awslambda.HttpResponseStream.from(res, { statusCode: gate.statusCode, headers: { "Content-Type": "application/json" } });
      s.write(JSON.stringify({ error: gate.error }));
      s.end();
    };
    // 本人確認（backend/shared/auth.mjs、docs/auth.md）。本番はトークン必須、RnD はトークン無しも通す
    const identity = await authenticate(event);
    trace.set(describeAuth(identity));
    const denied = authGate(identity);
    if (denied) return reject(denied);
    prewarmSpareInstance();  // 処理中に予備インスタンスを温める（同時2人目対策）
    const messages  = body.messages ?? [{ role:"user", content:"自己紹介して" }];
    const rawModel  = typeof body.model === "string" ? body.model : undefined;
    let ttsKey      = normalizeModelKey(rawModel) ?? TTS_DEFAULT;
    let voice       = body.voice ?? VOICE_DEFAULT;
    let personalityPrompt = null;
    let llmProvider = null;
    let llmModelId  = null;

    // ---- ログ用メタデータ ----
    const sessionId  = typeof body.session_id === "string" ? body.session_id : "unknown";
    // トークン付きなら users テーブルの owner_id（クライアントの自称は無視）。無しなら従来どおり本文の owner_id
    const owner      = await resolveOwner(identity, typeof body.owner_id === "string" ? body.owner_id : undefined);
    const ownerId    = owner.ownerId ?? "user_123";
    // 会話の文章を残すか（backend/shared/chat-log.mjs。環境の既定を、users の行の chat_log が上書きする）
    const chatLog    = chatLogEnabled(owner.user);
    trace.set({ chat_log: chatLog });
    const deviceId   = typeof body.device_id  === "string" ? body.device_id  : "app";
    const userTimestamp = new Date(requestAt).toISOString();
    const backchannelFired = !!body.backchannel_fired;
    const characterId = typeof body.character_id === "string" ? body.character_id : null;
    trace.set({
      source: "app", session_id: sessionId, device_id: deviceId, owner_id: ownerId, character_id: characterId,
      backchannel_fired: backchannelFired, history_messages: messages.length,
      user_chars: messages[messages.length - 1]?.content?.length ?? 0,
      ...describeClient(event, body),
      prev_turn: describePrevTurn(body.prev_turn), // 前のターンをクライアントが受け取って鳴らしたか（送らない版は null）
    });

    // 残高が0以下なら始めない（docs/pricing-and-cost-model.md 11.3）。キャラクターの読み込みと並べて読む
    const balanceCheck = checkBalance(ownerId);

    // 単価キャッシュ・デフォルトLLMを先にロード（await不要、バックグラウンドで）
    loadPricingCache();
    loadDefaultLlm();

    if (characterId) {
      const charConfig = await resolveCharacterFromDynamo(characterId);
      if (charConfig) {
        // 他人のキャラクター（人格プロンプト = 子どもに話す内容）は使えない。system 製は誰でも
        if (identity.auth === "user" && charConfig.ownerId && charConfig.ownerId !== "system" && charConfig.ownerId !== ownerId) {
          return reject({ statusCode: 403, error: "not_owner" });
        }
        ttsKey = normalizeModelKey(charConfig.provider) ?? ttsKey;
        voice    = charConfig.vendorId ?? voice;
        personalityPrompt = charConfig.personalityPrompt;
        llmProvider = charConfig.llmProvider;
        llmModelId  = charConfig.llmModelId;
        trace.set({ has_personality: !!personalityPrompt });
      } else {
        trace.set({ character_found: false }); // キャラクターかボイスが無い。body の値で続ける
      }
    }

    if (!(await balanceCheck).ok) return reject({ statusCode: 402, error: NO_BALANCE });

    // キャラ側にLLM指定がなければ is_default エントリを使う
    if (!llmProvider || !llmModelId) {
      const d = await loadDefaultLlm();
      llmProvider = d.provider;
      llmModelId  = d.modelId;
    }

    const cfg = TTS_TABLE[ttsKey] ?? TTS_TABLE[TTS_DEFAULT];
    trace.set({ llm: `${llmProvider}/${llmModelId}`, tts: cfg.ttsVendor, voice });
    trace.mark("config");

    // ---- ユーザーメッセージ保存 ----
    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg?.role === "user" && sessionId !== "unknown" && chatLog) {
      saveChatLog({
        "owner_id#device_id":   `owner_id#${ownerId}#device_id#${deviceId}`,
        "session_id#timestamp": `session_id#${sessionId}#timestamp#${userTimestamp}`,
        owner_id: ownerId, device_id: deviceId, source: "app",
        role: "user", content: lastUserMsg.content,
        content_type: "text", timestamp: userTimestamp, session_id: sessionId,
      });
    }



    send(res, "mark", { k: "model", v: ttsKey });
    send(res, "mark", { k: "llm_vendor", v: llmProvider });
    send(res, "mark", { k: "llm_model", v: llmModelId });
    send(res, "mark", { k: "tts_vendor", v: cfg.ttsVendor });

    // サーバ基準時刻（クライアントがREQ_TTFBやLLM/TTSとの相対を取れる）
    if (DEBUG_TIME) {
      send(res, "ping", { t: Date.now() });
    }

    // ---- LLM 開始 ----
    if (DEBUG_TIME) {
      send(res, "mark", { k: "llm_start", t: Date.now() });
    }
    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
    const backchannelHint = backchannelFired ? "\n【重要】相槌は別途再生済みです。冒頭の相槌・挨拶・オウム返しは不要です。本題から返答を始めてください。口調や温かさはいつも通りのままにしてください。" : "";
    // 検索後の「前置きなし」指示はシステムプロンプトに置かず、検索結果を返すメッセージ側（TOOL_RESULT_INSTRUCTION）に添える。
    // システムプロンプトに置くと通常ターンの口調まで素っ気なくなるため。
    // 検索ツールは3社共通（backend/shared/llm.mjs）。プロンプトの「検索できます」と実際のツール付与は必ず同じ条件にする
    const enableTools = !!secret("BRAVE_API_KEY");
    const toolHint = enableTools ? SEARCH_TOOL_HINT : "";
    const basePrompt = `あなたは子供向けの友好的な音声アシスタントです。簡潔に答えて、自然に会話を続けてください。単語の間に半角スペースを入れないでください。現在の日時は${now}です。日時を聞かれたら年は省略して簡潔に答えてください。相手が話した言語で返答してください。${backchannelHint}${toolHint}`;
    const systemContent = personalityPrompt ? `${personalityPrompt}\n\n${basePrompt}` : basePrompt;
    const messagesWithSystem = [{ role: "system", content: systemContent }, ...messages];

    // ---- ストリーム状態 ----
    let buf = "";
    let textAll = "";
    let segSeq = 0;
    let lastSegHash = "";
    let firstTtsMarked = false;
    const llmUsage = { in: 0, out: 0 }; // LLMトークン数（検索ありのターンは2要求分の合計）
    let ttsInputChars = 0;
    const toolCalls = {};  // ツール名→成功回数。PAID_TOOLSに載っているものだけ課金対象
    let ttsFallbackActive = false;   // この返答でずんだもんへ切り替え済みか
    let ttsFallbackChars = 0;        // ずんだもんで生成した文字数（Sakura分として記録）
    let ttsPcmBytes = 0;
    let geminiTtsAudioTokens = 0;

    // ---- LLM ストリーム（共通モジュール。会社ごとの違いは backend/shared/llm.mjs に閉じる）----
    const toolsDef = enableTools ? [WEB_SEARCH_TOOL] : null;
    const createLLMStream = (msgs, opts = {}) => chatStream({ provider: llmProvider, model: llmModelId, messages: msgs, tools: toolsDef, usage: llmUsage, trace, ...opts });

    let llmStream = createLLMStream(messagesWithSystem);

    // segment を送る唯一の経路
    // 読める文字が無い文（「……！」など）は単独で合成しない。Cartesia は30秒黙って500を返し、再試行込みで約90秒止まる
    // （2026-10-31再現。「……！どうされましたか。」のように後ろに文があれば通る）。次の文の頭に付けて送り、返答の最後なら捨てる
    let unspokenCarry = "";
    async function emitSegment(text, { final=false } = {}) {
      const t = (unspokenCarry + String(text ?? "").trim()).replace(/(?<=[\u3000-\u9fff])\s+(?=[\u3000-\u9fff])/g, "");
      unspokenCarry = "";
      if (!t) return;
      if (!/[\p{L}\p{N}]/u.test(t)) {
        if (!final) unspokenCarry = t;
        return;
      }
      const h = sha1(t);
      if (h === lastSegHash) return;     // 同一文は再送しない
      lastSegHash = h;
      segSeq += 1;

      // 画面用の確定テキスト
      send(res, "segment", { id: segSeq, text: t, final });

      // ---- TTS 開始マーク（最初のチャンクのみ）
      if (DEBUG_TIME && !firstTtsMarked) {
        send(res, "mark", { k: "tts_first_byte", t: Date.now() });
        firstTtsMarked = true;
      }

      // ログ用（1文ごと）: text_at=LLMから文が揃った時刻、tts_ms=合成にかかった時間、sent_at=音声を書き終えた時刻。
      // 時刻はリクエスト開始からのms
      const seg = { id: segSeq, chars: t.length, text_at: trace.elapsed(), vendor: cfg.ttsVendor, attempts: 0 };
      const ttsStart = Date.now();

      // 音声チャンク（textは載せない）
      // 主プロバイダーで合成。429/5xx は短く再試行し、だめならこの返答の残りはずんだもんで続ける
      async function synthesizePrimary(t) {
        seg.attempts++;
        let b64, fmt;
        if (cfg.ttsVendor === "openai") {
          b64 = await ttsToBase64OpenAI(t, voice, cfg.ttsModel);
          // PCMバイト数を概算（WAV base64からヘッダ44バイト分を除く）
          ttsPcmBytes += Math.round(b64.length * 3 / 4) - 44;
          fmt = "wav";
        } else if (cfg.ttsVendor === "google") {
          const g = resolveGoogleTtsFromBody(body);
          if (voice) g.voiceName = voice;
          const w = await ttsToBase64Google(t, g);
          b64 = w;
          fmt = "wav";
        } else if (cfg.ttsVendor === "gemini") {
          const g = resolveGeminiTtsFromBody(body, cfg);
          if (voice) g.voiceName = voice;
          const result = await ttsToBase64Gemini(t, g);
          b64 = result.b64;
          geminiTtsAudioTokens += result.audioTokens;
          fmt = "wav";
        } else if (cfg.ttsVendor === "elevenlabs") {
          const e = resolveElevenLabsTtsFromBody(body, cfg);
          if (voice) e.voiceId = voice;
          b64 = await ttsToBase64ElevenLabs(t, e);
          fmt = "wav";
        } else if (cfg.ttsVendor === "cartesia") {
          const c = resolveCartesiaTtsFromBody(body, cfg);
          if (voice && voice !== "default") c.voiceId = voice;
          b64 = await ttsToBase64Cartesia(t, c);
          fmt = "wav";
        } else if (cfg.ttsVendor === "fishaudio") {
          const f = resolveFishAudioTtsFromBody(body);
          if (voice) f.referenceId = voice;
          b64 = await ttsToBase64FishAudio(t, f);
          fmt = "mp3";
        } else if (cfg.ttsVendor === "sakura") {
          const modelName = voice === "default" ? "zundamon" : voice;
          b64 = await ttsToBase64Sakura(t, { model: modelName });
          fmt = "wav";
        } else if (cfg.ttsVendor === "zakicorp") {
          const speaker = voice === "default" ? "vivian" : voice;
          b64 = await ttsToBase64ZakiCorp(t, { speaker });
          fmt = "wav";
        } else {
          throw new Error("Unknown ttsVendor");
        }
        return { b64, fmt };
      }
      const callPrimary = (t) => TTS_SLOW_EXEMPT.has(cfg.ttsVendor) ? synthesizePrimary(t) : withTtsDeadline(synthesizePrimary(t), ttsSlowMs(cfg.ttsVendor, t));
      const synthesizeFallback = async (t) => { seg.attempts++; return { b64: await ttsToBase64Sakura(t, { model: "zundamon" }), fmt: "wav" }; };
      try {
        let out;
        let usedFallback = false;
        if (ttsFallbackActive) {
          out = await synthesizeFallback(t);
          usedFallback = true;
        } else {
          try {
            out = await callPrimary(t);
          } catch (e) {
            let lastErr = e;
            trace.ext(cfg.ttsVendor, { status: ttsErrorStatus(e), ms: Date.now() - ttsStart, error: true, ...(e?.slow ? { slow: true } : {}) });
            if (cfg.ttsVendor !== "sakura" && isRetryableTtsError(e)) {
              for (const wait of TTS_RETRY_WAITS_MS) {
                await sleepMs(wait);
                try { out = await callPrimary(t); lastErr = null; break; }
                catch (e2) {
                  lastErr = e2;
                  trace.ext(cfg.ttsVendor, { status: ttsErrorStatus(e2), error: true, retry: true, ...(e2?.slow ? { slow: true } : {}) });
                  if (e2?.slow) break; // 遅いならこれ以上待たずに切り替える
                }
              }
            }
            if (lastErr) {
              if (cfg.ttsVendor === "sakura") throw lastErr;
              trace.error("tts_primary", lastErr); // この後ずんだもんへ切り替える
              ttsFallbackActive = true;
              usedFallback = true;
              // 切り替わった最初の文の頭に一言添える（音声だけ。画面のテキストは変えない）
              out = await synthesizeFallback(TTS_FALLBACK_NOTICE + t);
              ttsFallbackChars += TTS_FALLBACK_NOTICE.length;
            }
          }
        }
        seg.tts_ms = Date.now() - ttsStart;
        seg.bytes = Math.round(out.b64.length * 3 / 4);
        if (usedFallback) { seg.fallback = "sakura"; ttsFallbackChars += t.length; } else ttsInputChars += t.length;
        send(res, "tts", { id: segSeq, format: out.fmt, b64: out.b64, ...(usedFallback ? { fallback: "sakura" } : {}) });
        seg.sent_at = trace.elapsed();
      } catch (e) {
        seg.error = ttsErrorStatus(e) ?? e?.name ?? "error";
        trace.error("tts", e);
        send(res, "error", { message: `TTS failed: ${e?.message || e}` });
      }
      trace.segment(seg);
    }

    // ---- LLM ストリーム処理（共通インターフェース）----
    try {
      // テキストを文に区切って送る。ツール呼び出しが来たらそれを返して止まる（来なければ null）。
      // afterSearch: 検索結果を渡した後の要求。頭の「調べてみるね」系の1文は捨てる（指示しても言うことがある。ロードマップ30）
      // dropPreface: 頭の「調べてみるね」系の1文を捨てるだけ（検索のやり直しの要求。もう言ってあるので）
      let spokeAfterSearch = false;
      async function pumpLLM(stream, label, { afterSearch = false, dropPreface = afterSearch } = {}) {
        let first = true;
        const emit = async (segText, opts) => {
          if (dropPreface && first && isSearchPreface(segText)) { first = false; trace.set({ preface_dropped: true }); return; }
          if (afterSearch) spokeAfterSearch = true;
          first = false;
          textAll += segText;
          await emitSegment(segText, opts);
        };
        for await (const delta of stream) {
          if (delta.type === "toolCall") {
            const pre = buf.trim();
            buf = "";
            if (pre) await emit(pre);
            return delta;
          }
          trace.mark(`${label}_first_token`);
          buf += delta.text;
          if (DEBUG) send(res, "llm_token", { token: delta.text });
          let match;
          while ((match = buf.match(/^(.*?[。！？!?])\s*/s))) {
            const segText = match[1].trim();
            buf = buf.slice(match[0].length);
            if (segText) await emit(segText);
          }
          if (buf.trim().length >= SEG_MAX_CHARS) {
            const segText = buf.trim();
            buf = "";
            await emit(segText);
          }
        }
        const tail = buf.trim();
        buf = "";
        if (tail) await emit(tail, { final: true });
        return null;
      }

      trace.mark("llm_start");
      let call = await pumpLLM(llmStream, "llm");
      // 「探してみるね。待っててね。」と言っただけで検索を呼ばずに終わったら、検索を必ず呼ばせてもう1回だけ頼む
      // （一言を添える指示があると起きる。11/10 に ESP32 で「探してみるね」で止まった。ロードマップ30）。
      // 言った一言は会話に足さない（足すと assistant が2つ続き、検索後の返答がまた前置きから始めやすい）
      if (!call && toolsDef && isSearchPromiseOnly(textAll)) {
        trace.set({ search_forced: true });
        trace.mark("llm_force_start");
        call = await pumpLLM(createLLMStream(messagesWithSystem, { toolChoice: "required" }), "llm_force", { dropPreface: true });
      }
      if (call) {
        trace.mark("tool_call");
        trace.set({ tool: call.name }); // 検索語は発話から作られるので書かない
        send(res, "tool_call", { name: call.name, args: call.args });

        let toolResult;
        if (call.name === "web_search") {
          const { query, say } = searchCallArgs(call.args);
          // 検索の間の一言（ツールの say）を鳴らしながら検索する。文章でもう何か言っていれば重ねない
          let saying = null;
          if (say && !textAll.trim()) {
            trace.set({ search_say: true });
            textAll += say;
            saying = emitSegment(say);
          }
          try {
            if (!query) throw new Error("web_search: no query in tool args");
            toolResult = await searchWeb(query, 3, trace);
            toolCalls.web_search = (toolCalls.web_search ?? 0) + 1;
          } catch (e) {
            trace.error("web_search", e);
            toolResult = [{ title: "検索エラー", snippet: "検索に失敗しました", url: "" }];
          }
          // 一言の音声を書き終えてから次の文へ（音声の書き込みは1本ずつ）
          if (saying) await saying;
        } else {
          toolResult = { error: `Unknown tool: ${call.name}` };
        }

        messagesWithSystem.push(...toolRoundMessages(call, { results: toolResult, instruction: TOOL_RESULT_INSTRUCTION }));
        // 2回目は検索結果で答えさせる（ツールは渡すが呼ばせない）
        trace.mark("llm2_start");
        const nested = await pumpLLM(createLLMStream(messagesWithSystem, { toolChoice: "none" }), "llm2", { afterSearch: true });
        if (nested) {
          // それでも Gemini 3系は再検索を求めることがある（10/30・11/09 に「調べるね」で終わった原因）。
          // まだ何も答えていなければ、検索結果を普通の文章に直してツール無しでもう1回だけ要求する
          trace.set({ nested_tool: nested.name });
          if (!spokeAfterSearch) {
            trace.mark("llm3_start");
            await pumpLLM(createLLMStream(inlineLastToolRound(messagesWithSystem), { tools: null }), "llm3", { afterSearch: true });
          }
        }
      }
      trace.mark("llm_done");
      send(res, "done", {});
      trace.mark("done_sent");

      // ---- 原価の計算 + usage + 会話ログ + 台帳（backend/shared/turn-record.mjs。ESP32 用の本文と同じ）----
      // 本文が空でも有料の検索を呼んでいれば記録する（ロードマップ30。以前は空だと検索代が記録から漏れた）
      if (sessionId !== "unknown" && (textAll.trim() || Object.keys(toolCalls).length > 0)) {
        await recordTurn({
          source: "app", ownerId, deviceId, sessionId, characterId, voice, text: textAll, chatLog,
          sttProvider: null, durationMs: Date.now() - requestAt,
          llm: { provider: llmProvider, model: llmModelId, tokensIn: llmUsage.in, tokensOut: llmUsage.out },
          tts: { vendor: cfg.ttsVendor, model: cfg.ttsModel, chars: ttsInputChars, fallbackChars: ttsFallbackChars, pcmBytes: ttsPcmBytes, audioTokens: geminiTtsAudioTokens },
          userMsgChars: lastUserMsg?.content?.length ?? 0, toolCalls,
        });
        trace.mark("usage_saved");
      }
    } catch (err) {
      trace.error("handler", err);
      const msg = (err && err.message) ? err.message : String(err);
      send(res, "error", { message: msg });
    } finally {
      res.end();
      trace.finish({
        segments_count: segSeq, reply_chars: textAll.trim().length,
        llm_tokens_in: llmUsage.in, llm_tokens_out: llmUsage.out,
        tts_chars: ttsInputChars, tts_fallback_chars: ttsFallbackChars || undefined,
        tool_calls: Object.keys(toolCalls).length > 0 ? toolCalls : undefined,
      });
    }
  });
