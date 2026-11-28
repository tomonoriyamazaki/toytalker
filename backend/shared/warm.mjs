// 予備インスタンスの事前ウォームアップ（本文2本・相槌2本が使う。CDK の selfWarm: true で自分への Invoke 権限が付く）。
// 本リクエスト処理中（=このインスタンスがビジー中）に自分自身へwarmup pingを非同期送信すると、
// 別のコールドなインスタンスに着弾して初期化されるため、2人目の同時利用時のコールドスタートを防げる。
// 受ける側は各 Lambda の handler の先頭（body.warmup なら何もせず返す）。
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

// 自分自身を呼ぶので、その場のリージョン（データのリージョンではない。backend/shared/region.mjs）
const lambdaSelfClient = new LambdaClient({});

/** 待たずに投げる。失敗しても何もしない */
export function prewarmSpareInstance() {
  lambdaSelfClient.send(new InvokeCommand({
    FunctionName: process.env.AWS_LAMBDA_FUNCTION_NAME,
    InvocationType: "Event",
    Payload: Buffer.from(JSON.stringify({ body: '{"warmup":true}' })),
  })).catch(() => {});
}
