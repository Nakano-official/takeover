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
 *   ✅ staffs.available_slots / assist_slots … 本命。学期ごとの空きコマ更新（業務ごと・D32）
 *   ✅ staffs.skills          … 対応できる業務（テイク / 介助）。D28 では職員管理にしていたが、
 *                               承認後に直す画面が無く職員がシートを開くしかなかったため開放した（D31）。
 *                               **両方外した保存は受け付けない**。skills 空欄は D9 で「全対応」扱いのため、
 *                               「どちらもできません」のつもりが**全依頼を受ける**側に倒れてしまう。
 *
 *   ❌ staffs.name           … 表示と突合に使う。本人が変えると職員側の照合がずれる
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
  // 業務ごとに選べる時限が違いうるので（介助だけの移動枠など・D32）、どの業務で出せるかも返す。
  const periodRows = readRows(SHEET.PERIODS).filter(function (p) {
    return String(p.period).trim();
  });
  const periods = periodRows.map(function (p) {
    return {
      period: String(p.period).trim(),
      time: p.start_time ? p.start_time + '〜' + p.end_time : '',
      supportTypes: SUPPORT_TYPES.filter(function (t) {
        return periodAllowsSupportType_(p, t);
      }),
    };
  });

  return {
    staff_id: user.staff_id,
    email: user.email,
    // ── 職員が管理する項目（画面では読み取り専用で見せる）──
    name: staff ? String(staff.name || '').trim() : user.name,
    role: String(user.role || '').trim(),
    skills: staff ? String(staff.skills || '').trim() : '',
    // ── 本人が変更できる項目 ──
    phone: contact ? String(contact.phone || '').trim() : '',
    webhook_url: contact ? String(contact.webhook_url || '').trim() : '',
    skillList: staff ? splitSkills_(staff.skills) : [],
    supportTypes: SUPPORT_TYPES.slice(),
    // 業務ごとの空きコマ。画面はこれを切り替えて出す（1ページ内でタブ・D32）
    slotsByType: slotsByTypeOf_(staff),
    // Date のまま返すと google.script.run が null にするので文字列で返す
    slots_updated_at: staff ? String(staff.slots_updated_at || '').trim() : '',
    // ── 画面の組み立て用 ──
    isStudent: isStudent,
    days: WORK_DAYS.slice(),
    periods: periods,
  };
}

/**
 * マイページからの更新。受け付けるのは phone / webhook_url / slots / skills の4つだけ
 * （D28 の3つ＋ D31 で skills を追加）。
 *
 * @param {{phone:string, webhook_url:string, slots:Array<string>, skills:Array<string>}} payload
 * @return {{ok:boolean, slots:string, skills:string, slots_updated_at:string, warnings:Array<string>}}
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

  // 空きコマと対応できる業務は学生のみ。職員は代行候補にならない（findCandidates_ が
  // role='学生' で絞る）ので、どちらも職員の行では意味を持たない。
  var savedSlots = {};
  var skillsCsv = '';
  var updatedAt = '';
  if (isStudent) {
    const staffRow = findRow(SHEET.STAFFS, 'staff_id', user.staff_id);
    updatedAt = nowString_();

    const updates = { slots_updated_at: updatedAt };

    // 空きコマは業務ごと（D32）。**送られてきた業務だけ**を書き換える。
    // 画面が介助のタブを出していないとき（対応できる業務から外している等）に
    // 空配列を送りつけたことにすると、本人が入れた介助の空きコマを黙って消してしまう。
    const requested = slotsPayload_(p);
    SUPPORT_TYPES.forEach(function (type) {
      const col = SLOT_COLUMN_BY_SUPPORT_TYPE[type];
      if (requested[type] === undefined) {
        savedSlots[type] = splitSlots_(staffRow && staffRow[col]);
        return;
      }
      const csv = normalizeSlots_(requested[type], type);
      updates[col] = csv;
      savedSlots[type] = splitSlots_(csv);
    });

    // skills は**送られてきたときだけ**触る（D31）。古い画面が開きっぱなしで
    // skills を含まない保存が飛んできても、黙って全対応に倒すより現状維持のほうが安全。
    // 逆に「空配列で送ってきた＝全部外した」は意思表示なので normalizeSkills_ が弾く。
    if (p.skills !== undefined) {
      skillsCsv = normalizeSkills_(p.skills);
      updates.skills = skillsCsv;
      // 担当を外れたわけではないので保存は止めない。ただし黙って食い違わせない。
      droppedSkillWarning_(user.staff_id, staffRow, skillsCsv).forEach(function (w) { warnings.push(w); });
    } else {
      skillsCsv = splitSkills_(staffRow && staffRow.skills).join(',');
    }

    // 保存のたびに日時を更新する。値が変わらなくても「今学期これで出し直した」という
    // 本人の確認なので、職員が「まだ出していない人」を見分けられるようにする（D28）。
    const staffUpdated = updateRow(SHEET.STAFFS, 'staff_id', user.staff_id, updates);
    if (!staffUpdated) throw new Error('名簿の行が見つかりませんでした。職員にお問い合わせください。');

    // 「対応できる業務に入れているのに、その業務の空きコマが空」だけを警告する。
    // 対応しない業務の空きコマが無いのは当たり前なので、そこを鳴らすとノイズになる。
    const mySkills = splitSkills_(skillsCsv);
    SUPPORT_TYPES.forEach(function (type) {
      if (mySkills.length && mySkills.indexOf(type) === -1) return;
      if (!savedSlots[type].length) {
        warnings.push(type + 'の空きコマが1つも選ばれていません。' + type + 'の代行候補に出ません。');
      }
    });
  }

  return {
    ok: true, slotsByType: savedSlots, skills: skillsCsv,
    slots_updated_at: updatedAt, warnings: warnings,
  };
}

/**
 * 画面から来た空きコマを「業務 → 配列」の形に揃える（D32）。
 *
 * 新しい画面は `slotsByType: { テイク: [...], 介助: [...] }` を送る。
 * 古い画面が開きっぱなしのときは `slots: [...]` が来るので、**テイクぶんだけ**として扱う
 * （介助は触らない＝黙って消さない）。
 */
