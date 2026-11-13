// toytalker_mini_v0.7 — AEC voice barge-in（実機確認済み構成）+ OTA
// v0.5安定版・v0.6音量方式を保持。このフォルダには最新のソースだけを置き、配布した版は
// git のタグ fw-<版> で残す（tools/publish-firmware.sh が付ける）。版は FirmwareVersion.h。
// OTA: OtaUpdater.h / AmazonRootCA.h、起動時の更新確認（startNormalOperation）、LED_BLINK_OTA。
// TLS は全接続で証明書を検証する（0.7.6、ロードマップ6）: Lambda（CloudFront）と OTA は AmazonRootCA.h、Soniox は SonioxRootCA.h。
// デバイス鍵（DeviceAuth.h）を Lambda への全要求に添える。
// NLP既定=AGGR（実機構成）。設計は docs/esp32-ota-settings-plan.md。
// 受信(producer)とI2S再生(consumer)をFreeRTOSタスクで分離し、PSRAMリングバッファで吸収
// LED制御はすべてdigitalWrite

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include "StreamCompletion.h"
#include <driver/i2s_std.h>
#include <esp_wifi.h>
#include <esp_mac.h>  // esp_read_mac (BLEアドバタイズ名用)
#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <Preferences.h>
#include <esp_heap_caps.h>  // heap_caps_get_largest_free_block ([DIAG]/[MEM]計測用)
#include <atomic>
#include <esp_timer.h>
#include <math.h>
#include "VoiceLevelGate.h"
#include "VoiceLevelMeter.h"
#include "BargeInFlag.h"
#include "ChunkedBodyDecoder.h"
#include "AecMonitor.h"
#include "TlsMemory.h"
#include "SttMicFilter.h"
#include "SonioxPreconnect.h"
#include "FirmwareVersion.h"
#include "OtaUpdater.h"
#include "PowerSense.h"
#include "TurnReport.h"
#include "PlaybackLimiter.h"
#include <Preferences.h>
#include "AmazonRootCA.h"
#include "SonioxRootCA.h"
#include "DeviceAuth.h"
#include <esp_arduino_version.h>
#include <mbedtls/sha256.h>  // sha256Hex（CloudFront 経由の POST に本文ハッシュを添える）

// ==== デバッグ設定 ====
#define DEBUG_MEMORY 0

// ==== WiFi（NVSから読み込み） ====
String wifiSSID = "";
String wifiPassword = "";
String pendingSSID = "";
String pendingPassword = "";
Preferences preferences;

// ==== BLE UUIDs（アプリ側toy.tsxと一致） ====
#define SERVICE_UUID           "12345678-1234-1234-1234-123456789abc"
#define CHAR_SSID_UUID         "12345678-1234-1234-1234-123456789ab1"
#define CHAR_PASSWORD_UUID     "12345678-1234-1234-1234-123456789ab2"
#define CHAR_COMMAND_UUID      "12345678-1234-1234-1234-123456789ab3"
#define CHAR_STATUS_UUID       "12345678-1234-1234-1234-123456789ab4"
#define CHAR_MAC_UUID          "12345678-1234-1234-1234-123456789ab5"

// ==== デバイスモード ====
enum DeviceMode {
  MODE_NORMAL,
  MODE_BLE_PROV,
  MODE_CONNECTING
};
DeviceMode currentMode = MODE_CONNECTING;

// ==== BLE ====
BLEServer* pServer = NULL;
BLECharacteristic* pStatusChar = NULL;
bool bleDeviceConnected = false;
bool oldBleDeviceConnected = false;
String deviceMacAddress = "";

// ==== API（CloudFront の固定ドメイン。docs/roadmap.md の3、0.7.4 から） ====
// Function URL のホスト名はスタックを作り直すと変わるので、本体はこの名前だけを知る。経路で Lambda が分かれる。
// CloudFront → Lambda は署名付き（OAC）なので、POST は本文の SHA-256 を x-amz-content-sha256 で添える（sha256Hex）。
// 環境を変えるときはここだけ（infra/config/stages.ts の apiDomain）。
#ifndef TOYTALKER_API_HOST
#define TOYTALKER_API_HOST "api-rnd.zakicorp.com"
#endif

// ==== Lambda (TTS) - Binary Streaming ====
const char* LAMBDA_HOST = TOYTALKER_API_HOST;
const char* LAMBDA_PATH = "/chat-mcu";

// ==== Lambda (Backchannel) ====
const char* BACKCHANNEL_HOST = TOYTALKER_API_HOST;
const char* BACKCHANNEL_PATH = "/backchannel-mcu";

// ==== Lambda (Soniox Key) ====
const char* SONIOX_LAMBDA_URL = "https://" TOYTALKER_API_HOST "/stt-token";

// ==== Soniox ====
const char* SONIOX_WS_URL = "stt-rt.soniox.com";
const int SONIOX_WS_PORT = 443;
String sonioxKey;
// 一時キーは Lambda に頼む寿命（SONIOX_KEY_TTL_SEC）で発行される。期限切れのキーで WS を開くと会話が
// 始まらないので、取得から SONIOX_KEY_MAX_AGE_MINUTES を越えたら WS を開く前に取り直す。
// 寿命との差（1分）は判定から接続までのズレ用。再生中は先行接続ワーカー（Core 0）で、
// 先行接続が無いときは録音開始前に loop() で取り直す。
const int SONIOX_KEY_TTL_SEC = 180;              // Lambda に頼む寿命。指定しない古いファームは1時間
const uint32_t SONIOX_KEY_MAX_AGE_MINUTES = 2;   // 2026-10-28から試用。問題なければこれが本番値
uint32_t sonioxKeyFetchedMs = 0;  // loop() だけが書く。ワーカーは読むだけ
String sonioxModel = "stt-rt-v4";  // 起動時に1回だけ設定。以後は読み取り専用（ワーカーからも読む）

// ==== I2S PIN ==== (v0.2基板: マイク/アンプでBCLK・WSも分離)
#define PIN_MIC_BCLK 48
#define PIN_MIC_WS   33
#define PIN_MIC_DATA 34
#define PIN_AMP_BCLK 37
#define PIN_AMP_WS   36
#define PIN_AMP_DIN  38
#define PIN_AMP_SD   39
#define SAMPLE_RATE_STT 16000
#define SAMPLE_RATE_TTS 24000

// ==== LED & Button ====
#define PIN_LED      40
#define PIN_BUTTON   35

// ==== 電源・温度・充電（v0.2基板新設。読み取りは PowerSense.h） ====
#define PIN_VBAT_ADC   1   // 470k×2分圧: 実電圧=読み値×2。ADC1系なのでWiFi中も測定可
#define PIN_BOARD_TEMP 2   // TH2分圧(基板温度)
#define PIN_CHG_STAT1  13  // BQ25185 STAT1(100kプルアップ済みオープンドレイン)
#define PIN_CHG_STAT2  14  // BQ25185 STAT2
// 録音中（待機側）に読んで覚え、会話の要求の "device" に添える。送る時に読まないのは要求を遅らせないため
const uint32_t POWER_SENSE_INTERVAL_MS = 30000;
static PowerReading powerReading;
static bool powerReadingValid = false;
static uint32_t powerReadMs = 0;

// LED状態（PWMなし、digitalWriteのみ）
enum LEDMode {
  LED_OFF,
  LED_ON,          // 点灯 = 録音中（話してOK）
  LED_BLINKING,    // 600ms周期 = 再生中
  LED_BLINK_SLOW,  // 1.2s周期 = 準備中（起動〜録音準備完了）
  LED_BLINK_FAST,  // 300ms周期 = BLE設定モード
  LED_BLINK_OTA    // 120ms周期 = ファーム更新中（電源を切らない）
};

volatile LEDMode currentLEDMode = LED_OFF;
volatile bool blinkState = false;
hw_timer_t* ledTimer = NULL;
bool ampOn = false;
BargeInFlag bargeInRequested;
volatile bool sonioxPreconnectPending = false;  // 再生中の先行WS接続が進行中か

// (最初の関数定義。Arduinoの自動プロトタイプはこの直前に入るので、enum等より後に置く)
// OTA後の初回起動でコアが自動で有効印を付けるのを止める。有効印は startNormalOperation() で
// Wi-Fi接続とSonioxキー取得に成功してから ota::confirmRunningImage() が付ける。
// それより前に落ちる版はブートローダーが旧版へ戻す。コア側はCなので extern "C" が要る。
extern "C" bool verifyRollbackLater() { return true; }

void IRAM_ATTR onBargeInButton() {
  bargeInRequested.setFromISR(PIN_AMP_SD);
}

// 確保失敗フックでは固定領域への記録だけ行う。Serialやheap APIを呼ばない。
static portMUX_TYPE allocFailureMux = portMUX_INITIALIZER_UNLOCKED;
static uint32_t allocFailureCount = 0;
static size_t allocFailureLastSize = 0;
static uint32_t allocFailureLastCaps = 0;

void IRAM_ATTR recordAllocationFailure(size_t size, uint32_t caps, const char*) {
  portENTER_CRITICAL_SAFE(&allocFailureMux);
  ++allocFailureCount;
  allocFailureLastSize = size;
  allocFailureLastCaps = caps;
  portEXIT_CRITICAL_SAFE(&allocFailureMux);
}

