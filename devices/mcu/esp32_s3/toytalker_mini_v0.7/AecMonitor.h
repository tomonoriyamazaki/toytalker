#pragma once
#include <Arduino.h>
#include <driver/i2s_std.h>
#include <esp_aec.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <math.h>
#include <new>
#include "AecCapture.h"
#include "AecSignal.h"
#include "AecMicHeadroom.h"
#include "AecGateEnergy.h"
#include "AecBargeGate.h"
#include "VoiceLevelMeter.h"

constexpr bool AEC_ENABLED = true;  // false: new I2S driver + original level monitor, for comparison
constexpr bool AEC_RESET_EACH_TURN = true; // compare against the old retained filter state
// Default is AGGR (1), the configuration verified on the device (2026-09-12).
// Build with -DTOYTALKER_AEC_NLP_LEVEL=0 to compare against NORMAL.
#ifndef TOYTALKER_AEC_NLP_LEVEL
#define TOYTALKER_AEC_NLP_LEVEL 1
#endif
static_assert(TOYTALKER_AEC_NLP_LEVEL == 0 || TOYTALKER_AEC_NLP_LEVEL == 1,
              "AEC comparison supports NORMAL(0) and AGGR(1) only");
constexpr aec_nlp_level_t AEC_NLP_LEVEL = static_cast<aec_nlp_level_t>(TOYTALKER_AEC_NLP_LEVEL);
constexpr const char* AEC_NLP_LABEL = TOYTALKER_AEC_NLP_LEVEL == 0 ? "NORMAL" : "AGGR";
constexpr uint32_t AEC_MIC_SAMPLES = 512;   // FD API: 32 ms at 16 kHz
static_assert(AEC_MIC_SAMPLES == AEC_BARGE_FRAME_SAMPLES, "barge-in hold must match AEC frame size");
constexpr uint32_t AEC_TX_SAMPLES = 1023;   // 4092-byte stereo DMA buffer at 24 kHz
constexpr uint32_t AEC_MIC_HOLD_MS = 96;    // maximum wait for matching TX EOF, not a fixed delay
constexpr int32_t AEC_REFERENCE_ADVANCE_MS = 16; // causal margin for filter, not an acoustic delay measurement

