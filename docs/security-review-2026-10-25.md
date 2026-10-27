# セキュリティ見直し（2026-10-25）

認証（ロードマップ4）に着手する前に、公開している入口とアカウント運用を棚卸しした記録。セキュリティの現状と残りの対策はこの文書が入口。済んだ項目は「済（日付）」にし、新しい発見はここに追記する。

## きっかけ

2026年10月に脆弱性の報道が重なった（PHP2Shell、Node.js Brotli CVE-2026-111497、Microsoft月例更新のCVE初の4桁、AIによる脆弱性発見の加速）。ToyTalkerへの直接の影響は無い（PHPは不使用、LambdaのNode 24は管理ランタイムで更新モードAuto、TTS PCのWindowsは自動更新）。本質は「公開している入口はいずれ機械的に叩かれる」と考えて設計を正すこと。

## 確認した結果

### 守れているもの

- ルートMFAあり、ルートのアクセスキー無し。子アカウントはルート資格情報なし（ルートアクセスの集中管理）。
- 鍵はSSM SecureStringにあり、Lambda環境変数に無い。
- S3 2バケットは公開ブロック。Lambdaロールは関数ごとの最小権限。DynamoDBは削除保護あり。
- 単価テーブル（`api-unit-prices`）と為替はAPIから書けない。AWS資格情報が無いと変えられない。
- ローカルTTSはCloudflare WAFで `X-Zakicorp-Edge-Key` 必須。
- AWS側の月額は約$3.3で、予算アラート（$5 / $10、月次）は妥当。**LLM・TTSなど外部APIの費用はAWS予算の外**なので、費用燃やし攻撃の検知は各社のダッシュボードか `toytalker-usage` の集計に頼る。

### 問題（深刻な順）

1. **デバイスの乗っ取り。** `POST /devices` は既存の `device_id` を再登録すると `owner_id` を上書きする。`PUT /devices/{id}` は所有者を確認しない。ESP32の `device_id` はBLEのMACアドレスで、推測の余地がある。乗っ取られると、キャラクター・相槌・ファーム版指定（`fw_target`。自分のS3の署名付きURLとSHA検証の範囲内）を変えられ、**以後の会話ログが乗っ取った側の `owner_id` で記録されて読める**。キャラクターとカスタムボイスの更新・削除も「システム製でないこと」しか見ていない。
2. **会話ログの閲覧はクライアントの `owner_id` を信用している。** ESP32のログは、登録済みデバイスならデバイス行の `owner_id`（アプリ側のランダムUUID）で記録されるので、MACだけでは読めない（当初「MACだけで読める」と評価したが誤り。未登録デバイスのログだけMACが鍵になる）。守りはUUIDが推測できないことだけで、1の乗っ取りと組み合わさると破れる。
3. **費用を燃やされる経路。** 本文・相槌・読み上げ・Soniox一時鍵発行の全部が無認証・無制限。Function URLにはWAFもレート制限も付けられない。
4. **AWS資格情報の運用。** RnDアカウントにIAMユーザー3人分と長期アクセスキー3本が有効。`codecommit`（2020年作成、未使用、CodeCommitの残骸。同名リポジトリが1つ残る）、`yamazaki-3tyd`（2024年にS3を1回使ったきりのAdministrator）、`zackey`（CLIで使用中のAdministrator）。Identity Centerを整えたのにCLIは長期鍵のまま。「料金表やデバイス情報が入れ替わる」最大の経路はAPIでなくここ。
5. **復旧と検知の手段がない。** DynamoDBのPITRが全テーブルで無効。CloudTrailのトレイルが無く90日の履歴のみ。GuardDuty無効。
6. Lambda 3本の依存に修正版のある高リスク脆弱性（`undici` 8.x の応答非同期化、`fast-xml-parser` の実体展開上限回避）。

## 対策と時期

