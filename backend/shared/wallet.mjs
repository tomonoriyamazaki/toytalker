// 前払いポイントの財布と台帳（ロードマップ4、docs/pricing-and-cost-model.md 第11節）。
//
// - wallets（owner_id）: 残高の要約。balance_jpy は台帳の amount_jpy の合計と一致する。
//   last_used_at は有効期限（最後に使った日から1年、11.7）の起点で、consume と purchase で更新し adjust では更新しない。
//   無い財布（段階3より前からある財布）は課金 worker の毎日の処理が最初に見た日を起点にする（11.10）。
//   expiry_warned_for は失効30日前の予告を記録した時点の last_used_at（段階4のプッシュが使う）、expired_at は最後に失効した時刻
// - wallet-ledger（owner_id ＋ "timestamp#type#id"）: 追記だけの台帳。1ターンの原価の正本でもある（11.6）。
//   会話の文章は持たない。consume の ref は chat-logs の並べ替えキー（"session_id#…#timestamp#…"）
//
// 台帳の行と残高の加算は1つのトランザクションで書く（片方だけ残らない。同じ行の二重書きは条件で弾く）。
// 引くのはターンの終わりで、そのターンで0を下回っても最後まで返す。止めるのは次のターンの始め（段階2、checkBalance）。
// Stripe 由来の行（purchase / refund / dispute）は課金 worker だけが書く（11.10）。キーの時刻と ID は Stripe 側の値にし、
// 同じ Webhook が2回来ても1行しか書けないようにする。失効（expire）も課金 worker だけが書く（キーは日本時間の日付で1日1回）。
import { randomUUID } from "node:crypto";
import { DynamoDBClient, TransactWriteItemsCommand } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, ScanCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { tableName } from "./tables.mjs";
import { jstDayRange } from "./jst.mjs";
import { dataClientConfig } from "./region.mjs";

const WALLETS_TABLE = tableName("wallets");
const LEDGER_TABLE = tableName("wallet-ledger");
const LEDGER_SK = "timestamp#type#id";

/** 有効期限: 最後に使った日（買った日）から1年（11.7） */
export const EXPIRY_DAYS = 365;
/** 失効の予告を記録する日数（失効の30日前。11.10） */
export const EXPIRY_WARN_DAYS = EXPIRY_DAYS - 30;
const DAY_MS = 24 * 60 * 60 * 1000;

