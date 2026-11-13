# ToyTalker infra（AWS CDK / TypeScript）

ToyTalkerのAWS資源（Lambda 8本・Function URL 7本・DynamoDB 8テーブル・S3・SNS・温めルール・月次Scheduler・CloudFront 固定ドメイン）を1スタック `toytalker-<stage>`（RnDは改名まで旧名 `ToyTalker-rnd`。`config/stages.ts` の `legacyNames` と `stackName()`）で管理する。CloudFront が us-east-1 に要求する ACM 証明書と WAF は `<スタック名>-edge`（`lib/toytalker-edge-stack.ts`）に置き、本体が参照する。この文書は手順だけを持つ。いまの状態と残作業は [docs/roadmap.md](../docs/roadmap.md)、決定と根拠は [docs/multi-account-iac-plan.md](../docs/multi-account-iac-plan.md)。

## 構成

| ファイル | 役割 |
|---|---|
| `bin/toytalker.ts` | 入口。`--context stage=<rnd\|stg\|prd\|prd-dg>` で環境を選び、資格情報のアカウントが一致するか確認し、SSMに秘密が登録済みか確かめてスタックを作る |
| `config/stages.ts` | 環境ごとの秘密でない設定（アカウントID・リージョン・通知先・ZakiCorp URL・テーブル名の末尾・S3バケット名・アーキテクチャ） |
| `lib/secrets.ts` | SSM Parameter Store（SecureString）の名前一覧と読み出し。名前は全環境共通 `/toytalker/<key>` |
| `lib/toytalker-stack.ts` | 資源定義。Lambdaは `backend/<dir>/index.mjs` をesbuildでまとめる（旧deploy.shと同じ指定。deploy.shは2026-09-16に削除）。CloudFront は `createApiDistribution` |
| `lib/toytalker-edge-stack.ts` | us-east-1 のスタック `<スタック名>-edge`: ACM 証明書（DNS 検証）と WAF（レート制限）。本体が crossRegionReferences で参照する |
| `scripts/` | 初回移行用（下記） |

## 使い方

```bash
cd infra
npm ci
bash scripts/install-lambda-deps.sh     # 各Lambdaディレクトリのnpm依存（初回・clone直後）
npx cdk synth  --context stage=rnd      # テンプレート生成（cdk.out/）
npx cdk synth  --context stage=rnd --context nag=true   # cdk-nag の静的点検。指摘があると止まる（deploy前に通す）
npx cdk diff   --context stage=rnd      # 本番との差分。Replace が1つも無いことを確認してから deploy
npx cdk deploy --context stage=rnd --all   # スタックは edge（us-east-1）・本体・org の3つ。本体は edge に依存するので順番は CDK が決める
```

cdk-nag で受け入れる指摘は `lib/toytalker-stack.ts` の `acknowledgeNagFindings` に理由付きで書く（根拠は [docs/security-review-2026-10-25.md](../docs/security-review-2026-10-25.md)）。

資格情報はIdentity Center（SSO）。`aws sso login` 後にそのまま動く（`[default]` がRnDのSSOプロファイル。期限8時間）。別アカウントへ出すときは `AWS_PROFILE=<profile>` か `--profile <profile>` を付ける。設定のアカウントIDと資格情報が違えば起動時に止まる。

## 落とし穴

- **`cdk synth`/`diff`/`deploy` にはAWS資格情報が要る**（SSMの登録の有無を確かめるため。値は読まない）。起動時にアカウントIDが `stages.ts` と一致しないと止まる。**`cdk bootstrap` も `infra/` で実行するとアプリを読み込んで同じ検査で止まる**（新しいアカウントにはまだ鍵が無い）。bootstrapは cdk.json の無いディレクトリから実行する（下の「新しい環境の立ち上げ」。2026-10-15、STGで判明）。
- **`NodejsFunction` は使っていない。** `npx esbuild` をリポジトリ直下で起動してインストール確認待ちで止まるため、esbuildのAPIを直接呼ぶ `bundleLambda` を使っている。
- 各Lambdaディレクトリの `node_modules` が無いとバンドルできない。clone直後は `bash scripts/install-lambda-deps.sh`。**deploy前にも毎回実行する。** `node_modules` は git 管理外なので、別の作業ツリーで `package-lock.json` を更新して deploy したあと、main の古い `node_modules` から deploy すると依存が lock より前の版に戻る（2026-10-28、ESP32用Lambda 2本の undici が 8.12.3→8.7.0 に戻った。`cdk diff` には S3Key の変化としてしか出ない）。
- 名前を固定した資源（Lambda・テーブル・S3）の名前や部品IDを変えると作り直しになる。`cdk diff` の requires replacement を必ず見る。Lambdaの作り直しはFunction URLのホスト名が変わり、アプリとESP32が壊れる。
- 新しいCloudFormation資源を既存スタックに `cdk import` するときは、import操作にそれ以外の変更を含められない（`--context importPhase=true` の仕組みは下の「importで引き取る手順」）。
- CDKが環境変数を上書きするので、手作業でLambdaの環境変数を変えても次のdeployで戻る。
- `cdk synth` が `CredentialsProviderError: UnauthorizedException: Session token not found or invalid` で止まり、`aws sts get-caller-identity` は通るとき（2026-10-25、CLI 2.33.2）: `eval "$(aws configure export-credentials --format env)"` でCLIの資格情報を環境変数に出してから実行する。原因未確定（[セキュリティ見直し](../docs/security-review-2026-10-25.md) の「観察」）。

