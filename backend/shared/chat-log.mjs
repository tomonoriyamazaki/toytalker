// 会話の文章（発話・返答）を chat-logs に残すかどうか。
//   - 環境の既定: 環境変数 CHAT_LOG_SAVE（infra/config/stages.ts の chatLog.save）。"true" のときだけ残す。
//     未設定は「残さない」に倒す（設定漏れで文章が溜まらないように）。
//   - 行ごとの上書き: 行の chat_log が true / false なら既定より優先する。
//     ESP32 は devices の行、アプリは users の行。デプロイ無しで次の会話から効く（不具合の調査で1台だけ残す、など）。
//   残さない場合も、原価は台帳（wallet-ledger）に書くので請求と日次の金額には影響しない。
export function chatLogEnabled(row) {
  if (typeof row?.chat_log === "boolean") return row.chat_log;
  return process.env.CHAT_LOG_SAVE === "true";
}
