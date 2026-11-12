/**
 * 学生への公開の切り替え（D56）の検証 — Node 上で実行する
 *
 *     node tools/sim-access.js
 *
 * 守りたいこと：
 *   1. 何も設定していない（＝この仕組みを入れる前の本番）は「公開中」
 *   2. 準備中は、学生はマイページだけ。画面だけでなくサーバー関数も止まる
 *   3. 職員はいつも通り使える。切り替えられるのも職員だけ
 *   4. 未登録の人は、準備中でも申請画面へ行ける
 */
const fs = require('fs');
const path = require('path');
const { Harness } = require('./gas-harness');

const SRC = path.join(__dirname, '..', 'src');
const h = new Harness();
// doGet が組み立てる画面を「どのファイルを開いたか」で見分けられるようにする
h.stub({
  ScriptApp: { getService: function () { return { getUrl: function () { return 'https://example.invalid/app'; } }; } },
  HtmlService: {
    XFrameOptionsMode: { DEFAULT: 'DEFAULT' },
    createHtmlOutputFromFile: function (name) {
      const text = fs.readFileSync(path.join(SRC, name + '.html'), 'utf8');
      return { getContent: function () { return text; } };
    },
    createTemplateFromFile: function (name) {
      const t = { file: name };
      t.evaluate = function () {
        const out = { file: t.file, chrome: t.chrome };
        out.setTitle = function () { return out; };
        out.addMetaTag = function () { return out; };
        out.setXFrameOptionsMode = function () { return out; };
        return out;
      };
      return t;
    },
    createHtmlOutput: function (html) {
      const out = { file: '(message)', html: html };
      out.setTitle = function () { return out; };
      out.addMetaTag = function () { return out; };
      out.setXFrameOptionsMode = function () { return out; };
      return out;
    },
  },
});
h.load(['Constants.gs', 'Util.gs', 'Terms.gs', 'Vacancy.gs', 'Access.gs', 'ClassCalendar.gs', 'Profile.gs',
  'Identity.gs', 'code.js']);
const G = h.G;

const STAFF = { staff_id: 'T1', name: '職員 花子', role: '職員', email: 'staff@example.ac.jp' };
const STUDENT = { staff_id: 'S1', name: '学生 太郎', role: '学生', email: 'student@example.ac.jp' };

function setup() {
  h.reset();
  h.add('staffs', { staff_id: 'T1', name: STAFF.name, role: '職員' });
  h.add('staffs', { staff_id: 'S1', name: STUDENT.name, role: '学生', skills: 'テイク' });
  h.add('contacts', { staff_id: 'T1', name: STAFF.name, email: STAFF.email });
  h.add('contacts', { staff_id: 'S1', name: STUDENT.name, email: STUDENT.email, phone: '090-1111-2222' });
}
const as = (u) => h.setUser(u);
const pageOf = (page) => G.doGet({ parameter: page ? { page: page } : {} }).file;
// 例外のメッセージ（投げなければ null）
const errOf = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const CLOSED = h.value('CLOSED_MESSAGE');

console.log('===== 学生への公開の切り替え（D56）=====');

h.section('1) 何も設定していなければ公開中');
setup();
as(STAFF);
h.check(G.getStudentAccess().open === true, '職員の画面には「公開中」と出る');
as(STUDENT);
h.check(pageOf('home') === 'home', '学生がシフト確認を開ける');
h.check(errOf(() => G.getMyCourses()) === null, '学生が欠勤連絡のコマを読める');

h.section('2) 切り替えられるのは職員だけ');
as(STUDENT);
h.check(/職員権限/.test(errOf(() => G.setStudentAccess(false)) || ''), '学生は準備中にできない');
h.check(/職員権限/.test(errOf(() => G.getStudentAccess()) || ''), '学生は状態を読む関数も呼べない');
as(STAFF);
h.check(/不正/.test(errOf(() => G.setStudentAccess('false')) || ''), 'true/false 以外は受け付けない');
h.check(G.setStudentAccess(false).open === false && G.getStudentAccess().open === false, '職員が準備中にできる');

h.section('3) 準備中：学生はマイページだけ');
as(STUDENT);
['home', 'absence', 'vacancies', 'respond'].forEach(function (p) {
  h.check(pageOf(p) === 'closed', '?page=' + p + ' は準備中の画面になる');
});
h.check(pageOf('') === 'closed', 'ページ指定なしも準備中の画面');
h.check(pageOf('mypage') === 'mypage', 'マイページは開ける');
h.check(pageOf('approvals') === 'closed', '職員の画面を指定しても準備中の画面（中身は出ない）');
const chrome = G.renderChrome_({ file: 'mypage', title: 'マイページ' }, 'mypage', G.getCurrentUser_());
h.check(!/\?page=home"/.test(chrome) && !/\?page=absence"/.test(chrome), 'ナビに使えない画面を並べない');
h.check(/\?page=mypage"/.test(chrome), '右上からマイページへ入れる');

// 画面を介さず google.script.run で呼ばれても通さない
[
  ['getMyCourses', () => G.getMyCourses()],
  ['submitAbsence', () => G.submitAbsence('C001', '2026-11-16')],
  ['getVacancyForRespond', () => G.getVacancyForRespond('V001')],
  ['respondToVacancy', () => G.respondToVacancy('V001', '承諾')],
  ['claimVacancy', () => G.claimVacancy('V001')],
  ['getOpenVacancies', () => G.getOpenVacancies()],
  ['getDashboardData', () => G.getDashboardData()],
  ['getTimetable', () => G.getTimetable()],
].forEach(function (x) {
  h.check(errOf(x[1]) === CLOSED, x[0] + ' は「準備中」で止まる');
});
h.check(errOf(() => G.getMyProfile()) === null, 'マイページの読み込みは通る');
h.check(h.db.vacancies.length === 0, '欠員は1件も作られていない');

h.section('4) 準備中でも職員はいつも通り');
as(STAFF);
h.check(pageOf('home') === 'home' && pageOf('approvals') === 'approvals', '職員はシフト確認・承認画面を開ける');
h.check(errOf(() => G.getDashboardData()) === null, '職員はシフトのデータを読める');
h.check(/\?page=approvals"/.test(G.renderChrome_({ file: 'home', title: 'シフト確認' }, 'home', G.getCurrentUser_())),
  '職員のナビはいつも通り');

h.section('5) 準備中でも未登録の人は申請画面へ');
h.setEmail('newcomer@example.ac.jp');
h.check(pageOf('home') === 'signup', '名簿に無い人は申請画面');

h.section('6) 公開に戻すと学生も使える');
as(STAFF);
h.check(G.setStudentAccess(true).open === true, '職員が公開に戻せる');
as(STUDENT);
h.check(pageOf('home') === 'home', '学生がシフト確認を開ける');
h.check(errOf(() => G.getMyCourses()) === null, '学生がまたサーバー関数を呼べる');

process.exit(h.report());
