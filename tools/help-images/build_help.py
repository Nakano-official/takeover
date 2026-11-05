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
    return ('<img class="help-img" alt="' + alt + '" '
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
     '<b>他の設定はそのままで大丈夫です。</b>',
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
        if n:
            parts.append('</section>\n')
        n += 1
        parts.append('<section class="help-step" data-title="' + title + '">')
    parts.append('  <p>' + body + '</p>')
    parts.append('  ' + img(shot, alt))

HEAD = '''<!--
  ヘルプ：Google Chat の通知先URL（Webhook）の作り方（D46・D54）

  マイページと利用登録の申請の「詳細はこちら」から開く（ヘルプの一覧にも出る）。
  書き方は help-shift.html の冒頭を参照。

  画像だけは help-shots ではなく実際の Chat の画面なので、tools/help-images/ で作る。
  このファイルは tools/help-images/build_help.py が組み立てる。
-->
<section class="help-step" data-title="はじめに">
  <p>代行のお願いは、ここで作るあなた専用の場所に届きます。
    <b>登録しないと代行依頼の通知が届きません。</b></p>
  <div class="notice info">💻 <b>この作業はPCのブラウザでしかできません。</b>
    スマホの Chat アプリには、ここで使う「アプリと統合」の画面がありません。
    <b>PCでこのページを開き直して</b>、最後の貼り付けまで済ませてください（一度きりです）。
    できあがったあとの代行依頼は、スマホの Chat アプリにちゃんと届きます。</div>
</section>

'''
TAIL = '''  <div class="notice warn">⚠️ このURLは<b>あなた宛の通知の鍵</b>です。他の人に教えないでください。
    もし他の人に知られたら、同じ画面から Webhook を削除して作り直し、
    新しいURLをここに貼り直してください。</div>
</section>
'''

html = HEAD + '\n'.join(parts) + '\n' + TAIL
io.open(OUT, 'w', encoding='utf-8', newline='\n').write(html)
print('作成: src/help-webhook.html', round(len(html) / 1024), 'KB')
