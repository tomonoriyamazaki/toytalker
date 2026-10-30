# 利用者認証（Cognito + Google / Sign in with Apple）

ロードマップ4の入口。認証の「いまの状態」「仕組み」「各社側の設定手順」「確認の仕方」を持つ。状態が変わったらこの文書を上書きする。設計の経緯は [先送り項目](deferred-items.md) の「ユーザー認証」（2026-09 の設計メモ）と [ロードマップ](roadmap.md) の4（2026-10-29 の方針）。前払いポイント制は認証の後（[原価と課金](pricing-and-cost-model.md) 第11節）。

## いまの状態（2026-10-30）

- **RnD へ deploy 済（2026-10-29）。CLI で本物のトークンの経路まで確認済。残りはアプリの実機確認と Google / Apple の設定。** プール `ap-northeast-1_eTtAWro8f`（`toytalker-auth-rnd`）、アプリ用クライアント `j7mibe6i3eop4r2sakbgs52e5`、ログイン画面 `toytalker-auth-rnd.auth.ap-northeast-1.amazoncognito.com`。**Google と Apple の IdP も RnD に deploy 済（2026-10-30）。** Apple は Cognito の転送先（`appleid.apple.com/auth/authorize`）が Apple のサインイン画面を返すところまで curl で確認。実機での Google / Apple のログインは未確認。
- 確認済（curl、固定ドメイン経由）: トークン無しは 200 で `auth: "none"`。不正トークンは `/me` `/stt-token` `/chat-app` `/read-aloud-app` すべて 401 `invalid_token`（LLM は走らない）。試験用利用者（`exodjp@gmail.com`、Cognito 利用者）のトークンで `GET /me` が users の行を作り（`created: true`、2回目は false）、`/characters` はクエリの `owner_id` を無視して本人分だけ、会話（`/chat-app`）がログイン中に通り（ログ `auth: "user"`、`owner_id` は users の値）、他人のデバイスへの `PUT` は 403 `not_owner`、鍵発行は 200。
- アプリ用クライアントは CLI 確認用に `ADMIN_USER_PASSWORD_AUTH`（AWS 資格情報が要る管理者用）も許可している。
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
| 検証 | `backend/shared/auth.mjs`（`aws-jwt-verify`。依存は `backend/shared/package.json`、`install-lambda-deps.sh` が入れる） | ID トークン、`tokenUse: "id"`、`clientId` 一致。JWKS は容器内キャッシュ。ネットワーク越しの認証を音声の経路に挟まない。users の行はキャッシュせず毎回読む（運用で `owner_id` を付け替えたとき全経路で即座に同じ答えにするため。2026-10-30） |
| 同じ人を1人にする | 登録前トリガー `backend/toytalker-auth-presignup-lambda`（`toytalker-auth-presignup-<環境>`）。外部IdPからの初回ログインで、その IdP が検証した同じメールの既存利用者がいれば `AdminLinkProviderForUser` でリンクする | Google と Apple で入っても Cognito 上は1人（2026-10-29決定。本来の形は「3: Cognito の層で結ぶ」。自分のテーブルでメールを束ねる案は却下）。入ってきた側も結び付け先も、IdP が検証したメール（`email_verified`。CDK の `attributeMapping` で写す）のときだけ結ぶ（2026-10-30）。LINE は ID トークンに `email_verified` が無い（2026-10-30に LINE の文書で確認）ので、そのままでは結ばれない。結ぶなら LINE を足すときに「LINE のメールを信じる」と決めて足す。Apple の「メールを非公開」やメールの違う Google とは一致しないので別人になる（ログイン画面の「前回は◯◯でログインしました」で案内。端末に覚え、ログアウトしても消さない）。Cognito の癖で、リンク直後の1回目のログインはエラーになり、アプリが自動で2回目を試す |
| 本人 → owner_id | DynamoDB `toytalker-users`（pk `sub`、GSI `owner_id-index` は運用で「この owner_id は誰か」を引く用）。列は `sub` `owner_id` `created_at` `last_login_at` だけ。メールアドレスと結び付いた会社（`identities`）は Cognito が正本で、写さない（2026-10-30。古くなる・個人情報の置き場所が増えるため）。`owner_id` → users で `sub` → Cognito の利用者で引ける。`owner_id` は内部IDのまま | **端末の ID とアカウントの ID は別**（2026-10-30決定）。初回ログインで新しい `owner_id` を発行する。端末の `u_<uuid>` は「ログインしていない人」の仮の ID で、ログイン中は使わず、ログアウトすると戻る。ログイン前のデータは引き継がない（本番はログイン必須なのでゲストのデータは無い。RnD で使っている数人は users の行を手で書いて引き継いだ） |
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
| `GET /me` | 本人の `owner_id`・メール・IdP を返す。初回は新しい `owner_id` を発行して users の行を作る |
| `POST /devices` | 既存行が他人のものなら 403（本番）。新規は本人を書く |
| `GET/PUT/DELETE /devices/{id}` | 行の所有者 = 本人 |
| `PUT/DELETE /characters/{id}`、`PUT/DELETE /custom-voices/{id}` | 行の所有者 = 本人（system 製は従来どおり 403） |
| `GET /devices` `/characters` `/custom-voices` `/logs/*` `/usage*` | 本人の `owner_id` で引く |
| `POST /characters` `/custom-voices` | `owner_id` は本人 |

