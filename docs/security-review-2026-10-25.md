# セキュリティ見直し（2026-10-25）

認証（ロードマップ4）に着手する前に、公開している入口とアカウント運用を棚卸しした記録。セキュリティの現状と残りの対策はこの文書が入口。守りの順番は先頭の「脅威モデル」が決める。済んだ項目は「済（日付）」にし、新しい発見はここに追記する。

## 脅威モデル（2026-10-27）

「誰が・何を狙って・どこから入り・入られると何が起きるか」を表にして、守りの順番を決めたもの。チェックリスト（cdk-nag / FSBP）は下の「IaC化した設定の点検」で、侵入に関係する指摘は Function URL 公開の1件だけだった。この表はコード（`backend/`、`devices/mcu/esp32_s3/toytalker_mini_v0.7/`、`app/`、`infra/`）を読んで作った。状態が変わったら行を上書きする。

前提: リポジトリは公開なので、Function URL 7本・アカウントID・テーブル名・APIの形は「知られている」ものとして扱う。守りは秘密のURLではなく認証と上限で作る。

### 表（深刻な順）

| # | 誰が | 狙い | 入口 | 入られると | 今の守り | 足りないもの（どの項目で） |
|---|---|---|---|---|---|---|
| 1 | インターネット上の誰でも（ファーム・アプリ・公開リポジトリからURLを知る） | 自分の費用でLLM・TTS・STTを使う（費用燃やし） | Function URL 7本（認証なし、CORS `*`）。会話2本は `messages`・`model`（TTS会社）・`voice`（ベンダーのボイスID）を本文で自由に指定でき、一番高いTTSを選べる。Soniox鍵発行は誰にでも1時間有効の文字起こし鍵を返す。クローンボイス登録は Cartesia の従量課金と自宅PCのGPUを使う | 外部API各社の請求（**AWS予算の外**）、Soniox・Cartesiaの枯渇、ZakiCorp PCのGPU占有で正規の会話が止まる | URLが長い乱数なこと、月次レポートの集計、各社ダッシュボード。天井は無い | 各社側の支出上限は置かない（2026-10-27決定。正規利用の増加でも全員の会話が止まる。天井は4の認証とポイント制で身元ごとに作る）。各社側に置くのは**使用量アラート**だけで、鍵漏れやバグの暴走に気づく用（ユーザー操作、急がない）。**3**: CloudFront + WAF のレート制限・国制限、Function URL を IAM 認証にして直叩きを塞ぐ。**4**: 認証と身元ごとのサーバー側上限（前払いポイント）。小物: Soniox一時鍵の寿命を1時間→会話1回分（数分）へ |
| 2 | `device_id`（BLE MAC）か `owner_id`（アプリのランダムUUID）を知った人 | 他人の会話ログを読む、設定を変える、子どもへの発話内容を決める | 設定Lambda全ルート。`owner_id` は本文・クエリの自称を信用。`POST /devices` の再登録で `owner_id` 上書き、`PUT /devices/{id}` は所有者を見ない、**`DELETE /devices/{id}` は本文に `owner_id` を入れなければ所有者確認を通過する**、`GET /logs/*` / `/usage*` は自称の `owner_id` で読める。MACは48bitで上位24bitはベンダー固定、同一ロットは連番に近く、設定モード中はBLEで読める（広告名 `ToyTalker-XXXX` は下2バイト） | 子どもの会話ログの閲覧。キャラクター差し替え（人格プロンプト＝子どもに話す内容を第三者が決められる）。相槌OFF、デバイス削除、`fw_target` で古い版への固定（自分のバケット内の版に限る） | IDの推測困難性だけ。アプリのUUIDは推測しにくいが、ESP32の未登録機は MAC が `owner_id` にもなる | **4**: 所有者確認（下の「認証フェーズへ渡す所有者確認の一覧」）、製造時のデバイス鍵（下の「ファーム側の認証の方針」）。小物（4の前でも入れられる）: `DELETE /devices/{id}` の `owner_id` 必須化 |
| 3 | 同じWi-Fiにいる人、偽アクセスポイント（公衆Wi-Fi、宿泊先、近所） | 子どもへの発話の乗っ取り、盗聴 | **ESP32 v0.7 は Lambda への TLS を `setInsecure()` で結び、証明書を検証していない**（`toytalker_mini_v0.7.ino` 1716行）。Soniox の WebSocket も `beginSSL` にCAを渡していない。OTA だけは CA 検証＋ホスト固定（`OtaUpdater.h`） | 返答音声を差し替えて任意の言葉を子どもに言わせる。発話・返答の盗聴。Soniox鍵の横取り | なし（Wi-Fi自体の暗号化に頼っている） | **6のファーム作業に入れる（根治、小さい）**: `OtaUpdater.h` の `AMAZON_ROOT_CAS` を会話・相槌・Soniox鍵発行の接続にも `setCACert` で使う。3でCloudFrontに替わっても証明書は Amazon Trust Services なので同じ束で足りる。Soniox のCAは別に要る（証明書チェーンを確認して束に足す） |
| 4 | 偽ファームを配ろうとする人 | 機器の乗っ取り（マイク・スピーカー付きの機器） | OTA。本体はホスト固定（`toytalker-firmware` バケット）・CA検証・SHA-256・起動後の自己確認（ロールバック）。SHA は Lambda が同じバケットの `manifest.json` から返すので、**信頼の根は `toytalker-firmware` への書き込み権限**（= AWS管理者権限、#7） | 全機が勝手に動く | 上の4点。バケットは公開ブロック・バージョニングあり | **6**: 検証3件（電源断・SHA改ざん・ロールバック）。**9**: バケットのTLS強制とCDK取り込み。**本番で検討**: ファーム署名（ESP32 Secure Boot v2）か、少なくとも配布バケットを本番アカウントの絞った権限で管理 |
| 5 | Web検索結果に指示を仕込む人（プロンプトインジェクション） | 子どもに不適切な発話をさせる | LLMのツール（Brave検索）の結果がLLMの入力になる。ツールは検索だけで、書き込み・外部送信の手段は無い | 不適切な返答1回。データ流出や設定変更は起きない | システムプロンプト、ツールの範囲が検索だけ | 本番で: 子ども向け出力の安全フィルタ（各社のモデレーションAPI）を検討。先送りで可 |
| 6 | 自宅PCのAPIサーバーを狙う人 | 開発PCの乗っ取り（= #7 と #8 の足場） | Cloudflare Tunnel → `tts.zakicorp.com` → PC上のPython APIサーバー。WAF で Edge キー必須、Bearer 鍵、`/health` は `status` だけ、話者名は英数字と `-_` | PCごと取られる。PCにはSSOセッション（8時間）、リポジトリ、ブラウザのセッションがある | 2段の合言葉、Cloudflare WAF | **検討**: APIサーバーを開発PCと分ける（別マシン / VM / 別のWindowsユーザーで実行）。β版のまま本番へ持ち込まない（本番のクローンボイスはCartesia） |
| 7 | AWS管理者権限を奪う人（PCの乗っ取り、SSOセッションの横取り、**Gmailの乗っ取り**） | 全部（データ消去・鍵奪取・偽ファーム配布・請求） | このPC（SSOセッション8時間、ブラウザのポータル）。Gmail は Identity Center のパスワード再設定先でありルートのメールでもある。**Gmailが要石** | 全部。復旧の手段も同じ権限で消せる | パスキーMFA（Identity Center・ルート）、長期鍵なし、CloudTrail組織トレイル、削除保護、PITR | **10**: 不変バックアップ（Vault Lock）・復元訓練。**今すぐ（ユーザー操作）**: Gmail の2段階認証をパスキー/認証アプリにし、復旧用電話・メールを見直す。**7(c)**: 日常用の読み取り専用権限セット。**本番**: GuardDuty |
| 8 | 開発PC上のAI（Claude Code / Codex）が騙される・誤操作する | 消す・壊す・鍵を漏らす | リポジトリ内容・Web文書・MCP結果に仕込まれた指示。承認ダイアログの読み飛ばし | データ消失、設定破壊 | 破壊操作は `ask`、説明→OKのルール、削除保護、PITR、鍵は環境変数に無い | **10**: 不変バックアップ。承認ダイアログを読む習慣（運用） |
| 9 | 悪意ある依存パッケージ（npm: Lambda・CDK・アプリ、Arduinoライブラリ） | 鍵を盗む、バックドア | `npm ci` → esbuild でバンドルして配る。Arduino は IDE のライブラリマネージャで手動更新 | 鍵流出（SSMの鍵はLambdaが実行時に読むので、Lambda内のコードからは読める） | lockfile、`npm audit` 0件、Dependabot alerts / security updates ON、secret scanning / push protection | Arduino ライブラリの版を [ESP32ファーム](esp32-firmware.md) に固定記録する（運用） |
| 10 | 内側で読める人（自分、将来の運用者） | 子どもの会話を読む | `chat-logs` テーブルとLambdaログ（文字起こしが残る）。RnDは管理者が全部読める | プライバシー侵害（子どものデータ） | 1人運用 | **9**: Lambdaログから会話の文章を外す。**7(a)〜(d)**: 本番でCMK・権限セット分離・TTL |

