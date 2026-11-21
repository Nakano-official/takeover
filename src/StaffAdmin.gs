/**
 * スタッフの登録と、本人の確認（D64）
 *
 * 以前は学生が自分で利用登録を申請し（氏名・電話・通知先・空きコマ）、職員が承認していた（D28）。
 * 2026-11-21 に改めた：氏名・電話番号・大学のメールアドレスは**支援室の名簿にすでにある**ので、
 * **職員が名簿から登録する**。学生の入力の手間と、書き方の揺れ（名前・番号）を無くすため。
 *
 * ■ メールアドレスの打ち間違いへの備え
 *   職員が入れるメールアドレスを1文字間違えると、別の実在の学生に業務の連絡が届きうる。そこで：
 *   - 登録した人は**本人の確認がまだ**（contacts.confirmed_at が空）の状態から始まる
 *   - 初めて画面を開いたとき「あなたは〇〇 〇〇さんですか？」と出し（confirm.html）、「はい」で確認済みにする。
 *     「いいえ」なら職員スペースへ知らせる（メールアドレスの登録を直してもらう）
 *   - **確認がまだの人には通知を送らない**（buildWebhookMap_）。学生が使う画面の関数も止める（getOpenUser_）
 *
 * ■ すでにいる人は確認済み
 *   confirmed_at の列が無い（移行前）か、値が入っていれば確認済み。移行（migrateAddContactConfirmedAt）は
 *   列を足し、今いる全員に移行の日時を入れる。**空になるのは、ここで職員が新しく登録した人だけ**。
 *
 * ■ 登録するのは学生スタッフだけ
 *   職員のアカウントは支援室の共用アカウント1つだけで、増えない（構築のときに手で入れる・setup.md 1.4）。
 *   画面から区分を選べる入口を残すと、学生を誤って職員にしたときに連絡先DB全体が見える画面に入れてしまうので、
 *   区分は受け取らず、いつも「学生」で作る。
 *
 * ■ 職員が直せるもの
 *   氏名・電話番号・メールアドレス（updateStaffContact）。メールアドレスを変えたら確認をやり直す。
 *   空きコマ・通知先は今まで通り本人がマイページで直す。
 *
 * 公開関数（google.script.run から呼ぶ）:
 *  - registerStaff(items)       … 職員だけ。1人でも、名簿から貼った何人分でも
 *  - updateStaffContact(p)      … 職員だけ
 *  - confirmMyIdentity(isMe)    … 本人（確認がまだの人）
 */

const STAFF_REGISTER_MAX = 200;   // 1回に登録できる人数（貼り間違いで大量に作らないため）
// CONFIRMED_COL（Constants.gs）と isUnconfirmedContact_（Util.gs）は、本人確認・通知・名簿からも使うので共通の場所にある

function hasConfirmedColumn_() {
  return getHeaders_(SHEET.CONTACTS).map(function (x) { return String(x).trim(); }).indexOf(CONFIRMED_COL) !== -1;
}

function assertConfirmedColumn_() {
  if (!hasConfirmedColumn_()) {
    throw new Error('連絡先DBに confirmed_at 列がありません。GAS エディタから migrateAddContactConfirmedAt() を1回実行してください。');
  }
}

/** 大学のメールアドレスとして使える形か（形だけを見る。実在は本人の確認で確かめる） */
function normalizeStaffEmail_(value) {
  const email = String(value == null ? '' : value).trim();
  if (!email) throw new Error('メールアドレスを入れてください。');
  if (email.length > 254 || !/^[^\s@<>"'\\]+@[^\s@<>"'\\]+\.[^\s@<>"'\\]+$/.test(email)) {
    throw new Error('メールアドレスの形が違います：' + email);
  }
  assertNotFormula_('メールアドレス', email);
  return email;
}

/**
 * 1人分の入力をそろえる（登録・修正で共通）。
 * @param {{email, family_name, given_name, phone, skills}} raw   区分（role）は受け取らない（いつも学生）
 */
function normalizeStaffEntry_(raw) {
  const p = raw || {};
  const family = validatePersonName_('姓', p.family_name);
  const given = validatePersonName_('名', p.given_name);
  if (/[\s　]/.test(family + given)) throw new Error('姓と名の中に空白は入れないでください。');
  return {
    email: normalizeStaffEmail_(p.email),
    name: validatePersonName_('氏名', family + ' ' + given),   // 「姓 名」（半角スペース1つ・D54）
    phone: validatePhone_(p.phone),                              // 空なら空（名簿に無い人もいる）
    // 空＝全対応（D9）。選んだものは業務の名前だけを残す
    skills: p.skills === undefined || p.skills === '' || (Array.isArray(p.skills) && !p.skills.length)
      ? '' : normalizeSkills_(p.skills),
  };
}

/**
 * 職員がスタッフを登録する。名簿から貼った何人分でもよい。
 *
 * **1人でも直す必要があれば、誰も登録しない**（何行目の何がおかしいかを返す）。
 * 途中まで登録された状態を作らず、直して丸ごと貼り直せばよい形にするため。
 *
 * @param {Array<Object>|Object} items normalizeStaffEntry_ の入力（email・family_name・given_name・phone・skills）
 * @return {{ok:true, registered:Array<{staff_id,name,email}>}|{ok:false, errors:Array<{line,email,message}>}}
 */
