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
OpenAI / Google / Gemini / ElevenLabs / Cartesia / FishAudio / Sakura(ずんだもん) / ZakiCorp(自前クローンボイス, β版)

Cartesiaの設定・有効化手順は [Cartesia TTS導入](docs/cartesia-tts.md) を参照。

### コスト記録の方針

- 相槌のLLM・TTSは記録せず `service#margin`（2.0）で吸収する。相槌はデフォルトON。
- LLMのツール呼び出しは、外部の有料API（Serper検索など）だけ回数課金で `tool` として記録する。無料ツール（デバイス設定変更など）はLLMトークンに含まれるので何もしない。[ツールコスト記録](docs/search-cost-tracking.md) を参照。

### システムプロンプトの方針（2026-09-13）

本文応答が素っ気なくなった原因として、検索後の「前置き禁止・中身だけ」の強い指示がシステムプロンプト末尾に毎ターン入っていた点を修正。App/ESP32両方のメインLambdaで、検索ヒントは「検索前の一言」だけに戻し、検索後の指示は検索結果を返す `functionResponse.response.instruction`（`TOOL_RESULT_INSTRUCTION`）に移して検索直後のターンだけに効かせる。相槌ヒントにも「口調や温かさはいつも通り」を追記。口調が戻ったかはユーザーの会話で確認する。

**デプロイ元の注意（2026-09-13の事故）：** Cartesia TTS対応はブランチ `worktree-cartesia-tts`（`.claude/worktrees/cartesia-tts`、mainの上位集合）にあり、mainには未統合。最初にmainの作業ツリーからデプロイしたため11:14〜11:21の間、App/ESP32メインLambdaからCartesiaが消えた。11:21にworktree側へ同じプロンプト修正を入れて再デプロイし復旧（bundleにCartesia参照あり）。**Lambdaをデプロイする前に `git worktree list` と各ブランチの差分を確認し、本番に出ている版がどのブランチかを特定する。** 現在、プロンプト修正はworktree（未コミット）とmain作業ツリー（未コミット、同内容）の両方にある。統合はworktree側を正とし、main側の2ファイルは統合前に破棄してよい。

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

### スクリーンショットの共有

- 保存先は `C:\Users\exodj\Pictures\Screenshots`。
- 「スクショ撮ったから見て」、またはスクショの文脈で「撮ったから見て」と依頼されたら、保存先の画像ファイルを更新日時の新しい順に並べ、最新1枚を開いて確認する。「最新」という指定や画像の貼り付けは不要。
- 「2枚撮った」など枚数の指定があれば、最新の指定枚数を確認する。ファイル名・パスの指定があればそちらを優先する。
- 開いたファイル名または撮影時刻を返答に添え、対象が合っているか分かるようにする。画像が見つからない場合はその旨を伝える。

## ESP32-S3ファーム開発

- 2026-09-12の今回の改修をユーザーが「いい感じ」と受け入れ、コミットとローカルmainへの統合を依頼。到達点は条件付きstream終端救済、ボタン即時消音、AC RMSによる誤停止抑制、USBログ待ち対策。実機再現が未完了の条件と声の反応距離の制約は各調査メモに保持。現行実機と同じ設定で再ビルドするには `--build-property 'compiler.cpp.extra_flags=-DTOYTALKER_AEC_NLP_LEVEL=1'` を付ける（既定NLPはNORMAL）。

- 最新の実機は2026-09-12 23:00台にUSBログ待ち対策を追加した `toytalker_v07_serial_nowait`。Hardware CDCの送信待ちを0にし、PC未受信時はログ欠落を許容して会話処理の待機を防ぐ。AC RMS/AGGR・音声割り込みON・音量・ボタン設定を維持。ビルド・書き込みハッシュ・起動のtimeout=0・STT送信fail=0確認済み。起動確認後に受信ポートを閉じ、未受信状態でのユーザー確認待ち。[調査と修正](docs/esp32-usb-log-backpressure-2026-09-12.md)。

- **2026-09-12のAEC調整は一旦終了。** AC RMS版についてユーザーが「途中停止がだいぶ減ったが、声で止めるには近づく必要がある」と確認し、現設定を維持する方針を指定。Cartesia・サービス音量維持・音声割り込みON・ボタン即時停止ONを基準とする。感度と誤停止の現状のトレードオフを最終的な限界とは扱わない。AEC本体の時刻整列・入力飽和/前処理・フィルタ/NLP等にも未検証の改善候補があり、今回のAC RMS化は後段判定の変更。改善の保証や誤停止の完全解消は未確認。[到達点・今後の改善余地](docs/esp32-aec-gate-ac-2026-09-12.md)に記録。追加調整やスマホ感度設定の実装は今回の終了条件に含めない。以下の「未確認」は各書き込み時点の記録。

