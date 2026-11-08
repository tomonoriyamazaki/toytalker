# ESP32-S3ファーム: 現在の状態と入口

ESP32-S3スタンドアロン機（v3）のファーム開発の入口。ここには「今どの版が何に入っていて、何が未確認か」と、各調査メモへの案内だけを置く。ルール（Arduino IDE維持、フォルダ1つ＋gitタグ）は [CLAUDE.md](../CLAUDE.md) の「ESP32-S3ファーム開発」。残作業の順番は [ロードマップ](roadmap.md) の6。状態が変わったらこの節を上書きし、経過は各調査メモへ書く。

## 現在の状態（2026-09-16時点）

- 開発先は [v0.7](../devices/mcu/esp32_s3/toytalker_mini_v0.7/toytalker_mini_v0.7.ino)（OTA対応、NLP既定=AGGR、`sketch.yaml` にボード設定あり）。[v0.6](../devices/mcu/esp32_s3/toytalker_mini_v0.6/toytalker_mini_v0.6.ino) は音量方式の検証版、[v0.5](../devices/mcu/esp32_s3/toytalker_mini_v0.5/toytalker_mini_v0.5.ino) は実機確認済み安定版として保持。
- 試験機「v0.2 大スピーカー」（`90:da:72:49:ba:e5`）に入っている版は **0.7.4**（2026-10-29、beta に発行して OTA で更新、`fw_channel=beta`）。0.7.4 の内容は、接続先を CloudFront の固定ドメイン `api-rnd.zakicorp.com`（`TOYTALKER_API_HOST`、経路 `/chat-mcu` `/backchannel-mcu` `/stt-token`）にし、POST に本文の SHA-256（`sha256Hex()`、`x-amz-content-sha256`）を添える（ロードマップ3、[infra/README](../infra/README.md) の「固定ドメイン」）。実機で会話・相槌・OTA 判定が CloudFront 経由で通ることをログで確認済み。0.7.3 は本文・相槌の要求に `"fw":"<版>"` を添える（Lambdaの切り分けログ用）、Soniox一時キーの期限前の取り直し（下記）。git タグ `fw-0.7.3` `fw-0.7.4`。`stable` は未設定のまま。配布機は `toytalker_v07_serial_nowait`（2026-09-12夜書き込み、OTA非対応、版の報告なし）。
- 実機構成: AEC後のAC RMSで音声割り込み判定、NLP=AGGR、音声割り込みON、ボタン即時消音、AEC毎ターン再作成、TLSはPSRAM固定、USBログ送信待ち0。TTSはCartesia基準。
- NLP既定はAGGR（2026-09-16にNORMALから変更。実機構成と同じ）。NORMALで比較するときは `--build-property 'compiler.cpp.extra_flags=-DTOYTALKER_AEC_NLP_LEVEL=0'`。
- AEC調整は一旦終了。「途中停止は減ったが、声で止めるには近づく必要がある」というトレードオフは既知で、最終的な限界とは扱わない。AEC本体の時刻整列・入力飽和・フィルタ等に未検証の改善候補あり。
- **本体が生きているかは `devices` の `last_seen` で見る**（2026-11-08）: 鍵発行 Lambda が `device_id` 付きの要求のたびに更新する（本体は起動時と3分ごとに呼ぶ。旧ファーム v0.6 も `device_id` を付けるので配布機も対象）。それ以前は機器設定 Lambda しか書いておらず「最後にアプリで設定を触った時刻」だった。配布機2台の最後の会話は 2026-09-07 と 09-10（会話ログで確認）。
- **旧ファーム（v0.6）はいまのバックエンドでそのまま動く**（2026-11-08 に同じ形の要求を Function URL へ送って確認。接続先・要求の項目・応答の枠（型バイト＋長さ）が同じで、知らないイベント名は無視する）。
- **OTAは2026-09-15実装、2026-09-16に試験機で 0.7.1→0.7.2 の更新成功（17秒）。** 配布した版はgitタグ `fw-0.7.1` `fw-0.7.2`。S3 `toytalker-firmware` の `manifest.json` は `channels: {beta: "0.7.2"}`、stable は未設定。更新確認は起動時にSoniox一時キー取得の応答で行い、本体はS3から直接取る。発行は `bash devices/mcu/esp32_s3/tools/publish-firmware.sh beta`、`stable --promote` で全機へ。仕様・検証手順・未実施の本番操作は [OTA実装](esp32-ota-settings-plan.md)、実装後の残タスクは [OTA引き継ぎ](handoff-esp32-ota-2026-09-16.md)。
- **Soniox一時キーの取り直し（2026-10-28実装、試験機で確認済み）**: キーはLambdaが1時間有効で発行するが、以前は起動時の1回しか取らず、時間が経つと期限切れのキーでWSを開いて会話が始まらなかった。取得から `SONIOX_KEY_MAX_AGE_MINUTES` 分を越えていれば、再生中の先行接続ワーカー（Core 0、`SonioxPreconnect::Prepare`）がWSを開く前に取り直し、先行接続が無い回は `startSTTRecording()` が接続前に取り直す。取り直しの呼び出しは `device_id` 等を付けない軽いGET（Lambdaはデバイス報告もOTA判定もしない）。Sonioxの `error_code` 応答は `[STT] soniox error:` でログに出す（自動復旧は作らない。証拠が出てから判断）。**2026-10-28から「寿命3分（Lambda に `?ttl=180` で頼む）・閾値2分」で試用中**。ほぼ毎ターン取り直しが走り（再生中のワーカーで1.6秒。再生・録音再開への影響なし、`stack_free` は取り直しあり/なしで同じ4096〜4720）、キーが本当に3分で切れるので「一度も Soniox のエラーが出ない」ことが取り直しの検証になる。問題が出なければこの組を本番値にする。`ttl` を付けない古いファーム・アプリは従来どおり1時間。アプリ側（`chat.tsx`）も同じ50分判定で、画面表示時・前面復帰時・WSを開く直前に取り直す。
- スマホから音声割り込み・相槌を再起動なしでON/OFFする案は未実装。相槌設定の本体反映は起動時、音声割り込みはファーム内固定。[設定同期の相談記録](esp32-ota-settings-plan.md)。

