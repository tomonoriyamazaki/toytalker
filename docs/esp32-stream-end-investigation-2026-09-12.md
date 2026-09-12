# 2026-09-12 音声途中停止の調査

## 結論

12:17台の第3ターンは、全PCMフレームとアプリケーション完了通知`{"event":"done"}`の受信後、HTTP chunked終端を認識する前に`connection_closed`となり、ファームが未再生のリングバッファを破棄した。音声割り込み（AEC）による停止ではない。

**音声を打ち切った直接の処理経路は確認済み。HTTP終端を認識できなかった根本原因は未確定。** 調査時点ではファーム・Lambdaとも未変更。後述の修正はv0.7のファームのみが対象。

## 実機とログ

- 起動ログ: ToyTalker Mini v0.7、Arduino 3.3.11、IDF v5.5.5。
- 通信上のdevice ID: `90:da:72:49:ba:e5`（NVS）。USB列挙のシリアル番号末尾はBA:E4であり、同一視しない。
- 端末ログ: `.local/serial-logs/COM12-20260912-121614.log`（Git対象外）。
- 入力: 「うーん、なんか問題なかったんだけどな。さっきはさ、音声会話途切れちゃったんだよね。」
- CloudWatch: `/aws/lambda/toytalk-api-stream-for-esp32-lambda`、ap-northeast-1。
- Lambda Request ID: `da27a5d8-c978-42f8-bef7-b5673069ac3e`。

Lambda側はJST 12:17:40.749からログがあり、49,494 / 86,912 / 210,484 bytesのPCMを生成。端末側も同サイズの3フレームを受信し、すべて`remaining=0`で完了している。PCM合計346,890 bytes。端末の`Streaming complete`はステレオ変換後のサイズなのでLambda側の2倍になる。

CloudWatchのDurationは1,475.84msでEND/REPORTあり。取得範囲に例外・タイムアウトなし。ただし、この事実だけではネットワーク終端の配送成功は保証できない。

端末の順序:

```text
[META] {"event":"done"}
[STREAM_ERROR] reason=connection_closed body_offset=347570 expected=5 got=0
[STREAM_ERROR] binary header incomplete: 0/5 bytes
[STREAM_ERROR] dropping response and returning to recording
[TURN_STOP] cause=stream_error
[STATS] underruns=0
[AEC_LEVEL] ... gate_fired=0
```

アンプ停止は受信終了から28ms程度で、正常時のリングを再生し切る待機がない。その後の録音・音声送信は再開。次の「今、聞こえる？」は`cause=completed`で終了している。毎回起こるものではない。

## コード上の経路

1. `processMetadata()`はsegment/tts_startを処理するが、doneを受信完了の状態として保持しない。
2. 外側のループは次の5-byteフレームヘッダーを要求する。
3. `ChunkedBodyDecoder`はHTTPのゼロサイズチャンクとトレーラー終端まで受信して初めてdoneとなる。未完了のままavailable<=0かつconnected=falseならconnection_closed。
4. ヘッダーが0/5 bytesのためresponseFailedとなり、アンプOFFと`playerStop()`によるリング破棄へ進む。

ローカルLambdaコードはTTS処理後にdoneを送信し、その後に利用量・会話履歴の保存を行い、finallyでres.end()する。保存等の例外ではdone後にもerrorを送る可能性がある。このため「どんなdoneでも直ちに全処理成功」とする変更には、プロトコルの意味の整理が必要。今回のライブLambdaとローカルコードのハッシュ完全照合は未実施。

## 再現試験

`.local/serial-logs/terminal_chunk_probe.cpp`でv0.7の実際のChunkedBodyDecoderを使用。ESP32付属g++のC++17 static_assertをコンパイルして、以下の両方が成立した。

- 正しいdoneフレームとHTTP終端`0\r\n\r\n`がある場合は正常完了。
- 同じdoneフレームが完全に届いてもHTTP終端なしに切断すると、次のヘッダー読み取りは0 bytesでエラー。

これは観測結果を説明できる入力条件の再現であり、実通信でHTTP終端が欠落していたことの証明ではない。TLSライブラリが残データを取り出す前に閉じた可能性も区別できていない。

## 次の修正・検証候補

