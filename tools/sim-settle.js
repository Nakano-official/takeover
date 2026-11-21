/**
 * 決着の選択肢・判断に要る情報・欠勤連絡の確認（issue #52〜#54）の検証 — Node 上で実行する
 *
 *     node tools/sim-settle.js
 *
 * 守りたいこと：
 *   1. 介助の欠員は「1人テイク」にできない（画面にボタンを出さず、直接呼ばれてもサーバーが止める・#52）
 *   2. テイクは、その日その時間に担当が残るときだけ「1人テイク」を選べる（相方も欠勤なら不可・相方の代行が
 *      決まっていれば可・#52）
 *   3. 代行への回答・欠員補充管理・確定の確認で、業務・利用者・科目・教室が分かる（#53）
 *   4. 欠勤連絡は確認を挟む。確認の時点ではサーバーを呼ばず、確定したら確認した内容で1回だけ送る（#54）
 *
 * 画面は tools/page-vm.js で、本物の src/*.html のスクリプトを動かして確かめる。
 */
const { Harness } = require('./gas-harness');
const { loadPage } = require('./page-vm');

const h = new Harness();
h.load(['Constants.gs', 'Util.gs', 'Terms.gs', 'Vacancy.gs', 'Access.gs', 'ClassCalendar.gs', 'Cancellation.gs',
  'Input.gs', 'code.js', 'Identity.gs']);
const G = h.G;
const T = h.time;

// 1〜2週間先の、業務のある曜日（日曜を避ける）
var D = T.dateIn(8);
if (G.weekdayOf_(D) === '日') D = T.dateIn(9);
const DAY = G.weekdayOf_(D);

function setup() {
  h.reset();
  h.add('terms', { term_id: 'X-後期', system: 'semester', start_date: T.dateIn(-30), end_date: T.dateIn(90) });
  h.add('periods', { period: '1', start_time: '09:15', end_time: '10:45' });
  h.add('periods', { period: '2', start_time: '11:00', end_time: '12:30' });
  [['S1', '学生 一郎'], ['S2', '学生 二郎'], ['S3', '学生 三郎'], ['S4', '学生 四郎'], ['S5', '代行 五郎']].forEach(function (s) {
    h.add('staffs', { staff_id: s[0], name: s[1], role: '学生', skills: '',
      available_slots: s[0] === 'S5' ? DAY + '1' : '', assist_slots: s[0] === 'S5' ? DAY + '2' : '' });
    h.add('contacts', { staff_id: s[0], name: s[1], email: s[0].toLowerCase() + '@example.jp', phone: '090-0000-000' + s[0].slice(1) });
  });
  h.add('staffs', { staff_id: 'T1', name: '職員 花子', role: '職員' });
  h.add('contacts', { staff_id: 'T1', name: '職員 花子', email: 't1@example.jp' });
  const c = (id, period, type, user, a, b, extra) => h.add('courses', Object.assign({ course_id: id, quarter: 'X-後期', day: DAY,
    period: period, support_type: type, user_student: user, staff_a_id: a, staff_b_id: b || '' }, extra || {}));
  c('CT', '1', 'テイク', '架空 花子', 'S1', 'S2', { subject: '線形代数', room: '講義室A' });
  c('CA', '2', '介助', '架空 花子', 'S3', '', { subject: '経済学入門', room: '' });
  c('CT1', '1', 'テイク', '仮名 太郎', 'S4', '');   // もともと1人のテイク
  h.add('vacancies', { vacancy_id: 'VT', date: D, course_id: 'CT', absent_staff_id: 'S1', result: '' });
  h.add('vacancies', { vacancy_id: 'VA', date: D, course_id: 'CA', absent_staff_id: 'S3', result: '' });
  h.add('vacancies', { vacancy_id: 'VT1', date: D, course_id: 'CT1', absent_staff_id: 'S4', result: '' });
}
const asStaff = () => h.setUser({ staff_id: 'T1', name: '職員 花子', role: '職員', email: 't1@example.jp' });
const as = (id) => h.setUser({ staff_id: id, name: h.row('staffs', 'staff_id', id).name, role: '学生', email: id.toLowerCase() + '@example.jp' });
const errOf = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
const vac = (id) => h.row('vacancies', 'vacancy_id', id);
const manageOf = () => {
  asStaff();
  const byId = {};
  JSON.parse(JSON.stringify(G.getVacanciesForManage())).forEach((v) => { byId[v.vacancy_id] = v; });
  return byId;
};
// 欠員補充管理の画面（manage.html）。一時キャッシュ（shared-cache）は使わないので空の代わりを渡す
const managePage = () => loadPage('manage', { globals: {
  viewCacheLoad() {}, viewCacheLocked() { return false; }, viewCacheClear() {},
} });

console.log('===== 決着の選択肢・判断の情報・欠勤連絡の確認（#52〜#54）=====');

