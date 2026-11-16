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
h.load(['Constants.gs', 'Util.gs', 'Terms.gs', 'Vacancy.gs', 'Access.gs', 'ClassCalendar.gs', 'Cancellation.gs', 'Input.gs', 'Setup.js']);
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
h.check(/授業期間外/.test(threw),
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
// readRows_ が Date を返す。生の String() だと
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


// ── 9) 移動の枠はもう使わない（D57）──────────────────────────
//
// 以前は授業のあいだの移動介助を、時限マスタの support_types='介助' の行（移動の枠）として登録していた
// （D33〜D35）。15分の細い行が時間割を読みにくくするので 2026-11-16 にやめた。移動は介助のコマの印で持つ（D58）。
// 時限マスタの行は残すが、選択肢にも一覧にも出さず、新しく登録もさせない。残ったコマはまとめて消せる。
h.section('9) 移動の枠はもう使わない（D57）');
h.reset();
h.add('terms', { term_id: '2026-前期', system: 'semester', start_date: T.dateIn(-30), end_date: T.dateIn(30) });
h.add('periods', { period: '1', start_time: '09:15', end_time: '11:00' });
h.add('periods', { period: '移動1-2', start_time: '11:00', end_time: '11:15', support_types: '介助', label: '移動介助' });
h.add('periods', { period: '移動前2', start_time: '11:00', end_time: '11:15', support_types: '', label: '' });
h.add('periods', { period: '2', start_time: '11:15', end_time: '12:30' });
h.add('staffs', { staff_id: 'S1', name: '介助できる人', role: '学生', skills: '介助',
  available_slots: '', assist_slots: '月移動1-2' });
h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
h.setUser({ staff_id: 'T1', name: '職員', role: '職員' });

h.check(h.G.periodLabelOf_('1', h.row('periods', 'period', '1')) === '1限',
  'label が空なら従来どおり「1限」');
h.check(h.G.isMovePeriod_(h.row('periods', 'period', '移動1-2')), '介助だけの枠は移動の枠');
h.check(h.G.isMovePeriod_(h.row('periods', 'period', '移動前2')), '★キーが「移動前2」なら業務の指定が無くても移動の枠');
h.check(!h.G.isMovePeriod_(h.row('periods', 'period', '2')), '授業の時限は移動の枠ではない');

const movePayload = {
  quarter: '2026-前期', day: '月', period: '移動1-2',
  user_student: '利用 学生', staff_a_id: 'S1',
};
['テイク', '介助'].forEach(function (type) {
  let msg = '';
  try { h.G.validateCoursePayload_(Object.assign({}, movePayload, { support_type: type })); } catch (e) { msg = e.message; }
  h.check(/使わなくなりました/.test(msg), '★' + type + 'でも移動の枠には登録できない（印で付けるよう案内する）');
});

let blocked = false;
try {
  h.G.validateCoursePayload_(Object.assign({}, movePayload, { support_type: '介助', period: '9' }));
} catch (e) { blocked = /存在しない時限/.test(e.message); }
h.check(blocked, '★時限マスタに無い時限は弾く');

// 以前に登録した移動の枠のコマが残っていても、候補抽出は今まで通り動く（消すまでのあいだ）
const moveCourse = {
  course_id: 'CM1', quarter: '2026-前期', day: '月', period: '移動1-2',
  support_type: '介助', user_student: '利用 学生', staff_a_id: '', staff_b_id: '',
};
h.check(h.G.findCandidates_(moveCourse, []).length === 1,
  '残っている移動の枠のコマも、候補は今まで通り assist_slots で拾う');

// 入力画面へ渡す時限の選択肢と一覧
h.add('courses', { course_id: 'C001', quarter: '2026-前期', day: '月', period: '2', support_type: '介助',
  user_student: '利用 学生', staff_a_id: 'S1' });
h.add('courses', { course_id: 'C002', quarter: '2026-前期', day: '月', period: '移動1-2', support_type: '介助',
  user_student: '利用 学生', staff_a_id: 'S1' });
h.add('courses', { course_id: 'C003', quarter: '2026-前期', day: '火', period: '移動前2', support_type: '介助',
  user_student: '利用 学生', staff_a_id: 'S1' });
const ctx = h.G.getInputData();
h.check(ctx.periods.map(function (p) { return p.period; }).join() === '1,2', '★時限の選択肢に移動の枠を出さない');
h.check(JSON.stringify(ctx.periods[0].supportTypes) === JSON.stringify(['テイク', '介助']),
  'support_types が空の時限は全業務で選べる');
h.check(ctx.courses.map(function (c) { return c.course_id; }).join() === 'C001', '★一覧に移動の枠のコマを出さない');

// ── 10) 授業の前後の移動の枠を引く（D35）──────────────────────
//
// 移動の枠のコマはもう作らない（D57）が、以前に作ったものが残っているあいだは欠勤の「かたまり」（D45）が
// これで前後の移動を束ねる。2限のあと（食堂へ運ぶ＝2限の担当）と3限の前（＝3限の担当）は別の枠。
h.section('10) 授業の前後の移動の枠を引く（残っているコマのため）');
h.reset();
h.add('terms', { term_id: '2026-前期', system: 'semester', start_date: T.dateIn(-30), end_date: T.dateIn(30) });
h.add('periods', { period: '移動前2', start_time: '11:00', end_time: '11:15', support_types: '介助', label: '移動介助' });
h.add('periods', { period: '2', start_time: '11:15', end_time: '12:30' });
h.add('periods', { period: '移動後2', start_time: '12:30', end_time: '12:45', support_types: '介助', label: '移動介助' });
h.add('periods', { period: '移動前3', start_time: '13:15', end_time: '13:30', support_types: '介助', label: '移動介助' });
h.add('periods', { period: '3', start_time: '13:30', end_time: '15:00' });
h.add('staffs', { staff_id: 'S1', name: '介助 一郎', role: '学生', skills: '介助' });
h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
h.setUser({ staff_id: 'T1', name: '職員', role: '職員' });

h.check(h.G.precedingMovePeriod_('2', '介助').period === '移動前2', '2限の前は「移動前2」');
h.check(h.G.followingMovePeriod_('2', '介助').period === '移動後2', '★2限の後は「移動後2」');
h.check(h.G.precedingMovePeriod_('3', '介助').period === '移動前3', '★3限の前は「移動前3」');
h.check(h.G.followingMovePeriod_('3', '介助') === null, '3限の後には枠が無い');
h.check(h.G.precedingMovePeriod_('2', 'テイク') === null, 'テイクでは移動枠を対象にしない');
h.add('periods', { period: '1', start_time: '09:15', end_time: '11:00' });
h.check(h.G.followingMovePeriod_('1', '介助') === null,
  '★1限のあとに枠は無い（移動前2 を「1限のあと」と取り違えない）');

// 移動の同時作成はやめた。古い画面から送られてきても授業だけ作る
const bundleBase = {
  quarter: '2026-前期', day: '月', period: '2', support_type: '介助',
  user_student: '利用 学生', staff_a_id: 'S1', room: 'A101', subject: '英語I',
};
const added = h.G.addCourse(Object.assign({}, bundleBase, { withMoveBefore: true, withMoveAfter: true }));
h.check(h.db.courses.length === 1 && added.course_id === 'C001', '★移動の同時作成の指定が来ても、授業の1コマだけ作る');


// ── 10b) 移動は介助のコマの印として持つ（D58）────────────────────
//
// 移動介助は勤務時間に入る。別のコマにすると時間割がかさばるので、介助の授業のコマに
// 「前の移動あり／後の移動あり」の印を付け、勤務時間は時限マスタの移動の枠から計算する。
h.section('10b) 移動は介助のコマの印（D58）');
h.reset();
h.add('terms', { term_id: '2026-前期', system: 'semester', start_date: T.dateIn(-30), end_date: T.dateIn(30) });
h.add('periods', { period: '移動前2', start_time: '10:45', end_time: '11:00', support_types: '介助', label: '移動介助' });
h.add('periods', { period: '2', start_time: '11:00', end_time: '12:30' });
h.add('periods', { period: '移動後2', start_time: '12:30', end_time: '12:45', support_types: '介助', label: '移動介助' });
h.add('periods', { period: '3', start_time: '13:30', end_time: '15:00' });
h.add('staffs', { staff_id: 'S1', name: '介助 一郎', role: '学生', skills: 'テイク,介助' });
h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
h.setUser({ staff_id: 'T1', name: '職員', role: '職員', email: 't1@example.jp' });

const withMove = Object.assign({}, bundleBase, { move_before: true, move_after: true });
const flagged = h.G.addCourse(withMove);
const fc = h.row('courses', 'course_id', flagged.course_id);
h.check(h.db.courses.length === 1, '★印を付けてもコマは1つ（移動のコマは作らない）');
h.check(fc.move_before === 'あり' && fc.move_after === 'あり', 'シートには「あり」と書く（職員が読める言葉）');
h.check(h.G.courseWorkSpan_(fc).label === '10:45〜12:45', '★勤務時間は前の移動の始まり〜あとの移動の終わり');
h.check(h.G.courseTimeText_(fc) === '10:45〜12:45・移動を含む', '画面・通知の時刻は「移動を含む」と添える');
h.check(h.G.courseMoveText_(fc) === '授業の前とあとの移動', '移動の説明');
const onlyBefore = Object.assign({}, fc, { move_after: '' });
h.check(h.G.courseWorkSpan_(onlyBefore).label === '10:45〜12:30', '前だけなら 10:45〜12:30');
h.check(h.G.courseTimeText_(Object.assign({}, fc, { move_before: '', move_after: '' })) === '11:00〜12:30',
  '印が無ければ授業の時刻のまま（「移動を含む」は付けない）');
h.check(h.G.courseWorkSpan_(Object.assign({}, fc, { support_type: 'テイク' })).hasMove === false,
  'テイクには移動を足さない（シートを手で直して印が残っていても）');

let msg = '';
try { h.G.validateCoursePayload_(Object.assign({}, withMove, { support_type: 'テイク', user_student: '別' })); } catch (e) { msg = e.message; }
h.check(/介助のコマにだけ/.test(msg), '★テイクには移動を付けられない');
msg = '';
try { h.G.validateCoursePayload_(Object.assign({}, bundleBase, { period: '3', move_after: true, user_student: '別' })); } catch (e) { msg = e.message; }
h.check(/のあとの移動の枠がありません/.test(msg), '移動の枠が無い授業に付けようとしたら理由を返す');

// 編集で外せる
h.G.updateCourse(Object.assign({}, bundleBase, { course_id: flagged.course_id, move_before: true, move_after: false }));
h.check(h.row('courses', 'course_id', flagged.course_id).move_after === '', '編集で「後の移動」を外せる');

// 入力画面へ：授業の時限に前後の移動の枠を付けて渡す／コマに勤務時間を付ける
const ictx = h.G.getInputData();
const p2 = ictx.periods.filter(function (x) { return x.period === '2'; })[0];
h.check(p2.moveBefore && p2.moveBefore.time === '10:45〜11:00' && p2.moveAfter && p2.moveAfter.time === '12:30〜12:45',
  '入力画面へ、その授業の前後の移動の枠を渡す');
h.check(ictx.periods.filter(function (x) { return x.period === '3'; })[0].moveAfter === null, '3限のあとには枠が無い');
const ic = ictx.courses[0];
h.check(ic.move_before === true && ic.move_after === false && ic.workTime === '10:45〜12:30', 'コマに印と勤務時間を付ける');

// 締切は勤務の始まり（前の移動の始まり）から数える
h.reset();
h.add('terms', { term_id: '2026-前期', system: 'semester', start_date: T.dateIn(-30), end_date: T.dateIn(30) });
h.add('periods', { period: '移動前2', start_time: T.hhmmIn(25), end_time: T.hhmmIn(40), support_types: '介助', label: '移動介助' });
h.add('periods', { period: '2', start_time: T.hhmmIn(40), end_time: T.hhmmIn(130) });
const dc = { course_id: 'CX', period: '2', support_type: '介助', move_before: 'あり' };
h.check(!h.G.isPastRecruitDeadline_(T.today(), '2'), '授業の開始（40分後）だけで見ればまだ締切前');
h.check(h.G.isPastRecruitDeadline_(T.today(), dc), '★前の移動があれば移動の始まり（25分後）から30分前＝もう締切');
h.check(!h.G.isPastRecruitDeadline_(T.today(), Object.assign({}, dc, { move_before: '' })), '印が無ければ授業の開始から');


// ── 10c) 移動の枠のコマを印へ移し替える（GAS エディタから1回）──────────────
h.section('10c) 移動の枠のコマを印へ移し替える（D58）');
h.reset();
h.add('terms', { term_id: '2026-前期', system: 'semester', start_date: T.dateIn(-30), end_date: T.dateIn(30) });
h.add('periods', { period: '移動前2', start_time: '10:45', end_time: '11:00', support_types: '介助', label: '移動介助' });
h.add('periods', { period: '2', start_time: '11:00', end_time: '12:30' });
h.add('periods', { period: '移動後2', start_time: '12:30', end_time: '12:45', support_types: '介助', label: '移動介助' });
h.add('periods', { period: '昼の付き添い', start_time: '13:15', end_time: '13:30', support_types: '介助', label: '移動介助' });
h.add('periods', { period: '3', start_time: '13:30', end_time: '15:00' });
h.add('staffs', { staff_id: 'S1', name: '介助 一郎', role: '学生', skills: '介助' });
h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
const mc = (id, period, extra) => Object.assign({ course_id: id, quarter: '2026-前期', day: '月', period: period,
  support_type: '介助', user_student: '利用 学生', staff_a_id: 'S1' }, extra || {});
h.add('courses', mc('C001', '2'));
h.add('courses', mc('C002', '移動前2'));
h.add('courses', mc('C003', '移動後2'));                                   // 欠員の記録あり
h.add('courses', mc('C004', '移動前2', { user_student: '別の 学生' }));      // くっつく授業が無い
h.add('courses', mc('C005', '3'));
h.add('courses', mc('C006', '昼の付き添い'));                              // 宣言の無い枠は時刻でつなぐ
h.add('vacancies', { vacancy_id: 'V1', course_id: 'C003', date: T.dateIn(-7), absent_staff_id: 'S1', result: '補充済' });
// courses シートの列（ハーネスは列が揃っているので「足す」は起きない）
h.context.openMainDb_ = function () {
  return { getSheetByName: function () {
    const hs = h.headers.courses;
    return { getLastColumn: function () { return hs.length; },
      getRange: function () { return { getValues: function () { return [hs]; }, setValues: function () {} }; } };
  } };
};
h.setUser({ staff_id: 'T1', name: '職員', role: '職員', email: 't1@example.jp' });
const mig = h.G.migrateMoveCoursesToFlags();
h.check(mig.flagged === 3 && mig.deleted === 2 && mig.kept === 1 && mig.orphan === 1,
  '★印3件・削除2件・記録ありで残す1件・相手なし1件：' + JSON.stringify(mig));
const c1 = h.row('courses', 'course_id', 'C001');
h.check(c1.move_before === 'あり' && c1.move_after === 'あり', '★2限の授業に「前」「あと」の印が付く');
h.check(h.row('courses', 'course_id', 'C005').move_before === 'あり', '★宣言の無い枠も時刻でつないで3限の「前」に付く');
h.check(!h.row('courses', 'course_id', 'C002') && !h.row('courses', 'course_id', 'C006'), '印を付けた移動のコマは消す');
h.check(!!h.row('courses', 'course_id', 'C003'), '欠員の記録が付いた移動のコマは残す');
h.check(!!h.row('courses', 'course_id', 'C004'), 'くっつく授業が見つからない移動のコマは消さない');
const again = h.G.migrateMoveCoursesToFlags();
h.check(again.flagged === 0 && again.deleted === 0, 'もう一度実行しても何も変わらない');
h.deployerEmail = 'deployer@example.jp';
let denied = '';
try { h.G.migrateMoveCoursesToFlags(); } catch (e) { denied = e.message; }
h.check(/スクリプトエディタ/.test(denied), '★画面からは実行できない（GAS エディタから実行する）');
h.deployerEmail = '';
h.setUser({ staff_id: 'T1', name: '職員', role: '職員' });

// ── 10d) 利用者の名前の書き方を揃える（D59）──────────────────
// 「龍谷太郎」「龍谷 太郎」「龍谷　太郎」が別の人にならないよう、空白を揃え、登録済みの書き方に寄せる。
h.section('10d) 利用者の名前の書き方を揃える（D59）');
h.reset();
h.add('terms', { term_id: '2026-前期', system: 'semester', start_date: T.dateIn(-30), end_date: T.dateIn(30) });
h.add('periods', { period: '1', start_time: '09:15', end_time: '10:45' });
h.add('periods', { period: '2', start_time: '11:00', end_time: '12:30' });
h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
h.setUser({ staff_id: 'T1', name: '職員', role: '職員', email: 't1@example.jp' });
const np = (period, name) => ({ quarter: '2026-前期', day: '月', period: period, support_type: 'テイク', user_student: name });
h.G.addCourse(np('1', '  架空　 花子 '));
h.check(h.row('courses', 'course_id', 'C001').user_student === '架空 花子', '★全角・連続の空白は半角1つに揃える');
h.G.addCourse(np('2', '架空花子'));
h.check(h.row('courses', 'course_id', 'C002').user_student === '架空 花子', '★空白の無い書き方でも、登録済みの「架空 花子」に寄せる');
let nm = '';
try { h.G.addCourse(np('2', '<b>架空</b>')); } catch (e) { nm = e.message; }
h.check(/使えない記号/.test(nm), '名前に使えない記号は弾く');
// 登録済みのばらつき（シートを手で直した・以前の入力）
h.add('courses', Object.assign({ course_id: 'C010' }, np('1', '仮名太郎'), { day: '火' }));
h.add('courses', Object.assign({ course_id: 'C011' }, np('2', '仮名　太郎'), { day: '火' }));
h.add('courses', Object.assign({ course_id: 'C012' }, np('1', '仮名 太郎'), { day: '水' }));
h.check(h.G.getInputData().users.join() === '仮名 太郎,架空 花子', '★利用者の候補は空白の違いを1人にまとめる（「姓 名」の形で出す）');
const plan = h.G.previewUserStudentNames();
h.check(plan.length === 1 && plan[0].to === '仮名 太郎' && plan[0].from.length === 2 && plan[0].count === 3,
  '揃える案を出す（書き換えはしない）：' + JSON.stringify(plan));
h.check(h.row('courses', 'course_id', 'C010').user_student === '仮名太郎', '案を出すだけでは書き換えない');
const fixed = h.G.fixUserStudentNames();
h.check(fixed.courses === 2 && ['C010', 'C011', 'C012'].every(function (id) {
  return h.row('courses', 'course_id', id).user_student === '仮名 太郎'; }), '★揃えると全部「仮名 太郎」になる');
h.check(h.G.previewUserStudentNames().length === 0, 'もう揃えるものは無い');
h.setUser({ staff_id: 'T1', name: '職員', role: '職員' });


// ── 11) 担当未定のまま授業だけ登録できる（D38）──────────────
//
// 実務では授業（科目・教室・教員・利用学生・曜日時限）が学期開始前に確定し、
// 担当の割り当ては学生の空きコマが集まってから決まる。担当を必須にしていたせいで、
// 決まる前は「仮の担当」を入れるしかなく、本番の全コマが職員アカウント名義になっていた。
//
// 空の担当が既存ロジックを壊さないことを、経路ごとに固定しておく。
h.section('11) 担当未定のまま授業だけ登録できる');
h.reset();
h.add('terms', { term_id: '2026-前期', system: 'semester', start_date: T.dateIn(-30), end_date: T.dateIn(30) });
h.add('periods', { period: '1', start_time: '09:15', end_time: '10:45' });
h.add('staffs', { staff_id: 'S1', name: '学生 一郎', role: '学生', skills: 'テイク', available_slots: '月1' });
h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
h.add('contacts', { staff_id: 'S1', name: '学生 一郎', phone: '090-0000-0000' });
h.setUser({ staff_id: 'T1', name: '職員', role: '職員' });

const bare = {
  quarter: '2026-前期', day: '月', period: '1', support_type: 'テイク',
  user_student: '利用 学生', subject: 'フーリエ解析', room: '1-542',
};
const bareRes = h.G.addCourse(bare);
h.check(!!bareRes.course_id, '★担当を選ばなくても登録できる');
const bareRow = h.row('courses', 'course_id', bareRes.course_id);
h.check(bareRow.staff_a_id === '' && bareRow.staff_b_id === '', '担当は空のまま保存される');
h.check(bareRow.subject === 'フーリエ解析', '授業の情報は入る');

// Bだけ選んだらAへ寄せる（人が読んだときに「1人ならA」で揃う）
const bRes = h.G.addCourse(Object.assign({}, bare, {
  day: '火', staff_b_id: 'S1', user_student: '別の学生',
}));
const bRow = h.row('courses', 'course_id', bRes.course_id);
h.check(bRow.staff_a_id === 'S1' && bRow.staff_b_id === '', '★Bだけ選ばれたらAへ寄せる');

// 既存ロジックが空の担当で壊れないこと
h.section('11b) 担当未定のコマが既存ロジックを壊さない');
const unassigned = h.row('courses', 'course_id', bareRes.course_id);
h.check(h.G.findCandidates_(unassigned, [unassigned.staff_a_id, unassigned.staff_b_id]).length === 1,
  '★候補抽出：空の担当を除外扱いにして、条件の合う学生を拾う');
h.check(h.G.isAssigned_(unassigned, 'S1') === false, '担当判定：空の担当は誰とも一致しない');

// 欠勤連絡：担当者本人しか出せないので、担当未定のコマは出てこない
h.setUser({ staff_id: 'S1', name: '学生 一郎', role: '学生' });
const myList = h.G.getMyCourses();
h.check(myList.filter(function (c) { return c.course_id === bareRes.course_id; }).length === 0,
  '★欠勤連絡に担当未定のコマは出ない（担当者本人しか出せないので当然そうなる）');
h.setUser({ staff_id: 'T1', name: '職員', role: '職員' });

// 二重起用チェックは空を飛ばす（担当未定のコマが他の登録を邪魔しない）
const okRes = h.G.addCourse(Object.assign({}, bare, { staff_a_id: 'S1', user_student: '三人目' }));
h.check(!!okRes.course_id, '★同じ枠に担当未定のコマがあっても、実在の担当で登録できる');

process.exitCode = h.report();
