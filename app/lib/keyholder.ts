import { apiFetch } from "./api";

/**
 * ボイスキーホルダーモードの声（本体のボタンで鳴らす声）を、機器ごとに足す・消す。
 * 受け口は読み上げ Lambda（/read-aloud-app に keyholder を付けて送る。backend/toytalker-tts-only-lambda/keyholder.mjs）。
 * 足した声は、本体が次に会話モードで起動して Wi-Fi につながった時に入る（docs/esp32-firmware.md）
 */
export type KeyholderLine = {
  clip_id: string;
  text: string;
  voice_id: string;
  voice_label: string;
  seconds: number;
};

export type KeyholderState = {
  lines: KeyholderLine[];
  used_bytes: number;
  capacity_bytes: number;
  /** あと何秒ぶん入るか */
  seconds_left: number;
  max_lines: number;
  /** 本体が、声を受け取れる版で起動したことがあるか */
  device_ready: boolean;
  /** 本体に、この一覧とは別の声（USB で書いた声など）が入っている */
  device_has_voices: boolean;
  /** いまの一覧が本体に入っているか。一覧を一度も作っていなければ null */
  installed: boolean | null;
  updated_at: string | null;
};

export class KeyholderError extends Error {
  code: string;
  seconds?: number;
  state?: KeyholderState;
  constructor(code: string, extra: { seconds?: number; state?: KeyholderState } = {}) {
    super(code);
    this.code = code;
    this.seconds = extra.seconds;
    this.state = extra.state;
  }
}

async function call<T>(ownerId: string | null, keyholder: Record<string, unknown>): Promise<T> {
  const res = await apiFetch("/read-aloud-app", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ owner_id: ownerId ?? undefined, keyholder }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new KeyholderError(json?.error ?? `HTTP ${res.status}`, { seconds: json?.seconds, state: json?.state });
  return json as T;
}

export const listKeyholder = (ownerId: string | null, deviceId: string) =>
  call<{ state: KeyholderState }>(ownerId, { action: "list", device_id: deviceId });

/** 文を声にして足す。audio_b64 は本体が鳴らすのと同じ音（WAV） */
export const addKeyholderLine = (ownerId: string | null, deviceId: string, text: string, voiceId: string) =>
  call<{ state: KeyholderState; clip_id: string; audio_b64: string }>(ownerId, {
    action: "add", device_id: deviceId, text, voice_id: voiceId,
  });

export const removeKeyholderLine = (ownerId: string | null, deviceId: string, clipId: string) =>
  call<{ state: KeyholderState }>(ownerId, { action: "remove", device_id: deviceId, clip_id: clipId });

export const previewKeyholderLine = (ownerId: string | null, deviceId: string, clipId: string) =>
  call<{ clip_id: string; audio_b64: string }>(ownerId, { action: "preview", device_id: deviceId, clip_id: clipId });

/** 画面に出す文 */
export function keyholderErrorText(e: unknown, state?: KeyholderState | null): string {
  const code = e instanceof KeyholderError ? e.code : String((e as any)?.message ?? e);
  switch (code) {
    case "full": return "もう入りません。どれかを消してから足してください";
    case "too_long": {
      const made = e instanceof KeyholderError && e.seconds != null ? `${e.seconds}秒` : "この声";
      return `${made}は長すぎて入りません（空きは約${state?.seconds_left ?? 0}秒）。文を短くするか、どれかを消してください`;
    }
    case "text_too_long": return "文は80文字までです";
    case "no_balance": return "ポイントがなくなったため作れません";
    case "tts_failed": return "声を作れませんでした。少し待ってから、もう一度ためしてください";
    case "no_sound": return "音のない声ができました。文を変えてためしてください";
    case "conflict": return "ほかの端末で変更されました。この画面を開き直してください";
    case "not_owner": return "このおもちゃの持ち主ではありません";
    default: return `失敗しました: ${code}`;
  }
}
