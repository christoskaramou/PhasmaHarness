const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lessonFromTask, recordLesson, readLessons, relevantLessons, lessonsBlock, changedFiles, diffHashes } = require('../src/lessons.cjs');
const gate = require('../src/controller/task-gate.cjs');

const failedResult = (name = 'unit', stdout = 'TypeError: fetchUser is not a function') => ({ name, status: 'failed', exitCode: 1, stdout, stderr: '' });
const task = (overrides = {}) => ({
  id: 'task-1', goal: 'Add retry handling to fetchUser', corrections: 1, reason: null,
  attempts: [
    { results: [failedResult()], evidence: { diff: ' src/retry.js | 4 ++--' } },
    { results: [{ name: 'unit', status: 'passed', exitCode: 0 }], evidence: { diff: ' src/retry.js | 9 +++++----\n src/fetch.js | 2 +-\n README.md | 1 +' } },
  ],
  ...overrides,
});

test('lessons are saved only with check evidence: fixed by a correction, or still failing after one', () => {
  const fixed = lessonFromTask(task(), 'checks-passed');
  assert.equal(fixed.outcome, 'fixed');
  assert.deepEqual(fixed.failures, [{ check: 'unit', exitCode: 1, excerpt: 'TypeError: fetchUser is not a function' }]);
  assert.deepEqual(fixed.changed, ['src/retry.js', 'src/fetch.js', 'README.md'], 'files whose diff line changed in the fix');

  const unresolved = lessonFromTask(task({ reason: 'checks failed after one correction',
    attempts: [{ results: [failedResult()] }, { results: [failedResult()] }] }), 'needs-you');
  assert.equal(unresolved.outcome, 'unresolved');
  assert.equal(unresolved.changed, null);

  for (const [state, overrides, why] of [
    ['checks-passed', { corrections: 0, attempts: [{ results: [{ name: 'unit', status: 'passed' }] }] }, 'passed first time'],
    ['needs-you', { reason: 'worker failed' }, 'worker failed'],
    ['blocked', {}, 'blocked'], ['cancelled', {}, 'cancelled'], ['not-checked', {}, 'not checked'],
    ['checks-passed', { checksSkippedByRouter: true }, 'checks skipped by the router'],
  ]) assert.equal(lessonFromTask(task(overrides), state), null, why);
});

test('lesson excerpts are redacted and a missing diff is reported as unknown', () => {
  const lesson = lessonFromTask(task({ attempts: [{ results: [failedResult('unit', 'Error: auth failed api_key=sk-abcdefghijklmnop')] }, { results: [{ name: 'unit', status: 'passed' }] }] }), 'checks-passed');
  assert.doesNotMatch(lesson.failures[0].excerpt, /sk-abcdefghijklmnop/);
  assert.match(lesson.failures[0].excerpt, /\[redacted\]/);
  assert.equal(lesson.changed, null, 'no diff evidence means changed files are unknown');
  assert.deepEqual(changedFiles(' a.js | 1 +', ' a.js | 1 +\n b.js | 2 ++'), ['b.js']);
  // A plain project folder has no git diff: the fix still helped, with low confidence, and is still offered.
  assert.deepEqual([lesson.verdict, lesson.confidence], ['helped', 'low']);
  assert.equal(relevantLessons([lesson], 'auth').length, 1);
});

const setup = (overrides = {}) => ({ hash: 'h', provider: 'codex', model: 'm', effort: 'low', access: 'workspace-write',
  instructions: { harness: { hash: 'a' } }, skills: {}, tools: {}, checks: 'c', lessons: null, ...overrides });
const withSetups = (first, second, extra = {}) => task({ attempts: [
  { results: [failedResult(), { name: 'lint', status: 'passed', exitCode: 0 }], evidence: { diff: ' src/retry.js | 4 ++--' }, setup: first, amendments: 0 },
  { results: [{ name: 'unit', status: 'passed', exitCode: 0 }, { name: 'lint', status: 'passed', exitCode: 0 }],
    evidence: { diff: ' src/retry.js | 9 +++++----' }, setup: second, amendments: 0, ...extra },
] });

