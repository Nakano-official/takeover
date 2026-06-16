/**
 * Google カレンダー連携（Phase 2）
 *
 * まずは「機能B（カレンダー↔勤怠の突合）」が成立するかを確かめるための
 * 読み取り専用の診断関数を置く。書き込み（代行記録の反映など）は後続で追加する。
 *
 * 設計方針：
 *  - カレンダーIDはスクリプトプロパティ CALENDAR_ID で管理する（コードに直書きしない）。
 *  - 未設定のときは「デフォルトカレンダー（実行者本人）」を見る。
 *    → テストカレンダーを用意しなくても、本人のシフト入りカレンダーで確認できる。
 *  - これらは GAS エディタから手動実行し「実行ログ」で結果を見るデバッグ関数。
 *  - 初回実行時にカレンダー閲覧の承認ダイアログが出るので「許可」する。
 */

const PROP_CALENDAR_ID = 'CALENDAR_ID';

// ─── カレンダー取得 ──────────────────────────────────────────

/**
 * 連携対象のカレンダーを取得する。
 * CALENDAR_ID が設定されていればそれを、無ければデフォルト（本人）カレンダーを返す。
 */
function getCalendar_() {
  const id = PropertiesService.getScriptProperties().getProperty(PROP_CALENDAR_ID);
  if (id) {
    const cal = CalendarApp.getCalendarById(id);
    if (!cal) throw new Error('CALENDAR_ID のカレンダーが見つかりません（共有・IDを確認）：' + id);
    return cal;
  }
  // 未設定時はデフォルト（実行者本人）。確認用途のフォールバック。
  return CalendarApp.getDefaultCalendar();
}

// ─── 日付・時刻ユーティリティ ────────────────────────────────

// "2026-05-01" → その日の 00:00〜翌日00:00 の範囲 [start, end)
function dayRange_(dateStr) {
  const m = String(dateStr).trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!m) throw new Error('日付は YYYY-MM-DD 形式で指定してください：' + dateStr);
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start: start, end: end };
}

// Date → "HH:mm"（ログ表示用）
function hhmm_(d) {
  return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
}

// イベントの安全な属性取得（権限・種類によって例外が出る項目を握りつぶす）
function safe_(fn) {
  try {
    const v = fn();
    return v == null ? '' : v;
  } catch (e) {
    return '(取得不可: ' + e.message + ')';
  }
}

// ─── 診断：1日のイベントを全フィールド付きでダンプ ──────────

/**
 * 指定日のイベントを、人物特定に使えそうなフィールド込みで一覧表示する。
 * 「同じ時間帯に重なる2件があるか」「その2件が何で区別できるか」を確認する用途。
 *
 * 使い方：GASエディタで関数を inspectCalendarDay に切り替え、下の testInspectCalendar を
 * 実行するか、この関数を直接呼ぶ（引数は手動で書き換える）。
 *
 * @param {string} dateStr    "YYYY-MM-DD"
 * @param {string} [calendarId] 省略時は getCalendar_()（CALENDAR_ID または本人）。
 *                              共有カレンダーのIDを渡すとそのカレンダーを見る。
 */
function inspectCalendarDay(dateStr, calendarId) {
  const cal = calendarId ? CalendarApp.getCalendarById(calendarId) : getCalendar_();
  if (!cal) throw new Error('カレンダーが見つかりません（共有・IDを確認）：' + calendarId);
  const range = dayRange_(dateStr);
  const events = cal.getEvents(range.start, range.end);

  Logger.log('===== カレンダー診断 ' + dateStr + ' =====');
  Logger.log('カレンダー: ' + cal.getName() + '（' + cal.getId() + '）');
  Logger.log('イベント件数: ' + events.length);

  events.forEach(function (ev, i) {
    const s = ev.getStartTime();
    const e = ev.getEndTime();
    Logger.log('--- [' + (i + 1) + '] ' + hhmm_(s) + '〜' + hhmm_(e) + ' ---');
    Logger.log('  タイトル: ' + safe_(function () { return ev.getTitle(); }));
    Logger.log('  ID      : ' + safe_(function () { return ev.getId(); }));
    Logger.log('  説明    : ' + String(safe_(function () { return ev.getDescription(); })).replace(/\n/g, ' / '));
    Logger.log('  場所    : ' + safe_(function () { return ev.getLocation(); }));
    Logger.log('  色      : ' + safe_(function () { return ev.getColor(); }));
    Logger.log('  作成者  : ' + safe_(function () { return ev.getCreators().join(', '); }));
    Logger.log('  ゲスト  : ' + safe_(function () {
      return ev.getGuestList().map(function (g) {
        return g.getEmail() + '(' + g.getName() + ')';
      }).join(', ');
    }));
  });

  // 実書式（授業名（利用者名）教室／説明にスタッフ氏名）からの構造抽出
  Logger.log('----- 構造抽出（機能Bの突合キー）-----');
  events.forEach(function (ev, i) {
    const info = parseEvent_(ev);
    Logger.log('[' + (i + 1) + '] 授業=' + info.className
      + ' / 利用者=' + info.user
      + ' / 教室=' + info.room
      + ' / スタッフ(' + info.staff.length + ')=' + info.staff.join('・'));
  });

  // 同じ時間帯に重なるペアを検出して、区別できる材料を示す
  Logger.log('----- 重なり（同時間帯）の検出 -----');
  reportOverlaps_(events);
  Logger.log('===== 終了 =====');
}

