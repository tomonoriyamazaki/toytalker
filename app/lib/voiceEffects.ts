/**
 * クローンボイス用の声の加工（スマホ内で完結。16bit PCM の wav を受け取り、加工した wav を返す）。
 * 加工した声でクローンを作ると、その加工がボイスに残る（2026-11-04 の PC 実験でピッチは残ると確認。
 * ロボットは未確認）。ネイティブ部品を使わず JS の計算だけで作る。
 */

export type VoiceEffectId = "raw" | "high" | "helium" | "low" | "robot";

export const VOICE_EFFECTS: { id: VoiceEffectId; label: string; note: string }[] = [
  { id: "raw", label: "そのままの声", note: "録音した声そのまま" },
  { id: "high", label: "高い声", note: "ちょっと子どもっぽく" },
  { id: "helium", label: "ヘリウム声", note: "うんと高く" },
  { id: "low", label: "かいじゅう声", note: "低くて太い声" },
  { id: "robot", label: "ロボット声", note: "おためし（残らないかも）" },
];

type Pcm = { sampleRate: number; samples: Float32Array };

/** PCM の wav を読む（整数 8/16/24/32bit と float 32/64bit。2ch 以上なら平均して 1ch に）。
 *  data の長さが 0 や壊れていても残り全部を使う */
export function decodeWav(bytes: Uint8Array): Pcm {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("wav ではありません");
  let off = 12, channels = 1, sampleRate = 24000, bits = 16, isFloat = false;
  while (off + 8 <= bytes.length) {
    const id = tag(off);
    let size = dv.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      let fmt = dv.getUint16(body, true);
      channels = dv.getUint16(body + 2, true);
      sampleRate = dv.getUint32(body + 4, true);
      bits = dv.getUint16(body + 14, true);
      // WAVE_FORMAT_EXTENSIBLE は SubFormat GUID の先頭2バイトが本当の形式
      if (fmt === 0xfffe && size >= 26) fmt = dv.getUint16(body + 24, true);
      if (fmt !== 1 && fmt !== 3) throw new Error("圧縮された wav には対応していません");
      isFloat = fmt === 3;
    } else if (id === "data") {
      const bps = bits / 8;
      const read: ((o: number) => number) | null =
        isFloat && bits === 32 ? (o) => dv.getFloat32(o, true)
        : isFloat && bits === 64 ? (o) => dv.getFloat64(o, true)
        : !isFloat && bits === 8 ? (o) => (dv.getUint8(o) - 128) / 128
        : !isFloat && bits === 16 ? (o) => dv.getInt16(o, true) / 32768
        : !isFloat && bits === 24 ? (o) => ((dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getInt8(o + 2) << 16)) / 8388608)
        : !isFloat && bits === 32 ? (o) => dv.getInt32(o, true) / 2147483648
        : null;
      if (!read) throw new Error(`${bits}bit の wav には対応していません`);
      if (size === 0 || body + size > bytes.length) size = bytes.length - body;
      const frames = Math.floor(size / (bps * channels));
      const samples = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let sum = 0;
        for (let c = 0; c < channels; c++) sum += read(body + (i * channels + c) * bps);
        samples[i] = sum / channels;
      }
      return { sampleRate, samples };
    }
    off = body + size + (size & 1);
  }
  throw new Error("wav に音声データがありません");
}

export function encodeWav({ sampleRate, samples }: Pcm): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const dv = new DataView(out.buffer);
  const put = (o: number, s: string) => { for (let i = 0; i < 4; i++) out[o + i] = s.charCodeAt(i); };
  put(0, "RIFF"); dv.setUint32(4, 36 + samples.length * 2, true); put(8, "WAVE");
  put(12, "fmt "); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
  dv.setUint32(24, sampleRate, true); dv.setUint32(28, sampleRate * 2, true);
  dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
  put(36, "data"); dv.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    dv.setInt16(44 + i * 2, Math.round(v * 32767), true);
  }
  return out;
}

/** 速さを変える（ピッチと声質が一緒に動く。factor>1 で高く速く、<1 で低く遅く）。
 *  高くするときは折り返し雑音を抑えるため、先に新しいナイキスト付近より上を軽く落とす */
function resample(x: Float32Array, factor: number): Float32Array {
  let src = x;
  if (factor > 1) {
    src = new Float32Array(x.length);
    const a = Math.exp(-2 * Math.PI * (0.45 / factor));
    let y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      y1 = (1 - a) * x[i] + a * y1;
      y2 = (1 - a) * y1 + a * y2;
      src[i] = y2;
    }
  }
  const n = Math.floor(src.length / factor);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const p = i * factor, j = Math.floor(p), t = p - j;
    out[i] = src[j] * (1 - t) + (src[j + 1] ?? src[j]) * t;
  }
  return out;
}

/** リング変調（正弦波を掛ける）。元の声と少し混ぜて言葉が聞き取れるようにする */
function ringMod(x: Float32Array, sampleRate: number, hz: number): Float32Array {
  const out = new Float32Array(x.length);
  const w = (2 * Math.PI * hz) / sampleRate;
  for (let i = 0; i < x.length; i++) out[i] = x[i] * (0.8 * Math.sin(w * i) + 0.2);
  return out;
}

/** 一番大きい所を -3dB にそろえる（小さく録れた声を持ち上げる。上げすぎは 20 倍まで） */
function normalize(x: Float32Array): Float32Array {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak === 0) return x;
  const g = Math.min(0.708 / peak, 20);
  const out = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * g;
  return out;
}

export function applyVoiceEffect(pcm: Pcm, effect: VoiceEffectId): Pcm {
  const { sampleRate, samples } = pcm;
  const fx: Record<VoiceEffectId, () => Float32Array> = {
    raw: () => samples,
    high: () => resample(samples, 1.3),
    helium: () => resample(samples, 1.6),
    low: () => resample(samples, 0.75),
    robot: () => ringMod(samples, sampleRate, 50),
  };
  return { sampleRate, samples: normalize(fx[effect]()) };
}
