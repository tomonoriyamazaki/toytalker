# web

- `site/` — `https://toytalker.zakicorp.com` のホームページとプライバシーポリシー（Google の OAuth 同意画面と App Store の申請に使う）。ここが正本
- `site/buy/` — ポイントの購入ページ（[原価と課金](../docs/pricing-and-cost-model.md) 11.10）。素の HTML と JS で、外部 JS は読み込まない（CSP）。ログインは Cognito の Web クライアント（PKCE、`auth.js`）、API は `config.js` の `API_BASE`（当面は RnD）。`config.js` の `COGNITO_CLIENT_ID` は `cdk deploy` の出力 `WebClientId`。`terms.html` は利用規約と特商法の表示で、Stripe の設定（公開情報の利用規約 URL）からも参照する。Stripe からの戻り先は `done.html`（単発の購入）と `auto-done.html`（オートチャージのカード登録）で、どちらも残高・設定をサーバーから数秒ごとに読み直すだけで URL のパラメータは見ない。`config.js` の `CONSENT_VERSION` は `backend/shared/billing.mjs` と同じ値にする（確認画面の文言を変えたら両方上げる）。CloudFront の既定ルートオブジェクトはルートにしか効かないので、ページ内のリンクと Stripe の戻り先は `/buy/index.html` と書く（`/buy/` で開けるようにするなら CloudFront Function で `/buy/` → `/buy/index.html` に書き換える）
- `index.html` と画像 — 2025年の旧デモ（v1）の元。公開中の `toytalk.zakicorp.com/demo/`（S3 バケット `toytalk.zakicorp.com`）の版が正。中のチャットは削除済みの v1 API を呼ぶので動かない

## 置き場所

CDK 管理の外（RnD アカウント、環境に属さない）。本番づくり（ロードマップ7）で、ファームのバケットとあわせて置き場所を決める。

- S3 バケット `toytalker-web`（ap-northeast-1、非公開。静的ウェブサイトホスティングは使わない）
- CloudFront 配信（OAC でバケットを読む。別名 `toytalker.zakicorp.com`、証明書は us-east-1 の `*.zakicorp.com`、既定のルートオブジェクト `index.html`）
- Cloudflare の DNS: `CNAME toytalker → <配信のドメイン>`（DNS only）

裏のバケット・配信・アカウントを変えても、URL が同じなら Google の検索や同意画面・App Store の登録には影響しない。URL は変えない。

## 反映

```sh
aws s3 sync web/site s3://toytalker-web --delete --cache-control "no-cache"
aws cloudfront create-invalidation --distribution-id E335QPFK5DELJ0 --paths "/*"
```

`--cache-control "no-cache"` は必ず付ける（`sync` は変わったファイルしか送らないので、メタデータだけ直したいときは `aws s3 cp web/site s3://toytalker-web --recursive --cache-control "no-cache"`。2026-11-08 に全ファイルへ付けた）。無いとブラウザが JS を自分の判断で長く保持し、公開しても古い画面のまま開く（2026-11-08 に購入ページで起きた。CloudFront の invalidation ではブラウザ側のキャッシュは消せない）。`no-cache` でも ETag で毎回確認するだけなので、ログイン（sessionStorage のトークン）には影響しない。
