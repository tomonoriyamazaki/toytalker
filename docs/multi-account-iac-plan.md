# 複数アカウント展開とIaC化の計画（2026-09-15決定）

今のAWSアカウントをRnDにし、STG → 自分用本番 → DG（西川さん）向け本番へ展開するための計画。道具はAWS CDK（TypeScript）。この文書は「何を決めたか、なぜか」を持つ。いまの状態と残作業の順番は [ロードマップ](roadmap.md)、コードと手順は [infra/README.md](../infra/README.md)。

## 決定事項

| 項目 | 決定 | 根拠 |
|---|---|---|
| IaCの道具 | AWS CDK（TypeScript） | Lambda 8本がNode.js ESM + esbuildで、`NodejsFunction` がdeploy.shを丸ごと置き換える。ストリーミングFunction URLは `invokeMode: RESPONSE_STREAM` の1行。アプリもTS系で言語が増えない |
| CloudFormation | CDKの裏で使い続ける | CDKはTSをCloudFormationテンプレートに変換して流す。YAMLは書かない。マネコンのCloudFormation画面はスタックの閲覧・ロールバック用に使う |
| 今のアカウント | RnDとして残し、ToyTalkerの資源はCDK管理に引き取る（2026-09-15に変更） | 当初は手作業のまま残す予定だったが、RnDを見ながらCDKを書き、当てて差分が消えるまで直せる方が確実。テーブルにはデータが入っているので作り直さず `cdk import` で引き取る。ToyTalker以外の資源はCDKの管理外のまま |
| 環境 | RnD（現行）→ STG → 自分用本番 → DG向け本番 | Organizationsで分け、ログインはIAM Identity Center。アカウントごとのアクセスキーは作らない。組織とIdentity Centerは2019年から既にあり、管理アカウント = RnD のまま使う（2026-10-13決定。下の「組織とIdentity Center」、却下理由は [先送り項目](deferred-items.md)） |
| 資源の名前 | 全資源に環境名を付ける: `toytalker-<機能>-<環境>`（2026-10-12決定。[命名規則](naming-conventions.md)）。RnDは既存名のままimportで引き取り、CloudFront固定ドメインの後に改名する | 当初は「固定名を全環境で維持、S3だけ環境名」としたが、コンソールやログで環境が一目で分かる方を取った。RnDの既存資源をimportで引き取るには名前の一致が必要なので、RnDの改名は後回し |
| 環境ごとの設定 | `infra/config/stages.ts` の1ファイルに環境ごとの塊を並べ、`cdk deploy --context stage=<env>` で選ぶ | アカウントID・リージョン・APIの固定ドメイン・通知メール・ZakiCorp URL・メモリなど。秘密ではないのでGitに入れる |
| 秘密の値 | アカウントごとのSSM Parameter Store（SecureString）。名前は全環境で同じ（例 `/toytalker/openai-api-key`）、中身だけ違う | CDKは名前しか持たず、秘密がファイルに載らない。中身は初回にアカウントごとに手で入れる（`put-secret.ts`）。Lambdaが実行時に読む（2026-10-06切替。下の「秘密の実行時取得」）ので、鍵の入れ替えはSSMを変えるだけで `cdk deploy` は要らない |
| CDKが決める値 | Function URLのホスト名など、生成結果の値はファイルに書かない | CDKコード内で「このLambdaのURLをあのLambdaの環境変数へ」と配線する。人が見るのはデプロイ後の出力 |
| デプロイ経路 | ローカルからSSOの一時資格情報で `cdk deploy`。GitHub Actions + OIDCは見送り（2026-10-25） | 1人運用では門が増えるだけ。再検討は複数人がdeployするようになったとき（[先送り項目](deferred-items.md)） |
| Lambda起動の高速化 | 今はやらない | 温め設計が効いている（下記） |
| Terraform | 見送り | AWS単独ならCDKの方が学ぶことが少ない。Cloudflare側（DNS・WAF・Tunnel）もコード化したくなったら再検討 |

## アカウント一覧（2026-10-14）

