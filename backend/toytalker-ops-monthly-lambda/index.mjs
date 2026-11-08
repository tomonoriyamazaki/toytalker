// Node.js 18+ / ESM（index.mjs）
// Handler: index.handler
// 用途: 月1回の運用まとめ。為替の取得・保存、先月の記録実費の集計、各社請求との突き合わせ、
//       単価行の点検、前払いポイントの残高合計（資金決済法の基準日 3月末・9月末の目安）を行い、結果を1通のメール（SNS）で送る。
//       値の自動修正はしない。
// 起動: EventBridge Scheduler（毎月1日 09:00 JST）。手動実行時は event で対象月・送信有無を指定できる。
// Event: { month?: "YYYY-MM"（集計対象月。既定は先月）, send?: boolean（既定true）, fx?: boolean（既定true） }
// Env: OPS_SNS_TOPIC_ARN（必須）, FX_OVERWRITE（"true"で既存の為替行も上書き。既定は無い月だけ作成）,
//      STALE_PRICE_DAYS（既定180）, OPENAI_ADMIN_KEY / ANTHROPIC_ADMIN_KEY / ELEVENLABS_API_KEY（任意。あれば各社の実績を取得）
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { CloudWatchLogsClient, StartQueryCommand, GetQueryResultsCommand, StopQueryCommand } from "@aws-sdk/client-cloudwatch-logs";
import { ensureSecrets, secret } from "../shared/secrets.mjs";
import { tableName } from "../shared/tables.mjs";
import { listWallets, describeWallet } from "../shared/wallet.mjs";

const REGION = "ap-northeast-1";
const ddb  = DynamoDBDocumentClient.from(new DynamoDBClient({ region: REGION }));
const sns  = new SNSClient({ region: REGION });
const logs = new CloudWatchLogsClient({ region: REGION });

const USAGE_TABLE          = tableName("usage");
const UNIT_PRICES_TABLE    = tableName("api-unit-prices");
const EXCHANGE_RATES_TABLE = tableName("exchange-rates");
const FX_FALLBACK_RATE     = 150;  // 本文Lambdaが為替行を見つけられないときに使う既定値（点検表示用）

// 記録側Lambdaのロググループ。単価行が無くて記録されなかった警告をここから拾う。
// 名前は環境で変わるのでCDKが環境変数 RECORDING_LOG_GROUPS（JSON配列）で渡す。無ければRnDの旧名
const RECORDING_LOG_GROUPS = process.env.RECORDING_LOG_GROUPS
  ? JSON.parse(process.env.RECORDING_LOG_GROUPS)
  : [
    "/aws/lambda/toytalk-stream-handler-lambda",
    "/aws/lambda/toytalk-api-stream-for-esp32-lambda",
    "/aws/lambda/toytalker-tts-only-lambda",
  ];

// TTSを呼ぶLambda（本文・相槌・読み上げ）のロググループ。1リクエスト1行のJSON（backend/shared/trace.mjs）から、
// ずんだもんへの切り替え回数と会社ごとのピーク同時本数を数える。CDKが環境変数 TTS_LOG_GROUPS で渡す。無ければRnDの旧名
const TTS_LOG_GROUPS = process.env.TTS_LOG_GROUPS
  ? JSON.parse(process.env.TTS_LOG_GROUPS)
  : [
    ...RECORDING_LOG_GROUPS,
    "/aws/lambda/toytalker-backchannel-for-app-lambda",
    "/aws/lambda/toytalker-backchannel-for-esp32-lambda",
  ];

// 請求額をAPIで取れない社は、確認先のURLだけ案内する
const MANUAL_CHECK_URLS = {
  cartesia: "https://play.cartesia.ai/usage",
  brave:    "https://api-dashboard.search.brave.com/app/dashboard",
  google:   "https://console.cloud.google.com/billing",
  gemini:   "https://console.cloud.google.com/billing",
  soniox:   "https://console.soniox.com/",
  sakura:   "https://secure.sakura.ad.jp/",
  fishaudio:"https://fish.audio/",
  zakicorp: "(自前サーバー。電気代・ngrok費用のみ)",
};

// 資金決済法（docs/pricing-and-cost-model.md 11.7）: 基準日（3月末・9月末）の未使用残高がこれを超えたら届出が要る
const PREPAID_REPORT_THRESHOLD_JPY = 10_000_000;

