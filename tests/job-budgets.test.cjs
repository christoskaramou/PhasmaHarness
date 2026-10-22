const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JobBudgets, normalizedUsage, usageSummary } = require('../src/job-budgets.cjs');

test('task bots and their children have no default time or attempt limits; explicit limits remain enforced', t => {
  const f = fixture(t), root = f.worker('task', {}, null), child = f.worker('child', root.session);
  const budget = f.budgets.forJob(root.job);
  assert.equal(budget.limitsEnabled, false);
  assert.equal(child.job.budgetId, root.job.budgetId);
  for (let i = 0; i < 25; i++) {
    const handle = f.budgets.beginRequest(root.controller, root.session, { provider: 'codex' });
    f.budgets.report(handle, { usage: { inputTokens: 1, outputTokens: 1 } }, true);
  }
  f.budgets.refresh(); f.tick(121 * 60000); f.budgets.refresh();
  assert.equal(budget.state, 'active');
  assert.equal(root.controller.busy, root.session.id);
  assert.equal(f.budgets.summary(budget.id).limitMs, null);
  assert.equal(f.budgets.summary(budget.id).limitAttempts, null);
  assert.equal(f.budgets.summary(budget.id).attempts, 25);
  const limited = f.worker('maintenance');
  assert.equal(f.budgets.forJob(limited.job).limitsEnabled, true);
});

test('legacy default caps become unlimited while customized limits survive reload', t => {
  const f = fixture(t), root = f.worker('root'), custom = f.worker('custom');
  const saved = structuredClone(f.budgets.records);
  delete saved.root.limitsEnabled; delete saved.custom.limitsEnabled;
  saved.custom.limitAttempts = 5;
  saved.edited = { ...saved.root, id: 'edited', version: 2 };
  const reloaded = fixture(t, saved);
  assert.equal(reloaded.budgets.records.root.limitsEnabled, false);
  assert.equal(reloaded.budgets.records.custom.limitsEnabled, true);
  assert.equal(reloaded.budgets.records.edited.limitsEnabled, true, 'previously edited default-valued limits are preserved');
});

test('paused unlimited tasks resume without introducing caps and still require cleanup', async t => {
  const f = fixture(t), root = f.worker('root', {}, null), budget = f.budgets.forJob(root.job);
  budget.state = 'paused'; budget.usedMs = 121 * 60000;
  const args = { jobId: root.job.id, expectedVersion: budget.version, limitMinutes: 120, resume: true, limitsEnabled: false };
  assert.throws(() => f.budgets.update(args), /cleanup/);
  await root.controller.stop();
  f.budgets.update(args);
  assert.equal(budget.state, 'active');
  assert.equal(budget.limitsEnabled, false);
  assert.equal(root.job.state, 'queued');
  const limited = f.worker('limited');
  assert.throws(() => f.budgets.update({ ...args, jobId: limited.job.id, expectedVersion: 1 }), /Only an unlimited/);
});

function fixture(t, saved = {}) {
  let wall = 1000000, mono = 0, failSave = false, writes = 0;
  const contexts = [], jobs = [], persisted = [];
  const primary = { data: { jobBudgets: saved }, log: { warn() {} }, save() {
    writes++;
    if (failSave) throw new Error('Budget disk failure');
    persisted.push(structuredClone(this.data.jobBudgets));
  } };
  const agents = { primary, closing: false, revisionOperations: new Map(),
    allControllers: () => contexts, pendingJobs: () => jobs, snapshot: () => ({}), emit() {},
    findJob(id) { const found = jobs.find(record => record.job.id === id); if (!found) throw new Error('Unknown assignment'); return found; },
    pump() { budgets.refresh(); } };
  const budgets = new JobBudgets(agents, () => wall, () => mono);
  const worker = (id, source = {}, limits = { limitMs: 7200000, limitAttempts: 20, limitTokens: null }) => {
    const job = { id, state: 'running', delivered: false, startIndex: 0, historyStartIndex: 0 };
    budgets.register(job, source, source.delegation ? null : limits); budgets.persist();
    const session = { id: `session-${id}`, delegation: job, items: [{ text: 'Earlier evidence' }], status: 'running', queue: [] };
    const controller = { busy: session.id, data: { sessions: [session] }, activeTurns: new Map([[session.id, 'turn']]),
      loading: new Set(), stopping: new Set(), cleanupPending: new Set(), blockedReason: () => null,
      save: () => primary.save(), session: () => session,
      async stop() { controller.busy = null; controller.activeTurns.clear(); controller.stopping.clear(); session.status = 'interrupted'; } };
    const record = { controller, session, job }; contexts.push(controller); jobs.push(record); return record;
  };
  t.after(() => budgets.close());
  return { budgets, primary, contexts, jobs, persisted, worker,
    tick(ms) { wall += ms; mono += ms; }, jumpWall(ms) { wall += ms; },
    fail(value) { failSave = value; }, writes: () => writes };
}