/**
 * 1イベントから機能Bの突合に使う情報を取り出す。
 *   タイトル "授業名（利用者名）教室" → className / user / room
 *   説明（改行区切りのスタッフ氏名）   → staff[]
 * 先頭の SEED_TAG は除去する。全角・半角どちらの括弧にも対応。
 */
function parseEvent_(ev) {
  var title = String(safe_(function () { return ev.getTitle(); }));
  if (title.indexOf(SEED_TAG) === 0) title = title.slice(SEED_TAG.length);

  var className = title, user = '', room = '';
  const m = title.match(/^(.*?)[（(](.*?)[)）](.*)$/);
  if (m) {
    className = m[1].trim();
    user = m[2].trim();
    room = m[3].trim();
  }

  const desc = String(safe_(function () { return ev.getDescription(); }));
  const staff = desc
    .split(/\r?\n/)
    .map(function (s) { return s.replace(/<[^>]*>/g, '').trim(); }) // 説明のHTMLタグ除去
    .filter(function (s) { return s.length > 0; });

  return { className: className, user: user, room: room, staff: staff };
}

/**
 * イベント配列から時間が重なるペアを見つけ、何で区別できるかを判定して表示する。
 */
function reportOverlaps_(events) {
  var found = 0;
  for (var i = 0; i < events.length; i++) {
    for (var j = i + 1; j < events.length; j++) {
      const a = events[i], b = events[j];
      // [start,end) が重なるか
      if (a.getStartTime() < b.getEndTime() && b.getStartTime() < a.getEndTime()) {
        found++;
        const ta = safe_(function () { return a.getTitle(); });
        const tb = safe_(function () { return b.getTitle(); });
        Logger.log('● 重なり: 「' + ta + '」× 「' + tb + '」（'
          + hhmm_(a.getStartTime()) + '〜 / ' + hhmm_(b.getStartTime()) + '〜）');
        const keys = distinguishers_(a, b);
        Logger.log('   区別できる材料: ' + (keys.length ? keys.join(', ') : '⚠️ なし（IDのみ。中身では人物を特定できない）'));
      }
    }
  }
  if (found === 0) Logger.log('（重なるイベントはありませんでした）');
}

/**
 * 2イベントの「人物特定に使える差分」を列挙する。
 * タイトル/説明/場所/色/ゲストのどれが異なるかを返す。
 */
function distinguishers_(a, b) {
  const keys = [];
  function differ(label, fn) {
    const va = String(safe_(function () { return fn(a); })).trim();
    const vb = String(safe_(function () { return fn(b); })).trim();
    if (va !== vb) keys.push(label);
  }
  differ('タイトル', function (x) { return x.getTitle(); });
  differ('説明', function (x) { return x.getDescription(); });
  differ('場所', function (x) { return x.getLocation(); });
  differ('色', function (x) { return x.getColor(); });
  differ('ゲスト', function (x) {
    return x.getGuestList().map(function (g) { return g.getEmail(); }).sort().join(',');
  });
  return keys;
}

// ─── テスト用：疑似イベントの生成 / 削除 ────────────────────

// 疑似データの目印。タイトル先頭に付け、削除時はこれで判定する（実イベントを消さないため）。
const SEED_TAG = '【テスト】';

/**
 * テストカレンダーに「2人テイク」を含む疑似イベントを作る。実データは一切使わない。
 * 同じ時間帯に2件並ぶ状況を再現し、機能Bの突合・区別ロジックを検証する用途。
 *
 * イベントには staff_id / course_id を「説明欄」に入れて、人物を特定できる形にしている。
 * （これは「カレンダーにどう書けば機能Bが成立するか」の設計案そのもの。）
 *
 * @param {string} calendarId テストカレンダーのID（必須・安全のため明示指定）
 */