// loop側の会話境界で出力。失敗のない回もdelta=0を残す。
void logMemoryCheckpoint(const char* stage) {
  static uint32_t reportedFailures = 0;
  uint32_t count, caps;
  size_t size;
  portENTER_CRITICAL_SAFE(&allocFailureMux);
  count = allocFailureCount;
  size = allocFailureLastSize;
  caps = allocFailureLastCaps;
  portEXIT_CRITICAL_SAFE(&allocFailureMux);
  Serial.printf("[ALLOC_FAIL] checkpoint=%s delta=%lu total=%lu last_size=%u last_caps=0x%08lX\n",
                stage, (unsigned long)(count - reportedFailures), (unsigned long)count,
                (unsigned)size, (unsigned long)caps);
  reportedFailures = count;
  // 内部RAMとPSRAMの管理情報・canaryを検査。再生中の読み取りループでは実行しない。
  bool intact = heap_caps_check_integrity_all(true);
  Serial.printf("[HEAP_CHECK] checkpoint=%s ok=%d internal_free=%lu max_blk=%lu\n",
                stage, intact,
                (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  tls_memory::printStats(stage);
}


// ボタン状態
int lastButtonReading = HIGH;
int buttonState = HIGH;
int lastButtonState = HIGH;
unsigned long lastDebounceTime = 0;
const unsigned long debounceDelay = 50;

unsigned long buttonPressStart = 0;
bool buttonLongPressTriggered = false;
const unsigned long LONG_PRESS_MS = 1500;

// ==== WiFi接続状態（イベントベース） ====
volatile bool wifiConnected = false;
volatile bool wifiGotIP = false;

// ==== Soniox STT 状態 ====
WebSocketsClient ws;
static SonioxPreconnect sonioxPreconnect;
static bool sonioxPlaybackPhase = false; // loop-only; worker never changes UI/STT state
String partialText = "";
String sonioxFinalBuf = "";
String lastFinalText = "";
unsigned long lastPartialMs = 0;
// 話し終わりの猶予（2026-11-08、ロードマップ6。アプリの「ふつう」と同じ動き: app/app/(tabs)/chat.tsx）。
// Soniox の終端（<end>）が来ても STT_GRACE_MS 待ち、その間に声（ブロックRMS ≥ STT_GRACE_SPEECH_RMS）か
// 新しい文字が出たら同じ発話として聞き続ける（Soniox は同じ WS で続きを文字にし、次の <end> を送る）。
// 声が物音だっただけなら次の <end> が来ないので、STT_GRACE_RESUME_MAX_MS 新しい文字が無ければ送る。
// 以前の「途中結果が 800ms 更新されなければ送る」予備判定（END_SILENCE_MS）は、Soniox の待ちと関係なく
// 小さい子の言葉の切れ目で送ってしまうので外した。サーバーから値を受け取る形はロードマップ25（OTA）。
const unsigned long STT_GRACE_MS = 600;             // 0 なら <end> ですぐ送る（Soniox の既定のまま）
const unsigned long STT_GRACE_RESUME_MAX_MS = 2000;  // 0.7.24: 3000 → 2000
// 0.7.24: 1200 → 2500。1200 では周りの音（猶予中の最大 1250〜1980）を声と数えて送信が 2〜6 秒遅れた。
// 声は 3700〜6600 だった（2026-11-13、試験機、ケースなし）。新しい文字が出れば音量に関係なく待つので、小さい声の続きは文字で拾う
const uint32_t STT_GRACE_SPEECH_RMS = 2500;         // [GRACE] の speech_peak_rms / grace_peak_rms を見て詰める
// 救済: Soniox が <end> を送らないまま黙ったとき（通常は Soniox の最大待ちで <end> が来る）
const unsigned long STT_STALL_MS = 4000;
struct SttGraceState {
  unsigned long firstEndMs = 0;   // 最初の <end>（0 = まだ）
  unsigned long graceStartMs = 0; // 猶予中（0 = 猶予していない）
  unsigned long resumeStartMs = 0;// 猶予中に声が出てからの待ち（0 = 待っていない）
  uint32_t resumes = 0;
  uint32_t speechPeakRms = 0;     // 録音開始から最初の <end> までのブロックRMS最大（しきい値の目安）
  uint32_t gracePeakRms = 0;      // 猶予中のブロックRMS最大
};
static SttGraceState sttGrace;
// 本体側の計測（TurnReport.h）。聞き取りの途中の値。finishUtterance で sttReport へ写して次の要求に添える
static SttReport sttProgress, sttReport;
static uint32_t sttRecordStartMs = 0;    // 録音開始（startSTTRecording）
static bool sttWsWaitPending = false;    // 録音開始時に Soniox が未接続だった（繋がった時刻を ws_wait_ms に）
static uint32_t lastTextChangeMs = 0;    // 途中結果の文字が最後に変わった時刻
static uint32_t sonioxDisconnects = 0, sonioxErrors = 0;  // 前の要求から数える
static bool sonioxClosingOnPurpose = false;  // 自分で切るとき（再生中の先行接続の張り直し）。切断の回数に数えない
// ---- 待ち受けの見張り（0.7.19、ロードマップ20・24）----
// 切れたら戻す: 聞き取り中のはず（sttWanted）なのに Soniox とつながっていなければ、loop() がつなぎ直す。
//   以前は DISCONNECTED で isRecording を false にするだけで、電源を入れ直すまで無反応だった。
// 無音なら休む: 文字が出ないまま STT_IDLE_SLEEP_MS 聞き続けたら、Soniox を閉じて休む（Soniox は無音でも
//   接続の時間で課金する）。休み中は LED がゆっくり明滅し、ボタンを押すと聞き取りに戻る。
const unsigned long STT_IDLE_SLEEP_MS = 180000;    // アプリ（ロードマップ24）と同じ3分
const unsigned long STT_RECOVER_FIRST_MS = 1500;   // 切れたのに気づいてから、つなぎ直すまで
const unsigned long STT_RECOVER_MAX_MS = 30000;    // 続けて失敗したら倍々でここまで間を空ける
const unsigned long STT_RECOVER_STABLE_MS = 30000; // これだけつながっていたら、間を最初の値に戻す
const unsigned long IDLE_BREATH_MS = 4000;         // 休み中の LED の明滅1回の長さ
static bool sttWanted = false;       // 聞き取り中のはず（startSTTRecording で true、返答の送信・休み・BLE で false）
static bool sttRecovering = false;   // つなぎ直しの startSTTRecording（無音の時計を巻き戻さない）
static bool idleSleeping = false;    // 休み中
static uint32_t sttIdleSinceMs = 0;  // この待ち受けを始めた時刻
static uint32_t sttDownSinceMs = 0;  // 切れているのに気づいた時刻（0 = つながっている）
static uint32_t sttUpSinceMs = 0;    // つながった時刻（0 = 切れている）
static uint32_t sttRecoverWaitMs = STT_RECOVER_FIRST_MS;
static uint32_t idleSleepStartMs = 0;
bool armed = false;
bool isRecording = false;
bool endpointDetected = false;
bool i2sRecordReady = false;
bool micInstalled = false;
// loopタスク専用。大きな配列をloop/startSTTRecordingのスタックに重ねない。
// 再生監視タスクは自身のraw[320]を使用し、ここには触れない。
static int32_t sttRaw[512];
static int16_t sttPcm[512];
static SttMicFilter sttMicFilter;
static bool sttInputFirstBlock = true;
unsigned long sttRestartMs = 0;  // STT再開計測用

// ==== TTS 受信状態 ====
int curSegmentId = -1;
String responseText = "";
uint8_t* currentPcmBuffer = NULL;
size_t currentPcmSize = 0;
const uint32_t TTS_SEGMENT_GAP_MS = 400;  // 文の区切りに追加する間（先頭・末尾には入れない）
bool ttsAudioQueued = false;
bool ttsGapPending = false;
static std::atomic<uint32_t> ttsTurnStartMs{0};
static std::atomic<bool> ttsFirstWriteLogged{false};
static std::atomic<uint32_t> ttsFirstWriteAtMs{0};  // 返答の音声を最初に I2S へ渡した時刻（再生タスクが書く）
static uint32_t ttsPcmBytes = 0, ttsSegments = 0;   // loopのみ。このターンに受けた返答の音声バイト数・区切り数
static bool ttsFirstPcmLogged = false;  // loopのみ
static uint32_t ttsRingWaitMs = 0;      // producerのみ
static uint32_t sonioxServiceMaxMs = 0;

bool sonioxKeyIsOld() {
  return millis() - sonioxKeyFetchedMs >= SONIOX_KEY_MAX_AGE_MINUTES * 60UL * 1000UL;  // 符号なしの差なので millis() の桁あふれでも正しい
}

// 本文の SHA-256（16進小文字64文字）。CloudFront → Lambda の署名（OAC）が本文ハッシュを含むため、
// POST はこの値を x-amz-content-sha256 ヘッダーで添える（無いと Function URL が IAM 認証になったとき 403）。
String sha256Hex(const String& body) {
  unsigned char digest[32];
  mbedtls_sha256((const unsigned char*)body.c_str(), body.length(), digest, 0);
  char hex[65];
  for (int i = 0; i < 32; i++) sprintf(hex + i * 2, "%02x", digest[i]);
  hex[64] = 0;
  return String(hex);
}

// Lambda に GET して本文を返す。WiFi 切替直後などの一時的な失敗に備えて attempts 回まで試す。
int httpGetWithRetry(const String& url, String& body, int attempts) {
  HTTPClient http;
  int code = -1;
  for (int attempt = 1; attempt <= attempts; attempt++) {
    http.setTimeout(5000);
    http.begin(url, AMAZON_ROOT_CAS);  // 証明書を検証する（CloudFront は Amazon Trust Services）
    if (device_auth::available()) http.addHeader(device_auth::KEY_HEADER, device_auth::value());
    code = http.GET();
    if (code == 200) {
      body = http.getString();
      http.end();
      return code;
    }
    Serial.printf("⚠️ Lambda GET failed (HTTP %d), attempt %d/%d\n", code, attempt, attempts);
    http.end();
    if (attempt < attempts) delay(1000);
  }
  return code;
}

// キーだけを取る軽い呼び出し。fw を付けないので Lambda は OTA 判定も版の記録もしない（last_seen だけ）。
// device_id とデバイス鍵は付ける（0.7.6から。本番で「登録済みの機器か」と鍵を見るため。付けないとアプリ扱いでトークンを求められる）。
// loop() からもワーカーからも呼ばれる。グローバルには触らず keyOut に返す。
bool fetchSonioxKeyOnly(String& keyOut) {
  const uint32_t t0 = millis();
  String body;
  if (httpGetWithRetry(String(SONIOX_LAMBDA_URL) + "?device_id=" + deviceMacAddress + "&ttl=" + SONIOX_KEY_TTL_SEC, body, 2) != 200) {
    Serial.println("[SONIOX_KEY] refresh failed: Lambda unreachable");
    return false;
  }
  DynamicJsonDocument doc(1024);
  if (deserializeJson(doc, body) || !doc.containsKey("api_key")) {
    Serial.println("[SONIOX_KEY] refresh failed: bad response");
    return false;
  }
  keyOut = doc["api_key"].as<String>();
  Serial.printf("[SONIOX_KEY] refreshed ms=%lu\n", (unsigned long)(millis() - t0));
  return !keyOut.isEmpty();
}

String sonioxStartMessageFor(const String& key);
void finishUtterance(const char* why);

// 先行接続ワーカー（Core 0）で接続前に走る。古ければ取り直し、新しいキーで開始メッセージを作る。
// sonioxKey と sonioxKeyFetchedMs は loop() のものなので書かない（finishSonioxPreconnect が写す）。
bool prepareSonioxKeyOnWorker(String& startMessageOut, String& keyOut) {
  if (!sonioxKeyIsOld()) return false;
  Serial.printf("[SONIOX_KEY] old (age_s=%lu); refreshing on worker\n",
                (unsigned long)((millis() - sonioxKeyFetchedMs) / 1000));
  if (!fetchSonioxKeyOnly(keyOut)) return false;
  startMessageOut = sonioxStartMessageFor(keyOut);
  return true;
}

// loop() で WS を直接開く直前に呼ぶ。古ければ取り直す（1〜2秒。先行接続が無い回だけ）。
void refreshSonioxKeyIfOld(const char* why) {
  if (!sonioxKeyIsOld()) return;
  Serial.printf("[SONIOX_KEY] old (age_s=%lu); refreshing on loop (%s)\n",
                (unsigned long)((millis() - sonioxKeyFetchedMs) / 1000), why);
  String key;
  if (fetchSonioxKeyOnly(key)) {
    sonioxKey = key;
    sonioxKeyFetchedMs = millis();
  }
}

String sonioxStartMessageFor(const String& key) {
  return "{\"api_key\":\"" + key + "\","
         "\"model\":\"" + sonioxModel + "\","
         "\"audio_format\":\"pcm_s16le\",\"sample_rate\":16000,\"num_channels\":1,"
         "\"enable_partial_results\":true,\"enable_endpoint_detection\":true,"
         "\"language_hints\":[\"ja\",\"en\"]}";
}

String sonioxStartMessage() { return sonioxStartMessageFor(sonioxKey); }

// Soniox の WebSocket を証明書の検証つきで設定する（接続は ws.loop() か先行接続ワーカーが行う）。
// beginSSL は CA を渡さないと setInsecure になる（WebSocketsClient.cpp）ので、beginSslWithCA を使う
void beginSonioxWs() {
  ws.beginSslWithCA(SONIOX_WS_URL, SONIOX_WS_PORT, "/transcribe-websocket", SONIOX_ROOT_CAS);
}

bool sonioxIsConnected() {
  return !sonioxPreconnect.ownsClient() && ws.isConnected();
}

void finishSonioxPreconnect() {
  SonioxPreconnect::Result result;
  if (!sonioxPreconnect.takeResult(result, webSocketEvent)) return;
  Serial.printf("[WS_PRECONNECT] elapsed_ms=%lu ready=%d cancelled=%d stack_free=%lu prepare_ms=%lu key_refreshed=%d\n",
                (unsigned long)result.elapsedMs, result.ready, result.cancelled, (unsigned long)result.stackFree,
                (unsigned long)result.prepareMs, result.keyRefreshed);
  if (result.keyRefreshed) {
    // ワーカーが取った新しいキーを loop() の状態へ写す（接続に失敗していてもキー自体は有効）
    sonioxKey = result.key;
    sonioxKeyFetchedMs = result.keyFetchedMs;
  }
  sonioxPreconnectPending = false;
  if (result.ready) sonioxConnectionReady(); // start message was already sent by the worker
}

void prepareSonioxDuringPlayback() {
  sonioxPlaybackPhase = true;
  finishSonioxPreconnect();
  if (sonioxPreconnect.ownsClient()) return;
  sonioxClosingOnPurpose = true;   // disconnect() は DISCONNECTED を同じ呼び出しの中で出す
  ws.disconnect();
  sonioxClosingOnPurpose = false;
  beginSonioxWs();
  ws.onEvent(webSocketEvent);
  ws.enableHeartbeat(15000, 3000, 2);
  sonioxPreconnectPending = true;
  const bool background = sonioxPreconnect.start(sonioxStartMessage(), prepareSonioxKeyOnWorker);
  Serial.printf("[WS_PRECONNECT] started background=%d core=0\n", background);
}

// During playback, connect/start runs on Core 0 while loop keeps receiving TTS.
// Connected-client polling and all application callbacks stay on loop.
void serviceSoniox(const char* stage) {
  finishSonioxPreconnect();
  if (sonioxPreconnect.ownsClient()) return;
  if (sonioxPlaybackPhase && !ws.isConnected() && sonioxPreconnect.available()) {
    if (bargeInRequested) return; // STT restart will decide how to reconnect
    if (sonioxPreconnect.start(sonioxStartMessage(), prepareSonioxKeyOnWorker)) {
      sonioxPreconnectPending = true;
      return;
    }
  }
  const uint32_t started = millis();
  const bool connectedBefore = ws.isConnected();
  ws.loop();
  const uint32_t elapsed = millis() - started;
  if (elapsed > sonioxServiceMaxMs) sonioxServiceMaxMs = elapsed;
  if (elapsed >= 50) {
    Serial.printf("[WS_TIMING] stage=%s blocked_ms=%lu connected_before=%d connected_after=%d\n",
                  stage, (unsigned long)elapsed, connectedBefore, ws.isConnected());
  }
}

void logFirstTtsWrite() {
  if (!ttsFirstWriteLogged.exchange(true)) {
    ttsFirstWriteAtMs.store(millis());
    Serial.printf("[LATENCY] first_tts_i2s_ms=%lu (copy completion, not acoustic start)\n",
                  (unsigned long)(millis() - ttsTurnStartMs.load()));
  }
}

// 終了待ちの内訳を計測。出力は最初の録音パケット送信後にまとめる。
// lastI2sWriteMsはDMAへのコピー完了時刻であり、スピーカーの発声終了時刻ではない。
static std::atomic<uint32_t> lastI2sWriteMs{0};
static std::atomic<uint32_t> playbackI2sBytes{0};
static i2s_chan_handle_t micRx = nullptr;
static i2s_chan_handle_t playbackTx = nullptr;
static AecMonitor aecMonitor;  // internal SRAM: ISR capture queues must not be in PSRAM
static portMUX_TYPE playbackDmaMux = portMUX_INITIALIZER_UNLOCKED;
static uint32_t playbackDmaSize = 0, playbackDmaOverflows = 0;
static uint32_t lastPlaybackDmaOverflows = 0;
static constexpr size_t PLAY_DMA_COUNT = 8;
static constexpr size_t PLAY_DMA_FRAMES = AEC_TX_SAMPLES; // actual 1023 frames / 4092 bytes
struct DmaTailTiming {
  bool valid = false;
  bool confirmed = false;
  uint32_t blockBytes = 0;
  uint32_t confirmAfterBytes = 0;
  uint32_t tailPaddingUs = 0;
  int64_t confirmedUs = 0;
  int64_t ampOffUs = 0;
};
static DmaTailTiming dmaTailTiming;

bool IRAM_ATTR onMicDma(i2s_chan_handle_t, i2s_event_data_t* event, void*) {
  aecMonitor.captureRx(event);
  return false;
}
bool IRAM_ATTR onPlaybackDma(i2s_chan_handle_t, i2s_event_data_t* event, void*) {
  portENTER_CRITICAL_ISR(&playbackDmaMux);
  playbackDmaSize = event->size;
  portEXIT_CRITICAL_ISR(&playbackDmaMux);
  aecMonitor.captureTx(event);
  return false;
}
bool IRAM_ATTR onPlaybackDmaOverflow(i2s_chan_handle_t, i2s_event_data_t*, void*) {
  portENTER_CRITICAL_ISR(&playbackDmaMux);
  ++playbackDmaOverflows;
  portEXIT_CRITICAL_ISR(&playbackDmaMux);
  return false;
}

uint32_t i2sTimeoutMs(TickType_t ticks) {
  return ticks == portMAX_DELAY ? UINT32_MAX : ticks * portTICK_PERIOD_MS;
}
esp_err_t readMicI2s(void* data, size_t len, size_t* bytes, TickType_t timeout) {
  *bytes = 0;
  return micRx ? i2s_channel_read(micRx, data, len, bytes, i2sTimeoutMs(timeout)) : ESP_ERR_INVALID_STATE;
}
esp_err_t releaseI2sChannel(i2s_chan_handle_t& channel) {
  if (!channel) return ESP_OK;
  esp_err_t err = i2s_channel_disable(channel);
  if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) return err;
  err = i2s_del_channel(channel);
  if (err == ESP_OK) channel = nullptr;
  return err;
}

// 最後のバッファ内の位置を知るため、相槌・区切り無音も含む全コピー量を数える。
esp_err_t writePlaybackI2s(const void* data, size_t len, size_t* written, TickType_t timeout) {
  *written = 0;
  esp_err_t err = playbackTx ? i2s_channel_write(playbackTx, data, len, written, i2sTimeoutMs(timeout))
                            : ESP_ERR_INVALID_STATE;
  playbackI2sBytes.fetch_add(*written, std::memory_order_relaxed);
  return err;
}

// 新APIのEOF callbackから実バッファサイズと空きキュー溢れを取得する。
// 音声参照のcapture欠落は別途 [AEC_STATS] で扱う。
void pollPlaybackI2sEvents(bool monitoring) {
  portENTER_CRITICAL(&playbackDmaMux);
  uint32_t bytes = playbackDmaSize;
  uint32_t overflows = playbackDmaOverflows;
  portEXIT_CRITICAL(&playbackDmaMux);
  if (monitoring && (bytes != dmaTailTiming.blockBytes || overflows != lastPlaybackDmaOverflows))
    dmaTailTiming.valid = false;
  dmaTailTiming.blockBytes = bytes;
  lastPlaybackDmaOverflows = overflows;
}

void beginDmaTailTiming(bool writerStopped) {
  dmaTailTiming = DmaTailTiming{};
  pollPlaybackI2sEvents(false);  // 再生中の古いイベントを取り除く
  uint32_t total = playbackI2sBytes.load(std::memory_order_relaxed);
  uint32_t block = dmaTailTiming.blockBytes;
  if (!writerStopped || total == 0 || block == 0 || block > PLAY_DMA_FRAMES * 4 || block % 4 || total % 4) return;
  uint32_t used = total % block;
  if (used == 0) used = block;
  // 残りを埋め、他のN-1個も埋め、元のバッファに最初の1フレームを書けるまで。
  // 再取得はドライバのDMA完了キューを待つ。IRQ時刻そのものではなく完了確認の上限時刻。
  dmaTailTiming.confirmAfterBytes = PLAY_DMA_COUNT * block - used + 4;
  dmaTailTiming.tailPaddingUs = (uint64_t)(block - used) * 1000000 / (SAMPLE_RATE_TTS * 4);
  dmaTailTiming.valid = true;
}
static uint32_t turnTimingSequence = 0;
struct TurnEndTiming {
  bool pending = false;
  bool firstReadSeen = false;
  bool interrupted = false;
  bool flushCompleted = false;
  bool wsReadyAtRecord = false;
  uint32_t turn = 0;
  uint32_t receiveEndMs = 0;
  uint32_t lastWriteMs = 0;
  uint32_t parkedMs = 0;
  uint32_t flushWriteMs = 0;
  uint32_t flushWsMs = 0;
  uint32_t flushEndMs = 0;
  uint32_t ampOffMs = 0;
  uint32_t micSetupDoneMs = 0;
  uint32_t recordOnMs = 0;
  uint32_t firstReadMs = 0;
};
static TurnEndTiming turnEndTiming;
// このターンの記録（loopのみ）と、次の要求に添える前のターンの記録（TurnReport.h）
static TurnReport turnReport, lastTurnReport;

void printTurnEndTiming(uint32_t firstSendMs) {
  if (!turnEndTiming.pending) return;
  const TurnEndTiming& t = turnEndTiming;
  Serial.printf("[TURN_END] turn=%lu interrupted=%d recv_end_ms=%lu last_i2s_copy_ms=%lu stop_return_ms=%lu flush_end_ms=%lu flush_ok=%d flush_write_ms=%lu flush_ws_ms=%lu\n",
                (unsigned long)t.turn, t.interrupted, (unsigned long)t.receiveEndMs,
                (unsigned long)t.lastWriteMs, (unsigned long)t.parkedMs,
                (unsigned long)t.flushEndMs, t.flushCompleted,
                (unsigned long)t.flushWriteMs, (unsigned long)t.flushWsMs);
  Serial.printf("[TURN_END] turn=%lu amp_off_ms=%lu mic_setup_done_ms=%lu record_on_ms=%lu ws_ready=%d first_read_ms=%lu first_send_ms=%lu amp_to_mic_ms=%lu amp_to_send_ms=%lu\n",
                (unsigned long)t.turn, (unsigned long)t.ampOffMs,
                (unsigned long)t.micSetupDoneMs, (unsigned long)t.recordOnMs,
                t.wsReadyAtRecord, (unsigned long)t.firstReadMs, (unsigned long)firstSendMs,
                (unsigned long)(t.micSetupDoneMs - t.ampOffMs),
                (unsigned long)(firstSendMs - t.ampOffMs));
  Serial.printf("[DMA_TAIL] turn=%lu valid=%d confirmed=%d block_bytes=%lu tail_padding_us=%lu confirmed_us=%lld after_confirm_us=%lld\n",
                (unsigned long)t.turn, dmaTailTiming.valid, dmaTailTiming.confirmed,
                (unsigned long)dmaTailTiming.blockBytes, (unsigned long)dmaTailTiming.tailPaddingUs,
                (long long)dmaTailTiming.confirmedUs,
                (long long)(dmaTailTiming.valid && dmaTailTiming.confirmed ? dmaTailTiming.ampOffUs - dmaTailTiming.confirmedUs : -1));
  turnEndTiming.pending = false;
}

// ==== 相槌（Backchannel）状態 ====
bool backchannelEnabled = true;
const int BACKCHANNEL_TRIGGER_CHARS = 7;

int utf8Len(const String& s) {
  int count = 0;
  for (int i = 0; i < s.length(); ) {
    uint8_t c = (uint8_t)s.charAt(i);
    if (c < 0x80) i += 1;
    else if (c < 0xE0) i += 2;
    else if (c < 0xF0) i += 3;
    else i += 4;
    count++;
  }
  return count;
}
volatile bool backchannelFetching = false;
volatile bool backchannelReady = false;
volatile bool backchannelFired = false;
volatile bool backchannelAbort = false;
uint8_t* backchannelPcm = NULL;
size_t backchannelPcmSize = 0;
String backchannelText = "";
TaskHandle_t backchannelTaskHandle = NULL;

const int MAX_PAST_BACKCHANNELS = 10;
String pastBackchannels[MAX_PAST_BACKCHANNELS];
int pastBackchannelCount = 0;

void addPastBackchannel(const String& text) {
  if (pastBackchannelCount >= MAX_PAST_BACKCHANNELS) {
    for (int i = 0; i < pastBackchannelCount - 1; i++) {
      pastBackchannels[i] = pastBackchannels[i + 1];
    }
    pastBackchannelCount--;
  }
  pastBackchannels[pastBackchannelCount] = text;
  pastBackchannelCount++;
}

// ==== セッションID ====
String sessionId = "";

// ==== 会話履歴 ====
const int MAX_HISTORY = 5;
struct Message {
  String role;
  String content;
};
Message conversationHistory[MAX_HISTORY * 2];
int historyCount = 0;

// ==== 音量調整 ====
// 0.7.20: 「VOLUME 倍して山を切る」をやめ、リミッター（PlaybackLimiter.h）で全体を持ち上げる。
// 倍率は NVS の audio/gain（無ければ PLAYBACK_GAIN_DEFAULT）。聞き比べ用にシリアルから変えられる:
// 数字1文字 1〜8 → 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 倍（次の返答から。NVS に残る）。0 は既定へ戻す。
// e / f で EQ（低い音を削り 3kHz を持ち上げる）のあり・なし（保存しない。既定はなし＝0.7.25。聞き比べ用に残してある）。
const float PLAYBACK_GAIN_DEFAULT = 6.0f;  // 2026-11-13 に試験機で聞いて決めた（EQ あり。絞りが効くのは返答の4割前後、音割れ0）
static PlaybackLimiter playbackLimiter;

void setPlaybackGain(float gain, bool save) {
  playbackLimiter.setGain(gain);
  if (save) {
    Preferences prefs;
    if (prefs.begin("audio", false)) {
      prefs.putFloat("gain", playbackLimiter.gain());
      prefs.end();
    }
  }
  Serial.printf("[VOLUME] gain=%.2f saved=%d\n", playbackLimiter.gain(), save);
}

void loadPlaybackGain() {
  float gain = PLAYBACK_GAIN_DEFAULT;
  Preferences prefs;
  if (prefs.begin("audio", true)) {
    gain = prefs.getFloat("gain", PLAYBACK_GAIN_DEFAULT);
    prefs.end();
  }
  setPlaybackGain(gain, false);
}

// 聞き取り中の loop() から。シリアルの数字1文字で倍率を変える（試験用）
void pollPlaybackGainSerial() {
  static const float table[] = {PLAYBACK_GAIN_DEFAULT, 1.5f, 2.0f, 2.5f, 3.0f, 4.0f, 5.0f, 6.0f, 8.0f};
  while (Serial.available() > 0) {
    const int c = Serial.read();
    if (c >= '0' && c <= '8') setPlaybackGain(table[c - '0'], true);
    else if (c == 'e' || c == 'f') {  // e = EQ あり、f = EQ なし（聞き比べ用。保存しない）
      playbackLimiter.setEq(c == 'e');
      Serial.printf("[VOLUME] eq=%d\n", playbackLimiter.eq());
    }
  }
}

// ==== TTS設定 ====
const char* TTS_PROVIDER = "ElevenLabs";
const char* TTS_CHARACTER = "default";

// ==== WiFiイベントハンドラ ====
void WiFiEvent(WiFiEvent_t event, WiFiEventInfo_t info) {
  switch (event) {
    case ARDUINO_EVENT_WIFI_STA_START:
      Serial.println("🔷 WiFi: STA started");
      break;
    case ARDUINO_EVENT_WIFI_STA_STOP:
      Serial.println("🔷 WiFi: STA stopped");
      wifiConnected = false;
      wifiGotIP = false;
      break;
    case ARDUINO_EVENT_WIFI_STA_CONNECTED:
      Serial.println("🔷 WiFi: Connected to AP!");
      wifiConnected = true;
      break;
    case ARDUINO_EVENT_WIFI_STA_DISCONNECTED:
      Serial.printf("🔷 WiFi: Disconnected, reason: %d\n", info.wifi_sta_disconnected.reason);
      wifiConnected = false;
      wifiGotIP = false;
      switch (info.wifi_sta_disconnected.reason) {
        case 2:  Serial.println("   -> AUTH_EXPIRE"); break;
        case 15: Serial.println("   -> 4WAY_HANDSHAKE_TIMEOUT (wrong password?)"); break;
        case 201: Serial.println("   -> NO_AP_FOUND"); break;
        case 202: Serial.println("   -> AUTH_FAIL"); break;
        default: break;
      }
      break;
    case ARDUINO_EVENT_WIFI_STA_GOT_IP:
      Serial.printf("🔷 WiFi: Got IP: %s\n", WiFi.localIP().toString().c_str());
      wifiGotIP = true;
      break;
    case ARDUINO_EVENT_WIFI_STA_LOST_IP:
      Serial.println("🔷 WiFi: Lost IP");
      wifiGotIP = false;
      break;
    default:
      break;
  }
}

// ==== NVS操作 ====
void saveWiFiCredentials(const String& ssid, const String& password) {
  preferences.begin("wifi", false);
  preferences.putString("ssid", ssid);
  preferences.putString("password", password);
  preferences.end();
  Serial.println("💾 WiFi credentials saved to NVS");
}

void saveDeviceMac(const String& mac) {
  preferences.begin("device", false);
  preferences.putString("mac", mac);
  preferences.end();
  Serial.printf("💾 Device MAC saved to NVS: %s\n", mac.c_str());
}

String loadDeviceMac() {
  preferences.begin("device", true);
  String mac = preferences.getString("mac", "");
  preferences.end();
  return mac;
}

bool loadWiFiCredentials() {
  preferences.begin("wifi", true);
  wifiSSID = preferences.getString("ssid", "");
  wifiPassword = preferences.getString("password", "");
  preferences.end();
  if (wifiSSID.length() > 0) {
    Serial.printf("📂 Loaded WiFi: %s\n", wifiSSID.c_str());
    return true;
  }
  Serial.println("📂 No WiFi credentials in NVS");
  return false;
}

// ==== BLEステータス送信 ====
void sendBLEStatus(const char* status) {
  if (pStatusChar && bleDeviceConnected) {
    pStatusChar->setValue(status);
    pStatusChar->notify();
    Serial.printf("📤 BLE Status: %s\n", status);
  }
}

// ==== 前方宣言 ====
void tryConnectWiFiFromBLE(const String& ssid, const String& password);
void startNormalOperation();

// ==== BLEコールバック ====
class ServerCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer* pServer) {
    bleDeviceConnected = true;
    Serial.println("📱 BLE Client connected");
  }
  void onDisconnect(BLEServer* pServer) {
    bleDeviceConnected = false;
    Serial.println("📱 BLE Client disconnected");
    if (currentMode == MODE_BLE_PROV) {
      pServer->startAdvertising();
    }
  }
};

class SSIDCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    pendingSSID = pCharacteristic->getValue().c_str();
    Serial.printf("📝 Received SSID: %s\n", pendingSSID.c_str());
  }
};

class PasswordCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    pendingPassword = pCharacteristic->getValue().c_str();
    Serial.printf("📝 Received Password length: %d\n", pendingPassword.length());
  }
};

class CommandCallbacks : public BLECharacteristicCallbacks {
  void onWrite(BLECharacteristic* pCharacteristic) {
    String value = pCharacteristic->getValue().c_str();
    Serial.printf("📝 Received Command: %s\n", value.c_str());
    if (value == "CONNECT") {
      if (pendingSSID.length() > 0) {
        tryConnectWiFiFromBLE(pendingSSID, pendingPassword);
      } else {
        sendBLEStatus("ERROR:NO_SSID");
      }
    }
  }
};

// ==== BLE開始 ====
void startBLE() {
  Serial.println("🔵 Starting BLE...");
  // アドバタイズ名にMAC下4桁を含める（アプリのスキャン一覧で個体を識別できるように）
  uint8_t btMac[6];
  esp_read_mac(btMac, ESP_MAC_BT);
  char bleName[20];
  snprintf(bleName, sizeof(bleName), "ToyTalker-%02X%02X", btMac[4], btMac[5]);
  BLEDevice::init(bleName);
  pServer = BLEDevice::createServer();
  pServer->setCallbacks(new ServerCallbacks());

  BLEService* pService = pServer->createService(SERVICE_UUID);

  BLECharacteristic* pSSIDChar = pService->createCharacteristic(CHAR_SSID_UUID, BLECharacteristic::PROPERTY_WRITE);
  pSSIDChar->setCallbacks(new SSIDCallbacks());

  BLECharacteristic* pPasswordChar = pService->createCharacteristic(CHAR_PASSWORD_UUID, BLECharacteristic::PROPERTY_WRITE);
  pPasswordChar->setCallbacks(new PasswordCallbacks());

  BLECharacteristic* pCommandChar = pService->createCharacteristic(CHAR_COMMAND_UUID, BLECharacteristic::PROPERTY_WRITE);
  pCommandChar->setCallbacks(new CommandCallbacks());

  pStatusChar = pService->createCharacteristic(
    CHAR_STATUS_UUID,
    BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY
  );
  pStatusChar->addDescriptor(new BLE2902());
  pStatusChar->setValue("READY");

  BLECharacteristic* pMacChar = pService->createCharacteristic(CHAR_MAC_UUID, BLECharacteristic::PROPERTY_READ);
  deviceMacAddress = BLEDevice::getAddress().toString().c_str();
  pMacChar->setValue(deviceMacAddress.c_str());

  pService->start();

  BLEAdvertising* pAdvertising = BLEDevice::getAdvertising();
  pAdvertising->addServiceUUID(SERVICE_UUID);
  pAdvertising->setScanResponse(true);
  pAdvertising->setMinPreferred(0x06);
  pAdvertising->setMinPreferred(0x12);
  BLEDevice::startAdvertising();

  Serial.println("🔵 BLE advertising started - Device name: ToyTalk-Setup");
  currentMode = MODE_BLE_PROV;
  // 録音中はLEDタイマーが停止しているため再開（長押しでBLEに入った場合の点滅不具合対策）
  if (ledTimer) timerAlarm(ledTimer, 30000, true, 0);
  setLEDMode(LED_BLINK_FAST);
}

// ==== BLE停止 ====
void stopBLE() {
  Serial.println("🔵 Stopping BLE...");
  BLEDevice::deinit(true);
  pServer = NULL;
  pStatusChar = NULL;
  bleDeviceConnected = false;
}

// ==== LED タイマー割り込み（30ms周期）====
void IRAM_ATTR onLEDTimer() {
  LEDMode mode = currentLEDMode;
  if (mode == LED_BLINKING || mode == LED_BLINK_SLOW || mode == LED_BLINK_FAST || mode == LED_BLINK_OTA) {
    static uint8_t blinkCounter = 0;
    // 30msティック数: OTA=2(60ms毎), FAST=5(150ms毎), BLINKING=10(300ms毎), SLOW=20(600ms毎)
    uint8_t ticks = (mode == LED_BLINK_OTA) ? 2 : (mode == LED_BLINK_FAST) ? 5 : (mode == LED_BLINK_SLOW) ? 20 : 10;
    blinkCounter++;
    if (blinkCounter >= ticks) {
      blinkCounter = 0;
      blinkState = !blinkState;
      digitalWrite(PIN_LED, blinkState ? HIGH : LOW);
    }
  }
}

// ==== LED制御関数（digitalWriteのみ）====
void setLEDMode(LEDMode mode) {
  if (currentLEDMode == mode) return;
  currentLEDMode = mode;
  blinkState = false;

  switch (mode) {
    case LED_OFF:
      digitalWrite(PIN_LED, LOW);
      break;
    case LED_ON:
      digitalWrite(PIN_LED, HIGH);
      break;
    case LED_BLINKING:
    case LED_BLINK_SLOW:
    case LED_BLINK_FAST:
    case LED_BLINK_OTA:
      blinkState = true;
      digitalWrite(PIN_LED, HIGH);
      break;
  }
}

// ==== 会話履歴に追加 ====
void addToHistory(const String& role, const String& content) {
  if (historyCount >= MAX_HISTORY * 2) {
    for (int i = 0; i < historyCount - 2; i++) {
      conversationHistory[i] = conversationHistory[i + 2];
    }
    historyCount -= 2;
  }
  conversationHistory[historyCount].role = role;
  conversationHistory[historyCount].content = content;
  historyCount++;
  Serial.printf("💾 Added to history [%s]: %s\n", role.c_str(), content.c_str());
}

// ==== mono → stereo 変換 ====
void monoToStereo(int16_t* mono, int16_t* stereo, size_t samples) {
  playbackLimiter.process(mono, stereo, samples);
}

// ==== I2S 録音設定 (STT) ====
// AEC未使用/初期化失敗時の比較用: マイク上の絶対音量。
constexpr bool VOICE_BARGE_ENABLED = true;
constexpr bool VOICE_BARGE_DETECT_ONLY = true;   // AECが使えない場合の生マイクは計測のみ。AECの停止設定はAecBargeGate.h。
static_assert(VOICE_BARGE_DETECT_ONLY, "raw microphone fallback must remain detect-only when AEC is unavailable");
// 比較試験はこの1か所で選ぶ。ReleaseDuringPlaybackが約8ターン正常だった設定。
enum class VoiceRxTestMode {
  ReleaseDuringPlayback,  // RX 8枚。再生前にドライバを解放、STT前に再確保
  PauseDuringPlayback,    // RX 8枚。停止のみ（低速化が再現した比較条件）
  MonitorOriginalDma,     // RX 8枚で同時録音・音量計測
  MonitorSmallDma,        // RX 4枚で同時録音・音量計測（2回目の低速化が再現）
  MonitorResetEachTurn    // RX 4枚で同時録音。再生終了時にRXも解放しSTTで再確保
};
constexpr VoiceRxTestMode VOICE_RX_TEST_MODE = VoiceRxTestMode::MonitorResetEachTurn;
constexpr bool VOICE_RX_PAUSE_DURING_PLAYBACK =
    VOICE_RX_TEST_MODE == VoiceRxTestMode::ReleaseDuringPlayback ||
    VOICE_RX_TEST_MODE == VoiceRxTestMode::PauseDuringPlayback;
constexpr bool VOICE_RX_RELEASE_WHEN_PAUSED =
    VOICE_RX_TEST_MODE == VoiceRxTestMode::ReleaseDuringPlayback;
constexpr bool VOICE_RX_RESET_AFTER_PLAYBACK = VOICE_RX_TEST_MODE == VoiceRxTestMode::MonitorResetEachTurn;
constexpr int MIC_DMA_COUNT =
    (VOICE_RX_TEST_MODE == VoiceRxTestMode::MonitorSmallDma || VOICE_RX_RESET_AFTER_PLAYBACK) ? 4 : 8;
constexpr int MIC_DMA_FRAMES = 512;  // 1枚32ms。割り込み周期・サンプル形式は変えない
// モノラル32bitのデータ領域。管理領域は別途必要。通常STTも同じ設定を使う。
constexpr uint32_t MIC_DMA_DATA_BYTES = MIC_DMA_COUNT * MIC_DMA_FRAMES * sizeof(int32_t);
static_assert(!AEC_ENABLED || (VOICE_RX_RESET_AFTER_PLAYBACK && MIC_DMA_FRAMES == AEC_MIC_SAMPLES &&
                              SAMPLE_RATE_STT == 16000 && SAMPLE_RATE_TTS == 24000),
              "AEC capture requires per-turn RX reset, 512-sample RX and 16/24 kHz clocks");
constexpr uint32_t VOICE_BARGE_RMS = 3200;       // 試験値: 再生のみ持続最大2388、近距離の声4049
constexpr uint32_t VOICE_BARGE_HOLD_MS = 120;
constexpr uint32_t VOICE_BARGE_WARMUP_MS = 500;
constexpr uint32_t VOICE_BARGE_FRAME_SAMPLES = 320;  // 20ms @ 16kHz
constexpr uint32_t VOICE_BARGE_HOLD_FRAMES =
    (SAMPLE_RATE_STT * VOICE_BARGE_HOLD_MS / 1000 + VOICE_BARGE_FRAME_SAMPLES - 1) /
    VOICE_BARGE_FRAME_SAMPLES;
static TaskHandle_t voiceTaskHandle = NULL;
static SemaphoreHandle_t voiceStopped = NULL;
static std::atomic<bool> voiceMonitorEnabled{false};
static std::atomic<uint32_t> voiceTriggerMs{0};
// 声の割り込みの確かめ中（監視タスクが立て、再生タスクが見る）。true の間は返答を捨てずに無音を流す
static volatile bool playerPaused = false;
// スマホの設定（鍵発行の応答の voice_barge_enabled）。届かなければ今までどおり ON。ボタンはいつでも効く
static volatile bool voiceBargeEnabled = true;
static bool voiceMonitorRunning = false;  // start/stopはloopタスクだけ
static bool micPausedForPlayback = false;  // loopのみ。STT開始前に必ず再開する
static bool micReleasedForPlayback = false;
static uint32_t micInstallGeneration = 0;  // loopのみ。再インストールが行われたか確認する

// 監視タスクが停止通知の直前に書き、loopが通知を受けた後に読む。
// 出力は録音の最初の送信後へ回し、切替前にログ待ちを増やさない。
struct VoiceLevelSummary {
  bool pending = false;
  uint32_t generation = 0;
  uint32_t peakRms = 0, sustainedRms = 0;
  uint32_t armedFrames = 0, windows = 0, readErrors = 0;
};
static VoiceLevelSummary voiceLevelSummary;

void voiceMonitorTask(void*) {
  static int32_t raw[VOICE_BARGE_FRAME_SAMPLES];
  static VoiceLevelMeter<VOICE_BARGE_HOLD_FRAMES> levels;  // 計測履歴は固定領域。動的確保なし
  for (;;) {
    ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
    if (aecMonitor.ready()) {
      uint32_t candidateMs = 0;  // 確かめ中の発火の時刻（割り込みと決まったら voiceTriggerMs にする）
      while (voiceMonitorEnabled.load()) {
        const auto event = aecMonitor.pump();
        if (event == AecMonitor::Event::Triggered && voiceMonitorEnabled.load() && !bargeInRequested) {
          const uint32_t atMs = millis();
          if (!AEC_BARGE_DETECT_ONLY && voiceBargeEnabled) {
            // すぐ黙らせ、返答は捨てずに一時停止して確かめる（AecBargeGate.h の AEC_CONFIRM_*）
            digitalWrite(PIN_AMP_SD, LOW);
            playerPaused = true;
            candidateMs = atMs;
            aecMonitor.beginConfirm(esp_timer_get_time());
          } else if (!AEC_BARGE_DETECT_ONLY) {
            // スマホの設定で声の割り込みを切っている: 数えるだけで止めない
            aecMonitor.resumeAfterReject(esp_timer_get_time());
          }
          aecMonitor.printTrigger(atMs);
        } else if (event == AecMonitor::Event::Confirmed) {
          if (voiceMonitorEnabled.load() && !bargeInRequested) {
            voiceTriggerMs.store(candidateMs ? candidateMs : millis());
            bargeInRequested = true;
            // Signal only: loop owns sockets, playback cancellation and channel lifetime.
            aecMonitor.stopCapture();
            voiceMonitorEnabled.store(false);
          }
          aecMonitor.printConfirm("voice");
        } else if (event == AecMonitor::Event::Rejected) {
          // 声ではなかった: 止めた所から続ける。ボタンが押されていればアンプは入れない（enableAmp が ISR と排他）
          playerPaused = false;
          if (!bargeInRequested) bargeInRequested.enableAmp(PIN_AMP_SD);
          aecMonitor.resumeAfterReject(esp_timer_get_time());
          candidateMs = 0;
          aecMonitor.printConfirm("resume");
        }
        vTaskDelay(pdMS_TO_TICKS(1));
      }
      aecMonitor.finish();
      Serial.printf("[AEC] stopped stack_free=%u\n", (unsigned)uxTaskGetStackHighWaterMark(NULL));
      xSemaphoreGive(voiceStopped);
      continue;
    }
    VoiceLevelGate gate;
    levels.reset();
    uint32_t seenSamples = 0, lastLog = millis(), maxRms = 0;
    uint32_t readErrors = 0, frames = 0;
    bool triggered = false;
    while (voiceMonitorEnabled.load()) {
      size_t bytes = 0;
      esp_err_t err = readMicI2s(raw, sizeof(raw), &bytes, pdMS_TO_TICKS(40));
      if (!voiceMonitorEnabled.load()) break;
      if (err != ESP_OK || bytes != sizeof(raw)) {
        gate.reset();
        levels.breakRun();
        ++readErrors;
        vTaskDelay(pdMS_TO_TICKS(2));
        continue;
      }
      // DCオフセットをフレーム平均で除去。二乗和は64bitでオーバーフローを防ぐ。
      int64_t sum = 0, squares = 0;
      for (uint32_t i = 0; i < VOICE_BARGE_FRAME_SAMPLES; ++i) {
        int32_t v = raw[i] >> 14;
        sum += v;
        squares += (int64_t)v * v;
      }
      double mean = (double)sum / VOICE_BARGE_FRAME_SAMPLES;
      double variance = (double)squares / VOICE_BARGE_FRAME_SAMPLES - mean * mean;
      uint32_t rms = (uint32_t)sqrt(variance > 0 ? variance : 0);
      if (rms > maxRms) maxRms = rms;
      ++frames;
      bool audioStarted = playbackI2sBytes.load() > 0;
      if (audioStarted) seenSamples += VOICE_BARGE_FRAME_SAMPLES;
      else seenSamples = 0;
      bool armedNow = audioStarted && seenSamples >= SAMPLE_RATE_STT * VOICE_BARGE_WARMUP_MS / 1000;
      levels.feed(rms, armedNow);  // detect-onlyで一度発火した後も、最後まで計測する
      if (!triggered && gate.feed(rms, VOICE_BARGE_FRAME_SAMPLES, VOICE_BARGE_RMS,
                                 SAMPLE_RATE_STT * VOICE_BARGE_HOLD_MS / 1000, armedNow)) {
        triggered = true;
        // ネットワーク待ち中でもまず音を止める。ソケットとI2S寿命管理はloop側に任せる。
        if (!VOICE_BARGE_DETECT_ONLY) {
          voiceTriggerMs.store(millis());
          bargeInRequested = true;
          digitalWrite(PIN_AMP_SD, LOW);
        }
        Serial.printf("[VOICE] trigger rms=%lu threshold=%lu hold_ms=%lu detect_only=%d at_ms=%lu\n",
                      (unsigned long)rms, (unsigned long)VOICE_BARGE_RMS,
                      (unsigned long)VOICE_BARGE_HOLD_MS, VOICE_BARGE_DETECT_ONLY,
                      (unsigned long)millis());
      }
      if (millis() - lastLog >= 1000) {
        Serial.printf("[VOICE] rms=%lu max=%lu threshold=%lu armed=%d frames=%lu read_errors=%lu sustained_rms=%lu\n",
                      (unsigned long)rms, (unsigned long)maxRms, (unsigned long)VOICE_BARGE_RMS,
                      armedNow, (unsigned long)frames, (unsigned long)readErrors,
                      (unsigned long)levels.sustainedRms());
        maxRms = 0;
        lastLog = millis();
      }
    }
    Serial.printf("[VOICE] stopped frames=%lu read_errors=%lu stack_free=%u\n",
                  (unsigned long)frames, (unsigned long)readErrors,
                  (unsigned)uxTaskGetStackHighWaterMark(NULL));
    voiceLevelSummary.peakRms = levels.peakRms();
    voiceLevelSummary.sustainedRms = levels.sustainedRms();
    voiceLevelSummary.armedFrames = levels.armedFrames();
    voiceLevelSummary.windows = levels.windows();
    voiceLevelSummary.readErrors = readErrors;
    voiceLevelSummary.pending = true;
    xSemaphoreGive(voiceStopped);  // 以降は次の通知までマイクへ触れない
  }
}

