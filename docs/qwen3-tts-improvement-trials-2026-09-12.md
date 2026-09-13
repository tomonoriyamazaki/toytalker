# Qwen3-TTS 改善候補の比較（2026-09-12）

重複トークン除去の置き換えは約1%の処理時間削減。波形変換の間隔を4から8/12へ広げると生成倍率は約9%/13%増えたが、初回音声は平均約0.22秒/0.35秒遅くなった。本番は元の実装・chunk_size=4へ復帰済み。今回の比較で100人同時対応を確認したわけではない。

## 重複トークン除去の置き換え

`apply_repetition_penalty` の毎ステップの `token_history.unique()` を、語彙サイズ固定のboolマスクへ置き換えた。履歴に現れたトークンに一度だけペナルティを適用する意味は維持する。元のAPI・インストール済みライブラリは変更せず、実験プロセス内だけで差し替えた。

本番停止前にCPU/CUDA、float32/bfloat16、logitsの2形状、履歴長0/1/94/2048、penalty=1/1.05/1.5の96条件で元実装との厳密一致を確認。正・負・ゼロ・無限大・NaNのlogits、重複履歴も含む。許容誤差は0、NaN同士は一致として扱う。

### 比較条件

Qwen3-TTS 1.7B、RTX 5090、vivian、同じ41文字、chunk_size=4。同一モデルプロセスで通常/改善/改善/通常（ABBA）を5ブロック、計20件。ブロック内は同じ乱数seed、ブロックごとにseedを変更。各モード10件、ウォームアップは別の1件。プロファイラーはOFF、要求は単独・逐次。API追加無音を除くモデル波形の音声長で生成倍率を計算した。

| 指標 | 通常版 | マスク版 |
|---|---:|---:|
| 成功 | 10/10 | 10/10 |
| HTTP完了時間 平均 | 2.684秒 | 2.659秒 |
| モデル生成時間 平均 | 2.669秒 | 2.636秒 |
| 音声生成倍率（HTTP全体） | 3.183倍 | 3.213倍 |
| 初回PCM受信 平均 | 0.749秒 | 0.750秒 |
| 初回PCM受信 最大 | 0.774秒 | 0.770秒 |
| 模擬再生枯渇 | 0件 | 0件 |

HTTP全体の音声秒数あたり処理時間は約0.95%減、モデル生成時間は平均約1.24%減。5ブロックすべてでモデル時間が短く、ブロック別削減幅は0.53〜1.93%。小さな効果で、100人対応の見積もりを大きく変える改善ではない。

**5ブロックとも、同じseedの通常2件・改善2件のfloat波形SHA256が完全一致。** 今回の入力では音声そのものを変えずに比較できた。ただし単一話者・短文・5seedでの結果であり、全入力や並列動作の保証ではない。今回の置き換えは重複除去部分のみで、推論の並列化は行っていない。

### 保存先

`tts-models/faster-qwen3-tts/benchmarks/concurrency/results/profile-20260912-211009/`

- `repetition-analysis.json`: 集計とseed別結果。
- `repetition-trial.jsonl`: 各要求のmode、seed、生成時間、波形ハッシュ、ペナルティ実行回数。
- `baseline-model-output.wav` / `mask-model-output.wav`: 最初のseedの通常・改善波形。APIフェード・追加無音前。
- クライアント結果は `results/20260912T121033_901776Z/`。

21:12:31 JSTに通常サービスのhealth復帰を確認後、次の独立したchunk比較へ進んだ。

## 波形変換の間隔（chunk_size）の比較

重複除去は元実装のまま、chunk_sizeだけを4/8/12で比較。1モデルプロセスで4→8→12→12→8→4の順を3ブロック（3seed）、計18件。各設定6件、ウォームアップは別の1件。ブロック内は同じseed。プロファイラーはOFF。音声を最後まで溜める方式へ変えたのではなく、ストリーミング中に何ステップごとに波形へ変換して送るかの比較。

| 指標 | 4（通常） | 8 | 12 |
|---|---:|---:|---:|
| 成功 | 6/6 | 6/6 | 6/6 |
| HTTP完了 平均 | 2.801秒 | 2.577秒 | 2.475秒 |
| 音声生成倍率 | 3.189倍 | 3.466倍 | 3.609倍 |
| 通常比の処理量増加 | — | 8.7% | 13.2% |
| 初回PCM受信 平均 | 0.749秒 | 0.969秒 | 1.095秒 |
| 初回PCM受信 最大 | 0.761秒 | 0.989秒 | 1.129秒 |
| 模擬再生枯渇 | 0件 | 0件 | 0件 |

