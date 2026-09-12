/**
 * GAS上でしか確かめられない確認用の関数（GASエディタから手動実行してログを見る）
 *
 * ロジックの検証は手元の Node（`tools/`）へ移した。ここに残っているのは
 * **実スプレッドシート・実 Chat 送信・実カレンダー・実 PropertiesService を触るもの**だけ。
 * 通し確認（一時データを作って消す e2e）は E2E.gs にある。
 *
 *   手元で回す（1秒・GAS不要）:
 *     node tools/check-syntax.js    構文チェック
 *     node tools/sim-vacancy.js     欠員補充のロジック
 *     node tools/sim-attendance.js  勤怠CSVの解析と15分丸め突合
 *     node tools/sim-forms.js       フォーム設問→DB値のマッピング
 *
 * ■ 副作用のあるものに注意
 *   - testNotify / testNotifyVacancy … **実際に Chat へ送信する**
 *   - testSheets                     … テスト行を書いて最後に消す
 *   - testSeed / testClearSeed       … **実カレンダーに疑似イベントを作る/消す**
 *   本番DB・本番カレンダーに向けて実行しないこと（ダミーDB前提）。
 */

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



// ─── デバッグ用 ──────────────────────────────────────────────

/**
 * 回答画面サーバー関数の動作確認。最新の欠員に対して getVacancyForRespond を実行しログ出力。
 * 「読み込み中で固まる」原因（サーバー側エラー）を切り分けるために使う。
 */
function testRespond() {
  const vacancies = readRows(SHEET.VACANCIES);
  if (vacancies.length === 0) {
    Logger.log('vacancies が空です。先に欠勤連絡で欠員を作ってください。');
    return;
  }
  const vid = vacancies[vacancies.length - 1].vacancy_id;
  Logger.log('実行ユーザー: ' + Session.getActiveUser().getEmail());
  const me = getCurrentUser_();
  Logger.log('→ staff_id: ' + (me ? me.staff_id + '（' + me.role + '）' : '未登録'));
  Logger.log('対象 vacancy_id: ' + vid);
  try {
    const res = getVacancyForRespond(vid);
    Logger.log('結果: ' + JSON.stringify(res));
  } catch (e) {
    Logger.log('❌ エラー: ' + e.message);
    Logger.log(e.stack);
  }
}

/**
 * 候補スクリーニングの動作確認。GASエディタから実行してログを見る。
 * 実データは変更しない。
 */
function testVacancy() {
  Logger.log('===== Vacancy 候補スクリーニング確認 =====');

  const courses = readRows(SHEET.COURSES);
  if (courses.length === 0) {
    Logger.log('courses が空です。Setup を確認してください。');
    return;
  }

  courses.forEach(function (c) {
    const slotKey = String(c.day).trim() + String(c.period).trim();
    Logger.log('--- コマ ' + c.course_id + '（' + slotKey + '限）担当=' +
      c.staff_a_id + '/' + c.staff_b_id + ' ---');

    // 全学生のスロットを可視化（なぜ候補になる/ならないかを確認できる）
    readRows(SHEET.STAFFS).forEach(function (s) {
      if (String(s.role).trim() !== '学生') return;
      const slots = String(s.available_slots).split(',').map(function (x) { return x.trim(); });
      const hit = slots.indexOf(slotKey) !== -1;
      Logger.log('   ' + s.staff_id + ' ' + s.name + ' [' + s.available_slots + ']' +
        (hit ? ' ← スロット一致' : ''));
    });

    const candidates = findCandidates_(c, [c.staff_a_id, c.staff_b_id]);
    Logger.log('   → 代行候補: ' +
      (candidates.length ? candidates.map(function (x) { return x.name; }).join('、') : 'なし'));
  });

  Logger.log('（候補が「なし」の場合、その曜日時限に空きのある別の学生を staffs に足すと候補に出ます）');
  Logger.log('===== 確認終了 =====');
}


// ─── デバッグ用 ──────────────────────────────────────────────

/**
 * GASエディタから実行して端末エンドポイントの応答を確認する。
 * 実トークンは使わず集計ロジックだけ検証する（ネットワーク不要）。
 */
