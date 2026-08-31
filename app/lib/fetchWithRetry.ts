// 電波の弱い環境(展示会場・テザリング等)での瞬断を自動リトライで吸収するfetch。
// 冪等なリクエスト(GET)専用。POST/PUT/DELETEには使わないこと(二重実行の恐れがあるため)。
export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  retries = 2,
  backoffMs = 600,
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, init);
      if (res.ok) return res;
      // 4xxはリトライしても結果が変わらないので即返す。5xxは一時障害の可能性ありリトライ
      if (res.status < 500) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e; // ネットワーク断(TypeError: Network request failed 等)
    }
    if (i < retries) await new Promise((r) => setTimeout(r, backoffMs * (i + 1)));
  }
  throw lastErr;
}