組織 `o-lbme8l7xtz`（管理アカウント = RnD。組織上の名前は `management`、2026-10-15に `toytalker-rnd` から変更）。名前の規則は [命名規則](naming-conventions.md) の「AWSアカウント」節。2026-10-14に名前3件と子2つの主メールを変更し、STGを作成済み（下表は実測値）。`create-account` で作ったアカウントには、管理アカウントから `sts assume-role` で入れる `OrganizationAccountAccessRole`（AdministratorAccess）が自動で付く。ルートのパスワードは未設定（必要なら「パスワードを忘れた」で主メール宛てに再設定）。

| 用途 | 組織上の名前 | アカウントID | 主メール | CLIプロファイル | 状態 |
|---|---|---|---|---|---|
| 管理アカウント（ToyTalkerのRnDが同居） | `management` | 342082316736 | `exodjp@gmail.com`（変えない） | `toytalker-rnd`（SSO。`default` も同じSSOに向けた。2026-10-25） | 稼働中。他プロジェクトの資源・公開S3もある。ToyTalker分は CloudFormation `ToyTalker-rnd`、`stages.ts` の `rnd` |
| STG | `toytalker-stg` | 131746731200 | `exodjp+toytalker-stg@gmail.com` | `toytalker-stg` | 2026-10-14作成（`create-account`、8秒で完了）。2026-10-15 `cdk bootstrap` 済み（`CDKToolkit`）、2026-10-16 SSM鍵11件投入済み（RnDと同じ値）。deployはロードマップ3 |
| 自分用本番 | `toytalker-prd` | 未作成 | `exodjp+toytalker-prd@gmail.com` | `toytalker-prd` | ロードマップ7 |
| DG向け本番 | `toytalker-prd-dg` | 未作成 | `exodjp+toytalker-prd-dg@gmail.com` | `toytalker-prd-dg` | ロードマップ7 |
| 検証用（2019年参加の旧子アカウント） | `sandbox-1` | 586464890779 | `exodjp+sandbox-1@gmail.com`（旧 `exodjp@nifty.com`、解約済み） | `sandbox-1` | 中身未確認。費用$0。ToyTalkerには使わない |
| 検証用（同上） | `sandbox-2` | 499135248182 | `exodjp+sandbox-2@gmail.com`（旧 `exodjp@yahoo.co.jp`） | `sandbox-2` | 同上 |

- 請求は一括請求で管理アカウントに集まる。子アカウントに支払い方法は要らない（組織から出すときだけ必要）。管理アカウントのルートにはMFAあり（2026-10-15確認）。
- 子アカウントのルート資格情報は無い（2026-10-15、ルートアクセスの集中管理を有効化して削除。下の「組織とIdentity Center」）。子にはIdentity Centerか、管理アカウントからの `OrganizationAccountAccessRole` で入る。
- 管理アカウントの主メールは Account Management API では変えられない（ルートでBillingコンソールから変える）。gmailのままで困らないので変えない。
- 名前変更は `aws account put-account-name`（管理アカウントから子を指定できる。信頼されたアクセス `account.amazonaws.com` が必要で、2026-10-14に有効化済み）。主メール変更は `start-primary-email-update` → 新アドレスに届く6桁コードで `accept-primary-email-update`。どちらも請求・資源・Identity Centerの割り当てには影響しない。名前は何度でも付け替えられるので、用途が変わったら改名する。
- Identity Centerの入口は `https://d-95671d6109.awsapps.com/start`（ユーザー `yamazaki`、グループ `admins`、権限セット `AdministratorAccess`。規則は [命名規則](naming-conventions.md) の「IAM Identity Center」）。CLIは `aws configure sso` で作ったプロファイルで `cdk deploy --profile <プロファイル名> --context stage=<環境>`（2026-10-25にSSOへ移行済み。長期アクセスキーは無い。手順は [セキュリティ見直し](security-review-2026-10-25.md)）。

### 組織とIdentity Center（2026-10-13に読み取りで確認、2026-10-15に整理）

