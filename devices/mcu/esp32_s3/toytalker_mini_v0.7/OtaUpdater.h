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
// 失敗しても再起動せず通常動作へ進む。同じ目標版への試行はNVSで数え、MAX_ATTEMPTS回で諦める
// （ロールバックで旧版へ戻った後の再更新ループもこれで止まる）。
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
constexpr uint8_t MAX_ATTEMPTS = 3;
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

// 新版がここまで到達（Wi-Fi接続とLambda到達）したら有効印を付ける。
// これを呼ぶ前に落ちる版はブートローダーが旧版へ戻す（verifyRollbackLater() の上書きが前提）。
inline void confirmRunningImage() {
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

// ---- NVS 試行カウンタ（namespace "ota": ver=目標版, n=回数）----
inline uint8_t loadAttempts(const String& version) {
  Preferences prefs;
  if (!prefs.begin("ota", true)) return 0;
  const String last = prefs.getString("ver", "");
  const uint8_t n = (last == version) ? prefs.getUChar("n", 0) : 0;
  prefs.end();
  return n;
}

inline void storeAttempts(const String& version, uint8_t n) {
  Preferences prefs;
  if (!prefs.begin("ota", false)) return;
  prefs.putString("ver", version);
  prefs.putUChar("n", n);
  prefs.end();
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
  const uint8_t attempts = loadAttempts(m.version);
  if (attempts >= MAX_ATTEMPTS) {
    Serial.printf("[OTA] skip: target=%s attempts=%u reached limit\n", m.version.c_str(), attempts);
    return Result::Skipped;
  }
  storeAttempts(m.version, attempts + 1);  // 途中で電源が落ちても回数が残るよう先に記録
  Serial.printf("[OTA] start: %s -> %s size=%u attempt=%u/%u\n", TOYTALKER_FW_VERSION, m.version.c_str(),
                (unsigned)m.size, attempts + 1, MAX_ATTEMPTS);

  uint8_t* buffer = (uint8_t*)heap_caps_malloc(IO_BUFFER_BYTES, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  if (!buffer) {
    Serial.println("[OTA] fail: io buffer allocation");
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
  Serial.printf("[OTA] done: %s -> %s bytes=%u total_ms=%lu; restarting\n", TOYTALKER_FW_VERSION,
                m.version.c_str(), (unsigned)received, (unsigned long)(millis() - t0));
  Serial.flush();
  delay(200);
  ESP.restart();
  return Result::Failed;  // 到達しない
}

}  // namespace ota
