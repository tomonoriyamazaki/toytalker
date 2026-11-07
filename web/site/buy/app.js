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
    bad_settings: "条件と金額の組み合わせが正しくありません。",
    auto_blocked: "このアカウントではオートチャージを申し込めません。お問い合わせください（support@zakicorp.com）。",
    not_found: "ページが見つかりません。",
  };
  const AUTO_ERRORS = {
    authentication_required: "カード会社が追加の確認を求めたため購入できませんでした",
    card_declined: "カード会社が支払いを承認しませんでした",
    expired_card: "カードの有効期限が切れています",
    insufficient_funds: "カードの残高・限度額が足りませんでした",
  };
  let billing = null;

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
      billing = b;
      renderAuto(b);
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

  // ---- オートチャージ ----
  const cardText = (card) => (card ? `${card.brand ?? "カード"} •••• ${card.last4 ?? ""}${card.exp ? `（期限 ${card.exp}）` : ""}` : "");

  /** 状態の表示。設定は GET /billing の auto（サーバーの値）だけから出す */
  function renderAuto(b) {
    const a = b.auto;
    const st = $("auto-status");
    const detail = $("auto-detail");
    const settings = a ? `残高が ${yen(a.below_jpy)}円を下回ったら ${yen(a.amount_jpy)}円分を購入（月 ${yen(a.monthly_cap_jpy)}円まで。今月 ${yen(a.charged_this_month_jpy)}円）` : "";
    let text = "未設定です。";
    let sub = "";
    let canStop = false;
    if (a && a.enabled) {
      canStop = true;
      if (a.status === "cap_reached") { text = "有効（今月の上限に達したため、今月はこれ以上自動では購入しません）"; }
      else if (a.status === "failed") { text = "停止中: 購入できなかったため止まっています。"; sub = `理由: ${AUTO_ERRORS[a.last_error] ?? a.last_error ?? "不明"}。「設定を変える」からカードを登録し直すと再開します。`; }
      else if (a.charging) { text = "有効（いま買い足しを進めています）"; }
      else { text = "有効"; }
      sub = [settings, cardText(b.card), sub].filter(Boolean).join("。");
    } else if (a && a.status === "stopped_by_dispute") {
      text = "停止中: カード会社からの支払い異議により止まっています。お問い合わせください（support@zakicorp.com）。";
    } else if (a && a.status === "stopped") {
      text = "止めています。";
      sub = `以前の設定: ${settings}。再開するには申し込み直してください（カードの登録もやり直します）。`;
    }
    st.textContent = text;
    detail.textContent = sub;
    $("auto-open").textContent = a && a.enabled ? "設定を変える" : "申し込む";
    $("auto-open").hidden = a && a.status === "stopped_by_dispute";
    $("auto-stop").hidden = !canStop;
    $("auto-stop-confirm").hidden = true;
    $("auto-stop-cancel").hidden = true;
  }

  function fillSelect(id, options, current, fallback) {
    const sel = $(id);
    sel.replaceChildren();
    for (const v of options) {
      const o = document.createElement("option");
      o.value = String(v);
      o.textContent = `${yen(v)}円`;
      sel.appendChild(o);
    }
    sel.value = String(options.includes(current) ? current : fallback);
  }

  function openAutoForm() {
    if (!billing) return;
    const o = billing.auto_options;
    const a = billing.auto ?? {};
    fillSelect("auto-below", o.below, a.below_jpy, o.below[0]);
    fillSelect("auto-amount", o.amount, a.amount_jpy, o.amount[0]);
    fillSelect("auto-cap", o.cap, a.monthly_cap_jpy, o.cap_default);
    $("auto-confirm").hidden = true;
    $("auto-form").hidden = false;
    $("auto-form").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  let autoSettings = null;
  function reviewAuto() {
    const s = { below_jpy: Number($("auto-below").value), amount_jpy: Number($("auto-amount").value), monthly_cap_jpy: Number($("auto-cap").value) };
    if (!(s.amount_jpy > s.below_jpy) || !(s.monthly_cap_jpy >= s.amount_jpy)) { showError(MESSAGES.bad_settings); return; }
    showError("");
    autoSettings = s;
    for (const el of document.querySelectorAll("#auto-confirm .auto-below")) el.textContent = yen(s.below_jpy);
    for (const el of document.querySelectorAll("#auto-confirm .auto-amount")) el.textContent = yen(s.amount_jpy);
    for (const el of document.querySelectorAll("#auto-confirm .auto-cap")) el.textContent = yen(s.monthly_cap_jpy);
    $("auto-form").hidden = true;
    $("auto-confirm").hidden = false;
    $("auto-confirm").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function setupAuto() {
    if (!autoSettings) return;
    const btn = $("auto-setup");
    btn.disabled = true;
    showError("");
    try {
      sessionStorage.setItem("toytalker.buy.autoSetupAt", String(Date.now())); // auto-done.js が「新しい同意か」を見る
      const r = await A.api("POST", "/billing/auto-charge/setup", { ...autoSettings, consent_version: cfg.CONSENT_VERSION });
      location.href = r.url; // Stripe のカード登録画面へ。戻り先は auto-done.html（完了）か index.html（やめた）
    } catch (e) {
      btn.disabled = false;
      if (e.code === "login_required" || e.status === 401) { A.logout(); return renderAccount(); }
      showError(MESSAGES[e.code] ?? `カードの登録画面を開けませんでした（${e.message}）`);
    }
  }

  async function stopAuto() {
    const btn = $("auto-stop-confirm");
    btn.disabled = true;
    showError("");
    try {
      await A.api("PUT", "/billing/auto-charge", { enabled: false });
      await renderAccount();
    } catch (e) {
      if (e.code === "login_required" || e.status === 401) { A.logout(); return renderAccount(); }
      showError(MESSAGES[e.code] ?? `止められませんでした（${e.message}）`);
    } finally {
      btn.disabled = false;
    }
  }

  function closeAuto() {
    autoSettings = null;
    $("auto-form").hidden = true;
    $("auto-confirm").hidden = true;
  }

  for (const b of document.querySelectorAll("#login button[data-provider]")) {
    b.addEventListener("click", () => A.login(b.dataset.provider).catch((e) => showError(e.message)));
  }
  $("logout").addEventListener("click", () => { A.logout(); selected = null; $("confirm").hidden = true; closeAuto(); renderAccount(); });
  $("checkout").addEventListener("click", checkout);
  $("cancel").addEventListener("click", () => { selected = null; $("confirm").hidden = true; });
  $("auto-open").addEventListener("click", openAutoForm);
  $("auto-review").addEventListener("click", reviewAuto);
  $("auto-form-cancel").addEventListener("click", closeAuto);
  $("auto-setup").addEventListener("click", setupAuto);
  $("auto-confirm-cancel").addEventListener("click", closeAuto);
  // 止めるのは2段階（ダイアログは使わない）
  $("auto-stop").addEventListener("click", () => { $("auto-stop").hidden = true; $("auto-stop-confirm").hidden = false; $("auto-stop-cancel").hidden = false; });
  $("auto-stop-cancel").addEventListener("click", () => { $("auto-stop").hidden = false; $("auto-stop-confirm").hidden = true; $("auto-stop-cancel").hidden = true; });
  $("auto-stop-confirm").addEventListener("click", stopAuto);

  if (!cfg.COGNITO_CLIENT_ID) showError("このページはまだ設定されていません（config.js の COGNITO_CLIENT_ID）。");
  renderAccount();
})();