- **Organizations はすでにある**（`o-lbme8l7xtz`、2019年2月作成、全機能有効、SCP未使用）。**管理アカウント = RnD（342082316736、exodjp@gmail.com）。**
- 子アカウント2つ（`sandbox-1` / `sandbox-2`）は2019年に招待で参加。2026年7〜9月の費用は $0、中身は未確認。主メールは2026-10-14に gmail のプラスアドレスへ変更済み（旧 nifty は解約済みで受信不可だった）。
- **IAM Identity Center は2021年から有効**（インスタンス `ssoins-7758a71eeb88ba75`、ID store `d-95671d6109`、入口 `https://d-95671d6109.awsapps.com/start`、別名 `zackey.awsapps.com`）。2026-10-15に整理済み: ユーザーは `yamazaki`（gmail）1人、グループ `admins` に権限セット `AdministratorAccess`（セッション8時間）が4アカウント全部へ割り当て済み。旧ユーザー2人（`yamazaki-3tyd-sso` / `-sso2`）と空の権限セット `dev` は削除。規則は [命名規則](naming-conventions.md) の「IAM Identity Center」。パスワードとパスキー2本は2026-10-25に設定済み。
- 有効化済みの信頼されたアクセス: `access-analyzer`、`sso`、`account`（Account Management。2026-10-14）、`iam`（2026-10-15）、`cloudtrail`（2026-10-25、組織トレイル）。
- **ルートアクセスの集中管理は有効**（2026-10-15。`RootCredentialsManagement` と `RootSessions` の両方）。子アカウントのルート資格情報は3つとも無し（sandbox-1のパスワード、sandbox-2のパスワードとU2Fキーを `sts assume-root` で削除。STGは最初から無し）。以後 `create-account` で作るアカウントはルート資格情報なしで作られ、子のルートで「パスワードを忘れた」もできない。ルートでしかできない操作の手順は [infra/README](../infra/README.md) の「子アカウントでルートが要る操作」。

### 決めたこと（2026-10-13、組織とアカウント）

- **管理アカウントはRnDのままにする。** 教科書は「管理アカウントにワークロードを置かない」だが、作り直すには組織の解散とIdentity Centerの組み直しが要り、1人運用で得るものに見合わない。却下理由は [先送り項目](deferred-items.md)。
- **古い子アカウント2つは閉鎖せず、検証用に残す。** 料金はかからず、gmailのSSOユーザーで管理者として入れる。STG・本番には使わず新規作成する（メールを環境名で揃える、2019年の設定を引き継がない、管理アカウントから入るロールが自動で付く）。
- **STG以降のアカウントは管理アカウントから `create-account` で作る。** メールは `exodjp+toytalker-stg@gmail.com` の形（環境ごとに別アドレスが要るが受信箱は1つ）。STGは2026-10-14に作成済み。管理アカウントの組織上の名前は `management`（他プロジェクトの資源も持つため。一度 `toytalker-rnd` にして翌日変えた）。
- Identity Centerはそのまま使い、ユーザー名がまともな `yamazaki` を残してメールを gmail に付け替えた（2026-10-15完了）。グループは `test-group` → `admins`。

### 決めたこと（2026-09-16、秘密と鍵）

- 秘密はSecrets Managerでなく **SSM SecureString**（1件$0.40/月が不要。ローテーション・アカウント間共有を使わないため）。
- 鍵はAWS管理キー。**CMKは本番アカウントで入れる**（DG向け本番で他の人が入る時点で効く。1鍵約$1/月）。RnD/STGはAWS管理キーのまま（自分1人なので門が増えない。2026-10-15再確認）。対象は環境変数から鍵を外したのでSSMだけ。ロードマップ7の着手時に決める: 自分用本番にも入れるか、DG向け本番で会話ログのDynamoDBにも入れるか（顧客への説明用）。後から足せる（SSMは入れ直し、DynamoDBは稼働中に切替可）。
- STG用に鍵を分けるのは見送り、RnDと同じ値を写した（2026-10-16）。本番では分ける。
- ファーム配布バケット `toytalker-firmware` はCDKの管理外（`fromBucketName` で参照のみ）。名前は `stages.ts` の `firmwareBucketName`。ファームは環境に属さず全機共通なので、環境ごとのスタックへ `cdk import` するのは合わない。置くアカウントと管理方法はロードマップ9で決める（2026-10-25）。

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

