// 課金の処理（内向き。URL は無い。docs/pricing-and-cost-model.md 11.10）。入口は3つ:
//   1. SQS: billing-app が署名を確かめて入れた Stripe のイベント ID。中身は信じず、ID で Stripe から取り直してから処理する
//   2. スケジュール { task: "auto-charge" }（5分ごと。段階3b）: 残高が条件を下回った家庭の買い足し
//   3. スケジュール { task: "expire" }（毎日。段階3c）: 有効期限（最後に使った日から1年。335日で予告の記録、365日で失効）
// この Lambda だけが台帳に purchase / refund / dispute / expire を書き、off-session の請求を出す。
import { randomUUID } from "node:crypto";
import { SNSClient, PublishCommand } from "@aws-sdk/client-sns";
import { ensureSecrets, secret } from "../shared/secrets.mjs";
import {
  recordStripeRow, getBalance, listWallets, describeWallet, stampLastUsedAt, recordExpiryWarning, recordExpire,
  EXPIRY_DAYS, EXPIRY_WARN_DAYS,
} from "../shared/wallet.mjs";
import { jstDate } from "../shared/jst.mjs";
import {
  getBilling, updateBilling, listAutoEnabled, parseAutoSettings,
  BUY_AMOUNTS, AUTO_AMOUNT_OPTIONS, AUTO_COOLDOWN_MS, AUTO_RESERVATION_STALE_MS,
} from "../shared/billing.mjs";
import { stripeClient, StripeError } from "../shared/stripe.mjs";
import { startTrace } from "../shared/trace.mjs";

const sns = new SNSClient({});
const OPS_TOPIC_ARN = process.env.OPS_SNS_TOPIC_ARN;
const LIVEMODE = process.env.STRIPE_LIVEMODE === "true";

export const handler = async (event, context) => {
  await ensureSecrets();
  if (Array.isArray(event?.Records) && event.Records[0]?.eventSource === "aws:sqs") return handleQueue(event, context);
  if (event?.task === "auto-charge") return handleAutoCharge(context);
  if (event?.task === "expire") return handleExpire(context, { dryRun: event.dry_run === true });
  console.warn("[billing-worker] unknown event:", JSON.stringify(event).slice(0, 200));
  return { ok: false };
};

// ---- オートチャージの買い足し（5分ごと。11.10） ----

/**
 * billing の auto_enabled の行を全部見て、残高が条件を下回っている家庭に買い足しを出す。1家庭の失敗は他に波及させない。
 * 手元から `aws lambda invoke --payload '{"task":"auto-charge"}'` で同じことを1回だけ走らせられる
 */
async function handleAutoCharge(context) {
  const trace = startTrace("billing-worker", { context });
  trace.set({ task: "auto-charge" });
  const counts = { seen: 0, charged: 0, waiting: 0, skipped: 0, failed: 0 };
  try {
    const stripe = stripeClient(secret("STRIPE_KEY_WORKER"), (s, info) => trace.ext(s, info));
    const rows = await listAutoEnabled();
    counts.seen = rows.length;
    for (const row of rows) {
      try {
        const r = await autoChargeOne(stripe, row);
        counts[r] = (counts[r] ?? 0) + 1;
      } catch (e) {
        counts.failed++;
        console.error("[billing-worker] auto-charge error:", row.owner_id, e?.name ?? e, e?.message ?? "");
      }
    }
    trace.set({ status: "done", ...counts });
    return { ok: true, ...counts };
  } catch (e) {
    trace.error("auto-charge", e);
    trace.set({ status: "error", ...counts });
    throw e;
  } finally {
    trace.finish();
  }
}

/**
 * 1家庭の買い足し。残高 < 条件 なら予約して off-session で請求する。
 * 予約（auto_reservation）は「請求中」の印で、Webhook（成功か最終失敗）でしか消さない。古いからと外すと、請求は通ったのに
 * Lambda が落ちて印を消せなかったときに新しい ID で再請求して二重に引くため（11.10）。
 * @returns {Promise<"charged"|"waiting"|"skipped"|"cap_reached"|"declined">}
 */
