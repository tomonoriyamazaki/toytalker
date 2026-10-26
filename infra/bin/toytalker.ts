import * as cdk from "aws-cdk-lib";
import { AwsSolutionsChecks, ServerlessChecks } from "cdk-nag";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { getStage, stackName } from "../config/stages.js";
import { assertSecretsExist, loadSecrets } from "../lib/secrets.js";
import { ToyTalkerStack } from "../lib/toytalker-stack.js";
import { ToyTalkerOrgStack } from "../lib/toytalker-org-stack.js";

const app = new cdk.App();
const config = getStage(app.node.tryGetContext("stage"));
const importPhase = String(app.node.tryGetContext("importPhase")) === "true";

// 静的点検（--context nag=true）。cdk-nag の AwsSolutions と Serverless のルールで全スタックを見る。
// 違反はエラーになり synth が止まる。結果は cdk.out/<pack>-<stack>-NagReport.csv。
// 意図して外すルールは lib/ 側で NagSuppressions に理由付きで書く（docs/security-review-2026-10-25.md）。
if (String(app.node.tryGetContext("nag")) === "true") {
  cdk.Validations.of(app).addPlugins(new AwsSolutionsChecks(app, { verbose: true }));
  cdk.Validations.of(app).addPlugins(new ServerlessChecks(app, { verbose: true }));
}

// 別環境へ誤って流さないよう、資格情報のアカウントが設定と一致することを確かめる
const identity = await new STSClient({ region: config.region }).send(new GetCallerIdentityCommand({}));
if (identity.Account !== config.account) {
  throw new Error(
    `stage=${config.stage} は account ${config.account} ですが、今の資格情報は ${identity.Account} です（AWS_PROFILE / --profile を確認）`,
  );
}

// 秘密はLambdaが実行時にSSMから読む。ここでは登録漏れだけ確かめる。
// 環境変数方式から移るときだけ --context keepEnvSecrets=true で値を読み、環境変数にも残す（1段目）。
// 動作を確かめたあと、フラグ無しでdeployして環境変数から外す（2段目）。
const keepEnvSecrets = String(app.node.tryGetContext("keepEnvSecrets")) === "true";
const envSecrets = keepEnvSecrets ? await loadSecrets(config.region) : undefined;
if (!keepEnvSecrets) await assertSecretsExist(config.region);

new ToyTalkerStack(app, stackName(config), {
  env: { account: config.account, region: config.region },
  config,
  envSecrets,
  importPhase,
  terminationProtection: true,
  description: `ToyTalker ${config.stage}: Lambda, DynamoDB, S3, SNS, warmer, monthly ops`,
});

// 組織全体で1つの資源（CloudTrail 組織トレイル）は管理アカウントの環境にだけ出す
if (config.organizationId) {
  new ToyTalkerOrgStack(app, "toytalker-org", {
    env: { account: config.account, region: config.region },
    organizationId: config.organizationId,
    terminationProtection: true,
    description: "ToyTalker org-wide: CloudTrail organization trail",
  });
}