- 最新の実機は2026-09-12 21:56に **AC RMSで音声割り込みを判定する比較版** を書き込み。Cartesia・サービス音量維持・割り込みONがユーザー指定。32msフレームの平均を除いたマイク/AEC出力のRMSをゲートへ渡し、再生PCM・音量・AGGR・入力divisor=1・閾値/保持時間・ボタン停止は維持。DC残留の仮説検証で、改善は未確認。数値テスト、ビルド、COM12書き込み・ハッシュ、Soniox/STT送信を確認。保存先 `toytalker_v07_gate_ac_aggr`、ログ取得21:56:11〜22:26:11。[調査・比較手順](docs/esp32-aec-gate-ac-2026-09-12.md)。以下は過去の経緯。

- 最新の実機は2026-09-12 21:48に **音声自動割り込みONへ復帰**。OFF比較でユーザーが最後までの再生とボタン停止を確認した後、Cartesiaを基準にONで調整継続する方針を指定。`AEC_BARGE_DETECT_ONLY=false`、AGGR、入力divisor=1、ボタン即時消音を維持。`toytalker_v07_voice_on_aggr` をビルドしCOM12へ書き込み・ハッシュ検証、起動のaec_detect_only=0とSoniox/STT送信を確認。今回感度は変更しておらず、誤停止は未解決。ログ取得は21:48:59〜22:18:59。同じログファイルを使用。以下のOFF状態は過去の比較記録。

- 現在の実機（2026-09-12 21:38書き込み）は **音声自動割り込みOFF（AEC計測のみ）**、ボタン即時消音あり、AGGR、入力縮小なし。`AEC_BARGE_DETECT_ONLY=true`、入力divisor既定値1に変更し、`toytalker_v07_detect_only_aggr` をCOM12へ書き込み・ハッシュ検証済み。起動ログのaec_detect_only=1、Soniox接続/STT送信を確認。最終文が欠ける症状の比較用で、聴取結果は未確認。AGGR再ビルドには `-DTOYTALKER_AEC_NLP_LEVEL=1` を指定。以前の入力1/4実験は `-DTOYTALKER_AEC_MIC_DIVISOR=4` で選択可能。ログは同じファイルへ21:38:49〜22:08:49の30分取得。[比較記録](docs/esp32-aec-input-headroom-2026-09-12.md)参照。以下は過去の経緯。

- 2026-09-12 21:29に、バリバリ音の比較のため入力1/4縮小前の `toytalker_v07_button_aggr` をCOM12へ書き戻した。実機はAGGR＋ボタン即時消音あり・入力縮小なし。ハッシュ検証、再起動/STT送信確認済み。作業ツリーには入力縮小の比較コードが残っており、現在実機の版と異なる。再ビルド/書き込み時は [入力クリップ比較](docs/esp32-aec-input-headroom-2026-09-12.md) の復旧記録を確認する。

- 2026-09-12 21:08台にAEC入力を飽和前に1/4へ縮小し、判定RMSを4倍補正する比較版をAGGR設定でCOM12へ書き込み。ビルド/数値テスト・起動/STT送信確認済み。直前のCartesia応答はclips=7,043でaec_level停止。改善の実機確認はまだ。ボタン即時消音も維持。[入力クリップ比較](docs/esp32-aec-input-headroom-2026-09-12.md) を参照。

- 2026-09-12 20:40台に短押しの即時消音修正をAGGR設定でCOM12へ書き込み。20:44にユーザーから「一瞬で止まる」と改善報告。ボタン停止4回でISR→消音GPIO操作1〜2µs、録音再開39〜65ms、初回STT送信73〜99msを確認。通常再生完了後の録音復帰も確認。接続待ち中など全局面は未検証。[ボタン反応の修正](docs/esp32-button-response-2026-09-12.md) を参照。

- 2026-09-12のAEC誤停止比較は [NLP比較準備](docs/esp32-aec-nlp-comparison-2026-09-12.md) を参照。デフォルトNORMALを維持し、ビルド指定でAGGRを選べる比較版を追加。参照advanceや割り込み閾値は変更しない。同日20:03にユーザーの依頼でAGGR版をCOM12へ書き込み、ハッシュ検証とWi-Fi/Soniox接続・STT送信を確認。音響評価は未実施。同一PCMの再生用経路もまだなく、通常会話のA/Bは予備比較として扱う。

