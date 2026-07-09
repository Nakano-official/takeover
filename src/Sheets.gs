/**
 * 共通シート操作レイヤー
 *
 * 全画面・全ロジックはこのファイルの関数を経由してスプレッドシートにアクセスする。
 * 各所で直接 SpreadsheetApp を呼ばないこと（アクセス経路を1か所に集約するため）。
 *
 * 設計方針：
 *  - シートは「ヘッダー名 → 値」のオブジェクト配列として読む（列順に依存しない）
 *  - 書き込みは必ず LockService で保護する（同時回答などの競合対策）
 *  - メインDB / 連絡先DB の振り分けはこのファイル内で吸収する
 */

// シート名の定数（タイプミス防止のため文字列を直書きしない）
const SHEET = {
  STAFFS: 'staffs',
  COURSES: 'courses',
  VACANCIES: 'vacancies',
  RESPONSES: 'responses',
  PERIODS: 'periods',
  CONTACTS: 'contacts',
};

// 連絡先DBに属するシート（これ以外はメインDB扱い）
const CONTACTS_DB_SHEETS = [SHEET.CONTACTS];

// 書き込みロックの最大待機時間（ミリ秒）
const LOCK_TIMEOUT_MS = 15000;

// ─── スプレッドシートを開く ──────────────────────────────────

function openMainDb_() {
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('スクリプトプロパティ SPREADSHEET_ID が未設定です。');
  return SpreadsheetApp.openById(id);
}

function openContactsDb_() {
  const id = PropertiesService.getScriptProperties().getProperty('CONTACTS_SPREADSHEET_ID');
  if (!id) throw new Error('スクリプトプロパティ CONTACTS_SPREADSHEET_ID が未設定です。');
  return SpreadsheetApp.openById(id);
}

// シート名から対象シートを取得する（DBの振り分けを内部で吸収）
function getSheet_(sheetName) {
  const ss = CONTACTS_DB_SHEETS.indexOf(sheetName) !== -1 ? openContactsDb_() : openMainDb_();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('シートが見つかりません：' + sheetName);
  return sheet;
}

// ─── 読み取り ────────────────────────────────────────────────

/**
 * シート全行を「ヘッダー名 → 値」のオブジェクト配列で返す。
 * 1行目をヘッダーとして扱い、完全に空の行は除外する。
 */
function readRows(sheetName) {
  const sheet = getSheet_(sheetName);
  const values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];

  const headers = values[0];
  const rows = [];
  for (var r = 1; r < values.length; r++) {
    const raw = values[r];
    if (isEmptyRow_(raw)) continue;
    const obj = {};
    for (var c = 0; c < headers.length; c++) {
      obj[headers[c]] = raw[c];
    }
    rows.push(obj);
  }
  return rows;
}

/**
 * 指定カラムが value と一致する最初の行を返す。なければ null。
 * 比較は文字列化して行う（ID等の型ゆれを吸収）。
 */
function findRow(sheetName, columnName, value) {
  const rows = readRows(sheetName);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][columnName]).trim() === String(value).trim()) return rows[i];
  }
  return null;
}

/**
 * 指定カラムが value と一致する全行を返す。
 */
function filterRows(sheetName, columnName, value) {
  return readRows(sheetName).filter(function (row) {
    return String(row[columnName]).trim() === String(value).trim();
  });
}

// ─── 書き込み（LockService 保護）─────────────────────────────

/**
 * 1行を追記する。rowObject はヘッダー名をキーに持つオブジェクト。
 * ヘッダーに無いキーは無視し、足りないキーは空文字で埋める。
 */
function appendRow(sheetName, rowObject) {
  return withLock_(function () {
    const sheet = getSheet_(sheetName);
    const headers = getHeaders_(sheet);
    const row = headers.map(function (h) {
      return rowObject[h] !== undefined && rowObject[h] !== null ? rowObject[h] : '';
    });
    sheet.appendRow(row);
    return true;
  });
}

/**
 * keyColumn が keyValue と一致する行を、updates の内容で部分更新する。
 * updates に含まれるカラムのみ書き換える。更新できたら true、対象が無ければ false。
 */