h.section('1) 介助の欠員に「1人テイク」は出さない・受け付けない（#52）');
setup();
let m = manageOf();
h.check(m.VA.settleOptions.join() === '職員対応', '★介助の欠員の選択肢は「職員対応」だけ');
h.check(m.VT.settleOptions.join() === '1人テイク,職員対応', 'テイクで相方が残るなら「1人テイク」も選べる');
h.check(m.VT1.settleOptions.join() === '職員対応', 'もともと1人のテイクは、欠勤すると誰も残らないので「職員対応」だけ');
const closedBefore = h.notifiesOf('closed').length;
h.check(/介助/.test(errOf(() => G.setVacancyResult('VA', '1人テイク')) || ''), '★介助に直接「1人テイク」を送っても止める');
h.check(vac('VA').result === '' && h.notifiesOf('closed').length === closedBefore && h.db.responses.length === 0,
  '止めたときは、欠員・回答・通知を変えない');
h.check(/ほかに入る担当がいません/.test(errOf(() => G.setVacancyResult('VT1', '1人テイク')) || ''), '誰も残らないテイクも「1人テイク」にできない');
h.check(G.setVacancyResult('VT', '1人テイク').ok && vac('VT').result === '1人テイク', '★相方が残るテイクは「1人テイク」にできる');
h.check(G.setVacancyResult('VA', '職員対応').ok && vac('VA').result === '職員対応', '「職員対応」は今まで通り');
setup();
asStaff();
h.check(G.confirmSubstitute('VA', 'S5').ok && vac('VA').substitute_staff_id === 'S5', '代行の確定は今まで通り（介助でも）');

h.section('2) 相方も欠勤・相方の代行が決まっている（#52）');
setup();
h.add('vacancies', { vacancy_id: 'VT2', date: D, course_id: 'CT', absent_staff_id: 'S2', result: '' });   // 相方も欠勤
m = manageOf();
h.check(m.VT.settleOptions.join() === '職員対応', '★相方も欠勤なら「1人テイク」は選べない');
h.check(/ほかに入る担当がいません/.test(errOf(() => G.setVacancyResult('VT', '1人テイク')) || ''), 'サーバーも止める');
vac('VT2').result = '補充済';
vac('VT2').substitute_staff_id = 'S5';
m = manageOf();
h.check(m.VT.settleOptions.join() === '1人テイク,職員対応', '★相方の欠勤に代行が決まっていれば、その人が残るので選べる');
h.check(G.suggestSettleResult_(h.row('courses', 'course_id', 'CA'), D, 'S3') === '職員対応', '決着の提案も、介助なら「職員対応」');
h.check(G.suggestSettleResult_(h.row('courses', 'course_id', 'CT'), D, 'S1') === '1人テイク', '代行が残るテイクの提案は「1人テイク」');

h.section('3) 欠員補充管理の画面のボタン（#52）と情報（#53）');
setup();
m = manageOf();
let page = managePage();
const htmlA = page.ctx.renderVacancy(m.VA);
const htmlT = page.ctx.renderVacancy(m.VT);
h.check(htmlA.indexOf('1人テイクにする') === -1 && htmlA.indexOf('職員対応にする') !== -1, '★介助のカードに「1人テイクにする」を出さない');
h.check(htmlA.indexOf('介助は1人体制') !== -1, '出さない理由を添える');
h.check(htmlT.indexOf('1人テイクにする') !== -1 && htmlT.indexOf('職員対応にする') !== -1, 'テイク（相方が残る）は両方出す');
h.check(htmlT.indexOf('テイク') !== -1 && htmlT.indexOf('架空 花子') !== -1 && htmlT.indexOf('線形代数') !== -1 &&
  htmlT.indexOf('講義室A') !== -1, '★カードに業務・利用者・科目・教室を出す');
h.check(htmlA.indexOf('教室: 未設定') !== -1, '空欄は「未設定」と出す');
const odd = Object.assign({}, m.VT, { user_student: '<b>x</b>', subject: '"><img src=x>' });
const htmlOdd = page.ctx.renderVacancy(odd);
h.check(htmlOdd.indexOf('<b>x</b>') === -1 && htmlOdd.indexOf('&lt;b&gt;x&lt;/b&gt;') !== -1 && htmlOdd.indexOf('<img') === -1,
  '表示する値はエスケープする');
// 確定の確認に、日時・コマ・代行者の名前を出す
page.ctx.render(Object.keys(m).map((k) => m[k]));
page.ctx.confirmSub('VA', 'S5', null);
const q = page.ask();
h.check(!!q && q.text.indexOf('代行 五郎') !== -1 && q.text.indexOf(D) !== -1 && q.text.indexOf('介助') !== -1 && q.text.indexOf('経済学入門') !== -1,
  '★代行の確定の確認（画面の中の窓）に、代行者の名前・日付・業務・科目を出す');
