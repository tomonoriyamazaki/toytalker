#include "../devices/mcu/esp32_s3/toytalker_mini_v0.6/VoiceLevelGate.h"
#include "../devices/mcu/esp32_s3/toytalker_mini_v0.6/VoiceLevelMeter.h"

constexpr bool sustainedTriggers() {
  VoiceLevelGate g;
  for (int i = 0; i < 5; ++i)
    if (g.feed(6000, 320, 6000, 1920, true)) return false;
  return g.feed(6000, 320, 6000, 1920, true);
}
constexpr bool spikesDoNotAccumulate() {
  VoiceLevelGate g;
  for (int i = 0; i < 100; ++i) {
    if (g.feed(20000, 320, 6000, 1920, true)) return false;
    if (g.feed(5999, 320, 6000, 1920, true)) return false;
  }
  return g.aboveSamples == 0;
}
constexpr bool warmupAndReadFailureReset() {
  VoiceLevelGate g;
  for (int i = 0; i < 10; ++i)
    if (g.feed(20000, 320, 6000, 1920, false)) return false;
  for (int i = 0; i < 5; ++i)
    if (g.feed(20000, 320, 6000, 1920, true)) return false;
  g.reset(); // monitor resets on partial read or timeout
  return !g.feed(20000, 320, 6000, 1920, true) && g.aboveSamples == 320;
}
static_assert(sustainedTriggers(), "120ms required; equality triggers");
static_assert(spikesDoNotAccumulate(), "quiet frame resets sustained audio");
static_assert(warmupAndReadFailureReset(), "unarmed/error frames cannot contribute");

constexpr bool meterSeparatesSpikesFromSustainedSound() {
  VoiceLevelMeter<6> m;
  for (int i = 0; i < 18; ++i) m.feed(i % 6 == 0 ? 30000 : 100, true);
  return m.peakRms() == 30000 && m.sustainedRms() == 100 && m.windows() == 13;
}

constexpr bool meterUsesOverlappingWindows() {
  VoiceLevelMeter<6> m;
  for (uint32_t i = 1; i <= 8; ++i) m.feed(i * 1000, true);
  // The best six frames start at index 2, not on a six-frame boundary.
  if (m.sustainedRms() != 3000 || m.windows() != 3) return false;
  m.feed(0, true);
  return m.sustainedRms() == 3000 && m.peakRms() == 8000;
}

constexpr bool meterBreaksAtGapsAndResetsPerTurn() {
  VoiceLevelMeter<6> m;
  for (int i = 0; i < 5; ++i) m.feed(20000, true);
  m.breakRun(); // partial read / timeout
  for (int i = 0; i < 5; ++i) m.feed(20000, true);
  m.feed(100000, false); // unarmed frames do not affect peaks either
  for (int i = 0; i < 5; ++i) m.feed(6000, true);
  if (m.windows() != 0 || m.sustainedRms() != 0) return false;
  m.feed(6000, true);
  if (m.sustainedRms() != 6000 || m.peakRms() != 20000 || m.armedFrames() != 16) return false;
  m.reset();
  return m.peakRms() == 0 && m.sustainedRms() == 0 && m.windows() == 0 && m.armedFrames() == 0;
}

constexpr bool meterAgreesWithGateAtEveryPrefix() {
  constexpr uint32_t frames[] = {0, 20000, 6000, 7000, 8000, 6000, 7000, 8000,
                                5999, 30000, 30000, 30000, 30000, 30000, 0,
                                6500, 9000, 9000, 9000, 9000, 9000, 0};
  constexpr uint32_t thresholds[] = {0, 1, 5999, 6000, 6500, 7000, 9000, 30000, 30001};
  for (uint32_t threshold : thresholds) {
    VoiceLevelMeter<6> m;
    VoiceLevelGate g;
    bool everTriggered = false;
    for (size_t i = 0; i < sizeof(frames) / sizeof(frames[0]); ++i) {
      if (i == 12) { m.breakRun(); g.reset(); } // a read failure between loud frames
      const bool armed = i != 0;
      m.feed(frames[i], armed);
      if (g.feed(frames[i], 320, threshold, 1920, armed)) everTriggered = true;
      if (everTriggered != (m.windows() > 0 && m.sustainedRms() >= threshold)) return false;
    }
  }
  return true;
}

static_assert(meterSeparatesSpikesFromSustainedSound(), "short loud peaks cannot set a sustained threshold");
static_assert(meterUsesOverlappingWindows(), "all six-frame windows must be considered, including wraparound");
static_assert(meterBreaksAtGapsAndResetsPerTurn(), "gaps/unarmed frames split runs and each turn starts clean");
static_assert(meterAgreesWithGateAtEveryPrefix(), "reported sustained RMS matches the actual gate, including equality");
