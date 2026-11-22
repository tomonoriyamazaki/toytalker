#pragma once
// SetupCrypto.h — SoftAP 設定の「土台」: アプリと本体がその場かぎりの鍵を交換し、送る中身を暗号にする（ロードマップ45）。
//
// 親機のパスワードは全機共通で守りにならないので、家の Wi-Fi のパスワードはこの暗号で包んで受け取る。
// 防げるのは「電波をのぞいて読む」まで。偽の親機や、設定モードの本体へ他人がつなぐことは防げない
// （本体ごとの設定コードを鍵に混ぜる「強化」で防ぐ。その時は deriveKeys の psk に入れる）。
//
// 決まり（アプリ側は app/lib/setupCrypto.ts。両方を同じに保つ。app/scripts/setup-crypto-vectors.mjs の値で突き合わせる）:
//   1. アプリ → POST /kx  pub=<アプリの X25519 公開鍵 32 バイトの hex>
//      本体  → {"v":1,"sid":"<8 バイト hex>","pub":"<本体の公開鍵 hex>","confirm":"<32 バイト hex>"}
//   2. 共有値 = X25519(自分の秘密鍵, 相手の公開鍵)。全部 0 なら断る。
//      鍵 96 バイト = HKDF-SHA256(ikm = 共有値 || psk, salt = アプリ公開鍵 || 本体公開鍵, info = "toytalker-setup-v1")
//        [0..32)  アプリ → 本体の AES-256-GCM の鍵
//        [32..64) 本体 → アプリの鍵（いまは使っていない。保護者用の鍵を渡す時に使う）
//        [64..96) 確認用。confirm = HMAC-SHA256(確認用の鍵, "toytalker-setup-v1 device" || sid)
//   3. 暗号文 = AES-256-GCM(鍵, nonce = 0x00 ×4 || 通し番号 8 バイト big-endian, aad = <用途の名前> || sid)。
//      送る形は 暗号文 || タグ 16 バイト の hex。通し番号は 1 から。本体は前より大きい番号しか受けない（同じ文の送り直しを断る）。
//   鍵は 1 回の設定かぎり。/kx のたびに作り直し、SESSION_TTL_MS で捨てる。本体の秘密鍵は鍵を作ったらすぐ消す。
//
// Espressif の Unified Provisioning の Security 1（X25519 ＋本体ごとの秘密）と同じ考え方で、通信の形は合わせていない。
// 違いは、暗号を改ざんの分かる GCM にしたこと（Security 1 は AES-CTR で、途中で書き換えられても分からない）。

#include <Arduino.h>
#include <esp_random.h>
#include <mbedtls/ecp.h>
#include <mbedtls/ecdh.h>
#include <mbedtls/bignum.h>
#include <mbedtls/hkdf.h>
#include <mbedtls/md.h>
#include <mbedtls/gcm.h>
#include <mbedtls/platform_util.h>

namespace setupcrypto {

static const size_t KEY_LEN = 32;
static const size_t SID_LEN = 8;
static const size_t TAG_LEN = 16;
static const uint32_t SESSION_TTL_MS = 5UL * 60UL * 1000UL;
static const char PROTOCOL[] = "toytalker-setup-v1";
static const char CONFIRM_LABEL[] = "toytalker-setup-v1 device";

struct Session {
  bool valid = false;
  uint32_t createdMs = 0;
  uint64_t lastSeq = 0;
  uint8_t sid[SID_LEN];
  uint8_t keyAppToDev[KEY_LEN];
  uint8_t keyDevToApp[KEY_LEN];
  uint8_t keyConfirm[KEY_LEN];
};

static Session g_session;

inline void clearSession() {
  mbedtls_platform_zeroize(&g_session, sizeof(g_session));
  g_session.valid = false;
}

// ---- hex ----
inline int hexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return c - 'a' + 10;
  if (c >= 'A' && c <= 'F') return c - 'A' + 10;
  return -1;
}

