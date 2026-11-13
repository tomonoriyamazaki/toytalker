import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as events from "aws-cdk-lib/aws-events";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as path from "node:path";
import type { StageConfig } from "../config/stages.js";
import { SECRET_PARAMS } from "./secrets.js";
import { BACKEND_DIR, FUNCTIONS, LAMBDA_RUNTIME, bundleLambda, configEnv } from "./toytalker-stack.js";

/** 別リージョンにも置く Lambda（本体スタックの FUNCTIONS の key）。今は ESP32 の本文だけ */
const SATELLITE_FUNCTION_KEYS = ["chat-mcu"] as const;

const pascal = (key: string) => key.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());

export interface ToyTalkerSatelliteStackProps extends cdk.StackProps {
  readonly config: StageConfig;
}

/**
 * データ（DynamoDB・SSM）とは別のリージョンに置く会話用 Lambda（config.satellites。2026-11-13、RnD のオレゴン）。
 * 目的は、利用者と Lambda の距離が音声の途切れ・速さにどう効くかを測ること。
 *
 * - 置くのは Lambda・Function URL・ロググループだけ。コードと設定は本体スタックの FUNCTIONS と同じものを使う。
 * - データは本体のリージョンのものを読む: 環境変数 DATA_REGION を渡し、backend/shared/region.mjs が DynamoDB と SSM の
 *   クライアントをそのリージョンへ向ける。権限も本体リージョンのテーブル・パラメータの ARN に付ける（本体スタックと同じ動詞）。
 *   テーブルを読むたびにリージョン間を往復するので、その分は Lambda ログの marks.config に出る。
 * - 入口は2つ。Function URL の直接呼び出し（公開）と、本体スタックの CloudFront 固定ドメイン
 *   （経路 `/chat-mcu-<短縮名>` と振り分け。本体の createApiDistribution）。
 *   守りは本体の Function URL を直接呼ぶ経路と同じ（未登録機の門・デバイス鍵。backend/shared/auth.mjs）。
 * - 温めルール（5分ごと）は、国で振り分けるとき（countries が空でない）だけ置く。試験だけの間は置かないので、
 *   しばらく使わないと最初の1回はコールドスタートになる（ログの container_age_s。最初の1バイトまで約2秒）。
 * - 全部 DESTROY。`cdk destroy` で何も残らない。
 */
export class ToyTalkerSatelliteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ToyTalkerSatelliteStackProps) {
    super(scope, id, props);
    const { config } = props;
    if (this.region === config.region) {
      throw new Error(`satellites に本体と同じリージョン（${config.region}）は書けません`);
    }

    cdk.Tags.of(this).add("project", "toytalker");
    cdk.Tags.of(this).add("environment", config.stage);

    const satellite = config.satellites?.find((s) => s.region === this.region);
    if (!satellite) throw new Error(`config.satellites に ${this.region} がありません`);
    /** 国で振り分けて利用者が来るなら温める。試験だけ（countries が空）なら置かない */
    const warm = satellite.countries.length > 0;

    const env = configEnv(config);
    /** 本体リージョンにある資源の ARN */
    const dataArn = (service: string, resource: string, resourceName: string) =>
      this.formatArn({ service, region: config.region, resource, resourceName });
    const tables = new Map<string, dynamodb.ITable>();
    const table = (key: string): dynamodb.ITable => {
      let t = tables.get(key);
      if (!t) {
        t = dynamodb.Table.fromTableArn(this, `${pascal(key)}Table`, dataArn("dynamodb", "table", `toytalker-${key}${config.tableSuffix}`));
        tables.set(key, t);
      }
      return t;
    };

