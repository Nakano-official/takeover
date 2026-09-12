/**
 * マイページ — 本人が自分の情報を確認・更新する（D28）
 *
 * 職員へお願いしないと直せなかった項目のうち、**本人が持ってよいもの**だけを開放する。
 * 特に効くのは `available_slots`（空きコマ）で、学期ごとの再収集がセルフサービスになる。
 *
 * ■ 本人が変更できるもの / できないもの（D28 の線引き。ここが本ファイルの肝）
 *
 *   ✅ contacts.phone         … 自分の連絡先。他に影響しない
 *   ✅ contacts.webhook_url   … 自分の Chat スペース。形式は isChatWebhook_ で検証する
 *   ✅ staffs.available_slots … 本命。学期ごとの空きコマ更新
 *
 *   ❌ staffs.name           … 機能Bがカレンダーの氏名で突合する（D7③）。変えると照合が黙って壊れる
 *   ❌ staffs.skills         … 誰にどの依頼が飛ぶかを決める。自己申告だと未研修者にテイクが回る
 *   ❌ staffs.personal_code  … 勤怠CSVの突合キー（D2/D14）。壊れても気づけない
 *   ❌ staffs.role           … 自分を職員にできてしまう＝連絡先DB全体が見える画面に入れる
 *   ❌ contacts.email / staff_id … 本人を特定するキーそのもの
 *
 * ■ なりすまし防止
 *   更新対象の staff_id は**必ず `getCurrentUser_()`（Session）から取る**。
 *   画面から送られてきた id は一切見ない。受け付けるフィールドも上の3つに限定し、
 *   payload に role や name が混じっていても無視する（ホワイトリスト方式）。
 */

/**
 * マイページの表示データを返す。**自分の行だけ**を返す（他人の連絡先は一切含めない）。
 * @return {Object} 表示・編集に必要な値一式
 */
function getMyProfile() {
  const user = getCurrentUser_();
  if (!user) throw new Error('利用登録がありません。');

  const staff = findRow(SHEET.STAFFS, 'staff_id', user.staff_id);
  const contact = findRow(SHEET.CONTACTS, 'staff_id', user.staff_id);
  const isStudent = String(user.role).trim() !== ROLE_STAFF;

  // 空きコマの選択肢（曜日 × 時限）。曜日は WORK_DAYS（Constants.gs）、時限は時限マスタが唯一の出所。
  const periods = readRows(SHEET.PERIODS).map(function (p) {
    return {
      period: String(p.period).trim(),
      time: p.start_time ? p.start_time + '〜' + p.end_time : '',
    };
  }).filter(function (p) { return p.period; });

  return {
    staff_id: user.staff_id,
    email: user.email,
    // ── 職員が管理する項目（画面では読み取り専用で見せる）──
    name: staff ? String(staff.name || '').trim() : user.name,
    role: String(user.role || '').trim(),
    skills: staff ? String(staff.skills || '').trim() : '',
    personal_code: staff ? String(staff.personal_code || '').trim() : '',
    // ── 本人が変更できる項目 ──
    phone: contact ? String(contact.phone || '').trim() : '',
    webhook_url: contact ? String(contact.webhook_url || '').trim() : '',
    slots: staff ? splitSlots_(staff.available_slots) : [],
    // Date のまま返すと google.script.run が null にするので文字列で返す
    slots_updated_at: staff ? String(staff.slots_updated_at || '').trim() : '',
    // ── 画面の組み立て用 ──
    isStudent: isStudent,
    days: WORK_DAYS.slice(),
    periods: periods,
  };
}

/**
 * マイページからの更新。受け付けるのは phone / webhook_url / slots の3つだけ（D28）。
 *
 * @param {{phone:string, webhook_url:string, slots:Array<string>}} payload
 * @return {{ok:boolean, slots:string, slots_updated_at:string, warnings:Array<string>}}
 */
