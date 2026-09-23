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
h.load(['Constants.gs', 'Util.gs', 'Vacancy.gs']);
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

// ── 12) 空きコマは業務ごと（D32）────────────────────────────
//
// テイクと介助で空いている時間は違う。1本の available_slots で兼ねると
// 「テイクは空いているが介助はできない時間」に介助の依頼が飛ぶ。
// ここが壊れても**エラーは出ず、間違った人に通知が飛ぶ／誰にも飛ばない**だけなので、
// 候補の中身を名指しで固定しておく。
h.section('12) 候補抽出は業務ごとの空きコマで絞る');
setup(90);
const D12 = T.dayJp();
// 候補A＝テイクの時間だけ空き／候補B＝介助の時間だけ空き。両方とも両業務に対応できる。
h.row('staffs', 'staff_id', 'S3').skills = 'テイク,介助';
h.row('staffs', 'staff_id', 'S3').available_slots = D12 + '3';
h.row('staffs', 'staff_id', 'S3').assist_slots = '';
h.row('staffs', 'staff_id', 'S4').skills = 'テイク,介助';
h.row('staffs', 'staff_id', 'S4').available_slots = '';
h.row('staffs', 'staff_id', 'S4').assist_slots = D12 + '3';

const course12 = h.row('courses', 'course_id', 'C001');
const namesOf = (type) => {
  course12.support_type = type;
  return G.findCandidates_(course12, ['S1', 'S2']).map(function (c) { return c.staff_id; }).sort();
};

h.check(JSON.stringify(namesOf('テイク')) === JSON.stringify(['S3']),
  '★テイクのコマは available_slots で絞る（介助しか空いていない人は出ない）');
h.check(JSON.stringify(namesOf('介助')) === JSON.stringify(['S4']),
  '★介助のコマは assist_slots で絞る（テイクしか空いていない人は出ない）');

// 両方空いている人は両方に出る
h.row('staffs', 'staff_id', 'S3').assist_slots = D12 + '3';
h.check(JSON.stringify(namesOf('介助')) === JSON.stringify(['S3', 'S4']),
  '両方の空きコマを入れれば両方の候補に出る');

// skills は従来どおり別に効く（空きコマがあってもスキルが合わなければ出ない）
h.row('staffs', 'staff_id', 'S3').skills = 'テイク';
h.check(JSON.stringify(namesOf('介助')) === JSON.stringify(['S4']),
  'スキルの絞り込みは従来どおり重ねて効く');

// ── 12b) assist_slots 列がまだ無いDB ───────────────────────
//
// マイグレーション前は assist_slots を素直に読むと**介助の候補が全員ぶん消える**。
// エラーが出ないので「なぜか誰にも通知が飛ばない」としてしか現れない。
// 列が無いときは従来の1本へ寄せる（close_notified_at と同じ手当て）。
h.section('12b) assist_slots 列が無いDB（マイグレーション未実行）');
h.reset();
h.headers.staffs = h.headers.staffs.filter(function (c) { return c !== 'assist_slots'; });
setup(90);
h.row('staffs', 'staff_id', 'S3').skills = 'テイク,介助';
h.row('staffs', 'staff_id', 'S4').skills = 'テイク,介助';
const course12b = h.row('courses', 'course_id', 'C001');
course12b.support_type = '介助';
h.check(G.findCandidates_(course12b, ['S1', 'S2']).length === 2,
  '★列が無ければ available_slots へ寄せる（介助の候補が0人にならない）');
h.headers.staffs = h.headers.staffs.concat(['assist_slots']);

// ── 13) 欠勤は「授業＋前後の移動介助」のかたまりで出す（D45）──
//
// 介助の担当が休むと、授業だけでなく前後の移動も同じ人の仕事なので一緒に欠員になる。
// **1回の欠勤登録＝1つの募集＝1回の通知＝まとめて承諾**にする。
// 別々に募集すると、同じ欠勤で通知が3通飛び、別々の人が別々の枠を承諾しうる。
h.section('13) 欠勤のかたまり（授業＋前後の移動介助）');

