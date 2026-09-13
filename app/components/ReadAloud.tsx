/**
 * 読み上げモード（テキスト → TTSのみ → ローカル保存 → 再生）。
 * 会話(chat.tsx)とは完全に独立。session_id/履歴/STTには一切触れない。
 * Lambda: toytalker-tts-only-lambda（音声バイナリを直接ストリーミング返却。サーバー非保持）。
 */
import { useEffect, useRef, useState } from "react";
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  Modal,
  Pressable,
  Animated,
  Dimensions,
  ActivityIndicator,
  Platform,
} from "react-native";
import * as FileSystem from "expo-file-system";
import * as Sharing from "expo-sharing";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Sound from "react-native-sound";
import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from "expo-av";
import { Buffer } from "buffer";

/* toytalker-tts-only-lambda（テキスト→TTSのみ。音声バイナリ直返し）*/
const TTS_ONLY_URL =
  "https://y2ln7ndym3ktjhnkqgzwrk7ogu0ikkno.lambda-url.ap-northeast-1.on.aws/";
/* ボイス一覧（toytalker-device-setting-lambda の GET /voices）*/
const DEVICE_SETTING_URL =
  "https://7k6nkpy3tf2drljy77pnouohjm0buoux.lambda-url.ap-northeast-1.on.aws";

const RECENT_KEY = "readAloudRecents";
const MAX_RECENTS = 20;

type Voice = {
  voice_id: string;
  label: string;
  provider: string;
  vendor_id: string;
  isCustom?: boolean;
};
type Recent = {
  id: string;
  text: string;
  voiceId: string;
  voiceLabel: string;
  format: string;
  fileName: string;
  createdAt: number;
};

type Props = {
  visible: boolean;
  onClose: () => void;
  ownerId: string | null;
};

// 読み上げ音声は永続ディレクトリに保存（端末側で完結＝ダウンロード/保存を兼ねる）
const AUDIO_DIR = `${FileSystem.documentDirectory}read-aloud/`;

