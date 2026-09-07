// toytalker_mini_v0.5
// v0.4ベース、v0.2基板(2026-08-30配置最適化ピン)対応。Step 2a: ピン載せ替えのみ、ロジック変更なし
// （v0.1基板との[STATS]比較を成立させるため、動作はv0.4と同一に保つ。センサー系追加はStep 2bで）
// 受信(producer)とI2S再生(consumer)をFreeRTOSタスクで分離し、PSRAMリングバッファで吸収
// LED制御はすべてdigitalWrite

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <driver/i2s.h>
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
volatile bool bargeInRequested = false;
volatile bool sonioxPreconnectPending = false;  // 再生中の先行WS接続が進行中か

void IRAM_ATTR onBargeInButton() {
  bargeInRequested = true;
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
String partialText = "";
String sonioxFinalBuf = "";
String lastFinalText = "";
unsigned long lastPartialMs = 0;
const unsigned long END_SILENCE_MS = 800;
bool armed = false;
bool isRecording = false;
bool endpointDetected = false;
bool i2sRecordReady = false;
unsigned long sttRestartMs = 0;  // STT再開計測用

// ==== TTS 受信状態 ====
int curSegmentId = -1;
String responseText = "";
uint8_t* currentPcmBuffer = NULL;
size_t currentPcmSize = 0;
const uint32_t TTS_SEGMENT_GAP_MS = 400;  // 文の区切りに追加する間（先頭・末尾には入れない）
bool ttsAudioQueued = false;
bool ttsGapPending = false;

// 終了待ちの内訳を計測。出力は最初の録音パケット送信後にまとめる。
// lastI2sWriteMsはDMAへのコピー完了時刻であり、スピーカーの発声終了時刻ではない。
static std::atomic<uint32_t> lastI2sWriteMs{0};
static std::atomic<uint32_t> playbackI2sBytes{0};
static QueueHandle_t playbackI2sEvents = NULL;
static constexpr size_t PLAY_DMA_COUNT = 8;
static constexpr size_t PLAY_DMA_FRAMES = 1024;
static constexpr size_t PLAY_I2S_EVENT_COUNT = 32;
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

// 最後のバッファ内の位置を知るため、相槌・区切り無音も含む全コピー量を数える。
esp_err_t writePlaybackI2s(const void* data, size_t len, size_t* written, TickType_t timeout) {
  esp_err_t err = i2s_write(I2S_NUM_1, data, len, written, timeout);
  playbackI2sBytes.fetch_add(*written, std::memory_order_relaxed);
  return err;
}

// EOFイベントから実際のバッファサイズを取得。legacyドライバは4096を4092に丸める。
// 監視中のイベント欠落・DMAエラー・空きバッファのスキップがあれば計測を無効にする。
void pollPlaybackI2sEvents(bool monitoring) {
  if (!playbackI2sEvents) return;
  if (monitoring && uxQueueMessagesWaiting(playbackI2sEvents) >= PLAY_I2S_EVENT_COUNT) {
    dmaTailTiming.valid = false;
  }
  i2s_event_t event;
  while (xQueueReceive(playbackI2sEvents, &event, 0) == pdTRUE) {
    if (event.type == I2S_EVENT_TX_DONE) {
      if (monitoring && event.size != dmaTailTiming.blockBytes) dmaTailTiming.valid = false;
      dmaTailTiming.blockBytes = event.size;
    } else if (monitoring && (event.type == I2S_EVENT_TX_Q_OVF || event.type == I2S_EVENT_DMA_ERROR)) {
      dmaTailTiming.valid = false;
    }
  }
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
void setupI2SRecord() {
  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_RX),
    .sample_rate = SAMPLE_RATE_STT,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_32BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = (i2s_comm_format_t)(I2S_COMM_FORMAT_I2S | I2S_COMM_FORMAT_I2S_MSB),
    .intr_alloc_flags = 0,
    .dma_buf_count = 8,
    .dma_buf_len = 512,
    .use_apll = true,
    .tx_desc_auto_clear = false,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pins = {
    .bck_io_num = PIN_MIC_BCLK,
    .ws_io_num = PIN_MIC_WS,
    .data_out_num = I2S_PIN_NO_CHANGE,
    .data_in_num = PIN_MIC_DATA
  };

  i2s_driver_install(I2S_NUM_0, &cfg, 0, NULL);
  i2s_set_pin(I2S_NUM_0, &pins);
  i2s_start(I2S_NUM_0);
}

// ==== I2S 再生設定 (TTS) ====
void setupI2SPlay() {
  pinMode(PIN_AMP_SD, OUTPUT);
  digitalWrite(PIN_AMP_SD, LOW);
  delay(10);

  i2s_config_t cfg = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = SAMPLE_RATE_TTS,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT,
    .communication_format = (i2s_comm_format_t)(I2S_COMM_FORMAT_I2S | I2S_COMM_FORMAT_I2S_MSB),
    .intr_alloc_flags = 0,
    .dma_buf_count = PLAY_DMA_COUNT,
    .dma_buf_len = PLAY_DMA_FRAMES,
    .use_apll = true,
    .tx_desc_auto_clear = true,
    .fixed_mclk = 0
  };

  i2s_pin_config_t pins = {
    .bck_io_num = PIN_AMP_BCLK,
    .ws_io_num = PIN_AMP_WS,
    .data_out_num = PIN_AMP_DIN,
    .data_in_num = I2S_PIN_NO_CHANGE
  };

  playbackI2sEvents = NULL;
  if (i2s_driver_install(I2S_NUM_1, &cfg, PLAY_I2S_EVENT_COUNT, &playbackI2sEvents) != ESP_OK) {
    // 計測用キューを確保できなければ従来の再生構成を試す。
    playbackI2sEvents = NULL;
    i2s_driver_install(I2S_NUM_1, &cfg, 0, NULL);
  }
  i2s_set_pin(I2S_NUM_1, &pins);
  i2s_set_clk(I2S_NUM_1, SAMPLE_RATE_TTS, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_STEREO);
  playbackI2sBytes.store(0, std::memory_order_relaxed);
}