- リモート（別端末）から SSO ログインするとき: `aws sso login --sso-session toytalker --use-device-code --no-browser` でURLとコードを出し、手元の端末で開いて承認する。通常方式はこのPCのブラウザへ戻る仕組みなので完了できない。コードは10分で失効。SSOセッションは8時間で切れる。

## 子アカウントでルートが要る操作

子アカウントのルート資格情報は無い（ルートアクセスの集中管理）。ルートでしかできない操作（S3バケットポリシー削除など）は管理アカウントから行う:

```bash
aws sts assume-root --target-principal <アカウントID> --task-policy-arn arn=arn:aws:iam::aws:policy/root-task/<S3UnlockBucketPolicy|SQSUnlockQueuePolicy|IAMDeleteRootUserCredentials|IAMCreateRootUserPassword>
```

管理アカウント自身のルート（gmail、MFAあり）は対象外。

## 名前とタグ

- 規則は [docs/naming-conventions.md](../docs/naming-conventions.md)（`toytalker-<機能>-<環境>`）。RnDの既存資源は改名まで旧名のまま。
- DynamoDBのテーブル名はコードに書かない。`config/stages.ts` の `tableSuffix`（RnDは空、STG以降は `-stg` 等）をCDKが環境変数 `TABLE_SUFFIX` で全Lambdaへ渡し、`backend/shared/tables.mjs` の `tableName("devices")` が `toytalker-devices<suffix>` に組む。`lib/toytalker-stack.ts` のテーブルも同じ形で作る
- タグ `project=toytalker` と `environment=<stage>` を `Tags.of(stack)` で全資源に付ける（タグ非対応のFunction URL・Schedulerには付かない）

## 秘密（SSM）

- 必須: `lib/secrets.ts` の `REQUIRED_SECRETS`（OpenAI・Anthropic・Google・ElevenLabs・FishAudio・Sakura・Cartesia・ZakiCorp API/Edge・Brave・Soniox）
- 任意: OpenAI/Anthropicの管理キー（月次レポートが各社の請求を取るときだけ）
- 1件入れる: `printf '%s' "$VALUE" | npx tsx scripts/put-secret.ts <stage> OPENAI_API_KEY`
- Lambdaは実行時にSSMから読み、メモリに保持する（`backend/shared/secrets.mjs`）。環境変数には鍵を置かず、関数ごとの対象名だけを `SECRET_PARAMS` で渡す。どの関数がどの鍵を読めるかは `lib/toytalker-stack.ts` の `secrets`
- 鍵を入れ替えるときはSSMを変えるだけ。稼働中のLambdaは容器が入れ替わるとき（約2時間ごと）に読む。急ぐなら deploy か設定変更で容器を入れ替える
- 鍵を発行元で作り直す手順（値は書かない）は [docs/security-review-2026-10-25.md](../docs/security-review-2026-10-25.md) の「鍵の再発行手順」
- Lambdaに鍵を新しく使わせるとき: `lib/secrets.ts` に名前を足し、その関数の `secrets` に加え、コードでは `secret("名前")` で読む
- **例外は外部IdP（ロードマップ4）の秘密2件**（Google のクライアントシークレット、Apple の秘密鍵。`lib/secrets.ts` の `IDP_SECRETS`）。Cognito の IdP は deploy 時に値が要り、CloudFormation の `ssm-secure` が Cognito に対応していないので Secrets Manager（`toytalker/google-oauth-client-secret`、`toytalker/apple-signin-private-key`）に置き、`{{resolve:secretsmanager}}` で読む。登録手順は [docs/auth.md](../docs/auth.md)。`stages.ts` の `auth.google` / `auth.apple` が無い環境では参照しない
- 環境変数方式の環境を移すときだけ2段階でdeployする（コードと設定の更新が別々に行われ、その間に鍵が読めなくなるのを避ける）: `npx cdk deploy --context stage=<stage> --context keepEnvSecrets=true` → ログの `[secrets] loaded n/n from SSM` と動作を確認 → フラグ無しで `npx cdk deploy`。新しく作る環境は最初からフラグ無し

