# MacBookでの開発 引き継ぎ（2026-09-13作成）

来週の大阪出張でMacBookから開発するための引き継ぎ。Mac側でClaude Codeを新規セッションで起動し、最初に「docs/handoff-macbook-2026-09.md を読んで」と伝える。Windows PC側のClaude Codeセッションは別マシンへ移せないので、状況はこのファイルとCLAUDE.mdで渡す。

方針: 開発は基本Macのローカルセッションで行う。自宅Windows PC（TTSサーバー）の面倒を見るときだけRemote Controlを使う。

## 1. 出発前にWindows側でやること

| # | 項目 | 状態 |
|---|---|---|
| 1 | 未コミット変更のコミットとpush | 済（2026-09-13 19:40） |
| 2 | stash 2本の整理 | 済（2026-09-13、確認のうえ削除） |
| 3 | `backend/*/deploy.sh` のMac対応、各Lambdaの `npm install`、ESP32シリアル受信 | 済（2026-09-13、Mac側で対応） |
| 4 | 自宅PCへの遠隔手段（Remote Control、Tailscale等） | 済（Tailscale + Sunshine/Moonlight、2026-09-13 Macから接続確認） |
| 5 | ESP32実機・USBケーブル・スマホ（実機アプリ）の持参 | 未（出発時に確認） |
| 6 | 出発直前にWindows Updateを手動確認し、更新と再起動をその場で済ませる | 未 |

### 1-1. コミット・push・stash（2026-09-13 19:40 時点で完了）

- 2026-09-13の作業はすべてコミット・push済み。ローカル・リモートとも `main` のみで、worktree・stash・未コミット変更は無い。Macでは `git pull` するだけでよい。
- 古いstash 2件（設定ファイルの差分と、ESP32音声修正の中断分）は中身を確認のうえ削除済み。

### 1-3. deploy.sh のMac対応（済）

2026-09-13にMac側で対応した。8本の `backend/*/deploy.sh` と `toytalker-ops-monthly-lambda/setup.sh` を、同じファイルのままWindows（Git Bash）とMacの両方で動くようにした。

- `"/c/Program Files/nodejs/npx.cmd"` / `npm.cmd` の絶対パスをやめ、PATHの `npx` / `npm` を使う。
- zip作成は `zip` コマンドがあればそれを使い（Mac / Linux）、無ければ従来の `powershell Compress-Archive`（Windows Git Bash）に分岐する。
- `set -euo pipefail` が無かった3本（soniox-stt、device-setting、tts-only）に追加した。無いとバンドル失敗時に古いzipをそのままデプロイしてしまう（Macの試験で実際に起きかけた）。

動作確認は本番へデプロイせずに行った。`aws lambda update-function-code` だけ握りつぶす偽の `aws` をPATHの先頭に置いて8本を最後まで実行し、できた `deploy.zip` の中身を `aws lambda get-function` で取得した本番コードと比較して、8本すべて一致を確認した。Macで初めて動かすLambdaは先に各ディレクトリで `npm install` が要る（`openai` 等の依存が無いとesbuildが失敗する）。

### 1-4. 自宅PCの遠隔手段（2026-09-13 21:50 時点で確認済み）

TTSサーバー（RTX 5090）は持ち出せない。自動復帰の仕組みに加えて、止まったときに手を入れる手段を以下で用意した。

- **Tailscale**: 自宅PC（`desktop-ojpa2dh`、100.125.70.89）・MacBook・iPhoneの3台が同じアカウントで接続済み。サービスは自動起動。
- **Sunshine + Moonlight（画面共有）**: Windows側は `SunshineService`（自動起動）が稼働し、47984/47989/47990/48010をLISTEN。ファイアウォール規則「Sunshine」でTCP/UDP受信を全プロファイル許可済み。MacのMoonlightには `DESKTOP-OJPA2DH` がペアリング済みで、手動アドレス 100.125.70.89 も登録済み。2026-09-13にMacをiPhoneテザリング（LAN外）にした状態でTailscale経由の接続試験に成功（1920x1080 HEVC、遅延約41ms、コマ落ち0%、リレーなしの直接接続、PIN入力不要）。昇格が必要な操作（`switch-api.ps1`、`cloudflared` サービス再起動、Windows Update）はこれで行う。
- **Claude Code Remote Control**: Windows側で `claude --remote-control` を起動したままにすると、Macのブラウザ（claude.ai/code）やスマホアプリからこのPC上のセッションを操作できる。PC再起動で消えるので、消えたらMoonlightから起動し直す。
- **セッション間メッセージ**: MacのClaude Codeセッションから自宅PCのセッションへメッセージを送れることを確認した（2026-09-13）。相手側の権限内の確認作業を頼む用途。
- 使えないもの: Windows 11 Homeはリモートデスクトップのホストになれない（`fDenyTSConnections=1` のままでよい）。OpenSSHサーバーは未導入。
- 復旧手順は [起動・復旧](tts-boot-recovery.md)。Windows更新の再起動はアクティブ時間07:00〜翌01:00の外で起きる（[設定記録](windows-update-restart-control.md)）。再起動後にTTSが自動復帰することは2026-09-13 17:48の再起動試験で確認済み。