- 音声の完了とHTTP終端の完了を別々に記録する。HTTP終端の問題だけで、受信済みの正常な音声まで破棄しない設計を検討する。
- done受信済み、PCMフレーム完了、サーバーerror有無を判定材料とする。PCM途中の欠落・不正フレーム・意図した割り込みまで正常扱いにはしない。
- 終端エラー時のデコーダ状態、残りchunk bytes、TLSエラー、done受信有無を出力し、外部APIを使わない模擬通信で分割受信・終端欠落・途中切断を検証する。
- 次に実機で短文・長文の連続会話を確認する。今回の調査では書き込みも再起動も実施していない。

12:10〜12:14頃のSoniox再接続後にSTT送信が戻らない現象は別件。切断時のisRecording=falseと再接続時の録音再開の欠如が疑われるが、本件のstream_errorと混同しない。

## 修正（fix/esp32-stream-completion）

- 稼働中Lambdaの配布コードを取得し、TTS処理完了後にdone、履歴・利用量保存の後にres.end()、例外時はerrorとなる順序を確認した。取得したindex.mjsのSHA256は `E377179809A6759F405CB53349295EE09A10120071F0AC3E00916E042C584203`。Lambdaは変更していない。
- v0.7はJSONのトップレベルeventを解析し、doneとerrorをターンごとに保持する。本文中の文字列を完了通知とは見なさない。
- 完全なフレームを処理した後、次のヘッダーの受信が0 bytesでconnection_closedとなり、done受信済み・errorなし・割り込みなしの場合に限り、通常のリング再生完了待ちとDMA flushへ進む。受信済み音声を接続切断だけで破棄しない。
- PCM開始や新しいsegment/tts_startでdone状態を解除する。部分ヘッダー、PCM途中欠落、不正JSON、HTTPフレーミングエラー、タイムアウトは救済しない。done前後のサーバーerrorがあれば、この救済を適用しない。
- HTTP正常終端時の既存挙動、声による割り込み、再生終了後の録音開始順序は維持する。通常の再生待ちには従来どおり30秒の上限がある。
- `[STREAM_END] done=1 http_complete=0 reason=connection_closed; draining audio` は今回の救済経路。続くサマリーでdone/server_error/http_complete/failedを確認できる。先行する低層のSTREAM_ERRORログは残すため、それだけで再生失敗とは判断しない。

### 検証と実機での確認

`tests/stream_completion_test.cpp` はv0.7の実際のデコーダと完了判定を使用するC++17 static_assertテスト。1-byte分割受信、正常HTTP終端、done後の終端欠落、タイムアウト、PCM途中切断、部分ヘッダー、done前後のerror、割り込み、ターン間リセットを検証する。ESP32付属g++でコンパイル成功。

実機への書き込みと修正後の会話試験は未実施。Arduino IDEでv0.7を書き込んだ後、短文・長文を連続して試し、以下を確認する。

ファーム全体もArduino ESP32 3.3.11、FQBN `esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=4M,PartitionScheme=no_fs,CDCOnBoot=cdc` でビルド成功。Flash 1,475,810 bytes / 2,031,616 bytes、静的RAM 67,096 bytes。これは実行時のメモリ安定性の検証とは区別する。

1. 通常応答が末尾まで再生され、その後に録音へ戻る。
2. 救済ログが出たターンも、リング再生とDMA flushの後に録音へ戻る。実際の終端欠落は毎回再現するとは限らない。
3. 声による割り込みは従来どおり途中で再生を止める。
4. メモリ確保失敗・再生待ち時間・連続会話の安定性をログで比較する。

この変更はHTTP終端の未認識そのものを解消したという主張ではなく、確認できた音声破棄経路への対処である。

### 14:18 書き込みと起動確認

ユーザーの依頼でCOM12のESP32-S3（USB MAC 90:da:72:49:ba:e4、Flash 4MB / PSRAM 2MB）へ上記ビルドを書き込み、書き込みデータのハッシュ検証に成功。再起動後にv0.7 / Arduino 3.3.11 / IDF 5.5.5、Wi-Fi接続、Soniox接続、STT音声送信の継続を確認した。起動確認の範囲ではメモリ確保失敗0、STT送信fail=0。

ログは `.local/serial-logs/COM12-20260912-141828.log`（5分間の受信、Git対象外）。修正後の会話再生・終端欠落の救済経路・割り込みの実機検証はまだ未実施。

その後、ユーザーから修正後の会話は「一応問題ない」と報告あり。通常会話の動作確認として記録する。元の終端切断の再現と救済経路の実機確認は未確認であり、解消確定とはしない。ユーザーの方針により、当面は通常利用で様子を見て、再発時にログと発生状況を調べる。

