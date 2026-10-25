const { test } = require('node:test');
const assert = require('node:assert/strict');
const { SmartRouter, contextFor } = require('../src/routing/smart-router.cjs');
const { capCatalog } = require('../src/routing/effort-cap.cjs');
const { JevClient } = require('../src/providers/jev.cjs');
const { DIFFICULTY_POLICY, TASK_KINDS } = require('../src/routing/benchmarks.cjs');

const worker = { id: 'worker', model: 'test-model', effort: 'low' };
const session = { routingCatalog: [worker], routerChoice: { provider: 'codex', model: 'test-model', effort: 'low' } };
const evidence = { available: true, files: [], signals: [], limitations: [] };
const decision = relevant => ({ preset: worker.id, reason: 'test', difficulty: 'low', taskKind: relevant ? 'review' : 'general', workspaceRelevant: relevant, needsChecks: relevant, risk: 'low', uncertainty: 'low', sameTask: false, confident: true });

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

// 2026-10-25: a Claude CLI or LM Studio router left usage without totalTokens and every render of that chat threw.
test('router usage in Claude CLI and API shapes is kept with a total', async () => {
  const shapes = [
    [{ input_tokens: 2, cache_creation_input_tokens: 8778, cache_read_input_tokens: 0, output_tokens: 572 }, 9352],
    [{ inputTokens: 3702, outputTokens: 510, cachedInputTokens: null, cacheWriteInputTokens: null }, 4212],
  ];
  for (const [usage, total] of shapes) {
    const router = new SmartRouter(__dirname);
    router.classifyCodex = async () => ({ decision: decision(false), usage });
    const result = await router.choose('hello', session, []);
    assert.equal(result.router.usage.totalTokens, total);
  }
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
    assert.ok(schema.required.includes('difficulty'));
    assert.deepEqual(schema.properties.difficulty.enum, ['low', 'medium', 'high', 'xhigh']);
    assert.ok(prompt.includes(DIFFICULTY_POLICY), 'Smart receives the shared difficulty contract');
    assert.ok(prompt.includes(JSON.stringify(TASK_KINDS)), 'Smart receives the shared task-kind descriptions');
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
      assert.deepEqual(Object.keys(questions.difficulty.criteria), ['low', 'medium', 'high', 'xhigh']);
      assert.ok(questions.difficulty.instructions.endsWith(DIFFICULTY_POLICY));
      assert.deepEqual(questions.taskKind.criteria, TASK_KINDS);
      const values = { preset: worker.id, difficulty: 'low', taskKind: 'review', workspaceRelevant: 'yes', needsChecks: needed ? 'yes' : 'no', risk: 'low', uncertainty: 'low' };
      return { answers: Object.fromEntries(Object.entries(values).map(([id, choice]) => [id, { choice, confidence: 1 }])), usage: { totalTokens: 1 } };
    };
    assert.equal((await jev.classify(context, undefined, false, [{ ...worker, benchmarks: [] }])).decision.needsChecks, needed);
  }
});

test('the reusable prompt matrix records raw versus applied choices and exposes difficulty misses', async () => {
  const { evaluate } = require('./routing-decisions-live.cjs');
  const cases = require('./fixtures/routing-difficulty.json');
  const workers = ['low', 'medium', 'high', 'xhigh'].map(effort => ({ id: 'worker-' + effort, model: 'arbitrary-worker', effort }));
  const router = new SmartRouter(__dirname, undefined, undefined, async () => evidence);
  let calls = 0;
  router.classifyCodex = async text => {
    const task = cases[calls++];
    assert.equal(text, task.text, 'the original prompt reaches the router unchanged');
    if (task.expected === 'xhigh') throw new Error('Controlled provider failure');
    return { decision: { ...decision(true), preset: 'worker-low', difficulty: task.expected === 'medium' ? 'high' : task.expected }, usage: { totalTokens: 10 } };
  };
  const classify = router.classifyCodex;
  const samples = await evaluate(router, { id: 'router', model: 'arbitrary-router', effort: 'medium' }, workers);
  assert.equal(calls, 4, 'no repeated call without new evidence');
  assert.equal(router.classifyCodex, classify, 'restore the classifier after evaluation');
  assert.deepEqual(samples.slice(0, 3).map(s => s.difficultyMatch), [true, false, true]);
  assert.equal(samples[2].raw.preset, 'worker-low');
  assert.equal(samples[2].selected, 'worker-high');
  assert.equal(samples[2].usage.totalTokens, 10);
  assert.match(samples[3].error, /Controlled provider failure/);
});

