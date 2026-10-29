# 利用者認証（Cognito + Google / Sign in with Apple）

ロードマップ4の入口。認証の「いまの状態」「仕組み」「各社側の設定手順」「確認の仕方」を持つ。状態が変わったらこの文書を上書きする。設計の経緯は [先送り項目](deferred-items.md) の「ユーザー認証」（2026-09 の設計メモ）と [ロードマップ](roadmap.md) の4（2026-10-29 の方針）。前払いポイント制は認証の後（[原価と課金](pricing-and-cost-model.md) 第11節）。

## いまの状態（2026-10-29）

- **RnD へ deploy 済（2026-10-29）。CLI で本物のトークンの経路まで確認済。残りはアプリの実機確認と Google / Apple の設定。** プール `ap-northeast-1_eTtAWro8f`（`toytalker-auth-rnd`）、アプリ用クライアント `j7mibe6i3eop4r2sakbgs52e5`、ログイン画面 `toytalker-auth-rnd.auth.ap-northeast-1.amazoncognito.com`。Google / Apple の IdP は各社側の設定（下の「各社側の設定」）が済んでから `stages.ts` に ID を書いて deploy する。
- 確認済（curl、固定ドメイン経由）: トークン無しは 200 で `auth: "none"`。不正トークンは `/me` `/stt-token` `/chat-app` `/read-aloud-app` すべて 401 `invalid_token`（LLM は走らない）。試験用利用者（`exodjp@gmail.com`、Cognito 利用者）のトークンで `GET /me` が users の行を作り（`created: true`、2回目は false）、`/characters` はクエリの `owner_id` を無視して本人分だけ、会話（`/chat-app`）がログイン中に通り（ログ `auth: "user"`、`owner_id` は users の値）、他人のデバイスへの `PUT` は 403 `not_owner`、鍵発行は 200。
- 注意: `GET /me?owner_id=` で結び付けるのは `u_<uuid>` 形式だけ（curl の `u_authtest` は新しい ID が発行された。アプリの ID は常にこの形式）。アプリ用クライアントは CLI 確認用に `ADMIN_USER_PASSWORD_AUTH`（AWS 資格情報が要る管理者用）も許可している。
- RnD は `auth.required: false`（トークン無しも通す）。本番は `true`。
- 小物2つ（脅威モデル#1・#2）: `DELETE /devices/{id}` の `owner_id` 必須化は**済**（トークン無しのときは本文の `owner_id` が無いと 400、違えば 403）。Soniox 一時鍵の寿命短縮は、ロードマップ11の試用（寿命3分・閾値2分）の結果で本番値を決めてから（Lambda の `DEFAULT_KEY_TTL_SEC` は 1時間のまま。短縮は古いファーム・アプリが消えてから）。

## 仕組み

```
アプリ ──(認可コード + PKCE)──▶ Cognito ログイン画面（managed login） ──▶ Google / Apple
  │                                   │
  │◀── ID トークン（1時間）+ リフレッシュトークン（180日）
  │
  └─ x-toytalker-token: <ID トークン> ──▶ CloudFront ──▶ Lambda（backend/shared/auth.mjs が JWT を検証）
                                                           └─ users テーブル: sub → owner_id
```

