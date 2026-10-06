// 秘密（APIキー類）の実行時取得。全Lambda共通で、esbuildが各バンドルへ取り込む。
// Lambdaの環境変数には鍵を置かず、SSM Parameter Store（SecureString）から読んでメモリに保持する。
// 読む対象は環境変数 SECRET_PARAMS（JSON: 名前 → SSMパラメータ名。CDKが関数ごとに設定）。
// 鍵を入れ替えるときはSSMを変えるだけでよく、5分以内に反映される（deploy不要）。
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

const REFRESH_MS = 5 * 60 * 1000;
const CHUNK = 10; // GetParameters の上限

const params = JSON.parse(process.env.SECRET_PARAMS || "{}");
const ssm = new SSMClient({});

let values = {};
let loadedAt = 0;
let inflight = null;

async function fetchAll() {
  const byParam = new Map(Object.entries(params).map(([name, param]) => [param, name]));
  const names = [...byParam.keys()];
  const chunks = [];
  for (let i = 0; i < names.length; i += CHUNK) chunks.push(names.slice(i, i + CHUNK));
  const results = await Promise.all(
    chunks.map(c => ssm.send(new GetParametersCommand({ Names: c, WithDecryption: true })))
  );
  const next = {};
  const missing = [];
  for (const res of results) {
    for (const p of res.Parameters ?? []) next[byParam.get(p.Name)] = p.Value;
    missing.push(...(res.InvalidParameters ?? []));
  }
  if (missing.length > 0) console.warn("[secrets] not found in SSM:", missing.join(", "));
  if (!loadedAt) console.log(`[secrets] loaded ${Object.keys(next).length}/${names.length} from SSM`);
  values = next;
  loadedAt = Date.now();
}

// 失敗しても例外にしない。前回の値を使い続け、次の呼び出しで取り直す
function refresh() {
  inflight ??= fetchAll()
    .catch(e => console.error("[secrets] load failed:", e?.name, e?.message))
    .finally(() => { inflight = null; });
  return inflight;
}

// 初期化フェーズで取得を始める（handlerの ensureSecrets が完了を待つ）
refresh();

/** handlerの先頭で呼ぶ。初回は取得完了を待ち、以降は5分を過ぎていたら裏で取り直す */
export async function ensureSecrets() {
  if (!loadedAt) await refresh();
  else if (Date.now() - loadedAt > REFRESH_MS) refresh();
}

/**
 * 鍵の値。SSMに無い・未取得なら同名の環境変数、それも無ければ undefined。
 * 環境変数を見るのは、環境変数方式からの移行中（cdk deploy --context keepEnvSecrets=true）と手元での実行のため
 */
export function secret(name) {
  return values[name] ?? process.env[name];
}
