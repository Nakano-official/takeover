/**
 * 職員がスタッフを登録する・本人の確認（D64）の検証 — Node 上で実行する
 *
 *     node tools/sim-staffreg.js
 *
 * 2026-11-21 から、学生の申請をやめ、職員が支援室の名簿から登録する。守りたいこと：
 *   1. 職員だけが登録・修正できる。1人でも直すところがあれば、誰も登録しない（途中まで登録された状態を作らない）
 *   2. 氏名・電話・メールの形を確かめる（以前の申請と同じ決まり：姓と名・電話の形・数式を弾く）
 *   3. 登録した人は「本人の確認がまだ」から始まる。確かめるまで、通知を送らず・学生の画面の関数も止め・
 *      どの画面を開いても確認の画面を出す
 *   4. 「はい」で確認済みになり、普通に使える。「いいえ」なら職員スペースへ知らせ、確認済みにしない
 *   5. すでにいる人（confirmed_at が入っている・列が無い）は確認済みのまま。何も変わらない
 *   6. 職員がメールアドレスを直したら、確認をやり直す
 *   7. 名簿の画面：貼った名簿の読み取り（列の順番・見出し・氏名が1列）と、職員に「確認まだ」が見える
 */
const { Harness } = require('./gas-harness');
const { loadPage } = require('./page-vm');

const h = new Harness();
const rendered = [];
h.stub({
  // doGet が返す画面を記録する（どの HTML を出したか）
  HtmlService: {
    createTemplateFromFile: function (file) {
      const t = {
        evaluate: function () {
          const out = { file: file, user: t.user };
          out.setTitle = function () { return out; };
          out.addMetaTag = function () { return out; };
          out.setXFrameOptionsMode = function () { rendered.push(out); return out; };
          return out;
        },
      };
      return t;
    },
    createHtmlOutputFromFile: function () { return { getContent: function () { return ''; } }; },
    XFrameOptionsMode: { DEFAULT: 'DEFAULT' },
  },
  ScriptApp: { getService: function () { return { getUrl: function () { return 'https://example.invalid/app'; } }; } },
});
h.load(['Constants.gs', 'Util.gs', 'Terms.gs', 'Vacancy.gs', 'Access.gs', 'ClassCalendar.gs', 'Cancellation.gs',
  'Profile.gs', 'Registration.gs', 'Roster.gs', 'StaffAdmin.gs', 'Notify.gs', 'code.js', 'Identity.gs']);
const G = h.G;
const HOOK = 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t';
// Notify.gs を読み込んだので、Chat への送信の一番下だけ記録にする
h.context.postToWebhook_ = function (url, text) { h.notifyLog.push({ kind: 'post', url: url, text: text }); return true; };

function setup() {
  h.reset();
  rendered.length = 0;
  h.add('periods', { period: '1', start_time: '09:15', end_time: '10:45' });
  h.add('staffs', { staff_id: 'T1', name: '職員 花子', role: '職員' });
  h.add('contacts', { staff_id: 'T1', name: '職員 花子', email: 't1@example.ac.jp' });
  h.add('staffs', { staff_id: 'S1', name: '既存 学生', role: '学生', skills: 'テイク' });
  h.add('contacts', { staff_id: 'S1', name: '既存 学生', email: 's1@example.ac.jp', phone: '090-0000-0001', webhook_url: HOOK });
}
const asStaff = () => h.setUser({ staff_id: 'T1', name: '職員 花子', role: '職員', email: 't1@example.ac.jp' });
// 本人として開く（本人確認は本物の getCurrentUser_ がシートから引く）
const asEmail = (email) => { h.setUser(null); h.setEmail(email); };
const errOf = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
const ONE = { email: 'y250001@example.ac.jp', family_name: '新人', given_name: '太郎', phone: '09000000002', skills: ['テイク'] };
const contactOf = (email) => h.db.contacts.filter((c) => String(c.email).toLowerCase() === email.toLowerCase())[0];

console.log('===== 職員がスタッフを登録する・本人の確認（D64）=====');

