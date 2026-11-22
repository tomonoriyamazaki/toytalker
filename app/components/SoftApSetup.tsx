/**
 * SoftAP で Wi-Fi を設定する画面（試作。ロードマップ45。おもちゃ設定のホームから開く）。
 * 流れ: 「おもちゃを探してつなぐ」→ OS の確認でつなぐ（入力なし）→ 本体が探した Wi-Fi の一覧から選ぶ
 *       → パスワードを送る → 本体がつながったら元の回線に戻り、機器を登録する。
 * 利用者が入れるのは家の Wi-Fi のパスワードだけ。API は lib/softap.ts
 */
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import {
  joinToy,
  leaveToy,
  saveFailureText,
  saveToToy,
  scanFromToy,
  ToyInfo,
  ToyNet,
  wifiModuleAvailable,
} from "../lib/softap";

type Props = {
  visible: boolean;
  onClose: () => void;
  /** 機器を登録する（クラウドの API。ネットに戻ってから呼ぶ）。できたら true */
  onRegister: (deviceId: string) => Promise<boolean>;
};

type Step = "enter" | "joining" | "pick" | "saving" | "registering" | "done";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export default function SoftApSetup({ visible, onClose, onRegister }: Props) {
  const [step, setStep] = useState<Step>("enter");
  const [info, setInfo] = useState<ToyInfo | null>(null);
  const [nets, setNets] = useState<ToyNet[]>([]);
  const [scanning, setScanning] = useState(false);
  const [homeSsid, setHomeSsid] = useState("");
  const [homePass, setHomePass] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [message, setMessage] = useState("");
  const joinedRef = useRef(false); // 親機につないだままか（閉じる時に離れるため）
  const toySsidRef = useRef(""); // つないだ親機の名前（離れる時に使う）

  useEffect(() => {
    if (!visible) return;
    setStep("enter");
    setMessage("");
    setInfo(null);
    setNets([]);
    setHomeSsid("");
    setHomePass("");
  }, [visible]);

  const close = async () => {
    if (joinedRef.current) {
      joinedRef.current = false;
      await leaveToy(toySsidRef.current);
    }
    onClose();
  };

  const loadNets = async (rescan: boolean) => {
    setScanning(true);
    try {
      setNets(await scanFromToy(rescan));
    } catch (e: any) {
      setMessage(e.message);
    } finally {
      setScanning(false);
    }
  };

  const join = async () => {
    if (!wifiModuleAvailable()) {
      setMessage("このアプリのビルドには Wi-Fi 接続の機能が入っていません（アプリの作り直しが要ります）。");
      return;
    }
    setMessage("");
    setStep("joining");
    try {
      const t0 = Date.now();
      const got = await joinToy();
      joinedRef.current = true;
      toySsidRef.current = got.name;
      setInfo(got);
      console.log(`[SOFTAP] joined id=${got.id} fw=${got.fw} ms=${Date.now() - t0}`);
      setStep("pick");
      loadNets(false);
    } catch (e: any) {
      console.log(`[SOFTAP] join failed: ${e.message}`);
      setMessage(e.message);
      setStep("enter");
    }
  };

  const save = async () => {
    const ssid = homeSsid.trim();
    if (!ssid) {
      setMessage("つなぐ Wi-Fi を選ぶか、名前を入れてください。");
      return;
    }
    if (homePass.length > 0 && homePass.length < 8) {
      setMessage("パスワードは 8 文字以上です。");
      return;
    }
    setMessage("");
    setStep("saving");
    try {
      const r = await saveToToy(ssid, homePass);
      console.log(`[SOFTAP] save result state=${r.state} reason=${r.reason}`);
      if (r.state === "failed") {
        setMessage(saveFailureText(r.reason));
        setStep("pick");
        return;
      }
      // つながった、または結果を受け取れなかった（本体が先に再起動した）。どちらも元の回線に戻って登録を試す
      joinedRef.current = false;
      await leaveToy(toySsidRef.current);
      setStep("registering");
      let ok = false;
      for (let i = 0; i < 8 && !ok && info; i++) {
        await sleep(i === 0 ? 3000 : 4000); // スマホが元の回線に戻るのを待つ
        ok = await onRegister(info.id);
      }
      console.log(`[SOFTAP] register ok=${ok}`);
      setMessage(
        ok
          ? "設定できました。おもちゃが起動の音を鳴らしたら使えます。"
          : r.state === "connected"
            ? "Wi-Fi の設定はできましたが、機器の登録ができませんでした。ネットにつながっているか確かめて、もう一度試してください。"
            : "結果を受け取れませんでした。おもちゃが起動の音を鳴らしたか確かめてください。"
      );
      setStep("done");
    } catch (e: any) {
      setMessage(`送れませんでした: ${e.message}`);
      setStep("pick");
    }
  };

  const busyText =
    step === "joining" ? "おもちゃの Wi-Fi につないでいます…"
    : step === "saving" ? "おもちゃが Wi-Fi につないでいます…"
    : step === "registering" ? "機器を登録しています…"
    : "";

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={close}>
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <TouchableOpacity onPress={close}>
            <Text style={s.back}>← 戻る</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>Wi-Fi でつなぐ（試作）</Text>
        </View>
        <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
          <ScrollView contentContainerStyle={s.wrap} keyboardShouldPersistTaps="handled">
            {message ? (
              <View style={s.statusBox}>
                <Text style={s.statusText}>{message}</Text>
              </View>
            ) : null}

            {busyText ? (
              <View style={s.center}>
                <ActivityIndicator size="large" color="#007AFF" />
                <Text style={s.loadingText}>{busyText}</Text>
              </View>
            ) : null}

            {step === "enter" && (
              <View style={s.form}>
                <Text style={s.note}>おもちゃのボタンを長押しして、ランプが速く点滅したら「おもちゃを探してつなぐ」を押します。確認が出たら「接続」を選んでください。</Text>
                <TouchableOpacity style={s.button} onPress={join}>
                  <Text style={s.buttonText}>おもちゃを探してつなぐ</Text>
                </TouchableOpacity>
              </View>
            )}

            {step === "pick" && (
              <View style={s.form}>
                <Text style={s.note}>{info ? `${info.name}（${info.id}、版 ${info.fw}）につながりました。` : ""}</Text>
                <View style={s.rowBetween}>
                  <Text style={s.label}>おもちゃをつなぐ Wi-Fi</Text>
                  <TouchableOpacity onPress={() => loadNets(true)} disabled={scanning}>
                    <Text style={s.link}>{scanning ? "探しています…" : "もう一度探す"}</Text>
                  </TouchableOpacity>
                </View>
                {scanning && nets.length === 0 ? <ActivityIndicator color="#007AFF" /> : null}
                {nets.map((n) => {
                  const selected = n.s === homeSsid;
                  return (
                    <TouchableOpacity key={n.s} style={[s.netItem, selected && s.netItemSelected]} onPress={() => setHomeSsid(n.s)}>
                      <Text style={[s.netName, selected && s.netNameSelected]}>{n.s}</Text>
                      <Text style={s.netSub}>{n.o ? "パスワードなし・" : ""}{n.r} dBm</Text>
                    </TouchableOpacity>
                  );
                })}
                <Text style={s.label}>Wi-Fi の名前（一覧に無い時は手で入れる）</Text>
                <TextInput style={s.input} value={homeSsid} onChangeText={setHomeSsid} autoCapitalize="none" autoCorrect={false} placeholder="Wi-Fi の名前" />
                <View style={s.rowBetween}>
                  <Text style={s.label}>パスワード</Text>
                  <TouchableOpacity onPress={() => setShowPass((v) => !v)}>
                    <Text style={s.link}>{showPass ? "隠す" : "表示"}</Text>
                  </TouchableOpacity>
                </View>
                <TextInput style={s.input} value={homePass} onChangeText={setHomePass} secureTextEntry={!showPass} autoCapitalize="none" autoCorrect={false} placeholder="Wi-Fi のパスワード" />
                <TouchableOpacity style={s.button} onPress={save}>
                  <Text style={s.buttonText}>この Wi-Fi につなぐ</Text>
                </TouchableOpacity>
              </View>
            )}

            {step === "done" && (
              <TouchableOpacity style={s.button} onPress={close}>
                <Text style={s.buttonText}>閉じる</Text>
              </TouchableOpacity>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const s = StyleSheet.create({
  root:            { flex: 1, backgroundColor: "#f5f5f5" },
  header:          { flexDirection: "row", alignItems: "center", padding: 16, gap: 12, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e0e0e0" },
  headerTitle:     { fontSize: 18, fontWeight: "600" },
  back:            { fontSize: 16, color: "#007AFF" },
  wrap:            { padding: 20, gap: 16 },
  statusBox:       { backgroundColor: "#e3f2fd", padding: 12, borderRadius: 8 },
  statusText:      { fontSize: 14, color: "#1976d2" },
  center:          { alignItems: "center", gap: 16, marginTop: 20 },
  loadingText:     { fontSize: 16, color: "#666" },
  form:            { gap: 12 },
  note:            { fontSize: 13, color: "#666" },
  label:           { fontSize: 14, fontWeight: "500", color: "#333" },
  link:            { fontSize: 14, color: "#007AFF" },
  rowBetween:      { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  input:           { backgroundColor: "#fff", padding: 14, borderRadius: 8, borderWidth: 1, borderColor: "#ddd", fontSize: 16 },
  button:          { backgroundColor: "#007AFF", padding: 16, borderRadius: 12, alignItems: "center" },
  buttonText:      { color: "#fff", fontSize: 16, fontWeight: "600" },
  netItem:         { backgroundColor: "#fff", padding: 14, borderRadius: 12, borderWidth: 1, borderColor: "#e0e0e0", flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  netItemSelected: { borderColor: "#007AFF", backgroundColor: "#f0f7ff" },
  netName:         { fontSize: 15, fontWeight: "500", flexShrink: 1 },
  netNameSelected: { color: "#007AFF", fontWeight: "600" },
  netSub:          { fontSize: 12, color: "#888", marginLeft: 8 },
});
