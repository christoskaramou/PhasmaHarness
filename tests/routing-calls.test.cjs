const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SmartRouter, contextFor } = require('../src/routing/smart-router.cjs');
const { JevClient } = require('../src/providers/jev.cjs');

const worker = { id: 'worker', model: 'test-model', effort: 'low' };
const session = { routingCatalog: [worker], routerChoice: { provider: 'codex', model: 'test-model', effort: 'low' } };
const evidence = { available: true, files: [], signals: [], limitations: [] };
const decision = relevant => ({ preset: worker.id, reason: 'test', taskKind: relevant ? 'review' : 'general', workspaceRelevant: relevant, needsChecks: relevant, risk: 'low', uncertainty: 'low' });

test('Smart skips workspace scanning and the second call for general messages', async () => {
  const router = new SmartRouter(__dirname);
  let calls = 0;
  router.inspect = async () => assert.fail('general messages must not scan the workspace');
  router.classifyCodex = async () => {
    calls++;
    return { decision: decision(false), usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 } };
  };
  const result = await router.choose('hello', session, []);
  await new Promise(setImmediate);
  assert.equal(calls, 1, 'no discarded call may continue in the background');
  assert.equal(result.router.usage.totalTokens, 105);
  assert.equal(result.router.evidence.coverage, 'not-needed');
  assert.equal(result.assessment.needsChecks, false);
});

test('Smart runs evidence classification only when requested and counts both calls', async () => {
  const router = new SmartRouter(__dirname);
  const order = [];
  router.inspect = async () => { order.push('scan'); return evidence; };
  router.classifyCodex = async (_text, _session, _workers, _model, _effort, workspace) => {
    order.push(workspace.available ? 'evidence' : 'first');
    return { decision: decision(true), usage: { inputTokens: 100, outputTokens: 5, totalTokens: 105 }, timing: {} };
  };
  const result = await router.choose('review changes', session, []);
  assert.deepEqual(order, ['first', 'scan', 'evidence']);
  assert.equal(result.router.usage.totalTokens, 210);
  assert.equal(result.router.timings.classifications.length, 2);
  assert.equal(result.assessment.needsChecks, true);
});

test('Smart schema and Jev both return an explicit check decision with configured check context', async () => {
  const configuredChecks = [{ name: 'Unit', argv: ['node', '--test'] }];
  const context = contextFor('review', { ...session, configuredChecks }, evidence);
  assert.deepEqual(context.configuredChecks, [{ name: 'Unit', command: 'node --test' }]);
  const router = new SmartRouter(__dirname);
  router.claude = { run: async ({ schema, prompt }) => {
    assert.ok(schema.required.includes('needsChecks'));
    assert.equal(schema.properties.needsChecks.type, 'boolean');
    assert.match(prompt, /node --test/);
    return { structured_output: decision(false) };
  } };
  const smart = await router.classifyCodex('review', { ...session, configuredChecks }, [worker], 'test', 'low', evidence, { provider: 'claude-cli' }, new AbortController());
  assert.equal(smart.decision.needsChecks, false);
  const jev = new JevClient({ configured: true });
  for (const needed of [false, true]) {
    jev.evaluate = async (state, questions) => {
      assert.deepEqual(state.configuredChecks, context.configuredChecks);
      assert.ok(questions.needsChecks.criteria.yes);
      const values = { preset: worker.id, taskKind: 'review', workspaceRelevant: 'yes', needsChecks: needed ? 'yes' : 'no', risk: 'low', uncertainty: 'low' };
      return { answers: Object.fromEntries(Object.entries(values).map(([id, choice]) => [id, { choice, confidence: 1 }])), usage: { totalTokens: 1 } };
    };
    assert.equal((await jev.classify(context, undefined, false, [{ ...worker, benchmarks: [] }])).decision.needsChecks, needed);
  }
});

test('Stop during workspace scanning prevents the second paid call', async () => {
  const router = new SmartRouter(__dirname);
  let calls = 0;
  router.classifyCodex = async () => { calls++; return { decision: decision(true) }; };
  router.inspect = async () => { router.cancel(); return evidence; };
  await assert.rejects(router.choose('review changes', session, []), { name: 'AbortError' });
  assert.equal(calls, 1);
});
