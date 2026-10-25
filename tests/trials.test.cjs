const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const trials = require('../src/trials.cjs');

const failing = (name, stdout) => ({ name, status: 'failed', exitCode: 1, stdout, stderr: '' });
const passing = name => ({ name, status: 'passed', exitCode: 0, stdout: 'ok', stderr: '' });
const rule = { id: 'r1', rule: 'Make sure fetchUser is a function before wiring retries.', lessonKey: 'k', check: 'unit',
  error: 'TypeError: fetchUser is not a function', goal: 'Add retry handling to fetchUser', state: 'trial', since: 1, carried: [] };
const task = (id, attempts, extra = {}) => ({ id, attempts: attempts.map(results => ({ results })), trialRuleIds: ['r1'], ...extra });
const tempRoot = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-trials-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test('a carried task is clean only when the rule\'s check ran first and passed, and a hit is that exact failure on any attempt', () => {
  assert.equal(trials.trialOutcome(task('a', [[passing('unit')]]), rule), 'clean');
  assert.equal(trials.trialOutcome(task('b', [[failing('unit', 'TypeError: fetchUser is not a function\n  at retry.js:3'), failing('lint', 'x')], [passing('unit')]]), rule),
    'hit', 'the target failure plus another failing check is still a hit');
  assert.equal(trials.trialOutcome(task('c', [[passing('lint')], [failing('unit', 'TypeError: fetchUser is not a function')]]), rule), 'hit', 'on a later attempt too');
  assert.equal(trials.trialOutcome(task('d', [[failing('unit', 'ReferenceError: x is not defined')], [passing('unit')]]), rule), 'none', 'another failure says nothing');
  assert.equal(trials.trialOutcome(task('e', [[passing('lint')]]), rule), 'none', 'the check did not run');
  assert.equal(trials.trialOutcome(task('f', [[passing('unit')]], { checksSkippedByRouter: true }), rule), 'none', 'skipped checks say nothing');
});

test('three clean carried tasks keep a rule, a hit drops it, and the same task never counts twice', t => {
  const root = tempRoot(t);
  const started = trials.startTrial(root, { rule: rule.rule, lessonKey: 'k', check: 'unit', error: rule.error, goal: rule.goal, source: 'a reflection' });
  const carried = id => ({ ...task(id, [[passing('unit')]]), trialRuleIds: [started.id] });
  assert.deepEqual(trials.recordOutcomes(root, carried('t1')), []);
  assert.deepEqual(trials.recordOutcomes(root, carried('t1')), [], 'a correction of the same task does not count again');
  assert.deepEqual(trials.recordOutcomes(root, { ...task('t2', [[passing('lint')]]), trialRuleIds: [started.id] }), [], 'none counts nothing');
  trials.recordOutcomes(root, carried('t3'));
  const [kept] = trials.recordOutcomes(root, carried('t4'));
  assert.equal(kept.state, 'kept');
  assert.equal(trials.readRules(root)[0].carried.filter(entry => entry.outcome === 'clean').length, 3);
  assert.match(fs.readFileSync(path.join(root, trials.PAGE), 'utf8'), /\*\*Kept\*\* · Make sure fetchUser is a function/);

  const second = trials.startTrial(root, { rule: 'Export fetchUser by name.', lessonKey: 'k', check: 'unit', error: rule.error, goal: rule.goal, source: 'a reflection' });
  const [dropped] = trials.recordOutcomes(root, { ...task('t5', [[failing('unit', 'TypeError: fetchUser is not a function')]]), trialRuleIds: [second.id] });
  assert.equal(dropped.state, 'dropped');
  assert.match(dropped.reason, /came back/);
});

