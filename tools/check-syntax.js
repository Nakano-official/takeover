/**
 * src/ 全体の構文チェック — clasp push する前に走らせる
 *
 *     node tools/check-syntax.js
 *
 * `.gs` / `.js` と、`.html` の `<script>` 内 JavaScript を構文解析だけする（実行はしない）。
 *
 * ■ なぜこれがあるか
 *   GAS は構文エラーを「push した後、その関数を呼んだとき」にしか教えてくれない。
 *   HTML 内の JS に至っては、画面を開いて操作するまで気づけない。
 *   文字列の閉じ忘れ1つのために push → エディタ → 画面操作 を往復するのは高くつく。
 *   （実際、D22 の実装中に Notify.gs の文字列リテラルが改行で分断された状態を
 *     これで検出した。GAS に上げていたら通知が飛ばなくなるまで気づけなかった。）
 *
 * ■ 検出できないこと
 *   構文だけを見る。未定義の関数・変数、GAS API の誤用、ロジックの誤りは分からない。
 *   ロジックは tools/sim-*.js、GAS 依存は GASエディタの e2e 関数が受け持つ。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC_DIR = path.join(__dirname, '..', 'src');

// テンプレートのスクリプトレット（<?= x ?> / <?!= x ?> / <? ... ?>）は JavaScript ではない。
// サーバー側で値に置き換わるので、構文チェックでは識別子1つに置き換えて評価する。
const SCRIPTLET = /<\?!?=?[\s\S]*?\?>/g;

function scriptsIn(html) {
  const out = [];
  const re = /<script>([\s\S]*?)<\/script>/g;
  var m;
  while ((m = re.exec(html)) !== null) out.push(m[1]);
  return out;
}

function checkSyntax(code, label) {
  try {
    new vm.Script(code, { filename: label });
    return null;
  } catch (e) {
    return e.message;
  }
}

const files = fs.readdirSync(SRC_DIR).sort();
var checked = 0;
const errors = [];

files.forEach(function (f) {
  const full = path.join(SRC_DIR, f);
  if (f.endsWith('.gs') || f.endsWith('.js')) {
    const err = checkSyntax(fs.readFileSync(full, 'utf8'), f);
    checked++;
    if (err) errors.push(f + ': ' + err);
  } else if (f.endsWith('.html')) {
    const blocks = scriptsIn(fs.readFileSync(full, 'utf8'));
    blocks.forEach(function (code, i) {
      const label = f + ' <script> #' + (i + 1);
      const err = checkSyntax(code.replace(SCRIPTLET, 'SCRIPTLET'), label);
      checked++;
      if (err) errors.push(label + ': ' + err);
    });
  }
});

console.log('===== src/ 構文チェック（' + checked + '件）=====');
if (errors.length === 0) {
  console.log('✅ 構文エラーはありません');
} else {
  errors.forEach(function (e) { console.log('❌ ' + e); });
  console.log('\n' + errors.length + '件の構文エラー。push 前に直してください。');
  process.exitCode = 1;
}
