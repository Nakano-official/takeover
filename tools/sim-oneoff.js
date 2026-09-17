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


// ── 9) 授業のあいだの「移動介助」の枠（D33）──────────────────
//
// 介助は授業間の移動を含むが、移動は時限に収まらない。時限マスタに
// support_types='介助' の行を足して表現する。テイクでこの枠に登録できてしまうと、
// テイクの空きコマ表に移動枠は無いので**代行候補が永久に0人**になる（エラーは出ない）。
h.section('9) 移動介助の枠は介助でしか選べない');
h.reset();
h.add('terms', { term_id: '2026-前期', system: 'semester', start_date: T.dateIn(-30), end_date: T.dateIn(30) });
h.add('periods', { period: '1', start_time: '09:15', end_time: '11:00' });
h.add('periods', { period: '移動1-2', start_time: '11:00', end_time: '11:15', support_types: '介助', label: '移動介助' });
h.add('periods', { period: '2', start_time: '11:15', end_time: '12:30' });
h.add('staffs', { staff_id: 'S1', name: '介助できる人', role: '学生', skills: '介助',
  available_slots: '', assist_slots: '月移動1-2' });
h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
h.setUser({ staff_id: 'T1', name: '職員', role: '職員' });

h.check(h.G.periodLabelOf_('1', h.row('periods', 'period', '1')) === '1限',
  'label が空なら従来どおり「1限」');
h.check(h.G.periodLabelOf_('移動1-2', h.row('periods', 'period', '移動1-2')) === '移動介助',
  '★label があればそれを呼び名にする（「移動1-2限」にしない）');

const movePayload = {
  quarter: '2026-前期', day: '月', period: '移動1-2',
  user_student: '利用 学生', staff_a_id: 'S1',
};
let blocked = false;
try {
  h.G.validateCoursePayload_(Object.assign({}, movePayload, { support_type: 'テイク' }));
} catch (e) { blocked = /移動介助 は テイク では選べません/.test(e.message); }
h.check(blocked, '★テイクを移動介助の枠に登録できない（サーバー側で弾く）');

let ok = null;
try {
  ok = h.G.validateCoursePayload_(Object.assign({}, movePayload, { support_type: '介助' }));
} catch (e) { ok = e.message; }
h.check(ok && ok.period === '移動1-2', '介助なら登録できる');

blocked = false;
try {
  h.G.validateCoursePayload_(Object.assign({}, movePayload, { support_type: '介助', period: '9' }));
} catch (e) { blocked = /存在しない時限/.test(e.message); }
h.check(blocked, '★時限マスタに無い時限は弾く');

// 候補抽出：移動枠のコマは assist_slots の「月移動1-2」で拾う
const moveCourse = {
  course_id: 'CM1', quarter: '2026-前期', day: '月', period: '移動1-2',
  support_type: '介助', user_student: '利用 学生', staff_a_id: '', staff_b_id: '',
};
h.check(h.G.findCandidates_(moveCourse, []).length === 1,
  '★移動枠の空きコマ（月移動1-2）を持つ人が候補に出る');

h.row('staffs', 'staff_id', 'S1').assist_slots = '月1';
h.check(h.G.findCandidates_(moveCourse, []).length === 0,
  '授業の時限が空いていても、移動枠の空きが無ければ候補に出ない');

// 入力画面へ渡す時限の選択肢
const ctx = h.G.getInputData('2026-前期');
const movePeriod = ctx.periods.filter(function (p) { return p.period === '移動1-2'; })[0];
h.check(movePeriod && movePeriod.label === '移動介助', '入力画面へ表示名を渡す');
h.check(JSON.stringify(movePeriod.supportTypes) === JSON.stringify(['介助']),
  '★その枠を選べる業務を渡す（画面はこれでプルダウンを絞る）');
const normal = ctx.periods.filter(function (p) { return p.period === '1'; })[0];
h.check(JSON.stringify(normal.supportTypes) === JSON.stringify(['テイク', '介助']),
  'support_types が空の時限は全業務で選べる');


// ── 10) 授業と直前の移動介助をまとめて登録する（D34）────────
//
// 介助は「授業の前の移動もその人が担当する」のが基本形なので、入力を2回に分けない。
// 直前の枠は**時刻でつながっているか**で引く（キーの名前を解析しない）。
// 職員がシートで枠を足したり時刻を変えたりしても追随できるようにするため。
h.section('10) 授業の前の移動介助をまとめて登録する');
h.reset();
h.add('terms', { term_id: '2026-前期', system: 'semester', start_date: T.dateIn(-30), end_date: T.dateIn(30) });
h.add('periods', { period: '移動前1', start_time: '08:45', end_time: '09:15', support_types: '介助', label: '移動介助' });
h.add('periods', { period: '1', start_time: '09:15', end_time: '11:00' });
h.add('periods', { period: '移動1-2', start_time: '11:00', end_time: '11:15', support_types: '介助', label: '移動介助' });
h.add('periods', { period: '2', start_time: '11:15', end_time: '12:30' });
h.add('staffs', { staff_id: 'S1', name: '介助 一郎', role: '学生', skills: '介助' });
h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
h.setUser({ staff_id: 'T1', name: '職員', role: '職員' });

