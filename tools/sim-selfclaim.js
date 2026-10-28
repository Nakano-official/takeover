/**
 * 自分から代行に入る（D50）の検証 — Node 上で実行する
 *
 *     node tools/sim-selfclaim.js
 *
 * シフト表の赤いコマと欠員一覧から、学生スタッフが**自分で手を挙げて先着で確定**できる。
 * 代行候補（通知が届く人）との違いは**空きコマ登録を見ないことだけ**。ここで一番大事なのは
 * 「空きコマを見ない」代わりに、それ以外の条件が緩んでいないこと：
 *   - 欠勤者本人・相方（担当）・職員・スキルが合わない人・同じ時限に別の仕事がある人は入れない
 *   - 締切（授業開始30分前）を過ぎたら入れない（職員が決着に動いているので二重手配になる）
 *   - かたまり（D45）は全部の枠で条件を満たす人だけ。確定するときは全部まとめて
 *   - 先着は承諾と同じ（2人目は「埋まりました」）
 */
const { Harness } = require('./gas-harness');

const h = new Harness();
h.load(['Constants.gs', 'Util.gs', 'Terms.gs', 'Vacancy.gs', 'Input.gs', 'code.js', 'Identity.gs']);
const G = h.G;
const T = h.time;
const CLOSED = h.value('MSG_SELF_CLAIM_CLOSED');

const STAFFS = [
  ['S1', '欠勤する人', '学生', 'テイク', '3'],
  ['S2', '相方', '学生', 'テイク', ''],
  ['S3', '空きコマ登録あり', '学生', 'テイク', '3'],
  ['S4', 'たまたま空いている', '学生', 'テイク', ''],
  ['S5', '介助だけ', '学生', '介助', ''],
  ['S6', '別のコマを担当', '学生', 'テイク', ''],
  ['S7', '全対応', '学生', '', ''],
  ['T1', '職員', '職員', '', ''],
];

/**
 * 欠員 V001（3限のテイク）を作る。
 *   closed=false … **明日**の13:15開始。時刻に関係なく締切前（夜に回しても日付をまたいで壊れない）
 *   closed=true  … 今日・今から10分後に開始＝締切（30分前）を過ぎている
 */
var DAY = 0;
function setup(closed) {
  h.reset();
  DAY = closed ? 0 : 1;
  const D = T.dayJp(DAY);
  h.add('periods', closed
    ? { period: '3', start_time: T.hhmmIn(10), end_time: T.hhmmIn(100) }
    : { period: '3', start_time: '13:15', end_time: '14:45' });
  STAFFS.forEach(function (s) {
    h.add('staffs', {
      staff_id: s[0], name: s[1], role: s[2], skills: s[3],
      available_slots: s[4] ? D + s[4] : '',
    });
    h.add('contacts', { staff_id: s[0], name: s[1], email: s[0].toLowerCase() + '@example.jp' });
  });
  h.add('courses', {
    course_id: 'C001', quarter: '2026-後期', day: D, period: '3', support_type: 'テイク',
    user_student: '利用 学生', staff_a_id: 'S1', staff_b_id: 'S2',
  });
  h.add('courses', {
    course_id: 'C002', quarter: '2026-後期', day: D, period: '3', support_type: 'テイク',
    user_student: '別の 利用者', staff_a_id: 'S6', staff_b_id: '',
  });
  h.add('vacancies', { vacancy_id: 'V001', course_id: 'C001', date: T.dateIn(DAY), absent_staff_id: 'S1' });
}
function as(id) {
  const s = h.row('staffs', 'staff_id', id);
  h.setUser({ staff_id: id, name: s.name, role: s.role, email: id.toLowerCase() + '@example.jp' });
}
const vac = (id) => h.row('vacancies', 'vacancy_id', id);
const blockerFor = (vid, sid) => G.selfClaimBlocker_(vac(vid), h.row('staffs', 'staff_id', sid));

console.log('===== 自分から代行に入る（D50）検証 =====');

// ── 1) 空きコマ登録が無くても入れる ─────────────────────
h.section('1) 空きコマ登録の無い人が、自分から入って確定する');
setup(false);
h.check(!G.isCandidate_(h.row('courses', 'course_id', 'C001'), 'S4', T.dateIn(DAY)),
  '（S4 は空きコマ登録が無いので、代行依頼の候補ではない）');
h.check(blockerFor('V001', 'S4') === '', '★空きコマ登録が無くても入れる');
as('S4');
var r = G.claimVacancy('V001');
h.check(r.ok && r.confirmed, '確定する');
h.check(vac('V001').result === '補充済' && vac('V001').substitute_staff_id === 'S4', '補充済・代行 S4 になる');
h.check(h.notifiesOf('filled').length === 1, '承諾と同じく確定通知が1回出る');
var resp = h.db.responses.filter(function (x) { return x.vacancy_id === 'V001' && x.staff_id === 'S4'; })[0];
h.check(resp && resp.answer === '承諾', '欠員補充管理に出るよう、回答「承諾」として記録する');