// ==== チャンク管理用グローバル変数 ====
static int g_currentChunkSize = -1;
static int g_bytesReadFromChunk = 0;

// ==== HTTPチャンクサイズ読み取り ====
int readChunkSize(WiFiClientSecure& client) {
  const int MAX_RETRIES = 3;
  for (int retry = 0; retry < MAX_RETRIES; retry++) {
    String line = "";
    unsigned long startTime = millis();
    while (client.connected() && (millis() - startTime < 5000)) {
      if (client.available()) {
        char c = client.read();
        if (c == '\n') break;
        else if (c != '\r') line += c;
      } else {
        delay(1);
      }
    }
    if (line.length() == 0) {
      if (retry < MAX_RETRIES - 1) { delay(100); continue; }
      return -1;
    }
    int chunkSize = 0;
    bool validHex = false;
    for (int i = 0; i < line.length(); i++) {
      char c = line.charAt(i);
      if (c >= '0' && c <= '9') { chunkSize = chunkSize * 16 + (c - '0'); validHex = true; }
      else if (c >= 'a' && c <= 'f') { chunkSize = chunkSize * 16 + (c - 'a' + 10); validHex = true; }
      else if (c >= 'A' && c <= 'F') { chunkSize = chunkSize * 16 + (c - 'A' + 10); validHex = true; }
      else break;
    }
    if (!validHex) {
      if (retry < MAX_RETRIES - 1) { delay(100); continue; }
      return -1;
    }
    return chunkSize;
  }
  return -1;
}

