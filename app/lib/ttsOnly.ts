import { Buffer } from "buffer";
import { API_BASE_URL, requestHeaders } from "./api";

/* 読み上げLambda（テキスト→TTSのみ。音声バイナリ直返し）。固定ドメイン経由（app/lib/api.ts） */
const TTS_ONLY_URL = `${API_BASE_URL}/read-aloud-app`;

export type TtsAudio = { buf: ArrayBuffer; format: string; fallback: string | null };

/** 文章を指定のボイスで読み上げた音声を取る（POSTボディが必要なため downloadAsync は使えない → XHR） */
export const fetchTtsAudio = (body: { text: string; voice_id: string; owner_id?: string }): Promise<TtsAudio> =>
  new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", TTS_ONLY_URL, true);
    xhr.setRequestHeader("Content-Type", "application/json");
    xhr.responseType = "arraybuffer";
    xhr.timeout = 60000;
    xhr.onload = () => {
      if (xhr.status === 200) {
        const fmt =
          (xhr.getResponseHeader("x-audio-format") ||
            (xhr.getResponseHeader("content-type") === "audio/mpeg" ? "mp3" : "wav")).trim();
        // 選んだ声が混み合っていて別の声（ずんだもん）で作られたときだけ付く
        const fallback = xhr.getResponseHeader("x-tts-fallback")?.trim() || null;
        resolve({ buf: xhr.response as ArrayBuffer, format: fmt, fallback });
      } else {
        let msg = `HTTP ${xhr.status}`;
        try {
          msg = Buffer.from(new Uint8Array(xhr.response)).toString("utf8");
          const j = JSON.parse(msg);
          msg = j.error ?? msg;
        } catch {}
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("ネットワークエラー"));
    xhr.ontimeout = () => reject(new Error("タイムアウト"));
    // CloudFront → Lambda の署名用に本文のハッシュと、ログイン中ならトークンを添える（app/lib/api.ts）
    const json = JSON.stringify(body);
    requestHeaders(json)
      .then((h) => { for (const [k, v] of Object.entries(h)) xhr.setRequestHeader(k, v); })
      .catch(() => {})
      .finally(() => xhr.send(json));
  });
