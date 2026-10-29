# ToyTalker infra（AWS CDK / TypeScript）

ToyTalkerのAWS資源（Lambda 8本・Function URL 7本・DynamoDB 8テーブル・S3・SNS・温めルール・月次Scheduler・CloudFront 固定ドメイン）を1スタック `toytalker-<stage>`（RnDは改名まで旧名 `ToyTalker-rnd`。`config/stages.ts` の `legacyNames` と `stackName()`）で管理する。CloudFront が us-east-1 に要求する ACM 証明書と WAF は `<スタック名>-edge`（`lib/toytalker-edge-stack.ts`）に置き、本体が参照する。この文書は手順だけを持つ。いまの状態と残作業は [docs/roadmap.md](../docs/roadmap.md)、決定と根拠は [docs/multi-account-iac-plan.md](../docs/multi-account-iac-plan.md)。

## 構成

| ファイル | 役割 |
|---|---|
| `bin/toytalker.ts` | 入口。`--context stage=<rnd\|stg\|prd\|prd-dg>` で環境を選び、資格情報のアカウントが一致するか確認し、SSMに秘密が登録済みか確かめてスタックを作る |
| `config/stages.ts` | 環境ごとの秘密でない設定（アカウントID・リージョン・通知先・ZakiCorp URL・テーブル名の末尾・S3バケット名・アーキテクチャ） |
| `lib/secrets.ts` | SSM Parameter Store（SecureString）の名前一覧と読み出し。名前は全環境共通 `/toytalker/<key>` |
| `lib/toytalker-stack.ts` | 資源定義。Lambdaは `backend/<dir>/index.mjs` をesbuildでまとめる（旧deploy.shと同じ指定。deploy.shは2026-09-16に削除）。CloudFront は `createApiDistribution` |
| `lib/toytalker-edge-stack.ts` | us-east-1 のスタック `<スタック名>-edge`: ACM 証明書（DNS 検証）と WAF（レート制限）。本体が crossRegionReferences で参照する |
| `scripts/` | 初回移行用（下記） |

## 使い方

```bash
cd infra
npm ci
bash scripts/install-lambda-deps.sh     # 各Lambdaディレクトリのnpm依存（初回・clone直後）
npx cdk synth  --context stage=rnd      # テンプレート生成（cdk.out/）
npx cdk synth  --context stage=rnd --context nag=true   # cdk-nag の静的点検。指摘があると止まる（deploy前に通す）
npx cdk diff   --context stage=rnd      # 本番との差分。Replace が1つも無いことを確認してから deploy
npx cdk deploy --context stage=rnd --all   # スタックは edge（us-east-1）・本体・org の3つ。本体は edge に依存するので順番は CDK が決める
```

cdk-nag で受け入れる指摘は `lib/toytalker-stack.ts` の `acknowledgeNagFindings` に理由付きで書く（根拠は [docs/security-review-2026-10-25.md](../docs/security-review-2026-10-25.md)）。

資格情報はIdentity Center（SSO）。`aws sso login` 後にそのまま動く（`[default]` がRnDのSSOプロファイル。期限8時間）。別アカウントへ出すときは `AWS_PROFILE=<profile>` か `--profile <profile>` を付ける。設定のアカウントIDと資格情報が違えば起動時に止まる。

## 落とし穴

- **`cdk synth`/`diff`/`deploy` にはAWS資格情報が要る**（SSMの登録の有無を確かめるため。値は読まない）。起動時にアカウントIDが `stages.ts` と一致しないと止まる。**`cdk bootstrap` も `infra/` で実行するとアプリを読み込んで同じ検査で止まる**（新しいアカウントにはまだ鍵が無い）。bootstrapは cdk.json の無いディレクトリから実行する（下の「新しい環境の立ち上げ」。2026-10-15、STGで判明）。
- **`NodejsFunction` は使っていない。** `npx esbuild` をリポジトリ直下で起動してインストール確認待ちで止まるため、esbuildのAPIを直接呼ぶ `bundleLambda` を使っている。
- 各Lambdaディレクトリの `node_modules` が無いとバンドルできない。clone直後は `bash scripts/install-lambda-deps.sh`。**deploy前にも毎回実行する。** `node_modules` は git 管理外なので、別の作業ツリーで `package-lock.json` を更新して deploy したあと、main の古い `node_modules` から deploy すると依存が lock より前の版に戻る（2026-10-28、ESP32用Lambda 2本の undici が 8.12.3→8.7.0 に戻った。`cdk diff` には S3Key の変化としてしか出ない）。
- 名前を固定した資源（Lambda・テーブル・S3）の名前や部品IDを変えると作り直しになる。`cdk diff` の requires replacement を必ず見る。Lambdaの作り直しはFunction URLのホスト名が変わり、アプリとESP32が壊れる。
- 新しいCloudFormation資源を既存スタックに `cdk import` するときは、import操作にそれ以外の変更を含められない（`--context importPhase=true` の仕組みは下の「importで引き取る手順」）。
- CDKが環境変数を上書きするので、手作業でLambdaの環境変数を変えても次のdeployで戻る。
- `cdk synth` が `CredentialsProviderError: UnauthorizedException: Session token not found or invalid` で止まり、`aws sts get-caller-identity` は通るとき（2026-10-25、CLI 2.33.2）: `eval "$(aws configure export-credentials --format env)"` でCLIの資格情報を環境変数に出してから実行する。原因未確定（[セキュリティ見直し](../docs/security-review-2026-10-25.md) の「観察」）。

