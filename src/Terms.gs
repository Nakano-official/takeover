/**
 * 学期マスタ（terms）ヘルパー — backlog 11-3 / decisions.md D16
 *
 * 龍谷大では学期体系が1つではない：
 *   - 先端理工学部（学籍番号 Y 始まり）… クォーター制（1Q〜4Q）
 *   - それ以外の学部              … セメスター制（前期／後期）
 * この2体系は同じ暦の上で同時に走る（例：7月は「前期」と「2Q」が両方"現在"）。
 * そのため「quarters.sort() の末尾＝現在」という単一学期前提は成り立たない。
 *
 * `terms` シート（term_id・system・start_date・end_date）を真実の源とし、
 * 「今日を含む学期の集合」を日付で解決する。courses.quarter 列には term_id を入れる
 * （列名は互換のため据え置き。値が '3Q' か '後期' かで体系が決まるので、
 *  courses 側に学部情報を持たなくても成立する）。decisions.md D16。
 *
 * ※ terms シートが未整備（旧DB）でも壊れないよう、その場合は courses 由来の
 *   辞書順末尾を「現在」とみなす従来動作にフォールバックする。
 */

// terms シートを読む（無ければ空配列）。日付は 'yyyy-MM-dd' 文字列に揃える。
function readTerms_() {
  var rows;
  try {
    rows = readRows(SHEET.TERMS);
  } catch (e) {
    return []; // シート未作成の旧DB
  }
  return rows.map(function (r) {
    return {
      term_id: String(r.term_id || '').trim(),
      system: String(r.system || '').trim(),
      start_date: dateToStr_(r.start_date),
      end_date: dateToStr_(r.end_date),
    };
  }).filter(function (t) { return t.term_id; });
}

// 今日（JST）の 'yyyy-MM-dd'
function todayJst_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
}

// term_id → system（'quarter'/'semester'）のマップ
function termSystemMap_(terms) {
  terms = terms || readTerms_();
  const m = {};
  terms.forEach(function (t) { m[t.term_id] = t.system; });
  return m;
}

// system コードの日本語ラベル（画面表示用）。未知は空文字。
function systemLabel_(system) {
  return system === 'quarter' ? 'クォーター'
    : system === 'semester' ? 'セメスター' : '';
}

// 今日を含む学期の term_id 配列（通常はセメスター1つ＋クォーター1つの集合）。
function currentTermIds_(terms) {
  terms = terms || readTerms_();
  const today = todayJst_();
  return terms
    .filter(function (t) {
      return t.start_date && t.end_date && t.start_date <= today && today <= t.end_date;
    })
    .map(function (t) { return t.term_id; });
}

/**
 * home 閲覧の既定「現在」表示範囲。今日を含む学期を起点に、
 * **今日を含むセメスター（前期/後期）は、それが暦で内包するクォーターまで含めて**返す。
 * → 前期の最中は、日付上すでに終了した 1Q も「前期全体＋1Q＋2Q」として表示し続ける（ユーザー要望）。
 *   後期なら「後期＋3Q＋4Q」。今日がどのクォーターにも入らない端境（例：2Q終了〜前期末）でも、
 *   現在の半期をまとめて出せる。欠勤対象の選択（activeTermIds_）は開講中のみに絞るため別関数のまま。
 */
function currentScopeTermIds_(terms) {
  terms = terms || readTerms_();
  const cur = currentTermIds_(terms);   // 今日を含む学期（例：前期・2Q）
  const set = {};
  cur.forEach(function (id) { set[id] = true; });
  // 今日を含む「セメスター」を、内包するクォーター（1Q/2Q 等）まで広げる。
  terms.forEach(function (t) {
    if (t.system === 'semester' && cur.indexOf(t.term_id) !== -1) {
      overlappingTermIds_(t.term_id, terms).forEach(function (id) { set[id] = true; });
    }
  });
  return Object.keys(set);
}

// 開始日の新しい順に並べた term_id（ドロップダウン表示用）。
function termIdsByRecency_(terms) {
  terms = terms || readTerms_();
  return terms.slice()
    .sort(function (a, b) { return String(a.start_date).localeCompare(String(b.start_date)); })
    .map(function (t) { return t.term_id; })
    .reverse();
}

/**
 * フィルタに使う「現在の学期集合」。
 * terms 未整備なら courseTermIds の辞書順末尾1つ（従来動作）。
 * terms があり現在該当が無ければ、最新開始の学期1つにフォールバック（画面が空にならないように）。
 */
function activeTermIds_(courseTermIds) {
  const terms = readTerms_();
  if (terms.length === 0) {
    const ids = (courseTermIds || []).slice().sort();
    return ids.length ? [ids[ids.length - 1]] : [];
  }
  const cur = currentTermIds_(terms);
  if (cur.length) return cur;
  const recent = termIdsByRecency_(terms);
  return recent.length ? [recent[0]] : [];
}