// 直前の枠の引き当て
const before1 = h.G.precedingMovePeriod_('1', '介助');
h.check(before1 && before1.period === '移動前1', '★1限の直前は「移動前1」（時刻でつながっている）');
const before2 = h.G.precedingMovePeriod_('2', '介助');
h.check(before2 && before2.period === '移動1-2', '★2限の直前は「移動1-2」');
h.check(h.G.precedingMovePeriod_('1', 'テイク') === null,
  '★テイクでは移動枠を直前として扱わない（その業務で選べない枠のため）');
h.check(h.G.precedingMovePeriod_('移動前1', '介助') === null,
  '★移動枠そのものには「直前の移動枠」は無い（授業時限は直前扱いしない）');

// まとめ登録
const bundleBase = {
  quarter: '2026-前期', day: '月', period: '1', support_type: '介助',
  user_student: '利用 学生', staff_a_id: 'S1', room: 'A101', subject: '基礎数学',
};
let bundleRes = h.G.addCourse(Object.assign({}, bundleBase, { withMove: true }));
h.check(!!bundleRes.course_id && !!bundleRes.move_course_id, '授業と移動介助の2件が作られる');
h.check(h.db.courses.length === 2, 'courses は2行');

const cls = h.row('courses', 'course_id', bundleRes.course_id);
const mv = h.row('courses', 'course_id', bundleRes.move_course_id);
h.check(mv.period === '移動前1', '移動ぶんは直前の枠に入る');
h.check(mv.day === cls.day && mv.quarter === cls.quarter, '曜日・学期は授業と同じ');
h.check(mv.staff_a_id === 'S1', '★担当は授業と同じ人（その人が移動も担当するため）');
h.check(mv.user_student === '利用 学生', '利用者も同じ');
h.check(mv.room === 'A101', '★教室は授業の教室を引き継ぐ（＝移動先）');
h.check(mv.support_type === '介助', '内容は介助');
h.check(mv.note.indexOf('1限') !== -1, '備考で「1限の前の移動」と分かる');
h.check(!mv.subject, '科目名は引き継がない（移動そのものに科目は無い）');

// チェックを外したときは作らない
h.reset();
h.add('terms', { term_id: '2026-前期', system: 'semester', start_date: T.dateIn(-30), end_date: T.dateIn(30) });
h.add('periods', { period: '移動前1', start_time: '08:45', end_time: '09:15', support_types: '介助', label: '移動介助' });
h.add('periods', { period: '1', start_time: '09:15', end_time: '11:00' });
h.add('staffs', { staff_id: 'S1', name: '介助 一郎', role: '学生', skills: '介助' });
h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
h.setUser({ staff_id: 'T1', name: '職員', role: '職員' });
h.G.addCourse(bundleBase);
h.check(h.db.courses.length === 1, '★withMove を送らなければ授業だけ作る');

// 同じ担当が既に移動枠に入っていたら、授業ごと止める（片方だけ残さない）
h.G.addCourse(Object.assign({}, bundleBase, { period: '移動前1', user_student: '別の学生' }));
h.check(h.db.courses.length === 2, '移動枠に別コマを1件入れておく');
let bundleBlocked = false;
try {
  h.G.addCourse(Object.assign({}, bundleBase, { withMove: true, user_student: '三人目' }));
} catch (e) { bundleBlocked = /既に別のコマ/.test(e.message); }
h.check(bundleBlocked, '★移動ぶんが二重起用になるなら、授業を作る前に止める');
h.check(h.db.courses.length === 2, '★止めたときは授業も作らない（半分だけ登録しない）');

// 直前に移動枠が無い時限で withMove を送ったら理由を返す
h.add('periods', { period: '7', start_time: '20:10', end_time: '21:40' });
bundleBlocked = false;
try {
  h.G.addCourse(Object.assign({}, bundleBase, { period: '7', withMove: true, user_student: '四人目' }));
} catch (e) { bundleBlocked = /移動介助の枠がありません/.test(e.message); }
h.check(bundleBlocked, '直前に移動枠が無ければ理由を返す');

process.exitCode = h.report();