### 表から決めた守りの順番

ロードマップの順（8 → 10 → 9 → 3 → 4）は変えない。表はそれに**今すぐできる小物**と**各項目に入れる1行**を足す。

- **ユーザーの操作だけ**: (a) Gmail の2段階認証と復旧方法の見直し（#7。済 2026-10-28）、(b) 外部APIの使用量アラート（#1。支出上限は置かない。Soniox・Cartesia・Google の3社だけでよい）。どちらもコード変更なし。
- **6（ファーム）に入れる**: Lambda・Soniox への TLS 証明書検証（#3）。OTA の検証3件と同じ版で出す。
- **4（認証）に入れる**: 所有者確認一覧（#2）、デバイス鍵。4の前に小物として `DELETE /devices/{id}` の `owner_id` 必須化と Soniox 一時鍵の寿命短縮を入れてよい（Lambda修正→deploy。説明→OK）。
- **3（CloudFront）**: 「壁」であって「鍵」ではない。Function URL を IAM 認証にして CloudFront だけが呼べるようにし、WAF でレート制限と国制限、ドメイン固定で再作成に強くする。誰が呼んでいるかは分からないので、4と両方要る。
- **10**: 表の #7 / #8 の最後の守り。順番どおり次にやる。
- **本番で**: ファーム署名の検討（#4）、出力の安全フィルタ（#5）、GuardDuty（#7）、CMKと権限分離（#10）、ZakiCorp TTS の分離（#6）。

