/**
 * 架空データで画面を組み立て、ブラウザで開ける HTML に書き出す（D51・ヘルプ撮影の土台）
 *
 *     node tools/help-shots/render.js
 *     → tools/help-shots/out/student-home.html など（ブラウザで直接開ける）
 *
 * ■ 何をしているか
 *   1. 検証ハーネスに架空データ（demo-data.js）を入れ、時刻を NOW に固定する
 *   2. src/*.html のテンプレート（<?= ?> / <?!= ?>）を展開する。ナビとヘルプのボタンは
 *      本物の renderChrome_ で作る
 *   3. 画面が読み込み時に呼ぶサーバー関数（getTimetable など）を**本物のコードで先に実行**し、
 *      結果を HTML に埋め込む。google.script.run はその結果を返す偽物に差し替える
 *   → サーバーへは一切つながず、本番と同じロジックで描いた画面が手元で開ける。
 *
 * ■ できないこと
 *   - ボタンを押したときの書き込み（欠勤の登録・代行に入る等）は「成功した」と返すだけ。
 *     画面は変わらない。撮りたい状態は demo-data.js の側で作る
 *   - ナビのリンク先は example.invalid（押しても移動しない）
 *
 * out/ は .gitignore 済み。架空データしか入らないが、成果物は撮った画像の方なので置かない。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DEMO = require('./demo-data');

// ── 時刻を NOW に固定する ──────────────────────────────────
// ハーネスの時刻ヘルパー（todayJst_ の差し替え等）は Node 側の Date を、
// 読み込んだ GAS のコード（締切判定など）は vm の中の Date を使う。両方を同じ時刻にする。
function fixedDate(RealDate, nowMs) {
  function FakeDate() {
    const args = Array.prototype.slice.call(arguments);
    const d = args.length ? new (Function.prototype.bind.apply(RealDate, [null].concat(args)))()
      : new RealDate(nowMs);
    Object.setPrototypeOf(d, FakeDate.prototype);
    return d;
  }
  FakeDate.prototype = Object.create(RealDate.prototype);
  FakeDate.prototype.constructor = FakeDate;
  FakeDate.now = function () { return nowMs; };
  FakeDate.UTC = RealDate.UTC;
  FakeDate.parse = RealDate.parse;
  return FakeDate;
}
const NOW_MS = DEMO.NOW.getTime();
global.Date = fixedDate(Date, NOW_MS);

const { Harness } = require('../gas-harness');

const SRC = path.join(__dirname, '..', '..', 'src');
const OUT = path.join(__dirname, 'out');

const h = new Harness();
h.stub({
  Date: fixedDate(h.value('Date'), NOW_MS),
  // code.js の getAppUrl_ が使う（ナビのリンク先。手元では押しても移動しない）
  ScriptApp: { getService: function () { return { getUrl: function () { return 'https://example.invalid/app'; } }; } },
  // include() と renderChrome_ のヘルプが使う。中身はテンプレートとして評価しない（GAS と同じ）
  HtmlService: {
    createHtmlOutputFromFile: function (name) {
      const text = fs.readFileSync(path.join(SRC, name + '.html'), 'utf8');
      return { getContent: function () { return text; } };
    },
  },
});
h.load(['Constants.gs', 'Util.gs', 'Terms.gs', 'Vacancy.gs', 'Input.gs', 'Setup.js', 'code.js', 'Identity.gs']);
const G = h.G;

/** 画面を見る人に切り替える（本物の getCurrentUser_ が contacts から引く） */
function viewAs(staffId) {
  const s = h.row('staffs', 'staff_id', staffId);
  h.setUser({ staff_id: staffId, name: s.name, role: s.role, email: staffId.toLowerCase() + '@example.jp' });
  return G.getCurrentUser_();
}

// ── 画面が読み込み時に呼ぶサーバー関数 ──────────────────────
// 引数ごとに結果を変えるもの（回答画面の欠員・ヘルプの話題）は 'name|引数' のキーで持つ。
function precompute(pages, params) {
  const out = {};
  const tryPut = function (key, fn) {
    try { out[key] = JSON.parse(JSON.stringify(fn())); } catch (e) { /* その人には呼べない関数 */ }
  };
  tryPut('getTimetable', function () { return G.getTimetable(null); });
  tryPut('getMyCourses', function () { return G.getMyCourses(); });
  tryPut('getOpenVacancies', function () { return G.getOpenVacancies(); });
  tryPut('getVacanciesForManage', function () { return G.getVacanciesForManage(); });
  tryPut('getInputData', function () { return G.getInputData(null); });
  if (params.vacancy) {
    tryPut('getVacancyForRespond|' + params.vacancy, function () { return G.getVacancyForRespond(params.vacancy); });
  }
  Object.keys(h.value('HELP_TOPICS')).forEach(function (key) {
    tryPut('getHelp|' + key, function () { return G.getHelp(key); });
  });
  // 欠勤連絡の「登録」を押した後の画面を撮るため、登録の返事も本物で作る。
  // データを書き換えるので**最後に**呼ぶ（renderPage が画面ごとにデータを入れ直す）
  if (pages.indexOf('absence') !== -1 && params.course) {
    tryPut('submitAbsence|' + params.course, function () {
      return G.submitAbsence(params.course, params.date, true);
    });
  }
  return out;
}

