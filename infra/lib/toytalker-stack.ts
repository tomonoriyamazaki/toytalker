import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { buildSync } from "esbuild";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as events from "aws-cdk-lib/aws-events";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as schedulerTargets from "aws-cdk-lib/aws-scheduler-targets";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { StageConfig } from "../config/stages.js";
import type { Secrets } from "./secrets.js";

/** 全Lambda共通のランタイム。EOLのときはここ1か所を変える */
export const LAMBDA_RUNTIME = lambda.Runtime.NODEJS_24_X;

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BACKEND_DIR = path.join(REPO_ROOT, "backend");
const ESM_BANNER = "import { createRequire } from 'module'; const require = createRequire(import.meta.url);";

type BundleFormat = "esm" | "cjs";

/**
 * 各Lambdaの index.mjs を esbuild で1ファイルにまとめる（deploy.sh と同じ指定）。
 * NodejsFunction を使わないのは、あちらが `npx esbuild` をリポジトリ直下で起動して止まるため
 * （esbuild は infra/ にしか無い）。AWS SDK はランタイム同梱のものを使う。
 * 同梱に切り替える案は docs/multi-account-iac-plan.md。
 */
function bundleLambda(fnDir: string, format: BundleFormat, requireShim: boolean): lambda.Code {
  return lambda.Code.fromAsset(fnDir, {
    assetHashType: cdk.AssetHashType.OUTPUT,
    bundling: {
      image: LAMBDA_RUNTIME.bundlingImage, // ローカルで失敗したときだけDockerに落ちる（通常は使わない）
      local: {
        tryBundle(outputDir: string): boolean {
          buildSync({
            absWorkingDir: fnDir,
            entryPoints: ["index.mjs"],
            outfile: path.join(outputDir, format === "esm" ? "index.mjs" : "index.js"),
            bundle: true,
            platform: "node",
            target: "node24",
            format,
            external: ["@aws-sdk/*"],
            banner: requireShim ? { js: ESM_BANNER } : undefined,
            logLevel: "warning",
          });
          return true;
        },
      },
    },
  });
}

export interface ToyTalkerStackProps extends cdk.StackProps {
  readonly config: StageConfig;
  readonly secrets: Secrets;
  /**
   * `cdk import` 用。CloudFormationはimport操作中に新しい資源を作れないので、
   * ロール・ポリシー・Lambda Permissionを出さず、既存ロールを参照する。
   */
  readonly importPhase: boolean;
}

type TableName =
  | "toytalker-devices"
  | "toytalker-characters"
  | "toytalker-voices"
  | "toytalker-llms"
  | "toytalker-chat-logs"
  | "toytalker-usage"
  | "toytalker-api-unit-prices"
  | "toytalker-exchange-rates";

interface FunctionSpec {
  readonly id: string;
  readonly name: string;
  readonly dir: string;
  readonly memorySize: number;
  readonly timeoutSeconds: number;
  readonly format: BundleFormat;
  /** ESMバンドル内で依存が require() を使う（undici）ので createRequire を先頭に足す */
  readonly requireShim?: boolean;
  readonly description?: string;
  readonly env: readonly string[];
  readonly url?: {
    readonly invokeMode: "RESPONSE_STREAM" | "BUFFERED";
    readonly cors?: lambda.CfnUrl.CorsProperty;
  };
  /** 温めルール（5分ごと）の対象。並び順がターゲットID（warm1〜）になる。既存はESP32用メインが先 */
  readonly warm: boolean;
  /** 実リクエスト中に自分自身へwarmup pingを投げる（予備インスタンス温め）。自分へのInvoke権限が要る */
  readonly selfWarm: boolean;
  readonly readTables: readonly TableName[];
  readonly readWriteTables: readonly TableName[];
}

// Function URLのCORS。既存設定をそのまま再現している（AllowHeadersがカンマ区切りの1要素なのも現状どおり）
const CORS_GET_ONLY: lambda.CfnUrl.CorsProperty = {
  allowCredentials: false,
  allowHeaders: ["content-type, authorization"],
  allowMethods: ["GET"],
  allowOrigins: ["*"],
  exposeHeaders: ["date, content-type, transfer-encoding"],
};

const TTS_ENV = [
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "ELEVENLABS_API_KEY",
  "FISHAUDIO_API_KEY",
  "SAKURA_API_KEY",
  "CARTESIA_API_KEY",
  "CARTESIA_DEFAULT_VOICE_ID",
  "ZAKICORP_API_KEY",
  "ZAKICORP_EDGE_KEY",
  "ZAKICORP_TTS_URL",
] as const;

