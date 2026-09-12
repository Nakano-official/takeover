/**
 * 利用登録の申請と承認（D28）のロジック検証 — Node 上で実行する
 *
 *     node tools/sim-registration.js
 *
 * ここで守りたい不変条件は2つ。
 *
 *   1. **承認するまで staffs / contacts に一切書かない。** 申請は registrations に溜まるだけ。
 *      ここが崩れると、大学アカウントを持つ誰でも自分を名簿に入れられてしまう。
 *   2. **role は申請者が決められない。** 承認時に職員が決める（既定は学生）。
 *      自己申告で職員になれると、連絡先DB全体が見える画面に入れてしまう。
 *
 * メールは常に Session から取る（画面が送る値は使わない）ことも合わせて確認する。
 */
const { Harness } = require('./gas-harness');

const h = new Harness();
h.load(['Constants.gs', 'Attendance.gs', 'Terms.gs', 'Vacancy.gs', 'Forms.gs', 'Profile.gs',
  'Registration.gs']);
const G = h.G;

const OK_HOOK = 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t';
const NEW_MAIL = 'newcomer@example.ac.jp';

function setup() {
  h.reset();
  ['1', '2', '3'].forEach(function (p, i) {
    h.add('periods', { period: p, start_time: '0' + (9 + i * 2) + ':00', end_time: '0' + (10 + i * 2) + ':30' });
  });
  // 既存の名簿（採番が S001 / S101 と衝突しないかも見る）
  h.add('staffs', { staff_id: 'S001', name: '職員 花子', role: '職員' });
  h.add('staffs', { staff_id: 'S101', name: '既存 学生', role: '学生', skills: 'テイク' });
  h.add('contacts', { staff_id: 'S001', name: '職員 花子', email: 'staff@example.ac.jp' });
  h.add('contacts', { staff_id: 'S101', name: '既存 学生', email: 'exist@example.ac.jp' });
}
const asNewcomer = () => h.setEmail(NEW_MAIL);
const asStaff = () => h.setUser({ staff_id: 'S001', name: '職員 花子', role: '職員', email: 'staff@example.ac.jp' });
const asStudent = () => h.setUser({ staff_id: 'S101', name: '既存 学生', role: '学生', email: 'exist@example.ac.jp' });
const reg = () => h.db.registrations[0];

const APPLY = {
  name: '新人 太郎', phone: '090-3333-3333', webhook_url: OK_HOOK,
  skills: 'テイク', slots: ['月1', '火2'], note: 'よろしくお願いします',
};

console.log('===== 利用登録の申請と承認（D28）ロジック検証 =====');

// ── 1) 申請画面のデータ ────────────────────────────────────
h.section('1) 未登録アカウントでも申請画面のデータが取れる');
setup(); asNewcomer();
let c = G.getSignupContext();
h.check(c.email === NEW_MAIL, 'メールは Session から取る');
h.check(c.alreadyRegistered === false, '名簿に無いので未登録と判定される');
h.check(c.status === '', 'まだ申請していない');
h.check(c.periods.length === 3 && c.days.length > 0, '空きコマの選択肢（曜日×時限）を返す');

h.section('1b) 登録済みの人には「登録済み」と返す');
h.setEmail('exist@example.ac.jp');
h.check(G.getSignupContext().alreadyRegistered === true, '名簿にあるので登録済み');

// ── 2) 申請：名簿には書かない ──────────────────────────────
h.section('2) 申請しても staffs / contacts には一切書かない');
setup(); asNewcomer();
const staffsBefore = h.db.staffs.length;
const contactsBefore = h.db.contacts.length;
let res = G.submitRegistration(APPLY);
h.check(res.ok === true, '申請できる');
h.check(h.db.registrations.length === 1, 'registrations に1件積まれる');
h.check(h.db.staffs.length === staffsBefore, '★staffs は増えない');
h.check(h.db.contacts.length === contactsBefore, '★contacts は増えない');
h.check(reg().status === '申請中', 'status は「申請中」');
h.check(reg().email === NEW_MAIL, '★メールは Session の値（画面の入力ではない）');
h.check(reg().slots === '月1,火2', '空きコマは正規化して保存する');
h.check(!!reg().applied_at, '申請日時が入る');

