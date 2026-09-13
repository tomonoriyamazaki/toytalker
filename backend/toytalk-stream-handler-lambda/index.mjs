  // Node.js 18+ / ESM（index.mjs）
  // Handler: index.handler
  // Env: OPENAI_API_KEY, GOOGLE_API_KEY, ELEVENLABS_API_KEY, FISHAUDIO_API_KEY, ZAKICORP_API_KEY, ZAKICORP_TTS_URL,
  //      CARTESIA_API_KEY, CARTESIA_DEFAULT_VOICE_ID (任意: CARTESIA_LANGUAGE 既定 "ja")
  import OpenAI from "openai";
  import { createHash } from "node:crypto";
  import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
  import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, QueryCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
  import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

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
    const resp = await fetch("https://google.serper.dev/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-API-KEY": SERPER_API_KEY },
      body: JSON.stringify({ q: query, num: numResults, safe: "active", gl: "jp", hl: "ja" }),
    });
    if (!resp.ok) throw new Error(`Serper API error: ${resp.status}`);
    const data = await resp.json();
    return (data.organic ?? []).slice(0, numResults).map(item => ({
      title: item.title ?? "",
      snippet: item.snippet ?? "",
      url: item.link ?? "",
    }));
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
  const CHARACTERS_TABLE    = "toytalker-characters";
  const VOICES_TABLE        = "toytalker-voices";
  const CHAT_LOGS_TABLE     = "toytalker-chat-logs";
  const LLMS_TABLE          = "toytalker-llms";
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
      console.log(`[Pricing] cached ${Object.keys(prices).length} prices, margin=${cachedMargin}`);
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

    // Sakura: 円建て直接
    if (price.currency === "JPY") {
      const inputCost = (mora ?? 0) * Number(price.unit_price_input);
      return { costJpy: inputCost * margin, usdJpyRate: null, unitPriceUsd: null, margin };
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
    const tts = await openai.audio.speech.create({
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

    // PCMバイナリデータを取得
    const pcmBuffer = Buffer.from(await resp.arrayBuffer());

    // PCM16 → WAV base64 に変換
    const pcmB64 = pcmBuffer.toString("base64");
    return pcm16ToWavBase64(pcmB64, 24000, 1);
  }

  // Cartesia TTS 共通: /tts/bytes を呼び、要求した形式の音声バイナリをBufferで返す
  const CARTESIA_API_VERSION = "2026-08-14";
  async function ttsBytesCartesia(text, { model, voiceId, outputFormat }) {
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

  // Fish Audio TTS → base64(WAV)
  async function ttsToBase64FishAudio(text, { referenceId = "6fdaebea7db042129f03ecb0a57ea7b6" } = {}) {
    const key = process.env.FISHAUDIO_API_KEY;
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

  export const handler = awslambda.streamifyResponse(async (event, res) => {
    res.setContentType("text/event-stream");

    const body      = event.body ? JSON.parse(event.body) : {};
    if (body.warmup) { res.end(); return; }  // EventBridgeウォームアップping（コールドスタート対策）
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
    const requestAt  = Date.now();
    const userTimestamp = new Date(requestAt).toISOString();

    // 単価キャッシュ・デフォルトLLMを先にロード（await不要、バックグラウンドで）
    loadPricingCache();
    loadDefaultLlm();

    const backchannelFired = !!body.backchannel_fired;
    const characterId = typeof body.character_id === "string" ? body.character_id : null;
    if (characterId) {
      const charConfig = await resolveCharacterFromDynamo(characterId);
      if (charConfig) {
        ttsKey = normalizeModelKey(charConfig.provider) ?? ttsKey;
        voice    = charConfig.vendorId ?? voice;
        personalityPrompt = charConfig.personalityPrompt;
        llmProvider = charConfig.llmProvider;
        llmModelId  = charConfig.llmModelId;
        console.log(`[Character] id=${characterId}, tts=${charConfig.provider}, voice=${charConfig.vendorId}, llm=${llmProvider}/${llmModelId}`);
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
    const toolHint = SERPER_API_KEY ? "\nウェブ検索ツールが使えます。最新情報や具体的な事実を調べたいときに使ってください。検索する前に、短い一言（例:「調べてみるね」「ちょっと待ってね」など、毎回違う表現）を添えてから検索してください。" : "";
    const basePrompt = `あなたは子供向けの友好的な音声アシスタントです。簡潔に答えて、自然に会話を続けてください。単語の間に半角スペースを入れないでください。現在の日時は${now}です。日時を聞かれたら年は省略して簡潔に答えてください。相手が話した言語で返答してください。${backchannelHint}${toolHint}`;
    const systemContent = personalityPrompt ? `${personalityPrompt}\n\n${basePrompt}` : basePrompt;
    const messagesWithSystem = [{ role: "system", content: systemContent }, ...messages];

    // ---- ストリーム状態 ----
    let buf = "";
    let textAll = "";
    let segSeq = 0;
    let lastSegHash = "";
    let firstTtsMarked = false;
    let llmTokensIn = 0, llmTokensOut = 0;
    let ttsInputChars = 0;
    const toolCalls = {};  // ツール名→成功回数。PAID_TOOLSに載っているものだけ課金対象
    let ttsPcmBytes = 0;
    let geminiTtsAudioTokens = 0;

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
      const reqBody = { contents };
      if (systemMsg) {
        reqBody.systemInstruction = { parts: [{ text: systemMsg.content }] };
      }
      reqBody.generationConfig = { temperature: 0.7 };
      if (tools) {
        reqBody.tools = [{ function_declarations: tools }];
      }

      const key = process.env.GOOGLE_API_KEY;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${key}`;

      return (async function* () {
        const resp = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reqBody),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`Gemini API error: ${resp.status} ${errText}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let sbuf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sbuf += decoder.decode(value, { stream: true });
          const lines = sbuf.split("\n");
          sbuf = lines.pop();
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
                if (part.text) yield part.text;
              }
            } catch {}
          }
        }
      })();
    }

    function streamLLMAnthropic(msgs, model) {
      const systemMsg = msgs.find(m => m.role === "system");
      const chatMsgs = msgs.filter(m => m.role !== "system");

      const reqBody = {
        model,
        max_tokens: 1024,
        stream: true,
        temperature: 0.7,
        messages: chatMsgs,
      };
      if (systemMsg) {
        reqBody.system = systemMsg.content;
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
          body: JSON.stringify(reqBody),
        });
        if (!resp.ok) {
          const errText = await resp.text();
          throw new Error(`Anthropic API error: ${resp.status} ${errText}`);
        }
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let sbuf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sbuf += decoder.decode(value, { stream: true });
          const lines = sbuf.split("\n");
          sbuf = lines.pop();
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

      // 画面用の確定テキスト
      send(res, "segment", { id: segSeq, text: t, final });

      // ---- TTS 開始マーク（最初のチャンクのみ）
      if (DEBUG_TIME && !firstTtsMarked) {
        send(res, "mark", { k: "tts_first_byte", t: Date.now() });
        firstTtsMarked = true;
      }

      ttsInputChars += t.length;

      // 音声チャンク（textは載せない）
      try {
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
        send(res, "tts", { id: segSeq, format: fmt, b64 });
      } catch (e) {
        send(res, "error", { message: `TTS failed: ${e?.message || e}` });
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
          send(res, "tool_call", { name: delta.name, args: delta.args });

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
            if (DEBUG) send(res, "llm_token", { token: delta2 });
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
        if (DEBUG) send(res, "llm_token", { token: delta });
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
      send(res, "done", {});

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

        // ログ保存（計算済みコスト付き）
        await saveLog({
          "owner_id#device_id":   `owner_id#${ownerId}#device_id#${deviceId}`,
          "session_id#timestamp": `session_id#${sessionId}#timestamp#${assistantTimestamp}`,
          owner_id: ownerId, device_id: deviceId, source: "app",
          role: "assistant", content: textAll.trim(),
          content_type: "text", timestamp: assistantTimestamp, session_id: sessionId,
          llm_provider: llmProvider, llm_model: llmModelId,
          llm_tokens_in: llmTokensIn, llm_tokens_out: llmTokensOut,
          tts_provider: cfg.ttsVendor, tts_input_units: ttsInputChars, tts_input_unit_type: "characters",
          stt_provider: null, stt_input_units: null, stt_input_unit_type: null,
          tool_usage: toolUsage,
          duration_ms: Date.now() - requestAt,
          character_id: characterId ?? "default",
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
      send(res, "error", { message: msg });
    } finally {
      res.end();
    }
  });
