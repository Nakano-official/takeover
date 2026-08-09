/**
 * 初回セットアップ用スクリプト
 * GASエディタから setupSpreadsheets() を1回だけ実行する。
 * 実行後、ログに表示された2つのIDをPropertiesServiceに登録すること。
 */

/**
 * 【動作確認用】ダミーデータ入りでセットアップする。
 * 架空のスタッフ・利用者・コマが入った状態で2つのDBを作る。デモ・実証実験向け。
 */
function setupSpreadsheets() {
  runSetup_(buildDummyData_(), false);
}

/**
 * 【本番用】空（ヘッダーのみ）でセットアップする。
 * staffs / courses / contacts は空。periods（時限マスタ）だけ入る。
 * 実データはフォーム取り込み・シフト入力画面・手入力で投入する（docs/guides/operations.md）。
 */
function setupSpreadsheetsEmpty() {
  runSetup_(emptyData_(), true);
}

// ヘッダーのみ（データ行なし）のセットアップ用データ
function emptyData_() {
  // terms（学期マスタ）は periods と同じく運用の土台なので、本番の空セットアップでも
  // 当年度の雛形を入れる（職員が学事暦に合わせて日付調整）。これで入力画面の学期選択が即使える（D16）。
  return {
    students: [], staff: [], users: [], staffs: [], courses: [], contacts: [],
    terms: currentYearTermsTemplate_(),
  };
}

// セットアップ本体（ダミー/空 共通）
function runSetup_(data, isEmpty) {
  // 再実行ガード：既にIDが登録済みなら中断する（スプレッドシート二重作成を防止）
  const props = PropertiesService.getScriptProperties();
  if (props.getProperty('SPREADSHEET_ID') || props.getProperty('CONTACTS_SPREADSHEET_ID')) {
    Logger.log('⚠️ 既にスプレッドシートIDが登録されています。再作成は中止しました。');
    Logger.log('作り直す場合はスクリプトプロパティのID2件を削除してから再実行してください。');
    return;
  }

  const mainDb = SpreadsheetApp.create('支援室シフト管理 - メインDB');
  setupMainDb_(mainDb, data);

  const contactsDb = SpreadsheetApp.create('支援室シフト管理 - 連絡先DB');
  setupContactsDb_(contactsDb, data);

  Logger.log('========== セットアップ完了（' + (isEmpty ? '本番・空' : 'デモ・ダミーデータ') + '）==========');
  if (!isEmpty) {
    Logger.log('学生スタッフ ' + data.students.length + '名・職員 ' + data.staff.length +
      '名・利用者 ' + data.users.length + '名・コマ ' + data.courses.length + '件 を投入しました。');
  }
  Logger.log('【SPREADSHEET_ID】メインDB:      ' + mainDb.getId());
  Logger.log('【CONTACTS_SPREADSHEET_ID】連絡先DB: ' + contactsDb.getId());
  Logger.log('上記IDをGASエディタ > プロジェクトの設定 > スクリプトプロパティに登録してください。');
  Logger.log('連絡先DBは職員のみ共有してください（スプレッドシートの共有設定で制限）。');
  if (isEmpty) {
    Logger.log('★ まずログインできるよう、最初の職員を1行ずつ追加してください：');
    Logger.log('  - staffs   : staff_id / name / role=職員 /（skills・available_slots は空でOK）');
    Logger.log('  - contacts : 同じ staff_id / name / email=自分の大学アドレス');
    Logger.log('  その後、フォーム取り込みやシフト入力画面で学生・コマを投入します（docs/guides/operations.md）。');
    Logger.log('  ★ terms（学期マスタ）に当年度の雛形（前期/後期＋1Q〜4Q）を入れました。');
    Logger.log('    開始/終了日を実際の学事暦に合わせて調整してください（体系判定・現在学期の解決に使います）。');
  } else {
    Logger.log('★ テストで自分が職員としてログインするには、連絡先DB contacts の S001 の email を');
    Logger.log('  自分のアドレスに書き換えてください（それで「職員」として全画面が見えます）。');
  }
}

