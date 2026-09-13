# 月次運用レポートLambda（為替更新・請求突き合わせ・単価点検）

2026-09-12に `toytalker-ops-monthly-lambda` を追加。毎月1日 09:00 JST に動き、結果を1通のメールで送る。値の自動修正はしない。

## やること

1. **為替**: Frankfurter（ECB公表レート、キー不要）からUSD→JPYを取り、`toytalker-exchange-rates` に当月の行が無ければ作る。既存行は維持（`FX_OVERWRITE=true` で上書き）。
2. **先月の記録集計**: `toytalker-usage` を先月分でスキャンし、プロバイダー×種別ごとにマージン後の円額・マージン前のUSD実費・使用量をまとめる。
3. **各社の実績との突き合わせ**: APIで請求を取れる社（OpenAI・Anthropic）は差分と割合を出し、20%超なら要確認印。ElevenLabsは使用文字数。取れない社（Cartesia・Serper・Google・Soniox・Sakura・FishAudio）は記録実費と確認先URLを並べる。
4. **点検**: 単価行が無くて記録されなかった呼び出し（記録側Lambdaの `[Pricing] missing price` ログをCloudWatchから検索）、180日以上更新されていない単価行、対象月の為替行の有無。
5. **通知**: SNSトピック `toytalker-ops-monthly` にメール。件名はASCII固定（`ToyTalker monthly cost report YYYY-MM`）。

## 記録側の変更（同日）

- App本文・ESP32本文・読み上げの3 Lambdaで、`toytalker-usage` に `cost_usd`（マージン前のUSD実費）を加算するようにした。突き合わせはこの値で行う。2026-09-12より前の行は `cost_jpy / margin / usd_jpy_rate` で割り戻すため概算になる（レポートに行数を表示）。
- 単価行が無いときに `console.warn("[Pricing] missing price for <provider#api_type>")` を出すようにした。以前は静かに記録されなかった。

## 構築と運用

- ディレクトリ: `backend/toytalker-ops-monthly-lambda/`
- 初回構築: `bash setup.sh <メールアドレス>`。SNSトピックとメール購読、実行ロール `toytalker-ops-monthly-role`、Lambda（Node.js 24、5分、256MB）、EventBridge Scheduler `toytalker-ops-monthly`（`cron(0 9 1 * ? *)`、Asia/Tokyo）を作る。再実行しても更新扱いで壊れない。購読はメール内のリンクで確認が必要。
- コード更新: `bash deploy.sh`（他のLambdaと同じ）。
- 手動実行: `{"month":"2026-08","send":false}` のように対象月と送信有無を指定できる。`send:false` は戻り値の `report` にレポート本文を返すだけでメールを送らない。`fx:false` で為替更新を省略。
- 環境変数:

| 変数 | 内容 |
|---|---|
| `OPS_SNS_TOPIC_ARN` | 必須。setup.sh が設定 |
| `FX_OVERWRITE` | `true` で当月の為替行を毎回上書き。既定は無い月だけ作成 |
| `STALE_PRICE_DAYS` | 単価行の鮮度しきい値。既定180 |
| `OPENAI_ADMIN_KEY` | 任意。OpenAIの組織コストAPI（管理者キーが必要） |
| `ANTHROPIC_ADMIN_KEY` | 任意。Anthropicの管理APIキー（`sk-ant-admin...`） |
| `ELEVENLABS_API_KEY` | 任意。使用文字数の取得。本文Lambdaと同じ値を設定済みだが、そのキーは `user_read` 権限が無く401になる。ElevenLabsで `user_read` 付きのキーを作って差し替えると取得できる |

## 2026-09-12 の確認

- `{"month":"2026-08","send":false}` で実行し、8月分（利用者8人、合計81.77円、実費$0.27）のレポートを生成できた。2026-09の為替行は154.04円（Frankfurter 2026-09-11）。
- OpenAI・Anthropicの実績取得はキー未設定のため未検証。キーを設定したら翌月のメールで確認する。
- 8月以前は為替行が無く150円固定で記録されている。レポートにその旨を表示する。

## 見直しの目安

- 差分が20%を超えて印が付いたら、まず単価行の単位・値を疑う（トークン種別の違い、キャッシュ料金、音声トークン換算など）。
- 「単価行なしの警告」が出たら `toytalker-api-unit-prices` に行を足す。足すまでその呼び出しは記録されない。
- 単価の自動取得はしない。各社がAPIで単価を公開しておらず、料金ページの読み取りは壊れやすいため。
