# ESP32 OTA・設定同期・状態送信の準備

2026-09-07の相談内容と、2026-09-10の音声割り込み・相槌ON/OFFの追加相談。以下は実装方針・候補であり、OTA・設定同期拡張・センサー送信の実装完了を意味しない。

## 実機の開発設定

ユーザー提供のArduino IDE画面ではESP32S3 Dev Module、Flash 4MB、QIO 80MHz、QSPI PSRAM、CPU 240MHz、Arduino/Events Core 1。USB CDC On BootはEnabled、USB ModeはHardware CDC and JTAG。

Partition Schemeは **No FS 4MB (2MB APP x2)** (`no_fs`)。コア3.3.10の定義では各アプリ領域は2,031,616 bytesで、otadataとNVSもある。現在の約1.40MBのファームは収まる。OTA実装後にサイズを再確認する。この構成で書き込み済みなら、OTAのための領域変更は不要。

以前のCLIビルド確認用の `huge_app` は実機設定とは異なり、OTA非対応。今後OTAのビルド確認では `PartitionScheme=no_fs` を使用し、USBなどの設定も実機に合わせる。ArduinoのままOTAを実装する方針で、ESP-IDF移行は前提としない。

## 設定同期

- スマホから設定用Lambda経由でDynamoDBに設定を保存する。
- 本体はSoniox一時キー取得のレスポンスで、区切りの間隔などの本体設定も取得する方針。
- TTS区切りは現状400msの定数。可変化は今後の実装。設定にはリビジョンを持たせ、値の範囲を検証し、欠落時は前回値または初期値を使用する。
- 設定は会話開始前など安全な区切りで反映する。反映頻度はキー取得タイミングに依存し、スマホ操作直後の即時反映は保証しない。
- OTAによるプログラム更新と、設定値だけの変更を区別する。

### 音声割り込み・相槌の再起動なしON/OFF（2026-09-10、相談段階・未実装）

ユーザーから、音声割り込みをスマホ側でON/OFFできるか、再起動せず反映できるか、既存の相槌設定はどうなっているか、という相談があった。現状のコードを確認した結果は以下。

- スマホの [`app/app/(tabs)/toy.tsx`](../app/app/(tabs)/toy.tsx) にデバイス別の相槌スイッチがあり、設定用Lambdaの `PUT /devices/{device_id}` で `backchannel_enabled` をDynamoDBへ保存する。画面では「おもちゃの電源を入れ直してください」と案内している。
- [`toytalk-soniox-stt-lambda`](../backend/toytalk-soniox-stt-lambda/index.mjs) がSoniox一時キーとともに相槌設定を返す。v0.7の `startNormalOperation()` は起動時にこれを読み、`backchannelEnabled` に反映する。会話中の設定再取得はまだない。
- 音声割り込みは `AecBargeGate.h` の `AEC_BARGE_DETECT_ONLY=false` など、ファーム内の固定設定。スマホのスイッチ・保存APIの項目・本体への同期は未実装。

変更候補は、スマホのデバイス設定に「声で再生を止める」を追加し、相槌と合わせてサーバーへ保存、本体が設定を再取得して会話の合間に反映する構成。音声割り込みONなら声で停止、OFFなら声では停止せず、通常の録音・会話とボタン停止は利用できる動作を想定する。

最初に対応するアプリ・サーバー・ファームの変更が必要だが、導入後は設定切替のたびのファーム書き込み・本体再起動を不要にできる。取得した設定を次の会話・再生から反映する案であり、スマホ操作直後の即時反映を実現済みという意味ではない。

再取得のAPI・頻度・反映タイミング、OFF時にAEC演算も休止する範囲は未決定。設定取得が本文開始を待たせないこと、処理中のAEC/I2Sを不整合な状態で切り替えないこと、通信失敗時は前回値を保持することを設計時に確認する。ここで扱うのは設定値の同期で、保留中のOTA実装とは別の作業。

## 本体状態の送信

Wi-Fi接続後の初回通信で、温度・電池電圧・充電状態・ファームバージョンなどを送信する方針。起動後の変化も扱うため、定期送信や充電状態の変化時の送信を検討する。頻度・APIは未決定。スマホには最終更新時刻を表示する。