// ─── ダミーデータ生成（全て架空名。実在の利用者/教員/科目名は使わない）──

/**
 * 月〜金に授業を配置し、シフトを破綻なく割り当てたダミーデータを生成する。
 * 制約：①同じ利用者を同一コマに重複させない ②同じスタッフを同一コマに二重起用しない
 *       ③スタッフの available_slots は「担当が入っていない＝空いている」コマにする。
 * 生成は決定的（毎回同じ結果）。
 * @return {{students:Array, staff:Array, users:Array, staffs:Array, courses:Array, contacts:Array}}
 */
function buildDummyData_() {
  // 学期マスタ（terms）。日付は「セットアップ実行時点」を基準に相対生成するため、
  // いつ実行しても「現在（開講中）」に該当する学期ができる（デモが空にならない）。
  // 龍谷大の2体系（先端理工=クォーター制／他学部=セメスター制）を同時に表現する（D16）。
  const now = new Date();
  const yr = now.getFullYear();
  const shiftDate_ = function (days) {
    const t = new Date(now.getTime());
    t.setDate(t.getDate() + days);
    return Utilities.formatDate(t, 'Asia/Tokyo', 'yyyy-MM-dd');
  };
  // 前期（セメスター）が 1Q・2Q を暦で内包する入れ子（前期⊇1Q+2Q）。
  // 実行時点を基準に：前期=現在／1Q=前期の前半（終了済み）／2Q=前期の後半（現在）とする。
  // → home で「2Q」を選んでも前期のセメスター科目が残り、「前期」を選ぶと 1Q+2Q もまとまって出る。
  const SEM_SPRING = yr + '-前期';  // 他学部の大半（セメスター制・現在）
  const Q1 = yr + '-1Q';            // 先端理工 1Q（前期前半・終了済み）
  const Q2 = yr + '-2Q';            // 先端理工 2Q（前期後半・現在）
  const terms = [
    { term_id: SEM_SPRING,   system: 'semester', start_date: shiftDate_(-120), end_date: shiftDate_(60) },
    { term_id: yr + '-後期', system: 'semester', start_date: shiftDate_(61),   end_date: shiftDate_(240) },
    { term_id: Q1,           system: 'quarter',  start_date: shiftDate_(-120), end_date: shiftDate_(-31) },
    { term_id: Q2,           system: 'quarter',  start_date: shiftDate_(-30),  end_date: shiftDate_(59) },
    { term_id: yr + '-3Q',   system: 'quarter',  start_date: shiftDate_(61),   end_date: shiftDate_(150) },
  ];

  const DAYS = ['月', '火', '水', '木', '金'];
  const PERIODS = ['1', '2', '3', '4'];
  const SLOTS = DAYS.length * PERIODS.length; // 20

  // 学生スタッフ（架空名）
  const students = [
    { id: 'S101', name: '佐藤 美咲' }, { id: 'S102', name: '高橋 健太' },
    { id: 'S103', name: '田中 由衣' }, { id: 'S104', name: '渡辺 翔' },
    { id: 'S105', name: '伊藤 彩花' }, { id: 'S106', name: '山本 大輝' },
    { id: 'S107', name: '中村 結菜' }, { id: 'S108', name: '小林 駿' },
    { id: 'S109', name: '加藤 莉子' }, { id: 'S110', name: '吉田 颯' },
    { id: 'S111', name: '山口 七海' }, { id: 'S112', name: '松本 陸' },
  ];
  const staff = [{ id: 'S001', name: '山田 花子' }]; // 職員
  const users = ['利用者A', '利用者B', '利用者C', '利用者D', '利用者E', '利用者F', '利用者G', '利用者H'];

  // 利用者を学期体系に振り分ける（デモで両体系＋クォーター切替が見えるように）。
  // 先頭6名＝セメスター制（前期）、末尾2名＝先端理工のクォーター制（1名 1Q・1名 2Q）。
  const userTerm = {};
  users.forEach(function (u, i) {
    userTerm[u] = (i < users.length - 2) ? SEM_SPRING
      : (i === users.length - 2 ? Q1 : Q2);
  });

  const SUBJECTS = ['基礎数学', '英語コミュニケーション', '情報リテラシー', '心理学概論',
    '物理学基礎', '経済学入門', '線形代数', '化学基礎', '統計学', '社会学概論',
    'プログラミング入門', '日本国憲法'];
  const ROOMS = ['1-101', '1-203', '2-105', '2-210', '3-102', '3-301', '4-201', '5-110'];

  // 対応可能な内容（スキル）。テイクと介助は別区分で、片方しかできない人もいる（D9）。
  //   i%6===0 → テイクのみ ／ i%6===3 → 介助のみ ／ それ以外 → 両方
  const skillById = {};
  students.forEach(function (st, i) {
    skillById[st.id] = (i % 6 === 0) ? 'テイク' : (i % 6 === 3) ? '介助' : 'テイク,介助';
  });
  function canDo(id, type) {
    return skillById[id].split(',').indexOf(type) !== -1;
  }

  // slot index → day/period
  function slotInfo(slot) {
    return { day: DAYS[Math.floor(slot / PERIODS.length)], period: PERIODS[slot % PERIODS.length] };
  }

  // 各利用者に週4コマを distinct な slot で割り当て（stride 5 で必ず4つとも別スロット）
  const sessions = [];
  var sCount = 0;
  for (var u = 0; u < users.length; u++) {
    for (var k = 0; k < 4; k++) {
      const slot = (u + k * 5) % SLOTS;
      const info = slotInfo(slot);
      sessions.push({
        day: info.day, period: info.period, slotKey: info.day + info.period,
        user: users[u],
        support_type: (sCount % 4 === 3) ? '介助' : 'テイク', // 4件に1件は介助(1名)
        subject: SUBJECTS[sCount % SUBJECTS.length],
        instructor: '（仮）教員' + String.fromCharCode(65 + (sCount % 12)),
        room: ROOMS[sCount % ROOMS.length],
      });
      sCount++;
    }
  }
  // 表示が綺麗になるよう曜日→時限順に並べる
  const dayOrder = {}; DAYS.forEach(function (d, i) { dayOrder[d] = i; });
  sessions.sort(function (a, b) {
    return dayOrder[a.day] - dayOrder[b.day] || Number(a.period) - Number(b.period);
  });

  // スタッフ割り当て（ローテーションで負荷分散・同一コマ重複回避）
  const busy = {}; students.forEach(function (s) { busy[s.id] = {}; });
  var ptr = 0;
  function pickStaff(slotKey, count, type) {
    const picked = [];
    var attempts = 0;
    while (picked.length < count && attempts < students.length * 2) {
      const cand = students[ptr % students.length];
      ptr++; attempts++;
      if (!busy[cand.id][slotKey] && picked.indexOf(cand.id) === -1 && canDo(cand.id, type)) {
        picked.push(cand.id);
        busy[cand.id][slotKey] = true;
      }
    }
    return picked;
  }

  const courses = sessions.map(function (se, i) {
    const need = se.support_type === 'テイク' ? 2 : 1;
    const assigned = pickStaff(se.slotKey, need, se.support_type);
    return {
      course_id: 'C' + ('00' + (i + 1)).slice(-3),
      quarter: userTerm[se.user], // term_id（セメスター or クォーター・D16）
      day: se.day, period: se.period,
      support_type: se.support_type,
      user_student: se.user,
      subject: se.subject,
      instructor: se.instructor,
      room: se.room,
      staff_a_id: assigned[0] || '',
      staff_b_id: assigned[1] || '',
      note: '',
    };
  });

  // available_slots = 担当が入っていない（空いている）全スロット
  const allSlots = [];
  for (var s = 0; s < SLOTS; s++) { const inf = slotInfo(s); allSlots.push(inf.day + inf.period); }
  // personal_code = 勤怠CSVの「個人ｺｰﾄﾞ」を模した架空の安定ID（D2 例 'Y2xxxxx' に合わせる）。
  // 職員は学生スタッフではない＝勤怠CSVに出ないため空にする。
  const staffs = staff.map(function (st) {
    return { staff_id: st.id, name: st.name, role: '職員', skills: '', available_slots: '', personal_code: '' };
  }).concat(students.map(function (st, i) {
    const free = allSlots.filter(function (sk) { return !busy[st.id][sk]; });
    return {
      staff_id: st.id, name: st.name, role: '学生',
      skills: skillById[st.id], available_slots: free.join(','),
      personal_code: 'Y2' + ('00000' + (i + 1)).slice(-5),
    };
  }));

  // 連絡先（ダミー）。webhook_url は空（運用時に登録）
  const contacts = staff.concat(students).map(function (p, i) {
    return {
      staff_id: p.id, name: p.name,
      email: p.id.toLowerCase() + '@example.ryukoku.ac.jp',
      phone: '000-0000-' + ('000' + (i + 1)).slice(-4),
      webhook_url: '',
    };
  });

  return { students: students, staff: staff, users: users, staffs: staffs, courses: courses, contacts: contacts, terms: terms };
}

