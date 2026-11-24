/**
 * スタッフの登録と、本人の確認（D64・D65）
 *
 * 以前は学生が自分で利用登録を申請し（氏名・電話・通知先・空きコマ）、職員が承認していた（D28）。
 * 2026-11-21 に改めた：氏名と学籍番号は**支援室の名簿にすでにある**ので、**職員が名簿から登録する**。
 * 学生の入力の手間と、書き方の揺れ（名前）を無くすため。
 *
 * ■ メールアドレスは持たない（D65・2026-11-24）
 *   支援室の名簿（Excel）は「学部・学籍・氏名・備考」で、メールアドレスは無い。大学のメールは全員
 *   「学籍番号＠mail.ryukoku.ac.jp」なので、contacts には学籍番号（account）だけを持ち、メールはスクリプトで作る。
 *
 * ■ 学籍番号の打ち間違いへの備え
 *   職員が入れる学籍番号を1文字間違えると、別の実在の学生に業務の連絡が届きうる。そこで：
 *   - 登録した人は**本人の確認がまだ**（contacts.confirmed_at が空）の状態から始まる
 *   - 初めて画面を開いたとき「あなたは〇〇 〇〇さんですか？」と出し（confirm.html）、「はい」で確認済みにする。
 *     「いいえ」なら職員スペースへ知らせる（学籍番号の登録を直してもらう）
 *   - **確認がまだの人には通知を送らない**（buildWebhookMap_）。学生が使う画面の関数も止める（getOpenUser_）
 *
 * ■ すでにいる人は確認済み
 *   confirmed_at の列が無い（移行前）か、値が入っていれば確認済み。移行（migrateAddContactConfirmedAt）は
 *   列を足し、今いる全員に移行の日時を入れる。**空になるのは、ここで職員が新しく登録した人だけ**。
 *
 * ■ 名簿をまるごと貼ってよい
 *   支援室の名簿には、登録済みの学生とまだの学生が混ざっている。**登録済みの人は飛ばし、新しい人だけを足す**
 *   （学籍番号で見分ける）。登録済みなのに氏名が名簿と違う人は、書き換えずに知らせる（どちらが正しいかは職員が決める）。
 *   形のおかしい行が1つでもあれば、誰も登録しない（途中まで登録された状態を作らない）。
 *
 * ■ 登録するのは学生スタッフだけ
 *   職員のアカウントは支援室の共用アカウント1つだけで、増えない（構築のときに手で入れる・setup.md 1.4）。
 *   画面から区分を選べる入口を残すと、学生を誤って職員にしたときに連絡先DB全体が見える画面に入れてしまうので、
 *   区分は受け取らず、いつも「学生」で作る。
 *
 * ■ 職員が直せるもの
 *   氏名・電話番号・学籍番号（updateStaffContact）。学籍番号を変えたら確認をやり直す。
 *   **職員の行の学籍番号（ログインの識別子）は変えられない**。変えると、職員の権限が別のアカウントへ移るため
 *   （PR #66 のレビュー）。空きコマ・通知先は今まで通り本人がマイページで直す。
 *
 * 公開関数（google.script.run から呼ぶ）:
 *  - registerStaff(items)       … 職員だけ。1人でも、名簿から貼った何人分でも
 *  - updateStaffContact(p)      … 職員だけ
 *  - confirmMyIdentity(isMe)    … 本人（確認がまだの人）
 */

const STAFF_REGISTER_MAX = 300;   // 1回に読める人数（名簿をまるごと貼るため。貼り間違いで大量に作らないよう上限は置く）
// CONFIRMED_COL（Constants.gs）と isUnconfirmedContact_（Util.gs）は、本人確認・通知・名簿からも使うので共通の場所にある

function hasConfirmedColumn_() {
  return getHeaders_(SHEET.CONTACTS).map(function (x) { return String(x).trim(); }).indexOf(CONFIRMED_COL) !== -1;
}

