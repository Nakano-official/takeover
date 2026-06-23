/**
 * 欠員補充ロジック
 *
 * 欠勤連絡画面（absence.html）から呼ばれるサーバー関数群。
 *  - getMyCourses     : ログイン中スタッフの担当コマ一覧（欠勤対象の選択肢）
 *  - submitAbsence    : 欠勤を登録し、代行候補を抽出して返す
 *  - findCandidates_  : 該当スロットに空きのある学生を抽出（内部）
 *
 * 通知の送信は別ファイル（Notify.gs）で行う。ここでは「欠員登録＋候補抽出」までを担う。
 */

const NOTIFY_STATUS_PENDING = '未通知';

// ─── 画面用API（google.script.run から呼ぶ）────────────────

/**
 * ログイン中スタッフが担当しているコマ一覧を返す（欠勤報告の選択肢用）。
 */
function getMyCourses() {
  const user = getCurrentUser_();
  if (!user) throw new Error('利用登録がありません。');

  const nameById = buildNameMap_();
  const periodById = buildPeriodMap_();

  // 最新クォーターに限定する（過去学期の古いコマは選択肢に出さない・review #3）。
  // 「過去分は削除しない」方針のため、courses には旧クォーターが累積している。
  const allCourses = readRows(SHEET.COURSES);
  const quarters = [];
  allCourses.forEach(function (c) {
    const q = String(c.quarter).trim();
    if (q && quarters.indexOf(q) === -1) quarters.push(q);
  });
  quarters.sort();
  const latest = quarters.length ? quarters[quarters.length - 1] : '';

  return allCourses
    .filter(function (c) {
      return String(c.quarter).trim() === latest && isAssigned_(c, user.staff_id);
    })
    .map(function (c) {
      const partnerId = String(c.staff_a_id).trim() === user.staff_id ? c.staff_b_id : c.staff_a_id;
      const p = periodById[String(c.period).trim()] || {};
      return {
        course_id: c.course_id,
        quarter: c.quarter,
        day: c.day,
        period: String(c.period).trim(),
        time: p.start_time ? p.start_time + '〜' + p.end_time : '',
        partner: nameById[String(partnerId).trim()] || partnerId || '',
      };
    });
}

/**
 * 欠勤を登録し、代行候補を抽出して返す。
 * @param {string} courseId 欠勤するコマ
 * @param {string} date     欠勤日（YYYY-MM-DD）
 * @return {{vacancy_id:string, course:Object, candidates:Array}}
 */