各seedの音声長は設定間で同じ（8.96/10.00/7.84秒）。生成ステップ数も同じ（112/125/98）。同じ設定・seedの反復2件はfloat波形ハッシュが一致した。長さ・ステップ数が同じでも設定間の音質同一を保証するものではない。単一話者・短文・3seedの探索比較。

ユーザーが `profile-20260912-211336` 内の `baseline-model-output.wav`、`chunk8-model-output.wav`、`chunk12-model-output.wav` を聴取し、「3つとも全く違和感なし」と報告した。今回保存した3音声の聴取確認は完了。完成WAVによる確認なので、リアルタイムの初回待ち時間・実機での再生挙動の評価とは区別する。本番設定の変更は行っていない。

**リアルタイム会話では、処理量増加と初回音声の遅れを両方考える必要がある。** 単純に12へ変更する判断はしていない。次の候補は「先頭は小さいチャンク、後続を大きくする」実験で、今回未実施。現在のAPIは最後のフェード用に1チャンクを保留するため、先頭チャンクだけ小さくしても初回送信が速いとは限らない。送信まで含めて測る必要がある。重複除去の変更との組み合わせも未測定。

### 保存先と比較音声

`tts-models/faster-qwen3-tts/benchmarks/concurrency/results/profile-20260912-211336/`

- `chunk-analysis.json`: 集計とseed別の長さ・ステップ数・反復一致。
- `repetition-trial.jsonl`: 共通の試験記録形式を再利用した各要求ログ（今回のmodeはbaseline/chunk8/chunk12）。
- [通常4の音声](../../tts-models/faster-qwen3-tts/benchmarks/concurrency/results/profile-20260912-211336/baseline-model-output.wav)
- [8の音声](../../tts-models/faster-qwen3-tts/benchmarks/concurrency/results/profile-20260912-211336/chunk8-model-output.wav)
- [12の音声](../../tts-models/faster-qwen3-tts/benchmarks/concurrency/results/profile-20260912-211336/chunk12-model-output.wav)

音声は最初のseedのモデル出力で、APIの末尾フェード・追加無音前。生成完了後のWAV再生では初回待ち時間の違いは体感できないため、待ち時間は表のHTTP計測値で比較する。クライアント結果は `results/20260912T121359_398807Z/`。

## 通常サービスの復帰

後続の[可変チャンク試験](qwen3-tts-dynamic-chunks-2026-09-12.md)を実施。先頭6チャンクを4のまま、後続8へ広げると処理量約7.2%増・初回PCM約0.079秒増。固定設定の音声確認とは別に、可変版の音声確認が必要。本番適用は行っていない。

21:15:46 JSTに通常APIのhealth復帰。TTS-AutoStartはRunning/Enabled=True、ngrok公開healthはok。通常8000番で音声生成1件成功、初回PCM0.898秒、完了2.521秒、模擬再生枯渇なし。確認結果は `results/20260912T121614_886682Z/`。

元のAPIソースSHA256は `82799770206ac86b54f2769feed9dbb83fee00989cb69bd1ceb7434b040d2c79` で不変。改善コードは実験資材のみ。本番への適用は行っていない。

## 再現資材

[benchmarks/concurrency](../../tts-models/faster-qwen3-tts/benchmarks/concurrency/README.md) の `repetition_trial.py`、`profile_server.py`、`profile-maintenance.ps1`、`analyze_repetition_trial.py`。管理者PowerShellで `profile-maintenance.ps1 -RepetitionTrial` を実行すると、事前検証→本番一時停止→20件比較→本番復帰まで行う。単独・逐次試験専用で、比較中の実験ポートへ別クライアントを接続しない。

chunk比較は `profile-maintenance.ps1 -ChunkTrial` で18件を実行し、復帰後 `python analyze_chunk_trial.py results/profile-<日時>` で集計する。実装は同じ `repetition_trial.py` のchunk_trial分岐を利用。結果・音声はGit対象外。

関連: [GPU詳細計測](qwen3-tts-cuda-trace-2026-09-12.md)、[処理区間の計測](qwen3-tts-profile-2026-09-12.md)。
