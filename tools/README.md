# tools — 開発用（GASには送られない）

`.clasp.json` の `rootDir` は `src` なので、このディレクトリは **`clasp push` の対象外**。
本番の動作には一切関係しない、開発中に手元で回すための道具置き場。

Node の標準モジュール（`fs` / `path` / `vm` / `child_process`）だけで動く。
**`npm install` は不要**で `package.json` も `node_modules` も持たない。

```
node tools/run-all.js         # ← push 前にこれ1つ（構文チェック＋全ロジック検証）
```

個別に回すこともできる。

```
node tools/check-syntax.js    # src/ 全体の構文チェック
node tools/sim-vacancy.js     # 欠員補充（機能A）のロジック
node tools/sim-attendance.js  # 勤怠CSVの解析と15分丸め突合（機能B）
node tools/sim-forms.js       # フォーム設問 → DB値のマッピング
node tools/sim-oneoff.js      # 単発コマ（特別授業・イベント・D27）
node tools/sim-profile.js     # マイページ（本人が変更できる項目の境界・D28）
node tools/sim-registration.js # 利用登録の申請と承認（D28）
```

いずれも失敗時は終了コード 1 を返す。

---

## なぜ手元で回すのか

GAS のテスト関数を1回動かすには、`clasp push` → GASエディタを開く → 関数をドロップダウンから
選ぶ → 実行 → ログを読む、が毎回必要で、しかも実スプレッドシートを書き換えるので後片付けが要る。
ロジックを1行変えるたびにこれをやるのは重すぎて、「変更したが確かめていない」が溜まる。

さらに、GAS 側のテストの多くは**結果を Logger に出して人がログを読み比べる**形だった
（「期待: 2件」と出るが、実際が3件でも赤くならない）。手元へ移したものは期待値を assert にしてある。

そこで**手元で確かめられるものは手元で確かめ**、GAS 側には
**GAS でしか確かめられないもの**だけを残す、という分担にしている。

| | 何を確かめるか | どこで |
|---|---|---|
| `check-syntax.js` | 構文エラー（`.gs`・`.js`・HTML内の `<script>`） | 手元・1秒 |
| `sim-*.js` | ドメインロジック（候補抽出・締切・状態遷移・CSV解析・突合・画面へ返す値） | 手元・1秒 |
| `src/Tests.gs` | 実シート読み書き・実 Chat 送信・実カレンダー・実 PropertiesService | GASエディタ |
| `src/E2E.gs` | 実 LockService の競合・通しの状態遷移（一時データを作って消す） | GASエディタ |
| ブラウザ | 画面の見た目と操作 | Web App |

---

## check-syntax.js

`src/` の `.gs` / `.js` と、`.html` の `<script>` 内 JavaScript を**構文解析だけ**する（実行しない）。

GAS は構文エラーを「push した後、その関数を呼んだとき」にしか教えてくれない。
HTML 内の JS に至っては、画面を開いて操作するまで気づけない。
文字列の閉じ忘れ1つで push → エディタ → 画面操作を往復するのは高くつくので、その前段に置く。

テンプレートのスクリプトレット（`<?= x ?>` 等）は JavaScript ではないため、識別子1つに置換して評価する。

**検出できないこと**：未定義の関数・変数、GAS API の誤用、ロジックの誤り。構文だけを見る。

## sim-vacancy.js（機能A）

`Constants.gs` / `Attendance.gs` / `Vacancy.gs` を読み込み、欠員補充の中核を検証する。
D1（先着確定）・D21（締切）・D22（募集クローズ／決着は職員）・D25（辞退の扱い）・D26（再オープンは職員のみ）。

**検出できないこと**：実 LockService の排他制御（ここは単一スレッドなので CAS の分岐しか見ていない）、
`Sheets.gs` の実行内キャッシュと `withLock_` の相互作用、実 Chat 送信、HTML 画面の挙動。

## sim-attendance.js（機能B）

`Attendance.gs` を読み込み、勤怠CSVの解析（`parseAttendanceCsv_`）と15分丸め突合
（`reconcileShifts_`）を合成データで検証する。元は GAS の `testParseAttendanceCsv` / `testReconcile`。

