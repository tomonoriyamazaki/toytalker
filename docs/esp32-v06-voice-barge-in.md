# v0.6 音声介入・第一弾（2026-09-09）

安定版v0.5は変更せず、`devices/mcu/esp32_s3/toytalker_mini_v0.6/toytalker_mini_v0.6.ino` で検証する。ブランチは `feature/firmware-v0.6-voice-barge-in`。OTAは保留。

**現在のソースは、同時録音を続けつつ再生終了時にRXを解放・次のSTT開始時に再確保する比較試験版（`VOICE_RX_TEST_MODE=VoiceRxTestMode::MonitorResetEachTurn`）。22:42にユーザーから10ターン問題なしとの報告があり、ファームの `turn=10` の正常完了も確認。今後の音声介入テストの基準とする。** RXバッファ半減だけでは22:23の2ターン目に低速化・受信タイムアウトが再現していた。RXをターン間で保持する影響を支持する結果だが、根本原因の特定や全条件での安定性を保証するものではない。

`VOICE_RX_TEST_MODE` を `VoiceRxTestMode::ReleaseDuringPlayback` に戻して再ビルドすると、約8ターン正常だったRX解放・通常RXバッファの設定に戻る。自分の再生音による誤停止が確認されたため、現在も `VOICE_BARGE_DETECT_ONLY=true` とし、自動ミュート・音声による中断は無効。

HTTP chunked受信と異常終了処理も修正済み。RXを停止するだけでは低速化が残り、RX解放・ターンごとの再確保で改善が報告された。最新の実機結果は末尾の22:42の記録を参照。

## 実装した動作

- MonitorモードではI2S0のマイクをI2S1の再生と同時に動かす。再生中は専用タスク、通常録音中はloopが読む。停止通知を待ってから読み取り担当を切り替える。現在の比較試験はRXバッファ4枚を維持し、再生終了時にマイクのドライバも解放して次のSTTで再確保する。
- マイク音声を20msごとに読み、フレーム平均を除去したRMSを計算する。再生PCMの振幅との比較ではなく、マイク上の絶対音量で判定する。
- 初期値はRMS 6000以上が120ms（6フレーム）連続した場合に発火。音声のI2S書き込み開始後、最初の約500ms分は判定しない。物理的な発声開始時刻を計測した値ではない。
- 発火時は先にアンプをミュートし、既存のボタンと共通の割り込みフラグを立てる。相槌・本文受信・リング残量の再生待ち・終了flushに中断判定を入れた。
- 監視タスクは起動時に一度作成し、ターンごとの作成・削除をしない。タスク確保失敗はボタンのみへフォールバック。I2S設定・Lambda接続タスク確保の失敗も検出する。
- TTSセグメント間の400ms、既存メモリ・終了計測は維持する。

## 調整する定数

v0.6スケッチの `VOICE_RX_TEST_MODE` と `VOICE_BARGE_` 定数を変更して再ビルドする。スマホからの変更は未実装。

| 定数 | 現在の値 | 用途 |
|---|---|---|
| `VOICE_BARGE_ENABLED` | true | 音声監視タスクを使用する |
| `VOICE_BARGE_DETECT_ONLY` | true | 検出ログだけで音を止めない。調整後falseで介入を再試験 |
| `VOICE_RX_TEST_MODE` | `VoiceRxTestMode::MonitorResetEachTurn` | 比較条件を1か所で選ぶ。復旧は `VoiceRxTestMode::ReleaseDuringPlayback` |
| `VOICE_RX_PAUSE_DURING_PLAYBACK` | false（モードから算出） | 再生中のマイク停止。直接編集しない |
| `VOICE_RX_RELEASE_WHEN_PAUSED` | false（モードから算出） | 停止時のドライバ解放。直接編集しない |
| `VOICE_RX_RESET_AFTER_PLAYBACK` | true（モードから算出） | 再生後にRXを解放。次のSTTで再確保。直接編集しない |
| `MIC_DMA_COUNT` | 4（モードから算出） | Small/ResetEachTurnモードは4枚、ほかは従来の8枚。通常STTにも適用 |
| `MIC_DMA_FRAMES` | 512 | RXバッファ1枚のサンプル数。従来と同じ |
| `VOICE_BARGE_RMS` | 6000 | 大きいほど反応しにくい。未校正の出発点 |
| `VOICE_BARGE_HOLD_MS` | 120 | 閾値を連続して超える音声の長さ |
| `VOICE_BARGE_WARMUP_MS` | 500 | 再生開始付近の判定抑制 |

## 実機確認手順

現在の受信遅延の比較試験と結果は末尾の22:23以降の記録を参照。以下の音量計測手順はMonitorモードの場合。