// ==== チャンク境界を超えてデータを読む ====
size_t readBytesAcrossChunks(WiFiClientSecure& client, uint8_t* buffer, size_t length) {
  size_t totalRead = 0;
  unsigned long startTime = millis();
  const unsigned long TIMEOUT_MS = 10000;

  while (totalRead < length) {
    if (millis() - startTime > TIMEOUT_MS) return totalRead;

    if (g_currentChunkSize == -1 || g_bytesReadFromChunk >= g_currentChunkSize) {
      if (g_currentChunkSize > 0) {
        while (!client.available() && client.connected() && (millis() - startTime < TIMEOUT_MS)) delay(1);
        client.read();
        client.read();
      }
      g_currentChunkSize = readChunkSize(client);
      g_bytesReadFromChunk = 0;
      if (g_currentChunkSize == 0) return totalRead;
      else if (g_currentChunkSize < 0) return totalRead;
    }

    int remainingInChunk = g_currentChunkSize - g_bytesReadFromChunk;
    int toRead = min((int)(length - totalRead), remainingInChunk);

    while (!client.available() && client.connected() && (millis() - startTime < TIMEOUT_MS)) delay(1);
    if (!client.connected() && !client.available()) return totalRead;

    int available = client.available();
    if (available > 0) {
      int actualRead = min(toRead, available);
      size_t read = client.readBytes(buffer + totalRead, actualRead);
      totalRead += read;
      g_bytesReadFromChunk += read;
    }
  }
  return totalRead;
}

// ==== メタデータ処理 (type=0x01) ====
void processMetadata(WiFiClientSecure& client, uint32_t length) {
  if (length == 0 || length > 4096) return;

  char* jsonBuf = (char*)malloc(length + 1);
  if (!jsonBuf) return;

  size_t bytesRead = readBytesAcrossChunks(client, (uint8_t*)jsonBuf, length);
  jsonBuf[bytesRead] = '\0';

  if (bytesRead != length) {
    Serial.printf("[META] Read mismatch: expected=%d, got=%d\n", length, bytesRead);
    free(jsonBuf);
    return;
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
    }
  }

  free(jsonBuf);
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
      delay(1);
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
    if (written > 0) lastI2sWriteMs.store(millis(), std::memory_order_relaxed);
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

