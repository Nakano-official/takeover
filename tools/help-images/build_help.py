"""src/help-webhook.html を組み立てる（D46）。

画像は base64 で埋め込む。GAS の HtmlService は `src/` のファイルしか配信できず、
`docs/img/` に置いてもブラウザからは見えないため。Drive の共有リンクは
大学ドメインの共有設定に左右されるので使わない。
"""
import io, os, base64

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
IMG = os.path.join(HERE, 'img-out')
OUT = os.path.join(ROOT, 'src', 'help-webhook.html')


def img(name, alt):
    data = base64.b64encode(open(os.path.join(IMG, name + '.png'), 'rb').read()).decode()
    return ('<img class="hw-shot" alt="' + alt + '" '
            'src="data:image/png;base64,' + data + '">')


STEPS = [
    ('Google Chat を開く',
     'ブラウザで Google のページを開き、右上の<b>アプリ一覧（⋮⋮⋮）</b>を押します。'
     '大学のアカウントでログインしておいてください。',
     'apps', 'ブラウザ右上のアプリ一覧ボタン'),
    (None,
     '一覧から<b>「チャット」</b>を選びます。'
     '（<a href="https://chat.google.com" target="_blank" rel="noopener">chat.google.com</a> を'
     '直接開いても同じです）',
     'chat', 'Googleアプリ一覧の中のチャット'),
    ('自分用のスペースを作る',
     '<b>「新しいチャット」→「スペースを作成」</b>を選びます。'
     '<b>DM（ダイレクトメッセージ）では作れません。</b>',
     'newspace', '新しいチャットのメニュー'),
    (None,
     '名前を付けて<b>「作成」</b>。名前は何でもかまいません。'
     '<b>自分ひとりのままでOK</b>で、他の人を追加する必要はありません。',
     'create', 'スペースを作成のダイアログ'),
    ('Webhook を発行する',
     'スペース名の<b>「∨」→「アプリと統合」</b>を開きます。',
     'menu', 'スペース名のメニュー'),
    (None,
     '<b>「＋ Webhook を追加」</b>を押します。',
     'apps2', 'アプリと統合の画面'),
    (None,
     '名前を入れて<b>「保存」</b>。アバターのURLは空のままで大丈夫です。',
     'name', '着信Webhookの名前入力'),
    ('URL をコピーして貼る',
     '一覧に出てきた Webhook の<b>「⋮」→「リンクをコピー」</b>を押し、この画面の'
     '<b>「Google Chat の通知先URL」</b>に貼り付けて保存してください。',
     'url', 'Webhookの一覧とリンクをコピーのメニュー'),
]

parts = []
n = 0
for title, body, shot, alt in STEPS:
    if title:
        n += 1
        parts.append('<h4 class="hw-h"><span class="hw-n">' + str(n) + '</span>' + title + '</h4>')
    parts.append('<p class="hw-p">' + body + '</p>')
    parts.append(img(shot, alt))

html = '''<!--
  Google Chat の通知先URL（Webhook）の作り方（D46）

  マイページ（mypage）と利用登録の申請（signup）の**両方から include する**。
  同じ手順を2か所に書くと必ずずれるので、ここを唯一の出所にする。

  画像は base64 で埋め込んでいる。GAS の HtmlService は src/ のファイルしか配信できず、
  docs/img/ に置いてもブラウザからは見えないため。Drive の共有リンクは大学ドメインの
  共有設定に左右されるので使わない。

  画像の元ファイルは tmp-img/（.gitignore 済み）。差し替えるときは
  scratchpad の prep_img.py / build_help.py を使って作り直す。
-->
<style>
  .hw { border: 1px solid var(--border); border-radius: var(--radius);
        background: var(--surface-alt); margin: 10px 0 0; }
  .hw > summary { cursor: pointer; padding: 10px 14px; font-size: .88rem;
                  font-weight: 700; color: var(--brand-ink); list-style: none; }
  .hw > summary::-webkit-details-marker { display: none; }
  .hw > summary::before { content: '▸ '; }
  .hw[open] > summary::before { content: '▾ '; }
  .hw > summary:hover { background: var(--brand-soft); border-radius: var(--radius); }
  .hw-body { padding: 4px 14px 14px; }
  .hw-h { font-size: .92rem; margin: 16px 0 6px; display: flex; align-items: center; gap: 8px; }
  .hw-h:first-child { margin-top: 4px; }
  .hw-n { display: inline-flex; align-items: center; justify-content: center;
          width: 22px; height: 22px; border-radius: 50%; background: var(--brand);
          color: #fff; font-size: .78rem; flex: 0 0 auto; }
  .hw-p { font-size: .85rem; line-height: 1.75; margin: 0 0 8px; color: var(--text); }
  .hw-shot { display: block; max-width: 100%; height: auto; margin: 0 0 14px;
             border: 1px solid var(--border-strong); border-radius: var(--radius-sm); }
  .hw-note { font-size: .82rem; line-height: 1.7; margin: 14px 0 0; padding: 10px 12px;
             border-radius: var(--radius-sm); background: var(--warn-bg); color: var(--warn); }
</style>

<details class="hw">
  <summary>通知先URLの作り方を見る（PCで一度だけ・所要3分）</summary>
  <div class="hw-body">
    <p class="hw-p">代行のお願いは、ここで作るあなた専用の場所に届きます。
      <b>登録しないと代行依頼の通知が届きません。</b></p>
''' + '\n    '.join(parts) + '''
    <p class="hw-note">⚠️ このURLは<b>あなた宛の通知の鍵</b>です。他の人に教えないでください。
      もし他の人に知られたら、同じ画面から Webhook を削除して作り直し、
      新しいURLをここに貼り直してください。</p>
  </div>
</details>
'''

io.open(OUT, 'w', encoding='utf-8', newline='\n').write(html)
print('作成: src/help-webhook.html', round(len(html) / 1024), 'KB')
