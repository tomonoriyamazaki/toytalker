import { useState, useEffect, useCallback, useRef } from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useOwnerId } from "../../hooks/useOwnerId";
import { fetchWithRetry } from "../../lib/fetchWithRetry";
import {
  SafeAreaView,
  Text,
  View,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  FlatList,
  Alert,
  ActivityIndicator,
  Platform,
  PermissionsAndroid,
  ScrollView,
  Switch,
} from "react-native";
import { BleManager, Device } from "react-native-ble-plx";

// BLE UUIDs (ESP32側と一致させる)
const SERVICE_UUID       = "12345678-1234-1234-1234-123456789abc";
const CHAR_SSID_UUID     = "12345678-1234-1234-1234-123456789ab1";
const CHAR_PASSWORD_UUID = "12345678-1234-1234-1234-123456789ab2";
const CHAR_COMMAND_UUID  = "12345678-1234-1234-1234-123456789ab3";
const CHAR_STATUS_UUID   = "12345678-1234-1234-1234-123456789ab4";
const CHAR_MAC_UUID      = "12345678-1234-1234-1234-123456789ab5";

const DEVICE_SETTING_URL   = "https://7k6nkpy3tf2drljy77pnouohjm0buoux.lambda-url.ap-northeast-1.on.aws";
const DEFAULT_CHARACTER_ID = "default";

const bleManager = new BleManager();

type ConnectionStatus = "disconnected" | "scanning" | "connecting" | "connected" | "configuring";
type Screen = "home" | "wifi-setup" | "device-settings" | "character-select" | "conversation-log" | "conversation-messages";

type CharacterItem = {
  character_id: string;
  name: string;
  description: string;
  owner_id: string;
  voice_id: string;
  personality_prompt?: string;
};

type RegisteredDevice = {
  device_id: string;
  character_id: string | null;
  owner_id: string;
  device_name: string;
  backchannel_enabled?: boolean;
};

type SessionItem = {
  session_id: string;
  first_message: string;
  timestamp: string;
};

type LogMessage = {
  role: string;
  content: string;
  timestamp: string;
};

