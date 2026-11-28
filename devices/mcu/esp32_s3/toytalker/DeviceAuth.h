#pragma once
// DeviceAuth.h — デバイス鍵（脅威モデル #2 のなりすまし防止。docs/security-review-2026-10-25.md、ロードマップ6）。
//
// - 初回起動時（Wi-Fi 接続後。RF が動いているので esp_fill_random は真の乱数）に 32 バイトの鍵を作り、NVS の
//   "device" 名前空間に 16 進 64 文字で保存する。以後は読むだけ。Wi-Fi 設定のやり直しでは消えない（"wifi" とは別の名前空間）。
// - Lambda への要求（会話・相槌・Soniox 鍵発行）に KEY_HEADER で添える。Lambda は devices の行にハッシュ（SHA-256）だけを持ち、
//   ハッシュがあれば一致を要求し、無ければ初回を信じて保存する（backend/shared/auth.mjs の deviceKeyCheck）。
// - 鍵は TLS の証明書検証（AmazonRootCA.h）が前提。検証なしでは偽サーバーに鍵が渡る。
// - シリアルにもログにも鍵は出さない（出すのは指紋＝ハッシュの先頭8文字だけ）。
// - NVS を全消去（フラッシュの全消去書き込み）すると鍵が作り直されて Lambda で不一致になる。そのときは devices の
//   その機器の行から device_key_hash を消すと、次の要求で新しい鍵が登録される（docs/esp32-firmware.md）。
//
// スレッド: ensure() は loop()（startNormalOperation）で1回呼ぶ。以後 value() は読むだけなので、ワーカー（Core 0）から呼んでよい。

#include <Arduino.h>
#include <Preferences.h>
#include <esp_random.h>
#include <mbedtls/sha256.h>

namespace device_auth {

/** ヘッダー名（小文字。CloudFront のオリジン要求ポリシーと backend/shared/auth.mjs の DEVICE_KEY_HEADER と同じ） */
static const char* const KEY_HEADER = "x-toytalker-device-key";

static char g_key[65] = {0};

inline bool isValidHex64(const String& s) {
  if (s.length() != 64) return false;
  for (size_t i = 0; i < 64; i++) {
    const char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

/** 鍵を NVS から読み、無ければ作って保存する。成功すれば true（以後 value() が鍵を返す） */
inline bool ensure() {
  if (g_key[0]) return true;
  Preferences prefs;
  if (!prefs.begin("device", false)) {
    Serial.println("[DEVKEY] NVS open failed; requests go without key");
    return false;
  }
  String stored = prefs.getString("auth_key", "");
  bool created = false;
  if (!isValidHex64(stored)) {
    uint8_t raw[32];
    esp_fill_random(raw, sizeof(raw));
    char hex[65];
    for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", raw[i]);
    hex[64] = 0;
    memset(raw, 0, sizeof(raw));
    if (prefs.putString("auth_key", hex) != 64) {
      prefs.end();
      Serial.println("[DEVKEY] NVS write failed; requests go without key");
      return false;
    }
    stored = hex;
    created = true;
  }
  prefs.end();
  memcpy(g_key, stored.c_str(), 64);
  g_key[64] = 0;

  // 指紋（SHA-256 の先頭8文字）。Lambda のログ・devices の device_key_hash の先頭と突き合わせられる
  unsigned char digest[32];
  mbedtls_sha256((const unsigned char*)g_key, 64, digest, 0);
  Serial.printf("[DEVKEY] %s fingerprint=%02x%02x%02x%02x\n", created ? "created" : "loaded",
                digest[0], digest[1], digest[2], digest[3]);
  return true;
}

/** 鍵（16進64文字）。ensure() 前・失敗時は空文字 */
inline const char* value() { return g_key; }
inline bool available() { return g_key[0] != 0; }

}  // namespace device_auth
