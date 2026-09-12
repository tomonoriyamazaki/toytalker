# ツール（外部有料API）のコスト記録

2026-09-12に、LLMのfunction callingで呼ぶツールのうち、外部の有料APIを使うもの（現状はWeb検索のSerper）の料金を利用状況に記録するようにした。種別は `stt / llm / tts` に `tool` を加えた4つ。

## 方針

- 相槌のLLM・TTS費用は記録せず、`service#margin`（1.5 → 2.0）で一律に吸収する。相槌はターン数にほぼ比例し、ユーザー間の差が小さいため。相槌はデフォルトON。
- ツールは「無料ツール」と「有料ツール」で扱いを分ける。
  - 無料ツール（デバイス設定変更など、自前のLambda/DynamoDBを呼ぶだけのもの）: 何も記録しない。ツール定義と2回目の呼び出しぶんのLLMトークンは、従来どおりLLMとして記録される。
  - 有料ツール（Serper検索など外部に料金が発生するもの）: 回数課金で `tool` として記録する。プロバイダー別に出るので、外部に払っている額が種別ごとに分かる。
- 検索は「調べ物をよくする子」と「雑談だけの子」で回数が大きく違うため、一律マージンではなく回数で数える。

## 実装

- 本文Lambda（App / ESP32）に `PAID_TOOLS` の対応表を置く。`ツール名 → { provider, model }`。ツール実行が成功するたびに `toolCalls[ツール名]` を加算し、ターン終了時に対応表にあるものだけ `apiType: "tool"`、`provider` をプロバイダー名にして `toytalker-usage` へ加算する。`requests` には呼び出し回数を足す。
- 単価は `toytalker-api-unit-prices` の `${provider}#tool` 行。`input_unit_type = "requests"`。現状は `serper#tool` = $0.001/回（$50 / 5万クレジット、1検索=1クレジット、結果10件まで。クレジットは購入から6か月で失効）。
- `calcCostJpy` に `requests` 単位の分岐を追加。
- チャットログ（`toytalker-chat-logs`）には `tool_usage`（`[{ tool, provider, requests, cost }]`）と `cost_tool` を保存し、`cost_total` に含める。
- `toytalker-device-setting-lambda` の `/usage/detail` は会話ごとに `tool = { cost, items }` を返す（2026-09-12以前のログはnull）。`/usage` は集計キーが汎用なので変更なし。
- アプリの利用状況ページはAPI種別に「ツール（外部API）」を追加し、円グラフはプロバイダー別、会話詳細はツールごとの行を出す。反映は次のアプリビルドから。

## 有料ツールを増やすとき

1. 本文Lambda2つの `PAID_TOOLS` に `ツール名: { provider, model }` を1行足す。
2. `toytalker-api-unit-prices` に `${provider}#tool` 行を足す（`input_unit_type = "requests"`）。
3. アプリ側の変更は不要。円グラフの色を付けたい場合だけ `CHART_COLORS` にプロバイダー名を足す。

無料ツールを増やすときは何もしなくてよい。

## 目安

「今日の東京の天気教えて」のような1回検索のターンで、ツール代は1クレジット = $0.001 ≈ 0.15円（マージン前、マージン2.0で0.3円）。同じターンのLLMトークン増加分は別途LLMとして記録される。

## 補足

- 最初は `search` という専用種別で実装し、同日中に `tool` へ汎用化した。切り替え前のテストで `2026-09-12#<device>#search` の利用状況行と `serper#search` の単価行が1件ずつ残っている。どちらも参照されないので、消しても問題ない。