本文Lambda（App）: 他人のキャラクター（`owner_id` が system でも本人でもない）は 403。読み上げLambda: 他人のクローンボイスは 403。相槌Lambda: トークンの検証だけ。

### アプリ（`app/lib/auth.ts`、`app/lib/api.ts`）

- `expo-auth-session` で Cognito のログイン画面を開く（iOS は ASWebAuthenticationSession、Android は Custom Tabs。Google が埋め込み WebView を拒むので WebView は使わない）。Safari と cookie を共有しない一時セッション（`preferEphemeralSession`）で開き、iOS の「サインインしようとしています」の確認ダイアログを出さない（2026-10-30）。Google の画面でアカウントを毎回選ぶことになるが、アプリ側は180日ログインが保たれる。ネイティブモジュールは増えていない（`expo-web-browser` `expo-crypto` `expo-secure-store` は既存）。
- トークンは SecureStore に置き、`apiFetch` と XHR（会話・読み上げ）が `x-toytalker-token` を自動で添える。期限の1分前からリフレッシュする。
- 設定タブ「アカウント情報」でログイン / ログアウト。値は `EXPO_PUBLIC_COGNITO_DOMAIN` / `EXPO_PUBLIC_COGNITO_CLIENT_ID`（既定は RnD。クライアント ID は deploy 後に `app/lib/auth.ts` の既定値へ書く）。
- 未ログインでも RnD では今までどおり使える。本番向けビルドでは 401 になるので、ログイン必須の導線（起動時にアカウント画面へ）は本番の前に足す。

### アプリの実機確認で分かったこと（2026-10-29）

- 試験用利用者でのログインは通った。ただし CLI の確認で先に同じ利用者へ別の `owner_id` を結び付けていたため、アプリの端末 ID がそれに差し替わり、選択中だったキャラクターが「他人のもの」になって本文が 403（相槌だけ鳴った）。users の行は手で元の `owner_id` に戻した。
- 直したこと: (a) 起動時にログイン済みなら `GET /me` でアカウントの `owner_id` を取り直す（`syncAccount`）、(b) 選択中のキャラクターが一覧に無ければ既定に戻す（他人のキャラクターを見せない）、(c) 本文が 401/403 のとき画面に理由を出す、(d) 相槌Lambdaも所有者確認（users を読むだけ）、(e) 最初の画面にログインボタン（`components/LoginButtons.tsx`。RnD は「ログインせずに使う」も出す。本番は `/me` の `auth_required` が true なので出ない）。
- その後（2026-10-30）「端末の ID をアカウントの ID にする」近道をやめ、2つを別の ID にした（上の表）。ログイン/ログアウトで端末の ID は変わらず、試験アカウントで入っても端末側は汚れない。

## 各社側の設定（ユーザーの操作）

リダイレクト先はどちらも `https://<AuthDomain>/oauth2/idpresponse`（`cdk deploy` の出力 `AuthDomain`。RnD は `https://toytalker-auth-rnd.auth.ap-northeast-1.amazoncognito.com/oauth2/idpresponse`）。

**Google**（Google Cloud コンソール → APIs & Services → Credentials → OAuth client ID、種類は「ウェブ アプリケーション」）:

1. 承認済みの JavaScript 生成元に `https://<AuthDomain>`、承認済みのリダイレクト URI に上の `/oauth2/idpresponse` を足す。OAuth 同意画面は外部・公開（審査は scope が `email profile openid` だけなら不要）。
2. クライアント ID を `stages.ts` の `auth.google.clientId` に書く。クライアントシークレットは Secrets Manager（東京）へ、JSON 1キーで:
   ```bash
   aws secretsmanager create-secret --region ap-northeast-1 --name toytalker/google-oauth-client-secret --secret-string '{"client_secret":"<値>"}'   # 2回目以降は put-secret-value
   ```
   スマホのコンソールで入れるときは、器を作ってから「Edit」→ **Key/value** タブで Key `client_secret`、Value に貼る（平文エディタは iPhone で貼れない）。
   RnD は 2026-10-30 に設定済み（OAuth 同意画面は Testing、テストユーザー `exodjp@gmail.com`。本番前に Publish）。

RnD の Apple は 2026-10-30 に設定済み: App ID `com.zakicorp.toytalk`（Description は ToyTalker）で有効化、Services ID `com.zakicorp.toytalker.signin`（Primary App ID は `com.zakicorp.toytalk`）、Key `ToyTalker Sign in`（Key ID `WADH8C78NZ`）、Team ID `89J44WY33V`。Services ID の名前はバンドルIDと揃えなくてよい（アプリとの結び付きは Primary App ID。利用者の sub はチーム単位）。バンドルIDを後で変えるときも古い App ID は消さない。

