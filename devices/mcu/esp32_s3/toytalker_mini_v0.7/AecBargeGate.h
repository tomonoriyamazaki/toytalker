#pragma once
#include <stdint.h>

// Experimental values from the 2026-09-10 quiet / speaking comparison.
// These guards reduce false stops; they are not a speech classifier.
constexpr bool AEC_BARGE_DETECT_ONLY = false; // Cartesia-based tuning: voice interruption enabled.
constexpr uint32_t AEC_BARGE_RMS = 1200;
constexpr uint32_t AEC_BARGE_FRAME_SAMPLES = 512;
constexpr uint32_t AEC_BARGE_HOLD_MS = 128;
constexpr uint32_t AEC_BARGE_WARMUP_MS = 500;
constexpr uint32_t AEC_BARGE_MAX_AGE_MS = 200;
constexpr uint32_t AEC_BARGE_HOLD_FRAMES = 4;
constexpr uint32_t AEC_BARGE_CLIP_RECOVERY_MS = 256;
// Require output RMS >= 1/4 of input RMS over the SAME candidate window.
// Trial value: strongly cancelled audio alone must not trip the absolute gate.
constexpr uint32_t AEC_BARGE_MIN_RETAINED_PERCENT = 25;
static_assert(AEC_BARGE_HOLD_FRAMES * AEC_BARGE_FRAME_SAMPLES * 1000 ==
              16000 * AEC_BARGE_HOLD_MS, "hold must contain whole AEC frames");

class AecBargeGate {
 public:
  constexpr void reset() { *this = AecBargeGate{}; }
  // A gap breaks the candidate but must not clear an active clipping guard.
  constexpr void breakRun() {
    used_ = next_ = 0;
    micEnergy_ = outEnergy_ = 0;
    for (uint32_t i = 0; i < AEC_BARGE_HOLD_FRAMES; ++i) mic_[i] = out_[i] = 0;
  }
  constexpr bool fired() const { return fired_; }
  constexpr uint32_t residualRejects() const { return residualRejects_; }
  constexpr uint32_t clipFrames() const { return clipFrames_; }
  constexpr uint32_t recoveryFrames() const { return recoveryFrames_; }
  constexpr uint64_t micEnergy() const { return micEnergy_; }
  constexpr uint64_t outEnergy() const { return outEnergy_; }
  constexpr uint32_t micFrame(uint32_t i) const { return mic_[(next_ + i) % AEC_BARGE_HOLD_FRAMES]; }
  constexpr uint32_t outFrame(uint32_t i) const { return out_[(next_ + i) % AEC_BARGE_HOLD_FRAMES]; }
  constexpr bool feed(uint32_t micRms, uint32_t outRms, bool armed,
                      uint32_t clippedSamples, uint32_t ageMs) {
    if (fired_) return false;
    if (clippedSamples) {
      ++clipFrames_;
      recoverySamples_ = 16000 * AEC_BARGE_CLIP_RECOVERY_MS / 1000;
      breakRun(); return false;
    }
    if (ageMs > AEC_BARGE_MAX_AGE_MS) { breakRun(); return false; }
    if (recoverySamples_) {
      recoverySamples_ = recoverySamples_ > AEC_BARGE_FRAME_SAMPLES ?
                         recoverySamples_ - AEC_BARGE_FRAME_SAMPLES : 0;
      ++recoveryFrames_;
      breakRun(); return false;
    }
    if (!armed || outRms < AEC_BARGE_RMS) { breakRun(); return false; }
    micEnergy_ -= square(mic_[next_]); outEnergy_ -= square(out_[next_]);
    mic_[next_] = micRms; out_[next_] = outRms;
    micEnergy_ += square(micRms); outEnergy_ += square(outRms);
    next_ = (next_ + 1) % AEC_BARGE_HOLD_FRAMES;
    if (used_ < AEC_BARGE_HOLD_FRAMES) ++used_;
    if (used_ < AEC_BARGE_HOLD_FRAMES) return false;
    // Squared RMS values of 16-bit PCM; 64-bit sums/products avoid overflow.
    if (outEnergy_ * 10000 < micEnergy_ * AEC_BARGE_MIN_RETAINED_PERCENT *
                                                AEC_BARGE_MIN_RETAINED_PERCENT) {
      ++residualRejects_;
      return false; // slide the window so a later voice can still interrupt
    }
    fired_ = true;
    return true;
  }
 private:
  static constexpr uint64_t square(uint32_t v) { return uint64_t(v) * v; }
  uint32_t mic_[AEC_BARGE_HOLD_FRAMES] = {}, out_[AEC_BARGE_HOLD_FRAMES] = {};
  uint64_t micEnergy_ = 0, outEnergy_ = 0;
  uint32_t used_ = 0, next_ = 0, recoverySamples_ = 0;
  uint32_t residualRejects_ = 0, clipFrames_ = 0, recoveryFrames_ = 0;
  bool fired_ = false;
};
