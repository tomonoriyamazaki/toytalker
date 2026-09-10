# CLAUDE.md

Claude CodeとCodexで共有するシステム概要・開発ルール。Codexはルートの [AGENTS.md](AGENTS.md) からこのファイルを参照する。共通情報はこのファイルを更新し、両ファイルへ重複して記載しない。

## システム構成

子供向け音声AIおもちゃ「ToyTalker」。ユーザーが話しかけると、キャラクターが音声で返答する。

### アーキテクチャ概要

```
[App / ESP32] → STT(Soniox直接WS) → Lambda(LLM+TTS streaming) → 音声再生
                                   → Lambda(相槌: LLM処理中の繋ぎ応答)
```

- **ストリーミング前提設計**: LLM→TTSは直列ストリーミング。最初のチャンクが生成され次第再生開始し、体感レイテンシを最小化
- **STTはLambdaを経由しない**: Soniox一時キーをLambdaが発行し、クライアントがSonioxに直接WebSocket接続（Lambda経由のボトルネック回避）
- **相槌(backchannel)**: メインLLMの処理中に「そうだね〜」等の短い応答を先に返してUXを保つ仕組み
- **App / ESP32は対称構成**: 各々に本Lambda+相槌Lambdaがあり、出力形式だけ異なる（App=base64, ESP32=PCM）

### TTSプロバイダー

複数プロバイダーをプラガブルに切替可能（DynamoDB `toytalker-voices` で管理）:
OpenAI / Google / Gemini / ElevenLabs / FishAudio / Sakura(ずんだもん) / ZakiCorp(自前クローンボイス, β版)

### Lambda一覧

| Lambda | 用途 | ディレクトリ |
|---|---|---|
| `toytalk-stream-handler-lambda` | App用メイン（LLM+TTS streaming） | `backend/toytalk-stream-handler-lambda` |
| `toytalk-api-stream-for-esp32-lambda` | ESP32用メイン（LLM+TTS streaming） | `backend/toytalk-api-stream-for-esp32-lambda` |
| `toytalker-backchannel-for-app-lambda` | App用相槌 | `backend/toytalker-backchannel-for-app-lambda` |
| `toytalker-backchannel-for-esp32-lambda` | ESP32用相槌 | `backend/toytalker-backchannel-for-esp32-lambda` |
| `toytalk-soniox-stt-lambda` | Soniox一時キー発行 | `backend/toytalk-soniox-stt-lambda` |
| `toytalker-device-setting-lambda` | デバイス登録・ボイス設定・コスト管理 | `backend/toytalker-device-setting-lambda` |
| `toytalker-tts-only-lambda` | App用 読み上げ（テキスト→TTSのみ、LLM/STTなし、音声バイナリ直返し） | `backend/toytalker-tts-only-lambda` |

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

- 依頼範囲内の読み取り・調査・通常のコマンド実行・修正は、逐一確認せず進める。削除操作の前はユーザーに確認する。実行環境の権限確認が必要な場合は、その仕組みに従う。
- 「コミットして」と言われたらコミットだけ行う。PR作成・マージ・ブランチクリーンアップは明示的な指示があるまでやらない。
- Lambda関数を修正したら、コミット前にデプロイする。各Lambda配下の `deploy.sh` を実行（例: `cd backend/<lambda-dir> && bash deploy.sh`）。
- PowerShellでgitコマンドを実行するとき、`Set-Location` を使わず `git` から直接実行する（パーミッション設定のパターンマッチが効かなくなるため）。

## ESP32-S3ファーム開発