const FUNCTIONS: readonly FunctionSpec[] = [
  {
    id: "Esp32Stream",
    name: "toytalk-api-stream-for-esp32-lambda",
    dir: "toytalk-api-stream-for-esp32-lambda",
    memorySize: 2048,
    timeoutSeconds: 120,
    format: "esm",
    requireShim: true,
    env: [...TTS_ENV, "ANTHROPIC_API_KEY", "SERPER_API_KEY"],
    url: { invokeMode: "RESPONSE_STREAM", cors: CORS_GET_ONLY },
    warm: true,
    selfWarm: true,
    readTables: ["toytalker-devices", "toytalker-characters", "toytalker-voices", "toytalker-llms", "toytalker-api-unit-prices", "toytalker-exchange-rates"],
    readWriteTables: ["toytalker-chat-logs", "toytalker-usage"],
  },
  {
    id: "StreamHandler",
    name: "toytalk-stream-handler-lambda",
    dir: "toytalk-stream-handler-lambda",
    memorySize: 2048,
    timeoutSeconds: 120,
    format: "esm",
    env: [...TTS_ENV, "ANTHROPIC_API_KEY", "SERPER_API_KEY"],
    url: { invokeMode: "RESPONSE_STREAM", cors: CORS_GET_ONLY },
    warm: true,
    selfWarm: true,
    readTables: ["toytalker-characters", "toytalker-voices", "toytalker-llms", "toytalker-api-unit-prices", "toytalker-exchange-rates"],
    readWriteTables: ["toytalker-chat-logs", "toytalker-usage"],
  },
  {
    id: "BackchannelApp",
    name: "toytalker-backchannel-for-app-lambda",
    dir: "toytalker-backchannel-for-app-lambda",
    memorySize: 1024,
    timeoutSeconds: 20,
    format: "esm",
    env: [...TTS_ENV, "ANTHROPIC_API_KEY"],
    url: { invokeMode: "RESPONSE_STREAM", cors: CORS_GET_ONLY },
    warm: true,
    selfWarm: true,
    readTables: ["toytalker-characters", "toytalker-voices"],
    readWriteTables: [],
  },
  {
    id: "BackchannelEsp32",
    name: "toytalker-backchannel-for-esp32-lambda",
    dir: "toytalker-backchannel-for-esp32-lambda",
    memorySize: 1024,
    timeoutSeconds: 20,
    format: "esm",
    requireShim: true,
    env: [...TTS_ENV, "ANTHROPIC_API_KEY"],
    url: { invokeMode: "BUFFERED" },
    warm: true,
    selfWarm: true,
    readTables: ["toytalker-devices", "toytalker-characters", "toytalker-voices"],
    readWriteTables: [],
  },
  {
    id: "SonioxStt",
    name: "toytalk-soniox-stt-lambda",
    dir: "toytalk-soniox-stt-lambda",
    memorySize: 128,
    timeoutSeconds: 3,
    format: "esm",
    env: ["SONIOX_API_KEY", "SONIOX_MODEL"],
    url: { invokeMode: "BUFFERED", cors: CORS_GET_ONLY },
    warm: true,
    selfWarm: false,
    readTables: ["toytalker-devices"],
    readWriteTables: [],
  },
  {
    id: "DeviceSetting",
    name: "toytalker-device-setting-lambda",
    dir: "toytalker-device-setting-lambda",
    memorySize: 256,
    timeoutSeconds: 60,
    format: "cjs",
    env: ["CARTESIA_API_KEY", "ZAKICORP_API_KEY", "ZAKICORP_EDGE_KEY", "ZAKICORP_TTS_URL"],
    url: { invokeMode: "BUFFERED", cors: CORS_GET_ONLY },
    warm: false,
    selfWarm: false,
    readTables: [],
    readWriteTables: [
      "toytalker-devices", "toytalker-characters", "toytalker-voices", "toytalker-llms",
      "toytalker-chat-logs", "toytalker-usage", "toytalker-api-unit-prices", "toytalker-exchange-rates",
    ],
  },
  {
    id: "TtsOnly",
    name: "toytalker-tts-only-lambda",
    dir: "toytalker-tts-only-lambda",
    memorySize: 2048,
    timeoutSeconds: 120,
    format: "esm",
    env: [...TTS_ENV],
    url: {
      invokeMode: "RESPONSE_STREAM",
      cors: {
        allowHeaders: ["content-type", "authorization"],
        allowMethods: ["POST", "GET"],
        allowOrigins: ["*"],
        exposeHeaders: ["content-type", "x-audio-format", "content-disposition"],
      },
    },
    warm: false,
    selfWarm: false,
    readTables: ["toytalker-voices", "toytalker-api-unit-prices", "toytalker-exchange-rates"],
    readWriteTables: ["toytalker-usage"],
  },
  {
    id: "OpsMonthly",
    name: "toytalker-ops-monthly-lambda",
    dir: "toytalker-ops-monthly-lambda",
    memorySize: 256,
    timeoutSeconds: 300,
    format: "esm",
    description: "Monthly ops report: FX rate, recorded cost vs provider bills, price table checks",
    env: ["ELEVENLABS_API_KEY", "OPENAI_ADMIN_KEY", "ANTHROPIC_ADMIN_KEY", "OPS_SNS_TOPIC_ARN"],
    warm: false,
    selfWarm: false,
    readTables: ["toytalker-usage", "toytalker-api-unit-prices"],
    readWriteTables: ["toytalker-exchange-rates"],
  },
];

