# システムアーキテクチャ設計

**プロジェクト**: 龍谷大学 障がい学生支援室 シフト管理・業務DXシステム
**作成日**: 2026-06-11
**最終更新**: 2026-09-23（実装に合わせて全面改訂・D43）

> この文書が**シート定義と画面構成の正**。実装を変えたらここを直す。
> ただし更新は**設計が固まった区切りごと**に行う（D43）。日々の経緯は
> [`decisions.md`](decisions.md)、未対応は [`backlog.md`](backlog.md) に都度書く。

> ⚠️ **今回のリリースは機能A（欠員補充）だけ。** 機能B（勤怠整合性チェック）は
> `future/feature-b/` へ退避しており、**本番のGASプロジェクトに存在しない**（D41）。
> この文書も機能Aだけを書く。

---

## 1. 画面一覧

| 画面 | `page` | 対象 | 主な用途 |
|---|---|---|---|
| シフト確認（時間割） | `home` | 全体 | 週ごとの時間割・欠員・代行の確認。既定の画面 |
| 欠勤連絡 | `absence` | 学生スタッフ | 自分の担当コマの欠勤を出す |
| シフト入力 | `input` | 職員 | 時間割（コマ）の登録・修正 |
| 欠員補充管理 | `manage` | 職員 | 回答状況の確認・代行確定・決着 |
| スタッフ名簿 | `roster` | 職員 | 登録済みスタッフが**使える状態か**の確認（D30） |
| 利用登録の承認 | `approvals` | 職員 | 名簿に無いアカウントからの申請を承認／却下（D28） |
| 学期設定 | `terms` | 職員 | 年度ごとの学期の開始日・終了日（D19） |
| 代行依頼への回答 | `respond` | 学生スタッフ | 承諾／辞退（通知のリンクから開く） |
| マイページ | `mypage` | 全体 | 本人が連絡先・対応できる業務・空きコマを直す（D28/D31/D32） |
| 利用登録の申請 | `signup` | 未登録者 | **名簿に無いアカウントでも開ける唯一の画面**（D28） |
| USB欠員通知 | `deviceRelay` | 職員 | M5Stack への中継。開きっぱなしにする（ナビには出ない） |

- ナビに出るのは `home` / `absence` / `input` / `manage` / `roster` / `approvals` / `terms`。
  `respond` / `mypage` / `signup` / `deviceRelay` は出さない（`code.js` の `NAV_PAGES`）。
- マイページへは**右上のユーザー名**から入る。ナビの項目を増やさないため。

---

## 2. アーキテクチャ概要

Google Sheets を中心（Single Source of Truth）に置き、各画面は独立して読み書きする。画面同士は直接通信しない。

```mermaid
flowchart LR
  In["シフト入力"] -->|書き込み| Sheets[("Google Sheets")]
  Ab["欠勤連絡"] -->|書き込み| Sheets
  Re["回答"] -->|書き込み| Sheets
  Mg["欠員補充管理"] -->|書き込み| Sheets
  My["マイページ"] -->|書き込み| Sheets
  Ap["利用登録の承認"] -->|書き込み| Sheets
  Tm["学期設定"] -->|書き込み| Sheets
  Sheets -->|読み込み| Home["シフト確認"]
  Sheets -->|読み込み| Ro["スタッフ名簿"]
  Trg["時間トリガー<br/>10分ごと"] -->|締切を検知| Sheets
```

**シートへのアクセスは必ず `Sheets.gs` を経由する**（`readRows` / `findRow` / `updateRow` /
`claimIfEmpty` 等）。1実行の間だけ読み取りをキャッシュし、整合性は「ロックを跨いだら捨てる」
（`withLock_`）で担保している。直接 `SpreadsheetApp` で書いたら `invalidateSheetCache_()` を呼ぶ。