test('helpers share a monotonic active-time clock; capacity, quota and idle waits consume none', t => {
  const f = fixture(t), root = f.worker('root'), helper = f.worker('helper', root.session);
  const budget = f.budgets.forJob(root.job);
  assert.equal(helper.job.budgetId, root.job.budgetId);
  f.budgets.refresh(); f.tick(1000); f.jumpWall(500000);
  assert.equal(f.budgets.snapshot().root.usedMs, 1000, 'wall-clock changes cannot exhaust a live lease');
  root.controller.busy = null; f.budgets.refresh(); f.tick(1000);
  assert.equal(f.budgets.elapsed(budget), 2000, 'overlapping helpers share one elapsed clock');
  helper.session.capacityWaiting = true; f.budgets.refresh(); f.tick(100000);
  assert.equal(f.budgets.elapsed(budget), 2000);
  helper.session.capacityWaiting = false; helper.session.quotaWaiting = { reason: 'allowance' };
  f.budgets.refresh(); f.tick(100000);
  assert.equal(f.budgets.elapsed(budget), 2000);
  delete helper.session.quotaWaiting; f.budgets.refresh(); f.tick(3000);
  helper.controller.busy = null; f.budgets.refresh(); f.tick(500000);
  assert.equal(f.budgets.elapsed(budget), 5000);
  assert.equal(budget.activeSince, null);
  assert.equal(f.persisted.at(-1).root.usedMs, 5000);
});

test('exhaustion saves the pause before targeted Stop; extending and Resume retain usage and evidence', async t => {
  const f = fixture(t), root = f.worker('root'), helper = f.worker('helper', root.session), other = f.worker('unrelated');
  const budget = f.budgets.forJob(root.job);
  f.budgets.update({ jobId: root.job.id, expectedVersion: 1, limitMinutes: 1, resume: false });
  let release;
  const originalStop = root.controller.stop;
  root.controller.stop = async () => {
    assert.equal(f.persisted.at(-1).root.state, 'paused');
    await new Promise(resolve => { release = resolve; }); await originalStop();
  };
  f.tick(60001); f.budgets.refresh();
  assert.equal(budget.state, 'paused');
  assert.equal(f.budgets.snapshot().root.stopping, true);
  assert.equal(f.budgets.held(helper.job), true);
  assert.equal(other.controller.busy, other.session.id);
  assert.throws(() => f.budgets.register({ id: 'escape' }, root.session), /budget reached/);
  const update = { jobId: helper.job.id, expectedVersion: budget.version, limitMinutes: 2, resume: true };
  assert.throws(() => f.budgets.update(update), /cleanup to stop/);
  const cleanup = f.budgets.operations.get(budget.id); release(); await cleanup;
  assert.equal(f.budgets.snapshot().root.stopping, false);
  assert.throws(() => f.budgets.update({ ...update, limitMinutes: 1 }), /time already used/);
  f.budgets.update(update);
  assert.equal(budget.state, 'active');
  assert.equal(budget.usedMs, 60001);
  assert.equal(root.job.state, 'queued');
  assert.equal(helper.job.state, 'queued');
  assert.equal(root.job.startIndex, 1);
  assert.equal(root.job.historyStartIndex, 0);
  assert.equal(root.job.budgetResumes, 1);
  assert.throws(() => f.budgets.update(update), /budget changed/);
});

test('budget saves fail closed and retry the open lease instead of silently admitting unrecorded time', t => {
  const f = fixture(t); f.worker('root'); f.fail(true);
  assert.throws(() => f.budgets.refresh(), /Budget disk failure/);
  const count = f.writes();
  assert.throws(() => f.budgets.refresh(), /Budget disk failure/);
  assert.equal(f.writes(), count + 1);
  f.fail(false); f.budgets.refresh();
  assert.equal(f.persisted.at(-1).root.activeSince, 1000000);
});

