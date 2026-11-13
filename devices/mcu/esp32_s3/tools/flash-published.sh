#!/bin/bash
# flash-published.sh — S3 に発行済みの版（試験機で確かめた .bin そのもの）を USB で本体に書く。
# 配布機（OTA 非対応の旧ファーム）を USB で書き換えるときに使う。Mac と Windows Git Bash の両方で動く
# （arduino-cli・node・aws が要る。aws は S3 を読めるプロファイルで。例: AWS_PROFILE=toytalker-rnd）。
#
# 使い方（リポジトリルートから）:
#   bash devices/mcu/esp32_s3/tools/flash-published.sh 0.7.20                      # ポートは自動（Mac の /dev/cu.usbmodem*）
#   bash devices/mcu/esp32_s3/tools/flash-published.sh 0.7.20 /dev/cu.usbmodem101  # ポートを指定（Windows は COM12 など）
#   bash devices/mcu/esp32_s3/tools/flash-published.sh 0.7.20 --dry-run            # 取得と照合まで。本体には触らない
#
# 版は必ず番号で指定する（beta は試験版を指していることがあるので、チャネル名では書かない）。
#
# 何をするか:
#   1. 手元でビルドする。ここで使うのは bootloader・パーティション表・boot_app0 だけ（コアとボード設定で決まる）。
#   2. アプリ本体は手元のビルドを使わず、S3 の .bin を取ってマニフェストの SHA-256・サイズと照合し、差し替える。
#      （手元のビルドはライブラリの版や OS の違いで試験機と同じ中身になる保証がない）
#   3. arduino-cli upload で4つまとめて書く。NVS（Wi-Fi 設定・デバイス鍵・音量）は消さない。
set -euo pipefail

BUCKET="toytalker-firmware"
REGION="ap-northeast-1"
BOARD="esp32s3"
SKETCH_DIR="${SKETCH_DIR:-devices/mcu/esp32_s3/toytalker_mini_v0.7}"
SKETCH_NAME="$(basename "$SKETCH_DIR")"
FQBN="esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=4M,PartitionScheme=no_fs,CDCOnBoot=cdc"   # sketch.yaml の default_fqbn と同じ
BUILD_DIR="${TMPDIR:-/tmp}/toytalker_flash_build"
if command -v cygpath >/dev/null 2>&1; then BUILD_DIR="$(cygpath -m "$BUILD_DIR")"; fi

cd "$(dirname "$0")/../../../.."   # リポジトリルート

VERSION=""; PORT=""; DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    -*) echo "unknown option: $arg" >&2; exit 2 ;;
    *) if [[ -z "$VERSION" ]]; then VERSION="$arg"; elif [[ -z "$PORT" ]]; then PORT="$arg"; else echo "too many arguments" >&2; exit 2; fi ;;
  esac
done
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "usage: $0 <版 例 0.7.20> [ポート] [--dry-run]" >&2
  exit 2
fi
for tool in arduino-cli node aws; do
  command -v "$tool" >/dev/null 2>&1 || { echo "❌ $tool が PATH に無い" >&2; exit 1; }
done

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

mkdir -p "$BUILD_DIR"
MANIFEST="$BUILD_DIR/manifest.json"
aws s3 cp "s3://$BUCKET/$BOARD/manifest.json" "$MANIFEST" --region "$REGION" >/dev/null \
  || { echo "❌ マニフェストを取れない（aws sso login を確認）" >&2; exit 1; }
ENTRY="$(node -e '
  const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  const e = (m.versions || {})[process.argv[2]];
  if (!e) { console.error("版 " + process.argv[2] + " はマニフェストに無い。ある版: " + Object.keys(m.versions || {}).join(", ")); process.exit(1); }
  console.log([e.key, e.sha256, e.size, JSON.stringify(m.channels || {})].join(" "));
' "$MANIFEST" "$VERSION")" || exit 1
read -r KEY SHA SIZE CHANNELS <<< "$ENTRY"
echo "🔖 version=$VERSION key=$KEY channels=$CHANNELS"

echo "🔨 building (bootloader・パーティション表のため)..."
BUILD_LOG="$(arduino-cli compile --fqbn "$FQBN" --build-path "$BUILD_DIR" "$SKETCH_DIR" 2>&1)" \
  || { echo "$BUILD_LOG" | tail -20 >&2; echo "❌ ビルド失敗" >&2; exit 1; }
APP_BIN="$BUILD_DIR/$SKETCH_NAME.ino.bin"
for f in "$APP_BIN" "$BUILD_DIR/$SKETCH_NAME.ino.bootloader.bin" "$BUILD_DIR/$SKETCH_NAME.ino.partitions.bin"; do
  [[ -f "$f" ]] || { echo "❌ ビルド成果物が無い: $f" >&2; exit 1; }
done

echo "☁️ S3 の .bin を取って照合..."
DOWNLOADED="$BUILD_DIR/published.bin"
rm -f "$DOWNLOADED"
aws s3 cp "s3://$BUCKET/$KEY" "$DOWNLOADED" --region "$REGION" >/dev/null \
  || { echo "❌ s3://$BUCKET/$KEY を取れない" >&2; exit 1; }
GOT_SHA="$(sha256_of "$DOWNLOADED")"
GOT_SIZE="$(wc -c < "$DOWNLOADED" | tr -d ' ')"
if [[ "$GOT_SHA" != "$SHA" || "$GOT_SIZE" != "$SIZE" ]]; then
  echo "❌ S3 の .bin がマニフェストと違う（期待 sha256=$SHA size=$SIZE / 実際 sha256=$GOT_SHA size=$GOT_SIZE）" >&2
  exit 1
fi
grep -a -q "\"fw\":\"$VERSION\"" "$DOWNLOADED" \
  || { echo "❌ .bin の中に \"fw\":\"$VERSION\" が無い（別の版の中身）" >&2; exit 1; }
cp "$DOWNLOADED" "$APP_BIN"
rm -f "$BUILD_DIR/$SKETCH_NAME.ino.merged.bin"   # 手元のビルドを含む結合ファイルは使わせない
echo "✅ 書くのは発行済みの $VERSION（sha256=$SHA size=$SIZE）"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "🧪 --dry-run: 本体には書かない"
  exit 0
fi

if [[ -z "$PORT" ]]; then
  PORTS=(/dev/cu.usbmodem*)
  if [[ ${#PORTS[@]} -ne 1 || ! -e "${PORTS[0]}" ]]; then
    echo "❌ ポートを自動で決められない。arduino-cli board list で確かめて、引数で渡す" >&2
    arduino-cli board list >&2 || true
    exit 1
  fi
  PORT="${PORTS[0]}"
fi
echo "🔌 writing to $PORT ..."
arduino-cli upload -p "$PORT" --fqbn "$FQBN" --input-dir "$BUILD_DIR" "$SKETCH_DIR"
echo "✅ 書き込み完了。本体は自動で再起動する。確かめること:"
echo "   - シリアルの [BUILD] fw=$VERSION"
echo "   - Wi-Fi につながるか（つながらなければ BLE 設定へ入る＝LED が速い点滅）"
echo "   - サーバーのログ: 鍵発行の fw=$VERSION と device_key=enrolled（2回目以降は match）"