### ファーム側の認証の方針（4の設計に入れる）

製造時に一台ごとの鍵を NVS に焼き、サーバーはハッシュだけを devices に持つ。毎リクエストでデバイスIDと鍵（または鍵で署名したタイムスタンプ）を送り、Lambda が先頭で照合。持ち主との紐づけはアプリで箱のコード/QRを読んで Cognito ユーザーと結ぶ。漏れたら devices の1行を無効にしてその1台だけ止める。証明書（AWS IoT 方式）はファーム変更が大きいので後回し。前提として #3 の証明書検証が要る（検証なしでは鍵も中間者に渡る）。

## 消されても戻せる仕組み（ロードマップ10、2026-10-28）

脅威モデル #7（管理者権限の乗っ取り）と #8（AI操作の誤承認）の最後の守り。前提は「全部が同じアカウントにあるので、管理者権限があれば PITR も S3 の版も一緒に消せる」こと。守る相手は障害でなく権限の誤用なので、別リージョン・別アカウントには出さない（別アカウントは root 乗っ取りによる閉鎖にだけ効く。本番アカウント分離のときに再検討。2026-10-27決定）。

### (a) 不変バックアップ（根治）

CDK `infra/lib/toytalker-stack.ts` の `createImmutableBackup`。有効化は `config/stages.ts` の `backup: { retentionDays: 35 }`（RnDだけ）。

| 項目 | 値 |
|---|---|
| 保管庫 | AWS Backup `toytalker-backup-rnd`（新名。暗号化は AWS 管理キー `aws/backup`、CMK は本番で） |
| ロック | Vault Lock **コンプライアンスモード**。最小保持35日・最大36日、確定までの猶予3日（AWS の下限）。確定後は管理者・root・AWS のどれも復旧点を消せず、保管庫の設定も変えられない。復旧点が全部期限切れになれば保管庫は消せる。最大も縛るのは、無期限の復旧点を入れられて保管庫が永久に消せなくなるのを防ぐため |
| 計画 | `toytalker-backup-rnd`、毎日 03:00 JST（開始猶予1時間・完了猶予4時間）、保持35日 |
| 対象 | DynamoDB 8テーブル、S3 `toytalker-tts-speakers`・`toytalker-firmware`・`toytalker-cloudtrail-org`（定期スナップショット方式。継続方式は EventBridge 通知が要り、CDK管理外のファームバケットを触るので使わない。初回は全量、以後は差分） |
| ロール | `BackupRole`（AWS管理ポリシー4つ: Backup / Restores / S3Backup / S3Restore）。復元ジョブにもこのロールを渡す。ARN はスタック出力 `BackupRoleArn` |
| 前提 | AWS Backup のアカウント設定で DynamoDB の「高度な機能」が有効（2026-10-28確認、`describe-region-settings` の `ResourceTypeManagementPreference.DynamoDB = true`）。無効だとバックアップが DynamoDB 側の管理になり保管庫のロックが効かない |
| 費用 | データ合計約6MB（chat-logs 5.7MB、S3 4.6MB）。DynamoDB は毎日全量、S3 は差分で、35日分でも数百MB。月数十円 |

効かないもの: バックアップ計画そのものは消せる（消されると翌日から新しい復旧点が増えなくなる。既存の復旧点は35日残る）。計画の有無は月次の点検か AWS Backup のジョブ通知で気づく。アカウント閉鎖は90日の猶予後に保管庫ごと消える。

**ロック確定前の3日間にやること**: 初回バックアップの成功を `aws backup list-backup-jobs --by-backup-vault-name toytalker-backup-rnd` で確認し、下の復元訓練（保管庫から）を1回通す。失敗していれば `aws backup delete-backup-vault-lock-configuration --backup-vault-name toytalker-backup-rnd` でロックを外して直す。

### (b) 復元訓練（根治）

PITR と保管庫の2経路。**PITR はテーブルが消されたら使えない**（削除時に DynamoDB が自動で作る `<table>$DeletedTableBackup` は35日残るが、管理者権限で消せる）。消されたときの本命は保管庫。

PITR から別名で復元（データを壊さない。復元したテーブルには削除保護・PITR・タグが付かないので訓練後に消す）:

```bash
aws dynamodb restore-table-to-point-in-time --source-table-name toytalker-llms \
  --target-table-name toytalker-llms-restore-test --use-latest-restorable-time   # 特定時刻は --restore-date-time
aws dynamodb wait table-exists --table-name toytalker-llms-restore-test          # 数分〜十数分
aws dynamodb scan --table-name toytalker-llms --select COUNT --query Count
aws dynamodb scan --table-name toytalker-llms-restore-test --select COUNT --query Count   # 件数が一致
aws dynamodb delete-table --table-name toytalker-llms-restore-test               # 片付け
```

保管庫から復元（DynamoDB）:

```bash
aws backup list-recovery-points-by-backup-vault --backup-vault-name toytalker-backup-rnd \
  --by-resource-arn arn:aws:dynamodb:ap-northeast-1:342082316736:table/toytalker-llms \
  --query "RecoveryPoints[].[CreationDate,RecoveryPointArn,Status]" --output table
aws backup start-restore-job --recovery-point-arn <RecoveryPointArn> \
  --iam-role-arn <BackupRoleArn（cdk の出力）> --metadata TargetTableName=toytalker-llms-restore-test
aws backup describe-restore-job --restore-job-id <RestoreJobId>                  # COMPLETED まで待つ
```

