#pragma once
#include <stdint.h>

// Scale before int16 conversion, not after clipping. Keep the level gate in
// its previous amplitude units. This is an acoustic comparison, not AGC.
namespace aec_mic {
#ifndef TOYTALKER_AEC_MIC_DIVISOR
#define TOYTALKER_AEC_MIC_DIVISOR 1
#endif
constexpr int32_t divisor = TOYTALKER_AEC_MIC_DIVISOR;
static_assert(divisor == 1 || divisor == 4, "AEC input comparison supports divisor 1 or 4");
constexpr int32_t scaled(int32_t centered) { return centered / divisor; }
constexpr bool clipped(int32_t centered) {
  return scaled(centered) > 32767 || scaled(centered) < -32768;
}
constexpr bool previouslyClipped(int32_t centered) {
  return centered > 32767 || centered < -32768;
}
constexpr int16_t sample(int32_t centered) {
  return scaled(centered) > 32767 ? 32767 :
         scaled(centered) < -32768 ? -32768 : int16_t(scaled(centered));
}
constexpr uint32_t gateRms(uint32_t actualRms) { return actualRms * divisor; }
}
