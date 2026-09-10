// toytalker_mini_v0.7 — experimental AEC voice barge-in
// v0.5安定版・v0.6音量方式を保持。AEC後の音量で停止し、通常STTへ戻す実験版。
// 受信(producer)とI2S再生(consumer)をFreeRTOSタスクで分離し、PSRAMリングバッファで吸収
// LED制御はすべてdigitalWrite

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
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
#include <esp_arduino_version.h>

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

// ==== Lambda (TTS) - Binary Streaming ====
const char* LAMBDA_HOST = "koufofwm3w4tidbe52crbyhpyq0cshss.lambda-url.ap-northeast-1.on.aws";
const char* LAMBDA_PATH = "/";

// ==== Lambda (Backchannel) ====
const char* BACKCHANNEL_HOST = "birb7yjw4nkldidcza4xfiyn5e0taluh.lambda-url.ap-northeast-1.on.aws";
const char* BACKCHANNEL_PATH = "/";

// ==== Lambda (Soniox Key) ====
const char* SONIOX_LAMBDA_URL = "https://ug5fcnjsxa22vtnrzlwpfgshd40nngbo.lambda-url.ap-northeast-1.on.aws/";

// ==== Soniox ====
const char* SONIOX_WS_URL = "stt-rt.soniox.com";
const int SONIOX_WS_PORT = 443;
String sonioxKey;
String sonioxModel = "stt-rt-v4";

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

// ==== 電源・温度・充電（v0.2基板新設。Step 2bで読み取り実装予定） ====
#define PIN_VBAT_ADC   1   // 470k×2分圧: 実電圧=読み値×2。ADC1系なのでWiFi中も測定可
#define PIN_BOARD_TEMP 2   // TH2分圧(基板温度)
#define PIN_CHG_STAT1  13  // BQ25185 STAT1(100kプルアップ済みオープンドレイン)
#define PIN_CHG_STAT2  14  // BQ25185 STAT2

// LED状態（PWMなし、digitalWriteのみ）
enum LEDMode {
  LED_OFF,
  LED_ON,          // 点灯 = 録音中（話してOK）
  LED_BLINKING,    // 600ms周期 = 再生中
  LED_BLINK_SLOW,  // 1.2s周期 = 準備中（起動〜録音準備完了）
  LED_BLINK_FAST   // 300ms周期 = BLE設定モード
};

volatile LEDMode currentLEDMode = LED_OFF;
volatile bool blinkState = false;
hw_timer_t* ledTimer = NULL;
bool ampOn = false;
BargeInFlag bargeInRequested;
volatile bool sonioxPreconnectPending = false;  // 再生中の先行WS接続が進行中か

