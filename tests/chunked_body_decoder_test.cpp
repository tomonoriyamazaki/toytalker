#include "../devices/mcu/esp32_s3/toytalker_mini_v0.6/ChunkedBodyDecoder.h"

// Compile-time integration tests execute the same read loop used by the firmware,
// with deterministic TCP packet arrival, short reads and a controllable clock.
struct Clock {
  uint32_t tick = 0, cancelAt = UINT32_MAX;
  constexpr uint32_t now() const { return tick; }
  constexpr void idle() { ++tick; }
  constexpr bool cancelled() const { return cancelAt != UINT32_MAX && tick >= cancelAt; }
};

struct Client {
  Clock& clock;
  const char* wire;
  size_t length, pos = 0, packet = 1, readLimit = 100000;
  uint32_t spacing = 2;
  bool holdOpen = false, transientNegative = false, transientZero = false;
  constexpr int available() const {
    size_t released = (clock.tick / spacing + 1) * packet;
    if (released > length) released = length;
    return released > pos ? (int)(released - pos) : 0;
  }
  constexpr bool connected() const { return pos < length || holdOpen; }
  constexpr int read(uint8_t* dst, size_t count) {
    if (transientNegative) { transientNegative = false; return -1; }
    if (transientZero) { transientZero = false; return 0; }
    size_t got = (size_t)available();
    if (got > count) got = count;
    if (got > readLimit) got = readLimit;
    for (size_t i = 0; i < got; ++i) dst[i] = (uint8_t)wire[pos++];
    return (int)got;
  }
};

constexpr char wire[] =
    "2\r\n\x01\x02\r\n"
    "5;test=yes\r\n\x00\x00\x00{}\r\n"
    "3\r\n\x02\x04\x00\r\n"
    "6\r\n\x00\x00\x10\x20\x30\x40\r\n"
    "0\r\nX-Debug: ok\r\n\r\n";

constexpr bool fragmentedFrames(size_t packet, size_t readLimit) {
  Clock clock;
  Client client{clock, wire, sizeof(wire) - 1};
  client.packet = packet;
  client.readLimit = readLimit;
  client.transientNegative = true;
  client.transientZero = true;
  ChunkedBodyDecoder decoder;
  uint8_t header[5] = {}, payload[4] = {};
  if (decoder.read(client, clock, header, 5) != 5 || header[0] != 1 || lambdaFrameLength(header) != 2) return false;
  if (decoder.read(client, clock, payload, 2) != 2 || payload[0] != '{' || payload[1] != '}') return false;
  if (decoder.read(client, clock, header, 5) != 5 || header[0] != 2 || lambdaFrameLength(header) != 4) return false;
  if (decoder.read(client, clock, payload, 4) != 4) return false;
  for (int i = 0; i < 4; ++i) if (payload[i] != (i + 1) * 0x10) return false;
  if (decoder.read(client, clock, payload, 1) != 0 || !decoder.done() || decoder.failed()) return false;
  return decoder.payloadBytes() == 16 && client.pos == sizeof(wire) - 1;
}
static_assert(fragmentedFrames(1, 1), "split every CR/LF, size digit, binary header and payload byte");
static_assert(fragmentedFrames(7, 2), "short reads across TCP and HTTP boundaries");
static_assert(fragmentedFrames(1000, 1000), "multiple HTTP chunks in one TCP packet");

constexpr bool rejects(const char* input, size_t size) {
  Clock clock;
  Client client{clock, input, size};
  ChunkedBodyDecoder decoder;
  uint8_t out[16] = {};
  decoder.read(client, clock, out, sizeof(out));
  size_t stop = client.pos;
  return decoder.failed() && !decoder.done() &&
         decoder.read(client, clock, out, sizeof(out)) == 0 && client.pos == stop;
}
static_assert(rejects("g\r\n", 3), "non-hex size must fail, not resynchronize");
static_assert(rejects("100000000\r\n", 11), "reject uint32 chunk-size overflow");
static_assert(rejects("1\r\nAX\n0\r\n\r\n", 12), "require CRLF after data");
static_assert(rejects("1\r\nA\rX0\r\n\r\n", 12), "require LF even when it arrives separately");
static_assert(rejects("2\r\nA", 4), "truncated payload must fail");
static_assert(rejects("1\r\nA\r\n0\r\n", 9), "zero chunk alone is not a complete trailer terminator");

constexpr bool idleTimeoutIsTerminal(uint32_t start = 0) {
  Clock clock;
  clock.tick = start;
  Client client{clock, "4\r\nAB", 5};
  client.holdOpen = true;
  ChunkedBodyDecoder decoder;
  uint8_t out[4] = {};
  if (decoder.read(client, clock, out, 4, 10) != 2 || !decoder.failed()) return false;
  // Later data must not be interpreted as a new binary header after failure.
  size_t stop = client.pos;
  return decoder.read(client, clock, out, 4, 10) == 0 && client.pos == stop;
}
static_assert(idleTimeoutIsTerminal(), "partial read cannot resume as the next frame");
static_assert(idleTimeoutIsTerminal(UINT32_MAX - 5), "idle timeout survives millis wraparound");

constexpr bool slowProgressSucceeds() {
  Clock clock;
  constexpr char data[] = "3\r\nABC\r\n0\r\n\r\n";
  Client client{clock, data, sizeof(data) - 1};
  client.spacing = 9;
  ChunkedBodyDecoder decoder;
  uint8_t out[4] = {};
  return decoder.read(client, clock, out, 4, 10) == 3 && decoder.done() &&
         !decoder.failed() && clock.tick > 10 && out[0] == 'A' && out[2] == 'C';
}
static_assert(slowProgressSucceeds(), "timeout resets on progress rather than truncating a slow frame");

constexpr bool cancelledAndReset() {
  Clock clock;
  clock.cancelAt = 5;
  Client client{clock, wire, sizeof(wire) - 1};
  ChunkedBodyDecoder decoder;
  uint8_t out[32] = {};
  decoder.read(client, clock, out, sizeof(out));
  if (!decoder.failed() || clock.tick != 5) return false;
  decoder.reset();
  clock.cancelAt = UINT32_MAX;
  Client next{clock, "1\r\nZ\r\n0\r\n\r\n", 11};
  next.packet = 100;
  return decoder.read(next, clock, out, sizeof(out)) == 1 && decoder.done() &&
         out[0] == 'Z' && decoder.payloadBytes() == 1;
}
static_assert(cancelledAndReset(), "cancellation is terminal and next response resets all state");

// -33161245 in the old signed log corresponds to this unsigned LE32 value.
constexpr uint8_t screenshotHeader[] = {0x02, 0xe3, 0xff, 0x05, 0xfe};
static_assert(lambdaFrameLength(screenshotHeader) == 4261806051U, "length decoding must use unsigned shifts");
static_assert(!validLambdaFrame(0x02, 4261806051U), "reject bogus multi-gigabyte PCM frames");
static_assert(!validLambdaFrame(0xce, 605166346U), "reject screenshot's unknown type without allocation");
static_assert(!validLambdaFrame(1, 4097) && !validLambdaFrame(1, 0), "metadata bounds");
static_assert(validLambdaFrame(1, 4096) && validLambdaFrame(2, 152874), "valid metadata/PCM accepted");

int main() {}