| 時期 | 対策 | 性質 | 状態 |
|---|---|---|---|
| 今すぐ | 全テーブルにPITR（CDK） | 根治 | 済（2026-10-25、8テーブルENABLED） |
| 今すぐ | Lambda 3本の依存更新（`npm audit fix`、package.jsonの範囲内） | 根治 | 済（2026-10-25、RnDへdeploy。温め・会話で正常） |
| 今すぐ | CloudTrail組織トレイル（スタック `toytalker-org`、バケット `toytalker-cloudtrail-org`、管理アカウントに1本） | 根治 | 済（2026-10-25。信頼されたアクセス有効化→deploy、Logging: true） |
| 今すぐ | CLIをSSOへ移し、長期鍵3本とIAMユーザー `codecommit` `yamazaki-3tyd` を削除。`codecommit` リポジトリは中身確認後に削除 | 根治 | 済（2026-10-25）。残るIAMユーザーは `zackey` のみ（鍵なし、パスワード+パスキー2本、**緊急用のコンソール入口として残す**） |
| 認証と一体（4） | Lambdaがトークンの本人を使う。デバイス・キャラ・ボイス・ログの所有者確認。再登録での `owner_id` 上書き禁止 | 根治 | 未。設計は [先送り項目](deferred-items.md) の「ユーザー認証」 |
| 固定ドメインと一体（3） | CloudFront + WAFでレート制限・地域制限 | 根治 | 未。ゲスト会話を残す限り認証では防げない |
| 認証後 | デバイス登録をログイン必須に | 根治 | 未 |
| 保留 | GuardDuty（月数百円〜）。他人が入る本番で再検討 | — | 保留 |
| 今すぐ | **v1残骸の削除**（無認証のAPI Gateway `toytalk-chat-apigateway-dev` → Python Lambda 2本。環境変数にOpenAI鍵、ロールはS3/DynamoDB/LambdaのFullAccess。30日間呼び出しゼロ）。削除後、その鍵がSSMの鍵と同じならOpenAI側で作り直す | 根治 | **済（2026-10-26）**。API Gateway、Lambda 2本、ロール `toytalk-lambda-role-dev`、ロググループ3つ（孤立の `toytalk-stream-handler-for-esp32-lambda` 分を含む）を削除。コードは `backend/*.py` に残る。最終ログは2025-08で、1年以上未使用だった。OpenAI鍵の同一性確認は未（ダッシュボードで判断） |
| 今すぐ | CDK修正のdeploy: S3 `toytalker-tts-speakers` とSNSのTLS強制、設定Lambdaの書き込み権限を devices/characters/voices に縮小、Soniox LambdaはdevicesのUpdateItemだけ | 根治 | **済（2026-10-26 deploy）**。差分はIAM 2本の縮小とポリシー2つの追加だけ、Replaceなし、32秒 |
| 今すぐ | 無料のアカウント設定: セキュリティ連絡先（Account.1）、IAMパスワードポリシー（IAM.7） | 根治 | 未。説明→OKで実施 |
| 今すぐ | GitHubのDependabot alerts / security updates を有効化（`.github/dependabot.yml` は追加済み） | 根治 | 未。リポジトリ設定はユーザー |
| 決める | Lambdaの同時実行上限（費用燃やしの天井。`reservedConcurrentExecutions`）とInvocations/Durationのアラーム | 痛み止め | 未。上限値を決める（下の「IaC点検」） |
| 決める | Lambdaログの保持期間（いまは無期限。会話の文字起こしがログに残る） | 根治 | 未 |
| 9で | `toytalker-firmware` のTLS強制（CDK管理外。取り込みと同時に） | 根治 | 未 |
| 本番で | DynamoDB・CloudTrail・SNS・ログのCMK暗号化（[複数アカウント計画](multi-account-iac-plan.md) の決定どおり）、CloudTrailのCloudWatch Logs連携、Config + Security Hub | 根治 | 本番アカウントで |

「再登録で `owner_id` を上書き」は、端末のリセットや機種変更での正当な再ペアリングも同じ経路なので、本人確認の無い今は塞げない。認証で本人が分かってから直す。

## SSOへの切替と鍵の削除（2026-10-25に実施済み。再現用の手順）

1. Identity Centerのユーザー `yamazaki` のパスワードを設定する（入口 `https://d-95671d6109.awsapps.com/start` の「パスワードを忘れた」→ gmail → MFA登録）。
2. `aws configure sso` でプロファイルを作る（入口URL、`ap-northeast-1`、アカウント 342082316736、権限セット `AdministratorAccess`）。`aws sso login --profile <名前>` → `aws sts get-caller-identity --profile <名前>` で確認。
3. `AWS_PROFILE` を環境変数に置き、`cdk diff --context stage=rnd` が通ることを確認する。
4. 削除の順: `codecommit` のリポジトリ確認 → ユーザー `codecommit`（鍵・Git資格情報・ユーザー）→ ユーザー `yamazaki-3tyd`（鍵・ユーザー）→ 最後に `zackey` の鍵。各削除は説明→OK。

