const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseChecklist, resolveCitations } = require('../src/tasks.cjs');

test('checklist parser preserves proposals and refuses missing or malformed blocks', () => {
  assert.deepEqual(parseChecklist('Done when:\n- First\n- Second\n- Third\n\nResult'), { proposedChecklist: ['First', 'Second', 'Third'], checklistStatus: 'proposed' });
  assert.equal(parseChecklist('A reply without criteria').checklistStatus, 'none-proposed');
  assert.equal(parseChecklist('Done when:\n- Too few').checklistStatus, 'unparseable');
  assert.equal(parseChecklist('Done when:\n' + Array(7).fill('- Item').join('\n')).checklistStatus, 'unparseable');
  assert.equal(parseChecklist('Done when:\n- ' + 'x'.repeat(501)).proposedChecklist, null);
});

test('citation signals resolve current files with bounded reads and workspace/private exclusions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-citations-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'example.js'), 'one\ntwo\n');
  fs.writeFileSync(path.join(root, '.env'), 'secret');
  fs.writeFileSync(path.join(root, 'large.js'), 'x'.repeat(65537));
  const results = resolveCitations(root, '[file](example.js:1-2) `example.js:3` missing.js:1 .env:1 ../outside.js:1 large.js:1').references;
  assert.deepEqual(results.map(r => r.status), ['resolved', 'unresolved', 'unresolved', 'unassessed', 'unassessed', 'unassessed']);
  fs.mkdirSync(path.join(root, 'nested'));
  fs.symlinkSync(root, path.join(root, 'nested', 'escape'), 'junction');
  assert.equal(resolveCitations(path.join(root, 'nested'), 'escape/example.js:1').references[0].status, 'unassessed');
  assert.equal(resolveCitations(root, Array.from({length:25}, (_, i) => `example.js:${i+1}`).join(' ')).references.length, 20);
});
const { shouldTrack, createTask, gateOutcome, summaryLine, correctionText, validateChecks, confirmTermination, identityFromProbe, MEASURED_REAP } = require('../src/tasks.cjs');

test('task tracking defaults on and only explicit off skips it', () => {
  for (const mode of [undefined, 'on', 'auto']) assert.equal(shouldTrack(mode), true);
  assert.equal(shouldTrack('off'), false);
});

test('no checks is not a pass, and blocked or unknown prevents correction', () => {
  assert.equal(gateOutcome({ workerOutcome: 'completed', results: [] }), 'not-checked');
  assert.equal(gateOutcome({ workerOutcome: 'completed', results: [{ status: 'passed' }] }), 'checks-passed');
  assert.equal(gateOutcome({ workerOutcome: 'failed', results: [{ status: 'passed' }] }), 'needs-you');
  assert.equal(gateOutcome({ workerOutcome: 'completed', results: [{ status: 'failed' }], corrections: 0 }), 'correcting');
  assert.equal(gateOutcome({ workerOutcome: 'completed', results: [{ status: 'failed' }], corrections: 1 }), 'needs-you');
  assert.equal(gateOutcome({ workerOutcome: 'completed', results: [{ status: 'failed' }, { status: 'blocked' }] }), 'blocked');
  assert.equal(gateOutcome({ workerOutcome: 'completed', results: [{ status: 'failed' }, { status: 'unknown' }] }), 'blocked');
  assert.equal(gateOutcome({ workerOutcome: 'failed', results: [{ status: 'blocked' }] }), 'needs-you');
  assert.equal(gateOutcome({ workerOutcome: 'completed', results: [{ status: 'failed' }], cancelled: true }), 'cancelled');
  assert.equal(gateOutcome({ workerOutcome: 'interrupted', results: [{ status: 'failed' }] }), 'cancelled');
});

