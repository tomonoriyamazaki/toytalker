#pragma once
// SoftApSetup.h — SoftAP の Wi-Fi 設定ページ（試作。ロードマップ45「売る本体から BLE を外す」の最初の一歩）。
//
// 本体が Wi-Fi の親機（SoftAP）になり、つないだスマホに設定ページを出す。ページで周りの Wi-Fi を選び、パスワードを入れると、
// 本体がその Wi-Fi につなぎ、つながったら呼び出し側（.ino）が NVS に保存して再起動する。
//
// - 親機の名前は ToyTalker-XXXX（BLE の名前と同じ下4桁）。パスワードは本体ごとの乱数（PASS_LEN 文字）で、最初に設定へ入った時に作って
//   NVS の "softap" 名前空間に残す（Wi-Fi 設定のやり直しでは変わらない。箱や本体の QR に刷る前提）。シリアルに QR 用の文字列ごと出す。
// - 設定ページを自動で開かせる仕組み（キャプティブポータル）: DNS はどの名前にも本体の IP を返し、本体あて以外の HTTP は
//   設定ページへ 302 で飛ばす。iOS の /hotspot-detect.html も Android の /generate_204 もこれに当たり、OS がログイン画面を出す。
//   DHCP の option 114（AP.enableDhcpCaptivePortal）は使っていない（URL が http の HTML で、RFC 8908 の JSON ではないため。未検証）。
// - 周りの Wi-Fi は、設定に入った時に1回と、ページの「もう一度探す」で探す。ESP32-S3 は 2.4GHz しか見えないので、一覧は 2.4GHz だけ。
//   探している間は無線が他のチャネルへ行くので、つないでいるスマホから親機が一瞬見えなくなる（切れるかどうかは実機で見る）。
// - つなぐ時も親機は立てたまま（APSTA）。相手のルーターのチャネルが違うと親機もそこへ移るので、結果の画面が出る前に
//   スマホが外れることがある。ページは応答が無くなったら「本体の音と LED で確かめて」と出す。
// - 試作の間は BLE 設定も同時に動く（.ino の startBLE から呼ぶ）。BLE 側がつなぎに行く時は suspend() で止め、失敗したら
//   requestRestart() で戻す。
// - シリアルには Wi-Fi のパスワードを出さない（長さだけ）。親機のパスワードは出す（本体に刷る値で、秘密ではない扱い）。
// - アプリは家の Wi-Fi のパスワードを暗号にして送る（0.7.42。POST /kx で鍵を交換し、/save に box で送る。決まりは SetupCrypto.h）。
//   設定ページ（ブラウザー）は暗号なしのまま送る（ALLOW_PLAIN_SAVE。売る形では閉じる）。
//
// スレッド: begin() / service() とページの処理は loop() から。suspend() / requestRestart() は BLE のタスクから呼んでよい（印を立てるだけ）。
// Wi-Fi のイベント（onWifiEvent）は別タスクで、数を数えるだけ。

#include <Arduino.h>
#include <WiFi.h>
#include <WebServer.h>
#include <DNSServer.h>
#include <Preferences.h>
#include <atomic>
#include <esp_wifi.h>
#include <esp_random.h>
#include <esp_mac.h>
#include <esp_heap_caps.h>
#include "FirmwareVersion.h"
#include "SetupCrypto.h"