PCB資料: [PINMAP](../devices/KiCad/toytalker_mini_v0.2/PINMAP.md)、[部品表](../devices/KiCad/toytalker_mini_v0.2/PARTS_LIST.md)、[実機確認計画](../devices/KiCad/toytalker_mini_v0.2/PHASE4_5_PLAN.md)。

- VBAT: GPIO1、470kΩ×2の分圧。残量パーセントは直接測定値ではなく推定となるため、まず電圧と区別する。
- TH2: GPIO2のサーミスタ。ESP32内部温度とは別項目にする。資料には基板温度と電池上への配置指示があるため、測定対象の名称は実装位置を確認して確定する。
- STAT1/STAT2: GPIO13/14。状態の解釈は充電ICの仕様と実機で確認する。
- TH1: ハードウェアの充電温度保護用。ファームから直接読めるセンサーとして扱わない。

## OTA実装（2026-09-15実装、2026-09-16に実機で更新成功）

2026-09-14〜15の相談で合意し、ブランチ `esp32-ota` で実装した。2026-09-16に試験機で 0.7.1 → 0.7.2 の更新が通った（下の実測）。残る検証は中断・改ざん・ロールバック・更新後の会話。

### 確認済みの前提

- 実機の `no_fs` はapp0/app1が各2,031,616バイトでotadataもあり、OTAに使える。OTA込みのv0.7.1（NLP=AGGR）のビルドは1,491,778バイト（73%）で、OTA追加分は約15KB。
- Arduino ESP32 3.3.11は `CONFIG_APP_ROLLBACK_ENABLE=y`。ただしコアが起動時に自動で有効印を付けるため、スケッチで `verifyRollbackLater()` を `true` に上書きし（Cリンケージなので `extern "C"`）、健全性確認後に `esp_ota_mark_app_valid_cancel_rollback()` を呼ぶ。
- 起動時のSoniox一時キー取得（`toytalk-soniox-stt-lambda`、`device_id` 付き）が更新確認の置き場。追加の通信は要らない。
- 通信はすべて `setInsecure()`。OTAだけ証明書検証を入れる。S3 ap-northeast-1 の証明書はSANに `*.s3.ap-northeast-1.amazonaws.com` を含み、Amazon Root CA 1〜4で検証できることをopensslで確認した。
- `toytalker-devices` は16台で配布機が複数ある。配布機のパーティション・ブートローダー世代は未確認。
- Lambdaのロール `toytalk-lambda-role-dev` には `AmazonS3FullAccess` が付いており、IAMの追加は不要。

### 方式

- **確認するLambda**: `toytalk-soniox-stt-lambda` だけ。応答に `firmware: {version, url, sha256, size}` を同梱する。他のLambdaは関与しない。
- **配布**: 非公開S3バケット `toytalker-firmware`。`esp32s3/<version>/toytalker_mini.bin` と `esp32s3/manifest.json`（`versions` に版ごとの `{key, sha256, size, published_at}`、`channels` に `stable` / `beta` が指す版）。Lambdaが10分の署名付きURLを返す。本体はS3から直接GETし、Lambdaはバイナリを中継しない。本体に認証情報は持たせない。
- **配布制御**: `toytalker-devices.fw_channel`（既定 `stable`、試験機は `beta`）。個別固定用に `fw_target`（版名。空文字で解除）。昇格はマニフェストの書き換えだけ（`publish-firmware.sh stable --promote`）。
- **版の識別**: `FirmwareVersion.h` の `TOYTALKER_FW_VERSION` / `TOYTALKER_HW_VERSION`。`[BUILD]` と `[OTA]` の起動ログに出る。キー取得時に `fw` `hw` `ota` `part` を送り、Lambdaが登録済みの行にだけ `firmware_version` `hw_version` `ota_capable` `running_partition` `fw_reported_at` を保存する（未登録の `device_id` で行は作らない）。判定は「目標版と不一致なら更新」で大小比較はしない。
- **本体が偽ファームを受け取らないための検証**（署名付きURLは誰でもGETできる前提。読まれる実害は無いので許容し、守るのは本体側）:
  1. URLのホストを `toytalker-firmware.s3.ap-northeast-1.amazonaws.com` 固定で照合し、他は拒否。
  2. 更新用クライアントだけ Amazon Root CA 1〜4（`AmazonRootCA.h`、公開情報、約5KB）で証明書検証する。取得・発行・更新作業は不要。1枚だけだとルート切替時にOTA不能になるので4枚。
  3. 受信バイト列のSHA-256をLambdaの値と照合してから `Update.end()`（イメージヘッダ・チップ検査と起動パーティション切替）を呼ぶ。
  4. バイナリ署名（`UPDATE_SIGN`）は第2版以降。
