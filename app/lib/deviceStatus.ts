// おもちゃ本体の状態（電池・温度・充電）の表示用の文言。
// 値は会話のたびに本体が送り、会話 Lambda が devices の行に残したもの（backend/shared/device-status.mjs）。
// 会話していない間は更新されないので、必ず「いつの値か」を添えて出す。

export type DeviceStatus = {
  vbat_mv?: number | null;
  board_temp_c?: number | null;
  chip_temp_c?: number | null;
  charge?: "idle" | "charging" | "fault" | "fault_fatal" | null;
  level?: "none" | "high" | "mid" | "low" | "empty" | null;
};

/** この時間以内の値は「いま」として出す */
const NOW_MS = 2 * 60 * 1000;

const LEVEL_LABEL: Record<string, string> = {
  none: "電池なし",
  high: "多い",
  mid: "ふつう",
  low: "少ない",
  empty: "充電してください",
};

const CHARGE_LABEL: Record<string, string> = {
  idle: "充電していません",
  charging: "充電中",
  fault: "充電が止まっています（温度など）",
  fault_fatal: "充電の異常",
};

export function batteryText(st: DeviceStatus): string {
  const parts: string[] = [];
  if (st.level && LEVEL_LABEL[st.level]) parts.push(LEVEL_LABEL[st.level]);
  if (typeof st.vbat_mv === "number" && st.level !== "none") parts.push(`${(st.vbat_mv / 1000).toFixed(2)}V`);
  return parts.length ? parts.join(" ") : "—";
}

export function chargeText(st: DeviceStatus): string {
  return (st.charge && CHARGE_LABEL[st.charge]) || "—";
}

export function tempText(st: DeviceStatus): string {
  return typeof st.board_temp_c === "number" ? `${Math.round(st.board_temp_c)}℃` : "—";
}

/** 「いま」か、そうでなければいつの値か */
export function statusAgeText(at: string | null | undefined, now = Date.now()): string {
  const t = Date.parse(at ?? "");
  if (!Number.isFinite(t)) return "";
  const diff = now - t;
  if (diff < NOW_MS) return "いま";
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}分前`;
  const d = new Date(t);
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;
  const sameDay = new Date(now).toDateString() === d.toDateString();
  return sameDay ? `今日 ${hm}` : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}
