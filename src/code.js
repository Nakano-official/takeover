/**
 * エントリポイント（Web App）
 *
 * doGet が ?page= パラメータを見て画面を振り分ける。
 * すべてのリクエストでログインユーザーを特定し、職員限定画面のアクセス制御を行う。
 *
 * Web App は「自分（デプロイした職員）として実行」でデプロイする。
 * これにより学生が連絡先DBへの直接権限を持たなくても処理が動く。
 * その代わり、ロール判定をこのコードで必ず行う（architecture.md §7）。
 */

// 画面定義：page パラメータ → HTMLファイル名・タイトル・職員限定フラグ
//
// hideInStaffNav: 職員のナビには出さない画面。アクセス自体は禁止しない
//   （staffOnly とは別の概念。URLで開けば従来どおり動く）。
const PAGES = {
  deviceRelay: { file: 'device-relay', title: 'USB欠員通知', staffOnly: true },
  home:    { file: 'home',    title: 'シフト確認',         staffOnly: false },
  input:   { file: 'input',   title: 'シフト入力',         staffOnly: true  },
  // 欠勤連絡は「学生スタッフが自分の担当コマの欠勤を出す」画面。職員には担当コマが
  // 無く常に空になるため、職員のナビには並べない。
  absence: { file: 'absence', title: '欠勤連絡',           staffOnly: false, hideInStaffNav: true },
  respond: { file: 'respond', title: '代行依頼への回答',   staffOnly: false },
  manage:  { file: 'manage',  title: '欠員補充管理',       staffOnly: true  },
  check:   { file: 'check',   title: '整合性チェック',     staffOnly: true  },
  terms:   { file: 'terms',   title: '学期設定',           staffOnly: true  },
  // マイページ（D28）。本人が自分の連絡先と空きコマを直す画面なので、職員・学生とも入れる。
  // 編集できる項目はサーバー側（Profile.gs）で固定してあり、画面からは増やせない。
  mypage:  { file: 'mypage',  title: 'マイページ',         staffOnly: false },
  // 利用登録の申請（D28）。**名簿（contacts）に無いアカウントでも開ける唯一の画面**。
  // doGet が未登録者をここへ回す。ナビには出さない（登録済みの人には用が無いため）。
  signup:  { file: 'signup',  title: '利用登録の申請',     staffOnly: false },
  // 申請の承認（D28）。ここが staffs / contacts に行を作る唯一の経路。
  approvals: { file: 'approvals', title: '利用登録の承認', staffOnly: true },
  // M5Stack への USB 中継用（別担当）。職員がログイン済みのPCでこの画面を開いたままにし、
  // PC側の中継プログラムが window.readShiftUsbSummary() を読んで USB で端末へ送る。
  // ナビには出さない（人が操作する画面ではなく、中継が開きっぱなしにする画面のため）。
  deviceRelay: { file: 'device-relay', title: 'USB欠員通知', staffOnly: true },
};

// 未登録アカウントを受け止める画面。PAGES のキーと合わせること。
const SIGNUP_PAGE = 'signup';
// ヘッダー右上のユーザーアイコンから開く画面。ナビには並べない。
const MYPAGE_PAGE = 'mypage';

// ナビに並べる画面（この順で表示する）。
// respond は通知リンクから ?vacancy= 付きで開く画面なので、ナビには出さない。
// ここに足せば全画面のナビに一斉に反映される（staffOnly は PAGES 側で自動判定）。
// マイページはここに入れない。ヘッダー右上のユーザーアイコンから入る（renderChrome_）。
const NAV_PAGES = ['home', 'absence', 'input', 'manage', 'approvals', 'check', 'terms'];

const DEFAULT_PAGE = 'home';
// ROLE_STAFF（'職員'）はドメイン定数なので Constants.gs にある（関数内から参照すること）。

// ─── エントリポイント ────────────────────────────────────────

