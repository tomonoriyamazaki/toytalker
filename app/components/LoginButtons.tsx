import { useState } from "react";
import { ActivityIndicator, Alert, StyleSheet, Text, TouchableOpacity, View } from "react-native";
import { authConfigured, signIn, type Provider, type Session } from "../lib/auth";

/**
 * ログインのボタン一式（docs/auth.md）。最初の画面（app/index.tsx）と設定タブのアカウント画面で共用する。
 * Google / Apple の IdP が未設定の間は、ボタンを押しても Cognito の画面でエラーになるので、試験用のメールログインも並べる。
 * showSkip は「ログインせずに使う」（トークン無しを通す環境 = RnD だけ。本番は出さない）
 */
export function LoginButtons({ onSignedIn, onSkip, showSkip }: {
  onSignedIn?: (s: Session) => void;
  onSkip?: () => void;
  showSkip?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const doSignIn = async (provider?: Provider) => {
    setBusy(true);
    try {
      const s = await signIn(provider);
      if (s) onSignedIn?.(s);
    } catch (e: any) {
      Alert.alert("ログインできませんでした", e?.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };
  if (busy) return <ActivityIndicator size="large" color="#007AFF" style={{ marginVertical: 24 }} />;
  if (!authConfigured()) return <Text style={s.note}>このビルドにはログインの設定がありません。</Text>;
  return (
    <View style={s.wrap}>
      <TouchableOpacity style={[s.button, s.google]} onPress={() => doSignIn("Google")}>
        <Text style={s.buttonText}>Google でログイン</Text>
      </TouchableOpacity>
      <TouchableOpacity style={[s.button, s.apple]} onPress={() => doSignIn("SignInWithApple")}>
        <Text style={s.buttonText}>Apple でログイン</Text>
      </TouchableOpacity>
      <TouchableOpacity style={s.link} onPress={() => doSignIn()}>
        <Text style={s.linkText}>メールアドレスでログイン（試験用）</Text>
      </TouchableOpacity>
      {showSkip && onSkip ? (
        <TouchableOpacity style={s.link} onPress={onSkip}>
          <Text style={s.linkText}>ログインせずに使う</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const s = StyleSheet.create({
  wrap:       { width: "100%", gap: 12 },
  button:     { padding: 16, borderRadius: 12, alignItems: "center" },
  google:     { backgroundColor: "#007AFF" },
  apple:      { backgroundColor: "#111" },
  buttonText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  link:       { paddingVertical: 10, alignItems: "center" },
  linkText:   { fontSize: 14, color: "#007AFF" },
  note:       { fontSize: 13, color: "#888", textAlign: "center" },
});
