import * as Crypto from "expo-crypto";

/**
 * APIの入口（CloudFront の固定ドメイン。docs/roadmap.md の3、2026-10-29）。
 * Function URL のホスト名はスタックを作り直すと変わるので、アプリはこの名前だけを知る。
 * 経路: /chat-app（会話）、/backchannel-app（相槌）、/stt-token（Soniox一時キー）、/read-aloud-app（読み上げ）、
 *       それ以外（/devices /characters /voices /llms /logs/* /usage* /custom-voices*）は設定Lambda。
 * 環境を変えるときは EAS のビルドプロファイルの env で EXPO_PUBLIC_API_BASE_URL を上書きする（infra/config/stages.ts の apiDomain）。
 */
export const API_BASE_URL = process.env.EXPO_PUBLIC_API_BASE_URL ?? "https://api-rnd.zakicorp.com";

export const apiUrl = (path: string): string => `${API_BASE_URL}${path}`;

/**
 * CloudFront から Lambda へは署名付きで渡る（Origin Access Control）。署名は本文のハッシュを含むので、
 * GET / HEAD 以外の要求は本文の SHA-256（本文が無ければ空文字列のハッシュ）を x-amz-content-sha256 で添える。
 * 無いと Function URL を IAM 認証にしたときに 403 になる（CloudFront 開発者ガイド「Restrict access to an AWS Lambda function URL origin」）。
 */
export async function bodyHashHeader(body?: string): Promise<Record<string, string>> {
  // expo-crypto（OS の暗号ライブラリ）。ネイティブモジュールなので、足したときは開発クライアントと配布ビルドの作り直しが要る（2026-10-29）
  const hex = await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, body ?? "", { encoding: Crypto.CryptoEncoding.HEX });
  return { "x-amz-content-sha256": hex };
}

/** fetch の薄い包み。path は "/" 始まり。本文は文字列（JSON.stringify 済み）で渡す */
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...((init.headers as Record<string, string> | undefined) ?? {}) };
  if (method !== "GET" && method !== "HEAD") {
    if (init.body !== undefined && typeof init.body !== "string") throw new Error("apiFetch: body は文字列で渡す");
    Object.assign(headers, await bodyHashHeader(init.body as string | undefined));
  }
  return fetch(apiUrl(path), { ...init, headers });
}