async function autoChargeOne(stripe, row) {
  const ownerId = row.owner_id;
  const log = (status, extra = {}) => console.log(JSON.stringify({ kind: "billing-worker", task: "auto-charge", owner_id: ownerId, status, ...extra }));
  if (!row.auto_enabled || !row.stripe_customer_id || !row.payment_method_id) { log("skipped", { reason: "no_card" }); return "skipped"; }
  if (["failed", "stopped_by_dispute", "stopped"].includes(row.auto_status)) { log("skipped", { reason: row.auto_status }); return "skipped"; }
  const amount = Number(row.auto_amount_jpy);
  const below = Number(row.auto_below_jpy);
  const cap = Number(row.auto_monthly_cap_jpy);
  if (!AUTO_AMOUNT_OPTIONS.includes(amount) || !(below > 0) || !(cap >= amount)) { log("skipped", { reason: "bad_settings" }); return "skipped"; }

  const now = Date.now();
  const month = jstMonth(now);
  const reservation = row.auto_reservation;
  if (reservation) {
    // 請求中。Stripe に出した要求に答えが返っていれば Webhook を待つだけ。返っていなければ（Lambda が途中で落ちた・通信が切れた）
    // 同じ予約 ID を冪等キーにして同じ要求を出し直す（Stripe は同じ PaymentIntent を返す。24時間）
    const age = now - Date.parse(reservation.at ?? 0);
    if (age > AUTO_RESERVATION_STALE_MS) {
      if (!reservation.notified_at) {
        await notifyOps("auto_charge_stuck", { owner_id: ownerId, reservation: reservation.id, payment_intent: reservation.payment_intent ?? null, since: reservation.at });
        await updateBilling(ownerId, { auto_reservation: { ...reservation, notified_at: new Date(now).toISOString() } });
      }
      log("waiting", { reason: "stale", reservation: reservation.id });
      return "waiting";
    }
    if (reservation.payment_intent) { log("waiting", { reservation: reservation.id, payment_intent: reservation.payment_intent }); return "waiting"; }
    return charge(stripe, row, reservation, amount, log);
  }

  const balance = await getBalance(ownerId);
  if (balance >= below) return "skipped"; // 残高は足りている（ログは出さない。5分ごとに全家庭分出ると多い）

  const chargedThisMonth = row.auto_month === month ? Number(row.auto_charged_jpy) || 0 : 0;
  if (chargedThisMonth + amount > cap) {
    // 今月の上限に届く。知らせるだけ（段階4のプッシュ）で、月が変わればまた買い足す
    if (row.auto_status !== "cap_reached") await updateBilling(ownerId, { auto_status: "cap_reached", auto_month: month, auto_charged_jpy: chargedThisMonth });
    log("cap_reached", { charged_this_month: chargedThisMonth, cap });
    return "cap_reached";
  }
  const lastChargedAt = Date.parse(row.auto_last_charged_at ?? 0) || 0;
  if (now - lastChargedAt < AUTO_COOLDOWN_MS) { log("skipped", { reason: "cooldown" }); return "skipped"; }

  // 予約: 「予約が無い」「まだ有効」のときだけ印を書く（並走した実行や、その間に止めた操作と競合しないように）
  const newReservation = { id: randomUUID(), at: new Date(now).toISOString(), amount_jpy: amount, balance_jpy: balance };
  try {
    await updateBilling(ownerId, { auto_reservation: newReservation, auto_status: "active", auto_month: month, auto_charged_jpy: chargedThisMonth }, {
      condition: "attribute_not_exists(#r) AND #e = :t",
      names: { "#r": "auto_reservation", "#e": "auto_enabled" },
      values: { ":t": true },
    });
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") { log("skipped", { reason: "reservation_race" }); return "skipped"; }
    throw e;
  }
  return charge(stripe, row, newReservation, amount, log);
}

