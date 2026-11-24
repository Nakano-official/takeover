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
  const user = getOpenUser_();
  if (!user) throw new Error('利用登録がありません。');

  const nameById = buildNameMap_();
  const periodById = buildPeriodMap_();

  // 現在の学期に限定する（過去学期の古いコマは選択肢に出さない・review #3）。
  // 「過去分は削除しない」方針のため courses には旧学期が累積している。
  // 学期は term マスタで解決する（今日を含む学期の集合・11-3/D16）。
  // 先端理工のクォーターと他学部のセメスターが同時に走るため「現在」は集合になりうる。
  const allCourses = readRows_(SHEET.COURSES);
  const courseTermIds = [];
  allCourses.forEach(function (c) {
    const q = String(c.quarter).trim();
    if (q && courseTermIds.indexOf(q) === -1) courseTermIds.push(q);
  });
  const activeSet = {};
  activeTermIds_(courseTermIds).forEach(function (id) { activeSet[id] = true; });

  // 曜日ごとの学期の範囲と授業の無い日（D53）。欠勤日の選択肢を「授業のある日」に限るため画面へ渡す
  const cal = classCalendar_();

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
      const range = termRangeOn_(cal, c.quarter, String(c.day).trim()) || {};
      return {
        course_id: c.course_id,
        quarter: c.quarter,
        day: c.day,
        period: String(c.period).trim(),
      periodLabel: periodLabelOf_(c.period, p),
        time: courseTimeText_(c, periodById),     // 移動の印があれば移動を含む勤務時間（D58）
        // 登録前の確認に出す（issue #54）。自分の担当のコマなので、シフト確認で見えている範囲と同じ
        support_type: String(c.support_type || '').trim(),
        user_student: String(c.user_student || '').trim(),
        subject: String(c.subject || '').trim(),
        room: String(c.room || '').trim(),
        partner: nameById[String(partnerId).trim()] || partnerId || '',
        oneOffDate: courseDate_(c),      // 単発コマの実施日（空＝毎週・D27）
        // このコマにくっついている移動介助のうち、**自分が担当のもの**（D45）。
        // 欠勤するとこれも一緒に休むことになるので、画面で見せて確認させる。
        attached: absenceBlockOf_(c, user.staff_id, '')
          .filter(function (x) { return String(x.course_id).trim() !== String(c.course_id).trim(); })
          .map(labelOfCourse_),
        termStart: range.start || '',
        termEnd: range.end || '',
        // 範囲の中で授業の無い日（祝日・全学休講・この時限が休みの日）。選択肢から外す
        skipDates: Object.keys(cal.noClass).filter(function (d) {
          return range.start && d >= range.start && d <= range.end && weekdayOf_(d) === String(c.day).trim()
            && isNoClassAt_(cal.noClass, d, c.period);
        }).concat(cancelledDatesOf_(cal, c.course_id)),
        // 個別の休講（D60）の日だけ。単発コマはこれだけを見る（issue #49）。
        // skipDates には全学の授業の無い日も入るが、単発コマ（補講・行事）はその日にも行うことがある
        cancelledDates: cancelledDatesOf_(cal, c.course_id),
      };
    });
}

/**
 * 欠勤を登録し、代行候補を抽出して返す。
 * @param {string} courseId 欠勤するコマ
 * @param {string} date     欠勤日（YYYY-MM-DD）
 * @return {{vacancy_id:string, course:Object, candidates:Array}}
 */
