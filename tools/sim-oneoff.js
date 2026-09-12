/**
 * 単発コマ（D27）のロジック検証 — Node 上で実行する
 *
 *     node tools/sim-oneoff.js
 *
 * `courses.date` が入った行は「その日1回だけ」のコマ（特別授業・新入生説明会・就活説明会など）。
 * 毎週の時間割と同じ `courses` に同居させているので、**学期で絞っている経路**と
 * **曜日×時限で衝突を見ている経路**の両方が、単発を正しく扱えているかを見る。
 *
 * ここで確かめるのはサーバー側だけ。時間割の週表示（home.html `weekStateOf`）と
 * 入力画面の出し分けはブラウザでの確認が要る。
 */
const { Harness } = require('./gas-harness');

const h = new Harness();
h.load(['Constants.gs', 'Attendance.gs', 'Terms.gs', 'Vacancy.gs', 'Input.gs']);
const G = h.G;
const T = h.time;

// ── 下ごしらえ ──────────────────────────────────────────────
// 「今日」を含む学期を1つ置き、毎週コマと単発コマを同じ曜日・時限に並べる。
const TERM = '2026-前期';
const D = T.dayJp();            // 今日の曜日
const TOMORROW = T.dateIn(1);
const DAY_TOMORROW = T.dayJp(1);

function setup(startInMin) {
  h.reset();
  h.add('terms', {
    term_id: TERM, system: 'semester',
    start_date: T.dateIn(-60), end_date: T.dateIn(60),
  });
  h.add('periods', { period: '3', start_time: T.hhmmIn(startInMin), end_time: T.hhmmIn(startInMin + 90) });
  h.add('staffs', { staff_id: 'S1', name: '欠勤する人', role: '学生', skills: 'テイク', available_slots: '' });
  h.add('staffs', { staff_id: 'S2', name: '相方', role: '学生', skills: 'テイク', available_slots: '' });
  h.add('staffs', { staff_id: 'S3', name: '候補A', role: '学生', skills: 'テイク', available_slots: D + '3' });
  h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員', skills: '', available_slots: '' });
  h.setUser({ staff_id: 'T1', name: '職員', role: '職員' });
}
const asAbsentee = () => h.setUser({ staff_id: 'S1', name: '欠勤する人', role: '学生' });
const asStaff = () => h.setUser({ staff_id: 'T1', name: '職員', role: '職員' });

const base = {
  quarter: TERM, period: '3', support_type: 'テイク',
  user_student: '利用学生', staff_a_id: 'S1', staff_b_id: 'S2',
};

console.log('===== 単発コマ（D27）ロジック検証 =====');

// ── 1) 登録：曜日は実施日から導かれる ───────────────────────
h.section('1) 単発コマの登録（曜日は実施日から自動で決まる）');
setup(90);
let res = G.addCourse(Object.assign({}, base, { date: TOMORROW, day: '月' }));  // day はわざと嘘
h.check(res.ok === true, '単発コマを登録できる');
let row = h.row('courses', 'course_id', res.course_id);
h.check(row.date === TOMORROW, 'date に実施日が入る');
h.check(row.day === DAY_TOMORROW, '★曜日は実施日から導出される（画面が送った誤った曜日は使わない）');

h.section('1b) 実施日の形式チェック');
let threw = '';
try { G.addCourse(Object.assign({}, base, { date: '2026/09/30' })); } catch (e) { threw = e.message; }
h.check(/形式/.test(threw), 'YYYY-MM-DD 以外は登録できない');
threw = '';
try { G.addCourse(Object.assign({}, base, { date: '', day: '' })); } catch (e) { threw = e.message; }
h.check(/曜日/.test(threw), '毎週コマで曜日が無ければ従来どおり弾く');

// ── 2) 二重起用：単発同士は日付が違えばぶつからない ─────────
h.section('2) 二重起用チェック（開催回が実際に重なるときだけ弾く）');
setup(90);
const dayAfter = T.dateIn(2);
G.addCourse(Object.assign({}, base, { date: TOMORROW }));