test('trial rules ride only matching tasks that run their check, in a capped block; at most five are on trial', t => {
  const root = tempRoot(t);
  for (let index = 0; index < 6; index++)
    trials.startTrial(root, { rule: `Rule ${index} about fetchUser retries.`, lessonKey: `k${index}`, check: 'unit', error: rule.error, goal: rule.goal, source: 'a reflection' });
  const records = trials.readRules(root);
  assert.equal(records.filter(record => record.state === 'trial').length, 5);
  assert.match(records[0].reason, /oldest made room/);
  assert.equal(trials.startTrial(root, { rule: 'Rule 5 about fetchUser retries.', lessonKey: 'k5', check: 'unit', error: rule.error, goal: rule.goal }).id,
    records[5].id, 'the same rule goes on trial once');
  assert.equal(trials.retired(records, 'Rule 0 about fetchUser retries.'), false, 'a rule that only made room may come back');
  assert.equal(trials.matchingTrials(records, 'Make fetchUser retries configurable', ['unit']).length, 3);
  assert.deepEqual(trials.matchingTrials(records, 'Update the README', ['unit']), [], 'no shared words, no rule');
  assert.deepEqual(trials.matchingTrials(records, 'Make fetchUser retries configurable', ['lint']), [], 'its check does not run here');
  const long = Array.from({ length: 3 }, (_, index) => ({ id: `l${index}`, rule: 'x'.repeat(300) }));
  assert.equal(trials.trialBlock(long).records.length, 2, 'the block stays within its limit');
  assert.equal(trials.trialBlock([]).block, null);
});

test('a kept rule joins kept-rules.md under one heading as one dated line, once', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'kept-rules.md');
  fs.writeFileSync(file, '# Project instructions\n\nStay small.\n\n## Other\n\nKeep this.\n');
  const record = { rule: 'Export fetchUser by name.', keptAt: Date.parse('2026-10-21T10:00:00Z') };
  assert.equal(trials.keepInInstructions(file, record), '- Export fetchUser by name. (kept 2026-10-21)');
  trials.keepInInstructions(file, { rule: 'Second rule.', keptAt: record.keptAt });
  trials.keepInInstructions(file, record);
  const body = fs.readFileSync(file, 'utf8');
  assert.equal(body.split(trials.HEADING).length, 2, 'one heading');
  assert.match(body, /## Rules Harness learned\n\n- Export fetchUser by name\. \(kept 2026-10-21\)\n- Second rule\. \(kept 2026-10-21\)\n$/);
  assert.equal(body.match(/Export fetchUser by name/g).length, 1, 'a rule is added once');
  assert.match(body, /## Other\n\nKeep this\./);
  fs.writeFileSync(file, 'x'.repeat(64 * 1024 - 10));
  assert.throws(() => trials.keepInInstructions(file, { rule: 'Too much.', keptAt: record.keptAt }), /64 KiB/);
});

test('with ten always-on rules a winner takes the place of the one tasks matched least recently; with all ten pinned it is kept on demand', t => {
  const root = tempRoot(t);
  for (let index = 0; index < trials.MAX_KEPT; index++)
    trials.updateRules(root, records => records.push({ ...rule, id: `kept${index}`, rule: `Kept rule ${index}.`, state: 'kept', keptAt: 1,
      lastMatchedAt: index === 4 ? 2 : 100 + index, line: `- Kept rule ${index}. (kept 1970-01-01)` }));
  const win = (text, keptRuleIds = []) => {
    const started = trials.startTrial(root, { rule: text, lessonKey: 'k', check: 'unit', error: rule.error, goal: rule.goal, source: 'a reflection' });
    const carried = (id, kept = []) => ({ ...task(id, [[passing('unit')]]), goal: 'Cache fetchUser results', trialRuleIds: [started.id], keptRuleIds: kept });
    trials.recordOutcomes(root, carried(`${text}a`));
    trials.recordOutcomes(root, carried(`${text}b`));
    return trials.recordOutcomes(root, carried(`${text}c`, keptRuleIds));
  };

  // kept4 matched this very task too, but the choice comes first.
  const [kept] = win('Winner rule.', ['kept4']);
  assert.deepEqual([kept.state, kept.onDemand, kept.displaces], ['kept', undefined, 'kept4']);
  assert.ok(trials.readRules(root).find(entry => entry.id === 'kept4').lastMatchedAt > 2, 'then the task counts as matching it');

  trials.updateRules(root, records => records.forEach(record => {
    record.pinned = record.state === 'kept';
  }));
  const [onDemand] = win('Second winner.');
  assert.deepEqual([onDemand.state, onDemand.onDemand, onDemand.displaces], ['kept', true, undefined], 'pinned rules never move out');
  assert.match(fs.readFileSync(path.join(root, trials.PAGE), 'utf8'), /\*\*Kept\*\* · Second winner\.\n.*for the tasks it matches \(not in kept-rules\.md\)/);
});

