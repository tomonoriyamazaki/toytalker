// 購入ページ本体（docs/pricing-and-cost-model.md 11.10）。残高を見せ、額を選び、最終確認を出してから Stripe Checkout へ送る。
// 残高に足すのは Webhook 経由のサーバーで、このページは何も足さない。
(function () {
  const A = window.ToyTalkerAuth;
  const cfg = window.TOYTALKER_BUY_CONFIG;
  const $ = (id) => document.getElementById(id);
  const yen = (n) => Math.floor(Number(n) || 0).toLocaleString("ja-JP");
  const MESSAGES = {
    login_required: "ログインの期限が切れました。もう一度ログインしてください。",
    bad_amount: "金額が正しくありません。",
    consent_outdated: "ページの内容が更新されました。再読み込みしてからやり直してください。",
    too_many_checkouts: "少し時間をおいてからもう一度お試しください。",
    not_found: "ページが見つかりません。",
  };

  function showError(msg) {
    const el = $("error");
    el.textContent = msg;
    el.hidden = !msg;
  }

  async function renderAccount() {
    const t = A.getToken();
    $("login").hidden = Boolean(t);
    $("account").hidden = !t;
    if (!t) return;
    $("email").textContent = t.email ?? "";
    try {
      const b = await A.api("GET", "/billing");
      $("balance").textContent = yen(b.balance_jpy);
      if (b.balance_jpy <= 0) $("balance").classList.add("empty");
      $("expiry").textContent = b.expires_at
        ? `有効期限: ${new Date(b.expires_at).toLocaleDateString("ja-JP")}（最後に使った日から1年。使うたびに延びます）`
        : "有効期限: 最初にポイントを使った日（または購入した日）から1年";
      const amounts = $("amounts");
      amounts.replaceChildren();
      for (const amt of b.buy_amounts) {
        const btn = document.createElement("button");
        btn.className = "primary";
        btn.textContent = `${yen(amt)}円分`;
        btn.addEventListener("click", () => showConfirm(amt));
        amounts.appendChild(btn);
      }
      if (b.consent_version !== cfg.CONSENT_VERSION) showError(MESSAGES.consent_outdated);
    } catch (e) {
      if (e.code === "login_required" || e.status === 401) { A.logout(); return renderAccount(); }
      showError(MESSAGES[e.code] ?? `残高を読めませんでした（${e.message}）`);
    }
  }

  let selected = null;
  function showConfirm(amount) {
    selected = amount;
    for (const el of document.querySelectorAll("#confirm .amount")) el.textContent = yen(amount);
    $("confirm").hidden = false;
    $("confirm").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function checkout() {
    if (!selected) return;
    const btn = $("checkout");
    btn.disabled = true;
    showError("");
    try {
      const r = await A.api("POST", "/billing/checkout", { amount_jpy: selected, consent_version: cfg.CONSENT_VERSION });
      location.href = r.url; // Stripe の画面へ。戻り先は done.html（成功）か index.html（やめた）
    } catch (e) {
      btn.disabled = false;
      if (e.code === "login_required" || e.status === 401) { A.logout(); return renderAccount(); }
      showError(MESSAGES[e.code] ?? `支払いの画面を開けませんでした（${e.message}）`);
    }
  }

  for (const b of document.querySelectorAll("#login button[data-provider]")) {
    b.addEventListener("click", () => A.login(b.dataset.provider).catch((e) => showError(e.message)));
  }
  $("logout").addEventListener("click", () => { A.logout(); selected = null; $("confirm").hidden = true; renderAccount(); });
  $("checkout").addEventListener("click", checkout);
  $("cancel").addEventListener("click", () => { selected = null; $("confirm").hidden = true; });

  if (!cfg.COGNITO_CLIENT_ID) showError("このページはまだ設定されていません（config.js の COGNITO_CLIENT_ID）。");
  renderAccount();
})();
