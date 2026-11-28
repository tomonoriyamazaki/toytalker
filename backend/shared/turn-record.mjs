// 本文1ターンの終わりの記録（App 用・ESP32 用の本文 Lambda が同じものを使う。ロードマップ50）。
//
//   原価の計算（LLM・TTS・ずんだもんへ切り替えた分・STT・有料ツール）→ usage → 会話ログ（返答の行）→ 台帳（残高から引く）
//
// 応答の最後（done を送った後）に呼び、書き終わるのを待ってから応答を閉じる（閉じた後は Lambda が止まり、待っていない書き込みは消える）。
// どれかが失敗しても投げない（会話は返し終わっている。台帳に書けなかったときは wallet.mjs がログに残し、警報が拾う）。
// 相槌の記録は backend/shared/backchannel.mjs、読み上げは読み上げ Lambda の trackTtsCost。
import { jstDate } from "./jst.mjs";
import { PAID_TOOLS } from "./llm.mjs";
import { loadPricingCache, getExchangeRate, calcCostJpy, calcTtsCost, addUsage } from "./cost.mjs";
import { saveChatLog } from "./chat-log.mjs";
import { recordConsume } from "./wallet.mjs";

/**
 * @param {object} p
 * @param {"app"|"esp"} p.source
 * @param {string} p.ownerId
 * @param {string} p.deviceId
 * @param {string} p.sessionId
 * @param {string|null} p.characterId
 * @param {string} p.voice            声（toytalker-voices の vendor_id）。会話ログに残す
 * @param {string} p.text             返答の全文（会話ログ用。空なら会話ログは書かない）
 * @param {boolean} p.chatLog         会話の文章を残すか（backend/shared/chat-log.mjs の chatLogEnabled）
 * @param {string|null} p.sttProvider 会話ログの stt_provider（ESP32 は "soniox"、App は null）
 * @param {number} p.durationMs       要求を受けてからの時間（会話ログ用）
 * @param {{ provider: string, model: string, tokensIn: number, tokensOut: number }} p.llm
 * @param {{ vendor: string, model: string, chars: number, fallbackChars: number, pcmBytes?: number, audioTokens?: number }} p.tts
 *        chars は主の声で読んだ文字数、fallbackChars はずんだもんで読んだ文字数（Sakura の分として別に数える）
 * @param {number} p.userMsgChars     利用者の発話の文字数（STT の原価の概算に使う）
 * @param {Record<string, number>} p.toolCalls ツール名 → 成功回数。PAID_TOOLS に載っているものだけ記録する
 */