test('restart pauses open leases with a bounded estimate and rejects corrupt saved budgets', t => {
  const f = fixture(t, { root: { id: 'root', version: 1, state: 'active', limitMs: 60000, usedMs: 1000, activeSince: 1 } });
  const budget = f.budgets.records.root;
  assert.equal(budget.state, 'paused'); assert.equal(budget.estimated, true);
  assert.equal(budget.usedMs, 60000); assert.equal(budget.activeSince, null);
  assert.equal(budget.version, 2);
  assert.throws(() => f.budgets.forMessage({}, { agentResult: { request: { budgetId: 'missing' } } }), /unavailable/);
  assert.equal(f.budgets.held({ budgetId: 'missing' }), true, 'a missing ledger cannot make a job unlimited');
  for (const invalid of [[], { root: { ...budget, version: 0 } }, { root: { ...budget, usedMs: -1 } }, { root: { ...budget, activeSince: 'yesterday' } }])
    assert.throws(() => new JobBudgets({ primary: { ...f.primary, data: { jobBudgets: invalid } } }), /budget.*invalid|budgets need review/);
});

test('failed pause persistence still stops active work and leaves independent deadline timers armed', async t => {
  const f = fixture(t), root = f.worker('root'), other = f.worker('other');
  const budget = f.budgets.forJob(root.job);
  budget.limitMs = 1;
  f.budgets.refresh(); f.tick(2); f.fail(true);
  assert.throws(() => f.budgets.refresh(), /Budget disk failure/);
  const operation = f.budgets.operations.get(budget.id);
  await operation;
  assert.equal(budget.state, 'paused');
  assert.equal(root.controller.busy, null);
  assert.equal(other.controller.busy, other.session.id);
  assert.ok(f.budgets.timer, 'a storage error cannot remove other running jobs’ deadline');
  f.fail(false); f.budgets.refresh();
  assert.equal(f.persisted.at(-1).root.state, 'paused');
});

test('a rejected provider Stop stays visibly unconfirmed and cannot be resumed', async t => {
  const f = fixture(t), root = f.worker('root'), budget = f.budgets.forJob(root.job);
  root.controller.stop = async () => { throw new Error('Interrupt transport failed'); };
  budget.limitMs = 1; f.budgets.refresh(); f.tick(2); f.budgets.refresh();
  await f.budgets.operations.get(budget.id);
  assert.equal(f.budgets.snapshot().root.stopping, true);
  assert.match(budget.reason, /Stop is unconfirmed: Interrupt transport failed/);
  assert.throws(() => f.budgets.update({ jobId: root.job.id, expectedVersion: budget.version,
    limitMinutes: 1, resume: true }), /cleanup to stop/);
});

test('automatic follow-ups retain the original allowance after the root record has been replaced', t => {
  const f = fixture(t), root = f.worker('root');
  const budget = f.budgets.forJob(root.job);
  const continuation = { id: 'follow-up', originalRequest: { id: 'original-message', budgetId: budget.id } };
  assert.equal(f.budgets.register(continuation, {}), false);
  assert.equal(continuation.budgetId, budget.id);
  budget.state = 'paused'; budget.usedMs = 60000; budget.limitMs = 60000;
  f.jobs.splice(0);
  root.controller.busy = null; root.controller.activeTurns.clear();
  root.session.delegation.delivered = true;
  root.session.queuePaused = true;
  root.session.queue = [{ agentReply: true, agentResult: { request: { budgetId: budget.id } } }];
  budget.stoppedSessions = [root.session.id];
  f.budgets.update({ jobId: budget.id, expectedVersion: budget.version, limitMinutes: 2, resume: true });
  assert.equal(budget.state, 'active');
  assert.equal(budget.usedMs, 60000);
  assert.equal(root.session.queuePaused, false);
});

