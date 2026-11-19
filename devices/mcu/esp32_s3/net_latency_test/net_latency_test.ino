// net_latency_test.ino — 回線ごとの速さを ESP32 本体で測る、計測専用のスケッチ。
//
// シリアル（USB、115200）から1行の命令で動かし、結果を "[NET] {…}" の JSON 1行で返す。
// マイク・スピーカー・BLE・Soniox は使わない。会話のファーム（toytalker_mini_v0.7）と同じにしてあるのは、
// 証明書の検証（AmazonRootCA.h / SonioxRootCA.h）、mbedTLS の確保先（TlsMemory.h = PSRAM）、区画表（partitions.csv）、
// 要求の形（/chat-mcu、SHA-256、デバイス鍵）。計測（J / H / T）は NVS を読むだけで書かない。
// NVS を書くのは W / R だけ（会話のファームの Wi-Fi 設定を入れ替える・戻す）。デバイス鍵には触らない。
//
// 命令（改行で確定）:
//   L <名前>            以後の結果に付ける回線の名前
//   J                   NVS に入っている Wi-Fi（会話のファームが使っているもの）へ繋ぐ
//   J <SSID><TAB><PW>   指定の Wi-Fi へ繋ぐ（保存しない。パスワードは表示しない）
//   H <回数>            接続だけを測る: DNS・TCP・TLS（API と Soniox。要求は送らないので費用なし）
//   T <回数>            会話1回ぶんを測る: 決まった文を /chat-mcu に送り、最初の音声までと受信の様子を見る
//                       （LLM と TTS の費用がかかり、RnD の usage / chat-logs に行が残る）
//   W <SSID><TAB><PW>   会話のファームが使う Wi-Fi をこれに入れ替える（元の設定は控える）。実際に話して比べる用
//   R                   W で入れ替える前の Wi-Fi に戻す
//   S                   いまの状態
//
// 時刻はどれも ms。T の時刻は「接続を始めた時」から（会話のファームの device.prev と同じ並び。pre_ms は無い）。
// play_start / underruns / stall は、届いた音声を 0.34 秒溜めてから実時間で鳴らしたと仮定した計算（実際には鳴らさない）。

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Preferences.h>
#include <mbedtls/sha256.h>
#include "TlsMemory.h"
#include "AmazonRootCA.h"
#include "SonioxRootCA.h"

static const char* API_HOST = "api-rnd.zakicorp.com";
static const char* STT_HOST = "stt-rt.soniox.com";
static const char* CHAT_PATH = "/chat-mcu";
static const char* KEY_HEADER = "x-toytalker-device-key";
static const char* TEST_TEXT = "すきなどうぶつをおしえて";
static const uint32_t PCM_BYTES_PER_MS = 48;   // 24kHz mono 16bit
static const uint32_t PREBUFFER_MS = 340;      // 会話のファームの溜め
static const uint32_t IDLE_TIMEOUT_MS = 15000;

static String g_label = "none";
static String g_mac;
static String g_key;
static uint8_t g_buf[2048];

// ---- 応答の読み取り（chunked をほどく） ----
struct BodyReader {
  WiFiClientSecure& c;
  uint32_t remain = 0;
  bool done = false, err = false;
  explicit BodyReader(WiFiClientSecure& client) : c(client) {}

  bool readRaw(uint8_t* b, size_t n) {
    size_t got = 0;
    uint32_t last = millis();
    while (got < n) {
      const int a = c.available();
      if (a > 0) {
        const int r = c.read(b + got, min((size_t)a, n - got));
        if (r > 0) { got += r; last = millis(); }
      } else {
        if (!c.connected() && c.available() <= 0) return false;
        if (millis() - last > IDLE_TIMEOUT_MS) return false;
        delay(1);
      }
    }
    return true;
  }

