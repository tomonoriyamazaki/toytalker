import * as AuthSession from "expo-auth-session";
import * as WebBrowser from "expo-web-browser";
import * as SecureStore from "expo-secure-store";
import { useEffect, useState } from "react";
import { API_BASE_URL } from "./api";
import { getStoredOwnerId, setOwnerId } from "../hooks/useOwnerId";

/**
 * ログイン（ロードマップ4、docs/auth.md）。
 * Cognito のログイン画面（managed login。Google / Sign in with Apple のボタンが並ぶ）を認可コード + PKCE で開き、
 * ID トークンを `x-toytalker-token` ヘッダーで Lambda へ送る（app/lib/api.ts）。
 * トークンは SecureStore（キーチェーン）に置き、期限（1時間）が近づいたらリフレッシュトークン（180日）で取り直す。
 * 値は CDK の出力（`cdk deploy` の UserPoolClientId / AuthDomain）。環境を変えるときは EAS の env で上書きする。
 */
export const COGNITO_DOMAIN = process.env.EXPO_PUBLIC_COGNITO_DOMAIN ?? "toytalker-auth-rnd.auth.ap-northeast-1.amazoncognito.com";
export const COGNITO_CLIENT_ID = process.env.EXPO_PUBLIC_COGNITO_CLIENT_ID ?? "j7mibe6i3eop4r2sakbgs52e5"; // RnD のアプリ用クライアント（cdk deploy の出力 UserPoolClientId、2026-10-29）
/** トークンを載せるヘッダー名。backend/shared/auth.mjs の TOKEN_HEADER と同じ */
export const TOKEN_HEADER = "x-toytalker-token";
const REDIRECT_URI = "toytalk://auth/callback"; // app.json の scheme。CDK の callbackUrls と同じ
const LOGOUT_URI = "toytalk://auth/signout";
const SESSION_KEY = "auth_session";
const REFRESH_MARGIN_MS = 60 * 1000;

const discovery: AuthSession.DiscoveryDocument = {
  authorizationEndpoint: `https://${COGNITO_DOMAIN}/oauth2/authorize`,
  tokenEndpoint: `https://${COGNITO_DOMAIN}/oauth2/token`,
  revocationEndpoint: `https://${COGNITO_DOMAIN}/oauth2/revoke`,
  endSessionEndpoint: `https://${COGNITO_DOMAIN}/logout`,
};

export type Provider = "Google" | "SignInWithApple";

export type Session = {
  idToken: string;
  accessToken: string;
  refreshToken: string | null;
  /** ID トークンの期限（ミリ秒） */
  expiresAt: number;
  email: string | null;
  provider: string | null;
};

let session: Session | null | undefined; // undefined = まだ読んでいない
let loading: Promise<Session | null> | null = null;
let refreshing: Promise<string | null> | null = null;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

export const authConfigured = (): boolean => COGNITO_CLIENT_ID.length > 0;

/** JWT の payload（検証はしない。表示用。検証は Lambda が行う） */
function decodePayload(jwt: string): Record<string, unknown> {
  try {
    const part = jwt.split(".")[1] ?? "";
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(part.length / 4) * 4, "=");
    return JSON.parse(globalThis.atob(b64));
  } catch {
    return {};
  }
}

function providerOf(payload: Record<string, unknown>): string | null {
  const ids = payload.identities;
  if (Array.isArray(ids) && ids[0]?.providerName) return String(ids[0].providerName);
  if (typeof ids === "string") {
    try { const p = JSON.parse(ids); if (Array.isArray(p) && p[0]?.providerName) return String(p[0].providerName); } catch {}
  }
  return "cognito";
}

function toSession(t: AuthSession.TokenResponse, previous?: Session | null): Session | null {
  if (!t.idToken || !t.accessToken) return null;
  const payload = decodePayload(t.idToken);
  const exp = typeof payload.exp === "number" ? payload.exp * 1000 : Date.now() + (t.expiresIn ?? 3600) * 1000;
  return {
    idToken: t.idToken,
    accessToken: t.accessToken,
    refreshToken: t.refreshToken ?? previous?.refreshToken ?? null,
    expiresAt: exp,
    email: typeof payload.email === "string" ? payload.email : previous?.email ?? null,
    provider: providerOf(payload),
  };
}

async function save(next: Session | null): Promise<void> {
  session = next;
  try {
    if (next) await SecureStore.setItemAsync(SESSION_KEY, JSON.stringify(next), { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK });
    else await SecureStore.deleteItemAsync(SESSION_KEY);
  } catch (e) {
    console.warn("[auth] save failed:", (e as Error)?.message);
  }
  notify();
}

async function load(): Promise<Session | null> {
  if (session !== undefined) return session;
  loading ??= (async () => {
    try {
      const raw = await SecureStore.getItemAsync(SESSION_KEY);
      session = raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      session = null;
    }
    return session;
  })();
  return loading;
}

/** 現在のセッション（表示用）。未ログインなら null */
export async function getSession(): Promise<Session | null> {
  return load();
}

