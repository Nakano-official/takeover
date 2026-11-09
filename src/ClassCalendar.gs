/**
 * 授業の無い日と、曜日ごとのクォーターの境目（D53）
 *
 * ■ 授業の無い日（no_class_days シート）
 *   祝日（授業実施日を除く）・全学終日休講・「5講時以降休講」・休業期間を持つ。
 *   from_period が空なら終日、数字ならその講時以降が休み（移動介助の枠は、枠の名前の数字で判定する：
 *   「移動前5」は5講時の前の移動なので、5講時以降が休みなら休み）。
 *
 * ■ クォーターの境目は計算する
 *   クォーターは全8回。祝日や休講の入り方が曜日ごとに違うので、境目も曜日ごとに違う
 *   （2026年度の第4クォーター開始：月11/16・木11/19・金11/20・火11/24・水11/25・土11/28）。
 *   セメスターの授業開始日から、曜日ごとに授業の無い日（終日）を飛ばして8回数え、9回目から次のクォーター。
 *   2025・2026年度の瀬田の学年暦で、全曜日が学年暦の記載と一致することを確かめてある。
 *   「5講時以降休講」の日は4講時までは授業があるので1回と数える（学年暦の記載とも一致する）。
 *
 * ■ どこで使うか
 *   「このコマがこの日にあるか」は isCourseHeldOn_ に集める。時間割（getTimetable）・欠勤連絡
 *   （getMyCourses / submitAbsence）はこれを使う。
 *
 * ■ 速さ
 *   計算結果はスクリプトキャッシュに持つ（シートを毎回読むと1回 200〜400ms 増える・D48）。
 *   学期設定から学期や授業の無い日を直したとき、シートが手で直されたとき（変更トリガー）に捨てる。
 */

const CLASS_CAL_CACHE_KEY = 'classcal:v1';
const CLASS_CAL_TTL_SEC = 21600;   // 6時間（キャッシュの上限）
const NO_CLASS_MAX_DAYS = 120;     // 1行で持てる期間の上限（冬期休業などを1行で書ける長さ）

// ─── 読み込み ────────────────────────────────────────────

/** no_class_days シートがあるか（無い旧DBでは migrateAddNoClassDaysSheet を案内する） */
function hasNoClassSheet_() {
  try { readRows_(SHEET.NO_CLASS_DAYS); return true; } catch (e) { return false; }
}

/** no_class_days の行（シートが無い旧DBでは空） */
function readNoClassDays_() {
  var rows;
  try {
    rows = readRows_(SHEET.NO_CLASS_DAYS);
  } catch (e) {
    return [];
  }
  return rows.map(function (r) {
    const start = dateToStr_(r.start_date);
    return {
      no_class_id: String(r.no_class_id || '').trim(),
      start_date: start,
      end_date: dateToStr_(r.end_date) || start,
      from_period: Number(String(r.from_period || '').trim()) || 0,
      reason: String(r.reason || '').trim(),
    };
  }).filter(function (r) { return /^\d{4}-\d{2}-\d{2}$/.test(r.start_date); });
}

/**
 * 日付 → { from, reason }。from=0 は終日。同じ日に複数あれば、休みの広いほう（from の小さいほう）を採る。
 */
function noClassIndex_(rows) {
  const index = {};
  (rows || []).forEach(function (r) {
    var d = r.start_date;
    const end = r.end_date && r.end_date >= r.start_date ? r.end_date : r.start_date;
    for (var guard = 0; d <= end && guard <= NO_CLASS_MAX_DAYS; guard++) {
      const cur = index[d];
      if (!cur || (cur.from && (!r.from_period || r.from_period < cur.from))) {
        index[d] = { from: r.from_period || 0, reason: r.reason };
      }
      d = shiftDateStr_(d, 1);
    }
  });
  return index;
}

/** 時限のキーから講時の番号（'3' → 3、'移動前5' → 5）。数字が無ければ 0 */
function periodNumberOf_(periodKey) {
  const m = /(\d+)/.exec(String(periodKey == null ? '' : periodKey));
  return m ? Number(m[1]) : 0;
}

/** その日のその時限が、授業の無い日に当たるか */
function isNoClassAt_(index, dateStr, periodKey) {
  const e = index && index[dateStr];
  if (!e) return false;
  if (!e.from) return true;
  return periodNumberOf_(periodKey) >= e.from;
}

// ─── クォーターの境目 ─────────────────────────────────────

