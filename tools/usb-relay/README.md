# 大学ログイン済みPCからUSBで欠員通知

公開範囲は「Ryukoku Universityの全員」のまま使用します。
職員として登録済みの大学アカウントで、専用のEdge画面にログインします。
GAS → ログイン済みEdge → PC中継プログラム → USB → M5Stack Basic の構成です。
スマホ設定・Wi-Fi設定・DEVICE_TOKENは、このUSB方式では使いません。

## 1. M5Stackへの書き込み

`device/usb_vacancy_alert/usb_vacancy_alert.ino` をArduino IDEで開きます。
ボードは M5Stack-Core-ESP32、ライブラリは M5Unified、書き込み速度は115200。
書き込み後は `USB VACANCY v1` / `WAITING FOR PC / GAS` と表示されます。
書き込みが終わったらシリアルモニタを閉じてください。

## 2. GASを更新（公開範囲を維持）

GASプロジェクトへ以下の変更を反映します。

- `src/Device.gs`：`getDeviceRelaySummary` 関数を追加（毎回 `requireStaff_()` で認可）。
- `src/code.js`：`PAGES` に `deviceRelay` の定義を追加。
- `src/device-relay.html`：新しいHTMLファイル。GASエディタでの名前は `device-relay`。

既存プロジェクトに未反映の変更がある場合は、ファイル全体を置き換えず上記の追加部分を反映します。
「デプロイ → デプロイを管理 → 編集 → 新しいバージョン」で更新します。
実行ユーザーは従来どおり、アクセスできるユーザーは「Ryukoku Universityの全員」を維持します。
これは手元のコード変更とは別作業です。自動では公開されません。

## 3. PC中継を開始

Windows、Node.js、Microsoft Edgeを使用します。
このフォルダの `start.ps1` を右クリックし「PowerShellで実行」します。
初回は中継に必要なPlaywrightをインストールします。
COMポート（前回はCOM7）とGASの `/exec` URLを入力します。
開いたEdgeで大学アカウントにログインしてください。
「USB欠員通知」画面と、コンソールの「GAS取得・USB受信確認済み」が成功の目印です。

USBだけ先に試す場合は、URL入力時に `TEST` と入力します。
本体が緑色の `USB TEST OK` になり短く鳴ります。実際の欠員情報は変更しません。

終了は中継コンソールで Ctrl+C。再開時は start.ps1 を実行します。
USBを抜いた場合やポートエラーが出た場合も、つなぎ直して中継を再起動してください。
書き込み中は中継を終了してください（同じCOMポートを同時使用できません）。

## 動作

- 初回取得を基準にし、既存の欠員では鳴りません。
- 取得完了から30秒後に再取得。新しい連番を検知すると赤画面＋ブザー1回。
- ボタンAで確認済み。欠員データ自体は変更しません。
- 取得失敗は接続待ち表示。90秒以上データが届かない場合も接続待ちへ切り替わります。
- PC起動・USB接続・中継プロセス・Edge画面の維持が必要です。スリープ中は通知できません。
- ログイン期限切れはEdgeで再ログインし、元の `?page=deviceRelay` を開き直します。
- 専用Edgeのログイン状態は `%LOCALAPPDATA%\ShiftUsbRelay\edge-profile` に保存します。
  通常のブラウザプロファイルやOneDrive内には保存しません。
- 大学の管理ポリシーで自動操作ブラウザの起動やログインが禁止されている場合は運用できません。
  制限回避は行わず、管理者と利用方式を確認してください。

## 検証

`npm test`：値の検証、URL制限、職員権限のない呼び出しの拒否。
大学SSO・実GAS・USB実機の通し動作は、上記の設定後に確認します。

参考：[GASの認証済み画面からの呼び出し](https://developers.google.com/apps-script/guides/html/communication)、
[Playwrightの専用ブラウザ起動](https://playwright.dev/docs/api/class-browsertype#browser-type-launch-persistent-context)。
