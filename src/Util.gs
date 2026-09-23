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
