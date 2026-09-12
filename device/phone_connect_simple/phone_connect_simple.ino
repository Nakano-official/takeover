/*
 * M5Stack Basic: smartphone connection test.
 * Board: M5Stack-Core-ESP32. Library: M5Unified.
 * Always starts its own Wi-Fi. No saved settings or GAS connection needed.
 */
#include <M5Unified.h>
#include <WiFi.h>
#include <WebServer.h>

const char* AP_NAME = "M5-Simple";
const char* AP_PASSWORD = "12345678";
WebServer server(80);
unsigned long testCount = 0;

const char PAGE[] = R"HTML(
<!doctype html><html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>M5 接続テスト</title></head>
<body style="font-family:sans-serif;padding:24px">
<h1>M5Stackに接続できました</h1>
<p>下のボタンを押すと、本体の画面が緑に変わります。</p>
<form method="post" action="/test">
<button style="font-size:22px;padding:16px">本体の画面を緑にする</button>
</form><p>この画面はスマホとの接続確認用です。</p>
</body></html>
)HTML";

void showScreen(bool received) {
  M5.Display.fillScreen(received ? TFT_DARKGREEN : TFT_NAVY);
  M5.Display.setTextColor(TFT_WHITE);
  M5.Display.setTextSize(2);
  M5.Display.setCursor(10, 12);
  M5.Display.println("PHONE TEST v1");
  M5.Display.println();
  M5.Display.printf("WiFi: %s\n", AP_NAME);
  M5.Display.printf("Pass: %s\n", AP_PASSWORD);
  M5.Display.println("http://192.168.4.1");
  M5.Display.println();
  if (received) {
    M5.Display.printf("PHONE OK! Count: %lu\n", testCount);
  } else {
    M5.Display.println("Connect your phone");
  }
}

void setup() {
  auto cfg = M5.config();
  M5.begin(cfg);
  Serial.begin(115200);
  M5.Display.setRotation(1);
  M5.Display.setBrightness(128);

  WiFi.mode(WIFI_AP);
  if (!WiFi.softAPConfig(IPAddress(192, 168, 4, 1),
                         IPAddress(192, 168, 4, 1),
                         IPAddress(255, 255, 255, 0)) ||
      !WiFi.softAP(AP_NAME, AP_PASSWORD)) {
    M5.Display.fillScreen(TFT_RED);
    M5.Display.setTextColor(TFT_WHITE);
    M5.Display.setTextSize(2);
    M5.Display.setCursor(10, 12);
    M5.Display.println("WiFi start failed");
    Serial.println("WiFi start failed; reset to retry");
    return;
  }

  server.on("/", HTTP_GET, []() {
    server.send(200, "text/html; charset=utf-8", PAGE);
  });
  server.on("/test", HTTP_POST, []() {
    ++testCount;
    showScreen(true);
    Serial.printf("Phone test received: %lu\n", testCount);
    server.sendHeader("Location", "/");
    server.send(303, "text/plain", "");
  });
  server.onNotFound([]() {
    server.send(404, "text/plain", "Open http://192.168.4.1");
  });
  server.begin();
  showScreen(false);
  Serial.println("PHONE TEST v1 ready: http://192.168.4.1");
}

void loop() {
  server.handleClient();
  delay(2);
}