- リモート（別端末）から SSO ログインするとき: `aws sso login --sso-session toytalker --use-device-code --no-browser` でURLとコードを出し、手元の端末で開いて承認する。通常方式はこのPCのブラウザへ戻る仕組みなので完了できない。コードは10分で失効。SSOセッションは8時間で切れる。

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

- 必須: `lib/secrets.ts` の `REQUIRED_SECRETS`（OpenAI・Anthropic・Google・ElevenLabs・FishAudio・Sakura・Cartesia・ZakiCorp API/Edge・Brave・Soniox）
- 任意: OpenAI/Anthropicの管理キー（月次レポートが各社の請求を取るときだけ）
- 1件入れる: `printf '%s' "$VALUE" | npx tsx scripts/put-secret.ts <stage> OPENAI_API_KEY`
- Lambdaは実行時にSSMから読み、メモリに保持する（`backend/shared/secrets.mjs`）。環境変数には鍵を置かず、関数ごとの対象名だけを `SECRET_PARAMS` で渡す。どの関数がどの鍵を読めるかは `lib/toytalker-stack.ts` の `secrets`
- 鍵を入れ替えるときはSSMを変えるだけ。稼働中のLambdaは5分を過ぎた次の呼び出しで取り直す（deploy不要）
- 鍵を発行元で作り直す手順（値は書かない）は [docs/security-review-2026-10-25.md](../docs/security-review-2026-10-25.md) の「鍵の再発行手順」
- Lambdaに鍵を新しく使わせるとき: `lib/secrets.ts` に名前を足し、その関数の `secrets` に加え、コードでは `secret("名前")` で読む
- **例外は外部IdP（ロードマップ4）の秘密2件**（Google のクライアントシークレット、Apple の秘密鍵。`lib/secrets.ts` の `IDP_SECRETS`）。Cognito の IdP は deploy 時に値が要り、CloudFormation の `ssm-secure` が Cognito に対応していないので Secrets Manager（`toytalker/google-oauth-client-secret`、`toytalker/apple-signin-private-key`）に置き、`{{resolve:secretsmanager}}` で読む。登録手順は [docs/auth.md](../docs/auth.md)。`stages.ts` の `auth.google` / `auth.apple` が無い環境では参照しない
- 環境変数方式の環境を移すときだけ2段階でdeployする（コードと設定の更新が別々に行われ、その間に鍵が読めなくなるのを避ける）: `npx cdk deploy --context stage=<stage> --context keepEnvSecrets=true` → ログの `[secrets] loaded n/n from SSM` と動作を確認 → フラグ無しで `npx cdk deploy`。新しく作る環境は最初からフラグ無し

## Lambdaログの見方（2026-10-28、ロードマップ9）

会話経路のLambda（本文2本・相槌2本・Soniox鍵発行・読み上げ）は、1リクエストにつき1行のJSONを出す（`backend/shared/trace.mjs`）。**会話の文章（発話・返答・検索語・相槌）はログに無い。** 正本は `chat-logs` テーブル。新しいログを足すときも文章を入れない。月次Lambdaは `[Pricing] missing price for <key>` の文字列を拾うので、この警告の形だけは変えない。