test('the prompt matrix also supports Jev without enabling quick answers or Smart calls', async () => {
  const { evaluate } = require('./routing-decisions-live.cjs');
  const cases = require('./fixtures/routing-difficulty.json');
  const workers = cases.map(({ expected }) => ({ id: expected, model: 'arbitrary-worker', effort: expected }));
  const router = new SmartRouter(__dirname, undefined, undefined, async () => evidence);
  router.classifyCodex = async () => assert.fail('Jev evaluation must not call Smart');
  let calls = 0;
  router.jev = { configured: true, classify: async (context, _signal, quick) => {
    assert.equal(quick, false);
    const task = cases[calls++];
    assert.equal(context.request, task.text);
    return { decision: { ...decision(true), preset: task.expected, difficulty: task.expected }, usage: { totalTokens: 5 } };
  } };
  const classify = router.jev.classify;
  const samples = await evaluate(router, { id: 'jev', provider: 'jev' }, workers);
  assert.equal(calls, 4);
  assert.equal(router.jev.classify, classify);
  assert.ok(samples.every(s => s.difficultyMatch && s.effortMatch && s.usage.totalTokens === 5));
});

test('the live evaluator starts under Electron when require.main does not identify its script', async () => {
  const file = require('node:path').resolve(__dirname, 'routing-decisions-live.cjs');
  const localRequire = require('node:module').createRequire(file);
  const exits = [], messages = [];
  const load = name => name === 'electron' ? { app: { exit: code => exits.push(code), whenReady: () => assert.fail('Usage must not discover models') } } : localRequire(name);
  load.main = {};
  require('node:vm').runInNewContext(require('node:fs').readFileSync(file, 'utf8'), {
    require: load, module: { exports: {} }, __filename: file,
    process: { argv: ['electron', file], exitCode: 0 }, console: { log: text => messages.push(text), error: assert.fail },
  });
  await new Promise(setImmediate);
  assert.ok(exits.length > 0 && exits.every(code => code === 0));
  assert.match(messages[0], /Use --list/);
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
const pick = (preset, extra = {}) => ({ preset, reason: 'test', difficulty: 'low', taskKind: 'debugging', workspaceRelevant: true, needsChecks: true, risk: 'high', uncertainty: 'medium', sameTask: false, confident: true, ...extra });

test('task difficulty controls model and effort independently of confidence for both routers', async t => {
  const workers = ['low', 'medium', 'high', 'xhigh'].flatMap(effort => [
    { id: `first:balanced:${effort}`, provider: 'first', model: 'balanced', effort },
    { id: `second:advanced:${effort}`, provider: 'second', model: 'advanced', effort },
  ]);
  for (const provider of ['jev', 'smart']) for (const difficulty of ['low', 'medium', 'high', 'xhigh']) await t.test(`${provider} ${difficulty}`, async () => {
    const router = new SmartRouter(__dirname);
    router.benchmarks = { catalog: list => list.map(p => ({ ...p, benchmarks: [{ source: 'aa-index', version: '4', harness: 'aa', score: p.provider === 'second' ? 90 : 60 }] })) };
    const selected = pick('first:balanced:medium', { difficulty, workspaceRelevant: false,
      taskKind: difficulty === 'xhigh' ? 'review' : difficulty === 'high' ? 'debugging' : 'lookup',
      risk: difficulty === 'high' ? 'high' : difficulty === 'medium' ? 'medium' : 'low',
      uncertainty: difficulty === 'xhigh' ? 'low' : 'high', confident: difficulty !== 'medium' });
    router.classifyCodex = async () => ({ decision: selected });
    router.jev = new JevClient({ configured: true });
    router.jev.evaluate = async () => ({ answers: Object.fromEntries(Object.entries({ preset: selected.preset, difficulty,
      taskKind: selected.taskKind, risk: selected.risk, uncertainty: selected.uncertainty, workspaceRelevant: 'no', needsChecks: 'no' })
      .map(([key, choice]) => [key, { choice, confidence: difficulty === 'medium' ? 0.21 : 0.99 }])) });
    const context = { routingCatalog: workers, routerChoice: { provider: 'codex', model: 'router' }, jevQuickAnswers: false };
    const result = await router.choose('Classify this task', context, [], provider);
    assert.equal(result.id, `${['high', 'xhigh'].includes(difficulty) ? 'second:advanced' : 'first:balanced'}:${difficulty}`);
    assert.equal(result.assessment.difficulty, difficulty);
    if (difficulty === 'medium') assert.equal(result.escalatedFrom, undefined, 'low confidence alone must not promote a bounded task');
    if (difficulty === 'xhigh') {
      const capped = await router.choose('Classify this task', { ...context, routingCatalog: capCatalog(workers, 'medium') }, [], provider);
      assert.equal(capped.id, 'second:advanced:medium');
      router.benchmarks = { catalog: list => list };
      const unknown = await router.choose('Classify this task', context, [], provider);
      assert.equal(unknown.id, 'first:balanced:xhigh', 'unknown benchmarks preserve the selected model while correcting effort');
      const fixed = { ...workers[0], id: selected.preset, effort: null };
      assert.equal((await router.choose('Classify this task', { ...context, routingCatalog: [fixed] }, [], provider)).effort, null);
    }
  });
});

test('both classifiers reject missing or unsupported difficulty before selecting a worker', async () => {
  const router = new SmartRouter(__dirname);
  for (const difficulty of [undefined, 'invented']) {
    router.complete = async () => ({ decision: { ...decision(false), difficulty } });
    await assert.rejects(router.classifyCodex('lookup', session, [worker], 'test', 'low', evidence, {}, new AbortController()), /invalid decision/);
    const jev = new JevClient({ configured: true, read: () => 'test' }, async (_url, request) => {
      const questions = JSON.parse(request.body).questions;
      const answers = Object.fromEntries(Object.entries(questions).map(([key, question]) => {
        const options = Object.keys(question.criteria);
        return [key, { type: 'choice', choice: key === 'difficulty' ? difficulty : options[0], confidence: 1,
          probabilities: Object.fromEntries(options.map((option, i) => [option, i === 0 ? 1 : 0])) }];
      }));
      return { ok: true, text: async () => JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 1, output_tokens: 0 } }) };
    });
    await assert.rejects(jev.classify({ request: 'lookup' }, new AbortController().signal, false, [worker]), /invalid decision/);
  }
});

