/**
 * 手元の検証をまとめて実行する — clasp push する前にこれを通す
 *
 *     node tools/run-all.js
 *
 * 構文チェックと全ての sim-*.js を順に走らせ、1つでも失敗したら終了コード 1 を返す。
 * 新しく `tools/sim-〇〇.js` を足せば自動で拾われる（列挙を書き足す必要はない）。
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const HERE = __dirname;

const scripts = ['check-syntax.js'].concat(
  fs.readdirSync(HERE).filter((f) => /^sim-.*\.js$/.test(f)).sort()
);

const failed = [];
scripts.forEach(function (s) {
  console.log('\n████ ' + s + ' ' + '█'.repeat(Math.max(1, 40 - s.length)));
  const res = spawnSync(process.execPath, [path.join(HERE, s)], { stdio: 'inherit' });
  if (res.status !== 0) failed.push(s);
});

console.log('\n' + '='.repeat(50));
if (failed.length === 0) {
  console.log('✅ ' + scripts.length + '件すべて成功。clasp push して問題ありません。');
} else {
  console.log('❌ 失敗: ' + failed.join(' / '));
  console.log('   直してから push すること。');
  process.exitCode = 1;
}
