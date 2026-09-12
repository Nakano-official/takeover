# 構築・引き継ぎ手順（管理者向け・最初に一度だけ）

このシステムを立ち上げて職員に「**URLを1本渡すだけ**」の状態にするための手順。
ここに書く作業は**構築者（開発担当）が一度だけ**行う。職員の日常運用は [`operations.md`](operations.md) を参照。

> ⚠️ **所有アカウントが最重要**：GASのデプロイとトリガーは「作成したアカウント」で動く。
> 個人/学生アカウントで構築すると、卒業・退職でアカウントが消えた瞬間に全停止する。
> **支援室（部署）のGoogleアカウント、または恒久的な職員アカウントで所有・デプロイ・トリガー設置**すること。
> 構築は代行してよいが、最終的な所有者を部署アカウントにする。

---

## 1. 本番セットアップ

### 1.1 空のDBを作る
1. GAS エディタで **`setupSpreadsheetsEmpty`** を実行（ヘッダーのみ＋時限マスタで2つのDBを生成）。
   ※ `setupSpreadsheets`（ダミー入り）と間違えないこと。
2. ログに出る2つのスプレッドシートIDを控える。

### 1.2 スクリプトプロパティを登録
「プロジェクトの設定 → スクリプト プロパティ」で登録（**コードに直書きしない**）。

| キー | 値 |
|---|---|
| `SPREADSHEET_ID` | メインDB のID |
| `CONTACTS_SPREADSHEET_ID` | 連絡先DB のID |
| `CALENDAR_ID` | 実際の共有カレンダーのID |
| `CHAT_WEBHOOK_URL` | 職員スペースの Incoming Webhook URL（→ 3章） |
| `DEVICE_TOKEN` | M5Stack 端末を使う場合のみ（任意） |

### 1.3 連絡先DBを「職員のみ」に共有
連絡先DB（メール・電話・Webhook）は**スプレッドシートの共有設定で職員のみ**に制限。学生には共有しない。

### 1.4 最初の職員を登録
空のDBには誰もいないので、まず1人入れる。
- メインDB `staffs`：`staff_id`／`name`／`role`＝**職員**
- 連絡先DB `contacts`：同じ `staff_id`／`name`／`email`＝その職員の大学アドレス

### 1.5 Web アプリをデプロイ
「デプロイ → 新しいデプロイ → ウェブアプリ」：
- **実行するユーザー：自分（＝部署アカウント）**
- **アクセスできるユーザー：大学ドメインのアカウント**

発行URL（`…/exec`）が**職員・学生に配るURL**。
※ M5Stack 端末（`?device=alert`）を使う場合のみアクセスを「全員」にする（画面はコード側のロール判定で保護）。

---

## 2. データ投入の自動化（職員の手作業をなくす）

職員がスプレッドシートを触らずに済むよう、データはフォーム＋トリガーで流し込む。

- **連絡先フォーム**（氏名・メール・電話・Chat Webhook URL）→ `contacts`
- **空きコマフォーム**（氏名 or メール・空きコマ `月1,火3` 形式）→ `staffs.available_slots`
- 各フォームに `onFormSubmit` トリガーを設置すると、**送信した瞬間に自動でシートへ反映**される
  （※取り込み関数・トリガーは今後実装。未設置の間は構築者が反映を代行する）

> 連絡先（静的・秘密）と空きコマ（クォーター毎に変動）は**フォームを分ける**。

> ### ⚠️ `clasp push` だけでは `/exec` に反映されない
>
> **push はコードを更新するだけで、公開URL（`/exec`）が配信するのは「デプロイしたバージョン」です。**
> デプロイを更新しない限り、職員・学生の画面は古いままになります。エラーは出ません。
>
> 確認と更新はこうします。
>
> ```
> npx clasp deployments        # @HEAD（テスト用）と @46 のようにバージョンが出る
> ```
>
> - **検証中だけ最新を見たい** … GASエディタ「デプロイ → デプロイをテスト」の `/dev` URL。
>   常に最新を配信します。ただし**スクリプトの編集権限があるアカウントしか開けません**
>   （学生アカウントでの通し確認には使えません）。
> - **本番URLを最新にする** … 「デプロイ → デプロイを管理 → 鉛筆アイコン →
>   バージョン『新しいバージョン』→ デプロイ」。`/exec` の URL は変わりません。
>   **新規デプロイを作らないこと**（URLが変わり、配布済みのリンクが古いコードを指したままになります）。
>
> 画面の変更が反映されないときは、ブラウザのキャッシュ（Ctrl+Shift+R）より先にここを疑ってください。
> 時間割は `?page=home&debug=1` で開くと画面下に診断が出ます。**この枠が出なければ古いコードです。**

---

## 2.5 時間トリガーを登録する（締切検知・D22）

代行が決まらないまま締切（授業開始30分前）に達した欠員を検知し、職員へ「決着してください」を
通知する処理は**時間トリガー**で動く。これを入れないと、誰も承諾しなかった欠員について
**通知が一切出ない**（欠勤連絡の時点でしか締切を判定できないため）。

1. GASエディタで `migrateAddVacancyCloseNotifiedAt()` を1回実行する
   （既存DBに `vacancies.close_notified_at` 列を足す。新規 `setupSpreadsheetsEmpty` なら不要）。
2. `installTriggers()` を実行する（10分ごとに `closeExpiredRecruits` が走るようになる）。
3. `listTriggers()` で登録内容と**実行者アカウント**を確認する。

