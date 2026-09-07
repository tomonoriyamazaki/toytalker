# ESP32-S3 v0.5 TLSメモリ調査（2026-09-06）

対象: `devices/mcu/esp32_s3/toytalker_mini_v0.5/toytalker_mini_v0.5.ino`

## 修正・実機確認後の結論（同日追記）

相槌タスクのStringリーク修正を採用した。修正コミットは `0d1037a`（`Fix backchannel task String leak before task deletion`）。修正後、ユーザーの実機試験で従来の8〜10ターンを超えて会話を継続でき、報告された試験範囲ではTLS接続失敗が再発しなかった。相槌タスクのリークが主要因だった可能性が高い。

**TLSのPSRAM移行は見送り、リーク修正を適用した状態で通常使用を続ける。** 以下に残すPSRAM移行案は、再発時に検討できる未採用の回避策であり、現在のファームには入っていない。

### 採用した修正と検証

- 相槌取得処理を通常のヘルパー関数 `fetchBackchannel()` に分離した。
- ヘルパーから戻る際に `partial`・`charId`・`url`・`payload` を破棄し、その後タスク側で完了状態を更新して `vTaskDelete(NULL)` を呼ぶ。
- `[BC] Free heap after` は上記Stringの解放後に出力する。タスクスタック自体の回収完了を示すログではない。
- Arduinoコア3.3.10でファーム全体のコンパイル・リンクに成功。FQBN: `esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=4M,PartitionScheme=huge_app`。Flash 1393435 bytes、静的RAM 50032 bytes。
- ユーザーが修正版を実機で試験。途中で約15ターンとの申告があり、その後も会話を継続して問題なしとの報告。正確な総ターン数は未計数。

### 提供されたスクリーンショットの計測値

すべて再生終了時の `[MEM]` 行。撮影時刻ごとの抜粋であり、連続する全ターンの記録ではない。

| 撮影時刻 | free (bytes) | max_blk (bytes) |
|---|---:|---:|
| 22:41:17 | 100080 | 34804 |
| 22:44:23 | 90332 | 31732 |
| 22:45:23 | 88804 | 31732 |
| 22:56:53 | 94704 | 31732 |

後半の最大連続ブロックは31732 bytesを維持し、freeも最後の抜粋では回復している。各画像で再生完了から録音への復帰が確認できた。ただし接続直前の `[DIAG] pre-connect` とは計測フェーズが異なり、以前の失敗時の約17KBと直接比較するものではない。全条件での解決や長時間の耐久性を保証する試験ではない。

最終画像の `underruns=13` は音声リングバッファが空になった記録。TLS接続失敗とは別の症状であり、これ自体はリーク継続の証拠ではない。音声供給の遅れの原因は未特定で、音切れが問題になる場合に別途調査する。

以下は修正前にまとめた調査記録。行番号と未実施事項は当時の状態を示し、採用状況・検証結果は上記追記を優先する。

## 当初の調査結論

Arduino IDEのまま回避できる有力な方法がある。インストール済みArduino ESP32コア3.3.10では、`mbedtls_platform_set_calloc_free()`でmbedTLSのアロケータを起動時に差し替え、PSRAMへ直接確保できる。SDK再ビルドもPlatformIO移行も不要。実機の改善効果は未検証だが、このAPIを使用する最小スケッチのコンパイルとリンクは成功した。

同時に、対象コードには相槌タスクのローカル`String`が解放されない問題がある。TLSのnew/deleteだけを原因とするのは早く、リーク修正も必要。

## 確認した環境と検証範囲

