/**
 * GitHub Pages に置くデモサイトを書き出す（架空データ・全画面を行き来できる）
 *
 *     node tools/demo-site/build.js
 *     → tools/demo-site/dist/index.html（ブラウザで直接開ける）
 *
 * main に push すると GitHub Actions（.github/workflows/demo-site.yml）がこれを回して Pages に載せる。
 * 生成物はコミットしない（dist/ は .gitignore 済み）。
 *
 * ■ 仕組み
 *   ヘルプ撮影の道具（tools/help-shots/render.js）をそのまま使う。架空データ（help-shots/demo-data.js）で
 *   本物の src/*.gs を動かして画面を組み立てるので、画面を直せばデモも次の push で追従する。
 *   その上で、ここでは次を足す。
 *   - 見る人ごとにフォルダを分けて全画面を書き出す（student/ staff/ …）
 *   - ナビ・画面内のリンク（?page=◯◯）を、同じフォルダの ◯◯.html へつなぎ替える（demo-bar.html）
 *   - 欠勤連絡（?course=）・代行依頼への回答（?vacancy=）は URL の値を読むようにして、1枚で全部のコマを開ける
 *   - ヘルプは help/*.json に1回だけ書き出し、押したときに取り寄せる（画像で各画面が重くならないように）
 *   - 画面下に「デモ」の帯（見る人の切り替え・画面一覧へ戻る・保存されない旨）
 *
 * ■ できないこと（help-shots と同じ）
 *   ボタンを押したときの書き込みは「成功した」と返すだけで、画面は変わらない（帯で「保存されません」と出す）。
 *
 * ■ Public に出るもの
 *   すべて demo-data.js の架空データ。**実データ・本番のURLを入れないこと**（Pages は誰でも見られる）。
 */
const fs = require('fs');
const path = require('path');

const R = require('../help-shots/render');
const { h, G, DEMO } = R;

const SRC = path.join(__dirname, '..', '..', 'src');
const DIST = path.join(__dirname, 'dist');
const APP_URL = 'https://example.invalid/app';   // help-shots の ScriptApp の偽物が返す URL

// 見る人 → 書き出す画面。label は帯と一覧に出す
const PERSONAS = {
  student: {
    label: '学生スタッフ（山田 太郎）', viewer: 'student',
    pages: ['home', 'absence', 'vacancies', 'respond', 'mypage'],
  },
  candidate: {
    label: '代行候補の学生（小林 健太）', viewer: 'candidate',
    pages: ['home', 'absence', 'vacancies', 'respond', 'mypage'],
  },
  staff: {
    label: '職員（支援室 職員）', viewer: 'staff',
    pages: ['home', 'input', 'manage', 'vacancies', 'roster', 'approvals', 'terms', 'respond', 'mypage'],
  },
  newcomer: {
    label: 'まだ登録していない人', viewer: 'newcomer',
    pages: ['signup'],
  },
  closed: {
    label: '準備中のときの学生（山田 太郎）', viewer: 'student', closed: true,
    pages: ['closed', 'mypage'],
  },
  fresh: {
    label: '登録されたばかりの学生（新人 花子）', viewer: 'fresh',
    pages: ['confirm'],
  },
};

// 一覧（index.html）に並べる画面。[見る人, 画面, URLの後ろ, 説明]
const INDEX = [
  ['学生スタッフの画面', [
    ['student', 'home', '', '自分のシフトと、欠員が出ているコマ'],
    ['student', 'absence', '?course=C40&date=' + DEMO.WEEK['木'], '欠勤連絡（木曜4限を選んだ状態）'],
    ['student', 'absence', '?course=C12&date=' + DEMO.WEEK['火'], '直前の欠勤連絡（締切を過ぎたコマ・代行を募集しない）'],
    ['student', 'vacancies', '', '欠員一覧（自分から代行に入れる）'],
    ['candidate', 'respond', '?vacancy=V005', '代行依頼への回答（Chat の通知から開く画面）'],
    ['student', 'mypage', '', 'マイページ（連絡先・空きコマ）'],
  ]],
  ['職員の画面', [
    ['staff', 'home', '', 'シフト確認（全員分）'],
    ['staff', 'manage', '', '欠員補充管理（決着待ち・募集中・補充済）'],
    ['staff', 'input', '', 'シフト入力'],
    ['staff', 'vacancies', '', '欠員一覧（学生から見えている状態）'],
    ['staff', 'roster', '', 'スタッフ名簿'],
    ['staff', 'approvals', '', '利用登録の承認（承認待ち1件）'],
    ['staff', 'terms', '', '学期設定'],
  ]],
  ['そのほか', [
    ['newcomer', 'signup', '', '登録がありません（名簿に無いアカウントで開いたとき）'],
    ['closed', 'closed', '', '準備中（学生への公開を閉じているとき）'],
    ['fresh', 'confirm', '', '本人の確認（職員が登録した人が初めて開いたとき）'],
  ]],
];

