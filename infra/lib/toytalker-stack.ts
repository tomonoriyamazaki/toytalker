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
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { StageConfig } from "../config/stages.js";
import { SECRET_PARAMS, type SecretName, type Secrets } from "./secrets.js";

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
  /** 移行用（--context keepEnvSecrets=true）。渡すと鍵をLambda環境変数にも残す。通常は渡さない */
  readonly envSecrets?: Secrets;
  /**
   * `cdk import` 用。CloudFormationはimport操作中に新しい資源を作れないので、
   * ロール・ポリシー・Lambda Permissionを出さず、既存ロールを参照する。
   */
  readonly importPhase: boolean;
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
  | "exchange-rates";

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

// Function URLのCORS。既存設定をそのまま再現している（AllowHeadersがカンマ区切りの1要素なのも現状どおり）
const CORS_GET_ONLY: lambda.CfnUrl.CorsProperty = {
  allowCredentials: false,
  allowHeaders: ["content-type, authorization"],
  allowMethods: ["GET"],
  allowOrigins: ["*"],
  exposeHeaders: ["date, content-type, transfer-encoding"],
};

const TTS_ENV = ["CARTESIA_DEFAULT_VOICE_ID", "ZAKICORP_TTS_URL"] as const;

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
    env: [...TTS_ENV],
    secrets: [...TTS_SECRETS, "ANTHROPIC_API_KEY", "BRAVE_API_KEY"],
    url: { invokeMode: "RESPONSE_STREAM", cors: CORS_GET_ONLY },
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
    env: [...TTS_ENV],
    secrets: [...TTS_SECRETS, "ANTHROPIC_API_KEY", "BRAVE_API_KEY"],
    url: { invokeMode: "RESPONSE_STREAM", cors: CORS_GET_ONLY },
    warm: true,
    selfWarm: true,
    readTables: ["characters", "voices", "llms", "api-unit-prices", "exchange-rates"],
    readWriteTables: ["chat-logs", "usage"],
  },
  {
    key: "backchannel-app",
    legacy: { id: "BackchannelApp", name: "toytalker-backchannel-for-app-lambda" },
    dir: "toytalker-backchannel-for-app-lambda",
    memorySize: 1024,
    timeoutSeconds: 20,
    format: "esm",
    env: [...TTS_ENV],
    secrets: [...TTS_SECRETS, "ANTHROPIC_API_KEY"],
    url: { invokeMode: "RESPONSE_STREAM", cors: CORS_GET_ONLY },
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
    env: [...TTS_ENV],
    secrets: [...TTS_SECRETS, "ANTHROPIC_API_KEY"],
    url: { invokeMode: "BUFFERED" },
    warm: true,
    selfWarm: true,
    readTables: ["devices", "characters", "voices"],
    readWriteTables: [],
  },
  {
    key: "stt-token",
    legacy: { id: "SonioxStt", name: "toytalk-soniox-stt-lambda" },
    dir: "toytalk-soniox-stt-lambda",
    memorySize: 128,
    timeoutSeconds: 5, // OTA判定でS3のmanifestを読むため3→5（2026-09-16）
    format: "esm",
    env: ["SONIOX_MODEL", "FIRMWARE_BUCKET"],
    secrets: ["SONIOX_API_KEY"],
    url: { invokeMode: "BUFFERED", cors: CORS_GET_ONLY },
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
    env: ["ZAKICORP_TTS_URL"],
    secrets: ["CARTESIA_API_KEY", "ZAKICORP_API_KEY", "ZAKICORP_EDGE_KEY"],
    url: { invokeMode: "BUFFERED", cors: CORS_GET_ONLY },
    warm: false,
    selfWarm: false,
    // 書くのは devices / characters / voices だけ（index.mjs の Put/Update/Delete の対象）。
    // 単価・為替・LLM一覧・会話ログ・使用量は読むだけなので、IAMでも書けないようにする（2026-10-25）
    readTables: ["llms", "chat-logs", "usage", "api-unit-prices", "exchange-rates"],
    readWriteTables: ["devices", "characters", "voices"],
  },
  {
    key: "read-aloud-app",
    legacy: { id: "TtsOnly", name: "toytalker-tts-only-lambda" },
    dir: "toytalker-tts-only-lambda",
    memorySize: 2048,
    timeoutSeconds: 120,
    format: "esm",
    env: [...TTS_ENV],
    secrets: [...TTS_SECRETS],
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
    readTables: ["voices", "api-unit-prices", "exchange-rates"],
    readWriteTables: ["usage"],
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
  constructor(scope: Construct, id: string, props: ToyTalkerStackProps) {
    super(scope, id, props);
    const { config, envSecrets, importPhase } = props;

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

    const allEnv: Record<string, string> = {
      CARTESIA_DEFAULT_VOICE_ID: config.cartesiaDefaultVoiceId,
      ZAKICORP_TTS_URL: config.zakicorpTtsUrl,
      SONIOX_MODEL: config.sonioxModel,
      FIRMWARE_BUCKET: config.firmwareBucketName,
      OPS_SNS_TOPIC_ARN: opsTopic.topicArn,
      RECORDING_LOG_GROUPS: JSON.stringify(RECORDING_FUNCTION_KEYS.map((k) => `/aws/lambda/${nameOf(k).name}`)),
    };

    const functions = new Map<string, lambda.Function>();
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
        const url = new lambda.CfnUrl(this, `${id}Url`, {
          targetFunctionArn: fn.functionArn,
          authType: "NONE",
          invokeMode: spec.url.invokeMode,
          cors: spec.url.cors,
        });
        url.applyRemovalPolicy(RETAIN);
        if (!importPhase) {
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

    // ---- デバイス設定Lambda: クローンボイス登録でS3へ保存・削除 ----
    if (!importPhase) speakersBucket.grantReadWrite(functions.get("settings-app")!);

    // ---- ESP32ファームのOTA配布バケット（手作業で作成、CDKは参照のみ） ----
    // Soniox鍵発行Lambdaが manifest.json を読み、.bin の署名付きURL（10分）を返す。署名はロールの資格情報なので読み取り権限が要る
    const firmwareBucket = s3.Bucket.fromBucketName(this, "FirmwareBucket", config.firmwareBucketName);
    if (!importPhase) firmwareBucket.grantRead(functions.get("stt-token")!);

    // ---- 消されても戻せる仕組み: AWS Backup + Vault Lock（ロードマップ10(a)） ----
    if (config.backup && !importPhase) {
      this.createImmutableBackup(config, Object.values(tables), [speakersBucket, firmwareBucket]);
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
    ack("AwsSolutions-S1", "非公開・単一利用者のバケット。アクセスログ用バケットを増やす価値が小さい（CloudTrail でAPI操作は追える）");
    ack("Serverless-LambdaDLQ", "呼び出しは Function URL（同期）と温め・月次（失敗はログで見て手動再実行）。DLQ を置く非同期処理が無い");
    ack("Serverless-EventBusDLQ", "温めpingのみ。取りこぼしても5分後に再実行される");
    ack("Serverless-SNSRedrivePolicy", "メール購読のみ。配信失敗の再処理先は不要");
    ack("Serverless-CloudWatchLogGroupRetentionPeriod", "引き取り時の設定（無期限）を維持。保持期間はロードマップ8(e)で決める");
    ack("Serverless-LambdaTracing", "X-Ray は使っていない。必要になったら有効化する（費用と情報量の追加）");
  }

  /**
   * DynamoDB 全テーブルと S3 2バケットを日次で保管庫に取り、Vault Lock（コンプライアンスモード）で
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
    new cdk.CfnOutput(this, "BackupRoleArn", { value: role.roleArn, description: "復元ジョブ（start-restore-job --iam-role-arn）に渡すロール" });
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
    return tables;
  }
}