/** 予約済みの買い足しを Stripe に出す（off-session の MIT。冪等キーは予約 ID） */
async function charge(stripe, row, reservation, amount, log) {
  const ownerId = row.owner_id;
  try {
    const pi = await stripe.post("/payment_intents", {
      amount,
      currency: "jpy",
      customer: row.stripe_customer_id,
      payment_method: row.payment_method_id,
      off_session: true,
      confirm: true,
      description: `ToyTalker auto-charge ${amount} JPY`,
      metadata: {
        owner_id: ownerId, sub: row.auto_consent?.sub ?? undefined, kind: "auto",
        reservation: reservation.id, consent_version: row.auto_consent?.version ?? undefined,
      },
    }, { idempotencyKey: `auto-charge:${reservation.id}` });
    // 答えが返った印（PaymentIntent の ID）。残高に足す・予約を消すのは Webhook の payment_intent.succeeded（足す処理を1か所に）
    await updateBilling(ownerId, { auto_reservation: { ...reservation, payment_intent: pi.id, pi_status: pi.status } });
    log("charged", { reservation: reservation.id, payment_intent: pi.id, pi_status: pi.status, amount });
    return "charged";
  } catch (e) {
    if (e instanceof StripeError && e.status === 402) {
      // カードが拒否された・発行会社が追加認証を求めた（authentication_required）。請求は成立していないので止めて理由を残す。
      // Webhook の payment_intent.payment_failed も来るが、同じ内容を書くだけ。利用者は購入ページでカードを保存し直すと active に戻る
      await updateBilling(ownerId, { auto_status: "failed", auto_last_error: e.code ?? e.declineCode ?? "payment_failed", auto_reservation: null, auto_last_failed_at: new Date().toISOString() });
      log("declined", { reservation: reservation.id, payment_intent: e.paymentIntentId, error_code: e.code, decline_code: e.declineCode });
      return "declined";
    }
    // 通信の失敗や 5xx。予約は残し、次の5分で同じ冪等キーで出し直す
    throw e;
  }
}

// ---- 有効期限（毎日。11.10 段階3c） ----

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 財布を全部見て、最後に使った日（last_used_at）から 335日で予告を記録し、365日で台帳に expire を書いて残高を0にする。
 * 最終利用日が無い財布（段階3より前からあるもの）には、この処理が最初に見た日を起点として付ける（= 段階3を出した日から数える）。
 * 残高が0以下の財布は予告も失効もしない（失うものが無い）。1家庭の失敗は他に波及させない。失効させた家庭があれば運用者へ1通メール。
 * 失効させる前にオートチャージを止める（残高が0になると条件を満たし、1年使っていない家庭のカードに5分以内に請求が走るため。
 * 止める → 失効の順で、間に買い足しが入らないようにする。再開は購入ページから申し込み直し）。
 * 手元から `aws lambda invoke --payload '{"task":"expire"}'` で1回だけ走らせられる。`"dry_run": true` を付けると読むだけで何も書かない
 */
async function handleExpire(context, { dryRun = false } = {}) {
  const trace = startTrace("billing-worker", { context });
  trace.set({ task: "expire", dry_run: dryRun });
  const counts = { seen: 0, stamped: 0, warned: 0, expired: 0, changed: 0, skipped: 0, failed: 0, auto_stopped: 0 };
  const expiredOwners = [];
  try {
    const now = Date.now();
    const date = jstDate(new Date(now).toISOString());
    const stampAt = new Date(now).toISOString();
    const rows = await listWallets();
    counts.seen = rows.length;
    for (const row of rows) {
      const ownerId = row.owner_id;
      const log = (status, extra = {}) => console.log(JSON.stringify({ kind: "billing-worker", task: "expire", owner_id: ownerId, status, dry_run: dryRun, ...extra }));
      try {
        const w = describeWallet(row);
        if (!w.lastUsedAt) {
          // 起点が無い財布。今日を起点にする（残高が無くても付けて、以後の計算を1本にする）
          if (!dryRun) await stampLastUsedAt(ownerId, stampAt);
          counts.stamped++;
          log("stamped", { balance_jpy: w.balanceJpy });
          continue;
        }
        if (!(w.balanceJpy > 0)) { counts.skipped++; continue; }
        const ageDays = Math.floor((now - Date.parse(w.lastUsedAt)) / DAY_MS);
        if (ageDays >= EXPIRY_DAYS) {
          const autoStopped = dryRun ? false : await stopAutoChargeForExpiry(ownerId);
          if (autoStopped) counts.auto_stopped++;
          const r = dryRun ? "expired" : await recordExpire({ ownerId, date, balanceRaw: w.balanceRaw, lastUsedAt: w.lastUsedAt });
          counts[r === "duplicate" ? "skipped" : r]++;
          log(r, { balance_jpy: w.balanceJpy, last_used_at: w.lastUsedAt, age_days: ageDays, date, auto_stopped: autoStopped });
          if (r === "expired") expiredOwners.push({ owner_id: ownerId, balance_jpy: w.balanceJpy, last_used_at: w.lastUsedAt });
          continue;
        }
        if (ageDays >= EXPIRY_WARN_DAYS) {
          if (w.expiryWarned) { counts.skipped++; continue; } // この起点に対する予告は記録済み
          const ok = dryRun ? true : await recordExpiryWarning(ownerId, w.lastUsedAt);
          counts[ok ? "warned" : "changed"]++;
          log(ok ? "warned" : "changed", { balance_jpy: w.balanceJpy, last_used_at: w.lastUsedAt, age_days: ageDays, expires_at: w.expiresAt });
          continue;
        }
        counts.skipped++;
      } catch (e) {
        counts.failed++;
        console.error("[billing-worker] expire error:", ownerId, e?.name ?? e, e?.message ?? "");
      }
    }
    if (expiredOwners.length > 0 && !dryRun) {
      await notifyOps("points_expired", { date, count: expiredOwners.length, total_jpy: expiredOwners.reduce((a, o) => a + o.balance_jpy, 0), wallets: expiredOwners });
    }
    trace.set({ status: "done", ...counts });
    return { ok: true, date, ...counts };
  } catch (e) {
    trace.error("expire", e);
    trace.set({ status: "error", ...counts });
    throw e;
  } finally {
    trace.finish();
  }
}

