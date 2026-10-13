# 引き継ぎ: CDK化とRnDの取り込み（2026-09-16作業分、2026-10-13更新）

新しいセッションで複数アカウント展開の続きを始めるための入口。決定の根拠と経過は [複数アカウント計画](multi-account-iac-plan.md)、コードと手順は [infra/README.md](../infra/README.md)。この文書は「今どうなっていて、次に何をするか」だけを持つ。

## 今の状態

- RnDアカウント（342082316736）のToyTalker資源36個は、CloudFormationスタック **`ToyTalker-rnd`** の管理下。ドリフトなし（2026-09-16確認）。
- **Lambdaの反映は `cd infra && npx cdk diff --context stage=rnd` → `npx cdk deploy --context stage=rnd`。** `deploy.sh` / `setup.sh` は削除済み。
- APIキー11件の正本は **SSM Parameter Store `/toytalker/<key>`**（AWS管理キーで暗号化、無料）。**Lambdaが実行時に読んでメモリに保持する**（`backend/shared/secrets.mjs`。2026-10-06に2段階deployで切替、環境変数から鍵を外した。アプリ・ESP32で実機確認済み）。環境変数にはどの鍵を読むかの名前 `SECRET_PARAMS` だけがある。鍵を替えるときはSSMを変えるだけ（5分以内に反映）。手順は infra/README の「秘密」節。
- IAMロールはCDKが関数ごとに作った最小権限のもの（`ToyTalker-rnd-<部品ID>ServiceRole…`）。旧ロールと旧Permissionは削除済み。**`toytalk-lambda-role-dev` だけはv1の旧Lambda 2本が使っているので残している。**
- 動作確認済み: アプリ（会話・読み上げ・設定保存・クローンボイス登録）、ESP32（会話・OTA 0.7.1→0.7.2）。いずれも新ロールで成功。
- Lambda 8本のバンドルは、CDK化前に本番に入っていたコードとバイト単位で一致することを確認した上で引き取った。
- Node 22だった3本はNode 24に統一。ESP32用メインのメモリは2024→2048MB（元の値はタイプミス）。
- **テーブル名はコードに無い**（2026-10-13）。`stages.ts` の `tableSuffix`（RnDは空）をCDKが環境変数 `TABLE_SUFFIX` で配り、`backend/shared/tables.mjs` の `tableName("devices")` が組む。タグ `project` / `environment` も全資源に付けた。STGは `tableSuffix: "-stg"` で最初から新名になる。`stages.ts` の環境名は `rnd` / `stg` / `prd` / `prd-dg`。

## 組織とアカウント（2026-10-13に読み取りで確認）

- **Organizations はすでにある**（`o-lbme8l7xtz`、2019年2月作成、全機能有効、SCP未使用）。**管理アカウント = RnD（342082316736、exodjp@gmail.com）。**
- 子アカウント2つ（2019年に招待で参加、2026年7〜9月の費用は $0、中身は未確認）: 586464890779（主メール exodjp@nifty.com、**このメールは解約済みで受信できない**）、499135248182（主メール exodjp@yahoo.co.jp、受信可）。
- **IAM Identity Center は2021年から有効**（インスタンス `ssoins-7758a71eeb88ba75`、ID store `d-95671d6109`、入口 `https://d-95671d6109.awsapps.com/start`）。ユーザー3人（gmail `yamazaki-3tyd-sso`、yahoo `yamazaki-3tyd-sso2`、以前の勤務先メール `yamazaki`）。グループ `test-group`（gmailとyahooのユーザーが所属）に権限セット `AdministratorAccess` が3アカウント全部へ割り当て済み。権限セット `dev` はyahooのアカウントだけ。
- 有効化済みの信頼されたアクセス: `access-analyzer`、`sso`。Account Management（子の主メールを管理アカウントから変える操作に必要）は未有効。

### 決めたこと（2026-10-13）

- **管理アカウントはRnDのままにする。** 教科書は「管理アカウントにワークロードを置かない」だが、作り直すには組織の解散とIdentity Centerの組み直しが要り、1人運用で得るものに見合わない。却下理由は [先送り項目](deferred-items.md)。
- **古い子アカウント2つは閉鎖せず、検証用に残す。** 料金はかからず、gmailのSSOユーザーで管理者として入れる。STG・本番には使わず新規作成する（メールを環境名で揃える、2019年の設定を引き継がない、管理アカウントから入るロールが自動で付く）。
- **子アカウント2つの主メールを gmail のプラスアドレスへ変える**（niftyは通知が届いていないため必須、yahooは揃えるため）。管理アカウントから Account Management の `start-primary-email-update` → 新アドレスに届くコードで `accept-primary-email-update`。事前に信頼されたアクセス `account.amazonaws.com` の有効化が要る。
- **STG以降のアカウントは管理アカウントから `create-account` で作る。** メールは `exodjp+toytalker-stg@gmail.com` の形（環境ごとに別アドレスが要るが受信箱は1つ）。
- **Identity Centerはそのまま使い、ユーザーを整理する**: yahooユーザーと以前の勤務先メールのユーザーを削除し、gmailユーザー1つに全アカウントの `AdministratorAccess` を割り当てる（グループ経由のままでもよい）。
- 上のどれもAWS設定変更なので、実行前に1つずつ説明してOKを得る。

