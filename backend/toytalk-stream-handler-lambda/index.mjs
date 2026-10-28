  // Node.js 18+ / ESM（index.mjs）
  // Handler: index.handler
  // Env: OPENAI_API_KEY, GOOGLE_API_KEY, ELEVENLABS_API_KEY, FISHAUDIO_API_KEY, ZAKICORP_API_KEY, ZAKICORP_TTS_URL,
  //      CARTESIA_API_KEY, CARTESIA_DEFAULT_VOICE_ID (任意: CARTESIA_LANGUAGE 既定 "ja")
  import OpenAI from "openai";
  import { createHash } from "node:crypto";
  import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
  import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
  import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
  import { ensureSecrets, secret } from "../shared/secrets.mjs";
  import { tableName } from "../shared/tables.mjs";
  import { chatStream, toolRoundMessages, searchWeb, WEB_SEARCH_TOOL, PAID_TOOLS, TOOL_RESULT_INSTRUCTION } from "../shared/llm.mjs";
  import { startTrace, describeClient, errorStatus } from "../shared/trace.mjs";

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
  const CHARACTERS_TABLE    = tableName("characters");
  const VOICES_TABLE        = tableName("voices");
  const CHAT_LOGS_TABLE     = tableName("chat-logs");
  const LLMS_TABLE          = tableName("llms");
  const USAGE_TABLE         = tableName("usage");
  const UNIT_PRICES_TABLE   = tableName("api-unit-prices");
  const EXCHANGE_RATES_TABLE = tableName("exchange-rates");

  async function saveLog(item) {
    try {
      await ddb.send(new PutCommand({ TableName: CHAT_LOGS_TABLE, Item: item }));
    } catch (e) {
      console.error("[saveLog] error:", e);
    }
  }

  // ---- 単価・マージン・為替レートのキャッシュ ----
  let cachedPrices = null;   // { "openai#llm": {...}, "openai#tts": {...}, ... }
  let cachedMargin = null;   // number
  let cachedRates = {};      // { "2026-04#JPY": 150, ... }
  let cacheLoadedAt = 0;
  const CACHE_TTL_MS = 3600_000; // 1時間

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
        if (pk === "service#margin") {
          cachedMargin = Number(item.margin) || 1.5;
        } else {
          prices[pk] = item;
        }
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
      const result = await ddb.send(new GetCommand({
        TableName: EXCHANGE_RATES_TABLE,
        Key: { month, currency },
      }));
      const rate = Number(result.Item?.rate) || 150;
      cachedRates[cacheKey] = rate;
      return rate;
    } catch (e) {
      console.error("[ExchangeRate] error:", e);
      return 150;
    }
  }

  function calcCostJpy({ providerApiType, model, tokensIn, tokensOut, characters, utf8Bytes, mora, pcmBytes, userMessageChars, requests, usdJpyRate }) {
    // モデル別の行（例 anthropic#llm#claude-haiku-5-5）があればそれ、無ければプロバイダー行（anthropic#llm）
    const price = (model && cachedPrices?.[`${providerApiType}#${model}`]) || cachedPrices?.[providerApiType];
    if (!price) {
      // 単価行が無いと記録されない。月次の運用Lambdaがこのログを拾って知らせる
      console.warn(`[Pricing] missing price for ${providerApiType}`);
      return null;
    }
    const margin = cachedMargin || 1.5;

    // Sakura: 円建て直接
    if (price.currency === "JPY") {
      const inputCost = (mora ?? 0) * Number(price.unit_price_input);
      return { costJpy: inputCost * margin, costUsd: null, usdJpyRate: null, unitPriceUsd: null, margin };
    }

    const inputUnit = price.input_unit_type;
    const outputUnit = price.output_unit_type;
    let costUsd = 0;

    if (inputUnit === "tokens") {
      costUsd += (tokensIn ?? 0) * Number(price.unit_price_input);
      if (outputUnit === "tokens") {
        costUsd += (tokensOut ?? 0) * Number(price.unit_price_output);
      } else if (outputUnit === "audio_tokens") {
        costUsd += (tokensOut ?? 0) * Number(price.unit_price_output);
      }
    } else if (inputUnit === "characters") {
      costUsd += (characters ?? 0) * Number(price.unit_price_input);
      if (outputUnit === "audio_tokens" && pcmBytes) {
        // OpenAI TTS: PCMバイト数から音声秒数→音声トークン数を概算
        const durationSec = pcmBytes / (24000 * 2);
        const audioTokens = Math.round((durationSec / 60) * 800);
        costUsd += audioTokens * Number(price.unit_price_output);
      }
    } else if (inputUnit === "utf8_bytes") {
      costUsd += (utf8Bytes ?? 0) * Number(price.unit_price_input);
    } else if (inputUnit === "audio_tokens") {
      // STT: 確定文の文字数から概算
      const chars = userMessageChars ?? 0;
      const textTokens = Math.round(chars * 0.3);
      const speechSec = chars / 6;
      const audioTokens = Math.round(speechSec * (30000 / 3600));
      costUsd += audioTokens * Number(price.unit_price_input);
      costUsd += textTokens * Number(price.unit_price_output);
    } else if (inputUnit === "requests") {
      // Web検索(Brave)など回数課金
      costUsd += (requests ?? 0) * Number(price.unit_price_input);
    }

    const costJpy = costUsd * usdJpyRate * margin;
    return { costJpy, costUsd, usdJpyRate, unitPriceUsd: Number(price.unit_price_input), margin };
  }

  async function addUsage({ ownerId, deviceId, date, apiType, provider, model, costJpy, costUsd, tokensIn, tokensOut, ttsCharacters, sttCharacters, requestCount, usdJpyRate, unitPriceUsd, margin }) {
    if (!costJpy || costJpy <= 0) return;
    const sk = `${date}#${deviceId}#${apiType}`;
    try {
      const addParts = ["cost_jpy :cost", "requests :one"];
      const vals = { ":cost": costJpy, ":one": requestCount ?? 1, ":p": provider, ":m": model, ":r": usdJpyRate ?? 0, ":u": unitPriceUsd ?? 0, ":mg": margin };
      if (costUsd)       { addParts.push("cost_usd :usd");         vals[":usd"]  = costUsd; }  // マージン前のUSD実費（請求額との突き合わせ用）
      if (tokensIn)      { addParts.push("tokens_in :tin");       vals[":tin"]  = tokensIn; }
      if (tokensOut)     { addParts.push("tokens_out :tout");     vals[":tout"] = tokensOut; }
      if (ttsCharacters) { addParts.push("tts_characters :ttsc"); vals[":ttsc"] = ttsCharacters; }
      if (sttCharacters) { addParts.push("stt_characters :sttc"); vals[":sttc"] = sttCharacters; }

      await ddb.send(new UpdateCommand({
        TableName: USAGE_TABLE,
        Key: { owner_id: ownerId, "date#device_id#api_type": sk },
        UpdateExpression: `ADD ${addParts.join(", ")} SET provider = :p, model = :m, usd_jpy_rate = :r, unit_price_usd = :u, margin = :mg`,
        ExpressionAttributeValues: vals,
      }));
    } catch (e) {
      console.error("[addUsage] error:", e);
    }
  }

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

  // ---- LLMデフォルト（llm_id未設定時のフォールバック）----
  // toytalker-llms の is_default エントリを使う（コンテナ生存中はキャッシュ）。
  // テーブルから取れないときだけ下の定数に落ちる
  const LLM_DEFAULT_PROVIDER = "google";
  const LLM_DEFAULT_MODEL    = "gemini-2.5-flash";
  let defaultLlmPromise = null;
  function loadDefaultLlm() {
    if (!defaultLlmPromise) {
      defaultLlmPromise = (async () => {
        try {
          const res = await ddb.send(new ScanCommand({ TableName: LLMS_TABLE }));
          const item = (res.Items ?? []).find((i) => i.is_default);
          if (item) return { provider: item.provider, modelId: item.model_id };
        } catch (e) {
          console.error("[DynamoDB] loadDefaultLlm error:", e);
        }
        return { provider: LLM_DEFAULT_PROVIDER, modelId: LLM_DEFAULT_MODEL };
      })();
    }
    return defaultLlmPromise;
  }



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
  // 一度切り替えたらその返答の残りはずんだもんのまま。仕様: docs/tts-fallback-and-notifications.md
  const TTS_RETRY_WAITS_MS = [300, 600];
  const TTS_FALLBACK_NOTICE = "いまはこんでいるから、べつのこえでおはなしするね。";
  const ttsErrorStatus = errorStatus;
  function isRetryableTtsError(e) {
    const s = ttsErrorStatus(e);
    return s === 429 || s === 408 || (s !== null && s >= 500);
  }
  const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const ownerId    = typeof body.owner_id   === "string" ? body.owner_id   : "user_123";
    const deviceId   = typeof body.device_id  === "string" ? body.device_id  : "app";
    const userTimestamp = new Date(requestAt).toISOString();
    const backchannelFired = !!body.backchannel_fired;
    const characterId = typeof body.character_id === "string" ? body.character_id : null;
    trace.set({
      source: "app", session_id: sessionId, device_id: deviceId, owner_id: ownerId, character_id: characterId,
      backchannel_fired: backchannelFired, history_messages: messages.length,
      user_chars: messages[messages.length - 1]?.content?.length ?? 0,
      ...describeClient(event, body),
    });

    // 単価キャッシュ・デフォルトLLMを先にロード（await不要、バックグラウンドで）
    loadPricingCache();
    loadDefaultLlm();

    if (characterId) {
      const charConfig = await resolveCharacterFromDynamo(characterId);
      if (charConfig) {
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
    if (lastUserMsg?.role === "user" && sessionId !== "unknown") {
      saveLog({
        "owner_id#device_id":   `owner_id#${ownerId}#device_id#${deviceId}`,
        "session_id#timestamp": `session_id#${sessionId}#timestamp#${userTimestamp}`,
        owner_id: ownerId, device_id: deviceId, source: "app",
        role: "user", content: lastUserMsg.content,
        content_type: "text", timestamp: userTimestamp, session_id: sessionId,
      });
    }

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
    const toolHint = enableTools ? "\nウェブ検索ツールが使えます。最新情報や具体的な事実を調べたいときに使ってください。検索する前に、短い一言（例:「調べてみるね」「ちょっと待ってね」など、毎回違う表現）を添えてから検索してください。" : "";
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
    async function emitSegment(text, { final=false } = {}) {
      const t = String(text ?? "").trim().replace(/(?<=[\u3000-\u9fff])\s+(?=[\u3000-\u9fff])/g, "");
      if (!t) return;
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
      const synthesizeFallback = async (t) => { seg.attempts++; return { b64: await ttsToBase64Sakura(t, { model: "zundamon" }), fmt: "wav" }; };
      try {
        let out;
        let usedFallback = false;
        if (ttsFallbackActive) {
          out = await synthesizeFallback(t);
          usedFallback = true;
        } else {
          try {
            out = await synthesizePrimary(t);
          } catch (e) {
            let lastErr = e;
            trace.ext(cfg.ttsVendor, { status: ttsErrorStatus(e), ms: Date.now() - ttsStart, error: true });
            if (cfg.ttsVendor !== "sakura" && isRetryableTtsError(e)) {
              for (const wait of TTS_RETRY_WAITS_MS) {
                await sleepMs(wait);
                try { out = await synthesizePrimary(t); lastErr = null; break; }
                catch (e2) { lastErr = e2; trace.ext(cfg.ttsVendor, { status: ttsErrorStatus(e2), error: true, retry: true }); }
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
      // ---- LLM ストリーム処理（tool callループ対応）----
      let toolCallDetected = false;
      trace.mark("llm_start");
      for await (const delta of llmStream) {
        if (delta.type === "toolCall") {
          toolCallDetected = true;
          trace.mark("tool_call");
          trace.set({ tool: delta.name }); // 検索語は発話から作られるので書かない
          // tool call前のつなぎテキストをflush
          const preBuf = buf.trim();
          if (preBuf) {
            buf = "";
            await emitSegment(preBuf);
          }
          send(res, "tool_call", { name: delta.name, args: delta.args });

          let toolResult;
          if (delta.name === "web_search") {
            try {
              toolResult = await searchWeb(delta.args.query, 3, trace);
              toolCalls.web_search = (toolCalls.web_search ?? 0) + 1;
            } catch (e) {
              trace.error("web_search", e);
              toolResult = [{ title: "検索エラー", snippet: "検索に失敗しました", url: "" }];
            }
          } else {
            toolResult = { error: `Unknown tool: ${delta.name}` };
          }

          messagesWithSystem.push(...toolRoundMessages(delta, { results: toolResult, instruction: TOOL_RESULT_INSTRUCTION }));
          // 2回目は検索結果で答えさせる（Gemini 3系は再検索を要求しがちで、無視すると本文が空になる）
          llmStream = createLLMStream(messagesWithSystem, { toolChoice: "none" });
          trace.mark("llm2_start");

          for await (const delta2 of llmStream) {
            if (delta2.type === "toolCall") {
              trace.set({ nested_tool_ignored: delta2.name });
              break;
            }
            trace.mark("llm2_first_token");
            textAll += delta2.text;
            buf     += delta2.text;
            if (DEBUG) send(res, "llm_token", { token: delta2.text });
            let match;
            while ((match = buf.match(/^(.*?[。！？!?])\s*/s))) {
              const segText = match[1].trim();
              buf = buf.slice(match[0].length);
              if (segText) await emitSegment(segText);
            }
            if (buf.trim().length >= SEG_MAX_CHARS) {
              const segText = buf.trim();
              buf = "";
              await emitSegment(segText);
            }
          }
          break;
        }
        trace.mark("llm_first_token");
        textAll += delta.text;
        buf     += delta.text;
        if (DEBUG) send(res, "llm_token", { token: delta.text });
        let match;
        while ((match = buf.match(/^(.*?[。！？!?])\s*/s))) {
          const segText = match[1].trim();
          buf = buf.slice(match[0].length);
          if (segText) await emitSegment(segText);
        }
        if (buf.trim().length >= SEG_MAX_CHARS) {
          const segText = buf.trim();
          buf = "";
          await emitSegment(segText);
        }
      }
      trace.mark("llm_done");
      // 残り
      const tail = buf.trim();
      if (tail.length > 0) {
        buf = "";
        await emitSegment(tail, { final: true });
      }
      send(res, "done", {});
      trace.mark("done_sent");

      // ---- コスト計算 + usage書き込み + ログ保存 ----
      if (sessionId !== "unknown" && textAll.trim()) {
        const assistantTimestamp = new Date().toISOString();

        await loadPricingCache();
        const date = assistantTimestamp.slice(0, 10);
        const month = assistantTimestamp.slice(0, 7);
        const usdJpyRate = await getExchangeRate(month);

        // LLM
        const llmPriceKey = `${llmProvider}#llm`;
        const llmCost = calcCostJpy({ providerApiType: llmPriceKey, model: llmModelId, tokensIn: llmUsage.in, tokensOut: llmUsage.out, usdJpyRate });
        if (llmCost) {
          await addUsage({ ownerId, deviceId, date, apiType: "llm", provider: llmProvider, model: llmModelId, costJpy: llmCost.costJpy, costUsd: llmCost.costUsd, tokensIn: llmUsage.in, tokensOut: llmUsage.out, usdJpyRate: llmCost.usdJpyRate, unitPriceUsd: llmCost.unitPriceUsd, margin: llmCost.margin });
        }

        // TTS
        const ttsPriceKey = `${cfg.ttsVendor}#tts`;
        let ttsCostResult;
        if (cfg.ttsVendor === "gemini") {
          ttsCostResult = calcCostJpy({ providerApiType: ttsPriceKey, tokensIn: ttsInputChars, tokensOut: geminiTtsAudioTokens, usdJpyRate });
        } else if (cfg.ttsVendor === "openai") {
          ttsCostResult = calcCostJpy({ providerApiType: ttsPriceKey, characters: ttsInputChars, pcmBytes: ttsPcmBytes, usdJpyRate });
        } else if (cfg.ttsVendor === "fishaudio") {
          const utf8Bytes = Buffer.byteLength(textAll.trim(), "utf8");
          ttsCostResult = calcCostJpy({ providerApiType: ttsPriceKey, utf8Bytes, usdJpyRate });
        } else if (cfg.ttsVendor === "sakura") {
          const mora = ttsInputChars;
          ttsCostResult = calcCostJpy({ providerApiType: ttsPriceKey, mora, usdJpyRate });
        } else {
          ttsCostResult = calcCostJpy({ providerApiType: ttsPriceKey, characters: ttsInputChars, usdJpyRate });
        }
        if (ttsCostResult) {
          await addUsage({ ownerId, deviceId, date, apiType: "tts", provider: cfg.ttsVendor, model: cfg.ttsModel, costJpy: ttsCostResult.costJpy, costUsd: ttsCostResult.costUsd, ttsCharacters: ttsInputChars, usdJpyRate: ttsCostResult.usdJpyRate, unitPriceUsd: ttsCostResult.unitPriceUsd, margin: ttsCostResult.margin });
        }

        // フォールバック（ずんだもん）で生成した分は Sakura として別行で記録
        let fallbackCostResult = null;
        if (ttsFallbackChars > 0) {
          fallbackCostResult = calcCostJpy({ providerApiType: "sakura#tts", mora: ttsFallbackChars, usdJpyRate });
          if (fallbackCostResult) {
            await addUsage({ ownerId, deviceId, date, apiType: "tts", provider: "sakura", model: "zundamon", costJpy: fallbackCostResult.costJpy, costUsd: fallbackCostResult.costUsd, ttsCharacters: ttsFallbackChars, usdJpyRate: fallbackCostResult.usdJpyRate, unitPriceUsd: fallbackCostResult.unitPriceUsd, margin: fallbackCostResult.margin });
          }
        }

        // STT (確定文の文字数から概算)
        const userMsgChars = lastUserMsg?.content?.length ?? 0;
        let sttCost = null;
        if (userMsgChars > 0) {
          sttCost = calcCostJpy({ providerApiType: "soniox#stt", userMessageChars: userMsgChars, usdJpyRate });
          if (sttCost) {
            await addUsage({ ownerId, deviceId, date, apiType: "stt", provider: "soniox", model: "soniox", costJpy: sttCost.costJpy, costUsd: sttCost.costUsd, sttCharacters: userMsgChars, usdJpyRate: sttCost.usdJpyRate, unitPriceUsd: sttCost.unitPriceUsd, margin: sttCost.margin });
          }
        }

        // ツール（外部の有料APIを呼ぶものだけ回数課金で記録。無料ツールはLLMトークンに含まれる）
        const toolUsage = [];
        let toolCostTotal = 0;
        for (const [toolName, count] of Object.entries(toolCalls)) {
          const paid = PAID_TOOLS[toolName];
          if (!paid || count <= 0) continue;
          const c = calcCostJpy({ providerApiType: `${paid.provider}#tool`, requests: count, usdJpyRate });
          if (!c) continue;
          await addUsage({ ownerId, deviceId, date, apiType: "tool", provider: paid.provider, model: paid.model, costJpy: c.costJpy, costUsd: c.costUsd, requestCount: count, usdJpyRate: c.usdJpyRate, unitPriceUsd: c.unitPriceUsd, margin: c.margin });
          toolUsage.push({ tool: toolName, provider: paid.provider, requests: count, cost: c.costJpy });
          toolCostTotal += c.costJpy;
        }

        // ログ保存（計算済みコスト付き）
        await saveLog({
          "owner_id#device_id":   `owner_id#${ownerId}#device_id#${deviceId}`,
          "session_id#timestamp": `session_id#${sessionId}#timestamp#${assistantTimestamp}`,
          owner_id: ownerId, device_id: deviceId, source: "app",
          role: "assistant", content: textAll.trim(),
          content_type: "text", timestamp: assistantTimestamp, session_id: sessionId,
          llm_provider: llmProvider, llm_model: llmModelId,
          llm_tokens_in: llmUsage.in, llm_tokens_out: llmUsage.out,
          tts_provider: cfg.ttsVendor, tts_input_units: ttsInputChars, tts_input_unit_type: "characters",
          stt_provider: null, stt_input_units: null, stt_input_unit_type: null,
          tool_usage: toolUsage,
          duration_ms: Date.now() - requestAt,
          character_id: characterId ?? "default",
          voice_id: voice,
          cost_stt: sttCost?.costJpy ?? 0,
          cost_llm: llmCost?.costJpy ?? 0,
          tts_fallback: ttsFallbackChars > 0 ? { from: cfg.ttsVendor, to: "sakura", chars: ttsFallbackChars } : null,
          cost_tts: (ttsCostResult?.costJpy ?? 0) + (fallbackCostResult?.costJpy ?? 0),
          cost_tool: toolCostTotal,
          cost_total: (sttCost?.costJpy ?? 0) + (llmCost?.costJpy ?? 0) + (ttsCostResult?.costJpy ?? 0) + (fallbackCostResult?.costJpy ?? 0) + toolCostTotal,
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