### 未確認・未実装

- OTA: 途中電源断、SHA改ざん、ロールバック（[OTA引き継ぎ](handoff-esp32-ota-2026-09-16.md)）。
- Soniox一時キーの取り直し: 2分の閾値での動作は2026-10-28に確認済み（`prepare_ms=1643 key_refreshed=1`、次ターンは `key_refreshed=0`）。残りは、寿命3分・閾値2分の試用で数日運用して `[STT] soniox error` が出ないこと（ロードマップ11）。
- 検索を挟んだ返答で再開直後に音声割り込みが誤発火する件（OTAとは別件。原因仮説のみ、対策未合意）。
- 盛り上がる場面の再生音で音声割り込みが誤発火する件（2026-11-01、0.7.4、昔話の「門をドンドンと叩いて」の辺り）。止まった直後の発話は「お話」の2文字で、再生中の返答に含まれる語だったため、再生音の漏れと推定（推測）。**サーバー側には割り込みの記録が無く、ログから確かめられない**。割り込みの記録を次の要求に添えて Lambda のログに出す（下の「11月配布版」の計測に含めた）。原因が確かめられたら、しきい値か AEC 側の対策を決める。改善の順（証拠→音量連動しきい値→消音して確かめる方式→相関判定・AEC本体・筐体）は [ロードマップ](roadmap.md) 6。
- stream終端の切断・救済経路の実機再現、Soniox再接続後の録音停止（別件）、検出前・未接続中の音声保持（未実装）。
- 本文開始の高速化で保留した候補は [先送り項目](deferred-items.md)。

### 11月配布版に入れるもの（2026-10-30決定。ロードマップ6）

西川さん・中島さんの配布機は OTA 非対応の旧ファームで、USB で書き換える。**期限は 2026-11-15**（中間発表で中島さんと会う。西川さんは未定で、会える日に同じ版を書く。束の中身は変えない）。これが最後の USB 書き込みになるので、次の版に以下を束ねて入れる。以後の修正は OTA で届く。両機が新版になったら `infra/config/stages.ts` の `directFunctionUrls` を false にし（Function URL を IAM 認証に）、デバイス鍵の初回登録を閉じる。