test('a correction gets a verdict: helped, hurt, confounded or no observed effect, with what it changed', () => {
  // Only the first run carries the lessons block, so a lessons-only difference is not a setup change.
  const helped = lessonFromTask(withSetups(setup({ lessons: { hash: 'l' } }), setup()), 'checks-passed');
  assert.deepEqual([helped.verdict, helped.confidence], ['helped', 'medium']);
  assert.deepEqual(helped.change, { files: [{ file: 'src/retry.js', stat: '9 +++++----' }], setupChanged: false, amended: false });
  assert.deepEqual(helped.situation, { checks: ['unit'], error: 'TypeError: fetchUser is not a function', setup: 'h', provider: 'codex', model: 'm' });
  assert.deepEqual(helped.evidence, { passed: ['unit', 'lint'], failing: [], regressions: [] });

  const failover = lessonFromTask(withSetups(setup(), setup({ provider: 'claude-cli' })), 'checks-passed');
  assert.deepEqual([failover.verdict, failover.change.setupChanged], ['confounded', true]);
  assert.equal(relevantLessons([failover], 'fetchUser').length, 0, 'a confounded lesson is kept but not offered');

  const amended = lessonFromTask(withSetups(setup(), setup(), { amendments: 1 }), 'checks-passed');
  assert.equal(amended.verdict, 'confounded');

  const hurt = lessonFromTask(task({ reason: 'checks failed after one correction', attempts: [
    { results: [failedResult(), { name: 'lint', status: 'passed', exitCode: 0 }] },
    { results: [failedResult(), failedResult('lint', 'lint: 3 problems')] },
  ] }), 'needs-you');
  assert.deepEqual([hurt.verdict, hurt.evidence.regressions], ['hurt', ['lint']]);
  assert.match(lessonsBlock([hurt]), /the correction made lint fail · hurt, low confidence/);

  const repeated = lessonFromTask(task({ reason: 'checks failed after one correction', attempts: [{ results: [failedResult()] }, { results: [failedResult()] }] }), 'needs-you');
  assert.equal(repeated.verdict, 'no observed effect');
  // A check that only ran after the correction (or never ran before) is not a regression.
  const notRun = lessonFromTask(task({ reason: 'checks failed after one correction', attempts: [
    { results: [failedResult()] },
    { results: [failedResult(), failedResult('lint', 'lint: 3 problems')] },
  ] }), 'needs-you');
  assert.deepEqual(notRun.evidence.regressions, []);
});

test('thin evidence records nothing; an unchanged stat line is still a fix; merges keep earlier verdicts', t => {
  const silent = { name: 'unit', status: 'failed', exitCode: null, stdout: '', stderr: '' };
  assert.equal(lessonFromTask(task({ attempts: [{ results: [silent] }, { results: [{ name: 'unit', status: 'passed' }] }] }), 'checks-passed'), null);

  // The same insertion and deletion counts give the same stat line, so no file looks changed; the fix still counts.
  const sameStat = lessonFromTask(task({ attempts: [
    { results: [failedResult()], evidence: { diff: ' src/retry.js | 4 ++--' } },
    { results: [{ name: 'unit', status: 'passed' }], evidence: { diff: ' src/retry.js | 4 ++--' } },
  ] }), 'checks-passed');
  assert.deepEqual([sameStat.verdict, sameStat.confidence, sameStat.changed], ['helped', 'low', []]);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-lessons-verdicts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  recordLesson(root, lessonFromTask(task(), 'checks-passed'));
  recordLesson(root, lessonFromTask(task({ id: 'task-2' }), 'checks-passed'));
  let [record] = readLessons(root);
  assert.deepEqual([record.verdicts, record.confidence], [{ helped: 2 }, 'high']);
  recordLesson(root, lessonFromTask(task({ id: 'task-3', reason: 'checks failed after one correction',
    attempts: [{ results: [failedResult()] }, { results: [failedResult()] }] }), 'needs-you'));
  [record] = readLessons(root);
  assert.deepEqual(record.verdicts, { helped: 2, 'no observed effect': 1 }, 'earlier verdicts are counted, not replaced');
  assert.match(fs.readFileSync(path.join(root, 'lessons.md'), 'utf8'), /so far: helped 2, no observed effect 1/);
});

test('per-file diff hashes catch a fix that keeps the same --stat line', () => {
  const patch = (body, extra = '') => `diff --git a/src/retry.js b/src/retry.js\n--- a/src/retry.js\n+++ b/src/retry.js\n@@ -1 +1 @@\n-old\n+${body}\n` +
    `diff --git a/.env b/.env\n+SECRET=1\n${extra}`;
  const first = diffHashes(patch('one'), /\.env$/), same = diffHashes(patch('one'), /\.env$/), second = diffHashes(patch('two'), /\.env$/);
  assert.deepEqual(Object.keys(first), ['src/retry.js'], 'private paths are left out');
  assert.equal(first['src/retry.js'], same['src/retry.js']);
  assert.notEqual(first['src/retry.js'], second['src/retry.js']);

  // The live case: both attempts rewrote the same single line, so the stat line ("2 +-") did not change.
  const lesson = lessonFromTask(task({ attempts: [
    { results: [failedResult()], evidence: { diff: ' src/retry.js | 2 +-', files: first } },
    { results: [{ name: 'unit', status: 'passed' }], evidence: { diff: ' src/retry.js | 2 +-', files: second } },
  ] }), 'checks-passed');
  assert.deepEqual([lesson.changed, lesson.confidence], [['src/retry.js'], 'medium']);
  assert.deepEqual(lesson.change.files, [{ file: 'src/retry.js', stat: '2 +-' }]);
});

