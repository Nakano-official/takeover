const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { summaryLine, relayUrl, isGasFrame } = require('./protocol');
test('only bounded integer summaries reach USB', () => {
  assert.equal(summaryLine({count: 0, latest: 9}), 'SUMMARY 0 9');
  for (const bad of [null, {}, {count: -1, latest: 0}, {count: '0\nTEST', latest: 1},
    {count: 1.5, latest: 0}, {count: 0, latest: 2147483648}]) {
    assert.throws(() => summaryLine(bad));
  }
});
test('relay URL removes tokens and uses authenticated page', () => {
  assert.equal(relayUrl('https://script.google.com/a/macros/example.edu/s/abc/exec?token=secret'),
    'https://script.google.com/a/macros/example.edu/s/abc/exec?page=deviceRelay');
  assert.throws(() => relayUrl('https://evil.example/exec'));
  assert.throws(() => relayUrl('http://script.google.com/s/abc/exec'));
  assert.equal(isGasFrame('https://n-123-script.googleusercontent.com/userCodeAppPanel'), true);
  assert.equal(isGasFrame('https://script.googleusercontent.com.evil.example/'), false);
});
test('GAS relay enforces staff before reading data', () => {
  let allowed = false, reads = 0;
  const ctx = vm.createContext({ requireStaff_() { if (!allowed) throw Error('denied'); },
    readRows() { reads++; return [{result: '', vacancy_id: 'V002'}, {result: 'filled', vacancy_id: 'V009'}]; },
    SHEET: {VACANCIES: 'vacancies'} });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../../src/Device.gs'), 'utf8'), ctx);
  assert.throws(() => ctx.getDeviceRelaySummary(), /denied/);
  assert.equal(reads, 0);
  allowed = true;
  assert.equal(summaryLine(ctx.getDeviceRelaySummary()), 'SUMMARY 1 9');
});
