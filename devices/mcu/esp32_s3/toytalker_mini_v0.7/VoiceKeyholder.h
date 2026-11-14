#pragma once
// ボイスキーホルダーモードの音声の入れ物（voices 区画）と、ADPCM の展開、鳴らす順番。
// 再生そのもの（I2S・アンプ・ボタン）は .ino 側。ここは通信もマイクも使わない。
//
// 入れ物の形（リトルエンディアン。作るのは devices/mcu/esp32_s3/tools/make-voices.mjs）:
//    0  "TTVK"
//    4  版（1）      5  件数      6-7  予約（0）
//    8  全体のバイト数（先頭から最後の音声の終わりまで）
//   12  CRC32（16 バイト目から全体の終わりまで。zlib と同じ計算）
//   16  件数 × 16 バイトの表:
//         位置 u32（区画の先頭から）、長さ u32（バイト）、形式 u8、予約 u8、サンプルレート u16、サンプル数 u32
//   以降 音声
// 形式 1 = IMA ADPCM（4bit・モノラル・ブロックなし。予測値 0・段 0 から始め、1 バイトに下位 → 上位の順で 2 サンプル）。
// 24kHz で 1 秒 12KB。形式の欄があるので、後から別の形式（mp3 など）を足せる。知らない形式の件は飛ばす。
#include <Arduino.h>
#include <esp_partition.h>
#include <esp_random.h>

namespace voicekey {

constexpr uint8_t FORMAT_VERSION = 1;
constexpr uint8_t CODEC_ADPCM = 1;
constexpr size_t MAX_CLIPS = 16;
constexpr size_t HEADER_BYTES = 16;
constexpr size_t ENTRY_BYTES = 16;

struct Clip {
  const uint8_t* data = nullptr;
  uint32_t bytes = 0;
  uint32_t samples = 0;
};

inline uint32_t readU32(const uint8_t* p) {
  return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
}

// zlib と同じ CRC32（4bit ずつの表引き）
inline uint32_t crc32(const uint8_t* data, size_t len) {
  static const uint32_t TABLE[16] = {
    0x00000000, 0x1DB71064, 0x3B6E20C8, 0x26D930AC, 0x76DC4190, 0x6B6B51F4, 0x4DB26158, 0x5005713C,
    0xEDB88320, 0xF00F9344, 0xD6D6A3E8, 0xCB61B38C, 0x9B64C2B0, 0x86D3D2D4, 0xA00AE278, 0xBDBDF21C};
  uint32_t crc = 0xFFFFFFFF;
  for (size_t i = 0; i < len; i++) {
    crc ^= data[i];
    crc = TABLE[crc & 0x0F] ^ (crc >> 4);
    crc = TABLE[crc & 0x0F] ^ (crc >> 4);
  }
  return ~crc;
}

// voices 区画を読む。区画はメモリに割り付けたままにする（再生中にフラッシュの読み出し命令を出さないため）
class Store {
  Clip clips_[MAX_CLIPS];
  size_t count_ = 0;
  bool tried_ = false;
  const char* error_ = "not loaded";

 public:
  size_t count() const { return count_; }
  const Clip& clip(size_t i) const { return clips_[i]; }
  const char* error() const { return error_; }

