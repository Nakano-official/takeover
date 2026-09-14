/**
 * スタッフ名簿 — 登録済みのスタッフを職員が一覧で確認する（職員限定）
 *
 * これまで「誰が登録済みか」「その人は代行候補に出られる状態か」を見るには、
 * スプレッドシートを2つ（staffs と 連絡先DB）開いて staff_id で目視突合するしかなかった。
 * 承認（approvals・D28）は**申請の入口**しか見えず、承認後に何が欠けたままかは分からない。
 *
 * ■ この画面が答える問い
 *   - 学生スタッフは今何人登録されているか
 *   - **その人は代行依頼が届くか**（webhook_url）・**職員から電話できるか**（phone）
 *   - **代行候補に出られるか**（available_slots。空だと構造的に永久に出てこない・backlog 10-5）
 *   - **本人が今学期の空きコマを出し直したか**（slots_updated_at。空＝職員が入れたまま・D28）
 *   - 今学期に何コマ持っているか
 *
 * ■ 読み取り専用
 *   ここでは何も書き換えない。名簿を作るのは承認（approveRegistration）だけ、
 *   本人の連絡先と空きコマを直すのはマイページ（Profile.gs）だけ、という D28 の経路を崩さない。
 *   職員が管理する項目（skills）はシートで直す。
 *
 * ■ 個人コード（personal_code）は出さない
 *   機能B（勤怠整合性チェック）を実装しない方針になったため（2026-09-13）、この列を読む相手が
 *   いなくなった。入力画面も無いまま「未入力」と警告し続けると、直しようのない赤が並ぶだけになる。
 *
 * ■ 個人情報
 *   連絡先（メール・電話）を含むので **職員限定**。requireStaff_() を先頭で必ず通す。
 */

/**
 * 名簿の一覧を返す（職員限定）。
 *
 * @return {{rows:Array<Object>, orphanContacts:Array<Object>, summary:Object,
 *           termScope:Array<string>, pendingRegistrations:number, generatedAt:string}}
 */
function getStaffRoster() {
  requireStaff_();

  const staffs = readRows(SHEET.STAFFS);
  const contacts = readRows(SHEET.CONTACTS);
  const courses = readRows(SHEET.COURSES);

  // staff_id → 連絡先。連絡先DBに行が無い人は**ログインできない**ので、
  // 名簿にいても使えていない（承認の途中で片側だけ作られた等）。それが分かるように保持する。
  const contactBy = {};
  contacts.forEach(function (c) {
    const id = String(c.staff_id || '').trim();
    if (id) contactBy[id] = c;
  });

  const scopeIds = rosterTermIds_(courses);
  const assigned = rosterAssignedCounts_(courses, scopeIds);

  const rows = staffs.map(function (s) {
    const staffId = String(s.staff_id || '').trim();
    const role = String(s.role || '').trim();
    const isStudent = role !== ROLE_STAFF;
    const contact = contactBy[staffId] || null;

    const slots = splitSlots_(s.available_slots);
    const phone = contact ? String(contact.phone || '').trim() : '';
    const webhook = contact ? String(contact.webhook_url || '').trim() : '';
    const updatedAt = rosterTimestamp_(s.slots_updated_at);

    // 「欠けていること」をコードで返す。文言は画面側に置く（ここはデータだけ返す）。
    const issues = [];
    if (!contact) issues.push('contact');
    if (isStudent) {
      // 空きコマが無い人は、候補抽出のどの経路にも乗らない＝依頼が一生飛ばない。
      if (!slots.length) issues.push('slots');
      // 空きコマはあるが本人の更新履歴が無い＝職員が入れたまま。学期をまたぐと古い値のまま残る。
      else if (!updatedAt) issues.push('slotsStale');
      // 連絡先の行ごと無い人に「通知先が無い」「電話が無い」まで並べても、直す手順は
      // 「行を作る」の1つしかない。根本の contact だけを出して重ねない。
      if (contact && !webhook) issues.push('webhook');
      if (contact && !phone) issues.push('phone');
    }

    return {
      staff_id: staffId,
      name: String(s.name || '').trim(),
      role: role,
      isStudent: isStudent,
      skills: String(s.skills || '').trim(),   // 空欄は全対応扱い（D9）
      email: contact ? String(contact.email || '').trim() : '',
      phone: phone,
      // Webhook URL そのものは出さない。届くかどうかが分かれば足りるうえ、
      // URL は**それを知っている人なら誰でも投稿できる**秘密に近い値なので画面に晒さない。
      hasWebhook: !!webhook,
      hasContact: !!contact,
      slots: slots,
      slotCount: slots.length,
      slots_updated_at: updatedAt,
      courseCount: assigned[staffId] || 0,
      issues: issues,
    };
  }).filter(function (r) { return r.staff_id; });

  // 学生を先に、次に氏名順。要対応を先頭へ寄せる並べ替えにはしない
  // （見るたびに行が動くと「さっき見た人」を見失うため。強調は画面側の色で足りる）。
  rows.sort(function (a, b) {
    if (a.isStudent !== b.isStudent) return a.isStudent ? -1 : 1;
    const byName = String(a.name).localeCompare(String(b.name), 'ja');
    if (byName) return byName;
    return String(a.staff_id).localeCompare(String(b.staff_id));
  });

  return {
    rows: rows,
    orphanContacts: rosterOrphanContacts_(staffs, contacts),
    summary: rosterSummary_(rows),
    termScope: scopeIds,
    pendingRegistrations: rosterPendingCount_(),
    generatedAt: nowString_(),
  };
}

