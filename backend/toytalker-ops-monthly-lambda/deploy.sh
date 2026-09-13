#!/bin/bash
# デプロイスクリプト - index.mjs を編集後にこれを実行（初回は先に setup.sh で関数・スケジュールを作る）
set -euo pipefail  # バンドル失敗時に古いbundle.mjsをデプロイしてしまわないよう即停止
cd "$(dirname "$0")"

echo "📦 Bundling with esbuild..."
npx esbuild index.mjs --bundle --platform=node --format=esm \
  --external:@aws-sdk/client-dynamodb \
  --external:@aws-sdk/lib-dynamodb \
  --external:@aws-sdk/client-sns \
  --external:@aws-sdk/client-cloudwatch-logs \
  --outfile=bundle.mjs

echo "📁 Creating zip..."
mkdir -p temp_deploy
cp bundle.mjs temp_deploy/index.mjs
cd temp_deploy
if command -v zip >/dev/null 2>&1; then
  rm -f ../deploy.zip; zip -q ../deploy.zip index.mjs                        # Mac / Linux
else
  powershell -Command "Compress-Archive -Path 'index.mjs' -DestinationPath '../deploy.zip' -Force"   # Windows Git Bash
fi
cd ..
rm -rf temp_deploy

echo "🚀 Deploying to Lambda..."
aws lambda update-function-code \
  --function-name toytalker-ops-monthly-lambda \
  --zip-file fileb://deploy.zip \
  --region ap-northeast-1 \
  --query '[CodeSize, LastModified]' \
  --output text

echo "✅ Done!"
