#!/bin/bash
# CDKのバンドル（esbuild）は各Lambdaディレクトリの node_modules から依存を解決する。
# 新しいマシンや clone 直後はこれを1回実行する。
set -euo pipefail
cd "$(dirname "$0")/../../backend"
for d in *-lambda; do
  if [ -f "$d/package-lock.json" ]; then
    echo "📦 $d (npm ci)"; (cd "$d" && npm ci --silent)
  elif [ -f "$d/package.json" ] && grep -q '"dependencies": {[^}]' "$d/package.json"; then
    echo "📦 $d (npm install)"; (cd "$d" && npm install --silent)
  else
    echo "—  $d (依存なし)"
  fi
done
