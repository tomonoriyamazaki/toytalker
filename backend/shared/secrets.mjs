// 秘密（APIキー類）の実行時取得。全Lambda共通で、esbuildが各バンドルへ取り込む。
// Lambdaの環境変数には鍵を置かず、SSM Parameter Store（SecureString）から読んでメモリに保持する。
// 読む対象は環境変数 SECRET_PARAMS（JSON: 名前 → SSMパラメータ名。CDKが関数ごとに設定）。
// 読むのは容器の初期化時の1回だけ。定期的な読み直しはしない（2026-11-07に廃止）:
// 温めがあっても容器は約2時間でAWSが入れ替えるので（7日のログで最長2.4時間）、鍵を入れ替えれば数時間で全容器に行き渡る。
// 5分ごとの読み直しは、SecureString 1件の復号ごとに KMS Decrypt を1回呼ぶため、温めping経由で月17万回になっていた。
// 急ぎで反映したいときは設定を1つ触って容器を入れ替える（docs/security-review-2026-10-25.md の入れ替え手順）。
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";

const CHUNK = 10; // GetParameters の上限

const params = JSON.parse(process.env.SECRET_PARAMS || "{}");
// 死んだ接続で待たされないよう短めに切る（切れたら SDK が新しい接続で再試行する）
const ssm = new SSMClient({ requestHandler: { connectionTimeout: 2000, requestTimeout: 3000 } });

let values = {};
let loaded = false;
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
  console.log(`[secrets] loaded ${Object.keys(next).length}/${names.length} from SSM`);
  values = next;
  loaded = true;
}

// 失敗しても例外にしない。次の呼び出しで取り直す
function refresh() {
  inflight ??= fetchAll()
    .catch(e => console.error("[secrets] load failed:", e?.name, e?.message))
    .finally(() => { inflight = null; });
  return inflight;
}

// 初期化フェーズで取得を始める（handlerの ensureSecrets が完了を待つ）
refresh();

/**
 * handlerの先頭で呼ぶ。初回の取得が終わるまで待つ（通常は数十ms。2回目以降は何もしない）。
 * 裏で取りに行ったままにしないこと: Lambda は応答を返すと実行を凍結するので、取得が途中で止まり
 * 次の呼び出しで接続エラーになる（2026-10-26に修正した事象）。
 */
export async function ensureSecrets() {
  if (!loaded) await refresh();
  // 初回が失敗していたら1回だけ取り直す。AWS が容器を先に初期化して凍結したとき、
  // 初期化中に始めた取得が切れていることがある（inflight は finally で空になっているので新しい要求になる）
  if (!loaded) await refresh();
}

/**
 * 鍵の値。SSMに無い・未取得なら同名の環境変数、それも無ければ undefined。
 * 環境変数を見るのは、環境変数方式からの移行中（cdk deploy --context keepEnvSecrets=true）と手元での実行のため
 */
export function secret(name) {
  return values[name] ?? process.env[name];
}
