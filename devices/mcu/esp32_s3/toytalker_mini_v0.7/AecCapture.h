#pragma once
#include <freertos/FreeRTOS.h>
#include <stdint.h>
#include <stddef.h>

// One ISR producer and one task consumer. All slots and counters MUST reside
// in internal SRAM (CONFIG_I2S_ISR_IRAM_SAFE=1 in the installed Arduino SDK).
// Never overwrite a slot held by the consumer; drop new data and count it.
// Only counters are protected: never copy a whole audio block with IRQs masked.
template <typename Block, uint32_t Capacity>
class AecCaptureQueue {
  static_assert(Capacity > 0, "capture queue needs storage");
 public:
  void reset() { portENTER_CRITICAL(&mux_); head_ = tail_ = dropped_ = 0; portEXIT_CRITICAL(&mux_); }
  __attribute__((always_inline)) inline Block* beginPush() {
    portENTER_CRITICAL_ISR(&mux_);
    Block* result = nullptr;
    if (head_ - tail_ >= Capacity) ++dropped_;
    else result = &slots_[head_ % Capacity];
    portEXIT_CRITICAL_ISR(&mux_);
    return result;
  }
  __attribute__((always_inline)) inline void commitPush() {
    portENTER_CRITICAL_ISR(&mux_); ++head_; portEXIT_CRITICAL_ISR(&mux_);
  }
  const Block* peek() {
    portENTER_CRITICAL(&mux_);
    const Block* result = tail_ == head_ ? nullptr : &slots_[tail_ % Capacity];
    portEXIT_CRITICAL(&mux_);
    return result;
  }
  void pop() { portENTER_CRITICAL(&mux_); ++tail_; portEXIT_CRITICAL(&mux_); }
  uint32_t dropped() { portENTER_CRITICAL(&mux_); uint32_t n = dropped_; portEXIT_CRITICAL(&mux_); return n; }
 private:
  Block slots_[Capacity] = {};
  portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
  uint32_t head_ = 0, tail_ = 0, dropped_ = 0;
};

class AecCaptureState {
 public:
  void start() { portENTER_CRITICAL(&mux_); errors_ = 0; enabled_ = true; portEXIT_CRITICAL(&mux_); }
  void stop() { portENTER_CRITICAL(&mux_); enabled_ = false; portEXIT_CRITICAL(&mux_); }
  uint32_t errors() { portENTER_CRITICAL(&mux_); uint32_t n = errors_; portEXIT_CRITICAL(&mux_); return n; }
  __attribute__((always_inline)) inline bool enabledFromISR() {
    portENTER_CRITICAL_ISR(&mux_); bool value = enabled_; portEXIT_CRITICAL_ISR(&mux_); return value;
  }
  __attribute__((always_inline)) inline void errorFromISR() {
    portENTER_CRITICAL_ISR(&mux_); ++errors_; portEXIT_CRITICAL_ISR(&mux_);
  }
 private:
  portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
  uint32_t errors_ = 0;
  bool enabled_ = false;
};
