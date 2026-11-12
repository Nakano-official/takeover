/**
 * サーバー関数の入口を確かめる — Node 上で実行する
 *
 *     node tools/check-entrypoints.js
 *
 * GAS では、名前が `_` で終わらないトップレベルの関数は、どの画面からでも
 * `google.script.run.関数名()` で呼べる（その画面が使っているかどうかに関係なく）。
 * Web アプリは「デプロイした人として実行」なので、呼ばれた関数はその人の権限で動く。
 *
 * そこで、`_` で終わらない関数は次のどれかであること：
 *   - 先頭で呼び出した人を確かめる（requireStaff_ / getCurrentUser_ / requireEditorRun_ /
 *     Session.getActiveUser で本人のメールを取る）
 *   - 下の ALLOW に理由つきで載っている
 * 内部でしか使わない関数は、名前を `_` で終わらせる。
 *
 * あわせて requireEditorRun_ の振る舞い（画面からの呼び出しを通さない）を Harness で確かめる。
 */
const fs = require('fs');
const path = require('path');

const SRC = path.join(__dirname, '..', 'src');

// 呼び出した人を確かめなくてよい関数（理由つき）
const ALLOW = {
  doGet: 'Web アプリの入口。中で本人を特定し、画面ごとに出し分ける',
  include: 'テンプレートの部品読み込み。返すのは src/ の HTML（画面のソースと同じもの）だけ',
  getHelp: 'ヘルプの中身。HELP_TOPICS のキーしか受け付けない（中身は公開してよいもの）',
  closeExpiredRecruits: '時間トリガーの受け口（名前で登録済み）。締切を過ぎたものを閉じるだけで、何度呼んでも結果は同じ',
  onDbSheetChange: '変更トリガーの受け口（名前で登録済み）。本人確認のキャッシュを捨てるだけ',
  keepIdentityCacheAlive: '時間トリガーの受け口（名前で登録済み）。キャッシュの寿命を延ばすだけ',
};

// 関数の先頭（この行数まで）に、呼び出した人を確かめる処理があること
const HEAD_LINES = 6;
const GUARD_RE = /requireStaff_\(|getOpenUser_\(\)|requireEditorRun_\(|getCurrentUser_\(\)|Session\.getActiveUser\(\)/;

const problems = [];
let publicCount = 0;

fs.readdirSync(SRC).filter((f) => /\.(gs|js)$/.test(f)).sort().forEach(function (file) {
  const lines = fs.readFileSync(path.join(SRC, file), 'utf8').split(/\r?\n/);
  lines.forEach(function (line, i) {
    const m = /^function ([A-Za-z0-9$]+)\s*\(/.exec(line);
    if (!m) return;
    const name = m[1];
    if (/_$/.test(name)) return;
    publicCount++;
    if (ALLOW[name]) return;
    const head = lines.slice(i + 1, i + 1 + HEAD_LINES).join('\n');
    if (!GUARD_RE.test(head)) {
      problems.push(file + ':' + (i + 1) + '  ' + name + '()  … 先頭で呼び出した人を確かめていない'
        + '（内部用なら名前を _ で終わらせる）');
    }
  });
});

Object.keys(ALLOW).forEach(function (name) {
  const found = fs.readdirSync(SRC).filter((f) => /\.(gs|js)$/.test(f)).some(function (f) {
    return new RegExp('^function ' + name + '\\s*\\(', 'm').test(fs.readFileSync(path.join(SRC, f), 'utf8'));
  });
  if (!found) problems.push('ALLOW の ' + name + ' が src/ に無い（消したなら ALLOW からも外す）');
});

// requireEditorRun_ の振る舞い
const { Harness } = require('./gas-harness');
const h = new Harness();
h.load(['Constants.gs', 'Util.gs', 'Terms.gs', 'Vacancy.gs', 'Access.gs', 'ClassCalendar.gs', 'code.js', 'Identity.gs']);
function editorRunPasses() {
  try { h.G.requireEditorRun_(); return true; } catch (e) { return false; }
}
h.deployerEmail = 'deployer@example.ac.jp';   // 画面から：実行者＝デプロイした人
h.setUser({ staff_id: 'S1', name: '学生', role: '学生', email: 'student@example.ac.jp' });
if (editorRunPasses()) problems.push('requireEditorRun_ が画面からの呼び出し（利用者≠実行者）を通している');
h.setUser({ staff_id: 'T1', name: '職員', role: '職員', email: 'staff@example.ac.jp' });
if (editorRunPasses()) problems.push('requireEditorRun_ が職員の画面からの呼び出しを通している（保守用は職員でも画面からは呼ばせない）');
h.deployerEmail = '';
h.setEmail('editor@example.ac.jp');   // エディタから実行＝利用者と実行者が同じ
if (!editorRunPasses()) problems.push('requireEditorRun_ がエディタからの実行（利用者＝実行者）を止めている');
h.setEmail('');
h.setUser(null);
if (editorRunPasses()) problems.push('requireEditorRun_ が利用者のメールが取れないときに通している');

if (problems.length) {
  console.log('❌ サーバー関数の入口に問題があります：');
  problems.forEach((p) => console.log('   - ' + p));
  process.exitCode = 1;
} else {
  console.log('✅ 画面から呼べる関数 ' + publicCount + ' 件は、すべて先頭で呼び出した人を確かめています'
    + '（理由つきの例外 ' + Object.keys(ALLOW).length + ' 件）');
}