void IRAM_ATTR onBargeInButton() {
  bargeInRequested.setFromISR();
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
const unsigned long END_SILENCE_MS = 800;
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
static bool ttsFirstPcmLogged = false;  // loopのみ
static uint32_t ttsRingWaitMs = 0;      // producerのみ
static uint32_t sonioxServiceMaxMs = 0;

String sonioxStartMessage() {
  return "{\"api_key\":\"" + sonioxKey + "\","
         "\"model\":\"" + sonioxModel + "\","
         "\"audio_format\":\"pcm_s16le\",\"sample_rate\":16000,\"num_channels\":1,"
         "\"enable_partial_results\":true,\"enable_endpoint_detection\":true,"
         "\"language_hints\":[\"ja\",\"en\"]}";
}

bool sonioxIsConnected() {
  return !sonioxPreconnect.ownsClient() && ws.isConnected();
}

void finishSonioxPreconnect() {
  SonioxPreconnect::Result result;
  if (!sonioxPreconnect.takeResult(result, webSocketEvent)) return;
  Serial.printf("[WS_PRECONNECT] elapsed_ms=%lu ready=%d cancelled=%d stack_free=%lu\n",
                (unsigned long)result.elapsedMs, result.ready, result.cancelled, (unsigned long)result.stackFree);
  sonioxPreconnectPending = false;
  if (result.ready) sonioxConnectionReady(); // start message was already sent by the worker
}

void prepareSonioxDuringPlayback() {
  sonioxPlaybackPhase = true;
  finishSonioxPreconnect();
  if (sonioxPreconnect.ownsClient()) return;
  ws.disconnect();
  ws.beginSSL(SONIOX_WS_URL, SONIOX_WS_PORT, "/transcribe-websocket");
  ws.onEvent(webSocketEvent);
  ws.enableHeartbeat(15000, 3000, 2);
  sonioxPreconnectPending = true;
  const bool background = sonioxPreconnect.start(sonioxStartMessage());
  Serial.printf("[WS_PRECONNECT] started background=%d core=0\n", background);
}

// During playback, connect/start runs on Core 0 while loop keeps receiving TTS.
// Connected-client polling and all application callbacks stay on loop.
void serviceSoniox(const char* stage) {
  finishSonioxPreconnect();
  if (sonioxPreconnect.ownsClient()) return;
  if (sonioxPlaybackPhase && !ws.isConnected() && sonioxPreconnect.available()) {
    if (bargeInRequested) return; // STT restart will decide how to reconnect
    if (sonioxPreconnect.start(sonioxStartMessage())) {
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
const float VOLUME = 1.5;  // デジタルゲイン（クリップ保護あり）。2.0はノイズ増の割に音量差わずかで、1.5がスイートスポット

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
  if (mode == LED_BLINKING || mode == LED_BLINK_SLOW || mode == LED_BLINK_FAST) {
    static uint8_t blinkCounter = 0;
    // 30msティック数: FAST=5(150ms毎), BLINKING=10(300ms毎), SLOW=20(600ms毎)
    uint8_t ticks = (mode == LED_BLINK_FAST) ? 5 : (mode == LED_BLINK_SLOW) ? 20 : 10;
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
  for (size_t i = 0; i < samples; i++) {
    // クリップ保護: int16範囲を超えたら飽和させる（オーバーフローによる波形破壊を防ぐ）
    int32_t v = (int32_t)(mono[i] * VOLUME);
    if (v > 32767) v = 32767;
    else if (v < -32768) v = -32768;
    int16_t sample = (int16_t)v;
    stereo[2*i]     = sample;
    stereo[2*i + 1] = sample;
  }
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
      while (voiceMonitorEnabled.load()) {
        const bool triggered = aecMonitor.pump();
        if (triggered && voiceMonitorEnabled.load() && !bargeInRequested) {
          const uint32_t atMs = millis();
          if (!AEC_BARGE_DETECT_ONLY) {
            voiceTriggerMs.store(atMs);
            digitalWrite(PIN_AMP_SD, LOW);
            bargeInRequested = true;
            // Signal only: loop owns sockets, playback cancellation and channel lifetime.
            aecMonitor.stopCapture();
            voiceMonitorEnabled.store(false);
          }
          aecMonitor.printTrigger(atMs);
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

size_t playRingFree() {
  return PLAY_RING_SIZE - 1 - playRingAvail();
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
  for (;;) {
    if (!playerActive) {
      playerParked = true;
      vTaskDelay(pdMS_TO_TICKS(5));
      continue;
    }
    playerParked = false;

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
  }
}

// 再生セッション開始（I2Sドライバインストール後に呼ぶ）
void playerStart() {
  if (!playRing) return;
  playRingHead = 0;
  playRingTail = 0;
  playerStreamEnd = false;
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
    digitalWrite(PIN_AMP_SD, HIGH);
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
    if (bytesRead > 0 && !ttsFirstPcmLogged) {
      ttsFirstPcmLogged = true;
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
  String payload = "{\"partial_text\":\"" + partial + "\"";
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
    http.begin(url);
    http.addHeader("Content-Type", "application/json");
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
};

void lambdaConnectAndSendTask(void* param) {
  LambdaConnectParams* p = (LambdaConnectParams*)param;
  // 原因特定用: TLS接続直前の内部RAM状態(free / 最大連続ブロック)。
  // TLSの合計使用量と1回の確保サイズは別。freeが足りてもmax_blkが小さいと確保に失敗し得る。
  Serial.printf("[DIAG] pre-connect free=%u max_blk=%u\n",
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  tls_memory::printStats("lambda_pre_connect");
  p->client->setInsecure();
  uint32_t connectStart = millis();
  bool connected = p->client->connect(LAMBDA_HOST, 443);
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

// ==== Lambda に送信 & SSE 受信 ====
void sendToLambdaAndPlay(const String& text) {
  unsigned long t0 = millis();
  ttsTurnStartMs.store(t0);
  ttsFirstWriteLogged.store(false);
  ttsFirstPcmLogged = false;
  ttsRingWaitMs = 0;
  sonioxServiceMaxMs = 0;
  Serial.println("🚀 Sending to Lambda: " + text);
  Serial.printf("💾 Free heap: %d bytes\n", ESP.getFreeHeap());
  responseText = "";
  ttsAudioQueued = false;
  ttsGapPending = false;
  bargeInRequested = false;

  turnEndTiming = TurnEndTiming{};
  dmaTailTiming = DmaTailTiming{};
  turnEndTiming.turn = ++turnTimingSequence;
  lastI2sWriteMs.store(0, std::memory_order_relaxed);

  if (isRecording) isRecording = false;
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
    clearBackchannelCache();
    startSTTRecording();
    return;
  }
  Serial.printf("[VOICE_TEST] playback rx_paused=%d rx_released=%d raw_detect_only=%d aec_detect_only=%d\n",
                micPausedForPlayback, micReleasedForPlayback, VOICE_BARGE_DETECT_ONLY, AEC_BARGE_DETECT_ONLY);
  if (!setupI2SPlay()) {
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

  String payload =
    "{\"model\":\"" + String(TTS_PROVIDER) + "\",\"voice\":\"" + String(TTS_CHARACTER) + "\","
    "\"device_id\":\"" + deviceMacAddress + "\","
    "\"session_id\":\"" + sessionId + "\","
    "\"owner_id\":\"" + deviceMacAddress + "\","
    "\"backchannel_fired\":" + (backchannelForReply ? "true" : "false") + ","
    "\"messages\":" + messagesJson + "}";

  Serial.printf("📝 History count: %d\n", historyCount);

  String req =
    String("POST ") + LAMBDA_PATH + " HTTP/1.1\r\n"
    "Host: " + LAMBDA_HOST + "\r\n"
    "Content-Type: application/json\r\n"
    "Accept: text/event-stream\r\n"
    "Connection: close\r\n"
    "Content-Length: " + payload.length() + "\r\n\r\n"
    + payload;

  // Lambda SSL接続+送信をCore 0でバックグラウンド
  WiFiClientSecure client;
  LambdaConnectParams connParams = { &client, &req, false, false, false };
  TaskHandle_t connTaskHandle = NULL;
  if (xTaskCreatePinnedToCore(lambdaConnectAndSendTask, "lambda_conn", 16384, &connParams, 1, &connTaskHandle, 0) != pdPASS) {
    connParams.failed = true;
    Serial.println("[VOICE] Lambda task allocation failed; returning to recording");
  }
  Serial.printf("⏱️ [%lums] Lambda task started on Core 0\n", millis() - t0);

  // アンプON（PWMなし）
  if (!ampOn) {
    pinMode(PIN_AMP_SD, OUTPUT);
    digitalWrite(PIN_AMP_SD, HIGH);
    delay(50);
    ampOn = true;
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

  if (connParams.failed) {
    stopVoiceMonitor();
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

  Serial.printf("[LATENCY] headers_ms=%lu turn_elapsed_ms=%lu interrupted=%d\n",
                (unsigned long)(millis() - headerStart), millis() - t0, (bool)bargeInRequested);
  Serial.printf("⏱️ [%lums] Header phase ended\n", millis() - t0);
  if (headersOk) Serial.println("📨 BINARY STREAM START (Chunked)");

  lambdaBody.reset();

  setLEDMode(LED_BLINKING);

  while (headersOk && !bargeInRequested && !responseFailed) {
    uint8_t header[5];
    size_t read = readBytesAcrossChunks(client, header, 5);
    if (read == 0 && lambdaBody.done()) {
      Serial.println("🏁 BINARY STREAM END");
      break;
    }
    if (read != 5) {
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
      if (!processPCM(client, length)) {
        responseFailed = !bargeInRequested;
        break;
      }
    }
  }

  unsigned long tEnd = millis();
  turnEndTiming.pending = true;
  turnEndTiming.receiveEndMs = tEnd;
  turnEndTiming.interrupted = bargeInRequested || responseFailed;

  if (bargeInRequested || responseFailed) {
    digitalWrite(PIN_AMP_SD, LOW);
    if (responseFailed) Serial.println("[STREAM_ERROR] dropping response and returning to recording");
    else Serial.println("🔘 Barge-in: skipping buffer flush");
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
  Serial.printf("⏱️ end+[%lums] Amp off\n", millis() - tEnd);
  statsPrint();  // このターンのWiFi/再生品質サマリ

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
      if (msg.indexOf("\"tokens\"") >= 0) {
        String nonFinalCurrent = "";
        bool foundEndToken = false;
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
          } else if (isFinal) {
            sonioxFinalBuf += token;
          } else {
            nonFinalCurrent += token;
          }
          searchPos = textEnd + 1;
        }

        String fullText = sonioxFinalBuf + nonFinalCurrent;
        if (fullText.length() > 0) {
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
      ws.beginSSL(SONIOX_WS_URL, SONIOX_WS_PORT, "/transcribe-websocket");
      ws.onEvent(webSocketEvent);
      ws.enableHeartbeat(15000, 3000, 2);
    }
  } else {
    // 起動直後など先行接続が存在しない場合は待たずに即接続（従来はここで5秒無駄待ちしていた）
    Serial.printf("⏱️ STT [%lums] No preconnect pending, connecting fresh\n", millis() - t0);
    ws.beginSSL(SONIOX_WS_URL, SONIOX_WS_PORT, "/transcribe-websocket");
    ws.onEvent(webSocketEvent);
    ws.enableHeartbeat(15000, 3000, 2);
  }
  isRecording = true;
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

  // Sonioxキー取得（WiFi切替直後などの一時的な失敗に備えて3回リトライ）
  HTTPClient http;
  String initUrl = String(SONIOX_LAMBDA_URL) + "?device_id=" + deviceMacAddress;
  int code = -1;
  String resp;
  for (int attempt = 1; attempt <= 3; attempt++) {
    http.begin(initUrl);
    code = http.GET();
    if (code == 200) {
      resp = http.getString();
      http.end();
      break;
    }
    Serial.printf("⚠️ Soniox key fetch failed (HTTP %d), attempt %d/3\n", code, attempt);
    http.end();
    delay(1000);
  }
  if (code != 200) {
    Serial.println("❌ Soniox key fetch gave up");
    setLEDMode(LED_OFF);
    return;
  }

  DynamicJsonDocument doc(512);
  if (deserializeJson(doc, resp)) {
    setLEDMode(LED_OFF);
    return;
  }
  sonioxKey = doc["api_key"].as<String>();
  Serial.println("✅ Soniox temp key obtained");

  if (doc.containsKey("backchannel_enabled")) {
    backchannelEnabled = doc["backchannel_enabled"].as<bool>();
  }
  if (doc.containsKey("stt_model")) {
    sonioxModel = doc["stt_model"].as<String>();
  }
  Serial.printf("🔊 Backchannel: %s, STT: %s\n", backchannelEnabled ? "ON" : "OFF", sonioxModel.c_str());

  startSTTRecording();
}

// ==== SETUP ====
void setup() {
  Serial.begin(921600);
  delay(100);
  Serial.println(AEC_BARGE_DETECT_ONLY ? "\n🚀 ToyTalker Mini v0.7 (AEC evaluation / detect only)"
                                     : "\n🚀 ToyTalker Mini v0.7 (AEC barge-in trial)");
  Serial.printf("[BUILD] arduino=%s idf=%s\n", ESP_ARDUINO_VERSION_STR, esp_get_idf_version());
  esp_err_t allocHookResult = heap_caps_register_failed_alloc_callback(recordAllocationFailure);
  Serial.printf("[ALLOC_FAIL] hook_install_err=%d\n", allocHookResult);
  Serial.printf("[VOICE_TEST] mode=%s rx_dma_count=%d rx_dma_frames=%d raw_detect_only=%d aec_detect_only=%d\n",
                VOICE_RX_PAUSE_DURING_PLAYBACK ? (VOICE_RX_RELEASE_WHEN_PAUSED ? "release_rx" : "pause_rx")
                                             : (VOICE_RX_RESET_AFTER_PLAYBACK ? "monitor_reset_each_turn"
                                                : (VOICE_RX_TEST_MODE == VoiceRxTestMode::MonitorSmallDma ? "monitor_small_dma" : "monitor_original_dma")),
                MIC_DMA_COUNT, MIC_DMA_FRAMES, VOICE_BARGE_DETECT_ONLY, AEC_BARGE_DETECT_ONLY);

  WiFi.onEvent(WiFiEvent);

  // LED初期化（digitalWriteのみ、PWMなし）
  pinMode(PIN_LED, OUTPUT);
  digitalWrite(PIN_LED, HIGH);

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
  attachInterrupt(digitalPinToInterrupt(PIN_BUTTON), onBargeInButton, FALLING);

  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);

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

  serviceSoniox("recording_loop");
  handleButtonLongPress();

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
      for (int i = 0; i < samples; i++) {
        uint32_t a = pcm[i] >= 0 ? int32_t(pcm[i]) : -int32_t(pcm[i]);
        if (a > micPeak) micPeak = a;
        if (raw[i] < rawMin) rawMin = raw[i];
        if (raw[i] > rawMax) rawMax = raw[i];
      }
      if (samples > 0) rawSample = (uint32_t)raw[0];
      bool ok = ws.sendBIN((uint8_t*)pcm, samples * sizeof(int16_t));
      if (ok) {
        if (samples > 0) {
          const uint32_t sentAtMs = millis();
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
    if (millis() - lastStats > 5000) {
      statsRecordRssi();  // 録音中(待機側)のRSSIも記録
      Serial.printf("[STT] send ok=%d fail=%d peak=%d rawMin=%ld rawMax=%ld raw0=0x%08lX RSSI=%d heap=%d\n",
                    sendOk, sendFail, micPeak, (long)rawMin, (long)rawMax, (unsigned long)rawSample, WiFi.RSSI(), ESP.getFreeHeap());
      sendOk = 0; sendFail = 0; micPeak = 0;
      rawMin = INT32_MAX; rawMax = INT32_MIN;
      lastStats = millis();
    }
  }

  // Sonioxエンドポイント検出
  if (endpointDetected && partialText.length() > 0) {
    if (partialText != lastFinalText) {
      lastFinalText = partialText;
      sendToLambdaAndPlay(partialText);
    }
    endpointDetected = false;
    armed = false;
    partialText = "";
    sonioxFinalBuf = "";
  }
  // 無音検出フォールバック
  else if (armed && partialText.length() > 0 && (millis() - lastPartialMs) >= END_SILENCE_MS) {
    if (partialText != lastFinalText) {
      lastFinalText = partialText;
      sendToLambdaAndPlay(partialText);
    }
    armed = false;
    partialText = "";
    sonioxFinalBuf = "";
  }
}