## 決めたこと（2026-09-16）

- 秘密はSecrets Managerでなく **SSM SecureString**（1件$0.40/月が不要。ローテーション・アカウント間共有を使わないため）。
- 鍵はAWS管理キー。**CMKは本番アカウントで入れる**（SSMとLambda環境変数の両方。DG向け本番で他の人が入る時点で効く。1鍵約$1/月）。RnD/STGはAWS管理キーのまま。
- **秘密の実行時取得へ切り替える** → 2026-10-06に完了。詳細は計画メモの同名の節。
- **命名は環境名を付けて統一する** → 2026-10-12に `toytalker-<機能>-<環境>` で決定（[命名規則](naming-conventions.md)）。スタック名・部品ID・固定名の3層を一度に変える。RnDの改名はCloudFront固定ドメインの後、STGは最初から新名。新旧対応は計画メモの「命名」。
- ファーム配布バケット `toytalker-firmware` はCDKの管理外（`fromBucketName` で参照のみ）。名前は `stages.ts` の `firmwareBucketName`。

## 次にやること（順序の案）

1. ~~秘密の実行時取得~~（2026-10-06完了）
2. ~~命名の決定~~（2026-10-12決定）→ ~~テーブル名の環境変数化とタグ~~（2026-10-13 RnDへdeploy済み）
3. **組織の整理 → STGアカウント作成 → `cdk bootstrap` → SSM投入 → `cdk deploy` → マスターデータ投入**。順に: (a) 信頼されたアクセス `account.amazonaws.com` を有効化し、子アカウント2つの主メールをgmailのプラスアドレスへ変更 (b) `create-account` でSTG作成（メール `exodjp+toytalker-stg@gmail.com`）(c) Identity Centerのユーザー整理とSTGへの割り当て (d) `stages.ts` の `stg.account` を埋めて `cdk bootstrap aws://<id>/ap-northeast-1` (e) SSMへ鍵11件を投入（値はユーザー。`scripts/put-secret.ts`）(f) `cdk deploy --context stage=stg` (g) `export-master-data.ts rnd` → `import-master-data.ts stg --from=rnd --yes`。(a)〜(c)の背景は上の「組織とアカウント」
4. **CloudFront固定ドメイン**（`api-stg.zakicorp.com` 等。アプリとESP32の接続先切替）
5. RnDの改名（4の後）→ **自分用本番**（CMK込み）→ **DG向け本番**。本番が2つになったらGitHub Actions + OIDC

判断待ち・別機会:

- v1の残骸を消すか: `toytalk-lambda-role-dev`、`toytalk-openai-api-dev`、`toytalk-api-raspi`、API Gateway `toytalk-chat-apigateway-dev`、孤立ロググループ `/aws/lambda/toytalk-stream-handler-for-esp32-lambda`
- Windows機で: `infra/` の動作確認は済（2026-09-29、Node v22.19.0・Git Bash。`npm ci`、`install-lambda-deps.sh`、型チェック、`cdk diff --context stage=rnd` が差分なし。deployは未実行）。`supervisor.py` の `ZAKICORP_TTS_URL` 同期停止はコード修正済みで、このPCの `.local/tts-service/` への反映が未実施
- `toytalker-firmware` を1資源だけ `cdk import` で引き取るか
- Soniox鍵発行Lambda（128MB）はコールドスタート時のSSM取得に約0.9秒かかる（他は1〜2GBで約0.2秒）。温めで普段は起きないが、気になるなら256MBへ

## 落とし穴

- **`cdk synth`/`diff`/`deploy` にはAWS資格情報が要る**（SSMの登録の有無を確かめるため。値は読まない）。起動時にアカウントIDが `stages.ts` と一致しないと止まる。
- **`NodejsFunction` は使っていない。** `npx esbuild` をリポジトリ直下で起動してインストール確認待ちで止まるため、esbuildのAPIを直接呼ぶ `bundleLambda` を使っている。
- 各Lambdaディレクトリの `node_modules` が無いとバンドルできない。clone直後は `bash infra/scripts/install-lambda-deps.sh`。
- 名前を固定した資源（Lambda・テーブル・S3）の名前や部品IDを変えると作り直しになる。`cdk diff` の requires replacement を必ず見る。Lambdaの作り直しはFunction URLのホスト名が変わり、アプリとESP32が壊れる。
- 新しいCloudFormation資源を既存スタックに `cdk import` するときは、import操作にそれ以外の変更を含められない（`--context importPhase=true` の仕組みは infra/README）。
