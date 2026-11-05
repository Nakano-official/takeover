/**
 * 横断的な小道具置き場
 *
 * 特定の機能に属さない、**依存の無い純粋な関数**だけをここに置く。
 *
 * かつては機能モジュールに間借りしていた。`isChatWebhook_` は Google フォーム取り込みの
 * `Forms.gs` にあり、マイページ（`Profile.gs`）と利用登録の承認（`Registration.gs`）が
 * それを呼んでいた。この形だと**使わなくなった機能を消すときに、生きている関数が
 * 巻き添えになる**。実際 `Forms.gs` を廃止するとき（D39）にそれが起きた。
 *
 * 置いてよいもの：GAS API もシートも参照しない、入力→出力だけの関数。
 * 置いてはいけないもの：業務のルール（Constants.gs か、その機能のファイルへ）。
 */

// Google Chat の Incoming Webhook URL 形式かどうか（誤URL・別宛先の混入防止）
function isChatWebhook_(url) {
  return /^https:\/\/chat\.googleapis\.com\//.test(String(url).trim());
}

// ─── 入力の形（シートに書く前の確認）────────────────────────
//
// 先頭が = + - @ の文字は、スプレッドシートが式として扱う（文字列に固定した列を除く）。
// 自由に書ける欄は、書き込む前にここを通す。画面（input.html）にも同じ形の確認がある。
const FORMULA_LIKE_RE_ = /^[=+\-@＝＋－＠]/;

function assertNotFormula_(label, value) {
  if (FORMULA_LIKE_RE_.test(String(value == null ? '' : value).trim())) {
    throw new Error(label + 'の先頭に = + - @ は使えません（スプレッドシートで数式として扱われるため）。');
  }
}

/**
 * 人の名前として受け付けられるか（利用登録の氏名など）。
 * 名前は画面・Chat の通知・シートのあちこちに出るので、記号は最小限にする。
 * < > は Chat の文面でメンションやリンクの書式になるので使わせない。
 * @return {string} 前後の空白を除いた名前
 */
function validatePersonName_(label, value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) throw new Error(label + 'を入力してください。');
  if (s.length > 40) throw new Error(label + 'は40文字以内で入力してください。');
  if (/[<>"\\\u0000-\u001f\u007f]/.test(s)) {
    throw new Error(label + 'に使えない記号が含まれています（< > " \\ など）。');
  }
  assertNotFormula_(label, s);
  return s;
}

/**
 * 電話番号の形を揃える（090-1234-5678）。全角は半角に直す。空は許す（必須かどうかは呼び出し側）。
 * ハイフンの無い11桁（古い書き方）は 3-4-4 に分ける。
 * @return {string} 揃えた番号
 */
function validatePhone_(value) {
  const s = String(value == null ? '' : value).trim()
    .replace(/[０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/[－ー‐−]/g, '-');
  if (!s) return '';
  if (/^\d{11}$/.test(s)) return s.slice(0, 3) + '-' + s.slice(3, 7) + '-' + s.slice(7);
  const digits = s.replace(/-/g, '').length;
  if (!/^0\d{1,4}-\d{1,4}-\d{4}$/.test(s) || digits < 10 || digits > 11) {
    throw new Error('電話番号は 090-1234-5678 の形で入れてください。');
  }
  return s;
}

/**
 * 時刻のパース（機能Aの締切判定が使う）。
 *
 * もとは Attendance.gs（機能B）にあり、`Vacancy.gs` の `periodStartMinutes_` が
 * 借りていた。機能Bを今回のリリースから外す（D41）にあたって、
 * **生きている機能が道連れにならないよう**ここへ移した。
 *
 * periods.start_time は文字列（'09:15'）と Date の両方がありうるので、両方を受ける。
 */
// 'H:mm' / 'HH:mm'（前後空白可）→ 0時からの分。空・不正なら null。
function hhmmToMin_(v) {
  const m = String(v == null ? '' : v).trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// Date を日本時間の「0時からの分」に変換
function jstMinutes_(d) {
  const hm = Utilities.formatDate(d, 'Asia/Tokyo', 'HH:mm');
  return hhmmToMin_(hm);
}
