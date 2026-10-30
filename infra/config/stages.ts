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
   * APIの固定ドメイン（ロードマップ3）。CloudFront の別名で、ACM 証明書（us-east-1、`<スタック名>-edge`）と
   * Cloudflare の CNAME（DNS only）をこの名前で作る。アプリ・ESP32はこの名前だけを知り、Function URL のホスト名は知らない。
   * 経路は `/chat-app` `/chat-mcu` `/backchannel-app` `/backchannel-mcu` `/stt-token` `/read-aloud-app`、それ以外は設定Lambda（lib/toytalker-stack.ts の API_ROUTES）
   */
  readonly apiDomain: string;
  /**
   * WAF のレート制限。送信元IPごと、5分あたりの要求数で、超えた分は CloudFront が 403 を返す。
   * 省略した環境は WAF を作らない（月約$6）。RnD は省略（2026-10-29決定。docs/deferred-items.md）、本番だけ置く
   */
  readonly apiRateLimitPer5Min?: number;
  /**
   * Function URL を CloudFront を通さず直接呼べるままにするか（authType NONE + 公開ポリシー）。
   * 配布済みの旧ファーム・旧アプリが Function URL を直接呼ぶ間は true。全部が apiDomain へ移った
   * （Lambdaログの `edge: "direct"` が無くなった）ら false にして IAM 認証にし、CloudFront（OAC の署名）だけが呼べるようにする。
   * 切り替えは Function URL の設定変更だけで、ホスト名は変わらない。
   */
  readonly directFunctionUrls: boolean;
  /**
   * 利用者認証（ロードマップ4、docs/auth.md）。Cognito ユーザープール `toytalker-auth-<環境>` を作り、Lambda が ID トークンを検証する
   * （backend/shared/auth.mjs）。
   * - required: トークン無しの要求を 401 で止めるか。本番は true。RnD は false（トークン無しも通し、ログに auth: "none"。
   *   トークン付きなら本番と同じに検証するので動作確認は RnD でできる）。環境変数 AUTH_REQUIRED で Lambda へ渡す
   * - domainPrefix: ログイン画面（managed login）のドメイン `<prefix>.auth.<region>.amazoncognito.com`。リージョン内で一意
   * - google / apple: 外部IdP（Google ログイン、Sign in with Apple）。省略した環境は Cognito の利用者
   *   （`admin-create-user` で作る試験用）だけでログインできる。ID は公開情報なのでここに書く。秘密（Google のクライアントシークレット、
   *   Apple の秘密鍵）は Secrets Manager（lib/secrets.ts の IDP_SECRETS）。SSM の ssm-secure は Cognito の IdP に使えない
   *   （CloudFormation の対応資源に無い。2026-10-29確認）ので、この2件だけ Secrets Manager
   */
  readonly auth: {
    readonly required: boolean;
    readonly domainPrefix: string;
    readonly google?: { readonly clientId: string };
    readonly apple?: { readonly servicesId: string; readonly teamId: string; readonly keyId: string };
  };
  /**
   * 消されても戻せる仕組み（ロードマップ10）。AWS Backup で DynamoDB 全テーブルと S3 バケット（speakers・firmware、管理アカウントでは CloudTrail も）を日次で
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
    apiDomain: "api-rnd.zakicorp.com",
    directFunctionUrls: true, // 配布機（OTA非対応の旧ファーム）と旧アプリが Function URL を直接呼ぶ間は true。ロードマップ6の書き換え後に false
    auth: {
      required: false,
      domainPrefix: "toytalker-auth-rnd",
      // Google Cloud の OAuth クライアント（ウェブ アプリケーション、2026-10-30）。シークレットは Secrets Manager（lib/secrets.ts）
      google: { clientId: "520949921857-mr4fv64ejd5rad8n7mg346466b96impe.apps.googleusercontent.com" },
      // apple は各社側の設定後に足す（docs/auth.md）
    },
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
    apiDomain: "api-stg.zakicorp.com",
    directFunctionUrls: false, // 新しい環境は最初から CloudFront 経由だけ
    auth: { required: true, domainPrefix: "toytalker-auth-stg" },
  },
  prd: {
    ...common,
    stage: "prd",
    account: "",
    legacyNames: false,
    tableSuffix: "-prd",
    speakersBucketName: "toytalker-tts-speakers-prd",
    firmwareBucketName: "toytalker-firmware-prd",
    apiDomain: "api-prd.zakicorp.com",
    directFunctionUrls: false,
    auth: { required: true, domainPrefix: "toytalker-auth-prd" },
    // 1ターン = 本文1 + 相槌1、Soniox鍵は3分に1回。家庭のNATの裏に数台いても 5分で300 には届かない。費用燃やしの天井が目的で、精密な値ではない
    apiRateLimitPer5Min: 300,
  },
  "prd-dg": {
    ...common,
    stage: "prd-dg",
    account: "",
    legacyNames: false,
    tableSuffix: "-prd-dg",
    speakersBucketName: "toytalker-tts-speakers-prd-dg",
    firmwareBucketName: "toytalker-firmware-prd-dg",
    apiDomain: "api-prd-dg.zakicorp.com",
    directFunctionUrls: false,
    auth: { required: true, domainPrefix: "toytalker-auth-prd-dg" },
    apiRateLimitPer5Min: 300,
  },
};

/** CloudFormationスタック名。旧名は `ToyTalker-rnd`、新名は小文字で `toytalker-<環境>` */
export function stackName(config: StageConfig): string {
  return config.legacyNames ? `ToyTalker-${config.stage}` : `toytalker-${config.stage}`;
}

/** CloudFront 用に us-east-1 に置く資源（ACM 証明書・WAF）のスタック名。本体スタックが参照する */
export function edgeStackName(config: StageConfig): string {
  return `${stackName(config)}-edge`;
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
