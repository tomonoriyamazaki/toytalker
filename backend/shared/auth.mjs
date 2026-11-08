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
//     （= アプリでログインして登録していない）機器を拒む（deviceGate）。なりすまし防止はデバイス鍵（checkDeviceKey。下の説明）。
//   - ログには auth の結果（none / user / invalid）と owner_id だけ書く。メールアドレスは書かない。
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
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
// 受け付けるクライアント（トークンの aud）。アプリのクライアントに加え、購入ページの Web クライアント（COGNITO_WEB_CLIENT_ID）を
// 配られた Lambda（billing-app だけ）はそれも通す。他の Lambda は Web のトークンを受け付けない
const CLIENT_IDS = [CLIENT_ID, process.env.COGNITO_WEB_CLIENT_ID || ""].filter(Boolean);
const USERS_TABLE = tableName("users");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
// JWKS（公開鍵）は初回検証で取りに行き、容器の間は保持する。鍵が替わったら自動で取り直す（ライブラリの既定）
const verifier = USER_POOL_ID && CLIENT_ID
  ? CognitoJwtVerifier.create({ userPoolId: USER_POOL_ID, tokenUse: "id", clientId: CLIENT_IDS })
  : null;

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

// ---- デバイス鍵（脅威モデル #2 のなりすまし防止。docs/security-review-2026-10-25.md、ロードマップ6） ----
// 本体（0.7.6 から。ファームの DeviceAuth.h）は初回起動時に 32 バイトの乱数鍵を作って NVS に持ち、16進64文字で DEVICE_KEY_HEADER に添える。
// サーバーは devices の行に SHA-256（16進）だけを device_key_hash として持つ。鍵そのものはどこにも保存せず、ログにも出さない。
//   - 行にハッシュがある: 一致を要求する。鍵が無い・違う要求は 403（鍵の無い旧ファームもこの1台は通らなくなる）。
//   - 行にハッシュが無い: 鍵付きなら初回を信じて保存する（TOFU）。鍵の無い要求（旧ファーム）は通す。
//     登録を閉じた後（DEVICE_KEY_ENROLL=false。両配布機が 0.7.6 以降になったら。infra/config/stages.ts の deviceKeyEnroll）は、
//     ハッシュの無い行への要求を鍵の有無にかかわらず 403 にする。
//   - 行が無い（未登録機・DynamoDB の失敗）: 照合しない（保存先が無い）。本番の拒否は deviceGate。
//   - 保存するのは鍵発行 Lambda（toytalk-soniox-stt-lambda。起動時に必ず最初に呼ばれ、devices の UpdateItem 権限がある）だけ。
//     会話・相槌の Lambda は devices を読むだけなので、ハッシュの無い行への鍵付き要求は保存せずに通す（device_key: pending）。
// 漏れた・NVS を消したときは、その1行の device_key_hash を消すと次の鍵付き要求で登録し直される（登録を閉じていれば止まったまま）。

/** 鍵を載せるヘッダー名（小文字）。CloudFront のオリジン要求ポリシー（infra/lib/toytalker-stack.ts）にも同じ名前がある */
export const DEVICE_KEY_HEADER = "x-toytalker-device-key";
/** ハッシュの無い行に初回登録を許すか（環境変数 DEVICE_KEY_ENROLL。CDK が stages.ts から配る。未設定は許す） */
export const DEVICE_KEY_ENROLL = process.env.DEVICE_KEY_ENROLL !== "false";
const DEVICES_TABLE = tableName("devices");
const DEVICE_KEY_RE = /^[0-9a-f]{64}$/;

