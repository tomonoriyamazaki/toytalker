// app/_layout.tsx
import { useEffect } from "react";
import { Slot } from "expo-router";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { syncAccount } from "../lib/auth";

export default function RootLayout() {
  // ログイン済みなら起動時に GET /me で owner_id をサーバーと揃える（別の端末で先にログインしていた場合など。docs/auth.md）
  useEffect(() => {
    syncAccount();
  }, []);
  return (
    <SafeAreaProvider>
      <Slot />
    </SafeAreaProvider>
  );
}
