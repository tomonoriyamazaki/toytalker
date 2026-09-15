// マスターデータ4テーブル（characters・voices・llms・api-unit-prices）をJSONへ書き出す。
// 使い方: npx tsx scripts/export-master-data.ts <stage>
// 出力: master-data/<stage>/<table>.json（Git対象外。キャラクターの人格プロンプトを含むため）
import * as fs from "node:fs";
import * as path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { resolveStage } from "./_common.js";

export const MASTER_TABLES = ["toytalker-characters", "toytalker-voices", "toytalker-llms", "toytalker-api-unit-prices"] as const;

const { config } = await resolveStage(process.argv.slice(2));
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }));
const here = path.dirname(new URL(import.meta.url).pathname);
const outDir = path.join(here, "..", "master-data", config.stage);
fs.mkdirSync(outDir, { recursive: true });

for (const table of MASTER_TABLES) {
  const items: Record<string, unknown>[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: table, ExclusiveStartKey }));
    items.push(...(res.Items ?? []));
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  const file = path.join(outDir, `${table}.json`);
  fs.writeFileSync(file, JSON.stringify(items, null, 2) + "\n");
  console.log(`${table}: ${items.length} items → ${path.relative(process.cwd(), file)}`);
}