実施結果（2026-10-25）:
- Identity Center: MFAは「サインインごと」「セキュリティキーと内蔵認証のみ」「未登録なら登録必須」。`yamazaki` にパスキー2本（Windows Hello、iPhone）。アクセスポータルの別名は `zackey.awsapps.com`（`d-95671d6109` と同じ）。
- CLI: `~/.aws/config` に `[sso-session toytalker]` と `[profile toytalker-rnd]`。`[default]` も同じSSOに向けたので、`AWS_PROFILE` 無しでSSOになる。`~/.aws/credentials` は空。期限（8時間）が切れたら `aws sso login`。
- 削除済み: ユーザー `codecommit`（鍵・Git資格情報・ポリシー）とリポジトリ `codecommit`（2020年のreadmeのみ）、ユーザー `yamazaki-3tyd`（鍵・パスワード・MFA・ポリシー）、`zackey` のアクセスキー。
- `zackey` は残す。パスワード+パスキー2本でコンソールのみ。Identity Centerに入れなくなったときの、ルートを使わない予備口。
- アクセスポータルの Active sessions にCLIのログインは行として出なかった。CLIの痕跡はCloudTrailの `CreateToken` / `GetRoleCredentials`（イベントソース `sso.amazonaws.com`）。

## 認証フェーズへ渡す所有者確認の一覧

`backend/toytalker-device-setting-lambda/index.mjs`:

- `POST /devices`: 既存行の `owner_id` と本人が違えば403（新規登録は本人を書く）。
- `PUT /devices/{id}` / `DELETE /devices/{id}` / `GET /devices/{id}`: 行の `owner_id` と本人の一致。
- `PUT|DELETE /characters/{id}`、`PUT|DELETE /custom-voices/{id}`: 行の `owner_id` と本人の一致（システム製は従来どおり拒否）。
- `GET /logs/*` / `GET /usage*` / `GET /devices` / `GET /characters` / `GET /custom-voices`: クエリの `owner_id` を捨て、本人IDを使う。

本文・読み上げ・相槌Lambda: `owner_id` を本文から受け取っている箇所を本人IDへ。ESP32経由はデバイス行の `owner_id` を使う現在の方式を維持。

## IaC化した設定の点検（2026-10-25、2回目）

上の棚卸しの後、CDKのコードと合成したテンプレート、稼働中の設定を機械的に照合した。使ったもの: cdk-nag 3.0.2（AwsSolutions + Serverless）、checkov 3.3.30（テンプレート）、AWS CLIの読み取り、IAM Access Analyzer、Prowler 5.45（Security Hub FSBP基準）。設定変更はしていない。

### 1. CDKの静的点検（cdk-nag）

`cd infra && npx cdk synth --context stage=rnd --context nag=true` で動く（`bin/toytalker.ts`）。指摘はエラーになり synth が止まるので、**deploy前にこれが通ることを確認する**。初回は68件。

- **直した**: S3 `toytalker-tts-speakers` の平文HTTP拒否（AwsSolutions-S10）、SNSトピックの平文Publish拒否（SNS3）。
- **読んで見つけて直した（ツールは指摘しない）**: 設定Lambdaが8テーブル全部に書けた。コードが書くのは devices / characters / voices だけなので、単価・為替・LLM一覧・会話ログ・使用量は読み取りだけに縮めた。「単価と為替はAPIから書けない」がIAMでも成り立つ。Soniox Lambdaは devices の UpdateItem だけ（Put/Deleteを外した）。
- **理由を書いて受け入れた**（`lib/toytalker-stack.ts` の `acknowledgeNagFindings`）: `AWSLambdaBasicExecutionRole`（IAM4）、grantRead/grantReadWriteが作るS3動詞のワイルドカードと対象1バケットの `/*`（IAM5）、Schedulerの `:*`（IAM5）、S3アクセスログ（S1）、DLQ・X-Ray・ログ無期限（Serverlessパック）。
- checkovの追加分: CMK暗号化（DynamoDB・ログ・CloudTrail・SNS）は本番で入れる決定どおり。LambdaのVPC配置は不要。**同時実行上限（CKV_AWS_115）は費用燃やしの天井として意味がある**（下の「決めること」）。Function URLの認証なし（CKV_AWS_258）は既知（3で）。

### 2. ベストプラクティス照合（Security Hub FSBP）

Security Hubは有効化せず（Configが前提で費用が出る。本番で）、同じ基準をCLIの読み取りとProwlerで当てた。

