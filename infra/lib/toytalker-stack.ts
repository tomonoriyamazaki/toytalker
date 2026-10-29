import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { buildSync } from "esbuild";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as backup from "aws-cdk-lib/aws-backup";
import * as sns from "aws-cdk-lib/aws-sns";
import * as subs from "aws-cdk-lib/aws-sns-subscriptions";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as events from "aws-cdk-lib/aws-events";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import * as schedulerTargets from "aws-cdk-lib/aws-scheduler-targets";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cw from "aws-cdk-lib/aws-cloudwatch";
import * as cwActions from "aws-cdk-lib/aws-cloudwatch-actions";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import type * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { StageConfig } from "../config/stages.js";
import { IDP_SECRETS, SECRET_PARAMS, type SecretName, type Secrets } from "./secrets.js";
import { CLOUDTRAIL_BUCKET_NAME } from "./toytalker-org-stack.js";

/** 全Lambda共通のランタイム。EOLのときはここ1か所を変える */
export const LAMBDA_RUNTIME = lambda.Runtime.NODEJS_24_X;

/**
 * Function URL を OAC 付きのオリジンにする。CDK の `FunctionUrlOrigin.withOriginAccessControl` は L2 の FunctionUrl を要求し、
 * authType が AWS_IAM でないと synth で止めるが、ここは import で引き取った L1（CfnUrl）で、旧クライアントが残る間は
 * NONE のまま CloudFront も通す（stages.ts の directFunctionUrls）。そこで同じこと（OAC の付与と CloudFront への Invoke 許可）を自前で行う。
 */
class LambdaUrlOrigin extends origins.HttpOrigin {
  constructor(
    private readonly fn: lambda.Function,
    url: lambda.CfnUrl,
    private readonly oac: cloudfront.IOriginAccessControl,
    props: origins.HttpOriginProps,
  ) {
    super(cdk.Fn.select(2, cdk.Fn.split("/", url.attrFunctionUrl)), {
      ...props,
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
    });
  }

  bind(scope: Construct, options: cloudfront.OriginBindOptions): cloudfront.OriginBindConfig {
    const config = super.bind(scope, options);
    const principal = new iam.ServicePrincipal("cloudfront.amazonaws.com");
    const sourceArn = `arn:${cdk.Aws.PARTITION}:cloudfront::${cdk.Aws.ACCOUNT_ID}:distribution/${options.distributionId}`;
    this.fn.addPermission("CloudFrontInvokeUrl", { principal, action: "lambda:InvokeFunctionUrl", sourceArn });
    this.fn.addPermission("CloudFrontInvoke", { principal, action: "lambda:InvokeFunction", sourceArn, invokedViaFunctionUrl: true });
    return {
      ...config,
      originProperty: { ...config.originProperty!, originAccessControlId: this.oac.originAccessControlId },
    };
  }
}

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
  /** 移行用（--context keepEnvSecrets=true）。渡すと鍵をLambda環境変数にも残す。通常は渡さない */
  readonly envSecrets?: Secrets;
  /**
   * `cdk import` 用。CloudFormationはimport操作中に新しい資源を作れないので、
   * ロール・ポリシー・Lambda Permissionを出さず、既存ロールを参照する。
   */
  readonly importPhase: boolean;
  /**
   * CloudFront 固定ドメイン（ロードマップ3）に要る us-east-1 の資源（lib/toytalker-edge-stack.ts）。
   * 渡すとディストリビューションを作る。importPhase では渡さない
   */
  readonly edge?: { readonly certificate: acm.ICertificate; readonly webAclArn?: string };
}

/**
 * DynamoDBテーブルの機能名。実名は `toytalker-<機能名><config.tableSuffix>`（docs/naming-conventions.md）。
 * Lambdaには環境変数 TABLE_SUFFIX を渡し、コード側は backend/shared/tables.mjs の tableName() で同じ形に組む。
 */
type TableKey =
  | "devices"
  | "characters"
  | "voices"
  | "llms"
  | "chat-logs"
  | "usage"
  | "api-unit-prices"
  | "exchange-rates"
  | "users";

interface FunctionSpec {
  /** 機能名（docs/naming-conventions.md）。新名は `toytalker-<key>-<環境>`、部品IDは PascalCase（chat-app → ChatApp） */
  readonly key: string;
  /** 改名前のRnDで使う部品IDと固定名（config.legacyNames のとき）。変えると作り直しになる */
  readonly legacy: { readonly id: string; readonly name: string };
  /** backend/ のディレクトリ名（RnDの改名と同時に機能名へ直す） */
  readonly dir: string;
  readonly memorySize: number;
  readonly timeoutSeconds: number;
  readonly format: BundleFormat;
  /** ESMバンドル内で依存が require() を使う（undici）ので createRequire を先頭に足す */
  readonly requireShim?: boolean;
  readonly description?: string;
  /** 秘密でない設定（環境変数） */
  readonly env: readonly string[];
  /** 実行時にSSMから読む鍵。名前を環境変数 SECRET_PARAMS で渡し、読み取り権限を付ける */
  readonly secrets: readonly SecretName[];
  readonly url?: {
    readonly invokeMode: "RESPONSE_STREAM" | "BUFFERED";
    readonly cors?: lambda.CfnUrl.CorsProperty;
    /**
     * 固定ドメイン（config.apiDomain）での経路。CloudFront がこの path pattern の要求をこの Function URL へ送る。
     * Lambda には path がそのまま届く（本文・相槌・鍵発行・読み上げは path を見ない）。"default" はそれ以外の全部で、
     * `/devices` `/characters` `/voices` `/logs/*` `/usage*` `/custom-voices*` を自分で振り分ける設定Lambdaに割り当てる
     */
    readonly route: string | "default";
  };
  /** 温めルール（5分ごと）の対象。並び順がターゲットID（warm1〜）になる。既存はESP32用メインが先 */
  readonly warm: boolean;
  /** 実リクエスト中に自分自身へwarmup pingを投げる（予備インスタンス温め）。自分へのInvoke権限が要る */
  readonly selfWarm: boolean;
  readonly readTables: readonly TableKey[];
  readonly readWriteTables: readonly TableKey[];
  /** 読み取りに加えて UpdateItem だけ許すテーブル（Put/Delete は許さない） */
  readonly updateTables?: readonly TableKey[];
}

/** 認証トークンを載せるヘッダー（backend/shared/auth.mjs の TOKEN_HEADER、app/lib/api.ts）。Authorization は CloudFront の OAC が上書きするので別名 */
const TOKEN_HEADER = "x-toytalker-token";