// ─── 内部 ──────────────────────────────────────────────────

/**
 * 担当コマ数を数える対象の学期。home と同じ「現在の範囲」（前期なら 1Q/2Q も含む・D16）を使い、
 * 学期が解決できないときだけ activeTermIds_ のフォールバックに落とす（画面が全員0コマにならないように）。
 */
function rosterTermIds_(courses) {
  const terms = readTerms_();
  const scope = currentScopeTermIds_(terms);
  if (scope.length) return scope;
  return activeTermIds_(courses.map(function (c) { return String(c.quarter || '').trim(); }));
}

/** staff_id → 今学期の担当コマ数。過ぎた単発コマ（D27）は数えない */
function rosterAssignedCounts_(courses, scopeIds) {
  const inScope = {};
  scopeIds.forEach(function (id) { inScope[id] = true; });
  const today = todayJst_();

  const counts = {};
  courses.forEach(function (c) {
    if (!inScope[String(c.quarter || '').trim()]) return;
    const date = courseDate_(c);          // 単発なら実施日・毎週なら空
    if (date && date < today) return;     // 終わった単発は「今持っているコマ」ではない
    [c.staff_a_id, c.staff_b_id].forEach(function (raw) {
      const id = String(raw || '').trim();
      if (id) counts[id] = (counts[id] || 0) + 1;
    });
  });
  return counts;
}

/**
 * 名簿（staffs）に対応する行が無い連絡先。
 * 承認は staffs → contacts の順に作るので通常は出ないが、途中で失敗すると
 * 逆向き（staffs だけ）が残る。どちらの片側残りも気づけるように両方見る
 * （staffs 側の欠けは各行の hasContact=false で出る）。
 */
function rosterOrphanContacts_(staffs, contacts) {
  const known = {};
  staffs.forEach(function (s) {
    const id = String(s.staff_id || '').trim();
    if (id) known[id] = true;
  });
  return contacts.map(function (c) {
    return {
      staff_id: String(c.staff_id || '').trim(),
      name: String(c.name || '').trim(),
      email: String(c.email || '').trim(),
    };
  }).filter(function (c) {
    if (!c.email && !c.name && !c.staff_id) return false;   // 空行
    return !c.staff_id || !known[c.staff_id];
  });
}

/** 学生スタッフの状態を数え上げる（画面上部のサマリー用） */
function rosterSummary_(rows) {
  const students = rows.filter(function (r) { return r.isStudent; });
  const count = function (code) {
    return students.filter(function (r) { return r.issues.indexOf(code) !== -1; }).length;
  };
  return {
    total: rows.length,
    students: students.length,
    staffMembers: rows.length - students.length,
    needsAction: students.filter(function (r) { return r.issues.length > 0; }).length,
    noContact: count('contact'),
    noSlots: count('slots'),
    slotsStale: count('slotsStale'),
    noWebhook: count('webhook'),
    noPhone: count('phone'),
  };
}

/** 未処理の利用登録申請の件数（承認画面への導線に出す）。registrations が無くても落とさない */
function rosterPendingCount_() {
  try {
    return readRows(SHEET.REGISTRATIONS).filter(function (r) {
      return String(r.status || '').trim() === REGISTRATION_STATUS.PENDING;
    }).length;
  } catch (e) {
    return 0;   // シート未作成（移行前）。名簿の表示自体は続けたい
  }
}

/**
 * 日時セルを文字列へ。google.script.run は Date を含む戻り値を null 化するため、
 * ここで必ず文字列にしてから返す（slots_updated_at はシートの書式次第で Date になる）。
 */
function rosterTimestamp_(value) {
  if (value instanceof Date) {
    return Utilities.formatDate(value, 'Asia/Tokyo', 'yyyy-MM-dd HH:mm:ss');
  }
  return String(value == null ? '' : value).trim();
}
