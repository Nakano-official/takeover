/**
 * 利用登録の申請と承認（D28）
 *
 * 名簿（contacts）に無いアカウントは、これまで「利用登録がありません」で**行き止まり**だった。
 * そこから先は職員が staffs / contacts へ手で行を作るしかなく、学期開始に負担が集中する。
 * ここでは本人に申請を出させ、**職員が承認して初めて名簿に入る**形にする。
 *
 * ■ 流れ
 *   未登録アカウントで開く → 申請画面（signup）→ registrations に「申請中」で溜まる
 *   → 職員が承認画面（approvals）で内容を見て承認 → staffs と contacts に行ができる
 *   → 以後は通常の画面が使える
 *
 * ■ 押さえている点
 *   - **メールは必ず Session から取る**。画面から送られてきた値は使わない。
 *   - **承認まで staffs / contacts には一切書かない**。申請は registrations に溜まるだけ。
 *   - **role は申請者に選ばせない**。承認時に職員が決める（既定は学生）。
 *     ここを入力項目にすると自己申告で職員権限が取れ、連絡先DB全体が見える画面に入れてしまう。
 *   - 申請は1メール1件（再申請は同じ行を上書き）。却下された人も出し直せる。
 *
 * ■ アクセス範囲の注意（D28）
 *   現在 appsscript.json は access: DOMAIN で、大学アカウントに限られる。承認を挟むので妥当。
 *   ただし **M5Stack 端末のためにアクセスを「全員」にすると、この申請口が全世界に開く**。
 *   端末を有効にするときは申請画面だけ別の防御（招待コード等）を入れること。
 */

const REGISTRATION_STATUS = {
  PENDING: '申請中',
  APPROVED: '承認済',
  REJECTED: '却下',
};

// ─── 申請側（未登録者が使う）────────────────────────────────

/**
 * 申請画面に出す情報を返す。**contacts に無いアカウントでも呼べる**必要があるため、
 * getCurrentUser_() ではなく Session から直接メールを取る。
 */
function getSignupContext() {
  const email = String(Session.getActiveUser().getEmail() || '').trim();
  if (!email) {
    throw new Error('ログイン情報を取得できませんでした。大学のアカウントでログインしてください。');
  }

  // 既に名簿にいるなら申請は不要（画面側で通常画面へ促す）
  const contact = findRowCI_(SHEET.CONTACTS, 'email', email);
  const existing = findRegistrationByEmail_(email);

  const periods = readRows(SHEET.PERIODS).map(function (p) {
    return {
      period: String(p.period).trim(),
      time: p.start_time ? p.start_time + '〜' + p.end_time : '',
    };
  }).filter(function (p) { return p.period; });

  return {
    email: email,
    alreadyRegistered: !!contact,
    status: existing ? String(existing.status || '').trim() : '',
    appliedAt: existing ? String(existing.applied_at || '').trim() : '',
    rejectReason: existing ? String(existing.reject_reason || '').trim() : '',
    // 申請中・却下のときは前回の入力を出して直せるようにする
    name: existing ? String(existing.name || '').trim() : '',
    phone: existing ? String(existing.phone || '').trim() : '',
    webhook_url: existing ? String(existing.webhook_url || '').trim() : '',
    skills: existing ? String(existing.skills || '').trim() : '',
    slots: existing ? splitSlots_(existing.slots) : [],
    note: existing ? String(existing.note || '').trim() : '',
    days: WORK_DAYS.slice(),
    periods: periods,
  };
}

/**
 * 利用登録を申請する（未登録者が実行）。registrations に「申請中」で積むだけで、
 * staffs / contacts には**一切書かない**。
 *
 * @param {{name, phone, webhook_url, skills, slots, note}} payload
 */
