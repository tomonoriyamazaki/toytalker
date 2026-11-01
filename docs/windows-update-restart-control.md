# Windows更新による再起動の制御（2026-09-12）

## 要件と現在の状態

### 方針変更（2026-09-12）

ユーザーがWindowsの自動再起動を仕様として受け入れ、一時停止の解除と「1時〜5時をアクティブ時間外」にする設定可否の確認を依頼。Windows設定の「更新の再開」を実行した。以下の一時停止記録と恒久対策案は、それ以前の調査経緯として保持する。

アクティブ時間の標準上限は18時間。「5時〜翌1時」は20時間となるため設定できない。ユーザーが代替の「7時〜翌1時」（時間外1〜7時）を選択したため、標準設定画面で自動判定から手動へ切り替え、開始7:00・終了1:00を保存した。今後の運用は自動更新を受け入れ、アクティブ時間で再起動時刻を調整する方針。Proへの変更・恒久的な手動更新化は進めない。

設定後、画面の「現在は7:00から1:00まで」「手動」と保存値`ActiveHoursStart=7`、`ActiveHoursEnd=1`、`SmartActiveHoursState=0`を確認した。`PauseUpdatesExpiryTime`は未設定で、一時停止は解除済み。PC再起動試験はまだ実施していない。

### 変更前の調査記録

当初は完全な手動更新を希望し、暫定的に2026-10-17まで一時停止したが、上記の方針変更により解除した。以下は変更前の値であり、現在の設定ではない。

- OS: `Microsoft Windows 11 Home`、25H2、10.0.26200。Win32_OperatingSystemで確認。レジストリProductNameはWindows 10 Homeと残っているため、それだけでOSを判定しない。
- 既存設定: `NoAutoRebootWithLoggedOnUsers=1`、`AUOptions=3`。
- 変更前のアクティブ時間: 09:00〜翌01:00（自動判定）。
- 調査時のWindows Update画面は「最新の状態」。Windows UpdateのRebootRequiredキーなし。ただしこのキー単独であらゆる再起動要因を否定するものではない。
- 停止期限: `PauseUpdatesExpiryTime=2026-10-16T15:03:46Z`、JST **10/17 00:03:46**。機能更新・品質更新も同じ期限。設定画面は「2026/10/17まで一時停止」と表示。

## 9/10の再起動について分かったこと

Systemログ:

- JST 02:29:03、MoUsoCoreWorker.exeがOS Service pack理由で計画再起動を要求。
- 02:36:05、02:36:53、TrustedInstaller.exeがOSアップグレード理由で追加の再起動を要求。

Setupログ:

- 02:29:32、KB5126052をInstalled状態にするため再起動が必要と記録。
- 02:37:48〜49、KB5126052とKB5124008のInstalled状態への移行を記録。
- 更新履歴でKB5124008は2026-09セキュリティパッチ（26200.9445）、KB5126052は2026-09 .NET Frameworkセキュリティパッチと確認。

更新に伴う再起動であることは確認できた。現在のアクティブ時間から外れた時刻だが、当夜の設定履歴までは確認していない。したがって「時間外だったことが唯一の原因」「ユーザーが予約した」等とは断定しない。

