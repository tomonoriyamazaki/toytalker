// 購入ページのログイン（Cognito の managed login、認可コード + PKCE。公開クライアントなので秘密は無い）。
// トークンは sessionStorage（タブを閉じれば消える）。リフレッシュトークンは使わず、切れたらログインし直す。
// アプリ（app/lib/auth.ts）と同じプール・同じ IdP で、クライアントだけ Web 用（infra の WebClient）。
(function () {
  const cfg = window.TOYTALKER_BUY_CONFIG;
  const KEY = "toytalker.buy.token";
  const redirectUri = `${location.origin}/buy/callback.html`;

  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const randomString = (n) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const sha256 = async (text) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

  async function login(provider) {
    const verifier = randomString(48);
    const state = randomString(16);
    sessionStorage.setItem("toytalker.buy.pkce", JSON.stringify({ verifier, state }));
    const p = new URLSearchParams({
      client_id: cfg.COGNITO_CLIENT_ID,
      response_type: "code",
      scope: "openid email profile",
      redirect_uri: redirectUri,
      state,
      code_challenge: b64url(await sha256(verifier)),
      code_challenge_method: "S256",
    });
    if (provider) p.set("identity_provider", provider);
    location.href = `${cfg.COGNITO_DOMAIN}/oauth2/authorize?${p}`;
  }

  /** callback.html で呼ぶ。code をトークンに替えて保存し、購入ページへ戻る */
  async function handleCallback() {
    const q = new URLSearchParams(location.search);
    const saved = JSON.parse(sessionStorage.getItem("toytalker.buy.pkce") || "null");
    sessionStorage.removeItem("toytalker.buy.pkce");
    if (q.get("error")) throw new Error(`ログインできませんでした（${q.get("error")}）`);
    const code = q.get("code");
    if (!code || !saved || q.get("state") !== saved.state) throw new Error("ログインの状態が一致しません。もう一度ログインしてください");
    const res = await fetch(`${cfg.COGNITO_DOMAIN}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", client_id: cfg.COGNITO_CLIENT_ID, code, redirect_uri: redirectUri, code_verifier: saved.verifier }),
    });
    if (!res.ok) throw new Error(`トークンを受け取れませんでした（${res.status}）`);
    const tokens = await res.json();
    const payload = JSON.parse(atob(tokens.id_token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    sessionStorage.setItem(KEY, JSON.stringify({ id_token: tokens.id_token, exp: payload.exp, email: payload.email ?? null }));
  }

  /** 有効な ID トークン。無い・切れていれば null */
  function getToken() {
    try {
      const t = JSON.parse(sessionStorage.getItem(KEY) || "null");
      if (!t || !t.id_token || t.exp * 1000 < Date.now() + 30_000) return null;
      return t;
    } catch { return null; }
  }

  function logout() {
    sessionStorage.removeItem(KEY);
  }

  const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

  /**
   * 課金 API を呼ぶ。トークンは x-toytalker-token（Authorization は CloudFront の OAC が上書きする）。
   * 本文のある要求は SHA-256 を x-amz-content-sha256 で添える（app/lib/api.ts と同じ）
   */
  async function api(method, path, body) {
    const t = getToken();
    if (!t) throw Object.assign(new Error("login_required"), { code: "login_required" });
    const headers = { "x-toytalker-token": t.id_token };
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      headers["Content-Type"] = "application/json";
      headers["x-amz-content-sha256"] = hex(await sha256(payload));
    }
    const res = await fetch(`${cfg.API_BASE}${path}`, { method, headers, body: payload });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || `HTTP ${res.status}`), { code: json.error || `http_${res.status}`, status: res.status });
    return json;
  }

  window.ToyTalkerAuth = { login, handleCallback, getToken, logout, api };
})();