// ---- 日付ユーティリティ（すべてUTC） ----
function prevMonthOf(date = new Date()) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1));
  return d.toISOString().slice(0, 7);
}
function currentMonthOf(date = new Date()) {
  return date.toISOString().slice(0, 7);
}
function monthRange(month) {
  const [y, m] = month.split("-").map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1));
  const end   = new Date(Date.UTC(y, m, 1));
  return { start, end };
}
const fmtJpy = (v) => `${(Math.round(v * 100) / 100).toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}円`;
const fmtUsd = (v) => `$${(Math.round(v * 10000) / 10000).toFixed(4)}`;

async function fetchJson(url, opts = {}, timeoutMs = 15000) {
  const resp = await fetch(url, { ...opts, signal: AbortSignal.timeout(timeoutMs) });
  const text = await resp.text();
  if (!resp.ok) throw new Error(`${resp.status} ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

// ---- 1. 為替 ----
// Frankfurter（ECB公表レート、キー不要）からUSD→JPYを取り、対象月の行が無ければ作る
async function updateExchangeRate(month, { overwrite = false } = {}) {
  const key = { month, currency: "JPY" };
  const existing = (await ddb.send(new GetCommand({ TableName: EXCHANGE_RATES_TABLE, Key: key }))).Item;
  let fetched = null;
  try {
    const j = await fetchJson("https://api.frankfurter.dev/v1/latest?base=USD&symbols=JPY");
    fetched = { rate: Number(j?.rates?.JPY), asOf: j?.date };
    if (!fetched.rate) throw new Error("rate missing in response");
  } catch (e) {
    return { month, action: "failed", error: e?.message || String(e), existing: existing?.rate ?? null };
  }
  if (existing && !overwrite) {
    return { month, action: "kept", rate: Number(existing.rate), fetched: fetched.rate, asOf: fetched.asOf };
  }
  await ddb.send(new PutCommand({
    TableName: EXCHANGE_RATES_TABLE,
    Item: { ...key, rate: fetched.rate, source: "frankfurter", rate_date: fetched.asOf, updated_at: new Date().toISOString() },
  }));
  return { month, action: existing ? "overwritten" : "created", rate: fetched.rate, previous: existing?.rate ?? null, asOf: fetched.asOf };
}

// ---- 2. 単価表 ----
async function loadPrices() {
  const result = await ddb.send(new ScanCommand({
    TableName: UNIT_PRICES_TABLE,
    FilterExpression: "version = :v",
    ExpressionAttributeValues: { ":v": "current" },
  }));
  const prices = {};
  let margin = 1.5;
  for (const item of (result.Items ?? [])) {
    const pk = item["provider#api_type"];
    if (pk === "service#margin") margin = Number(item.margin) || 1.5;
    else prices[pk] = item;
  }
  return { prices, margin };
}

// ---- 3. 先月の記録実費 ----
// toytalker-usage を対象月でスキャンし、provider#api_type ごとに集計する。
// cost_usd（マージン前USD実費）は2026-09-12以降の記録にだけある。無い行は cost_jpy / margin / rate で割り戻す。
async function aggregateUsage(month) {
  const byKey = {};
  const byApi = {};
  const owners = new Set();
  let total = { cost_jpy: 0, cost_usd: 0, requests: 0 };
  let derivedRows = 0;
  let lastKey;
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: USAGE_TABLE,
      FilterExpression: "begins_with(#sk, :m)",
      ExpressionAttributeNames: { "#sk": "date#device_id#api_type" },
      ExpressionAttributeValues: { ":m": month },
      ExclusiveStartKey: lastKey,
    }));
    for (const item of (result.Items ?? [])) {
      const parts = String(item["date#device_id#api_type"]).split("#");
      const apiType = parts[2] ?? "unknown";
      const provider = item.provider ?? "unknown";
      const key = `${provider}#${apiType}`;
      const costJpy = Number(item.cost_jpy) || 0;
      let costUsd = Number(item.cost_usd) || 0;
      let rawJpy = 0;  // 円建て（Sakura）のマージン前実費
      const margin = Number(item.margin) || 1.5;
      const rate = Number(item.usd_jpy_rate) || 0;
      if (!costUsd && costJpy > 0) {
        if (rate > 0) { costUsd = costJpy / margin / rate; derivedRows += 1; }
        else rawJpy = costJpy / margin;  // rate=0 は円建て: USD換算しない
      }
      const agg = byKey[key] ??= { provider, apiType, cost_jpy: 0, cost_usd: 0, raw_jpy: 0, requests: 0, tokens_in: 0, tokens_out: 0, tts_characters: 0, stt_characters: 0, models: new Set(), owners: new Set() };
      agg.cost_jpy += costJpy;
      agg.cost_usd += costUsd;
      agg.raw_jpy += rawJpy;
      agg.requests += Number(item.requests) || 0;
      agg.tokens_in += Number(item.tokens_in) || 0;
      agg.tokens_out += Number(item.tokens_out) || 0;
      agg.tts_characters += Number(item.tts_characters) || 0;
      agg.stt_characters += Number(item.stt_characters) || 0;
      if (item.model) agg.models.add(item.model);
      if (item.owner_id) { agg.owners.add(item.owner_id); owners.add(item.owner_id); }
      byApi[apiType] = (byApi[apiType] ?? 0) + costJpy;
      total.cost_jpy += costJpy; total.cost_usd += costUsd; total.requests += Number(item.requests) || 0;
    }
    lastKey = result.LastEvaluatedKey;
  } while (lastKey);
  return { byKey, byApi, total, ownerCount: owners.size, derivedRows };
}

