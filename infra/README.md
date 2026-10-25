# ToyTalker infra（AWS CDK / TypeScript）

ToyTalkerのAWS資源（Lambda 8本・Function URL 7本・DynamoDB 8テーブル・S3・SNS・温めルール・月次Scheduler）を1スタック `toytalker-<stage>`（RnDは改名まで旧名 `ToyTalker-rnd`。`config/stages.ts` の `legacyNames` と `stackName()`）で管理する。この文書は手順だけを持つ。いまの状態と残作業は [docs/roadmap.md](../docs/roadmap.md)、決定と根拠は [docs/multi-account-iac-plan.md](../docs/multi-account-iac-plan.md)。

## 構成

| ファイル | 役割 |
|---|---|
| `bin/toytalker.ts` | 入口。`--context stage=<rnd\|stg\|prd\|prd-dg>` で環境を選び、資格情報のアカウントが一致するか確認し、SSMに秘密が登録済みか確かめてスタックを作る |
| `config/stages.ts` | 環境ごとの秘密でない設定（アカウントID・リージョン・通知先・ZakiCorp URL・テーブル名の末尾・S3バケット名・アーキテクチャ） |
| `lib/secrets.ts` | SSM Parameter Store（SecureString）の名前一覧と読み出し。名前は全環境共通 `/toytalker/<key>` |
| `lib/toytalker-stack.ts` | 資源定義。Lambdaは `backend/<dir>/index.mjs` をesbuildでまとめる（旧deploy.shと同じ指定。deploy.shは2026-09-16に削除） |
| `scripts/` | 初回移行用（下記） |

## 使い方

```bash
cd infra
npm ci
bash scripts/install-lambda-deps.sh     # 各Lambdaディレクトリのnpm依存（初回・clone直後）
npx cdk synth  --context stage=rnd      # テンプレート生成（cdk.out/）
npx cdk diff   --context stage=rnd      # 本番との差分。Replace が1つも無いことを確認してから deploy
npx cdk deploy --context stage=rnd
```

資格情報はIdentity Center（SSO）。`aws sso login` 後にそのまま動く（`[default]` がRnDのSSOプロファイル。期限8時間）。別アカウントへ出すときは `AWS_PROFILE=<profile>` か `--profile <profile>` を付ける。設定のアカウントIDと資格情報が違えば起動時に止まる。

## 落とし穴

- **`cdk synth`/`diff`/`deploy` にはAWS資格情報が要る**（SSMの登録の有無を確かめるため。値は読まない）。起動時にアカウントIDが `stages.ts` と一致しないと止まる。**`cdk bootstrap` も `infra/` で実行するとアプリを読み込んで同じ検査で止まる**（新しいアカウントにはまだ鍵が無い）。bootstrapは cdk.json の無いディレクトリから実行する（下の「新しい環境の立ち上げ」。2026-10-15、STGで判明）。
- **`NodejsFunction` は使っていない。** `npx esbuild` をリポジトリ直下で起動してインストール確認待ちで止まるため、esbuildのAPIを直接呼ぶ `bundleLambda` を使っている。
- 各Lambdaディレクトリの `node_modules` が無いとバンドルできない。clone直後は `bash scripts/install-lambda-deps.sh`。
- 名前を固定した資源（Lambda・テーブル・S3）の名前や部品IDを変えると作り直しになる。`cdk diff` の requires replacement を必ず見る。Lambdaの作り直しはFunction URLのホスト名が変わり、アプリとESP32が壊れる。
- 新しいCloudFormation資源を既存スタックに `cdk import` するときは、import操作にそれ以外の変更を含められない（`--context importPhase=true` の仕組みは下の「importで引き取る手順」）。
- CDKが環境変数を上書きするので、手作業でLambdaの環境変数を変えても次のdeployで戻る。

## 子アカウントでルートが要る操作

子アカウントのルート資格情報は無い（ルートアクセスの集中管理）。ルートでしかできない操作（S3バケットポリシー削除など）は管理アカウントから行う:

```bash
aws sts assume-root --target-principal <アカウントID> --task-policy-arn arn=arn:aws:iam::aws:policy/root-task/<S3UnlockBucketPolicy|SQSUnlockQueuePolicy|IAMDeleteRootUserCredentials|IAMCreateRootUserPassword>
```

管理アカウント自身のルート（gmail、MFAあり）は対象外。

## 名前とタグ

- 規則は [docs/naming-conventions.md](../docs/naming-conventions.md)（`toytalker-<機能>-<環境>`）。RnDの既存資源は改名まで旧名のまま。
- DynamoDBのテーブル名はコードに書かない。`config/stages.ts` の `tableSuffix`（RnDは空、STG以降は `-stg` 等）をCDKが環境変数 `TABLE_SUFFIX` で全Lambdaへ渡し、`backend/shared/tables.mjs` の `tableName("devices")` が `toytalker-devices<suffix>` に組む。`lib/toytalker-stack.ts` のテーブルも同じ形で作る
- タグ `project=toytalker` と `environment=<stage>` を `Tags.of(stack)` で全資源に付ける（タグ非対応のFunction URL・Schedulerには付かない）

