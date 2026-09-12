/**
 * マイページ（D28）のロジック検証 — Node 上で実行する
 *
 *     node tools/sim-profile.js
 *
 * ここで一番大事なのは **「本人が変更できる項目の境界」がサーバー側で守られていること**。
 * 画面は信用しない前提なので、payload に role や name を混ぜても無視されること、
 * 更新対象が必ず Session の本人であることを確かめる。
 *
 * 次に大事なのが空きコマの正規化。実在しないスロット（土9 など）を通してしまうと、
 * その人は**永久に代行候補へ出ない**という静かな壊れ方をする（backlog 10-5 と同じ性質）。
 */
const { Harness } = require('./gas-harness');

const h = new Harness();
h.load(['Constants.gs', 'Attendance.gs', 'Terms.gs', 'Vacancy.gs', 'Forms.gs', 'Profile.gs']);
const G = h.G;
const T = h.time;

const OK_HOOK = 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t';

function setup() {
  h.reset();
  ['1', '2', '3'].forEach(function (p, i) {
    h.add('periods', { period: p, start_time: '0' + (9 + i * 2) + ':00', end_time: '0' + (10 + i * 2) + ':30' });
  });
  h.add('staffs', {
    staff_id: 'S101', name: '学生 太郎', role: '学生', skills: 'テイク',
    available_slots: '月1,火2', personal_code: 'Y200001',
  });
  h.add('staffs', { staff_id: 'T1', name: '職員 花子', role: '職員' });
  h.add('contacts', {
    staff_id: 'S101', name: '学生 太郎', email: 's101@example.ac.jp',
    phone: '090-1111-1111', webhook_url: OK_HOOK,
  });
  h.add('contacts', { staff_id: 'T1', name: '職員 花子', email: 't1@example.ac.jp' });
  h.add('staffs', {
    staff_id: 'S102', name: '別の学生', role: '学生', skills: 'テイク', available_slots: '月1',
  });
  h.add('contacts', { staff_id: 'S102', name: '別の学生', email: 's102@example.ac.jp', phone: '090-9999-9999' });
}
const asStudent = () => h.setUser({ staff_id: 'S101', name: '学生 太郎', role: '学生', email: 's101@example.ac.jp' });
const asStaff = () => h.setUser({ staff_id: 'T1', name: '職員 花子', role: '職員', email: 't1@example.ac.jp' });
const staffRow = (id) => h.row('staffs', 'staff_id', id);
const contactRow = (id) => h.row('contacts', 'staff_id', id);

console.log('===== マイページ（D28）ロジック検証 =====');

// ── 1) 表示 ────────────────────────────────────────────────
h.section('1) getMyProfile は自分の行だけを返す');
setup();
asStudent();
let p = G.getMyProfile();
h.check(p.staff_id === 'S101', '自分の staff_id');
h.check(p.name === '学生 太郎' && p.role === '学生', '氏名・区分を返す（表示は読み取り専用）');
h.check(p.phone === '090-1111-1111' && p.webhook_url === OK_HOOK, '連絡先を返す');
h.check(JSON.stringify(p.slots) === JSON.stringify(['月1', '火2']), '空きコマを配列で返す');
h.check(p.isStudent === true, '学生と判定される');
h.check(p.days.join('') === h.value('WORK_DAYS').join(''), '曜日は WORK_DAYS から');
h.check(p.periods.length === 3 && p.periods[0].period === '1', '時限は時限マスタから');
h.check(JSON.stringify(p).indexOf('090-9999-9999') === -1, '★他人の電話番号は一切含まない');
h.check(p.slots_updated_at === '', 'まだ本人が更新していないので空');

h.section('1b) 職員でも開ける（空きコマは対象外）');
asStaff();
p = G.getMyProfile();
h.check(p.isStudent === false, '職員と判定される');
h.check(p.staff_id === 'T1', '自分の行が返る');

h.section('1c) 未登録なら拒否');
h.setUser(null);
let threw = '';
try { G.getMyProfile(); } catch (e) { threw = e.message; }
h.check(/利用登録/.test(threw), '利用登録が無ければ例外');

// ── 2) 更新：本人の3項目だけ ───────────────────────────────
h.section('2) 変更できるのは 電話・Webhook・空きコマ の3つだけ');
setup();
asStudent();
let res = G.updateMyProfile({
  phone: '080-2222-2222',
  webhook_url: OK_HOOK,
  slots: ['水3', '月1'],
  // ↓ 画面が送ってきても無視されるべきもの
  name: '書き換えた名前',
  role: '職員',
  skills: 'テイク,介助',
  personal_code: 'HACKED',
  staff_id: 'S102',
  available_slots: '月1,月2,月3',
});
h.check(res.ok === true, '保存できる');
h.check(contactRow('S101').phone === '080-2222-2222', '電話が更新される');
h.check(staffRow('S101').name === '学生 太郎', '★氏名は書き換わらない（機能Bの照合キー・D7③）');
h.check(staffRow('S101').role === '学生', '★role は書き換わらない（権限昇格を防ぐ）');
h.check(staffRow('S101').skills === 'テイク', '★skills は書き換わらない（依頼の振り分けに関わる）');
h.check(staffRow('S101').personal_code === 'Y200001', '★personal_code は書き換わらない（勤怠の突合キー）');
h.check(contactRow('S101').email === 's101@example.ac.jp', '★メールは書き換わらない（本人を特定するキー）');

