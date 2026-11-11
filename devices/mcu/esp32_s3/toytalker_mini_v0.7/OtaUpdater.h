#pragma once
// OtaUpdater.h — 起動時のファーム更新（S3署名付きURLから直接取得）
//
// 呼び出し元は startNormalOperation() のSonioxキー取得直後だけ。録音・WebSocket・AECが
// 動く前に終えるので、会話を止める処理は要らない。設計は docs/esp32-ota-settings-plan.md。
//
// 本体が偽ファームを受け取らないための検証（署名付きURLは誰でもGETできる前提）:
//   1. URLのホストが自分のバケット固定であること
//   2. Amazonのルート証明書で接続先を検証すること（OTAだけ）
//   3. 受信全体のSHA-256がLambdaの応答と一致すること
//   4. Updateライブラリのイメージヘッダ・チップ種別検査
//
// 失敗しても再起動せず通常動作へ進む。失敗は2種類に分けて扱う（2026-11-11）:
//   - ロールバック（入れた版が確認前に落ち、ブートローダーが旧版へ戻した）→ その版は以後試さない。
//     試し続けると「入れる→落ちる→戻る」が永久に続き、会話できなくなるため。次の版が出れば試す。
//   - ダウンロードの失敗（電源断・通信・SHA不一致など）→ 諦めない。ループにならない（そのまま会話へ進む）。
//     ただし弱いWi-Fiで起動のたびに最大3分待たせないよう、続けてBACKOFF_AFTER回失敗したら
//     以後はBACKOFF_EVERY回の起動に1回だけ試す。
// 前回の結果は鍵取得の要求に添えて（queryParams()）、Lambdaの1行ログで見えるようにする。
#include <Arduino.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Update.h>
#include <Preferences.h>
#include <ArduinoJson.h>
#include <esp_ota_ops.h>
#include <esp_heap_caps.h>
#include <mbedtls/sha256.h>
#include "FirmwareVersion.h"
#include "AmazonRootCA.h"

namespace ota {

constexpr const char* ALLOWED_HOST = "toytalker-firmware.s3.ap-northeast-1.amazonaws.com";
constexpr uint8_t BACKOFF_AFTER = 3;   // 続けてこの回数失敗したら間を空ける
constexpr uint8_t BACKOFF_EVERY = 5;   // 間を空けた後は、この回数の起動に1回だけ試す
constexpr size_t MIN_IMAGE_BYTES = 512 * 1024;   // これより小さい "ファーム" は受け付けない
constexpr size_t IO_BUFFER_BYTES = 16 * 1024;    // PSRAM。Update側は4KBセクタ単位で書く
constexpr uint32_t HTTP_TIMEOUT_MS = 15000;      // 接続・応答ヘッダ待ち
constexpr uint32_t STALL_TIMEOUT_MS = 15000;     // データが1バイトも来ない時間の上限
constexpr uint32_t TOTAL_TIMEOUT_MS = 180000;    // 全体の上限（起動を無限に待たせない）

struct Manifest {
  String version;
  String url;
  String sha256;   // 64桁の16進小文字
  size_t size = 0;
};

enum class Result { NoUpdate, Invalid, Skipped, Failed };  // 成功時は再起動するので戻り値なし

inline bool capable() {
  return esp_ota_get_next_update_partition(nullptr) != nullptr;
}

inline const char* runningLabel() {
  const esp_partition_t* p = esp_ota_get_running_partition();
  return p ? p->label : "?";
}

inline size_t updatePartitionSize() {
  const esp_partition_t* p = esp_ota_get_next_update_partition(nullptr);
  return p ? p->size : 0;
}

inline void printBootInfo() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  const esp_partition_t* next = esp_ota_get_next_update_partition(nullptr);
  esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
  if (running) esp_ota_get_state_partition(running, &state);
  Serial.printf("[OTA] fw=%s hw=%s running=%s next=%s capable=%d img_state=%d\n",
                TOYTALKER_FW_VERSION, TOYTALKER_HW_VERSION, running ? running->label : "?",
                next ? next->label : "none", next != nullptr, (int)state);
}

inline void markUpdateSucceeded();  // 下の NVS の節
inline void confirmImageState();

