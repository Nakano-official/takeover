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
 *  - 同じ実行の中では同じシートを何度読んでも API 往復は1回（実行内キャッシュ・下記）
 */

// シート名の定数（タイプミス防止のため文字列を直書きしない）
const SHEET = {
  STAFFS: 'staffs',
  COURSES: 'courses',
  VACANCIES: 'vacancies',
  RESPONSES: 'responses',
  PERIODS: 'periods',
  TERMS: 'terms',
  CONTACTS: 'contacts',
};

// 連絡先DBに属するシート（これ以外はメインDB扱い）
const CONTACTS_DB_SHEETS = [SHEET.CONTACTS];

// 書き込みロックの最大待機時間（ミリ秒）
const LOCK_TIMEOUT_MS = 15000;

// ─── 実行内キャッシュ（backlog 10-10）────────────────────────
//
// GAS の1実行は数秒で終わる短命プロセスだが、従来はシートを読むたびに
// SpreadsheetApp.openById() → getDataRange().getValues() を丸ごと走らせていた。
// 候補者が「承諾」を1タップする経路（respondToVacancy → isCandidate_ →
// notifyVacancyFilled）だけで同じシートを17回以上読み、さらに候補人数ぶん
// contacts を全読みしており、**先着確定（D1）の競合が起きるまさにその瞬間が
// 最も遅い**という状態だった（ロック待ち LOCK_TIMEOUT_MS=15秒に接近する）。
//
// そこで1実行の内側に限って以下をメモ化する：
//   - Spreadsheet / Sheet オブジェクト（openById の往復そのもの）
//   - シートの生データ（headers + values）
//
// 整合性の担保は「ロックを跨いだら必ず捨てる」の一点に集約する。withLock_ が
// 取得直後と解放直前にデータキャッシュを全消しするため、
//   (a) ロック内の読み取り（nextId_ の採番・CAS の現在値検証）は必ず実データを見る
//   (b) 自分の書き込み後は、次の読み取りで必ず最新を読み直す
// が保証される。キャッシュに乗るのはロック外の読み取り（画面表示・候補抽出・
// 通知文の組み立て）だけで、書き込み判断には一切使われない。
//
// ※ Sheets.gs を経由せず直接シートを書き換えるコード（Setup.js の各 migrate 等）は、
//    書き換え後に invalidateSheetCache_() を呼ぶこと。
// ※ readRows は毎回オブジェクトを組み直して返す（キャッシュしているのは生の値配列だけ）。
//    呼び出し側が戻り値を書き換えても他の呼び出しに影響しない。

var SS_CACHE_ = {};          // 'main' | 'contacts' → Spreadsheet
var SHEET_OBJ_CACHE_ = {};   // シート名 → Sheet
var SHEET_DATA_CACHE_ = {};  // シート名 → {headers, values}

/**
 * シートの生データキャッシュを捨てる。
 * @param {string} [sheetName] 省略時は全シート分を捨てる
 */
function invalidateSheetCache_(sheetName) {
  if (sheetName) delete SHEET_DATA_CACHE_[sheetName];
  else SHEET_DATA_CACHE_ = {};
}

// ─── スプレッドシートを開く ──────────────────────────────────

function openMainDb_() {
  if (SS_CACHE_.main) return SS_CACHE_.main;
  const id = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!id) throw new Error('スクリプトプロパティ SPREADSHEET_ID が未設定です。');
  SS_CACHE_.main = SpreadsheetApp.openById(id);
  return SS_CACHE_.main;
}

function openContactsDb_() {
  if (SS_CACHE_.contacts) return SS_CACHE_.contacts;
  const id = PropertiesService.getScriptProperties().getProperty('CONTACTS_SPREADSHEET_ID');
  if (!id) throw new Error('スクリプトプロパティ CONTACTS_SPREADSHEET_ID が未設定です。');
  SS_CACHE_.contacts = SpreadsheetApp.openById(id);
  return SS_CACHE_.contacts;
}

// シート名から対象シートを取得する（DBの振り分けを内部で吸収）
function getSheet_(sheetName) {
  if (SHEET_OBJ_CACHE_[sheetName]) return SHEET_OBJ_CACHE_[sheetName];
  const ss = CONTACTS_DB_SHEETS.indexOf(sheetName) !== -1 ? openContactsDb_() : openMainDb_();
  const sheet = ss.getSheetByName(sheetName);
  // 見つからないケースはキャッシュしない（Setup.js が実行中にシートを作ることがある）
  if (!sheet) throw new Error('シートが見つかりません：' + sheetName);
  SHEET_OBJ_CACHE_[sheetName] = sheet;
  return sheet;
}

