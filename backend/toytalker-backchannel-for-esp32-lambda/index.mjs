// Node.js 18+ / ESM（index.mjs）
// Handler: index.handler
// ESP32向け相槌Lambda: raw PCMバイナリをレスポンスボディで返す
// ヘッダ X-Backchannel-Text に相槌テキストを格納
// ここにあるのは入口だけ（要求の読み方・登録済み機器の門とデバイス鍵・残高の確認・出力の形）。相槌の本体は backend/shared/backchannel.mjs
// Env: ZAKICORP_TTS_URL, CARTESIA_DEFAULT_VOICE_ID (任意: CARTESIA_LANGUAGE 既定 "ja")。鍵は SSM（backend/shared/secrets.mjs）
import { Agent, setGlobalDispatcher } from "undici";
import { ensureSecrets } from "../shared/secrets.mjs";
import { startTrace, describeClient } from "../shared/trace.mjs";
import { checkDeviceKey, deviceGate, loadDeviceRow } from "../shared/auth.mjs";
import { checkBalance, NO_BALANCE } from "../shared/wallet.mjs";
import { resolveCharacter, runBackchannel } from "../shared/backchannel.mjs";
import { trimSilence } from "../shared/tts-pcm.mjs";
import { prewarmSpareInstance } from "../shared/warm.mjs";

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

// TTS の頼み方のうち ESP32 用だけの値（backend/shared/tts-pcm.mjs の options）。Google は少し速く高く、Gemini は文だけを渡す。
// Gemini は空の音声を返すことがあるのでやり直すが、相槌は遅れると意味が無いので1回だけ
const TTS_OPTIONS = { google: { speakingRate: 1.2, pitch: 3.0 }, gemini: { attempts: 2, readAloudPrompt: false } };

const json = (statusCode, body) => ({ statusCode, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// ---- Handler (BUFFEREDモード - isBase64Encodedでバイナリ返却) ----
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
    prewarmSpareInstance();  // 処理中に予備インスタンスを温める（同時2人目対策）
    prewarmConnections();    // LLM/TTS接続を先行確立（keep-alive切れ時の保険、非同期）
    const partialText = body.partial_text ?? "";
    const deviceId = body.device_id ?? null;
    const history = Array.isArray(body.history) ? body.history.slice(-6) : [];
    const pastBackchannels = Array.isArray(body.past_backchannels) ? body.past_backchannels.slice(-10) : [];
    trace.set({ source: "esp", device_id: deviceId, character_id: body.character_id ?? null, partial_chars: partialText.length, history_turns: history.length, ...describeClient(event, body) });

    if (!partialText) {
      return { statusCode: 400, body: JSON.stringify({ error: "partial_text is required" }) };
    }

    // ESP32 はログインしない。本番（AUTH_REQUIRED）では devices テーブルに登録済みの機器だけ通す（docs/auth.md）。
    // DynamoDB の失敗（null）は従来どおり続ける
    const loaded = deviceId ? await loadDeviceRow(deviceId) : { device: null };
    const deviceRow = loaded?.device ?? null;
    if (loaded && !deviceRow) {
      const gate = deviceGate(null);
      if (gate) {
        trace.set({ status: gate.statusCode, reason: gate.error });
        return json(gate.statusCode, { error: gate.error });
      }
    }
    // デバイス鍵（なりすまし防止。backend/shared/auth.mjs の checkDeviceKey）。行がある機器だけ照合する
    if (deviceRow) {
      const key = await checkDeviceKey(event, deviceRow);
      trace.set(key.log);
      if (key.gate) {
        trace.set({ status: key.gate.statusCode, reason: key.gate.error });
        return json(key.gate.statusCode, { error: key.gate.error });
      }
    }
    // 持ち主は機器の行で決まる。残高と、キャラクター（声・人格）は並べて読む（順に読むと DynamoDB 3往復、並べると2往復ぶん。
    // 相槌の最後に原価を書く1往復が増えた分をここで取り返す。docs/pricing-and-cost-model.md 11.3）。
    // 門（未登録機・デバイス鍵）を通ってから始めるので、拒否で返るときに読みかけの要求は残らない
    const ownerId = deviceRow?.owner_id ?? null;
    if (ownerId) trace.set({ owner_id: ownerId });
    // キャラクターは機器の行のものが優先、無ければ要求の character_id。どちらも無い・読めないときはずんだもん・人格なし（resolveCharacter は投げない）
    const characterPromise = (async () => {
      let characterId = deviceRow?.character_id ?? null;
      let charConfig = characterId ? await resolveCharacter(characterId) : null;
      if (!charConfig && body.character_id) {
        characterId = body.character_id;
        charConfig = await resolveCharacter(characterId);
      }
      return { characterId, charConfig };
    })();
    const [balance, { characterId, charConfig }] = await Promise.all([checkBalance(ownerId), characterPromise]);
    // 残高0なら相槌も返さない（本文が止める旨をしゃべる）。ファームは200以外を捨てる
    if (!balance.ok) {
      trace.set({ status: 402, reason: NO_BALANCE });
      return json(402, { error: NO_BALANCE });
    }

    const { text, pcm: rawPcm } = await runBackchannel({
      trace, client: "esp", partialText, history, pastBackchannels, charConfig, characterId, ttsOptions: TTS_OPTIONS,
      ownerId, deviceId,
    });
    const pcmBuffer = trimSilence(rawPcm);
    trace.set({ pcm_bytes: pcmBuffer.length, trim_ms: Math.round((rawPcm.length - pcmBuffer.length) / 48) });

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/octet-stream",
        "X-Backchannel-Text": encodeURIComponent(text),
        "X-Pcm-Length": String(pcmBuffer.length),
        "X-Latency-Ms": String(Date.now() - start),
      },
      body: pcmBuffer.toString("base64"),
      isBase64Encoded: true,
    };
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