namespace softap {

/** つながった時に呼ぶ（保存は呼び出し側）。この後 RESTART_AFTER_MS で再起動する */
typedef void (*ConnectedFn)(const String& ssid, const String& password);

static const size_t PASS_LEN = 10;                 // 親機のパスワードの長さ（未決定。短いほど手打ちは楽、長いほど総当たりに強い）
static const uint8_t AP_CHANNEL = 1;
static const uint8_t AP_MAX_CLIENTS = 2;           // 設定するスマホ1台＋確認用
static const uint32_t SCAN_MS_PER_CHANNEL = 120;   // 1チャネルあたりの待ち。13 チャネルで 2 秒前後の見込み（実機で測る）
static const size_t SCAN_LIST_MAX = 20;
static const uint32_t CONNECT_TIMEOUT_MS = 25000;  // つなぎに行ってから諦めるまで
static const uint8_t CONNECT_MAX_TRIES = 3;        // 切られたらやり直す回数（1回目は偶然の失敗がある）
static const uint32_t RESTART_AFTER_MS = 5000;     // つながってから再起動まで（ページが結果を読む時間）

enum class Scan : uint8_t { None, Running, Done, Failed };
enum class Conn : uint8_t { Idle, Pending, Connecting, Connected, Failed };

static WebServer* g_server = nullptr;
static DNSServer* g_dns = nullptr;
static ConnectedFn g_onConnected = nullptr;
static bool g_active = false;
static bool g_eventsHooked = false;
static std::atomic<bool> g_suspended{false};
static std::atomic<bool> g_restartRequested{false};
// true: OS の接続確認を設定ページへ飛ばし、ログイン画面として自動で開かせる（アプリなしの道）。
// false: 接続確認に「ネットに出られる」と答え、ログイン画面を出さない（アプリから入る道。ページは http://192.168.4.1/ を手で開く）。
static const bool CAPTIVE_POPUP = false;
static char g_ssid[20] = {0};
static char g_deviceId[18] = {0};  // 機器 ID（BLE のアドレス。小文字のコロン区切り）
// false: 親機のパスワードを全部の本体で同じにする（アプリが何も聞かずにつなげる。試作 0.7.40）。
//        この場合、親機のパスワードは守りにならない。家の Wi-Fi のパスワードを守るには、中身の暗号化が別に要る（未実装）。
// true: 本体ごとの乱数（NVS softap/pass）。QR か手入力で入る。
static const bool PER_DEVICE_PASS = false;
static const char COMMON_PASS[] = "toytalker-setup";
static char g_pass[24] = {0};
// true: 暗号なしの /save（ssid, pass をそのまま）も受ける。設定ページ（ブラウザー）がこれを使う。
// 売る形では false にする（ページは使えなくなる。ページを残すなら、ページの中で同じ暗号をする JavaScript が要る）。
// アプリは /info の enc を見て、いつも暗号で送る（暗号なしへは戻らない）。
static const bool ALLOW_PLAIN_SAVE = true;
static bool g_cryptoTested = false;
static uint32_t g_beginMs = 0;

static Scan g_scan = Scan::None;
static uint32_t g_scanStartMs = 0;
static uint32_t g_scanMs = 0;
static String g_scanJson = "[]";

static Conn g_conn = Conn::Idle;
static String g_trySsid, g_tryPass;
static uint32_t g_connMs = 0;        // Pending / Connecting に入った時刻
static uint32_t g_retryAtMs = 0;
static uint8_t g_tries = 0;
static uint32_t g_restartAtMs = 0;
static uint32_t g_seenDisconnects = 0;

// Wi-Fi のイベントで数えるもの
static std::atomic<uint32_t> g_joins{0}, g_leaves{0}, g_scanLeaves{0}, g_staDisconnects{0};
static std::atomic<uint8_t> g_lastReason{0};
static std::atomic<bool> g_scanning{false};

inline uint32_t internalFree() { return heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT); }

inline void logHeap(const char* stage) {
  Serial.printf("[SOFTAP] heap stage=%s internal_free=%lu internal_min=%lu max_blk=%lu psram_free=%lu\n", stage,
                (unsigned long)internalFree(),
                (unsigned long)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                (unsigned long)heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}

/** ページの下とログに出す計測値 */
inline String diagJson() {
  char b[280];
  snprintf(b, sizeof(b),
           "{\"heap\":%lu,\"heap_min\":%lu,\"max_blk\":%lu,\"psram\":%lu,\"sta\":%u,\"joins\":%lu,\"leaves\":%lu,"
           "\"scan_ms\":%lu,\"scan_leaves\":%lu,\"up_s\":%lu}",
           (unsigned long)internalFree(),
           (unsigned long)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
           (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
           (unsigned long)heap_caps_get_free_size(MALLOC_CAP_SPIRAM), (unsigned)WiFi.softAPgetStationNum(),
           (unsigned long)g_joins.load(), (unsigned long)g_leaves.load(), (unsigned long)g_scanMs,
           (unsigned long)g_scanLeaves.load(), (unsigned long)((millis() - g_beginMs) / 1000));
  return String(b);
}

inline void onWifiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_AP_STACONNECTED:
      g_joins++;
      Serial.printf("[SOFTAP] station joined t=%lums (scanning=%d)\n", millis() - g_beginMs, g_scanning.load());
      break;
    case ARDUINO_EVENT_WIFI_AP_STADISCONNECTED:
      g_leaves++;
      if (g_scanning.load()) g_scanLeaves++;
      Serial.printf("[SOFTAP] station left t=%lums reason=%d (scanning=%d)\n", millis() - g_beginMs,
                    (int)info.wifi_ap_stadisconnected.reason, g_scanning.load());
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      // 8（ASSOC_LEAVE）と 3（AUTH_LEAVE）は自分から離れた時の理由。つなぎ直しの WiFi.begin や、あきらめた時の
      // WiFi.disconnect で必ず出るので、失敗には数えない（数えると、やり直しが即失敗になり、本当の理由も上書きされる。
      // 2026-11-22 実機: パスワード違いの 2 が 3 に置き換わってアプリへ返った）
      if (info.wifi_sta_disconnected.reason == 8 || info.wifi_sta_disconnected.reason == 3) break;
      g_lastReason.store((uint8_t)info.wifi_sta_disconnected.reason);
      g_staDisconnects++;
      break;
    default:
      break;
  }
}

