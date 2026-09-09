#include "../devices/mcu/esp32_s3/toytalker_mini_v0.6/VoiceLevelGate.h"

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
