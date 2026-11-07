// Stripe のカード登録（Checkout の setup モード）から戻ったところ。設定を billing に書くのは Webhook 経由のサーバーで、
// 少し遅れることがあるので数秒ごとに読み直す。URL のパラメータは何も見ない。
// 「新しい設定が反映されたか」は、申し込みを始めた時刻（app.js が sessionStorage に残す）より新しい同意かで見る
(function () {
  const A = window.ToyTalkerAuth;
  const yen = (n) => Math.floor(Number(n) || 0).toLocaleString("ja-JP");
  const status = document.getElementById("status");
  const detail = document.getElementById("detail");
  const startedAt = Number(sessionStorage.getItem("toytalker.buy.autoSetupAt")) || 0;
  let tries = 0;
  async function poll() {
    tries++;
    try {
      const b = await A.api("GET", "/billing");
      const a = b.auto;
      const fresh = a && a.enabled && a.status === "active" && Date.parse(a.consent_at || 0) >= startedAt - 60_000;
      if (fresh || tries >= 10) {
        if (fresh) {
          sessionStorage.removeItem("toytalker.buy.autoSetupAt");
          status.textContent = "オートチャージを設定しました。";
          detail.textContent = `残高が ${yen(a.below_jpy)}円を下回ったら ${yen(a.amount_jpy)}円分を購入（月 ${yen(a.monthly_cap_jpy)}円まで）。カード: ${b.card ? `${b.card.brand ?? ""} •••• ${b.card.last4 ?? ""}` : "—"}`
            + (a.charging ? "。残高が条件を下回っているので、最初の買い足しを進めています" : "");
        } else {
          status.textContent = "反映まで少し時間がかかることがあります。しばらくしてから購入ページで設定をご確認ください。";
        }
        return;
      }
    } catch (e) {
      if (e.code === "login_required" || e.status === 401) { status.textContent = "ログインの期限が切れました。購入ページでログインし直すと設定を確認できます。"; return; }
      status.textContent = `設定を読めませんでした（${e.message}）`;
      return;
    }
    setTimeout(poll, 3000);
  }
  poll();
})();