| 部品 | 所在 | 要点 |
|---|---|---|
| ユーザープール | CDK `createAuth`（`infra/lib/toytalker-stack.ts`）。名前 `toytalker-auth-<環境>`、Essentials プラン、自己サインアップ無し、削除保護 + RETAIN | 消すと sub が全部変わり users テーブルの対応が無効になる |
| ログイン画面 | `<domainPrefix>.auth.ap-northeast-1.amazoncognito.com`（`stages.ts` の `auth.domainPrefix`）。managed login + Cognito 既定の見た目 | Google / Apple のボタンが並ぶ。アプリは `identity_provider=Google` 等で直接その IdP へ飛ばす |
| アプリ用クライアント | `toytalker-app-<環境>`。公開クライアント（シークレット無し）、認可コード、scope `openid email profile`、コールバック `toytalk://auth/callback` | ID トークン 1時間、リフレッシュ 180日 |
| 外部IdP | `stages.ts` の `auth.google` / `auth.apple`（ID は公開情報）。秘密は **Secrets Manager** `toytalker/google-oauth-client-secret` と `toytalker/apple-signin-private-key`（`infra/lib/secrets.ts` の `IDP_SECRETS`） | SSM の ssm-secure は CloudFormation が Cognito に対応していない（2026-10-29確認）ので、この2件だけ Secrets Manager（月 $0.80）。`{{resolve:secretsmanager}}` で deploy 時に読み、テンプレートに値は残らない |
| トークンのヘッダー | `x-toytalker-token`（`Authorization` は CloudFront の OAC が署名で上書きするので使えない） | CloudFront の origin request policy の allowList と Function URL の CORS に入れてある |
| 検証 | `backend/shared/auth.mjs`（`aws-jwt-verify`。依存は `backend/shared/package.json`、`install-lambda-deps.sh` が入れる） | ID トークン、`tokenUse: "id"`、`clientId` 一致。JWKS は容器内キャッシュ。ネットワーク越しの認証を音声の経路に挟まない |
| 同じ人を1人にする | 登録前トリガー `backend/toytalker-auth-presignup-lambda`（`toytalker-auth-presignup-<環境>`）。外部IdPからの初回ログインで、その IdP が検証した同じメールの既存利用者がいれば `AdminLinkProviderForUser` でリンクする | Google と Apple で入っても Cognito 上は1人（2026-10-29決定。本来の形は「3: Cognito の層で結ぶ」。自分のテーブルでメールを束ねる案は却下）。未検証のメールでは結ばない。Apple の「メールを非公開」は一致しないので別人になる（アプリの「前回は◯◯でログイン」で案内）。Cognito の癖で、リンク直後の1回目のログインはエラーになり、アプリが自動で2回目を試す |
| 本人 → owner_id | DynamoDB `toytalker-users`（pk `sub`、GSI `owner_id-index`）。`owner_id` は内部IDのまま | 初回ログインで端末の `owner_id`（`u_<uuid>`）を、まだ誰のものでもなければそのまま結び付ける（データ移行なし）。誰かのものなら新しい ID を発行し、アプリは端末側の ID を差し替える（`GET /me` の応答） |
| ログ | 1行JSON（`trace.mjs`）に `auth`（none / user / invalid）、`auth_reason`、`auth_provider`、`status`、`owner_id` | メールアドレスと sub は書かない |
| 通知 | CloudWatch メトリクスフィルタ（`status` が 401/403）+ アラーム3つ（`toytalker-api-rejected-<環境>` 5分で20件、`-api-invocations-` 600件、`-api-errors-` 10件）→ 月次レポートと同じ SNS トピック（メール） | Lambda からはメールを送らない（応答が遅れ、連打でメールも連打される） |

### 環境の違い（`stages.ts` の `auth.required` → 環境変数 `AUTH_REQUIRED`）

| 要求 | RnD（false） | 本番（true） |
|---|---|---|
| トークン無し（アプリ） | 通す。クライアントの自称 `owner_id` を使う。ログ `auth: "none"` | **401** `login_required`。LLM も TTS も走らない |
| トークン付き・正しい | 検証して users の `owner_id` を使う。ログ `auth: "user"` | 同じ |
| トークン付き・不正/期限切れ | **401** `invalid_token` | 同じ |
| ESP32（`device_id` だけ） | 通す（未登録機も） | devices テーブルに行が無い機器は **403** `device_not_registered`（登録はアプリのログイン後にしかできない） |

### 所有者確認（設定Lambda `backend/toytalker-device-setting-lambda/index.mjs`）

