/**
 * 授業の無い日と、曜日ごとのクォーターの境目の検証（D53）— Node 上で実行する
 *
 *     node tools/sim-calendar.js
 *
 * クォーターは全8回で、祝日や全学休講の入り方が曜日ごとに違うので、境目も曜日ごとに違う。
 * ここがずれると、ある曜日だけ前のクォーターのコマが出続ける（エラーは出ない）。
 *
 * 1) は 2026年度の瀬田の学年暦（大学の公開ページ）の授業の無い日を入れ、
 *    学年暦に書かれた第2・第4クォーターの開始日と全曜日一致することを確かめる。
 * 2) 以降の欠勤連絡などは、今日からの相対の日付で作る（日がたっても壊れないように）。
 */
const { Harness } = require('./gas-harness');

const h = new Harness();
h.load(['Constants.gs', 'Util.gs', 'Terms.gs', 'Vacancy.gs', 'Access.gs', 'ClassCalendar.gs', 'Input.gs', 'code.js', 'Identity.gs']);
const G = h.G;
const T = h.time;

console.log('===== 授業の無い日・クォーターの境目（D53）=====');

// ── 1) 2026年度（瀬田）────────────────────────────────────────
h.section('1) 2026年度の学年暦どおりにクォーターが切り替わる');
h.reset();
[
  ['2026-前期', 'semester', '2026-04-07', '2026-07-27'],
  ['2026-1Q', 'quarter', '2026-04-07', '2026-06-08'],
  ['2026-2Q', 'quarter', '2026-06-09', '2026-07-27'],
  ['2026-後期', 'semester', '2026-09-18', '2027-01-20'],
  ['2026-3Q', 'quarter', '2026-09-18', '2026-11-19'],
  ['2026-4Q', 'quarter', '2026-11-20', '2027-01-20'],
].forEach((t) => h.add('terms', { term_id: t[0], system: t[1], start_date: t[2], end_date: t[3] }));
// 学年暦で授業の無い日（授業実施日の祝日 4/29・7/20・9/21・10/12・11/3 は入れない）
[
  ['2026-05-04', '2026-05-06', '', '連休'],
  ['2026-05-13', '', '5', '降誕会'],
  ['2026-05-21', '', '', '創立記念日'],
  ['2026-09-22', '2026-09-23', '', '国民の休日・秋分の日'],
  ['2026-10-24', '', '', '龍谷祭（瀬田）'],
  ['2026-10-30', '2026-10-31', '', '龍谷祭（深草）'],
  ['2026-11-23', '', '', '勤労感謝の日'],
  ['2026-12-29', '2027-01-06', '', '冬期休業'],
  ['2027-01-11', '', '', '成人の日'],
].forEach((n, i) => h.add('no_class_days', {
  no_class_id: 'N' + (i + 1), start_date: n[0], end_date: n[1], from_period: n[2], reason: n[3],
}));

let cal = G.classCalendar_();
const starts = (id) => ['月', '火', '水', '木', '金', '土'].map((d) => d + cal.ranges[id].byDay[d].start.slice(5)).join(' ');
const ends = (id) => ['月', '火', '水', '木', '金', '土'].map((d) => d + cal.ranges[id].byDay[d].end.slice(5)).join(' ');
h.check(starts('2026-2Q') === '月06-15 火06-09 水06-10 木06-11 金06-05 土06-06',
  '★第2クォーターの開始が学年暦と一致（月6/15・火6/9・水6/10・木6/11・金6/5・土6/6）：' + starts('2026-2Q'));
h.check(starts('2026-4Q') === '月11-16 火11-24 水11-25 木11-19 金11-20 土11-28',
  '★第4クォーターの開始が学年暦と一致（月11/16・火11/24・水11/25・木11/19・金11/20・土11/28）：' + starts('2026-4Q'));
h.check(ends('2026-3Q') === '月11-09 火11-17 水11-18 木11-12 金11-13 土11-21',
  '第3クォーターの終わりは曜日ごとの8回目：' + ends('2026-3Q'));
h.check(cal.ranges['2026-3Q'].byDay['金'].start === '2026-09-18' && cal.ranges['2026-4Q'].byDay['水'].end === '2027-01-20',
  'クォーターは授業開始日の曜日から始まり、セメスターの授業終了日まで');
h.check(cal.ranges['2026-後期'].byDay === null && cal.ranges['2026-後期'].start === '2026-09-18',
  'セメスターは学期の開始日〜終了日のまま');