保管庫から復元（S3）: `--metadata DestinationBucketName=<復元先>,EncryptionType=original`（復元先はバージョニング有効の既存バケット。元のバケットへ戻すときは既存オブジェクトを上書きせず、消えたものだけ戻る。`RestoreLatestVersionsUpTo=all` で全版）。

本番で本当に消されたとき: 元の名前で復元する（`TargetTableName=toytalker-llms`）。CloudFormation は名前で資源を見ているので、同じ名前で戻せばスタックのドリフトも消える。復元後に削除保護と PITR を `aws dynamodb update-table` で付け直す（次の `cdk deploy` でも揃う）。Lambda はテーブル名しか知らないので、コードやdeployは要らない。

訓練の記録:
- 2026-10-28 PITR: `toytalker-llms` → `toytalker-llms-restore-test`（最新時点）。CREATING から ACTIVE まで約5分、件数5=5、`llm_id` の一覧が一致。削除保護は付かない（`DeletionProtectionEnabled: False`）ことを確認し、削除。
- 2026-10-28 保管庫から: `start-backup-job` で `toytalker-llms` をオンデマンドで取り（約3分、447バイト、復旧点は `arn:aws:backup:...`）、`start-restore-job` で `toytalker-llms-restore-test` へ復元（約10分）。件数5=5、`llm_id` 一致。削除。復旧点の削除は Vault Lock で拒否されることになっているが、Claude Code 側の権限で試せなかったので、確認するなら手で `aws backup delete-recovery-point` を打つ（AccessDenied になるのが正常）。

### (c) URL の固定

ロードマップ3の CloudFront 固定ドメインで解決する。Function URL 5本がアプリ・ESP32に直書きで、スタック再作成でつながらなくなる。

### (d) 鍵の再発行手順（痛み止め）

SSM `/toytalker/<key>` の値（必須11本・任意2本）は AWS にしかない（ZakiCorp の2本だけサーバー側 `.env` にも同値がある）。アカウントを失ったら全部を発行元で作り直す。値はどこにも書かない。名前の正本は `infra/lib/secrets.ts`、各社へのログインは exodjp@gmail.com（Gmail が要石、脅威モデル#7）。

入れ替えの共通手順（無停止）: (1) 発行元で新しい鍵を作る（古い鍵はまだ消さない） → (2) `cd infra && printf '%s' "$VALUE" | npx tsx scripts/put-secret.ts rnd <NAME> --overwrite` → (3) 稼働中の Lambda は5分を過ぎた次の呼び出しで取り直す。会話1回か CloudWatch の `[secrets] loaded` で確認 → (4) 発行元で古い鍵を消す。deploy は要らない。

| SSM名（`secrets.ts` の名前） | 発行元 | 注意 |
|---|---|---|
| `openai-api-key` | platform.openai.com → Project `toytalker` → API keys（Service account 鍵 `toytalker-rnd`。2026-10-27 に作り直し済み） | LLM（GPT）と OpenAI TTS |
| `anthropic-api-key` | console.anthropic.com → API Keys | LLM（Claude） |
| `google-api-key` | Google Cloud コンソール → APIs & Services → Credentials（AI Studio で作った鍵も同じ場所に出る） | Gemini（既定LLM）と Cloud Text-to-Speech の両方が有効なプロジェクトで作る。止まると既定の会話が止まるので最優先 |
| `elevenlabs-api-key` | elevenlabs.io → Developers → API Keys | 月次レポートで使用量を取るなら `user_read` 権限を付ける（いまの鍵には無く401） |
| `fishaudio-api-key` | fish.audio → API Keys | TTS |
| `sakura-api-key` | さくらインターネット「さくらのAI Engine」のコントロールパネル（`api.ai.sakura.ad.jp`） | ずんだもん。Cartesia 429 時のフォールバック先（ロードマップ5） |
| `cartesia-api-key` | play.cartesia.ai → API Keys | TTS とクローンボイス登録。前払いクレジット |
| `zakicorp-api-key` | 自分で発行（乱数）。サーバー側 `tts-models/faster-qwen3-tts/scripts/.env` の `ZAKICORP_API_KEY` と同値 | サーバー側は新旧両方を受け付けないので、短い停止を保守時間に。手順は [起動・復旧](tts-boot-recovery.md) |
| `zakicorp-edge-key` | 自分で発行。Cloudflare WAF ルール `tts-edge-key-required`（ゾーン `zakicorp.com`）と `.env` と SSM の3か所 | 無停止の順番（ルールを新旧どちらでも通す → SSM と `.env` → ルールを新だけに）は [起動・復旧](tts-boot-recovery.md) の「拠点での遮断」 |
| `brave-api-key` | api-dashboard.search.brave.com → API Keys | Web検索（2026-10-28 に Serper から切替。Serper の鍵は SSM から削除済み、アカウント解約待ち） |
| `soniox-api-key` | console.soniox.com → API Keys | STT。Lambda がこの親鍵から一時鍵を発行する。止まると会話が始まらない |
| `openai-admin-key` / `anthropic-admin-key` | OpenAI: Organization settings → Admin keys。Anthropic: Settings → Admin keys | 任意。月次レポートが請求額を取るときだけ。読み取り専用に絞れないので当面置かない方針（[原価と課金](pricing-and-cost-model.md)） |

