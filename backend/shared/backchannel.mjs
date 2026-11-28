// 相槌の本体（App 用・ESP32 用の相槌 Lambda が同じものを使う。ロードマップ50 の相槌ぶん）。
//
//   聞こえた断片 → LLM で一言 → TTS（失敗したら即ずんだもん）→ 原価を usage と台帳に記録
//
// 各 Lambda の index.mjs に残るのは、要求の読み方・本人確認（App は Cognito のトークン、ESP32 は登録済み機器の門とデバイス鍵）・
// 残高の確認・出力の形（App は WAV の base64 を JSON で、ESP32 は PCM をそのまま）だけ。
// ログ（trace）には聞こえた断片も相槌の文章も書かない（backend/shared/trace.mjs）。
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand } from "@aws-sdk/lib-dynamodb";
import { secret } from "./secrets.mjs";
import { tableName } from "./tables.mjs";
import { dataClientConfig } from "./region.mjs";
import { errorStatus } from "./trace.mjs";
import { jstDate } from "./jst.mjs";
import { BACKCHANNEL_LLM_MODEL, geminiThinkingConfig } from "./llm.mjs";
import { normalizeModelKey } from "./tts-vendors.mjs";
import { synthesizePcmBuffer } from "./tts-pcm.mjs";
import { loadPricingCache, getExchangeRate, calcCostJpy, calcTtsCost, addUsage } from "./cost.mjs";
import { recordConsume } from "./wallet.mjs";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(dataClientConfig));
const CHARACTERS_TABLE = tableName("characters");
const VOICES_TABLE     = tableName("voices");

// 声の会社 → TTS の呼び先とモデル（モデル名の表を1つにするのはロードマップ14）
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
const TTS_DEFAULT = "Sakura";
const FALLBACK = { ttsVendor: "sakura", ttsModel: "sakura", voice: "zundamon" };

/**
 * キャラクターの行と、その声の行を読む。無い・読めないときは null（ずんだもん・人格なしで続ける）。
 * @returns {Promise<{ provider: string, vendorId: string, personalityPrompt: string|null, ownerId: string|null }|null>}
 */
export async function resolveCharacter(characterId) {
  try {
    const charRes = await ddb.send(new GetCommand({ TableName: CHARACTERS_TABLE, Key: { character_id: characterId } }));
    if (!charRes.Item) return null;

    const voiceId = charRes.Item.voice_id;
    if (!voiceId) return null;

    const voiceRes = await ddb.send(new GetCommand({ TableName: VOICES_TABLE, Key: { voice_id: voiceId } }));
    if (!voiceRes.Item) return null;

    return {
      provider: voiceRes.Item.provider,
      vendorId: voiceRes.Item.vendor_id,
      personalityPrompt: charRes.Item.personality_prompt || null,
      ownerId: charRes.Item.owner_id ?? null,
    };
  } catch (e) {
    console.error("[resolveCharacter] error:", e);
    return null;
  }
}

/** resolveCharacter の結果 → 相槌に使う声と人格。null ならずんだもん・人格なし */
export function voiceFor(charConfig) {
  if (!charConfig) return { ...TTS_TABLE[TTS_DEFAULT], voice: "zundamon", personalityPrompt: null };
  const cfg = TTS_TABLE[normalizeModelKey(charConfig.provider) ?? TTS_DEFAULT] ?? TTS_TABLE[TTS_DEFAULT];
  return { ...cfg, voice: charConfig.vendorId ?? null, personalityPrompt: charConfig.personalityPrompt ?? null };
}

