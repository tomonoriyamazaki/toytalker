#pragma once
#include "VoiceLevelGate.h"

// Experimental values from the 2026-09-10 quiet / speaking comparison.
// A loud contact sound can still trigger; this is not a speech classifier.
constexpr bool AEC_BARGE_DETECT_ONLY = false;
constexpr uint32_t AEC_BARGE_RMS = 1200;
constexpr uint32_t AEC_BARGE_FRAME_SAMPLES = 512;
constexpr uint32_t AEC_BARGE_HOLD_MS = 128;
constexpr uint32_t AEC_BARGE_WARMUP_MS = 500;
constexpr uint32_t AEC_BARGE_MAX_AGE_MS = 200;

class AecBargeGate {
 public:
  constexpr void reset() { gate_.reset(); fired_ = false; }
  constexpr void breakRun() { gate_.reset(); }
  constexpr bool fired() const { return fired_; }
  constexpr bool feed(uint32_t outRms, bool armed, uint32_t clippedSamples, uint32_t ageMs) {
    if (fired_) return false;
    const bool eligible = armed && clippedSamples == 0 && ageMs <= AEC_BARGE_MAX_AGE_MS;
    if (!gate_.feed(outRms, AEC_BARGE_FRAME_SAMPLES, AEC_BARGE_RMS,
                    16000 * AEC_BARGE_HOLD_MS / 1000, eligible)) return false;
    fired_ = true;
    return true;
  }
 private:
  VoiceLevelGate gate_;
  bool fired_ = false;
};
