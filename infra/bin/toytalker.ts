import * as cdk from "aws-cdk-lib";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { getStage } from "../config/stages.js";
import { assertSecretsExist, loadSecrets } from "../lib/secrets.js";
import { ToyTalkerStack } from "../lib/toytalker-stack.js";

const app = new cdk.App();
const config = getStage(app.node.tryGetContext("stage"));
const importPhase = String(app.node.tryGetContext("importPhase")) === "true";

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

new ToyTalkerStack(app, `ToyTalker-${config.stage}`, {
  env: { account: config.account, region: config.region },
  config,
  envSecrets,
  importPhase,
  terminationProtection: true,
  description: `ToyTalker ${config.stage}: Lambda, DynamoDB, S3, SNS, warmer, monthly ops`,
});