h.section('1) 職員が1人登録する');
setup(); asStaff();
let r = G.registerStaff([ONE]);
const c1 = contactOf(ONE.email);
const s1 = c1 && h.row('staffs', 'staff_id', c1.staff_id);
h.check(r.ok && r.registered.length === 1 && r.registered[0].name === '新人 太郎', '登録できる（姓と名を半角スペースでつなぐ）');
h.check(!!s1 && s1.role === '学生' && s1.skills === 'テイク', '区分は学生・業務は選んだもの');
h.check(c1 && c1.phone === '090-0000-0002', '電話番号は 3-4-4 にそろえる');
h.check(c1 && c1.confirmed_at === '', '★本人の確認がまだ（confirmed_at が空）');
h.check(s1 && s1.available_slots === '' && s1.slots_updated_at === '', '空きコマは空（本人がマイページで出す）');
h.check(c1 && c1.webhook_url === '', '通知先は空');

h.section('2) 形の確認（以前の申請と同じ決まり）');
const regErr = (over) => {
  setup(); asStaff();
  const res = G.registerStaff([Object.assign({}, ONE, over)]);
  return res.ok ? '' : res.errors[0].message;
};
h.check(regErr({}) === '', 'ふつうの登録は通る');
h.check(/メールアドレスの形/.test(regErr({ email: 'y250001' })), '@ の無いメールは弾く');
h.check(/メールアドレスを入れて/.test(regErr({ email: '' })), 'メールが空なら弾く');
h.check(/姓を入力/.test(regErr({ family_name: '' })), '姓が空なら弾く');
h.check(/空白/.test(regErr({ family_name: '新 人' })), '姓の中に空白があれば弾く');
h.check(/先頭に/.test(regErr({ family_name: '=1+1' })), '先頭が = の姓は弾く');
h.check(/使えない記号/.test(regErr({ given_name: '<users/all>' })), '< > を含む名は弾く');
h.check(/電話番号/.test(regErr({ phone: '090-1234-abcd' })), '数字以外の電話番号は弾く');
h.check(regErr({ phone: '' }) === '', '電話番号は空でもよい（名簿に無い人もいる）');
h.check(/1つ以上/.test(regErr({ skills: ['どれでもない'] })), '業務の名前でないものだけなら弾く');

h.section('3) 1人でも直すところがあれば、誰も登録しない');
setup(); asStaff();
const before = h.db.staffs.length;
r = G.registerStaff([ONE, Object.assign({}, ONE, { email: 'Y250001@example.ac.jp' }), { email: 'x@example.ac.jp', family_name: '', given_name: '花' }]);
h.check(!r.ok && r.errors.length === 2, '直すところを全部返す');
h.check(r.errors[0].line === 2 && /1 行目にも/.test(r.errors[0].message), '★同じメール（大文字小文字は区別しない）が2回あれば何行目かを返す');
h.check(r.errors[1].line === 3, '何行目かを返す');
h.check(h.db.staffs.length === before && h.db.contacts.length === 2, '★誰も登録していない');
r = G.registerStaff([Object.assign({}, ONE, { email: 'S1@example.ac.jp' })]);
h.check(!r.ok && /もう名簿にあります/.test(r.errors[0].message), '★すでに名簿にあるメールは登録しない');
h.check(/人までです/.test(errOf(() => G.registerStaff(new Array(201).fill(ONE)))), '1回に登録できる人数に上限がある');
setup(); asStaff();
r = G.registerStaff([ONE, Object.assign({}, ONE, { email: 'y250002@example.ac.jp', given_name: '次郎' })]);
h.check(r.ok && r.registered.length === 2 && r.registered[0].staff_id !== r.registered[1].staff_id, 'まとめて登録できる（別々の ID）');

h.section('4) 職員だけが登録・修正できる');
setup(); h.setUser({ staff_id: 'S1', name: '既存 学生', role: '学生', email: 's1@example.ac.jp' });
h.check(/職員/.test(errOf(() => G.registerStaff([ONE]))), '学生は登録できない');
h.check(/職員/.test(errOf(() => G.updateStaffContact({ staff_id: 'S1', email: 'x@example.ac.jp', family_name: 'a', given_name: 'b' }))), '学生は直せない');
asEmail('nobody@example.ac.jp');
h.check(/利用登録/.test(errOf(() => G.registerStaff([ONE]))), '名簿に無い人も登録できない');