- 2026-09-12の音声途中停止は、全PCMとdone受信後のconnection_closedでリングを破棄した経路を確認。`fix/esp32-stream-completion`でv0.7に条件付きの再生継続を追加。模擬テスト・ビルド済み。同日14:18にCOM12へ書き込み、Wi-Fi/Soniox接続とSTT送信を確認。その後ユーザーから通常会話は問題なしと報告。元の終端切断と救済経路は実機で未確認のため、通常利用で様子を見て再発時に調べる方針。条件・ログ・試験手順は [終端調査と修正](docs/esp32-stream-end-investigation-2026-09-12.md) を参照。Soniox再接続後の録音停止は別件。

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

同時要求の検証は [試験計画](docs/qwen3-tts-concurrency-test-plan.md) と [2026-09-12の4〜32件測定](docs/qwen3-tts-capacity-2026-09-12.md) を参照。1〜16件では全体の音声生成倍率が約3.1倍でほぼ一定。16件は48/48受信完了、32件は1/32完了・31件期限超過で中止。32件後の残存処理・ヘルス不応答をAPI再起動で復旧し、単独生成成功を確認。初回2件の音声はユーザー聴取で正常。4〜32件の内容・キャッシュ干渉・100人対応は未確認。

内部時間の実測は [2026-09-12のプロファイル](docs/qwen3-tts-profile-2026-09-12.md) を参照。単独要求5件でトークン生成約81%、波形デコード約19%。計測なし/ありの生成倍率は3.181/3.159倍。改善はまだ未実施。実験後は通常APIの音声生成・外部health・監視タスクの稼働を確認済み。

GPU詳細計測は [2026-09-12のCUDAトレース](docs/qwen3-tts-cuda-trace-2026-09-12.md) を参照。トークン生成区間のGPU活動時間割合は約80%、波形変換は約15%（計測下の単独1件、最大演算能力の使用率ではない）。重複トークン除去・波形変換の呼び出し削減が比較候補。トレース取得の影響があるため、改善効果は計測なしで検証する。通常サービスは復帰確認済み。

改善候補の比較は [2026-09-12の改善試験](docs/qwen3-tts-improvement-trials-2026-09-12.md) を参照。重複トークン除去の固定マスク化は同seedの波形完全一致、HTTP処理時間約0.95%減。chunk_size=8/12は生成倍率約9%/13%増だが初回PCMが約0.22/0.35秒遅い。両変更の組合せ・可変chunk・並列性能は未測定。本番は元の実装・chunk_size=4へ復帰し音声生成を確認済み。

可変チャンクの比較は [2026-09-12の可変チャンク試験](docs/qwen3-tts-dynamic-chunks-2026-09-12.md) を参照。先頭6チャンクを4のまま保ち後続8にすると、単独短文で処理量約7.2%増・初回PCM約0.079秒増。後続12は約9.5%増・初回約0.172秒増。36件成功、本番は元設定に復帰済み。可変版の聴取・並列性能は未確認。

可変チャンク試験の聴取追記：通常4と先頭6チャンクを4・後続8にした保存WAVは、ユーザーが「全く違和感なし」と確認済み。可変12の聴取・並列性能は未確認。本番適用は行っていない。

可変版の同時2件・4件は [改善版の並列要求比較](docs/qwen3-tts-parallel-improvement-2026-09-12.md) を参照。通常/改善の計60件受信成功。改善版の総生成倍率は2件3.40倍、4件3.31倍で増えず、4件は20/20で模擬再生枯渇。4件の音声長も通常版より増えており、速度差の解釈と聴取確認が必要。本番は元設定に復帰済み。

並列要求の聴取追記：改善版4件同時の先頭バースト（`20260912T125241_468029Z`）はユーザー報告で00/01に違和感、02/03は問題なし。症状の具体像・原因は未確定。受信成功を品質正常とは扱わず、改善版の本番適用はしていない。

TTS調査の現在地は [現状まとめ](docs/qwen3-tts-current-status.md) を最初に参照。改善版の4件同時で00/01に言葉の繰り返し・抜け、声の崩れ・ノイズはなしとユーザー報告。02/03は正常。本番未適用、負荷試験は停止中。

2026-09-12夜の追記：繰り返し・抜けの有力原因は、`talker_graph.py` の `StaticCache` がサーバーに1つしかなく、同時要求が交互に進むたびに互いのKV文脈を上書きする構造（元実装の問題、可変チャンク版は無関係）。本番でも要求が重なれば起きる。未対策。総処理量が伸びないのも同じ構造による。バッチNで1ステップを測ると N=1 19.9ms / N=8 27.9ms / N=16 38.3ms で、総音声生成倍率の見込みは N=8 で約18倍（現行約3.1倍）。[見込み計測](docs/qwen3-tts-batch-step-bench-2026-09-12.md)。