function assertConfirmedColumn_() {
  if (!hasConfirmedColumn_()) {
    throw new Error('連絡先DBに confirmed_at 列がありません。GAS エディタから migrateAddContactConfirmedAt() を1回実行してください。');
  }
}

/**
 * 1人分の入力をそろえる（登録・修正で共通）。
 * @param {{account, family_name, given_name, phone, skills}} raw   区分（role）は受け取らない（いつも学生）
 * @param {{keepAccount:string}} [opts] keepAccount … 職員の行など、学籍番号の形でない今の識別子を変えずに通す
 */
function normalizeStaffEntry_(raw, opts) {
  const p = raw || {};
  const keep = opts && opts.keepAccount;
  const family = validatePersonName_('姓', p.family_name);
  const given = validatePersonName_('名', p.given_name);
  if (/[\s　]/.test(family + given)) throw new Error('姓と名の中に空白は入れないでください。');
  const account = keep && String(p.account == null ? '' : p.account).trim().toUpperCase() === keep
    ? keep : normalizeAccount_(p.account, { studentOnly: true });
  return {
    account: account,
    name: validatePersonName_('氏名', family + ' ' + given),   // 「姓 名」（半角スペース1つ・D54）
    phone: validatePhone_(p.phone),                              // 空なら空（名簿に無い人もいる）
    // 空＝全対応（D9）。選んだものは業務の名前だけを残す
    skills: p.skills === undefined || p.skills === '' || (Array.isArray(p.skills) && !p.skills.length)
      ? '' : normalizeSkills_(p.skills),
  };
}

/**
 * 職員がスタッフを登録する。名簿をまるごと貼った何人分でもよい。
 *
 * - **登録済みの人（同じ学籍番号）は飛ばす**（skipped）。氏名が名簿と違えば nameDiffers を付けて知らせる（書き換えない）
 * - 同じ貼り付けの中で同じ学籍番号が2回あれば、2回目は飛ばす。氏名が違えばどちらが正しいか分からないので直してもらう
 * - **形のおかしい行が1つでもあれば、誰も登録しない**（何行目の何がおかしいかを返す）
 *
 * @param {Array<Object>|Object} items normalizeStaffEntry_ の入力（account・family_name・given_name・phone・skills）
 * @return {{ok:true, registered:Array<{line,staff_id,name,account}>, skipped:Array<{line,account,name,current,nameDiffers,reason}>}
 *        |{ok:false, errors:Array<{line,account,message}>}}  line は items の何番目か（1から）
 */
function registerStaff(items) {
  requireStaff_();
  assertConfirmedColumn_();
  assertAccountColumn_();
  const list = Array.isArray(items) ? items : [items];
  if (!list.length) throw new Error('登録する人がいません。');
  if (list.length > STAFF_REGISTER_MAX) throw new Error('1回に読めるのは ' + STAFF_REGISTER_MAX + ' 人までです。名簿を分けて貼ってください。');

  // 1. 形の確認（シートを読まない）。1行でもおかしければ誰も登録しない
  const normalized = [];
  const errors = [];
  list.forEach(function (raw, i) {
    try {
      normalized.push(normalizeStaffEntry_(raw));
    } catch (err) {
      normalized.push(null);
      errors.push({ line: i + 1, account: String((raw && raw.account) || '').trim(), message: err.message });
    }
  });
  if (errors.length) return { ok: false, errors: errors };

  // 2. 登録済みかの確認と書き込みを、同じロックの中で行う（PR #59 のレビュー）。
  //    別のタブで同じ人を同時に登録しても、同じ学籍番号の行が2つできないように
  return withLock_(function () { return registerScreened_(normalized); });
}

