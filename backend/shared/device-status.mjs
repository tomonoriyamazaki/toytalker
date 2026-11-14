// 本体の状態（電池電圧・温度・充電状態）を devices の機器の行に「最後の値と時刻」として残す（ロードマップ25）。
// 値は本文要求の body.device（ファームの PowerSense.h）を trace.mjs の describeDevice に通したもの。
// アプリは設定 Lambda の GET /devices で device_status / device_status_at を受け取って表示する。
import { UpdateCommand } from "@aws-sdk/lib-dynamodb";

/** この間隔より新しい記録があり、充電状態も変わっていなければ書かない */
export const STATUS_WRITE_INTERVAL_MS = 5 * 60 * 1000;
/** これ未満の電圧は「電池が付いていない（分圧が 0 付近）」とみなす */
const NO_BATTERY_MV = 2500;

/**
 * 充電IC BQ25185 の STAT1/STAT2（データシート SLUSF65B 表6-2。1=High, 0=Low）。
 *   idle: 充電完了・休止・充電無効（USB なしもここ。STAT だけでは区別できない）
 *   charging: 充電中
 *   fault: 回復できる異常（入力過電圧・TS 高温/低温・IC 過熱・SYS 短絡）
 *   fault_fatal: 回復できない異常（ILIM/ISET 短絡・電池過電流・安全タイマー切れ）
 */
export function chargeState(stat1, stat2) {
  if (stat1 === 1 && stat2 === 1) return "idle";
  if (stat1 === 1 && stat2 === 0) return "charging";
  if (stat1 === 0 && stat2 === 1) return "fault";
  if (stat1 === 0 && stat2 === 0) return "fault_fatal";
  return null;
}

/**
 * 電圧からの残量の目安（推定。再生中は電圧が下がり、充電中は上がるので段階だけ）。
 * 充電中は電圧が残量を表さないので null。
 */
export function batteryLevel(vbatMv, charge) {
  if (!Number.isFinite(vbatMv)) return null;
  if (vbatMv < NO_BATTERY_MV) return "none";
  if (charge === "charging") return null;
  if (vbatMv >= 3950) return "high";
  if (vbatMv >= 3700) return "mid";
  if (vbatMv >= 3500) return "low";
  return "empty";
}

/**
 * 行に書く値を返す。書かなくてよいとき（本体が送っていない・前回から間が無く充電状態も同じ）は null。
 * @param {object|null} row devices の機器の行
 * @param {object|null} dev describeDevice の戻り値
 */
export function nextDeviceStatus(row, dev, now = Date.now()) {
  if (!row || !dev || dev.vbat_mv === null || dev.vbat_mv === undefined) return null;
  const charge = chargeState(dev.chg_stat1, dev.chg_stat2);
  const status = {
    vbat_mv: dev.vbat_mv,
    board_temp_c: dev.board_temp_c ?? null,
    chip_temp_c: dev.chip_temp_c ?? null,
    chg_stat1: dev.chg_stat1 ?? null,
    chg_stat2: dev.chg_stat2 ?? null,
    charge,
    level: batteryLevel(dev.vbat_mv, charge),
  };
  const prev = row.device_status;
  const prevAt = Date.parse(row.device_status_at ?? "");
  const fresh = Number.isFinite(prevAt) && now - prevAt < STATUS_WRITE_INTERVAL_MS;
  if (fresh && prev && prev.charge === status.charge && prev.level === status.level) return null;
  return status;
}

/**
 * devices に書く。会話を止めないよう、失敗しても投げない（戻り値は書いたかどうか）。
 * 行が無ければ作らない（未登録機の行を作らない）。
 */
export async function recordDeviceStatus(ddb, tableName, row, dev, now = Date.now()) {
  const status = nextDeviceStatus(row, dev, now);
  if (!status) return false;
  try {
    await ddb.send(new UpdateCommand({
      TableName: tableName,
      Key: { device_id: row.device_id },
      UpdateExpression: "SET device_status = :s, device_status_at = :t",
      ConditionExpression: "attribute_exists(device_id)",
      ExpressionAttributeValues: { ":s": status, ":t": new Date(now).toISOString() },
    }));
    return true;
  } catch (e) {
    console.error("[DynamoDB] recordDeviceStatus error:", e?.name ?? e);
    return false;
  }
}
