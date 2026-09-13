#!/bin/bash
# デプロイスクリプト - index.mjs を編集後にこれを実行（初回は先に setup.sh で関数・スケジュールを作る）
set -euo pipefail  # バンドル失敗時に古いbundle.mjsをデプロイしてしまわないよう即停止
cd "$(dirname "$0")"

echo "📦 Bundling with esbuild..."
"/c/Program Files/nodejs/npx" esbuild index.mjs --bundle --platform=node --format=esm \
  --external:@aws-sdk/client-dynamodb \
  --external:@aws-sdk/lib-dynamodb \
  --external:@aws-sdk/client-sns \
  --external:@aws-sdk/client-cloudwatch-logs \
  --outfile=bundle.mjs

echo "📁 Creating zip..."
mkdir -p temp_deploy
cp bundle.mjs temp_deploy/index.mjs
cd temp_deploy
powershell -Command "Compress-Archive -Path 'index.mjs' -DestinationPath '../deploy.zip' -Force"
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
