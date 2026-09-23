/**
 * 勤怠整合性チェック（機能B）のロジック検証 — Node 上で実行する
 *
 *     node tools/sim-attendance.js
 *
 * `src/Attendance.gs` を**そのまま**読み込み、`Utilities.parseCsv` だけ差し替えて動かす。
 * 対象は CSV パーサ（`parseAttendanceCsv_`）と 15分丸め突合（`reconcileShifts_`）＝
 * どちらも純粋関数なので、実スプレッドシートも実カレンダーも要らない。
 *
 * ■ 元は GAS の testParseAttendanceCsv / testReconcile（Attendance.gs 内）だった。
 *   あちらは結果を Logger に出して「期待: 2件」と**人がログを読み比べる**形で、
 *   ズレても赤くならなかった。ここでは期待値を assert にしてある。
 *
 * ■ ここで確かめられないこと
 *   実CSVの文字コード（Shift_JIS/MS932）と実ヘッダー文字列（backlog 9-6）、
 *   実カレンダーからの予定抽出（D7③）。合成データで**構造**だけを見ている。
 *   実データが入ったら ATTEND_HEADER / アンカー語を調整して、ここを通してから使う。
 */
const { Harness } = require('./gas-harness');

const h = new Harness();
h.load(['Attendance.gs']);
const G = h.G;

console.log('===== 勤怠整合性チェック（機能B）ロジック検証 =====');

// ── CSV パーサ ──────────────────────────────────────────────
// D2 の構造（1行＝1日、①②③の勤務枠ブロックが横に並ぶ）を模した合成CSV。実データは使わない。
h.section('1) parseAttendanceCsv_：ノートテイク枠だけを抜き出す');

const BASE = ['個人ｺｰﾄﾞ', '氏名', '処理日', '曜日', '勤怠区分', '出勤例外', '退勤例外', 'ﾒﾓ1', 'ｱﾙﾊﾞｲﾄ交通費'];
const BLOCK = ['承認', 'ｱﾙﾊﾞｲﾄ先', '開始', '終了', '休憩', '時間', '更新者氏名', '更新日', '更新時刻'];

