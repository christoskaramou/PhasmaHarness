const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { reflectionInput, checkReflection, SCHEMA } = require('../src/reflection.cjs');
const { lessonFromTask, recordLesson, readLessons } = require('../src/lessons.cjs');
const reflection = require('../src/controller/reflection.cjs');

const failed = { name: 'unit', status: 'failed', exitCode: 1, stdout: 'TypeError: fetchUser is not a function\n  at retry.js:12', stderr: '' };
const task = () => ({ id: 'task-1', goal: 'Add retry handling to fetchUser', corrections: 1, startIndex: 0, attempts: [
  { results: [failed] }, { results: [{ name: 'unit', status: 'passed', exitCode: 0 }], evidence: { diff: ' src/retry.js | 2 +-' } }] });
const items = [
  { type: 'userMessage', content: [{ type: 'text', text: 'Add retry handling to fetchUser' }] },
  { type: 'commandExecution', command: 'cat .env', exitCode: 0, aggregatedOutput: 'api_key=sk-abcdefghijklmnop' },
  { type: 'fileChange', changes: [{ path: '.env', diff: '+SECRET=1' }, { path: 'src/retry.js', diff: '+export const fetchUser = retry(load);' }] },
  { type: 'agentMessage', text: 'Renamed fetchUser to loadUser in retry.js.' },
];

test('the reflection sees the task\'s own run, redacted, with private files left out and the newest work kept', () => {
  const { prompt, plain, hash } = reflectionInput(task(), items, '# Project rules\nKeep exports stable.');
  assert.doesNotMatch(prompt, /sk-abcdefghijklmnop|SECRET=1/, 'secrets and private files never reach the model');
  assert.match(plain, /TypeError: fetchUser is not a function/);
  assert.match(plain, /Renamed fetchUser to loadUser/);
  assert.match(JSON.parse(prompt).existingRules, /Keep exports stable/);
  assert.equal(hash, reflectionInput(task(), items, '# Project rules\nKeep exports stable.').hash, 'the same input hashes the same');
  const long = Array.from({ length: 60 }, (_, index) => ({ type: 'agentMessage', text: `step ${index} ` + 'x'.repeat(500) }));
  const trajectory = JSON.parse(reflectionInput(task(), [items[0], ...long], '').prompt).trajectory;
  assert.match(trajectory[0], /^Request: Add retry handling/, 'the task itself always stays');
  assert.match(trajectory.at(-1), /^Worker: step 59 /, 'then the newest work, as much as fits');
  assert.ok(trajectory.join('').length < 11000);
  assert.deepEqual(Object.keys(SCHEMA.properties), ['reflection', 'rule', 'moment', 'reason']);
});

test('a proposed rule is kept only when safe and quoting the run verbatim; keep and rejections are recorded', () => {
  const { plain } = reflectionInput(task(), items, '');
  const rule = 'Keep exported function names when refactoring; check callers before renaming.';
  assert.deepEqual(checkReflection({ reflection: 'rule', rule, moment: 'Renamed fetchUser   to loadUser in retry.js', reason: 'Renaming broke callers.' }, plain),
    { rule, moment: 'Renamed fetchUser to loadUser in retry.js', reason: 'Renaming broke callers.' }, 'whitespace and case may differ');
  assert.match(checkReflection({ reflection: 'rule', rule, moment: 'The worker deleted every test file.', reason: '' }, plain).rejected, /not found/);
  assert.match(checkReflection({ reflection: 'rule', rule: 'See https://example.com/rules first.', moment: 'Renamed fetchUser to loadUser', reason: '' }, plain).rejected, /safety/);
  assert.match(checkReflection({ reflection: 'rule', rule: 'Skip the unit tests when they are slow.', moment: 'Renamed fetchUser to loadUser', reason: '' }, plain).rejected, /safety/);
  assert.match(checkReflection({ reflection: 'rule', rule: 'x'.repeat(301), moment: 'Renamed fetchUser to loadUser', reason: '' }, plain).rejected, /300/);
  assert.deepEqual(checkReflection({ reflection: 'keep', rule: '', moment: '', reason: 'Flaky network.' }, plain), { keep: true, reason: 'Flaky network.' });
  assert.match(checkReflection(null, plain).rejected, /invalid/);
  // A quoted secret is redacted before the check and before it is stored.
  const secret = reflectionInput(task(), [...items, { type: 'agentMessage', text: 'Login failed with api_key=sk-zyxwvutsrqponmlk in the request.' }], '');
  const stored = checkReflection({ reflection: 'rule', rule, moment: 'Login failed with api_key=sk-zyxwvutsrqponmlk in the request', reason: '' }, secret.plain);
  assert.equal(stored.moment, 'Login failed with [redacted] in the request');
});

test('a lesson\'s reflection is asked once per input, saved by re-reading the lessons, and skipped while background work is paused', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-reflection-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const lesson = lessonFromTask(task(), 'checks-passed');
  recordLesson(root, lesson);
  const calls = [], warnings = [];
  const router = { id: 'router', provider: 'codex', model: 'gpt-5.6-terra', label: 'Terra' };
  const owner = { effectiveRouter: () => router, available: () => true, smartRouter: { complete: async request => {
    calls.push(request);
    // Another write lands while the call runs; the save must keep it.
    recordLesson(root, lessonFromTask(task(), 'checks-passed'));
    return { decision: { reflection: 'rule', rule: 'Keep exported function names when refactoring.', moment: 'Renamed fetchUser to loadUser in retry.js', reason: 'Callers broke.' } };
  } } };
  let paused = null;
  const controller = { agents: { primary: owner, backgroundQuota: () => paused }, log: { warn: (...args) => warnings.push(args) } };
  const reflect = () => reflection.reflectOnLesson.call(controller, { items }, task(), lesson, root, root);

  await reflect();
  const [record] = readLessons(root);
  assert.equal(calls.length, 1);
  assert.equal(record.reflection.rule, 'Keep exported function names when refactoring.');
  assert.equal(record.reflection.model, 'Terra');
  assert.equal(record.seen, 2, 'the write made during the call survives');
  assert.match(fs.readFileSync(path.join(root, 'lessons.md'), 'utf8'), /Proposed rule: Keep exported function names when refactoring\. \(from: "Renamed fetchUser to loadUser in retry\.js"\)/);
  assert.equal(reflect(), null, 'the same input is not asked again');

  paused = { provider: 'codex', reason: 'Background work paused.' };
  const other = { ...task(), goal: 'Something new about fetchUser' };
  assert.equal(reflection.reflectOnLesson.call(controller, { items }, other, lesson, root, root), null, 'no call past the background usage limit');
  assert.equal(calls.length, 1);
  assert.deepEqual(warnings, []);
});