## 進め方（CDK化の経過。2026-09-16で完了した分の記録）

RnDでCDKを完成させてから、同じコードをSTG・本番にまっさらに出す。RnDへの `cdk deploy` は本番デプロイと同じ扱いで、毎回 `cdk diff` で置き換え（Replace）が1つも出ないことを確認してから流す。コードは [infra/](../infra/README.md)。7以降の残りは [ロードマップ](roadmap.md) の3・7が持つ。

1. **済（2026-09-16）RnDの現状をAWS CLIで読み出した。** 上の棚卸しに反映。CloudFormationで全種類がimport可能なことも `get-template-summary` で確認した（Lambda::Url・Events::Rule・Scheduler::Schedule・SNS::Subscription・Logs::LogGroup を含む）。
2. **済 CDKの骨組み。** `infra/` に1スタック `ToyTalker-<stage>`。Lambdaはesbuild APIで直接バンドルし、8本とも本番に入っているコードとバイト単位で一致することを確認した（`aws lambda get-function` で取得して比較）。温めルール・自分へのping・Scheduler・SNS購読を含む。ランタイムはNode 24で統一（`LAMBDA_RUNTIME` 1か所）。
   - `NodejsFunction` は使わない。`npx esbuild` をリポジトリ直下で起動してインストール確認待ちで止まるため（esbuildは `infra/` にしか無い）。
3. **済（コードのみ、SSMへの投入は未実行）環境設定ファイルとSSMの名前。** `infra/config/stages.ts` と `infra/lib/secrets.ts`。RnDのLambda環境変数からSSMへ写すスクリプトは `infra/scripts/migrate-secrets-from-lambda.ts`。（`--context secretsSource=lambda` は2026-10-06の実行時取得への切替で廃止）。
4. **済（2026-09-16 05:00 JST）RnDの既存資源を `cdk import` で引き取った。** 手順は [infra/README.md](../infra/README.md)。`cdk bootstrap` → SSMへ11件投入（`migrate-secrets-from-lambda.ts`）→ `--context importPhase=true` のテンプレート（36資源）で `cdk import`。import前後でLambda 8本の設定・コードハッシュ・環境変数が同一であることを確認した（更新日時だけCloudFormationのタグ付けで変わる）。IAMロールはimportせず、次のdeployでCDK管理の最小権限ロール（関数ごと、使うテーブルだけ）へ差し替えた。
5. **済（同日 05:16 JST）初回 `cdk deploy` でドリフトなし。** Replaceなし。変わったもの: ロール9つ新設と差し替え、Node 22→24（3本）、ESP32用メインのメモリ 2024→2048、Function URL公開許可と温めルールのPermission追加（旧Sidは残る）。deploy直後に実機からの会話1件がDynamoDB・LLM・検索・TTSまで新ロールで成功。ドリフト検出は IN_SYNC。**ここでdeploy.shの役目が終わった。以後RnDへの反映は `cdk deploy --context stage=rnd`。**
   - 同日06:24 JST、ESP32 OTA（main b18c70d）に合わせて2回目のdeploy: Soniox鍵発行Lambdaのタイムアウト3→5、`toytalker-devices` 書き込み、ファーム配布バケット `toytalker-firmware`（手作業で作成、CDKは `fromBucketName` で参照のみ。名前は `stages.ts` の `firmwareBucketName`）の読み取り、環境変数 `FIRMWARE_BUCKET`。デバイス設定Lambdaもmainの版へ。
   - 同日、アプリ（会話・読み上げ・設定保存・クローンボイス登録）とESP32（会話・OTA）の確認後に後片付け: 旧ロール `toytalker-ops-monthly-role` `toytalker-ops-monthly-scheduler-role` と旧Permission（Sid `FunctionURLAllowPublicAccess` `FunctionURLAllowInvokeAction` `toytalker-warmer`）を削除。**`toytalk-lambda-role-dev` は残した**（v1の旧Lambda `toytalk-openai-api-dev` `toytalk-api-raspi` がまだ使っている。API Gateway `toytalk-chat-apigateway-dev` ともども、消すなら別途判断）。