function submitAbsence(courseId, date) {
  const user = getCurrentUser_();
  if (!user) throw new Error('利用登録がありません。');

  const course = findRow(SHEET.COURSES, 'course_id', courseId);
  if (!course) throw new Error('指定のコマが見つかりません。');

  // なりすまし防止：本人がそのコマの担当か確認
  if (!isAssigned_(course, user.staff_id)) {
    throw new Error('あなたはこのコマの担当ではありません。');
  }
  if (!date) throw new Error('欠勤日を指定してください。');

  // 日付バリデーション（review #2）：形式・過去日・曜日一致をチェック
  const dateStr = dateToStr_(date);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error('欠勤日の形式が不正です。');
  }
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  if (dateStr < today) {
    throw new Error('過去の日付には欠勤登録できません。');
  }
  const wd = weekdayOf_(dateStr);
  const courseDay = String(course.day).trim();
  if (wd && courseDay && wd !== courseDay) {
    throw new Error('欠勤日（' + dateStr + '・' + wd + '曜）が、このコマの曜日（' + courseDay + '曜）と一致しません。');
  }

  // 二重登録の防止（同じ人・同じコマ・同じ日で未解決の欠員が既にある）
  const dup = readRows(SHEET.VACANCIES).filter(function (v) {
    return String(v.course_id).trim() === String(courseId).trim() &&
           dateToStr_(v.date) === dateStr &&
           String(v.absent_staff_id).trim() === user.staff_id &&
           !String(v.result).trim();
  });
  if (dup.length > 0) {
    throw new Error('この日のこのコマの欠勤は既に登録されています。');
  }

  // 欠員を登録（採番と追記を同一ロックで）
  const vacancyId = appendRowWithId(SHEET.VACANCIES, 'vacancy_id', 'V', {
    date: dateStr,
    course_id: courseId,
    absent_staff_id: user.staff_id,
    notify_status: NOTIFY_STATUS_PENDING,
    result: '',
  });

  // 代行候補を抽出（欠勤者と相方＋当日のダブルブッキングを除外）
  const candidates = findCandidates_(course, [course.staff_a_id, course.staff_b_id], dateStr);

  // 補充候補が0人 → 自動決着（review #4・CLAUDE.md ドメイン）。
  // 相方が残るコマ（2名テイク等）は「1人テイク」、残らない1名コマは「職員対応」。
  if (candidates.length === 0) {
    // 同コマ・同日に欠勤登録済みのスタッフ（相方も欠勤しているケース）を把握する（review再レビューB）
    const absentSameSlot = {};
    readRows(SHEET.VACANCIES).forEach(function (v) {
      if (String(v.course_id).trim() === String(courseId).trim() &&
          dateToStr_(v.date) === dateStr) {
        const a = String(v.absent_staff_id).trim();
        if (a) absentSameSlot[a] = true;
      }
    });
    // 欠勤者本人＋同コマ同日に欠勤している人を除いて、残るスタッフがいるか
    const remaining = [course.staff_a_id, course.staff_b_id]
      .map(function (x) { return String(x).trim(); })
      .filter(Boolean)
      .filter(function (id) { return id !== user.staff_id && !absentSameSlot[id]; });
    const autoResult = remaining.length > 0 ? '1人テイク' : '職員対応';
    updateRow(SHEET.VACANCIES, 'vacancy_id', vacancyId, { result: autoResult });

    var autoNotify;
    try {
      autoNotify = notifyAutoResolved(vacancyId, autoResult);
    } catch (e) {
      autoNotify = { error: e.message };
    }
    return {
      vacancy_id: vacancyId,
      course: {
        course_id: course.course_id,
        day: course.day,
        period: String(course.period).trim(),
      },
      candidates: [],
      autoResult: autoResult,
      notify: autoNotify,
    };
  }

  // 職員スペース＋候補者へ通知（失敗しても欠員登録は確定させる）
  var notify;
  try {
    notify = notifyNewVacancy(vacancyId);
  } catch (e) {
    notify = { error: e.message };
  }

  return {
    vacancy_id: vacancyId,
    course: {
      course_id: course.course_id,
      day: course.day,
      period: String(course.period).trim(),
    },
    candidates: candidates,
    notify: notify,
  };
}

// ─── 回答フロー（respond画面用）────────────────────────────

/**
 * 回答画面に表示する欠員情報を返す。ログインユーザーが候補かどうかも返す。
 * @param {string} vacancyId
 */
