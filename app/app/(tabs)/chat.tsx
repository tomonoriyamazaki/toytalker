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
  AppState,
} from "react-native";
import * as FileSystem from "expo-file-system";
import { Audio, InterruptionModeIOS, InterruptionModeAndroid } from "expo-av";
import Voice, {
  SpeechResultsEvent,
  SpeechErrorEvent,
  SpeechPartialResultsEvent,
} from "@react-native-voice/voice";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useFocusEffect } from "@react-navigation/native";
import { useOwnerId } from "../../hooks/useOwnerId";
import { APP_VERSION } from "../../lib/appVersion";
import { API_BASE_URL, apiFetch, requestHeaders } from "../../lib/api";
import { DEFAULT_STT_CHOICE, loadSttChoice, rememberSttOptions, sonioxModelConfig, sttChoiceKey, sttGraceMs, type SttChoice } from "../../lib/sttModel";
import AudioRecord from "react-native-audio-record";
import Sound from "react-native-sound";
import { acquireMic, releaseMic, micOwner } from "../../lib/micOwner";
import ReadAloud from "../../components/ReadAloud";

/* === Soniox定数 === */
const SONIOX_WS_URL = "wss://stt-rt.soniox.com/transcribe-websocket"; // 公式
let SONIOX_MODEL = "stt-rt-v4"; // Lambda が配る値（stt_model）。設定画面の選択で上書きされ得る
/** 設定画面「音声認識」のモデルと話し終わりの待ち（app/lib/sttModel.ts）。チャット画面を開くたびに読み直す */
let sttChoice: SttChoice = DEFAULT_STT_CHOICE;
const SONIOX_SAMPLE_RATE = 16000;
const SONIOX_CHANNELS = 1;

/** Soniox temporary key発行Lambda（固定ドメイン経由。app/lib/api.ts）。GETでkeyを受け取りセットする */
/**
 * 一時キーはLambdaに頼む寿命（SONIOX_KEY_TTL_SEC）で発行される。期限切れのキーで接続すると会話が
 * 始まらないので、取得から SONIOX_KEY_MAX_AGE_MINUTES を越えたらWSを開く前に取り直す。
 * 寿命との差（1分）は判定から接続までのズレ用。
 */
const SONIOX_KEY_TTL_SEC = 180; // Lambdaに頼む寿命。指定しない古いアプリは1時間
const SONIOX_KEY_MAX_AGE_MINUTES = 2; // 2026-10-28から試用。問題なければこれが本番値
let sonioxKeyCache: { key: string; fetchedAt: number } | null = null;
let sonioxKeyInflight: Promise<string> | null = null;

const fetchSonioxTempKey = async (): Promise<string> => {
  // app_version は Lambda の切り分けログ用（本文・相槌と同じ）
  // 本文の無い要求なので GET（ESP32 と同じ。CloudFront 経由では本文の無い POST に署名用のハッシュが要るので避ける）
  const res = await apiFetch(`/stt-token?ttl=${SONIOX_KEY_TTL_SEC}&app_version=${encodeURIComponent(APP_VERSION)}`);
  const js = await res.json();
  if (!res.ok || !js?.api_key) throw new Error("Failed to get Soniox temp key");
  if (js.stt_model) SONIOX_MODEL = js.stt_model;
  rememberSttOptions(js.stt_options); // 設定画面の選択肢と待ちの中身（app/lib/sttModel.ts）
  return js.api_key as string;
};

/** 有効なキーを返す。古いか無ければ取り直す。同時に呼ばれても取得は1回にまとめる */
const getSonioxKey = async (): Promise<string> => {
  const c = sonioxKeyCache;
  if (c && Date.now() - c.fetchedAt < SONIOX_KEY_MAX_AGE_MINUTES * 60 * 1000) return c.key;
  if (sonioxKeyInflight) return sonioxKeyInflight;
  const ageSec = c ? Math.round((Date.now() - c.fetchedAt) / 1000) : -1;
  console.log(`[SONIOX_KEY] fetching (age=${ageSec}s)`);
  sonioxKeyInflight = fetchSonioxTempKey()
    .then((key) => {
      sonioxKeyCache = { key, fetchedAt: Date.now() };
      console.log("[SONIOX_KEY] refreshed");
      return key;
    })
    .finally(() => { sonioxKeyInflight = null; });
  return sonioxKeyInflight;
};


/* === デバッグ === */
const SHOW_STT_DEBUG_UI = DEBUG;
let DEBUG = false;
let DEBUG_TIME = false;

type Turn = { role: "user" | "assistant"; text: string; ts: number };
const DEBUG_HISTORY = false;

/* 会話Lambda（LLM→TTS、SSE）。固定ドメイン経由 */
const STREAM_URL = `${API_BASE_URL}/chat-app`;

/* 相槌Lambda（固定ドメイン経由の経路） */
const BACKCHANNEL_PATH = "/backchannel-app";
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

