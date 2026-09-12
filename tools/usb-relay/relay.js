const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const path = require('node:path');
const os = require('node:os');
const { summaryLine, relayUrl, isGasFrame } = require('./protocol');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const port = process.argv[2];
  if (!/^COM\d+$/.test(port || '')) throw new Error('使い方: node relay.js COM7 GAS_URL（USBテストは GAS_URL の代わりに --test）');
  const test = process.argv[3] === '--test';
  const url = test ? null : relayUrl(process.argv[3]);
  let context, pending, stopped = false;
  const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', path.join(__dirname, 'serial.ps1'), '-PortName', port],
    { windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout });
  function expect(message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending = null; reject(new Error('USB応答なし。コードとポートを確認してください。')); }, 12000);
      pending = { message, resolve: () => { clearTimeout(timer); pending = null; resolve(); },
        reject: error => { clearTimeout(timer); pending = null; reject(error); } };
    });
  }
  lines.on('line', line => {
    if (line.startsWith('USB_ERROR: ')) {
      const detail = line.slice(11);
      const message = /access.*denied/i.test(detail)
        ? `${port} を開けません。他の中継画面とArduino IDEを閉じてください。詳細: ${detail}`
        : `USBエラー: ${detail}`;
      stopped = true;
      if (pending) pending.reject(new Error(message));
      else console.error(message);
      return;
    }
    if (pending && line.trim() === pending.message) pending.resolve();
  });
  child.on('error', error => { stopped = true; if (pending) pending.reject(error); });
  child.on('exit', () => { stopped = true; if (pending) pending.reject(new Error('USB接続が終了しました。シリアルモニタを閉じて再実行してください。')); });
  child.stdin.on('error', () => { stopped = true; });
  process.once('SIGINT', () => { stopped = true; if (context) context.close().catch(() => {}); child.stdin.end(); });
  async function send(line) {
    const ack = expect('ACK');
    child.stdin.write(line + '\n');
    await ack;
  }
  try {
    await expect('READY');
    if (test) {
      await send('TEST');
      console.log('USBテスト成功。本体の USB TEST OK を確認してください。');
      return;
    }
    // 専用プロファイルをOneDriveやリポジトリの外に保存する。
    context = await chromium.launchPersistentContext(
      path.join(process.env.LOCALAPPDATA || os.tmpdir(), 'ShiftUsbRelay', 'edge-profile'),
      { channel: 'msedge', headless: false });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('開いたEdgeで大学アカウントにログインしてください。終了は Ctrl+C。');
    let lastMessage = '';
    while (!stopped && !page.isClosed()) {
      let command;
      try {
        let relayFrame;
        for (const frame of page.frames()) {
          if (!isGasFrame(frame.url())) continue;
          if (await frame.evaluate(() => window.shiftUsbRelayVersion === 1)) { relayFrame = frame; break; }
        }
        if (!relayFrame) throw new Error('大学ログインと USB欠員通知 画面を待っています。GAS更新後は画面を再読み込みしてください。');
        const result = await relayFrame.evaluate(() => window.readShiftUsbSummary());
        command = summaryLine(result);
      } catch (error) {
        if (stopped || page.isClosed()) break;
        child.stdin.write('ERROR\n');
        const message = '取得待ち：' + error.message;
        if (message !== lastMessage) console.log(message);
        lastMessage = message;
        await wait(5000);
        continue;
      }
      await send(command);
      lastMessage = `${new Date().toLocaleTimeString()} GAS取得・USB受信確認済み：${command}`;
      console.log(lastMessage);
      // サーバー呼び出しを重ねない。取得完了から30秒待つ。
      for (let i = 0; i < 30 && !stopped && !page.isClosed(); i++) await wait(1000);
    }
  } finally {
    if (!child.stdin.destroyed) {
      if (!test) child.stdin.write('ERROR\n');
      child.stdin.end();
    }
    lines.close();
    if (context) await context.close().catch(() => {});
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