void initVoiceMonitor() {
  if (!VOICE_BARGE_ENABLED) return;
  aecMonitor.init();
  voiceStopped = xSemaphoreCreateBinary();
  if (!voiceStopped) {
    aecMonitor.release();
    Serial.println("[VOICE] semaphore allocation failed; button only");
    return;
  }
  if (xTaskCreatePinnedToCore(voiceMonitorTask, "voice_aec", 8192, NULL, 2,
                              &voiceTaskHandle, 1) != pdPASS) {
    vSemaphoreDelete(voiceStopped);
    voiceStopped = NULL;
    voiceTaskHandle = NULL;
    aecMonitor.release();
    Serial.println("[VOICE] task allocation failed; button only");
  }
}

void startVoiceMonitor() {
  if (!voiceTaskHandle || !micInstalled || micPausedForPlayback || voiceMonitorRunning) return;
  voiceMonitorRunning = true;
  voiceLevelSummary = VoiceLevelSummary{};
  voiceLevelSummary.generation = micInstallGeneration;
  voiceTriggerMs.store(0);
  // Also allow retry after a previous turn's DSP handle recreation failed.
  // start() is harmless when AEC storage was unavailable at initialization.
  aecMonitor.start(micInstallGeneration);
  voiceMonitorEnabled.store(true);
  xTaskNotifyGive(voiceTaskHandle);
  if (aecMonitor.ready()) return;
  Serial.printf("[VOICE] monitor start rms=%lu hold_ms=%lu warmup_ms=%lu detect_only=%d mic_generation=%lu\n",
                (unsigned long)VOICE_BARGE_RMS, (unsigned long)VOICE_BARGE_HOLD_MS,
                (unsigned long)VOICE_BARGE_WARMUP_MS, VOICE_BARGE_DETECT_ONLY,
                (unsigned long)micInstallGeneration);
}

void stopVoiceMonitor() {
  if (!voiceMonitorRunning) return;
  aecMonitor.stopCapture();
  voiceMonitorEnabled.store(false);
  // AECの遅延録音は待たずに捨てる。処理中の1フレーム完了を待ってSTTへ戻す。
  xSemaphoreTake(voiceStopped, portMAX_DELAY);
  voiceMonitorRunning = false;
}

void printVoiceLevelSummary() {
  if (!voiceMonitorRunning) aecMonitor.printSummary();
  if (voiceMonitorRunning || !voiceLevelSummary.pending) return;
  const auto& s = voiceLevelSummary;
  Serial.printf("[VOICE_LEVEL] generation=%lu peak_rms=%lu sustained_rms=%lu hold_ms=%lu armed_frames=%lu windows=%lu threshold=%lu detect_only=%d read_errors=%lu\n",
                (unsigned long)s.generation, (unsigned long)s.peakRms,
                (unsigned long)s.sustainedRms, (unsigned long)VOICE_BARGE_HOLD_MS,
                (unsigned long)s.armedFrames, (unsigned long)s.windows,
                (unsigned long)VOICE_BARGE_RMS, VOICE_BARGE_DETECT_ONLY,
                (unsigned long)s.readErrors);
  voiceLevelSummary.pending = false;
}

bool pauseMicForPlaybackTest() {
  if (!VOICE_RX_PAUSE_DURING_PLAYBACK || !micInstalled) return true;
  // 呼び出し元はSTT送信停止後、監視開始前。読み取り中のタスクはいない。
  stopVoiceMonitor();
  uint32_t freeBefore = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  esp_err_t err = VOICE_RX_RELEASE_WHEN_PAUSED ? releaseI2sChannel(micRx) : i2s_channel_disable(micRx);
  if (err != ESP_OK) {
    Serial.printf("[VOICE_TEST] mic pause/release failed=%d\n", err);
    return false;
  }
  micReleasedForPlayback = VOICE_RX_RELEASE_WHEN_PAUSED;
  micPausedForPlayback = !micReleasedForPlayback;
  if (micReleasedForPlayback) {
    micInstalled = false;
    i2sRecordReady = false;
  }
  Serial.printf("[VOICE_TEST] rx_released=%d internal_free_before=%lu after=%lu\n",
                micReleasedForPlayback, (unsigned long)freeBefore,
                (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  return true;
}

// 1回目は正常・2回目から低速になるため、RXをターン間で持ち越さない比較。
// STTの読み手はloopで停止済み。監視終了を待ち、TXを破棄する前にRXも解放する。
void resetMicAfterPlaybackTest() {
  if (!VOICE_RX_RESET_AFTER_PLAYBACK || !micInstalled) return;
  stopVoiceMonitor();
  esp_err_t err = releaseI2sChannel(micRx);
  if (err != ESP_OK) {
    Serial.printf("[VOICE_TEST] rx_reset_after_playback=0 err=%d generation=%lu\n",
                  err, (unsigned long)micInstallGeneration);
    return;  // 解放失敗時はinstalled状態を維持し、既存RXで録音への復帰を試す
  }
  micInstalled = false;
  i2sRecordReady = false;
  micPausedForPlayback = false;
  Serial.printf("[VOICE_TEST] rx_reset_after_playback=1 generation=%lu\n",
                (unsigned long)micInstallGeneration);
}

void setupI2SRecord() {
  if (micInstalled) return;
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  chan.dma_desc_num = MIC_DMA_COUNT;
  chan.dma_frame_num = MIC_DMA_FRAMES;
  esp_err_t err = i2s_new_channel(&chan, nullptr, &micRx);
  if (err != ESP_OK) {
    Serial.printf("[VOICE] mic channel allocation failed=%d\n", err);
    return;
  }
  i2s_std_config_t cfg = {};
  cfg.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE_STT);
  cfg.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO);
  cfg.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;
  cfg.gpio_cfg.mclk = I2S_GPIO_UNUSED;
  cfg.gpio_cfg.bclk = (gpio_num_t)PIN_MIC_BCLK;
  cfg.gpio_cfg.ws = (gpio_num_t)PIN_MIC_WS;
  cfg.gpio_cfg.dout = I2S_GPIO_UNUSED;
  cfg.gpio_cfg.din = (gpio_num_t)PIN_MIC_DATA;
  err = i2s_channel_init_std_mode(micRx, &cfg);
  i2s_event_callbacks_t callbacks = {};
  callbacks.on_recv = onMicDma;
  if (err == ESP_OK) err = i2s_channel_register_event_callback(micRx, &callbacks, nullptr);
  if (err == ESP_OK) err = i2s_channel_enable(micRx);
  if (err != ESP_OK) {
    i2s_del_channel(micRx); micRx = nullptr;
    Serial.printf("[VOICE] mic initialization failed=%d\n", err);
    return;
  }
  micInstalled = true;
  ++micInstallGeneration;
  Serial.printf("[VOICE_TEST] mic_ready driver=std dma_count=%d dma_frames=%d dma_data_bytes=%lu internal_free=%lu max_blk=%lu generation=%lu\n",
                MIC_DMA_COUNT, MIC_DMA_FRAMES, (unsigned long)MIC_DMA_DATA_BYTES,
                (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                (unsigned long)micInstallGeneration);
}

// ==== I2S 再生設定 (TTS) ====
bool setupI2SPlay() {
  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);
  delay(10);
  if (playbackTx) return false;
  i2s_chan_config_t chan = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
  chan.dma_desc_num = PLAY_DMA_COUNT;
  chan.dma_frame_num = PLAY_DMA_FRAMES;
  chan.auto_clear_after_cb = true;  // callback copies the played signal BEFORE it is cleared
  chan.auto_clear_before_cb = false;
  // Previous TX channel is deleted, so no callback can race this reset.
  playbackDmaSize = playbackDmaOverflows = lastPlaybackDmaOverflows = 0;
  esp_err_t err = i2s_new_channel(&chan, &playbackTx, nullptr);
  if (err != ESP_OK) {
    Serial.printf("[VOICE] playback allocation failed=%d\n", err);
    return false;
  }
  i2s_std_config_t cfg = {};
  cfg.clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE_TTS);
  cfg.slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO);
  cfg.gpio_cfg.mclk = I2S_GPIO_UNUSED;
  cfg.gpio_cfg.bclk = (gpio_num_t)PIN_AMP_BCLK;
  cfg.gpio_cfg.ws = (gpio_num_t)PIN_AMP_WS;
  cfg.gpio_cfg.dout = (gpio_num_t)PIN_AMP_DIN;
  cfg.gpio_cfg.din = I2S_GPIO_UNUSED;
  err = i2s_channel_init_std_mode(playbackTx, &cfg);
  i2s_event_callbacks_t callbacks = {};
  callbacks.on_sent = onPlaybackDma;
  callbacks.on_send_q_ovf = onPlaybackDmaOverflow;
  if (err == ESP_OK) err = i2s_channel_register_event_callback(playbackTx, &callbacks, nullptr);
  if (err == ESP_OK) err = i2s_channel_enable(playbackTx);
  if (err != ESP_OK) {
    i2s_del_channel(playbackTx); playbackTx = nullptr;
    Serial.printf("[VOICE] playback initialization failed=%d\n", err);
    return false;
  }
  playbackI2sBytes.store(0, std::memory_order_relaxed);
  return true;
}

// ==== HTTP chunked body: one decoder per response ====
static ChunkedBodyDecoder lambdaBody;
static StreamCompletion lambdaCompletion;
struct LambdaReadRuntime {
  uint32_t now() { return millis(); }
  void idle() { delay(1); }
  bool cancelled() { return bargeInRequested; }
};

size_t readBytesAcrossChunks(WiFiClientSecure& client, uint8_t* buffer, size_t length) {
  LambdaReadRuntime runtime;
  size_t read = lambdaBody.read(client, runtime, buffer, length);
  if (read != length && !bargeInRequested && !lambdaBody.done()) {
    Serial.printf("[STREAM_ERROR] reason=%s body_offset=%lu expected=%u got=%u\n",
                  lambdaBody.error(), (unsigned long)lambdaBody.payloadBytes(),
                  (unsigned)length, (unsigned)read);
  }
  return read;
}

// Never accept a partial/timed-out header line as a complete line.
bool readLambdaResponseHeaders(WiFiClientSecure& client) {
  String line;
  bool firstLine = true, sawCr = false, chunked = false;
  size_t total = 0;
  uint32_t lastProgress = millis();
  while (!bargeInRequested && total < 16384) {
    if (millis() - lastProgress >= 10000) break;
    if (client.available() <= 0) {
      if (!client.connected()) break;
      delay(1);
      continue;
    }
    uint8_t c;
    if (client.read(&c, 1) != 1) { delay(1); continue; }
    lastProgress = millis();
    ++total;
    if (sawCr) {
      if (c != '\n') break;
      if (firstLine) {
        if (line != "HTTP/1.1 200" && !line.startsWith("HTTP/1.1 200 ")) {
          Serial.printf("[STREAM_ERROR] HTTP status: %s\n", line.c_str());
          return false;
        }
        firstLine = false;
      } else if (line.length() == 0) {
        if (!chunked) Serial.println("[STREAM_ERROR] expected Transfer-Encoding: chunked");
        return chunked;
      } else {
        line.toLowerCase();
        int colon = line.indexOf(':');
        if (colon > 0 && line.substring(0, colon) == "transfer-encoding") {
          String value = line.substring(colon + 1);
          value.trim();
          chunked = value == "chunked";
        }
      }
      line = "";
      sawCr = false;
    } else if (c == '\r') {
      sawCr = true;
    } else {
      if (c == '\n' || line.length() >= 1024) break;
      line += (char)c;
    }
  }
  if (!bargeInRequested) Serial.println("[STREAM_ERROR] incomplete/invalid HTTP headers");
  return false;
}

// ==== メタデータ処理 (type=0x01) ====
bool processMetadata(WiFiClientSecure& client, uint32_t length) {
  if (length == 0 || length > 4096) return false;

  char* jsonBuf = (char*)malloc(length + 1);
  if (!jsonBuf) return false;

  size_t bytesRead = readBytesAcrossChunks(client, (uint8_t*)jsonBuf, length);
  jsonBuf[bytesRead] = '\0';

  if (bytesRead != length) {
    Serial.printf("[META] Read mismatch: expected=%d, got=%d\n", length, bytesRead);
    free(jsonBuf);
    return false;
  }

  String json = String(jsonBuf);
  Serial.printf("[META] %s\n", jsonBuf);

  // Parse the top-level event, not text that happens to contain an event name.
  JsonDocument eventFilter;
  eventFilter["event"] = true;
  JsonDocument eventDoc;
  if (deserializeJson(eventDoc, jsonBuf, length, DeserializationOption::Filter(eventFilter))) {
    free(jsonBuf);
    return false;
  }
  lambdaCompletion.metadata(eventDoc["event"] | "");

  if (json.indexOf("\"event\":\"segment\"") >= 0) {
    int p = json.indexOf("\"text\":\"");
    if (p >= 0) {
      p += 8;
      int e = json.indexOf("\"", p);
      if (e >= 0) {
        String segmentText = json.substring(p, e);
        responseText += segmentText;
        Serial.printf("[SEGMENT] Text: %s\n", segmentText.c_str());
        Serial.printf("[LATENCY] segment_text_ms=%lu\n",
                      (unsigned long)(millis() - ttsTurnStartMs.load()));
      }
    }
    int idPos = json.indexOf("\"id\":");
    if (idPos >= 0) {
      idPos += 5;
      curSegmentId = json.substring(idPos, json.indexOf(",", idPos)).toInt();
    }
  }

  if (json.indexOf("\"event\":\"tts_start\"") >= 0) {
    // 通信チャンクではなくTTSセグメント境界。実際の音声到着まで無音は追加しない。
    ttsGapPending = ttsAudioQueued;
    int sizePos = json.indexOf("\"size\":");
    if (sizePos >= 0) {
      sizePos += 7;
      currentPcmSize = json.substring(sizePos, json.indexOf("}", sizePos)).toInt();
      ttsSegments++;
      Serial.printf("[TTS_START] id=%d, size=%d\n", curSegmentId, currentPcmSize);
      Serial.printf("[LATENCY] segment=%d tts_header_ms=%lu\n", curSegmentId,
                    (unsigned long)(millis() - ttsTurnStartMs.load()));
    }
  }

  free(jsonBuf);
  return true;
}

// ==== 再生ジッタバッファ（PSRAMリングバッファ + 再生専用タスク） ====
// 不安定な回線でのぷつぷつ音切れ対策:
// 受信(メインループ=producer)とI2S再生(playbackTask=consumer)を分離し、
// リングバッファでネットワークジッタを吸収する。
#define PLAY_RING_SIZE   (512 * 1024)  // 512KB ≈ 5.4秒分 (24kHz/16bit/stereo)
#define PLAY_PREBUFFER   (32 * 1024)   // 再生開始/再開前に溜める量 ≈ 0.34秒
#define PLAY_WRITE_CHUNK 4096          // I2Sへの1回の書き込み量

static uint8_t* playRing = NULL;
static volatile size_t playRingHead = 0;      // producer書き込み位置
static volatile size_t playRingTail = 0;      // consumer読み出し位置
static volatile bool playerActive = false;    // 再生セッション中
static volatile bool playerStreamEnd = false; // 受信完了（残りを出し切って停止）
static volatile bool playerPrebuffering = true;
static volatile bool playerParked = true;     // タスクがI2Sに触っていない状態
// 一時停止のとき巻き戻す量: アンプを切った時点で DMA に入っていた分（8 本 × 4092 バイト ≈ 0.34 秒、満杯と仮定）
static constexpr size_t PLAY_REWIND_BYTES = PLAY_DMA_COUNT * PLAY_DMA_FRAMES * 4;
static size_t playConsumedBytes = 0;          // 再生タスクだけが書く。このセッションでリングから I2S へ渡した量
static uint32_t playPauses = 0;               // このセッションで一時停止した回数（再生タスクだけが書く）
static TaskHandle_t playerTaskHandle = NULL;

// ==== WiFi/再生品質の計測（基板グラウンド設計の検証用） ====
// 1ターン（録音開始）ごとにリセットし、再生終了時に [STATS] サマリを出す。
// underruns = 再生中のバッファ枯渇回数（音途切れの直接指標）。v0.1基板の
// ベースライン取得と、v0.2（GND強化後）の効果測定に使う
static volatile uint32_t statUnderruns = 0;
static volatile bool statUnderrunPending = false;  // 空検知→再生再開で確定カウント(終端の空は数えない)
static int32_t statRssiSum = 0;
static int32_t statRssiCount = 0;
static int statRssiMin = 0;  // RSSIは負値。0は未計測の意味
static uint32_t statLastRssiMs = 0;

// 電池・温度・充電を読んで覚える（PowerSense.h）。起動時と、録音中 POWER_SENSE_INTERVAL_MS ごと
void updatePowerReading() {
  powerReading = powerSenseRead(PIN_VBAT_ADC, PIN_BOARD_TEMP, PIN_CHG_STAT1, PIN_CHG_STAT2);
  powerReadingValid = true;
  powerReadMs = millis();
  Serial.printf("[POWER] vbat_mv=%lu board_temp_c=%.1f chip_temp_c=%.1f chg_stat1=%d chg_stat2=%d\n",
                (unsigned long)powerReading.vbatMv, powerReading.boardTempC, powerReading.chipTempC,
                powerReading.chgStat1, powerReading.chgStat2);
}

void statsReset() {
  statUnderruns = 0;
  statUnderrunPending = false;
  statRssiSum = 0;
  statRssiCount = 0;
  statRssiMin = 0;
}

void statsRecordRssi() {
  int r = WiFi.RSSI();
  if (r >= 0) return;  // 未接続時は0が返るので除外
  statRssiSum += r;
  statRssiCount++;
  if (statRssiMin == 0 || r < statRssiMin) statRssiMin = r;
}

void statsPrint() {
  int avg = statRssiCount ? (int)(statRssiSum / statRssiCount) : 0;
  // bc=1(相槌発動)のターンはバースト受信→生成ペース落ちで underruns=1 が正常値
  Serial.printf("[STATS] underruns=%lu bc=%d rssi_avg=%d rssi_min=%d samples=%ld\n",
                (unsigned long)statUnderruns, backchannelFired ? 1 : 0, avg, statRssiMin, (long)statRssiCount);
  // メモリリーク調査用: free=内部RAM空き / max_blk=内部RAMの最大連続ブロック(TLSは約45KBの連続領域が必要) / min_ever=起動以来の最低値
  Serial.printf("[MEM] free=%u max_blk=%u min_ever=%u\n",
                (unsigned)ESP.getFreeHeap(),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                (unsigned)ESP.getMinFreeHeap());
  Serial.printf("[VOICE_TEST] rx_paused_for_playback=%d rx_released_for_playback=%d\n",
                micPausedForPlayback, micReleasedForPlayback);
}

size_t playRingAvail() {
  size_t h = playRingHead, t = playRingTail;
  return (h + PLAY_RING_SIZE - t) % PLAY_RING_SIZE;
}

// 再生済みの直近 PLAY_REWIND_BYTES は上書きしない（確かめで再開するとき、アンプを切って黙って流れた分を巻き戻すため）
size_t playRingFree() {
  const size_t used = playRingAvail() + PLAY_REWIND_BYTES;
  return used >= PLAY_RING_SIZE - 1 ? 0 : PLAY_RING_SIZE - 1 - used;
}

// producer: リングバッファへ書き込み（満杯時は空くまで待つ）。barge-in時はfalse
bool playRingPush(const uint8_t* data, size_t len) {
  size_t pushed = 0;
  while (pushed < len) {
    if (bargeInRequested) return false;
    size_t freeSpace = playRingFree();
    if (freeSpace == 0) {
      uint32_t waitStart = millis();
      delay(1);
      ttsRingWaitMs += millis() - waitStart;
      continue;
    }
    size_t n = min(len - pushed, freeSpace);
    size_t h = playRingHead;
    size_t n1 = min(n, PLAY_RING_SIZE - h);  // 折返し前の連続領域
    memcpy(playRing + h, data + pushed, n1);
    if (n > n1) memcpy(playRing, data + pushed + n1, n - n1);
    playRingHead = (h + n) % PLAY_RING_SIZE;
    pushed += n;
  }
  return true;
}

