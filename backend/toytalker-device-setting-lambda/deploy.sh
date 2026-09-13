#!/bin/bash
set -euo pipefail  # バンドル失敗時に古いbundle.mjsをデプロイしてしまわないよう即停止
cd "$(dirname "$0")"

echo "📦 Installing dependencies..."
npm install

echo "📦 Bundling with esbuild..."
npx esbuild index.mjs --bundle --platform=node --format=cjs \
  --external:@aws-sdk/client-dynamodb \
  --external:@aws-sdk/lib-dynamodb \
  --external:@aws-sdk/client-s3 \
  --outfile=bundle.js

echo "📁 Creating zip..."
mkdir -p temp_deploy
cp bundle.js temp_deploy/index.js
cd temp_deploy
if command -v zip >/dev/null 2>&1; then
  rm -f ../deploy.zip; zip -q ../deploy.zip index.js                        # Mac / Linux
else
  powershell -Command "Compress-Archive -Path 'index.js' -DestinationPath '../deploy.zip' -Force"   # Windows Git Bash
fi
cd ..
rm -rf temp_deploy

echo "🚀 Deploying to Lambda..."
aws lambda update-function-code \
  --function-name toytalker-device-setting-lambda \
  --zip-file fileb://deploy.zip \
  --region ap-northeast-1 \
  --query '[CodeSize, LastModified]' \
  --output text

echo "✅ Done!"