**検出できないこと**：実CSVの文字コード（Shift_JIS / MS932）と実ヘッダー文字列（backlog 9-6）、
実カレンダーからの予定抽出（D7③）。合成データで**構造**だけを見ている。

## sim-forms.js

`Constants.gs` / `Forms.gs` を読み込み、フォーム送信の `namedValues` から DB に入る値の
組み立てを検証する。元は GAS の `testIntakeMapping`。
`available_slots` が1つずれると、その学生は代行候補に**構造的に出てこなくなる**（backlog 10-5）。

## sim-oneoff.js（単発コマ・D27）

`courses.date` が入った「その日1回だけ」のコマを、毎週の時間割と同じ `courses` に同居させている。
**学期で絞っている経路**と**曜日×時限で衝突を見ている経路**の両方が単発を正しく扱えるかを見る。
曜日の導出・`occurrencesOverlap_` の衝突判定・実施日以外の欠勤拒否・学期外での成立・
過ぎた単発の非表示・候補抽出・入力一覧の並び順。

**検出できないこと**：時間割の週表示（`home.html` の `weekStateOf`）と入力画面の出し分け。ブラウザ確認が要る。

## sim-profile.js / sim-registration.js（D28）

`Profile.gs`（マイページ）と `Registration.gs`（利用登録の申請・承認）を検証する。
見ているのはどちらも**境界**で、機能そのものより「越えてはいけない線」を守れているか。

- `sim-profile.js` … 本人が変更できるのは電話・Webhook・空きコマの3つだけ。
  payload に `role` や `name` を混ぜても無視されること、`staff_id` が必ず Session から取られること、
  実在しないスロットを弾くこと。
- `sim-registration.js` … **承認するまで `staffs` / `contacts` に一切書かない**こと、
  **`role` を申請者が決められない**こと、メールが Session 由来であること、
  二重承認・重複メール・却下後の再申請。

**検出できないこと**：画面の見た目と操作（申請フォーム・承認画面）。ブラウザ確認が要る。

---

## 新しい検証を足すとき

`tools/sim-〇〇.js` という名前で置けば `run-all.js` が自動で拾う。中身は `gas-harness.js` の `Harness` を使う。

```js
const { Harness } = require('./gas-harness');

const h = new Harness();
h.load(['Constants.gs', 'Terms.gs']);   // 読み込み順は GAS の連結順と同じ意味を持つ
h.add('terms', { term_id: '2026-前期', system: 'semester', start_date: '2026-04-01', end_date: '2026-09-20' });
h.setUser({ staff_id: 'T1', name: '職員', role: '職員' });

h.section('現在の学期');
h.check(h.G.currentTermIds_(h.G.readTerms_()).length === 1, '今日を含む学期が1つ解決される');

process.exitCode = h.report();
```

- `h.G` … 読み込んだ GAS の**関数**が生えている場所
- `h.value('WORK_DAYS')` … トップレベルの `const` を読むときはこちら。
  `.gs` の `const` は GAS ではグローバルだが Node の `vm` では**コンテキストのプロパティにならない**ため、
  `h.G.WORK_DAYS` は `undefined` になる（同じコンテキスト内の関数からは見えるので呼び出しには影響しない）
- `h.db` / `h.add(sheet, row)` / `h.row(sheet, col, val)` … メモリ上のシート
- `h.notifyLog` / `h.notifiesOf(kind)` … 送られた（ことになっている）通知
- `h.time` … `today()` / `dateIn(days)` / `hhmmIn(minutes)` / `dayJp()`
- `h.stub({...})` … スタブの追加・上書き（`load` の**前**に呼ぶ）
- `h.check(cond, msg)` / `h.section(title)` / `h.report()`

外部送信（`UrlFetchApp`）は呼ばれたら例外になるようにしてある。実送信は絶対に起きない。

> ⚠️ **シート列を増やしたら `gas-harness.js` の `DEFAULT_HEADERS` も更新すること。**
> ハーネスは本番の `writeRowUpdates_` と同じく「ヘッダーに無い列は書かない」挙動を再現するため、
> ここが古いと**本番では書けるのに手元では書けない**（あるいはその逆）という食い違いが出る。
