#pragma once
#include <stdint.h>
#include <stddef.h>

// STT only: reset when recording starts, seed DC from the first nonzero block.
// Zero-filled startup samples must not pull the DC estimate towards zero.
class SttMicFilter {
 public:
  constexpr void reset() { ready_ = false; dcQ_ = 0; clips_ = zeros_ = 0; }
  constexpr void convert(const int32_t* raw, int16_t* pcm, size_t samples) {
    clips_ = zeros_ = 0;
    if (!ready_) {
      int64_t sum = 0;
      size_t valid = 0;
      for (size_t i = 0; i < samples; ++i) {
        if (raw[i] != 0) { sum += raw[i] >> 14; ++valid; }
      }
      if (valid) { dcQ_ = (sum / int64_t(valid)) * 1024; ready_ = true; }
    }
    for (size_t i = 0; i < samples; ++i) {
      if (raw[i] == 0) { pcm[i] = 0; ++zeros_; continue; }
      const int32_t value = raw[i] >> 14;
      dcQ_ += (int64_t(value) * 1024 - dcQ_) / 1024;
      const int32_t centered = value - int32_t(dcQ_ / 1024);
      if (centered > 32767 || centered < -32768) ++clips_;
      pcm[i] = centered > 32767 ? 32767 : centered < -32768 ? -32768 : int16_t(centered);
    }
  }
  constexpr uint32_t clips() const { return clips_; }
  constexpr uint32_t zeros() const { return zeros_; }
  constexpr int32_t dc() const { return int32_t(dcQ_ / 1024); }
 private:
  int64_t dcQ_ = 0;
  uint32_t clips_ = 0, zeros_ = 0;
  bool ready_ = false;
};