## Lambdaログの見方（2026-10-28、ロードマップ9）

会話経路のLambda（本文2本・相槌2本・Soniox鍵発行・読み上げ）は、1リクエストにつき1行のJSONを出す（`backend/shared/trace.mjs`）。**会話の文章（発話・返答・検索語・相槌）はログに無い。** 正本は `chat-logs` テーブル。新しいログを足すときも文章を入れない。月次Lambdaは `[Pricing] missing price for <key>` の文字列を拾うので、この警告の形だけは変えない。同じく `[wallet] consume error`（使った分を台帳に書けなかった。`backend/shared/wallet.mjs`）はアラームのメトリクスフィルタが拾うので、先頭の文言を変えない。見方と直し方は [原価と課金の考え方](../docs/pricing-and-cost-model.md) の 11.2。

| 項目 | 意味 |
|---|---|
| `kind` | `turn`（本文）/ `backchannel`（相槌）/ `stt-token`（Soniox鍵発行とOTA判定）/ `read-aloud`（読み上げ）/ `settings`（設定）/ `billing`（課金 API。`stripe_event` `stripe_type` と `reason`）/ `billing-worker`（課金の処理。`status` は recorded / duplicate / dropped / retry / ignored。スケジュールの回は `task`（auto-charge / expire）と件数の内訳） |
| `request_id` `session_id` `device_id` `owner_id` | 識別子。`request_id` はLambdaの requestId（`REPORT` 行と同じ値） |
| `source` `fw` `app_version` `ua` | 出どころ。`source` は `esp` / `app`。`fw` はESP32が本文に添えるファーム版（v0.7.3以降）、`app_version` はアプリ版（`app/lib/appVersion.ts`。次の配布以降）。古い版からの要求は null。**送信元IPは書かない**（個人に結びつく。2026-10-28決定。2026-11-09 に「CloudFront のアクセスログとしてだけ 180 日残す」方針に変えたが、Lambda ログに入れない点は変わらない。実装はロードマップ 29、設計は [docs/access-logs.md](../docs/access-logs.md)） |
| `edge` `country` | 経路（2026-10-29）。`cloudfront` = 固定ドメイン経由で、`country` に `CloudFront-Viewer-Country` の国コード（JP など）。`direct` = Function URL を直接呼ぶ旧ファーム・旧アプリで、`country` は null。`direct` が無くなったら Function URL を IAM 認証にする（下の「固定ドメイン」） |
| `llm` `tts` `voice` `character_id` `has_personality` | 使った設定 |
| `marks` | 段階の経過時刻（リクエスト開始からのms）。本文は `secrets`（SSM鍵）→ `config`（DynamoDB）→ `llm_start` → `llm_first_token` →（検索時 `tool_call` → `llm2_start` → `llm2_first_token`）→ `llm_done` → `done_sent` → `usage_saved` |
| `tool` `search_say` `search_forced` `preface_dropped` `nested_tool` | 検索したターンだけ（ロードマップ30）。`tool` は呼んだツール名、`search_say` は検索ツールの引数 `say`（検索の間の一言）を鳴らした。残りは保険が働いた印で、増えたら `say` 方式が外れている: `search_forced` = 「調べるね」と言っただけで終わったので検索を強制、`preface_dropped` = 検索後の返答の頭の「調べるね」を捨てた、`nested_tool` = 検索後にもう一度検索を求めた |
| `ext` | 外部サービス呼び出し。`service`（gemini / openai / anthropic / brave / soniox / cartesia …）、`status`、`ms`（応答ヘッダが返るまで）、`at`（開始時刻）。TTSは失敗したときだけ載る |
| `segments` | 本文のTTS 1文ごと。`text_at`（LLMから文が揃った時刻）、`tts_ms`、`first_chunk_ms`（ZakiCorpのストリーミングだけ）、`bytes`、`trim_ms`（無音を削った量）、`sent_at`（音声を書き終えた時刻）、`attempts`、`fallback`、`error` |
| `errors` | `where`、`status`、`message`（160字まで。外部サービスのエラー本文に入力文が混ざることがあるため短く切る） |
| `prev_turn` | 本文だけ（2026-11-08）。**前のターン**をクライアントが受け取って鳴らしたか。サーバーは「送り終えた」までしか分からないので、クライアントが次の要求に添える。`request_at`（前のターンの turn ログと結びつける）、`attempts` `segments` `tts` `played` `play_failed` `stalls`（回数。`stalls` は再生の見張りが動いた回数）、`done` `loaded` `bc_received` `bc_played` `bc_error`（真偽）、`error`（network / timeout / http:<status> / parse）。送らない版（アプリ 0.8.7 以前、ESP32 の今の版）は null。`segments` が 0 なら受信できていない（通信側）、受けたのに `played` が 0 や `stalls` > 0 なら鳴らす側（アプリ） |
| `device` | ESP32 の本文だけ（2026-11-08、ファーム 0.7.4 より後）。本体の状態: `vbat_mv`（電池電圧 mV、未校正）、`board_temp_c` / `chip_temp_c`（基板温度・ESP32 内蔵の温度 ℃、読めなければ null）、`chg_stat1` / `chg_stat2`（充電IC STAT ピンの値 1/0。意味は未確認）。0.7.7 から: 要求時の `rssi`・`heap_free`・`heap_min`・`max_blk`・`psram_free`（バイト）・`uptime_s`（小さければ再起動の直後）と、`device.prev`（**前のターン**。時刻はそのターンで本体が送信を決めた時からの ms、0 は起きなかった）: `stop`（`done` / `aec` / `button` / `stream_error` / `connect_failed` / `i2s_failed`）、`pre_ms` → `tls_ms` → `send_ms` → `headers_ms` → `first_audio_ms` → `play_start_ms` → `recv_end_ms` → `play_end_ms`、`barge_ms`（割り込みの判定）、`audio_ms`（受けた音声の長さ）、`unplayed_ms`（止めたとき鳴らしていなかった分）、`underruns`、`segments`、`bc`、`rssi_avg` / `rssi_min`、`ws_max_block_ms`、`aec_*`（声の割り込み判定の材料。AEC 後の AC RMS で `aec_threshold` と比べる。`aec_out_sustained` は4フレーム続けて超えた最大の値）。`device.stt`（この要求の発話の聞き取り。録音開始からの ms）: `ws_wait_ms`、`listen_ms`、`last_text_to_end_ms`（Soniox の話し終わり判定の待ち）、`end_to_send_ms`（猶予）、`resumes`、`speech_peak_rms` / `grace_peak_rms`、`disconnects` / `errors`（Soniox）、`why`。見方は [ESP32ファーム](../docs/esp32-firmware.md) の「本体側の計測」。送らない版は null。`filter device.vbat_mv < 3500` や `filter device.prev.stop = "aec"` のように引ける |
| `ota_offer` `ota_last` `ota_fails` `ota_bad` `ota_alert` | 鍵発行だけ。`ota_offer` は勧めた版。残りは ESP32（0.7.12 以降）が起動時に添える前回の OTA の結果（2026-11-12）: `ota_last` は `started`（途中で止まった＝電源断など）/ 失敗の段階（`sha256` `stall` `http_get` …）/ `rollback1`（入れた版が1回戻った。入れ直す。2026-11-13 以降の版）/ `rollback`（入れた版が落ちて戻り、以後試さない。2026-11-13 以降の版は2回目）、`ota_fails` は続けて失敗した回数、`ota_bad` はロールバックして以後試さない版。`ota_alert: true` は「いま勧めている版をロールバックした・SHA 不一致で拒んだ」＝発行の誤りの疑いで、警報 `toytalker-ota-broken-<環境>` が1件目でメールする（警報のメールは運用トピックのポリシーに `cloudwatch.amazonaws.com` の許可が要る。2026-11-13 まで無く、どの警報も届いていなかった。届かない時は `aws cloudwatch describe-alarm-history --history-item-type Action` に失敗が残る）（電源断・通信の失敗は鳴らさず、月次レポートの「ESP32 のファーム」に出る） |
| `total_ms` `container_age_s` | 合計と、容器が起きてからの秒数（小さければコールドスタート直後） |