h.section('2b) staff_id は Session から取る（payload の id は見ない）');
h.check(staffRow('S102').available_slots === '月1', '★payload の staff_id で他人の行を書き換えられない');
h.check(contactRow('S102').phone === '090-9999-9999', '★他人の連絡先も無傷');

// ── 3) 空きコマの正規化 ────────────────────────────────────
h.section('3) 空きコマは並べ替えて保存し、実在しないスロットは弾く');
h.check(staffRow('S101').available_slots === '月1,水3', '曜日→時限の順に並べ替えて保存する');

setup(); asStudent();
G.updateMyProfile({ phone: '1', webhook_url: OK_HOOK, slots: ['火2', '火2', '月1'] });
h.check(staffRow('S101').available_slots === '月1,火2', '重複は1つにまとめる');

setup(); asStudent();
threw = '';
try { G.updateMyProfile({ phone: '1', webhook_url: OK_HOOK, slots: ['月9'] }); } catch (e) { threw = e.message; }
h.check(/時限が不正/.test(threw), '★時限マスタに無い時限は弾く（通すとその人は永久に候補へ出ない）');
h.check(staffRow('S101').available_slots === '月1,火2', '弾かれたときは元の値が残る');

threw = '';
try { G.updateMyProfile({ phone: '1', webhook_url: OK_HOOK, slots: ['日1'] }); } catch (e) { threw = e.message; }
h.check(/曜日が不正/.test(threw), 'WORK_DAYS に無い曜日は弾く');

setup(); asStudent();
res = G.updateMyProfile({ phone: '1', webhook_url: OK_HOOK, slots: [] });
h.check(staffRow('S101').available_slots === '', '空選択は「今期は空き無し」として受け付ける');
h.check(res.warnings.some(function (w) { return /候補に出ません/.test(w); }), '空なら注意を返す');

// ── 4) Webhook の検証 ──────────────────────────────────────
h.section('4) Webhook は形式が合うときだけ受け付ける');
setup(); asStudent();
threw = '';
try { G.updateMyProfile({ phone: '1', webhook_url: 'https://example.com/hook', slots: [] }); }
catch (e) { threw = e.message; }
h.check(/Webhook/.test(threw), '★Chat 以外のURLは弾く（他人のスペースへ飛ぶ事故を防ぐ）');
h.check(contactRow('S101').webhook_url === OK_HOOK, '弾かれたときは元の値が残る');

setup(); asStudent();
res = G.updateMyProfile({ phone: '090-1111-1111', webhook_url: '', slots: ['月1'] });
h.check(contactRow('S101').webhook_url === '', '空は「登録しない」として受け付ける');
h.check(res.warnings.some(function (w) { return /通知が届きません/.test(w); }), '空なら注意を返す');

// ── 5) 更新日時（D28：未更新者を職員が見分けるため）──────────
h.section('5) slots_updated_at は保存のたびに入る');
setup(); asStudent();
h.check(staffRow('S101').slots_updated_at === '', '最初は空');
res = G.updateMyProfile({ phone: '1', webhook_url: OK_HOOK, slots: ['月1', '火2'] });
h.check(!!staffRow('S101').slots_updated_at, '保存すると日時が入る');
h.check(res.slots_updated_at === staffRow('S101').slots_updated_at, '画面へ返す値とシートの値が一致する');
h.check(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(staffRow('S101').slots_updated_at),
  '文字列で入る（Date だと google.script.run が null にする）');

const before = staffRow('S101').slots_updated_at;
G.updateMyProfile({ phone: '1', webhook_url: OK_HOOK, slots: ['月1', '火2'] });
h.check(!!staffRow('S101').slots_updated_at,
  '内容が同じでも日時は入る（「今学期これで出し直した」という確認だから）');
h.check(typeof before === 'string', '（前回値は文字列）');

h.section('5b) 職員の保存では空きコマに触らない');
setup(); asStaff();
G.updateMyProfile({ phone: '06-1111-2222', webhook_url: OK_HOOK, slots: ['月1'] });
h.check(contactRow('T1').phone === '06-1111-2222', '職員も連絡先は更新できる');
h.check(!staffRow('T1').available_slots, '★職員の available_slots は書かない（意味を持たないため）');
h.check(!staffRow('T1').slots_updated_at, '職員には更新日時も入らない');

// ── 6) 名簿に行が無い場合 ──────────────────────────────────
h.section('6) 行が見つからないときは理由を返す');
setup();
h.setUser({ staff_id: 'S999', name: '幽霊', role: '学生', email: 'ghost@example.ac.jp' });
threw = '';
try { G.updateMyProfile({ phone: '1', webhook_url: OK_HOOK, slots: [] }); } catch (e) { threw = e.message; }
h.check(/連絡先の行が見つかりません/.test(threw), '職員に問い合わせるよう促す');

process.exitCode = h.report();
