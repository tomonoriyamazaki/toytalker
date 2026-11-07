// 購入ページの設定（環境ごとの値。秘密は無い）。当面は RnD と Stripe の sandbox を向ける（docs/pricing-and-cost-model.md 11.10）。
// COGNITO_CLIENT_ID は `cdk deploy` の出力 WebClientId。本番（ロードマップ7）で API_BASE / COGNITO_DOMAIN / CLIENT_ID を差し替える。
window.TOYTALKER_BUY_CONFIG = {
  API_BASE: "https://api-rnd.zakicorp.com",
  COGNITO_DOMAIN: "https://toytalker-auth-rnd.auth.ap-northeast-1.amazoncognito.com",
  COGNITO_CLIENT_ID: "hutd0daovcemu15i63v89lv6f",
  // 最終確認画面と同意文の版（backend/shared/billing.mjs の CONSENT_VERSION と同じ値。違うと API が 409 を返す）
  CONSENT_VERSION: "2026-11-07",
};
