// 課金の処理（内向き。URL は無い。docs/pricing-and-cost-model.md 11.10）。入口は3つ:
//   1. SQS: billing-app が署名を確かめて入れた Stripe のイベント ID。中身は信じず、ID で Stripe から取り直してから処理する
//   2. スケジュール { task: "auto-charge" }（5分ごと。段階3b）: 残高が条件を下回った家庭の買い足し
//   3. スケジュール { task: "expire" }（毎日。段階3c）: 有効期限
// この Lambda だけが台帳に purchase / refund / dispute / expire を書き、off-session の請求を出す。
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { ensureSecrets, secret } from "../shared/secrets.mjs";
import { recordStripeRow } from "../shared/wallet.mjs";
import { getBilling, updateBilling, BUY_AMOUNTS, AUTO_AMOUNT_OPTIONS } from "../shared/billing.mjs";
import { stripeClient, StripeError } from "../shared/stripe.mjs";
import { startTrace } from "../shared/trace.mjs";

const sns = new SNSClient({});
const OPS_TOPIC_ARN = process.env.OPS_SNS_TOPIC_ARN;
const LIVEMODE = process.env.STRIPE_LIVEMODE === "true";

export const handler = async (event, context) => {
  await ensureSecrets();
  if (Array.isArray(event?.Records) && event.Records[0]?.eventSource === "aws:sqs") return handleQueue(event, context);
  if (event?.task === "auto-charge" || event?.task === "expire") {
    // 段階3b / 3c で実装。スケジュールだけ先に置いても何もしない
    console.log(JSON.stringify({ kind: "billing-worker", task: event.task, status: "not_implemented" }));
    return { ok: true };
  }
  console.warn("[billing-worker] unknown event:", JSON.stringify(event).slice(0, 200));
  return { ok: false };
};

/** SQS は1件ずつ（batchSize 1）だが、形は複数件に対応しておく。失敗した件だけ再試行させる（reportBatchItemFailures） */
async function handleQueue(event, context) {
  const batchItemFailures = [];
  for (const record of event.Records) {
    const trace = startTrace("billing-worker", { context });
    trace.set({ message_id: record.messageId, receive_count: Number(record.attributes?.ApproximateReceiveCount) || null });
    try {
      const { id } = JSON.parse(record.body ?? "{}");
      if (typeof id !== "string" || !id.startsWith("evt_")) {
        trace.set({ status: "dropped", reason: "bad_message" });
        continue; // 形が違うものは再試行しても直らない
      }
      await processEvent(id, trace);
    } catch (e) {
      trace.error("event", e);
      trace.set({ status: "retry" });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    } finally {
      trace.finish();
    }
  }
  return { batchItemFailures };
}

async function processEvent(eventId, trace) {
  const stripe = stripeClient(secret("STRIPE_KEY_WORKER"), (s, info) => trace.ext(s, info));
  let ev;
  try {
    ev = await stripe.get(`/events/${eventId}`);
  } catch (e) {
    if (e instanceof StripeError && e.status === 404) {
      // Stripe に無い ID（偽のメッセージか、30日より古い）。再試行しても出てこない
      trace.set({ status: "dropped", reason: "unknown_event" });
      return;
    }
    throw e;
  }
  trace.set({ stripe_event: ev.id, stripe_type: ev.type, livemode: ev.livemode });
  if (Boolean(ev.livemode) !== LIVEMODE) {
    trace.set({ status: "dropped", reason: "livemode_mismatch" });
    return;
  }
  const obj = ev.data?.object ?? {};
  switch (ev.type) {
    case "payment_intent.succeeded": return onPaymentSucceeded(stripe, obj, trace);
    case "payment_intent.payment_failed": return onPaymentFailed(obj, trace);
    case "checkout.session.completed": return onCheckoutCompleted(stripe, obj, trace);
    case "charge.refunded": return onChargeRefunded(stripe, obj, trace);
    case "charge.dispute.created": return onDisputeCreated(stripe, obj, trace);
    default:
      trace.set({ status: "ignored" });
  }
}

