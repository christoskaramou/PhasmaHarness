const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SmartRouter, contextFor } = require('../src/routing/smart-router.cjs');
const { capCatalog } = require('../src/routing/effort-cap.cjs');
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

test('a Claude router runs at its selected effort; unset leaves the CLI default and Cursor gets none', async () => {
  const router = new SmartRouter(__dirname);
  const seen = [];
  router.claude = { run: async options => { seen.push(['claude', options.effort]); return { structured_output: decision(false) }; } };
  router.cursor = { run: async options => { seen.push(['cursor', options.effort]); return { structured_output: decision(false) }; } };
  await router.classifyCodex('x', session, [worker], 'claude-haiku-4-5', 'low', evidence, { provider: 'claude-cli' }, new AbortController());
  await router.classifyCodex('x', session, [worker], 'claude-haiku-4-5', null, evidence, { provider: 'claude-cli' }, new AbortController());
  await router.classifyCodex('x', session, [worker], 'auto', 'low', evidence, { provider: 'cursor-cli' }, new AbortController());
  await router.classifyCodex('x', session, [worker], 'grok-4.7', 'low', evidence, { provider: 'cursor-cli', effortOption: 'effort', parameterized: true }, new AbortController());
  assert.deepEqual(seen, [['claude', 'low'], ['claude', undefined], ['cursor', undefined], ['cursor', 'low']], 'Cursor gets an effort only with its reasoning option');
});

test('Jev context ranking names each excerpt by an ID key, never by list position', async () => {
  const { ContextSearch } = require('../src/workspace/context-search.cjs');
  let asked;
  const jev = { configured: true, async evaluate(state, questions) {
    asked = { state: JSON.parse(state), questions };
    return { model: 'jev-1.13.0', answers: { r0: { noul: 0.1 }, r1: { noul: 0.9 }, r2: { noul: 0.5 } }, usage: { inputTokens: 10, outputTokens: 0, totalTokens: 10 }, estimatedCostUsd: 0, durationMs: 1 };
  } };
  const candidates = [
    { source: 'code', path: 'src/a.cpp', line: 10, text: 'alpha' },
    { source: 'code', path: 'src/b.cpp', line: 20, text: 'beta' },
    { source: 'code', path: 'src/a.cpp', line: 10, text: 'alpha again' },
  ];
  const result = await new ContextSearch(require('node:os').tmpdir(), jev).rank({ query: 'where is beta', candidates, warnings: [], files: [], corpusHash: 'h' }, 'jev');
  assert.deepEqual(Object.keys(asked.state.excerpts), ['E1', 'E2', 'E3']);
  assert.deepEqual(asked.state.excerpts.E2, { source: 'code', path: 'src/b.cpp', line: 20, text: 'beta' });
  assert.match(asked.questions.r1.instructions, /excerpt E2 .*key is E2/);
  assert.doesNotMatch(JSON.stringify(asked.questions), /src\/|candidate \d/, 'no workspace paths in the questions');
  assert.deepEqual(result.hits.map(hit => hit.text), ['beta', 'alpha again', 'alpha']);
  assert.equal(result.mode, 'jev');
});

test('the Jev comparison follows Jev routing without touching the active routing', async () => {
  const router = new SmartRouter(__dirname);
  const order = [];
  router.inspect = async () => { order.push('scan'); return evidence; };
  router.jev = { configured: true, async classify(context, _signal, quick) {
    assert.equal(quick, false, 'no quick answers in a comparison');
    const scanned = JSON.stringify(context).includes('"available":true');
    order.push(scanned ? 'evidence' : 'first');
    return { decision: decision(true), confidence: 0.8, estimatedCostUsd: 0.0001 };
  } };
  // A comparison may run while the router is busy with the next message.
  router.abort = new AbortController();
  const result = await router.shadowJev('review changes', session, new AbortController().signal);
  assert.deepEqual(order, ['first', 'scan', 'evidence']);
  assert.deepEqual(result, { id: 'worker', provider: 'codex', model: 'test-model', effort: 'low', confidence: 0.8, costUsd: 0.0002 });
  order.length = 0;
  router.jev.classify = async () => { order.push('first'); return { decision: decision(false), confidence: 0.9, estimatedCostUsd: 0.0001 }; };
  router.inspect = async () => assert.fail('a general message needs no workspace scan');
  assert.equal((await router.shadowJev('hello', session, new AbortController().signal)).costUsd, 0.0001);
  assert.deepEqual(order, ['first']);
});

