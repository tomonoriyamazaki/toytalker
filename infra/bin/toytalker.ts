import * as cdk from "aws-cdk-lib";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { getStage } from "../config/stages.js";
import { loadSecrets, loadSecretsFromLambda } from "../lib/secrets.js";
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

// 秘密の読み出し元。既定はSSM。RnDでSSMへ移す前の確認だけ --context secretsSource=lambda で既存Lambdaの環境変数を読む
const secretsSource = app.node.tryGetContext("secretsSource") ?? "ssm";
if (secretsSource === "lambda" && config.stage !== "rnd") {
  throw new Error("secretsSource=lambda はRnDの移行時だけ使えます");
}
const secrets = secretsSource === "lambda" ? await loadSecretsFromLambda(config.region) : await loadSecrets(config.region);

new ToyTalkerStack(app, `ToyTalker-${config.stage}`, {
  env: { account: config.account, region: config.region },
  config,
  secrets,
  importPhase,
  terminationProtection: true,
  description: `ToyTalker ${config.stage}: Lambda, DynamoDB, S3, SNS, warmer, monthly ops`,
});