function updateRow(sheetName, keyColumn, keyValue, updates) {
  return withLock_(function () {
    const sheet = getSheet_(sheetName);
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const keyIdx = headers.indexOf(keyColumn);
    if (keyIdx === -1) throw new Error('キー列が存在しません：' + keyColumn);

    for (var r = 1; r < values.length; r++) {
      if (String(values[r][keyIdx]).trim() !== String(keyValue).trim()) continue;
      for (var c = 0; c < headers.length; c++) {
        if (updates[headers[c]] !== undefined) {
          sheet.getRange(r + 1, c + 1).setValue(updates[headers[c]]);
        }
      }
      return true;
    }
    return false;
  });
}

/**
 * 条件付き更新（compare-and-set）の共通実装。
 * keyColumn=keyValue の行について、guardColumn の現在値が mode を満たすときだけ updates を書き込む。
 *   mode='empty'    : guardColumn が空のときだけ書く（先着確保）
 *   mode='notEmpty' : guardColumn が非空のときだけ書く（確定の取り消し＝再オープン等）
 * 判定と書き込みを同一ロック内で atomically 行うため、複数の書き手が競合しても
 * 条件を満たした最初の1回だけが適用され、残りは applied=false になる（decisions.md D1）。
 *
 * @return {{ok:boolean, applied:boolean, current:(Object|null)}}
 *   ok=false            : 対象行が見つからない
 *   applied=true        : 条件を満たし updates を書き込んだ（current は書き込み前スナップショット）
 *   applied=false       : 条件を満たさず未書き込み（current に現在の行内容）
 */
function updateRowIfGuard_(sheetName, keyColumn, keyValue, guardColumn, mode, updates) {
  return withLock_(function () {
    const sheet = getSheet_(sheetName);
    const values = sheet.getDataRange().getValues();
    const headers = values[0];
    const keyIdx = headers.indexOf(keyColumn);
    const guardIdx = headers.indexOf(guardColumn);
    if (keyIdx === -1) throw new Error('キー列が存在しません：' + keyColumn);
    if (guardIdx === -1) throw new Error('ガード列が存在しません：' + guardColumn);

    for (var r = 1; r < values.length; r++) {
      if (String(values[r][keyIdx]).trim() !== String(keyValue).trim()) continue;

      // 書き込み前の行内容（誰が先約か・旧値は何か等を呼び出し側へ返すため）
      const current = {};
      for (var c = 0; c < headers.length; c++) current[headers[c]] = values[r][c];

      // guard 条件を満たさなければ未書き込みで返す
      const guardFilled = !!String(values[r][guardIdx]).trim();
      const satisfies = (mode === 'empty') ? !guardFilled : guardFilled;
      if (!satisfies) {
        return { ok: true, applied: false, current: current };
      }

      // 条件を満たすので updates を書き込む
      for (var c2 = 0; c2 < headers.length; c2++) {
        if (updates[headers[c2]] !== undefined) {
          sheet.getRange(r + 1, c2 + 1).setValue(updates[headers[c2]]);
        }
      }
      return { ok: true, applied: true, current: current };
    }
    return { ok: false, applied: false, current: null };
  });
}

/**
 * 先着確保（compare-and-set）。guardColumn が「空」のときだけ updates を書き込む。
 * 複数人が同時に承諾しても先に入った1人だけが確保でき、残りは claimed=false（先約あり）になる。
 * 実体は updateRowIfGuard_（mode='empty'）。従来の戻り値（claimed）を保つラッパー。
 *
 * @return {{ok:boolean, claimed:boolean, current:(Object|null)}}
 *   ok=false              : 対象行が見つからない
 *   ok=true, claimed=true : 確保成功（先着でこの呼び出しが書き込んだ）
 *   ok=true, claimed=false: 既に guardColumn が埋まっていた（current に確保前の行内容）
 */
function claimIfEmpty(sheetName, keyColumn, keyValue, guardColumn, updates) {
  const res = updateRowIfGuard_(sheetName, keyColumn, keyValue, guardColumn, 'empty', updates);
  return { ok: res.ok, claimed: res.applied, current: res.current };
}

