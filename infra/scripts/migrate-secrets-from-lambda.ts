// RnDの既存Lambda環境変数にあるAPIキー類を、同じアカウントのSSM Parameter Store（SecureString）へ写す。
// 使い方: npx tsx scripts/migrate-secrets-from-lambda.ts rnd [--overwrite] [--dry-run]
// 既にある名前は --overwrite が無ければ飛ばす。値は表示しない。
import { SSMClient, PutParameterCommand, GetParameterCommand } from "@aws-sdk/client-ssm";
import { loadSecretsFromLambda, REQUIRED_SECRETS, OPTIONAL_SECRETS, type SecretName } from "../lib/secrets.js";
import { resolveStage } from "./_common.js";

const { config, flags } = await resolveStage(process.argv.slice(2));
if (config.stage !== "rnd") throw new Error("このスクリプトはRnD専用です（他環境は put-secret.ts で1件ずつ入れる）");
const overwrite = flags.has("--overwrite");
const dryRun = flags.has("--dry-run");

const secrets = await loadSecretsFromLambda(config.region);
const ssm = new SSMClient({ region: config.region });
const params: Record<string, string> = { ...REQUIRED_SECRETS, ...OPTIONAL_SECRETS };

for (const [envName, paramName] of Object.entries(params)) {
  const value = secrets[envName as SecretName];
  if (!value) { console.log(`skip     ${paramName}（Lambdaに値なし）`); continue; }
  let exists = false;
  try { await ssm.send(new GetParameterCommand({ Name: paramName })); exists = true; } catch { /* not found */ }
  if (exists && !overwrite) { console.log(`exists   ${paramName}（--overwrite で上書き）`); continue; }
  if (dryRun) { console.log(`would ${exists ? "overwrite" : "create"} ${paramName}`); continue; }
  await ssm.send(new PutParameterCommand({ Name: paramName, Value: value, Type: "SecureString", Overwrite: overwrite }));
  console.log(`${exists ? "updated " : "created "} ${paramName}`);
}