トークン付きのときはクエリ・本文の `owner_id` を捨てて本人の `owner_id` を使う。行の所有者と違えば 403 `not_owner`。トークン無し（RnD）はクライアントが名乗った `owner_id` と比べ、名乗っていなければ従来どおり通す（`DELETE /devices/{id}` だけは必須で 400）。

| ルート | 確認 |
|---|---|
| `GET /me` | 本人の `owner_id`・メール・IdP を返す。初回は users の行を作る（`?owner_id=` で端末の ID を結び付ける） |
| `POST /devices` | 既存行が他人のものなら 403（本番）。新規は本人を書く |
| `GET/PUT/DELETE /devices/{id}` | 行の所有者 = 本人 |
| `PUT/DELETE /characters/{id}`、`PUT/DELETE /custom-voices/{id}` | 行の所有者 = 本人（system 製は従来どおり 403） |
| `GET /devices` `/characters` `/custom-voices` `/logs/*` `/usage*` | 本人の `owner_id` で引く |
| `POST /characters` `/custom-voices` | `owner_id` は本人 |

本文Lambda（App）: 他人のキャラクター（`owner_id` が system でも本人でもない）は 403。読み上げLambda: 他人のクローンボイスは 403。相槌Lambda: トークンの検証だけ。

### アプリ（`app/lib/auth.ts`、`app/lib/api.ts`）

- `expo-auth-session` で Cognito のログイン画面を開く（iOS は ASWebAuthenticationSession、Android は Custom Tabs。Google が埋め込み WebView を拒むので WebView は使わない）。ネイティブモジュールは増えていない（`expo-web-browser` `expo-crypto` `expo-secure-store` は既存）。
- トークンは SecureStore に置き、`apiFetch` と XHR（会話・読み上げ）が `x-toytalker-token` を自動で添える。期限の1分前からリフレッシュする。
- 設定タブ「アカウント情報」でログイン / ログアウト。値は `EXPO_PUBLIC_COGNITO_DOMAIN` / `EXPO_PUBLIC_COGNITO_CLIENT_ID`（既定は RnD。クライアント ID は deploy 後に `app/lib/auth.ts` の既定値へ書く）。
- 未ログインでも RnD では今までどおり使える。本番向けビルドでは 401 になるので、ログイン必須の導線（起動時にアカウント画面へ）は本番の前に足す。

### アプリの実機確認で分かったこと（2026-10-29）

- 試験用利用者でのログインは通った。ただし CLI の確認で先に同じ利用者へ別の `owner_id` を結び付けていたため、アプリの端末 ID がそれに差し替わり、選択中だったキャラクターが「他人のもの」になって本文が 403（相槌だけ鳴った）。users の行は手で元の `owner_id` に戻した。
- 直したこと: (a) 起動時にログイン済みなら `GET /me` で `owner_id` を揃える（`syncAccount`）、(b) 選択中のキャラクターが一覧に無ければ既定に戻す（他人のキャラクターを見せない）、(c) 本文が 401/403 のとき画面に理由を出す、(d) 相槌Lambdaも所有者確認（users を読むだけ）、(e) 最初の画面にログインボタン（`components/LoginButtons.tsx`。RnD は「ログインせずに使う」も出す。本番は `/me` の `auth_required` が true なので出ない）。
- 本番でも「別の端末で先にログインしていた人」は同じ経路を通る（端末の ID はサーバーの値に揃い、ログイン前にその端末で作ったデータは引き継がれない）。

## 各社側の設定（ユーザーの操作）

リダイレクト先はどちらも `https://<AuthDomain>/oauth2/idpresponse`（`cdk deploy` の出力 `AuthDomain`。RnD は `https://toytalker-auth-rnd.auth.ap-northeast-1.amazoncognito.com/oauth2/idpresponse`）。

**Google**（Google Cloud コンソール → APIs & Services → Credentials → OAuth client ID、種類は「ウェブ アプリケーション」）:

