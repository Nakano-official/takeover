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
