// 環境ごとの設定。秘密でない値だけを置く（秘密は各アカウントのSSM Parameter Store。lib/secrets.ts）。
// 選択は `cdk deploy --context stage=<name>`。

export type StageName = "rnd" | "stg" | "prod" | "prod-dg";

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
  /** speaker embedding (.pt) のバックアップ先。S3バケット名は全世界で一意なので環境名を付ける */
  readonly speakersBucketName: string;
  /** ESP32ファームのOTA配布先（manifest.json と .bin）。Soniox鍵発行Lambdaが読んで署名付きURLを返す */
  readonly firmwareBucketName: string;
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
    speakersBucketName: "toytalker-tts-speakers", // 既存バケット名をそのまま維持
    firmwareBucketName: "toytalker-firmware", // 手作業で作成済み（2026-09-16）。CDKは参照のみ
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
    account: "",
    speakersBucketName: "toytalker-tts-speakers-stg",
    firmwareBucketName: "toytalker-firmware-stg",
  },
  prod: {
    ...common,
    stage: "prod",
    account: "",
    speakersBucketName: "toytalker-tts-speakers-prod",
    firmwareBucketName: "toytalker-firmware-prod",
  },
  "prod-dg": {
    ...common,
    stage: "prod-dg",
    account: "",
    speakersBucketName: "toytalker-tts-speakers-prod-dg",
    firmwareBucketName: "toytalker-firmware-prod-dg",
  },
};

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
