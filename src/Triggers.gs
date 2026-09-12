/**
 * 時間トリガーの管理（D22）
 *
 * このシステムで「時間が来たから動く」処理を1箇所に集める。現在の対象は代行募集の締切検知
 * （closeExpiredRecruits・Vacancy.gs）だけだが、締切前リマインドや月末の勤怠リマインド（B-3）も
 * ここに足していく想定。
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
function managedTriggers_() {
  return [
    {
      handler: 'closeExpiredRecruits',
      intervalMin: RECRUIT_DEADLINE_CHECK_INTERVAL_MIN,
      label: '代行募集の締切検知（募集クローズ＋職員へ決着要求・D22）',
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
    // everyMinutes が受け付けるのは 1/5/10/15/30 分のみ。それ以外はGASが例外を投げる。
    ScriptApp.newTrigger(t.handler).timeBased().everyMinutes(t.intervalMin).create();
    Logger.log('✅ ' + t.handler + ' を ' + t.intervalMin + '分ごとに実行するトリガーを作成しました。');
    Logger.log('   ' + t.label);
  });

  if (removed > 0) Logger.log('（既存の同名トリガー ' + removed + '件を作り直しました）');
  Logger.log('実行者: ' + Session.getEffectiveUser().getEmail() +
    '　※このアカウントでトリガーが動きます（引き継ぎ時は新担当が再実行すること）');
}

/**
 * このスクリプトのトリガーを全部削除する。
 * 検証中に通知を止めたいとき、または引き継ぎで作り直すときに使う。
 */
function removeTriggers() {
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

  const managed = managedTriggers_();
  const have = triggers.map(function (t) { return t.getHandlerFunction(); });
  managed.forEach(function (m) {
    if (have.indexOf(m.handler) === -1) {
      Logger.log('⚠️ ' + m.handler + ' が未登録です（' + m.label + '）。installTriggers() を実行してください。');
    }
  });
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