function seedTestCalendar(calendarId) {
  if (!calendarId) throw new Error('テストカレンダーのIDを引数で指定してください（実カレンダーへの誤投入防止）。');
  const cal = CalendarApp.getCalendarById(calendarId);
  if (!cal) throw new Error('カレンダーが見つかりません：' + calendarId);

  // 実際のカレンダー書式に合わせる：
  //   タイトル = 授業名（利用者名）開講教室
  //   説明     = 学生スタッフ氏名を改行区切りで列挙（2人テイクなら2行）
  // 2026-05-12（火）に、2人テイクの別授業2コマ（同時刻＝重なり）＋1人テイク1コマを作る。
  const events = [
    // 15:15〜16:45・授業A（利用者A）22号館201：スタッフ2名
    { date: '2026-05-12', start: '15:15', end: '16:45',
      className: '英語コミュニケーションI', user: '利用者A', room: '22号館201',
      staff: ['田中太郎', '佐藤花子'] },
    // 同時刻・別授業B（利用者B）22号館305：スタッフ2名（←別イベントとして重なる）
    { date: '2026-05-12', start: '15:15', end: '16:45',
      className: '基礎数学', user: '利用者B', room: '22号館305',
      staff: ['鈴木一郎', '高橋次郎'] },
    // 13:30〜15:00・授業C（利用者C）：1人テイク
    { date: '2026-05-12', start: '13:30', end: '15:00',
      className: '心理学概論', user: '利用者C', room: '21号館101',
      staff: ['山本三郎'] },
  ];

  events.forEach(function (ev) {
    const s = parseDateTime_(ev.date, ev.start);
    const e = parseDateTime_(ev.date, ev.end);
    const title = SEED_TAG + ev.className + '（' + ev.user + '）' + ev.room;
    const desc = ev.staff.join('\n');
    cal.createEvent(title, s, e, { description: desc }); // ゲストは付けない（招待メールを飛ばさない）
  });

  Logger.log('疑似イベントを ' + events.length + ' 件作成しました（' + cal.getName() + '）。');
  Logger.log('→ inspectCalendarDay("2026-05-12", "' + calendarId + '") で診断できます。');
}

/**
 * seedTestCalendar が作った疑似イベント（SEED_TAG 付き）だけを削除する。
 * @param {string} calendarId テストカレンダーのID
 * @param {string} dateStr    "YYYY-MM-DD"（その日の疑似イベントを掃除）
 */
function clearTestCalendarSeed(calendarId, dateStr) {
  if (!calendarId) throw new Error('テストカレンダーのIDを指定してください。');
  const cal = CalendarApp.getCalendarById(calendarId);
  if (!cal) throw new Error('カレンダーが見つかりません：' + calendarId);
  const range = dayRange_(dateStr);
  var n = 0;
  cal.getEvents(range.start, range.end).forEach(function (ev) {
    if (String(ev.getTitle()).indexOf(SEED_TAG) === 0) { ev.deleteEvent(); n++; }
  });
  Logger.log('疑似イベントを ' + n + ' 件削除しました（' + dateStr + '）。');
}

// "2026-05-12","15:15" → Date
function parseDateTime_(dateStr, hhmm) {
  const d = dayRange_(dateStr).start;
  const t = String(hhmm).split(':');
  d.setHours(Number(t[0]), Number(t[1]), 0, 0);
  return d;
}

// ─── デバッグ用 ──────────────────────────────────────────────

/**
 * 自分がアクセスできる全カレンダー（個人＋共有＋購読）を一覧表示する。
 * 共有シフトカレンダーの「ID」をここで見つけて、CALENDAR_ID に設定する。
 */
function listCalendars() {
  Logger.log('===== アクセス可能なカレンダー一覧 =====');
  const all = CalendarApp.getAllCalendars();
  Logger.log('件数: ' + all.length);
  all.forEach(function (c, i) {
    const owned = safe_(function () { return c.isOwnedByMe() ? 'owner' : 'shared'; });
    Logger.log('--- [' + (i + 1) + '] ' + c.getName() + ' ---');
    Logger.log('  ID   : ' + c.getId());
    Logger.log('  権限 : ' + owned);
  });
  Logger.log('→ シフトが入った共有カレンダーのIDを CALENDAR_ID に設定するか、');
  Logger.log('  testInspectCalendarOn でそのIDを直接指定して診断できます。');
  Logger.log('===== 終了 =====');
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
