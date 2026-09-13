#!/bin/bash
# 初回構築スクリプト（再実行しても壊れないように、既存があれば更新する）
#   使い方: bash setup.sh <通知先メールアドレス>
# 作るもの:
#   1. SNSトピック toytalker-ops-monthly とメール購読（購読はメール内のリンクで確認が必要）
#   2. Lambda実行ロール toytalker-ops-monthly-role（DynamoDB 3テーブル、SNS発行、CloudWatch Logs検索、ログ出力）
#   3. Lambda関数 toytalker-ops-monthly-lambda（Node.js 24、タイムアウト5分）
#   4. EventBridge Scheduler toytalker-ops-monthly（毎月1日 09:00 JST）と、その起動ロール
set -euo pipefail
cd "$(dirname "$0")"

EMAIL="${1:-}"
if [ -z "$EMAIL" ]; then echo "usage: bash setup.sh <email>"; exit 1; fi

REGION="ap-northeast-1"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
FN="toytalker-ops-monthly-lambda"
ROLE="toytalker-ops-monthly-role"
SCHED_ROLE="toytalker-ops-monthly-scheduler-role"
TOPIC="toytalker-ops-monthly"

echo "🔔 SNS topic..."
TOPIC_ARN=$(aws sns create-topic --name "$TOPIC" --region "$REGION" --query TopicArn --output text)
if ! aws sns list-subscriptions-by-topic --topic-arn "$TOPIC_ARN" --region "$REGION" --query "Subscriptions[?Endpoint=='$EMAIL']" --output text | grep -q .; then
  aws sns subscribe --topic-arn "$TOPIC_ARN" --protocol email --notification-endpoint "$EMAIL" --region "$REGION" --output text
  echo "   → $EMAIL に確認メールを送りました。メール内のリンクで購読を確認してください"
else
  echo "   → $EMAIL は購読済み（確認待ちの場合はメールのリンクを開いてください）"
fi

echo "🔐 Lambda role..."
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "$TRUST" --output text --query Role.Arn
  echo "   → 作成。IAMの反映を待ちます"; sleep 10
fi
# Git Bash の /tmp は Windows の aws CLI から見えないので、スクリプトのフォルダに書く
cat > ops-policy.json <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], "Resource": "arn:aws:logs:$REGION:$ACCOUNT_ID:*" },
    { "Effect": "Allow", "Action": ["logs:FilterLogEvents"], "Resource": [
        "arn:aws:logs:$REGION:$ACCOUNT_ID:log-group:/aws/lambda/toytalk-stream-handler-lambda:*",
        "arn:aws:logs:$REGION:$ACCOUNT_ID:log-group:/aws/lambda/toytalk-api-stream-for-esp32-lambda:*",
        "arn:aws:logs:$REGION:$ACCOUNT_ID:log-group:/aws/lambda/toytalker-tts-only-lambda:*" ] },
    { "Effect": "Allow", "Action": ["dynamodb:Scan", "dynamodb:Query", "dynamodb:GetItem"], "Resource": [
        "arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/toytalker-usage",
        "arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/toytalker-api-unit-prices",
        "arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/toytalker-exchange-rates" ] },
    { "Effect": "Allow", "Action": ["dynamodb:PutItem"], "Resource": "arn:aws:dynamodb:$REGION:$ACCOUNT_ID:table/toytalker-exchange-rates" },
    { "Effect": "Allow", "Action": ["sns:Publish"], "Resource": "$TOPIC_ARN" }
  ]
}
EOF
aws iam put-role-policy --role-name "$ROLE" --policy-name ops-monthly --policy-document file://ops-policy.json
rm -f ops-policy.json
ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$ROLE"

echo "📦 Bundling..."
"/c/Program Files/nodejs/npx" esbuild index.mjs --bundle --platform=node --format=esm \
  --external:@aws-sdk/client-dynamodb --external:@aws-sdk/lib-dynamodb \
  --external:@aws-sdk/client-sns --external:@aws-sdk/client-cloudwatch-logs \
  --outfile=bundle.mjs