test('summaries and correction text keep the failed output', () => {
  const passed = { state: 'needs-you', corrections: 0, attempts: [{ workerOutcome: 'failed', results: [{ status: 'passed' }] }] };
  assert.equal(summaryLine(passed), 'Worker turn failed · configured checks passed');
  const mixed = {
    state: 'blocked', corrections: 0, reason: null,
    attempts: [{ results: [{ status: 'failed', name: 'unit', stdout: 'boom' }, { status: 'blocked', detail: 'missing program' }] }],
  };
  assert.equal(summaryLine(mixed), 'Blocked: missing program');
  const task = {
    amendments: [{ text: 'keep the header' }],
    attempts: [{ results: [{ status: 'failed', name: 'unit', exitCode: 2, stdout: 'boom' }] }],
  };
  assert.match(correctionText(task), /unit: exit 2/);
  assert.match(correctionText(task), /boom/);
  assert.match(correctionText(task), /keep the header/);
});

test('checks stay inside the workspace and within the timeout bounds', () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-checks-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-checks-out-'));
  try {
    const checks = validateChecks(workspace, [{ name: 'unit', argv: ['node', '-e', '0'], cwd: workspace, timeoutMs: 120000, readOnlySafe: true }]);
    assert.equal(checks[0].argv[0], 'node');
    assert.equal(checks[0].readOnlySafe, true);
    assert.throws(() => validateChecks(workspace, [{ name: 'bad', argv: ['node'], cwd: outside, timeoutMs: 1000 }]), /inside the workspace/);
    assert.throws(() => validateChecks(workspace, [{ name: 'bad', argv: [], cwd: workspace, timeoutMs: 1000 }]), /argument list/);
    assert.throws(() => validateChecks(workspace, [{ name: 'bad', argv: ['node'], cwd: workspace, timeoutMs: 999 }]), /timeout/);
    assert.throws(() => validateChecks(workspace, Array.from({ length: 11 }, (_, index) => ({ name: `c${index}`, argv: ['node'], cwd: workspace, timeoutMs: 1000 }))), /10 checks/);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('a task keeps its own copy of the checks', () => {
  const checks = [{ id: 'c', name: 'unit', argv: ['node'], cwd: 'C:\\work', timeoutMs: 1000, readOnlySafe: false }];
  const task = createTask({ messageId: 'm', goal: 'fix it', checks, access: 'read-only' });
  checks[0].argv.push('changed');
  assert.deepEqual(task.checks[0].argv, ['node']);
  assert.throws(() => { task.checks.push({}); });
});

test('parent identity decides whether a block can clear', () => {
  const measured = { pid: 7, creationTime: 'a', children: [], runtime: { ...MEASURED_REAP } };
  assert.deepEqual(confirmTermination(measured, () => ({ pid: 7, creationTime: 'a' })), { clear: false, kill: true });
  assert.deepEqual(confirmTermination(measured, () => ({ pid: 7, creationTime: 'reused' })), { clear: true, kill: false });
  assert.deepEqual(confirmTermination(measured, () => ({ status: 'absent' })), { clear: true, kill: false });
  assert.deepEqual(confirmTermination(measured, () => null), { clear: false, kill: false });
  assert.deepEqual(confirmTermination(measured, () => ({ status: 'unknown' })), { clear: false, kill: false });
  const other = { ...measured, runtime: { ...MEASURED_REAP, codexVersion: '0.154.0' } };
  assert.deepEqual(confirmTermination(other, () => ({ status: 'absent' })), { clear: false, kill: false });
  const child = { ...measured, children: [{ pid: 9, creationTime: 'c' }] };
  assert.deepEqual(confirmTermination(child, pid => pid === 9 ? { pid: 9, creationTime: 'c' } : { status: 'absent' }), { clear: false, kill: false });
  assert.deepEqual(confirmTermination(child, pid => pid === 9 ? null : { status: 'absent' }), { clear: false, kill: false });
});

test('a process probe distinguishes absence from a failed lookup', () => {
  assert.deepEqual(identityFromProbe({ status: 0, stdout: '' }, 4), { status: 'absent' });
  assert.equal(identityFromProbe({ status: 0, stdout: '123' }, 4).creationTime, '123');
  assert.equal(identityFromProbe({ error: new Error('ETIMEDOUT'), status: null, stdout: '' }, 4).status, 'unknown');
  assert.equal(identityFromProbe({ status: 1, stdout: '', stderr: 'cim failed' }, 4).status, 'unknown');
});
