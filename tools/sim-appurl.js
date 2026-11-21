/**
 * Chat に入れるリンクの URL（公開用の `/exec`）の検証 — Node 上で実行する
 *
 *     node tools/sim-appurl.js
 *
 * ■ なぜ
 *   ScriptApp.getService().getUrl() は、その操作が `/dev`（テスト用のデプロイ）から行われていれば `/dev` の URL を返す。
 *   `/dev` はスクリプトの編集権限がある人しか開けないので、それを Chat に入れると、学生が開いたときに
 *   「アクセス権が必要です」になり、「リクエスト」でスクリプトの持ち主（支援室）へ共有のリクエストが届いていた。
 *
 * 守りたいこと：
 *   1. `/exec` で画面が開かれたら、その URL を覚える（`/dev` では覚えない・上書きしない）
 *   2. 承認の Chat・代行依頼の回答リンクには、`/dev` から操作しても覚えた `/exec` の URL を入れる
 *   3. 画面の中のリンク（ナビ）は今まで通り、開いている URL（`/dev` なら `/dev`）
 *   4. 覚えた値が `/exec` の形でなければ使わない（入れ間違いでリンクを壊さない）
 */
const fs = require('fs');
const path = require('path');
const { Harness } = require('./gas-harness');

// 架空の URL（ID は本物ではない）
const EXEC = 'https://script.google.com/a/macros/example.ac.jp/s/AKfycbDEMO-deployment/exec';
const DEV = 'https://script.google.com/a/macros/example.ac.jp/s/1DEMO-script-id/dev';
var CUR = EXEC;   // いま開いている URL（getUrl() が返す値）

const h = new Harness();
h.stub({ ScriptApp: { getService: function () { return { getUrl: function () { return CUR; } }; } } });
h.load(['Constants.gs', 'Util.gs', 'Terms.gs', 'Vacancy.gs', 'Access.gs', 'ClassCalendar.gs', 'Cancellation.gs',
  'Profile.gs', 'Registration.gs', 'Notify.gs', 'code.js', 'Identity.gs']);
const G = h.G;
const T = h.time;
// Notify.gs を読み込んだので、まとめて送る一番下だけ差し替える（宛先と本文を記録する）
const posted = [];
h.context.postToWebhooks_ = function (targets) {
  const out = {};
  targets.forEach(function (t) { posted.push(t); out[t.key] = { sent: true, reason: '' }; });
  return out;
};
// 承認の Chat は postToWebhook_（1件ずつ）で送る。これも記録だけにする
h.context.postToWebhook_ = function (url, text) { posted.push({ key: 'single', url: url, text: text }); return true; };

const HOOK = 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t';
var D = T.dateIn(8);
if (G.weekdayOf_(D) === '日') D = T.dateIn(9);
const DAY = G.weekdayOf_(D);

function setup() {
  h.reset();
  posted.length = 0;
  h.add('terms', { term_id: 'X-後期', system: 'semester', start_date: T.dateIn(-30), end_date: T.dateIn(90) });
  h.add('periods', { period: '1', start_time: '09:15', end_time: '10:45' });
  h.add('staffs', { staff_id: 'T1', name: '職員 花子', role: '職員' });
  h.add('contacts', { staff_id: 'T1', name: '職員 花子', email: 't1@example.ac.jp' });
  h.add('staffs', { staff_id: 'S1', name: '学生 一郎', role: '学生', skills: 'テイク' });
  h.add('contacts', { staff_id: 'S1', name: '学生 一郎', email: 's1@example.ac.jp', webhook_url: HOOK });
  h.add('staffs', { staff_id: 'S2', name: '学生 二郎', role: '学生', skills: 'テイク', available_slots: DAY + '1' });
  h.add('contacts', { staff_id: 'S2', name: '学生 二郎', email: 's2@example.ac.jp', webhook_url: HOOK });
  h.add('courses', { course_id: 'C1', quarter: 'X-後期', day: DAY, period: '1', support_type: 'テイク',
    user_student: '架空 花子', staff_a_id: 'S1', staff_b_id: '' });
  h.add('vacancies', { vacancy_id: 'V1', date: D, course_id: 'C1', absent_staff_id: 'S1', result: '' });
}
const asStaff = () => h.setUser({ staff_id: 'T1', name: '職員 花子', role: '職員', email: 't1@example.ac.jp' });

console.log('===== Chat に入れるリンクの URL（/dev を送らない）=====');

h.section('1) /exec で開かれたら覚える。/dev では覚えない');
setup();
CUR = DEV;
G.rememberPublicAppUrl_();
h.check(!h.props.APP_URL, '/dev で開いても覚えない');
h.check(G.getPublicAppUrl_() === DEV, 'まだ覚えていなければ、今まで通り開いている URL を使う');
CUR = EXEC;
G.rememberPublicAppUrl_();
h.check(h.props.APP_URL === EXEC, '★/exec で開かれたら、その URL を覚える');
CUR = DEV;
G.rememberPublicAppUrl_();
h.check(h.props.APP_URL === EXEC, '★そのあと /dev で開いても、覚えた /exec は上書きしない');
// doGet の最初（ルーティングより前）で覚えている
const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'code.js'), 'utf8');
const doGetBody = code.slice(code.indexOf('function doGet('), code.indexOf('const pageKey'));
h.check(doGetBody.indexOf('rememberPublicAppUrl_()') !== -1, 'doGet が、画面を振り分ける前に URL を覚える');

h.section('2) /dev から操作しても、Chat には /exec のリンクを入れる');
CUR = DEV;   // 職員が /dev から操作している
h.check(G.getPublicAppUrl_() === EXEC, '★Chat に使う URL は覚えた /exec');
h.check(G.getAppUrl_() === DEV, '画面の中のリンク（ナビ）は今まで通り、開いている /dev');
// 承認の Chat（すでに出ていた申請を承認する。新しい申請は D64 で受け付けなくなった）
h.add('registrations', { registration_id: 'R001', email: 'newcomer@example.ac.jp', name: '新人 太郎', phone: '090-0000-3333',
  webhook_url: HOOK, skills: 'テイク', slots: DAY + '1', assist_slots: '', note: '', status: '申請中', applied_at: '2026-11-01 10:00:00' });
asStaff();
posted.length = 0;
const ap = G.approveRegistration(h.db.registrations[0].registration_id);
const approval = posted.filter((t) => /利用登録が承認されました/.test(t.text))[0];
h.check(ap.ok && !!approval, '前提：承認の Chat を送っている');
h.check(approval && approval.text.indexOf(EXEC) !== -1 && approval.text.indexOf('/dev') === -1,
  '★承認の Chat の「こちらから開けます」は /exec（/dev ではない）');
// 代行依頼の回答リンク
posted.length = 0;
G.notifyNewVacancy_('V1', false);
const ask = posted.filter((t) => /page=respond/.test(t.text));
h.check(ask.length > 0 && ask.every((t) => t.text.indexOf(EXEC + '?page=respond&vacancy=V1') !== -1 && t.text.indexOf('/dev') === -1),
  '★代行依頼の回答リンクも /exec');

h.section('3) 覚えた値が /exec の形でなければ使わない');
h.props.APP_URL = 'https://example.invalid/something';
CUR = EXEC;
h.check(G.getPublicAppUrl_() === EXEC, '形の違う値は使わず、開いている URL を使う');
G.rememberPublicAppUrl_();
h.check(h.props.APP_URL === EXEC, '/exec で開かれたら正しい値に直る');

process.exit(h.report());
