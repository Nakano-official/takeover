/**
 * 職員がスタッフを登録する・本人の確認（D64・D65）の検証 — Node 上で実行する
 *
 *     node tools/sim-staffreg.js
 *
 * 2026-11-21 から、学生の申請をやめ、職員が支援室の名簿から登録する。2026-11-24 からはメールアドレスを持たず、
 * 学籍番号（contacts.account）で持つ（D65）。守りたいこと：
 *   1. 職員だけが登録・修正できる。形のおかしい行が1つでもあれば、誰も登録しない（途中まで登録された状態を作らない）
 *   2. 学籍番号・氏名・電話の形を確かめる（大学のメールを貼ってもよい・全角でもよい）
 *   3. 名簿をまるごと貼ってよい：登録済みの人は飛ばし、新しい人だけを足す。名前が名簿と違う人は書き換えずに知らせる
 *   4. 登録した人は「本人の確認がまだ」から始まる。確かめるまで、通知を送らず・学生の画面の関数も止め・
 *      どの画面を開いても確認の画面を出す
 *   5. 「はい」で確認済みになり、普通に使える。「いいえ」なら職員スペースへ知らせ、確認済みにしない
 *   6. 移行の前（confirmed_at や account の列が無い）は登録を止め、今いる人はそのまま入れる
 *   7. 職員が学籍番号を直したら、確認をやり直す。**職員の行の学籍番号（ログインの識別子）は変えられない**
 *   8. 名簿の画面：支援室の Excel（学部・学籍・氏名・備考）を貼って読める。登録済みの人に印が付く
 *   9. 移行（migrateContactsToAccount）：email を学籍番号に書き換え、DM の列を足す。おかしい行が1つでもあれば何も書き換えない
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
  'Profile.gs', 'Registration.gs', 'Roster.gs', 'StaffAdmin.gs', 'Notify.gs', 'code.js', 'Identity.gs', 'Setup.js']);
const G = h.G;
const HOOK = 'https://chat.googleapis.com/v1/spaces/AAA/messages?key=k&token=t';
// Notify.gs を読み込んだので、Chat への送信の一番下だけ記録にする
h.context.postToWebhook_ = function (url, text) { h.notifyLog.push({ kind: 'post', url: url, text: text }); return true; };
const HEADERS = h.headers.contacts.slice();

function setup() {
  h.reset();
  h.headers.contacts = HEADERS.slice();
  rendered.length = 0;
  h.add('periods', { period: '1', start_time: '09:15', end_time: '10:45' });
  h.add('staffs', { staff_id: 'T1', name: '職員 花子', role: '職員' });
  h.add('contacts', { staff_id: 'T1', name: '職員 花子', account: 'SHIENSHITSU' });   // 支援室の共用アカウント
  h.add('staffs', { staff_id: 'S1', name: '既存 学生', role: '学生', skills: 'テイク' });
  h.add('contacts', { staff_id: 'S1', name: '既存 学生', account: 'Y240001', phone: '090-0000-0001', webhook_url: HOOK });
}
const STAFF_MAIL = 'shienshitsu@mail.ryukoku.ac.jp';
const asStaff = () => h.setUser({ staff_id: 'T1', name: '職員 花子', role: '職員', email: STAFF_MAIL });
// 本人として開く（本人確認は本物の getCurrentUser_ がシートから引く）
const asEmail = (email) => { h.setUser(null); h.setEmail(email); };
const errOf = (fn) => { try { fn(); return ''; } catch (e) { return e.message; } };
const ONE = { account: 'Y250001', family_name: '新人', given_name: '太郎', phone: '09000000002', skills: ['テイク'] };
const ONE_MAIL = 'y250001@mail.ryukoku.ac.jp';
const contactOf = (account) => h.db.contacts.filter((c) => String(c.account).toUpperCase() === account.toUpperCase())[0];

console.log('===== 職員がスタッフを登録する・本人の確認（D64・D65）=====');

h.section('1) 職員が1人登録する');
setup(); asStaff();
let r = G.registerStaff([ONE]);
const c1 = contactOf('Y250001');
const s1 = c1 && h.row('staffs', 'staff_id', c1.staff_id);
h.check(r.ok && r.registered.length === 1 && r.registered[0].name === '新人 太郎', '登録できる（姓と名を半角スペースでつなぐ）');
h.check(!!s1 && s1.role === '学生' && s1.skills === 'テイク', '区分は学生・業務は選んだもの');
h.check(c1 && c1.phone === '090-0000-0002', '電話番号は 3-4-4 にそろえる');
h.check(c1 && c1.confirmed_at === '', '★本人の確認がまだ（confirmed_at が空）');
h.check(c1 && !('email' in c1), '★メールアドレスは持たない（学籍番号だけ・D65）');
h.check(s1 && s1.available_slots === '' && s1.slots_updated_at === '', '空きコマは空（本人がマイページで出す）');
h.check(c1 && c1.webhook_url === '', '通知先は空');
setup(); asStaff();
G.registerStaff([Object.assign({}, ONE, { role: '職員' })]);
h.check(h.row('staffs', 'staff_id', contactOf('Y250001').staff_id).role === '学生',
  '★区分は受け取らない。「職員」を送られても学生で登録する（職員のアカウントは共用の1つだけ）');

h.section('2) 形の確認');
const regErr = (over) => {
  setup(); asStaff();
  const res = G.registerStaff([Object.assign({}, ONE, over)]);
  return res.ok ? '' : res.errors[0].message;
};
const accOf = (over) => { setup(); asStaff(); const res = G.registerStaff([Object.assign({}, ONE, over)]); return res.ok ? res.registered[0].account : ''; };
h.check(regErr({}) === '', 'ふつうの登録は通る');
h.check(accOf({ account: 'y250001' }) === 'Y250001', '小文字の学籍番号は大文字にそろえる');
h.check(accOf({ account: 'Ｙ２５０００１' }) === 'Y250001', '★全角の学籍番号も読む');
h.check(accOf({ account: ONE_MAIL }) === 'Y250001', '★大学のメールを貼っても、「@より前」を使う');
h.check(accOf({ account: 'y24m012' }) === 'Y24M012', '大学院生の学籍番号も通る');
h.check(/大学のメール/.test(regErr({ account: 'y250001@example.com' })), '★大学のドメインでないメールは弾く');
h.check(/学籍番号の形/.test(regErr({ account: 'abc' })), '学籍番号の形でないものは弾く');
h.check(/学籍番号の形/.test(regErr({ account: 'SHIENSHITSU' })), '★学籍番号の形でないアカウント（職員など）は、名簿から学生として登録できない');
h.check(/学籍番号を入れて/.test(regErr({ account: '' })), '学籍番号が空なら弾く');
h.check(/姓を入力/.test(regErr({ family_name: '' })), '姓が空なら弾く');
h.check(/空白/.test(regErr({ family_name: '新 人' })), '姓の中に空白があれば弾く');
h.check(/先頭に/.test(regErr({ family_name: '=1+1' })), '先頭が = の姓は弾く');
h.check(/使えない記号/.test(regErr({ given_name: '<users/all>' })), '< > を含む名は弾く');
h.check(/電話番号/.test(regErr({ phone: '090-1234-abcd' })), '数字以外の電話番号は弾く');
h.check(regErr({ phone: '' }) === '', '電話番号は空でもよい（名簿に無い）');
h.check(/1つ以上/.test(regErr({ skills: ['どれでもない'] })), '業務の名前でないものだけなら弾く');

h.section('3) 形のおかしい行が1つでもあれば、誰も登録しない');
setup(); asStaff();
const before = h.db.staffs.length;
r = G.registerStaff([ONE, { account: 'Y250002', family_name: '', given_name: '花' }, { account: 'xyz', family_name: '新人', given_name: '三郎' }]);
h.check(!r.ok && r.errors.length === 2, '直すところを全部返す');
h.check(r.errors[0].line === 2 && r.errors[1].line === 3 && r.errors[1].account === 'xyz', '何番目か（と学籍番号）を返す');
h.check(h.db.staffs.length === before && h.db.contacts.length === 2, '★誰も登録していない');
r = G.registerStaff([ONE, Object.assign({}, ONE, { account: 'y250001', given_name: '次郎' })]);
h.check(!r.ok && /1 番目にもあり、氏名が違います/.test(r.errors[0].message), '★同じ学籍番号（大文字小文字は区別しない）で氏名が違えば直してもらう');
h.check(/人までです/.test(errOf(() => G.registerStaff(new Array(301).fill(ONE)))), '1回に読める人数に上限がある');
setup(); asStaff();
r = G.registerStaff([ONE, Object.assign({}, ONE, { account: 'Y250002', given_name: '次郎' })]);
h.check(r.ok && r.registered.length === 2 && r.registered[0].staff_id !== r.registered[1].staff_id, 'まとめて登録できる（別々の ID）');

h.section('3b) 名簿をまるごと貼る：登録済みの人は飛ばし、新しい人だけを足す');
setup(); asStaff();
r = G.registerStaff([
  { account: 'Y240001', family_name: '既存', given_name: '学生' },            // 登録済み（同じ名前）
  ONE,                                                                       // 新しい人
  { account: 'y240001', family_name: '既存', given_name: '学生' },            // 同じ人がもう1回（大文字小文字違い）
  { account: 'Y250002', family_name: '新人', given_name: '次郎' },            // 新しい人
  { account: 'Y250002', family_name: '新人', given_name: '次郎' },            // 同じ貼り付けで2回目
]);
h.check(r.ok && r.registered.length === 2 && r.registered.map((x) => x.account).join() === 'Y250001,Y250002',
  '★新しい2人だけを登録する');
h.check(r.skipped.length === 3 && r.skipped[0].reason === 'registered' && r.skipped[0].line === 1 && !r.skipped[0].nameDiffers,
  '★登録済みの人は飛ばしたと返す（何番目か）');
h.check(r.skipped.filter((x) => x.reason === 'duplicate').length === 1, '同じ貼り付けの中の2回目も飛ばす');
h.check(h.db.contacts.length === 4 && h.db.staffs.length === 4, '★登録済みの人の行を二重に作らない');
h.check(r.registered[0].line === 2 && r.registered[1].line === 4, '登録した人が何番目かも返す');
setup(); asStaff();
r = G.registerStaff([{ account: 'Y240001', family_name: '既存', given_name: '花子' }, ONE]);
const diff = r.skipped[0];
h.check(r.ok && r.registered.length === 1 && diff.nameDiffers && diff.current === '既存 学生' && diff.name === '既存 花子',
  '★登録済みで名前が名簿と違えば知らせる（貼った名前と今の名簿の名前）');
h.check(h.row('staffs', 'staff_id', 'S1').name === '既存 学生' && contactOf('Y240001').name === '既存 学生',
  '★登録済みの人の名前は書き換えない（どちらが正しいかは職員が決める）');
h.check(G.registerStaff([{ account: 'Y240001', family_name: '既存', given_name: '学生' }]).registered.length === 0,
  '全員が登録済みなら、誰も足さずに終わる（エラーにしない）');

h.section('4) 職員だけが登録・修正できる');
setup(); h.setUser({ staff_id: 'S1', name: '既存 学生', role: '学生', email: 'y240001@mail.ryukoku.ac.jp' });
h.check(/職員/.test(errOf(() => G.registerStaff([ONE]))), '学生は登録できない');
h.check(/職員/.test(errOf(() => G.updateStaffContact({ staff_id: 'S1', account: 'Y240009', family_name: 'a', given_name: 'b' }))), '学生は直せない');
asEmail('y259999@mail.ryukoku.ac.jp');
h.check(/利用登録/.test(errOf(() => G.registerStaff([ONE]))), '名簿に無い人も登録できない');

h.section('5) 移行の前（列が無い）は登録を止め、今いる人はそのまま入れる');
setup();
h.db.contacts.forEach((c) => { delete c.confirmed_at; });
h.headers.contacts = h.headers.contacts.filter((x) => x !== 'confirmed_at');
asStaff();
h.check(/migrateAddContactConfirmedAt/.test(errOf(() => G.registerStaff([ONE]))), '★confirmed_at 列が無ければ、移行を案内して登録しない');
asEmail('y240001@mail.ryukoku.ac.jp');
h.check(G.getCurrentUser_().confirmed === true, '★列が無いあいだ、今いる人は確認済み（確認の画面を出さない）');
h.check(G.isUnconfirmedContact_({ staff_id: 'S1', confirmed_at: '2026-01-01' }) === false &&
  G.isUnconfirmedContact_({ staff_id: 'S1', confirmed_at: '' }) === true, '値があれば確認済み・空なら確認がまだ');
// account 列が無い（D65 の移行の前）：email で引く
h.reset();
h.headers.contacts = ['staff_id', 'name', 'email', 'phone', 'webhook_url', 'confirmed_at'];
h.add('staffs', { staff_id: 'T1', name: '職員 花子', role: '職員' });
h.add('contacts', { staff_id: 'T1', name: '職員 花子', email: STAFF_MAIL });
h.add('staffs', { staff_id: 'S1', name: '既存 学生', role: '学生' });
h.add('contacts', { staff_id: 'S1', name: '既存 学生', email: 'Y240001@mail.ryukoku.ac.jp' });
asEmail('y240001@mail.ryukoku.ac.jp');
const pre = G.getCurrentUser_();
h.check(pre && pre.staff_id === 'S1', '★account 列が無いあいだは、今まで通りメールで本人を引く（push してから移行するまでも入れる）');
asStaff();
h.check(/migrateContactsToAccount/.test(errOf(() => G.registerStaff([ONE]))), '★account 列が無ければ、移行を案内して登録しない');
h.check(/migrateContactsToAccount/.test(errOf(() => G.updateStaffContact({ staff_id: 'S1', account: 'Y240001', family_name: '既存', given_name: '学生' }))),
  '修正も止める');
h.check(JSON.parse(JSON.stringify(G.getStaffRoster())).rows.filter((x) => x.staff_id === 'S1')[0].account === 'Y240001',
  '名簿の表示は、移行の前でもメールから学籍番号を出す');
h.headers.contacts = HEADERS.slice();   // 以降の節のために列を戻す

h.section('5b) 大学のアカウントでなければ、名簿に同じ値があっても入れない');
setup();
asEmail('y240001@gmail.com');
h.check(G.getCurrentUser_() === null, '★ドメインが違えば null（学籍番号が同じでも別人）');

h.section('6) 確認がまだの人：画面は確認だけ・関数も通知も止める');
setup(); asStaff();
G.registerStaff([ONE]);
const newId = contactOf('Y250001').staff_id;
h.db.staffs.filter((s) => s.staff_id === newId)[0].available_slots = '月1';   // 仮に空きコマがあっても
contactOf('Y250001').webhook_url = HOOK;                                      // 仮に通知先があっても
asEmail(ONE_MAIL);
h.check(G.getCurrentUser_().confirmed === false, '本人確認：学籍番号から作ったメールで引け、確認がまだ');
G.doGet({ parameter: { page: 'home' } });
h.check(rendered[rendered.length - 1].file === 'confirm', '★どの画面を開いても、確認の画面を出す');
G.doGet({ parameter: { page: 'mypage' } });
h.check(rendered[rendered.length - 1].file === 'confirm', 'マイページを開いても、先に確認');
h.check(/本人の確認/.test(errOf(() => G.getOpenUser_())), '★学生の画面の関数（getOpenUser_）も止める');
h.check(G.buildWebhookMap_()[newId] === undefined && G.buildWebhookMap_().S1 === HOOK, '★確認がまだの人には通知を送らない（今いる人には送る）');
h.check(G.renderChrome_(h.value('CONFIRM_PAGE'), 'confirm', G.getCurrentUser_()).indexOf('appnav') === -1, '確認の画面にはナビを出さない');

h.section('7) 「はい」で確認済みになり、普通に使える');
r = G.confirmMyIdentity(true);
h.check(r.ok && r.confirmed === true && !!contactOf('Y250001').confirmed_at, '★「はい」で確認済みになる');
h.check(G.getCurrentUser_().confirmed === true, '★本人確認のキャッシュも新しくなる（次の操作から普通に使える）');
G.doGet({ parameter: { page: 'mypage' } });
h.check(rendered[rendered.length - 1].file === 'mypage', 'マイページが開く');
h.check(G.buildWebhookMap_()[newId] === HOOK, '通知も送るようになる');
h.check(G.confirmMyIdentity(true).already === true, 'もう一度押しても何もしない');

h.section('8) 「いいえ」なら職員スペースへ知らせ、確認済みにしない');
setup(); asStaff();
G.registerStaff([ONE]);
asEmail(ONE_MAIL);
r = G.confirmMyIdentity(false);
const post = h.notifiesOf('post').filter((p) => /違う/.test(p.text))[0];
h.check(r.ok && r.confirmed === false && contactOf('Y250001').confirmed_at === '', '★確認済みにしない');
h.check(!!post && post.text.indexOf(ONE_MAIL) !== -1 && post.text.indexOf('新人 太郎') !== -1 && /学籍番号/.test(post.text),
  '★職員スペースへ、登録の名前とログインしたアカウントを知らせ、学籍番号を確かめるよう頼む');
h.check(r.notified === true, '知らせたことを画面へ返す');
asEmail('y259999@mail.ryukoku.ac.jp');
h.check(/利用登録/.test(errOf(() => G.confirmMyIdentity(true))), '名簿に無い人は確認できない');
asEmail('y240001@mail.ryukoku.ac.jp');
h.check(G.confirmMyIdentity(true).already === true && contactOf('Y240001').confirmed_at === '2026-01-01 00:00:00',
  'すでに確認済みの人は何も変わらない');

h.section('9) 職員が氏名・電話・学籍番号を直す');
setup(); asStaff();
r = G.updateStaffContact({ staff_id: 'S1', account: 'Y240001', family_name: '既存', given_name: '次郎', phone: '09000000009' });
h.check(r.ok && !r.reconfirm, '学籍番号を変えなければ、確認はそのまま');
h.check(h.row('staffs', 'staff_id', 'S1').name === '既存 次郎' && contactOf('Y240001').name === '既存 次郎', '氏名は名簿と連絡先の両方を直す');
h.check(contactOf('Y240001').phone !== '' && contactOf('Y240001').confirmed_at === '2026-01-01 00:00:00', '電話を直しても確認済みのまま');
r = G.updateStaffContact({ staff_id: 'S1', account: 'y240002', family_name: '既存', given_name: '次郎', phone: '' });
h.check(r.reconfirm === true && contactOf('Y240002').confirmed_at === '' && !contactOf('Y240001'), '★学籍番号を変えたら、確認をやり直す');
h.check(/ほかの人/.test(errOf(() => G.updateStaffContact({ staff_id: 'S1', account: 'SHIENSHITSU', family_name: 'a', given_name: 'b' }))) ||
  /学籍番号の形/.test(errOf(() => G.updateStaffContact({ staff_id: 'S1', account: 'SHIENSHITSU', family_name: 'a', given_name: 'b' }))),
  'ほかの人の識別子にはできない');
setup(); asStaff();
G.registerStaff([ONE]);
h.check(/ほかの人/.test(errOf(() => G.updateStaffContact({ staff_id: 'S1', account: 'Y250001', family_name: 'a', given_name: 'b' }))),
  '★ほかの学生の学籍番号にはできない');
h.check(/見つかりません/.test(errOf(() => G.updateStaffContact({ staff_id: 'S999', account: 'Y259998', family_name: 'a', given_name: 'b' }))), '無いスタッフは直せない');

h.section('9b) 職員の行の学籍番号（ログインの識別子）は変えられない');
setup(); asStaff();
r = G.updateStaffContact({ staff_id: 'T1', account: 'SHIENSHITSU', family_name: '職員', given_name: '桜子', phone: '' });
h.check(r.ok && !r.reconfirm && h.row('staffs', 'staff_id', 'T1').name === '職員 桜子' && contactOf('SHIENSHITSU').staff_id === 'T1',
  '職員の行も、識別子を変えなければ氏名・電話を直せる（学籍番号の形でなくても通す）');
h.check(/学生スタッフでない人/.test(errOf(() => G.updateStaffContact({ staff_id: 'T1', account: 'Y259990', family_name: '職員', given_name: '桜子' }))),
  '★職員の行の識別子は変えられない（変えると職員の権限が別のアカウントへ移る）');
h.check(contactOf('SHIENSHITSU').staff_id === 'T1' && !contactOf('Y259990'), '★拒否したら何も書き換えない');
asEmail(STAFF_MAIL);
h.check(G.getCurrentUser_().role === '職員', '共用アカウントは今まで通り職員として入れる');

h.section('10) 名簿：確認がまだの人が分かる');
setup(); asStaff();
G.registerStaff([ONE]);
const roster = JSON.parse(JSON.stringify(G.getStaffRoster()));
const row = roster.rows.filter((x) => x.account === 'Y250001')[0];
h.check(row && row.issues.indexOf('unconfirmed') !== -1 && row.confirmed === false, '★確認がまだの人に「確認まだ」が付く');
h.check(row && row.entryYear === '25' && row.studentNo === 'Y250001', '学籍番号から入学年度を出す（D61）');
h.check(roster.summary.unconfirmed === 1, '上の集計にも出る');
h.check(roster.rows.filter((x) => x.staff_id === 'S1')[0].issues.indexOf('unconfirmed') === -1, '今いる人には付かない');

h.section('11) マイページで電話番号を直せない（D64）');
setup(); h.setUser({ staff_id: 'S1', name: '既存 学生', role: '学生', email: 'y240001@mail.ryukoku.ac.jp' });
G.updateMyProfile({ phone: '080-9999-9999', webhook_url: HOOK, skills: ['テイク'], slotsByType: { 'テイク': ['月1'] } });
h.check(contactOf('Y240001').phone === '090-0000-0001', '★送られてきても電話番号は変わらない');

h.section('12) 名簿の画面：支援室の Excel を貼って読む');
const page = loadPage('roster', { include: ['shared-contact'], globals: {
  viewCacheLoad() {}, viewCacheLocked() { return false; }, viewCacheClear() {},
} });
const parse = (t) => page.ctx.parseBulk(t);
page.ctx.DATA = { rows: [] };
let p = parse('学部\t学籍\t氏名\t備考\n理工学部\tY250001\t新人　太郎\t\n文学部\ty250002\t新人 次郎\t2回生から\n\n');
h.check(p.length === 2 && p[0].account === 'Y250001' && p[0].family_name === '新人' && p[0].given_name === '太郎' && p[0].line === 2 && !p[0].why,
  '★見出しの行で「学籍」「氏名」の列を見つけ、全角スペースの氏名を姓と名に分ける（何行目かも覚える）');
h.check(p[1].account === 'Y250002' && p[1].given_name === '次郎' && p[1].phone === '' && !p[1].why, '★学部・備考は読まない。小文字の学籍番号も大文字にそろえる');
p = parse('理工学部\tY250001\t新人　太郎\t備考');
h.check(p.length === 1 && p[0].account === 'Y250001' && p[0].given_name === '太郎', '見出しの行が無くても、学籍番号の形のセルと、その右の氏名を読む');
p = parse('Y250001\t新人　太郎\nY250002');
h.check(!p[0].why && /氏名がありません/.test(p[1].why), '学籍と氏名の2列だけでもよい。氏名が無い行を見分ける');
p = parse('Y25-0001\t新人　太郎\nY250002\t新人　次郎');
h.check(p.length === 2 && /学籍番号が見つかりません/.test(p[0].why) && !p[1].why,
  '★見出しの無い名簿で1行目の学籍番号がおかしくても、その行を捨てずに赤くする（黙って2行目だけ登録しない・PR #59 のレビュー）');
p = parse('Y250001\t新人　太郎\t090-1234-5678');
h.check(p[0].phone === '' && p[0].given_name === '太郎', '見出しの無い名簿では電話を読まない（備考の数字を電話と取り違えない）');
p = parse('番号\t名前\nY250001\t新人　太郎');
h.check(/学籍番号が見つかりません/.test(p[0].why) && !p[1].why, '読めない見出しの行は、赤い行として出す（直してもらう）');
p = parse('学籍\t氏名\nABC\t新人　太郎\nY250003\t新人三郎\n\t新人　四郎');
h.check(/学籍番号の形/.test(p[0].why) && /姓と名/.test(p[1].why) && /学籍番号がありません/.test(p[2].why),
  '直すところのある行を見分ける（学籍番号の形・姓と名が分けられない・学籍番号が無い）');
// 登録済みの人に印を付ける（いま表示している名簿で）
page.ctx.DATA = { rows: [{ staff_id: 'S1', account: 'Y240001', name: '既存 学生' }, { staff_id: 'S2', account: 'Y240002', name: '既存 花子' }] };
p = parse('学籍\t氏名\nY240001\t既存　学生\nY240002\t既存　桃子\nY250001\t新人　太郎\nY250001\t新人　太郎\nY250009\t新人　五郎\nY250009\t別人　六郎');
h.check(p[0].state === 'registered' && !p[0].nameDiffers, '★登録済みの人に印を付ける');
h.check(p[1].state === 'registered' && p[1].nameDiffers && p[1].current === '既存 花子', '★登録済みで名前が違えば、今の名簿の名前と並べる');
h.check(p[2].state === 'new' && p[3].state === 'duplicate', '新しい人と、同じ貼り付けの中の2回目');
h.check(/氏名が違います/.test(p[5].why), '同じ学籍番号で氏名が違えば直してもらう');
// 窓：読み取ったあと、登録を押すと registerStaff に読み取った内容を送る
page.ctx.openStaffDialog('bulk');
page.el('bulkText').value = '学籍\t氏名\nY240001\t既存　学生\nY250001\t新人　太郎\nY250002\t新人　次郎';
page.ctx.bulkPreview();
h.check(page.el('staffDialogGo').disabled === false && page.el('staffDialogGo').textContent === '2 人を登録する',
  '★新しい人の人数をボタンに出す（登録済みは数えない）');
h.check(/新しく登録するのは 2 人/.test(page.el('bulkPreview').innerHTML) && /登録済み（飛ばす）/.test(page.el('bulkPreview').innerHTML),
  '読み取りの結果に、登録済みで飛ばす人を出す');
page.ctx.staffDialogGo();
const call = page.calls.filter((c) => c.name === 'registerStaff')[0];
h.check(call && call.args[0].length === 3 && call.args[0][2].given_name === '次郎' && call.args[0][0].account === 'Y240001',
  '★登録済みの人も含めて送る（最後はサーバーが学籍番号で見分ける）');
page.reply(page.calls.indexOf(call), { ok: true, registered: [{ line: 2, name: '新人 太郎' }, { line: 3, name: '新人 次郎' }],
  skipped: [{ line: 1, account: 'Y240001', name: '既存 学生', current: '既存 学生', nameDiffers: false, reason: 'registered' }] });
h.check(/2 人を登録しました/.test(page.el('rosterMsg').innerHTML) && /1 人は飛ばしました/.test(page.el('rosterMsg').innerHTML),
  '登録した人数と、飛ばした人数を出す');
page.ctx.openStaffDialog('bulk');
page.el('bulkText').value = '学籍\t氏名\nY240001\t既存　学生';
page.ctx.bulkPreview();
h.check(page.el('staffDialogGo').disabled === true, '新しい人がいなければ登録を押せない');
page.el('bulkText').value = '学籍\t氏名\nABC\t新人　太郎\nY250001\t新人　太郎';
page.ctx.bulkPreview();
h.check(page.el('staffDialogGo').disabled === true, '直すところがあれば登録を押せない');
// 職員の行を直す窓では、学籍番号を変えられない
page.ctx.DATA = { rows: [{ staff_id: 'T1', account: 'SHIENSHITSU', name: '職員 花子', isStudent: false, phone: '' },
  { staff_id: 'S1', account: 'Y240001', name: '既存 学生', isStudent: true, phone: '' }] };
page.ctx.openStaffDialog('edit', 'T1');
h.check(/readonly/.test(page.el('staffDialogBody').innerHTML) && /変えられません/.test(page.el('staffDialogBody').innerHTML),
  '★職員の行を直す窓では、学籍番号の欄を変えられない');
page.ctx.openStaffDialog('edit', 'S1');
h.check(!/readonly/.test(page.el('staffDialogBody').innerHTML), '学生スタッフの行は学籍番号を直せる');

h.section('13) 確認の「はい」のあと、その場で業務と空きコマを登録する');
setup(); asStaff();
G.registerStaff([ONE]);
contactOf('Y250001').webhook_url = HOOK;
asEmail(ONE_MAIL);
h.check(/本人の確認/.test(errOf(() => G.updateMyProfile({ skills: ['テイク'], slotsByType: { 'テイク': ['月1'] } }))),
  '★確認がまだの人は、業務と空きコマを保存できない');
G.confirmMyIdentity(true);
const sv = G.updateMyProfile({ skills: ['テイク'], slotsByType: { 'テイク': ['月1'] } });
const meRow = h.row('staffs', 'staff_id', contactOf('Y250001').staff_id);
h.check(sv.ok && meRow.available_slots === '月1' && meRow.skills === 'テイク', '確認のあとは、業務と空きコマを保存できる');
h.check(contactOf('Y250001').webhook_url === HOOK, '★通知先を送らなければ、通知先は今のまま（空にしない）');
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

h.section('14) 移行：account 列を足し、DM の列を足す（migrateContactsToAccount）。email はそのまま残す');
// 連絡先DBの contacts を、行列のまま持つ偽のシートで表す（移行は Sheets.gs を通らず、直接セルを書き換えるため）
function fakeContacts(grid) {
  const sheet = {
    grid: grid,
    writes: 0,
    failOnWrite: 0,   // n 回目の書き込みで失敗させる（途中で止まったときを試す）
    getLastColumn() { return grid[0].length; },
    getLastRow() { return grid.length; },
    getMaxRows() { return grid.length + 50; },
    getRange(r, c, nr, nc) {
      return {
        getValues() { return grid.slice(r - 1, r - 1 + nr).map((row) => row.slice(c - 1, c - 1 + nc).map((v) => (v === undefined ? '' : v))); },
        setValues(vals) {
          sheet.writes++;
          if (sheet.failOnWrite && sheet.writes === sheet.failOnWrite) throw new Error('書き込みに失敗（試験）');
          vals.forEach((vrow, i) => {
            while (grid.length < r + i) grid.push(new Array(grid[0].length).fill(''));
            vrow.forEach((v, j) => { grid[r - 1 + i][c - 1 + j] = v; });
          });
        },
        setNumberFormat() {},
      };
    },
  };
  h.context.openContactsDb_ = function () { return { getSheetByName: (n) => (n === 'contacts' ? sheet : null) }; };
  return sheet;
}
const col = (sh, name) => sh.grid[0].indexOf(name);
const logs = [];
h.context.Logger = { log: (m) => logs.push(String(m)) };
h.setUser({ staff_id: 'T1', name: '職員', role: '職員', email: STAFF_MAIL });
let sh = fakeContacts([
  ['staff_id', 'name', 'email', 'phone', 'webhook_url', 'confirmed_at'],
  ['T1', '職員 花子', STAFF_MAIL, '', '', '2026-01-01'],
  ['S1', '既存 学生', 'Y240001@Mail.Ryukoku.ac.jp', '090-0000-0001', HOOK, '2026-01-01'],
  ['', '', '', '', '', ''],
]);
G.migrateContactsToAccount();
const ac = col(sh, 'account');
h.check(ac === 6 && sh.grid[1][ac] === 'SHIENSHITSU' && sh.grid[2][ac] === 'Y240001' && sh.grid[3][ac] === '',
  '★account 列を新しく足し、「@より前」の大文字を入れる（空行は空のまま）');
h.check(sh.grid[0][2] === 'email' && sh.grid[2][2] === 'Y240001@Mail.Ryukoku.ac.jp',
  '★email 列は書き換えない（前の版がそのまま動き、前の版へ戻しても入れる・PR #59 のレビュー）');
h.check(sh.grid[0].slice(7).join() === 'dm_space,dm_error,dm_error_at', '★DM の列を足す');
h.check(sh.grid[2][4] === HOOK && sh.grid[2][3] === '090-0000-0001', 'ほかの列（電話・通知先）はそのまま');
// 2回目：前の版に戻していた間に email だけで登録された人がいれば、その行だけ埋める
sh.grid.push(['S2', '戻し中 太郎', 'y240002@mail.ryukoku.ac.jp', '', '', '2026-01-02', '', '', '', '']);
logs.length = 0;
G.migrateContactsToAccount();
h.check(sh.grid[0].length === 10 && sh.grid[4][ac] === 'Y240002' && sh.grid[2][ac] === 'Y240001',
  '★もう一度実行すると、account が空で email がある行だけを埋める（列は増やさない）');
logs.length = 0;
G.migrateContactsToAccount();
h.check(logs.some((m) => /埋める行もありません/.test(m)), 'もう埋める行が無ければ、何も書き換えない');
// おかしい行があれば、何も書かない
sh = fakeContacts([
  ['staff_id', 'name', 'email', 'phone', 'webhook_url', 'confirmed_at'],
  ['S1', '既存 学生', 'y240001@mail.ryukoku.ac.jp', '', '', ''],
  ['S2', '学外 太郎', 'taro@example.com', '', '', ''],
  ['S3', '重複 花子', 'Y240001@mail.ryukoku.ac.jp', '', '', ''],
]);
logs.length = 0;
G.migrateContactsToAccount();
h.check(sh.grid[0].length === 6 && sh.writes === 0,
  '★大学のメールでない行・同じ学籍番号になる行があれば、何も書かない（account も DM の列も足さない）');
h.check(logs.some((m) => /3行目.*大学のメールではありません/.test(m)) && logs.some((m) => /4行目.*2行目と同じ学籍番号/.test(m)),
  '直す行を、何行目か・なぜかで出す');
// 見出しと値は1回の書き込みで入る：書き込みに失敗しても、見出しだけの列が残らない
sh = fakeContacts([
  ['staff_id', 'name', 'email', 'phone', 'webhook_url', 'confirmed_at'],
  ['S1', '既存 学生', 'y240001@mail.ryukoku.ac.jp', '', '', ''],
]);
sh.failOnWrite = 1;
h.check(/失敗/.test(errOf(() => G.migrateContactsToAccount())) && sh.grid[0].indexOf('account') === -1,
  '★account の見出しと値を1回で書く（失敗しても、見出しだけ・値だけの列が残らない）');
sh.failOnWrite = 0;
G.migrateContactsToAccount();
h.check(sh.grid[1][col(sh, 'account')] === 'Y240001', '失敗のあと、もう一度実行すればそのまま移行できる');
h.deployerEmail = 'deployer@mail.ryukoku.ac.jp';
h.check(/スクリプトエディタ/.test(errOf(() => G.migrateContactsToAccount())), '★画面からは実行できない（GAS エディタから実行する）');
h.deployerEmail = '';

h.section('14b) 前の版へ戻すとき：学籍番号から email を入れる（restoreContactEmailsForRollback）');
sh = fakeContacts([
  ['staff_id', 'name', 'email', 'phone', 'webhook_url', 'confirmed_at', 'account'],
  ['S1', '既存 学生', 'y240001@mail.ryukoku.ac.jp', '', '', '2026-01-01', 'Y240001'],
  ['S9', '新人 太郎', '', '', '', '', 'Y250001'],
]);
G.restoreContactEmailsForRollback();
h.check(sh.grid[2][2] === 'y250001@mail.ryukoku.ac.jp' && sh.grid[1][2] === 'y240001@mail.ryukoku.ac.jp',
  '★この版で登録した人（email が空）に、学籍番号から作ったメールを入れる（前の版でも入れるように）。今ある email はそのまま');

h.section('14c) confirmed_at の移行：見出しと値を1回で書く（migrateAddContactConfirmedAt）');
sh = fakeContacts([
  ['staff_id', 'name', 'account', 'phone', 'webhook_url'],
  ['T1', '職員 花子', 'SHIENSHITSU', '', ''],
  ['', '', '', '', ''],
  ['S1', '既存 学生', 'Y240001', '', ''],
]);
sh.failOnWrite = 1;
h.check(/失敗/.test(errOf(() => G.migrateAddContactConfirmedAt())) && sh.grid[0].indexOf('confirmed_at') === -1,
  '★書き込みに失敗しても、見出しだけの列が残らない（今いる人が「確認がまだ」になって通知から外れない・PR #59 のレビュー）');
sh.failOnWrite = 0;
G.migrateAddContactConfirmedAt();
const cc = col(sh, 'confirmed_at');
h.check(!!sh.grid[1][cc] && sh.grid[2][cc] === '' && !!sh.grid[3][cc], 'もう一度実行すれば、今いる全員を確認済みにする（空行は空）');
sh.grid.push(['S9', '新人 太郎', 'Y250001', '', '', '']);   // 移行のあとで職員が登録した人（確認がまだ）
G.migrateAddContactConfirmedAt();
h.check(sh.grid[4][cc] === '', '★移行のあとに登録された、確認がまだの人を確認済みにしない（2回目は何もしない）');

h.section('15) 確認がまだの人には、マイページの中身も返さない');
setup(); asStaff();
G.registerStaff([ONE]);
asEmail(ONE_MAIL);
h.check(/本人の確認/.test(errOf(() => G.getMyProfile())), '★確認がまだなら getMyProfile は電話・通知先・空きコマを返さない（PR #59 のレビュー）');
G.confirmMyIdentity(true);
h.check(G.getMyProfile().isStudent === true, '確認のあとは今まで通り返す');

h.section('16) 学籍番号を直したら、覚えていた DM の宛先も消す');
setup(); asStaff();
Object.assign(contactOf('Y240001'), { dm_space: 'spaces/OLD', dm_error: '前の失敗', dm_error_at: '2026-11-01 10:00' });
G.updateStaffContact({ staff_id: 'S1', account: 'Y240001', family_name: '既存', given_name: '学生', phone: '' });
h.check(contactOf('Y240001').dm_space === 'spaces/OLD', '学籍番号を変えなければ、DM の宛先はそのまま');
G.updateStaffContact({ staff_id: 'S1', account: 'Y240009', family_name: '既存', given_name: '学生', phone: '' });
const moved = contactOf('Y240009');
h.check(moved.dm_space === '' && moved.dm_error === '' && moved.dm_error_at === '' && moved.confirmed_at === '',
  '★学籍番号を変えたら、DM の宛先と送れなかった記録を消し、確認もやり直す（前の人に届き続けない・PR #59 のレビュー）');

h.section('17) ロック：入れ子にしても、一番外側でだけ取って外す（Sheets.gs の withLock_）');
{
  const vm = require('vm');
  const fs = require('fs');
  const path = require('path');
  const ev = [];
  const ctx = vm.createContext({
    LockService: { getScriptLock: () => ({ waitLock: () => ev.push('取る'), releaseLock: () => ev.push('外す') }) },
    console: console,
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'Sheets.gs'), 'utf8'), ctx, { filename: 'Sheets.gs' });
  const out = vm.runInContext(
    'withLock_(function () { log.push("外の前"); withLock_(function () { log.push("中"); }); log.push("外の後"); return 1; })',
    Object.assign(ctx, { log: ev }));
  h.check(out === 1 && ev.join('→') === '取る→外の前→中→外の後→外す',
    '★内側の withLock_ はロックを外さない（「確かめてから書く」の途中で、ほかの実行が割り込まない）：' + ev.join('→'));
  ev.length = 0;
  try { vm.runInContext('withLock_(function () { withLock_(function () { throw new Error("x"); }); })', ctx); } catch (e) { /* 期待どおり */ }
  vm.runInContext('withLock_(function () {})', ctx);
  h.check(ev.join('→') === '取る→外す→取る→外す', '中で失敗しても、深さが戻り、次の呼び出しはまたロックを取る');
}

process.exitCode = h.report();
