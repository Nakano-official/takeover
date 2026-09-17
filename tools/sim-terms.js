/**
 * 学期マスタ（D16）の解決ロジック検証 — Node 上で実行する
 *
 *     node tools/sim-terms.js
 *
 * クォーター制（先端理工）とセメスター制（他学部）が**同じ暦の上で同時に走る**ため、
 * 「いま表示すべき学期の集合」は単純な1つではない。前期⊇1Q+2Q／後期⊇3Q+4Q の入れ子で、
 * 画面の既定（現在（開講中））はこの集合で決まる。
 *
 * ここが外れると**登録したコマが時間割から丸ごと消える**。エラーは出ないので、
 * 職員からは「登録したのに出ない＝壊れている」としか見えない。実際に2026-09-17、
 * 後期開始の数日前に開いたとき、寄せ先が 4Q になって 3Q のコマが全部消えた（D36）。
 *
 * **学期の境目は毎年必ず来る**ので、その時期の挙動をここで固定しておく。
 */
const { Harness } = require('./gas-harness');

const h = new Harness();
h.load(['Constants.gs', 'Attendance.gs', 'Terms.gs', 'Vacancy.gs', 'Input.gs', 'code.js']);
const G = h.G;
const T = h.time;

/** 年度まるごとの学期マスタを作る（オフセットは今日からの日数） */
function setupTerms(spec) {
  h.reset();
  spec.forEach(function (t) {
    h.add('terms', {
      term_id: t[0], system: t[1],
      start_date: T.dateIn(t[2]), end_date: T.dateIn(t[3]),
    });
  });
  h.add('periods', { period: '1', start_time: '09:15', end_time: '10:45' });
  h.add('staffs', { staff_id: 'S1', name: '担当', role: '学生', skills: '介助' });
  h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
  h.add('contacts', { staff_id: 'T1', name: '職員', email: 't@e.jp' });
  h.setUser({ staff_id: 'T1', name: '職員', role: '職員', email: 't@e.jp' });
}

function addCourse(id, term) {
  h.add('courses', {
    course_id: id, quarter: term, day: '月', period: '1',
    support_type: '介助', user_student: '利用 学生', staff_a_id: 'S1',
  });
}

const ids = (res) => res.courses.map(function (c) { return c.course_id; }).sort().join(',');

// 後期が始まる4日後・3Qは後期と同時開始・4Qはそのあと
const BEFORE_AUTUMN = [
  ['2026-前期', 'semester', -170, -10],
  ['2026-1Q', 'quarter', -170, -100],
  ['2026-2Q', 'quarter', -99, -10],
  ['2026-後期', 'semester', 4, 150],
  ['2026-3Q', 'quarter', 4, 60],
  ['2026-4Q', 'quarter', 61, 150],
];

console.log('===== 学期の解決（D16・D36）ロジック検証 =====');

// ── 1) 学期の境目（どの学期にも入っていない日）──────────────
h.section('1) 学期の境目：開講中が1つも無い日');
setupTerms(BEFORE_AUTUMN);
addCourse('C1', '2026-3Q');
addCourse('C2', '2026-4Q');
addCourse('C3', '2026-後期');

h.check(G.currentTermIds_(G.readTerms_()).length === 0, '今日を含む学期は無い');
h.check(G.currentScopeTermIds_(G.readTerms_()).length === 0, '現在の表示範囲も空になる');
h.check(G.nearestTermId_(G.readTerms_()) === '2026-後期',
  '★いちばん近い学期は後期（同着ならセメスターを優先＝表示が広いほうへ倒す）');

let res = G.getTimetable('');
h.check(ids(res) === 'C1,C2,C3',
  '★「現在（開講中）」で、これから始まる3Q・4Q・後期のコマがすべて出る');

// ここが D36 の再発防止。開始日が最新の学期（4Q）へ寄せると
// 4Q と期間が重ならない 3Q が丸ごと消える。
h.check(ids(G.getTimetable('2026-3Q')).indexOf('C1') !== -1, '3Q を指定しても出る');

h.section('1b) シフト入力の既定学期');
const input = G.getInputData('');
h.check(input.quarter === '2026-後期',
  '★入力画面の既定も近い学期（4Q が既定だと毎回選び直すことになる）');

// ── 2) 開講中がある日 ──────────────────────────────────────
h.section('2) 後期の開講中');
setupTerms([
  ['2026-前期', 'semester', -300, -140],
  ['2026-後期', 'semester', -10, 140],
  ['2026-3Q', 'quarter', -10, 50],
  ['2026-4Q', 'quarter', 51, 140],
]);
addCourse('C1', '2026-3Q');
addCourse('C2', '2026-4Q');
addCourse('C3', '2026-前期');

const scope = G.currentScopeTermIds_(G.readTerms_());
h.check(scope.indexOf('2026-後期') !== -1 && scope.indexOf('2026-3Q') !== -1
  && scope.indexOf('2026-4Q') !== -1,
  '★後期の最中は 後期＋3Q＋4Q（終了済みでも半期内のクォーターは残す・D16）');
h.check(scope.indexOf('2026-前期') === -1, '前期は入らない');

res = G.getTimetable('');
h.check(ids(res) === 'C1,C2', '前期のコマは「現在」に出ない');

// ── 3) 全部終わったあと ────────────────────────────────────
h.section('3) 年度が終わったあと（すべて過去）');
setupTerms([
  ['2026-前期', 'semester', -300, -200],
  ['2026-後期', 'semester', -190, -30],
  ['2026-3Q', 'quarter', -190, -110],
  ['2026-4Q', 'quarter', -109, -30],
]);
addCourse('C1', '2026-4Q');
addCourse('C2', '2026-3Q');

h.check(G.nearestTermId_(G.readTerms_()) === '2026-後期',
  '★いちばん近いのは直近に終わった後期（同着ならセメスター優先）');
res = G.getTimetable('');
h.check(ids(res) === 'C1,C2', '直近の半期のコマが出る（画面が空にならない）');

// ── 4) 日付が未設定の学期が混ざっても落ちない ──────────────
h.section('4) 日付が未設定の学期');
setupTerms([['2026-後期', 'semester', 4, 150]]);
h.add('terms', { term_id: '2027-前期', system: 'semester', start_date: '', end_date: '' });
addCourse('C1', '2026-後期');
h.check(G.nearestTermId_(G.readTerms_()) === '2026-後期', '日付の無い学期は寄せ先にしない');
h.check(ids(G.getTimetable('')) === 'C1', '表示は壊れない');

// ── 5) 学期マスタが空（移行前）────────────────────────────
h.section('5) 学期マスタが空のまま（従来動作）');
h.reset();
h.add('periods', { period: '1', start_time: '09:15', end_time: '10:45' });
h.add('staffs', { staff_id: 'T1', name: '職員', role: '職員' });
h.add('contacts', { staff_id: 'T1', name: '職員', email: 't@e.jp' });
h.setUser({ staff_id: 'T1', name: '職員', role: '職員', email: 't@e.jp' });
addCourse('C1', '2026-3Q');
addCourse('C2', '2026-4Q');
h.check(G.nearestTermId_(G.readTerms_()) === '', '学期が無ければ空を返す');
h.check(ids(G.getTimetable('')) === 'C2',
  'terms 未整備なら従来どおり courses 由来の辞書順末尾に寄せる');

process.exitCode = h.report();
