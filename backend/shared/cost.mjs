// 原価の計算と、利用額（usage）への記録。本文・相槌・読み上げの Lambda が同じものを使う
// （2026-11-28 まで本文2本と読み上げに同じ関数の写しがあり、TTS の数え方が Lambda ごとにずれていた）。
//
//   請求額（円） = API単価（USD） × 使用量 × その月の為替 × マージン      docs/pricing-and-cost-model.md 第1節
//
// - 単価とマージンは api-unit-prices（version = "current"）。1時間キャッシュする
// - 為替は exchange-rates の月の行。行が無い月は 150 円
// - usage は「持ち主・日・機器・種別」ごとの合計。1ターンの正本は台帳（wallet.mjs の recordConsume）
// 記録の失敗で会話を止めないので、どの関数も投げない（ログに出すだけ）。
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, ScanCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { tableName } from "./tables.mjs";
import { dataClientConfig } from "./region.mjs";

const USAGE_TABLE = tableName("usage");
const UNIT_PRICES_TABLE = tableName("api-unit-prices");
const EXCHANGE_RATES_TABLE = tableName("exchange-rates");

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient(dataClientConfig));

const CACHE_TTL_MS = 3600_000;
const DEFAULT_MARGIN = 1.5;   // service#margin の行が読めないときだけ使う
const DEFAULT_USD_JPY = 150;  // 為替の行が無い月

let cachedPrices = null;  // { "openai#llm": {...}, "openai#tts": {...}, ... }
let cachedMargin = null;
const cachedRates = {};   // { "2026-04#JPY": 150, ... }
let cacheLoadedAt = 0;

/** 単価とマージンを読む（1時間キャッシュ）。待たずに呼べば先読みになる */
export async function loadPricingCache() {
  if (cachedPrices && (Date.now() - cacheLoadedAt) < CACHE_TTL_MS) return;
  try {
    const result = await ddb.send(new ScanCommand({
      TableName: UNIT_PRICES_TABLE,
      FilterExpression: "version = :v",
      ExpressionAttributeValues: { ":v": "current" },
    }));
    const prices = {};
    for (const item of (result.Items ?? [])) {
      const pk = item["provider#api_type"];
      if (pk === "service#margin") cachedMargin = Number(item.margin) || DEFAULT_MARGIN;
      else prices[pk] = item;
    }
    cachedPrices = prices;
    cacheLoadedAt = Date.now();
  } catch (e) {
    console.error("[Pricing] cache load error:", e);
  }
}

/** その月（"YYYY-MM"）の為替。行が無い・読めないときは 150 */
export async function getExchangeRate(month, currency = "JPY") {
  const cacheKey = `${month}#${currency}`;
  if (cachedRates[cacheKey]) return cachedRates[cacheKey];
  try {
    const result = await ddb.send(new GetCommand({ TableName: EXCHANGE_RATES_TABLE, Key: { month, currency } }));
    const rate = Number(result.Item?.rate) || DEFAULT_USD_JPY;
    cachedRates[cacheKey] = rate;
    return rate;
  } catch (e) {
    console.error("[ExchangeRate] error:", e);
    return DEFAULT_USD_JPY;
  }
}

/** PCM（24kHz・16bit・モノラル）のバイト数 → 秒 */
const pcmSeconds = (pcmBytes) => (pcmBytes ?? 0) / (24000 * 2);

/**
 * 使用量から請求額（マージン後の円）を出す。先に loadPricingCache を待っておく。単価行が無ければ null（記録されない）。
 * 使用量は単価行の単位（input_unit_type / output_unit_type）に合うものを渡す:
 *   tokens → tokensIn / tokensOut、characters → characters（＋ OpenAI TTS は pcmBytes）、utf8_bytes → utf8Bytes、
 *   mora（円建ての Sakura）→ mora、audio_tokens（STT）→ userMessageChars、requests（検索など）→ requests
 * @returns {{ costJpy: number, costUsd: number|null, usdJpyRate: number|null, unitPriceUsd: number|null, margin: number }|null}
 */
export function calcCostJpy({ providerApiType, model, tokensIn, tokensOut, characters, utf8Bytes, mora, pcmBytes, userMessageChars, requests, usdJpyRate }) {
  // モデル別の行（例 anthropic#llm#claude-haiku-5-5）があればそれ、無ければプロバイダー行（anthropic#llm）
  const price = (model && cachedPrices?.[`${providerApiType}#${model}`]) || cachedPrices?.[providerApiType];
  if (!price) {
    // 単価行が無いと記録されない。月次の運用Lambdaがこのログを拾って知らせる
    console.warn(`[Pricing] missing price for ${providerApiType}`);
    return null;
  }
  const margin = cachedMargin || DEFAULT_MARGIN;
  // Sakura: 円建て
  if (price.currency === "JPY") {
    const inputCost = (mora ?? 0) * Number(price.unit_price_input);
    return { costJpy: inputCost * margin, costUsd: null, usdJpyRate: null, unitPriceUsd: null, margin };
  }
  const inputUnit = price.input_unit_type;
  const outputUnit = price.output_unit_type;
  let costUsd = 0;
  if (inputUnit === "tokens") {
    costUsd += (tokensIn ?? 0) * Number(price.unit_price_input);
    if (outputUnit === "tokens" || outputUnit === "audio_tokens") {
      costUsd += (tokensOut ?? 0) * Number(price.unit_price_output);
    }
  } else if (inputUnit === "characters") {
    costUsd += (characters ?? 0) * Number(price.unit_price_input);
    if (outputUnit === "audio_tokens" && pcmBytes) {
      // OpenAI TTS: PCMバイト数から音声秒数→音声トークン数を概算
      const audioTokens = Math.round((pcmSeconds(pcmBytes) / 60) * 800);
      costUsd += audioTokens * Number(price.unit_price_output);
    }
  } else if (inputUnit === "utf8_bytes") {
    costUsd += (utf8Bytes ?? 0) * Number(price.unit_price_input);
  } else if (inputUnit === "audio_tokens") {
    // STT: 確定文の文字数から概算
    const chars = userMessageChars ?? 0;
    const textTokens = Math.round(chars * 0.3);
    const speechSec = chars / 6;
    const audioTokens = Math.round(speechSec * (30000 / 3600));
    costUsd += audioTokens * Number(price.unit_price_input);
    costUsd += textTokens * Number(price.unit_price_output);
  } else if (inputUnit === "requests") {
    // Web検索(Brave)など回数課金
    costUsd += (requests ?? 0) * Number(price.unit_price_input);
  }
  const costJpy = costUsd * usdJpyRate * margin;
  return { costJpy, costUsd, usdJpyRate, unitPriceUsd: Number(price.unit_price_input), margin };
}

