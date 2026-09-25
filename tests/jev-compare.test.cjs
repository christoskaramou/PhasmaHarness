const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JevCompareLog, MAX_BYTES } = require('../src/routing/jev-compare.cjs');

const entry = (used, jev, source = 'router') => ({ at: 1, used: { id: used.join(':'), provider: used[0], model: used[1], effort: used[2], source },
  jev: { id: jev.join(':'), provider: jev[0], model: jev[1], effort: jev[2], costUsd: 0.0001 } });

test('the Jev comparison log counts agreement, keeps no message text, survives restarts and rotates', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'jev-compare-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'jev-compare.jsonl');
  const log = new JevCompareLog(file);
  log.record(entry(['codex', 'gpt-5.6-terra', 'low'], ['codex', 'gpt-5.6-terra', 'low']));
  log.record(entry(['codex', 'gpt-5.6-terra', 'high'], ['codex', 'gpt-5.6-terra', 'low']));
  log.record(entry(['claude-cli', 'claude-opus-5-5', 'high'], ['codex', 'gpt-6-astra', 'high'], 'manual'));
  log.record({ at: 1, used: { id: 'x' }, error: 'Jev is rate-limited or overloaded. Try again later.' });
  const expected = { compared: 3, errors: 1, sameWorker: 1, sameModel: 2, sameProvider: 2, manual: 1, manualSameModel: 0, costUsd: 0.0003 };
  const round = s => ({ ...s, costUsd: Number(s.costUsd.toFixed(6)) });
  assert.deepEqual(round(log.summary()), expected);
  assert.deepEqual(round(new JevCompareLog(file).summary()), expected, 'reloaded from disk');
  fs.appendFileSync(file, '{"torn');
  assert.deepEqual(round(new JevCompareLog(file).summary()), expected, 'a torn line is skipped');
  // At the size limit the file moves to .1 and the summary still covers both files.
  fs.writeFileSync(file, (JSON.stringify(entry(['codex', 'a', 'low'], ['codex', 'a', 'low'])) + '\n').repeat(Math.ceil(MAX_BYTES / 150) + 10));
  const big = new JevCompareLog(file);
  const before = big.summary().compared;
  big.record(entry(['codex', 'a', 'low'], ['codex', 'b', 'low']));
  assert.ok(fs.existsSync(file + '.1'));
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, 1);
  assert.equal(big.summary().compared, before + 1);
});
