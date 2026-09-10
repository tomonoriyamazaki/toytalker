#pragma once
#include <freertos/FreeRTOS.h>
#include <esp_attr.h>

// ESP-IDF critical sections protect the flag across both cores and the button ISR.
// Do not rely on std::atomic being lock-free inside an ISR on this toolchain.
class BargeInFlag {
  portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
  bool value = false;
 public:
  operator bool() {
    portENTER_CRITICAL(&mux);
    bool result = value;
    portEXIT_CRITICAL(&mux);
    return result;
  }
  void operator=(bool next) {
    portENTER_CRITICAL(&mux);
    value = next;
    portEXIT_CRITICAL(&mux);
  }
  void IRAM_ATTR setFromISR() {
    portENTER_CRITICAL_ISR(&mux);
    value = true;
    portEXIT_CRITICAL_ISR(&mux);
  }
};