  bool readLine(String& s, size_t limit) {
    s = "";
    uint8_t ch;
    while (true) {
      if (!readRaw(&ch, 1)) return false;
      if (ch == '\n') return true;
      if (ch != '\r') s += (char)ch;
      if (s.length() > limit) return false;
    }
  }

  // ほどいた本文を最大 n バイト読む。0 は終わりか失敗（done / err で見分ける）
  size_t read(uint8_t* b, size_t n) {
    if (done || err) return 0;
    if (remain == 0) {
      String line;
      if (!readLine(line, 64)) { err = true; return 0; }
      const int semi = line.indexOf(';');
      if (semi >= 0) line = line.substring(0, semi);
      line.trim();
      if (line.length() == 0) { err = true; return 0; }
      remain = strtoul(line.c_str(), nullptr, 16);
      if (remain == 0) { done = true; return 0; }
    }
    const size_t want = min((size_t)remain, n);
    size_t got = 0;
    uint32_t last = millis();
    while (got == 0) {
      const int a = c.available();
      if (a > 0) {
        const int r = c.read(b, min((size_t)a, want));
        if (r > 0) got = r;
      } else {
        if (!c.connected() && c.available() <= 0) { err = true; return 0; }
        if (millis() - last > IDLE_TIMEOUT_MS) { err = true; return 0; }
        delay(1);
      }
    }
    remain -= got;
    if (remain == 0) {
      uint8_t crlf[2];
      if (!readRaw(crlf, 2)) err = true;
    }
    return got;
  }
};

// ---- 枠（種類1バイト + 長さ LE32）と、鳴らしたと仮定した計算 ----
struct TurnStats {
  uint8_t hdr[5];
  int hdrGot = 0;
  uint32_t frameRemain = 0;
  uint8_t frameType = 0;
  bool frameError = false;

  uint32_t pcmBytes = 0;
  uint32_t firstAudioAt = 0, lastAudioAt = 0, maxGapMs = 0;
  uint32_t segments = 0;

  bool playing = false;
  uint32_t playStartAt = 0, anchorAt = 0, playedBaseMs = 0, dryAt = 0;
  uint32_t underruns = 0, stallMs = 0;

  void onPcm(uint32_t now, uint32_t bytes) {
    const uint32_t before = pcmBytes / PCM_BYTES_PER_MS;
    if (playing && playedBaseMs + (now - anchorAt) >= before) {
      // 次が届く前に溜めが尽きた
      ++underruns;
      dryAt = anchorAt + (before - playedBaseMs);
      playedBaseMs = before;
      playing = false;
    }
    if (!firstAudioAt) firstAudioAt = now;
    else if (now - lastAudioAt > maxGapMs) maxGapMs = now - lastAudioAt;
    lastAudioAt = now;
    pcmBytes += bytes;
    const uint32_t after = pcmBytes / PCM_BYTES_PER_MS;
    if (!playing && after - playedBaseMs >= PREBUFFER_MS) {
      playing = true;
      anchorAt = now;
      if (!playStartAt) playStartAt = now;
      if (dryAt) { stallMs += now - dryAt; dryAt = 0; }
    }
  }

  void feed(uint32_t now, const uint8_t* b, size_t n) {
    size_t i = 0;
    while (i < n && !frameError) {
      if (frameRemain == 0) {
        hdr[hdrGot++] = b[i++];
        if (hdrGot < 5) continue;
        hdrGot = 0;
        frameType = hdr[0];
        frameRemain = uint32_t(hdr[1]) | (uint32_t(hdr[2]) << 8) | (uint32_t(hdr[3]) << 16) | (uint32_t(hdr[4]) << 24);
        const bool valid = frameType == 0x01 ? (frameRemain > 0 && frameRemain <= 4096)
                                             : (frameType == 0x02 && frameRemain <= 16U * 1024 * 1024);
        if (!valid) frameError = true;
        if (frameType == 0x01) ++segments;  // メタデータの枠の数（目安）
        continue;
      }
      const uint32_t take = min((uint32_t)(n - i), frameRemain);
      if (frameType == 0x02) onPcm(now, take);
      frameRemain -= take;
      i += take;
    }
  }
};

