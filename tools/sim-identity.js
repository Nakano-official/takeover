/**
 * 本人確認キャッシュ（D48・Identity.gs）の検証 — Node 上で実行する
 *
 *     node tools/sim-identity.js
 *
 * ここで一番大事なのは **古い権限が残らないこと**。キャッシュが当たって速くなることより、
 * 「シートを直したのに職員権限のまま」「トリガーが止まっているのに持ち続ける」を起こさないほうが重い。
 *   - シートが直されたら（onDbSheetChange）次の呼び出しで必ず読み直す
 *   - 世代が無ければ（トリガーが動いていない）キャッシュに書かない
 *   - 読んでいる最中にシートが直されても、古い内容を新しい世代で保存しない
 *   - 未登録（null）は持たない（承認された直後から使えること）
 *
 * 実 CacheService の挙動と、変更トリガーが手の編集で本当に発火するかは GAS でしか確かめられない。
 */
const { Harness } = require('./gas-harness');

const h = new Harness();
h.load(['Constants.gs', 'Util.gs', 'Terms.gs', 'Vacancy.gs', 'Input.gs', 'code.js', 'Identity.gs']);
const G = h.G;

const GEN = 'identity:gen';
const keyOf = (email) => 'identity:user:' + email.toLowerCase();

// シートを読んだ回数（contacts を引いた回数で数える）
var reads = 0;
const origFindRowCI = G.findRowCI_;
G.findRowCI_ = function () { reads++; return origFindRowCI.apply(this, arguments); };

function setup() {
  h.reset();
  reads = 0;
  h.add('staffs', { staff_id: 'T1', name: '職員 一郎', role: '職員' });
  h.add('staffs', { staff_id: 'S1', name: '学生 花子', role: '学生' });
  h.add('contacts', { staff_id: 'T1', name: '職員 一郎', email: 't1@example.jp' });
  h.add('contacts', { staff_id: 'S1', name: '学生 花子', email: 's1@example.jp' });
  h.setEmail('t1@example.jp');
}

// ── 1) トリガーが動いていない（世代が無い）────────────────
h.section('1) 世代が無いときはキャッシュを使わない（従来どおり毎回読む）');
setup();
var u = G.getCurrentUser_();
h.check(u && u.staff_id === 'T1' && u.role === '職員', '本人を正しく引ける');
G.getCurrentUser_();
h.check(reads === 2, '★世代が無ければ2回とも読む（トリガー無しで古い権限を持ち続けない）');
h.check(!h.cache.has(keyOf('t1@example.jp')), '★世代が無ければキャッシュに書かない');

// ── 2) 当たれば読まない ──────────────────────────────────
h.section('2) 世代があれば2回目からシートを読まない');
setup();
G.keepIdentityCacheAlive();
h.check(h.cache.has(GEN), 'keepIdentityCacheAlive が世代を作る');
h.check(h.cache.get(GEN).ttl === h.value('IDENTITY_GEN_TTL_SEC'), '世代の寿命は1時間');
u = G.getCurrentUser_();
var u2 = G.getCurrentUser_();
h.check(reads === 1, '★2回目はシートを読まない');
h.check(JSON.stringify(u) === JSON.stringify(u2), 'キャッシュから返しても中身は同じ');
h.check(u2.email === 't1@example.jp', 'email も返す');
h.check(h.cache.get(keyOf('t1@example.jp')).ttl === h.value('IDENTITY_ENTRY_TTL_SEC'),
  '各人の項目は6時間');
var cached = JSON.parse(h.cache.get(keyOf('t1@example.jp')).value);
h.check(Object.keys(cached.user).sort().join(',') === 'name,role,staff_id',
  '★持つのは staff_id・name・role の3つだけ');

// 戻り値を書き換えても次に影響しない
u2.role = '学生';
h.check(G.getCurrentUser_().role === '職員', '戻り値を書き換えてもキャッシュは変わらない');

// ── 3) シートが直されたら読み直す ─────────────────────────
h.section('3) シートを直したら（変更トリガー）次の呼び出しで反映される');
setup();
G.keepIdentityCacheAlive();
G.getCurrentUser_();
h.row('staffs', 'staff_id', 'T1').role = '学生';     // 職員がシートで権限を外した
h.check(G.getCurrentUser_().role === '職員', '（変更トリガーが来るまでは古いまま＝想定どおり）');
G.onDbSheetChange({ changeType: 'EDIT' });
reads = 0;
h.check(G.getCurrentUser_().role === '学生', '★変更トリガーのあとは新しい権限になる');
h.check(reads === 1, '変更トリガーのあとは1回読み直す');
var threw = '';
try { G.requireStaff_(); } catch (e) { threw = e.message; }
h.check(threw === '職員権限が必要です。', '★権限を外した人は職員限定の関数を呼べない');