- ローカルArduino ESP32コア: `Arduino15/packages/esp32/hardware/esp32/3.3.10`
- ESP32-S3 SDK: `Arduino15/packages/esp32/tools/esp32s3-libs/3.3.10`
- SDKコンパイル定義: ESP-IDF v5.5.4、mbedTLSヘッダー: 3.6.5。
- `qio_qspi/include/sdkconfig.h`: `CONFIG_MBEDTLS_INTERNAL_MEM_ALLOC=1`、`CONFIG_MBEDTLS_SSL_MAX_CONTENT_LEN=16384`。
- `esp_config.h`: `MBEDTLS_PLATFORM_MEMORY`有効、標準calloc/freeはEspressif関数に設定されている。
- 実際の`libmbedcrypto.a`を付属`xtensa-esp32s3-elf-nm.exe`で調べ、`mbedtls_platform_set_calloc_free`の定義と`mbedtls_calloc`経由の参照を確認。
- Arduino IDE付属arduino-cli 1.5.1で最小スケッチをビルド。FQBN: `esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=4M`。正常終了、Flash 540241 bytes、静的RAM 26348 bytes。
- 最小スケッチは`C:/Users/exodj/AppData/Local/Temp/toytalker_tls_psram_probe/toytalker_tls_psram_probe.ino`。hook設定、20KBのmbedTLS確保、外部RAM判定、`mbedtls_ssl_setup()`を含む。ネットワーク接続を行うものではない。
- 実機への書き込み、実機ログの取得、ファーム全体のビルドは実施していない。実機に現在書き込まれたコアの版は別途起動ログで照合すること。
- 対象inoには調査開始前から変更がある。今回の調査で対象inoは編集していない。

## 1. 第一候補: TLSのアロケータをPSRAMに変更

`heap_caps_malloc_extmem_enable(12288)`は通常mallocの振り分け方針を変える。一方、現行SDKのmbedTLS標準アロケータは次のように内部RAMを明示するため、その閾値では変更できない。

```cpp
heap_caps_calloc(n, size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
```

