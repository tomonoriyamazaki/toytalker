  // Node.js 18+ / ESM（index.mjs）
  // Handler: index.handler
  // Env: OPENAI_API_KEY, GOOGLE_API_KEY, ELEVENLABS_API_KEY, FISHAUDIO_API_KEY, SAKURA_API_KEY, ZAKICORP_API_KEY, ZAKICORP_TTS_URL,
  //      CARTESIA_API_KEY, CARTESIA_DEFAULT_VOICE_ID (任意: CARTESIA_LANGUAGE 既定 "ja")
  import OpenAI from "openai";
  import { createHash } from "node:crypto";
  import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
  import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
  import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";
  import { Agent, setGlobalDispatcher } from "undici";
  import { ensureSecrets, secret } from "../shared/secrets.mjs";
  import { tableName } from "../shared/tables.mjs";
  import { chatStream, toolRoundMessages, searchWeb, WEB_SEARCH_TOOL, PAID_TOOLS, TOOL_RESULT_INSTRUCTION } from "../shared/llm.mjs";
  import { startTrace, describeClient, errorStatus } from "../shared/trace.mjs";
import { deviceGate } from "../shared/auth.mjs";

  // ---- fetchのkeep-alive延長（デフォルト4秒→60秒） ----
  // 会話の間が数秒空くとLLM/TTSへのTLS接続が閉じられ、次のターンで
  // SSLハンドシェイクからやり直しになり体感ラグが出る。60秒に延長して回避
  try {
    setGlobalDispatcher(new Agent({ keepAliveTimeout: 60_000, keepAliveMaxTimeout: 600_000 }));
  } catch (e) {
    console.log("[KeepAlive] setGlobalDispatcher failed:", e?.message);
  }

  // ---- 外部APIへの接続を事前確立（deep warmup） ----
  // TLSハンドシェイク済みのkeep-alive接続をプールに作っておく。
  // 401等が返っても接続自体はプールに残るのでOK
  const PREWARM_ORIGINS = ["https://api.openai.com", "https://api.ai.sakura.ad.jp"];
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
  const DEVICES_TABLE    = tableName("devices");
  const VOICES_TABLE     = tableName("voices");
  const CHARACTERS_TABLE = tableName("characters");
  const CHAT_LOGS_TABLE  = tableName("chat-logs");
  const LLMS_TABLE       = tableName("llms");
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
  let cachedPrices = null;
  let cachedMargin = null;
  let cachedRates = {};
  let cacheLoadedAt = 0;
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
    if (price.currency === "JPY") {
      const inputCost = (mora ?? 0) * Number(price.unit_price_input);
      return { costJpy: inputCost * margin, costUsd: null, usdJpyRate: null, unitPriceUsd: null, margin };
    }
    const inputUnit = price.input_unit_type;
    const outputUnit = price.output_unit_type;
    let costUsd = 0;
    if (inputUnit === "tokens") {
      costUsd += (tokensIn ?? 0) * Number(price.unit_price_input);
      if (outputUnit === "tokens" || outputUnit === "audio_tokens") {
        costUsd += (tokensOut ?? 0) * Number(price.unit_price_output);
      }
    } else if (inputUnit === "characters") {
      costUsd += (characters ?? 0) * Number(price.unit_price_input);
      if (outputUnit === "audio_tokens" && pcmBytes) {
        const durationSec = pcmBytes / (24000 * 2);
        const audioTokens = Math.round((durationSec / 60) * 800);
        costUsd += audioTokens * Number(price.unit_price_output);
      }
    } else if (inputUnit === "utf8_bytes") {
      costUsd += (utf8Bytes ?? 0) * Number(price.unit_price_input);
    } else if (inputUnit === "audio_tokens") {
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
  const TTS_FORMAT     = "pcm";
  const VOICE_DEFAULT  = "alloy";
  const DEBUG          = false;
  const DEBUG_TIME     = process.env.DEBUG_TIME === "true";

  // Binary protocol helpers
  // Send JSON metadata (type=0x01)
  const sendMeta = (res, ev, data) => {
    const json = JSON.stringify({ event: ev, ...data });
    const buf = Buffer.from(json, "utf8");
    const header = Buffer.alloc(5);
    header.writeUInt8(0x01, 0);           // type: metadata
    header.writeUInt32LE(buf.length, 1);  // length
    res.write(header);
    res.write(buf);
  };

  // Send binary PCM data (type=0x02)
  const sendPCM = (res, pcmBuffer) => {
    const header = Buffer.alloc(5);
    header.writeUInt8(0x02, 0);              // type: PCM audio
    header.writeUInt32LE(pcmBuffer.length, 1); // length
    res.write(header);
    res.write(pcmBuffer);
  };

  // TTS音声の先頭/末尾の無音をトリミング（24kHz/16bit/mono前提）
  // TTSは末尾に数百msの無音を含むことが多く、これを削ると
  // 「喋り終わり→録音再開」の体感切替がその分速くなる（先頭側は応答体感の改善）
  const trimSilence = (pcm, { threshold = 512, padMs = 80, sampleRate = 24000 } = {}) => {
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
  };

  const sha1  = (s)=>createHash("sha1").update(s).digest("hex");

  // ---- TTS設定（プロバイダーごと）----
  const TTS_DEFAULT = "OpenAI";
  const TTS_TABLE = {
    OpenAI:     { ttsVendor: "openai",     ttsModel: "gpt-4o-mini-tts-2025-03-20" },
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

// OpenAI TTS → Buffer (raw PCM)
async function ttsBufferOpenAI(text, voice, ttsModel) {
  const tts = await getOpenAI().audio.speech.create({
    model: ttsModel,
    input: text,
    voice,
    response_format: "pcm"
  });
  const buf = Buffer.from(await tts.arrayBuffer());

  // 先頭が MP3 だったらフォールバックで WAV 再取得
  if (buf[0] === 0xFF && (buf[1] === 0xF3 || buf[1] === 0xFB || buf[0] === 0x49)) {
    console.warn("[TTS] OpenAI returned non-PCM, retrying as WAV");
    const tts2 = await getOpenAI().audio.speech.create({
      model: ttsModel.replace("mini", "tts"),
      input: text,
      voice,
      format: "wav"
    });
    return Buffer.from(await tts2.arrayBuffer());
  }
  return buf;
}

  // Google Cloud Text-to-Speech (API Key) → Buffer (raw PCM)
  async function ttsBufferGoogle(
    text,
    {
      voiceName,
      speakingRate = 1.2,
      pitch = 3.0,
      sampleRateHertz = 24000,
      audioEncoding = "LINEAR16",
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
    // json.audioContent は LINEAR16 (base64) → 生のBufferに変換
    const pcmBuffer = Buffer.from(json.audioContent, "base64");

    // Google TTS特有の冒頭クリック音対策: フェードイン処理
    const fadeMs = 20;  // 20ミリ秒
    const fadeSamples = Math.floor(sampleRateHertz * fadeMs / 1000);
    for (let i = 0; i < fadeSamples && i * 2 < pcmBuffer.length; i++) {
      const fade = i / fadeSamples;  // 0→1
      const sample = pcmBuffer.readInt16LE(i * 2);
      pcmBuffer.writeInt16LE(Math.round(sample * fade), i * 2);
    }
    return pcmBuffer;
  }


  // Gemini Speech Generation → Buffer (raw PCM)（APIキーは GOOGLE_API_KEY を共用）
  async function ttsBufferGemini(text, { model = "gemini-2.5-flash-preview-tts", voiceName = "Kore" } = {}) {
    const key = secret("GOOGLE_API_KEY");
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

    // 24kHz/mono PCM16 base64 → 生のBufferに変換
    return Buffer.from(b64Pcm, "base64");
  }

  // ElevenLabs TTS → Buffer (raw PCM)
  async function ttsBufferElevenLabs(text, { model = "eleven_turbo_v2_5", voiceId = "hMK7c1GPJmptCzI4bQIu" } = {}) {
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

    // PCMバイナリデータを直接返す
    return Buffer.from(await resp.arrayBuffer());
  }

  // Cartesia TTS → Buffer (raw PCM 24kHz/16bit/mono)
  const CARTESIA_API_VERSION = "2026-08-14";
  async function ttsBufferCartesia(text, { model = "sonic-3.6", voiceId } = {}) {
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
        output_format: { container: "raw", encoding: "pcm_s16le", sample_rate: 24000 },
      }),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`Cartesia TTS failed: ${resp.status} ${errorText}`);
    }

    return Buffer.from(await resp.arrayBuffer());
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

  // FishAudio TTS → Buffer (raw PCM via MP3 decode is not feasible on Lambda;
  // FishAudio supports pcm output via format param)
  async function ttsBufferFishAudio(text, { referenceId = "hMK7c1GPJmptCzI4bQIu" } = {}) {
    const key = secret("FISHAUDIO_API_KEY");
    if (!key) throw new Error("FISHAUDIO_API_KEY is not set");
    const resp = await fetch("https://api.fish.audio/v1/tts", {
      method: "POST",
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ text, reference_id: referenceId, format: "pcm", sample_rate: 24000, latency: "normal" }),
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`FishAudio TTS failed: ${resp.status} ${errorText}`);
    }
    return Buffer.from(await resp.arrayBuffer());
  }

  // Sakura (VOICEVOX) TTS → Buffer (raw PCM)
  async function ttsBufferSakura(text, { model = "zundamon", style = "normal" } = {}) {
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
    // WAVヘッダ（44バイト）をスキップしてPCMデータを取得
    return wavBuffer.slice(44);
  }

  // ZakiCorp TTS (clone voice via local GPU) — streaming PCM to ESP32
  // 戻り値は { bytes, firstChunkMs }（最初の音声チャンクが届くまでの時間。ログの切り分け用）
  async function ttsStreamZakiCorp(text, { speaker = "vivian", language = "Japanese" } = {}, res, segSeq) {
    const t = Date.now();
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
    let totalBytes = 0;
    let firstChunkMs = null;
    for await (const raw of resp.body) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (firstChunkMs === null) {
        firstChunkMs = Date.now() - t;
        sendMeta(res, "tts_start", { id: segSeq, size: 0, streaming: true });
      }
      sendPCM(res, chunk);
      totalBytes += chunk.length;
    }
    return { bytes: totalBytes, firstChunkMs };
  }

  // DynamoDBからdevice_idに紐づくキャラクター＆ボイス設定を解決
  // 解決チェーン: device → character(voice_id + personality_prompt) → voice(provider + vendor_id)
  async function resolveCharacterFromDynamo(deviceId) {
    try {
      const deviceRes = await ddb.send(new GetCommand({
        TableName: DEVICES_TABLE,
        Key: { device_id: deviceId },
      }));
      const device = deviceRes.Item;
      if (!device) return { registered: false }; // 未登録機。本番では拒む（deviceGate）
      const partial = { registered: true, ownerId: device.owner_id ?? null, characterId: device.character_id ?? "default" };

      let voiceId = null;
      let personalityPrompt = null;
      let llmId = null;

      if (device.character_id) {
        const charRes = await ddb.send(new GetCommand({
          TableName: CHARACTERS_TABLE,
          Key: { character_id: device.character_id },
        }));
        if (charRes.Item) {
          voiceId = charRes.Item.voice_id ?? null;
          personalityPrompt = charRes.Item.personality_prompt || null;
          llmId = charRes.Item.llm_id ?? null;
        }
      }

      if (!voiceId) voiceId = device.voice_id ?? null;
      if (!voiceId) return partial; // 登録済みだがキャラクター未設定。body の値で続ける

      const voiceRes = await ddb.send(new GetCommand({
        TableName: VOICES_TABLE,
        Key: { voice_id: voiceId },
      }));
      if (!voiceRes.Item) return partial;

      // LLM設定を解決（llm_id未設定なら null のまま返し、handler側でデフォルトを充当）
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
        ...partial,
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
    res.setContentType("application/octet-stream");
    await ensureSecrets();

    const body    = event.body ? JSON.parse(event.body) : {};
    if (body.warmup) { res.end(); return; }  // EventBridgeウォームアップping（コールドスタート対策）
    // 切り分け用のログ。1リクエスト1行のJSONで、会話の文章は書かない（backend/shared/trace.mjs）
    const trace = startTrace("turn", { event, context, t0: requestAt });
    trace.mark("secrets");
    prewarmSpareInstance();  // 処理中に予備インスタンスを温める（同時2人目対策）
    prewarmConnections();    // LLM/TTS接続を先行確立（keep-alive切れ時の保険、非同期）
    loadDefaultLlm();        // デフォルトLLMを先読み（キャッシュ済みなら即時）
    const messages= body.messages ?? [{ role:"user", content:"自己紹介して" }];
    const deviceId = typeof body.device_id === "string" ? body.device_id : null;
    const backchannelFired = !!body.backchannel_fired;

    // ---- ログ用メタデータ ----
    const sessionId  = typeof body.session_id === "string" ? body.session_id : "unknown";
    let   ownerId    = typeof body.owner_id   === "string" ? body.owner_id   : deviceId ?? "unknown";
    const userTimestamp = new Date(requestAt).toISOString();
    trace.set({
      source: "esp", session_id: sessionId, device_id: deviceId, owner_id: ownerId,
      backchannel_fired: backchannelFired, history_messages: messages.length,
      user_chars: messages[messages.length - 1]?.content?.length ?? 0,
      ...describeClient(event, body),
    });

    function normalizeModelKey(k) {
      if (!k) return undefined;
      const s = String(k).toLowerCase();
      if (s.includes("openai"))      return "OpenAI";
      if (s.includes("google"))      return "Google";
      if (s.includes("gemini"))      return "Gemini";
      if (s.includes("elevenlabs"))  return "ElevenLabs";
      if (s.includes("cartesia"))    return "Cartesia";
      if (s.includes("fishaudio") || s.includes("fish")) return "FishAudio";
      if (s.includes("sakura"))    return "Sakura";
      if (s.includes("zakicorp") || s.includes("qwen")) return "ZakiCorp";
      return undefined;
    }

    // device_idがあればDynamoDBからキャラクター＆ボイス設定を取得、なければbodyの値を使う
    let ttsKey = normalizeModelKey(body.model) ?? TTS_DEFAULT;
    let voice    = body.voice ?? VOICE_DEFAULT;
    let personalityPrompt = null;
    let llmProvider = null;
    let llmModelId  = null;
    let characterId = "default";

    // 拒否応答（403）。ストリームを開く前に JSON 1つで返す。LLM も TTS も走らない
    const reject = (gate) => {
      trace.set({ status: gate.statusCode, reason: gate.error });
      trace.finish();
      const s = awslambda.HttpResponseStream.from(res, { statusCode: gate.statusCode, headers: { "Content-Type": "application/json" } });
      s.write(JSON.stringify({ error: gate.error }));
      s.end();
    };
    // ESP32 はログインしない。本番（AUTH_REQUIRED）では devices テーブルに登録済み（= アプリでログインして結び付けた）機器だけ通す（docs/auth.md）。
    // DynamoDB の失敗（null）は従来どおり body の値で続ける
    const charConfig = deviceId ? await resolveCharacterFromDynamo(deviceId) : { registered: false };
    if (charConfig?.registered === false) {
      const gate = deviceGate(null);
      if (gate) return reject(gate);
    }
    if (deviceId) {
      if (charConfig?.provider) {
        ttsKey = normalizeModelKey(charConfig.provider) ?? ttsKey;
        voice    = charConfig.vendorId ?? voice;
        personalityPrompt = charConfig.personalityPrompt;
        llmProvider = charConfig.llmProvider;
        llmModelId  = charConfig.llmModelId;
        characterId = charConfig.characterId ?? "default";
        if (charConfig.ownerId) ownerId = charConfig.ownerId;
        trace.set({ owner_id: ownerId, character_id: characterId, has_personality: !!personalityPrompt });
      } else {
        if (charConfig?.ownerId) { ownerId = charConfig.ownerId; trace.set({ owner_id: ownerId }); }
        trace.set({ device_registered: charConfig?.registered === true }); // 未登録か、キャラクター未設定。body の値で続ける
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

    sendMeta(res, "mark", { k: "model", v: ttsKey });
    sendMeta(res, "mark", { k: "llm_vendor", v: llmProvider });
    sendMeta(res, "mark", { k: "llm_model", v: llmModelId });
    sendMeta(res, "mark", { k: "tts_vendor", v: cfg.ttsVendor });

    // サーバ基準時刻（クライアントがREQ_TTFBやLLM/TTSとの相対を取れる）
    if (DEBUG_TIME) {
      sendMeta(res, "ping", { t: Date.now() });
    }

    // ---- ユーザーメッセージ保存 ----
    const lastUserMsg = messages[messages.length - 1];
    if (lastUserMsg?.role === "user" && sessionId !== "unknown") {
      saveLog({
        "owner_id#device_id":   `owner_id#${ownerId}#device_id#${deviceId}`,
        "session_id#timestamp": `session_id#${sessionId}#timestamp#${userTimestamp}`,
        owner_id: ownerId, device_id: deviceId, source: "esp",
        role: "user", content: lastUserMsg.content,
        content_type: "audio", timestamp: userTimestamp, session_id: sessionId,
      });
    }

    // ---- LLM 開始 ----
    if (DEBUG_TIME) {
      sendMeta(res, "mark", { k: "llm_start", t: Date.now() });
    }

    // システムプロンプトを追加（キャラクターの個性 + 共通指示）
    const now = new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit" });
    const backchannelHint = backchannelFired ? "\n【重要】相槌は別途再生済みです。冒頭の相槌・挨拶・オウム返しは不要です。本題から返答を始めてください。口調や温かさはいつも通りのままにしてください。" : "";
    // 検索後の「前置きなし」指示はシステムプロンプトに置かず、検索結果を返すメッセージ側（TOOL_RESULT_INSTRUCTION）に添える。
    // システムプロンプトに置くと通常ターンの口調まで素っ気なくなるため。
    // 検索ツールは3社共通（backend/shared/llm.mjs）。プロンプトの「検索できます」と実際のツール付与は必ず同じ条件にする
    const enableTools = !!secret("BRAVE_API_KEY");
    const toolHint = enableTools ? "\nウェブ検索ツールが使えます。最新情報や具体的な事実を調べたいときに使ってください。検索する前に、短い一言（例:「調べてみるね」「ちょっと待ってね」など、毎回違う表現）を添えてから検索してください。" : "";
    const basePrompt = `あなたは子供向けの友好的な音声アシスタントです。簡潔に答えて、自然に会話を続けてください。単語の間に半角スペースを入れないでください。現在の日時は${now}です。日時を聞かれたら年は省略して簡潔に答えてください。相手が話した言語で返答してください。${backchannelHint}${toolHint}`;
    const systemPrompt = {
      role: "system",
      content: personalityPrompt ? `${personalityPrompt}\n\n${basePrompt}` : basePrompt,
    };
    const messagesWithSystem = [systemPrompt, ...messages];

    // ---- ストリーム状態 ----
    let buf = "";
    let textAll = "";
    let segSeq = 0;
    let lastSegHash = "";
    let firstTtsMarked = false;
    let ttsChain = Promise.resolve();
    const llmUsage = { in: 0, out: 0 }; // LLMトークン数（検索ありのターンは2要求分の合計）
    let ttsInputChars = 0;
    const toolCalls = {};  // ツール名→成功回数。PAID_TOOLSに載っているものだけ課金対象
    let ttsFallbackActive = false;   // この返答でずんだもんへ切り替え済みか
    let ttsFallbackChars = 0;        // ずんだもんで生成した文字数（Sakura分として記録）

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

      // 画面用の確定テキスト（メタデータとして送信）
      sendMeta(res, "segment", { id: segSeq, text: t, final });

      // ---- TTS 開始マーク（最初のチャンクのみ）
      if (DEBUG_TIME && !firstTtsMarked) {
        sendMeta(res, "mark", { k: "tts_first_byte", t: Date.now() });
        firstTtsMarked = true;
      }

      // ログ用（1文ごと）: text_at=LLMから文が揃った時刻、tts_ms=合成にかかった時間、first_chunk_ms=最初の音声が届くまで
      // （ZakiCorpのストリーミングだけ。他は tts_ms と同じ）、sent_at=音声を書き終えた時刻。時刻はリクエスト開始からのms
      const seg = { id: segSeq, chars: t.length, text_at: trace.elapsed(), vendor: cfg.ttsVendor, attempts: 0 };
      const ttsStart = Date.now();

      // 音声チャンク（生PCMバイナリとして送信）
      // 主プロバイダーで合成。429/5xx は短く再試行し、だめならこの返答の残りはずんだもんで続ける
      async function synthesizePrimary(t) {
        seg.attempts++;
        let pcmBuffer;
        if (cfg.ttsVendor === "openai") {
          const voiceName = voice === "default" ? "nova" : voice;
          pcmBuffer = await ttsBufferOpenAI(t, voiceName, cfg.ttsModel);
        } else if (cfg.ttsVendor === "google") {
          const voiceName = voice === "default" ? "ja-JP-Neural2-C" : voice;  // 男性
          pcmBuffer = await ttsBufferGoogle(t, { voiceName });
        } else if (cfg.ttsVendor === "gemini") {
          const voiceName = voice === "default" ? "Kore" : voice;
          pcmBuffer = await ttsBufferGemini(t, { model: cfg.ttsModel, voiceName });
        } else if (cfg.ttsVendor === "elevenlabs") {
          const voiceId = voice === "default" ? "hMK7c1GPJmptCzI4bQIu" : voice;  // Sameno（子供向け）
          pcmBuffer = await ttsBufferElevenLabs(t, { model: cfg.ttsModel, voiceId });
        } else if (cfg.ttsVendor === "cartesia") {
          const voiceId = voice === "default" ? undefined : voice;  // 未指定時は環境変数の既定ボイス
          pcmBuffer = await ttsBufferCartesia(t, { model: cfg.ttsModel, voiceId });
        } else if (cfg.ttsVendor === "fishaudio") {
          const referenceId = voice === "default" ? "hMK7c1GPJmptCzI4bQIu" : voice;
          pcmBuffer = await ttsBufferFishAudio(t, { referenceId });
        } else if (cfg.ttsVendor === "sakura") {
          const modelName = voice === "default" ? "zundamon" : voice;
          pcmBuffer = await ttsBufferSakura(t, { model: modelName });
        } else if (cfg.ttsVendor === "zakicorp") {
          const speaker = voice === "default" ? "vivian" : voice;
          const z = await ttsStreamZakiCorp(t, { speaker }, res, segSeq);
          seg.bytes = z.bytes;
          seg.first_chunk_ms = z.firstChunkMs;
          pcmBuffer = null;
        } else {
          throw new Error("Unknown ttsVendor");
        }
        return pcmBuffer;
      }
      const synthesizeFallback = (t) => { seg.attempts++; return ttsBufferSakura(t, { model: "zundamon" }); };
      try {
        let pcmBuffer;
        let usedFallback = false;
        if (ttsFallbackActive) {
          pcmBuffer = await synthesizeFallback(t);
          usedFallback = true;
        } else {
          try {
            pcmBuffer = await synthesizePrimary(t);
          } catch (e) {
            let lastErr = e;
            trace.ext(cfg.ttsVendor, { status: ttsErrorStatus(e), ms: Date.now() - ttsStart, error: true });
            if (cfg.ttsVendor !== "sakura" && isRetryableTtsError(e)) {
              for (const wait of TTS_RETRY_WAITS_MS) {
                await sleepMs(wait);
                try { pcmBuffer = await synthesizePrimary(t); lastErr = null; break; }
                catch (e2) { lastErr = e2; trace.ext(cfg.ttsVendor, { status: ttsErrorStatus(e2), error: true, retry: true }); }
              }
            }
            if (lastErr) {
              if (cfg.ttsVendor === "sakura") throw lastErr;
              trace.error("tts_primary", lastErr); // この後ずんだもんへ切り替える
              ttsFallbackActive = true;
              usedFallback = true;
              // 切り替わった最初の文の頭に一言添える（音声だけ。画面のテキストは変えない）
              pcmBuffer = await synthesizeFallback(TTS_FALLBACK_NOTICE + t);
              ttsFallbackChars += TTS_FALLBACK_NOTICE.length;
            }
          }
        }
        seg.tts_ms = Date.now() - ttsStart;
        if (usedFallback) { seg.fallback = "sakura"; ttsFallbackChars += t.length; } else ttsInputChars += t.length;
        if (pcmBuffer) {
          const rawBytes = pcmBuffer.length;
          pcmBuffer = trimSilence(pcmBuffer);  // 前後の無音を削って切替体感を速く
          seg.bytes = pcmBuffer.length;
          seg.trim_ms = Math.round((rawBytes - pcmBuffer.length) / 48); // 24kHz/16bit/mono = 48 bytes/ms
          sendMeta(res, "tts_start", { id: segSeq, size: pcmBuffer.length });
          sendPCM(res, pcmBuffer);
        }
        seg.sent_at = trace.elapsed();
      } catch (e) {
        seg.error = ttsErrorStatus(e) ?? e?.name ?? "error";
        trace.error("tts", e);
        sendMeta(res, "error", { message: `TTS failed: ${e?.message || e}` });
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
          sendMeta(res, "tool_call", { name: delta.name, args: delta.args });

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
            if (DEBUG) sendMeta(res, "llm_token", { token: delta2.text });
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
        if (DEBUG) sendMeta(res, "llm_token", { token: delta.text });
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
      sendMeta(res, "done", {});
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
        if (cfg.ttsVendor === "sakura") {
          ttsCostResult = calcCostJpy({ providerApiType: ttsPriceKey, mora: ttsInputChars, usdJpyRate });
        } else if (cfg.ttsVendor === "fishaudio") {
          const utf8Bytes = Buffer.byteLength(textAll.trim(), "utf8");
          ttsCostResult = calcCostJpy({ providerApiType: ttsPriceKey, utf8Bytes, usdJpyRate });
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

        await saveLog({
          "owner_id#device_id":   `owner_id#${ownerId}#device_id#${deviceId}`,
          "session_id#timestamp": `session_id#${sessionId}#timestamp#${assistantTimestamp}`,
          owner_id: ownerId, device_id: deviceId, source: "esp",
          role: "assistant", content: textAll.trim(),
          content_type: "text", timestamp: assistantTimestamp, session_id: sessionId,
          llm_provider: llmProvider, llm_model: llmModelId,
          llm_tokens_in: llmUsage.in, llm_tokens_out: llmUsage.out,
          tts_provider: cfg.ttsVendor, tts_input_units: ttsInputChars, tts_input_unit_type: "characters",
          stt_provider: "soniox", stt_input_units: null, stt_input_unit_type: null,
          tool_usage: toolUsage,
          duration_ms: Date.now() - requestAt,
          character_id: characterId,
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
      sendMeta(res, "error", { message: msg });
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