test('on-demand rules ride matching tasks after the trials, two at most; past thirty the least used makes room and may come back', t => {
  const root = tempRoot(t);
  const onDemand = index => ({ ...rule, id: `od${index}`, rule: `On demand ${index}.`, state: 'kept', onDemand: true, keptAt: 1, lastMatchedAt: 10 + index });
  trials.updateRules(root, records => records.push(...Array.from({ length: trials.MAX_ON_DEMAND + 1 }, (_, index) => onDemand(index))));
  let records = trials.readRules(root);
  assert.deepEqual(trials.matchingOnDemand(records, 'Make fetchUser retries configurable', ['unit']).map(record => record.id), ['od0', 'od1']);
  assert.deepEqual(trials.matchingOnDemand(records, 'Update the README', ['unit']), []);
  assert.match(trials.keptBlock(records.slice(0, 1)).block, /^Project rules learned from earlier failures here \(follow them unless they conflict with the request\):\n- On demand 0\.$/);

  trials.updateRules(root, current => trials.makeRoomOnDemand(current, 'od0'));
  records = trials.readRules(root);
  assert.deepEqual([records[1].state, records[1].room], ['dropped', true], 'the least used besides the one just added makes room');
  assert.equal(trials.retired(records, 'On demand 1.'), false, 'and may come back');
});

test('undoing the last kept line removes the heading', t => {
  const root = tempRoot(t);
  const file = path.join(root, 'kept-rules.md');
  fs.writeFileSync(file, '# Project instructions\n\nStay small.\n');
  const line = trials.keepInInstructions(file, { rule: 'Only rule.', keptAt: Date.parse('2026-10-21T10:00:00Z') });
  assert.equal(trials.removeKeptLine(fs.readFileSync(file, 'utf8'), line), '# Project instructions\n\nStay small.\n');
});

test('a kept rule a task carried rolls back on a hit unless pinned; a line deleted by hand frees its place; taken-out text never returns', t => {
  const root = tempRoot(t);
  const line = '- Make sure fetchUser is a function before wiring retries. (kept 2026-10-21)';
  const body = `# Project instructions\n\n${trials.HEADING}\n\n${line}\n`;
  trials.updateRules(root, records => records.push(
    { ...rule, id: 'kept', state: 'kept', keptAt: 1, line },
    { ...rule, id: 'pinned', rule: 'Pinned rule.', state: 'kept', keptAt: 1, line: '- Pinned rule. (kept 2026-10-21)', pinned: true }));
  const records = trials.readRules(root);
  assert.deepEqual(trials.carriedKept(records, body, ['unit']).map(record => record.id), ['kept'], 'only a line the worker reads is carried');
  assert.deepEqual(trials.carriedKept(records, body, ['lint']), [], 'and only by a task that runs its check');

  const hit = (id, keptRuleIds) => ({ id, attempts: [{ results: [failing('unit', rule.error)] }], keptRuleIds });
  assert.deepEqual(trials.recordOutcomes(root, { id: 'p', attempts: [{ results: [passing('unit')] }], keptRuleIds: ['kept'] }), [], 'a clean task changes nothing');
  assert.deepEqual(trials.recordOutcomes(root, hit('n', [])), [], 'a task that did not carry it changes nothing');
  assert.deepEqual(trials.recordOutcomes(root, hit('pin', ['pinned'])), [], 'a rule the user put back survives a hit');
  const [rolled] = trials.recordOutcomes(root, hit('h', ['kept']));
  assert.equal(rolled.state, 'rolled back');
  assert.match(fs.readFileSync(path.join(root, trials.PAGE), 'utf8'), /\*\*Rolled back\*\* · Make sure fetchUser/);

  trials.forgetDeletedKept(root, body);
  assert.deepEqual(trials.readRules(root).map(record => [record.id, record.state]), [['kept', 'rolled back'], ['pinned', 'removed']],
    'a kept line missing from kept-rules.md was deleted by hand');
  trials.updateRules(root, entries => entries.push({ ...rule, id: 'dropped', rule: 'Dropped rule.', state: 'dropped', reason: 'the failure it targets came back' }));
  for (const text of [rule.rule, 'Pinned rule.', 'Dropped rule.'])
    assert.equal(trials.startTrial(root, { rule: text, lessonKey: 'k', check: 'unit', error: rule.error, goal: rule.goal, source: 'a reflection' }), null,
      `"${text}" was taken out, so it does not go back on trial`);
});

