/**
 * Soniox のモデルと「話し終わりの待ち」の選択（設定画面「音声認識」で選ぶ。ロードマップ18）。
 *
 * 選択肢の中身はサーバーが配る（一時キー Lambda の応答 `stt_options`。正本は infra/config/stages.ts の sttOptions）。
 * アプリはモデル名も Soniox の設定値も持たないので、モデルの追加・廃止や待ちの値の調整にアプリの更新は要らない。
 * アプリが持つのは「はやい / ふつう / ゆっくり」の段階と、終端の後の猶予の動き（chat.tsx）だけ。
 *
 * - モデル: "default"（おすすめ）は Lambda の `stt_model` に従う。それ以外はこの端末だけ上書きする。
 *   選んでいたモデルがサーバーの一覧から消えたら（廃止）「おすすめ」に戻る。
 * - 待ち: 既定は「ふつう」（2026-11-08、大人と4歳半の子で試して決めた）。soniox は開始メッセージにそのまま足し、
 *   grace_ms は終端（<end>）の後に送らずに待つ時間（その間に声が出たら同じ発話としてつなぐ）。
 *
 * サーバーの一覧は受け取るたびに端末へ保存し（設定画面は一時キーを取らないのでそれを読む）、
 * 一度も受け取っていないときは「おすすめ」と下の組み込みの待ちで動く。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

export type SttWaitChoice = "fast" | "normal" | "slow";
/** "default" か、サーバーの一覧にあるモデル名 */
export type SttModelChoice = string;
export type SttChoice = { model: SttModelChoice; wait: SttWaitChoice };

type WaitSetting = { soniox: Record<string, unknown>; grace_ms: number };
export type SttOptions = {
  models: { id: string; label: string; description?: string }[];
  waits: Partial<Record<SttWaitChoice, WaitSetting>>;
  waits_by_model?: Record<string, Partial<Record<SttWaitChoice, WaitSetting>>>;
};

export const STT_MODEL_STORAGE_KEY = "sttModelChoice";
// 2026-11-08 に「はやい / ふつう / ゆっくり」へ名前と中身を付け替えたので、以前の保存値（sttWaitChoice）は読まない
export const STT_WAIT_STORAGE_KEY = "sttWait";
const STT_OPTIONS_STORAGE_KEY = "sttOptionsFromServer";

export const DEFAULT_STT_CHOICE: SttChoice = { model: "default", wait: "normal" };

export const STT_WAIT_OPTIONS: { value: SttWaitChoice; label: string; description: string }[] = [
  { value: "fast", label: "はやい", description: "話し終わったらすぐ返事をします。話の途中で切れることがあります。" },
  { value: "normal", label: "ふつう", description: "少し待ってから返事をします。おすすめ。" },
  { value: "slow", label: "ゆっくり", description: "さらに待ちます。話の途中で間が空く小さい子向け。返事は遅くなります。" },
];

/** サーバーから受け取れていないときの待ち（2026-11-08 時点の stages.ts と同じ値） */
const BUILTIN_WAITS: Record<SttWaitChoice, WaitSetting> = {
  fast: { soniox: {}, grace_ms: 0 },
  normal: { soniox: { endpoint_sensitivity: -0.3, max_endpoint_delay_ms: 2500 }, grace_ms: 600 },
  slow: { soniox: { endpoint_sensitivity: -0.6, max_endpoint_delay_ms: 3000 }, grace_ms: 1200 },
};

let serverOptions: SttOptions | null = null;

const isOptions = (v: any): v is SttOptions =>
  !!v && Array.isArray(v.models) && !!v.waits && typeof v.waits === "object";

/** 一時キーの応答に stt_options があれば覚えて端末へ保存する（chat.tsx） */
export const rememberSttOptions = (v: unknown) => {
  if (!isOptions(v)) return;
  serverOptions = v;
  AsyncStorage.setItem(STT_OPTIONS_STORAGE_KEY, JSON.stringify(v)).catch(() => {});
};

/** 覚えている一覧。メモリに無ければ端末の保存分を読む */
export const loadSttOptions = async (): Promise<SttOptions | null> => {
  if (serverOptions) return serverOptions;
  try {
    const raw = await AsyncStorage.getItem(STT_OPTIONS_STORAGE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    if (isOptions(v)) serverOptions = v;
  } catch {}
  return serverOptions;
};

/** 設定画面のモデルの選択肢（先頭は常に「おすすめ」） */
export const sttModelOptions = (o: SttOptions | null) => [
  { value: "default", label: "おすすめ", description: "サーバーが決めたモデルを使います。" },
  ...(o?.models ?? []).map((m) => ({ value: m.id, label: m.label, description: m.description ?? m.id })),
];

const validModel = (m: string | null, o: SttOptions | null): SttModelChoice =>
  m && m !== "default" && o?.models.some((x) => x.id === m) ? m : "default";

export const loadSttChoice = async (): Promise<SttChoice> => {
  try {
    const [m, w, o] = await Promise.all([
      AsyncStorage.getItem(STT_MODEL_STORAGE_KEY),
      AsyncStorage.getItem(STT_WAIT_STORAGE_KEY),
      loadSttOptions(),
    ]);
    return {
      model: validModel(m, o), // 一覧に無いモデル（廃止・以前の "v5" などの値）は「おすすめ」に戻す
      wait: w === "fast" || w === "normal" || w === "slow" ? w : "normal",
    };
  } catch {
    return DEFAULT_STT_CHOICE;
  }
};

export const sttChoiceKey = (c: SttChoice) => `${c.model}/${c.wait}`;

const effectiveModel = (c: SttChoice, serverModel: string) => (c.model === "default" ? serverModel : c.model);

const waitSetting = (c: SttChoice, serverModel: string): WaitSetting => {
  const o = serverOptions;
  const model = effectiveModel(c, serverModel);
  return o?.waits_by_model?.[model]?.[c.wait] ?? o?.waits[c.wait] ?? BUILTIN_WAITS[c.wait];
};

/** 開始メッセージのうちモデルと終端検出の部分。serverModel は Lambda が配った stt_model */
export const sonioxModelConfig = (c: SttChoice, serverModel: string) => ({
  model: effectiveModel(c, serverModel),
  enable_endpoint_detection: true,
  ...waitSetting(c, serverModel).soniox,
});

/** 終端の後にアプリが送らずに待つ時間（chat.tsx の猶予） */
export const sttGraceMs = (c: SttChoice, serverModel: string) => {
  const g = Number(waitSetting(c, serverModel).grace_ms);
  return Number.isFinite(g) && g > 0 ? Math.min(g, 5000) : 0;
};
