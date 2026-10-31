# web

- `site/` — `https://toytalker.zakicorp.com` のホームページとプライバシーポリシー（Google の OAuth 同意画面と App Store の申請に使う）。ここが正本
- `index.html` と画像 — 2025年の旧デモ（v1）の元。公開中の `toytalk.zakicorp.com/demo/`（S3 バケット `toytalk.zakicorp.com`）の版が正。中のチャットは削除済みの v1 API を呼ぶので動かない

## 置き場所

CDK 管理の外（RnD アカウント、環境に属さない）。本番づくり（ロードマップ7）で、ファームのバケットとあわせて置き場所を決める。

- S3 バケット `toytalker-web`（ap-northeast-1、非公開。静的ウェブサイトホスティングは使わない）
- CloudFront 配信（OAC でバケットを読む。別名 `toytalker.zakicorp.com`、証明書は us-east-1 の `*.zakicorp.com`、既定のルートオブジェクト `index.html`）
- Cloudflare の DNS: `CNAME toytalker → <配信のドメイン>`（DNS only）

裏のバケット・配信・アカウントを変えても、URL が同じなら Google の検索や同意画面・App Store の登録には影響しない。URL は変えない。

## 反映

```sh
aws s3 sync web/site s3://toytalker-web --delete
aws cloudfront create-invalidation --distribution-id <配信ID> --paths "/*"
```