/** 要求のデバイス鍵のハッシュ。鍵が無ければ null、形が違えば "malformed" */
export function presentedDeviceKeyHash(event) {
  const headers = event?.headers ?? {};
  const raw = headers[DEVICE_KEY_HEADER] ?? headers[DEVICE_KEY_HEADER.toUpperCase()] ?? null;
  if (raw == null || raw === "") return null;
  const key = String(raw).trim();
  if (!DEVICE_KEY_RE.test(key)) return "malformed";
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function sameHash(a, b) {
  const x = Buffer.from(String(a), "utf8");
  const y = Buffer.from(String(b), "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * デバイス鍵の照合。例外は投げない（DynamoDB の失敗は会話を止めず通す）。
 * @param event Lambda のイベント（ヘッダーを読む）
 * @param deviceRow devices の行（null は未登録か読み取り失敗）
 * @param options.enroll ハッシュの無い行に保存するか（devices の UpdateItem 権限がある Lambda だけ true）
 * @returns {Promise<{ gate: null|{statusCode:number,error:string}, log: object }>} log は trace.set にそのまま渡す
 *   device_key: match | enrolled | pending（鍵付き・ハッシュなしで保存せず通した）| missing（鍵なし・ハッシュなしで通した）| unregistered
 *               | mismatch | required | malformed | closed | enroll_failed
 *   device_key_fp: ハッシュの先頭8文字（ファームのシリアル [DEVKEY] fingerprint と同じ値。鍵の推測には使えない）
 */
export async function checkDeviceKey(event, deviceRow, { enroll = false } = {}) {
  const presented = presentedDeviceKeyHash(event);
  const fp = presented && presented !== "malformed" ? { device_key_fp: presented.slice(0, 8) } : {};
  const deny = (result, error) => ({ gate: { statusCode: 403, error }, log: { device_key: result, ...fp } });
  const pass = (result) => ({ gate: null, log: { device_key: result, ...fp } });

  if (!deviceRow) return pass("unregistered");
  if (presented === "malformed") return deny("malformed", "device_key_invalid");

  const stored = typeof deviceRow.device_key_hash === "string" && deviceRow.device_key_hash ? deviceRow.device_key_hash : null;
  if (stored) {
    if (!presented) return deny("required", "device_key_required");
    return sameHash(stored, presented) ? pass("match") : deny("mismatch", "device_key_mismatch");
  }
  if (!DEVICE_KEY_ENROLL) return deny("closed", "device_key_not_enrolled");
  if (!presented) return pass("missing");
  if (!enroll) return pass("pending");

  // 初回登録。同時に来た別の要求（鍵発行と相槌など）が同じ鍵を先に書いていても通るよう、同じ値なら条件を満たす
  try {
    await ddb.send(new UpdateCommand({
      TableName: DEVICES_TABLE,
      Key: { device_id: deviceRow.device_id },
      UpdateExpression: "SET device_key_hash = :h, device_key_enrolled_at = :t",
      ConditionExpression: "attribute_exists(device_id) AND (attribute_not_exists(device_key_hash) OR device_key_hash = :h)",
      ExpressionAttributeValues: { ":h": presented, ":t": new Date().toISOString() },
    }));
    return pass("enrolled");
  } catch (e) {
    // 別の鍵が先に登録された（同じ MAC を名乗る2台が同時に初回を迎えた）。後から来た方は通さない
    if (e?.name === "ConditionalCheckFailedException") return deny("mismatch", "device_key_mismatch");
    console.warn("[auth] device key enroll failed:", e?.name, e?.message);
    return pass("enroll_failed");
  }
}

/**
 * devices への書き込み（端末の報告など）を、鍵が合う要求だけに絞る条件。UpdateCommand の ConditionExpression に AND で足す。
 * 鍵付きなら「ハッシュが無いか一致」、鍵なしなら「ハッシュが無い」。値は ExpressionAttributeValues に混ぜる
 */
export function deviceKeyWriteCondition(event) {
  const presented = presentedDeviceKeyHash(event);
  if (presented && presented !== "malformed") {
    return { expression: "(attribute_not_exists(device_key_hash) OR device_key_hash = :dkh)", values: { ":dkh": presented } };
  }
  return { expression: "attribute_not_exists(device_key_hash)", values: {} };
}

/** devices の行をアプリへ返すときの形。ハッシュは返さず、登録済みかだけを返す */
export function publicDeviceRow(row) {
  if (!row) return row;
  const { device_key_hash, ...rest } = row;
  return { ...rest, device_key_registered: !!device_key_hash };
}

/** ログに書く項目（docs/roadmap.md の9。メールアドレスと sub は書かない） */
export function describeAuth(identity) {
  return { auth: identity.auth, ...(identity.reason ? { auth_reason: identity.reason } : {}), ...(identity.provider ? { auth_provider: identity.provider } : {}) };
}

/**
 * users の行。毎回読む（容器内キャッシュはしない。2026-10-30決定）。
 * 読み取りは 5〜15ms で会話1ターン（2〜5秒）に埋もれる一方、キャッシュすると運用で owner_id を付け替えたとき
 * 容器ごとに答えが違う時間が生まれ、古い ID でログが書かれる。キャッシュしてよいのは変わらないもの（JWKS）か、
 * 遅れても困らないもの（SSM の鍵）だけ
 */
async function findBySub(sub) {
  const res = await ddb.send(new GetCommand({ TableName: USERS_TABLE, Key: { sub } }));
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
  // 持つのは対応と時刻だけ。メールアドレスと「どの会社で入れるか」は Cognito が正本（利用者の email / identities）。
  // 写しを作ると古くなり（リンクで会社が増える）、個人情報の置き場所も増える（2026-10-30決定）
  const item = { sub: identity.sub, owner_id: ownerId, created_at: now, last_login_at: now };
  try {
    await ddb.send(new PutCommand({ TableName: USERS_TABLE, Item: item, ConditionExpression: "attribute_not_exists(#s)", ExpressionAttributeNames: { "#s": "sub" } }));
    return { ownerId, user: item, created: true };
  } catch (e) {
    if (e?.name !== "ConditionalCheckFailedException") throw e;
    // 同時に2本の要求が初回登録に来た。先に書かれた行を使う
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
