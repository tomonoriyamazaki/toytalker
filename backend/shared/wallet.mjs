// 前払いポイントの財布と台帳（ロードマップ4、docs/pricing-and-cost-model.md 第11節）。
//
// - wallets（owner_id）: 残高の要約。balance_jpy は台帳の amount_jpy の合計と一致する。
//   last_used_at は有効期限（最後に使った日から1年、11.7）の起点で、consume と purchase で更新し adjust では更新しない
// - wallet-ledger（owner_id ＋ "timestamp#type#id"）: 追記だけの台帳。1ターンの原価の正本でもある（11.6）。
//   会話の文章は持たない。consume の ref は chat-logs の並べ替えキー（"session_id#…#timestamp#…"）
//
// 台帳の行と残高の加算は1つのトランザクションで書く（片方だけ残らない。同じ行の二重書きは条件で弾く）。
// 引くのはターンの終わりで、そのターンで0を下回っても最後まで返す。止めるのは次のターンの始め（段階2、checkBalance）。
// Stripe 由来の行（purchase / refund / dispute）は課金 worker だけが書く（11.10）。キーの時刻と ID は Stripe 側の値にし、
// 同じ Webhook が2回来ても1行しか書けないようにする。
import { randomUUID } from "node:crypto";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { tableName } from "./tables.mjs";

const WALLETS_TABLE = tableName("wallets");
const LEDGER_TABLE = tableName("wallet-ledger");
const LEDGER_SK = "timestamp#type#id";

/** 有効期限: 最後に使った日（買った日）から1年（11.7） */
export const EXPIRY_DAYS = 365;

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
  try {
    await appendAndAdd(ownerId, {
      [LEDGER_SK]: `${timestamp}#consume#${deviceId}`,
      type: "consume",
      amount_jpy: -(Number(amountJpy) || 0),
      timestamp, device_id: deviceId, source,
      ...detail,
    }, { touch: true });
    return true;
  } catch (e) {
    console.error("[wallet] consume error:", e?.name ?? e);
    return false;
  }
}

/**
 * 運用者の手作業の調整（返金・お詫び・検証用など。11.2）。1回につき1行。書いた行は直さず、間違えたら逆向きの調整を足す。
 * 運用者が手元から呼ぶ（infra/scripts/wallet-adjust.ts）。Lambda には書く権限が無い。失敗は投げる。
 * 最終利用日は動かさない（有効期限の起点は利用者自身の消費と購入だけ）。
 * @param {object} p
 * @param {string} p.ownerId
 * @param {number} p.amountJpy  足すなら正、引くなら負
 * @param {string} p.memo       理由
 * @param {string} p.by         書いた人
 */
export async function recordAdjust({ ownerId, amountJpy, memo, by }) {
  const amount = Number(amountJpy);
  if (!ownerId || !Number.isFinite(amount) || amount === 0) throw new Error("ownerId と 0 以外の amountJpy が要る");
  if (!memo || !by) throw new Error("memo（理由）と by（書いた人）が要る");
  const timestamp = new Date().toISOString();
  const id = randomUUID().slice(0, 8);
  await appendAndAdd(ownerId, { [LEDGER_SK]: `${timestamp}#adjust#${id}`, type: "adjust", amount_jpy: amount, timestamp, memo, by }, { touch: false });
  return { timestamp, id };
}

/**
 * Stripe 由来の行（課金 worker だけが呼ぶ。11.10）。
 *   purchase: 支払い完了（PaymentIntent）。正の額。最終利用日も更新する
 *   refund:   返金（Refund）。負の額
 *   dispute:  チャージバック（Dispute）。負の額
 * キーの時刻と ID は Stripe 側の値（created と id）なので、同じイベントが2回来ても2行目は書けない。
 * @param {object} p
 * @param {string} p.ownerId
 * @param {"purchase"|"refund"|"dispute"} p.type
 * @param {string} p.stripeId    pi_… / re_… / du_…
 * @param {number} p.createdUnix Stripe の created（秒）
 * @param {number} p.amountJpy   符号付き（purchase は正、refund / dispute は負）
 * @param {object} [p.detail]    stripe_customer_id、payment_intent_id、sub（買った人）、kind（buy / auto）など
 * @returns {Promise<boolean>} 書けたら true。すでに同じ行があれば false（何も変えない）
 */