Logs Insights の例。遅かったターンを探す:

```
fields @timestamp, session_id, device_id, fw, llm, tts, total_ms, marks.llm_first_token, marks.llm_done, segments_count
| filter kind = "turn" and total_ms > 8000
| sort @timestamp desc
```

音声が途切れた箇所の切り分け: `segments` の `sent_at` の間隔が空いた文を見つけ、その文の `sent_at - text_at` が大きければTTS側、前の文との `text_at` の差が大きければLLM側（`marks.tool_call` があれば検索待ち）、`ext` に 429 / 5xx があれば外部サービス側。相槌は `marks.llm_done` と `marks.tts_done` の差で見る。

## 固定ドメイン（CloudFront、ロードマップ3）

`config/stages.ts` の `apiDomain`（RnD は `api-rnd.zakicorp.com`）を CloudFront の別名にし、Function URL 7本を1つのドメインの経路に束ねる（`lib/toytalker-stack.ts` の `createApiDistribution`、各 Lambda の `url.route`）。目的は URL の固定（Function URL のホスト名はスタックを作り直すと変わる）、WAF のレート制限（費用燃やしの天井）、国コードのログ。キャッシュはしない。ストリーミング応答はそのまま通る。

| 経路 | Lambda |
|---|---|
| `/chat-app` `/chat-mcu` | 本文（App / ESP32） |
| `/backchannel-app` `/backchannel-mcu` | 相槌 |
| `/stt-token` | Soniox 一時キー発行（OTA 判定も） |
| `/read-aloud-app` | 読み上げ |
| それ以外（`/devices` `/characters` `/voices` `/llms` `/logs/*` `/usage*` `/custom-voices*`） | 設定Lambda（path を自分で振り分ける） |

