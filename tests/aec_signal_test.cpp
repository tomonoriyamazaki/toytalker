#include "../devices/mcu/esp32_s3/toytalker_mini_v0.7/AecSignal.h"
#include "../devices/mcu/esp32_s3/toytalker_mini_v0.7/VoiceLevelMeter.h"
#include "../devices/mcu/esp32_s3/toytalker_mini_v0.7/AecBargeGate.h"

using aec_signal::ReferenceHistory;
using aec_signal::LowPass24k;
using aec_signal::SampleClock;

constexpr bool resamplesAcrossDmaBoundary() {
  ReferenceHistory<4, 3> history;
  for (int b = 0; b < 3; ++b) {
    auto& block = history.begin(b * 8000);
    for (int i = 0; i < 4; ++i) block.data[i] = (b * 4 + i) * 100;
    history.commit();
  }
  // 16 kHz request positions over a 24 kHz ramp, including DMA boundaries.
  for (int i = 0; i < 8; ++i) {
    int16_t result = -1;
    if (!history.sample(i * 3000, result) || result != i * 150) return false;
  }
  int16_t result = -1;
  return !history.sample(-1, result) && !history.sample(22500, result);
}

constexpr bool gapsAndOverwritesAreInvalid() {
  ReferenceHistory<4, 2> history;
  history.begin(0).data[3] = 300; history.commit();
  history.begin(16000).data[0] = 800; history.commit(); // missing an entire DMA block
  int16_t result = 999;
  if (history.sample(7000, result) || history.sample(10000, result)) return false;
  history.begin(24000); history.commit(); // oldest block overwritten
  if (history.sample(0, result)) return false;
  history.reset(); // never carry the previous turn's reference into a new turn
  return !history.sample(16000, result);
}

constexpr bool referenceBecomesReadyOnlyAfterInterpolationNeighbourArrives() {
  ReferenceHistory<4, 2> history;
  history.begin(0).data[3] = 300; history.commit();
  int16_t result = 0;
  if (history.sample(7000, result)) return false;
  history.begin(8000).data[0] = 400; history.commit();
  return history.sample(7000, result) && result == 350;
}

constexpr bool smallClockCorrectionAllowsInterpolation() {
  ReferenceHistory<4, 2> history;
  history.begin(0).data[3] = 300; history.commit();
  history.begin(8096).data[0] = 400; history.commit(); // +2 us clock correction
  int16_t result = 0;
  return history.sample(7000, result) && result == 347;
}

constexpr bool filterHasUnityGainAndResets() {
  LowPass24k filter;
  int16_t result = 0;
  for (int i = 0; i < 64; ++i) result = filter.feed(10000);
  if (result != 10000) return false;
  filter.reset();
  for (int i = 0; i < 64; ++i) if (filter.feed(0) != 0) return false;
  return aec_signal::saturate(90000) == 32767 && aec_signal::saturate(-90000) == -32768;
}

constexpr bool filterRejectsAliasingTone() {
  LowPass24k filter;
  // 10 kHz would fold down to 6 kHz when resampled to 16 kHz.
  constexpr int16_t tone[] = {0,5000,-8660,10000,-8660,5000,0,-5000,8660,-10000,8660,-5000};
  int peak = 0;
  for (int i = 0; i < 120; ++i) {
    int v = filter.feed(tone[i % 12]);
    if (v < 0) v = -v;
    if (i >= 25 && v > peak) peak = v;
  }
  return peak < 100;
}

constexpr bool clockRejectsDiscontinuities() {
  SampleClock clock;
  if (clock.observe(1, 100000, 32000)) return false;
  if (!clock.observe(2, 132100, 32000) || clock.endUs() != 132001) return false;
  if (clock.observe(4, 196000, 32000)) return false; // dropped capture
  if (clock.observe(5, 240000, 32000)) return false; // excessive interrupt timing shift
  clock.reset();
  if (clock.observe(UINT32_MAX, 100000, 32000)) return false;
  return clock.observe(0, 132000, 32000); // sequence rollover
}

