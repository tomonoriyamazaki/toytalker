  // Node.js 18+ / ESM（index.mjs）
  // Handler: index.handler
  // Env: OPENAI_API_KEY, GOOGLE_API_KEY, ELEVENLABS_API_KEY, FISHAUDIO_API_KEY, SAKURA_API_KEY, ZAKICORP_API_KEY, ZAKICORP_TTS_URL,
  //      CARTESIA_API_KEY, CARTESIA_DEFAULT_VOICE_ID (任意: CARTESIA_LANGUAGE 既定 "ja")
  import OpenAI from "openai";
  import { createHash } from "node:crypto";
  import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
  import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
  import { Agent, setGlobalDispatcher } from "undici";
  import { ensureSecrets, secret } from "../shared/secrets.mjs";
  import { tableName } from "../shared/tables.mjs";
  import { DATA_REGION } from "../shared/region.mjs";
  import { checkBalance } from "../shared/wallet.mjs";
  import { chatStream, toolRoundMessages, searchWeb, WEB_SEARCH_TOOL, TOOL_RESULT_INSTRUCTION, SEARCH_TOOL_HINT, searchCallArgs, isSearchPreface, isSearchPromiseOnly, inlineLastToolRound, loadDefaultLlm } from "../shared/llm.mjs";
  import { startTrace, describeClient, describePrevTurn, describeDevice, errorStatus } from "../shared/trace.mjs";
  import { deviceSettings } from "../shared/device-settings.mjs";
  import { recordDeviceStatus } from "../shared/device-status.mjs";
