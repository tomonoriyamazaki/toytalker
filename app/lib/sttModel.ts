/**
 * Soniox のモデルと「話し終わりの待ち」の選択（設定画面「音声認識」で選ぶ。ロードマップ18）。
 *
 * モデル: 既定は "default" で、一時キー Lambda が配る `stt_model`（infra/config/stages.ts の sonioxModel）に従う。
 * それ以外はこの端末だけ上書きする。v5 と v6 を deploy せずに聞き比べるための選択肢。
 * stt-rt-v5 は 2026-12-15 に廃止され v6 へ自動で振り替わるので、その後は "v5" の選択肢を消す。
 *
 * 待ち: 小さい子は話の途中で間が空き、既定の終端検出だと置いていかれる（2026-11-08、4歳半の子で v5 でも）。
 * 既定は「ふつう」（2026-11-08、大人と4歳半の子で試して決めた）。
 * 会話を区切るのは Soniox の終端（<end>）だけなので、Soniox の設定で区切りにくくする。
 * endpoint_sensitivity をマイナスにすると「文が終わった」と判断しにくくなり（-1.0〜0、v5・v6 とも可）、
 * max_endpoint_delay_ms はその上限（既定 2000、500〜3000）。値は仮で、子どもに話してもらって詰める。
 * v6 の低遅延設定（level 2・感度 0.3・最大 1500ms）は子どもには早すぎたので外した。
 */
import AsyncStorage from "@react-native-async-storage/async-storage";

export type SttModelChoice = "default" | "v5" | "v6";
export type SttWaitChoice = "fast" | "normal" | "slow";

export const STT_MODEL_STORAGE_KEY = "sttModelChoice";
// 2026-11-08 に「はやい / ふつう / ゆっくり」へ名前と中身を付け替えたので、以前の保存値（sttWaitChoice）は読まない
export const STT_WAIT_STORAGE_KEY = "sttWait";

export const STT_MODEL_OPTIONS: { value: SttModelChoice; label: string; description: string }[] = [
  { value: "default", label: "おすすめ", description: "サーバーが決めたモデルを使います。" },
  { value: "v5", label: "v5", description: "stt-rt-v5。2026-12-15 に廃止され v6 へ振り替わります。" },
  { value: "v6", label: "v6", description: "stt-rt-v6。" },
];

export const STT_WAIT_OPTIONS: { value: SttWaitChoice; label: string; description: string }[] = [
  { value: "fast", label: "はやい", description: "話し終わったらすぐ返事をします。話の途中で切れることがあります。" },
  { value: "normal", label: "ふつう", description: "少し待ってから返事をします。おすすめ。" },
  { value: "slow", label: "ゆっくり", description: "さらに待ちます。話の途中で間が空く小さい子向け。返事は遅くなります。" },
];

const MODELS: Record<SttModelChoice, string | null> = {
  default: null, // Lambda の値を使う
  v5: "stt-rt-v5",
  v6: "stt-rt-v6",
};

const WAITS: Record<SttWaitChoice, Record<string, number>> = {
  fast: {},
  normal: { endpoint_sensitivity: -0.3, max_endpoint_delay_ms: 2500 },
  slow: { endpoint_sensitivity: -0.6, max_endpoint_delay_ms: 3000 },
};

/**
 * 終端（<end>）が来てからも送らずに待つ時間（アプリ側の猶予）。その間にまた声が出たら同じ発話としてつなぐ。
 * Soniox は文として終わって聞こえると設定に関係なく即座に区切るので（2026-11-08 実測、終端まで 19〜48ms の回があった）、
 * 子どもが言葉を切ってから続ける分はアプリで拾う。値は仮。
 */
const GRACE_MS: Record<SttWaitChoice, number> = { fast: 0, normal: 600, slow: 1200 };
export const sttGraceMs = (c: SttChoice) => GRACE_MS[c.wait];

export type SttChoice = { model: SttModelChoice; wait: SttWaitChoice };
export const DEFAULT_STT_CHOICE: SttChoice = { model: "default", wait: "normal" };

export const loadSttChoice = async (): Promise<SttChoice> => {
  try {
    const [m, w] = await Promise.all([
      AsyncStorage.getItem(STT_MODEL_STORAGE_KEY),
      AsyncStorage.getItem(STT_WAIT_STORAGE_KEY),
    ]);
    return {
      // 以前の選択肢 "v6-fast" など、無くなった値は既定に戻す
      model: m && m in MODELS ? (m as SttModelChoice) : "default",
      wait: w && w in WAITS ? (w as SttWaitChoice) : "normal",
    };
  } catch {
    return DEFAULT_STT_CHOICE;
  }
};

export const sttChoiceKey = (c: SttChoice) => `${c.model}/${c.wait}`;

/** 開始メッセージのうちモデルと終端検出の部分。serverModel は Lambda が配った値 */
export const sonioxModelConfig = (c: SttChoice, serverModel: string) => ({
  model: MODELS[c.model] ?? serverModel,
  enable_endpoint_detection: true,
  ...WAITS[c.wait],
});