export default function Toy() {
  const ownerId = useOwnerId();
  const [status, setStatus]                         = useState<ConnectionStatus>("disconnected");
  const [bleDevices, setBleDevices]                 = useState<Device[]>([]);
  const [connectedDevice, setConnectedDevice]       = useState<Device | null>(null);
  const [ssid, setSsid]                             = useState("");
  const [password, setPassword]                     = useState("");
  const [statusMessage, setStatusMessage]           = useState("");
  const [screen, setScreen]                         = useState<Screen>("home");
  const [deviceId, setDeviceId]                       = useState<string | null>(null);
  const [registeredDevices, setRegisteredDevices]     = useState<RegisteredDevice[]>([]);
  const [characters, setCharacters]                   = useState<CharacterItem[]>([]);
  const [charactersLoading, setCharactersLoading]     = useState(false);
  const [updatingCharacter, setUpdatingCharacter]   = useState(false);
  const [sessions, setSessions]                     = useState<SessionItem[]>([]);
  const [sessionsLoading, setSessionsLoading]       = useState(false);
  const [logMessages, setLogMessages]               = useState<LogMessage[]>([]);
  const [logMessagesLoading, setLogMessagesLoading] = useState(false);
  const [selectedSessionId, setSelectedSessionId]   = useState<string | null>(null);

  useEffect(() => {
    if (Platform.OS === "android") {
      requestAndroidPermissions();
    }
    // AsyncStorageから登録済みデバイスを復元（旧キーからのマイグレーション対応）
    (async () => {
      const newVal = await AsyncStorage.getItem("registeredDevices");
      if (newVal) {
        setRegisteredDevices(JSON.parse(newVal));
      } else {
        const oldVal = await AsyncStorage.getItem("registeredDevice");
        if (oldVal) {
          const d = JSON.parse(oldVal);
          const migrated = [{ ...d, device_name: d.device_name ?? "" }];
          setRegisteredDevices(migrated);
          await AsyncStorage.setItem("registeredDevices", JSON.stringify(migrated));
          await AsyncStorage.removeItem("registeredDevice");
        }
      }
    })();
    return () => {
      bleManager.stopDeviceScan();
    };
  }, []);

  // サーバーからデバイス一覧を同期
  useEffect(() => {
    if (!ownerId) return;
    (async () => {
      try {
        const res = await fetchWithRetry(`${DEVICE_SETTING_URL}/devices?owner_id=${encodeURIComponent(ownerId)}`);
        const data = await res.json();
        if (data.devices?.length > 0) {
          const devices = data.devices.map((d: any) => ({
            device_id: d.device_id,
            character_id: d.character_id,
            owner_id: d.owner_id,
            device_name: d.device_name ?? "",
            backchannel_enabled: d.backchannel_enabled !== false,
          }));
          setRegisteredDevices(devices);
          await AsyncStorage.setItem("registeredDevices", JSON.stringify(devices));
        }
      } catch {}
    })();
  }, [ownerId]);

  // キャラクター一覧をプリフェッチ（名前表示用）
  useEffect(() => {
    if (!ownerId) return;
    (async () => {
      try {
        const res = await fetchWithRetry(`${DEVICE_SETTING_URL}/characters?owner_id=${encodeURIComponent(ownerId)}`);
        const data = await res.json();
        setCharacters(data.characters ?? []);
      } catch {}
    })();
  }, [ownerId]);

  const currentDevice = registeredDevices.find((d) => d.device_id === deviceId) ?? null;

  const addOrUpdateDevice = async (device: RegisteredDevice) => {
    setRegisteredDevices((prev) => {
      const idx = prev.findIndex((d) => d.device_id === device.device_id);
      const updated = idx >= 0
        ? prev.map((d, i) => (i === idx ? { ...device, device_name: device.device_name || d.device_name } : d))
        : [...prev, device];
      AsyncStorage.setItem("registeredDevices", JSON.stringify(updated));
      return updated;
    });
  };

  const removeDevice = async (targetDeviceId: string) => {
    setRegisteredDevices((prev) => {
      const updated = prev.filter((d) => d.device_id !== targetDeviceId);
      AsyncStorage.setItem("registeredDevices", JSON.stringify(updated));
      return updated;
    });
    setDeviceId(null);
    setScreen("home");
  };

  const updateDeviceName = async (targetDeviceId: string, name: string) => {
    setRegisteredDevices((prev) => {
      const updated = prev.map((d) => (d.device_id === targetDeviceId ? { ...d, device_name: name } : d));
      AsyncStorage.setItem("registeredDevices", JSON.stringify(updated));
      return updated;
    });
    try {
      await fetch(`${DEVICE_SETTING_URL}/devices/${encodeURIComponent(targetDeviceId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_name: name }),
      });
    } catch {}
  };

  const requestAndroidPermissions = async () => {
    if (Platform.OS === "android" && Platform.Version >= 31) {
      await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
        PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
      ]);
    } else if (Platform.OS === "android") {
      await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION);
    }
  };

  const scanStopTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const finishScan = (message: string) => {
    if (scanStopTimerRef.current) {
      clearTimeout(scanStopTimerRef.current);
      scanStopTimerRef.current = null;
    }
    bleManager.stopDeviceScan();
    setStatus("disconnected");
    setStatusMessage(message);
  };

  const startScan = () => {
    setBleDevices([]);
    setStatus("scanning");
    setStatusMessage("スキャン中...");
    let foundAny = false;

    bleManager.startDeviceScan(null, null, (error, device) => {
      if (error) {
        finishScan("スキャンエラー: " + error.message);
        return;
      }
      if (device?.name?.includes("ToyTalk")) {
        setBleDevices((prev) => {
          if (prev.find((d) => d.id === device.id)) return prev;
          return [...prev, device];
        });
        // 最初の1台を見つけたら、近くの2台目を拾う猶予1秒だけ待って終了
        if (!foundAny) {
          foundAny = true;
          if (scanStopTimerRef.current) clearTimeout(scanStopTimerRef.current);
          scanStopTimerRef.current = setTimeout(() => finishScan("スキャン完了"), 1000);
        }
      }
    });

    // 何も見つからない場合の上限
    scanStopTimerRef.current = setTimeout(() => finishScan("スキャン完了"), 5000);
  };

  const stopScan = () => {
    finishScan("");
  };

  const connectToDevice = async (device: Device) => {
    try {
      bleManager.stopDeviceScan();
      setStatus("connecting");
      setStatusMessage("接続中...");

      const connected = await device.connect();
      await connected.discoverAllServicesAndCharacteristics();

      // MACアドレスをCHAR_MACから読み取る
      const macChar = await connected.readCharacteristicForService(SERVICE_UUID, CHAR_MAC_UUID);
      const mac = macChar.value ? atob(macChar.value) : device.id;
      setDeviceId(mac);

      setConnectedDevice(connected);
      setStatus("connected");
      setStatusMessage("接続完了！WiFi設定を入力してください");
      setScreen("wifi-setup");

      connected.monitorCharacteristicForService(
        SERVICE_UUID,
        CHAR_STATUS_UUID,
        (error, characteristic) => {
          if (error) return;
          if (characteristic?.value) {
            handleStatusUpdate(atob(characteristic.value), mac);
          }
        }
      );

      connected.onDisconnected(() => {
        setConnectedDevice(null);
        setStatus("disconnected");
        setStatusMessage("");
        setScreen("home");
      });
    } catch (error: any) {
      setStatus("disconnected");
      setStatusMessage("接続エラー: " + error.message);
    }
  };

  const handleStatusUpdate = async (bleStatus: string, mac: string) => {
    switch (bleStatus) {
      case "CONNECTING":
        setStatusMessage("WiFi接続中...");
        break;
      case "CONNECTED":
        setStatusMessage("WiFi接続成功！デバイスを登録中...");
        await registerDevice(mac);
        break;
      case "FAILED":
        setStatusMessage("WiFi接続失敗");
        Alert.alert("エラー", "WiFi接続に失敗しました。SSID/パスワードを確認してください。");
        break;
      default:
        setStatusMessage(bleStatus);
    }
  };

  const registerDevice = async (mac: string) => {
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/devices`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ device_id: mac, owner_id: ownerId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      // 登録後にデバイス情報を取得
      const deviceRes = await fetch(`${DEVICE_SETTING_URL}/devices/${encodeURIComponent(mac)}`);
      const deviceData = await deviceRes.json();
      await addOrUpdateDevice({ ...deviceData, device_name: deviceData.device_name ?? "" });
      setStatusMessage("デバイス登録完了！");
    } catch (e: any) {
      setStatusMessage("デバイス登録エラー: " + e.message);
    }
  };

  const sendWiFiConfig = async () => {
    if (!connectedDevice) {
      Alert.alert("エラー", "デバイスに接続されていません");
      return;
    }
    if (!ssid) {
      Alert.alert("エラー", "SSIDを入力してください");
      return;
    }
    try {
      setStatus("configuring");
      setStatusMessage("設定を送信中...");
      await connectedDevice.writeCharacteristicWithResponseForService(SERVICE_UUID, CHAR_SSID_UUID, btoa(ssid));
      await connectedDevice.writeCharacteristicWithResponseForService(SERVICE_UUID, CHAR_PASSWORD_UUID, btoa(password));
      await connectedDevice.writeCharacteristicWithResponseForService(SERVICE_UUID, CHAR_COMMAND_UUID, btoa("CONNECT"));
      setStatusMessage("設定送信完了、WiFi接続を待機中...");
    } catch (error: any) {
      // BLE切断エラーはCONNECTコマンド処理後の正常切断の可能性があるので無視
      if (error.message?.toLowerCase().includes("disconnect")) return;
      setStatus("connected");
      setStatusMessage("送信エラー: " + error.message);
    }
  };

  const disconnect = async () => {
    if (connectedDevice) {
      await connectedDevice.cancelConnection();
      setConnectedDevice(null);
    }
    setStatus("disconnected");
    setStatusMessage("");
    setSsid("");
    setPassword("");
    setScreen("home");
    // registeredDevice と deviceId はAsyncStorageに保持（画面に残す）
  };

  const openDeviceSettings = () => {
    setScreen("device-settings");
  };

  const openCharacterSelect = async () => {
    setCharactersLoading(true);
    setScreen("character-select");
    try {
      const res = await fetchWithRetry(`${DEVICE_SETTING_URL}/characters?owner_id=${encodeURIComponent(ownerId!)}`);
      const data = await res.json();
      setCharacters(data.characters ?? []);
    } catch (e: any) {
      Alert.alert("エラー", `キャラクター一覧の取得に失敗しました\n(${e?.message ?? e})`);
    } finally {
      setCharactersLoading(false);
    }
  };

  const selectCharacter = async (characterId: string) => {
    if (!deviceId) return;
    setUpdatingCharacter(true);
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/devices/${encodeURIComponent(deviceId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ character_id: characterId }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setRegisteredDevices((prev) => {
        const updated = prev.map((d) => (d.device_id === deviceId ? { ...d, character_id: characterId } : d));
        AsyncStorage.setItem("registeredDevices", JSON.stringify(updated));
        return updated;
      });
      setScreen("device-settings");
    } catch (e: any) {
      Alert.alert("エラー", "キャラクターの更新に失敗しました");
    } finally {
      setUpdatingCharacter(false);
    }
  };

  const openConversationLog = async () => {
    if (!deviceId) return;
    setSessionsLoading(true);
    setScreen("conversation-log");
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/logs/sessions?owner_id=${encodeURIComponent(ownerId!)}&device_id=${encodeURIComponent(deviceId)}`);
      const data = await res.json();
      setSessions(data.sessions ?? []);
    } catch (e: any) {
      Alert.alert("エラー", "会話ログの取得に失敗しました");
    } finally {
      setSessionsLoading(false);
    }
  };

  const loadSessionMessages = async (sessionId: string) => {
    if (!deviceId) return;
    setLogMessagesLoading(true);
    setSelectedSessionId(sessionId);
    setScreen("conversation-messages");
    try {
      const res = await fetch(`${DEVICE_SETTING_URL}/logs/messages?owner_id=${encodeURIComponent(ownerId!)}&device_id=${encodeURIComponent(deviceId)}&session_id=${encodeURIComponent(sessionId)}`);
      const data = await res.json();
      setLogMessages(data.messages ?? []);
    } catch (e: any) {
      Alert.alert("エラー", "メッセージの取得に失敗しました");
    } finally {
      setLogMessagesLoading(false);
    }
  };

  const currentCharacterLabel = (device?: RegisteredDevice | null) => {
    const d = device ?? currentDevice;
    if (!d?.character_id || d.character_id === "default") return "デフォルト";
    const c = characters.find((c) => c.character_id === d.character_id);
    return c ? c.name : d.character_id;
  };

  // ---- 会話メッセージ画面 ----
  if (screen === "conversation-messages") {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => setScreen("conversation-log")}>
            <Text style={s.back}>← 戻る</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>会話内容</Text>
        </View>
        {logMessagesLoading ? (
          <View style={s.center}>
            <ActivityIndicator size="large" color="#007AFF" />
          </View>
        ) : logMessages.length === 0 ? (
          <View style={s.center}>
            <Text style={s.emptyText}>メッセージがありません</Text>
          </View>
        ) : (
          <FlatList
            data={logMessages}
            keyExtractor={(_, i) => String(i)}
            contentContainerStyle={{ padding: 16, gap: 8 }}
            renderItem={({ item }) => {
              const isUser = item.role === "user";
              return (
                <View style={[s.msgBubble, isUser ? s.msgUser : s.msgAssistant]}>
                  <Text style={[s.msgRole, isUser && { color: "rgba(255,255,255,0.7)" }]}>{isUser ? "こども" : "AI"}</Text>
                  <Text style={[s.msgContent, isUser && { color: "#fff" }]}>{item.content}</Text>
                  <Text style={[s.msgTime, isUser && { color: "rgba(255,255,255,0.6)" }]}>{new Date(item.timestamp).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}</Text>
                </View>
              );
            }}
          />
        )}
      </SafeAreaView>
    );
  }

  // ---- 会話ログ画面（セッション一覧） ----
  if (screen === "conversation-log") {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => setScreen("device-settings")}>
            <Text style={s.back}>← 戻る</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>会話ログ</Text>
        </View>
        {sessionsLoading ? (
          <View style={s.center}>
            <ActivityIndicator size="large" color="#007AFF" />
          </View>
        ) : sessions.length === 0 ? (
          <View style={s.center}>
            <Text style={s.emptyText}>会話ログがありません</Text>
          </View>
        ) : (
          <FlatList
            data={sessions}
            keyExtractor={(item) => item.session_id}
            contentContainerStyle={{ padding: 16, gap: 8 }}
            renderItem={({ item }) => (
              <TouchableOpacity style={s.deviceItem} onPress={() => loadSessionMessages(item.session_id)}>
                <View style={{ flex: 1 }}>
                  <Text style={s.deviceName} numberOfLines={2}>{item.first_message || "(空のセッション)"}</Text>
                  <Text style={s.deviceSub}>{new Date(item.timestamp).toLocaleString("ja-JP")}</Text>
                </View>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
            )}
          />
        )}
      </SafeAreaView>
    );
  }

  // ---- キャラクター選択画面 ----
  if (screen === "character-select") {
    const currentId = currentDevice?.character_id ?? DEFAULT_CHARACTER_ID;
    const systemChars = characters.filter((c) => c.owner_id === "system");
    const userChars   = characters.filter((c) => c.owner_id !== "system");

    const sections = [
      { title: "システム", data: systemChars },
      { title: "カスタム", data: userChars },
    ].filter((s) => s.data.length > 0);

    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => setScreen("device-settings")}>
            <Text style={s.back}>← 戻る</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>キャラクター選択</Text>
        </View>
        {charactersLoading || updatingCharacter ? (
          <View style={s.center}>
            <ActivityIndicator size="large" color="#007AFF" />
          </View>
        ) : (
          <FlatList
            data={characters}
            keyExtractor={(item) => item.character_id}
            contentContainerStyle={{ padding: 16, gap: 8 }}
            ListHeaderComponent={
              <>
                {sections.map((section) => (
                  <View key={section.title}>
                    <Text style={s.sectionHeader}>{section.title}</Text>
                    {section.data.map((item) => {
                      const selected = item.character_id === currentId;
                      return (
                        <TouchableOpacity
                          key={item.character_id}
                          style={[s.characterItem, selected && s.characterItemSelected]}
                          onPress={() => selectCharacter(item.character_id)}
                        >
                          <View style={s.characterRow}>
                            <View style={[s.radio, selected && s.radioSelected]} />
                            <View style={{ flex: 1 }}>
                              <Text style={[s.characterLabel, selected && s.characterLabelSelected]}>{item.name}</Text>
                              {item.description ? (
                                <Text style={s.characterDesc}>{item.description}</Text>
                              ) : null}
                            </View>
                          </View>
                        </TouchableOpacity>
                      );
                    })}
                  </View>
                ))}
              </>
            }
            renderItem={() => null}
          />
        )}
      </SafeAreaView>
    );
  }

  // ---- デバイス設定画面 ----
  if (screen === "device-settings") {
    const deleteDevice = () => {
      Alert.alert("デバイスを削除", "このデバイスの登録を解除しますか？", [
        { text: "キャンセル", style: "cancel" },
        {
          text: "削除",
          style: "destructive",
          onPress: async () => {
            try {
              await fetch(`${DEVICE_SETTING_URL}/devices/${encodeURIComponent(deviceId!)}`, {
                method: "DELETE",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ owner_id: ownerId }),
              });
            } catch {}
            await removeDevice(deviceId!);
          },
        },
      ]);
    };

    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <TouchableOpacity onPress={() => setScreen("home")}>
            <Text style={s.back}>← 戻る</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>デバイス設定</Text>
        </View>
        <ScrollView contentContainerStyle={s.wrap}>
          <TextInput
            style={s.input}
            value={currentDevice?.device_name ?? ""}
            onChangeText={(text) => {
              setRegisteredDevices((prev) =>
                prev.map((d) => (d.device_id === deviceId ? { ...d, device_name: text } : d))
              );
            }}
            onEndEditing={(e) => {
              if (deviceId) updateDeviceName(deviceId, e.nativeEvent.text);
            }}
            placeholder={deviceId ?? "デバイス名を入力"}
            autoCapitalize="none"
          />
          <Text style={s.deviceIdText}>{deviceId}</Text>
          <TouchableOpacity style={s.settingRow} onPress={openCharacterSelect}>
            <View>
              <Text style={s.settingLabel}>キャラクター</Text>
              <Text style={s.settingValue}>{currentCharacterLabel()}</Text>
            </View>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>
          <View style={s.settingRow}>
            <Text style={s.settingLabel}>相槌（あいづち）</Text>
            <Switch
              value={currentDevice?.backchannel_enabled !== false}
              onValueChange={async (val) => {
                setRegisteredDevices((prev) => {
                  const updated = prev.map((d) => (d.device_id === deviceId ? { ...d, backchannel_enabled: val } : d));
                  AsyncStorage.setItem("registeredDevices", JSON.stringify(updated));
                  return updated;
                });
                try {
                  await fetch(`${DEVICE_SETTING_URL}/devices/${encodeURIComponent(deviceId!)}`, {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ backchannel_enabled: val }),
                  });
                } catch {}
                Alert.alert("設定を変更しました", "おもちゃの電源を入れ直してください");
              }}
            />
          </View>
          <TouchableOpacity style={s.settingRow} onPress={openConversationLog}>
            <View>
              <Text style={s.settingLabel}>会話ログ</Text>
              <Text style={s.settingValue}>デバイスの会話履歴を確認</Text>
            </View>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>
          <TouchableOpacity style={s.deleteButton} onPress={deleteDevice}>
            <Text style={s.deleteButtonText}>デバイスを削除</Text>
          </TouchableOpacity>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ---- WiFi設定画面 ----
  if (screen === "wifi-setup") {
    return (
      <SafeAreaView style={s.root}>
        <View style={s.header}>
          <TouchableOpacity onPress={disconnect}>
            <Text style={s.back}>← 戻る</Text>
          </TouchableOpacity>
          <Text style={s.headerTitle}>WiFi設定</Text>
        </View>
        <ScrollView contentContainerStyle={s.wrap}>
          {statusMessage ? (
            <View style={s.statusBox}>
              <Text style={s.statusText}>{statusMessage}</Text>
            </View>
          ) : null}

          {status === "connecting" && (
            <View style={s.center}>
              <ActivityIndicator size="large" color="#007AFF" />
              <Text style={s.loadingText}>接続中...</Text>
            </View>
          )}

          {(status === "connected" || status === "configuring") && (
            <View style={s.form}>
              <Text style={s.label}>SSID (WiFi名)</Text>
              <TextInput
                style={s.input}
                value={ssid}
                onChangeText={setSsid}
                placeholder="WiFiのSSIDを入力"
                autoCapitalize="none"
                autoCorrect={false}
              />
              <Text style={s.label}>パスワード</Text>
              <TextInput
                style={s.input}
                value={password}
                onChangeText={setPassword}
                placeholder="WiFiのパスワードを入力"
                secureTextEntry
                autoCapitalize="none"
                autoCorrect={false}
              />
              <TouchableOpacity
                style={[s.button, status === "configuring" && s.buttonDisabled]}
                onPress={sendWiFiConfig}
                disabled={status === "configuring"}
              >
                {status === "configuring" ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={s.buttonText}>WiFi設定を送信</Text>
                )}
              </TouchableOpacity>
            </View>
          )}
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ---- ホーム画面 ----
  return (
    <SafeAreaView style={s.root}>
      <ScrollView contentContainerStyle={s.wrap}>
        <Text style={s.title}>おもちゃ設定</Text>

        {statusMessage ? (
          <View style={s.statusBox}>
            <Text style={s.statusText}>{statusMessage}</Text>
          </View>
        ) : null}

        {/* 未接続時: スキャン */}
        {status === "disconnected" && (
          <>
            <TouchableOpacity style={s.button} onPress={startScan}>
              <Text style={s.buttonText}>デバイスをスキャン</Text>
            </TouchableOpacity>

            {bleDevices.length > 0 && (
              <View style={s.section}>
                <Text style={s.subtitle}>見つかったデバイス</Text>
                {bleDevices.map((item) => (
                  <TouchableOpacity
                    key={item.id}
                    style={s.deviceItem}
                    onPress={() => connectToDevice(item)}
                  >
                    <View>
                      <Text style={s.deviceName}>{item.name}</Text>
                      <Text style={s.deviceSub}>タップして接続</Text>
                    </View>
                    <Text style={s.chevron}>›</Text>
                  </TouchableOpacity>
                ))}
              </View>
            )}
          </>
        )}

        {/* スキャン中 */}
        {status === "scanning" && (
          <View style={s.center}>
            <ActivityIndicator size="large" color="#007AFF" />
            <TouchableOpacity style={s.buttonSecondary} onPress={stopScan}>
              <Text style={s.buttonTextSecondary}>スキャン停止</Text>
            </TouchableOpacity>
          </View>
        )}

        {/* 接続中 */}
        {status === "connecting" && (
          <View style={s.center}>
            <ActivityIndicator size="large" color="#007AFF" />
            <Text style={s.loadingText}>接続中...</Text>
          </View>
        )}

        {/* 登録済みデバイス（常に最下部に表示） */}
        {registeredDevices.length > 0 && (
          <View style={[s.section, s.registeredSection]}>
            <Text style={s.subtitle}>登録済みデバイス</Text>
            {registeredDevices.map((device) => (
              <TouchableOpacity
                key={device.device_id}
                style={s.deviceItem}
                onPress={() => {
                  setDeviceId(device.device_id);
                  openDeviceSettings();
                }}
              >
                <View>
                  <Text style={s.deviceName}>{device.device_name || device.device_id}</Text>
                  <Text style={s.deviceSub}>
                    キャラクター: {currentCharacterLabel(device)}
                  </Text>
                </View>
                <Text style={s.chevron}>›</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  root:                  { flex: 1, backgroundColor: "#f5f5f5" },
  wrap:                  { padding: 20, gap: 16 },
  title:                 { fontSize: 24, fontWeight: "700", marginBottom: 8 },
  subtitle:              { fontSize: 16, fontWeight: "600", marginBottom: 8, color: "#333" },
  section:               { gap: 8 },
  registeredSection:     { marginTop: 24, paddingTop: 24, borderTopWidth: 2, borderTopColor: "#ccc" },
  statusBox:             { backgroundColor: "#e3f2fd", padding: 12, borderRadius: 8 },
  statusText:            { fontSize: 14, color: "#1976d2" },
  button:                { backgroundColor: "#007AFF", padding: 16, borderRadius: 12, alignItems: "center" },
  buttonDisabled:        { backgroundColor: "#999" },
  buttonText:            { color: "#fff", fontSize: 16, fontWeight: "600" },
  buttonSecondary:       { backgroundColor: "#fff", padding: 14, borderRadius: 12, alignItems: "center", borderWidth: 1, borderColor: "#ddd" },
  buttonTextSecondary:   { color: "#666", fontSize: 16 },
  deviceItem:            { backgroundColor: "#fff", padding: 16, borderRadius: 12, borderWidth: 1, borderColor: "#e0e0e0", flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  deviceName:            { fontSize: 15, fontWeight: "600" },
  deviceSub:             { fontSize: 12, color: "#888", marginTop: 2 },
  center:                { alignItems: "center", gap: 16, marginTop: 20 },
  loadingText:           { fontSize: 16, color: "#666" },
  form:                  { gap: 12 },
  label:                 { fontSize: 14, fontWeight: "500", color: "#333" },
  input:                 { backgroundColor: "#fff", padding: 14, borderRadius: 8, borderWidth: 1, borderColor: "#ddd", fontSize: 16 },
  chevron:               { fontSize: 20, color: "#999" },
  // ヘッダー
  header:                { flexDirection: "row", alignItems: "center", padding: 16, gap: 12, backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#e0e0e0" },
  headerTitle:           { fontSize: 18, fontWeight: "600" },
  back:                  { fontSize: 16, color: "#007AFF" },
  deviceIdText:          { fontSize: 12, color: "#999", marginBottom: 4 },
  // デバイス設定画面
  settingRow:            { backgroundColor: "#fff", padding: 16, borderRadius: 12, borderWidth: 1, borderColor: "#e0e0e0", flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  settingLabel:          { fontSize: 15, fontWeight: "600" },
  settingValue:          { fontSize: 13, color: "#666", marginTop: 2 },
  // キャラクター選択画面
  characterItem:         { backgroundColor: "#fff", padding: 16, borderRadius: 12, borderWidth: 1, borderColor: "#e0e0e0", marginBottom: 8 },
  characterItemSelected: { borderColor: "#007AFF", backgroundColor: "#f0f7ff" },
  characterRow:          { flexDirection: "row", alignItems: "center", gap: 12 },
  radio:                 { width: 20, height: 20, borderRadius: 10, borderWidth: 2, borderColor: "#ccc" },
  radioSelected:         { borderColor: "#007AFF", backgroundColor: "#007AFF" },
  characterLabel:        { fontSize: 15, fontWeight: "500" },
  characterLabelSelected:{ color: "#007AFF", fontWeight: "600" },
  characterDesc:         { fontSize: 12, color: "#888", marginTop: 2 },
  sectionHeader:         { fontSize: 13, fontWeight: "700", color: "#555", marginTop: 12, marginBottom: 6, textTransform: "uppercase" },
  // 削除ボタン
  deleteButton:          { marginTop: 24, padding: 16, borderRadius: 12, borderWidth: 1, borderColor: "#ff3b30", alignItems: "center" as const },
  deleteButtonText:      { color: "#ff3b30", fontSize: 16, fontWeight: "600" as const },
  // 会話ログ
  emptyText:             { fontSize: 14, color: "#999" },
  msgBubble:             { padding: 12, borderRadius: 12, maxWidth: "85%" },
  msgUser:               { backgroundColor: "#007AFF", alignSelf: "flex-end" },
  msgAssistant:          { backgroundColor: "#fff", borderWidth: 1, borderColor: "#e0e0e0", alignSelf: "flex-start" },
  msgRole:               { fontSize: 11, color: "#888", marginBottom: 4 },
  msgContent:            { fontSize: 14, color: "#333" },
  msgTime:               { fontSize: 10, color: "#aaa", marginTop: 4, textAlign: "right" },
});