/**
 * 支払い完了 → 台帳に purchase を書いて残高に足す。足す相手は PaymentIntent の metadata の owner_id で、
 * Customer の metadata の owner_id と一致することを確かめる。足す額は amount_received（通貨は jpy、額は決まった選択肢のどれか）。
 */
async function onPaymentSucceeded(stripe, pi, trace) {
  const ownerId = pi.metadata?.owner_id;
  const kind = pi.metadata?.kind;
  trace.set({ owner_id: ownerId ?? null, payment_intent: pi.id, purchase_kind: kind ?? null, amount: pi.amount_received, currency: pi.currency }); // ログの kind（billing-worker）と衝突しないよう purchase_kind
  if (!ownerId || pi.status !== "succeeded" || pi.currency !== "jpy") {
    trace.set({ status: "dropped", reason: "unexpected_payment_intent" });
    await notifyOps("purchase_rejected", { payment_intent: pi.id, reason: "unexpected_payment_intent" });
    return;
  }
  const amount = Number(pi.amount_received);
  const allowed = kind === "buy" ? BUY_AMOUNTS : kind === "auto" ? AUTO_AMOUNT_OPTIONS : [];
  if (!allowed.includes(amount)) {
    trace.set({ status: "dropped", reason: "unexpected_amount" });
    await notifyOps("purchase_rejected", { payment_intent: pi.id, reason: "unexpected_amount", amount, kind });
    return;
  }
  if (pi.customer) {
    const customer = await stripe.get(`/customers/${pi.customer}`);
    if (customer.metadata?.owner_id !== ownerId) {
      trace.set({ status: "dropped", reason: "owner_mismatch" });
      await notifyOps("purchase_rejected", { payment_intent: pi.id, reason: "owner_mismatch" });
      return;
    }
  }
  const written = await recordStripeRow({
    ownerId, type: "purchase", stripeId: pi.id, createdUnix: pi.created, amountJpy: amount,
    detail: {
      kind, sub: pi.metadata?.sub, stripe_customer_id: pi.customer ?? undefined,
      charge_id: pi.latest_charge ?? undefined, consent_version: pi.metadata?.consent_version,
    },
  });
  trace.set({ status: written ? "recorded" : "duplicate" });
  if (kind === "auto" && written) {
    // 段階3b: 今月の額に足し、予約を消す（予約 ID は PaymentIntent の metadata.reservation）
    const row = await getBilling(ownerId);
    const month = jstMonth();
    await updateBilling(ownerId, {
      auto_month: month,
      auto_charged_jpy: (row?.auto_month === month ? Number(row.auto_charged_jpy) || 0 : 0) + amount,
      auto_last_charged_at: new Date().toISOString(),
      auto_reservation: null,
      auto_last_error: null,
    });
  }
}

/** 自動の買い足しが失敗（カードの期限切れ・authentication_required など）→ 止めて理由を残す（段階3b。単発の失敗は Stripe の画面で見えるので何もしない） */
async function onPaymentFailed(pi, trace) {
  const ownerId = pi.metadata?.owner_id;
  trace.set({ owner_id: ownerId ?? null, payment_intent: pi.id, purchase_kind: pi.metadata?.kind ?? null, error_code: pi.last_payment_error?.code ?? null });
  if (!ownerId || pi.metadata?.kind !== "auto") { trace.set({ status: "ignored" }); return; }
  await updateBilling(ownerId, {
    auto_status: "failed",
    auto_last_error: pi.last_payment_error?.code ?? pi.last_payment_error?.decline_code ?? "payment_failed",
    auto_reservation: null,
  });
  trace.set({ status: "recorded" });
}

/** Checkout の完了。段階3a は purchase を payment_intent.succeeded で扱うので、ここで足すことはしない。setup モード（カードの保存）は段階3b */
async function onCheckoutCompleted(stripe, session, trace) {
  trace.set({ checkout_session: session.id, mode: session.mode, owner_id: session.metadata?.owner_id ?? null });
  if (session.mode !== "setup") { trace.set({ status: "ignored" }); return; }
  trace.set({ status: "not_implemented" }); // 段階3b
}

