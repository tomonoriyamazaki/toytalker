import { useState, useEffect } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

// owner_id はキーチェーン(SecureStore)を正として保持する。
// キーチェーンはアプリを削除しても端末に残るため、dev⇔TestFlightの入れ替えや
// 再インストールでもIDが変わらない(iOS)。AsyncStorageは旧バージョンからの移行元。
// ログイン（app/lib/auth.ts）すると、この端末の owner_id をアカウントに結び付ける。サーバーが別の owner_id を
// 返したとき（すでに他のアカウントのものだった）は setOwnerId で差し替え、画面にも伝える（docs/auth.md）。
const OWNER_ID_KEY = "owner_id";

let current: string | null = null;
let resolving: Promise<string> | null = null;
const listeners = new Set<(id: string) => void>();

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

/** サーバーが決めた owner_id に差し替える（ログイン時。app/lib/auth.ts） */
export async function setOwnerId(id: string): Promise<void> {
  current = id;
  await persist(id);
  listeners.forEach((l) => l(id));
}

export function useOwnerId(): string | null {
  const [ownerId, setState] = useState<string | null>(current);

  useEffect(() => {
    let alive = true;
    getStoredOwnerId().then((id) => { if (alive) setState(id); });
    const l = (id: string) => { if (alive) setState(id); };
    listeners.add(l);
    return () => { alive = false; listeners.delete(l); };
  }, []);

  return ownerId;
}
