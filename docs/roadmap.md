# ロードマップ: 残りの作業と順番

「残っていること全部」の入口と、インフラの「いまの状態」を持つ。順番と、誰の手が要るかだけを書き、各項目の中身・経緯・手順は右端の文書へ。終わった行は消さず「済（日付）」にし、全部済んだらこの文書を消す。着手しないと決めた項目はここに書かず [先送り項目](deferred-items.md) へ。インフラの決定と根拠は [複数アカウント計画](multi-account-iac-plan.md)、手順は [infra/README](../infra/README.md)。

## 方針（2026-10-07合意）

- 書いてあることを順に全部終わらせる。優先度の議論はしない。
- Claudeだけで進められる部分は、ユーザーの手待ち（アカウント作成・実機確認など）の間に先へ進める。各セッションの冒頭で「このセッションでユーザーにやってもらうこと」を先に列挙する。
- 本番影響の操作は説明→OKの原則どおり。同種の操作をまとめて1回のOKで進めてよいかは、その場で聞く。

## いまの状態（インフラ、2026-10-25時点）

状態が変わったらここを上書きする。経過は書かない。

- RnDアカウント（342082316736、管理アカウントと同居）のToyTalker資源36個は、CloudFormationスタック **`ToyTalker-rnd`** の管理下。ドリフトなし（2026-09-16確認）。
- **Lambdaの反映は `cd infra && npx cdk diff --context stage=rnd` → `npx cdk deploy --context stage=rnd`。** `deploy.sh` / `setup.sh` は削除済み。
- APIキー11件の正本は **SSM Parameter Store `/toytalker/<key>`**（AWS管理キーで暗号化）。Lambdaが実行時に読んでメモリに保持する（`backend/shared/secrets.mjs`。2026-10-06切替、アプリ・ESP32で実機確認済み）。環境変数には鍵の名前 `SECRET_PARAMS` だけ。鍵を替えるときはSSMを変えるだけ（5分以内に反映）。
- IAMロールはCDKが関数ごとに作った最小権限のもの。旧ロールと旧Permissionは削除済み。v1の旧ロール `toytalk-lambda-role-dev` と旧Lambda 2本・API Gatewayも2026-10-26に削除済み。アカウント内の `toytalk*` Lambdaは8本だけ。
- **CLIはIdentity Center（SSO）で動かす**（2026-10-25）。`~/.aws/config` の `[sso-session toytalker]` と `[profile toytalker-rnd]`、`[default]` も同じSSO。IAMユーザーは `zackey`（鍵なし、緊急用コンソール）だけ。長期アクセスキーは無い。[セキュリティ見直し](security-review-2026-10-25.md)
- Lambda 8本はNode 24、ESP32用メインのメモリは2048MB。CDK化前に本番に入っていたコードとバイト単位で一致することを確認した上で引き取った。
- **STGは新名で合成される**（2026-10-16）。アカウント 131746731200、`cdk bootstrap` 済み、SSM鍵11件投入済み（RnDと同じ値）。`stages.ts` の `legacyNames`（RnDだけ true）で部品ID・固定名・スタック名を切り替える。deployとマスターデータ投入は3の中で。
- **テーブル名はコードに無い**（2026-10-13）。`stages.ts` の `tableSuffix`（RnDは空）をCDKが環境変数 `TABLE_SUFFIX` で配り、`backend/shared/tables.mjs` が組む。タグ `project` / `environment` も全資源に付けた。環境名は `rnd` / `stg` / `prd` / `prd-dg`。
- 組織 `o-lbme8l7xtz`、Identity Center（ユーザー `yamazaki`、グループ `admins`）、ルートアクセスの集中管理は整理済み。一覧は [複数アカウント計画](multi-account-iac-plan.md) の「アカウント一覧」。
- ファーム配布バケット `toytalker-firmware` はCDKの管理外（`fromBucketName` で参照のみ）。扱いは9で決める。
- **CDKの静的点検は `npx cdk synth --context stage=rnd --context nag=true`**（cdk-nag。指摘ゼロが前提で、受け入れる指摘は `lib/toytalker-stack.ts` の `acknowledgeNagFindings` に理由付きで書く。2026-10-25）。deploy前に `cdk diff` と合わせて通す。
- Windows機で `infra/` の動作確認済み（2026-09-29、Node v22.19.0・Git Bash。`npm ci`、`install-lambda-deps.sh`、型チェック、`cdk diff` が差分なし）。

