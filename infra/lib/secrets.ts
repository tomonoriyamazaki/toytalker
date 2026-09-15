// 秘密の値はアカウントごとのSSM Parameter Store（SecureString）に置き、synth時に読んでLambda環境変数へ焼く。
// 名前は全環境で同じ。中身だけアカウントごとに違う。鍵を入れ替えたら `cdk deploy` し直す。
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

/** Lambda環境変数名 → SSMパラメータ名 */
export const REQUIRED_SECRETS = {
  OPENAI_API_KEY: "/toytalker/openai-api-key",
  ANTHROPIC_API_KEY: "/toytalker/anthropic-api-key",
  GOOGLE_API_KEY: "/toytalker/google-api-key",
  ELEVENLABS_API_KEY: "/toytalker/elevenlabs-api-key",
  FISHAUDIO_API_KEY: "/toytalker/fishaudio-api-key",
  SAKURA_API_KEY: "/toytalker/sakura-api-key",
  CARTESIA_API_KEY: "/toytalker/cartesia-api-key",
  ZAKICORP_API_KEY: "/toytalker/zakicorp-api-key",
  ZAKICORP_EDGE_KEY: "/toytalker/zakicorp-edge-key",
  SERPER_API_KEY: "/toytalker/serper-api-key",
  SONIOX_API_KEY: "/toytalker/soniox-api-key",
} as const;

/** 無くてもデプロイできるもの（月次レポートが各社の請求を取りに行くときだけ使う） */
export const OPTIONAL_SECRETS = {
  OPENAI_ADMIN_KEY: "/toytalker/openai-admin-key",
  ANTHROPIC_ADMIN_KEY: "/toytalker/anthropic-admin-key",
} as const;

export type RequiredSecretName = keyof typeof REQUIRED_SECRETS;
export type OptionalSecretName = keyof typeof OPTIONAL_SECRETS;
export type SecretName = RequiredSecretName | OptionalSecretName;

export type Secrets = Record<RequiredSecretName, string> & Partial<Record<OptionalSecretName, string>>;

export async function loadSecrets(region: string): Promise<Secrets> {
  const ssm = new SSMClient({ region });
  const all: Record<string, string> = { ...REQUIRED_SECRETS, ...OPTIONAL_SECRETS };
  const byParam = new Map(Object.entries(all).map(([env, param]) => [param, env]));
  const names = [...byParam.keys()];
  const found: Record<string, string> = {};
  const missing: string[] = [];
  for (let i = 0; i < names.length; i += 10) {
    const chunk = names.slice(i, i + 10);
    const res = await ssm.send(new GetParametersCommand({ Names: chunk, WithDecryption: true }));
    for (const p of res.Parameters ?? []) {
      if (p.Name && p.Value !== undefined) found[byParam.get(p.Name)!] = p.Value;
    }
    missing.push(...(res.InvalidParameters ?? []));
  }
  const missingRequired = missing.filter((p) => Object.values(REQUIRED_SECRETS).includes(p as never));
  if (missingRequired.length > 0) {
    throw new Error(
      `SSMに未登録の秘密があります（region=${region}）:\n  ${missingRequired.join("\n  ")}\n` +
        `登録は infra/scripts/put-secret.ts（1件ずつ）か、RnDなら infra/scripts/migrate-secrets-from-lambda.ts を使う`,
    );
  }
  return found as Secrets;
}

/**
 * 移行用: RnDの既存Lambdaの環境変数から秘密を読む（読み取りのみ）。
 * SSMへ移す前に synth / diff を確かめるときと、scripts/migrate-secrets-from-lambda.ts が使う。
 */
export async function loadSecretsFromLambda(region: string): Promise<Secrets> {
  const { LambdaClient, GetFunctionConfigurationCommand } = await import("@aws-sdk/client-lambda");
  const client = new LambdaClient({ region });
  const env: Record<string, string> = {};
  for (const fn of ["toytalk-stream-handler-lambda", "toytalk-soniox-stt-lambda", "toytalker-ops-monthly-lambda"]) {
    const res = await client.send(new GetFunctionConfigurationCommand({ FunctionName: fn }));
    Object.assign(env, res.Environment?.Variables ?? {});
  }
  const found: Record<string, string> = {};
  const missing: string[] = [];
  for (const name of Object.keys(REQUIRED_SECRETS) as RequiredSecretName[]) {
    if (env[name]) found[name] = env[name];
    else missing.push(name);
  }
  for (const name of Object.keys(OPTIONAL_SECRETS) as OptionalSecretName[]) {
    if (env[name]) found[name] = env[name];
  }
  if (missing.length > 0) throw new Error(`Lambda環境変数に無い秘密: ${missing.join(", ")}`);
  return found as Secrets;
}