- AECの開発先は [v0.7](devices/mcu/esp32_s3/toytalker_mini_v0.7/toytalker_mini_v0.7.ino)。AEC自動停止ON、生マイクへのフォールバックは計測のみ。TLSのPSRAM移行、AEC参照待ち・STT補正、Soniox先行接続の別タスク化で、声への停止反応・再生音・本文開始速度は改善報告あり（保存点 `dd77e42`）。13:19の無発声での誤検出に対し、RMS 1,200 / 128msに出力/入力RMS比25%以上と飽和後256msの保護を追加。18:26の再生音による停止の疑いを受け、`AEC_RESET_EACH_TURN=true` で、時刻・参照履歴だけでなくAEC本体も毎ターン再作成する比較版を追加した。18:43に「自分の声で停止し、再生音では停止しない」と改善報告。10ターン目の検出→録音29ms、初回送信62ms、AEC欠落・確保失敗0を確認。状態持越しが原因だったとの確定ではなく、本文開始が重いという懸念は残る。画像には初期化・本文開始の時間がなく、`[AEC_RESET] elapsed_us / ready` と要求開始から `first_tts_i2s_ms` までのログで切り分ける。初期化コスト・再学習・長時間の安定性も比較する。検出前・未接続中の音声保持は未実装。[v0.7の試験手順・実機結果・復旧](docs/esp32-v07-aec.md) を参照。
- [v0.6](devices/mcu/esp32_s3/toytalker_mini_v0.6/toytalker_mini_v0.6.ino) は音量方式の検証版として保持する。AECが合わない場合に大きめの声・再生音量・閾値等を調整する選択肢を残す。現在は自動停止OFF。調整・実機試験・計測結果は [音声介入第一弾](docs/esp32-v06-voice-barge-in.md) を参照。[v0.5](devices/mcu/esp32_s3/toytalker_mini_v0.5/toytalker_mini_v0.5.ino) は実機確認済みの安定版として保持する。OTAは保留。
- ボードはESP32-S3-MINI-1-N4R2（Flash 4MB、quad PSRAM 2MB）。
- Arduino IDE環境を維持する。ビルド確認にはArduino IDE付属のarduino-cliも利用できる。ユーザーの指示なしにPlatformIO / ESP-IDFへ移行しない。
- 2026-09-06にビルド確認した環境はArduino ESP32コア3.3.10。利用可能なAPIやメモリ設定は、実際のインストール済みコアで確認する。
- 2026-09-10のTLS修正時にはインストール済みコアが3.3.11 / IDF 5.5.5へ更新されていた。現在のv0.7はこの環境でビルド確認済み。起動時の `[BUILD]` で実機の版も確認する。
- ビルド確認と実機確認を区別して報告する。通信・音声・メモリの安定性は、ユーザーによる実機の連続会話試験とログで確認する。

### ビルド確認

リポジトリルートから実行するPowerShellの例。`arduino-cli` がPATHにない場合はArduino IDE付属の実行ファイルを指定する。

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=4M,PartitionScheme=no_fs,CDCOnBoot=cdc --build-path "$env:TEMP/toytalker_v07_build" devices/mcu/esp32_s3/toytalker_mini_v0.7
```

これはビルド確認用の設定であり、書き込み時は実機のボード・ポート・Arduino IDE設定を確認する。

### メモリ問題の対応記録

- 相槌タスク終了前にローカルStringを解放する修正を `0d1037a` で採用。ユーザーの実機試験で、以前の8〜10ターンを超えて会話を継続できた。
- v0.5・v0.6ではTLSのPSRAM移行は未採用。v0.7ではAEC追加後の確保失敗を受け、`TlsMemory.h` で起動時に全mbedTLS用callocをPSRAMへ固定する対策を追加した。内部RAMへはフォールバックしない。`[TLS_MEM]` の起動プローブ・失敗数・PSRAM空きと、連続会話の速度・音切れを実機確認する。
- 原因、修正、実機ログ、未採用案は [ESP32-S3 TLSメモリ調査](docs/esp32-s3-tls-memory-investigation-2026-09-06.md) を参照。レポート冒頭の修正後の結論を優先する。

## ZakiCorp TTS（クローンボイス, β版）

ローカルPC (RTX 5090) でQwen3-TTSベースのクローンボイスAPIサーバーを稼働。ngrokでインターネットに公開し、Lambdaから利用する。

### 起動

ログオン時にタスクスケジューラ (`TTS-AutoStart`) が自動起動。手動起動は不要。
- スクリプト: `C:\Users\exodj\projects\tts-models\faster-qwen3-tts\scripts\start-tts-service.ps1`
- APIサーバー + ngrok起動 → URL変更時はLambda環境変数 (`ZAKICORP_TTS_URL`) を5つ自動更新
- ログ: `scripts\tts-service.log` / トースト通知(BurntToast)

### ngrok URL変更時のLambda更新対象

1. `toytalk-stream-handler-lambda` (app TTS)
2. `toytalk-api-stream-for-esp32-lambda` (ESP32 TTS)
3. `toytalker-backchannel-for-app-lambda` (app 相槌)
4. `toytalker-backchannel-for-esp32-lambda` (ESP32 相槌)
5. `toytalker-tts-only-lambda` (app 読み上げ)

### S3 / DynamoDB

- S3バケット: `toytalker-tts-speakers` — speaker embedding (.pt) のバックアップ保管
- DynamoDBテーブル: `toytalker-voices` — ZakiCorpボイスエントリ (provider=ZakiCorp, voice_id=zakicorp-{name}, vendor_id={name})
