# USBログ未受信時の遅延

## 症状と根拠

2026-09-12、ログ取得が22:26:11で終了した後にユーザーが大きな遅延を報告。22:53:06に受信を再開し、ユーザーも正常に戻ったと確認。

受信再開直後のturn=10はamp_to_mic_ms=9969、mic_drop=389、ref_drop=254、clock_resets=57。以降のturn=13はamp_to_mic_ms=4、mic_drop/ref_drop/clock_resets=0。受信中断中の全文はなく、遅延の全てをこの原因に確定しない。本文生成待ちも別にある。

インストール済みArduino ESP32 3.3.11の `cores/esp32/HWCDC.cpp` では送信待ち既定100ms、連続タイムアウト20回で打ち切り。USBが接続されたままPCが読まない場合、送信キューが埋まると一度の書き込みで約2秒待ち得る。ファームは音声/STT処理と同じタスク内でもSerialへ出力するため、ログ待ちが処理を遅らせ得る。

## 修正

v0.7のsetupでSerial.begin直後、Hardware USB CDC使用時に `Serial.setTxTimeoutMs(0)` を設定。キュー空きや送信ロックを待たず、送れないログは欠落を許容する。起動ログ `[SERIAL] hwcdc_tx_timeout_ms=0 drop_on_backpressure=1` で確認可能。

対象は現行ボードのHardware USB CDC。UARTやNative USB用の動作変更ではない。Arduinoコアのファイルは編集せず、ファーム内で公開APIを使用。音声PCM・音量・AEC判定・ボタン処理は変更しない。ログ整形などのCPU処理は残るため、全処理が無コストになる意味ではない。大量出力や複数タスクの競合では、受信中でもログの一部が欠ける可能性がある。

## 検証・運用

受信再開後、ユーザーが「いい感じ」と報告し、今回の改修をコミット・統合する方針を指定。ログ未受信の長時間試験を完了したとの明示報告ではないため、その耐久性は未検証として保持する。

23:00台にビルド成功（Flash 1,477,126 bytes / 静的RAM 67,144 bytes）、COM12へ書き込みとハッシュ検証を完了。20秒の起動確認で `[SERIAL] hwcdc_tx_timeout_ms=0 drop_on_backpressure=1` とSTT送信157件/fail=0を複数回確認。確認後はポートを閉じた。USB未受信時の会話の聴取確認はユーザー確認待ち。既存ログファイルへの追記はファイルロックで失敗したため、この起動確認の証跡はツール出力と本記録に保持する。

FQBNは従来どおり `esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=4M,PartitionScheme=no_fs,CDCOnBoot=cdc`。AGGR指定 `compiler.cpp.extra_flags=-DTOYTALKER_AEC_NLP_LEVEL=1`、ビルド先 `$env:TEMP/toytalker_v07_serial_nowait`。

コード確認：HWCDCの送信ロック、リングバッファ送信の待ち時間がともに0となる。キュー満杯時のリトライは最大20回で打ち切り。v0.7にSerial.flush呼び出しはない。

実機確認は通常の起動/STTと、PCが受信していない状態での会話を区別する。後者ではUSBケーブルを接続したままログ取得を終了し、会話・ボタン停止・録音復帰が遅くならないか確認する。再受信時に本体の電源を入れ直す必要はない。受信していなかった期間のログは完全には復元できない。