test('a chat rule rides only tasks that share two words with its request, one at a time, and the chat scanner decides it, not checks', t => {
  const root = tempRoot(t);
  const chat = (id, extra = {}) => ({ ...rule, id, rule: `Chat rule ${id}.`, check: null, error: 'renamed a public export', goal: 'Rename the loader module', ...extra });
  trials.updateRules(root, records => records.push(chat('c1'), chat('c2'), { ...rule, id: 'checked' }));
  let records = trials.readRules(root);
  assert.deepEqual(trials.matchingTrials(records, 'Rename the README', ['unit']).map(record => record.id), [], 'one shared word is not enough');
  assert.deepEqual(trials.matchingTrials(records, 'Rename the loader and add fetchUser retries', ['unit']).map(record => record.id), ['c1', 'checked'],
    'two words carry it, and at most one chat rule rides a task');

  const carrying = { ...task('t1', [[passing('unit')]]), trialRuleIds: ['c1', 'checked'] };
  trials.recordOutcomes(root, carrying);
  records = trials.readRules(root);
  assert.deepEqual(records.find(record => record.id === 'c1').carried, [], 'settling the task leaves the chat rule for the scanner');
  assert.equal(records.find(record => record.id === 'checked').carried.length, 1);

  assert.deepEqual(trials.recordChatVerdicts(root, carrying, [{ id: 'c1', verdict: 'not relevant' }]), []);
  assert.deepEqual(trials.recordChatVerdicts(root, carrying, [{ id: 'c1', verdict: 'avoided' }]), [], 'the same task counts once');
  assert.deepEqual(trials.recordChatVerdicts(root, { ...carrying, id: 't2' }, [{ id: 'c2', verdict: 'avoided' }]), [], 'only rules the task carried');
  trials.recordChatVerdicts(root, { ...carrying, id: 't3' }, [{ id: 'c1', verdict: 'avoided' }]);
  trials.recordChatVerdicts(root, { ...carrying, id: 't4' }, [{ id: 'c1', verdict: 'avoided' }]);
  const [kept] = trials.recordChatVerdicts(root, { ...carrying, id: 't5' }, [{ id: 'c1', verdict: 'avoided' }]);
  assert.deepEqual([kept.id, kept.state], ['c1', 'kept']);
  assert.deepEqual(trials.readRules(root).find(record => record.id === 'c1').carried.map(entry => entry.outcome), ['none', 'clean', 'clean', 'clean']);

  const [dropped] = trials.recordChatVerdicts(root, { ...carrying, id: 't6', trialRuleIds: ['c2'] }, [{ id: 'c2', verdict: 'recurred' }]);
  assert.deepEqual([dropped.state, dropped.reason], ['dropped', 'the mistake it targets came back']);
});

test('a kept chat rule is carried from kept-rules.md only by close matches, stamped when matched, and rolled back by the scanner', t => {
  const root = tempRoot(t);
  const line = '- Keep public export names. (kept 2026-10-21)';
  trials.updateRules(root, records => records.push({ ...rule, id: 'k', rule: 'Keep public export names.', check: null, error: 'renamed a public export',
    goal: 'Rename the loader module', state: 'kept', keptAt: 1, line }));
  const records = trials.readRules(root);
  assert.deepEqual(trials.carriedKept(records, line, [], 'Fix the README'), []);
  assert.deepEqual(trials.carriedKept(records, line, [], 'Rename the loader again').map(record => record.id), ['k']);

  trials.recordOutcomes(root, { id: 't1', goal: 'Rename the loader again', attempts: [], keptRuleIds: ['k'] });
  assert.ok(trials.readRules(root)[0].lastMatchedAt > 1, 'matched closely, so stamped');
  const [rolled] = trials.recordChatVerdicts(root, { id: 't1', keptRuleIds: ['k'] }, [{ id: 'k', verdict: 'recurred' }]);
  assert.deepEqual([rolled.state, rolled.reason], ['rolled back', 'the mistake it targets came back after it was kept']);
});
