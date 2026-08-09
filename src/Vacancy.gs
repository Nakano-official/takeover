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

  // 現在の学期に限定する（過去学期の古いコマは選択肢に出さない・review #3）。
  // 「過去分は削除しない」方針のため courses には旧学期が累積している。
  // 学期は term マスタで解決する（今日を含む学期の集合・11-3/D16）。
  // 先端理工のクォーターと他学部のセメスターが同時に走るため「現在」は集合になりうる。
  const allCourses = readRows(SHEET.COURSES);
  const courseTermIds = [];
  allCourses.forEach(function (c) {
    const q = String(c.quarter).trim();
    if (q && courseTermIds.indexOf(q) === -1) courseTermIds.push(q);
  });
  const activeSet = {};
  activeTermIds_(courseTermIds).forEach(function (id) { activeSet[id] = true; });

  // 学期ID → 開講期間（欠勤日の選択肢を「授業のある日」に限定するため画面へ渡す）
  const termById = {};
  readTerms_().forEach(function (t) { termById[t.term_id] = t; });

  return allCourses
    .filter(function (c) {
      return activeSet[String(c.quarter).trim()] && isAssigned_(c, user.staff_id);
    })
    .map(function (c) {
      const partnerId = String(c.staff_a_id).trim() === user.staff_id ? c.staff_b_id : c.staff_a_id;
      const p = periodById[String(c.period).trim()] || {};
      const term = termById[String(c.quarter).trim()] || {};
      return {
        course_id: c.course_id,
        quarter: c.quarter,
        day: c.day,
        period: String(c.period).trim(),
        time: p.start_time ? p.start_time + '〜' + p.end_time : '',
        partner: nameById[String(partnerId).trim()] || partnerId || '',
        termStart: term.start_date || '',
        termEnd: term.end_date || '',
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

  // 学期期間チェック：欠勤日はコマの学期（terms）の開講期間内であること。
  // 曜日が合っていても、長期休暇中や学期外・翌年など「授業が無い日」の登録を防ぐ（重大バグ修正）。
  // terms 未整備／該当学期に日付が無い場合はスキップ（後方互換）。
  const courseTerm = readTerms_().filter(function (t) {
    return t.term_id === String(course.quarter).trim();
  })[0];
  if (courseTerm && courseTerm.start_date && courseTerm.end_date) {
    if (dateStr < courseTerm.start_date || dateStr > courseTerm.end_date) {
      throw new Error('欠勤日（' + dateStr + '）は、このコマの学期「' + courseTerm.term_id +
        '」の開講期間（' + courseTerm.start_date + '〜' + courseTerm.end_date + '）外です。' +
        '授業のある日を選んでください。');
    }
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

  const courseInfo = {
    course_id: course.course_id,
    day: course.day,
    period: String(course.period).trim(),
  };

  // 代行者なしで決着させる共通処理（候補0人・締切超過の両方から使う）。
  // 決着書き込みは状態機械（settle 遷移）に通す。作成直後で競合は無いが、
  // 全ての result 書き込みを1経路に揃える（backlog 11-2）。
  const settleWithoutSubstitute_ = function (reason) {
    const autoResult = autoSettleResult_(course, dateStr, user.staff_id);
    transitionVacancyOrThrow_(vacancyId, 'settle', { result: autoResult });
    var autoNotify;
    try {
      autoNotify = notifyAutoResolved(vacancyId, autoResult, reason);
    } catch (e) {
      autoNotify = { error: e.message };
    }
    return {
      vacancy_id: vacancyId,
      course: courseInfo,
      candidates: [],
      autoResult: autoResult,
      notify: autoNotify,
    };
  };

  // 締切超過（授業開始 RECRUIT_DEADLINE_MIN_BEFORE 分前を過ぎている）→ 直前欠勤。
  // 欠勤の記録は残すが、間に合わない代行依頼は候補へ送らない（requirements §8・運用決定）。
  // 職員スペースには「直前欠勤（代行募集なし）」を通知し、画面では学生に
  // Google Classroom への欠勤連絡を案内する（従来の人力フローへ戻す）。
  if (isPastRecruitDeadline_(dateStr, course.period)) {
    const late = settleWithoutSubstitute_(AUTO_RESOLVE_REASON.PAST_DEADLINE);
    late.lateAbsence = true;
    late.deadlineMinutes = RECRUIT_DEADLINE_MIN_BEFORE;
    return late;
  }

  // 代行候補を抽出（欠勤者と相方＋当日のダブルブッキングを除外）
  const candidates = findCandidates_(course, [course.staff_a_id, course.staff_b_id], dateStr);

  // 補充候補が0人 → 自動決着（review #4・CLAUDE.md ドメイン）。
  // 相方が残るコマ（2名テイク等）は「1人テイク」、残らない1名コマは「職員対応」。
  if (candidates.length === 0) {
    return settleWithoutSubstitute_(AUTO_RESOLVE_REASON.NO_CANDIDATES);
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
    course: courseInfo,
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
  if (answer !== ANSWER.ACCEPT && answer !== ANSWER.DECLINE) throw new Error('回答内容が不正です。');

  const vacancy = findRow(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  if (!vacancy) throw new Error('対象の欠員が見つかりません。');

  // 対象日を過ぎた募集には回答不可（古いリンクからの後日承諾を弾く・backlog 10-9）。
  // 作成側 submitAbsence にしか過去日拒否が無かった非対称を是正する。
  assertVacancyNotPast_(vacancy.date);

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
  if (answer === ANSWER.DECLINE) {
    return { ok: true, answer: answer, confirmed: false };
  }

  // 承諾 → 先着確保（result が空のときだけ自分を代行に確定・settle 遷移）。
  // throwしない低レベル版を使い、負けたら「埋まりました」を穏当に返す。
  const claim = tryTransitionVacancy_(
    vacancyId, 'settle',
    { result: VACANCY_RESULT.FILLED, substitute_staff_id: user.staff_id }
  );
  if (!claim.ok) throw new Error('対象の欠員が見つかりません。');

  // 一瞬差で他の人に確定された → 受付終了
  if (!claim.applied) {
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

// ─── 欠員ライフサイクルの状態遷移（状態機械・backlog 11-2）──────
//
// 「未解決 → 補充済／1人テイク／職員対応 → 再オープン」という遷移を、
// 従来は respondToVacancy・confirmSubstitute・setVacancyResult・reopenVacancy・
// 自動決着に個別実装しており、CAS（先着確定との競合検査）や前提条件が
// 遷移ごとに抜けていた（10-1・10-4・10-9 はすべてこの構造が同じ原因）。
// result 列を「決着マーカー」とした compare-and-set を1箇所に集約し、
// 全ての result 書き込みをこの2関数だけに通す。
//
//   direction='settle' : 未決着(result空) → 決着（updates を書き込む・先着確保）
//   direction='reopen' : 決着済(result非空) → 未決着（result等をクリア）

/**
 * 遷移をCASで試みる（throwしない低レベル版）。先着で負けても例外にしないため、
 * respondToVacancy が「埋まりました」を穏当に返せる。
 * @return {{ok:boolean, applied:boolean, current:(Object|null)}}
 *   ok=false     : 対象の欠員が存在しない
 *   applied=true : 前提を満たし書き込んだ（current は書き込み前スナップショット）
 *   applied=false: 前提不成立で未書き込み（settle=既に決着 / reopen=まだ未決着）
 */
function tryTransitionVacancy_(vacancyId, direction, updates) {
  if (direction === 'settle') {
    const claim = claimIfEmpty(SHEET.VACANCIES, 'vacancy_id', vacancyId, 'result', updates);
    return { ok: claim.ok, applied: claim.claimed, current: claim.current };
  }
  if (direction === 'reopen') {
    const res = updateRowIfGuard_(
      SHEET.VACANCIES, 'vacancy_id', vacancyId, 'result', 'notEmpty', updates
    );
    return { ok: res.ok, applied: res.applied, current: res.current };
  }
  throw new Error('未知の遷移です：' + direction);
}

/**
 * 遷移を実行し、前提不成立を職員向けメッセージで throw する（confirm/setResult/reopen 用）。
 * @return {{ok, applied, current}} applied は必ず true（失敗時は throw 済み）
 */
function transitionVacancyOrThrow_(vacancyId, direction, updates) {
  const res = tryTransitionVacancy_(vacancyId, direction, updates);
  if (!res.ok) throw new Error('対象の欠員が見つかりません。');
  if (!res.applied) {
    throw new Error(direction === 'reopen'
      ? 'この欠員はまだ未確定です（再オープン不要）。'
      : MSG_VACANCY_SETTLED);
  }
  return res;
}

/**
 * 代行募集の締切（授業開始の RECRUIT_DEADLINE_MIN_BEFORE 分前）を過ぎているか。
 *
 * 締切は欠員行に保存せず、対象日＋時限マスタの開始時刻から**毎回算出する**。
 * こうしておくと定数を変えたときに既存の未解決欠員へも即反映され、
 * 「この欠員だけ締切が違う」という状態が生まれない（requirements §8）。
 *
 * 時限マスタに開始時刻が無い／形式が読めない場合は**判定不能**とみなし false を返す
 * （＝従来どおり代行募集を行う）。締切が読めないことを理由に募集を止めない、という安全側に倒す。
 * 時刻セルが文字列でも Date でも同じ結果になる（periodStartMinutes_）。
 *
 * @param {string} dateStr 'yyyy-MM-dd'
 * @param {(string|number)} period 時限
 * @return {boolean} 締切を過ぎていれば true
 */
function isPastRecruitDeadline_(dateStr, period) {
  const dm = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) return false;

  const p = buildPeriodMap_()[String(period).trim()];
  const startMin = p ? periodStartMinutes_(p.start_time) : null;
  if (startMin === null) return false;

  // スクリプトのタイムゾーンは Asia/Tokyo（appsscript.json）なので、
  // 数値から組み立てた Date と new Date() の比較はそのまま日本時間の比較になる。
  const midnight = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), 0, 0, 0);
  const deadline = midnight.getTime() + (startMin - RECRUIT_DEADLINE_MIN_BEFORE) * 60 * 1000;
  return new Date().getTime() > deadline;
}

/**
 * 代行者なしで決着させるときの結果を決める（D10）。
 * 欠勤者本人と、同コマ・同日に既に欠勤登録している人（相方も欠勤しているケース）を除いて、
 * 担当が残るなら「1人テイク」、誰も残らないなら「職員対応」。
 *
 * 補充候補0人のときと、締切超過の直前欠勤のときの**両方**から使う。
 *
 * @param {Object} course
 * @param {string} dateStr        'yyyy-MM-dd'
 * @param {string} absentStaffId  欠勤者
 * @return {string} VACANCY_RESULT.SOLO / VACANCY_RESULT.STAFF
 */
function autoSettleResult_(course, dateStr, absentStaffId) {
  const courseId = String(course.course_id).trim();
  const absentId = String(absentStaffId).trim();

  const absentSameSlot = {};
  readRows(SHEET.VACANCIES).forEach(function (v) {
    if (String(v.course_id).trim() === courseId && dateToStr_(v.date) === dateStr) {
      const a = String(v.absent_staff_id).trim();
      if (a) absentSameSlot[a] = true;
    }
  });

  const remaining = [course.staff_a_id, course.staff_b_id]
    .map(function (x) { return String(x).trim(); })
    .filter(Boolean)
    .filter(function (id) { return id !== absentId && !absentSameSlot[id]; });

  return remaining.length > 0 ? VACANCY_RESULT.SOLO : VACANCY_RESULT.STAFF;
}

/**
 * 欠員の対象日が過去でないことを確認する（過ぎた募集への操作を弾く・backlog 10-9）。
 * 古いChat通知リンクから、日付が過ぎた欠員に後日「承諾」されるのを防ぐ。
 */
function assertVacancyNotPast_(dateValue) {
  const dateStr = dateToStr_(dateValue);
  const today = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd');
  if (dateStr && dateStr < today) {
    throw new Error('この募集は対象日を過ぎています。');
  }
}

// ─── 欠員補充管理（manage画面用・職員限定）─────────────────

/**
 * 欠員一覧を回答状況つきで返す（職員のダッシュボード用）。
 */
function getVacanciesForManage() {
  requireStaff_();

  // 各シートは一度だけ読み、findCandidates_ に ctx として渡して
  // 欠員ごとのフルリード（courses/staffs/vacancies）を防ぐ（最適化）。
  const allStaffs = readRows(SHEET.STAFFS);
  const allCourses = readRows(SHEET.COURSES);
  const allVacancies = readRows(SHEET.VACANCIES);
  const ctx = { staffs: allStaffs, courses: allCourses, vacancies: allVacancies };

  const nameById = {};
  allStaffs.forEach(function (s) { nameById[String(s.staff_id).trim()] = s.name; });
  const periodById = buildPeriodMap_();
  const courseById = {};
  allCourses.forEach(function (c) {
    courseById[String(c.course_id).trim()] = c;
  });

  // 連絡先（電話）。連絡先DBは職員のみ＝この画面（職員限定）でのみ表示する（D4）。
  const phoneById = {};
  readRows(SHEET.CONTACTS).forEach(function (c) {
    phoneById[String(c.staff_id).trim()] = String(c.phone || '').trim();
  });

  // 欠員ごとの回答をまとめる（＋ staff_id → answer の索引）
  const responsesByVacancy = {};
  const answerByVacancy = {};
  readRows(SHEET.RESPONSES).forEach(function (r) {
    const vid = String(r.vacancy_id).trim();
    const sid = String(r.staff_id).trim();
    if (!responsesByVacancy[vid]) responsesByVacancy[vid] = [];
    responsesByVacancy[vid].push({
      staff_id: r.staff_id,
      name: nameById[sid] || r.staff_id,
      answer: r.answer,
      answered_at: String(r.answered_at || ''),
    });
    if (!answerByVacancy[vid]) answerByVacancy[vid] = {};
    answerByVacancy[vid][sid] = r.answer;
  });

  return allVacancies.map(function (v) {
    const vid = String(v.vacancy_id).trim();
    const course = courseById[String(v.course_id).trim()] || {};
    const p = periodById[String(course.period || '').trim()] || {};
    const subId = String(v.substitute_staff_id || '').trim();
    const resolved = !!String(v.result || '').trim();

    // 未解決のみ、電話フロー用に「候補（空きコマ学生）＋電話＋回答状況」を付ける。
    // 返信が来ないとき、職員がこの電話番号に直接連絡して口頭で決めるための導線。
    var candidates = [];
    if (!resolved && String(course.course_id || '').trim()) {
      candidates = findCandidates_(course, [course.staff_a_id, course.staff_b_id], v.date, ctx)
        .map(function (cand) {
          const sid = String(cand.staff_id).trim();
          return {
            staff_id: cand.staff_id,
            name: cand.name,
            phone: phoneById[sid] || '',
            answer: (answerByVacancy[vid] && answerByVacancy[vid][sid]) || '',
          };
        });
    }

    return {
      vacancy_id: v.vacancy_id,
      date: dateToStr_(v.date),
      day: course.day || '',
      period: String(course.period || '').trim(),
      time: p.start_time ? p.start_time + '〜' + p.end_time : '',
      absentName: nameById[String(v.absent_staff_id).trim()] || v.absent_staff_id,
      result: String(v.result || '').trim(),
      substituteName: subId ? (nameById[subId] || subId) : '',
      responses: responsesByVacancy[vid] || [],
      candidates: candidates,
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

  // result が空のときだけ atomically 確定する（settle 遷移）。
  // 職員の確定中に候補者が respondToVacancy で先着確定するケースを防ぐ（D1違反の是正・backlog 10-1）。
  transitionVacancyOrThrow_(vacancyId, 'settle',
    { result: VACANCY_RESULT.FILLED, substitute_staff_id: substituteStaffId });

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
  if (VACANCY_RESULT_VALUES.indexOf(result) === -1 || result === VACANCY_RESULT.FILLED) {
    throw new Error('指定できる結果は「' + VACANCY_RESULT.SOLO + '」または「' + VACANCY_RESULT.STAFF + '」です。');
  }

  // result が空のときだけ atomically 決着する（settle 遷移）。
  // 職員の決着中に候補者が先着確定するケースを防ぐ（D1違反の是正・backlog 10-1）。
  transitionVacancyOrThrow_(vacancyId, 'settle', { result: result, substitute_staff_id: '' });

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

  // result が非空（決着済み）のときだけ atomically 開き直す（reopen 遷移）。
  // 「旧確定者の控え」と「クリア」を同一ロックで行い、確定処理との競合で
  // 解除通知の宛先がずれるのを防ぐ（backlog 10-1）。旧値は current（書き込み前）から読む。
  const res = transitionVacancyOrThrow_(vacancyId, 'reopen',
    { result: '', substitute_staff_id: '', notify_status: NOTIFY_STATUS_PENDING });

  // 書き込み前スナップショットから「補充済で確定していた代行者」を控える（解除通知のため）
  const prevSub = String(res.current.result).trim() === VACANCY_RESULT.FILLED
    ? String(res.current.substitute_staff_id || '').trim()
    : '';

  // 元の確定者へ解除を通知（review 3次レビュー・#8 の対称性に揃える）
  var released = null;
  if (prevSub) {
    try {
      released = notifySubstituteReleased(vacancyId, prevSub);
    } catch (e) {
      released = { error: e.message };
    }
  }

  // 候補者へ再募集を送る（backlog 10-4）。
  // 従来は notify_status を戻すだけで再送経路が無く、全候補が「募集終了」を受信済みのまま
  // 誰にも再依頼が届かず無人で当日を迎える恐れがあった。notifyNewVacancy を再利用する。
  var reNotify;
  try {
    reNotify = notifyNewVacancy(vacancyId, true);
  } catch (e) {
    reNotify = { error: e.message };
  }
  return { ok: true, notify: { released: released, reopened: reNotify } };
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
 * @param {Object} [ctx]            読み込み済みの行データ {staffs, courses, vacancies}。
 *                                  渡すとシート再読込を省く（一覧で多数回呼ぶ場合の最適化）。
 *                                  省略時は各シートを内部で読む（従来動作・後方互換）。
 */
function findCandidates_(course, excludeStaffIds, date, ctx) {
  const slotKey = String(course.day).trim() + String(course.period).trim();
  const exclude = (excludeStaffIds || []).map(function (x) { return String(x).trim(); });
  const supportType = String(course.support_type || '').trim();        // テイク / 介助
  const quarter = String(course.quarter).trim();
  const courseId = String(course.course_id).trim();

  // 同一スロットで「埋まっている」学生（ダブルブッキング除外用）
  const allCourses = (ctx && ctx.courses) || readRows(SHEET.COURSES);
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
    const allVacancies = (ctx && ctx.vacancies) || readRows(SHEET.VACANCIES);
    allVacancies.forEach(function (v) {
      const sub = String(v.substitute_staff_id || '').trim();
      if (!sub) return;
      if (dateToStr_(v.date) !== target) return;
      if (slotOf[String(v.course_id).trim()] === slotKey) busy[sub] = true;
    });
  }

  const allStaffs = (ctx && ctx.staffs) || readRows(SHEET.STAFFS);
  return allStaffs
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

/**
 * 時限マスタの時刻セルを「0時からの分」に直す。読めなければ null。
 *
 * periods.start_time は **文字列（'09:15'）と Date の両方がありうる**。
 * Setup.js はテキスト書式を固定して文字列で書くが、その書式は既定の7行ぶんしか
 * 掛かっておらず（10-6 と同じパターン）、職員が8行目以降に時限を手で足すと
 * Sheets が '09:15' を時刻値として解釈し、読み戻すと Date になる。
 * 締切判定がその1点で黙って壊れる（＝常に「締切前」に倒れる）ため、両方を受ける。
 *
 * パースは Attendance.gs の既存ヘルパーを使い分ける（hhmmToMin_ / jstMinutes_）。
 */
function periodStartMinutes_(value) {
  if (value instanceof Date) return jstMinutes_(value);
  // 'HH:mm:ss' や全角コロンでも読めるように整えてから渡す
  const s = String(value == null ? '' : value)
    .replace(/：/g, ':')
    .trim()
    .replace(/^(\d{1,2}:\d{2}).*$/, '$1');
  return hhmmToMin_(s);
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

// ─── 実機e2e（Tier A・backlog 9-5）──────────────────────────────
//
// 実 LockService・実スプレッドシート（ダミーDB前提）に対して、機能Aの中核
// （欠員登録 → 候補抽出 → 先着競合 → 再オープン）を内部関数で駆動し状態を検証する。
// 公開関数（submitAbsence 等）は Session 依存で1人では役を演じ分けにくいため、
// ここでは内部関数を直接叩く（UI/ロール判定/通知配線はブラウザ walkthrough で確認する）。
// 作成した欠員は最後に削除して後片付けする（ダミーDBを汚さない）。

/**
 * 機能Aの実機e2e。GASエディタから実行しログを見る。
 * @param {{notify?:boolean}} [opts] notify=true で確定・再募集の実通知も送る（既定 false）。
 */
function e2eVacancyFlow(opts) {
  opts = opts || {};
  const notify = !!opts.notify;
  const say = function (m) { Logger.log(m); };
  const assert = function (cond, m) {
    if (!cond) throw new Error('❌ ASSERT失敗: ' + m);
    say('  ✅ ' + m);
  };

  say('===== 機能A 実機e2e（内部関数駆動・ダミーDB / 通知=' + (notify ? 'ON' : 'OFF') + '）=====');

  const courses = readRows(SHEET.COURSES);
  if (!courses.length) throw new Error('courses が空です。setupSpreadsheets を実行してください。');

  // 先着競合を実際に試すため「候補が2人以上」のコマを探す（無ければ候補最多のコマ）。
  var course = null, cands = [];
  for (var i = 0; i < courses.length; i++) {
    const c = courses[i];
    const cc = findCandidates_(c, [c.staff_a_id, c.staff_b_id]);
    if (cc.length > cands.length) { course = c; cands = cc; }
    if (cc.length >= 2) break;
  }
  course = course || courses[0];
  const courseId = String(course.course_id).trim();
  const absentId = String(course.staff_a_id).trim() || String(course.staff_b_id).trim();
  const date = nextDateForWeekday_(String(course.day).trim());
  say('対象コマ: ' + courseId + '（' + course.day + course.period + '限 / ' + course.quarter +
    ' / ' + course.user_student + '）欠勤=' + absentId + ' 対象日=' + date);

  // 欠員を登録（submitAbsence の書き込み相当）
  const vacancyId = appendRowWithId(SHEET.VACANCIES, 'vacancy_id', 'V', {
    date: date, course_id: courseId, absent_staff_id: absentId,
    notify_status: NOTIFY_STATUS_PENDING, result: '',
  });
  say('欠員登録: ' + vacancyId);

  try {
    // 候補抽出（当日分）
    const cds = findCandidates_(course, [course.staff_a_id, course.staff_b_id], date);
    say('候補: ' + (cds.length ? cds.map(function (x) { return x.staff_id + '/' + x.name; }).join('、') : 'なし'));

    if (cds.length >= 2) {
      // 先着競合：2人が同時承諾 → 実 LockService 下で1人だけ確定（D1）
      const A = String(cds[0].staff_id).trim(), B = String(cds[1].staff_id).trim();
      const r1 = tryTransitionVacancy_(vacancyId, 'settle', { result: VACANCY_RESULT.FILLED, substitute_staff_id: A });
      const r2 = tryTransitionVacancy_(vacancyId, 'settle', { result: VACANCY_RESULT.FILLED, substitute_staff_id: B });
      assert(r1.applied === true, '先着A（' + A + '）が確定');
      assert(r2.applied === false, '後着B（' + B + '）は確定不可（受付終了）');
      const v = findRow(SHEET.VACANCIES, 'vacancy_id', vacancyId);
      assert(String(v.result).trim() === VACANCY_RESULT.FILLED, 'result=補充済');
      assert(String(v.substitute_staff_id).trim() === A, '代行者=先着A（後着で上書きされない）');
      if (notify) { notifyVacancyFilled(vacancyId, A); say('  （確定通知を送信）'); }
    } else if (cds.length === 1) {
      const A2 = String(cds[0].staff_id).trim();
      const r = tryTransitionVacancy_(vacancyId, 'settle', { result: VACANCY_RESULT.FILLED, substitute_staff_id: A2 });
      assert(r.applied === true, '唯一候補A（' + A2 + '）が確定');
      if (notify) { notifyVacancyFilled(vacancyId, A2); }
    } else {
      // 候補0人 → 自動決着の分岐（相方が残るか）。ここでは相方の有無だけ確認。
      say('  候補0人。自動決着（1人テイク/職員対応）の分岐は submitAbsence 経由で確認する。');
      tryTransitionVacancy_(vacancyId, 'settle', { result: VACANCY_RESULT.STAFF, substitute_staff_id: '' });
    }

    // 再オープン（決着 → 未決着）。旧値が current から読めること。
    const re = transitionVacancyOrThrow_(vacancyId, 'reopen',
      { result: '', substitute_staff_id: '', notify_status: NOTIFY_STATUS_PENDING });
    const v2 = findRow(SHEET.VACANCIES, 'vacancy_id', vacancyId);
    assert(String(v2.result).trim() === '', '再オープンで result がクリアされる');
    assert(re.current && !!String(re.current.result).trim(), '再オープンの current から旧決着値が読める');
    if (notify) { notifyNewVacancy(vacancyId, true); say('  （再募集通知を送信）'); }

    // 二重再オープンは弾かれる（未決着への reopen は throw）
    var threw = false;
    try {
      transitionVacancyOrThrow_(vacancyId, 'reopen', { result: '' });
    } catch (e) { threw = true; }
    assert(threw, '未決着への再オープンは throw（二重再オープン防止）');

    say('===== e2e 成功：実 LockService・実 Sheets で機能A中核を確認 =====');
  } finally {
    // 後片付け：作った欠員と紐づく回答を削除
    const dv = deleteRowByKey(SHEET.VACANCIES, 'vacancy_id', vacancyId);
    const dr = deleteRowByKey(SHEET.RESPONSES, 'vacancy_id', vacancyId);
    say('後片付け: 欠員 ' + dv + ' 行 / 回答 ' + dr + ' 行を削除（' + vacancyId + '）');
  }
}

// ─── D21 実機確認用（一時的・確認できたら削除してよい）─────────
//
// 「授業開始30分前を過ぎた欠勤連絡」の挙動を実機で確認するための関数。
// 本物の授業時刻を待つのは非現実的なので、**時計ではなく授業時刻の方を動かす**：
// 一時的な時限（開始時刻＝今から+N分）を作り、その時限のコマに対して submitAbsence を実行する。
// 実行アカウント自身を担当スタッフにするので、GASエディタから1人で全経路を通せる。
//
// 作成する一時データ（すべて末尾で削除する）：
//   staffs  ZTEST1（代行候補役）/ ZTEST2（相方役）
//   periods ZT（開始時刻を書き換えながら使い回す）
//   courses ZC1（締切超過の検証）/ ZC2（締切前の検証）
//   vacancies / responses … 上記コマに紐づく行
//
// 既定では Chat を実際に送らない（スクリプトプロパティ CHAT_WEBHOOK_URL を一時的に外す）。
// 職員スペースへの実際の文面を見たい場合は e2eDeadlineFlow({notify:true}) で実行する。

/**
 * D21（代行募集の締切）の実機e2e。GASエディタから実行してログを見る。
 * @param {{notify?:boolean}} [opts] notify=true で職員スペースへ実際に通知する（既定 false）
 */
function e2eDeadlineFlow(opts) {
  opts = opts || {};
  const notify = !!opts.notify;
  const say = function (m) { Logger.log(m); };
  var pass = 0, fail = 0;
  const assert = function (cond, m) {
    if (cond) { pass++; say('  ✅ ' + m); } else { fail++; say('  ❌ ' + m); }
  };

  const me = getCurrentUser_();
  if (!me) throw new Error('実行アカウントが連絡先DB（contacts）に登録されていません。先に登録してください。');

  const now = new Date();
  const today = Utilities.formatDate(now, 'Asia/Tokyo', 'yyyy-MM-dd');
  const hourNow = Number(Utilities.formatDate(now, 'Asia/Tokyo', 'HH'));
  if (hourNow < 2 || hourNow >= 21) {
    throw new Error('この確認は 02:00〜21:00 の間に実行してください（前後の時刻が日付をまたぐと判定が意味を持たないため）。');
  }

  const dayJp = weekdayOf_(today);
  const TEST_Q = '__TEST_D21__';
  const PERIOD = 'ZT';
  const SLOT = dayJp + PERIOD;

  // 「今から offsetMin 分後」の HH:mm
  const at = function (offsetMin) {
    return Utilities.formatDate(new Date(new Date().getTime() + offsetMin * 60000), 'Asia/Tokyo', 'HH:mm');
  };
  // 一時時限の開始時刻を書き換える（＝授業時刻を動かす）
  const setStart = function (offsetMin) {
    updateRow(SHEET.PERIODS, 'period', PERIOD, { start_time: at(offsetMin), end_time: at(offsetMin + 90) });
    return at(offsetMin);
  };

  say('===== D21 締切（授業開始' + RECRUIT_DEADLINE_MIN_BEFORE + '分前）実機e2e / 通知=' +
    (notify ? 'ON' : 'OFF') + ' =====');
  say('実行者: ' + me.name + '（' + me.staff_id + '・' + me.role + '） 対象日: ' + today + '（' + dayJp + '曜）');

  const props = PropertiesService.getScriptProperties();
  const savedWebhook = props.getProperty(PROP_STAFF_WEBHOOK);
  if (!notify && savedWebhook) props.deleteProperty(PROP_STAFF_WEBHOOK); // 実送信を止める

  try {
    // ── 一時データを作る ──
    appendRow(SHEET.PERIODS, { period: PERIOD, start_time: at(60), end_time: at(150) });
    appendRow(SHEET.STAFFS, {
      staff_id: 'ZTEST1', name: 'テスト候補', role: '学生', skills: 'テイク,介助', available_slots: SLOT,
    });
    appendRow(SHEET.STAFFS, {
      staff_id: 'ZTEST2', name: 'テスト相方', role: '学生', skills: 'テイク,介助', available_slots: '',
    });
    ['ZC1', 'ZC2'].forEach(function (cid) {
      appendRow(SHEET.COURSES, {
        course_id: cid, quarter: TEST_Q, day: dayJp, period: PERIOD,
        support_type: 'テイク', user_student: 'テスト利用学生', subject: 'D21確認用',
        staff_a_id: me.staff_id, staff_b_id: 'ZTEST2', note: '★一時データ（e2eDeadlineFlow）',
      });
    });
    say('一時データを作成（periods ' + PERIOD + ' / staffs ZTEST1・ZTEST2 / courses ZC1・ZC2）');

    // ── 0) 時刻セルの型を確認（Date化していると締切判定も時刻表示も壊れる）──
    // periods のテキスト書式が既定7行ぶんしか無かった問題（migratePeriodsTextFormat）の確認も兼ねる。
    say('--- periods の時刻セルの型 ---');
    readRows(SHEET.PERIODS).forEach(function (p) {
      const t = p.start_time;
      say('   ' + p.period + '限: ' + t + ' 〜 ' + p.end_time +
        '（型: ' + (t instanceof Date ? '⚠️Date' : typeof t) + ' → ' + periodStartMinutes_(t) + '分）');
    });

    // ── 1) 締切判定そのものを、開始時刻をずらしながら確認 ──
    say('--- 締切判定（授業開始' + RECRUIT_DEADLINE_MIN_BEFORE + '分前が締切）---');
    [-30, -5, 25, 35, 90].forEach(function (off) {
      const start = setStart(off);
      const past = isPastRecruitDeadline_(today, PERIOD);
      const expected = off < RECRUIT_DEADLINE_MIN_BEFORE; // 開始が「今+30分」より手前なら締切超過
      say('   開始 ' + start + '（今から' + (off >= 0 ? '+' : '') + off + '分）→ ' +
        (past ? '締切超過＝募集しない' : '締切前＝募集する') + (past === expected ? '' : '  ← ⚠️想定と違う'));
      assert(past === expected, '今から' + off + '分後開始 → ' + (expected ? '募集しない' : '募集する'));
    });

    // ── 2) 締切超過の欠勤連絡（授業が10分後に始まる）──
    say('--- 締切超過ケース（授業が10分後に開始）---');
    setStart(10);
    const late = submitAbsence('ZC1', today);
    say('   戻り: ' + JSON.stringify(late));
    assert(late.lateAbsence === true, '直前欠勤として扱われる（lateAbsence=true）');
    assert(late.deadlineMinutes === RECRUIT_DEADLINE_MIN_BEFORE, '締切の分数を画面へ返す');
    assert(late.candidates.length === 0, '代行候補への依頼を出さない');
    assert(late.autoResult === VACANCY_RESULT.SOLO, '相方 ZTEST2 が残るので「1人テイク」で自動決着');
    const vLate = findRow(SHEET.VACANCIES, 'vacancy_id', late.vacancy_id);
    assert(!!vLate, '欠勤の記録自体は残る（登録はさせる）');
    assert(vLate && String(vLate.result).trim() === VACANCY_RESULT.SOLO, 'シートにも決着結果が入る');

    // ── 3) 締切前の欠勤連絡（授業が90分後に始まる）──
    say('--- 締切前ケース（授業が90分後に開始）---');
    setStart(90);
    const early = submitAbsence('ZC2', today);
    say('   戻り: ' + JSON.stringify(early));
    assert(!early.lateAbsence, '従来どおり代行募集が走る（lateAbsence が立たない）');
    assert(early.candidates.length === 1 && String(early.candidates[0].staff_id).trim() === 'ZTEST1',
      '代行候補 ZTEST1 を抽出する');
    const vEarly = findRow(SHEET.VACANCIES, 'vacancy_id', early.vacancy_id);
    assert(vEarly && !String(vEarly.result).trim(), '未解決のまま（回答待ち）になる');

    say(fail === 0
      ? '===== ✅ 全' + pass + '件成功：D21 の挙動を実機で確認しました ====='
      : '===== ❌ ' + fail + '件失敗（成功 ' + pass + '件）。上のログを確認してください =====');
  } finally {
    // ── 後片付け（作った一時データを必ず消す）──
    if (!notify && savedWebhook) props.setProperty(PROP_STAFF_WEBHOOK, savedWebhook);
    var removed = [];
    ['ZC1', 'ZC2'].forEach(function (cid) {
      readRows(SHEET.VACANCIES)
        .filter(function (v) { return String(v.course_id).trim() === cid; })
        .forEach(function (v) {
          deleteRowByKey(SHEET.RESPONSES, 'vacancy_id', v.vacancy_id);
          deleteRowByKey(SHEET.VACANCIES, 'vacancy_id', v.vacancy_id);
          removed.push(v.vacancy_id);
        });
      deleteRowByKey(SHEET.COURSES, 'course_id', cid);
    });
    deleteRowByKey(SHEET.STAFFS, 'staff_id', 'ZTEST1');
    deleteRowByKey(SHEET.STAFFS, 'staff_id', 'ZTEST2');
    deleteRowByKey(SHEET.PERIODS, 'period', PERIOD);
    say('後片付け: 一時データを削除しました（欠員 ' + (removed.join('・') || 'なし') +
      ' / courses ZC1・ZC2 / staffs ZTEST1・ZTEST2 / periods ' + PERIOD + '）');
    say('   ※ 残っていたら、上記のIDでシートから手動削除してください。');
  }
}

// 指定曜日（月〜日）の直近の未来日（明日以降）を 'yyyy-MM-dd' で返す。過去日ガード回避用。
function nextDateForWeekday_(dayJp) {
  const names = ['日', '月', '火', '水', '木', '金', '土'];
  const target = names.indexOf(dayJp);
  const d = new Date();
  d.setDate(d.getDate() + 1); // 明日から探す
  for (var i = 0; i < 7; i++) {
    if (target === -1 || d.getDay() === target) break;
    d.setDate(d.getDate() + 1);
  }
  return Utilities.formatDate(d, 'Asia/Tokyo', 'yyyy-MM-dd');
}
