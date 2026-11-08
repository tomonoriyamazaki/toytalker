#pragma once
// TurnReport.h — 本体側の計測（2026-11-08、ロードマップ6「本体側の計測を次の要求に添える」）。
// Lambda の中の区間（LLM・TTS）はログにあるが、本体→CloudFront・音声の受信・再生・Soniox はサーバーから見えない。
// そこで本体が数えた値を次の会話の要求の "device" に添え、会話 Lambda が trace.mjs の describeDevice で
// 1行ログの device に写す（infra/README の「Lambdaログの見方」）。**数値と決まった語だけで、文章は入れない**。
//
//   device.prev: 前のターン（要求→再生→止まるまで）。止まった理由・区間の時刻・バッファ切れ・割り込み判定の材料
//   device.stt:  この要求の発話の聞き取り（録音開始→Soniox の <end> →猶予→送信）
//
// 時刻は prev が「そのターンの sendToLambdaAndPlay の開始（t0）からの ms」、stt が「録音開始からの ms」。
// 0 は「起きなかった・届かなかった」（例: first_audio_ms=0 は返答の音声を1バイトも受けていない）。
// 本体が再起動すると前のターンの記録は消える（device.uptime_s が小さいことで分かる）。
#include <Arduino.h>
#include <math.h>
#include "AecMonitor.h"

struct TurnReport {
  bool valid = false;
  uint32_t turn = 0;
  // done（最後まで鳴らした）/ aec（声の割り込み）/ button / stream_error / connect_failed / i2s_failed
  const char* stop = "";
  uint32_t preMs = 0;        // t0 → TLS 接続を始めた（相槌の待ち・I2S の切り替え・Soniox 先行接続の開始を含む）
  uint32_t tlsMs = 0;        // TLS 接続（毎ターン張り直し。0.7.6 から証明書の検証が入った）
  bool tlsOk = false;
  uint32_t sendMs = 0;       // 要求の書き込み
  uint32_t headersMs = 0;    // t0 → 応答ヘッダーを読み終えた
  uint32_t firstAudioMs = 0; // t0 → 返答の最初の音声バイト（相槌は含まない）
  uint32_t playStartMs = 0;  // t0 → 返答の音声を最初に I2S へ渡した（溜め 0.34 秒の後。スピーカーの発声はこの数十ms後）
  uint32_t recvEndMs = 0;    // t0 → 受信の終わり（最後まで、または割り込み・失敗で止めた）
  uint32_t playEndMs = 0;    // t0 → アンプを切った
  uint32_t bargeMs = 0;      // t0 → 割り込みの判定（声: AEC の発火、ボタン: 押した時刻）。割り込みが無ければ 0
  uint32_t audioMs = 0;      // 受けた返答の音声の長さ（24kHz mono の バイト数から）
  uint32_t unplayedMs = 0;   // 止めた時点でバッファに残っていた鳴らしていない音声（最後まで鳴らせば 0）
  uint32_t underruns = 0;    // 再生中のバッファ切れ（溜め直してから再開した回数）
  uint32_t segments = 0;     // 受けた音声の区切り（tts_start）
  bool bc = false;           // このターンで相槌を鳴らした
  int rssiAvg = 0, rssiMin = 0;  // 再生中の Wi-Fi RSSI（0 は未計測）
  uint32_t wsMaxBlockMs = 0; // 受信中に Soniox の ws.loop() が止めた最長（受信を遅らせる）
  AecMonitor::Report aec;
};

struct SttReport {
  bool valid = false;
  uint32_t wsWaitMs = 0;        // 録音開始 → Soniox が使える（先行接続が間に合えば数十ms。録音開始時に未接続なら、その間の声は落ちる）
  uint32_t listenMs = 0;        // 録音開始 → 送信を決めた
  uint32_t lastTextToEndMs = 0; // 最後に文字が変わってから Soniox の最初の <end> まで（Soniox の話し終わり判定の待ち）
  uint32_t endToSendMs = 0;     // 最初の <end> → 送信を決めた（猶予 0.6 秒と、猶予中に続けた分）
  uint32_t resumes = 0;         // 猶予中に続けた回数
  uint32_t speechPeakRms = 0, gracePeakRms = 0;
  uint32_t disconnects = 0;     // 前の要求からこの要求までに Soniox が切れた回数（再生中の先行接続を含む）
  uint32_t errors = 0;          // 同じ間に Soniox が error_code を返した回数
  const char* why = "";         // quiet / no new text / stall / no grace
};

