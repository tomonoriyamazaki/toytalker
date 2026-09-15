// 秘密を1件、SSM Parameter Store（SecureString）へ入れる。値は標準入力から読む（履歴に残さないため）。
// 使い方: printf '%s' "$VALUE" | npx tsx scripts/put-secret.ts <stage> <ENV_NAME> [--overwrite]
//   例:   printf '%s' "sk-..." | npx tsx scripts/put-secret.ts stg OPENAI_API_KEY
import { SSMClient, PutParameterCommand } from "@aws-sdk/client-ssm";
import { REQUIRED_SECRETS, OPTIONAL_SECRETS } from "../lib/secrets.js";
import { resolveStage } from "./_common.js";

const { config, flags, rest } = await resolveStage(process.argv.slice(2));
const envName = rest[0];
const params: Record<string, string> = { ...REQUIRED_SECRETS, ...OPTIONAL_SECRETS };
const paramName = envName ? params[envName] : undefined;
if (!paramName) throw new Error(`ENV_NAME は次のどれか: ${Object.keys(params).join(", ")}`);

const chunks: Buffer[] = [];
for await (const c of process.stdin) chunks.push(c as Buffer);
const value = Buffer.concat(chunks).toString("utf8").replace(/\r?\n$/, "");
if (!value) throw new Error("標準入力が空です");

const ssm = new SSMClient({ region: config.region });
await ssm.send(new PutParameterCommand({ Name: paramName, Value: value, Type: "SecureString", Overwrite: flags.has("--overwrite") }));
console.log(`put ${paramName} (${config.stage}, ${value.length} chars)`);