// One model per task: fixtures with two models so a kept worker, a fresh pick and the strongest model differ.
const small = { id: 'codex:small:low', provider: 'codex', model: 'small', effort: 'low', label: 'small · low' };
const smallHigh = { id: 'codex:small:high', provider: 'codex', model: 'small', effort: 'high', label: 'small · high' };
const big = { id: 'codex:big:low', provider: 'codex', model: 'big', effort: 'low', label: 'big · low' };
const bigHigh = { id: 'codex:big:high', provider: 'codex', model: 'big', effort: 'high', label: 'big · high' };
const catalog = [small, smallHigh, big, bigHigh];
const indexed = new SmartRouter(__dirname);
indexed.benchmarks = { catalog: workers => workers.map(w => ({ ...w, benchmarks: [{ source: 'aa-index', version: '4', harness: 'aa', score: w.model === 'big' ? 70 : 40 }] })) };
const job = (worker, status = 'pending') => ({ goal: 'Fix the shadow map flicker', worker: { id: worker.id, label: worker.label }, status });
const pick = (preset, extra = {}) => ({ preset, reason: 'test', taskKind: 'debugging', workspaceRelevant: true, needsChecks: true, risk: 'high', uncertainty: 'medium', sameTask: false, confident: true, ...extra });

test('a lowered effort cap keeps a continued task on its model at the highest effort still offered', async () => {
  const router = new SmartRouter(__dirname);
  router.benchmarks = indexed.benchmarks;
  router.inspect = async () => assert.fail('a continued task needs no workspace scan');
  router.classifyCodex = async () => ({ decision: pick(small.id, { sameTask: true }), usage: { totalTokens: 100 } });
  const worker = { id: bigHigh.id, provider: 'codex', model: 'big', effort: 'high', label: bigHigh.label };
  const session = { routingCatalog: capCatalog(catalog, 'low'), routerChoice: { provider: 'codex', model: 'small', effort: 'low' }, job: { goal: 'Fix the shadow map flicker', worker, status: 'pending' } };
  const result = await router.choose('continue', session, []);
  assert.equal(result.id, big.id, 'same model, capped effort');
  assert.equal(result.sameTask, true);
  assert.match(result.reason, /^Same task \(pending\): kept big · low\./);
});

test('a continued task keeps its worker with one routing call, and says when the router would pick another', async () => {
  const router = new SmartRouter(__dirname);
  router.benchmarks = indexed.benchmarks;
  let calls = 0;
  router.inspect = async () => assert.fail('a continued task needs no workspace scan');
  router.classifyCodex = async () => { calls++; return { decision: pick(big.id, { sameTask: true }), usage: { totalTokens: 100 } }; };
  const session = { routingCatalog: catalog, routerChoice: { provider: 'codex', model: 'small', effort: 'low' }, job: job(smallHigh) };
  const result = await router.choose('the shadows still flicker, fix that', session, []);
  assert.equal(calls, 1, 'no second call for a continued task');
  assert.equal(result.id, smallHigh.id, 'the task keeps its model and effort');
  assert.equal(result.sameTask, true);
  assert.equal(result.routerPick, big.id);
  assert.match(result.reason, /^Same task \(pending\): kept small · high\. On its own this message would get big · low\./);
  assert.equal(result.assessment.needsChecks, true);
  // Its worker is gone (disabled or at a usage limit): the router's pick runs, and the task continues on it.
  const moved = await router.choose('continue', { ...session, routingCatalog: [small, big, bigHigh] }, []);
  assert.equal(moved.id, big.id);
  assert.equal(moved.sameTask, true);
});

test('a new task is routed as before, and an unsure router uses the strongest model unless the work is low-risk', async () => {
  const router = new SmartRouter(__dirname);
  router.benchmarks = indexed.benchmarks;
  router.inspect = async () => evidence;
  let decision;
  router.classifyCodex = async () => ({ decision, usage: { totalTokens: 100 } });
  const session = { routingCatalog: catalog, routerChoice: { provider: 'codex', model: 'small', effort: 'low' }, job: job(smallHigh, 'done') };
  decision = pick(small.id, { workspaceRelevant: false });
  assert.equal((await router.choose('design the asset streaming system', session, [])).id, small.id, 'a confident router keeps its pick');
  decision = pick(smallHigh.id, { workspaceRelevant: false, confident: false });
  const unsure = await router.choose('design the asset streaming system', session, []);
  assert.equal(unsure.id, bigHigh.id, 'the strongest model at the effort the router chose');
  assert.equal(unsure.escalatedFrom, smallHigh.id);
  assert.match(unsure.reason, /^The router was unsure; using the strongest model instead of small · high\./);
  // Only within the provider the router chose, so the conversation is not handed to another provider.
  const claudeBig = { id: 'claude-cli:huge:high', provider: 'claude-cli', model: 'huge', effort: 'high', label: 'huge · high' };
  router.benchmarks = { catalog: workers => workers.map(w => ({ ...w, benchmarks: [{ source: 'aa-index', version: '4', harness: 'aa', score: { big: 70, huge: 90 }[w.model] || 40 }] })) };
  decision = pick(smallHigh.id, { workspaceRelevant: false, confident: false });
  assert.equal((await router.choose('design it', { ...session, routingCatalog: [...catalog, claudeBig] }, [])).id, bigHigh.id);
  router.benchmarks = indexed.benchmarks;
  decision = pick(small.id, { workspaceRelevant: false, confident: false, risk: 'low', taskKind: 'general' });
  assert.equal((await router.choose('what does RAII mean', session, [])).id, small.id, 'low-risk work is never escalated');
  decision = pick(small.id, { workspaceRelevant: false, confident: false, sameTask: true });
  assert.equal((await router.choose('more of this', session, [])).id, smallHigh.id, 'a continued task is never escalated');
});

