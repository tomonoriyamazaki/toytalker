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