h.section('2b) 画面が email や status を送っても無視する');
setup(); asNewcomer();
G.submitRegistration(Object.assign({}, APPLY, {
  email: 'attacker@example.ac.jp', status: '承認済', staff_id: 'S999', role: '職員',
}));
h.check(reg().email === NEW_MAIL, '★email は上書きされない');
h.check(reg().status === '申請中', '★status は「申請中」のまま');
h.check(!reg().staff_id, '★staff_id は空のまま（承認時にしか入らない）');

h.section('2c) 入力の検証');
setup(); asNewcomer();
let threw = '';
try { G.submitRegistration(Object.assign({}, APPLY, { name: '' })); } catch (e) { threw = e.message; }
h.check(/氏名/.test(threw), '氏名が無ければ弾く');
threw = '';
try { G.submitRegistration(Object.assign({}, APPLY, { webhook_url: 'https://example.com/x' })); }
catch (e) { threw = e.message; }
h.check(/Webhook/.test(threw), 'Chat 以外のURLは弾く');
threw = '';
try { G.submitRegistration(Object.assign({}, APPLY, { slots: ['月9'] })); } catch (e) { threw = e.message; }
h.check(/時限が不正/.test(threw), '実在しない時限は弾く（Profile.gs と同じ検証）');
h.check(h.db.registrations.length === 0, '弾かれたときは何も積まれない');

h.section('2d) 登録済みの人は申請できない');
setup(); h.setEmail('exist@example.ac.jp');
threw = '';
try { G.submitRegistration(APPLY); } catch (e) { threw = e.message; }
h.check(/既に登録済み/.test(threw), '名簿にある人の申請は拒否する');

h.section('2e) 出し直しは同じ行を上書きする');
setup(); asNewcomer();
G.submitRegistration(APPLY);
const firstId = reg().registration_id;
res = G.submitRegistration(Object.assign({}, APPLY, { name: '新人 次郎' }));
h.check(h.db.registrations.length === 1, '★申請は1メール1件（重複して積まない）');
h.check(reg().registration_id === firstId, '同じ行を更新する');
h.check(reg().name === '新人 次郎', '内容が差し替わる');
h.check(res.resubmitted === true, '出し直しであることを返す');

// ── 3) 承認：ここだけが名簿に書く ──────────────────────────
h.section('3) 承認すると staffs と contacts に行ができる');
setup(); asNewcomer();
G.submitRegistration(APPLY);
const rid = reg().registration_id;
asStaff();
res = G.approveRegistration(rid);
h.check(res.ok === true, '承認できる');
h.check(res.staff_id === 'S102', '★既存の S101 の次で採番される（S001 とも衝突しない）');
const newStaff = h.row('staffs', 'staff_id', res.staff_id);
const newContact = h.row('contacts', 'staff_id', res.staff_id);
h.check(!!newStaff && !!newContact, 'staffs と contacts の両方に行ができる');
h.check(newStaff.name === '新人 太郎' && newContact.email === NEW_MAIL, '氏名とメールが入る');
h.check(newStaff.role === '学生', '★区分の既定は「学生」');
h.check(newStaff.available_slots === '月1,火2', '空きコマが引き継がれる');
h.check(!!newStaff.slots_updated_at, '本人の申告なので更新日時も入る（D28）');
h.check(newStaff.personal_code === '', '個人コードは空（職員が後から入れる）');
h.check(newContact.phone === '090-3333-3333' && newContact.webhook_url === OK_HOOK, '連絡先が入る');
h.check(reg().status === '承認済' && reg().staff_id === res.staff_id, '申請に結果が記録される');
h.check(reg().decided_by === 'S001', '誰が承認したかが残る');
h.check(h.notifiesOf('post').length === 1, '★本人へ通知を出す（Webhookが実際に届くかの確認を兼ねる）');

