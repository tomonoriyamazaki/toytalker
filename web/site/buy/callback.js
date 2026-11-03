// Cognito から戻ってきたところ。code をトークンに替えて購入ページへ
window.ToyTalkerAuth.handleCallback()
  .then(() => location.replace("/buy/index.html"))
  .catch((e) => {
    document.getElementById("status").textContent = e.message;
    document.getElementById("back").hidden = false;
  });
