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
- 20:09の11ターン目に意図しないAEC停止を確認（`cause=aec_level`、候補窓の比率92.5%、検出→録音31ms）。その後のユーザー比較では、机に置く・最初から手に持って静止・再生途中に持ち上げる、の3条件は問題なし。長い線でつながった未固定のスピーカーをマイクへ向けると停止した。次は実際に使う位置・向きへ固定して比較する。音響経路や入力レベルの変化が有力な手掛かりだが、一時的な再適応・定常的な消し残り・飽和のどれかは未確定で、累積する同期ずれと断定しない。AECの抑制強度と割り込み判定には調整余地があるが、現行設定を維持。現行はAEC後の音量判定であり、人の声の識別ではない。[実機記録と次の確認](docs/esp32-v07-aec.md) を参照。
- 本文の前置き重複対策として、v0.7の本文要求で `backchannel_fired` に「再生済み、または取得済みPCMを本文前に再生予定」を反映する修正を追加。実再生用の `backchannelFired` は早めに変更しない。`[BC] reply_hint / planned / played` と実際の本文で確認する。ユーザーが更新したLambdaの検索用プロンプトは維持。相槌取得と本文要求の並行化は保留、本文の32KBプリバッファも維持する。詳しくは [本文開始の高速化検討](docs/esp32-v07-latency-review.md) と [実機試験手順](docs/esp32-v07-aec.md) を参照。
- Arduino IDE環境を維持する。ビルド確認にはArduino IDE付属のarduino-cliも利用できる。ユーザーの指示なしにPlatformIO / ESP-IDFへ移行しない。
- 2026-09-06にビルド確認した環境はArduino ESP32コア3.3.10。利用可能なAPIやメモリ設定は、実際のインストール済みコアで確認する。
- 2026-09-10のTLS修正時にはインストール済みコアが3.3.11 / IDF 5.5.5へ更新されていた。現在のv0.7はこの環境でビルド確認済み。起動時の `[BUILD]` で実機の版も確認する。
- ビルド確認と実機確認を区別して報告する。通信・音声・メモリの安定性は、ユーザーによる実機の連続会話試験とログで確認する。

### セッション引き継ぎ（2026-09-10）

- ユーザーが現状を次の開発の基準として受け入れ、ほかの改修へ進むため `feature/firmware-v0.6-voice-barge-in` の `9925fe0` までをローカル `main` へマージするよう依頼。次の作業の開始点は統合後の `main`。スピーカー配置による停止等は既知の制約として記録し、追加のAEC調整を今回の統合条件にはしない。マージ名は `Merge firmware v0.7 AEC barge-in improvements`。再開時は `git status` / `git log` で最新状態を確認する。
- `9925fe0` にv0.7の②相槌通知修正と引き継ぎ文書を保存済み。ファームはビルド済みで、通常会話での通知値と効果の対応は実機確認途中。`18756d0`（認証チェックリスト・運用費用資料）、`87035d8`（Lambdaの検索後の前置き抑制）、`d3a59a8`（AEC誤停止対策・毎ターン再初期化）も統合に含む。
- スマホから音声割り込み・相槌を再起動なしでON/OFFする案は相談段階で未実装。現状の相槌設定はスマホから保存できるが、本体への反映は起動時。音声割り込みはファーム内の固定設定。現状の経路と変更候補は [設定同期の相談記録](docs/esp32-ota-settings-plan.md) を参照。

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

2026-09-11にタスクスケジューラ (`TTS-AutoStart`) をOS起動30秒後の非対話実行（S4U、通常権限）へ変更。ログオン不要。監視は現在稼働中で、既存API/ngrokの引継ぎと外部ヘルス確認に成功。OS再起動後の音声生成確認は未実施。
- 実装・登録: `tools/tts-service/supervisor.py` / `tools/tts-service/install.ps1`
- 実際の配置: `.local/tts-service/`（Git対象外、登録時のコピー）。再適用は保守時間にタスクを停止してから登録する。
- APIサーバー + ngrokを監視し、プロセス終了後に再起動。モデル準備・公開ヘルス確認後、URL変更時にLambda環境変数 (`ZAKICORP_TTS_URL`) を5つ更新。
- ログ: `.local/tts-service/logs/`。既存の認証ファイルを参照し、画面通知に依存しない。
- 元のTTSリポジトリの`setup-tasks.ps1`を実行するとログオン起動に戻る。[適用・検証・復旧手順](docs/tts-boot-recovery.md)を参照。

### ngrok URL変更時のLambda更新対象

1. `toytalk-stream-handler-lambda` (app TTS)
2. `toytalk-api-stream-for-esp32-lambda` (ESP32 TTS)
3. `toytalker-backchannel-for-app-lambda` (app 相槌)
4. `toytalker-backchannel-for-esp32-lambda` (ESP32 相槌)
5. `toytalker-tts-only-lambda` (app 読み上げ)

### S3 / DynamoDB

- S3バケット: `toytalker-tts-speakers` — speaker embedding (.pt) のバックアップ保管
- DynamoDBテーブル: `toytalker-voices` — ZakiCorpボイスエントリ (provider=ZakiCorp, voice_id=zakicorp-{name}, vendor_id={name})
