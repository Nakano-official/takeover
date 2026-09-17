/**
 * 画面（HTML）の中の JavaScript が「存在しないものを呼んでいないか」を調べる。
 *
 *     node tools/check-pages.js
 *
 * `check-syntax.js` は構文しか見ないので、**未定義の関数呼び出しは素通りする**。
 * これは画面を開くまで分からず、しかも `buildForm()` のような描画関数の中で起きると
 * **画面が「読み込み中…」のまま固まる**（例外は握られず、見た目には何も出ない）。
 * 2026-09-17 に `input.html` で `escapeAttr` が未定義のまま呼ばれ、実際にこれが起きた。
 *
 * 見るのは2つ。
 *   1. HTML内で呼んでいる関数が、その HTML の中か既知のグローバルに在るか
 *   2. `google.script.run.〇〇()` の 〇〇 が `src/*.gs` / `src/*.js` に在るか
 *      （サーバー関数名のタイプミスは、押した瞬間にしか分からない）
 *
 * **検出できないこと**：変数の未定義、引数の個数、実行時の型、DOM 要素の有無。
 * 構文解析器は使わず、文字列とコメントを取り除いたうえでの走査なので、完全ではない。
 * 迷ったら**通す**側に倒してある（誤検知で止めるより、拾える分を拾う）。
 */
const fs = require('fs');
const path = require('path');

const SRC_DIR = path.join(__dirname, '..', 'src');

// ブラウザと GAS クライアントの既知グローバル。ここに無いものを「未定義」と言う。
const KNOWN_GLOBALS = new Set([
  // 構文・制御
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'function', 'do', 'else',
  // 組み込み
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Date', 'Math', 'JSON', 'RegExp',
  'Error', 'Promise', 'Set', 'Map', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  // ブラウザ
  'alert', 'confirm', 'prompt', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'requestAnimationFrame', 'fetch', 'FileReader', 'Blob', 'URL', 'FormData', 'Event',
  'document', 'window', 'console', 'location', 'history', 'navigator', 'localStorage',
  // GAS クライアント
  'google',
]);

/**
 * 正規表現リテラルの開始かどうか（除算の `/` と見分ける）。
 *
 * ここを雑にすると `/'/g` のような**クォートを含む正規表現**を文字列の開始と誤認し、
 * そこから先の解析が丸ごとずれる（実際に terms.html で全定義を見失った）。
 * 直前の非空白文字で判定する古典的なヒューリスティック。
 */
function regexCanFollow(out) {
  const prev = out.replace(/\s+$/, '').slice(-1);
  if (!prev) return true;
  if ('(,=:[!&|?{};+-*%~^<>'.indexOf(prev) !== -1) return true;
  return /\b(return|typeof|case|new|delete|void|do|else)$/.test(out.replace(/\s+$/, ''));
}

/** 文字列リテラル・テンプレート・正規表現・コメントを空白に潰す（識別子の誤検出を防ぐ） */
function stripLiterals(code) {
  let out = '';
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    const next = code[i + 1];
    if (c === '/' && next === '/') {
      while (i < code.length && code[i] !== '\n') { out += ' '; i++; }
      continue;
    }
    if (c === '/' && next === '*') {
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) {
        out += code[i] === '\n' ? '\n' : ' '; i++;
      }
      out += '  '; i += 2;
      continue;
    }
    if (c === '/' && regexCanFollow(out)) {
      out += ' '; i++;
      let inClass = false;
      while (i < code.length) {
        if (code[i] === '\\') { out += '  '; i += 2; continue; }
        if (code[i] === '[') inClass = true;
        else if (code[i] === ']') inClass = false;
        else if (code[i] === '/' && !inClass) break;
        else if (code[i] === '\n') break;      // 行をまたぐ正規表現は無い＝除算だった
        out += ' '; i++;
      }
      out += ' '; i++;
      while (i < code.length && /[gimsuy]/.test(code[i])) { out += ' '; i++; }
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      out += ' '; i++;
      while (i < code.length && code[i] !== quote) {
        if (code[i] === '\\') { out += '  '; i += 2; continue; }
        out += code[i] === '\n' ? '\n' : ' '; i++;
      }
      out += ' '; i++;
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** その塊の中で「名前が用意されている」もの（宣言・引数・代入）を集める */
function declaredNames(code) {
  const names = new Set();
  const add = (m) => { if (m) names.add(m); };

  // function 宣言・式
  for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // var/let/const（関数代入も含む）
  for (const m of code.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)/g)) add(m[1]);
  // 引数リスト（function (a, b) と (a, b) => の両方）
  for (const m of code.matchAll(/function\s*[A-Za-z_$\w]*\s*\(([^)]*)\)/g)) {
    m[1].split(',').forEach((a) => add(a.trim().split(/[=\s]/)[0]));
  }
  for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g)) {
    m[1].split(',').forEach((a) => add(a.trim().split(/[=\s]/)[0]));
  }
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*=>/g)) add(m[1]);
  // catch (e)
  for (const m of code.matchAll(/catch\s*\(\s*([A-Za-z_$][\w$]*)/g)) add(m[1]);
  return names;
}