test('the router sees the current task, and task status lines never reach it', () => {
  const context = contextFor('and the normals too', {
    job: job(small, 'needs-input'),
    items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Fix the shadow map flicker' }] },
      { type: 'agentMessage', phase: 'final_answer', text: 'Which cascade flickers?\n\n[task: needs-input]' }],
  }, { available: false });
  assert.deepEqual(context.currentTask, { goal: 'Fix the shadow map flicker', worker: { id: small.id, label: small.label }, status: 'needs-input' });
  assert.equal(context.recentMessages[1].text, 'Which cascade flickers?');
  assert.equal(contextFor('hi', {}, { available: false }).currentTask, undefined);
});

test('Jev unsure about high-risk work between Sonnet and the 1M-context Opus: the strongest (Opus) runs, as measured', async () => {
  // 25 Sep: Jev picked claude-sonnet-5 · high at 23% confidence for a high-risk review. Opus had no numbers (its
  // 1M-context ID matched no benchmark rows, and its only runs are fallback-labelled), so nothing looked stronger.
  const { BenchmarkStore } = require('../src/routing/benchmarks.cjs');
  const sonnet = { id: 'claude-cli:claude-sonnet-5:high', provider: 'claude-cli', model: 'claude-sonnet-5', effort: 'high', label: 'claude-sonnet-5 · high' };
  const opus = { id: 'claude-cli:claude-opus-5-5[1m]:high', provider: 'claude-cli', model: 'claude-opus-5-5[1m]', effort: 'high', label: 'claude-opus-5-5[1m] · high' };
  const jev = new JevClient({ configured: true, read: () => 'key' });
  jev.evaluate = async () => {
    const answer = (choice, confidence = 0.9) => ({ choice, confidence, probabilities: {} });
    return { model: 'jev-1.13.0', answers: { preset: answer(sonnet.id, 0.23), needsChecks: answer('no'), taskKind: answer('review'), workspaceRelevant: answer('no'),
      risk: answer('high'), uncertainty: answer('high') }, usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 }, estimatedCostUsd: 0, durationMs: 1 };
  };
  const router = new SmartRouter(__dirname);
  router.benchmarks = new BenchmarkStore();
  router.jev = jev;
  const chosen = await router.choose('review the C++ scripting work and finish it', { routingCatalog: [sonnet, opus], jevQuickAnswers: false }, [], 'jev');
  assert.equal(chosen.id, opus.id);
  assert.equal(chosen.escalatedFrom, sonnet.id);
});

test('Jev asks whether the prompt continues the task only when there is one, and keeps the task worker', async () => {
  const jev = new JevClient({ configured: true, read: () => 'key' });
  const asked = [];
  let answers;
  jev.evaluate = async (state, questions) => {
    asked.push(Object.keys(questions));
    const answer = (choice, confidence = 0.9) => ({ choice, confidence, probabilities: {} });
    return { model: 'jev-1.13.0', answers: { preset: answer(answers.preset, answers.presetConfidence), needsChecks: answer('yes'), taskKind: answer('debugging'), workspaceRelevant: answer('no'),
      risk: answer('high'), uncertainty: answer('low'), ...(questions.sameTask ? { sameTask: answer(answers.sameTask) } : {}) }, usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 }, estimatedCostUsd: 0, durationMs: 1 };
  };
  const router = new SmartRouter(__dirname);
  router.benchmarks = indexed.benchmarks;
  router.jev = jev;
  answers = { preset: big.id, sameTask: 'yes' };
  const kept = await router.choose('fix that', { routingCatalog: catalog, job: job(small), jevQuickAnswers: false }, [], 'jev');
  assert.ok(asked[0].includes('sameTask'));
  assert.equal(kept.id, small.id);
  asked.length = 0;
  answers = { preset: small.id, presetConfidence: 0.3 };
  const fresh = await router.choose('design the renderer', { routingCatalog: catalog, jevQuickAnswers: false }, [], 'jev');
  assert.ok(!asked[0].includes('sameTask'), 'no task yet, no task question');
  assert.equal(fresh.id, big.id, 'Jev unsure about high-risk new work: the strongest model');
  answers = { preset: small.id, presetConfidence: 0.8 };
  assert.equal((await router.choose('design the renderer', { routingCatalog: catalog, jevQuickAnswers: false }, [], 'jev')).id, small.id);
});
