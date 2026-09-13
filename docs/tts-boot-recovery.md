# ログオン不要のTTS起動・復旧

## 目的と構成

PC再起動後、人がログオンする前にクローン音声を復旧させる。Windows更新の設定はこの作業では変更しない。

管理対象は既存の `C:\Users\exodj\projects\tts-models\faster-qwen3-tts\api_server.py` とngrok。アプリのリトライ修正とは独立している。

- 実装: `tools/tts-service/supervisor.py`
- 登録: `tools/tts-service/install.ps1`（管理者PowerShell）
- 配置先: `.local/tts-service/`（Git対象外）。登録時にスクリプトのコピーを配置するため、ブランチ切替だけで実行中のサービスは変わらない。改修適用は保守時間にタスクを停止してから再登録する。稼働中の上書き登録はインストーラーが拒否する。
- 実行アカウント: 既存TTSタスクのユーザー、S4U・通常権限。パスワード保存なしの非対話実行。Windows認証を必要とするネットワーク共有やEFSには依存させない。CUDAと実際のHTTPS/API接続は事前プローブで検証する。
- 起動: OS起動30秒後、実行時間の上限なし。監視スクリプト自体が異常終了した場合は1分後に再試行（タスク設定の上限999回）。

監視は15秒間隔。既存のAPI/ngrokプロセスを引き継ぎ、二重起動を避ける。APIは実行ファイル・引数・作業ディレクトリを照合する。プロセス終了後は30秒待って再起動する。自分が起動したプロセスについて、ヘルスチェックが10分間連続で失敗した場合にも再起動する。引き継いだ既存プロセスはヘルス失敗だけでは停止しない。

`/health`は現行APIの起動処理（モデルロード・ウォームアップ）後に応答する。公開URLの`/health`も確認してから、5つのLambdaのURLを照合する。URL変更時のみ更新し、他の環境変数を保持し、RevisionIdによって同時変更の上書きを防ぐ。通信不通なら次の監視周期で再試行する。音声生成自体の継続的な成功まではヘルスチェックだけでは保証しない。

認証情報は従来の `.env`、AWSプロファイル、ngrok設定を参照し、Gitへコピーしない。APIキーが空の場合は起動を拒否する。ログは `.local/tts-service/logs/` に保存する。APIログには会話関連情報が含まれる可能性があるため共有前に確認する。現段階ではログの自動世代管理は未実装。

## 適用と確認

管理者PowerShellでリポジトリルートから実行:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\tts-service\install.ps1 -ProbeOnly
Get-ScheduledTaskInfo -TaskName TTS-BootProbe
Get-Content .\.local\tts-service\logs\probe.log
```

プローブは既存TTSを停止せず、非対話タスク内でCUDA割当、設定読込、ローカル・公開ヘルス、AWS Lambda設定の読み取りを確認する。`LastTaskResult=0`と`PROBE PASSED`を確認した後に適用:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\tts-service\install.ps1
Get-ScheduledTask -TaskName TTS-AutoStart
Get-Content .\.local\tts-service\logs\supervisor.log -Tail 20
```

元タスクのXMLは `.local/tts-service/TTS-AutoStart.before.xml` に初回のみ保存する。インストーラーはWindows更新タスク・レジストリ・元のTTSリポジトリを変更しない。旧 `setup-tasks.ps1` を再実行するとログオン起動へ戻るため注意する。

完了判定には、非対話タスクでの動作確認に加えて、作業保存後にPCを再起動し、ログオンせずスマホでクローン音声の応答を確認する。再起動はこのインストーラーでは実行しない。API/ngrok終了からの復旧の実機試験は音声利用を中断するため、利用していない時間に行う。

## 公開経路: Cloudflare Tunnel（2026-09-13切替）

本番TTSの公開URLは **`https://tts.zakicorp.com`**（固定）。Lambda 5本の `ZAKICORP_TTS_URL` はこの値で、監視タスクが `config.json` の `public_url` を使って照合・維持する。ngrokは予備として引き続き監視配下で動いているが、Lambdaへは公開しない。