/** 呼び出している名前（`.foo(` のようなメソッド呼び出しは除く） */
function calledNames(code) {
  const names = new Set();
  for (const m of code.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) names.add(m[2]);
  return names;
}

/** google.script.run のチェーン末尾にあるサーバー関数名 */
function serverCalls(code) {
  const names = new Set();
  // google.script.run ... .name(  の name を拾う（間に with*Handler が挟まる）
  for (const m of code.matchAll(/google\s*\.\s*script\s*\.\s*run([\s\S]{0,400}?)\.([A-Za-z_$][\w$]*)\s*\(/g)) {
    const tail = m[2];
    if (/^with[A-Z]/.test(tail)) continue;   // withSuccessHandler 等は GAS 側の API
    names.add(tail);
  }
  return names;
}

/** HTML の <script> 本文を1つに連結する（テンプレート構文は識別子へ置換） */
function scriptOf(html) {
  let out = '';
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    out += m[1] + '\n';
  }
  // <?= x ?> / <?!= x ?> / <? ... ?> は JavaScript ではないので潰す
  return out.replace(/<\?[\s\S]*?\?>/g, '0');
}

// ── サーバー側の関数名を集める ───────────────────────────────
const serverFunctions = new Set();
fs.readdirSync(SRC_DIR)
  .filter((f) => f.endsWith('.gs') || f.endsWith('.js'))
  .forEach((f) => {
    const code = stripLiterals(fs.readFileSync(path.join(SRC_DIR, f), 'utf8'));
    for (const m of code.matchAll(/function\s+([A-Za-z_$][\w$]*)/g)) serverFunctions.add(m[1]);
  });

// ── 各 HTML を見る ───────────────────────────────────────────
const pages = fs.readdirSync(SRC_DIR).filter((f) => f.endsWith('.html')).sort();
let problems = 0;

console.log('===== 画面の呼び出し先チェック（' + pages.length + '件）=====');

pages.forEach((file) => {
  const html = fs.readFileSync(path.join(SRC_DIR, file), 'utf8');
  const raw = scriptOf(html);
  if (!raw.trim()) return;

  const code = stripLiterals(raw);
  const declared = declaredNames(code);
  const found = [];

  calledNames(code).forEach((name) => {
    if (declared.has(name)) return;
    if (KNOWN_GLOBALS.has(name)) return;
    found.push('未定義の関数を呼んでいます: ' + name + '()');
  });

  serverCalls(code).forEach((name) => {
    if (serverFunctions.has(name)) return;
    found.push('サーバー関数が見つかりません: google.script.run.' + name + '()');
  });

  if (found.length) {
    problems += found.length;
    console.log('\n❌ ' + file);
    found.sort().forEach((f) => console.log('   - ' + f));
  }
});

if (problems === 0) {
  console.log('✅ 未定義の呼び出しはありません');
  process.exitCode = 0;
} else {
  console.log('\n❌ ' + problems + ' 件。画面を開くまで気づけない種類なので、push 前に直すこと。');
  process.exitCode = 1;
}