function registerStaff(items) {
  requireStaff_();
  assertConfirmedColumn_();
  const list = Array.isArray(items) ? items : [items];
  if (!list.length) throw new Error('登録する人がいません。');
  if (list.length > STAFF_REGISTER_MAX) throw new Error('1回に登録できるのは ' + STAFF_REGISTER_MAX + ' 人までです。');

  const seen = {};
  const entries = [];
  const errors = [];
  list.forEach(function (raw, i) {
    try {
      const e = normalizeStaffEntry_(raw);
      const key = e.email.toLowerCase();
      if (seen[key]) throw new Error('同じメールアドレスが ' + seen[key] + ' 行目にもあります。');
      seen[key] = i + 1;
      if (findRowCI_(SHEET.CONTACTS, 'email', e.email)) throw new Error('このメールアドレスは、もう名簿にあります。');
      entries.push(e);
    } catch (err) {
      errors.push({ line: i + 1, email: String((raw && raw.email) || '').trim(), message: err.message });
    }
  });
  if (errors.length) return { ok: false, errors: errors };

  const registered = [];
  entries.forEach(function (e) {
    // staffs を先に作り、その staff_id で contacts を作る（承認と同じ順・2つのスプレッドシートをまたぐ）
    const staffId = appendRowWithId_(SHEET.STAFFS, 'staff_id', 'S', {
      name: e.name, role: '学生', skills: e.skills,   // 職員は増えない（上の「登録するのは学生スタッフだけ」）
      available_slots: '', assist_slots: '', personal_code: '',
      slots_updated_at: '',   // 空きコマは本人がマイページで出す（名簿では「未提出」）
    });
    const contact = { staff_id: staffId, name: e.name, email: e.email, phone: e.phone, webhook_url: '' };
    contact[CONFIRMED_COL] = '';   // 本人の確認がまだ
    try {
      appendRow_(SHEET.CONTACTS, contact);
    } catch (err) {
      throw new Error((registered.length ? registered.length + ' 人を登録したところで止まりました。' : '') +
        '名簿（staffs）に ' + staffId + '（' + e.name + '）を作りましたが、連絡先の作成に失敗しました：' + err.message +
        '　連絡先DBに手で行を足すか、staffs の ' + staffId + ' を消してください。');
    }
    registered.push({ staff_id: staffId, name: e.name, email: e.email });
  });
  advanceIdentityGen_();   // 新しい人がログインしたときに、名簿に無い扱いのキャッシュが残らないように
  return { ok: true, registered: registered };
}

/**
 * 職員がスタッフの氏名・電話番号・メールアドレスを直す。
 * メールアドレスを変えたら、本人の確認をやり直す（別の人のアドレスに替わった可能性があるため）。
 * @param {{staff_id, email, family_name, given_name, phone}} p
 */
function updateStaffContact(p) {
  requireStaff_();
  const q = p || {};
  const staffId = String(q.staff_id || '').trim();
  const staff = findRow_(SHEET.STAFFS, 'staff_id', staffId);
  if (!staff) throw new Error('対象のスタッフが見つかりません。');
  const contact = findRow_(SHEET.CONTACTS, 'staff_id', staffId);
  if (!contact) throw new Error('このスタッフの連絡先の行がありません。連絡先DBを確かめてください。');

  const e = normalizeStaffEntry_({ email: q.email, family_name: q.family_name, given_name: q.given_name, phone: q.phone });
  const emailChanged = e.email.toLowerCase() !== String(contact.email || '').trim().toLowerCase();
  if (emailChanged) {
    const other = findRowCI_(SHEET.CONTACTS, 'email', e.email);
    if (other && String(other.staff_id).trim() !== staffId) throw new Error('このメールアドレスは、ほかの人の登録に使われています。');
  }

  updateRow_(SHEET.STAFFS, 'staff_id', staffId, { name: e.name });
  const updates = { name: e.name, phone: e.phone, email: e.email };
  if (emailChanged && hasConfirmedColumn_()) updates[CONFIRMED_COL] = '';   // 確認をやり直す
  updateRow_(SHEET.CONTACTS, 'staff_id', staffId, updates);
  advanceIdentityGen_();   // 氏名・メールが変わったので、本人確認のキャッシュを捨てる（D48）
  return { ok: true, reconfirm: emailChanged };
}

/**
 * 本人の確認（初めて画面を開いたとき）。
 *   isMe=true  … 確認済みにする。このあとマイページで空きコマを出してもらう
 *   isMe=false … 確認済みにせず、職員スペースへ「登録のメールアドレスを確かめて」と知らせる
 */
function confirmMyIdentity(isMe) {
  const user = getCurrentUser_();
  if (!user) throw new Error('利用登録がありません。');
  if (user.confirmed !== false) return { ok: true, already: true };

  if (isMe === true) {
    const updates = {};
    updates[CONFIRMED_COL] = nowString_();
    updateRow_(SHEET.CONTACTS, 'staff_id', user.staff_id, updates);
    advanceIdentityGen_();
    return { ok: true, confirmed: true };
  }

  var notified = false;
  try {
    const url = getStaffSpaceWebhookOrEmpty_();
    if (url) {
      postToWebhook_(url, '⚠️ *名簿の確認で「違う」が押されました*\n' +
        '登録の名前: ' + user.name + '（' + user.staff_id + '）\n' +
        'ログインしたアカウント: ' + user.email + '\n' +
        'メールアドレスの登録を確かめてください（スタッフ名簿で直せます）。');
      notified = true;
    }
  } catch (e) { /* 知らせられなくても、本人には支援室へ連絡するよう案内する */ }
  return { ok: true, confirmed: false, notified: notified };
}