inline String turnReportJsonNumber(double v, int digits) {
  if (isnan(v) || isinf(v)) return "null";
  return String(v, digits);
}

// "prev":{…}（先頭のカンマは呼び出し側）
inline String turnReportJson(const TurnReport& r) {
  char buf[640];
  int n = snprintf(buf, sizeof(buf),
    "\"prev\":{\"turn\":%lu,\"stop\":\"%s\",\"pre_ms\":%lu,\"tls_ms\":%lu,\"tls_ok\":%d,\"send_ms\":%lu,"
    "\"headers_ms\":%lu,\"first_audio_ms\":%lu,\"play_start_ms\":%lu,\"recv_end_ms\":%lu,\"play_end_ms\":%lu,"
    "\"barge_ms\":%lu,\"audio_ms\":%lu,\"unplayed_ms\":%lu,\"underruns\":%lu,\"segments\":%lu,\"bc\":%d,"
    "\"rssi_avg\":%d,\"rssi_min\":%d,\"ws_max_block_ms\":%lu",
    (unsigned long)r.turn, r.stop, (unsigned long)r.preMs, (unsigned long)r.tlsMs, r.tlsOk ? 1 : 0,
    (unsigned long)r.sendMs, (unsigned long)r.headersMs, (unsigned long)r.firstAudioMs,
    (unsigned long)r.playStartMs, (unsigned long)r.recvEndMs, (unsigned long)r.playEndMs,
    (unsigned long)r.bargeMs, (unsigned long)r.audioMs, (unsigned long)r.unplayedMs,
    (unsigned long)r.underruns, (unsigned long)r.segments, r.bc ? 1 : 0, r.rssiAvg, r.rssiMin,
    (unsigned long)r.wsMaxBlockMs);
  String out(buf);
  if (n < 0 || n >= (int)sizeof(buf)) out = "\"prev\":{\"turn\":" + String(r.turn);  // 起きない想定。壊れた JSON は送らない
  const auto& a = r.aec;
  if (a.valid) {
    // 割り込み判定の材料。threshold と比べる（out_sustained < threshold なら、4フレーム続けて超えた場面が無い）
    snprintf(buf, sizeof(buf),
      ",\"aec_threshold\":%lu,\"aec_fired\":%d,\"aec_armed_frames\":%lu,\"aec_out_peak\":%lu,"
      "\"aec_out_sustained\":%lu,\"aec_mic_sustained\":%lu,\"aec_residual_rejects\":%lu,\"aec_clip_frames\":%lu,"
      "\"aec_recovery_frames\":%lu,\"aec_age_rejects\":%lu,\"aec_missing\":%lu,\"aec_trigger_out\":%lu,"
      "\"aec_trigger_mic\":%lu,\"aec_ref_peak\":%lu,\"aec_trigger_ref\":%lu,\"aec_retained_pct\":",
      (unsigned long)AEC_BARGE_RMS, a.fired ? 1 : 0, (unsigned long)a.armedFrames, (unsigned long)a.outPeak,
      (unsigned long)a.outSustained, (unsigned long)a.micSustained, (unsigned long)a.residualRejects,
      (unsigned long)a.clipFrames, (unsigned long)a.recoveryFrames, (unsigned long)a.ageRejects,
      (unsigned long)a.missing, (unsigned long)a.triggerOut, (unsigned long)a.triggerMic,
      (unsigned long)a.refPeak, (unsigned long)a.triggerRef);
    out += buf;
    out += turnReportJsonNumber(a.retainedPct, 1);
  }
  out += "}";
  return out;
}

// "stt":{…}（先頭のカンマは呼び出し側）
inline String sttReportJson(const SttReport& s) {
  char buf[320];
  snprintf(buf, sizeof(buf),
    "\"stt\":{\"ws_wait_ms\":%lu,\"listen_ms\":%lu,\"last_text_to_end_ms\":%lu,\"end_to_send_ms\":%lu,"
    "\"resumes\":%lu,\"speech_peak_rms\":%lu,\"grace_peak_rms\":%lu,\"disconnects\":%lu,\"errors\":%lu,\"why\":\"%s\"}",
    (unsigned long)s.wsWaitMs, (unsigned long)s.listenMs, (unsigned long)s.lastTextToEndMs,
    (unsigned long)s.endToSendMs, (unsigned long)s.resumes, (unsigned long)s.speechPeakRms,
    (unsigned long)s.gracePeakRms, (unsigned long)s.disconnects, (unsigned long)s.errors, s.why);
  return String(buf);
}