// ── 2) 入れない人 ────────────────────────────────────────
h.section('2) 入れない人には理由を返し、何も書かない');
setup(false);
h.check(blockerFor('V001', 'S1') === 'あなたの欠勤です。', '★欠勤者本人は入れない');
h.check(blockerFor('V001', 'S2') === 'あなたが担当しているコマです。', '★相方は入れない（もう入っている）');
h.check(blockerFor('V001', 'S5').indexOf('対応できる業務') !== -1, '★スキルが合わない人は入れない');
h.check(blockerFor('V001', 'S6') === 'この時間は、あなたの別の担当か代行が入っています。',
  '★同じ時限に別のコマを担当している人は入れない（二重起用）');
h.check(blockerFor('V001', 'T1') === '代行に入れるのは学生スタッフだけです。', '★職員は入れない');
h.check(blockerFor('V001', 'S7') === '', 'skills 空欄（全対応・D9）は入れる');
as('S5');
r = G.claimVacancy('V001');
h.check(!r.ok && r.message.indexOf('対応できる業務') !== -1, 'claimVacancy も同じ理由を返す');
h.check(!String(vac('V001').result || '').trim(), '★入れない人が押しても result は空のまま');
h.check(h.db.responses.length === 0, '★回答も記録しない');
h.check(h.notifiesOf('filled').length === 0, '通知も出ない');

// ── 3) 先着 ──────────────────────────────────────────────
h.section('3) 先着：2人目は「埋まりました」');
setup(false);
as('S4');
G.claimVacancy('V001');
as('S3');
r = G.claimVacancy('V001');
h.check(!r.ok && r.filled, '★2人目は filled（他の人で決まった）');
h.check(vac('V001').substitute_staff_id === 'S4', '先に入った人のまま');
// 承諾（代行依頼から）との先着も同じ枠を取り合う
setup(false);
as('S3');
G.respondToVacancy('V001', '承諾');
as('S4');
r = G.claimVacancy('V001');
h.check(!r.ok && r.filled, '★代行依頼の承諾が先なら、自分から入るは filled');

// ── 4) 同じ時限に2つの欠員 ─────────────────────────────
h.section('4) 同じ時限の別の欠員には、もう入れない');
setup(false);
h.row('courses', 'course_id', 'C002').staff_b_id = 'S2b';
h.add('vacancies', { vacancy_id: 'V002', course_id: 'C002', date: T.dateIn(DAY), absent_staff_id: 'S6' });
as('S4');
G.claimVacancy('V001');
h.check(blockerFor('V002', 'S4') === 'この時間は、あなたの別の担当か代行が入っています。',
  '★同じ日・同じ時限の代行が確定済みなら、もう1つには入れない');

// ── 5) 締切・過去日 ──────────────────────────────────────
h.section('5) 締切を過ぎたら入れない・過ぎた日は入れない');
setup(true);   // 授業開始が10分後＝締切（30分前）を過ぎた
h.check(blockerFor('V001', 'S4') === CLOSED, '★締切後は入れない（職員へ連絡するよう案内する）');
as('S4');
r = G.claimVacancy('V001');
h.check(!r.ok && r.message === CLOSED && !String(vac('V001').result || '').trim(),
  'claimVacancy も締切で止まり、何も書かない');
setup(false);
vac('V001').date = T.dateIn(-1);
h.check(blockerFor('V001', 'S4') === 'この欠員は対象日を過ぎています。', '★過ぎた日の欠員には入れない');
setup(false);
vac('V001').result = '1人テイク';
h.check(blockerFor('V001', 'S4') === 'この欠員はすでに対応が決まっています。', '決着済みには入れない');

// ── 6) かたまり（D45）────────────────────────────────────
h.section('6) かたまりは全部の枠で入れる人だけ・確定は全部まとめて');
function setupBlock() {
  h.reset();
  const D = T.dayJp(1);   // 明日（時刻に関係なく締切前）
  h.add('periods', { period: '移動前2', start_time: '10:45', end_time: '11:00', support_types: '介助', label: '移動介助' });
  h.add('periods', { period: '2', start_time: '11:00', end_time: '12:30' });
  h.add('periods', { period: '移動後2', start_time: '12:30', end_time: '12:45', support_types: '介助', label: '移動介助' });
  [['S1', '欠勤する人', '介助'], ['S8', '介助できる', '介助'], ['S9', '移動後に別の担当', '介助'], ['S10', 'テイクだけ', 'テイク']]
    .forEach(function (x) {
      h.add('staffs', { staff_id: x[0], name: x[1], role: '学生', skills: x[2] });
      h.add('contacts', { staff_id: x[0], name: x[1], email: x[0].toLowerCase() + '@example.jp' });
    });
  [['CB1', '移動前2'], ['CB2', '2'], ['CB3', '移動後2']].forEach(function (c) {
    h.add('courses', {
      course_id: c[0], quarter: '2026-後期', day: D, period: c[1], support_type: '介助',
      user_student: '利用 学生', staff_a_id: 'S1',
    });
  });
  h.add('courses', {
    course_id: 'CX', quarter: '2026-後期', day: D, period: '移動後2', support_type: '介助',
    user_student: '別の 利用者', staff_a_id: 'S9',
  });
  ['CB1', 'CB2', 'CB3'].forEach(function (cid, i) {
    h.add('vacancies', {
      vacancy_id: 'VB' + (i + 1), course_id: cid, date: T.dateIn(1), absent_staff_id: 'S1', group_id: 'G1',
    });
  });
}
setupBlock();
h.check(blockerFor('VB2', 'S8') === '', 'すべての枠で入れる人は入れる');
h.check(blockerFor('VB2', 'S9') === 'この時間は、あなたの別の担当か代行が入っています。',
  '★移動後の枠だけ別の担当がある人は、かたまり全体に入れない');