// ---- 4. 各社の実績（APIがある社だけ） ----
async function fetchOpenAiCost(month) {
  const key = secret("OPENAI_ADMIN_KEY");
  if (!key) return { status: "skipped", note: "OPENAI_ADMIN_KEY 未設定" };
  const { start, end } = monthRange(month);
  let sum = 0, page = null, guard = 0;
  do {
    const url = new URL("https://api.openai.com/v1/organization/costs");
    url.searchParams.set("start_time", String(Math.floor(start.getTime() / 1000)));
    url.searchParams.set("end_time", String(Math.floor(end.getTime() / 1000)));
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);
    const j = await fetchJson(url, { headers: { Authorization: `Bearer ${key}` } });
    for (const bucket of (j.data ?? [])) for (const r of (bucket.results ?? [])) sum += Number(r?.amount?.value) || 0;
    page = j.has_more ? j.next_page : null;
  } while (page && ++guard < 10);
  return { status: "ok", usd: sum };
}

async function fetchAnthropicCost(month) {
  const key = secret("ANTHROPIC_ADMIN_KEY");
  if (!key) return { status: "skipped", note: "ANTHROPIC_ADMIN_KEY 未設定" };
  const { start, end } = monthRange(month);
  let cents = 0, page = null, guard = 0;
  do {
    const url = new URL("https://api.anthropic.com/v1/organizations/cost_report");
    url.searchParams.set("starting_at", start.toISOString());
    url.searchParams.set("ending_at", end.toISOString());
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", "31");
    if (page) url.searchParams.set("page", page);
    const j = await fetchJson(url, { headers: { "x-api-key": key, "anthropic-version": "2023-06-01" } });
    // amount は最小通貨単位（セント）の10進文字列
    for (const bucket of (j.data ?? [])) for (const r of (bucket.results ?? [])) cents += Number(r?.amount) || 0;
    page = j.has_more ? j.next_page : null;
  } while (page && ++guard < 10);
  return { status: "ok", usd: cents / 100 };
}

async function fetchElevenLabsUsage() {
  const key = secret("ELEVENLABS_API_KEY");
  if (!key) return { status: "skipped", note: "ELEVENLABS_API_KEY 未設定" };
  const j = await fetchJson("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": key } });
  return {
    status: "ok",
    tier: j.tier,
    characterCount: Number(j.character_count) || 0,
    characterLimit: Number(j.character_limit) || 0,
    resetAt: j.next_character_count_reset_unix ? new Date(j.next_character_count_reset_unix * 1000).toISOString().slice(0, 10) : null,
  };
}

/**
 * 前払いポイントの残高の合計（toytalker-wallets。11.10 段階3c）。毎月1日の朝に走るので「前月末の残高」の目安になる。
 * 対象月が3月・9月なら資金決済法の基準日の値として見る（1,000万円を超えていれば2か月以内に届出）
 */