h.section('5) 移行の前（confirmed_at 列が無い）は登録を止め、今いる人は確認済み');
setup();
const savedHeaders = h.headers.contacts.slice();
h.db.contacts.forEach((c) => { delete c.confirmed_at; });
h.headers.contacts = h.headers.contacts.filter((x) => x !== 'confirmed_at');
asStaff();
h.check(/migrateAddContactConfirmedAt/.test(errOf(() => G.registerStaff([ONE]))), '★列が無ければ、移行を案内して登録しない');
asEmail('s1@example.ac.jp');
h.check(G.getCurrentUser_().confirmed === true, '★列が無いあいだ、今いる人は確認済み（確認の画面を出さない）');
h.check(G.isUnconfirmedContact_({ staff_id: 'S1', confirmed_at: '2026-01-01' }) === false &&
  G.isUnconfirmedContact_({ staff_id: 'S1', confirmed_at: '' }) === true, '値があれば確認済み・空なら確認がまだ');
h.headers.contacts = savedHeaders;   // 以降の節のために列を戻す

h.section('6) 確認がまだの人：画面は確認だけ・関数も通知も止める');
setup(); asStaff();
G.registerStaff([ONE]);
const newId = contactOf(ONE.email).staff_id;
h.db.staffs.filter((s) => s.staff_id === newId)[0].available_slots = '月1';   // 仮に空きコマがあっても
contactOf(ONE.email).webhook_url = HOOK;                                       // 仮に通知先があっても
asEmail(ONE.email);
h.check(G.getCurrentUser_().confirmed === false, '本人確認：確認がまだ');
G.doGet({ parameter: { page: 'home' } });
h.check(rendered[rendered.length - 1].file === 'confirm', '★どの画面を開いても、確認の画面を出す');
G.doGet({ parameter: { page: 'mypage' } });
h.check(rendered[rendered.length - 1].file === 'confirm', 'マイページを開いても、先に確認');
h.check(/本人の確認/.test(errOf(() => G.getOpenUser_())), '★学生の画面の関数（getOpenUser_）も止める');
h.check(G.buildWebhookMap_()[newId] === undefined && G.buildWebhookMap_().S1 === HOOK, '★確認がまだの人には通知を送らない（今いる人には送る）');
h.check(G.renderChrome_(h.value('CONFIRM_PAGE'), 'confirm', G.getCurrentUser_()).indexOf('appnav') === -1, '確認の画面にはナビを出さない');

h.section('7) 「はい」で確認済みになり、普通に使える');
r = G.confirmMyIdentity(true);
h.check(r.ok && r.confirmed === true && !!contactOf(ONE.email).confirmed_at, '★「はい」で確認済みになる');
h.check(G.getCurrentUser_().confirmed === true, '★本人確認のキャッシュも新しくなる（次の操作から普通に使える）');
G.doGet({ parameter: { page: 'mypage' } });
h.check(rendered[rendered.length - 1].file === 'mypage', 'マイページが開く');
h.check(G.buildWebhookMap_()[newId] === HOOK, '通知も送るようになる');
h.check(G.confirmMyIdentity(true).already === true, 'もう一度押しても何もしない');

h.section('8) 「いいえ」なら職員スペースへ知らせ、確認済みにしない');
setup(); asStaff();
G.registerStaff([ONE]);
asEmail(ONE.email);
r = G.confirmMyIdentity(false);
const post = h.notifiesOf('post').filter((p) => /違う/.test(p.text))[0];
h.check(r.ok && r.confirmed === false && contactOf(ONE.email).confirmed_at === '', '★確認済みにしない');
h.check(!!post && post.text.indexOf(ONE.email) !== -1 && post.text.indexOf('新人 太郎') !== -1, '★職員スペースへ、登録の名前とログインしたアカウントを知らせる');
h.check(r.notified === true, '知らせたことを画面へ返す');
asEmail('nobody@example.ac.jp');
h.check(/利用登録/.test(errOf(() => G.confirmMyIdentity(true))), '名簿に無い人は確認できない');
asEmail('s1@example.ac.jp');
h.check(G.confirmMyIdentity(true).already === true && contactOf('s1@example.ac.jp').confirmed_at === '2026-01-01 00:00:00',
  'すでに確認済みの人は何も変わらない');

