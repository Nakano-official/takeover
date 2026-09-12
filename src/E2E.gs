/**
 * 実機e2e — 一時データを作って通しで動かし、最後に必ず消す
 *
 * 実 LockService・実スプレッドシート（ダミーDB前提）に対して機能Aの中核を駆動し、
 * 状態を検証する。**手元の Node（tools/sim-vacancy.js）では確かめられないもの**、
 * すなわちロックの実挙動・シートへの実書き込み・実通知の配線がここの担当。
 *
 * ロジックそのもの（候補抽出・締切判定・状態遷移・画面へ返す値）は
 * `node tools/sim-vacancy.js` が1秒で確認するので、まずそちらを通してからこれを流す。
 *
 * ■ 実行前に
 *   - **ダミーDBに向いていること**を確認する（本番DBでは実行しない）
 *   - 既定では通知を送らない（opts.notify=true で実送信になる）
 *   - 一時データ（ZTEST1・ZTEST2・ZC1・ZC2・学期 __TEST_…）は finally で削除するが、
 *     途中で実行が止まった場合はログに出るIDをシートから手で消すこと
 */

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
 * D21（代行募集の締切）と D22（募集クローズ／決着は職員）の実機e2e。GASエディタから実行してログを見る。
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

  say('===== D21/D22 締切と募集クローズ（授業開始' + RECRUIT_DEADLINE_MIN_BEFORE + '分前）実機e2e / 通知=' +
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
    assert(late.recruitClosed === true, '募集はクローズされる（D22）');
    assert(late.suggestion === VACANCY_RESULT.SOLO, '相方 ZTEST2 が残るので「1人テイク」を職員へ提案する');
    const vLate = findRow(SHEET.VACANCIES, 'vacancy_id', late.vacancy_id);
    assert(!!vLate, '欠勤の記録自体は残る（登録はさせる）');
    assert(vLate && !String(vLate.result).trim(),
      'result は空のまま＝職員の決着待ち（D22：システムは決着させない）');
    assert(vLate && !!String(vLate.close_notified_at).trim(),
      '締切到達を処理済みとしてマークする（トリガーが再度拾わない）');

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
    assert(vEarly && !String(vEarly.close_notified_at || '').trim(),
      'まだ募集中なので close_notified_at は空');

    // ── 4) 募集中に締切へ到達 → 時間トリガーがクローズする（D22 の中核）──
    // 対象を early の欠員1件に限定して走らせる（実データの欠員を巻き込まないため）。
    say('--- 締切到達の検知（closeExpiredRecruits）---');
    assert(!isRecruitClosed_(vEarly, findRow(SHEET.COURSES, 'course_id', 'ZC2')),
      '締切前は「募集クローズ」と判定されない');

    setStart(10); // 授業開始を10分後にずらす＝締切（30分前）を過ぎた状態にする
    const vEarly2 = findRow(SHEET.VACANCIES, 'vacancy_id', early.vacancy_id);
    assert(isRecruitClosed_(vEarly2, findRow(SHEET.COURSES, 'course_id', 'ZC2')),
      '締切を過ぎると「募集クローズ」と判定される（保存ではなく毎回算出）');

    const tick1 = closeExpiredRecruits(false, [early.vacancy_id]);
    say('   1回目: ' + JSON.stringify(tick1));
    assert(tick1.scanned === 1, '締切超過の未決着欠員を1件拾う');
    const vClosed = findRow(SHEET.VACANCIES, 'vacancy_id', early.vacancy_id);
    assert(vClosed && !String(vClosed.result).trim(),
      'トリガーは result を書かない（決着は職員・D22）');
    assert(vClosed && !!String(vClosed.close_notified_at).trim(),
      'close_notified_at にクローズ時刻が入る');

    const tick2 = closeExpiredRecruits(false, [early.vacancy_id]);
    say('   2回目: ' + JSON.stringify(tick2));
    assert(tick2.scanned === 0, '同じ欠員を二度は拾わない（二重通知しない）');

    // ── 5) 締切後は候補が回答できない ──
    const closedRespond = getVacancyForRespond(early.vacancy_id);
    assert(closedRespond.deadlineClosed === true, '回答画面が「募集終了」を返す');

    say(fail === 0
      ? '===== ✅ 全' + pass + '件成功：D21/D22 の挙動を実機で確認しました ====='
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
