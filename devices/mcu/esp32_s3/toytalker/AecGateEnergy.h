#pragma once
#include <stdint.h>
#include <stddef.h>

// Gate-only measurement. Never modifies microphone, reference or speaker PCM.
namespace aec_gate_energy {
struct Moments {
  int64_t sum = 0;
  uint64_t squares = 0;
  uint32_t count = 0;
  constexpr void feed(int16_t sample) {
    sum += sample;
    squares += int64_t(sample) * sample;
    ++count;
  }
  constexpr int32_t mean() const { return count ? int32_t(sum / count) : 0; }
  // Sum of squared deviations; integer division leaves <1 energy unit error.
  constexpr uint64_t acEnergy() const {
    return count ? squares - uint64_t(sum * sum) / count : 0;
  }
};
}
