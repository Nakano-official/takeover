/**
 * ヘルプの画像を自動で撮り、src/help-*.html に埋め込む（D51）
 *
 *     cd tools/help-shots && npm install   （初回だけ。playwright-core が入る）
 *     node tools/help-shots/shoot.js
 *
 * 1. render.js で架空データの画面を out/ に書き出す
 * 2. 手元の Chrome（Playwright）で開き、操作 → 枠・矢印・番号を描く → 必要な範囲だけ撮る（img/）
 * 3. src/help-*.html の data-shot="◯◯" の場所に、画像を base64 で埋め込む
 *
 * ■ 撮るものを足す・直すときは下の SHOTS だけを触る
 *   page    … render.js の SHOTS のキー（どの画面を開くか）
 *   device  … 'phone'（幅390）／'pc'（幅1280）。学生向けはスマホ、職員向けはPC
 *   steps   … 撮る前の操作（click: 押すもの）
 *   clip    … 写す範囲。並べた要素をすべて含む長方形を撮る
 *   marks   … 囲むもの。1つなら「枠＋矢印」、2つ以上なら「枠＋番号」（矢印は引かない）
 *             番号付きで矢印を引くと、押す場所が近いとき矢印が文字を横切るため（D46 と同じ決まり）
 *   指定は Playwright のセレクタ。見えている要素だけを相手にする（PC用の隠れた表なども同じ HTML にあるため）。
 *
 * ■ 容量
 *   1話題 200KB 程度まで（D46・D51）。最後に話題ごとの合計を出すので、超えたら clip を絞る。
 *
 * img/ は .gitignore 済み（*.jpg）。成果物は埋め込んだ src/help-*.html の方。
 */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const render = require('./render');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');
const IMG = path.join(__dirname, 'img');

const DEVICES = {
  phone: { viewport: { width: 390, height: 1200 }, deviceScaleFactor: 1.5 },
  pc: { viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 1 },
};
const JPEG_QUALITY = 72;
const MARK_COLOR = '#e5484d';

const card = (id) => 'button.cd[onclick*="' + id + '"]';
const day = (d) => 'button[data-day="' + d + '"]';

