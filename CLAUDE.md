# CLAUDE.md

Claude CodeとCodexで共有するシステム概要・開発ルール。Codexはルートの [AGENTS.md](AGENTS.md) からこのファイルを参照する。共通情報はこのファイルを更新し、両ファイルへ重複して記載しない。

**このファイルの運用**: 書くのは「コードから読み取れないこと」だけ（ルール、事故の教訓、本番に出ている版、未確認の事項）。各領域の「現在の状態」は上書きし、日付付きの経過は積み上げずに `docs/` の調査メモへ書く。調査メモは領域ごとの入口1本に要点を統合し、1日単位の個別メモは統合後に削除する（2026-09-13に40本→24本へ整理）。意図的に先送りした項目と却下理由は [先送り項目](docs/deferred-items.md) に書く。

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
- LLMのツール呼び出しは、外部の有料API（Serper検索など）だけ回数課金で `tool` として記録する。無料ツールは何もしない。手順は [原価と課金の考え方](docs/pricing-and-cost-model.md) の第9節。
- 為替は毎月1日に `toytalker-ops-monthly-lambda` が自動保存し、先月の実費・各社請求・単価行の点検をメールする。単価は自動更新しない。手順は [原価と課金の考え方](docs/pricing-and-cost-model.md) の第10節。
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
- **作業は原則worktreeで行う（1つの作業ツリーに1セッション）。** 依頼を受けたら `.claude/worktrees/<name>` にブランチを切って始め、聞かない。同じ作業ツリーを複数セッションで共有すると、ファイルの選り分けや相手の作業待ちが発生する（2026-09-13）。終わったらmainへfast-forwardし、了承を得てworktreeとブランチを消す。CLAUDE.mdなど共有ファイルの大規模整理は1セッションだけで行う。
- 「コミットして」と言われたらコミットだけ行う。PR作成・マージ・ブランチクリーンアップは明示的な指示があるまでやらない。
- Lambda関数を修正したら、コミット前にデプロイして動作確認する。各Lambda配下の `deploy.sh` を実行（例: `cd backend/<lambda-dir> && bash deploy.sh`）。
- **Lambdaのデプロイ元はmain。** デプロイ前に `git worktree list` と各ブランチの差分を確認し、本番に出ている版がどのブランチかを特定する（2026-09-13に別worktreeの変更を含まない作業ツリーからデプロイし、数分間本番からCartesiaが消えた）。
- PowerShellでgitコマンドを実行するとき、`Set-Location` を使わず `git` から直接実行する（パーミッション設定のパターンマッチが効かなくなるため）。
- ビルド確認と実機確認を区別して報告する。通信・音声・メモリの安定性は、ユーザーによる実機の連続会話試験とログで確認する。
- 原因不明の問題の診断は「証拠→仮説（推測と明示）→合意→検証」の順で進め、証拠が足りない仮説を断定口調で言わない。対策を出すときは「根治か、痛み止めか」を一言で明示する。
- 話題が変わる区切りや、コンテキストが膨らんだら、新しいセッションでの再開をこちらから提案する。「引き継ぎmd書いて」と言われたら、状況・決定事項・残タスクを `docs/` にまとめる。
- 破壊的・不可逆な操作（DynamoDBの削除/更新、Lambda削除、`Remove-Item`、`git reset --hard` 等）のパーミッションは `ask` のままにし、`allow` へ移す提案はしない。
- MacBookで開発するときは [MacBook引き継ぎ](docs/handoff-macbook-2026-09.md) を最初に読む。Windows固有のルール（PowerShell、スクリーンショット保存先、`tools/tts-service/`）はMacでは該当しない。

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

