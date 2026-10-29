import { useState, useEffect } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";
import { currentSession, subscribeAuth } from "../lib/auth";

// 端末の owner_id（ログインしていない人の仮の ID）はキーチェーン(SecureStore)を正として保持する。
// キーチェーンはアプリを削除しても端末に残るため、dev⇔TestFlightの入れ替えや
// 再インストールでもIDが変わらない(iOS)。AsyncStorageは旧バージョンからの移行元。
// ログイン中（app/lib/auth.ts）は、useOwnerId がアカウントの owner_id（GET /me の値）を返し、端末の ID は触らない。
// ログアウトすると端末の ID に戻る。2つは別の ID で、ログイン前のデータは引き継がない（docs/auth.md、2026-10-30決定）。
const OWNER_ID_KEY = "owner_id";

let current: string | null = null;
let resolving: Promise<string> | null = null;

function generateUUID(): string {
  const hex = "0123456789abcdef";
  let uuid = "";
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      uuid += "-";
    } else if (i === 14) {
      uuid += "4";
    } else {
      uuid += hex[Math.floor(Math.random() * 16)];
    }
  }
  return `u_${uuid}`;
}

async function persist(id: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(OWNER_ID_KEY, id, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  } catch {
    // キーチェーンに書けなくてもAsyncStorageで従来通り動作
  }
  await AsyncStorage.setItem(OWNER_ID_KEY, id);
}

async function resolveOwnerId(): Promise<string> {
  // ① キーチェーン(端末に永続)
  try {
    const fromKeychain = await SecureStore.getItemAsync(OWNER_ID_KEY);
    if (fromKeychain) return fromKeychain;
  } catch {
    // SecureStore不能な環境(一部Android等)はAsyncStorageのみで動かす
  }

  // ② AsyncStorage(旧バージョンの保存先) → あればキーチェーンへ移行
  const fromAsync = await AsyncStorage.getItem(OWNER_ID_KEY);
  const id = fromAsync ?? generateUUID();
  await persist(id);
  return id;
}

/** 端末の owner_id（無ければ作る）。同時に呼ばれても解決は1回 */
export async function getStoredOwnerId(): Promise<string> {
  if (current) return current;
  resolving ??= resolveOwnerId().then((id) => { current = id; return id; });
  return resolving;
}

/** いま使う owner_id。ログイン中はアカウントの ID、それ以外は端末の仮の ID。どちらも未解決なら null */
function effectiveOwnerId(): string | null {
  const s = currentSession();
  if (s) return s.ownerId ?? null; // ログイン直後で /me がまだなら null（取れ次第 subscribeAuth で更新される）
  return current;
}

export function useOwnerId(): string | null {
  const [ownerId, setState] = useState<string | null>(effectiveOwnerId());

  useEffect(() => {
    let alive = true;
    const update = () => { if (alive) setState(effectiveOwnerId()); };
    getStoredOwnerId().then(update);
    const unsubscribe = subscribeAuth(update);
    return () => { alive = false; unsubscribe(); };
  }, []);

  return ownerId;
}
