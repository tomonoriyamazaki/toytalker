#pragma once
// VoiceSync.h — アプリで足した声（ボイスキーホルダーモードの voices.bin）を S3 から取って、voices 区画に入れ替える（0.7.33）。
//
// 流れ: 起動時の鍵取得で、いま入っているイメージの印（voicekey::installedTag）を vk で名乗る。
// サーバー側の声（アプリの一覧から組んだイメージ）と違えば、Lambda が応答に voices { url, sha256, size } を入れる。
// 本体は全部を PSRAM に受けてから SHA-256 と入れ物の形（TTVK・CRC）を確かめ、合っていれば区画を消して書く。
// 受け取りに失敗しても、区画は前の声のまま（次の起動でまた勧められる）。書いている途中で電源が切れたら声なしになり、
// 次の起動で取り直す（先頭の 16 バイトを最後に書くので、途中のものを「入っている」と名乗ることは無い）。
// キーホルダーモードの間は Wi-Fi を使わないので、入れ替わるのは会話モードで起動した時だけ。
#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <esp_heap_caps.h>
#include <esp_partition.h>
#include <mbedtls/sha256.h>
#include "FirmwareVersion.h"
#include "OtaUpdater.h"      // ホストの確かめ・16進・ルート証明書は OTA と同じもの
#include "VoiceKeyholder.h"

namespace voicesync {

constexpr uint32_t HTTP_TIMEOUT_MS = 15000;    // 接続・応答ヘッダ待ち
constexpr uint32_t STALL_TIMEOUT_MS = 15000;   // データが1バイトも来ない時間の上限
constexpr uint32_t TOTAL_TIMEOUT_MS = 60000;   // 全体の上限（最大でも 384KB）
constexpr size_t WRITE_CHUNK_BYTES = 4096;     // フラッシュへは内蔵 RAM のバッファを経て書く

struct Offer {
  String url;
  String sha256;   // 64桁の16進小文字
  size_t size = 0;
};

// Lambda 応答の voices オブジェクトを検証して取り出す。失敗理由は reason に入る
inline bool parseOffer(JsonVariantConst v, Offer& out, const char*& reason) {
  if (!v.is<JsonObjectConst>()) { reason = "not_object"; return false; }
  out.url = v["url"] | "";
  out.sha256 = v["sha256"] | "";
  out.size = v["size"] | 0;
  out.sha256.toLowerCase();
  if (out.url.isEmpty() || out.url.length() > 4096) { reason = "url"; return false; }
  if (!ota::isHex64(out.sha256))                    { reason = "sha256"; return false; }
  if (out.size < voicekey::HEADER_BYTES)            { reason = "size_small"; return false; }
  return true;
}

// 入れ物として正しいか（先頭・版・大きさ・CRC）。0 件のイメージ（アプリで全部消した）も正しい
inline bool imageValid(const uint8_t* image, size_t size) {
  if (size < voicekey::HEADER_BYTES || memcmp(image, "TTVK", 4) != 0 || image[4] != voicekey::FORMAT_VERSION) return false;
  if (voicekey::readU32(image + 8) != size) return false;
  return voicekey::crc32(image + voicekey::HEADER_BYTES, size - voicekey::HEADER_BYTES) == voicekey::readU32(image + 12);
}

// from から len バイトを区画の offset へ書く（元は PSRAM なので、内蔵 RAM のバッファへ写してから）
inline bool writeRange(const esp_partition_t* part, size_t offset, const uint8_t* from, size_t len, uint8_t* bounce) {
  for (size_t done = 0; done < len;) {
    const size_t n = (len - done) < WRITE_CHUNK_BYTES ? (len - done) : WRITE_CHUNK_BYTES;
    memcpy(bounce, from + done, n);
    if (esp_partition_write(part, offset + done, bounce, n) != ESP_OK) return false;
    done += n;
  }
  return true;
}

// 声を入れ替える。入れ替えたら true。失敗したら理由をログに出して false（区画は、書き始める前なら前のまま）
inline bool apply(const Offer& o) {
  const esp_partition_t* part =
    esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "voices");
  if (!part) { Serial.println("[VOICES] skip: no voices partition"); return false; }
  if (o.size > part->size) {
    Serial.printf("[VOICES] reject: size=%u exceeds partition=%u\n", (unsigned)o.size, (unsigned)part->size);
    return false;
  }
  if (!ota::hostAllowed(o.url)) { Serial.println("[VOICES] reject: url host is not the firmware bucket"); return false; }