- **タイミング**: 第1版は起動時のみ。録音・WebSocket・AECが動く前に終える。稼働中の定期確認は第2版。
- **失敗時**: ダウンロード・書き込み・SHA不一致・タイムアウト（応答15秒、無通信15秒、全体180秒）のどれでも `Update.abort()` して通常動作へ進む（再起動ループにしない）。同じ目標版への試行回数をNVS（namespace `ota`）に数えて3回で諦める。回数は開始前に記録するので、途中の電源断も1回に数える。ロールバックで旧版に戻った場合も同じカウンタで再更新ループを防ぐ。
- **ロールバック確認**: 新版がWi-Fi接続とSonioxキー取得に成功した時点で `ota::confirmRunningImage()` が有効印を付ける。それ以前にクラッシュすればブートローダーが旧版へ戻す。
- **OTA可否**: `esp_ota_get_next_update_partition()` がNULLなら `ota=0` を報告して更新しない（`huge_app` で書かれた機の保護）。
- **LED**: 更新中は60ms周期の速い点滅（`LED_BLINK_OTA`）。この間は電源を切らない。

### 実装した場所

- ファーム: [`toytalker_mini_v0.7`](../devices/mcu/esp32_s3/toytalker_mini_v0.7/) に追加。[`OtaUpdater.h`](../devices/mcu/esp32_s3/toytalker_mini_v0.7/OtaUpdater.h)（検証・ダウンロード・書き込み・有効印）、[`FirmwareVersion.h`](../devices/mcu/esp32_s3/toytalker_mini_v0.7/FirmwareVersion.h)、[`AmazonRootCA.h`](../devices/mcu/esp32_s3/toytalker_mini_v0.7/AmazonRootCA.h)、`sketch.yaml`（`default_fqbn`。IDE 2とarduino-cliが読む）。`AecMonitor.h` のNLP既定を実機構成のAGGRにした。`.ino` は `startNormalOperation()` のキー取得直後に有効印と更新適用を入れ、`verifyRollbackLater()` の上書きと `LED_BLINK_OTA` を追加。
- 発行: [`devices/mcu/esp32_s3/tools/publish-firmware.sh <beta|stable> [--dry-run] [--no-build] [--promote] [--force]`](../devices/mcu/esp32_s3/tools/publish-firmware.sh)。版は `FirmwareVersion.h` から読む。フォルダに未コミットの変更があると止まり（`--allow-dirty` で試験発行は可、タグなし）、発行に成功したコミットへタグ `fw-<版>` を付ける。同じ版のS3オブジェクト・タグは既定で上書きしない。偽の `aws` を使ったオフライン試験で、発行・重複拒否・昇格の3経路を確認済み。
- Lambda: `toytalk-soniox-stt-lambda` に判定と署名付きURL発行（`deploy.sh` の外部指定に `client-s3` と `s3-request-presigner` を追加。Node 22ランタイム同梱）。`toytalker-device-setting-lambda` の `PUT /devices/{id}` が `fw_channel` `fw_target` を受け付ける。Soniox・S3・DynamoDBをスタブにしたローカル試験で、stable/betaの振り分け、`fw_target` による戻し、更新不要、`ota=0`、未登録機、旧ファーム（`fw` なし）の互換を確認済み。

### 配布の手順

