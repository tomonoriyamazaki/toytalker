# 命名規則

ToyTalkerで人が付ける名前の規則。AWS資源は2026-10-12決定（根拠は末尾）。既存のRnD資源は改名まで旧名のままで、新旧対応表と改名の影響・順番は [複数アカウント計画](multi-account-iac-plan.md) の「命名」節。新しい種類の名前を決めたらここに足す。

## AWS資源

**`toytalker-<機能>-<環境>`**。小文字とハイフンだけ。

- 環境は `rnd` / `stg` / `prd` / `prd-dg`（3文字で揃える。`prd-dg` はDG向け本番）。環境＝アカウントなので、環境名は人が読むための印で、一覧の並びや IAM の前方一致には使わない。
- 機能名は何語でもよい（`read-aloud-app`、`api-unit-prices`）。名前を機械的に分解する箇所は作らない。
- 種類の接尾辞（`-lambda` `-table` `-bucket`）は付けない。ARN・ロググループ・コンソールが種類を示す。
- Lambdaのうち、同じ機能でスマホ向け・ESP32向けの2本があるものは `-app` / `-mcu` を機能名の末尾に付ける（`mcu` は `devices/mcu/` に合わせた名前で、基板が変わっても持つ）。両方から使うものには付けない。
- 固定名を使う（CDKの生成名にしない）。コンソールやログで名前を読む運用のため。ただしコードには名前を書かず、CDKが環境変数で渡す。
- 実装は `infra/lib/toytalker-stack.ts` の `resolveNames()`（Lambda）と `fixed`（SNS・温めルール・Scheduler）。各Lambdaは機能名 `key` と旧名 `legacy` を持ち、`stages.ts` の `legacyNames`（RnDだけ true）で切り替える。スタック名は `stages.ts` の `stackName()`。STGは2026-10-16にこの規則で合成を確認した

| 種類 | 例 |
|---|---|
| Lambda | `toytalker-chat-app-stg`、`toytalker-chat-mcu-stg`、`toytalker-backchannel-app-stg`、`toytalker-stt-token-stg`、`toytalker-settings-app-stg`、`toytalker-read-aloud-app-stg`、`toytalker-ops-monthly-stg` |
| DynamoDB | `toytalker-devices-stg`、`toytalker-chat-logs-stg`、`toytalker-api-unit-prices-stg` |
| S3 | `toytalker-tts-speakers-stg`、`toytalker-firmware-stg` |
| SNS・EventBridge・Scheduler | `toytalker-ops-monthly-stg`、`toytalker-warmer-stg` |
| ロググループ | `/aws/lambda/<関数名>`（関数名に追従） |
| CloudFormationスタック | `toytalker-stg` |
| IAMロール | 名前を付けない（CDKがスタック名を先頭に生成する） |
| CDKの部品ID | PascalCaseで機能名のみ: `ChatApp`、`ChatMcu`、`SttToken`、`SettingsApp`、`ReadAloudApp`、`DevicesTable`。環境名は含めない（スタック名が持つ） |

### タグ

全資源に2つ。CDKの `Tags.of(stack).add()` で付ける。キーは小文字。

| キー | 値 |
|---|---|
| `project` | `toytalker` |
| `environment` | `rnd` / `stg` / `prd` / `prd-dg` |

### SSM Parameter Store

**`/toytalker/<用途>-<種類>`**。小文字とハイフン。環境名は付けない（アカウントごとに同じ名前で中身だけ違う）。例: `/toytalker/openai-api-key`、`/toytalker/zakicorp-edge-key`、`/toytalker/openai-admin-key`。正本は `infra/lib/secrets.ts`。

### AWSアカウント

組織上の名前・主メール・CLIプロファイル名を同じ語で揃える。一覧は [複数アカウント計画](multi-account-iac-plan.md) の「アカウント一覧」。

| 項目 | 規則 | 例 |
|---|---|---|
| 組織上の名前 | ToyTalkerの環境は `toytalker-<環境>`。環境は資源名と同じ `stg` / `prd` / `prd-dg`。ToyTalker以外の検証用は `sandbox-<番号>`。管理アカウントは `management`（他プロジェクトの資源も持ち、ToyTalkerのRnDはここに同居する。RnDであることは `stages.ts` の `rnd` とタグが示す） | `toytalker-stg`、`sandbox-1`、`management` |
| 主メール | `exodjp+<組織上の名前>@gmail.com`（gmailのプラスアドレス。受信箱は1つで、アカウントごとに別アドレスという要件を満たす）。管理アカウント（RnD）だけは既存の `exodjp@gmail.com` のまま | `exodjp+toytalker-stg@gmail.com` |
| CLIプロファイル名 | 組織上の名前と同じ。Identity Center（SSO）のプロファイルで、アクセスキーは作らない。管理アカウントは当面 `default`（IAMユーザーのアクセスキー）も残る | `--profile toytalker-stg` |
| `stages.ts` の環境名 | `<環境>` の部分と同じ（`rnd` / `stg` / `prd` / `prd-dg`） | `--context stage=stg` |

