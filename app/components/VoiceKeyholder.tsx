/**
 * ボイスキーホルダーモードの声を選ぶ画面（デバイス設定から開く）。
 * 文と声を選んで足すと、サーバーが本体用の音声を作り、本体が次に会話モードで起動した時に取り込む。
 * 試聴は、本体が鳴らすのと同じ音（圧縮した後の音）を鳴らす。API は lib/keyholder.ts
 */
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import * as FileSystem from "expo-file-system";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Sound from "react-native-sound";
import { loadVoices, Voice } from "../lib/voices";
import {
  addKeyholderLine,
  keyholderErrorText,
  KeyholderError,
  KeyholderLine,
  KeyholderState,
  listKeyholder,
  previewKeyholderLine,
  removeKeyholderLine,
} from "../lib/keyholder";

type Props = {
  visible: boolean;
  onClose: () => void;
  ownerId: string | null;
  deviceId: string | null;
};

const VOICE_KEY = "keyholderVoiceId";
const MAX_TEXT = 80;
// 試聴の音は端末の一時置き場に残す（同じ声をもう一度聞く時に取り直さない。消えても取り直せる）
const clipPath = (clipId: string) => `${FileSystem.cacheDirectory}keyholder-${clipId}.wav`;

export default function VoiceKeyholder({ visible, onClose, ownerId, deviceId }: Props) {
  const [state, setState] = useState<KeyholderState | null>(null);
  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<Voice | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [text, setText] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const soundRef = useRef<Sound | null>(null);

  const stopPlayback = () => {
    try {
      soundRef.current?.stop();
      soundRef.current?.release();
    } catch {}
    soundRef.current = null;
  };

  useEffect(() => {
    if (!visible || !deviceId) return;
    let alive = true;
    setState(null);
    setMessage("");
    setText("");
    setLoading(true);
    (async () => {
      try {
        const [list, vs] = await Promise.all([listKeyholder(ownerId, deviceId), loadVoices(ownerId).catch(() => [] as Voice[])]);
        if (!alive) return;
        setState(list.state);
        setVoices(vs);
        const savedId = await AsyncStorage.getItem(VOICE_KEY);
        if (alive) setSelectedVoice(vs.find((v) => v.voice_id === savedId) ?? vs[0] ?? null);
      } catch (e) {
        if (alive) setMessage(keyholderErrorText(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      stopPlayback();
    };
  }, [visible, deviceId, ownerId]);

  const playWav = async (clipId: string, audioB64?: string) => {
    stopPlayback();
    const path = clipPath(clipId);
    if (audioB64) await FileSystem.writeAsStringAsync(path, audioB64, { encoding: FileSystem.EncodingType.Base64 });
    Sound.setCategory("Playback");
    const snd = new Sound(path.replace("file://", ""), "", (err) => {
      if (err) {
        setMessage("再生に失敗しました");
        return;
      }
      soundRef.current = snd;
      snd.play(() => {
        snd.release();
        if (soundRef.current === snd) soundRef.current = null;
      });
    });
  };

  const onPlay = async (line: KeyholderLine) => {
    if (!deviceId) return;
    setMessage("");
    try {
      const cached = await FileSystem.getInfoAsync(clipPath(line.clip_id));
      if (cached.exists) return await playWav(line.clip_id);
      const res = await previewKeyholderLine(ownerId, deviceId, line.clip_id);
      await playWav(line.clip_id, res.audio_b64);
    } catch (e) {
      setMessage(keyholderErrorText(e, state));
    }
  };

  const onAdd = async () => {
    const t = text.trim();
    if (!deviceId || !t || busy) return;
    if (!selectedVoice) {
      setMessage("声を選んでください");
      return;
    }
    setBusy(true);
    setMessage("声を作っています…");
    stopPlayback();
    try {
      const res = await addKeyholderLine(ownerId, deviceId, t, selectedVoice.voice_id);
      setState(res.state);
      setText("");
      setMessage("");
      await playWav(res.clip_id, res.audio_b64);
    } catch (e) {
      if (e instanceof KeyholderError && e.state) setState(e.state);
      setMessage(keyholderErrorText(e, e instanceof KeyholderError && e.state ? e.state : state));
    } finally {
      setBusy(false);
    }
  };

  const onRemove = (line: KeyholderLine) => {
    if (!deviceId || busy) return;
    Alert.alert("この声を消しますか？", line.text, [
      { text: "キャンセル", style: "cancel" },
      {
        text: "消す",
        style: "destructive",
        onPress: async () => {
          setBusy(true);
          setMessage("");
          stopPlayback();
          try {
            const res = await removeKeyholderLine(ownerId, deviceId, line.clip_id);
            setState(res.state);
            FileSystem.deleteAsync(clipPath(line.clip_id), { idempotent: true }).catch(() => {});
          } catch (e) {
            setMessage(keyholderErrorText(e, state));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  const pickVoice = (v: Voice) => {
    setSelectedVoice(v);
    setPickerOpen(false);
    AsyncStorage.setItem(VOICE_KEY, v.voice_id).catch(() => {});
  };

  // いまの一覧が本体に入っているか
  const syncText = (() => {
    if (!state) return "";
    if (!state.device_ready) {
      return "このおもちゃは、まだ声を受け取れません（本体の更新が必要です。更新の後に、Wi-Fi のある場所で電源を入れ直してください）";
    }
    if (state.installed === null) {
      return state.device_has_voices
        ? "本体には、はじめから入れてある声が入っています。ここで声を足すと、足した声に入れ替わります"
        : "まだ声が入っていません";
    }
    if (state.installed) return state.lines.length > 0 ? "この一覧は本体に入っています" : "本体の声は空になっています";
    if (state.lines.length === 0) {
      return "本体には、まだ前の声が残っています。Wi-Fi のある場所で、おはなしモードのまま電源を入れ直すと消えます";
    }
    return"まだ本体に入っていません。Wi-Fi のある場所で、おはなしモードのまま電源を入れ直すと入ります";
  })();

  const providers = [...new Set(voices.map((v) => v.provider))];
  const full = !!state && (state.lines.length >= state.max_lines || state.seconds_left < 0.5);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <SafeAreaView style={st.root}>
        <View style={st.header}>
          <TouchableOpacity onPress={onClose} style={st.backBtn}>
            <Text style={st.backText}>‹ 戻る</Text>
          </TouchableOpacity>
          <Text style={st.title}>ボイスキーホルダー</Text>
          <View style={{ width: 56 }} />
        </View>

        <ScrollView contentContainerStyle={st.body} keyboardShouldPersistTaps="handled">
          <Text style={st.help}>
            おもちゃのボタンを3回つづけて押すと、ここに入れた声をボタンで鳴らすモードになります（Wi-Fi のない場所でも鳴ります）。もう一度3回押すと、おはなしモードに戻ります。
          </Text>

          {loading && <ActivityIndicator style={{ marginVertical: 24 }} />}

          {state && (
            <>
              <View style={st.statusBox}>
                <Text style={st.statusText}>{syncText}</Text>
                <Text style={st.statusSub}>
                  {state.lines.length} / {state.max_lines} 件・あと約 {state.seconds_left} 秒ぶん入ります
                </Text>
              </View>

              {state.lines.map((line) => (
                <View key={line.clip_id} style={st.row}>
                  <View style={st.rowText}>
                    <Text style={st.lineText}>{line.text}</Text>
                    <Text style={st.lineSub}>
                      {line.voice_label}・{line.seconds} 秒
                    </Text>
                  </View>
                  <TouchableOpacity style={st.rowBtn} onPress={() => onPlay(line)}>
                    <Text style={st.rowBtnText}>▶</Text>
                  </TouchableOpacity>
                  <TouchableOpacity style={st.rowBtn} onPress={() => onRemove(line)} disabled={busy}>
                    <Text style={[st.rowBtnText, st.removeText]}>消す</Text>
                  </TouchableOpacity>
                </View>
              ))}

              <Text style={st.label}>声</Text>
              <TouchableOpacity style={st.voiceSelect} onPress={() => setPickerOpen(true)}>
                <Text style={st.voiceSelectText}>
                  {selectedVoice ? `${selectedVoice.label}（${selectedVoice.provider}）` : "選択してください"}
                </Text>
                <Text style={st.chevron}>▾</Text>
              </TouchableOpacity>

              <Text style={st.label}>しゃべる文</Text>
              <TextInput
                style={st.input}
                value={text}
                onChangeText={setText}
                placeholder="例: おはよう！きょうも いっしょに あそぼうね"
                maxLength={MAX_TEXT}
                multiline
                editable={!busy}
              />
              <TouchableOpacity
                style={[st.addBtn, (busy || full || !text.trim()) && st.addBtnDisabled]}
                onPress={onAdd}
                disabled={busy || full || !text.trim()}
              >
                {busy ? <ActivityIndicator color="#fff" /> : <Text style={st.addBtnText}>声を作って足す</Text>}
              </TouchableOpacity>
              <Text style={st.note}>
                {full ? "いっぱいです。どれかを消すと足せます。" : "声を作るたびに、読み上げと同じだけポイントを使います。作った声はすぐに鳴らして確かめられます。"}
              </Text>
            </>
          )}

          {message ? <Text style={st.message}>{message}</Text> : null}
        </ScrollView>

        <Modal visible={pickerOpen} transparent animationType="fade" onRequestClose={() => setPickerOpen(false)}>
          <Pressable style={st.pickerOverlay} onPress={() => setPickerOpen(false)}>
            <View style={st.pickerBox}>
              <Text style={st.pickerHeader}>声を選ぶ</Text>
              <ScrollView>
                {providers.map((provider) => (
                  <View key={provider}>
                    <Text style={st.pickerSection}>{provider}</Text>
                    {voices
                      .filter((v) => v.provider === provider)
                      .map((v) => (
                        <TouchableOpacity
                          key={v.voice_id}
                          style={[st.pickerItem, selectedVoice?.voice_id === v.voice_id && st.pickerItemActive]}
                          onPress={() => pickVoice(v)}
                        >
                          <Text style={st.pickerItemText}>
                            {v.label}
                            {v.isCustom ? "（じぶんの声）" : ""}
                          </Text>
                          {selectedVoice?.voice_id === v.voice_id && <Text style={st.pickerCheck}>✓</Text>}
                        </TouchableOpacity>
                      ))}
                  </View>
                ))}
              </ScrollView>
            </View>
          </Pressable>
        </Modal>
      </SafeAreaView>
    </Modal>
  );
}

const st = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#f5f5f5" },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, paddingVertical: 12, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e0e0e0" },
  backBtn: { width: 56 },
  backText: { fontSize: 16, color: "#007AFF" },
  title: { fontSize: 17, fontWeight: "600" },
  body: { padding: 16, gap: 10 },
  help: { fontSize: 13, color: "#555", lineHeight: 19 },
  statusBox: { backgroundColor: "#eef4ff", borderRadius: 12, padding: 12 },
  statusText: { fontSize: 14, color: "#1a3d7c", lineHeight: 20 },
  statusSub: { fontSize: 12, color: "#4a628f", marginTop: 4 },
  row: { backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: "#e0e0e0", padding: 12, flexDirection: "row", alignItems: "center", gap: 8 },
  rowText: { flex: 1 },
  lineText: { fontSize: 15 },
  lineSub: { fontSize: 12, color: "#888", marginTop: 2 },
  rowBtn: { paddingHorizontal: 10, paddingVertical: 8 },
  rowBtnText: { fontSize: 15, color: "#007AFF" },
  removeText: { color: "#d33" },
  label: { fontSize: 13, color: "#666", marginTop: 8 },
  voiceSelect: { backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: "#e0e0e0", padding: 14, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  voiceSelectText: { fontSize: 15, flex: 1 },
  chevron: { fontSize: 16, color: "#999" },
  input: { backgroundColor: "#fff", borderRadius: 12, borderWidth: 1, borderColor: "#e0e0e0", padding: 14, fontSize: 15, minHeight: 64, textAlignVertical: "top" },
  addBtn: { backgroundColor: "#007AFF", borderRadius: 12, padding: 14, alignItems: "center" },
  addBtnDisabled: { backgroundColor: "#a9c8f0" },
  addBtnText: { color: "#fff", fontSize: 16, fontWeight: "600" },
  note: { fontSize: 12, color: "#888", lineHeight: 17 },
  message: { fontSize: 14, color: "#c33", marginTop: 4 },
  pickerOverlay: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "center", padding: 24 },
  pickerBox: { backgroundColor: "#fff", borderRadius: 14, maxHeight: "75%", paddingVertical: 8 },
  pickerHeader: { fontSize: 16, fontWeight: "600", padding: 14 },
  pickerSection: { fontSize: 12, color: "#888", paddingHorizontal: 14, paddingTop: 10, paddingBottom: 4 },
  pickerItem: { paddingHorizontal: 14, paddingVertical: 12, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  pickerItemActive: { backgroundColor: "#eef4ff" },
  pickerItemText: { fontSize: 15 },
  pickerCheck: { fontSize: 15, color: "#007AFF" },
});
