/**
 * SES の SMTP パスワードを IAM のシークレットアクセスキーから作る（AWS の公式の手順と同じ計算）。
 * 使い方: npx tsx scripts/ses-smtp-password.ts ap-northeast-1   （シークレットは標準入力から。画面やシェル履歴に残さない）
 *   例: aws iam create-access-key --user-name toytalker-ses-smtp-rnd --query AccessKey.SecretAccessKey --output text | npx tsx scripts/ses-smtp-password.ts ap-northeast-1
 * 出力の1行が Gmail に入れる SMTP パスワード。ユーザー名はアクセスキー ID。
 */
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const region = process.argv[2];
if (!region) { console.error("usage: ses-smtp-password.ts <region>  (secret access key on stdin)"); process.exit(2); }
const secret = readFileSync(0, "utf8").trim();
if (!secret) { console.error("secret access key が標準入力にありません"); process.exit(2); }

const hmac = (key: Buffer | string, msg: string) => createHmac("sha256", key).update(msg, "utf8").digest();
let sig = hmac("AWS4" + secret, "11111111");
sig = hmac(sig, region);
sig = hmac(sig, "ses");
sig = hmac(sig, "aws4_request");
sig = hmac(sig, "SendRawEmail");
console.log(Buffer.concat([Buffer.from([0x04]), sig]).toString("base64"));
