# GAS同期用ツール

clasp のログイン時に**要求する権限（OAuthスコープ）を指定するためだけ**のフォルダ。
`auth/appsscript.json` がそのスコープ定義で、本番のマニフェストではない。

## ⚠️ このフォルダで本番のスクリプトIDを使わないこと

`auth/` の中身は `appsscript.json` **1ファイルだけ**。
`auth-project.json` の `scriptId` に**本番**を書いてしまうと、このフォルダで
`clasp push` を1回打っただけで**本番プロジェクトの中身が `appsscript.json` 1つに置き換わる**
（`src/` の全ファイルが消える）。`rootDir` が `auth` を指しているため、警告も出ない。

そのため `auth-project.json` は**リポジトリに入れない**（`.gitignore` 済み）。
`.clasp.json` をコミットしないのと同じ理由で、スクリプトIDは各自がローカルに置く。

## 使い方

1. `auth-project.example.json` を `auth-project.json` にコピーする
2. `scriptId` に**認証用の使い捨てプロジェクトのID**を入れる（本番は入れない）
3. このフォルダで認証を開始する

```powershell
node node_modules/@google/clasp/build/src/index.js --project auth-project.json login --use-project-scopes
```

## 認証後

本番プロジェクトを**別の作業フォルダ**へ取得してバックアップし、必要な差分だけを反映する。
取得前のローカル `src` 全体をそのまま push しない。**clasp はプロジェクト全体を置き換える**ので、
アップロード直前にリモートの変更有無を必ず確認すること
（`clasp push` はローカルに無いファイルをリモートから削除する。実際に一度これで
`device-relay.html` が消えている。詳細は changelog 2026-09-12）。

本番のアクセス設定は大学ドメイン限定を維持する。
デプロイは職員アカウントのみが行う（decisions.md D29）。