/**
 * 失効の前にオートチャージを止める。有効なら auto_enabled: false・auto_status: stopped_by_expiry（カードと設定は残す。再開は申し込み直し）。
 * 失効の書き込みが「財布が動いていた」で見送られた場合も止めたままにする（365日放置した財布がその瞬間に使われるのは稀で、再開は利用者がすぐできる）
 * @returns {Promise<boolean>} 止めたら true
 */
async function stopAutoChargeForExpiry(ownerId) {
  const billing = await getBilling(ownerId);
  if (!billing?.auto_enabled) return false;
  await updateBilling(ownerId, { auto_enabled: false, auto_status: "stopped_by_expiry", auto_stopped_at: new Date().toISOString() });
  return true;
}

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
    // 今月の額に足し、この請求の予約を消す（予約 ID は PaymentIntent の metadata.reservation。別の予約なら触らない）
    const row = await getBilling(ownerId);
    const month = jstMonth();
    const mine = row?.auto_reservation?.id === pi.metadata?.reservation;
    await updateBilling(ownerId, {
      auto_month: month,
      auto_charged_jpy: (row?.auto_month === month ? Number(row.auto_charged_jpy) || 0 : 0) + amount,
      auto_last_charged_at: new Date().toISOString(),
      auto_reservation: mine ? null : undefined,
      auto_last_error: null,
    });
    trace.set({ reservation_cleared: mine });
  }
}

/** 自動の買い足しが失敗（カードの期限切れ・authentication_required など）→ 止めて理由を残す。単発の失敗は Stripe の画面で見えるので何もしない */
async function onPaymentFailed(pi, trace) {
  const ownerId = pi.metadata?.owner_id;
  trace.set({ owner_id: ownerId ?? null, payment_intent: pi.id, purchase_kind: pi.metadata?.kind ?? null, error_code: pi.last_payment_error?.code ?? null });
  if (!ownerId || pi.metadata?.kind !== "auto") { trace.set({ status: "ignored" }); return; }
  const row = await getBilling(ownerId);
  const mine = row?.auto_reservation?.id === pi.metadata?.reservation;
  await updateBilling(ownerId, {
    auto_status: "failed",
    auto_last_error: pi.last_payment_error?.code ?? pi.last_payment_error?.decline_code ?? "payment_failed",
    auto_last_failed_at: new Date().toISOString(),
    auto_reservation: mine ? null : undefined,
  });
  trace.set({ status: "recorded", reservation_cleared: mine });
}

/**
 * Checkout の完了。単発（payment モード）は purchase を payment_intent.succeeded で扱うので、ここでは何もしない。
 * setup モード（オートチャージの申し込み・設定変更）: 保存したカードと設定・同意を billing に書いて active にし、
 * その場で残高が条件を下回っていれば買い足しをすぐ出す（残高0から始まる本体の持ち主が、申し込んだ直後に話せるように）。
 * 設定はセッションの metadata（billing-app が検査して載せた値。Stripe から取り直したもの）から読み、ここでも検査する。
 */
