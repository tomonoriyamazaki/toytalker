# 複数アカウント展開とIaC化の計画（2026-09-15決定）

今のAWSアカウントをRnDにし、STG → 自分用本番 → DG（西川さん）向け本番へ展開するための計画。道具はAWS CDK（TypeScript）。着手したら本文の「進め方」を進捗に合わせて上書きし、決定の根拠はこの文書に残す。

## 決定事項

| 項目 | 決定 | 根拠 |
|---|---|---|
| IaCの道具 | AWS CDK（TypeScript） | Lambda 8本がNode.js ESM + esbuildで、`NodejsFunction` がdeploy.shを丸ごと置き換える。ストリーミングFunction URLは `invokeMode: RESPONSE_STREAM` の1行。アプリもTS系で言語が増えない |
| CloudFormation | CDKの裏で使い続ける | CDKはTSをCloudFormationテンプレートに変換して流す。YAMLは書かない。マネコンのCloudFormation画面はスタックの閲覧・ロールバック用に使う |
| 今のアカウント | 手作業のままRnDとして残す | ToyTalker以外の資源も載っている。`cdk import` は設定値を読み取らずコードは手書きになるので、既存資源の取り込みはしない |
| 環境 | RnD（現行）→ STG → 自分用本番 → DG向け本番 | Organizationsで分け、ログインはIAM Identity Center。アカウントごとのアクセスキーは作らない |
| デプロイ経路 | 当面ローカルから `cdk deploy --profile <env>` | GitHub Actions + OIDCは本番が2つになってから |
| Lambda起動の高速化 | 今はやらない | 温め設計が効いている（下記） |
| Terraform | 見送り | AWS単独ならCDKの方が学ぶことが少ない。Cloudflare側（DNS・WAF・Tunnel）もコード化したくなったら再検討 |

## 現状の棚卸し（2026-09-15、RnDアカウント）

CDKで再現する対象。

- Lambda 8本（Node 22と24が混在、x86_64）。メイン2本は2048MB、相槌1024MB、デバイス設定256MB
- Lambda Function URL 5本（ストリーミング）、API Gateway 1本
- DynamoDB 8テーブル、S3 `toytalker-tts-speakers`、SNS `toytalker-ops-monthly`、EventBridge Scheduler `toytalker-ops-monthly`
- EventBridgeルール `toytalker-lambda-warmer`（5分ごと、メイン2本・相槌2本・Soniox鍵発行の5本へ `{"warmup":true}`）
- 各Lambdaの実行ロール。環境変数はLambda全体で22種類、APIキー類がここに直接入っている
- Function URLのホスト名がアプリとESP32ファームにハードコードされている
- ZakiCorp TTSの監視タスク（`tools/tts-service/supervisor.py`）がLambda 6本の `ZAKICORP_TTS_URL` を関数名指定で同期している

## 進め方

1. **CDKの骨組みを書く**（worktreeで）。上の棚卸し全部。ランタイムはNode 24で統一。温めルールと、実リクエスト中に自分へpingを投げる予備インスタンス温めはそのまま持ち込む。
2. **Lambdaコードから固定名を外す。** テーブル名や相手Lambda名が `toytalker-*` で焼き込まれているので環境変数経由にする。
3. **秘密情報の置き場。** APIキー類はアカウントごとのSSM Parameter Storeへ。CDKは参照だけ持つ。
4. **マスターデータの投入スクリプト。** characters・voices・llms・api-unit-prices の4テーブルをRnDから書き出してSTGへ入れる。
5. **STGアカウントを作って `cdk bootstrap` → `cdk deploy`。** アプリとESP32の接続先をSTGへ向けて実機確認。
6. **エンドポイントの固定名化。** Function URLはアカウントごとにホスト名が変わるので、CloudFrontを前段に置いて `api-stg.zakicorp.com` のような固定名にする（ストリーミングはCloudFront経由でも通る）。ESP32とアプリへの焼き込み方をここで整理。
7. **ZakiCorp TTSのURL同期を止める。** 公開URLが `https://tts.zakicorp.com` で固定になったので、CDKの設定値に移す。
8. STGで一通り動いたら、同じスタックを自分用本番、DG向け本番の順に出す。
9. 本番が2つになったらGitHub Actions + OIDC（アカウントごとにOIDC用ロール1つ。権限はCDKのロール群を借りるだけ。これもCDKで書く）。
10. 最後にRnDもCDKで作り直すか判断する。RnDが手作業のままだと、ランタイムEOL対応などはRnDだけ個別更新になる。

## CDK化のついでに入れるもの

- **arm64**: 料金2割減。速度はネットワーク待ちが支配的なので変わらない。純粋なJSなので書き換え不要、実機確認は要る。
- **AWS SDKのtree-shaking同梱**: 今は `--external:@aws-sdk/*` でランタイム同梱SDKを数千ファイルから読んでいる。使う分だけを1ファイルに同梱すれば初期化が数十ms縮む。tree-shakingとminifyを効かせないと逆に遅くなる。

## CDKの前提知識（初回作業時の確認用）

- `cdk bootstrap` をアカウント（×リージョン）ごとに1回実行すると、CDK用のロール一式（CloudFormation実行・デプロイ・ファイル公開・参照）とS3バケット1つができる。S3が要るのはCloudFormationがzipの中身を受け取れず「S3のどこにあるか」しか受け付けないため。
- `cdk diff` で変更対象を事前に確認できる。Lambda 1本だけ直して `cdk deploy` しても、コードのハッシュが変わった関数だけ更新される。`--hotswap` はCloudFormationを通さず直接差し替える開発用で、本番では使わない。
- ランタイム版は `lambda.Runtime.NODEJS_24_X` のような定数で指定する。共通定数にしておけばEOL時は1か所の変更で全関数に反映される。

## 調査記録: Lambdaコールドスタート（2026-09-15）

直近7日のCloudWatch Logsを、温めping（アプリログ無し、START/END/REPORTの3行）と実リクエストに分けて集計した。

| 関数 | 呼び出し | コールドスタート | うち実リクエスト | 初期化平均 |
|---|---|---|---|---|
| App用メイン | 2204 | 124 | 1 | 408ms |
| ESP32用メイン | 3346 | 160 | 5（判別しにくいもの11） | 418ms |
| 相槌(ESP32) | 2834 | 105 | 4 | 363ms |

コールドスタートの大半は予備インスタンス温めが意図通り新しいインスタンスを起こしているもので、ユーザーに当たる初期化待ちはほぼゼロ。温めは常時1台と予備1台なので、3人以上の同時利用で3人目からはコールドを踏むが、今の規模では問題になっていない。初期化400msの内訳は推定で `openai` パッケージの読み込みが大半、次にランタイム同梱SDKの読み込み。ユーザーが感じるコールドスタートにはこの他にログに出ないサンドボックス生成の100〜200msが乗り、そこは手が出せない。

却下した高速化案と理由は [先送り項目](deferred-items.md) の「Lambda初期化の短縮」。