/** hex を outLen バイトちょうどに戻す。長さか文字が合わなければ false */
inline bool hexDecode(const String& hex, uint8_t* out, size_t outLen) {
  if (hex.length() != outLen * 2) return false;
  for (size_t i = 0; i < outLen; i++) {
    const int hi = hexNibble(hex[i * 2]), lo = hexNibble(hex[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = (uint8_t)((hi << 4) | lo);
  }
  return true;
}

inline String hexEncode(const uint8_t* data, size_t len) {
  static const char DIGITS[] = "0123456789abcdef";
  String s;
  s.reserve(len * 2);
  for (size_t i = 0; i < len; i++) {
    s += DIGITS[data[i] >> 4];
    s += DIGITS[data[i] & 0x0f];
  }
  return s;
}

/** mbedTLS に渡す乱数。無線が動いている間の esp_fill_random は真の乱数（設定モードは親機が動いている） */
inline int rng(void*, unsigned char* out, size_t len) {
  esp_fill_random(out, len);
  return 0;
}

// ---- X25519（鍵は RFC 7748 の並び = little-endian の 32 バイト） ----

/** 公開鍵 = priv × 基点。priv は乱数 32 バイトのままでよい（中で決まりの形に整える） */
inline bool x25519Public(const uint8_t priv[32], uint8_t pub[32]) {
  mbedtls_ecp_group grp;
  mbedtls_mpi d;
  mbedtls_ecp_point q;
  mbedtls_ecp_group_init(&grp);
  mbedtls_mpi_init(&d);
  mbedtls_ecp_point_init(&q);
  size_t olen = 0;
  uint8_t k[32];
  memcpy(k, priv, 32);
  k[0] &= 248;
  k[31] &= 127;
  k[31] |= 64;
  const bool done = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_CURVE25519) == 0
                    && mbedtls_mpi_read_binary_le(&d, k, 32) == 0
                    && mbedtls_ecp_mul(&grp, &q, &d, &grp.G, rng, nullptr) == 0
                    && mbedtls_ecp_point_write_binary(&grp, &q, MBEDTLS_ECP_PF_UNCOMPRESSED, &olen, pub, 32) == 0
                    && olen == 32;
  mbedtls_platform_zeroize(k, sizeof(k));
  mbedtls_ecp_point_free(&q);
  mbedtls_mpi_free(&d);
  mbedtls_ecp_group_free(&grp);
  return done;
}

/** 共有値 = priv × 相手の公開鍵。全部 0（相手が弱い点を送ってきた）なら false */
inline bool x25519Shared(const uint8_t priv[32], const uint8_t peerPub[32], uint8_t shared[32]) {
  mbedtls_ecp_group grp;
  mbedtls_mpi d;
  mbedtls_ecp_point peer, result;
  mbedtls_ecp_group_init(&grp);
  mbedtls_mpi_init(&d);
  mbedtls_ecp_point_init(&peer);
  mbedtls_ecp_point_init(&result);
  uint8_t k[32];
  memcpy(k, priv, 32);
  k[0] &= 248;
  k[31] &= 127;
  k[31] |= 64;
  size_t olen = 0;
  bool ok = mbedtls_ecp_group_load(&grp, MBEDTLS_ECP_DP_CURVE25519) == 0
            && mbedtls_mpi_read_binary_le(&d, k, 32) == 0
            && mbedtls_ecp_point_read_binary(&grp, &peer, peerPub, 32) == 0
            && mbedtls_ecp_mul(&grp, &result, &d, &peer, rng, nullptr) == 0
            && mbedtls_ecp_point_write_binary(&grp, &result, MBEDTLS_ECP_PF_UNCOMPRESSED, &olen, shared, 32) == 0
            && olen == 32;
  if (ok) {
    uint8_t acc = 0;
    for (size_t i = 0; i < 32; i++) acc |= shared[i];
    if (acc == 0) ok = false;
  }
  mbedtls_platform_zeroize(k, sizeof(k));
  mbedtls_ecp_point_free(&result);
  mbedtls_ecp_point_free(&peer);
  mbedtls_mpi_free(&d);
  mbedtls_ecp_group_free(&grp);
  return ok;
}

/** 共有値から 3 本の鍵を作る。psk は本体ごとの設定コード（「強化」で入れる。いまは nullptr / 0） */
inline bool deriveKeys(const uint8_t shared[32], const uint8_t appPub[32], const uint8_t devPub[32],
                       const uint8_t* psk, size_t pskLen, uint8_t out[KEY_LEN * 3]) {
  if (pskLen > 64) return false;
  uint8_t ikm[32 + 64];
  uint8_t salt[64];
  memcpy(ikm, shared, 32);
  if (pskLen) memcpy(ikm + 32, psk, pskLen);
  memcpy(salt, appPub, 32);
  memcpy(salt + 32, devPub, 32);
  const int r = mbedtls_hkdf(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), salt, sizeof(salt), ikm, 32 + pskLen,
                             (const uint8_t*)PROTOCOL, strlen(PROTOCOL), out, KEY_LEN * 3);
  mbedtls_platform_zeroize(ikm, sizeof(ikm));
  return r == 0;
}

inline bool confirmTag(const uint8_t keyConfirm[KEY_LEN], const uint8_t sid[SID_LEN], uint8_t out[32]) {
  uint8_t msg[sizeof(CONFIRM_LABEL) - 1 + SID_LEN];
  memcpy(msg, CONFIRM_LABEL, sizeof(CONFIRM_LABEL) - 1);
  memcpy(msg + sizeof(CONFIRM_LABEL) - 1, sid, SID_LEN);
  return mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), keyConfirm, KEY_LEN, msg, sizeof(msg), out) == 0;
}