// Function URLのCORS（ブラウザから呼ぶときだけ効く。アプリ・ESP32には関係ない）
const CORS_GET_ONLY: lambda.CfnUrl.CorsProperty = {
  allowCredentials: false,
  allowHeaders: ["content-type", "authorization", TOKEN_HEADER],
  allowMethods: ["GET"],
  allowOrigins: ["*"],
  exposeHeaders: ["date, content-type, transfer-encoding"],
};

const TTS_ENV = ["CARTESIA_DEFAULT_VOICE_ID", "ZAKICORP_TTS_URL"] as const;
/** 利用者認証（backend/shared/auth.mjs）。アプリから呼ばれる Lambda に配る。ESP32 用は AUTH_REQUIRED だけ（未登録機の門） */
const AUTH_ENV = ["AUTH_REQUIRED", "COGNITO_USER_POOL_ID", "COGNITO_CLIENT_ID"] as const;

const TTS_SECRETS = [
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "ELEVENLABS_API_KEY",
  "FISHAUDIO_API_KEY",
  "SAKURA_API_KEY",
  "CARTESIA_API_KEY",
  "ZAKICORP_API_KEY",
  "ZAKICORP_EDGE_KEY",
] as const;

/** 環境ごとの部品IDと固定名（docs/naming-conventions.md）。RnDは改名まで旧名 */
function resolveNames(spec: FunctionSpec, config: StageConfig): { id: string; name: string } {
  if (config.legacyNames) return spec.legacy;
  const id = spec.key.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase());
  return { id, name: `toytalker-${spec.key}-${config.stage}` };
}

/** 月次レポートが「単価行なし」の警告を拾う記録側Lambda */
const RECORDING_FUNCTION_KEYS = ["chat-app", "chat-mcu", "read-aloud-app"] as const;

const FUNCTIONS: readonly FunctionSpec[] = [
  {
    key: "chat-mcu",
    legacy: { id: "Esp32Stream", name: "toytalk-api-stream-for-esp32-lambda" },
    dir: "toytalk-api-stream-for-esp32-lambda",
    memorySize: 2048,
    timeoutSeconds: 120,
    format: "esm",
    requireShim: true,
    env: [...TTS_ENV, "AUTH_REQUIRED"],
    secrets: [...TTS_SECRETS, "ANTHROPIC_API_KEY", "BRAVE_API_KEY"],
    url: { invokeMode: "RESPONSE_STREAM", cors: CORS_GET_ONLY, route: "/chat-mcu" },
    warm: true,
    selfWarm: true,
    readTables: ["devices", "characters", "voices", "llms", "api-unit-prices", "exchange-rates"],
    readWriteTables: ["chat-logs", "usage"],
  },
  {
    key: "chat-app",
    legacy: { id: "StreamHandler", name: "toytalk-stream-handler-lambda" },
    dir: "toytalk-stream-handler-lambda",
    memorySize: 2048,
    timeoutSeconds: 120,
    format: "esm",
    env: [...TTS_ENV, ...AUTH_ENV],
    secrets: [...TTS_SECRETS, "ANTHROPIC_API_KEY", "BRAVE_API_KEY"],
    url: { invokeMode: "RESPONSE_STREAM", cors: CORS_GET_ONLY, route: "/chat-app" },
    warm: true,
    selfWarm: true,
    readTables: ["characters", "voices", "llms", "api-unit-prices", "exchange-rates"],
    readWriteTables: ["chat-logs", "usage", "users"], // users は初回ログインの行作成（backend/shared/auth.mjs の resolveOwner）
  },
  {
    key: "backchannel-app",
    legacy: { id: "BackchannelApp", name: "toytalker-backchannel-for-app-lambda" },
    dir: "toytalker-backchannel-for-app-lambda",
    memorySize: 1024,
    timeoutSeconds: 20,
    format: "esm",
    env: [...TTS_ENV, ...AUTH_ENV],
    secrets: [...TTS_SECRETS, "ANTHROPIC_API_KEY"],
    url: { invokeMode: "RESPONSE_STREAM", cors: CORS_GET_ONLY, route: "/backchannel-app" },
    warm: true,
    selfWarm: true,
    readTables: ["characters", "voices"],
    readWriteTables: [],
  },
  {
    key: "backchannel-mcu",
    legacy: { id: "BackchannelEsp32", name: "toytalker-backchannel-for-esp32-lambda" },
    dir: "toytalker-backchannel-for-esp32-lambda",
    memorySize: 1024,
    timeoutSeconds: 20,
    format: "esm",
    requireShim: true,
    env: [...TTS_ENV, "AUTH_REQUIRED"],
    secrets: [...TTS_SECRETS, "ANTHROPIC_API_KEY"],
    url: { invokeMode: "BUFFERED", route: "/backchannel-mcu" },
    warm: true,
    selfWarm: true,
    readTables: ["devices", "characters", "voices"],
    readWriteTables: [],
  },
  {
    key: "stt-token",
    legacy: { id: "SonioxStt", name: "toytalk-soniox-stt-lambda" },
    dir: "toytalk-soniox-stt-lambda",
    memorySize: 256, // 128ではコールドスタート時のSSM取得が約0.9秒（他は1〜2GBで約0.2秒）。256へ（ロードマップ9、2026-10-28）
    timeoutSeconds: 5, // OTA判定でS3のmanifestを読むため3→5（2026-09-16）
    format: "esm",
    env: ["SONIOX_MODEL", "FIRMWARE_BUCKET", ...AUTH_ENV],
    secrets: ["SONIOX_API_KEY"],
    url: { invokeMode: "BUFFERED", cors: CORS_GET_ONLY, route: "/stt-token" },
    warm: true,
    selfWarm: false,
    readTables: ["devices"],
    readWriteTables: [],
    updateTables: ["devices"], // firmware_version 等を UpdateItem で記録（Put/Delete は不要）
  },
  {
    key: "settings-app",
    legacy: { id: "DeviceSetting", name: "toytalker-device-setting-lambda" },
    dir: "toytalker-device-setting-lambda",
    memorySize: 256,
    timeoutSeconds: 60,
    format: "cjs",
    env: ["ZAKICORP_TTS_URL", ...AUTH_ENV],
    secrets: ["CARTESIA_API_KEY", "ZAKICORP_API_KEY", "ZAKICORP_EDGE_KEY"],
    url: { invokeMode: "BUFFERED", cors: CORS_GET_ONLY, route: "default" },
    warm: false,
    selfWarm: false,
    // 書くのは devices / characters / voices / users だけ（index.mjs の Put/Update/Delete の対象）。
    // 単価・為替・LLM一覧・会話ログ・使用量は読むだけなので、IAMでも書けないようにする（2026-10-25）
    readTables: ["llms", "chat-logs", "usage", "api-unit-prices", "exchange-rates"],
    readWriteTables: ["devices", "characters", "voices", "users"],
  },
  {
    key: "read-aloud-app",
    legacy: { id: "TtsOnly", name: "toytalker-tts-only-lambda" },
    dir: "toytalker-tts-only-lambda",
    memorySize: 2048,
    timeoutSeconds: 120,
    format: "esm",
    env: [...TTS_ENV, ...AUTH_ENV],
    secrets: [...TTS_SECRETS],
    url: {
      invokeMode: "RESPONSE_STREAM",
      cors: {
        allowHeaders: ["content-type", "authorization", TOKEN_HEADER],
        allowMethods: ["POST", "GET"],
        allowOrigins: ["*"],
        exposeHeaders: ["content-type", "x-audio-format", "content-disposition"],
      },
      route: "/read-aloud-app",
    },
    warm: false,
    selfWarm: false,
    readTables: ["voices", "api-unit-prices", "exchange-rates"],
    readWriteTables: ["usage", "users"],
  },
  {
    key: "ops-monthly",
    legacy: { id: "OpsMonthly", name: "toytalker-ops-monthly-lambda" },
    dir: "toytalker-ops-monthly-lambda",
    memorySize: 256,
    timeoutSeconds: 300,
    format: "esm",
    description: "Monthly ops report: FX rate, recorded cost vs provider bills, price table checks",
    env: ["OPS_SNS_TOPIC_ARN", "RECORDING_LOG_GROUPS"],
    secrets: ["ELEVENLABS_API_KEY", "OPENAI_ADMIN_KEY", "ANTHROPIC_ADMIN_KEY"],
    warm: false,
    selfWarm: false,
    readTables: ["usage", "api-unit-prices"],
    readWriteTables: ["exchange-rates"],
  },
];