- **クライアントの約束**: CloudFront → Lambda は OAC の SigV4 署名で渡り、署名が本文のハッシュを含む。GET / HEAD 以外は本文の SHA-256（本文が無ければ空文字列のハッシュ）を `x-amz-content-sha256` ヘッダーで添える。アプリは `app/lib/api.ts` の `apiFetch` / `bodyHashHeader`、ESP32 は `sha256Hex()`。無いと Function URL が IAM 認証のとき 403。
- **段階**: `directFunctionUrls: true`（RnD の今）は Function URL が `NONE` + 公開ポリシーのままで、CloudFront 経由と直接の両方を受ける。配布済みの旧ファーム・旧アプリが直接呼ぶ間はこのまま。Lambda ログの `edge: "direct"` が無くなったら `false` にして deploy すると `AWS_IAM` になり、CloudFront（OAC）だけが呼べる。authType の変更は作り直しにならず、ホスト名も変わらない。新しい環境は最初から `false`。
- **オリジンへ渡すヘッダーは allowList**（`content-type` `accept` `user-agent` `origin` `access-control-request-*` `cloudfront-viewer-country` `x-toytalker-token`。`x-amz-content-sha256` は OAC が扱うので書けない）。Host を渡すと Function URL が受け付けない。`Authorization` は OAC が上書きするので、認証（ロードマップ4）のトークンは `x-toytalker-token`（[docs/auth.md](../docs/auth.md)）。
- **WAF は本番だけ**（`apiRateLimitPer5Min` のある環境。RnD は省略、理由は [docs/deferred-items.md](../docs/deferred-items.md)）: 送信元 IP ごとに 5分で 300 件を超えると 403。サンプル要求の保存とログは切る（IP を残さない）。件数は us-east-1 の CloudWatch `AWS/WAFV2` の `BlockedRequests`。費用は WebACL $5 + ルール $1 + 100万要求あたり $0.60（月約 $6）。CloudFront と ACM は無料枠内。
- **応答待ちは 60 秒**（最初の1バイトまで、および途中のパケット間隔）。LLM の初回トークンがそれより遅いと 504。
- **アクセスログは今は取っていない**（送信元 IP が入る。cdk-nag の CFR3 を理由付きで受け入れ）。**2026-11-09 に「標準ログ v2 で項目を絞り、専用バケットに 180 日残す」方針に変えた**（ロードマップ 29。設計は [docs/access-logs.md](../docs/access-logs.md)）。実装したらこの行と CFR3 の受け入れ文言を直す。地域制限は掛けない（海外の利用者。CFR1）。

初回の出し方（RnD は 2026-10-29 に実施済み。次の環境でも同じ）:

1. us-east-1 を bootstrap する（cdk.json の無いディレクトリから。「新しい環境の立ち上げ」の 3 と同じ理由）: `npx cdk bootstrap aws://342082316736/us-east-1`
2. `npx cdk deploy --context stage=rnd ToyTalker-rnd-edge`。ACM 証明書の検証で止まるので、`aws acm describe-certificate --region us-east-1 --certificate-arn <arn>` の `ResourceRecord`（CNAME の名前と値）を Cloudflare の `zakicorp.com` ゾーンに **DNS only** で足す。数分で検証が通り deploy が終わる
3. `npx cdk deploy --context stage=rnd ToyTalker-rnd`。出力 `ApiDistributionDomainName`（`d….cloudfront.net`）を、Cloudflare に `CNAME api-rnd → その値`（**DNS only**。Proxied にすると Cloudflare の証明書になり、ESP32 の CA 束と合わない）で足す
4. `curl -s https://api-rnd.zakicorp.com/voices | head -c 200`（設定Lambda）と `curl -s "https://api-rnd.zakicorp.com/stt-token?ttl=60"`（鍵発行）で通ることを確かめる。本文のある POST は `x-amz-content-sha256` 付きで
5. アプリ（EAS ビルド）と試験機（ファーム 0.7.4 を beta に発行して OTA）を切り替え、実機で会話・相槌・読み上げ・設定画面を確かめる。Lambda ログに `edge: "cloudfront"` と `country` が出る