// 内訳の値が undefined（モデル名が取れなかった等）でも書けるようにする。落とさないと行ごと失敗する
const raw = new DynamoDBClient(dataClientConfig);
const ddb = DynamoDBDocumentClient.from(raw, { marshallOptions: { removeUndefinedValues: true } });
// 残高を DynamoDB の数値の文字列のまま読む（wrapNumbers）。残高は consume の積み重ねで JavaScript の数値より長い桁になっていて
// （例 975.01661000000000052）、Number にすると丸まり「読んだときのまま」の条件が一致しない。失効の処理だけがこちらを使う。
// 元のクライアントは別に作る。DynamoDBDocumentClient.from は渡したクライアントの config に変換の設定を書き込むので、
// 同じ raw から2つ作ると後の設定が先の ddb にもかかる（2026-11-08〜11、台帳の数値が { value: "…" } で返り、アプリの利用状況の詳細が落ちた）
const ddbExact = DynamoDBDocumentClient.from(new DynamoDBClient(dataClientConfig), { marshallOptions: { removeUndefinedValues: true }, unmarshallOptions: { wrapNumbers: true } });

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
  const sk = `${timestamp}#consume#${deviceId}`;
  const amount = -(Number(amountJpy) || 0);
  try {
    await appendAndAdd(ownerId, {
      [LEDGER_SK]: sk,
      type: "consume",
      amount_jpy: amount,
      timestamp, device_id: deviceId, source,
      ...detail,
    }, { touch: true });
    return true;
  } catch (e) {
    // 引けなかった分を後から adjust で直せるように、誰の・どの行の・いくらかと、取り消しの理由を残す（文章は無い）。
    // reasons は [台帳の行, 財布] の順。台帳が ConditionalCheckFailed なら同じキーの行が先にある、TransactionConflict ならやり直しても同時の書き込みに負けた
    console.error("[wallet] consume error:", e?.name ?? e, JSON.stringify({ reasons: cancelCodes(e), owner_id: ownerId, sk, amount_jpy: amount, source }));
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

/**
 * 失効（課金 worker の毎日の処理だけが呼ぶ。11.10）。台帳に expire（残高を0にするマイナスの額）を書き、残高を0にする。
 * キーは日本時間の日付（その日の始まりの時刻 ＋ "expire" ＋ 日付）なので、同じ日に2回走っても2行目は書けない。
 * 財布の側は「残高と最終利用日が読んだときのまま」の条件付きで、Scan の後に使われた（起点が延びた）・調整された財布は失効させない。
 * 残高は listWallets が読んだ DynamoDB の数値の文字列をそのまま使う（JavaScript の数値に丸めると条件が一致せず、引き切れない）。
 * @param {object} p
 * @param {string} p.ownerId
 * @param {string} p.date        日本時間の日付 "YYYY-MM-DD"（処理日）
 * @param {string} p.balanceRaw  読んだときの残高（DynamoDB の数値の文字列。正の数）
 * @param {string} p.lastUsedAt  読んだときの最終利用日
 * @returns {Promise<"expired"|"duplicate"|"changed">} changed は Scan の後に財布が動いていて失効させなかった
 */
export async function recordExpire({ ownerId, date, balanceRaw, lastUsedAt }) {
  if (!ownerId || !/^\d{4}-\d{2}-\d{2}$/.test(date ?? "") || !/^\d+(\.\d+)?$/.test(balanceRaw ?? "") || !(Number(balanceRaw) > 0) || !lastUsedAt) {
    throw new Error("ownerId・date・正の balanceRaw・lastUsedAt が要る");
  }
  const timestamp = jstDayRange(date).start;
  const now = new Date().toISOString();
  try {
    // 数値を文字列のまま書くので低水準の API を使う（Document client は数値を JavaScript の数値に変える）
    await raw.send(new TransactWriteItemsCommand({
      TransactItems: [
        {
          Put: {
            TableName: LEDGER_TABLE,
            Item: {
              owner_id: { S: ownerId }, [LEDGER_SK]: { S: `${timestamp}#expire#${date}` }, type: { S: "expire" }, amount_jpy: { N: `-${balanceRaw}` },
              timestamp: { S: timestamp }, date: { S: date }, last_used_at: { S: lastUsedAt }, processed_at: { S: now },
            },
            ConditionExpression: "attribute_not_exists(owner_id)",
          },
        },
        {
          Update: {
            TableName: WALLETS_TABLE,
            Key: { owner_id: { S: ownerId } },
            UpdateExpression: "ADD balance_jpy :d SET updated_at = :t, expired_at = :t",
            ConditionExpression: "balance_jpy = :b AND last_used_at = :lu",
            ExpressionAttributeValues: { ":d": { N: `-${balanceRaw}` }, ":t": { S: now }, ":b": { N: balanceRaw }, ":lu": { S: lastUsedAt } },
          },
        },
      ],
    }));
    return "expired";
  } catch (e) {
    if (isDuplicate(e)) return "duplicate";
    if (e?.name === "TransactionCanceledException" && (e.CancellationReasons ?? [])[1]?.Code === "ConditionalCheckFailed") return "changed";
    throw e;
  }
}

/**
 * 失効の予告の記録（失効の30日前。通知そのものは段階4のプッシュ）。予告した時点の最終利用日を残すので、
 * その後に使われて起点が延びれば「予告は古い」と分かる（describeWallet の expiryWarned）。最終利用日が読んだときのままのときだけ書く。
 * @returns {Promise<boolean>} 書けたら true。財布が動いていれば false
 */
export async function recordExpiryWarning(ownerId, lastUsedAt) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: WALLETS_TABLE,
      Key: { owner_id: ownerId },
      UpdateExpression: "SET expiry_warned_at = :t, expiry_warned_for = :lu",
      ConditionExpression: "last_used_at = :lu",
      ExpressionAttributeValues: { ":t": new Date().toISOString(), ":lu": lastUsedAt },
    }));
    return true;
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/**
 * 最終利用日が無い財布（段階3より前からある財布）に起点を付ける（11.10 の「無い財布は段階3を出した日から数える」。
 * 課金 worker の毎日の処理が最初に見た日 = 段階3を出した日）。すでにあれば何もしない
 * @returns {Promise<boolean>} 付けたら true
 */
export async function stampLastUsedAt(ownerId, at) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: WALLETS_TABLE,
      Key: { owner_id: ownerId },
      UpdateExpression: "SET last_used_at = :t, updated_at = :t",
      ConditionExpression: "attribute_not_exists(last_used_at)",
      ExpressionAttributeValues: { ":t": at },
    }));
    return true;
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") return false;
    throw e;
  }
}