  // 鳴らせる件が1つでもあれば true。2回目以降は前の結果を返す
  bool begin(uint16_t sampleRate) {
    if (tried_) return count_ > 0;
    tried_ = true;
    const esp_partition_t* part =
      esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_ANY, "voices");
    if (!part) { error_ = "no voices partition (old partition table)"; return false; }
    const void* mapped = nullptr;
    esp_partition_mmap_handle_t handle = 0;
    if (esp_partition_mmap(part, 0, part->size, ESP_PARTITION_MMAP_DATA, &mapped, &handle) != ESP_OK) {
      error_ = "mmap failed";
      return false;
    }
    const uint8_t* base = static_cast<const uint8_t*>(mapped);
    if (memcmp(base, "TTVK", 4) != 0) { error_ = "empty (no TTVK header)"; return false; }
    if (base[4] != FORMAT_VERSION) { error_ = "unknown format version"; return false; }
    const size_t n = base[5];
    const uint32_t total = readU32(base + 8);
    if (n == 0 || n > MAX_CLIPS || total > part->size || total < HEADER_BYTES + n * ENTRY_BYTES) {
      error_ = "bad header";
      return false;
    }
    if (crc32(base + HEADER_BYTES, total - HEADER_BYTES) != readU32(base + 12)) { error_ = "crc mismatch"; return false; }
    for (size_t i = 0; i < n; i++) {
      const uint8_t* e = base + HEADER_BYTES + i * ENTRY_BYTES;
      const uint32_t offset = readU32(e), bytes = readU32(e + 4), samples = readU32(e + 12);
      const uint8_t codec = e[8];
      const uint16_t rate = (uint16_t)(e[10] | (e[11] << 8));
      // 形式・レートが合わない件、表の外を指す件、サンプル数が長さと合わない件は鳴らさない
      if (codec != CODEC_ADPCM || rate != sampleRate) continue;
      if (offset < HEADER_BYTES + n * ENTRY_BYTES || bytes == 0 || offset > total || bytes > total - offset) continue;
      if (samples == 0 || samples > bytes * 2) continue;
      clips_[count_].data = base + offset;
      clips_[count_].bytes = bytes;
      clips_[count_].samples = samples;
      count_++;
    }
    error_ = count_ > 0 ? "" : "no playable clip";
    return count_ > 0;
  }
};

// IMA ADPCM の展開。make-voices.mjs の圧縮と同じ表・同じ計算
class AdpcmDecoder {
  int32_t predicted_ = 0;
  int index_ = 0;

 public:
  int16_t step(uint8_t nibble) {
    static const int16_t STEPS[89] = {
      7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107,
      118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963,
      1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894,
      6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794,
      32767};
    static const int8_t INDEX_MOVES[8] = {-1, -1, -1, -1, 2, 4, 6, 8};
    const int32_t s = STEPS[index_];
    int32_t diff = s >> 3;
    if (nibble & 1) diff += s >> 2;
    if (nibble & 2) diff += s >> 1;
    if (nibble & 4) diff += s;
    predicted_ += (nibble & 8) ? -diff : diff;
    if (predicted_ > 32767) predicted_ = 32767;
    else if (predicted_ < -32768) predicted_ = -32768;
    index_ += INDEX_MOVES[nibble & 7];
    if (index_ < 0) index_ = 0;
    else if (index_ > 88) index_ = 88;
    return (int16_t)predicted_;
  }
  // clip の from 番目から n サンプルを out へ。前から順に呼ぶ
  void decode(const Clip& clip, uint32_t from, uint32_t n, int16_t* out) {
    for (uint32_t i = 0; i < n; i++) {
      const uint32_t k = from + i;
      const uint8_t b = clip.data[k >> 1];
      out[i] = step((k & 1) ? (b >> 4) : (b & 0x0F));
    }
  }
};

// 鳴らす順番。一巡するまで同じ件を出さず、巡の変わり目でも同じ件を続けない
class Shuffle {
  uint8_t order_[MAX_CLIPS];
  size_t count_ = 0, pos_ = 0;
  int last_ = -1;

  void mix() {
    for (size_t i = count_; i > 1; i--) {
      const size_t j = esp_random() % i;
      const uint8_t t = order_[i - 1];
      order_[i - 1] = order_[j];
      order_[j] = t;
    }
    if (count_ > 1 && order_[0] == last_) {  // 前の巡の最後と同じなら、後ろのどれかと入れ替える
      const size_t j = 1 + esp_random() % (count_ - 1);
      const uint8_t t = order_[0];
      order_[0] = order_[j];
      order_[j] = t;
    }
    pos_ = 0;
  }

 public:
  void begin(size_t count) {
    count_ = count > MAX_CLIPS ? MAX_CLIPS : count;
    for (size_t i = 0; i < count_; i++) order_[i] = (uint8_t)i;
    last_ = -1;
    mix();
  }
  size_t next() {
    if (pos_ >= count_) mix();
    last_ = order_[pos_++];
    return (size_t)last_;
  }
};

}  // namespace voicekey
