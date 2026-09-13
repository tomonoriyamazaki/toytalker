# CLAUDE.md

Claude CodeとCodexで共有するシステム概要・開発ルール。Codexはルートの [AGENTS.md](AGENTS.md) からこのファイルを参照する。共通情報はこのファイルを更新し、両ファイルへ重複して記載しない。

**このファイルの運用**: 書くのは「コードから読み取れないこと」だけ（ルール、事故の教訓、本番に出ている版、未確認の事項）。各領域の「現在の状態」は上書きし、日付付きの経過は積み上げずに `docs/` の調査メモへ書く。2026-09-13の圧縮前の全文は [退避版](docs/claude-md-archive-2026-09-13.md) にある。

## システム構成

子供向け音声AIおもちゃ「ToyTalker」。ユーザーが話しかけると、キャラクターが音声で返答する。開発者は1人で、ハード（ESP32・基板）、バックエンド（Lambda/DynamoDB）、アプリ（React Native）をすべて自分で作っている。ソフトは専門家、ハードは学習中。

```
[App / ESP32] → STT(Soniox直接WS) → Lambda(LLM+TTS streaming) → 音声再生
                                   → Lambda(相槌: LLM処理中の繋ぎ応答)
```

- **ストリーミング前提設計**: LLM→TTSは直列ストリーミング。最初のチャンクが生成され次第再生開始する。
- **STTはLambdaを経由しない**: Soniox一時キーをLambdaが発行し、クライアントがSonioxへ直接WebSocket接続する。
- **相槌(backchannel)**: メインLLMの処理中に「そうだね〜」等の短い応答を先に返す。デフォルトON。
- **App / ESP32は対称構成**: 各々にメインLambda+相槌Lambdaがあり、出力形式だけ異なる（App=base64, ESP32=PCM）。

### TTSプロバイダー

DynamoDB `toytalker-voices` で切替: OpenAI / Google / Gemini / ElevenLabs / Cartesia / FishAudio / Sakura(ずんだもん) / ZakiCorp(自前クローンボイス, β版)。Cartesiaの設定は [Cartesia TTS導入](docs/cartesia-tts.md)。

### コスト記録の方針

- 原価・マージン2.0・前払いポイント・プレミアムボイスの料金体系は [原価と課金の考え方](docs/pricing-and-cost-model.md)。
- 相槌のLLM・TTSは記録せず `service#margin`（2.0）で吸収する。
- LLMのツール呼び出しは、外部の有料API（Serper検索など）だけ回数課金で `tool` として記録する。無料ツールは何もしない。[ツールコスト記録](docs/search-cost-tracking.md)。
- 為替は毎月1日に `toytalker-ops-monthly-lambda` が自動保存し、先月の実費・各社請求・単価行の点検をメールする。単価は自動更新しない。[月次運用レポート](docs/ops-monthly-report.md)。
- `zakicorp#tts` の単価は暫定（$0.000025/文字、Cartesiaの半額、2026-09-13登録）。正式な単価は未決定。

### Lambda一覧

| Lambda | 用途 | ディレクトリ |
|---|---|---|
| `toytalk-stream-handler-lambda` | App用メイン（LLM+TTS streaming） | `backend/toytalk-stream-handler-lambda` |
| `toytalk-api-stream-for-esp32-lambda` | ESP32用メイン（LLM+TTS streaming） | `backend/toytalk-api-stream-for-esp32-lambda` |
| `toytalker-backchannel-for-app-lambda` | App用相槌 | `backend/toytalker-backchannel-for-app-lambda` |
| `toytalker-backchannel-for-esp32-lambda` | ESP32用相槌 | `backend/toytalker-backchannel-for-esp32-lambda` |
| `toytalk-soniox-stt-lambda` | Soniox一時キー発行 | `backend/toytalk-soniox-stt-lambda` |
| `toytalker-device-setting-lambda` | デバイス登録・ボイス設定・コスト管理 | `backend/toytalker-device-setting-lambda` |
| `toytalker-tts-only-lambda` | App用 読み上げ（テキスト→TTSのみ、音声バイナリ直返し） | `backend/toytalker-tts-only-lambda` |
| `toytalker-ops-monthly-lambda` | 月次運用レポート（毎月1日にメール） | `backend/toytalker-ops-monthly-lambda` |

### DynamoDBテーブル一覧

| テーブル | 用途 |
|---|---|
| `toytalker-devices` | ESP32デバイス登録 |
| `toytalker-characters` | キャラクター定義（人格プロンプト） |
| `toytalker-voices` | ボイス設定（プロバイダー・モデル・voice_id） |
| `toytalker-llms` | LLM設定 |
| `toytalker-chat-logs` | 会話履歴・トークン使用量 |
| `toytalker-usage` | API利用量トラッキング |
| `toytalker-api-unit-prices` | 各API単価 |
| `toytalker-exchange-rates` | USD-JPY為替レート |

### デバイス世代

- v1: Raspberry Pi（廃止）
- v2: スマホアプリ経由（現行）
- v3: ESP32-S3スタンドアロン（現行、アプリ不要で直接AWS通信）