1. **1フォルダ + gitタグ。** `toytalker_mini_v0.7` には最新のソースだけを置く。`FirmwareVersion.h` の版を上げてコミットする（2026-09-16決定。版ごとにフォルダを残す方式は、OTAで版が増えることを見込んで採らなかった）。
   - 配布した版のソースへ戻す: `git checkout fw-<版> -- devices/mcu/esp32_s3/toytalker_mini_v0.7`（作業中の変更は先にコミットしておく）。
   - 並べて見たい: `git worktree add .claude/worktrees/fw-<版> fw-<版>`。
2. `bash devices/mcu/esp32_s3/tools/publish-firmware.sh beta` でビルド・S3配置・タグ付け。タグは `git push origin fw-<版>` で共有する。
3. 試験機（`fw_channel=beta`）の電源を入れ直し、`[OTA]` ログとDynamoDBの `firmware_version` を確認する。
4. `bash devices/mcu/esp32_s3/tools/publish-firmware.sh stable --promote` で全機へ。

### 実機検証

1. 済（2026-09-16）: 0.7.1 をUSBで書き込み。起動時の `[OTA] confirm: img_state=-1 (no action)` でUSB書き込み版は有効印の対象外と確認。
2. 済（2026-09-16 06:39）: 0.7.2（版の文字列だけ変更）を `beta` に発行し、試験機「v0.2 大スピーカー」（`fw_channel=beta`）の電源を入れ直し。実測:
   - Wi-Fi接続 5.0秒 → 鍵取得 → `[OTA] start: 0.7.1 -> 0.7.2 size=1491920 attempt=1/3`
   - TLS接続とヘッダー 614ms、ダウンロードと書き込み 16.9秒（約88KB/s、10%ごとに1.4〜2.0秒で一定）、`[OTA] done total_ms=17040`
   - 再起動後 `[BUILD] fw=0.7.2`、`running=app1 next=app0 img_state=1`（検証待ち）、Wi-Fi再接続 1.9秒、鍵取得後に `[OTA] confirm: pending_verify -> valid err=0`
   - DynamoDB `firmware_version=0.7.2 running_partition=app1 ota_capable=true`
   - 録音前の `ALLOC_FAIL total=0` / `HEAP_CHECK ok=1 internal_free=168728`。更新のある起動の遅れは約20秒（見込み15〜40秒の範囲内）
   - 署名付きURLは一時トークン込みで1,587文字（上限4,096）。S3からの取得はAmazon Root CA 1〜4だけで検証が通る（Macのcurlでも確認）
3. ダウンロード途中で電源断。旧版で起動し再試行することを確認。
4. SHA-256を壊したマニフェストで拒否されることを確認。
5. 有効印の前にわざとクラッシュする版で、旧版へ戻り試行カウンタでループが止まることを確認。
6. 更新後にWi-Fi設定（NVS）が残り、通常会話ができることを確認。

### 本番に入れたもの（2026-09-16）

- S3バケット `toytalker-firmware`（ap-northeast-1、パブリックアクセス全遮断、SSE-S3、バージョニング有効、タグ project=toytalker / purpose=esp32-firmware-ota）。
- Soniox Lambda と デバイス設定 Lambda はCDKスタック `ToyTalker-rnd` 経由で反映（タイムアウト5秒、devices書き込み権限、`toytalker-firmware` 読み取り権限、環境変数 `FIRMWARE_BUCKET`）。**この2本は2026-09-15にCDK管理へ移っており、`deploy.sh` で触るとドリフトになる。** 反映は `cd infra && npx cdk deploy --context stage=rnd`（[複数アカウント計画](multi-account-iac-plan.md)）。
- 発行済み: 0.7.1（beta→試験機へUSB書き込み）、0.7.2（beta、OTAで試験機へ）。`stable` は未設定なので、beta以外の機には更新提案が出ない。配布機へ広げるときは `publish-firmware.sh stable --promote`。

### 見込みと制約

- 所要時間の実測は上の「実機検証」2。自宅Wi-Fiで約17秒（1.49MB）。更新の無い起動は変わらない。
- 配布済みの実機は現行ファームにOTAコードが無いので、初回だけUSB書き込みが必要。
- 本文Lambda・Soniox WSの `setInsecure()` は今回触らない。
- 署名付きURLはLambdaの一時認証情報を含むため2KB前後になる。本体のJSON読み取りはArduinoJson 7で容量制限が無く、URL長の上限は4096にしている。