test('usage validation preserves unknown data and counts cached input once', () => {
  assert.deepEqual(normalizedUsage({ input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 5, output_tokens: 10 }),
    { inputTokens: 125, outputTokens: 10, cachedInputTokens: 20, totalTokens: 135 });
  assert.equal(normalizedUsage({ inputTokens: 125, cachedInputTokens: 20, outputTokens: 10 }).totalTokens, 135);
  for (const invalid of [null, {}, { input_tokens: 3 }, { inputTokens: -1, outputTokens: 1 },
    { inputTokens: 10, outputTokens: NaN }, { inputTokens: 1, cachedInputTokens: 2, outputTokens: 0 },
    { inputTokens: '10', outputTokens: 1 }, { inputTokens: -1, outputTokens: 1, input_tokens: 10, output_tokens: 1 }])
    assert.equal(normalizedUsage(invalid), null);
  assert.equal(usageSummary({ requests: {} }).reportedTokens, null);
  assert.equal(usageSummary({ requests: {} }).providerEstimateUsd, null);
  assert.equal(normalizedUsage({ inputTokens: 0, outputTokens: 0 }).totalTokens, 0, 'a real zero report stays distinct from missing usage');
  const overflow = usageSummary({ requests: { first: { complete: true, usage: { totalTokens: Number.MAX_SAFE_INTEGER }, providerEstimateUsd: Number.MAX_VALUE },
    second: { complete: true, usage: { totalTokens: 1 }, providerEstimateUsd: Number.MAX_VALUE } } });
  assert.equal(overflow.reportedTokens, null); assert.equal(overflow.providerEstimateUsd, null);
  assert.equal(overflow.tokensComplete, false); assert.equal(overflow.missingFinalUsage, true);
});

test('stable request reports are cumulative, retain provider estimates and mark missing usage incomplete', t => {
  const f = fixture(t), root = f.worker('root'), budget = f.budgets.forJob(root.job);
  const first = f.budgets.beginRequest(root.controller, root.session, { id: 'first', provider: 'claude-cli' });
  const result = { usage: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 10 }, providerEstimateUsd: 0.04 };
  f.budgets.report(first, result); f.budgets.report(first, result);
  f.budgets.report(first, { usage: { inputTokens: 120, cachedInputTokens: 25, outputTokens: 15 }, providerEstimateUsd: 0.05 }, true);
  f.budgets.report(first, result, true);
  const second = f.budgets.beginRequest(root.controller, root.session, { id: 'second', provider: 'cursor-cli' });
  f.budgets.report(second, {}, true);
  const summary = f.budgets.snapshot().root.usage;
  assert.equal(summary.attempts, 2);
  assert.equal(summary.reportedTokens, 135, 'a repeated report cannot charge cached tokens or a whole turn twice');
  assert.equal(summary.providerEstimateUsd, 0.05);
  assert.equal(summary.tokensComplete, false);
  assert.equal(summary.costComplete, false);
  assert.equal(summary.missingFinalUsage, true);
  assert.equal(Object.hasOwn(f.budgets.snapshot().root, 'requests'), false, 'renderer snapshots contain totals rather than the request ledger');
  assert.equal(f.budgets.inflight.size, 0);
  const saved = f.persisted.at(-1);
  saved.root.requests.first.usage.totalTokens = 0;
  const restored = new JobBudgets({ ...f.budgets.agents, primary: { ...f.primary, data: { jobBudgets: saved } } });
  t.after(() => restored.close());
  assert.equal(restored.snapshot().root.usage.reportedTokens, 135, 'loaded totals are derived from validated counters, not a saved shortcut');
});

test('reported-token limits pause live work, preserve usage and refuse unmetered providers before admission', async t => {
  const f = fixture(t), root = f.worker('root'), budget = f.budgets.forJob(root.job);
  f.budgets.update({ jobId: 'root', expectedVersion: 1, limitMinutes: 120, limitAttempts: 3, limitTokens: 100, resume: false });
  let cancelled = 0;
  const handle = f.budgets.beginRequest(root.controller, root.session, { provider: 'codex', cancel: () => cancelled++ });
  f.budgets.report(handle, { usage: { inputTokens: 100, outputTokens: 10 } });
  assert.equal(budget.state, 'paused'); assert.equal(cancelled, 1);
  assert.match(budget.reason, /reported-token limit/);
  f.budgets.report(handle, { usage: { inputTokens: 100, outputTokens: 10 } }, true);
  await f.budgets.operations.get(budget.id);
  const update = { jobId: 'root', expectedVersion: budget.version, limitMinutes: 120, limitAttempts: 3, limitTokens: 200, resume: true };
  assert.throws(() => f.budgets.update({ ...update, limitTokens: 100 }), /exhausted/);
  f.budgets.update(update);
  assert.equal(usageSummary(budget).reportedTokens, 110);
  assert.throws(() => f.budgets.beginRequest(root.controller, root.session, { provider: 'native:deepseek' }), /cannot report tokens/);
  assert.equal(usageSummary(budget).attempts, 1, 'a refused provider was never admitted');
});

