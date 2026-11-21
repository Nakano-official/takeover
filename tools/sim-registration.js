/**
 * 利用登録の申請と承認（D28）のロジック検証 — Node 上で実行する
 *
 *     node tools/sim-registration.js
 *
 * 2026-11-21 から学生の申請は受け付けていない（D64）。職員が名簿から登録する（tools/sim-staffreg.js）。
 * ここでは、**すでに出ていた申請**を承認・却下する部分と、申請の入口が無くなったことを確かめる。
 *
 * 守りたい不変条件：
 *   1. **申請の入口（getSignupContext / submitRegistration）が無い。** 画面が無くても google.script.run から
 *      申請を作れてしまわないように
 *   2. **承認するまで staffs / contacts に一切書かない。** 却下しても何も作らない
 *   3. **role は承認時に職員が決める（既定は学生）。** 未知の区分は学生に倒す
 *   4. 承認した人は**本人の確認済み**（本人が自分のアカウントで申請したので、メールアドレスは本人のもの）
 */
const { Harness } = require('./gas-harness');

const h = new Harness();
h.load(['Constants.gs', 'Util.gs', 'Terms.gs', 'Vacancy.gs', 'Access.gs', 'ClassCalendar.gs', 'Cancellation.gs', 'Profile.gs',
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

/** すでに出ていた申請（以前の申請画面が保存していた形）を1件置く */
function pending(over) {
  h.add('registrations', Object.assign({
    registration_id: 'R001', email: NEW_MAIL, name: '新人 太郎', phone: '090-3333-3333', webhook_url: OK_HOOK,
    skills: 'テイク', slots: '月1,火2', assist_slots: '水3', note: 'よろしくお願いします',
    status: '申請中', applied_at: '2026-11-01 10:00:00', decided_at: '', decided_by: '', staff_id: '', reject_reason: '',
  }, over || {}));
  return reg().registration_id;
}

console.log('===== 利用登録の承認（D28・申請は D64 でやめた）ロジック検証 =====');

h.section('1) 申請の入口は無い（D64）');
h.check(typeof G.submitRegistration === 'undefined', '★submitRegistration は無い（画面が無くても申請を作れない）');
h.check(typeof G.getSignupContext === 'undefined', 'getSignupContext も無い');

// ── 3) 承認：ここだけが名簿に書く ──────────────────────────
h.section('3) 承認すると staffs と contacts に行ができる');
setup();
const rid = pending();
asStaff();
let res = G.approveRegistration(rid);
h.check(res.ok === true, '承認できる');
h.check(res.staff_id === 'S102', '★既存の S101 の次で採番される（S001 とも衝突しない）');
const newStaff = h.row('staffs', 'staff_id', res.staff_id);
const newContact = h.row('contacts', 'staff_id', res.staff_id);
h.check(!!newStaff && !!newContact, 'staffs と contacts の両方に行ができる');
h.check(newStaff.name === '新人 太郎' && newContact.email === NEW_MAIL, '氏名とメールが入る');
h.check(newStaff.role === '学生', '★区分の既定は「学生」');
h.check(newStaff.available_slots === '月1,火2', 'テイクの空きコマが引き継がれる');
h.check(newStaff.assist_slots === '水3', '介助の空きコマも引き継がれる（テイクの値を写さない）');
h.check(!!newStaff.slots_updated_at, '本人の申告なので更新日時も入る（D28）');
h.check(newStaff.personal_code === '', '個人コードは空（職員が後から入れる）');
h.check(newContact.phone === '090-3333-3333' && newContact.webhook_url === OK_HOOK, '連絡先が入る');
h.check(!!String(newContact.confirmed_at || '').trim(), '★承認した人は本人の確認済み（自分のアカウントで申請したので・D64）');
h.check(reg().status === '承認済' && reg().staff_id === res.staff_id, '申請に結果が記録される');
h.check(reg().decided_by === 'S001', '誰が承認したかが残る');
h.check(h.notifiesOf('post')[0].text.indexOf(h.G.getPublicAppUrl_()) !== -1, '★承認の通知にシステムの（公開用の）URL を付ける');
h.check(h.notifiesOf('post').length === 1, '★本人へ通知を出す（Webhookが実際に届くかの確認を兼ねる）');
h.check(h.notifiesOf('post')[0].text.indexOf('準備中') === -1, '公開中なら「準備中」の案内は付けない');

h.section('3a) 準備中に承認したら、使えるのはマイページだけと伝える（D56）');
setup(); pending(); asStaff();
h.props.STUDENT_ACCESS = 'closed';
G.approveRegistration(reg().registration_id);
h.check(h.notifiesOf('post')[0].text.indexOf('準備中のため、使えるのはマイページだけ') !== -1, '学生には準備中の案内を付ける');
setup(); pending(); asStaff();
h.props.STUDENT_ACCESS = 'closed';
G.approveRegistration(reg().registration_id, { role: '職員' });
h.check(h.notifiesOf('post')[0].text.indexOf('準備中') === -1, '職員として承認したら付けない（職員は止めない）');

h.section('3b) 区分とスキルは職員が決める');
setup(); pending({ skills: 'テイク' }); asStaff();
res = G.approveRegistration(reg().registration_id, { role: '職員', skills: 'テイク,介助' });
h.check(h.row('staffs', 'staff_id', res.staff_id).role === '職員', '職員として承認できる');
h.check(h.row('staffs', 'staff_id', res.staff_id).skills === 'テイク,介助', 'スキルを職員が上書きできる');
setup(); pending(); asStaff();
res = G.approveRegistration(reg().registration_id, { role: 'なりすまし管理者' });
h.check(h.row('staffs', 'staff_id', res.staff_id).role === '学生', '★未知の区分は「学生」に倒す');

h.section('3c) 二重承認・重複メールを防ぐ');
setup();
const id2 = pending();
asStaff();
G.approveRegistration(id2);
let threw = '';
try { G.approveRegistration(id2); } catch (e) { threw = e.message; }
h.check(/既に/.test(threw), '★承認済みの申請は二度承認できない');
setup(); pending();
h.add('contacts', { staff_id: 'S900', name: '別経路', email: NEW_MAIL });   // 承認前に同じメールが名簿へ入ったケース
asStaff();
threw = '';
try { G.approveRegistration(reg().registration_id); } catch (e) { threw = e.message; }
h.check(/既に名簿/.test(threw), '★同じメールが名簿にあれば承認しない（二重登録の防止）');

// ── 4) 却下 ────────────────────────────────────────────────
h.section('4) 却下しても名簿には何も作らない');
setup(); pending(); asStaff();
const before = h.db.staffs.length;
G.rejectRegistration(reg().registration_id, '在籍が確認できません');
h.check(reg().status === '却下', 'status が「却下」になる');
h.check(reg().reject_reason === '在籍が確認できません', '理由が残る');
h.check(h.db.staffs.length === before, '★名簿には何も作らない');

// ── 5) 権限 ────────────────────────────────────────────────
h.section('5) 承認まわりは職員限定');
setup();
const rid5 = pending();
asStudent();
['getRegistrations', 'approveRegistration', 'rejectRegistration'].forEach(function (fn) {
  var t = '';
  try { G[fn](rid5, {}); } catch (e) { t = e.message; }
  h.check(/職員/.test(t), fn + ' は学生から呼べない');
});
h.setUser(null); asNewcomer();
threw = '';
try { G.approveRegistration(rid5); } catch (e) { threw = e.message; }
h.check(/利用登録|職員/.test(threw), '未登録者からも呼べない');
h.check(h.db.staffs.length === 2, '拒否されたときは名簿が増えていない');
asStaff();
h.check(G.getRegistrations().length === 1, '職員は一覧を取れる');
h.check(G.getRegistrations()[0].status === '申請中', '申請中のまま');

h.section('承認のときにも氏名を確かめる（シートを直接直された申請）');
setup(); pending({ name: '=A1&B1' }); asStaff();
threw = '';
try { G.approveRegistration(reg().registration_id, {}); } catch (e) { threw = e.message; }
h.check(threw.indexOf('申請の氏名の先頭に') !== -1, '名簿へ写す前に弾く');
h.check(h.db.staffs.length === 2, '名簿は増えていない');

process.exitCode = h.report();
