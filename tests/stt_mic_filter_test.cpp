#include "../devices/mcu/esp32_s3/toytalker_mini_v0.7/SttMicFilter.h"

constexpr bool startupPaddingDoesNotBecomeSpeech() {
  SttMicFilter filter;
  const int32_t raw[] = {0, 0, -13500 * 16384, -13500 * 16384};
  int16_t pcm[4] = {};
  filter.convert(raw, pcm, 4);
  for (auto sample : pcm) if (sample != 0) return false;
  return filter.dc() == -13500 && filter.zeros() == 2 && filter.clips() == 0;
}

constexpr bool emptyInputAndPaddingDoNotChangeDc() {
  SttMicFilter filter;
  const int32_t zeros[4] = {};
  const int32_t offset[4] = {-14000 * 16384, -14000 * 16384, -14000 * 16384, -14000 * 16384};
  int16_t pcm[4] = {};
  filter.convert(nullptr, nullptr, 0);
  filter.convert(zeros, pcm, 4);
  filter.convert(offset, pcm, 4);
  if (filter.dc() != -14000 || filter.clips() != 0) return false;
  filter.convert(zeros, pcm, 4);
  for (auto sample : pcm) if (sample != 0) return false;
  return filter.dc() == -14000 && filter.zeros() == 4;
}

constexpr bool nextRecordingHasNoPreviousDcTransient() {
  SttMicFilter filter;
  const int32_t oldRaw[] = {-18000 * 16384, -18000 * 16384};
  const int32_t newRaw[] = {20000 * 16384, 20000 * 16384};
  int16_t pcm[2] = {};
  filter.convert(oldRaw, pcm, 2);
  filter.reset();
  filter.convert(newRaw, pcm, 2);
  return pcm[0] == 0 && pcm[1] == 0 && filter.dc() == 20000 && filter.clips() == 0;
}

constexpr bool speechSurvivesNegativeDcRemoval() {
  SttMicFilter filter;
  int32_t raw[32] = {};
  int16_t pcm[32] = {};
  for (int i = 0; i < 32; ++i) raw[i] = (-13500 + (i % 2 ? 2000 : -2000)) * 16384;
  // Exercise repeated blocks: integer rounding must not build a large DC bias.
  for (int block = 0; block < 100; ++block) {
    filter.convert(raw, pcm, 32);
    for (int i = 0; i < 32; ++i) {
      const int expected = i % 2 ? 2000 : -2000;
      if (pcm[i] < expected - 10 || pcm[i] > expected + 10) return false;
    }
  }
  return filter.clips() == 0;
}

constexpr bool overRangeInputSaturatesInsteadOfWrapping() {
  SttMicFilter filter;
  const int32_t raw[] = {-100000 * 16384, 100000 * 16384};
  int16_t pcm[2] = {};
  filter.convert(raw, pcm, 2);
  return pcm[0] == -32768 && pcm[1] == 32767 && filter.clips() == 2;
}

static_assert(startupPaddingDoesNotBecomeSpeech(), "startup zeros and microphone DC must not generate a loud transient");
static_assert(emptyInputAndPaddingDoNotChangeDc(), "empty and zero-filled blocks cannot seed or corrupt microphone DC");
static_assert(nextRecordingHasNoPreviousDcTransient(), "recording restart must discard the previous DC estimate");
static_assert(speechSurvivesNegativeDcRemoval(), "DC removal must preserve voice amplitude without accumulating rounding bias");
static_assert(overRangeInputSaturatesInsteadOfWrapping(), "large input must clamp with an explicit clip count");
