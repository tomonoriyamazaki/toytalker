import { EventSourcePolyfill } from "event-source-polyfill";
import { useEffect, useRef, useState, useCallback } from "react";
import {
  SafeAreaView,
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  KeyboardAvoidingView,
  Keyboard,
  Platform,
  PermissionsAndroid,
  Modal,
  Dimensions,
  Pressable,
  Animated,
} from "react-native";
import * as FileSystem from "expo-file-system";
import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from "expo-av";
import Voice, {
  SpeechResultsEvent,
  SpeechErrorEvent,
  SpeechPartialResultsEvent,
} from "@react-native-voice/voice";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Menu, Provider } from "react-native-paper";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect } from "@react-navigation/native";
import { useOwnerId } from "../../hooks/useOwnerId";
import AudioRecord from "react-native-audio-record";
import Sound from "react-native-sound";
import ReadAloud from "../../components/ReadAloud";

/* === Soniox定数 === */
const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket"; // 公式
let SONIOX_MODEL = "stt-rt-v4";
const SONIOX_SAMPLE_RATE = 16000;
const SONIOX_CHANNELS = 1;

/** Soniox temporary key発行Lambda。POSTしてkey idを受け取りセットする */
const SONIOX_KEY_URL =
  "https://ug5fcnjsxa22vtnrzlwpfgshd40nngbo.lambda-url.ap-northeast-1.on.aws/";


/* === デバッグ === */
const SHOW_STT_DEBUG_UI = DEBUG;
let DEBUG = false;
let DEBUG_TIME = false;

type Turn = { role: "user" | "assistant"; text: string; ts: number };
const DEBUG_HISTORY = false;

/* 既存：あなたのSSEサーバ（LLM→TTS）*/
const STREAM_URL =
  "https://ruc3x2rt3bcnsqxvuyvwdshhh40mzadk.lambda-url.ap-northeast-1.on.aws/";

/* 相槌Lambda */
const BACKCHANNEL_URL =
  "https://5zcqptvuekdtfjnl4fian2crnm0alohv.lambda-url.ap-northeast-1.on.aws/";
const BACKCHANNEL_TRIGGER_CHARS = 7;

/* === ユーティリティ === */
function base64ToArrayBuffer(b64: string): ArrayBuffer {
  const binaryString = (global as any).atob
    ? (global as any).atob(b64)
    : Buffer.from(b64, "base64").toString("binary");
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes.buffer;
}