### 1-5. 出発前に確認した自宅PCの状態（2026-09-13 21:50）

- 電源設定: AC時のスリープ・休止はともに「なし」。
- `TTS-AutoStart` は稼働中。直近の起動ログに「public health and Lambda URLs verified」。`cloudflared` サービスは自動起動で稼働中。Lambdaの `ZAKICORP_TTS_URL` は `https://tts.zakicorp.com`。
- Windows Updateの再起動待ちは無し。出発直前に手動で更新確認し、溜まった更新と再起動をその場で済ませる（留守中の自動再起動を減らす）。
- TTSサーバーが完全に落ちた場合、Cloudflareが5xxを返せばフォールバックでずんだもんへ切り替わる。応答が遅いだけの状態は切り替わらない（遅延条件は未実装、5節の4）。長引くときは `toytalker-voices` でZakiCorpボイスをCartesiaへ差し替える（Macから可能）。

## 2. Macのセットアップ

```bash
# Homebrew前提
brew install git node@22 awscli arduino-cli
npm install -g @anthropic-ai/claude-code
git clone https://github.com/tomonoriyamazaki/toytalker.git
cd toytalker
aws configure   # Windowsと同じIAMキー、region=ap-northeast-1、output=json
```

- Node はWindows側が v22.19.0。同じメジャーにする。
- ESP32ファームを触るなら:

```bash
arduino-cli config init
arduino-cli config add board_manager.additional_urls https://espressif.github.io/arduino-esp32/package_esp32_index.json
arduino-cli core update-index
arduino-cli core install esp32:esp32@3.3.11
```

  CLAUDE.mdのcompileコマンドは `--build-path` を `/tmp/toytalker_v07_build` などに変えればそのまま使える。書き込み時のポートは `/dev/cu.usbmodem*`（`arduino-cli board list` で確認）。NLP=AGGRの `--build-property` も同じ。
- アプリ（Expo 53 / RN 0.79）: `cd app && npm install && npx expo start`。iOSシミュレータを使うならXcodeを入れる。EAS Buildはクラウドなのでどちらのマシンからでも同じ。
- Lambdaは各ディレクトリで `npm install`（`node_modules` がないLambdaは `npx esbuild` が都度取得する）。
- 秘密情報: リポジトリ内に `.env` は無い。Lambdaの環境変数はAWS側。Macに持ち込むのはAWSのキーだけ。ZakiCorpのAPIキーはTTSサーバーを触るときだけ必要で、サーバー側 `tts-models/faster-qwen3-tts/scripts/.env` にある。
- `.claude/settings.local.json` はGit対象外でマシン固有。Macでは最初は許可プロンプトが多いので、Mac側で改めて育てる。

## 3. Macで違うこと・触らないもの

- CLAUDE.mdの「PowerShellでgitを実行するときSet-Locationを使わない」「スクリーンショットの保存先」はWindows固有。Macでは該当なし。
- Macのスクリーンショット保存先は `~/Pictures/Screenshots`（2026-09-14に `defaults write com.apple.screencapture location` で設定）。「スクショ撮ったから見て」ではここを新しい順に見る。フォルダが空なら、クリップボードにコピーするモードで撮っている可能性が高い（設定の不具合ではない）。
- `tools/tts-service/`（supervisor.py, install.ps1, switch-api.ps1, cloudflared-service-fix.ps1）はWindows PC上でしか意味がない。Macから編集してもよいが、反映はWindows PCで昇格実行が必要。
- ESP32のシリアルログは `.local/serial-logs/`（Git対象外）にWindows側だけある。Macでは `.local/serial/capture.sh`（2026-09-13作成、Git対象外）が `/dev/cu.usbmodem*` を921600bpsで読み続けて `.local/serial/esp32.log` へ追記する。書き込みでポートが消えても再接続する。起動は `nohup .local/serial/capture.sh &`、閲覧は `tail -f .local/serial/esp32.log`。Arduino IDEのシリアルモニタとは同時に開けない。実機受信は2026-09-13にMacで確認済み。
- Macの `npm install` はpackage-lock.jsonを書き換える（Node v25 / Windowsはv22）。Lambdaはesbuildで束ねるので影響はないが、lockの差分はコミットしない。8本のうち依存があるLambda 6本は2026-09-13に `npm install` 済み。
- 2台で作業するので、切り替えのたびにpush/pullする。デプロイ前に `git log origin/main..HEAD` と `git status` で本番に出す版を確認する（CLAUDE.mdのworktree確認ルールと同じ趣旨）。