function updateMyProfile(payload) {
  const user = getCurrentUser_();
  if (!user) throw new Error('利用登録がありません。');
  const p = payload || {};
  const isStudent = String(user.role).trim() !== ROLE_STAFF;
  const warnings = [];

  const phone = String(p.phone || '').trim();
  const webhook = String(p.webhook_url || '').trim();

  // Webhook は宛先を間違えると他人のスペースへ通知が飛ぶので、形式が合うときだけ受け付ける。
  // 空は「登録しない」の意思表示として受け付ける（通知が届かなくなる旨は画面で警告する）。
  if (webhook && !isChatWebhook_(webhook)) {
    throw new Error('Chat の Webhook URL の形式が違います（https://chat.googleapis.com/ で始まる必要があります）。');
  }
  if (!webhook) warnings.push('Webhook URL が未登録です。代行依頼の通知が届きません。');
  if (!phone) warnings.push('電話番号が未登録です。返信が無いときに職員が連絡できません。');

  const contactUpdated = updateRow(SHEET.CONTACTS, 'staff_id', user.staff_id, {
    phone: phone, webhook_url: webhook,
  });
  if (!contactUpdated) throw new Error('連絡先の行が見つかりませんでした。職員にお問い合わせください。');

  // 空きコマは学生のみ。職員には available_slots の意味が無いので触らない。
  var slotsCsv = '';
  var updatedAt = '';
  if (isStudent) {
    slotsCsv = normalizeSlots_(p.slots);
    updatedAt = nowString_();
    // 保存のたびに日時を更新する。値が変わらなくても「今学期これで出し直した」という
    // 本人の確認なので、職員が「まだ出していない人」を見分けられるようにする（D28）。
    const staffUpdated = updateRow(SHEET.STAFFS, 'staff_id', user.staff_id, {
      available_slots: slotsCsv, slots_updated_at: updatedAt,
    });
    if (!staffUpdated) throw new Error('名簿の行が見つかりませんでした。職員にお問い合わせください。');
    if (!slotsCsv) warnings.push('空きコマが1つも選ばれていません。代行の候補に出ません。');
  }

  return { ok: true, slots: slotsCsv, slots_updated_at: updatedAt, warnings: warnings };
}

/**
 * 空きコマの入力（['月1','火3'] 形式）を検証して '月1,火3' の保存形へ正規化する。
 *
 * 曜日は WORK_DAYS、時限は時限マスタにあるものだけを通す。ここを緩くすると、
 * 実在しないスロット（土9 など）が available_slots に入り、**その人は永久に候補へ出ない**
 * という静かな壊れ方をする（backlog 10-5 と同じ性質）。
 */
function normalizeSlots_(slots) {
  const validDay = {};
  WORK_DAYS.forEach(function (d) { validDay[d] = true; });
  const validPeriod = {};
  readRows(SHEET.PERIODS).forEach(function (p) {
    const key = String(p.period).trim();
    if (key) validPeriod[key] = true;
  });

  const seen = {};
  const out = [];
  (slots || []).forEach(function (raw) {
    const s = String(raw).trim();
    if (!s) return;
    const day = s.slice(0, 1);
    const period = s.slice(1);
    if (!validDay[day]) throw new Error('曜日が不正です：' + s);
    if (!validPeriod[period]) throw new Error('時限が不正です：' + s);
    if (seen[s]) return;
    seen[s] = true;
    out.push({ day: day, period: period, key: s });
  });

  // 表示順（曜日 → 時限）で並べて保存する。人がシートを見たときに読める順にしておく。
  const dayIndex = {};
  WORK_DAYS.forEach(function (d, i) { dayIndex[d] = i; });
  const periodOrder = Object.keys(validPeriod);
  const periodIndex = {};
  periodOrder.forEach(function (p, i) { periodIndex[p] = i; });

  out.sort(function (a, b) {
    return (dayIndex[a.day] - dayIndex[b.day]) || (periodIndex[a.period] - periodIndex[b.period]);
  });
  return out.map(function (x) { return x.key; }).join(',');
}

/** '月1,火3' 形式を配列へ（空要素は捨てる） */
function splitSlots_(csv) {
  return String(csv || '').split(',')
    .map(function (x) { return x.trim(); })
    .filter(Boolean);
}
