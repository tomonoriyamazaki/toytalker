# ToyTalker infra（AWS CDK / TypeScript）

ToyTalkerのAWS資源（Lambda 8本・Function URL 7本・DynamoDB 8テーブル・S3・SNS・温めルール・月次Scheduler）を1スタック `ToyTalker-<stage>` で管理する。決定事項と進め方は [docs/multi-account-iac-plan.md](../docs/multi-account-iac-plan.md)。

## 構成

| ファイル | 役割 |
|---|---|
| `bin/toytalker.ts` | 入口。`--context stage=<rnd\|stg\|prod\|prod-dg>` で環境を選び、資格情報のアカウントが一致するか確認し、SSMから秘密を読んでスタックを作る |
| `config/stages.ts` | 環境ごとの秘密でない設定（アカウントID・リージョン・通知先・ZakiCorp URL・S3バケット名・アーキテクチャ） |
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

別アカウントへ出すときは `AWS_PROFILE=<profile>` か `--profile <profile>` を付ける。設定のアカウントIDと資格情報が違えば起動時に止まる。

## 秘密（SSM）

- 必須: `lib/secrets.ts` の `REQUIRED_SECRETS`（OpenAI・Anthropic・Google・ElevenLabs・FishAudio・Sakura・Cartesia・ZakiCorp API/Edge・Serper・Soniox）
- 任意: OpenAI/Anthropicの管理キー（月次レポートが各社の請求を取るときだけ）
- 1件入れる: `printf '%s' "$VALUE" | npx tsx scripts/put-secret.ts <stage> OPENAI_API_KEY`
- RnDの既存Lambda環境変数から一括で写す: `npx tsx scripts/migrate-secrets-from-lambda.ts rnd [--dry-run]`
- 鍵を入れ替えたら `cdk deploy` し直す（synth時に読んでLambda環境変数へ焼くため）

## RnDの既存資源をimportで引き取る手順

CloudFormationはimport操作中に新しい資源を作れないので、2段階で行う。

```bash
# 0. 事前準備（各1回）
npx cdk bootstrap aws://342082316736/ap-northeast-1
npx tsx scripts/migrate-secrets-from-lambda.ts rnd

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
