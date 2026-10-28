# ESP32-S3ファーム: 現在の状態と入口

ESP32-S3スタンドアロン機（v3）のファーム開発の入口。ここには「今どの版が何に入っていて、何が未確認か」と、各調査メモへの案内だけを置く。ルール（Arduino IDE維持、フォルダ1つ＋gitタグ）は [CLAUDE.md](../CLAUDE.md) の「ESP32-S3ファーム開発」。残作業の順番は [ロードマップ](roadmap.md) の6。状態が変わったらこの節を上書きし、経過は各調査メモへ書く。

## 現在の状態（2026-09-16時点）

- 開発先は [v0.7](../devices/mcu/esp32_s3/toytalker_mini_v0.7/toytalker_mini_v0.7.ino)（OTA対応、NLP既定=AGGR、`sketch.yaml` にボード設定あり）。[v0.6](../devices/mcu/esp32_s3/toytalker_mini_v0.6/toytalker_mini_v0.6.ino) は音量方式の検証版、[v0.5](../devices/mcu/esp32_s3/toytalker_mini_v0.5/toytalker_mini_v0.5.ino) は実機確認済み安定版として保持。
- 試験機「v0.2 大スピーカー」（`90:da:72:49:ba:e5`）に入っている版は 0.7.2（2026-09-16、OTAで更新、app1で稼働、`fw_channel=beta`）。
- 開発中の版は **0.7.3**（2026-10-28。本文・相槌の要求に `"fw":"<版>"` を添えるだけの変更。Lambdaの切り分けログ用。**未ビルド・未配布**。配布はロードマップ6の `stable` 発行と一緒に）。配布機は `toytalker_v07_serial_nowait`（2026-09-12夜書き込み、OTA非対応、版の報告なし）。
- 実機構成: AEC後のAC RMSで音声割り込み判定、NLP=AGGR、音声割り込みON、ボタン即時消音、AEC毎ターン再作成、TLSはPSRAM固定、USBログ送信待ち0。TTSはCartesia基準。
- NLP既定はAGGR（2026-09-16にNORMALから変更。実機構成と同じ）。NORMALで比較するときは `--build-property 'compiler.cpp.extra_flags=-DTOYTALKER_AEC_NLP_LEVEL=0'`。
- AEC調整は一旦終了。「途中停止は減ったが、声で止めるには近づく必要がある」というトレードオフは既知で、最終的な限界とは扱わない。AEC本体の時刻整列・入力飽和・フィルタ等に未検証の改善候補あり。
- **OTAは2026-09-15実装、2026-09-16に試験機で 0.7.1→0.7.2 の更新成功（17秒）。** 配布した版はgitタグ `fw-0.7.1` `fw-0.7.2`。S3 `toytalker-firmware` の `manifest.json` は `channels: {beta: "0.7.2"}`、stable は未設定。更新確認は起動時にSoniox一時キー取得の応答で行い、本体はS3から直接取る。発行は `bash devices/mcu/esp32_s3/tools/publish-firmware.sh beta`、`stable --promote` で全機へ。仕様・検証手順・未実施の本番操作は [OTA実装](esp32-ota-settings-plan.md)、実装後の残タスクは [OTA引き継ぎ](handoff-esp32-ota-2026-09-16.md)。
- **Soniox一時キーの取り直し（2026-10-28実装、試験機で確認済み）**: キーはLambdaが1時間有効で発行するが、以前は起動時の1回しか取らず、時間が経つと期限切れのキーでWSを開いて会話が始まらなかった。取得から `SONIOX_KEY_MAX_AGE_MINUTES` 分を越えていれば、再生中の先行接続ワーカー（Core 0、`SonioxPreconnect::Prepare`）がWSを開く前に取り直し、先行接続が無い回は `startSTTRecording()` が接続前に取り直す。取り直しの呼び出しは `device_id` 等を付けない軽いGET（Lambdaはデバイス報告もOTA判定もしない）。Sonioxの `error_code` 応答は `[STT] soniox error:` でログに出す（自動復旧は作らない。証拠が出てから判断）。**閾値は本番値50分だが、2026-10-28から試用で2分にして運用中**（ほぼ毎ターン取り直しが走る。再生中のワーカーで1.6秒、再生・録音再開への影響なし、`stack_free` は取り直しあり/なしで同じ4096〜4720）。問題が出なければ50に戻す。アプリ側（`chat.tsx`）も同じ50分判定で、画面表示時・前面復帰時・WSを開く直前に取り直す。
- スマホから音声割り込み・相槌を再起動なしでON/OFFする案は未実装。相槌設定の本体反映は起動時、音声割り込みはファーム内固定。[設定同期の相談記録](esp32-ota-settings-plan.md)。

