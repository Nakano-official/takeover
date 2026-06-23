/*
 * M5Stack 動作確認スケッチ（GAS連携なし・単体テスト）
 * --------------------------------------------------------------------------
 * 目的：買ったM5Stackが正しく動くかを確認するだけの最小コード。
 *   - 画面が映るか（文字・色）
 *   - ボタンが効くか（押すとカウントが増える）
 *   - ブザーが鳴るか（押すとピッと鳴る）
 *   - シリアルモニタにログが出るか
 *
 * 対象ハード：M5StickC Plus2（M5Unified を使うので Core / Core2 / ATOM 等でもほぼ動く）。
 *
 * ─── 準備（Arduino IDE）─────────────────────────────────────────────
 *   1. ボードマネージャで「M5Stack」(ESP32) を入れ、ボードに M5StickC Plus2 を選ぶ。
 *   2. ライブラリマネージャで「M5Unified」をインストール。
 *   3. このスケッチを書き込む。書き込み速度がうまくいかない時は 115200 を試す。
 *
 * ─── 使い方 ─────────────────────────────────────────────────────────
 *   - 画面に "M5 TEST" とカウントが出る。
 *   - 本体のボタンAを押す → カウント+1・背景色が変わる・ピッと鳴る。
 *   - シリアルモニタ（115200 bps）にも押下ログが出る。
 * ------------------------------------------------------------------------ */

#include <M5Unified.h>

int count = 0;

// 押すたびに切り替える背景色（動いていることが目で分かるように）
uint16_t colors[] = { TFT_BLACK, TFT_NAVY, TFT_DARKGREEN, TFT_MAROON, TFT_PURPLE };
const int NUM_COLORS = sizeof(colors) / sizeof(colors[0]);

void drawScreen() {
  uint16_t bg = colors[count % NUM_COLORS];
  M5.Display.fillScreen(bg);
  M5.Display.setTextColor(TFT_WHITE, bg);
  M5.Display.setTextDatum(top_left);

  M5.Display.setTextSize(2);
  M5.Display.setCursor(6, 6);
  M5.Display.print("M5 TEST");

  M5.Display.setTextSize(2);
  M5.Display.setCursor(6, 40);
  M5.Display.print("Count:");
  M5.Display.setTextSize(5);
  M5.Display.setCursor(6, 64);
  M5.Display.printf("%d", count);

  M5.Display.setTextSize(1);
  M5.Display.setCursor(6, 118);
  M5.Display.print("press BtnA");
}

void beep() {
  M5.Speaker.setVolume(150);   // 0-255
  M5.Speaker.tone(2000, 150);  // 2kHz を 0.15秒
}

void setup() {
  auto cfg = M5.config();
  M5.begin(cfg);
  Serial.begin(115200);
  M5.Display.setRotation(1);   // 横向き。縦がよければ 0 に変える。
  drawScreen();
  Serial.println("M5 hello_test started. Press button A.");
}

void loop() {
  M5.update();  // ボタン状態の更新（必須）

  if (M5.BtnA.wasPressed()) {
    count++;
    beep();
    drawScreen();
    Serial.printf("BtnA pressed -> count = %d\n", count);
  }

  delay(20);
}