async function onCheckoutCompleted(stripe, session, trace) {
  const ownerId = session.metadata?.owner_id;
  trace.set({ checkout_session: session.id, mode: session.mode, owner_id: ownerId ?? null });
  if (session.mode !== "setup") { trace.set({ status: "ignored" }); return; }
  const settings = parseAutoSettings(session.metadata);
  if (!ownerId || session.metadata?.kind !== "auto_setup" || !settings || !session.setup_intent || !session.customer) {
    trace.set({ status: "dropped", reason: "unexpected_session" });
    await notifyOps("auto_setup_rejected", { checkout_session: session.id, reason: "unexpected_session" });
    return;
  }
  // SetupIntent（カード）を取り直す。鍵に Setup Intents と Payment Methods の Read が要る
  const si = await stripe.get(`/setup_intents/${session.setup_intent}`, { "expand[]": "payment_method" });
  const pm = si.payment_method;
  trace.set({ setup_intent: si.id, si_status: si.status, si_usage: si.usage, pm_type: pm?.type ?? null });
  if (si.status !== "succeeded" || si.usage !== "off_session" || !pm?.id || si.customer !== session.customer) {
    trace.set({ status: "dropped", reason: "unexpected_setup_intent" });
    await notifyOps("auto_setup_rejected", { checkout_session: session.id, setup_intent: si.id, reason: "unexpected_setup_intent", si_status: si.status, si_usage: si.usage });
    return;
  }
  const customer = await stripe.get(`/customers/${session.customer}`);
  if (customer.metadata?.owner_id !== ownerId) {
    trace.set({ status: "dropped", reason: "owner_mismatch" });
    await notifyOps("auto_setup_rejected", { checkout_session: session.id, reason: "owner_mismatch" });
    return;
  }
  const row = await getBilling(ownerId);
  if (row?.auto_status === "stopped_by_dispute") {
    // 申し込みは billing-app が弾くが、チャージバックの前に始めたセッションが後から完了することはある
    trace.set({ status: "dropped", reason: "stopped_by_dispute" });
    return;
  }
  if (row?.stripe_customer_id && row.stripe_customer_id !== session.customer) {
    trace.set({ status: "dropped", reason: "customer_mismatch" });
    await notifyOps("auto_setup_rejected", { checkout_session: session.id, reason: "customer_mismatch" });
    return;
  }
  const consentAt = new Date((Number(session.created) || 0) * 1000).toISOString();
  const card = pm.card ?? {};
  try {
    await updateBilling(ownerId, {
      stripe_customer_id: session.customer,
      payment_method_id: pm.id,
      card_brand: card.brand ?? pm.type ?? null,
      card_last4: card.last4 ?? null,
      card_exp: card.exp_month && card.exp_year ? `${String(card.exp_month).padStart(2, "0")}/${card.exp_year}` : null,
      auto_enabled: true,
      auto_below_jpy: settings.below,
      auto_amount_jpy: settings.amount,
      auto_monthly_cap_jpy: settings.cap,
      auto_consent: { version: session.metadata.consent_version ?? null, at: consentAt, sub: session.metadata.sub ?? null, setup_intent: si.id, checkout_session: session.id },
      auto_status: "active",
      auto_last_error: null,
      auto_stopped_at: null,
    }, {
      // 古いセッションの完了が新しいものの後に届いても、新しい同意を上書きしない
      condition: "attribute_not_exists(#c) OR attribute_not_exists(#c.#at) OR #c.#at <= :at",
      names: { "#c": "auto_consent", "#at": "at" },
      values: { ":at": consentAt },
    });
  } catch (e) {
    if (e?.name === "ConditionalCheckFailedException") { trace.set({ status: "dropped", reason: "older_than_current" }); return; }
    throw e;
  }
  trace.set({ status: "recorded", auto_below: settings.below, auto_amount: settings.amount, auto_cap: settings.cap });
  // 申し込んだ直後の買い足し（残高が条件を下回っていれば）。失敗しても申し込みは済んでいるので、次の5分の回に任せる
  try {
    const fresh = await getBilling(ownerId);
    const r = await autoChargeOne(stripe, fresh);
    trace.set({ first_charge: r });
  } catch (e) {
    trace.error("first_charge", e);
  }
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
