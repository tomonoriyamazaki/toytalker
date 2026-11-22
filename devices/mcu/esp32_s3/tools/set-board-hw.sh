#!/bin/bash
# set-board-hw.sh — 本体の NVS に基板の版（device/hw）を書く。USB で最初に書いたときに 1 回だけ使う。
# ファームは全基板で 1 本で、起動時にこの版を読んでマイクの初期化を切り替える（BoardConfig.h）。
# 鍵が無い本体は v0.2 として動くので、v0.2 機には使わなくてよい。0.7.35 以降のファームが要る。
#
# 使い方:
#   bash devices/mcu/esp32_s3/tools/set-board-hw.sh v0.3 COM4               # Windows（Git Bash）
#   bash devices/mcu/esp32_s3/tools/set-board-hw.sh v0.3 /dev/cu.usbmodem101 # Mac
#
# 何をするか: シリアルへ "HW <版>" の行を 1 秒おきに最大 15 回送り、本体の返事
# （[BOARD] hw=<版> saved=1 か unchanged）を待つ。書けたら本体は自分で再起動する。
# ポートを開いた拍子に本体がリセットされても、起動した後の送信が届く。
set -euo pipefail

HW="${1:-}"; PORT="${2:-}"
if [[ ! "$HW" =~ ^v[0-9]+\.[0-9]+$ || -z "$PORT" ]]; then
  echo "usage: $0 <基板の版 例 v0.3> <ポート>" >&2
  exit 2
fi

echo "🏷️ 基板の版 ${HW} を ${PORT} へ書く..."
if command -v powershell.exe >/dev/null 2>&1; then
  # DTR/RTS は立てない（立てると開くたびに本体がリセットされる）
  HW="$HW" PORT="$PORT" powershell.exe -NoProfile -Command '
    $hw = $env:HW
    $p = New-Object System.IO.Ports.SerialPort $env:PORT, 921600
    $p.DtrEnable = $false; $p.RtsEnable = $false
    try { $p.Open() } catch { Write-Host "   ポートを開けない（シリアルモニタなど、ほかで開いていないか）"; exit 1 }
    $seen = ""; $ok = $false
    for ($i = 0; $i -lt 15 -and -not $ok; $i++) {
      $p.Write("HW $hw`n")
      Start-Sleep -Milliseconds 1000
      $seen += $p.ReadExisting()
      if ($seen -match ("\[BOARD\] hw=" + [regex]::Escape($hw) + " (saved=1|unchanged)")) { $ok = $true }
    }
    $p.Close()
    ($seen -split "`n") | Where-Object { $_ -match "\[BOARD\]" } | ForEach-Object { Write-Host ("   " + $_.Trim()) }
    if (-not $ok) { exit 1 }
  ' || { echo "❌ 本体から返事が無い（0.7.35 以降のファームか、ポートが合っているか）" >&2; exit 1; }
else
  stty -f "$PORT" 921600 raw -echo 2>/dev/null || stty -F "$PORT" 921600 raw -echo
  exec 3<>"$PORT"
  OK=0
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    printf 'HW %s\n' "$HW" >&3
    while IFS= read -r -t 1 -u 3 LINE; do
      case "$LINE" in
        *"[BOARD] hw=${HW} saved=1"*|*"[BOARD] hw=${HW} unchanged"*) echo "   ${LINE}"; OK=1 ;;
      esac
    done
    [[ $OK -eq 1 ]] && break
  done
  exec 3>&-
  [[ $OK -eq 1 ]] || { echo "❌ 本体から返事が無い（0.7.35 以降のファームか、ポートが合っているか）" >&2; exit 1; }
fi
echo "✅ 基板の版 ${HW} を書いた。起動ログの [BOARD] hw=${HW} mic=... で確かめる"
