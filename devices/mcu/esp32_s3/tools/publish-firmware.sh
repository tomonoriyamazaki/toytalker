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
#   bash devices/mcu/esp32_s3/tools/publish-firmware.sh beta --verify     # 照合だけ。チャネルが指す版の .bin を S3 から取り直し、マニフェストの SHA-256・サイズと比べる
#
# 発行と --promote の最後にも同じ照合をする（2026-11-13）。食い違ったまま配ると全機が sha256 で弾くので、発行した時点で止める。
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
# Windows（Git Bash）では arduino-cli.exe とこのスクリプトが同じ場所を指すよう、C:/... の形にそろえる。
# MSYS_NO_PATHCONV=1 で /tmp のまま渡すと exe 側は C:\tmp に書き、ここは古い .bin を読んで別の版の中身を発行してしまう（2026-11-08 に 0.7.6 の名前で 0.7.5 を発行した）
if command -v cygpath >/dev/null 2>&1; then BUILD_DIR="$(cygpath -m "$BUILD_DIR")"; fi

cd "$(dirname "$0")/../../../.."   # リポジトリルート

CHANNEL="${1:-}"
shift || true
DRY_RUN=0; NO_BUILD=0; PROMOTE=0; FORCE=0; ALLOW_DIRTY=0; VERIFY_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --no-build) NO_BUILD=1 ;;
    --promote) PROMOTE=1 ;;
    --force) FORCE=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --verify) VERIFY_ONLY=1 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done
if [[ "$CHANNEL" != "beta" && "$CHANNEL" != "stable" ]]; then
  echo "usage: $0 <beta|stable> [--dry-run] [--no-build] [--promote] [--force] [--allow-dirty] [--verify]" >&2
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

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# S3 の .bin を取り直して、期待する SHA-256・サイズと比べる。違えば 1 を返す
check_object() {  # key sha256 size
  local tmp="$BUILD_DIR/verify.bin" got_sha got_size
  rm -f "$tmp"
  aws s3 cp "s3://$BUCKET/$1" "$tmp" --region "$REGION" >/dev/null \
    || { echo "❌ 照合: s3://$BUCKET/$1 を取れない" >&2; return 1; }
  got_sha="$(sha256_of "$tmp")"
  got_size="$(wc -c < "$tmp" | tr -d ' ')"
  rm -f "$tmp"
  if [[ "$got_sha" != "$2" || "$got_size" != "$3" ]]; then
    echo "❌ 照合: s3://$BUCKET/$1 が期待と違う" >&2
    echo "   期待 sha256=$2 size=$3" >&2
    echo "   S3   sha256=$got_sha size=$got_size" >&2
    return 1
  fi
}

# S3 のマニフェストを取り直し、チャネルが指す版の .bin と照らし合わせる（機器が受け取るのと同じ組み合わせ）。
# VERIFY_MANIFEST=<ファイル> を渡すと S3 の代わりにそのマニフェストを使う（照合が止まることを確かめる試験用）
verify_channel() {  # channel
  local file="$BUILD_DIR/manifest.verify.json" entry version key sha size
  if [[ -n "${VERIFY_MANIFEST:-}" ]]; then
    cp "$VERIFY_MANIFEST" "$file"
  else
    aws s3 cp "s3://$BUCKET/$MANIFEST_KEY" "$file" --region "$REGION" >/dev/null \
      || { echo "❌ 照合: マニフェストを取れない" >&2; return 1; }
  fi
  entry="$(node -e '
    const m = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const v = (m.channels || {})[process.argv[2]];
    const e = v && (m.versions || {})[v];
    if (!e) { console.error("channel " + process.argv[2] + " が指す版がマニフェストに無い: " + v); process.exit(1); }
    console.log([v, e.key, e.sha256, e.size].join(" "));
  ' "$file" "$1")" || { echo "❌ 照合: マニフェストを読めない" >&2; return 1; }
  read -r version key sha size <<< "$entry"
  check_object "$key" "$sha" "$size" || {
    echo "❌ $1 が指す $version は、マニフェストと S3 の .bin が食い違っている。このままだと機器は sha256 で弾く。" >&2
    echo "   直すには、同じ版を --force で発行し直すか、チャネルを前の版へ戻す" >&2
    return 1
  }
  echo "🔁 verified: $1 -> $version （S3 の .bin とマニフェストの sha256・size が一致）"
}

if [[ $VERIFY_ONLY -eq 1 ]]; then
  verify_channel "$CHANNEL"
  exit $?
fi