function testDevicePoll() {
  Logger.log('===== 端末エンドポイント 動作確認 =====');

  const tokenSet = !!PropertiesService.getScriptProperties().getProperty(PROP_DEVICE_TOKEN);
  Logger.log('[プロパティ] DEVICE_TOKEN = ' + (tokenSet ? '設定済み' : '⚠️ 未設定（端末は unauthorized になる）'));

  const summary = getOpenVacancySummary_();
  Logger.log('未対応件数(count): ' + summary.count);
  Logger.log('最新の欠員連番(latest): ' + summary.latest);
  Logger.log('→ 端末への応答例: ' + JSON.stringify({ ok: true, count: summary.count, latest: summary.latest }));

  // 認証分岐の確認（誤トークンは弾かれること）
  const wrong = handleDevicePoll_({ token: '__wrong__' });
  Logger.log('誤トークン応答: ' + wrong.getContent());

  Logger.log('===== 確認終了 =====');
  Logger.log('※ 実際のHTTP確認は、ブラウザで <Web AppのURL>?device=alert&token=<DEVICE_TOKEN> を開く。');
}



/**
 * 接続確認：どのカレンダーを見るか・直近1週間のイベント件数を出す。
 * まずこれを実行して、見ているカレンダーが意図通りか確かめる。
 */
function testCalendarConnection() {
  Logger.log('===== カレンダー接続確認 =====');
  try {
    const cal = getCalendar_();
    const usingDefault = !PropertiesService.getScriptProperties().getProperty(PROP_CALENDAR_ID);
    Logger.log('対象カレンダー: ' + cal.getName());
    Logger.log('  ID: ' + cal.getId());
    Logger.log('  ソース: ' + (usingDefault ? 'デフォルト（本人）※CALENDAR_ID未設定' : 'CALENDAR_ID 指定'));
    const now = new Date();
    const weekLater = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    Logger.log('  今後7日のイベント件数: ' + cal.getEvents(now, weekLater).length);
    Logger.log('→ OK。inspectCalendarDay("YYYY-MM-DD") で特定日を診断できます。');
  } catch (e) {
    Logger.log('❌ ' + e.message);
  }
  Logger.log('===== 終了 =====');
}

/**
 * inspectCalendarDay を固定日付で実行するラッパー（GASエディタから実行しやすいように）。
 * 確認したい日付をここで書き換える。シフト（テイク）が2人入っている日を選ぶこと。
 */
function testInspectCalendar() {
  inspectCalendarDay('2026-05-01'); // ← 2人テイクが入っている日付に書き換えて実行
}

/**
 * 共有カレンダーのIDを直接指定して特定日を診断するラッパー。
 * listCalendars で見つけたIDと、2人テイクが入っている日付を書き換えて実行する。
 */
function testInspectCalendarOn() {
  const calendarId = 'ここにカレンダーのIDを貼る';
  inspectCalendarDay('2026-05-12', calendarId);
}

// ─── テストカレンダー用ラッパー ──────────────────────────────

// テスト対象カレンダーIDの解決順：
//   ① 下の TEST_CALENDAR_ID を実IDに書き換えていればそれ
//   ② 書き換えていなければ スクリプトプロパティ CALENDAR_ID を使う（こちらが簡単）
// どちらか設定されていれば testSeed / testInspectSeed / testClearSeed が動く。
const TEST_CALENDAR_ID = ''; // 使うならここにテストカレンダーIDを貼る（空ならCALENDAR_IDを使用）

function testCalId_() {
  if (TEST_CALENDAR_ID) return TEST_CALENDAR_ID;
  const id = PropertiesService.getScriptProperties().getProperty(PROP_CALENDAR_ID);
  if (id) return id;
  throw new Error('テストカレンダーIDが未設定です。スクリプトプロパティ ' + PROP_CALENDAR_ID
    + ' を設定するか、TEST_CALENDAR_ID を書き換えてください。');
}

// 1) 疑似イベントを作成
function testSeed() {
  seedTestCalendar(testCalId_());
}

// 2) 作った疑似イベントを診断（重なり検出まで）
function testInspectSeed() {
  inspectCalendarDay('2026-05-12', testCalId_());
}

// 3) 疑似イベントを掃除
function testClearSeed() {
  clearTestCalendarSeed(testCalId_(), '2026-05-12');
}

// ─── 単発コマ・型の診断（D27）────────────────────────────────