| 項目 | 値・場所 |
|---|---|
| Cloudflareアカウント / ゾーン | exodjp@gmail.com のアカウント、ゾーン `zakicorp.com`（無料プラン。ネームサーバーは `ariadne.ns.cloudflare.com` / `tate.ns.cloudflare.com`、2026-09-13にRoute 53から移行。登録先はお名前.com） |
| トンネル | 名前 `toytalker-tts`、ID `8bc0e7f0-7f28-409a-bb05-ea1d9c0c9d7c`（locally-managed） |
| DNS | `tts` → `8bc0e7f0-….cfargotunnel.com` のCNAME（`cloudflared tunnel route dns` で自動作成、プロキシON）。ほかに `toytalk` → CloudFront（DNS only）とACM検証用CNAME（DNS only）をRoute 53から移した |
| 設定ファイル | `C:\Users\exodj\.cloudflared\config.yml`（ingress: `tts.zakicorp.com` → `http://localhost:8000`、それ以外は404） |
| 認証情報（Git対象外、秘密） | `C:\Users\exodj\.cloudflared\cert.pem`（`cloudflared tunnel login` で取得）、`C:\Users\exodj\.cloudflared\8bc0e7f0-….json`（トンネル資格情報）。同じ3ファイルの複製が `C:\Windows\System32\config\systemprofile\.cloudflared\` にもある |
| 常駐 | Windowsサービス `cloudflared`（自動起動、LocalSystem）。`service install` は `--config` を保存しないため、`tools/tts-service/cloudflared-service-fix.ps1`（管理者）でImagePathに `--config` と `--logfile` を明示している |
| ログ | `.local/tts-service/logs/cloudflared-service.log`（サービス）、`cloudflared.log`（手動実行時） |
| 監視 | `supervisor.py` は `public_url` があればその `/health` を確認してLambdaへ同期する。Cloudflareは `Python-urllib` のUser-Agentを403で弾くため、監視は `toytalker-supervisor/1.0` を名乗る |

### 正常確認

```powershell
Get-Service cloudflared
Invoke-RestMethod https://tts.zakicorp.com/health -TimeoutSec 10
& 'C:\Program Files (x86)\cloudflared\cloudflared.exe' tunnel info toytalker-tts
Get-Content .\.local\tts-service\logs\cloudflared-service.log -Tail 5
```

`tunnel info` で東京拠点（nrt〜）へ3〜4本の接続があれば正常。切替時の実測は [バッチエンジン記録](qwen3-tts-batch-engine-2026-09-12.md) 参照（ngrokと同等、同時32件まで枯渇0）。

### 復旧

- サービスが止まった: 管理者PowerShellで `Start-Service cloudflared`。起動直後に落ちる場合は `cloudflared-service-fix.ps1` を再実行（ImagePathの引数が消えた場合の対処）。
- PC再起動後: サービスは自動起動。監視タスクとは独立。
- トンネルを作り直す: `cloudflared tunnel login`（ブラウザで承認）→ `tunnel create <名前>` → `config.yml` の `tunnel`/`credentials-file` を新IDに → `tunnel route dns <名前> tts.zakicorp.com` → `cloudflared-service-fix.ps1`。
- **ngrokへ戻す**: 管理者PowerShellで `switch-api.ps1 -ApiScript api_server_batch.py -PublicUrl ''`。監視タスクがngrokのURLをLambdaへ再同期する（約1分）。

### 未実施（次の段階）

Cloudflare Accessのサービストークン（Lambdaだけを通す）、公開側 `/health` の話者一覧非表示、話者登録名の検証、安定後のngrok撤去。

## APIの版の切り替え（元の `api_server.py` とバッチ版 `api_server_batch.py`）

2026-09-13追加。`config.json` の `api_script`（省略時 `api_server.py`）で監視が起動するAPIを選ぶ。`supervisor.py` はこの値を起動コマンドと既存プロセスの照合の両方に使う。`install.ps1 -ApiScript api_server_batch.py` で登録時に指定することもできる。

登録し直さずに切り替えるには、管理者PowerShellでリポジトリルートから:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\tools\tts-service\switch-api.ps1 -ApiScript api_server_batch.py
```

処理内容: `.local` の `config.json`・`supervisor.py` を日時付きで退避 → タスクを無効化・停止 → 8000番で待ち受けているAPIプロセスを停止 → `supervisor.py` を配置し `api_script` を設定 → タスクを有効化・起動 → ローカルhealth（最大240秒）→ ngrok公開healthを確認。ngrokは停止しないので公開URLは変わらず、Lambdaの更新は起きない。音声は停止からhealth復帰までの約40秒間止まる。

復旧は同じスクリプトを `-ApiScript api_server.py` で実行する。バッチ版の詳細は [実装と検証](qwen3-tts-batch-engine-2026-09-12.md)。切り替え後は `Invoke-RestMethod http://127.0.0.1:8000/health` の応答に `engine` があればバッチ版。

## 自動起動しなかったときの手動手順

管理者PowerShellを開く。以下はPCを再起動せず、TTS・ngrokの起動状態を確認・復旧する手順。

### 1. 状態とログを確認する

```powershell
$ttsRuntime = 'C:\Users\exodj\projects\toytalker\.local\tts-service'
Get-ScheduledTask -TaskName TTS-AutoStart | Select-Object TaskName, State
Get-ScheduledTaskInfo -TaskName TTS-AutoStart | Select-Object LastRunTime, LastTaskResult
Get-Content "$ttsRuntime\logs\supervisor.log" -Tail 30
```

