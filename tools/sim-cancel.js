/**
 * 個別の休講（D53 の3回目・D60）の検証 — Node 上で実行する
 *
 *     node tools/sim-cancel.js
 *
 * 守りたいこと：
 *   1. 休講は**その日だけ**。授業そのもの（courses）は消えず、ほかの週はいつも通り
 *   2. 休講の日は欠勤連絡で選べず、決まっていない欠員は「休講」で締め切る
 *   3. 担当・その日の代行・職員スペースへ知らせる。**利用学生の名前は Chat に書かない**
 *   4. 「この利用者のこの日のコマを全部」で、同じ利用学生のその日のコマだけをまとめて休講にする
 *   5. 職員だけが操作できる。取り消せる
 */
const { Harness, time: T } = require('./gas-harness');
const { loadPage } = require('./page-vm');

/**
 * 欠勤連絡の画面（src/absence.html）のスクリプトを動かし、指定のコマで rebuildDates() を呼んだあとの状態を返す。
 * サーバーの判定と画面の判定が食い違う不具合（issue #49）は、サーバー側のテストだけでは見つからないため。
 */
function absencePageFor(courses, courseId) {
  const p = loadPage('absence', { include: ['shared-dialog'] });
  p.ctx.COURSES = JSON.parse(JSON.stringify(courses));   // 画面に届くのは JSON にした値
  p.el('course').value = courseId;
  p.ctx.rebuildDates();
  return { disabled: p.el('submit').disabled, hint: p.el('datehint').textContent, options: p.el('dateWrap').innerHTML };
}

const h = new Harness();
h.load(['Constants.gs', 'Util.gs', 'Terms.gs', 'Vacancy.gs', 'Access.gs', 'ClassCalendar.gs', 'Cancellation.gs',
  'Input.gs', 'Notify.gs']);
const G = h.G;
// Notify.gs を読み込んだので、送信の一番下だけ差し替える（宛先と本文を記録する）
const posted = [];
h.context.postToWebhooks_ = function (targets) {
  const out = {};
  targets.forEach(function (t) { posted.push(t); out[t.key] = { sent: !!t.url, reason: t.url ? '' : 'Webhook未登録' }; });
  return out;
};
h.context.notifyVacancyClosed_ = function (id, label) {
  h.notifyLog.push({ kind: 'closed', id: id, label: label });
  return { others: [], errors: [] };
};

// 1〜2週間先の、業務のある曜日（日曜を避ける）
var D = T.dateIn(8);
if (G.weekdayOf_(D) === '日') D = T.dateIn(9);
const DAY = G.weekdayOf_(D);
const NEXT = G.shiftDateStr_(D, 7);   // 翌週の同じ曜日

function setup() {
  h.reset();
  posted.length = 0;
  h.add('terms', { term_id: 'X-後期', system: 'semester', start_date: T.dateIn(-30), end_date: T.dateIn(90) });
  h.add('periods', { period: '移動前2', start_time: '10:45', end_time: '11:00', support_types: '介助', label: '移動介助' });
  h.add('periods', { period: '1', start_time: '09:15', end_time: '10:45' });
  h.add('periods', { period: '2', start_time: '11:00', end_time: '12:30' });
  [['S1', '学生 一郎'], ['S2', '学生 二郎'], ['S3', '学生 三郎'], ['S4', '代行 四郎']].forEach(function (s) {
    h.add('staffs', { staff_id: s[0], name: s[1], role: '学生', skills: 'テイク,介助' });
    h.add('contacts', { staff_id: s[0], name: s[1], email: s[0].toLowerCase() + '@example.jp',
      webhook_url: s[0] === 'S2' ? '' : 'https://chat.googleapis.com/v1/spaces/' + s[0] });
  });
  h.add('staffs', { staff_id: 'T1', name: '職員 花子', role: '職員' });
  h.add('contacts', { staff_id: 'T1', name: '職員 花子', email: 't1@example.jp' });
  const c = (id, period, type, user, a, b, extra) => Object.assign({ course_id: id, quarter: 'X-後期', day: DAY,
    period: period, support_type: type, user_student: user, staff_a_id: a, staff_b_id: b || '' }, extra || {});
  h.add('courses', c('C1', '1', 'テイク', '架空 花子', 'S1', 'S2'));
  h.add('courses', c('C2', '2', '介助', '架空 花子', 'S3', '', { move_before: 'あり' }));
  h.add('courses', c('C3', '1', 'テイク', '仮名 太郎', 'S2', ''));
  // 欠員：C1 の D は募集中、C2 の D は代行（S4）が決まっている
  h.add('vacancies', { vacancy_id: 'V1', date: D, course_id: 'C1', absent_staff_id: 'S1', result: '' });
  h.add('vacancies', { vacancy_id: 'V2', date: D, course_id: 'C2', absent_staff_id: 'S3', result: '補充済', substitute_staff_id: 'S4' });
}
const asStaff = () => h.setUser({ staff_id: 'T1', name: '職員 花子', role: '職員', email: 't1@example.jp' });
const asStudent = () => h.setUser({ staff_id: 'S1', name: '学生 一郎', role: '学生', email: 's1@example.jp' });
const errOf = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const held = (id, d) => G.courseHeldOn_(h.row('courses', 'course_id', id), d, G.classCalendar_());