export default function ReadAloud({ visible, onClose, ownerId }: Props) {
  const { width: SCREEN_W } = Dimensions.get("window");
  const slideAnim = useRef(new Animated.Value(SCREEN_W)).current;
  const [mounted, setMounted] = useState(false);

  const [voices, setVoices] = useState<Voice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<Voice | null>(null);
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);

  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string>("");
  const [recents, setRecents] = useState<Recent[]>([]);

  const soundRef = useRef<Sound | null>(null);

  // スライドイン/アウト
  useEffect(() => {
    if (visible) {
      setMounted(true);
      slideAnim.setValue(SCREEN_W);
      Animated.timing(slideAnim, { toValue: 0, duration: 260, useNativeDriver: true }).start();
    } else if (mounted) {
      Animated.timing(slideAnim, { toValue: SCREEN_W, duration: 220, useNativeDriver: true }).start(
        () => setMounted(false)
      );
    }
  }, [visible]);

  // 初期化（ディレクトリ確保・ボイス取得・履歴復元・保存ボイス復元）
  useEffect(() => {
    if (!visible) return;
    (async () => {
      try {
        const info = await FileSystem.getInfoAsync(AUDIO_DIR);
        if (!info.exists) await FileSystem.makeDirectoryAsync(AUDIO_DIR, { intermediates: true });
      } catch {}
      loadRecents();
      loadVoices();
    })();
  }, [visible]);

  const loadVoices = async () => {
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/voices`);
      const data = await res.json();
      const systemVoices: Voice[] = data.voices ?? [];

      // ユーザー自身のカスタムボイス（ZakiCorp / Cartesia）は別エンドポイント。
      // settings.tsx と同じ方式でマージ（GET /voices には含まれない）。
      let customVoices: Voice[] = [];
      if (ownerId) {
        try {
          const cr = await fetch(
            `${DEVICE_SETTING_URL}/custom-voices?owner_id=${encodeURIComponent(ownerId)}`
          );
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
        } catch {
          // カスタムボイス取得失敗時はシステムボイスのみで継続
        }
      }

      const vs = [...systemVoices, ...customVoices];
      setVoices(vs);
      const savedId = await AsyncStorage.getItem("readAloudVoiceId");
      const found = vs.find((v) => v.voice_id === savedId);
      setSelectedVoice(found ?? vs[0] ?? null);
    } catch {
      setStatus("ボイス一覧の取得に失敗しました");
    }
  };

  const loadRecents = async () => {
    try {
      const raw = await AsyncStorage.getItem(RECENT_KEY);
      const list: Recent[] = raw ? JSON.parse(raw) : [];
      // 実ファイルが残っているものだけ
      const alive: Recent[] = [];
      for (const r of list) {
        const fi = await FileSystem.getInfoAsync(`${AUDIO_DIR}${r.fileName}`);
        if (fi.exists) alive.push(r);
      }
      setRecents(alive);
      if (alive.length !== list.length) {
        await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(alive));
      }
    } catch {}
  };

  const persistRecents = async (list: Recent[]) => {
    setRecents(list);
    try {
      await AsyncStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch {}
  };

  const pickVoice = (v: Voice) => {
    setSelectedVoice(v);
    setVoicePickerOpen(false);
    AsyncStorage.setItem("readAloudVoiceId", v.voice_id);
  };

  const stopPlayback = () => {
    try {
      soundRef.current?.stop();
      soundRef.current?.release();
    } catch {}
    soundRef.current = null;
  };

  // バックグラウンドでも再生継続できるようオーディオセッションを再設定。
  // chat.tsx が staysActiveInBackground:false に戻すため、再生前に毎回設定する。
  // （iOS は app.json の UIBackgroundModes:["audio"] と併用で初めて有効）
  const ensureBackgroundAudio = async () => {
    try {
      await Audio.setAudioModeAsync({
        staysActiveInBackground: true,
        playsInSilentModeIOS: true,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        shouldDuckAndroid: true,
      });
    } catch {
      // Android(現状アプリ未提供)では UIBackgroundModes 非対応。将来フォアグラウンドサービスで対応。
    }
  };

  const playFile = async (fileName: string) => {
    stopPlayback();
    await ensureBackgroundAudio();
    const path = `${AUDIO_DIR}${fileName}`.replace("file://", "");
    Sound.setCategory("Playback");
    const snd = new Sound(path, "", (err) => {
      if (err) {
        setStatus("再生に失敗しました");
        soundRef.current = null;
        return;
      }
      soundRef.current = snd;
      snd.play((ok) => {
        snd.release();
        soundRef.current = null;
        if (!ok) setStatus("再生に失敗しました");
      });
    });
  };

  // arraybuffer 取得（POSTボディが必要なため downloadAsync は使えない → XHR）
  const fetchAudio = (body: object): Promise<{ buf: ArrayBuffer; format: string }> =>
    new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", TTS_ONLY_URL, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.responseType = "arraybuffer";
      xhr.timeout = 60000;
      xhr.onload = () => {
        if (xhr.status === 200) {
          const fmt =
            (xhr.getResponseHeader("x-audio-format") ||
              (xhr.getResponseHeader("content-type") === "audio/mpeg" ? "mp3" : "wav")).trim();
          resolve({ buf: xhr.response as ArrayBuffer, format: fmt });
        } else {
          let msg = `HTTP ${xhr.status}`;
          try {
            msg = Buffer.from(new Uint8Array(xhr.response)).toString("utf8");
            const j = JSON.parse(msg);
            msg = j.error ?? msg;
          } catch {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error("ネットワークエラー"));
      xhr.ontimeout = () => reject(new Error("タイムアウト"));
      xhr.send(JSON.stringify(body));
    });

  const onSpeak = async () => {
    const t = text.trim();
    if (!t) return;
    if (!selectedVoice) {
      setStatus("ボイスを選択してください");
      return;
    }
    setBusy(true);
    setStatus("音声を生成中…");
    stopPlayback();
    try {
      const { buf, format } = await fetchAudio({
        text: t,
        voice_id: selectedVoice.voice_id,
        owner_id: ownerId ?? undefined,
      });
      const b64 = Buffer.from(new Uint8Array(buf)).toString("base64");
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
      const fileName = `${id}.${format}`;
      await FileSystem.writeAsStringAsync(`${AUDIO_DIR}${fileName}`, b64, {
        encoding: FileSystem.EncodingType.Base64,
      });
      const rec: Recent = {
        id,
        text: t,
        voiceId: selectedVoice.voice_id,
        voiceLabel: selectedVoice.label,
        format,
        fileName,
        createdAt: Date.now(),
      };
      const next = [rec, ...recents].slice(0, MAX_RECENTS);
      // あふれた分のファイルは削除
      for (const old of recents.slice(MAX_RECENTS - 1)) {
        FileSystem.deleteAsync(`${AUDIO_DIR}${old.fileName}`, { idempotent: true }).catch(() => {});
      }
      await persistRecents(next);
      setStatus("");
      await playFile(fileName);
    } catch (e: any) {
      setStatus(`失敗: ${e?.message ?? e}`);
    } finally {
      setBusy(false);
    }
  };

  const deleteRecent = async (rec: Recent) => {
    FileSystem.deleteAsync(`${AUDIO_DIR}${rec.fileName}`, { idempotent: true }).catch(() => {});
    await persistRecents(recents.filter((r) => r.id !== rec.id));
  };

  // 共有シート（iOS/Android）でファイルとして取り出す。
  // 「"ファイル"に保存」「AirDrop」「他アプリへ送信」等が選べる。
  const shareRecent = async (rec: Recent) => {
    try {
      if (!(await Sharing.isAvailableAsync())) {
        setStatus("この端末では共有を利用できません");
        return;
      }
      const isMp3 = rec.format === "mp3";
      await Sharing.shareAsync(`${AUDIO_DIR}${rec.fileName}`, {
        mimeType: isMp3 ? "audio/mpeg" : "audio/wav",
        UTI: isMp3 ? "public.mp3" : "com.microsoft.waveform-audio",
        dialogTitle: "音声を共有",
      });
    } catch (e: any) {
      setStatus(`共有に失敗しました: ${e?.message ?? e}`);
    }
  };

  const handleClose = () => {
    stopPlayback();
    onClose();
  };

  if (!mounted) return null;

  // ベンダー(provider)別にグルーピング（キャラ設定のボイス選択画面と同じ並び）。
  // ZakiCorp は最後にまとめる。
  // 並び順はサーバー（sort_order）に従う。各プロバイダーの直後に自分のカスタムボイスを並べる
  const providerOrder = [...new Set(voices.map((v) => v.provider))];
  const voiceSections: { title: string; data: Voice[] }[] = [];
  for (const provider of providerOrder) {
    const pv = voices.filter((v) => v.provider === provider);
    if (pv.length === 0) continue;
    const sys = pv.filter((v) => !v.isCustom);
    const cus = pv.filter((v) => v.isCustom);
    if (sys.length > 0) voiceSections.push({ title: provider, data: sys });
    if (cus.length > 0) voiceSections.push({ title: `${provider} (Custom)`, data: cus });
  }

  return (
    <Modal visible transparent animationType="none" onRequestClose={handleClose}>
      <Animated.View style={[st.container, { transform: [{ translateX: slideAnim }] }]}>
        {/* ヘッダー */}
        <View style={st.header}>
          <TouchableOpacity onPress={handleClose} style={st.backBtn}>
            <Text style={st.backText}>‹ 戻る</Text>
          </TouchableOpacity>
          <Text style={st.title}>🔊 読み上げ</Text>
          <View style={{ width: 56 }} />
        </View>

        <ScrollView style={st.body} keyboardShouldPersistTaps="handled">
          {/* ボイス選択 */}
          <Text style={st.label}>ボイス</Text>
          <TouchableOpacity style={st.voiceSelect} onPress={() => setVoicePickerOpen(true)}>
            <Text style={st.voiceSelectText}>
              {selectedVoice ? `${selectedVoice.label}（${selectedVoice.provider}）` : "選択してください"}
            </Text>
            <Text style={st.chevron}>▾</Text>
          </TouchableOpacity>

          {/* テキスト入力 */}
          <Text style={st.label}>テキスト</Text>
          <TextInput
            value={text}
            onChangeText={setText}
            placeholder="読み上げたいテキストを入力（日本語・英語そのままでOK）"
            style={st.textArea}
            multiline
            textAlignVertical="top"
          />

          <TouchableOpacity
            style={[st.speakBtn, (busy || !text.trim()) && st.speakBtnDisabled]}
            onPress={onSpeak}
            disabled={busy || !text.trim()}
          >
            {busy ? (
              <ActivityIndicator color="#fff" />
            ) : (
              <Text style={st.speakBtnText}>読み上げ</Text>
            )}
          </TouchableOpacity>

          {!!status && <Text style={st.status}>{status}</Text>}

          {/* 直近生成リスト */}
          {recents.length > 0 && (
            <>
              <Text style={[st.label, { marginTop: 24 }]}>直近の生成（端末に保存）</Text>
              {recents.map((r) => (
                <View key={r.id} style={st.recentItem}>
                  <TouchableOpacity style={{ flex: 1 }} onPress={() => playFile(r.fileName)}>
                    <Text style={st.recentText} numberOfLines={2}>
                      {r.text}
                    </Text>
                    <Text style={st.recentMeta}>
                      ▶ {r.voiceLabel} ・ {r.format.toUpperCase()} ・{" "}
                      {new Date(r.createdAt).toLocaleString("ja-JP")}
                    </Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => shareRecent(r)} style={st.shareBtn}>
                    <Text style={st.shareText}>共有</Text>
                  </TouchableOpacity>
                  <TouchableOpacity onPress={() => deleteRecent(r)} style={st.delBtn}>
                    <Text style={st.delText}>削除</Text>
                  </TouchableOpacity>
                </View>
              ))}
            </>
          )}
          <View style={{ height: 40 }} />
        </ScrollView>

        {/* ボイス選択モーダル */}
        <Modal
          visible={voicePickerOpen}
          transparent
          animationType="fade"
          onRequestClose={() => setVoicePickerOpen(false)}
        >
          <Pressable style={st.pickerOverlay} onPress={() => setVoicePickerOpen(false)}>
            <View style={st.pickerBox}>
              <Text style={st.pickerHeader}>ボイスを選択</Text>
              <ScrollView>
                {voiceSections.map((section) => (
                  <View key={section.title}>
                    <Text style={st.pickerSection}>{section.title}</Text>
                    {section.data.map((v) => (
                      <TouchableOpacity
                        key={v.voice_id}
                        style={[
                          st.pickerItem,
                          selectedVoice?.voice_id === v.voice_id && st.pickerItemActive,
                        ]}
                        onPress={() => pickVoice(v)}
                      >
                        <Text style={st.pickerItemText}>{v.label}</Text>
                        {selectedVoice?.voice_id === v.voice_id && (
                          <Text style={st.pickerCheck}>✓</Text>
                        )}
                      </TouchableOpacity>
                    ))}
                  </View>
                ))}
              </ScrollView>
            </View>
          </Pressable>
        </Modal>
      </Animated.View>
    </Modal>
  );
}

const st = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#fff" },
  header: {
    height: Platform.OS === "ios" ? 88 : 56,
    paddingTop: Platform.OS === "ios" ? 36 : 0,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderColor: "#eee",
  },
  backBtn: { width: 56 },
  backText: { fontSize: 16, color: "#007aff" },
  title: { flex: 1, textAlign: "center", fontSize: 17, fontWeight: "700" },
  body: { flex: 1, padding: 16 },
  label: { fontSize: 13, color: "#666", marginBottom: 6, fontWeight: "600" },
  voiceSelect: {
    flexDirection: "row",
    alignItems: "center",
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginBottom: 18,
  },
  voiceSelectText: { flex: 1, fontSize: 16, color: "#111" },
  chevron: { fontSize: 14, color: "#999" },
  textArea: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    padding: 12,
    fontSize: 16,
    minHeight: 140,
    marginBottom: 16,
  },
  speakBtn: {
    backgroundColor: "#007aff",
    borderRadius: 12,
    paddingVertical: 14,
    alignItems: "center",
  },
  speakBtnDisabled: { backgroundColor: "#9bbce0" },
  speakBtnText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  status: { marginTop: 12, color: "#666", fontSize: 13 },
  recentItem: {
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
    paddingVertical: 12,
    gap: 10,
  },
  recentText: { fontSize: 14, color: "#111" },
  recentMeta: { marginTop: 4, fontSize: 11, color: "#999" },
  shareBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  shareText: { color: "#007aff", fontSize: 12, fontWeight: "600" },
  delBtn: { paddingHorizontal: 8, paddingVertical: 4 },
  delText: { color: "#b00", fontSize: 12 },
  pickerOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.3)",
    justifyContent: "center",
    alignItems: "center",
  },
  pickerBox: {
    backgroundColor: "#fff",
    borderRadius: 14,
    width: "82%",
    maxHeight: "70%",
    paddingVertical: 8,
  },
  pickerHeader: {
    fontSize: 12,
    fontWeight: "700",
    color: "#999",
    paddingHorizontal: 16,
    paddingVertical: 8,
    textTransform: "uppercase",
  },
  pickerSection: {
    fontSize: 12,
    fontWeight: "700",
    color: "#999",
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 4,
    backgroundColor: "#f7f7f7",
  },
  pickerItem: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  pickerItemActive: { backgroundColor: "rgba(0,122,255,0.08)" },
  pickerItemText: { flex: 1, fontSize: 16, color: "#111", fontWeight: "600" },
  pickerCheck: { fontSize: 16, color: "#007aff", marginLeft: 8 },
});
