# ToyTalker Mini v0.3 ピンマップ

> **このファイルの役割: 「GPIOの正」。** ピン割当の唯一の基準+ファーム用のdefine。ピンを変えたら必ずここを更新する。部品の値 → PARTS_LIST.md

v0.2 からの変更点（2026-11-08）: マイクが I2S（SPH0645）→ **PDM（SPH0655LM4H-1-8）** になり、WS 線が不要に。**GPIO33 は未接続（解放）**。ピン番号は他に変えていない。

## v0.3 割当表（v0.2 からの変更は ★）

| 信号 | GPIO | v0.2 | 備考 |
|---|---|---|---|
| MIC_CLK | **48** | 48 (MIC_BCLK) | ★ PDM クロック出力（SPH0655 の CLOCK）。配線は v0.2 の BCLK と同じ |
| (解放) | **33** | 33 (MIC_WS) | ★ PDM に WS は無い。回路図は no_connect |
| MIC_DATA | **34** | 34 | ★ PDM データ入力（SPH0655 の DATA）。マイクの SELECT は GND 固定 |
| AMP_BCLK | **37** | 37 | I2S1(再生)。MAX98357 BCLK |
| AMP_WS | **36** | 36 | MAX98357 LRCLK |
| AMP_DIN | **38** | 38 | MAX98357 DIN |
| AMP_SD | **39** | 39 | アンプシャットダウン |
| LED | **40** | 40 | R8(1.5kΩ)→D1 |
| BUTTON(S2) | **35** | 35 | R7経由 |
| BOOT(S3) | **0** | 0 | ストラッピング(固定) |
| VBAT_ADC | **1** | 1 | ADC1_CH0(固定。WiFi中測定可はGPIO1〜10のみ) |
| BOARD_TEMP | **2** | 2 | ADC1_CH1(固定) |
| CHG_STAT1 | **13** | 13 | BQ25185 STAT1+100kプルアップ |
| CHG_STAT2 | **14** | 14 | BQ25185 STAT2+100kプルアップ |
| USB D-/D+ | 19/20 | 19/20 | USB-Serial/JTAG(固定) |
| (解放) | 3,4,5,6,7,8,9,10,11,12,33 | | 3はストラップ、他は将来用 |

**回避ピン**: GPIO3(ストラップ)/IO26(PSRAM CS)/IO45・46(ストラップ)/TXD0・RXD0(デバッグ温存)
※IO33〜48系はoctal PSRAM機(R8)制約の対象だが、本機N4R2(quad)は全て使用可(データシート確認済み)

## ファーム側の対応（v0.3 基板で必要。未実装）

v0.7 の録音は `i2s_std.h`（I2S 標準モード、BCLK/WS/DIN の 3 線）。v0.3 基板では **`i2s_pdm.h` の PDM RX モード（CLK/DIN の 2 線）** に替える。ESP32-S3 の PDM RX は I2S0 だけ対応（再生の I2S1 はそのまま）。

```cpp
// v0.3基板。v0.2 と同じ番号で、PIN_MIC_WS だけ無くなる
#define PIN_MIC_CLK  48   // PDM clock (v0.2 の PIN_MIC_BCLK と同じ配線)
#define PIN_MIC_DATA 34   // PDM data
#define PIN_AMP_BCLK 37
#define PIN_AMP_WS   36
#define PIN_AMP_DIN  38
#define PIN_AMP_SD   39
#define PIN_LED      40
#define PIN_BUTTON   35
#define PIN_VBAT_ADC 1
#define PIN_BOARD_TEMP 2
#define PIN_CHG_STAT1 13
#define PIN_CHG_STAT2 14
```

- **クロック**: 16kHz × 128 = 2.048MHz（`i2s_pdm_rx_clk_config_t` の `dn_sample_mode` 既定で 16kHz 指定 → 2.048MHz）。SPH0655 は 1.2〜4.8MHz、2軍の SD18OB261-060 は 1.2〜3.5MHz なので両方に入る（×64 = 1.024MHz は両方とも下限未満で不可）。
- **左右**: マイクの SELECT を GND に落としているので、データは片側のスロットにだけ出る。ESP32 の PDM RX をモノラル（`I2S_PDM_SLOT_LEFT` か `RIGHT`）で受け、どちらが鳴るかは実機で確認する（Knowles は SELECT=L で「クロックの立ち下がり側」）。
- **ゲイン**: SPH0655 の感度は -37dBFS（0645 は -26dBFS）。同じ声で約 11dB 小さい 16bit 値が来るので、v0.5 で入れた DC 除去の後に約 ×3.5（+11dB）する。SD18OB261-060（-26dBFS）なら不要。
- **v0.2 基板との両対応**: `sketch.yaml` のビルド定数（例 `-DTOYTALKER_BOARD=3`）で録音の初期化だけ切り替えると、v0.2 機の OTA 配布と v0.3 機を同じソースで出せる。
- 温度・電池・充電 STAT の読み方は v0.2 と同じ（[v0.2 の PINMAP.md](../toytalker_mini_v0.2/PINMAP.md) のメモ）。
