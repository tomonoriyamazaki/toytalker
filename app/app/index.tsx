import { useEffect, useState } from "react";
import { ActivityIndicator, Image, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { LoginButtons } from "../components/LoginButtons";
import { getAuthRequired, useAuthSession } from "../lib/auth";

/**
 * 最初の画面（docs/auth.md）。
 *   - ログイン済み: 今までどおり「タップで会話へ」
 *   - 未ログイン: Google / Apple / 試験用メールのボタン。トークン無しを通す環境（RnD。/me の auth_required が false）では
 *     「ログインせずに使う」も出す。本番（auth_required が true）では出さず、ログインしないと先へ進めない
 */
export default function Home() {
  const router = useRouter();
  const { session, ready } = useAuthSession();
  const [authRequired, setAuthRequired] = useState<boolean | null>(null);
  useEffect(() => {
    getAuthRequired().then(setAuthRequired);
  }, []);

  const goChat = () => router.replace("/(tabs)/chat");
  const loading = !ready || (!session && authRequired === null);

  return (
    <SafeAreaView style={s.root}>
      {session ? (
        <Pressable style={s.touch} onPress={goChat}>
          <View style={s.wrap}>
            <Image source={require("../assets/images/mascot.png")} style={s.logo} resizeMode="contain" />
            <Text style={s.hint}>タップで会話へ</Text>
            <Text style={s.account}>
              {session.email ?? "ログイン中"}
              {session.provider === "Google" ? "（Google）" : session.provider === "SignInWithApple" ? "（Apple）" : ""}
            </Text>
          </View>
        </Pressable>
      ) : (
        <View style={s.touch}>
          <View style={s.wrap}>
            <Image source={require("../assets/images/mascot.png")} style={s.logo} resizeMode="contain" />
            {loading ? (
              <ActivityIndicator size="large" color="#007AFF" />
            ) : (
              <LoginButtons onSignedIn={goChat} onSkip={goChat} showSkip={authRequired === false} />
            )}
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}
const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  touch: { flex: 1, alignItems: "center", justifyContent: "center", padding: 24 },
  wrap: { width: "100%", alignItems: "center", gap: 16 },
  logo: { width: 280, height: 280 },
  hint: { color: "#888", fontSize: 16 },
  account: { color: "#aaa", fontSize: 12 },
});
