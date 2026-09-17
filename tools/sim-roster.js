/**
 * スタッフ名簿（職員画面）のロジック検証 — Node 上で実行する
 *
 *     node tools/sim-roster.js
 *
 * この画面は読み取り専用なので、壊れ方は「書き換え」ではなく **見落とし**の側に出る。
 * 見ているのは3点。
 *
 *   1. **職員限定であること**。連絡先（メール・電話）を含むので学生に返してはいけない。
 *   2. **Webhook URL そのものを返さないこと**。届くかどうかだけ分かれば足り、
 *      URL は知っている人なら誰でも投稿できる値なので画面に出さない。
 *   3. **「欠けていること」を取りこぼさないこと**。空きコマ未登録・通知先なしは
 *      どちらも「動いているように見えて実は届かない」種類の壊れ方で、
 *      この画面が唯一の気づく場所になる。
 *   4. **個人コード（personal_code）を返さないこと**。機能Bを実装しない方針になり
 *      （2026-09-13）読む相手がいなくなった。列はシートに残っているので、うっかり
 *      画面へ戻さないようにここで固定する。
 */
const { Harness } = require('./gas-harness');

const h = new Harness();
h.load(['Constants.gs', 'Attendance.gs', 'Terms.gs', 'Vacancy.gs', 'Profile.gs',
  'Registration.gs', 'Roster.gs']);
const G = h.G;
const T = h.time;

const OK_HOOK = 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t';

const asStaff = () => h.setUser({ staff_id: 'T1', name: '職員 花子', role: '職員', email: 't1@example.ac.jp' });
const asStudent = () => h.setUser({ staff_id: 'S101', name: '完備 太郎', role: '学生', email: 's101@example.ac.jp' });
const rowOf = (res, id) => res.rows.filter((r) => r.staff_id === id)[0];

