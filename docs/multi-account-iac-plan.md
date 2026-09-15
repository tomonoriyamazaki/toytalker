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
- Lambda Function URL 7本（RESPONSE_STREAM 4本: App用メイン・ESP32用メイン・App用相槌・読み上げ。BUFFERED 3本: ESP32用相槌・Soniox鍵発行・デバイス設定）。API Gateway `toytalk-chat-apigateway-dev` はv1（Raspberry Pi）時代の旧Lambda向けで現行8本とは無関係。CDKの対象外
- DynamoDB 8テーブル、S3 `toytalker-tts-speakers`、SNS `toytalker-ops-monthly`、EventBridge Scheduler `toytalker-ops-monthly`
- EventBridgeルール `toytalker-lambda-warmer`（5分ごと、メイン2本・相槌2本・Soniox鍵発行の5本へ `{"warmup":true}`）
- 実行ロールは2つ。7本が共有する `toytalk-lambda-role-dev`（DynamoDB/S3/Lambda FullAccess等の広い管理ポリシー）と、月次レポート用 `toytalker-ops-monthly-role`（最小権限のインライン）。環境変数はLambda全体で22種類、APIキー類がここに直接入っている
- 温めルールは `AWS::Lambda::Permission`（Sid `toytalker-warmer`）で5本に付いている。Function URLの公開許可は新しい4本には `InvokeFunctionUrl` と `InvokeFunction`（`InvokedViaFunctionUrl` 条件）の2つ、古い3本には前者だけ
- Function URLのホスト名がアプリとESP32ファームにハードコードされている
- ZakiCorp TTSの監視タスク（`tools/tts-service/supervisor.py`）がLambda 6本の `ZAKICORP_TTS_URL` を関数名指定で同期している

## 進め方

RnDでCDKを完成させてから、同じコードをSTG・本番にまっさらに出す。RnDへの `cdk deploy` はSTGができるまで本番デプロイと同じ扱いで、毎回 `cdk diff` で置き換え（Replace）が1つも出ないことを確認してから流す。コードは [infra/](../infra/README.md)。

1. **済（2026-09-16）RnDの現状をAWS CLIで読み出した。** 上の棚卸しに反映。CloudFormationで全種類がimport可能なことも `get-template-summary` で確認した（Lambda::Url・Events::Rule・Scheduler::Schedule・SNS::Subscription・Logs::LogGroup を含む）。
2. **済 CDKの骨組み。** `infra/` に1スタック `ToyTalker-<stage>`。Lambdaはesbuild APIで直接バンドルし、8本とも本番に入っているコードとバイト単位で一致することを確認した（`aws lambda get-function` で取得して比較）。温めルール・自分へのping・Scheduler・SNS購読を含む。ランタイムはNode 24で統一（`LAMBDA_RUNTIME` 1か所）。
   - `NodejsFunction` は使わない。`npx esbuild` をリポジトリ直下で起動してインストール確認待ちで止まるため（esbuildは `infra/` にしか無い）。