/**
 * 「単発コマが時間割に出ない」を切り分けるための診断（GASエディタから実行してログを見る）。
 *
 * どの層で落ちているかを1回で分かるように、次の3つを順に出す：
 *   1. courses シートの生の値と**型**（period が数値か／date が Date 値か）
 *   2. getTimetable が実際に返したコマ（単発が含まれているか・oneOffDate は何か）
 *   3. 表示中の週に相当する日付（サーバーのJST基準）
 *
 * 実データは一切変更しない。
 */
function testOneOffDiagnosis() {
  Logger.log('===== 単発コマ 診断 =====');

  const today = todayJst_();
  Logger.log('[今日（JST）] ' + today + '（' + weekdayOf_(today) + '曜）');

  // 今週の月〜日（home.html の buildWeek と同じ計算）
  const m = today.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d0 = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const monday = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate());
  monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
  const names = ['月', '火', '水', '木', '金', '土', '日'];
  const weekDates = names.map(function (n, i) {
    const x = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
    return n + '=' + Utilities.formatDate(x, 'Asia/Tokyo', 'yyyy-MM-dd');
  });
  Logger.log('[今週の日付] ' + weekDates.join(' / '));

  // ── 1) シートの生の値と型 ──
  Logger.log('--- courses シートの生データ（型つき）---');
  const rows = readRows(SHEET.COURSES);
  if (rows.length === 0) Logger.log('（courses が空です）');
  rows.forEach(function (c) {
    const rawDate = c.date;
    const dateType = rawDate instanceof Date ? '⚠️Date' : typeof rawDate;
    const periodType = typeof c.period;
    Logger.log('・' + String(c.course_id).trim() +
      ' | quarter=' + String(c.quarter).trim() +
      ' | day=' + String(c.day).trim() +
      ' | period=' + c.period + '(' + periodType + (periodType === 'number' ? '⚠️' : '') + ')' +
      ' | date=' + (rawDate === '' || rawDate == null ? '(空)' : rawDate) + '(' + dateType + ')' +
      ' → courseDate_=' + (courseDate_(c) || '(空＝毎週)'));
  });

  // ── 2) getTimetable が返すもの ──
  Logger.log('--- getTimetable() の戻り ---');
  var tt;
  try {
    tt = getTimetable();
  } catch (e) {
    Logger.log('❌ getTimetable が例外: ' + e.message);
    return;
  }
  Logger.log('選択中の学期: ' + tt.quarter);
  Logger.log('学期の選択肢: ' + (tt.quarters || []).map(function (o) { return o.value; }).join(' / '));
  Logger.log('返ってきたコマ数: ' + tt.courses.length + '（曜日の軸: ' + tt.days.join('') +
    ' / 時限の軸: ' + tt.periods.map(function (p) { return p.period; }).join(',') + '）');

  const oneOffs = tt.courses.filter(function (c) { return c.oneOffDate; });
  Logger.log('うち単発コマ: ' + oneOffs.length + '件');
  oneOffs.forEach(function (c) {
    const hit = weekDates.filter(function (w) { return w.split('=')[1] === c.oneOffDate; })[0];
    Logger.log('・' + c.course_id + ' | ' + c.day + c.period + '限 | oneOffDate=' + c.oneOffDate +
      ' | 今週に含まれる: ' + (hit ? 'はい（' + hit + '）' : 'いいえ → その週へ送らないと出ません'));
  });

  // シートには date があるのに getTimetable に出ていないコマを名指しする
  const returned = {};
  tt.courses.forEach(function (c) { returned[c.course_id] = true; });
  const missing = rows.filter(function (c) {
    return courseDate_(c) && !returned[String(c.course_id).trim()];
  });
  if (missing.length) {
    Logger.log('❌ 単発なのに getTimetable が返していないコマ: ' +
      missing.map(function (c) { return String(c.course_id).trim(); }).join('、'));
  } else {
    Logger.log('✅ シート上の単発コマはすべて getTimetable に含まれています。');
    Logger.log('   ここまで正常なら、残るのは画面側（週送り／マイビュー／絞り込み）か、');
    Logger.log('   ブラウザが古いJSを読んでいるかです。Ctrl+Shift+R で再読み込みしてください。');
  }
  Logger.log('===== 診断終了 =====');
}

// ─── 設定の診断 ──────────────────────────────────────────────