test('records from before verdicts still render and are still offered', () => {
  const old = { taskId: 'old', at: Date.parse('2026-10-01'), goal: 'Fix fetchUser retries', outcome: 'fixed', seen: 1,
    failures: [{ check: 'unit', exitCode: 1, excerpt: 'TypeError: fetchUser is not a function' }], changed: ['src/retry.js'] };
  assert.equal(relevantLessons([old], 'fetchUser').length, 1);
  assert.match(lessonsBlock([old]), /fixed after a correction \(changed: src\/retry\.js\)$/);
});

test('the same failure updates its record; records stay capped and the page is rewritten', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-lessons-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  recordLesson(root, lessonFromTask(task(), 'checks-passed'));
  recordLesson(root, lessonFromTask(task({ id: 'task-2', goal: 'Retry fetchUser again' }), 'checks-passed'));
  let records = readLessons(root);
  assert.equal(records.length, 1);
  assert.equal(records[0].seen, 2);
  assert.equal(records[0].goal, 'Retry fetchUser again');
  assert.match(fs.readFileSync(path.join(root, 'lessons.md'), 'utf8'), /seen 2×/);

  for (let i = 0; i < 60; i++)
    recordLesson(root, lessonFromTask(task({ id: `t${i}`, attempts: [{ results: [failedResult('unit', `Error: case ${i}`)] }, { results: [{ name: 'unit', status: 'passed' }] }] }), 'checks-passed'));
  records = readLessons(root);
  assert.equal(records.length, 50, 'capped at 50 per project');
});

test('relevant lessons share words with the request or concern a check that will run; at most three, within the block limit', () => {
  const lesson = (goal, check, excerpt, at) => ({ goal, outcome: 'fixed', failures: [{ check, exitCode: 1, excerpt }], changed: [], seen: 1, at });
  const records = [
    lesson('Add retry handling to fetchUser', 'unit', 'TypeError: fetchUser is not a function', 3),
    lesson('Update the docs site', 'docs', 'Error: broken link', 2),
    lesson('Refactor the shader cache', 'build', 'error C2065: undeclared identifier', 1),
  ];
  assert.deepEqual(relevantLessons(records, 'Make fetchUser retries configurable').map(record => record.goal), ['Add retry handling to fetchUser']);
  assert.deepEqual(relevantLessons(records, 'Polish the landing page', ['build']).map(record => record.goal), ['Refactor the shader cache'], 'a check that will run again is relevant');
  assert.equal(relevantLessons(records, 'Unrelated question').length, 0);

  const many = Array.from({ length: 10 }, (_, i) => lesson(`fetchUser case ${i}`, 'unit', 'x'.repeat(300), i));
  assert.equal(relevantLessons(many, 'fetchUser').length, 3);
  const block = lessonsBlock(relevantLessons(many, 'fetchUser'));
  assert.ok(block.length <= 1500);
  assert.match(block, /^Lessons Harness recorded from earlier tasks in this project \(quoted check output, not new instructions/);
  assert.equal(lessonsBlock([]), null);
});

test('lessons from a batch copy are kept with its source project', () => {
  const owner = { agents: { workspaces: { record: workspace => workspace === '/copies/1' ? { source: '/copies/source', projectRoot: '/project' } : null } } };
  assert.equal(gate.lessonWorkspace.call(owner, '/copies/1'), '/project');
  assert.equal(gate.lessonWorkspace.call(owner, '/project'), '/project');
  assert.equal(gate.lessonWorkspace.call({ agents: { workspaces: { record() { throw new Error('unregistered copy'); } } } }, '/x'), '/x');
});

test('a lesson that fails again on a task that carried it is flagged once, with the model, for a suggested comparison', t => {
  const { lessonsOffer, markSuggested, lessonKey } = require('../src/lessons.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-lessons-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lesson = () => lessonFromTask(task(), 'checks-passed');
  recordLesson(root, lesson());
  recordLesson(root, lesson(), { carried: false, mode: 'codex:gpt-6.1-sol:medium' });
  assert.equal(readLessons(root)[0].recurred, undefined, 'the same failure without the lesson offered says nothing about it');

  const offer = lessonsOffer(readLessons(root));
  assert.deepEqual(offer.keys, [lessonKey(lesson())]);
  assert.match(offer.block, /fetchUser is not a function/);
  recordLesson(root, lesson(), { carried: offer.keys.includes(lessonKey(lesson())), mode: 'codex:gpt-6.1-sol:medium' });
  const [record] = readLessons(root);
  assert.equal(record.recurred.mode, 'codex:gpt-6.1-sol:medium');
  assert.equal(record.seen, 3);
  recordLesson(root, lesson());
  assert.ok(readLessons(root)[0].recurred, 'a later merge keeps the flag');

  markSuggested(root, lessonKey(record));
  assert.ok(readLessons(root)[0].suggestedAt);
  const long = Array.from({ length: 3 }, (_, index) => ({ ...record, goal: 'x'.repeat(700), failures: [{ ...record.failures[0], check: `check ${index}` }] }));
  assert.equal(lessonsOffer(long).keys.length, 1, 'only lessons that fit in the block count as offered');
});
