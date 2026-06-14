/**
 * 初回セットアップ用スクリプト
 * GASエディタから setupSpreadsheets() を1回だけ実行する。
 * 実行後、ログに表示された2つのIDをPropertiesServiceに登録すること。
 */

function setupSpreadsheets() {
  // 再実行ガード：既にIDが登録済みなら中断する（スプレッドシート二重作成を防止）
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SPREADSHEET_ID') || props.getProperty('CONTACTS_SPREADSHEET_ID')) {
    Logger.log('⚠️ 既にスプレッドシートIDが登録されています。再作成は中止しました。');
    Logger.log('作り直す場合はスクリプトプロパティのID2件を削除してから再実行してください。');
    return;
  }

  const mainDb = SpreadsheetApp.create('支援室シフト管理 - メインDB');
  setupMainDb_(mainDb);

  const contactsDb = SpreadsheetApp.create('支援室シフト管理 - 連絡先DB');
  setupContactsDb_(contactsDb);

  Logger.log('========== セットアップ完了 ==========');
  Logger.log('【SPREADSHEET_ID】メインDB:      ' + mainDb.getId());
  Logger.log('【CONTACTS_SPREADSHEET_ID】連絡先DB: ' + contactsDb.getId());
  Logger.log('上記IDをGASエディタ > プロジェクトの設定 > スクリプトプロパティに登録してください。');
  Logger.log('連絡先DBは職員のみ共有してください（スプレッドシートの共有設定で制限）。');
}

// ─── メインDB ────────────────────────────────────────────────

function setupMainDb_(ss) {
  const staffsSheet = ss.getActiveSheet();
  staffsSheet.setName('staffs');
  staffsSheet.getRange(1, 1, 1, 4).setValues([['staff_id', 'name', 'role', 'available_slots']]);
  staffsSheet.getRange(2, 1, 3, 4).setValues([
    ['S001', '山田 花子', '職員', ''],
    ['S002', '田中 太郎', '学生', '月1,月2,火3,水1'],
    ['S003', '鈴木 次郎', '学生', '火1,火2,木3,金2'],
  ]);

  const coursesSheet = ss.insertSheet('courses');
  coursesSheet.getRange(1, 1, 1, 6).setValues([
    ['course_id', 'quarter', 'day', 'period', 'staff_a_id', 'staff_b_id'],
  ]);
  // period 列（D列）は periods シートと突合するためテキスト固定
  coursesSheet.getRange(2, 4, 2, 1).setNumberFormat('@');
  coursesSheet.getRange(2, 1, 2, 6).setValues([
    ['C001', '2026-Q3', '月', '1', 'S002', 'S003'],
    ['C002', '2026-Q3', '火', '2', 'S002', 'S003'],
  ]);

  const vacanciesSheet = ss.insertSheet('vacancies');
  vacanciesSheet.getRange(1, 1, 1, 7).setValues([
    ['vacancy_id', 'date', 'course_id', 'absent_staff_id', 'notify_status', 'result', 'substitute_staff_id'],
  ]);

  const responsesSheet = ss.insertSheet('responses');
  responsesSheet.getRange(1, 1, 1, 4).setValues([
    ['vacancy_id', 'staff_id', 'answer', 'answered_at'],
  ]);

  const periodsSheet = ss.insertSheet('periods');
  periodsSheet.getRange(1, 1, 1, 3).setValues([['period', 'start_time', 'end_time']]);
  // period（数値型化を防ぐ）・start_time/end_time（時刻型化を防ぐ）を全てテキスト固定
  periodsSheet.getRange(2, 1, 7, 3).setNumberFormat('@');
  periodsSheet.getRange(2, 1, 7, 3).setValues([
    ['1', '09:15', '11:00'],
    ['2', '11:15', '12:30'],
    ['3', '13:30', '15:00'],
    ['4', '15:15', '16:45'],
    ['5', '16:55', '18:25'],
    ['6', '18:35', '20:05'],
    ['7', '20:10', '21:40'],
  ]);

  applyHeaderStyle_(
    [staffsSheet, coursesSheet, vacanciesSheet, responsesSheet, periodsSheet],
    '#4a86e8'
  );
}

// ─── 連絡先DB ────────────────────────────────────────────────

function setupContactsDb_(ss) {
  const contactsSheet = ss.getActiveSheet();
  contactsSheet.setName('contacts');
  contactsSheet.getRange(1, 1, 1, 5).setValues([
    ['staff_id', 'name', 'email', 'phone', 'webhook_url'],
  ]);
  // phone 列（D列）は先頭0欠落・数値化を防ぐためテキスト固定
  contactsSheet.getRange(2, 4, 3, 1).setNumberFormat('@');
  // ダミーデータ（実運用前に差し替える）
  contactsSheet.getRange(2, 1, 3, 5).setValues([
    ['S001', '山田 花子', 'yamada@example.ryukoku.ac.jp', '000-0000-0001', ''],
    ['S002', '田中 太郎', 'tanaka@example.ryukoku.ac.jp', '000-0000-0002', ''],
    ['S003', '鈴木 次郎', 'suzuki@example.ryukoku.ac.jp', '000-0000-0003', ''],
  ]);

  applyHeaderStyle_([contactsSheet], '#cc0000');
}

// ─── 共通：ヘッダー書式 ──────────────────────────────────────

function applyHeaderStyle_(sheets, bgColor) {
  sheets.forEach(function (sheet) {
    var lastCol = sheet.getLastColumn();
    if (lastCol < 1) return;
    var header = sheet.getRange(1, 1, 1, lastCol);
    header.setFontWeight('bold');
    header.setBackground(bgColor);
    header.setFontColor('#ffffff');
    sheet.setFrozenRows(1);
    sheet.setColumnWidths(1, lastCol, 160);
  });
}
