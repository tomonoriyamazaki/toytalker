// 利用者認証（ロードマップ4、docs/auth.md）。全Lambda共通で、esbuildが各バンドルへ取り込む。
//
// 方針:
//   - 本人確認は Cognito の ID トークン（JWT）を Lambda の中で検証する（aws-jwt-verify。JWKS は容器内にキャッシュ）。
//     音声の経路にネットワーク越しの認証（API Gateway オーソライザー等）を挟まない。
//   - トークンは `Authorization` でなく `x-toytalker-token` ヘッダーで送る（CloudFront の OAC が Authorization を署名で上書きするため）。
//   - 認証必須かは環境ごと（infra/config/stages.ts の auth.required → 環境変数 AUTH_REQUIRED）。
//       本番: トークン無しは 401 で即終了（LLM は走らない）。
//       RnD:  トークン無しも通し（従来どおりクライアントの自称 owner_id を使う）、ログに auth: "none" を残す。
//             トークン付きなら本番と同じに検証するので、動作確認は RnD でできる。
//     不正・期限切れのトークンはどの環境でも 401（auth: "invalid"）。
//   - Cognito の sub → owner_id の対応は DynamoDB `toytalker-users`（pk: sub）。owner_id は内部IDのまま残す。
//     アカウントの owner_id は初回ログイン時に新しく発行する（端末の owner_id とは別。2026-10-30決定。
//     端末の ID は「ログインしていない人」の仮の ID で、アカウントの ID は端末に依存しない「人」の ID。
//     ログイン前のデータは引き継がない。本番はログイン必須なのでゲストのデータは最初から無い。RnD の数人は users の行を手で書く）。
//   - ESP32 はログインしない。device_id だけ送り、Lambda が devices テーブルから所有者を引く。本番ではその行が無い
//     （= アプリでログインして登録していない）機器を拒む（deviceGate）。製造時のデバイス鍵は後で（docs/security-review-2026-10-25.md）。
//   - ログには auth の結果（none / user / invalid）と owner_id だけ書く。メールアドレスは書かない。
import { randomUUID } from "node:crypto";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { tableName } from "./tables.mjs";

/** トークンを載せるヘッダー名（小文字。Function URL はヘッダー名を小文字で渡す）。アプリは app/lib/api.ts */
export const TOKEN_HEADER = "x-toytalker-token";
/** 認証必須か（環境変数 AUTH_REQUIRED。CDK が stages.ts の auth.required から配る） */
export const AUTH_REQUIRED = process.env.AUTH_REQUIRED === "true";

const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || "";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID || "";
const USERS_TABLE = tableName("users");
const CACHE_MS = 5 * 60 * 1000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// JWKS（公開鍵）は初回検証で取りに行き、容器の間は保持する。鍵が替わったら自動で取り直す（ライブラリの既定）
const verifier = USER_POOL_ID && CLIENT_ID
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, tokenUse: "id", clientId: CLIENT_ID })
  : null;

/** sub → { ownerId, at } の容器内キャッシュ。5分で取り直す（owner_id は変わらないので長くてもよいが、削除に追従するため） */
const ownerCache = new Map();

/** ID トークンの出どころ（Google / SignInWithApple / cognito）。federated だと identities に入る */
function providerOf(payload) {
  const ids = payload.identities;
  if (Array.isArray(ids) && ids[0]?.providerName) return String(ids[0].providerName);
  if (typeof ids === "string") {
    try { const p = JSON.parse(ids); if (Array.isArray(p) && p[0]?.providerName) return String(p[0].providerName); } catch { /* ignore */ }
  }
  return "cognito";
}

/**
 * 要求のトークンを検証する。例外は投げない。
 * @returns {Promise<{ auth: "none"|"user"|"invalid", sub: string|null, email: string|null, provider: string|null, reason: string|null }>}
 */
export async function authenticate(event) {
  const headers = event?.headers ?? {};
  const token = headers[TOKEN_HEADER] ?? headers[TOKEN_HEADER.toUpperCase()] ?? null;
  const none = { auth: "none", sub: null, email: null, provider: null, reason: null };
  if (!token) return none;
  if (!verifier) return { ...none, auth: "invalid", reason: "verifier_not_configured" };
  try {
    const payload = await verifier.verify(String(token));
    return { auth: "user", sub: payload.sub, email: typeof payload.email === "string" ? payload.email : null, provider: providerOf(payload), reason: null };
  } catch (e) {
    // 期限切れ・署名不一致・別プールのトークンなど。ログにはエラー名だけ（JwtExpiredError / JwtInvalidSignatureError / JwtParseError …）
    return { ...none, auth: "invalid", reason: e?.name || "invalid_token" };
  }
}

/**
 * 認証の門。拒むなら { statusCode, error } を返し、通すなら null。
 * 本番（AUTH_REQUIRED）ではトークン無しを 401、どの環境でも不正なトークンを 401 にする。
 */
