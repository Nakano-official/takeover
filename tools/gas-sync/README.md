# GAS同期用ツール

`auth-project.json` と `auth/appsscript.json` はclaspのログイン時に要求する権限を指定するためだけのファイルです。
**このフォルダを対象に push しないでください。** 本番のマニフェストではありません。

認証を開始するコマンド（このフォルダで実行）：

```powershell
node node_modules/@google/clasp/build/src/index.js --project auth-project.json login --use-project-scopes
```

認証後は、本番プロジェクトを別の作業フォルダへ取得してバックアップし、
USB中継の追加部分だけを反映します。取得前のローカル src 全体をそのままpushしません。
claspはプロジェクト全体を置き換えるため、アップロード直前にもリモートの変更有無を確認します。
本番のアクセス設定は大学ドメイン限定を維持します。
