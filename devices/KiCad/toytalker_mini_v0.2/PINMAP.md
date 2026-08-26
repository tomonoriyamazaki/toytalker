# ToyTalker Mini v0.2 ピンマップ

v0.1からの変更点: I2Sマイク/アンプ分離、GPIO3(ストラップ)解放、電池残量ADC・充電STAT追加、ネット名誤記修正。

## v0.2 割当表

| 信号 | GPIO | v0.1 | 変更 | 備考 |
|---|---|---|---|---|
| MIC_BCLK | **4** | 4(共有) | 維持 | I2S0(録音専用) |
| MIC_WS | **5** | 3(共有) | 変更 | GPIO3(JTAGストラップ)から退避 |
| MIC_DATA | **9** | 9 | 維持 | SPH0645 DOUT |
| AMP_BCLK | **10** | 4(共有) | 新規 | I2S1(再生専用)。ここから同時動作可能に |
| AMP_WS | **11** | 3(共有) | 新規 | |
| AMP_DIN | **12** | 5 | 変更 | MAX98357 DIN |
| AMP_SD | **6** | 6 | 維持 | アンプシャットダウン |
| LED | **8** | 8 | 維持 | 抵抗値は増やして減光(B8) |
| BUTTON(S2) | **7** | 7 | 維持 | |
| BOOT(S3) | **0** | 0 | 維持 | **ネット名を「GPIO27」→「GPIO0_BOOT」に修正**(誤記) |
| VBAT_ADC | **1** | — | 新規 | ADC1_CH0。470kΩ×2分圧+0.1µF |
| BOARD_TEMP | **2** | — | 新規 | ADC1_CH1。NTCサーミスタTH2(10k)+10kプルアップ分圧+0.1µF。本体温度の可視化用 |
| CHG_STAT1 | **13** | — | 新規 | BQ25185 STAT1(O.D.)+100kプルアップ→3V3 |
| CHG_STAT2 | **14** | — | 新規 | BQ25185 STAT2(O.D.)+100kプルアップ→3V3 |
| USB D-/D+ | 19/20 | 19/20 | 維持 | USB-Serial/JTAG |
| (解放) | 3 | WS共有 | **未接続に** | ストラップピンをクリーンに |

## 制約検証(機械チェック済み)

- ✅ ストラップピン: GPIO0はBOOTボタン専用(正しい用途)。GPIO3は解放。GPIO45/46は未使用のまま
- ✅ VBAT_ADC=GPIO1、BOARD_TEMP=GPIO2はADC1系(GPIO1〜10)→ WiFi動作中も測定可能
- ✅ 新規使用の1,2,10,11,12,13,14はv0.1で全て未接続(PCBネットリストで確認。GPIO2は2026-08-19追加)
- ✅ GPIO19/20(USB)・GPIO43/44(UART0、将来のデバッグ用)は温存
- ⚠️ IO26/IO33〜37は内蔵PSRAM/フラッシュとの兼ね合いがあるため今回は使わない(全て回避済み)

## ファームv0.5側の対応(Phase 4)

```cpp
// v0.2基板 (I2S分離)
#define PIN_MIC_BCLK 4
#define PIN_MIC_WS   5
#define PIN_MIC_DATA 9
#define PIN_AMP_BCLK 10
#define PIN_AMP_WS   11
#define PIN_AMP_DIN  12
#define PIN_AMP_SD   6
#define PIN_LED      8
#define PIN_BUTTON   7
#define PIN_VBAT_ADC 1
#define PIN_BOARD_TEMP 2
#define PIN_CHG_STAT1 13
#define PIN_CHG_STAT2 14
```
