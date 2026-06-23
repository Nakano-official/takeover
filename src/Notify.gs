/**
 * Google Chat 通知
 *
 * Incoming Webhook へ POST してメッセージを送る。
 *  - 職員向けスペース : スクリプトプロパティ CHAT_WEBHOOK_URL
 *  - スタッフ個人      : 連絡先DB contacts の webhook_url 列（個別スペースのWebhook）
 *
 * 設計方針：
 *  - 通知の失敗で欠員登録などの主処理を巻き込まない（呼び出し側で try/catch する）
 *  - 送信結果は { 成否・理由 } を集約して返し、職員が状況を把握できるようにする
 *  - 外部リクエスト（UrlFetchApp）の権限が必要。初回実行時に承認ダイアログが出る。
 */

const PROP_STAFF_WEBHOOK = 'CHAT_WEBHOOK_URL';

// 通知ステータス（vacancies.notify_status に記録する値）
// ※ '未通知'（未通知の初期値）は Vacancy.gs の NOTIFY_STATUS_PENDING が担う。
//    ファイル読み込み順に依存しないよう、ここでは他ファイルの定数を参照しない。
const NOTIFY_STATUS = {
  DONE: '通知済',
  PARTIAL: '一部通知',
  FAILED: '通知失敗',
};

// ─── 低レベル送信 ────────────────────────────────────────────

/**
 * Webhook URL にテキストメッセージを1件送る。
 * 成功で true。失敗時は例外を投げる（呼び出し側で握りつぶすか判断する）。
 */
function postToWebhook_(webhookUrl, text) {
  if (!webhookUrl) throw new Error('Webhook URL が空です。');
  const res = UrlFetchApp.fetch(webhookUrl, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    payload: JSON.stringify({ text: text }),
    muteHttpExceptions: true, // 失敗時もHTTPコードで判定したいので例外化しない
  });
  const code = res.getResponseCode();
  if (code < 200 || code >= 300) {
    throw new Error('Chat送信に失敗（HTTP ' + code + '）: ' + res.getContentText());
  }
  return true;
}

// 職員スペースの Webhook URL を取得する（未設定なら例外）
function getStaffSpaceWebhook_() {
  const url = PropertiesService.getScriptProperties().getProperty(PROP_STAFF_WEBHOOK);
  if (!url) throw new Error('スクリプトプロパティ ' + PROP_STAFF_WEBHOOK + ' が未設定です。');
  return url;
}

// スタッフ個人の Webhook URL を連絡先DBから取得する（無ければ空文字）
function getStaffWebhook_(staffId) {
  const c = findRow(SHEET.CONTACTS, 'staff_id', staffId);
  return c ? String(c.webhook_url || '').trim() : '';
}

// ─── 欠員通知（メイン）──────────────────────────────────────

/**
 * 欠員1件について、職員スペースと代行候補者へ通知を送る。
 * 候補者には回答画面（respond）への個別リンクを添える。
 * 送信後 vacancies.notify_status を更新する。
 *
 * @param  {string} vacancyId
 * @return {{staff:boolean, candidates:Array, errors:Array, notify_status:string}}
 */