// 文字の出し方（2026-11-03 試し）。
//   "voice":  文ごとに、その文の音声が鳴り始めてから、声の長さの REVEAL_SPEED 倍の時間で1字ずつ出す（文の間で止まる。声ごとに速さが違う）
//   "steady": 返答の最初の音声が鳴ったら、以後の文は音声を待たず REVEAL_CHARS_PER_SEC の一定の速さで続けて出す（文字が声より先に進む）
// 相槌はどちらでも音声が鳴り始めたときに出す。戻すときは "voice" にするだけ
const REVEAL_MODE: "voice" | "steady" = "steady";
// 再生の見張り（playLoop）。読み込みがこの時間で戻らない、または再生が「長さ＋余裕」で終わらないときは、文字だけ出して次へ進む。
// 2026-11-07 15:01 の無反応（サーバーは送り終えていたが、アプリは相槌も返答も鳴らさず、文字も出ず、マイクも再開しなかった）の痛み止め。
const PLAYBACK_LOAD_TIMEOUT_MS = 5000;
const PLAYBACK_GRACE_MS = 3000;
const PLAYBACK_UNKNOWN_DURATION_MS = 15000; // 長さが取れなかったときの上限
const REVEAL_SPEED = 0.4;
const REVEAL_CHARS_PER_SEC = 20;
// 返答・相槌の1行。時刻 at から span ミリ秒かけて1字ずつ出す。
// 各字は REVEAL_FADE_MS かけて薄い色から濃くする（パッと出さずになめらかに）。
// 時間が過ぎてから描かれたとき（画面の作り直しなど）は最初から全文を出す
const REVEAL_FADE_MS = 250;
function RevealText({ text, at, span, style }: { text: string; at: number; span: number; style: any }) {
  const chars = Array.from(text);
  const doneAt = at + span + REVEAL_FADE_MS;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (span <= 0 || Date.now() >= doneAt) return;
    let raf = 0;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      if (t < doneAt) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [text, at, span]);
  if (span <= 0 || now >= doneAt) return <Text selectable style={style}>{text}</Text>;

  // 濃さが1になった字はまとめ、現れ途中の字だけ1字ずつ色の濃さを変える
  const step = span / chars.length;
  let solid = "";
  const fading: { c: string; a: number }[] = [];
  for (let i = 0; i < chars.length; i++) {
    const a = Math.min(1, Math.max(0, (now - at - i * step) / REVEAL_FADE_MS));
    if (a <= 0) break;
    if (a >= 1 && fading.length === 0) solid += chars[i];
    else fading.push({ c: chars[i], a });
  }
  return (
    <Text selectable style={style}>
      {solid}
      {fading.map((f, i) => (
        <Text key={i} style={{ color: `rgba(0,0,0,${f.a})` }}>{f.c}</Text>
      ))}
    </Text>
  );
}

