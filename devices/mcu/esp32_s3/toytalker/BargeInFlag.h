#pragma once
#include <freertos/FreeRTOS.h>
#include <esp_attr.h>
#include <esp_timer.h>
#include <hal/gpio_ll.h>

// ESP-IDF critical sections protect the flag across both cores and the button ISR.
// Do not rely on std::atomic being lock-free inside an ISR on this toolchain.
class BargeInFlag {
  portMUX_TYPE mux = portMUX_INITIALIZER_UNLOCKED;
  bool value = false;
  bool armed = false;
  int64_t buttonAtUs = 0, mutedAtUs = 0;
 public:
  struct ButtonTiming { int64_t pressedUs, mutedUs; };
  void beginTurn() {
    portENTER_CRITICAL(&mux);
    value = false;
    armed = true;
    buttonAtUs = mutedAtUs = 0;
    portEXIT_CRITICAL(&mux);
  }
  ButtonTiming buttonTiming(bool consume = false) {
    portENTER_CRITICAL(&mux);
    ButtonTiming result{buttonAtUs, mutedAtUs};
    if (consume) buttonAtUs = mutedAtUs = 0;
    portEXIT_CRITICAL(&mux);
    return result;
  }
  // Serialize amplifier enable with the ISR so a pending press cannot be
  // followed by an amplifier HIGH write from the playback setup task.
  bool enableAmp(uint32_t pin) {
    portENTER_CRITICAL(&mux);
    bool enabled = !value;
    if (enabled) gpio_ll_set_level(&GPIO, pin, 1);
    portEXIT_CRITICAL(&mux);
    return enabled;
  }
  operator bool() {
    portENTER_CRITICAL(&mux);
    bool result = value;
    portEXIT_CRITICAL(&mux);
    return result;
  }
  void operator=(bool next) {
    portENTER_CRITICAL(&mux);
    value = next;
    if (!next) armed = false;
    portEXIT_CRITICAL(&mux);
  }
  void IRAM_ATTR setFromISR(uint32_t ampPin) {
    const int64_t atUs = esp_timer_get_time();
    portENTER_CRITICAL_ISR(&mux);
    // Register-only GPIO write: no Serial, driver calls, allocation or waits.
    gpio_ll_set_level(&GPIO, ampPin, 0);
    if (armed && buttonAtUs == 0) {
      buttonAtUs = atUs;
      mutedAtUs = esp_timer_get_time();
    }
    value = true;
    portEXIT_CRITICAL_ISR(&mux);
  }
};