function notifyNewVacancy(vacancyId) {
  const vacancy = findRow(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  if (!vacancy) throw new Error('対象の欠員が見つかりません。');
  const course = findRow(SHEET.COURSES, 'course_id', vacancy.course_id);
  if (!course) throw new Error('対象のコマが見つかりません。');

  const nameById = buildNameMap_();
  const periodById = buildPeriodMap_();
  const p = periodById[String(course.period).trim()] || {};
  const timeText = p.start_time ? p.start_time + '〜' + p.end_time : '';
  const dateText = dateToStr_(vacancy.date);
  const slot = String(course.day).trim() + String(course.period).trim() + '限';
  const absentName = nameById[String(vacancy.absent_staff_id).trim()] || vacancy.absent_staff_id;
  const respondUrl = getAppUrl_() + '?page=respond&vacancy=' + encodeURIComponent(vacancyId);

  const result = { staff: false, candidates: [], errors: [] };

  // 1) 職員スペースへ通知
  const staffMsg =
    '🚨 *欠員が発生しました*\n' +
    '日付: ' + dateText + '\n' +
    'コマ: ' + slot + (timeText ? '（' + timeText + '）' : '') + '\n' +
    '欠勤: ' + absentName + '\n' +
    '欠員ID: ' + vacancyId + '\n' +
    '対応状況は管理画面で確認してください。';
  try {
    postToWebhook_(getStaffSpaceWebhook_(), staffMsg);
    result.staff = true;
  } catch (e) {
    result.errors.push('職員スペース: ' + e.message);
  }

  // 2) 代行候補者へ個別に依頼（当日のダブルブッキングも除外）
  const candidates = findCandidates_(course, [course.staff_a_id, course.staff_b_id], vacancy.date);
  candidates.forEach(function (cand) {
    const entry = { staff_id: cand.staff_id, name: cand.name, sent: false, reason: '' };
    const url = getStaffWebhook_(cand.staff_id);
    if (!url) {
      entry.reason = 'Webhook未登録';
      result.candidates.push(entry);
      return;
    }
    const msg =
      cand.name + ' さん\n' +
      '代行のお願いです。下記コマで欠員が出ました。\n' +
      '日付: ' + dateText + '\n' +
      'コマ: ' + slot + (timeText ? '（' + timeText + '）' : '') + '\n' +
      '対応可能か、こちらから回答してください:\n' + respondUrl;
    try {
      postToWebhook_(url, msg);
      entry.sent = true;
    } catch (e) {
      entry.reason = e.message;
    }
    result.candidates.push(entry);
  });

  // 3) 通知ステータスを記録
  const sentCount = result.candidates.filter(function (c) { return c.sent; }).length;
  var status;
  if (!result.staff && sentCount === 0) {
    status = NOTIFY_STATUS.FAILED;
  } else if (result.errors.length > 0 || sentCount < result.candidates.length) {
    // 職員 or 一部候補には届いたが、未達（Webhook未登録含む）が残る
    status = NOTIFY_STATUS.PARTIAL;
  } else {
    status = NOTIFY_STATUS.DONE;
  }
  try {
    updateRow(SHEET.VACANCIES, 'vacancy_id', vacancyId, { notify_status: status });
  } catch (e) {
    result.errors.push('ステータス更新: ' + e.message);
  }
  result.notify_status = status;

  return result;
}

// ─── 補充確定の通知（先着自動確定 D1）──────────────────────

/**
 * 欠員が補充確定したことを関係者へ通知する。
 *  1) 職員スペース … 「補充されました（代行=氏名）」
 *  2) 確定した本人 … 「あなたに代行が決まりました」
 *  3) 他の候補者   … 「募集は終了しました」（無駄に承諾しに来ないように）
 * いずれも送信失敗は握りつぶし、結果を集約して返す（確定処理は別途確定済み）。
 *
 * @param  {string} vacancyId
 * @param  {string} substituteStaffId  確定した代行者
 * @return {{staff:boolean, substitute:boolean, others:Array, errors:Array}}
 */
function notifyVacancyFilled(vacancyId, substituteStaffId) {
  const vacancy = findRow(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  if (!vacancy) throw new Error('対象の欠員が見つかりません。');
  const course = findRow(SHEET.COURSES, 'course_id', vacancy.course_id);
  if (!course) throw new Error('対象のコマが見つかりません。');

  const nameById = buildNameMap_();
  const periodById = buildPeriodMap_();
  const p = periodById[String(course.period).trim()] || {};
  const timeText = p.start_time ? p.start_time + '〜' + p.end_time : '';
  const dateText = dateToStr_(vacancy.date);
  const slot = String(course.day).trim() + String(course.period).trim() + '限';
  const subId = String(substituteStaffId).trim();
  const subName = nameById[subId] || subId;

  const result = { staff: false, substitute: false, others: [], errors: [] };

  // 1) 職員スペースへ「補充済」
  const staffMsg =
    '✅ *欠員が補充されました*\n' +
    '日付: ' + dateText + '\n' +
    'コマ: ' + slot + (timeText ? '（' + timeText + '）' : '') + '\n' +
    '代行: ' + subName + '\n' +
    '欠員ID: ' + vacancyId;
  try {
    postToWebhook_(getStaffSpaceWebhook_(), staffMsg);
    result.staff = true;
  } catch (e) {
    result.errors.push('職員スペース: ' + e.message);
  }

  // 2) 確定した本人へ
  const subUrl = getStaffWebhook_(subId);
  if (subUrl) {
    const msg =
      subName + ' さん\n' +
      '代行が確定しました。ご協力ありがとうございます。\n' +
      '日付: ' + dateText + '\n' +
      'コマ: ' + slot + (timeText ? '（' + timeText + '）' : '');
    try {
      postToWebhook_(subUrl, msg);
      result.substitute = true;
    } catch (e) {
      result.errors.push('確定者: ' + e.message);
    }
  }

  // 3) 他の候補者へ「募集終了」（当日のダブルブッキングも除外）
  const candidates = findCandidates_(course, [course.staff_a_id, course.staff_b_id], vacancy.date);
  candidates.forEach(function (cand) {
    if (String(cand.staff_id).trim() === subId) return; // 確定本人は除外
    const entry = { staff_id: cand.staff_id, name: cand.name, sent: false, reason: '' };
    const url = getStaffWebhook_(cand.staff_id);
    if (!url) {
      entry.reason = 'Webhook未登録';
      result.others.push(entry);
      return;
    }
    const msg =
      cand.name + ' さん\n' +
      '先ほどの代行募集は他の方で補充が決まりました。ご確認ありがとうございました。\n' +
      '日付: ' + dateText + '\n' +
      'コマ: ' + slot;
    try {
      postToWebhook_(url, msg);
      entry.sent = true;
    } catch (e) {
      entry.reason = e.message;
    }
    result.others.push(entry);
  });

  return result;
}

// ─── デバッグ用 ──────────────────────────────────────────────

/**
 * 職員スペースへの疎通確認。GASエディタから実行してChatにテスト投稿が届くか見る。
 * 初回は外部リクエストの承認ダイアログが出るので「許可」する。
 */
function testNotify() {
  Logger.log('===== Notify 疎通確認 =====');
  try {
    const url = getStaffSpaceWebhook_();
    Logger.log('CHAT_WEBHOOK_URL: 設定OK');
    postToWebhook_(url, '✅ テスト送信：支援室シフト管理システムから職員スペースへ送信できています。');
    Logger.log('→ 送信成功。Chatのスペースを確認してください。');
  } catch (e) {
    Logger.log('❌ ' + e.message);
  }
  Logger.log('===== 終了 =====');
}

/**
 * 最新の欠員に対して notifyNewVacancy を実行する（実送信あり）。
 * testNotify で疎通確認できた後に使う。
 */
function testNotifyVacancy() {
  const vacancies = readRows(SHEET.VACANCIES);
  if (vacancies.length === 0) {
    Logger.log('vacancies が空です。先に欠勤連絡で欠員を作ってください。');
    return;
  }
  const vid = vacancies[vacancies.length - 1].vacancy_id;
  Logger.log('対象 vacancy_id: ' + vid);
  try {
    const res = notifyNewVacancy(vid);
    Logger.log('結果: ' + JSON.stringify(res, null, 2));
  } catch (e) {
    Logger.log('❌ ' + e.message);
    Logger.log(e.stack);
  }
}
