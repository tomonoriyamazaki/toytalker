#!/bin/bash
# publish-firmware.sh — ファーム（toytalker_mini_v0.7）をビルドしてS3へ発行し、マニフェストのチャネルを更新する。
# 設計は docs/esp32-ota-settings-plan.md。Mac と Windows Git Bash の両方で動く（node と aws が要る）。
#
# 使い方（リポジトリルートから）:
#   bash devices/mcu/esp32_s3/tools/publish-firmware.sh beta              # ビルド → S3 → beta を新版に向ける
#   bash devices/mcu/esp32_s3/tools/publish-firmware.sh stable --promote  # beta が指す版を stable にも向ける（ビルドなし）
#   bash devices/mcu/esp32_s3/tools/publish-firmware.sh beta --dry-run    # ビルドとSHA-256計算だけ。S3には触らない
#   bash devices/mcu/esp32_s3/tools/publish-firmware.sh beta --no-build   # 前回のビルド成果物をそのまま発行
#   --force を付けると同じ版のS3オブジェクトとgitタグを上書きする（既定では拒否。版は不変にする）
#   --allow-dirty を付けると未コミットの変更があっても発行する（タグは付けない。実機の一時試験用）
#
# 運用は「1フォルダ + gitタグ」。フォルダには最新のソースだけを置き、配布するときは FirmwareVersion.h の
# TOYTALKER_FW_VERSION を上げてコミットしてから発行する。発行に成功するとコミットにタグ fw-<版> を付けるので、
# その版のソースへ戻すのは `git checkout fw-<版> -- devices/mcu/esp32_s3/toytalker_mini_v0.7` の1コマンド。
set -euo pipefail

BUCKET="toytalker-firmware"
REGION="ap-northeast-1"
BOARD="esp32s3"
SKETCH_DIR="${SKETCH_DIR:-devices/mcu/esp32_s3/toytalker_mini_v0.7}"
FQBN="esp32:esp32:esp32s3:PSRAM=enabled,FlashSize=4M,PartitionScheme=no_fs,CDCOnBoot=cdc"   # sketch.yaml の default_fqbn と同じ
BUILD_DIR="${TMPDIR:-/tmp}/toytalker_publish_build"

cd "$(dirname "$0")/../../../.."   # リポジトリルート

CHANNEL="${1:-}"
shift || true
DRY_RUN=0; NO_BUILD=0; PROMOTE=0; FORCE=0; ALLOW_DIRTY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-build) NO_BUILD=1 ;;
    --promote) PROMOTE=1 ;;
    --force) FORCE=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
if [[ "$CHANNEL" != "beta" && "$CHANNEL" != "stable" ]]; then
  echo "usage: $0 <beta|stable> [--dry-run] [--no-build] [--promote] [--force] [--allow-dirty]" >&2
  exit 2
fi

MANIFEST_KEY="$BOARD/manifest.json"
MANIFEST_LOCAL="$BUILD_DIR/manifest.json"
mkdir -p "$BUILD_DIR"

fetch_manifest() {
  if aws s3 cp "s3://$BUCKET/$MANIFEST_KEY" "$MANIFEST_LOCAL" --region "$REGION" >/dev/null 2>&1; then
    echo "📄 manifest fetched"
  else
    echo "📄 manifest not found in S3; starting a new one"
    echo '{}' > "$MANIFEST_LOCAL"
  fi
}

# node でマニフェストを書き換える（jq は Windows に無いことがある）
update_manifest() {  # mode channel version key sha256 size
  node -e '
    const fs = require("fs");
    const [file, mode, channel, version, key, sha256, size] = process.argv.slice(1);
    let m = {};
    try { m = JSON.parse(fs.readFileSync(file, "utf8")); } catch {}
    m.versions = m.versions || {};
    m.channels = m.channels || {};
    if (mode === "promote") {
      const from = m.channels.beta;
      if (!from || !m.versions[from]) throw new Error("beta channel has no published version to promote");
      m.channels[channel] = from;
    } else {
      m.versions[version] = { key, sha256, size: Number(size), published_at: new Date().toISOString() };
      m.channels[channel] = version;
    }
    m.updated_at = new Date().toISOString();
    fs.writeFileSync(file, JSON.stringify(m, null, 2) + "\n");
    console.log(JSON.stringify({ channels: m.channels }, null, 2));
  ' "$MANIFEST_LOCAL" "$@"
}

