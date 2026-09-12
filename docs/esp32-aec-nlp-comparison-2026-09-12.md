# AEC残留エコーの比較準備（2026-09-12）

## 判断

最初の比較候補は残留エコー抑制の `AEC_NLP_LEVEL_NORMAL` → `AEC_NLP_LEVEL_AGGR`。採用確定ではない。参照時刻、FD_LOW_COST、filter_length=4、RMS 1,200 / 128ms、毎ターンの再作成、音量は維持する。

同日turn=18の無発声時の誤停止はout_sustained=1,410、turn=20の意図した「ちょっと待って」は1,463。固定閾値を引き上げるだけでは分離しにくい。詳細は [実機ログ比較](esp32-stream-end-investigation-2026-09-12.md) を参照。

## 実装とSDKの確認

- 参照はI2S TX完了callbackから、音量調整・クリップ後の実送信波形をauto-clear前に取得する。ネットワークで届いた時刻を再生時刻としてはいない。
- 24kHz参照をローパス・16kHz補間し、フィルター群遅延0.5msを補正。参照advance=16msは実測した音響遅延ではない。欠落・同期リセット0は絶対的な整列の正しさを保証しない。
- 問題の回と完走した回はともにAECを毎ターン再作成し、欠落・同期リセット0。固定遅延の変更を最初の修正とする証拠は不足している。
- インストール済みArduino ESP32 3.3.11のesp_aec.h / esp_aec_nlp.hで、FD、NORMAL=0、AGGR=1とconfig.nlp_levelを確認した。
- 現行は `aec_process()` を呼ぶ。[Espressif公式のESP32-S3 AEC説明](https://docs.espressif.com/projects/esp-sr/en/latest/esp32s3/acoustic_echo_cancellation/README.html) は、このAPIを線形処理＋非線形処理の一括呼び出しとしている。NLP呼び出しが欠けていると判断して二重に適用しない。
- 同公式説明でAGGRは残留エコーをより強く抑制する設定。ただし近端音声にも影響し得る。誤停止の減少だけで採用せず、普通の声での停止と反応速度も比較する。
- 現行ではAEC出力は割り込み判定に使用し、再生中のAEC出力をそのままSonioxへ送ってはいない。この変更の主な評価対象は割り込みの検出感度。

## 比較版

`AecMonitor.h` に `TOYTALKER_AEC_NLP_LEVEL` のビルド指定を追加。省略時は0=NORMAL、比較時は1=AGGR。設定文字列を起動時と各ターン開始時に記録する。任意の値やVERYAGGRを誤指定するとコンパイルを失敗させる。

PowerShell（arduino-cliはArduino IDE付属の実行ファイルを使用可能）:

```powershell
# A: NORMAL（Arduino IDEで通常ビルドする場合もこちら）
arduino-cli compile --fqbn esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=4M,PartitionScheme=no_fs,CDCOnBoot=cdc --build-path "$env:TEMP/toytalker_v07_build" devices/mcu/esp32_s3/toytalker_mini_v0.7

# B: AGGR（独立した出力先）
arduino-cli compile --fqbn esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=4M,PartitionScheme=no_fs,CDCOnBoot=cdc --build-property 'compiler.cpp.extra_flags=-DTOYTALKER_AEC_NLP_LEVEL=1' --build-path "$env:TEMP/toytalker_v07_aec_aggr" devices/mcu/esp32_s3/toytalker_mini_v0.7
```

ビルドディレクトリのbuild.options.jsonでも設定を確認する。書き込み時はポートと対象を再確認し、それぞれの出力ディレクトリを使用する。復旧はNORMAL版を書き戻す。端末は14:18に書き込んだNORMAL版のままで、比較版はまだ書き込んでいない。

## 比較の進め方と限界

厳密な同一音声の比較には、固定PCMの保存・再生経路が必要。現状のファームにはその試験用経路がなく、今回も追加していない。LLMへ同じ依頼をしても返答・波形・区切りが変わるので、同一音声の再現試験とはしない。

次の実機確認は、同じ配置・音量・話す距離でA/Bそれぞれの無発声再生と意図した割り込みを行う予備比較。声の反応が悪化する、確保失敗、フレーム欠落が増えるならNORMALへ戻す。A/Bの音声が違う点を記録し、改善の確定には固定PCM再生の追加か、複数回の比較が必要。

比較項目は誤停止数/試行数、声で停止できた数/試行数、AEC出力の持続値、検出後の録音開始時間、cpu_max_us/slow_frames、欠落・確保失敗。現行ログのtrigger_to_record_msは「発声開始からの反応時間」ではなく検出後の時間なので、声を拾うまでの遅れは別途評価する。

## 検証

AGGR版のビルド成功: Flash 1,475,838 / 2,031,616 bytes、静的RAM 67,096 bytes。AEC参照・ゲートの既存C++17コンパイル時テストも成功。音響的な抑制効果・声への反応・CPU余裕は、これらのテストだけでは確認できない。

NORMAL版も同じソースでビルド成功: Flash 1,475,842 / 2,031,616 bytes、静的RAM 67,096 bytes。

## 20:03 AGGR版の書き込み

ユーザーの依頼でCOM12（ESP32-S3、MAC 90:da:72:49:ba:e4）へAGGR版を書き込み、全書き込み領域のハッシュ検証に成功。build.options.jsonの `TOYTALKER_AEC_NLP_LEVEL=1` を確認した。再起動後のWi-Fi/Soniox接続とSTT送信を確認。受信開始前のAEC初期化ログは取得できていないため、次の会話の `[AEC] monitor start ... nlp=AGGR` でも確認する。音響比較は未実施。

`.local/serial-logs/COM12-20260912-141828.log` へ区切り付きで追記を再開。受信は20:03:56〜20:33:56の30分間。同じファイルへのtailは継続利用できる。常時受信ではない。