function submitRegistration(payload) {
  const email = String(Session.getActiveUser().getEmail() || '').trim();
  if (!email) throw new Error('ログイン情報を取得できませんでした。');

  if (findRowCI_(SHEET.CONTACTS, 'email', email)) {
    throw new Error('このアカウントは既に登録済みです。画面を再読み込みしてください。');
  }

  const p = payload || {};
  const name = String(p.name || '').trim();
  const phone = String(p.phone || '').trim();
  const webhook = String(p.webhook_url || '').trim();
  const note = String(p.note || '').trim();

  if (!name) throw new Error('氏名を入力してください。');
  // 氏名は承認後に機能Bでカレンダーの氏名と突合する（D7③）。姓名の間の扱いは運用で揃える。
  if (webhook && !isChatWebhook_(webhook)) {
    throw new Error('Chat の Webhook URL の形式が違います（https://chat.googleapis.com/ で始まる必要があります）。');
  }

  // 空きコマは Profile.gs と同じ検証を通す（実在しないスロットを入れない）
  const slots = normalizeSlots_(p.slots);
  // skills は本人の申告。承認時に職員が確定させるので、ここでは値の見張りだけする。
  const skills = ['テイク', '介助']
    .filter(function (x) { return String(p.skills || '').indexOf(x) !== -1; })
    .join(',');

  const existing = findRegistrationByEmail_(email);
  const row = {
    email: email, name: name, phone: phone, webhook_url: webhook,
    skills: skills, slots: slots, note: note,
    status: REGISTRATION_STATUS.PENDING,
    applied_at: nowString_(),
    // 出し直しなので、前回の却下の痕跡は消す
    decided_at: '', decided_by: '', staff_id: '', reject_reason: '',
  };

  if (existing) {
    if (String(existing.status).trim() === REGISTRATION_STATUS.APPROVED) {
      throw new Error('この申請は既に承認されています。画面を再読み込みしてください。');
    }
    updateRow(SHEET.REGISTRATIONS, 'registration_id', existing.registration_id, row);
    return { ok: true, registration_id: existing.registration_id, resubmitted: true };
  }
  const id = appendRowWithId(SHEET.REGISTRATIONS, 'registration_id', 'R', row);
  return { ok: true, registration_id: id, resubmitted: false };
}

// ─── 承認側（職員が使う）────────────────────────────────────

/**
 * 申請の一覧を返す（職員限定）。申請中を先に、次に新しい順で並べる。
 */
function getRegistrations() {
  requireStaff_();
  const rows = readRows(SHEET.REGISTRATIONS).map(function (r) {
    return {
      registration_id: String(r.registration_id || '').trim(),
      email: String(r.email || '').trim(),
      name: String(r.name || '').trim(),
      phone: String(r.phone || '').trim(),
      webhook_url: String(r.webhook_url || '').trim(),
      skills: String(r.skills || '').trim(),
      slots: String(r.slots || '').trim(),
      note: String(r.note || '').trim(),
      status: String(r.status || '').trim(),
      applied_at: String(r.applied_at || '').trim(),
      decided_at: String(r.decided_at || '').trim(),
      staff_id: String(r.staff_id || '').trim(),
      reject_reason: String(r.reject_reason || '').trim(),
    };
  }).filter(function (r) { return r.registration_id; });

  const rank = function (s) { return s === REGISTRATION_STATUS.PENDING ? 0 : 1; };
  rows.sort(function (a, b) {
    return (rank(a.status) - rank(b.status)) ||
      (a.applied_at < b.applied_at ? 1 : a.applied_at > b.applied_at ? -1 : 0);
  });
  return rows;
}

/**
 * 申請を承認して名簿に入れる（職員限定）。
 *
 * **ここが staffs / contacts に行を作る唯一の経路**。`role` と `skills` は職員が決める
 * （申請者の申告はあくまで参考値として画面に出す）。
 *
 * @param {string} registrationId
 * @param {{role:string, skills:string}} [opts] 省略時は role=学生・skills=申請どおり
 */
