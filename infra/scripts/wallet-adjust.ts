// 財布に調整（adjust）の行を1つ足す。返金・お詫び・検証用など（docs/pricing-and-cost-model.md 11.2）。
// 台帳の行と残高の加算は backend/shared/wallet.mjs の recordAdjust で1回の書き込みにする。書いた行は直さず、間違えたら逆向きを足す。
// 使い方: npx tsx scripts/wallet-adjust.ts <stage> <owner_id> <円（引くなら負）> <理由> <書いた人> [--yes]
//   例:   npx tsx scripts/wallet-adjust.ts rnd u_584a... 1000 "段階2の検証用" tomonori --yes
// --yes が無ければ、今の残高と書く内容を表示するだけで書かない。
import { resolveStage } from "./_common.js";

const { config, flags, rest } = await resolveStage(process.argv.slice(2));
const [ownerId, amountStr, memo, by] = rest;
const amountJpy = Number(amountStr);
if (!ownerId || !Number.isFinite(amountJpy) || amountJpy === 0 || !memo || !by) {
  throw new Error("引数: <stage> <owner_id> <円（0以外）> <理由> <書いた人> [--yes]");
}

// wallet.mjs はテーブル名とリージョンを環境変数から読むので、読み込む前に入れる
process.env.TABLE_SUFFIX = config.tableSuffix;
process.env.AWS_REGION = config.region;
// @ts-expect-error 型定義の無い JS（Lambda と共用）
const { getBalance, recordAdjust } = await import("../../backend/shared/wallet.mjs");

const before = await getBalance(ownerId);
console.log(`${config.stage} ${ownerId}: 残高 ${before} 円 → ${before + amountJpy} 円（${amountJpy > 0 ? "+" : ""}${amountJpy}、理由: ${memo}、by: ${by}）`);
if (!flags.has("--yes")) {
  console.log("--yes を付けると書く");
} else {
  const r = await recordAdjust({ ownerId, amountJpy, memo, by });
  console.log(`書いた: ${r.timestamp}#adjust#${r.id}、残高 ${await getBalance(ownerId)} 円`);
}