export class ToyTalkerStack extends cdk.Stack {
  private readonly config: StageConfig;

  constructor(scope: Construct, id: string, props: ToyTalkerStackProps) {
    super(scope, id, props);
    const { config, envSecrets, importPhase } = props;
    this.config = config;

    // ---- タグ（全資源。docs/naming-conventions.md） ----
    cdk.Tags.of(this).add("project", "toytalker");
    cdk.Tags.of(this).add("environment", config.stage);

    // ---- DynamoDB（データ入り。作り直さない） ----
    const tables = this.createTables(config.tableSuffix);

    // ---- S3: speaker embedding のバックアップ ----
    const speakersBucket = new s3.Bucket(this, "SpeakersBucket", {
      bucketName: config.speakersBucketName,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true, // 平文HTTPのアクセスを拒否するバケットポリシー（Security Hub S3.5。2026-10-25）
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---- SNS: 月次運用レポートの宛先 ----
    // スタックを消しても既存資源が消えないよう、データ以外も RETAIN にする（Function URLは消えるとホスト名が変わる）
    const RETAIN = cdk.RemovalPolicy.RETAIN;
    // Lambda以外の固定名（旧名は環境名なし）
    const fixed = config.legacyNames
      ? { opsTopic: "toytalker-ops-monthly", warmer: "toytalker-lambda-warmer", opsSchedule: "toytalker-ops-monthly" }
      : { opsTopic: `toytalker-ops-monthly-${config.stage}`, warmer: `toytalker-warmer-${config.stage}`, opsSchedule: `toytalker-ops-monthly-${config.stage}` };
    const names = new Map(FUNCTIONS.map((spec) => [spec.key, resolveNames(spec, config)] as const));
    const nameOf = (key: string) => names.get(key)!;

    const opsTopic = new sns.Topic(this, "OpsMonthlyTopic", {
      topicName: fixed.opsTopic,
      enforceSSL: true, // 平文HTTPでのPublishを拒否するトピックポリシー（2026-10-25）
    });
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

    // ---- 利用者認証: Cognito（ロードマップ4、docs/auth.md） ----
    const auth = this.createAuth(config, importPhase);

    const allEnv: Record<string, string> = {
      AUTH_REQUIRED: String(config.auth.required),
      COGNITO_USER_POOL_ID: auth.userPool.userPoolId,
      COGNITO_CLIENT_ID: auth.client.userPoolClientId,
      CARTESIA_DEFAULT_VOICE_ID: config.cartesiaDefaultVoiceId,
      ZAKICORP_TTS_URL: config.zakicorpTtsUrl,
      SONIOX_MODEL: config.sonioxModel,
      FIRMWARE_BUCKET: config.firmwareBucketName,
      OPS_SNS_TOPIC_ARN: opsTopic.topicArn,
      RECORDING_LOG_GROUPS: JSON.stringify(RECORDING_FUNCTION_KEYS.map((k) => `/aws/lambda/${nameOf(k).name}`)),
    };

    const functions = new Map<string, lambda.Function>();
    const urls = new Map<string, lambda.CfnUrl>();
    const logGroups = new Map<string, logs.ILogGroup>();
    for (const spec of FUNCTIONS) {
      const { id, name } = nameOf(spec.key);
      const environment: Record<string, string> = {};
      for (const key of spec.env) {
        const value = allEnv[key];
        if (value === undefined) throw new Error(`${name}: 環境変数 ${key} の値がありません`);
        environment[key] = value;
      }
      environment.TABLE_SUFFIX = config.tableSuffix; // backend/shared/tables.mjs がテーブル名を組む
      environment.SECRET_PARAMS = JSON.stringify(Object.fromEntries(spec.secrets.map((n) => [n, SECRET_PARAMS[n]])));
      for (const name of spec.secrets) {
        const value = envSecrets?.[name];
        if (value !== undefined) environment[name] = value; // 移行の1段目だけ
      }

      const logGroup = new logs.LogGroup(this, `${id}Logs`, {
        logGroupName: `/aws/lambda/${name}`,
        retention: logs.RetentionDays.INFINITE,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      logGroups.set(spec.key, logGroup);

      const fn = new lambda.Function(this, id, {
        functionName: name,
        description: spec.description,
        code: bundleLambda(path.join(BACKEND_DIR, spec.dir), spec.format, spec.requireShim ?? false),
        handler: "index.handler",
        runtime: LAMBDA_RUNTIME,
        architecture: config.architecture === "arm64" ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64,
        memorySize: spec.memorySize,
        timeout: cdk.Duration.seconds(spec.timeoutSeconds),
        environment,
        logGroup,
        role: spec.key === "ops-monthly" ? existingOpsRole : existingLambdaRole,
      });
      fn.applyRemovalPolicy(RETAIN);
      functions.set(spec.key, fn);

      if (spec.url) {
        // 入口は CloudFront の固定ドメイン（createApiDistribution）。Function URL を直接呼ぶ旧クライアントが残る間だけ
        // NONE + 公開ポリシーで直接も受け、全部が移ったら AWS_IAM にして CloudFront（OAC）だけが呼べるようにする。
        // authType の変更は作り直しにならない（ホスト名は変わらない）
        const url = new lambda.CfnUrl(this, `${id}Url`, {
          targetFunctionArn: fn.functionArn,
          authType: config.directFunctionUrls ? "NONE" : "AWS_IAM",
          invokeMode: spec.url.invokeMode,
          cors: spec.url.cors,
        });
        url.applyRemovalPolicy(RETAIN);
        urls.set(spec.key, url);
        if (!importPhase && config.directFunctionUrls) {
          fn.addPermission(`${id}UrlPublicAccess`, {
            principal: new iam.AnyPrincipal(),
            action: "lambda:InvokeFunctionUrl",
            functionUrlAuthType: lambda.FunctionUrlAuthType.NONE,
          });
          fn.addPermission(`${id}UrlInvokeAction`, {
            principal: new iam.AnyPrincipal(),
            action: "lambda:InvokeFunction",
            invokedViaFunctionUrl: true,
          });
        }
        new cdk.CfnOutput(this, `${id}FunctionUrl`, { value: url.attrFunctionUrl });
      }

      if (!importPhase) {
        for (const t of spec.readTables) tables[t].grantReadData(fn);
        for (const t of spec.readWriteTables) tables[t].grantReadWriteData(fn);
        for (const t of spec.updateTables ?? []) tables[t].grant(fn, "dynamodb:UpdateItem");
        // 秘密の実行時取得。SecureStringの復号はAWS管理キー（aws/ssm）ならSSM経由で許可される
        fn.addToRolePolicy(new iam.PolicyStatement({
          actions: ["ssm:GetParameters"],
          resources: spec.secrets.map((n) => this.formatArn({
            service: "ssm", resource: "parameter", resourceName: SECRET_PARAMS[n].replace(/^\//, ""),
          })),
        }));
        if (spec.selfWarm) {
          // 自分自身へのInvoke。関数ARNをトークンで参照すると循環になるので固定名から組み立てる
          fn.addToRolePolicy(new iam.PolicyStatement({
            actions: ["lambda:InvokeFunction"],
            resources: [this.formatArn({ service: "lambda", resource: "function", resourceName: name, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME })],
          }));
        }
      }
    }

    // ---- CloudFront 固定ドメイン（ロードマップ3） ----
    if (props.edge && !importPhase) this.createApiDistribution(config, props.edge, functions, urls);

    // ---- 怪しい要求・異常に気づく通知（ロードマップ4(b)） ----
    if (!importPhase) this.createApiAlarms(config, functions, logGroups, opsTopic);

    // ---- デバイス設定Lambda: クローンボイス登録でS3へ保存・削除 ----
    if (!importPhase) speakersBucket.grantReadWrite(functions.get("settings-app")!);

    // ---- ESP32ファームのOTA配布バケット（手作業で作成、CDKは参照のみ） ----
    // Soniox鍵発行Lambdaが manifest.json を読み、.bin の署名付きURL（10分）を返す。署名はロールの資格情報なので読み取り権限が要る
    const firmwareBucket = s3.Bucket.fromBucketName(this, "FirmwareBucket", config.firmwareBucketName);
    if (!importPhase) {
      firmwareBucket.grantRead(functions.get("stt-token")!);
      // 平文HTTPのアクセスを拒否（Security Hub S3.5。他のバケットの enforceSSL と同じ文）。バケット本体はCDK管理外のまま、
      // バケットポリシーだけをこのスタックが持つ（ロードマップ9、2026-10-28）。環境のバケットが無いと deploy で止まるので、
      // 新しい環境へ出す前にバケットを作る（置き場所の決定はロードマップ9）
      new s3.BucketPolicy(this, "FirmwareBucketPolicy", { bucket: firmwareBucket }).document.addStatements(
        new iam.PolicyStatement({
          sid: "DenyInsecureTransport",
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ["s3:*"],
          resources: [firmwareBucket.bucketArn, firmwareBucket.arnForObjects("*")],
          conditions: { Bool: { "aws:SecureTransport": "false" } },
        }),
      );
    }

    // ---- 消されても戻せる仕組み: AWS Backup + Vault Lock（ロードマップ10(a)） ----
    if (config.backup && !importPhase) {
      // CloudTrail の保管先（toytalker-org スタック、管理アカウントだけ）も金庫に入れる。操作記録を消されても戻せるようにする
      const cloudTrailBucket = config.organizationId
        ? [s3.Bucket.fromBucketName(this, "CloudTrailBucketRef", CLOUDTRAIL_BUCKET_NAME)]
        : [];
      this.createImmutableBackup(config, Object.values(tables), [speakersBucket, firmwareBucket, ...cloudTrailBucket]);
    }

    // ---- 温めルール（5分ごと、5本へ {"warmup":true}） ----
    const warmTargets = FUNCTIONS.filter((s) => s.warm).map((s) => functions.get(s.key)!);
    const warmer = new events.CfnRule(this, "WarmerRule", {
      name: fixed.warmer,
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
    const opsFn = functions.get("ops-monthly")!;
    if (!importPhase) {
      opsTopic.grantPublish(opsFn);
      opsFn.addToRolePolicy(new iam.PolicyStatement({
        actions: ["logs:FilterLogEvents"],
        resources: RECORDING_FUNCTION_KEYS.map((k) => logGroups.get(k)!.logGroupArn),
      }));
    }
    const opsSchedule = new scheduler.Schedule(this, "OpsMonthlySchedule", {
      scheduleName: fixed.opsSchedule,
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

    this.acknowledgeNagFindings();
  }

  /**
   * cdk-nag（`cdk synth --context nag=true`）で意図して受け入れている指摘。根拠は docs/security-review-2026-10-25.md。
   * ここに無い指摘が出たら、直すか、理由を書いてここに足す。
   */
  private acknowledgeNagFindings(): void {
    const ack = (id: string, reason: string) => cdk.Validations.of(this).acknowledge({ id, reason });
    ack("AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole]",
      "Lambdaの標準ロググループ書き込み（CloudWatch Logs のみ）。resourceは自関数のログに限られる");
    for (const action of ["s3:GetObject*", "s3:GetBucket*", "s3:List*", "s3:DeleteObject*", "s3:Abort*"]) {
      ack(`AwsSolutions-IAM5[Action::${action}]`, "grantRead / grantReadWrite が生成する動詞のワイルドカード。対象は1バケットに限定");
    }
    ack("AwsSolutions-IAM5[Resource::arn:<AWS::Partition>:s3:::toytalker-firmware/*]",
      "ファーム配布バケットのオブジェクト全部を読む（manifest と .bin）。バケット1つに限定");
    ack("AwsSolutions-IAM5[Resource::<SpeakersBucket6044DDC1.Arn>/*]",
      "クローンボイスの speaker embedding を保存・削除する。バケット1つに限定");
    ack("AwsSolutions-IAM5[Resource::<OpsMonthlyCC65D2A5.Arn>:*]",
      "EventBridge Scheduler が月次Lambdaのバージョン付きARNも呼べるようCDKが付ける。関数1つに限定");
    ack("AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForBackup]",
      "AWS Backup のサービスロール。対象資源のバックアップに必要な動詞を AWS が保守する標準ポリシー（ロードマップ10）");
    ack("AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSBackupServiceRolePolicyForRestores]",
      "同上（復元）");
    ack("AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/AWSBackupServiceRolePolicyForS3Backup]",
      "同上（S3 のバックアップ。開発者ガイドが指定する管理ポリシー）");
    ack("AwsSolutions-IAM4[Policy::arn:<AWS::Partition>:iam::aws:policy/AWSBackupServiceRolePolicyForS3Restore]",
      "同上（S3 の復元）");
    ack("AwsSolutions-COG2", "ログインは Google / Apple の外部IdP（各社側の2段階認証）。Cognito 側の MFA は federated 利用者に掛からず、試験用の Cognito 利用者だけに掛かるので置かない（ロードマップ4）");
    ack("AwsSolutions-COG8", "脅威防御（Plus プラン、$0.05/MAU）は置かない。ログインは外部IdP側の守りに乗り、費用燃やしの天井は WAF のレート制限と前払いポイントで作る。本番で利用者が増えたら再検討（ロードマップ4）");
    ack("AwsSolutions-IAM5[Resource::<UsersTable9725E9C8.Arn>/index/*]",
      "users テーブルの GSI（owner_id-index）を読む。grantReadWriteData が index/* で付ける。テーブル1つに限定");
    ack("AwsSolutions-S1", "非公開・単一利用者のバケット。アクセスログ用バケットを増やす価値が小さい（CloudTrail でAPI操作は追える）");
    ack("Serverless-LambdaDLQ", "呼び出しは Function URL（同期）と温め・月次（失敗はログで見て手動再実行）。DLQ を置く非同期処理が無い");
    ack("Serverless-EventBusDLQ", "温めpingのみ。取りこぼしても5分後に再実行される");
    ack("Serverless-SNSRedrivePolicy", "メール購読のみ。配信失敗の再処理先は不要");
    ack("Serverless-CloudWatchLogGroupRetentionPeriod", "引き取り時の設定（無期限）を維持。保持期間はロードマップ8(e)で決める");
    ack("Serverless-LambdaTracing", "X-Ray は使っていない。必要になったら有効化する（費用と情報量の追加）");
    ack("AwsSolutions-CFR1", "海外の利用者が使うAPIなので地域制限は掛けない（ロードマップ3、2026-10-27決定）。天井は WAF のレート制限");
    ack("AwsSolutions-CFR3", "アクセスログには送信元IPが入る。IPは個人に結びつくので残さない（2026-10-28決定）。国コードだけを Lambda ログに書く");
    if (this.config.apiRateLimitPer5Min === undefined) {
      ack("AwsSolutions-CFR2", "WAF は本番だけ（2026-10-29決定、docs/deferred-items.md）。RnD は Function URL の IAM 認証化で直叩きを塞ぎ、天井は4の認証とポイント制で作る");
    }
  }

  /**
   * 固定ドメイン `config.apiDomain` の CloudFront ディストリビューション（ロードマップ3）。
   *
   * - 目的は3つ: (1) URLの固定（Function URL のホスト名はスタックを作り直すと変わる。アプリ・ESP32に直書きだった）、
   *   (2) WAF のレート制限（費用燃やしの天井。脅威モデル#1。本番だけ。stages.ts の apiRateLimitPer5Min）、
   *   (3) 国コード（CloudFront-Viewer-Country）を Lambda ログへ。
   * - 1つのドメインに経路で振り分ける（FunctionSpec.url.route）。キャッシュはしない。ストリーミング応答はそのまま通る。
   * - オリジンは Function URL + OAC（SigV4 署名）。Function URL を AWS_IAM にすれば CloudFront だけが呼べる。
   *   署名の都合で、本文のある要求（POST/PUT）はクライアントが本文の SHA-256 を `x-amz-content-sha256` で添える
   *   （CloudFront 開発者ガイド「Restrict access to an AWS Lambda function URL origin」）。アプリは app/lib/api.ts、ESP32 は sha256Hex()。
   * - オリジンへ渡すヘッダーは allowList（Host を渡すと Function URL が受け付けない）。`Authorization` は OAC が上書きするので
   *   渡らない。認証（ロードマップ4）のトークンは別名のヘッダーにし、ここの allowList にも足す
   * - 応答待ちは 60 秒（最初の1バイトまで、および途中のパケット間隔。既定30秒。LLM の初回トークンが遅いときの保険）
   */
  private createApiDistribution(
    config: StageConfig,
    edge: NonNullable<ToyTalkerStackProps["edge"]>,
    functions: ReadonlyMap<string, lambda.Function>,
    urls: ReadonlyMap<string, lambda.CfnUrl>,
  ): void {
    const oac = new cloudfront.FunctionUrlOriginAccessControl(this, "ApiOriginAccessControl", {
      originAccessControlName: `toytalker-api-${config.stage}`,
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });
    const originRequestPolicy = new cloudfront.OriginRequestPolicy(this, "ApiOriginRequestPolicy", {
      originRequestPolicyName: `toytalker-api-${config.stage}`,
      comment: "ToyTalker API: all query strings, selected headers + viewer country, no cookies",
      headerBehavior: cloudfront.OriginRequestHeaderBehavior.allowList(
        "content-type",
        "accept",
        "user-agent",
        "origin",
        "access-control-request-method",
        "access-control-request-headers",
        "cloudfront-viewer-country",
        TOKEN_HEADER, // 認証トークン（ロードマップ4）。Authorization は OAC が上書きするので別名
        // x-amz-content-sha256 は書けない（CloudFront が「not allowed」で拒否。OAC が署名用に自分で扱う。2026-10-29 deploy で判明）
      ),
      queryStringBehavior: cloudfront.OriginRequestQueryStringBehavior.all(),
      cookieBehavior: cloudfront.OriginRequestCookieBehavior.none(),
    });

    const behaviorFor = (key: string): cloudfront.BehaviorOptions => ({
      origin: new LambdaUrlOrigin(functions.get(key)!, urls.get(key)!, oac, {
        originId: key,
        readTimeout: cdk.Duration.seconds(60),
        keepaliveTimeout: cdk.Duration.seconds(60),
      }),
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
      compress: false, // 音声バイナリと SSE。圧縮は効かず、ストリーミングの妨げになる
    });
    const routed = FUNCTIONS.filter((s) => s.url);
    const defaults = routed.filter((s) => s.url!.route === "default");
    if (defaults.length !== 1) throw new Error(`route "default" の Lambda は1つだけ（今は ${defaults.map((s) => s.key).join(", ")}）`);
    const additionalBehaviors: Record<string, cloudfront.BehaviorOptions> = {};
    for (const spec of routed) if (spec.url!.route !== "default") additionalBehaviors[spec.url!.route] = behaviorFor(spec.key);

    const distribution = new cloudfront.Distribution(this, "ApiDistribution", {
      comment: `ToyTalker API ${config.stage} (${config.apiDomain})`,
      domainNames: [config.apiDomain],
      certificate: edge.certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      webAclId: edge.webAclArn, // undefined なら WAF なし
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      defaultBehavior: behaviorFor(defaults[0].key),
      additionalBehaviors,
      enableLogging: false, // アクセスログは送信元IPを含むので取らない（acknowledgeNagFindings の CFR3）
    });
    // 消えるとドメインの向き先が無くなる。スタックを消しても残す（Function URL と同じ扱い）
    distribution.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    new cdk.CfnOutput(this, "ApiDomain", { value: `https://${config.apiDomain}` });
    new cdk.CfnOutput(this, "ApiDistributionDomainName", {
      value: distribution.distributionDomainName,
      description: `Cloudflare に CNAME ${config.apiDomain} -> この値（DNS only）を置く`,
    });
  }

  /**
   * DynamoDB 全テーブルと S3 バケット（speakers・firmware、管理アカウントでは CloudTrail も）を日次で保管庫に取り、Vault Lock（コンプライアンスモード）で
   * 保持日数が過ぎるまで誰にも（管理者・root・AWS）消せなくする。守る相手は障害でなく権限の誤用
   * （管理者権限の乗っ取り、AI操作の誤承認）なので、別リージョン・別アカウントへは出さない（2026-10-27決定）。
   *
   * - 保管庫名 `toytalker-backup-<環境>`。ロック確定後は保管庫も設定も変えられない。復旧点が全部期限切れになれば消せる
   * - 最小保持 = retentionDays、最大 = その+1日（CDKが最小＜最大を要求する）。最大も縛るのは、無期限の復旧点を誰かが入れて
   *   保管庫が永久に消せなくなるのを防ぐため
   * - 確定までの猶予は AWS の下限 3日。その間に初回バックアップと復元を確かめ、問題があればロックを外せる
   * - S3 は定期（スナップショット）方式。継続方式は EventBridge 通知が要り、CDK管理外の `toytalker-firmware` を触るので使わない
   * - DynamoDB はアカウント設定「高度な機能」が有効（2026-10-28確認）。無効だとバックアップが DynamoDB 側の管理になり保管庫のロックが効かない
   * - 暗号化は AWS 管理キー（aws/backup）。CMK は本番で
   */
  private createImmutableBackup(config: StageConfig, tables: readonly dynamodb.ITable[], buckets: readonly s3.IBucket[]): void {
    const retention = cdk.Duration.days(config.backup!.retentionDays);
    const vault = new backup.BackupVault(this, "BackupVault", {
      backupVaultName: `toytalker-backup-${config.stage}`,
      lockConfiguration: { minRetention: retention, maxRetention: retention.plus(cdk.Duration.days(1)), changeableFor: cdk.Duration.days(3) },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // バックアップと復元の両方に使うロール。S3 には専用の管理ポリシーが要る（AWS Backup 開発者ガイド「Amazon S3 backups」）
    const role = new iam.Role(this, "BackupRole", {
      assumedBy: new iam.ServicePrincipal("backup.amazonaws.com"),
      description: "ToyTalker AWS Backup: backup and restore DynamoDB tables and S3 buckets",
      managedPolicies: [
        "service-role/AWSBackupServiceRolePolicyForBackup",
        "service-role/AWSBackupServiceRolePolicyForRestores",
        "AWSBackupServiceRolePolicyForS3Backup",
        "AWSBackupServiceRolePolicyForS3Restore",
      ].map((n) => iam.ManagedPolicy.fromAwsManagedPolicyName(n)),
    });

    const plan = new backup.BackupPlan(this, "BackupPlan", {
      backupPlanName: `toytalker-backup-${config.stage}`,
      backupVault: vault,
      backupPlanRules: [
        new backup.BackupPlanRule({
          ruleName: "daily",
          backupVault: vault,
          scheduleExpression: events.Schedule.cron({ minute: "0", hour: "18" }), // 03:00 JST
          startWindow: cdk.Duration.hours(1),
          completionWindow: cdk.Duration.hours(4),
          deleteAfter: retention,
        }),
      ],
    });
    plan.addSelection("Selection", {
      backupSelectionName: `toytalker-backup-${config.stage}`,
      role,
      disableDefaultBackupPolicy: true,
      resources: [
        ...tables.map((t) => backup.BackupResource.fromDynamoDbTable(t)),
        ...buckets.map((b) => backup.BackupResource.fromArn(b.bucketArn)),
      ],
    });
    new cdk.CfnOutput(this, "BackupRoleArn", { value: role.roleArn, description: "IAM role for restore jobs (pass to start-restore-job --iam-role-arn)" });
  }

  private createTables(tableSuffix: string): Record<TableKey, dynamodb.Table> {
    const S = dynamodb.AttributeType.STRING;
    const defs: Record<TableKey, { pk: string; sk?: string }> = {
      "devices": { pk: "device_id" },
      "characters": { pk: "character_id" },
      "voices": { pk: "voice_id" },
      "llms": { pk: "llm_id" },
      "chat-logs": { pk: "owner_id#device_id", sk: "session_id#timestamp" },
      "usage": { pk: "owner_id", sk: "date#device_id#api_type" },
      "api-unit-prices": { pk: "provider#api_type", sk: "version" },
      "exchange-rates": { pk: "month", sk: "currency" },
      "users": { pk: "sub" }, // Cognito の sub → owner_id（ロードマップ4、docs/auth.md）
    };
    const tables = {} as Record<TableKey, dynamodb.Table>;
    for (const [key, def] of Object.entries(defs) as [TableKey, { pk: string; sk?: string }][]) {
      // 部品IDは環境名を含めない（DevicesTable など。スタック名が環境を持つ）
      const id = key.replace(/(^|-)(\w)/g, (_, __, c: string) => c.toUpperCase()) + "Table";
      tables[key] = new dynamodb.Table(this, id, {
        tableName: `toytalker-${key}${tableSuffix}`,
        partitionKey: { name: def.pk, type: S },
        sortKey: def.sk ? { name: def.sk, type: S } : undefined,
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        deletionProtection: true,
        // 誤った書き換え・削除・投入ミスから35日以内の任意の時点へ戻せるようにする（2026-10-25）
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
    }
    // 初回ログインで端末の owner_id を結び付けるとき「すでに誰かのものか」を引く（backend/shared/auth.mjs の ownerTaken）
    tables.users.addGlobalSecondaryIndex({
      indexName: "owner_id-index",
      partitionKey: { name: "owner_id", type: S },
      projectionType: dynamodb.ProjectionType.KEYS_ONLY,
    });
    return tables;
  }

  /**
   * 利用者認証（ロードマップ4、docs/auth.md）。Cognito ユーザープール + ログイン画面（managed login）+ 外部IdP + アプリ用クライアント。
   *
   * - 自己サインアップは無し。ログインは Google / Sign in with Apple（stages.ts の auth.google / auth.apple があるとき）。
   *   試験用に Cognito の利用者を `admin-create-user` で作ることはできる（メール + パスワード）
   * - アプリは認可コード + PKCE（公開クライアント、シークレット無し）でログイン画面を開き、ID トークンを `x-toytalker-token` で送る。
   *   Lambda は backend/shared/auth.mjs で検証する（JWKS は容器内キャッシュ。ネットワーク越しの認証を音声の経路に挟まない）
   * - IdP の秘密は Secrets Manager（lib/secrets.ts の IDP_SECRETS）。`{{resolve:secretsmanager}}` で deploy 時に読み、テンプレートに残らない
   * - 料金プランは Essentials（managed login に要る。MAU 1万まで無料）。脅威防御（Plus）は置かない（acknowledgeNagFindings の COG8）
   * - 同じ人が Google と Apple でログインしても1人にする: 登録前トリガー（backend/toytalker-auth-presignup-lambda）が、
   *   IdP が検証した同じメールの既存利用者に新しい IdP をリンクする（2026-10-29決定。docs/auth.md）
   * - 消すとログインできなくなり、sub が全部変わる（users テーブルの対応が無効になる）。RETAIN + 削除保護
   */
  private createAuth(config: StageConfig, importPhase: boolean): { userPool: cognito.UserPool; client: cognito.UserPoolClient } {
    const userPool = new cognito.UserPool(this, "UserPool", {
      userPoolName: `toytalker-auth-${config.stage}`,
      featurePlan: cognito.FeaturePlan.ESSENTIALS,
      selfSignUpEnabled: false,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      mfa: cognito.Mfa.OFF,
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    if (!importPhase) {
      // 登録前トリガー。FUNCTIONS の仕組み（Function URL・温め・テーブル権限）は使わないので、ここで直接作る
      const name = `toytalker-auth-presignup-${config.stage}`;
      const logGroup = new logs.LogGroup(this, "AuthPreSignUpLogs", {
        logGroupName: `/aws/lambda/${name}`,
        retention: logs.RetentionDays.INFINITE,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
      });
      const trigger = new lambda.Function(this, "AuthPreSignUp", {
        functionName: name,
        description: "Cognito PreSignUp: link external IdP sign-ins with the same verified email to one user",
        code: bundleLambda(path.join(BACKEND_DIR, "toytalker-auth-presignup-lambda"), "esm", false),
        handler: "index.handler",
        runtime: LAMBDA_RUNTIME,
        architecture: config.architecture === "arm64" ? lambda.Architecture.ARM_64 : lambda.Architecture.X86_64,
        memorySize: 256,
        timeout: cdk.Duration.seconds(10),
        logGroup,
      });
      // ロールの既定ポリシーに足すと「ポリシー → プール → Lambda → 既定ポリシー」の循環になる（Lambda はロール配下の既定ポリシーに依存する）。
      // 別のポリシーにして後からロールへ付ける
      new iam.Policy(this, "AuthPreSignUpPolicy", {
        statements: [new iam.PolicyStatement({
          actions: ["cognito-idp:ListUsers", "cognito-idp:AdminLinkProviderForUser"],
          resources: [userPool.userPoolArn],
        })],
      }).attachToRole(trigger.role!);
      userPool.addTrigger(cognito.UserPoolOperation.PRE_SIGN_UP, trigger);
    }

    const domain = userPool.addDomain("Domain", {
      cognitoDomain: { domainPrefix: config.auth.domainPrefix },
      managedLoginVersion: cognito.ManagedLoginVersion.NEWER_MANAGED_LOGIN,
    });

    const providers: cognito.UserPoolClientIdentityProvider[] = [cognito.UserPoolClientIdentityProvider.COGNITO];
    const idps: Construct[] = [];
    if (config.auth.google) {
      idps.push(new cognito.UserPoolIdentityProviderGoogle(this, "GoogleIdp", {
        userPool,
        clientId: config.auth.google.clientId,
        clientSecretValue: cdk.SecretValue.secretsManager(IDP_SECRETS.GOOGLE_OAUTH_CLIENT_SECRET),
        scopes: ["openid", "email", "profile"],
        attributeMapping: {
          email: cognito.ProviderAttribute.GOOGLE_EMAIL,
          emailVerified: cognito.ProviderAttribute.other("email_verified"),
          fullname: cognito.ProviderAttribute.GOOGLE_NAME,
        },
      }));
      providers.push(cognito.UserPoolClientIdentityProvider.GOOGLE);
    }
    if (config.auth.apple) {
      idps.push(new cognito.UserPoolIdentityProviderApple(this, "AppleIdp", {
        userPool,
        clientId: config.auth.apple.servicesId,
        teamId: config.auth.apple.teamId,
        keyId: config.auth.apple.keyId,
        privateKeyValue: cdk.SecretValue.secretsManager(IDP_SECRETS.APPLE_SIGNIN_PRIVATE_KEY),
        scopes: ["email", "name"],
        attributeMapping: {
          email: cognito.ProviderAttribute.APPLE_EMAIL,
          fullname: cognito.ProviderAttribute.APPLE_NAME,
        },
      }));
      providers.push(cognito.UserPoolClientIdentityProvider.APPLE);
    }

    const client = userPool.addClient("AppClient", {
      userPoolClientName: `toytalker-app-${config.stage}`,
      generateSecret: false, // アプリに秘密は置けない。PKCE で守る
      // 試験用の Cognito 利用者を CLI から試すため（admin-initiate-auth。AWS の資格情報が無いと呼べない）。本番の経路は OAuth（下）
      authFlows: { userSrp: true, adminUserPassword: true },
      oAuth: {
        flows: { authorizationCodeGrant: true },
        scopes: [cognito.OAuthScope.OPENID, cognito.OAuthScope.EMAIL, cognito.OAuthScope.PROFILE],
        callbackUrls: ["toytalk://auth/callback"], // app.json の scheme。app/lib/auth.ts と合わせる
        logoutUrls: ["toytalk://auth/signout"],
      },
      supportedIdentityProviders: providers,
      preventUserExistenceErrors: true,
      idTokenValidity: cdk.Duration.hours(1),
      accessTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(180), // 子ども向けの玩具なので、親が頻繁にログインし直さずに済む長さ
    });
    for (const idp of idps) client.node.addDependency(idp);

    // managed login は見た目の設定（branding）が無いとログイン画面がエラーになる。Cognito 既定の見た目を使う
    const branding = new cognito.CfnManagedLoginBranding(this, "ManagedLoginBranding", {
      userPoolId: userPool.userPoolId,
      clientId: client.userPoolClientId,
      useCognitoProvidedValues: true,
    });
    branding.node.addDependency(domain);

    const authDomain = `${config.auth.domainPrefix}.auth.${this.region}.amazoncognito.com`;
    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: client.userPoolClientId, description: "app/lib/auth.ts の EXPO_PUBLIC_COGNITO_CLIENT_ID" });
    new cdk.CfnOutput(this, "AuthDomain", { value: authDomain, description: "app/lib/auth.ts の EXPO_PUBLIC_COGNITO_DOMAIN。Google / Apple 側のリダイレクト先は https://<この値>/oauth2/idpresponse" });
    return { userPool, client };
  }

  /**
   * 怪しい要求・異常に気づく通知（ロードマップ4(b)、2026-10-29決定）。Lambda からメールは送らない（応答が遅れ、連打されるとメールも連打される）。
   * Lambda はログ1行（backend/shared/trace.mjs の status）を書くだけで、CloudWatch のメトリクスフィルタ + アラーム → 月次レポートと同じ
   * SNS トピックで1通にまとめて知らせる。アラーム1つ月 $0.10。
   *   - api-rejected: 5分間に 401/403 が REJECTED_PER_5MIN 件以上（トークン無し・不正トークン・他人の資源・未登録機）
   *   - api-invocations: アプリ・ESP32から呼ばれる Lambda の呼び出し合計が5分で INVOCATIONS_PER_5MIN 件以上（費用燃やし・連打）
   *   - api-errors: 同 Lambda のエラー（例外で落ちた呼び出し）が5分で ERRORS_PER_5MIN 件以上
   */
  private createApiAlarms(
    config: StageConfig,
    functions: ReadonlyMap<string, lambda.Function>,
    logGroups: ReadonlyMap<string, logs.ILogGroup>,
    topic: sns.ITopic,
  ): void {
    const REJECTED_PER_5MIN = 20;
    const INVOCATIONS_PER_5MIN = 600; // 1ターン = 本文1 + 相槌1 + 鍵発行(3分に1回)。温めは5分に5件。数家庭の同時利用でも届かない
    const ERRORS_PER_5MIN = 10;
    const period = cdk.Duration.minutes(5);
    const apiKeys = FUNCTIONS.filter((s) => s.url).map((s) => s.key);
    const namespace = "ToyTalker";
    const rejectedMetricName = `api-rejected-${config.stage}`;

    for (const key of apiKeys) {
      const { id } = resolveNames(FUNCTIONS.find((s) => s.key === key)!, config);
      new logs.MetricFilter(this, `${id}RejectedFilter`, {
        logGroup: logGroups.get(key)!,
        filterPattern: logs.FilterPattern.any(
          logs.FilterPattern.numberValue("$.status", "=", 401),
          logs.FilterPattern.numberValue("$.status", "=", 403),
        ),
        metricNamespace: namespace,
        metricName: rejectedMetricName,
        metricValue: "1",
        unit: cw.Unit.COUNT,
      });
    }
    const action = new cwActions.SnsAction(topic);
    const alarm = (id: string, name: string, metric: cw.IMetric, threshold: number, description: string) => {
      new cw.Alarm(this, id, {
        alarmName: `toytalker-${name}-${config.stage}`,
        alarmDescription: description,
        metric,
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(action);
    };
    alarm("ApiRejectedAlarm", "api-rejected",
      new cw.Metric({ namespace, metricName: rejectedMetricName, statistic: "Sum", period }),
      REJECTED_PER_5MIN, `ToyTalker ${config.stage}: ${REJECTED_PER_5MIN}+ requests rejected (401/403) in 5 minutes. See Lambda logs: filter status = 401 or 403 (auth, auth_reason, edge, ua)`);
    const sumOf = (name: string, pick: (fn: lambda.Function) => cw.Metric) => new cw.MathExpression({
      expression: "SUM(METRICS())",
      usingMetrics: Object.fromEntries(apiKeys.map((k, i) => [`${name}${i}`, pick(functions.get(k)!)])),
      period,
      label: name,
    });
    alarm("ApiInvocationsAlarm", "api-invocations",
      sumOf("inv", (fn) => fn.metricInvocations({ period, statistic: "Sum" })),
      INVOCATIONS_PER_5MIN, `ToyTalker ${config.stage}: ${INVOCATIONS_PER_5MIN}+ API Lambda invocations in 5 minutes (abuse or runaway client)`);
    alarm("ApiErrorsAlarm", "api-errors",
      sumOf("err", (fn) => fn.metricErrors({ period, statistic: "Sum" })),
      ERRORS_PER_5MIN, `ToyTalker ${config.stage}: ${ERRORS_PER_5MIN}+ API Lambda errors in 5 minutes`);
  }
}
