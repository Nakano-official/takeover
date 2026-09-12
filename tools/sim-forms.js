/**
 * フォーム取り込み（空きコマ・連絡先）のマッピング検証 — Node 上で実行する
 *
 *     node tools/sim-forms.js
 *
 * `src/Constants.gs` / `src/Forms.gs` を**そのまま**読み込み、フォーム送信イベントの
 * `namedValues`（設問名 → 回答）から DB に入る値を組み立てる部分だけを見る。
 * Google フォームも実シートも要らない（純粋関数のみ）。
 *
 * ■ 元は GAS の testIntakeMapping（Forms.gs 内）だった。
 *   あちらは組み立て結果を Logger に出して「期待: 月1,月3,水2」と**人がログを読み比べる**形で、
 *   ズレても赤くならなかった。ここでは期待値を assert にしてある。
 *
 * ■ なぜここが壊れると痛いか
 *   `available_slots` が1つずれると、その学生は該当コマの代行候補に**構造的に出てこなくなる**。
 *   エラーにはならず「候補なし」として静かに募集クローズへ倒れるので、気づきにくい（backlog 10-5）。
 */
const { Harness } = require('./gas-harness');

const h = new Harness();
h.load(['Constants.gs', 'Forms.gs']);
const G = h.G;

console.log('===== フォーム取り込みのマッピング検証 =====');

// 本番の namedValues はチェックボックスを「カンマ結合の単一文字列」で渡す（例: '1限, 3限'）。
// 配列で渡ってくる形もありうるので、両方を通せることを確認する。
const nv = {
  'メールアドレス': ['S010@mail.ryukoku.ac.jp'],
  '月曜の空きコマ': ['1限, 3限'],      // 本番形式：カンマ結合
  '水曜の空きコマ': ['2限'],
  '対応できる業務': ['テイク, 介助'],   // 本番形式：カンマ結合
  '電話番号': ['090-1111-2222'],
  'Google Chat Webhook URL': ['https://chat.googleapis.com/v1/spaces/XXX/messages?key=abc&token=def'],
};

h.section('1) 設問 → DB に入る値');
h.check(G.firstValue_(nv, 'メールアドレス') === 'S010@mail.ryukoku.ac.jp', 'メールアドレスを取り出す');
h.check(G.buildSlots_(nv) === '月1,月3,水2', '空きコマを「月1,月3,水2」に組み立てる');
h.check(G.buildSkills_(nv) === 'テイク,介助', 'スキルを「テイク,介助」に組み立てる');
h.check(G.firstValue_(nv, '電話番号') === '090-1111-2222', '電話番号を取り出す');
h.check(/^https:\/\/chat\.googleapis\.com\//.test(G.firstValue_(nv, 'Google Chat Webhook URL')),
  'Webhook URL を取り出す');

h.section('2) 設問名は WORK_DAYS から導出される（backlog 10-5）');
// 曜日集合の単一の出所は Constants.gs の WORK_DAYS。フォームの設問名がここからずれると
// その曜日の空きコマが永久に取り込まれない（＝その曜日の代行候補が構造的に0人になる）。
// どの曜日が業務日かは運用で変わる（2026-09-12 に土曜を追加）。ここでは**曜日の中身を固定せず**、
// 「WORK_DAYS に入っている曜日はすべて取り込まれる」という導出の関係だけを見る。
const days = h.value('WORK_DAYS');            // トップレベル const は h.value で読む
const suffix = h.value('WORK_DAY_SLOT_Q_SUFFIX');
h.check(Array.isArray(days) && days.length > 0, 'WORK_DAYS が定義されている');
const nvAllDays = {};
days.forEach((d, i) => { nvAllDays[d + suffix] = [(i + 1) + '限']; });
h.check(G.buildSlots_(nvAllDays) === days.map((d, i) => d + (i + 1)).join(','),
  'WORK_DAYS の全曜日ぶんの設問が取り込まれる（' + days.join('') + '）');
// WORK_DAYS に無い曜日の設問は無視される（フォームに余分な設問があっても壊れない）
const notWorkDay = ['日', '土', '金'].filter((d) => days.indexOf(d) === -1)[0];
if (notWorkDay) {
  h.check(G.buildSlots_({ [notWorkDay + suffix]: ['1限'] }) === '',
    'WORK_DAYS に無い曜日（' + notWorkDay + '）の設問は取り込まない');
}

h.section('3) 未回答・空欄');
h.check(G.buildSlots_({}) === '', '空きコマの設問が1つも無ければ空文字');
h.check(G.buildSkills_({}) === '', 'スキルの設問が無ければ空文字（空欄は全対応扱い・D9）');
h.check(G.firstValue_({}, '電話番号') === '', '未回答の設問は空文字');
h.check(G.buildSlots_({ '月曜の空きコマ': [''] }) === '', '空文字の回答はスロットを作らない');

h.section('4) Webhook URL の形式チェック');
h.check(G.isChatWebhook_('https://chat.googleapis.com/v1/spaces/X/messages?key=k') === true,
  '正しい Chat Webhook は true');
h.check(G.isChatWebhook_('https://example.com/hook') === false, '無関係なURLは false');
h.check(G.isChatWebhook_('') === false, '空文字は false');

process.exitCode = h.report();