/** '2026-3Q' → { parent: '2026-後期', half: 1 }（クォーターでなければ null） */
function quarterParentOf_(termId) {
  const m = /^(\d{4})-([1-4])Q$/.exec(String(termId || '').trim());
  if (!m) return null;
  const q = Number(m[2]);
  return { parent: m[1] + '-' + (q <= 2 ? '前期' : '後期'), half: (q % 2) === 1 ? 1 : 2 };
}

/**
 * 曜日ごとに、前半（1回目〜8回目）と後半（9回目〜終わり）の範囲を出す。
 * 数えるのはセメスターの授業開始日〜終了日のうち、授業の無い日（終日）以外。
 * @return {Object<string, {first:{start,end}, second:{start,end}|null}>} 曜日 → 範囲
 */
function weekdayHalves_(semStart, semEnd, index) {
  const out = {};
  for (var k = 0; k < 7; k++) {
    var d = shiftDateStr_(semStart, k);
    if (d > semEnd) continue;
    const day = weekdayOf_(d);
    if (WORK_DAYS.indexOf(day) === -1) continue;   // 授業のある曜日だけ（日曜は数えない）
    const dates = [];
    for (; d <= semEnd; d = shiftDateStr_(d, 7)) {
      const e = index[d];
      if (e && !e.from) continue;           // 終日休みは数えない
      dates.push(d);
    }
    if (!dates.length) continue;
    const n = QUARTER_SESSIONS;
    out[day] = {
      first: { start: dates[0], end: dates[Math.min(n, dates.length) - 1] },
      second: dates.length > n ? { start: dates[n], end: dates[dates.length - 1] } : null,
    };
  }
  return out;
}

/**
 * 学期ごとの範囲。セメスターは学期の開始日〜終了日。
 * クォーターは、親のセメスターに日付があれば曜日ごとに計算する（byDay）。無ければ自分の日付のまま。
 * @return {Object<string, {start, end, byDay:Object|null, computed:boolean}>}
 */
function computeTermRanges_(terms, index) {
  const byId = {};
  (terms || []).forEach(function (t) { byId[t.term_id] = t; });
  const halvesCache = {};
  const out = {};
  (terms || []).forEach(function (t) {
    const q = quarterParentOf_(t.term_id);
    const parent = q ? byId[q.parent] : null;
    if (!q || !parent || !parent.start_date || !parent.end_date) {
      if (t.start_date && t.end_date) out[t.term_id] = { start: t.start_date, end: t.end_date, byDay: null, computed: false };
      return;
    }
    if (!halvesCache[q.parent]) halvesCache[q.parent] = weekdayHalves_(parent.start_date, parent.end_date, index);
    const halves = halvesCache[q.parent];
    const byDay = {};
    var start = '', end = '';
    Object.keys(halves).forEach(function (day) {
      const r = q.half === 1 ? halves[day].first : halves[day].second;
      if (!r) return;
      byDay[day] = r;
      if (!start || r.start < start) start = r.start;
      if (!end || r.end > end) end = r.end;
    });
    if (start) out[t.term_id] = { start: start, end: end, byDay: byDay, computed: true };
  });
  return out;
}

// ─── まとめて持つ（キャッシュつき）──────────────────────────

/**
 * 授業の無い日と学期の範囲。スクリプトキャッシュに持つ。
 * @return {{noClass:Object<string,{from,reason}>, ranges:Object}}
 */
function classCalendar_() {
  const cache = CacheService.getScriptCache();
  const hit = cache.get(CLASS_CAL_CACHE_KEY);
  if (hit) {
    try { return JSON.parse(hit); } catch (e) { /* 壊れていたら作り直す */ }
  }
  const index = noClassIndex_(readNoClassDays_());
  const cal = { noClass: index, ranges: computeTermRanges_(readTerms_(), index) };
  try { cache.put(CLASS_CAL_CACHE_KEY, JSON.stringify(cal), CLASS_CAL_TTL_SEC); } catch (e) { /* 持たないだけ */ }
  return cal;
}

/** 学期や授業の無い日が変わったら呼ぶ */
function clearClassCalendarCache_() {
  try { CacheService.getScriptCache().remove(CLASS_CAL_CACHE_KEY); } catch (e) { /* 次の期限切れで消える */ }
}

