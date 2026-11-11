// 利用状況（GET /usage、GET /usage/detail）の応答を、画面がそのまま描ける形に揃える。
// 画面は金額・文字数・回数を <Text> に直接描くので、数値でも文字列でもない値が1つ来るだけで描画が例外になる
// （2026-11-08〜11、サーバーが台帳の数値を { value: "…" } の形で返し、詳細画面でアプリが終了した）。
// 描く箇所ごとに守らず、受け取り口のここで一度だけ直す。

/** 数値に直す。数値の文字列と { value: "…" }（DynamoDB の数値を文字列のまま包んだ形）も受ける。直せなければ null */
export function toNum(v: unknown): number | null {
  const raw = v !== null && typeof v === "object" && "value" in v ? (v as { value: unknown }).value : v;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** 金額用。直せなければ 0 */
const num = (v: unknown): number => toNum(v) ?? 0;

/** 画面に描ける文字列。数値は文字列にし、それ以外は null */
const str = (v: unknown): string | null =>
  typeof v === "string" ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : null;

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** GET /usage（月の合計・デバイス別・API種別・為替・残高） */
export function normalizeUsage(data: unknown) {
  const d = obj(data);

  const byApi: Record<string, { total: number; daily: { date: string; cost: number; requests: number }[] }> = {};
  for (const [apiType, v] of Object.entries(obj(d.by_api_type))) {
    const a = obj(v);
    byApi[apiType] = {
      total: num(a.total),
      daily: arr(a.daily)
        .map(obj)
        .map((x) => ({ date: str(x.date) ?? "", cost: num(x.cost), requests: num(x.requests) }))
        .filter((x) => x.date !== ""),
    };
  }

  // デバイス別は total と API種別ごとの金額、それに表示名
  const byDevice: Record<string, Record<string, number | string | null>> = {};
  for (const [deviceId, v] of Object.entries(obj(d.by_device))) {
    const row: Record<string, number | string | null> = {};
    for (const [k, x] of Object.entries(obj(v))) row[k] = k === "device_name" ? str(x) : num(x);
    row.total = num(row.total);
    byDevice[deviceId] = row;
  }

  const r = obj(d.exchange_rate);
  const rate = toNum(r.rate);

  return {
    month: str(d.month),
    // 無い（エラーの応答など）ときは null のまま。0 にすると「この月の利用データはありません」が出てしまう
    total_cost: toNum(d.total_cost),
    balance_jpy: toNum(d.balance_jpy),
    by_api_type: byApi,
    by_device: byDevice,
    exchange_rate: rate == null ? null : {
      month: str(r.month) ?? undefined,
      rate,
      rate_date: str(r.rate_date) ?? undefined,
      fetched_at: str(r.fetched_at) ?? undefined,
    },
  };
}

/** GET /usage/detail（1日の会話ごとの内訳） */
export function normalizeUsageDetail(data: unknown) {
  const d = obj(data);
  const part = (v: unknown) => (v !== null && typeof v === "object" ? obj(v) : null);

  const conversations = arr(d.conversations).map(obj).map((c) => {
    const stt = part(c.stt);
    const llm = part(c.llm);
    const tts = part(c.tts);
    const toolItems = arr(obj(c.tool).items).map(obj).map((t) => ({
      provider: str(t.provider),
      tool: str(t.tool),
      requests: toNum(t.requests),
      cost: num(t.cost),
    }));
    return {
      timestamp: str(c.timestamp),
      device_id: str(c.device_id),
      device_name: str(c.device_name),
      character_id: str(c.character_id),
      user_message: typeof c.user_message === "string" ? c.user_message : null,
      stt: stt && { cost: num(stt.cost), characters: toNum(stt.characters) },
      llm: llm && { cost: num(llm.cost), provider: str(llm.provider), tokens_in: toNum(llm.tokens_in), tokens_out: toNum(llm.tokens_out) },
      tts: tts && { cost: num(tts.cost), provider: str(tts.provider), characters: toNum(tts.characters) },
      tool: toolItems.length > 0 ? { items: toolItems } : null,
      total: num(c.total),
    };
  });

  return { date: str(d.date), conversations };
}
