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
 * 前のターンをクライアントが受け取って鳴らしたか（2026-11-08）。本文要求の body.prev_turn。
 * サーバーのログは「送り終えた」までしか分からない（2026-11-07 15:01、返答を送り切ったのにアプリは無反応）ので、
 * クライアントが次の要求に前のターンの結果を添え、ここで同名の項目として載せる。文章は入れない。
 * 項目はアプリ（app/app/(tabs)/chat.tsx の TurnStats）と同じ。ESP32 も同じ名前で送れる。知らない項目は捨てる。
 *   request_at: 前のターンの request_at（その turn ログと結びつける）
 *   attempts / segments / tts / played / play_failed / stalls: 回数（試行、受けた文、受けた音声、鳴らし終えた音声、再生失敗、再生の見張りが動いた回数）
 *   done / loaded / bc_received / bc_played / bc_error: 真偽（done を受けた、受信完了、相槌を受けた、相槌を鳴らした、相槌の取得失敗）
 *   error: network / timeout / http:<status> / parse（無ければ null）
 */
export function describePrevTurn(prev) {
  if (!prev || typeof prev !== "object") return null;
  const out = {};
  for (const k of ["request_at", "error"]) out[k] = typeof prev[k] === "string" ? prev[k].slice(0, 32) : null;
  for (const k of ["attempts", "segments", "tts", "played", "play_failed", "stalls"]) {
    out[k] = Number.isFinite(prev[k]) ? Math.max(0, Math.min(9999, Math.trunc(prev[k]))) : null;
  }
  for (const k of ["done", "loaded", "bc_received", "bc_played", "bc_error"]) out[k] = typeof prev[k] === "boolean" ? prev[k] : null;
  return out;
}

/**
 * ESP32 本体の状態と計測（2026-11-08、ロードマップ6）。本文要求の body.device（ファームの PowerSense.h と TurnReport.h）。
 * 文章は入らない数値と決まった語だけ。知らない項目は捨て、範囲外の値は null にする。
 *   vbat_mv: 電池電圧（mV、未校正。電池なしなら 0 付近）
 *   board_temp_c / chip_temp_c: 基板温度（サーミスタ TH2）/ ESP32 内蔵の温度（℃。読めなければ null）
 *   chg_stat1 / chg_stat2: 充電IC BQ25185 の STAT1/STAT2 のピンの値（1=High, 0=Low）。意味の割り当ては未確認なのでそのまま
 *   rssi / heap_free / heap_min / max_blk / psram_free / uptime_s: 要求時の電波（dBm）、内部RAMの空き・起動以来の最低・最大の連続領域、
 *     PSRAM の空き（バイト）、起動からの秒（小さければ再起動の直後で、prev は無い）
 *   prev: 前のターン（0.7.7 から）。時刻はそのターンの開始（本体が送信を決めた時）からの ms、0 は「起きなかった」。
 *     stop: done / aec / button / stream_error / connect_failed / i2s_failed
 *     pre_ms → tls_ms → send_ms → headers_ms → first_audio_ms → play_start_ms → recv_end_ms → play_end_ms、barge_ms（割り込みの判定）
 *     audio_ms（受けた音声の長さ）/ unplayed_ms（止めたとき鳴らしていなかった分）/ underruns / segments / bc / rssi_avg / rssi_min / ws_max_block_ms
 *     aec_*: 声の割り込み判定の材料（AC RMS）。aec_out_sustained < aec_threshold なら、4フレーム続けてしきい値を超えた場面が無い
 *   stt: この要求の発話の聞き取り（0.7.7 から）。時刻は録音開始からの ms。
 *     ws_wait_ms / listen_ms / last_text_to_end_ms（Soniox の話し終わり判定の待ち）/ end_to_send_ms（猶予）/ resumes /
 *     speech_peak_rms / grace_peak_rms / disconnects / errors / why（quiet / no new text / stall / no grace）
 */
