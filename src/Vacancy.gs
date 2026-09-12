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

  // 単発コマ（D27）は学期の「現在」判定に載せない。学期外の説明会などもありうるため、
  // 「実施日が今日以降か」だけで出す。毎週のコマは従来どおり現在の学期で絞る。
  const today = todayJst_();
  return allCourses
    .filter(function (c) {
      if (!isAssigned_(c, user.staff_id)) return false;
      const d = courseDate_(c);
      if (d) return d >= today;
      return !!activeSet[String(c.quarter).trim()];
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
        oneOffDate: courseDate_(c),      // 単発コマの実施日（空＝毎週・D27）
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

  // 単発コマ（D27）はその日1回しか無いので、実施日と一致するかだけを見る。
  // 学期の開講期間チェックはしない（学期外の説明会・行事もありうるため）。
  const oneOffDate = courseDate_(course);
  if (oneOffDate) {
    if (dateStr !== oneOffDate) {
      throw new Error('このコマは ' + oneOffDate + ' の1回限りです（指定：' + dateStr + '）。');
    }
  } else {
    // 毎週のコマ：欠勤日はコマの学期（terms）の開講期間内であること。
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

  // 代行を募集せずに閉じる共通処理（候補0人・締切超過の両方から使う）。
  //
  // D22 でここは「自動決着」から「募集クローズ」に変わった。**result は書かない**。
  // 1人テイクで回すか職員が入るかは人員配置の判断であり、システムには決められない。
  // result を書いてしまうと欠員一覧から落ち、最も人手を要する欠員が最も見えなくなる。
  // システムがやるのは「募集しないと決めたことを記録し、職員へ決着を要求する」ところまで。
  const closeRecruitWithoutSubstitute_ = function (reason) {
    // 職員が決着させるときの手がかり（相方が残るか）。あくまで提案で、書き込みはしない。
    const suggestion = suggestSettleResult_(course, dateStr, user.staff_id);
    // 締切到達を処理済みとしてマークし、時間トリガーが同じ欠員をもう一度拾わないようにする。
    try {
      updateRow(SHEET.VACANCIES, 'vacancy_id', vacancyId, { close_notified_at: nowString_() });
    } catch (e) { /* マークに失敗してもトリガー側が拾い直すだけなので握りつぶす */ }
    var closeNotify;
    try {
      closeNotify = notifyRecruitClosed(vacancyId, reason, suggestion);
    } catch (e) {
      closeNotify = { error: e.message };
    }
    return {
      vacancy_id: vacancyId,
      course: courseInfo,
      candidates: [],
      recruitClosed: true,
      closeReason: reason,
      suggestion: suggestion,
      notify: closeNotify,
    };
  };

  // 締切超過（授業開始 RECRUIT_DEADLINE_MIN_BEFORE 分前を過ぎている）→ 直前欠勤。
  // 欠勤の記録は残すが、間に合わない代行依頼は候補へ送らない（requirements §8・運用決定）。
  // 職員スペースには「直前欠勤（代行募集なし）」を通知し、画面では学生に
  // Google Classroom への欠勤連絡を案内する（従来の人力フローへ戻す）。
  if (isPastRecruitDeadline_(dateStr, course.period)) {
    const late = closeRecruitWithoutSubstitute_(RECRUIT_CLOSE_REASON.PAST_DEADLINE);
    late.lateAbsence = true;
    late.deadlineMinutes = RECRUIT_DEADLINE_MIN_BEFORE;
    return late;
  }

  // 代行候補を抽出（欠勤者と相方＋当日のダブルブッキングを除外）
  const candidates = findCandidates_(course, [course.staff_a_id, course.staff_b_id], dateStr);

  // 補充候補が0人 → 募集せずに閉じ、職員へ決着を要求する（review #4・D22）。
  // 以前はここで「1人テイク／職員対応」まで自動で書き込んでいた（D10）が、その判断は職員が行う。
  if (candidates.length === 0) {
    return closeRecruitWithoutSubstitute_(RECRUIT_CLOSE_REASON.NO_CANDIDATES);
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
    deadlineClosed: course ? isRecruitClosed_(vacancy, course) : false, // 締切で募集終了（D22）
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

  // 締切（授業開始 RECRUIT_DEADLINE_MIN_BEFORE 分前）を過ぎた募集は受け付けない（D22）。
  // ここを開けたままにすると、職員が決着に動き出した後に承諾が入って二重手配になる。
  // 「他の人で埋まった」とは理由が違うので、画面の文言も分ける（deadline フラグ）。
  if (isRecruitClosed_(vacancy, course)) {
    return { ok: false, closed: true, deadline: true, message: MSG_RECRUIT_CLOSED };
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
 * この欠員の代行募集が「クローズ済み」か（D22）。
 *
 * クローズ状態は**保存しない**。締切そのものと同じく date + periods.start_time から毎回算出する
 * （isPastRecruitDeadline_ と同じ理由：定数を変えたときに既存の欠員へも即反映される）。
 * シートに保存するのは close_notified_at＝「締切到達を処理して職員へ通知したか」だけで、
 * これは状態ではなく副作用の記録（二重通知の防止）。
 *
 * 「決着済み（result あり）」とは別物。クローズ済みかつ未決着＝**職員の決着待ち**で、
 * これが manage 画面で最優先に見せるべき状態になる。
 *
 * @param {Object} vacancy vacancies の1行
 * @param {Object} course  対応する courses の1行（無ければ判定不能として false）
 * @return {boolean}
 */
function isRecruitClosed_(vacancy, course) {
  if (!vacancy || !course) return false;
  if (String(vacancy.result || '').trim()) return false;   // 決着済みは「募集中/クローズ」の軸の外
  return isPastRecruitDeadline_(dateToStr_(vacancy.date), course.period);
}

/**
 * 代行者なしで閉じた欠員について、職員へ示す**決着の提案**を組み立てる（D22）。
 *
 * 欠勤者本人と、同コマ・同日に既に欠勤登録している人（相方も欠勤しているケース）を除いて、
 * 担当が残るなら「1人テイク」、誰も残らないなら「職員対応」。
 *
 * ※ D22 以前はこの戻り値をそのまま `result` に書き込んで自動決着させていた（autoSettleResult_）。
 *   現在は**書き込まない**。相方が残るかどうかは分かるが、その日を実際に1人で回してよいかは
 *   人員配置の判断であり、システムには決められない。職員が manage 画面で決める際の
 *   手がかりとして、通知文面と管理画面に「〜が妥当そう」と添えるだけに留める。
 *
 * 補充候補0人のとき・締切超過の直前欠勤のとき・募集中に締切へ到達したときの**3経路**から使う。
 *
 * @param {Object} course
 * @param {string} dateStr        'yyyy-MM-dd'
 * @param {string} absentStaffId  欠勤者
 * @return {string} VACANCY_RESULT.SOLO / VACANCY_RESULT.STAFF
 */
function suggestSettleResult_(course, dateStr, absentStaffId) {
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

    // 募集がクローズ済みで未決着＝**職員の決着待ち**（D22）。この画面で最優先に見せる状態。
    // システムは result を書かないので、放っておくと誰も動かないまま授業開始を迎える。
    const closed = !resolved && isRecruitClosed_(v, course);

    // 未解決のみ、電話フロー用に「候補（空きコマ学生）＋電話＋回答状況」を付ける。
    // 返信が来ないとき、職員がこの電話番号に直接連絡して口頭で決めるための導線。
    var candidates = [];
    if (!resolved && String(course.course_id || '').trim()) {
      candidates = findCandidates_(course, [course.staff_a_id, course.staff_b_id], v.date, ctx)
        .map(function (cand) {
          const sid = String(cand.staff_id).trim();
          const answer = (answerByVacancy[vid] && answerByVacancy[vid][sid]) || '';
          return {
            staff_id: cand.staff_id,
            name: cand.name,
            // 辞退した候補には電話番号を出さない（e2eテストでの指摘）。
            // 全員に番号が並んでいると「まだ反応していないのは誰か」が読めず、
            // 断った相手にもう一度かけてしまう。電話をかける先＝未回答の候補だけに絞る。
            phone: answer === ANSWER.DECLINE ? '' : (phoneById[sid] || ''),
            answer: answer,
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
      // 募集は終わったが決着していない（＝職員が「1人テイク／職員対応」を決める番）
      awaitingDecision: closed,
      // 決着の手がかり（相方が残るか）。提案であって、システムは書き込まない（D22）
      suggestion: closed
        ? suggestSettleResult_(course, dateToStr_(v.date), String(v.absent_staff_id).trim())
        : '',
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

  // 締切を過ぎてから開き直すのか、まだ募集できる時間帯なのかで挙動が変わる（D22）。
  // 判定に使うコマは、reopen の書き込み前に引いておく（ロックの中で別シートを読まない）。
  const cur = findRow(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  const curCourse = cur ? findRow(SHEET.COURSES, 'course_id', cur.course_id) : null;
  const pastDeadline = cur && curCourse
    ? isPastRecruitDeadline_(dateToStr_(cur.date), curCourse.period)
    : false;

  // result が非空（決着済み）のときだけ atomically 開き直す（reopen 遷移）。
  // 「旧確定者の控え」と「クリア」を同一ロックで行い、確定処理との競合で
  // 解除通知の宛先がずれるのを防ぐ（backlog 10-1）。旧値は current（書き込み前）から読む。
  //
  // 締切前に戻すなら close_notified_at も消す（もう一度きちんと募集し、締切に達したら
  // 改めて職員へ決着を要求できる状態に戻す）。締切後の再オープンでは消さない
  // ＝トリガーが同じ欠員を拾って職員へ二度目の「決着してください」を投げるのを防ぐ。
  const updates = { result: '', substitute_staff_id: '', notify_status: NOTIFY_STATUS_PENDING };
  if (!pastDeadline) updates.close_notified_at = '';
  const res = transitionVacancyOrThrow_(vacancyId, 'reopen', updates);

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
  //
  // ただし締切を過ぎているなら再募集はしない（D22）。respondToVacancy が締切超過の回答を
  // 弾くため、依頼を送っても候補は答えられず「押せないボタン」を配るだけになる。
  // この場合の再オープンは「職員が決着をやり直すために開く」操作として扱う。
  var reNotify = null;
  if (pastDeadline) {
    reNotify = { skipped: true, reason: '締切を過ぎているため再募集は行いません（職員が決着します）。' };
  } else {
    try {
      reNotify = notifyNewVacancy(vacancyId, true);
    } catch (e) {
      reNotify = { error: e.message };
    }
  }
  return { ok: true, pastDeadline: pastDeadline, notify: { released: released, reopened: reNotify } };
}

// ─── 締切到達の検知（時間トリガー・D22）───────────────────────

/**
 * 締切に到達した代行募集をクローズし、職員へ決着を要求する（時間トリガーの入口）。
 *
 * **この関数は result を書かない。** 締切（授業開始 RECRUIT_DEADLINE_MIN_BEFORE 分前）に
 * 達したら募集を閉じる＝もう候補は増えない、というところまでがシステムの責務で、
 * 「1人テイクで回すのか職員が入るのか」は人員配置の判断なので職員が manage 画面で決める（D22）。
 *
 * なぜトリガーが要るか：締切判定は従来 submitAbsence の1回しか走らなかったため、
 * 「締切前に登録され、誰も承諾しないまま締切に達した」欠員を閉じる契機が存在しなかった。
 * 補充できずに当日を迎える欠員こそ職員が最も早く知る必要があるのに、通知が一切出なかった。
 *
 * 二重通知の防止：close_notified_at が空のときだけ処理者になる（claimIfEmpty の CAS）。
 * マークしてから通知するので、通知の途中で実行が落ちたときは「通知が届かない」側に倒れる。
 * 逆順（通知→マーク）にすると落ちるたびに全員へ再送されるため、こちらを選ぶ。
 *
 * @param {boolean} [verbose] true のときだけログを出す（GASエディタから手で実行するとき用）。
 *   時間トリガーは第1引数にイベントオブジェクトを渡してくるため、=== true で厳密に判定する。
 * @param {Array<string>} [onlyVacancyIds] 対象をこの欠員IDだけに限定する（e2e 検証用）。
 *   省略時は全欠員を走査する＝トリガーからの通常動作。テストが実データの欠員を
 *   「通知済み」にしてしまわないよう、e2e からは必ず指定する。
 * @return {{scanned:number, notified:Array, marked:Array, errors:Array}}
 */
function closeExpiredRecruits(verbose, onlyVacancyIds) {
  const out = { scanned: 0, notified: [], marked: [], errors: [] };
  const say = function (m) { if (verbose === true) Logger.log(m); };
  const only = onlyVacancyIds
    ? onlyVacancyIds.map(function (x) { return String(x).trim(); })
    : null;

  // close_notified_at 列が無いDB（マイグレーション未実行）では CAS のガード列が引けない。
  // 例外で落ちるとトリガーの失敗メールが毎回飛ぶだけなので、理由を出して静かに戻る。
  if (getHeaders_(SHEET.VACANCIES).indexOf('close_notified_at') === -1) {
    const msg = 'vacancies に close_notified_at 列がありません。' +
      'Setup.js の migrateAddVacancyCloseNotifiedAt() を1回実行してください。';
    out.errors.push(msg);
    say('❌ ' + msg);
    return out;
  }

  const today = todayJst_();
  const courseById = {};
  readRows(SHEET.COURSES).forEach(function (c) {
    courseById[String(c.course_id).trim()] = c;
  });

  readRows(SHEET.VACANCIES).forEach(function (v) {
    const vid = String(v.vacancy_id).trim();
    if (!vid) return;
    if (only && only.indexOf(vid) === -1) return;             // e2e で対象を限定しているとき
    if (String(v.result || '').trim()) return;                // 決着済み（募集の軸の外）
    if (String(v.close_notified_at || '').trim()) return;     // この欠員は処理済み
    const course = courseById[String(v.course_id).trim()];
    if (!course) return;                                      // コマが消えている＝判定不能
    const dateStr = dateToStr_(v.date);
    if (!isPastRecruitDeadline_(dateStr, course.period)) return; // まだ募集中
    out.scanned++;

    const claim = claimIfEmpty(SHEET.VACANCIES, 'vacancy_id', vid, 'close_notified_at',
      { close_notified_at: nowString_() });
    if (!claim.ok || !claim.claimed) return;  // 別の実行が先に処理した

    // 導入前から未決着で残っている過去日の欠員は、マークするだけで通知しない。
    // 初回実行で古い欠員ぶんの通知が一斉に流れるのを防ぐ（授業はもう終わっている）。
    if (dateStr && dateStr < today) {
      out.marked.push(vid);
      say('・' + vid + '（' + dateStr + '）は過去日のため通知せずマークのみ');
      return;
    }

    try {
      notifyRecruitClosed(vid, RECRUIT_CLOSE_REASON.DEADLINE_REACHED,
        suggestSettleResult_(course, dateStr, String(v.absent_staff_id).trim()));
      out.notified.push(vid);
      say('・' + vid + '（' + dateStr + ' ' + course.day + course.period + '限）の募集をクローズ、職員へ通知');
    } catch (e) {
      out.errors.push(vid + ': ' + e.message);
      say('・' + vid + ' の通知に失敗: ' + e.message);
    }
  });

  say('締切チェック完了: 対象 ' + out.scanned + '件 / 通知 ' + out.notified.length +
    '件 / 過去分マーク ' + out.marked.length + '件 / エラー ' + out.errors.length + '件');
  return out;
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
    // 単発コマ（date あり）は、同じ曜日・時限でも別の日なら競合しない（D27）
    if (cid !== courseId &&
        String(c.quarter).trim() === quarter &&
        slotOf[cid] === slotKey &&
        occurrencesOverlap_(courseDate_(course), courseDate_(c))) {
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
function courseDate_(course) {
  // セルがテキスト書式でないシートでは '2026-09-12' が**日付値**として保存され、
  // readRows が Date を返す。生の String() を掛けると
  // 'Sat Sep 12 2026 00:00:00 GMT+0900 (Japan Standard Time)' になり、
  // 時間割の照合（date === oneOffDate）が絶対に一致せず**そのコマが消える**。
  // エラーにならないので気づけない。10-6b（periods の時刻）と同じパターンなので、
  // 同じく「読む側で吸収する」形にしておく（dateToStr_ は Date も ISO 文字列も受ける）。
  if (!course || course.date === '' || course.date == null) return '';
  return dateToStr_(course.date).trim();
}

/**
 * 2つのコマの「開催回」が重なりうるか（D27・単発コマ）。
 *
 * courses は本来「毎週その曜日・その時限」の週パターンだが、date 列が入っていると
 * **その日1回だけ**の単発コマになる。同じ曜日・時限でも、別の日付の単発同士は
 * 実際には一度もぶつからない。二重起用チェックと候補抽出の busy 判定で、
 * これを取り違えると「ぶつかっていないのに登録できない／候補から外れる」が起きる。
 *
 *   毎週 × 毎週   → 毎週ぶつかる         → true
 *   毎週 × 単発   → その単発の日にぶつかる → true
 *   単発 × 単発   → 同じ日付のときだけ     → date が一致すれば true
 *
 * @param {string} dateA 空＝毎週 / 'yyyy-MM-dd'＝単発
 * @param {string} dateB 同上
 */
function occurrencesOverlap_(dateA, dateB) {
  const a = String(dateA || '').trim();
  const b = String(dateB || '').trim();
  if (a && b) return a === b;
  return true;   // 片方でも毎週なら必ず重なる
}

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
