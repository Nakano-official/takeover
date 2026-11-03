/**
 * 時間割PDF（受講登録確認表）の読み取り検証（D52） — Node 上で実行する
 *
 *     node tools/sim-timetable-pdf.js
 *
 * `src/shared-timetable-pdf.html` の `<script>` をそのまま読み込み、
 * pdf.js が返すのと同じ形の「文字＋座標」を**架空のデータで**組み立てて渡す。
 *
 * ■ 本物の PDF は使わない・置かない（学籍番号と氏名が載っている。リポジトリは Public）。
 *   座標は 2026-09 の実物（一覧表の形）を pdf.js で読んだときの並びに合わせてある：
 *   見出しは中央寄せ・中身は左寄せ／科目名だけ 1.5 上にずれる／見出しは字を離して書く
 *   （「授 業 科 目 名」「備　　考」）／ページは 90° 回転（ここでは回転後の座標で書く）。
 *
 * ■ pdf.js 自体（CDN から読む部分）はここでは確かめない。手元で実物を読む確認は
 *   pdfjs-dist を別の場所に入れて行った（D52）。画面の中で動くかは /dev で確かめる。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'shared-timetable-pdf.html'), 'utf8');
const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
const G = { window: {} };
vm.createContext(G);
vm.runInContext(script, G);

let pass = 0;
const fails = [];
function check(cond, label) {
  if (cond) { pass++; console.log('  ✅ ' + label); } else { fails.push(label); console.log('  ❌ ' + label); }
}

// ─── 架空の受講登録確認表を「文字＋座標」で組み立てる ───────────────────

const HEAD_Y = 88;
// 見出し（実物と同じ位置・同じ字の離し方）
function headerItems(dx) {
  dx = dx || 0;
  const it = (x, s, w) => ({ x: x + dx, y: HEAD_Y, w: w, s: s });
  return [
    it(24, '曜日', 18), it(49, '講時', 18), it(73.5, '開講期', 27), it(106.5, '時間割番号', 45),
    it(172.5, '区分', 18),
    it(253.5, '授', 9), it(271.5, '業', 9), it(289.5, '科', 9), it(307.5, '目', 9), it(325.5, '名', 9),
    it(383, '単位', 18), it(408, '制限外', 27), it(462, '開講学舎', 36),
    it(551.5, '担', 9), it(569.5, '当', 9), it(587.5, '教', 9), it(605.5, '員', 9), it(623.5, '名', 9),
    it(715.5, '備', 9), it(760.5, '考', 9),
  ];
}
// 表の上の情報
function topItems(opts) {
  opts = opts || {};
  const out = [
    { x: 24, y: 20.6, w: 48, s: (opts.year || '2026') + '年度' },
    { x: 81, y: 20.6, w: 72, s: (opts.sem || '後期') + '履修登録' },
    { x: 24, y: 44.6, w: 112, s: '受講登録確認表' },
    { x: 24, y: 60.6, w: 136, s: '（第1回履修登録）' },
  ];
  if (opts.name !== false) {
    out.push(
      { x: 190.5, y: 61.4, w: 63, s: '学籍番号／氏名' },
      { x: 267, y: 61, w: 28, s: 'X000000' },
      { x: 315, y: 61, w: 16, s: '架空' },
      { x: 339, y: 61, w: 48, s: '花子（カクウ' },
      { x: 395, y: 61, w: 32, s: 'ハナコ）' });
  }
  return out;
}
/** 1行ぶん。day は「月」「集中」、period は全角の「３」など */
function row(y, r, dx) {
  dx = dx || 0;
  const it = (x, s, w, yy) => ({ x: x + dx, y: yy == null ? y : yy, w: w, s: s });
  const out = [];
  if (r.day === '集中') out.push(it(24, '集中', 18));
  else { out.push(it(28.5, r.day, 9)); out.push(it(53.5, r.period, 9)); }
  out.push(it(78, r.term, 18), it(112.3, r.code, 31.5), it(157, '受講可', 27));
  out.push(it(212, r.subject, 9 * r.subject.length, y - 1.5));     // 科目名だけ少し上
  if (r.units) out.push(it(389.8, r.units, 4.5));
  out.push(it(444, '瀬田', 18));
  r.instructor.split('　').forEach((p, i) => out.push(it(523 + i * 27, p, 9 * p.length)));
  if (r.note) out.push(it(664, r.note, 90));
  return out;
}
function page(rows, opts) {
  opts = opts || {};
  let items = opts.noTop ? [] : topItems(opts);
  if (!opts.noHeader) items = items.concat(headerItems(opts.dx));
  rows.forEach((r, i) => { items = items.concat(row(108 + i * 16, r, opts.dx)); });
  // 下の集計欄（表の行ではない数字。番号の形をしていないので拾わないこと）
  items.push({ x: 24, y: 400, w: 60, s: '履修登録単位数' }, { x: 60, y: 420, w: 9, s: '24' });
  return items;
}

