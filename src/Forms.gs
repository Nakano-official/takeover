/**
 * フォーム連携 — 学生スタッフの「空きコマ＋連絡先」フォームをDBへ自動反映する
 *
 * 学生は1つのフォームに回答する（セクション①空きコマ ②連絡先）。
 * 回答はクォーター毎の再収集で、フォームを「正」として上書きする。
 *
 * 振り分け（ファンアウト）:
 *  - 空きコマ・スキル        → staffs（メインDB）available_slots / skills
 *  - 電話番号・Webhook URL   → contacts（連絡先DB・職員のみ）phone / webhook_url
 *
 * 照合キー: フォームが自動収集する「メールアドレス」を contacts.email に突き合わせ、
 *           名簿（先に登録済み）に一致した staff_id の行だけを更新する。
 *           名簿に無いメールは反映しない（学外・無関係な学内ユーザーの混入防止）。
 *
 * 前提:
 *  - フォームの回答先を「連絡先DB（職員のみ）」のスプレッドシートにリンクすること
 *    （回答に Webhook URL・電話番号という秘密/個人情報が含まれるため）。
 *  - 下の TITLE 定数を、フォームの設問名と完全一致させること（変えたらここを直す）。
 *  - 設置は installIntakeTrigger() を一度だけGASエディタから実行する。
 *
 * 公開関数:
 *  - onIntakeFormSubmit(e)  : フォーム送信トリガーで起動（自動）
 *  - installIntakeTrigger() : 連絡先DBに onFormSubmit トリガーを設置（手動・1回）
 *  - testIntakeMapping()    : 設問→値のマッピングをログ確認（手動）
 */

// ─── フォームの設問名（フォーム側と完全一致させる）────────────────
// メール自動収集ONのとき、回答シートの列見出しは「メールアドレス」になる
const Q_EMAIL = 'メールアドレス';
// セクション②連絡先
const Q_PHONE = '電話番号';
const Q_WEBHOOK = 'Google Chat Webhook URL';
// セクション①空きコマ（曜日ごとのチェックボックス。選択肢は「1限」〜「7限」）。
// 設問の曜日集合は WORK_DAYS（Constants.gs）を単一の出所とし、設問名は day+WORK_DAY_SLOT_Q_SUFFIX で
// 導出する。土曜運用の有効化は WORK_DAYS に '土' を足すだけで入力画面と同時に揃う（backlog 10-5）。
// スキル（チェックボックス。選択肢は「テイク」「介助」）
const Q_SKILLS = '対応できる業務';

// ─── トリガー本体 ────────────────────────────────────────────

/**
 * フォーム送信時に起動。回答1件を staffs / contacts へ振り分けて反映する。
 * 連絡先DB（回答先スプレッドシート）に対する onFormSubmit インストール型トリガーで呼ばれる。
 */
function onIntakeFormSubmit(e) {
  try {
    if (!e || !e.namedValues) { Logger.log('[intake] イベント不正（namedValues なし）'); return; }
    const nv = e.namedValues;

    const email = firstValue_(nv, Q_EMAIL).toLowerCase();
    if (!email) { Logger.log('[intake] メール未取得。メール自動収集がONか確認。'); return; }

    // 名簿（contacts）にメールで照合
    const contacts = readRows(SHEET.CONTACTS);
    var contact = null;
    for (var i = 0; i < contacts.length; i++) {
      if (String(contacts[i].email).trim().toLowerCase() === email) { contact = contacts[i]; break; }
    }
    if (!contact) {
      Logger.log('[intake] 未登録のメール（名簿に無し）：' + email + ' → 反映せず（要・名簿登録）');
      return;
    }
    const staffId = String(contact.staff_id).trim();

    const slots = buildSlots_(nv);
    const skills = buildSkills_(nv);
    const phone = firstValue_(nv, Q_PHONE);
    const webhook = firstValue_(nv, Q_WEBHOOK);

    // 空きコマはクォーター再収集の上書き（フォームが正。未選択＝今期は空き無し）。
    // skills は「無回答」と「全対応」を区別できないため、空送信では上書きしない
    // （空欄＝全対応扱いのため、未チェック送信で介助専門者にテイク依頼が飛ぶのを防ぐ／Vacancy.gs）。
    const cuStaff = { available_slots: slots };
    if (skills) cuStaff.skills = skills;
    const okStaff = updateRow(SHEET.STAFFS, 'staff_id', staffId, cuStaff);
    if (!okStaff) {
      Logger.log('[intake] staffs に staff_id=' + staffId + ' の行が無く更新できず（要・staffs登録）');
    }

    // 電話・Webhook は入力があったときだけ上書き（空送信で既存を消さない）。
    // Webhook は宛先誤り防止のため Google Chat の URL 形式のときだけ反映する。
    const cu = {};
    if (phone) cu.phone = phone;
    if (webhook && isChatWebhook_(webhook)) {
      cu.webhook_url = webhook;
    } else if (webhook) {
      Logger.log('[intake] Webhook URL の形式が不正のため反映せず：' + webhook);
    }
    if (Object.keys(cu).length) updateRow(SHEET.CONTACTS, 'staff_id', staffId, cu);

    Logger.log('[intake] 反映OK: ' + staffId
      + ' / slots=[' + slots + ']'
      + ' / skills=' + (skills ? '[' + skills + ']' : '据置')
      + ' / phone=' + (phone ? '更新' : '据置')
      + ' / webhook=' + (cu.webhook_url ? '更新' : '据置'));
  } catch (err) {
    Logger.log('[intake] エラー: ' + err.message);
  }
}

