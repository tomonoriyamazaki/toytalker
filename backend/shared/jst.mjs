// 利用額の日付は日本時間で区切る（利用者が見る「何日に使ったか」と合わせる）。
// 時刻そのもの（chat-logs・台帳の timestamp）は UTC の ISO 8601 のまま持つ。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** ISO 8601 の時刻 → 日本時間の日付 "YYYY-MM-DD" */
export function jstDate(iso) {
  return new Date(Date.parse(iso) + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** 日本時間の日付 "YYYY-MM-DD" → その日の始まりと次の日の始まり（UTC の ISO 8601） */
export function jstDayRange(date) {
  const start = Date.parse(`${date}T00:00:00.000Z`) - JST_OFFSET_MS;
  return { start: new Date(start).toISOString(), end: new Date(start + 24 * 60 * 60 * 1000).toISOString() };
}
