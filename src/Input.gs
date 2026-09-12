/**
 * シフト入力（courses 登録）— 職員専用
 *
 * 利用者中心の時間割（courses・D8）を画面から追加・削除する（backlog #4）。
 * クォーター毎に被支援者がフォームで申告した授業を、職員がここでシフトとして登録する。
 *
 * 公開関数（google.script.run から呼ぶ）:
 *  - getInputData(quarter)  : 入力用マスタ＋指定クォーターのコマ一覧を返す
 *  - addCourse(payload)     : 1コマを追加する
 *  - updateCourse(payload)  : 1コマを編集する（教室未定など後からの修正）
 *  - deleteCourse(courseId) : 1コマを削除する
 */

// 既存コマ一覧の並び替え用（土日コマが過去データに在っても順序が壊れないよう全曜日を持つ）。
// 入力の選択肢そのものは WORK_DAYS（Constants.gs・関数内参照）を使う（backlog 10-5）。
const DAY_ORDER_INPUT = ['月', '火', '水', '木', '金', '土', '日'];

// 入力画面用データ（マスタ＋指定クォーターのコマ一覧）を返す
function getInputData(quarter) {
  requireStaff_();

  const nameById = {};
  const students = [];
  readRows(SHEET.STAFFS).forEach(function (s) {
    const id = String(s.staff_id).trim();
    nameById[id] = s.name;
    if (String(s.role).trim() === '学生') {
      students.push({
        staff_id: id,
        name: s.name,
        skills: String(s.skills || '').trim(),
        slots: String(s.available_slots || '').split(',')
          .map(function (x) { return x.trim(); }).filter(Boolean),
      });
    }
  });

  const periods = readRows(SHEET.PERIODS).map(function (p) {
    return {
      period: String(p.period).trim(),
      time: p.start_time ? p.start_time + '〜' + p.end_time : '',
    };
  });
  const periodIndex = {};
  periods.forEach(function (p, i) { periodIndex[p.period] = i; });

  const allCourses = readRows(SHEET.COURSES);
  const courseTermIds = [];
  const users = [];
  allCourses.forEach(function (c) {
    const q = String(c.quarter).trim();
    if (q && courseTermIds.indexOf(q) === -1) courseTermIds.push(q);
    const u = String(c.user_student || '').trim();
    if (u && users.indexOf(u) === -1) users.push(u);
  });
  users.sort();

  // 学期の選択を term マスタで解決する（11-3/D16）。input は編集用なので単一学期
  // （新規コマの割り当て先は1学期に定まるため、和集合ではなく単一で解決する）。
  const sel = resolveTermSelection_(quarter, courseTermIds, 'edit');
  const selected = sel.selected;
  const filterSet = {};
  sel.filterIds.forEach(function (id) { filterSet[id] = true; });

  // 学期セレクタ用に「体系（クォーター/セメスター）」ラベル付きの選択肢を作る。
  // これで職員はコマ登録時に「クォーター授業／セメスター授業」を選べる（term_id が体系を担う・D16）。
  const sysMap = termSystemMap_();
  const termOptions = sel.options.map(function (o) {
    const sysLabel = systemLabel_(sysMap[o.value] || '');
    return {
      value: o.value,
      label: o.value + (sysLabel ? '（' + sysLabel + '）' : ''),
      system: sysMap[o.value] || '',
    };
  });

  const courses = allCourses
    .filter(function (c) { return filterSet[String(c.quarter).trim()]; })
    .map(function (c) {
      return {
        course_id: String(c.course_id).trim(),
        quarter: String(c.quarter).trim(),
        day: String(c.day).trim(),
        period: String(c.period).trim(),
        date: courseDate_(c),          // 単発コマの実施日（空＝毎週・D27）
        support_type: String(c.support_type || '').trim(),
        user_student: String(c.user_student || '').trim(),
        subject: String(c.subject || '').trim(),
        instructor: String(c.instructor || '').trim(),
        room: String(c.room || '').trim(),
        staff_a_id: String(c.staff_a_id || '').trim(),
        staff_b_id: String(c.staff_b_id || '').trim(),
        staffA: nameById[String(c.staff_a_id).trim()] || String(c.staff_a_id || '').trim(),
        staffB: nameById[String(c.staff_b_id).trim()] || String(c.staff_b_id || '').trim(),
        note: String(c.note || '').trim(),
      };
    })
    .sort(function (a, b) {
      // 毎週のコマ（時間割）を先に、単発コマ（D27）を後ろに日付順でまとめる。
      // 性質が違うものを曜日順に混ぜると、職員が「この日のイベント」を探しにくい。
      if (!a.date !== !b.date) return a.date ? 1 : -1;
      if (a.date && b.date && a.date !== b.date) return a.date < b.date ? -1 : 1;
      return (DAY_ORDER_INPUT.indexOf(a.day) - DAY_ORDER_INPUT.indexOf(b.day))
        || ((periodIndex[a.period] || 0) - (periodIndex[b.period] || 0))
        || String(a.user_student).localeCompare(b.user_student);
    });

  return {
    terms: termOptions,       // 学期セレクタ用（体系ラベル付き・{value,label,system}）
    quarter: selected,
    days: WORK_DAYS.slice(),  // 業務のある曜日（Constants.gs・関数内参照で連結順に依存しない）
    periods: periods,
    staff: students,
    users: users,
    courses: courses,
  };
}