### 未確認・未実装

- OTA: 途中電源断、SHA改ざん、ロールバック（[OTA引き継ぎ](handoff-esp32-ota-2026-09-16.md)）。
- Soniox一時キーの取り直し: 2分の閾値での動作は2026-10-28に確認済み（`prepare_ms=1643 key_refreshed=1`、次ターンは `key_refreshed=0`）。残りは、試用（2分）で数日運用して問題が出ないこと、50分に戻した後に70分以上つけっぱなしで会話できること。
- 検索を挟んだ返答で再開直後に音声割り込みが誤発火する件（OTAとは別件。原因仮説のみ、対策未合意）。
- stream終端の切断・救済経路の実機再現、Soniox再接続後の録音停止（別件）、検出前・未接続中の音声保持（未実装）。
- 本文開始の高速化で保留した候補は [先送り項目](deferred-items.md)。

## 環境・ビルド

- ビルド確認済みのコアはArduino ESP32 3.3.11 / IDF 5.5.5。利用可能なAPIは実際のインストール済みコアで確認する。起動時の `[BUILD]` で実機の版を確認する。
- ボードはESP32-S3-MINI-1-N4R2（Flash 4MB、quad PSRAM 2MB）。Partition Schemeは `no_fs`（2MB APP x2、OTA用）。
- mbedTLSのcallocは `TlsMemory.h` で起動時にPSRAMへ固定し、内部RAMへはフォールバックしない。
- Arduino IDE付属のarduino-cliでもビルド確認できる。リポジトリルートから（書き込み時は実機のボード・ポート・IDE設定を確認する）:

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=4M,PartitionScheme=no_fs,CDCOnBoot=cdc --build-path "$env:TEMP/toytalker_v07_build" devices/mcu/esp32_s3/toytalker_mini_v0.7
```

`sketch.yaml` の `default_fqbn` があるので `--fqbn` を省略してもよい。

## 調査メモ

- [v0.7 AEC試験手順・実機結果・復旧](esp32-v07-aec.md) — AEC全般の入口。NLP=AGGRの根拠とボタン即時消音の実測もここ
- [AC RMS判定と到達点](esp32-aec-gate-ac-2026-09-12.md) — 現行判定方式、今後の改善余地、再開時の切り分け手順
- [終端調査と修正](esp32-stream-end-investigation-2026-09-12.md) — 終端救済の実装と、AEC閾値の根拠になったturn=18/20の実測
- [USBログ待ち対策](esp32-usb-log-backpressure-2026-09-12.md) — 現行実機版の最後の変更
- [入力クリップ比較](esp32-aec-input-headroom-2026-09-12.md) — 入力1/4縮小を却下した記録。再提案しないために残す
- [音声介入第一弾（v0.6）](esp32-v06-voice-barge-in.md) — 音量方式が不可と分かった根拠、RXターンごと再確保の由来
- [TLSメモリ調査](esp32-s3-tls-memory-investigation-2026-09-06.md) — Stringリーク修正の経緯と、未修正のリスク一覧
- [v0.5 再生終了の計測](esp32-playback-end-timing.md) — v0.5のみ。v0.7はI2S APIが違う
- [配布実機の音途切れ報告（2026-09-11）](device-audio-investigation-2026-09-11.md) — サーバー側調査、原因未特定。実機の版照合が未着手
- [OTA・設定同期・状態送信](esp32-ota-settings-plan.md) — OTAの仕様・配布手順・実機検証、設定同期の相談記録
- [OTA引き継ぎ（2026-09-16）](handoff-esp32-ota-2026-09-16.md) — OTA実装後の残タスクと、検索後の誤停止の記録
- [マイコン（ハード）](mcu.md) — パーツ一覧、基板設計の覚え書き、次の基板改修で行うこと
