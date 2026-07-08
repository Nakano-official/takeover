/**
 * 勤怠整合性チェック（機能B）
 *
 * Googleカレンダーの勤務予定（職員がイレギュラーを反映済み＝信頼できる「予定の正」）と、
 * 大学の労務管理システムから出力した勤怠CSV（学生の登録＝ミス・漏れが多い）を突き合わせ、
 * 差分をハイライトして職員の目視照合の手間を減らす（decisions.md D14）。
 *
 * 突合の2本のキー経路：
 *   予定側： カレンダー説明欄の氏名 → staffs.name → staff_id
 *   実績側： CSVの個人ｺｰﾄﾞ        → staffs.personal_code → staff_id
 *   → (staff_id × 日付) でグループ化し、開始/終了を 15分丸め で比較する。
 *
 * 差分3型：
 *   🔴 登録漏れ   … カレンダーに予定あり・CSVに無し（学生の登録漏れ／欠勤・休講）
 *   🟡 予定外勤務 … CSVあり・カレンダーに予定無し（代行・超過枠など）
 *   🟠 時間不一致 … 両方あり・15分丸めでズレ（超過・早退）
 *
 * 設計上の重要点：
 *  - CSVは画面アップロード（base64）→ サーバーで Shift_JIS 復号 → メモリ内で照合。
 *    **CSV本文・ファイルはシートに保存しない**（他キャンパス等の個人情報を残さない＝D2）。
 *  - 実CSVの「①②③ブロック」の正確なヘッダー文字列は未入手（Git管理外）。
 *    ヘッダー判定は下の HEADER_PATTERNS / ブロック検出に集約し、実ファイル入手時に調整する。
 */

// ─── ヘッダー判定（実CSV入手時はここを調整）──────────────────
// 半角/全角どちらの表記でも拾えるよう候補を並べる。先頭一致ではなく「部分一致」で探す。
const ATTEND_HEADER = {
  code: ['個人ｺｰﾄﾞ', '個人コード'],          // 突合キー（学籍番号系の安定ID）
  name: ['氏名'],
  date: ['処理日', '日付'],                   // yyyy/MM/dd 想定
};
// ①②③ブロックの先頭アンカー。この列を起点に 開始=+1 / 終了=+2 を読む（D2のブロック列順）。
const ATTEND_ALBAITO_ANCHOR = ['ｱﾙﾊﾞｲﾄ先', 'アルバイト先'];
// 「ノートテイク」業務だけ残す（同一学生の別バイトを排除）。半角ｶﾅ表記も拾う。
const ATTEND_NOTETAKE_KEYWORDS = ['ノートテイク', 'ﾉｰﾄﾃｲｸ', 'ノートテイカー'];

// 15分丸めの単位（分）。出勤簿が「予定ベース＋15分丸め」で記録されるため（backlog #8）。
const ATTEND_ROUND_MIN = 15;

// ─── サーバーAPI（check.html から google.script.run で呼ぶ）──

/**
 * 勤怠CSVとカレンダーを照合する（職員限定）。
 * @param {Object} payload {csvBase64:string, dateFrom:'yyyy-MM-dd', dateTo:'yyyy-MM-dd'}
 * @return {Object} 照合結果（差分一覧・要確認・サマリ）。Date は全て文字列化して返す。
 */
