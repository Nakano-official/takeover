/**
 * シフト入力（courses 登録）— 職員専用
 *
 * 利用者中心の時間割（courses・D8）を画面から追加・削除する（backlog #4）。
 * クォーター毎に被支援者がフォームで申告した授業を、職員がここでシフトとして登録する。
 *
 * 公開関数（google.script.run から呼ぶ）:
 *  - getInputData(quarter)  : 入力用マスタ＋指定クォーターのコマ一覧を返す
 *  - addCourse(payload)     : 1コマを追加する
 *  - deleteCourse(courseId) : 1コマを削除する
 */

const DAY_ORDER_INPUT = ['月', '火', '水', '木', '金', '土', '日'];
const INPUT_DAYS = ['月', '火', '水', '木', '金', '土'];

// 入力画面用データ（マスタ＋指定クォーターのコマ一覧）を返す
function getInputData(quarter) {
  requireStaff_();

  const nameById = {};
  const students = [];
  readRows(SHEET.STAFFS).forEach(function (s) {
    const id = String(s.staff_id).trim();
    nameById[id] = s.name;
    if (String(s.role).trim() === '学生') {
      students.push({ staff_id: id, name: s.name, skills: String(s.skills || '').trim() });
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
  const quarters = [];
  const users = [];
  allCourses.forEach(function (c) {
    const q = String(c.quarter).trim();
    if (q && quarters.indexOf(q) === -1) quarters.push(q);
    const u = String(c.user_student || '').trim();
    if (u && users.indexOf(u) === -1) users.push(u);
  });
  quarters.sort();
  users.sort();
  const selected = (quarter && quarters.indexOf(quarter) !== -1)
    ? quarter
    : (quarters.length ? quarters[quarters.length - 1] : '');

  const courses = allCourses
    .filter(function (c) { return String(c.quarter).trim() === selected; })
    .map(function (c) {
      return {
        course_id: String(c.course_id).trim(),
        quarter: String(c.quarter).trim(),
        day: String(c.day).trim(),
        period: String(c.period).trim(),
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
      return (DAY_ORDER_INPUT.indexOf(a.day) - DAY_ORDER_INPUT.indexOf(b.day))
        || ((periodIndex[a.period] || 0) - (periodIndex[b.period] || 0))
        || String(a.user_student).localeCompare(b.user_student);
    });

  return {
    quarters: quarters,
    quarter: selected,
    days: INPUT_DAYS,
    periods: periods,
    staff: students,
    users: users,
    courses: courses,
  };
}

// 1コマを追加する
function addCourse(payload) {
  requireStaff_();
  const p = payload || {};
  const quarter = String(p.quarter || '').trim();
  const day = String(p.day || '').trim();
  const period = String(p.period || '').trim();
  const supportType = String(p.support_type || '').trim();
  const userStudent = String(p.user_student || '').trim();
  const staffA = String(p.staff_a_id || '').trim();
  const staffB = String(p.staff_b_id || '').trim();

  // 必須チェック
  if (!quarter) throw new Error('クォーターを入力してください。');
  if (!day) throw new Error('曜日を選んでください。');
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

  // 二重起用チェック：同じ quarter+day+period に既に入っているスタッフは不可
  const assigned = {};
  readRows(SHEET.COURSES).forEach(function (c) {
    if (String(c.quarter).trim() === quarter
      && String(c.day).trim() === day
      && String(c.period).trim() === period) {
      [String(c.staff_a_id).trim(), String(c.staff_b_id).trim()].forEach(function (id) {
        if (id) assigned[id] = true;
      });
    }
  });
  [staffA, staffB].forEach(function (id) {
    if (id && assigned[id]) {
      throw new Error(nameOf_(id) + ' は ' + day + period + '限 に既に別のコマへ入っています。');
    }
  });

  const id = appendRowWithId(SHEET.COURSES, 'course_id', 'C', {
    quarter: quarter, day: day, period: period,
    support_type: supportType, user_student: userStudent,
    subject: String(p.subject || '').trim(),
    instructor: String(p.instructor || '').trim(),
    room: String(p.room || '').trim(),
    staff_a_id: staffA, staff_b_id: staffB,
    note: String(p.note || '').trim(),
  });
  return { ok: true, course_id: id };
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
