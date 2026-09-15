// `cdk import --resource-mapping` 用のファイルを、synth済みテンプレートから作る。
// 使い方: npx cdk synth --context stage=<stage> --context importPhase=true
//         npx tsx scripts/make-import-mapping.ts <stage>
// 出力: import/<stage>.generated.json（論理ID → 既存資源の識別子）
import * as fs from "node:fs";
import * as path from "node:path";
import { SNSClient, ListSubscriptionsByTopicCommand } from "@aws-sdk/client-sns";
import { resolveStage } from "./_common.js";

const { config } = await resolveStage(process.argv.slice(2));
const here = path.dirname(new URL(import.meta.url).pathname);
const templatePath = path.join(here, "..", "cdk.out", `ToyTalker-${config.stage}.template.json`);
const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
const { account, region } = config;

const sns = new SNSClient({ region });
const mapping: Record<string, Record<string, string>> = {};
const unsupported: string[] = [];

for (const [logicalId, res] of Object.entries<any>(template.Resources)) {
  const p = res.Properties ?? {};
  switch (res.Type) {
    case "AWS::DynamoDB::Table": mapping[logicalId] = { TableName: p.TableName }; break;
    case "AWS::S3::Bucket": mapping[logicalId] = { BucketName: p.BucketName }; break;
    case "AWS::Logs::LogGroup": mapping[logicalId] = { LogGroupName: p.LogGroupName }; break;
    case "AWS::Lambda::Function": mapping[logicalId] = { FunctionName: p.FunctionName }; break;
    case "AWS::Lambda::Url": {
      const fnLogical = p.TargetFunctionArn?.["Fn::GetAtt"]?.[0];
      const fnName = template.Resources[fnLogical]?.Properties?.FunctionName;
      mapping[logicalId] = { FunctionArn: `arn:aws:lambda:${region}:${account}:function:${fnName}` };
      break;
    }
    case "AWS::SNS::Topic": mapping[logicalId] = { TopicArn: `arn:aws:sns:${region}:${account}:${p.TopicName}` }; break;
    case "AWS::SNS::Subscription": {
      const topicLogical = p.TopicArn?.Ref;
      const topicName = template.Resources[topicLogical]?.Properties?.TopicName;
      const topicArn = `arn:aws:sns:${region}:${account}:${topicName}`;
      const subs = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn: topicArn }));
      const hit = subs.Subscriptions?.find((s) => s.Protocol === p.Protocol && s.Endpoint === p.Endpoint);
      if (!hit?.SubscriptionArn || hit.SubscriptionArn === "PendingConfirmation") {
        throw new Error(`SNS購読が見つからないか未確認です: ${p.Protocol} ${p.Endpoint}`);
      }
      mapping[logicalId] = { Arn: hit.SubscriptionArn };
      break;
    }
    case "AWS::Events::Rule": mapping[logicalId] = { Arn: `arn:aws:events:${region}:${account}:rule/${p.Name}` }; break;
    case "AWS::Scheduler::Schedule": mapping[logicalId] = { Name: p.Name }; break;
    default: unsupported.push(`${logicalId} (${res.Type})`);
  }
}

if (unsupported.length > 0) {
  throw new Error(`import対象にできない資源がテンプレートにあります（--context importPhase=true で synth したか確認）:\n  ${unsupported.join("\n  ")}`);
}
const out = path.join(here, "..", "import", `${config.stage}.generated.json`);
fs.writeFileSync(out, JSON.stringify(mapping, null, 2) + "\n");
console.log(`${Object.keys(mapping).length} resources → ${path.relative(process.cwd(), out)}`);