function pageTitle(pageKey) {
  if (pageKey === 'closed') return h.value('CLOSED_PAGE').title;
  if (pageKey === 'confirm') return h.value('CONFIRM_PAGE').title;
  return h.value('PAGES')[pageKey].title;
}

// その人の担当コマ（欠勤連絡で選べるコマ）
function myCourseIds(staffId) {
  return DEMO_COURSES().filter(function (c) { return c.staff_a_id === staffId || c.staff_b_id === staffId; })
    .map(function (c) { return c.course_id; });
}
function DEMO_COURSES() { DEMO.seed(h); return h.db.courses.slice(); }

/** 書き込みを伴う返事を先に作る（1件ごとにデータを入れ直す） */
function extraResponses(persona) {
  const staffId = DEMO.VIEWERS[persona.viewer];
  return function (out) {
    if (!staffId) return;
    const tryPut = function (key, fn) {
      DEMO.seed(h);
      if (persona.closed) h.props.STUDENT_ACCESS = 'closed';
      R.viewAs(staffId);
      try { out[key] = JSON.parse(JSON.stringify(fn())); } catch (e) { if (process.env.RENDER_DEBUG) console.log('  x', key, e.message); }
    };
    if (persona.pages.indexOf('absence') !== -1) {
      myCourseIds(staffId).forEach(function (id) {
        const c = h.db.courses.filter(function (x) { return x.course_id === id; })[0];
        tryPut('submitAbsence|' + id, function () { return G.submitAbsence(id, DEMO.WEEK[c.day], true); });
      });
    }
    if (persona.pages.indexOf('respond') !== -1) {
      DEMO.seed(h);
      const answers = h.value('ANSWER');
      h.db.vacancies.map(function (v) { return v.vacancy_id; }).forEach(function (id) {
        tryPut('getVacancyForRespond|' + id, function () { return G.getVacancyForRespond(id); });
        // 承諾／辞退を押した後の返事（承諾なら「あなたに代行が決まりました」など本物の判定で出る）
        [answers.ACCEPT, answers.DECLINE].forEach(function (ans) {
          tryPut('respondToVacancy|' + id + '|' + ans, function () { return G.respondToVacancy(id, ans); });
        });
      });
    }
  };
}

/** テンプレートで埋めた値を、URL から読むように差し替える（見つからなければ止める＝画面が変わったら気づける） */
function readFromUrl(html, from, name) {
  if (html.indexOf(from) === -1) throw new Error('差し替える箇所が見つかりません: ' + from);
  return html.replace(from, from.replace("'';", "new URLSearchParams(location.search).get('" + name + "') || '';"));
}

function demoBar(personaKey, pageKey) {
  const template = fs.readFileSync(path.join(__dirname, 'demo-bar.html'), 'utf8');
  const personas = Object.keys(PERSONAS).map(function (k) {
    return { key: k, label: PERSONAS[k].label, pages: PERSONAS[k].pages };
  });
  const conf = { appUrl: APP_URL, persona: personaKey, page: pageKey, personas: personas,
    date: DEMO.NOW.getFullYear() + '/' + (DEMO.NOW.getMonth() + 1) + '/' + DEMO.NOW.getDate() };
  return template.replace('/*DEMO_CONF*/null', function () { return JSON.stringify(conf).replace(/</g, '\\u003c'); });
}

