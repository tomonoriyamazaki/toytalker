# 引き継ぎ: CDK化とRnDの取り込み（2026-09-16作業分）

新しいセッションで複数アカウント展開の続きを始めるための入口。決定の根拠と経過は [複数アカウント計画](multi-account-iac-plan.md)、コードと手順は [infra/README.md](../infra/README.md)。この文書は「今どうなっていて、次に何をするか」だけを持つ。

## 今の状態

- RnDアカウント（342082316736）のToyTalker資源36個は、CloudFormationスタック **`ToyTalker-rnd`** の管理下。ドリフトなし（2026-09-16確認）。
- **Lambdaの反映は `cd infra && npx cdk diff --context stage=rnd` → `npx cdk deploy --context stage=rnd`。** `deploy.sh` / `setup.sh` は削除済み。
- APIキー11件の正本は **SSM Parameter Store `/toytalker/<key>`**（AWS管理キーで暗号化、無料）。CDKがdeploy時に読んでLambda環境変数へ配る。Lambdaのコンソールで環境変数を直接変えても次のdeployで戻る。鍵を替える手順は infra/README の「秘密」節。
- IAMロールはCDKが関数ごとに作った最小権限のもの（`ToyTalker-rnd-<部品ID>ServiceRole…`）。旧ロールと旧Permissionは削除済み。**`toytalk-lambda-role-dev` だけはv1の旧Lambda 2本が使っているので残している。**
- 動作確認済み: アプリ（会話・読み上げ・設定保存・クローンボイス登録）、ESP32（会話・OTA 0.7.1→0.7.2）。いずれも新ロールで成功。
- Lambda 8本のバンドルは、CDK化前に本番に入っていたコードとバイト単位で一致することを確認した上で引き取った。
- Node 22だった3本はNode 24に統一。ESP32用メインのメモリは2024→2048MB（元の値はタイプミス）。

## 決めたこと（2026-09-16）

- 秘密はSecrets Managerでなく **SSM SecureString**（1件$0.40/月が不要。ローテーション・アカウント間共有を使わないため）。
- 鍵はAWS管理キー。**CMKは本番アカウントで入れる**（SSMとLambda環境変数の両方。DG向け本番で他の人が入る時点で効く。1鍵約$1/月）。RnD/STGはAWS管理キーのまま。
- **秘密の実行時取得へ切り替える**（Lambdaが初期化時にSSMを読みメモリに保持。環境変数から鍵を外す）。STGを作る前にやる。詳細は計画メモの同名の節。
- **命名は環境名を付けて統一する**（案: `toytalker-<env>-chat-app` など。スタック名・部品ID・固定名の3層を一度に変える）。RnDの改名はCloudFront固定ドメインの後、STGは最初から新名。詳細は計画メモの「命名の見直し」。
- ファーム配布バケット `toytalker-firmware` はCDKの管理外（`fromBucketName` で参照のみ）。名前は `stages.ts` の `firmwareBucketName`。

## 次にやること（順序の案）

1. **秘密の実行時取得**（8本のコード＋CDK。実機試験が要る）
2. **命名の決定**（計画メモの案を確定。テーブルのキー名を変えるならここで）
3. **STGアカウント作成 → `cdk bootstrap` → SSM投入 → `cdk deploy` → マスターデータ投入**（`stages.ts` の `account` を埋める。投入スクリプトは infra/scripts）
4. **CloudFront固定ドメイン**（`api-stg.zakicorp.com` 等。アプリとESP32の接続先切替）
5. RnDの改名（4の後）

判断待ち・別機会:

- v1の残骸を消すか: `toytalk-lambda-role-dev`、`toytalk-openai-api-dev`、`toytalk-api-raspi`、API Gateway `toytalk-chat-apigateway-dev`、孤立ロググループ `/aws/lambda/toytalk-stream-handler-for-esp32-lambda`
- Windows機で: `tools/tts-service/supervisor.py` の `ZAKICORP_TTS_URL` 同期停止（計画の9番。今は同じ値なので衝突しない）、`infra/` の動作確認（`install-lambda-deps.sh` はGit Bash前提）
- `toytalker-firmware` を1資源だけ `cdk import` で引き取るか

## 落とし穴

- **`cdk synth`/`diff`/`deploy` にはAWS資格情報が要る**（SSMを読むため）。起動時にアカウントIDが `stages.ts` と一致しないと止まる。
- **`NodejsFunction` は使っていない。** `npx esbuild` をリポジトリ直下で起動してインストール確認待ちで止まるため、esbuildのAPIを直接呼ぶ `bundleLambda` を使っている。
- 各Lambdaディレクトリの `node_modules` が無いとバンドルできない。clone直後は `bash infra/scripts/install-lambda-deps.sh`。
- 名前を固定した資源（Lambda・テーブル・S3）の名前や部品IDを変えると作り直しになる。`cdk diff` の requires replacement を必ず見る。Lambdaの作り直しはFunction URLのホスト名が変わり、アプリとESP32が壊れる。
- 新しいCloudFormation資源を既存スタックに `cdk import` するときは、import操作にそれ以外の変更を含められない（`--context importPhase=true` の仕組みは infra/README）。