// ---- 小物 ----
static String sha256Hex(const String& body) {
  unsigned char digest[32];
  mbedtls_sha256((const unsigned char*)body.c_str(), body.length(), digest, 0);
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", digest[i]);
  hex[64] = 0;
  return String(hex);
}

static String jsonEscape(const String& s) {
  String out;
  for (size_t i = 0; i < s.length(); i++) {
    const char ch = s[i];
    if (ch == '"' || ch == '\\') { out += '\\'; out += ch; }
    else if ((uint8_t)ch < 0x20) out += ' ';
    else out += ch;
  }
  return out;
}

static void loadDeviceIdentity() {
  Preferences prefs;
  if (prefs.begin("device", true)) {
    g_mac = prefs.getString("mac", "");
    g_key = prefs.getString("auth_key", "");
    prefs.end();
  }
  if (g_mac.length() == 0) g_mac = WiFi.macAddress();
}

static void printStatus(const char* ev) {
  Serial.printf("[NET] {\"ev\":\"%s\",\"label\":\"%s\",\"wifi\":%d,\"ssid\":\"%s\",\"rssi\":%d,\"ch\":%d,\"ip\":\"%s\","
                "\"device_id\":\"%s\",\"has_key\":%d,\"tls_psram\":%d,\"heap_free\":%lu,\"psram_free\":%lu}\n",
                ev, jsonEscape(g_label).c_str(), WiFi.status() == WL_CONNECTED,
                jsonEscape(WiFi.SSID()).c_str(), WiFi.status() == WL_CONNECTED ? WiFi.RSSI() : 0,
                WiFi.channel(), WiFi.localIP().toString().c_str(),
                g_mac.c_str(), g_key.length() == 64, tls_memory::installed,
                (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                (unsigned long)heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
}

// ---- J: Wi-Fi へ繋ぐ ----
static void cmdJoin(const String& arg) {
  String ssid, pass;
  if (arg.length() == 0) {
    Preferences prefs;
    if (prefs.begin("wifi", true)) {
      ssid = prefs.getString("ssid", "");
      pass = prefs.getString("password", "");
      prefs.end();
    }
    if (ssid.length() == 0) {
      Serial.println("[NET] {\"ev\":\"join\",\"ok\":0,\"error\":\"no wifi in nvs\"}");
      return;
    }
  } else {
    const int tab = arg.indexOf('\t');
    ssid = tab < 0 ? arg : arg.substring(0, tab);
    pass = tab < 0 ? String("") : arg.substring(tab + 1);
  }
  WiFi.disconnect(true);
  delay(300);
  WiFi.mode(WIFI_STA);
  const uint32_t t = millis();
  WiFi.begin(ssid.c_str(), pass.c_str());
  while (WiFi.status() != WL_CONNECTED && millis() - t < 20000) delay(20);
  const bool ok = WiFi.status() == WL_CONNECTED;
  Serial.printf("[NET] {\"ev\":\"join\",\"label\":\"%s\",\"ok\":%d,\"ms\":%lu,\"ssid\":\"%s\",\"rssi\":%d,\"ch\":%d,"
                "\"bssid\":\"%s\",\"ip\":\"%s\",\"dns\":\"%s\"}\n",
                jsonEscape(g_label).c_str(), ok, (unsigned long)(millis() - t), jsonEscape(ssid).c_str(),
                ok ? WiFi.RSSI() : 0, WiFi.channel(), ok ? WiFi.BSSIDstr().c_str() : "",
                WiFi.localIP().toString().c_str(), WiFi.dnsIP().toString().c_str());
}

// ---- W / R: 会話のファームが使う Wi-Fi を入れ替える・戻す ----
// 実際に話して比べるときに使う。元の設定は "wifi_bak" に1回だけ控える（W を続けて打っても最初の設定が残る）。
static void cmdSaveWifi(const String& arg) {
  const int tab = arg.indexOf('\t');
  const String ssid = tab < 0 ? arg : arg.substring(0, tab);
  const String pass = tab < 0 ? String("") : arg.substring(tab + 1);
  if (ssid.length() == 0) {
    Serial.println("[NET] {\"ev\":\"wifi_saved\",\"ok\":0,\"error\":\"no ssid\"}");
    return;
  }
  String curSsid, curPass;
  Preferences prefs;
  if (prefs.begin("wifi", true)) {
    curSsid = prefs.getString("ssid", "");
    curPass = prefs.getString("password", "");
    prefs.end();
  }
  Preferences bak;
  bool ok = bak.begin("wifi_bak", false);
  String bakSsid;
  if (ok) {
    if (!bak.isKey("ssid") && curSsid.length() > 0) {
      bak.putString("ssid", curSsid);
      bak.putString("password", curPass);
    }
    bakSsid = bak.getString("ssid", "");
    bak.end();
  }
  ok = ok && prefs.begin("wifi", false);
  if (ok) {
    ok = prefs.putString("ssid", ssid) == ssid.length();
    prefs.putString("password", pass);
    prefs.end();
  }
  Serial.printf("[NET] {\"ev\":\"wifi_saved\",\"ok\":%d,\"ssid\":\"%s\",\"backup_ssid\":\"%s\"}\n",
                ok, jsonEscape(ssid).c_str(), jsonEscape(bakSsid).c_str());
}

static void cmdRestoreWifi() {
  Preferences bak;
  String ssid, pass;
  if (bak.begin("wifi_bak", false)) {
    ssid = bak.getString("ssid", "");
    pass = bak.getString("password", "");
    if (ssid.length() > 0) {
      Preferences prefs;
      if (prefs.begin("wifi", false)) {
        prefs.putString("ssid", ssid);
        prefs.putString("password", pass);
        prefs.end();
        bak.clear();
      } else {
        ssid = "";
      }
    }
    bak.end();
  }
  Serial.printf("[NET] {\"ev\":\"wifi_restored\",\"ok\":%d,\"ssid\":\"%s\"}\n", ssid.length() > 0, jsonEscape(ssid).c_str());
}

// ---- H: 接続だけを測る ----
static void handshakeOnce(const char* tag, const char* host, const char* ca, int i) {
  IPAddress ip;
  uint32_t t = millis();
  const bool dnsOk = WiFi.hostByName(host, ip) == 1;
  const uint32_t dnsMs = millis() - t;

  uint32_t tcpMs = 0;
  bool tcpOk = false;
  if (dnsOk) {
    WiFiClient plain;
    t = millis();
    tcpOk = plain.connect(ip, 443, 8000);
    tcpMs = millis() - t;
    plain.stop();
  }

  // 会話のファームの tls_ms と同じ測り方（名前解決・TCP・TLS をまとめた connect() の時間）
  uint32_t tlsMs = 0;
  bool tlsOk = false;
  if (tcpOk) {
    WiFiClientSecure secure;
    secure.setCACert(ca);
    secure.setHandshakeTimeout(15);
    t = millis();
    tlsOk = secure.connect(host, 443);
    tlsMs = millis() - t;
    secure.stop();
  }
  Serial.printf("[NET] {\"ev\":\"hs\",\"label\":\"%s\",\"host\":\"%s\",\"i\":%d,\"dns_ok\":%d,\"dns\":%lu,\"tcp_ok\":%d,\"tcp\":%lu,"
                "\"tls_ok\":%d,\"tls\":%lu,\"rssi\":%d}\n",
                jsonEscape(g_label).c_str(), tag, i, dnsOk, (unsigned long)dnsMs, tcpOk, (unsigned long)tcpMs,
                tlsOk, (unsigned long)tlsMs, WiFi.RSSI());
}

static void cmdHandshake(int count) {
  for (int i = 0; i < count; i++) {
    handshakeOnce("api", API_HOST, AMAZON_ROOT_CAS, i);
    delay(200);
    handshakeOnce("stt", STT_HOST, SONIOX_ROOT_CAS, i);
    delay(200);
  }
  Serial.printf("[NET] {\"ev\":\"hs_done\",\"label\":\"%s\",\"count\":%d}\n", jsonEscape(g_label).c_str(), count);
}

// ---- T: 会話1回ぶん ----
static void turnOnce(int i) {
  const String payload =
    String("{\"model\":\"ElevenLabs\",\"voice\":\"default\",") +
    "\"device_id\":\"" + g_mac + "\"," +
    "\"session_id\":\"net-test-" + String((unsigned long)esp_random(), HEX) + "\"," +
    "\"owner_id\":\"" + g_mac + "\"," +
    "\"fw\":\"net-test\"," +
    "\"backchannel_fired\":false," +
    "\"messages\":[{\"role\":\"user\",\"content\":\"" + TEST_TEXT + "\"}]}";
  const String req =
    String("POST ") + CHAT_PATH + " HTTP/1.1\r\n" +
    "Host: " + API_HOST + "\r\n" +
    "Content-Type: application/json\r\n" +
    "x-amz-content-sha256: " + sha256Hex(payload) + "\r\n" +
    (g_key.length() == 64 ? String(KEY_HEADER) + ": " + g_key + "\r\n" : String("")) +
    "Accept: text/event-stream\r\n" +
    "Connection: close\r\n" +
    "Content-Length: " + payload.length() + "\r\n\r\n" +
    payload;

  const int rssiStart = WiFi.RSSI();
  WiFiClientSecure client;
  client.setCACert(AMAZON_ROOT_CAS);
  client.setHandshakeTimeout(15);
  const uint32_t t0 = millis();
  const bool connected = client.connect(API_HOST, 443);
  const uint32_t tlsMs = millis() - t0;
  uint32_t sendMs = 0, headersAt = 0, firstByteAt = 0, recvEndAt = 0;
  int http = 0;
  const char* error = "";
  TurnStats st;
  BodyReader body(client);

  if (!connected) {
    error = "connect";
  } else {
    const uint32_t ts = millis();
    const size_t written = client.print(req);
    sendMs = millis() - ts;
    if (written != req.length()) {
      error = "send";
    } else {
      String line;
      bool chunked = false, first = true, headerOk = false;
      while (body.readLine(line, 1024)) {
        if (first) {
          first = false;
          const int sp = line.indexOf(' ');
          if (sp > 0) http = line.substring(sp + 1, sp + 4).toInt();
        } else if (line.length() == 0) {
          headerOk = true;
          break;
        } else {
          line.toLowerCase();
          if (line.startsWith("transfer-encoding:") && line.indexOf("chunked") > 0) chunked = true;
        }
      }
      headersAt = millis() - t0;
      if (!headerOk) error = "headers";
      else if (http != 200) error = "status";
      else if (!chunked) error = "not chunked";
      else {
        while (true) {
          const size_t n = body.read(g_buf, sizeof(g_buf));
          if (n == 0) break;
          const uint32_t now = millis();
          if (!firstByteAt) firstByteAt = now - t0;
          st.feed(now, g_buf, n);
          if (st.frameError) break;
        }
        recvEndAt = millis() - t0;
        if (st.frameError) error = "frame";
        else if (body.err) error = "body";
      }
    }
  }
  client.stop();

  const uint32_t audioMs = st.pcmBytes / PCM_BYTES_PER_MS;
  const uint32_t firstAudio = st.firstAudioAt ? st.firstAudioAt - t0 : 0;
  // 溜めに届かないほど短い返答は、受信の終わりで鳴らし始める
  const uint32_t playStart = st.playStartAt ? st.playStartAt - t0 : (st.pcmBytes ? recvEndAt : 0);
  const uint32_t recvSpan = (st.firstAudioAt && st.lastAudioAt > st.firstAudioAt) ? st.lastAudioAt - st.firstAudioAt : 0;
  const uint32_t kbps = recvSpan ? (uint32_t)((uint64_t)st.pcmBytes * 8 / recvSpan) : 0;
  Serial.printf("[NET] {\"ev\":\"turn\",\"label\":\"%s\",\"i\":%d,\"ok\":%d,\"error\":\"%s\",\"http\":%d,"
                "\"tls\":%lu,\"send\":%lu,\"headers\":%lu,\"first_byte\":%lu,\"first_audio\":%lu,\"play_start\":%lu,\"recv_end\":%lu,"
                "\"audio_ms\":%lu,\"underruns\":%lu,\"stall_ms\":%lu,\"max_gap\":%lu,\"kbps\":%lu,\"frames\":%lu,"
                "\"rssi_start\":%d,\"rssi_end\":%d}\n",
                jsonEscape(g_label).c_str(), i, error[0] == 0, error, http,
                (unsigned long)tlsMs, (unsigned long)sendMs, (unsigned long)headersAt, (unsigned long)firstByteAt,
                (unsigned long)firstAudio, (unsigned long)playStart, (unsigned long)recvEndAt,
                (unsigned long)audioMs, (unsigned long)st.underruns, (unsigned long)st.stallMs,
                (unsigned long)st.maxGapMs, (unsigned long)kbps, (unsigned long)st.segments,
                rssiStart, WiFi.RSSI());
}

static void cmdTurn(int count) {
  for (int i = 0; i < count; i++) {
    turnOnce(i);
    delay(1500);
  }
  Serial.printf("[NET] {\"ev\":\"turn_done\",\"label\":\"%s\",\"count\":%d}\n", jsonEscape(g_label).c_str(), count);
}

// ---- 命令 ----
static void handleLine(String line) {
  while (line.endsWith("\r") || line.endsWith("\n")) line.remove(line.length() - 1);
  if (line.length() == 0) return;
  const char cmd = line[0];
  String arg = line.length() > 2 ? line.substring(2) : String("");
  if (cmd == 'L') {
    arg.trim();
    g_label = arg.length() ? arg : String("none");
    printStatus("label");
  } else if (cmd == 'J') {
    cmdJoin(arg);
  } else if (cmd == 'W') {
    cmdSaveWifi(arg);
  } else if (cmd == 'R') {
    cmdRestoreWifi();
  } else if (cmd == 'S' || cmd == '?') {
    printStatus("status");
  } else if (cmd == 'H' || cmd == 'T') {
    if (WiFi.status() != WL_CONNECTED) {
      Serial.println("[NET] {\"ev\":\"error\",\"error\":\"wifi not connected\"}");
      return;
    }
    arg.trim();
    int count = arg.toInt();
    if (count <= 0) count = cmd == 'H' ? 10 : 3;
    if (count > 50) count = 50;
    if (cmd == 'H') cmdHandshake(count);
    else cmdTurn(count);
  } else {
    Serial.println("[NET] {\"ev\":\"error\",\"error\":\"unknown command\"}");
  }
}

void setup() {
  Serial.begin(115200);
  delay(500);
  tls_memory::init();
  WiFi.persistent(false);  // Wi-Fi の設定を NVS に書かない
  WiFi.mode(WIFI_STA);
  loadDeviceIdentity();
  printStatus("ready");
}

void loop() {
  static String line;
  while (Serial.available() > 0) {
    const char ch = (char)Serial.read();
    if (ch == '\n') {
      handleLine(line);
      line = "";
    } else if (line.length() < 256) {
      line += ch;
    }
  }
  delay(5);
}
