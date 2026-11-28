// 声の行（toytalker-voices の provider）や要求の model から、TTS の会社のキー（各 Lambda の TTS_TABLE のキー）を決める。
// 本文2本・相槌・読み上げの Lambda に同じ関数の写しがあったものを1つにした（2026-11-28）。
// 一致はゆるい（"gemini" を含めば Gemini）。エンジンの表を1つにして完全一致にするのはロードマップ14。
export function normalizeModelKey(k) {
  if (!k) return undefined;
  const s = String(k).toLowerCase();
  if (s.includes("openai"))      return "OpenAI";
  if (s.includes("google"))      return "Google";
  if (s.includes("gemini"))      return "Gemini";
  if (s.includes("elevenlabs"))  return "ElevenLabs";
  if (s.includes("cartesia"))    return "Cartesia";
  if (s.includes("fishaudio") || s.includes("fish")) return "FishAudio";
  if (s.includes("sakura"))      return "Sakura";
  if (s.includes("zakicorp") || s.includes("qwen")) return "ZakiCorp";
  return undefined;
}
