# セキュリティ見直し（2026-10-25）

認証（ロードマップ4）に着手する前に、公開している入口とアカウント運用を棚卸しした記録。セキュリティの現状と残りの対策はこの文書が入口。済んだ項目は「済（日付）」にし、新しい発見はここに追記する。

## きっかけ

2026年10月に脆弱性の報道が重なった（PHP2Shell、Node.js Brotli CVE-2026-111497、Microsoft月例更新のCVE初の4桁、AIによる脆弱性発見の加速）。ToyTalkerへの直接の影響は無い（PHPは不使用、LambdaのNode 24は管理ランタイムで更新モードAuto、TTS PCのWindowsは自動更新）。本質は「公開している入口はいずれ機械的に叩かれる」と考えて設計を正すこと。

## 確認した結果

### 守れているもの

- ルートMFAあり、ルートのアクセスキー無し。子アカウントはルート資格情報なし（ルートアクセスの集中管理）。
- 鍵はSSM SecureStringにあり、Lambda環境変数に無い。
- S3 2バケットは公開ブロック。Lambdaロールは関数ごとの最小権限。DynamoDBは削除保護あり。
- 単価テーブル（`api-unit-prices`）と為替はAPIから書けない。AWS資格情報が無いと変えられない。
- ローカルTTSはCloudflare WAFで `X-Zakicorp-Edge-Key` 必須。
- AWS側の月額は約$3.3で、予算アラート（$5 / $10、月次）は妥当。**LLM・TTSなど外部APIの費用はAWS予算の外**なので、費用燃やし攻撃の検知は各社のダッシュボードか `toytalker-usage` の集計に頼る。

### 問題（深刻な順）

1. **デバイスの乗っ取り。** `POST /devices` は既存の `device_id` を再登録すると `owner_id` を上書きする。`PUT /devices/{id}` は所有者を確認しない。ESP32の `device_id` はBLEのMACアドレスで、推測の余地がある。乗っ取られると、キャラクター・相槌・ファーム版指定（`fw_target`。自分のS3の署名付きURLとSHA検証の範囲内）を変えられ、**以後の会話ログが乗っ取った側の `owner_id` で記録されて読める**。キャラクターとカスタムボイスの更新・削除も「システム製でないこと」しか見ていない。
2. **会話ログの閲覧はクライアントの `owner_id` を信用している。** ESP32のログは、登録済みデバイスならデバイス行の `owner_id`（アプリ側のランダムUUID）で記録されるので、MACだけでは読めない（当初「MACだけで読める」と評価したが誤り。未登録デバイスのログだけMACが鍵になる）。守りはUUIDが推測できないことだけで、1の乗っ取りと組み合わさると破れる。
3. **費用を燃やされる経路。** 本文・相槌・読み上げ・Soniox一時鍵発行の全部が無認証・無制限。Function URLにはWAFもレート制限も付けられない。
4. **AWS資格情報の運用。** RnDアカウントにIAMユーザー3人分と長期アクセスキー3本が有効。`codecommit`（2020年作成、未使用、CodeCommitの残骸。同名リポジトリが1つ残る）、`yamazaki-3tyd`（2024年にS3を1回使ったきりのAdministrator）、`zackey`（CLIで使用中のAdministrator）。Identity Centerを整えたのにCLIは長期鍵のまま。「料金表やデバイス情報が入れ替わる」最大の経路はAPIでなくここ。
5. **復旧と検知の手段がない。** DynamoDBのPITRが全テーブルで無効。CloudTrailのトレイルが無く90日の履歴のみ。GuardDuty無効。
6. Lambda 3本の依存に修正版のある高リスク脆弱性（`undici` 8.x の応答非同期化、`fast-xml-parser` の実体展開上限回避）。

## 対策と時期

| 時期 | 対策 | 性質 | 状態 |
|---|---|---|---|
| 今すぐ | 全テーブルにPITR（CDK） | 根治 | コード済、RnDへdeploy待ち |
| 今すぐ | Lambda 3本の依存更新（`npm audit fix`、package.jsonの範囲内） | 根治 | コード済、RnDへdeploy待ち |
| 今すぐ | CloudTrail組織トレイル（スタック `toytalker-org`、バケット `toytalker-cloudtrail-org`、管理アカウントに1本） | 根治 | コード済。先に信頼されたアクセス `cloudtrail.amazonaws.com` の有効化が要る |
| 今すぐ | CLIをSSOへ移し、長期鍵3本とIAMユーザー `codecommit` `yamazaki-3tyd` を削除。`codecommit` リポジトリは中身確認後に削除 | 根治 | 未。手順は下記 |
| 認証と一体（4） | Lambdaがトークンの本人を使う。デバイス・キャラ・ボイス・ログの所有者確認。再登録での `owner_id` 上書き禁止 | 根治 | 未。設計は [先送り項目](deferred-items.md) の「ユーザー認証」 |
| 固定ドメインと一体（3） | CloudFront + WAFでレート制限・地域制限 | 根治 | 未。ゲスト会話を残す限り認証では防げない |
| 認証後 | デバイス登録をログイン必須に | 根治 | 未 |
| 保留 | GuardDuty（月数百円〜）。他人が入る本番で再検討 | — | 保留 |

「再登録で `owner_id` を上書き」は、端末のリセットや機種変更での正当な再ペアリングも同じ経路なので、本人確認の無い今は塞げない。認証で本人が分かってから直す。

## SSOへの切替と鍵の削除（手順）

1. Identity Centerのユーザー `yamazaki` のパスワードを設定する（入口 `https://d-95671d6109.awsapps.com/start` の「パスワードを忘れた」→ gmail → MFA登録）。
2. `aws configure sso` でプロファイルを作る（入口URL、`ap-northeast-1`、アカウント 342082316736、権限セット `AdministratorAccess`）。`aws sso login --profile <名前>` → `aws sts get-caller-identity --profile <名前>` で確認。
3. `AWS_PROFILE` を環境変数に置き、`cdk diff --context stage=rnd` が通ることを確認する。
4. 削除の順: `codecommit` のリポジトリ確認 → ユーザー `codecommit`（鍵・Git資格情報・ユーザー）→ ユーザー `yamazaki-3tyd`（鍵・ユーザー）→ 最後に `zackey` の鍵（ユーザーは残してもよい）。各削除は説明→OK。

## 認証フェーズへ渡す所有者確認の一覧

`backend/toytalker-device-setting-lambda/index.mjs`:

- `POST /devices`: 既存行の `owner_id` と本人が違えば403（新規登録は本人を書く）。
- `PUT /devices/{id}` / `DELETE /devices/{id}` / `GET /devices/{id}`: 行の `owner_id` と本人の一致。
- `PUT|DELETE /characters/{id}`、`PUT|DELETE /custom-voices/{id}`: 行の `owner_id` と本人の一致（システム製は従来どおり拒否）。
- `GET /logs/*` / `GET /usage*` / `GET /devices` / `GET /characters` / `GET /custom-voices`: クエリの `owner_id` を捨て、本人IDを使う。

本文・読み上げ・相槌Lambda: `owner_id` を本文から受け取っている箇所を本人IDへ。ESP32経由はデバイス行の `owner_id` を使う現在の方式を維持。