3. **済（コードのみ、SSMへの投入は未実行）環境設定ファイルとSSMの名前。** `infra/config/stages.ts` と `infra/lib/secrets.ts`。RnDのLambda環境変数からSSMへ写すスクリプトは `infra/scripts/migrate-secrets-from-lambda.ts`。SSMに入れるまでは `--context secretsSource=lambda` で既存Lambdaの環境変数を読んでsynth/diffできる（RnD限定）。
4. **済（2026-09-16 05:00 JST）RnDの既存資源を `cdk import` で引き取った。** 手順は [infra/README.md](../infra/README.md)。`cdk bootstrap` → SSMへ11件投入（`migrate-secrets-from-lambda.ts`）→ `--context importPhase=true` のテンプレート（36資源）で `cdk import`。import前後でLambda 8本の設定・コードハッシュ・環境変数が同一であることを確認した（更新日時だけCloudFormationのタグ付けで変わる）。IAMロールはimportせず、次のdeployでCDK管理の最小権限ロール（関数ごと、使うテーブルだけ）へ差し替えた。
5. **済（同日 05:16 JST）初回 `cdk deploy` でドリフトなし。** Replaceなし。変わったもの: ロール9つ新設と差し替え、Node 22→24（3本）、ESP32用メインのメモリ 2024→2048、Function URL公開許可と温めルールのPermission追加（旧Sidは残る）。deploy直後に実機からの会話1件がDynamoDB・LLM・検索・TTSまで新ロールで成功。ドリフト検出は IN_SYNC。**ここでdeploy.shの役目が終わった。以後RnDへの反映は `cdk deploy --context stage=rnd`。**
   - 未処理: 旧ロール `toytalk-lambda-role-dev` `toytalker-ops-monthly-role` `toytalker-ops-monthly-scheduler-role` と、旧Permission（Sid `FunctionURLAllowPublicAccess` `FunctionURLAllowInvokeAction` `toytalker-warmer`）の削除。実機の連続会話試験が済んでから消す。
6. **済（スクリプトのみ）マスターデータの投入スクリプト。** `infra/scripts/export-master-data.ts` / `import-master-data.ts`。出力先 `infra/master-data/` はGit対象外（人格プロンプトを含む）。
7. **STGアカウントを作って `cdk bootstrap` → `cdk deploy`。** `stages.ts` の `account` を埋め、SSMに鍵を入れ、マスターデータを投入し、アプリとESP32の接続先をSTGへ向けて実機確認。
8. **エンドポイントの固定名化。** Function URLはアカウントごとにホスト名が変わるので、CloudFrontを前段に置いて `api-stg.zakicorp.com` のような固定名にする（ストリーミングはCloudFront経由でも通る）。アプリは `eas.json` のビルドプロファイルで、ESP32はビルドフラグで接続先を切り替える。現在のハードコード箇所: `app/app/(tabs)/chat.tsx`・`settings.tsx`・`toy.tsx`・`app/components/ReadAloud.tsx`、ESP32は各版の `.ino`。
9. **ZakiCorp TTSのURL同期を止める。** 公開URLが `https://tts.zakicorp.com` で固定になったので `stages.ts` の値にした。`tools/tts-service/supervisor.py` の同期はimport後に不要になる（CDKがdeployのたびに環境変数を上書きするので、同期を残すと互いに書き合う）。
10. STGで一通り動いたら、同じスタックを自分用本番、DG向け本番の順に出す。
11. 本番が2つになったらGitHub Actions + OIDC（アカウントごとにOIDC用ロール1つ。権限はCDKのロール群を借りるだけ。これもCDKで書く）。

### 決めたこと（実装中に追加）

- リポジトリは公開。`stages.ts` に載るアカウントIDと通知先メールは秘密ではなく、メールは既に `docs/tts-boot-recovery.md` にもある。
- スタックは `terminationProtection: true`、テーブルとS3は `RemovalPolicy.RETAIN`、テーブルは削除保護ON。
- ロググループもCDK管理（保持期間は現状どおり無期限。変えるなら `stages.ts` に足す）。
- `cdk.json` は `versionReporting: false`（`AWS::CDK::Metadata` を出さない。import時に余計な資源を作らないため）。

## 命名の見直し（2026-09-16、未決定）

今の名前は `toytalk-`/`toytalker-` が混在し、環境名が無い。計画では「固定名を全環境で維持」としたが、環境名を付ける方向で見直したい（コンソールやログで環境が一目で分かる。S3は既に環境名が必須）。案は接頭辞 `toytalker-<env>-`、envは `rnd` / `stg` / `prd` / `prd-dg`（例: `toytalker-stg-devices`、`toytalker-stg-stream-handler`）。

### 名前の案（2026-09-16）

- 形は `toytalker-<env>-<機能>-<相手>`。環境名を前に置くと一覧が環境ごとに固まり、IAMで `toytalker-stg-*` の前方一致が書ける。
- `-lambda` `-table` のような種類は付けない（コンソールもログの `/aws/lambda/…` も種類を示す）。
- 相手は `app`（スマホ）と `mcu`（ESP32。`devices/mcu/` に合わせ、基板が変わっても持つ名前）。両方から使うものは付けない。

