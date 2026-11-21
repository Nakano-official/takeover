/**
 * 利用登録の申請と承認（D28）
 *
 * ⚠️ 2026-11-21 から、学生の申請は受け付けていない（D64）。職員が名簿から登録する（StaffAdmin.gs）。
 *    ここに残っているのは、すでに出ていた申請を承認・却下するための部分だけ。
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

// ─── 申請側（2026-11-21 にやめた・D64）────────────────────────
//
// 以前はここに getSignupContext / submitRegistration（未登録者が自分で申請する）があった。
// 職員が支援室の名簿から登録する形（StaffAdmin.gs の registerStaff）に替えたので消した。
// 使わない入口を残すと、画面が無くても google.script.run から申請を作れてしまうため。
// すでに出ていた申請（申請中）は、下の承認・却下で今まで通り片付けられる。

// ─── 承認側（職員が使う）────────────────────────────────────

/**
 * 申請の一覧を返す（職員限定）。申請中を先に、次に新しい順で並べる。
 */
function getRegistrations() {
  requireStaff_();
  const rows = readRows_(SHEET.REGISTRATIONS).map(function (r) {
    return {
      registration_id: String(r.registration_id || '').trim(),
      email: String(r.email || '').trim(),
      name: String(r.name || '').trim(),
      phone: String(r.phone || '').trim(),
      webhook_url: String(r.webhook_url || '').trim(),
      skills: String(r.skills || '').trim(),
      slots: String(r.slots || '').trim(),
      assist_slots: String(r.assist_slots || '').trim(),
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
  const reg = findRow_(SHEET.REGISTRATIONS, 'registration_id', registrationId);
  if (!reg) throw new Error('対象の申請が見つかりません。');
  if (String(reg.status).trim() !== REGISTRATION_STATUS.PENDING) {
    throw new Error('この申請は既に「' + String(reg.status).trim() + '」です。画面を更新してください。');
  }

  const email = String(reg.email || '').trim();
  if (findRowCI_(SHEET.CONTACTS, 'email', email)) {
    throw new Error('このメールは既に名簿にあります（二重登録の防止）。申請を却下してください。');
  }

  // 申請の時点の確認と同じものを、名簿へ写す前にもう一度通す（申請はシートを直接直されることもある）
  const name = validatePersonName_('申請の氏名', reg.name);
  const phone = validatePhone_(reg.phone);

  const o = opts || {};
  const role = String(o.role || '').trim() === ROLE_STAFF ? ROLE_STAFF : '学生';
  const skills = splitSkills_(o.skills === undefined ? reg.skills : o.skills).join(',');

  // staffs に採番して作り、その staff_id で contacts を作る。
  // 2つのスプレッドシートをまたぐので原子的にはできない。staffs を先に作るのは、
  // staff_id の採番元がそちらだから。contacts 側で失敗したら staff_id を名指しで返し、
  // 職員が手で直せるようにする（黙って片側だけ残さない）。
  const staffId = appendRowWithId_(SHEET.STAFFS, 'staff_id', 'S', {
    name: name,
    role: role,
    skills: skills,
    available_slots: String(reg.slots || '').trim(),
    assist_slots: String(reg.assist_slots || '').trim(),   // 業務ごとに申請してもらう（D54）
    personal_code: '',              // 列は残っているが使わない（機能Bを実装しないため・2026-09-13）
    slots_updated_at: nowString_(), // 本人の申告なので「本人が出した」扱いにする（D28）
  });

  try {
    appendRow_(SHEET.CONTACTS, {
      staff_id: staffId,
      name: name,
      email: email,
      phone: phone,
      webhook_url: String(reg.webhook_url || '').trim(),
      // 申請は本人が自分のアカウントでログインして出したものなので、メールアドレスは本人のもの。確認済みにする（D64）
      confirmed_at: nowString_(),
    });
  } catch (e) {
    throw new Error('名簿（staffs）に ' + staffId + ' を作りましたが、連絡先の作成に失敗しました：'
      + e.message + '　連絡先DBに手で行を足すか、staffs の ' + staffId + ' を消してやり直してください。');
  }

  updateRow_(SHEET.REGISTRATIONS, 'registration_id', registrationId, {
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
        // URL を探さずに済むよう、ここから開けるようにする（D54）
        'こちらから開けます：\n' + getPublicAppUrl_() + '\n' +   // `/dev` の URL を送らない（公開用の URL）
        'このメッセージが届いていれば、代行依頼の通知も同じ場所に届きます。\n' +
        'マイページから空きコマや連絡先をいつでも更新できます。' +
        // 準備中は開いてもマイページしか使えないので、先に伝えておく（D56）
        (role !== ROLE_STAFF && isClosedForStudents_()
          ? '\n\nいまは準備中のため、使えるのはマイページだけです。準備が整ったら、シフトの確認や欠勤の連絡もできるようになります。'
          : ''));
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
  const reg = findRow_(SHEET.REGISTRATIONS, 'registration_id', registrationId);
  if (!reg) throw new Error('対象の申請が見つかりません。');
  if (String(reg.status).trim() !== REGISTRATION_STATUS.PENDING) {
    throw new Error('この申請は既に「' + String(reg.status).trim() + '」です。画面を更新してください。');
  }
  updateRow_(SHEET.REGISTRATIONS, 'registration_id', registrationId, {
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
  const rows = readRows_(SHEET.REGISTRATIONS);
  for (var i = 0; i < rows.length; i++) {
    if (String(rows[i].email).trim().toLowerCase() === target) return rows[i];
  }
  return null;
}