// google.script.run の偽物。先に計算した結果を少し遅らせて返す（本物と同じく非同期）
function gasStub(responses) {
  return '<script>(function () {\n' +
    '  var R = ' + JSON.stringify(responses).replace(/</g, '\\u003c') + ';\n' +
    '  function runner(ok, ng) {\n' +
    '    return new Proxy({}, { get: function (_, name) {\n' +
    '      if (name === "withSuccessHandler") return function (f) { return runner(f, ng); };\n' +
    '      if (name === "withFailureHandler") return function (f) { return runner(ok, f); };\n' +
    '      if (name === "withUserObject") return function () { return runner(ok, ng); };\n' +
    '      return function () {\n' +
    '        var arg = arguments.length ? String(arguments[0]) : "";\n' +
    '        var key = (name + "|" + arg) in R ? name + "|" + arg : name;\n' +
    '        var res = key in R ? JSON.parse(JSON.stringify(R[key])) : { ok: true };\n' +
    '        setTimeout(function () { if (ok) ok(res); }, 30);\n' +
    '      };\n' +
    '    } });\n' +
    '  }\n' +
    '  window.google = { script: { run: runner(null, null) } };\n' +
    '})();</script>';
}

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * GAS の HtmlTemplate 相当。<?= x ?> はエスケープして、<?!= x ?> はそのまま出す。
 * <? 文 ?>（出力なし）は src/ で使っていないので受け付けない（使い始めたらここを足す）。
 */
function evaluate(template, scope) {
  Object.keys(scope).forEach(function (k) { h.context[k] = scope[k]; });
  return template.replace(/<\?(!?=)?([\s\S]*?)\?>/g, function (all, mode, code) {
    if (!mode) throw new Error('出力なしのスクリプトレットには未対応です: ' + all.slice(0, 40));
    const v = vm.runInContext('(' + code.trim() + ')', h.context, { filename: 'template' });
    return mode === '!=' ? String(v == null ? '' : v) : escapeHtml(v);
  });
}

function renderPage(viewerKey, pageKey, params) {
  DEMO.seed(h);   // 画面ごとに入れ直す（前の画面で書き込んだもの＝欠勤の登録などを持ち越さない）
  const user = viewAs(DEMO.VIEWERS[viewerKey]);
  const config = h.value('PAGES')[pageKey];
  const html = evaluate(fs.readFileSync(path.join(SRC, config.file + '.html'), 'utf8'), {
    user: user,
    params: params || {},
    pageKey: pageKey,
    appUrl: G.getAppUrl_(),
    chrome: G.renderChrome_(config, pageKey, user),
  });
  const stub = gasStub(precompute([pageKey], params || {}));
  // 画面のスクリプトより前に差し込む（読み込み直後に google.script.run を呼ぶため）
  return html.replace(/<head>/i, '<head>\n' + stub);
}

// 書き出す画面（ヘルプで写す画面）。ファイル名 → [見る人, page, パラメータ]
const SHOTS = {
  'student-home': ['student', 'home', {}],
  'student-absence': ['student', 'absence', { course: 'C40', date: DEMO.WEEK['木'] }],
  'student-absence-late': ['student', 'absence', { course: 'C12', date: DEMO.WEEK['火'] }],
  'student-vacancies': ['student', 'vacancies', {}],
  'candidate-respond': ['candidate', 'respond', { vacancy: 'V005' }],
  'staff-home': ['staff', 'home', {}],
  'staff-manage': ['staff', 'manage', {}],
  'staff-input': ['staff', 'input', {}],
  'staff-vacancies': ['staff', 'vacancies', {}],
};

function main() {
  fs.mkdirSync(OUT, { recursive: true });
  Object.keys(SHOTS).forEach(function (name) {
    const s = SHOTS[name];
    const html = renderPage(s[0], s[1], s[2]);
    fs.writeFileSync(path.join(OUT, name + '.html'), html);
    console.log('✅ ' + path.relative(process.cwd(), path.join(OUT, name + '.html')));
  });
  console.log('\nブラウザで開いて確認できます（日時は ' + DEMO.NOW.toLocaleString('ja-JP') + ' に固定）。');
}

if (require.main === module) main();

module.exports = { main, renderPage, SHOTS, OUT };
