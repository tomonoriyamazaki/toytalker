import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ensureSecrets, secret } from "../shared/secrets.mjs";
import { tableName } from "../shared/tables.mjs";
import { startTrace } from "../shared/trace.mjs";

const ddbClient = new DynamoDBClient({ region: "ap-northeast-1" });
const ddb = DynamoDBDocumentClient.from(ddbClient);
const s3 = new S3Client({ region: "ap-northeast-1" });
const DEVICES_TABLE = tableName("devices");

// ---- ESP32 OTA（docs/esp32-ota-settings-plan.md）----
// 本体は起動時に fw/hw/ota/part を付けてここへ来る。マニフェストのチャネル（既定 stable、
// デバイス行の fw_channel で beta、fw_target で版固定）が指す版と違えば、S3の署名付きURLを返す。
// バイナリはLambdaを通さず本体がS3から直接取る。本体側はホスト固定・CA検証・SHA-256で守る。
const FIRMWARE_BUCKET = process.env.FIRMWARE_BUCKET || "toytalker-firmware";
const FIRMWARE_MANIFEST_KEY = "esp32s3/manifest.json";
const FIRMWARE_URL_TTL_SEC = 600;
// Soniox一時キーの寿命。既定は1時間（起動時の1回しか取らない古いファーム・アプリのため変えない）。
// 期限前に取り直す新しいファーム・アプリは ?ttl=180 のように短い寿命を頼む（60〜3600秒。不正・範囲外は既定）。
const DEFAULT_KEY_TTL_SEC = 3600;
function keyTtlSeconds(query) {
  const n = Number(query.ttl);
  if (!Number.isInteger(n) || n < 60 || n > DEFAULT_KEY_TTL_SEC) return DEFAULT_KEY_TTL_SEC;
  return n;
}
const MANIFEST_CACHE_MS = 60_000;
const FIRMWARE_CHANNELS = new Set(["stable", "beta"]);
let manifestCache = { at: 0, data: null };

async function loadManifest() {
  const now = Date.now();
  if (manifestCache.data && now - manifestCache.at < MANIFEST_CACHE_MS) return manifestCache.data;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: FIRMWARE_BUCKET, Key: FIRMWARE_MANIFEST_KEY }));
    const data = JSON.parse(await res.Body.transformToString());
    manifestCache = { at: now, data };
    return data;
  } catch (err) {
    console.warn(`[OTA] manifest unavailable: ${err.name}: ${err.message}`);
    return null;
  }
}

function pickTargetVersion(manifest, device) {
  if (device?.fw_target) return String(device.fw_target);
  const channel = FIRMWARE_CHANNELS.has(device?.fw_channel) ? device.fw_channel : "stable";
  return manifest?.channels?.[channel] ?? null;
}

async function buildFirmwareInfo(query, device, manifest) {
  if (query.ota !== "1" || !query.fw || !manifest) return null;
  const target = pickTargetVersion(manifest, device);
  if (!target || target === query.fw) return null;
  const entry = manifest.versions?.[target];
  if (!entry?.key || !entry?.sha256 || !entry?.size) {
    console.warn(`[OTA] target=${target} has no manifest entry`);
    return null;
  }
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: FIRMWARE_BUCKET, Key: entry.key }),
    { expiresIn: FIRMWARE_URL_TTL_SEC },
  );
  return { version: target, url, sha256: entry.sha256, size: entry.size };
}

// 本体の報告を記録する。登録済みの行だけ更新し、未登録の device_id で行を作らない。
function recordDeviceReport(deviceId, query) {
  if (!deviceId || !query.fw) return Promise.resolve();
  return ddb.send(new UpdateCommand({
    TableName: DEVICES_TABLE,
    Key: { device_id: deviceId },
    UpdateExpression: "SET firmware_version = :fw, hw_version = :hw, ota_capable = :o, running_partition = :p, fw_reported_at = :t",
    ConditionExpression: "attribute_exists(device_id)",
    ExpressionAttributeValues: {
      ":fw": String(query.fw).slice(0, 32),
      ":hw": String(query.hw ?? "").slice(0, 16),
      ":o": query.ota === "1",
      ":p": String(query.part ?? "").slice(0, 16),
      ":t": new Date().toISOString(),
    },
  })).catch((err) => {
    if (err.name !== "ConditionalCheckFailedException") console.warn(`[OTA] report failed: ${err.message}`);
  });
}