h.section('9) 職員が氏名・電話・メールを直す');
setup(); asStaff();
r = G.updateStaffContact({ staff_id: 'S1', email: 's1@example.ac.jp', family_name: '既存', given_name: '次郎', phone: '09000000009' });
h.check(r.ok && !r.reconfirm, 'メールを変えなければ、確認はそのまま');
h.check(h.row('staffs', 'staff_id', 'S1').name === '既存 次郎' && contactOf('s1@example.ac.jp').name === '既存 次郎', '氏名は名簿と連絡先の両方を直す');
h.check(contactOf('s1@example.ac.jp').phone !== '' && contactOf('s1@example.ac.jp').confirmed_at === '2026-01-01 00:00:00', '電話を直しても確認済みのまま');
r = G.updateStaffContact({ staff_id: 'S1', email: 's1-new@example.ac.jp', family_name: '既存', given_name: '次郎', phone: '' });
h.check(r.reconfirm === true && contactOf('s1-new@example.ac.jp').confirmed_at === '', '★メールを変えたら、確認をやり直す');
h.check(/ほかの人/.test(errOf(() => G.updateStaffContact({ staff_id: 'S1', email: 't1@example.ac.jp', family_name: 'a', given_name: 'b' }))),
  '★ほかの人のメールにはできない');
h.check(/見つかりません/.test(errOf(() => G.updateStaffContact({ staff_id: 'S999', email: 'z@example.ac.jp', family_name: 'a', given_name: 'b' }))), '無いスタッフは直せない');

h.section('10) 名簿：確認がまだの人が分かる');
setup(); asStaff();
G.registerStaff([ONE]);
const roster = JSON.parse(JSON.stringify(G.getStaffRoster()));
const row = roster.rows.filter((x) => x.email === ONE.email)[0];
h.check(row && row.issues.indexOf('unconfirmed') !== -1 && row.confirmed === false, '★確認がまだの人に「確認まだ」が付く');
h.check(roster.summary.unconfirmed === 1, '上の集計にも出る');
h.check(roster.rows.filter((x) => x.staff_id === 'S1')[0].issues.indexOf('unconfirmed') === -1, '今いる人には付かない');

h.section('11) マイページで電話番号を直せない（D64）');
setup(); h.setUser({ staff_id: 'S1', name: '既存 学生', role: '学生', email: 's1@example.ac.jp' });
G.updateMyProfile({ phone: '080-9999-9999', webhook_url: HOOK, skills: ['テイク'], slotsByType: { 'テイク': ['月1'] } });
h.check(contactOf('s1@example.ac.jp').phone === '090-0000-0001', '★送られてきても電話番号は変わらない');

h.section('12) 名簿の画面：貼った名簿を読む');
const page = loadPage('roster', { include: ['shared-dialog', 'shared-contact'], globals: {
  viewCacheLoad() {}, viewCacheLocked() { return false; }, viewCacheClear() {},
} });
const parse = (t) => page.ctx.parseBulk(t);
let p = parse('メール\t姓\t名\t電話\ny250001@example.ac.jp\t新人\t太郎\t090-0000-0002\n\n');
h.check(p.length === 1 && p[0].email === 'y250001@example.ac.jp' && p[0].family_name === '新人' && p[0].given_name === '太郎' &&
  p[0].phone === '090-0000-0002' && p[0].line === 2, '★見出しの行を飛ばし、タブ区切りを読む（何行目かも覚える）');
p = parse('新人 太郎,09000000002,y250001@example.ac.jp');
h.check(p[0].email === 'y250001@example.ac.jp' && p[0].family_name === '新人' && p[0].given_name === '太郎' && p[0].phone === '09000000002',
  '★列の順番が違っても・氏名が1列でも読む（カンマ区切り）');
