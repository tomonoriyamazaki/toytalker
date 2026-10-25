# ZakiCorp TTS（クローンボイス, β版）: 現在の状態と入口

ローカルPC（RTX 5090）でQwen3-TTSベースのクローンボイスAPIサーバーを稼働させ、Cloudflare Tunnelで `https://tts.zakicorp.com` として公開し、Lambdaから使っている。この文書は「今どの版がどの構成で動いていて、何がどこにあるか」の入口。手順は [起動・復旧](tts-boot-recovery.md)、設計と計測は [バッチエンジン](qwen3-tts-batch-engine-2026-09-12.md)、経緯は [調査の経緯](qwen3-tts-current-status.md)。状態が変わったらこの文書を上書きする。

## 現在の状態（2026-09-13時点）

- **本番はバッチ推論エンジン第2版**（2026-09-13 12:06反映）。`tts-models/faster-qwen3-tts/api_server_batch.py` + `batch_engine.py`。要求ごとに独立したKV行を持つ。本番は `scripts/.env` の `TTS_BATCH_CLASSES=1,2,4,8,16` で同時16件構成（VRAM約11GiB、他のGPU用途と同居するため。2026-09-13夜に32件構成・約19GiBから変更）、`TTS_CONTEXT_FRAMES=12` で波形復号の左文脈12フレーム（同日19:02反映。聴取で25と区別なし、32件時の復号が約半分）。17件目以降は待ち行列。32件構成へ戻すには `.env` の行を消して再起動。元の `api_server.py` は無変更で残す。
- 切替は `tools/tts-service/switch-api.ps1 -ApiScript <script> [-PublicUrl <url>]` を昇格実行（`.local/tts-service/config.json` の `api_script`/`public_url` を設定し監視タスク再起動、APIは約40秒停止）。復旧は `-ApiScript api_server.py`。公開URLは固定なのでLambdaの再設定は不要。
- ユーザー確認済み（2026-09-13）: アプリでの会話、Cloudflare経由と合言葉遮断後の会話、クローンボイス登録、PC再起動後の自動復帰。未確認: 長文分割境界の聞こえ方。
- 単独要求の元実装は `StaticCache` が1つで同時要求が互いのKV文脈を上書きする構造があった（言葉の繰り返し・抜けの原因）。バッチ版で解消。
- 単価 `zakicorp#tts` は暫定（$0.000025/文字、Cartesiaの半額、2026-09-13登録）。正式な単価は未決定。
- 未反映: `supervisor.py` の `ZAKICORP_TTS_URL` 同期停止はコード修正済みで、このPCの `.local/tts-service/` への再登録が未実施（[ロードマップ](roadmap.md) の9）。
- 待ち行列の可視化は検討のみ（[先送り項目](deferred-items.md)）。Cartesia 429時のずんだもんフォールバックは別件（[TTSフォールバック](tts-fallback-and-notifications.md)）。

## 公開経路（2026-09-13にCloudflare Tunnelへ切替）

- 公開URLは固定の **`https://tts.zakicorp.com`**。Cloudflare Tunnel `toytalker-tts`（ID `8bc0e7f0-…`、locally-managed）を Windowsサービス `cloudflared`（自動起動）が張る。東京拠点、無料プラン、転送量課金なし。
- `zakicorp.com` のDNSはRoute 53からCloudflare（無料）へ移行済み。`toytalk.zakicorp.com`（S3+CloudFrontのサイト）とACM検証用CNAMEもCloudflare側に置いた（どちらもDNS only）。登録先はお名前.com、期限は自動更新。Route 53の `zakicorp.com` ホストゾーンは削除済み（`zackey.xyz` は残る）。
- 監視タスクは `config.json` の `public_url` にこのURLを持ち、`/health` を確認する。Lambda 6本の `ZAKICORP_TTS_URL` の正本は `infra/config/stages.ts` の `zakicorpTtsUrl`（CDKがdeployのたびに配る）で、監視タスクは照合して違えば警告するだけで書き換えない。URLを変えるときは両方を直す。Cloudflareは `Python-urllib` のUser-Agentを403で弾くため、監視は `toytalker-supervisor/1.0` を名乗る。
- 拠点での遮断: WAFカスタムルール `tts-edge-key-required` が `X-Zakicorp-Edge-Key` ヘッダー（Lambda側はSSM `/toytalker/zakicorp-edge-key`、サーバー側 `.env` にも同値）の無い要求を403で落とす。期限なし。公開側 `/health` は `status` のみ、話者登録名は英数字と `-_` に限定。詳細と鍵の入れ替え手順は [起動・復旧](tts-boot-recovery.md) の「公開経路」節。
- ngrokは2026-09-13 18:02に撤去（`public_url` 設定中は監視タスクが起動しない。`switch-api.ps1 -PublicUrl ''` で復活）。`cloudflared service install` は `--config` を保存しないので `tools/tts-service/cloudflared-service-fix.ps1` でImagePathに明示する。