/** blocks = [[ｱﾙﾊﾞｲﾄ先, 開始, 終了], ...] を①②③に展開する（埋まらない枠は空） */
function csvRow(code, name, date, blocks) {
  var r = [code, name, date, '火', '通常', '', '', '', '500'];
  for (var i = 0; i < 3; i++) {
    const b = blocks[i] || ['', '', ''];
    r = r.concat([b[0] ? '済' : '', b[0], b[1], b[2], '0:00', '', '職員', date, '12:00']);
  }
  return r;
}
function toCsv(rows) {
  return rows.map((r) => r.map((c) => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\r\n');
}

const headers = BASE.concat(BLOCK).concat(BLOCK).concat(BLOCK);
const parsed = G.parseAttendanceCsv_(toCsv([
  headers,
  // ノートテイク2枠＋別バイト1枠 → ノートテイクの2件だけ拾う
  csvRow('Y200001', '佐藤 美咲', '2026/05/12',
    [['ノートテイク', '9:15', '11:00'], ['図書館', '12:00', '13:00'], ['ノートテイク', '13:30', '14:30']]),
  // ノートテイクなし → 0件
  csvRow('Y200099', '他バイト 太郎', '2026/05/12', [['学食', '11:00', '14:00']]),
  // 半角カナ表記のゆれも拾う（ATTEND_NOTETAKE_KEYWORDS）
  csvRow('Y200002', '高橋 健', '2026/05/12', [['ﾉｰﾄﾃｲｸ', '10:00', '11:30']]),
  // ノートテイク枠だが時刻が無い（実労なし）→ 拾わない
  csvRow('Y200003', '田中 花', '2026/05/12', [['ノートテイク', '', '']]),
]));

h.check(parsed.length === 3, '抽出は3件（佐藤2枠＋高橋1枠。別バイトと時刻なしは除外）');
const sato = parsed.filter((p) => p.code === 'Y200001');
h.check(sato.length === 2, '佐藤は2枠');
h.check(sato[0].startMin === 9 * 60 + 15 && sato[0].endMin === 11 * 60, '1枠目は 9:15-11:00');
h.check(sato[0].block === 1, '1枠目はブロック①');
h.check(sato[1].startMin === 13 * 60 + 30 && sato[1].endMin === 14 * 60 + 30, '2枠目は 13:30-14:30');
h.check(sato[1].block === 3, '2枠目はブロック③（②の別バイトを飛ばす）');
h.check(sato[0].date === '2026-05-12', '処理日を yyyy-MM-dd に正規化する');
h.check(parsed.filter((p) => p.code === 'Y200099').length === 0, '別バイトだけの学生は0件');
h.check(parsed.filter((p) => p.code === 'Y200002').length === 1, '半角カナ「ﾉｰﾄﾃｲｸ」も拾う');
h.check(parsed.filter((p) => p.code === 'Y200003').length === 0, '時刻が無い枠は拾わない');

h.section('2) parseAttendanceCsv_：ヘッダーが違えば理由を出して失敗する');
var threw = '';
try {
  G.parseAttendanceCsv_(toCsv([['氏名', '日付'], ['佐藤', '2026/05/12']]));
} catch (e) { threw = e.message; }
h.check(/個人ｺｰﾄﾞ/.test(threw), '必須ヘッダーが無ければ、何が無いかを言って例外にする');

// ── 15分丸め突合 ────────────────────────────────────────────
// 出勤簿は「予定ベース＋15分丸め」で書かれる（CLAUDE.md）ので、分一致では比較しない。
h.section('3) reconcileShifts_：予定（カレンダー）と実績（CSV）を突き合わせる');

const predicted = [
  // 一致：15分丸めで同じ（9:15-11:00 と 9:13-11:02）
  { staff_id: 'S101', name: '佐藤', date: '2026-05-12', startMin: 9 * 60 + 15, endMin: 11 * 60, label: '英語(A)201' },
  // 時間不一致：早終了（予定 13:30-15:00 / 実績 13:30-14:30）
  { staff_id: 'S101', name: '佐藤', date: '2026-05-12', startMin: 13 * 60 + 30, endMin: 15 * 60, label: '数学(B)305' },
  // 登録漏れ：予定あり・実績なし
  { staff_id: 'S102', name: '高橋', date: '2026-05-12', startMin: 15 * 60 + 15, endMin: 16 * 60 + 45, label: '心理(C)101' },
];
const actual = [
  { staff_id: 'S101', name: '佐藤', date: '2026-05-12', startMin: 9 * 60 + 13, endMin: 11 * 60 + 2 },
  { staff_id: 'S101', name: '佐藤', date: '2026-05-12', startMin: 13 * 60 + 30, endMin: 14 * 60 + 30 },
  // 予定外勤務：実績あり・予定なし
  { staff_id: 'S103', name: '田中', date: '2026-05-12', startMin: 10 * 60, endMin: 12 * 60 },
];
const diffs = G.reconcileShifts_(predicted, actual);
const count = (t) => diffs.filter((d) => d.type === t).length;

h.check(diffs.length === 4, '差分は4件');
h.check(count('一致') === 1, '一致1件（15分丸めで吸収される数分のズレ）');
h.check(count('時間不一致') === 1, '時間不一致1件（早終了）');
h.check(count('登録漏れ') === 1, '登録漏れ1件（予定あり・実績なし）');
h.check(count('予定外勤務') === 1, '予定外勤務1件（実績あり・予定なし）');

h.check(diffs[0].type === '登録漏れ', '並び順は「問題の重い順」＝登録漏れが先頭');
h.check(diffs[diffs.length - 1].type === '一致', '「一致」は最後に来る');

const mismatch = diffs.filter((d) => d.type === '時間不一致')[0];
h.check(!!mismatch.calendar && !!mismatch.csv, '時間不一致は予定側・実績側の両方を持つ');
const missing = diffs.filter((d) => d.type === '登録漏れ')[0];
h.check(!!missing.calendar && !missing.csv, '登録漏れは予定側だけを持つ');
h.check(missing.name === '高橋', '登録漏れは高橋');
const extra = diffs.filter((d) => d.type === '予定外勤務')[0];
h.check(!extra.calendar && !!extra.csv, '予定外勤務は実績側だけを持つ');
h.check(extra.name === '田中', '予定外勤務は田中');

h.section('4) reconcileShifts_：人と日付をまたいで混ざらない');
const crossed = G.reconcileShifts_(
  [{ staff_id: 'S101', name: '佐藤', date: '2026-05-12', startMin: 600, endMin: 660, label: 'x' }],
  [{ staff_id: 'S101', name: '佐藤', date: '2026-05-13', startMin: 600, endMin: 660 }]
);
h.check(crossed.length === 2, '別の日の実績とはペアにならない（登録漏れ＋予定外勤務の2件）');
h.check(crossed.filter((d) => d.type === '一致').length === 0, '日付が違えば「一致」にはしない');

process.exitCode = h.report();