async function aggregateWallets() {
  const wallets = (await listWallets()).map(describeWallet);
  const positive = wallets.filter(w => w.balanceJpy > 0);
  const now = Date.now();
  return {
    count: wallets.length,
    positiveCount: positive.length,
    totalJpy: positive.reduce((a, w) => a + w.balanceJpy, 0),
    negativeJpy: wallets.filter(w => w.balanceJpy < 0).reduce((a, w) => a + w.balanceJpy, 0), // RnD（残高0で止めない）で出るマイナス
    expiringSoon: positive.filter(w => w.expiresAt && Date.parse(w.expiresAt) - now < 30 * 24 * 60 * 60 * 1000).length,
    noOrigin: positive.filter(w => !w.lastUsedAt).length, // 毎日の処理が起点を付けるので、普段は0
  };
}

async function safe(fn) {
  try { return await fn(); } catch (e) { return { status: "error", error: e?.message || String(e) }; }
}

// ---- 5. 点検 ----
function checkStalePrices(prices, staleDays) {
  const cutoff = Date.now() - staleDays * 86400_000;
  const stale = [];
  for (const [pk, item] of Object.entries(prices)) {
    const t = item.updated_at ? Date.parse(item.updated_at) : NaN;
    if (Number.isNaN(t) || t < cutoff) stale.push({ key: pk, updated_at: item.updated_at ?? "(未設定)" });
  }
  return stale.sort((a, b) => a.key.localeCompare(b.key));
}

// 記録側Lambdaが「単価行が無い」と警告した provider#api_type を対象月のログから集める（Logs Insights で1回。
// FilterLogEvents で頭から読んでいた頃は、ログが溜まるにつれ10/1に90秒、11/1に106秒かかっていた）
async function findMissingPriceWarnings(month) {
  const { start, end } = monthRange(month);
  try {
    const rows = await insightsQuery(RECORDING_LOG_GROUPS,
      'filter @message like "[Pricing] missing price" | parse @message /missing price for (?<key>\\S+)/ | stats count(*) as n by key',
      start.getTime(), end.getTime(), Date.now() + 60_000);
    const found = {};
    for (const row of rows) {
      const key = row.find((x) => x.field === "key")?.value;
      if (key) found[key] = Number(row.find((x) => x.field === "n")?.value) || 0;
    }
    return found;
  } catch (e) {
    return { [`(取得失敗: ${e?.message || e})`]: 0 };
  }
}

// ---- 5b. TTSの切り替え回数とピーク同時本数（docs/tts-fallback-and-notifications.md の4） ----
// Scale / Enterprise へ上げる時期の判断材料。Cartesia の同時接続上限は組織単位なので、全Lambdaを合わせて数える。

/**
 * ログ1行から、TTSの呼び出し区間 { vendor, start, end }（epoch ms）を取り出す。
 * 開始はログの時刻 − total_ms。本文は文ごとに [text_at, text_at + tts_ms]、相槌・読み上げは段階の時刻から。
 * 再試行の待ちも区間に入るので、枠を実際に握っていた時間より少し長めに出る（上限の判断には安全側）。
 * 切り替え後の文（ずんだもんだけを呼んだ文）は sakura として数える。
 */
export function ttsIntervalsOf(rec, loggedAt) {
  const t0 = loggedAt - (rec.total_ms ?? 0);
  if (rec.kind === "turn") {
    return (rec.segments ?? [])
      .filter((s) => typeof s.text_at === "number" && typeof s.tts_ms === "number")
      .map((s) => ({
        vendor: s.fallback && s.attempts === 1 ? s.fallback : s.vendor,
        start: t0 + s.text_at,
        end: t0 + s.text_at + s.tts_ms,
      }));
  }
  // 相槌は LLM の後、読み上げは設定の読み込みの後に TTS を呼ぶ
  const from = rec.kind === "backchannel" ? rec.marks?.llm_done : rec.kind === "read-aloud" ? rec.marks?.config : undefined;
  const to = rec.marks?.tts_done;
  if (!rec.tts || typeof from !== "number" || typeof to !== "number") return [];
  return [{ vendor: rec.tts, start: t0 + from, end: t0 + to }];
}

/** 区間の集まりの最大の重なり数と、その時刻（epoch ms） */
export function peakConcurrency(intervals) {
  const points = [];
  for (const iv of intervals) {
    points.push([iv.start, 1], [iv.end, -1]);
  }
  // 同じ時刻なら終わりを先に数える（ちょうど接する区間は重ならない）
  points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0, peak = 0, at = null;
  for (const [t, d] of points) {
    cur += d;
    if (cur > peak) { peak = cur; at = t; }
  }
  return { peak, at };
}

