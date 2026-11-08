/**
 * Soniox のモデル・終端検出の選択（設定画面「音声認識」で選ぶ。ロードマップ18）。
 *
 * 既定は "default" で、一時キー Lambda が配る `stt_model`（infra/config/stages.ts の sonioxModel）に従う。
 * それ以外はこの端末だけ上書きする。v5 と v6 を deploy せずに聞き比べるための選択肢。
 * stt-rt-v5 は 2026-12-15 に廃止され v6 へ自動で振り替わるので、その後は "v5" の選択肢を消す。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

export type SttModelChoice = "default" | "v5" | "v6" | "v6-fast";

export const STT_MODEL_STORAGE_KEY = "sttModelChoice";

export const STT_MODEL_OPTIONS: { value: SttModelChoice; label: string; description: string }[] = [
  { value: "default", label: "おすすめ", description: "サーバーが決めたモデルを使います。" },
  { value: "v5", label: "v5", description: "stt-rt-v5。2026-12-15 に廃止され v6 へ振り替わります。" },
  { value: "v6", label: "v6", description: "stt-rt-v6。終端検出は既定のまま。" },
  {
    value: "v6-fast",
    label: "v6・低遅延終端",
    description: "stt-rt-v6 に Soniox 推奨の低遅延設定（level 2・感度 0.3・最大 1500ms）。話の途中で切れやすくなることがあります。",
  },
];

/** 選択肢ごとの上書き。model が null なら Lambda の値を使う */
const OVERRIDES: Record<SttModelChoice, { model: string | null; endpoint?: Record<string, number> }> = {
  default: { model: null },
  v5: { model: "stt-rt-v5" },
  v6: { model: "stt-rt-v6" },
  "v6-fast": {
    model: "stt-rt-v6",
    endpoint: { endpoint_latency_adjustment_level: 2, endpoint_sensitivity: 0.3, max_endpoint_delay_ms: 1500 },
  },
};

export const isSttModelChoice = (v: unknown): v is SttModelChoice =>
  typeof v === "string" && v in OVERRIDES;

export const loadSttModelChoice = async (): Promise<SttModelChoice> => {
  try {
    const v = await AsyncStorage.getItem(STT_MODEL_STORAGE_KEY);
    return isSttModelChoice(v) ? v : "default";
  } catch {
    return "default";
  }
};

/** 開始メッセージのうちモデルと終端検出の部分。serverModel は Lambda が配った値 */
export const sonioxModelConfig = (choice: SttModelChoice, serverModel: string) => {
  const o = OVERRIDES[choice];
  return { model: o.model ?? serverModel, enable_endpoint_detection: true, ...(o.endpoint ?? {}) };
};
