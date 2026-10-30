// Cognito の登録前トリガー（PreSignUp）。ロードマップ4、docs/auth.md。
//
// 目的: 同じ人が Google と Apple（将来は LINE も）でログインしても Cognito 上で1人にする。
// 外部IdPからの初回ログイン（PreSignUp_ExternalProvider）で、その IdP が検証したメールアドレスと同じメールの
// 利用者がすでにプールにいれば、新しい IdP の身元をその既存利用者にリンクする（AdminLinkProviderForUser）。
// いなければ何もしない（Cognito がそのまま新しい利用者を作る）。
//
// 作法:
//   - 結び付けるのは IdP が検証したメールだけ（Google / Apple は検証済みのメールを返す）。未検証のメールで結ぶと乗っ取りの穴になる
//   - Cognito の既知の癖: リンクした直後のログインは Cognito 側でエラーになり、もう一度ログインすると通る。アプリ（app/lib/auth.ts）が自動で再試行する
//   - ログにメールアドレスは書かない
import { CognitoIdentityProviderClient, ListUsersCommand, AdminLinkProviderForUserCommand } from "@aws-sdk/client-cognito-identity-provider";

const cognito = new CognitoIdentityProviderClient({});

// Cognito の userName は "<idp小文字>_<IdP側のID>"（例 google_1234567890、signinwithapple_001234.abcd.5678）。
// リンクには IdP の正式名が要る
const PROVIDER_NAMES = { google: "Google", signinwithapple: "SignInWithApple", line: "LINE" };

export const handler = async (event) => {
  const log = { kind: "presignup", trigger: event.triggerSource, linked: false };
  try {
    if (event.triggerSource !== "PreSignUp_ExternalProvider") return event; // 試験用の Cognito 利用者（admin-create-user）は対象外

    const email = event.request?.userAttributes?.email;
    // IdP が検証したと言うメールだけで結ぶ（lib/toytalker-stack.ts の attributeMapping で email_verified を写している）
    const verified = String(event.request?.userAttributes?.email_verified) === "true";
    const sep = String(event.userName ?? "").indexOf("_");
    const providerKey = sep > 0 ? event.userName.slice(0, sep).toLowerCase() : "";
    const providerUserId = sep > 0 ? event.userName.slice(sep + 1) : "";
    const providerName = PROVIDER_NAMES[providerKey];
    log.provider = providerName ?? providerKey;
    if (!email || !providerName || !providerUserId) { log.skip = "no_email_or_provider"; return event; }
    if (!verified) { log.skip = "email_not_verified"; return event; }

    const res = await cognito.send(new ListUsersCommand({
      UserPoolId: event.userPoolId,
      Filter: `email = "${email.replace(/"/g, '\\"')}"`,
      Limit: 10,
    }));
    // 自分自身（まだ作られていない）は出ない。複数いれば一番古い利用者へ。
    // 結び付け先も検証済みのメールの利用者だけ（未検証のメールで先に作られた利用者に、本人が後から吸い込まれないように）
    const isVerified = (u) => u.Attributes?.find((a) => a.Name === "email_verified")?.Value === "true";
    const candidates = (res.Users ?? []).filter((u) => u.Username !== event.userName && isVerified(u))
      .sort((a, b) => new Date(a.UserCreateDate) - new Date(b.UserCreateDate));
    const existing = candidates[0];
    if (!existing) { log.skip = "no_existing_user"; return event; }

    await cognito.send(new AdminLinkProviderForUserCommand({
      UserPoolId: event.userPoolId,
      DestinationUser: { ProviderName: "Cognito", ProviderAttributeValue: existing.Username },
      SourceUser: { ProviderName: providerName, ProviderAttributeName: "Cognito_Subject", ProviderAttributeValue: providerUserId },
    }));
    log.linked = true;
    log.candidates = candidates.length;
    return event;
  } catch (e) {
    // リンクに失敗しても登録は止めない（別人として作られる。ログで気づいて手でリンクする）
    log.error = `${e?.name ?? ""}: ${String(e?.message ?? e).slice(0, 160)}`;
    return event;
  } finally {
    console.log(JSON.stringify(log));
  }
};