`Running`は監視プログラムの稼働を示し、音声生成成功そのものを示すわけではない。初回起動前はログファイルがまだ存在しない場合がある。

### 2. タスクを手動で起動する

停止中なら次を実行する。Disabledなら先に有効化する。

```powershell
Enable-ScheduledTask -TaskName TTS-AutoStart
Start-ScheduledTask -TaskName TTS-AutoStart
```

モデルロードを待ち、ログに`api ready`と`Service ready; public health and Lambda URLs verified`が出るか確認する。タスクがすでにRunningの場合は重複実行されないため、この操作では再起動にならない。

### 3. ヘルスと音声を確認する

```powershell
Invoke-RestMethod 'http://127.0.0.1:8000/health' -TimeoutSec 10
Invoke-RestMethod 'http://127.0.0.1:4040/api/tunnels' -TimeoutSec 10
Get-Content "$ttsRuntime\logs\supervisor.log" -Tail 30
```

8000番への接続失敗はAPI未起動・準備中など、4040番への接続失敗はngrok未起動などの手掛かり。接続できても公開トンネルやAWS更新に失敗することがあるため、監視ログも合わせて見る。最後にスマホでクローン音声の会話を試す。

監視が新しく起動したプロセスの出力は`logs/api.log`と`logs/ngrok.log`。引き継いだ既存プロセスの過去の出力はこれらには保存されない。エラーが続く場合はログを確認し、PC再起動を繰り返さない。

### 4. タスクが使えない場合の一時的な直接起動

タスク自体が実行できない場合は、ログオンしたPowerShellから同じ監視プログラムを直接実行できる。先にタスクを無効化・停止し、二つの監視が同時に動かないようにする。停止時に音声が中断する可能性があるため、会話していないときに行う。

```powershell
Disable-ScheduledTask -TaskName TTS-AutoStart
Stop-ScheduledTask -TaskName TTS-AutoStart
Get-ScheduledTask -TaskName TTS-AutoStart | Select-Object State
# Runningでなくなったことを確認してから次へ進む
$ttsConfig = Get-Content "$ttsRuntime\config.json" -Raw | ConvertFrom-Json
& $ttsConfig.python -u "$ttsRuntime\supervisor.py" --config "$ttsRuntime\config.json"
```

このコマンドは監視を続けるため終了しない。PowerShellを開いたまま使い、状態確認は別のウィンドウで行う。一時対応を終えるときはCtrl+Cで直接起動した監視を終了させてから、タスクを有効化・起動する。残っているAPI/ngrokは監視が引き継ぐ。

```powershell
Enable-ScheduledTask -TaskName TTS-AutoStart
Start-ScheduledTask -TaskName TTS-AutoStart
```

配置ファイル自体が失われている場合はこの直接起動もできないため、登録手順または以下の元タスクへの復元を使う。プローブには稼働中のTTSが必要なので、完全停止状態でプローブだけを繰り返しても起動はしない。

## 戻し方

管理者PowerShellで監視タスクを停止し、保存したXMLを再登録する。停止時にタスク配下の子プロセスも終了する可能性があるため、音声利用していない時間に行う。

```powershell
Stop-ScheduledTask -TaskName TTS-AutoStart
$previous = Get-Content .\.local\tts-service\TTS-AutoStart.before.xml -Raw
Register-ScheduledTask -TaskName TTS-AutoStart -Xml $previous -Force
```

既存API/ngrokが残っている場合は二重起動しないようプロセスを確認してから元タスクを起動する。プローブタスクは起動トリガーがなく、自動では実行されない。

## 検証記録（2026-09-11）

- Python/PowerShellの構文確認を実施。
- 既存プロセス引継ぎ、終了後の待機、所有プロセスのみのヘルス復旧、モデルロード猶予、Lambda環境変数保持・RevisionId・URL不変時の非更新をユニットテストで検証。
- ユニットテスト6件成功。
- 通常権限ではタスク登録がアクセス拒否となり、UAC昇格で登録・実行した。
- 22:52:53、S4Uの非対話プローブでCUDA割当、`.env`読込、ローカル・公開ヘルス、AWS読取、ngrok設定ファイル存在確認が成功。タスク結果0。
- 22:53:36、監視開始。API PID 16796、ngrok PID 16968を停止せず引き継いだ。22:53:45、公開ヘルスと5つのLambda URLの照合に成功。URL更新は発生していない。
- 実タスクがRunning、S4U/Limited、MSFT_TaskBootTrigger、遅延PT30S、時間制限PT0S、再試行999回/PT1M、IgnoreNewであることを確認。
- OS再起動・プロセス強制終了の実機試験は未実施。

参考: [Microsoft: 起動時トリガー](https://learn.microsoft.com/en-us/windows/win32/taskschd/starting-an-executable-on-system-boot)、[タスクの再試行・実行時間設定](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/new-scheduledtasksettingsset)
