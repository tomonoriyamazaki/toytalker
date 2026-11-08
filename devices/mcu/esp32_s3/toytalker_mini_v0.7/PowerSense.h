#pragma once
// PowerSense.h — 電池電圧・温度・充電状態の読み取り（2026-11-08、ロードマップ6。v0.2基板）
// 会話の要求の "device" に添え、会話Lambdaが1行ログ（backend/shared/trace.mjs の describeDevice）に写す。
// devices への記録とアプリ表示はロードマップ25。ピンと部品は devices/KiCad/toytalker_mini_v0.2/PINMAP.md・PARTS_LIST.md。
//
// - 電池電圧: GPIO1、470kΩ×2 の分圧なので読み値×2。分圧が高抵抗なので ADC の入力で数十mV ずれうる（未校正）。
//   残量%は電圧からの推定になるので送らない。電池を付けていなければ 0 付近になる。
// - 基板温度: GPIO2、+3V3 —10kΩ— GPIO2 —TH2(NCP15XH103F03RC: 10kΩ@25℃, B=3380)— GND。読めない値なら送らない（null）。
// - チップ温度: ESP32 内蔵（temperatureRead）。基板温度とは別。差が大きければ CPU の自己発熱。
// - 充電状態: BQ25185 の STAT1/STAT2（GPIO13/14、100kΩ プルアップのオープンドレイン）をそのままの値（1=High, 0=Low）で送る。
//   意味（充電中・完了・異常）の割り当ては充電ICのデータシートと実機で確かめてから Lambda かアプリで解釈する（ファームでは解釈しない）。
#include <Arduino.h>
#include <math.h>

struct PowerReading {
  uint32_t vbatMv = 0;
  float boardTempC = NAN;
  float chipTempC = NAN;
  int chgStat1 = -1;
  int chgStat2 = -1;
};

inline void powerSenseBegin(int pinStat1, int pinStat2) {
  pinMode(pinStat1, INPUT);  // 外付けプルアップがあるので内部プルアップは使わない
  pinMode(pinStat2, INPUT);
}

inline uint32_t powerSenseReadMv(int pin, int samples = 8) {
  uint32_t sum = 0;
  for (int i = 0; i < samples; ++i) sum += analogReadMilliVolts(pin);
  return sum / samples;
}

inline PowerReading powerSenseRead(int pinVbat, int pinBoardTemp, int pinStat1, int pinStat2) {
  constexpr float VCC_MV = 3300.0f;
  constexpr float R_TOP = 10000.0f;
  constexpr float R25 = 10000.0f;
  constexpr float BETA = 3380.0f;
  PowerReading r;
  r.vbatMv = powerSenseReadMv(pinVbat) * 2;
  const float tMv = (float)powerSenseReadMv(pinBoardTemp);
  // 端に張り付いた値はサーミスタの断線・短絡か、分圧が無い基板
  if (tMv > 50.0f && tMv < VCC_MV - 50.0f) {
    const float rt = R_TOP * tMv / (VCC_MV - tMv);
    const float invT = 1.0f / 298.15f + logf(rt / R25) / BETA;
    r.boardTempC = 1.0f / invT - 273.15f;
  }
  r.chipTempC = temperatureRead();
  r.chgStat1 = digitalRead(pinStat1) == HIGH ? 1 : 0;
  r.chgStat2 = digitalRead(pinStat2) == HIGH ? 1 : 0;
  return r;
}

inline String powerSenseJsonNumber(float v) {
  if (isnan(v) || isinf(v)) return "null";
  return String(v, 1);
}

// 要求の "device" の中身（先頭と末尾の {} は呼び出し側）。計測（ロードマップ6の「本体側の計測」）も同じ "device" に足す
inline String powerSenseJsonFields(const PowerReading& r) {
  return String("\"vbat_mv\":") + r.vbatMv +
         ",\"board_temp_c\":" + powerSenseJsonNumber(r.boardTempC) +
         ",\"chip_temp_c\":" + powerSenseJsonNumber(r.chipTempC) +
         ",\"chg_stat1\":" + r.chgStat1 +
         ",\"chg_stat2\":" + r.chgStat2;
}
