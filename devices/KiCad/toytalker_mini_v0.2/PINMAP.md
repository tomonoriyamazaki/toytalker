# ToyTalker Mini v0.2 ピンマップ

> **このファイルの役割: 「GPIOの正」。** ピン割当の唯一の基準+ファームv0.5用のdefine。ピンを変えたら必ずここを更新する。部品の値 → PARTS_LIST.md

v0.1からの変更点: I2Sマイク/アンプ分離、GPIO3(ストラップ)解放、電池残量ADC・充電STAT追加、ネット名誤記修正。

## v0.2 割当表（2026-08-30 配置最適化で改訂。旧v0.2案からの変更は★）

| 信号 | GPIO | v0.1 | 備考 |
|---|---|---|---|
| MIC_BCLK | **48** ★ | 4(共有) | I2S0(録音)。左列下段=マイクへ最短 |
| MIC_WS | **33** ★ | 3(共有) | |
| MIC_DATA | **34** ★ | 9 | SPH0645 DOUT |
| AMP_BCLK | **36** ★ | 4(共有) | I2S1(再生)。下辺=アンプへ南ルート |
| AMP_WS | **37** ★ | 3(共有) | |
| AMP_DIN | **38** ★ | 5 | MAX98357 DIN |
| AMP_SD | **39** ★ | 6 | アンプシャットダウン |
| LED | **47** ★ | 8 | R8→D1 |
| BUTTON(S2) | **35** ★ | 7 | R7経由 |
| BOOT(S3) | **0** | 0 | ストラッピング(固定) |
| VBAT_ADC | **1** | — | ADC1_CH0(固定。WiFi中測定可はGPIO1〜10のみ) |
| BOARD_TEMP | **2** | — | ADC1_CH1(固定) |
| CHG_STAT1 | **13** | — | BQ25185 STAT1+100kプルアップ |
| CHG_STAT2 | **14** | — | BQ25185 STAT2+100kプルアップ |
| USB D-/D+ | 19/20 | 19/20 | USB-Serial/JTAG(固定) |
| (解放) | 3,4,5,6,7,8,9,10,11,12 | | 旧割当は全て未接続に。3はストラップ、他は将来用 |

**回避ピン**: GPIO3(ストラップ)/IO26(PSRAM CS)/IO45・46(ストラップ)/TXD0・RXD0(デバッグ温存)
※IO33〜48系はoctal PSRAM機(R8)制約の対象だが、本機N4R2(quad)は全て使用可(データシート確認済み)

## 制約検証(機械チェック済み)

- ✅ ストラップピン: GPIO0はBOOTボタン専用(正しい用途)。GPIO3は解放。GPIO45/46は未使用のまま
- ✅ VBAT_ADC=GPIO1、BOARD_TEMP=GPIO2はADC1系(GPIO1〜10)→ WiFi動作中も測定可能
- ✅ 新規使用の1,2,10,11,12,13,14はv0.1で全て未接続(PCBネットリストで確認。GPIO2は2026-08-19追加)
- ✅ GPIO19/20(USB)・GPIO43/44(UART0、将来のデバッグ用)は温存
- ⚠️ IO26/IO33〜37は内蔵PSRAM/フラッシュとの兼ね合いがあるため今回は使わない(全て回避済み)

## ファームv0.5側の対応(Phase 4)

```cpp
// v0.2基板 (2026-08-30 配置最適化ピン)
#define PIN_MIC_BCLK 48
#define PIN_MIC_WS   33
#define PIN_MIC_DATA 34
#define PIN_AMP_BCLK 36
#define PIN_AMP_WS   37
#define PIN_AMP_DIN  38
#define PIN_AMP_SD   39
#define PIN_LED      47
#define PIN_BUTTON   35
#define PIN_VBAT_ADC 1
#define PIN_BOARD_TEMP 2
#define PIN_CHG_STAT1 13
#define PIN_CHG_STAT2 14
```
