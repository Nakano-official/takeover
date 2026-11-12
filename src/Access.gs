/**
 * 学生への公開の切り替え（D56）
 *
 * 職員がシフトを入れ終えるまで、学生には「準備中」を見せる。
 * 導入のとき、全員に先に利用登録してもらい、承認した人から順にシフトを入れ、
 * 揃ったら職員がスイッチ1つで公開する（仮のスタッフを作る案はやめた）。
 *
 * - 準備中でも学生が使えるのは**マイページだけ**（連絡先・空きコマを本人が直せるように）。
 *   ヘルプも開ける（getHelp は止めない）。
 * - 職員と、未登録の人の申請画面は影響を受けない。
 * - 画面だけでなく、学生が呼べるサーバー関数も止める（getOpenUser_）。
 *   画面を介さずに google.script.run で呼ばれても通さないため。
 * - 値はスクリプトのプロパティ STUDENT_ACCESS に持つ。'closed' のときだけ準備中。
 *   **無い＝公開中**（この仕組みを入れる前の本番をそのまま動かすため）。
 */

const STUDENT_ACCESS_PROP = 'STUDENT_ACCESS';
const STUDENT_ACCESS_CLOSED = 'closed';
// 準備中でも学生が開ける画面
const PAGES_OPEN_WHILE_CLOSED = ['mypage'];
const CLOSED_MESSAGE = 'ただいま準備中です。準備が整ったら使えるようになります。';

function isClosedForStudents_() {
  const v = PropertiesService.getScriptProperties().getProperty(STUDENT_ACCESS_PROP);
  return String(v == null ? '' : v).trim() === STUDENT_ACCESS_CLOSED;
}

// この人が今、準備中で止められる人か（職員は止めない）
function isClosedFor_(user) {
  return !!user && user.role !== ROLE_STAFF && isClosedForStudents_();
}

/**
 * getCurrentUser_ と同じものを返すが、準備中の学生なら止める。
 * 学生が呼べる画面の関数（シフト確認・欠勤連絡・欠員一覧・代行）はこちらを使う。
 * 未登録（null）はそのまま返す（それぞれの関数が「利用登録がありません」で止める）。
 */
function getOpenUser_() {
  const user = getCurrentUser_();
  if (isClosedFor_(user)) throw new Error(CLOSED_MESSAGE);
  return user;
}

/** 職員の画面（利用登録の承認）が、いまの公開の状態を読む */
function getStudentAccess() {
  requireStaff_();
  return { open: !isClosedForStudents_() };
}

/**
 * 学生への公開を切り替える。学生へ Chat などで知らせることはしない（ユーザー判断・2026-11-12）。
 * @param {boolean} open true＝公開中／false＝準備中
 */
function setStudentAccess(open) {
  requireStaff_();
  if (open !== true && open !== false) throw new Error('公開の切り替えの値が不正です。');
  const props = PropertiesService.getScriptProperties();
  if (open) props.deleteProperty(STUDENT_ACCESS_PROP);
  else props.setProperty(STUDENT_ACCESS_PROP, STUDENT_ACCESS_CLOSED);
  return { open: open };
}