/** 主プロバイダー失敗でずんだもんへ切り替えたリクエストか。返り値は切り替え元の会社（無ければ null） */
export function fallbackFromOf(rec) {
  if (rec.kind === "turn") return rec.tts_fallback_chars > 0 ? (rec.tts ?? "unknown") : null;
  return rec.tts_fallback ? (rec.tts ?? "unknown") : null;
}

// Logs Insights で読む（FilterLogEvents で1か月分を頭から読むと300秒に収まらなかった。2026-11-01）。
// 1回の問い合わせは1万行までなので日ごとに分け、5日ずつ並べて投げる。時間切れでもレポートの残りは送る
const TTS_QUERY = 'fields @timestamp, @message | filter kind = "turn" or kind = "backchannel" or kind = "read-aloud" | limit 10000';
const INSIGHTS_ROW_LIMIT = 10000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function insightsQuery(logGroupNames, queryString, startMs, endMs, deadlineAt) {
  const { queryId } = await logs.send(new StartQueryCommand({
    logGroupNames,
    startTime: Math.floor(startMs / 1000),
    endTime: Math.floor(endMs / 1000) - 1,
    queryString,
    limit: INSIGHTS_ROW_LIMIT,
  }));
  for (;;) {
    await sleep(1000);
    const r = await logs.send(new GetQueryResultsCommand({ queryId }));
    if (r.status === "Complete") return r.results ?? [];
    if (["Failed", "Cancelled", "Timeout", "Unknown"].includes(r.status)) throw new Error(`Insights ${r.status}`);
    if (Date.now() > deadlineAt) {
      await logs.send(new StopQueryCommand({ queryId })).catch(() => {});
      throw new Error("時間切れ");
    }
  }
}

/** Insights の1行（[{field, value}]）→ { at: epoch ms, rec }。@message は "時刻	リクエストID	INFO	{...}" の形 */
export function parseInsightsRow(row) {
  const get = (f) => row.find((x) => x.field === f)?.value;
  const msg = get("@message") ?? "";
  const ts = get("@timestamp");
  const i = msg.indexOf("{");
  if (i < 0 || !ts) return null;
  try {
    return { at: Date.parse(`${ts.replace(" ", "T")}Z`), rec: JSON.parse(msg.slice(i)) };
  } catch {
    return null;
  }
}

async function aggregateTtsTraces(month, { budgetMs = 120_000 } = {}) {
  const { start, end } = monthRange(month);
  const deadlineAt = Date.now() + budgetMs;
  const intervalsByVendor = {};
  const fallbacks = { turn: 0, backchannel: 0, "read-aloud": 0 };
  const fallbackFrom = {};
  let slowSwitches = 0; // 本文のうち、主プロバイダーが遅くて（3秒超え）切り替えた回数
  const requests = { turn: 0, backchannel: 0, "read-aloud": 0 };
  const problems = [];
  const days = [];
  for (let t = start.getTime(); t < end.getTime(); t += 86400_000) days.push(t);
  const tally = ({ at, rec }) => {
    if (!(rec.kind in requests)) return;
    requests[rec.kind]++;
    const from = fallbackFromOf(rec);
    if (from) {
      fallbacks[rec.kind]++;
      if ((rec.ext ?? []).some((x) => x.slow)) slowSwitches++;
      fallbackFrom[from] = (fallbackFrom[from] ?? 0) + 1;
    }
    for (const iv of ttsIntervalsOf(rec, at)) {
      (intervalsByVendor[iv.vendor] ??= []).push(iv);
    }
  };
  for (let i = 0; i < days.length; i += 5) {
    const batch = days.slice(i, i + 5);
    const results = await Promise.allSettled(batch.map((d) => insightsQuery(TTS_LOG_GROUPS, TTS_QUERY, d, Math.min(d + 86400_000, end.getTime()), deadlineAt)));
    results.forEach((r, j) => {
      const day = new Date(batch[j]).toISOString().slice(0, 10);
      if (r.status === "rejected") { problems.push(`${day}（UTC）: 取得失敗（${r.reason?.message || r.reason}）`); return; }
      if (r.value.length >= INSIGHTS_ROW_LIMIT) problems.push(`${day}（UTC）: 1万行を超えたので途中まで`);
      for (const row of r.value) {
        const parsed = parseInsightsRow(row);
        if (parsed) tally(parsed);
      }
    });
  }
  const peaks = Object.fromEntries(Object.entries(intervalsByVendor).map(([v, ivs]) => [v, { ...peakConcurrency(ivs), calls: ivs.length }]));
  return { requests, fallbacks, fallbackFrom, slowSwitches, peaks, problems };
}