// ヘッダー＋オブジェクト配列をシートに書き込む（列順はヘッダーに従う）
function writeTable_(sheet, headers, rows) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  if (rows.length === 0) return;
  const values = rows.map(function (r) {
    return headers.map(function (h) { return r[h] !== undefined && r[h] !== null ? r[h] : ''; });
  });
  sheet.getRange(2, 1, values.length, headers.length).setValues(values);
}

// ─── マイグレーション（既存シートへのカラム追加）─────────────

/**
 * 既存の courses シートに、時間割デジタル化（D8）で増えたカラムを追加する。
 * 既にデータがある運用シートを壊さず、不足しているヘッダーだけ末尾に足す（冪等）。
 * GASエディタから1回実行する。コードはヘッダー名で読むため列順は問わない。
 */
function migrateCoursesColumns() {
  const NEEDED = ['support_type', 'user_student', 'subject', 'instructor', 'room', 'note'];
  const ss = openMainDb_();
  const sheet = ss.getSheetByName('courses');
  if (!sheet) { Logger.log('❌ courses シートが見つかりません。'); return; }

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h).trim();
  });

  const toAdd = NEEDED.filter(function (h) { return headers.indexOf(h) === -1; });
  if (toAdd.length === 0) {
    Logger.log('✅ courses は既に最新のカラム構成です（追加なし）。');
    return;
  }

  sheet.getRange(1, lastCol + 1, 1, toAdd.length).setValues([toAdd]);
  invalidateSheetCache_('courses'); // Sheets.gs を経由しない書き換えなので実行内キャッシュを捨てる
  Logger.log('✅ courses に ' + toAdd.length + ' 列を追加しました: ' + toAdd.join(', '));
  Logger.log('   既存行の新カラムは空です。時間割の内容を入力してください。');
}