const SHOTS = [
  // ── シフトの見方（スマホ・学生）──
  { id: 'shift-1', page: 'student-home', device: 'phone',
    // 今週を見ていると「今週へ」が出ないので、次の週へ送ってから撮る
    steps: [{ click: '.weekbar button[aria-label="次の週"]' }],
    clip: ['.weekbar'],
    marks: [
      { sel: '.weekbar button[aria-label="前の週"]', n: 1 }, { sel: '#wkRange', n: 2 },
      { sel: '.weekbar button[aria-label="次の週"]', n: 3 }, { sel: '#wkNow', n: 4 },
    ] },
  { id: 'shift-2', page: 'student-home', device: 'phone',
    steps: [{ click: day('水') }],
    clip: [card('C30'), card('C32')],
    marks: [
      { sel: card('C30') + ' .st-vacant', n: 1 },
      { sel: card('C31') + ' .st-filled', n: 2 },
      { sel: card('C32') + ' .st-open', n: 3 },
    ] },
  { id: 'shift-3', page: 'student-home', device: 'phone',
    steps: [{ click: day('水') }, { click: card('C32') }],
    clip: ['#modal .sheet'], marks: [] },
  { id: 'shift-4', page: 'student-home', device: 'phone',
    steps: [{ click: '#myviewLabel' }],
    clip: ['.filterbar', 'button.cd >> nth=0'],
    marks: [{ sel: '#myviewLabel' }] },
  { id: 'shift-5', page: 'student-home', device: 'phone',
    steps: [{ click: '#fToggle' }],
    clip: ['.filters'], marks: [{ sel: '#toolbar' }] },

  // ── 欠勤を連絡する（スマホ・学生）──
  { id: 'absence-1', page: 'student-home', device: 'phone',
    steps: [{ click: day('木') }, { click: card('C40') }],
    clip: ['#modal .sheet'], marks: [{ sel: '#modal .m-act a.btn.danger' }] },
  { id: 'absence-2', page: 'student-absence', device: 'phone',
    clip: ['#form'], marks: [{ sel: '#submit' }] },
  { id: 'absence-3', page: 'student-absence', device: 'phone',
    steps: [{ click: '#submit' }], clip: ['#result'], marks: [] },
  { id: 'absence-4', page: 'student-absence-late', device: 'phone',
    steps: [{ click: '#submit' }], clip: ['#result'], marks: [] },

  // ── 代行に入る（スマホ・学生）──
  { id: 'substitute-1', page: 'candidate-respond', device: 'phone',
    clip: ['#content'],
    marks: [{ sel: 'button:has-text("承諾する")', n: 1 }, { sel: 'button:has-text("辞退する")', n: 2 }] },
  { id: 'substitute-2a', page: 'student-home', device: 'phone',
    steps: [{ click: day('水') }],
    clip: [card('C30')], marks: [{ sel: card('C30') + ' .st-myopen' }] },
  { id: 'substitute-2b', page: 'student-home', device: 'phone',
    steps: [{ click: day('水') }, { click: card('C30') }],
    clip: ['#modal .m-status', '#modal .m-act'], marks: [{ sel: '#modal .m-act button.btn.ok' }] },
  { id: 'substitute-3', page: 'student-vacancies', device: 'phone',
    // 上の説明文から写す（.bar から写すと、その上の行が半分だけ写り込む）
    clip: ['main > .hint', '.vac.can >> nth=0'],
    marks: [{ sel: '#onlyLabel', n: 1 }, { sel: '.vac.can .act button >> nth=0', n: 2 }] },
  { id: 'substitute-4', page: 'student-vacancies', device: 'phone',
    clip: ['.vac.closed'], marks: [{ sel: '.vac.closed .why' }] },

  // ── 職員の操作（PC・職員）──
  { id: 'staff-1', page: 'staff-manage', device: 'pc',
    clip: ['.vac >> nth=0', '.vac >> nth=2'], marks: [] },
  { id: 'staff-2', page: 'staff-manage', device: 'pc',
    clip: ['.vac.await'],
    marks: [{ sel: '.vac.await .alt button >> nth=0', n: 1 }, { sel: '.vac.await .alt button >> nth=1', n: 2 }] },
  { id: 'staff-3', page: 'staff-manage', device: 'pc',
    clip: ['.vac:has-text("V005") .resp'],
    // 電話と確定は**同じ人の行**を指す（まだ返事の無い人＝電話をかける相手）
    marks: [
      { sel: '.vac:has-text("V005") .resp-row:has-text("未回答") .tel', n: 1 },
      { sel: '.vac:has-text("V005") .resp-row:has-text("未回答") button.ok', n: 2 },
    ] },
  { id: 'staff-4', page: 'staff-manage', device: 'pc',
    clip: ['.vac.done:has-text("V006")'], marks: [{ sel: '.vac.done:has-text("V006") .alt button' }] },
  { id: 'staff-5', page: 'staff-input', device: 'pc',
    clip: ['[id^="card-"] >> nth=0', '#addCard'], marks: [{ sel: '#addCard' }] },
];

// ── 撮影 ────────────────────────────────────────────────

// 「見えているもの」で絞ってから「何番目か」を選ぶ（逆だと隠れた PC 用の表の要素を拾う）
const visible = (sel) => (sel.indexOf(' >> nth=') !== -1
  ? sel.replace(' >> nth=', ' >> visible=true >> nth=')
  : sel + ' >> visible=true');

