// Stripe から戻ったところ。残高に足すのは Webhook 経由のサーバーで、少し遅れることがあるので数秒ごとに読み直す。
// URL のパラメータは何も見ない（ここから残高を動かす経路は無い）
(function () {
  const A = window.ToyTalkerAuth;
  const yen = (n) => Math.floor(Number(n) || 0).toLocaleString("ja-JP");
  const status = document.getElementById("status");
  let first = null;
  let tries = 0;
  async function poll() {
    tries++;
    try {
      const b = await A.api("GET", "/billing");
      document.getElementById("balance").textContent = yen(b.balance_jpy);
      if (first === null) first = b.balance_jpy;
      if (b.balance_jpy > first || tries >= 10) {
        status.textContent = b.balance_jpy > first ? "ポイントが加わりました。" : "反映まで少し時間がかかることがあります。しばらくしてから購入ページで残高をご確認ください。";
        return;
      }
    } catch (e) {
      if (e.code === "login_required" || e.status === 401) { status.textContent = "ログインの期限が切れました。購入ページでログインし直すと残高を確認できます。"; return; }
      status.textContent = `残高を読めませんでした（${e.message}）`;
      return;
    }
    setTimeout(poll, 3000);
  }
  poll();
})();
