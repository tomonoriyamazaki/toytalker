#!/bin/bash
# firmware-family.sh — 基板の系統（同じ .bin が動く基板のまとまり）ごとの、ソースの場所と S3 の置き場。
# publish-firmware.sh と flash-published.sh が source して使う。系統を足すときはここに 1 つ足し、
# 一時キー Lambda（backend/toytalk-soniox-stt-lambda/index.mjs の FIRMWARE_FAMILIES）にも同じ置き場を足す。
#
#   mini    ESP32-S3-MINI-1（基板 v0.2・v0.3）。ファーム 0.7.x
#   wroom1  ESP32-S3-WROOM-1-N16R8（基板 v0.4 以降）。ファーム 0.8.0 以降
#
# 系統が違う .bin は動かない（PSRAM の方式とピンが違う）。ソース・ビルド設定・S3 の置き場を系統の名前 1 つで
# まとめて決めるのは、別の系統の置き場へ発行する取り違えを起こさないため。

# family_config <系統> — BOARD（S3 の置き場）・SKETCH_DIR・BIN_NAME・FQBN を決める。リポジトリルートで呼ぶ
family_config() {
  case "$1" in
    mini)   BOARD="esp32s3";        SKETCH_DIR="devices/mcu/esp32_s3/toytalker_mini_v0.7"; BIN_NAME="toytalker_mini.bin" ;;
    wroom1) BOARD="esp32s3-wroom1"; SKETCH_DIR="devices/mcu/esp32_s3/toytalker";           BIN_NAME="toytalker.bin" ;;
    *) echo "❌ 知らない系統: '$1'（mini か wroom1）" >&2; return 2 ;;
  esac
  [[ -d "$SKETCH_DIR" ]] || { echo "❌ $1 のソースが無い: $SKETCH_DIR" >&2; return 1; }
  # ビルド設定はスケッチの sketch.yaml が正（Arduino IDE と同じ設定でビルドする）
  FQBN="$(sed -n 's/^default_fqbn:[[:space:]]*//p' "$SKETCH_DIR/sketch.yaml" 2>/dev/null | tr -d '\r' | head -1)"
  [[ "$FQBN" == esp32:esp32:* ]] || { echo "❌ $SKETCH_DIR/sketch.yaml から default_fqbn を読めない: '$FQBN'" >&2; return 1; }
}

# family_check_version <系統> <版> — 版の番号が系統と合っているか。0.7 以前は mini、0.8.0 以降は wroom1。
# ログや devices の行には版しか残らないので、番号だけで系統が分かるようにしておく
family_check_version() {
  local is_mini=0
  [[ "$2" =~ ^0\.[0-7]\. ]] && is_mini=1
  if [[ "$1" == "mini" && $is_mini -eq 0 ]] || [[ "$1" != "mini" && $is_mini -eq 1 ]]; then
    echo "❌ 版 $2 は系統 $1 の番号ではない（0.7 以前は mini、0.8.0 以降は wroom1）" >&2
    return 1
  fi
}