mkdir -p temp_deploy && cp bundle.mjs temp_deploy/index.mjs
( cd temp_deploy && powershell -Command "Compress-Archive -Path 'index.mjs' -DestinationPath '../deploy.zip' -Force" )
rm -rf temp_deploy

echo "λ Lambda function..."
if aws lambda get-function --function-name "$FN" --region "$REGION" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --zip-file fileb://deploy.zip --region "$REGION" --query LastModified --output text
  aws lambda wait function-updated --function-name "$FN" --region "$REGION"
  aws lambda update-function-configuration --function-name "$FN" --region "$REGION" \
    --environment "Variables={OPS_SNS_TOPIC_ARN=$TOPIC_ARN}" --timeout 300 --memory-size 256 --query LastModified --output text
else
  for i in 1 2 3 4 5 6; do
    if aws lambda create-function --function-name "$FN" --region "$REGION" \
        --runtime nodejs24.x --handler index.handler --role "$ROLE_ARN" \
        --zip-file fileb://deploy.zip --timeout 300 --memory-size 256 \
        --environment "Variables={OPS_SNS_TOPIC_ARN=$TOPIC_ARN}" \
        --description "Monthly ops report: FX rate, recorded cost vs provider bills, price table checks" \
        --query FunctionArn --output text; then break; fi
    echo "   → ロール反映待ち ($i)"; sleep 10
  done
fi
aws lambda wait function-active-v2 --function-name "$FN" --region "$REGION"
FN_ARN="arn:aws:lambda:$REGION:$ACCOUNT_ID:function:$FN"

echo "⏰ Scheduler role..."
SCHED_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"scheduler.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if ! aws iam get-role --role-name "$SCHED_ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$SCHED_ROLE" --assume-role-policy-document "$SCHED_TRUST" --output text --query Role.Arn
  sleep 10
fi
aws iam put-role-policy --role-name "$SCHED_ROLE" --policy-name invoke-ops-monthly \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"lambda:InvokeFunction\",\"Resource\":\"$FN_ARN\"}]}"
SCHED_ROLE_ARN="arn:aws:iam::$ACCOUNT_ID:role/$SCHED_ROLE"

echo "⏰ Schedule (1st of month 09:00 JST)..."
# Input は文字列で渡す必要があるため、ターゲットはJSONファイルで指定する
cat > sched-target.json <<EOF
{ "Arn": "$FN_ARN", "RoleArn": "$SCHED_ROLE_ARN", "Input": "{}" }
EOF
SCHED_ARGS=(--name "$TOPIC" --region "$REGION" \
  --schedule-expression "cron(0 9 1 * ? *)" --schedule-expression-timezone "Asia/Tokyo" \
  --flexible-time-window "Mode=OFF" \
  --target file://sched-target.json \
  --description "ToyTalker monthly cost report")
if aws scheduler get-schedule --name "$TOPIC" --region "$REGION" >/dev/null 2>&1; then
  aws scheduler update-schedule "${SCHED_ARGS[@]}" --query ScheduleArn --output text
else
  CREATED=0
  for i in 1 2 3 4 5 6; do
    if aws scheduler create-schedule "${SCHED_ARGS[@]}" --query ScheduleArn --output text; then CREATED=1; break; fi
    echo "   → 再試行 ($i)"; sleep 10
  done
  if [ "$CREATED" != "1" ]; then rm -f sched-target.json; echo "❌ スケジュール作成に失敗"; exit 1; fi
fi
rm -f sched-target.json

echo "✅ Done. topic=$TOPIC_ARN function=$FN_ARN"
echo "   任意: OPENAI_ADMIN_KEY / ANTHROPIC_ADMIN_KEY / ELEVENLABS_API_KEY を関数の環境変数に足すと各社の実績も取得します"
