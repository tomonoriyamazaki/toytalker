/**
 * SoftAP 設定の「土台」: アプリと本体がその場かぎりの鍵を交換し、送る中身を暗号にする（ロードマップ45）。
 * 決まりの説明は本体側 devices/mcu/esp32_s3/toytalker_mini_v0.7/SetupCrypto.h の先頭。両方を同じに保つ。
 * 突き合わせは app/scripts/setup-crypto-vectors.mjs（このファイルをそのまま読み込む。だから expo や react-native を import しない）。
 * 乱数（秘密鍵）は呼び出し側が作って渡す（lib/softap.ts が expo-crypto で作る）。
 */
import { gcm } from "@noble/ciphers/aes";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";

const PROTOCOL = "toytalker-setup-v1";
const CONFIRM_LABEL = "toytalker-setup-v1 device";
const SSID_MAX = 32;
const PASS_MAX = 64;

export type SetupSession = {
  sid: string; // hex
  keyAppToDev: Uint8Array;
  keyDevToApp: Uint8Array; // いまは使っていない（保護者用の鍵を受け取る時に使う）
  seq: number; // 最後に使った通し番号
};

/** /kx に送る公開鍵（hex）。priv は乱数 32 バイト */
export function publicKeyHex(priv: Uint8Array): string {
  return bytesToHex(x25519.getPublicKey(priv));
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * /kx の返事から鍵を作る。本体が同じ鍵を持っていること（confirm）を確かめ、違えば投げる。
 * psk は本体ごとの設定コード（「強化」で入れる。いまは渡さない）
 */
export function openSession(
  priv: Uint8Array,
  reply: { v?: number; sid?: string; pub?: string; confirm?: string },
  psk: Uint8Array = new Uint8Array(0)
): SetupSession {
  if (reply?.v !== 1 || !/^[0-9a-f]{16}$/.test(reply.sid ?? "") || !/^[0-9a-f]{64}$/.test(reply.pub ?? "") || !/^[0-9a-f]{64}$/.test(reply.confirm ?? "")) {
    throw new Error("おもちゃの返事の形が違います。");
  }
  const appPub = x25519.getPublicKey(priv);
  const devPub = hexToBytes(reply.pub!);
  // 共有値が全部 0（相手が弱い点を送ってきた）なら、ここで投げる
  const shared = x25519.getSharedSecret(priv, devPub);
  const keys = hkdf(sha256, concatBytes(shared, psk), concatBytes(appPub, devPub), utf8ToBytes(PROTOCOL), 96);
  const want = hmac(sha256, keys.slice(64, 96), concatBytes(utf8ToBytes(CONFIRM_LABEL), hexToBytes(reply.sid!)));
  if (!equalBytes(want, hexToBytes(reply.confirm!))) throw new Error("おもちゃと鍵が合いませんでした。");
  return { sid: reply.sid!, keyAppToDev: keys.slice(0, 32), keyDevToApp: keys.slice(32, 64), seq: 0 };
}

/** 本体へ送る暗号文を作る。purpose は用途の名前（本体側と同じ字）。通し番号を 1 つ進める */
export function sealToToy(session: SetupSession, purpose: string, plain: Uint8Array): { sid: string; seq: number; box: string } {
  const seq = ++session.seq;
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setUint32(8, seq, false); // 通し番号は 2^32 未満（上位 4 バイトは 0 のまま）
  const aad = concatBytes(utf8ToBytes(purpose), hexToBytes(session.sid));
  return { sid: session.sid, seq, box: bytesToHex(gcm(session.keyAppToDev, nonce, aad).encrypt(plain)) };
}

/**
 * Wi-Fi の名前とパスワードを、長さの決まった 98 バイトに詰める（暗号文の長さからパスワードの長さが分からないように）。
 * 形: [名前の長さ 1][名前 32（余りは 0）][パスワードの長さ 1][パスワード 64（余りは 0）]
 */
export function packWifi(ssid: string, password: string): Uint8Array {
  const s = utf8ToBytes(ssid);
  const p = utf8ToBytes(password);
  if (s.length === 0 || s.length > SSID_MAX) throw new Error("Wi-Fi の名前は 1〜32 バイトです。");
  if (p.length > PASS_MAX) throw new Error("パスワードが長すぎます。");
  const out = new Uint8Array(1 + SSID_MAX + 1 + PASS_MAX);
  out[0] = s.length;
  out.set(s, 1);
  out[1 + SSID_MAX] = p.length;
  out.set(p, 2 + SSID_MAX);
  return out;
}