| 項目 | 意味 |
|---|---|
| `kind` | `turn`（本文）/ `backchannel`（相槌）/ `stt-token`（Soniox鍵発行とOTA判定）/ `read-aloud`（読み上げ） |
| `request_id` `session_id` `device_id` `owner_id` | 識別子。`request_id` はLambdaの requestId（`REPORT` 行と同じ値） |
| `source` `fw` `app_version` `ua` | 出どころ。`source` は `esp` / `app`。`fw` はESP32が本文に添えるファーム版（v0.7.3以降）、`app_version` はアプリ版（`app/lib/appVersion.ts`。次の配布以降）。古い版からの要求は null。**送信元IPは書かない**（個人に結びつく。2026-10-28決定） |
| `edge` `country` | 経路（2026-10-29）。`cloudfront` = 固定ドメイン経由で、`country` に `CloudFront-Viewer-Country` の国コード（JP など）。`direct` = Function URL を直接呼ぶ旧ファーム・旧アプリで、`country` は null。`direct` が無くなったら Function URL を IAM 認証にする（下の「固定ドメイン」） |
| `llm` `tts` `voice` `character_id` `has_personality` | 使った設定 |
| `marks` | 段階の経過時刻（リクエスト開始からのms）。本文は `secrets`（SSM鍵）→ `config`（DynamoDB）→ `llm_start` → `llm_first_token` →（検索時 `tool_call` → `llm2_start` → `llm2_first_token`）→ `llm_done` → `done_sent` → `usage_saved` |
| `ext` | 外部サービス呼び出し。`service`（gemini / openai / anthropic / brave / soniox / cartesia …）、`status`、`ms`（応答ヘッダが返るまで）、`at`（開始時刻）。TTSは失敗したときだけ載る |
| `segments` | 本文のTTS 1文ごと。`text_at`（LLMから文が揃った時刻）、`tts_ms`、`first_chunk_ms`（ZakiCorpのストリーミングだけ）、`bytes`、`trim_ms`（無音を削った量）、`sent_at`（音声を書き終えた時刻）、`attempts`、`fallback`、`error` |
| `errors` | `where`、`status`、`message`（160字まで。外部サービスのエラー本文に入力文が混ざることがあるため短く切る） |
| `total_ms` `container_age_s` | 合計と、容器が起きてからの秒数（小さければコールドスタート直後） |

Logs Insights の例。遅かったターンを探す:

```
fields @timestamp, session_id, device_id, fw, llm, tts, total_ms, marks.llm_first_token, marks.llm_done, segments_count
| filter kind = "turn" and total_ms > 8000
| sort @timestamp desc
```

音声が途切れた箇所の切り分け: `segments` の `sent_at` の間隔が空いた文を見つけ、その文の `sent_at - text_at` が大きければTTS側、前の文との `text_at` の差が大きければLLM側（`marks.tool_call` があれば検索待ち）、`ext` に 429 / 5xx があれば外部サービス側。相槌は `marks.llm_done` と `marks.tts_done` の差で見る。

## 固定ドメイン（CloudFront、ロードマップ3）

`config/stages.ts` の `apiDomain`（RnD は `api-rnd.zakicorp.com`）を CloudFront の別名にし、Function URL 7本を1つのドメインの経路に束ねる（`lib/toytalker-stack.ts` の `createApiDistribution`、各 Lambda の `url.route`）。目的は URL の固定（Function URL のホスト名はスタックを作り直すと変わる）、WAF のレート制限（費用燃やしの天井）、国コードのログ。キャッシュはしない。ストリーミング応答はそのまま通る。

| 経路 | Lambda |
|---|---|
| `/chat-app` `/chat-mcu` | 本文（App / ESP32） |
| `/backchannel-app` `/backchannel-mcu` | 相槌 |
| `/stt-token` | Soniox 一時キー発行（OTA 判定も） |
| `/read-aloud-app` | 読み上げ |
| それ以外（`/devices` `/characters` `/voices` `/llms` `/logs/*` `/usage*` `/custom-voices*`） | 設定Lambda（path を自分で振り分ける） |

