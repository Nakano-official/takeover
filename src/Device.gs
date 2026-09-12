/**
 * 物理アラート端末（M5Stack）連携（decisions.md D6 / 案1）
 *
 * 職員向けの欠員アラート端末（音＋光＋文字）が、LAN内からこのWeb Appを
 * 定期ポーリングするための「読み取り専用・軽量エンドポイント」。
 *
 * 設計の要点：
 *  - クラウド→LAN内端末へ直接プッシュできないため、端末側がポーリングする。
 *  - 返すのは「未対応欠員の件数 + 最新の欠員連番」だけ。氏名等の個人情報は一切返さない（D3と整合）。
 *  - 認証はトークン1本（スクリプトプロパティ DEVICE_TOKEN）。ログインユーザーは介在しない。
 *  - 端末が「新着あり」を判定できるよう、最新の欠員連番（単調増加）を返す。
 *    端末はこの値が前回より増えたら新着とみなして1回だけ鳴らす。
 *
 * 呼び出し：  GET  <Web App の /exec URL>?device=alert&token=<DEVICE_TOKEN>
 * 応答（JSON）：
 *   成功時： {"ok": true,  "count": <未対応件数>, "latest": <最新の欠員連番>}
 *   失敗時： {"ok": false, "error": "unauthorized"}
 *
 * ※ 端末はGoogleログインを持たないため、このWeb Appのデプロイは
 *    「アクセスできるユーザー＝全員（匿名可）」にする必要がある。
 *    画面側は getCurrentUser_ で必ずロール判定するため、匿名でも個人情報は出ない。
 */

const PROP_DEVICE_TOKEN = 'DEVICE_TOKEN';

// 大学ログイン済みのPC専用。呼び出しのたびに職員権限を確認する。
// USB中継（別担当）が device-relay 画面から google.script.run で呼ぶ。
// トークン方式（handleDevicePoll_）と違い、こちらは**ログイン済み職員**であることが認可の根拠なので、
// Web App のアクセス範囲を「全員」に開く必要がない。
function getDeviceRelaySummary() {
  requireStaff_();
  return getOpenVacancySummary_();
}

/**
 * 端末ポーリングを処理して JSON を返す（doGet から分岐して呼ばれる）。
 * @param {Object} params e.parameter（token を含む）
 */
function handleDevicePoll_(params) {
  const expected = PropertiesService.getScriptProperties().getProperty(PROP_DEVICE_TOKEN);
  const given = String((params && params.token) || '');

  // トークン未設定・空・不一致はすべて拒否（件数すら返さない）
  if (!expected || given.length === 0 || given !== expected) {
    return deviceJson_({ ok: false, error: 'unauthorized' });
  }

  const summary = getOpenVacancySummary_();
  return deviceJson_({ ok: true, count: summary.count, latest: summary.latest });
}

/**
 * 未対応欠員の「件数」と「最新の欠員連番」を集計する。
 *  - 件数 ＝ result が空（＝未確定）の欠員の数。
 *  - 最新連番 ＝ 全欠員の vacancy_id の連番の最大値。採番は単調増加なので「最新の登録」を表す。
 *    （未対応に限らず最大値を返すことで、対応確定で件数が減っても "最新" は後退しない＝
 *     端末が確定後に誤って再アラートしない）
 * @return {{count:number, latest:number}}
 */
function getOpenVacancySummary_() {
  const rows = readRows(SHEET.VACANCIES);
  var count = 0;
  var latest = 0;
  rows.forEach(function (v) {
    if (!String(v.result).trim()) count++;        // 未対応（result 空）
    const n = vacancySeq_(v.vacancy_id);          // 'V003' → 3
    if (n > latest) latest = n;
  });
  return { count: count, latest: latest };
}

// vacancy_id（例 'V003'）末尾の連番を整数で返す。取れなければ 0。
function vacancySeq_(id) {
  const m = String(id).match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

// オブジェクトを JSON テキスト出力で返す（Content-Type: application/json）
function deviceJson_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
