// 前払いポイントの財布と台帳（ロードマップ4、docs/pricing-and-cost-model.md 第11節）。
//
// - wallets（owner_id）: 残高の要約。balance_jpy は台帳の amount_jpy の合計と一致する
// - wallet-ledger（owner_id ＋ "timestamp#type#id"）: 追記だけの台帳。1ターンの原価の正本でもある（11.6）。
//   会話の文章は持たない。consume の ref は chat-logs の並べ替えキー（"session_id#…#timestamp#…"）
//
// 台帳の行と残高の加算は1つのトランザクションで書く（片方だけ残らない。同じ行の二重書きは条件で弾く）。
// 段階1（2026-10-31）は引くだけで、残高が0を下回っても会話は止めない。
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { tableName } from "./tables.mjs";

const WALLETS_TABLE = tableName("wallets");
const LEDGER_TABLE = tableName("wallet-ledger");
const LEDGER_SK = "timestamp#type#id";

// 内訳の値が undefined（モデル名が取れなかった等）でも書けるようにする。落とさないと行ごと失敗する
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });

/**
 * 1回分の消費を台帳に書き、残高から引く。失敗しても会話は止めないので投げずに false を返す。
 * @param {object} p
 * @param {string} p.ownerId
 * @param {string} p.deviceId   台帳キーの id 部分。同じ時刻・同じ機器の行は1つだけ書ける
 * @param {string} p.timestamp  ISO 8601（chat-logs の返答の行と同じ値）
 * @param {"app"|"esp"|"tts"} p.source
 * @param {number} p.amountJpy  マージン後の円（正の数で渡す。台帳には負で書く）
 * @param {object} [p.detail]   内訳（cost_llm など。文章は入れない）
 */
export async function recordConsume({ ownerId, deviceId, timestamp, source, amountJpy, detail = {} }) {
  if (!ownerId || !deviceId || !timestamp) return false;
  const amount = -(Number(amountJpy) || 0);
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: LEDGER_TABLE,
            Item: {
              owner_id: ownerId,
              [LEDGER_SK]: `${timestamp}#consume#${deviceId}`,
              type: "consume",
              amount_jpy: amount,
              timestamp, device_id: deviceId, source,
              ...detail,
            },
            ConditionExpression: "attribute_not_exists(owner_id)",
          },
        },
        {
          Update: {
            TableName: WALLETS_TABLE,
            Key: { owner_id: ownerId },
            UpdateExpression: "ADD balance_jpy :d SET updated_at = :t",
            ExpressionAttributeValues: { ":d": amount, ":t": new Date().toISOString() },
          },
        },
      ],
    }));
    return true;
  } catch (e) {
    console.error("[wallet] consume error:", e?.name ?? e);
    return false;
  }
}

/** 残高（円）。財布が無ければ 0 */
export async function getBalance(ownerId) {
  if (!ownerId) return 0;
  const r = await ddb.send(new GetCommand({ TableName: WALLETS_TABLE, Key: { owner_id: ownerId } }));
  return Number(r.Item?.balance_jpy) || 0;
}

/** その日（"YYYY-MM-DD"、UTC。chat-logs・usage と同じ切り方）の台帳の行 */
export async function listLedgerByDate(ownerId, date) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: LEDGER_TABLE,
      KeyConditionExpression: "owner_id = :o AND begins_with(#sk, :d)",
      ExpressionAttributeNames: { "#sk": LEDGER_SK },
      ExpressionAttributeValues: { ":o": ownerId, ":d": date },
      ExclusiveStartKey,
    }));
    items.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}