- **クライアントの約束**: CloudFront → Lambda は OAC の SigV4 署名で渡り、署名が本文のハッシュを含む。GET / HEAD 以外は本文の SHA-256（本文が無ければ空文字列のハッシュ）を `x-amz-content-sha256` ヘッダーで添える。アプリは `app/lib/api.ts` の `apiFetch` / `bodyHashHeader`、ESP32 は `sha256Hex()`。無いと Function URL が IAM 認証のとき 403。
- **段階**: `directFunctionUrls: true`（RnD の今）は Function URL が `NONE` + 公開ポリシーのままで、CloudFront 経由と直接の両方を受ける。配布済みの旧ファーム・旧アプリが直接呼ぶ間はこのまま。Lambda ログの `edge: "direct"` が無くなったら `false` にして deploy すると `AWS_IAM` になり、CloudFront（OAC）だけが呼べる。authType の変更は作り直しにならず、ホスト名も変わらない。新しい環境は最初から `false`。
- **オリジンへ渡すヘッダーは allowList**（`content-type` `accept` `user-agent` `origin` `access-control-request-*` `cloudfront-viewer-country` `x-toytalker-token`。`x-amz-content-sha256` は OAC が扱うので書けない）。Host を渡すと Function URL が受け付けない。`Authorization` は OAC が上書きするので、認証（ロードマップ4）のトークンは `x-toytalker-token`（[docs/auth.md](../docs/auth.md)）。
- **WAF は本番だけ**（`apiRateLimitPer5Min` のある環境。RnD は省略、理由は [docs/deferred-items.md](../docs/deferred-items.md)）: 送信元 IP ごとに 5分で 300 件を超えると 403。サンプル要求の保存とログは切る（IP を残さない）。件数は us-east-1 の CloudWatch `AWS/WAFV2` の `BlockedRequests`。費用は WebACL $5 + ルール $1 + 100万要求あたり $0.60（月約 $6）。CloudFront と ACM は無料枠内。
- **応答待ちは 60 秒**（最初の1バイトまで、および途中のパケット間隔）。LLM の初回トークンがそれより遅いと 504。
- **アクセスログは取らない**（送信元 IP が入る。cdk-nag の CFR3 を理由付きで受け入れ）。地域制限も掛けない（海外の利用者。CFR1）。

初回の出し方（RnD は 2026-10-29 に実施済み。次の環境でも同じ）:

1. us-east-1 を bootstrap する（cdk.json の無いディレクトリから。「新しい環境の立ち上げ」の 3 と同じ理由）: `npx cdk bootstrap aws://342082316736/us-east-1`
2. `npx cdk deploy --context stage=rnd ToyTalker-rnd-edge`。ACM 証明書の検証で止まるので、`aws acm describe-certificate --region us-east-1 --certificate-arn <arn>` の `ResourceRecord`（CNAME の名前と値）を Cloudflare の `zakicorp.com` ゾーンに **DNS only** で足す。数分で検証が通り deploy が終わる
3. `npx cdk deploy --context stage=rnd ToyTalker-rnd`。出力 `ApiDistributionDomainName`（`d….cloudfront.net`）を、Cloudflare に `CNAME api-rnd → その値`（**DNS only**。Proxied にすると Cloudflare の証明書になり、ESP32 の CA 束と合わない）で足す
4. `curl -s https://api-rnd.zakicorp.com/voices | head -c 200`（設定Lambda）と `curl -s "https://api-rnd.zakicorp.com/stt-token?ttl=60"`（鍵発行）で通ることを確かめる。本文のある POST は `x-amz-content-sha256` 付きで
5. アプリ（EAS ビルド）と試験機（ファーム 0.7.4 を beta に発行して OTA）を切り替え、実機で会話・相槌・読み上げ・設定画面を確かめる。Lambda ログに `edge: "cloudfront"` と `country` が出る

## 利用者認証（Cognito、ロードマップ4）

状態・仕組み・各社側の設定・確認の仕方は [docs/auth.md](../docs/auth.md)。CDK は `lib/toytalker-stack.ts` の `createAuth`（ユーザープール `toytalker-auth-<環境>`、managed login、アプリ用クライアント、外部IdP）と `createApiAlarms`（401/403・呼び出し数・エラー数のアラーム → 月次レポートと同じ SNS）。環境ごとの設定は `config/stages.ts` の `auth`。deploy の出力 `UserPoolId` / `UserPoolClientId` / `AuthDomain` をアプリ（`app/lib/auth.ts`）と各社側の設定に使う。

## バックアップと復元（AWS Backup、ロードマップ10）

`config/stages.ts` の `backup: { retentionDays }` がある環境に、保管庫 `toytalker-backup-<環境>`（Vault Lock コンプライアンスモード。確定後は誰にも消せない）と日次計画・ロールを作る（`lib/toytalker-stack.ts` の `createImmutableBackup`）。初回 deploy から3日が猶予で、その間にバックアップの成功と復元を確かめる。復元の手順と鍵の再発行手順は [docs/security-review-2026-10-25.md](../docs/security-review-2026-10-25.md) の「消されても戻せる仕組み」。

```bash
aws backup list-backup-jobs --by-backup-vault-name toytalker-backup-rnd --query "BackupJobs[].[CreationDate,ResourceType,ResourceName,State]" --output table
aws backup describe-backup-vault --backup-vault-name toytalker-backup-rnd   # Locked / LockDate / NumberOfRecoveryPoints
```

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
