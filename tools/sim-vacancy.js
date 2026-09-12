/**
 * 欠員補充（機能A）のロジック検証 — Node 上で実行する
 *
 *     node tools/sim-vacancy.js
 *
 * `src/Constants.gs` / `Attendance.gs`（時刻パースのため）/ `Vacancy.gs` を**そのまま**読み込み、
 * Sheets・Notify・GAS ランタイムだけ差し替えて動かす（tools/gas-harness.js）。
 * clasp push もGASエディタも実スプレッドシートも要らないので、変更のたびに回せる。
 *
 * ここで見ているのは主に D21（締切）と D22（募集クローズ／決着は職員）と D25（辞退の扱い）。
 * 実 LockService の競合・実 Chat 送信・実カレンダーは**ここでは確かめられない**ので、
 * GAS 側の `e2eVacancyFlow` / `e2eDeadlineFlow` が引き続き必要（役割分担は gas-harness.js の冒頭）。
 */
const { Harness } = require('./gas-harness');

const h = new Harness();
h.load(['Constants.gs', 'Attendance.gs', 'Vacancy.gs']);
const G = h.G;
const T = h.time;

/**
 * 授業開始を「今から startInMin 分後」に置いた状態を作る。
 * 締切は開始30分前（RECRUIT_DEADLINE_MIN_BEFORE）なので：
 *   startInMin > 30 → まだ募集する ／ startInMin <= 30 → 締切超過
 */
function setup(startInMin) {
  h.reset();
  const D = T.dayJp();
  h.add('periods', { period: '3', start_time: T.hhmmIn(startInMin), end_time: T.hhmmIn(startInMin + 90) });
  h.add('staffs', { staff_id: 'S1', name: '欠勤する人', role: '学生', skills: 'テイク', available_slots: '' });
  h.add('staffs', { staff_id: 'S2', name: '相方', role: '学生', skills: 'テイク', available_slots: '' });
  h.add('staffs', { staff_id: 'S3', name: '候補A', role: '学生', skills: 'テイク', available_slots: D + '3' });
  h.add('staffs', { staff_id: 'S4', name: '候補B', role: '学生', skills: 'テイク', available_slots: D + '3' });
  h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員', skills: '', available_slots: '' });
  h.add('courses', {
    course_id: 'C001', quarter: '2026-前期', day: D, period: '3', support_type: 'テイク',
    user_student: '利用学生', staff_a_id: 'S1', staff_b_id: 'S2',
  });
  h.add('contacts', { staff_id: 'S3', name: '候補A', phone: '090-1111-1111' });
  h.add('contacts', { staff_id: 'S4', name: '候補B', phone: '090-2222-2222' });
  h.setUser({ staff_id: 'S1', name: '欠勤する人', role: '学生' });
}
const asStaff = () => h.setUser({ staff_id: 'T1', name: '職員', role: '職員' });
const asCandidateA = () => h.setUser({ staff_id: 'S3', name: '候補A', role: '学生' });
/** 授業開始を動かす（時間の経過を再現する） */
function moveClassTo(minutes) {
  const p = h.row('periods', 'period', '3');
  p.start_time = T.hhmmIn(minutes);
  p.end_time = T.hhmmIn(minutes + 90);
}
const vac = (id) => h.row('vacancies', 'vacancy_id', id);
const isBlank = (v) => !String(v || '').trim();

console.log('===== 欠員補充（機能A）ロジック検証 =====');

// ── 1) 締切前・候補あり：従来どおり募集する ─────────────────
h.section('1) 締切前（授業90分後）・候補2名 → 募集する');
setup(90);
let r = G.submitAbsence('C001', T.today());
h.check(r.candidates.length === 2, '候補2名を抽出する');
h.check(!r.recruitClosed, '募集クローズにはならない');
h.check(h.notifiesOf('new').length === 1, '代行依頼の通知が1回出る');
h.check(isBlank(vac(r.vacancy_id).result), 'result は空（未解決）');
h.check(isBlank(vac(r.vacancy_id).close_notified_at), 'close_notified_at は空（まだ募集中）');

// ── 2) 締切超過の直前欠勤：募集せず、決着もしない（D21 + D22）──
h.section('2) 締切超過（授業10分後）→ 募集しない・result は書かない');
setup(10);
r = G.submitAbsence('C001', T.today());
h.check(r.lateAbsence === true, '直前欠勤として扱う');
h.check(r.recruitClosed === true, '募集はクローズされる');
h.check(r.candidates.length === 0, '候補へ依頼を送らない');
h.check(r.suggestion === '1人テイク', '相方 S2 が残るので「1人テイク」を提案する');
h.check(r.autoResult === undefined, '自動決着の結果は返さない（D22 で撤去）');
h.check(isBlank(vac(r.vacancy_id).result), '★result は空のまま＝職員の決着待ち');
h.check(!isBlank(vac(r.vacancy_id).close_notified_at), 'close_notified_at にクローズ時刻が入る');
let n = h.notifiesOf('recruitClosed');
h.check(n.length === 1 && n[0].reason === 'past_deadline', '職員へ past_deadline で通知する');
h.check(h.notifiesOf('new').length === 0, '候補への依頼通知は出ない');