## 順番

| 順 | 項目 | Claudeだけで | ユーザーが要る | 状態 | 詳細 |
|---|---|---|---|---|---|
| 1 | 命名の決定 | 案を出す | 最終OK | 済（2026-10-12、下記） | [命名規則](naming-conventions.md)、新旧対応は [複数アカウント計画](multi-account-iac-plan.md) の「命名」 |
| 2 | テーブル名の環境変数化とタグ（RnDへdeploy） → STGアカウント作成 → `cdk bootstrap` → SSM投入 → STGを新名で合成 | 環境変数化・タグ・bootstrap以降 | Organizationsでアカウント作成、SSM投入のOK | 済（2026-10-16。下記） | 上の「いまの状態」、[infra/README](../infra/README.md) |
| 3 | **RnDにCloudFront固定ドメイン**（`api-rnd.zakicorp.com` 等。Function URL は IAM 認証にして CloudFront だけが呼べるようにし、WAF でレート制限）→ アプリ・ESP32の接続先切替 → 実機確認 | CDK・アプリ・ファーム・deploy | Cloudflare DNS追加、実機確認 | 未着手。**DG を待たず RnD で進める**（2026-10-27決定。理由: 海外の利用者（中島さん）が使えるようにする。CloudFront は世界共通の入口なので、バックエンドは東京のままでよい。海外リージョンへの配置は遅延が問題になったら別途。URL固定は10(c)の復旧性と4の認証の前提）。STGへのdeployはDG案件として外した（[先送り項目](deferred-items.md)） | [複数アカウント計画](multi-account-iac-plan.md) |
| 4 | 認証（Cognito + Google / Sign in with Apple）→ 前払いポイント制 | CDK・Lambda・アプリ | Google Cloud / Apple Developer側の設定、実機確認 | 設計メモあり、未着手 | [先送り項目](deferred-items.md) の「ユーザー認証」、[原価と課金](pricing-and-cost-model.md) 第11節 |
| 5 | Cartesia 429時のずんだもんフォールバック、ZakiCorp TTS待ち行列の可視化 | 全部 | 実機確認 | 仕様あり、未着手 | [TTSフォールバック](tts-fallback-and-notifications.md)、[先送り項目](deferred-items.md) の「待ち行列の可視化」 |
| 6 | ESP32: 検索後の誤停止対策、OTA検証3件（電源断・SHA改ざん・ロールバック）、`stable` 発行、配布機のUSB書き込み、アプリの版表示と `fw_channel` 切替 | コード | 実機・S3操作・USB書き込み | 誤停止は原因仮説のみ・対策未合意 | [OTA引き継ぎ](handoff-esp32-ota-2026-09-16.md) |
| 7 | RnDの改名 → 自分用本番（CMK込み）→ DG向け本番。**本番・DGで入れる会話保護**（2026-10-27決定。RnDはやらない）: (a) ログと `chat-logs` テーブルを CMK で暗号化し、鍵ポリシーで復号できるのを Lambda ロールと自分だけにする（管理者権限を持つ運用者にも読ませない。鍵管理者は自分を必ず残す）、(b) Lambda のログに発話・返答の文章を書かない（会話ID・デバイスID・所要時間・エラーだけ）、(c) 運用者用に権限を絞った権限セット（ログは読めるが chat-logs は読めない）、(d) `chat-logs` の保持期間（TTL）は保護者向け機能にするかで決める | 大半 | アカウント作成×2、実機確認 | 未着手。3の後。GitHub Actions + OIDCは外した（[先送り項目](deferred-items.md)、2026-10-25） | [複数アカウント計画](multi-account-iac-plan.md) の「決めたこと」（CMKは本番で入れる）と「命名」 |
| 8 | セキュリティ強化: PITR・依存更新・CloudTrail組織トレイル・CLIのSSO化と長期鍵の削除（済）。**IaC点検の残り**: (a) CDK修正のdeploy（済 2026-10-26。S3/SNSのTLS強制、設定Lambda・Soniox LambdaのIAM縮小）、(b) v1残骸の削除（済 2026-10-26。残りはOpenAI鍵の作り直し判断）、(c) セキュリティ連絡先とIAMパスワードポリシー（済 2026-10-27）、(d) GitHubでDependabot alerts / security updates をON（済 2026-10-27）、(e) 決める: 不変バックアップの保管先と保持日数（10）。アカウント単位の公開ブロックは `zackey.xyz` を残すので保留、ログ保持期間は無期限のまま、同時実行上限は却下（[先送り項目](deferred-items.md)）。所有者確認は4、レート制限は3で | **脅威モデルの表を作る**（叩き台は [セキュリティ見直し](security-review-2026-10-25.md) の「次のセッション」） | (e)の値 | 1回目済（2026-10-25）。2回目は(a)〜(d)済、(e)は10の実装で。**次は脅威モデル**（2026-10-27） | [セキュリティ見直し](security-review-2026-10-25.md) の「IaC化した設定の点検」 |
| 9 | **Lambdaログの作り直し**（2026-10-27決定。次にLambdaを触るときに）: 会話の文章は `chat-logs` テーブルが正本で、Lambdaログには書かない。代わりに切り分けに要る情報を揃える: 会話ID・デバイスID・リクエストID、どこから来たか（App/ESP32、ファーム版、アプリ版）、段階ごとの所要時間（Soniox鍵発行、LLM最初のトークン、TTS各セグメントの最初のチャンク、応答ストリーム書き込み、合計）、外部サービスの応答コード、エラー。音声が途切れたときに「どの段階で何秒止まったか」をログだけで追える形にする（2026-10-26の遅延調査ではLambdaログに時間情報が無く特定できなかった）。ログ保持期間は無期限のまま（2026-10-27決定。会話の文章を書かなくなれば溜めるリスクが無く、費用対策の調査に使える。容量63MBで月数円）。小物: `toytalker-firmware` のTLS強制（CDKへの取り込みと同時に）、ToyTalker外の残骸の棚卸し（Prowlerの一覧は [セキュリティ見直し](security-review-2026-10-25.md) の「ベストプラクティス照合」）、`zackey.xyz` のDNSをRoute53からCloudflareへ移した（済 2026-10-27。CNAME → S3静的サイト、Proxied、SSL Flexible。Route53ゾーン削除済みでRoute53は$0。登録はお名前.com のまま）、**`zakicorp.com` と `zackey.xyz` の登録を 2026-12 上旬に Cloudflare Registrar へ移管**（更新直後45日以内の移管は更新分が失われることがあるため待つ。zakicorp.com は 2026-10-31 以降、zackey.xyz は 2026-12-03 以降。手順: お名前.com で移管ロック OFF とドメインプロテクション確認 → 基本情報の AuthCode 表示 → Cloudflare「Transfer a domain」→ 承認メール。費用は各 .com/.xyz 1年分の原価で、期限が1年延びる）、旧デモサイト `toytalk.zakicorp.com`（CloudFront + S3、2025-06）は面白いので残す。ただし中のチャットは削除済みのv1 API Gatewayを呼ぶので動かない（画像と画面だけ表示される）。動かすなら現行のFunction URLに向けて書き直す、`toytalker-firmware` の扱い（ファームは環境に属さず全機共通なので、環境ごとのスタックへ取り込むのは合わない。どのアカウントに置き、どう管理するかを別途決める。2026-10-25）、Soniox Lambda 128→256MB（コールドスタート時のSSM取得が約0.9秒。他は1〜2GBで約0.2秒。温めで普段は起きない）、`.local/tts-service/` へ supervisor.py 反映 | 全部 | 削除のOK | 未着手（v1残骸は8(b)で2026-10-26に削除済み） | [ZakiCorp TTS](zakicorp-tts.md) |
| 10 | **消されても戻せる仕組み**（2026-10-26。前提: 全部が同じアカウントにあるので、管理者権限の誤用・乗っ取り・AI操作の誤承認で PITR やバージョンごと消せる）: (a) **別アカウントの不変バックアップ**（根治）。AWS Backup で DynamoDB 8テーブルと S3 `toytalker-tts-speakers` / `toytalker-firmware` を日次で保管庫に取り（**2026-10-27決定: 同じRnDアカウントに置く。保持35日**。別アカウントは root 乗っ取りによる閉鎖にだけ効くので、本番アカウント分離のときに再検討）、Vault Lock（= 不変・イミュータブルバックアップ。コンプライアンスモード、保持35日程度）で RnD の管理者にも root にも消せなくする。別リージョン退避は不要（権限が同じなら別リージョンでも消せる。守る相手は障害でなく権限の誤用）。データは合計約6MBで月数十円。(b) **復元訓練**（根治）。PITR から1テーブルを別名で復元して中身を確かめて消す。手順を [セキュリティ見直し](security-review-2026-10-25.md) に書く。(c) **URLの固定**は3のCloudFront固定ドメインで解決（Function URL 5本がESP32・アプリに直書きで、スタック再作成でつながらなくなる）。(d) **鍵の再発行手順**（痛み止め）。SSMの鍵11本はAWSにしかないので、発行元と手順を文書化（値は書かない。名前は `infra/lib/secrets.ts`）。(e) CloudTrail バケットのバージョニング（痛み止め） | (a)のCDK、(b)、(d)、(e) | (a)の保管先アカウントの決定、Vault Lock は不可逆なので保持日数のOK、(b)の実施OK | 未着手。設計のみ | [セキュリティ見直し](security-review-2026-10-25.md) |