/**
 * 追加・編集で共通の入力検証（D27 で単発コマに対応）。
 *
 * かつて addCourse と updateCourse に同じ検証が約50行ずつ重複していた（backlog 10-10 の見送り分）。
 * 単発コマの規則をそこへ二重に書くと必ずドリフトするので、このタイミングで1本に抽出した。
 *
 * 単発コマ（date あり）の扱い：
 *  - **曜日は日付から導く**（画面が送ってくる day は使わない）。ズレようがない形にする。
 *  - 曜日は WORK_DAYS に縛らない。日曜の行事もありうるし、日付が決まっている以上
 *    「業務のある曜日か」を問う意味がない（WORK_DAYS は毎週コマの選択肢を決める定数）。
 *
 * @param {Object} p                 画面から来た入力
 * @param {string} [excludeCourseId] 編集時に「自分自身」を二重起用チェックから外す
 * @return {Object} courses へ書き込む正規化済みの値
 */
function validateCoursePayload_(p, excludeCourseId) {
  const quarter = String(p.quarter || '').trim();
  const dateStr = String(p.date || '').trim();
  const period = String(p.period || '').trim();
  const supportType = String(p.support_type || '').trim();
  const userStudent = String(p.user_student || '').trim();
  const staffA = String(p.staff_a_id || '').trim();
  const staffB = String(p.staff_b_id || '').trim();

  if (!quarter) throw new Error('学期を選んでください。');

  // 単発コマなら曜日は日付から導出する。毎週コマは画面の選択をそのまま使う。
  var day;
  if (dateStr) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      throw new Error('実施日の形式が不正です（YYYY-MM-DD で指定してください）。');
    }
    day = weekdayOf_(dateStr);
    if (!day) throw new Error('実施日が不正です：' + dateStr);
  } else {
    day = String(p.day || '').trim();
    if (!day) throw new Error('曜日を選んでください。');
  }

  if (!period) throw new Error('時限を選んでください。');
  if (supportType !== 'テイク' && supportType !== '介助') {
    throw new Error('内容（テイク / 介助）を選んでください。');
  }
  if (!userStudent) throw new Error('利用者を入力してください。');
  if (!staffA) throw new Error('担当スタッフ（少なくとも1名）を選んでください。');
  if (staffB && staffA === staffB) throw new Error('担当A・Bに同じスタッフは選べません。');

  // スタッフ実在チェック
  const roleById = {};
  readRows(SHEET.STAFFS).forEach(function (s) {
    roleById[String(s.staff_id).trim()] = String(s.role).trim();
  });
  [staffA, staffB].forEach(function (id) {
    if (id && roleById[id] === undefined) throw new Error('存在しないスタッフIDです：' + id);
  });

  // 二重起用チェック：同じ学期・曜日・時限で、**開催回が実際に重なる**別コマに入っていないか。
  // 単発同士は日付が違えばぶつからない（occurrencesOverlap_・D27）。
  const exclude = String(excludeCourseId || '').trim();
  const assigned = {};
  readRows(SHEET.COURSES).forEach(function (c) {
    if (exclude && String(c.course_id).trim() === exclude) return;
    if (String(c.quarter).trim() !== quarter) return;
    if (String(c.day).trim() !== day) return;
    if (String(c.period).trim() !== period) return;
    if (!occurrencesOverlap_(dateStr, courseDate_(c))) return;
    [String(c.staff_a_id).trim(), String(c.staff_b_id).trim()].forEach(function (id) {
      if (id) assigned[id] = true;
    });
  });
  const where = (dateStr ? dateStr + '（' + day + '）' : day) + period + '限';
  [staffA, staffB].forEach(function (id) {
    if (id && assigned[id]) {
      throw new Error(nameOf_(id) + ' は ' + where + ' に既に別のコマへ入っています。');
    }
  });

  return {
    quarter: quarter, day: day, period: period, date: dateStr,
    support_type: supportType, user_student: userStudent,
    subject: String(p.subject || '').trim(),
    instructor: String(p.instructor || '').trim(),
    room: String(p.room || '').trim(),
    staff_a_id: staffA, staff_b_id: staffB,
    note: String(p.note || '').trim(),
  };
}

