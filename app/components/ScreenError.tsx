// 画面の描画で例外が出たときに、アプリを終了させずに出す画面。
// Expo Router は、画面のファイルが ErrorBoundary を export していると、その画面をこれで包む（描画中の例外を受け止める仕組みは他に無い）。
// 各タブの画面と app/_layout.tsx から `export { ErrorBoundary } from ".../components/ScreenError"` で使う。
// 「もう一度ためす」は画面を作り直す（その画面の入力や開いていた階層は最初に戻る）。
import { useEffect } from "react";
import { StyleSheet, Text, TouchableOpacity, View } from "react-native";
import type { ErrorBoundaryProps } from "expo-router";

export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  useEffect(() => {
    console.error("[ScreenError]", error);
  }, [error]);

  return (
    <View style={s.root}>
      <Text style={s.title}>この画面を表示できませんでした</Text>
      <Text style={s.body}>もう一度ためしても直らないときは、アプリを一度閉じて開き直してください。</Text>
      <TouchableOpacity style={s.button} onPress={() => { retry(); }} activeOpacity={0.7}>
        <Text style={s.buttonText}>もう一度ためす</Text>
      </TouchableOpacity>
      {/* 原因を調べる手がかり（運営者に伝えてもらう用）。長いものは切る */}
      <Text style={s.detail} numberOfLines={4}>{String(error?.message ?? error).slice(0, 300)}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  root:       { flex: 1, alignItems: "center", justifyContent: "center", padding: 32, backgroundColor: "#fff" },
  title:      { fontSize: 17, fontWeight: "700", color: "#333", textAlign: "center" },
  body:       { fontSize: 14, color: "#666", textAlign: "center", lineHeight: 21, marginTop: 12 },
  button:     { marginTop: 24, paddingVertical: 12, paddingHorizontal: 28, borderRadius: 10, backgroundColor: "#007AFF" },
  buttonText: { fontSize: 15, fontWeight: "600", color: "#fff" },
  detail:     { fontSize: 11, color: "#aaa", textAlign: "center", marginTop: 24 },
});