| 今 | 案 | 中身 |
|---|---|---|
| `toytalk-stream-handler-lambda` | `toytalker-<env>-chat-app` | App用メイン（LLM+TTS） |
| `toytalk-api-stream-for-esp32-lambda` | `toytalker-<env>-chat-mcu` | ESP32用メイン |
| `toytalker-backchannel-for-app-lambda` | `toytalker-<env>-backchannel-app` | App用相槌 |
| `toytalker-backchannel-for-esp32-lambda` | `toytalker-<env>-backchannel-mcu` | ESP32用相槌 |
| `toytalk-soniox-stt-lambda` | `toytalker-<env>-stt-token` | Soniox一時キー発行（両方から使う） |
| `toytalker-device-setting-lambda` | `toytalker-<env>-settings-app` | デバイス登録・ボイス設定・コスト（「デバイス設定」より広い） |
| `toytalker-tts-only-lambda` | `toytalker-<env>-read-aloud-app` | 読み上げ。実装（TTSのみ）より機能名 |
| `toytalker-ops-monthly-lambda` | `toytalker-<env>-ops-monthly` | 月次レポート |

テーブルは `toytalker-<env>-devices` のように接頭辞を替えるだけ。S3は `toytalker-<env>-tts-speakers`。ロググループは関数名に追従。

### 名前を変えたときに起きること

CDKで固定名を変えると、その資源は「作り直し（Replace）」になる。`cdk diff` に requires replacement と出る。古い資源は RETAIN にしてあるので消えずに残る。

| 資源 | 影響 |
|---|---|
| IAMロール | CDKが名前を付けるので変える場面がない。作り直しても実害なし |
| Lambda関数名 | **Function URLのホスト名が変わる。** アプリとESP32の接続先を配り直す必要がある。ロググループ名、`supervisor.py` の関数名一覧、月次レポートのログ検索対象も追従 |
| DynamoDBテーブル名 | 新テーブルは空。マスター4テーブルは `export/import-master-data.ts` で移せる。会話ログ・利用量は件数が多い |
| DynamoDBキー名 | テーブル名変更に加えて、データの詰め替えとLambdaコードの書き換えが要る。一番重い。変えるならSTGを作る前に決める |
| S3バケット名 | `aws s3 sync` で写すだけ（34オブジェクト） |
| SNS・温めルール・Scheduler | 影響なし。メール購読は再確認メールが届く |

### 進め方の案

1. **Lambdaコードがテーブル名を環境変数から組み立てるように直す**（例: `TABLE_PREFIX`）。名前はまだ変えない。CDKが環境変数を配るので、名前を知っているのは `stages.ts` だけになる。ここは無リスク。
2. **STGは最初から新しい名前で作る。** まっさらなので追加の手間はない。
3. **RnDは、CloudFrontの固定ドメイン（進め方8）の後に改名する。** 配布済みの実機があるので、Function URLのホスト名が変わっても困らない状態にしてから。接頭辞の統一と環境名の付与は1回で済ませる。

## CDK化のついでに入れるもの

- **arm64**: 料金2割減。速度はネットワーク待ちが支配的なので変わらない。純粋なJSなので書き換え不要、実機確認は要る。
- **AWS SDKのtree-shaking同梱**: 今は `--external:@aws-sdk/*` でランタイム同梱SDKを数千ファイルから読んでいる。使う分だけを1ファイルに同梱すれば初期化が数十ms縮む。tree-shakingとminifyを効かせないと逆に遅くなる。やるなら `backend/package.json` を作って `@aws-sdk/*` を `backend/node_modules` に置き（各Lambdaの `openai` 版違いはそのまま）、`bundleLambda` の `external` を空にして `minify: true`。import直後はやらず、diffが空になってから別コミットで。

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