test('attempt ceilings include failures and require an explicit extension without resetting history', async t => {
  const f = fixture(t), root = f.worker('root'), budget = f.budgets.forJob(root.job);
  f.budgets.update({ jobId: 'root', expectedVersion: 1, limitMinutes: 120, limitAttempts: 1, resume: false });
  const handle = f.budgets.beginRequest(root.controller, root.session, { provider: 'codex' });
  f.budgets.report(handle, { uncertain: true }, true);
  assert.throws(() => f.budgets.beginRequest(root.controller, root.session, { provider: 'codex' }), /model-attempt limit/);
  await f.budgets.operations.get(budget.id);
  const update = { jobId: 'root', expectedVersion: budget.version, limitMinutes: 120, limitAttempts: 2, resume: true };
  assert.throws(() => f.budgets.update({ ...update, limitTokens: 500 }), /earlier usage is unknown/);
  f.budgets.update({ ...update, limitTokens: null });
  assert.equal(usageSummary(budget).attempts, 1);
  assert.equal(usageSummary(budget).reportedTokens, null);
  assert.equal(budget.state, 'active');
});

test('a failed admission save creates no live request and retains uncertain usage for review', t => {
  const f = fixture(t), root = f.worker('root'); f.fail(true);
  assert.throws(() => f.budgets.beginRequest(root.controller, root.session, { provider: 'codex' }), { message: 'Budget disk failure', budgetPersistenceFailed: true });
  assert.equal(f.budgets.inflight.size, 0);
  assert.equal(f.budgets.snapshot().root.usage.missingFinalUsage, true);
  f.fail(false);
  f.budgets.records.root.limitTokens = 100;
  assert.throws(() => f.budgets.beginRequest(root.controller, root.session, { provider: 'codex' }), /Earlier model usage is unavailable/);
});

test('scoped asynchronous requests keep their original job and cancellation after foreground work changes', async t => {
  const f = fixture(t), root = f.worker('root'), other = f.worker('other');
  let release, cancelled = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const pending = f.budgets.scoped(root.session, async () => {
    await gate;
    return f.budgets.beginRequest(other.controller, other.session, { kind: 'routing', provider: 'codex', cancel: () => cancelled++ });
  });
  root.controller.busy = null; release();
  const handle = await pending;
  assert.equal(handle.budgetId, 'root');
  const budget = f.budgets.records.root; budget.limitMs = 1;
  f.budgets.refresh(); f.tick(2); f.budgets.refresh();
  assert.equal(cancelled, 1);
  assert.equal(other.controller.busy, other.session.id, 'the new foreground work cannot inherit cancellation of the old request');
  assert.equal(f.budgets.snapshot().root.stopping, true);
  f.budgets.report(handle, { usage: { inputTokens: 1, outputTokens: 1 } }, true);
  await f.budgets.operations.get('root');
  assert.equal(f.budgets.snapshot().root.stopping, false);
});

test('structured formatting retries each have their own durable usage record', async t => {
  const { SmartRouter } = require('../src/routing/smart-router.cjs');
  const f = fixture(t), root = f.worker('root');
  const router = new SmartRouter('unused-fixture-directory');
  router.accountRequest = (choice, cancel) => {
    const handle = f.budgets.beginRequest(root.controller, root.session, { kind: 'routing', ...choice, cancel });
    return result => f.budgets.report(handle, result, true);
  };
  let calls = 0;
  router.completeOnce = async () => ({ decision: ++calls === 1 ? 'not JSON' : '{"answer":"ok"}',
    usage: { inputTokens: 10, outputTokens: 5 }, providerEstimateUsd: 0.01 });
  const result = await router.complete({ prompt: 'Fixture', instructions: 'Fixture', schema: { type: 'object',
    properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } },
  { provider: 'codex', model: 'fixture' }, new AbortController());
  assert.deepEqual(result.decision, { answer: 'ok' });
  const usage = f.budgets.snapshot().root.usage;
  assert.equal(usage.attempts, 2); assert.equal(usage.reportedTokens, 30);
  assert.equal(usage.providerEstimateUsd, 0.02); assert.equal(usage.tokensComplete, true);
});

