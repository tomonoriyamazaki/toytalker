// 課金 API（外向き。docs/pricing-and-cost-model.md 11.10）。購入ページ（web/site/buy/）から呼ばれる。
//
//   GET  /billing                 残高・有効期限・カード・オートチャージの状態（Cognito のトークン必須。RnD でも必須）
//   POST /billing/checkout        単発の購入。{ amount_jpy } は 500 / 1,000 / 3,000 のどれか。Stripe Checkout の URL を返す
//   POST /billing/webhook         Stripe の Webhook。署名を確かめ、イベント ID だけを SQS に入れる（中身の処理は billing-worker）
//
// 守り: この Lambda は台帳に書けず、off-session の請求もできない（鍵は Checkout と Customer だけの restricted key）。
// 残高に足す相手・額はクライアントの値を使わない（相手はトークン、額は Stripe の PaymentIntent）。
// Function URL は IAM 認証にしない（Stripe は署名用の x-amz-content-sha256 を付けられない）。守りはトークンと Webhook の署名。
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ensureSecrets, secret } from "../shared/secrets.mjs";
import { getWallet } from "../shared/wallet.mjs";
import { getBilling, updateBilling, describeBilling, BUY_AMOUNTS, CONSENT_VERSION, CHECKOUT_MIN_INTERVAL_MS } from "../shared/billing.mjs";
import { stripeClient, verifyWebhook, rawBodyOf } from "../shared/stripe.mjs";
import { startTrace, describeClient } from "../shared/trace.mjs";
import { authenticate, authGate, describeAuth, resolveOwner } from "../shared/auth.mjs";

const sqs = new SQSClient({});
const QUEUE_URL = process.env.BILLING_QUEUE_URL;
/** 購入ページの URL（末尾スラッシュ無し）。Checkout の戻り先と CORS に使う */
const BUY_PAGE_URL = (process.env.BUY_PAGE_URL ?? "").replace(/\/$/, "");
/** 本番の鍵か（Stripe のイベントの livemode と比べる。sandbox のイベントが本番に、またはその逆に混ざらないように） */
const LIVEMODE = process.env.STRIPE_LIVEMODE === "true";

/** worker が扱うイベント。それ以外は受け取っても SQS に入れない */
const FORWARDED_EVENTS = new Set([
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "checkout.session.completed",
  "charge.refunded",
  "charge.dispute.created",
]);