/**
 * 既存の staffs シートに skills 列（対応可能な内容：テイク/介助）を追加する（D9）。
 * 既存運用シートを壊さず、無ければ末尾に1列足す（冪等）。GASエディタから1回実行する。
 * skills 未設定の行は findCandidates_ で「全対応扱い」となるため、運用前に入力すること。
 */
function migrateStaffsColumns() {
  const ss = openMainDb_();
  const sheet = ss.getSheetByName('staffs');
  if (!sheet) { Logger.log('❌ staffs シートが見つかりません。'); return; }

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h).trim();
  });
  if (headers.indexOf('skills') !== -1) {
    Logger.log('✅ staffs には既に skills 列があります（追加なし）。');
    return;
  }

  sheet.getRange(1, lastCol + 1, 1, 1).setValues([['skills']]);
  invalidateSheetCache_('staffs'); // Sheets.gs を経由しない書き換えなので実行内キャッシュを捨てる
  Logger.log('✅ staffs に skills 列を追加しました。');
  Logger.log('   各学生に「テイク」「介助」「テイク,介助」のいずれかを入力してください。');
  Logger.log('   空欄は当面「全対応」として候補に出ます（運用前に入力推奨）。');
}

/**
 * 既存の staffs シートに personal_code 列を追加する（D2/D14・機能Bの勤怠CSV突合キー）。
 * 勤怠CSVの「個人ｺｰﾄﾞ」と突き合わせる安定ID。無ければ末尾に1列足す（冪等）。
 * 追加した列はテキスト書式にして先頭ゼロ・英字接頭辞の数値化を防ぐ。GASエディタから1回実行。
 */