// consumer: 再生専用タスク（Core 0）
void playbackTask(void* param) {
  bool pauseRewound = false;  // この一時停止で巻き戻し済み
  for (;;) {
    if (!playerActive) {
      playerParked = true;
      vTaskDelay(pdMS_TO_TICKS(5));
      continue;
    }
    playerParked = false;

    if (playerPaused) {
      // 声の割り込みの確かめ中: 返答は捨てず、無音を流して I2S と AEC の参照の時計を止めない
      static const uint8_t pauseSilence[PLAY_WRITE_CHUNK] = {};
      if (!pauseRewound) {
        // アンプを切ってから DMA に残っていた分は誰にも聞こえていないので、その分だけ戻す
        const size_t back = min(PLAY_REWIND_BYTES, playConsumedBytes);
        playRingTail = (playRingTail + PLAY_RING_SIZE - back) % PLAY_RING_SIZE;
        playConsumedBytes -= back;
        ++playPauses;
        pauseRewound = true;
        Serial.printf("[PLAYER] paused for confirm rewind_bytes=%u\n", (unsigned)back);
      }
      size_t written = 0;
      writePlaybackI2s(pauseSilence, sizeof(pauseSilence), &written, pdMS_TO_TICKS(100));
      continue;
    }
    pauseRewound = false;

    size_t avail = playRingAvail();

    if (playerPrebuffering) {
      // プリバッファ: 一定量溜まるまで再生開始を待つ（ストリーム終了時は即出し切る）
      if (avail >= PLAY_PREBUFFER || (playerStreamEnd && avail > 0)) {
        playerPrebuffering = false;
        if (statUnderrunPending) {  // 溜め直し後の再開=本物のアンダーランとして確定
          statUnderruns++;
          statUnderrunPending = false;
        }
        Serial.printf("[PLAYER] playback start (buffered=%u bytes)\n", (unsigned)avail);
      } else if (playerStreamEnd && avail == 0) {
        playerActive = false;  // 何も残っていないまま終了
      } else {
        vTaskDelay(pdMS_TO_TICKS(2));
      }
      continue;
    }

    // 500msごとにRSSIをサンプリング（再生中の電波品質記録）
    if (millis() - statLastRssiMs > 500) {
      statLastRssiMs = millis();
      statsRecordRssi();
    }

    if (avail == 0) {
      if (playerStreamEnd) {
        playerActive = false;  // 全データ再生完了
        continue;
      }
      // アンダーラン: 溜め直す（この間DMAは無音を出力）
      // カウントは再生再開時に確定させる（ストリーム終端の空を誤カウントしないため）
      statUnderrunPending = true;
      Serial.println("[PLAYER] underrun → rebuffering");
      playerPrebuffering = true;
      continue;
    }

    size_t t = playRingTail;
    size_t n = min(avail, (size_t)PLAY_WRITE_CHUNK);
    n = min(n, PLAY_RING_SIZE - t);  // 折返し前まで
    size_t written = 0;
    writePlaybackI2s(playRing + t, n, &written, portMAX_DELAY);
    if (written > 0) {
      lastI2sWriteMs.store(millis(), std::memory_order_relaxed);
      logFirstTtsWrite();
    }
    playRingTail = (t + written) % PLAY_RING_SIZE;
    playConsumedBytes += written;
  }
}

// 再生セッション開始（I2Sドライバインストール後に呼ぶ）
void playerStart() {
  if (!playRing) return;
  playRingHead = 0;
  playRingTail = 0;
  playerStreamEnd = false;
  playerPaused = false;
  playConsumedBytes = 0;
  playPauses = 0;
  playerPrebuffering = true;
  statUnderrunPending = false;  // 前セッション(相槌等)の終端レースを持ち越さない
  playerActive = true;
}

// 再生タスク即時停止（barge-in/エラー時）。I2Sドライバuninstall前に必ず呼ぶ
void playerStop() {
  if (!playRing) return;
  playerActive = false;
  delay(10);  // タスクがplayerActive読み取り直後だった場合の猶予
  unsigned long start = millis();
  while (!playerParked && (millis() - start < 1000)) delay(5);
  playRingHead = 0;
  playRingTail = 0;
  playerPaused = false;
}

// 次のセグメントの直前に無音PCMを流す。固定領域を再利用してヒープ確保を避ける。
bool queueTtsSegmentGap() {
  static const uint8_t silence[1024] = {};
  size_t remaining = (size_t)SAMPLE_RATE_TTS * TTS_SEGMENT_GAP_MS / 1000 * 2 * sizeof(int16_t);
  while (remaining > 0) {
    if (bargeInRequested) return false;
    size_t n = min(remaining, sizeof(silence));
    if (playRing) {
      if (!playRingPush(silence, n)) return false;
      remaining -= n;
    } else {
      size_t written = 0;
      esp_err_t err = writePlaybackI2s(silence, n, &written, pdMS_TO_TICKS(100));
      if (err != ESP_OK || written == 0) {
        Serial.printf("[TTS_GAP] I2S write failed: err=%d written=%u\n", err, (unsigned)written);
        return false;
      }
      remaining -= written;
    }
  }
  Serial.printf("[TTS_GAP] id=%d inserted=%lums\n", curSegmentId, (unsigned long)TTS_SEGMENT_GAP_MS);
  return true;
}

// ==== PCMデータ処理 (type=0x02)。trueは全量成功、falseは中断/異常 ====
bool processPCM(WiFiClientSecure& client, uint32_t length) {
  uint32_t segmentStart = millis(), readMs = 0, wsMs = 0;
  uint32_t ringWaitBefore = ttsRingWaitMs;
  // アンプON（PWMなし）
  if (!ampOn) {
    pinMode(PIN_AMP_SD, OUTPUT);
    if (!bargeInRequested.enableAmp(PIN_AMP_SD)) return false;
    delay(50);
    ampOn = true;
  }
  Serial.printf("[PCM] Streaming %lu bytes\n", (unsigned long)length);

  // リングバッファ再生時は細かい粒度で読み、受信・ws.loop()の頻度を上げる
  const size_t STREAM_CHUNK_SIZE = playRing ? 8192 : 65536;
  uint32_t remaining = length;
  uint32_t totalPlayed = 0;

  while (remaining > 0) {
    if (bargeInRequested) {
      Serial.println("🔘 Barge-in! Stopping playback");
      return false;
    }

    uint32_t chunkSize = (remaining > STREAM_CHUNK_SIZE) ? STREAM_CHUNK_SIZE : remaining;

    uint8_t* pcmData = (uint8_t*)ps_malloc(chunkSize);
    if (!pcmData) pcmData = (uint8_t*)malloc(chunkSize);
    if (!pcmData) {
      Serial.println("[STREAM_ERROR] PCM allocation failed; aborting response");
      return false;
    }

    uint32_t readStart = millis();
    size_t bytesRead = readBytesAcrossChunks(client, pcmData, chunkSize);
    readMs += millis() - readStart;
    ttsPcmBytes += bytesRead;
    if (bytesRead > 0 && !ttsFirstPcmLogged) {
      ttsFirstPcmLogged = true;
      turnReport.firstAudioMs = millis() - ttsTurnStartMs.load();
      Serial.printf("[LATENCY] first_pcm_chunk_ms=%lu bytes=%u\n",
                    (unsigned long)(millis() - ttsTurnStartMs.load()), (unsigned)bytesRead);
    }
    if (bytesRead != chunkSize) {
      if (bargeInRequested) {
        Serial.printf("[PCM] Read cancelled by barge-in: expected=%d, got=%d\n", chunkSize, bytesRead);
        free(pcmData);
        return false;
      }
      Serial.printf("[STREAM_ERROR] PCM incomplete id=%d expected=%lu got=%u remaining=%lu; aborting response\n",
                    curSegmentId, (unsigned long)chunkSize, (unsigned)bytesRead, (unsigned long)remaining);
      free(pcmData);
      return false;
    }

    size_t samples = bytesRead / 2;
    size_t stereoBytes = samples * 4;
    int16_t* stereo = (int16_t*)malloc(stereoBytes);
    if (!stereo) {
      Serial.println("[PCM] stereo malloc failed for chunk!");
      free(pcmData);
      return false;
    }

    monoToStereo((int16_t*)pcmData, stereo, samples);
    free(pcmData);

    if (stereoBytes > 0 && ttsGapPending) {
      if (!queueTtsSegmentGap()) {
        free(stereo);
        return false;  // 割り込みまたはI2Sエラーでストリームを停止
      }
      ttsGapPending = false;
    }

    if (playRing) {
      // リングバッファへ投入（再生はplaybackTaskが担当）
      if (!playRingPush((uint8_t*)stereo, stereoBytes)) {
        free(stereo);
        return false;  // barge-in
      }
      if (stereoBytes > 0) ttsAudioQueued = true;
    } else {
      // フォールバック: 直接再生（リングバッファ確保失敗時）
      size_t written = 0;
      esp_err_t err = writePlaybackI2s((uint8_t*)stereo, stereoBytes, &written, portMAX_DELAY);
      if (err != ESP_OK || written != stereoBytes) {
        free(stereo);
        Serial.println("[STREAM_ERROR] incomplete I2S write");
        return false;
      }
      if (written > 0) {
        lastI2sWriteMs.store(millis(), std::memory_order_relaxed);
        logFirstTtsWrite();
      }
      if (written > 0) ttsAudioQueued = true;
    }
    free(stereo);

    totalPlayed += stereoBytes;
    remaining -= bytesRead;
    uint32_t wsStart = millis();
    serviceSoniox("pcm_receive");
    wsMs += millis() - wsStart;
  }

  Serial.printf("[PCM] Streaming complete: %d bytes total\n", totalPlayed);
  Serial.printf("[PCM_TIMING] id=%d wall_ms=%lu read_ms=%lu ring_wait_ms=%lu ws_ms=%lu remaining=%lu\n",
                curSegmentId, (unsigned long)(millis() - segmentStart), (unsigned long)readMs,
                (unsigned long)(ttsRingWaitMs - ringWaitBefore), (unsigned long)wsMs,
                (unsigned long)remaining);
  return true;
}

// ==== 相槌キャッシュクリア ====
void clearBackchannelCache() {
  if (backchannelPcm) { free(backchannelPcm); backchannelPcm = NULL; }
  backchannelPcmSize = 0;
  backchannelText = "";
  backchannelReady = false;
  backchannelFetching = false;
  backchannelFired = false;
  backchannelAbort = false;
}

// ==== 相槌フェッチ用FreeRTOSタスク ====
struct BackchannelParams {
  String partialText;
  String characterId;
};

// 通常の関数として戻り、ローカルStringをタスク削除前に破棄する。
void fetchBackchannel(void* param) {
  BackchannelParams* p = (BackchannelParams*)param;
  String partial = p->partialText;
  String charId = p->characterId;
  delete p;

  Serial.printf("[BC] Fetching backchannel for: %s\n", partial.c_str());
  Serial.printf("[BC] Free heap before: %d\n", ESP.getFreeHeap());

  String url = String("https://") + BACKCHANNEL_HOST + BACKCHANNEL_PATH;
  String payload = "{\"partial_text\":\"" + partial + "\",\"fw\":\"" TOYTALKER_FW_VERSION "\"";
  if (charId.length() > 0) {
    payload += ",\"device_id\":\"" + charId + "\"";
  }
  if (historyCount > 0) {
    payload += ",\"history\":[";
    int start = (historyCount > 6) ? historyCount - 6 : 0;
    for (int i = start; i < historyCount; i++) {
      if (i > start) payload += ",";
      payload += "{\"role\":\"" + conversationHistory[i].role + "\",\"content\":\"" + conversationHistory[i].content + "\"}";
    }
    payload += "]";
  }
  if (pastBackchannelCount > 0) {
    payload += ",\"past_backchannels\":[";
    for (int i = 0; i < pastBackchannelCount; i++) {
      if (i > 0) payload += ",";
      payload += "\"" + pastBackchannels[i] + "\"";
    }
    payload += "]";
  }
  payload += "}";

  {
    HTTPClient http;
    http.begin(url, AMAZON_ROOT_CAS);  // 証明書を検証する
    http.addHeader("Content-Type", "application/json");
    http.addHeader("x-amz-content-sha256", sha256Hex(payload));
    if (device_auth::available()) http.addHeader(device_auth::KEY_HEADER, device_auth::value());
    http.setTimeout(8000);
    const char* headerKeys[] = {"X-Backchannel-Text", "x-backchannel-text"};
    http.collectHeaders(headerKeys, 2);

    int httpCode = http.POST(payload);

    if (backchannelAbort || httpCode != 200) {
      Serial.printf("[BC] %s (code=%d)\n", backchannelAbort ? "Aborted" : "HTTP error", httpCode);
      http.end();
    } else {
      if (http.hasHeader("X-Backchannel-Text")) {
        backchannelText = http.header("X-Backchannel-Text");
      } else if (http.hasHeader("x-backchannel-text")) {
        backchannelText = http.header("x-backchannel-text");
      }

      int len = http.getSize();
      WiFiClient* stream = http.getStreamPtr();

      const size_t INIT_SIZE = 32768;
      const size_t MAX_SIZE = 256000;
      size_t bufSize = (len > 0) ? (size_t)len : INIT_SIZE;
      uint8_t* pcm = (uint8_t*)ps_malloc(bufSize);
      if (!pcm) pcm = (uint8_t*)malloc(bufSize);

      if (pcm) {
        size_t totalRead = 0;
        unsigned long startTime = millis();
        while (http.connected() && (millis() - startTime < 15000) && !backchannelAbort) {
          size_t avail = stream->available();
          if (avail > 0) {
            if (totalRead + avail > bufSize) {
              size_t newSize = min(bufSize * 2, MAX_SIZE);
              if (newSize <= bufSize) break;
              uint8_t* newBuf = (uint8_t*)ps_realloc(pcm, newSize);
              if (!newBuf) newBuf = (uint8_t*)realloc(pcm, newSize);
              if (!newBuf) break;
              pcm = newBuf;
              bufSize = newSize;
            }
            size_t rd = stream->readBytes(pcm + totalRead, avail);
            totalRead += rd;
          } else {
            if (len > 0 && (int)totalRead >= len) break;
            delay(1);
          }
        }

        if (totalRead > 0 && !backchannelAbort) {
          backchannelPcm = pcm;
          backchannelPcmSize = totalRead;
          backchannelReady = true;
          Serial.printf("[BC] Ready: pcm=%d bytes\n", totalRead);
        } else {
          free(pcm);
          Serial.printf("[BC] %s\n", backchannelAbort ? "Aborted" : "No PCM data");
        }
      } else {
        Serial.println("[BC] malloc failed");
      }
      http.end();
    }
  }

}

void fetchBackchannelTask(void* param) {
  fetchBackchannel(param);
  // partial / charId / url / payload はここでは解放済み。
  Serial.printf("[BC] Free heap after: %d\n", ESP.getFreeHeap());
  backchannelFetching = false;
  backchannelTaskHandle = NULL;
  vTaskDelete(NULL);
}

// ==== 相槌フェッチ開始 ====
void startBackchannelFetch(const String& partial) {
  if (!backchannelEnabled) return;
  if (backchannelFetching || backchannelReady || backchannelFired) return;
  if (strlen(BACKCHANNEL_HOST) == 0) return;
  if (ESP.getFreeHeap() < 60000) {
    Serial.printf("[BC] Not enough heap: %d bytes, skipping\n", ESP.getFreeHeap());
    return;
  }

  backchannelFetching = true;

  BackchannelParams* params = new BackchannelParams();
  params->partialText = partial;
  params->characterId = deviceMacAddress;

  xTaskCreatePinnedToCore(fetchBackchannelTask, "bc_fetch", 16384, params, 1, &backchannelTaskHandle, 1);
}

// ==== 相槌再生 ====
bool playBackchannelIfReady() {
  if (!backchannelReady || !backchannelPcm || backchannelPcmSize == 0) return false;

  Serial.printf("[BC] Playing backchannel: %d bytes\n", backchannelPcmSize);

  size_t samples = backchannelPcmSize / 2;
  const size_t PLAY_CHUNK = 4096;
  size_t offset = 0;

  while (offset < samples && !bargeInRequested) {
    size_t chunkSamples = min(PLAY_CHUNK, samples - offset);
    size_t stereoBytes = chunkSamples * 4;
    int16_t* stereo = (int16_t*)malloc(stereoBytes);
    if (!stereo) break;

    monoToStereo((int16_t*)(backchannelPcm + offset * 2), stereo, chunkSamples);
    size_t written = 0;
    writePlaybackI2s((uint8_t*)stereo, stereoBytes, &written, portMAX_DELAY);
    free(stereo);
    offset += chunkSamples;
  }

  backchannelFired = true;
  if (backchannelText.length() > 0) addPastBackchannel(backchannelText);
  Serial.println("[BC] Backchannel playback done");

  free(backchannelPcm);
  backchannelPcm = NULL;
  backchannelPcmSize = 0;
  backchannelReady = false;

  return true;
}

// ---- Lambda SSL接続+リクエスト送信バックグラウンドタスク ----
struct LambdaConnectParams {
  WiFiClientSecure* client;
  String* request;
  std::atomic<bool> connected;
  std::atomic<bool> sent;
  std::atomic<bool> failed;
  // 計測（TurnReport）。sent / failed を立てる前に書くので、loop はそれを見てから読む
  uint32_t connectStartMs;
  uint32_t connectMs;
  uint32_t sendMs;
};

