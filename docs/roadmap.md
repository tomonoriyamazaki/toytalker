# ロードマップ: 残りの作業と順番

「残っていること全部」の入口。順番と、誰の手が要るかだけを持つ。各項目の中身・経緯・手順は右端の文書へ。終わった行は消さず「済（日付）」にし、全部済んだらこの文書を消す。着手しないと決めた項目はここに書かず [先送り項目](deferred-items.md) へ。

## 方針（2026-10-07合意）

- 書いてあることを順に全部終わらせる。優先度の議論はしない。
- Claudeだけで進められる部分は、ユーザーの手待ち（アカウント作成・実機確認など）の間に先へ進める。各セッションの冒頭で「このセッションでユーザーにやってもらうこと」を先に列挙する。
- 本番影響の操作は説明→OKの原則どおり。同種の操作をまとめて1回のOKで進めてよいかは、その場で聞く。

## 順番

| 順 | 項目 | Claudeだけで | ユーザーが要る | 状態 | 詳細 |
|---|---|---|---|---|---|
| 1 | 命名の決定 | 案を出す | 最終OK | 済（2026-10-12、下記） | [命名規則](naming-conventions.md)、新旧対応は [複数アカウント計画](multi-account-iac-plan.md) の「命名」 |
| 2 | テーブル名の環境変数化とタグ（RnDへdeploy） → STGアカウント作成 → `cdk bootstrap` → SSM投入 → STGを新名で合成 | 環境変数化・タグ・bootstrap以降 | Organizationsでアカウント作成、SSM投入のOK | 済（2026-10-16。下記） | [CDK引き継ぎ](handoff-cdk-infra-2026-09.md)、[infra/README](../infra/README.md) |
| 3 | CloudFront固定ドメイン（`api-stg.zakicorp.com` 等）→ STGへ初回 `cdk deploy` → マスターデータ投入 → アプリ・ESP32の接続先切替 → 実機確認 | CDK・アプリ・ファーム・deploy | Cloudflare DNS追加、実機確認 | 未着手。**DG向け展開の構成が決まるまで着手しない**（2026-10-25。下記） | [複数アカウント計画](multi-account-iac-plan.md) |
| 4 | 認証（Cognito + Google / Sign in with Apple）→ 前払いポイント制 | CDK・Lambda・アプリ | Google Cloud / Apple Developer側の設定、実機確認 | 設計メモあり、未着手 | [先送り項目](deferred-items.md) の「ユーザー認証」、[原価と課金](pricing-and-cost-model.md) 第11節 |
| 5 | Cartesia 429時のずんだもんフォールバック、ZakiCorp TTS待ち行列の可視化 | 全部 | 実機確認 | 仕様あり、未着手 | [TTSフォールバック](tts-fallback-and-notifications.md)、[先送り項目](deferred-items.md) の「待ち行列の可視化」 |
| 6 | ESP32: 検索後の誤停止対策、OTA検証3件（電源断・SHA改ざん・ロールバック）、`stable` 発行、配布機のUSB書き込み、アプリの版表示と `fw_channel` 切替 | コード | 実機・S3操作・USB書き込み | 誤停止は原因仮説のみ・対策未合意 | [OTA引き継ぎ](handoff-esp32-ota-2026-09-16.md) |
| 7 | RnDの改名 → 自分用本番（CMK込み）→ DG向け本番 | 大半 | アカウント作成×2、実機確認 | 未着手。3の後。GitHub Actions + OIDCは外した（[先送り項目](deferred-items.md)、2026-10-25） | [CDK引き継ぎ](handoff-cdk-infra-2026-09.md) |
| 8 | セキュリティ強化: PITR・依存更新・CloudTrail組織トレイル・CLIのSSO化と長期鍵の削除。所有者確認は4、レート制限は3で | コード | SSOのパスワード設定、deployと削除のOK | コードは済（2026-10-25）。deploy・SSO切替・鍵削除が未 | [セキュリティ見直し](security-review-2026-10-25.md) |
| 9 | 小物: v1残骸の削除（旧ロール・旧Lambda 2本・API Gateway・孤立ロググループ）、`toytalker-firmware` の扱い（ファームは環境に属さず全機共通なので、環境ごとのスタックへ取り込むのは合わない。どのアカウントに置き、どう管理するかを別途決める。2026-10-25）、Soniox Lambda 128→256MB、`.local/tts-service/` へ supervisor.py 反映 | 全部 | 削除のOK | 未着手 | [CDK引き継ぎ](handoff-cdk-infra-2026-09.md) の「判断待ち」 |

並べた理由: 1は2以降の名前の前提。8（セキュリティ）は4の前に済ませる。4〜6は2〜3と独立なので、ユーザーの手待ちの間にClaudeが進められる。7は本番なので最後。**3はDG向け展開の構成が決まってから**（下記）なので、当面は4〜6をRnDで進める。

## STGへのdeployを3へ移した理由（2026-10-25）

- STGは「DG向け本番へ出す前の準備環境」で、いま出しても使えない。アプリ・ESP32の接続先はFunction URLのハードコードで、固定ドメイン（3）が無いとSTGへ向けられない。
- これからRnDで認証（4）を実装するとスタックが大きく変わり、いま「ゼロから作れる」ことを確認しても認証後にやり直しになる。使わない環境をRnDに追従させる手間だけ増える。
- 着手の条件は、DG向け展開の構成（何を、どの形で出すか）が決まること。それまでは4〜6をRnDで進める。アカウント・bootstrap・SSM・新名合成は済んでいるので、着手時は3の中で `cdk deploy --context stage=stg` → `export-master-data.ts rnd` / `import-master-data.ts stg --from=rnd --yes` から始める。

## 1の決定（2026-10-12）

- 形は `toytalker-<機能>-<環境>`（例 `toytalker-chat-app-stg`、`toytalker-devices-stg`）。計画メモの案から環境名を最後に変え、種類の接尾辞は付けず、タグ `project` / `environment` を全資源に付ける。規則は [命名規則](naming-conventions.md)、新旧対応表と適用の順番は [複数アカウント計画](multi-account-iac-plan.md) の「命名」節。
- **DynamoDBのキー名（`owner_id#device_id` 等）は変えない。** 変えるとデータ移行とコード全面修正が入り、環境名を付ける目的とは無関係。
- 未ログイン端末の扱い（4で必要: ログイン必須かゲスト継続か）は4の着手時に決める。
- 「Lambdaコードがテーブル名を環境変数から組み立てる」直しとタグは2026-10-13にRnDへ入れた（RnDの名前は変えていない）。STGは最初から新名で作る。RnDの改名は7。

## 済

- STGの準備（2026-10-16）。アカウント 131746731200、`cdk bootstrap`、SSM鍵11件、`legacyNames` による新名合成。deployと投入は3へ。

- テーブル名の環境変数化とタグ（2026-10-13）。RnDの名前は変えず、CDKが配る `TABLE_SUFFIX` から `backend/shared/tables.mjs` が組む。`stages.ts` の `prod` / `prod-dg` も `prd` / `prd-dg` へ。[infra/README](../infra/README.md) の「名前とタグ」
- 命名の決定（2026-10-12）。`toytalker-<機能>-<環境>`。[命名規則](naming-conventions.md)
- 秘密の実行時取得（2026-10-06）。Lambda 8本がSSMから鍵を読む。[CDK引き継ぎ](handoff-cdk-infra-2026-09.md)
