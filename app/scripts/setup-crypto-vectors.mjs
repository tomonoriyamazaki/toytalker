// SoftAP 設定の暗号（ロードマップ45 の土台）で、アプリ側（lib/setupCrypto.ts）と本体側（SetupCrypto.h）の計算が合うかを確かめる。
//
//   cd app && node scripts/setup-crypto-vectors.mjs
//
// アプリの部品で決まった入力から値を作り、本体の SetupCrypto.h の selfTest() に書いてある値と比べる（違えば終了コード 1）。
// 本体はその値を自分の部品（mbedTLS）で計算し直して比べる（起動時のシリアル `[SETUPCRYPTO] selftest ok`）。
// 両方が通れば、同じ決まりで動いている。決まりを変えた時は、ここが出す値を SetupCrypto.h に写す。
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gcm } from "@noble/ciphers/aes";
import { x25519 } from "@noble/curves/ed25519";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { openSession, packWifi, publicKeyHex, sealToToy } from "../lib/setupCrypto.ts";

// RFC 7748 6.1。アプリ = Alice、本体 = Bob
const appPriv = hexToBytes("77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a");
const devPriv = hexToBytes("5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb");
const sid = "0102030405060708";

// 本体の役（SetupCrypto.h の startSession と同じ計算を、ここでは部品を直接使って書く）
const appPub = hexToBytes(publicKeyHex(appPriv));
const devPub = x25519.getPublicKey(devPriv);
const shared = x25519.getSharedSecret(devPriv, appPub);
const keys = hkdf(sha256, shared, concatBytes(appPub, devPub), utf8ToBytes("toytalker-setup-v1"), 96);
const confirm = bytesToHex(hmac(sha256, keys.slice(64, 96), concatBytes(utf8ToBytes("toytalker-setup-v1 device"), hexToBytes(sid))));

// アプリの役（売り物のコードそのもの）
const session = openSession(appPriv, { v: 1, sid, pub: bytesToHex(devPub), confirm });
const plain = packWifi("テストの Wi-Fi", "correct horse battery staple");
const sealed = sealToToy(session, "save", plain);

// 本体の役で開けるか
const nonce = new Uint8Array(12);
nonce[11] = 1;
const opened = gcm(keys.slice(0, 32), nonce, concatBytes(utf8ToBytes("save"), hexToBytes(sid))).decrypt(hexToBytes(sealed.box));

const values = {
  A_PUB: bytesToHex(appPub),
  B_PUB: bytesToHex(devPub),
  SHARED: bytesToHex(shared),
  V_KEY_A2D: bytesToHex(session.keyAppToDev),
  V_CONFIRM: confirm,
  V_BOX: sealed.box,
  V_PLAIN: bytesToHex(plain),
};

let failed = false;
const check = (name, ok) => {
  console.log(`${ok ? "ok  " : "NG  "} ${name}`);
  if (!ok) failed = true;
};
check("RFC 7748 の共有値", values.SHARED === "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742");
check("アプリの鍵 = 本体の役の鍵", values.V_KEY_A2D === bytesToHex(keys.slice(0, 32)));
check("本体の役で開いた中身 = 元の中身", bytesToHex(opened) === values.V_PLAIN);
check("通し番号は 1 から", sealed.seq === 1 && sealToToy(session, "save", plain).seq === 2);
check("暗号文の長さはいつも同じ（98 + 16 バイト）", sealed.box.length === (98 + 16) * 2 && sealToToy(session, "save", packWifi("a", "")).box.length === (98 + 16) * 2);
let threw = false;
try { openSession(appPriv, { v: 1, sid, pub: bytesToHex(devPub), confirm: confirm.replace(/^./, (c) => (c === "0" ? "1" : "0")) }); } catch { threw = true; }
check("確認の値が違えば断る", threw);
threw = false;
try { openSession(appPriv, { v: 1, sid, pub: "00".repeat(32), confirm }); } catch { threw = true; }
check("弱い公開鍵（全部 0）を断る", threw);

const header = readFileSync(fileURLToPath(new URL("../../devices/mcu/esp32_s3/toytalker_mini_v0.7/SetupCrypto.h", import.meta.url)), "utf8");
for (const [name, value] of Object.entries(values)) {
  const m = header.match(new RegExp(`static const char ${name}\\[\\] = "([^"]*)";`));
  check(`SetupCrypto.h の ${name}`, m?.[1] === value);
  if (m?.[1] !== value) console.log(`     static const char ${name}[] = "${value}";`);
}
process.exit(failed ? 1 : 0);