h.section('1b) 〇講時以降休講');
h.check(!G.isNoClassAt_(cal.noClass, '2026-05-13', '4'), '5/13 の4限は授業がある');
h.check(G.isNoClassAt_(cal.noClass, '2026-05-13', '5'), '5/13 の5限は休み');
h.check(G.isNoClassAt_(cal.noClass, '2026-05-13', '移動前5'), '5限の前の移動介助も休み（枠の数字で判定）');
h.check(!G.isNoClassAt_(cal.noClass, '2026-05-13', '移動後4'), '4限のあとの移動介助は休みにしない');
h.check(G.isNoClassAt_(cal.noClass, '2027-01-06', '1'), '期間（冬期休業 12/29〜1/6）の中の日も休み');

h.section('1c) このコマはこの日にあるか');
const course = (q, day, period, extra) => Object.assign({ quarter: q, day: day, period: period, date: '' }, extra || {});
h.check(G.courseHeldOn_(course('2026-3Q', '火', '2'), '2026-11-17', cal).held, '3Q の火2 は 11/17 にある（火曜の8回目）');
h.check(!G.courseHeldOn_(course('2026-3Q', '火', '2'), '2026-11-24', cal).held, '3Q の火2 は 11/24 には無い（もう 4Q）');
h.check(G.courseHeldOn_(course('2026-4Q', '火', '2'), '2026-11-24', cal).held, '4Q の火2 は 11/24 から');
h.check(!G.courseHeldOn_(course('2026-4Q', '月', '1'), '2026-11-23', cal).held, '勤労感謝の日は授業が無い');
h.check(G.courseHeldOn_(course('2026-4Q', '火', '1', { date: '2026-11-23' }), '2026-11-23', cal).held,
  '「この日だけ」のコマ（補講など）は授業の無い日でも行う');
h.check(G.courseHeldOn_(course('2026-後期', '火', '1'), '2026-11-03', cal).held, '授業実施日の祝日（11/3）は授業がある');

h.section('1d) 学期の行へ書き戻す（おおまかな期間）');
G.syncQuarterDates_();
const termRow = (id) => h.row('terms', 'term_id', id);
h.check(termRow('2026-3Q').start_date === '2026-09-18' && termRow('2026-3Q').end_date === '2026-11-21',
  '3Q の行は「一番早い曜日の始まり〜一番遅い曜日の終わり」');
h.check(termRow('2026-4Q').start_date === '2026-11-16', '4Q の行の開始は一番早い曜日（月11/16）');

// ── 2) 画面へ渡すデータと欠勤連絡（今日からの相対）──────────────────
h.section('2) 時間割と欠勤連絡');
h.reset();
const sStart = T.dateIn(-30);
const sEnd = T.dateIn(120);
h.add('terms', { term_id: 'X-前期', system: 'semester', start_date: sStart, end_date: sEnd });
h.add('periods', { period: '1', start_time: '09:00', end_time: '10:30' });
h.add('periods', { period: '5', start_time: '16:55', end_time: '18:25' });
h.add('staffs', { staff_id: 'S1', name: '学生A', role: '学生', skills: 'テイク', available_slots: '' });
h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
h.add('contacts', { staff_id: 'S1', name: '学生A', email: 's1@example.jp' });
h.add('contacts', { staff_id: 'T1', name: '職員', email: 't1@example.jp' });
const OFF = T.dateIn(9);                // 授業の無い日（終日）
const DAY = G.weekdayOf_(OFF);
const NEXT = T.dateIn(16);              // 翌週の同じ曜日（授業がある）
const HALF = T.dateIn(23);              // 5講時以降が休み
h.add('courses', { course_id: 'C1', quarter: 'X-前期', day: DAY, period: '1', support_type: 'テイク', user_student: '利用者A', staff_a_id: 'S1' });
h.add('courses', { course_id: 'C5', quarter: 'X-前期', day: DAY, period: '5', support_type: 'テイク', user_student: '利用者A', staff_a_id: 'S1' });
h.add('no_class_days', { no_class_id: 'N1', start_date: OFF, end_date: '', from_period: '', reason: '架空の祝日' });
h.add('no_class_days', { no_class_id: 'N2', start_date: HALF, end_date: '', from_period: '5', reason: '架空の行事' });
G.clearClassCalendarCache_();

h.setUser({ staff_id: 'S1', name: '学生A', role: '学生', email: 's1@example.jp' });
const tt = G.getTimetable('');
h.check(tt.noClass[OFF] && tt.noClass[OFF].reason === '架空の祝日' && !tt.noClass[OFF].from, '時間割へ授業の無い日（終日）を渡す');
h.check(tt.noClass[HALF] && tt.noClass[HALF].from === 5, '〇講時以降も渡す');