// ==== PCMデータ処理 (type=0x02) ====
bool processPCM(WiFiClientSecure& client, uint32_t length) {
  // アンプON（PWMなし）
  if (!ampOn) {
    pinMode(PIN_AMP_SD, OUTPUT);
    digitalWrite(PIN_AMP_SD, HIGH);
    delay(50);
    ampOn = true;
  }
  Serial.printf("[PCM] Streaming %d bytes\n", length);

  // リングバッファ再生時は細かい粒度で読み、受信・ws.loop()の頻度を上げる
  const size_t STREAM_CHUNK_SIZE = playRing ? 8192 : 65536;
  uint32_t remaining = length;
  uint32_t totalPlayed = 0;

  while (remaining > 0) {
    if (bargeInRequested) {
      Serial.println("🔘 Barge-in! Stopping playback");
      return true;
    }

    uint32_t chunkSize = (remaining > STREAM_CHUNK_SIZE) ? STREAM_CHUNK_SIZE : remaining;

    uint8_t* pcmData = (uint8_t*)ps_malloc(chunkSize);
    if (!pcmData) pcmData = (uint8_t*)malloc(chunkSize);
    if (!pcmData) {
      Serial.printf("[PCM] malloc failed for chunk! Skipping remaining %d bytes\n", remaining);
      uint8_t dummy[512];
      while (remaining > 0) {
        uint32_t toRead = (remaining > 512) ? 512 : remaining;
        size_t read = readBytesAcrossChunks(client, dummy, toRead);
        if (read == 0) break;
        remaining -= read;
      }
      return false;
    }

    size_t bytesRead = readBytesAcrossChunks(client, pcmData, chunkSize);
    if (bytesRead != chunkSize) {
      Serial.printf("[PCM] Read mismatch in chunk: expected=%d, got=%d\n", chunkSize, bytesRead);
      free(pcmData);
      break;
    }

    size_t samples = bytesRead / 2;
    size_t stereoBytes = samples * 4;
    int16_t* stereo = (int16_t*)malloc(stereoBytes);
    if (!stereo) {
      Serial.println("[PCM] stereo malloc failed for chunk!");
      free(pcmData);
      break;
    }

    monoToStereo((int16_t*)pcmData, stereo, samples);
    free(pcmData);

    if (stereoBytes > 0 && ttsGapPending) {
      if (!queueTtsSegmentGap()) {
        free(stereo);
        return true;  // 割り込みまたはI2Sエラーでストリームを停止
      }
      ttsGapPending = false;
    }

    if (playRing) {
      // リングバッファへ投入（再生はplaybackTaskが担当）
      if (!playRingPush((uint8_t*)stereo, stereoBytes)) {
        free(stereo);
        return true;  // barge-in
      }
      if (stereoBytes > 0) ttsAudioQueued = true;
    } else {
      // フォールバック: 直接再生（リングバッファ確保失敗時）
      size_t written = 0;
      writePlaybackI2s((uint8_t*)stereo, stereoBytes, &written, portMAX_DELAY);
      if (written > 0) lastI2sWriteMs.store(millis(), std::memory_order_relaxed);
      if (written > 0) ttsAudioQueued = true;
    }
    free(stereo);

    totalPlayed += stereoBytes;
    remaining -= bytesRead;
    ws.loop();  // SSL handshake進行
  }

  Serial.printf("[PCM] Streaming complete: %d bytes total\n", totalPlayed);
  return false;
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

  while (offset < samples) {
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
  volatile bool connected;
  volatile bool sent;
  volatile bool failed;
};

void lambdaConnectAndSendTask(void* param) {
  LambdaConnectParams* p = (LambdaConnectParams*)param;
  // 原因特定用: TLS接続直前の内部RAM状態(free / 最大連続ブロック)。
  // TLSハンドシェイクは連続40KB前後を要求するので、freeが足りていてもmax_blkが小さいと失敗する
  Serial.printf("[DIAG] pre-connect free=%u max_blk=%u\n",
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  p->client->setInsecure();
  if (!p->client->connect(LAMBDA_HOST, 443)) {
    Serial.printf("[DIAG] connect() FAILED, post free=%u max_blk=%u\n",
                  (unsigned)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                  (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    p->failed = true;
    vTaskDelete(NULL);
    return;
  }
  p->connected = true;
  p->client->print(*(p->request));
  p->sent = true;
  vTaskDelete(NULL);
}

// ==== Lambda に送信 & SSE 受信 ====
void sendToLambdaAndPlay(const String& text) {
  unsigned long t0 = millis();
  Serial.println("🚀 Sending to Lambda: " + text);
  Serial.printf("💾 Free heap: %d bytes\n", ESP.getFreeHeap());
  responseText = "";
  ttsAudioQueued = false;
  ttsGapPending = false;

  turnEndTiming = TurnEndTiming{};
  dmaTailTiming = DmaTailTiming{};
  turnEndTiming.turn = ++turnTimingSequence;
  lastI2sWriteMs.store(0, std::memory_order_relaxed);

  if (isRecording) isRecording = false;

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
  i2s_driver_uninstall(I2S_NUM_0);
  setupI2SPlay();
  playerStart();  // 再生タスク起動（リングバッファ初期化）
  Serial.printf("⏱️ [%lums] I2S switched\n", millis() - t0);

  // Soniox WebSocket切断→即再接続開始（再生中にSSL handshakeを進める）
  ws.disconnect();
  ws.beginSSL(SONIOX_WS_URL, SONIOX_WS_PORT, "/transcribe-websocket");
  ws.onEvent(webSocketEvent);
  ws.enableHeartbeat(15000, 3000, 2);
  sonioxPreconnectPending = true;
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

  String payload =
    "{\"model\":\"" + String(TTS_PROVIDER) + "\",\"voice\":\"" + String(TTS_CHARACTER) + "\","
    "\"device_id\":\"" + deviceMacAddress + "\","
    "\"session_id\":\"" + sessionId + "\","
    "\"owner_id\":\"" + deviceMacAddress + "\","
    "\"backchannel_fired\":" + (backchannelFired ? "true" : "false") + ","
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
  xTaskCreatePinnedToCore(lambdaConnectAndSendTask, "lambda_conn", 16384, &connParams, 1, &connTaskHandle, 0);
  Serial.printf("⏱️ [%lums] Lambda task started on Core 0\n", millis() - t0);

  // アンプON（PWMなし）
  if (!ampOn) {
    pinMode(PIN_AMP_SD, OUTPUT);
    digitalWrite(PIN_AMP_SD, HIGH);
    delay(50);
    ampOn = true;
    Serial.printf("⏱️ [%lums] Amp ready\n", millis() - t0);
  }

  // 相槌再生（Lambda接続と並列）
  if (backchannelReady && backchannelPcm && backchannelPcmSize > 0) {
    Serial.println("[BC] Playing backchannel while Lambda connects...");
    playBackchannelIfReady();
  }
  Serial.printf("⏱️ [%lums] Backchannel phase done\n", millis() - t0);

  // Lambda接続完了待ち
  while (!connParams.sent && !connParams.failed) delay(1);
  Serial.printf("⏱️ [%lums] Lambda request sent (ok=%d)\n", millis() - t0, !connParams.failed);

  if (connParams.failed) {
    Serial.printf("💾 Free heap at failure: %d\n", ESP.getFreeHeap());
    setLEDMode(LED_OFF);
    playerStop();
    i2s_stop(I2S_NUM_1);
    i2s_driver_uninstall(I2S_NUM_1);
    if (ampOn) { digitalWrite(PIN_AMP_SD, LOW); ampOn = false; }
    clearBackchannelCache();
    startSTTRecording();
    return;
  }

  // HTTPレスポンスヘッダー読み取り
  while (true) {
    String line = client.readStringUntil('\n');
    if (line.length() == 0 || line == "\r") break;
  }

  Serial.printf("⏱️ [%lums] Headers read, first audio byte incoming\n", millis() - t0);
  Serial.println("📨 BINARY STREAM START (Chunked)");

  g_currentChunkSize = -1;
  g_bytesReadFromChunk = 0;

  setLEDMode(LED_BLINKING);

  while (client.connected() || client.available()) {
    uint8_t header[5];
    size_t read = readBytesAcrossChunks(client, header, 5);
    if (read == 0) {
      Serial.println("🏁 BINARY STREAM END");
      break;
    }
    if (read != 5) {
      Serial.printf("[BINARY] Header incomplete: %d/5 bytes\n", read);
      break;
    }

    uint8_t type = header[0];
    uint32_t length = (header[1]) | (header[2] << 8) | (header[3] << 16) | (header[4] << 24);

    Serial.printf("[BINARY] type=0x%02X, length=%d\n", type, length);

    ws.loop();  // SSL handshake進行

    if (type == 0x01) {
      processMetadata(client, length);
    } else if (type == 0x02) {
      if (processPCM(client, length)) {
        Serial.println("[PCM] Playback interrupted: aborting stream");
        client.stop();
        break;
      }
    } else {
      Serial.printf("[BINARY] Unknown type: 0x%02X, skip %d bytes\n", type, length);
      uint8_t* dummy = (uint8_t*)malloc(length);
      if (dummy) {
        readBytesAcrossChunks(client, dummy, length);
        free(dummy);
      }
    }
  }

  unsigned long tEnd = millis();
  turnEndTiming.pending = true;
  turnEndTiming.receiveEndMs = tEnd;
  turnEndTiming.interrupted = bargeInRequested;

  if (bargeInRequested) {
    Serial.println("🔘 Barge-in: skipping buffer flush");
    playerStop();  // 再生タスク即時停止＋リング破棄
    turnEndTiming.parkedMs = millis();
  } else {
    // 受信完了: リングバッファの残りを出し切るまで待つ
    if (playRing) {
      playerStreamEnd = true;
      unsigned long drainStart = millis();
      while (playerActive && (millis() - drainStart < 30000)) {
        ws.loop();  // SSL handshake進行
        delay(10);
      }
      playerStop();  // 正常時は既に停止済み、タイムアウト時の保険
      Serial.printf("⏱️ end+[%lums] Ring buffer drained\n", millis() - tEnd);
    }
    turnEndTiming.parkedMs = millis();
    beginDmaTailTiming(!playRing || playerParked);
    const size_t dmaBytes = PLAY_DMA_COUNT * PLAY_DMA_FRAMES * 4;
    const size_t flushChunk = 8192;
    uint8_t* silence = (uint8_t*)calloc(1, flushChunk);
    if (silence) {
      size_t remaining = dmaBytes;
      while (remaining > 0) {
        size_t toWrite = (remaining > flushChunk) ? flushChunk : remaining;
        uint32_t writeStartMs = millis();
        size_t chunkWritten = 0;
        while (chunkWritten < toWrite) {
          size_t part = toWrite - chunkWritten;
          size_t flushed = dmaBytes - remaining + chunkWritten;
          if (dmaTailTiming.valid && !dmaTailTiming.confirmed) {
            // 元の8192-byte単位とws.loopの位置を維持し、確認境界だけ書き込みを分割。
            size_t boundary = dmaTailTiming.confirmAfterBytes - 4;
            size_t next = flushed < boundary ? boundary : dmaTailTiming.confirmAfterBytes;
            part = min(part, next - flushed);
          }
          size_t written = 0;
          esp_err_t err = i2s_write(I2S_NUM_1, silence, part, &written, portMAX_DELAY);
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
        ws.loop();  // SSL handshake進行
        turnEndTiming.flushWsMs += millis() - wsStartMs;
      }
      free(silence);
      turnEndTiming.flushCompleted = remaining == 0;
    }
    turnEndTiming.flushEndMs = millis();
    Serial.printf("⏱️ end+[%lums] DMA flush\n", millis() - tEnd);
  }

  digitalWrite(PIN_AMP_SD, LOW);
  dmaTailTiming.ampOffUs = esp_timer_get_time();
  turnEndTiming.ampOffMs = millis();
  turnEndTiming.lastWriteMs = lastI2sWriteMs.load(std::memory_order_relaxed);
  ampOn = false;
  Serial.printf("⏱️ end+[%lums] Amp off\n", millis() - tEnd);
  statsPrint();  // このターンのWiFi/再生品質サマリ

  addToHistory("user", text);
  if (responseText.length() > 0) addToHistory("assistant", responseText);

  bargeInRequested = false;
  clearBackchannelCache();
  Serial.printf("⏱️ end+[%lums] Cleanup done\n", millis() - tEnd);

  i2s_stop(I2S_NUM_1);
  i2s_driver_uninstall(I2S_NUM_1);
  Serial.printf("⏱️ end+[%lums] I2S uninstalled\n", millis() - tEnd);

  startSTTRecording();
  Serial.printf("⏱️ end+[%lums] STT recording started\n", millis() - tEnd);
}

// ==== Soniox WebSocketイベント ====
void webSocketEvent(WStype_t type, uint8_t *payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      if (sttRestartMs > 0) {
        Serial.printf("⏱️ STT [%lums] WS actually connected (from restart)\n", millis() - sttRestartMs);
      }
      Serial.println("✅ Connected to Soniox!");
      {
        String startMsg =
          "{\"api_key\":\"" + sonioxKey + "\","
          "\"model\":\"" + sonioxModel + "\","
          "\"audio_format\":\"pcm_s16le\","
          "\"sample_rate\":16000,"
          "\"num_channels\":1,"
          "\"enable_partial_results\":true,"
          "\"enable_endpoint_detection\":true,"
          "\"language_hints\":[\"ja\",\"en\"]"
          "}";
        ws.sendTXT(startMsg);
        Serial.println("📤 Sent start message to Soniox");
        sonioxPreconnectPending = false;
        if (isRecording) {
          // 録音準備完了 = 点灯（話してOK）。録音中はタイマー停止（必須ではないが念のため）
          // 再生中のpreconnect時(isRecording=false)はLEDを変えない
          timerAlarm(ledTimer, 0, false, 0);
          setLEDMode(LED_ON);
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
  statsReset();  // このターンの品質計測を開始
  Serial.println("🎙️ Starting STT recording...");
  // 準備中はゆっくり点滅（タイマーが録音停止中の場合があるので再開）
  if (ledTimer) timerAlarm(ledTimer, 30000, true, 0);
  setLEDMode(LED_BLINK_SLOW);

  if (!i2sRecordReady) {
    setupI2SRecord();
    Serial.printf("⏱️ STT [%lums] I2S record setup\n", millis() - t0);
  }
  i2sRecordReady = false;

  if (turnEndTiming.pending) turnEndTiming.micSetupDoneMs = millis();

  if (ws.isConnected()) {
    Serial.printf("⏱️ STT [%lums] WS already connected (preconnect success!)\n", millis() - t0);
  } else if (sonioxPreconnectPending) {
    Serial.printf("⏱️ STT [%lums] WS not yet connected, waiting...\n", millis() - t0);
    // preconnectが進行中なので、ws.loop()で完了を待つ
    unsigned long wsWaitStart = millis();
    while (!ws.isConnected() && (millis() - wsWaitStart < 5000)) {
      ws.loop();
      delay(1);
    }
    if (ws.isConnected()) {
      Serial.printf("⏱️ STT [%lums] WS connected after wait\n", millis() - t0);
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
  if (turnEndTiming.pending) {
    turnEndTiming.recordOnMs = millis();
    turnEndTiming.wsReadyAtRecord = ws.isConnected();
  }
  Serial.printf("⏱️ STT [%lums] isRecording=true\n", millis() - t0);

  // WS接続済み（=startメッセージ送信済み）なら即「話してOK」の点灯へ。
  // 未接続ならゆっくり点滅のまま、CONNECTEDイベント側で点灯に切り替わる
  if (ws.isConnected()) {
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
  Serial.println("\n🚀 ToyTalker Mini v0.5");

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

  // 再生ジッタバッファ初期化（PSRAM）+ 再生専用タスク起動
  playRing = (uint8_t*)ps_malloc(PLAY_RING_SIZE);
  if (playRing) {
    xTaskCreatePinnedToCore(playbackTask, "player", 8192, NULL, 2, &playerTaskHandle, 0);
    Serial.printf("🔊 Playback jitter buffer ready (%d KB)\n", PLAY_RING_SIZE / 1024);
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
    i2sRecordReady = true;
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
        if (isRecording) { ws.disconnect(); isRecording = false; }
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
    handleButtonLongPress();
    if (!bleDeviceConnected && oldBleDeviceConnected) {
      delay(500);
      if (pServer) pServer->startAdvertising();
    }
    oldBleDeviceConnected = bleDeviceConnected;
    delay(10);
    return;
  }

  ws.loop();
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
  if (isRecording && wifiGotIP && ws.isConnected()) {
    static uint32_t lastSend = 0;
    static uint32_t sendOk = 0, sendFail = 0;
    static uint32_t lastStats = 0;
    static int16_t micPeak = 0;  // v0.2基板検証用: マイク信号が生きているかの確認(無音でも数十、声で数千〜)
    static int32_t rawMin = INT32_MAX, rawMax = INT32_MIN;  // 生データの振れ幅(DCオフセットとクロストークの判別用)
    static uint32_t rawSample = 0;
    if (millis() - lastSend > 5) {
      int32_t raw[512];
      int16_t pcm[512];
      size_t n = 0;
      i2s_read(I2S_NUM_0, (void*)raw, sizeof(raw), &n, portMAX_DELAY);
      if (n > 0 && turnEndTiming.pending && !turnEndTiming.firstReadSeen) {
        turnEndTiming.firstReadMs = millis();
        turnEndTiming.firstReadSeen = true;
      }
      int samples = n / sizeof(int32_t);
      // SPH0645は大きな負のDCオフセットを持つ(この個体は約-13500@16bit)。
      // DCに声が埋もれてSTTが認識できないため、ゆっくり追従する平均を引いて直流除去する
      static int32_t micDc = 0;
      for (int i = 0; i < samples; i++) {
        int32_t s = raw[i] >> 14;
        micDc += (s - micDc) >> 10;  // 時定数 約64ms@16kHz
        int32_t v = s - micDc;
        if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
        pcm[i] = (int16_t)v;
        int16_t a = pcm[i] >= 0 ? pcm[i] : -pcm[i];
        if (a > micPeak) micPeak = a;
        if (raw[i] < rawMin) rawMin = raw[i];
        if (raw[i] > rawMax) rawMax = raw[i];
      }
      if (samples > 0) rawSample = (uint32_t)raw[0];
      bool ok = ws.sendBIN((uint8_t*)pcm, samples * sizeof(int16_t));
      if (ok) {
        if (samples > 0) printTurnEndTiming(millis());  // 毎ターン最初の音声送信だけ。sendOkの統計リセットとは独立。
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
