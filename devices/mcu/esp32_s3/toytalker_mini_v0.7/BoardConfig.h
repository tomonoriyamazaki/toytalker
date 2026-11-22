#pragma once
// BoardConfig.h — 基板の版と、版で変わる値の表。
//
// ファームは全基板で 1 本（.bin も 1 つ）。基板の版は NVS の device/hw に持ち、起動時に読んで
// この表の 1 行を選ぶ。NVS は OTA で消えないので、USB で最初に書いたときに 1 回だけ版を書けばよい
// （tools/flash-published.sh --hw v0.3。受け口は .ino の pollSerial の "HW <版>"）。
// 鍵が無い・知らない版なら表の先頭（v0.2）として動く。配布済みの v0.2 機には鍵が無いので、
// この版が OTA で入っても今までどおり I2S のマイクで動く。
//
// 版を足すときはここに 1 行足す。表にあるのは版で違う値だけで、全基板で同じピン（アンプ・LED・
// ボタン・電源まわり）は .ino の #define のまま。版で変わったらこの表へ移す。
// v0.4 以降は基板の抵抗で版を自動判別する予定（docs/mcu.md の「次の基板改修で行うこと」）。
#include <Arduino.h>
#include <Preferences.h>
#include <string.h>

namespace board {

enum class Mic : uint8_t {
  I2sStd,  // I2S 標準モード（BCLK/WS/DIN）。32bit の枠に 18bit が左詰めで来る（SPH0645）
  Pdm,     // PDM（CLK/DIN）。ESP32-S3 の PDM→PCM 変換で 16bit が来る（SPH0655）
};

struct Config {
  const char* hw;       // サーバーへ知らせる版の名前（鍵発行の要求の hw）。NVS の値と同じ
  Mic mic;
  int8_t micClk;        // I2S の BCLK / PDM の CLOCK
  int8_t micWs;         // I2S の WS。PDM では使わない（-1）
  int8_t micData;
  bool pdmRightSlot;    // PDM でどちらの枠を読むか（マイクの SELECT の配線で決まる）
  // PDM の 16bit 値に掛けて「I2S の生の値」と同じ単位にする倍率（16384 で、>>14 した後が元の 16bit と同じ）。
  // v0.2 の 0645 は 18bit が来て >>14 の後も 18bit の大きさ（16bit の 4 倍）なので、データシートの
  // 感度の差（11dB = 3.5 倍）まで合わせるなら 14 倍になる。v0.3 の 6 倍は仮の値で、根拠のある値では
  // ない（スピーカーと配置が決まってから実測で決める。docs/esp32-firmware.md の冒頭）。
  // 掛けた結果は int32 に収まるよう頭打ちにする（toRaw）。
  int32_t pdmRawScale;
};

constexpr Config TABLE[] = {
  // hw     mic           clk  ws  data  右枠   倍率
  {"v0.2", Mic::I2sStd,  48,  33,  34,  false, 0},       // 先頭 = 鍵が無いときの既定
  {"v0.3", Mic::Pdm,     48,  -1,  34,  false, 6 * 16384},
};
constexpr size_t TABLE_SIZE = sizeof(TABLE) / sizeof(TABLE[0]);

inline const Config* find(const char* hw) {
  for (size_t i = 0; i < TABLE_SIZE; ++i)
    if (strcmp(TABLE[i].hw, hw) == 0) return &TABLE[i];
  return nullptr;
}

inline const Config* current_ = &TABLE[0];
inline const Config& current() { return *current_; }

// PDM の倍率。試験のときだけシリアルの "MIC <倍>" で上書きできる（保存しない。再起動で表の値に戻る）
inline int32_t pdmScaleOverride_ = 0;
inline int32_t pdmScale() { return pdmScaleOverride_ ? pdmScaleOverride_ : current_->pdmRawScale; }

// setup() の最初に 1 回。マイクを初期化する前に呼ぶ
inline void load() {
  String saved;
  Preferences prefs;
  if (prefs.begin("device", true)) {  // 名前空間がまだ無い本体では失敗する（= 鍵なし）
    saved = prefs.getString("hw", "");
    prefs.end();
  }
  const Config* found = saved.isEmpty() ? nullptr : find(saved.c_str());
  if (found) current_ = found;
  Serial.printf("[BOARD] hw=%s mic=%s nvs=%s%s\n", current_->hw,
                current_->mic == Mic::Pdm ? "pdm" : "i2s",
                saved.isEmpty() ? "(none)" : saved.c_str(),
                (!saved.isEmpty() && !found) ? " (unknown; using default)" : "");
}

// 版を NVS に書く。表に無い版は書かない。戻り値: 書いて値が変わったら true（呼び出し側が再起動する）
inline bool save(const char* hw) {
  if (!find(hw)) {
    Serial.printf("[BOARD] unknown hw=%s; not saved\n", hw);
    return false;
  }
  if (strcmp(current_->hw, hw) == 0) {
    Serial.printf("[BOARD] hw=%s unchanged\n", hw);
    return false;
  }
  Preferences prefs;
  if (!prefs.begin("device", false)) {
    Serial.println("[BOARD] nvs open failed; not saved");
    return false;
  }
  const bool ok = prefs.putString("hw", hw) > 0;
  prefs.end();
  Serial.printf("[BOARD] hw=%s saved=%d\n", hw, ok);
  return ok;
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