1. 承認済みの JavaScript 生成元に `https://<AuthDomain>`、承認済みのリダイレクト URI に上の `/oauth2/idpresponse` を足す。OAuth 同意画面は外部・公開（審査は scope が `email profile openid` だけなら不要）。
2. クライアント ID を `stages.ts` の `auth.google.clientId` に書く。クライアントシークレットは Secrets Manager へ:
   ```bash
   aws secretsmanager create-secret --name toytalker/google-oauth-client-secret --secret-string "<値>"   # 2回目以降は put-secret-value
   ```

**Apple**（Apple Developer → Certificates, Identifiers & Profiles）:

1. App ID（`com.zakicorp.toytalk`）で Sign in with Apple を有効にする。
2. Services ID（例 `com.zakicorp.toytalk.signin`）を作り、Sign in with Apple を構成: ドメイン `<AuthDomain>`、Return URL は上の `/oauth2/idpresponse`。
3. Key を作り（Sign in with Apple）、`.p8` を1回だけダウンロードする。Key ID と Team ID を控える。
4. `stages.ts` の `auth.apple` に `servicesId` / `teamId` / `keyId` を書く。秘密鍵は Secrets Manager へ:
   ```bash
   aws secretsmanager create-secret --name toytalker/apple-signin-private-key --secret-string file://AuthKey_XXXXXXXXXX.p8
   ```
5. App Store の審査基準 4.8: 第三者ログインを置くなら Sign in with Apple も要る。Cognito 経由のウェブ方式でよい。

どちらも設定後に `cdk synth --context nag=true` → `cdk diff` → `cdk deploy`（CLAUDE.md の手順）。

## 確認の仕方

1. deploy 後、出力の `UserPoolId` / `UserPoolClientId` / `AuthDomain` を控え、`app/lib/auth.ts` の既定値（クライアント ID）を書く。
2. 試験用利用者（IdP 設定前でも使える）:
   ```bash
   aws cognito-idp admin-create-user --user-pool-id <UserPoolId> --username <メール> --user-attributes Name=email,Value=<メール> Name=email_verified,Value=true --temporary-password '<仮パスワード>'
   ```
   アプリの「メールアドレスでログイン（試験用）」で仮パスワード → 新パスワードの順に入れる。
3. トークンの検証を curl で: `aws cognito-idp initiate-auth --auth-flow USER_PASSWORD_AUTH ...` はクライアントで許可していない（USER_SRP だけ）ので、アプリでログインしてから Lambda ログの `auth: "user"` と `owner_id` を見る。`x-toytalker-token: garbage` を付けた要求が 401 `invalid_token` になり、ログに `auth: "invalid"` が出ることも見る。
4. `GET /me` の応答で `owner_id` が端末の ID のまま結び付いたこと（`created: true`）を確かめる。DynamoDB `toytalker-users` に1行。
5. ログイン中に会話・相槌・読み上げ・設定画面（キャラクター・カスタムボイス・デバイス・利用状況）が動くこと。他人の `owner_id` を名乗っても自分の行しか見えないこと。
6. 5分間に 401/403 を20件以上出して `toytalker-api-rejected-rnd` のメールが届くこと（任意）。

## 残り

- Google / Apple の設定（上）→ `stages.ts` → deploy → 実機で両方のログイン。
- アプリの新ビルド（`expo-auth-session` は JS だけなので開発クライアントはそのままでよいが、`app.json` の `scheme` によるコールバックは既存ビルドにある）。
- 本番向け: ログイン必須の導線（起動時のアカウント画面）、ESP32 の登録フロー（ログイン後にしか登録できないことの案内）、製造時のデバイス鍵（[セキュリティ見直し](security-review-2026-10-25.md) の「ファーム側の認証の方針」）。
- 前払いポイント制（[原価と課金](pricing-and-cost-model.md) 第11節）は認証の実機確認の後。
