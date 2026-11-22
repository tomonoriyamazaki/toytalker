/**
 * SoftAP の Wi-Fi 設定（試作。ロードマップ45）。
 * 本体が Wi-Fi の親機（ToyTalker-XXXX）になり、アプリが OS の「この Wi-Fi につなぐ」仕組みで入って、本体の API を直接呼ぶ。
 * 本体側は devices/mcu/esp32_s3/toytalker_mini_v0.7/SoftApSetup.h（/info /scan /kx /save /status）。
 * 親機につないでいる間はネットに出られないので、クラウドの API（機器の登録）は leaveToy の後に呼ぶ。
 */
import * as Crypto from "expo-crypto";
import { NativeModules, Platform } from "react-native";
import WifiManager from "react-native-wifi-reborn";
import { openSession, packWifi, publicKeyHex, sealToToy, SetupSession } from "./setupCrypto";

const BASE = "http://192.168.4.1";

export type ToyInfo = { id: string; name: string; fw: string; enc?: number }; // enc: 暗号つきの /save に対応（0.7.42〜）
export type ToyNet = { s: string; r: number; o: boolean }; // 名前・電波の強さ(dBm)・パスワード無し
export type ScanResult = { state: "scanning" | "done" | "failed"; nets: ToyNet[] };
export type SaveResult = { state: "connected" | "failed" | "unknown"; reason: number };

/** ネイティブのモジュールが入ったビルドか（入れる前の dev client では false） */
export const wifiModuleAvailable = (): boolean => !!NativeModules.WifiManager;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function toyFetch(path: string, init: RequestInit = {}, timeoutMs = 4000): Promise<any> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, signal: ctl.signal });
    const body = await res.json();
    if (!res.ok) throw Object.assign(new Error(body?.error ?? `HTTP ${res.status}`), { code: body?.code });
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// 親機の名前の前半と、全部の本体で同じパスワード（本体の SoftApSetup.h の COMMON_PASS と合わせる）。
// 利用者に何も入れさせずにつなぐためのもので、守りにはならない。家の Wi-Fi のパスワードは、本体と交換した鍵で
// 暗号にして送る（saveToToy）
export const TOY_SSID_PREFIX = "ToyTalker-";
const TOY_COMMON_PASS = "toytalker-setup";
const JOIN_TRIES = 3; // OS の「つなぐ」を試す回数

/**
 * 近くで設定モードになっているおもちゃの親機につなぎ、本体が答えるまで待つ。OS の確認が1回出る。入力は要らない。
 * つながったかは OS の返事ではなく、本体の /info が返るかで決める（iOS は今の Wi-Fi 名を読めないことがある）。
 * 名前の前半だけでつなぐ仕組みは iOS だけ（Android は周りを探して選ぶ形が要る。未対応）。
 */
export async function joinToy(): Promise<ToyInfo> {
  if (Platform.OS !== "ios") throw new Error("この試作は iPhone だけに対応しています。");
  // OS が「つなげなかった」と返したら、少し待ってやり直す（JOIN_TRIES 回まで）。本体が点滅を始めた直後は、iPhone がまだ親機を
  // 見つけていないことがある（2026-11-22 実機: 点滅から 20 秒ほどの 1 回目は失敗、何も変えずに押し直した 2 回目は通った。
  // 本体は親機を立てた直後の 3.4 秒、周りを探していて電波が途切れる）。原因を突き止めた直しではなく、押し直しの代わり。
  let joinError: any = null;
  for (let attempt = 1; attempt <= JOIN_TRIES; attempt++) {
    joinError = null;
    const t0 = Date.now();
    try {
      await WifiManager.connectToProtectedSSIDPrefix(TOY_SSID_PREFIX, TOY_COMMON_PASS, false);
    } catch (e: any) {
      if (e?.code === "userDenied") throw new Error("接続をキャンセルしました。");
      joinError = e;
    }
    console.log(`[SOFTAP] join attempt=${attempt} os=${joinError ? joinError?.code ?? "error" : "ok"} ms=${Date.now() - t0}`);
    // つながったかは本体の /info で決める。OS がつなげなかったと言っている時は、念のため短く確かめるだけにする
    const deadline = Date.now() + (joinError ? 4000 : 20000);
    while (Date.now() < deadline) {
      try {
        const info = await toyFetch("/info", {}, 2500);
        if (info?.id) {
          if (!info.enc) throw Object.assign(new Error(`おもちゃのソフトが古く（版 ${info.fw}）、この設定に対応していません。`), { fatal: true });
          forgetToySession();
          return info as ToyInfo;
        }
      } catch (e: any) {
        if (e?.fatal) throw e;
      }
      await sleep(700);
    }
    if (!joinError) break; // OS はつないだと言うのに本体が答えない。やり直しても変わらない
  }
  throw new Error(
    joinError
      ? `おもちゃの Wi-Fi につながりませんでした（${joinError?.code ?? joinError?.message ?? "不明"}）。おもちゃのボタンを長押しして、ランプが速く点滅しているのを確かめてから、もう一度試してください。`
      : "おもちゃから応答がありません。おもちゃが設定モード（ランプが速く点滅）か確かめてください。"
  );
}