// ── 3) 候補0人：同じく募集クローズのみ（旧D10）──────────────
h.section('3) 候補0人（締切前）→ 募集クローズのみ・result は書かない');
setup(90);
h.db.staffs.forEach((s) => { s.available_slots = ''; }); // 誰も空いていない
r = G.submitAbsence('C001', T.today());
h.check(r.recruitClosed === true, '募集クローズになる');
h.check(r.suggestion === '1人テイク', '相方が残るので「1人テイク」を提案する');
h.check(isBlank(vac(r.vacancy_id).result), '★result は空のまま＝職員の決着待ち');
n = h.notifiesOf('recruitClosed');
h.check(n.length === 1 && n[0].reason === 'no_candidates', '職員へ no_candidates で通知する');

h.section('3b) 1名コマ（相方なし）→「職員対応」を提案する');
setup(90);
h.row('courses', 'course_id', 'C001').staff_b_id = '';
h.row('courses', 'course_id', 'C001').support_type = '介助';
h.db.staffs.forEach((s) => { s.available_slots = ''; });
r = G.submitAbsence('C001', T.today());
h.check(r.suggestion === '職員対応', '誰も残らないので「職員対応」を提案する');
h.check(isBlank(vac(r.vacancy_id).result), 'それでも result は書かない');

// ── 4) 募集中に締切へ到達 → トリガーがクローズする（D22 の中核）──
h.section('4) 募集中に締切到達 → closeExpiredRecruits がクローズ（result は書かない）');
setup(90);
r = G.submitAbsence('C001', T.today());
const vid = r.vacancy_id;
const course = h.row('courses', 'course_id', 'C001');
h.check(!G.isRecruitClosed_(vac(vid), course), '締切前は「クローズ」と判定されない');

moveClassTo(10); // 授業開始が10分後＝締切（30分前）を過ぎた
h.check(G.isRecruitClosed_(vac(vid), course), '締切後は「クローズ」と判定される（保存ではなく毎回算出）');

h.notifyLog.length = 0;
let tick = G.closeExpiredRecruits();
h.check(tick.scanned === 1, '締切超過の未決着欠員を1件拾う');
h.check(tick.notified.length === 1 && tick.notified[0] === vid, '職員へ通知した欠員として記録する');
h.check(isBlank(vac(vid).result), '★トリガーは result を書かない');
h.check(!isBlank(vac(vid).close_notified_at), 'close_notified_at が入る');
n = h.notifiesOf('recruitClosed');
h.check(n.length === 1 && n[0].reason === 'deadline_reached', '職員へ deadline_reached で通知する');
h.check(n[0].suggestion === '1人テイク', '決着の提案を通知に添える');

tick = G.closeExpiredRecruits();
h.check(tick.scanned === 0, '★2回目は同じ欠員を拾わない（二重通知しない）');

// ── 5) 締切後は候補が回答できない ───────────────────────────
h.section('5) 締切後の回答は受け付けない');
asCandidateA();
let ans = G.respondToVacancy(vid, '承諾');
h.check(ans.ok === false && ans.deadline === true, '承諾は「締切で終了」として弾かれる');
h.check(isBlank(vac(vid).result), '弾かれた承諾で result が埋まらない');
h.check(G.getVacancyForRespond(vid).deadlineClosed === true, '回答画面に deadlineClosed が立つ');

// ── 6) 締切前なら従来どおり先着確定できる（D1）──────────────
h.section('6) 締切前の承諾は先着確定する');
setup(90);
r = G.submitAbsence('C001', T.today());
asCandidateA();
ans = G.respondToVacancy(r.vacancy_id, '承諾');
h.check(ans.ok === true && ans.confirmed === true, '承諾が通る');
h.check(vac(r.vacancy_id).result === '補充済', 'result に「補充済」が入る');
h.check(vac(r.vacancy_id).substitute_staff_id === 'S3', '代行者が記録される');