## 4. 出発時点の本番の状態（2026-09-13）

- ESP32実機: `toytalker_v07_serial_nowait`（2026-09-12夜書き込み）。詳細はCLAUDE.md「ESP32-S3ファーム開発」。
- ZakiCorp TTS: バッチ推論エンジン第2版、公開はCloudflare Tunnel `https://tts.zakicorp.com`、ngrokは予備。
- Lambda 5本の `ZAKICORP_TTS_URL` は上記固定URL。監視タスク `TTS-AutoStart` が維持する。
- Cartesia TTS: 本文・相槌・読み上げの5 Lambdaで利用可能（Proプラン）。アプリからのクローンボイス作成はデバイス設定Lambda（`POST /custom-voices` provider=Cartesia、タイムアウト60秒）。ボイス一覧の並びは `toytalker-voices.sort_order` でサーバー制御。[Cartesia TTS導入](cartesia-tts.md)。
- TTSフォールバック: 主プロバイダーが429/5xx等で失敗したら再試行→ずんだもん（返答単位で固定、Sakura分は別行で記録）。5 Lambdaに導入済み。[仕様と実測](tts-fallback-and-notifications.md)。Proでも同時64件まで429は出ず、96件で27件が切り替わることを実測済み。
- アプリ: 0.8.6 (24) をTestFlightへ送信済み。内部グループのみで、外部グループ「tester」への追加は未実施（追加すると新バージョンのBeta審査が入る）。開発ビルド（development、24）も端末に入っている。
- コスト: `service#margin` は2.0。単価表の全行に `provider` / `api_type` 列あり。`cartesia#tts` は$0.00005/字（Pro）、`serper#tool` は$0.001/回。為替2026-09は154.04円（ECB）。月次運用レポートLambdaは毎月1日にメール（10/1が初回本番）。
- Cartesiaへの問い合わせ（同時接続・組織・クローンの扱い）は2026-09-13に回答済み。要点は [フォールバック仕様の背景](tts-fallback-and-notifications.md)。

## 5. 残タスク（出張中に着手できるもの）

- CLAUDE.md「未確認」に挙がっている項目のうち、実機とスマホがあればできるもの: スマホからのZakiCorp会話確認、長文分割境界の聞こえ方、stream終端の切断・救済経路の再現。
- Cloudflare側の未実施: Accessのサービストークン、公開 `/health` の話者一覧非表示、話者登録名の検証。これはCloudflareダッシュボードとLambda側の作業なのでMacからできる。ただしTTSサーバー側の変更が要るものはWindows PCが必要。
- 先送り項目は [deferred-items.md](deferred-items.md)。
- 2026-09-13夜時点で次に手を付ける順番（合意済み、いずれも未実装）:
  1. 認証（Cognito: Apple・Google・LINE）。設計は [deferred-items.md](deferred-items.md) の「ユーザー認証」。
  2. 前払いポイント制（ウォレット・消費記録・Web購入ページ Stripe Checkout・プッシュ通知）。仕様は [原価と課金の考え方](pricing-and-cost-model.md) 第11節。購入ページは認証の後。
  3. 単価のモデル単位化（`provider#api_type#model` → `provider#api_type` の順で引く）と、利用状況の行をプロバイダーごとに分ける変更（同じ日に同じ端末で2プロバイダーを使うと `provider` が上書きされる既存の制約）。
  4. フォールバックの遅延条件（主プロバイダーの応答3秒超で切り替え）と、月次レポートへの「ピーク同時本数」「切り替え回数」の追加。
  5. Fish Audio (demo) のボイス16件は版権声のため、いずれ削除（使用中キャラクターの確認が先）。