## 起動・監視

- タスクスケジューラ `TTS-AutoStart` がOS起動30秒後に非対話実行（S4U、通常権限、ログオン不要）。APIサーバー（と `public_url` 未設定時はngrok）を監視し、終了後に再起動。`public_url` が設定されていればLambda環境変数 `ZAKICORP_TTS_URL` を照合するだけで、無ければngrokのURLを6本へ書き込む（次の `cdk deploy` で戻る）。
- 実装・登録: `tools/tts-service/supervisor.py` / `install.ps1`。実際の配置は `.local/tts-service/`（Git対象外）、ログは `.local/tts-service/logs/`。再適用は保守時間にタスクを停止してから登録する。
- 元のTTSリポジトリの `setup-tasks.ps1` を実行するとログオン起動に戻る。手順は [起動・復旧](tts-boot-recovery.md)。
- Windows更新は自動更新を受け入れ、アクティブ時間07:00〜翌01:00。[設定記録](windows-update-restart-control.md)。

`ZAKICORP_TTS_URL` の照合対象（`public_url` 未設定時はngrok URL変更のたびに書き込み）:

1. `toytalk-stream-handler-lambda`（app TTS）
2. `toytalk-api-stream-for-esp32-lambda`（ESP32 TTS）
3. `toytalker-backchannel-for-app-lambda`（app 相槌）
4. `toytalker-backchannel-for-esp32-lambda`（ESP32 相槌）
5. `toytalker-tts-only-lambda`（app 読み上げ）
6. `toytalker-device-setting-lambda`（クローンボイス登録 `/v1/speakers/register`。2026-09-13まで同期対象から漏れていた）

## S3 / DynamoDB / 認証

- APIキー `ZAKICORP_API_KEY` は `C:\Users\exodj\projects\tts-models\faster-qwen3-tts\scripts\.env`（サーバー側）とSSM `/toytalker/zakicorp-api-key`（Lambda側）にある。リポジトリには書かない。
- S3バケット `toytalker-tts-speakers` — speaker embedding (.pt) のバックアップ
- `toytalker-voices` のZakiCorpエントリ: provider=ZakiCorp, voice_id=zakicorp-{name}, vendor_id={name}

## 調査メモ

- [バッチエンジンの実装と検証](qwen3-tts-batch-engine-2026-09-12.md) — 現行本番版。最初に読む。設計の根拠になった事前計測（見込み計測・CUDAトレース・改善候補比較）もここ
- [調査の経緯](qwen3-tts-current-status.md) — 元実装の問題発見から本番反映までの時系列、元実装の分析と却下した案
- [元実装の1〜32件測定](qwen3-tts-capacity-2026-09-12.md) — バッチ版の改善幅の比較対象
- [計測方法と用語の定義](qwen3-tts-concurrency-test-plan.md) — TTFA・生成倍率・模擬再生枯渇の定義。未実施の試験一覧
- [起動・復旧](tts-boot-recovery.md) — 監視タスク、公開経路、合言葉、API版の切替、手動復旧、ngrokへの戻し方
