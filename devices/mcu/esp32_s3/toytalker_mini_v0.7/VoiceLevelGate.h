#pragma once
#include <stdint.h>

// Sample-count based hold: scheduling delays must not count as sustained sound.
class VoiceLevelGate {
 public:
  uint32_t aboveSamples = 0;
  constexpr void reset() { aboveSamples = 0; }
  constexpr bool feed(uint32_t rms, uint32_t samples, uint32_t threshold,
            uint32_t requiredSamples, bool armed) {
    if (!armed || rms < threshold) { reset(); return false; }
    aboveSamples += samples;
    return aboveSamples >= requiredSamples;
  }
};