/** その学期の、その曜日の範囲（曜日ごとの計算が無ければ学期全体） */
function termRangeOn_(cal, termId, day) {
  const r = cal && cal.ranges && cal.ranges[String(termId || '').trim()];
  if (!r) return null;
  if (r.byDay) return r.byDay[day] || null;
  return { start: r.start, end: r.end };
}

/**
 * そのコマがその日に実際にあるか。
 * @return {{held:boolean, reason:string}} reason は無いときの理由（画面に出す）
 */
function courseHeldOn_(course, dateStr, cal) {
  const oneOff = courseDate_(course);
  if (oneOff) return { held: dateStr === oneOff, reason: dateStr === oneOff ? '' : 'この日の予定ではありません' };
  const day = String(course.day || '').trim();
  if (weekdayOf_(dateStr) !== day) return { held: false, reason: '曜日が違います' };
  const termId = String(course.quarter || '').trim();
  const hasRange = cal && cal.ranges && cal.ranges[termId];
  const r = termRangeOn_(cal, termId, day);
  if (hasRange && (!r || dateStr < r.start || dateStr > r.end)) {
    return { held: false, reason: termId + ' の' + day + '曜の授業期間外です' + (r ? '（' + r.start + '〜' + r.end + '）' : '') };
  }
  if (isNoClassAt_(cal && cal.noClass, dateStr, course.period)) {
    const e = cal.noClass[dateStr];
    return { held: false, reason: '授業がありません（' + (e.reason || '授業なし') + (e.from ? '・' + e.from + '講時以降' : '') + '）' };
  }
  return { held: true, reason: '' };
}

/**
 * クォーターの行の開始日・終了日を、計算した範囲（一番早い曜日〜一番遅い曜日）に書き換える。
 * 学期の選択肢や「今どの学期か」の判断は、この大まかな期間で今までどおり動く。
 */
function syncQuarterDates_() {
  clearClassCalendarCache_();
  const terms = readTerms_();
  const ranges = computeTermRanges_(terms, noClassIndex_(readNoClassDays_()));
  terms.forEach(function (t) {
    const r = ranges[t.term_id];
    if (!r || !r.computed) return;
    if (r.start !== t.start_date || r.end !== t.end_date) {
      updateRow_(SHEET.TERMS, 'term_id', t.term_id, { start_date: r.start, end_date: r.end });
    }
  });
  clearClassCalendarCache_();
}

// ─── 学期設定の画面から（職員限定）────────────────────────────

/**
 * 授業の無い日を足す。
 * @param {{start_date, end_date, from_period, reason}} p
 */
function addNoClassDay(p) {
  requireStaff_();
  const q = p || {};
  const start = String(q.start_date || '').trim();
  const end = String(q.end_date || '').trim() || start;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    throw new Error('日付は YYYY-MM-DD 形式で入力してください。');
  }
  if (end < start) throw new Error('終わりの日が始まりの日より前になっています。');
  if (dayGap_(end, start) > NO_CLASS_MAX_DAYS) throw new Error('1件で登録できる期間は ' + NO_CLASS_MAX_DAYS + ' 日までです。');
  const from = String(q.from_period == null ? '' : q.from_period).trim();
  if (from && !/^[1-9]$/.test(from)) throw new Error('「何講時以降」は 1〜9 の数字か、空（終日）で指定してください。');
  const reason = String(q.reason || '').trim();
  if (!reason) throw new Error('理由を入力してください（例：勤労感謝の日）。');
  if (reason.length > 40) throw new Error('理由は40文字以内で入力してください。');
  assertNotFormula_('理由', reason);

  if (!hasNoClassSheet_()) throw new Error('授業の無い日のシートがありません。GASエディタで migrateAddNoClassDaysSheet を実行してください。');

  const id = appendRowWithId_(SHEET.NO_CLASS_DAYS, 'no_class_id', 'N', {
    start_date: start, end_date: end === start ? '' : end, from_period: from, reason: reason,
  });
  syncQuarterDates_();
  return { ok: true, no_class_id: id };
}

/** 授業の無い日を消す */
function deleteNoClassDay(noClassId) {
  requireStaff_();
  const id = String(noClassId == null ? '' : noClassId).trim();
  if (!id) throw new Error('対象が指定されていません。');
  const n = deleteRowByKey_(SHEET.NO_CLASS_DAYS, 'no_class_id', id);
  if (!n) throw new Error('対象が見つかりません（' + id + '）。画面を更新してください。');
  syncQuarterDates_();
  return { ok: true };
}