1. Arduino IDEでv0.6スケッチを開く。ESP32S3 Dev Module / Flash 4MB / QIO 80MHz / QSPI PSRAM / No FS 4MB (2MB APP x2) / USB CDC Enabled。その他はv0.5で動作した設定を維持する。
2. 普通に会話し、誰も話しかけない再生で勝手に停止しないか確認する。`[VOICE] rms=... max=... threshold=... armed=... frames=... read_errors=...` を取得する。
3. 再生開始から1秒ほど待ち、近くで「ねえ、ちょっと待って」と少し大きめに話す。現在の計測モードでは音量変化を確認する。調整後 `DETECT_ONLY=false` にした試験で `trigger` と停止、録音復帰を確認する。
4. 相槌中、本文の途中、長い返答の終盤でも確認する。ボタンによる停止も確認する。
5. 誤反応なら閾値を上げる。反応しなければ人の声のログを見て下げる。比較しづらい場合は `DETECT_ONLY=true` で再生だけ／人の声が重なる場合を測る（発火ログは各ターン1回）。
6. 10〜20ターン程度継続し、`[DIAG] pre-connect` と `[MEM]`、音切れ、マイク読取エラーを確認する。`frames` は正常時おおむね毎秒50増加する。実機の誤検出率・反応時間・耐久性はまだ未検証。

`[VOICE] trigger_to_record_ms` は検出から録音モード設定までの時間。`ws_ready=0` なら送信可能とは限らない。既存の `amp_off_ms` は後処理側の時刻で、音声介入で先行ミュートした時刻ではない。中断時のDMA_TAILは無効として扱う。

## 今回の限界と注意点

