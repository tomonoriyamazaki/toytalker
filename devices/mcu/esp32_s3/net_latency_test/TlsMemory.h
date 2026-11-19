#pragma once
#include <Arduino.h>
#include <esp_heap_caps.h>
#include <esp_memory_utils.h>
#include <mbedtls/platform.h>

// Set once, before any HTTPS/WSS connection. Applies to all mbedTLS users.
// No internal fallback: TLS must not consume the RAM needed by DMA and tasks.
constexpr bool TLS_PSRAM_ENABLED = true;

namespace tls_memory {
static portMUX_TYPE statsMux = portMUX_INITIALIZER_UNLOCKED;
static uint32_t calls = 0, failures = 0;
static size_t largestRequest = 0;
static bool installed = false;

inline void* allocate(size_t count, size_t size) {
  if (count == 0 || size == 0) return nullptr;
  const bool overflow = count > SIZE_MAX / size;
  const size_t bytes = overflow ? SIZE_MAX : count * size;
  void* result = overflow ? nullptr : heap_caps_calloc(count, size, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
  // No allocation or logging inside the critical section. Hooks run in tasks.
  portENTER_CRITICAL(&statsMux);
  ++calls;
  if (!result) ++failures;
  if (bytes > largestRequest) largestRequest = bytes;
  portEXIT_CRITICAL(&statsMux);
  return result;
}

inline void release(void* ptr) {
  // Also accepts nullptr and any allocation made by the original heap allocator.
  heap_caps_free(ptr);
}

inline void printStats(const char* stage) {
  uint32_t count, failed;
  size_t largest;
  portENTER_CRITICAL(&statsMux);
  count = calls; failed = failures; largest = largestRequest;
  portEXIT_CRITICAL(&statsMux);
  Serial.printf("[TLS_MEM] stage=%s psram=%d calls=%lu fail=%lu largest_req=%u psram_free=%u psram_max_blk=%u\n",
                stage, installed, (unsigned long)count, (unsigned long)failed, (unsigned)largest,
                (unsigned)heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT),
                (unsigned)heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
}

inline bool init() {
  if (installed) return true;
  if (!TLS_PSRAM_ENABLED) {
    Serial.println("[TLS_MEM] allocator=core_default (comparison mode)");
    return true;
  }
  if (!psramFound()) {
    Serial.println("[TLS_MEM] PSRAM unavailable; check board PSRAM setting");
    return false;
  }
  const int rc = mbedtls_platform_set_calloc_free(allocate, release);
  if (rc != 0) {
    Serial.printf("[TLS_MEM] allocator installation failed rc=%d\n", rc);
    return false;
  }
  // Exercise mbedTLS's public allocator, not just our helper. Freed before WiFi/AEC.
  constexpr size_t probeBytes = 20000;
  auto* probe = static_cast<uint8_t*>(mbedtls_calloc(1, probeBytes));
  const bool external = probe && esp_ptr_external_ram(probe);
  bool zeroed = probe != nullptr;
  if (probe) for (size_t i = 0; i < probeBytes; ++i) zeroed &= probe[i] == 0;
  mbedtls_free(probe);
  installed = external && zeroed;
  Serial.printf("[TLS_MEM] allocator=psram ready=%d probe_bytes=%u external=%d zeroed=%d\n",
                installed, (unsigned)probeBytes, external, zeroed);
  return installed;
}
} // namespace tls_memory
