"""Webhook 案内の画像を、注釈つきで画面に埋め込める大きさへ整える。

マイページの本文幅は 720px。スマホでも見るので横幅はそれ以下で足りる。
注釈（枠＋矢印）は縮小後に描く。線の太さを最終サイズ基準で決められるため。
減色はそのあと。ベタ塗りの注釈色はパレット化してもにじまない。

座標は**最終画像に対する割合（0〜1）**で書く。元画像の解像度が変わっても効く。
"""
import io, os, base64, math
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
SRC = os.path.join(ROOT, 'tmp-img')
OUT = os.path.join(HERE, 'img-out')
os.makedirs(OUT, exist_ok=True)

MAX_W = 640
MARK = (230, 60, 50)        # 注釈の色（Google の UI に無い赤）
MARK_W = 3

S = 'スクリーンショット 2026-09-28 '

# (元ファイル, 出力名, 切り出し, [注釈...])
#
#   注釈 = {'box': (x0,y0,x1,y1) …囲む枠（画像に対する割合）
#           'arrow': (始点x, 始点y)  …押す場所が1つだけの画像。空白から枠へ引く
#           'n': 番号, 'at': 角      …押す場所が複数の画像。枠の角に番号を置く
#
# 矢印とバッジは併用しない。番号付きの画像は押す場所が詰まっていて、
# 矢印を引くと必ずメニューの文字を横切る（実際そうなった）。
PLAN = [
    (S + '093552.png', 'apps', None, [
        {'box': (0.567, 0.415, 0.693, 0.601), 'arrow': (0.30, 0.85)},
    ]),
    (S + '093634.png', 'chat', None, [
        {'box': (0.72, 0.53, 0.94, 0.65), 'arrow': (0.45, 0.80)},
    ]),
    (S + '095831.png', 'newspace', None, [
        {'box': (0.01, 0.11, 0.36, 0.21), 'n': 1, 'at': 'tl'},
        {'box': (0.38, 0.23, 0.96, 0.31), 'n': 2, 'at': 'tl'},
    ]),
    (S + '093814.png', 'create', None, [
        {'box': (0.16, 0.12, 0.98, 0.23), 'n': 1, 'at': 'tl'},
        {'box': (0.82, 0.88, 0.98, 0.98), 'n': 2, 'at': 'tl'},
    ]),
    (S + '093916.png', 'menu', (0, 0, 420, 700), [
        {'box': (0.14, 0.02, 0.72, 0.11), 'n': 1, 'at': 'tl'},
        {'box': (0.14, 0.44, 0.72, 0.52), 'n': 2, 'at': 'tl'},
    ]),
    (S + '093949.png', 'apps2', None, [
        {'box': (0.80, 0.78, 0.99, 0.93), 'arrow': (0.55, 0.62)},
    ]),
    (S + '094048.png', 'name', None, [
        {'box': (0.05, 0.28, 0.95, 0.44), 'n': 1, 'at': 'tl'},
        {'box': (0.80, 0.77, 0.96, 0.94), 'n': 2, 'at': 'tl'},
    ]),
    (S + '095810.png', 'url', None, [
        {'box': (0.955, 0.70, 0.995, 0.92), 'n': 1, 'at': 'tl'},
        {'box': (0.80, 0.14, 0.99, 0.33), 'n': 2, 'at': 'tl'},
    ]),
]


def rounded(d, box, color, w):
    try:
        d.rounded_rectangle(box, radius=8, outline=color, width=w)
    except AttributeError:
        d.rectangle(box, outline=color, width=w)


def arrow(d, start, box, color, w):
    """box のいちばん近い辺の中点へ向けて矢印を引く"""
    cx = (box[0] + box[2]) / 2
    cy = (box[1] + box[3]) / 2
    sx, sy = start
    # 枠の外側で止める（線が枠に食い込まないように）
    dx, dy = cx - sx, cy - sy
    dist = math.hypot(dx, dy) or 1
    ux, uy = dx / dist, dy / dist
    # 枠の境界までの距離をざっくり求める
    half_w, half_h = (box[2] - box[0]) / 2, (box[3] - box[1]) / 2
    t = min(half_w / abs(ux) if ux else 1e9, half_h / abs(uy) if uy else 1e9)
    ex, ey = cx - ux * (t + 6), cy - uy * (t + 6)
    d.line([sx, sy, ex, ey], fill=color, width=w)
    # 矢じり
    head = 11
    ang = math.atan2(ey - sy, ex - sx)
    for a in (ang + math.radians(150), ang - math.radians(150)):
        d.line([ex, ey, ex + head * math.cos(a), ey + head * math.sin(a)], fill=color, width=w)


def badge(d, pos, n, color, size):
    """番号バッジ。画像の外へ出ないよう位置を内側へ寄せる"""
    r = 11
    W, H = size
    x = min(max(pos[0], r + 1), W - r - 1)
    y = min(max(pos[1], r + 1), H - r - 1)
    d.ellipse([x - r, y - r, x + r, y + r], fill=color)
    d.text((x - 3, y - 7), str(n), fill=(255, 255, 255))


def corner(box, at):
    x0, y0, x1, y1 = box
    return {'tl': (x0, y0), 'tr': (x1, y0), 'bl': (x0, y1), 'br': (x1, y1)}[at]


total = 0
print(f'{"名前":<10}{"寸法":>12}{"容量":>10}')
for src, name, crop, marks in PLAN:
    im = Image.open(os.path.join(SRC, src)).convert('RGB')
    if crop:
        im = im.crop(crop)
    if im.width > MAX_W:
        im = im.resize((MAX_W, round(im.height * MAX_W / im.width)), Image.LANCZOS)

    d = ImageDraw.Draw(im)
    W, H = im.size
    for m in marks:
        box = (m['box'][0] * W, m['box'][1] * H, m['box'][2] * W, m['box'][3] * H)
        rounded(d, box, MARK, MARK_W)
        if 'arrow' in m:
            arrow(d, (m['arrow'][0] * W, m['arrow'][1] * H), box, MARK, MARK_W)
        if 'n' in m:
            badge(d, corner(box, m.get('at', 'tl')), m['n'], MARK, (W, H))

    im = im.quantize(colors=128, method=Image.MEDIANCUT)
    buf = io.BytesIO()
    im.save(buf, format='PNG', optimize=True)
    data = buf.getvalue()
    open(os.path.join(OUT, name + '.png'), 'wb').write(data)
    total += len(base64.b64encode(data))
    print(f'{name:<10}{f"{im.width}x{im.height}":>12}{len(data)/1024:>8.0f}KB')

print()
print(f'base64 にしたときの合計: {total/1024:.0f}KB')