/** 親機のパスワード。NVS にあれば読み、無ければ作って残す。無線が動いてから呼ぶ（esp_random が真の乱数になる） */
inline void loadOrCreatePassword() {
  if (g_pass[0]) return;
  if (!PER_DEVICE_PASS) {
    strlcpy(g_pass, COMMON_PASS, sizeof(g_pass));
    return;
  }
  // 見間違えやすい字（0 o 1 l i）を除いた 31 字
  static const char ALPHABET[] = "abcdefghjkmnpqrstuvwxyz23456789";
  Preferences prefs;
  const bool opened = prefs.begin("softap", false);
  if (opened && prefs.isKey("pass")) {
    const String p = prefs.getString("pass", "");
    if (p.length() == PASS_LEN) {
      memcpy(g_pass, p.c_str(), PASS_LEN);
      g_pass[PASS_LEN] = 0;
      prefs.end();
      return;
    }
  }
  for (size_t i = 0; i < PASS_LEN; i++) g_pass[i] = ALPHABET[esp_random() % (sizeof(ALPHABET) - 1)];
  g_pass[PASS_LEN] = 0;
  if (opened) {
    prefs.putString("pass", g_pass);
    prefs.end();
  }
  Serial.println("[SOFTAP] password created");
}

inline void appendJsonString(String& out, const String& s) {
  out += '"';
  for (size_t i = 0; i < s.length(); i++) {
    const uint8_t c = (uint8_t)s[i];
    if (c == '"' || c == '\\') { out += '\\'; out += (char)c; }
    else if (c < 0x20) { char u[8]; snprintf(u, sizeof(u), "\\u%04x", c); out += u; }
    else out += (char)c;
  }
  out += '"';
}

inline void startScan() {
  if (g_scan == Scan::Running || g_conn == Conn::Pending || g_conn == Conn::Connecting || g_conn == Conn::Connected) return;
  WiFi.scanDelete();
  g_scanStartMs = millis();
  g_scanning.store(true);
  const int16_t r = WiFi.scanNetworks(true /*async*/, false /*隠した SSID は出さない*/, false, SCAN_MS_PER_CHANNEL);
  if (r == WIFI_SCAN_FAILED) {
    g_scanning.store(false);
    g_scan = Scan::Failed;
    Serial.println("[SOFTAP] scan start failed");
    return;
  }
  g_scan = Scan::Running;
  Serial.printf("[SOFTAP] scan start stations=%u\n", (unsigned)WiFi.softAPgetStationNum());
}

