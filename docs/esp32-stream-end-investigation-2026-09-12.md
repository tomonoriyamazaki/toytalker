# 2026-09-12 音声途中停止の調査

## 結論

12:17台の第3ターンは、全PCMフレームとアプリケーション完了通知`{"event":"done"}`の受信後、HTTP chunked終端を認識する前に`connection_closed`となり、ファームが未再生のリングバッファを破棄した。音声割り込み（AEC）による停止ではない。

**音声を打ち切った直接の処理経路は確認済み。HTTP終端を認識できなかった根本原因は未確定。** ファーム・Lambdaは変更していない。

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