6. **済（スクリプトのみ）マスターデータの投入スクリプト。** `infra/scripts/export-master-data.ts` / `import-master-data.ts`。出力先 `infra/master-data/` はGit対象外（人格プロンプトを含む）。
7. **済（2026-10-16、deployと投入を除く）STGアカウントの準備。** 作成・`cdk bootstrap`・SSM投入まで。`cdk deploy` とマスターデータ投入はロードマップ3（固定ドメインの後。理由はロードマップ）。
8. **済（コード、2026-10-29。deploy と実機確認はロードマップ3）エンドポイントの固定名化。** `api-<環境>.zakicorp.com`（`stages.ts` の `apiDomain`）を CloudFront の別名にし、Function URL 7本を経路で束ねる。us-east-1 の ACM 証明書と WAF は `<スタック名>-edge` スタック。アプリは `app/lib/api.ts` の `API_BASE_URL`（EAS の env `EXPO_PUBLIC_API_BASE_URL` で上書き）、ESP32 は `TOYTALKER_API_HOST` で接続先を切り替える。構成と手順は [infra/README](../infra/README.md) の「固定ドメイン」。
9. **済（コードのみ、このPCへの反映は未実施）ZakiCorp TTSのURL同期を止める。** 固定URLのときは照合と警告だけにし、書き込みはngrok経路に限った。 公開URLが `https://tts.zakicorp.com` で固定になったので `stages.ts` の値にした。`tools/tts-service/supervisor.py` の同期はimport後に不要になる（CDKがdeployのたびに環境変数を上書きするので、同期を残すと互いに書き合う）。反映はロードマップ9。
10. STGで一通り動いたら、同じスタックを自分用本番、DG向け本番の順に出す（ロードマップ7）。
11. ~~本番が2つになったらGitHub Actions + OIDC~~ → 2026-10-25に見送り（[先送り項目](deferred-items.md)）。

### 決めたこと（実装中に追加）

- リポジトリは公開。`stages.ts` に載るアカウントIDと通知先メールは秘密ではなく、メールは既に `docs/tts-boot-recovery.md` にもある。
- スタックは `terminationProtection: true`、テーブルとS3は `RemovalPolicy.RETAIN`、テーブルは削除保護ON。
- ロググループもCDK管理（保持期間は現状どおり無期限。変えるなら `stages.ts` に足す）。
- `cdk.json` は `versionReporting: false`（`AWS::CDK::Metadata` を出さない。import時に余計な資源を作らないため）。

## 秘密の実行時取得（2026-09-16合意、2026-10-06実装・RnD切替済み）

「CDKがdeploy時にSSMを読み、Lambda環境変数に焼く」方式から、「Lambdaが初期化時にSSMを読み、メモリに保持する」方式へ変えた。実装は `backend/shared/secrets.mjs` と `infra/lib/toytalker-stack.ts` の `secrets`、手順は infra/README の「秘密」節。計画と違えた点: 切替時にコード更新と設定更新の間で鍵が読めなくなるのを避けるため、`--context keepEnvSecrets=true` で環境変数にも残す1段目を挟む2段階deployにした（`secret()` は環境変数へフォールバックする）。以下は合意時の計画。