constexpr bool pairedWindowsBreakOnMissingReference() {
  VoiceLevelMeter<4> meter;
  for (int i = 0; i < 3; ++i) meter.feed(5000, true);
  meter.breakRun();
  for (int i = 0; i < 3; ++i) meter.feed(5000, true);
  if (meter.windows() != 0) return false;
  meter.feed(4000, true);
  return meter.sustainedRms() == 4000 && meter.windows() == 1;
}

static_assert(resamplesAcrossDmaBoundary(), "24/16 kHz time mapping must cross DMA boundaries");
static_assert(referenceBecomesReadyOnlyAfterInterpolationNeighbourArrives(), "early AEC must wait for both interpolation neighbours");
static_assert(gapsAndOverwritesAreInvalid(), "missing, overwritten and previous-turn references must not become silence");
static_assert(smallClockCorrectionAllowsInterpolation(), "small clock corrections must preserve reference continuity");
static_assert(filterHasUnityGainAndResets(), "reference filter gain, saturation and reset");
static_assert(filterRejectsAliasingTone(), "resampling must attenuate content above the new Nyquist frequency");
static_assert(clockRejectsDiscontinuities(), "sample clock must detect loss and tolerate bounded jitter and rollover");
static_assert(pairedWindowsBreakOnMissingReference(), "missing reference cannot join loud frames into a hold window");

constexpr bool aecBargeRejectsPeaksAndFiresOncePerTurn() {
  AecBargeGate gate;
  // Quiet playback can peak above threshold, but must not trigger on single frames.
  for (int i = 0; i < 20; ++i)
    if (gate.feed(3000, i % 4 == 0 ? 1900 : 800, true, 0, 125)) return false;
  for (int i = 0; i < 3; ++i)
    if (gate.feed(3000, AEC_BARGE_RMS, true, 0, 125)) return false;
  if (!gate.feed(3000, AEC_BARGE_RMS, true, 0, 125) || !gate.fired()) return false;
  for (int i = 0; i < 10; ++i)
    if (gate.feed(3000, 1700, true, 0, 125)) return false;
  gate.reset(); // next turn must be able to interrupt again
  for (int i = 0; i < 3; ++i)
    if (gate.feed(3000, 1700, true, 0, 125)) return false;
  return gate.feed(3000, 1700, true, 0, 125);
}

constexpr bool aecBargeBreaksOnInvalidAudio() {
  for (int invalid = 0; invalid < 3; ++invalid) {
    AecBargeGate gate;
    for (int i = 0; i < 3; ++i)
      if (gate.feed(3000, 2000, true, 0, 125)) return false;
    if (invalid == 0) gate.breakRun(); // missing reference or clock/sequence discontinuity
    else if (gate.feed(3000, 9000, invalid != 1, 0,
                       invalid == 2 ? AEC_BARGE_MAX_AGE_MS + 1 : 125)) return false;
    for (int i = 0; i < 3; ++i)
      if (gate.feed(3000, 2000, true, 0, 125)) return false;
    if (!gate.feed(3000, 2000, true, 0, AEC_BARGE_MAX_AGE_MS)) return false;
  }
  return true;
}

static_assert(aecBargeRejectsPeaksAndFiresOncePerTurn(), "AEC output requires four continuous frames and resets per turn");
static_assert(aecBargeBreaksOnInvalidAudio(), "unarmed, stale or missing audio cannot complete a barge-in hold");

constexpr bool aecBargeRejectsStronglyCancelledAudioAndThenAcceptsVoice() {
  AecBargeGate gate;
  // Repeat the single observed false-trigger frame as a synthetic window.
  // The screenshot does not contain the other three real candidate frames.
  for (int i = 0; i < 12; ++i)
    if (gate.feed(5822, 1304, true, 0, 82)) return false;
  if (gate.residualRejects() != 9 || gate.fired()) return false;
  // All new voice frames must eventually replace the rejected residual window.
  bool triggered = false;
  for (int i = 0; i < 4; ++i) triggered |= gate.feed(3000, 2000, true, 0, 82);
  return triggered && gate.fired();
}