test('both routers apply difficulty once without escalating by task kind or unrelated workspace signals', async t => {
  const workers = ['medium', 'high', 'xhigh'].flatMap(effort => [
    { id: `first:balanced:${effort}`, provider: 'first', model: 'balanced', effort },
    { id: `second:advanced:${effort}`, provider: 'second', model: 'advanced', effort },
  ]);
  for (const provider of ['smart', 'jev']) await t.test(provider, async () => {
    const router = new SmartRouter(__dirname);
    router.benchmarks = { catalog: list => list.map(p => ({ ...p, benchmarks: [{ source: 'aa-index', version: '4', harness: 'aa', score: p.provider === 'second' ? 90 : 60 }] })) };
    router.inspect = async () => ({ ...evidence, nativeProject: true, signals: ['gpu-backend', 'memory-lifetime'] });
    let selected = pick('first:balanced:high', { taskKind: 'audit', difficulty: 'xhigh', risk: 'low', uncertainty: 'low' });
    router.complete = async () => ({ decision: selected });
    router.jev = new JevClient({ configured: true, read: () => 'test' }, async (_url, request) => {
      const questions = JSON.parse(request.body).questions;
      const values = { ...selected, workspaceRelevant: 'yes', needsChecks: 'no' };
      return { ok: true, text: async () => JSON.stringify({ model: 'jev-1.13.0', usage: { input_tokens: 1, output_tokens: 0 },
        answers: Object.fromEntries(Object.entries(questions).map(([key, question]) => [key, { type: 'choice', choice: values[key], confidence: 1,
          probabilities: Object.fromEntries(Object.keys(question.criteria).map(option => [option, option === values[key] ? 1 : 0])) }])) }) };
    });
    const context = { workspace: __dirname, routingCatalog: workers, routerChoice: { provider: 'codex', model: 'router' }, jevQuickAnswers: false };
    const result = await router.choose('Review all changes across the renderer, resource ownership and job scheduling', context, [], provider);
    assert.equal(result.id, 'second:advanced:xhigh');
    assert.equal(result.assessment.difficulty, 'xhigh');
    assert.equal(result.assessment.taskKind, 'audit');
    assert.equal(result.routerPick, selected.preset, 'retain the classifier pick separately from the applied worker');
    const capped = await router.choose('Review all changes', { ...context, routingCatalog: capCatalog(workers, 'high') }, [], provider);
    assert.equal(capped.id, 'second:advanced:high', 'never bypass the effort cap');
    assert.equal(capped.assessment.difficulty, 'xhigh');
    const fixed = { ...workers[0], id: selected.preset, effort: null };
    assert.equal((await router.choose('Review all changes', { ...context, routingCatalog: [fixed] }, [], provider)).effort, null);
    for (const difficulty of ['medium', 'high']) {
      selected = { ...selected, difficulty, taskKind: 'review', preset: `first:balanced:${difficulty}` };
      const narrow = await router.choose('Review only this parser function', context, [], provider);
      assert.equal(narrow.effort, difficulty, 'focused reviews retain their assessed effort despite unrelated workspace complexity');
    }
    selected = { ...selected, taskKind: 'debugging', difficulty: 'high' };
    assert.equal((await router.choose('Fix this race condition', context, [], provider)).effort, 'high');
    selected = { ...selected, taskKind: 'audit', difficulty: 'high' };
    assert.equal((await router.choose('Investigate this one lifecycle failure', context, [], provider)).effort, 'high', 'task kind cannot override assessed difficulty');
  });
});

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

