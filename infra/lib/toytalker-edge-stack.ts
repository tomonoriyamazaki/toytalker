import * as cdk from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
import * as wafv2 from "aws-cdk-lib/aws-wafv2";
import { Construct } from "constructs";
import type { StageConfig } from "../config/stages.js";

export interface ToyTalkerEdgeStackProps extends cdk.StackProps {
  readonly config: StageConfig;
}

/**
 * CloudFront が要求する「us-east-1 にある資源」だけを持つスタック（ロードマップ3）。本体スタック（東京）の
 * CloudFront ディストリビューションが crossRegionReferences で参照する。
 *
 * - ACM 証明書（`apiDomain`）。検証は DNS。Route 53 は使っていない（zakicorp.com の DNS は Cloudflare）ので、
 *   初回 deploy は検証用 CNAME を Cloudflare に手で足すまで待つ（値は ACM コンソールか
 *   `aws acm describe-certificate --region us-east-1` の ResourceRecord）。
 * - WAF WebACL（scope CLOUDFRONT）。`apiRateLimitPer5Min` のある環境（本番）だけ。送信元IPごとのレート制限だけで、
 *   費用燃やし（脅威モデル#1）の天井。正規の利用者を止めない値にする。RnD に置かない理由は docs/deferred-items.md。
 *   サンプル要求の保存とログは切る（送信元IPを残さない方針。2026-10-28決定）。見るのは CloudWatch の件数だけ。
 */
export class ToyTalkerEdgeStack extends cdk.Stack {
  readonly certificate: acm.ICertificate;
  /** WAF を作らない環境では undefined */
  readonly webAclArn?: string;

  constructor(scope: Construct, id: string, props: ToyTalkerEdgeStackProps) {
    super(scope, id, props);
    const { config } = props;
    cdk.Tags.of(this).add("project", "toytalker");
    cdk.Tags.of(this).add("environment", config.stage);

    this.certificate = new acm.Certificate(this, "ApiCertificate", {
      domainName: config.apiDomain,
      validation: acm.CertificateValidation.fromDns(), // ホストゾーンを渡さない = CNAME は人が Cloudflare に置く
    });

    new cdk.CfnOutput(this, "ApiCertificateArn", { value: this.certificate.certificateArn });

    if (config.apiRateLimitPer5Min === undefined) return;
    const metric = (name: string) => ({
      cloudWatchMetricsEnabled: true,
      metricName: name,
      sampledRequestsEnabled: false, // サンプルには送信元IPが入るので保存しない
    });
    const webAcl = new wafv2.CfnWebACL(this, "ApiWebAcl", {
      name: `toytalker-api-${config.stage}`,
      description: `ToyTalker API ${config.stage}: per-IP rate limit`,
      scope: "CLOUDFRONT",
      defaultAction: { allow: {} },
      visibilityConfig: metric(`toytalker-api-${config.stage}`),
      rules: [
        {
          name: "rate-limit-per-ip",
          priority: 0,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: config.apiRateLimitPer5Min,
              evaluationWindowSec: 300,
              aggregateKeyType: "IP",
            },
          },
          visibilityConfig: metric(`toytalker-api-${config.stage}-rate-limit`),
        },
      ],
    });
    this.webAclArn = webAcl.attrArn;
  }
}