function migrateStaffsPersonalCode() {
  const ss = openMainDb_();
  const sheet = ss.getSheetByName('staffs');
  if (!sheet) { Logger.log('❌ staffs シートが見つかりません。'); return; }

  const lastCol = sheet.getLastColumn();
  const headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) {
    return String(h).trim();
  });
  if (headers.indexOf('personal_code') !== -1) {
    Logger.log('✅ staffs には既に personal_code 列があります（追加なし）。');
    return;
  }

  const col = lastCol + 1;
  sheet.getRange(1, col, 1, 1).setValues([['personal_code']]);
  // 既存データ行＋余白をテキスト固定（個人ｺｰﾄﾞの数値化・先頭ゼロ欠落を防ぐ）
  sheet.getRange(2, col, Math.max(sheet.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  invalidateSheetCache_('staffs'); // Sheets.gs を経由しない書き換えなので実行内キャッシュを捨てる
  Logger.log('✅ staffs に personal_code 列を追加しました。');
  Logger.log('   各学生スタッフに勤怠CSVの「個人ｺｰﾄﾞ」（例 Y2xxxxx）を入力してください。');
  Logger.log('   未入力の学生は機能Bの照合で「要確認（personal_code 未登録）」になります。');
}

/**
 * 既存の periods シートのテキスト書式を「列全体」に広げる（D21 で判明した潜在バグの修正）。
 *
 * セットアップ時のテキスト固定は既定の7行ぶんにしか掛かっておらず、職員が8行目以降に
 * 時限（8限・課外時限など）を手で足すと `09:15` が**時刻値**として保存される。
 * すると `readRows` が Date を返し、締切判定（D21・`isPastRecruitDeadline_`）が
 * 黙って「締切前」に倒れたり、時刻表示が壊れたりする。10-6（personal_code）と同じパターン。
 *
 * 書式を広げるだけで、既に時刻値になっているセルは文字列へ直さない
 * （表示上の見た目は変わらないため、必要なら職員が入力し直す）。冪等。
 * GASエディタから1回実行する。
 */
function migratePeriodsTextFormat() {
  const ss = openMainDb_();
  const sheet = ss.getSheetByName('periods');
  if (!sheet) { Logger.log('❌ periods シートが見つかりません。'); return; }

  const rows = Math.max(sheet.getMaxRows() - 1, 1);
  sheet.getRange(2, 1, rows, 3).setNumberFormat('@');
  invalidateSheetCache_('periods'); // Sheets.gs を経由しない書き換えなので実行内キャッシュを捨てる

  Logger.log('✅ periods の period / start_time / end_time を列全体（' + rows + '行）テキスト固定にしました。');

  // 既に時刻値（Date）として保存されている行があれば知らせる
  const bad = readRows('periods').filter(function (p) {
    return (p.start_time instanceof Date) || (p.end_time instanceof Date);
  });
  if (bad.length === 0) {
    Logger.log('   現在の全行が文字列として読めています（問題なし）。');
  } else {
    Logger.log('   ⚠️ 次の時限は既に時刻値になっています。該当セルを入力し直してください（例：先頭に \' を付けて 09:15）：');
    bad.forEach(function (p) {
      Logger.log('     ' + p.period + '限: ' + p.start_time + ' 〜 ' + p.end_time);
    });
  }
}

/**
 * 指定年度の学期マスタ雛形（前期/後期＋1Q〜4Q）を返す（D16/D19）。
 * 日付は「学期設定」画面で職員が実際の学事暦に合わせて調整する前提の**目安値**。年度をまたいで
 * 再利用できるよう年を引数に取る（月日パターンは共通・実始まり曜日は年で数日ずれるため要調整）。
 *
 * 月日パターンは2026年度の実カレンダーに寄せてある（龍谷大・2026-07 ヒアリング）：
 *   前期＝4/7〜8/4（＝2Q終了）、夏休みを挟んで 後期＝9/18〜翌1/28。
 *   1Q 4/7〜6/8 ／ 2Q 6/9〜8/4 ／ 3Q 9/18〜11/19 ／ 4Q 11/20〜翌1/28。
 *   ※ 前期⊇1Q+2Q・後期⊇3Q+4Q の入れ子は保つ。夏(8/5〜9/17)・春(1/29〜)は「現在なし」の空白期間になる。
 * @param {(string|number)} year 西暦年（例：2027）
 * @return {Array<{term_id,system,start_date,end_date}>}
 */
function yearTermsTemplate_(year) {
  const yr = String(year);
  const ny = String(Number(yr) + 1);
  return [
    { term_id: yr + '-前期', system: 'semester', start_date: yr + '-04-07', end_date: yr + '-08-04' },
    { term_id: yr + '-後期', system: 'semester', start_date: yr + '-09-18', end_date: ny + '-01-28' },
    { term_id: yr + '-1Q', system: 'quarter', start_date: yr + '-04-07', end_date: yr + '-06-08' },
    { term_id: yr + '-2Q', system: 'quarter', start_date: yr + '-06-09', end_date: yr + '-08-04' },
    { term_id: yr + '-3Q', system: 'quarter', start_date: yr + '-09-18', end_date: yr + '-11-19' },
    { term_id: yr + '-4Q', system: 'quarter', start_date: yr + '-11-20', end_date: ny + '-01-28' },
  ];
}

/**
 * 当年度の学期マスタ雛形（前期/後期＋1Q〜4Q）を返す（D16）。
 * 本番の空セットアップ・マイグレーションで共用。yearTermsTemplate_ の当年度ラッパー。
 * @return {Array<{term_id,system,start_date,end_date}>}
 */
function currentYearTermsTemplate_() {
  return yearTermsTemplate_(Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy'));
}

/**
 * 既存のメインDBに terms（学期マスタ）シートを追加する（D16・11-3）。
 * 無ければヘッダー付きで新規作成し、当年度のセメスター/クォーターの雛形行を入れる（冪等）。
 * GASエディタから1回実行。日付列はテキスト固定。実際の開始/終了日は学事暦に合わせて職員が調整する。
 * ※ terms が空/未作成でも画面は従来どおり courses 由来の学期で動く（後方互換）。
 */
function migrateAddTermsSheet() {
  const ss = openMainDb_();
  if (ss.getSheetByName('terms')) {
    Logger.log('✅ terms シートは既に存在します（作成なし）。');
    return;
  }
  const sheet = ss.insertSheet('terms');
  const HEADERS = ['term_id', 'system', 'start_date', 'end_date'];
  const template = currentYearTermsTemplate_();
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  // 日付列はテキスト固定。雛形の行数ぶんではなく列全体に掛ける（10-6 / 10-6b と同じ理由）
  sheet.getRange(2, 3, Math.max(sheet.getMaxRows() - 1, 1), 2).setNumberFormat('@');
  writeTable_(sheet, HEADERS, template);
  applyHeaderStyle_([sheet], '#4a86e8');
  invalidateSheetCache_('terms'); // Sheets.gs を経由しない書き換えなので実行内キャッシュを捨てる
  Logger.log('✅ terms シートを作成し、当年度の雛形（前期/後期＋1Q〜4Q）を入れました。');
  Logger.log('   先端理工=クォーター制／他学部=セメスター制。実際の開始/終了日は学事暦に合わせて調整してください。');
  Logger.log('   courses.quarter には該当する term_id（例 前期 / 2Q）を入れます。');
}

/**
 * 既存データの学期IDを新表記（1Q〜4Q）に一括リネームする（D16・表記統一）。
 * 旧ダミーの「Q（実行期）/Q（次期）」や旧「Q1〜Q4」形式を「1Q〜4Q」に揃える。
 * terms シートの term_id 列と courses の quarter 列を**同時に**書き換えるので参照は壊れない。
 * 冪等（新表記は再変換されない）。GASエディタから1回実行する。
 */
function migrateTermNotation() {
  const ss = openMainDb_();

  // 1つの term_id を新表記へ。旧ダミー固有ラベル → 現在/次クォーター、Q数字 → 数字Q。
  const renameId_ = function (id) {
    var s = String(id == null ? '' : id);
    s = s.split('Q（実行期）').join('2Q'); // 旧ダミーの現在クォーター
    s = s.split('Q（次期）').join('3Q');   // 旧ダミーの次クォーター
    s = s.replace(/Q([1-4])/g, '$1Q');     // 2026-Q1 → 2026-1Q など（新表記は不変＝冪等）
    return s;
  };

  const fixColumn_ = function (sheetName, colName) {
    const sheet = ss.getSheetByName(sheetName);
    if (!sheet) return 0;
    const values = sheet.getDataRange().getValues();
    if (values.length < 2) return 0;
    const headers = values[0].map(function (h) { return String(h).trim(); });
    const ci = headers.indexOf(colName);
    if (ci === -1) return 0;
    var n = 0;
    for (var r = 1; r < values.length; r++) {
      const cur = String(values[r][ci]);
      if (!cur) continue;
      const nv = renameId_(cur);
      if (nv !== cur) { sheet.getRange(r + 1, ci + 1).setValue(nv); n++; }
    }
    return n;
  };

  const a = fixColumn_('terms', 'term_id');
  const b = fixColumn_('courses', 'quarter');
  invalidateSheetCache_(); // Sheets.gs を経由しない書き換えなので実行内キャッシュを捨てる
  Logger.log('✅ 学期表記を統一しました：terms.term_id ' + a + ' 件 / courses.quarter ' + b + ' 件を変更。');
  Logger.log('   例：2026-Q（実行期）→ 2026-2Q ／ 2026-Q1 → 2026-1Q（前期/後期はそのまま）。');
  if (a + b === 0) Logger.log('   変更対象はありませんでした（既に新表記です）。');
}

// ─── メインDB ────────────────────────────────────────────────

function setupMainDb_(ss, data) {
  const staffsSheet = ss.getActiveSheet();
  staffsSheet.setName('staffs');
  // personal_code（学籍番号系の安定ID）は機能Bの勤怠CSV突合キー（decisions.md D2/D14）。
  // 先頭ゼロ・英字接頭辞の数値化を防ぐためテキスト固定する（F列）。
  // 空セットアップ（staffs 0行）でも 3行目以降に職員が直接入力するため、データ行数ではなく
  // 列全体をテキスト固定する（データ行数だけだと F2 しか保護されず 10-6 の数値化バグを踏む）。
  staffsSheet.getRange(2, 6, Math.max(staffsSheet.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  writeTable_(staffsSheet,
    ['staff_id', 'name', 'role', 'skills', 'available_slots', 'personal_code'], data.staffs);

  // courses は「利用者中心の時間割」を表す（decisions.md D8）。
  // 1行＝1コマ（利用者×曜日×時限）。同じ曜日・時限に複数の利用者が並ぶ。
  // support_type=テイク は staff 2名、介助 は1名（staff_b_id 空）のことがある。
  const coursesSheet = ss.insertSheet('courses');
  const COURSE_HEADERS = [
    'course_id', 'quarter', 'day', 'period',
    'support_type',   // 内容：テイク / 介助
    'user_student',   // 利用学生（被支援者）の氏名
    'subject',        // 科目名
    'instructor',     // 担当教員
    'room',           // 教室
    'staff_a_id', 'staff_b_id',
    'note',           // 備考
  ];
  // period 列（D列）は periods シートと突合するためテキスト固定。初期データの行数ぶんではなく
  // 列全体に掛ける（10-6 / 10-6b と同じ理由。空セットアップだと1行しか掛からず、以後
  // シフト入力画面から足したコマの period が数値になる）。
  coursesSheet.getRange(2, 4, Math.max(coursesSheet.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  writeTable_(coursesSheet, COURSE_HEADERS, data.courses);

  const vacanciesSheet = ss.insertSheet('vacancies');
  vacanciesSheet.getRange(1, 1, 1, 7).setValues([
    ['vacancy_id', 'date', 'course_id', 'absent_staff_id', 'notify_status', 'result', 'substitute_staff_id'],
  ]);

  const responsesSheet = ss.insertSheet('responses');
  responsesSheet.getRange(1, 1, 1, 4).setValues([
    ['vacancy_id', 'staff_id', 'answer', 'answered_at'],
  ]);

  // terms（学期マスタ）。term_id・system（quarter/semester）・開始/終了日で「現在の学期」を解決する（D16）。
  // 先端理工=クォーター制／他学部=セメスター制の2体系が同時に走るための真実の源。
  const termsSheet = ss.insertSheet('terms');
  const TERM_HEADERS = ['term_id', 'system', 'start_date', 'end_date'];
  // start_date/end_date（C・D列）は日付の型ゆれを避け 'yyyy-MM-dd' 文字列で扱うためテキスト固定。
  // 初期データの行数ぶんではなく**列全体**に掛ける（10-6 / 10-6b と同じ理由）。
  termsSheet.getRange(2, 3, Math.max(termsSheet.getMaxRows() - 1, 1), 2).setNumberFormat('@');
  writeTable_(termsSheet, TERM_HEADERS, data.terms || []);

  const periodsSheet = ss.insertSheet('periods');
  periodsSheet.getRange(1, 1, 1, 3).setValues([['period', 'start_time', 'end_time']]);
  // period（数値型化を防ぐ）・start_time/end_time（時刻型化を防ぐ）を全てテキスト固定。
  // 既定の7行ぶんだけでなく**列全体**に掛ける（10-6 と同じ理由）。7行だけだと、職員が
  // 8行目以降に時限（8限・課外時限など）を手で足したとき '09:15' が時刻値に化け、
  // readRows が Date を返して締切判定（D21）や時刻表示が黙って壊れる。
  periodsSheet.getRange(2, 1, Math.max(periodsSheet.getMaxRows() - 1, 1), 3).setNumberFormat('@');
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
    [staffsSheet, coursesSheet, vacanciesSheet, responsesSheet, termsSheet, periodsSheet],
    '#4a86e8'
  );
}

// ─── 連絡先DB ────────────────────────────────────────────────

function setupContactsDb_(ss, data) {
  const contactsSheet = ss.getActiveSheet();
  contactsSheet.setName('contacts');
  // phone 列（C…ではなくD列）は先頭0欠落・数値化を防ぐためテキスト固定。
  // personal_code と同様、空セットアップ後に職員が直接追加する行も保護するため列全体に掛ける。
  contactsSheet.getRange(2, 4, Math.max(contactsSheet.getMaxRows() - 1, 1), 1).setNumberFormat('@');
  writeTable_(contactsSheet, ['staff_id', 'name', 'email', 'phone', 'webhook_url'], data.contacts);

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