function setup() {
  h.reset();
  ['1', '2', '3'].forEach(function (p, i) {
    h.add('periods', { period: p, start_time: '0' + (9 + i * 2) + ':00', end_time: '0' + (10 + i * 2) + ':30' });
  });
  // 今日を含む学期（前期）と、それが内包するクォーター
  h.add('terms', { term_id: '2026-前期', system: 'semester', start_date: T.dateIn(-60), end_date: T.dateIn(60) });
  h.add('terms', { term_id: '2026-2Q', system: 'quarter', start_date: T.dateIn(-10), end_date: T.dateIn(40) });
  h.add('terms', { term_id: '2026-後期', system: 'semester', start_date: T.dateIn(120), end_date: T.dateIn(240) });

  h.add('staffs', { staff_id: 'T1', name: '職員 花子', role: '職員' });
  h.add('contacts', { staff_id: 'T1', name: '職員 花子', email: 't1@example.ac.jp' });

  // ① 何も欠けていない学生
  h.add('staffs', {
    staff_id: 'S101', name: '完備 太郎', role: '学生', skills: 'テイク',
    available_slots: '月1,火2', assist_slots: '', personal_code: 'Y200001',
    slots_updated_at: '2026-09-01 10:00:00',
  });
  h.add('contacts', {
    staff_id: 'S101', name: '完備 太郎', email: 's101@example.ac.jp',
    phone: '090-1111-1111', webhook_url: OK_HOOK,
  });

  // ② 承認直後の状態：通知先も電話も無い
  h.add('staffs', {
    staff_id: 'S102', name: '承認直後 次郎', role: '学生', skills: 'テイク,介助',
    available_slots: '水3', assist_slots: '水3', personal_code: '',
    slots_updated_at: '2026-09-02 09:00:00',
  });
  h.add('contacts', { staff_id: 'S102', name: '承認直後 次郎', email: 's102@example.ac.jp' });

  // ③ 職員が手で入れたまま本人が出し直していない（slots_updated_at が空）
  h.add('staffs', {
    staff_id: 'S103', name: '未更新 三郎', role: '学生', skills: '介助',
    available_slots: '', assist_slots: '木1', personal_code: 'Y200003', slots_updated_at: '',
  });
  h.add('contacts', {
    staff_id: 'S103', name: '未更新 三郎', email: 's103@example.ac.jp',
    phone: '090-3333-3333', webhook_url: OK_HOOK,
  });

  // ④ 空きコマが1つも無い＝代行候補に構造的に出てこない
  h.add('staffs', {
    staff_id: 'S104', name: '空きなし 四郎', role: '学生', skills: 'テイク',
    available_slots: '', personal_code: 'Y200004', slots_updated_at: '',
  });
  h.add('contacts', {
    staff_id: 'S104', name: '空きなし 四郎', email: 's104@example.ac.jp',
    phone: '090-4444-4444', webhook_url: OK_HOOK,
  });

  // ⑤ 名簿にはいるが連絡先DBに行が無い＝ログインできない
  h.add('staffs', {
    staff_id: 'S105', name: '連絡先なし 五郎', role: '学生', skills: 'テイク',
    available_slots: '金2', assist_slots: '', personal_code: 'Y200005',
    slots_updated_at: '2026-09-03 09:00:00',
  });

  // 担当コマ（今学期）
  h.add('courses', {
    course_id: 'C1', quarter: '2026-前期', day: '月', period: '1', support_type: 'テイク',
    user_student: '利用 学生', staff_a_id: 'S101', staff_b_id: 'S103',
  });
  h.add('courses', {
    course_id: 'C2', quarter: '2026-2Q', day: '火', period: '2', support_type: 'テイク',
    user_student: '利用 学生', staff_a_id: 'S101', staff_b_id: '',
  });
  // 別学期のコマは数えない
  h.add('courses', {
    course_id: 'C3', quarter: '2026-後期', day: '水', period: '3', support_type: '介助',
    user_student: '利用 学生', staff_a_id: 'S101', staff_b_id: '',
  });
  // 終わった単発コマは「今持っているコマ」ではない（D27）
  h.add('courses', {
    course_id: 'C4', quarter: '2026-前期', day: '木', period: '1', support_type: 'テイク',
    user_student: '利用 学生', staff_a_id: 'S101', staff_b_id: '', date: T.dateIn(-3),
  });
  // これからの単発コマは数える
  h.add('courses', {
    course_id: 'C5', quarter: '2026-前期', day: '金', period: '2', support_type: 'テイク',
    user_student: '利用 学生', staff_a_id: 'S101', staff_b_id: '', date: T.dateIn(3),
  });
}

console.log('===== スタッフ名簿（職員画面）ロジック検証 =====');

// ── 1) 権限 ────────────────────────────────────────────────
h.section('1) 職員限定');
setup();

asStudent();
let denied = false;
try { G.getStaffRoster(); } catch (e) { denied = /職員権限/.test(e.message); }
h.check(denied, '学生が呼ぶと職員権限エラーになる（連絡先を含むため）');

h.setUser(null);
denied = false;
try { G.getStaffRoster(); } catch (e) { denied = /利用登録/.test(e.message); }
h.check(denied, '未登録アカウントが呼ぶと利用登録エラーになる');

asStaff();
let res = G.getStaffRoster();
h.check(!!res && Array.isArray(res.rows), '職員なら一覧を取得できる');

// ── 2) 返す中身 ────────────────────────────────────────────
h.section('2) 返す中身');
h.check(res.rows.length === 6, '登録済みの全員（学生5・職員1）を返す');
h.check(res.rows.filter((r) => r.isStudent).length === 5, '学生スタッフが5人');

const s101 = rowOf(res, 'S101');
h.check(s101.name === '完備 太郎' && s101.role === '学生', '氏名と区分を返す');
h.check(s101.email === 's101@example.ac.jp' && s101.phone === '090-1111-1111',
  '連絡先DBのメール・電話を突き合わせて返す');