同日深夜にバッチ推論エンジンを実装（`tts-models/faster-qwen3-tts/batch_engine.py`、`api_server_batch.py`。元の `api_server.py` とライブラリは無変更）。要求ごとに独立したKV行を持ち、1/2/4/8/16のCUDA graphを1本のワーカースレッドで回す。HTTP経由で同時16件 20.95倍・初回PCM p95 0.84秒・枯渇0/48、同時4件 9.42倍・0.42秒、単独の初回PCM 0.25秒。隠れ状態は元実装とbf16 1〜2ulp以内で一致。[実装と検証](docs/qwen3-tts-batch-engine-2026-09-12.md)。ユーザー聴取で同一文8件・別話者8件とも問題なし（`measure-000-06` の末尾切れは旧実装にもある生成側のEOS判定で、並列とは無関係と波形で確認）。

**2026-09-13 10:27にユーザー指示で本番をバッチ版へ切替済み。** `tools/tts-service/switch-api.ps1 -ApiScript api_server_batch.py` を昇格実行し、`.local/tts-service/config.json` の `api_script` を設定、監視タスク再起動、ローカル・公開healthを確認。ngrok URLは不変でLambda更新なし。切替前の設定は `.local/tts-service/config.json.20260913-102735.bak` 等に退避。復旧は同スクリプトを `-ApiScript api_server.py` で昇格実行。切替後にngrok経由で同時1/4/8件と別話者8件を確認済み（8件で14.75倍・初回p95 0.63秒・枯渇0）。4件試験で1件だけ28秒の生成があり、同時実行の干渉ではないことを行単位の完全一致検査で確認（他行の有無・行移動で出力差0）。最初のトークンの反復ペナルティ漏れを修正し、10:40に同スクリプトで本番を再起動済み。`supervisor.py` は `config.json` の `api_script` でAPIを選ぶ。手順は [起動・復旧](docs/tts-boot-recovery.md)、結果は [実装と検証](docs/qwen3-tts-batch-engine-2026-09-12.md) 参照。スマホからの会話確認は未実施。

### 起動

2026-09-11にタスクスケジューラ (`TTS-AutoStart`) をOS起動30秒後の非対話実行（S4U、通常権限）へ変更。ログオン不要。監視は現在稼働中で、既存API/ngrokの引継ぎと外部ヘルス確認に成功。OS再起動後の音声生成確認は未実施。
- 実装・登録: `tools/tts-service/supervisor.py` / `tools/tts-service/install.ps1`
- 実際の配置: `.local/tts-service/`（Git対象外、登録時のコピー）。再適用は保守時間にタスクを停止してから登録する。
- APIサーバー + ngrokを監視し、プロセス終了後に再起動。モデル準備・公開ヘルス確認後、URL変更時にLambda環境変数 (`ZAKICORP_TTS_URL`) を5つ更新。
- ログ: `.local/tts-service/logs/`。既存の認証ファイルを参照し、画面通知に依存しない。
- 元のTTSリポジトリの`setup-tasks.ps1`を実行するとログオン起動に戻る。[適用・検証・復旧手順](docs/tts-boot-recovery.md)を参照。

### ngrok URL変更時のLambda更新対象

Windows更新は自動更新を受け入れる運用。2026-09-12に一時停止を解除し、アクティブ時間を手動で07:00〜翌01:00（時間外01:00〜07:00）へ設定済み。Proへの変更・恒久的な手動更新化は進めない。[Windows更新の設定・調査記録](docs/windows-update-restart-control.md)を参照。

1. `toytalk-stream-handler-lambda` (app TTS)
2. `toytalk-api-stream-for-esp32-lambda` (ESP32 TTS)
3. `toytalker-backchannel-for-app-lambda` (app 相槌)
4. `toytalker-backchannel-for-esp32-lambda` (ESP32 相槌)
5. `toytalker-tts-only-lambda` (app 読み上げ)

### S3 / DynamoDB

- S3バケット: `toytalker-tts-speakers` — speaker embedding (.pt) のバックアップ保管
- DynamoDBテーブル: `toytalker-voices` — ZakiCorpボイスエントリ (provider=ZakiCorp, voice_id=zakicorp-{name}, vendor_id={name})
- 単価: `toytalker-api-unit-prices` の `zakicorp#tts` を2026-09-13に暫定登録（$0.000025/文字、Cartesiaの半額、model=qwen3-tts-1.7b）。それまで `[Pricing] missing price for zakicorp#tts` でコスト集計から抜けていた。正式な単価は未決定。
