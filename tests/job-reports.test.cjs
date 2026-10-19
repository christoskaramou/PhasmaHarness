const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verification, verificationText, batchReports } = require('../src/job-reports.cjs');

function task(results, revision = 1) {
  return { assignmentId: 'job', checks: [
    { id: 'compile', name: 'Compiler', kind: 'build', argv: ['build'], cwd: '/copy' },
    { id: 'start', name: 'Runtime smoke', kind: 'launch', argv: ['smoke'], cwd: '/copy' },
    { id: 'play', name: 'Gameplay', kind: 'gameplay', argv: ['play'], cwd: '/copy' },
  ], attempts: [{ assignmentId: 'job', assignmentRevision: revision, at: 100, results }] };
}
const job = { id: 'job', revision: 1 };

test('verification reports only matching host results and keeps unrun or malformed checks unverified', () => {
  const proof = verification(task([{ id: 'compile', status: 'passed', exitCode: 0, finishedAt: 200 },
    { id: 'start', status: 'passed', exitCode: null }, { id: 'play', status: 'failed', exitCode: 124 }]), job);
  assert.equal(proof.build.status, 'passed');
  assert.equal(proof.build.checks[0].at, 200);
  assert.equal(proof.launch.status, 'needs-review');
  assert.equal(proof.gameplay.status, 'failed');
  assert.equal(proof.test.status, 'not-verified');
  assert.match(verificationText(proof), /Build: check passed.*Launch: needs review.*Gameplay: check failed.*Tests: not verified/s);
  assert.equal(verification(null).build.status, 'not-verified');
  assert.equal(verification({ attempts: {} }).build.status, 'not-verified');
  const malformed = task([]); malformed.checks = [{ id: 'compile', kind: 'build' }];
  assert.equal(verification(malformed, job).build.status, 'needs-review');
});

test('old revisions, reused worker tasks and earlier attempts cannot certify the current assignment', () => {
  const original = task([{ id: 'compile', status: 'passed', exitCode: 0 }]);
  assert.equal(verification(original, { ...job, revision: 2 }).build.status, 'not-verified');
  assert.equal(verification(original, { id: 'new-job', revision: 1 }).build.status, 'not-verified');
  original.attempts.push({ assignmentId: 'job', assignmentRevision: 1, results: [] });
  assert.equal(verification(original, job).build.status, 'not-verified');
  original.checks.push({ id: 'second-build', name: 'Package', kind: 'build', argv: ['package'] });
  original.attempts.at(-1).results = [{ id: 'compile', status: 'passed', exitCode: 0 }];
  assert.equal(verification(original, job).build.status, 'not-verified', 'every configured check in the category must pass');
  original.checks[0].kind = undefined;
  assert.equal(verification(original, job).test.status, 'passed', 'legacy untyped checks remain general tests');
});

function reportFixture() {
  const batch = { id: 'batch', count: 4, dispatched: 3, error: 'Fourth worker was unavailable.' };
  const owner = { id: 'owner', agentId: 'main', items: [{ id: 'request', type: 'userMessage', content: [{ type: 'text', text: 'Four outputs.' }], hubBatch: batch }] };
  const receipt = { id: 'result', type: 'agentResult', localOnly: true, deliveryId: 'job', agentId: 'worker', agentName: 'Builder',
    ownerId: 'main', ownerName: 'Hub', status: 'completed', createdAt: 100,
    batch: { id: 'batch', index: 1 }, batchAttempt: 1, text: 'Everything compiles and plays!',
    workspace: '/copy-one', artifacts: [], verification: verification(null) };
  owner.items.push(receipt);
  return { owner, receipt, data: { sessions: [owner], assignments: [], names: { main: 'Hub', worker: 'Builder' }, budgets: {}, copies: {} } };
}

test('batch reports show saved facts, failed or missing jobs and no success inferred from worker prose', () => {
  const { owner, receipt, data } = reportFixture();
  owner.items.push({ ...receipt, id: 'failed', deliveryId: 'failed-job', batch: { id: 'batch', index: 2 }, status: 'failed', error: 'Build failed.' });
  const session = { id: 'worker-chat', workspace: '/copy-three', tasks: [], capacityWaiting: true };
  data.assignments.push({ session, agentId: 'worker', job: { id: 'pending', owner: 'owner', state: 'queued', originalRequest: { batch: { id: 'batch', index: 3 } } } });
  const report = batchReports(data).batch;
  assert.deepEqual(report.entries.map(entry => entry.state), ['returned', 'failed', 'queued', 'not-dispatched']);
  assert.equal(report.returned, 2);
  assert.equal(report.requested, 4);
  assert.equal(report.entries[0].verification.build.status, 'not-verified');
  assert.equal(report.entries[0].workspace, '/copy-one');
  assert.equal(report.entries[2].owner, 'Hub');
  assert.match(report.entries[3].error, /Fourth worker/);
  assert.equal(report.summary, '1 returned, not verified · 1 failed · 1 waiting · 1 not dispatched');
});