/**
 * 指定 term と期間が重なる term_id をすべて返す（D16）。
 * 例：2Q を渡すと、2Q を暦で内包する「前期」も返る（＝前期のセメスター科目が消えない）。
 * 前期 を渡すと、内包する 1Q・2Q も返る（春の全体）。日付が欠けている term は自分のみ。
 */
function overlappingTermIds_(termId, terms) {
  terms = terms || readTerms_();
  var target = null;
  for (var i = 0; i < terms.length; i++) {
    if (terms[i].term_id === termId) { target = terms[i]; break; }
  }
  if (!target || !target.start_date || !target.end_date) return [termId];
  return terms
    .filter(function (t) {
      if (!t.start_date || !t.end_date) return t.term_id === termId;
      // 期間が重なる： t.start <= target.end && target.start <= t.end
      return t.start_date <= target.end_date && target.start_date <= t.end_date;
    })
    .map(function (t) { return t.term_id; });
}

/**
 * 画面の学期セレクタを解決する。
 * @param {string} requested      選択された term_id（falsy=既定）
 * @param {Array}  courseTermIds  courses に実在する term の配列（terms 未整備時の fallback 用）
 * @param {string} mode           'view'（home 閲覧）／'edit'（input 編集）
 *   - view : 既定＝「現在（開講中）」＝今日を含むセメスター＋その内包クォーター全体
 *            （前期の間は 前期＋1Q＋2Q、後期の間は 後期＋3Q＋4Q。終了済みクォーターも半期内は残す）。
 *            特定学期を選ぶと**期間が重なる学期も含める**
 *            （2Q を選んでも並行する前期のセメスター科目が残る・ユーザー要望）。先頭に番兵 '' を置く。
 *   - edit : 単一学期・完全一致（新規コマの割り当て先／編集対象を混ぜないため）。
 * @return {{options:Array<{value,label}>, selected:string, filterIds:Array<string>}}
 */
function resolveTermSelection_(requested, courseTermIds, mode) {
  const view = (mode === 'view');
  const terms = readTerms_();
  requested = String(requested || '').trim();

  // 後方互換：terms 未整備なら courses 由来・辞書順末尾を現在とみなす（従来動作・完全一致）。
  if (terms.length === 0) {
    const ids = (courseTermIds || []).slice().sort();
    const latest = ids.length ? ids[ids.length - 1] : '';
    const selected = (requested && ids.indexOf(requested) !== -1) ? requested : latest;
    return {
      options: ids.slice().reverse().map(function (id) { return { value: id, label: id }; }),
      selected: selected,
      filterIds: selected ? [selected] : [],
    };
  }

  const allIdsDesc = termIdsByRecency_(terms);
  const valid = {};
  allIdsDesc.forEach(function (id) { valid[id] = true; });
  var selected, filterIds;

  if (requested && valid[requested]) {
    selected = requested;
    // view：選んだ学期と期間が重なる学期も含める（セメスター科目を残す）。edit：その学期のみ。
    filterIds = view ? overlappingTermIds_(requested, terms) : [requested];
  } else if (view) {
    // 既定＝「現在（開講中）」＝今日を含むセメスター＋その内包クォーター全体
    // （前期の間は 前期＋1Q＋2Q、後期の間は 後期＋3Q＋4Q。終了済みクォーターも半期内は残す）。
    // 無ければ最新1つ＋その重なり（空表示回避＆セメスター保持）。
    const cur = currentScopeTermIds_(terms);
    selected = '';
    filterIds = cur.length
      ? cur
      : (allIdsDesc.length ? overlappingTermIds_(allIdsDesc[0], terms) : []);
  } else {
    // edit 既定：現在のうち最も新しく始まったもの、無ければ最新（完全一致）。
    const cur = currentTermIds_(terms);
    if (cur.length) {
      selected = allIdsDesc.filter(function (id) { return cur.indexOf(id) !== -1; })[0] || cur[0];
    } else {
      selected = allIdsDesc.length ? allIdsDesc[0] : '';
    }
    filterIds = selected ? [selected] : [];
  }

  var options = allIdsDesc.map(function (id) { return { value: id, label: id }; });
  if (view) options = [{ value: '', label: '現在（開講中）' }].concat(options);
  return { options: options, selected: selected, filterIds: filterIds };
}

// ─── 学期マスタ管理画面（terms.html）用API・職員限定（D19）──────
// 「毎年の学期日付は職員がHTMLから入力する（スプレッドシートを直接触らせない）」方針の受け口。
// 年度の追加（雛形6行）と、各学期の開始/終了日の編集を画面から行う。

/**
 * 学期マスタ管理画面のデータを返す（職員限定）。
 * 既存の全 term を開始日の新しい順で、今日を含む学期（＝現在）に印を付けて返す。
 * @return {{today, terms:Array, hasCurrent:boolean, existingYears:Array, suggestYear:string}}
 */