// ---- LLM（相槌の一言。Gemini Flash）----
async function generateBackchannel(partialText, personalityPrompt, history = [], pastBackchannels = []) {
  const key = secret("GOOGLE_API_KEY");
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
    `https://generativelanguage.googleapis.com/v1beta/models/${BACKCHANNEL_LLM_MODEL}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: `（話し中）${partialText}` }] }],
        generationConfig: { maxOutputTokens: 20, temperature: 0.9, thinkingConfig: geminiThinkingConfig(BACKCHANNEL_LLM_MODEL) },
      }),
    }
  );
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Gemini failed: ${resp.status} ${errText}`);
  }
  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "うん";
  return {
    text: text.trim(),
    // 原価の計算に使う（本文の LLM と同じ数え方。backend/shared/llm.mjs）
    tokensIn: data?.usageMetadata?.promptTokenCount ?? 0,
    tokensOut: data?.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

/**
 * 相槌1回の原価を usage と台帳に書き、残高から引く（2026-11-28 から。それまではマージンで吸収して記録していなかった）。
 * usage は本文と別の行（並べ替えキーの後ろに #bc）、台帳は source: "backchannel" の consume 1行（ref 無し。会話ログに行が無いため）。
 * 作った時点でかかるので、端末が鳴らさなかった相槌も記録する。失敗しても投げない。
 * @returns {Promise<{ costJpy: number, saved: boolean }|null>} 単価行が無くて計算できなければ null
 */
async function charge({ ownerId, deviceId, client, characterId, llm, tts, pricing }) {
  await pricing;
  const timestamp = new Date().toISOString();
  const date = jstDate(timestamp);  // usage の日付は日本時間（為替の月は UTC。本文と同じ）
  const usdJpyRate = await getExchangeRate(timestamp.slice(0, 7));

  const llmCost = calcCostJpy({ providerApiType: "google#llm", model: BACKCHANNEL_LLM_MODEL, tokensIn: llm.tokensIn, tokensOut: llm.tokensOut, usdJpyRate });
  const ttsCost = calcTtsCost({ vendor: tts.usedVendor, chars: tts.chars, utf8Bytes: tts.utf8Bytes, pcmBytes: tts.pcmBytes, audioTokens: tts.audioTokens, usdJpyRate });
  if (!llmCost && !ttsCost) return null;

  const costJpy = (llmCost?.costJpy ?? 0) + (ttsCost?.costJpy ?? 0);
  const usage = { ownerId, deviceId, date, variant: "bc" };
  const [, , saved] = await Promise.all([
    llmCost && addUsage({ ...usage, apiType: "llm", provider: "google", model: BACKCHANNEL_LLM_MODEL, costJpy: llmCost.costJpy, costUsd: llmCost.costUsd, tokensIn: llm.tokensIn, tokensOut: llm.tokensOut, usdJpyRate: llmCost.usdJpyRate, unitPriceUsd: llmCost.unitPriceUsd, margin: llmCost.margin }),
    ttsCost && addUsage({ ...usage, apiType: "tts", provider: tts.usedVendor, model: tts.usedModel, costJpy: ttsCost.costJpy, costUsd: ttsCost.costUsd, ttsCharacters: tts.chars, usdJpyRate: ttsCost.usdJpyRate, unitPriceUsd: ttsCost.unitPriceUsd, margin: ttsCost.margin }),
    recordConsume({
      ownerId, deviceId, timestamp, source: "backchannel", amountJpy: costJpy,
      // 相槌は書き終わるまで応答を返せない（ESP32 は相槌を受け取ってから本文を頼む）。同じ財布への書き込みと重なったときのやり直しは
      // 2回（合わせて 0.1 秒ほど）までにし、それでも書けなければログに残して返す（警報が拾い、adjust で引く）
      maxRetries: 2,
      detail: {
        client,
        cost_usd: (llmCost?.costUsd ?? 0) + (ttsCost?.costUsd ?? 0),
        cost_llm: llmCost?.costJpy ?? 0, llm_provider: "google", llm_model: BACKCHANNEL_LLM_MODEL,
        llm_tokens_in: llm.tokensIn, llm_tokens_out: llm.tokensOut,
        cost_tts: ttsCost?.costJpy ?? 0, tts_provider: tts.vendor, tts_chars: tts.chars,
        tts_fallback: tts.usedVendor !== tts.vendor ? { from: tts.vendor, to: tts.usedVendor, chars: tts.chars } : null,
        character_id: characterId ?? "default",
      },
    }),
  ]);
  return { costJpy, saved };
}

/**
 * 相槌を1つ作る。失敗は投げる（呼ぶ側が 500 で返す）。
 * @param {object} p
 * @param {object} p.trace             startTrace("backchannel") の戻り値
 * @param {"app"|"esp"} p.client       台帳の行に残す出どころ
 * @param {string} p.partialText       聞こえている断片
 * @param {object[]} p.history         直前の会話（{ role, content }）
 * @param {string[]} p.pastBackchannels 過去に使った相槌
 * @param {object|null} p.charConfig   resolveCharacter の結果。null ならずんだもん・人格なし
 * @param {string|null} p.characterId  台帳の行に残す
 * @param {object} [p.ttsOptions]      tts-pcm.mjs の options（Google の速さ・高さ、Gemini のやり直し回数と指示文）
 * @param {string|null} p.ownerId      持ち主。分からなければ原価は記録しない（RnD でトークン無しのアプリ、未登録の本体）
 * @param {string|null} p.deviceId     機器。App は "app"
 * @returns {Promise<{ text: string, pcm: Buffer }>} pcm は 24kHz・モノラル・16bit
 */
export async function runBackchannel({ trace, client, partialText, history, pastBackchannels, charConfig, characterId, ttsOptions, ownerId, deviceId }) {
  const { ttsVendor, ttsModel, voice, personalityPrompt } = voiceFor(charConfig);
  trace.set({ tts: ttsVendor, voice: voice ?? "default", has_personality: !!personalityPrompt });
  trace.mark("config");

  const billable = Boolean(ownerId && deviceId);
  // 単価は LLM を待つ間に読んでおく（キャッシュが温かければ何もしない）
  const pricing = billable ? loadPricingCache() : null;

  const llm = await generateBackchannel(partialText, personalityPrompt, history, pastBackchannels);
  trace.mark("llm_done");
  trace.set({ reply_chars: llm.text.length });

  let usedVendor = ttsVendor, usedModel = ttsModel, out;
  try {
    out = await synthesizePcmBuffer({ vendor: ttsVendor, model: ttsModel, voice, text: llm.text, options: ttsOptions });
  } catch (e) {
    // 主プロバイダーが失敗（同時接続上限など）したら即ずんだもん。相槌は短いので再試行しない
    if (ttsVendor === FALLBACK.ttsVendor) throw e;
    trace.ext(ttsVendor, { status: errorStatus(e), error: true });
    trace.error("tts_primary", e); // この後ずんだもんへ切り替える
    trace.set({ tts_fallback: FALLBACK.ttsVendor });
    usedVendor = FALLBACK.ttsVendor; usedModel = FALLBACK.voice;
    out = await synthesizePcmBuffer({ vendor: FALLBACK.ttsVendor, model: FALLBACK.ttsModel, voice: FALLBACK.voice, text: llm.text });
  }
  trace.mark("tts_done");

  if (billable) {
    const charged = await charge({
      ownerId, deviceId, client, characterId, llm, pricing,
      tts: { vendor: ttsVendor, usedVendor, usedModel, chars: llm.text.length, utf8Bytes: Buffer.byteLength(llm.text, "utf8"), pcmBytes: out.pcm.length, audioTokens: out.audioTokens },
    }).catch((e) => { trace.error("charge", e); return null; });
    trace.mark("usage_saved");
    // 金額と、台帳に書けたか。Gemini の声は音声トークン数も（原価の概算を実際の値と見比べられるように）
    trace.set({ cost_jpy: charged ? Number(charged.costJpy.toFixed(5)) : null, charged: charged?.saved ?? false, ...(out.audioTokens ? { tts_audio_tokens: out.audioTokens } : {}) });
  } else {
    trace.set({ charged: false });
  }

  return { text: llm.text, pcm: out.pcm };
}
