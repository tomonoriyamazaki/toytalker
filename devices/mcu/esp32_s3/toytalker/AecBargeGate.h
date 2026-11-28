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

// 発火後の確かめ（2026-11-09、0.7.9）: 発火したらアンプを切って再生を一時停止し、スピーカーが黙っている間に
// マイクだけで声が続くかを見る。続けば割り込み、静かなら止めた所から再生を続ける。
// 再生音の漏れ・触った音・くすっと笑う程度の短い音は、スピーカーを止めれば消えるので再開になる。
// 鳴り続ける背景の音（プリンターなど）は声と区別できない。値は試験値（ログの aec_confirm_* で詰める）。
constexpr uint32_t AEC_CONFIRM_SETTLE_MS = 64;     // アンプを切ってから部屋の残響が引くまで（このフレームは数えない）
constexpr uint32_t AEC_CONFIRM_WINDOW_MS = 384;    // 耳をすます長さ（12 フレーム）
constexpr uint32_t AEC_CONFIRM_RMS = 1200;         // 声とみなすマイクの AC RMS（判定と同じ尺度）
constexpr uint32_t AEC_CONFIRM_VOICE_FRAMES = 3;   // 窓の中でこれだけ超えたら声（連続でなくてよい。音節の切れ目があるため）
constexpr uint32_t AEC_CONFIRM_TIMEOUT_MS = 1000;  // マイクのフレームが来ないときの保険。来なければ割り込み扱い（従来どおり止める）
constexpr uint32_t AEC_REARM_MS = 300;             // 再開してから判定を再開するまで
// 0.7.10: 音量に加えて ESP-SR の VAD（声の特徴）も見る。指がマイクに当たる音など、大きいが声でない音を除くため。
// モードは大きいほど声と判定しにくい（esp_vad.h）。VAD が作れなければ音量だけで判定する（0.7.9 と同じ）
constexpr int AEC_CONFIRM_VAD_MODE = 2;            // VAD_MODE_2（試験値）
constexpr uint32_t AEC_CONFIRM_VAD_MS = 30;        // VAD に渡す長さ（32ms のフレームの先頭 480 サンプル）
constexpr uint32_t AEC_CONFIRM_WINDOW_FRAMES = AEC_CONFIRM_WINDOW_MS * 16 / AEC_BARGE_FRAME_SAMPLES;
static_assert(AEC_CONFIRM_WINDOW_FRAMES * AEC_BARGE_FRAME_SAMPLES == AEC_CONFIRM_WINDOW_MS * 16,
              "confirm window must contain whole AEC frames");

class AecBargeGate {
 public:
  constexpr void reset() { *this = AecBargeGate{}; }
  // A gap breaks the candidate but must not clear an active clipping guard.
  constexpr void breakRun() {
    used_ = next_ = 0;
    micEnergy_ = outEnergy_ = 0;
    for (uint32_t i = 0; i < AEC_BARGE_HOLD_FRAMES; ++i) mic_[i] = out_[i] = 0;
  }
  // 確かめの結果が「声ではない」だったとき。数えた回数は残し、次の発火を待てる状態に戻す
  constexpr void rearm() { breakRun(); fired_ = false; recoverySamples_ = 0; }
  constexpr bool fired() const { return fired_; }
  constexpr uint32_t residualRejects() const { return residualRejects_; }
  constexpr uint32_t clipFrames() const { return clipFrames_; }
  constexpr uint32_t recoveryFrames() const { return recoveryFrames_; }
  constexpr uint32_t ageRejects() const { return ageRejects_; }
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
    if (ageMs > AEC_BARGE_MAX_AGE_MS) { ++ageRejects_; breakRun(); return false; }
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
  uint32_t residualRejects_ = 0, clipFrames_ = 0, recoveryFrames_ = 0, ageRejects_ = 0;
  bool fired_ = false;
};
