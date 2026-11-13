#pragma once
// PlaybackLimiter.h — 再生音を大きく聞こえさせる処理（0.7.20）。音の配分（EQ）→ リミッター。
//
// 以前は「VOLUME 倍して、int16 をはみ出た山を切り落とす」だけだった。話し声は大きな山がたまに来て、
// 大半は小さいので、倍率を上げると山が割れるだけで全体は大きく聞こえない（2.0 で頭打ちだった）。
//
// 1. EQ（音の高さの配分）: 小さいスピーカーは 300Hz より下をほとんど鳴らせないのに、声の電力の多くは
//    そこにあって上限の枠を使ってしまう。低い音を削り（ハイパス）、耳が敏感でスピーカーも得意な
//    3kHz 付近を持ち上げる（ピーキング）。同じ上限の中で、はっきり大きく聞こえる。
// 2. リミッター: 全体を gain 倍に持ち上げ、山が上限（CEILING）を超えそうな所だけ自動で絞る。
//    入力を LOOKAHEAD サンプル（2ms）遅らせて出し、その間にこれから出る山を見て絞りを先に効かせる
//    （attack 約0.5ms）。山が過ぎたら約120ms かけて戻す（release）。
//    最後に int16 で切るのは保険で、通常は当たらない。遅れの 2ms ぶんは再生の終わりで出ずに残る。
//
// 置き場所はファームの最後の段。本文・相槌の両方が通る（monoToStereo）。AEC の参照は I2S へ書いた後の
// 波形から取るので、処理した後の音がそのまま参照になる。
#include <stdint.h>
#include <stddef.h>
#include <math.h>

class PlaybackLimiter {
 public:
  static constexpr size_t LOOKAHEAD = 48;      // 24kHz で 2ms
  static constexpr float SAMPLE_RATE = 24000.0f;
  static constexpr float CEILING = 30000.0f;   // int16 の少し手前
  static constexpr float GAIN_MIN = 1.0f, GAIN_MAX = 8.0f;
  // EQ の値（聞いて詰める）
  static constexpr float HIGHPASS_HZ = 300.0f;
  static constexpr float PRESENCE_HZ = 3000.0f, PRESENCE_DB = 6.0f, PRESENCE_Q = 1.0f;

  struct Stats {
    uint32_t samples = 0;
    uint16_t inPeak = 0;        // 届いた音声の山（何もかける前）
    uint64_t inSquares = 0;     // 届いた音声の2乗和（平均の大きさ用）
    uint64_t outSquares = 0;    // 出した音の2乗和
    uint32_t limited = 0;       // 絞りが効いたサンプル数（1dB 以上）
    float minReduction = 1.0f;  // いちばん強く絞った時の倍率（1.0 = 絞っていない）
    uint32_t hardClips = 0;     // 保険の切り落としに当たった数（0 のはず）
    uint32_t inRms() const { return samples ? (uint32_t)sqrt((double)inSquares / samples) : 0; }
    uint32_t outRms() const { return samples ? (uint32_t)sqrt((double)outSquares / samples) : 0; }
    uint32_t limitedPct() const { return samples ? (uint32_t)((uint64_t)limited * 100 / samples) : 0; }
  };

  PlaybackLimiter() {
    highpass_.setHighpass(HIGHPASS_HZ, 0.7071f);
    presence_.setPeaking(PRESENCE_HZ, PRESENCE_DB, PRESENCE_Q);
  }
  void setGain(float g) { gain_ = g < GAIN_MIN ? GAIN_MIN : g > GAIN_MAX ? GAIN_MAX : g; }
  float gain() const { return gain_; }
  void setEq(bool on) { eq_ = on; }
  bool eq() const { return eq_; }
  const Stats& stats() const { return stats_; }
  void resetStats() { stats_ = Stats{}; }
  // 新しい返答の前に。前の返答の残り（遅延の中身・絞り・フィルタ）を持ち越さない
  void reset() {
    for (size_t i = 0; i < LOOKAHEAD; i++) delay_[i] = 0, abs_[i] = 0;
    pos_ = 0;
    env_ = 0;
    highpass_.clear();
    presence_.clear();
  }

