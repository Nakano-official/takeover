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

// 一括送信（postToWebhooks_）で職員スペース宛を指す予約キー。
// 他の宛先キーは staff_id なので、衝突しない形にしておく。
const STAFF_SPACE_KEY_ = '__staff_space__';

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

/**
 * 複数の Webhook へまとめて送る（UrlFetchApp.fetchAll・backlog 10-10）。
 *
 * 従来は候補1人ずつ postToWebhook_ を直列に呼んでおり、候補人数ぶんの往復が
 * そのまま応答時間に積み上がっていた（先着確定の競合中に最も遅くなる経路）。
 * fetchAll は並列に投げるため、人数が増えてもほぼ一定時間で終わる。
 *
 * URLが空/不正なものは fetchAll に渡さない。1件の不正URLで fetchAll 全体が
 * 例外になり、送れたはずの人にまで届かなくなるのを防ぐため。
 *
 * @param {Array<{key:string, url:string, text:string}>} targets
 * @return {Object} key → {sent:boolean, reason:string}
 */
function postToWebhooks_(targets) {
  const out = {};
  const requests = [];
  const keys = [];

  (targets || []).forEach(function (t) {
    const url = String(t.url || '').trim();
    if (!url) {
      out[t.key] = { sent: false, reason: 'Webhook未登録' };
      return;
    }
    if (url.indexOf('https://') !== 0) {
      out[t.key] = { sent: false, reason: 'Webhook URL が不正です（https で始まっていません）' };
      return;
    }
    keys.push(t.key);
    requests.push({
      url: url,
      method: 'post',
      contentType: 'application/json; charset=UTF-8',
      payload: JSON.stringify({ text: t.text }),
      muteHttpExceptions: true, // 失敗時もHTTPコードで判定したいので例外化しない
    });
  });
  if (requests.length === 0) return out;

  var responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    // 通信基盤ごと失敗（クォータ超過など）。全件を失敗として返す。
    keys.forEach(function (k) { out[k] = { sent: false, reason: e.message }; });
    return out;
  }

  responses.forEach(function (res, i) {
    const code = res.getResponseCode();
    out[keys[i]] = (code >= 200 && code < 300)
      ? { sent: true, reason: '' }
      : { sent: false, reason: 'Chat送信に失敗（HTTP ' + code + '）: ' + res.getContentText() };
  });
  return out;
}

// 職員スペースの Webhook URL を取得する（未設定なら例外）
function getStaffSpaceWebhook_() {
  const url = PropertiesService.getScriptProperties().getProperty(PROP_STAFF_WEBHOOK);
  if (!url) throw new Error('スクリプトプロパティ ' + PROP_STAFF_WEBHOOK + ' が未設定です。');
  return url;
}

// 職員スペースの Webhook URL（未設定でも例外にせず空文字を返す版）。
// 一括送信の宛先リストを組み立てる側で「未設定」も1件の失敗として扱えるようにする。
function getStaffSpaceWebhookOrEmpty_() {
  return String(PropertiesService.getScriptProperties().getProperty(PROP_STAFF_WEBHOOK) || '').trim();
}

/**
 * staff_id → webhook_url のマップを1回の読み取りで作る（backlog 10-10）。
 * 従来は候補1人ごとに getStaffWebhook_ → findRow → contacts 全読みで、
 * 候補n人なら contacts をn回読んでいた。
 */
function buildWebhookMap_() {
  const map = {};
  readRows(SHEET.CONTACTS).forEach(function (c) {
    map[String(c.staff_id).trim()] = String(c.webhook_url || '').trim();
  });
  return map;
}

// スタッフ個人の Webhook URL を連絡先DBから取得する（無ければ空文字）
function getStaffWebhook_(staffId) {
  return buildWebhookMap_()[String(staffId).trim()] || '';
}

// ─── 欠員通知（メイン）──────────────────────────────────────