/** AES-256-GCM を開く。in は 暗号文 || タグ。out は inLen - TAG_LEN バイト。改ざん・鍵違いなら false */
inline bool gcmOpen(const uint8_t key[KEY_LEN], uint64_t seq, const uint8_t* aad, size_t aadLen,
                    const uint8_t* in, size_t inLen, uint8_t* out) {
  if (inLen < TAG_LEN) return false;
  uint8_t nonce[12] = {0};
  for (int i = 0; i < 8; i++) nonce[4 + i] = (uint8_t)(seq >> (56 - 8 * i));
  mbedtls_gcm_context gcm;
  mbedtls_gcm_init(&gcm);
  const size_t ctLen = inLen - TAG_LEN;
  const bool ok = mbedtls_gcm_setkey(&gcm, MBEDTLS_CIPHER_ID_AES, key, KEY_LEN * 8) == 0
                  && mbedtls_gcm_auth_decrypt(&gcm, ctLen, nonce, sizeof(nonce), aad, aadLen, in + ctLen, TAG_LEN, in, out) == 0;
  mbedtls_gcm_free(&gcm);
  return ok;
}

// ---- 1 回の設定の鍵 ----

/**
 * アプリの公開鍵（hex）から鍵を作り、本体の公開鍵・sid・確認の値を返す。前の鍵は捨てる。
 * 失敗したら false（公開鍵の形が違う、弱い点、暗号の部品の失敗）
 */
inline bool startSession(const String& appPubHex, String& sidHex, String& devPubHex, String& confirmHex) {
  clearSession();
  uint8_t appPub[32], priv[32], devPub[32], shared[32], keys[KEY_LEN * 3], tag[32];
  if (!hexDecode(appPubHex, appPub, 32)) return false;
  esp_fill_random(priv, sizeof(priv));
  bool ok = x25519Public(priv, devPub) && x25519Shared(priv, appPub, shared)
            && deriveKeys(shared, appPub, devPub, nullptr, 0, keys);
  mbedtls_platform_zeroize(priv, sizeof(priv));
  mbedtls_platform_zeroize(shared, sizeof(shared));
  if (ok) {
    esp_fill_random(g_session.sid, SID_LEN);
    memcpy(g_session.keyAppToDev, keys, KEY_LEN);
    memcpy(g_session.keyDevToApp, keys + KEY_LEN, KEY_LEN);
    memcpy(g_session.keyConfirm, keys + KEY_LEN * 2, KEY_LEN);
    ok = confirmTag(g_session.keyConfirm, g_session.sid, tag);
  }
  mbedtls_platform_zeroize(keys, sizeof(keys));
  if (!ok) {
    clearSession();
    return false;
  }
  g_session.lastSeq = 0;
  g_session.createdMs = millis();
  g_session.valid = true;
  sidHex = hexEncode(g_session.sid, SID_LEN);
  devPubHex = hexEncode(devPub, 32);
  confirmHex = hexEncode(tag, sizeof(tag));
  return true;
}

enum class OpenResult : uint8_t { Ok, NoSession, BadFormat, Replay, BadTag };

/**
 * アプリからの暗号文（hex）を開く。purpose は用途の名前（"save" など。別の用途の文を使い回せないようにする）。
 * out には outLen バイトちょうどが入る（中身の長さは用途ごとに固定。長さから中身を推し量れないようにする）
 */
inline OpenResult openFromApp(const char* purpose, const String& sidHex, uint64_t seq, const String& boxHex,
                              uint8_t* out, size_t outLen) {
  if (g_session.valid && millis() - g_session.createdMs > SESSION_TTL_MS) clearSession();
  if (!g_session.valid) return OpenResult::NoSession;
  uint8_t sid[SID_LEN];
  if (!hexDecode(sidHex, sid, SID_LEN) || memcmp(sid, g_session.sid, SID_LEN) != 0) return OpenResult::NoSession;
  static const size_t MAX_BOX = 256;
  const size_t boxLen = outLen + TAG_LEN;
  uint8_t box[MAX_BOX];
  if (boxLen > MAX_BOX || !hexDecode(boxHex, box, boxLen)) return OpenResult::BadFormat;
  if (seq == 0 || seq <= g_session.lastSeq) return OpenResult::Replay;
  uint8_t aad[32 + SID_LEN];
  const size_t purposeLen = strlen(purpose);
  if (purposeLen > 32) return OpenResult::BadFormat;
  memcpy(aad, purpose, purposeLen);
  memcpy(aad + purposeLen, g_session.sid, SID_LEN);
  if (!gcmOpen(g_session.keyAppToDev, seq, aad, purposeLen + SID_LEN, box, boxLen, out)) return OpenResult::BadTag;
  g_session.lastSeq = seq;  // 本物と確かめられた番号だけ進める
  return OpenResult::Ok;
}

