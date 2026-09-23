# future/feature-b — 勤怠整合性チェック（今回のリリースには含めない）

**このディレクトリは `clasp push` の対象外**（`.clasp.json` の `rootDir` が `src`）。
ここにあるコードは**本番のGASプロジェクトに存在せず、職員の画面にも出ない**。

## なぜここにあるか

機能B（勤怠整合性チェック）は 2026-09-13 に「今は実装しない」と決まった（D41）。
ただし**今後作る予定はある**ので、消さずに置いてある。

- 実カレンダーとの照合は**一度も走らせていない**（合成データでの検証まで）
- 実CSVのヘッダー文字列は未確定（backlog 9-6）
- 今回のリリースは**機能A（欠員補充）だけ**で運用する

削除ではなく退避にしたのは、**GASエディタから開けてしまう状態を無くしたかった**から。
`src/` に置いたままだと本番へ push され、職員のナビに「整合性チェック」が出て、
動かない画面を開けてしまう。

## 中身

| ファイル | もとの場所 | 内容 |
|---|---|---|
| `Attendance.gs` | `src/` | 照合エンジン（CSV解析・15分丸め突合） |
| `check.html` | `src/` | 職員画面（CSVアップロード → 差分ハイライト） |
| `sim-attendance.js` | `tools/` | CSV解析と突合の検証（25件） |

## 戻すときの手順

1. 3ファイルをもとの場所へ戻す（`Attendance.gs` と `check.html` は `src/`、
   `sim-attendance.js` は `tools/`）。
2. `sim-attendance.js` の `require('./gas-harness')` のパスを確認する
   （`tools/` に戻せばそのまま動く）。
3. `src/code.js` の `PAGES` に次を足し、`NAV_PAGES` にも `'check'` を入れる。

   ```js
   check:   { file: 'check',   title: '整合性チェック',     staffOnly: true  },
   ```

4. **時刻ヘルパーは戻さない。** `hhmmToMin_` / `jstMinutes_` は
   `src/Util.gs` へ移してある（機能Aの締切判定が使っているため）。
   `Attendance.gs` からは消してあるので、そのまま `Util.gs` のものを使う。
   **戻すときに二重定義にしないこと**（`.gs` は連結されるので後勝ちで上書きされ、
   気づきにくい壊れ方をする）。
5. `node tools/run-all.js` を通してから push する。

## 再開するときに先に片付けること

- `staffs.personal_code`（勤怠CSVの突合キー）は**画面から消してある**（2026-09-13）。
  列はシートに残っているが、誰も入力できない。機能Bを再開するなら入力手段が要る。
- 実CSVのヘッダー文字列の確認（backlog 9-6）
- `personal_code` 未登録者の予定が「登録漏れ」に化ける偽陽性（backlog 9-1）
- カレンダーの氏名表記ゆれ（D7③）

詳細は `docs/spec/backlog.md` の 9-x と `docs/spec/decisions.md` の D2 / D14 / D41。