### 14:29頃の途中停止報告：AEC判定による停止

ログ受信は14:23で終了し、14:27台に同じファイルへの追記として30分間再開した。ユーザーの途中停止報告を受けて確認した直近turn=8（東京の天気）とturn=9（面白いニュース）は、いずれも `[AEC_TRIGGER]` に続いて `[TURN_STOP] cause=aec_level`。`[STREAM_END] done=0 server_error=0 http_complete=0 failed=0` であり、今回対象のdone後connection_closedとは異なる停止経路だった。

turn=9は閾値1,200 / 継続128msの判定で発火し、PCM受信を割り込みキャンセル。検出から録音再開24ms、初回送信57ms。AEC統計はmissing/mic_drop/ref_drop/clock_resets/format_errors/clipsがすべて0。underruns=2も記録されているが、最終的な打ち切りの直接原因はAEC判定。ユーザーが再生中に発声していたかは未確認で、再生音による誤検出とまでは断定しない。設定変更・追加書き込みは行っていない。

ユーザーはその後、上記停止時は黙っていたと回答。再生音などによる誤検出が疑われる。

14:34頃の桃太郎の途中停止報告もturn=18で `cause=aec_level`。第9セグメント受信中、`at_ms=951944`で発火。判定窓4フレームのAEC出力RMSは1,411 / 2,865 / 1,410 / 2,085で、全フレームが閾値1,200を超えた。窓内の出力/入力比は93.8%。ターン全体のreduction_db=4.5で、途中にはmic=2,318に対してout=30の区間もあり、常にAECが効いていないわけではない。missing/mic_drop/ref_drop/clock_resets/format_errors/clipsは0。Sonioxの切断・再接続も途中にあったが、その後も音声受信・再生は続いており、最終停止理由はAEC判定だった。配置・音量を揃えた比較と判定調整は引き続き未実施。

### 同じ音量でのturn=18 / 19比較

ユーザーから次は最後まで再生でき、音量は同じだったと報告。turn=19は「もう一回続きいける？」への桃太郎の続きで、turn=18と同一の音声ではない。

| 指標 | turn=18（停止） | turn=19（完走） |
|---|---:|---:|
| 停止理由 | aec_level | completed |
| AEC入力の最大フレームRMS | 2,989 | 2,381 |
| AEC出力の最大フレームRMS | 2,865 | 1,195 |
| AEC出力の128ms持続値の最大 | 1,410 | 951 |
| ログ上の全体reduction_db | 4.5 | 4.8 |
| underruns | 1 | 0 |
| AEC missing / mic_drop / ref_drop / clock_resets | すべて0 | すべて0 |

両方ともAEC再作成成功（約54ms / 53ms）、途中でSonioxの切断・再接続あり。完走した回もSoniox切断があるため、それだけでは今回の打ち切りを説明できない。turn=19はdoneとHTTP終端を受信後、リング待ち5,419ms、DMA flush完了5,770ms、録音再開5,782ms。今回追加したconnection_closed救済は使わず正常終了した。

平均的な抑制指標の差より、局所的なAEC出力の増大と閾値1,200 / 128msの関係が明確。turn=19の最大値も閾値に近いが、単発ピークだけで発火するわけではない。再生音の内容が異なるため、AECの適応状態・音響経路・音源由来の違いはこの比較だけでは分離できない。実際に声で割り込んだときの値を比較せず、閾値引き上げだけで解決としない。

### 14:54確認：意図した声の割り込み

ユーザーが「ちょっと待って」で割り込んだと報告。直近turn=20（入力「ごめん、もう1回」）はcause=aec_level、判定4フレームの出力RMSは1,652 / 1,463 / 2,188 / 3,365、出力/入力比91.5%。out_sustained=1,463、out_peak=3,834、検出→録音49ms、初回送信83ms。AECの欠落・同期リセット・クリップは0。

誤停止turn=18のout_sustained=1,410と、意図した割り込みの1,463は近い。単純な閾値引き上げでは、今回の意図した声まで検出しにくくなる可能性がある。停止時点で観測を打ち切るため、より高い閾値でも少し待てば検出できたかは、このログだけでは分からない。

14:54:23時点でログ最終更新は14:54:18、受信継続を確認。常時収集ではなく、14:27台から30分の受信で14:57台に終了予定。