constexpr bool aecBargeUsesWindowEnergyAndIncludesRatioBoundary() {
  AecBargeGate gate;
  for (int i = 0; i < 3; ++i)
    if (gate.feed(8000, 2000, true, 0, 82)) return false;
  if (!gate.feed(8000, 2000, true, 0, 82)) return false; // exactly 25% RMS
  gate.reset();
  for (int i = 0; i < 8; ++i)
    if (gate.feed(8000, 1999, true, 0, 82)) return false; // just below
  gate.reset();
  if (gate.feed(8000, 1500, true, 0, 82)) return false;
  for (int i = 0; i < 2; ++i)
    if (gate.feed(3000, 1500, true, 0, 82)) return false;
  // One echo-dominant frame does not reject an otherwise eligible whole window.
  if (!gate.feed(3000, 1500, true, 0, 82)) return false;
  if (gate.micFrame(0) != 8000 || gate.micFrame(3) != 3000) return false;
  gate.reset();
  for (int i = 0; i < 3; ++i)
    if (gate.feed(32768, 32768, true, 0, 82)) return false;
  return gate.feed(32768, 32768, true, 0, 82); // 64-bit window energy
}

constexpr bool aecBargeWaitsForCleanAudioAfterClipping() {
  AecBargeGate gate;
  for (int i = 0; i < 3; ++i)
    if (gate.feed(3000, 2000, true, 0, 82)) return false;
  if (gate.feed(30000, 20000, true, 1, 82)) return false;
  for (int i = 0; i < 4; ++i)
    if (gate.feed(3000, 2000, true, 0, 82)) return false;
  // Another clipped frame restarts recovery, even during an unarmed interval.
  if (gate.feed(30000, 20000, false, 1, 82)) return false;
  gate.breakRun();
  for (int i = 0; i < 20; ++i)
    if (gate.feed(3000, 2000, true, 0, AEC_BARGE_MAX_AGE_MS + 1)) return false;
  constexpr uint32_t cleanFrames = 16000 * AEC_BARGE_CLIP_RECOVERY_MS / 1000 /
                                   AEC_BARGE_FRAME_SAMPLES;
  for (uint32_t i = 0; i < cleanFrames; ++i)
    if (gate.feed(3000, 2000, true, 0, 82)) return false;
  for (int i = 0; i < 3; ++i)
    if (gate.feed(3000, 2000, true, 0, 82)) return false;
  return gate.feed(3000, 2000, true, 0, 82) && gate.clipFrames() == 2 &&
         gate.recoveryFrames() == cleanFrames + 4;
}

constexpr bool aecBargeClearsRecoveryAndWindowAtNextTurn() {
  AecBargeGate gate;
  gate.feed(30000, 20000, true, 1, 82);
  gate.reset();
  for (int i = 0; i < 3; ++i)
    if (gate.feed(3000, 2000, true, 0, 82)) return false;
  return gate.feed(3000, 2000, true, 0, 82) && gate.clipFrames() == 0 &&
         gate.recoveryFrames() == 0 && gate.residualRejects() == 0;
}

static_assert(aecBargeRejectsStronglyCancelledAudioAndThenAcceptsVoice(), "residual rejection must not latch out later speech");
static_assert(aecBargeUsesWindowEnergyAndIncludesRatioBoundary(), "relative gate uses one whole window without overflow");
static_assert(aecBargeWaitsForCleanAudioAfterClipping(), "clipping recovery counts clean fresh samples, not wall time or stale frames");
static_assert(aecBargeClearsRecoveryAndWindowAtNextTurn(), "recovery and diagnostic state must not leak into another turn");
