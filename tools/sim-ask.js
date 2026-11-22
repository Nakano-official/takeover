/**
 * 画面の中の確認・お知らせ・入力の窓（shared-ask・PR #60）の検証 — Node 上で実行する
 *
 *     node tools/sim-ask.js
 *
 * 守りたいこと：
 *   1. 入力の窓は、Enter・Shift＋Enter・日本語の変換を確定する Enter では実行しない。ボタンを押したときだけ（#61）
 *      変換中の Escape では閉じない（変換の取り消しだけ）
 *   2. 代行に入ったとき、職員スペースへ Chat を送れたときだけ「知らせました」と言う（#62）
 *   3. 確認・お知らせの窓は、ヘルプ・詳細・編集の窓より上に出る（#63）。お知らせの窓に「やめる」を出さない
 *   4. シフト入力で、Ctrl＋クリックなど別タブで開く操作は止めない（このタブの入力は残る・#64）
 *
 * 画面は tools/page-vm.js で、本物の src/*.html のスクリプトを動かして確かめる。
 */
const fs = require('fs');
const path = require('path');
const { Harness } = require('./gas-harness');
const { loadPage } = require('./page-vm');

const h = new Harness();
const SRC = path.join(__dirname, '..', 'src');
const read = (f) => fs.readFileSync(path.join(SRC, f), 'utf8');
const noCache = { viewCacheLoad() {}, viewCacheLocked() { return false; }, viewCacheClear() {} };

console.log('===== 画面の中の確認・お知らせ・入力の窓（#61〜#64）=====');

h.section('1) 入力の窓は、ボタンを押したときだけ実行する（#61）');
{
  const p = loadPage('approvals');
  const rejects = () => p.calls.filter((c) => c.name === 'rejectRegistration');
  p.ctx.reject('R1', p.el('btnR1'));
  h.check(!!p.ask() && /却下/.test(p.ask().title), '「却下」で理由の入力の窓が出る');
  const input = p.el('askInput');
  input.value = '在籍が確認できません';
  p.fire('document', 'keydown', { key: 'Enter', isComposing: true, keyCode: 229, target: input });
  h.check(!!p.ask() && rejects().length === 0, '★日本語の変換を確定する Enter では却下しない（窓は開いたまま）');
  p.fire('document', 'keydown', { key: 'Enter', target: input });
  h.check(!!p.ask() && rejects().length === 0, '★変換していない Enter でも却下しない');
  p.fire('document', 'keydown', { key: 'Enter', shiftKey: true, target: input });
  h.check(!!p.ask() && rejects().length === 0, '★Shift＋Enter でも却下しない');
  p.fire('document', 'keydown', { key: 'Escape', isComposing: true, keyCode: 229, target: input });
  h.check(!!p.ask(), '変換中の Escape では閉じない（変換の取り消しだけ）');
  p.answer(true);
  h.check(rejects().length === 1 && rejects()[0].args[1] === '在籍が確認できません', '「却下する」を押すと、入れた理由で却下する');

  p.ctx.reject('R2', p.el('btnR2'));
  p.fire('document', 'keydown', { key: 'Escape', target: input });
  h.check(!p.ask() && rejects().length === 1, '変換していない Escape で閉じ、却下しない');
}

h.section('2) 代行に入ったあとの知らせは、Chat の送信結果に合わせる（#62）');
[['vacancies', 'claim'], ['home', 'claimFromTable']].forEach(([file, fn]) => {
  const run = (res) => {
    const p = loadPage(file, { globals: noCache });
    p.ctx[fn]('V1', p.el('btnV1'));
    p.answer(true);
    const i = p.calls.findIndex((c) => c.name === 'claimVacancy');
    p.reply(i, res);
    return p.ask();
  };
  const ok = run({ ok: true, notify: { staff: true } });
  h.check(!!ok && /知らせました/.test(ok.text), file + '：送れたら「職員スペースへ Chat で知らせました」');
  const ng = run({ ok: true, notify: { staff: false, errors: ['職員スペース: 送れません'] } });
  h.check(!!ng && !/知らせました/.test(ng.text) && /確定しています/.test(ng.text) && /職員へ直接/.test(ng.text),
    '★' + file + '：送れなかったら「知らせました」と言わず、確定したことと職員へ伝えることを出す');
  const err = run({ ok: true, notify: { error: 'Webhook が見つかりません' } });
  h.check(!!err && !/知らせました/.test(err.text), file + '：送る処理が止まったときも「知らせました」と言わない');
});

h.section('3) 確認・お知らせの窓は、ほかの窓より上に出る（#63）');
{
  const z = (css, sel) => {
    const m = css.match(new RegExp(sel.replace(/[.#]/g, '\\$&') + '\\s*\\{[^}]*?z-index:\\s*(\\d+)'));
    return m ? Number(m[1]) : NaN;
  };
  const ask = z(read('shared-ask.html'), '#askModal.help-modal');
  const others = [
    ['ヘルプ（.help-modal）', z(read('shared-styles.html'), '.help-modal')],
    ['シフト確認の詳細（.modal）', z(read('home.html'), '.modal')],
    ['シフト入力の編集（.emodal）', z(read('input.html'), '.emodal')],
  ];
  others.forEach(([name, v]) => {
    h.check(ask > v, '★確認・お知らせの窓（' + ask + '）は ' + name + '（' + v + '）より上');
  });
  // .btn の display が hidden 属性に勝つので、明示して隠していないと、お知らせの窓に「やめる」が出る
  h.check(/\.ask-foot \.btn\[hidden\]\s*\{\s*display:\s*none/.test(read('shared-ask.html')),
    '★お知らせの窓では「やめる」を見えなくする（hidden を display: none にする指定がある）');
}

h.section('4) シフト入力：別タブで開く操作は止めない（#64）');
{
  const p = loadPage('input');
  p.ctx.FORM_DIRTY = true;   // 登録していない入力がある
  let clicked = 0;
  const link = { target: '', getAttribute(k) { return k === 'href' ? '?page=home' : null; }, click() { clicked++; } };
  const click = (ev) => p.fire('window', 'click', Object.assign({ button: 0, target: { closest: () => link } }, ev));

  ['ctrlKey', 'metaKey', 'shiftKey'].forEach((k) => {
    const e = click({ [k]: true });
    h.check(!e.defaultPrevented && !p.ask(), '★' + k + ' を押しながらのクリックは止めない（ブラウザが別タブ・別窓で開く）');
  });
  link.target = '_blank';
  const blank = click({});
  h.check(!blank.defaultPrevented && !p.ask(), '別タブで開くリンク（target=_blank）は止めない');
  link.target = '';

  const plain = click({});
  h.check(plain.defaultPrevented && !!p.ask() && /離れますか/.test(p.ask().title), 'ふつうのクリックは止めて、画面の中の窓で確かめる');
  p.answer(false);
  h.check(clicked === 0 && p.ctx.LEAVING === false, '「入力に戻る」なら移動しない');
  click({});
  p.answer(true);
  h.check(clicked === 1 && p.ctx.LEAVING === true, '「入力を捨てて移動する」なら、同じリンクで移動する');
}

process.exit(h.report());
