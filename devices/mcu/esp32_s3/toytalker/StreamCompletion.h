#pragma once
#include <stddef.h>

// Only called between fully consumed binary frames. A transport close after
// application completion must not discard audio already queued for playback.
class StreamCompletion {
 public:
  constexpr void reset() { done_ = false; error_ = false; }
  constexpr void metadata(const char* event) {
    if (equal(event, "done")) done_ = true;
    if (equal(event, "error")) error_ = true;
    if (equal(event, "segment") || equal(event, "tts_start")) done_ = false;
  }
  constexpr void pcmStarted() { done_ = false; }
  constexpr bool doneSeen() const { return done_; }
  constexpr bool errorSeen() const { return error_; }
  constexpr bool canDrainAfterClose(size_t headerBytes, const char* reason, bool interrupted) const {
    return done_ && !error_ && !interrupted && headerBytes == 0 &&
           equal(reason, "connection_closed");
  }
 private:
  static constexpr bool equal(const char* a, const char* b) {
    while (*a && *a == *b) { ++a; ++b; }
    return *a == *b;
  }
  bool done_ = false;
  bool error_ = false;
};
