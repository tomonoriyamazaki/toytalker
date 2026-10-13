// export-master-data.ts で書き出したJSONを別環境のテーブルへ入れる（同じキーは上書き）。
// 使い方: npx tsx scripts/import-master-data.ts <to-stage> --from=<from-stage> --yes
//   例:   npx tsx scripts/import-master-data.ts stg --from=rnd --yes
import * as fs from "node:fs";
import * as path from "node:path";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { resolveStage } from "./_common.js";

// 機能名。実名は `toytalker-<機能名><tableSuffix>`。JSONのファイル名は環境によらず `toytalker-<機能名>.json`（export-master-data.ts と同じ）
const MASTER_TABLES = ["characters", "voices", "llms", "api-unit-prices"] as const;

const { config, flags } = await resolveStage(process.argv.slice(2));
const from = [...flags].find((f) => f.startsWith("--from="))?.slice("--from=".length);
if (!from) throw new Error("--from=<stage> を指定してください");
if (from === config.stage) throw new Error("--from と書き込み先が同じです");
if (!flags.has("--yes")) throw new Error(`${config.stage} のテーブルへ書き込みます。実行するには --yes を付けてください`);

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: config.region }));
const here = path.dirname(new URL(import.meta.url).pathname);

for (const key of MASTER_TABLES) {
  const table = `toytalker-${key}${config.tableSuffix}`;
  const file = path.join(here, "..", "master-data", from, `toytalker-${key}.json`);
  const items: Record<string, unknown>[] = JSON.parse(fs.readFileSync(file, "utf8"));
  for (let i = 0; i < items.length; i += 25) {
    let requests = items.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } }));
    while (requests.length > 0) {
      const res = await ddb.send(new BatchWriteCommand({ RequestItems: { [table]: requests } }));
      requests = (res.UnprocessedItems?.[table] ?? []) as typeof requests;
      if (requests.length > 0) await new Promise((r) => setTimeout(r, 500));
    }
  }
  console.log(`${table}: ${items.length} items → ${config.stage}`);
}
