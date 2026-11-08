// 環境ごとの設定。秘密でない値だけを置く（秘密は各アカウントのSSM Parameter Store。lib/secrets.ts）。
// 選択は `cdk deploy --context stage=<name>`。

export type StageName = "rnd" | "stg" | "prd" | "prd-dg";

/**
 * アプリの設定画面「音声認識」の選択肢（ロードマップ18）。一時キーLambda（/stt-token）がアプリへ `stt_options` として配り、
 * アプリ（app/lib/sttModel.ts）はモデル名も Soniox の設定値も持たない。モデルの追加・廃止や待ちの値の調整は
 * ここを変えて deploy するだけで、アプリの更新は要らない。受け取れないときのアプリは「おすすめ」と組み込みの待ちで動く。
 * ESP32 には配らない（応答を読む JSON の大きさが決まっているため）。
 */
export interface SttOptions {
  /** 「おすすめ」以外に選べるモデル。廃止したモデルを消すと、それを選んでいた端末は「おすすめ」に戻る */
  readonly models: readonly { readonly id: string; readonly label: string; readonly description?: string }[];
  /**
   * 「話し終わりの待ち」の中身。soniox は開始メッセージにそのまま足す値（アプリは解釈しない）、
   * grace_ms は終端（<end>）の後にアプリが送らずに待つ時間（その間に声が出たら同じ発話としてつなぐ）
   */
  readonly waits: Readonly<Record<SttWait, SttWaitSetting>>;
  /** モデルごとに待ちの中身を変えたいときだけ書く（モデル名 → 待ち → 中身）。無ければ waits */
  readonly waits_by_model?: Readonly<Record<string, Partial<Record<SttWait, SttWaitSetting>>>>;
}
export type SttWait = "fast" | "normal" | "slow";
export interface SttWaitSetting {
  readonly soniox: Readonly<Record<string, number | boolean | string>>;
  readonly grace_ms: number;
}

