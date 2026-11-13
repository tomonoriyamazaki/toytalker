// データ（DynamoDB・SSM）のあるリージョン。全Lambda共通で、esbuildが各バンドルへ取り込む。
// 通常は未設定で、SDK は Lambda 自身のリージョンを使う（今まで通り）。
// データと別のリージョンに置いた Lambda（infra/lib/toytalker-satellite-stack.ts。例: オレゴン）には、
// CDK が環境変数 DATA_REGION でデータのリージョン（例: ap-northeast-1）を渡す。
// DynamoDB と SSM のクライアントはこの設定で作る。自分自身を呼ぶ LambdaClient など、その場のリージョンを使うものには渡さない。
export const DATA_REGION = process.env.DATA_REGION || undefined;

/** `new DynamoDBClient({ ...dataClientConfig })` のように渡す。未設定なら空（SDK の既定） */
export const dataClientConfig = DATA_REGION ? { region: DATA_REGION } : {};