- [v0.7 AEC試験手順・実機結果・復旧](docs/esp32-v07-aec.md) — AEC全般の入口。NLP=AGGRの根拠とボタン即時消音の実測もここ
- [AC RMS判定と到達点](docs/esp32-aec-gate-ac-2026-09-12.md) — 現行判定方式、今後の改善余地、再開時の切り分け手順
- [終端調査と修正](docs/esp32-stream-end-investigation-2026-09-12.md) — 終端救済の実装と、AEC閾値の根拠になったturn=18/20の実測
- [USBログ待ち対策](docs/esp32-usb-log-backpressure-2026-09-12.md) — 現行実機版の最後の変更
- [入力クリップ比較](docs/esp32-aec-input-headroom-2026-09-12.md) — 入力1/4縮小を却下した記録。再提案しないために残す
- [音声介入第一弾（v0.6）](docs/esp32-v06-voice-barge-in.md) — 音量方式が不可と分かった根拠、RXターンごと再確保の由来
- [TLSメモリ調査](docs/esp32-s3-tls-memory-investigation-2026-09-06.md) — Stringリーク修正の経緯と、未修正のリスク一覧
- [v0.5 再生終了の計測](docs/esp32-playback-end-timing.md) — v0.5のみ。v0.7はI2S APIが違う
- [配布実機の音途切れ報告（2026-09-11）](docs/device-audio-investigation-2026-09-11.md) — サーバー側調査、原因未特定。実機の版照合が未着手
- 本文開始の高速化で保留した候補は [先送り項目](docs/deferred-items.md)

## ZakiCorp TTS（クローンボイス, β版）

ローカルPC (RTX 5090) でQwen3-TTSベースのクローンボイスAPIサーバーを稼働。Cloudflare Tunnelで `https://tts.zakicorp.com` として公開し、Lambdaから利用する（2026-09-13にngrokから切替、同日ngrok撤去）。

### 現在の状態（2026-09-13時点）

- **本番はバッチ推論エンジン第2版**（2026-09-13 12:06反映）。`tts-models/faster-qwen3-tts/api_server_batch.py` + `batch_engine.py`。要求ごとに独立したKV行を持つ。本番は `scripts/.env` の `TTS_BATCH_CLASSES=1,2,4,8,16` で同時16件構成（VRAM約11GiB、他のGPU用途と同居するため。2026-09-13夜に32件構成・約19GiBから変更）。17件目以降は待ち行列。32件構成へ戻すには `.env` の行を消して再起動。元の `api_server.py` は無変更で残す。
- 切替は `tools/tts-service/switch-api.ps1 -ApiScript <script> [-PublicUrl <url>]` を昇格実行（`.local/tts-service/config.json` の `api_script`/`public_url` を設定し監視タスク再起動、APIは約40秒停止）。復旧は `-ApiScript api_server.py`。公開URLは固定なのでLambdaの再設定は不要。
- ユーザー確認済み（2026-09-13）: アプリでの会話、Cloudflare経由と合言葉遮断後の会話、クローンボイス登録、PC再起動後の自動復帰。未確認: 長文分割境界の聞こえ方。
- 単独要求の元実装は `StaticCache` が1つで同時要求が互いのKV文脈を上書きする構造があった（言葉の繰り返し・抜けの原因）。バッチ版で解消。

### 公開経路（2026-09-13にCloudflare Tunnelへ切替）

