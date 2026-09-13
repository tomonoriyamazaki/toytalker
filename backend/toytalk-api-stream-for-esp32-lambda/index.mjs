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

  // ---- Web検索（Serper） ----
  const SERPER_API_KEY = process.env.SERPER_API_KEY;

  async function searchWeb(query, numResults = 3) {
    if (!SERPER_API_KEY) throw new Error("SERPER_API_KEY is not set");
    console.log(`[SearchWeb] query=${JSON.stringify(query)} bytes=${Buffer.byteLength(query, 'utf8')}`);
    const resp = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": SERPER_API_KEY },
      body: JSON.stringify({ q: query, num: numResults, safe: "active", gl: "jp", hl: "ja" }),
    });
    if (!resp.ok) throw new Error(`Serper API error: ${resp.status}`);
    const data = await resp.json();
    const results = (data.organic ?? []).slice(0, numResults).map(item => ({
      title: item.title ?? "",
      snippet: item.snippet ?? "",
      url: item.link ?? "",
    }));
    console.log(`[SearchWeb] results: ${JSON.stringify(results.map(r => r.title))}`);
    return results;
  }

  // 外部の有料APIを呼ぶツールの課金情報。ここに無いツール（デバイス設定変更など）は無料扱いで、
  // かかるLLMトークンはLLM側に含まれる。単価は toytalker-api-unit-prices の `${provider}#tool` 行。
  const PAID_TOOLS = {
    web_search: { provider: "serper", model: "google-search" },
  };

  // 検索結果と一緒に渡す指示。検索直後のターンだけに効かせ、通常ターンの口調には影響させない。
  const TOOL_RESULT_INSTRUCTION = "この検索結果をもとに答えてください。「調べてきたよ」「お待たせ」「調べたところ」のような前置き・報告・お礼は入れず、答えの中身から話し始めてください。口調や温かさはいつも通りのキャラクターのままで、そのあとも自然に会話を続けてください。";

  const WEB_SEARCH_TOOL = {
    name: "web_search",
    description: "子供の質問に答えるためにウェブ検索する。知識にない最新情報や具体的な事実を調べるときに使う。",
    parameters: {
      type: "object",
      properties: { query: { type: "string", description: "検索クエリ" } },
      required: ["query"],
    },
  };

  const ddbClient = new DynamoDBClient({ region: "ap-northeast-1" });
  const ddb = DynamoDBDocumentClient.from(ddbClient);
  const DEVICES_TABLE    = "toytalker-devices";
  const VOICES_TABLE     = "toytalker-voices";
  const CHARACTERS_TABLE = "toytalker-characters";
  const CHAT_LOGS_TABLE  = "toytalker-chat-logs";
  const LLMS_TABLE       = "toytalker-llms";
  const USAGE_TABLE         = "toytalker-usage";
  const UNIT_PRICES_TABLE   = "toytalker-api-unit-prices";
  const EXCHANGE_RATES_TABLE = "toytalker-exchange-rates";

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

  function calcCostJpy({ providerApiType, tokensIn, tokensOut, characters, utf8Bytes, mora, pcmBytes, userMessageChars, requests, usdJpyRate }) {
    const price = cachedPrices?.[providerApiType];
    if (!price) return null;
    const margin = cachedMargin || 1.5;
    if (price.currency === "JPY") {
      const inputCost = (mora ?? 0) * Number(price.unit_price_input);
      return { costJpy: inputCost * margin, usdJpyRate: null, unitPriceUsd: null, margin };
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
      // Web検索(Serper)など回数課金
      costUsd += (requests ?? 0) * Number(price.unit_price_input);
    }
    const costJpy = costUsd * usdJpyRate * margin;
    return { costJpy, usdJpyRate, unitPriceUsd: Number(price.unit_price_input), margin };
  }

  async function addUsage({ ownerId, deviceId, date, apiType, provider, model, costJpy, tokensIn, tokensOut, ttsCharacters, sttCharacters, requestCount, usdJpyRate, unitPriceUsd, margin }) {
    if (!costJpy || costJpy <= 0) return;
    const sk = `${date}#${deviceId}#${apiType}`;
    try {
      const addParts = ["cost_jpy :cost", "requests :one"];
      const vals = { ":cost": costJpy, ":one": requestCount ?? 1, ":p": provider, ":m": model, ":r": usdJpyRate ?? 0, ":u": unitPriceUsd ?? 0, ":mg": margin };
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

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

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
    const trimmed = pcm.slice(headCut * 2, (tailCut + 1) * 2);
    const cutMs = Math.round(((total - (tailCut - headCut + 1)) / sampleRate) * 1000);
    if (cutMs > 0) {
      console.log(`[TrimSilence] cut ${cutMs}ms (head ${Math.round(headCut / sampleRate * 1000)}ms, tail ${Math.round((total - 1 - tailCut) / sampleRate * 1000)}ms)`);
    }
    return trimmed;
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
  try {
    const tts = await openai.audio.speech.create({
      model: ttsModel,
      input: text,
      voice,
      response_format: "pcm"
    });

    const buf = Buffer.from(await tts.arrayBuffer());
    console.log(`[TTS] PCM size: ${buf.length} bytes`);

    // 先頭が MP3 だったらフォールバックで WAV 再取得
    if (buf[0] === 0xFF && (buf[1] === 0xF3 || buf[1] === 0xFB || buf[0] === 0x49)) {
      console.warn("[TTS] PCM not returned, retrying as WAV");
      const tts2 = await openai.audio.speech.create({
        model: ttsModel.replace("mini", "tts"),
        input: text,
        voice,
        format: "wav"
      });
      return Buffer.from(await tts2.arrayBuffer());
    }

    // 本物のPCM Bufferを返す
    // デバッグ: 最初の16バイトを確認
    const head = buf.slice(0, 16);
    console.log(`[TTS OpenAI] First 16 bytes (hex): ${head.toString('hex')}`);
    console.log(`[TTS OpenAI] First 8 samples (int16LE): ${Array.from({length: 8}, (_, i) => head.readInt16LE(i*2)).join(', ')}`);

    return buf;

  } catch (err) {
    console.error("[TTS] OpenAI PCM fetch failed:", err);
    throw err;
  }
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
    const key = process.env.GOOGLE_API_KEY;
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
    console.log(`[TTS Google] PCM size: ${pcmBuffer.length} bytes`);

    // Google TTS特有の冒頭クリック音対策: フェードイン処理
    const fadeMs = 20;  // 20ミリ秒
    const fadeSamples = Math.floor(sampleRateHertz * fadeMs / 1000);
    for (let i = 0; i < fadeSamples && i * 2 < pcmBuffer.length; i++) {
      const fade = i / fadeSamples;  // 0→1
      const sample = pcmBuffer.readInt16LE(i * 2);
      pcmBuffer.writeInt16LE(Math.round(sample * fade), i * 2);
    }

    // デバッグ: 最初の16バイトを確認
    const head = pcmBuffer.slice(0, 16);
    console.log(`[TTS Google] First 16 bytes (hex): ${head.toString('hex')}`);
    console.log(`[TTS Google] First 8 samples (int16LE): ${Array.from({length: 8}, (_, i) => head.readInt16LE(i*2)).join(', ')}`);

    return pcmBuffer;
  }


  // Gemini Speech Generation → Buffer (raw PCM)（APIキーは GOOGLE_API_KEY を共用）
  async function ttsBufferGemini(text, { model = "gemini-2.5-flash-preview-tts", voiceName = "Kore" } = {}) {
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

    // 24kHz/mono PCM16 base64 → 生のBufferに変換
    const pcmBuffer = Buffer.from(b64Pcm, "base64");
    console.log(`[TTS Gemini] PCM size: ${pcmBuffer.length} bytes`);

    // デバッグ: 最初の16バイトを確認
    const head = pcmBuffer.slice(0, 16);
    console.log(`[TTS Gemini] First 16 bytes (hex): ${head.toString('hex')}`);
    console.log(`[TTS Gemini] First 8 samples (int16LE): ${Array.from({length: 8}, (_, i) => head.readInt16LE(i*2)).join(', ')}`);

    return pcmBuffer;
  }

  // ElevenLabs TTS → Buffer (raw PCM)
  async function ttsBufferElevenLabs(text, { model = "eleven_turbo_v2_5", voiceId = "hMK7c1GPJmptCzI4bQIu" } = {}) {
    const key = process.env.ELEVENLABS_API_KEY;
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

    // レスポンスヘッダーを確認
    const contentType = resp.headers.get('content-type');
    console.log(`[TTS ElevenLabs] Content-Type: ${contentType}`);

    // PCMバイナリデータを直接返す
    const pcmBuffer = Buffer.from(await resp.arrayBuffer());
    console.log(`[TTS ElevenLabs] PCM size: ${pcmBuffer.length} bytes`);

    // デバッグ: 最初の16バイトを確認
    const head = pcmBuffer.slice(0, 16);
    console.log(`[TTS ElevenLabs] First 16 bytes (hex): ${head.toString('hex')}`);
    console.log(`[TTS ElevenLabs] First 8 samples (int16LE): ${Array.from({length: 8}, (_, i) => head.readInt16LE(i*2)).join(', ')}`);

    return pcmBuffer;
  }

  // Cartesia TTS → Buffer (raw PCM 24kHz/16bit/mono)
  const CARTESIA_API_VERSION = "2026-08-14";
  async function ttsBufferCartesia(text, { model = "sonic-3.6", voiceId } = {}) {
    const key = process.env.CARTESIA_API_KEY;
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

    const pcmBuffer = Buffer.from(await resp.arrayBuffer());
    console.log(`[TTS Cartesia] PCM size: ${pcmBuffer.length} bytes`);
    return pcmBuffer;
  }


  // FishAudio TTS → Buffer (raw PCM via MP3 decode is not feasible on Lambda;
  // FishAudio supports pcm output via format param)
  async function ttsBufferFishAudio(text, { referenceId = "hMK7c1GPJmptCzI4bQIu" } = {}) {
    const key = process.env.FISHAUDIO_API_KEY;
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
    const pcmBuffer = Buffer.from(await resp.arrayBuffer());
    console.log(`[TTS FishAudio] PCM size: ${pcmBuffer.length} bytes`);
    return pcmBuffer;
  }

  // Sakura (VOICEVOX) TTS → Buffer (raw PCM)
  async function ttsBufferSakura(text, { model = "zundamon", style = "normal" } = {}) {
    const key = process.env.SAKURA_API_KEY;
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
    const pcmBuffer = wavBuffer.slice(44);
    console.log(`[TTS Sakura] WAV size: ${wavBuffer.length}, PCM size: ${pcmBuffer.length} bytes`);

    return pcmBuffer;
  }

  // ZakiCorp TTS (clone voice via local GPU) — streaming PCM to ESP32
  async function ttsStreamZakiCorp(text, { speaker = "vivian", language = "Japanese" } = {}, res, segSeq) {
    const key = process.env.ZAKICORP_API_KEY;
    const baseUrl = process.env.ZAKICORP_TTS_URL;
    if (!key || !baseUrl) throw new Error("ZAKICORP_API_KEY or ZAKICORP_TTS_URL is not set");
    const resp = await fetch(`${baseUrl}/v1/tts/stream`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text, language, speaker }),
    });
    if (!resp.ok) {
      const errorText = await resp.text();
      throw new Error(`ZakiCorp TTS failed: ${resp.status} ${errorText}`);
    }
    let totalBytes = 0;
    let firstChunk = true;
    for await (const raw of resp.body) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      if (firstChunk) {
        sendMeta(res, "tts_start", { id: segSeq, size: 0, streaming: true });
        firstChunk = false;
      }
      sendPCM(res, chunk);
      totalBytes += chunk.length;
    }
    console.log(`[TTS ZakiCorp] streamed ${totalBytes} bytes, text="${text}"`);
    return totalBytes;
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
      if (!device) return null;

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
      if (!voiceId) return null;

      const voiceRes = await ddb.send(new GetCommand({
        TableName: VOICES_TABLE,
        Key: { voice_id: voiceId },
      }));
      if (!voiceRes.Item) return null;

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
        provider: voiceRes.Item.provider,
        vendorId: voiceRes.Item.vendor_id,
        personalityPrompt,
        ownerId: device.owner_id ?? null,
        characterId: device.character_id ?? "default",
        llmProvider,
        llmModelId,
      };
    } catch (e) {
      console.error("[DynamoDB] resolveCharacterFromDynamo error:", e);
      return null;
    }
  }

  export const handler = awslambda.streamifyResponse(async (event, res) => {
    res.setContentType("application/octet-stream");

    const body    = event.body ? JSON.parse(event.body) : {};
    if (body.warmup) { res.end(); return; }  // EventBridgeウォームアップping（コールドスタート対策）
    prewarmSpareInstance();  // 処理中に予備インスタンスを温める（同時2人目対策）
    prewarmConnections();    // LLM/TTS接続を先行確立（keep-alive切れ時の保険、非同期）
    loadDefaultLlm();        // デフォルトLLMを先読み（キャッシュ済みなら即時）
    const messages= body.messages ?? [{ role:"user", content:"自己紹介して" }];
    const deviceId = typeof body.device_id === "string" ? body.device_id : null;
    const backchannelFired = !!body.backchannel_fired;

    // ---- ログ用メタデータ ----
    const sessionId  = typeof body.session_id === "string" ? body.session_id : "unknown";
    let   ownerId    = typeof body.owner_id   === "string" ? body.owner_id   : deviceId ?? "unknown";
    const requestAt  = Date.now();
    const userTimestamp = new Date(requestAt).toISOString();

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

    if (deviceId) {
      const charConfig = await resolveCharacterFromDynamo(deviceId);
      if (charConfig) {
        ttsKey = normalizeModelKey(charConfig.provider) ?? ttsKey;
        voice    = charConfig.vendorId ?? voice;
        personalityPrompt = charConfig.personalityPrompt;
        llmProvider = charConfig.llmProvider;
        llmModelId  = charConfig.llmModelId;
        characterId = charConfig.characterId ?? "default";
        if (charConfig.ownerId) ownerId = charConfig.ownerId;
        console.log(`[DynamoDB] device=${deviceId}, tts=${charConfig.provider}, voice=${charConfig.vendorId}, llm=${llmProvider}/${llmModelId}, hasPersonality=${!!personalityPrompt}, ownerId=${ownerId}`);
      } else {
        console.log(`[DynamoDB] device=${deviceId} not found or no character set, using defaults`);
      }
    }

    // キャラ側にLLM指定がなければ is_default エントリを使う
    if (!llmProvider || !llmModelId) {
      const d = await loadDefaultLlm();
      llmProvider = d.provider;
      llmModelId  = d.modelId;
    }
    console.log(`[LLM] provider=${llmProvider}, model=${llmModelId}`);

    const cfg = TTS_TABLE[ttsKey] ?? TTS_TABLE[TTS_DEFAULT];

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
    const toolHint = SERPER_API_KEY ? "\nウェブ検索ツールが使えます。最新情報や具体的な事実を調べたいときに使ってください。検索する前に、短い一言（例:「調べてみるね」「ちょっと待ってね」など、毎回違う表現）を添えてから検索してください。" : "";
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
    let llmTokensIn = 0, llmTokensOut = 0;
    let ttsInputChars = 0;
    const toolCalls = {};  // ツール名→成功回数。PAID_TOOLSに載っているものだけ課金対象

    // ---- LLM ストリーム生成 ----
    function streamLLMOpenAI(msgs, model) {
      return (async function* () {
        const llm = await openai.chat.completions.create({
          model,
          temperature: 0.7,
          stream: true,
          stream_options: { include_usage: true },
          messages: msgs,
        });
        for await (const chunk of llm) {
          if (chunk.usage) {
            llmTokensIn  = chunk.usage.prompt_tokens     ?? 0;
            llmTokensOut = chunk.usage.completion_tokens ?? 0;
          }
          const delta = chunk.choices?.[0]?.delta?.content ?? "";
          if (delta) yield delta;
        }
      })();
    }

    function buildGeminiContents(msgs) {
      const systemMsg = msgs.find(m => m.role === "system");
      const chatMsgs = msgs.filter(m => m.role !== "system");
      const contents = chatMsgs.map(m => {
        if (m.role === "assistant" && m.functionCall) {
          return { role: "model", parts: [{ functionCall: m.functionCall }] };
        }
        if (m.role === "user" && m.functionResponse) {
          return { role: "user", parts: [{ functionResponse: m.functionResponse }] };
        }
        return {
          role: m.role === "assistant" ? "model" : m.role,
          parts: [{ text: m.content }],
        };
      });
      return { systemMsg, contents };
    }

    function streamLLMGemini(msgs, model, { tools = null } = {}) {
      const { systemMsg, contents } = buildGeminiContents(msgs);
      const body = { contents };
      if (systemMsg) {
        body.systemInstruction = { parts: [{ text: systemMsg.content }] };
      }
      body.generationConfig = { temperature: 0.7, thinkingConfig: { thinkingBudget: 0 } };
      if (tools) {
        body.tools = [{ function_declarations: tools }];
      }

      const key = process.env.GOOGLE_API_KEY;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;

      return (async function* () {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`Gemini API error: ${resp.status} ${errText}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            if (data === "[DONE]") return;
            try {
              const parsed = JSON.parse(data);
              const parts = parsed.candidates?.[0]?.content?.parts ?? [];
              if (parsed.usageMetadata) {
                llmTokensIn  += parsed.usageMetadata.promptTokenCount ?? 0;
                llmTokensOut += parsed.usageMetadata.candidatesTokenCount ?? 0;
              }
              for (const part of parts) {
                if (part.functionCall) {
                  yield { __toolCall: true, name: part.functionCall.name, args: part.functionCall.args };
                  return;
                }
                if (part.text !== undefined && !part.thought) {
                  if (part.text) yield part.text;
                }
              }
            } catch {}
          }
        }
      })();
    }

    function streamLLMAnthropic(msgs, model) {
      const systemMsg = msgs.find(m => m.role === "system");
      const chatMsgs = msgs.filter(m => m.role !== "system");

      const body = {
        model,
        max_tokens: 1024,
        stream: true,
        temperature: 0.7,
        messages: chatMsgs,
      };
      if (systemMsg) {
        body.system = systemMsg.content;
      }

      const key = process.env.ANTHROPIC_API_KEY;

      return (async function* () {
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": key,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`Anthropic API error: ${resp.status} ${errText}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split("\n");
          buf = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const data = line.slice(6).trim();
            try {
              const parsed = JSON.parse(data);
              if (parsed.type === "content_block_delta") {
                const text = parsed.delta?.text ?? "";
                if (text) yield text;
              } else if (parsed.type === "message_delta" && parsed.usage) {
                llmTokensOut = parsed.usage.output_tokens ?? 0;
              } else if (parsed.type === "message_start" && parsed.message?.usage) {
                llmTokensIn = parsed.message.usage.input_tokens ?? 0;
              } else if (parsed.type === "message_stop") {
                return;
              }
            } catch {}
          }
        }
      })();
    }

    const enableTools = llmProvider === "google" && SERPER_API_KEY;
    const toolsDef = enableTools ? [WEB_SEARCH_TOOL] : null;

    function createLLMStream(msgs) {
      if (llmProvider === "openai") {
        return streamLLMOpenAI(msgs, llmModelId);
      } else if (llmProvider === "google") {
        return streamLLMGemini(msgs, llmModelId, { tools: toolsDef });
      } else if (llmProvider === "anthropic") {
        return streamLLMAnthropic(msgs, llmModelId);
      } else {
        return (async function* () { yield "（LLM ルート未実装です）"; })();
      }
    }

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

      ttsInputChars += t.length;

      // 音声チャンク（生PCMバイナリとして送信）
      try {
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
          await ttsStreamZakiCorp(t, { speaker }, res, segSeq);
          pcmBuffer = null;
        } else {
          throw new Error("Unknown ttsVendor");
        }
        if (pcmBuffer) {
          pcmBuffer = trimSilence(pcmBuffer);  // 前後の無音を削って切替体感を速く
          sendMeta(res, "tts_start", { id: segSeq, size: pcmBuffer.length });
          sendPCM(res, pcmBuffer);
          console.log(`[Lambda] id=${segSeq}, pcm.length=${pcmBuffer.length} bytes, text="${t}"`);
        }
      } catch (e) {
        sendMeta(res, "error", { message: `TTS failed: ${e?.message || e}` });
      }
    }

    // ---- LLM ストリーム処理（共通インターフェース）----
    try {
      // ---- LLM ストリーム処理（tool callループ対応）----
      let toolCallDetected = false;
      for await (const delta of llmStream) {
        if (delta && delta.__toolCall) {
          toolCallDetected = true;
          console.log(`[ToolCall] ${delta.name}(${JSON.stringify(delta.args)})`);
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
              toolResult = await searchWeb(delta.args.query);
              toolCalls.web_search = (toolCalls.web_search ?? 0) + 1;
              console.log(`[ToolCall] search returned ${toolResult.length} results`);
            } catch (e) {
              console.error(`[ToolCall] search error:`, e);
              toolResult = [{ title: "検索エラー", snippet: "検索に失敗しました", url: "" }];
            }
          } else {
            toolResult = { error: `Unknown tool: ${delta.name}` };
          }

          messagesWithSystem.push(
            { role: "assistant", functionCall: { name: delta.name, args: delta.args } },
            { role: "user", functionResponse: { name: delta.name, response: { results: toolResult, instruction: TOOL_RESULT_INSTRUCTION } } }
          );
          llmStream = createLLMStream(messagesWithSystem);

          for await (const delta2 of llmStream) {
            if (delta2 && delta2.__toolCall) {
              console.log(`[ToolCall] nested tool call ignored: ${delta2.name}`);
              break;
            }
            textAll += delta2;
            buf     += delta2;
            if (DEBUG) sendMeta(res, "llm_token", { token: delta2 });
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
        textAll += delta;
        buf     += delta;
        if (DEBUG) sendMeta(res, "llm_token", { token: delta });
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
      // 残り
      const tail = buf.trim();
      if (tail.length > 0) {
        buf = "";
        await emitSegment(tail, { final: true });
      }
      sendMeta(res, "done", {});

      // ---- コスト計算 + usage書き込み + ログ保存 ----
      if (sessionId !== "unknown" && textAll.trim()) {
        const assistantTimestamp = new Date().toISOString();

        await loadPricingCache();
        const date = assistantTimestamp.slice(0, 10);
        const month = assistantTimestamp.slice(0, 7);
        const usdJpyRate = await getExchangeRate(month);

        // LLM
        const llmPriceKey = `${llmProvider}#llm`;
        const llmCost = calcCostJpy({ providerApiType: llmPriceKey, tokensIn: llmTokensIn, tokensOut: llmTokensOut, usdJpyRate });
        if (llmCost) {
          await addUsage({ ownerId, deviceId, date, apiType: "llm", provider: llmProvider, model: llmModelId, costJpy: llmCost.costJpy, tokensIn: llmTokensIn, tokensOut: llmTokensOut, usdJpyRate: llmCost.usdJpyRate, unitPriceUsd: llmCost.unitPriceUsd, margin: llmCost.margin });
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
          await addUsage({ ownerId, deviceId, date, apiType: "tts", provider: cfg.ttsVendor, model: cfg.ttsModel, costJpy: ttsCostResult.costJpy, ttsCharacters: ttsInputChars, usdJpyRate: ttsCostResult.usdJpyRate, unitPriceUsd: ttsCostResult.unitPriceUsd, margin: ttsCostResult.margin });
        }

        // STT (確定文の文字数から概算)
        const userMsgChars = lastUserMsg?.content?.length ?? 0;
        let sttCost = null;
        if (userMsgChars > 0) {
          sttCost = calcCostJpy({ providerApiType: "soniox#stt", userMessageChars: userMsgChars, usdJpyRate });
          if (sttCost) {
            await addUsage({ ownerId, deviceId, date, apiType: "stt", provider: "soniox", model: "soniox", costJpy: sttCost.costJpy, sttCharacters: userMsgChars, usdJpyRate: sttCost.usdJpyRate, unitPriceUsd: sttCost.unitPriceUsd, margin: sttCost.margin });
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
          await addUsage({ ownerId, deviceId, date, apiType: "tool", provider: paid.provider, model: paid.model, costJpy: c.costJpy, requestCount: count, usdJpyRate: c.usdJpyRate, unitPriceUsd: c.unitPriceUsd, margin: c.margin });
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
          llm_tokens_in: llmTokensIn, llm_tokens_out: llmTokensOut,
          tts_provider: cfg.ttsVendor, tts_input_units: ttsInputChars, tts_input_unit_type: "characters",
          stt_provider: "soniox", stt_input_units: null, stt_input_unit_type: null,
          tool_usage: toolUsage,
          duration_ms: Date.now() - requestAt,
          character_id: characterId,
          voice_id: voice,
          cost_stt: sttCost?.costJpy ?? 0,
          cost_llm: llmCost?.costJpy ?? 0,
          cost_tts: ttsCostResult?.costJpy ?? 0,
          cost_tool: toolCostTotal,
          cost_total: (sttCost?.costJpy ?? 0) + (llmCost?.costJpy ?? 0) + (ttsCostResult?.costJpy ?? 0) + toolCostTotal,
        });
      }
    } catch (err) {
      const msg = (err && err.message) ? err.message : String(err);
      sendMeta(res, "error", { message: msg });
    } finally {
      res.end();
    }
  });