function slotsPayload_(p) {
  const out = {};
  const byType = (p && p.slotsByType) || null;
  if (byType) {
    SUPPORT_TYPES.forEach(function (type) {
      if (byType[type] !== undefined) out[type] = byType[type];
    });
    return out;
  }
  if (p && p.slots !== undefined) out['テイク'] = p.slots;
  return out;
}

/**
 * 空きコマの入力（['月1','火3'] 形式）を検証して '月1,火3' の保存形へ正規化する。
 *
 * 曜日は WORK_DAYS、時限は時限マスタにあるものだけを通す。ここを緩くすると、
 * 実在しないスロット（土9 など）が available_slots に入り、**その人は永久に候補へ出ない**
 * という静かな壊れ方をする（backlog 10-5 と同じ性質）。
 *
 * supportType を渡すと、その業務で選べない時限（介助専用の移動枠など・D32）も弾く。
 */
function normalizeSlots_(slots, supportType) {
  const validDay = {};
  WORK_DAYS.forEach(function (d) { validDay[d] = true; });
  const validPeriod = {};
  readRows(SHEET.PERIODS).forEach(function (p) {
    const key = String(p.period).trim();
    if (!key) return;
    if (supportType && !periodAllowsSupportType_(p, supportType)) return;
    validPeriod[key] = true;
  });

  const seen = {};
  const out = [];
  (slots || []).forEach(function (raw) {
    const s = String(raw).trim();
    if (!s) return;
    const day = s.slice(0, 1);
    const period = s.slice(1);
    if (!validDay[day]) throw new Error('曜日が不正です：' + s);
    if (!validPeriod[period]) {
      throw new Error('時限が不正です：' + s + (supportType ? '（' + supportType + 'では選べません）' : ''));
    }
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

/**
 * 対応できる業務の入力（['テイク','介助'] 形式）を検証して 'テイク,介助' の保存形へ正規化する。
 *
 * **1つも選ばれていない保存は受け付けない。** skills 空欄は D9 で「全対応」扱いなので、
 * 「どちらもできません」のつもりで両方外すと、**逆に全部の依頼が飛ぶ**側に倒れる。
 * 画面でも止めているが、ここで止めないと画面を通さない経路で同じことが起きる。
 */
function normalizeSkills_(skills) {
  const raw = Array.isArray(skills) ? skills : String(skills == null ? '' : skills).split(',');
  const picked = SUPPORT_TYPES.filter(function (name) {
    return raw.some(function (x) { return String(x).trim() === name; });
  });
  if (!picked.length) {
    throw new Error('対応できる業務を1つ以上選んでください（すべて外すと、逆にすべての依頼が届きます）。');
  }
  return picked.join(',');
}

/**
 * いま担当しているコマの内容が、新しい skills から外れていないかを見て警告文を返す。
 *
 * 保存は止めない（担当を決めるのは職員で、本人が外したからといって担当が消えるわけではない）。
 * ただし黙って食い違わせると、**代行候補には出ないのに担当は持っている**という状態が
 * 誰にも見えないまま残る。その場で本人に伝えて、職員へ相談する入口にする。
 */
function droppedSkillWarning_(staffId, staff, skillsCsv) {
  const before = splitSkills_(staff && staff.skills);
  if (!before.length) return [];                       // 元が全対応なら「外れた」判定はできない
  const after = splitSkills_(skillsCsv);
  const dropped = before.filter(function (x) { return after.indexOf(x) === -1; });
  if (!dropped.length) return [];

  const id = String(staffId).trim();
  const counts = {};
  readRows(SHEET.COURSES).forEach(function (c) {
    const type = String(c.support_type || '').trim();
    if (dropped.indexOf(type) === -1) return;
    if (String(c.staff_a_id).trim() !== id && String(c.staff_b_id).trim() !== id) return;
    counts[type] = (counts[type] || 0) + 1;
  });

  return Object.keys(counts).map(function (type) {
    return type + 'を外しましたが、担当している' + type + 'のコマが ' + counts[type] +
      ' 件あります。担当そのものは変わりません。外れたい場合は職員へお伝えください。';
  });
}

/** 'テイク,介助' 形式を配列へ（既知の値だけ・空欄＝全対応はそのまま空配列） */
function splitSkills_(csv) {
  const raw = String(csv || '').split(',').map(function (x) { return x.trim(); });
  return SUPPORT_TYPES.filter(function (name) { return raw.indexOf(name) !== -1; });
}