function doGet(e) {
  const params = (e && e.parameter) || {};

  // 物理アラート端末（M5Stack）用の軽量エンドポイント（decisions.md D6）。
  // ?device=alert&token=（秘密文字列）で叩く。返すのは件数＋最新欠員番号のみ＝個人情報なし（D3と整合）。
  // 画面のルーティングより前に処理し、ログイン不要（トークンで保護）にする。
  if (params.device === 'alert') {
    return handleDevicePoll_(params);
  }

  // 未知の page は既定画面へフォールバックするが、必ず以降の共通ガード
  // （null ユーザー拒否 → staffOnly 判定）を通す。ここで renderPage_ を直接呼ぶと
  // 未登録ユーザーが ?page=xxx で利用登録ゲートを素通りできてしまう（旧実装のバグ）。
  const pageKey = PAGES[params.page] ? params.page : DEFAULT_PAGE;
  const config = PAGES[pageKey];

  const user = getCurrentUser_();

  // 名簿（contacts）に無いアカウントは、行き止まりにせず**申請画面へ回す**（D28）。
  // かつては「職員にお問い合わせください」で終わりだったため、名簿登録が全部職員の手作業だった。
  // ここを開けても名簿は汚れない。申請は registrations に溜まるだけで、
  // staffs / contacts に行ができるのは職員が承認したときだけ（Registration.gs）。
  if (!user) {
    return renderPage_(PAGES[SIGNUP_PAGE], SIGNUP_PAGE, null, params);
  }

  // 登録済みの人に申請画面は用が無いので既定画面へ送る
  if (pageKey === SIGNUP_PAGE) {
    return renderPage_(PAGES[DEFAULT_PAGE], DEFAULT_PAGE, user, params);
  }

  // 職員限定画面のアクセス制御
  if (config.staffOnly && user.role !== ROLE_STAFF) {
    return renderMessage_(
      'アクセス権限がありません',
      'この画面は職員のみが利用できます。'
    );
  }

  return renderPage_(config, pageKey, user, params);
}

// ─── ユーザー特定（ロール判定）──────────────────────────────

/**
 * ログイン中のユーザーを特定して { email, staff_id, name, role } を返す。
 * contacts でメール → staff_id を引き、staffs で role を引く。
 * 登録が無ければ null。
 */
function getCurrentUser_() {
  const email = Session.getActiveUser().getEmail();
  if (!email) return null;

  const contact = findRowCI_(SHEET.CONTACTS, 'email', email);
  if (!contact) return null;

  const staff = findRow(SHEET.STAFFS, 'staff_id', contact.staff_id);
  return {
    email: email,
    // staff_id は正規化して返す（Vacancy.gs 等が String().trim() 済みIDと === で比較するため、
    // contacts のセルが数値や前後空白付きだと自己除外・重複欠勤チェック・相方表示が不成立になる）。
    staff_id: String(contact.staff_id).trim(),
    name: staff ? staff.name : contact.name,
    role: staff ? String(staff.role).trim() : '',
  };
}

// findRowCI_（大文字小文字を無視した行検索）はデータアクセスなので Sheets.gs にある。

// 呼び出し側が職員かどうかを保証する（google.script.run で呼ぶサーバー関数の先頭で使う）
function requireStaff_() {
  const user = getCurrentUser_();
  if (!user) throw new Error('利用登録がありません。');
  if (user.role !== ROLE_STAFF) throw new Error('職員権限が必要です。');
  return user;
}

// ─── 画面描画 ────────────────────────────────────────────────

