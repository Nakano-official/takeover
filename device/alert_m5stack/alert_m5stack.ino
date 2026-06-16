/*
 * 欠員アラート端末（職員向け）  decisions.md D6 / 案1
 * --------------------------------------------------------------------------
 * 役割：
 *   GAS Web App を定期ポーリングし、新しい欠員を検知したら
 *   「ブザー1回（約0.8秒）＋ 画面を赤く点灯（文字表示）」で職員に知らせる。
 *   職員が本体ボタンを押すと点灯OFF（＝確認した）。さらに新着が来たらまた1回鳴って点灯。
 *
 *   音 ＝ 新着イベント／光 ＝ 未確認の新着あり。鳴り続けない・確認したら消える。
 *
 * 対象ハード：
 *   M5StickC Plus2（主対象）。M5Unified を使うので M5Stack Core / Core2 等でもほぼそのまま動く。
 *   ※ 画面の日本語フォントは別途設定が要るため、表示は英数字にしてある（文字化け回避）。
 *
 * GASエンドポイント（src/Device.gs）：
 *   GET  <Web AppのURL>?device=alert&token=<DEVICE_TOKEN>
 *   応答 {"ok":true,"count":<未対応件数>,"latest":<最新の欠員連番>}
 *
 * ─── 事前準備（Arduino IDE）─────────────────────────────────────────────
 *   1. ボードマネージャで「M5Stack」(ESP32) を追加し、ボードに M5StickC Plus2 を選ぶ。
 *   2. ライブラリマネージャで「M5Unified」をインストール。
 *   3. 下の CONFIG 4項目（SSID / PASS / GAS_URL / DEVICE_TOKEN）を自分の値に書き換える。
 *   4. GAS側：スクリプトプロパティ DEVICE_TOKEN を同じ文字列で設定し、
 *      Web App を「アクセスできるユーザー＝全員」で（再）デプロイする。
 *      /exec の URL を GAS_URL に貼る（末尾は /exec）。
 * ------------------------------------------------------------------------ */

#include <M5Unified.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>

// ─── CONFIG（ここだけ自分の値に書き換える）────────────────────────────
static const char* WIFI_SSID    = "ここにWi-FiのSSID";
static const char* WIFI_PASS    = "ここにWi-Fiのパスワード";
// GAS Web App の /exec URL（末尾は /exec）。?device=... は付けない。
static const char* GAS_URL      = "https://script.google.com/macros/s/XXXXXXXX/exec";
// GAS のスクリプトプロパティ DEVICE_TOKEN と完全に同じ文字列にする。
static const char* DEVICE_TOKEN = "ここに端末用トークン";

// ポーリング間隔（ミリ秒）。短すぎるとGASの実行回数制限に近づくので30秒程度を推奨。
static const unsigned long POLL_INTERVAL_MS = 30000;
// ───────────────────────────────────────────────────────────────────

// 状態
long lastLatest   = -1;     // 前回観測した最新の欠員連番（-1＝初回未取得）
int  openCount    = 0;      // 未対応件数（表示用）
bool unacked      = false;  // 未確認の新着があるか（光ON条件）
bool wifiOk       = false;
unsigned long lastPollAt = 0;

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

// ─── ブザー（新着時に1回だけ）────────────────────────────────────────
void beepOnce() {
  M5.Speaker.setVolume(180);     // 0-255。利用者が近くにいる時の配慮で控えめ。
  M5.Speaker.tone(2000, 800);    // 2kHz を約0.8秒。自動で鳴り止む。
}

// ─── HTTP 取得 ───────────────────────────────────────────────────────
// 成功したら payload に応答本文を入れて true を返す。
bool fetchSummary(String& payload) {
  if (WiFi.status() != WL_CONNECTED) return false;

  WiFiClientSecure client;
  client.setInsecure();          // 端末→Googleの証明書検証は省略（内部用途）。

  String url = String(GAS_URL) + "?device=alert&token=" + DEVICE_TOKEN;

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
    beepOnce();
  }
  drawScreen();
}

// ─── WiFi ────────────────────────────────────────────────────────────
void ensureWifi() {
  if (WiFi.status() == WL_CONNECTED) { wifiOk = true; return; }
  wifiOk = false;
  drawScreen();
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(300);
    M5.update();  // 接続待ち中もボタンを拾えるように
  }
  wifiOk = (WiFi.status() == WL_CONNECTED);
  Serial.println(wifiOk ? "WiFi connected" : "WiFi failed");
  drawScreen();
}

void setup() {
  auto cfg = M5.config();
  M5.begin(cfg);
  Serial.begin(115200);
  M5.Display.setRotation(1);
  drawScreen();
  ensureWifi();
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
