// 環境ごとの設定。秘密でない値だけを置く（秘密は各アカウントのSSM Parameter Store。lib/secrets.ts）。
// 選択は `cdk deploy --context stage=<name>`。

export type StageName = "rnd" | "stg" | "prd" | "prd-dg";

export interface StageConfig {
  readonly stage: StageName;
  /** AWSアカウントID。デプロイ前に呼び出し元の資格情報と一致するか確認する（bin/toytalker.ts） */
  readonly account: string;
  readonly region: string;
  /** 月次運用レポート（SNS）の宛先 */
  readonly opsEmail: string;
  /** ZakiCorp TTS（クローンボイス）の公開URL。Cloudflare Tunnelで固定 */
  readonly zakicorpTtsUrl: string;
  /** Soniox STTのモデル名 */
  readonly sonioxModel: string;
  /** Cartesiaの既定ボイスID */
  readonly cartesiaDefaultVoiceId: string;
  /**
   * DynamoDBテーブル名の末尾（`toytalker-devices` + suffix）。Lambdaには環境変数 TABLE_SUFFIX で渡し、
   * コードは `backend/shared/tables.mjs` で組み立てる。RnDは改名（ロードマップ7）まで旧名なので空文字。
   */
  readonly tableSuffix: string;
  /** speaker embedding (.pt) のバックアップ先。S3バケット名は全世界で一意なので環境名を付ける */
  readonly speakersBucketName: string;
  /** ESP32ファームのOTA配布先（manifest.json と .bin）。Soniox鍵発行Lambdaが読んで署名付きURLを返す */
  readonly firmwareBucketName: string;
  /**
   * 消されても戻せる仕組み（ロードマップ10）。AWS Backup で DynamoDB 全テーブルと S3 2バケットを日次で
   * 保管庫 `toytalker-backup-<環境>` に取り、Vault Lock（コンプライアンスモード）で管理者にも root にも消せなくする。
   * `retentionDays` は保管庫の最小保持日数（最大はその+1日）で、ロック確定後は変えられない（変えるなら新しい保管庫）。
   * 省略した環境は保管庫を作らない。
   */
  readonly backup?: { readonly retentionDays: number };
  /**
   * Organizations の組織ID。管理アカウントの環境（RnD）にだけ置く。これがある環境では
   * 組織全体で1つの資源（CloudTrail 組織トレイル）を持つスタック `toytalker-org` も合成する。
   */
  readonly organizationId?: string;
  /**
   * 固定名を改名前の旧名（`toytalk-stream-handler-lambda`、スタック `ToyTalker-rnd` など）にするか。
   * RnDだけ true（改名はロードマップ7。部品IDも旧のまま）。false なら docs/naming-conventions.md の
   * `toytalker-<機能>-<環境>` とスタック `toytalker-<環境>`、部品IDは機能名のPascalCase。
   */
  readonly legacyNames: boolean;
  /** Lambdaのアーキテクチャ。arm64は料金2割減。切替は実機確認とセット */
  readonly architecture: "x86_64" | "arm64";
  /**
   * RnDの既存資源を `cdk import` で引き取る間だけ使う（--context importPhase=true）。
   * import時はCDKがロールを新規作成できないので、Lambdaに既存ロールを結び付けておき、
   * 引き取り後の `cdk deploy` でCDK管理の最小権限ロールへ差し替える。
   */
  readonly existingRoles?: {
    readonly lambdaRoleArn: string;
    readonly opsLambdaRoleArn: string;
    readonly schedulerRoleArn: string;
  };
}

const common = {
  region: "ap-northeast-1",
  opsEmail: "exodjp@gmail.com",
  zakicorpTtsUrl: "https://tts.zakicorp.com",
  sonioxModel: "stt-rt-v4",
  cartesiaDefaultVoiceId: "c7eafe22-8b71-40cd-850b-c5a3bbd8f8d2",
  architecture: "x86_64",
} as const;

export const stages: Record<StageName, StageConfig> = {
  // 現行アカウント。ToyTalkerの資源は手作業で作られたものをimportで引き取る。
  rnd: {
    ...common,
    stage: "rnd",
    account: "342082316736",
    legacyNames: true, // 改名（ロードマップ7）まで旧名。tableSuffix も同時に "-rnd" へ
    tableSuffix: "", // 既存テーブル名をそのまま維持。改名時に "-rnd" へ
    speakersBucketName: "toytalker-tts-speakers", // 既存バケット名をそのまま維持
    firmwareBucketName: "toytalker-firmware", // 手作業で作成済み（2026-09-16）。CDKは参照のみ
    backup: { retentionDays: 35 }, // 2026-10-27決定（同じアカウント、35日）。保管庫名は新規なので最初から新名
    organizationId: "o-lbme8l7xtz", // RnD = 管理アカウント。toytalker-org スタックをここに出す
    existingRoles: {
      lambdaRoleArn: "arn:aws:iam::342082316736:role/toytalk-lambda-role-dev",
      opsLambdaRoleArn: "arn:aws:iam::342082316736:role/toytalker-ops-monthly-role",
      schedulerRoleArn: "arn:aws:iam::342082316736:role/toytalker-ops-monthly-scheduler-role",
    },
  },
  // 以下はアカウント作成後に account を埋める。空のままだと bin/toytalker.ts が止める。
  stg: {
    ...common,
    stage: "stg",
    account: "131746731200", // 2026-10-14 create-account で作成
    legacyNames: false,
    tableSuffix: "-stg",
    speakersBucketName: "toytalker-tts-speakers-stg",
    firmwareBucketName: "toytalker-firmware-stg",
  },
  prd: {
    ...common,
    stage: "prd",
    account: "",
    legacyNames: false,
    tableSuffix: "-prd",
    speakersBucketName: "toytalker-tts-speakers-prd",
    firmwareBucketName: "toytalker-firmware-prd",
  },
  "prd-dg": {
    ...common,
    stage: "prd-dg",
    account: "",
    legacyNames: false,
    tableSuffix: "-prd-dg",
    speakersBucketName: "toytalker-tts-speakers-prd-dg",
    firmwareBucketName: "toytalker-firmware-prd-dg",
  },
};

/** CloudFormationスタック名。旧名は `ToyTalker-rnd`、新名は小文字で `toytalker-<環境>` */
export function stackName(config: StageConfig): string {
  return config.legacyNames ? `ToyTalker-${config.stage}` : `toytalker-${config.stage}`;
}

export function getStage(name: unknown): StageConfig {
  if (typeof name !== "string" || !(name in stages)) {
    throw new Error(
      `stage を指定してください: --context stage=<${Object.keys(stages).join("|")}>`,
    );
  }
  const config = stages[name as StageName];
  if (!config.account) {
    throw new Error(`stage=${name} の account が config/stages.ts に未設定です`);
  }
  return config;
}