function renderPage_(config, pageKey, user, params) {
  var template;
  try {
    template = HtmlService.createTemplateFromFile(config.file);
  } catch (err) {
    // HTMLが未作成でもエラーで落とさず「準備中」を出す（段階的に画面を足すため）
    return renderMessage_('準備中', '「' + config.title + '」画面は現在準備中です。');
  }

  // テンプレートから参照できる値を渡す
  template.user = user || {};
  template.pageKey = pageKey;
  template.params = params;
  template.appUrl = getAppUrl_();
  // ヘッダー＋ナビはここで組み立て、各画面は <?!= chrome ?> で貼るだけにする。
  // 画面ごとに手書きしないので、ナビの抜け漏れ（学期設定リンクが無い等）が起きない。
  template.chrome = renderChrome_(config, pageKey, user);

  return template
    .evaluate()
    .setTitle(config.title + ' | 支援室シフト管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

/**
 * 全画面共通のヘッダー＋ナビHTMLを組み立てる。
 *
 * ナビの中身は PAGES / NAV_PAGES から生成するので、画面を1つ足せば全画面のナビに載る。
 * 学生には staffOnly の画面を出さない（サーバー側のアクセス制御 doGet と同じ判定を使う）。
 * 見た目のCSSは shared-styles.html 側（.appbar / .appnav）にある。
 *
 * @param {Object} config  表示中の画面定義（PAGES の値）
 * @param {string} pageKey 表示中の page キー（現在地のハイライト用）
 * @param {Object} user    ログイン中ユーザー（role でナビを出し分ける）
 * @return {string} ヘッダー＋ナビのHTML
 */
function renderChrome_(config, pageKey, user) {
  const appUrl = getAppUrl_();
  const isStaff = user && user.role === ROLE_STAFF;

  // 未登録者（申請画面）にはナビを出さない。行ける画面がまだ無いので、
  // リンクを並べても押した先で弾かれるだけになる。
  const visible = !user ? [] : NAV_PAGES.filter(function (key) {
    const p = PAGES[key];
    if (!p) return false;
    if (p.staffOnly && !isStaff) return false;       // 職員限定画面は学生に出さない
    if (p.hideInStaffNav && isStaff) return false;   // 学生専用の画面は職員に出さない
    return true;
  });

  const links = visible.map(function (key) {
    const current = key === pageKey;
    return '<a' + (current ? ' class="on" aria-current="page"' : '') +
      ' href="' + escapeHtml_(appUrl) + '?page=' + encodeURIComponent(key) + '">' +
      escapeHtml_(PAGES[key].title) + '</a>';
  }).join('');

  // 画面数が少ないとき（学生＝シフト確認・欠勤連絡の2つ）は、ナビを
  // 「画面いっぱいの切り替えボタン」にして押しやすくする（.few）。
  // 職員のように項目が多いときは、従来どおり横スクロールのピル並びにする。
  const few = visible.length <= 3 ? ' few' : '';

  return '' +
    '<header class="appbar">' +
      '<h1>' + escapeHtml_(config.title) + '</h1>' +
      renderUserChip_(appUrl, pageKey, user) +
    '</header>' +
    '<nav class="appnav' + few + '">' + links + '</nav>';
}

/**
 * ヘッダー右上のユーザー表示を作る。
 *
 * 登録済みなら**マイページへのリンク**にする。ナビの項目数を増やさずに導線を置けるうえ、
 * 「自分の情報を直す」は他の画面（時間割・欠員管理）と並ぶ性質のものではないため。
 * 未登録（申請画面）ではリンクにしない — 行ける先がまだ無い。
 */
function renderUserChip_(appUrl, pageKey, user) {
  if (!user) return '<span class="user">まだ利用登録がありません</span>';
  const current = pageKey === MYPAGE_PAGE ? ' on' : '';
  return '<a class="user' + current + '" href="' + escapeHtml_(appUrl) +
    '?page=' + encodeURIComponent(MYPAGE_PAGE) + '" title="マイページ（連絡先・空きコマの変更）">' +
    '<span class="avatar" aria-hidden="true">👤</span>' +
    '<span class="uname">' + escapeHtml_(user.name || '') +
      '<small>' + escapeHtml_(user.role || '') + '</small></span>' +
    '</a>';
}

// 簡易メッセージ画面（エラー・準備中など）
function renderMessage_(heading, message) {
  const safeHeading = escapeHtml_(heading);
  const safeMessage = escapeHtml_(message);
  // 共通スタイル（shared-styles）はテンプレート外なので、ここだけは最小限のCSSを直書きする。
  // トークンの値は shared-styles.html の :root と揃えておくこと。
  const html =
    '<!DOCTYPE html><html lang="ja"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font-family:"Helvetica Neue",Arial,"Hiragino Sans","Noto Sans JP",' +
    '"Yu Gothic",sans-serif;margin:0;padding:1.5rem;background:#f4f6fa;color:#1b2430;' +
    'line-height:1.7;-webkit-font-smoothing:antialiased;}' +
    '.box{max-width:480px;margin:3rem auto;background:#fff;border:1px solid #e3e8ef;' +
    'border-radius:10px;padding:2rem;box-shadow:0 1px 2px rgba(16,24,40,.05),0 1px 3px rgba(16,24,40,.07);}' +
    'h1{font-size:1.15rem;margin:0 0 .75rem;color:#1f47a8;}' +
    'p{margin:0;color:#667281;}</style></head>' +
    '<body><div class="box"><h1>' + safeHeading + '</h1><p>' + safeMessage + '</p></div></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(heading + ' | 支援室シフト管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

// HTMLテンプレートから他ファイル（CSS/JS断片）を読み込む共通ヘルパー
// 使い方： HTML内で <?!= include('style') ?>
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

// このWeb App自身のURL（画面間リンクの生成に使う）
function getAppUrl_() {
  return ScriptApp.getService().getUrl();
}

// ─── 画面用データAPI（google.script.run から呼ぶ）───────────

/**
 * シフト確認画面（home）用のダッシュボードデータを返す。
 * courses に staffs(氏名)・periods(時刻)・vacancies(状況) を結合する。
 */
function getDashboardData() {
  // 読み取り専用画面だが、未登録ユーザーには返さない
  if (!getCurrentUser_()) throw new Error('利用登録がありません。');

  const nameById = {};
  readRows(SHEET.STAFFS).forEach(function (s) {
    nameById[String(s.staff_id).trim()] = s.name;
  });

  const periodById = {};
  readRows(SHEET.PERIODS).forEach(function (p) {
    periodById[String(p.period).trim()] = p;
  });

  const vacancies = readRows(SHEET.VACANCIES);

  return readRows(SHEET.COURSES).map(function (c) {
    const courseId = String(c.course_id).trim();
    const p = periodById[String(c.period).trim()] || {};

    // このコマに紐づく欠員から状況を判定する
    const related = vacancies.filter(function (v) {
      return String(v.course_id).trim() === courseId;
    });
    var status = COURSE_VACANCY_STATUS.NORMAL;
    var substitute = '';
    const open = related.filter(function (v) { return !String(v.result).trim(); });
    if (open.length > 0) {
      status = COURSE_VACANCY_STATUS.OPEN;
    } else if (related.length > 0) {
      const latest = related[related.length - 1];
      status = String(latest.result).trim(); // 補充済 / 1人テイク / 職員対応
      const subId = String(latest.substitute_staff_id || '').trim();
      if (subId) substitute = nameById[subId] || subId;
    }

    return {
      course_id: courseId,
      quarter: c.quarter,
      day: c.day,
      period: String(c.period).trim(),
      time: p.start_time ? p.start_time + '〜' + p.end_time : '',
      staffA: nameById[String(c.staff_a_id).trim()] || c.staff_a_id || '',
      staffB: nameById[String(c.staff_b_id).trim()] || c.staff_b_id || '',
      status: status,
      substitute: substitute,
    };
  });
}

/**
 * 時間割ビュー（home）用データ。利用者中心の courses（D8）に
 * 担当氏名・時限の時刻・欠員状況を結合して返す。
 * クォーターで絞り込み（未指定なら最新クォーター）。
 *
 * 欠員（vacancies）は**特定の日付**に紐づくのに対し、courses は曜日×時限の
 * 週パターンなので、表示する「週」を決めないと日付を捨てることになる（D23）。
 * ここでは週を決め打ちせず、欠員を「course_id|日付」の索引（vacancy）として渡し、
 * どの週を表示するかはクライアントに任せる。週送りでサーバーへ往復しないで済む。
 *
 * @param {string} [quarter] 表示する学期（省略可）
 */
function getTimetable(quarter) {
  const user = getCurrentUser_();
  if (!user) throw new Error('利用登録がありません。');

  const nameById = {};
  readRows(SHEET.STAFFS).forEach(function (s) {
    nameById[String(s.staff_id).trim()] = s.name;
  });

  // ログイン中スタッフの「対応可能な内容（スキル）」と「空きコマ」。
  // クライアントで「自分が入れる募集中」を判定するために返す（D8③）。
  const meRow = findRow(SHEET.STAFFS, 'staff_id', user.staff_id);
  const splitList = function (v) {
    return String(v || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  };
  const me = {
    name: user.name,
    role: user.role,
    skills: meRow ? splitList(meRow.skills) : [],
    slots: meRow ? splitList(meRow.available_slots) : [],
  };

  // 時限マスタ（時刻と並び順）
  const periodTime = {};
  const periodIndex = {};
  readRows(SHEET.PERIODS).forEach(function (p, i) {
    const key = String(p.period).trim();
    periodTime[key] = p.start_time ? p.start_time + '〜' + p.end_time : '';
    periodIndex[key] = i;
  });

  const vacancies = readRows(SHEET.VACANCIES);
  const allCourses = readRows(SHEET.COURSES);

  // 学期の選択を term マスタで解決する（11-3/D16）。
  // home は閲覧用なので既定は「現在（開講中）」＝今日を含む学期すべての和集合
  // （先端理工のクォーターと他学部のセメスターが同時に並ぶ）。
  const courseTermIds = [];
  allCourses.forEach(function (c) {
    const q = String(c.quarter).trim();
    if (q && courseTermIds.indexOf(q) === -1) courseTermIds.push(q);
  });
  const sel = resolveTermSelection_(quarter, courseTermIds, 'view');
  const filterSet = {};
  sel.filterIds.forEach(function (id) { filterSet[id] = true; });
  const sysMap = termSystemMap_(); // term_id → system（詳細表示で体系を出すため）

  // 単発コマ（D27）は学期フィルタを通さない。学期外の説明会・行事もありうるうえ、
  // どの週に出すかは date で決まるので、学期で落とすと「その日なのに出ない」が起きる。
  // 実際にどの週へ出すかはクライアントが date で判定する（週送りはサーバー往復なし・D23）。
  const courses = allCourses
    .filter(function (c) {
      return courseDate_(c) ? true : !!filterSet[String(c.quarter).trim()];
    })
    .map(function (c) {
      const courseId = String(c.course_id).trim();
      const term = String(c.quarter).trim();
      return {
        course_id: courseId,
        term: term,                          // 学期ID（例：2026-2Q / 2026-前期）
        system: sysMap[term] || '',          // quarter / semester（詳細表示用）
        day: String(c.day).trim(),
        period: String(c.period).trim(),
        support_type: String(c.support_type || '').trim(),
        user_student: String(c.user_student || '').trim(),
        subject: String(c.subject || '').trim(),
        instructor: String(c.instructor || '').trim(),
        room: String(c.room || '').trim(),
        staffA: nameById[String(c.staff_a_id).trim()] || String(c.staff_a_id || '').trim(),
        staffB: nameById[String(c.staff_b_id).trim()] || String(c.staff_b_id || '').trim(),
        note: String(c.note || '').trim(),
        oneOffDate: courseDate_(c),          // 単発コマの実施日（空＝毎週・D27）
        // status / substitute / absent / date は週によって変わるのでサーバーでは埋めない。
        // 下の vacancy（course_id|日付 の索引）から、クライアントが表示中の週ぶんだけ組み立てる。
      };
    });

  // 欠員の重ね合わせを「course_id|日付」で表示対象ぶんまとめて返す（D23）。
  //
  // 週を送るたびに getTimetable を呼び直すと、変わらない courses/staffs/periods/terms まで
  // 毎回読み直して往復1回ぶん待たされる。週で変わるのはこの重ね合わせだけなので、
  // 先に全部渡してクライアント側で週を切り替える（往復ゼロ）。
  // 件数は欠勤の発生回数ぶんで、コマ数に比べて十分小さい。
  const courseIdSet = {};
  courses.forEach(function (c) { courseIdSet[c.course_id] = true; });

  const byCourseDate = {};
  vacancies.forEach(function (v) {
    const cid = String(v.course_id).trim();
    if (!courseIdSet[cid]) return; // 表示対象外のコマ（別学期など）は返さない
    const key = cid + '|' + dateToStr_(v.date);
    if (!byCourseDate[key]) byCourseDate[key] = [];
    byCourseDate[key].push(v);
  });

  const vacancy = {};
  Object.keys(byCourseDate).forEach(function (key) {
    const related = byCourseDate[key];
    const absent = [];
    related.forEach(function (v) {
      const a = String(v.absent_staff_id).trim();
      if (a) absent.push(nameById[a] || a);
    });

    var status = COURSE_VACANCY_STATUS.NORMAL;
    var substitute = '';
    const open = related.filter(function (v) { return !String(v.result).trim(); });
    if (open.length > 0) {
      status = COURSE_VACANCY_STATUS.OPEN;
    } else {
      // 同じ日に複数件（A・B両方欠勤など）あるときは最後の行を代表にする。
      // 日付が同一なので「いつの話か分からない」問題は起きない。
      const latest = related[related.length - 1];
      status = String(latest.result).trim(); // 補充済 / 1人テイク / 職員対応
      const subId = String(latest.substitute_staff_id || '').trim();
      if (subId) substitute = nameById[subId] || subId;
    }
    vacancy[key] = { status: status, substitute: substitute, absent: absent };
  });

  // 軸は「時間割の枠」として固定する。月〜日の全曜日と時限マスタの全時限を常に並べ、
  // コマが無い曜日・時限も空欄の枠として残す。
  // 週表示にした以上、週の途中の曜日が抜けている方が不自然なので土日も枠として出す
  // （日曜に授業が入ることはほぼ無いが、枠としては置く）。
  // ※ シフト入力の選択肢は WORK_DAYS（月〜土・D17）で、ここは表示の枠だけの話。
  //   日曜は WORK_DAYS に無いので登録できないが、枠としてはここに出る。
  const DAY_ORDER = ['月', '火', '水', '木', '金', '土', '日'];
  const daySet = {};
  DAY_ORDER.forEach(function (d) { daySet[d] = true; });
  const periodSet = {};
  Object.keys(periodIndex).forEach(function (p) { periodSet[p] = true; }); // 時限マスタ全件
  courses.forEach(function (c) { daySet[c.day] = true; periodSet[c.period] = true; });
  const days = DAY_ORDER.filter(function (d) { return daySet[d]; });
  const periods = Object.keys(periodSet)
    .sort(function (a, b) {
      const ia = periodIndex[a] !== undefined ? periodIndex[a] : 999;
      const ib = periodIndex[b] !== undefined ? periodIndex[b] : 999;
      return ia - ib;
    })
    .map(function (p) { return { period: p, time: periodTime[p] || '' }; });

  // 学期の開講期間（term_id → {start, end}）。
  // 週表示では「その週のその日が学期の期間内か」をコマ単位で判定する必要がある。
  // これが無いと、後期の終了後の週へ送っても後期のコマが並び続ける（授業が無い日に
  // 授業があるように見える）。期間が未設定の学期は判定せず従来どおり表示する（D16 と同じ後方互換）。
  const termRange = {};
  readTerms_().forEach(function (t) {
    if (t.start_date && t.end_date) {
      termRange[t.term_id] = { start: t.start_date, end: t.end_date };
    }
  });

  return {
    quarters: sel.options, quarter: sel.selected,
    days: days, periods: periods, courses: courses, me: me,
    vacancy: vacancy,   // 'course_id|yyyy-MM-dd' → {status, substitute, absent[]}
    termRange: termRange, // term_id → {start, end}（週が開講期間内かの判定用）
    today: todayJst_(), // 「今週」の基準（端末の時計ではなくサーバーのJSTで判定する）
  };
}

// 文字列をHTMLエスケープする（メッセージ画面用）
function escapeHtml_(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── デバッグ用 ──────────────────────────────────────────────

// GASエディタから実行してログイン特定とロール判定を確認する
function whoAmI() {
  const email = Session.getActiveUser().getEmail();
  Logger.log('ログインメール: ' + (email || '(取得できず)'));
  const user = getCurrentUser_();
  if (!user) {
    Logger.log('→ 未登録（contacts にこのメールがありません）');
    Logger.log('  ※ テスト中は contacts のいずれかの email を自分のアドレスに変更すると登録扱いになります。');
    return;
  }
  Logger.log('→ staff_id: ' + user.staff_id);
  Logger.log('→ 氏名: ' + user.name);
  Logger.log('→ ロール: ' + user.role + (user.role === ROLE_STAFF ? '（職員：全画面可）' : '（学生：一般画面のみ）'));
}