inline void pollScan() {
  if (g_scan != Scan::Running) return;
  const int16_t n = WiFi.scanComplete();
  if (n == WIFI_SCAN_RUNNING) {
    if (millis() - g_scanStartMs > 15000) {  // 終わりの知らせが来ない
      g_scanning.store(false);
      g_scan = Scan::Failed;
      Serial.println("[SOFTAP] scan timeout");
    }
    return;
  }
  g_scanning.store(false);
  g_scanMs = millis() - g_scanStartMs;
  if (n < 0) {
    g_scan = Scan::Failed;
    Serial.printf("[SOFTAP] scan failed ms=%lu\n", (unsigned long)g_scanMs);
    return;
  }
  // 同じ名前（中継機・メッシュ）は強いほうの1つにまとめる。結果は強い順に並んで届く
  String json = "[";
  String seen[SCAN_LIST_MAX];
  size_t count = 0;
  for (int i = 0; i < n && count < SCAN_LIST_MAX; i++) {
    const String ssid = WiFi.SSID(i);
    if (ssid.length() == 0) continue;
    bool dup = false;
    for (size_t k = 0; k < count; k++) if (seen[k] == ssid) { dup = true; break; }
    if (dup) continue;
    seen[count++] = ssid;
    if (json.length() > 1) json += ',';
    json += "{\"s\":";
    appendJsonString(json, ssid);
    json += ",\"r\":" + String(WiFi.RSSI(i)) + ",\"o\":" + (WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "true" : "false") + "}";
  }
  json += "]";
  g_scanJson = json;
  g_scan = Scan::Done;
  Serial.printf("[SOFTAP] scan done ms=%lu found=%d listed=%u stations=%u left_during_scan=%lu\n", (unsigned long)g_scanMs, (int)n,
                (unsigned)count, (unsigned)WiFi.softAPgetStationNum(), (unsigned long)g_scanLeaves.load());
  WiFi.scanDelete();
  logHeap("after_scan");
}

