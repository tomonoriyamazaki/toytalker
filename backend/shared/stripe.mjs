// Stripe の呼び出し（docs/pricing-and-cost-model.md 11.10）。SDK は使わず REST を fetch で呼ぶ（依存を増やさない。
// 使うのは Checkout Session・Customer・PaymentIntent・Event の数本だけ）。
// 鍵は呼び出し側が SSM から読んで渡す（backend/shared/secrets.mjs）。app 用と worker 用で別の restricted key。
import { createHmac, timingSafeEqual } from "node:crypto";

const API = "https://api.stripe.com/v1";
/** Webhook の署名の時刻の許容（秒）。古い要求の再送を弾く（Stripe の推奨は5分） */
const SIGNATURE_TOLERANCE_SEC = 300;

export class StripeError extends Error {
  constructor(status, body, path) {
    const err = body?.error ?? {};
    super(`Stripe ${status} ${path}: ${err.type ?? ""} ${err.code ?? ""} ${err.message ?? ""}`.trim());
    this.name = "StripeError";
    this.status = status;
    this.code = err.code ?? null;
    this.type = err.type ?? null;
    this.param = err.param ?? null;
    /** card_error のとき（カードの拒否理由。insufficient_funds など） */
    this.declineCode = err.decline_code ?? null;
    /** 請求の失敗（402）に添えられる PaymentIntent の ID（off-session の買い足しで、どの請求が落ちたか） */
    this.paymentIntentId = err.payment_intent?.id ?? null;
  }
}

/**
 * @param {string} secretKey  rk_… / sk_…
 * @param {(service: string, info: object) => void} [onCall]  trace.ext（status と ms を記録する）
 */
export function stripeClient(secretKey, onCall) {
  if (!secretKey) throw new Error("Stripe の鍵が無い");
  async function call(method, path, params, { idempotencyKey } = {}) {
    const headers = { Authorization: `Bearer ${secretKey}` };
    let url = `${API}${path}`;
    let body;
    if (method === "GET") {
      const q = encodeForm(params ?? {});
      if (q) url += `?${q}`;
    } else {
      headers["Content-Type"] = "application/x-www-form-urlencoded";
      body = encodeForm(params ?? {});
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
    }
    const t0 = Date.now();
    const res = await fetch(url, { method, headers, body });
    const json = await res.json().catch(() => ({}));
    onCall?.("stripe", { path: path.replace(/\/[a-z]+_[A-Za-z0-9]+/g, "/…"), status: res.status, ms: Date.now() - t0 });
    if (!res.ok) throw new StripeError(res.status, json, path);
    return json;
  }
  return {
    get: (path, params) => call("GET", path, params),
    post: (path, params, opts) => call("POST", path, params, opts),
  };
}

/** 入れ子のオブジェクトを Stripe の form 形式（metadata[owner_id]=…、line_items[0][price_data][currency]=…）にする */
export function encodeForm(obj) {
  const pairs = [];
  const walk = (prefix, v) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((item, i) => walk(`${prefix}[${i}]`, item));
    else if (typeof v === "object") for (const [k, item] of Object.entries(v)) walk(prefix ? `${prefix}[${k}]` : k, item);
    else pairs.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
  };
  walk("", obj);
  return pairs.join("&");
}

/**
 * Webhook の署名（Stripe-Signature: t=…,v1=…）を確かめる。合えば本文を JSON にして返し、合わなければ null。
 * HMAC-SHA256(`${t}.${rawBody}`, secret) を v1 と比べる。時刻が許容を超えて古い要求も弾く。
 * @param {string} rawBody  受け取ったままの本文（JSON にし直した文字列では署名が合わない）
 * @param {string} header   Stripe-Signature ヘッダー
 * @param {string} secret   whsec_…
 */
export function verifyWebhook(rawBody, header, secret, nowSec = Math.floor(Date.now() / 1000)) {
  if (!rawBody || !header || !secret) return null;
  let t = null;
  const v1 = [];
  for (const part of header.split(",")) {
    const [k, v] = part.trim().split("=");
    if (k === "t") t = Number(v);
    else if (k === "v1" && v) v1.push(v);
  }
  if (!Number.isFinite(t) || v1.length === 0) return null;
  if (Math.abs(nowSec - t) > SIGNATURE_TOLERANCE_SEC) return null;
  const expected = createHmac("sha256", secret).update(`${t}.${rawBody}`, "utf8").digest("hex");
  const ok = v1.some((sig) => sig.length === expected.length && timingSafeEqual(Buffer.from(sig, "utf8"), Buffer.from(expected, "utf8")));
  if (!ok) return null;
  try { return JSON.parse(rawBody); } catch { return null; }
}

/** Lambda Function URL のイベントから受け取ったままの本文を取り出す（base64 のことがある） */
export function rawBodyOf(event) {
  if (typeof event?.body !== "string") return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}
