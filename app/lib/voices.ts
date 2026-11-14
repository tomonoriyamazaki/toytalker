import { apiFetch } from "./api";

export type Voice = {
  voice_id: string;
  label: string;
  provider: string;
  vendor_id: string;
  isCustom?: boolean;
};

/**
 * 選べる声の一覧（みんなの声 + 自分のクローンボイス）。
 * 自分のクローンボイスは別の経路（GET /custom-voices）で、GET /voices には入っていない。取れなければ、みんなの声だけで続ける
 */
export async function loadVoices(ownerId: string | null): Promise<Voice[]> {
  const res = await apiFetch(`/voices`, { retries: 2 });
  const data = await res.json();
  const systemVoices: Voice[] = data.voices ?? [];
  let customVoices: Voice[] = [];
  if (ownerId) {
    try {
      const cr = await apiFetch(`/custom-voices?owner_id=${encodeURIComponent(ownerId)}`, { retries: 2 });
      const cd = await cr.json();
      customVoices = (cd.voices ?? [])
        .filter((v: any) => v.owner_id !== "system")
        .map((v: any) => ({
          voice_id: v.voice_id,
          label: v.label,
          provider: v.provider ?? "ZakiCorp",
          vendor_id: v.vendor_id,
          isCustom: true,
        }));
    } catch {}
  }
  return [...systemVoices, ...customVoices];
}
