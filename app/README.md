# ToyTalk App

- ToyTalk アプリの React Native / Expo プロジェクトです。
- iOS / Android アプリのソースコードをこのディレクトリで管理しています。
- 現在はiOSのみ稼働

---
## ツール
- React Native	：JavaScript。node.jsを使う
- Expo          ：RNのツール群。アカウント登録が必要
- EAS			      ：Expoのクラウドサービス。ビルドを手軽にしてくれる
- .ipa			    ：ビルド後にできるiOSアプリのバイナリコード
- xcode			    ：ビルド&検証ツール。今回はEASに任せるので使わない

## 環境
- 開発端末       ：Windows PC 1台でok。これで開発～検証までできる。VSCodeにgit bashを入れておく
- 入れるもの     ：nodejsをサイトからとってきて入れる　→　npm(nodejsのインストーラ)コマンドでexpo,eas群のツールを入れる

### iOSアプリの検証方法
- 流れ          ：コード書く　→　簡易検証　→　実機検証　→　TestFlight（iOSアプリに登録する前の段階のもの）にアップ
- 簡易検証       ：アプリのUIとか操作感とかをさくっと確認できる。npx expo start -cコマンドしたら、QRでるので、アプリ側にexpo go入れた状態でカメラ読み取りでok。ただマイクとか機器自体の機能があるとNGになるので、途中からは使えなくなる
- 実機検証初期設定：iPhoneのデバイス登録をしたり必要なツールを導入する
  - npm i -g eas-cli             ：EASを入れる
  - npm i -D expo-dev-client     ：Expoの検証用ツールを入れる
  - eas device:create            ：証明書設定してデバイスを登録する。前提としてapple developper（1.5万円/年かかる）に登録。スマホを新しくしたら、コマンドではデバイス追加がうまくいかなかったので、developerサイト上で手動でデバイス追加→プロファイル上でデバイス登録→eas credentialsでプロフィル削除→buildで認識された
  - eas.jsonの修正               ：ビルドのprofileを設定する。development = 実機検証1、preview = 実機検証2、testflight = TestFlight用で今回は設定。3つ作ったが、正直、preview = testflight用でよかった
- 実機検証1      ：これがメイン。マイクなどのiPhoneの機能を使うために必要。PC側でのサービス起動が必要だが、毎回buildしないで済むので素早く検証できる
  - eas build --platform ios --profile development    ：ビルド。10分以上かかる。ネイティブ系やapp.jsonの変更がある場合は都度buildする。jsコードなどの場合は不要。QRコードが発行されるのでそこからダウンロードする。
  - npx expo start --dev-client --tunnel  ：このコマンドでサービスが立ち上がる。起動中の間だけアプリを利用できる。初回だけQRを読み込む
    - 必ず --tunnel 付きで起動する。tunnel なしだと URL が 192.168.x.x の LAN アドレスになり、自宅Wi-Fi以外から繋がらない。tunnel だと Expo 管理の *.exp.direct の公開URLになるので、キャリア回線や出先からも同じ dev client で繋がる（PCはスリープ無効のまま起動しっぱなしにする）
    - tunnel の URL はプロジェクトの場所と Expo アカウント名から決まるので、expo start を再起動しても同じ。2回目以降は dev client の「Recently opened」から繋がり、QRの再読み込みは不要。読み直すのは dev client をビルドし直したとき（新しいアプリにURLの記憶が無い）だけ
    - ここで使う ngrok は Expo 社が用意した専用経路で、自分の ngrok アカウントや TTS 配信（Cloudflare）とは無関係
- 実機検証2       ：実質不要。PC側でサービス起動（expo start）しなくてもアプリ検証できる。でもjsコードを修正したら毎回buildしないといけないのでほぼ使わない。ここで検証せずにtestflightへ登録でok
  - eas build --platform ios --profile preview    ：ビルド。10分以上かかる。QRコードが発行されるので、ダウンロードすれば利用可能
- TestFlight    ：iOSアプリとして登録する前段階の検証サイト。ここにアップしたら、URLが発行できるようになる。これも初回手続きが面倒
  - eas.jsonの修正               ：ビルドのprofileを設定する。今回はtestflightを追加。distorbutionにstoreを指定する
  - eas build --platform ios --profile testflight   ：ビルド。ここに10分以上かかる
  - eas submit --platform ios --latest  ：TestFlightに提出するコマンド
  - apple connectサイトでのTestFlightテスター設定      ：テスターには内部と外部がいるが、内部だとApple ID登録するとか面倒。外部だと審査下りればみんな使える→外部を設定する→URLが発行される。審査は1-2日?で基本通る
  - →URLが発行されたら、それを共有する→testflightアプリ経由で、対象アプリのインストールができるようになる

### Android

（未設定）

---

## ✅ 完了
* スプラッシュなし
* アイコン追加
* TestFlight のアップロードと外部公開
* 権限まわり（マイク、通知）の実装
* 会話機能実装　※STTはスマホ依存

## 機能追加
* おもちゃのwifiを設定できるようにする
* ログ機能追加

## 改善
* 話している内容を保持する　→　OK
* 時間計測できるようにした（DEGUB_TIMEでon/off）　→　OK
* マイク開始中は音声会話ずっとできるように　→　OK
* マイク開始中、スマホから出る音声が入力されてしまう防ぐ or 出力中は入力止める　→　OK。出力中は止める
* 文字入力画面になると入力中の文字が見えなくなる
* 下に自動スクロールさせたい
* 文字区切りがおかしい
* ボイスのテンションが安定しない。↑が原因なのもある。4o-ttsに雰囲気の指定ができるので試す　→　いろいろなTTSをお試し中。ニジボイス申請中


```