これは「TLSがハードウェア上PSRAMを使えない」という意味ではない。Espressif自身の外部RAM用設定も`MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT`を使用する。[ESP-IDF v5.5.4の実装](https://github.com/espressif/esp-idf/blob/v5.5.4/components/mbedtls/port/esp_mem.c)

今回のビルドでは実行時に関数ポインタを差し替えるAPIが利用できる。`CONFIG_MBEDTLS_CUSTOM_MEM_ALLOC`をスケッチでdefineする必要はない。[mbedTLS 3.6.5の実装](https://github.com/Mbed-TLS/mbedtls/blob/mbedtls-3.6.5/library/platform.c)

追加する関数:

```cpp
#include <esp_heap_caps.h>
#include <mbedtls/platform.h>

static void* tlsPsramCalloc(size_t n, size_t size) {
  return heap_caps_calloc(n, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
}

static void tlsPsramFree(void* p) {
  heap_caps_free(p);
}
```

`setup()`のSerial初期化後、WiFi・HTTPS・WebSocketなどの開始前に一度だけ実行する:

```cpp
if (!psramFound()) {
  Serial.println("[TLS] PSRAM unavailable; initialization stopped");
  while (true) delay(1000);
}
int rc = mbedtls_platform_set_calloc_free(tlsPsramCalloc, tlsPsramFree);
if (rc != 0) {
  Serial.printf("[TLS] allocator setup failed: %d\n", rc);
  while (true) delay(1000);
}
```

注意点:

- mbedTLS全体の設定なので、LambdaだけでなくSonioxや相槌HTTPSにも適用される。接続のたびに切り替えず、起動時に設定して固定する。
- この例は内部RAMへフォールバックしない。大きなTLS確保が内部RAMへ戻ることを避け、PSRAM不足なら明確に失敗させるため。
- 確保はcallocでゼロ初期化し、解放は内部RAMにもPSRAMにも対応する`heap_caps_free`を使う。
- DMA用メモリ、WiFi内部構造、タスクスタック、通常のStringなどがすべてPSRAMに移るわけではない。
- quad PSRAMの帯域・容量を既存の音声リングバッファと共有するため、接続時間、音切れ、PSRAMの最大ブロックも実機で確認する。
- 将来コアを変更する際はAPIとビルド設定を再確認する。ここで実証したのはインストール済み3.3.10。

## 2. コード上のリーク: fetchBackchannelTask

該当箇所: 911〜1017行付近。

関数外側のスコープに`String partial`, `charId`, `url`, `payload`があり、そのスコープを抜ける前に`vTaskDelete(NULL)`を呼んでいる。タスク自己削除はC++の通常のreturnではなく、スタックを巻き戻してローカルオブジェクトのデストラクタを呼ぶ処理ではない。このため、各Stringがヒープに確保したバッファが残る。SSOに収まる短い文字列を除き、少なくともURLや通常のpayloadが該当する。

`HTTPClient http`は既に内側のブロックに置かれており、そのブロックを出るときに破棄される。しかし外側のStringは対象外。`[BC] Free heap after`も、これらがまだ生存している時点の計測。

対策は、HTTP処理だけでなく**ローカルStringを含む処理全体**を通常のヘルパー関数に移し、その関数から戻った後でタスクを終了すること。あるいは全体を内側のスコープで囲み、そのスコープを抜けた後に完了通知・`vTaskDelete`を行う。タスクエントリ自体をreturnさせない。

FreeRTOSはタスク自身が確保した任意のメモリを自動回収しない。タスク削除前にアプリ側で解放する必要がある。[ESP-IDF FreeRTOS](https://docs.espressif.com/projects/esp-idf/en/v5.5.4/esp32s3/api-reference/system/freertos_idf.html#deletion)

これが報告された8〜10ターンの失敗をどの程度説明するかは、修正前後の同一フェーズの計測が必要。リークにより内部RAMの穴が埋まり続けると、freeと最大ブロックの両方に影響し得る。

## 3. 断片化・ピーク使用量を増やす箇所

| 箇所 | 観察 | 対策 |
|---|---|---|
| 1034 / 1178行 | 相槌とLambda接続タスクを毎回16384 bytesのスタック付きで生成 | 常駐タスク＋通知/キューへ変更し、起動時に一度確保。スタック縮小はhigh-water mark実測後 |
| 1178 / 1200行 | タスク生成の戻り値を無視。生成失敗するとsent/failedが変わらず無限待ち | `pdPASS`確認、失敗時に既存エラー復帰経路へ。待ち時間を制限する場合はワーカーと引数の寿命も保証 |
| 1109〜1124行 | 相槌abortの待ち時間を過ぎてもタスクが残り得る。そのままabortフラグを戻す | 終了確認・所有権移譲を確実にする。稼働中タスクを強制削除して済ませない |
| 1145〜1173行 | `messagesJson`, `payload`, `req`に本文のコピーが重複し、関数終了まで生存 | 再利用バッファ、事前reserve、ヘッダーと本文の分割送信。ワーカーの送信終了を同期してから解放 |
| 436 / 175行 | 履歴をString代入でずらす。長寿命の文字列確保がTLSなどと混在 | 履歴をリング構造にし、上限を設けて容量を再利用。必要ならPSRAMの明示バッファへ |
| 862 / 1050行 | 音声変換用最大16KBなどを繰り返しmalloc/free | 起動時にPSRAMの作業領域を確保して再利用。並列利用しないことを確認 |
| 491〜519行 | 再生I2SのDMA設定は8×1024×stereo 16-bit、約32KBのデータ領域 | リングバッファがあるのでDMA深さを段階的に減らす比較実験。音切れ・アンダーランで評価 |
| 1238 / 1274行付近 | Lambdaが残っている間にSonioxのTLS接続を進める | 切り分けでは先行接続を一時無効化。製品ではTLSをPSRAMへ移して並列性を維持する案を優先 |
| 1265行以降 | 正常な受信終了後に明示的なclient.stopがなく、ドレイン・履歴追加・録音再開まで進む | 受信完了直後にstop。既に相手切断を検出してstop済みの場合は効果なしだが、解放時点を明確にできる |

16KBの一時音声バッファについて、通常mallocが実際にどちらのRAMを使うかはArduinoの閾値・空き状況による。「必ず内部RAM」とは断定できない。PSRAM明示＋再利用で予測可能にする。

タスク常駐化はスタックの反復確保をなくすが、常駐分のRAMは消費する。相槌とLambdaを直列化できるなら共通ネットワークワーカーも候補。

## 4. WiFiClientSecureの再利用だけでは不十分

現時点の対象inoは1175行のローカル`WiFiClientSecure client;`を使っている。明示的なnew/deleteという依頼文と少し異なるが、内部のSSLコンテキストは動的確保される。

Arduinoコア3.3.10の`NetworkClientSecure::stop()`は`stop_ssl_socket()`を呼び、そこから`mbedtls_ssl_free()`などでTLSリソースを解放する。したがってclientをstaticやグローバルにしても、切断・再接続時の大きなTLS確保はなくならない。少量のオブジェクト確保削減にはなるが主対策ではない。

また、約40KBというTLS接続全体の使用量と、1回のcallocに必要な連続サイズは区別する。16384 bytesのコンテンツにプロトコルの余裕分などが加わる。`max_blk=17KB`という丸めた値だけで特定の失敗確保サイズを断定しない。

## 5. 追加のメモリ破壊リスク

相槌PCM取得の980〜989行付近で、バッファを一度だけ倍増した後に、`avail`をそのまま`readBytes(pcm + totalRead, avail)`へ渡している。一度の拡張後も`avail > bufSize - totalRead`の場合、書き込みが領域を超える。今回のログで発生した証拠はないが、ヒープ破壊を断片化と取り違えないため、読み取り量を残容量で制限し、応答長の上限も検証する必要がある。

## 6. 実機検証の順番

1. 相槌タスクのStringリークを直し、同じ会話条件でベースラインと比較。
2. TLS PSRAM hookを有効化し、mbedTLSから確保した20KBが`esp_ptr_external_ram()`でtrueになることを確認。実際のTLS割り当て先も必要に応じてカウンタ等で検証。
3. 同一条件で最低50〜100ターン。会話履歴が満杯になった後、内部RAMとPSRAMのfreeが低下し続けないこと、接続失敗・音切れ・遅延を確認。
4. 通常終了、相槌タイムアウト、割り込み発話、ネットワーク切断を別々に確認。
5. まだ内部RAMの最大ブロックが低下するならタスク常駐化、音声作業バッファ固定化、履歴リング化を順に比較。

各ターンで内部RAMとPSRAMの`free / largest_free_block`を、相槌開始前、相槌のString破棄後、I2S切替前後、接続タスク生成前、TLS接続直前、TLS解放後、関数から戻った後の同じフェーズで計測する。自己削除したタスクのスタックはidleタスクによる回収待ちになる場合もある。

`heap_caps_register_failed_alloc_callback()`で失敗した要求のバイト数とcapsを記録すると、TLSなのか16KBスタックなのかを区別できる。コールバック内で動的確保や重いログ処理をせず、固定領域に記録して後で出力する。`heap_caps_check_integrity_all(true)`もフェーズ境界で用いてヒープ破壊を切り分ける。[Espressifのヒープ診断](https://docs.espressif.com/projects/esp-idf/en/stable/esp32s3/api-reference/system/heap_debug.html)

## 採用優先度の低い案

- `setBufferSizes()`は確認したNetworkClientSecureにはない。
- `.ino`で`CONFIG_MBEDTLS_EXTERNAL_MEM_ALLOC`やバッファ長のマクロだけを書き換えても、既にビルドされたSDKライブラリは変わらない。構造体の設定不整合にも注意。
- `client`のグローバル化だけ、接続失敗時の同じ状態での即時リトライだけでは原因を取り除けない。
- 任意の生きたC/C++オブジェクトを移動して内部ヒープを圧縮する汎用APIはない。寿命・確保先・ピーク使用量を管理する。
- keep-aliveは今回の解決策に依存させていない。接続ごとにTLSを作り直す構成で成立する対策。
- 同じモジュール/コア3.3.10で3.3.7との差を報告した[上流issue #12769](https://github.com/espressif/arduino-esp32/issues/12769)もあるが、別アプリの利用者報告であり、本件と同じ原因と確定したものではない。ダウングレードは追加比較候補にとどめる。
