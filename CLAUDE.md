# CLAUDE.md

Claude CodeとCodexで共有するシステム概要・開発ルール。Codexはルートの [AGENTS.md](AGENTS.md) からこのファイルを参照する。共通情報はこのファイルを更新し、両ファイルへ重複して記載しない。

**このファイルの運用**: 書くのは「ルール・システム構成・各領域の入口へのリンク」だけ。各領域の「現在の状態」は入口文書が持ち、上書きで更新する。日付付きの経過は積み上げず `docs/` の調査メモへ書き、要点は入口へ統合して個別メモは消す。意図的に先送りした項目と却下理由は [先送り項目](docs/deferred-items.md)。**残っている作業の全体と順番は [ロードマップ](docs/roadmap.md) が入口**（項目が済んだら更新する）。

## 各領域の入口

- 残作業全体: [ロードマップ](docs/roadmap.md)。やらないと決めたことは [先送り項目](docs/deferred-items.md)
- インフラ（CDK・複数アカウント）: 状態は [ロードマップ](docs/roadmap.md) の「いまの状態」、決定と根拠は [複数アカウント計画](docs/multi-account-iac-plan.md) と [命名規則](docs/naming-conventions.md)、手順は [infra/README](infra/README.md)
- セキュリティ: [セキュリティ見直し](docs/security-review-2026-10-25.md)
- ESP32ファーム: [ESP32ファーム](docs/esp32-firmware.md)（状態・ビルド・調査メモ一覧）
- ZakiCorp TTS（クローンボイス）: [ZakiCorp TTS](docs/zakicorp-tts.md)（状態・所在）、[起動・復旧](docs/tts-boot-recovery.md)（手順）、[バッチエンジン](docs/qwen3-tts-batch-engine-2026-09-12.md)（設計・計測）
- 利用者認証（Cognito + Google / Apple。ロードマップ4）: [利用者認証](docs/auth.md)（状態・仕組み・各社側の設定・確認の仕方）
- 原価・課金・前払いポイント制: [原価と課金の考え方](docs/pricing-and-cost-model.md)
- TTSフォールバックと通知（未実装）: [仕様](docs/tts-fallback-and-notifications.md)。Cartesiaの設定は [Cartesia TTS導入](docs/cartesia-tts.md)
- MacBookでの開発: [MacBook引き継ぎ](docs/handoff-macbook-2026-09.md)

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
- **TTSプロバイダー**は DynamoDB `toytalker-voices` で切替: OpenAI / Google / Gemini / ElevenLabs / Cartesia / FishAudio / Sakura(ずんだもん) / ZakiCorp(自前クローンボイス, β版。ローカルPCのQwen3-TTSを `https://tts.zakicorp.com` で公開)。
- **インフラ**: RnDアカウントのToyTalker資源はCDK（`infra/`）のスタック `ToyTalker-rnd` の管理下。APIキー類の正本はSSM `/toytalker/<key>` で、Lambdaが実行時に読む（環境変数に鍵は無い）。テーブル名はCDKが配る `TABLE_SUFFIX` から `backend/shared/tables.mjs` で組む。
- **Lambdaログ**: 会話経路の各Lambdaが1リクエスト1行のJSONを出す（`backend/shared/trace.mjs`）。**会話の文章（発話・返答・検索語・相槌）はログに書かない**（正本は `chat-logs`）。新しいログを足すときも文章を入れない。項目と見方は [infra/README](infra/README.md) の「Lambdaログの見方」。
- デバイス世代: v1 Raspberry Pi（廃止）、v2 スマホアプリ経由（現行）、v3 ESP32-S3スタンドアロン（現行、アプリ不要で直接AWS通信）。
- **Lambda 8本**（ディレクトリは `backend/<Lambda名>`）: App用メイン `toytalk-stream-handler-lambda`、ESP32用メイン `toytalk-api-stream-for-esp32-lambda`、相槌 `toytalker-backchannel-for-app-lambda` / `-for-esp32-lambda`、Soniox一時キー発行（ESP32のOTA更新確認も同梱）`toytalk-soniox-stt-lambda`、本人（`/me`）・デバイス登録・ボイス設定・コスト管理・クローンボイス登録 `toytalker-device-setting-lambda`、App用読み上げ `toytalker-tts-only-lambda`、月次運用レポート `toytalker-ops-monthly-lambda`。ほかに Cognito の登録前トリガー `toytalker-auth-presignup-lambda`（同じメールの利用者を1人にする）。DynamoDB 9テーブルは `backend/shared/tables.mjs`（`users` は Cognito の sub → owner_id）。
- **利用者認証**: Cognito の ID トークンを `x-toytalker-token` ヘッダーで送り、Lambda が `backend/shared/auth.mjs` で検証する。本番はトークン必須、RnD はトークン無しも通す（`infra/config/stages.ts` の `auth.required`）。ESP32 はログインせず、本番では登録済みの機器だけ通す。詳細は [利用者認証](docs/auth.md)。

### コスト記録の方針