// 1コマを追加する
function addCourse(payload) {
  requireStaff_();
  const row = validateCoursePayload_(payload || {}, null);
  const id = appendRowWithId(SHEET.COURSES, 'course_id', 'C', row);
  return { ok: true, course_id: id };
}

// 1コマを編集する（履修登録時に教室未定 → 後から修正、などに対応）
function updateCourse(payload) {
  requireStaff_();
  const p = payload || {};
  const courseId = String(p.course_id || '').trim();
  if (!courseId) throw new Error('course_id がありません。');

  const existing = findRow(SHEET.COURSES, 'course_id', courseId);
  if (!existing) throw new Error('対象のコマが見つかりませんでした。');

  const row = validateCoursePayload_(p, courseId);

  // 欠員記録が紐づくコマは、構造（曜日・時限・内容・実施日）を変えない（記録保全のため）。
  // 科目・教室・担当・備考などの修正は許可する。
  // 実施日を含めるのは、単発コマ（D27）の日付を後から動かすと、その日に紐づいた欠員
  //（vacancies.date）と食い違い、どの回の欠員だったのか分からなくなるため。
  const hasVacancy = readRows(SHEET.VACANCIES).some(function (v) {
    return String(v.course_id).trim() === courseId;
  });
  if (hasVacancy) {
    if (String(existing.day).trim() !== row.day
      || String(existing.period).trim() !== row.period
      || String(existing.support_type).trim() !== row.support_type
      || courseDate_(existing) !== row.date) {
      throw new Error('このコマには欠員記録が紐づいているため、曜日・時限・内容・実施日は変更できません'
        + '（科目・教室・担当などの修正は可能です）。');
    }
  }

  const updated = updateRow(SHEET.COURSES, 'course_id', courseId, row);
  if (!updated) throw new Error('更新できませんでした（対象が見つかりません）。');
  return { ok: true, course_id: courseId };
}

// 1コマを削除する
function deleteCourse(courseId) {
  requireStaff_();
  const id = String(courseId || '').trim();
  if (!id) throw new Error('course_id がありません。');

  // 欠員記録が紐づくコマは削除しない（記録保全のため）
  const hasVacancy = readRows(SHEET.VACANCIES).some(function (v) {
    return String(v.course_id).trim() === id;
  });
  if (hasVacancy) {
    throw new Error('このコマには欠員記録が紐づいているため削除できません。先に欠員側を整理してください。');
  }

  const n = deleteRowByKey(SHEET.COURSES, 'course_id', id);
  if (!n) throw new Error('対象のコマが見つかりませんでした。');
  return { ok: true, deleted: n };
}

// staff_id → 氏名（無ければIDをそのまま返す）
function nameOf_(id) {
  const s = findRow(SHEET.STAFFS, 'staff_id', id);
  return s ? s.name : id;
}
