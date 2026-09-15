# 複数アカウント展開とIaC化の計画（2026-09-15決定）

今のAWSアカウントをRnDにし、STG → 自分用本番 → DG（西川さん）向け本番へ展開するための計画。道具はAWS CDK（TypeScript）。着手したら本文の「進め方」を進捗に合わせて上書きし、決定の根拠はこの文書に残す。

## 決定事項

| 項目 | 決定 | 根拠 |
|---|---|---|
| IaCの道具 | AWS CDK（TypeScript） | Lambda 8本がNode.js ESM + esbuildで、`NodejsFunction` がdeploy.shを丸ごと置き換える。ストリーミングFunction URLは `invokeMode: RESPONSE_STREAM` の1行。アプリもTS系で言語が増えない |
| CloudFormation | CDKの裏で使い続ける | CDKはTSをCloudFormationテンプレートに変換して流す。YAMLは書かない。マネコンのCloudFormation画面はスタックの閲覧・ロールバック用に使う |
| 今のアカウント | RnDとして残し、ToyTalkerの資源はCDK管理に引き取る（2026-09-15に変更） | 当初は手作業のまま残す予定だったが、RnDを見ながらCDKを書き、当てて差分が消えるまで直せる方が確実。テーブルにはデータが入っているので作り直さず `cdk import` で引き取る。ToyTalker以外の資源はCDKの管理外のまま |
| 環境 | RnD（現行）→ STG → 自分用本番 → DG向け本番 | Organizationsで分け、ログインはIAM Identity Center。アカウントごとのアクセスキーは作らない |
| 資源の名前 | テーブル名・Lambda名は `toytalker-*` の固定名を全環境で維持。S3バケットだけ環境名を付ける | アカウントが別なら同じ名前でぶつからない。RnDの既存資源をimportで引き取るには名前の一致が必要。S3は全世界で一意なので `toytalker-tts-speakers-<stage>` |
| 環境ごとの設定 | `infra/config/stages.ts` の1ファイルに環境ごとの塊を並べ、`cdk deploy --context stage=<env>` で選ぶ | アカウントID・リージョン・APIの固定ドメイン・通知メール・ZakiCorp URL・メモリなど。秘密ではないのでGitに入れる |
| 秘密の値 | アカウントごとのSSM Parameter Store（SecureString）。名前は全環境で同じ（例 `/toytalker/openai-api-key`）、中身だけ違う | CDKは名前しか持たず、秘密がファイルに載らない。中身は初回にアカウントごとに手で入れる（投入スクリプト可）。CDKがデプロイ時に読んでLambda環境変数に焼くので、鍵を入れ替えたら `cdk deploy` し直す |
| CDKが決める値 | Function URLのホスト名など、生成結果の値はファイルに書かない | CDKコード内で「このLambdaのURLをあのLambdaの環境変数へ」と配線する。人が見るのはデプロイ後の出力 |
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

RnDでCDKを完成させてから、同じコードをSTG・本番にまっさらに出す。RnDへの `cdk deploy` はSTGができるまで本番デプロイと同じ扱いで、毎回 `cdk diff` で置き換え（Replace）が1つも出ないことを確認してから流す。

1. **RnDの現状をAWS CLIで読み出す。** Lambda 8本の設定、テーブル8つの定義、Function URL、IAMロールのポリシー、温めルール、Scheduler、SNS。CloudFormationのIaC generatorも抜け漏れ確認に使える（生成コードは使わない）。
2. **CDKの骨組みを書く**（worktreeで）。上の棚卸し全部。ランタイムはNode 24で統一。温めルールと、実リクエスト中に自分へpingを投げる予備インスタンス温めはそのまま持ち込む。
3. **環境設定ファイルとSSMの名前を決める。** `infra/config/stages.ts` と `/toytalker/<key>`。RnDのLambda環境変数に直接入っているAPIキー類をRnDのSSMへ移す。
4. **RnDの既存資源を `cdk import` で引き取る。** DynamoDB 8テーブル、Lambda 8本、IAMロール、S3、SNS。Function URLとEventBridgeルールが引き取れるかは要確認。引き取れなければ、URL固定名化までは手作業のまま残しCDKの管理外にする（Function URLを作り直すとホスト名が変わりアプリとESP32が壊れる）。
5. **RnDで `cdk diff` が空になるまで直す。** ここでdeploy.shの役目が終わる。以後RnDへの反映は `cdk deploy --context stage=rnd`。
6. **マスターデータの投入スクリプト。** characters・voices・llms・api-unit-prices の4テーブルをRnDから書き出して別環境へ入れる。
7. **STGアカウントを作って `cdk bootstrap` → `cdk deploy`。** SSMに鍵を入れ、マスターデータを投入し、アプリとESP32の接続先をSTGへ向けて実機確認。
8. **エンドポイントの固定名化。** Function URLはアカウントごとにホスト名が変わるので、CloudFrontを前段に置いて `api-stg.zakicorp.com` のような固定名にする（ストリーミングはCloudFront経由でも通る）。アプリは `eas.json` のビルドプロファイルで、ESP32はビルドフラグで接続先を切り替える。
9. **ZakiCorp TTSのURL同期を止める。** 公開URLが `https://tts.zakicorp.com` で固定になったので、環境設定ファイルの値に移す。
10. STGで一通り動いたら、同じスタックを自分用本番、DG向け本番の順に出す。
11. 本番が2つになったらGitHub Actions + OIDC（アカウントごとにOIDC用ロール1つ。権限はCDKのロール群を借りるだけ。これもCDKで書く）。

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
