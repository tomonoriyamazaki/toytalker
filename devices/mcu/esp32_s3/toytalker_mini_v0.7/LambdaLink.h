#pragma once
#include <Arduino.h>
#include <WiFiClientSecure.h>
#include <atomic>

// Lambda への TLS 接続 1 回ぶんの状態（使い方と持ち主の決まりは .ino の lambdaLinkTask の上）。
// .ino に置くと Arduino が関数の宣言をこの定義より前に作ってしまうので、ヘッダーに分けている。
enum : uint8_t { LAMBDA_LINK_GO = 1, LAMBDA_LINK_ABORT = 2 };
const uint32_t LAMBDA_LINK_MAX_IDLE_MS = 5000;  // 先に張ってからこれ以上たった接続は使わず張り直す（言い直しが続いた時）
struct LambdaLink {
  WiFiClientSecure client;
  const String* request = nullptr;       // 「送る」の前に loop() が入れる
  std::atomic<uint8_t> command{0};       // 0=まだ決まっていない
  std::atomic<bool> connected{false}, sent{false}, failed{false};
  std::atomic<bool> finished{false};     // タスクが最後に立てる。これ以降タスクは触らない
  // 計測（TurnReport）。finished を立てる前に書くので、loop はそれを見てから読む
  uint32_t connectStartMs = 0, connectMs = 0, connectedAtMs = 0, sendMs = 0;
  TaskHandle_t task = nullptr;
};