function approveRegistration(registrationId, opts) {
  const me = requireStaff_();
  const reg = findRow(SHEET.REGISTRATIONS, 'registration_id', registrationId);
  if (!reg) throw new Error('対象の申請が見つかりません。');
  if (String(reg.status).trim() !== REGISTRATION_STATUS.PENDING) {
    throw new Error('この申請は既に「' + String(reg.status).trim() + '」です。画面を更新してください。');
  }

  const email = String(reg.email || '').trim();
  if (findRowCI_(SHEET.CONTACTS, 'email', email)) {
    throw new Error('このメールは既に名簿にあります（二重登録の防止）。申請を却下してください。');
  }

  const o = opts || {};
  const role = String(o.role || '').trim() === ROLE_STAFF ? ROLE_STAFF : '学生';
  const skills = ['テイク', '介助']
    .filter(function (x) { return String(o.skills === undefined ? reg.skills : o.skills).indexOf(x) !== -1; })
    .join(',');

  // staffs に採番して作り、その staff_id で contacts を作る。
  // 2つのスプレッドシートをまたぐので原子的にはできない。staffs を先に作るのは、
  // staff_id の採番元がそちらだから。contacts 側で失敗したら staff_id を名指しで返し、
  // 職員が手で直せるようにする（黙って片側だけ残さない）。
  const staffId = appendRowWithId(SHEET.STAFFS, 'staff_id', 'S', {
    name: String(reg.name || '').trim(),
    role: role,
    skills: skills,
    available_slots: String(reg.slots || '').trim(),
    personal_code: '',              // 勤怠CSVの突合キー。職員が後から入れる（D2/D14）
    slots_updated_at: nowString_(), // 本人の申告なので「本人が出した」扱いにする（D28）
  });

  try {
    appendRow(SHEET.CONTACTS, {
      staff_id: staffId,
      name: String(reg.name || '').trim(),
      email: email,
      phone: String(reg.phone || '').trim(),
      webhook_url: String(reg.webhook_url || '').trim(),
    });
  } catch (e) {
    throw new Error('名簿（staffs）に ' + staffId + ' を作りましたが、連絡先の作成に失敗しました：'
      + e.message + '　連絡先DBに手で行を足すか、staffs の ' + staffId + ' を消してやり直してください。');
  }

  updateRow(SHEET.REGISTRATIONS, 'registration_id', registrationId, {
    status: REGISTRATION_STATUS.APPROVED,
    decided_at: nowString_(),
    decided_by: me.staff_id,
    staff_id: staffId,
    reject_reason: '',
  });

  // 承認をChatで知らせる。挨拶が目的ではなく、**申請された Webhook URL が本当に届くかを
  // この場で確かめる**ため。ここで届かないと、後日いきなり代行依頼が消える形で気づくことになる。
  var notify = null;
  const webhook = String(reg.webhook_url || '').trim();
  if (webhook) {
    try {
      postToWebhook_(webhook,
        String(reg.name || '').trim() + ' さん\n' +
        '支援室シフト管理システムの利用登録が承認されました。\n' +
        'このメッセージが届いていれば、代行依頼の通知も同じ場所に届きます。\n' +
        'マイページから空きコマや連絡先をいつでも更新できます。');
      notify = { sent: true, reason: '' };
    } catch (e) {
      notify = { sent: false, reason: e.message };
    }
  } else {
    notify = { sent: false, reason: 'Webhook未登録（代行依頼の通知が届きません）' };
  }

  return { ok: true, staff_id: staffId, role: role, skills: skills, notify: notify };
}

/**
 * 申請を却下する（職員限定）。名簿には何も作らない。本人は申請画面で理由を見て出し直せる。
 */
function rejectRegistration(registrationId, reason) {
  const me = requireStaff_();
  const reg = findRow(SHEET.REGISTRATIONS, 'registration_id', registrationId);
  if (!reg) throw new Error('対象の申請が見つかりません。');
  if (String(reg.status).trim() !== REGISTRATION_STATUS.PENDING) {
    throw new Error('この申請は既に「' + String(reg.status).trim() + '」です。画面を更新してください。');
  }
  updateRow(SHEET.REGISTRATIONS, 'registration_id', registrationId, {
    status: REGISTRATION_STATUS.REJECTED,
    decided_at: nowString_(),
    decided_by: me.staff_id,
    reject_reason: String(reason || '').trim(),
  });
  return { ok: true };
}

// ─── 内部 ──────────────────────────────────────────────────

/** メール（大文字小文字を無視）で申請を1件引く */
function findRegistrationByEmail_(email) {
  const target = String(email).trim().toLowerCase();
  const rows = readRows(SHEET.REGISTRATIONS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].email).trim().toLowerCase() === target) return rows[i];
  }
  return null;
}