- 理由: 環境変数はLambdaの設定を読める人に平文で見え、CDKがS3に上げるテンプレートにも入る。実行時取得なら鍵は関数のメモリにしかなく、読めるのはその関数のロールだけ。鍵の差し替えもSSMを変えるだけでdeploy不要になる。
- 速度: 初期化（コールドスタート）に `GetParameters` 1〜2回分（30〜60ms）が足される。2回目以降は保持した値を使うので環境変数と同じ。温めで初期化はほぼ起きない（週1〜5回）ので体感差なし。
- やり方: 共通モジュール1つを8本に入れ、初期化時に10件ずつ並列取得、5分以上経ったら裏で取り直す。CDKは環境変数から鍵を外し、ロールに `ssm:GetParameters` を足す。AWS管理キーの復号はSSM経由で自動的に許可される。AWS公式の Parameters and Secrets Lambda Extension はレイヤー追加とHTTP呼び出しへの書き換えが要るので使わない。
- 時期: STGを作る前。8本のコードに手が入るので実機試験が要る。先にやればSTGは最初から環境変数に鍵の無い状態で立ち上がる。
- 秘密でない設定（`ZAKICORP_TTS_URL`・`CARTESIA_DEFAULT_VOICE_ID`・`SONIOX_MODEL`・`FIRMWARE_BUCKET`・`OPS_SNS_TOPIC_ARN`）は環境変数のまま。

## 命名（決定）

2026-09-16に案を出し、2026-10-12に決定。**規則は [命名規則](naming-conventions.md)**（`toytalker-<機能>-<環境>`、環境は `rnd` / `stg` / `prd` / `prd-dg`、種類の接尾辞なし、タグ `project` / `environment`）。ここには既存RnD資源の新旧対応と、改名の影響・順番だけを置く。`stages.ts` の `prod` / `prod-dg` は2026-10-13に `prd` / `prd-dg` へ直した（アカウント未作成なので資源への影響なし）。

### Lambda

| 今 | 決定 | CDK部品ID（今 → 決定） | 中身 |
|---|---|---|---|
| `toytalk-stream-handler-lambda` | `toytalker-chat-app-<環境>` | `StreamHandler` → `ChatApp` | App用メイン（LLM+TTS） |
| `toytalk-api-stream-for-esp32-lambda` | `toytalker-chat-mcu-<環境>` | `Esp32Stream` → `ChatMcu` | ESP32用メイン |
| `toytalker-backchannel-for-app-lambda` | `toytalker-backchannel-app-<環境>` | `BackchannelApp`（変更なし） | App用相槌 |
| `toytalker-backchannel-for-esp32-lambda` | `toytalker-backchannel-mcu-<環境>` | `BackchannelEsp32` → `BackchannelMcu` | ESP32用相槌 |
| `toytalk-soniox-stt-lambda` | `toytalker-stt-token-<環境>` | `SonioxStt` → `SttToken` | Soniox一時キー発行（両方から使う） |
| `toytalker-device-setting-lambda` | `toytalker-settings-app-<環境>` | `DeviceSetting` → `SettingsApp` | デバイス登録・ボイス設定・コスト（「デバイス設定」より広い） |
| `toytalker-tts-only-lambda` | `toytalker-read-aloud-app-<環境>` | `TtsOnly` → `ReadAloudApp` | 読み上げ。実装（TTSのみ）より機能名 |
| `toytalker-ops-monthly-lambda` | `toytalker-ops-monthly-<環境>` | `OpsMonthly`（変更なし） | 月次レポート |

### Lambda以外

| 種類 | 今 | 決定 |
|---|---|---|
| スタック名 | `ToyTalker-rnd` | `toytalker-<環境>`（小文字で揃える） |
| DynamoDB 8テーブル | `toytalker-devices` など | `toytalker-devices-<環境>` など末尾に環境名。部品IDは `DevicesTable` のまま |
| S3 | `toytalker-tts-speakers`、`toytalker-firmware` | `toytalker-tts-speakers-<環境>`、`toytalker-firmware-<環境>`（`stages.ts` のSTG以降の値と同じ形） |
| SNS・温めルール・Scheduler | `toytalker-ops-monthly`、`toytalker-lambda-warmer` | `toytalker-ops-monthly-<環境>`、`toytalker-warmer-<環境>` |
| ロググループ | `/aws/lambda/<関数名>` | 関数名に追従 |
| IAMロール | CDKが付ける（スタック名が先頭） | 固定名は付けない。スタック名の変更で環境名が付く |
| SSM | `/toytalker/<key>` | 変えない（アカウントごとなので環境名不要） |
| `backend/` のディレクトリ名 | `toytalk-stream-handler-lambda` など | `backend/<機能>`（`backend/chat-app` など、環境名は付けない）。RnDの改名と同時に直す。それまでは旧名のまま |
| 固定ドメイン（ロードマップ3） | 未定 | 3の着手時に決める。`api-stg.zakicorp.com` の形が案 |