export function authGate(identity) {
  if (identity.auth === "invalid") return { statusCode: 401, error: "invalid_token" };
  if (identity.auth === "none" && AUTH_REQUIRED) return { statusCode: 401, error: "login_required" };
  return null;
}

/**
 * ESP32（device_id だけで来る要求）の門。本番では devices テーブルに行が無い機器を拒む
 * （登録はアプリのログイン後にしかできないので、登録済み = 持ち主がいる）。RnD は従来どおり通す。
 */
export function deviceGate(deviceRow) {
  if (AUTH_REQUIRED && !deviceRow) return { statusCode: 403, error: "device_not_registered" };
  return null;
}

/** ログに書く項目（docs/roadmap.md の9。メールアドレスと sub は書かない） */
export function describeAuth(identity) {
  return { auth: identity.auth, ...(identity.reason ? { auth_reason: identity.reason } : {}), ...(identity.provider ? { auth_provider: identity.provider } : {}) };
}

async function findBySub(sub) {
  const cached = ownerCache.get(sub);
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.item;
  const res = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { sub } }));
  if (res.Item) ownerCache.set(sub, { item: res.Item, at: Date.now() });
  return res.Item ?? null;
}

/**
 * この要求で使う owner_id を決める。
 *   - auth "user": users テーブルの行。無ければ新しい owner_id を発行して作る（初回ログイン）。クライアントが名乗る owner_id は使わない。
 *   - auth "none"（RnD でトークン無し）: claimedOwnerId（端末の仮の ID）をそのまま返す（従来の自称方式）。
 * @returns {Promise<{ ownerId: string|null, user: object|null, created: boolean }>}
 */
export async function resolveOwner(identity, claimedOwnerId) {
  const claimed = typeof claimedOwnerId === "string" && claimedOwnerId ? claimedOwnerId : null;
  if (identity.auth !== "user") return { ownerId: claimed, user: null, created: false };

  const existing = await findBySub(identity.sub);
  if (existing) return { ownerId: existing.owner_id, user: existing, created: false };

  const ownerId = `u_${randomUUID()}`;
  const now = new Date().toISOString();
  const item = { sub: identity.sub, owner_id: ownerId, email: identity.email, provider: identity.provider, created_at: now, last_login_at: now };
  try {
    await ddb.send(new PutCommand({ TableName: USERS_TABLE, Item: item, ConditionExpression: "attribute_not_exists(#s)", ExpressionAttributeNames: { "#s": "sub" } }));
    ownerCache.set(identity.sub, { item, at: Date.now() });
    return { ownerId, user: item, created: true };
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
    // 同時に2本の要求が初回登録に来た。先に書かれた行を使う
    ownerCache.delete(identity.sub);
    const row = await findBySub(identity.sub);
    return { ownerId: row?.owner_id ?? null, user: row, created: false };
  }
}

/**
 * 読むだけの版（相槌Lambdaが使う。users テーブルに行を作らない）。auth "user" で行が無ければ ownerId は null
 */
export async function lookupOwner(identity, claimedOwnerId) {
  const claimed = typeof claimedOwnerId === "string" && claimedOwnerId ? claimedOwnerId : null;
  if (identity.auth !== "user") return { ownerId: claimed, user: null };
  const row = await findBySub(identity.sub);
  return { ownerId: row?.owner_id ?? null, user: row };
}

/** 行の所有者が本人か system か（キャラクター・ボイスを使ってよいか）。トークン無しのときは見ない */
export function canUse(identity, ownerId, rowOwnerId) {
  if (identity.auth !== "user") return true;
  return !rowOwnerId || rowOwnerId === "system" || rowOwnerId === ownerId;
}

/** ログイン時刻を記す（設定Lambdaの GET /me だけが呼ぶ。失敗しても要求は通す） */
export async function touchLogin(sub) {
  try {
    await ddb.send(new UpdateCommand({
      TableName: USERS_TABLE, Key: { sub },
      UpdateExpression: "SET last_login_at = :t", ExpressionAttributeValues: { ":t": new Date().toISOString() },
    }));
  } catch (e) {
    console.warn("[auth] touchLogin failed:", e?.name, e?.message);
  }
}

/**
 * 行の所有者と本人が一致するか。
 *   - auth "user": 行の owner_id が本人の owner_id と同じか（system の行は所有者なし = 不一致）。
 *   - auth "none": クライアントが owner_id を名乗っていれば一致を見る。名乗っていなければ requireClaim のとき 400、そうでなければ通す（従来）。
 * 拒むなら { statusCode, error } を返し、通すなら null。
 */
export function ownerGate(identity, ownerId, row, { requireClaim = false } = {}) {
  if (identity.auth === "user") {
    return row?.owner_id === ownerId ? null : { statusCode: 403, error: "not_owner" };
  }
  if (!ownerId) return requireClaim ? { statusCode: 400, error: "owner_id is required" } : null;
  return row?.owner_id === ownerId ? null : { statusCode: 403, error: "not_owner" };
}
