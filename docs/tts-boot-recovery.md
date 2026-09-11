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