console.log('===== 個別の休講（D60）=====');

h.section('1) 職員だけが操作できる・理由は必須');
setup();
asStudent();
h.check(/職員権限/.test(errOf(() => G.cancelClass({ course_id: 'C1', date: D, reason: '教員の都合' })) || ''), '学生は休講にできない');
asStaff();
h.check(/理由/.test(errOf(() => G.cancelClass({ course_id: 'C1', date: D, reason: '' })) || ''), '理由が無ければ止める');
h.check(/過ぎた日/.test(errOf(() => G.cancelClass({ course_id: 'C1', date: T.dateIn(-7), reason: 'x' })) || ''), '過ぎた日は休講にできない');
h.check(/=/.test('=') && /数式|先頭/.test(errOf(() => G.cancelClass({ course_id: 'C1', date: D, reason: '=1+1' })) || ''),
  '数式に見える理由は受け付けない');
h.check(h.db.cancellations.length === 0, 'ここまでで休講は1件も入っていない');

h.section('2) その日のそのコマだけ休講にする');
setup();
asStaff();
const r1 = G.cancelClass({ course_id: 'C1', date: D, reason: '教員の都合' });
h.check(r1.ok && h.db.cancellations.length === 1 && h.db.cancellations[0].course_id === 'C1', '★休講の記録が1件できる');
h.check(!!h.row('courses', 'course_id', 'C1'), '★授業そのもの（courses）は消えない');
h.check(!held('C1', D).held && held('C1', D).cancelled, 'その日は「授業がない」扱い');
h.check(held('C1', NEXT).held, '★翌週の同じ曜日はいつも通り');
h.check(held('C3', D).held, '同じ時間の別の利用者のコマには影響しない');
h.check(h.row('vacancies', 'vacancy_id', 'V1').result === '休講', '★募集中の欠員は「休講」で締め切る');
h.check(h.notifiesOf('closed').some((n) => n.id === 'V1' && n.label === '休講'), '代行の候補へ締め切りを知らせる');
h.check(r1.closedVacancies === 1 && r1.courses.join() === DAY + '1限 テイク', '画面へ返す要約（利用学生の名前は入れない）');
// Chat
const to = (key) => posted.filter((t) => t.key === key)[0];
h.check(!!to('S1') && !!to('S2') && !!to('__staff__'), '★担当A・Bと職員スペースへ知らせる');
h.check(!to('S3') && !to('S4'), '関係の無い人には送らない');
h.check(to('S1').text.indexOf('休講です') !== -1 && to('S1').text.indexOf('教員の都合') !== -1, '本文に休講と理由');
h.check(posted.every((t) => t.text.indexOf('架空') === -1), '★Chat に利用学生の名前を書かない');
h.check(to('__staff__').text.indexOf('職員 花子') !== -1 && to('__staff__').text.indexOf('学生 一郎') !== -1,
  '職員スペースには担当と操作した職員を書く');
h.check(r1.notify.people.some((p) => p.staff_id === 'S2' && !p.sent), 'Webhook の無い人は「届かなかった」と返す（電話で伝える）');
// 欠勤連絡
asStudent();
h.check(/休講です/.test(errOf(() => G.submitAbsence('C1', D)) || ''), '★休講の日は欠勤連絡を受け付けない');
const mine = G.getMyCourses().filter((c) => c.course_id === 'C1')[0];
h.check(mine.skipDates.indexOf(D) !== -1, '欠勤連絡の日付の選択肢から外す');
// 二重
asStaff();
h.check(/休講です/.test(errOf(() => G.cancelClass({ course_id: 'C1', date: D, reason: 'もう一度' })) || ''), 'もう休講の日は休講にできない');