function getVacancyForRespond(vacancyId) {
  const user = getCurrentUser_();
  if (!user) throw new Error('利用登録がありません。');

  const vacancy = findRow(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  if (!vacancy) throw new Error('対象の欠員が見つかりません。');

  const course = findRow(SHEET.COURSES, 'course_id', vacancy.course_id);
  const nameById = buildNameMap_();
  const periodById = buildPeriodMap_();
  const p = course ? (periodById[String(course.period).trim()] || {}) : {};

  // 自分の既存回答
  const mine = readRows(SHEET.RESPONSES).filter(function (r) {
    return String(r.vacancy_id).trim() === String(vacancyId).trim() &&
           String(r.staff_id).trim() === user.staff_id;
  });

  return {
    vacancy_id: vacancyId,
    date: dateToStr_(vacancy.date),   // Date型のまま返すと google.script.run で null になるため文字列化
    day: course ? course.day : '',
    period: course ? String(course.period).trim() : '',
    time: p.start_time ? p.start_time + '〜' + p.end_time : '',
    absentName: nameById[String(vacancy.absent_staff_id).trim()] || vacancy.absent_staff_id,
    closed: !!String(vacancy.result).trim(),       // 対応確定済みなら true
    eligible: course ? isCandidate_(course, user.staff_id, vacancy.date) : false,
    myAnswer: mine.length ? mine[0].answer : '',
  };
}

/**
 * 代行依頼に回答する（承諾 / 辞退）＝先着自動確定（decisions.md D1）。
 *  - 「承諾」: まだ誰も確定していなければ、その場でこの回答者を代行に確定する（職員は介在しない）。
 *             同時承諾は claimIfEmpty（LockService内の compare-and-set）で1人だけが確保。
 *  - 「辞退」: 記録のみ。欠員は開いたまま。
 * 回答者は Session から特定するため、URLのvacancy_idだけでは他人になりすませない。
 *
 * @return 次のいずれか：
 *   {ok:true,  answer:'承諾', confirmed:true,  notify} … 自分に確定
 *   {ok:true,  answer:'辞退', confirmed:false}        … 辞退を記録
 *   {ok:false, filled:true,   closed:true}            … 既に他の人で埋まった（受付終了）
 */
function respondToVacancy(vacancyId, answer) {
  const user = getCurrentUser_();
  if (!user) throw new Error('利用登録がありません。');
  if (answer !== '承諾' && answer !== '辞退') throw new Error('回答内容が不正です。');

  const vacancy = findRow(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  if (!vacancy) throw new Error('対象の欠員が見つかりません。');

  const course = findRow(SHEET.COURSES, 'course_id', vacancy.course_id);
  if (!course) throw new Error('対象のコマが見つかりません。');

  // 候補資格チェック（候補以外は回答不可）
  if (!isCandidate_(course, user.staff_id, vacancy.date)) {
    throw new Error('あなたはこの欠員の代行候補ではありません。');
  }

  // 早期判定：既に確定済みなら受け付けない（権威ある判定は後段の claimIfEmpty）
  if (String(vacancy.result).trim()) {
    return { ok: false, filled: true, closed: true };
  }

  // 回答そのものは記録しておく（先着で負けても「承諾した事実」はログに残す）
  upsertRow(
    SHEET.RESPONSES,
    { vacancy_id: vacancyId, staff_id: user.staff_id },
    { answer: answer, answered_at: nowString_() }
  );

  // 辞退は確定処理を動かさない
  if (answer === '辞退') {
    return { ok: true, answer: answer, confirmed: false };
  }

  // 承諾 → 先着確保（result が空のときだけ自分を代行に確定）
  const claim = claimIfEmpty(
    SHEET.VACANCIES, 'vacancy_id', vacancyId, 'result',
    { result: '補充済', substitute_staff_id: user.staff_id }
  );
  if (!claim.ok) throw new Error('対象の欠員が見つかりません。');

  // 一瞬差で他の人に確定された → 受付終了
  if (!claim.claimed) {
    return { ok: false, filled: true, closed: true };
  }

  // 確定できた → 関係者へ通知（通知失敗でも確定は確定）
  var notify;
  try {
    notify = notifyVacancyFilled(vacancyId, user.staff_id);
  } catch (e) {
    notify = { error: e.message };
  }

  return { ok: true, answer: answer, confirmed: true, notify: notify };
}

// ─── 欠員補充管理（manage画面用・職員限定）─────────────────

const VACANCY_RESULTS = ['補充済', '1人テイク', '職員対応'];

/**
 * 欠員一覧を回答状況つきで返す（職員のダッシュボード用）。
 */
function getVacanciesForManage() {
  requireStaff_();

  const nameById = buildNameMap_();
  const periodById = buildPeriodMap_();
  const courseById = {};
  readRows(SHEET.COURSES).forEach(function (c) {
    courseById[String(c.course_id).trim()] = c;
  });

  // 欠員ごとの回答をまとめる
  const responsesByVacancy = {};
  readRows(SHEET.RESPONSES).forEach(function (r) {
    const vid = String(r.vacancy_id).trim();
    if (!responsesByVacancy[vid]) responsesByVacancy[vid] = [];
    responsesByVacancy[vid].push({
      staff_id: r.staff_id,
      name: nameById[String(r.staff_id).trim()] || r.staff_id,
      answer: r.answer,
      answered_at: String(r.answered_at || ''),
    });
  });

  return readRows(SHEET.VACANCIES).map(function (v) {
    const course = courseById[String(v.course_id).trim()] || {};
    const p = periodById[String(course.period || '').trim()] || {};
    const subId = String(v.substitute_staff_id || '').trim();
    return {
      vacancy_id: v.vacancy_id,
      date: dateToStr_(v.date),
      day: course.day || '',
      period: String(course.period || '').trim(),
      time: p.start_time ? p.start_time + '〜' + p.end_time : '',
      absentName: nameById[String(v.absent_staff_id).trim()] || v.absent_staff_id,
      result: String(v.result || '').trim(),
      substituteName: subId ? (nameById[subId] || subId) : '',
      responses: responsesByVacancy[String(v.vacancy_id).trim()] || [],
    };
  });
}

/**
 * 代行者を確定する。result を「補充済」にし substitute_staff_id を記録する。
 * （カレンダー反映は Phase 2 で Calendar.gs から行う）
 */
function confirmSubstitute(vacancyId, substituteStaffId) {
  requireStaff_();
  if (!substituteStaffId) throw new Error('代行者が指定されていません。');

  const vacancy = findRow(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  if (!vacancy) throw new Error('対象の欠員が見つかりません。');
  if (String(vacancy.result).trim()) throw new Error('この欠員は既に確定済みです。');

  const ok = updateRow(SHEET.VACANCIES, 'vacancy_id', vacancyId, {
    result: '補充済',
    substitute_staff_id: substituteStaffId,
  });
  if (!ok) throw new Error('欠員の更新に失敗しました。');

  // 確定を関係者へ通知（先着確定と挙動を揃える・review #8）
  var notify;
  try {
    notify = notifyVacancyFilled(vacancyId, substituteStaffId);
  } catch (e) {
    notify = { error: e.message };
  }
  return { ok: true, notify: notify };
}

/**
 * 代行者なしで決着させる（1人テイク / 職員対応）。
 */
function setVacancyResult(vacancyId, result) {
  requireStaff_();
  if (VACANCY_RESULTS.indexOf(result) === -1 || result === '補充済') {
    throw new Error('指定できる結果は「1人テイク」または「職員対応」です。');
  }
  const vacancy = findRow(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  if (!vacancy) throw new Error('対象の欠員が見つかりません。');
  if (String(vacancy.result).trim()) throw new Error('この欠員は既に確定済みです。');

  updateRow(SHEET.VACANCIES, 'vacancy_id', vacancyId, {
    result: result,
    substitute_staff_id: '',
  });

  // 募集終了を候補者へ通知（先着確定と挙動を揃える・review #8）
  var notify;
  try {
    notify = notifyVacancyClosed(vacancyId, result);
  } catch (e) {
    notify = { error: e.message };
  }
  return { ok: true, notify: notify };
}

/**
 * 確定済みの欠員を未確定（オープン）に戻す（職員のみ・review再レビューA）。
 * 候補0人で自動決着（1人テイク/職員対応）した後などに、見つかった代行者を
 * 充て直したり結果を変えたりするための導線。result と代行者をクリアして開き直す。
 */
function reopenVacancy(vacancyId) {
  requireStaff_();
  const vacancy = findRow(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  if (!vacancy) throw new Error('対象の欠員が見つかりません。');
  if (!String(vacancy.result).trim()) throw new Error('この欠員はまだ未確定です（再オープン不要）。');

  const ok = updateRow(SHEET.VACANCIES, 'vacancy_id', vacancyId, {
    result: '',
    substitute_staff_id: '',
    notify_status: NOTIFY_STATUS_PENDING,
  });
  if (!ok) throw new Error('欠員の更新に失敗しました。');
  return { ok: true };
}

// ─── 候補スクリーニング ──────────────────────────────────────

/**
 * コマの曜日・時限に空きがある学生を代行候補として抽出する。
 * available_slots は「月1,月2,火3」形式。コマのスロットキーは day+period（例：月1）。
 *
 * 同一スロットでの二重起用を防ぐため、以下も除外する（review #1）：
 *  - 同じクォーター・曜日・時限の「別コマ」の担当になっている学生
 *    （毎週その枠は埋まるため。available_slots と courses は別収集でドリフトしうる）
 *  - date 指定時：その日付・同じスロットで既に代行確定済み（substitute）の学生
 *
 * @param {Object} course           対象コマ
 * @param {Array}  excludeStaffIds  除外するスタッフID（欠勤者・相方など）
 * @param {string} [date]           欠勤日（YYYY-MM-DD）。指定時は当日の代行確定者も除外
 */
function findCandidates_(course, excludeStaffIds, date) {
  const slotKey = String(course.day).trim() + String(course.period).trim();
  const exclude = (excludeStaffIds || []).map(function (x) { return String(x).trim(); });
  const supportType = String(course.support_type || '').trim();        // テイク / 介助
  const quarter = String(course.quarter).trim();
  const courseId = String(course.course_id).trim();

  // 同一スロットで「埋まっている」学生（ダブルブッキング除外用）
  const allCourses = readRows(SHEET.COURSES);
  const slotOf = {};   // course_id → day+period
  const busy = {};     // staff_id → そのスロットは空けられない
  allCourses.forEach(function (c) {
    const cid = String(c.course_id).trim();
    slotOf[cid] = String(c.day).trim() + String(c.period).trim();
    if (cid !== courseId &&
        String(c.quarter).trim() === quarter &&
        slotOf[cid] === slotKey) {
      [c.staff_a_id, c.staff_b_id].forEach(function (id) {
        id = String(id).trim();
        if (id) busy[id] = true;
      });
    }
  });

  // date 指定時：その日・同スロットで既に代行確定済みの学生も除外
  if (date) {
    const target = dateToStr_(date);
    readRows(SHEET.VACANCIES).forEach(function (v) {
      const sub = String(v.substitute_staff_id || '').trim();
      if (!sub) return;
      if (dateToStr_(v.date) !== target) return;
      if (slotOf[String(v.course_id).trim()] === slotKey) busy[sub] = true;
    });
  }

  return readRows(SHEET.STAFFS)
    .filter(function (s) {
      const id = String(s.staff_id).trim();
      if (String(s.role).trim() !== '学生') return false;             // 学生のみ候補
      if (exclude.indexOf(id) !== -1) return false;                   // 欠勤者・相方を除外
      if (busy[id]) return false;                                     // 同一スロットで二重起用になる
      const slots = String(s.available_slots).split(',').map(function (x) { return x.trim(); });
      if (slots.indexOf(slotKey) === -1) return false;                // 該当スロットに空き
      // 対応可能な内容（スキル）チェック。skills 未設定は従来どおり全対応扱い
      if (supportType) {
        const skills = String(s.skills || '').split(',')
          .map(function (x) { return x.trim(); }).filter(Boolean);
        if (skills.length && skills.indexOf(supportType) === -1) return false;
      }
      return true;
    })
    .map(function (s) {
      return { staff_id: s.staff_id, name: s.name };
    });
}

// ─── 内部ヘルパー ────────────────────────────────────────────

// スタッフが指定コマの担当（A or B）か
function isAssigned_(course, staffId) {
  return String(course.staff_a_id).trim() === String(staffId).trim() ||
         String(course.staff_b_id).trim() === String(staffId).trim();
}

// スタッフが指定コマの代行候補か（担当A/Bを除外したスクリーニング結果に含まれるか）
// date を渡すと当日のダブルブッキング（別コマ担当・代行確定済み）も考慮する。
function isCandidate_(course, staffId, date) {
  const target = String(staffId).trim();
  return findCandidates_(course, [course.staff_a_id, course.staff_b_id], date).some(function (c) {
    return String(c.staff_id).trim() === target;
  });
}

// 'YYYY-MM-DD' から曜日（月〜日）を返す。形式不正なら空文字。
function weekdayOf_(dateStr) {
  const m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
}

// 現在時刻を 'yyyy-MM-dd HH:mm:ss'（日本時間）の文字列で返す
function nowString_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
}

// 値がDate型でも文字列でも 'yyyy-MM-dd'（日本時間）の文字列に揃える。
// google.script.run は Date を含むオブジェクトを返すと null 化することがあるため。
function dateToStr_(d) {
  if (d instanceof Date) {
    return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
  }
  return String(d == null ? '' : d).slice(0, 10);
}

// staff_id → 氏名 のマップ
function buildNameMap_() {
  const map = {};
  readRows(SHEET.STAFFS).forEach(function (s) {
    map[String(s.staff_id).trim()] = s.name;
  });
  return map;
}

// period → periodsレコード のマップ
function buildPeriodMap_() {
  const map = {};
  readRows(SHEET.PERIODS).forEach(function (p) {
    map[String(p.period).trim()] = p;
  });
  return map;
}

// ─── デバッグ用 ──────────────────────────────────────────────

/**
 * 回答画面サーバー関数の動作確認。最新の欠員に対して getVacancyForRespond を実行しログ出力。
 * 「読み込み中で固まる」原因（サーバー側エラー）を切り分けるために使う。
 */
function testRespond() {
  const vacancies = readRows(SHEET.VACANCIES);
  if (vacancies.length === 0) {
    Logger.log('vacancies が空です。先に欠勤連絡で欠員を作ってください。');
    return;
  }
  const vid = vacancies[vacancies.length - 1].vacancy_id;
  Logger.log('実行ユーザー: ' + Session.getActiveUser().getEmail());
  const me = getCurrentUser_();
  Logger.log('→ staff_id: ' + (me ? me.staff_id + '（' + me.role + '）' : '未登録'));
  Logger.log('対象 vacancy_id: ' + vid);
  try {
    const res = getVacancyForRespond(vid);
    Logger.log('結果: ' + JSON.stringify(res));
  } catch (e) {
    Logger.log('❌ エラー: ' + e.message);
    Logger.log(e.stack);
  }
}

/**
 * 候補スクリーニングの動作確認。GASエディタから実行してログを見る。
 * 実データは変更しない。
 */
function testVacancy() {
  Logger.log('===== Vacancy 候補スクリーニング確認 =====');

  const courses = readRows(SHEET.COURSES);
  if (courses.length === 0) {
    Logger.log('courses が空です。Setup を確認してください。');
    return;
  }

  courses.forEach(function (c) {
    const slotKey = String(c.day).trim() + String(c.period).trim();
    Logger.log('--- コマ ' + c.course_id + '（' + slotKey + '限）担当=' +
      c.staff_a_id + '/' + c.staff_b_id + ' ---');

    // 全学生のスロットを可視化（なぜ候補になる/ならないかを確認できる）
    readRows(SHEET.STAFFS).forEach(function (s) {
      if (String(s.role).trim() !== '学生') return;
      const slots = String(s.available_slots).split(',').map(function (x) { return x.trim(); });
      const hit = slots.indexOf(slotKey) !== -1;
      Logger.log('   ' + s.staff_id + ' ' + s.name + ' [' + s.available_slots + ']' +
        (hit ? ' ← スロット一致' : ''));
    });

    const candidates = findCandidates_(c, [c.staff_a_id, c.staff_b_id]);
    Logger.log('   → 代行候補: ' +
      (candidates.length ? candidates.map(function (x) { return x.name; }).join('、') : 'なし'));
  });

  Logger.log('（候補が「なし」の場合、その曜日時限に空きのある別の学生を staffs に足すと候補に出ます）');
  Logger.log('===== 確認終了 =====');
}