test('API schema failures retain reported usage and only exhaust the configured token limit', async t => {
  const { SmartRouter } = require('../src/routing/smart-router.cjs');
  const { Providers } = require('../src/providers/providers.cjs');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  for (const limitTokens of [100, 15]) {
    const f = fixture(t), root = f.worker('root');
    f.budgets.update({ jobId: root.job.id, expectedVersion: 1, limitMinutes: 120, limitTokens, resume: false });
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-budget-router-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const router = new SmartRouter(directory);
    router.accountRequest = (choice, cancel) => {
      const handle = f.budgets.beginRequest(root.controller, root.session, { kind: 'routing', ...choice, cancel });
      return result => f.budgets.report(handle, result, true);
    };
    let calls = 0;
    const api = {
      local: { inspect: async () => ({ supported: true, kind: 'llama.cpp' }), exclusive: async (_choice, operation) => operation() },
      provider: () => ({ name: 'Fixture API' }),
      modelRequest: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop',
        message: { content: ++calls === 1 ? 'not JSON' : '{"answer":"ok"}' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } })),
    };
    router.providers = { structured: (...args) => Providers.prototype.structured.call(api, ...args) };
    const pending = router.complete({ instructions: 'Fixture', prompt: 'Fixture', schema: { type: 'object',
      properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } },
    { provider: 'local', model: 'fixture' }, new AbortController());
    if (limitTokens === 100) assert.deepEqual((await pending).decision, { answer: 'ok' });
    else await assert.rejects(pending, /reported-token limit/);
    const budget = f.budgets.snapshot().root;
    assert.equal(calls, limitTokens === 100 ? 2 : 1);
    assert.equal(budget.state, limitTokens === 100 ? 'active' : 'paused');
    assert.equal(budget.usage.reportedTokens, calls * 15);
    assert.equal(budget.usage.tokensComplete, true);
  }
});

test('Jev accounting keeps valid usage from malformed answers and cancellation does not change provider health', async t => {
  const { JevClient } = require('../src/providers/jev.cjs');
  const f = fixture(t), root = f.worker('root');
  const questions = { pick: { type: 'choice', criteria: { yes: 'Yes', no: 'No' } } };
  let malformed = false;
  const client = new JevClient({ configured: true, read: () => 'fixture-only-key' }, async () => ({ ok: true,
    text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: { pick: { type: 'choice', choice: malformed ? 'invalid' : 'yes',
      confidence: 1, probabilities: { yes: 1, no: 0 } } }, usage: { input_tokens: 10, output_tokens: 2 } }) }));
  client.accountRequest = (choice, cancel) => {
    const handle = f.budgets.beginRequest(root.controller, root.session, { kind: 'routing', ...choice, cancel });
    return result => f.budgets.report(handle, result, true);
  };
  await client.evaluate({}, questions);
  malformed = true;
  await assert.rejects(client.evaluate({}, questions));
  assert.equal(f.budgets.snapshot().root.usage.reportedTokens, 24);
  assert.equal(f.budgets.snapshot().root.usage.providerEstimateUsd, null, 'a locally calculated price is not a provider cost report');
  client.resetHealth();
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  client.fetch = async (_url, request) => new Promise((_resolve, reject) => {
    request.signal.addEventListener('abort', () => reject(new Error('cancelled fixture transport')), { once: true }); entered();
  });
  const pending = client.evaluate({}, questions), rejected = assert.rejects(pending, { name: 'AbortError' });
  await ready; f.budgets.pause(f.budgets.records.root, 'Fixture job paused.');
  await rejected;
  assert.equal(client.health.error, null);
  assert.equal(f.budgets.snapshot().root.usage.tokensComplete, false);
  assert.equal(f.budgets.inflight.size, 0);
});

test('a restart charges active time only until the last heartbeat, not the downtime after a crash', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-budget-heartbeat-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const heartbeat = path.join(directory, 'job-heartbeat');
  const f = fixture(t);
  f.budgets.heartbeatFile = heartbeat;
  f.worker('crashed');
  f.budgets.refresh();
  assert.equal(fs.readFileSync(heartbeat, 'utf8'), '1000000', 'a lease writes a heartbeat at once');
  const saved = { root: { id: 'root', version: 1, state: 'active', limitMs: 3600000, usedMs: 1000, activeSince: 1000000 } };
  fs.writeFileSync(heartbeat, String(1000000 + 5000));
  const primary = { filename: path.join(directory, 'sessions.json'), data: { jobBudgets: saved }, log: { warn() {} }, save() {} };
  const restored = new JobBudgets({ primary }, () => 1000000 + 8 * 3600000, () => 0);
  assert.equal(restored.records.root.usedMs, 6000, 'eight hours offline are not charged');
  assert.equal(restored.records.root.state, 'paused');
  assert.equal(restored.records.root.estimated, true);
});
