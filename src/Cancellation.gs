/**
 * 個別の休講（D53 の3回目・D60）
 *
 * 教員の都合や利用学生の欠席で、**ある日のあるコマだけ**授業が無くなることがある。
 * そのコマはシフト確認に出続けるので、担当が知らずに教室へ行ったり、欠勤・代行の募集が動いたりしていた。
 *
 * ■ 休講と削除を取り違えない
 *   - **休講**＝その日だけ。シフト確認でコマを押した詳細から職員が登録する。授業そのもの（courses）は消えない。
 *   - **削除**＝学期のすべての週から消える。シフト入力でだけ行う。
 *   ボタンの言葉と確認の文言でこの違いを毎回示す。
 *
 * ■ 休講にすると
 *   - cancellations シートに1行（コマ・日付・理由・登録した職員・日時）
 *   - 時間割ではその日のそのコマが「休講（理由）」になる。欠勤連絡ではその日を選べない（courseHeldOn_）
 *   - その日のそのコマに決まっていない欠員があれば、結果「休講」で決着させ、代行の候補へ締め切りを知らせる
 *   - 担当（A・B）と、その日の代行に決まっていた人、職員スペースへ Chat で知らせる。利用学生の名前は書かない
 *   - 移動の印（D58）が付いた介助のコマは、移動も一緒に休みになる（同じ1コマなので）
 *   - 「この利用者のこの日のコマを全部」を選ぶと、同じ利用学生のその日のコマをまとめて休講にする
 *
 * 公開関数（google.script.run から呼ぶ・職員だけ）:
 *  - cancelClass({course_id, date, reason, wholeDay})
 *  - uncancelClass({course_id, date, wholeDay})
 */

const CANCEL_REASON_MAX = 60;

/** cancellations の行（シートが無い旧DBでは空） */
function readCancellations_() {
  try {
    return readRows_(SHEET.CANCELLATIONS);
  } catch (e) {
    return [];
  }
}

function hasCancellationSheet_() {
  try { readRows_(SHEET.CANCELLATIONS); return true; } catch (e) { return false; }
}

/** 'course_id|yyyy-MM-dd' → {id, reason} */
function cancellationIndex_(rows) {
  const out = {};
  (rows || []).forEach(function (r) {
    const cid = String(r.course_id || '').trim();
    const d = dateToStr_(r.date);
    if (!cid || !d) return;
    out[cid + '|' + d] = { id: String(r.cancellation_id || '').trim(), reason: String(r.reason || '').trim() };
  });
  return out;
}

/** その日に休講にする（取り消す）コマ。wholeDay なら同じ利用学生のその日のコマを全部 */
function cancellationTargets_(course, dateStr, wholeDay, pick) {
  if (!wholeDay) return [course];
  const key = nameKey_(course.user_student);
  if (!key) return [course];
  const out = readRows_(SHEET.COURSES).filter(function (c) {
    return nameKey_(c.user_student) === key && pick(c);
  });
  if (!out.some(function (c) { return String(c.course_id).trim() === String(course.course_id).trim(); })) out.unshift(course);
  return out;
}

/**
 * その日のそのコマを休講にする（職員だけ）。
 * @param {{course_id:string, date:string, reason:string, wholeDay:boolean}} p
 * @return {{ok:boolean, courses:Array<string>, closedVacancies:number, notify:Object}}
 */