/** 親機から離れて、元の回線に戻す。ssid はつないだ親機の名前（/info の name） */
export async function leaveToy(ssid: string): Promise<void> {
  forgetToySession();
  try {
    if (Platform.OS === "android") {
      await WifiManager.forceWifiUsageWithOptions(false, { noInternet: false });
      await WifiManager.disconnect();
    } else {
      // 前半だけでつないだ設定は、前半の名前で消す。念のため実際の名前でも消す
      try { await WifiManager.disconnectFromSSID(TOY_SSID_PREFIX); } catch {}
      if (ssid && ssid !== TOY_SSID_PREFIX) await WifiManager.disconnectFromSSID(ssid);
    }
  } catch {}
}

/** 本体が探した周りの Wi-Fi。rescan で探し直す。探し終わるまで待つ（最大 15 秒） */
export async function scanFromToy(rescan: boolean): Promise<ToyNet[]> {
  let first = rescan;
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const r: ScanResult = await toyFetch(first ? "/scan?start=1" : "/scan");
    first = false;
    if (r.state === "done") return r.nets ?? [];
    if (r.state === "failed") throw new Error("Wi-Fi を探せませんでした。");
    await sleep(800);
  }
  throw new Error("Wi-Fi の一覧が返ってきませんでした。");
}

const postForm = (path: string, body: string, timeoutMs: number) =>
  toyFetch(path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body }, timeoutMs);

// 本体と交換した、その場かぎりの鍵（1 回の設定の間だけ持つ。本体は 5 分で捨てる）
let session: SetupSession | null = null;

/** 本体と鍵を交換する（X25519。決まりは lib/setupCrypto.ts）。秘密鍵はここで作って、鍵ができたら捨てる */
async function exchangeKeys(): Promise<SetupSession> {
  const priv = Crypto.getRandomBytes(32);
  const t0 = Date.now();
  const reply = await postForm("/kx", `pub=${publicKeyHex(priv)}`, 6000);
  const s = openSession(priv, reply);
  priv.fill(0);
  console.log(`[SOFTAP] kx ok ms=${Date.now() - t0}`);
  return s;
}

/** 親機を離れる時に鍵を捨てる */
export function forgetToySession(): void {
  session?.keyAppToDev.fill(0);
  session?.keyDevToApp.fill(0);
  session = null;
}

/**
 * Wi-Fi の名前とパスワードを暗号にして本体へ送り、本体がつながるか失敗するまで待つ（最大 40 秒）。
 * 暗号なしでは送らない（古いファームの本体には joinToy の時点で断っている）。
 */
export async function saveToToy(ssid: string, password: string): Promise<SaveResult> {
  const plain = packWifi(ssid, password);
  for (let attempt = 0; ; attempt++) {
    if (!session) session = await exchangeKeys();
    const { sid, seq, box } = sealToToy(session, "save", plain);
    try {
      await postForm("/save", `sid=${sid}&seq=${seq}&box=${box}`, 6000);
      break;
    } catch (e: any) {
      // 本体が鍵を捨てていた（5 分たった・設定モードに入り直した）時は、1 回だけ交換し直して送る
      if (e?.code !== "no_session" || attempt > 0) throw e;
      forgetToySession();
    }
  }
  const deadline = Date.now() + 40000;
  let misses = 0;
  while (Date.now() < deadline) {
    await sleep(1000);
    try {
      const r = await toyFetch("/status", {}, 2500);
      misses = 0;
      if (r.state === "connected" || r.state === "failed") return { state: r.state, reason: r.reason ?? 0 };
    } catch {
      // 本体は成功すると 5 秒後に再起動して親機が消える。答えが続けて途切れたら結果は分からない
      if (++misses >= 8) break;
    }
  }
  return { state: "unknown", reason: 0 };
}

/**
 * 失敗の理由（Wi-Fi の切断理由コード）を文にする。
 * 2（認証の時間切れ）は、WPA3 のパスワード違いでも（2026-11-20 実機）、正しいパスワードのたまたまの失敗でも出る
 * （2026-11-22 実機。同じパスワードで次は通った）ので、言い切らない。
 */
export function saveFailureText(reason: number): string {
  if (reason === 201) return "その Wi-Fi が見つかりませんでした。名前を確かめてください（5GHz だけの Wi-Fi にはつながりません）。";
  if (reason === 2) return "つながりませんでした。パスワードを確かめて、合っていればもう一度試してください。";
  if (reason === 15 || reason === 202 || reason === 204) return "パスワードが違うようです。";
  return `つながりませんでした（理由 ${reason}）。`;
}