export const handler = async (event, context) => {
  const start = Date.now();
  // 切り分け用のログ。1リクエスト1行のJSON（backend/shared/trace.mjs）。鍵発行の所要時間と応答コード、OTAの提示を残す
  let trace = null;
  try {
    await ensureSecrets();
    // EventBridgeウォームアップping（コールドスタート対策）
    if (event.body === '{"warmup":true}') return { statusCode: 200, body: "warm" };
    trace = startTrace("stt-token", { event, context, t0: start });
    trace.mark("secrets");

    const SONIOX_API_KEY = secret("SONIOX_API_KEY");
    if (!SONIOX_API_KEY) {
      trace.set({ status: 500, reason: "missing_key" });
      return {
        statusCode: 500,
        body: JSON.stringify({ error: "Missing SONIOX_API_KEY" }),
      };
    }

    const query = event.queryStringParameters ?? {};

    // Soniox temporary key API
    const url = "https://api.soniox.com/v1/auth/temporary-api-key";

    const body = {
      usage_type: "transcribe_websocket",
      expires_in_seconds: keyTtlSeconds(query),
      client_reference_id: "toytalk-lambda",
    };

    // Soniox API呼び出しとデバイス設定取得を並列実行
    const deviceId = query.device_id ?? null;
    const wantsFirmware = query.ota === "1" && !!query.fw;
    trace.set({
      source: deviceId ? "esp" : "app", device_id: deviceId,
      fw: query.fw ? String(query.fw).slice(0, 32) : null, hw: query.hw ? String(query.hw).slice(0, 16) : null,
      ota_check: wantsFirmware, ua: event.headers?.["user-agent"] ?? null,
    });

    const sonioxStart = Date.now();
    const [sonioxRes, deviceSettings, manifest] = await Promise.all([
      fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${SONIOX_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      }).then((r) => { trace.ext("soniox", { status: r.status, ms: Date.now() - sonioxStart }); return r; }),
      deviceId ? ddb.send(new GetCommand({
        TableName: DEVICES_TABLE,
        Key: { device_id: deviceId },
      })).catch((e) => { trace.error("devices_get", e); return null; }) : Promise.resolve(null),
      wantsFirmware ? loadManifest() : Promise.resolve(null),
      recordDeviceReport(deviceId, query),
    ]);
    trace.mark("parallel_done");

    if (!sonioxRes.ok) {
      const text = await sonioxRes.text();
      trace.set({ status: sonioxRes.status });
      return {
        statusCode: sonioxRes.status,
        body: JSON.stringify({
          error: "Soniox API error",
          status: sonioxRes.status,
          details: text,
        }),
      };
    }

    const data = await sonioxRes.json();

    const result = { ok: true, ...data };
    result.stt_model = process.env.SONIOX_MODEL || "stt-rt-v4";
    if (deviceSettings?.Item) {
      result.backchannel_enabled = deviceSettings.Item.backchannel_enabled !== false;
      trace.set({ device_registered: true, backchannel_enabled: result.backchannel_enabled });
    } else if (deviceId) {
      trace.set({ device_registered: false });
    }
    if (wantsFirmware) {
      const firmware = await buildFirmwareInfo(query, deviceSettings?.Item, manifest).catch((err) => {
        trace.error("ota_offer", err);
        return null;
      });
      if (firmware) {
        result.firmware = firmware;
        trace.set({ ota_offer: firmware.version });
      }
    }

    trace.set({ status: 200 });
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result),
    };
  } catch (err) {
    if (trace) { trace.error("handler", err); trace.set({ status: 500 }); }
    else console.error("[stt-token] failed before trace:", err?.name, err?.message);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: err.message }),
    };
  } finally {
    trace?.finish();
  }
};
