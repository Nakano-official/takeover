/**
 * 本人確認の結果を、実行をまたいで持つキャッシュ（D48）
 *
 * ■ なぜ要るか
 *   getCurrentUser_（code.js）は毎回、連絡先DBとメインDBを開いて contacts・staffs を読む。
 *   シートAPIは行数に関係なく1回 200〜400ms かかり、2026-10-28 の実測では
 *   doGet 1回のコード時間 1,056ms のうち 1,028ms がこれだった。ナビを押すたびに走るので、
 *   職員が同じタブで画面を行き来するときの待ちの大半を占めていた。
 *   Sheets.gs の実行内キャッシュは1実行で消えるため、ここには効かない。
 *
 * ■ 何を持つか
 *   メールアドレス → { staff_id, name, role } だけ。**未登録（null）は持たない**
 *   （承認された直後から使えるようにするため）。
 *   この3つはどの画面からも変えられない（Profile.gs の ❌ 欄。承認は新しい行を作るだけ）。
 *   変わるのは**職員がシートを直接直したときだけ**なので、それを変更トリガーで拾って捨てる。
 *
 * ■ 捨て方（世代番号）
 *   各人の項目に「書いたときの世代」を入れておき、現在の世代と違えば使わない。
 *   メインDB・連絡先DBのどちらかが手で変更されると onDbSheetChange が世代を進め、
 *   全員分が一度に無効になる。CacheService は中身を列挙できないので、1件ずつ消す代わりにこの形にした。
 *   世代は**シートを読む前**に取っておく。読んでいる最中にシートが直されても、
 *   書き込む項目は古い世代のままなので、次の呼び出しで必ず読み直される。
 *
 * ■ トリガーが止まっているときに古い権限が残り続けないために
 *   世代を**作るのはトリガー側だけ**（installTriggers・onDbSheetChange・keepIdentityCacheAlive）。
 *   画面からの呼び出しは、世代が無ければキャッシュを使わず従来どおりシートを読む。
 *   世代の寿命は IDENTITY_GEN_TTL_SEC（1時間）で、keepIdentityCacheAlive が15分ごとに延ばす。
 *     - トリガーが動いている … シートを直してから数秒で反映される
 *     - トリガーが止まった   … 実行者の異動など（backlog 12-1）。最長1時間でキャッシュ自体が止まる
 *
 * ■ 注意
 *   - getUserCache は使えない。executeAs: USER_DEPLOYING なので「ユーザー」はデプロイした職員
 *     1人になり、**全員で共有される**（別の人の権限で動く）。必ず getScriptCache にメールをキーで置く。
 *   - 世代を書き換えるのは ScriptLock の中だけ。延長と更新が競合し、進めた世代を古い値で
 *     上書きすると、捨てたはずの項目が生き返るため。画面からの読み取りはロックを取らない。
 *   - onDbSheetChange / keepIdentityCacheAlive はトリガーから呼ぶので公開関数にしてある。
 *     google.script.run から呼ばれても、キャッシュが捨てられて次が少し遅くなるだけで害はない。
 */

const IDENTITY_GEN_KEY = 'identity:gen';
const IDENTITY_KEY_PREFIX = 'identity:user:';
const IDENTITY_GEN_TTL_SEC = 3600;          // 世代の寿命。延長されなければ1時間で消え、キャッシュが止まる
const IDENTITY_ENTRY_TTL_SEC = 21600;       // 各人の項目の寿命（CacheService の上限＝6時間）
const IDENTITY_KEEPALIVE_INTERVAL_MIN = 15; // 世代の延長間隔（everyMinutes が受け付ける値にすること）

/**
 * email の本人確認結果を返す。キャッシュに今の世代の項目があればシートを読まない。
 * @param {string} email
 * @param {function(): ?Object} load シートから引く処理（{staff_id, name, role} か null を返す）
 * @return {?Object}
 */
function cachedIdentity_(email, load) {
  const cache = CacheService.getScriptCache();
  const key = IDENTITY_KEY_PREFIX + String(email).trim().toLowerCase();
  const got = cache.getAll([IDENTITY_GEN_KEY, key]);
  const gen = got[IDENTITY_GEN_KEY];

  if (gen && got[key]) {
    try {
      const entry = JSON.parse(got[key]);
      if (entry.gen === gen && entry.user) return entry.user;
    } catch (e) {
      // 壊れた値は使わずに読み直す（下で上書きされる）
    }
  }

  const user = load();
  // 世代が無い＝トリガーが動いていない可能性がある。持たずに返す（読み直すだけなので安全側）
  if (user && gen) {
    cache.put(key, JSON.stringify({ gen: gen, user: user }), IDENTITY_ENTRY_TTL_SEC);
  }
  return user;
}

/**
 * 変更トリガーの受け口。メインDB・連絡先DBのどちらかが手で変更されたら呼ばれる。
 * 変更されたシートは見ずに、全員分を無効にする（onChange の引数にはシート名が無い）。
 */
function onDbSheetChange(e) {
  advanceIdentityGen_();
}

/**
 * 世代の寿命を延ばす（時間トリガーから15分ごと）。値は変えないので、持っている項目は当たり続ける。
 * 世代が消えていたら新しく作る。
 */
function keepIdentityCacheAlive() {
  withLock_(function () {
    const cache = CacheService.getScriptCache();
    const gen = cache.get(IDENTITY_GEN_KEY) || newIdentityGen_();
    cache.put(IDENTITY_GEN_KEY, gen, IDENTITY_GEN_TTL_SEC);
  });
}

/** 世代を進めて、全員分の項目を無効にする */
function advanceIdentityGen_() {
  try {
    withLock_(function () {
      CacheService.getScriptCache().put(IDENTITY_GEN_KEY, newIdentityGen_(), IDENTITY_GEN_TTL_SEC);
    });
  } catch (err) {
    // ロックが取れなくても古い権限を残さない。世代を消せばキャッシュが止まり、
    // 次の keepIdentityCacheAlive が新しい世代を作るまで全員がシートを読む。
    CacheService.getScriptCache().remove(IDENTITY_GEN_KEY);
    throw err;
  }
}

/** 世代を消してキャッシュを止める（removeTriggers から呼ぶ） */
function stopIdentityCache_() {
  CacheService.getScriptCache().remove(IDENTITY_GEN_KEY);
}

/** 今キャッシュが動いているか（listTriggers の表示用） */
function isIdentityCacheActive_() {
  return !!CacheService.getScriptCache().get(IDENTITY_GEN_KEY);
}

function newIdentityGen_() {
  return String(Date.now()) + '-' + Math.random().toString(36).slice(2, 8);
}
