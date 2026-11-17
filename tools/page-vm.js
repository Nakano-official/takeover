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
 *   - confirm() の答えは p.confirmAnswer で決める（既定は true）。聞かれた文は p.confirms に残る
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

  const body = fakeElement('body');
  body.tagName = 'BODY';
  const document = {
    getElementById: el, body: body, activeElement: body,
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
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
  ctx.addEventListener = function () {};
  vm.createContext(ctx);
  scripts.forEach(function (s, i) { vm.runInContext(s, ctx, { filename: file + '.html#script' + i }); });
  page.ctx = ctx;
  return page;
}

module.exports = { loadPage };
