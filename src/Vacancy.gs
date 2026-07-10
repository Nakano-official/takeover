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

  return allCourses
    .filter(function (c) {
      return activeSet[String(c.quarter).trim()] && isAssigned_(c, user.staff_id);
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
    const autoResult = remaining.length > 0 ? VACANCY_RESULT.SOLO : VACANCY_RESULT.STAFF;
    // 決着書き込みは状態機械（settle 遷移）に通す。作成直後で競合は無いが、
    // 全ての result 書き込みを1経路に揃える（backlog 11-2）。
    transitionVacancyOrThrow_(vacancyId, 'settle', { result: autoResult });

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