inline const char* openResultName(OpenResult r) {
  switch (r) {
    case OpenResult::Ok: return "ok";
    case OpenResult::NoSession: return "no_session";
    case OpenResult::BadFormat: return "bad_format";
    case OpenResult::Replay: return "replay";
    default: return "bad_tag";
  }
}

/**
 * 起動時などに呼べる自己点検（RFC 7748 6.1 と、app/scripts/setup-crypto-vectors.mjs がアプリ側の部品で作った値）。
 * 本体とアプリの計算が合っているかを実機で確かめる。シリアルに結果を出し、全部合えば true
 */
inline bool selfTest() {
  // RFC 7748 6.1: Alice の秘密鍵 / 公開鍵、Bob の公開鍵、共有値
  static const char A_PRIV[] = "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a";
  static const char A_PUB[] = "8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a";
  static const char B_PUB[] = "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f";
  static const char SHARED[] = "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742";
  // ここから下は app/scripts/setup-crypto-vectors.mjs の出力（アプリ = A、本体 = B、sid = 0102030405060708、seq = 1、用途 "save"）
  static const char V_KEY_A2D[] = "8f044194b27703cf8b9df8e14b282284a435f77767a359e908713e3b82cca44a";
  static const char V_CONFIRM[] = "2d562dfe883c04f8b296ee3f1fad382740cf67f74c8ead5c2eca7dec0eecdcc6";
  static const char V_BOX[] = "955074a038d79961dd7e62525d28c9cf95ca61e170fbe9af9191529ecc0fd8e3664c3aac450044656c0cf81fe143fbc4c38cb9a671238aa37a365cc60e4ebb7e9dbca816aa7ba88ba8ec1f7d0ae58d9129062c819ee86b11021ba5c31fea45162031d1c7259c8a7467ca7d69fbd20b5be59b";
  static const char V_PLAIN[] = "12e38386e382b9e38388e381ae2057692d466900000000000000000000000000001c636f727265637420686f727365206261747465727920737461706c65000000000000000000000000000000000000000000000000000000000000000000000000";

  uint8_t aPriv[32], aPub[32], bPub[32], want[32], got[32], keys[KEY_LEN * 3], tag[32];
  hexDecode(A_PRIV, aPriv, 32);
  hexDecode(A_PUB, aPub, 32);
  hexDecode(B_PUB, bPub, 32);
  hexDecode(SHARED, want, 32);
  const uint32_t t0 = micros();
  const bool pubOk = x25519Public(aPriv, got) && memcmp(got, aPub, 32) == 0;
  const uint32_t t1 = micros();
  const bool sharedOk = x25519Shared(aPriv, bPub, got) && memcmp(got, want, 32) == 0;
  const uint32_t t2 = micros();
  uint8_t zero[32] = {0}, tmp[32];
  const bool zeroRejected = !x25519Shared(aPriv, zero, tmp);

  const uint8_t sid[SID_LEN] = {1, 2, 3, 4, 5, 6, 7, 8};
  bool kdfOk = deriveKeys(want, aPub, bPub, nullptr, 0, keys) && hexEncode(keys, KEY_LEN) == V_KEY_A2D;
  bool confirmOk = confirmTag(keys + KEY_LEN * 2, sid, tag) && hexEncode(tag, 32) == V_CONFIRM;

  const size_t boxLen = strlen(V_BOX) / 2;
  uint8_t box[256], plain[256];
  bool gcmOk = false, tamperRejected = false;
  if (boxLen <= sizeof(box) && boxLen >= TAG_LEN && hexDecode(V_BOX, box, boxLen)) {
    uint8_t aad[4 + SID_LEN] = {'s', 'a', 'v', 'e'};
    memcpy(aad + 4, sid, SID_LEN);
    gcmOk = gcmOpen(keys, 1, aad, sizeof(aad), box, boxLen, plain) && hexEncode(plain, boxLen - TAG_LEN) == V_PLAIN;
    box[0] ^= 1;
    tamperRejected = !gcmOpen(keys, 1, aad, sizeof(aad), box, boxLen, plain);
  }
  const bool all = pubOk && sharedOk && zeroRejected && kdfOk && confirmOk && gcmOk && tamperRejected;
  Serial.printf("[SETUPCRYPTO] selftest %s pub=%d shared=%d zero_rejected=%d kdf=%d confirm=%d gcm=%d tamper_rejected=%d "
                "pub_us=%lu shared_us=%lu\n",
                all ? "ok" : "FAILED", pubOk, sharedOk, zeroRejected, kdfOk, confirmOk, gcmOk, tamperRejected,
                (unsigned long)(t1 - t0), (unsigned long)(t2 - t1));
  return all;
}

}  // namespace setupcrypto