// A single static instance lives in internal SRAM. ISR callbacks only access
// its two small SRAM capture queues. Larger history/held audio lives in PSRAM
// and is accessed ONLY by the monitor task. No allocation/logging/DSP in ISR.
class AecMonitor {
  struct RxBlock { int64_t endUs; uint32_t sequence; int32_t data[AEC_MIC_SAMPLES]; };
  struct TxBlock { int64_t endUs; uint32_t sequence; int16_t data[AEC_TX_SAMPLES]; };
  struct MicBlock { int64_t endUs; uint32_t sequence, clips, preScaleClips; bool continuous; int16_t data[AEC_MIC_SAMPLES]; };
  struct Pending { MicBlock blocks[8]; uint32_t head = 0, tail = 0; };
  using History = aec_signal::ReferenceHistory<AEC_TX_SAMPLES, 16>;
  struct Stats {
    uint32_t paired = 0, missing = 0, pendingDrops = 0, clockResets = 0, clips = 0;
    uint32_t preScaleClips = 0;
    uint32_t gateMicRms = 0, gateOutRms = 0, dcRejectedFrames = 0;
    int32_t micMean = 0, outMean = 0;
    uint32_t cpuMaxUs = 0, slowFrames = 0, micRms = 0, refRms = 0, outRms = 0;
    uint64_t micEnergy = 0, outEnergy = 0;
  };
 public:
  bool init() {
    if (!AEC_ENABLED) { Serial.println("[AEC] disabled; raw level monitor only"); return false; }
    uint32_t internalBefore = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    uint32_t psramBefore = heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    void* historyMem = heap_caps_malloc(sizeof(History), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (historyMem) history_ = new (historyMem) History{};
    void* pendingMem = heap_caps_malloc(sizeof(Pending), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (pendingMem) pending_ = new (pendingMem) Pending{};
    for (auto& buffer : buffers_) {
      buffer = static_cast<int16_t*>(heap_caps_aligned_alloc(16, AEC_MIC_SAMPLES * sizeof(int16_t),
                                                          MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    }
    if (storageReady()) handle_ = createHandle();
    if (!handle_) {
      Serial.println("[AEC] init failed or unsupported frame size; raw level monitor only");
      release();
      return false;
    }
    Serial.printf("[AEC] ready=1 mode=FD_LOW_COST nlp=%s frame=%lu max_ref_wait_ms=%lu ref_advance_ms=%ld detect_only=%d barge_rms=%lu barge_hold_ms=%lu min_retained_pct=%lu clip_recovery_ms=%lu reset_each_turn=%d\n",
                  AEC_NLP_LABEL, (unsigned long)AEC_MIC_SAMPLES, (unsigned long)AEC_MIC_HOLD_MS, (long)AEC_REFERENCE_ADVANCE_MS,
                  AEC_BARGE_DETECT_ONLY, (unsigned long)AEC_BARGE_RMS, (unsigned long)AEC_BARGE_HOLD_MS,
                  (unsigned long)AEC_BARGE_MIN_RETAINED_PERCENT, (unsigned long)AEC_BARGE_CLIP_RECOVERY_MS,
                  AEC_RESET_EACH_TURN);
    Serial.printf("[AEC_MEM] internal_delta=%ld psram_delta=%ld internal_free=%lu max_blk=%lu\n",
                  (long)internalBefore - (long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                  (long)psramBefore - (long)heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT),
                  (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                  (unsigned long)heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
    return true;
  }
  // Only before any channel/callback/task is running (initialization failure).
  void release() {
    if (handle_) aec_destroy(handle_);
    handle_ = nullptr;
    heap_caps_free(history_); history_ = nullptr;
    heap_caps_free(pending_); pending_ = nullptr;
    for (auto& buffer : buffers_) { heap_caps_free(buffer); buffer = nullptr; }
  }
  bool ready() const { return handle_ != nullptr; }
  void start(uint32_t generation) {
    if (!storageReady()) return;
    // The previous monitor task has acknowledged stop, and capture is disabled.
    // Input time/history restarts each turn, so the library's adaptive filter
    // and buffered audio must start a new session too. No public reset API is
    // exposed by the installed SDK; only recreate the DSP handle, not capture storage.
    const int64_t resetStarted = esp_timer_get_time();
    const bool recreate = !handle_ || (AEC_RESET_EACH_TURN && turnStarted_);
    if (recreate) {
      if (handle_) aec_destroy(handle_);
      handle_ = createHandle();
    }
    turnStarted_ = true;
    Serial.printf("[AEC_RESET] generation=%lu enabled=%d recreated=%d ready=%d elapsed_us=%lu internal_free=%lu psram_free=%lu\n",
                  (unsigned long)generation, AEC_RESET_EACH_TURN, recreate, ready(),
                  (unsigned long)(esp_timer_get_time() - resetStarted),
                  (unsigned long)heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                  (unsigned long)heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
    if (!ready()) {
      // Keep reusable storage and retry next turn; caller uses detect-only raw
      // monitoring this turn. Do not reuse a possibly contaminated old instance.
      summaryPending_ = false;
      Serial.println("[AEC] turn reset failed; raw level monitor only, retry next turn");
      return;
    }
    // No old DMA callback can publish while capture is disabled.
    rx_.reset(); tx_.reset();
    rxSequence_ = txSequence_ = 0;
    history_->reset(); pending_->head = pending_->tail = 0;
    rxClock_.reset(); txClock_.reset(); lowPass_.reset();
    micLevels_.reset(); outLevels_.reset(); stats_ = Stats{};
    bargeGate_.reset(); triggerAudioAgeMs_ = 0;
    dcReady_ = false; firstAudioUs_ = 0; processedSequence_ = 0;
    generation_ = generation; lastLog_ = millis(); summaryPending_ = false;
    windowMicEnergy_ = windowOutEnergy_ = 0; windowMicMax_ = windowOutMax_ = 0;
    capture_.start();
    Serial.printf("[AEC_INPUT] divisor=%ld gate_rms_multiplier=%ld\n",
                  (long)aec_mic::divisor, (long)aec_mic::divisor);
    Serial.printf("[AEC] monitor start generation=%lu nlp=%s detect_only=%d max_ref_wait_ms=%lu barge_rms=%lu barge_hold_ms=%lu\n",
                  (unsigned long)generation_, AEC_NLP_LABEL, AEC_BARGE_DETECT_ONLY, (unsigned long)AEC_MIC_HOLD_MS,
                  (unsigned long)AEC_BARGE_RMS, (unsigned long)AEC_BARGE_HOLD_MS);
  }
  void stopCapture() { capture_.stop(); }
  void finish() {
    // Pending delayed mic frames are discarded, not waited for during STT restart.
    summaryPending_ = true;
  }

  void IRAM_ATTR captureRx(const i2s_event_data_t* event) {
    if (!capture_.enabledFromISR()) return;
    uint32_t seq = ++rxSequence_;
    if (event->size != sizeof(RxBlock::data) || !event->dma_buf) {
      capture_.errorFromISR(); return;
    }
    auto* b = rx_.beginPush();
    if (!b) return;
    b->endUs = esp_timer_get_time(); b->sequence = seq;
    const int32_t* source = static_cast<const int32_t*>(event->dma_buf);
    for (size_t i = 0; i < AEC_MIC_SAMPLES; ++i) b->data[i] = source[i];
    rx_.commitPush();
  }
  void IRAM_ATTR captureTx(const i2s_event_data_t* event) {
    if (!capture_.enabledFromISR()) return;
    uint32_t seq = ++txSequence_;
    if (event->size != AEC_TX_SAMPLES * 4 || !event->dma_buf) {
      capture_.errorFromISR(); return;
    }
    auto* b = tx_.beginPush();
    if (!b) return;
    b->endUs = esp_timer_get_time(); b->sequence = seq;
    const int16_t* source = static_cast<const int16_t*>(event->dma_buf);
    // Both slots carry the same post-volume/clipped waveform. Copy before auto-clear.
    for (size_t i = 0; i < AEC_TX_SAMPLES; ++i) b->data[i] = source[i * 2];
    tx_.commitPush();
  }

  bool pump() {
    bool triggered = false;
    drainTx(); drainRx();
    if (pending_->head != pending_->tail) {
      const auto& mic = pending_->blocks[pending_->tail % 8];
      int16_t lastReference = 0;
      const int64_t lastTick = referenceFirstTick(mic.endUs) + int64_t(AEC_MIC_SAMPLES - 1) * 3000;
      // Begin when the last reference sample (including interpolation) exists.
      // process() still validates EVERY sample; gaps never become silent audio.
      if (history_->sample(lastTick, lastReference) ||
          esp_timer_get_time() - mic.endUs >= int64_t(AEC_MIC_HOLD_MS) * 1000) {
        triggered = process(mic);
        ++pending_->tail;
      }
    }
    // Return a candidate before serial output so the caller can mute promptly.
    if (!triggered && millis() - lastLog_ >= 1000) {
      Serial.printf("[AEC] mic=%lu ref=%lu out=%lu mic_max=%lu out_max=%lu reduction_db=%.1f paired=%lu missing=%lu mic_drop=%lu ref_drop=%lu cpu_max_us=%lu\n",
                    (unsigned long)stats_.micRms, (unsigned long)stats_.refRms, (unsigned long)stats_.outRms,
                    (unsigned long)windowMicMax_, (unsigned long)windowOutMax_,
                    reduction(windowMicEnergy_, windowOutEnergy_), (unsigned long)stats_.paired,
                    (unsigned long)stats_.missing, (unsigned long)rx_.dropped(),
                    (unsigned long)tx_.dropped(), (unsigned long)stats_.cpuMaxUs);
      windowMicEnergy_ = windowOutEnergy_ = 0; windowMicMax_ = windowOutMax_ = 0;
      lastLog_ = millis();
    }
    return triggered;
  }
  void printTrigger(uint32_t atMs) {
    printGateAc();
    Serial.printf("[AEC_TRIGGER] generation=%lu mic=%lu ref=%lu out=%lu threshold=%lu hold_ms=%lu audio_age_ms=%lu detect_only=%d at_ms=%lu window_retained_pct=%.1f\n",
                  (unsigned long)generation_, (unsigned long)stats_.micRms, (unsigned long)stats_.refRms,
                  (unsigned long)stats_.outRms, (unsigned long)AEC_BARGE_RMS, (unsigned long)AEC_BARGE_HOLD_MS,
                  (unsigned long)triggerAudioAgeMs_, AEC_BARGE_DETECT_ONLY, (unsigned long)atMs,
                  retainedPercent());
  }
  void printSummary() {
    if (!summaryPending_) return;
    summaryPending_ = false;
    printGateAc();
    Serial.printf("[AEC_INPUT] divisor=%ld pre_scale_clips=%lu actual_clips=%lu\n",
                  (long)aec_mic::divisor, (unsigned long)stats_.preScaleClips, (unsigned long)stats_.clips);
    Serial.printf("[AEC_LEVEL] generation=%lu mic_peak=%lu mic_sustained=%lu out_peak=%lu out_sustained=%lu hold_ms=128 windows=%lu reduction_db=%.1f detect_only=%d gate_fired=%d\n",
                  (unsigned long)generation_, (unsigned long)micLevels_.peakRms(),
                  (unsigned long)micLevels_.sustainedRms(), (unsigned long)outLevels_.peakRms(),
                  (unsigned long)outLevels_.sustainedRms(), (unsigned long)outLevels_.windows(),
                  reduction(stats_.micEnergy, stats_.outEnergy), AEC_BARGE_DETECT_ONLY, bargeGate_.fired());
    Serial.printf("[AEC_STATS] paired=%lu missing=%lu mic_drop=%lu ref_drop=%lu pending_drop=%lu clock_resets=%lu format_errors=%lu clips=%lu cpu_max_us=%lu slow_frames=%lu held_discarded=%lu\n",
                  (unsigned long)stats_.paired, (unsigned long)stats_.missing,
                  (unsigned long)rx_.dropped(), (unsigned long)tx_.dropped(),
                  (unsigned long)stats_.pendingDrops, (unsigned long)stats_.clockResets,
                  (unsigned long)capture_.errors(), (unsigned long)stats_.clips,
                  (unsigned long)stats_.cpuMaxUs, (unsigned long)stats_.slowFrames,
                  (unsigned long)(pending_->head - pending_->tail));
    Serial.printf("[AEC_GATE] residual_reject_windows=%lu clip_frames=%lu recovery_frames=%lu min_retained_pct=%lu clip_recovery_ms=%lu\n",
                  (unsigned long)bargeGate_.residualRejects(), (unsigned long)bargeGate_.clipFrames(),
                  (unsigned long)bargeGate_.recoveryFrames(), (unsigned long)AEC_BARGE_MIN_RETAINED_PERCENT,
                  (unsigned long)AEC_BARGE_CLIP_RECOVERY_MS);
    // Deferred until STT's first send; extra logs must not delay the handoff.
    // Oldest first; turn-wide peaks cannot explain a trigger's four frames.
    if (bargeGate_.fired()) {
      for (uint32_t i = 0; i < AEC_BARGE_HOLD_FRAMES; ++i)
        Serial.printf("[AEC_GATE_FRAME] index=%lu mic=%lu out=%lu\n", (unsigned long)i,
                      (unsigned long)bargeGate_.micFrame(i), (unsigned long)bargeGate_.outFrame(i));
    }
  }
 private:
  void printGateAc() const {
    Serial.printf("[AEC_GATE_AC] mic_total=%lu out_total=%lu mic_ac=%lu out_ac=%lu mic_mean=%ld out_mean=%ld dc_rejected_frames=%lu\n",
                  (unsigned long)stats_.micRms, (unsigned long)stats_.outRms,
                  (unsigned long)stats_.gateMicRms, (unsigned long)stats_.gateOutRms,
                  (long)stats_.micMean, (long)stats_.outMean, (unsigned long)stats_.dcRejectedFrames);
  }
  bool storageReady() const {
    return history_ && pending_ && buffers_[0] && buffers_[1] && buffers_[2];
  }
  static aec_handle_t* createHandle() {
    aec_config_t config = {};
    config.mic_num = config.ref_num = config.out_num = 1;
    config.filter_length = 4;
    config.sample_rate = 16000;
    config.caps = MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT;
    config.mode = AEC_MODE_FD_LOW_COST;
    config.nlp_level = AEC_NLP_LEVEL;
    aec_handle_t* handle = aec_create_from_config(&config);
    if (handle && aec_get_chunksize(handle) != AEC_MIC_SAMPLES) {
      aec_destroy(handle);
      return nullptr;
    }
    return handle;
  }
  double retainedPercent() const {
    return bargeGate_.micEnergy() ? 100.0 * sqrt(double(bargeGate_.outEnergy()) /
                                                double(bargeGate_.micEnergy())) : NAN;
  }
  static int64_t referenceFirstTick(int64_t micEndUs) {
    return (micEndUs - 32000 + int64_t(AEC_REFERENCE_ADVANCE_MS) * 1000) * 48;
  }
  static uint64_t energy(const int16_t* samples) {
    uint64_t result = 0;
    for (size_t i = 0; i < AEC_MIC_SAMPLES; ++i) result += int64_t(samples[i]) * samples[i];
    return result;
  }
  static uint32_t rms(uint64_t e) { return uint32_t(sqrt(double(e) / AEC_MIC_SAMPLES)); }
  static double reduction(uint64_t mic, uint64_t out) {
    // NAN means no valid reference-active comparison; zero output is finite-clamped.
    return mic ? 10.0 * log10(double(mic) / double(out ? out : 1)) : NAN;
  }
  void breakLevels() { micLevels_.breakRun(); outLevels_.breakRun(); bargeGate_.breakRun(); }
  void drainTx() {
    while (const auto* b = tx_.peek()) {
      if (!txClock_.observe(b->sequence, b->endUs, 42625)) {
        if (b->sequence > 1) ++stats_.clockResets;
        history_->reset(); lowPass_.reset();
      }
      int64_t startUs = txClock_.endUs() - 42625;
      auto& block = history_->begin((startUs - 500) * 48); // FIR group delay
      bool audible = false;
      for (size_t i = 0; i < AEC_TX_SAMPLES; ++i) {
        audible |= b->data[i] != 0;
        block.data[i] = lowPass_.feed(b->data[i]);
      }
      if (audible && !firstAudioUs_) firstAudioUs_ = startUs;
      history_->commit(); tx_.pop();
    }
  }
  void drainRx() {
    while (const auto* b = rx_.peek()) {
      const bool continuous = rxClock_.observe(b->sequence, b->endUs, 32000);
      if (!continuous) {
        if (b->sequence > 1) ++stats_.clockResets;
        dcReady_ = false;
      }
      if (pending_->head - pending_->tail >= 8) { ++pending_->tail; ++stats_.pendingDrops; }
      auto& dest = pending_->blocks[pending_->head % 8];
      dest.endUs = rxClock_.endUs(); dest.sequence = b->sequence; dest.clips = dest.preScaleClips = 0;
      dest.continuous = continuous;
      for (size_t i = 0; i < AEC_MIC_SAMPLES; ++i) {
        int32_t value = b->data[i] >> 14;
        if (!dcReady_) { dc_ = value; dcReady_ = true; }
        dc_ += (value - dc_) >> 10;
        int32_t centered = value - dc_;
        if (aec_mic::previouslyClipped(centered)) ++dest.preScaleClips;
        if (aec_mic::clipped(centered)) ++dest.clips;
        dest.data[i] = aec_mic::sample(centered);
      }
      ++pending_->head; rx_.pop();
    }
  }
  bool process(const MicBlock& mic) {
    int64_t started = esp_timer_get_time();
    if (!mic.continuous || mic.sequence != processedSequence_ + 1) breakLevels();
    processedSequence_ = mic.sequence;
    auto* in = buffers_[0]; auto* ref = buffers_[1]; auto* out = buffers_[2];
    int64_t firstTick = referenceFirstTick(mic.endUs);
    bool complete = true;
    for (size_t i = 0; i < AEC_MIC_SAMPLES; ++i) {
      in[i] = mic.data[i];
      if (!history_->sample(firstTick + int64_t(i) * 3000, ref[i])) complete = false;
    }
    if (!complete) { ++stats_.missing; breakLevels(); return false; }
    // Before the first transmitted sound, detection is unarmed and no echo is
    // present. Leave this CPU time for TLS/response startup instead of DSP.
    if (firstAudioUs_) aec_process(handle_, in, ref, out);
    else for (size_t i = 0; i < AEC_MIC_SAMPLES; ++i) out[i] = in[i];
    uint64_t mi = energy(in), re = energy(ref), ou = energy(out);
    stats_.micRms = aec_mic::gateRms(rms(mi)); stats_.refRms = rms(re);
    stats_.outRms = aec_mic::gateRms(rms(ou));
    aec_gate_energy::Moments micMoments, outMoments;
    for (size_t i = 0; i < AEC_MIC_SAMPLES; ++i) {
      micMoments.feed(in[i]); outMoments.feed(out[i]);
    }
    stats_.gateMicRms = aec_mic::gateRms(rms(micMoments.acEnergy()));
    stats_.gateOutRms = aec_mic::gateRms(rms(outMoments.acEnergy()));
    stats_.micMean = micMoments.mean() * aec_mic::divisor;
    stats_.outMean = outMoments.mean() * aec_mic::divisor;
    stats_.preScaleClips += mic.preScaleClips;
    ++stats_.paired; stats_.clips += mic.clips;
    bool armed = firstAudioUs_ && mic.endUs - 32000 >= firstAudioUs_ + int64_t(AEC_BARGE_WARMUP_MS) * 1000;
    micLevels_.feed(stats_.micRms, armed); outLevels_.feed(stats_.outRms, armed);
    if (armed) {
      if (stats_.micRms > windowMicMax_) windowMicMax_ = stats_.micRms;
      if (stats_.outRms > windowOutMax_) windowOutMax_ = stats_.outRms;
      // Reduction is only over reference-active, warmed-up frames, not silent gaps.
      if (stats_.refRms >= 100) {
        stats_.micEnergy += mi; stats_.outEnergy += ou;
        windowMicEnergy_ += mi; windowOutEnergy_ += ou;
      }
    }
    const int64_t finishedUs = esp_timer_get_time();
    const uint32_t ageMs = uint32_t((finishedUs - mic.endUs) / 1000);
    if (armed && stats_.outRms >= AEC_BARGE_RMS && stats_.gateOutRms < AEC_BARGE_RMS)
      ++stats_.dcRejectedFrames;
    const bool triggered = bargeGate_.feed(stats_.gateMicRms, stats_.gateOutRms, armed, mic.clips, ageMs);
    if (triggered) triggerAudioAgeMs_ = ageMs;
    uint32_t elapsed = uint32_t(finishedUs - started);
    if (elapsed > stats_.cpuMaxUs) stats_.cpuMaxUs = elapsed;
    if (elapsed > 32000) ++stats_.slowFrames;
    return triggered;
  }

  AecCaptureQueue<RxBlock, 2> rx_;
  AecCaptureQueue<TxBlock, 2> tx_;
  AecCaptureState capture_;
  uint32_t rxSequence_ = 0, txSequence_ = 0;  // respective ISR only, reset while capture disabled
  aec_handle_t* handle_ = nullptr;
  History* history_ = nullptr;
  Pending* pending_ = nullptr;
  int16_t* buffers_[3] = {};
  aec_signal::SampleClock rxClock_, txClock_;
  aec_signal::LowPass24k lowPass_;
  VoiceLevelMeter<4> micLevels_, outLevels_;
  AecBargeGate bargeGate_;
  uint32_t triggerAudioAgeMs_ = 0;
  Stats stats_;
  uint32_t generation_ = 0, lastLog_ = 0, processedSequence_ = 0;
  uint32_t windowMicMax_ = 0, windowOutMax_ = 0;
  uint64_t windowMicEnergy_ = 0, windowOutEnergy_ = 0;
  int64_t firstAudioUs_ = 0;
  int32_t dc_ = 0;
  bool dcReady_ = false, summaryPending_ = false, turnStarted_ = false;
};