void lambdaConnectAndSendTask(void* param) {
  LambdaConnectParams* p = (LambdaConnectParams*)param;
  // 原因特定用: TLS接続直前の内部RAM状態(free / 最大連続ブロック)。
  // TLSの合計使用量と1回の確保サイズは別。freeが足りてもmax_blkが小さいと確保に失敗し得る。
  Serial.printf("[DIAG] pre-connect free=%u max_blk=%u\n",
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  tls_memory::printStats("lambda_pre_connect");
  p->client->setCACert(AMAZON_ROOT_CAS);  // 証明書を検証する（0.7.5 までは setInsecure で検証なし）
  uint32_t connectStart = millis();
  p->connectStartMs = connectStart;
  bool connected = p->client->connect(LAMBDA_HOST, 443);
  p->connectMs = millis() - connectStart;
  Serial.printf("[LATENCY] lambda_connect_ms=%lu ok=%d\n",
                (unsigned long)(millis() - connectStart), connected);
  tls_memory::printStats(connected ? "lambda_connected" : "lambda_failed");
  if (!connected) {
    Serial.printf("[DIAG] connect() FAILED, post free=%u max_blk=%u\n",
                  (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                  (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    p->failed = true;
    vTaskDelete(NULL);
    return;
  }
  p->connected = true;
  if (bargeInRequested) {
    // connect()の途中で他タスクからclientを破棄しない。接続後は不要なPOSTを送らない。
    p->client->stop();
    Serial.println("[LATENCY] Lambda request cancelled before POST");
    p->failed = true;
    vTaskDelete(NULL);
    return;
  }
  uint32_t sendStart = millis();
  size_t expected = p->request->length();
  size_t written = p->client->print(*(p->request));
  p->sendMs = millis() - sendStart;
  Serial.printf("[LATENCY] lambda_send_ms=%lu written=%u expected=%u\n",
                (unsigned long)(millis() - sendStart), (unsigned)written, (unsigned)expected);
  if (written != expected) {
    p->client->stop();
    p->failed = true;
    vTaskDelete(NULL);
    return;
  }
  p->sent = true;
  vTaskDelete(NULL);
}

// このターンの記録を締めて、次の要求に添える記録にする（TurnReport.h）
void finishTurnReport(const char* stop, uint32_t t0) {
  turnReport.valid = true;
  turnReport.stop = stop;
  turnReport.playEndMs = millis() - t0;
  const uint32_t firstWrite = ttsFirstWriteAtMs.load();
  if (firstWrite) turnReport.playStartMs = firstWrite - t0;
  turnReport.audioMs = ttsPcmBytes / (SAMPLE_RATE_TTS * 2 / 1000);
  turnReport.underruns = statUnderruns;
  turnReport.segments = ttsSegments;
  turnReport.bc = backchannelFired;
  turnReport.rssiAvg = statRssiCount ? (int)(statRssiSum / statRssiCount) : 0;
  turnReport.rssiMin = statRssiMin;
  turnReport.wsMaxBlockMs = sonioxServiceMaxMs;
  lastTurnReport = turnReport;
  Serial.printf("[TURN_REPORT] {%s}\n", turnReportJson(turnReport).c_str());  // 次の要求の device.prev と同じ中身
}

// 要求の "device":{…}。電池・温度・充電（PowerSense.h）、いまの電波とメモリ、前のターンとこの発話の計測（TurnReport.h）
String deviceStatusJson(const TurnReport& prev) {
  char buf[200];
  const int rssi = WiFi.RSSI();
  snprintf(buf, sizeof(buf),
           "\"rssi\":%d,\"heap_free\":%lu,\"heap_min\":%lu,\"max_blk\":%lu,\"psram_free\":%lu,\"uptime_s\":%lu",
           rssi < 0 ? rssi : 0,
           (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
           (unsigned long)heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
           (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
           (unsigned long)heap_caps_get_free_size(MALLOC_CAP_SPIRAM),
           (unsigned long)(millis() / 1000));
  String out = "\"device\":{";
  if (powerReadingValid) out += powerSenseJsonFields(powerReading) + ",";
  out += buf;
  if (prev.valid) out += "," + turnReportJson(prev);
  if (sttReport.valid) out += "," + sttReportJson(sttReport);
  out += "}";
  return out;
}

// ==== Lambda に送信 & SSE 受信 ====
void sendToLambdaAndPlay(const String& text) {
  unsigned long t0 = millis();
  ttsTurnStartMs.store(t0);
  ttsFirstWriteLogged.store(false);
  ttsFirstPcmLogged = false;
  ttsFirstWriteAtMs.store(0);
  ttsPcmBytes = 0;
  playbackLimiter.reset();
  playbackLimiter.resetStats();
  ttsSegments = 0;
  ttsRingWaitMs = 0;
  sonioxServiceMaxMs = 0;
  // 前のターンの記録はこの要求に添える（下の payload）。このターンの記録を新しく始める
  const TurnReport prevReport = lastTurnReport;
  turnReport = TurnReport{};
  Serial.println("🚀 Sending to Lambda: " + text);
  Serial.printf("💾 Free heap: %d bytes\n", ESP.getFreeHeap());
  responseText = "";
  ttsAudioQueued = false;
  ttsGapPending = false;
  bargeInRequested.beginTurn();

  turnEndTiming = TurnEndTiming{};
  dmaTailTiming = DmaTailTiming{};
  turnEndTiming.turn = ++turnTimingSequence;
  turnReport.turn = turnEndTiming.turn;
  lastI2sWriteMs.store(0, std::memory_order_relaxed);

  if (isRecording) isRecording = false;
  sttWanted = false;  // 返答の間は見張らない（戻るときに startSTTRecording が立てる）
  logMemoryCheckpoint("before_playback");

  // バックチャネルタスク完了待ち
  if (backchannelFetching && backchannelTaskHandle != NULL) {
    Serial.println("[BC] Waiting for backchannel task to finish...");
    unsigned long waitStart = millis();
    while (backchannelTaskHandle != NULL && (millis() - waitStart < 10000)) delay(10);
    if (backchannelTaskHandle != NULL) {
      Serial.println("[BC] Timeout - aborting task");
      backchannelAbort = true;
      unsigned long abortStart = millis();
      while (backchannelTaskHandle != NULL && (millis() - abortStart < 3000)) delay(10);
      backchannelAbort = false;
    }
  }
  Serial.printf("⏱️ [%lums] BC wait done\n", millis() - t0);

  // タイマー再開（再生中のLEDアニメーション用）
  timerAlarm(ledTimer, 30000, true, 0);

  // I2S切り替え
  // 比較モードではRXを停止/解放。Monitorモードでは監視タスクへ引き継ぐ。
  if (!pauseMicForPlaybackTest()) {
    finishTurnReport("i2s_failed", t0);
    clearBackchannelCache();
    startSTTRecording();
    return;
  }
  Serial.printf("[VOICE_TEST] playback rx_paused=%d rx_released=%d raw_detect_only=%d aec_detect_only=%d\n",
                micPausedForPlayback, micReleasedForPlayback, VOICE_BARGE_DETECT_ONLY, AEC_BARGE_DETECT_ONLY);
  if (!setupI2SPlay()) {
    finishTurnReport("i2s_failed", t0);
    clearBackchannelCache();
    resetMicAfterPlaybackTest();
    startSTTRecording();
    return;
  }
  Serial.printf("[VOICE_TEST] playback_ready rx_dma_count=%d internal_free=%lu max_blk=%lu\n",
                micInstalled ? MIC_DMA_COUNT : 0,
                (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  playerStart();  // 再生タスク起動（リングバッファ初期化）
  Serial.printf("⏱️ [%lums] I2S switched\n", millis() - t0);

  // 接続タスクへ所有権を渡し、相槌・本返答の受信と並列に準備する。
  prepareSonioxDuringPlayback();
  Serial.printf("⏱️ [%lums] WS reconnect started (preconnect during playback)\n", millis() - t0);

  // ペイロード組み立て
  String messagesJson = "[";
  for (int i = 0; i < historyCount; i++) {
    if (i > 0) messagesJson += ",";
    messagesJson += "{\"role\":\"" + conversationHistory[i].role + "\",";
    messagesJson += "\"content\":\"" + conversationHistory[i].content + "\"}";
  }
  if (historyCount > 0) messagesJson += ",";
  messagesJson += "{\"role\":\"user\",\"content\":\"" + text + "\"}";
  messagesJson += "]";

  // POST precedes local backchannel playback. Tell Lambda about the ready PCM
  // committed to play before its reply, without marking it as already played.
  // Use the same snapshot below so late-arriving PCM cannot change the plan.
  const bool backchannelPlanned = !bargeInRequested && backchannelReady &&
                                 backchannelPcm && backchannelPcmSize > 0;
  const bool backchannelForReply = backchannelFired || backchannelPlanned;
  Serial.printf("[BC] reply_hint=%d planned=%d played=%d pcm_bytes=%u\n",
                backchannelForReply, backchannelPlanned, (bool)backchannelFired,
                (unsigned)(backchannelPlanned ? backchannelPcmSize : 0));

  // fw: Lambdaの切り分けログ用（どの版の本体からの要求か）。文章は chat-logs に残り、ログには時刻と識別子だけが出る
  String payload =
    "{\"model\":\"" + String(TTS_PROVIDER) + "\",\"voice\":\"" + String(TTS_CHARACTER) + "\","
    "\"device_id\":\"" + deviceMacAddress + "\","
    "\"session_id\":\"" + sessionId + "\","
    "\"owner_id\":\"" + deviceMacAddress + "\","
    "\"fw\":\"" TOYTALKER_FW_VERSION "\","
    "\"backchannel_fired\":" + (backchannelForReply ? "true" : "false") + ","
    // 本体の状態（電池・温度・充電・電波・メモリ）と計測（前のターン・この発話の聞き取り）。
    // Lambda がログの device に写す（TurnReport.h）。文章は入れない
    + deviceStatusJson(prevReport) + "," +
    "\"messages\":" + messagesJson + "}";

  Serial.printf("📝 History count: %d\n", historyCount);

  String req =
    String("POST ") + LAMBDA_PATH + " HTTP/1.1\r\n"
    "Host: " + LAMBDA_HOST + "\r\n"
    "Content-Type: application/json\r\n"
    "x-amz-content-sha256: " + sha256Hex(payload) + "\r\n"
    + (device_auth::available() ? String(device_auth::KEY_HEADER) + ": " + device_auth::value() + "\r\n" : String("")) +
    "Accept: text/event-stream\r\n"
    "Connection: close\r\n"
    "Content-Length: " + payload.length() + "\r\n\r\n"
    + payload;

  // Lambda SSL接続+送信をCore 0でバックグラウンド
  WiFiClientSecure client;
  LambdaConnectParams connParams = { &client, &req, false, false, false, 0, 0, 0 };
  TaskHandle_t connTaskHandle = NULL;
  if (xTaskCreatePinnedToCore(lambdaConnectAndSendTask, "lambda_conn", 16384, &connParams, 1, &connTaskHandle, 0) != pdPASS) {
    connParams.failed = true;
    Serial.println("[VOICE] Lambda task allocation failed; returning to recording");
  }
  Serial.printf("⏱️ [%lums] Lambda task started on Core 0\n", millis() - t0);

  // アンプON（PWMなし）
  if (!ampOn) {
    pinMode(PIN_AMP_SD, OUTPUT);
    ampOn = bargeInRequested.enableAmp(PIN_AMP_SD);
    if (ampOn) delay(50);
    Serial.printf("⏱️ [%lums] Amp ready\n", millis() - t0);
  }

  startVoiceMonitor();

  // 相槌再生（Lambda接続と並列）
  if (backchannelPlanned) {
    Serial.println("[BC] Playing backchannel while Lambda connects...");
    playBackchannelIfReady();
  }
  Serial.printf("⏱️ [%lums] Backchannel phase done\n", millis() - t0);

  // Lambda接続完了待ち
  // タスクがclient/reqを使い終わるまで寿命を保持する。音声検出時のミュートは監視側で行う。
  while (!connParams.sent && !connParams.failed) delay(1);
  Serial.printf("⏱️ [%lums] Lambda request sent (ok=%d)\n", millis() - t0, !connParams.failed);

  if (connParams.connectStartMs) {
    turnReport.preMs = connParams.connectStartMs - t0;
    turnReport.tlsMs = connParams.connectMs;
    turnReport.tlsOk = connParams.connected;
    turnReport.sendMs = connParams.sendMs;
  }
  if (connParams.failed) {
    stopVoiceMonitor();
    turnReport.aec = aecMonitor.report();
    finishTurnReport("connect_failed", t0);
    bargeInRequested = false;
    Serial.printf("💾 Free heap at failure: %d\n", ESP.getFreeHeap());
    setLEDMode(LED_OFF);
    playerStop();
    resetMicAfterPlaybackTest();
    releaseI2sChannel(playbackTx);
    if (ampOn) { digitalWrite(PIN_AMP_SD, LOW); ampOn = false; }
    clearBackchannelCache();
    startSTTRecording();
    return;
  }

  // HTTPレスポンスヘッダー読み取り
  uint32_t headerStart = millis();
  bool headersOk = readLambdaResponseHeaders(client);
  bool responseFailed = !headersOk && !bargeInRequested;
  if (headersOk) turnReport.headersMs = millis() - t0;

  Serial.printf("[LATENCY] headers_ms=%lu turn_elapsed_ms=%lu interrupted=%d\n",
                (unsigned long)(millis() - headerStart), millis() - t0, (bool)bargeInRequested);
  Serial.printf("⏱️ [%lums] Header phase ended\n", millis() - t0);
  if (headersOk) Serial.println("📨 BINARY STREAM START (Chunked)");

  lambdaBody.reset();
  lambdaCompletion.reset();

  setLEDMode(LED_BLINKING);

  while (headersOk && !bargeInRequested && !responseFailed) {
    uint8_t header[5];
    size_t read = readBytesAcrossChunks(client, header, 5);
    if (read == 0 && lambdaBody.done()) {
      Serial.println("🏁 BINARY STREAM END");
      break;
    }
    if (read != 5) {
      if (lambdaCompletion.canDrainAfterClose(read, lambdaBody.error(), bargeInRequested)) {
        Serial.println("[STREAM_END] done=1 http_complete=0 reason=connection_closed; draining audio");
        break;
      }
      if (!bargeInRequested) Serial.printf("[STREAM_ERROR] binary header incomplete: %u/5 bytes\n", (unsigned)read);
      responseFailed = !bargeInRequested;
      break;
    }

    uint8_t type = header[0];
    uint32_t length = lambdaFrameLength(header);

    Serial.printf("[BINARY] type=0x%02X, length=%lu\n", type, (unsigned long)length);
    if (!validLambdaFrame(type, length)) {
      Serial.printf("[STREAM_ERROR] invalid frame at body_offset=%lu header=%02X %02X %02X %02X %02X; aborting response\n",
                    (unsigned long)(lambdaBody.payloadBytes() - 5),
                    header[0], header[1], header[2], header[3], header[4]);
      responseFailed = true;
      break;
    }

    serviceSoniox("binary_header");

    if (type == 0x01) {
      if (!processMetadata(client, length)) {
        if (!bargeInRequested) Serial.println("[STREAM_ERROR] metadata incomplete/unavailable; aborting response");
        responseFailed = !bargeInRequested;
        break;
      }
    } else if (type == 0x02) {
      lambdaCompletion.pcmStarted();
      if (!processPCM(client, length)) {
        responseFailed = !bargeInRequested;
        break;
      }
    }
  }

  unsigned long tEnd = millis();
  Serial.printf("[STREAM_END] done=%d server_error=%d http_complete=%d failed=%d\n",
                lambdaCompletion.doneSeen(), lambdaCompletion.errorSeen(), lambdaBody.done(), responseFailed);
  turnEndTiming.pending = true;
  turnEndTiming.receiveEndMs = tEnd;
  turnEndTiming.interrupted = bargeInRequested || responseFailed;

  if (bargeInRequested || responseFailed) {
    digitalWrite(PIN_AMP_SD, LOW);
    if (responseFailed) Serial.println("[STREAM_ERROR] dropping response and returning to recording");
    else Serial.println("🔘 Barge-in: skipping buffer flush");
    // 止めた時点で鳴らしていない分（リングは 24kHz stereo 16bit = 96 バイト/ms）
    if (playRing) turnReport.unplayedMs = playRingAvail() / 96;
    playerStop();  // 再生タスク即時停止＋リング破棄
    client.stop();
    turnEndTiming.parkedMs = millis();
  } else {
    // 受信完了: リングバッファの残りを出し切るまで待つ
    if (playRing) {
      playerStreamEnd = true;
      unsigned long drainStart = millis();
      while (!bargeInRequested && playerActive && (millis() - drainStart < 30000)) {
        serviceSoniox("playback_drain");
        delay(10);
      }
      // 受信を終えた後の出し切り中に割り込まれたときも、鳴らしていない分を数える（96 バイト/ms）
      if (bargeInRequested) turnReport.unplayedMs = playRingAvail() / 96;
      playerStop();  // 正常時は既に停止済み、タイムアウト時の保険
      Serial.printf("⏱️ end+[%lums] Ring buffer drained\n", millis() - tEnd);
    }
    turnEndTiming.parkedMs = millis();
    beginDmaTailTiming(!playRing || playerParked);
    if (bargeInRequested) dmaTailTiming.valid = false;
    const size_t dmaBytes = PLAY_DMA_COUNT * PLAY_DMA_FRAMES * 4;
    const size_t flushChunk = 8192;
    uint8_t* silence = (uint8_t*)calloc(1, flushChunk);
    if (silence) {
      size_t remaining = dmaBytes;
      while (remaining > 0 && !bargeInRequested) {
        size_t toWrite = (remaining > flushChunk) ? flushChunk : remaining;
        uint32_t writeStartMs = millis();
        size_t chunkWritten = 0;
        while (chunkWritten < toWrite && !bargeInRequested) {
          size_t part = toWrite - chunkWritten;
          size_t flushed = dmaBytes - remaining + chunkWritten;
          if (dmaTailTiming.valid && !dmaTailTiming.confirmed) {
            // 元の8192-byte単位とws.loopの位置を維持し、確認境界だけ書き込みを分割。
            size_t boundary = dmaTailTiming.confirmAfterBytes - 4;
            size_t next = flushed < boundary ? boundary : dmaTailTiming.confirmAfterBytes;
            part = min(part, next - flushed);
          }
          size_t written = 0;
          esp_err_t err = i2s_channel_write(playbackTx, silence, part, &written, UINT32_MAX);
          int64_t copyDoneUs = esp_timer_get_time();
          chunkWritten += written;
          pollPlaybackI2sEvents(true);
          if (err != ESP_OK || written == 0) {
            dmaTailTiming.valid = false;
            break;
          }
          if (dmaTailTiming.valid && !dmaTailTiming.confirmed && flushed + written >= dmaTailTiming.confirmAfterBytes) {
            dmaTailTiming.confirmed = true;
            dmaTailTiming.confirmedUs = copyDoneUs;
          }
        }
        turnEndTiming.flushWriteMs += millis() - writeStartMs;
        remaining -= chunkWritten;
        if (chunkWritten < toWrite) break;
        uint32_t wsStartMs = millis();
        serviceSoniox("dma_flush");
        turnEndTiming.flushWsMs += millis() - wsStartMs;
      }
      free(silence);
      turnEndTiming.flushCompleted = remaining == 0;
    }
    turnEndTiming.flushEndMs = millis();
    Serial.printf("⏱️ end+[%lums] DMA flush\n", millis() - tEnd);
  }

  stopVoiceMonitor();
  client.stop();
  turnEndTiming.interrupted = bargeInRequested || responseFailed;
  if (bargeInRequested || responseFailed) dmaTailTiming.valid = false;
  digitalWrite(PIN_AMP_SD, LOW);
  dmaTailTiming.ampOffUs = esp_timer_get_time();
  turnEndTiming.ampOffMs = millis();
  turnEndTiming.lastWriteMs = lastI2sWriteMs.load(std::memory_order_relaxed);
  ampOn = false;
  Serial.printf("[TURN_STOP] cause=%s ws_max_block_ms=%lu\n",
                responseFailed ? "stream_error" : bargeInRequested ?
                (voiceTriggerMs.load() ? "aec_level" : "button") : "completed",
                (unsigned long)sonioxServiceMaxMs);
  turnReport.recvEndMs = tEnd - t0;
  turnReport.aec = aecMonitor.report();
  if (bargeInRequested) {
    const uint32_t triggerMs = voiceTriggerMs.load();
    const int64_t pressedUs = bargeInRequested.buttonTiming().pressedUs;
    if (triggerMs) turnReport.bargeMs = triggerMs - t0;
    else if (pressedUs) turnReport.bargeMs = (uint32_t)(pressedUs / 1000) - t0;  // millis() と同じ時計（esp_timer）
  }
  finishTurnReport(responseFailed ? "stream_error" : bargeInRequested ?
                   (voiceTriggerMs.load() ? "aec" : "button") : "done", t0);
  Serial.printf("⏱️ end+[%lums] Amp off\n", millis() - tEnd);
  statsPrint();  // このターンのWiFi/再生品質サマリ
  {
    // 届いた音声の大きさ（in_*）と、リミッターを通した後（out_rms）。倍率を決める材料（相槌も含む）
    const auto& lv = playbackLimiter.stats();
    Serial.printf("[PCM_LEVEL] eq=%d gain=%.2f in_peak=%u in_rms=%lu out_rms=%lu limited_pct=%lu min_reduction=%.2f hard_clips=%lu samples=%lu\n",
                  playbackLimiter.eq(), playbackLimiter.gain(), lv.inPeak, (unsigned long)lv.inRms(), (unsigned long)lv.outRms(),
                  (unsigned long)lv.limitedPct(), lv.minReduction, (unsigned long)lv.hardClips, (unsigned long)lv.samples);
  }

  addToHistory("user", text);
  if (responseText.length() > 0) addToHistory("assistant", responseText);

  bargeInRequested = false;
  clearBackchannelCache();
  Serial.printf("⏱️ end+[%lums] Cleanup done\n", millis() - tEnd);

  resetMicAfterPlaybackTest();
  releaseI2sChannel(playbackTx);
  Serial.printf("⏱️ end+[%lums] I2S uninstalled\n", millis() - tEnd);

  startSTTRecording();
  Serial.printf("⏱️ end+[%lums] STT recording started\n", millis() - tEnd);
}

// ==== Soniox WebSocketイベント ====
void logLoopStack(const char* stage) {
  Serial.printf("[STACK] %s min_free=%u bytes\n", stage,
                (unsigned)uxTaskGetStackHighWaterMark(NULL));
}

// Runs on loop only, including completion handed back from the connect worker.
void sonioxConnectionReady() {
  if (sttRestartMs > 0) {
    Serial.printf("⏱️ STT [%lums] WS ready (from restart)\n", millis() - sttRestartMs);
  }
  Serial.println("✅ Connected to Soniox!");
  if (sttWsWaitPending) {
    sttWsWaitPending = false;
    sttProgress.wsWaitMs = millis() - sttRecordStartMs;
  }
  logLoopStack("soniox_ready");
  Serial.println("📤 Sent start message to Soniox");
  sonioxPreconnectPending = false;
  if (isRecording) {
    timerAlarm(ledTimer, 0, false, 0);
    setLEDMode(LED_ON);
  }
}

void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      {
        String startMsg = sonioxStartMessage();
        if (ws.sendTXT(startMsg)) sonioxConnectionReady();
        else {
          Serial.println("[STT] start message failed");
          ws.disconnect();
        }
      }
      // isRecordingはstartSTTRecordingで設定（再生中のpreconnect時に録音開始を防ぐ）
      break;

    case WStype_TEXT: {
      String msg = (char*)payload;
      if (msg.indexOf("\"error_code\"") >= 0) {
        // 期限切れのキーなどで Soniox が拒否したとき。この後 Soniox が切断し、録音は止まる。
        Serial.printf("[STT] soniox error: %s\n", msg.c_str());
        sonioxErrors++;
      }
      if (msg.indexOf("\"tokens\"") >= 0) {
        String nonFinalCurrent = "";
        bool foundEndToken = false;
        bool newTextSeen = false;
        int searchPos = msg.indexOf("\"tokens\"");
        while (true) {
          int textPos = msg.indexOf("\"text\":\"", searchPos);
          if (textPos < 0) break;
          textPos += 8;
          int textEnd = msg.indexOf("\"", textPos);
          if (textEnd < 0) break;
          String token = msg.substring(textPos, textEnd);

          int objEnd = msg.indexOf("}", textEnd);
          if (objEnd < 0) objEnd = msg.length();
          String objSlice = msg.substring(textEnd, objEnd);
          bool isFinal = objSlice.indexOf("\"is_final\":true") >= 0;

          if (token == "\\u003cend\\u003e") {
            foundEndToken = true;
          } else {
            if (token.length() > 0) newTextSeen = true;
            if (isFinal) sonioxFinalBuf += token;
            else nonFinalCurrent += token;
          }
          searchPos = textEnd + 1;
        }

        // 猶予の最中か、猶予中に声が出た後に新しい文字が来たら、同じ発話の続き。次の <end> を待つ
        if (newTextSeen && (sttGrace.graceStartMs || sttGrace.resumeStartMs)) {
          if (sttGrace.graceStartMs) {
            sttGrace.resumes++;
            Serial.printf("[GRACE] text resumed +%lums after first end\n", millis() - sttGrace.firstEndMs);
          }
          sttGrace.graceStartMs = 0;
          sttGrace.resumeStartMs = 0;
        }

        String fullText = sonioxFinalBuf + nonFinalCurrent;
        if (fullText.length() > 0) {
          // <end> と同じメッセージの確定（途中結果の差し替え）は数えない。数えると last_text_to_end_ms がいつも 0 付近になる
          if (!foundEndToken && fullText != partialText) lastTextChangeMs = millis();
          partialText = fullText;
          lastPartialMs = millis();
          armed = true;
          Serial.println(">> " + partialText);

          if (utf8Len(fullText) >= BACKCHANNEL_TRIGGER_CHARS && !backchannelFired && !backchannelFetching && !backchannelReady) {
            startBackchannelFetch(fullText);
          }
        }

        if (foundEndToken && partialText.length() > 0) {
          Serial.println("🎯 Endpoint detected by Soniox!");
          endpointDetected = true;
        }
      }
      break;
    }

    case WStype_DISCONNECTED:
      Serial.println("✅ Soniox disconnected");
      if (!sonioxClosingOnPurpose) sonioxDisconnects++;
      isRecording = false;
      sonioxPreconnectPending = false;
      break;

    default:
      break;
  }
}

// ==== STT録音開始 ====
void startSTTRecording() {
  unsigned long t0 = millis();
  sttRestartMs = t0;
  sttRecordStartMs = t0;
  sttWanted = false;  // マイクが使えず戻るときは見張らない。録音を始められたら下で立てる
  if (!sttRecovering) sttIdleSinceMs = t0;  // つなぎ直しでは無音の時計を巻き戻さない
  sttProgress = SttReport{};
  sttWsWaitPending = false;
  sonioxPlaybackPhase = false;
  finishSonioxPreconnect();
  statsReset();  // このターンの品質計測を開始
  Serial.println("🎙️ Starting STT recording...");
  logMemoryCheckpoint("before_recording");
  // 準備中はゆっくり点滅（タイマーが録音停止中の場合があるので再開）
  if (ledTimer) timerAlarm(ledTimer, 30000, true, 0);
  setLEDMode(LED_BLINK_SLOW);

  if (!i2sRecordReady) {
    setupI2SRecord();
    Serial.printf("⏱️ STT [%lums] I2S record setup\n", millis() - t0);
  }
  i2sRecordReady = micInstalled;
  if (!micInstalled) {
    isRecording = false;
    Serial.println("[VOICE] microphone unavailable; recording disabled");
    return;
  }
  if (micReleasedForPlayback) {
    micReleasedForPlayback = false;
    Serial.println("[VOICE_TEST] mic reinstalled for STT");
  }
  if (micPausedForPlayback) {
    esp_err_t err = i2s_channel_enable(micRx);
    if (err != ESP_OK) {
      isRecording = false;
      Serial.printf("[VOICE_TEST] mic resume failed=%d; recording disabled\n", err);
      return;
    }
    micPausedForPlayback = false;
    Serial.println("[VOICE_TEST] mic resumed for STT");
  }
  sttMicFilter.reset();
  sttInputFirstBlock = true;
  // 再生音が残ったRXキューを捨てる。検出前の音声引き継ぎは未実装。
  for (int i = 0; i < 8; ++i) {
    size_t bytes = 0;
    readMicI2s(sttRaw, sizeof(sttRaw), &bytes, 0);
    if (!bytes) break;
  }

  if (turnEndTiming.pending) turnEndTiming.micSetupDoneMs = millis();
  logLoopStack("before_stt_connect");

  if (sonioxIsConnected()) {
    Serial.printf("⏱️ STT [%lums] WS already connected (preconnect success!)\n", millis() - t0);
  } else if (sonioxPreconnectPending || sonioxPreconnect.ownsClient()) {
    Serial.printf("⏱️ STT [%lums] WS not yet connected, waiting...\n", millis() - t0);
    // preconnectが進行中なので、ws.loop()で完了を待つ
    unsigned long wsWaitStart = millis();
    while (!sonioxIsConnected() && (millis() - wsWaitStart < 5000)) {
      serviceSoniox("recording_connect");
      delay(1);
    }
    if (sonioxIsConnected()) {
      Serial.printf("⏱️ STT [%lums] WS connected after wait\n", millis() - t0);
    } else if (sonioxPreconnect.ownsClient()) {
      // connect() is still using ws: keep ownership with the worker. loop will
      // collect completion later; never reset/delete its in-flight socket.
      Serial.println("[WS_PRECONNECT] still running; socket retained until completion");
    } else {
      Serial.printf("⏱️ STT [%lums] WS still not connected, starting fresh\n", millis() - t0);
      sonioxPreconnectPending = false;
      refreshSonioxKeyIfOld("preconnect_failed");
      beginSonioxWs();
      ws.onEvent(webSocketEvent);
      ws.enableHeartbeat(15000, 3000, 2);
    }
  } else {
    // 起動直後など先行接続が存在しない場合は待たずに即接続（従来はここで5秒無駄待ちしていた）
    Serial.printf("⏱️ STT [%lums] No preconnect pending, connecting fresh\n", millis() - t0);
    refreshSonioxKeyIfOld("no_preconnect");
    beginSonioxWs();
    ws.onEvent(webSocketEvent);
    ws.enableHeartbeat(15000, 3000, 2);
  }
  isRecording = true;
  sttWanted = true;
  if (sonioxIsConnected()) sttProgress.wsWaitMs = millis() - t0;
  else sttWsWaitPending = true;  // sonioxConnectionReady で埋める
  const auto buttonTiming = bargeInRequested.buttonTiming();
  if (buttonTiming.pressedUs != 0) {
    const int64_t recordUs = esp_timer_get_time();
    Serial.printf("[BUTTON] irq_to_mute_us=%lu irq_to_record_ms=%lu ws_ready=%d\n",
                  (unsigned long)(buttonTiming.mutedUs - buttonTiming.pressedUs),
                  (unsigned long)((recordUs - buttonTiming.pressedUs) / 1000), sonioxIsConnected());
  }
  if (voiceTriggerMs.load() != 0) {
    Serial.printf("[VOICE] trigger_to_record_ms=%lu ws_ready=%d\n",
                  (unsigned long)(millis() - voiceTriggerMs.load()), sonioxIsConnected());
  }
  if (turnEndTiming.pending) {
    turnEndTiming.recordOnMs = millis();
    turnEndTiming.wsReadyAtRecord = sonioxIsConnected();
  }
  Serial.printf("⏱️ STT [%lums] isRecording=true\n", millis() - t0);

  // WS接続済み（=startメッセージ送信済み）なら即「話してOK」の点灯へ。
  // 未接続ならゆっくり点滅のまま、CONNECTEDイベント側で点灯に切り替わる
  if (sonioxIsConnected()) {
    if (ledTimer) timerAlarm(ledTimer, 0, false, 0);
    setLEDMode(LED_ON);
  }

  partialText = "";
  sonioxFinalBuf = "";
  lastFinalText = "";
  armed = false;
  endpointDetected = false;
  sttGrace = SttGraceState{};
  clearBackchannelCache();
  Serial.printf("⏱️ STT [%lums] startSTTRecording done\n", millis() - t0);
}

// ==== WiFi接続（1回試行） ====
bool tryConnectWiFiOnce(const String& ssid, const String& password) {
  wifiConnected = false;
  wifiGotIP = false;

  WiFi.disconnect(true);
  delay(500);
  WiFi.mode(WIFI_STA);
  delay(100);

  wifi_country_t country = {
    .cc = "JP", .schan = 1, .nchan = 14, .max_tx_power = 20, .policy = WIFI_COUNTRY_POLICY_MANUAL
  };
  esp_wifi_set_country(&country);

  Serial.printf("📶 Connecting to: %s\n", ssid.c_str());
  WiFi.begin(ssid.c_str(), password.c_str());

  for (int i = 0; i < 10; i++) {
    delay(1000);
    Serial.print(".");
    if (wifiGotIP) return true;
  }
  return false;
}

// ==== BLEからのWiFi接続試行 ====
void tryConnectWiFiFromBLE(const String& ssid, const String& password) {
  sendBLEStatus("CONNECTING");

  Serial.printf("📶 Connecting to WiFi from BLE: %s\n", ssid.c_str());

  const int MAX_RETRIES = 2;
  for (int retry = 1; retry <= MAX_RETRIES; retry++) {
    Serial.printf("\n🔄 Attempt %d of %d\n", retry, MAX_RETRIES);
    if (tryConnectWiFiOnce(ssid, password)) {
      Serial.printf("\n✅ WiFi connected! IP: %s\n", WiFi.localIP().toString().c_str());
      saveWiFiCredentials(ssid, password);
      wifiSSID = ssid;
      wifiPassword = password;
      deviceMacAddress = BLEDevice::getAddress().toString().c_str();
      saveDeviceMac(deviceMacAddress);
      sendBLEStatus("CONNECTED");
      delay(1000);
      ESP.restart();
      return;
    }

    Serial.printf("\n❌ Attempt %d failed\n", retry);
    if (retry < MAX_RETRIES) {
      Serial.println("⏳ Waiting 2 seconds before retry...");
      delay(2000);
    }
  }

  Serial.println("\n❌ WiFi connection failed after all retries");
  sendBLEStatus("FAILED");
}

// ==== 通常動作開始 ====
void startNormalOperation() {
  Serial.println("🎯 Starting normal operation...");
  currentMode = MODE_NORMAL;

  // デバイス鍵（初回はここで作る。Wi-Fi 接続後なので乱数は RF 由来）。失敗しても鍵なしで続ける
  device_auth::ensure();

  // Sonioxキー取得（WiFi切替直後などの一時的な失敗に備えて3回リトライ）
  // fw/hw/ota/part はLambdaが記録し、更新の要否判定にも使う（docs/esp32-ota-settings-plan.md）
  String initUrl = String(SONIOX_LAMBDA_URL) + "?device_id=" + deviceMacAddress
                 + "&fw=" + TOYTALKER_FW_VERSION + "&hw=" + TOYTALKER_HW_VERSION
                 + "&ota=" + (ota::capable() ? "1" : "0") + "&part=" + ota::runningLabel()
                 + "&ttl=" + SONIOX_KEY_TTL_SEC
                 + ota::queryParams();  // 前回の更新の結果（ロールバック・続いた失敗）
  String resp;
  const int code = httpGetWithRetry(initUrl, resp, 3);
  if (code != 200) {
    Serial.println("❌ Soniox key fetch gave up");
    setLEDMode(LED_OFF);
    return;
  }

  // 署名付きURL（一時認証トークン込みで2KB前後）が firmware に入るので余裕を取る
  DynamicJsonDocument doc(4096);
  if (deserializeJson(doc, resp)) {
    setLEDMode(LED_OFF);
    return;
  }
  sonioxKey = doc["api_key"].as<String>();
  sonioxKeyFetchedMs = millis();
  Serial.println("✅ Soniox temp key obtained");

  // Wi-Fi接続とLambda到達まで来た版は健全とみなし、OTA後の初回起動なら有効印を付ける
  ota::confirmRunningImage();

  // 更新があれば録音・WS・AECを始める前に適用する。成功時は再起動して戻らない。
  if (doc.containsKey("firmware")) {
    ota::Manifest manifest;
    const char* reason = "";
    if (ota::parseManifest(doc["firmware"], manifest, reason)) {
      setLEDMode(LED_BLINK_OTA);
      const ota::Result result = ota::apply(manifest);
      Serial.printf("[OTA] result=%d; continuing with current firmware\n", (int)result);
      setLEDMode(LED_BLINK_SLOW);
      logMemoryCheckpoint("after_ota_attempt");
    } else {
      Serial.printf("[OTA] manifest rejected: %s\n", reason);
    }
  }

  if (doc.containsKey("backchannel_enabled")) {
    backchannelEnabled = doc["backchannel_enabled"].as<bool>();
  }
  if (doc.containsKey("stt_model")) {
    sonioxModel = doc["stt_model"].as<String>();
  }
  // 声の割り込み（スマホの設定。届かなければ ON のまま）。反映は起動時
  if (doc.containsKey("voice_barge_enabled")) {
    voiceBargeEnabled = doc["voice_barge_enabled"].as<bool>();
  }
  Serial.printf("🔊 Backchannel: %s, STT: %s, voice barge-in: %s\n", backchannelEnabled ? "ON" : "OFF",
                sonioxModel.c_str(), voiceBargeEnabled ? "ON" : "OFF");

  startSTTRecording();
}

// ==== SETUP ====
void setup() {
  Serial.begin(921600);
#if ARDUINO_USB_CDC_ON_BOOT && ARDUINO_USB_MODE
  // Debug output must not stall audio/STT when the PC stops reading USB.
  // Drop bytes on a full queue or contended lock instead of waiting.
  Serial.setTxTimeoutMs(0);
#endif
  delay(100);
  Serial.println(AEC_BARGE_DETECT_ONLY ? "\n🚀 ToyTalker Mini v0.7 (AEC evaluation / detect only)"
                                     : "\n🚀 ToyTalker Mini v0.7 (AEC barge-in + OTA)");
  Serial.printf("[BUILD] fw=%s hw=%s arduino=%s idf=%s\n", TOYTALKER_FW_VERSION, TOYTALKER_HW_VERSION,
                ESP_ARDUINO_VERSION_STR, esp_get_idf_version());
  ota::printBootInfo();
  ota::checkPreviousUpdate();  // 前回入れた版で起動できたか、ロールバックで戻ったか
#if ARDUINO_USB_CDC_ON_BOOT && ARDUINO_USB_MODE
  Serial.println("[SERIAL] hwcdc_tx_timeout_ms=0 drop_on_backpressure=1");
#endif
  esp_err_t allocHookResult = heap_caps_register_failed_alloc_callback(recordAllocationFailure);
  Serial.printf("[ALLOC_FAIL] hook_install_err=%d\n", allocHookResult);
  Serial.printf("[VOICE_TEST] mode=%s rx_dma_count=%d rx_dma_frames=%d raw_detect_only=%d aec_detect_only=%d\n",
                VOICE_RX_PAUSE_DURING_PLAYBACK ? (VOICE_RX_RELEASE_WHEN_PAUSED ? "release_rx" : "pause_rx")
                                             : (VOICE_RX_RESET_AFTER_PLAYBACK ? "monitor_reset_each_turn"
                                                : (VOICE_RX_TEST_MODE == VoiceRxTestMode::MonitorSmallDma ? "monitor_small_dma" : "monitor_original_dma")),
                MIC_DMA_COUNT, MIC_DMA_FRAMES, VOICE_BARGE_DETECT_ONLY, AEC_BARGE_DETECT_ONLY);

  WiFi.onEvent(WiFiEvent);

  loadPlaybackGain();
  // LED初期化（digitalWriteのみ、PWMなし）
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, HIGH);

  powerSenseBegin(PIN_CHG_STAT1, PIN_CHG_STAT2);
  updatePowerReading();

  // LEDアニメーション用ハードウェアタイマー
  ledTimer = timerBegin(1000000);
  timerAttachInterrupt(ledTimer, &onLEDTimer);
  timerAlarm(ledTimer, 30000, true, 0);  // 30ms周期
  setLEDMode(LED_BLINK_SLOW);  // 起動〜録音準備完了までゆっくり点滅

  // NVSからBLE MACアドレスを読み込み
  deviceMacAddress = loadDeviceMac();
  if (deviceMacAddress.length() > 0) {
    Serial.printf("📱 Device MAC (from NVS): %s\n", deviceMacAddress.c_str());
  }

  // ボタン初期化 + barge-in用割り込み
  pinMode(PIN_BUTTON, INPUT_PULLUP);

  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);
  attachInterrupt(digitalPinToInterrupt(PIN_BUTTON), onBargeInButton, FALLING);

  if (!tls_memory::init()) {
    Serial.println("[TLS_MEM] startup stopped before network connections");
    for (;;) delay(1000);
  }
  initVoiceMonitor();
  Serial.printf("[WS_PRECONNECT] worker_ready=%d stack_bytes=8192 core=0\n", sonioxPreconnect.init(ws));

  // 再生ジッタバッファ初期化（PSRAM）+ 再生専用タスク起動
  playRing = (uint8_t*)ps_malloc(PLAY_RING_SIZE);
  if (playRing) {
    if (xTaskCreatePinnedToCore(playbackTask, "player", 8192, NULL, 2, &playerTaskHandle, 0) == pdPASS) {
      Serial.printf("🔊 Playback jitter buffer ready (%d KB)\n", PLAY_RING_SIZE / 1024);
    } else {
      free(playRing); playRing = nullptr; playerTaskHandle = nullptr;
      Serial.println("[PLAYER] task allocation failed; direct playback mode");
    }
  } else {
    Serial.println("⚠️ playRing ps_malloc failed → direct playback mode");
  }

  if (loadWiFiCredentials()) {
    // 高速起動: disconnect不要、100msポーリング
    WiFi.mode(WIFI_STA);
    wifi_country_t country = {
      .cc = "JP", .schan = 1, .nchan = 14, .max_tx_power = 20, .policy = WIFI_COUNTRY_POLICY_MANUAL
    };
    esp_wifi_set_country(&country);

    Serial.printf("📶 Connecting to: %s\n", wifiSSID.c_str());
    WiFi.begin(wifiSSID.c_str(), wifiPassword.c_str());

    // I2S録音設定をWiFi接続待ち中に先行実行
    setupI2SRecord();
    i2sRecordReady = micInstalled;
    Serial.println("🎙️ I2S ready (during WiFi connect)");

    // 100msポーリングで最大8秒待ち
    bool connected = false;
    for (int i = 0; i < 80; i++) {
      delay(100);
      if (wifiGotIP) { connected = true; break; }
      if (i % 10 == 9) Serial.print(".");
    }

    if (!connected) {
      // リトライ1回
      Serial.println("\n🔄 Retry...");
      WiFi.disconnect(true);
      delay(500);
      WiFi.mode(WIFI_STA);
      esp_wifi_set_country(&country);
      WiFi.begin(wifiSSID.c_str(), wifiPassword.c_str());
      for (int i = 0; i < 80; i++) {
        delay(100);
        if (wifiGotIP) { connected = true; break; }
      }
    }

    if (connected) {
      Serial.printf("\n✅ WiFi connected! IP: %s (%.1fs)\n", WiFi.localIP().toString().c_str(), millis() / 1000.0);
      sessionId = String(millis()) + "-" + String(random(100000, 999999));
      Serial.printf("🆔 Session ID: %s\n", sessionId.c_str());
      startNormalOperation();
    } else {
      Serial.println("\n❌ WiFi connection failed, entering BLE provisioning mode");
      startBLE();
    }
  } else {
    Serial.println("⚠️ No WiFi config, entering BLE provisioning mode");
    startBLE();
  }
}

// ==== 待ち受けの見張り: 無音なら休む・切れたら戻す（0.7.19）====
// 休みに入る合図の音（下がっていく短い音）。返答の再生と同じ順で I2S を切り替える:
// マイクを止める → 再生を作る → アンプ ON → 書く → アンプ OFF → 再生を消す。マイクは起きるときに作り直す。
void playSleepChime() {
  if (!pauseMicForPlaybackTest()) return;
  if (!setupI2SPlay()) {
    resetMicAfterPlaybackTest();
    return;
  }
  bargeInRequested.beginTurn();
  if (bargeInRequested.enableAmp(PIN_AMP_SD)) {
    delay(50);
    static int16_t buf[480];  // ステレオ240フレーム（10ms）
    const uint32_t totalFrames = SAMPLE_RATE_TTS * 350 / 1000;
    float phase = 0;
    size_t written = 0;
    for (uint32_t done = 0; done < totalFrames && !bargeInRequested;) {
      const uint32_t n = min((uint32_t)240, totalFrames - done);
      for (uint32_t i = 0; i < n; i++) {
        const float t = (float)(done + i) / totalFrames;          // 0→1
        const float freq = 880.0f - 550.0f * t;                   // 880Hz → 330Hz
        const float env = (t < 0.05f ? t / 0.05f : 1.0f) * (1.0f - t) * (1.0f - t);  // 立ち上がり5%、あとは消えていく
        phase += 2.0f * PI * freq / SAMPLE_RATE_TTS;
        if (phase > 2.0f * PI) phase -= 2.0f * PI;
        const int16_t v = (int16_t)(sinf(phase) * env * 9000.0f);
        buf[2 * i] = buf[2 * i + 1] = v;
      }
      writePlaybackI2s(buf, n * 4, &written, portMAX_DELAY);
      done += n;
    }
    delay(400);  // DMA（最大 0.34 秒ぶん）に残った音が出終わるまで
  }
  digitalWrite(PIN_AMP_SD, LOW);
  ampOn = false;
  bargeInRequested = false;
  resetMicAfterPlaybackTest();
  releaseI2sChannel(playbackTx);
}

// 休み中の LED（PWM）をやめて、いつもの digitalWrite に戻す
void leaveIdleSleepLed() {
  idleSleeping = false;
  ledcDetach(PIN_LED);
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, LOW);
}

void enterIdleSleep(uint32_t idleMs) {
  Serial.printf("[IDLE] sleep: no text for %lus; closing Soniox (button to wake)\n", (unsigned long)(idleMs / 1000));
  sttWanted = false;
  isRecording = false;
  sttDownSinceMs = sttUpSinceMs = 0;
  sttRecoverWaitMs = STT_RECOVER_FIRST_MS;
  if (sonioxPreconnect.ownsClient()) sonioxPreconnect.cancel();
  else {
    sonioxClosingOnPurpose = true;  // 切断の回数に数えない
    ws.disconnect();
    sonioxClosingOnPurpose = false;
  }
  sonioxPreconnectPending = false;
  partialText = "";
  sonioxFinalBuf = "";
  armed = false;
  endpointDetected = false;
  sttGrace = SttGraceState{};
  clearBackchannelCache();
  playSleepChime();
  // LED は休み中だけ PWM でゆっくり明滅させる（ほかの状態は digitalWrite のまま。休み中は音を出さない）
  if (ledTimer) timerAlarm(ledTimer, 0, false, 0);
  setLEDMode(LED_OFF);
  ledcAttach(PIN_LED, 5000, 8);
  ledcWrite(PIN_LED, 0);
  idleSleepStartMs = millis();
  idleSleeping = true;
}

void exitIdleSleep(const char* why) {
  Serial.printf("[IDLE] wake (%s) after %lus\n", why, (unsigned long)((millis() - idleSleepStartMs) / 1000));
  leaveIdleSleepLed();
  bargeInRequested = false;  // 起こすために押したボタンを「再生の中断」として残さない
  startSTTRecording();
}

// 休み中の loop()。ws.loop() は呼ばない（ライブラリが自分でつなぎ直してしまう）
void serviceIdleSleep() {
  static uint32_t lowSinceMs = 0;
  finishSonioxPreconnect();  // 取り消した先行接続があれば回収する
  handleButtonLongPress();
  if (currentMode != MODE_NORMAL || !idleSleeping) return;  // 長押しで BLE 設定へ入った
  if (digitalRead(PIN_BUTTON) == LOW) {
    if (!lowSinceMs) lowSinceMs = millis() | 1;
    else if (millis() - lowSinceMs >= debounceDelay) {
      lowSinceMs = 0;
      exitIdleSleep("button");
      return;
    }
  } else {
    lowSinceMs = 0;
  }
  // 明滅: 0 → 明るい → 0 を IDLE_BREATH_MS で1回。目に自然に見えるよう2乗する
  const float x = 0.5f - 0.5f * cosf(2.0f * PI * ((millis() - idleSleepStartMs) % IDLE_BREATH_MS) / IDLE_BREATH_MS);
  ledcWrite(PIN_LED, (uint32_t)(x * x * 255.0f));
  delay(10);
}

// 聞き取り中の loop() から毎回呼ぶ
void watchSttConnection() {
  if (!sttWanted) {
    sttDownSinceMs = sttUpSinceMs = 0;
    return;
  }
  const uint32_t now = millis();
  // 無音なら休む。文字が出ている間（partialText あり）は発話の途中なので数えない
  uint32_t idleMs = now - sttIdleSinceMs;
  if (lastTextChangeMs && now - lastTextChangeMs < idleMs) idleMs = now - lastTextChangeMs;
  if (partialText.length() == 0 && idleMs >= STT_IDLE_SLEEP_MS) {
    enterIdleSleep(idleMs);
    return;
  }
  // 切れたら戻す。ライブラリの自動再接続でつながっても isRecording は false のままなので、両方を見る
  if (sonioxPreconnect.ownsClient()) return;  // 先行接続ワーカーが接続中。結果を待つ
  if (isRecording && sonioxIsConnected()) {
    sttDownSinceMs = 0;
    if (!sttUpSinceMs) sttUpSinceMs = now | 1;
    else if (now - sttUpSinceMs >= STT_RECOVER_STABLE_MS) sttRecoverWaitMs = STT_RECOVER_FIRST_MS;
    return;
  }
  sttUpSinceMs = 0;
  if (!wifiGotIP) {  // Wi-Fi が戻ってから数え始める
    sttDownSinceMs = 0;
    return;
  }
  if (!sttDownSinceMs) {
    sttDownSinceMs = now | 1;
    return;
  }
  if (now - sttDownSinceMs < sttRecoverWaitMs) return;
  const uint32_t nextWaitMs = min(sttRecoverWaitMs * 2, (uint32_t)STT_RECOVER_MAX_MS);
  Serial.printf("[STT_RECOVER] not listening for %lums (recording=%d ws=%d); reconnecting, next wait %lums\n",
                (unsigned long)(now - sttDownSinceMs), isRecording, ws.isConnected(), (unsigned long)nextWaitMs);
  sttRecoverWaitMs = nextWaitMs;
  sonioxClosingOnPurpose = true;  // 自動再接続で半端につながった接続を捨てる。切断の回数には数えない
  ws.disconnect();
  sonioxClosingOnPurpose = false;
  sonioxPreconnectPending = false;
  sttRecovering = true;
  startSTTRecording();  // 鍵が古ければ取り直してから、新しく接続する
  sttRecovering = false;
  sttDownSinceMs = millis() | 1;  // 次の待ちはここから数える
}

// ==== ボタン長押し処理 ====
void handleButtonLongPress() {
  bool pressed = (digitalRead(PIN_BUTTON) == LOW);
  if (pressed && !buttonLongPressTriggered) {
    if (buttonPressStart == 0) {
      buttonPressStart = millis();
    } else if (millis() - buttonPressStart >= LONG_PRESS_MS) {
      buttonLongPressTriggered = true;
      if (currentMode == MODE_NORMAL) {
        Serial.println("🔘 Long press detected - Entering BLE mode");
        isRecording = false;
        sttWanted = false;
        if (idleSleeping) leaveIdleSleepLed();
        sonioxPlaybackPhase = false;
        if (sonioxPreconnect.ownsClient()) sonioxPreconnect.cancel();
        else ws.disconnect();
        WiFi.disconnect(true);
        startBLE();
      }
    }
  } else if (!pressed) {
    buttonPressStart = 0;
    buttonLongPressTriggered = false;
  }
}

// ==== LOOP ====
void loop() {
  if (currentMode == MODE_BLE_PROV) {
    finishSonioxPreconnect(); // collect cancelled job without touching a running socket
    handleButtonLongPress();
    if (!bleDeviceConnected && oldBleDeviceConnected) {
      delay(500);
      if (pServer) pServer->startAdvertising();
    }
    oldBleDeviceConnected = bleDeviceConnected;
    delay(10);
    return;
  }

  if (idleSleeping) {
    serviceIdleSleep();
    return;
  }

  serviceSoniox("recording_loop");
  handleButtonLongPress();
  if (currentMode != MODE_NORMAL) return;  // 長押しで BLE 設定へ入った
  watchSttConnection();
  if (idleSleeping) return;
  pollPlaybackGainSerial();

  // ボタンデバウンス
  int reading = digitalRead(PIN_BUTTON);
  if (reading != lastButtonReading) lastDebounceTime = millis();
  if ((millis() - lastDebounceTime) > debounceDelay) {
    if (reading != buttonState) {
      buttonState = reading;
    }
  }
  lastButtonReading = reading;

  // 録音データ送信
  if (isRecording && wifiGotIP && sonioxIsConnected()) {
    static uint32_t lastSend = 0;
    static uint32_t sendOk = 0, sendFail = 0;
    static uint32_t lastStats = 0;
    static uint16_t micPeak = 0;  // -32768の絶対値32768も表現する
    static int32_t rawMin = INT32_MAX, rawMax = INT32_MIN;  // 生データの振れ幅(DCオフセットとクロストークの判別用)
    static uint32_t rawSample = 0;
    if (millis() - lastSend > 5) {
      auto& raw = sttRaw;
      auto& pcm = sttPcm;
      size_t n = 0;
      readMicI2s((void*)raw, sizeof(raw), &n, portMAX_DELAY);
      if (n > 0 && turnEndTiming.pending && !turnEndTiming.firstReadSeen) {
        turnEndTiming.firstReadMs = millis();
        turnEndTiming.firstReadSeen = true;
      }
      int samples = n / sizeof(int32_t);
      sttMicFilter.convert(raw, pcm, samples);
      int64_t squares = 0;
      for (int i = 0; i < samples; i++) {
        uint32_t a = pcm[i] >= 0 ? int32_t(pcm[i]) : -int32_t(pcm[i]);
        if (a > micPeak) micPeak = a;
        if (raw[i] < rawMin) rawMin = raw[i];
        if (raw[i] > rawMax) rawMax = raw[i];
        squares += (int64_t)pcm[i] * pcm[i];
      }
      // 話し終わりの猶予（STT_GRACE_MS）。猶予中に声が出たら同じ発話として聞き続ける
      // 録音開始直後の DC 補正の過渡は除く（最初のブロック。[STT_INPUT] と同じ扱い）
      if (samples > 0 && !sttInputFirstBlock) {
        const uint32_t blockRms = (uint32_t)sqrt((double)squares / samples);
        if (!sttGrace.firstEndMs) {
          if (blockRms > sttGrace.speechPeakRms) sttGrace.speechPeakRms = blockRms;
        } else if (sttGrace.graceStartMs) {
          if (blockRms > sttGrace.gracePeakRms) sttGrace.gracePeakRms = blockRms;
          if (blockRms >= STT_GRACE_SPEECH_RMS) {
            sttGrace.graceStartMs = 0;
            sttGrace.resumes++;
            sttGrace.resumeStartMs = millis();
            Serial.printf("[GRACE] speech resumed +%lums after first end (rms=%lu)\n",
                          millis() - sttGrace.firstEndMs, (unsigned long)blockRms);
          }
        }
      }
      if (samples > 0) rawSample = (uint32_t)raw[0];
      bool ok = ws.sendBIN((uint8_t*)pcm, samples * sizeof(int16_t));
      if (ok) {
        if (samples > 0) {
          const uint32_t sentAtMs = millis();
          const auto buttonTiming = bargeInRequested.buttonTiming(true);
          if (buttonTiming.pressedUs != 0) {
            Serial.printf("[BUTTON] irq_to_first_send_ms=%lu\n",
                          (unsigned long)((esp_timer_get_time() - buttonTiming.pressedUs) / 1000));
          }
          const uint32_t triggerAtMs = voiceTriggerMs.exchange(0);
          if (triggerAtMs != 0) {
            Serial.printf("[VOICE] trigger_to_first_send_ms=%lu\n", (unsigned long)(sentAtMs - triggerAtMs));
          }
          printTurnEndTiming(sentAtMs);  // 毎ターン最初の音声送信だけ。sendOkの統計リセットとは独立。
          printVoiceLevelSummary();
          if (sttInputFirstBlock) {
            Serial.printf("[STT_INPUT] first_block_samples=%d dc=%ld clips=%lu zero_samples=%lu\n", samples,
                          (long)sttMicFilter.dc(), (unsigned long)sttMicFilter.clips(),
                          (unsigned long)sttMicFilter.zeros());
            sttInputFirstBlock = false;
          }
        }
        sendOk++;
        if (sendOk == 1 && sttRestartMs > 0) {
          Serial.printf("⏱️ STT [%lums] First audio packet sent\n", millis() - sttRestartMs);
          sttRestartMs = 0;
        }
      } else {
        sendFail++;
      }
      lastSend = millis();
    }
    if (millis() - powerReadMs >= POWER_SENSE_INTERVAL_MS) updatePowerReading();
    if (millis() - lastStats > 5000) {
      statsRecordRssi();  // 録音中(待機側)のRSSIも記録
      Serial.printf("[STT] send ok=%d fail=%d peak=%d rawMin=%ld rawMax=%ld raw0=0x%08lX RSSI=%d heap=%d\n",
                    sendOk, sendFail, micPeak, (long)rawMin, (long)rawMax, (unsigned long)rawSample, WiFi.RSSI(), ESP.getFreeHeap());
      sendOk = 0; sendFail = 0; micPeak = 0;
      rawMin = INT32_MAX; rawMax = INT32_MIN;
      lastStats = millis();
    }
  }

  // Sonioxエンドポイント検出 → 猶予（STT_GRACE_MS）。猶予が 0 ならすぐ送る
  if (endpointDetected) {
    endpointDetected = false;
    if (partialText.length() > 0) {
      const unsigned long now = millis();
      if (!sttGrace.firstEndMs) {
        sttGrace.firstEndMs = now;
        if (lastTextChangeMs) sttProgress.lastTextToEndMs = now - lastTextChangeMs;
      }
      sttGrace.resumeStartMs = 0;
      if (STT_GRACE_MS == 0) finishUtterance("no grace");
      else if (!sttGrace.graceStartMs) sttGrace.graceStartMs = now;
    }
  }
  if (armed && partialText.length() > 0) {
    const unsigned long now = millis();
    if (sttGrace.graceStartMs && now - sttGrace.graceStartMs >= STT_GRACE_MS) finishUtterance("quiet");
    else if (sttGrace.resumeStartMs && now - sttGrace.resumeStartMs >= STT_GRACE_RESUME_MAX_MS) finishUtterance("no new text");
    else if (!sttGrace.graceStartMs && !sttGrace.resumeStartMs && now - lastPartialMs >= STT_STALL_MS) finishUtterance("stall");
  }
}

// 発話を Lambda へ送る（猶予の判定から）。[GRACE] の行はしきい値と猶予の長さを詰めるための計測
void finishUtterance(const char* why) {
  const SttGraceState g = sttGrace;
  sttGrace = SttGraceState{};
  // この発話の聞き取りを次の要求に添える（TurnReport.h の SttReport）
  sttReport = sttProgress;
  sttReport.valid = true;
  sttReport.listenMs = millis() - sttRecordStartMs;
  sttReport.endToSendMs = g.firstEndMs ? millis() - g.firstEndMs : 0;
  sttReport.resumes = g.resumes;
  sttReport.speechPeakRms = g.speechPeakRms;
  sttReport.gracePeakRms = g.gracePeakRms;
  sttReport.disconnects = sonioxDisconnects;
  sttReport.errors = sonioxErrors;
  sttReport.why = why;  // 呼び出し側は文字列リテラルだけ
  sonioxDisconnects = sonioxErrors = 0;
  Serial.printf("[STT_REPORT] {%s}\n", sttReportJson(sttReport).c_str());  // この要求の device.stt と同じ中身
  Serial.printf("[GRACE] sent +%ldms after first end (%s, resumed=%lu, grace=%lums, speech_peak_rms=%lu, grace_peak_rms=%lu, threshold=%lu)\n",
                g.firstEndMs ? (long)(millis() - g.firstEndMs) : -1L, why, (unsigned long)g.resumes,
                STT_GRACE_MS, (unsigned long)g.speechPeakRms, (unsigned long)g.gracePeakRms,
                (unsigned long)STT_GRACE_SPEECH_RMS);
  String text = partialText;
  armed = false;
  partialText = "";
  sonioxFinalBuf = "";
  if (text != lastFinalText) {
    lastFinalText = text;
    sendToLambdaAndPlay(text);
  }
}