人の名前（`Tomonori Yamazaki`）は組織上のアカウント名に使わない。3アカウントが同名で区別できなかったため（2026-10-13）。

### IAM Identity Center

| 項目 | 規則 | 例 |
|---|---|---|
| ユーザー名 | 姓のローマ字小文字。作成後は変えられないので、接尾辞（`-sso` など）を付けない。表示名はフルネーム、メールは本人の受信できるアドレス | `yamazaki` |
| グループ | 役割の複数形、小文字（グループは人の集まりなので複数形。AWSの例も `Administrators`） | `admins` |
| 権限セット | AWS管理ポリシー1つを包むならそのポリシー名。独自に作るなら kebab-case の役割名。中身の無い権限セットは残さない | `AdministratorAccess`、`ReadOnlyAccess` |

2026-10-15時点の実体: ユーザー `yamazaki`（gmail）1人、グループ `admins`（`yamazaki` が所属）、権限セット `AdministratorAccess`（セッション8時間）が4アカウント全部へ `admins` に割り当て済み。

### 固定ドメイン

**`api-<環境>.zakicorp.com`**（2026-10-29決定。`api-rnd` `api-stg` `api-prd` `api-prd-dg`）。正本は `infra/config/stages.ts` の `apiDomain`。CloudFront の別名で、DNS は Cloudflare の CNAME（DNS only）。本番の名前を短くしたくなったら7で見直す。

## DynamoDB のキー名・属性名

snake_case。複合キーは `#` で連結する（`owner_id#device_id`、`session_id#timestamp`、`date#device_id#api_type`、`provider#api_type`）。変えない（2026-10-12決定。データ移行とコード全面修正が入り、環境名を付ける目的とは無関係）。

## リポジトリ

| 対象 | 規則 | 例 |
|---|---|---|
| `backend/` のLambdaディレクトリ | 機能名のみ（`backend/<機能>`）。環境名・`-lambda` は付けない。RnDの改名と同時に直し、それまでは旧名 | `backend/chat-app`、`backend/stt-token` |
| Lambda環境変数 | UPPER_SNAKE_CASE | `ZAKICORP_TTS_URL`、`SECRET_PARAMS` |
| ESP32ファームのgitタグ | `fw-<版>`。`publish-firmware.sh` が発行成功時に付ける | `fw-0.7.2` |
| OTAチャンネル | `stable` / `beta`。`toytalker-devices.fw_channel` の値 | |
| S3のファーム配置 | `esp32s3/<版>/toytalker_mini.bin`、`esp32s3/manifest.json` | |
| 作業ブランチとworktree | `.claude/worktrees/<name>`、ブランチ名も `<name>` | `naming` |
| 調査メモ | `docs/<領域>-<内容>.md`。領域ごとの入口1本に統合し、日付付きの個別メモは統合後に消す | `docs/esp32-v07-aec.md` |

## 根拠（AWS資源、2026-10-12）

- AWSに公式の命名規約は無い。タグ付けホワイトペーパーは「名前に構造を持たせることはできるが、名前に入る情報は限られる」とし、環境や用途はタグで持たせる立場。
- AWS公式ブログの例は `[project]-[application]-[environment]-名前` で、環境を最後ではなく自由名の前に置く。複数環境を1アカウントに同居させIAMの前方一致で絞る前提で、環境＝アカウントの今の構成には当たらない。環境値の例は `dev / stg / prd`。
- 公式例に種類の接尾辞は出てこない。Terraform向けの公式ガイドにも「資源の種類を名前で繰り返さない」とある。
- CDKのベストプラクティスは「固定名を付けず生成名を使う」。RnDの既存資源のimportに固定名が要ったこと、名前を読む運用であることから固定名を維持した。「テーブル名はコードに書かず環境変数で渡す」はCDKの勧めと同じ。
- タグの組織名接頭辞（`anycompany:environment-type` 形式）は、他ツールのタグと紛れる環境向けなので付けない。

出典: [Best Practices for Tagging AWS Resources](https://docs.aws.amazon.com/whitepapers/latest/tagging-best-practices/tagging-best-practices.html)、[Tagging best practices - Tag Editor](https://docs.aws.amazon.com/tag-editor/latest/userguide/best-practices-and-strats.html)、[Working backward: From IAM policies and principal tags to standardized names and tags](https://aws.amazon.com/blogs/security/working-backward-from-iam-policies-and-principal-tags-to-standardized-names-and-tags-for-your-aws-resources/)、[AWS CDK best practices](https://docs.aws.amazon.com/cdk/v2/guide/best-practices.html)、[Terraform best practices (AWS Prescriptive Guidance)](https://docs.aws.amazon.com/prescriptive-guidance/latest/terraform-aws-provider-best-practices/structure.html)