全部失ったときの順番: Soniox（会話が始まらない）→ Google（既定LLM・TTS）→ Cartesia / ZakiCorp 2本（主なボイス）→ 残りの TTS → 検索 → 管理キー。

### (e) CloudTrail の保管先を守る

CloudTrail は毎回別のキーで新しいファイルを書くので、バージョニングに上書き保護の意味は無い（2026-10-28、ユーザー指摘）。残るのは「消しても削除マーカーが付くだけで版が残る」の一点で、版の削除までやられれば終わり。そこで本命は **`toytalker-cloudtrail-org` を金庫（上の (a)）の対象に足す**ことにした（根治。年に数百MB）。`versioned: true` も雑な削除への保険として残す。

バケットが消されても、CloudTrail の**イベント履歴**（トレイルと無関係にアカウント・リージョンごとに管理イベントを90日保持。利用者は消せない。`aws cloudtrail lookup-events`）で直近90日の操作は追える。データイベントは含まず、組織横断では見られない。改ざんの検知は CloudTrail 自身のログファイル検証（有効）で。

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

2026-10-25の棚卸しの一覧。2026-10-27以降に見つけたもの（ESP32の証明書検証なし、`DELETE /devices/{id}` の所有者確認の抜け、Soniox一時鍵の寿命など）は先頭の「脅威モデル」の表にだけ書く。

1. **デバイスの乗っ取り。** `POST /devices` は既存の `device_id` を再登録すると `owner_id` を上書きする。`PUT /devices/{id}` は所有者を確認しない。ESP32の `device_id` はBLEのMACアドレスで、推測の余地がある。乗っ取られると、キャラクター・相槌・ファーム版指定（`fw_target`。自分のS3の署名付きURLとSHA検証の範囲内）を変えられ、**以後の会話ログが乗っ取った側の `owner_id` で記録されて読める**。キャラクターとカスタムボイスの更新・削除も「システム製でないこと」しか見ていない。
2. **会話ログの閲覧はクライアントの `owner_id` を信用している。** ESP32のログは、登録済みデバイスならデバイス行の `owner_id`（アプリ側のランダムUUID）で記録されるので、MACだけでは読めない（当初「MACだけで読める」と評価したが誤り。未登録デバイスのログだけMACが鍵になる）。守りはUUIDが推測できないことだけで、1の乗っ取りと組み合わさると破れる。
3. **費用を燃やされる経路。** 本文・相槌・読み上げ・Soniox一時鍵発行の全部が無認証・無制限。Function URLにはWAFもレート制限も付けられない。
4. **AWS資格情報の運用。** RnDアカウントにIAMユーザー3人分と長期アクセスキー3本が有効。`codecommit`（2020年作成、未使用、CodeCommitの残骸。同名リポジトリが1つ残る）、`yamazaki-3tyd`（2024年にS3を1回使ったきりのAdministrator）、`zackey`（CLIで使用中のAdministrator）。Identity Centerを整えたのにCLIは長期鍵のまま。「料金表やデバイス情報が入れ替わる」最大の経路はAPIでなくここ。
5. **復旧と検知の手段がない。** DynamoDBのPITRが全テーブルで無効。CloudTrailのトレイルが無く90日の履歴のみ。GuardDuty無効。
6. Lambda 3本の依存に修正版のある高リスク脆弱性（`undici` 8.x の応答非同期化、`fast-xml-parser` の実体展開上限回避）。

## 対策と時期