- AEC・人の声の識別は未実装。自身の再生音、机を叩く音、周囲の大きな音でも反応し得る。声と再生音の音量分布が重なる場合、閾値調整だけでは解決できない。
- 検出前の音声の保存・遡り送信は未実装。録音復帰時に古いRXデータを捨てるため、話し始めは欠け得る。まず「声で停止する」試験として扱う。
- アンプのミュートは監視タスクで行うが、録音復帰はメイン処理の終了を待つ。相槌中のLambda TLS接続待ち、HTTPヘッダー読み取り、Soniox再接続などでは復帰が遅くなる可能性がある。実行中の接続タスクが使うclientやrequestを途中破棄しない。
- Monitorモードでは再生中もRX DMA（Small/ResetEachTurn: 4×512×4 bytes、Original: 8×512×4 bytes）と監視タスクの4KBスタック等を保持する。v0.5より内部RAMに負荷がかかる。静的RAMのビルド表示だけではこの増分を評価できない。
- ESP32-S3はI2S APLL非対応。元の `use_apll=true` はこのターゲットではドライバで採用されない。v0.6のfalseは標準クロックの明示であり、APLL競合を修復したという意味ではない。根拠: [SoC定義](https://github.com/espressif/esp-idf/blob/v5.5.4/components/soc/esp32s3/include/soc/soc_caps.h)、[legacyドライバ](https://github.com/espressif/esp-idf/blob/v5.5.4/components/driver/deprecated/i2s_legacy.c) の `i2s_config_transfer`。

## 検証と復旧

第一弾の初回ビルドはArduino ESP32コア3.3.10で成功。Flash 1,394,747 / 2,031,616 bytes（68%）、静的RAM 50,360 bytes。v0.5のソースが安定版コミットから変更されていないことも確認済み。初回実機試験で以下の動作とクラッシュが報告された。

閾値到達までの連続時間、短いスパイクの除外、ウォームアップ・読取エラー後のリセットを `tests/voice_level_gate_test.cpp` のコンパイル時テストで確認する。これは音響判定や並列I2Sの実機試験を代替しない。

上記テストは手元のXtensa C++コンパイラーで `-std=c++17 -fsyntax-only tests/voice_level_gate_test.cpp` を実行し、3件のstatic_assertが成功した。

ビルド:

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=4M,PartitionScheme=no_fs,CDCOnBoot=cdc --build-path "$env:TEMP/toytalker_v06_build" devices/mcu/esp32_s3/toytalker_mini_v0.6
```

戻す場合は、同じボード設定で変更していないv0.5スケッチを開いてUSBで書き込む。全Flash消去は不要。v0.5安定版の基準コミットは `cb0d137`。

## 初回実機ログと録音復帰の修正（2026-09-09 20:13）

ユーザー提供の2枚のスクリーンショットを確認。

- 音量検出: `rms=29006 threshold=6000 hold_ms=120`、監視停止時 `frames=112 read_errors=0 stack_free=1076`。`trigger_to_record_ms=33 ws_ready=1` で録音復帰し、次のSTT結果も出ている。この停止はクラッシュではない。検出対象がユーザーの声か再生音かはログ単独では特定しない。
- 別の復帰時: `WS not yet connected, waiting...` → `Connected to Soniox!` の直後、`Core 1 panic'ed (Double exception)` が発生して再起動。音量判定とは別の異常。
- クラッシュしたELFのSHA256は `2e6d04de8dd52a113987887afc61eb38a88db292812803e4d22c77c42e2e01b3`。Arduino IDEキャッシュ内のELFで照合できた。PC `0x4038b596` は `_xt_context_save`、バックトレースには `esp_wifi_internal_tx`、`esf_buf_alloc_dynamic`、`esf_buf_alloc`、`ieee80211_alloc_tx_buf` が含まれる。
- 同ELFの逆アセンブルでは、`loop()` のスタックフレームは3152 bytes、`sendToLambdaAndPlay()` は288 bytes、`startSTTRecording()` は2128 bytes。3段だけで5568 bytesを占めた状態でWebSocket/TLSへ入る。Arduino loopタスクは8192 bytes。スタック不足は有力候補だが、このダンプだけで根本原因を確定したわけではない。

今回追加した復帰時の `stale[512]` と、既存loop内の `raw[512]` / `pcm[512]` が通信呼び出し中もスタックを占有する構成を修正。loop専用の静的バッファ `sttRaw` / `sttPcm`（合計3072 bytes）へ移し、古いRXデータの破棄にも同じrawバッファを使う。音声監視タスクは別バッファを使用するため共有しない。loopのスタック容量自体は増やさない。

`[STACK] before_stt_connect / soniox_connected / soniox_start_sent min_free=... bytes` を追加。値はそのタスクの起動以来の最小残量で、現在の残量ではない。修正後は再接続を伴う録音復帰を繰り返し、再起動の有無とこのログを確認する。音量閾値は原因を混ぜないため6000のまま維持した。

修正後ビルド成功: Flash 1,394,859 bytes、静的RAM 53,432 bytes。逆アセンブルで `loop()` は80 bytes、`startSTTRecording()` は96 bytes、`sendToLambdaAndPlay()` は288 bytesとなり、上記3段のフレーム合計は5568→464 bytes（5104 bytes削減）。これは通信ライブラリ等を含めた総スタック使用量ではない。音量判定の3件のコンパイル時テストも成功。クラッシュが解消したかは修正版の実機試験待ち。

## 再試験: 誤検出と本文待ち時間（同日20:23〜20:25）

ユーザーが再生音で勝手に停止すること、ターンを重ねると本文再生までが遅くなることを報告。提供されたturn 1・2・4・5のログではパニック再起動なし。`[STACK] min_free` は4160→4016 bytes、音声監視の `read_errors=0`。スタック修正後の改善を支持するが、長期安定性は未確認。

| turn | trigger RMS | 検出→録音モード設定 | 備考 |
|---|---:|---:|---|
| 1 | 38139 | 138ms | 復帰時Soniox接続待ちを経て送信 |
| 2 | 15014 | 66ms | この時点のws_ready=0。接続完了までさらに約1.2秒 |
| 4 | 9269 | 9695ms | 相槌中に誤発火。接続・送信タスクを待ってから復帰 |
| 5 | 23246 | 66ms | ws_ready=0。接続完了までさらに約1.1秒、再生中のunderrunも発生 |

RMS 6000は再生音でも超える。単に閾値を上げれば人の声を確実に識別できるわけではない。turn 4の約9.7秒は検出の遅さではなく、検出後もLambdaタスクとSoniox接続を待つ時間。元の `Headers read, first audio byte incoming` は中断でヘッダー読取をスキップしても出ていたため、実際の音声到着を示すログではなかった。

この段階では固定閾値の自動停止を無効化し、次を計測する版へ変更した。

- `[LATENCY] lambda_connect_ms`: DNS/TCP/TLSを含むconnect呼び出し時間と成功有無。
- `[LATENCY] lambda_send_ms`: HTTPリクエスト書き込み時間・実書き込みバイト数。短い書き込みは成功扱いにしない。
- `[LATENCY] headers_ms`: 本文前のヘッダー読み取り処理に入ってからの時間。中断有無も表示。
- `[LATENCY] first_pcm_chunk_ms`: ターン開始（Lambda送信関数入口）から最初のPCM読み取りチャンクが返るまで。最初のネットワーク1バイトの到着時刻ではない。
- `[LATENCY] first_tts_i2s_ms`: ターン開始から最初の本文PCMをI2Sへコピーし終わるまで。相槌は対象外。スピーカーの発声開始時刻ではない。
- `[PCM_TIMING]`: セグメントごとの処理時間、PCM読み取り時間、リングが満杯の待ち、`ws.loop()` の時間、未処理バイト数。読み取り時間はサーバー生成・ネットワーク・タスク実行待ち等を区別しない。途中で割り込んだ場合はサマリが出ないことがある。

まず同じ場所・音量で、黙って3ターンほど最後まで再生し、停止なしでも遅延が増すか確認する。その後、発話を重ねた区間のRMSを比較する。電波・サーバー・監視負荷のどれが主因かは未確定。必要なら同じv0.6で `VOICE_BARGE_ENABLED=false` にした比較を行う（RX常設は変わらないため、v0.5と完全同条件ではない）。

中断リクエストが接続中に来た場合、接続が戻った後は不要なPOSTを送らないようにした。ただし進行中のconnectを中断できるようにした変更ではない。client/requestの寿命を保つための待ちは残る。この待ちの解消は接続処理の構造を見直す別の課題。

計測モード版のビルド成功: Flash 1,396,083 bytes（68%）、静的RAM 53,448 bytes。音量判定テスト成功、v0.5は変更なし。その後の実機結果は以下。

## v0.5との比較後: 再生中のRXを止める試験（同日21:05〜21:06）

ユーザーから同条件のv0.5では問題なく、v0.6の1ターン目は正常だが2ターン目は明らかに遅いとの報告。自動停止しない計測モードでも再現しており、誤検出による中断だけでは説明できない。

| v0.6のターン | 同じ53,686 bytesのPCM読み取り | underruns | RSSI平均 / 最小 | マイクread_errors |
|---|---:|---:|---|---:|
| 1 | 92ms（segment id=2） | 0 | -77 / -80 | 0 |
| 2 | 1,618ms（segment id=3） | 13 | -74 / -78 | 0 |

2ターン目の別セグメント（97,802 bytes）も読み取り2,519ms。いずれも `ring_wait_ms=0`、`ws_ms=0〜1` で、受信待ち側に時間が偏っている。RSSIは2ターン目のほうが良いため、電波の弱さだけを主因と扱わずv0.6の変更を優先して調べる。`read_ms` は待ち・処理・スケジューリングを含むため、これだけで回線やI2Sのどちらが原因かは確定しない。

次の比較用に `VOICE_RX_PAUSE_DURING_PLAYBACK` を追加し、trueを既定値にした。

- STT送信停止後・再生開始前に `i2s_stop(I2S_NUM_0)` を呼ぶ。音声監視タスクは起動せず待機する。
- RXドライバ、DMAバッファ、監視タスクのスタック・セマフォは保持する。メモリ解放による改善と同時録音の動作による影響を混ぜないため、v0.5と同じアンインストールにはしない。
- 正常終了・ボタン中断・再生設定失敗・Lambda接続失敗からのSTT開始時に、停止していたRXを `i2s_start(I2S_NUM_0)` で再開する。再開失敗時は録音可能と表示せずエラーを出す。
- 既存のスタック対策、通信処理、400msの間、受信時間の計測は維持する。v0.5のソースは変更しない。

停止と再開のAPIは [ESP-IDF v5.5.4 legacy I2Sドライバ](https://github.com/espressif/esp-idf/blob/v5.5.4/components/driver/deprecated/i2s_legacy.c) の実装で確認した。RXの停止は対応するI2S受信とGDMAを止め、ドライバやDMAバッファは解放しない。停止中に別タスクからi2s_readを呼ばない構成にする。

比較試験手順:

1. このv0.6を同じArduino設定で書き込み、同じ場所・音量で3〜5ターン会話する。現在の設定中は声による停止・再生中のRMSログが出ないのが正常。
2. 各再生終了時の `[VOICE_TEST] rx_paused_for_playback=1`、`[PCM_TIMING]`、`[STATS]` を確認する。続く `[VOICE_TEST] mic resumed for STT` と次の録音・送信も確認する。
3. 遅さが消えれば、マイク同時動作・監視処理・その開始停止の影響を次に細分化する。残れば、保持しているメモリや通信処理など、ほかの差分を調べる。いずれも単独の原因確定にはしない。

この変更は比較用であり、音声介入を有効にした状態の修復ではない。実機結果は未取得。

比較試験版のビルド成功: Arduinoコア3.3.10、Flash 1,396,491 / 2,031,616 bytes（68%）、静的RAM 53,448 bytes。音量判定のコンパイル時テスト成功、v0.5が `cb0d137` から変更されていないことを確認した。

## RX停止中も再現: 受信フレームの同期喪失（同日21:20〜21:23）

3枚のスクリーンショットを確認。1ターン目は `rx_paused_for_playback=1`、`underruns=0`。63,184 bytesのPCM読み取り152ms、152,874 bytesは386msで正常に完了し、`mic resumed for STT` も記録された。

2ターン目も `rx_paused_for_playback=1` だが、`Unknown type: 0xCE`、長さ605,166,346など不正なフレームが連続。さらに `type=0x02 length=-33161245` を音声として処理している。負数表示はunsigned値4,261,806,051を `%d` で出していたためであり、負の長さを直接受信したという意味ではない。最後は `expected=8192 got=1467` の途中読みとなり、`wall_ms=33586 read_ms=27414 ws_ms=6064 remaining=4261461987`、`underruns=22`。クラッシュ再起動の記録ではなく、異常な受信処理から録音へ戻った記録。

マイクRX・RMS監視が停止した条件でも再現したため、それらの実行負荷だけでは説明できない。保持したメモリ等を含む他のv0.6差分まで除外したわけではない。

コード上で確認した問題（v0.5から引き継いだ受信処理にも存在する）:

- HTTPチャンク末尾のCR/LFを、1バイト以上到着しただけで2回readしていた。両方を取得したか・内容がCRLFかを確認しない。サイズ行も終端到着を確認せず、部分的な16進数字だけで受理する経路がある。
- PCM途中読みやstereoバッファ確保失敗を、上位が正常継続する戻り値で返していた。未消費のPCMを次の5バイトヘッダーとして読むと、今回のような不明な種類・巨大な長さになり得る。
- 不明な種類を受けると、不正な長さのままmallocしてスキップしようとしていた。確保できなければ本文を消費せず次のヘッダーへ進むため、同期を失った状態で繰り返す。

今回の画像には最初に同期が崩れた箇所は写っていない。上記は修正すべき具体的な不具合だが、v0.6の2ターン目から遅くなる発端を確定したものではない。

修正内容:

- `ChunkedBodyDecoder.h` を追加。サイズ行、データ、末尾CRLF、ゼロチャンク、trailerの状態を保持し、TCP/TLSがどこで分割されても必要なバイトを待つ。ヒープ確保なし。データはまとめて読み取る。
- 無通信10秒・切断・中断・書式異常を終端エラーとし、同じ応答で次のフレーム読み取りを再開しない。10秒はデータ進捗からの時間とし、少しずつ届いている音声を呼び出し開始からの時間だけで打ち切らない。
- HTTPヘッダーは完全な行を読み、HTTP 200とTransfer-Encoding: chunkedを確認してから本文へ進む。途中ヘッダーを本文と誤認しない。
- バイナリ長はunsignedのシフトで復元・表示。種類は0x01/0x02のみ、メタデータは1〜4096 bytes、PCMは1フレーム16 MiB以下を受理する。PCM上限はストリーミング単位の健全性チェックで、その大きさを一括確保するものではない。
- PCM・メタデータは全量処理できた場合のみ成功。異常時はアンプをミュートし、リング残量を破棄して応答を閉じ、通常録音へ戻す。壊れたデータを別の音声フレームとして再生し続けない。
- `[STREAM_ERROR]` に理由・body_offset・読取予定/実績、不正なフレームの場合は5バイトの生ヘッダーを出す。次の障害ではこの最初の行と直前のPCMログを確認する。

HTTPの区切り仕様は [RFC 9112 §7.1](https://www.rfc-editor.org/rfc/rfc9112.html#section-7.1) と照合。正しいtype+LE32形式は `backend/toytalk-api-stream-for-esp32-lambda/index.mjs` のsendMeta/sendPCMで確認した。Lambdaは変更していない。

検証: `tests/chunked_body_decoder_test.cpp` のコンパイル時テストで、ファームと同じread処理に偽の通信・時計を与え、1バイトずつの到着、短いread、複数チャンクの一括到着、拡張・trailer、途中切断、無通信タイムアウト、低速だが進捗のある通信、中断後のターン初期化、巨大な長さ・不正な種類を確認する。これは実機のネットワーク再現試験ではない。

次の実機確認も `VOICE_RX_PAUSE_DURING_PLAYBACK=true` のまま、2ターン目以降の正常完了・`[PCM_TIMING]`・`[STATS]` と、もし出るなら最初の `[STREAM_ERROR]` を取得する。音声介入はまだ再有効化しない。

受信修正版の検証結果: Arduinoコア3.3.10、No FS 4MB / QSPI PSRAM / USB CDCのビルド成功。Flash 1,397,727 / 2,031,616 bytes（68%）、静的RAM 53,456 bytes。受信・音量判定のコンパイル時テストは `-std=c++17 -Wall -Wextra -Werror -fsyntax-only` で成功。実機での遅延改善は未確認。

## 受信修正後も低速: RX寿命をv0.5へ戻す比較（同日21:44）

ユーザーの2枚の画像のうち1枚目は21:23の再掲、2枚目が受信修正版の新しい実機ログ。turn=2、`rx_paused_for_playback=1`。

- PCMフレーム長132,684 bytesは正常範囲。`first_pcm_chunk_ms=33423`、`first_tts_i2s_ms=42513`。送信関数入口から最初の音声読取まで約33.4秒、最初のI2Sコピーまで約42.5秒。
- `reason=idle_timeout body_offset=98591 expected=8192 got=8113`。そのPCMフレームの残りは42,572 bytes。前回のように残りを次のフレームとして読み続けず、異常終了して録音へ復帰した。
- `underruns=4`、RSSI平均-82 / 最小-84。異常で早く打ち切っているため、以前の22回から減ったことを改善の証拠にしない。
- 復帰直後は `ws_ready=0`。Soniox再接続は約1.4秒。`first_pcm_chunk_ms` は途中のSoniox処理等も含む累積値であり、33秒全部をLambdaサーバーの生成時間と見なさない。

受信修正は異常の拡大を止める効果を確認できたが、低速化は解消していない。ユーザーは前より悪化したと報告。異なる応答を各1回比較したログだけでは、修正による悪化か通信条件の変動かを断定しない。

追加でArduino IDEの両スケッチの `build.options.json` を照合した。このリポジトリのv0.5とv0.6は、コア3.3.10・FQBN全項目（CPU240、QIO、Flash4M、no_fs、QSPI PSRAM、USB CDC、Loop/Event Core1等）が一致。ボード設定の相違は確認されなかった。

次の比較はRXドライバの保持を外す一点に限定:

- `VOICE_RX_RELEASE_WHEN_PAUSED=true` を追加。再生前に `i2s_driver_uninstall(I2S_NUM_0)` を呼び、`micInstalled/i2sRecordReady` をfalseにする。
- 正常終了・ボタン中断・受信エラー・再生設定失敗・Lambda接続失敗からの録音開始で、既存のsetupI2SRecord経由でRXを再確保する。監視停止の確認前に解放しない。
- 比較中も監視タスク・スタックは確保したまま待機する。受信修正、スタック修正、Soniox先行接続、音量、400msの間は変更しない。v0.5ソース自体も変更しない。
- `[VOICE_TEST] rx_released=1 internal_free_before=... after=...` と、再生終了時の `rx_released_for_playback=1`、録音復帰時の `mic reinstalled for STT` を出す。

停止と解放は異なる。[ESP-IDF v5.5.4のi2s_driver_uninstall](https://github.com/espressif/esp-idf/blob/v5.5.4/components/driver/deprecated/i2s_legacy.c) はRX用DMAチャネル、バッファ等を解放しクロックも無効化する。これで改善したとしても、メモリ量・配置・ドライバ状態のどれが原因かまでは別途切り分けが必要。

次はこの版で2〜3ターン会話し、2ターン目以降の `[LATENCY]`、`[PCM_TIMING]`、`[STATS]`、`[VOICE_TEST]` を比較する。音声介入を再開できる状態ではなく、実機の改善は未確認。

RX解放版は同じFQBNでコンパイル・リンク成功。Flash 1,397,983 / 2,031,616 bytes（68%）、静的RAM 53,456 bytes。v0.5が安定版 `cb0d137` から変更されていないことも確認した。

## RX解放で連続会話が改善（同日21:58）

ユーザーから「8ターンくらいしてるけど全然OK」と報告。添付された3枚はturn=1〜3のログで、全8ターンのログを確認したわけではない。

| 画像のターン | underruns | 最後のPCMフレーム長（bytes） | read_ms | ring_wait_ms |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0 | 152,754 | 344 | 591 |
| 2 | 1 | 144,620 | 287 | 3,065 |
| 3 | 1 | 207,522 | 558 | 4,092 |

3枚とも掲載部分では全PCMの `remaining=0` と通常の `BINARY STREAM END` を確認。`STREAM_ERROR` は見られない。長い `ring_wait_ms` は、受信済み音声を入れるリングの空きを再生が進むまで待った時間であり、従来の数秒〜数十秒に及ぶ `read_ms` の増大とは区別する。

各ターンで `rx_paused_for_playback=0 rx_released_for_playback=1`、続いて `mic reinstalled for STT` を確認。Sonioxは先行接続済みで `ws_ready=1`、スタック最小空きは4,160 bytes。再生後の通常録音へ復帰している。

比較から、再生中にRXドライバ・資源を保持することが低速化に関係している可能性が高まった。以前の停止のみの版でもマイク読み取り・音量監視は止まっていたため、「マイクが動いていないから」だけでは今回の差を説明できない。ただし解放は内部RAMの量・配置、DMAチャネル、周辺回路の状態にも影響するので、どれが根本原因かは未確定。

この結果は通常会話の再生が改善した確認であり、音声介入の完成ではない。再生中のマイクと音声介入は休止したまま。次はこの比較結果を基準に、RXの資源使用量や開始・停止処理を調べ、同時録音を戻しても低速化しない条件を切り分ける。今回の結果記録ではファームの設定・コードは変更しない。

## RXバッファ半減で同時録音を再開（同日、21:58の結果を受けた次の試験）

`VOICE_RX_TEST_MODE` で過去の比較条件と次の条件を選べるようにした。既存のPAUSE/RELEASEフラグとRX枚数はこのモードから算出する。

| `VoiceRxTestMode` の値 | 再生中のRX | RXバッファ枚数 | 実機結果 |
| --- | --- | ---: | --- |
| `ReleaseDuringPlayback` | ドライバ・DMAを解放 | 通常STT時8枚 | 約8ターン正常の報告あり |
| `PauseDuringPlayback` | 停止、領域は保持 | 8枚 | 低速化が再現 |
| `MonitorOriginalDma` | 同時録音・音量計測 | 8枚 | 低速化が再現 |
| `MonitorSmallDma` | 同時録音・音量計測 | 4枚 | 22:23の2ターン目で低速化・受信タイムアウト |

変更対象はRXの枚数。1枚512サンプル・16kHz・モノラル32bitを維持し、データ領域は16,384→8,192 bytes、管理領域は別途必要。1枚分の32msは維持し、バッファ全体の容量は256→128ms相当になる。容量は読み取りを止めても音声が欠けない保証時間ではない。[IDF v5.5.4のRX処理](https://github.com/espressif/esp-idf/blob/v5.5.4/components/driver/deprecated/i2s_legacy.c) はキュー満杯時に古い項目を捨てるため、通信で読み取りが滞った場合のSTTの欠落にも注意して評価する。

通常STTも同じ小さいRXを使う。再生との切り替えでRXを再設定する処理は加えず、以前の同時録音と同じ寿命で容量差を比較する。音量6000・保持120ms、監視タスク、TXバッファ、TTS間400ms、HTTP受信処理、TLSの確保先・Soniox先行接続は変更しない。`VOICE_BARGE_DETECT_ONLY=true` のため、再生中の声は計測するだけで自動停止しない。

起動時に `[VOICE_TEST] mode=monitor_small_dma rx_dma_count=4 rx_dma_frames=512 detect_only=1`、RX設定完了時に `mic_ready` の容量・内部RAM、各ターンのTX設定後に `playback_ready` の内部RAMを記録する。既存のTLS接続前ログと合わせて比較する。空き量はその時点の値であり、他タスクの確保・解放も影響する。

次の実機確認:

1. 同じArduino IDE設定でv0.6を書き込み、起動時の上記モード表示を確認する。
2. まず5ターン程度普通に会話する。2ターン目以降の本文再生の速さ、音切れ、通常STTの認識を確認する。再生中の音声介入はこの版では起きない。
3. 2〜3ターン目の `[VOICE]`、`[PCM_TIMING]`、`[STATS]`、`[MEM]`、`[VOICE_TEST]` を残す。`frames` が増加し、`read_errors` が増えていないかも確認する。ただし `read_errors=0` でもDMAキュー内の音声欠落がないことは保証しない。
4. 正常なら約10ターンまで継続。遅延・受信エラーが再現したらそのログを保存し、`VOICE_RX_TEST_MODE` を `VoiceRxTestMode::ReleaseDuringPlayback` に戻して再ビルド・書き込みする。

改善すれば少ないRX資源で同時録音できる可能性を支持する。再発した場合は、容量を半減するだけでは不十分と判断し、保持するドライバの状態やほかの内部RAM使用箇所を次に調べる。どちらの結果でも根本原因を一つに断定しない。

検証: Arduinoコア3.3.10、No FS 4MB / QSPI PSRAM / USB CDCでコンパイル・リンク成功。Flash 1,398,111 / 2,031,616 bytes（68%）、静的RAM 53,456 bytes。既存の受信・音量判定のコンパイル時テストも成功。v0.5は安定版 `cb0d137` から変更なし。RXの削減は動的確保分なので、静的RAMのビルド表示は変わらない。実機への書き込みと動作確認はまだ行っていない。

## RX半減でも2回目に再現: ターン間の保持を外す比較（同日22:23）

ユーザーは「1回目は問題なし、2回目になるとだめ」と報告。添付画像はturn=2。Arduino IDEのビルド済み `.ino.cpp` も `MonitorSmallDma`、RX4枚であることを確認した。

- セグメントid=2、PCM 88,482 bytesの途中で複数回バッファ枯渇。最後は `reason=idle_timeout body_offset=147690 expected=6562 got=957`。最後の6,562 bytesの読み取り中に957 bytesまで受信し、その後の進捗が途絶えた。
- `underruns=7`、マイク監視終了時 `frames=2424 read_errors=0 stack_free=1076`。監視は動作し続けているが、これだけでDMAキューの欠落がないとは断定しない。
- `[MEM] free=132256 max_blk=33780 min_ever=68644`、RSSI平均-76 / 最小-78。これらは異常終了後の値で、受信中の一時的なメモリ不足を否定する値ではない。
- `rx_paused_for_playback=0 rx_released_for_playback=0`。受信エラーで応答を打ち切り、Soniox先行接続済みの録音へ復帰。クラッシュ再起動や音量検出による中断ではない。

8KBのRX削減だけでは解消しなかった。容量不足そのものを否定できたわけではないが、さらに容量を小さくする試験は一旦止める。

コード上の相違: MonitorSmallDmaはRXを起動時から保持する一方、TXは各ターンでインストール・アンインストールする。初回だけ正常という報告から、RXのターン間保持を外して比較する。ドライバ状態の不具合を確認できたという意味ではない。

今回追加した `VoiceRxTestMode::MonitorResetEachTurn`:

- 再生中もRX4枚で録音・音量計測を続ける。監視タスク、音量判定、TLS、TX設定、400msの間は維持。
- 正常終了・ボタン中断・ストリーム異常・Lambda接続失敗の後、監視停止を確認してRXを解放し、続いてTXを破棄する。再生設定に失敗した経路でもRXを解放して録音復帰を試す。
- 次のSTT開始時は既存の `setupI2SRecord` でRXを作り直す。解放に失敗した場合は失敗ログを出し、既存RXで録音復帰を試す。その場合は「リセットできた試験」として扱わない。
- `rx_reset_after_playback=1 generation=...` と `mic_ready ... generation=...` を追加。初回1、次の録音2、次は3と増えることを確認する。`monitor start` にも世代番号を付ける。
- `VOICE_BARGE_DETECT_ONLY=true` を維持。再生中の自動停止はまだ無効。

メモリ不足と破壊を次のログで区別するための計測も追加:

- 起動時に `heap_caps_register_failed_alloc_callback` を登録。`[ALLOC_FAIL] hook_install_err=0` が成功。
- フック内は固定領域の件数・最後の要求サイズ・capabilitiesの記録だけとし、出力・動的確保・heap API呼び出しはしない。両コア/ISRからの記録は短いクリティカルセクションで保護する。
- 会話境界の `before_playback` / `before_recording` で `[ALLOC_FAIL] delta=... total=... last_size=... last_caps=...` を出す。deltaは直前のチェックポイントからの失敗数。最後の要求しか保持しないので、複数失敗の全内容は復元できない。フォールバックで回復した失敗も含み得るため、件数だけで低速化の原因と断定しない。
- 同じ境界で `heap_caps_check_integrity_all` を実行し `[HEAP_CHECK] ok=...` を出す。インストール済みSDKは `CONFIG_HEAP_POISONING_LIGHT=1`。管理情報・canaryの検査であり、すべてのメモリ破壊を検出できるものではない。再生中の読み取りループでは実行しない。境界の検査・ログ時間が増えるため、今回の録音切り替え時間は従来版と厳密には比較しない。

次の実機確認はまず2〜3ターン。起動時の `mode=monitor_reset_each_turn` と、1ターン目終了から2ターン目のログを確認する。特に `[VOICE_TEST]` の世代番号、`[ALLOC_FAIL]`、`[HEAP_CHECK]`、`[PCM_TIMING]`、`[STATS]` を残す。再発時は2回目だけでも十分な判定材料になるので、失敗したまま長く続ける必要はない。

RXを作り直して改善しても、ドライバ状態のリセットとメモリ配置の変化を完全には区別できない。改善しなければメモリ失敗・破壊の記録を次の調査に使う。快適だった設定へ戻す場合は `VoiceRxTestMode::ReleaseDuringPlayback` に変更して再ビルド・書き込みする。

検証: Arduinoコア3.3.10、No FS 4MB / QSPI PSRAM / USB CDCでコンパイル・リンク成功。Flash 1,399,742 / 2,031,616 bytes（68%）、静的RAM 53,552 bytes。既存の受信・音量判定のコンパイル時テストは `-Wall -Wextra -Werror` でも成功。正常・中断・受信失敗・接続失敗・TX設定失敗の各復帰経路をコードで確認し、v0.5が `cb0d137` から変更されていないことも確認した。実機の改善は未確認。

## RX再確保でマイク同時動作中も改善（同日22:36〜22:37）

ユーザーから2・3・4ターン目ともスムーズで問題なしとの報告。3枚の画像で `turn=2/3/4` を確認した。1ターン目の画像と長時間試験の結果はこの報告には含まれない。

| ターン | 最後のPCM長（bytes） | read_ms | ring_wait_ms | underruns | RX解放→次回確保のgeneration |
| --- | ---: | ---: | ---: | ---: | --- |
| 2 | 113,946 | 725 | 0 | 2 | 2→3 |
| 3 | 72,350 | 164 | 979 | 1 | 3→4 |
| 4 | 107,340 | 249 | 0 | 1 | 4→5 |

- 各画像に再生中の `[VOICE] rms=...` があり、監視終了時はそれぞれ `frames=400/459/371 read_errors=0`。RXは再生中も有効だった。`rx_paused_for_playback=0 rx_released_for_playback=0` とも一致する。
- 掲載されたPCMは `remaining=0`、通常の `BINARY STREAM END`、`interrupted=0`。受信タイムアウト・再起動は写っていない。underrunはゼロではないため、音切れが完全にないとログだけから断定しない。
- 全画像で `rx_reset_after_playback=1` の後に `mic_ready ... dma_count=4 dma_data_bytes=8192` があり、generationが順に増加。意図したRX解放・再確保が実行されている。
- `[ALLOC_FAIL] checkpoint=before_recording delta=0 total=0`、`[HEAP_CHECK] ... ok=1`。今回の成功した試験では、フックが記録する確保失敗と検査可能なヒープ破損は検出されていない。失敗していた以前の版にはこの診断がないため、その時点のメモリ不足・破損まで否定しない。
- Sonioxは各回 `WS already connected`、通常録音へ復帰。`amp_to_mic_ms=4/4/4`、`amp_to_send_ms=37/37/37`。これらはアンプOFF後の時間であり、実際の発声終了からの時間ではない。

RXを同じ4枚に保ったまま、ターン終了時の解放・再確保と診断を追加した版で改善した。単純なRX容量削減より、RXの寿命・再初期化が関係する可能性を支持する。再確保によるメモリ配置変更や診断によるタイミング変化も伴うので、特定のドライバ不具合を証明したわけではない。

2ターン目には `trigger rms=6035 threshold=6000 hold_ms=120 detect_only=1` が記録されている。現在は検出だけなので再生が継続するが、そのまま自動停止を有効にすればこの条件で中断する。音源がユーザーの声か再生音かはログ単独では特定しない。音声介入を再開する前に、再生音のみと人の声が重なる場合の判定を調整する必要がある。

今回は結果の記録のみでファームは変更しない。同じ版で合計10ターン程度の継続確認を行い、低速化が再発しなければ音量判定の調整へ進む。

## 同時録音を有効にしたまま10ターン正常（同日22:42）

ユーザーから「10回目、全く問題なし」と報告。添付画像の `[TURN_END] turn=10 interrupted=0` と、RX解放時の `generation=10`、次の確保時の `generation=11` で確認した。返答本文に含まれる回数の発言を判定根拠にはしていない。全10ターンのログが揃ったわけではなく、連続動作の体感についてはユーザー報告による。

- 掲載されたPCMは43,680 bytesを `read_ms=138`、98,488 bytesを `read_ms=228` で受信。両方 `remaining=0`、通常の `BINARY STREAM END`。
- マイク監視は `frames=340 read_errors=0 stack_free=852`。再生中も音量計測が動作。`underruns=1`、RSSI平均-82 / 最小-84。ユーザーは問題なしと報告しているが、ログ上のバッファ枯渇はゼロではない。
- `[ALLOC_FAIL] checkpoint=before_recording delta=0 total=0`、`[HEAP_CHECK] ... ok=1`。現在の版でフックが記録した確保失敗は0件、チェックポイントで検査可能なヒープ破損も検出されていない。
- 再生後の `[MEM] free=123580 max_blk=33780 min_ever=58816`。RX/TX解放後は内部空き167,604 bytes、RX再確保後158,404 bytes。計測フェーズが違うため、この3つを同じ条件の空き量として比較しない。
- Soniox先行接続済みで次の録音へ復帰。`amp_to_mic_ms=3 amp_to_send_ms=36`。アンプOFFからの計測であり、実際の発声終了からの時間ではない。

以前繰り返していた2ターン目からの低速化が、この試験では10ターンまで再現しなかった。RX4枚・再生中のマイク監視ON・ターン終了時RX再確保の構成を、次の判定調整の基準として維持する。`VOICE_BARGE_DETECT_ONLY=true` のままなので、音声による自動停止の成功を確認した試験ではない。

次の段階は、再生音だけの場合と人の声が重なる場合の音量を比較し、誤検出を抑えてから自動停止を再試験する。今回の記録ではファームを変更せず、追加ビルド・書き込みも不要。