const DEVICE_PREV_MS = [
  "pre_ms", "tls_ms", "send_ms", "headers_ms", "first_audio_ms", "play_start_ms", "recv_end_ms", "play_end_ms",
  "barge_ms", "audio_ms", "unplayed_ms", "ws_max_block_ms", "aec_confirm_ms",
];
const DEVICE_PREV_COUNTS = [
  "turn", "underruns", "segments",
  "aec_threshold", "aec_armed_frames", "aec_out_peak", "aec_out_sustained", "aec_mic_sustained",
  "aec_residual_rejects", "aec_clip_frames", "aec_recovery_frames", "aec_age_rejects", "aec_missing",
  "aec_trigger_out", "aec_trigger_mic", "aec_ref_peak", "aec_trigger_ref",
  // 発火後の確かめ（ファーム 0.7.9）
  "aec_triggers", "aec_confirm_rejects", "aec_confirm_voice_frames", "aec_confirm_mic_max",
];
const DEVICE_PREV_FLAGS = ["tls_ok", "bc", "aec_fired", "aec_confirm_timeout"];
const DEVICE_PREV_STOPS = ["done", "aec", "button", "stream_error", "connect_failed", "i2s_failed"];
const DEVICE_STT_MS = ["ws_wait_ms", "listen_ms", "last_text_to_end_ms", "end_to_send_ms"];
const DEVICE_STT_COUNTS = ["resumes", "speech_peak_rms", "grace_peak_rms", "disconnects", "errors"];
const DEVICE_STT_WHY = ["quiet", "no new text", "stall", "no grace"];
const DAY_MS = 24 * 3600 * 1000;

export function describeDevice(dev) {
  if (!dev || typeof dev !== "object") return null;
  const num = (v, min, max, digits = 0) => {
    if (!Number.isFinite(v) || v < min || v > max) return null;
    const p = 10 ** digits;
    return Math.round(v * p) / p;
  };
  const oneOf = (v, list) => (list.includes(v) ? v : null);
  const flag = (v) => (v === 0 || v === 1 ? v : null);
  const out = {
    vbat_mv: num(dev.vbat_mv, 0, 10000),
    board_temp_c: num(dev.board_temp_c, -40, 150, 1),
    chip_temp_c: num(dev.chip_temp_c, -40, 150, 1),
    chg_stat1: flag(dev.chg_stat1),
    chg_stat2: flag(dev.chg_stat2),
    rssi: num(dev.rssi, -127, 0),
    heap_free: num(dev.heap_free, 0, 64 * 1024 * 1024),
    heap_min: num(dev.heap_min, 0, 64 * 1024 * 1024),
    max_blk: num(dev.max_blk, 0, 64 * 1024 * 1024),
    psram_free: num(dev.psram_free, 0, 64 * 1024 * 1024),
    uptime_s: num(dev.uptime_s, 0, 10 * 365 * 24 * 3600),
  };
  const prev = dev.prev;
  if (prev && typeof prev === "object") {
    const p = { stop: oneOf(prev.stop, DEVICE_PREV_STOPS) };
    for (const k of DEVICE_PREV_MS) p[k] = num(prev[k], 0, DAY_MS);
    for (const k of DEVICE_PREV_COUNTS) p[k] = num(prev[k], 0, 0xffffffff);
    for (const k of DEVICE_PREV_FLAGS) p[k] = flag(prev[k]);
    p.rssi_avg = num(prev.rssi_avg, -127, 0);
    p.rssi_min = num(prev.rssi_min, -127, 0);
    p.aec_retained_pct = num(prev.aec_retained_pct, 0, 100000, 1);
    out.prev = p;
  }
  const stt = dev.stt;
  if (stt && typeof stt === "object") {
    const s = { why: oneOf(stt.why, DEVICE_STT_WHY) };
    for (const k of DEVICE_STT_MS) s[k] = num(stt[k], 0, DAY_MS);
    for (const k of DEVICE_STT_COUNTS) s[k] = num(stt[k], 0, 0xffffffff);
    out.stt = s;
  }
  return out;
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