async function rectOf(page, sel) {
  const loc = page.locator(visible(sel)).first();
  await loc.waitFor({ state: 'visible', timeout: 5000 });
  return loc.evaluate(function (el) {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
}

function union(rects) {
  const x1 = Math.min.apply(null, rects.map((r) => r.x));
  const y1 = Math.min.apply(null, rects.map((r) => r.y));
  const x2 = Math.max.apply(null, rects.map((r) => r.x + r.w));
  const y2 = Math.max.apply(null, rects.map((r) => r.y + r.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

/**
 * 枠・番号・矢印を、画面の上（position: fixed の SVG）に描く。
 * 座標は画面（ビューポート）基準。描いたものが写る範囲を返す（矢印の根元を含めるため）。
 */
async function drawMarks(page, rects, viewportWidth) {
  return page.evaluate(function (args) {
    const rects = args.rects;
    const color = args.color;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('width', String(window.innerWidth));
    svg.setAttribute('height', String(window.innerHeight));
    svg.style.cssText = 'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none';
    svg.innerHTML = '<defs><marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" ' +
      'markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="' + color + '"/></marker></defs>';
    const extent = [];
    const add = function (tag, attrs) {
      const el = document.createElementNS(NS, tag);
      Object.keys(attrs).forEach(function (k) { el.setAttribute(k, attrs[k]); });
      svg.appendChild(el);
      return el;
    };
    rects.forEach(function (m) {
      const r = { x: m.x - 4, y: m.y - 4, w: m.w + 8, h: m.h + 8 };
      add('rect', { x: r.x, y: r.y, width: r.w, height: r.h, rx: 8, fill: 'none', stroke: color, 'stroke-width': 3 });
      extent.push(r);
      if (m.n) {
        add('circle', { cx: r.x, cy: r.y, r: 12, fill: color });
        const t = add('text', { x: r.x, y: r.y + 5, 'text-anchor': 'middle', 'font-size': 14,
          'font-weight': 700, fill: '#fff', 'font-family': 'sans-serif' });
        t.textContent = String(m.n);
        extent.push({ x: r.x - 13, y: r.y - 13, w: 26, h: 26 });
      } else if (m.arrow && r.w < args.vw * 0.6) {
        // 枠の右下（右が詰まっていれば左下）の空いた所から、枠の角へ向けて引く。
        // 横いっぱいのボタンは左右に引く余白が無く、枠だけで十分目立つので引かない
        const right = r.x + r.w + 60 < args.vw;
        const sx = right ? r.x + r.w + 46 : r.x - 46;
        const sy = r.y + r.h + 40;
        const ex = right ? r.x + r.w - 4 : r.x + 4;
        const ey = r.y + r.h + 4;
        add('line', { x1: sx, y1: sy, x2: ex, y2: ey, stroke: color, 'stroke-width': 4,
          'stroke-linecap': 'round', 'marker-end': 'url(#ah)' });
        extent.push({ x: Math.min(sx, ex) - 6, y: ey, w: Math.abs(sx - ex) + 12, h: sy - ey + 8 });
      }
    });
    document.body.appendChild(svg);
    return extent;
  }, { rects: rects, color: MARK_COLOR, vw: viewportWidth });
}

async function shoot(browser, shot) {
  const dev = DEVICES[shot.device];
  const ctx = await browser.newContext(dev);
  const page = await ctx.newPage();
  page.on('dialog', function (d) { d.accept(); });   // confirm() は「OK」で進める
  const errors = [];
  page.on('pageerror', function (e) { errors.push(e.message); });

  await page.goto(pathToFileURL(path.join(render.OUT, shot.page + '.html')).href);
  // ナビは画面上部に張り付く（sticky）。スクロールすると写したい所がナビの下に隠れるので、撮影中は外す
  await page.addStyleTag({ content: '.appnav { position: static !important; }' });
  await page.waitForTimeout(400);
  for (const step of shot.steps || []) {
    if (step.click) await page.locator(visible(step.click)).first().click();
    await page.waitForTimeout(step.wait || 350);
  }

  // 写す範囲の先頭が画面の上に来るまでスクロールしてから測り直す
  let area = union(await Promise.all(shot.clip.map((s) => rectOf(page, s))));
  await page.evaluate(function (dy) { window.scrollBy(0, dy); }, area.y - 16);
  await page.waitForTimeout(150);
  area = union(await Promise.all(shot.clip.map((s) => rectOf(page, s))));

  const marks = await Promise.all((shot.marks || []).map(async function (m) {
    const r = await rectOf(page, m.sel);
    return Object.assign(r, { n: m.n, arrow: !m.n && shot.marks.length === 1 });
  }));
  const extent = marks.length ? await drawMarks(page, marks, dev.viewport.width) : [];
  area = union([area].concat(extent));

  const pad = 10;
  const clip = {
    x: Math.max(0, area.x - pad),
    y: Math.max(0, area.y - pad),
    width: Math.min(dev.viewport.width, area.x + area.w + pad) - Math.max(0, area.x - pad),
    height: Math.min(dev.viewport.height, area.y + area.h + pad) - Math.max(0, area.y - pad),
  };
  const file = path.join(IMG, shot.id + '.jpg');
  await page.screenshot({ path: file, clip: clip, type: 'jpeg', quality: JPEG_QUALITY });
  await ctx.close();
  if (errors.length) throw new Error(shot.id + ': 画面のエラー ' + errors.join(' / '));
  return file;
}

// ── 埋め込み ────────────────────────────────────────────

/**
 * src/help-*.html の data-shot="id" の要素（仮置きの div か、前回埋め込んだ img）を画像に置き換える。
 * 何度実行しても同じ結果になる（img にも data-shot と data-alt を残す）。
 */
function embed(ids) {
  const files = fs.readdirSync(SRC).filter((f) => /^help-.*\.html$/.test(f) && f !== 'help-webhook.html');
  const sizes = {};
  const done = {};
  files.forEach(function (f) {
    const full = path.join(SRC, f);
    let s = fs.readFileSync(full, 'utf8');
    let bytes = 0;
    ids.forEach(function (id) {
      const re = new RegExp('<div class="help-img-todo" data-shot="' + id + '"[^>]*>[^<]*</div>|' +
        '<img class="help-img" data-shot="' + id + '"[^>]*>');
      const m = s.match(re);
      if (!m) return;
      const alt = (m[0].match(/data-alt="([^"]*)"/) || [])[1] || '';
      const b64 = fs.readFileSync(path.join(IMG, id + '.jpg')).toString('base64');
      bytes += b64.length;
      s = s.replace(re, '<img class="help-img" data-shot="' + id + '" data-alt="' + alt + '" alt="' + alt +
        '" src="data:image/jpeg;base64,' + b64 + '">');
      done[id] = true;
    });
    if (bytes) {
      fs.writeFileSync(full, s);
      sizes[f] = bytes;
    }
  });
  const missing = ids.filter((id) => !done[id]);
  return { sizes: sizes, missing: missing };
}

async function main() {
  let chromium;
  try {
    chromium = require('playwright-core').chromium;
  } catch (e) {
    console.error('playwright-core がありません。先に  cd tools/help-shots && npm install  を実行してください。');
    process.exitCode = 1;
    return;
  }
  render.main();
  fs.mkdirSync(IMG, { recursive: true });

  // 手元の Chrome を使う（ブラウザは入れない）
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    for (const shot of SHOTS) {
      await shoot(browser, shot);
      console.log('📷 ' + shot.id);
    }
  } finally {
    await browser.close();
  }

  const res = embed(SHOTS.map((s) => s.id));
  console.log('\n埋め込み（base64 の大きさ。1話題 200KB 程度まで）');
  Object.keys(res.sizes).forEach(function (f) {
    const kb = Math.round(res.sizes[f] / 1024);
    console.log((kb > 220 ? '⚠️ ' : '✅ ') + f + ': ' + kb + 'KB');
  });
  if (res.missing.length) {
    console.log('⚠️ 埋め込み先（data-shot）が見つからない画像: ' + res.missing.join(', '));
    process.exitCode = 1;
  }
  console.log('\n次に  node tools/run-all.js  で画面が壊れていないか確かめてください。');
}

if (require.main === module) {
  main().catch(function (e) { console.error(e); process.exitCode = 1; });
}