function getTermsAdmin() {
  requireStaff_();
  const terms = readTerms_();
  const today = todayJst_();
  const curSet = {};
  currentTermIds_(terms).forEach(function (id) { curSet[id] = true; });

  const rows = terms.slice()
    .sort(function (a, b) { return String(b.start_date).localeCompare(String(a.start_date)); })
    .map(function (t) {
      return {
        term_id: t.term_id,
        system: t.system,
        systemLabel: systemLabel_(t.system),
        start_date: t.start_date,
        end_date: t.end_date,
        isCurrent: !!curSet[t.term_id],
      };
    });

  // 既存年度（term_id の年プレフィックス）と、次に追加を促す年度（最大年+1、無ければ今年）。
  const years = {};
  terms.forEach(function (t) {
    const m = String(t.term_id).match(/^(\d{4})/);
    if (m) years[m[1]] = true;
  });
  const existingYears = Object.keys(years).sort();
  const thisYear = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy');
  const suggestYear = existingYears.length
    ? String(Number(existingYears[existingYears.length - 1]) + 1)
    : thisYear;

  return {
    today: today,
    terms: rows,
    hasCurrent: Object.keys(curSet).length > 0,
    existingYears: existingYears,
    suggestYear: suggestYear,
  };
}

/**
 * 指定年度の学期6行（前期/後期＋1Q〜4Q）を terms に追加する（職員限定・冪等）。
 * 既に存在する term_id はスキップする。日付は雛形（職員が後から各行を実暦に調整）。
 * 日付列はテキスト固定にして数値/日付化を防ぐ（先頭ゼロ・型ゆれ対策・10-6 と同方針）。
 * @param {(string|number)} year 西暦4桁
 * @return {{added:number, skipped:number, year:string}}
 */
function addTermsYear(year) {
  requireStaff_();
  const y = String(year == null ? '' : year).trim();
  if (!/^\d{4}$/.test(y)) throw new Error('年度は西暦4桁で指定してください（例：2027）。');

  const template = yearTermsTemplate_(y); // Setup.js（関数内参照＝連結順に非依存）

  return withLock_(function () {
    var sheet;
    try {
      sheet = getSheet_(SHEET.TERMS);
    } catch (e) {
      throw new Error('terms（学期マスタ）シートがありません。先に migrateAddTermsSheet を実行してください。');
    }
    const values = sheet.getDataRange().getValues();
    const headers = values[0].map(function (h) { return String(h).trim(); });
    const idxId = headers.indexOf('term_id');
    const idxStart = headers.indexOf('start_date');
    const idxEnd = headers.indexOf('end_date');
    if (idxId === -1 || idxStart === -1 || idxEnd === -1) {
      throw new Error('terms シートのヘッダー（term_id/start_date/end_date）が不正です。');
    }

    // 日付列を列全体テキスト固定（追記行も日付化させない）
    const maxDataRows = Math.max(sheet.getMaxRows() - 1, 1);
    sheet.getRange(2, idxStart + 1, maxDataRows, 1).setNumberFormat('@');
    sheet.getRange(2, idxEnd + 1, maxDataRows, 1).setNumberFormat('@');

    const existing = {};
    for (var r = 1; r < values.length; r++) {
      const id = String(values[r][idxId]).trim();
      if (id) existing[id] = true;
    }

    var added = 0, skipped = 0;
    template.forEach(function (t) {
      if (existing[t.term_id]) { skipped++; return; }
      const rowArr = headers.map(function (h) { return t[h] !== undefined ? t[h] : ''; });
      sheet.appendRow(rowArr);
      added++;
    });
    return { added: added, skipped: skipped, year: y };
  });
}

/**
 * 1学期の開始/終了日を更新する（職員限定）。学事暦に合わせた毎年の日付調整に使う。
 * term_id・system は構造上の識別子なので変更しない（日付のみ編集）。
 * @return {{term_id, start_date, end_date}}
 */
function updateTermDates(termId, startDate, endDate) {
  requireStaff_();
  const id = String(termId == null ? '' : termId).trim();
  const s = String(startDate == null ? '' : startDate).trim();
  const e = String(endDate == null ? '' : endDate).trim();
  if (!id) throw new Error('学期が指定されていません。');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || !/^\d{4}-\d{2}-\d{2}$/.test(e)) {
    throw new Error('日付は YYYY-MM-DD 形式で入力してください。');
  }
  if (s > e) throw new Error('開始日が終了日より後になっています。');

  const ok = updateRow(SHEET.TERMS, 'term_id', id, { start_date: s, end_date: e });
  if (!ok) throw new Error('対象の学期が見つかりません（' + id + '）。画面を更新してください。');
  return { term_id: id, start_date: s, end_date: e };
}