並べた理由: 1は2以降の名前の前提。8（セキュリティ）は4の前に済ませる。4〜6は2〜3と独立なので、ユーザーの手待ちの間にClaudeが進められる。7は本番なので最後。**3（RnDのCloudFront固定ドメイン）はDGを待たずに進める。STGへのdeployはDG案件としてロードマップから外した**（[先送り項目](deferred-items.md)）。順は 8（脅威モデル）→ 10 → 9 → 3 → 4。

## 1の決定（2026-10-12）

- 形は `toytalker-<機能>-<環境>`（例 `toytalker-chat-app-stg`、`toytalker-devices-stg`）。計画メモの案から環境名を最後に変え、種類の接尾辞は付けず、タグ `project` / `environment` を全資源に付ける。規則は [命名規則](naming-conventions.md)、新旧対応表と適用の順番は [複数アカウント計画](multi-account-iac-plan.md) の「命名」節。
- **DynamoDBのキー名（`owner_id#device_id` 等）は変えない。** 変えるとデータ移行とコード全面修正が入り、環境名を付ける目的とは無関係。
- 未ログイン端末の扱い（4で必要: ログイン必須かゲスト継続か）は4の着手時に決める。
- 「Lambdaコードがテーブル名を環境変数から組み立てる」直しとタグは2026-10-13にRnDへ入れた（RnDの名前は変えていない）。STGは最初から新名で作る。RnDの改名は7。

