// 秘密の値はアカウントごとのSSM Parameter Store（SecureString）に置き、Lambdaが実行時に読む（backend/shared/secrets.mjs）。
// CDKは名前をLambdaへ渡し（環境変数 SECRET_PARAMS）、読み取り権限を付け、synth時に登録漏れを確かめるだけで、値は読まない。
// 名前は全環境で同じ。中身だけアカウントごとに違う。鍵の入れ替えはSSMを変えるだけで、deployは要らない。
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

/** コード内の名前（secret("…") の引数） → SSMパラメータ名 */
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

export const SECRET_PARAMS: Record<SecretName, string> = { ...REQUIRED_SECRETS, ...OPTIONAL_SECRETS };

/** 必須の秘密がSSMに登録されているか確かめる。復号しないので値は手元に来ない */
export async function assertSecretsExist(region: string): Promise<void> {
  await getSecrets(region, false);
}

/** 移行用（--context keepEnvSecrets=true）: 値を読んでLambda環境変数にも残す */
export async function loadSecrets(region: string): Promise<Secrets> {
  return getSecrets(region, true);
}

async function getSecrets(region: string, decrypt: boolean): Promise<Secrets> {
  const ssm = new SSMClient({ region });
  const byParam = new Map(Object.entries(SECRET_PARAMS).map(([env, param]) => [param, env]));
  const names = [...byParam.keys()];
  const found: Record<string, string> = {};
  const missing: string[] = [];
  for (let i = 0; i < names.length; i += 10) {
    const chunk = names.slice(i, i + 10);
    const res = await ssm.send(new GetParametersCommand({ Names: chunk, WithDecryption: decrypt }));
    for (const p of res.Parameters ?? []) {
      if (p.Name && p.Value !== undefined) found[byParam.get(p.Name)!] = p.Value;
    }
    missing.push(...(res.InvalidParameters ?? []));
  }
  const missingRequired = missing.filter((p) => Object.values(REQUIRED_SECRETS).includes(p as never));
  if (missingRequired.length > 0) {
    throw new Error(
      `SSMに未登録の秘密があります（region=${region}）:\n  ${missingRequired.join("\n  ")}\n` +
        `登録は infra/scripts/put-secret.ts（1件ずつ）`,
    );
  }
  return found as Secrets;
}