export class ToyTalkerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ToyTalkerStackProps) {
    super(scope, id, props);
    const { config, secrets, importPhase } = props;

    // ---- DynamoDB（データ入り。作り直さない） ----
    const tables = this.createTables();

    // ---- S3: speaker embedding のバックアップ ----
    const speakersBucket = new s3.Bucket(this, "SpeakersBucket", {
      bucketName: config.speakersBucketName,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---- SNS: 月次運用レポートの宛先 ----
    // スタックを消しても既存資源が消えないよう、データ以外も RETAIN にする（Function URLは消えるとホスト名が変わる）
    const RETAIN = cdk.RemovalPolicy.RETAIN;
    const opsTopic = new sns.Topic(this, "OpsMonthlyTopic", { topicName: "toytalker-ops-monthly" });
    opsTopic.applyRemovalPolicy(RETAIN);
    opsTopic.addSubscription(new subs.EmailSubscription(config.opsEmail));
    for (const sub of opsTopic.node.findAll()) if (sub instanceof sns.CfnSubscription) sub.applyRemovalPolicy(RETAIN);

    // ---- Lambda ----
    const existingLambdaRole = config.existingRoles && importPhase
      ? iam.Role.fromRoleArn(this, "ExistingLambdaRole", config.existingRoles.lambdaRoleArn, { mutable: false })
      : undefined;
    const existingOpsRole = config.existingRoles && importPhase
      ? iam.Role.fromRoleArn(this, "ExistingOpsLambdaRole", config.existingRoles.opsLambdaRoleArn, { mutable: false })
      : undefined;
    const existingSchedulerRole = config.existingRoles && importPhase
      ? iam.Role.fromRoleArn(this, "ExistingSchedulerRole", config.existingRoles.schedulerRoleArn, { mutable: false })
      : undefined;
    if (importPhase && !config.existingRoles) {
      throw new Error("importPhase には config.existingRoles が必要です");
    }

    const allEnv: Record<string, string | undefined> = {
      ...secrets,
      CARTESIA_DEFAULT_VOICE_ID: config.cartesiaDefaultVoiceId,
      ZAKICORP_TTS_URL: config.zakicorpTtsUrl,
      SONIOX_MODEL: config.sonioxModel,
      OPS_SNS_TOPIC_ARN: opsTopic.topicArn,
    };

    const functions = new Map<string, lambda.Function>();
    const logGroups = new Map<string, logs.ILogGroup>();
    for (const spec of FUNCTIONS) {
      const environment: Record<string, string> = {};
      for (const key of spec.env) {
        const value = allEnv[key];
        if (value === undefined) {
          if (key in secrets || key.endsWith("_ADMIN_KEY")) continue; // 任意の秘密は無ければ入れない
          throw new Error(`${spec.name}: 環境変数 ${key} の値がありません`);
        }
        environment[key] = value;
      }

      const logGroup = new logs.LogGroup(this, `${spec.id}Logs`, {
        logGroupName: `/aws/lambda/${spec.name}`,
        retention: logs.RetentionDays.INFINITE,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      logGroups.set(spec.name, logGroup);

      const fn = new lambda.Function(this, spec.id, {
        functionName: spec.name,
        description: spec.description,
        code: bundleLambda(path.join(BACKEND_DIR, spec.dir), spec.format, spec.requireShim ?? false),
        handler: "index.handler",
        runtime: LAMBDA_RUNTIME,
        architecture: config.architecture === "arm64" ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64,
        memorySize: spec.memorySize,
        timeout: cdk.Duration.seconds(spec.timeoutSeconds),
        environment,
        logGroup,
        role: spec.id === "OpsMonthly" ? existingOpsRole : existingLambdaRole,
      });
      fn.applyRemovalPolicy(RETAIN);
      functions.set(spec.name, fn);

      if (spec.url) {
        const url = new lambda.CfnUrl(this, `${spec.id}Url`, {
          targetFunctionArn: fn.functionArn,
          authType: "NONE",
          invokeMode: spec.url.invokeMode,
          cors: spec.url.cors,
        });
        url.applyRemovalPolicy(RETAIN);
        if (!importPhase) {
          fn.addPermission(`${spec.id}UrlPublicAccess`, {
            principal: new iam.AnyPrincipal(),
            action: "lambda:InvokeFunctionUrl",
            functionUrlAuthType: lambda.FunctionUrlAuthType.NONE,
          });
          fn.addPermission(`${spec.id}UrlInvokeAction`, {
            principal: new iam.AnyPrincipal(),
            action: "lambda:InvokeFunction",
            invokedViaFunctionUrl: true,
          });
        }
        new cdk.CfnOutput(this, `${spec.id}FunctionUrl`, { value: url.attrFunctionUrl });
      }

      if (!importPhase) {
        for (const t of spec.readTables) tables[t].grantReadData(fn);
        for (const t of spec.readWriteTables) tables[t].grantReadWriteData(fn);
        if (spec.selfWarm) {
          // 自分自身へのInvoke。関数ARNをトークンで参照すると循環になるので固定名から組み立てる
          fn.addToRolePolicy(new iam.PolicyStatement({
            actions: ["lambda:InvokeFunction"],
            resources: [this.formatArn({ service: "lambda", resource: "function", resourceName: spec.name, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME })],
          }));
        }
      }
    }

    // ---- デバイス設定Lambda: クローンボイス登録でS3へ保存・削除 ----
    if (!importPhase) speakersBucket.grantReadWrite(functions.get("toytalker-device-setting-lambda")!);

    // ---- 温めルール（5分ごと、5本へ {"warmup":true}） ----
    const warmTargets = FUNCTIONS.filter((s) => s.warm).map((s) => functions.get(s.name)!);
    const warmer = new events.CfnRule(this, "WarmerRule", {
      name: "toytalker-lambda-warmer",
      description: "ToyTalker Lambda cold start warmer",
      scheduleExpression: "rate(5 minutes)",
      state: "ENABLED",
      targets: warmTargets.map((fn, i) => ({
        id: `warm${i + 1}`,
        arn: fn.functionArn,
        input: JSON.stringify({ body: '{"warmup":true}' }),
      })),
    });
    warmer.applyRemovalPolicy(RETAIN);
    if (!importPhase) {
      for (const fn of warmTargets) {
        fn.addPermission("WarmerInvoke", {
          principal: new iam.ServicePrincipal("events.amazonaws.com"),
          sourceArn: warmer.attrArn,
        });
      }
    }

    // ---- 月次運用レポート（毎月1日 09:00 JST） ----
    const opsFn = functions.get("toytalker-ops-monthly-lambda")!;
    if (!importPhase) {
      opsTopic.grantPublish(opsFn);
      opsFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["logs:FilterLogEvents"],
        resources: [
          "toytalk-stream-handler-lambda",
          "toytalk-api-stream-for-esp32-lambda",
          "toytalker-tts-only-lambda",
        ].map((n) => logGroups.get(n)!.logGroupArn),
      }));
    }
    const opsSchedule = new scheduler.Schedule(this, "OpsMonthlySchedule", {
      scheduleName: "toytalker-ops-monthly",
      description: "ToyTalker monthly cost report",
      schedule: scheduler.ScheduleExpression.cron({
        minute: "0", hour: "9", day: "1", month: "*", year: "*",
        timeZone: cdk.TimeZone.ASIA_TOKYO,
      }),
      target: new schedulerTargets.LambdaInvoke(opsFn, {
        input: scheduler.ScheduleTargetInput.fromObject({}),
        role: existingSchedulerRole,
      }),
    });
    opsSchedule.applyRemovalPolicy(RETAIN);
  }