| 時期 | 対策 | 性質 | 状態 |
|---|---|---|---|
| 今すぐ | 全テーブルにPITR（CDK） | 根治 | 済（2026-10-25、8テーブルENABLED） |
| 今すぐ | Lambda 3本の依存更新（`npm audit fix`、package.jsonの範囲内） | 根治 | 済（2026-10-25、RnDへdeploy。温め・会話で正常） |
| 今すぐ | CloudTrail組織トレイル（スタック `toytalker-org`、バケット `toytalker-cloudtrail-org`、管理アカウントに1本） | 根治 | 済（2026-10-25。信頼されたアクセス有効化→deploy、Logging: true） |
| 今すぐ | CLIをSSOへ移し、長期鍵3本とIAMユーザー `codecommit` `yamazaki-3tyd` を削除。`codecommit` リポジトリは中身確認後に削除 | 根治 | 済（2026-10-25）。残るIAMユーザーは `zackey` のみ（鍵なし、パスワード+パスキー2本、**緊急用のコンソール入口として残す**） |
| 認証と一体（4） | Lambdaがトークンの本人を使う。デバイス・キャラ・ボイス・ログの所有者確認。再登録での `owner_id` 上書き禁止 | 根治 | 未。設計は [先送り項目](deferred-items.md) の「ユーザー認証」 |
| 固定ドメインと一体（3） | CloudFront + WAFでレート制限・地域制限 | 根治 | 未。ゲスト会話を残す限り認証では防げない |
| 認証後 | デバイス登録をログイン必須に | 根治 | 未 |
| 保留 | GuardDuty（月数百円〜）。他人が入る本番で再検討 | — | 保留 |
| 今すぐ | **v1残骸の削除**（無認証のAPI Gateway `toytalk-chat-apigateway-dev` → Python Lambda 2本。環境変数にOpenAI鍵、ロールはS3/DynamoDB/LambdaのFullAccess。30日間呼び出しゼロ）。削除後、その鍵がSSMの鍵と同じならOpenAI側で作り直す | 根治 | **済（2026-10-26）**。API Gateway、Lambda 2本、ロール `toytalk-lambda-role-dev`、ロググループ3つ（孤立の `toytalk-stream-handler-for-esp32-lambda` 分を含む）を削除。コードは `backend/*.py` に残る。最終ログは2025-08で、1年以上未使用だった。OpenAI鍵は1本しかなく v1 と現行で同じだったので、2026-10-27 に作り直した（Project `toytalker`、Service account 鍵 `toytalker-rnd`、SSM 版2）。古い鍵と旧 Project は削除。観察: 作り直し前の7日間に、ToyTalker の Lambda が無稼働の日を含めて21件の小さな Chat Completions（入力10トークン程度）が古い鍵から出ていた。発信元は不明（このPC・Codex・.env には鍵なし）。新しい鍵で続くかを Usage で見る |
| 今すぐ | CDK修正のdeploy: S3 `toytalker-tts-speakers` とSNSのTLS強制、設定Lambdaの書き込み権限を devices/characters/voices に縮小、Soniox LambdaはdevicesのUpdateItemだけ | 根治 | **済（2026-10-26 deploy）**。差分はIAM 2本の縮小とポリシー2つの追加だけ、Replaceなし、32秒 |
| 今すぐ | 無料のアカウント設定: セキュリティ連絡先（Account.1）、IAMパスワードポリシー（IAM.7） | 根治 | 済（2026-10-27） |
| 今すぐ | GitHubのDependabot alerts / security updates を有効化（`.github/dependabot.yml` は追加済み） | 根治 | 済（2026-10-27） |
| 決める | Lambdaの同時実行上限（費用燃やしの天井。`reservedConcurrentExecutions`）とInvocations/Durationのアラーム | 痛み止め | 未。上限値を決める（下の「IaC点検」） |
| 決める | Lambdaログの保持期間（いまは無期限。会話の文字起こしがログに残る） | 根治 | 未 |
| 10 | 消されても戻せる仕組み: AWS Backup + Vault Lock（コンプライアンス、35日。DynamoDB 8テーブル、S3 3バケット（CloudTrail 含む））、復元訓練、鍵の再発行手順 | 根治（(d)は痛み止め） | **deploy 済（2026-10-28 19:39 JST。ロック確定は 2026-10-31 19:39 JST）**。PITR 訓練済。上の「消されても戻せる仕組み」 |
| 9で | `toytalker-firmware` のTLS強制（CDK管理外。取り込みと同時に） | 根治 | 未 |
| 本番で | DynamoDB・CloudTrail・SNS・ログのCMK暗号化（[複数アカウント計画](multi-account-iac-plan.md) の決定どおり）、CloudTrailのCloudWatch Logs連携、Config + Security Hub | 根治 | 本番アカウントで |

「再登録で `owner_id` を上書き」は、端末のリセットや機種変更での正当な再ペアリングも同じ経路なので、本人確認の無い今は塞げない。認証で本人が分かってから直す。

## SSOへの切替と鍵の削除（2026-10-25に実施済み。再現用の手順）

1. Identity Centerのユーザー `yamazaki` のパスワードを設定する（入口 `https://d-95671d6109.awsapps.com/start` の「パスワードを忘れた」→ gmail → MFA登録）。
2. `aws configure sso` でプロファイルを作る（入口URL、`ap-northeast-1`、アカウント 342082316736、権限セット `AdministratorAccess`）。`aws sso login --profile <名前>` → `aws sts get-caller-identity --profile <名前>` で確認。
3. `AWS_PROFILE` を環境変数に置き、`cdk diff --context stage=rnd` が通ることを確認する。
4. 削除の順: `codecommit` のリポジトリ確認 → ユーザー `codecommit`（鍵・Git資格情報・ユーザー）→ ユーザー `yamazaki-3tyd`（鍵・ユーザー）→ 最後に `zackey` の鍵。各削除は説明→OK。

実施結果（2026-10-25）:
- Identity Center: MFAは「サインインごと」「セキュリティキーと内蔵認証のみ」「未登録なら登録必須」。`yamazaki` にパスキー2本（Windows Hello、iPhone）。アクセスポータルの別名は `zackey.awsapps.com`（`d-95671d6109` と同じ）。
- CLI: `~/.aws/config` に `[sso-session toytalker]` と `[profile toytalker-rnd]`。`[default]` も同じSSOに向けたので、`AWS_PROFILE` 無しでSSOになる。`~/.aws/credentials` は空。期限（8時間）が切れたら `aws sso login`。
- 削除済み: ユーザー `codecommit`（鍵・Git資格情報・ポリシー）とリポジトリ `codecommit`（2020年のreadmeのみ）、ユーザー `yamazaki-3tyd`（鍵・パスワード・MFA・ポリシー）、`zackey` のアクセスキー。
- `zackey` は残す。パスワード+パスキー2本でコンソールのみ。Identity Centerに入れなくなったときの、ルートを使わない予備口。
- アクセスポータルの Active sessions にCLIのログインは行として出なかった。CLIの痕跡はCloudTrailの `CreateToken` / `GetRoleCredentials`（イベントソース `sso.amazonaws.com`）。