| 基準 | 結果 |
|---|---|
| IAM: ルートMFA、ルート鍵なし、長期鍵なし、IAMユーザー1人（鍵なし・パスキー2本） | 合格 |
| DynamoDB: PITR、削除保護、全8テーブル | 合格 |
| S3: バケット単位の公開ブロック・既定暗号化・バージョニング（3バケット） | 合格 |
| CloudTrail: 組織・全リージョン・ログ検証・配信中 | 合格 |
| Lambda: ランタイム nodejs24.x、更新モードAuto | 合格 |
| **v1残骸**: API Gateway `toytalk-chat-apigateway-dev`（ステージ `dev`）の `POST /chat` と `POST /raspi` が **認証なし** で Python Lambda `toytalk-openai-api-dev` / `toytalk-api-raspi` を呼ぶ。両方の環境変数に `OPENAI_API_SECRET_KEY`、ロール `toytalk-lambda-role-dev` は S3 / DynamoDB / Lambda の FullAccess + KMS PowerUser。30日間の呼び出しはゼロ | **不合格。今の構成で最大の穴**（鍵と全テーブルを握る無認証の入口が、使っていないのに開いている）。9で予定していた削除を前倒しし、**2026-10-26に削除済み** |
| S3.1 アカウント単位の公開ブロック | 未設定。ただし同じアカウントに公開バケット `zackey.xyz`（ToyTalker外）があり、入れるとそれが止まる。ToyTalkerの3バケットはバケット単位で塞いである |
| S3.5 平文HTTP拒否 | `toytalker-cloudtrail-org` のみ合格。`toytalker-tts-speakers` はCDKで直した（deploy待ち）。`toytalker-firmware` はCDK外（9で） |
| Account.1 セキュリティ連絡先 | 未登録 |
| IAM.7 パスワードポリシー | 未設定（ユーザーはパスキー運用の1人だけ） |
| Config.1 / GuardDuty.1 / Security Hub | 無効（費用。本番で） |
| CloudTrail.2 KMS暗号化、CloudTrail.5 CloudWatch Logs連携、CloudTrail.7 / S3.9 アクセスログ | 未（本番で） |
| Lambda.1 公開ポリシー（Function URL 7本） | 既知。CloudFront + WAF（3）と認証（4）で扱う。Access Analyzerの「公開」指摘もこの7本と `zackey.xyz`、Identity Centerのロール（正常） |
| 検知: CloudWatchアラームなし、同時実行は既定の1000を共有、予算 $5 / $10 のみ | 費用燃やし（問題3）の天井が無い |

Prowler（`prowler aws -f ap-northeast-1 us-east-1 --compliance aws_foundational_security_best_practices_aws`、読み取りのみ）の結果: 154基準中、合格のみ34、不合格あり39（残りは対象資源なし）。ToyTalker資源の不合格は上の表と同じ（Lambda.1、S3.5、S3.17、CloudTrail.2/5/7、SNS.1、DynamoDB.4=AWS Backupの計画なし。PITRで足りるので保留）。それ以外は **ToyTalker外の残骸**で、9の削除候補に足す: S3 `abc-test-342082316736` と `-modify-s3policy`（公開ブロックなし）、`toytalk.zakicorp.com`、`aws-athena-query-results-*`、ECSタスク定義 `a`、ECRリポジトリ `test`、SNS `test` / `ABC-topic-yamazaki`、Lambda `lambda-mail`（python3.8）/ `test`（python3.8）/ `ABC-modify-s3-policy-lambda`、API Gateway `api-mail`、KMS CMK 2本（ローテーションなし）、CloudFront 1本（`zackey.xyz` 向けと思われる。ログ・WAFなし）。IAM.1（`AdministratorAccess`）はIdentity Centerの権限セットで想定どおり。

### 3. 依存の脆弱性を継続的に見る仕組み

**要る。** 理由: Lambdaは `npm ci` した依存をesbuildでバンドルして配るので、依存の修正版が出ても誰かが気づいて deploy しない限り本番に入らない。今回の `undici` / `fast-xml-parser` は報道で気づいた。

- リポジトリは **公開**（`github.com/tomonoriyamazaki/toytalker`）なので Dependabot は無料。現状は secret scanning と push protection が有効、**Dependabot alerts / security updates は無効**。
- `.github/dependabot.yml` を追加した。対象は `infra/`、lockfileのあるLambda 5本、`app/`。週1回、**セキュリティ修正だけ**を1本のPRにまとめる（版上げPRは作らない）。
- 残りはリポジトリ設定（Settings → Code security → Dependabot alerts と security updates をON）。ユーザーの操作。
- 補足: 2026-10-25時点で Lambda 5本の `npm audit --omit=dev` は0件。`infra/` の `brace-expansion`（high、aws-cdk-lib配下）は `npm audit fix` で解消。Lambdaランタイムは管理ランタイムで自動更新。アプリ（React Native）の依存もDependabotの対象に入れたが、修正の反映は審査・配布の都合で別途。