### 名前は3層あり、一度に変える

| 層 | 今 | 決めているもの |
|---|---|---|
| スタック名 | `ToyTalker-rnd` | IAMロール名の先頭、CloudFormationの一覧 |
| 部品ID（CDKコード内の名前） | `StreamHandler`、`DevicesTable` など | ロール名の中身、CloudFormationの論理ID |
| 資源の固定名 | `toytalk-stream-handler-lambda`、`toytalker-devices` など | 実際のLambda名・テーブル名。アプリやコードが参照するのはこれ |

部品IDを変えると、その資源はCloudFormation上で別物になり作り直しになる（テーブルも同じ）。固定名を変える時点で作り直しは避けられないので、スタック名・部品ID・固定名は同時に変え、作り直しを1回で済ませる。

### 名前を変えたときに起きること

CDKで固定名を変えると、その資源は「作り直し（Replace）」になる。`cdk diff` に requires replacement と出る。古い資源は RETAIN にしてあるので消えずに残る。

| 資源 | 影響 |
|---|---|
| IAMロール | CDKが名前を付けるので変える場面がない。作り直しても実害なし |
| Lambda関数名 | **Function URLのホスト名が変わる。** アプリとESP32の接続先を配り直す必要がある。ロググループ名と `supervisor.py` の関数名一覧も追従。月次レポートのログ検索対象はCDKが環境変数 `RECORDING_LOG_GROUPS` で渡すので追従不要（2026-10-16） |
| DynamoDBテーブル名 | 新テーブルは空。マスター4テーブルは `export/import-master-data.ts` で移せる。会話ログ・利用量は件数が多い |
| S3バケット名 | `aws s3 sync` で写すだけ（34オブジェクト） |
| SNS・温めルール・Scheduler | 影響なし。メール購読は再確認メールが届く |

### 適用の順番（決定）

1. **Lambdaコードがテーブル名を環境変数から組み立てるように直す**（`TABLE_SUFFIX` を1つ配り、`devices${TABLE_SUFFIX}` のように組む。RnDは空文字）。2026-10-12時点で8本の `index.mjs` に文字列直書きが計36か所。名前はまだ変えない。CDKが環境変数を配るので、名前を知っているのは `stages.ts` だけになる。タグ2つもこのとき足す（RnDの既存資源にも付く。Replaceは起きない）。ここは無リスクで、ロードマップ2（STG）の最初の作業。**済（2026-10-13）**: `backend/shared/tables.mjs` の `tableName()`、`stages.ts` の `tableSuffix`、タグ2つをRnDへdeployした。`cdk diff` にReplaceなし、テーブル名の読み取り（`/llms` `/voices` `/characters`）とログを確認。
2. **STGは最初から新しい名前で作る。** まっさらなので追加の手間はない。**済（2026-10-16）**: `stages.ts` の `legacyNames`（RnDだけ true）で部品ID・固定名・スタック名を切り替える実装を入れ、STGの合成結果が上の表どおり（`toytalker-chat-app-stg`、スタック `toytalker-stg`、`toytalker-warmer-stg` 等）であることを確認。月次レポートのログ検索対象は環境変数 `RECORDING_LOG_GROUPS` でCDKが渡す（無ければ旧名）。RnDの差分は月次Lambdaの環境変数追加だけでReplaceなし。
3. **RnDは、CloudFrontの固定ドメイン（進め方8）の後に改名する**（ロードマップ7）。配布済みの実機があるので、Function URLのホスト名が変わっても困らない状態にしてから。接頭辞の統一・環境名の付与・`backend/` ディレクトリ名・`supervisor.py` の関数名一覧を1回で済ませる。

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