  // mono（int16）→ stereo（左右同じ）。samples は mono の数
  void process(const int16_t* mono, int16_t* stereo, size_t samples) {
    for (size_t i = 0; i < samples; i++) {
      const int16_t in = mono[i];
      const uint16_t absIn = in < 0 ? (uint16_t)(-(int32_t)in) : (uint16_t)in;
      if (absIn > stats_.inPeak) stats_.inPeak = absIn;
      stats_.inSquares += (uint32_t)absIn * absIn;

      float x = (float)in;
      if (eq_) x = presence_.step(highpass_.step(x));

      const float delayed = delay_[pos_];
      delay_[pos_] = x;
      abs_[pos_] = fabsf(x);
      pos_ = (pos_ + 1) % LOOKAHEAD;

      // これから出る 2ms の中でいちばん大きい山を見る（1サンプルだけの山も、出る前に絞りが間に合う）
      float ahead = 0;
      for (size_t k = 0; k < LOOKAHEAD; k++) if (abs_[k] > ahead) ahead = abs_[k];
      const float level = ahead * gain_;
      if (level > env_) env_ += (level - env_) * ATTACK;  // 速く追う
      else env_ += (level - env_) * RELEASE;              // ゆっくり戻す

      float reduction = 1.0f;
      if (env_ > CEILING) reduction = CEILING / env_;
      if (reduction < 0.89f) stats_.limited++;  // 1dB 以上絞った
      if (reduction < stats_.minReduction) stats_.minReduction = reduction;

      float out = delayed * gain_ * reduction;
      if (out > 32767.0f) { out = 32767.0f; stats_.hardClips++; }
      else if (out < -32768.0f) { out = -32768.0f; stats_.hardClips++; }
      const int16_t s = (int16_t)out;
      stats_.outSquares += (int64_t)s * s;
      stats_.samples++;
      stereo[2 * i] = s;
      stereo[2 * i + 1] = s;
    }
  }

 private:
  // 2次のフィルタ（RBJ の式）
  struct Biquad {
    float b0 = 1, b1 = 0, b2 = 0, a1 = 0, a2 = 0, z1 = 0, z2 = 0;
    void clear() { z1 = z2 = 0; }
    float step(float x) {
      const float y = b0 * x + z1;
      z1 = b1 * x - a1 * y + z2;
      z2 = b2 * x - a2 * y;
      return y;
    }
    void setHighpass(float hz, float q) {
      const float w = 2.0f * (float)M_PI * hz / SAMPLE_RATE, c = cosf(w), alpha = sinf(w) / (2.0f * q);
      const float a0 = 1.0f + alpha;
      b0 = (1.0f + c) / 2.0f / a0; b1 = -(1.0f + c) / a0; b2 = b0;
      a1 = -2.0f * c / a0; a2 = (1.0f - alpha) / a0;
    }
    void setPeaking(float hz, float db, float q) {
      const float A = powf(10.0f, db / 40.0f);
      const float w = 2.0f * (float)M_PI * hz / SAMPLE_RATE, c = cosf(w), alpha = sinf(w) / (2.0f * q);
      const float a0 = 1.0f + alpha / A;
      b0 = (1.0f + alpha * A) / a0; b1 = -2.0f * c / a0; b2 = (1.0f - alpha * A) / a0;
      a1 = -2.0f * c / a0; a2 = (1.0f - alpha / A) / a0;
    }
  };
  // 1サンプルあたりの係数（24kHz）。attack 約0.5ms、release 約120ms
  static constexpr float ATTACK = 0.08f;
  static constexpr float RELEASE = 0.00035f;
  float gain_ = 1.5f;
  bool eq_ = false;  // 既定はなし（2026-11-13: +6dB の持ち上げで再生中ずっとシャラシャラした音が乗った。外すと消えた）
  float env_ = 0;
  float delay_[LOOKAHEAD] = {};
  float abs_[LOOKAHEAD] = {};
  size_t pos_ = 0;
  Biquad highpass_, presence_;
  Stats stats_;
};