## 秘密（SSM）

- 必須: `lib/secrets.ts` の `REQUIRED_SECRETS`（OpenAI・Anthropic・Google・ElevenLabs・FishAudio・Sakura・Cartesia・ZakiCorp API/Edge・Serper・Soniox）
- 任意: OpenAI/Anthropicの管理キー（月次レポートが各社の請求を取るときだけ）
- 1件入れる: `printf '%s' "$VALUE" | npx tsx scripts/put-secret.ts <stage> OPENAI_API_KEY`
- Lambdaは実行時にSSMから読み、メモリに保持する（`backend/shared/secrets.mjs`）。環境変数には鍵を置かず、関数ごとの対象名だけを `SECRET_PARAMS` で渡す。どの関数がどの鍵を読めるかは `lib/toytalker-stack.ts` の `secrets`
- 鍵を入れ替えるときはSSMを変えるだけ。稼働中のLambdaは5分を過ぎた次の呼び出しで取り直す（deploy不要）
- Lambdaに鍵を新しく使わせるとき: `lib/secrets.ts` に名前を足し、その関数の `secrets` に加え、コードでは `secret("名前")` で読む
- 環境変数方式の環境を移すときだけ2段階でdeployする（コードと設定の更新が別々に行われ、その間に鍵が読めなくなるのを避ける）: `npx cdk deploy --context stage=<stage> --context keepEnvSecrets=true` → ログの `[secrets] loaded n/n from SSM` と動作を確認 → フラグ無しで `npx cdk deploy`。新しく作る環境は最初からフラグ無し

## 新しい環境の立ち上げ（STGで2026-10-15に実施）

1. 管理アカウントで `aws organizations create-account --account-name toytalker-<環境> --email exodjp+toytalker-<環境>@gmail.com`。ルート資格情報なしで作られる（ルートアクセスの集中管理が有効）。IDを `config/stages.ts` の `account` に書く
2. Identity Center でグループ `admins` に `AdministratorAccess` を割り当てる（`aws sso-admin create-account-assignment`）
3. **bootstrapは cdk.json の無いディレクトリから実行する。** `infra/` で実行するとアプリを読み込み、SSMに鍵が無いので止まる。資格情報は管理アカウントから `aws sts assume-role --role-arn arn:aws:iam::<id>:role/OrganizationAccountAccessRole ...` で取るか、SSOプロファイルを使う
   ```bash
   cd "$TMPDIR" && /path/to/toytalker/infra/node_modules/.bin/cdk bootstrap aws://<id>/ap-northeast-1
   ```
4. SSMへ鍵11件を投入（`npx tsx scripts/put-secret.ts`、値はユーザー）
5. `npx cdk diff --context stage=<環境>` → `npx cdk deploy --context stage=<環境>`
6. マスターデータ: `npx tsx scripts/export-master-data.ts rnd` → `npx tsx scripts/import-master-data.ts <環境> --from=rnd --yes`

## RnDの既存資源をimportで引き取る手順

CloudFormationはimport操作中に新しい資源を作れないので、2段階で行う。

```bash
# 0. 事前準備（各1回）
npx cdk bootstrap aws://342082316736/ap-northeast-1
npx tsx scripts/migrate-secrets-from-lambda.ts rnd   # 2026-10-06に削除済み（Lambda環境変数からSSMへ写すスクリプト。移行は完了）

# 1. import段階: ロール・ポリシー・Lambda Permissionを含まないテンプレートで既存資源を引き取る
npx cdk synth --context stage=rnd --context importPhase=true
npx tsx scripts/make-import-mapping.ts rnd            # import/rnd.generated.json（論理ID→既存資源）
npx cdk import --context stage=rnd --context importPhase=true --resource-mapping import/rnd.generated.json ToyTalker-rnd

# 2. 通常デプロイ: CDK管理の最小権限ロールへ差し替え、Permission・ポリシーを追加、Node 24へ統一
npx cdk diff   --context stage=rnd                     # Replace が無いことを確認
npx cdk deploy --context stage=rnd
```

2段階目のあと、既存のロール `toytalk-lambda-role-dev` と旧Sid（`FunctionURLAllowPublicAccess` 等）は使われなくなるが残る。動作確認後に手で消す。

## マスターデータ

```bash
npx tsx scripts/export-master-data.ts rnd                 # master-data/rnd/*.json（Git対象外）
npx tsx scripts/import-master-data.ts stg --from=rnd --yes
```