function cancelClass(p) {
  const me = requireStaff_();
  const q = p || {};
  const courseId = String(q.course_id || '').trim();
  const dateStr = String(q.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('日付が不正です。');
  const reason = String(q.reason || '').trim();
  if (!reason) throw new Error('休講の理由を入力してください（例：教員の都合・利用学生の欠席）。');
  if (reason.length > CANCEL_REASON_MAX) throw new Error('理由は' + CANCEL_REASON_MAX + '文字以内で入力してください。');
  if (/[<>"\\\u0000-\u001f\u007f]/.test(reason)) throw new Error('理由に使えない記号が含まれています（< > " \\ など）。');
  assertNotFormula_('理由', reason);
  if (!hasCancellationSheet_()) {
    throw new Error('休講を記録するシートがまだありません。GAS エディタから migrateAddCancellationsSheet() を実行してください。');
  }
  if (dateStr < todayJst_()) throw new Error('過ぎた日は休講にできません。');

  const course = findRow_(SHEET.COURSES, 'course_id', courseId);
  if (!course) throw new Error('対象のコマが見つかりません。');
  const cal = classCalendar_();
  const held = courseHeldOn_(course, dateStr, cal);
  if (!held.held) throw new Error('この日（' + dateStr + '）は' + held.reason + '。');

  const targets = cancellationTargets_(course, dateStr, !!q.wholeDay, function (c) {
    return courseHeldOn_(c, dateStr, cal).held;
  });

  const done = withLock_(function () {
    const existing = cancellationIndex_(readCancellations_());
    const added = [];
    targets.forEach(function (c) {
      const cid = String(c.course_id).trim();
      if (existing[cid + '|' + dateStr]) return;
      appendRowWithId_(SHEET.CANCELLATIONS, 'cancellation_id', 'X', {
        course_id: cid, date: dateStr, reason: reason, created_by: me.staff_id, created_at: nowString_(),
      });
      added.push(c);
    });
    // その日の決まっていない欠員は「休講」で決着させる（代行を探し続けない）
    const ids = {};
    added.forEach(function (c) { ids[String(c.course_id).trim()] = true; });
    const closed = [];
    const subs = [];
    readRows_(SHEET.VACANCIES).forEach(function (v) {
      if (!ids[String(v.course_id).trim()] || dateToStr_(v.date) !== dateStr) return;
      const sub = String(v.substitute_staff_id || '').trim();
      if (sub) subs.push(sub);
      if (String(v.result || '').trim()) return;
      updateRow_(SHEET.VACANCIES, 'vacancy_id', String(v.vacancy_id).trim(), { result: VACANCY_RESULT.CANCELLED });
      closed.push(String(v.vacancy_id).trim());
    });
    return { added: added, closed: closed, subs: subs };
  });
  clearClassCalendarCache_();

  var notify = null;
  if (done.added.length) {
    try {
      notify = notifyCancellation_(done.added, dateStr, reason, false, done.subs, me.name);
    } catch (e) {
      notify = { error: e.message };
    }
    done.closed.forEach(function (vid) {
      try { notifyVacancyClosed_(vid, VACANCY_RESULT.CANCELLED); } catch (e) { /* 候補への締め切りの知らせは届かなくても続ける */ }
    });
  }
  return {
    ok: true,
    courses: done.added.map(cancellationLabel_),
    closedVacancies: done.closed.length,
    notify: notify,
  };
}

/**
 * 休講を取り消す（職員だけ）。授業はその日に戻る。
 * 休講で決着させた欠員は戻さない（必要なら欠員補充管理で再オープンする）。
 * @param {{course_id:string, date:string, wholeDay:boolean}} p
 */
function uncancelClass(p) {
  const me = requireStaff_();
  const q = p || {};
  const courseId = String(q.course_id || '').trim();
  const dateStr = String(q.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) throw new Error('日付が不正です。');
  const course = findRow_(SHEET.COURSES, 'course_id', courseId);
  if (!course) throw new Error('対象のコマが見つかりません。');

  const index = cancellationIndex_(readCancellations_());
  if (!index[courseId + '|' + dateStr]) throw new Error('このコマのこの日は休講になっていません。');
  const targets = cancellationTargets_(course, dateStr, !!q.wholeDay, function (c) {
    return !!index[String(c.course_id).trim() + '|' + dateStr];
  });

  const removed = [];
  targets.forEach(function (c) {
    const hit = index[String(c.course_id).trim() + '|' + dateStr];
    if (hit && deleteRowByKey_(SHEET.CANCELLATIONS, 'cancellation_id', hit.id)) removed.push(c);
  });
  clearClassCalendarCache_();

  var notify = null;
  if (removed.length) {
    try {
      notify = notifyCancellation_(removed, dateStr, '', true, [], me.name);
    } catch (e) {
      notify = { error: e.message };
    }
  }
  const hadClosed = readRows_(SHEET.VACANCIES).some(function (v) {
    return dateToStr_(v.date) === dateStr && String(v.result || '').trim() === VACANCY_RESULT.CANCELLED &&
      removed.some(function (c) { return String(c.course_id).trim() === String(v.course_id).trim(); });
  });
  return { ok: true, courses: removed.map(cancellationLabel_), hadClosedVacancy: hadClosed, notify: notify };
}

/** 画面の返事に使う「火2限 介助」の形（利用学生の名前は入れない） */
function cancellationLabel_(c) {
  return String(c.day || '').trim() + periodLabelOf_(c.period, buildPeriodMap_()[String(c.period).trim()]) +
    ' ' + String(c.support_type || '').trim();
}
