# help-images — Webhook 案内の画像を作り直す（D46）

`src/help-webhook.html`（マイページと利用登録から include している Webhook の作り方）に
埋め込む画像を組み立てるスクリプト。ほかの `tools/` と同じく **`clasp push` の対象外**。

画像は HTML の中に base64 で埋め込む。GAS の HtmlService は `src/` のファイルしか配信できず、
`docs/img/` に置いてもブラウザからは見えない。Drive の共有リンクは閲覧者ごとの共有設定に
左右される（学生が「アクセス権が必要です」になる）ので使わない。
→ **職員や学生に画像を別途共有する必要はない。** 画面を開けば出る。

## 元画像はリポジトリに入っていない

スクリーンショットは `tmp-img/`（`.gitignore` の `*.png` で除外）に置く。
切り落としている部分に氏名が写っているものがあるため、**このリポジトリは Public なので
元画像はコミットしない**。`prep_img.py` の `crop` で落としてから埋め込んでいる。

つまり **`src/help-webhook.html` が唯一の成果物**で、作り直すには元画像を撮り直すか、
撮った人から受け取る必要がある。

## 手順

Pillow が要る（`tools/` で唯一 Node ではなく Python）。

```
pip install pillow
python tools/help-images/prep_img.py     # tmp-img/ → tools/help-images/img-out/
python tools/help-images/build_help.py   # img-out/ → src/help-webhook.html
node tools/run-all.js                    # 画面が壊れていないか
```

## どこを直すか

- **画像の差し替え・注釈の位置** … `prep_img.py` の `PLAN`
- **手順の文章・並び** … `build_help.py` の `STEPS`

`PLAN` の座標は**最終画像に対する割合（0〜1）**で書く。元画像の解像度が変わっても効くため。
ズレていたら数字だけ直して作り直す。

注釈の決まり（見た目を揃えるため）：

| 押す場所 | 付けるもの |
|---|---|
| 1つだけ | 枠＋矢印（空白から引く） |
| 2つ以上 | 枠＋枠の角に番号。**矢印は引かない** |

番号付きで矢印を引くと、押す場所が詰まっていて必ずメニューの文字を横切る
（「スペースをブラウジング」「このスペースのリンクをコピー」の上を通った）。

## 容量

1枚ずつ base64 にして HTML に入れるので、増やすほど画面が重くなる。
`prep_img.py` は横幅 640px へ縮小し、128色に減色して 700KB → 180KB に収めている。
実行すると合計が表示されるので、**200KB 程度を超えないように**枚数と大きさを調整する。