h.section('3) この利用者のこの日のコマを全部');
setup();
asStaff();
const r2 = G.cancelClass({ course_id: 'C1', date: D, reason: '利用学生の欠席', wholeDay: true });
h.check(h.db.cancellations.map((x) => x.course_id).sort().join() === 'C1,C2', '★同じ利用学生のその日のコマ（C1・C2）だけ');
h.check(held('C3', D).held, '別の利用学生のコマは休講にしない');
h.check(!!to('S3') && !!to('S4'), '★C2 の担当と、その日の代行に決まっていた人にも知らせる');
h.check(to('S3').text.indexOf('10:45〜12:30・移動を含む') !== -1, '移動の印のある介助は、移動も含む時刻で知らせる（移動も休み）');
h.check(h.row('vacancies', 'vacancy_id', 'V2').result === '補充済', '決着済みの欠員は書き換えない');
h.check(r2.courses.length === 2, '2コマを休講にしたと返す');

h.section('4) 休講を取り消す');
posted.length = 0;
asStudent();
h.check(/職員権限/.test(errOf(() => G.uncancelClass({ course_id: 'C1', date: D })) || ''), '学生は取り消せない');
asStaff();
const u1 = G.uncancelClass({ course_id: 'C2', date: D });
h.check(h.db.cancellations.map((x) => x.course_id).join() === 'C1' && held('C2', D).held, '★C2 だけ取り消せる');
h.check(!!to('S3') && to('S3').text.indexOf('取り消しました') !== -1 && !!to('__staff__'), '担当と職員スペースへ取り消しを知らせる');
const u2 = G.uncancelClass({ course_id: 'C1', date: D, wholeDay: true });
h.check(h.db.cancellations.length === 0 && held('C1', D).held, '全部取り消すと授業がある扱いに戻る');
h.check(u2.hadClosedVacancy === true && h.row('vacancies', 'vacancy_id', 'V1').result === '休講',
  '休講で締め切った欠員は戻さない（必要なら欠員補充管理で再オープン）と知らせる');
h.check(/なっていません/.test(errOf(() => G.uncancelClass({ course_id: 'C1', date: D })) || ''), '休講でない日は取り消せない');
void u1;

h.section('5) 授業を削除したら休講の記録も消す（休講と削除は別もの）');
setup();
asStaff();
G.cancelClass({ course_id: 'C3', date: D, reason: '教員の都合' });
G.deleteCourse('C3');
h.check(!h.row('courses', 'course_id', 'C3') && h.db.cancellations.length === 0, '削除したコマの休講の記録は残さない');

h.section('6) 休講を取り消したら、代行に決まっている人にも知らせる（issue #44）');
setup();
asStaff();
// 別の日・別のコマにも代行がいる（その人には送らない）
h.add('vacancies', { vacancy_id: 'V3', date: NEXT, course_id: 'C2', absent_staff_id: 'S3', result: '補充済', substitute_staff_id: 'S1' });
G.cancelClass({ course_id: 'C2', date: D, reason: '教員の都合' });
h.check(!!to('S4') && to('S4').text.indexOf('休講です') !== -1, '休講のとき、代行の人（S4）に知らせる');
posted.length = 0;
const u3 = G.uncancelClass({ course_id: 'C2', date: D });
h.check(!!to('S4') && to('S4').text.indexOf('取り消しました') !== -1, '★取り消したときも、代行の人（S4）に「いつも通り実施」を知らせる');
h.check(!!to('S4') && to('S4').text.indexOf('2限') !== -1 && to('S4').text.indexOf('1限') === -1, '代行の人には、その人のコマだけを並べる');
h.check(!to('S1'), '★別の日の代行の人（S1）には送らない');
h.check(u3.notify.people.some((p) => p.staff_id === 'S4' && p.sent), '代行の人に届いたかを画面へ返す（届かなければ職員が分かる）');
h.check(h.row('vacancies', 'vacancy_id', 'V2').substitute_staff_id === 'S4', '代行の人はそのまま担当に残る');
// 休講で締めた欠員（代行者なし）の人には送らない／代行者が残っていても決着が「補充済」でなければ送らない
setup();
asStaff();
h.row('vacancies', 'vacancy_id', 'V2').result = '職員対応';
G.cancelClass({ course_id: 'C2', date: D, reason: '教員の都合' });
posted.length = 0;
G.uncancelClass({ course_id: 'C2', date: D });
h.check(!to('S4'), '補充済でない欠員の代行者欄は宛先にしない');
// 代行の人に Webhook が無ければ「届かなかった」と返す
setup();
asStaff();
h.row('vacancies', 'vacancy_id', 'V2').substitute_staff_id = 'S2';   // S2 は Webhook なし
G.cancelClass({ course_id: 'C2', date: D, reason: '教員の都合' });
const u4 = G.uncancelClass({ course_id: 'C2', date: D });
h.check(u4.notify.people.some((p) => p.staff_id === 'S2' && !p.sent), '★代行の人に届かなかったら、画面に「届かなかった」と返す');

