/**
 * トリガーの管理（D22・D48）
 *
 * このシステムで「時間が来たから動く」「シートが変わったから動く」処理を1箇所に集める。
 *   - 代行募集の締切検知（closeExpiredRecruits・Vacancy.gs）… 10分ごと
 *   - 本人確認キャッシュの無効化（onDbSheetChange・Identity.gs）… メインDB・連絡先DBの変更時
 *   - 本人確認キャッシュの延長（keepIdentityCacheAlive・Identity.gs）… 15分ごと
 * 締切前リマインドや月末の勤怠リマインド（B-3）もここに足していく想定。
 *
 * ■ なぜトリガーが要るか
 *   締切判定（D21）はもともと欠勤連絡の**その1回**しか走らなかった。そのため
 *   「締切前に登録され、誰も承諾しないまま締切に達した」欠員を閉じる契機が存在せず、
 *   補充できないまま当日を迎える欠員について職員へ何の通知も出なかった。
 *
 * ■ 実行者について（重要・backlog 12-1）
 *   トリガーは**インストールした人のアカウントで**動く。Web App の「デプロイした職員として実行」
 *   とは別管理なので、その職員が異動・退職するときは新しい担当者が installTriggers() を
 *   実行し直す必要がある。引き継ぎ手順に必ず含めること。
 *
 * ■ 使い方（GASエディタから手で実行する）
 *   1. installTriggers()  … トリガーを作る（作り直しも兼ねる・冪等）
 *   2. listTriggers()     … 今あるトリガーを確認する
 *   3. removeTriggers()   … このスクリプトのトリガーを全部消す
 */

// このファイルが管理するトリガーの一覧。関数名 → 説明。
// 増やすときはここに足す（install / remove / list が自動で追従する）。
//   intervalMin    … 時間トリガー（N分ごと）
//   spreadsheetProp … 変更トリガー。そのスクリプトプロパティが指すスプレッドシートの変更で動く
// 同じ handler を複数並べてよい（変更トリガーは DB ごとに1つ要る）。
function managedTriggers_() {
  return [
    {
      handler: 'closeExpiredRecruits',
      intervalMin: RECRUIT_DEADLINE_CHECK_INTERVAL_MIN,
      label: '代行募集の締切検知（募集クローズ＋職員へ決着要求・D22）',
    },
    {
      handler: 'onDbSheetChange',
      spreadsheetProp: 'SPREADSHEET_ID',
      label: 'メインDBが直されたら本人確認キャッシュを捨てる（D48）',
    },
    {
      handler: 'onDbSheetChange',
      spreadsheetProp: 'CONTACTS_SPREADSHEET_ID',
      label: '連絡先DBが直されたら本人確認キャッシュを捨てる（D48）',
    },
    {
      handler: 'keepIdentityCacheAlive',
      intervalMin: IDENTITY_KEEPALIVE_INTERVAL_MIN,
      label: '本人確認キャッシュの延長（止まると最長1時間でキャッシュが止まる・D48）',
    },
  ];
}

/**
 * 時間トリガーを作る（既存の同名トリガーは作り直す）。
 * 間隔の定数（RECRUIT_DEADLINE_CHECK_INTERVAL_MIN）を変えたときも、これを実行し直せば反映される。
 * 既存トリガーは間隔を後から変更できないため、消してから作る。
 */
function installTriggers() {
  const managed = managedTriggers_();
  const names = managed.map(function (t) { return t.handler; });

  // 同じハンドラのトリガーを一旦全部消す（二重登録＝二重実行を防ぐ）
  var removed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (names.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });

  managed.forEach(function (t) {
    if (t.spreadsheetProp) {
      const id = PropertiesService.getScriptProperties().getProperty(t.spreadsheetProp);
      if (!id) throw new Error('スクリプトプロパティ ' + t.spreadsheetProp + ' が未設定です。');
      ScriptApp.newTrigger(t.handler).forSpreadsheet(id).onChange().create();
      Logger.log('✅ ' + t.handler + ' を ' + t.spreadsheetProp + ' の変更で実行するトリガーを作成しました。');
    } else {
      // everyMinutes が受け付けるのは 1/5/10/15/30 分のみ。それ以外はGASが例外を投げる。
      ScriptApp.newTrigger(t.handler).timeBased().everyMinutes(t.intervalMin).create();
      Logger.log('✅ ' + t.handler + ' を ' + t.intervalMin + '分ごとに実行するトリガーを作成しました。');
    }
    Logger.log('   ' + t.label);
  });

  // 本人確認キャッシュを動かし始める（世代はトリガー側だけが作る・Identity.gs）
  advanceIdentityGen_();
  Logger.log('✅ 本人確認キャッシュを有効にしました（D48）。');

  if (removed > 0) Logger.log('（既存の同名トリガー ' + removed + '件を作り直しました）');
  Logger.log('実行者: ' + Session.getEffectiveUser().getEmail() +
    '　※このアカウントでトリガーが動きます（引き継ぎ時は新担当が再実行すること）');
}

/**
 * このスクリプトのトリガーを全部削除する。
 * 検証中に通知を止めたいとき、または引き継ぎで作り直すときに使う。
 */
function removeTriggers() {
  // 変更トリガーが無くなると、シートを直してもキャッシュが捨てられない。先に止める（D48）
  stopIdentityCache_();
  Logger.log('本人確認キャッシュを止めました（以後は毎回シートを読みます）。');

  const triggers = ScriptApp.getProjectTriggers();
  if (triggers.length === 0) {
    Logger.log('トリガーはありません。');
    return;
  }
  triggers.forEach(function (t) {
    Logger.log('🗑 削除: ' + t.getHandlerFunction());
    ScriptApp.deleteTrigger(t);
  });
  Logger.log('✅ ' + triggers.length + '件のトリガーを削除しました。');
}

/**
 * 今あるトリガーを一覧表示する（何が・誰の権限で動いているかの確認用）。
 */
function listTriggers() {
  const triggers = ScriptApp.getProjectTriggers();
  Logger.log('===== 登録済みトリガー（' + triggers.length + '件）=====');
  triggers.forEach(function (t) {
    Logger.log('・' + t.getHandlerFunction() + '（' + t.getEventType() + '）');
  });
  if (triggers.length === 0) {
    Logger.log('（なし）installTriggers() を実行してください。');
  }
  Logger.log('実行者: ' + Session.getEffectiveUser().getEmail());

  // 同じ handler が複数あるもの（変更トリガー）は数で比べる
  const want = {};
  managedTriggers_().forEach(function (m) {
    if (!want[m.handler]) want[m.handler] = { count: 0, label: m.label };
    want[m.handler].count++;
  });
  Object.keys(want).forEach(function (handler) {
    const have = triggers.filter(function (t) { return t.getHandlerFunction() === handler; }).length;
    if (have < want[handler].count) {
      Logger.log('⚠️ ' + handler + ' が足りません（' + have + '/' + want[handler].count + '件・' +
        want[handler].label + '）。installTriggers() を実行してください。');
    }
  });

  Logger.log('本人確認キャッシュ（D48）: ' + (isIdentityCacheActive_()
    ? '有効'
    : '停止中（毎回シートを読む。installTriggers() を実行すると有効になる）'));
}

/**
 * 締切検知をその場で1回だけ走らせる（トリガーを待たずに動作確認する用）。
 * ログに「どの欠員をクローズし、誰に通知したか」が出る。
 */
function runDeadlineCheckNow() {
  Logger.log('===== 締切チェックを手動実行 =====');
  const res = closeExpiredRecruits(true);
  Logger.log(JSON.stringify(res));
}
