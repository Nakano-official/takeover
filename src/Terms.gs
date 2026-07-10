/**
 * 学期マスタ（terms）ヘルパー — backlog 11-3 / decisions.md D16
 *
 * 龍谷大では学期体系が1つではない：
 *   - 先端理工学部（学籍番号 Y 始まり）… クォーター制（Q1〜Q4）
 *   - それ以外の学部              … セメスター制（前期／後期）
 * この2体系は同じ暦の上で同時に走る（例：7月は「前期」と「Q2」が両方"現在"）。
 * そのため「quarters.sort() の末尾＝現在」という単一学期前提は成り立たない。
 *
 * `terms` シート（term_id・system・start_date・end_date）を真実の源とし、
 * 「今日を含む学期の集合」を日付で解決する。courses.quarter 列には term_id を入れる
 * （列名は互換のため据え置き。値が 'Q3' か '後期' かで体系が決まるので、
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
 * 例：Q2 を渡すと、Q2 を暦で内包する「前期」も返る（＝前期のセメスター科目が消えない）。
 * 前期 を渡すと、内包する Q1・Q2 も返る（春の全体）。日付が欠けている term は自分のみ。
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
 *   - view : 既定＝「現在（開講中）」。特定学期を選ぶと**期間が重なる学期も含める**
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
    // 既定＝「現在（開講中）」＝今日を含む学期すべて（前期＋現在Qが並ぶ）。
    // 無ければ最新1つ＋その重なり（空表示回避＆セメスター保持）。
    const cur = currentTermIds_(terms);
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
