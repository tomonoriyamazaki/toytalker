// Lambdaログの切り分け情報。全Lambda共通で、esbuildが各バンドルへ取り込む。
//
// 方針（docs/roadmap.md の9、2026-10-27決定）:
//   - 会話の文章（発話・返答・検索語・相槌）はログに書かない。正本は DynamoDB `chat-logs`。
//   - 代わりに「どの段階で何秒止まったか」をログだけで追えるよう、1リクエストにつき1行のJSONを出す。
//     識別子（リクエストID・会話ID・デバイスID・所有者ID）、どこから来たか（App/ESP32、ファーム版、アプリ版、User-Agent）、
//     段階ごとの経過時刻（marks）、外部サービス呼び出しの応答コードと所要時間（ext）、TTSセグメントごとの時刻（segments）、
//     エラー（errors）、合計所要時間。
//   - CloudWatch Logs Insights は JSON を自動で項目に分けるので、`filter kind = "turn" and total_ms > 5000` のように引ける。
//
// 使い方:
//   const trace = startTrace("turn", { event, context, t0 });   // t0 は handler 先頭の Date.now()（鍵の取得時間も含めるため）
//   trace.set({ session_id, device_id });                        // 識別子や設定（文章は入れない）
//   trace.mark("llm_first_token");                               // 段階の経過時刻。同じ名前は最初の1回だけ記録
//   trace.ext("openai", { status: 200, ms: 812 });               // 外部サービスの応答
//   trace.segment({ id: 1, chars: 12, ... });                    // TTSセグメント1つ分
//   trace.error("tts", err);                                     // エラー（メッセージは短く切る。文章が混ざる可能性があるため）
//   trace.finish({ llm_tokens_in: 120 });                        // 最後に1回。JSON 1行を console.log する

const MODULE_LOADED_AT = Date.now();
const ERROR_MESSAGE_MAX = 160;

/** エラーからHTTPの応答コードを拾う（`e.status`、または "Cartesia TTS failed: 429 ..." のようなメッセージ） */
export function errorStatus(e) {
  if (typeof e?.status === "number") return e.status;
  const m = /\b([45]\d{2})\b/.exec(String(e?.message || ""));
  return m ? Number(m[1]) : null;
}

/** エラーメッセージの先頭だけ。外部サービスのエラー本文が入力文を含むことがあるので長くは残さない */
export function shortMessage(e) {
  const s = String(e?.message ?? e ?? "");
  return s.length > ERROR_MESSAGE_MAX ? `${s.slice(0, ERROR_MESSAGE_MAX)}…` : s;
}

/**
 * 要求が通った経路（ロードマップ3、2026-10-29）。
 *   edge:    "cloudfront"（固定ドメイン api-<環境>.zakicorp.com 経由）| "direct"（Function URL を直接呼ぶ旧ファーム・旧アプリ）
 *   country: CloudFront-Viewer-Country の国コード（ISO 3166-1 alpha-2）。direct のときは null
 * 送信元IP（requestContext.http.sourceIp）は個人に結びつくので書かない（2026-10-28決定）。国だけなら誰かを特定できない。
 * "direct" が無くなったら Function URL を IAM 認証に切り替える（infra/config/stages.ts の directFunctionUrls）。
 */
export function describeEdge(event) {
  const headers = event?.headers ?? {};
  const country = typeof headers["cloudfront-viewer-country"] === "string" ? headers["cloudfront-viewer-country"].slice(0, 2) : null;
  return { edge: country ? "cloudfront" : "direct", country };
}

/**
 * リクエストの出どころ。本文の fw（ESP32ファーム版）/ app_version（アプリ版）と User-Agent、経路と国（describeEdge）。
 */
export function describeClient(event, body) {
  const headers = event?.headers ?? {};
  const ua = headers["user-agent"] ?? headers["User-Agent"] ?? null;
  const fw = typeof body?.fw === "string" ? body.fw.slice(0, 32) : null;
  const appVersion = typeof body?.app_version === "string" ? body.app_version.slice(0, 32) : null;
  return { fw, app_version: appVersion, ua, ...describeEdge(event) };
}

/**
 * @param {string} kind  "turn"（本文）| "backchannel"（相槌）| "stt-token"（Soniox鍵）| "read-aloud"（読み上げ）
 * @param {{ event?: object, context?: object, t0?: number }} p
 */
export function startTrace(kind, { event, context, t0 } = {}) {
  const start = t0 ?? Date.now();
  const rec = {
    kind,
    request_id: context?.awsRequestId ?? event?.requestContext?.requestId ?? null,
    // 容器が起きてからの秒数。小さければコールドスタート直後（温めpingで起きた容器も含む）
    container_age_s: Math.round((start - MODULE_LOADED_AT) / 1000),
  };
  const marks = {};
  const ext = [];
  const segments = [];
  const errors = [];
  let finished = false;

  const elapsed = () => Date.now() - start;

  const trace = {
    /** 開始からの経過ミリ秒 */
    elapsed,
    /** 識別子や設定を足す（文章は入れない） */
    set(fields) {
      for (const [k, v] of Object.entries(fields ?? {})) if (v !== undefined) rec[k] = v;
      return trace;
    },
    /** 段階の経過時刻（ms）。同じ名前は最初の1回だけ */
    mark(name) {
      if (!(name in marks)) marks[name] = elapsed();
      return marks[name];
    },
    /** 外部サービス呼び出し1回分。service は "openai" / "brave" / "soniox" / "dynamodb" など */
    ext(service, info) {
      ext.push({ service, at: elapsed(), ...info });
    },
    /** TTSセグメント1つ分（本文Lambdaが使う） */
    segment(info) {
      segments.push(info);
    },
    /** エラー。その場でも console.error に出す（JSON 1行が出る前に落ちたときのため） */
    error(where, e) {
      const entry = { where, at: elapsed(), name: e?.name ?? null, status: errorStatus(e), message: shortMessage(e) };
      errors.push(entry);
      console.error(`[${kind}] ${where} failed:`, entry.name ?? "", entry.status ?? "", entry.message);
    },
    /** 最後に1回。例外で抜けた経路からも呼べるよう、2回目以降は何もしない */
    finish(extra) {
      if (finished) return;
      finished = true;
      const out = { ...rec, ...(extra ?? {}), total_ms: elapsed(), marks, ext, errors };
      if (segments.length > 0) out.segments = segments;
      console.log(JSON.stringify(out));
    },
  };
  return trace;
}