function runAttendanceCheck(payload) {
  requireStaff_();
  payload = payload || {};
  const dateFrom = String(payload.dateFrom || '').trim();
  const dateTo = String(payload.dateTo || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
    throw new Error('照合期間を YYYY-MM-DD 形式で指定してください。');
  }
  if (dateFrom > dateTo) throw new Error('開始日が終了日より後になっています。');
  if (!payload.csvBase64) throw new Error('勤怠CSVファイルが選択されていません。');

  // 1) CSVを復号して解析（メモリ内のみ）
  const text = decodeShiftJisBase64_(payload.csvBase64);
  const actualRaw = parseAttendanceCsv_(text); // [{code,name,date,startMin,endMin,block}]

  // 2) staffs から突合マップを作る
  const staffs = readRows(SHEET.STAFFS);
  const idByName = {};        // 正規化氏名 → staff_id（予定側の突合）
  const idByCode = {};        // personal_code → staff_id（実績側の突合）
  const nameById = {};
  const unregistered = [];     // 個人ｺｰﾄﾞ未登録の学生（照合できない＝要確認B）
  staffs.forEach(function (s) {
    const id = String(s.staff_id).trim();
    const nm = String(s.name).trim();
    nameById[id] = nm;
    if (nm) idByName[normName_(nm)] = id;
    const code = String(s.personal_code || '').trim();
    if (code) idByCode[code] = id;
    if (String(s.role).trim() === '学生' && !code) {
      unregistered.push({ staff_id: id, name: nm });
    }
  });

  // 3) 実績側：期間内 × staffs在籍の個人ｺｰﾄﾞ だけ残す（他キャンパス等は破棄＝保存しない）
  const actual = [];
  actualRaw.forEach(function (r) {
    if (r.date < dateFrom || r.date > dateTo) return;
    const id = idByCode[r.code];
    if (!id) return; // staffs に無い個人ｺｰﾄﾞ＝対象外（破棄）
    actual.push({
      staff_id: id, name: nameById[id] || r.name,
      date: r.date, startMin: r.startMin, endMin: r.endMin,
    });
  });

  // 4) 予定側：カレンダーから期間内のイベントを取り出し、説明欄の氏名で staff_id を引く
  const predictedResult = getPredictedShifts_(dateFrom, dateTo, idByName, nameById);
  const predicted = predictedResult.shifts;     // [{staff_id,name,date,startMin,endMin,label}]
  const unknownNames = predictedResult.unknownNames; // 要確認A（氏名がstaffsに無い）

  // 5) (staff_id × 日付) で突合
  const diffs = reconcileShifts_(predicted, actual);

  // サマリ集計
  const summary = { 一致: 0, 登録漏れ: 0, 予定外勤務: 0, 時間不一致: 0 };
  diffs.forEach(function (d) { summary[d.type] = (summary[d.type] || 0) + 1; });

  return {
    range: { from: dateFrom, to: dateTo },
    summary: summary,
    diffs: diffs.filter(function (d) { return d.type !== '一致'; }), // 画面は問題のみ。一致はサマリだけ
    matchedCount: summary['一致'],
    warnings: {
      unknownNames: unknownNames,     // カレンダーに居るが staffs.name に無い氏名
      unregistered: unregistered,     // personal_code 未登録の学生（照合不能）
    },
    counts: {
      calendarEvents: predictedResult.eventCount,
      predictedShifts: predicted.length,
      csvRows: actualRaw.length,
      csvMatched: actual.length,
    },
  };
}

// ─── CSV 復号・解析 ──────────────────────────────────────────

/**
 * base64（data URL 接頭辞は許容）→ Shift_JIS 復号 → 文字列。
 */
function decodeShiftJisBase64_(b64) {
  const comma = String(b64).indexOf(',');
  const pure = comma !== -1 && String(b64).slice(0, comma).indexOf('base64') !== -1
    ? String(b64).slice(comma + 1) : String(b64);
  const bytes = Utilities.base64Decode(pure);
  // 大学システムの出力は Shift_JIS（D2）。NEC/IBM拡張があれば 'MS932' へ要変更。
  return Utilities.newBlob(bytes).getDataAsString('Shift_JIS');
}

/**
 * 勤怠CSVテキストを解析し、ノートテイク勤務行を [{code,name,date,startMin,endMin,block}] で返す。
 * 1行が①②③の最大3バイト枠を持つため、ブロックごとに展開する（D2-追記）。
 * 絞り込み（個人ｺｰﾄﾞ在籍）は呼び出し側（runAttendanceCheck）で行う。
 */