h.section('7) 休講にした単発コマは欠勤連絡できない（issue #45）');
setup();
asStaff();
h.add('courses', { course_id: 'C9', quarter: 'X-後期', day: DAY, period: '2', support_type: 'テイク',
  user_student: '仮名 太郎', staff_a_id: 'S1', staff_b_id: '', date: D });
G.cancelClass({ course_id: 'C9', date: D, reason: '教員の都合' });
asStudent();
const vBefore = h.db.vacancies.length;
h.check(/休講です/.test(errOf(() => G.submitAbsence('C9', D)) || ''), '★休講の単発コマは欠勤連絡を受け付けない');
h.check(h.db.vacancies.length === vBefore, '欠員を作らない（代行の募集も動かない）');
const one = G.getMyCourses().filter((c) => c.course_id === 'C9')[0];
h.check(one && one.oneOffDate === D && one.skipDates.indexOf(D) !== -1, '★画面へ「その日は休講」と分かる形で渡す（欠勤連絡で選べない）');
// 個別の休講でなければ、授業の無い日でも単発コマは今まで通り（学期外の行事・補講）
asStaff();
G.uncancelClass({ course_id: 'C9', date: D });
h.add('no_class_days', { no_class_id: 'N1', start_date: D, end_date: '', from_period: '', reason: '全学休講' });
G.clearClassCalendarCache_();
asStudent();
h.db.vacancies = h.db.vacancies.filter((v) => v.course_id !== 'C9');   // 上で（直す前のコードなら）できた欠員を消してから試す
var r9 = null;
try { r9 = G.submitAbsence('C9', D); } catch (e) { r9 = { error: e.message }; }
h.check(r9 && r9.vacancy_id, '★授業の無い日でも、休講でなければ単発コマは欠勤連絡できる（今まで通り）');

h.section('8) 休講中の欠員は再オープンも代行の確定もできない（issue #46）');
setup();
asStaff();
h.row('staffs', 'staff_id', 'S4').available_slots = DAY + '1';   // S4 は C1 の代行候補
G.cancelClass({ course_id: 'C1', date: D, reason: '教員の都合' });
h.check(h.row('vacancies', 'vacancy_id', 'V1').result === '休講', '前提：V1 は「休講」で締まっている');
h.check(/休講です/.test(errOf(() => G.reopenVacancy('V1')) || ''), '★休講中は再オープンできない');
h.check(/取り消して/.test(errOf(() => G.reopenVacancy('V1')) || ''), '先に休講を取り消すよう案内する');
h.check(h.row('vacancies', 'vacancy_id', 'V1').result === '休講', '結果は書き換えない');
// 経路の漏れで開いたままになっていても、代行を確定させない
h.row('vacancies', 'vacancy_id', 'V1').result = '';
h.setUser({ staff_id: 'S4', name: '代行 四郎', role: '学生', email: 's4@example.jp' });
const c4 = G.claimVacancy('V1');
h.check(c4.ok === false && /休講/.test(c4.message || ''), '★自分から代行に入れない');
h.check(/休講です/.test(errOf(() => G.respondToVacancy('V1', '承諾')) || ''), '★代行依頼に承諾できない');
asStaff();
h.check(/休講です/.test(errOf(() => G.confirmSubstitute('V1', 'S4')) || ''), '★職員も代行を確定できない');
h.check(h.row('vacancies', 'vacancy_id', 'V1').result === '' && !h.row('vacancies', 'vacancy_id', 'V1').substitute_staff_id,
  'どの経路でも代行者は書かれない');
// 休講を取り消せば、いつも通り再オープンできる
h.row('vacancies', 'vacancy_id', 'V1').result = '休講';
G.uncancelClass({ course_id: 'C1', date: D });
const ro = G.reopenVacancy('V1');
h.check(ro.ok && h.row('vacancies', 'vacancy_id', 'V1').result === '', '★休講を取り消したあとは再オープンできる');

h.section('9) 全学の授業の無い日の単発コマは、画面からも欠勤連絡できる（issue #49）');
setup();
asStaff();
h.add('courses', { course_id: 'C9', quarter: 'X-後期', day: DAY, period: '2', support_type: 'テイク',
  user_student: '仮名 太郎', staff_a_id: 'S1', staff_b_id: '', date: D });
