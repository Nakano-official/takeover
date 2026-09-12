// M5Stack Basic / M5Stack-Core-ESP32 / M5Unified
// USB only. Protocol: SUMMARY <count> <latest>\n, ERROR\n, TEST\n
#include <M5Unified.h>
#include <stdlib.h>
#include <string.h>

char line[80];
size_t used = 0;
bool overflowed = false, haveData = false, online = false, unacked = false;
unsigned long lastReceived = 0;
long count = 0, latest = -1;

void draw() {
  M5.Display.fillScreen(!online ? TFT_NAVY : unacked ? TFT_RED : TFT_DARKGREEN);
  M5.Display.setTextColor(TFT_WHITE);
  M5.Display.setTextSize(2);
  M5.Display.setCursor(10, 12);
  M5.Display.println("USB VACANCY v1");
  M5.Display.println();
  if (!online) {
    M5.Display.println("WAITING FOR PC / GAS");
    if (haveData) M5.Display.printf("Last count: %ld\n", count);
  } else {
    M5.Display.printf("%ld open\n\n", count);
    M5.Display.println(unacked ? "NEW! Press A" : "ack / waiting");
  }
}

bool readNumber(char*& p, long& value) {
  if (*p < '0' || *p > '9') return false;
  value = 0;
  while (*p >= '0' && *p <= '9') {
    int digit = *p++ - '0';
    if (value > (2147483647L - digit) / 10) return false;
    value = value * 10 + digit;
  }
  return true;
}

void playNotificationMelody() {
  // ドレミファソラシド・ドシラソファミレド（C4→C5→C4）
  const uint16_t notes[] = {
    262, 294, 330, 349, 392, 440, 494, 523,
    523, 494, 440, 392, 349, 330, 294, 262
  };
  M5.Speaker.setVolume(150);
  for (size_t i = 0; i < sizeof(notes) / sizeof(notes[0]); ++i) {
    M5.Speaker.tone(notes[i], 130);
    delay(155);
  }
}

void receiveLine() {
  if (!strcmp(line, "ERROR")) { online = false; draw(); return; }
  if (!strcmp(line, "TEST")) {
    M5.Display.fillScreen(TFT_DARKGREEN);
    M5.Display.setCursor(10, 12);
    M5.Display.println("USB TEST OK");
    M5.Speaker.tone(2000, 150);
    Serial.println("TEST OK");
    return;
  }
  if (strncmp(line, "SUMMARY ", 8)) return;
  char* p = line + 8;
  long nextCount, nextLatest;
  if (!readNumber(p, nextCount) || *p++ != ' ' ||
      !readNumber(p, nextLatest) || *p != '\0') return;
  if (haveData && nextLatest > latest) {
    unacked = true;
    playNotificationMelody();
  }
  count = nextCount;
  latest = nextLatest;
  haveData = online = true;
  lastReceived = millis();
  draw();
  Serial.println("OK");
}

void setup() {
  auto cfg = M5.config();
  M5.begin(cfg);
  Serial.begin(115200);
  M5.Display.setRotation(1);
  M5.Display.setBrightness(128);
  M5.Speaker.setVolume(150);
  draw();
  Serial.println("USB READY");
}

void loop() {
  M5.update();
  for (int n = 0; n < 128 && Serial.available(); ++n) {
    char ch = Serial.read();
    if (ch == '\n') {
      line[used] = '\0';
      if (!overflowed) receiveLine();
      used = 0;
      overflowed = false;
    } else if (ch != '\r') {
      if (used < sizeof(line) - 1) line[used++] = ch;
      else overflowed = true;
    }
  }
  if (M5.BtnA.wasPressed()) { unacked = false; draw(); }
  if (online && millis() - lastReceived > 90000) { online = false; draw(); }
  delay(5);
}
