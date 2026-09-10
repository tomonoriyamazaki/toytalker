#pragma once
#include <Arduino.h>
#include <WebSocketsClient.h>
#include <atomic>

// The worker exclusively owns the client from start() through takeResult().
// Its callback sends the start message only; application state stays on loop().
// A timeout/cancel NEVER deletes a task or a socket while connect() is running.
class SonioxPreconnect {
 public:
  struct Result {
    bool ready = false, cancelled = false;
    uint32_t elapsedMs = 0, stackFree = 0;
  };
  bool init(WebSocketsClient& client) {
    client_ = &client;
    if (xTaskCreatePinnedToCore(taskEntry, "soniox_connect", 8192, this, 1, &task_, 0) == pdPASS) return true;
    task_ = nullptr;
    return false;
  }
  bool available() const { return task_ != nullptr; }
  bool ownsClient() const { return state_.load(std::memory_order_acquire) != State::Idle; }

  // Caller has already configured beginSSL() and heartbeat, and owns client.
  bool start(const String& startMessage) {
    if (!available() || ownsClient()) return false;
    startMessage_ = startMessage;
    if (startMessage_.length() != startMessage.length() || startMessage_.isEmpty()) return false;
    result_ = Result{};
    startSent_ = false;
    cancel_.store(false);
    client_->onEvent([this](WStype_t type, uint8_t*, size_t) {
      if (type == WStype_CONNECTED && !cancel_.load()) {
        startSent_ = client_->sendTXT(startMessage_);
      } else if (type == WStype_DISCONNECTED) {
        startSent_ = false;
      }
    });
    state_.store(State::Running, std::memory_order_release);
    xTaskNotifyGive(task_);
    return true;
  }
  void cancel() { if (ownsClient()) cancel_.store(true); }

  // Only loop() consumes a completed job. No ws method may be called earlier.
  bool takeResult(Result& result, WebSocketsClient::WebSocketClientEvent normalCallback) {
    if (state_.load(std::memory_order_acquire) != State::Complete) return false;
    if (cancel_.load()) {
      // A cancel can arrive after the worker has published completion.
      client_->disconnect();
      result_.ready = false;
      result_.cancelled = true;
    }
    client_->onEvent(normalCallback);
    result = result_;
    state_.store(State::Idle, std::memory_order_release);
    return true;
  }

 private:
  enum class State { Idle, Running, Complete };
  static void taskEntry(void* context) { static_cast<SonioxPreconnect*>(context)->run(); }
  void run() {
    for (;;) {
      ulTaskNotifyTake(pdTRUE, portMAX_DELAY);
      if (state_.load(std::memory_order_acquire) != State::Running) continue;
      const uint32_t started = millis();
      // This bounds retries, not an individual synchronous TLS call. Retain
      // ownership until that call returns even if cancellation was requested.
      while (!cancel_.load() && millis() - started < 5000) {
        client_->loop();
        if (startSent_ && client_->isConnected()) break;
        vTaskDelay(pdMS_TO_TICKS(1));
      }
      result_.cancelled = cancel_.load();
      result_.ready = !result_.cancelled && startSent_ && client_->isConnected();
      if (!result_.ready) client_->disconnect();
      startMessage_ = ""; // bounded member buffer is reused, not leaked per job
      result_.elapsedMs = millis() - started;
      result_.stackFree = uxTaskGetStackHighWaterMark(nullptr);
      state_.store(State::Complete, std::memory_order_release);
      // No client/callback/request/result access after publication until notified.
    }
  }
  WebSocketsClient* client_ = nullptr;
  TaskHandle_t task_ = nullptr;
  std::atomic<State> state_{State::Idle};
  std::atomic<bool> cancel_{false};
  String startMessage_;
  Result result_;
  bool startSent_ = false;
};