function parseAttendanceCsv_(text) {
  const rows = Utilities.parseCsv(text);
  if (!rows || rows.length < 2) return [];
  const headers = rows[0].map(function (h) { return String(h).trim(); });

  const idxCode = findHeaderIdx_(headers, ATTEND_HEADER.code);
  const idxName = findHeaderIdx_(headers, ATTEND_HEADER.name);
  const idxDate = findHeaderIdx_(headers, ATTEND_HEADER.date);
  if (idxCode === -1 || idxDate === -1) {
    throw new Error('CSVのヘッダーに「個人ｺｰﾄﾞ」「処理日」が見つかりません。出力形式をご確認ください。');
  }
  // ①②③ブロックのアンカー（ｱﾙﾊﾞｲﾄ先）列をすべて拾う
  const anchors = [];
  headers.forEach(function (h, i) {
    if (containsAny_(h, ATTEND_ALBAITO_ANCHOR)) anchors.push(i);
  });
  if (anchors.length === 0) {
    throw new Error('CSVのヘッダーに「ｱﾙﾊﾞｲﾄ先」列が見つかりません。出力形式をご確認ください。');
  }

  const out = [];
  for (var r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || isAllBlank_(row)) continue;
    const code = String(row[idxCode] || '').trim();
    if (!code) continue;
    const name = idxName !== -1 ? String(row[idxName] || '').trim() : '';
    const date = normDate_(String(row[idxDate] || '').trim());
    if (!date) continue;

    anchors.forEach(function (a, bi) {
      const albaito = String(row[a] || '').trim();
      if (!containsAny_(albaito, ATTEND_NOTETAKE_KEYWORDS)) return; // ノートテイク枠のみ
      const startMin = hhmmToMin_(row[a + 1]);
      const endMin = hhmmToMin_(row[a + 2]);
      if (startMin == null || endMin == null) return; // 時刻が無い枠は実労なし扱い
      out.push({
        code: code, name: name, date: date,
        startMin: startMin, endMin: endMin, block: bi + 1,
      });
    });
  }
  return out;
}

// ─── カレンダー：予定の取り出し ──────────────────────────────

/**
 * 期間内のカレンダーイベントを取り出し、説明欄の氏名から予定シフトを組み立てる。
 * Calendar.gs の getCalendar_() / parseEvent_() を再利用する。
 * @return {{shifts:Array, unknownNames:Array, eventCount:number}}
 *   shifts       : [{staff_id,name,date,startMin,endMin,label}]
 *   unknownNames : [{name,date,label}]（氏名が staffs.name に無い＝要確認A）
 */
function getPredictedShifts_(dateFrom, dateTo, idByName, nameById) {
  const cal = getCalendar_();
  const start = dateStrToJst_(dateFrom);
  const end = new Date(dateStrToJst_(dateTo).getTime() + 24 * 60 * 60 * 1000); // 終了日を含む
  const events = cal.getEvents(start, end);

  const shifts = [];
  const unknownSeen = {};
  const unknownNames = [];
  events.forEach(function (ev) {
    const info = parseEvent_(ev); // {className,user,room,staff[]}
    const s = ev.getStartTime();
    const e = ev.getEndTime();
    const date = Utilities.formatDate(s, 'Asia/Tokyo', 'yyyy-MM-dd');
    const startMin = jstMinutes_(s);
    const endMin = jstMinutes_(e);
    const label = info.className + (info.user ? '（' + info.user + '）' : '') + (info.room ? ' ' + info.room : '');
    info.staff.forEach(function (nm) {
      const id = idByName[normName_(nm)];
      if (id) {
        shifts.push({
          staff_id: id, name: nameById[id] || nm,
          date: date, startMin: startMin, endMin: endMin, label: label,
        });
      } else {
        const key = normName_(nm) + '|' + date;
        if (!unknownSeen[key]) {
          unknownSeen[key] = true;
          unknownNames.push({ name: nm, date: date, label: label });
        }
      }
    });
  });
  return { shifts: shifts, unknownNames: unknownNames, eventCount: events.length };
}

// ─── 照合エンジン ────────────────────────────────────────────

/**
 * 予定シフトと実績（CSV）を (staff_id × 日付) で突き合わせ、差分レコードを返す。
 * 同一日に複数枠がある場合は、重なる枠どうしをペアにして比較する。
 * @return {Array} [{type,staff_id,name,date,calendar:{...}|null,csv:{...}|null}]
 */