### 次のセッション: 脅威モデルを作る（2026-10-27に合意）

目的は「本気で侵入しようとされても大丈夫」を、チェックリストでなく「誰が・何を狙って・どこから入り・入られると何が起きるか」の表で定義し、守りの順番を決めること。cdk-nag を全部直しても安全にはならない（侵入に関係する指摘は Function URL 公開の1件だけで、それは認証の設計そのもの）。

作るもの: この文書の先頭に置く表。叩き台:

| 誰が | 狙い | 入口 | 入られると | 今の守り | 足りないもの |
|---|---|---|---|---|---|
| ファームやアプリを解析した人 | 自分の費用で LLM/TTS を使う | Function URL 7本（認証なし。URLはESP32・アプリに直書き） | 請求が膨らむ | なし | 認証（ロードマップ4）、CloudFront+WAF のレート制限（3）、同時実行上限（8(e)） |
| 同上 | 他人の設定を見る・変える | 設定 Lambda の URL + デバイスID | プライバシー侵害 | デバイスIDを知らないと無理、だけ | 認証（本人の物だけ触れる） |
| 改ざんしたアプリ・ファーム | 上限を無視して使う | 同上 | 費用・他人の設定 | なし | クライアントを信用しない設計: 身元ごとのサーバー側上限（前払いポイント） |
| PCやSSOを乗っ取った人 | AWS を自由に使う | SSO セッション（AdministratorAccess） | 全部 | MFA、長期鍵なし、CloudTrail | 侵入検知（GuardDuty、月数百円）、読み取り専用の権限セット、不変バックアップ（10） |
| 悪意ある npm パッケージ | 鍵を盗む | Lambda の依存 | 鍵流出 | npm audit 0件、Dependabot 設定 | Dependabot の ON（ユーザー操作） |
| 偽ファームを配る人 | 機器を乗っ取る | OTA | 機器が勝手に動く | SHA 検証（未検証） | 検証試験（6） |
| 騙された Claude（プロンプトインジェクション） | 消す・壊す | 承認ダイアログ | データ消失 | ask、削除保護、PITR | 不変バックアップ（10）、承認ダイアログを読む習慣 |

ファーム側の認証の方針（4の設計に入れる）: 製造時に一台ごとの鍵を NVS に焼き、サーバーはハッシュだけを devices に持つ。毎リクエストでデバイスIDと鍵（または鍵で署名したタイムスタンプ）を送り、Lambda が先頭で照合。持ち主との紐づけはアプリで箱のコード/QRを読んで Cognito ユーザーと結ぶ。漏れたら devices の1行を無効にしてその1台だけ止める。証明書（AWS IoT 方式）はファーム変更が大きいので後回し。

CloudFront の位置づけ: 「壁」であって「鍵」ではない。Function URL を IAM 認証にして CloudFront だけが呼べるようにし、WAF でレート制限と国制限、ドメイン固定で再作成に強くする。誰が呼んでいるかは分からないので、認証と両方要る。

### 決めること

- **同時実行上限**（痛み止め）: 会話Lambda 2本・相槌2本・読み上げ・Soniox鍵発行に `reservedConcurrentExecutions` を置くと、費用燃やしの天井ができる（例: 会話20、相槌20、他10）。超えた分は429になるので、実利用の同時数（いまは1人）に余裕を見て決める。Invocations / Duration のアラーム（SNSでメール）も同時に。
- **ログ保持期間**: Lambdaログは無期限。会話の文字起こしが含まれるので、期限（例: 13か月。月次レポートは当月分しか読まない）を決めて `retention` を変える。
- **アカウント単位の公開ブロック**: `zackey.xyz` をこのアカウントから出すか、公開のまま残すか。

### 観察（原因未確定）

2026-10-26/27 も同じ事象。`export-credentials` の回避策で毎回通った。リモートからのログインは `aws sso login --use-device-code --no-browser` でコードを出し、手元の端末で承認する（通常方式はこのPCのブラウザに戻るので完了できない。コードは10分で失効）。

CDKの `synth` / `diff` が `CredentialsProviderError: UnauthorizedException: Session token not found or invalid` で止まった（AWS CLI 2.33.2 の `aws sso login` 直後、CLIの `sts get-caller-identity` は通る状態）。JS SDK（3.1132）が `~/.aws/sso/cache` のトークンを使うときだけ失敗する。回避は `eval "$(aws configure export-credentials --format env)"` を打ってから `cdk` を実行する（CLIが持つロール資格情報を環境変数に出す。8時間）。原因は追っていない（推測: CLI 2.33の `session.db` 方式とJSONキャッシュの食い違い）。