  uint8_t* image = (uint8_t*)heap_caps_malloc(o.size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  uint8_t* bounce = (uint8_t*)heap_caps_malloc(WRITE_CHUNK_BYTES, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const uint32_t t0 = millis();
  WiFiClientSecure client;
  client.setCACert(AMAZON_ROOT_CAS);
  client.setHandshakeTimeout(HTTP_TIMEOUT_MS / 1000);
  HTTPClient http;
  http.setReuse(false);
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.setUserAgent(String("toytalker-voices/") + TOYTALKER_FW_VERSION);

  auto fail = [&](const char* stage, int detail) -> bool {
    Serial.printf("[VOICES] fail: stage=%s detail=%d ms=%lu\n", stage, detail, (unsigned long)(millis() - t0));
    http.end();
    if (image) heap_caps_free(image);
    if (bounce) heap_caps_free(bounce);
    return false;
  };
  if (!image || !bounce) return fail("alloc", (int)o.size);

  Serial.printf("[VOICES] start: size=%u\n", (unsigned)o.size);
  if (!http.begin(client, o.url)) return fail("begin", 0);
  const int code = http.GET();
  if (code != HTTP_CODE_OK) return fail("http_get", code);
  if (http.getSize() != (int)o.size) return fail("content_length", http.getSize());

  WiFiClient* stream = http.getStreamPtr();
  size_t received = 0;
  uint32_t lastDataMs = millis();
  while (received < o.size) {
    const uint32_t now = millis();
    if (now - t0 > TOTAL_TIMEOUT_MS) return fail("total_timeout", (int)received);
    if (now - lastDataMs > STALL_TIMEOUT_MS) return fail("stall", (int)received);
    const int avail = stream->available();
    if (avail <= 0) {
      if (!stream->connected()) return fail("disconnected", (int)received);
      delay(1);
      continue;
    }
    const size_t remaining = o.size - received;
    const int n = stream->read(image + received, (size_t)avail < remaining ? (size_t)avail : remaining);
    if (n <= 0) { delay(1); continue; }
    received += n;
    lastDataMs = millis();
  }
  http.end();
  const uint32_t downloadMs = millis() - t0;

  uint8_t digest[32];
  mbedtls_sha256(image, o.size, digest, 0);
  char hex[65];
  ota::toHex(digest, sizeof(digest), hex);
  if (o.sha256 != hex) {
    Serial.printf("[VOICES] sha256 mismatch expected=%s got=%s\n", o.sha256.c_str(), hex);
    return fail("sha256", 0);
  }
  if (!imageValid(image, o.size)) return fail("image_invalid", 0);

  // ここから区画を書き換える。先頭の 16 バイト（TTVK と CRC）は最後に書く
  const size_t eraseBytes = (o.size + 4095) & ~(size_t)4095;
  if (esp_partition_erase_range(part, 0, eraseBytes) != ESP_OK) return fail("erase", (int)eraseBytes);
  if (!writeRange(part, voicekey::HEADER_BYTES, image + voicekey::HEADER_BYTES, o.size - voicekey::HEADER_BYTES, bounce)) {
    return fail("flash_write", 0);
  }
  if (!writeRange(part, 0, image, voicekey::HEADER_BYTES, bounce)) return fail("flash_write_header", 0);

  Serial.printf("[VOICES] done: clips=%u bytes=%u download_ms=%lu total_ms=%lu\n", (unsigned)image[5], (unsigned)o.size,
                (unsigned long)downloadMs, (unsigned long)(millis() - t0));
  heap_caps_free(image);
  heap_caps_free(bounce);
  return true;
}

}  // namespace voicesync