## 別リージョンの Lambda と振り分け（海外対応、ロードマップ36）

海外の利用者に近いリージョンにも会話用の Lambda を置き、CloudFront で行き先を振り分ける仕組み（2026-11-13、RnD のオレゴン us-west-2）。設定は `config/stages.ts` の `satellites`、スタックは `lib/toytalker-satellite-stack.ts`（`ToyTalker-rnd-usw2`）、振り分けは `lib/toytalker-stack.ts` の `createApiDistribution` と `routeFunctionCode`。

- **置いているもの**: ESP32 本文の Lambda 1本（`toytalker-chat-mcu-rnd`、us-west-2）と Function URL、ロググループ。相槌・鍵発行・アプリ用は東京だけ。
- **データは東京のまま**: 環境変数 `DATA_REGION` を渡すと、`backend/shared/region.mjs` が DynamoDB と SSM のクライアントを東京へ向ける。権限も東京のテーブル・パラメータの ARN。テーブルの読み込みは容器の初回だけ遅い（実測 0.4〜0.9 秒、以後はキャッシュで数 ms）。
- **入口（固定ドメイン `api-rnd.zakicorp.com`）**:

| 要求 | 行き先 |
|---|---|
| `/chat-mcu-usw2` | 必ずオレゴン |
| `/chat-mcu` + ヘッダー `x-toytalker-region: usw2` | オレゴン |
| `/chat-mcu` + ヘッダー `x-toytalker-region: <それ以外>` | 東京（国を見ない。現地から東京と比べるとき） |
| `/chat-mcu`（ヘッダーなし） | `satellites` の `countries` にある国ならオレゴン、それ以外は東京。**今は `countries` が空なので全部東京** |

- **振り分けは CloudFront Functions**（`toytalker-api-route-chat-mcu-rnd`、viewer request）。例外が出ても要求は通す。別リージョンへ送ったときだけ us-east-1 の `/aws/cloudfront/function/toytalker-api-route-chat-mcu-rnd` に `route chat-mcu-usw2 country=JP by=header` の1行を書く（国コードだけ）。要求の本文は読めないので、機器ごとの振り分けはできない。
- **どちらが処理したかの見分け方**: ロググループがリージョンごとに別（東京 `/aws/lambda/toytalk-api-stream-for-esp32-lambda`、オレゴン `/aws/lambda/toytalker-chat-mcu-rnd`）。項目は同じ（上の「Lambdaログの見方」）。
- **確かめ方**（本文のある要求は SHA-256 を添える。上の「固定ドメイン」）:

```
B='{"messages":[{"role":"user","content":"すきなどうぶつをおしえて"}]}'; H=$(printf '%s' "$B" | sha256sum | cut -d' ' -f1)
curl -s -o /dev/null -w "%{http_code} first_byte=%{time_starttransfer}s total=%{time_total}s\n" -X POST \
  -H "content-type: application/json" -H "x-amz-content-sha256: $H" -H "x-toytalker-region: usw2" -d "$B" https://api-rnd.zakicorp.com/chat-mcu
```

- **ESP32 本文の Lambda を直したら両方へ出す**: オレゴンの Lambda は東京と同じコード（`backend/toytalk-api-stream-for-esp32-lambda` と `backend/shared`）から作る。`cdk deploy --context stage=rnd ToyTalker-rnd ToyTalker-rnd-usw2` のように両方を指定する（`ToyTalker-rnd` だけだとオレゴンが古い版のまま残る）。揃っているかは `cdk diff` に同じ2つを渡して見る。
- **国での振り分けを始めるとき**: `countries` に国コード（`["US"]` など）を書いて `cdk deploy --context stage=rnd ToyTalker-rnd ToyTalker-rnd-usw2`。オレゴンに温めルール（5分ごと）も一緒にできる。
- **リージョンを足す・やめる順番**は `config/stages.ts` の `SatelliteConfig` のコメント。初回はそのリージョンの `cdk bootstrap` が要る（us-west-2 は 2026-11-13 済）。
- **分かっていること（2026-11-13、日本の PC から各2〜4回）**: LLM（Gemini）と TTS（OpenAI）の待ちは東京とオレゴンでほぼ同じ。差は距離の分で、最初の1バイトまで東京 0.10〜0.13 秒・オレゴン 0.2〜0.5 秒（CloudFront 経由、温まった状態）。声が日本にあるもの（ZakiCorp・ずんだもん）をオレゴンから呼んだときの差は未計測。
- **残り**: 本番で使うなら DynamoDB の複製（グローバルテーブル。残高のテーブルは書く場所を1つに決める）、相槌・鍵発行も置くか、の検討。