- **CA 検証**（脅威モデル #3。2026-11-08 実装、0.7.6。試験機で会話・相槌・鍵発行・Soniox が繋がることを確認。接続時間の比較は未）: TLS は全接続で証明書を検証する。会話（`setCACert`）・相槌と Soniox 鍵発行（`HTTPClient::begin(url, CA)`。CA を渡さない `begin(url)` は中で `setInsecure` になる）は `AmazonRootCA.h`（CloudFront の証明書は ACM の Amazon RSA 2048 M01 ← Amazon Root CA 1）。Soniox の WebSocket は `beginSslWithCA` と `SonioxRootCA.h`（2026-11-08 のチェーンは WE1 ← GTS Root R4。Google の推奨どおり GTS Root R1〜R4 と GlobalSign Root CA の5枚。`beginSSL` は CA を渡さないと `setInsecure`）。両方の束で実サーバーのチェーンが通ることを openssl で確認済み。**実機で見ること**: 会話・相槌・鍵発行・Soniox が繋がること、`[LATENCY] lambda_connect_ms` と `[WS_PRECONNECT] elapsed_ms` が 0.7.5 から大きく増えないこと（証明書の検証ぶん。Soniox は ECDSA P-384）、`[DIAG]`・`tls_memory` の空きが減りすぎないこと。鍵発行が通らない版は起動確認（`confirmRunningImage`）に届かないので、OTA なら次の再起動で前の版へ戻る。
- **デバイス鍵**（脅威モデル #2。なりすまし防止。2026-11-08 実装、0.7.6。Lambda・CloudFront は deploy 済（2026-11-08。架空の device_id で鍵のヘッダーが Lambda まで届くことを確認）。0.7.6 は beta に発行済（`--allow-dirty` なのでタグ `fw-0.7.6` はコミット時に付ける）。**試験機へ OTA（2026-11-08 19:23）し、鍵発行で `enrolled`、以後の会話・相槌で `match` をログで確認**（指紋 68a19974）。最初の発行は配布スクリプトのビルド先の食い違いで中身が 0.7.5 だった（スクリプトを直して上書き）。会話の体感の速さは未確認）: `DeviceAuth.h`。Wi-Fi 接続後の最初の通常起動で 32 バイトの乱数鍵を作り、NVS の `device` 名前空間（`auth_key`、16進64文字）に保存する（Wi-Fi 設定のやり直しでは消えない）。会話・相槌・Soniox 鍵発行の全要求に `x-toytalker-device-key` で添える（キーだけの軽い鍵発行にも `device_id` を付けるようにした。本番でアプリ扱い＝トークン必須にならないため）。シリアルには指紋（SHA-256 の先頭8文字）だけ `[DEVKEY] created|loaded fingerprint=…` と出し、Lambda ログの `device_key_fp` と同じ値になる。Lambda は `backend/shared/auth.mjs` の `checkDeviceKey`: 行に `device_key_hash` があれば一致を要求、無ければ鍵発行 Lambda が初回の鍵のハッシュを保存（会話・相槌は保存せず通す＝`pending`）、鍵の無い旧ファームは通す。ログの `device_key`（`match` / `enrolled` / `pending` / `missing` / `mismatch` …）で移行を数える。端末の報告（`last_seen`・版）も鍵が合う要求だけが書ける。アプリへ返す devices の行からハッシュは外し、`device_key_registered` だけ返す。CloudFront はヘッダーを許可リストで転送するので `x-toytalker-device-key` を足した（10個で上限）。**止め方・戻し方**: 漏れたらその行の `device_key_hash` を消す（登録を開けている間は次の鍵付き要求で登録し直される。閉じていれば止まったまま）。NVS を全消去した機器・`fw_target` で 0.7.5 以前へ戻した機器は 403 になるので、同じく行のハッシュを消す。**両配布機が 0.7.6 以降になりログの `device_key` が `match` だけになったら** `stages.ts` の `deviceKeyEnroll` を false（`directFunctionUrls: false` と同じ時）。
- **本体側の計測を次の要求に添える**（遠隔で途切れを診るため。2026-11-08 実装、**0.7.7**。Lambda の `describeDevice` は deploy 済。0.7.7 を試験機へ OTA し、ログに `device.prev` / `device.stt` が届くことを確認（2026-11-08 21:10、3ターン）。そこで見つけた数え方の誤り3つ（出し切り中の割り込みで `unplayed_ms` が 0、`last_text_to_end_ms` がいつも 0 付近、自分で切った Soniox を `disconnects` に数える）を直した **0.7.8 を beta に発行し、試験機へ OTA（2026-11-08 22:13）。22:32・22:34 の2ターンで、直した値（`last_text_to_end_ms` 2050 / 125 など）が届くことを確認**。**次（2026-11-09〜）**: 返答の途中で「普通の声で止める」「大声で止める」を2〜3回ずつ試し、黙って聞くターンと合わせて、しきい値と飽和の扱いの値を決める。あわせて速さの2つ（相槌の取得を待たずに本文を送る、猶予 0.6 秒の間に TLS を先に張る）に着手するか、11/15 の束に入れるかを決める。22:32 の黙って聞いたターンでは、再生音だけでマイクが 28 フレーム飽和し（`aec_clip_frames`）、AEC 後は瞬間 2373・4フレーム持続 702 だった。**飽和を一律に声とみなすと誤発火する**ので、飽和時はマイクと参照（`aec_ref_peak` 7872）の比で判断する形にする。再生音の漏れは持続でおよそ 700〜1400 に出ている（2例）。相槌ありでも、取得が済んでいれば送信前の待ちは 22ms（1.4秒待つのは取得中のときだけ）。TLS は毎ターン 0.6〜0.7 秒。**0.7.7 の3ターンで分かったこと（各1例。推測を含む）**: (1) 黙っていて止まったターン（利用者は話しかけていない）は `stop=aec`、発火時の AEC 後 1392（しきい値 1200）・残り 28%（下限 25%）とすれすれで、再生音の漏れによる誤発火と見ている。(2) 止まらなかったターンは AEC 後でも `aec_out_sustained=21759`（しきい値の約18倍）なのに不発。残り判定・処理遅れでの却下は 0 で、マイクの飽和 116 フレーム（約3.7秒）とその後の判定停止 100 フレームが続いていた＝**大声ほど飽和の安全策で判定が止まる**。誤発火（1392）と大声（21759）の差は大きいので、しきい値を上げる（または再生音量に連動）＋飽和時の扱いを変える組み合わせで両方を改善できる見込み（ロードマップ21）。値は「黙って聞く・普通の声・大声」の記録を数回集めてから決める。(3) 送信を決めてから返答が鳴り始めるまで、相槌なし 2.6 秒・相槌あり 3.65 秒。相槌ありは送信前に相槌の取得を約 1.4 秒待っている（`pre_ms`）。TLS は毎ターン約 0.6 秒。並行送信と猶予中の先行接続で最大約2秒縮む見込み。（最初の 0.7.7 の発行は arduino-cli が PATH に無く古い .bin が約2分出ていた。`--force` で差し替え、`publish-firmware.sh` はビルド失敗と、.bin に `"fw":"<版>"` が無いときに止まるよう直した）。）: `TurnReport.h`。会話の要求の `device` に、いまの状態（`rssi`・`heap_free`・`heap_min`・`max_blk`・`psram_free`・`uptime_s`）と、`prev`（前のターン）・`stt`（この発話の聞き取り）を添え、Lambda が `trace.mjs` の `describeDevice` で1行ログの `device` に写す（項目の一覧は [infra/README](../infra/README.md) の「Lambdaログの見方」）。数値と決まった語だけで文章は入れない。シリアルにも同じ中身を `[TURN_REPORT]`（ターンの終わり）と `[STT_REPORT]`（送信を決めた時）で出す。本体が再起動すると前のターンの記録は消える（`uptime_s` で分かる）。**0.7.6 の試験で出た3件の見方**: (1) 黙っていても再生が止まる → `prev.stop`（`done` / `aec` / `button` / `stream_error` / `connect_failed` / `i2s_failed`）と `prev.barge_ms`・`prev.unplayed_ms`（止めたとき鳴らしていなかった長さ）。`aec` なら同じ行の `aec_trigger_out` / `aec_trigger_mic` / `aec_trigger_ref` / `aec_retained_pct` が発火した4フレームの値（参照が大きく残りが25%すれすれなら再生音の漏れ＝ロードマップ21の材料）。`done` なのに短く聞こえたなら `underruns` と `audio_ms`（受けた音声の長さ）を見る。(2) 大声でも割り込めない → 割り込みが無かったターンでも `aec_out_peak`（AEC 後の AC RMS の最大）と `aec_out_sustained`（4フレーム続けて超えた最大の値）を `aec_threshold`（1200）と比べる。sustained が届いていないなら声が足りない／AEC が声まで削っている、届いているのに発火しないなら `aec_residual_rejects`（残り25%判定で落とした）・`aec_clip_frames` / `aec_recovery_frames`（マイクの飽和で判定を止めた。大声ほど起きる）・`aec_age_rejects`（処理遅れ）のどれかで落ちている。(3) アプリより遅い → `stt.last_text_to_end_ms`（最後に文字が変わってから Soniox の `<end>` まで）→ `stt.end_to_send_ms`（猶予 0.6 秒）→ `prev.pre_ms`（相槌の待ち・I2S 切り替え）→ `prev.tls_ms`（TLS、毎ターン張り直し）→ `prev.headers_ms` → `prev.first_audio_ms` → `prev.play_start_ms`（溜め 0.34 秒の後）。`prev.*` は前のターンの値なので、同じ機器の次の turn 行に載る。Lambda の中の区間は同じ行の `marks`・`segments`。ほかに `stt.ws_wait_ms`（録音開始時に Soniox が未接続だった時間。その間の声は落ちる）、`stt.disconnects` / `stt.errors`（ロードマップ20 の Soniox 切断の回数）。元の決定（2026-11-01・11-08）: 割り込みの記録（判定時の AC RMS としきい値・再生開始からの ms）、割り込みが無いターンの最大値、区間の内訳、Soniox の再接続回数、RSSI、空きヒープ。サーバー側で分かっていたこと: 0.7.6 の試験ではどのターンも返答は最後まで送り切っている（エラー0）。止まるのは本体側。
- **Soniox 切断後に録音へ戻す**（ロードマップ20、2026-11-04）: いまは `WStype_DISCONNECTED` で `isRecording` を false にするだけで、録音を立て直す処理が無い（戻す手段は電源の入れ直しだけ）。先行接続は返答の再生開始時に開始メッセージまで送り、再生が終わるまで音声を送らずに待つので、Soniox が最初の音声を待てずに 408 で閉じる、または idle（close 1001）で閉じる余地がある（閉じるまでの秒数は文書に無い。鍵の期限は開いている接続を切らないと文書にある）。直し: 切断されたら録音状態へ戻し、先行接続が無ければ接続し直す。証拠はシリアルで「Soniox disconnected」の後に「Starting STT recording」が続かない箇所。
- **Soniox の鍵を接続時に渡す**（ロードマップ22、期限 2027-01-15）: 開始メッセージの `api_key` は廃止予定で、接続時の `Authorization: Bearer` ヘッダーかサブプロトコル `soniox-api-key` に移す。先行接続ワーカーは鍵を先に用意してから接続する形に変える。
- **話し終わりの猶予 0.6 秒**（ロードマップ25から先に。2026-11-08 実装、ビルド確認のみ・実機未）: `END_SILENCE_MS`（途中結果が 800ms 更新されなければ送る予備判定）を外し、アプリの「ふつう」と同じ猶予にした。Soniox の `<end>` の後 `STT_GRACE_MS`（600ms）待ち、その間に声（ブロック RMS ≥ `STT_GRACE_SPEECH_RMS`）か新しい文字が出たら同じ発話として次の `<end>` を待つ。声だけで文字が `STT_GRACE_RESUME_MAX_MS`（3秒）来なければ送る。Soniox が `<end>` を送らずに 4 秒黙ったときの救済（`STT_STALL_MS`）は残した。Soniox の待ちの値（感度・最大待ち）は開始メッセージに足していない（25 でサーバーから配る）。**声のしきい値 1200 は暫定**（再生中監視と同じ `>>14` の尺度で、静かな部屋の声の大きさは未計測）。シリアルの `[GRACE] sent +…ms after first end (quiet|no new text|stall, resumed=…, speech_peak_rms=…, grace_peak_rms=…)` で、話している間と猶予中の音量を見て詰める。物音で毎回つなぐなら上げ、言葉の続きを拾えないなら下げる。
- **電池電圧・温度・充電状態を要求に添える**（ロードマップ25から先に。2026-11-08 実装、ビルド確認のみ・実機未）: `PowerSense.h`。起動時と録音中 30 秒ごとに読み（シリアル `[POWER]`）、会話の要求に `"device":{"vbat_mv","board_temp_c","chip_temp_c","chg_stat1","chg_stat2"}` を添える。Lambda は `trace.mjs` の `describeDevice` で1行ログの `device` に写す。電圧は分圧×2 の未校正値、基板温度は TH2（B=3380）から計算、STAT1/2 はピンの値のまま（意味は BQ25185 のデータシートと実機で確かめる）。`devices` への記録・一時キー要求への添付・アプリ表示は 25。本体側の計測（上）も同じ `device` に足す。**0.7.5 を試験機へ OTA（2026-11-08 15:47、beta）し、ログに値が届くことを確認**。このときは電池なし・USB 給電で、`vbat_mv` 4058〜4216、STAT 1/1 と 1/0 が入れ替わった（電池が無いので充電ICの BAT 端子の電圧と、電池を探す動きを読んでいると推定。電圧と STAT の意味は電池をつないで USB の抜き差しで確かめる）。基板温度 43〜46℃・チップ 51〜54℃（TH2 がチップの熱を拾っているかは未確認）。猶予は「若干遅いが許容」（ユーザーの体感。`[GRACE]` は未取得）。
- 接続先は CloudFront の固定ドメイン（0.7.4 で済）。OTA 対応（0.7 系で済）。
## 環境・ビルド

