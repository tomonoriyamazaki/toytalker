# Cartesia TTS 導入

Cartesia（Sonicモデル）をTTSプロバイダーとして追加した記録と、有効化の手順。ElevenLabsと同じ経路（`toytalker-voices` の `provider` で切替）で動く。

## 実装の要点

- 5つのTTS Lambda（App本文 / ESP32本文 / App相槌 / ESP32相槌 / 読み上げ）に `Cartesia` を追加。`TTS_TABLE` のキーは `Cartesia`、`ttsVendor` は `cartesia`、既定モデルは `sonic-3.6`。
- API: `POST https://api.cartesia.ai/tts/bytes`。ヘッダは `Authorization: Bearer <key>` と `Cartesia-Version: 2026-08-14`。
- 出力形式:
  - App本文・相槌・ESP32本文・ESP32相槌: raw PCM 16bit / 24kHz / mono（ElevenLabsの `pcm_24000` と同じ）。Appは既存の `pcm16ToWavBase64` でWAV化、ESP32はそのままPCM送信。
  - 読み上げ（tts-only）: mp3 44.1kHz / 128kbps をネイティブで要求（lamejs変換なし）。
- 言語は `language: "ja"` を明示（環境変数 `CARTESIA_LANGUAGE` で変更可）。
- ボイスIDはUUID形式。DynamoDBの `vendor_id` から渡す。未指定時は環境変数 `CARTESIA_DEFAULT_VOICE_ID` を使い、それも無ければエラーにする（ElevenLabsのようなコード内固定の既定ボイスは持たない）。
- コスト計算は既存の文字数課金（`characters`）の汎用経路を使うため、コード変更なし。単価行の追加だけで集計される。
- 相槌Lambdaはモデル名を渡さず関数既定の `sonic-3.6` を使う（ElevenLabsと同じ扱い）。

## 有効化手順

### 1. Lambda環境変数

5つのLambdaに以下を追加する（コンソールまたは `aws lambda update-function-configuration`）。

| 変数 | 必須 | 内容 |
|---|---|---|
| `CARTESIA_API_KEY` | 必須 | Cartesiaのキー（`sk_car_...`） |
| `CARTESIA_DEFAULT_VOICE_ID` | 推奨 | ボイス未指定時に使うUUID |
| `CARTESIA_LANGUAGE` | 任意 | 既定 `ja` |

対象Lambda:

1. `toytalk-stream-handler-lambda`
2. `toytalk-api-stream-for-esp32-lambda`
3. `toytalker-backchannel-for-app-lambda`
4. `toytalker-backchannel-for-esp32-lambda`
5. `toytalker-tts-only-lambda`

例（PowerShell、既存の変数を消さないよう `--environment` は現在値を含めて指定する）:

```powershell
aws lambda get-function-configuration --function-name toytalk-stream-handler-lambda --region ap-northeast-1 --query 'Environment.Variables'
```

で現在値を確認してから、`Variables` に `CARTESIA_API_KEY` 等を足した形で `update-function-configuration --environment` を実行する。

### 2. `toytalker-voices` にボイス行を追加

```json
{
  "voice_id":  "cartesia_<name>",
  "provider":  "Cartesia",
  "vendor_id": "<CartesiaのボイスUUID>",
  "label":     "<アプリに表示する名前>",
  "owner_id":  "system"
}
```

- `provider` は `Cartesia`（大文字小文字はLambda側で吸収するが、アプリのボイス一覧はこの文字列でグループ化する）。
- ボイスUUIDはCartesiaのダッシュボード（Voice Library）か `GET https://api.cartesia.ai/voices` で確認する。日本語ボイスは `language: ja` で絞り込む。
- アプリのボイス選択画面と読み上げ画面は `GET /voices` の `provider` で自動的にセクションを作るため、アプリ側の変更は不要。利用状況グラフの色だけ `cartesia` を追加済み。

### 3. `toytalker-api-unit-prices` に単価行を追加

```json
{
  "provider#api_type": "cartesia#tts",
  "version":           "current",
  "currency":          "USD",
  "input_unit_type":   "characters",
  "unit_price_input":  "0.00004"
}
```

- 2026-09-12にProプラン（$5/月、100Kクレジット、1クレジット/字）へ変更したため、単価は $0.00005/字（$50/100万字）。Startup（$49/月、1.25M）に上げたら $0.0000392/字 に直す。
- 単価は1時間キャッシュされるため、行を追加した直後の会話は集計されないことがある。

### 4. 動作確認

1. `toytalker-characters` の任意キャラクターの `voice_id` を手順2の値にする。
2. アプリで会話し、`tts` イベントの音声が再生されること、CloudWatchに `Cartesia TTS failed` が出ないことを確認する。
3. 読み上げ画面で同じボイスを選び、mp3再生を確認する。
4. ESP32はキャラクター経由（`character_id`）なら再書き込み不要。ファーム固定の `TTS_PROVIDER` を使う経路でCartesiaを指定する場合は文字列を `"Cartesia"` に変えて書き込む。
5. 利用状況ページに `cartesia` の集計が出ることを確認する。

## 2026-09-12 の投入状況