function setupBlock(startInMin) {
  h.reset();
  const D = T.dayJp();
  h.add('periods', { period: '移動前2', start_time: T.hhmmIn(startInMin - 15), end_time: T.hhmmIn(startInMin), support_types: '介助', label: '移動介助' });
  h.add('periods', { period: '2', start_time: T.hhmmIn(startInMin), end_time: T.hhmmIn(startInMin + 90) });
  h.add('periods', { period: '移動後2', start_time: T.hhmmIn(startInMin + 90), end_time: T.hhmmIn(startInMin + 105), support_types: '介助', label: '移動介助' });

  const slots = D + '移動前2,' + D + '2,' + D + '移動後2';
  h.add('staffs', { staff_id: 'S1', name: '欠勤する人', role: '学生', skills: '介助', assist_slots: '' });
  // 全枠空いている人（まとめて受けられる）
  h.add('staffs', { staff_id: 'S3', name: '全部いける人', role: '学生', skills: '介助', assist_slots: slots });
  // 授業の時間しか空いていない人（まとめては受けられない）
  h.add('staffs', { staff_id: 'S4', name: '授業だけの人', role: '学生', skills: '介助', assist_slots: D + '2' });
  h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
  h.add('contacts', { staff_id: 'S3', name: '全部いける人', phone: '090-3333-3333' });
  h.add('contacts', { staff_id: 'S4', name: '授業だけの人', phone: '090-4444-4444' });

  [['CB1', '移動前2'], ['CB2', '2'], ['CB3', '移動後2']].forEach(function (c) {
    h.add('courses', {
      course_id: c[0], quarter: '2026-前期', day: D, period: c[1], support_type: '介助',
      user_student: '利用 学生', staff_a_id: 'S1', staff_b_id: '',
    });
  });
  h.setUser({ staff_id: 'S1', name: '欠勤する人', role: '学生' });
}

setupBlock(90);
let b = G.submitAbsence('CB2', T.today());
h.check(b.vacancy_ids.length === 3, '★1回の欠勤連絡で3件の欠員ができる（前・授業・後）');
h.check(h.db.vacancies.length === 3, 'vacancies は3行');

const gids = h.db.vacancies.map(function (v) { return String(v.group_id || ''); });
h.check(gids[0] && gids.every(function (g) { return g === gids[0]; }),
  '★3件が同じ group_id で束ねられる');

h.check(b.vacancy_id === b.vacancy_ids[1], '代表は授業そのもの（かたまりの中心）');
h.check(JSON.stringify(b.course.block).indexOf('移動介助') !== -1, '画面へ枠の一覧を返す');

h.check(b.candidates.length === 1 && b.candidates[0].staff_id === 'S3',
  '★候補は全枠に空きがある人だけ（授業の時間しか空いていない人は呼ばない）');
h.check(h.notifiesOf('new').length === 1, '★通知は1回だけ（3件ぶん送らない）');

// まとめて承諾
h.section('13b) 承諾1回でかたまり全部が確定する');
h.setUser({ staff_id: 'S3', name: '全部いける人', role: '学生' });
const acc = G.respondToVacancy(b.vacancy_id, '承諾');
h.check(acc.confirmed === true, '承諾できる');
h.check(acc.also_confirmed.length === 2, '★残り2件も一緒に確定する');
h.check(h.db.vacancies.every(function (v) {
  return String(v.result).trim() === '補充済' && String(v.substitute_staff_id).trim() === 'S3';
}), '★3件とも同じ人で補充済みになる（別の人に分かれない）');

// 一部だけ休む（移動だけ／授業だけ）も従来どおり出せる
h.section('13c) 一部だけの欠勤も出せる');
setupBlock(90);
const single = G.submitAbsence('CB2', T.today(), false);
h.check(single.vacancy_ids.length === 1, '★includeAttached=false なら1件だけ');
h.check(!String(h.row('vacancies', 'vacancy_id', single.vacancy_id).group_id || '').trim(),
  '単独の欠員に group_id は付けない（従来と同じ形）');
h.check(single.candidates.length === 2,
  '単独なら、その枠に空きがある人は全員候補（授業だけの人も呼べる）');

// 移動コマ単独の欠勤
setupBlock(90);
const moveOnly = G.submitAbsence('CB1', T.today());
h.check(moveOnly.vacancy_ids.length === 1,
  '★移動コマを選んだときは、その枠だけ（移動の前の移動、にはならない）');

// 二重登録の防止がかたまりに広がる
h.section('13d) かたまりの一部が既に出ていたら止める');
setupBlock(90);
G.submitAbsence('CB1', T.today());              // 移動だけ先に出しておく
let blocked = false;
try { G.submitAbsence('CB2', T.today()); } catch (e) { blocked = /既に登録されています/.test(e.message); }
h.check(blocked, '★かたまりのうち1件でも未解決で残っていれば、重ねて登録させない');

// 担当が違う移動は巻き込まない
h.section('13e) 担当が違う移動は巻き込まない');
setupBlock(90);
h.row('courses', 'course_id', 'CB3').staff_a_id = 'S4';   // 食堂への移動だけ別の人
h.setUser({ staff_id: 'S1', name: '欠勤する人', role: '学生' });
const partial = G.submitAbsence('CB2', T.today());
h.check(partial.vacancy_ids.length === 2,
  '★別の人が担当している移動は、かたまりに入れない（その人の仕事なので）');

process.exitCode = h.report();