// 新版がここまで到達（Wi-Fi接続とLambda到達）したら有効印を付ける。
// これを呼ぶ前に落ちる版はブートローダーが旧版へ戻す（verifyRollbackLater() の上書きが前提）。
inline void confirmRunningImage() {
  confirmImageState();
  markUpdateSucceeded();  // 入れた版で有効印まで来たら更新の記録を片付ける（入れた版でなければ何もしない）
}

inline void confirmImageState() {
  const esp_partition_t* running = esp_ota_get_running_partition();
  esp_ota_img_states_t state = ESP_OTA_IMG_UNDEFINED;
  if (!running || esp_ota_get_state_partition(running, &state) != ESP_OK) {
    Serial.println("[OTA] confirm: state unavailable");
    return;
  }
  if (state == ESP_OTA_IMG_PENDING_VERIFY) {
    const esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
    Serial.printf("[OTA] confirm: pending_verify -> valid err=%d fw=%s\n", (int)err, TOYTALKER_FW_VERSION);
  } else {
    Serial.printf("[OTA] confirm: img_state=%d (no action)\n", (int)state);
  }
}

// "https://<host>/..." のホスト部を取り出して固定値と比較する。大文字小文字は区別しない。
inline bool hostAllowed(const String& url) {
  const char* prefix = "https://";
  if (!url.startsWith(prefix)) return false;
  const int start = strlen(prefix);
  int end = url.indexOf('/', start);
  if (end < 0) end = url.length();
  String host = url.substring(start, end);
  host.toLowerCase();
  return host == ALLOWED_HOST;
}