// 行の削除（退職）も同じ
h.db.contacts = h.db.contacts.filter(function (c) { return c.staff_id !== 'T1'; });
G.onDbSheetChange({ changeType: 'REMOVE_ROW' });
h.check(G.getCurrentUser_() === null, '★名簿から消した人は次の呼び出しで未登録になる');

// ── 4) 延長は値を変えない ────────────────────────────────
h.section('4) keepIdentityCacheAlive は世代を変えない（当たり続ける）');
setup();
G.keepIdentityCacheAlive();
var gen1 = h.cache.get(GEN).value;
G.getCurrentUser_();
G.keepIdentityCacheAlive();
h.check(h.cache.get(GEN).value === gen1, '★延長しても世代は同じ');
reads = 0;
G.getCurrentUser_();
h.check(reads === 0, '延長のあとも当たる');

// ── 5) 世代が消えたら ────────────────────────────────────
h.section('5) 世代が消えたら（追い出し・トリガー停止）キャッシュを使わない');
setup();
G.keepIdentityCacheAlive();
G.getCurrentUser_();
h.cache.delete(GEN);                                    // 期限切れ・追い出し
reads = 0;
G.getCurrentUser_();
h.check(reads === 1, '★世代が無ければ、項目が残っていても使わない');
G.keepIdentityCacheAlive();                             // 新しい世代ができる
reads = 0;
G.getCurrentUser_();
h.check(reads === 1, '★新しい世代では古い項目を使わない（読み直す）');

G.stopIdentityCache_();
h.check(!G.isIdentityCacheActive_(), 'stopIdentityCache_ でキャッシュが止まる');

// ── 6) 読んでいる最中にシートが直された ───────────────────
h.section('6) 読み込み中にシートが直されても、古い内容を新しい世代で保存しない');
setup();
G.keepIdentityCacheAlive();
var fired = false;
const origFindRow = G.findRow;
G.findRow = function () {
  const r = origFindRow.apply(this, arguments);
  if (!fired) {
    fired = true;
    // staffs を読み終えた直後（キャッシュに書く前）に職員がシートを直し、変更トリガーが走った
    h.row('staffs', 'staff_id', 'T1').role = '学生';
    G.onDbSheetChange({ changeType: 'EDIT' });
  }
  return r;
};
h.check(G.getCurrentUser_().role === '職員', '（その回は読んだ時点の内容を返す）');
G.findRow = origFindRow;
h.check(G.getCurrentUser_().role === '学生', '★次の呼び出しでは直した内容になる（古い世代で保存されている）');

// ── 7) 未登録は持たない ──────────────────────────────────
h.section('7) 未登録（null）はキャッシュしない');
setup();
G.keepIdentityCacheAlive();
h.setEmail('new@example.jp');
h.check(G.getCurrentUser_() === null, '名簿に無ければ null');
h.check(!h.cache.has(keyOf('new@example.jp')), '★null は書かない');
// 承認で行ができた（アプリの書き込み＝変更トリガーは来ない前提）
h.add('staffs', { staff_id: 'S2', name: '新人', role: '学生' });
h.add('contacts', { staff_id: 'S2', name: '新人', email: 'new@example.jp' });
u = G.getCurrentUser_();
h.check(u && u.staff_id === 'S2', '★承認された直後から本人として使える');

// ── 8) 人ごとに分かれる・メールの大小 ─────────────────────
h.section('8) 人ごとに別の項目・メールの大文字小文字');
setup();
G.keepIdentityCacheAlive();
h.setEmail('t1@example.jp');
G.getCurrentUser_();
h.setEmail('s1@example.jp');
u = G.getCurrentUser_();
h.check(u.staff_id === 'S1' && u.role === '学生', '★別の人には別の結果（他人の権限で動かない）');
h.setEmail('T1@Example.JP');
reads = 0;
u = G.getCurrentUser_();
h.check(reads === 0 && u.staff_id === 'T1', '大文字小文字が違っても同じ項目に当たる');
h.check(u.email === 'T1@Example.JP', 'email は今のセッションの表記で返す');

// ── 9) 壊れた値 ──────────────────────────────────────────
h.section('9) キャッシュの値が壊れていたら読み直す');
setup();
G.keepIdentityCacheAlive();
h.cache.set(keyOf('t1@example.jp'), { value: '{壊れた', ttl: 1 });
u = G.getCurrentUser_();
h.check(u && u.staff_id === 'T1' && reads === 1, '★壊れた値は使わず読み直す');
h.check(JSON.parse(h.cache.get(keyOf('t1@example.jp')).value).user.staff_id === 'T1',
  '読み直した結果で上書きする');

// ── 10) Session が空 ─────────────────────────────────────
h.section('10) メールが取れない（トリガー実行など）');
setup();
G.keepIdentityCacheAlive();
h.setEmail('');
h.check(G.getCurrentUser_() === null && reads === 0, 'メールが空なら読まずに null');

process.exitCode = h.report();