    for (const key of SATELLITE_FUNCTION_KEYS) {
      const spec = FUNCTIONS.find((f) => f.key === key);
      if (!spec?.url) throw new Error(`${key}: 本体スタックの FUNCTIONS に Function URL 付きの定義がありません`);
      // 関数名はリージョンごとの名前空間なので、新名（docs/naming-conventions.md）をそのまま使う
      const fnId = pascal(key);
      const name = `toytalker-${key}-${config.stage}`;

      const environment: Record<string, string> = {};
      for (const k of spec.env) {
        const value = env[k];
        if (value === undefined) {
          throw new Error(`${name}: 環境変数 ${k} は環境の設定だけでは決まらないので、別リージョンには置けません`);
        }
        environment[k] = value;
      }
      environment.TABLE_SUFFIX = config.tableSuffix;
      environment.SECRET_PARAMS = JSON.stringify(Object.fromEntries(spec.secrets.map((n) => [n, SECRET_PARAMS[n]])));
      environment.DATA_REGION = config.region; // backend/shared/region.mjs

      const logGroup = new logs.LogGroup(this, `${fnId}Logs`, {
        logGroupName: `/aws/lambda/${name}`,
        retention: logs.RetentionDays.THREE_MONTHS,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });

      const fn = new lambda.Function(this, fnId, {
        functionName: name,
        description: `${spec.description ?? key} (satellite, data in ${config.region})`,
        code: bundleLambda(path.join(BACKEND_DIR, spec.dir), spec.format, spec.requireShim ?? false),
        handler: "index.handler",
        runtime: LAMBDA_RUNTIME,
        architecture: config.architecture === "arm64" ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64,
        memorySize: spec.memorySize,
        timeout: cdk.Duration.seconds(spec.timeoutSeconds),
        environment,
        logGroup,
      });

      const url = new lambda.CfnUrl(this, `${fnId}Url`, {
        targetFunctionArn: fn.functionArn,
        authType: "NONE",
        invokeMode: spec.url.invokeMode,
      });
      fn.addPermission(`${fnId}UrlPublicAccess`, {
        principal: new iam.AnyPrincipal(),
        action: "lambda:InvokeFunctionUrl",
        functionUrlAuthType: lambda.FunctionUrlAuthType.NONE,
      });
      fn.addPermission(`${fnId}UrlInvokeAction`, {
        principal: new iam.AnyPrincipal(),
        action: "lambda:InvokeFunction",
        invokedViaFunctionUrl: true,
      });
      // 本体スタックの CloudFront（固定ドメイン）からも呼べるようにする（config.satellites の urlHosts）。
      // 配信の ARN で絞らないのは、本体スタックとの参照を作らず片方だけ消せるようにするため（このアカウントの配信に限る）
      const cloudFront = new iam.ServicePrincipal("cloudfront.amazonaws.com");
      fn.addPermission(`${fnId}CloudFrontInvokeUrl`, { principal: cloudFront, action: "lambda:InvokeFunctionUrl", sourceAccount: this.account });
      fn.addPermission(`${fnId}CloudFrontInvoke`, { principal: cloudFront, action: "lambda:InvokeFunction", sourceAccount: this.account, invokedViaFunctionUrl: true });
      new cdk.CfnOutput(this, `${fnId}FunctionUrl`, { value: url.attrFunctionUrl });

      // 本体スタックと同じ動詞を、本体リージョンのテーブルに付ける
      for (const t of spec.readTables) table(t).grantReadData(fn);
      for (const t of spec.readWriteTables) table(t).grantReadWriteData(fn);
      for (const t of spec.updateTables ?? []) table(t).grant(fn, "dynamodb:GetItem", "dynamodb:UpdateItem");
      for (const t of spec.appendTables ?? []) table(t).grant(fn, "dynamodb:PutItem");
      for (const t of spec.lookupTables ?? []) table(t).grant(fn, "dynamodb:GetItem", "dynamodb:Query");
      for (const t of spec.scanTables ?? []) table(t).grant(fn, "dynamodb:GetItem", "dynamodb:Query", "dynamodb:Scan");
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["ssm:GetParameters"],
        resources: spec.secrets.map((n) => dataArn("ssm", "parameter", SECRET_PARAMS[n].replace(/^\//, ""))),
      }));
      if (spec.warm && warm) {
        // 温めルール（5分ごと、{"warmup":true}）。国で振り分けて利用者が来るリージョンだけ置く（本体スタックの WarmerRule と同じ）
        const warmer = new events.CfnRule(this, `${fnId}Warmer`, {
          name: `toytalker-warmer-${key}-${config.stage}`,
          description: "ToyTalker Lambda cold start warmer (satellite)",
          scheduleExpression: "rate(5 minutes)",
          state: "ENABLED",
          targets: [{ id: "warm1", arn: fn.functionArn, input: JSON.stringify({ body: '{"warmup":true}' }) }],
        });
        fn.addPermission(`${fnId}WarmerInvoke`, { principal: new iam.ServicePrincipal("events.amazonaws.com"), sourceArn: warmer.attrArn });
      }
      if (spec.selfWarm) {
        // 予備インスタンスの温め（自分自身への Invoke）。これはこのリージョンの自分
        fn.addToRolePolicy(new iam.PolicyStatement({
          actions: ["lambda:InvokeFunction"],
          resources: [this.formatArn({ service: "lambda", resource: "function", resourceName: name, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME })],
        }));
      }
    }

    // cdk-nag で意図して受け入れている指摘（本体スタックの acknowledgeNagFindings と同じ理由）
    const ack = (nagId: string, reason: string) => cdk.Validations.of(this).acknowledge({ id: nagId, reason });
    ack("AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
      "Lambdaの標準ロググループ書き込み（CloudWatch Logs のみ）。resourceは自関数のログに限られる");
    ack("Serverless-LambdaDLQ", "呼び出しは Function URL（同期）だけ");
    ack("Serverless-LambdaTracing", "X-Ray は使っていない（本体スタックと同じ）");
  }
}