## 済

- SSM鍵の再読み込みを待つように修正し、初回読み込み失敗時は1回取り直す（2026-10-27）。warmup pingのたびに裏の再読み込みが凍結され、1日約165件の `[secrets] load failed` が出ていた。`backend/shared/secrets.mjs`。会話への影響は無かった
- セキュリティ強化の即効分（2026-10-25）。PITR、依存更新、CloudTrail組織トレイル、CLIのSSO化、長期鍵3本とIAMユーザー2つの削除。[セキュリティ見直し](security-review-2026-10-25.md)

- STGの準備（2026-10-16）。アカウント 131746731200、`cdk bootstrap`、SSM鍵11件、`legacyNames` による新名合成。deployと投入は3へ。

- テーブル名の環境変数化とタグ（2026-10-13）。RnDの名前は変えず、CDKが配る `TABLE_SUFFIX` から `backend/shared/tables.mjs` が組む。`stages.ts` の `prod` / `prod-dg` も `prd` / `prd-dg` へ。[infra/README](../infra/README.md) の「名前とタグ」
- 命名の決定（2026-10-12）。`toytalker-<機能>-<環境>`。[命名規則](naming-conventions.md)
- 秘密の実行時取得（2026-10-06）。Lambda 8本がSSMから鍵を読む。[複数アカウント計画](multi-account-iac-plan.md) の「秘密の実行時取得」