## 利用者認証（Cognito、ロードマップ4）

状態・仕組み・各社側の設定・確認の仕方は [docs/auth.md](../docs/auth.md)。CDK は `lib/toytalker-stack.ts` の `createAuth`（ユーザープール `toytalker-auth-<環境>`、managed login、アプリ用クライアント、外部IdP）と `createApiAlarms`（401/403・呼び出し数・エラー数のアラームと、使った分を台帳に書けなかったときのアラーム `wallet-consume-failed` → 月次レポートと同じ SNS）。環境ごとの設定は `config/stages.ts` の `auth`。deploy の出力 `UserPoolId` / `UserPoolClientId` / `AuthDomain` をアプリ（`app/lib/auth.ts`）と各社側の設定に使う。

## バックアップと復元（AWS Backup、ロードマップ10）

`config/stages.ts` の `backup: { retentionDays }` がある環境に、保管庫 `toytalker-backup-<環境>`（Vault Lock コンプライアンスモード。確定後は誰にも消せない）と日次計画・ロールを作る（`lib/toytalker-stack.ts` の `createImmutableBackup`）。初回 deploy から3日が猶予で、その間にバックアップの成功と復元を確かめる。異常（ジョブの失敗、計画の削除・変更、30時間完了ジョブが無い）は月次レポートと同じ SNS トピックへメールが来る（`createBackupAlerts`、ロードマップ12）。復元の手順と鍵の再発行手順は [docs/security-review-2026-10-25.md](../docs/security-review-2026-10-25.md) の「消されても戻せる仕組み」。

```bash
aws backup list-backup-jobs --by-backup-vault-name toytalker-backup-rnd --query "BackupJobs[].[CreationDate,ResourceType,ResourceName,State]" --output table
aws backup describe-backup-vault --backup-vault-name toytalker-backup-rnd   # Locked / LockDate / NumberOfRecoveryPoints
```

## サポートの返信の送信元（SES、ロードマップ 7(d)、2026-11-08）

`support@zakicorp.com`（会社の窓口。Google Cloud の同意画面もこれ）と `toytalker-support@zakicorp.com`（ToyTalker の窓口。プライバシーポリシー・特商法・購入ページ・アプリに出す）宛のメールは Cloudflare Email Routing で同じ Gmail へ転送し、Gmail のフィルタが宛先でラベルを分ける。返信は Gmail の「別のアドレスから送信」が SES の SMTP で、受信したアドレスから送る。手元にメールボックスは持たない。製品が増えたら `<製品>-support@` を Cloudflare のルール・`stages.ts` の `supportMail.addresses`・Gmail の送信元に1つずつ足す（Google アカウントは support@ の1つで足りる）。設定は `stages.ts` の `supportMail`（無い環境は作らない）。

1. deploy すると SES のドメイン識別子と IAM ユーザー `toytalker-ses-smtp-<stage>` ができ、出力 `SupportMailDns*` に DNS へ入れる記録（DKIM の CNAME 3本、MAIL FROM の MX と TXT）が出る。Cloudflare の DNS に入れる（CNAME はプロキシ無し「DNS のみ」）。`aws sesv2 get-email-identity --email-identity zakicorp.com` の `DkimAttributes.Status` が `SUCCESS` になれば検証済み（数分〜）。
2. 送れる相手の制限（sandbox）の解除を申請する: `aws sesv2 put-account-details --production-access-enabled --mail-type TRANSACTIONAL --website-url https://toytalker.zakicorp.com/ --use-case-description "..."`（用途: 問い合わせへの手動の返信だけ。1日数通）。承認まで1日ほど。承認前は検証済みの宛先にしか送れない。
3. SMTP の資格情報を作る（長期鍵の唯一の例外。権限は `addresses` からの `ses:SendRawEmail` だけ。SMTP のユーザー名とパスワードは全アドレスで共通）。シークレットは画面に出さずパイプで変換する:
   ```sh
   aws iam create-access-key --user-name toytalker-ses-smtp-rnd --query "AccessKey.[AccessKeyId,SecretAccessKey]" --output text > "$TMP/ses-key.txt"   # 1行目=ID 2行目=secret（一時ファイル。使ったら消す）
   cut -f2 "$TMP/ses-key.txt" | npx tsx scripts/ses-smtp-password.ts ap-northeast-1
   ```
   ユーザー名 = アクセスキー ID、パスワード = 出力の1行。パスワードマネージャーに入れ、一時ファイルは消す。