// ---- 設定ページ ----
static const char PAGE[] PROGMEM = R"HTML(<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ToyTalker の Wi-Fi 設定</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,"Hiragino Sans","Noto Sans JP",sans-serif;margin:0;padding:16px;background:#f6f4ef;color:#222;font-size:16px;line-height:1.6}
main{max-width:480px;margin:0 auto}
h1{font-size:20px;margin:4px 0 4px}
p{margin:4px 0 12px;color:#555;font-size:14px}
#list button{display:flex;justify-content:space-between;width:100%;padding:12px;margin:0 0 6px;border:1px solid #ccc;border-radius:8px;background:#fff;font-size:16px;color:#222;text-align:left}
#list button.sel{border-color:#e07a2f;background:#fff3e8}
#list span{color:#777;font-size:13px;white-space:nowrap;margin-left:8px}
label{display:block;margin:12px 0 4px;font-size:14px;color:#555}
input[type=text],input[type=password]{width:100%;box-sizing:border-box;padding:12px;border:1px solid #bbb;border-radius:8px;font-size:16px}
.row{font-size:14px;margin-top:8px}
#go{width:100%;margin-top:16px;padding:14px;border:0;border-radius:8px;background:#e07a2f;color:#fff;font-size:17px;font-weight:600}
#go:disabled{background:#bbb}
#rescan{border:0;background:none;color:#1a66c2;font-size:14px;padding:6px 0}
#msg{margin-top:14px;padding:12px;border-radius:8px;background:#fff;border:1px solid #ddd;display:none;white-space:pre-line}
#diag{margin-top:24px;color:#999;font-size:11px;white-space:pre-wrap;word-break:break-all}
</style></head><body><main>
<h1>Wi-Fi を選ぶ</h1>
<p>ToyTalker をつなぐ Wi-Fi を選んでください。使えるのは 2.4GHz の Wi-Fi です。</p>
<div id="list">周りの Wi-Fi を探しています…</div>
<button id="rescan" type="button">もう一度探す</button>
<form id="f">
<label for="ssid">Wi-Fi の名前（一覧に無いときは手で入力）</label>
<input id="ssid" type="text" maxlength="32" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
<label for="pass">パスワード</label>
<input id="pass" type="password" maxlength="64" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false">
<div class="row"><label style="display:inline;margin:0"><input id="show" type="checkbox"> パスワードを表示する</label></div>
<button id="go" type="submit">つなぐ</button>
</form>
<div id="msg"></div>
<div id="diag"></div>
</main><script>
var t0=Date.now(),listMs=0,misses=0;
function $(i){return document.getElementById(i)}
function msg(t){var m=$('msg');m.style.display=t?'block':'none';m.textContent=t||''}
function diag(d){if(d)$('diag').textContent='試作の計測: 一覧まで '+(listMs||'-')+'ms / '+JSON.stringify(d)}
function bars(r){return r>=-55?'強い':r>=-67?'ふつう':r>=-78?'弱い':'とても弱い'}
function get(u,cb){var x=new XMLHttpRequest();x.open('GET',u,true);x.timeout=4000;
x.onload=function(){var j=null;try{j=JSON.parse(x.responseText)}catch(e){}cb(j)};
x.onerror=x.ontimeout=function(){cb(null)};x.send()}
function render(nets){var l=$('list');l.textContent='';
if(!nets.length){l.textContent='Wi-Fi が見つかりませんでした。名前を手で入力するか、もう一度探してください。';return}
nets.forEach(function(n){var b=document.createElement('button');b.type='button';
var a=document.createElement('b');a.textContent=n.s;a.style.fontWeight='500';
var s=document.createElement('span');s.textContent=(n.o?'パスワードなし・':'')+bars(n.r);
b.appendChild(a);b.appendChild(s);
b.onclick=function(){var c=l.querySelectorAll('button');for(var i=0;i<c.length;i++)c[i].className='';
b.className='sel';$('ssid').value=n.s;$('pass').focus()};
l.appendChild(b)})}
function scan(start){get('/scan'+(start?'?start=1':''),function(j){
if(!j){$('list').textContent='本体から応答がありません。ToyTalker の Wi-Fi につながっているか確かめてください。';setTimeout(scan,2000);return}
if(j.state=='scanning'){if(start)$('list').textContent='周りの Wi-Fi を探しています…';setTimeout(scan,600);return}
if(!listMs)listMs=Date.now()-t0;diag(j.diag);
if(j.state=='failed'){$('list').textContent='探せませんでした。もう一度探すか、名前を手で入力してください。';return}
render(j.nets||[])})}
function poll(){get('/status',function(j){
if(!j){misses++;if(misses>=6){msg('本体との接続が切れました。\n本体から起動の音がして、LED がゆっくりの点滅から点灯に変われば成功です。\n速い点滅のままなら、もう一度 ToyTalker の Wi-Fi につないでやり直してください。');$('go').disabled=false;return}
setTimeout(poll,1000);return}
misses=0;diag(j.diag);
if(j.state=='connected'){msg('つながりました。本体が起動し直します。起動の音がしたら話しかけられます。');return}
if(j.state=='failed'){var r=j.reason,t='つながりませんでした。';
if(r==201||r==210||r==211||r==212)t+='この名前の Wi-Fi が見つかりません。名前と、2.4GHz の Wi-Fi かどうかを確かめてください。';
else if(r==15||r==202||r==204||r==2)t+='パスワードが違うようです。';
else t+='もう一度試してください。（理由 '+r+'）';
msg(t);$('go').disabled=false;return}
setTimeout(poll,1000)})}
$('show').onchange=function(){$('pass').type=this.checked?'text':'password'};
$('rescan').onclick=function(){scan(true)};
$('f').onsubmit=function(e){e.preventDefault();var s=$('ssid').value,p=$('pass').value;
if(!s){msg('Wi-Fi の名前を選ぶか入力してください。');return}
if(p.length>0&&p.length<8){msg('パスワードは 8 文字以上です。');return}
$('go').disabled=true;msg('つないでいます…（30 秒ほどかかることがあります）');misses=0;
var x=new XMLHttpRequest();x.open('POST','/save',true);x.timeout=5000;
x.setRequestHeader('Content-Type','application/x-www-form-urlencoded');
x.onload=function(){if(x.status==200){setTimeout(poll,1000)}else{var t='送れませんでした。';try{t=JSON.parse(x.responseText).error||t}catch(e){}msg(t);$('go').disabled=false}};
x.onerror=x.ontimeout=function(){msg('本体から応答がありません。ToyTalker の Wi-Fi につながっているか確かめてください。');$('go').disabled=false};
x.send('ssid='+encodeURIComponent(s)+'&pass='+encodeURIComponent(p))};
scan(false);
</script></body></html>
)HTML";

/** 本体あて以外の要求（OS の接続確認など）は設定ページへ飛ばす。飛ばしたら true */
inline bool redirectIfForeign() {
  const String host = g_server->hostHeader();
  const String ip = WiFi.softAPIP().toString();
  Serial.printf("[SOFTAP] http t=%lums host=%s uri=%s\n", millis() - g_beginMs, host.c_str(), g_server->uri().c_str());
  if (host.length() == 0 || host.startsWith(ip)) return false;
  if (!CAPTIVE_POPUP) {
    // OS の接続確認には「ネットに出られる」と答える。ログイン画面が出ず、スマホはこの Wi-Fi に留まる。
    // アプリから入った時に、iPhone のログイン画面がアプリの上にかぶさるのを防ぐ（2026-11-21 実機で確認）。
    const String uri = g_server->uri();
    g_server->sendHeader("Cache-Control", "no-store");
    if (uri.indexOf("generate_204") >= 0 || uri.indexOf("gen_204") >= 0) {
      g_server->send(204, "text/plain", "");  // Android
    } else if (uri.indexOf("connecttest.txt") >= 0) {
      g_server->send(200, "text/plain", "Microsoft Connect Test");  // Windows
    } else {
      g_server->send(200, "text/html", "<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>");  // iOS / macOS
    }
    return true;
  }
  g_server->sendHeader("Location", String("http://") + ip + "/", true);
  g_server->sendHeader("Cache-Control", "no-store");
  g_server->send(302, "text/plain", "");
  return true;
}

inline void sendJson(int code, const String& body) {
  g_server->sendHeader("Cache-Control", "no-store");
  g_server->send(code, "application/json", body);
}

inline void handleRoot() {
  if (redirectIfForeign()) return;
  g_server->sendHeader("Cache-Control", "no-store");
  g_server->send_P(200, "text/html; charset=utf-8", PAGE);
}

inline void handleScan() {
  if (redirectIfForeign()) return;
  if (g_server->hasArg("start") || g_scan == Scan::None) startScan();
  const char* state = g_scan == Scan::Done ? "done" : g_scan == Scan::Failed ? "failed" : "scanning";
  String body = String("{\"state\":\"") + state + "\",\"nets\":" + (g_scan == Scan::Done ? g_scanJson : String("[]"))
                + ",\"diag\":" + diagJson() + "}";
  sendJson(200, body);
}

/** アプリ用: この本体がどれかを返す（機器の登録に使う ID と版）。ページは使わない */
inline void handleInfo() {
  if (redirectIfForeign()) return;
  sendJson(200, String("{\"id\":\"") + g_deviceId + "\",\"name\":\"" + g_ssid + "\",\"fw\":\"" TOYTALKER_FW_VERSION "\",\"enc\":1}");
}

inline void handleStatus() {
  if (redirectIfForeign()) return;
  const char* state = g_conn == Conn::Connected ? "connected" : g_conn == Conn::Failed ? "failed"
                      : g_conn == Conn::Idle ? "idle" : "connecting";
  sendJson(200, String("{\"state\":\"") + state + "\",\"reason\":" + String((int)g_lastReason.load()) + ",\"diag\":" + diagJson() + "}");
}

/** アプリ用: その場かぎりの鍵を交換する（SetupCrypto.h）。呼ぶたびに鍵を作り直す */
inline void handleKx() {
  if (redirectIfForeign()) return;
  const uint32_t t0 = millis();
  String sid, pub, confirm;
  if (!setupcrypto::startSession(g_server->arg("pub"), sid, pub, confirm)) {
    Serial.println("[SOFTAP] kx rejected");
    sendJson(400, "{\"ok\":false,\"error\":\"鍵を交換できませんでした。\"}");
    return;
  }
  Serial.printf("[SOFTAP] kx ok ms=%lu\n", (unsigned long)(millis() - t0));
  sendJson(200, String("{\"v\":1,\"sid\":\"") + sid + "\",\"pub\":\"" + pub + "\",\"confirm\":\"" + confirm + "\"}");
}

inline void handleSave() {
  if (redirectIfForeign()) return;
  String ssid, pass;
  const bool encrypted = g_server->hasArg("box");
  if (encrypted) {
    // 中身は長さの決まった 98 バイト: [名前の長さ][名前 32][パスワードの長さ][パスワード 64]（アプリの packWifi）
    uint8_t plain[98];
    const uint64_t seq = strtoull(g_server->arg("seq").c_str(), nullptr, 10);
    const setupcrypto::OpenResult r =
      setupcrypto::openFromApp("save", g_server->arg("sid"), seq, g_server->arg("box"), plain, sizeof(plain));
    if (r != setupcrypto::OpenResult::Ok) {
      Serial.printf("[SOFTAP] save rejected crypto=%s\n", setupcrypto::openResultName(r));
      // 鍵が無い・期限切れは、アプリが鍵を交換し直して送り直す（409 と code で見分ける）
      sendJson(r == setupcrypto::OpenResult::NoSession ? 409 : 400,
               String("{\"ok\":false,\"code\":\"") + setupcrypto::openResultName(r) + "\",\"error\":\"暗号を開けませんでした。\"}");
      return;
    }
    const size_t ssidLen = plain[0], passLen = plain[33];
    if (ssidLen <= 32 && passLen <= 64) {
      ssid.concat((const char*)plain + 1, ssidLen);
      pass.concat((const char*)plain + 34, passLen);
    }
    mbedtls_platform_zeroize(plain, sizeof(plain));
  } else if (ALLOW_PLAIN_SAVE) {
    ssid = g_server->arg("ssid");
    pass = g_server->arg("pass");
  } else {
    sendJson(400, "{\"ok\":false,\"error\":\"暗号なしでは受け取れません。\"}");
    return;
  }
  if (ssid.length() == 0 || ssid.length() > 32) {
    sendJson(400, "{\"ok\":false,\"error\":\"Wi-Fi の名前は 1〜32 バイトです。\"}");
    return;
  }
  if ((pass.length() > 0 && pass.length() < 8) || pass.length() > 64) {
    sendJson(400, "{\"ok\":false,\"error\":\"パスワードは 8〜63 文字です。\"}");
    return;
  }
  if (g_conn == Conn::Pending || g_conn == Conn::Connecting || g_conn == Conn::Connected) {
    sendJson(409, "{\"ok\":false,\"error\":\"いま つないでいる途中です。\"}");
    return;
  }
  g_trySsid = ssid;
  g_tryPass = pass;
  g_conn = Conn::Pending;
  g_connMs = millis();
  Serial.printf("[SOFTAP] save ssid=%s pass_len=%u encrypted=%d\n", ssid.c_str(), (unsigned)pass.length(), (int)encrypted);
  sendJson(200, "{\"ok\":true}");
}

inline void handleNotFound() {
  if (redirectIfForeign()) return;
  g_server->send(404, "text/plain", "not found");
}

inline void beginStation() {
  g_tries++;
  g_seenDisconnects = g_staDisconnects.load();
  g_retryAtMs = 0;
  Serial.printf("[SOFTAP] connect try=%u ssid=%s\n", (unsigned)g_tries, g_trySsid.c_str());
  WiFi.begin(g_trySsid.c_str(), g_tryPass.length() ? g_tryPass.c_str() : nullptr);
}

inline void serviceConnect() {
  const uint32_t now = millis();
  if (g_conn == Conn::Pending) {
    // 応答を送り切るのを少し待つ。探している最中なら終わるまで待つ（探しながらはつなげない）
    if (now - g_connMs < 300 || g_scan == Scan::Running) return;
    g_conn = Conn::Connecting;
    g_connMs = now;
    g_tries = 0;
    g_lastReason.store(0);
    beginStation();
    return;
  }
  if (g_conn == Conn::Connecting) {
    if (WiFi.status() == WL_CONNECTED && WiFi.localIP() != IPAddress((uint32_t)0)) {
      g_conn = Conn::Connected;
      g_restartAtMs = now + RESTART_AFTER_MS;
      Serial.printf("[SOFTAP] connected ms=%lu tries=%u ip=%s channel=%d stations=%u\n", (unsigned long)(now - g_connMs),
                    (unsigned)g_tries, WiFi.localIP().toString().c_str(), (int)WiFi.channel(), (unsigned)WiFi.softAPgetStationNum());
      if (g_onConnected) g_onConnected(g_trySsid, g_tryPass);
      setupcrypto::clearSession();  // 用が済んだ鍵は消す
      return;
    }
    const bool dropped = g_staDisconnects.load() != g_seenDisconnects;
    if (dropped && !g_retryAtMs) {
      g_seenDisconnects = g_staDisconnects.load();
      Serial.printf("[SOFTAP] connect dropped reason=%d try=%u\n", (int)g_lastReason.load(), (unsigned)g_tries);
      if (g_tries >= CONNECT_MAX_TRIES) g_connMs = now - CONNECT_TIMEOUT_MS;  // 下で失敗にする
      else g_retryAtMs = (now + 700) | 1;
    }
    if (now - g_connMs >= CONNECT_TIMEOUT_MS) {
      g_conn = Conn::Failed;
      WiFi.disconnect(false, false);  // 子機側だけ止める（親機は残す）
      Serial.printf("[SOFTAP] connect failed reason=%d tries=%u stations=%u\n", (int)g_lastReason.load(), (unsigned)g_tries,
                    (unsigned)WiFi.softAPgetStationNum());
      return;
    }
    if (g_retryAtMs && (int32_t)(now - g_retryAtMs) >= 0) beginStation();
    return;
  }
  if (g_conn == Conn::Connected && (int32_t)(now - g_restartAtMs) >= 0) {
    Serial.println("[SOFTAP] restarting with the saved Wi-Fi");
    Serial.flush();
    delay(100);
    ESP.restart();
  }
}

/** 親機と設定ページを始める（やり直しにも使う）。loop() のタスクから呼ぶ */
inline bool begin(ConnectedFn onConnected) {
  g_onConnected = onConnected;
  g_suspended.store(false);
  g_restartRequested.store(false);
  logHeap("before");
  if (!g_eventsHooked) {
    WiFi.onEvent(onWifiEvent);
    g_eventsHooked = true;
  }
  if (g_server) g_server->stop();
  if (g_dns) g_dns->stop();

  WiFi.setAutoReconnect(false);  // 保存済みの Wi-Fi を探し続けると、親機が何度も他のチャネルへ行く
  WiFi.mode(WIFI_AP_STA);        // 子機側は「探す」と「つなぐ」に使う
  WiFi.disconnect(false, false);
  wifi_country_t country = {
    .cc = "JP", .schan = 1, .nchan = 14, .max_tx_power = 20, .policy = WIFI_COUNTRY_POLICY_MANUAL
  };
  esp_wifi_set_country(&country);

  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_BT);  // BLE の名前と同じ下4桁（アプリと本体のラベルで同じ番号になる）
  snprintf(g_ssid, sizeof(g_ssid), "ToyTalker-%02X%02X", mac[4], mac[5]);
  snprintf(g_deviceId, sizeof(g_deviceId), "%02x:%02x:%02x:%02x:%02x:%02x", mac[0], mac[1], mac[2], mac[3], mac[4], mac[5]);
  loadOrCreatePassword();

  if (!WiFi.softAP(g_ssid, g_pass, AP_CHANNEL, 0, AP_MAX_CLIENTS)) {
    Serial.println("[SOFTAP] softAP start failed");
    g_active = false;
    return false;
  }
  const IPAddress ip = WiFi.softAPIP();

  if (!g_dns) g_dns = new DNSServer();
  g_dns->setErrorReplyCode(DNSReplyCode::NoError);
  g_dns->start(53, "*", ip);

  if (!g_server) {
    g_server = new WebServer(80);
    g_server->on("/", HTTP_GET, handleRoot);
    g_server->on("/scan", HTTP_GET, handleScan);
    g_server->on("/status", HTTP_GET, handleStatus);
    g_server->on("/info", HTTP_GET, handleInfo);
    g_server->on("/kx", HTTP_POST, handleKx);
    g_server->on("/save", HTTP_POST, handleSave);
    g_server->onNotFound(handleNotFound);
  }
  g_server->begin();

  setupcrypto::clearSession();
  if (!g_cryptoTested) {  // 起動して最初の 1 回だけ。本体の暗号の計算がアプリと合っているかをシリアルに出す
    g_cryptoTested = true;
    setupcrypto::selfTest();
  }

  g_beginMs = millis();
  g_conn = Conn::Idle;
  g_scan = Scan::None;
  g_scanning.store(false);
  g_active = true;
  Serial.printf("[SOFTAP] started ssid=%s pass=%s ip=%s channel=%u\n", g_ssid, g_pass, ip.toString().c_str(), (unsigned)AP_CHANNEL);
  Serial.printf("[SOFTAP] qr=WIFI:T:WPA;S:%s;P:%s;;\n", g_ssid, g_pass);
  logHeap("ap_up");
  startScan();  // ページを開いた時に一覧ができているように、先に探しておく
  return true;
}

/** BLE 側がつなぎに行く前に呼ぶ（Wi-Fi のモードを向こうが変えるので、こちらは手を出さない）。別タスクから呼んでよい */
inline void suspend() { g_suspended.store(true); }

/** BLE 側の接続が失敗した後に呼ぶ。次の service() で親機を立て直す。別タスクから呼んでよい */
inline void requestRestart() { g_restartRequested.store(true); }

inline bool active() { return g_active && !g_suspended.load(); }

/** 親機につないでいる台数（動いていなければ 0） */
inline uint8_t stations() { return active() ? WiFi.softAPgetStationNum() : 0; }

/** loop() から呼び続ける */
inline void service() {
  if (g_restartRequested.exchange(false)) {
    Serial.println("[SOFTAP] restart requested");
    begin(g_onConnected);
  }
  if (!active()) return;
  g_server->handleClient();
  pollScan();
  serviceConnect();
}

}  // namespace softap
