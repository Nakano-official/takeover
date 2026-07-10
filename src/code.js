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
const PAGES = {
  home:    { file: 'home',    title: 'シフト確認',         staffOnly: false },
  input:   { file: 'input',   title: 'シフト入力',         staffOnly: true  },
  absence: { file: 'absence', title: '欠勤連絡',           staffOnly: false },
  respond: { file: 'respond', title: '代行依頼への回答',   staffOnly: false },
  manage:  { file: 'manage',  title: '欠員補充管理',       staffOnly: true  },
  check:   { file: 'check',   title: '整合性チェック',     staffOnly: true  },
};

const DEFAULT_PAGE = 'home';
const ROLE_STAFF = '職員';

// ─── エントリポイント ────────────────────────────────────────

function doGet(e) {
  const params = (e && e.parameter) || {};

  // 物理アラート端末（M5Stack）用の軽量エンドポイント（decisions.md D6）。
  // ?device=alert&token=（秘密文字列）で叩く。返すのは件数＋最新欠員番号のみ＝個人情報なし（D3と整合）。
  // 画面のルーティングより前に処理し、ログイン不要（トークンで保護）にする。
  if (params.device === 'alert') {
    return handleDevicePoll_(params);
  }

  const pageKey = params.page || DEFAULT_PAGE;
  const config = PAGES[pageKey];

  // 未知の page は既定画面へフォールバック
  if (!config) {
    return renderPage_(PAGES[DEFAULT_PAGE], DEFAULT_PAGE, getCurrentUser_(), {});
  }

  const user = getCurrentUser_();

  // 利用登録（contacts に存在）がないユーザーは拒否
  if (!user) {
    return renderMessage_(
      '利用登録がありません',
      'このアカウントは支援室シフト管理システムに登録されていません。職員にお問い合わせください。'
    );
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
    staff_id: contact.staff_id,
    name: staff ? staff.name : contact.name,
    role: staff ? String(staff.role).trim() : '',
  };
}

// メールは大文字小文字を無視して照合する
function findRowCI_(sheetName, columnName, value) {
  const target = String(value).trim().toLowerCase();
  const rows = readRows(sheetName);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i][columnName]).trim().toLowerCase() === target) return rows[i];
  }
  return null;
}

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

  return template
    .evaluate()
    .setTitle(config.title + ' | 支援室シフト管理')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.DEFAULT);
}

// 簡易メッセージ画面（エラー・準備中など）
function renderMessage_(heading, message) {
  const safeHeading = escapeHtml_(heading);
  const safeMessage = escapeHtml_(message);
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<style>body{font-family:sans-serif;margin:0;padding:2rem;background:#f5f5f5;color:#333;}' +
    '.box{max-width:480px;margin:3rem auto;background:#fff;border-radius:8px;padding:2rem;' +
    'box-shadow:0 1px 4px rgba(0,0,0,.1);}h1{font-size:1.2rem;margin:0 0 1rem;}' +
    'p{line-height:1.7;margin:0;}</style></head>' +
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
 * @param {string} [quarter] 表示するクォーター（省略可）
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

  const courses = allCourses
    .filter(function (c) { return filterSet[String(c.quarter).trim()]; })
    .map(function (c) {
      const courseId = String(c.course_id).trim();
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
        status: status,
        substitute: substitute,
      };
    });

  // 軸は「時間割の枠」として固定する。標準曜日（月〜金）と時限マスタの全時限を
  // 常に並べ、コマが無い曜日・時限も空欄の枠として残す（土日や課外時限は登場時のみ追加）。
  const DAY_ORDER = ['月', '火', '水', '木', '金', '土', '日'];
  const STANDARD_DAYS = ['月', '火', '水', '木', '金'];
  const daySet = {};
  STANDARD_DAYS.forEach(function (d) { daySet[d] = true; });
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

  return {
    quarters: sel.options, quarter: sel.selected,
    days: days, periods: periods, courses: courses, me: me,
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
