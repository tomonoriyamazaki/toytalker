import * as Crypto from "expo-crypto";
import { getIdToken, TOKEN_HEADER } from "./auth";

/**
 * APIの入口（CloudFront の固定ドメイン。docs/roadmap.md の3、2026-10-29）。
 * Function URL のホスト名はスタックを作り直すと変わるので、アプリはこの名前だけを知る。
 * 経路: /chat-app（会話）、/backchannel-app（相槌）、/stt-token（Soniox一時キー）、/read-aloud-app（読み上げ）、
 *       それ以外（/me /devices /characters /voices /llms /logs/* /usage* /custom-voices*）は設定Lambda。
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

/**
 * ログイン中なら ID トークンを `x-toytalker-token` で添える（docs/auth.md）。`Authorization` は CloudFront の OAC が上書きするので使わない。
 * 未ログインなら空（RnD はトークン無しも通る。本番は 401）
 */
export async function authHeader(): Promise<Record<string, string>> {
  const token = await getIdToken();
  return token ? { [TOKEN_HEADER]: token } : {};
}

/** XHR で送るときのヘッダー一式（本文のハッシュ + トークン）。GET には bodyHash は要らないが付いていても害はない */
export async function requestHeaders(body?: string): Promise<Record<string, string>> {
  const [hash, auth] = await Promise.all([bodyHashHeader(body), authHeader()]);
  return { ...hash, ...auth };
}

export type ApiInit = RequestInit & {
  /**
   * 5xx とネットワーク断の再試行回数（既定 0）。電波の弱い環境（展示会場・テザリング等）の瞬断を吸収する。
   * 冪等な GET だけに付ける。POST/PUT/DELETE は二重実行の恐れがあるので付けない
   */
  retries?: number;
};

/**
 * fetch の薄い包み。path は "/" 始まり。本文は文字列（JSON.stringify 済み）で渡す。
 * ログイン中はトークンを、GET / HEAD 以外は本文のハッシュを自動で添える
 */
export async function apiFetch(path: string, init: ApiInit = {}): Promise<Response> {
  const { retries = 0, ...rest } = init;
  const method = (rest.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...((rest.headers as Record<string, string> | undefined) ?? {}), ...(await authHeader()) };
  if (method !== "GET" && method !== "HEAD") {
    if (rest.body !== undefined && typeof rest.body !== "string") throw new Error("apiFetch: body は文字列で渡す");
    Object.assign(headers, await bodyHashHeader(rest.body as string | undefined));
  }
  const attempts = method === "GET" || method === "HEAD" ? retries : 0;
  let lastErr: unknown;
  for (let i = 0; i <= attempts; i++) {
    try {
      const res = await fetch(apiUrl(path), { ...rest, headers });
      if (res.ok || res.status < 500) return res; // 4xx は再試行しても結果が変わらない
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e; // ネットワーク断
    }
    if (i < attempts) await new Promise((r) => setTimeout(r, 600 * (i + 1)));
  }
  throw lastErr;
}