/**
 * 欠員1件について、職員スペースと代行候補者へ通知を送る。
 * 候補者には回答画面（respond）への個別リンクを添える。
 * 送信後 vacancies.notify_status を更新する。
 *
 * @param  {string}  vacancyId
 * @param  {boolean} [reopened]  再オープンによる再募集なら true（文言に「再募集」を付す・backlog 10-4）
 * @return {{staff:boolean, candidates:Array, errors:Array, notify_status:string}}
 */
function notifyNewVacancy(vacancyId, reopened) {
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
  const tag = reopened ? '（再募集）' : '';

  // 職員スペースと全候補者への送信を1回の fetchAll にまとめる（backlog 10-10）
  const targets = [];

  // 1) 職員スペース宛
  const staffMsg =
    '🚨 *欠員が発生しました' + tag + '*\n' +
    '日付: ' + dateText + '\n' +
    'コマ: ' + slot + (timeText ? '（' + timeText + '）' : '') + '\n' +
    '欠勤: ' + absentName + '\n' +
    '欠員ID: ' + vacancyId + '\n' +
    '対応状況は管理画面で確認してください。';
  const staffSpaceUrl = getStaffSpaceWebhookOrEmpty_();
  if (staffSpaceUrl) {
    targets.push({ key: STAFF_SPACE_KEY_, url: staffSpaceUrl, text: staffMsg });
  } else {
    result.errors.push('職員スペース: スクリプトプロパティ ' + PROP_STAFF_WEBHOOK + ' が未設定です。');
  }

  // 2) 代行候補者宛（当日のダブルブッキングも除外）
  const candidates = findCandidates_(course, [course.staff_a_id, course.staff_b_id], vacancy.date);
  const webhookById = buildWebhookMap_();
  candidates.forEach(function (cand) {
    const sid = String(cand.staff_id).trim();
    result.candidates.push({ staff_id: cand.staff_id, name: cand.name, sent: false, reason: '' });
    targets.push({
      key: sid,
      url: webhookById[sid] || '',
      text:
        cand.name + ' さん\n' +
        '代行のお願いです' + tag + '。下記コマで欠員が出ました。\n' +
        '日付: ' + dateText + '\n' +
        'コマ: ' + slot + (timeText ? '（' + timeText + '）' : '') + '\n' +
        '対応可能か、こちらから回答してください:\n' + respondUrl,
    });
  });

  // 送信（並列）→ 結果を各エントリへ反映
  const sendResult = postToWebhooks_(targets);
  const staffSend = sendResult[STAFF_SPACE_KEY_];
  if (staffSend) {
    result.staff = staffSend.sent;
    if (!staffSend.sent) result.errors.push('職員スペース: ' + staffSend.reason);
  }
  result.candidates.forEach(function (entry) {
    const r = sendResult[String(entry.staff_id).trim()];
    if (!r) return;
    entry.sent = r.sent;
    entry.reason = r.reason;
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

  // 職員スペース・確定者・他候補への送信を1回の fetchAll にまとめる（backlog 10-10）
  const webhookById = buildWebhookMap_();
  const targets = [];

  // 1) 職員スペースへ「補充済」
  const staffSpaceUrl = getStaffSpaceWebhookOrEmpty_();
  if (staffSpaceUrl) {
    targets.push({
      key: STAFF_SPACE_KEY_,
      url: staffSpaceUrl,
      text:
        '✅ *欠員が補充されました*\n' +
        '日付: ' + dateText + '\n' +
        'コマ: ' + slot + (timeText ? '（' + timeText + '）' : '') + '\n' +
        '代行: ' + subName + '\n' +
        '欠員ID: ' + vacancyId,
    });
  } else {
    result.errors.push('職員スペース: スクリプトプロパティ ' + PROP_STAFF_WEBHOOK + ' が未設定です。');
  }

  // 2) 確定した本人へ（Webhook未登録なら従来どおり黙って送らない）
  const subUrl = webhookById[subId] || '';
  if (subUrl) {
    targets.push({
      key: subId,
      url: subUrl,
      text:
        subName + ' さん\n' +
        '代行が確定しました。ご協力ありがとうございます。\n' +
        '日付: ' + dateText + '\n' +
        'コマ: ' + slot + (timeText ? '（' + timeText + '）' : ''),
    });
  }

  // 3) 他の候補者へ「募集終了」（当日のダブルブッキングも除外）
  const candidates = findCandidates_(course, [course.staff_a_id, course.staff_b_id], vacancy.date);
  candidates.forEach(function (cand) {
    const sid = String(cand.staff_id).trim();
    if (sid === subId) return; // 確定本人は除外（キーの衝突も起きない）
    result.others.push({ staff_id: cand.staff_id, name: cand.name, sent: false, reason: '' });
    targets.push({
      key: sid,
      url: webhookById[sid] || '',
      text:
        cand.name + ' さん\n' +
        '先ほどの代行募集は他の方で補充が決まりました。ご確認ありがとうございました。\n' +
        '日付: ' + dateText + '\n' +
        'コマ: ' + slot,
    });
  });

  // 送信（並列）→ 結果を各エントリへ反映
  const sendResult = postToWebhooks_(targets);
  const staffSend = sendResult[STAFF_SPACE_KEY_];
  if (staffSend) {
    result.staff = staffSend.sent;
    if (!staffSend.sent) result.errors.push('職員スペース: ' + staffSend.reason);
  }
  const subSend = subUrl ? sendResult[subId] : null;
  if (subSend) {
    result.substitute = subSend.sent;
    if (!subSend.sent) result.errors.push('確定者: ' + subSend.reason);
  }
  result.others.forEach(function (entry) {
    const r = sendResult[String(entry.staff_id).trim()];
    if (!r) return;
    entry.sent = r.sent;
    entry.reason = r.reason;
  });

  return result;
}

// ─── 手動決着の通知（職員対応 / 1人テイク・review #8）──────

/**
 * 代行者なしで決着（1人テイク / 職員対応）したことを候補者へ知らせる。
 * 先着自動確定（notifyVacancyFilled）と挙動を対称にし、候補が放置されないようにする。
 *
 * @param  {string} vacancyId
 * @param  {string} resultLabel  '1人テイク' / '職員対応'
 * @return {{others:Array, errors:Array}}
 */
function notifyVacancyClosed(vacancyId, resultLabel) {
  const vacancy = findRow(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  if (!vacancy) throw new Error('対象の欠員が見つかりません。');
  const course = findRow(SHEET.COURSES, 'course_id', vacancy.course_id);
  if (!course) throw new Error('対象のコマが見つかりません。');

  const periodById = buildPeriodMap_();
  const p = periodById[String(course.period).trim()] || {};
  const timeText = p.start_time ? p.start_time + '〜' + p.end_time : '';
  const dateText = dateToStr_(vacancy.date);
  const slot = String(course.day).trim() + String(course.period).trim() + '限';

  const result = { others: [], errors: [] };
  const candidates = findCandidates_(course, [course.staff_a_id, course.staff_b_id], vacancy.date);
  const webhookById = buildWebhookMap_();
  const targets = candidates.map(function (cand) {
    const sid = String(cand.staff_id).trim();
    result.others.push({ staff_id: cand.staff_id, name: cand.name, sent: false, reason: '' });
    return {
      key: sid,
      url: webhookById[sid] || '',
      text:
        cand.name + ' さん\n' +
        '先ほどの代行募集は「' + resultLabel + '」で締め切られました。ご確認ありがとうございました。\n' +
        '日付: ' + dateText + '\n' +
        'コマ: ' + slot + (timeText ? '（' + timeText + '）' : ''),
    };
  });

  const sendResult = postToWebhooks_(targets); // 一括送信（backlog 10-10）
  result.others.forEach(function (entry) {
    const r = sendResult[String(entry.staff_id).trim()];
    if (!r) return;
    entry.sent = r.sent;
    entry.reason = r.reason;
  });
  return result;
}

/**
 * 再オープンで代行確定が解除されたことを、元の確定者へ知らせる（review 3次レビュー）。
 * 「補充済（先着/手動）」を再オープンしたとき、確定通知を受けた本人へ解除を伝え、
 * 入る気のまま放置されないようにする（#8 の挙動対称性に揃える）。
 *
 * @param  {string} vacancyId
 * @param  {string} substituteStaffId  解除された元の代行者
 * @return {{sent:boolean, reason:string}}
 */
function notifySubstituteReleased(vacancyId, substituteStaffId) {
  const vacancy = findRow(SHEET.VACANCIES, 'vacancy_id', vacancyId);
  if (!vacancy) throw new Error('対象の欠員が見つかりません。');
  const course = findRow(SHEET.COURSES, 'course_id', vacancy.course_id);
  if (!course) throw new Error('対象のコマが見つかりません。');

  const periodById = buildPeriodMap_();
  const p = periodById[String(course.period).trim()] || {};
  const timeText = p.start_time ? p.start_time + '〜' + p.end_time : '';
  const dateText = dateToStr_(vacancy.date);
  const slot = String(course.day).trim() + String(course.period).trim() + '限';
  const name = buildNameMap_()[String(substituteStaffId).trim()] || substituteStaffId;

  const url = getStaffWebhook_(substituteStaffId);
  if (!url) return { sent: false, reason: 'Webhook未登録' };

  const msg =
    name + ' さん\n' +
    'さきほど確定していた代行は解除されました（再調整中です）。\n' +
    '日付: ' + dateText + '\n' +
    'コマ: ' + slot + (timeText ? '（' + timeText + '）' : '') + '\n' +
    '欠員ID: ' + vacancyId;
  try {
    postToWebhook_(url, msg);
    return { sent: true, reason: '' };
  } catch (e) {
    return { sent: false, reason: e.message };
  }
}

/**
 * 代行者なしで自動決着したことを職員スペースへ知らせる（review #4）。
 * 候補へ依頼を送っていないケースなので個別通知の宛先は無く、職員への一報のみ。
 *
 * @param  {string} vacancyId
 * @param  {string} resultLabel  '1人テイク' / '職員対応'
 * @param  {string} [reason]     AUTO_RESOLVE_REASON。PAST_DEADLINE なら「直前欠勤」の文面にする
 * @return {{staff:boolean, errors:Array}}
 */
function notifyAutoResolved(vacancyId, resultLabel, reason) {
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

  // 直前欠勤（締切超過で募集を行わなかった）は、候補不在とは原因も職員の動き方も違うので文面を分ける。
  const late = reason === AUTO_RESOLVE_REASON.PAST_DEADLINE;
  const msg =
    (late ? '⏰ *直前の欠勤連絡です（代行募集なし）*\n' : '⚠️ *補充候補がいませんでした*\n') +
    '日付: ' + dateText + '\n' +
    'コマ: ' + slot + (timeText ? '（' + timeText + '）' : '') + '\n' +
    '欠勤: ' + absentName + '\n' +
    (late
      ? '→ 授業開始' + RECRUIT_DEADLINE_MIN_BEFORE + '分前を過ぎているため、代行候補への依頼は送っていません。\n'
      : '') +
    '→ 自動で「' + resultLabel + '」に設定しました。変更が必要なら管理画面で対応してください。\n' +
    '欠員ID: ' + vacancyId;

  const result = { staff: false, errors: [] };
  try {
    postToWebhook_(getStaffSpaceWebhook_(), msg);
    result.staff = true;
  } catch (e) {
    result.errors.push('職員スペース: ' + e.message);
  }
  try {
    updateRow(SHEET.VACANCIES, 'vacancy_id', vacancyId, { notify_status: NOTIFY_STATUS.DONE });
  } catch (e) {
    result.errors.push('ステータス更新: ' + e.message);
  }
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