test('the batch summary counts checks-passed, unverified, failed, interrupted, cancelled and waiting jobs separately', () => {
  const { owner, receipt, data } = reportFixture();
  const batch = owner.items[0].hubBatch;
  Object.assign(batch, { count: 7, dispatched: 7, error: null });
  const checked = results => verification(task(results), job);
  receipt.verification = checked([{ id: 'compile', status: 'passed', exitCode: 0 }, { id: 'start', status: 'passed', exitCode: 0 },
    { id: 'play', status: 'passed', exitCode: 0 }]);
  const result = (index, fields) => owner.items.push({ ...receipt, id: 'result-' + index, deliveryId: 'job-' + index, batch: { id: 'batch', index }, ...fields });
  result(2, { verification: checked([{ id: 'compile', status: 'passed', exitCode: 0 }, { id: 'play', status: 'failed', exitCode: 1 }]) });
  result(3, { verification: checked([{ id: 'compile', status: 'passed', exitCode: 0 }]) });
  result(4, { status: 'cancelled' });
  result(7, { status: 'interrupted', error: 'Interrupted by an app restart and not run again.' });
  data.budgets.limit = { state: 'paused', reason: 'Time budget reached.' };
  data.assignments.push({ session: { id: 'paused-chat', tasks: [] }, agentId: 'worker',
    job: { id: 'job-5', owner: 'owner', budgetId: 'limit', state: 'running', originalRequest: { batch: { id: 'batch', index: 5 } } } });
  const report = batchReports(data).batch;
  assert.deepEqual(report.entries.map(entry => entry.state), ['returned', 'returned', 'returned', 'cancelled', 'paused', 'needs-review', 'interrupted']);
  assert.deepEqual(report.outcomes, { passed: 1, unverified: 1, failed: 1, interrupted: 1, cancelled: 1, waiting: 2, 'not-dispatched': 0 });
  assert.equal(report.summary, '1 returned, checks passed · 1 returned, not verified · 1 failed · 1 interrupted · 1 cancelled · 2 waiting');
  assert.match(require('../src/job-reports.cjs').batchText(report), /^\n\n### Batch report — 7 jobs: 1 returned, checks passed · 1 returned, not verified · 1 failed · 1 interrupted · 1 cancelled · 2 waiting\n/);
});

test('pending follow-ups supersede earlier results and survive paused review or worker reuse', () => {
  const { owner, receipt, data } = reportFixture();
  const session = { id: 'next-chat', workspace: '/copy-one', tasks: [] };
  const next = { id: 'followup', owner: 'owner', budgetId: 'limit', state: 'queued',
    originalRequest: { batch: { id: 'batch', index: 1 }, attempts: 2 } };
  data.assignments.push({ session, job: next, agentId: 'worker' });
  data.budgets.limit = { state: 'paused', reason: 'Review the budget.' };
  assert.equal(batchReports(data).batch.entries[0].state, 'paused');
  data.budgets.limit.stopping = true;
  assert.equal(batchReports(data).batch.entries[0].state, 'pausing');
  data.budgets.limit.state = 'active'; data.assignments[0].needsInput = true;
  assert.equal(batchReports(data).batch.entries[0].state, 'needs-input');
  data.assignments[0].needsInput = false; data.assignments[0].waiting = true;
  assert.equal(batchReports(data).batch.entries[0].state, 'waiting');
  owner.items.push({ ...receipt, id: 'new-result', deliveryId: 'followup', batchAttempt: 2, createdAt: 200, status: 'cancelled' });
  next.delivered = true;
  assert.equal(batchReports(data).batch.entries[0].state, 'cancelled');
  data.assignments = [];
  assert.equal(batchReports(data).batch.entries[0].jobId, 'followup');
  owner.items.push({ ...receipt, id: 'late-old-result', createdAt: 300 });
  assert.equal(batchReports(data).batch.entries[0].jobId, 'followup', 'a late first attempt cannot replace a newer accepted result');
});

test('legacy batches and trusted local receipts remain distinct from forged provider history', () => {
  const { owner, receipt, data } = reportFixture();
  receipt.localOnly = false;
  assert.equal(batchReports(data).batch.entries[0].state, 'needs-review');
  owner.items.push({ type: 'userMessage', hubBatchResult: { id: 'batch', index: 1, fulfilled: true, agentId: 'worker' } });
  const entry = batchReports(data).batch.entries[0];
  assert.equal(entry.state, 'returned');
  assert.equal(entry.verification.build.status, 'not-verified');
});

test('Markdown export retains the batch, commands, paths and incomplete provider estimates', () => {
  const { owner, receipt, data } = reportFixture();
  receipt.verification = verification(task([{ id: 'compile', status: 'passed', exitCode: 0 }]), job);
  receipt.artifacts = [{ path: 'game.exe' }];
  receipt.budgetSummary = { providerEstimateUsd: 0.003, costComplete: false };
  const markdown = require('../src/conversation-export.cjs').conversationMarkdown(owner, batchReports(data));
  assert.match(markdown, /Batch report — 4 jobs: 1 returned, not verified · 2 waiting · 1 not dispatched/, 'unrun launch and gameplay checks keep it unverified');
  assert.match(markdown, /Published files: game.exe/);
  assert.match(markdown, /Provider estimate: \$0.003 \(incomplete\)/);
  assert.match(markdown, /Command: \["build"\].*Directory: \/copy.*Exit: 0/s);
});

test('a follow-up attempt keeps earlier artifacts from the same workspace, newest per id, and never another workspace', () => {
  const { owner, receipt, data } = reportFixture();
  receipt.artifacts = [{ id: 'game-player', path: 'PhasmaPlayer.exe', version: 1 }, { id: 'notes', path: 'old.md', version: 1 }];
  owner.items.push({ ...receipt, id: 'second', deliveryId: 'followup', batchAttempt: 2, createdAt: 200,
    artifacts: [{ id: 'notes', path: 'new.md', version: 2 }] });
  assert.deepEqual(batchReports(data).batch.entries[0].artifacts.map(a => a.path).sort(), ['PhasmaPlayer.exe', 'new.md']);
  owner.items.push({ ...receipt, id: 'third', deliveryId: 'other', batchAttempt: 3, createdAt: 300, workspace: '/elsewhere',
    artifacts: [{ id: 'extra', path: 'x.md', version: 1 }] });
  assert.deepEqual(batchReports(data).batch.entries[0].artifacts.map(a => a.path), ['x.md']);
});