/**
 * 財布を全部（毎日の失効の処理と月次レポートの残高合計）。数値は DynamoDB の文字列のまま（{ value: "…" }）返るので describeWallet に通す。
 * 家庭が数千を超えたら索引に替える（ロードマップ13）
 */
export async function listWallets() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await ddbExact.send(new ScanCommand({ TableName: WALLETS_TABLE, ExclusiveStartKey }));
    items.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/**
 * 財布の行の要約（getWallet と listWallets で同じ形にする）。balance_jpy は数値でも wrapNumbers の { value: "…" } でもよい。
 * balanceRaw は DynamoDB の数値の文字列（recordExpire の条件に使う。数値で読んだ行では丸めた値の文字列）
 */
export function describeWallet(item) {
  const lastUsedAt = typeof item?.last_used_at === "string" ? item.last_used_at : null;
  const expiresAt = lastUsedAt ? new Date(Date.parse(lastUsedAt) + EXPIRY_DAYS * DAY_MS).toISOString() : null;
  const expiredAt = typeof item?.expired_at === "string" ? item.expired_at : null;
  const b = item?.balance_jpy;
  const balanceRaw = b && typeof b === "object" && typeof b.value === "string" ? b.value : b != null ? String(b) : "0";
  return {
    balanceJpy: Number(balanceRaw) || 0,
    balanceRaw,
    lastUsedAt,
    expiresAt,
    // 失効した後に使われていなければ「失効して0になった」状態（画面に出す）
    expiredAt: expiredAt && (!lastUsedAt || expiredAt >= lastUsedAt) ? expiredAt : null,
    expiryWarned: Boolean(lastUsedAt && item?.expiry_warned_for === lastUsedAt),
  };
}

/** TransactWrite の「台帳の行がすでにある」失敗か */
function isDuplicate(e) {
  return e?.name === "TransactionCanceledException" && (e.CancellationReasons ?? [])[0]?.Code === "ConditionalCheckFailed";
}

/** TransactWrite が取り消された理由（項目ごとの Code。[台帳の行, 財布] の順）。取り消し以外の失敗は null */
function cancelCodes(e) {
  return e?.name === "TransactionCanceledException" ? (e.CancellationReasons ?? []).map((r) => r?.Code ?? "None") : null;
}

// やり直せば通る取り消し。TransactionConflict は同じ財布への書き込みが同時に走ったとき（同じ持ち主の本体とアプリが同時に話し終えた、
// 会話と購入が重なった等）に負けた側へ返る。SDK はこれをやり直さない。取り消しは何も書かれていないので、同じ行をもう一度書いてよい
const RETRY_CODES = new Set(["TransactionConflict", "ThrottlingError", "ProvisionedThroughputExceeded"]);
// やり直す前の待ち（ミリ秒）。同時に負けた同士がまた重ならないよう、0.5〜1.5倍にばらす。全部待って2秒ほど
const RETRY_DELAYS_MS = [20, 40, 80, 160, 320, 640];

function isRetryable(e) {
  const codes = cancelCodes(e);
  return Boolean(codes) && !codes.includes("ConditionalCheckFailed") && codes.some((c) => RETRY_CODES.has(c));
}

/**
 * 台帳に1行足し（同じキーの行があれば失敗）、同じ額を残高に足す。1つのトランザクションで書く。
 * touch なら最終利用日（有効期限の起点）も今にする。同時の書き込みに負けたときはやり直す（RETRY_DELAYS_MS）
 */
async function appendAndAdd(ownerId, row, { touch }) {
  const now = new Date().toISOString();
  const input = {
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
  };
  for (let attempt = 0; ; attempt++) {
    try {
      await ddb.send(new TransactWriteCommand(input));
      return;
    } catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length || !isRetryable(e)) throw e;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt] * (0.5 + Math.random())));
    }
  }
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
 * expiresAt は最終利用日 + EXPIRY_DAYS（最終利用日が無い財布は null。段階3を出す前からある財布は最初の消費・購入か毎日の処理で起点が付く）。
 * expiredAt は失効して残高が0になった時刻（その後に使われていれば null）
 * @returns {Promise<{ balanceJpy: number, lastUsedAt: string|null, expiresAt: string|null, expiredAt: string|null, expiryWarned: boolean }>}
 */
export async function getWallet(ownerId) {
  if (!ownerId) return describeWallet(null);
  const r = await ddb.send(new GetCommand({ TableName: WALLETS_TABLE, Key: { owner_id: ownerId } }));
  return describeWallet(r.Item);
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