h.check(s101.hasWebhook === true, 'Webhook は「あるか」だけを返す');
h.check(JSON.stringify(res.rows).indexOf(OK_HOOK) === -1,
  'Webhook URL そのものは絶対に返さない（知っていれば誰でも投稿できる値のため）');
h.check(JSON.stringify(s101.slotsByType['テイク']) === JSON.stringify(['月1', '火2']),
  '空きコマを業務ごとの配列で返す（D32）');
h.check(s101.slotCount === 2, '件数は「その人が対応する業務」ぶんだけ数える');
h.check(s101.slotCounts.filter(function (c) { return c.type === '介助'; })[0].relevant === false,
  '★テイクだけの人にとって介助の空きコマは関係ない（relevant=false）');
h.check(s101.issues.length === 0, '何も欠けていない人は issues が空');

const t1 = rowOf(res, 'T1');
h.check(t1.isStudent === false, '職員は isStudent=false');
h.check(t1.issues.length === 0, '職員に学生向けの不足（空きコマ・個人コード等）は付かない');

h.check(res.rows[res.rows.length - 1].staff_id === 'T1', '学生を先に、職員を後ろに並べる');

// ── 3) 欠けていることの検出 ────────────────────────────────
h.section('3) 欠けていることの検出');
const has = (id, code) => rowOf(res, id).issues.indexOf(code) !== -1;

h.check(has('S102', 'webhook'), '通知先が無ければ webhook（代行依頼が届かない）');
h.check(has('S102', 'phone'), '電話が無ければ phone');
h.check(!has('S102', 'slots') && !has('S102', 'slotsStale'),
  '両方の業務に空きコマがあり本人の更新記録もあるなら空きコマ系の不足は出ない');

h.check(has('S103', 'slotsStale'), '空きコマはあるが slots_updated_at が空なら slotsStale');
h.check(!has('S103', 'slots'),
  '★介助だけの人はテイクの空きコマが空でも不足にしない（対応しない業務は関係ない）');

h.check(has('S104', 'slots'), '空きコマが1つも無ければ slots');
h.check(!has('S104', 'slotsStale'), 'slots が出ているときに slotsStale は重ねない');

h.check(has('S105', 'contact'), '連絡先DBに行が無ければ contact（ログインできない）');
h.check(rowOf(res, 'S105').hasContact === false, 'hasContact=false で行の強調に使える');
h.check(!has('S105', 'webhook') && !has('S105', 'phone'),
  '連絡先の行ごと無い人に「通知先なし」「電話なし」を重ねない（直す手順は行を作る1つだけ）');
h.check(rowOf(res, 'S105').slotCount === 1,
  '名簿（staffs）側の項目は連絡先の有無と無関係に見る');

// ── 4) サマリー ────────────────────────────────────────────
h.section('4) サマリー');
const sum = res.summary;
h.check(sum.total === 6 && sum.students === 5 && sum.staffMembers === 1, '人数の内訳');
h.check(sum.needsAction === 4, '不足がある学生は4人（S102・S103・S104・S105）');
h.check(sum.noWebhook === 1, '通知先なしは1人');
h.check(sum.noPhone === 1, '電話なしは1人');
h.check(sum.noSlots === 1, '空きコマ未登録は1人');
h.check(sum.slotsStale === 1, '本人未更新は1人');
h.check(sum.noContact === 1, 'ログイン不可は1人');

// 片方の業務だけ空きコマが空のとき
h.section('3b) 対応する業務のうち片方だけ空でも拾う（D32）');
setup();
h.row('staffs', 'staff_id', 'S101').skills = 'テイク,介助';   // 介助も担当するが assist_slots は空
asStaff();
let res2 = G.getStaffRoster();
const s101b = res2.rows.filter(function (r) { return r.staff_id === 'S101'; })[0];
h.check(s101b.issues.indexOf('slots') !== -1,
  '★テイクは埋まっていても介助が空なら「空きコマ未登録」を出す');
h.check(JSON.stringify(s101b.missingSlotTypes) === JSON.stringify(['介助']),
  '★足りないのがどの業務かを返す');