## ワークフロールール

- 依頼範囲内の読み取り・調査・通常のコマンド実行・コード修正は、逐一確認せず進める。
- **本番に影響する操作（Lambdaデプロイ・AWS設定変更・DynamoDB書き込み）と削除操作は、何をするかを説明してからユーザーの明示的なOKを得て実行する。** 説明と実行を同じターンでやらない。
- 「コミットして」と言われたらコミットだけ行う。PR作成・マージ・ブランチクリーンアップは明示的な指示があるまでやらない。
- Lambda関数を修正したら、コミット前にデプロイして動作確認する。各Lambda配下の `deploy.sh` を実行（例: `cd backend/<lambda-dir> && bash deploy.sh`）。
- **Lambdaのデプロイ元はmain。** デプロイ前に `git worktree list` と各ブランチの差分を確認し、本番に出ている版がどのブランチかを特定する（2026-09-13に別worktreeの変更を含まない作業ツリーからデプロイし、数分間本番からCartesiaが消えた）。
- PowerShellでgitコマンドを実行するとき、`Set-Location` を使わず `git` から直接実行する（パーミッション設定のパターンマッチが効かなくなるため）。
- ビルド確認と実機確認を区別して報告する。通信・音声・メモリの安定性は、ユーザーによる実機の連続会話試験とログで確認する。
- 原因不明の問題の診断は「証拠→仮説（推測と明示）→合意→検証」の順で進め、証拠が足りない仮説を断定口調で言わない。対策を出すときは「根治か、痛み止めか」を一言で明示する。
- 話題が変わる区切りや、コンテキストが膨らんだら、新しいセッションでの再開をこちらから提案する。「引き継ぎmd書いて」と言われたら、状況・決定事項・残タスクを `docs/` にまとめる。
- 破壊的・不可逆な操作（DynamoDBの削除/更新、Lambda削除、`Remove-Item`、`git reset --hard` 等）のパーミッションは `ask` のままにし、`allow` へ移す提案はしない。

### スクリーンショットの共有

- 保存先は `C:\Users\exodj\Pictures\Screenshots`。
- 「スクショ撮ったから見て」等の依頼では、保存先の画像を更新日時の新しい順に並べ、最新1枚を開く。「2枚撮った」など枚数指定があれば最新の指定枚数、ファイル名・パス指定があればそちらを優先する。
- 開いたファイル名または撮影時刻を返答に添える。見つからなければその旨を伝える。

## ESP32-S3ファーム開発

### 現在の状態（2026-09-13時点）

- 開発先は [v0.7](devices/mcu/esp32_s3/toytalker_mini_v0.7/toytalker_mini_v0.7.ino)。[v0.6](devices/mcu/esp32_s3/toytalker_mini_v0.6/toytalker_mini_v0.6.ino) は音量方式の検証版、[v0.5](devices/mcu/esp32_s3/toytalker_mini_v0.5/toytalker_mini_v0.5.ino) は実機確認済み安定版として保持。OTAは保留。
- 実機に入っている版は `toytalker_v07_serial_nowait`（2026-09-12夜書き込み）。構成: AEC後のAC RMSで音声割り込み判定、NLP=AGGR、音声割り込みON、ボタン即時消音、AEC毎ターン再作成、TLSはPSRAM固定、USBログ送信待ち0。TTSはCartesia基準。
- 同じ設定で再ビルドするには `--build-property 'compiler.cpp.extra_flags=-DTOYTALKER_AEC_NLP_LEVEL=1'` を付ける（既定NLPはNORMAL）。
- AEC調整は一旦終了。「途中停止は減ったが、声で止めるには近づく必要がある」というトレードオフは既知で、最終的な限界とは扱わない。AEC本体の時刻整列・入力飽和・フィルタ等に未検証の改善候補あり。
- 未確認: stream終端の切断・救済経路の実機再現、Soniox再接続後の録音停止（別件）、検出前・未接続中の音声保持（未実装）。
- スマホから音声割り込み・相槌を再起動なしでON/OFFする案は未実装。相槌設定の本体反映は起動時、音声割り込みはファーム内固定。[設定同期の相談記録](docs/esp32-ota-settings-plan.md)。

### 環境・ビルド

- Arduino IDE環境を維持する。ユーザーの指示なしにPlatformIO / ESP-IDFへ移行しない。ビルド確認にはArduino IDE付属のarduino-cliも使える。
- ビルド確認済みのコアはArduino ESP32 3.3.11 / IDF 5.5.5。利用可能なAPIは実際のインストール済みコアで確認する。起動時の `[BUILD]` で実機の版を確認する。
- ボードはESP32-S3-MINI-1-N4R2（Flash 4MB、quad PSRAM 2MB）。
- mbedTLSのcallocは `TlsMemory.h` で起動時にPSRAMへ固定し、内部RAMへはフォールバックしない。