test('a stale same-task classification without an active task cannot bypass difficulty routing', async () => {
  const router = new SmartRouter(__dirname);
  router.benchmarks = indexed.benchmarks;
  router.classifyCodex = async () => ({ decision: pick(small.id, { sameTask: true, difficulty: 'high', workspaceRelevant: false }), usage: { totalTokens: 1 } });
  const result = await router.choose('Review the full implementation', { routingCatalog: catalog, routerChoice: small, job: null }, []);
  assert.equal(result.id, bigHigh.id);
  assert.equal(result.sameTask, false);
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

test('new difficult work uses stronger models across providers while simple work and continued tasks stay economical', async () => {
  const router = new SmartRouter(__dirname);
  router.benchmarks = indexed.benchmarks;
  router.inspect = async () => evidence;
  let decision;
  router.classifyCodex = async () => ({ decision, usage: { totalTokens: 100 } });
  const session = { routingCatalog: catalog, routerChoice: { provider: 'codex', model: 'small', effort: 'low' }, job: job(smallHigh, 'done') };
  decision = pick(small.id, { workspaceRelevant: false });
  assert.equal((await router.choose('explain the asset type name', session, [])).id, small.id, 'simple work keeps its adequate pick');
  decision = pick(smallHigh.id, { difficulty: 'high', workspaceRelevant: false, confident: true });
  const unsure = await router.choose('design the asset streaming system', session, []);
  assert.equal(unsure.id, bigHigh.id, 'the strongest model at the effort the router chose');
  assert.equal(unsure.escalatedFrom, smallHigh.id);
  assert.match(unsure.reason, /^high difficulty: using the strongest measured model/);
  // New work can escalate to a stronger model from any offered provider.
  const claudeBig = { id: 'claude-cli:huge:high', provider: 'claude-cli', model: 'huge', effort: 'high', label: 'huge · high' };
  router.benchmarks = { catalog: workers => workers.map(w => ({ ...w, benchmarks: [{ source: 'aa-index', version: '4', harness: 'aa', score: { big: 70, huge: 90 }[w.model] || 40 }] })) };
  decision = pick(smallHigh.id, { difficulty: 'high', workspaceRelevant: false, confident: false });
  assert.equal((await router.choose('design it', { ...session, routingCatalog: [...catalog, claudeBig] }, [])).id, claudeBig.id);
  router.benchmarks = indexed.benchmarks;
  decision = pick(small.id, { workspaceRelevant: false, confident: false, risk: 'low', taskKind: 'general' });
  assert.equal((await router.choose('what does RAII mean', session, [])).id, small.id, 'low difficulty work is not escalated by confidence');
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

test('both routers consider every provider for escalation and keep adequate mid-tier model-effort choices', async () => {
  const middle = { id: 'claude-cli:balanced:medium', provider: 'claude-cli', model: 'balanced', effort: 'medium', label: 'balanced · medium' };
  const strongest = ['codex', 'cursor-cli', 'local-api'].flatMap(provider => (provider === 'local-api' ? [null] : ['high', 'xhigh']).map(effort => ({ id: `${provider}:advanced:${effort || 'default'}`, provider, model: `advanced-${provider}`, effort, label: 'Advanced' })));
  for (const provider of ['jev', 'smart']) {
    const router = new SmartRouter(__dirname);
    let winningProvider = 'codex';
    router.benchmarks = { catalog: workers => workers.map(w => ({ ...w, benchmarks: [{ source: 'aa-index', version: '4', harness: 'aa', score: w.provider === winningProvider ? 90 : w.model === middle.model ? 60 : 40 }] })) };
    let selected = pick(middle.id, { difficulty: 'xhigh', taskKind: 'review', workspaceRelevant: false, risk: 'low', uncertainty: 'high', confident: false });
    router.classifyCodex = async () => ({ decision: selected, usage: { totalTokens: 1 } });
    router.jev = new JevClient({ configured: true, read: () => 'key' });
    router.jev.evaluate = async () => ({ answers: Object.fromEntries(Object.entries({ preset: selected.preset, difficulty: selected.difficulty, taskKind: selected.taskKind, risk: selected.risk, uncertainty: selected.uncertainty, workspaceRelevant: 'no', needsChecks: 'no' }).map(([k, choice]) => [k, { choice, confidence: selected.confident ? 0.95 : 0.19 }])), usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 }, durationMs: 1 });
    const context = { routingCatalog: [middle, ...strongest], routerChoice: { provider: 'codex', model: 'router', effort: 'low' }, jevQuickAnswers: false };
    for (winningProvider of ['codex', 'cursor-cli', 'local-api']) {
      const result = await router.choose('Review these changes', context, [], provider);
      assert.equal(result.provider, winningProvider);
      assert.equal(result.effort, winningProvider === 'local-api' ? null : 'xhigh');
      assert.equal(result.escalatedFrom, middle.id);
    }
    winningProvider = 'codex';
    const capped = await router.choose('Review these changes', { ...context, routingCatalog: capCatalog(context.routingCatalog, 'high') }, [], provider);
    assert.equal(capped.provider, 'codex'); assert.equal(capped.effort, 'high');
    const withoutCodex = await router.choose('Review these changes', { ...context, routingCatalog: [middle] }, [], provider);
    assert.equal(withoutCodex.id, middle.id, 'never selects a provider absent from the offered catalog');
    for (const taskKind of ['implementation', 'debugging', 'review']) {
      selected = { ...selected, difficulty: 'medium', taskKind, confident: true, uncertainty: 'low', risk: taskKind === 'review' ? 'low' : 'medium' };
      const routine = await router.choose('A focused, well-understood task', context, [], provider);
      assert.equal(routine.id, middle.id); assert.equal(routine.effort, 'medium');
      assert.equal(routine.escalatedFrom, undefined, 'adequate mid-tier work is not forced to the strongest model');
    }
  }
});

test('demanding read-only reviews use stronger reasoning with either router, while narrow reviews stay small', async () => {
  const xhigh = { ...bigHigh, id: 'codex:big:xhigh', effort: 'xhigh' };
  for (const provider of ['jev', 'smart']) {
    const router = new SmartRouter(__dirname);
    router.benchmarks = indexed.benchmarks;
    router.inspect = async () => ({ available: false, coverage: 'unavailable', files: [], signals: [], limitations: ['No source excerpts'] });
    let review = pick(small.id, { difficulty: 'xhigh', taskKind: 'review', risk: 'low', uncertainty: 'high', confident: false });
    router.classifyCodex = async () => ({ decision: review, usage: { totalTokens: 1 } });
    router.jev = new JevClient({ configured: true, read: () => 'key' });
    router.jev.evaluate = async () => ({ answers: Object.fromEntries(Object.entries({ preset: review.preset, difficulty: review.difficulty, taskKind: 'review', risk: review.risk, uncertainty: review.uncertainty, workspaceRelevant: 'yes', needsChecks: 'no' }).map(([k, choice]) => [k, { choice, confidence: review.confident ? 0.9 : 0.19 }])), usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 }, durationMs: 1 });
    const context = { routingCatalog: [...catalog, xhigh], routerChoice: { provider: 'codex', model: 'small', effort: 'low' }, jevQuickAnswers: false };
    const result = await router.choose('Review the repository changes without editing files', context, [], provider);
    assert.equal(result.id, xhigh.id); assert.equal(result.escalatedFrom, small.id);
    assert.match(result.reason, /xhigh difficulty:.*supported effort \(xhigh\)/);
    assert.equal((await router.choose('Review changes', { ...context, routingCatalog: capCatalog(context.routingCatalog, 'high') }, [], provider)).id, bigHigh.id);
    review.preset = big.id;
    assert.equal((await router.choose('Review changes', context, [], provider)).id, xhigh.id, 'raise effort even if the model is already strongest');
    review = { ...review, difficulty: 'low', preset: small.id, uncertainty: 'low', confident: true };
    assert.equal((await router.choose('Review this spelling correction', context, [], provider)).id, small.id, 'a confident, bounded review can retain the adequate cheaper choice');
  }
});

test('a demanding review initially routed to Sonnet Medium uses Opus 5.5 xhigh with bundled evidence', async () => {
  const { BenchmarkStore } = require('../src/routing/benchmarks.cjs');
  const workers = ['claude-sonnet-5-5', 'claude-opus-5-5'].flatMap(model => ['low', 'medium', 'high', 'xhigh'].map(effort => ({ id: `claude-cli:${model}:${effort}`, model, effort, provider: 'claude-cli', label: `${model} · ${effort}` })));
  const router = new SmartRouter(__dirname);
  router.benchmarks = new BenchmarkStore();
  router.inspect = async () => ({ available: false, coverage: 'unavailable', files: [], signals: [], limitations: ['Git change inventory unavailable.'] });
  router.jev = new JevClient({ configured: true, read: () => 'key' });
  const answers = { preset: 'claude-cli:claude-sonnet-5-5:medium', difficulty: 'xhigh', taskKind: 'review', workspaceRelevant: 'yes', needsChecks: 'no', risk: 'low', uncertainty: 'high' };
  router.jev.evaluate = async () => ({ answers: Object.fromEntries(Object.entries(answers).map(([k, choice]) => [k, { choice, confidence: k === 'preset' ? 0.19 : 0.9 }])), usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 }, durationMs: 1 });
  const result = await router.choose('Review recent PE changes without editing files', { routingCatalog: workers, jevQuickAnswers: false }, [], 'jev');
  assert.equal(result.id, 'claude-cli:claude-opus-5-5:xhigh');
  assert.equal(result.escalatedFrom, answers.preset);
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
    return { model: 'jev-1.13.0', answers: { preset: answer(sonnet.id, 0.23), difficulty: answer('xhigh'), needsChecks: answer('no'), taskKind: answer('review'), workspaceRelevant: answer('no'),
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
    return { model: 'jev-1.13.0', answers: { preset: answer(answers.preset, answers.presetConfidence), difficulty: answer('high'), needsChecks: answer('yes'), taskKind: answer('debugging'), workspaceRelevant: answer('no'),
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
  assert.equal(fresh.id, bigHigh.id, 'difficult new work uses the strongest measured model at high effort');
  answers = { preset: small.id, presetConfidence: 0.8 };
  assert.equal((await router.choose('design the renderer', { routingCatalog: catalog, jevQuickAnswers: false }, [], 'jev')).id, bigHigh.id, 'high confidence does not lower the required capability');
});


test('Jev requests the stable alias and learns its displayed version only from valid provider responses', async () => {
  let reported = 'jev-9.8.7', calls = 0;
  const client = new JevClient({ configured: true, read: () => 'fixture-key' }, async (_url, request) => {
    calls++;
    assert.equal(JSON.parse(request.body).model, 'jev-latest');
    return { ok: true, text: async () => JSON.stringify({ model: reported,
      answers: { relevant: { type: 'noul', noul: 0.9 } }, usage: { input_tokens: 2, output_tokens: 0 } }) };
  });
  const questions = { relevant: { type: 'noul', instructions: 'Relevant?' } };
  assert.equal(client.model, null);
  assert.equal(calls, 0, 'reading the model never probes the paid endpoint');
  await client.evaluate('fixture', questions);
  assert.equal(client.model, 'jev-9.8.7');
  reported = 'jev-9.8.8';
  await client.evaluate('fixture', questions);
  assert.equal(client.model, 'jev-9.8.8');
  reported = 'invalid identifier';
  await assert.rejects(client.evaluate('fixture', questions), /invalid model identifier/);
  assert.equal(client.model, 'jev-9.8.8', 'invalid responses cannot replace the observed version');
});


test('Jev quick answers return only confident low-risk yes/no results and otherwise select a worker', async () => {
  const jev = new JevClient({ configured: true });
  const router = new SmartRouter(__dirname);
  router.jev = jev;
  router.inspect = async () => assert.fail('these fixtures need no workspace scan');
  for (const scenario of [
    { answer: 'yes', expected: 'Yes.' },
    { answer: 'no', expected: 'No.' },
    { answer: 'yes', confidence: 0.94 },
    { answer: 'yes', probability: 0.97 },
    { answer: 'yes', risk: 'high' },
    { answer: 'yes', uncertainty: 'high' },
    { answer: 'yes', enabled: false },
    { answer: 'yes', images: 1 },
  ]) {
    let calls = 0;
    jev.evaluate = async (_context, questions) => {
      calls++;
      const quick = !!questions.quickAnswer;
      const values = { preset: quick ? 'jev' : worker.id, difficulty: 'low', taskKind: 'general',
        workspaceRelevant: 'no', needsChecks: 'no', risk: scenario.risk || 'low', uncertainty: scenario.uncertainty || 'low' };
      const answers = Object.fromEntries(Object.entries(values).map(([id, choice]) => [id, { choice, confidence: 1 }]));
      if (quick) answers.quickAnswer = { choice: scenario.answer, confidence: scenario.confidence ?? 1,
        probabilities: { [scenario.answer]: scenario.probability ?? 1 } };
      return { model: 'jev-test', answers, usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, estimatedCostUsd: 0, durationMs: 1 };
    };
    const selected = await router.choose('Does the text mention rain? Text: Rain is expected.',
      { ...session, jevQuickAnswers: scenario.enabled, attachedImageCount: scenario.images || 0 }, [], 'jev');
    assert.equal(selected.directAnswer || undefined, scenario.expected);
    if (!scenario.expected) assert.equal(selected.id, worker.id);
    const retried = !scenario.expected && scenario.enabled !== false && !scenario.images;
    assert.equal(calls, retried ? 2 : 1);
  }
});