const fmtJst = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 16).replace("T", " ");

// ---- 6. レポート組み立て ----
function buildReport({ month, fx, prices, margin, usage, actuals, stale, missing, staleDays, notes, tts, wallets }) {
  const L = [];
  L.push(`ToyTalker 月次コスト確認レポート（対象月: ${month}）`);
  L.push(`生成: ${new Date().toISOString()}  マージン: ${margin}`);
  L.push("");

  L.push("■ 為替（今月の記録に使う USD→JPY）");
  if (fx.action === "created")     L.push(`  ${fx.month}: ${fx.rate} 円（Frankfurter ${fx.asOf} を新規保存）`);
  else if (fx.action === "kept")   L.push(`  ${fx.month}: ${fx.rate} 円（既存行を維持。参考: Frankfurter ${fx.asOf} は ${fx.fetched}）`);
  else if (fx.action === "overwritten") L.push(`  ${fx.month}: ${fx.rate} 円（${fx.previous} から上書き。Frankfurter ${fx.asOf}）`);
  else if (fx.action === "skipped") L.push(`  取得をスキップ（fx=false）`);
  else L.push(`  取得失敗: ${fx.error}。行が無い月は本文Lambdaが ${FX_FALLBACK_RATE} 円で計算します`);
  L.push("");

  L.push(`■ ${month} の記録（toytalker-usage）`);
  L.push(`  合計: ${fmtJpy(usage.total.cost_jpy)}（マージン後） / 実費 ${fmtUsd(usage.total.cost_usd)}（マージン前USD、円建てSakuraを除く） / 利用者 ${usage.ownerCount} 人`);
  if (usage.derivedRows > 0) L.push(`  ※ ${usage.derivedRows} 行は cost_usd が無く、円額から割り戻した概算を含みます`);
  const apiOrder = ["stt", "llm", "tts", "tool"];
  const apiLine = Object.entries(usage.byApi).sort((a, b) => apiOrder.indexOf(a[0]) - apiOrder.indexOf(b[0])).map(([k, v]) => `${k} ${fmtJpy(v)}`).join(" / ");
  if (apiLine) L.push(`  種別: ${apiLine}`);
  L.push("");

  L.push("■ プロバイダー別（記録実費 と 各社の実績）");
  const keys = Object.keys(usage.byKey).sort();
  if (keys.length === 0) L.push("  記録がありません");
  const seenProviders = new Set();
  for (const k of keys) {
    const a = usage.byKey[k];
    const units = [];
    if (a.tokens_in || a.tokens_out) units.push(`tokens in ${a.tokens_in.toLocaleString()} / out ${a.tokens_out.toLocaleString()}`);
    if (a.tts_characters) units.push(`${a.tts_characters.toLocaleString()} 文字`);
    if (a.stt_characters) units.push(`${a.stt_characters.toLocaleString()} 文字`);
    if (a.apiType === "tool") units.push(`${a.requests.toLocaleString()} 回`);
    const usdText = a.cost_usd > 0 ? `実費 ${fmtUsd(a.cost_usd)}` : (a.raw_jpy > 0 ? `実費 ${fmtJpy(a.raw_jpy)}（円建て）` : "実費 0");
    L.push(`  ${k}: ${fmtJpy(a.cost_jpy)} / ${usdText} / ${units.join(", ") || `${a.requests} 回`}${a.models.size ? ` / ${[...a.models].join(",")}` : ""}`);
    seenProviders.add(a.provider);
  }
  L.push("");

  L.push("■ 各社の実績との突き合わせ");
  const recordedUsdByProvider = {};
  const recordedJpyByProvider = {};
  for (const a of Object.values(usage.byKey)) {
    recordedUsdByProvider[a.provider] = (recordedUsdByProvider[a.provider] ?? 0) + a.cost_usd;
    recordedJpyByProvider[a.provider] = (recordedJpyByProvider[a.provider] ?? 0) + a.raw_jpy;
  }
  const lineFor = (provider, actual) => {
    const rec = recordedUsdByProvider[provider] ?? 0;
    if (actual.status === "ok" && typeof actual.usd === "number") {
      const diff = actual.usd - rec;
      const pct = rec > 0 ? ` (${diff >= 0 ? "+" : ""}${Math.round(diff / rec * 100)}%)` : "";
      const flag = rec > 0 && Math.abs(diff) / rec > 0.2 ? "  ← 要確認（差が20%超）" : "";
      return `  ${provider}: 請求 ${fmtUsd(actual.usd)} / 記録 ${fmtUsd(rec)} / 差 ${fmtUsd(diff)}${pct}${flag}`;
    }
    if (actual.status === "skipped") return `  ${provider}: 未取得（${actual.note}） / 記録 ${fmtUsd(rec)}`;
    return `  ${provider}: 取得失敗（${actual.error}） / 記録 ${fmtUsd(rec)}`;
  };
  L.push(lineFor("openai", actuals.openai));
  L.push(lineFor("anthropic", actuals.anthropic));
  const el = actuals.elevenlabs;
  const elRec = usage.byKey["elevenlabs#tts"]?.tts_characters ?? 0;
  if (el.status === "ok") L.push(`  elevenlabs: 現在サイクル ${el.characterCount.toLocaleString()} / ${el.characterLimit.toLocaleString()} 文字（${el.tier}、リセット ${el.resetAt}） / ${month} の記録 ${elRec.toLocaleString()} 文字 / 記録実費 ${fmtUsd(recordedUsdByProvider.elevenlabs ?? 0)}`);
  else if (el.status === "skipped") L.push(`  elevenlabs: 未取得（${el.note}）`);
  else L.push(`  elevenlabs: 取得失敗（${el.error}）`);
  const manual = [...seenProviders].filter(p => !["openai", "anthropic", "elevenlabs"].includes(p)).sort();
  if (manual.length) {
    L.push("  手動確認（APIで請求を取れない社。記録実費と各社ダッシュボードを比べてください）:");
    for (const p of manual) {
      const usd = recordedUsdByProvider[p] ?? 0, jpy = recordedJpyByProvider[p] ?? 0;
      const amount = usd > 0 ? fmtUsd(usd) : (jpy > 0 ? `${fmtJpy(jpy)}（円建て）` : "0");
      L.push(`    ${p}: 記録実費 ${amount} → ${MANUAL_CHECK_URLS[p] ?? "(URL未登録)"}`);
    }
  }
  L.push("");

  L.push(`■ TTS の切り替えと同時本数（${month}、Lambdaログから）`);
  if (tts.status === "error") {
    L.push(`  取得失敗（${tts.error}）`);
  } else {
    const f = tts.fallbacks, n = tts.requests;
    const fromText = Object.entries(tts.fallbackFrom).sort((a, b) => b[1] - a[1]).map(([v, c]) => `${v} ${c}`).join(", ");
    L.push(`  ずんだもんへの切り替え: 本文 ${f.turn} / ${n.turn} 回、相槌 ${f.backchannel} / ${n.backchannel} 回、読み上げ ${f["read-aloud"]} / ${n["read-aloud"]} 回${fromText ? `（切り替え元: ${fromText}）` : ""}`);
    L.push(`    うち本文で、主プロバイダーが3秒を超えて切り替えた回数: ${tts.slowSwitches} 回（残りは 429 / 5xx などの失敗）`);
    const peaks = Object.entries(tts.peaks).sort((a, b) => b[1].peak - a[1].peak);
    if (peaks.length === 0) L.push("  ピーク同時本数: TTSの呼び出し記録がありません");
    else {
      L.push("  ピーク同時本数（全Lambda合計。Cartesia の上限は Pro 3 / Startup 5 / Scale 15）:");
      for (const [v, p] of peaks) L.push(`    ${v}: ${p.peak} 本（${fmtJst(p.at)} JST） / 呼び出し ${p.calls.toLocaleString()} 回`);
    }
    for (const pr of tts.problems) L.push(`  ※ ${pr}`);
  }
  L.push("");

  L.push("■ 前払いポイントの残高（toytalker-wallets、生成時点）");
  if (wallets.status === "error") {
    L.push(`  取得失敗（${wallets.error}）`);
  } else {
    const w = wallets;
    const baseDay = /-(03|09)$/.test(month);
    L.push(`  残高合計: ${fmtJpy(w.totalJpy)} / 残高のある財布 ${w.positiveCount} / 財布の数 ${w.count}${baseDay ? "  ← 資金決済法の基準日（3月末・9月末）の目安" : ""}`);
    if (w.totalJpy > PREPAID_REPORT_THRESHOLD_JPY) L.push(`  ※ 合計が ${fmtJpy(PREPAID_REPORT_THRESHOLD_JPY)} を超えています。基準日の値なら2か月以内に財務局へ届出（docs/pricing-and-cost-model.md 11.7）`);
    if (w.negativeJpy < 0) L.push(`  マイナスの財布の合計: ${fmtJpy(w.negativeJpy)}（残高0で止めない環境の消費）`);
    L.push(`  30日以内に失効する財布: ${w.expiringSoon}${w.noOrigin ? ` / 起点（最終利用日）の無い財布: ${w.noOrigin}` : ""}`);
  }
  L.push("");

  L.push("■ 点検");
  const missingKeys = Object.entries(missing);
  if (missingKeys.length) {
    L.push(`  単価行が無くて記録されなかった呼び出しがあります（${month}）:`);
    for (const [k, n] of missingKeys) L.push(`    ${k}: ${n} 回 → toytalker-api-unit-prices に行を追加してください`);
  } else {
    L.push("  単価行なしの警告: なし");
  }
  if (stale.length) {
    L.push(`  ${staleDays} 日以上更新されていない単価行（各社の料金ページで見直し）:`);
    for (const s of stale) L.push(`    ${s.key}: ${s.updated_at}`);
  } else {
    L.push(`  単価行の鮮度: すべて ${staleDays} 日以内`);
  }
  L.push(`  単価行の数: ${Object.keys(prices).length}`);
  for (const n of notes) L.push(`  ${n}`);
  L.push("");
  L.push("このメールは toytalker-ops-monthly-lambda が自動送信しています。値の自動修正は行いません。");
  return L.join("\n");
}