/**
 * 有効な ID トークン。期限が近ければリフレッシュして返す。未ログイン・リフレッシュ失敗なら null（未ログインとして扱う）。
 * 同時に呼ばれてもリフレッシュは1回にまとめる
 */
export async function getIdToken(): Promise<string | null> {
  const s = await load();
  if (!s) return null;
  if (s.expiresAt - REFRESH_MARGIN_MS > Date.now()) return s.idToken;
  if (!s.refreshToken || !authConfigured()) return null;
  refreshing ??= (async () => {
    try {
      const t = await AuthSession.refreshAsync({ clientId: COGNITO_CLIENT_ID, refreshToken: s.refreshToken! }, discovery);
      const next = toSession(t, s);
      await save(next);
      return next?.idToken ?? null;
    } catch (e) {
      console.warn("[auth] refresh failed:", (e as Error)?.message);
      // リフレッシュトークンの期限切れ・失効。ログアウト状態にする（本番ではログインし直し）
      await save(null);
      return null;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/**
 * ログイン。provider を渡すとその IdP の画面へ直接飛ぶ（省略時は Cognito の選択画面）。
 * 成功したら設定Lambda の GET /me で端末の owner_id をアカウントに結び付け、サーバーが別の owner_id を返したら端末側も差し替える
 * （すでに他のアカウントのものだった owner_id は引き継げない。docs/auth.md）。
 * 戻り値はセッション。利用者が画面を閉じたら null
 */
export async function signIn(provider?: Provider): Promise<Session | null> {
  if (!authConfigured()) throw new Error("ログインの設定（EXPO_PUBLIC_COGNITO_CLIENT_ID）がありません");
  const request = new AuthSession.AuthRequest({
    clientId: COGNITO_CLIENT_ID,
    redirectUri: REDIRECT_URI,
    responseType: AuthSession.ResponseType.Code,
    scopes: ["openid", "email", "profile"],
    usePKCE: true,
    extraParams: provider ? { identity_provider: provider } : {},
  });
  let result = await request.promptAsync(discovery);
  if (result.type === "error" && /already found an entry/i.test(result.params?.error_description ?? "")) {
    // Cognito の既知の癖: 2社目のログインで既存の利用者にリンクした直後の1回目はエラーになり、もう一度で通る（docs/auth.md）
    console.log("[auth] linked to existing user, retrying sign-in");
    result = await request.promptAsync(discovery);
  }
  if (result.type !== "success") {
    if (result.type === "error") throw new Error(result.params?.error_description ?? result.error?.message ?? "ログインに失敗しました");
    return null; // cancel / dismiss
  }
  const token = await AuthSession.exchangeCodeAsync(
    { clientId: COGNITO_CLIENT_ID, code: result.params.code, redirectUri: REDIRECT_URI, extraParams: { code_verifier: request.codeVerifier ?? "" } },
    discovery,
  );
  const next = toSession(token);
  if (!next) throw new Error("トークンを受け取れませんでした");
  await save(next);
  await linkAccount(next.idToken);
  return next;
}

/** GET /me で端末の owner_id をアカウントへ結び付ける。失敗しても例外にしない（次の要求で Lambda が同じことをする） */
async function linkAccount(idToken: string): Promise<void> {
  try {
    const local = await getStoredOwnerId();
    const res = await fetch(`${API_BASE_URL}/me?owner_id=${encodeURIComponent(local ?? "")}`, { headers: { [TOKEN_HEADER]: idToken } });
    const me = await res.json();
    if (res.ok && typeof me?.owner_id === "string" && me.owner_id !== local) {
      console.log("[auth] owner_id replaced by server:", me.owner_id);
      await setOwnerId(me.owner_id);
    }
  } catch (e) {
    console.warn("[auth] link failed:", (e as Error)?.message);
  }
}

/** ログアウト。リフレッシュトークンを失効させ、端末のセッションを消す。Cognito 側のログイン状態（ブラウザの cookie）も消す */
export async function signOut(): Promise<void> {
  const s = await load();
  await save(null);
  if (!s || !authConfigured()) return;
  try {
    if (s.refreshToken) await AuthSession.revokeAsync({ clientId: COGNITO_CLIENT_ID, token: s.refreshToken }, discovery);
  } catch (e) {
    console.warn("[auth] revoke failed:", (e as Error)?.message);
  }
  try {
    const url = `${discovery.endSessionEndpoint}?client_id=${encodeURIComponent(COGNITO_CLIENT_ID)}&logout_uri=${encodeURIComponent(LOGOUT_URI)}`;
    await WebBrowser.openAuthSessionAsync(url, LOGOUT_URI);
  } catch {
    // ブラウザを開けなくても端末側は消えている
  }
}

/** 画面用。セッションの変化を追う */
export function useAuthSession(): { session: Session | null; ready: boolean } {
  const [state, setState] = useState<{ session: Session | null; ready: boolean }>({ session: session ?? null, ready: session !== undefined });
  useEffect(() => {
    let alive = true;
    const update = () => { if (alive) setState({ session: session ?? null, ready: true }); };
    load().then(update);
    listeners.add(update);
    return () => { alive = false; listeners.delete(update); };
  }, []);
  return state;
}