if [[ $PROMOTE -eq 1 ]]; then
  [[ "$CHANNEL" == "stable" ]] || { echo "--promote は stable にだけ使う" >&2; exit 2; }
  fetch_manifest
  update_manifest promote "$CHANNEL" "" "" "" ""
  if [[ $DRY_RUN -eq 1 ]]; then echo "(dry-run) manifest not uploaded"; exit 0; fi
  aws s3 cp "$MANIFEST_LOCAL" "s3://$BUCKET/$MANIFEST_KEY" --region "$REGION" --content-type application/json >/dev/null
  verify_channel "$CHANNEL"
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
  # ビルドに失敗したら止める。以前は `| grep ... || true` で失敗を握りつぶし、古い .bin を新しい版の名前で発行した
  # （2026-11-08、arduino-cli が PATH に無く 0.7.7 の名前で古い中身を発行）。古い .bin は先に消して取り違えを防ぐ
  command -v arduino-cli >/dev/null 2>&1 || { echo "❌ arduino-cli が PATH に無い（Windows は Arduino IDE の resources/app/lib/backend/resources を PATH へ）" >&2; exit 1; }
  rm -f "$BIN"
  BUILD_LOG="$(arduino-cli compile --fqbn "$FQBN" --build-path "$BUILD_DIR" "$SKETCH_DIR" 2>&1)" \
    || { echo "$BUILD_LOG" | tail -20 >&2; echo "❌ build failed" >&2; exit 1; }
  echo "$BUILD_LOG" | grep -E 'Sketch uses|Global variables' || true
fi
[[ -f "$BIN" ]] || { echo "binary not found: $BIN" >&2; exit 1; }
# 中身が本当にこの版かを確かめる（--no-build や別の経路で古い .bin が混ざっても止める）。
# 本文の要求に入る `"fw":"<版>"` は文字列リテラルの連結で .bin にそのまま残る（toytalker_mini_v0.7.ino の payload）
if ! grep -aqF "\"fw\":\"$VERSION\"" "$BIN"; then
  echo "❌ $BIN の中身が $VERSION ではない（\"fw\":\"$VERSION\" が見つからない）。ビルドし直す" >&2
  exit 1
fi
echo "🔎 binary contains \"fw\":\"$VERSION\""

SHA="$(sha256_of "$BIN")"
SIZE="$(wc -c < "$BIN" | tr -d ' ')"
echo "📦 size=$SIZE sha256=$SHA"

# アプリの枠に収まるかを確かめる。枠はスケッチの partitions.csv の app0（ボード設定の no_fs より狭い）。
# arduino-cli の「Maximum is …」はボード設定の値のままなので、枠を超えてもビルドは通る。超えた .bin は本体が OTA で弾く
APP_SLOT_HEX="$(awk -F, '$1 ~ /^app0/ { gsub(/[ \t\r]/, "", $5); print $5 }' "$SKETCH_DIR/partitions.csv" 2>/dev/null || true)"
if [[ ! "$APP_SLOT_HEX" =~ ^0x[0-9A-Fa-f]+$ ]]; then
  echo "❌ $SKETCH_DIR/partitions.csv から app0 の大きさを読めない: '$APP_SLOT_HEX'" >&2
  exit 1
fi
APP_SLOT=$((APP_SLOT_HEX))
if (( SIZE > APP_SLOT )); then
  echo "❌ .bin（$SIZE バイト）がアプリの枠（$APP_SLOT バイト）を超えている。発行しない" >&2
  exit 1
fi
echo "📏 app slot=$APP_SLOT free=$((APP_SLOT - SIZE)) ($(( (APP_SLOT - SIZE) * 100 / APP_SLOT ))%)"

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
# マニフェストを向ける前に、置いた .bin が手元と同じかを確かめる（違えばチャネルは前の版のまま）
check_object "$KEY" "$SHA" "$SIZE" || { echo "❌ アップロードした .bin が手元と違う。マニフェストは更新していない" >&2; exit 1; }

fetch_manifest
update_manifest publish "$CHANNEL" "$VERSION" "$KEY" "$SHA" "$SIZE"
aws s3 cp "$MANIFEST_LOCAL" "s3://$BUCKET/$MANIFEST_KEY" --region "$REGION" --content-type application/json >/dev/null
verify_channel "$CHANNEL"
echo "✅ published $VERSION to $CHANNEL"

if [[ -n "$DIRTY" ]]; then
  echo "⚠️ 未コミットの変更を含む発行なのでタグ $TAG は付けない"
else
  git tag -f "$TAG" -m "firmware $VERSION published to $CHANNEL (sha256 $SHA)" >/dev/null
  echo "🏷️ tagged $TAG (push with: git push origin $TAG)"
fi