export default function Chat() {
  const ownerId = useOwnerId();
  // 時間計測
  const [msg, setMsg] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [sessionId, setSessionId] = useState(() => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const sessionIdRef = useRef(sessionId);
  useEffect(() => { sessionIdRef.current = sessionId; }, [sessionId]);
  const readyRef = useRef(false);

  // ドロワー
  type SessionItem = { session_id: string; first_message: string; timestamp: string };
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [readAloudOpen, setReadAloudOpen] = useState(false);
  const drawerAnim = useRef(new Animated.Value(0)).current;
  const [sessions, setSessions] = useState<SessionItem[]>([]);
  const scrollRef = useRef<ScrollView>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);

  // セッション管理とウォッチドッグ
  const sonioxSessionRef = useRef(0);  // 起動ごとに +1
  const sonioxWatchRef = useRef<{ 
    firstAudioTimer?: any; 
    serverQuietTimer?: any; 
  } | null>(null);


  const [debugTime, setDebugTime] = useState(DEBUG_TIME);
  useEffect(() => {
    DEBUG_TIME = debugTime;
    DEBUG = debugTime;
  }, [debugTime]);

  // STTモード
  const [sttMode, setSttMode] = useState<"local" | "soniox">("soniox");
  const [backchannelEnabled, setBackchannelEnabled] = useState(true);
  const backchannelEnabledRef = useRef(true);
  useFocusEffect(
    useCallback(() => {
      (async () => {
        const saved = await AsyncStorage.getItem("sttMode");
        if (saved === "local" || saved === "soniox") setSttMode(saved);
        const bcSaved = await AsyncStorage.getItem("backchannelEnabled");
        const enabled = bcSaved !== "false";
        setBackchannelEnabled(enabled);
        backchannelEnabledRef.current = enabled;
      })();
    }, [])
  );

  // Sonioxキー発行
  const [sonioxKey, setSonioxKey] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      (async () => {
        if (sttMode === "soniox" && !sonioxKey) {
          const key = await fetchSonioxTempKey();
          setSonioxKey(key);
          if (DEBUG) setLog(L => [...L, "Soniox temp key fetched"]);
        }
      })();
    }, [sttMode, sonioxKey])
  );


  // キャラクター選択UI
  const [menuVisible, setMenuVisible] = useState(false);
  const [anchor, setAnchor] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const pillRef = useRef<View>(null);
  const inputRef = useRef<import("react-native").TextInput>(null);
  const { width: SCREEN_W } = Dimensions.get("window");
  const MENU_W = 240;
  const DRAWER_W = Math.round(SCREEN_W * 0.75);

  type CharacterItem = { character_id: string; name: string; owner_id: string; };
  const [characters, setCharacters] = useState<CharacterItem[]>([]);
  const [selectedCharacter, setSelectedCharacter] = useState<CharacterItem>({ character_id: "default", name: "トイトーカー", owner_id: "system" });
  const selectedCharacterRef = useRef<CharacterItem>({ character_id: "default", name: "トイトーカー", owner_id: "system" });

  const DEVICE_SETTING_URL = "https://7k6nkpy3tf2drljy77pnouohjm0buoux.lambda-url.ap-northeast-1.on.aws";

  // 起動時に保存済みキャラクターを復元
  useEffect(() => {
    AsyncStorage.getItem("selectedCharacter").then((val) => {
      if (val) {
        const c = JSON.parse(val);
        setSelectedCharacter(c);
        selectedCharacterRef.current = c;
      }
    });
  }, []);

  const selectCharacter = (c: CharacterItem) => {
    setSelectedCharacter(c);
    selectedCharacterRef.current = c;
    AsyncStorage.setItem("selectedCharacter", JSON.stringify(c));
    setMenuVisible(false);
    Keyboard.dismiss();
  };

  useFocusEffect(
    useCallback(() => {
      if (!ownerId) return;
      (async () => {
        try {
          const res = await fetch(`${DEVICE_SETTING_URL}/characters?owner_id=${encodeURIComponent(ownerId)}`);
          const data = await res.json();
          setCharacters(data.characters ?? []);
        } catch {}
      })();
    }, [ownerId])
  );

  // ドロワー操作
  const openDrawer = () => {
    setDrawerOpen(true);
    drawerAnim.setValue(-DRAWER_W);
    Animated.timing(drawerAnim, { toValue: 0, duration: 260, useNativeDriver: true }).start();
    fetchSessions();
  };

  const closeDrawer = () => {
    Animated.timing(drawerAnim, { toValue: -DRAWER_W, duration: 220, useNativeDriver: true }).start(() => {
      setDrawerOpen(false);
    });
  };

  const fetchSessions = async () => {
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/logs/sessions?owner_id=${encodeURIComponent(ownerId!)}&device_id=app`);
      const data = await res.json();
      setSessions(data.sessions ?? []);
    } catch {}
  };

  const startNewChat = () => {
    closeDrawer();
    setLog([]);
    historyRef.current = [];
    pastBackchannelsRef.current = [];
    const newId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setSessionId(newId);
    sessionIdRef.current = newId;
  };

  const loadSession = async (sid: string) => {
    closeDrawer();
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/logs/messages?owner_id=${encodeURIComponent(ownerId!)}&device_id=app&session_id=${sid}`);
      const data = await res.json();
      const messages: any[] = data.messages ?? [];
      const newLog: string[] = [];
      const newHistory: Turn[] = [];
      let lastCharacterId: string | null = null;
      for (const m of messages) {
        if (m.role === "user") {
          newLog.push(JSON.stringify({ type: "user", text: m.content }));
          newHistory.push({ role: "user", text: m.content, ts: new Date(m.timestamp).getTime() });
        } else if (m.role === "assistant") {
          newLog.push(m.content);
          newHistory.push({ role: "assistant", text: m.content, ts: new Date(m.timestamp).getTime() });
          if (m.character_id) lastCharacterId = m.character_id;
        }
      }
      setLog(newLog);
      historyRef.current = newHistory;
      setSessionId(sid);
      sessionIdRef.current = sid;
      // セッション内で最後に使ったキャラクターに切り替え
      if (lastCharacterId) {
        const found = characters.find(c => c.character_id === lastCharacterId);
        if (found) selectCharacter(found);
      }
    } catch {}
  };

  // 会話履歴
  const historyRef = useRef<Turn[]>([]);
  const curAssistantRef = useRef<string>("");
  const HISTORY_TURNS_TO_SEND = 10;

  // 音声キュー
  const playingRef = useRef(false);
  const queueRef = useRef<Array<{ uri: string }>>([]);
  const loopBeatRef = useRef(0);
  const currentSoundRef = useRef<any>(null); // 再生中のSoundオブジェクト

  // STT共通state
  const [isListening, setIsListening] = useState(false);
  const [partial, setPartial] = useState("");
  const [finalText, setFinalText] = useState("");

  const lastSentRef = useRef<string>("");
  const autoSendTimerRef = useRef<NodeJS.Timeout | null>(null);
  const sendingRef = useRef(false);
  const textSentRef = useRef(false); // テキスト送信時はSTT自動再起動をスキップ
  const sttDetectAtRef = useRef<number | null>(null);
  const lastActivityAtRef = useRef<number>(0);
  const inactivityTimerRef = useRef<NodeJS.Timeout | null>(null);
  const INACT_MS = 900;


  const restoreIOSPlayback = async () => {
    if (Platform.OS !== "ios") return;
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false, // マイク完全に解放して再生専用
        staysActiveInBackground: false,
        playsInSilentModeIOS: true,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        interruptionModeAndroid: InterruptionModeAndroid.DoNotMix,
        shouldDuckAndroid: true,
        playThroughEarpieceAndroid: false,
      });
      if(DEBUG)setLog(L => [...L, "AudioMode restored to Playback"]);
    } catch (e: any) {
      if(DEBUG)setLog(L => [...L, `AudioMode(Playback) err: ${e?.message ?? e}`]);
    }
  };


  const ensureMicPermissionAndroid = async () => {
    if (Platform.OS !== "android") return true;
    try {
      const granted = await PermissionsAndroid.request(
        PermissionsAndroid.PERMISSIONS.RECORD_AUDIO
      );
      return granted === PermissionsAndroid.RESULTS.GRANTED;
    } catch {
      return false;
    }
  };

  // ===== 追加: iOSでも明示的にマイク権限を確認 =====
  const ensureMicPermissionIOS = async () => {
    if (Platform.OS !== "ios") return true;
    try {
      const { status } = await Audio.requestPermissionsAsync();
      return status === "granted";
    } catch {
      return false;
    }
  };
  // =====

  // 計測
  const mtRef = { current: {} as Record<string, number | undefined> };
  const mtSet = (k: string) => {
    if (DEBUG_TIME) mtRef.current[k] = Date.now();
  };
  const sttStartAtRef = { current: 0 };
  const sendStartAtRef = { current: 0 };
  const mtReport = (appendLog: (f: (L: string[]) => string[]) => void) => {
    if (!DEBUG_TIME) return;
    const m = mtRef.current;
    const REQ_TTFB_ms = m.firstEventAt && m.reqAt ? m.firstEventAt - m.reqAt : undefined;
    const TTS_FIRST_ARRIVE_ms =
      m.firstTtsArriveAt && m.reqAt ? m.firstTtsArriveAt - m.reqAt : undefined;
    const LLM_START_srv_ms = m.srv_llmStart && m.srv_t0 ? m.srv_llmStart - m.srv_t0 : undefined;
    const TTS_FIRST_BYTE_srv_ms =
      m.srv_ttsFirstByte && m.srv_t0 ? m.srv_ttsFirstByte - m.srv_t0 : undefined;

    appendLog((L) => [
      ...L,
      `⏱️ TTFB=${REQ_TTFB_ms}ms, FirstTTS(arrive)=${TTS_FIRST_ARRIVE_ms}ms / srv: LLM=${LLM_START_srv_ms}ms, TTS1B=${TTS_FIRST_BYTE_srv_ms}ms`,
    ]);
  };

  /* === Local STT(既存) === */
  useEffect(() => {
    if (sttMode !== "local") return;

    // 再登録前にクリーンアップ
    Voice.removeAllListeners?.();

    Voice.onSpeechStart = () => {
      setIsListening(true);
      setPartial("");
      setFinalText("");
      if (DEBUG_TIME) sttStartAtRef.current = Date.now();
      lastActivityAtRef.current = Date.now();
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
    Voice.onSpeechEnd = () => {
      setIsListening(false);
      if (DEBUG_TIME && sttDetectAtRef.current != null) {
        const dur = Date.now() - sttDetectAtRef.current;
        setLog((L) => [...L, `⏱️ STT(talk)=${dur}ms`]);
        sttDetectAtRef.current = null;
      }
      const textToSend = (finalText || partial).trim();

      // ローカルSTTで、入力テキストの表示を正す
      setPartial(""); 

      if (textToSend) {
        (async () => {
          try {
            await stopSTT();
          } catch {}
          send(textToSend);
        })();
      }
    };
    Voice.onSpeechError = (e: SpeechErrorEvent) => {
      setIsListening(false);
      setLog((L) => [...L, `STT Error: ${e.error?.message ?? "unknown"}`]);
    };
    Voice.onSpeechPartialResults = (e: SpeechPartialResultsEvent) => {
      const text = (e.value?.[0] ?? "").trim();
      if (text) setPartial(text);
      if (sttDetectAtRef.current == null) sttDetectAtRef.current = Date.now();
      lastActivityAtRef.current = Date.now();
    };
    Voice.onSpeechResults = (e: SpeechResultsEvent) => {
      const text = (e.value?.[0] ?? "").trim();
      setFinalText(text);
      setPartial("");
      if (DEBUG_TIME && sttStartAtRef.current) {
        const dur = Date.now() - sttStartAtRef.current;
        setLog((L) => [...L, `⏱️ STT=${dur}ms`]);
        sttStartAtRef.current = 0;
      }
      lastActivityAtRef.current = Date.now();
    };
    return () => {
      Voice.destroy().then(Voice.removeAllListeners);
    };
  }, [sttMode]);

  useEffect(() => {
    const t = finalText.trim();
    if (!t) return;

    if (!isListening) {
      setLog(L => [...L, JSON.stringify({ type: "user", text: t })]);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);

      if (t !== lastSentRef.current && !sendingRef.current) {
        lastSentRef.current = t;
        (async () => {
          try {
            await stopSTT();
          } catch {}
          if (DEBUG) setLog((L) => [...L, `AutoSend: ${t}`]);
          send(t);
        })();
      }
      return;
    }

    if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    inactivityTimerRef.current = setTimeout(() => {
      const quiet = Date.now() - lastActivityAtRef.current >= INACT_MS;
      if (!quiet) return;
      const latest = finalText.trim();
      if (!latest) return;
      if (latest === lastSentRef.current || sendingRef.current) return;

      lastSentRef.current = latest;
      (async () => {
        try {
          await stopSTT();
        } catch {}
        if (DEBUG) setLog((L) => [...L, `AutoSend: ${latest}`]);
        send(latest);
      })();
    }, INACT_MS);

    return () => {
      if (inactivityTimerRef.current) clearTimeout(inactivityTimerRef.current);
    };
  }, [finalText, isListening]);

  /* === Soniox: リアルタイムWS === */
  const sonioxWsRef = useRef<WebSocket | null>(null);
  const sonioxListeningRef = useRef(false);
  const preconnectedWsRef = useRef<WebSocket | null>(null);
  const sonioxFinalBufRef = useRef<string>(""); // final確定の蓄積
  const sonioxNonFinalBufRef = useRef<string>(""); // 非確定の表示用

  // 相槌
  const pastBackchannelsRef = useRef<string[]>([]);
  const backchannelFiredRef = useRef(false);
  const backchannelAudioRef = useRef<{ text: string; audio: string; format: string } | null>(null);
  const sttFinishedRef = useRef(false);

  const configureAudioRecord = () => {
    AudioRecord.init({
      sampleRate: SONIOX_SAMPLE_RATE,
      channels: SONIOX_CHANNELS,
      bitsPerSample: 16,
      audioSource: 6, // VOICE_RECOGNITION(Android); iOSでは無視される
      wavFile: "", // 生PCMでon('data')を受ける
    });
  };

  const fetchSonioxTempKey = async (): Promise<string> => {
    const res = await fetch(SONIOX_KEY_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    const js = await res.json();
    if (!res.ok || !js?.api_key) throw new Error("Failed to get Soniox temp key");
    if (js.stt_model) SONIOX_MODEL = js.stt_model;
    return js.api_key as string;
  };

  // Soniox WS先行接続（再生中に呼ぶ）
  const preconnectSonioxWs = async () => {
    if (preconnectedWsRef.current) return;
    console.log("⏱️ preconnect: creating WebSocket");
    const ws = new WebSocket(SONIOX_WS_URL);
    ws.binaryType = "arraybuffer";
    preconnectedWsRef.current = ws;

    ws.onopen = async () => {
      console.log("⏱️ preconnect: WebSocket OPEN, sending config");
      const cfg = {
        api_key: sonioxKey ?? (await fetchSonioxTempKey()),
        model: SONIOX_MODEL,
        audio_format: "pcm_s16le",
        sample_rate: SONIOX_SAMPLE_RATE,
        num_channels: SONIOX_CHANNELS,
        enable_endpoint_detection: true,
        language_hints: ["ja","en"],
      };
      ws.send(JSON.stringify(cfg));
    };

    ws.onerror = () => {
      console.log("⏱️ preconnect: WebSocket error");
      preconnectedWsRef.current = null;
    };

    ws.onclose = () => {
      if (preconnectedWsRef.current === ws) {
        preconnectedWsRef.current = null;
      }
    };
  };

  const startSonioxSTT = async () => {
    const sttT0 = Date.now();
    if(DEBUG)setLog(L => [...L, "Soniox STT: start()"]);

    // すでに起動中なら無視（多重起動防止）
    if (sonioxListeningRef.current) {
      setLog(L => [...L, "Soniox already listening – skip"]);
      return;
    }

    // 権限チェック
    const okAndroid = await ensureMicPermissionAndroid();
    const okIOS = await ensureMicPermissionIOS();
    console.log(`⏱️ STT [${Date.now() - sttT0}ms] mic permission checked`);
    if (!okAndroid || !okIOS) {
      setLog(L => [...L, "STT: マイク権限がありません"]);
      return;
    }

    // 新しいセッションIDを払い出し
    const mySession = ++sonioxSessionRef.current;
    const guard = () => sonioxSessionRef.current === mySession;

    // 旧WSが残っていたら閉じる
    try { sonioxWsRef.current?.close(); } catch {}

    let bytesSent = 0;
    let gotServerMsg = false;

    // 先行接続済みWSがあれば再利用
    const preWs = preconnectedWsRef.current;
    const usePreconnected = preWs && preWs.readyState === WebSocket.OPEN;
    if (usePreconnected) {
      console.log(`⏱️ STT [${Date.now() - sttT0}ms] using preconnected WebSocket`);
    } else {
      console.log(`⏱️ STT [${Date.now() - sttT0}ms] creating new WebSocket`);
      if (preWs) try { preWs.close(); } catch {}
    }
    preconnectedWsRef.current = null;

    const ws = usePreconnected ? preWs! : new WebSocket(SONIOX_WS_URL);
    ws.binaryType = "arraybuffer";
    sonioxWsRef.current = ws;

    // ウォッチドッグ初期化
    if (!sonioxWatchRef.current) sonioxWatchRef.current = {};
    const clearWatch = () => {
      if (sonioxWatchRef.current?.firstAudioTimer) clearTimeout(sonioxWatchRef.current.firstAudioTimer);
      if (sonioxWatchRef.current?.serverQuietTimer) clearTimeout(sonioxWatchRef.current.serverQuietTimer);
      sonioxWatchRef.current = null;
    };

    // WS未接続中のPCMバッファ
    const audioBuffer: Uint8Array[] = [];
    let wsReady = usePreconnected;

    // 録音開始処理（WS接続前でも呼べる — バッファリングする）
    const beginRecording = async () => {
      console.log(`⏱️ STT [${Date.now() - sttT0}ms] configuring AudioRecord`);
      configureAudioRecord();
      AudioRecord.on("data", (b64: string) => {
        if (!guard()) return;
        if (!sonioxListeningRef.current) return;

        try {
          const ab = base64ToArrayBuffer(b64);
          const chunk = new Uint8Array(ab);
          if (wsReady && ws.readyState === 1) {
            ws.send(chunk);
          } else {
            audioBuffer.push(chunk);
          }
          bytesSent += chunk.byteLength;
        } catch (e: any) {
          setLog(L => [...L, `Soniox send err: ${e?.message ?? String(e)}`]);
        }
      });

      try {
        console.log(`⏱️ STT [${Date.now() - sttT0}ms] AudioRecord.start()`);
        await AudioRecord.start();
        console.log(`⏱️ STT [${Date.now() - sttT0}ms] AudioRecord started OK`);
        sonioxListeningRef.current = true;
        setIsListening(true);
        setPartial(""); setFinalText("");
        sonioxFinalBufRef.current = ""; sonioxNonFinalBufRef.current = "";
        backchannelFiredRef.current = false; backchannelAudioRef.current = null;
        sttFinishedRef.current = false;
        if(DEBUG)setLog(L => [...L, "AudioRecord started"]);
      } catch (e: any) {
        setIsListening(false);
        setLog(L => [...L, `AudioRecord.start failed: ${e?.message ?? e}`]);
        try { ws.close(); } catch {}
        sonioxListeningRef.current = false;
        setIsListening(false);
        return;
      }
    };

    if (usePreconnected) {
      // 先行接続済み: config送信済み、即録音開始
      await beginRecording();
    } else {
      // WS接続と録音を並行開始
      ws.onopen = async () => {
        if (!guard()) return;
        console.log(`⏱️ STT [${Date.now() - sttT0}ms] WebSocket OPEN`);

        const cfg = {
          api_key: sonioxKey ?? (await fetchSonioxTempKey()),
          model: SONIOX_MODEL,
          audio_format: "pcm_s16le",
          sample_rate: SONIOX_SAMPLE_RATE,
          num_channels: SONIOX_CHANNELS,
          enable_endpoint_detection: true,
          language_hints: ["ja","en"],
        };
        ws.send(JSON.stringify(cfg));
        if(DEBUG)setLog(L => [...L, "Soniox WS: OPEN + cfg sent"]);

        // バッファに溜まったPCMを一括送信
        if (audioBuffer.length > 0) {
          console.log(`⏱️ STT [${Date.now() - sttT0}ms] flushing ${audioBuffer.length} buffered chunks`);
          for (const chunk of audioBuffer) {
            ws.send(chunk);
          }
          audioBuffer.length = 0;
        }
        wsReady = true;
      };

      // WS接続待ちの間も録音開始（バッファリングモード）
      await beginRecording();
    }

    ws.onmessage = (ev) => {
      if (!guard()) return;
      gotServerMsg = true;

      try {
        const data = typeof ev.data === "string" ? JSON.parse(ev.data) : null;
        if (!data) return;

        if (data.error_code) {
          // サーバからのエラー（408含む）を正常終了風に処理してセッションを畳む
          setLog(L => [...L, `Soniox Error ${data.error_code}: ${data.error_message ?? ""}`]);
          try { ws.close(); } catch {}
          return;
        }

        const tokens: Array<{ text: string; is_final?: boolean }> = data.tokens || [];
        let nonFinalCurrent = "";
        for (const t of tokens) {
          const txt = t.text ?? "";
          if (!txt) continue;
          if (txt.trim() === "<end>") {
            if (DEBUG) setLog(L => [...L, "Soniox: <end> detected, closing WS"]);
            try { ws.close(); } catch {}
            continue;
          }
          if (t.is_final) {
            sonioxFinalBufRef.current += txt;
          } else {
            nonFinalCurrent += txt;
          }
        }
        sonioxNonFinalBufRef.current = nonFinalCurrent;
        const fullText = sonioxFinalBufRef.current + nonFinalCurrent;
        if (fullText.trim()) {
          setPartial(fullText);

          // 相槌トリガー: 有効 & 5文字以上 & まだ発火していない
          if (backchannelEnabledRef.current && !backchannelFiredRef.current && fullText.trim().length >= BACKCHANNEL_TRIGGER_CHARS) {
            backchannelFiredRef.current = true;
            const charId = selectedCharacterRef.current.character_id;
            const bcPartial = fullText.trim();
            console.log("[BC] fetch firing:", bcPartial, "historyLen=", historyRef.current.length);
            (async () => {
              try {
                const r = await fetch(BACKCHANNEL_URL, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    partial_text: bcPartial,
                    character_id: charId,
                    history: historyRef.current.slice(-6).map(t => ({ role: t.role, content: t.text })),
                    past_backchannels: pastBackchannelsRef.current.slice(-10),
                  }),
                });
                console.log("[BC] status=", r.status);
                const raw = await r.text();
                console.log("[BC] raw len=", raw.length);
                let data = JSON.parse(raw);
                if (typeof data.body === "string") data = JSON.parse(data.body);
                console.log("[BC] text=", data.text, "hasAudio=", !!data.audio, "sttDone=", sttFinishedRef.current);
                if (data.text) pastBackchannelsRef.current.push(data.text);
                if (data.audio) {
                  if (sttFinishedRef.current) {
                    console.log("[BC] playing now");
                    setLog(L => [...L, data.text]);
                    enqueueAudio(data.audio, `bc-${Date.now()}`, data.format || "wav");
                  } else {
                    console.log("[BC] cached for later");
                    backchannelAudioRef.current = { text: data.text, audio: data.audio, format: data.format || "wav" };
                  }
                }
              } catch (e: any) {
                console.log("[BC] ERROR:", e?.message ?? e);
              }
            })();
          }
        }
      } catch (e: any) {
        setLog(L => [...L, `Soniox parse err: ${e?.message ?? e}`]);
      }
    };

    ws.onerror = (_e) => {
      if (!guard()) return;
      setLog(L => [...L, "Soniox WS error"]);
    };

    // ws.closeが実行されたとき or サーバー側から想定外にWebSocket通信を切断された時に自動実行される
    ws.onclose = async (e) => {
      if(DEBUG)setLog(L => [...L, `Soniox WS closed: code=${e.code}`]);

      // 状態リセット
      sonioxListeningRef.current = false;
      setIsListening(false);
      sttFinishedRef.current = true;

      const fullText = (sonioxFinalBufRef.current + sonioxNonFinalBufRef.current).trim();
      if (fullText) {
        setLog(L => [...L, JSON.stringify({ type: "user", text: fullText })]);
        setPartial("");

        // 本Lambdaへの送信を最優先（録音停止を待たない）
        send(fullText);

        // 相槌音声があれば再生（ケース2: fetch完了済み）
        const bc = backchannelAudioRef.current;
        if (bc) {
          console.log("[BC] Playing cached backchannel:", bc.text);
          setLog(L => [...L, bc.text]);
          enqueueAudio(bc.audio, `bc-${Date.now()}`, bc.format);
          backchannelAudioRef.current = null;
        }
        // ケース1（fetchがまだ返ってない）はfetch完了時にsttFinishedRefを見て即再生
      }

      // 録音停止 + 再生モードに切り替え（send後に非同期で実行）
      try { await AudioRecord.stop(); } catch {}
      try { AudioRecord.removeAllListeners?.(); } catch {}
      await restoreIOSPlayback();
    };
  };


  const stopSonioxSTT = () => {
    if(DEBUG)setLog(L => [...L, "Soniox STT: stop()"]);
    try { sonioxWsRef.current?.close(); } catch {}  
  };


  // STT開始/停止トグル
  const startSTT = async () => {
    if(DEBUG)setLog(L => [...L, "=== startSTT CALLED ==="]);
    if(DEBUG)setLog((L) => [...L, `sttMode=${sttMode}`]);

    // 二重起動ガード（無反応の原因になりやすいので明示）
    if (isListening) return;

    // 再生中なら強制停止してキューをリセット
    if (playingRef.current) {
      currentSoundRef.current?.stop();
      currentSoundRef.current?.release();
      currentSoundRef.current = null;
      queueRef.current = [];
      playingRef.current = false;
    }

    // iOS録音カテゴリ
    if (Platform.OS === "ios") {
      try {
        await Audio.setAudioModeAsync({
          allowsRecordingIOS: true,
          playsInSilentModeIOS: true,
          staysActiveInBackground: false,
          interruptionModeIOS: InterruptionModeIOS.DoNotMix,
        });
      } catch (e: any) {
        setLog(L => [...L, `Audio.setAudioModeAsync error: ${String(e)}`]); // ★追加
      }
    }

    if (sttMode === "soniox") {
      // 体感フィードバック
      setIsListening(true);
      try {
        await startSonioxSTT();
      } catch (e) {
        setIsListening(false);
        throw e;
      }
      return;
    }

    if (sttMode === "local") {
      lastSentRef.current = "";
      if (autoSendTimerRef.current) {
        clearTimeout(autoSendTimerRef.current);
        autoSendTimerRef.current = null;
      }
      const okAndroid = await ensureMicPermissionAndroid();
      const okIOS = await ensureMicPermissionIOS();
      if (!okAndroid || !okIOS) {
        setLog((L) => [...L, "STT: マイク権限がありません"]);
        return;
      }
      try {
        const avail = await Voice.isAvailable();
        if (!avail) {
          setLog((L) => [...L, "STT: 音声認識がこの端末/設定で利用できません"]);
          return;
        }
        // 体感フィードバック
        setIsListening(true);
        if (DEBUG) setLog((L) => [...L, "STT: start(ja-JP)"]);
        await Voice.start("ja-JP", { EXTRA_PARTIAL_RESULTS: true } as any);
      } catch (e: any) {
        setIsListening(false);
        setLog((L) => [...L, `STT start failed: ${e?.message ?? e}`]);
      }
    }
  };

  const stopSTT = async () => {
    if (sttMode === "soniox") {
      await stopSonioxSTT();
    } else {
      try {
        await Voice.stop();
      } catch {}
    }
    await restoreIOSPlayback();
  };

  /* === 既存: 音声再生キュー/TTS === */
  const enqueueAudio = async (b64: string, id: string, format: string) => {
    if(DEBUG)setLog(L => [...L, `---start--- enqueueAudio called: id=${id}, format=${format}`]);
    const path = `${FileSystem.cacheDirectory}${id}.${format}`;
    await FileSystem.writeAsStringAsync(path, b64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    queueRef.current.push({ uri: path });
    if (DEBUG) setLog(L => [...L, `before playLoop queue length: ${queueRef.current.length}`]);
    if (DEBUG) setLog(L => [...L, `before playLoop playingRef status: ${playingRef.current}`]);
    if (!playingRef.current) {
      if (DEBUG) setLog(L => [...L, "enqueueAudio triggers playLoop"]);
      playLoop();
    } else {
      if (DEBUG) setLog(L => [...L, "enqueueAudio skipped playLoop (already playing)"]);
    }
  };

  const playLoop = async () => {
    console.log("▶️ playLoop START (react-native-sound)");
    if (playingRef.current) {
      console.log("⏩ already playing, return");
      return;
    }
    playingRef.current = true;
    loopBeatRef.current = Date.now();
    try {
      Sound.setCategory("Playback");
      while (queueRef.current.length) {
        const { uri } = queueRef.current.shift()!;
        const path = uri.replace("file://", "");
        console.log(`🎵 dequeued (Sound): ${path}`);
        await new Promise<void>((resolve) => {
          const s = new Sound(path, "", (error) => {
            if (error) {
              console.log("❌ Sound load error:", error);
              currentSoundRef.current = null;
              resolve();
              return;
            }
            console.log("✅ Sound loaded:", path);
            currentSoundRef.current = s;
            loopBeatRef.current = Date.now();
            // 最後のチャンクならSoniox WSを先行接続
            if (queueRef.current.length === 0 && sttMode === "soniox") {
              preconnectSonioxWs();
            }
            s.play((success) => {
              if (success) console.log("🏁 Finished playing:", path);
              else console.log("⚠️ Playback failed:", path);
              s.release();
              currentSoundRef.current = null;
              loopBeatRef.current = Date.now();
              resolve();
            });
          });
        });
      }
    } catch (e: any) {
      console.log("💥 playLoop(Sound) error:", e?.message ?? e);
    } finally {
      playingRef.current = false;
      loopBeatRef.current = Date.now();
      console.log("🔚 playLoop FINISHED (Sound)");
      if (queueRef.current.length > 0) {
        console.log("🔄 playLoop restarting (Sound)");
        playLoop();
      } else {
        const t0 = Date.now();
        console.log("🎙️ Auto restart STT after playback");

        const doAutoRestart = async () => {
          if (sendingRef.current) {
            console.log("⏸️ sending in progress, skip auto-restart");
            return;
          }
          if (textSentRef.current) {
            console.log("⏸️ text sent, skip auto-restart STT");
            textSentRef.current = false;
            return;
          }

          console.log(`⏱️ [${Date.now() - t0}ms] before startSonioxSTT`);
          if (sttMode === "soniox") {
            await startSonioxSTT();
            console.log(`⏱️ [${Date.now() - t0}ms] startSonioxSTT returned`);
          } else if (sttMode === "local") {
            console.log("🎤 preparing local STT restart");
            try {
              // 🎧 セッション破棄（安全のため）
              await Voice.destroy().catch(() => {});
              await new Promise(res => setTimeout(res, 100)); // 少し待つ

              // 🎙️ リスナーを再登録（重要！）
              Voice.removeAllListeners?.();
              Voice.onSpeechStart = () => {
                setIsListening(true);
                setPartial("");
                setFinalText("");
              };
              Voice.onSpeechEnd = () => {
                setIsListening(false);
                const textToSend = (finalText || partial).trim();
                if (textToSend) send(textToSend);
              };
              Voice.onSpeechResults = (e) => {
                const text = e.value?.[0] ?? "";
                setFinalText(text);
              };
              Voice.onSpeechPartialResults = (e) => {
                const text = e.value?.[0] ?? "";
                setPartial(text);
              };

              // 🎤 再度録音スタート
              await Voice.start("ja-JP", { EXTRA_PARTIAL_RESULTS: true });
              console.log("🎧 Local STT restarted successfully");
            } catch (e) {
              console.log("⚠️ Local STT restart error:", e);
            }
          }
        };

        setTimeout(doAutoRestart, 100); // 再生後1秒待って再開
      }
    }
  };



  // メッセージ送信（既存SSEサーバ）
  const send = async (textArg?: string) => {
    const t = (textArg ?? msg).trim();
    if (!t) return;

    if (DEBUG_HISTORY) setLog((L) => [...L, `🧾 hist +user "${t.slice(0, 40)}"`]);
    if (sendingRef.current) {
      if (DEBUG) setLog((L) => [...L, "skip: sending in flight"]);
      return;
    }
    sendingRef.current = true;

    if (DEBUG) setLog((L) => [...L, `→ POST ${t}`]);
    if (DEBUG_TIME) sendStartAtRef.current = Date.now();
    setMsg("");
    if (textArg === undefined) {
      setLog((L) => [...L, JSON.stringify({ type: "user", text: t })]);
      setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
      textSentRef.current = true;
      if (isListening) stopSTT();
    }

    // 会話POSTは一過性のネットワーク障害(接続確立失敗)で落ちることがあるため、
    // 何も受信していなければ新規XHRで最大 MAX_RETRIES 回まで再送する(合計 MAX_RETRIES+1 試行)。
    const MAX_RETRIES = 2;
    const RETRY_BACKOFF_MS = [500, 1500];
    const attempt = (attemptNo: number) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", STREAM_URL, true);
      xhr.setRequestHeader("Content-Type", "application/json");
      xhr.timeout = 30000;

      let lastIndex = 0;
      let buffer = "";
      let accText = "";
      const printedIds = new Set<string>();
      let lastEventType: string | null = null;
      let currentEvent: string | null = null;
      let currentData: string[] = [];
      let firstEventSeen = false;

      const flush = () => {
        if (currentData.length === 0 && !currentEvent) return;
        const ev = currentEvent ?? lastEventType ?? "message";
        const dataStr = currentData.join("\n");
        if (DEBUG_TIME && !firstEventSeen) {
          firstEventSeen = true;
          mtSet("firstEventAt");
        }

        try {
          if (ev === "ping") {
            if (DEBUG_TIME) {
              const obj = JSON.parse(dataStr);
              (mtRef.current as any).srv_t0 = obj?.t;
            }
          } else if (ev === "mark") {
            if (DEBUG_TIME) {
              const obj = JSON.parse(dataStr);
              if (obj?.k === "llm_start") (mtRef.current as any).srv_llmStart = obj.t;
              if (obj?.k === "tts_first_byte") (mtRef.current as any).srv_ttsFirstByte = obj.t;
            }
          } else if (ev === "tts") {
            if (DEBUG_TIME && !(mtRef.current as any).firstTtsArriveAt) mtSet("firstTtsArriveAt");
            const obj = JSON.parse(dataStr);
            const { id, b64, format } = obj || {};
            if (id != null && b64 && format) {
              const key = `tts:${String(id)}`;
              if (!printedIds.has(key)) {
                printedIds.add(key);
                enqueueAudio(b64, String(id), String(format));
              }
            }
          } else if (ev === "segment") {
            const obj = JSON.parse(dataStr);
            console.log("🛰 segment event:", obj); 
            const text: string = obj?.text ?? "";
            const final: boolean = !!obj?.final;
            const segId = obj?.id != null ? String(obj.id) : null;
            const segKey = segId ? `seg:${segId}` : null;

            if (!segKey || !printedIds.has(segKey)) {
              if (segKey) printedIds.add(segKey);
              if (text) {
                setLog((L) => [...L, text]);
                curAssistantRef.current += text;
              }
            }
            if (final) {
              console.log("🧾 final segment received");
            }
          } else if (ev === "error") {
            setLog((L) => [...L, `Error: ${dataStr}`]);
          } else if (ev === "done") {
            if (DEBUG_TIME) mtReport(setLog);
          }
        } catch (e: any) {
          setLog((L) => [...L, `ParseErr(${ev}): ${e?.message ?? e}`]);
        }

        lastEventType = ev;
        currentEvent = null;
        currentData = [];
      };

      const processChunk = (chunk: string) => {
        buffer += chunk;
        let idx: number;
        while ((idx = buffer.indexOf("\n\n")) !== -1) {
          const record = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);

          const lines = record.split("\n");
          for (const line of lines) {
            if (line.startsWith("event:")) {
              if (currentEvent || currentData.length) flush();
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              currentData.push(line.slice(5).trimStart());
            } else {
              // コメント無視
            }
          }
          flush();
        }
      };

      xhr.onprogress = () => {
        const text = xhr.responseText || "";
        const chunk = text.slice(lastIndex);
        lastIndex = text.length;
        if (chunk) processChunk(chunk);
      };
      xhr.onerror = () => {
        // 何も受信していない＝接続確立/送信段階の失敗。一過性なら新規XHRで再送する。
        // 受信開始後の失敗は再送しない(既に再生した音声・表示した文が二重になるため)。
        const receivedNothing = lastIndex === 0;
        if (receivedNothing && attemptNo <= MAX_RETRIES) {
          const wait = RETRY_BACKOFF_MS[attemptNo - 1] ?? 1500;
          setLog((L) => [...L, `XHR error → retry ${attemptNo}/${MAX_RETRIES} in ${wait}ms`]);
          setTimeout(() => {
            try {
              attempt(attemptNo + 1);
            } catch (e: any) {
              setLog((L) => [...L, `Error: ${e?.message ?? e}`]);
              sendingRef.current = false;
            }
          }, wait);
          return;
        }
        setLog((L) => [
          ...L,
          receivedNothing ? `XHR error (gave up after ${attemptNo} attempts)` : `XHR error (mid-stream)`,
        ]);
        sendingRef.current = false;
      };
      xhr.ontimeout = () => {
        // 30s待った後なので再送しない
        setLog((L) => [...L, `XHR timeout`]);
        sendingRef.current = false;
      };

      xhr.onload = () => {
        const text = xhr.responseText || "";
        const tail = text.slice(lastIndex);
        if (tail) processChunk(tail);
        const out = accText.trim();
        if (DEBUG) setLog((L) => [...L, "=== stream done ==="]);

        historyRef.current.push({ role: "user", text: t, ts: Date.now() });
        const whole = curAssistantRef.current.trim();
        if (whole) {
          historyRef.current.push({ role: "assistant", text: whole, ts: Date.now() });
        }
        curAssistantRef.current = "";
        console.log("🧾 xhr.onload history push: historyLen=", historyRef.current.length);

        sendingRef.current = false;
      };

      if (DEBUG_TIME) {
        (mtRef.current as any) = {};
        mtSet("reqAt");
      }

      const recentTurns = historyRef.current.slice(-HISTORY_TURNS_TO_SEND);
      const historyMessages = [
        ...recentTurns.map((t) => ({ role: t.role, content: t.text })),
        { role: "user", content: t },
      ];

      const payload = {
        character_id: selectedCharacterRef.current.character_id,
        messages: historyMessages,
        session_id: sessionIdRef.current,
        owner_id: ownerId,
        device_id: "app",
        request_at: new Date().toISOString(),
        backchannel_fired: backchannelFiredRef.current,
      };
      console.log("🚀 payload to Lambda:", JSON.stringify(payload, null, 2), attemptNo > 1 ? `(attempt ${attemptNo})` : "");
      xhr.send(JSON.stringify(payload));
    };

    try {
      attempt(1);
    } catch (e: any) {
      setLog((L) => [...L, `Error: ${e?.message ?? e}`]);
      sendingRef.current = false;
    }
  };

  return (
    <SafeAreaView style={s.root}>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={0}
      >
      {/* ヘッダー */}
      <View style={s.header}>
        <TouchableOpacity style={s.hamburgerBtn} onPress={openDrawer}>
          <Text style={s.hamburgerText}>☰</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }} />
        <TouchableOpacity
          ref={pillRef}
          style={s.modelPill}
          activeOpacity={0.7}
          onPress={() => {
            inputRef.current?.blur();
            pillRef.current?.measureInWindow((x, y, w, h) => {
              setAnchor({ x, y, w, h });
              setMenuVisible(true);
            });
          }}
        >
          <Text style={s.modelPillText}>{selectedCharacter.name}</Text>
        </TouchableOpacity>
      </View>

      {/* キャラクター選択 */}
      <Modal
        visible={menuVisible}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuVisible(false)}
      >
        <View style={s.overlay}>
          <Pressable style={StyleSheet.absoluteFill} onPress={() => setMenuVisible(false)} />
          {anchor && (
            <View
              style={[
                s.dropdown,
                {
                  top: anchor.y + anchor.h + 8,
                  left: Math.min(anchor.x, SCREEN_W - MENU_W - 12),
                  width: MENU_W,
                },
              ]}
            >
              <Text style={s.dropdownHeader}>キャラクター</Text>
              {(["system", "custom"] as const).map((group) => {
                const filtered = characters
                  .filter((c) => group === "system" ? c.owner_id === "system" : c.owner_id !== "system");
                if (filtered.length === 0) return null;
                return (
                  <View key={group}>
                    <Text style={s.dropdownSection}>{group === "system" ? "システム" : "カスタム"}</Text>
                    {filtered.map((c) => (
                      <TouchableOpacity
                        key={c.character_id}
                        style={[s.dropdownItem, selectedCharacter.character_id === c.character_id && s.dropdownItemActive]}
                        onPress={() => selectCharacter(c)}
                      >
                        <View style={s.dropdownRow}>
                          <Text style={s.dropdownTitle}>{c.name}</Text>
                          {selectedCharacter.character_id === c.character_id && <Text style={s.dropdownCheck}>✓</Text>}
                        </View>
                      </TouchableOpacity>
                    ))}
                  </View>
                );
              })}
            </View>
          )}
        </View>
      </Modal>

      <ScrollView
        ref={scrollRef}
        style={s.chat}
        onScroll={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          const distanceFromBottom = contentSize.height - contentOffset.y - layoutMeasurement.height;
          setShowScrollButton(distanceFromBottom > 100);
        }}
        scrollEventThrottle={16}
      >
        {log.map((l, i) => {
          let content = l;
          let isUser = false;
          try {
            const obj = JSON.parse(l);
            if (obj.type === "user") {
              content = obj.text;
              isUser = true;
            }
          } catch {}
          if (isUser) {
              return (
                <View key={i} style={s.userBubble}>
                  <TextInput editable={false} multiline scrollEnabled={false} value={content} style={[s.userBubbleText, { padding: 0 }]} />
                </View>
              );
            } else {
              return (
                <TextInput key={i} editable={false} multiline scrollEnabled={false} value={content} style={s.line} />
              );
            }
          })}
        
      {/* ★ partialを仮バブルで右側にリアルタイム表示 */}
      {partial && !sendingRef.current ? (
        <View style={s.userBubble}>
          <Text style={s.userBubbleText}>{partial}</Text>
        </View>
      ) : null}


        {SHOW_STT_DEBUG_UI && (
          <View style={{ marginTop: 12 }}>
            <Text style={s.section}>🎙️ STT</Text>
            <Text style={s.small}>{isListening ? "Listening: true" : "Listening: false"}</Text>
            <Text style={s.label}>Partial</Text>
            <Text style={s.box}>{partial || "…"}</Text>
            <Text style={s.label}>Final</Text>
            <Text style={s.boxStrong}>{finalText || "…"}</Text>
          </View>
        )}
      </ScrollView>

      <View style={{ height: 0 }}>
        {showScrollButton && (
          <TouchableOpacity
            style={s.scrollToBottomBtn}
            onPress={() => scrollRef.current?.scrollToEnd({ animated: true })}
          >
            <Text style={s.scrollToBottomText}>↓</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={s.inputRow}>
        <TouchableOpacity
          style={[s.micBtn, { backgroundColor: isListening ? "#b00020" : "#0a7" }]}
          onPress={isListening ? stopSTT : startSTT}
        >
          <Text style={s.btnText}>{isListening ? "停止" : "🎤開始"}</Text>
        </TouchableOpacity>

        <TextInput
          ref={inputRef}
          value={msg}
          onChangeText={setMsg}
          placeholder="メッセージを入力…"
          style={s.input}
        />
        <TouchableOpacity style={s.btn} onPress={() => send()}>
          <Text style={s.btnText}>送信</Text>
        </TouchableOpacity>
      </View>
      {/* サイドドロワー */}
      {drawerOpen && (
        <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
          <Pressable style={s.drawerOverlay} onPress={closeDrawer} />
          <Animated.View style={[s.drawer, { width: DRAWER_W, transform: [{ translateX: drawerAnim }] }]}>
            {/* 読み上げモード（会話とは独立） */}
            <TouchableOpacity
              style={s.drawerReadAloud}
              onPress={() => { closeDrawer(); setReadAloudOpen(true); }}
            >
              <Text style={s.drawerReadAloudText}>🔊 読み上げ</Text>
            </TouchableOpacity>
            <View style={s.drawerDivider} />
            {/* New Chat */}
            <TouchableOpacity style={s.drawerNewChat} onPress={startNewChat}>
              <Text style={s.drawerNewChatText}>＋ New Chat</Text>
            </TouchableOpacity>
            <View style={s.drawerDivider} />
            {/* 履歴リスト */}
            <ScrollView style={{ flex: 1 }}>
              {sessions.length === 0 ? (
                <Text style={s.drawerEmpty}>履歴がありません</Text>
              ) : (
                sessions.map((s2) => (
                  <TouchableOpacity key={s2.session_id} style={s.drawerItem} onPress={() => loadSession(s2.session_id)}>
                    <Text style={s.drawerItemText} numberOfLines={2}>
                      {s2.first_message || "（空のセッション）"}
                    </Text>
                    <Text style={s.drawerItemDate}>
                      {new Date(s2.timestamp).toLocaleDateString("ja-JP")}
                    </Text>
                  </TouchableOpacity>
                ))
              )}
            </ScrollView>
          </Animated.View>
        </View>
      )}

      <ReadAloud
        visible={readAloudOpen}
        onClose={() => setReadAloudOpen(false)}
        ownerId={ownerId}
      />
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: "#fff" },
  chat: { flex: 1, padding: 16 },
  line: { fontSize: 16, marginBottom: 4 },
  section: { fontSize: 16, fontWeight: "600", marginBottom: 6 },
  small: { color: "#666", marginBottom: 6 },
  label: { fontSize: 12, color: "#666", marginTop: 8 },
  box: {
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 10,
    padding: 10,
    minHeight: 40,
    fontSize: 16,
  },
  boxStrong: {
    borderWidth: 1,
    borderColor: "#4f46e5",
    borderRadius: 10,
    padding: 10,
    minHeight: 40,
    fontSize: 16,
  },
  scrollToBottomBtn: {
    position: "absolute",
    bottom: 12,
    alignSelf: "center",
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: "rgba(0,0,0,0.4)",
    alignItems: "center",
    justifyContent: "center",
  },
  scrollToBottomText: {
    color: "#fff",
    fontSize: 18,
    fontWeight: "700",
  },
  inputRow: {
    flexDirection: "row",
    gap: 8,
    padding: 12,
    borderTopWidth: 1,
    borderColor: "#eee",
  },
  input: {
    flex: 1,
    borderWidth: 1,
    borderColor: "#ddd",
    borderRadius: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 16,
  },
  btn: {
    backgroundColor: "#111",
    paddingHorizontal: 16,
    borderRadius: 12,
    justifyContent: "center",
  },
  btnText: { color: "#fff", fontWeight: "600" },
  micBtn: {
    paddingHorizontal: 14,
    borderRadius: 12,
    justifyContent: "center",
  },
  userLine: {
    textAlign: "right",
    color: "#007aff",
    fontWeight: "500",
  },
  userBubble: {
    alignSelf: "flex-end",
    backgroundColor: "#007aff",
    borderRadius: 16,
    paddingHorizontal: 12,
    paddingVertical: 8,
    marginBottom: 6,
    maxWidth: "80%",
  },
  userBubbleText: {
    color: "#fff",
    fontSize: 16,
  },
  header: {
    height: 36,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 12,
    borderBottomWidth: 1,
    borderColor: "#eee",
    backgroundColor: "#fff",
  },
  modelPill: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 12,
    backgroundColor: "rgba(0,0,0,0.06)",
  },
  modelPillText: {
    fontSize: 14,
    fontWeight: "600",
    color: "#333",
  },
  headerTitle: {
    flex: 1,
    textAlign: "center",
    fontSize: 16,
    fontWeight: "700",
  },
  modalOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.3)",
    justifyContent: "center",
    alignItems: "center",
  },
  modalBox: {
    backgroundColor: "#fff",
    borderRadius: 12,
    padding: 16,
    width: "70%",
  },
  modalItem: {
    paddingVertical: 12,
  },
  modalItemText: {
    fontSize: 16,
    textAlign: "center",
  },
  modalCancel: {
    marginTop: 12,
    fontSize: 14,
    textAlign: "center",
    color: "#b00",
  },
  overlay: {
    flex: 1,
    backgroundColor: "transparent",
  },
  dropdown: {
    position: "absolute",
    backgroundColor: "#fff",
    borderRadius: 12,
    paddingVertical: 6,
    width: 280,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
  dropdownItem: {
    paddingVertical: 10,
    paddingHorizontal: 12,
  },
  dropdownText: {
    fontSize: 16,
  },
  dropdownRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  dropdownHeader: {
    fontSize: 11,
    fontWeight: "700",
    color: "#999",
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 4,
    textTransform: "uppercase",
  },
  dropdownSection: {
    fontSize: 11,
    fontWeight: "700",
    color: "#999",
    paddingHorizontal: 12,
    paddingTop: 8,
    paddingBottom: 2,
    textTransform: "uppercase",
    borderTopWidth: 1,
    borderTopColor: "#e0e0e0",
    marginTop: 4,
  },
  dropdownTitle: {
    fontSize: 16,
    fontWeight: "600",
    color: "#111",
  },
  dropdownSub: {
    marginTop: 2,
    fontSize: 12,
    color: "#6b7280",
  },
  dropdownCheck: {
    fontSize: 16,
    color: "#4f46e5",
    marginLeft: 8,
  },
  dropdownItemActive: {
    backgroundColor: "rgba(79,70,229,0.06)",
    borderRadius: 8,
  },
  dropdownDivider: {
    height: 1,
    backgroundColor: "#eee",
    marginVertical: 6,
  },
  hamburgerBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    justifyContent: "center",
  },
  hamburgerText: {
    fontSize: 20,
    color: "#333",
  },
  drawerOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: "rgba(0,0,0,0.3)",
  },
  drawer: {
    position: "absolute",
    top: 0,
    left: 0,
    bottom: 0,
    backgroundColor: "#fff",
    shadowColor: "#000",
    shadowOpacity: 0.15,
    shadowRadius: 16,
    shadowOffset: { width: 4, height: 0 },
    elevation: 8,
  },
  drawerReadAloud: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
  },
  drawerReadAloudText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#111",
  },
  drawerNewChat: {
    paddingVertical: 16,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
  },
  drawerNewChatText: {
    fontSize: 16,
    fontWeight: "700",
    color: "#007aff",
  },
  drawerDivider: {
    height: 1,
    backgroundColor: "#eee",
  },
  drawerItem: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#f0f0f0",
  },
  drawerItemText: {
    fontSize: 14,
    color: "#111",
  },
  drawerItemDate: {
    marginTop: 4,
    fontSize: 11,
    color: "#999",
  },
  drawerEmpty: {
    padding: 20,
    color: "#999",
    fontSize: 14,
  },
});
