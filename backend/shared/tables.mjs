// DynamoDBテーブル名。全Lambda共通で、esbuildが各バンドルへ取り込む。
// 名前は `toytalker-<機能>-<環境>`（docs/naming-conventions.md）。環境名の部分（例 "-stg"）は
// CDKが環境変数 TABLE_SUFFIX で渡す（正本は infra/config/stages.ts の tableSuffix）。
// RnDは改名まで旧名のままなので空文字。コードにはテーブルの固定名を書かない。
const TABLE_SUFFIX = process.env.TABLE_SUFFIX ?? "";

/** 機能名（"devices" など）から、この環境のテーブル名を返す */
export function tableName(base) {
  return `toytalker-${base}${TABLE_SUFFIX}`;
}