## 認証フェーズへ渡す所有者確認の一覧

`backend/toytalker-device-setting-lambda/index.mjs`:

- `POST /devices`: 既存行の `owner_id` と本人が違えば403（新規登録は本人を書く）。
- `PUT /devices/{id}` / `DELETE /devices/{id}` / `GET /devices/{id}`: 行の `owner_id` と本人の一致。
- `PUT|DELETE /characters/{id}`、`PUT|DELETE /custom-voices/{id}`: 行の `owner_id` と本人の一致（システム製は従来どおり拒否）。
- `GET /logs/*` / `GET /usage*` / `GET /devices` / `GET /characters` / `GET /custom-voices`: クエリの `owner_id` を捨て、本人IDを使う。

本文・読み上げ・相槌Lambda: `owner_id` を本文から受け取っている箇所を本人IDへ。ESP32経由はデバイス行の `owner_id` を使う現在の方式を維持。

## IaC化した設定の点検（2026-10-25、2回目）

上の棚卸しの後、CDKのコードと合成したテンプレート、稼働中の設定を機械的に照合した。使ったもの: cdk-nag 3.0.2（AwsSolutions + Serverless）、checkov 3.3.30（テンプレート）、AWS CLIの読み取り、IAM Access Analyzer、Prowler 5.45（Security Hub FSBP基準）。設定変更はしていない。

### 1. CDKの静的点検（cdk-nag）

`cd infra && npx cdk synth --context stage=rnd --context nag=true` で動く（`bin/toytalker.ts`）。指摘はエラーになり synth が止まるので、**deploy前にこれが通ることを確認する**。初回は68件。

- **直した**: S3 `toytalker-tts-speakers` の平文HTTP拒否（AwsSolutions-S10）、SNSトピックの平文Publish拒否（SNS3）。
- **読んで見つけて直した（ツールは指摘しない）**: 設定Lambdaが8テーブル全部に書けた。コードが書くのは devices / characters / voices だけなので、単価・為替・LLM一覧・会話ログ・使用量は読み取りだけに縮めた。「単価と為替はAPIから書けない」がIAMでも成り立つ。Soniox Lambdaは devices の UpdateItem だけ（Put/Deleteを外した）。
- **理由を書いて受け入れた**（`lib/toytalker-stack.ts` の `acknowledgeNagFindings`）: `AWSLambdaBasicExecutionRole`（IAM4）、grantRead/grantReadWriteが作るS3動詞のワイルドカードと対象1バケットの `/*`（IAM5）、Schedulerの `:*`（IAM5）、S3アクセスログ（S1）、DLQ・X-Ray・ログ無期限（Serverlessパック）。
- checkovの追加分: CMK暗号化（DynamoDB・ログ・CloudTrail・SNS）は本番で入れる決定どおり。LambdaのVPC配置は不要。**同時実行上限（CKV_AWS_115）は費用燃やしの天井として意味がある**（下の「決めること」）。Function URLの認証なし（CKV_AWS_258）は既知（3で）。

### 2. ベストプラクティス照合（Security Hub FSBP）

Security Hubは有効化せず（Configが前提で費用が出る。本番で）、同じ基準をCLIの読み取りとProwlerで当てた。

| 基準 | 結果 |
|---|---|
| IAM: ルートMFA、ルート鍵なし、長期鍵なし、IAMユーザー1人（鍵なし・パスキー2本） | 合格 |
| DynamoDB: PITR、削除保護、全8テーブル | 合格 |
| S3: バケット単位の公開ブロック・既定暗号化・バージョニング（3バケット） | 合格 |
| CloudTrail: 組織・全リージョン・ログ検証・配信中 | 合格 |
| Lambda: ランタイム nodejs24.x、更新モードAuto | 合格 |
| **v1残骸**: API Gateway `toytalk-chat-apigateway-dev`（ステージ `dev`）の `POST /chat` と `POST /raspi` が **認証なし** で Python Lambda `toytalk-openai-api-dev` / `toytalk-api-raspi` を呼ぶ。両方の環境変数に `OPENAI_API_SECRET_KEY`、ロール `toytalk-lambda-role-dev` は S3 / DynamoDB / Lambda の FullAccess + KMS PowerUser。30日間の呼び出しはゼロ | **不合格。今の構成で最大の穴**（鍵と全テーブルを握る無認証の入口が、使っていないのに開いている）。9で予定していた削除を前倒しし、**2026-10-26に削除済み** |
| S3.1 アカウント単位の公開ブロック | 未設定。ただし同じアカウントに公開バケット `zackey.xyz`（ToyTalker外）があり、入れるとそれが止まる。ToyTalkerの3バケットはバケット単位で塞いである |
| S3.5 平文HTTP拒否 | `toytalker-cloudtrail-org` のみ合格。`toytalker-tts-speakers` はCDKで直した（deploy待ち）。`toytalker-firmware` はCDK外（9で） |
| Account.1 セキュリティ連絡先 | 未登録 |
| IAM.7 パスワードポリシー | 未設定（ユーザーはパスキー運用の1人だけ） |
| Config.1 / GuardDuty.1 / Security Hub | 無効（費用。本番で） |
| CloudTrail.2 KMS暗号化、CloudTrail.5 CloudWatch Logs連携、CloudTrail.7 / S3.9 アクセスログ | 未（本番で） |
| Lambda.1 公開ポリシー（Function URL 7本） | 既知。CloudFront + WAF（3）と認証（4）で扱う。Access Analyzerの「公開」指摘もこの7本と `zackey.xyz`、Identity Centerのロール（正常） |
| 検知: CloudWatchアラームなし、同時実行は既定の1000を共有、予算 $5 / $10 のみ | 費用燃やし（問題3）の天井が無い |