h.section('3b) 区分とスキルは職員が決める');
setup(); asNewcomer();
G.submitRegistration(Object.assign({}, APPLY, { skills: 'テイク' }));
asStaff();
res = G.approveRegistration(reg().registration_id, { role: '職員', skills: 'テイク,介助' });
h.check(h.row('staffs', 'staff_id', res.staff_id).role === '職員', '職員として承認できる');
h.check(h.row('staffs', 'staff_id', res.staff_id).skills === 'テイク,介助', 'スキルを職員が上書きできる');

setup(); asNewcomer();
G.submitRegistration(APPLY);
asStaff();
res = G.approveRegistration(reg().registration_id, { role: 'なりすまし管理者' });
h.check(h.row('staffs', 'staff_id', res.staff_id).role === '学生', '★未知の区分は「学生」に倒す');

h.section('3c) 二重承認・重複メールを防ぐ');
setup(); asNewcomer();
G.submitRegistration(APPLY);
asStaff();
const id2 = reg().registration_id;
G.approveRegistration(id2);
threw = '';
try { G.approveRegistration(id2); } catch (e) { threw = e.message; }
h.check(/既に/.test(threw), '★承認済みの申請は二度承認できない');

setup(); asNewcomer();
G.submitRegistration(APPLY);
// 承認前に同じメールが名簿へ入ってしまったケース
h.add('contacts', { staff_id: 'S900', name: '別経路', email: NEW_MAIL });
asStaff();
threw = '';
try { G.approveRegistration(reg().registration_id); } catch (e) { threw = e.message; }
h.check(/既に名簿/.test(threw), '★同じメールが名簿にあれば承認しない（二重登録の防止）');

// ── 4) 却下と再申請 ────────────────────────────────────────
h.section('4) 却下しても名簿には何も作らない／本人は出し直せる');
setup(); asNewcomer();
G.submitRegistration(APPLY);
asStaff();
const before = h.db.staffs.length;
G.rejectRegistration(reg().registration_id, '在籍が確認できません');
h.check(reg().status === '却下', 'status が「却下」になる');
h.check(reg().reject_reason === '在籍が確認できません', '理由が残る');
h.check(h.db.staffs.length === before, '★名簿には何も作らない');

asNewcomer();
c = G.getSignupContext();
h.check(c.status === '却下' && c.rejectReason === '在籍が確認できません', '本人の画面に理由が出る');
h.check(c.name === '新人 太郎', '前回の入力が残っていて直せる');
G.submitRegistration(Object.assign({}, APPLY, { name: '新人 三郎' }));
h.check(reg().status === '申請中', '★却下された人も出し直せる');
h.check(reg().reject_reason === '', '前回の却下理由は消える');

// ── 5) 権限 ────────────────────────────────────────────────
h.section('5) 承認まわりは職員限定');
setup(); asNewcomer();
G.submitRegistration(APPLY);
const rid5 = reg().registration_id;

asStudent();
['getRegistrations', 'approveRegistration', 'rejectRegistration'].forEach(function (fn) {
  var t = '';
  try { G[fn](rid5, {}); } catch (e) { t = e.message; }
  h.check(/職員/.test(t), fn + ' は学生から呼べない');
});
h.setUser(null); h.setEmail(NEW_MAIL);
threw = '';
try { G.approveRegistration(rid5); } catch (e) { threw = e.message; }
h.check(/利用登録|職員/.test(threw), '未登録者からも呼べない');
h.check(h.db.staffs.length === 2, '拒否されたときは名簿が増えていない');

asStaff();
h.check(G.getRegistrations().length === 1, '職員は一覧を取れる');
h.check(G.getRegistrations()[0].status === '申請中', '申請中のまま');

process.exitCode = h.report();