h.check(s101b.slotCounts.filter(function (c) { return c.type === '介助'; })[0].relevant === true,
  '介助も対応する人なので relevant=true');

// ── 5) 担当コマ数 ──────────────────────────────────────────
h.section('5) 担当コマ数');
h.check(res.termScope.indexOf('2026-前期') !== -1 && res.termScope.indexOf('2026-2Q') !== -1,
  '今日を含む前期と、それが内包する 2Q を対象にする（D16）');
h.check(res.termScope.indexOf('2026-後期') === -1, '今日を含まない後期は対象外');
h.check(rowOf(res, 'S101').courseCount === 3,
  '担当Aとして 前期C1・2QC2・これからの単発C5 の3コマ（後期C3と終わった単発C4は数えない）');
h.check(rowOf(res, 'S103').courseCount === 1, '担当Bでも1コマとして数える');
h.check(rowOf(res, 'S104').courseCount === 0, '担当が無ければ0');

// 学期が1つも解決できないときに全員0コマにならないこと
h.section('5b) 学期が解決できないとき');
setup();
h.db.terms.length = 0;      // terms 未整備
asStaff();
res = G.getStaffRoster();
h.check(res.termScope.length > 0, 'terms が空でも対象学期にフォールバックする');
h.check(rowOf(res, 'S101').courseCount > 0, '全員が0コマにならない');

// ── 6) 片側だけの行 ────────────────────────────────────────
h.section('6) 片側だけ残った行');
setup();
h.add('contacts', { staff_id: 'S999', name: '名簿なし 九郎', email: 's999@example.ac.jp' });
h.add('contacts', { staff_id: '', name: '', email: '' });   // 空行は無視する
asStaff();
res = G.getStaffRoster();
h.check(res.orphanContacts.length === 1, '名簿に行が無い連絡先を拾う（空行は数えない）');
h.check(res.orphanContacts[0].staff_id === 'S999', 'その staff_id が分かる');
h.check(rowOf(res, 'S105').issues.indexOf('contact') !== -1,
  '逆向き（staffs だけ）も各行の contact で分かる');

// ── 7) 承認待ち件数 ────────────────────────────────────────
h.section('7) 承認待ちの件数');
setup();
h.add('registrations', { registration_id: 'R001', email: 'a@example.ac.jp', name: 'A', status: '申請中' });
h.add('registrations', { registration_id: 'R002', email: 'b@example.ac.jp', name: 'B', status: '承認済' });
h.add('registrations', { registration_id: 'R003', email: 'c@example.ac.jp', name: 'C', status: '却下' });
asStaff();
res = G.getStaffRoster();
h.check(res.pendingRegistrations === 1, '申請中だけを数える（承認済・却下は数えない）');

// ── 8) 型の吸収 ────────────────────────────────────────────
h.section('8) シートの型を吸収する');
setup();
// slots_updated_at はセルの書式次第で Date になる。Date のまま返すと
// google.script.run が戻り値ごと null にするので、必ず文字列にしてから返す。
// （Date は harness 側ではなく**サンドボックス内**で作る。realm をまたぐと instanceof が効かない）
h.row('staffs', 'staff_id', 'S101').slots_updated_at = h.value('new Date(2026, 8, 1, 10, 0, 0)');
asStaff();
res = G.getStaffRoster();
h.check(typeof rowOf(res, 'S101').slots_updated_at === 'string' &&
  rowOf(res, 'S101').slots_updated_at.indexOf('2026-09-01') === 0,
  'Date の slots_updated_at を文字列に直して返す');
// 機能Bを実装しない以上、この列は画面に出さない（シートには残っている）
h.check(rowOf(res, 'S101').personal_code === undefined,
  '★個人コードは返さない（機能B未実装・2026-09-13）');
h.check(JSON.stringify(res).indexOf('Y200001') === -1,
  '★個人コードの値がレスポンスのどこにも混ざらない');

process.exitCode = h.report();