Prowler（`prowler aws -f ap-northeast-1 us-east-1 --compliance aws_foundational_security_best_practices_aws`、読み取りのみ）の結果: 154基準中、合格のみ34、不合格あり39（残りは対象資源なし）。ToyTalker資源の不合格は上の表と同じ（Lambda.1、S3.5、S3.17、CloudTrail.2/5/7、SNS.1、DynamoDB.4=AWS Backupの計画なし。PITRで足りるので保留）。それ以外は **ToyTalker外の残骸**で、9の削除候補に足す: S3 `abc-test-342082316736` と `-modify-s3policy`（公開ブロックなし）、`toytalk.zakicorp.com`、`aws-athena-query-results-*`、ECSタスク定義 `a`、ECRリポジトリ `test`、SNS `test` / `ABC-topic-yamazaki`、Lambda `lambda-mail`（python3.8）/ `test`（python3.8）/ `ABC-modify-s3-policy-lambda`、API Gateway `api-mail`、KMS CMK 2本（v1の `toytalk-kms-dev` / `-prod`。2026-10-27 に削除予約、2026-11-26 に消える。旧デモサイトのバケットは標準暗号化へ戻した）、CloudFront 1本（`zackey.xyz` 向けと思われる。ログ・WAFなし）。IAM.1（`AdministratorAccess`）はIdentity Centerの権限セットで想定どおり。

### 3. 依存の脆弱性を継続的に見る仕組み

**要る。** 理由: Lambdaは `npm ci` した依存をesbuildでバンドルして配るので、依存の修正版が出ても誰かが気づいて deploy しない限り本番に入らない。今回の `undici` / `fast-xml-parser` は報道で気づいた。

- リポジトリは **公開**（`github.com/tomonoriyamazaki/toytalker`）なので Dependabot は無料。現状は secret scanning と push protection が有効、**Dependabot alerts / security updates は無効**。
- `.github/dependabot.yml` を追加した。対象は `infra/`、lockfileのあるLambda 5本、`app/`。週1回、**セキュリティ修正だけ**を1本のPRにまとめる（版上げPRは作らない）。
- 残りはリポジトリ設定（Settings → Code security → Dependabot alerts と security updates をON）。ユーザーの操作。
- 補足: 2026-10-25時点で Lambda 5本の `npm audit --omit=dev` は0件。`infra/` の `brace-expansion`（high、aws-cdk-lib配下）は `npm audit fix` で解消。Lambdaランタイムは管理ランタイムで自動更新。アプリ（React Native）の依存もDependabotの対象に入れたが、修正の反映は審査・配布の都合で別途。

### 決めること

- **同時実行上限**（2026-10-27 却下。CloudFront + WAF で天井を作る。[先送り項目](deferred-items.md)）: 会話Lambda 2本・相槌2本・読み上げ・Soniox鍵発行に `reservedConcurrentExecutions` を置くと、費用燃やしの天井ができる（例: 会話20、相槌20、他10）。超えた分は429になるので、実利用の同時数（いまは1人）に余裕を見て決める。Invocations / Duration のアラーム（SNSでメール）も同時に。
- **ログ保持期間**（2026-10-27 決定: 無期限のまま。会話の文章をログに書かない方針に変える（ロードマップ9）ので溜めるリスクが無く、費用調査に使える）: Lambdaログは無期限。会話の文字起こしが含まれるので、期限（例: 13か月。月次レポートは当月分しか読まない）を決めて `retention` を変える。
- **アカウント単位の公開ブロック**（2026-10-27 決定: 保留。`zackey.xyz` はサイトとして運営中で残す）: `zackey.xyz` をこのアカウントから出すか、公開のまま残すか。

### 観察（原因未確定）

2026-10-26/27 も同じ事象。`export-credentials` の回避策で毎回通った。リモートからのログインは `aws sso login --use-device-code --no-browser` でコードを出し、手元の端末で承認する（通常方式はこのPCのブラウザに戻るので完了できない。コードは10分で失効）。

CDKの `synth` / `diff` が `CredentialsProviderError: UnauthorizedException: Session token not found or invalid` で止まった（AWS CLI 2.33.2 の `aws sso login` 直後、CLIの `sts get-caller-identity` は通る状態）。JS SDK（3.1132）が `~/.aws/sso/cache` のトークンを使うときだけ失敗する。回避は `eval "$(aws configure export-credentials --format env)"` を打ってから `cdk` を実行する（CLIが持つロール資格情報を環境変数に出す。8時間）。原因は追っていない（推測: CLI 2.33の `session.db` 方式とJSONキャッシュの食い違い）。
