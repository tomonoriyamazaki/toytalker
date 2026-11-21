/**
 * SoftAP の Wi-Fi 設定（試作。ロードマップ45）。
 * 本体が Wi-Fi の親機（ToyTalker-XXXX）になり、アプリが OS の「この Wi-Fi につなぐ」仕組みで入って、本体の API を直接呼ぶ。
 * 本体側は devices/mcu/esp32_s3/toytalker_mini_v0.7/SoftApSetup.h（/info /scan /save /status）。
 * 親機につないでいる間はネットに出られないので、クラウドの API（機器の登録）は leaveToy の後に呼ぶ。
 */
import { NativeModules, Platform } from "react-native";
import WifiManager from "react-native-wifi-reborn";

const BASE = "http://192.168.4.1";

export type ToyInfo = { id: string; name: string; fw: string };
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
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
}

// 親機の名前の前半と、全部の本体で同じパスワード（本体の SoftApSetup.h の COMMON_PASS と合わせる）。
// 利用者に何も入れさせずにつなぐためのもので、守りにはならない。中身の暗号化は別に要る（未実装）
export const TOY_SSID_PREFIX = "ToyTalker-";
const TOY_COMMON_PASS = "toytalker-setup";

/**
 * 近くで設定モードになっているおもちゃの親機につなぎ、本体が答えるまで待つ。OS の確認が1回出る。入力は要らない。
 * つながったかは OS の返事ではなく、本体の /info が返るかで決める（iOS は今の Wi-Fi 名を読めないことがある）。
 * 名前の前半だけでつなぐ仕組みは iOS だけ（Android は周りを探して選ぶ形が要る。未対応）。
 */
export async function joinToy(): Promise<ToyInfo> {
  if (Platform.OS !== "ios") throw new Error("この試作は iPhone だけに対応しています。");
  let joinError: any = null;
  try {
    await WifiManager.connectToProtectedSSIDPrefix(TOY_SSID_PREFIX, TOY_COMMON_PASS, false);
  } catch (e: any) {
    if (e?.code === "userDenied") throw new Error("接続をキャンセルしました。");
    joinError = e;
  }
  // OS がつなげなかったと言っている時は、念のため短く確かめるだけにする
  const deadline = Date.now() + (joinError ? 5000 : 20000);
  while (Date.now() < deadline) {
    try {
      const info = await toyFetch("/info", {}, 2500);
      if (info?.id) return info as ToyInfo;
    } catch {}
    await sleep(700);
  }
  throw new Error(
    joinError
      ? `おもちゃの Wi-Fi につながりませんでした（${joinError?.code ?? joinError?.message ?? "不明"}）。おもちゃのボタンを長押しして、ランプが速く点滅しているのを確かめてから、もう一度試してください。`
      : "おもちゃから応答がありません。おもちゃが設定モード（ランプが速く点滅）か確かめてください。"
  );
}

/** 親機から離れて、元の回線に戻す。ssid はつないだ親機の名前（/info の name） */
export async function leaveToy(ssid: string): Promise<void> {
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

/** Wi-Fi の名前とパスワードを本体へ送り、本体がつながるか失敗するまで待つ（最大 40 秒） */
export async function saveToToy(ssid: string, password: string): Promise<SaveResult> {
  await toyFetch(
    "/save",
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `ssid=${encodeURIComponent(ssid)}&pass=${encodeURIComponent(password)}`,
    },
    6000
  );
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

/** 失敗の理由（Wi-Fi の切断理由コード）を文にする。WPA3 のパスワード違いは 2 で返る（2026-11-20 実機） */
export function saveFailureText(reason: number): string {
  if (reason === 201) return "その Wi-Fi が見つかりませんでした。名前を確かめてください（5GHz だけの Wi-Fi にはつながりません）。";
  if (reason === 15 || reason === 202 || reason === 204 || reason === 2) return "パスワードが違うようです。";
  return `つながりませんでした（理由 ${reason}）。`;
}
