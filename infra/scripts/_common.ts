import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { getStage, type StageConfig } from "../config/stages.js";

/** 引数の stage を読み、資格情報のアカウントが一致することを確かめて設定を返す */
export async function resolveStage(argv: string[]): Promise<{ config: StageConfig; flags: Set<string>; rest: string[] }> {
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const rest = argv.filter((a) => !a.startsWith("--"));
  const config = getStage(rest[0]);
  const identity = await new STSClient({ region: config.region }).send(new GetCallerIdentityCommand({}));
  if (identity.Account !== config.account) {
    throw new Error(`stage=${config.stage} は account ${config.account} ですが、今の資格情報は ${identity.Account} です`);
  }
  return { config, flags, rest: rest.slice(1) };
}
