/**
 * 画面（src/*.html）のスクリプトを、最小限の DOM の代わりで Node の上で動かす（検証用）
 *
 * サーバーのテストだけでは、画面とサーバーの判定の食い違い（issue #49）や、
 * 「確認の前にサーバーを呼んでいないか」（issue #54）は見つからない。画面の関数を実際に呼んで確かめるための道具。
 *
 *     const { loadPage } = require('./page-vm');
 *     const p = loadPage('absence', { include: ['shared-dialog'] });
 *     p.ctx.COURSES = ...; p.el('course').value = 'C1'; p.ctx.rebuildDates();
 *     p.el('submit').disabled  /  p.calls（google.script.run の呼び出し）
 *
 * ■ できること・できないこと
 *   - getElementById はどの id にも、値・innerHTML・hidden などを持つ箱を返す（innerHTML の中の要素は作らない）
 *   - <?!= include('x') ?> は include に挙げたものだけ中身を入れる。ほかのテンプレートの値は空になる
 *   - google.script.run は呼び出しを calls に記録するだけ（成功の返事は p.reply(i, 値) で返せる）
 *   - 画面の中の確認（askConfirm・shared-ask）は本物が動く。p.ask() で開いている窓の題名と本文を読み、
 *     p.answer(true / false) で「OK」「やめる」を押す
 *   - document / window に登録された処理（keydown・click など）は p.fire('document' | 'window', 種類, イベント) で送れる。
 *     戻り値で preventDefault / stopImmediatePropagation が呼ばれたかを見られる
 *   - ブラウザの confirm() は使わない決まりだが、念のため p.confirmAnswer で答えを決められる（既定は true）
 *   - 見た目・レイアウト・フォーカスの実際の動きは確かめられない（ブラウザで確かめる）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SRC = path.join(__dirname, '..', 'src');

function fakeElement(id) {
  const attrs = {};
  const classes = {};
  return {
    id: id, value: '', innerHTML: '', textContent: '', disabled: false, hidden: false, checked: false, inert: false,
    style: {}, options: [], children: [], offsetParent: {}, tagName: 'DIV',
    classList: {
      add(c) { classes[c] = true; }, remove(c) { delete classes[c]; },
      toggle(c, on) { if (on === undefined ? !classes[c] : on) classes[c] = true; else delete classes[c]; },
      contains(c) { return !!classes[c]; },
    },
    setAttribute(k, v) { attrs[k] = String(v); }, getAttribute(k) { return k in attrs ? attrs[k] : null; },
    hasAttribute(k) { return k in attrs; }, removeAttribute(k) { delete attrs[k]; },
    addEventListener() {}, focus() {}, contains(x) { return x === this; },
    querySelector() { return null; }, querySelectorAll() { return []; },
    scrollIntoView() {}, appendChild() {}, removeChild() {},
  };
}

function loadPage(file, opts) {
  opts = opts || {};
  const include = opts.include || [];
  let html = fs.readFileSync(path.join(SRC, file + '.html'), 'utf8');
  // ヘッダー（<?!= chrome ?>）として code.js の renderChrome_ が付ける部品のうち、画面の関数が使うもの
  // （窓のキーボード操作・画面の中の確認とお知らせ）。本番と同じく、どの画面にも付ける
  html = html.replace(/<\?!=\s*chrome\s*\?>/, function () {
    return ['shared-dialog', 'shared-ask'].map(function (n) {
      return fs.readFileSync(path.join(SRC, n + '.html'), 'utf8');
    }).join('\n');
  });
  html = html.replace(/<\?!=\s*include\('([^']+)'\)\s*\?>/g, function (all, name) {
    return include.indexOf(name) !== -1 ? fs.readFileSync(path.join(SRC, name + '.html'), 'utf8') : '';
  });
  html = html.replace(/<\?!?=[\s\S]*?\?>/g, '');
  const scripts = [];
  html.replace(/<script>([\s\S]*?)<\/script>/g, function (all, body) { scripts.push(body); return ''; });

  const els = {};
  const el = (id) => els[id] || (els[id] = fakeElement(id));
  const page = { calls: [], confirms: [], alerts: [], confirmAnswer: true, el: el };

  function runner(ok, ng) {
    return new Proxy({}, { get: function (_, name) {
      if (name === 'withSuccessHandler') return function (f) { return runner(f, ng); };
      if (name === 'withFailureHandler') return function (f) { return runner(ok, f); };
      if (name === 'withUserObject') return function () { return runner(ok, ng); };
      return function () { page.calls.push({ name: name, args: Array.prototype.slice.call(arguments), ok: ok, ng: ng }); };
    } });
  }
  page.reply = function (i, value) { const c = page.calls[i]; if (c && c.ok) c.ok(value); };
  // 画面の中の確認・お知らせの窓（shared-ask）
  page.ask = function () {
    const m = els.askModal;
    if (!m || m.hidden) return null;
    return { title: els.askTitle ? els.askTitle.textContent : '', text: els.askBody ? (els.askBody.textContent || els.askBody.innerHTML) : '' };
  };
  page.answer = function (yes) { page.ctx.askClose_(yes); };
  const listeners = { document: {}, window: {} };
  const listen = (where) => function (type, fn) { (listeners[where][type] = listeners[where][type] || []).push(fn); };
  page.fire = function (where, type, ev) {
    const e = Object.assign({ key: '', target: null, defaultPrevented: false, stopped: false }, ev || {});
    e.preventDefault = function () { e.defaultPrevented = true; };
    e.stopImmediatePropagation = function () { e.stopped = true; };
    e.stopPropagation = function () { e.stopped = true; };
    for (const fn of (listeners[where][type] || [])) { fn(e); if (e.stopped) break; }
    return e;
  };

  const body = fakeElement('body');
  body.tagName = 'BODY';
  const document = {
    getElementById: el, body: body, activeElement: body,
    addEventListener: listen('document'), querySelector() { return null; }, querySelectorAll() { return []; },
    createElement() { return fakeElement(''); },
  };
  const ctx = Object.assign({
    document: document, google: { script: { run: runner(null, null) } }, console: console,
    alert(m) { page.alerts.push(String(m)); },
    confirm(m) { page.confirms.push(String(m)); return page.confirmAnswer; },
    sessionStorage: { getItem() { return null; }, setItem() {}, removeItem() {} },
    setTimeout: function (f) { return 0; }, clearTimeout() {},
    location: { search: '', href: '' },
  }, opts.globals || {});
  ctx.window = ctx;
  ctx.addEventListener = listen('window');
  vm.createContext(ctx);
  scripts.forEach(function (s, i) { vm.runInContext(s, ctx, { filename: file + '.html#script' + i }); });
  page.ctx = ctx;
  return page;
}

module.exports = { loadPage };
