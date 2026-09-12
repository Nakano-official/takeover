/*
 * 欠員アラート端末（職員向け）  decisions.md D6 / 案1
 * --------------------------------------------------------------------------
 * 役割：
 *   GAS Web App を定期ポーリングし、新しい欠員を検知したら
 *   「ドレミファソラシド・ドシラソファミレドを1回＋画面を赤く点灯」で知らせる。
 *   職員が本体ボタンを押すと点灯OFF（＝確認した）。さらに新着が来たらまた1回鳴って点灯。
 *
 *   音 ＝ 新着イベント／光 ＝ 未確認の新着あり。鳴り続けない・確認したら消える。
 *
 * 対象ハード：
 *   M5Stack Basic。M5Unified を使用する。
 *   ※ 画面の日本語フォントは別途設定が要るため、表示は英数字にしてある（文字化け回避）。
 *
 * GASエンドポイント（src/Device.gs）：
 *   GET  <Web AppのURL>?device=alert&token=<DEVICE_TOKEN>
 *   応答 {"ok":true,"count":<未対応件数>,"latest":<最新の欠員連番>}
 *
 * ─── 事前準備（Arduino IDE）─────────────────────────────────────────────
 *   1. ボードマネージャで「M5Stack」(ESP32) を追加し、ボードに M5Stack-Core-ESP32 を選ぶ。
 *   2. ライブラリマネージャで「M5Unified」と「WiFiManager」(tzapu) をインストール。
 *   3. 初回起動時、スマホからWi-Fi・GAS URL・DEVICE_TOKENを設定する。
 *   4. GAS側：スクリプトプロパティ DEVICE_TOKEN を端末設定と同じ文字列にし、
 *      Web App を「アクセスできるユーザー＝全員」で（再）デプロイする。
 *      /exec の URL を初回設定画面に入力する（末尾は /exec）。
 * ------------------------------------------------------------------------ */

#include <M5Unified.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFiManager.h>

// 初回設定用アクセスポイント。パスワードは設定画面を開くためのもの（接続先Wi-Fiとは別）。
static const char* SETUP_AP_NAME = "Shift-M5Stack-Setup";
static const char* SETUP_AP_PASS = "shiftsetup";

// GASを3秒ごとに確認する。端末は電源ONの間、Wi-Fi接続状態で常時待機する。
static const unsigned long POLL_INTERVAL_MS = 3000;
static const unsigned long WIFI_RETRY_INTERVAL_MS = 10000;

Preferences preferences;
String gasUrl;
String deviceToken;

// 状態
long lastLatest   = -1;     // 前回観測した最新の欠員連番（-1＝初回未取得）
int  openCount    = 0;      // 未対応件数（表示用）
bool unacked      = false;  // 未確認の新着があるか（光ON条件）
bool wifiOk       = false;
unsigned long lastPollAt = 0;
unsigned long lastWifiRetryAt = 0;

// ─── 表示 ────────────────────────────────────────────────────────────
void drawScreen() {
  // 未確認の新着あり＝赤背景、それ以外＝濃い緑背景（遠目でも状態が分かる）
  uint16_t bg = unacked ? TFT_RED : TFT_DARKGREEN;
  M5.Display.fillScreen(bg);
  M5.Display.setTextColor(TFT_WHITE, bg);
  M5.Display.setTextDatum(top_left);

  M5.Display.setTextSize(2);
  M5.Display.setCursor(6, 6);
  M5.Display.print("VACANCY");

  // 未対応件数（大きく）
  M5.Display.setTextSize(5);
  M5.Display.setCursor(6, 36);
  M5.Display.printf("%d", openCount);
  M5.Display.setTextSize(2);
  M5.Display.print(" open");

  // 状態行
  M5.Display.setTextSize(2);
  M5.Display.setCursor(6, 95);
  if (!wifiOk) {
    M5.Display.print("WiFi...");
  } else if (unacked) {
    M5.Display.print("NEW! press btn");
  } else {
    M5.Display.print("ack / waiting");
  }
}

// ─── メロディー（新着時に1回だけ）────────────────────────────────────
void playNotificationMelody() {
  // C4 D4 E4 F4 G4 A4 B4 C5 / C5 B4 A4 G4 F4 E4 D4 C4
  static const uint16_t notes[] = {
    262, 294, 330, 349, 392, 440, 494, 523,
    523, 494, 440, 392, 349, 330, 294, 262
  };
  const uint16_t noteMs = 180;
  const uint16_t gapMs = 35;
  M5.Speaker.setVolume(180);
  for (uint16_t frequency : notes) {
    M5.Speaker.tone(frequency, noteMs);
    delay(noteMs + gapMs);
    M5.update();
  }
}

// ─── HTTP 取得 ───────────────────────────────────────────────────────
// 成功したら payload に応答本文を入れて true を返す。
bool fetchSummary(String& payload) {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  client.setInsecure();          // 端末→Googleの証明書検証は省略（内部用途）。

  String url = gasUrl + "?device=alert&token=" + deviceToken;

  HTTPClient http;
  http.setFollowRedirects(HTTPC_FORCE_FOLLOW_REDIRECTS);  // GASは302で本体へ飛ばすため必須
  http.setTimeout(15000);
  if (!http.begin(client, url)) return false;

  int code = http.GET();
  bool ok = false;
  if (code == 200) {
    payload = http.getString();
    ok = true;
  } else {
    Serial.printf("HTTP error: %d\n", code);
  }
  http.end();
  return ok;
}

