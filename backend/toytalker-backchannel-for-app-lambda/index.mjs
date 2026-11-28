// Node.js 18+ / ESM（index.mjs）
// Handler: index.handler
// App向け相槌Lambda: WAV の base64 を JSON で返す。
// ここにあるのは入口だけ（要求の読み方・本人確認・残高の確認・出力の形）。相槌の本体は backend/shared/backchannel.mjs
// Env: ZAKICORP_TTS_URL, CARTESIA_DEFAULT_VOICE_ID (任意: CARTESIA_LANGUAGE 既定 "ja")。鍵は SSM（backend/shared/secrets.mjs）
import { ensureSecrets } from "../shared/secrets.mjs";
import { startTrace, describeClient } from "../shared/trace.mjs";
import { authenticate, authGate, describeAuth, lookupOwner, canUse } from "../shared/auth.mjs";
import { checkBalance, NO_BALANCE } from "../shared/wallet.mjs";
import { resolveCharacter, runBackchannel } from "../shared/backchannel.mjs";
import { pcmToWav } from "../shared/tts-pcm.mjs";
import { prewarmSpareInstance } from "../shared/warm.mjs";

// TTS の頼み方のうち App 用だけの値（backend/shared/tts-pcm.mjs の options）。Google は素の速さ・高さ、Gemini は「読み上げて」の指示文つき。
// Gemini は空の音声を返すことがあるのでやり直すが、相槌は遅れると意味が無いので1回だけ
const TTS_OPTIONS = { google: { speakingRate: 1.0, pitch: 0 }, gemini: { attempts: 2, readAloudPrompt: true } };

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---- Handler ----
export const handler = async (event, context) => {
  const start = Date.now();
  // 切り分け用のログ。1リクエスト1行のJSONで、聞こえた断片も相槌の文章も書かない（backend/shared/trace.mjs）
  let trace = null;
  try {
    await ensureSecrets();
    const body = event.body ? JSON.parse(event.body) : {};
    if (body.warmup) return { statusCode: 200, body: "warm" };  // EventBridgeウォームアップping
    trace = startTrace("backchannel", { event, context, t0: start });
    trace.mark("secrets");
    trace.set(describeClient(event, body)); // 拒否するときもログに出どころを残す
    // 本人確認（backend/shared/auth.mjs、docs/auth.md）。本番はトークン必須、RnD はトークン無しも通す
    const identity = await authenticate(event);
    trace.set(describeAuth(identity));
    const denied = authGate(identity);
    if (denied) {
      trace.set({ status: denied.statusCode, reason: denied.error });
      return json(denied.statusCode, { error: denied.error });
    }
    prewarmSpareInstance();  // 処理中に予備インスタンスを温める（同時2人目対策）
    const partialText = body.partial_text ?? "";
    const characterId = body.character_id ?? null;
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
    const pastBackchannels = Array.isArray(body.past_backchannels) ? body.past_backchannels.slice(-10) : [];
    trace.set({ source: "app", character_id: characterId, partial_chars: partialText.length, history_turns: history.length, ...describeClient(event, body) });

    if (!partialText) {
      return { statusCode: 400, body: JSON.stringify({ error: "partial_text is required" }) };
    }

    // 持ち主と残高、キャラクター（声・人格）は並べて読む（順に読むと DynamoDB 4往復、並べると2往復ぶん。
    // 相槌の最後に原価を書く1往復が増えた分をここで取り返す。docs/pricing-and-cost-model.md 11.3）。
    // 断るときもキャラクターの読み込みは走るが、読むだけなので害は無い
    // 持ち主: ログイン中は users テーブルの行（自称は使わない）、RnD でトークン無しのときだけ要求の owner_id（本文Lambdaと同じ）
    const ownerAndBalance = (async () => {
      const who = await lookupOwner(identity, body.owner_id);
      return { who, balanceOk: who.ownerId ? (await checkBalance(who.ownerId)).ok : true };
    })();
    // キャラクターが無い・読めないときはずんだもん・人格なし（resolveCharacter は投げない）
    const [{ who, balanceOk }, charConfig] = await Promise.all([ownerAndBalance, characterId ? resolveCharacter(characterId) : null]);
    if (who.ownerId) trace.set({ owner_id: who.ownerId });
    // 残高0なら相槌も返さない（本文が止める）
    if (!balanceOk) {
      trace.set({ status: 402, reason: NO_BALANCE });
      return json(402, { error: NO_BALANCE });
    }
    // 他人のキャラクター（声・人格）は使えない。本文Lambdaと同じ判定（system 製は誰でも）
    if (charConfig && !canUse(identity, who.ownerId, charConfig.ownerId)) {
      trace.set({ status: 403, reason: "not_owner" });
      return json(403, { error: "not_owner" });
    }

    const { text, pcm } = await runBackchannel({
      trace, client: "app", partialText, history, pastBackchannels, charConfig, characterId, ttsOptions: TTS_OPTIONS,
      ownerId: who.ownerId, deviceId: typeof body.device_id === "string" && body.device_id ? body.device_id : "app",
    });
    const audioBase64 = pcmToWav(pcm).toString("base64");
    trace.set({ audio_bytes: pcm.length + 44 });

    return json(200, { text, audio: audioBase64, format: "wav", latency_ms: Date.now() - start });
  } catch (err) {
    if (trace) trace.error("handler", err); else console.error("[backchannel] failed before trace:", err?.name, err?.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  } finally {
    trace?.finish();
  }
};