export async function recordStripeRow({ ownerId, type, stripeId, createdUnix, amountJpy, detail = {} }) {
  const amount = Number(amountJpy);
  if (!ownerId || !stripeId || !Number.isFinite(amount) || amount === 0) throw new Error("ownerId・stripeId・0 以外の amountJpy が要る");
  if (!["purchase", "refund", "dispute"].includes(type)) throw new Error(`type が不正: ${type}`);
  if ((type === "purchase") !== (amount > 0)) throw new Error(`${type} の額の符号が不正: ${amount}`);
  const timestamp = new Date((Number(createdUnix) || 0) * 1000).toISOString();
  try {
    await appendAndAdd(ownerId, { [LEDGER_SK]: `${timestamp}#${type}#${stripeId}`, type, amount_jpy: amount, timestamp, stripe_id: stripeId, ...detail },
      { touch: type === "purchase" });
    return true;
  } catch (e) {
    if (isDuplicate(e)) return false;
    throw e;
  }
}

/** TransactWrite の「台帳の行がすでにある」失敗か */
function isDuplicate(e) {
  return e?.name === "TransactionCanceledException" && (e.CancellationReasons ?? [])[0]?.Code === "ConditionalCheckFailed";
}

/**
 * 台帳に1行足し（同じキーの行があれば失敗）、同じ額を残高に足す。1つのトランザクションで書く。
 * touch なら最終利用日（有効期限の起点）も今にする
 */
async function appendAndAdd(ownerId, row, { touch }) {
  const now = new Date().toISOString();
  await ddb.send(new TransactWriteCommand({
    TransactItems: [
      {
        Put: {
          TableName: LEDGER_TABLE,
          Item: { owner_id: ownerId, ...row },
          ConditionExpression: "attribute_not_exists(owner_id)",
        },
      },
      {
        Update: {
          TableName: WALLETS_TABLE,
          Key: { owner_id: ownerId },
          UpdateExpression: touch ? "ADD balance_jpy :d SET updated_at = :t, last_used_at = :t" : "ADD balance_jpy :d SET updated_at = :t",
          ExpressionAttributeValues: { ":d": row.amount_jpy, ":t": now },
        },
      },
    ],
  }));
}

/**
 * 会話・読み上げを始めてよいか（段階2）。残高が0以下（財布が無いときも0）なら始めない。
 * 環境変数 WALLET_STOP_AT_ZERO が "false" の環境（RnD）は残高にかかわらず続ける。引き落としはそのまま記録するので残高はマイナスになる。
 * 残高を読めなかったときは止めない（DynamoDB の障害で会話を全部止めないため。損はその間の原価だけ）。
 * @returns {Promise<{ ok: boolean, balanceJpy: number|null }>}
 */
export async function checkBalance(ownerId) {
  if (!ownerId) return { ok: true, balanceJpy: null };
  if (process.env.WALLET_STOP_AT_ZERO === "false") return { ok: true, balanceJpy: null };
  try {
    const balanceJpy = await getBalance(ownerId);
    return { ok: balanceJpy > 0, balanceJpy };
  } catch (e) {
    console.error("[wallet] balance error:", e?.name ?? e);
    return { ok: true, balanceJpy: null };
  }
}

/** 残高0で止めたときの応答の error（アプリが文言を出し分ける） */
export const NO_BALANCE = "no_balance";

/** 残高（円）。財布が無ければ 0 */
export async function getBalance(ownerId) {
  return (await getWallet(ownerId)).balanceJpy;
}

/**
 * 財布の要約。財布が無ければ残高 0、最終利用日 null。
 * expiresAt は最終利用日 + EXPIRY_DAYS（最終利用日が無い財布は null。段階3を出す前からある財布は最初の消費・購入で起点が付く）
 * @returns {Promise<{ balanceJpy: number, lastUsedAt: string|null, expiresAt: string|null }>}
 */
export async function getWallet(ownerId) {
  if (!ownerId) return { balanceJpy: 0, lastUsedAt: null, expiresAt: null };
  const r = await ddb.send(new GetCommand({ TableName: WALLETS_TABLE, Key: { owner_id: ownerId } }));
  const lastUsedAt = typeof r.Item?.last_used_at === "string" ? r.Item.last_used_at : null;
  const expiresAt = lastUsedAt ? new Date(Date.parse(lastUsedAt) + EXPIRY_DAYS * 24 * 60 * 60 * 1000).toISOString() : null;
  return { balanceJpy: Number(r.Item?.balance_jpy) || 0, lastUsedAt, expiresAt };
}

/** 時刻が start 以上 end 未満（UTC の ISO 8601）の台帳の行。日本時間の1日は jst.mjs の jstDayRange で作る */
export async function listLedgerBetween(ownerId, start, end) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(new QueryCommand({
      TableName: LEDGER_TABLE,
      // 並べ替えキーは "時刻#type#id" なので、ちょうど end の時刻の行は end より後ろに並び、範囲から外れる
      KeyConditionExpression: "owner_id = :o AND #sk BETWEEN :s AND :e",
      ExpressionAttributeNames: { "#sk": LEDGER_SK },
      ExpressionAttributeValues: { ":o": ownerId, ":s": start, ":e": end },
      ExclusiveStartKey,
    }));
    items.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}