/**
 * 画面の中の時計も NOW に合わせる（読み込んだ時点を NOW とし、そこから進める）。
 * 合わせないと、欠勤日の選択肢などがブラウザの「今日」で作られ、架空データの週とずれる。
 * 画面のスクリプトより前に置く。
 */
function clockShim() {
  return '<script>(function () {\n' +
    '  var R = Date, shift = ' + DEMO.NOW.getTime() + ' - R.now();\n' +
    '  function D() {\n' +
    '    var a = Array.prototype.slice.call(arguments);\n' +
    '    if (!(this instanceof D)) return new R(R.now() + shift).toString();\n' +
    '    var d = a.length ? new (Function.prototype.bind.apply(R, [null].concat(a)))() : new R(R.now() + shift);\n' +
    '    Object.setPrototypeOf(d, D.prototype);\n' +
    '    return d;\n' +
    '  }\n' +
    '  D.prototype = R.prototype;\n' +
    '  D.now = function () { return R.now() + shift; };\n' +
    '  D.UTC = R.UTC; D.parse = R.parse;\n' +
    '  window.Date = D;\n' +
    '})();</script>';
}

function buildPage(personaKey, pageKey) {
  const persona = PERSONAS[personaKey];
  let html = R.renderPage(persona.viewer, pageKey, persona.closed ? { closed: true } : {}, {
    helpBase: '../help/',
    extra: extraResponses(persona),
  });
  if (pageKey === 'absence') {
    html = readFromUrl(html, "var PRE_COURSE = '';", 'course');
    html = readFromUrl(html, "var PRE_DATE = '';", 'date');
  }
  if (pageKey === 'respond') html = readFromUrl(html, "var VACANCY_ID = '';", 'vacancy');
  html = html.replace(/<head>/i, function () { return '<head>\n' + clockShim(); });
  html = html.replace(/<\/body>/i, function () { return demoBar(personaKey, pageKey) + '\n</body>'; });
  return html;
}

function buildHelp() {
  fs.mkdirSync(path.join(DIST, 'help'), { recursive: true });
  Object.keys(h.value('HELP_TOPICS')).forEach(function (key) {
    fs.writeFileSync(path.join(DIST, 'help', key + '.json'), JSON.stringify(G.getHelp(key)));
  });
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function buildIndex() {
  const styles = fs.readFileSync(path.join(SRC, 'shared-styles.html'), 'utf8');
  const sections = INDEX.map(function (group) {
    const items = group[1].map(function (it) {
      const href = it[0] + '/' + it[1] + '.html' + it[2];
      return '<a class="item" href="' + escapeHtml(href) + '">' +
        '<span class="t">' + escapeHtml(pageTitle(it[1])) + '</span>' +
        '<span class="d">' + escapeHtml(it[3]) + '</span>' +
        '<span class="who">' + escapeHtml(PERSONAS[it[0]].label) + '</span></a>';
    }).join('');
    return '<section class="card"><h2>' + escapeHtml(group[0]) + '</h2><div class="items">' + items + '</div></section>';
  }).join('\n');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8')
    .replace('<!--STYLES-->', function () { return styles; })
    .replace('<!--SECTIONS-->', function () { return sections; })
    .replace('<!--DATE-->', escapeHtml(DEMO.NOW.toLocaleString('ja-JP', { dateStyle: 'long', timeStyle: 'short' })));
  fs.writeFileSync(path.join(DIST, 'index.html'), html);
}

function main() {
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  let count = 0;
  Object.keys(PERSONAS).forEach(function (personaKey) {
    fs.mkdirSync(path.join(DIST, personaKey), { recursive: true });
    PERSONAS[personaKey].pages.forEach(function (pageKey) {
      fs.writeFileSync(path.join(DIST, personaKey, pageKey + '.html'), buildPage(personaKey, pageKey));
      count++;
    });
  });
  buildHelp();
  buildIndex();
  // GitHub Pages の Jekyll を通さない（_ で始まるファイルが消えるなどを避ける）
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '');
  console.log('✅ ' + count + ' 画面を書き出しました → ' + path.relative(process.cwd(), path.join(DIST, 'index.html')));
}

if (require.main === module) main();

module.exports = { main, PERSONAS, DIST };