import { checkDeviceKey, deviceGate, loadDeviceRow } from "../shared/auth.mjs";
import { trimSilence } from "../shared/tts-pcm.mjs";
import { chatLogEnabled } from "../shared/chat-log.mjs";
import { recordTurn } from "../shared/turn-record.mjs";
import { saveChatLog } from "../shared/chat-log.mjs";
import { prewarmSpareInstance } from "../shared/warm.mjs";
import { normalizeModelKey } from "../shared/tts-vendors.mjs";

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

  const ddbClient = new DynamoDBClient({ region: DATA_REGION ?? "ap-northeast-1" });
  const ddb = DynamoDBDocumentClient.from(ddbClient);
  const DEVICES_TABLE    = tableName("devices");
  const VOICES_TABLE     = tableName("voices");
  const CHARACTERS_TABLE = tableName("characters");
  const LLMS_TABLE       = tableName("llms");

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

  // 前後の無音を削る trimSilence は backend/shared/tts-pcm.mjs（相槌と共通）

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

  // 既定の LLM（キャラクターに llm_id が無いとき）は backend/shared/llm.mjs の loadDefaultLlm



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

    // 24kHz/mono PCM16 base64 → 生のBufferに変換。音声トークン数（原価の計算に使う）は Buffer に添えて返す
    const pcm = Buffer.from(b64Pcm, "base64");
    pcm.audioTokens = json?.usageMetadata?.candidatesTokenCount ?? 0;
    return pcm;
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

  // ---- 残高0の停止（docs/pricing-and-cost-model.md 11.1）----
  // 本体は画面が無いので一言しゃべって終える。声はキャラクターによらずずんだもん（フォールバックと同じ。1回作ればインスタンスが覚えておく）。
  // 合成の原価は運営持ち（残高0の人から引かない）。ファームは通常の返答と同じ順（segment → tts_start → PCM → done）で受けるので変更不要
  const NO_BALANCE_TEXT = "ポイントがなくなったよ。おうちのひとにきいてね。";
  let noBalancePcm = null;
  async function sendNoBalance(res, trace) {
    sendMeta(res, "segment", { id: 1, text: NO_BALANCE_TEXT, final: true });
    try {
      noBalancePcm ??= trimSilence(await ttsBufferSakura(NO_BALANCE_TEXT, { model: "zundamon" }));
      sendMeta(res, "tts_start", { id: 1, size: noBalancePcm.length });
      sendPCM(res, noBalancePcm);
    } catch (e) {
      trace.error("tts", e);
      sendMeta(res, "error", { message: `TTS failed: ${e?.message || e}` });
    }
    sendMeta(res, "done", {});
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
  //
  // 読む順（2026-11-14）: 前の結果が無いと次が決まらないので device → character は直列。その先の voice と llm、
  // および残高（handler の checkBalance。持ち主は device の行で決まる）は並べて読む。往復は最大5回 → 3回。
  // 東京では1回 3〜4ms なので差は出ないが、データと別のリージョンの Lambda（infra/README の「別リージョンの Lambda と振り分け」）
  // では1回ごとにリージョン間の往復（約 100ms）が乗る。

  // 機器の行を読む loadDeviceRow は backend/shared/auth.mjs（相槌と共通）

  // 機器の行からキャラクター・声・LLM を解決する。失敗（null）なら handler は body の値で続ける
  async function resolveCharacterFromDevice(device) {
    try {
      const partial = { registered: true, deviceRow: device, ownerId: device.owner_id ?? null, characterId: device.character_id ?? "default" };

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

      // 声と LLM 設定は互いに依らないので並べて読む（llm_id 未設定なら読まず、handler 側でデフォルトを充当）
      const [voiceRes, llmRes] = await Promise.all([
        ddb.send(new GetCommand({
          TableName: VOICES_TABLE,
          Key: { voice_id: voiceId },
        })),
        llmId
          ? ddb.send(new GetCommand({
              TableName: LLMS_TABLE,
              Key: { llm_id: llmId },
            }))
          : null,
      ]);
      if (!voiceRes.Item) return partial;

      let llmProvider = null;
      let llmModelId  = null;
      if (llmRes?.Item) {
        llmProvider = llmRes.Item.provider;
        llmModelId  = llmRes.Item.model_id;
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
      console.error("[DynamoDB] resolveCharacterFromDevice error:", e);
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
      prev_turn: describePrevTurn(body.prev_turn), // 前のターンをクライアントが受け取って鳴らしたか（送らない版は null）
      device: describeDevice(body.device), // 本体の電池・温度・充電状態（送らない版は null）
    });


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
    const loaded = deviceId ? await loadDeviceRow(deviceId) : { device: null };
    const deviceRow = loaded?.device ?? null;
    if (loaded && !deviceRow) {
      const gate = deviceGate(null);
      if (gate) return reject(gate);
    }
    // デバイス鍵（なりすまし防止。backend/shared/auth.mjs の checkDeviceKey）。行がある機器だけ照合する
    if (deviceRow) {
      const key = await checkDeviceKey(event, deviceRow);
      trace.set(key.log);
      if (key.gate) return reject(key.gate);
    }
    // 持ち主は機器の行で決まる。残高の確認をここで始め、キャラクター以降の読み込みと並べる（待つのは下）。
    // 門（未登録機・デバイス鍵）を通ってから始めるので、拒否で返るときに読みかけの要求は残らない
    if (deviceRow?.owner_id) { ownerId = deviceRow.owner_id; trace.set({ owner_id: ownerId }); }
    // 会話の文章を残すか（backend/shared/chat-log.mjs。環境の既定を、機器の行の chat_log が上書きする）
    const chatLog = chatLogEnabled(deviceRow);
    trace.set({ chat_log: chatLog });
    const balanceCheck = checkBalance(ownerId);
    // 本体の状態（電池・温度・充電）を機器の行に残す（backend/shared/device-status.mjs。数分おきか充電状態が変わったとき）。
    // キャラクターの読み込みと並べて待つので、返事は遅れない。失敗しても会話は続ける
    const statusWrite = deviceRow ? recordDeviceStatus(ddb, DEVICES_TABLE, deviceRow, describeDevice(body.device), requestAt) : null;
    const charConfig = deviceRow ? await resolveCharacterFromDevice(deviceRow) : (loaded ? { registered: false } : null);
    if (statusWrite) trace.set({ device_status_saved: await statusWrite });
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

    // 残高が0以下なら会話を始めず、止めた理由を一言しゃべって終える（docs/pricing-and-cost-model.md 11.3）
    if (!(await balanceCheck).ok) {
      trace.set({ status: 402, reason: "no_balance" });
      try { await sendNoBalance(res, trace); } finally { res.end(); trace.finish(); }
      return;
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

    // 本体へ設定を下ろす（相槌のオン・オフ、話し終わりの待ち。backend/shared/device-settings.mjs）。本体は次の会話から使う。
    // 古いファームは知らないメタデータとして読み飛ばす
    if (deviceRow) {
      const settings = deviceSettings(deviceRow);
      sendMeta(res, "settings", settings);
      trace.set({ stt_wait: settings.stt?.wait ?? null });
    }

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
    if (lastUserMsg?.role === "user" && sessionId !== "unknown" && chatLog) {
      saveChatLog({
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
    const toolHint = enableTools ? SEARCH_TOOL_HINT : "";
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
    let ttsPcmBytes = 0;             // 主の声の音声の長さ（削る前の PCM。OpenAI の音声ぶんの原価）
    let geminiTtsAudioTokens = 0;    // Gemini の応答が返した音声トークン数（音声ぶんの原価）

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
      const callPrimary = (t) => TTS_SLOW_EXEMPT.has(cfg.ttsVendor) ? synthesizePrimary(t) : withTtsDeadline(synthesizePrimary(t), ttsSlowMs(cfg.ttsVendor, t));
      const synthesizeFallback = (t) => { seg.attempts++; return ttsBufferSakura(t, { model: "zundamon" }); };
      try {
        let pcmBuffer;
        let usedFallback = false;
        if (ttsFallbackActive) {
          pcmBuffer = await synthesizeFallback(t);
          usedFallback = true;
        } else {
          try {
            pcmBuffer = await callPrimary(t);
          } catch (e) {
            let lastErr = e;
            trace.ext(cfg.ttsVendor, { status: ttsErrorStatus(e), ms: Date.now() - ttsStart, error: true, ...(e?.slow ? { slow: true } : {}) });
            if (cfg.ttsVendor !== "sakura" && isRetryableTtsError(e)) {
              for (const wait of TTS_RETRY_WAITS_MS) {
                await sleepMs(wait);
                try { pcmBuffer = await callPrimary(t); lastErr = null; break; }
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
              pcmBuffer = await synthesizeFallback(TTS_FALLBACK_NOTICE + t);
              ttsFallbackChars += TTS_FALLBACK_NOTICE.length;
            }
          }
        }
        seg.tts_ms = Date.now() - ttsStart;
        if (usedFallback) { seg.fallback = "sakura"; ttsFallbackChars += t.length; } else ttsInputChars += t.length;
        if (pcmBuffer) {
          const rawBytes = pcmBuffer.length;
          if (!usedFallback) { ttsPcmBytes += rawBytes; geminiTtsAudioTokens += pcmBuffer.audioTokens ?? 0; }
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
          if (DEBUG) sendMeta(res, "llm_token", { token: delta.text });
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
        sendMeta(res, "tool_call", { name: call.name, args: call.args });

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
      sendMeta(res, "done", {});
      trace.mark("done_sent");

      // ---- 原価の計算 + usage + 会話ログ + 台帳（backend/shared/turn-record.mjs。App 用の本文と同じ）----
      // 本文が空でも有料の検索を呼んでいれば記録する（ロードマップ30。以前は空だと検索代が記録から漏れた）
      if (sessionId !== "unknown" && (textAll.trim() || Object.keys(toolCalls).length > 0)) {
        await recordTurn({
          source: "esp", ownerId, deviceId, sessionId, characterId, voice, text: textAll, chatLog,
          sttProvider: "soniox", durationMs: Date.now() - requestAt,
          llm: { provider: llmProvider, model: llmModelId, tokensIn: llmUsage.in, tokensOut: llmUsage.out },
          tts: { vendor: cfg.ttsVendor, model: cfg.ttsModel, chars: ttsInputChars, fallbackChars: ttsFallbackChars, pcmBytes: ttsPcmBytes, audioTokens: geminiTtsAudioTokens },
          userMsgChars: lastUserMsg?.content?.length ?? 0, toolCalls,
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