export async function recordTurn({ source, ownerId, deviceId, sessionId, characterId, voice, text, chatLog, sttProvider, durationMs, llm, tts, userMsgChars, toolCalls }) {
  const timestamp = new Date().toISOString();
  await loadPricingCache();
  const date = jstDate(timestamp);  // usage の日付は日本時間（為替の月は従来どおり UTC）
  const usdJpyRate = await getExchangeRate(timestamp.slice(0, 7));
  const row = { ownerId, deviceId, date };
  const priced = (c) => ({ costJpy: c.costJpy, costUsd: c.costUsd, usdJpyRate: c.usdJpyRate, unitPriceUsd: c.unitPriceUsd, margin: c.margin });

  const llmCost = calcCostJpy({ providerApiType: `${llm.provider}#llm`, model: llm.model, tokensIn: llm.tokensIn, tokensOut: llm.tokensOut, usdJpyRate });
  // 声の会社ごとの数え方は cost.mjs の calcTtsCost
  const ttsCost = calcTtsCost({ vendor: tts.vendor, chars: tts.chars, utf8Bytes: Buffer.byteLength(text.trim(), "utf8"), pcmBytes: tts.pcmBytes, audioTokens: tts.audioTokens, usdJpyRate });
  // フォールバック（ずんだもん）で生成した分は Sakura として記録
  const fallbackCost = tts.fallbackChars > 0 ? calcTtsCost({ vendor: "sakura", chars: tts.fallbackChars, usdJpyRate }) : null;
  // STT（確定文の文字数から概算）
  const sttCost = userMsgChars > 0 ? calcCostJpy({ providerApiType: "soniox#stt", userMessageChars: userMsgChars, usdJpyRate }) : null;
  // ツール（外部の有料APIを呼ぶものだけ回数課金で記録。無料ツールはLLMトークンに含まれる）
  const tools = [];
  for (const [toolName, count] of Object.entries(toolCalls ?? {})) {
    const paid = PAID_TOOLS[toolName];
    if (!paid || count <= 0) continue;
    const c = calcCostJpy({ providerApiType: `${paid.provider}#tool`, requests: count, usdJpyRate });
    if (c) tools.push({ toolName, count, paid, c });
  }
  const toolCostJpy = tools.reduce((sum, t) => sum + t.c.costJpy, 0);
  const toolCostUsd = tools.reduce((sum, t) => sum + t.c.costUsd, 0);

  // usage は種別ごとに別の行なので並べて書く。TTS の2つ（主の声とずんだもん）は同じ行なので順に書く（provider は最後に書いた値が残る）
  await Promise.all([
    llmCost && addUsage({ ...row, apiType: "llm", provider: llm.provider, model: llm.model, tokensIn: llm.tokensIn, tokensOut: llm.tokensOut, ...priced(llmCost) }),
    (async () => {
      if (ttsCost) await addUsage({ ...row, apiType: "tts", provider: tts.vendor, model: tts.model, ttsCharacters: tts.chars, ...priced(ttsCost) });
      if (fallbackCost) await addUsage({ ...row, apiType: "tts", provider: "sakura", model: "zundamon", ttsCharacters: tts.fallbackChars, ...priced(fallbackCost) });
    })(),
    sttCost && addUsage({ ...row, apiType: "stt", provider: "soniox", model: "soniox", sttCharacters: userMsgChars, ...priced(sttCost) }),
    // ツールは種類が違っても同じ行なので順に書く
    (async () => {
      for (const t of tools) await addUsage({ ...row, apiType: "tool", provider: t.paid.provider, model: t.paid.model, requestCount: t.count, ...priced(t.c) });
    })(),
  ]);

  // 会話ログ（文章だけ。原価は台帳）
  const ref = `session_id#${sessionId}#timestamp#${timestamp}`;
  if (chatLog && text.trim()) await saveChatLog({
    "owner_id#device_id":   `owner_id#${ownerId}#device_id#${deviceId}`,
    "session_id#timestamp": ref,
    owner_id: ownerId, device_id: deviceId, source,
    role: "assistant", content: text.trim(),
    content_type: "text", timestamp, session_id: sessionId,
    llm_provider: llm.provider, llm_model: llm.model,
    tts_provider: tts.vendor, stt_provider: sttProvider,
    duration_ms: durationMs,
    character_id: characterId ?? "default",
    voice_id: voice,
  });

  // 1ターンの原価は台帳に書き、残高から引く（chat-logs には文章だけ。docs/pricing-and-cost-model.md 11.6）
  const costTts = (ttsCost?.costJpy ?? 0) + (fallbackCost?.costJpy ?? 0);
  await recordConsume({
    ownerId, deviceId, timestamp, source,
    amountJpy: (sttCost?.costJpy ?? 0) + (llmCost?.costJpy ?? 0) + costTts + toolCostJpy,
    detail: {
      ref, session_id: sessionId,
      cost_usd: (sttCost?.costUsd ?? 0) + (llmCost?.costUsd ?? 0) + (ttsCost?.costUsd ?? 0) + (fallbackCost?.costUsd ?? 0) + toolCostUsd,
      cost_stt: sttCost?.costJpy ?? 0, stt_chars: userMsgChars,
      cost_llm: llmCost?.costJpy ?? 0, llm_provider: llm.provider, llm_model: llm.model,
      llm_tokens_in: llm.tokensIn, llm_tokens_out: llm.tokensOut,
      cost_tts: costTts, tts_provider: tts.vendor, tts_chars: tts.chars,
      tts_fallback: tts.fallbackChars > 0 ? { from: tts.vendor, to: "sakura", chars: tts.fallbackChars } : null,
      cost_tool: toolCostJpy, tool_usage: tools.map((t) => ({ tool: t.toolName, provider: t.paid.provider, requests: t.count, cost: t.c.costJpy })),
      character_id: characterId ?? "default",
    },
  });
}