/**
 * TTS 1回（または1ターン分の合計）の請求額。声の会社ごとの数え方をここ1か所に置く。
 *   sakura: モーラ（文字数で代用）／ fishaudio: UTF-8 のバイト数 ／ gemini: 入力トークン（文字数で代用）＋音声トークン ／
 *   openai: 文字数＋音声の長さ ／ そのほか: 文字数
 * @param {object} p
 * @param {string} p.vendor       TTS_TABLE の ttsVendor
 * @param {number} p.chars        読ませた文字数
 * @param {number} [p.utf8Bytes]  fishaudio 用。無ければ chars × 3
 * @param {number} [p.pcmBytes]   音声の長さ（24kHz・16bit・モノラルのバイト数）。openai の音声ぶんに使う
 * @param {number} [p.audioTokens] gemini の応答（usageMetadata）が返した音声トークン数。渡さないと音声ぶんが記録されない
 * @param {number} p.usdJpyRate
 */
export function calcTtsCost({ vendor, chars, utf8Bytes, pcmBytes, audioTokens, usdJpyRate }) {
  const providerApiType = `${vendor}#tts`;
  if (vendor === "sakura") return calcCostJpy({ providerApiType, mora: chars, usdJpyRate });
  if (vendor === "fishaudio") return calcCostJpy({ providerApiType, utf8Bytes: utf8Bytes ?? chars * 3, usdJpyRate });
  if (vendor === "gemini") return calcCostJpy({ providerApiType, tokensIn: chars, tokensOut: audioTokens ?? 0, usdJpyRate });
  if (vendor === "openai") return calcCostJpy({ providerApiType, characters: chars, pcmBytes, usdJpyRate });
  return calcCostJpy({ providerApiType, characters: chars, usdJpyRate });
}

/**
 * usage の行（持ち主・日・機器・種別）に足し込む。costJpy が 0 以下なら何もしない。
 * variant を付けると並べ替えキーの後ろに `#<variant>` が付き、別の行になる（相槌は "bc"）。
 * 同じ行の provider / model は最後に書いた値で上書きされるので、会社が違うもの（本文の LLM と相槌の LLM）を同じ行に混ぜない。
 * 読む側（設定Lambdaの /usage、月次レポート）はキーを # で切った3つ目までを見るので、種別ごとの合計には入る。
 */
export async function addUsage({ ownerId, deviceId, date, apiType, variant, provider, model, costJpy, costUsd, tokensIn, tokensOut, ttsCharacters, sttCharacters, requestCount, usdJpyRate, unitPriceUsd, margin }) {
  if (!costJpy || costJpy <= 0) return;
  const sk = `${date}#${deviceId}#${apiType}${variant ? `#${variant}` : ""}`;
  try {
    const addParts = ["cost_jpy :cost", "requests :one"];
    const vals = { ":cost": costJpy, ":one": requestCount ?? 1, ":p": provider, ":m": model, ":r": usdJpyRate ?? 0, ":u": unitPriceUsd ?? 0, ":mg": margin };
    if (costUsd)       { addParts.push("cost_usd :usd");         vals[":usd"]  = costUsd; }  // マージン前のUSD実費（請求額との突き合わせ用）
    if (tokensIn)      { addParts.push("tokens_in :tin");       vals[":tin"]  = tokensIn; }
    if (tokensOut)     { addParts.push("tokens_out :tout");     vals[":tout"] = tokensOut; }
    if (ttsCharacters) { addParts.push("tts_characters :ttsc"); vals[":ttsc"] = ttsCharacters; }
    if (sttCharacters) { addParts.push("stt_characters :sttc"); vals[":sttc"] = sttCharacters; }
    await ddb.send(new UpdateCommand({
      TableName: USAGE_TABLE,
      Key: { owner_id: ownerId, "date#device_id#api_type": sk },
      UpdateExpression: `ADD ${addParts.join(", ")} SET provider = :p, model = :m, usd_jpy_rate = :r, unit_price_usd = :u, margin = :mg`,
      ExpressionAttributeValues: vals,
    }));
  } catch (e) {
    console.error("[addUsage] error:", e);
  }
}
