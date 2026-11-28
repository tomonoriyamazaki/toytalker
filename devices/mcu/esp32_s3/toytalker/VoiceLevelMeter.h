#pragma once
#include <stddef.h>
#include <stdint.h>

// For fixed-size RMS frames. The largest window minimum is the highest
// threshold that would have triggered a consecutive-frame level gate.
// No allocation; gaps/unarmed frames cannot join two separate loud runs.
template <size_t WindowFrames>
class VoiceLevelMeter {
  static_assert(WindowFrames > 0, "a hold window needs at least one frame");

 public:
  constexpr void reset() { *this = VoiceLevelMeter{}; }
  constexpr void breakRun() { used_ = 0; next_ = 0; }

  constexpr void feed(uint32_t rms, bool armed) {
    if (!armed) { breakRun(); return; }
    ++armedFrames_;
    if (rms > peakRms_) peakRms_ = rms;
    recent_[next_] = rms;
    next_ = (next_ + 1) % WindowFrames;
    if (used_ < WindowFrames) ++used_;
    if (used_ != WindowFrames) return;

    ++windows_;
    uint32_t floor = recent_[0];
    for (size_t i = 1; i < WindowFrames; ++i)
      if (recent_[i] < floor) floor = recent_[i];
    if (floor > sustainedRms_) sustainedRms_ = floor;
  }

  constexpr uint32_t peakRms() const { return peakRms_; }
  constexpr uint32_t sustainedRms() const { return sustainedRms_; }
  constexpr uint32_t armedFrames() const { return armedFrames_; }
  constexpr uint32_t windows() const { return windows_; }

 private:
  uint32_t recent_[WindowFrames] = {};
  size_t used_ = 0, next_ = 0;
  uint32_t peakRms_ = 0, sustainedRms_ = 0;
  uint32_t armedFrames_ = 0, windows_ = 0;
};