if [[ $PROMOTE -eq 1 ]]; then
  [[ "$CHANNEL" == "stable" ]] || { echo "--promote は stable にだけ使う" >&2; exit 2; }
  fetch_manifest
  update_manifest promote "$CHANNEL" "" "" "" ""
  if [[ $DRY_RUN -eq 1 ]]; then echo "(dry-run) manifest not uploaded"; exit 0; fi
  aws s3 cp "$MANIFEST_LOCAL" "s3://$BUCKET/$MANIFEST_KEY" --region "$REGION" --content-type application/json >/dev/null
  echo "✅ stable promoted"
  exit 0
fi

VERSION="$(sed -n 's/^#define TOYTALKER_FW_VERSION "\([^"]*\)".*/\1/p' "$SKETCH_DIR/FirmwareVersion.h")"
if [[ -z "$VERSION" || ! "$VERSION" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "TOYTALKER_FW_VERSION を FirmwareVersion.h から読めない: '$VERSION'" >&2
  exit 1
fi
SKETCH_NAME="$(basename "$SKETCH_DIR")"
BIN="$BUILD_DIR/$SKETCH_NAME.ino.bin"
TAG="fw-$VERSION"

# 発行した版のソースをタグで残すため、フォルダの未コミット変更は拒否する（--allow-dirty で試験発行は可、タグなし）
DIRTY="$(git status --porcelain -- "$SKETCH_DIR" 2>/dev/null || true)"
if [[ -n "$DIRTY" && $ALLOW_DIRTY -eq 0 && $DRY_RUN -eq 0 ]]; then
  echo "❌ $SKETCH_DIR に未コミットの変更がある。コミットしてから発行する（試験なら --allow-dirty）" >&2
  echo "$DIRTY" >&2
  exit 1
fi
if [[ $DRY_RUN -eq 0 && $ALLOW_DIRTY -eq 0 && $FORCE -eq 0 ]] && git rev-parse -q --verify "refs/tags/$TAG" >/dev/null 2>&1; then
  echo "❌ gitタグ $TAG が既にある。版を上げるか --force を付ける" >&2
  exit 1
fi
KEY="$BOARD/$VERSION/toytalker_mini.bin"
echo "🔖 version=$VERSION channel=$CHANNEL key=$KEY"

if [[ $NO_BUILD -eq 0 ]]; then
  echo "🔨 building $SKETCH_DIR ($FQBN)..."
  arduino-cli compile --fqbn "$FQBN" --build-path "$BUILD_DIR" "$SKETCH_DIR" \
    | grep -E 'Sketch uses|Global variables' || true
fi
[[ -f "$BIN" ]] || { echo "binary not found: $BIN" >&2; exit 1; }

if command -v sha256sum >/dev/null 2>&1; then
  SHA="$(sha256sum "$BIN" | cut -d' ' -f1)"
else
  SHA="$(shasum -a 256 "$BIN" | cut -d' ' -f1)"
fi
SIZE="$(wc -c < "$BIN" | tr -d ' ')"
echo "📦 size=$SIZE sha256=$SHA"

if [[ $DRY_RUN -eq 1 ]]; then
  echo "(dry-run) S3 not touched"
  exit 0
fi

if aws s3api head-object --bucket "$BUCKET" --key "$KEY" --region "$REGION" >/dev/null 2>&1; then
  if [[ $FORCE -eq 0 ]]; then
    echo "❌ $KEY は既にS3にある。版を上げるか --force を付ける" >&2
    exit 1
  fi
  echo "⚠️ overwriting existing $KEY (--force)"
fi

aws s3 cp "$BIN" "s3://$BUCKET/$KEY" --region "$REGION" --content-type application/octet-stream \
  --metadata "sha256=$SHA,fw-version=$VERSION" >/dev/null
echo "☁️ uploaded s3://$BUCKET/$KEY"

fetch_manifest
update_manifest publish "$CHANNEL" "$VERSION" "$KEY" "$SHA" "$SIZE"
aws s3 cp "$MANIFEST_LOCAL" "s3://$BUCKET/$MANIFEST_KEY" --region "$REGION" --content-type application/json >/dev/null
echo "✅ published $VERSION to $CHANNEL"

if [[ -n "$DIRTY" ]]; then
  echo "⚠️ 未コミットの変更を含む発行なのでタグ $TAG は付けない"
else
  git tag -f "$TAG" -m "firmware $VERSION published to $CHANNEL (sha256 $SHA)" >/dev/null
  echo "🏷️ tagged $TAG (push with: git push origin $TAG)"
fi