const response = (statusCode, body) => ({
  statusCode,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const handler = async (event, context) => {
  const method = event.requestContext?.http?.method ?? "GET";
  const path = event.rawPath ?? "/";
  const trace = startTrace("billing", { event, context });
  trace.set({ method, path, ...describeClient(event, {}) });
  try {
    await ensureSecrets();
    trace.mark("secrets");
    let result;
    if (method === "POST" && path === "/billing/webhook") {
      result = await webhook(event, trace);
    } else {
      result = await api(method, path, event, trace);
    }
    trace.set({ status: result.statusCode });
    return result;
  } catch (err) {
    trace.error("handler", err);
    trace.set({ status: 500 });
    return response(500, { error: "internal_error" });
  } finally {
    trace.finish();
  }
};

// ---- Stripe の Webhook ----
async function webhook(event, trace) {
  const raw = rawBodyOf(event);
  const sig = event.headers?.["stripe-signature"] ?? event.headers?.["Stripe-Signature"];
  const ev = verifyWebhook(raw, sig, secret("STRIPE_WEBHOOK_SECRET"));
  if (!ev) {
    trace.set({ reason: "bad_signature" });
    return response(400, { error: "bad_signature" });
  }
  trace.set({ stripe_event: ev.id, stripe_type: ev.type, livemode: ev.livemode });
  if (Boolean(ev.livemode) !== LIVEMODE) {
    // 違う環境の鍵で作ったイベント。受け取ったことにして（200）再送を止めるが、処理はしない
    trace.set({ reason: "livemode_mismatch" });
    return response(200, { received: true, ignored: "livemode" });
  }
  if (!FORWARDED_EVENTS.has(ev.type)) return response(200, { received: true, ignored: "type" });
  // 中身は渡さない。worker が ID で Stripe から取り直す（この Lambda が乗っ取られて偽の中身を入れられても効かない）
  await sqs.send(new SendMessageCommand({ QueueUrl: QUEUE_URL, MessageBody: JSON.stringify({ id: ev.id, type: ev.type }) }));
  trace.mark("queued");
  return response(200, { received: true });
}

// ---- 利用者向け API ----
async function api(method, path, event, trace) {
  const identity = await authenticate(event);
  trace.set(describeAuth(identity));
  const denied = authGate(identity);
  if (denied) {
    trace.set({ reason: denied.error });
    return response(denied.statusCode, { error: denied.error });
  }
  // お金を扱うので、RnD（トークン無しも通す環境）でもログインを必須にする
  if (identity.auth !== "user") {
    trace.set({ reason: "login_required" });
    return response(401, { error: "login_required" });
  }
  const who = await resolveOwner(identity);
  const ownerId = who.ownerId;
  trace.set({ owner_id: ownerId });
  trace.mark("auth");

  if (method === "GET" && path === "/billing") {
    const [wallet, billing] = await Promise.all([getWallet(ownerId), getBilling(ownerId)]);
    return response(200, {
      balance_jpy: Math.round(wallet.balanceJpy * 1000) / 1000,
      last_used_at: wallet.lastUsedAt,
      expires_at: wallet.expiresAt,
      buy_amounts: BUY_AMOUNTS,
      consent_version: CONSENT_VERSION,
      ...describeBilling(billing),
    });
  }

  if (method === "POST" && path === "/billing/checkout") {
    let body = {};
    try { body = JSON.parse(rawBodyOf(event) || "{}"); } catch { body = {}; }
    const amount = Number(body.amount_jpy);
    if (!BUY_AMOUNTS.includes(amount)) {
      trace.set({ reason: "bad_amount" });
      return response(400, { error: "bad_amount" });
    }
    if (body.consent_version !== CONSENT_VERSION) {
      // 購入ページが古い（文言が変わった）。読み直してもらう
      trace.set({ reason: "consent_outdated" });
      return response(409, { error: "consent_outdated" });
    }
    const throttled = await throttleCheckout(ownerId);
    if (throttled) {
      trace.set({ reason: "too_many_checkouts" });
      return response(429, { error: "too_many_checkouts" });
    }
    const stripe = stripeClient(secret("STRIPE_KEY_APP"), (s, info) => trace.ext(s, info));
    let session;
    try {
      const customerId = await ensureCustomer(stripe, ownerId, identity);
      trace.mark("customer");
      session = await createCheckout(stripe, { ownerId, identity, amount, customerId });
    } catch (e) {
      // 失敗した試行は1分制限に数えない（印を外してから投げ直す）
      await updateBilling(ownerId, { last_checkout_at: null }).catch(() => {});
      throw e;
    }
    trace.mark("checkout");
    return response(200, { url: session.url });
  }

  trace.set({ reason: "not_found" });
  return response(404, { error: "not_found" });
}

/** 単発購入の Checkout セッション。額はサーバーが決めた値だけ */
function createCheckout(stripe, { ownerId, identity, amount, customerId }) {
  return stripe.post("/checkout/sessions", {
      mode: "payment",
      customer: customerId,
      locale: "ja",
      line_items: [{
        quantity: 1,
        price_data: {
          currency: "jpy",
          unit_amount: amount,
          product_data: { name: `ToyTalker ポイント ${amount.toLocaleString("ja-JP")}円分` },
        },
      }],
      // 残高に足すときの手掛かり。worker はこの metadata の owner_id と Customer の metadata を突き合わせる
      payment_intent_data: {
        description: `ToyTalker points ${amount} JPY`,
        metadata: { owner_id: ownerId, sub: identity.sub, kind: "buy", consent_version: CONSENT_VERSION },
      },
      // 特商法の最終確認（11.7）。自分のページにも出すが、実際の「支払う」は Stripe の画面にあるので要点をここにも
      custom_text: {
        submit: { message: "ポイントは1ポイント=1円で、最後に使った日から1年間有効です。購入後の返金は原則できません（詳しくは利用規約）。" },
      },
      // 利用規約への同意（本番だけ）。Stripe の設定（公開情報）の利用規約 URL（購入ページの terms.html）が要り、
      // sandbox は事業者情報を入れられないので付けない（2026-11-03）。同意は自分の確認画面でも取っている
      ...(LIVEMODE ? { consent_collection: { terms_of_service: "required" } } : {}),
      success_url: `${BUY_PAGE_URL}/done.html`,
      cancel_url: `${BUY_PAGE_URL}/index.html`,
  });
}

/** Checkout の作成を CHECKOUT_MIN_INTERVAL_MS に1回に絞る。絞られたら true */
async function throttleCheckout(ownerId) {
  const now = Date.now();
  try {
    await updateBilling(ownerId, { last_checkout_at: new Date(now).toISOString() }, {
      condition: "attribute_not_exists(#last_checkout_at) OR #last_checkout_at < :cutoff",
      names: { "#last_checkout_at": "last_checkout_at" },
      values: { ":cutoff": new Date(now - CHECKOUT_MIN_INTERVAL_MS).toISOString() },
    });
    return false;
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") return true;
    throw e;
  }
}

/**
 * この owner_id の Stripe Customer。無ければ作って billing に書く。
 * Customer にはログインのメールを入れる（Stripe の領収書メールの宛先。段階4のプッシュまでの親への知らせ）。
 * 手元のテーブルにはメールを持たない（docs/auth.md と同じ方針）。
 */
async function ensureCustomer(stripe, ownerId, identity) {
  const row = await getBilling(ownerId);
  if (row?.stripe_customer_id) return row.stripe_customer_id;
  const customer = await stripe.post("/customers", {
    email: identity.email ?? undefined,
    metadata: { owner_id: ownerId, sub: identity.sub },
  }, { idempotencyKey: `customer:${ownerId}` }); // 同時に2回呼ばれても Customer は1つ
  try {
    await updateBilling(ownerId, { stripe_customer_id: customer.id }, {
      condition: "attribute_not_exists(#c)", names: { "#c": "stripe_customer_id" },
    });
    return customer.id;
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
    return (await getBilling(ownerId)).stripe_customer_id; // 先に書かれた方を使う
  }
}