// ─── 読み取り ────────────────────────────────────────────────

/**
 * シートの生データ（1行目＝ヘッダーを含む2次元配列）を返す。実行内でキャッシュする。
 * 戻り値の配列は共有物なので**書き換えないこと**（書き換えは各 write 系関数が行う）。
 * @return {{headers:Array, values:Array<Array>}}
 */
function readSheetData_(sheetName) {
  const cached = SHEET_DATA_CACHE_[sheetName];
  if (cached) return cached;
  const values = getSheet_(sheetName).getDataRange().getValues();
  const data = { headers: values.length ? values[0] : [], values: values };
  SHEET_DATA_CACHE_[sheetName] = data;
  return data;
}

/**
 * シート全行を「ヘッダー名 → 値」のオブジェクト配列で返す。
 * 1行目をヘッダーとして扱い、完全に空の行は除外する。
 * 生データはキャッシュを使うが、オブジェクトは毎回組み直すので呼び出し側で自由に扱える。
 */
function readRows(sheetName) {
  const data = readSheetData_(sheetName);
  const values = data.values;
  if (values.length < 2) return [];

  const headers = data.headers;
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
function appendRowValues_(sheet, sheetName, row) {
  // **appendRow ではなく setValues で書く。**
  //
  // Sheet.appendRow はセルの表示形式を無視して値を解釈し直すため、テキスト固定にした列でも
  // '2' が**数値 2**に、'2026-09-12' が**日付値**に化ける（courses.period / courses.date /
  // vacancies.date で実際に発生した）。読み取り側は String()・dateToStr_ で吸収しているので
  // 実害は出ていなかったが、型がぶれる経路を残す理由がない。
  // setValues はセルの表示形式に従うので、テキスト固定の列へ入れた文字列は文字列のまま残る
  // （ダミーデータを書く writeTable_ が setValues で、そちらは全て文字列で入っていた）。
  const rowNumber = sheet.getLastRow() + 1;
  sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  return rowNumber;
}

function appendRow(sheetName, rowObject) {
  return withLock_(function () {
    const sheet = getSheet_(sheetName);
    const headers = getHeaders_(sheetName);
    const row = headers.map(function (h) {
      return rowObject[h] !== undefined && rowObject[h] !== null ? rowObject[h] : '';
    });
    appendRowValues_(sheet, sheetName, row);
    invalidateSheetCache_(sheetName);
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
    const data = readSheetData_(sheetName); // ロック取得時にキャッシュは捨てられているので実データ
    const values = data.values;
    const headers = data.headers;
    const keyIdx = headers.indexOf(keyColumn);
    if (keyIdx === -1) throw new Error('キー列が存在しません：' + keyColumn);

    for (var r = 1; r < values.length; r++) {
      if (String(values[r][keyIdx]).trim() !== String(keyValue).trim()) continue;
      writeRowUpdates_(sheet, r + 1, headers, updates);
      invalidateSheetCache_(sheetName);
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
    const data = readSheetData_(sheetName); // ロック取得時にキャッシュは捨てられているので実データ
    const values = data.values;
    const headers = data.headers;
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
      writeRowUpdates_(sheet, r + 1, headers, updates);
      invalidateSheetCache_(sheetName);
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
  // padStart で最小3桁を保ちつつ、1000以降は桁を伸ばす（slice(-3) だと 1000→'000' に
  // 折り返して以後の追加行が全て同一IDになる。courses は過去分を残す方針で1000超は現実的）。
  // 既存IDは可変長でも parseInt(id.slice(prefix.length)) で読めるため移行不要。
  return prefix + String(max + 1).padStart(3, '0');
}

/**
 * 連番IDを採番しつつ1行を追記する。採番と追記を同一ロック内で行い競合を防ぐ。
 * rowObject の idColumn は自動採番で上書きする。生成したIDを返す。
 */
function appendRowWithId(sheetName, idColumn, prefix, rowObject) {
  return withLock_(function () {
    const id = nextId_(sheetName, idColumn, prefix);
    const sheet = getSheet_(sheetName);
    const headers = getHeaders_(sheetName);
    const obj = {};
    for (var k in rowObject) obj[k] = rowObject[k];
    obj[idColumn] = id;
    const row = headers.map(function (h) {
      return obj[h] !== undefined && obj[h] !== null ? obj[h] : '';
    });
    appendRowValues_(sheet, sheetName, row);
    invalidateSheetCache_(sheetName);
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
    const data = readSheetData_(sheetName); // ロック取得時にキャッシュは捨てられているので実データ
    const values = data.values;
    const headers = data.headers;

    // 書き込む値（キー＋更新内容をマージ）
    const merged = {};
    for (var mk in matchObj) merged[mk] = matchObj[mk];
    for (var rk in rowObject) merged[rk] = rowObject[rk];

    for (var r = 1; r < values.length; r++) {
      if (isEmptyRow_(values[r])) continue;
      if (rowMatches_(values[r], headers, matchObj)) {
        writeRowUpdates_(sheet, r + 1, headers, merged);
        invalidateSheetCache_(sheetName);
        return 'updated';
      }
    }
    const row = headers.map(function (h) {
      return merged[h] !== undefined && merged[h] !== null ? merged[h] : '';
    });
    appendRowValues_(sheet, sheetName, row);
    invalidateSheetCache_(sheetName);
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
    const data = readSheetData_(sheetName); // ロック取得時にキャッシュは捨てられているので実データ
    const values = data.values;
    const keyIdx = data.headers.indexOf(keyColumn);
    if (keyIdx === -1) throw new Error('キー列が存在しません：' + keyColumn);
    var deleted = 0;
    for (var r = values.length - 1; r >= 1; r--) {
      if (String(values[r][keyIdx]).trim() === String(keyValue).trim()) {
        sheet.deleteRow(r + 1);
        deleted++;
      }
    }
    if (deleted) invalidateSheetCache_(sheetName);
    return deleted;
  });
}

/**
 * 1行のうち updates（ヘッダー名 → 値）に含まれる列だけを書き換える。
 * 連続した列はまとめて setValues するので、列ごと setValue の往復が減る（backlog 10-10）。
 * 更新対象**以外**のセルには一切触れないため、他列の書式・数式を巻き込まない。
 *
 * @param {Sheet}  sheet
 * @param {number} rowNumber 1始まりの行番号（ヘッダー行が1）
 * @param {Array}  headers
 * @param {Object} updates
 * @return {number} 実行した setValues の回数
 */
function writeRowUpdates_(sheet, rowNumber, headers, updates) {
  const cols = [];
  for (var c = 0; c < headers.length; c++) {
    if (updates[headers[c]] !== undefined) cols.push(c);
  }
  if (cols.length === 0) return 0;

  var writes = 0;
  var i = 0;
  while (i < cols.length) {
    // 連続する列インデックスの区間 [i, j] をひとまとめにする
    var j = i;
    while (j + 1 < cols.length && cols[j + 1] === cols[j] + 1) j++;
    const run = cols.slice(i, j + 1).map(function (c2) { return updates[headers[c2]]; });
    sheet.getRange(rowNumber, cols[i] + 1, 1, run.length).setValues([run]);
    writes++;
    i = j + 1;
  }
  return writes;
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

function getHeaders_(sheetName) {
  return readSheetData_(sheetName).headers;
}

function isEmptyRow_(row) {
  for (var i = 0; i < row.length; i++) {
    if (row[i] !== '' && row[i] !== null) return false;
  }
  return true;
}

/**
 * 関数を LockService で保護して実行する共通ラッパー。
 *
 * 実行内キャッシュの整合性もここが担保する（backlog 10-10）：
 *  - 取得直後に捨てる … ロック待ちの間に他の実行が書き込んでいる可能性があるため、
 *    ロック内の読み取り（nextId_ の採番・CAS の現在値検証）は必ず実データを読み直す。
 *    これが無いと、ロック外で読んだ古い vacancies から採番して**同じIDを二重発行**しうる。
 *  - 解放直前に捨てる … 自分の書き込みを、以降の読み取りに必ず反映させる。
 */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(LOCK_TIMEOUT_MS);
  invalidateSheetCache_();
  try {
    return fn();
  } finally {
    invalidateSheetCache_();
    lock.releaseLock();
  }
}