// 学期の外の単発コマ（行事など）
const OUT = T.dateIn(120);
h.add('courses', { course_id: 'C10', quarter: 'X-後期', day: G.weekdayOf_(OUT), period: '1', support_type: 'テイク',
  user_student: '仮名 太郎', staff_a_id: 'S1', staff_b_id: '', date: OUT });
h.add('no_class_days', { no_class_id: 'N1', start_date: D, end_date: '', from_period: '', reason: '全学休講' });
G.clearClassCalendarCache_();
asStudent();
var mine9 = G.getMyCourses();
var p9 = absencePageFor(mine9, 'C9');
h.check(!p9.disabled && p9.hint.indexOf('休講') === -1, '★全学休講の日の単発コマは、画面で欠勤の登録ボタンが押せる（休講と出さない）：' + p9.hint);
h.check(p9.options.indexOf('value="' + D + '"') !== -1, '実施日が選択肢に出る');
const pOut = absencePageFor(mine9, 'C10');
h.check(!pOut.disabled && pOut.options.indexOf('value="' + OUT + '"') !== -1, '学期の外の単発コマも今まで通り選べる');
const p1 = absencePageFor(mine9, 'C1');
h.check(p1.options.indexOf(D) === -1 && p1.options.indexOf(NEXT) !== -1, '★毎週のコマは、全学休講の日を今まで通り選択肢から外す');
const s9 = G.submitAbsence('C9', D);
h.check(!!s9.vacancy_id, 'サーバーも受け付ける（画面とサーバーの判定が揃う）');
// 同じ単発コマを個別に休講にしたら、画面もサーバーも止める
asStaff();
G.cancelClass({ course_id: 'C9', date: D, reason: '教員の都合' });
asStudent();
mine9 = G.getMyCourses();
p9 = absencePageFor(mine9, 'C9');
h.check(p9.disabled && p9.hint.indexOf('休講') !== -1, '★個別に休講にした単発コマは、画面で登録ボタンを押せない');
h.check(/休講です/.test(errOf(() => G.submitAbsence('C9', D)) || ''), '★サーバーも受け付けない');

h.section('10) 休講のあとで同じ日を全学休講にしても、休講を見落とさない（issue #50）');
setup();
asStaff();
h.row('staffs', 'staff_id', 'S4').available_slots = DAY + '1';
G.cancelClass({ course_id: 'C1', date: D, reason: '教員の都合' });
h.add('no_class_days', { no_class_id: 'N1', start_date: D, end_date: '', from_period: '', reason: '全学休講' });
G.clearClassCalendarCache_();
h.check(!held('C1', D).held, '前提：その日は授業の無い日でもある');
h.check(G.cancelledNotice_(h.row('courses', 'course_id', 'C1'), D).indexOf('教員の都合') !== -1,
  '★全学休講と重なっても、個別の休講を見つける');
posted.length = 0;
const resBefore = h.db.responses.length;
h.check(/休講です/.test(errOf(() => G.reopenVacancy('V1')) || ''), '★再オープンできない');
const v1 = h.row('vacancies', 'vacancy_id', 'V1');
h.check(v1.result === '休講' && !v1.substitute_staff_id, '欠員の結果と代行者は変えない');
h.check(h.db.responses.length === resBefore && posted.length === 0, '回答も募集の通知も作らない');
// 経路の漏れで開いたままでも、代行の回答・確定で止める
v1.result = '';
h.setUser({ staff_id: 'S4', name: '代行 四郎', role: '学生', email: 's4@example.jp' });
h.check(G.claimVacancy('V1').ok === false, '★自分から代行に入れない');
h.check(/休講です/.test(errOf(() => G.respondToVacancy('V1', '承諾')) || ''), '★代行依頼に承諾できない');
asStaff();
h.check(/休講です/.test(errOf(() => G.confirmSubstitute('V1', 'S4')) || ''), '★職員も代行を確定できない');
h.check(!h.row('vacancies', 'vacancy_id', 'V1').substitute_staff_id, 'どの経路でも代行者は書かれない');
// 休講を取り消し、授業のある日に戻れば再オープンできる
v1.result = '休講';
G.uncancelClass({ course_id: 'C1', date: D });
h.db.no_class_days = [];
G.clearClassCalendarCache_();
const ro10 = G.reopenVacancy('V1');
h.check(ro10.ok && h.row('vacancies', 'vacancy_id', 'V1').result === '', '★休講を取り消して授業のある日に戻れば、再オープンできる');

process.exit(h.report());