threw = '';
try { G.addCourse(Object.assign({}, base, { date: TOMORROW, user_student: '別の利用学生' })); }
catch (e) { threw = e.message; }
h.check(/既に別のコマ/.test(threw), '同じ日・同じ時限の単発は二重起用として弾く');
h.check(threw.indexOf(TOMORROW) !== -1, 'エラー文に日付が出る（曜日だけだと特定できない）');

// 曜日が同じでも別の日なら通る（毎週扱いで弾いていた頃の誤判定）
let sameWeekdayOther = T.dateIn(8);   // 翌日の1週間後＝同じ曜日
threw = '';
try { G.addCourse(Object.assign({}, base, { date: sameWeekdayOther, user_student: '別の利用学生' })); }
catch (e) { threw = e.message; }
h.check(threw === '', '★同じ曜日・時限でも別の日付の単発なら登録できる');

h.section('2b) 毎週コマとは必ずぶつかる');
setup(90);
G.addCourse(Object.assign({}, base, { day: DAY_TOMORROW }));   // 毎週コマ
threw = '';
try { G.addCourse(Object.assign({}, base, { date: TOMORROW, user_student: '別の利用学生' })); }
catch (e) { threw = e.message; }
h.check(/既に別のコマ/.test(threw), '毎週コマが入っている枠に単発は入れられない');

setup(90);
G.addCourse(Object.assign({}, base, { date: TOMORROW }));       // 単発が先
threw = '';
try { G.addCourse(Object.assign({}, base, { day: DAY_TOMORROW, user_student: '別の利用学生' })); }
catch (e) { threw = e.message; }
h.check(/既に別のコマ/.test(threw), '単発が入っている枠に毎週コマも入れられない（逆も同じ）');

// ── 3) 欠勤連絡：単発は「その日」だけ ───────────────────────
h.section('3) 欠勤連絡（単発は実施日1日だけが対象）');
setup(90);
const once = G.addCourse(Object.assign({}, base, { date: TOMORROW })).course_id;
asAbsentee();
let mine = G.getMyCourses();
let mineOnce = mine.filter((c) => c.course_id === once)[0];
h.check(!!mineOnce, '担当している単発コマが欠勤連絡の選択肢に出る');
h.check(mineOnce.oneOffDate === TOMORROW, '実施日を画面へ渡す（欠勤日の候補を1日に絞るため）');

threw = '';
try { G.submitAbsence(once, T.dateIn(8)); } catch (e) { threw = e.message; }
h.check(/1回限り/.test(threw), '★実施日以外の日では欠勤登録できない（同じ曜日でも）');

let sub = G.submitAbsence(once, TOMORROW);
h.check(!!sub.vacancy_id, '実施日なら欠勤登録できる');
h.check(h.row('vacancies', 'vacancy_id', sub.vacancy_id).date === TOMORROW, '欠員に実施日が記録される');

// ── 4) 学期の外でも単発は成立する ───────────────────────────
h.section('4) 学期の開講期間の外にある単発（新入生説明会など）');
setup(90);
const outside = T.dateIn(70);        // 学期終了（+60日）より後
const ev = G.addCourse(Object.assign({}, base, { date: outside })).course_id;
asAbsentee();
mine = G.getMyCourses();
h.check(mine.some((c) => c.course_id === ev), '★学期の期間外でも欠勤連絡の選択肢に出る');
threw = '';
try { G.submitAbsence(ev, outside); } catch (e) { threw = e.message; }
h.check(threw === '', '★学期の開講期間チェックは単発には適用しない');

h.section('4b) 毎週コマは従来どおり開講期間で弾く');
setup(90);
const weekly = G.addCourse(Object.assign({}, base, { day: DAY_TOMORROW })).course_id;
asAbsentee();
threw = '';
// 曜日は合わせたうえで学期の外へ出す（+1 と同じ曜日で、学期終了 +60 より後）
try { G.submitAbsence(weekly, T.dateIn(64)); } catch (e) { threw = e.message; }
h.check(/開講期間/.test(threw),
  '毎週コマは学期の期間外を拒否する（従来の挙動を壊していない）：' + threw);

