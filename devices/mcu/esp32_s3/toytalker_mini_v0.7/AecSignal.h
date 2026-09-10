#pragma once
#include <stdint.h>
#include <stddef.h>

namespace aec_signal {
constexpr int16_t saturate(int64_t value) {
  return value > 32767 ? 32767 : value < -32768 ? -32768 : static_cast<int16_t>(value);
}

// 25-tap Hann-windowed sinc, 7 kHz cutoff at 24 kHz, Q15, unity DC gain.
// Filter before 24 -> 16 kHz interpolation; history timestamps remove its 0.5 ms group delay.
class LowPass24k {
 public:
  constexpr void reset() { *this = LowPass24k{}; }
  constexpr int16_t feed(int16_t sample) {
    history_[next_] = sample;
    int64_t sum = 0;
    for (size_t i = 0; i < 25; ++i) sum += int64_t(history_[(next_ + 25 - i) % 25]) * taps_[i];
    next_ = (next_ + 1) % 25;
    return saturate(sum / 32768);
  }
 private:
  static constexpr int32_t taps_[25] = {0,16,-35,-120,282,143,-869,340,1694,-2099,-2434,9906,19120,
                                      9906,-2434,-2099,1694,340,-869,143,282,-120,-35,16,0};
  int16_t history_[25] = {};
  size_t next_ = 0;
};

// Sample position follows the DMA sample count. Slowly correct oscillator drift,
// rather than making every sample follow interrupt scheduling jitter.
class SampleClock {
 public:
  constexpr void reset() { *this = SampleClock{}; }
  constexpr bool observe(uint32_t sequence, int64_t irqUs, uint32_t blockUs) {
    bool continuous = ready_ && sequence == sequence_ + 1;
    int64_t expected = endUs_ + blockUs;
    int64_t error = irqUs - expected;
    if (!continuous || error > 3000 || error < -3000) {
      endUs_ = irqUs;
      continuous = false;
    } else {
      int64_t correction = error / 64;
      endUs_ = expected + (correction > 2 ? 2 : correction < -2 ? -2 : correction);
    }
    sequence_ = sequence;
    ready_ = true;
    return continuous;
  }
  constexpr int64_t endUs() const { return endUs_; }
 private:
  uint32_t sequence_ = 0;
  int64_t endUs_ = 0;
  bool ready_ = false;
};

// Monitor-task-owned history. 48 MHz integer timebase represents both 24 kHz
// (2000 ticks) and 16 kHz (3000 ticks) sample positions without rounding drift.
// Missing/stale/future data is invalid, never silently replaced with silence.
template <size_t Samples, size_t Blocks>
class ReferenceHistory {
 public:
  struct Block { int64_t start = 0; int16_t data[Samples] = {}; };
  constexpr void reset() { next_ = used_ = 0; }
  constexpr Block& begin(int64_t startTicks) {
    blocks_[next_].start = startTicks;
    return blocks_[next_];
  }
  constexpr void commit() {
    next_ = (next_ + 1) % Blocks;
    if (used_ < Blocks) ++used_;
  }
  constexpr bool sample(int64_t ticks, int16_t& output) const {
    for (size_t j = 0; j < used_; ++j) {
      size_t index = (next_ + Blocks - 1 - j) % Blocks;
      const auto& b = blocks_[index];
      int64_t offset = ticks - b.start;
      if (offset < 0 || offset >= int64_t(Samples) * 2000) continue;
      size_t i = size_t(offset / 2000);
      int64_t fraction = offset % 2000;
      if (fraction == 0) { output = b.data[i]; return true; }
      int16_t right = 0;
      int64_t interval = 2000;
      if (i + 1 < Samples) right = b.data[i + 1];
      else {
        if (j == 0) return false;  // next block has not arrived
        const auto& after = blocks_[(index + 1) % Blocks];
        interval = after.start - (b.start + int64_t(Samples - 1) * 2000);
        // A few microseconds of clock correction are allowed, a missing block is not.
        if (interval < 1000 || interval > 3000 || fraction > interval) return false;
        right = after.data[0];
      }
      output = saturate(int64_t(b.data[i]) + (int64_t(right) - b.data[i]) * fraction / interval);
      return true;
    }
    return false;
  }
 private:
  Block blocks_[Blocks] = {};
  size_t next_ = 0, used_ = 0;
};
}  // namespace aec_signal