// 描画で例外が出てもアプリを終了させず、この画面だけ「表示できませんでした」にする（components/ScreenError.tsx）
export { ErrorBoundary } from "../../components/ScreenError";

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
  // 一番下に付いていくか。返答の文字が出て行が増えるたびに下へ送る。指で上へスクロールしたら外れ、下まで戻すか ↓ を押すか話すと戻る
  const stickToBottomRef = useRef(true);
  const draggingRef = useRef(false);
  const STICK_PX = 40;
  // 付いていくかを変える。↓ ボタンは付いていないときだけ出す（描き直しは切り替わったときだけ）
  const setStick = (v: boolean) => {
    if (stickToBottomRef.current === v) return;
    stickToBottomRef.current = v;
    setShowScrollButton(!v);
  };

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
        sttChoice = await loadSttChoice();
        const bcSaved = await AsyncStorage.getItem("backchannelEnabled");
        const enabled = bcSaved !== "false";
        setBackchannelEnabled(enabled);
        backchannelEnabledRef.current = enabled;
      })();
    }, [])
  );

  // Sonioxキー発行: 画面表示時と、別アプリから戻った時に古ければ取り直す（会話ボタンの待ちを隠す）。
  // WSを開く直前にも getSonioxKey で判定するので、ここが走らなくても期限切れのキーは使わない。
  useFocusEffect(
    useCallback(() => {
      if (sttMode !== "soniox") return;
      const warm = (why: string) =>
        getSonioxKey().catch((e) => console.log(`[SONIOX_KEY] ${why} failed: ${e?.message ?? e}`));
      warm("focus");
      const sub = AppState.addEventListener("change", (state) => {
        if (state === "active") warm("foreground");
      });
      return () => sub.remove();
    }, [sttMode])
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
          const res = await apiFetch(`/characters?owner_id=${encodeURIComponent(ownerId)}`);
          const data = await res.json();
          const list: CharacterItem[] = data.characters ?? [];
          setCharacters(list);
          // 選択中のキャラクターが一覧に無い（ログインで owner_id が変わった、消された等）なら既定に戻す。
          // 他人のキャラクターを使い続けさせない（本文Lambdaは 403 で拒むが、名前と声が画面に残るのを防ぐ。docs/auth.md）
          const cur = selectedCharacterRef.current;
          if (cur.character_id !== "default" && !list.some((c) => c.character_id === cur.character_id)) {
            const def: CharacterItem = { character_id: "default", name: "トイトーカー", owner_id: "system" };
            setSelectedCharacter(def);
            selectedCharacterRef.current = def;
            AsyncStorage.removeItem("selectedCharacter");
          }
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
      const res = await apiFetch(`/logs/sessions?owner_id=${encodeURIComponent(ownerId!)}&device_id=app`);
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
      const res = await apiFetch(`/logs/messages?owner_id=${encodeURIComponent(ownerId!)}&device_id=app&session_id=${sid}`);
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
  // 文字は音声が鳴り始めたときに出す（画面の順番を鳴った順番に揃える）。uri の無い項目は文字だけ（音声が作れなかった文）
  // 前のターンの結果（文章は含めない）。次の本文要求に prev_turn として添え、Lambda のトレースに同名で載る。
  // サーバーは「送り終えた」までしか分からないので、アプリが受け取って鳴らしたかをここで残す（2026-11-08。ESP32 も同じ項目を送れる）。
  type TurnStats = {
    request_at: string;      // そのターンの request_at（サーバーの turn ログと結びつける）
    attempts: number;        // XHR の試行回数（再送を含む）
    segments: number;        // 受けた文（segment イベント）
    tts: number;             // 受けた音声（tts イベント）
    done: boolean;           // done イベントを受けた
    loaded: boolean;         // xhr.onload（受信完了）
    error: string | null;    // network / timeout / http:<status> / parse
    played: number;          // 鳴らし終えた音声
    play_failed: number;     // 読み込み失敗・再生失敗
    stalls: number;          // 再生の見張りが動いた回数（コールバックが戻らず飛ばした）
    bc_received: boolean;    // 相槌の音声を受けた
    bc_played: boolean;      // 相槌を鳴らし終えた
    bc_error: boolean;       // 相槌の取得に失敗
  };
  const turnStatsRef = useRef<TurnStats | null>(null); // いまのターン（鳴らし終わるまで更新する）
  const bcStatsRef = useRef({ bc_received: false, bc_error: false }); // 相槌は send より前に返ることがあるので、ここに溜めて send で写す
  const noteBc = (k: "bc_received" | "bc_error") => {
    if (sttFinishedRef.current && turnStatsRef.current) turnStatsRef.current[k] = true;
    else bcStatsRef.current[k] = true;
  };
  type Queued = { uri?: string; text?: string; notice?: string; kind?: "bc"; session: string; stats?: TurnStats };
  const queueRef = useRef<Queued[]>([]);
  // steady 用。返答の最初の音声が鳴ったか / 一定速で出している文字が出し終わる時刻 / 音声待ちの文（send ごとに作り直す）
  const replyAudioStartedRef = useRef(false);
  const steadyCursorRef = useRef(0);
  const pendingTextsRef = useRef<Map<string, string>>(new Map());
  const loopBeatRef = useRef(0);
  const currentSoundRef = useRef<any>(null); // 再生中のSoundオブジェクト

  // STT共通state
  const [isListening, setIsListening] = useState(false);
  const [partial, setPartial] = useState("");
  const [finalText, setFinalText] = useState("");

  const lastSentRef = useRef<string>("");
  const autoSendTimerRef = useRef<NodeJS.Timeout | null>(null);
  const sendingRef = useRef(false);
  const micStopRef = useRef<Promise<void> | null>(null); // 録音停止（AudioRecord.stop）の完了。再生はこれを待ってからカテゴリを切り替える
  // 録音器が動いているか。会話中はターンの区切りでも止めない（YouTube と同じく音声を止めずに続ける。ロードマップ26）。
  // iOS は背面のアプリが音声を止めた後に鳴らし始めることを拒むので、録音↔再生の切り替えをしない。
  // 返答の再生中に拾った音は、data の購読を外しているので Soniox へは送られない
  const recorderOnRef = useRef(false);
  const textSentRef = useRef(false); // テキスト送信時はSTT自動再起動をスキップ
  const sttDetectAtRef = useRef<number | null>(null);
  const lastActivityAtRef = useRef<number>(0);
  const inactivityTimerRef = useRef<NodeJS.Timeout | null>(null);
  const INACT_MS = 900;


  // 会話を止めた後に再生用へ戻す。会話中は録音器を止めず、カテゴリも PlayAndRecord のまま（recorderOnRef のコメントと
  // app/README の「iOS の音声セッション」）。staysActiveInBackground は true にしないと、expo-av は背面でここの設定を当てず、
  // 前面に戻った瞬間に古い設定を当て直す。
  const restoreIOSPlayback = async () => {
    if (Platform.OS !== "ios") return;
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: false, // マイク完全に解放して再生専用
        staysActiveInBackground: true,
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
      if (stickToBottomRef.current) setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);

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
  const sttStartingRef = useRef(false); // 開始処理の最中（録音器の start が終わる前）。二重起動を防ぐ印は同期的に立てる
  const micDataSubRef = useRef<{ remove: () => void } | null>(null); // AudioRecord.on("data") の購読。止めるときに外す
  const preconnectedWsRef = useRef<WebSocket | null>(null);
  const preconnectedChoiceRef = useRef(""); // 先行接続を開いた時の選択（sttChoiceKey）
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

  // 録音器を動かす（動いていれば何もしない）。ネイティブ側は start が2回来ると録音キューを2本作るので必ずここを通す
  const ensureRecorder = async () => {
    if (recorderOnRef.current) return false;
    configureAudioRecord();
    await AudioRecord.start();
    recorderOnRef.current = true;
    return true;
  };

  // 会話そのものを止めるときだけ録音器を止める（ターンの区切りでは止めない）
  const stopRecorder = () => {
    try { micDataSubRef.current?.remove(); } catch {}
    micDataSubRef.current = null;
    if (!recorderOnRef.current) return;
    recorderOnRef.current = false;
    micStopRef.current = AudioRecord.stop().then(() => {}, () => {});
  };
  // 画面が消えるときは録音器を止める（会話中ずっと動かすので、置き去りにしない）
  useEffect(() => () => { stopRecorder(); releaseMic("chat"); }, []);

  // Soniox WS先行接続（再生中に呼ぶ）
  const preconnectSonioxWs = async () => {
    if (preconnectedWsRef.current) return;
    console.log("⏱️ preconnect: creating WebSocket");
    const keyPromise = getSonioxKey(); // 古ければ取り直す。WS接続と並行
    keyPromise.catch(() => {}); // WSが開かず await に到達しない場合の未処理rejectを防ぐ
    const ws = new WebSocket(SONIOX_WS_URL);
    ws.binaryType = "arraybuffer";
    preconnectedWsRef.current = ws;
    const choice = sttChoice;
    preconnectedChoiceRef.current = sttChoiceKey(choice); // 選択が変わったら startSonioxSTT はこの接続を使わない

    ws.onopen = async () => {
      console.log("⏱️ preconnect: WebSocket OPEN, sending config");
      let apiKey: string;
      try {
        apiKey = await keyPromise;
      } catch (e: any) {
        console.log(`⏱️ preconnect: key fetch failed: ${e?.message ?? e}`);
        try { ws.close(); } catch {}
        return;
      }
      const cfg = {
        api_key: apiKey,
        ...sonioxModelConfig(choice, SONIOX_MODEL),
        audio_format: "pcm_s16le",
        sample_rate: SONIOX_SAMPLE_RATE,
        num_channels: SONIOX_CHANNELS,
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

    // すでに起動中か開始処理の最中なら無視（多重起動防止）。
    // sonioxListeningRef は録音器の start が終わってから立つので、その数ミリ秒の間に2回目が通ると
    // iOS 側で AudioQueue が2本できて1本が宙に浮く（2026-11-08 のログで 9ms 間隔の二重起動を確認）。印はここで同期的に立てる
    if (sonioxListeningRef.current || sttStartingRef.current) {
      console.log(`Soniox STT: already ${sonioxListeningRef.current ? "listening" : "starting"} – skip`);
      return;
    }
    sttStartingRef.current = true;
    try {

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
    // 計測（2026-11-07、ロードマップ18）: 最初の音声を送ってから最初の文字が届くまで。STT モデルの比較用
    let firstAudioSentAt = 0;
    let firstTextSeen = false;
    let speechAt = 0; // マイクの RMS が SPEECH_RMS を超えた最初の時刻（話し始めの近似）
    let lastSpeechAt = 0; // 同じく最後の時刻（話し終わりの近似。周りがうるさいと遅めに出る）
    let endLogged = false;
    const SPEECH_RMS = 400;
    // 先行接続は選択が同じときだけ使うので、どちらの経路でもこの選択で繋がる
    const modelLabel = `${sonioxModelConfig(sttChoice, SONIOX_MODEL).model}/${sttChoiceKey(sttChoice)}`;

    // 終端の猶予（app/lib/sttModel.ts の sttGraceMs）。<end> が来ても graceMs 待ち、その間に声が出たら
    // 同じ発話として聞き続ける（Soniox は同じ WS で続きを文字にし、次の <end> を送る）。
    // 声が物音だっただけなら次の <end> が来ないので、RESUME_MAX_MS 新しい文字が無ければ送る。
    const graceMs = sttGraceMs(sttChoice, SONIOX_MODEL);
    const RESUME_MAX_MS = 3000;
    // 猶予中の音は、基準を超えた状態がこの長さ続いたときだけ「話の続き」とみなす（一瞬の物音で 3 秒待たない。2026-11-08）
    const RESUME_MIN_LOUD_MS = 200;
    let loudRunMs = 0; // 基準を超えた音が続いている長さ
    let loudRunPeak = 0; // その間の最大音量
    let firstEndAt = 0;
    let graceTimer: ReturnType<typeof setTimeout> | null = null;
    let resumeTimer: ReturnType<typeof setTimeout> | null = null;
    let resumes = 0;
    const clearGraceTimers = () => {
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    };
    const finishUtterance = (why: string) => {
      clearGraceTimers();
      if (graceMs > 0) {
        const line = `⏱️ STT grace: sent +${firstEndAt ? Date.now() - firstEndAt : -1}ms after first end (${why}, resumed=${resumes}, grace=${graceMs}ms, model=${modelLabel})`;
        console.log(line);
        if (DEBUG_TIME) setLog((L) => [...L, line]);
      }
      try { ws.close(); } catch {}
    };
    const onEndpoint = () => {
      if (!firstEndAt) firstEndAt = Date.now();
      if (graceMs <= 0) { finishUtterance("no grace"); return; }
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
      if (!graceTimer) { graceTimer = setTimeout(() => finishUtterance("quiet"), graceMs); loudRunMs = 0; loudRunPeak = 0; } // 終端の後の音だけを数える
    };
    const onSpeechDuringGrace = () => {
      if (!graceTimer) return;
      clearTimeout(graceTimer); graceTimer = null;
      resumes++;
      console.log(`⏱️ STT grace: speech resumed (+${Date.now() - firstEndAt}ms after first end, loud=${Math.round(loudRunMs)}ms, peak_rms=${loudRunPeak})`);
      resumeTimer = setTimeout(() => finishUtterance("no new text"), RESUME_MAX_MS);
    };

    // 先行接続済みWSがあれば再利用
    const preWs = preconnectedWsRef.current;
    const choiceChanged = !!preWs && preconnectedChoiceRef.current !== sttChoiceKey(sttChoice);
    const usePreconnected = preWs && preWs.readyState === WebSocket.OPEN && !choiceChanged;
    if (usePreconnected) {
      console.log(`⏱️ STT [${Date.now() - sttT0}ms] using preconnected WebSocket`);
    } else {
      console.log(`⏱️ STT [${Date.now() - sttT0}ms] creating new WebSocket${choiceChanged ? " (stt choice changed)" : ""}`);
      if (preWs) try { preWs.close(); } catch {}
    }
    preconnectedWsRef.current = null;

    const keyPromise = usePreconnected ? null : getSonioxKey(); // 古ければ取り直す。WS接続と並行
    keyPromise?.catch(() => {}); // WSが開かず await に到達しない場合の未処理rejectを防ぐ
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

    // 別の画面（ボイス登録）がマイクを取ったときに呼ばれる。録音・再生・WSを止め、途中の文章は送らない。
    // 勝手には再開しない（会話画面でもう一度ボタンを押してもらう）
    let preempted = false;
    const onMicPreempted = async () => {
      preempted = true;
      console.log("[MIC] chat preempted");
      sonioxListeningRef.current = false;
      sonioxFinalBufRef.current = ""; sonioxNonFinalBufRef.current = "";
      stopRecorder();
      await micStopRef.current;
      stopPlayback();
      try { preconnectedWsRef.current?.close(); } catch {}
      preconnectedWsRef.current = null;
      try { ws.close(); } catch {}
      setIsListening(false);
      setPartial("");
    };

    // 録音開始処理（WS接続前でも呼べる — バッファリングする）
    const beginRecording = async () => {
      // マイクの持ち主になる。ボイス登録の録音中なら、そちらを止めてから（止めると iOS の音声モードが再生用に戻るので取り直す）
      if (await acquireMic("chat", onMicPreempted)) await setIOSRecordingMode();
      if (!guard()) return;
      // 型定義は void だが、実体は NativeEventEmitter の購読（remove() で外せる）
      micDataSubRef.current = AudioRecord.on("data", (b64: string) => {
        if (!guard()) return;
        if (!sonioxListeningRef.current) return;

        try {
          const ab = base64ToArrayBuffer(b64);
          const chunk = new Uint8Array(ab);
          if (ab.byteLength >= 2) {
            const v = new Int16Array(ab, 0, Math.floor(ab.byteLength / 2));
            let sum = 0;
            for (let i = 0; i < v.length; i++) sum += v[i] * v[i];
            const rms = Math.round(Math.sqrt(sum / v.length));
            const chunkMs = (v.length / (SONIOX_SAMPLE_RATE * SONIOX_CHANNELS)) * 1000;
            if (rms >= SPEECH_RMS) {
              lastSpeechAt = Date.now();
              if (!speechAt) speechAt = lastSpeechAt;
              loudRunMs += chunkMs;
              if (rms > loudRunPeak) loudRunPeak = rms;
              if (loudRunMs >= RESUME_MIN_LOUD_MS) onSpeechDuringGrace();
            } else {
              // 猶予中に短い物音だけで終わったときは、続きとみなさなかったことを残す（音量の切り分け用）
              if (graceTimer && loudRunMs > 0) {
                console.log(`⏱️ STT grace: short noise ignored (+${Date.now() - firstEndAt}ms after first end, loud=${Math.round(loudRunMs)}ms, peak_rms=${loudRunPeak})`);
              }
              loudRunMs = 0; loudRunPeak = 0;
            }
          }
          if (wsReady && ws.readyState === 1) {
            ws.send(chunk);
            if (!firstAudioSentAt) firstAudioSentAt = Date.now();
          } else {
            audioBuffer.push(chunk);
          }
          bytesSent += chunk.byteLength;
        } catch (e: any) {
          setLog(L => [...L, `Soniox send err: ${e?.message ?? String(e)}`]);
        }
      }) as unknown as { remove: () => void };

      try {
        const started = await ensureRecorder();
        console.log(`⏱️ STT [${Date.now() - sttT0}ms] ${started ? "AudioRecord started" : "AudioRecord already running"}`);
        sonioxListeningRef.current = true;
        setIsListening(true);
        setPartial(""); setFinalText("");
        sonioxFinalBufRef.current = ""; sonioxNonFinalBufRef.current = "";
        backchannelFiredRef.current = false; backchannelAudioRef.current = null;
        bcStatsRef.current = { bc_received: false, bc_error: false };
        sttFinishedRef.current = false;
        if(DEBUG)setLog(L => [...L, "AudioRecord started"]);
      } catch (e: any) {
        setIsListening(false);
        setLog(L => [...L, `AudioRecord.start failed: ${e?.message ?? e}`]);
        stopRecorder();
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

        let apiKey: string;
        try {
          apiKey = await keyPromise!;
        } catch (e: any) {
          setLog(L => [...L, `Soniox key fetch failed: ${e?.message ?? e}`]);
          try { ws.close(); } catch {}
          return;
        }
        const cfg = {
          api_key: apiKey,
          ...sonioxModelConfig(sttChoice, SONIOX_MODEL),
          audio_format: "pcm_s16le",
          sample_rate: SONIOX_SAMPLE_RATE,
          num_channels: SONIOX_CHANNELS,
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
          if (!firstAudioSentAt) firstAudioSentAt = Date.now();
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
            if (DEBUG) setLog(L => [...L, "Soniox: <end> detected"]);
            // 計測（ロードマップ18）: 話し終わり（最後に RMS≥SPEECH_RMS だった時刻）から終端が届くまで。猶予中につないだ後の <end> も出す
            const line = `⏱️ STT endpoint: +${lastSpeechAt ? Date.now() - lastSpeechAt : -1}ms after last speech (rms≥${SPEECH_RMS}, model=${modelLabel}${endLogged ? ", after resume" : ""})`;
            endLogged = true;
            console.log(line);
            if (DEBUG_TIME) setLog((L) => [...L, line]);
            onEndpoint();
            continue;
          }
          // 声が戻った後に新しい文字が来たら、物音ではなかった。次の <end> を待つ
          if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
          if (t.is_final) {
            sonioxFinalBufRef.current += txt;
          } else {
            nonFinalCurrent += txt;
          }
        }
        sonioxNonFinalBufRef.current = nonFinalCurrent;
        const fullText = sonioxFinalBufRef.current + nonFinalCurrent;
        if (fullText.trim()) {
          if (!firstTextSeen) {
            firstTextSeen = true;
            const now = Date.now();
            const line = `⏱️ STT first text: +${speechAt ? now - speechAt : -1}ms after speech (rms≥${SPEECH_RMS}), +${firstAudioSentAt ? now - firstAudioSentAt : -1}ms after first audio (audio_proc=${data.total_audio_proc_ms ?? "?"}ms, model=${modelLabel})`;
            console.log(line);
            if (DEBUG_TIME) setLog((L) => [...L, line]);
          }
          setPartial(fullText);

          // 相槌トリガー: 有効 & 5文字以上 & まだ発火していない
          if (backchannelEnabledRef.current && !backchannelFiredRef.current && fullText.trim().length >= BACKCHANNEL_TRIGGER_CHARS) {
            backchannelFiredRef.current = true;
            const charId = selectedCharacterRef.current.character_id;
            const bcPartial = fullText.trim();
            console.log("[BC] fetch firing:", bcPartial, "historyLen=", historyRef.current.length);
            (async () => {
              try {
                const r = await apiFetch(BACKCHANNEL_PATH, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    partial_text: bcPartial,
                    character_id: charId,
                    app_version: APP_VERSION,
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
                  noteBc("bc_received");
                  if (sttFinishedRef.current) {
                    console.log("[BC] playing now");
                    enqueueAudio(data.audio, `bc-${Date.now()}`, data.format || "wav", { text: data.text, kind: "bc" });
                  } else {
                    console.log("[BC] cached for later");
                    backchannelAudioRef.current = { text: data.text, audio: data.audio, format: data.format || "wav" };
                  }
                }
              } catch (e: any) {
                console.log("[BC] ERROR:", e?.message ?? e);
                noteBc("bc_error");
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
      // 新しい開始が旧WSを閉じたときの close は、新しいセッションの状態（録音中の印・録音器）に触らない
      if (!guard()) { if(DEBUG)setLog(L => [...L, `Soniox WS closed (stale): code=${e.code}`]); return; }
      if(DEBUG)setLog(L => [...L, `Soniox WS closed: code=${e.code}`]);
      clearGraceTimers();

      // 状態リセット
      sonioxListeningRef.current = false;
      setIsListening(false);
      sttFinishedRef.current = true;

      const fullText = (sonioxFinalBufRef.current + sonioxNonFinalBufRef.current).trim();
      if (fullText) {
        setLog(L => [...L, JSON.stringify({ type: "user", text: fullText })]);
        setPartial("");
      }

      // ターンの区切り: 録音器は止めず、音を Soniox へ流すのだけやめる（会話を止めるのは stopSTT と preempt）。
      // 別の画面にマイクを取られて閉じたときは、そちらが録音中なので触らない
      if (!preempted) {
        try { micDataSubRef.current?.remove(); } catch {}
        micDataSubRef.current = null;
      }

      if (fullText) {
        // 本Lambdaへの送信を最優先（録音停止の完了を待たない）
        send(fullText);

        // 相槌音声があれば再生（ケース2: fetch完了済み）
        const bc = backchannelAudioRef.current;
        if (bc) {
          console.log("[BC] Playing cached backchannel:", bc.text);
          enqueueAudio(bc.audio, `bc-${Date.now()}`, bc.format, { text: bc.text, kind: "bc" });
          backchannelAudioRef.current = null;
        }
        // ケース1（fetchがまだ返ってない）はfetch完了時にsttFinishedRefを見て即再生
      }

      // 会話を止めたときだけ（録音器が止まっていれば）マイクを手放して再生用に戻す
      if (preempted || recorderOnRef.current) return;
      await micStopRef.current;
      releaseMic("chat");
      await restoreIOSPlayback();
    };

    } finally {
      sttStartingRef.current = false;
    }
  };


  const stopSonioxSTT = () => {
    if(DEBUG)setLog(L => [...L, "Soniox STT: stop()"]);
    try { sonioxWsRef.current?.close(); } catch {}  
  };


  // 再生中なら止めてキューを捨てる（文字は出す）
  const stopPlayback = () => {
    if (!playingRef.current) return;
    currentSoundRef.current?.stop();
    currentSoundRef.current?.release();
    currentSoundRef.current = null;
    for (const item of queueRef.current) showQueued(item, 0);
    queueRef.current = [];
    playingRef.current = false;
  };

  // iOS録音カテゴリ（staysActiveInBackground の意味は restoreIOSPlayback のコメント）
  const setIOSRecordingMode = async () => {
    if (Platform.OS !== "ios") return;
    try {
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        interruptionModeIOS: InterruptionModeIOS.DoNotMix,
      });
    } catch (e: any) {
      setLog(L => [...L, `Audio.setAudioModeAsync error: ${String(e)}`]);
    }
  };

  // STT開始/停止トグル
  const startSTT = async () => {
    if(DEBUG)setLog(L => [...L, "=== startSTT CALLED ==="]);
    if(DEBUG)setLog((L) => [...L, `sttMode=${sttMode}`]);

    // 二重起動ガード（無反応の原因になりやすいので明示。React の state は描画前だと古いので印も見る）
    if (isListening || sonioxListeningRef.current || sttStartingRef.current) return;

    // 再生中なら強制停止してキューをリセット
    stopPlayback();

    // iOS録音カテゴリ
    await setIOSRecordingMode();

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
      stopRecorder();
      await stopSonioxSTT();
    } else {
      try {
        await Voice.stop();
      } catch {}
    }
    await restoreIOSPlayback();
  };

  /* === 既存: 音声再生キュー/TTS === */
  // 鳴らす項目の文字を出す。ms は音声の長さ（0なら全文を一度に）。会話を切り替えた後に鳴った分は出さない
  const showQueued = (item: Queued, ms: number) => {
    if (item.session !== sessionIdRef.current) return;
    if (REVEAL_MODE === "steady" && item.uri && item.kind !== "bc") {
      // 返答の音声が鳴り始めた。この文と、すでに届いている後ろの文（鳴る待ちの音声に付いた文字、音声がまだ来ていない文）を一定速で続けて出す
      if (item.notice) setLog((L) => [...L, item.notice!]);
      if (item.text) showSteady(item.text);
      for (const q of queueRef.current) {
        if (q.text && q.uri && q.kind !== "bc" && q.session === item.session) { showSteady(q.text); q.text = undefined; }
      }
      for (const text of pendingTextsRef.current.values()) showSteady(text);
      pendingTextsRef.current.clear();
      replyAudioStartedRef.current = true;
      return;
    }
    const lines: string[] = [];
    if (item.notice) lines.push(item.notice);
    if (item.text) lines.push(ms > 0 ? JSON.stringify({ type: "bot", text: item.text, at: Date.now(), span: ms * REVEAL_SPEED }) : item.text);
    if (lines.length > 0) setLog((L) => [...L, ...lines]);
  };

  // steady: 前の文の出し終わりに続けて、文字数に応じた時間で出す
  const showSteady = (text: string) => {
    const at = Math.max(Date.now(), steadyCursorRef.current);
    const span = (Array.from(text).length / REVEAL_CHARS_PER_SEC) * 1000;
    steadyCursorRef.current = at + span;
    setLog((L) => [...L, JSON.stringify({ type: "bot", text, at, span })]);
  };

  // 音声の無い文字だけの項目。鳴らす待ちがあればその後ろに並べ、無ければすぐ出す
  const enqueueText = (text: string) => {
    const item: Queued = { text, session: sessionIdRef.current };
    if (playingRef.current || queueRef.current.length > 0) queueRef.current.push(item);
    else showQueued(item, 0);
  };

  const enqueueAudio = async (b64: string, id: string, format: string, show?: { text?: string; notice?: string; kind?: "bc" }) => {
    if(DEBUG)setLog(L => [...L, `---start--- enqueueAudio called: id=${id}, format=${format}`]);
    const session = sessionIdRef.current;
    const path = `${FileSystem.cacheDirectory}${id}.${format}`;
    await FileSystem.writeAsStringAsync(path, b64, {
      encoding: FileSystem.EncodingType.Base64,
    });
    queueRef.current.push({ uri: path, ...show, session, stats: turnStatsRef.current ?? undefined });
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
      // 録音器が動いている間はカテゴリを触らない（PlayAndRecord のまま鳴らす）。止まっていれば再生用にする
      if (!recorderOnRef.current) {
        if (micStopRef.current) await micStopRef.current;
        Sound.setCategory("Playback");
      }
      while (queueRef.current.length) {
        const item = queueRef.current.shift()!;
        if (!item.uri) {
          showQueued(item, 0);
          continue;
        }
        const path = item.uri.replace("file://", "");
        console.log(`🎵 dequeued (Sound): ${path}`);
        await new Promise<void>((resolve) => {
          // 見張り: 読み込み・再生のコールバックが戻らないと、この文も後ろの文も出ず、マイクも再開しない。
          // 期限が来たら文字だけ出して次へ進む（PLAYBACK_*）。回数は prev_turn.stalls でサーバーのログに残る。
          let settled = false;
          let shown = false;
          let timer: ReturnType<typeof setTimeout> | null = null;
          let s: Sound | null = null;
          const finish = () => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            currentSoundRef.current = null;
            loopBeatRef.current = Date.now();
            resolve();
          };
          const stall = (phase: "load" | "play") => {
            if (settled) return;
            console.log(`⏰ playback watchdog: ${phase} did not return, skipping:`, path);
            if (item.stats) item.stats.stalls++;
            if (!shown) showQueued(item, 0);
            try { s?.stop(); s?.release(); } catch {}
            finish();
          };
          timer = setTimeout(() => stall("load"), PLAYBACK_LOAD_TIMEOUT_MS);
          s = new Sound(path, "", (error) => {
            if (settled) { try { s?.release(); } catch {} return; } // 見張りが先に進めた後に戻ってきた
            if (timer) clearTimeout(timer);
            if (error) {
              console.log("❌ Sound load error:", error);
              if (item.stats) item.stats.play_failed++;
              showQueued(item, 0);
              finish();
              return;
            }
            console.log("✅ Sound loaded:", path);
            currentSoundRef.current = s;
            loopBeatRef.current = Date.now();
            // 最後のチャンクならSoniox WSを先行接続
            if (queueRef.current.length === 0 && sttMode === "soniox") {
              preconnectSonioxWs();
            }
            const durationMs = s!.getDuration() > 0 ? s!.getDuration() * 1000 : 0;
            showQueued(item, durationMs);
            shown = true;
            timer = setTimeout(() => stall("play"), (durationMs || PLAYBACK_UNKNOWN_DURATION_MS) + PLAYBACK_GRACE_MS);
            s!.play((success) => {
              if (settled) { try { s?.release(); } catch {} return; }
              if (success) console.log("🏁 Finished playing:", path);
              else console.log("⚠️ Playback failed:", path);
              if (item.stats) {
                if (!success) item.stats.play_failed++;
                else if (item.kind === "bc") item.stats.bc_played = true;
                else item.stats.played++;
              }
              s!.release();
              finish();
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
            stopRecorder();
            return;
          }
          // 別の画面（ボイス登録）が録音中なら取りに行かない
          const owner = micOwner();
          if (owner && owner !== "chat") {
            console.log(`⏸️ mic in use by ${owner}, skip auto-restart STT`);
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

    // 前のターンの結果を次の要求に添え、このターンの記録を新しく始める（文章は入れない。TurnStats）
    const prevTurn = turnStatsRef.current;
    const stats: TurnStats = {
      request_at: "", attempts: 0, segments: 0, tts: 0, done: false, loaded: false, error: null,
      played: 0, play_failed: 0, stalls: 0,
      ...bcStatsRef.current, bc_played: false,
    };
    bcStatsRef.current = { bc_received: false, bc_error: false };
    turnStatsRef.current = stats;

    if (DEBUG) setLog((L) => [...L, `→ POST ${t}`]);
    if (DEBUG_TIME) sendStartAtRef.current = Date.now();
    setMsg("");
    if (textArg === undefined) {
      setLog((L) => [...L, JSON.stringify({ type: "user", text: t })]);
      if (stickToBottomRef.current) setTimeout(() => scrollRef.current?.scrollToEnd({ animated: true }), 50);
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
      // 文のid → 文字。音声（tts）が届いたら音声と一緒に順番待ちへ入れ、鳴り始めに出す
      const pendingTexts = new Map<string, string>();
      pendingTextsRef.current = pendingTexts;
      replyAudioStartedRef.current = false;
      steadyCursorRef.current = 0;
      // 音声が来なかった文（TTSの失敗など）の文字を、鳴らす待ちの後ろに並べる。応答の終わり・通信の失敗で呼ぶ
      const flushPendingTexts = () => {
        for (const text of pendingTexts.values()) enqueueText(text);
        pendingTexts.clear();
      };
      let fallbackNoticeShown = false; // 主の声が混み合ってずんだもんに替わったことを、返答ごとに1回だけ知らせる
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
            const { id, b64, format, fallback } = obj || {};
            if (id != null && b64 && format) {
              const key = `tts:${String(id)}`;
              if (!printedIds.has(key)) {
                printedIds.add(key);
                stats.tts++;
                const text = pendingTexts.get(String(id));
                pendingTexts.delete(String(id));
                // 切り替えの一言は、切り替わった文の前に出す（steady で文字がもう出ていれば、その後ろ）
                let notice: string | undefined;
                if (fallback && !fallbackNoticeShown) {
                  fallbackNoticeShown = true;
                  notice = "（混み合っているため、一時的に別の声で話しています）";
                }
                if (REVEAL_MODE === "steady" && replyAudioStartedRef.current) {
                  if (notice) setLog((L) => [...L, notice!]);
                  enqueueAudio(b64, String(id), String(format));
                } else {
                  enqueueAudio(b64, String(id), String(format), { text, notice });
                }
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
              stats.segments++;
              if (text) {
                if (REVEAL_MODE === "steady" && replyAudioStartedRef.current) showSteady(text);
                else if (segId) pendingTexts.set(segId, text);
                else enqueueText(text);
                curAssistantRef.current += text;
              }
            }
            if (final) {
              console.log("🧾 final segment received");
            }
          } else if (ev === "error") {
            setLog((L) => [...L, `Error: ${dataStr}`]);
          } else if (ev === "done") {
            stats.done = true;
            flushPendingTexts();
            if (DEBUG_TIME) mtReport(setLog);
          }
        } catch (e: any) {
          stats.error = "parse";
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
        flushPendingTexts();
        // 未受信でもサーバーが処理済みの可能性はある。再送は最大2回に制限する。
        // 受信開始後の失敗は再送しない(既に再生した音声・表示した文が二重になるため)。
        const receivedNothing = lastIndex === 0;
        if (receivedNothing && attemptNo <= MAX_RETRIES) {
          const wait = RETRY_BACKOFF_MS[attemptNo - 1] ?? 1500;
          setLog((L) => [...L, `通信に失敗しました。接続を再試行しています（${attemptNo}/${MAX_RETRIES}）…`]);
          setTimeout(() => {
            try {
              attempt(attemptNo + 1);
            } catch (e: any) {
              console.warn("Conversation retry failed:", e);
              setLog((L) => [...L, "会話の送信処理に失敗しました。もう一度お試しください。"]);
              sendingRef.current = false;
            }
          }, wait);
          return;
        }
        stats.error = "network";
        setLog((L) => [
          ...L,
          receivedNothing
            ? "再試行しましたが、通信に失敗しました。通信環境を確認して、もう一度お試しください。"
            : "応答の受信が途中で切れました。通信環境を確認して、もう一度お話しください。",
        ]);
        sendingRef.current = false;
      };
      xhr.ontimeout = () => {
        flushPendingTexts();
        // 30s待った後なので再送しない
        stats.error = "timeout";
        setLog((L) => [...L, "応答の受信が30秒以内に完了しなかったため、通信を終了しました。もう一度お試しください。"]);
        sendingRef.current = false;
      };

      xhr.onload = () => {
        if (xhr.status >= 400) {
          // 認証・所有者確認（docs/auth.md）か、残高0（402 no_balance）で拒まれた。無言にせず理由を出す
          let reason = "";
          try { reason = JSON.parse(xhr.responseText || "{}").error ?? ""; } catch {}
          const msg = reason === "login_required" ? "ログインが必要です。設定のアカウント情報からログインしてください。"
            : reason === "invalid_token" ? "ログインの期限が切れました。設定のアカウント情報からログインし直してください。"
            : reason === "not_owner" ? "このキャラクターは使えません（別のアカウントのものです）。キャラクターを選び直してください。"
            : reason === "no_balance" ? "ポイントがなくなりました。ポイントを追加すると、また話せます（残高は設定の利用状況で見られます）。"
            : `会話を始められませんでした（${xhr.status}${reason ? " " + reason : ""}）。`;
          stats.error = `http:${xhr.status}`;
          setLog((L) => [...L, msg]);
          sendingRef.current = false;
          return;
        }
        const text = xhr.responseText || "";
        const tail = text.slice(lastIndex);
        if (tail) processChunk(tail);
        flushPendingTexts();
        stats.loaded = true;
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

      const requestAt = new Date().toISOString();
      if (attemptNo === 1) stats.request_at = requestAt;
      stats.attempts = attemptNo;
      const payload = {
        character_id: selectedCharacterRef.current.character_id,
        messages: historyMessages,
        session_id: sessionIdRef.current,
        owner_id: ownerId,
        device_id: "app",
        app_version: APP_VERSION, // Lambdaの切り分けログ用（どの版のアプリからの要求か）
        request_at: requestAt,
        backchannel_fired: backchannelFiredRef.current,
        prev_turn: prevTurn, // 前のターンをアプリが受け取って鳴らしたか（TurnStats。文章は無い）。Lambda のログに同名で載る
      };
      console.log("🚀 payload to Lambda:", JSON.stringify(payload, null, 2), attemptNo > 1 ? `(attempt ${attemptNo})` : "");
      // CloudFront → Lambda の署名用に本文のハッシュと、ログイン中ならトークンを添える（app/lib/api.ts）
      // open() 後・send() 前なら非同期を挟んでよい。ハッシュに失敗しても送る（NONE の間は通る。IAM 後は 403 になりログで分かる）
      const json = JSON.stringify(payload);
      requestHeaders(json)
        .then((h) => { for (const [k, v] of Object.entries(h)) xhr.setRequestHeader(k, v); })
        .catch((e) => console.log("[SEND] body hash failed:", e?.message ?? e))
        .finally(() => xhr.send(json));
    };

    try {
      attempt(1);
    } catch (e: any) {
      console.warn("Conversation send failed:", e);
      setLog((L) => [...L, "会話の送信処理に失敗しました。もう一度お試しください。"]);
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
          // 付いていくかは利用者が指で動かしたときだけ決め直す（自動で下へ送っている途中の位置では外さない）
          if (!draggingRef.current) return;
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          setStick(contentSize.height - contentOffset.y - layoutMeasurement.height < STICK_PX);
        }}
        onScrollBeginDrag={() => { draggingRef.current = true; }}
        onScrollEndDrag={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          setStick(contentSize.height - contentOffset.y - layoutMeasurement.height < STICK_PX);
          draggingRef.current = false;
        }}
        onMomentumScrollEnd={(e) => {
          const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
          setStick(contentSize.height - contentOffset.y - layoutMeasurement.height < STICK_PX);
        }}
        onContentSizeChange={() => {
          if (stickToBottomRef.current && !draggingRef.current) scrollRef.current?.scrollToEnd({ animated: true });
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
            } else if (obj.type === "bot") {
              return <RevealText key={i} text={obj.text} at={obj.at} span={obj.span} style={s.line} />;
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
            onPress={() => { setStick(true); scrollRef.current?.scrollToEnd({ animated: true }); }}
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