  private createTables(): Record<TableName, dynamodb.Table> {
    const S = dynamodb.AttributeType.STRING;
    const defs: Record<TableName, { pk: string; sk?: string }> = {
      "toytalker-devices": { pk: "device_id" },
      "toytalker-characters": { pk: "character_id" },
      "toytalker-voices": { pk: "voice_id" },
      "toytalker-llms": { pk: "llm_id" },
      "toytalker-chat-logs": { pk: "owner_id#device_id", sk: "session_id#timestamp" },
      "toytalker-usage": { pk: "owner_id", sk: "date#device_id#api_type" },
      "toytalker-api-unit-prices": { pk: "provider#api_type", sk: "version" },
      "toytalker-exchange-rates": { pk: "month", sk: "currency" },
    };
    const tables = {} as Record<TableName, dynamodb.Table>;
    for (const [name, def] of Object.entries(defs) as [TableName, { pk: string; sk?: string }][]) {
      const id = name.replace(/^toytalker-/, "").replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase()) + "Table";
      tables[name] = new dynamodb.Table(this, id, {
        tableName: name,
        partitionKey: { name: def.pk, type: S },
        sortKey: def.sk ? { name: def.sk, type: S } : undefined,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        deletionProtection: true,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
    }
    return tables;
  }
}
