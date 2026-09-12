#include "../devices/mcu/esp32_s3/toytalker_mini_v0.7/AecGateEnergy.h"
#include "../devices/mcu/esp32_s3/toytalker_mini_v0.7/AecBargeGate.h"
constexpr bool check() {
  aec_gate_energy::Moments dc, wave, biased, limits;
  for (int i = 0; i < 512; ++i) {
    dc.feed(2000);
    wave.feed(i % 2 ? 1500 : -1500);
    biased.feed(i % 2 ? 3500 : 500);
    limits.feed(i % 2 ? 32767 : -32768);
  }
  if (dc.acEnergy() || dc.mean() != 2000) return false;
  if (wave.acEnergy() != 512ULL * 1500 * 1500) return false;
  if (biased.acEnergy() != wave.acEnergy()) return false;
  if (limits.acEnergy() > limits.squares) return false;
  AecBargeGate gate;
  for (int i = 0; i < 8; ++i)
    if (gate.feed(0, 0, true, 0, 20)) return false;
  for (int i = 0; i < 3; ++i)
    if (gate.feed(1500, 1500, true, 0, 20)) return false;
  return gate.feed(1500, 1500, true, 0, 20);
}
static_assert(check(), "DC alone must not interrupt; AC voice keeps the existing hold and threshold");