// ── 5) 過ぎた単発は出さない ─────────────────────────────────
h.section('5) 実施日が過ぎた単発は欠勤連絡に出ない');
setup(90);
h.add('courses', {
  course_id: 'C900', quarter: TERM, day: T.dayJp(-3), period: '3', support_type: 'テイク',
  user_student: '利用学生', staff_a_id: 'S1', staff_b_id: 'S2', date: T.dateIn(-3),
});
asAbsentee();
h.check(!G.getMyCourses().some((c) => c.course_id === 'C900'), '実施日を過ぎた単発は選択肢から消える');

// ── 6) 代行候補は従来どおりのロジック ───────────────────────
h.section('6) 欠員の代行候補は毎週コマと同じロジック（空きコマ × スキル）');
setup(90);
// 今日を実施日にして、候補 S3（今日の曜日の3限が空き）が拾えるか見る
const todayOnce = G.addCourse(Object.assign({}, base, { date: T.today() })).course_id;
asAbsentee();
sub = G.submitAbsence(todayOnce, T.today());
h.check(sub.candidates.length === 1 && sub.candidates[0].staff_id === 'S3',
  '★単発でも available_slots（曜日×時限）で候補を抽出する（仕様どおり従来ロジック）');
h.check(h.notifiesOf('new').length === 1, '代行依頼の通知が出る');

h.section('6b) 別の日の単発に入っている人は候補から外れない');
setup(90);
// S3 を「翌日の単発」に担当として入れる（今日の欠員とは別の回）
h.add('courses', {
  course_id: 'C901', quarter: TERM, day: DAY_TOMORROW, period: '3', support_type: 'テイク',
  user_student: '別の利用学生', staff_a_id: 'S3', staff_b_id: '', date: TOMORROW,
});
const todayOnce2 = G.addCourse(Object.assign({}, base, { date: T.today() })).course_id;
asAbsentee();
sub = G.submitAbsence(todayOnce2, T.today());
h.check(sub.candidates.some((c) => c.staff_id === 'S3'),
  '★別の日の単発に入っていても、今日の欠員の候補には残る');

// ── 7) 入力画面へ返すデータ ─────────────────────────────────
h.section('7) シフト入力の一覧（毎週が先・単発は日付順で後ろ）');
setup(90);
G.addCourse(Object.assign({}, base, { date: T.dateIn(5), user_student: 'イベントB' }));
G.addCourse(Object.assign({}, base, { date: T.dateIn(2), user_student: 'イベントA' }));
G.addCourse(Object.assign({}, base, { day: DAY_TOMORROW, user_student: '毎週の人' }));
asStaff();
const list = G.getInputData(TERM).courses;
h.check(list.length === 3, '3件が返る');
h.check(!list[0].date, '毎週のコマが先頭');
h.check(list[1].date === T.dateIn(2) && list[2].date === T.dateIn(5), '単発は日付の昇順で後ろに並ぶ');
h.check(list[1].user_student === 'イベントA', '日付順の中身も正しい');

// ── 8) セルの型ゆれを吸収する（10-6b の横展開）──────────────
// テキスト書式が掛かっていないシートでは '2026-09-12' が日付値として保存され、
// readRows が Date を返す。生の String() だと
// 'Sat Sep 12 2026 …' になり、時間割の照合が絶対に一致せず単発コマが消える。
h.section('8) date セルが Date でも実施日として読める');
h.check(G.courseDate_({ date: '2026-09-12' }) === '2026-09-12', '文字列はそのまま');
// Date は**サンドボックス側で**作る。ホスト側の new Date は別realmのオブジェクトになり、
// dateToStr_ の `instanceof Date` が false になってしまう（GAS は単一realmなので実機では起きない）。
h.check(G.courseDate_({ date: h.value('new Date(2026, 8, 12)') }) === '2026-09-12',
  '★Date でも yyyy-MM-dd になる');
h.check(G.courseDate_({ date: '2026-09-12T00:00:00.000Z' }) === '2026-09-12', 'ISO文字列も先頭10文字で揃う');
h.check(G.courseDate_({ date: '' }) === '', '空欄は空（毎週のコマ）');
h.check(G.courseDate_({}) === '', 'date 列が無い行も空');
h.check(G.courseDate_(null) === '', 'コマが無くても落ちない');

process.exitCode = h.report();
