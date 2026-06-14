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