- 料金体系（原価・マージン2.0・前払いポイント・プレミアムボイス）と前払いポイント制の実装仕様（未実装。購入機能は認証の後）は [原価と課金の考え方](docs/pricing-and-cost-model.md)。
- 相槌のLLM・TTSは記録せず `service#margin`（2.0）で吸収する。LLMのツール呼び出しは外部の有料API（Brave検索など）だけ回数課金で `tool` として記録する。
- 為替は毎月1日に月次Lambdaが自動保存し、点検をメールする。単価は自動更新しない。`zakicorp#tts` の単価は暫定（$0.000025/文字）。
- Cartesiaの429時は返答単位でずんだもんへ切り替えて会話を止めない（未実装）。複数アカウントでの上限回避はしない。

## ワークフロールール

- 依頼範囲内の読み取り・調査・通常のコマンド実行・コード修正は、逐一確認せず進める。
- **本番に影響する操作（Lambdaデプロイ・AWS設定変更・DynamoDB書き込み）と削除操作は、何をするかを説明してからユーザーの明示的なOKを得て実行する。** 説明と実行を同じターンでやらない。
- **作業は原則worktreeで行う（1つの作業ツリーに1セッション）。** 依頼を受けたら `.claude/worktrees/<name>` にブランチを切って始め、聞かない。終わったらmainへfast-forwardし、了承を得てworktreeとブランチを消す。CLAUDE.mdなど共有ファイルの大規模整理は1セッションだけで行う。
- 「コミットして」と言われたらコミットし、そのまま現在のブランチへpushする。PR作成・マージ・ブランチクリーンアップは明示的な指示があるまでやらない。
- Lambda関数を修正したら、コミット前にデプロイして動作確認する。**デプロイは `cd infra && npx cdk synth --context stage=rnd --context nag=true`（cdk-nagの静的点検。指摘ゼロ）→ `npx cdk diff --context stage=rnd` で差分を見てから `npx cdk deploy --context stage=rnd`**（資格情報はSSO。CDKが環境変数を上書きするので、手作業で環境変数を変えても次のdeployで戻る）。
- **Lambdaのデプロイ元はmain。** デプロイ前に `git worktree list` と各ブランチの差分を確認し、本番に出ている版がどのブランチかを特定する（2026-09-13に別worktreeの変更を含まない作業ツリーからデプロイし、数分間本番からCartesiaが消えた）。`cdk diff` で差分が出るLambdaが意図したものだけか、Replaceが無いかを確認する。
- PowerShellでgitコマンドを実行するとき、`Set-Location` を使わず `git` から直接実行する（パーミッション設定のパターンマッチが効かなくなるため）。
- ビルド確認と実機確認を区別して報告する。通信・音声・メモリの安定性は、ユーザーによる実機の連続会話試験とログで確認する。
- 原因不明の問題の診断は「証拠→仮説（推測と明示）→合意→検証」の順で進め、証拠が足りない仮説を断定口調で言わない。対策は「根治か、痛み止めか」を一言で明示する。
- 話題が変わる区切りや、コンテキストが膨らんだら、新しいセッションでの再開を提案する。「引き継ぎmd書いて」と言われたら、状況・決定事項・残タスクを該当領域の入口文書へまとめる（新しい引き継ぎ文書は作らない）。
- 破壊的・不可逆な操作（DynamoDBの削除/更新、Lambda削除、`Remove-Item`、`git reset --hard` 等）のパーミッションは `ask` のままにし、`allow` へ移す提案はしない。
- MacBookで開発するときは [MacBook引き継ぎ](docs/handoff-macbook-2026-09.md) を最初に読む。Windows固有のルール（PowerShell、スクリーンショット、`tools/tts-service/`）はMacでは該当しない。

### スクリーンショットの共有

- 保存先は `C:\Users\exodj\Pictures\Screenshots`。「スクショ撮ったから見て」等の依頼では、更新日時の新しい順で最新1枚を開く（枚数指定があれば最新の指定枚数、ファイル名指定があればそちら）。開いたファイル名または撮影時刻を返答に添える。

### ESP32-S3ファーム開発のルール

現在の状態・環境・ビルドコマンド・調査メモは [ESP32ファーム](docs/esp32-firmware.md)。

- Arduino IDE環境を維持する。ユーザーの指示なしにPlatformIO / ESP-IDFへ移行しない。利用可能なAPIは実際のインストール済みコアで確認する。
- **フォルダは v0.7 の1つで、配布した版は git タグ `fw-<版>` で残す**（版ごとのフォルダは作らない）。
- AEC調整は一旦終了。再開するときは入口文書の調査メモを読み、却下済みの案（入力1/4縮小、音量方式）を再提案しない。

### ZakiCorp TTSのルール

現在の状態・公開経路・監視・鍵の所在は [ZakiCorp TTS](docs/zakicorp-tts.md)。

- 公開URLの正本は `infra/config/stages.ts` の `zakicorpTtsUrl`。URLを変えるときは監視タスクの `public_url` も直す。
- 監視タスクの再登録は保守時間にタスクを停止してから行う。APIキーとEdgeキーはリポジトリに書かない（サーバー側 `scripts/.env` とSSM）。