// ── 7) 辞退した候補は電話番号を出さない（D25）───────────────
h.section('7) 辞退した候補には電話番号を出さない（manage）');
setup(90);
r = G.submitAbsence('C001', T.today());
asCandidateA();
G.respondToVacancy(r.vacancy_id, '辞退');
asStaff();
let row = G.getVacanciesForManage().filter((x) => x.vacancy_id === r.vacancy_id)[0];
const candA = row.candidates.filter((c) => c.staff_id === 'S3')[0];
const candB = row.candidates.filter((c) => c.staff_id === 'S4')[0];
h.check(candA.answer === '辞退', '辞退が記録されている');
h.check(candA.phone === '', '★辞退した候補の電話番号は返さない');
h.check(candB.answer === '', '未回答の候補はそのまま');
h.check(candB.phone === '090-2222-2222', '未回答の候補には電話番号を出す');
h.check(row.awaitingDecision === false, '締切前なので決着待ちではない');

// ── 8) 決着待ちのフラグと提案 ───────────────────────────────
h.section('8) 締切後・未決着は awaitingDecision と suggestion を返す');
moveClassTo(10);
row = G.getVacanciesForManage().filter((x) => x.vacancy_id === r.vacancy_id)[0];
h.check(row.awaitingDecision === true, '★awaitingDecision が立つ（画面の最上位に出す）');
h.check(row.suggestion === '1人テイク', '決着の提案を返す');
h.check(row.result === '', 'result は空のまま');

G.setVacancyResult(r.vacancy_id, '1人テイク');
row = G.getVacanciesForManage().filter((x) => x.vacancy_id === r.vacancy_id)[0];
h.check(row.result === '1人テイク', '職員の決着で result が入る');
h.check(row.awaitingDecision === false, '決着後は決着待ちから外れる');

// ── 9) 再オープンの挙動（締切前／締切後・D22/D26）────────────
h.section('9) 再オープン：締切前は再募集する／締切後は再募集しない');
setup(90);
r = G.submitAbsence('C001', T.today());
asStaff();
G.setVacancyResult(r.vacancy_id, '1人テイク');
h.notifyLog.length = 0;
let re = G.reopenVacancy(r.vacancy_id);
h.check(re.pastDeadline === false, '締切前の再オープン');
h.check(h.notifiesOf('new').filter((x) => x.reopened).length === 1, '締切前は候補へ再募集を送る');
h.check(isBlank(vac(r.vacancy_id).close_notified_at),
  '締切前の再オープンでは close_notified_at を消す（もう一度クローズできる状態に戻す）');

moveClassTo(10);
G.closeExpiredRecruits();
G.setVacancyResult(r.vacancy_id, '職員対応');
h.notifyLog.length = 0;
re = G.reopenVacancy(r.vacancy_id);
h.check(re.pastDeadline === true, '締切後の再オープンと判定する');
h.check(h.notifiesOf('new').length === 0, '★締切後は再募集を送らない（候補は回答できないため）');
h.check(!isBlank(vac(r.vacancy_id).close_notified_at),
  '★close_notified_at を保持する（トリガーが二度目の決着要求を投げない）');
h.check(G.closeExpiredRecruits().scanned === 0, '再オープン後もトリガーは再通知しない');
row = G.getVacanciesForManage().filter((x) => x.vacancy_id === r.vacancy_id)[0];
h.check(row.awaitingDecision === true, '再オープンした欠員は「決着待ち」として再び最上位に出る');

h.section('9b) 再オープンは職員のみ（D26）');
h.setUser({ staff_id: 'S3', name: '候補A', role: '学生' });
let threw = false;
try { G.reopenVacancy(r.vacancy_id); } catch (e) { threw = true; }
h.check(threw, '学生スタッフからの再オープンは拒否される');

// ── 10) 導入前から残る過去日の欠員は通知せずマークだけ ────────
h.section('10) 過去日の未決着欠員は通知せずマークのみ（初回実行の一斉通知を防ぐ）');
setup(90);
h.add('vacancies', {
  vacancy_id: 'V900', date: T.dateIn(-7), course_id: 'C001', absent_staff_id: 'S1',
  notify_status: '通知済',
});
h.notifyLog.length = 0;
tick = G.closeExpiredRecruits();
h.check(tick.marked.indexOf('V900') !== -1, '過去日の欠員はマーク扱いになる');
h.check(tick.notified.indexOf('V900') === -1, '★過去日の欠員では職員へ通知しない');
h.check(!isBlank(vac('V900').close_notified_at), 'マークは入る（次回以降拾わない）');
h.check(isBlank(vac('V900').result), '過去日でも result は書かない');

// ── 11) close_notified_at 列が無いDB（マイグレーション未実行）──
h.section('11) close_notified_at 列が無いDB（マイグレーション未実行）');
setup(10);
h.headers.vacancies = h.headers.vacancies.filter((x) => x !== 'close_notified_at');
tick = G.closeExpiredRecruits();
h.check(tick.errors.length === 1 && /close_notified_at/.test(tick.errors[0]),
  '例外で落ちず、列が無いことを理由として返す');
h.headers.vacancies.push('close_notified_at');

process.exitCode = h.report();
