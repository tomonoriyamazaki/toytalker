#include "../devices/mcu/esp32_s3/toytalker_mini_v0.7/ChunkedBodyDecoder.h"
#include "../devices/mcu/esp32_s3/toytalker_mini_v0.7/StreamCompletion.h"

struct Clock {
  uint32_t tick = 0;
  constexpr uint32_t now() const { return tick; }
  constexpr void idle() { ++tick; }
  constexpr bool cancelled() const { return false; }
};
struct Client {
  const char* wire;
  size_t length, pos = 0;
  bool hold = false;
  constexpr int available() const { return pos < length ? 1 : 0; }
  constexpr bool connected() const { return pos < length || hold; }
  constexpr int read(uint8_t* out, size_t) { *out = wire[pos++]; return 1; }
};

// Real decoder: fragmented PCM frame, complete metadata, then missing HTTP end.
constexpr char body[] = "1e\r\n"
    "\x02\x04\x00\x00\x00\x10\x20\x30\x40"
    "\x01\x10\x00\x00\x00{\"event\":\"done\"}\r\n";
constexpr bool transportCase(bool complete, bool hold = false) {
  constexpr char full[] = "1e\r\n"
      "\x02\x04\x00\x00\x00\x10\x20\x30\x40"
      "\x01\x10\x00\x00\x00{\"event\":\"done\"}\r\n0\r\n\r\n";
  Client client{complete ? full : body, complete ? sizeof(full)-1 : sizeof(body)-1};
  client.hold = hold;
  Clock clock;
  ChunkedBodyDecoder decoder;
  StreamCompletion completion;
  uint8_t out[16] = {};
  if (decoder.read(client, clock, out, 5) != 5 || lambdaFrameLength(out) != 4) return false;
  completion.pcmStarted();
  if (decoder.read(client, clock, out, 4) != 4) return false;
  if (decoder.read(client, clock, out, 5) != 5 || lambdaFrameLength(out) != 16) return false;
  if (decoder.read(client, clock, out, 16) != 16) return false;
  completion.metadata("done");
  size_t got = decoder.read(client, clock, out, 5, 5);
  bool recover = completion.canDrainAfterClose(got, decoder.error(), false);
  return got == 0 && (complete ? decoder.done() && !recover :
                     hold ? decoder.failed() && !recover : decoder.failed() && recover);
}
static_assert(transportCase(true), "normal HTTP termination remains normal");
static_assert(transportCase(false), "missing HTTP termination preserves completed audio");
static_assert(transportCase(false, true), "idle timeout is not masked");

constexpr bool truncatedPayload() {
  constexpr char wire[] = "9\r\n\x02\x04\x00\x00\x00\x10\x20";
  Client client{wire, sizeof(wire)-1};
  Clock clock;
  ChunkedBodyDecoder decoder;
  StreamCompletion completion;
  uint8_t out[5] = {};
  if (decoder.read(client, clock, out, 5) != 5) return false;
  completion.pcmStarted();
  return decoder.read(client, clock, out, 4) == 2 && decoder.failed() &&
         !completion.canDrainAfterClose(0, decoder.error(), false);
}
static_assert(truncatedPayload(), "PCM mid-frame disconnect remains an error");

constexpr bool safeguards() {
  StreamCompletion c;
  if (c.canDrainAfterClose(0, "connection_closed", false)) return false;
  c.metadata("done");
  if (!c.canDrainAfterClose(0, "connection_closed", false)) return false;
  for (size_t i = 1; i < 5; ++i)
    if (c.canDrainAfterClose(i, "connection_closed", false)) return false;
  if (c.canDrainAfterClose(0, "connection_closed", true)) return false;
  if (c.canDrainAfterClose(0, "chunk_framing", false)) return false;
  c.metadata("error");
  if (c.canDrainAfterClose(0, "connection_closed", false)) return false;
  c.reset(); c.metadata("error"); c.metadata("done");
  if (c.canDrainAfterClose(0, "connection_closed", false)) return false;
  c.reset(); c.metadata("done"); c.pcmStarted();
  if (c.canDrainAfterClose(0, "connection_closed", false)) return false;
  c.metadata("done"); c.metadata("tts_start");
  if (c.canDrainAfterClose(0, "connection_closed", false)) return false;
  c.metadata("done"); c.reset();
  return !c.doneSeen() && !c.errorSeen();
}
static_assert(safeguards(), "partial frames, errors, interruption and stale done cannot recover");