export interface StageConfig {
  readonly stage: StageName;
  /** AWSアカウントID。デプロイ前に呼び出し元の資格情報と一致するか確認する（bin/toytalker.ts） */
  readonly account: string;
  readonly region: string;
  /** 月次運用レポート（SNS）の宛先 */
  readonly opsEmail: string;
  /** ZakiCorp TTS（クローンボイス）の公開URL。Cloudflare Tunnelで固定 */
  readonly zakicorpTtsUrl: string;
  /** Soniox STTのモデル名（アプリの「おすすめ」と ESP32 が使う） */
  readonly sonioxModel: string;
  /** アプリの設定画面「音声認識」の選択肢。一時キーLambdaがアプリへ配る（型と方針は SttOptions） */
  readonly sttOptions: SttOptions;
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
  /**
   * 前払いポイント（docs/pricing-and-cost-model.md 第11節）。stopAtZero: 残高0以下（財布が無い利用者も）の会話・読み上げを止めるか。
   * 本番は true。RnD は false（外部テスターや家族の端末を止めない。引き落としは記録するので残高はマイナスになる）。
   * 止まる動きを RnD で試すときは一時的に true にしてデプロイする。環境変数 WALLET_STOP_AT_ZERO で Lambda へ渡す
   */
  readonly wallet: { readonly stopAtZero: boolean };
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
   * 前払いポイントの購入（ロードマップ4 段階3、docs/pricing-and-cost-model.md 11.10）。
   * - buyPageUrl: 購入ページ（web/site/buy/）。Checkout の戻り先、CORS の許可元、Cognito の Web クライアントの戻り先に使う。
   *   サイトは1つ（toytalker.zakicorp.com）なので、ページ側の config.js がどの環境の API を向くかで決まる（当面は RnD）
   * - stripeLivemode: 本番の鍵か。Webhook のイベントの livemode と比べ、sandbox のイベントが本番に（逆も）混ざらないようにする
   */
  readonly billing: { readonly buyPageUrl: string; readonly stripeLivemode: boolean };
  /**
   * サポートの返信の送信元（ロードマップ 7(d)、2026-11-08）。SES でドメインを検証し、Gmail の「別のアドレスから送信」が
   * SES の SMTP で addresses のどれかから送る（受け取りは Cloudflare の転送のまま。手元にメールボックスは持たない）。
   * addresses は「会社の窓口（support@。Google Cloud の同意画面もこれ）」と「製品ごとの窓口（<製品>-support@）」。
   * 製品が増えたらここと Cloudflare の転送ルールに1つ足す。SMTP 用の IAM ユーザー1つが長期鍵の唯一の例外で、
   * addresses からの送信だけ許す。無い環境は SES を作らない。
   */
  readonly supportMail?: { readonly domain: string; readonly addresses: readonly string[] };
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
  sonioxModel: "stt-rt-v6", // 2026-11-08 に v5 から切替。アプリの「話し終わりの待ち」は v6 で調整した（ロードマップ18）
  sttOptions: {
    // stt-rt-v5 は 2026-12-15 に廃止（以後 Soniox が v6 へ振り替える）。その後この行を消す
    models: [
      { id: "stt-rt-v6", label: "v6" },
      { id: "stt-rt-v5", label: "v5", description: "2026-12-15 に廃止され v6 へ振り替わります。" },
    ],
    // 2026-11-08 に大人と4歳半の子で試して決めた（v6）。Soniox は文として終わって聞こえると設定に関係なく即座に区切るので、
    // 子どもが言葉を切ってから続ける分は grace_ms で拾う。endpoint_sensitivity は -1.0〜1.0、max_endpoint_delay_ms は 500〜3000
    waits: {
      fast: { soniox: {}, grace_ms: 0 },
      normal: { soniox: { endpoint_sensitivity: -0.3, max_endpoint_delay_ms: 2500 }, grace_ms: 600 },
      slow: { soniox: { endpoint_sensitivity: -0.6, max_endpoint_delay_ms: 3000 }, grace_ms: 1200 },
    },
  },
  cartesiaDefaultVoiceId: "c7eafe22-8b71-40cd-850b-c5a3bbd8f8d2",
  architecture: "x86_64",
  wallet: { stopAtZero: true },
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
    wallet: { stopAtZero: false }, // 2026-11-03決定。財布の無い外部テスター等が黙って止まっていたため
    auth: {
      required: false,
      domainPrefix: "toytalker-auth-rnd",
      // Google Cloud の OAuth クライアント（ウェブ アプリケーション、2026-10-30）。シークレットは Secrets Manager（lib/secrets.ts）
      google: { clientId: "520949921857-mr4fv64ejd5rad8n7mg346466b96impe.apps.googleusercontent.com" },
      // Apple Developer の Services ID（Primary App ID は com.zakicorp.toytalk、2026-10-30）。秘密鍵は Secrets Manager（lib/secrets.ts）
      apple: { servicesId: "com.zakicorp.toytalker.signin", teamId: "89J44WY33V", keyId: "WADH8C78NZ" },
    },
    backup: { retentionDays: 35 }, // 2026-10-27決定（同じアカウント、35日）。保管庫名は新規なので最初から新名
    billing: { buyPageUrl: "https://toytalker.zakicorp.com/buy", stripeLivemode: false }, // Stripe は sandbox（2026-11-02 作成）
    supportMail: { domain: "zakicorp.com", addresses: ["support@zakicorp.com", "toytalker-support@zakicorp.com"] }, // 2026-11-08。DNS と転送は Cloudflare
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
    billing: { buyPageUrl: "https://toytalker.zakicorp.com/buy", stripeLivemode: false },
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
    billing: { buyPageUrl: "https://toytalker.zakicorp.com/buy", stripeLivemode: true },
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
    billing: { buyPageUrl: "https://toytalker.zakicorp.com/buy", stripeLivemode: true },
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
