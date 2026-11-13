// 課金の設定（docs/pricing-and-cost-model.md 11.10）。テーブル `toytalker-billing`（owner_id がキー）に、Stripe の顧客・保存したカード・
// オートチャージの設定と状態を持つ。書けるのは課金の Lambda 2本（billing-app / billing-worker）だけで、本文 Lambda は読む権限も持たない
// （財布は本文 Lambda が毎ターン書くので、設定を同じ行に置かない）。
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { tableName } from "./tables.mjs";
import { dataClientConfig } from "./region.mjs";

const BILLING_TABLE = tableName("billing");
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(dataClientConfig), { marshallOptions: { removeUndefinedValues: true } });

/** 単発で買える額（円、税込み。11.1 / 11.9）。サーバーがこの中から決め、クライアントの自由な額は受け取らない */
export const BUY_AMOUNTS = [500, 1000, 3000];
/** オートチャージの選択肢（11.10）: 残高がこれを下回ったら / 1回に買い足す額 / 月の上限 */
export const AUTO_BELOW_OPTIONS = [100, 300, 500];
export const AUTO_AMOUNT_OPTIONS = [500, 1000, 3000];
export const AUTO_CAP_OPTIONS = [1000, 3000, 5000, 10000];
export const AUTO_CAP_DEFAULT = 3000;
/** 買い足しの cooldown（11.10）。条件 500円・額 500円のような組で、買い足した直後にまた下回って連続請求するのを防ぐ */
export const AUTO_COOLDOWN_MS = 60 * 60 * 1000;
/** これより古い予約（買い足し中の印）が残っていたら運用者へメール（Stripe の冪等キーの寿命も24時間） */
export const AUTO_RESERVATION_STALE_MS = 24 * 60 * 60 * 1000;
/** 最終確認画面と同意文の版（web/site/buy/ と合わせる）。文言を変えたら上げる（2026-11-07: オートチャージの項を追加） */
export const CONSENT_VERSION = "2026-11-07";
/** Checkout の作成をこの間隔に絞る（連打・自動化の抑止） */
export const CHECKOUT_MIN_INTERVAL_MS = 60 * 1000;

/**
 * オートチャージの設定（条件・1回の額・月の上限）を検査する。選択肢の中の値で、額 ≥ 条件、上限 ≥ 額 のときだけ通す。
 * 額 = 条件（500円 / 500円）でも、買い足した直後の残高は条件以上になり（判定は「残高 ≥ 条件なら何もしない」）、5分後に続けて請求はしない。
 * 残高がマイナスになり得る RnD は worker の1時間の cooldown が歯止め。
 * 利用者の入力（購入ページ）と Stripe の Checkout の metadata（worker。文字列で返る）の両方で使う
 * @returns {{ below: number, amount: number, cap: number } | null}
 */
export function parseAutoSettings(src) {
  const below = Number(src?.below_jpy);
  const amount = Number(src?.amount_jpy);
  const cap = Number(src?.monthly_cap_jpy);
  if (!AUTO_BELOW_OPTIONS.includes(below) || !AUTO_AMOUNT_OPTIONS.includes(amount) || !AUTO_CAP_OPTIONS.includes(cap)) return null;
  if (!(amount >= below) || !(cap >= amount)) return null;
  return { below, amount, cap };
}

/** オートチャージが有効な行を全部（5分ごとの買い足し）。家庭が数千を超えたら索引に替える（ロードマップ13） */
export async function listAutoEnabled() {
  const items = [];
  let ExclusiveStartKey;
  do {
    const r = await ddb.send(new ScanCommand({
      TableName: BILLING_TABLE,
      FilterExpression: "auto_enabled = :t",
      ExpressionAttributeValues: { ":t": true },
      ExclusiveStartKey,
    }));
    items.push(...(r.Items ?? []));
    ExclusiveStartKey = r.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return items;
}

/** 行。無ければ null */
export async function getBilling(ownerId) {
  if (!ownerId) return null;
  const r = await ddb.send(new GetCommand({ TableName: BILLING_TABLE, Key: { owner_id: ownerId } }));
  return r.Item ?? null;
}

/**
 * 列を SET で書く（無い行は作る）。undefined の列は触らない。null を渡すとその列を消す。
 * @param {string} ownerId
 * @param {object} fields
 * @param {{ condition?: string, values?: object, names?: object }} [opts]  条件付き更新（失敗は ConditionalCheckFailedException）
 */
export async function updateBilling(ownerId, fields, opts = {}) {
  const sets = [];
  const removes = [];
  const names = { ...(opts.names ?? {}) };
  const values = { ...(opts.values ?? {}), ":updated_at": new Date().toISOString() };
  sets.push("#updated_at = :updated_at");
  names["#updated_at"] = "updated_at";
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    names[`#${k}`] = k;
    if (v === null) { removes.push(`#${k}`); continue; }
    values[`:${k}`] = v;
    sets.push(`#${k} = :${k}`);
  }
  let UpdateExpression = `SET ${sets.join(", ")}`;
  if (removes.length > 0) UpdateExpression += ` REMOVE ${removes.join(", ")}`;
  const r = await ddb.send(new UpdateCommand({
    TableName: BILLING_TABLE,
    Key: { owner_id: ownerId },
    UpdateExpression,
    ConditionExpression: opts.condition,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
    ReturnValues: "ALL_NEW",
  }));
  return r.Attributes ?? null;
}

/** 画面に出す形（カードは brand と下4桁と期限だけ。Stripe の ID は出さない） */
export function describeBilling(row) {
  if (!row) return { card: null, auto: null };
  const card = row.payment_method_id
    ? { brand: row.card_brand ?? null, last4: row.card_last4 ?? null, exp: row.card_exp ?? null }
    : null;
  const auto = row.auto_enabled !== undefined
    ? {
        enabled: Boolean(row.auto_enabled),
        below_jpy: row.auto_below_jpy ?? null,
        amount_jpy: row.auto_amount_jpy ?? null,
        monthly_cap_jpy: row.auto_monthly_cap_jpy ?? null,
        charged_this_month_jpy: row.auto_charged_jpy ?? 0,
        status: row.auto_status ?? null,
        last_error: row.auto_last_error ?? null,
        consent_version: row.auto_consent?.version ?? null,
        consent_at: row.auto_consent?.at ?? null,
        charging: Boolean(row.auto_reservation), // 買い足しの請求中（Webhook 待ち）
        last_charged_at: row.auto_last_charged_at ?? null,
      }
    : null;
  return { card, auto };
}