const R = {
  mon3: { day: '月', period: '３', term: '後期', code: 'U13Z001', subject: '基礎数学Ａ', units: '2', instructor: '仮名　一郎', note: '【オープン登録科目】' },
  mon4: { day: '月', period: '４', term: '後期', code: 'U14Z002', subject: '情報演習', units: '4', instructor: '仮名　次郎' },
  mon5: { day: '月', period: '５', term: '後期', code: 'U14Z002', subject: '情報演習', instructor: '仮名　次郎' },
  tue2: { day: '火', period: '２', term: '後期', code: 'U22Z003', subject: '社会と統計', units: '2', instructor: '仮名　三郎' },
  thu1Q3: { day: '木', period: '１', term: '３Ｑ', code: 'U41Z004', subject: '線形代数Ｂ', units: '2', instructor: '仮名　四郎' },
  fri2Q3: { day: '金', period: '２', term: '３Ｑ', code: 'U52Z005', subject: '物理実験', units: '1', instructor: '仮名　五郎' },
  year: { day: '水', period: '３', term: '通年', code: 'U33Z006', subject: '卒業研究', units: '4', instructor: '仮名　六郎' },
  intensive: { day: '集中', term: '後期', code: 'U88Z007', subject: '集中セミナー', units: '2', instructor: '仮名　七子' },
  sat6: { day: '土', period: '６', term: '後期', code: 'U66Z008', subject: '夜間講座', units: '2', instructor: '仮名　八郎' },
  sun1: { day: '日', period: '１', term: '後期', code: 'U71Z009', subject: '日曜講座', units: '2', instructor: '仮名　九郎' },
};

const CTX = {
  terms: ['2026-前期', '2026-後期', '2026-1Q', '2026-2Q', '2026-3Q', '2026-4Q'],
  days: ['月', '火', '水', '木', '金', '土'],
  periods: ['1', '2', '3', '4', '5'].map((p) => ({ period: p, label: p + '限', supportTypes: ['テイク', '介助'] }))
    .concat([{ period: '移動前3', label: '移動（3限の前）', supportTypes: ['介助'] }]),
  courses: [],
  current: '2026-後期',
};
const ctx = (over) => Object.assign({}, CTX, over || {});
const slots = (plan) => plan.cards.map((c) => c.day + c.period).join(',');
const reasons = (plan) => plan.skipped.map((s) => s.reason);

// ─── 1. 基本の読み取り ────────────────────────────────────────────
console.log('\n1. 一覧表を1行ずつ読む');
let p = G.tpdfParsePages([page([R.mon3, R.mon4, R.mon5, R.tue2])]);
check(p.problems.length === 0, '見出しを見つける（問題なし）');
check(p.year === '2026' && p.semester === '後期', '年度と学期を表の上から読む（2026・後期）');
check(p.studentName === '架空　花子', '氏名は学籍番号を飛ばし、フリガナの手前まで（' + p.studentName + '）');
check(p.rows.length === 4, '4行すべて読む');
const r0 = p.rows[0];
check(r0.day === '月' && r0.period === '3', '全角の時限「３」を半角にする');
check(r0.term === '後期' && r0.code === 'U13Z001', '開講期と時間割番号');
check(r0.subject === '基礎数学Ａ', '少し上にずれた科目名も同じ行として拾う');
check(r0.instructor === '仮名　一郎', '教員の姓と名を全角空白でつなぐ');
check(r0.instructor.indexOf('オープン') === -1, '備考（「備　　考」と字が離れた見出し）を教員の列に混ぜない');
check(p.rows[2].subject === '情報演習' && p.rows[2].period === '5', '単位の無い行（2コマ続きの2つ目）も読む');

