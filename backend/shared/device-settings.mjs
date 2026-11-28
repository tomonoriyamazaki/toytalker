// ESP32 へ下ろす設定（ロードマップ25。docs/esp32-ota-settings-plan.md の「音声割り込み・相槌の再起動なしON/OFF」）。
//   - 起動時: 一時キー Lambda の応答に載せる。
//   - 会話中: 会話 Lambda（/chat-mcu）が毎回の返事にメタデータ `settings` として添える（本体は次の会話から使う）。
//   機器の行（devices）はどちらの Lambda ももともと読んでいるので、呼び出しは増えない。
//
// 話し終わりの待ち（アプリの「おもちゃ」画面の はやい / ふつう / ゆっくり → devices の stt_wait）:
//   段階の中身は環境変数 STT_DEVICE_WAITS（infra/config/stages.ts の sttDeviceWaits）。
//   本体は soniox を解釈せず Soniox の開始メッセージに足し、grace_ms を終端（<end>）の後に待つ時間として使う。
//   行に stt_wait が無い機器には何も送らない（本体は組み込みの値のまま = 「ふつう」と同じ）。
export const STT_WAITS = ["fast", "normal", "slow"];
export const VOLUME_LEVELS = ["low", "mid", "high"];

const DEVICE_WAITS = (() => {
  try { return process.env.STT_DEVICE_WAITS ? JSON.parse(process.env.STT_DEVICE_WAITS) : null; }
  catch (e) { console.warn(`[STT_DEVICE_WAITS] invalid JSON: ${e.message}`); return null; }
})();

/** 機器の行の stt_wait を、本体へ送る形（{ wait, grace_ms, soniox }）にする。選んでいない・中身が無いときは null */
export function sttForDevice(row, waits = DEVICE_WAITS) {
  const wait = row?.stt_wait;
  if (!STT_WAITS.includes(wait)) return null;
  const setting = waits?.[wait];
  const grace = Number(setting?.grace_ms);
  if (!setting || !Number.isFinite(grace) || grace < 0) return null;
  const soniox = setting.soniox && typeof setting.soniox === "object" ? setting.soniox : {};
  return { wait, grace_ms: Math.round(grace), soniox };
}

/** 会話の返事に添えるメタデータ `settings` の中身。項目を足すときは古いファームが知らない項目を無視することを前提にする */
export function deviceSettings(row, waits = DEVICE_WAITS) {
  const stt = sttForDevice(row, waits);
  // 音量の段階（low / mid / high）。倍率へ直すのは本体。決めていない機器には送らない（本体は自分の既定のまま）
  const volume = VOLUME_LEVELS.includes(row?.volume_level) ? row.volume_level : null;
  return {
    backchannel_enabled: row?.backchannel_enabled !== false,
    ...(stt ? { stt } : {}),
    ...(volume ? { volume_level: volume } : {}),
  };
}