既存のNoAutoRebootWithLoggedOnUsersは無条件の再起動禁止ではない。Microsoftの説明では予約された自動インストール（AUOptions=4）とログオン状態などが関係し、手動予約した再起動は優先される。現在の3との組合せを恒久的な防止策にはしない。[Microsoft: 更新後の再起動管理](https://learn.microsoft.com/en-us/windows/deployment/update/waas-restart)

## 一時停止を検討した経緯（解除済み）

Windows標準の「設定 → Windows Update → 更新の一時停止 → 日付を選択」で10/17を選択した。レジストリを直接書き換えて期限を偽装する方法は使っていない。

一時停止は期限が来ると自動で更新を再開する。新しいUIでは、その時点から最大35日の範囲で延長できるが、永続的な手動更新設定と同一ではない。今回は解除済みなので、10/17の停止期限の管理や延長は不要。[Microsoft: 更新の一時停止](https://support.microsoft.com/en-us/windows/deployment/updates-lifecycle/pause-updates-in-windows)

今後、一時停止を一時的に利用した場合の手動更新手順:

1. 作業を保存し、クローン音声の利用がない時間を確保する。
2. Windows Updateで「更新の再開」を選ぶ。この操作は更新のダウンロード・インストールを始め得るため、作業を続けたいときには押さない。
3. 更新と必要な再起動を実施する。
4. TTS/ngrokの復旧とスマホでの音声生成を確認する。
5. 通常は自動更新の運用に戻す。改めて一時停止が必要な場合だけ期限を設定・管理する。

既存のWindowsUpdate-Reminderは土曜10時の更新確認・通知タスクで、停止期限を監視する処理はない。この調査ではタスクを変更していない。

## 恒久対策の判断

Microsoftの自動更新管理ポリシーの対応エディションにはPro等が記載され、Homeは含まれない。Homeにポリシー用レジストリを書くだけで有効になったとは判断しない。[Microsoft: AllowAutoUpdate](https://learn.microsoft.com/en-us/windows/client-management/mdm/policy-csp-update#allowautoupdate)

Proへの変更と手動更新化も検討したが、ユーザーが自動更新を受け入れる方針を選択したため採用しない。購入・OS変更は未実施。

Windows Update由来以外のクラッシュ、電源障害、別のインストーラーによる再起動は、このポリシーでは防げない。TTSの自動復旧は継続する。[TTSの起動・復旧手順](tts-boot-recovery.md)

## 再起動後に外から戻る手順（2026-10-31）

Windows更新は1〜7時に自動で再起動しうる（上の方針）。再起動すると Claude Code のセッション（Remote Control）と、そこから起動した Metro は止まる。Claude Code をOS起動時に自動起動する公式の仕組みは無い（[Remote Control](https://code.claude.com/docs/en/remote-control.md)。サーバーモード `claude remote-control` も「ターミナルで動き続けるプロセス」の扱い）ので、自動起動はせず、iPhone から画面ごと入って起動し直す。

| 部品 | 設定 | 確認の仕方 |
|---|---|---|
| Tailscale | サービス自動起動 + **Run unattended**（タスクトレイ → Preferences）。ログオン前・サインアウト後もつながる。PC は**鍵の期限なし**（管理画面 Machines → `desktop-ojpa2dh` → Disable key expiry、2026-10-31）。期限が切れると外から入れず、PC の前で再ログインが要るため。iPhone・Mac は期限あり（約半年ごとにアプリで再ログイン） | `tailscale debug prefs` の `"ForceDaemon": true`、`tailscale status --json` の `Self.KeyExpiry` が空 |
| Sunshine | Windowsサービス `SunshineService`（自動起動）。ログオン前の画面も配信する。ファイアウォールの受信許可は全プロファイル | `Get-Service SunshineService` |
| BitLocker | 起動前PINは使っていない（ログイン時のPINは Windows Hello で別物） | 起動時に「BitLocker」の画面が出ないこと |
| ZakiCorp TTS | ログオン不要で自動起動（[起動・復旧](tts-boot-recovery.md)） | — |

手順:

1. iPhone の Tailscale（VPN）をオンにし、Moonlight で接続する。Moonlight が同じWi-Fiで自動検出した宛先は LAN の `192.168.11.5` なので、外からは「オフライン」扱いになり Wake-On-LAN を送ろうとする。初回だけ「+」から Tailscale の `100.125.70.89`（固定）を手動で追加する（2026-10-31 追加済み。ペアリングのやり直しは不要だった）
2. ロック画面を開き、Windows Hello の PIN でログオンする
3. VS Code で Claude Code を起動し、`/rc`（Remote Control）を実行する。以後はスマホの Claude アプリから操作できる
4. アプリの確認に Metro が要れば `cd app && npm run start:tunnel`（URL は固定、[app/README](../app/README.md)）

Tailscale の Run unattended と Sunshine は 2026-10-31 に設定・確認済み（iPhone のモバイル回線から Moonlight で接続できることを確認）。実際に再起動してからログオンまで入れるかは未試験。

### Wi-Fi の不調で外から入れなくなる件（2026-10-31 調査）

PC は Wi-Fi 接続（ルーター Buffalo WSR-5400AX6/NMB は別の部屋で有線は引けない）。Wi-Fi はマザーボード（ASUS ROG CROSSHAIR X870E HERO）搭載の MediaTek MT7927、ドライバ 5.4.0.3044（2024-12-15）。2.4GHz（`Buffalo-G-5830-WPA3`、ch7）で繋がっている。

不調は2種類ある（証拠は WLAN-AutoConfig の 8001/8003 と Claude Code のセッション記録）:

- **切れては戻る**: 理由がほぼ「ネットワークはドライバーによって切断されました」。10/21・10/22 は数分で数回、10/30 は 02:23〜02:44 の21分と 15:24〜15:28 の4分つながらなかった。
- **接続中のまま通信だけ止まる**（10/26）: Remote Control は 08:38 まで応答し、その後 19:16 まで記録が無い。その間 Wi-Fi の切断記録は無く、毎日 11:17 の時刻同期も 10/26 だけ 19:15 にずれた（PC全体が外と通信できていなかった。Claude 側の不具合ではない）。19:14 に手で Wi-Fi を繋ぎ直して直った。切断として記録されないので Windows は自動で直さない。

推測: PC の Wi-Fi（初期ドライバ）が本命。仕事のノートPCでも切れることがあるのでルーター側も残る。

方針（2026-10-31決定）: 通信を見張って自動で繋ぎ直すタスクは入れない（痛み止めで、保守するものが増えるため）。次の順に様子を見る。

1. ルーターのファームウェアを確かめる（仕事のノートPCでも切れるので、両方に効くルーターから）。管理画面 `http://192.168.11.1`（ログイン情報は本体ラベル）→ 詳細設定 → 管理 → ファームウェア更新で、今の版・自動更新の設定・新しい版の有無を見る。更新中は家のネットが数分止まるので PC の前で行う。**確認済（2026-11-01）: Ver.1.09、自動更新「重要な更新のみ」毎日 04:00〜04:59（1.08→1.09 も自動で入った）。ルーター側でやることは無い**（4〜5時の自動更新の再起動で一瞬切れるのは正常）
2. まだ自作PCだけ切れるなら、Wi-Fi ドライバを ASUS のサポートページ（ROG CROSSHAIR X870E HERO → Windows 11 → Wireless）の最新版へ更新する。更新中は Wi-Fi が切れるので PC の前で行う。**済（2026-11-01）: 5.4.0.3044 → 5.7.0.6054（ASUS 公式、2026/07/16 版）。数日後に WLAN-AutoConfig の 8003（切断）の件数と Remote Control の切れ方を見て効果を判断する**
3. 有線が要るなら、LAN 端子付きの中継機・メッシュを PC の部屋に置いて PC と有線で繋ぐ

効いたかは、数日後に WLAN-AutoConfig の 8003（切断）の件数と、Remote Control が途切れた日の有無で見る。
