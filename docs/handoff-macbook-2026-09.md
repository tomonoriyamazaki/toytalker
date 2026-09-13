# MacBookでの開発 引き継ぎ（2026-09-13作成）

来週の大阪出張でMacBookから開発するための引き継ぎ。Mac側でClaude Codeを新規セッションで起動し、最初に「docs/handoff-macbook-2026-09.md を読んで」と伝える。Windows PC側のClaude Codeセッションは別マシンへ移せないので、状況はこのファイルとCLAUDE.mdで渡す。

方針: 開発は基本Macのローカルセッションで行う。自宅Windows PC（TTSサーバー）の面倒を見るときだけRemote Controlを使う。

## 1. 出発前にWindows側でやること

| # | 項目 | 状態 |
|---|---|---|
| 1 | 未コミット変更のコミットとpush | 未 |
| 2 | stash 2本の整理 | 未 |
| 3 | `backend/*/deploy.sh` のMac対応 | 未 |
| 4 | 自宅PCへの遠隔手段（Remote Control、Tailscale等） | 未 |
| 5 | ESP32実機・USBケーブル・スマホ（実機アプリ）の持参 | 未 |

### 1-1. 未コミット変更（2026-09-13 16:02のコミット `aaaabd1` 以降）

内容は2件。どちらも本番反映は済んでいて、リポジトリへの記録だけが残っている。

- **ZakiCorp TTSの公開経路をngrokからCloudflare Tunnel（`https://tts.zakicorp.com`）へ切替**した記録。`CLAUDE.md`、`docs/tts-boot-recovery.md`、`tools/tts-service/supervisor.py`（`public_url` 対応、User-Agent変更）、`tools/tts-service/switch-api.ps1`（`-PublicUrl`）、新規 `tools/tts-service/cloudflared-service-fix.ps1`。
- **Qwen3-TTS調査メモの統合**。`docs/qwen3-tts-*-2026-09-12.md` の個別メモ8本を削除し、`qwen3-tts-batch-engine-2026-09-12.md` / `qwen3-tts-capacity-2026-09-12.md` / `qwen3-tts-concurrency-test-plan.md` / `qwen3-tts-current-status.md` へ要点を移した。

pushしないとMacから見えない。コミットは2つに分けてよい。

### 1-2. stash

- `stash@{0}` "Temporary stash for settings": `.claude/settings.local.json` の差分のみ（Git対象外ファイル）。不要なら捨てる。
- `stash@{1}` "WIP on fix/esp32-audio-chunk-playback": 古いESP32音声修正の作業中断分。現行v0.7とは無関係の可能性が高い。中身を見て捨てるか判断する。

### 1-3. deploy.sh のMac対応

8本すべての `backend/*/deploy.sh` が次の2箇所でWindows専用になっている。

- `"/c/Program Files/nodejs/npx.cmd" esbuild ...` → `npx esbuild ...` にする（Git BashでもMacでも動く）。
- `powershell -Command "Compress-Archive ..."` → `zip -j ../deploy.zip index.mjs` などにする。

`toytalker-ops-monthly-lambda` は `setup.sh` もある。修正後の動作確認は本番Lambdaへのデプロイになるので、CLAUDE.mdのルール通りOKを取ってから実行する。デプロイ元はmain。

### 1-4. 自宅PCの遠隔手段

TTSサーバー（RTX 5090）は持ち出せない。自動復帰の仕組みはあるが、止まったときに手を入れる手段が今はない。

- **Claude Code Remote Control**: Windows側で `claude --remote-control` を起動したままにすると、Macのブラウザ（claude.ai/code）やスマホアプリからこのPC上のセッションを操作できる。実行はWindows PC上。TTSサーバー復旧、`.local/tts-service/logs/` の確認向き。
- **Tailscale + リモートデスクトップ**: 昇格が必要な操作（`switch-api.ps1`、`cloudflared` サービス）向け。導入するなら出発前に接続確認まで済ませる。
- 復旧手順は [起動・復旧](tts-boot-recovery.md)。Windows更新の再起動はアクティブ時間07:00〜翌01:00の外で起きる（[設定記録](windows-update-restart-control.md)）。

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
- `tools/tts-service/`（supervisor.py, install.ps1, switch-api.ps1, cloudflared-service-fix.ps1）はWindows PC上でしか意味がない。Macから編集してもよいが、反映はWindows PCで昇格実行が必要。
- ESP32のシリアルログは `.local/serial-logs/`（Git対象外）にWindows側だけある。Macで取る場合は別途保存する。
- 2台で作業するので、切り替えのたびにpush/pullする。デプロイ前に `git log origin/main..HEAD` と `git status` で本番に出す版を確認する（CLAUDE.mdのworktree確認ルールと同じ趣旨）。

## 4. 出発時点の本番の状態（2026-09-13）

- ESP32実機: `toytalker_v07_serial_nowait`（2026-09-12夜書き込み）。詳細はCLAUDE.md「ESP32-S3ファーム開発」。
- ZakiCorp TTS: バッチ推論エンジン第2版、公開はCloudflare Tunnel `https://tts.zakicorp.com`、ngrokは予備。
- Lambda 5本の `ZAKICORP_TTS_URL` は上記固定URL。監視タスク `TTS-AutoStart` が維持する。

## 5. 残タスク（出張中に着手できるもの）

- CLAUDE.md「未確認」に挙がっている項目のうち、実機とスマホがあればできるもの: スマホからのZakiCorp会話確認、長文分割境界の聞こえ方、stream終端の切断・救済経路の再現。
- Cloudflare側の未実施: Accessのサービストークン、公開 `/health` の話者一覧非表示、話者登録名の検証。これはCloudflareダッシュボードとLambda側の作業なのでMacからできる。ただしTTSサーバー側の変更が要るものはWindows PCが必要。
- 先送り項目は [deferred-items.md](deferred-items.md)。