h.check(blockerFor('VB2', 'S10').indexOf('対応できる業務') !== -1, 'スキルが合わない人は入れない');
as('S8');
r = G.claimVacancy('VB3');   // かたまりのどの欠員から押しても
h.check(r.ok && r.also_confirmed.length === 2, '★押した1件＋残り2件をまとめて確定する');
h.check(['VB1', 'VB2', 'VB3'].every(function (id) {
  return vac(id).result === '補充済' && vac(id).substitute_staff_id === 'S8';
}), '★かたまり3件とも S8 で補充済');

// ── 7) 欠員一覧 ──────────────────────────────────────────
h.section('7) 欠員一覧（getOpenVacancies）');
setupBlock();
h.add('courses', {
  course_id: 'CT', quarter: '2026-後期', day: T.dayJp(2), period: '2', support_type: 'テイク',
  user_student: '利用 学生', staff_a_id: 'S10', staff_b_id: 'S1',
});
h.add('vacancies', { vacancy_id: 'VT', course_id: 'CT', date: T.dateIn(2), absent_staff_id: 'S1' });
h.add('vacancies', { vacancy_id: 'VOLD', course_id: 'CT', date: T.dateIn(-7), absent_staff_id: 'S1' });
h.add('vacancies', { vacancy_id: 'VDONE', course_id: 'CT', date: T.dateIn(9), absent_staff_id: 'S1', result: '補充済' });
as('S8');
var list = G.getOpenVacancies();
h.check(list.items.length === 2, '★かたまり3件は1件にまとめ、過去日と決着済みは出さない');
var blk = list.items.filter(function (x) { return x.slots.length === 3; })[0];
h.check(blk && blk.slots.map(function (x) { return x.periodLabel; }).join(',').indexOf('移動介助') !== -1,
  'かたまりは枠を時限順に並べる');
h.check(blk.claimable === true && blk.reason === '', 'S8 はかたまりに入れる');
var take = list.items.filter(function (x) { return x.vacancy_id === 'VT'; })[0];
h.check(take && !take.claimable && take.reason.indexOf('対応できる業務') !== -1, 'テイクには入れない理由が付く');
h.check(list.items[0].date <= list.items[1].date, '日付の早い順');
h.check(/^\d{2}:\d{2}$/.test(blk.deadline), '締切の時刻を返す');
h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
h.add('contacts', { staff_id: 'T1', name: '職員', email: 't1@example.jp' });
as('T1');
list = G.getOpenVacancies();
h.check(list.isStaff && list.items.every(function (x) { return !x.claimable && !x.reason; }),
  '職員には「入る」も理由も出さない（確定は欠員補充管理）');

// ── 8) シフト表（getTimetable）───────────────────────────
h.section('8) シフト表の欠員に「入れるか」が付く');
setup(false);
as('S4');
var tt = G.getTimetable('');
var key = 'C001|' + T.dateIn(DAY);
h.check(tt.vacancy[key] && tt.vacancy[key].open.length === 1, 'まだ決まっていない欠員を open に載せる');
h.check(tt.vacancy[key].open[0].id === 'V001' && tt.vacancy[key].open[0].claimable === true,
  '★S4 には「入れる」が付く');
as('S5');
tt = G.getTimetable('');
h.check(!tt.vacancy[key].open[0].claimable && tt.vacancy[key].open[0].reason.indexOf('対応できる業務') !== -1,
  '入れない人には理由が付く');
as('T1');
tt = G.getTimetable('');
h.check(!tt.vacancy[key].open[0].claimable && tt.vacancy[key].open[0].reason === '',
  '職員には判定しない（欠員補充管理で確定する）');
// 決まったら open から消える
as('S4');
G.claimVacancy('V001');
tt = G.getTimetable('');
h.check(tt.vacancy[key].open.length === 0 && tt.vacancy[key].status === '補充済', '確定後は open が空になる');

process.exitCode = h.report();