function submitAbsence(courseId, date, includeAttached) {
  const user = getOpenUser_();
  if (!user) throw new Error('利用登録がありません。');

  const course = findRow_(SHEET.COURSES, 'course_id', courseId);
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
  // 学期の開講期間・授業の無い日は見ない（学期外の説明会・行事もありうるため）。
  // ただし個別の休講（D60）は見る。休講の日に欠勤を出すと、要らない代行募集が動く（issue #45）
  const oneOffDate = courseDate_(course);
  if (oneOffDate) {
    if (dateStr !== oneOffDate) {
      throw new Error('このコマは ' + oneOffDate + ' の1回限りです（指定：' + dateStr + '）。');
    }
    const cancelled = cancelledNotice_(course, dateStr);
    if (cancelled) throw new Error(cancelled + '欠勤の連絡は要りません。');
  } else {
    // 毎週のコマ：その日に授業が実際にあること（D53）。曜日ごとの学期の範囲（クォーターの境目）と、
    // 授業の無い日（祝日・全学休講・〇講時以降休講）を見る。学期の日付が未設定ならスキップ（後方互換）。
    const held = courseHeldOn_(course, dateStr, classCalendar_());
    if (!held.held) {
      throw new Error('欠勤日（' + dateStr + '）は、' + held.reason + '。授業のある日を選んでください。');
    }
  }

  // 欠勤のかたまり（D45）。介助の担当が休むと、授業だけでなく前後の移動介助も
  // 同じ人の欠員になる。**募集は1本**にして、通知1通・承諾1回で全部確定させる。
  // includeAttached を false にすれば従来どおり1コマだけ出せる（移動だけ休む等）。
  const block = (includeAttached === false)
    ? [course]
    : absenceBlockOf_(course, user.staff_id, dateStr);

  // 二重登録の防止（同じ人・同じコマ・同じ日で未解決の欠員が既にある）。
  // かたまりのうち1つでも既に出ていれば止める（部分的に重なった登録を作らない）。
  const open = readRows_(SHEET.VACANCIES).filter(function (v) {
    return dateToStr_(v.date) === dateStr &&
           String(v.absent_staff_id).trim() === user.staff_id &&
           !String(v.result).trim();
  });
  const already = block.filter(function (c) {
    return open.some(function (v) {
      return String(v.course_id).trim() === String(c.course_id).trim();
    });
  });
  if (already.length > 0) {
    throw new Error('この日の「' + labelOfCourse_(already[0]) + '」の欠勤は既に登録されています。');
  }

  // 欠員を登録する。2件以上なら group_id で束ね、1件なら空のまま（従来と同じ形）。
  const groupId = block.length > 1 ? 'G' + nowString_().replace(/[^0-9]/g, '') : '';
  const vacancyIds = block.map(function (c) {
    return appendRowWithId_(SHEET.VACANCIES, 'vacancy_id', 'V', {
      date: dateStr,
      course_id: String(c.course_id).trim(),
      absent_staff_id: user.staff_id,
      notify_status: NOTIFY_STATUS_PENDING,
      result: '',
      group_id: groupId,
    });
  });
  // 通知・回答の入口になる代表の欠員（かたまりの中心＝授業そのもの）
  const vacancyId = vacancyIds[block.indexOf(course)];

  const courseInfo = {
    course_id: course.course_id,
    day: course.day,
    period: String(course.period).trim(),
    periodLabel: periodLabelOf_(course.period, buildPeriodMap_()[String(course.period).trim()]),
    block: block.map(labelOfCourse_),
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
      vacancyIds.forEach(function (id) {
        updateRow_(SHEET.VACANCIES, 'vacancy_id', id, { close_notified_at: nowString_() });
      });
    } catch (e) { /* マークに失敗してもトリガー側が拾い直すだけなので握りつぶす */ }
    var closeNotify;
    try {
      closeNotify = notifyRecruitClosed_(vacancyId, reason, suggestion);
    } catch (e) {
      closeNotify = { error: e.message };
    }
    return {
      vacancy_id: vacancyId,
      vacancy_ids: vacancyIds,
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
  if (isPastRecruitDeadline_(dateStr, course)) {
    const late = closeRecruitWithoutSubstitute_(RECRUIT_CLOSE_REASON.PAST_DEADLINE);
    late.lateAbsence = true;
    late.deadlineMinutes = RECRUIT_DEADLINE_MIN_BEFORE;
    return late;
  }

  // 代行候補を抽出（欠勤者と相方＋当日のダブルブッキングを除外）。
  // かたまりのときは**すべての枠に空きがある人だけ**（D45）。1枠でも空いていない人は
  // 一部しか受けられず、「その人じゃないと頼めない」という業務の形に合わない。
  const candidates = findCandidatesForBlock_(
    block, [course.staff_a_id, course.staff_b_id], dateStr);

  // 補充候補が0人 → 募集せずに閉じ、職員へ決着を要求する（review #4・D22）。
  // 以前はここで「1人テイク／職員対応」まで自動で書き込んでいた（D10）が、その判断は職員が行う。
  if (candidates.length === 0) {
    return closeRecruitWithoutSubstitute_(RECRUIT_CLOSE_REASON.NO_CANDIDATES);
  }

  // 職員スペース＋候補者へ通知（失敗しても欠員登録は確定させる）
  var notify;
  try {
    notify = notifyNewVacancy_(vacancyId);
  } catch (e) {
    notify = { error: e.message };
  }

  return {
    vacancy_id: vacancyId,
    vacancy_ids: vacancyIds,
    course: courseInfo,
    candidates: candidates,
    notify: notify,
  };
}

/** コマ1件の呼び名（例：月2限 / 月移動介助）。画面と通知で同じ言い方に揃える */
function labelOfCourse_(course) {
  if (!course) return '';
  const p = buildPeriodMap_()[String(course.period).trim()];
  return String(course.day).trim() + periodLabelOf_(course.period, p);
}

// ─── 回答フロー（respond画面用）────────────────────────────

/**
 * 回答画面に表示する欠員情報を返す。ログインユーザーが候補かどうかも返す。
 * @param {string} vacancyId
 */
function getVacancyForRespond(vacancyId) {
  const user = getOpenUser_();
  if (!user) throw new Error('利用登録がありません。');

  const vacancy = findRow_(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  if (!vacancy) throw new Error('対象の欠員が見つかりません。');

  const course = findRow_(SHEET.COURSES, 'course_id', vacancy.course_id);
  const nameById = buildNameMap_();
  const periodById = buildPeriodMap_();
  const p = course ? (periodById[String(course.period).trim()] || {}) : {};

  // 自分の既存回答
  const mine = readRows_(SHEET.RESPONSES).filter(function (r) {
    return String(r.vacancy_id).trim() === String(vacancyId).trim() &&
           String(r.staff_id).trim() === user.staff_id;
  });

  return {
    vacancy_id: vacancyId,
    date: dateToStr_(vacancy.date),   // Date型のまま返すと google.script.run で null になるため文字列化
    day: course ? course.day : '',
    period: course ? String(course.period).trim() : '',
    periodLabel: course
      ? periodLabelOf_(course.period, buildPeriodMap_()[String(course.period).trim()]) : '',
    time: courseTimeText_(course),   // 移動を含む勤務時間（D58）
    // 判断に要るコマの情報（issue #53）。欠員一覧（getOpenVacancies）と同じ範囲。Chat の通知には入れない
    support_type: course ? String(course.support_type || '').trim() : '',
    user_student: course ? String(course.user_student || '').trim() : '',
    subject: course ? String(course.subject || '').trim() : '',
    room: course ? String(course.room || '').trim() : '',
    // かたまり（D45）で一緒に引き受ける、ほかの枠（承諾するとまとめて確定する）
    together: vacancyGroupOf_(vacancy).filter(function (v) {
      return String(v.vacancy_id).trim() !== String(vacancyId).trim() && !String(v.result || '').trim();
    }).map(function (v) {
      const c = findRow_(SHEET.COURSES, 'course_id', v.course_id);
      return c ? labelOfCourse_(c) : '';
    }).filter(Boolean),
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
 *             同時承諾は claimIfEmpty_（LockService内の compare-and-set）で1人だけが確保。
 *  - 「辞退」: 記録のみ。欠員は開いたまま。
 * 回答者は Session から特定するため、URLのvacancy_idだけでは他人になりすませない。
 *
 * @return 次のいずれか：
 *   {ok:true,  answer:'承諾', confirmed:true,  notify} … 自分に確定
 *   {ok:true,  answer:'辞退', confirmed:false}        … 辞退を記録
 *   {ok:false, filled:true,   closed:true}            … 既に他の人で埋まった（受付終了）
 */
function respondToVacancy(vacancyId, answer) {
  const user = getOpenUser_();
  if (!user) throw new Error('利用登録がありません。');
  if (answer !== ANSWER.ACCEPT && answer !== ANSWER.DECLINE) throw new Error('回答内容が不正です。');

  const vacancy = findRow_(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  if (!vacancy) throw new Error('対象の欠員が見つかりません。');

  // 対象日を過ぎた募集には回答不可（古いリンクからの後日承諾を弾く・backlog 10-9）。
  // 作成側 submitAbsence にしか過去日拒否が無かった非対称を是正する。
  assertVacancyNotPast_(vacancy.date);

  const course = findRow_(SHEET.COURSES, 'course_id', vacancy.course_id);
  if (!course) throw new Error('対象のコマが見つかりません。');

  // 候補資格チェック（候補以外は回答不可）
  if (!isCandidate_(course, user.staff_id, vacancy.date)) {
    throw new Error('あなたはこの欠員の代行候補ではありません。');
  }

  // 早期判定：既に確定済みなら受け付けない（権威ある判定は後段の claimIfEmpty_）
  if (String(vacancy.result).trim()) {
    return { ok: false, filled: true, closed: true };
  }

  // 締切（授業開始 RECRUIT_DEADLINE_MIN_BEFORE 分前）を過ぎた募集は受け付けない（D22）。
  // ここを開けたままにすると、職員が決着に動き出した後に承諾が入って二重手配になる。
  // 「他の人で埋まった」とは理由が違うので、画面の文言も分ける（deadline フラグ）。
  if (isRecruitClosed_(vacancy, course)) {
    return { ok: false, closed: true, deadline: true, message: MSG_RECRUIT_CLOSED };
  }

  // 休講の日の欠員には代行を確定させない（issue #46）。ふだんは休講で「休講」に決着して上で弾かれるが、
  // 経路の漏れで開いたままでも、ここで止める
  const cancelled = cancelledNotice_(course, dateToStr_(vacancy.date));
  if (cancelled) throw new Error(cancelled + '代行は要りません。');

  // 回答そのものは記録しておく（先着で負けても「承諾した事実」はログに残す）
  upsertRow_(
    SHEET.RESPONSES,
    { vacancy_id: vacancyId, staff_id: user.staff_id },
    { answer: answer, answered_at: nowString_() }
  );

  // 辞退は確定処理を動かさない
  if (answer === ANSWER.DECLINE) {
    return { ok: true, answer: answer, confirmed: false };
  }

  // 承諾 → 先着確保（かたまりごと・通知まで）
  const settled = settleBlockFor_(vacancy, user.staff_id);
  if (!settled.ok) return settled;   // 一瞬差で他の人に確定された → 受付終了
  return {
    ok: true, answer: answer, confirmed: true,
    also_confirmed: settled.also_confirmed,
    notify: settled.notify,
  };
}

/**
 * 欠員を staffId の代行として**先着で**確定し、関係者へ通知する。
 * 代行依頼への承諾（respondToVacancy）と、自分から入る（claimVacancy・D50）の共通部分。
 *
 * result が空のときだけ書く（settle 遷移・CAS）。throwしない低レベル版を使い、
 * 負けたら「埋まりました」を穏当に返す。
 *
 * かたまり（D45）のときは**まとめて確定させる**。授業と前後の移動介助は同じ人の仕事で、
 * 別々の人が受けると引き継ぎが成立しない。代表の欠員を先に確保してから残りを埋める。
 *
 * @return {{ok:false, filled:true, closed:true}|{ok:true, also_confirmed:Array, notify:Object}}
 */
function settleBlockFor_(vacancy, staffId) {
  const vacancyId = String(vacancy.vacancy_id).trim();
  const updates = { result: VACANCY_RESULT.FILLED, substitute_staff_id: staffId };

  const claim = tryTransitionVacancy_(vacancyId, 'settle', updates);
  if (!claim.ok) throw new Error('対象の欠員が見つかりません。');
  if (!claim.applied) return { ok: false, filled: true, closed: true };

  // 同じかたまりの残りも同じ人で確定する。代表を取れた時点でこの人に決まっているので、
  // ここは競合しない（取れなかった枠があれば、その枠だけ職員の決着に回る）。
  const groupIds = [];
  vacancyGroupOf_(vacancy).forEach(function (v) {
    const id = String(v.vacancy_id).trim();
    if (id === vacancyId) return;
    const more = tryTransitionVacancy_(id, 'settle', updates);
    if (more.ok && more.applied) groupIds.push(id);
  });

  // 確定できた → 関係者へ通知（通知失敗でも確定は確定）
  var notify;
  try {
    notify = notifyVacancyFilled_(vacancyId, staffId);
  } catch (e) {
    notify = { error: e.message };
  }
  return { ok: true, also_confirmed: groupIds, notify: notify };   // also_confirmed＝前後の移動介助（D45）
}

// ─── 自分から代行に入る（シフト表・欠員一覧・D50）────────────
//
// 代行依頼の通知は「空きコマを登録している人」にしか届かない（findCandidates_）。
// その日たまたま空いている学生スタッフも入れるように、シフト表の赤いコマと欠員一覧から
// **自分で手を挙げて先着で確定**できるようにする。確定の仕組みは承諾と同じ（settleBlockFor_）。
//
// 代行候補との違いは**空きコマ登録を見ないことだけ**。それ以外は同じ条件で弾く：
//   学生であること／自分の担当コマでないこと（欠勤者・相方）／スキル（D9）／
//   同じ時限に他の担当・代行が無いこと／締切（D21・D22）／対象日を過ぎていないこと。
// かたまり（D45）は**全部の枠で**この条件を満たす人だけが入れる（一部だけ受けられないため）。
// 空きコマを見ない代わりに、画面では「この時間に授業などの予定が無いか」を確認させる。

/**
 * staff がこの欠員（かたまりごと）に自分から入れるか。
 * @param {Object} vacancy vacancies の1行
 * @param {Object} staff   staffs の1行（本人）
 * @param {Object} [ctx]   {courses, vacancies, staffs}（一覧で何件も判定するとき用）
 * @return {string} 入れるなら ''、入れないならその理由（画面にそのまま出す）
 */
function selfClaimBlocker_(vacancy, staff, ctx) {
  if (!staff) return '利用登録がありません。';
  if (String(staff.role).trim() !== '学生') return '代行に入れるのは学生スタッフだけです。';
  if (String(vacancy.result || '').trim()) return 'この欠員はすでに対応が決まっています。';
  const dateStr = dateToStr_(vacancy.date);
  if (dateStr < todayJst_()) return 'この欠員は対象日を過ぎています。';

  const staffId = String(staff.staff_id).trim();
  const allCourses = (ctx && ctx.courses) || readRows_(SHEET.COURSES);
  const courseById = {};
  allCourses.forEach(function (c) { courseById[String(c.course_id).trim()] = c; });

  // かたまりのうち、まだ決まっていない枠すべて（代表を含む）
  const gid = String(vacancy.group_id || '').trim();
  const open = (gid
    ? ((ctx && ctx.vacancies) || readRows_(SHEET.VACANCIES)).filter(function (v) {
      return String(v.group_id || '').trim() === gid;
    })
    : [vacancy]
  ).filter(function (v) { return !String(v.result || '').trim(); });

  for (var i = 0; i < open.length; i++) {
    const v = open[i];
    const course = courseById[String(v.course_id).trim()];
    if (!course) return '対象のコマが見つかりません。';
    if (String(v.absent_staff_id).trim() === staffId) return 'あなたの欠勤です。';
    if (isAssigned_(course, staffId)) return 'あなたが担当しているコマです。';
    if (isRecruitClosed_(v, course)) return MSG_SELF_CLAIM_CLOSED;
    // 休講の日には入れない（issue #46）
    if (cancelledNotice_(course, dateToStr_(v.date), (ctx && ctx.cal) || null)) return 'この日のこのコマは休講です。代行は要りません。';
    if (!hasSkillFor_(staff, course.support_type)) {
      return '「' + String(course.support_type).trim() + '」はあなたの対応できる業務に入っていません。';
    }
    if (busyStaffIds_(course, v.date, ctx)[staffId]) {
      return 'この時間は、あなたの別の担当か代行が入っています。';
    }
  }
  return '';
}

/**
 * 自分から代行に入る（D50）。入れる条件は selfClaimBlocker_、確定は承諾と同じ先着。
 * 本人は Session から特定する（画面から送られた staff_id は使わない）。
 *
 * @return 次のいずれか：
 *   {ok:true,  confirmed:true, also_confirmed, notify} … 自分に確定
 *   {ok:false, filled:true,   closed:true}             … 既に他の人で埋まった
 *   {ok:false, message}                                … 入れない（理由つき）
 */
function claimVacancy(vacancyId) {
  const user = getOpenUser_();
  if (!user) throw new Error('利用登録がありません。');

  const vacancy = findRow_(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  if (!vacancy) throw new Error('対象の欠員が見つかりません。');
  if (String(vacancy.result || '').trim()) return { ok: false, filled: true, closed: true };

  const staff = findRow_(SHEET.STAFFS, 'staff_id', user.staff_id);
  const blocker = selfClaimBlocker_(vacancy, staff);
  if (blocker) return { ok: false, message: blocker };

  // 欠員補充管理の回答状況に「この人が承諾した」と出るよう、承諾と同じ形で記録しておく
  upsertRow_(
    SHEET.RESPONSES,
    { vacancy_id: String(vacancy.vacancy_id).trim(), staff_id: user.staff_id },
    { answer: ANSWER.ACCEPT, answered_at: nowString_() }
  );

  const settled = settleBlockFor_(vacancy, user.staff_id);
  if (!settled.ok) return settled;
  return { ok: true, confirmed: true, also_confirmed: settled.also_confirmed, notify: settled.notify };
}

/**
 * 欠員一覧（vacancies 画面・D50）。今日以降の**まだ決まっていない欠員**を、
 * かたまり（D45）ごとに1件にまとめて返す。学生には「入れるか／入れない理由」も付ける。
 * 職員にも見せる（学生から見えている状態の確認用）。操作は従来どおり欠員補充管理で行う。
 */
function getOpenVacancies() {
  const user = getOpenUser_();
  if (!user) throw new Error('利用登録がありません。');

  const staffs = readRows_(SHEET.STAFFS);
  const courses = readRows_(SHEET.COURSES);
  const vacancies = readRows_(SHEET.VACANCIES);
  const ctx = { staffs: staffs, courses: courses, vacancies: vacancies };
  const today = todayJst_();
  const isStaff = user.role === ROLE_STAFF;

  const nameById = {};
  var me = null;
  staffs.forEach(function (s) {
    const id = String(s.staff_id).trim();
    nameById[id] = s.name;
    if (id === user.staff_id) me = s;
  });
  const courseById = {};
  courses.forEach(function (c) { courseById[String(c.course_id).trim()] = c; });
  const periodById = buildPeriodMap_();
  const periodOrder = {};
  readRows_(SHEET.PERIODS).forEach(function (p, i) { periodOrder[String(p.period).trim()] = i; });

  // かたまりごとにまとめる（group_id が空なら1件で1つ）
  const groups = {};
  const order = [];
  vacancies.forEach(function (v) {
    if (String(v.result || '').trim()) return;
    const date = dateToStr_(v.date);
    if (!date || date < today) return;
    if (!courseById[String(v.course_id).trim()]) return;
    const key = String(v.group_id || '').trim() || ('v:' + String(v.vacancy_id).trim());
    if (!groups[key]) { groups[key] = []; order.push(key); }
    groups[key].push(v);
  });

  const items = order.map(function (key) {
    const members = groups[key].slice().sort(function (a, b) {
      const pa = String(courseById[String(a.course_id).trim()].period).trim();
      const pb = String(courseById[String(b.course_id).trim()].period).trim();
      return (periodOrder[pa] || 0) - (periodOrder[pb] || 0);
    });
    const first = members[0];
    const main = courseById[String(first.course_id).trim()];
    const slots = members.map(function (v) {
      const c = courseById[String(v.course_id).trim()];
      const key2 = String(c.period).trim();
      const p = periodById[key2] || {};
      return {
        periodLabel: periodLabelOf_(c.period, p),
        time: courseTimeText_(c, periodById),   // 移動を含む勤務時間（D58）
        support_type: String(c.support_type || '').trim(),
      };
    });
    const startMin = workStartMinutes_(main);   // 前の移動があれば移動の始まり（D58）
    const deadlineMin = startMin === null ? null : startMin - RECRUIT_DEADLINE_MIN_BEFORE;
    const closed = members.some(function (v) {
      return isRecruitClosed_(v, courseById[String(v.course_id).trim()]);
    });

    const blocker = isStaff ? '' : selfClaimBlocker_(first, me, ctx);
    return {
      vacancy_id: String(first.vacancy_id).trim(),   // claimVacancy に渡す代表（かたまりごと確定される）
      date: dateToStr_(first.date),
      day: String(main.day || '').trim(),
      slots: slots,
      user_student: String(main.user_student || '').trim(),
      subject: String(main.subject || '').trim(),
      room: String(main.room || '').trim(),
      absentName: nameById[String(first.absent_staff_id).trim()] || String(first.absent_staff_id || ''),
      deadline: deadlineMin === null ? '' :
        pad2_(Math.floor(deadlineMin / 60)) + ':' + pad2_(deadlineMin % 60),
      closed: closed,
      claimable: !isStaff && !blocker,
      reason: blocker,
    };
  });

  items.sort(function (a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.slots[0].time < b.slots[0].time ? -1 : (a.slots[0].time > b.slots[0].time ? 1 : 0);
  });
  return { isStaff: isStaff, today: today, items: items };
}

function pad2_(n) { return (n < 10 ? '0' : '') + n; }

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
    const claim = claimIfEmpty_(SHEET.VACANCIES, 'vacancy_id', vacancyId, 'result', updates);
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
function isPastRecruitDeadline_(dateStr, periodOrCourse) {
  const dm = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!dm) return false;

  const startMin = workStartMinutes_(periodOrCourse);
  if (startMin === null) return false;

  // スクリプトのタイムゾーンは Asia/Tokyo（appsscript.json）なので、
  // 数値から組み立てた Date と new Date() の比較はそのまま日本時間の比較になる。
  const midnight = new Date(Number(dm[1]), Number(dm[2]) - 1, Number(dm[3]), 0, 0, 0);
  const deadline = midnight.getTime() + (startMin - RECRUIT_DEADLINE_MIN_BEFORE) * 60 * 1000;
  return new Date().getTime() > deadline;
}

/**
 * 勤務の始まり（0時からの分）。コマを渡すと、前の移動の印があれば移動の始まり（D58）。
 * 時限（文字列）を渡すと、その時限の開始。読めなければ null。
 * 移動から入る人にとっては移動の始まりが仕事の始まりなので、代行募集の締切もそこから数える。
 */
function workStartMinutes_(periodOrCourse) {
  if (periodOrCourse && typeof periodOrCourse === 'object') {
    return periodStartMinutes_(courseWorkSpan_(periodOrCourse).start);
  }
  const p = buildPeriodMap_()[String(periodOrCourse).trim()];
  return p ? periodStartMinutes_(p.start_time) : null;
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
  return isPastRecruitDeadline_(dateToStr_(vacancy.date), course);
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
function suggestSettleResult_(course, dateStr, absentStaffId, allVacancies) {
  const options = settleOptionsFor_(course, dateStr, absentStaffId, allVacancies);
  return options.indexOf(VACANCY_RESULT.SOLO) !== -1 ? VACANCY_RESULT.SOLO : VACANCY_RESULT.STAFF;
}

/**
 * 代行者なしで決着させるときに**選べる結果**（D22・issue #52）。画面のボタン・サーバーの検証・決着の提案が共通で使う。
 *   - 介助 … 1人体制なので「職員対応」だけ。「1人テイク」にすると、介助の担当がいないまま決着済みになり、
 *            対応待ちから消える
 *   - テイク … その日その時間に**担当が残る**なら「1人テイク」も選べる。誰も残らなければ「職員対応」だけ
 * 1人で回してよいかの最終判断は職員がする（D22）。ここは「そもそも成り立たない選択肢」を出さないだけ。
 *
 * @param {Object} course
 * @param {string} dateStr        'yyyy-MM-dd'
 * @param {string} absentStaffId  この欠員の欠勤者
 * @param {Array}  [allVacancies] 読み込み済みの vacancies（一覧で何件も判定するとき用）
 * @return {Array<string>} VACANCY_RESULT.SOLO / VACANCY_RESULT.STAFF の並び（STAFF は必ず入る）
 */
function settleOptionsFor_(course, dateStr, absentStaffId, allVacancies) {
  if (String(course.support_type || '').trim() === '介助') return [VACANCY_RESULT.STAFF];
  return remainingStaffOn_(course, dateStr, absentStaffId, allVacancies).length > 0
    ? [VACANCY_RESULT.SOLO, VACANCY_RESULT.STAFF]
    : [VACANCY_RESULT.STAFF];
}

/**
 * その日そのコマに**実際に入る人**（この欠員の欠勤者を除く）。
 * 担当A・B から、同じ日・同じコマで欠勤している人を除き、その欠勤に代行が決まっていれば（補充済）代行の人を足す。
 * 例：相方も欠勤 → 残らない／相方の欠勤に代行が決まっている → 代行の人が残る
 */
function remainingStaffOn_(course, dateStr, absentStaffId, allVacancies) {
  const courseId = String(course.course_id).trim();
  const absent = {};
  absent[String(absentStaffId || '').trim()] = true;
  const subs = [];
  (allVacancies || readRows_(SHEET.VACANCIES)).forEach(function (v) {
    if (String(v.course_id).trim() !== courseId || dateToStr_(v.date) !== dateStr) return;
    const a = String(v.absent_staff_id || '').trim();
    if (a) absent[a] = true;
    const sub = String(v.substitute_staff_id || '').trim();
    if (sub && String(v.result || '').trim() === VACANCY_RESULT.FILLED) subs.push(sub);
  });
  const remaining = [course.staff_a_id, course.staff_b_id]
    .map(function (x) { return String(x || '').trim(); })
    .filter(function (id) { return id && !absent[id]; });
  subs.forEach(function (id) { if (remaining.indexOf(id) === -1) remaining.push(id); });
  return remaining;
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
  const allStaffs = readRows_(SHEET.STAFFS);
  const allCourses = readRows_(SHEET.COURSES);
  const allVacancies = readRows_(SHEET.VACANCIES);
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
  readRows_(SHEET.CONTACTS).forEach(function (c) {
    phoneById[String(c.staff_id).trim()] = String(c.phone || '').trim();
  });

  // 欠員ごとの回答をまとめる（＋ staff_id → answer の索引）
  const responsesByVacancy = {};
  const answerByVacancy = {};
  readRows_(SHEET.RESPONSES).forEach(function (r) {
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
      periodLabel: periodLabelOf_(course.period, periodById[String(course.period || '').trim()]),
      time: courseTimeText_(course, periodById),   // 移動を含む勤務時間（D58）
      absentName: nameById[String(v.absent_staff_id).trim()] || v.absent_staff_id,
      result: String(v.result || '').trim(),
      substituteName: subId ? (nameById[subId] || subId) : '',
      // 募集は終わったが決着していない（＝職員が「1人テイク／職員対応」を決める番）
      awaitingDecision: closed,
      // 決着の手がかり（相方が残るか）。提案であって、システムは書き込まない（D22）
      suggestion: closed
        ? suggestSettleResult_(course, dateToStr_(v.date), String(v.absent_staff_id).trim(), allVacancies)
        : '',
      // 代行なしで決着させるときに選べる結果（介助に「1人テイク」は出さない・issue #52）
      settleOptions: resolved || !String(course.course_id || '').trim() ? [] :
        settleOptionsFor_(course, dateToStr_(v.date), String(v.absent_staff_id).trim(), allVacancies),
      // 判断に要るコマの情報（issue #53）。電話の前に別の画面でコマを探さなくてよいように
      support_type: String(course.support_type || '').trim(),
      user_student: String(course.user_student || '').trim(),
      subject: String(course.subject || '').trim(),
      room: String(course.room || '').trim(),
      responses: responsesByVacancy[vid] || [],
      candidates: candidates,
    };
  });
}

/** 休講の日の欠員なら止める（代行の確定・issue #46）。見つからないときは後段が理由つきで止める */
function assertVacancyNotCancelled_(vacancy) {
  if (!vacancy) return;
  const course = findRow_(SHEET.COURSES, 'course_id', vacancy.course_id);
  if (!course) return;
  const cancelled = cancelledNotice_(course, dateToStr_(vacancy.date));
  if (cancelled) throw new Error(cancelled + '代行は要りません。');
}

/**
 * 代行者を確定する。result を「補充済」にし substitute_staff_id を記録する。
 * （カレンダー反映は Phase 2 で Calendar.gs から行う）
 */
function confirmSubstitute(vacancyId, substituteStaffId) {
  requireStaff_();
  if (!substituteStaffId) throw new Error('代行者が指定されていません。');
  assertVacancyNotCancelled_(findRow_(SHEET.VACANCIES, 'vacancy_id', vacancyId));

  // result が空のときだけ atomically 確定する（settle 遷移）。
  // 職員の確定中に候補者が respondToVacancy で先着確定するケースを防ぐ（D1違反の是正・backlog 10-1）。
  transitionVacancyOrThrow_(vacancyId, 'settle',
    { result: VACANCY_RESULT.FILLED, substitute_staff_id: substituteStaffId });

  // 確定を関係者へ通知（先着確定と挙動を揃える・review #8）
  var notify;
  try {
    notify = notifyVacancyFilled_(vacancyId, substituteStaffId);
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
  // そのコマ・その日に成り立たない決着は受け付けない（issue #52）。画面にボタンが無くても、直接呼ばれたら止める
  const vacancy = findRow_(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  const course = vacancy ? findRow_(SHEET.COURSES, 'course_id', vacancy.course_id) : null;
  if (vacancy && course &&
      settleOptionsFor_(course, dateToStr_(vacancy.date), vacancy.absent_staff_id).indexOf(result) === -1) {
    throw new Error(String(course.support_type || '').trim() === '介助'
      ? 'この欠員は介助です。介助は1人体制なので「' + VACANCY_RESULT.SOLO + '」にはできません。代行を確定するか「' + VACANCY_RESULT.STAFF + '」にしてください。'
      : 'この日のこのコマには、ほかに入る担当がいません（相方も欠勤など）。「' + VACANCY_RESULT.SOLO + '」にはできません。代行を確定するか「' + VACANCY_RESULT.STAFF + '」にしてください。');
  }

  // result が空のときだけ atomically 決着する（settle 遷移）。
  // 職員の決着中に候補者が先着確定するケースを防ぐ（D1違反の是正・backlog 10-1）。
  transitionVacancyOrThrow_(vacancyId, 'settle', { result: result, substitute_staff_id: '' });

  // 募集終了を候補者へ通知（先着確定と挙動を揃える・review #8）
  var notify;
  try {
    notify = notifyVacancyClosed_(vacancyId, result);
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
  const cur = findRow_(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  const curCourse = cur ? findRow_(SHEET.COURSES, 'course_id', cur.course_id) : null;

  // 休講中のコマは開き直さない（issue #46）。開くと授業の無い日に代行を募集し、確定までできてしまう。
  // 休講を取り消してから開き直す（D60 の手順）
  const cancelled = cur && curCourse ? cancelledNotice_(curCourse, dateToStr_(cur.date)) : '';
  if (cancelled) {
    throw new Error(cancelled + '再募集するときは、先にシフト確認でこのコマを押して休講を取り消してください。');
  }

  const pastDeadline = cur && curCourse
    ? isPastRecruitDeadline_(dateToStr_(cur.date), curCourse)
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
      released = notifySubstituteReleased_(vacancyId, prevSub);
    } catch (e) {
      released = { error: e.message };
    }
  }

  // 候補者へ再募集を送る（backlog 10-4）。
  // 従来は notify_status を戻すだけで再送経路が無く、全候補が「募集終了」を受信済みのまま
  // 誰にも再依頼が届かず無人で当日を迎える恐れがあった。notifyNewVacancy_ を再利用する。
  //
  // ただし締切を過ぎているなら再募集はしない（D22）。respondToVacancy が締切超過の回答を
  // 弾くため、依頼を送っても候補は答えられず「押せないボタン」を配るだけになる。
  // この場合の再オープンは「職員が決着をやり直すために開く」操作として扱う。
  var reNotify = null;
  if (pastDeadline) {
    reNotify = { skipped: true, reason: '締切を過ぎているため再募集は行いません（職員が決着します）。' };
  } else {
    try {
      reNotify = notifyNewVacancy_(vacancyId, true);
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
 * 二重通知の防止：close_notified_at が空のときだけ処理者になる（claimIfEmpty_ の CAS）。
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
  readRows_(SHEET.COURSES).forEach(function (c) {
    courseById[String(c.course_id).trim()] = c;
  });

  readRows_(SHEET.VACANCIES).forEach(function (v) {
    const vid = String(v.vacancy_id).trim();
    if (!vid) return;
    if (only && only.indexOf(vid) === -1) return;             // e2e で対象を限定しているとき
    if (String(v.result || '').trim()) return;                // 決着済み（募集の軸の外）
    if (String(v.close_notified_at || '').trim()) return;     // この欠員は処理済み
    const course = courseById[String(v.course_id).trim()];
    if (!course) return;                                      // コマが消えている＝判定不能
    const dateStr = dateToStr_(v.date);
    if (!isPastRecruitDeadline_(dateStr, course)) return; // まだ募集中
    out.scanned++;

    const claim = claimIfEmpty_(SHEET.VACANCIES, 'vacancy_id', vid, 'close_notified_at',
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
      notifyRecruitClosed_(vid, RECRUIT_CLOSE_REASON.DEADLINE_REACHED,
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
  const busy = busyStaffIds_(course, date, ctx);

  const allStaffs = (ctx && ctx.staffs) || readRows_(SHEET.STAFFS);
  return allStaffs
    .filter(function (s) {
      const id = String(s.staff_id).trim();
      if (String(s.role).trim() !== '学生') return false;             // 学生のみ候補
      if (exclude.indexOf(id) !== -1) return false;                   // 欠勤者・相方を除外
      if (busy[id]) return false;                                     // 同一スロットで二重起用になる
      if (slotsOf_(s, supportType).indexOf(slotKey) === -1) return false;   // 該当スロットに空き
      return hasSkillFor_(s, supportType);                            // 対応可能な内容（スキル）
    })
    .map(function (s) {
      return { staff_id: s.staff_id, name: s.name };
    });
}

/**
 * その業務に対応できるか（D9）。**skills が空欄なら、どの業務にも対応しない**（D65・2026-11-25）。
 * 以前は空欄＝全対応だったが、名簿から登録した人は業務が空で始まるうえ、画面が空の人に両方のチェックを
 * 入れて見せていたので、選んだつもりのない業務の依頼まで届きえた。本人が選ぶまで、どの依頼も届けない。
 */
function hasSkillFor_(staff, supportType) {
  const type = String(supportType || '').trim();
  if (!type) return true;
  const skills = String((staff && staff.skills) || '').split(',')
    .map(function (x) { return x.trim(); }).filter(Boolean);
  return skills.indexOf(type) !== -1;
}

/**
 * そのコマと**同じ曜日・時限に、もう仕事が入っている人**（staff_id → true）。
 * 代行候補（findCandidates_）と、自分から代行に入る判定（selfClaimBlocker_・D50）で共通。
 *   - 同じ時限の別のコマの担当。**学期の名前ではなく、実際に同じ時間に授業があるか**で見る（issue #43）。
 *     後期と 4Q のように学期が違っても、同じ日に両方の授業があれば同じ人は入れない
 *       - date を渡したとき：別のコマが**その日に実際にあるか**（courseHeldOn_：学期の曜日ごとの範囲・
 *         授業の無い日・単発の日付・個別の休講）。その日が休講のコマの担当は、その時間は空いている
 *       - date が無いとき：その曜日に同時に授業がある学期（concurrentTermSet_・シフト入力の二重起用チェックと同じ）で、
 *         開催回が重なるもの（単発コマは別の日なら競合しない・D27）
 *   - date を渡したとき：その日・同じ時限で既に代行が確定している人
 */
function busyStaffIds_(course, date, ctx) {
  const slotKey = String(course.day).trim() + String(course.period).trim();
  const quarter = String(course.quarter).trim();
  const courseId = String(course.course_id).trim();
  const dateStr = date ? dateToStr_(date) : '';

  // 一覧で何度も呼ぶときのために、学期の範囲は ctx に1回だけ持つ
  const cal = (ctx && ctx.cal) || classCalendar_();
  if (ctx && !ctx.cal) ctx.cal = cal;
  const sameTime = dateStr ? null : concurrentTermSet_(quarter, readTerms_(), String(course.day).trim(), cal);

  // 同一スロットで「埋まっている」学生（ダブルブッキング除外用）
  const allCourses = (ctx && ctx.courses) || readRows_(SHEET.COURSES);
  const slotOf = {};   // course_id → day+period
  const busy = {};     // staff_id → そのスロットは空けられない
  allCourses.forEach(function (c) {
    const cid = String(c.course_id).trim();
    slotOf[cid] = String(c.day).trim() + String(c.period).trim();
    if (cid === courseId || slotOf[cid] !== slotKey) return;
    const cTerm = String(c.quarter).trim();
    // 日付があるとき、学期の違う毎週のコマは**その学期の期間が分かるときだけ**数える。
    // 期間の無い学期（terms に行が無い古い年度など）は courseHeldOn_ が「ある」とみなすので、
    // 数えると昔のコマの担当まで埋まっている扱いになる
    const overlaps = dateStr
      ? courseHeldOn_(c, dateStr, cal).held &&
        (cTerm === quarter || !!courseDate_(c) || !!(cal && cal.ranges && cal.ranges[cTerm]))
      : !!sameTime[cTerm] && occurrencesOverlap_(courseDate_(course), courseDate_(c));
    if (!overlaps) return;
    [c.staff_a_id, c.staff_b_id].forEach(function (id) {
      id = String(id).trim();
      if (id) busy[id] = true;
    });
  });

  // date 指定時：その日・同スロットで既に代行確定済みの学生も除外
  if (dateStr) {
    const target = dateStr;
    const allVacancies = (ctx && ctx.vacancies) || readRows_(SHEET.VACANCIES);
    allVacancies.forEach(function (v) {
      const sub = String(v.substitute_staff_id || '').trim();
      if (!sub) return;
      if (dateToStr_(v.date) !== target) return;
      if (slotOf[String(v.course_id).trim()] === slotKey) busy[sub] = true;
    });
  }
  return busy;
}

// ─── 内部ヘルパー ────────────────────────────────────────────

/**
 * その業務でのそのスタッフの空きコマを配列で返す（D32）。
 *
 * テイクと介助で空いている時間は違う。同じ1本の available_slots で兼ねると、
 * 「テイクは空いているが介助はできない時間」に介助の依頼が飛ぶ（またはその逆）。
 *
 * ⚠️ **移行前のDBで黙って0件にしない。** assist_slots 列がまだ無いシートでは、
 * 素直に読むと介助の候補が**全員ぶん構造的に消える**（エラーは出ないので気づけない）。
 * 列の有無を見て、無ければ従来の1本へ寄せる（close_notified_at と同じ手当て）。
 */
function slotsOf_(staffRow, supportType) {
  var col = SLOT_COLUMN_BY_SUPPORT_TYPE[String(supportType || '').trim()] || DEFAULT_SLOT_COLUMN;
  if (col !== DEFAULT_SLOT_COLUMN && getHeaders_(SHEET.STAFFS).indexOf(col) === -1) {
    col = DEFAULT_SLOT_COLUMN;   // マイグレーション未実行のDB
  }
  return splitSlots_(staffRow && staffRow[col]);
}

/** '月1,火3' 形式を配列へ（空要素は捨てる） */
function splitSlots_(csv) {
  return String(csv || '').split(',')
    .map(function (x) { return x.trim(); })
    .filter(Boolean);
}

/** staffs の1行から「業務 → 空きコマ配列」を作る（D32） */
function slotsByTypeOf_(staff) {
  const out = {};
  SUPPORT_TYPES.forEach(function (type) {
    out[type] = splitSlots_(staff && staff[SLOT_COLUMN_BY_SUPPORT_TYPE[type]]);
  });
  return out;
}

/**
 * その時限が授業のあいだの**移動の枠**か（D33・D57）。
 *
 * 移動の枠を別のコマとしては 2026-11-16 から使わない（D57）。移動は介助の授業のコマの印で持つ（D58）。
 * `periods` の行は残すが、画面（時間割・シフト入力・空きコマ）には出さず、新しく登録もさせない。
 * 判定：キーが `移動前3` / `移動後2` の形か、選べる業務が限られている（`support_types` が全業務でない）。
 */
function isMovePeriod_(periodRow) {
  if (!periodRow) return false;
  if (declaredMoveAttachment_(periodRow.period)) return true;
  return SUPPORT_TYPES.some(function (t) { return !periodAllowsSupportType_(periodRow, t); });
}

// 介助のコマの「前の移動あり／後の移動あり」の印（D58）。シートで読める言葉にする
const MOVE_FLAG_VALUE = 'あり';

/** 移動の印が付いているか（空でなければあり） */
function hasMoveFlag_(v) {
  return !!String(v == null ? '' : v).trim();
}

/** 時限マスタの時刻（文字列 '9:15' でも Date でも）を 'HH:mm' にする。読めなければ元の文字 */
function hhmmText_(v) {
  const m = periodStartMinutes_(v);
  if (m === null) return String(v == null ? '' : v).trim();
  const pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
}

/**
 * コマの**勤務時間**（D58）。授業の時刻に、印の付いた前後の移動の枠を足したもの。
 *
 * 移動介助は勤務時間に入る。以前は移動を別のコマ（移動の枠）として持っていたが、時間割がかさばるので
 * 介助の授業のコマの印（move_before / move_after）にした。移動の長さは時限マスタの移動の枠のまま
 * （授業の前15分・2限のあと食堂へ15分など・D35）。テイクには付かない。
 *
 * @param {Object} course  courses の行
 * @param {Object} [periodMap] buildPeriodMap_() の結果（無ければ読む）
 * @return {{start:*, end:*, label:string, hasMove:boolean, before:Object|null, after:Object|null}}
 *         start / end は時限マスタの値のまま（締切の計算に使う）。label は 'HH:mm〜HH:mm'
 */
function courseWorkSpan_(course, periodMap) {
  const map = periodMap || buildPeriodMap_();
  const p = map[String(course.period).trim()] || {};
  var start = p.start_time;
  var end = p.end_time;
  var before = null;
  var after = null;
  if (String(course.support_type || '').trim() === '介助') {
    if (hasMoveFlag_(course.move_before)) {
      before = attachedMovePeriod_(course.period, '介助', 'before');
      if (before && before.start_time) start = before.start_time;
    }
    if (hasMoveFlag_(course.move_after)) {
      after = attachedMovePeriod_(course.period, '介助', 'after');
      if (after && after.end_time) end = after.end_time;
    }
  }
  return {
    start: start, end: end,
    label: start ? hhmmText_(start) + '〜' + hhmmText_(end) : '',
    hasMove: !!(before || after), before: before, after: after,
  };
}

/** 画面・通知に出す時刻。移動を含むときは「10:45〜12:45・移動を含む」 */
function courseTimeText_(course, periodMap) {
  if (!course) return '';
  const span = courseWorkSpan_(course, periodMap);
  return span.label + (span.hasMove ? '・移動を含む' : '');
}

/** 移動の印の説明（「授業の前・あと」など）。印が無ければ空 */
function courseMoveText_(course) {
  if (String(course.support_type || '').trim() !== '介助') return '';
  const b = hasMoveFlag_(course.move_before);
  const a = hasMoveFlag_(course.move_after);
  if (b && a) return '授業の前とあとの移動';
  if (b) return '授業の前の移動';
  if (a) return '授業のあとの移動';
  return '';
}

/** 移動の枠のキーの集合（period → true） */
function movePeriodKeys_() {
  const set = {};
  readRows_(SHEET.PERIODS).forEach(function (p) {
    if (isMovePeriod_(p)) set[String(p.period).trim()] = true;
  });
  return set;
}

/**
 * 移動枠のキーが「どの授業のどちら側か」を宣言していれば返す（D35）。
 *
 *   移動前3 → 3限の前 ／ 移動後2 → 2限の後
 *
 * 時刻だけでは**前と後を見分けられない場合がある**。授業間が15分ちょうどだと
 * 「次の授業の前の枠」の開始時刻が「前の授業の終了時刻」と一致するため、
 * 1限のあとを探すと `移動前2` が拾われてしまう（実際に起きた）。
 * キーはどの授業の仕事かを明示しているので、こちらを先に見る。
 *
 * @return {{side:string, period:string}|null}
 */
function declaredMoveAttachment_(key) {
  const m = String(key == null ? '' : key).trim().match(/^移動(前|後)(.+)$/);
  if (!m) return null;
  return { side: m[1] === '前' ? 'before' : 'after', period: m[2].trim() };
}

/**
 * 欠勤の「かたまり」を返す（D45）。授業と、**その前後の移動介助のコマ**。
 *
 * 移動介助は必ず授業と同じ人が担当する（シフト入力がそう作る・D34/D35）。
 * したがって介助の担当が休むと、授業だけでなく前後の移動も同じ人の欠員になる。
 * 実務でも「どちらかに出られないならその日は休む」という運用（職員確認・2026-09-23）。
 *
 * **同じ人・同じ日・同じ利用者**のコマだけを束ねる。担当が違うなら別の人の仕事なので
 * かたまりに入れない（2限のあとの移動は2限の担当、3限の前の移動は3限の担当・D35）。
 *
 * @param {Object} course  中心になるコマ（授業）
 * @param {string} staffId 欠勤する人
 * @param {string} dateStr 欠勤日 'yyyy-MM-dd'
 * @return {Array<Object>} courses の行。前→授業→後の順。移動が無ければ授業1件だけ
 */
function absenceBlockOf_(course, staffId, dateStr) {
  const out = [];
  const type = String(course.support_type || '').trim();
  const id = String(staffId).trim();
  const all = readRows_(SHEET.COURSES);

  const attached = function (side) {
    const mv = attachedMovePeriod_(course.period, type, side);
    if (!mv) return null;
    const key = String(mv.period).trim();
    return all.filter(function (c) {
      if (String(c.period).trim() !== key) return false;
      if (String(c.quarter).trim() !== String(course.quarter).trim()) return false;
      if (String(c.day).trim() !== String(course.day).trim()) return false;
      if (String(c.user_student).trim() !== String(course.user_student).trim()) return false;
      if (!isAssigned_(c, id)) return false;                       // 同じ人の仕事だけ
      return occurrencesOverlap_(courseDate_(course), courseDate_(c));
    })[0] || null;
  };

  const before = attached('before');
  if (before) out.push(before);
  out.push(course);
  const after = attached('after');
  if (after) out.push(after);
  return out;
}

/** かたまりに含まれるコマの行（通知や候補抽出で使う・D45） */
function blockCoursesOfVacancy_(vacancy) {
  return vacancyGroupOf_(vacancy)
    .map(function (v) { return findRow_(SHEET.COURSES, 'course_id', String(v.course_id).trim()); })
    .filter(Boolean);
}

/** 同じ group_id の欠員をすべて返す（group_id が空なら自分だけ） */
function vacancyGroupOf_(vacancy) {
  const gid = String((vacancy && vacancy.group_id) || '').trim();
  if (!gid) return vacancy ? [vacancy] : [];
  return readRows_(SHEET.VACANCIES).filter(function (v) {
    return String(v.group_id || '').trim() === gid;
  });
}

/**
 * かたまり全体で代行できる人（D45）。**すべての枠に空きがある人だけ**。
 *
 * 1枠でも空いていない人を呼ぶと、その人は一部しか受けられない。
 * 「その人じゃないと頼めない」（職員確認）ので、積集合を取る。
 */
function findCandidatesForBlock_(courses, excludeStaffIds, dateStr) {
  var acc = null;
  courses.forEach(function (c) {
    const here = findCandidates_(c, excludeStaffIds, dateStr);
    const ids = {};
    here.forEach(function (x) { ids[String(x.staff_id).trim()] = true; });
    acc = acc === null ? here : acc.filter(function (x) { return ids[String(x.staff_id).trim()]; });
  });
  return acc || [];
}

/**
 * その授業に**くっついている移動枠**を返す（D34・D35）。無ければ null。
 *
 *   前 … 3限の担当が3限の開始前に動く（`移動前3`）
 *   後 … 2限の担当が2限のあと食堂へ運ぶ（`移動後2`）
 *
 * **1つのあいだに2つ入りうる**（2限の後と3限の前は別の人の仕事・D35）。
 * だから「あいだ」ではなく「授業の前／後」で引く。
 *
 * 探し方は2段階。
 *   1. **キーが宣言している所属**（`移動前3` / `移動後2`）で引く。これが正。
 *   2. 宣言の無いキー（職員が独自の名前で足した枠）は**時刻でつながっているか**で引く。
 *      このとき、別の授業に宣言済みの枠は候補から外す（取り違えを防ぐ）。
 *
 * @param {string} period       授業の時限
 * @param {string} supportType  その業務で選べる枠だけを対象にする
 * @param {string} side         'before' / 'after'
 * @return {Object|null} periods の1行
 */
function attachedMovePeriod_(period, supportType, side) {
  const key = String(period == null ? '' : period).trim();
  const rows = readRows_(SHEET.PERIODS).filter(function (p) {
    if (String(p.period).trim() === key) return false;
    // 通常の授業時限（support_types が空）は移動枠ではない
    if (!String(p.support_types || '').trim()) return false;
    return periodAllowsSupportType_(p, supportType);
  });

  // 1) キーが「この授業のこちら側」と宣言しているもの
  const declared = rows.filter(function (p) {
    const at = declaredMoveAttachment_(p.period);
    return at && at.side === side && at.period === key;
  })[0];
  if (declared) return declared;

  // 2) 宣言の無い枠だけを、時刻でつながっているかで探す
  const target = readRows_(SHEET.PERIODS).filter(function (p) {
    return String(p.period).trim() === key;
  })[0];
  if (!target) return null;
  const edge = String((side === 'after' ? target.end_time : target.start_time) || '').trim();
  if (!edge) return null;

  const hit = rows.filter(function (p) {
    if (declaredMoveAttachment_(p.period)) return false;   // 別の授業に宣言済み
    const other = String((side === 'after' ? p.start_time : p.end_time) || '').trim();
    return other === edge;
  })[0];
  return hit || null;
}

/** その授業の直前の移動枠（D34） */
function precedingMovePeriod_(period, supportType) {
  return attachedMovePeriod_(period, supportType, 'before');
}

/** その授業の直後の移動枠（D35。例：2限のあとの食堂への移動） */
function followingMovePeriod_(period, supportType) {
  return attachedMovePeriod_(period, supportType, 'after');
}

/**
 * 画面に出す時限の呼び名（D33）。`periods.label` があればそれ、無ければ従来どおり「3限」。
 *
 * 授業のあいだの移動介助のように「n限」と呼べない枠を時限マスタに足せるようにするため。
 * **画面側で `period + '限'` を組み立てない**こと（16か所に散っていたのをここへ寄せた）。
 */
function periodLabelOf_(period, periodRow) {
  const label = String((periodRow && periodRow.label) || '').trim();
  return label || (String(period == null ? '' : period).trim() + '限');
}

/**
 * その時限がその業務で選べるか（D32）。
 * `periods.support_types` が空なら全業務で使える（通常の授業時限）。
 * 「介助」だけを入れておけば、授業のあいだの移動枠のように**介助でしか選べない枠**を作れる。
 */
function periodAllowsSupportType_(periodRow, supportType) {
  const allowed = String((periodRow && periodRow.support_types) || '').split(',')
    .map(function (x) { return x.trim(); }).filter(Boolean);
  if (!allowed.length) return true;
  return allowed.indexOf(String(supportType || '').trim()) !== -1;
}

// スタッフが指定コマの担当（A or B）か
function courseDate_(course) {
  // セルがテキスト書式でないシートでは '2026-09-12' が**日付値**として保存され、
  // readRows_ が Date を返す。生の String() を掛けると
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
  readRows_(SHEET.STAFFS).forEach(function (s) {
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
 * パースは Util.gs のヘルパーを使い分ける（hhmmToMin_ / jstMinutes_）。
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
  readRows_(SHEET.PERIODS).forEach(function (p) {
    map[String(p.period).trim()] = p;
  });
  return map;
}
