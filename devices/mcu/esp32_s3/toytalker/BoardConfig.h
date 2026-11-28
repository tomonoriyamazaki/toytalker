#pragma once
// BoardConfig.h — 基板の版と、版で変わる値の表。
//
// このファームは基板 v0.4 以降（ESP32-S3-WROOM-1-N16R8）用で、その中では全基板で 1 本（.bin も 1 つ）。
// 基板の版は、基板の 3 本のピン（HW_ID0〜2）を起動時に内蔵プルアップで読んで決める（抵抗で GND へ落としてあれば 0）。
// v0.4 は 3 本とも何もつないでいない（= 3 本とも 1）。v0.5 から抵抗を載せて区別する（docs/mcu.md の「版を見分ける」）。
// 人が版を書く手間（v0.3 以前は USB 書き込みのときに NVS へ書いていた）は無い。知らない組み合わせなら表の先頭として動く。
//
// 版を足すときはここに 1 行足す。表にあるのは版で違う値だけで、全基板で同じピン（アンプ・LED・
// ボタン・電源まわり）は .ino の #define のまま。版で変わったらこの表へ移す。
// v0.3 以前（MINI-1）はこのファームの対象外（PSRAM の方式が違い、.bin が動かない。toytalker_mini_v0.7 の 0.7.x）。
#include <Arduino.h>
#include <string.h>

namespace board {

enum class Mic : uint8_t {
  I2sStd,  // I2S 標準モード（BCLK/WS/DIN）。32bit の枠に 18bit が左詰めで来る（SPH0645）
  Pdm,     // PDM（CLK/DIN）。ESP32-S3 の PDM→PCM 変換で 16bit が来る（SPH0655）
};

struct Config {
  const char* hw;       // サーバーへ知らせる版の名前（鍵発行の要求の hw）。OTA の配布先もこれで決まる（v0.4 以降 = wroom1）
  uint8_t hwId;         // HW_ID0〜2 の読み（bit0 = HW_ID0。抵抗なし = 1）
  Mic mic;
  int8_t micClk;        // I2S の BCLK / PDM の CLOCK
  int8_t micWs;         // I2S の WS。PDM では使わない（-1）
  int8_t micData;
  bool pdmRightSlot;    // PDM でどちらの枠を読むか（マイクの SELECT の配線で決まる）
  // PDM の 16bit 値に掛けて「I2S の生の値」と同じ単位にする倍率（16384 で、>>14 した後が元の 16bit と同じ）。
  // 6 倍は v0.3 から引き継いだ仮の値で、根拠のある値ではない（v0.4 はスピーカーもマイクの位置も変わったので、
  // 実機で測って決め直す。docs/esp32-firmware.md）。
  // 掛けた結果は int32 に収まるよう頭打ちにする（toRaw）。
  int32_t pdmRawScale;
};

// 版の判別のピン（devices/KiCad/toytalker_v0.4/PINMAP.md）。他の用途に使わない
constexpr int8_t HW_ID_PINS[3] = {14, 21, 47};

constexpr Config TABLE[] = {
  // hw     id     mic        clk  ws  data  右枠   倍率
  {"v0.4", 0b111, Mic::Pdm,  4,   -1,  5,   false, 6 * 16384},   // 先頭 = 知らない組み合わせのときの既定
};
constexpr size_t TABLE_SIZE = sizeof(TABLE) / sizeof(TABLE[0]);

inline const Config* findById(uint8_t id) {
  for (size_t i = 0; i < TABLE_SIZE; ++i)
    if (TABLE[i].hwId == id) return &TABLE[i];
  return nullptr;
}

inline const Config* current_ = &TABLE[0];
inline const Config& current() { return *current_; }

// PDM の倍率。試験のときだけシリアルの "MIC <倍>" で上書きできる（保存しない。再起動で表の値に戻る）
inline int32_t pdmScaleOverride_ = 0;
inline int32_t pdmScale() { return pdmScaleOverride_ ? pdmScaleOverride_ : current_->pdmRawScale; }

// setup() の最初に 1 回。マイクを初期化する前に呼ぶ
inline void load() {
  uint8_t id = 0;
  for (int i = 0; i < 3; ++i) pinMode(HW_ID_PINS[i], INPUT_PULLUP);
  delay(2);  // プルアップが効くのを待つ
  for (int i = 0; i < 3; ++i) id |= (digitalRead(HW_ID_PINS[i]) ? 1 : 0) << i;
  for (int i = 0; i < 3; ++i) pinMode(HW_ID_PINS[i], INPUT);  // 抵抗のある基板で流しっぱなしにしない
  const Config* found = findById(id);
  if (found) current_ = found;
  Serial.printf("[BOARD] hw=%s mic=%s hw_id=%u%s\n", current_->hw,
                current_->mic == Mic::Pdm ? "pdm" : "i2s", (unsigned)id,
                found ? "" : " (unknown; using default)");
}

// PDM の 16bit の 1 サンプルを「I2S の生の値」の単位へ（頭打ちあり）。ISR からも呼ぶ
inline int32_t IRAM_ATTR toRaw(int16_t s, int32_t scale) {
  const int64_t wide = int64_t(s) * scale;
  return wide > INT32_MAX ? INT32_MAX : wide < INT32_MIN ? INT32_MIN : int32_t(wide);
}

// PDM の 16bit を、その場で「I2S の生の値」と同じ 32bit へ広げる。data は samples × 4 バイトの領域で、
// 先頭の samples × 2 バイトに 16bit が入っている。後ろから広げるので読む前の値を上書きしない
inline void expandPdm(void* data, size_t samples, int32_t scale) {
  auto* bytes = static_cast<uint8_t*>(data);
  for (size_t i = samples; i-- > 0;) {
    int16_t s;
    memcpy(&s, bytes + i * 2, sizeof(s));
    const int32_t wide = toRaw(s, scale);
    memcpy(bytes + i * 4, &wide, sizeof(wide));
  }
}

}  // namespace board