h.check(page.confirms.length === 0, '★ブラウザの確認（confirm）は使わない');
page.answer(false);
h.check(!page.calls.some((c) => c.name === 'confirmSubstitute') && page.ask() === null, '「やめる」なら確定せず、窓を閉じる');
page.ctx.confirmSub('VA', 'S5', null);
page.answer(true);
h.check(page.calls.filter((c) => c.name === 'confirmSubstitute').length === 1, '「確定する」で確定する');

h.section('4) 代行への回答画面に、判断に要る情報を出す（#53）');
setup();
h.add('courses', { course_id: 'CM', quarter: 'X-後期', day: DAY, period: '2', support_type: 'テイク', user_student: '架空 花子', staff_a_id: 'S1', staff_b_id: '' });
h.add('vacancies', { vacancy_id: 'VM', date: D, course_id: 'CM', absent_staff_id: 'S1', result: '', group_id: 'G1' });
vac('VT').group_id = 'G1';
as('S5');
const r = JSON.parse(JSON.stringify(G.getVacancyForRespond('VT')));
h.check(r.support_type === 'テイク' && r.user_student === '架空 花子' && r.subject === '線形代数' && r.room === '講義室A',
  '★回答画面へ業務・利用者・科目・教室を渡す');
h.check(r.together.length === 1 && r.together[0] === DAY + '2限', '★まとめて引き受けるほかのコマを渡す');
page = loadPage('respond');
page.ctx.render(r);
const rh = page.el('content').innerHTML;
const pos = (s) => rh.indexOf(s);
h.check(pos('線形代数') !== -1 && pos('講義室A') !== -1 && pos('架空 花子') !== -1 && pos('一緒に引き受けるコマ') !== -1,
  '★回答画面に業務・利用者・科目・教室・一緒に引き受けるコマを出す');
h.check(pos('>承諾する<') !== -1 && pos('講義室A') < pos('>承諾する<'), '情報は承諾・辞退のボタンより前に出す');
page.ctx.render(Object.assign({}, r, { room: '', subject: '<script>x</script>' }));
const rh2 = page.el('content').innerHTML;
h.check(rh2.indexOf('未設定') !== -1 && rh2.indexOf('<script>x') === -1, '空欄は「未設定」、値はエスケープする');

h.section('5) 欠勤連絡は確認を挟む（#54）');
setup();
as('S1');
const mine = JSON.parse(JSON.stringify(G.getMyCourses()));
page = loadPage('absence', { include: ['shared-dialog'] });
page.ctx.COURSES = mine;
page.el('course').value = 'CT';
page.ctx.rebuildDates();
page.el('date').value = D;
page.ctx.submit();
const sheet = page.el('absConfirm');
const body = page.el('absConfirmBody').innerHTML;
h.check(!sheet.hidden, '★「欠勤を登録」を押すと確認が出る');
h.check(!page.calls.some((c) => c.name === 'submitAbsence'), '★確認の時点ではサーバーを呼ばない');
h.check(body.indexOf(D + '（' + DAY + '）') !== -1 && body.indexOf('1限') !== -1 && body.indexOf('線形代数') !== -1 &&
  body.indexOf('架空 花子') !== -1 && body.indexOf('講義室A') !== -1, '確認に日付（曜日つき）・コマ・科目・利用者・教室を出す');
h.check(/職員へ知らせます/.test(body) && /過ぎていたら代行の募集はしません/.test(body), '通知の説明は実際の動き（締切後は募集しない）と合わせる');
page.ctx.cancelConfirm();
h.check(sheet.hidden && !page.calls.some((c) => c.name === 'submitAbsence') && page.el('course').value === 'CT' &&
  page.el('date').value === D, '★「戻って修正」で閉じる。何も送らず、入力はそのまま');
page.ctx.submit();
page.el('date').value = T.dateIn(30);   // 確認を開いたあとに入力が変わっても
page.ctx.confirmGo();
page.ctx.confirmGo();                    // 二度押し
const sent = page.calls.filter((c) => c.name === 'submitAbsence');
h.check(sent.length === 1, '★確定は1回だけ送る（二度押ししても1回）');
h.check(sent[0] && sent[0].args[0] === 'CT' && sent[0].args[1] === D, '★送るのは確認に出した内容（あとで入力が変わっても）');
// 介助で前後の移動のかたまり（D45）があるときは、一緒に休む範囲を出す
page = loadPage('absence', { include: ['shared-dialog'] });
page.ctx.COURSES = [Object.assign({}, mine[0], { course_id: 'CX', attached: ['火移動前2'] })];
page.el('course').value = 'CX';
page.el('date').value = D;
page.el('withAttached').checked = true;
page.ctx.submit();
h.check(page.el('absConfirmBody').innerHTML.indexOf('火移動前2') !== -1, 'かたまりで一緒に休む移動も確認に出す');

process.exit(h.report());