const mine = G.getMyCourses();
const c1 = mine.filter((c) => c.course_id === 'C1')[0];
const c5 = mine.filter((c) => c.course_id === 'C5')[0];
h.check(c1.skipDates.indexOf(OFF) !== -1 && c1.skipDates.indexOf(HALF) === -1, '欠勤日の候補から外す日：1限は終日休みの日だけ');
h.check(c5.skipDates.indexOf(OFF) !== -1 && c5.skipDates.indexOf(HALF) !== -1, '5限は〇講時以降休講の日も外す');

let threw = '';
try { G.submitAbsence('C1', OFF, true); } catch (e) { threw = e.message; }
h.check(/授業がありません（架空の祝日）/.test(threw), '★授業の無い日には欠勤連絡できない：' + threw);
threw = '';
try { G.submitAbsence('C5', HALF, true); } catch (e) { threw = e.message; }
h.check(/5講時以降/.test(threw), '★5講時以降休講の日の5限にも欠勤連絡できない：' + threw);
threw = '';
try { G.submitAbsence('C1', NEXT, true); } catch (e) { threw = e.message; }
h.check(!/授業がありません|授業期間外/.test(threw), '授業のある日は今までどおり受け付ける');

// ── 3) 学期設定の画面 ─────────────────────────────────────
h.section('3) 学期設定から授業の無い日を登録・削除する');
h.reset();
[
  ['2026-後期', 'semester', '2026-09-18', '2027-01-20'],
  ['2026-3Q', 'quarter', '2026-09-18', '2026-11-19'],
  ['2026-4Q', 'quarter', '2026-11-20', '2027-01-20'],
].forEach((t) => h.add('terms', { term_id: t[0], system: t[1], start_date: t[2], end_date: t[3] }));
h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
h.add('contacts', { staff_id: 'T1', name: '職員', email: 't1@example.jp' });
h.setUser({ staff_id: 'T1', name: '職員', role: '職員', email: 't1@example.jp' });
G.clearClassCalendarCache_();

const add = (p) => { try { G.addNoClassDay(p); return ''; } catch (e) { return e.message; } };
h.check(/理由/.test(add({ start_date: '2026-11-23', reason: '' })), '理由が空なら登録しない');
h.check(/先頭に/.test(add({ start_date: '2026-11-23', reason: '=1+1' })), '先頭が = の理由は登録しない');
h.check(/前になっています/.test(add({ start_date: '2026-12-01', end_date: '2026-11-01', reason: 'x' })), '終わりが始まりより前なら登録しない');
h.check(/講時/.test(add({ start_date: '2026-11-23', from_period: 'x', reason: 'x' })), '講時は数字か空だけ');
const before = G.classCalendar_().ranges['2026-4Q'].byDay['月'].start;
h.check(add({ start_date: '2026-11-23', reason: '勤労感謝の日' }) === '', '登録できる');
h.check(G.classCalendar_().noClass['2026-11-23'], '★登録するとすぐ反映される（キャッシュを捨てる）');
h.check(add({ start_date: '2026-10-05', reason: '架空の休講' }) === '' && G.classCalendar_().ranges['2026-4Q'].byDay['月'].start !== before,
  '★授業の無い日を足すと、その曜日のクォーターの境目が後ろへずれる');
h.check(h.row('terms', 'term_id', '2026-4Q').start_date !== '2026-11-20', '学期の行も計算し直して書き戻す');

threw = '';
try { G.updateTermDates('2026-3Q', '2026-09-18', '2026-11-30'); } catch (e) { threw = e.message; }
h.check(/自動で計算/.test(threw), 'クォーターの日付は手で直させない');
G.updateTermDates('2026-後期', '2026-09-25', '2027-01-20');
h.check(G.classCalendar_().ranges['2026-3Q'].byDay['金'].start === '2026-09-25', 'セメスターの日付を直すとクォーターも計算し直す');

const admin = G.getTermsAdmin();
const q3 = admin.terms.filter((t) => t.term_id === '2026-3Q')[0];
h.check(q3.computed && q3.byDay && q3.byDay['月'], '学期設定の画面へ、曜日ごとの範囲を渡す');
h.check(admin.noClassDays.length === 2 && admin.hasNoClassSheet, '登録した授業の無い日を渡す');
G.deleteNoClassDay(admin.noClassDays[0].no_class_id);
h.check(G.getTermsAdmin().noClassDays.length === 1, '削除できる');

h.section('4) 職員でなければ触れない');
h.setUser({ staff_id: 'S9', name: '学生', role: '学生', email: 's9@example.jp' });
['addNoClassDay', 'deleteNoClassDay'].forEach(function (fn) {
  threw = '';
  try { G[fn]({}); } catch (e) { threw = e.message; }
  h.check(/利用登録|職員/.test(threw), fn + ' は学生から呼べない');
});

process.exitCode = h.report();