- 手順1〜3は実施済み。5 Lambdaに `CARTESIA_API_KEY` / `CARTESIA_DEFAULT_VOICE_ID`（Emi）を設定、`toytalker-voices` に8件（Emi / Sakura / Haruka / Yui / Kenta / Keiko / Lily / Zaki（クローン））、`toytalker-api-unit-prices` に `cartesia#tts` = $0.00004/字（暫定）を登録。
- 読み上げLambdaのFunction URLを `cartesia_emi` で呼び、mp3（audio/mpeg）が1.4秒で返ることを確認。Cartesia直叩きではPCM 24kHzが0.6秒で返った。
- `voice_id` の命名は `cartesia_<name>`。Zakiは個人のクローンボイスで、当面はシステム扱いで一覧に出す。アプリからのクローン作成は別タスク。
- DynamoDBへ日本語ラベルをCLIで入れるときは `AWS_CLI_FILE_ENCODING=UTF-8` が必要。端末表示は化けるが保存データは正しい。

## 未確認事項

- アプリ・ESP32での実機の音声品質・日本語の自然さ・会話時のレイテンシは未検証（Lambda経路の動作確認まで）。
- `sonic-3.6` が利用不可の場合は `sonic-3` へ `TTS_TABLE` の `ttsModel` を変更する。
- 相槌用の短文で先頭無音が長い場合はESP32側の `trimSilence` が吸収する想定。App側は未確認。
- 感情・話速（`generation_config`）は未使用。必要なら `ttsBytesCartesia` の body に追加する。

## アプリからのクローンボイス作成（2026-09-13）

ZakiCorpのカスタムボイスと同じ画面・同じAPIで、Cartesia Instant cloneも作れるようにした。

- **API**: `POST /custom-voices` の `provider` に `"Cartesia"` を渡す（省略時は ZakiCorp）。デバイス設定Lambdaが音声をそのまま `POST https://api.cartesia.ai/voices/clone`（multipart、`language: ja`）へ送り、返ってきたボイスUUIDを `vendor_id` に保存する。元音声は `toytalker-tts-speakers` の `{owner_id}/cartesia_{voice_id}.{ext}` に控えを残し、`sample_key` に記録する。
- **一覧**: `GET /custom-voices` は ZakiCorp と Cartesia の両方（system + 自分のもの）を返す。`GET /voices` は owner_id 付きの行を除外する（ZakiCorp限定から一般化）。
- **削除**: `DELETE /custom-voices/{id}` は Cartesia 側のボイスも `DELETE /voices/{uuid}` で消し、S3の控えも消す。
- **受け付ける音声**: wav / mp3 / ogg / flac / webm、16MB以下。m4a（iOSのボイスメモなど）はCartesiaが受け付けないため400を返す。アプリの録音はwavなので問題ない。
- **アプリ**: 録音画面に「作成に使うエンジン」の切替（Cartesia / ZakiCorp、既定Cartesia）。Cartesiaは録音10秒、ZakiCorpは5秒。ボイス選択と読み上げ画面に「Cartesia（カスタム）」の区分を追加。
- **環境変数**: デバイス設定Lambdaに `CARTESIA_API_KEY` を設定済み。
- **プラン**: Instant clone はProプラン以上。Freeだと Cartesia が `402 plan_upgrade_required` を返し、Lambdaは502でその文言をそのまま返す（2026-09-13の確認時点ではFreeのままで、ここまで動作確認済み。Pro切替後に登録→一覧→削除を再確認する）。
- **料金**: クローン作成は無料。利用は標準ボイスと同じ `cartesia#tts` の単価で記録される。プレミアム扱いは今回はしない。
- **Lambda設定**: クローン作成は5秒前後かかるため、デバイス設定Lambdaのタイムアウトを10秒→60秒、メモリを128MB→256MBに変更（2026-09-13、コンソール設定。deploy.sh では変わらない）。10秒のままだとLambdaだけが途中で止まり、Cartesia側にはボイスが作られて登録漏れになる。
- **2026-09-13の確認**: Pro切替後、Lambda経由で登録（約5秒）→一覧→削除まで通しで成功。タイムアウト時に残った孤児ボイス1件はCartesia側で削除済み。

## ボイス一覧の並び順（2026-09-13）

- 並び順はサーバー側で決める。`toytalker-voices` の各行の `sort_order`（数値、小さいほど先。無い行は末尾）で並べ、同じ値の中はラベル順。現在は Sakura Internet 10 / Cartesia 20 / ElevenLabs 30 / OpenAI 40 / Google 50 / Gemini 60 / Fish Audio (demo) 70 / ZakiCorp 80。
- アプリ（設定のボイス選択・読み上げ）は受け取った順にプロバイダーの枠を作り、その直後に自分のカスタムボイスを「（カスタム）」として並べる。ZakiCorpの特別扱いは廃止。新しいプロバイダーはアプリ変更なしで表示される（利用状況グラフの色だけはアプリ側）。
- 並びを変えたいときは DynamoDB の `sort_order` を直すだけでよい。プロバイダーの位置を変えるなら、そのプロバイダーの全行を同じ値にする。
- `cartesia_zaki` は本人のクローンなので `owner_id` を本人に付け、公開一覧から外して「Cartesia（カスタム）」に移した（ラベル「Zaki」）。
- 表示名は `provider` の文字列がそのまま見出しになる（大文字変換は廃止）。2026-09-13に `Sakura` → `Sakura Internet`、`FishAudio` → `Fish Audio (demo)`（版権声のため一時的、いずれ削除）に改名。Lambdaは小文字化して `sakura` / `fish` を含むかで判定するので、この改名でLambda変更は不要。名前を変えるときは「sakura」「fish」「cartesia」「elevenlabs」「openai」「google」「gemini」「zakicorp」のいずれかを含める。自分のカスタムボイスの枠は `<provider> (Custom)`。