/** 返金（運用者が Stripe のダッシュボードで行う）→ 台帳に refund。部分返金が複数あっても refund ごとに1行 */
async function onChargeRefunded(stripe, charge, trace) {
  const pi = await paymentIntentOf(stripe, charge.payment_intent);
  const ownerId = pi?.metadata?.owner_id;
  trace.set({ owner_id: ownerId ?? null, payment_intent: pi?.id ?? null, charge: charge.id });
  if (!ownerId) { trace.set({ status: "dropped", reason: "no_owner" }); return; }
  // API 版 2022-11-15 以降、charge に refunds は同梱されない（Webhook は 2026-10-28）。/refunds から取り直す（鍵に Refunds の Read が要る）
  const refunds = charge.refunds?.data ?? (await stripe.get(`/refunds?charge=${encodeURIComponent(charge.id)}&limit=100`)).data ?? [];
  let written = 0;
  for (const r of refunds) {
    if (r.status && r.status !== "succeeded") continue;
    if (await recordStripeRow({
      ownerId, type: "refund", stripeId: r.id, createdUnix: r.created, amountJpy: -Number(r.amount),
      detail: { payment_intent_id: pi.id, charge_id: charge.id, reason: r.reason ?? undefined },
    })) written++;
  }
  trace.set({ status: "recorded", refunds: refunds.length, written });
}

/** チャージバック → 台帳に dispute（購入額のマイナス）、オートチャージを止め、運用者へメール（11.7） */
async function onDisputeCreated(stripe, dispute, trace) {
  const pi = await paymentIntentOf(stripe, dispute.payment_intent);
  const ownerId = pi?.metadata?.owner_id;
  trace.set({ owner_id: ownerId ?? null, payment_intent: pi?.id ?? null, dispute: dispute.id, amount: dispute.amount, reason: dispute.reason ?? null });
  if (!ownerId) {
    trace.set({ status: "dropped", reason: "no_owner" });
    await notifyOps("dispute_unmatched", { dispute: dispute.id, payment_intent: dispute.payment_intent ?? null });
    return;
  }
  const written = await recordStripeRow({
    ownerId, type: "dispute", stripeId: dispute.id, createdUnix: dispute.created, amountJpy: -Number(dispute.amount),
    detail: { payment_intent_id: pi.id, charge_id: dispute.charge ?? undefined, reason: dispute.reason ?? undefined },
  });
  if (written) {
    const row = await getBilling(ownerId);
    if (row?.auto_enabled) await updateBilling(ownerId, { auto_enabled: false, auto_status: "stopped_by_dispute" });
    await notifyOps("dispute_created", { owner_id: ownerId, dispute: dispute.id, payment_intent: pi.id, amount: dispute.amount, reason: dispute.reason ?? null });
  }
  trace.set({ status: written ? "recorded" : "duplicate" });
}

async function paymentIntentOf(stripe, id) {
  if (!id) return null;
  return stripe.get(`/payment_intents/${id}`);
}

/** 日本時間の年月 "YYYY-MM"（月の上限の区切り） */
function jstMonth(now = Date.now()) {
  return new Date(now + 9 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

/** 運用者へメール（月次レポートと同じ SNS トピック）。個人情報は入れない（owner_id と Stripe の ID だけ） */
async function notifyOps(subject, detail) {
  if (!OPS_TOPIC_ARN) return;
  try {
    await sns.send(new PublishCommand({
      TopicArn: OPS_TOPIC_ARN,
      Subject: `[ToyTalker billing] ${subject}`,
      Message: `${subject}\n\n${JSON.stringify(detail, null, 2)}\n\nStripe のダッシュボードで ID を検索して確認してください。`,
    }));
  } catch (e) {
    console.error("[billing-worker] notify failed:", e?.name ?? e);
  }
}