// payload から "key": の直後の整数を取り出す。見つからなければ -1。
long extractLong(const String& s, const char* key) {
  String pat = String("\"") + key + "\"";
  int i = s.indexOf(pat);
  if (i < 0) return -1;
  i = s.indexOf(':', i + pat.length());
  if (i < 0) return -1;
  i++;
  while (i < (int)s.length() && (s[i] == ' ' || s[i] == '\t')) i++;
  long v = 0; bool any = false;
  while (i < (int)s.length() && s[i] >= '0' && s[i] <= '9') {
    v = v * 10 + (s[i] - '0'); i++; any = true;
  }
  return any ? v : -1;
}

// 1回ポーリングして状態を更新する。
void poll() {
  String payload;
  if (!fetchSummary(payload)) {
    Serial.println("poll failed");
    return;
  }
  if (payload.indexOf("\"ok\":true") < 0) {
    Serial.println("unauthorized or bad response: " + payload);
    return;
  }

  long count  = extractLong(payload, "count");
  long latest = extractLong(payload, "latest");
  if (count < 0 || latest < 0) {
    Serial.println("parse failed: " + payload);
    return;
  }
  openCount = (int)count;

  if (lastLatest < 0) {
    // 初回：起動時点の既存欠員では鳴らさない（最新値を基準として覚えるだけ）。
    lastLatest = latest;
  } else if (latest > lastLatest) {
    // 新しい欠員を検知 → 1回だけ鳴らして点灯。
    lastLatest = latest;
    unacked = true;
    playNotificationMelody();
  }
  drawScreen();
}

// ─── WiFi・端末設定 ───────────────────────────────────────────────────
void loadDeviceSettings() {
  gasUrl = preferences.getString("gasUrl", "");
  deviceToken = preferences.getString("deviceToken", "");
}

void configureDevice(bool forcePortal) {
  loadDeviceSettings();

  char gasUrlBuffer[256];
  char tokenBuffer[96];
  snprintf(gasUrlBuffer, sizeof(gasUrlBuffer), "%s", gasUrl.c_str());
  snprintf(tokenBuffer, sizeof(tokenBuffer), "%s", deviceToken.c_str());

  WiFiManager manager;
  WiFiManagerParameter gasUrlParam(
    "gas_url", "GAS Web App URL", gasUrlBuffer, sizeof(gasUrlBuffer));
  WiFiManagerParameter tokenParam(
    "device_token", "DEVICE_TOKEN", tokenBuffer, sizeof(tokenBuffer));
  manager.addParameter(&gasUrlParam);
  manager.addParameter(&tokenParam);
  manager.setConfigPortalTimeout(180);

  bool connected;
  if (forcePortal || gasUrl.length() == 0 || deviceToken.length() == 0) {
    M5.Display.fillScreen(TFT_NAVY);
    M5.Display.setCursor(10, 10);
    M5.Display.setTextSize(2);
    M5.Display.println("SETUP MODE");
    M5.Display.println(SETUP_AP_NAME);
    M5.Display.println("Open 192.168.4.1");
    connected = manager.startConfigPortal(SETUP_AP_NAME, SETUP_AP_PASS);
  } else {
    connected = manager.autoConnect(SETUP_AP_NAME, SETUP_AP_PASS);
  }

  if (!connected) {
    Serial.println("setup timed out; restarting");
    delay(2000);
    ESP.restart();
  }

  gasUrl = String(gasUrlParam.getValue());
  deviceToken = String(tokenParam.getValue());
  gasUrl.trim();
  deviceToken.trim();
  preferences.putString("gasUrl", gasUrl);
  preferences.putString("deviceToken", deviceToken);
}

void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) { wifiOk = true; return; }
  wifiOk = false;
  drawScreen();
  if (millis() - lastWifiRetryAt >= WIFI_RETRY_INTERVAL_MS) {
    lastWifiRetryAt = millis();
    WiFi.reconnect();
  }
  wifiOk = (WiFi.status() == WL_CONNECTED);
  drawScreen();
}

void setup() {
  auto cfg = M5.config();
  M5.begin(cfg);
  Serial.begin(115200);
  M5.Display.setRotation(1);
  preferences.begin("shift-alert", false);
  drawScreen();
  // 設定変更時はボタンAを押したまま電源を入れる。
  delay(50);
  M5.update();
  configureDevice(M5.BtnA.isPressed());
  wifiOk = WiFi.status() == WL_CONNECTED;
  drawScreen();
  poll();                 // 起動直後に1回取得（基準値を覚える）
  lastPollAt = millis();
}

void loop() {
  M5.update();

  // ボタンA：確認した → 点灯OFF
  if (M5.BtnA.wasPressed() && unacked) {
    unacked = false;
    drawScreen();
  }

  // 定期ポーリング
  if (millis() - lastPollAt >= POLL_INTERVAL_MS) {
    ensureWifi();
    poll();
    lastPollAt = millis();
  }

  delay(20);
}
