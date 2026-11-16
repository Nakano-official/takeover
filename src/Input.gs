/**
 * シフト入力（courses 登録）— 職員専用
 *
 * 利用者中心の時間割（courses・D8）を画面から追加・削除する（backlog #4）。
 * クォーター毎に被支援者がフォームで申告した授業を、職員がここでシフトとして登録する。
 *
 * 公開関数（google.script.run から呼ぶ）:
 *  - getInputData()         : 入力用マスタ＋終わっていない学期のコマ一覧を返す
 *  - addCourse(payload)     : 1コマを追加する
 *  - updateCourse(payload)  : 1コマを編集する（教室未定など後からの修正）
 *  - deleteCourse(courseId) : 1コマを削除する
 */

// 既存コマ一覧の並び替え用（土日コマが過去データに在っても順序が壊れないよう全曜日を持つ）。
// 入力の選択肢そのものは WORK_DAYS（Constants.gs・関数内参照）を使う（backlog 10-5）。
const DAY_ORDER_INPUT = ['月', '火', '水', '木', '金', '土', '日'];

// 入力画面用データ（マスタ＋指定クォーターのコマ一覧）を返す
// 引数は使わない（以前は一覧に出す学期を受け取っていた。古い呼び出しが残っていても壊れないよう受けるだけ）
function getInputData(quarter) {
  requireStaff_();

  const nameById = {};
  const students = [];
  readRows_(SHEET.STAFFS).forEach(function (s) {
    const id = String(s.staff_id).trim();
    nameById[id] = s.name;
    if (String(s.role).trim() === '学生') {
      students.push({
        staff_id: id,
        name: s.name,
        skills: String(s.skills || '').trim(),
        // 空きコマは業務ごと（D32）。どちらで絞るかは画面が選んだ内容で決まる。
        slotsByType: slotsByTypeOf_(s),
      });
    }
  });

  const periodRows = readRows_(SHEET.PERIODS);
  const periodById = {};
  periodRows.forEach(function (p) { periodById[String(p.period).trim()] = p; });
  // 移動の枠は使わない（D57）。選択肢にも時間割にも出さない
  const isMoveKey = function (key) { return isMovePeriod_(periodById[String(key).trim()]); };
  const periods = periodRows.filter(function (p) { return !isMovePeriod_(p); }).map(function (p) {
    return {
      period: String(p.period).trim(),
      label: periodLabelOf_(p.period, p),
      // その授業の前後の移動の枠（D58）。介助のカードで「前の移動あり／後の移動あり」を出すのに使う
      moveBefore: moveSlotInfo_(precedingMovePeriod_(p.period, '介助')),
      moveAfter: moveSlotInfo_(followingMovePeriod_(p.period, '介助')),
      time: p.start_time ? p.start_time + '〜' + p.end_time : '',
      // その時限を選べる業務。画面は内容（テイク/介助）に応じて選択肢を出し分ける（D33）
      supportTypes: SUPPORT_TYPES.filter(function (t) {
        return periodAllowsSupportType_(p, t);
      }),
    };
  }).filter(function (p) { return p.period; });
  const periodIndex = {};
  periods.forEach(function (p, i) { periodIndex[p.period] = i; });

  const allCourses = readRows_(SHEET.COURSES);
  const courseTermIds = [];
  // 利用者の候補。空白の入り方だけが違う名前は1人にまとめる（D59）
  const spellingsByKey = {};
  allCourses.forEach(function (c) {
    const q = String(c.quarter).trim();
    if (q && courseTermIds.indexOf(q) === -1) courseTermIds.push(q);
    const u = String(c.user_student || '').trim();
    if (!u) return;
    (spellingsByKey[nameKey_(u)] = spellingsByKey[nameKey_(u)] || []).push(u);
  });
  const users = Object.keys(spellingsByKey).map(function (k) {
    return preferredNameSpelling_(spellingsByKey[k]);
  });
  users.sort();

  // 学期はカードごとに選ぶ（D52）。ここで決めるのは「手で足すカードの学期の初期値」（selected）だけ。
  // 既定は開講中の学期（無ければ今日にいちばん近い学期・D36）。
  const sel = resolveTermSelection_(null, courseTermIds, 'edit');
  // 開講中にセメスターとクォーターが並ぶとき（後期と 3Q は同じ日に始まる）は**セメスターを初期値にする**。
  // セメスター制の学部のほうが多く、クォーターの授業は PDF から学期つきで入るため。
  const currentSemester = readTerms_().filter(function (t) {
    return t.system === 'semester' && currentTermIds_().indexOf(t.term_id) !== -1;
  })[0];
  const selected = currentSemester ? currentSemester.term_id : sel.selected;

  // 一覧に出すのは**終わっていない学期**のコマ（終了日が今日以降・日付の無い学期も出す）。
  // 学期の選択欄は無くした。終わった学期のコマはシートに残るが一覧には出さない（直す場面が無いため）。
  // 学期マスタが無い旧DBでは全部出す。
  const termRows = readTerms_();
  const today = todayJst_();
  const termInfo = {};
  termRows.forEach(function (t) { termInfo[t.term_id] = t; });
  const listed = function (termId) {
    if (!termRows.length) return true;
    const t = termInfo[termId];
    if (!t) return true;                          // 学期マスタに無い学期のコマは、気づけるように出す
    return !t.end_date || t.end_date >= today;
  };
  // 学期の並び：始まりの早い順。同じ日に始まるならセメスター（前期・後期）を先に
  const termRank = function (termId) {
    const t = termInfo[termId];
    if (!t) return '9999-99-99 9';
    return (t.start_date || '9999-99-99') + ' ' + (t.system === 'semester' ? '0' : '1') + ' ' + termId;
  };

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

  // 残っている移動の枠のコマは出さない（D57）。片付けは GAS エディタから migrateMoveCoursesToFlags() で行う（D58）
  const courses = allCourses
    .filter(function (c) { return listed(String(c.quarter).trim()) && !isMoveKey(c.period); })
    .map(function (c) {
      return {
        course_id: String(c.course_id).trim(),
        quarter: String(c.quarter).trim(),
        day: String(c.day).trim(),
        period: String(c.period).trim(),
        periodLabel: periodLabelOf_(c.period, periodById[String(c.period).trim()]),
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
        move_before: hasMoveFlag_(c.move_before),   // 前の移動あり（D58）
        move_after: hasMoveFlag_(c.move_after),     // 後の移動あり
        workTime: courseWorkSpan_(c, periodById).hasMove ? courseWorkSpan_(c, periodById).label : '',
      };
    })
    .sort(function (a, b) {
      // 学期ごとにまとめる（画面は学期の見出しで区切る）
      const ra = termRank(a.quarter), rb = termRank(b.quarter);
      if (ra !== rb) return ra < rb ? -1 : 1;
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
    // 全学期の登録済みコマ（最小限の項目だけ）。時間割PDFから作るカードは学期がまちまちなので、
    // 表示中の学期に限らず「同じ利用者・学期・曜日・時限のコマが既にあるか」を画面で見るのに使う（D52）。
    courseSlots: allCourses.map(function (c) {
      return {
        quarter: String(c.quarter || '').trim(),
        day: String(c.day || '').trim(),
        period: String(c.period || '').trim(),
        date: courseDate_(c),
        user_student: String(c.user_student || '').trim(),
      };
    }),
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
  // 利用者の名前は空白を揃え、同じ人が別の書き方で登録済みならその書き方に寄せる（D59）
  const userStudent = canonicalUserStudent_(normalizeNameSpaces_(p.user_student));
  const staffA = String(p.staff_a_id || '').trim();
  const staffB = String(p.staff_b_id || '').trim();

  if (!quarter) throw new Error('学期を選んでください。');
  // 学期はカードごとに選ぶ（D52）。学期マスタがあるなら、そこに無い学期は受け付けない。
  const terms = readTerms_();
  if (terms.length && !terms.some(function (t) { return t.term_id === quarter; })) {
    throw new Error('学期マスタに無い学期です：' + quarter);
  }

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
  if (SUPPORT_TYPES.indexOf(supportType) === -1) {
    throw new Error('内容（' + SUPPORT_TYPES.join(' / ') + '）を選んでください。');
  }

  // その時限が実在し、その業務で選べるか（D32/D33）。
  // ここを素通しにすると、たとえばテイクを移動介助の枠に登録できてしまう。
  // テイクの空きコマ表に移動枠は無いので、そのコマは**代行候補が永久に0人**になる。
  // エラーは出ないので誰も気づけない。
  const periodRow = buildPeriodMap_()[period];
  if (!periodRow) throw new Error('存在しない時限です：' + period);
  // 移動の枠に別のコマとしては入れない（D57）。移動は介助の授業のコマの「前の移動あり／後の移動あり」で付ける（D58）
  if (isMovePeriod_(periodRow)) {
    throw new Error(periodLabelOf_(period, periodRow) + ' の枠は使わなくなりました。'
      + '移動は介助の授業のコマの「前の移動あり／後の移動あり」で付けてください。');
  }
  if (!periodAllowsSupportType_(periodRow, supportType)) {
    throw new Error(periodLabelOf_(period, periodRow) + ' は ' + supportType + ' では選べません。');
  }
  if (!userStudent) throw new Error('利用者を入力してください。');
  validatePersonName_('利用者', userStudent);

  // 前後の移動（D58）。介助のコマにだけ付けられ、その授業に移動の枠があるときだけ
  const wantBefore = !!p.move_before && p.move_before !== 'false';
  const wantAfter = !!p.move_after && p.move_after !== 'false';
  if (wantBefore || wantAfter) {
    if (supportType !== '介助') throw new Error('移動は介助のコマにだけ付けられます。');
    if (getHeaders_(SHEET.COURSES).indexOf('move_before') === -1) {
      throw new Error('移動を記録する列がまだありません。GAS エディタから migrateMoveCoursesToFlags() を実行してください。');
    }
    [['before', wantBefore, 'の前'], ['after', wantAfter, 'のあと']].forEach(function (x) {
      if (x[1] && !attachedMovePeriod_(period, '介助', x[0])) {
        throw new Error(periodLabelOf_(period, periodRow) + x[2] + 'の移動の枠がありません。');
      }
    });
  }

  // 自由に書ける欄は、シートで数式として扱われる形（先頭が = など）を受け付けない（Util.gs）。
  // 時間割PDFから入る値（D52）も手入力と同じくここを通る。
  [
    ['利用者', userStudent], ['科目名', p.subject], ['担当教員', p.instructor],
    ['教室', p.room], ['備考', p.note],
  ].forEach(function (f) { assertNotFormula_(f[0], f[1]); });

  // **担当は未定のままでよい（D38）。** 実務では授業（科目・教室・教員・利用学生・曜日時限）が
  // 学期開始前に確定し、担当の割り当ては学生の空きコマが集まってから決まる。
  // 必須にしていたせいで、担当が決まる前は「仮の担当」を入れるしかなく、
  // 実際に本番の全コマが職員アカウント名義になっていた（＝嘘のデータ）。
  //
  // 空の担当はどこでも除外済み（候補抽出・決着の提案・二重起用チェックのいずれも
  // `if (id)` / `filter(Boolean)` を通る）。欠勤連絡は担当者本人しか出せないので、
  // 担当未定のコマは自動的に対象外になる（正しい挙動）。
  if (staffB && staffA === staffB) throw new Error('担当A・Bに同じスタッフは選べません。');
  // Bだけ選ばれたらAへ寄せる。`isAssigned_` 等は両方を見るので動作は変わらないが、
  // 「1人ならA」に揃えておかないとシートを人が読んだときに分かりにくい。
  var a = staffA;
  var b = staffB;
  if (!a && b) { a = b; b = ''; }

  // スタッフ実在チェック
  const roleById = {};
  readRows_(SHEET.STAFFS).forEach(function (s) {
    roleById[String(s.staff_id).trim()] = String(s.role).trim();
  });
  [a, b].forEach(function (id) {
    if (id && roleById[id] === undefined) throw new Error('存在しないスタッフIDです：' + id);
  });

  // 二重起用チェック：期間の重なる学期・同じ曜日・時限で、**開催回が実際に重なる**別コマに入っていないか。
  // 後期と 3Q のように別の学期でも期間が重なれば、同じ時間に2か所へ入ることになる（D52）。
  // 単発同士は日付が違えばぶつからない（occurrencesOverlap_・D27）。
  const exclude = String(excludeCourseId || '').trim();
  const sameTime = concurrentTermSet_(quarter, terms, day, classCalendar_());
  const assigned = {};
  readRows_(SHEET.COURSES).forEach(function (c) {
    if (exclude && String(c.course_id).trim() === exclude) return;
    if (!sameTime[String(c.quarter).trim()]) return;
    if (String(c.day).trim() !== day) return;
    if (String(c.period).trim() !== period) return;
    if (!occurrencesOverlap_(dateStr, courseDate_(c))) return;
    [String(c.staff_a_id).trim(), String(c.staff_b_id).trim()].forEach(function (id) {
      if (id) assigned[id] = true;
    });
  });
  const where = (dateStr ? dateStr + '（' + day + '）' : day) + periodLabelOf_(period, periodRow);
  [a, b].forEach(function (id) {
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
    staff_a_id: a, staff_b_id: b,
    note: String(p.note || '').trim(),
    move_before: wantBefore ? MOVE_FLAG_VALUE : '',
    move_after: wantAfter ? MOVE_FLAG_VALUE : '',
  };
}

/**
 * その学期と、**その曜日に同時に授業がある**学期の集合（自分を含む）。二重起用チェック用（D52）。
 *
 * クォーターは**曜日ごとの期間**で比べる（D53）。`terms` のクォーターの行は「一番早い曜日の始まり〜
 * 一番遅い曜日の終わり」なので、行どうしで比べると 3Q（〜11/21）と 4Q（11/16〜）が重なって見え、
 * 3Q と 4Q で同じ曜日・時限に入る人（よくある形）が全員「二重起用」で弾かれていた。
 * 曜日ごとに見れば、同じ曜日の 3Q の終わりと 4Q の始まりは重ならない。
 *
 * Terms.gs の overlappingTermIds_ と違い、**境目の1日だけ重なるものは数えない**。
 * 日付が入っていない学期は、同じ学期どうしだけを同時とみなす。
 *
 * @param {string} termId
 * @param {Array}  terms   readTerms_() の結果
 * @param {string} [day]   曜日。cal と一緒に渡すとクォーターを曜日ごとの期間で比べる
 * @param {Object} [cal]   classCalendar_() の結果
 */
function concurrentTermSet_(termId, terms, day, cal) {
  const set = {};
  set[termId] = true;
  const rangeOf = function (t) {
    const r = (day && cal) ? termRangeOn_(cal, t.term_id, day) : null;
    if (r && r.start && r.end) return r;
    return (t.start_date && t.end_date) ? { start: t.start_date, end: t.end_date } : null;
  };
  var target = null;
  (terms || []).forEach(function (t) { if (t.term_id === termId) target = t; });
  const mine = target ? rangeOf(target) : null;
  if (!mine) return set;
  terms.forEach(function (t) {
    const r = rangeOf(t);
    if (!r) return;
    if (r.start < mine.end && mine.start < r.end) set[t.term_id] = true;
  });
  return set;
}

/**
 * 1コマを追加する。
 *
 * 以前は介助の授業の前後の移動介助を別のコマとして一緒に作っていた（D34・D35）が、2026-11-16 にやめた（D57）。
 * 移動の15分の枠が時間割を読みにくくするため。今は介助のコマの印（move_before / move_after・D58）で持つ。
 */
function addCourse(payload) {
  requireStaff_();
  const row = validateCoursePayload_(payload || {}, null);
  const id = appendRowWithId_(SHEET.COURSES, 'course_id', 'C', row);
  return { ok: true, course_id: id };
}

/** 画面へ渡す移動の枠の情報（無ければ null） */
function moveSlotInfo_(mv) {
  if (!mv) return null;
  return {
    period: String(mv.period).trim(),
    label: periodLabelOf_(mv.period, mv),
    time: mv.start_time ? hhmmText_(mv.start_time) + '〜' + hhmmText_(mv.end_time) : '',
  };
}

// 1コマを編集する（履修登録時に教室未定 → 後から修正、などに対応）
function updateCourse(payload) {
  requireStaff_();
  const p = payload || {};
  const courseId = String(p.course_id || '').trim();
  if (!courseId) throw new Error('course_id がありません。');

  const existing = findRow_(SHEET.COURSES, 'course_id', courseId);
  if (!existing) throw new Error('対象のコマが見つかりませんでした。');

  const row = validateCoursePayload_(p, courseId);

  // 欠員記録が紐づくコマは、構造（曜日・時限・内容・実施日）を変えない（記録保全のため）。
  // 科目・教室・担当・備考などの修正は許可する。
  // 実施日を含めるのは、単発コマ（D27）の日付を後から動かすと、その日に紐づいた欠員
  //（vacancies.date）と食い違い、どの回の欠員だったのか分からなくなるため。
  const hasVacancy = readRows_(SHEET.VACANCIES).some(function (v) {
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

  const updated = updateRow_(SHEET.COURSES, 'course_id', courseId, row);
  if (!updated) throw new Error('更新できませんでした（対象が見つかりません）。');
  return { ok: true, course_id: courseId };
}

// 1コマを削除する
function deleteCourse(courseId) {
  requireStaff_();
  const id = String(courseId || '').trim();
  if (!id) throw new Error('course_id がありません。');

  // 欠員記録が紐づくコマは削除しない（記録保全のため）
  const hasVacancy = readRows_(SHEET.VACANCIES).some(function (v) {
    return String(v.course_id).trim() === id;
  });
  if (hasVacancy) {
    throw new Error('このコマには欠員記録が紐づいているため削除できません。先に欠員側を整理してください。');
  }

  const n = deleteRowByKey_(SHEET.COURSES, 'course_id', id);
  if (!n) throw new Error('対象のコマが見つかりませんでした。');
  // そのコマの休講の記録（D60）はコマが無ければ意味が無いので一緒に消す
  readCancellations_().forEach(function (r) {
    if (String(r.course_id).trim() === id) deleteRowByKey_(SHEET.CANCELLATIONS, 'cancellation_id', String(r.cancellation_id).trim());
  });
  if (readCancellations_().length) clearClassCalendarCache_();
  return { ok: true, deleted: n };
}

/**
 * 利用者の名前を、登録済みの書き方に寄せる（D59）。
 *
 * 同じ利用学生でも「龍谷太郎」「龍谷 太郎」「龍谷　太郎」と書き方が違うと、別の人として扱われる
 * （利用者の候補に2回出る・時間割の絞り込みで分かれる）。空白を除いて同じ名前が登録済みなら、
 * 空白のある形（「姓 名」）を優先してその書き方にする。無ければ入力のまま。
 */
function canonicalUserStudent_(name) {
  if (!name) return name;
  const key = nameKey_(name);
  const same = [];
  readRows_(SHEET.COURSES).forEach(function (c) {
    const u = String(c.user_student || '').trim();
    if (u && nameKey_(u) === key) same.push(u);
  });
  if (!same.length) return name;
  return preferredNameSpelling_([name].concat(same));
}

// staff_id → 氏名（無ければIDをそのまま返す）
function nameOf_(id) {
  const s = findRow_(SHEET.STAFFS, 'staff_id', id);
  return s ? s.name : id;
}
