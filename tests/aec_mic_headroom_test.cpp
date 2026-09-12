#include "../devices/mcu/esp32_s3/toytalker_mini_v0.7/AecMicHeadroom.h"
#if TOYTALKER_AEC_MIC_DIVISOR == 4
static_assert(aec_mic::sample(80000) == 20000 && !aec_mic::clipped(80000), "gain must be reduced before saturation");
static_assert(aec_mic::sample(-80000) == -20000 && !aec_mic::clipped(-80000), "negative headroom must be preserved");
static_assert(aec_mic::previouslyClipped(80000), "count potential clipping at the previous gain");
static_assert(aec_mic::sample(200000) == 32767 && aec_mic::clipped(200000), "extreme positive input still saturates safely");
static_assert(aec_mic::sample(-200000) == -32768 && aec_mic::clipped(-200000), "extreme negative input still saturates safely");
static_assert(aec_mic::gateRms(300) == 1200, "preserve the gate amplitude units");
static_assert(aec_mic::sample(0) == 0 && aec_mic::gateRms(0) == 0, "silence remains silence");
static_assert(aec_mic::sample(131068) == 32767 && !aec_mic::clipped(131068), "positive representable boundary");
static_assert(aec_mic::sample(-131072) == -32768 && !aec_mic::clipped(-131072), "negative representable boundary");
#else
static_assert(aec_mic::sample(80000) == 32767 && aec_mic::clipped(80000), "baseline saturates positive input");
static_assert(aec_mic::sample(-80000) == -32768 && aec_mic::clipped(-80000), "baseline saturates negative input");
static_assert(aec_mic::sample(12345) == 12345 && aec_mic::gateRms(300) == 300, "baseline keeps original amplitude");
#endif