/** registerStaff の後半（withLock_ の中で呼ぶ）。登録済みの人を飛ばし、新しい人だけを書く */
function registerScreened_(normalized) {
  // 今の名簿（学籍番号 → 行）。ロックを取ってから読む
  const existing = {};
  readRows_(SHEET.CONTACTS).forEach(function (c) {
    const acc = String(c[ACCOUNT_COL] || '').trim().toUpperCase();
    if (acc) existing[acc] = c;
  });

  const seen = {};      // この貼り付けの中で見た学籍番号 → { line, name }
  const entries = [];
  const skipped = [];
  const errors = [];
  normalized.forEach(function (e, i) {
    const line = i + 1;
    try {
      const now = existing[e.account];
      if (now) {
        const current = String(now.name || '').trim();
        skipped.push({ line: line, account: e.account, name: e.name, current: current,
          nameDiffers: nameKey_(current) !== nameKey_(e.name), reason: 'registered' });
        return;
      }
      const dup = seen[e.account];
      if (dup) {
        if (nameKey_(dup.name) !== nameKey_(e.name)) {
          throw new Error('同じ学籍番号が ' + dup.line + ' 番目にもあり、氏名が違います（' + dup.name + '）。');
        }
        skipped.push({ line: line, account: e.account, name: e.name, current: '', nameDiffers: false, reason: 'duplicate' });
        return;
      }
      seen[e.account] = { line: line, name: e.name };
      e.line = line;
      entries.push(e);
    } catch (err) {
      errors.push({ line: line, account: e.account, message: err.message });
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
    const contact = { staff_id: staffId, name: e.name, phone: e.phone, webhook_url: '' };
    contact[ACCOUNT_COL] = e.account;
    contact[CONFIRMED_COL] = '';   // 本人の確認がまだ
    try {
      appendRow_(SHEET.CONTACTS, contact);
    } catch (err) {
      throw new Error((registered.length ? registered.length + ' 人を登録したところで止まりました。' : '') +
        '名簿（staffs）に ' + staffId + '（' + e.name + '）を作りましたが、連絡先の作成に失敗しました：' + err.message +
        '　連絡先DBに手で行を足すか、staffs の ' + staffId + ' を消してください。');
    }
    registered.push({ line: e.line, staff_id: staffId, name: e.name, account: e.account });
  });
  if (registered.length) advanceIdentityGen_();   // 新しい人がログインしたときに、名簿に無い扱いのキャッシュが残らないように
  return { ok: true, registered: registered, skipped: skipped };
}

/**
 * 職員がスタッフの氏名・電話番号・学籍番号を直す。
 * 学籍番号を変えたら、本人の確認をやり直す（別の人の番号に替わった可能性があるため）。
 * **学生スタッフでない行（職員など）の学籍番号は変えられない**。ログインの識別子なので、変えると権限が別のアカウントへ移る。
 * @param {{staff_id, account, account_before, family_name, given_name, phone}} p
 *   account_before … 画面を開いたときの学籍番号。今の値と違えば止める（ほかの画面の訂正を書き戻さない）
 */
function updateStaffContact(p) {
  requireStaff_();
  assertAccountColumn_();
  const q = p || {};
  const staffId = String(q.staff_id || '').trim();
  const staff = findRow_(SHEET.STAFFS, 'staff_id', staffId);
  if (!staff) throw new Error('対象のスタッフが見つかりません。');
  const isStudent = String(staff.role || '').trim() === '学生';
  // 画面を開いたときの学籍番号（画面が送ってくる）。今の値と違えば、ほかの画面で直されたので止める
  const before = q.account_before === undefined ? null : String(q.account_before || '').trim().toUpperCase();

  // 今の学籍番号の読み取り・変わったかどうかの判定・重複の確認・書き込みを、全部同じロックの中で行う（PR #59 のレビュー）。
  // ロックの外で判定すると、氏名だけの修正と学籍番号の訂正が重なったときに、古い番号を書き戻したり、
  // 確認のやり直しや DM の宛先の消去を飛ばしたりしうる
  const done = withLock_(function () {
    const contact = findRow_(SHEET.CONTACTS, 'staff_id', staffId);
    if (!contact) throw new Error('このスタッフの連絡先の行がありません。連絡先DBを確かめてください。');
    const current = String(contact[ACCOUNT_COL] || '').trim().toUpperCase();
    if (before !== null && before !== current) {
      throw new Error('この人の学籍番号は、ほかの画面で ' + current + ' に直されています。画面を読み直してから、もう一度直してください。');
    }
    const e = normalizeStaffEntry_({ account: q.account, family_name: q.family_name, given_name: q.given_name, phone: q.phone },
      { keepAccount: current });
    const accountChanged = e.account !== current;
    const updates = { name: e.name, phone: e.phone };
    if (accountChanged) {
      if (!isStudent) {
        throw new Error('学生スタッフでない人（' + String(staff.role || '').trim() + '）の学籍番号は、名簿の画面から変えられません。');
      }
      const other = findRowCI_(SHEET.CONTACTS, ACCOUNT_COL, e.account);
      if (other && String(other.staff_id).trim() !== staffId) throw new Error('この学籍番号は、ほかの人の登録に使われています。');
      // 学籍番号は、変えるときだけ書く（変えないときは書かない＝ほかの画面の訂正を書き戻さない）
      updates[ACCOUNT_COL] = e.account;
      if (hasConfirmedColumn_()) updates[CONFIRMED_COL] = '';   // 確認をやり直す
      // 覚えていた通知先は、前の学籍番号の人のもの。そのままだと直したあとも前の人に届くので消す（PR #59 のレビュー）。
      // DM の宛先に加えて、Webhook の通知先も消す（DM で困ったときに Webhook へ切り替えても、前の人に届かないように）
      const heads = getHeaders_(SHEET.CONTACTS).map(function (x) { return String(x).trim(); });
      DM_COLS.concat(['webhook_url']).forEach(function (c) { if (heads.indexOf(c) !== -1) updates[c] = ''; });
    }
    updateRow_(SHEET.CONTACTS, 'staff_id', staffId, updates);
    return { name: e.name, accountChanged: accountChanged };
  });
  updateRow_(SHEET.STAFFS, 'staff_id', staffId, { name: done.name });
  advanceIdentityGen_();   // 氏名・学籍番号が変わったので、本人確認のキャッシュを捨てる（D48）
  return { ok: true, reconfirm: done.accountChanged };
}

/**
 * 本人の確認（初めて画面を開いたとき）。
 *   isMe=true  … 確認済みにする。このあとマイページで空きコマを出してもらう
 *   isMe=false … 確認済みにせず、職員スペースへ「登録の学籍番号を確かめて」と知らせる
 */
function confirmMyIdentity(isMe) {
  const user = getCurrentUser_();
  if (!user) throw new Error('利用登録がありません。');
  if (user.confirmed !== false) return { ok: true, already: true };

  if (isMe === true) {
    // 行を読み直し、今の学籍番号がログインしているアカウントと同じときだけ確認済みにする（PR #59 のレビュー）。
    // 職員が学籍番号を直したのと同時に、前のアカウントから「はい」を押すと、直したときに空にした確認が
    // また埋まり、新しいアカウントでの確認が飛んでしまうため。名簿の修正と同じロックの中で行う
    const me = accountOfEmail_(user.email);
    withLock_(function () {
      const contact = findRow_(SHEET.CONTACTS, 'staff_id', user.staff_id);
      if (!contact || !me || contactAccount_(contact) !== me) {
        throw new Error('登録の学籍番号が変わりました。画面を開き直してください。');
      }
      const updates = {};
      updates[CONFIRMED_COL] = nowString_();
      updateRow_(SHEET.CONTACTS, 'staff_id', user.staff_id, updates);
    });
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
        '学籍番号の登録を確かめてください（スタッフ名簿で直せます）。');
      notified = true;
    }
  } catch (e) { /* 知らせられなくても、本人には支援室へ連絡するよう案内する */ }
  return { ok: true, confirmed: false, notified: notified };
}
