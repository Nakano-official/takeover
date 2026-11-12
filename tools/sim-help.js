/**
 * ヘルプの一覧がどの画面でも同じことの検証（D51）— Node 上で実行する
 *
 *     node tools/sim-help.js
 *
 * ほかの画面の使い方も見られるよう、全画面で同じ話題の一覧を開ける。
 * 職員向けの話題だけは職員にしか出さない。ボタンを出さないのは見せる話題が無い画面（noHelp）だけ。
 */
const fs = require('fs');
const path = require('path');
const { Harness } = require('./gas-harness');

const SRC = path.join(__dirname, '..', 'src');
const h = new Harness();
h.stub({
  ScriptApp: { getService: function () { return { getUrl: function () { return 'https://example.invalid/app'; } }; } },
  HtmlService: {
    createHtmlOutputFromFile: function (name) {
      const text = fs.readFileSync(path.join(SRC, name + '.html'), 'utf8');
      return { getContent: function () { return text; } };
    },
  },
});
h.load(['Constants.gs', 'Util.gs', 'Terms.gs', 'Vacancy.gs', 'Access.gs', 'ClassCalendar.gs', 'Identity.gs', 'code.js']);

const PAGES = h.value('PAGES');
const TOPICS = h.value('HELP_TOPICS');
// 見せる話題が無い画面（USB 中継プログラムが開く画面／未登録の人の申請画面）
const NO_HELP = ['deviceRelay', 'signup'];   // signup は画面の中のボタンから開く話題だけを持つ
const topicsOf = function (key, user) {
  const m = /HELP_TOPICS_HERE = (\[.*?\]);/.exec(h.G.renderChrome_(PAGES[key], key, user));
  return m ? JSON.parse(m[1]).map((t) => t.key) : [];
};
const ALL = Object.keys(TOPICS);
const FOR_STUDENT = ALL.filter((k) => !TOPICS[k].staffOnly);
const STAFF = { staff_id: 'T1', name: '職員', role: '職員', email: 't@example.jp' };
const STUDENT = { staff_id: 'S1', name: '学生', role: '学生', email: 's@example.jp' };
const hasBtn = (key, user) => h.G.renderChrome_(PAGES[key], key, user).indexOf('help-btn') !== -1;

console.log('===== ヘルプの検証 =====');
h.section('1) 職員はどの画面でも全部の話題を開ける');
Object.keys(PAGES).filter((k) => NO_HELP.indexOf(k) === -1).forEach(function (k) {
  h.check(hasBtn(k, STAFF) && topicsOf(k, STAFF).join() === ALL.join(), PAGES[k].title);
});

h.section('2) 学生は、職員向けを除いた同じ一覧を開ける');
Object.keys(PAGES).filter((k) => !PAGES[k].staffOnly && NO_HELP.indexOf(k) === -1).forEach(function (k) {
  h.check(hasBtn(k, STUDENT) && topicsOf(k, STUDENT).join() === FOR_STUDENT.join(), PAGES[k].title);
});
h.check(!hasBtn('signup', null) && topicsOf('signup', null).join() === 'webhook',
  '申請画面：ヘッダーのボタンは出さず、「詳細はこちら」で通知先URLの作り方だけを開ける（D54）');
NO_HELP.forEach(function (k) {
  h.check(!hasBtn(k, STAFF) && !hasBtn(k, null), PAGES[k].title + '：ヘッダーのボタンは出さない');
});

h.section('3) 話題の中身');
Object.keys(TOPICS).forEach(function (key) {
  const file = path.join(SRC, TOPICS[key].file + '.html');
  h.check(fs.existsSync(file), TOPICS[key].title + '：ファイルがある');
  const s = fs.readFileSync(file, 'utf8');
  h.check(/<section class="help-step" data-title="[^"]+"/.test(s), TOPICS[key].title + '：ページがある');
  h.check(s.indexOf('help-img-todo') === -1 || /^[\s\S]*-->/.test(s) && s.replace(/<!--[\s\S]*?-->/g, '').indexOf('help-img-todo') === -1,
    TOPICS[key].title + '：撮っていない画像が残っていない');
});

process.exitCode = h.report();