// ─── ID採番 ──────────────────────────────────────────────────

/**
 * prefix 付き連番IDを生成する（例：V001, V002）。
 * 既存の idColumn の最大連番+1 を採番する。LockService 内で呼ぶこと前提。
 */
function nextId_(sheetName, idColumn, prefix) {
  const rows = readRows(sheetName);
  var max = 0;
  rows.forEach(function (row) {
    const id = String(row[idColumn]);
    if (id.indexOf(prefix) === 0) {
      const n = parseInt(id.slice(prefix.length), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  });
  return prefix + ('000' + (max + 1)).slice(-3);
}

/**
 * 連番IDを採番しつつ1行を追記する。採番と追記を同一ロック内で行い競合を防ぐ。
 * rowObject の idColumn は自動採番で上書きする。生成したIDを返す。
 */
function appendRowWithId(sheetName, idColumn, prefix, rowObject) {
  return withLock_(function () {
    const id = nextId_(sheetName, idColumn, prefix);
    const sheet = getSheet_(sheetName);
    const headers = getHeaders_(sheet);
    const obj = {};
    for (var k in rowObject) obj[k] = rowObject[k];
    obj[idColumn] = id;
    const row = headers.map(function (h) {
      return obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
    });
    sheet.appendRow(row);
    return id;
  });
}

/**
 * matchObj の全カラムが一致する行を探し、あれば rowObject の内容で更新、
 * なければ matchObj + rowObject を1行として追記する（複合キーの upsert）。
 * responses（vacancy_id + staff_id で1件）のような複合キー更新に使う。
 * @return {'updated'|'inserted'}
 */
function upsertRow(sheetName, matchObj, rowObject) {
  return withLock_(function () {
    const sheet = getSheet_(sheetName);
    const values = sheet.getDataRange().getValues();
    const headers = values[0];

    // 書き込む値（キー＋更新内容をマージ）
    const merged = {};
    for (var mk in matchObj) merged[mk] = matchObj[mk];
    for (var rk in rowObject) merged[rk] = rowObject[rk];

    for (var r = 1; r < values.length; r++) {
      if (isEmptyRow_(values[r])) continue;
      if (rowMatches_(values[r], headers, matchObj)) {
        for (var c = 0; c < headers.length; c++) {
          if (merged[headers[c]] !== undefined) {
            sheet.getRange(r + 1, c + 1).setValue(merged[headers[c]]);
          }
        }
        return 'updated';
      }
    }
    const row = headers.map(function (h) {
      return merged[h] !== undefined && merged[h] !== null ? merged[h] : '';
    });
    sheet.appendRow(row);
    return 'inserted';
  });
}

/**
 * keyColumn が keyValue と一致する行を物理削除する。削除件数を返す。
 * 下の行から走査するため、複数一致でも行番号がずれず安全。LockServiceで保護。
 */
function deleteRowByKey(sheetName, keyColumn, keyValue) {
  return withLock_(function () {
    const sheet = getSheet_(sheetName);
    const values = sheet.getDataRange().getValues();
    const keyIdx = values[0].indexOf(keyColumn);
    if (keyIdx === -1) throw new Error('キー列が存在しません：' + keyColumn);
    var deleted = 0;
    for (var r = values.length - 1; r >= 1; r--) {
      if (String(values[r][keyIdx]).trim() === String(keyValue).trim()) {
        sheet.deleteRow(r + 1);
        deleted++;
      }
    }
    return deleted;
  });
}

// 行配列が matchObj の全カラムと一致するか
function rowMatches_(rowArr, headers, matchObj) {
  for (var key in matchObj) {
    var idx = headers.indexOf(key);
    if (idx === -1) return false;
    if (String(rowArr[idx]).trim() !== String(matchObj[key]).trim()) return false;
  }
  return true;
}

// ─── 内部ヘルパー ────────────────────────────────────────────

function getHeaders_(sheet) {
  return sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
}

function isEmptyRow_(row) {
  for (var i = 0; i < row.length; i++) {
    if (row[i] !== '' && row[i] !== null) return false;
  }
  return true;
}

// 関数を LockService で保護して実行する共通ラッパー
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ─── デバッグ用テスト ────────────────────────────────────────

/**
 * GASエディタから手動実行してデータアクセス層を検証する。
 * 実行後「実行ログ」を確認すること。実データは変更しない（テスト行は最後に削除）。
 */
function testSheets() {
  Logger.log('===== Sheets.gs 動作確認 開始 =====');

  // 1) プロパティ確認
  const props = PropertiesService.getScriptProperties();
  Logger.log('[プロパティ] SPREADSHEET_ID = ' + (props.getProperty('SPREADSHEET_ID') ? 'OK' : '未設定!'));
  Logger.log('[プロパティ] CONTACTS_SPREADSHEET_ID = ' + (props.getProperty('CONTACTS_SPREADSHEET_ID') ? 'OK' : '未設定!'));

  // 2) 各シートの読み取り件数
  Logger.log('--- readRows 件数 ---');
  [SHEET.STAFFS, SHEET.COURSES, SHEET.VACANCIES, SHEET.RESPONSES, SHEET.PERIODS, SHEET.CONTACTS].forEach(function (name) {
    try {
      Logger.log('  ' + name + ': ' + readRows(name).length + ' 件');
    } catch (e) {
      Logger.log('  ' + name + ': ❌ ' + e.message);
    }
  });

  // 3) staffs の中身サンプル
  const staffs = readRows(SHEET.STAFFS);
  Logger.log('--- staffs サンプル ---');
  staffs.forEach(function (s) {
    Logger.log('  ' + s.staff_id + ' / ' + s.name + ' / ' + s.role + ' / [' + s.available_slots + ']');
  });

  // 4) periods が時刻テキストとして読めているか（Date化していないか）
  Logger.log('--- periods 型チェック ---');
  readRows(SHEET.PERIODS).forEach(function (p) {
    const t = p.start_time;
    const type = (t instanceof Date) ? '⚠️Date型（要修正）' : typeof t;
    Logger.log('  ' + p.period + '限: ' + t + ' 〜 ' + p.end_time + '（型: ' + type + '）');
  });

  // 5) findRow / filterRows
  Logger.log('--- 検索テスト ---');
  const found = findRow(SHEET.STAFFS, 'staff_id', 'S002');
  Logger.log('  findRow S002 = ' + (found ? found.name : '見つからず'));
  Logger.log('  filterRows role=学生 = ' + filterRows(SHEET.STAFFS, 'role', '学生').length + ' 件');

  // 6) 書き込みテスト（vacancies にテスト行 → 削除）
  Logger.log('--- 書き込みテスト（追記→削除）---');
  try {
    const testId = '__TEST__' + new Date().getTime();
    appendRow(SHEET.VACANCIES, { vacancy_id: testId, date: '2026-06-12', notify_status: 'test' });
    const writeOk = findRow(SHEET.VACANCIES, 'vacancy_id', testId) !== null;
    Logger.log('  追記: ' + (writeOk ? 'OK' : '❌失敗'));
    deleteTestRow_(SHEET.VACANCIES, 'vacancy_id', testId);
    const cleanOk = findRow(SHEET.VACANCIES, 'vacancy_id', testId) === null;
    Logger.log('  テスト行削除: ' + (cleanOk ? 'OK' : '❌残存'));
  } catch (e) {
    Logger.log('  ❌ ' + e.message);
  }

  Logger.log('===== 動作確認 終了 =====');
}

// テスト専用：該当行を物理削除する（testSheets からのみ使用）
function deleteTestRow_(sheetName, keyColumn, keyValue) {
  withLock_(function () {
    const sheet = getSheet_(sheetName);
    const values = sheet.getDataRange().getValues();
    const keyIdx = values[0].indexOf(keyColumn);
    for (var r = values.length - 1; r >= 1; r--) {
      if (String(values[r][keyIdx]).trim() === String(keyValue).trim()) {
        sheet.deleteRow(r + 1);
      }
    }
  });
}
