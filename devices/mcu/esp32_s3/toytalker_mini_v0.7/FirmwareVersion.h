#pragma once
// FirmwareVersion.h — この版の識別子。
// OTAの更新判定は「サーバーの目標版と不一致なら更新」なので、変更を配布するときは必ずここを上げる。
// tools/publish-firmware.sh はこのファイルから版を読み取り、S3のキー・マニフェスト・gitタグ fw-<版> に使う。
// 形式は自由な文字列だが、S3キーに使うため英数字と . - _ に限る。
#define TOYTALKER_FW_VERSION "0.7.2"
#define TOYTALKER_HW_VERSION "v0.2"