**Apple**（Apple Developer → Certificates, Identifiers & Profiles）:

1. App ID（`com.zakicorp.toytalk`）で Sign in with Apple を有効にする。
2. Services ID（例 `com.zakicorp.toytalker.signin`）を作り、Sign in with Apple を構成: ドメイン `<AuthDomain>`、Return URL は上の `/oauth2/idpresponse`。
3. Key を作り（Sign in with Apple）、`.p8` を1回だけダウンロードする。Key ID と Team ID を控える。
4. `stages.ts` の `auth.apple` に `servicesId` / `teamId` / `keyId` を書く。秘密鍵（`.p8` の中身全部、改行込み）は Secrets Manager（東京）へ、JSON 1キー（`private_key`）で:
   ```bash
   python -c "import json,sys; print(json.dumps({'private_key': open(sys.argv[1]).read()}))" AuthKey_XXXXXXXXXX.p8 > key.json
   aws secretsmanager create-secret --region ap-northeast-1 --name toytalker/apple-signin-private-key --secret-string file://key.json && rm key.json
   ```
   スマホのコンソールで Key/value に貼ると改行が空白になる（2026-10-30。1行の PEM を Cognito が受け付けるかは未確認）。貼ったあとは値を画面に出さないスクリプトで「空白を除いて64文字ごとに改行」した版を `put-secret-value` で入れ直す。`.p8` は入れたら手元・Drive から消す（なくしても Apple で作り直して差し替えれば済み、sub は変わらない）。
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

- 実機で Google / Apple のログイン（両方とも IdP は deploy 済、2026-10-30）。同じメールで両方に入って Cognito 上で1人になること（登録前トリガーのリンクと、リンク直後のアプリの自動再試行）も見る。
- 別人になった人の救済（前払いポイント制の前に決める。2026-10-30）: 最初は運用で手作業で結ぶ（`AdminLinkProviderForUser`。吸収される側の利用者は先に消す必要がある）。利用者が増えたら設定画面に「ログイン方法を追加」（ログイン中にもう一方へログインして結ぶ。メールに頼らないので非公開メールや LINE も救える）。決めること: (a) 自分でまとめられるのは吸収される側が空（ポイント0・購入履歴なし）のときだけ、両方に残高があれば問い合わせで手作業、(b) 登録特典を配るなら移せない、(c) 手作業でも**メールを根拠にしない**（本人に両方のアカウントでログインしてもらって確かめる。未検証のメールを名乗った問い合わせで他人のアカウントとまとめないため）。ポイントは `owner_id` に付ける。
- **アカウント整理はあとで設計し直す**（2026-10-30、ユーザーの希望）。決めること: 利用者がどう操作してアカウントとポイントをまとめるか（画面の流れ）、両方にポイントがあるときどうなるか（合算するか、問い合わせか）。材料: (1) 自動でまとまるのは「2つ目のログイン方法で初めて入った瞬間」だけで、両方のアカウントが一度できると後からメールが一致してもまとまらない（2026-10-30の実機。Apple を非公開で作ったあと共有に変えて入り直しても、Apple は同じ sub で戻るので登録前トリガーが動かない。手作業で空の Apple 利用者と users の行を消してから入り直してまとめた）、(2) 安い追加案: ログイン時の `/me` で同じ確認済みメールの別アカウントがあれば「このメールで Google のアカウントもあります」と案内する。
- アプリの新ビルド（`expo-auth-session` は JS だけなので開発クライアントはそのままでよいが、`app.json` の `scheme` によるコールバックは既存ビルドにある）。
- 本番向け: トークン盗難の被害を小さくする2つ（「すべての端末からログアウト」= Cognito の `admin-user-global-sign-out` を設定画面か運用手順に、リフレッシュトークンの期限 180日の見直し）。ログイン画面の独自ドメイン（今は Cognito の `toytalker-auth-<環境>.auth.ap-northeast-1.amazoncognito.com` で、Google / Apple の画面にこのドメインが出る。案は API と同じ形の `auth-<環境>.zakicorp.com`。ACM 証明書（us-east-1）・Cloudflare の CNAME・Cognito の独自ドメインはどれも無料。後から変えても sub は変わらず、Google / Apple のリダイレクト先を書き換えるだけ。2026-10-30、本番で決める）。ログイン必須の導線は済（最初の画面、2026-10-29）。ESP32 の登録フロー（ログイン後にしか登録できないことの案内）、製造時のデバイス鍵（[セキュリティ見直し](security-review-2026-10-25.md) の「ファーム側の認証の方針」）。
- 前払いポイント制（[原価と課金](pricing-and-cost-model.md) 第11節）は認証の実機確認の後。