- ビルド確認済みのコアはArduino ESP32 3.3.11 / IDF 5.5.5。利用可能なAPIは実際のインストール済みコアで確認する。起動時の `[BUILD]` で実機の版を確認する。
- ボードはESP32-S3-MINI-1-N4R2（Flash 4MB、quad PSRAM 2MB）。Partition Schemeは `no_fs`（2MB APP x2、OTA用）。
- mbedTLSのcallocは `TlsMemory.h` で起動時にPSRAMへ固定し、内部RAMへはフォールバックしない。
- Arduino IDE付属のarduino-cliでもビルド確認できる。リポジトリルートから（書き込み時は実機のボード・ポート・IDE設定を確認する）:

```powershell
arduino-cli compile --fqbn esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=4M,PartitionScheme=no_fs,CDCOnBoot=cdc --build-path "$env:TEMP/toytalker_v07_build" devices/mcu/esp32_s3/toytalker_mini_v0.7
```

`sketch.yaml` の `default_fqbn` があるので `--fqbn` を省略してもよい。

## 調査メモ

- [v0.7 AEC試験手順・実機結果・復旧](esp32-v07-aec.md) — AEC全般の入口。NLP=AGGRの根拠とボタン即時消音の実測もここ
- [AC RMS判定と到達点](esp32-aec-gate-ac-2026-09-12.md) — 現行判定方式、今後の改善余地、再開時の切り分け手順
- [終端調査と修正](esp32-stream-end-investigation-2026-09-12.md) — 終端救済の実装と、AEC閾値の根拠になったturn=18/20の実測
- [USBログ待ち対策](esp32-usb-log-backpressure-2026-09-12.md) — 現行実機版の最後の変更
- [入力クリップ比較](esp32-aec-input-headroom-2026-09-12.md) — 入力1/4縮小を却下した記録。再提案しないために残す
- [音声介入第一弾（v0.6）](esp32-v06-voice-barge-in.md) — 音量方式が不可と分かった根拠、RXターンごと再確保の由来
- [TLSメモリ調査](esp32-s3-tls-memory-investigation-2026-09-06.md) — Stringリーク修正の経緯と、未修正のリスク一覧
- [v0.5 再生終了の計測](esp32-playback-end-timing.md) — v0.5のみ。v0.7はI2S APIが違う
- [配布実機の音途切れ報告（2026-09-11）](device-audio-investigation-2026-09-11.md) — サーバー側調査、原因未特定。実機の版照合が未着手
- [OTA・設定同期・状態送信](esp32-ota-settings-plan.md) — OTAの仕様・配布手順・実機検証、設定同期の相談記録
- [OTA引き継ぎ（2026-09-16）](handoff-esp32-ota-2026-09-16.md) — OTA実装後の残タスクと、検索後の誤停止の記録
- [マイコン（ハード）](mcu.md) — パーツ一覧、基板設計の覚え書き、次の基板改修で行うこと