// ─── 値の組み立て ────────────────────────────────────────────

// 曜日別チェックボックス（'1限','3限' …）を 'month1,day3' 形式（例：月1,水3）に組む。
// 対象曜日と設問名は WORK_DAYS / WORK_DAY_SLOT_Q_SUFFIX（Constants.gs）から関数内で導出する。
function buildSlots_(nv) {
  const out = [];
  WORK_DAYS.forEach(function (day) {
    const arr = nv[day + WORK_DAY_SLOT_Q_SUFFIX] || [];
    const periods = [];
    arr.forEach(function (v) {
      String(v).split(',').forEach(function (tok) {
        const m = String(tok).match(/(\d+)/);
        if (m) periods.push(parseInt(m[1], 10));
      });
    });
    periods.sort(function (a, b) { return a - b; });
    periods.forEach(function (p) { out.push(day + p); });
  });
  return out.join(',');
}

// スキルのチェック（テイク/介助）を 'テイク,介助' に正規化
function buildSkills_(nv) {
  const arr = nv[Q_SKILLS] || [];
  const set = [];
  arr.forEach(function (v) {
    String(v).split(',').forEach(function (tok) {
      const t = tok.trim();
      if (t && set.indexOf(t) === -1) set.push(t);
    });
  });
  return ['テイク', '介助'].filter(function (x) { return set.indexOf(x) !== -1; }).join(',');
}

// namedValues から先頭値を文字列で取り出す
function firstValue_(nv, key) {
  return (nv[key] && nv[key][0] != null) ? String(nv[key][0]).trim() : '';
}

// Google Chat の Incoming Webhook URL 形式かどうか（誤URL・別宛先の混入防止）
function isChatWebhook_(url) {
  return /^https:\/\/chat\.googleapis\.com\//.test(String(url).trim());
}

// ─── 設置・テスト ────────────────────────────────────────────

/**
 * 連絡先DB（フォームの回答先スプレッドシート）に onFormSubmit トリガーを設置する。
 * 二重設置を避けるため既存の同名トリガーは削除してから作り直す。GASエディタから1回実行。
 */
function installIntakeTrigger() {
  const id = PropertiesService.getScriptProperties().getProperty('CONTACTS_SPREADSHEET_ID');
  if (!id) throw new Error('スクリプトプロパティ CONTACTS_SPREADSHEET_ID が未設定です。');

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'onIntakeFormSubmit') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('onIntakeFormSubmit')
    .forSpreadsheet(SpreadsheetApp.openById(id))
    .onFormSubmit()
    .create();
  Logger.log('✅ onIntakeFormSubmit トリガーを連絡先DBに設置しました（フォームの回答先がこのDBであること）。');
}

/**
 * 設問→値のマッピングを実データ無しで確認する（GASエディタから手動実行→ログ確認）。
 */
function testIntakeMapping() {
  // 実際の namedValues はチェックボックスを「カンマ結合の単一文字列」で渡す
  // （例: '1限, 3限'）。配列形式と両方を通せることを確認する。
  const nv = {
    'メールアドレス': ['S010@mail.ryukoku.ac.jp'],
    '月曜の空きコマ': ['1限, 3限'],     // 本番形式：カンマ結合
    '水曜の空きコマ': ['2限'],
    '対応できる業務': ['テイク, 介助'],  // 本番形式：カンマ結合
    '電話番号': ['090-1111-2222'],
    'Google Chat Webhook URL': ['https://chat.googleapis.com/v1/spaces/XXX/messages?key=...&token=...'],
  };
  Logger.log('email  = ' + firstValue_(nv, Q_EMAIL));
  Logger.log('slots  = ' + buildSlots_(nv));   // 期待: 月1,月3,水2
  Logger.log('skills = ' + buildSkills_(nv));  // 期待: テイク,介助
  Logger.log('phone  = ' + firstValue_(nv, Q_PHONE));
  Logger.log('webhook= ' + firstValue_(nv, Q_WEBHOOK));

  // Webhook 形式チェック（正しい Chat URL のみ true）
  Logger.log('webhook valid(Chat)   = ' + isChatWebhook_('https://chat.googleapis.com/v1/spaces/X/messages?key=k'));  // true
  Logger.log('webhook valid(他URL)  = ' + isChatWebhook_('https://example.com/hook'));  // false
}