- 公開URLは固定の **`https://tts.zakicorp.com`**。Cloudflare Tunnel `toytalker-tts`（ID `8bc0e7f0-…`、locally-managed）を Windowsサービス `cloudflared`（自動起動）が張る。東京拠点、無料プラン、転送量課金なし。
- `zakicorp.com` のDNSはRoute 53からCloudflare（無料）へ移行済み。`toytalk.zakicorp.com`（S3+CloudFrontのサイト）とACM検証用CNAMEもCloudflare側に置いた（どちらもDNS only）。登録先はお名前.com、期限は自動更新。
- 監視タスクは `config.json` の `public_url` にこのURLを持ち、`/health` を確認してLambda 6本の `ZAKICORP_TTS_URL` を維持する。Cloudflareは `Python-urllib` のUser-Agentを403で弾くため、監視は `toytalker-supervisor/1.0` を名乗る。
- 設定・認証情報の所在、正常確認、復旧、ngrokへの戻し方（`switch-api.ps1 -PublicUrl ''`）は [起動・復旧](docs/tts-boot-recovery.md) の「公開経路」節。`cloudflared service install` は `--config` を保存しないので `tools/tts-service/cloudflared-service-fix.ps1` でImagePathに明示する。
- 拠点での遮断: WAFカスタムルール `tts-edge-key-required` が `X-Zakicorp-Edge-Key` ヘッダー（Lambda環境変数 `ZAKICORP_EDGE_KEY`、サーバー側 `.env` にも同値）の無い要求を403で落とす（2026-09-13）。期限なし。公開側 `/health` は `status` のみ、話者登録名は英数字と `-_` に限定。詳細と鍵の入れ替え手順はランブック。
- ngrokは2026-09-13 18:02に撤去（`public_url` 設定中は監視タスクが起動しない。`switch-api.ps1 -PublicUrl ''` で復活）。再起動試験済み（17:48、ログイン前にトンネル・API・監視が復帰）。Route 53の `zakicorp.com` ホストゾーンは2026-09-13に削除済み（`zackey.xyz` は残る）。

### 起動・監視

- タスクスケジューラ `TTS-AutoStart` がOS起動30秒後に非対話実行（S4U、通常権限、ログオン不要）。APIサーバー + ngrokを監視し、終了後に再起動。`public_url` が設定されていればそのURLを、無ければngrokのURLをLambda環境変数 `ZAKICORP_TTS_URL`（5つ）へ同期する。
- 実装・登録: `tools/tts-service/supervisor.py` / `install.ps1`。実際の配置は `.local/tts-service/`（Git対象外）、ログは `.local/tts-service/logs/`。再適用は保守時間にタスクを停止してから登録する。
- 元のTTSリポジトリの `setup-tasks.ps1` を実行するとログオン起動に戻る。[起動・復旧手順](docs/tts-boot-recovery.md)。
- Windows更新は自動更新を受け入れ、アクティブ時間07:00〜翌01:00。[設定記録](docs/windows-update-restart-control.md)。

`ZAKICORP_TTS_URL` の同期対象（`public_url` 未設定時はngrok URL変更のたびに更新）:

1. `toytalk-stream-handler-lambda` (app TTS)
2. `toytalk-api-stream-for-esp32-lambda` (ESP32 TTS)
3. `toytalker-backchannel-for-app-lambda` (app 相槌)
4. `toytalker-backchannel-for-esp32-lambda` (ESP32 相槌)
5. `toytalker-tts-only-lambda` (app 読み上げ)
6. `toytalker-device-setting-lambda` (クローンボイス登録 `/v1/speakers/register`。2026-09-13まで同期対象から漏れていた)

### S3 / DynamoDB / 認証

- APIキー `ZAKICORP_API_KEY` は `C:\Users\exodj\projects\tts-models\faster-qwen3-tts\scripts\.env`（サーバー側）と各Lambdaの環境変数にある。リポジトリには書かない。
- S3バケット `toytalker-tts-speakers` — speaker embedding (.pt) のバックアップ
- `toytalker-voices` のZakiCorpエントリ: provider=ZakiCorp, voice_id=zakicorp-{name}, vendor_id={name}

### 調査メモ

- [バッチエンジンの実装と検証](docs/qwen3-tts-batch-engine-2026-09-12.md) — 現行本番版。最初に読む。設計の根拠になった事前計測（見込み計測・CUDAトレース・改善候補比較）もここ
- [調査の経緯](docs/qwen3-tts-current-status.md) — 元実装の問題発見から本番反映までの時系列、元実装の分析と却下した案
- [元実装の1〜32件測定](docs/qwen3-tts-capacity-2026-09-12.md) — バッチ版の改善幅の比較対象
- [計測方法と用語の定義](docs/qwen3-tts-concurrency-test-plan.md) — TTFA・生成倍率・模擬再生枯渇の定義。未実施の試験一覧