> ⚠️ **トリガーはインストールした人のアカウントで動く**。Web App の「実行するユーザー」とは
> **別管理**なので、担当者が代わったら新しい担当者が `installTriggers()` を実行し直すこと。
> 片方だけ引き継ぐと「画面は動くのに締切通知だけ来ない」という気づきにくい壊れ方をする。

---

## 3. 職員スペースの Webhook（全体通知用）

1. PC で [chat.google.com](https://chat.google.com) → スペースを作成（職員が見るスペース）。
2. スペース名 →「アプリと連携」→「Webhook を追加」→ 名前を付けて保存 → URLをコピー。
3. そのURLをスクリプトプロパティ `CHAT_WEBHOOK_URL` に登録。
4. GAS の `testNotify` で疎通確認（Chatに届けばOK）。

> スタッフ個別のWebhookは学生本人が作成し、連絡先フォームで集める（学生向け案内は operations.md 付録）。

---

## 4. go-live チェックリスト

- [ ] `setupSpreadsheetsEmpty` で空DBを作成し、ID2件をプロパティに登録した
- [ ] `CALENDAR_ID` に実カレンダーを設定した
- [ ] 連絡先DBを**職員のみ**に共有した
- [ ] 最初の職員を `staffs`・`contacts` に登録した
- [ ] 職員スペースの `CHAT_WEBHOOK_URL` を設定し `testNotify` が届いた
- [ ] `installTriggers()` を実行し、`listTriggers()` に `closeExpiredRecruits` が出た（締切検知）
- [ ] フォーム（連絡先・空きコマ）を用意し、取り込み経路を確認した
- [ ] **所有者が部署アカウント**になっている（個人アカウント所有でない）
- [ ] 数名の実アカウントでログイン・通知の通しテストをした
- [ ] その後にURLを全員へ周知した

---

## 5. 動作確認

### 5.1 手元（push する前・Node）

```
node tools/run-all.js    # 構文チェック＋全ロジック検証（数秒）
```

`npm install` は不要（Node標準モジュールのみ）。`tools/` は `clasp push` の対象外なので
本番には送られない。詳細は `tools/README.md`。

### 5.2 GASエディタの確認用関数

`src/Tests.gs`（疎通・診断）と `src/E2E.gs`（通し確認）にまとめてある。
ここにあるのは **GAS でしか確かめられないもの**だけで、ロジックは 5.1 が受け持つ。

| 関数 | ある場所 | 確認できること |
|---|---|---|
| `whoAmI` | code.js | ログイン特定・ロール判定 |
| `testSheets` | Tests.gs | スプレッドシートの読み書き（テスト行を書いて消す） |
| `testNotify` | Tests.gs | 職員スペースへの Chat 送信（**実送信あり**） |
| `testNotifyVacancy` | Tests.gs | 最新の欠員で実通知（**実送信あり**） |
| `testVacancy` | Tests.gs | 実DBでの候補スクリーニング（なぜ候補に出ないかの診断） |
| `testRespond` | Tests.gs | 実DBの最新欠員で回答画面のサーバー関数を実行 |
| `testDevicePoll` | Tests.gs | M5Stack 端末エンドポイント |
| `testCalendarConnection` | Tests.gs | カレンダー連携（機能Bの基盤） |
| `listTriggers` | Triggers.gs | 時間トリガーの登録状況と実行者アカウント |
| `runDeadlineCheckNow` | Triggers.gs | 締切検知をその場で1回実行（**実送信あり**） |
| `e2eVacancyFlow` | E2E.gs | 欠員補充の通し確認（先着競合・再オープン・実LockService） |
| `e2eDeadlineFlow` | E2E.gs | 締切・募集クローズの通し確認（D21/D22） |

> `e2e*` は一時データを作って `finally` で消す。**ダミーDBに向いていることを確認してから**実行する。

---

## 付録A：デモ環境（動作確認用・ダミーデータ）

実データを使わず動きだけ見たいとき。
1. **`setupSpreadsheets`** を実行（架空データ入りでDB作成）。
2. ID2件をプロパティに登録。
3. 連絡先DB `contacts` の `S001` の `email` を自分のアドレスに変更 → 職員としてログイン。

> デモと本番は**別のスプレッドシート**で運用すること。
> 既存DBへの列追加マイグレーションは `migrateCoursesColumns()` / `migrateStaffsColumns()` /
> `migrateStaffsPersonalCode()` / `migrateAddTermsSheet()` / `migratePeriodsTextFormat()` /
> `migrateAddVacancyCloseNotifiedAt()`（D22）/ `migrateAddCourseDate()`（D27・単発コマ）。
> いずれも冪等で、何度実行しても安全。

---

## 付録B：構築時のスクリーンショット（任意）

`docs/img/` に置き、必要なら各章に差し込む。**秘密情報（URL・ID・実名）は写さない**。

| ファイル名 | 場面 |
|---|---|
| `setup-empty-log.png` | `setupSpreadsheetsEmpty` 実行ログ |
| `script-properties.png` | スクリプトプロパティ登録 |
| `contacts-share.png` | 連絡先DBの共有設定（職員のみ） |
| `deploy-settings.png` | デプロイ設定 |
| `chat-webhook-add.png` | Webhook を追加 |
| `chat-test-message.png` | 届いたテスト通知 |