リポジトリルートから実行するビルド確認の例（書き込み時は実機のボード・ポート・IDE設定を確認する）:

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=4M,PartitionScheme=no_fs,CDCOnBoot=cdc --build-path "$env:TEMP/toytalker_v07_build" devices/mcu/esp32_s3/toytalker_mini_v0.7
```

### 調査メモ

- [v0.7 AEC試験手順・実機結果・復旧](docs/esp32-v07-aec.md) — AEC全般の入口
- [AC RMS判定と到達点](docs/esp32-aec-gate-ac-2026-09-12.md) — 現行判定方式、今後の改善余地
- [USBログ待ち対策](docs/esp32-usb-log-backpressure-2026-09-12.md) — 現行実機版
- [ボタン反応の修正](docs/esp32-button-response-2026-09-12.md)、[NLP比較](docs/esp32-aec-nlp-comparison-2026-09-12.md)、[入力クリップ比較](docs/esp32-aec-input-headroom-2026-09-12.md)
- [終端調査と修正](docs/esp32-stream-end-investigation-2026-09-12.md)、[本文開始の高速化検討](docs/esp32-v07-latency-review.md)
- [音声介入第一弾（v0.6）](docs/esp32-v06-voice-barge-in.md)、[TLSメモリ調査](docs/esp32-s3-tls-memory-investigation-2026-09-06.md)

## ZakiCorp TTS（クローンボイス, β版）

ローカルPC (RTX 5090) でQwen3-TTSベースのクローンボイスAPIサーバーを稼働。ngrokで公開し、Lambdaから利用する。

### 現在の状態（2026-09-13時点）

- **本番はバッチ推論エンジン第2版**（2026-09-13 12:06反映）。`tts-models/faster-qwen3-tts/api_server_batch.py` + `batch_engine.py`。要求ごとに独立したKV行を持ち、同時32件・実運用上限24件程度、VRAM約20GiB。元の `api_server.py` は無変更で残す。
- 切替は `tools/tts-service/switch-api.ps1 -ApiScript <script>` を昇格実行（`.local/tts-service/config.json` の `api_script` を設定し監視タスク再起動）。復旧は `-ApiScript api_server.py`。ngrok URLは不変でLambda更新は不要。
- 未確認: スマホからの会話確認、長文分割境界の聞こえ方。
- 単独要求の元実装は `StaticCache` が1つで同時要求が互いのKV文脈を上書きする構造があった（言葉の繰り返し・抜けの原因）。バッチ版で解消。

### 起動・監視

- タスクスケジューラ `TTS-AutoStart` がOS起動30秒後に非対話実行（S4U、通常権限、ログオン不要）。APIサーバー + ngrokを監視し、終了後に再起動。URL変更時にLambda環境変数 `ZAKICORP_TTS_URL` を5つ更新する。
- 実装・登録: `tools/tts-service/supervisor.py` / `install.ps1`。実際の配置は `.local/tts-service/`（Git対象外）、ログは `.local/tts-service/logs/`。再適用は保守時間にタスクを停止してから登録する。
- 元のTTSリポジトリの `setup-tasks.ps1` を実行するとログオン起動に戻る。[起動・復旧手順](docs/tts-boot-recovery.md)。
- Windows更新は自動更新を受け入れ、アクティブ時間07:00〜翌01:00。[設定記録](docs/windows-update-restart-control.md)。

ngrok URL変更時のLambda更新対象:

1. `toytalk-stream-handler-lambda` (app TTS)
2. `toytalk-api-stream-for-esp32-lambda` (ESP32 TTS)
3. `toytalker-backchannel-for-app-lambda` (app 相槌)
4. `toytalker-backchannel-for-esp32-lambda` (ESP32 相槌)
5. `toytalker-tts-only-lambda` (app 読み上げ)

### S3 / DynamoDB / 認証

- APIキー `ZAKICORP_API_KEY` は `C:\Users\exodj\projects\tts-models\faster-qwen3-tts\scripts\.env`（サーバー側）と各Lambdaの環境変数にある。リポジトリには書かない。
- S3バケット `toytalker-tts-speakers` — speaker embedding (.pt) のバックアップ
- `toytalker-voices` のZakiCorpエントリ: provider=ZakiCorp, voice_id=zakicorp-{name}, vendor_id={name}

### 調査メモ

- [バッチエンジンの実装と検証](docs/qwen3-tts-batch-engine-2026-09-12.md) — 現行本番版。最初に読む
- [現状まとめ](docs/qwen3-tts-current-status.md) — バッチ版採用前の整理（記述は採用前の状態）
- 経過: [同時要求試験計画](docs/qwen3-tts-concurrency-test-plan.md)、[4〜32件測定](docs/qwen3-tts-capacity-2026-09-12.md)、[プロファイル](docs/qwen3-tts-profile-2026-09-12.md)、[CUDAトレース](docs/qwen3-tts-cuda-trace-2026-09-12.md)、[改善試験](docs/qwen3-tts-improvement-trials-2026-09-12.md)、[可変チャンク](docs/qwen3-tts-dynamic-chunks-2026-09-12.md)、[並列比較](docs/qwen3-tts-parallel-improvement-2026-09-12.md)、[バッチ見込み計測](docs/qwen3-tts-batch-step-bench-2026-09-12.md)