function reconcileShifts_(predicted, actual) {
  const groups = {}; // key = staff_id|date → {pred:[], act:[]}
  function bucket(key) {
    if (!groups[key]) groups[key] = { pred: [], act: [] };
    return groups[key];
  }
  predicted.forEach(function (p) { bucket(p.staff_id + '|' + p.date).pred.push(p); });
  actual.forEach(function (a) { bucket(a.staff_id + '|' + a.date).act.push(a); });

  const diffs = [];
  Object.keys(groups).forEach(function (key) {
    const g = groups[key];
    const usedAct = {};
    // 予定側を起点に、重なる実績枠を探してペアにする
    g.pred.forEach(function (p) {
      var bestJ = -1, bestOv = 0;
      g.act.forEach(function (a, j) {
        if (usedAct[j]) return;
        const ov = overlapMin_(p.startMin, p.endMin, a.startMin, a.endMin);
        if (ov > bestOv) { bestOv = ov; bestJ = j; }
      });
      if (bestJ === -1) {
        // 予定あり・実績なし → 登録漏れ
        diffs.push(makeDiff_('登録漏れ', p, null));
      } else {
        usedAct[bestJ] = true;
        const a = g.act[bestJ];
        if (sameAfterRound_(p, a)) {
          diffs.push(makeDiff_('一致', p, a));
        } else {
          diffs.push(makeDiff_('時間不一致', p, a));
        }
      }
    });
    // 余った実績 → 予定外勤務
    g.act.forEach(function (a, j) {
      if (!usedAct[j]) diffs.push(makeDiff_('予定外勤務', null, a));
    });
  });

  // 表示順：問題の重い順 → 日付 → 氏名
  const order = { 登録漏れ: 0, 時間不一致: 1, 予定外勤務: 2, 一致: 3 };
  diffs.sort(function (x, y) {
    return (order[x.type] - order[y.type]) ||
           (x.date < y.date ? -1 : x.date > y.date ? 1 : 0) ||
           (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
  });
  return diffs;
}

// 15分丸めで開始・終了が一致するか
function sameAfterRound_(p, a) {
  return round15_(p.startMin) === round15_(a.startMin) &&
         round15_(p.endMin) === round15_(a.endMin);
}

// 差分レコードを組み立てる（Date を含めず分→HH:mm 文字列で返す）
function makeDiff_(type, p, a) {
  const base = p || a;
  return {
    type: type,
    staff_id: base.staff_id,
    name: base.name,
    date: base.date,
    calendar: p ? { start: minToHHmm_(p.startMin), end: minToHHmm_(p.endMin), label: p.label || '' } : null,
    csv: a ? { start: minToHHmm_(a.startMin), end: minToHHmm_(a.endMin) } : null,
  };
}

// ─── 小物ユーティリティ ──────────────────────────────────────

function round15_(min) { return Math.round(min / ATTEND_ROUND_MIN) * ATTEND_ROUND_MIN; }

// [s1,e1) と [s2,e2) の重なり分数（重ならなければ0）
function overlapMin_(s1, e1, s2, e2) {
  return Math.max(0, Math.min(e1, e2) - Math.max(s1, s2));
}

// 氏名の正規化：前後・内部の空白（半角/全角）を除去して突合キーにする（D7の表記ゆれ対策）
function normName_(s) {
  return String(s == null ? '' : s).replace(/[\s　]+/g, '');
}

// ヘッダー配列から、候補語のいずれかを部分一致で含む最初の列indexを返す。無ければ-1。
function findHeaderIdx_(headers, candidates) {
  for (var i = 0; i < headers.length; i++) {
    if (containsAny_(headers[i], candidates)) return i;
  }
  return -1;
}

function containsAny_(str, keywords) {
  const s = String(str == null ? '' : str);
  for (var i = 0; i < keywords.length; i++) {
    if (s.indexOf(keywords[i]) !== -1) return true;
  }
  return false;
}

// 'yyyy/MM/dd' または 'yyyy-MM-dd'（時刻付き可）→ 'yyyy-MM-dd'。解釈不能なら ''。
function normDate_(s) {
  const m = String(s).match(/(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

// 'H:mm' / 'HH:mm'（前後空白可）→ 0時からの分。空・不正なら null。
function hhmmToMin_(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// 分 → 'HH:mm'
function minToHHmm_(min) {
  const h = Math.floor(min / 60), m = min % 60;
  return ('0' + h).slice(-2) + ':' + ('0' + m).slice(-2);
}

// Date を日本時間の「0時からの分」に変換
function jstMinutes_(d) {
  const hm = Utilities.formatDate(d, 'Asia/Tokyo', 'HH:mm');
  return hhmmToMin_(hm);
}

// 'yyyy-MM-dd' → その日 0:00（実行環境TZ基準のDate）。getEvents範囲指定に使う。
function dateStrToJst_(dateStr) {
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
}

function isAllBlank_(row) {
  for (var i = 0; i < row.length; i++) {
    if (String(row[i]).trim() !== '') return false;
  }
  return true;
}

// ─── テスト（GASエディタから手動実行・実データ不使用）──────

/**
 * 照合エンジン単体テスト。合成データで 登録漏れ／予定外勤務／時間不一致／一致 を検証する。
 */
function testReconcile() {
  const predicted = [
    // 一致（15分丸めで一致：9:15-11:00 vs 9:13-11:02）
    { staff_id: 'S101', name: '佐藤', date: '2026-05-12', startMin: 9 * 60 + 15, endMin: 11 * 60, label: '英語(A)201' },
    // 時間不一致（早終了：予定13:30-15:00、実績13:30-14:30）
    { staff_id: 'S101', name: '佐藤', date: '2026-05-12', startMin: 13 * 60 + 30, endMin: 15 * 60, label: '数学(B)305' },
    // 登録漏れ（予定あり・実績なし）
    { staff_id: 'S102', name: '高橋', date: '2026-05-12', startMin: 15 * 60 + 15, endMin: 16 * 60 + 45, label: '心理(C)101' },
  ];
  const actual = [
    { staff_id: 'S101', name: '佐藤', date: '2026-05-12', startMin: 9 * 60 + 13, endMin: 11 * 60 + 2 },
    { staff_id: 'S101', name: '佐藤', date: '2026-05-12', startMin: 13 * 60 + 30, endMin: 14 * 60 + 30 },
    // 予定外勤務（実績あり・予定なし）
    { staff_id: 'S103', name: '田中', date: '2026-05-12', startMin: 10 * 60, endMin: 12 * 60 },
  ];
  const diffs = reconcileShifts_(predicted, actual);
  Logger.log('===== reconcile テスト =====');
  diffs.forEach(function (d) {
    Logger.log('[' + d.type + '] ' + d.name + ' ' + d.date +
      ' 予定=' + (d.calendar ? d.calendar.start + '-' + d.calendar.end : '―') +
      ' 実績=' + (d.csv ? d.csv.start + '-' + d.csv.end : '―'));
  });
  Logger.log('期待: 一致1 / 時間不一致1 / 登録漏れ1 / 予定外勤務1');
}

/**
 * CSVパーサ単体テスト。D2の構造を模した合成CSV（実データ不使用）で解析・絞り込みを検証する。
 * 実CSV入手時は ATTEND_HEADER / アンカー語を調整して本テストを通すこと。
 */
function testParseAttendanceCsv() {
  const H = ['個人ｺｰﾄﾞ', '氏名', '処理日', '曜日', '勤怠区分', '出勤例外', '退勤例外', 'ﾒﾓ1', 'ｱﾙﾊﾞｲﾄ交通費'];
  const BLOCK = ['承認', 'ｱﾙﾊﾞｲﾄ先', '開始', '終了', '休憩', '時間', '更新者氏名', '更新日', '更新時刻'];
  const headers = H.concat(BLOCK).concat(BLOCK).concat(BLOCK); // ①②③
  function row(code, name, date, blocks) {
    // blocks = [[albaito,start,end], ...] を①②③に展開（埋まらない枠は空）
    var r = [code, name, date, '火', '通常', '', '', '', '500'];
    for (var i = 0; i < 3; i++) {
      const b = blocks[i] || ['', '', ''];
      r = r.concat([b[0] ? '済' : '', b[0], b[1], b[2], '0:00', '', '職員', date, '12:00']);
    }
    return r;
  }
  const rows = [
    headers,
    // ノートテイク2枠＋別バイト1枠を持つ学生 → ノートテイク2件だけ抽出されるはず
    row('Y200001', '佐藤 美咲', '2026/05/12', [['ノートテイク', '9:15', '11:00'], ['図書館', '12:00', '13:00'], ['ノートテイク', '13:30', '14:30']]),
    // ノートテイクなし → 0件
    row('Y200099', '他バイト 太郎', '2026/05/12', [['学食', '11:00', '14:00']]),
  ];
  const csv = rows.map(function (r) {
    return r.map(function (c) { return '"' + String(c).replace(/"/g, '""') + '"'; }).join(',');
  }).join('\r\n');

  const parsed = parseAttendanceCsv_(csv);
  Logger.log('===== parseAttendanceCsv テスト =====');
  Logger.log('抽出件数: ' + parsed.length + '（期待: 2）');
  parsed.forEach(function (p) {
    Logger.log('  ' + p.code + ' ' + p.name + ' ' + p.date + ' ' +
      minToHHmm_(p.startMin) + '-' + minToHHmm_(p.endMin) + ' (block' + p.block + ')');
  });
}