// ---- Handler ----
export const handler = async (event = {}) => {
  await ensureSecrets();
  const now = new Date();
  const month = typeof event.month === "string" && /^\d{4}-\d{2}$/.test(event.month) ? event.month : prevMonthOf(now);
  const send = event.send !== false;
  const doFx = event.fx !== false;
  const staleDays = Number(process.env.STALE_PRICE_DAYS) || 180;
  const notes = [];

  const fx = doFx
    ? await updateExchangeRate(currentMonthOf(now), { overwrite: process.env.FX_OVERWRITE === "true" })
    : { month: currentMonthOf(now), action: "skipped" };
  console.log("[FX]", JSON.stringify(fx));

  const { prices, margin } = await loadPrices();
  const usage = await aggregateUsage(month);
  const [openai, anthropic, elevenlabs] = await Promise.all([
    safe(() => fetchOpenAiCost(month)),
    safe(() => fetchAnthropicCost(month)),
    safe(() => fetchElevenLabsUsage()),
  ]);
  const stale = checkStalePrices(prices, staleDays);
  const missing = await findMissingPriceWarnings(month);
  const tts = await safe(() => aggregateTtsTraces(month));
  const wallets = await safe(() => aggregateWallets());

  // 対象月の為替行の有無（無ければ本文Lambdaは150円で計算していた）
  const monthRate = (await ddb.send(new GetCommand({ TableName: EXCHANGE_RATES_TABLE, Key: { month, currency: "JPY" } }))).Item;
  if (!monthRate) notes.push(`${month} の為替行が無く、その月の記録は既定の ${FX_FALLBACK_RATE} 円で計算されています`);

  const report = buildReport({ month, fx, prices, margin, usage, actuals: { openai, anthropic, elevenlabs }, stale, missing, staleDays, notes, tts, wallets });
  console.log(report);

  let published = false;
  if (send) {
    const topicArn = process.env.OPS_SNS_TOPIC_ARN;
    if (!topicArn) throw new Error("OPS_SNS_TOPIC_ARN is not set");
    // SNSのメール件名はASCIIのみ
    await sns.send(new PublishCommand({ TopicArn: topicArn, Subject: `ToyTalker monthly cost report ${month}`, Message: report }));
    published = true;
  }
  return { ok: true, month, published, fx, report };
};