> 全体構成（利用者・GAS・外部連携を含む俯瞰図）は [`README.md`](../README.md#-アーキテクチャ) を参照。

---

## 3. 各画面の詳細

### シフト入力（職員限定・`input`）

- 学期の初めに、履修登録から確定した時間割（コマ）を登録する
- **担当は未定のままでよい**（D38）。授業は学期開始前に確定するが、担当の割り当ては
  学生の空きコマが集まってから決まる。実務の順番に合わせている
- **介助のコマは、その授業の前後の移動介助も同時に作れる**（D34/D35）。
  既定でオンで、要らなければ外す
- 「この日だけ」を選ぶと単発コマ（特別授業・説明会）になる（D27）
- 直接スプレッドシートを編集させない（カスタムUIのみ）
- 書き込み先：メインDB（courses）

### シフト確認＝時間割（全体公開・`home`）

**表示範囲を決める軸は「見ている週」だけ**（D37）。学期の絞り込みは無い。
遠い週へは週の範囲表示を押してカレンダーから飛ぶ。

```
[◀ 前の週]  [ 9/14(月) 〜 9/20(日) ]  [次の週 ▶]  [今週へ]
                    ↑ 押すとカレンダー

時限        月        火        水        木        金        土
1限       [テイク]  [テイク]  [      ]  [ 介助 ]  [テイク]  [    ]
移動介助   ╌╌╌╌╌╌╌  ╌╌╌╌╌╌╌  ╌╌╌╌╌╌╌  [ 移動 ]  ╌╌╌╌╌╌╌  ╌╌╌╌   ← 細い帯
2限       [テイク]  [      ]  [ 介助 ]  [テイク]  [      ]  [    ]
```

- 週送りは**サーバー往復なし**。コマ・時限・学期は週で変わらないので先に全部渡し、
  週で変わる「欠員の重ね合わせ」だけを `course_id|日付` の索引で渡す（D23）
- 移動介助の枠は**予定が入っている週（スマホはその日）だけ**細い帯として出す（D33/D35）
- 絞り込みは利用者・スタッフ・内容（テイク/介助）と、マイビュー（自分の担当＋入れる募集中）
- 読み込み元：メインDB（staffs・courses・vacancies・periods・terms）

### 欠勤連絡（学生スタッフ・`absence`）

- 学生スタッフが欠勤を報告する。**自分が担当のコマしか出ない**
  （担当未定のコマは誰も出せない＝正しい挙動・D38）
- 送信後、GASが自動で以下を実行：
  1. vacancies シートに欠員を登録
  2. 人材プールから代行候補をスクリーニング
  3. Google Chat Webhook で候補者に通知送信
- **介助のコマは「授業＋前後の移動介助」のかたまりで出す**（D45）。前後の移動も同じ人の仕事なので、
  休むと一緒に欠員になる。**1回の欠勤連絡＝1つの募集＝1回の通知＝まとめて承諾**。
  - `vacancies` は枠の数だけ行ができるが、**同じ `group_id`** で束ねて1つの募集として扱う
  - 候補は**全部の枠に空きがある人だけ**（一部だけ入れる人は呼ばない）
  - 「この授業だけ休む」もできる。その場合は行1件・`group_id` は空（従来と同じ形）
- 書き込み先：メインDB（vacancies シート）

### 回答画面（学生スタッフ・候補者）

- 通知メッセージの「回答する」ボタンから開く（URL：`?page=respond&vacancy=<ID>`）
- 開いたユーザーを `Session.getActiveUser()` で特定する。URLに staff_id を含めないため、URLが他人に渡ってもなりすましはできない
- 承諾 / 辞退を選んで送信
- 承諾が通ると、**その場で確定まで行く**（先着自動確定・D1）。同じ `group_id` の欠員があれば
  まとめて同じ人で確定する（D45）
- 書き込み先：メインDB（responses・**vacancies**）

### 欠員補充管理（職員限定・`manage`）

- 欠員ごとの回答状況を一覧表示し、職員が決着させる
- **募集クローズ＝システム／決着＝職員**（D22）。締切（授業開始30分前・D21）に達しても
  システムは `result` を書かず、職員へ決着を求める。「1人テイク／職員対応」は人員配置の判断のため
- **辞退した候補の電話番号は出さない**（D25）。誰が反応済みかを見分けるため
- 再オープンは職員のみ（D26）
- 読み込み元：メインDB（vacancies・responses・courses）／連絡先DB（電話番号）
- 書き込み先：メインDB（vacancies）

### スタッフ名簿（職員限定・`roster`）

**読み取り専用**（D30）。名簿に行を作るのは承認だけ、本人の情報を直すのはマイページだけ、
という経路を崩さないため。一覧の主役は「登録されているか」ではなく**使える状態か**。

空きコマ未登録・本人未更新・通知先なし・電話なし・連絡先DBの行が無い、を数で出す。
どれも「登録は済んでいるのに実は動いていない」種類で、放っておくと誰も気づかない。

### マイページ（全体・`mypage`）

本人が直せるのは4つだけ（D28/D31/D32）。`staff_id` は必ず `Session` から取り、
画面から送られた id は見ない。

| 直せる | 直せない |
|---|---|
| `contacts.phone` / `contacts.webhook_url` | `staffs.name`（表示と突合に使う） |
| `staffs.available_slots` / `assist_slots` | `staffs.role`（自分を職員にできてしまう） |
| `staffs.skills`（テイク／介助） | |

- 空きコマは**業務ごとのタブ**で登録する（D32）。テイクと介助で空いている時間が違ううえ、
  介助には時限に収まらない枠（移動介助）が入るため
- **対応できる業務を全部外した保存は弾く**。空欄は「全対応」扱い（D9）なので、
  「どちらもできません」のつもりが逆に全依頼を受ける側に倒れる

### 利用登録の申請・承認（`signup` / `approvals`）

名簿に無いアカウントは `signup` へ回される（**未登録でも開ける唯一の画面**）。
申請は `registrations` に溜まるだけで、**承認するまで `staffs` / `contacts` には一切書かない**（D28）。
`role` は申請者に選ばせず、承認時に職員が決める。

---

## 4. データフロー

「読み込み元」は**画面に出すために読むもの**と、**通知を送るために読むもの**の両方を含む。
後者は画面には出ないが、連絡先DB（個人情報）を触るので分けて書く。

| 画面 | 読み込み元 | 書き込み先 |
|---|---|---|
| シフト確認（時間割） | メインDB（courses・staffs・vacancies・periods・terms） | — |
| シフト入力 | メインDB（courses・staffs・periods・terms・**vacancies**） | メインDB（courses） |
| 欠勤連絡 | メインDB（courses・periods・**staffs**）／**連絡先DB（webhook_url・通知用）** | メインDB（vacancies） |
| 代行依頼への回答 | メインDB（vacancies・courses・responses・**staffs**）／**連絡先DB（webhook_url・通知用）** | メインDB（responses・vacancies） |
| 欠員補充管理 | メインDB（vacancies・responses・courses・staffs）／連絡先DB（phone・webhook_url） | メインDB（vacancies） |
| スタッフ名簿 | メインDB（staffs・courses）／連絡先DB（contacts・registrations） | — |
| マイページ | メインDB（staffs・periods・**courses**）／連絡先DB（contacts） | メインDB（staffs）／連絡先DB（contacts） |
| 利用登録の申請 | メインDB（**staffs・periods**）／連絡先DB（contacts・registrations） | 連絡先DB（registrations） |
| 利用登録の承認 | 連絡先DB（registrations） | メインDB（staffs）／連絡先DB（contacts・registrations） |
| 学期設定 | メインDB（terms・courses） | メインDB（terms） |
| 時間トリガー（10分ごと） | メインDB（vacancies・courses・periods・staffs）／**連絡先DB（webhook_url・通知用）** | メインDB（vacancies） |

読みに行く理由が分かりにくいものだけ補足する。

- **シフト入力 → `vacancies`**：`updateCourse` / `deleteCourse` が**募集中の欠員が付いたコマを
  勝手に消させない**ために見る。消すと欠員が宙に浮く。
- **欠勤連絡 → `staffs`**：候補の抽出に空きコマ（`available_slots` / `assist_slots`）が要る。
- **マイページ → `courses`**：対応できる業務を**減らそうとしたとき**に、その業務で既に担当している
  コマがないか確かめて警告する（`droppedSkillWarning_`）。
- **利用登録の申請 → `periods`**：申請の時点で空きコマを選べるようにするため。
  `staffs` は同じ人が二重に申請していないかの確認。

### 連絡先DB（個人情報）を触るのはどこか

**画面に出すのは3か所だけ**。

| 画面 | 何を出すか |
|---|---|
| 欠員補充管理 | 候補の**電話番号**（電話フォローを画面内で完結させるため・D11） |
| スタッフ名簿 | 氏名・電話と、**Webhook が登録済みかどうか**（D30） |
| マイページ | **本人の**連絡先だけ |

**Webhook URL そのものは、どの画面にも出さない。** 届くかどうか（登録済みか）だけを返す。

一方で、**連絡先DBそのものは全リクエストで読まれる**。本人の特定
（`getCurrentUser_()`）がメール → `contacts` → `staff_id` の順で引くため（§7）。
さらに**通知を送るときも必ず読む**（`Notify.gs` の `buildWebhookMap_()`）。
欠勤連絡・回答・欠員補充管理・時間トリガーのどれから送っても同じ経路を通る。
画面には出ないが、**個人情報に触れる経路はここが一番多い**ので、
`Notify.gs` を変えるときは「読んだ Webhook URL をレスポンスやログに載せていないか」を必ず見る。

---

## 5. スプレッドシート構成

### データ構造（ER図）

`courses` を中心に、利用学生中心の時間割（D8）と欠員補充（vacancies/responses）が
`staff_id` / `course_id` / `vacancy_id` で結びつく。`contacts` のみ別ブック（連絡先DB）。

```mermaid
erDiagram
    staffs   ||--o{ courses    : "担当A/B（未定も可・D38）"
    periods  ||--o{ courses    : "時限（移動介助の枠も含む・D33）"
    terms    ||--o{ courses    : "学期（quarter が参照・D16）"
    courses  ||--o{ vacancies  : "欠員対象"
    staffs   ||--o{ vacancies  : "欠勤者/代行者"
    vacancies ||--o{ responses : "回答"
    staffs   ||--o{ responses  : "回答者"
    staffs   ||--|| contacts   : "連絡先(別DB)"
    registrations ||--o| staffs : "承認で採番(別DB)"

    staffs {
        string staff_id PK
        string name
        string role "職員 / 学生"
        string skills "テイク / 介助 / 両方・空=全対応(D9)"
        string available_slots "テイクの空きコマ 月1,火3 …(D32)"
        string assist_slots "介助の空きコマ 月移動前3 も入る(D32)"
        string personal_code "機能B用・退避中は未使用(D41)"
        datetime slots_updated_at "本人が出し直した日時・空=未更新(D28)"
    }
    courses {
        string course_id PK
        string quarter FK "terms.term_id"
        string day
        string period FK "periods.period"
        string support_type "テイク / 介助"
        string user_student "利用学生(被支援者)"
        string subject
        string instructor
        string room
        string staff_a_id FK "空=担当未定(D38)"
        string staff_b_id FK "介助は空"
        string note
        string date "単発コマの実施日・空=毎週(D27)"
    }
    vacancies {
        string vacancy_id PK
        date   date
        string course_id FK
        string absent_staff_id FK
        string notify_status
        string result "補充済/1人テイク/職員対応・空=未決着（書くのは職員・D22）"
        string substitute_staff_id FK
        datetime close_notified_at "締切到達を処理し職員へ決着要求した時刻（D22）"
        string group_id "かたまりの識別子・空=単独の欠員（D45）"
    }
    responses {
        string vacancy_id FK
        string staff_id FK
        string answer "承諾 / 辞退・辞退は取消不可(D25)"
        datetime answered_at
    }
    periods {
        string period PK "数字とは限らない。移動前3 など(D33)"
        string start_time
        string end_time
        string support_types "選べる業務・空=全業務(D32)"
        string label "画面の呼び名・空=「n限」(D33)"
    }
    terms {
        string term_id PK "2026-前期 / 2026-3Q"
        string system "semester / quarter"
        string start_date
        string end_date
    }
    contacts {
        string staff_id PK
        string name
        string email
        string phone
        string webhook_url "秘密・画面に出さない"
    }
    registrations {
        string registration_id PK
        string email "Session から取る"
        string name
        string phone
        string webhook_url
        string skills
        string slots
        string note
        string status "申請中 / 承認済 / 却下"
        datetime applied_at
        datetime decided_at
        string decided_by
        string staff_id "承認で採番"
        string reject_reason
    }
```

### 押さえておくべき決まりごと

ここを外すと**エラーが出ないまま壊れる**。

| 決まり | 外すとどうなるか |
|---|---|
| `periods` の**行の順番が時間割の並び順** | 並べ替えると時間割の並びが崩れる。構築時に確定させ運用では触らない（D40） |
| `periods.period` は**文字列キー**（`移動前3` など） | `assist_slots` に `月移動前3` の形で入る。**改名すると既存の空きコマがどのコマとも一致しない** |
| `vacancies.group_id` が同じ行は**1つの募集** | 空＝単独の欠員（従来どおり）。1件だけ確定させると、同じ欠勤の残りが未補充のまま取り残される（D45） |
| `skills` 空欄＝**全対応**（D9） | 「どちらもできません」のつもりで空にすると全依頼が飛ぶ |
| `available_slots` は**テイク用**（列名は互換で据え置き・D32） | 介助は `assist_slots`。混同すると片方の業務で候補0人 |
| 空の `staff_a_id` は**担当未定**（D38） | 候補抽出・決着提案・二重起用チェックはいずれも空を除外済み |
| `courses` の過去分は**消さない** | 時間割は終了が1年以上前の学期を送らないことで頭打ちにしている（D37） |

### メインDB（シフト管理）
- アクセス権限：職員 + GASスクリプト
- シート構成：`staffs` / `courses` / `vacancies` / `responses` / `periods` / `terms`

### 連絡先DB（個人情報）
- アクセス権限：**職員のみ**（本部確認済み・D3）
- シート構成：`contacts` / `registrations`
- Webhook URL は「知っていれば誰でも投稿できる」秘密情報のため、連絡先DBに置き、
  **画面にも返さない**（届くかどうかだけを返す・D30）
- `registrations` をここに置くのは、氏名・電話・Webhook を含むため（D28）

> どちらを開くかは `Sheets.gs` の `CONTACTS_DB_SHEETS` が決める。
> シート名を足すときはここにも足す。

---

## 6. 通知フロー

```mermaid
sequenceDiagram
    actor A as 欠勤するスタッフ
    participant App as GAS
    participant Main as メインDB
    participant Cont as 連絡先DB
    participant Chat as Google Chat
    actor C as 代行候補

    A->>App: 欠勤連絡
    App->>Main: 欠員を起票（vacancies）
    App->>Main: 空き＋スキルで候補をスクリーニング
    App->>Cont: 候補ごとの webhook_url を取得
    App->>Chat: 各候補の個人スペースへ個別依頼（回答リンク付き）
    Chat-->>C: 代行依頼（他スタッフには見えない）
    C->>App: 回答画面で承諾／辞退（responses に記録）
    App->>Main: 先着で確定（LockService・D1）
    App-->>Chat: 本人・他候補・職員へ結果通知
```

> **先着自動確定（D1）**：最初に承諾した候補へ自動で確定する。職員は通常介在せず、
> 誰も承諾しない等の例外時のみ欠員補充管理画面で「1人テイク／職員対応」に決着させる。
> 確定の Google カレンダー反映は今後実装（機能Aの完結・未着手）。

### 個別通知の仕組み（個人スペース + Incoming Webhook 方式）

スタッフ1人につき Chat スペースを1つ用意し、そこに Incoming Webhook を発行する。
GAS が「その人のスペースの Webhook」へ投稿することで、実質的な個別DMになる。
Chat API（Bot構築・GCP設定）は不要。

**スペースを作るのは本人**（職員ではない）。

1. 本人が**自分ひとりのスペース**を作る（他の人を追加しない。DMでは Webhook を発行できない）
2. 本人が Incoming Webhook を発行する
3. 本人が**マイページ**（または利用登録の申請）にURLを貼る → `contacts.webhook_url` に入る

作り方は**画面の中に入っている**（`help-webhook.html`・マイページと申請画面から `include`・D46）。
スクリーンショット付きで、職員が案内を配る必要はない。**PCのブラウザでしかできない**
（スマホの Chat アプリには「アプリと統合」が無い）が、できたあとの通知はスマホにも届く。

> **職員がスタッフごとにスペースを作る運用ではない**（初期の設計メモにはそう書いてあった）。
> スペースの所有者が本人でないと、本人が入れ替わるたび職員の作業が増える。
> いまは `staffs` / `contacts` に行を作るのは承認画面だけ、Webhook を入れるのは本人だけ、
> という経路に揃えてある（D28）。

**未登録は静かな未達になる。** `webhook_url` が空の候補者は通知がスキップされるが、
候補としては数えられる。「返事がない」のか「届いていない」のかが職員から見分けられないため、
**スタッフ名簿の「通知先なし」**で誰が未登録かを見えるようにしている（D30・backlog 12-2）。

本格導入が決まった場合は Chat API Bot（自動DM）への置き換えを検討する。

---

## 7. 実行権限とアクセス制御

### Web App のデプロイ設定

- `executeAs: USER_DEPLOYING` ＝ **最後にデプロイした人として動く**。学生スタッフが
  連絡先DBへの直接アクセス権を持たなくても通知処理が動く。
- `access: DOMAIN` ＝ 大学ドメインのアカウントのみ。
- **デプロイしてよいのは「スプレッドシート2つを開ける人」**（D42）。人の属性ではなく成立条件。
  開けない人がデプロイすると全画面が権限エラーで止まる（2026-09-12 に実際に起きた）。
- ⚠️ **引き継ぎ時は職員アカウントで最終デプロイする**。実行アカウントは最後にデプロイした人の
  ままなので、開発者名義のまま抜けると、そのアカウント停止時に止まる（setup.md 6章）。
- ⚠️ **トリガーは別管理**。`installTriggers()` は実行した人のアカウントで動く。
  片方だけ引き継ぐと「画面は動くのに締切通知だけ来ない」という壊れ方をする。

### ロール判定（必須）

**`executeAs: USER_DEPLOYING`＝全員の操作が「デプロイした人（職員）の権限」で走る。**
学生はスプレッドシートへの権限をひとつも持たないが、**スクリプト経由なら職員と同じ範囲に
届いてしまう**。したがって**データ保護の責任は全部コードのロール判定に載っている**。
シートの共有設定は守ってくれない。

本人の特定は `code.js` の `getCurrentUser_()` 1か所に集約してある。

1. `Session.getActiveUser().getEmail()` でログイン中のメールを取る
2. **連絡先DBの `contacts` をメールで引いて `staff_id` を得る**（大文字小文字は無視）
3. メインDBの `staffs` を `staff_id` で引いて `role`（職員 / 学生）を得る
4. `contacts` に無ければ `null` ＝ 未登録。`doGet` が利用登録の申請画面へ回す

- **職員限定のサーバー関数は先頭で `requireStaff_()` を呼ぶ**、という規約にしてある。
  `google.script.run` は画面を経由せず関数を直接叩けるので、**画面を出し分けるだけでは守れない**。
- 画面の出し分け（`PAGES` の `staffOnly`）と `doGet` のアクセス拒否は**同じ判定**を使う。
  表示と制御を二重管理にしない（D20）。
- ⚠️ **本人特定のたびに連絡先DBを読む。** つまり `contacts` は全リクエストで読まれる。
  1実行の間はキャッシュされる（`Sheets.gs`）ので往復は増えないが、
  「連絡先DBに触れるのは一部の画面だけ」ではない点は押さえておくこと。

### 同時書き込み対策

複数の候補者が同時に回答する場合があるため、シートへの書き込み処理には `LockService` を必ず使用する。

---

## 8. URL設計

Web App のURLは1本のみ（`/exec`）。`page` パラメータで `doGet` 内で画面を振り分ける。

| URL | 画面 | アクセス制限 |
|---|---|---|
| `?page=home`（既定） | シフト確認（時間割） | 全体 |
| `?page=absence` | 欠勤連絡 | 全体（職員のナビには出さない） |
| `?page=input` | シフト入力 | 職員のみ |
| `?page=manage` | 欠員補充管理 | 職員のみ |
| `?page=roster` | スタッフ名簿 | 職員のみ |
| `?page=approvals` | 利用登録の承認 | 職員のみ |
| `?page=terms` | 学期設定 | 職員のみ |
| `?page=respond&vacancy=<ID>` | 代行依頼への回答 | 全体（回答者は Session で特定） |
| `?page=mypage` | マイページ | 全体（右上のユーザー名から） |
| `?page=signup` | 利用登録の申請 | **名簿に無いアカウントでも開ける** |
| `?page=deviceRelay` | USB欠員通知（M5Stack 中継） | 職員のみ・ナビに出さない |

画面を足すときは `code.js` の `PAGES` に1行足す。ナビに出すなら `NAV_PAGES` にも足す。
それだけで全画面のナビに載り、`staffOnly` の出し分けと現在地ハイライトが効く（D20）。