// ─── 2. カードへの振り分け ─────────────────────────────────────────
console.log('\n2. どの学期にどのカードを作るか');
let plan = G.tpdfPlan(p, ctx());
check(plan.target === '2026-後期', '開講期「後期」→ 学期「2026-後期」');
check(slots(plan) === '月3,月4,月5,火2', '2コマ続きは2枚のカード（いまの手入力と同じ）');
check(plan.cards[0].subject === '基礎数学Ａ' && plan.cards[0].instructor === '仮名　一郎', '科目・教員をカードへ渡す');
check(plan.skipped.length === 0, '外すものは無い');

console.log('\n3. 集中・通年・設定に無い曜日や時限');
p = G.tpdfParsePages([page([R.mon3, R.intensive, R.year, R.sat6, R.sun1])]);
plan = G.tpdfPlan(p, ctx());
check(p.rows[1].intensive === true, '「集中」の行を集中講義として読む');
check(slots(plan) === '月3,水3', '通年は PDF の学期（後期）のカードにする');
check(reasons(plan).some((x) => x.indexOf('集中講義') !== -1), '集中講義はカードにせず理由を出す');
check(reasons(plan).some((x) => x.indexOf('6限') !== -1), '時限の設定に無い 6限 は外して理由を出す（D47）');
check(reasons(plan).some((x) => x.indexOf('日曜') !== -1), '業務のある曜日に無い日曜は外して理由を出す');

console.log('\n4. 学期が混ざっている PDF（先端理工：後期と 3Q）');
p = G.tpdfParsePages([page([R.mon3, R.thu1Q3, R.fri2Q3, R.tue2, R.mon4])]);
plan = G.tpdfPlan(p, ctx({ current: '2026-後期' }));
check(plan.target === '2026-後期' && slots(plan) === '月3,火2,月4', 'いま選んでいる学期（後期）の行だけカードにする');
check(plan.otherTerms['2026-3Q'] === 2, '残りの 3Q は「別の学期」として件数を返す（ボタンで作り直せる）');
plan = G.tpdfPlan(p, ctx({ current: '2026-3Q' }));
check(plan.target === '2026-3Q' && slots(plan) === '木1,金2', '3Q を選べば 3Q の行だけ');
plan = G.tpdfPlan(p, ctx({ current: '2026-1Q' }));
check(plan.target === '2026-後期', '選んでいる学期の行が無ければ、行のいちばん多い学期へ寄せる');

console.log('\n5. 二重登録を避ける');
p = G.tpdfParsePages([page([R.mon3, R.tue2])]);
plan = G.tpdfPlan(p, ctx({
  courses: [{ quarter: '2026-後期', day: '月', period: '3', date: '', user_student: '架空 花子' }],
}));
check(slots(plan) === '火2', '同じ利用者・曜日・時限のコマが登録済みなら作らない（空白の違いは無視）');
check(reasons(plan).some((x) => x.indexOf('登録済み') !== -1), '登録済みとして理由を出す');
plan = G.tpdfPlan(p, ctx({
  courses: [{ quarter: '2026-後期', day: '月', period: '3', date: '', user_student: '別の 利用者' }],
}));
check(slots(plan) === '月3,火2', '別の利用者のコマは重複ではない');
plan = G.tpdfPlan(p, ctx({
  courses: [{ quarter: '2026-後期', day: '月', period: '3', date: '2026-11-02', user_student: '架空 花子' }],
}));
check(slots(plan) === '月3,火2', '同じ曜日・時限でも単発コマ（D27）は毎週の授業と別物');
plan = G.tpdfPlan(p, ctx({ user: '架空花子（登録名）' }));
check(slots(plan) === '月3,火2', '画面で利用者名を差し替えたときはその名前で比べる');

console.log('\n6. 学期マスタに無い年度');
p = G.tpdfParsePages([page([R.mon3], { year: '2027' })]);
plan = G.tpdfPlan(p, ctx());
check(plan.target === '' && plan.cards.length === 0, '学期マスタに無い学期のカードは作らない');
check(reasons(plan).some((x) => x.indexOf('2027-後期') !== -1), '「学期マスタに 2027-後期 がありません」と出す');

