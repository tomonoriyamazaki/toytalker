#pragma once
#include <stddef.h>
#include <stdint.h>

// HTTP chunk framing only. The caller copies payload in blocks, and feeds framing
// bytes individually. State survives arbitrary TCP/TLS packet and caller boundaries.
// No allocation and no dependency on Arduino, so wire-format regressions can be tested.
class ChunkedBodyDecoder {
 public:
  enum class State { Size, Extension, SizeLf, Data, DataCr, DataLf,
                     Trailer, TrailerLf, Done, Error };
  constexpr void reset() { *this = ChunkedBodyDecoder{}; }
  constexpr bool done() const { return state_ == State::Done; }
  constexpr bool failed() const { return state_ == State::Error; }
  constexpr uint32_t remaining() const { return state_ == State::Data ? size_ : 0; }
  constexpr uint32_t payloadBytes() const { return payloadBytes_; }
  constexpr const char* error() const { return error_; }
  constexpr void fail(const char* reason = "chunk_framing") { state_ = State::Error; error_ = reason; }

  // Runtime supplies now(), idle() and cancelled(). All successful reads use the
  // bulk read API (including a one-byte framing read); never cast a negative read
  // result to size_t. Timeout measures lack of progress, not total frame duration.
  template <typename Client, typename Runtime>
  constexpr size_t read(Client& client, Runtime& runtime, uint8_t* out, size_t length,
                        uint32_t idleTimeoutMs = 10000) {
    size_t copied = 0;
    uint32_t lastProgress = runtime.now();
    while (copied < length && !done() && !failed()) {
      if (runtime.cancelled()) { fail("cancelled"); break; }
      if (uint32_t(runtime.now() - lastProgress) >= idleTimeoutMs) { fail("idle_timeout"); break; }
      int available = client.available();
      if (available <= 0) {
        if (!client.connected()) { fail("connection_closed"); break; }
        runtime.idle();
        continue;
      }
      uint8_t framingByte = 0;
      size_t wanted = remaining() ? length - copied : 1;
      if (remaining() && wanted > remaining()) wanted = remaining();
      if (wanted > (size_t)available) wanted = (size_t)available;
      int got = client.read(remaining() ? out + copied : &framingByte, wanted);
      if (got <= 0) { runtime.idle(); continue; }
      if ((size_t)got > wanted) { fail("invalid_read_count"); break; }
      lastProgress = runtime.now();
      if (remaining()) {
        copied += got;
        payloadBytes_ += got;
        consumeData(got);
      } else {
        framing(framingByte);
      }
    }
    return copied;
  }

  constexpr bool consumeData(size_t count) {
    if (state_ != State::Data || count > size_) { fail(); return false; }
    size_ -= count;
    if (size_ == 0) state_ = State::DataCr;
    return true;
  }

  constexpr bool framing(uint8_t c) {
    switch (state_) {
      case State::Size: {
        if (++lineBytes_ > 256) break;
        int digit = hex(c);
        if (digit >= 0) {
          if (size_ > (UINT32_MAX - (uint32_t)digit) / 16) break;
          size_ = size_ * 16 + digit;
          haveDigit_ = true;
          return true;
        }
        if (!haveDigit_) break;
        if (c == ';' || c == ' ' || c == '\t') { state_ = State::Extension; return true; }
        if (c == '\r') { state_ = State::SizeLf; return true; }
        break;
      }
      case State::Extension:
        if (++lineBytes_ > 256) break;
        if (c == '\r') { state_ = State::SizeLf; return true; }
        if (c == '\t' || (c >= 0x20 && c != 0x7f)) return true;
        break;
      case State::SizeLf:
        if (c != '\n') break;
        state_ = size_ ? State::Data : State::Trailer;
        lineBytes_ = 0;
        return true;
      case State::DataCr:
        if (c != '\r') break;
        state_ = State::DataLf;
        return true;
      case State::DataLf:
        if (c != '\n') break;
        state_ = State::Size;
        size_ = 0;
        lineBytes_ = 0;
        haveDigit_ = false;
        return true;
      case State::Trailer:
        if (++trailerBytes_ > 4096) break;
        if (c == '\r') { state_ = State::TrailerLf; return true; }
        if (c == '\t' || (c >= 0x20 && c != 0x7f)) { ++lineBytes_; return true; }
        break;
      case State::TrailerLf:
        if (++trailerBytes_ > 4096 || c != '\n') break;
        state_ = lineBytes_ == 0 ? State::Done : State::Trailer;
        lineBytes_ = 0;
        return true;
      default:
        break;
    }
    fail();
    return false;
  }

 private:
  static constexpr int hex(uint8_t c) {
    return c >= '0' && c <= '9' ? c - '0' :
           c >= 'a' && c <= 'f' ? c - 'a' + 10 :
           c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
  }
  State state_ = State::Size;
  uint32_t size_ = 0;
  uint16_t lineBytes_ = 0, trailerBytes_ = 0;
  bool haveDigit_ = false;
  uint32_t payloadBytes_ = 0;
  const char* error_ = "none";
};

// ToyTalker binary envelope: one type byte followed by an unsigned LE32 length.
constexpr uint32_t lambdaFrameLength(const uint8_t* header) {
  return uint32_t(header[1]) | (uint32_t(header[2]) << 8) |
         (uint32_t(header[3]) << 16) | (uint32_t(header[4]) << 24);
}

constexpr bool validLambdaFrame(uint8_t type, uint32_t length) {
  // PCM is streamed through a small buffer; this is a sanity limit per frame,
  // not an allocation size. 16 MiB allows over five minutes of 24 kHz mono PCM.
  return type == 0x01 ? length > 0 && length <= 4096 :
         type == 0x02 && length <= 16U * 1024 * 1024;
}