p = parse('y250001@example.ac.jp\t新人\t太郎');
h.check(p[0].phone === '' && !p[0].why, '電話番号が無くてもよい');
p = parse('a@example.ac.jp\t新人太郎\nb@example.ac.jp\t新人\t次郎\n山田\t花子');
h.check(/姓と名/.test(p[0].why) && !p[1].why && /メールアドレス/.test(p[2].why), '直すところのある行を見分ける（氏名が分けられない・メールが無い）');
// 窓：読み取ったあと、登録を押すと registerStaff に読み取った内容を送る
page.ctx.DATA = { rows: [] };
page.ctx.openStaffDialog('bulk');
page.el('bulkText').value = 'y250001@example.ac.jp\t新人\t太郎\t090-0000-0002\ny250002@example.ac.jp\t新人\t次郎';
page.ctx.bulkPreview();
h.check(page.el('staffDialogGo').disabled === false, '読み取れたら登録を押せる');
page.ctx.staffDialogGo();
const call = page.calls.filter((c) => c.name === 'registerStaff')[0];
h.check(call && call.args[0].length === 2 && call.args[0][1].given_name === '次郎', '★読み取った人数分を registerStaff に送る');
page.el('bulkText').value = '山田\t花子';
page.ctx.bulkPreview();
h.check(page.el('staffDialogGo').disabled === true, '直すところがあれば登録を押せない');

h.section('13) 確認の「はい」のあと、その場で業務と空きコマを登録する');
setup(); asStaff();
G.registerStaff([ONE]);
contactOf(ONE.email).webhook_url = HOOK;
asEmail(ONE.email);
h.check(/本人の確認/.test(errOf(() => G.updateMyProfile({ skills: ['テイク'], slotsByType: { 'テイク': ['月1'] } }))),
  '★確認がまだの人は、業務と空きコマを保存できない');
G.confirmMyIdentity(true);
const sv = G.updateMyProfile({ skills: ['テイク'], slotsByType: { 'テイク': ['月1'] } });
const meRow = h.row('staffs', 'staff_id', contactOf(ONE.email).staff_id);
h.check(sv.ok && meRow.available_slots === '月1' && meRow.skills === 'テイク', '確認のあとは、業務と空きコマを保存できる');
h.check(contactOf(ONE.email).webhook_url === HOOK, '★通知先を送らなければ、通知先は今のまま（空にしない）');
h.check(!(sv.warnings || []).some((w) => /Webhook/.test(w)), '通知先を送らなければ、通知先の注意も出さない');
// 画面：「はい」→ 確認 → 業務と空きコマの入力を出す
const cp = loadPage('confirm', { include: ['shared-slots', 'shared-chat-install'] });
cp.ctx.answer(true);
const confirmCall = cp.calls.filter((c) => c.name === 'confirmMyIdentity')[0];
h.check(confirmCall && confirmCall.args[0] === true, '「はい」で confirmMyIdentity(true) を呼ぶ');
cp.reply(cp.calls.indexOf(confirmCall), { ok: true, confirmed: true });
const profCall = cp.calls.filter((c) => c.name === 'getMyProfile')[0];
h.check(!!profCall && cp.el('setup').hidden === false, '★確認のあと、その場で登録の画面を出す（マイページの情報を読む）');
cp.reply(cp.calls.indexOf(profCall), JSON.parse(JSON.stringify(G.getMyProfile())));
const sb = cp.el('setupBody').innerHTML;
h.check(sb.indexOf('対応できる業務') !== -1 && sb.indexOf('空きコマ') !== -1 && sb.indexOf('data-slot=') !== -1,
  '★業務と空きコマ（曜日×時限）の入力を出す（マイページと同じ部品）');
cp.ctx.saveSetup();   // 業務を1つも選んでいない（この試験の DOM ではチェックが取れない）
h.check(!cp.calls.some((c) => c.name === 'updateMyProfile') && /1つ以上/.test(cp.el('setupMsg').innerHTML),
  '業務を1つも選ばなければ送らない');
cp.ctx.showNext(true);
h.check(cp.el('next').hidden === false && /あとで|いつでも/.test(cp.el('nextLead').textContent), '「あとで」なら、マイページで登録できると案内する');
// 職員として登録された人は、業務と空きコマを聞かずに最後の案内へ
const cp2 = loadPage('confirm', { include: ['shared-slots', 'shared-chat-install'] });
cp2.ctx.startSetup();
cp2.reply(0, { isStudent: false });
h.check(cp2.el('next').hidden === false && cp2.el('setupBody').innerHTML.indexOf('data-slot=') === -1, '職員として登録された人には、業務と空きコマを聞かない');

process.exitCode = h.report();
