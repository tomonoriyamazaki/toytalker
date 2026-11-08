// マイク（react-native-audio-record）の持ち主を1つにする。
// 録音器はアプリ全体で1つのネイティブ・シングルトンなので、会話画面とボイス登録画面が別々に
// init / start / stop すると取り合いになる（登録用の録音が壊れる、会話側に別のサンプリングレートの音声が流れる）。
// 録音を始める側は acquireMic() で持ち主になる。先に別の持ち主がいれば、その持ち主の onPreempt を呼んで止めさせてから進む。
// 止められた側は勝手に再開しない（会話なら、会話画面でもう一度ボタンを押してもらう）。

export type MicOwner = "chat" | "custom-voice";

let current: { owner: MicOwner; onPreempt: () => void | Promise<void> } | null = null;

/** 持ち主になる。別の持ち主を止めたときは true を返す（音声モードを取り直す目安）。 */
export async function acquireMic(owner: MicOwner, onPreempt: () => void | Promise<void>): Promise<boolean> {
  let preempted = false;
  const prev = current && current.owner !== owner ? current : null;
  // 先に持ち主を替えてから前の持ち主を止める（止めている最中に前の持ち主の自動再開が走っても、持ち主を見て引き下がれる）
  current = { owner, onPreempt };
  if (prev) {
    try {
      await prev.onPreempt();
    } catch (e: any) {
      console.log(`[MIC] preempt ${prev.owner} failed: ${e?.message ?? e}`);
    }
    preempted = true;
    console.log(`[MIC] ${prev.owner} -> ${owner}`);
  }
  return preempted;
}

/** 自分が持ち主のときだけ手放す（別の持ち主に替わった後に呼んでも何もしない）。 */
export function releaseMic(owner: MicOwner) {
  if (current?.owner === owner) current = null;
}

export function micOwner(): MicOwner | null {
  return current?.owner ?? null;
}