inline bool isHex64(const String& s) {
  if (s.length() != 64) return false;
  for (size_t i = 0; i < 64; ++i) {
    const char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

// Lambda応答の firmware オブジェクトを検証して取り出す。失敗理由は reason に入る。
inline bool parseManifest(JsonVariantConst fw, Manifest& out, const char*& reason) {
  if (!fw.is<JsonObjectConst>()) { reason = "not_object"; return false; }
  out.version = fw["version"] | "";
  out.url = fw["url"] | "";
  out.sha256 = fw["sha256"] | "";
  out.size = fw["size"] | 0;
  out.sha256.toLowerCase();
  if (out.version.isEmpty() || out.version.length() > 32) { reason = "version"; return false; }
  if (out.url.isEmpty() || out.url.length() > 4096)       { reason = "url"; return false; }
  if (!isHex64(out.sha256))                                { reason = "sha256"; return false; }
  if (out.size < MIN_IMAGE_BYTES)                          { reason = "size_small"; return false; }
  return true;
}

// ---- NVS（namespace "ota"）----
//   ver   : 失敗を数えている目標版        fails : その版で続けて失敗した回数（開始前に足すので電源断も数える）
//   skip  : 間を空ける残りの起動回数      last  : 前回の試行の結果（started / 失敗の段階 / rollback）
//   pend  : 入れて再起動した版（次の起動で確かめる）
//   bad   : ロールバックした版（以後試さない）
struct State {
  String ver, last, pend, bad;
  uint8_t fails = 0, skip = 0;
};

inline State loadState() {
  State st;
  Preferences prefs;
  if (!prefs.begin("ota", true)) return st;
  st.ver = prefs.getString("ver", "");
  st.fails = prefs.getUChar("fails", 0);
  st.skip = prefs.getUChar("skip", 0);
  st.last = prefs.getString("last", "");
  st.pend = prefs.getString("pend", "");
  st.bad = prefs.getString("bad", "");
  prefs.end();
  return st;
}

inline void saveState(const State& st) {
  Preferences prefs;
  if (!prefs.begin("ota", false)) return;
  prefs.putString("ver", st.ver);
  prefs.putUChar("fails", st.fails);
  prefs.putUChar("skip", st.skip);
  prefs.putString("last", st.last);
  prefs.putString("pend", st.pend);
  prefs.putString("bad", st.bad);
  prefs.remove("n");  // 0.7.11 までの試行カウンタ（上限3回で諦める方式）
  prefs.end();
}

// 起動ごとに1回（setup() で）。入れた版と違う版で動いていればロールバックで戻っている。
// 入れた版で動いていても、ここでは成功とみなさない。有効印の前に落ちる版もこの時点では動いているので、
// ここで記録を消すと戻った後にロールバックと分からず、入れ直しを永久に繰り返す（2026-11-11 の試験で起きた）。
// 成功の判定は有効印を付けた時（markUpdateSucceeded()）。
inline void checkPreviousUpdate() {
  State st = loadState();
  if (st.pend.isEmpty()) return;
  if (st.pend == TOYTALKER_FW_VERSION) {
    Serial.printf("[OTA] booted into %s; waiting for confirm\n", st.pend.c_str());
    return;
  }
  // 入れた版が有効印の前に落ちた（または確認前に電源が切れた）。その版は以後試さない
  Serial.printf("[OTA] rollback detected: target=%s running=%s; will not retry this version\n",
                st.pend.c_str(), TOYTALKER_FW_VERSION);
  st.bad = st.pend;
  st.last = "rollback";
  st.pend = "";
  saveState(st);
}

// 有効印を付けた後に呼ぶ。入れた版が鍵の取得まで来たので、更新の記録を片付ける
inline void markUpdateSucceeded() {
  State st = loadState();
  if (st.pend.isEmpty() || st.pend != TOYTALKER_FW_VERSION) return;
  Serial.printf("[OTA] update to %s succeeded\n", st.pend.c_str());
  st.pend = ""; st.ver = ""; st.fails = 0; st.skip = 0; st.last = "";
  saveState(st);
}

// 鍵取得の要求に添える前回の結果（空なら何も付けない）。値は決まった語と版だけ
inline String queryParams() {
  const State st = loadState();
  String q;
  if (!st.last.isEmpty()) q += "&ota_last=" + st.last;
  if (st.fails > 0) q += "&ota_fails=" + String(st.fails);
  if (!st.bad.isEmpty()) q += "&ota_bad=" + st.bad;
  return q;
}

inline void toHex(const uint8_t* bytes, size_t len, char* out) {
  static const char* digits = "0123456789abcdef";
  for (size_t i = 0; i < len; ++i) {
    out[i * 2] = digits[bytes[i] >> 4];
    out[i * 2 + 1] = digits[bytes[i] & 0x0F];
  }
  out[len * 2] = '\0';
}

// 更新を実行する。成功時は再起動して戻らない。失敗時は理由をログに出して戻る。
inline Result apply(const Manifest& m) {
  if (m.version == TOYTALKER_FW_VERSION) {
    Serial.printf("[OTA] target=%s equals running; no update\n", m.version.c_str());
    return Result::NoUpdate;
  }
  if (!capable()) {
    Serial.println("[OTA] skip: no OTA partition (flashed with a non-OTA scheme)");
    return Result::Skipped;
  }
  if (!hostAllowed(m.url)) {
    Serial.println("[OTA] reject: url host is not the firmware bucket");
    return Result::Invalid;
  }
  const size_t partitionSize = updatePartitionSize();
  if (m.size > partitionSize) {
    Serial.printf("[OTA] reject: size=%u exceeds partition=%u\n", (unsigned)m.size, (unsigned)partitionSize);
    return Result::Invalid;
  }
  State st = loadState();
  if (m.version == st.bad) {
    Serial.printf("[OTA] skip: target=%s rolled back before\n", m.version.c_str());
    return Result::Skipped;
  }
  if (st.ver != m.version) { st.ver = m.version; st.fails = 0; st.skip = 0; }
  if (st.skip > 0) {
    st.skip--;
    saveState(st);
    Serial.printf("[OTA] backoff: target=%s fails=%u next_try_in_boots=%u\n", m.version.c_str(),
                  st.fails, st.skip + 1);
    return Result::Skipped;
  }
  // 途中で電源が落ちても数えるよう先に記録する（次の起動で last=started が残っていれば中断）
  st.fails++;
  if (st.fails >= BACKOFF_AFTER) st.skip = BACKOFF_EVERY - 1;
  st.last = "started";
  saveState(st);
  Serial.printf("[OTA] start: %s -> %s size=%u try=%u\n", TOYTALKER_FW_VERSION, m.version.c_str(),
                (unsigned)m.size, st.fails);

  uint8_t* buffer = (uint8_t*)heap_caps_malloc(IO_BUFFER_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!buffer) {
    Serial.println("[OTA] fail: io buffer allocation");
    st.last = "alloc";
    saveState(st);
    return Result::Failed;
  }

  const uint32_t t0 = millis();
  WiFiClientSecure client;
  client.setCACert(AMAZON_ROOT_CAS);
  client.setHandshakeTimeout(HTTP_TIMEOUT_MS / 1000);
  HTTPClient http;
  http.setReuse(false);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setUserAgent(String("toytalker-ota/") + TOYTALKER_FW_VERSION);

  auto fail = [&](const char* stage, int detail) -> Result {
    Serial.printf("[OTA] fail: stage=%s detail=%d received_ms=%lu update_err=%s\n", stage, detail,
                  (unsigned long)(millis() - t0), Update.hasError() ? Update.errorString() : "-");
    if (Update.isRunning()) Update.abort();
    http.end();
    heap_caps_free(buffer);
    State failed = loadState();
    failed.last = stage;
    saveState(failed);
    return Result::Failed;
  };

  if (!http.begin(client, m.url)) return fail("begin", 0);
  const int code = http.GET();
  if (code != HTTP_CODE_OK) return fail("http_get", code);
  const int contentLength = http.getSize();
  if (contentLength != (int)m.size) return fail("content_length", contentLength);
  Serial.printf("[OTA] connected: tls_and_headers_ms=%lu\n", (unsigned long)(millis() - t0));

  if (!Update.begin(m.size, U_FLASH)) return fail("update_begin", 0);

  mbedtls_sha256_context sha;
  mbedtls_sha256_init(&sha);
  mbedtls_sha256_starts(&sha, 0);

  WiFiClient* stream = http.getStreamPtr();
  size_t received = 0;
  uint32_t lastDataMs = millis();
  uint8_t nextProgressPct = 10;
  while (received < m.size) {
    const uint32_t now = millis();
    if (now - t0 > TOTAL_TIMEOUT_MS) { mbedtls_sha256_free(&sha); return fail("total_timeout", (int)received); }
    if (now - lastDataMs > STALL_TIMEOUT_MS) { mbedtls_sha256_free(&sha); return fail("stall", (int)received); }
    const int avail = stream->available();
    if (avail <= 0) {
      if (!stream->connected()) { mbedtls_sha256_free(&sha); return fail("disconnected", (int)received); }
      delay(1);
      continue;
    }
    const size_t want = (size_t)avail < IO_BUFFER_BYTES ? (size_t)avail : IO_BUFFER_BYTES;
    const size_t remaining = m.size - received;
    const int n = stream->read(buffer, want < remaining ? want : remaining);
    if (n <= 0) { delay(1); continue; }
    mbedtls_sha256_update(&sha, buffer, n);
    const size_t written = Update.write(buffer, n);
    if (written != (size_t)n) { mbedtls_sha256_free(&sha); return fail("flash_write", (int)written); }
    received += n;
    lastDataMs = millis();
    const uint8_t pct = (uint8_t)((uint64_t)received * 100 / m.size);
    if (pct >= nextProgressPct) {
      Serial.printf("[OTA] progress=%u%% bytes=%u elapsed_ms=%lu\n", pct, (unsigned)received,
                    (unsigned long)(millis() - t0));
      nextProgressPct += 10;
    }
  }

  uint8_t digest[32];
  mbedtls_sha256_finish(&sha, digest);
  mbedtls_sha256_free(&sha);
  char hex[65];
  toHex(digest, sizeof(digest), hex);
  if (m.sha256 != hex) {
    Serial.printf("[OTA] sha256 mismatch expected=%s got=%s\n", m.sha256.c_str(), hex);
    return fail("sha256", 0);
  }

  // SHA一致を確認してから Update.end() へ。ここでイメージ検査と起動パーティション切替が行われる。
  if (!Update.end()) return fail("update_end", 0);

  http.end();
  heap_caps_free(buffer);
  st = loadState();
  st.pend = m.version;  // 次の起動でこの版が動いていれば成功、旧版ならロールバック
  st.last = "installed";
  saveState(st);
  Serial.printf("[OTA] done: %s -> %s bytes=%u total_ms=%lu; restarting\n", TOYTALKER_FW_VERSION,
                m.version.c_str(), (unsigned)received, (unsigned long)(millis() - t0));
  Serial.flush();
  delay(200);
  ESP.restart();
  return Result::Failed;  // 到達しない
}

}  // namespace ota