console.log('\n7. 2ページにわたる PDF');
p = G.tpdfParsePages([
  page([R.mon3, R.mon4]),
  page([R.mon5, R.tue2], { noTop: true, noHeader: true }),
]);
check(p.rows.length === 4, '見出しの無い2ページ目は、1ページ目の列の位置で読む');
check(p.rows[3].subject === '社会と統計', '2ページ目の中身も正しく読む');
p = G.tpdfParsePages([
  page([R.mon3, R.mon4]),
  page([R.mon5, R.tue2], { noTop: true }),
]);
check(p.rows.length === 4 && p.studentName === '架空　花子', '2ページ目に見出しが繰り返されても同じ結果');

console.log('\n8. 余白が少しずれても崩れない');
p = G.tpdfParsePages([page([R.mon3, R.tue2], { dx: 18 })]);
check(p.rows.length === 2 && p.rows[0].subject === '基礎数学Ａ' && p.rows[1].instructor === '仮名　三郎',
  '全体が右へ 18 ずれても読める（列の位置を決め打ちしていない）');

console.log('\n9. 違う資料を選んだとき');
p = G.tpdfParsePages([[
  { x: 24, y: 20, w: 48, s: '2024年度' },
  { x: 80, y: 73, w: 7, s: '月' }, { x: 196, y: 73, w: 7, s: '火' },
  { x: 26, y: 81, w: 10, s: '後期' }, { x: 55, y: 81, w: 10, s: 'G001' },
]]);
check(p.rows.length === 0 && p.problems.length === 1, '一覧の見出しが無ければ（2024年までの格子の形など）、読まずに理由を出す');
p = G.tpdfParsePages([page([R.mon3], { name: false })]);
check(p.studentName === '' && p.rows.length === 1, '氏名が読めなくても授業は読む（利用者は画面で選ぶ）');

// ─── 10. サーバー側：数式として動く値を書き込ませない ───────────────
// PDF は学生がメールで送ってくる（＝中身を誰でも書き換えられる）。画面の検査を通らない経路
// （画面を介さない呼び出し）でも止まるよう、Input.gs の validateCoursePayload_ で確かめる。
console.log('\n10. 先頭が = + - @ の値はシートに書かない（Input.gs）');
const { Harness } = require('./gas-harness');
const h = new Harness();
h.load(['Constants.gs', 'Util.gs', 'Terms.gs', 'Vacancy.gs', 'Input.gs']);
h.add('terms', { term_id: '2026-後期', system: 'semester', start_date: '2026-09-21', end_date: '2027-01-30' });
h.add('periods', { period: '3', start_time: '13:30', end_time: '15:00' });
h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
h.setUser({ staff_id: 'T1', name: '職員', role: '職員' });
const base = { quarter: '2026-後期', day: '月', period: '3', support_type: 'テイク', user_student: '架空 花子' };
function rejects(over) {
  try { h.G.addCourse(Object.assign({}, base, over)); return ''; } catch (e) { return e.message; }
}
[
  ['subject', '=SUM(A1:A3)', '科目名'],
  ['instructor', '+HYPERLINK("https://example.invalid","x")', '担当教員'],
  ['user_student', '-1+cmd', '利用者'],
  ['room', '@SUM(A1)', '教室'],
  ['note', '＝1+1', '備考'],
].forEach(function (x) {
  const o = {}; o[x[0]] = x[1];
  const msg = rejects(o);
  check(msg.indexOf(x[2] + 'の先頭に') !== -1, x[2] + '「' + x[1].slice(0, 12) + '…」を弾く');
});
check(rejects({ subject: '線形代数Ｂ（=演習つき）' }) === '', '途中に = があるだけなら登録できる');
check(h.G.readRows_('courses').length === 1, '弾いた値は1件もシートに書いていない（書けたのは通常の1件だけ）');

console.log('\n' + '='.repeat(50));
if (fails.length) {
  console.log('❌ ' + fails.length + '件失敗 / ' + (pass + fails.length) + '件');
  process.exitCode = 1;
} else {
  console.log('✅ ' + pass + '件すべて成功');
}