/**
 * 「リクエストされたドキュメントにアクセスする権限がありません」の切り分け用。
 *
 * この例外は SpreadsheetApp.openById() が投げるもので、原因は次のどれか：
 *   (1) スクリプトプロパティのIDが**古い／別のファイルを指している**
 *   (2) そのファイルを**作ったアカウントと、いま動かしているアカウントが違う**
 *   (3) IDのコピーミス（URL全体を貼った・余分な空白が入った 等）
 *
 * どれなのかはログを見ないと分からないので、実行アカウントと2つのIDを出し、
 * それぞれ実際に開いてみて結果を表示する。実データは変更しない。
 */
function showConfig() {
  Logger.log('===== 設定の診断 =====');

  // 実行アカウント。GASエディタから実行すると「いまエディタを開いている人」になり、
  // Web App 経由だと「デプロイした人」になる。ここが食い違うと権限エラーの原因になる。
  var active = '';
  var effective = '';
  try { active = Session.getActiveUser().getEmail(); } catch (e) { active = '(取得不可)'; }
  try { effective = Session.getEffectiveUser().getEmail(); } catch (e) { effective = '(取得不可)'; }
  Logger.log('[実行アカウント] 操作者=' + (active || '(空)') + ' / 実行権限=' + (effective || '(空)'));

  const props = PropertiesService.getScriptProperties();
  const keys = ['SPREADSHEET_ID', 'CONTACTS_SPREADSHEET_ID', 'CALENDAR_ID',
    'CHAT_WEBHOOK_URL', 'DEVICE_TOKEN'];
  Logger.log('--- スクリプトプロパティ ---');
  keys.forEach(function (k) {
    const v = props.getProperty(k);
    if (!v) { Logger.log('・' + k + ' = ⚠️未設定'); return; }
    // Webhook とトークンは秘密なので長さだけ出す
    if (k === 'CHAT_WEBHOOK_URL' || k === 'DEVICE_TOKEN') {
      Logger.log('・' + k + ' = 設定あり（' + v.length + '文字）');
      return;
    }
    const clean = v.trim();
    Logger.log('・' + k + ' = ' + v + (clean !== v ? '  ⚠️前後に空白があります' : ''));
    if (clean.indexOf('http') === 0 || clean.indexOf('/') !== -1) {
      Logger.log('    ⚠️ URLを貼っている可能性があります。IDだけ（/d/ と /edit の間）を入れてください。');
    }
  });

  // 実際に開いてみる
  [['メインDB', 'SPREADSHEET_ID'], ['連絡先DB', 'CONTACTS_SPREADSHEET_ID']].forEach(function (pair) {
    const label = pair[0];
    const id = props.getProperty(pair[1]);
    Logger.log('--- ' + label + '（' + pair[1] + '）---');
    if (!id) { Logger.log('  ⚠️ 未設定のため開けません。'); return; }
    try {
      const ss = SpreadsheetApp.openById(String(id).trim());
      const names = ss.getSheets().map(function (sh) { return sh.getName(); });
      Logger.log('  ✅ 開けました: 「' + ss.getName() + '」');
      Logger.log('     オーナー: ' + safeOwner_(ss));
      Logger.log('     シート: ' + names.join(' / '));
    } catch (e) {
      Logger.log('  ❌ 開けません: ' + e.message);
      Logger.log('     → このIDのファイルを ' + (effective || active || 'この実行アカウント') +
        ' が開けません。IDが正しいか、そのアカウントが所有/共有されているか確認してください。');
    }
  });

  // 期待するシートが揃っているか
  Logger.log('--- シートの有無 ---');
  ['staffs', 'courses', 'vacancies', 'responses', 'periods', 'terms', 'contacts', 'registrations']
    .forEach(function (name) {
      try {
        getSheet_(name);
        Logger.log('  ✅ ' + name);
      } catch (e) {
        Logger.log('  ❌ ' + name + ' … ' + e.message);
      }
    });

  Logger.log('===== 診断終了 =====');
}

// オーナーは取得できないことがある（共有ドライブ等）ので握りつぶす
function safeOwner_(ss) {
  try {
    const o = ss.getOwner();
    return o ? o.getEmail() : '(取得不可・共有ドライブの可能性)';
  } catch (e) {
    return '(取得不可: ' + e.message + ')';
  }
}
