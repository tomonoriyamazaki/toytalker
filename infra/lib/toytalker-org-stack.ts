import * as cdk from "aws-cdk-lib";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as cloudtrail from "aws-cdk-lib/aws-cloudtrail";
import { Construct } from "constructs";

export interface ToyTalkerOrgStackProps extends cdk.StackProps {
  /** Organizations の組織ID（`o-…`）。組織トレイルのバケットポリシーに使う */
  readonly organizationId: string;
}

/**
 * 環境（rnd / stg / prd）に属さず、組織全体で1つだけ持つ資源。管理アカウントにだけ出す。
 *
 * - CloudTrail 組織トレイル: 全アカウント・全リージョンの管理イベント（誰がいつ何を変えたか）を
 *   S3 に残す。アカウントが増えても自動で対象になる。管理イベントの1本目は無料、S3は年に数百MB。
 *
 * 事前に Organizations の信頼されたアクセス `cloudtrail.amazonaws.com` を有効にしておくこと
 * （`aws organizations enable-aws-service-access --service-principal cloudtrail.amazonaws.com`）。
 * 2026-10-25 セキュリティ見直しで追加。経緯は docs/security-review-2026-10-25.md。
 */
export class ToyTalkerOrgStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: ToyTalkerOrgStackProps) {
    super(scope, id, props);
    cdk.Tags.of(this).add("project", "toytalker");
    cdk.Tags.of(this).add("environment", "org");

    const bucket = new s3.Bucket(this, "CloudTrailBucket", {
      bucketName: "toytalker-cloudtrail-org",
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cloudtrail.Trail(this, "OrgTrail", {
      trailName: "toytalker-org",
      bucket,
      isOrganizationTrail: true,
      orgId: props.organizationId,
      isMultiRegionTrail: true,
      includeGlobalServiceEvents: true,
      enableFileValidation: true,
      managementEvents: cloudtrail.ReadWriteType.ALL,
      sendToCloudWatchLogs: false,
    });

    // cdk-nag（--context nag=true）。理由は docs/security-review-2026-10-25.md
    cdk.Validations.of(this).acknowledge({
      id: "AwsSolutions-S1",
      reason: "CloudTrail の保管先。非公開で、書くのは CloudTrail だけ。アクセスログ用バケットは増やさない",
    });
  }
}