4. Gmail: 設定 → アカウントとインポート → 「他のメールアドレスを追加」をアドレスごとに（名前「ToyTalker サポート」で `toytalker-support@zakicorp.com`、名前「ZakiCorp」で `support@zakicorp.com`）、「エイリアスとして扱う」はオン → SMTP サーバー `email-smtp.ap-northeast-1.amazonaws.com`、ポート 587、上のユーザー名とパスワード、「TLS を使用したセキュリティで保護された接続」→ Gmail が確認コードを support@ へ送るので、転送で届いたメールのコードを入れる。「受信したアドレスで返信する」をオンにする。
5. 自分宛に1通送り、送信元が support@ で「経由」の表示が無く、ヘッダーの DKIM が `zakicorp.com` で pass になっていることを見る。

鍵が漏れたら `aws iam delete-access-key` で即無効。作り直しは 3 から（SMTP パスワードはシークレットから一方向に作るので、無くしたら鍵ごと作り直す。Gmail 側のユーザー名も変わる）。IAM の資源は `identity/*`（sandbox の間は受信者の検証済み識別子も許可に要る。2026-11-08 に拒否で確認）。送信元は `ses:FromAddress` の条件で `addresses` に限る。2026-11-08 に RnD で 1〜5 を実施し、試験送信で SPF・DKIM の PASS と「経由」無しを確認済み。本番アクセスは申請中。

## 新しい環境の立ち上げ（STGで2026-10-15に実施）

1. 管理アカウントで `aws organizations create-account --account-name toytalker-<環境> --email exodjp+toytalker-<環境>@gmail.com`。ルート資格情報なしで作られる（ルートアクセスの集中管理が有効）。IDを `config/stages.ts` の `account` に書く
2. Identity Center でグループ `admins` に `AdministratorAccess` を割り当てる（`aws sso-admin create-account-assignment`）
3. **bootstrapは cdk.json の無いディレクトリから実行する。** `infra/` で実行するとアプリを読み込み、SSMに鍵が無いので止まる。資格情報は管理アカウントから `aws sts assume-role --role-arn arn:aws:iam::<id>:role/OrganizationAccountAccessRole ...` で取るか、SSOプロファイルを使う
   ```bash
   cd "$TMPDIR" && /path/to/toytalker/infra/node_modules/.bin/cdk bootstrap aws://<id>/ap-northeast-1
   ```
4. SSMへ鍵11件を投入（`npx tsx scripts/put-secret.ts`、値はユーザー）
5. `npx cdk diff --context stage=<環境>` → `npx cdk deploy --context stage=<環境>`
6. マスターデータ: `npx tsx scripts/export-master-data.ts rnd` → `npx tsx scripts/import-master-data.ts <環境> --from=rnd --yes`

## RnDの既存資源をimportで引き取る手順

CloudFormationはimport操作中に新しい資源を作れないので、2段階で行う。

```bash
# 0. 事前準備（各1回）
npx cdk bootstrap aws://342082316736/ap-northeast-1
npx tsx scripts/migrate-secrets-from-lambda.ts rnd   # 2026-10-06に削除済み（Lambda環境変数からSSMへ写すスクリプト。移行は完了）

# 1. import段階: ロール・ポリシー・Lambda Permissionを含まないテンプレートで既存資源を引き取る
npx cdk synth --context stage=rnd --context importPhase=true
npx tsx scripts/make-import-mapping.ts rnd            # import/rnd.generated.json（論理ID→既存資源）
npx cdk import --context stage=rnd --context importPhase=true --resource-mapping import/rnd.generated.json ToyTalker-rnd

# 2. 通常デプロイ: CDK管理の最小権限ロールへ差し替え、Permission・ポリシーを追加、Node 24へ統一
npx cdk diff   --context stage=rnd                     # Replace が無いことを確認
npx cdk deploy --context stage=rnd
```

2段階目のあと、既存のロール `toytalk-lambda-role-dev` と旧Sid（`FunctionURLAllowPublicAccess` 等）は使われなくなるが残る。動作確認後に手で消す。

## マスターデータ

```bash
npx tsx scripts/export-master-data.ts rnd                 # master-data/rnd/*.json（Git対象外）
npx tsx scripts/import-master-data.ts stg --from=rnd --yes
```
