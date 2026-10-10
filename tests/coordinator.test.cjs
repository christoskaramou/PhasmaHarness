const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Controller } = require('../src/controller.cjs');
const { Agents } = require('../src/agents.cjs');
const { SmartRouter } = require('../src/routing/smart-router.cjs');

const answer = reply => ({ reply, action: null });
const action = (tool, args) => ({ reply: '', action: { tool, arguments: args } });
class Client extends EventEmitter {
  constructor() { super(); this.calls = []; }
  async start() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } };
    if (method === 'model/list') return { data: ['gpt-5.6-terra', 'gpt-5.6-sol'].map(model => ({ model, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] })) };
    if (method === 'thread/start') return { thread: { id: randomUUID() } };
    if (method === 'turn/start') return { turn: { id: randomUUID() } };
    return {};
  }
  close() {}
}
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hub-'));
  const calls = [], replies = [], assessments = [];
  const factory = (file, cwd, options) => {
    const c = new Controller(file, cwd, new Client(), {
      cancel() {}, close() {},
      async choose() { return { id: 'terra-light', model: 'gpt-5.6-terra', effort: 'low', provider: 'codex', source: 'smart', needsChecks: false }; },
      async chooseHub(workers) { return workers.find(p => p.effort === 'low') || workers[0]; },
      async complete(request, choice, abort) {
        calls.push({ request, choice, abort });
        return { decision: request.schema.properties.summary ? { summary: 'User intent and pending work retained.' }
          : request.schema.properties.fulfilled ? assessments.shift() || { fulfilled: true, evidence: 'The fixture worker completed the requested task.', gaps: [] }
          : replies.shift() || answer('Hello.') };
      },
    }, options);
    c.claude.refresh = async () => c.claude.status;
    c.cursor.refresh = async () => c.cursor.status;
    return c;
  };
  const hub = factory(path.join(root, 'sessions.json'), root);
  await hub.initialize(); hub.data.settings.mode = 'terra-light';
  const agents = new Agents(hub, async () => {}, factory);
  const session = agents.conversation(hub, true, root, 'workspace-write');
  t.after(async () => {
    agents.closing = true; agents.pump();
    await Promise.all(agents.initializing.values());
    for (const c of agents.controllers.values()) c.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const send = text => hub.send({ id: session.id, text });
  return { root, hub, session, agents, calls, replies, assessments, send };
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.ok(check(), 'Condition did not become true');
}

test('Hub keeps its chat model, preserves old history and never starts a native worker turn', async t => {
  const { hub, session, agents, calls, send } = await setup(t);
  session.threadId = 'existing-main-thread';
  session.items.push({ id: 'old', type: 'agentMessage', text: 'Existing conversation', phase: 'final_answer' });
  hub.data.settings.mode = 'auto';
  await send('Hello');
  const model = calls[0].choice.id;
  hub.effectiveRouter = () => { throw new Error('Must use the pinned model'); };
  await send('How does this work?');
  assert.equal(calls[1].choice.id, model);
  assert.deepEqual(session.routes.map(route => route.source), ['hub-auto', 'hub-auto'], 'initial and pinned Auto turns keep their selection origin');
  assert.deepEqual(JSON.parse(fs.readFileSync(hub.filename)).sessions.find(s => s.id === session.id).routes.map(route => route.source), ['hub-auto', 'hub-auto']);
  assert.equal(JSON.parse(fs.readFileSync(hub.filename)).hubMode, model);
  assert.match(calls[1].request.prompt, /Existing conversation/);
  assert.equal(hub.client.calls.some(c => c.method.startsWith('thread/') || c.method === 'turn/start'), false);
  assert.equal(agents.snapshot().agents[0].name, 'Hub');
  await assert.rejects(agents.deleteAgent('main'), /cannot be deleted/);
  hub.available = () => false;
  await assert.rejects(send('Again'), /Hub Auto needs/);
  assert.equal(calls.length, 2, 'no replacement can run when all models are unavailable');
});

test('Hub Auto replaces a disconnected Claude pin with OpenAI and retains the conversation', async t => {
  const { hub, session, calls, send } = await setup(t);
  hub.data.settings.mode = 'auto';
  hub.setProviderEnabled('codex', false);
  await hub.refreshAccount();
  hub.setProviderEnabled('claude-cli', true);
  hub.claude.status = { loggedIn: true };
  hub.claude.models = [{ id: 'claude-cli:balanced', model: 'balanced', provider: 'claude-cli', efforts: ['medium'], rank: 30, worker: true, router: true }];
  await hub.refreshAccount();
  let selections = 0;
  const chooseHub = hub.smartRouter.chooseHub;
  hub.smartRouter.chooseHub = async (...args) => { selections++; return chooseHub(...args); };
  await send('Remember this conversation');
  assert.equal(calls[0].choice.provider, 'claude-cli');
  const oldPin = hub.data.hubMode;
  hub.setProviderEnabled('claude-cli', false);
  hub.setProviderEnabled('codex', true);
  await hub.refreshAccount();
  await send('Continue after switching providers');
  assert.equal(calls[1].choice.provider, 'codex');
  assert.match(calls[1].request.prompt, /Remember this conversation/);
  assert.equal(calls[1].choice.source, 'hub-auto');
  assert.notEqual(hub.data.hubMode, oldPin);
  assert.equal(hub.data.hubModeSource, 'auto');
  assert.equal(hub.data.settings.mode, 'auto');
  assert.equal(JSON.parse(fs.readFileSync(hub.filename)).hubMode, calls[1].choice.id);
  await send('Continue again');
  assert.equal(selections, 2, 'the healthy replacement stays pinned');
  assert.equal(calls[2].choice.id, calls[1].choice.id);
  assert.equal(hub.data.sessions[0].id, session.id);
  assert.equal(hub.client.calls.some(c => c.method === 'turn/start'), false);
});

test('Hub Auto replaces removed or rate-limited pins without overriding manual model choices', async t => {
  for (const unavailable of ['removed', 'limited']) await t.test(unavailable, async t => {
    const { hub, calls, send } = await setup(t);
    hub.data.settings.mode = 'auto';
    await send('Hello');
    const oldPin = hub.resolveWorker(hub.data.hubMode);
    if (unavailable === 'removed') hub.models = hub.models.filter(p => p.model !== oldPin.model);
    else hub.limits.limited = (_provider, model) => model === oldPin.model;
    await send('Next');
    assert.notEqual(calls[1].choice.model, oldPin.model);
  });
  const { hub, calls, send } = await setup(t);
  await send('A manually chosen model');
  const oldPin = hub.data.hubMode;
  hub.models = hub.models.filter(p => p.model !== calls[0].choice.model);
  assert.ok(hub.catalog().some(p => hub.available(p)), 'a replacement exists');
  hub.smartRouter.chooseHub = async () => assert.fail('a manual choice must not be silently changed');
  await assert.rejects(send('Next'), /chat model is unavailable/);
  assert.equal(hub.data.hubMode, oldPin);
  assert.equal(hub.data.hubModeSource, 'manual');
  assert.equal(calls.length, 1);
});

test('Hub Auto asks either router to choose from arbitrary available models across subscriptions', async t => {
  for (const routing of ['jev', 'smart']) for (const provider of ['codex', 'claude-cli', 'cursor-cli']) {
    await t.test(`${routing} with ${provider}`, async t => {
      const { hub, calls, send } = await setup(t);
      hub.data.settings.routing = routing; hub.data.settings.mode = 'auto';
      hub.data.hubMode = 'terra-light'; // Migrate an earlier automatic choice outside the policy.
      const model = 'future-balanced-model-v3', small = 'future-small-model-v2', flagship = 'future-large-model-v4';
      const models = [small, flagship, model], efforts = ['high', 'medium', 'low'];
      if (provider === 'codex') {
        hub.models = models.map(model => ({ model, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) }));
        hub.data.settings.disabledCodexModels = [];
      } else {
        hub.account = null;
        if (provider === 'claude-cli') {
          hub.data.settings.claudeEnabled = true; hub.claude.status = { loggedIn: true };
          hub.claude.models = models.map(model => ({ id: `claude-cli:${model}`, model, provider, efforts, rank: 35, worker: true, router: true }));
        } else {
          hub.data.settings.cursorEnabled = true; hub.cursor.status = { loggedIn: true };
          hub.cursor.models = models.map(id => ({ id, efforts, effortOption: 'reasoning_effort', parameterized: true }));
          hub.data.settings.providerModels = models.map(model => ({ id: `cursor-cli:${model}:default`, model, provider, enabled: true, rank: 35, worker: true, router: true }));
        }
      }
      const before = hub.catalog(), selections = [];
      hub.data.settings.jevEnabled = true;
      hub.smartRouter.chooseHub = async (workers, selectedProvider) => {
        selections.push(selectedProvider);
        assert.deepEqual(new Set(workers.map(p => p.model)), new Set(models), 'no model family is excluded');
        assert.ok(workers.every(p => ['low', 'medium'].includes(p.effort)));
        return workers.find(p => p.model === model && p.effort === 'low');
      };
      await send('Hello');
      assert.deepEqual(selections, [routing]);
      assert.equal(calls[0].choice.model, model); assert.equal(calls[0].choice.provider, provider); assert.equal(calls[0].choice.effort, 'low');
      const medium = before.find(p => p.model === model && p.effort === 'medium');
      hub.data.hubMode = medium.id;
      await send('Continue');
      assert.equal(calls[1].choice.id, medium.id, 'a qualifying pinned model stays fixed');
      const high = before.find(p => p.model === flagship && p.effort === 'high');
      assert.deepEqual(selections, [routing], 'a pinned choice needs no new routing call');
      const manual = await hub.coordinatorChoice(high.id, new AbortController());
      assert.equal(manual.id, high.id, 'explicit manual selection remains available');
      assert.equal(manual.source, 'manual');
      assert.equal((await hub.coordinatorChoice('auto', new AbortController())).model, model, 'returning to Auto asks the router again');
      assert.deepEqual(hub.catalog(), before, 'worker catalog and efforts are unchanged');
    });
  }
});

test('Hub Auto rejects unsupported effort while accepting previously unknown models', async t => {
  const { hub, calls, send } = await setup(t);
  hub.data.settings.mode = 'auto'; hub.data.settings.disabledCodexModels = [];
  const entries = (model, efforts) => ({ model, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) });
  hub.models = [entries('model-one', ['none', 'minimal', 'high', 'xhigh'])];
  await assert.rejects(send('Hello'), /Hub Auto needs.*Low or Medium/);
  assert.equal(calls.length, 0); assert.equal(hub.data.hubMode, undefined);
  hub.models.push(entries('unknown-model', ['medium', 'high']));
  await send('Hello');
  assert.equal(calls[0].choice.model, 'unknown-model'); assert.equal(calls[0].choice.effort, 'medium');
  hub.data.hubMode = null;
  hub.data.settings.disabledCodexModels = ['unknown-model'];
  await assert.rejects(send('Again'), /Hub Auto needs/);
  hub.data.settings.disabledCodexModels = [];
  hub.limits.limited = (_provider, model) => model === 'unknown-model';
  await assert.rejects(send('Again'), /Hub Auto needs/);
  assert.equal(calls.length, 1, 'disabled or rate-limited candidates never start inference');
});

test('Hub Auto switches to LM Studio alone, retains default effort and reuses its pin without a classifier', async t => {
  const { root, hub, calls, send } = await setup(t);
  hub.data.settings.mode = 'auto';
  await send('Remember our plan');
  for (const provider of ['codex', 'claude-cli', 'cursor-cli']) hub.setProviderEnabled(provider, false);
  hub.providerSettings({ action: 'provider', provider: { id: 'lm-studio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', enabled: true } });
  hub.providerSettings({ action: 'model', model: { provider: 'lm-studio', model: 'new-local-model', label: 'Local model', description: '', rank: 30, effort: null, router: false } });
  await hub.refreshAccount();
  assert.equal(hub.account, null);
  const selector = new SmartRouter(root);
  selector.complete = async () => assert.fail('One eligible model needs no classifier');
  let selections = 0;
  hub.smartRouter.chooseHub = async (...args) => { selections++; return selector.chooseHub(...args); };
  await send('Continue locally');
  const local = calls[1].choice;
  assert.equal(local.provider, 'lm-studio'); assert.equal(local.model, 'new-local-model');
  assert.equal(local.effort, null); assert.equal(local.source, 'hub-auto');
  assert.match(calls[1].request.prompt, /Remember our plan/);
  assert.equal(JSON.parse(fs.readFileSync(hub.filename)).hubMode, local.id);
  await send('Continue again');
  assert.equal(selections, 1, 'default effort remains a valid Auto pin');
  assert.equal(calls[2].choice.id, local.id); assert.equal(calls[2].choice.effort, null);
  hub.limits.limited = provider => provider === 'lm-studio';
  await assert.rejects(send('Limited'), /Hub Auto needs/);
  hub.limits.limited = () => false;
  hub.data.settings.providerModels[0].enabled = false;
  await assert.rejects(send('Disabled'), /Hub Auto needs/);
  assert.equal(calls.length, 3, 'unavailable local models never start inference');
});

test('Jev and Smart can choose fixed-effort Hub models without assigning a reasoning level', async () => {
  const router = new SmartRouter(__dirname);
  const workers = [
    { id: 'local-a:default', provider: 'local-a', model: 'fixed-a', effort: null },
    { id: 'local-b:default', provider: 'local-b', model: 'fixed-b' },
    { id: 'other:high', provider: 'other', model: 'reasoning', effort: 'high' },
  ];
  router.benchmarks.catalog = rows => rows;
  const pick = (catalog, instructions) => {
    assert.deepEqual(catalog.map(p => p.id), workers.slice(0, 2).map(p => p.id));
    assert.ok(catalog.every(p => !p.effort));
    assert.match(instructions, /no configurable effort/i);
    return catalog[0].id;
  };
  router.jev = { configured: true, evaluate: async ({ catalog }, questions) => {
    assert.ok(Object.values(questions.preset.criteria).every(label => label.endsWith('provider default')));
    return { answers: { preset: { choice: pick(catalog, questions.preset.instructions) } } };
  } };
  router.complete = async ({ prompt, instructions }) => ({ decision: { preset: pick(JSON.parse(prompt).catalog, instructions), reason: 'Available fixed-effort chat model.' } });
  for (const provider of ['jev', 'smart']) {
    const choice = await router.chooseHub(workers, provider, workers[1], new AbortController());
    assert.equal(choice.id, workers[0].id); assert.equal(choice.effort, null);
  }
});

test('Hub selection gives Jev and Smart the same evidence-based policy without names or escalation', async () => {
  const router = new SmartRouter(__dirname);
  const models = ['new-strong-model', 'new-small-model', 'new-balanced-model', 'unmeasured-model'];
  const workers = models.flatMap((model, i) => ['low', 'medium', 'high'].map(effort => ({ id: `${model}:${effort}`, model, effort,
    description: `Discovered model ${i}`, provider: 'custom-provider', label: `${model} ${effort}` })));
  router.benchmarks.catalog = rows => rows.map(p => ({ ...p, benchmarks: p.model === models[3] ? [] : [{ source: 'aa-index', version: 'test', harness: 'api', score: [90, 10, 50][models.indexOf(p.model)] }] }));
  const seen = [];
  const pick = (catalog, instructions) => {
    seen.push({ catalog, instructions });
    assert.equal(catalog.length, 4); assert.ok(catalog.every(p => ['low', 'medium'].includes(p.effort)));
    assert.deepEqual(new Set(catalog.map(p => p.model)), new Set([models[2], models[3]]), 'measured extremes are excluded independently of names');
    assert.equal(catalog.find(p => p.model === models[3]).index, undefined, 'unknown evidence is retained');
    assert.ok(catalog.every(p => p.description && p.provider === 'custom-provider'));
    assert.match(instructions, /mid-tier.*available catalog/);
    assert.doesNotMatch(instructions, /Sol|Sonnet|Opus|Astra|Haiku|Luna/);
    const measured = catalog.filter(p => p.effort === 'low' && Number.isFinite(p.index)).sort((a, b) => a.index - b.index);
    return measured[0].id;
  };
  router.jev = { configured: true, evaluate: async ({ catalog }, questions) => ({
    answers: { preset: { choice: pick(catalog, questions.preset.instructions), confidence: 0.1 } }, usage: { inputTokens: 7 },
  }) };
  router.complete = async ({ instructions, prompt, schema }) => {
    const catalog = JSON.parse(prompt).catalog;
    assert.deepEqual(schema.properties.preset.enum, catalog.map(p => p.id));
    return { decision: { preset: pick(catalog, instructions), reason: 'Balanced capability and cost for coordination.' }, usage: { inputTokens: 9 } };
  };
  const classifier = { model: 'configured-router', effort: 'low' };
  for (const provider of ['jev', 'smart']) {
    const result = await router.chooseHub(workers, provider, classifier, new AbortController());
    assert.equal(result.model, models[2]); assert.equal(result.effort, 'low');
    assert.equal(result.routerUsage.inputTokens, provider === 'jev' ? 7 : 9);
  }
  assert.deepEqual(seen[0], seen[1], 'both routers receive identical policy and catalog evidence');
  router.jev.evaluate = async () => { throw new Error('Temporarily unavailable'); };
  const fallback = await router.chooseHub(workers, 'jev', classifier, new AbortController());
  assert.equal(fallback.model, models[2]); assert.match(fallback.routerFallback, /Smart selected/);
  router.complete = async () => ({ decision: { preset: `${models[2]}:high`, reason: 'Invalid higher effort.' } });
  await assert.rejects(router.chooseHub(workers, 'smart', classifier, new AbortController()), /unavailable Hub model or effort/);
  router.complete = async () => ({ decision: { preset: `${models[0]}:low`, reason: 'Invalid top-tier model at Low effort.' } });
  await assert.rejects(router.chooseHub(workers, 'smart', classifier, new AbortController()), /unavailable Hub model or effort/);
  router.jev.evaluate = async () => ({ answers: { preset: { choice: 'invented-model' } } });
  await assert.rejects(router.chooseHub(workers, 'jev', classifier, new AbortController()), /unavailable Hub model or effort/);
  const abort = new AbortController();
  router.jev.evaluate = async () => { abort.abort(); throw Object.assign(new Error('Stopped'), { name: 'AbortError' }); };
  router.complete = async () => { assert.fail('Stop must not start fallback inference'); };
  await assert.rejects(router.chooseHub(workers, 'jev', classifier, abort), { name: 'AbortError' });
});

test('stopping Hub during automatic selection discards late model choices', async t => {
  const { hub, session, calls, send } = await setup(t);
  hub.data.settings.mode = 'auto';
  let release;
  hub.smartRouter.chooseHub = async workers => { await new Promise(resolve => { release = resolve; }); return workers[0]; };
  const pending = send('Hello');
  await until(() => !!release);
  assert.equal(hub.routing, session.id); assert.equal(hub.busy, session.id);
  await hub.stop(); release(); await pending;
  assert.equal(calls.length, 0); assert.equal(hub.data.hubMode, undefined);
  assert.equal(hub.busy, null); assert.equal(hub.routing, null); assert.equal(hub.activeTurns.size, 0);
  assert.equal(session.status, 'interrupted');
});

test('Hub capability bands handle ties, sparse evidence and duplicate provider/effort rows', async () => {
  const router = new SmartRouter(__dirname);
  for (const [scores, expected] of [
    [[10, 50, 90], [1]], [[50, 50, 50], [0, 1, 2]], [[10, 10, 90], [0, 1]],
    [[10, 90], [0, 1]], [[null, null, null], [0, 1, 2]], [[10, 20, 30, 40, 50, 60, 70, 80], [2, 3, 4, 5]],
  ]) {
    const workers = scores.flatMap((score, i) => ['low', 'medium'].map(effort => ({ id: `provider:model-${i}:${effort}`, model: `model-${i}`, effort, score })));
    workers.push(...workers.filter(p => p.model === 'model-0').map(p => ({ ...p, id: 'other-' + p.id })));
    router.benchmarks.catalog = rows => rows.map(p => ({ ...p, benchmarks: p.score === null ? [] : [{ source: 'aa-index', version: 'test', harness: 'api', score: p.score }] }));
    router.complete = async ({ prompt }) => {
      const catalog = JSON.parse(prompt).catalog;
      assert.deepEqual([...new Set(catalog.map(p => p.model))], expected.map(i => `model-${i}`));
      return { decision: { preset: catalog[0].id, reason: 'A balanced choice from the offered catalog.' } };
    };
    await router.chooseHub(workers, 'smart', { model: 'classifier' }, new AbortController());
  }
});

test('Hub creates Auto workers with inherited access and images, stays responsive, and receives results', async t => {
  const { hub, session, agents, calls, replies, send } = await setup(t);
  const image = 'data:image/png;base64,aGVsbG8=';
  replies.push(action('agent_work', { name: 'Fixer', task: 'Inspect the image and fix the issue.' }));
  await hub.send({ id: session.id, text: 'Fix this issue', images: [image] });
  const profile = hub.data.agents[0], worker = agents.controller(profile.id);
  assert.equal(profile.mode, 'auto'); assert.equal(profile.access, 'workspace-write');
  await until(() => worker.activeTurns.size > 0);
  const work = agents.conversation(worker);
  assert.deepEqual(work.delegation.images, [image]);
  assert.match(work.delegation.task, /agent_read_context/);
  assert.equal(hub.busy, null, 'Hub is free to chat while its worker runs');
  assert.equal(worker.busy, work.id);
  await send('Can we chat while that runs?');
  assert.equal(session.items.at(-1).text, 'Hello.');
  assert.equal(worker.busy, work.id, 'Hub chatting does not stop its worker');
  replies.push(answer('The worker fixed it and verified the result.'));
  worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Fixed and checked.' } } });
  worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
  await until(() => session.items.at(-1)?.text === 'The worker fixed it and verified the result.');
  assert.match(calls.at(-1).request.prompt, /Fixed and checked/);
  assert.equal(session.hubWorker, profile.id);
  replies.push(action('agent_work', { agentId: profile.id, task: 'Also handle this follow-up.' }));
  await send('Also fix the related issue');
  assert.equal(hub.data.agents.length, 1, 'follow-up reuses the same worker');
  assert.equal(agents.conversation(worker).id, work.id);
});

test('Hub saves its effective mode and resumes old worker results with its pinned model', async t => {
  for (const mode of ['auto', 'terra-light']) await t.test(mode, async t => {
    const { hub, session, calls, send } = await setup(t);
    hub.data.settings.mode = 'removed-local-model';
    await hub.send({ id: session.id, text: 'Hello', mode });
    const selected = calls.at(-1).choice.id;
    assert.equal(hub.data.settings.mode, mode);
    assert.equal(JSON.parse(fs.readFileSync(hub.filename)).settings.mode, mode);
    hub.smartRouter.chooseHub = async () => assert.fail('A returned result must reuse the pin');
    session.queuePaused = true;
    session.queue = [{ id: 'old-result', text: 'The review completed.', mode: 'removed-local-model', task: 'off', agentReply: true }];
    await hub.queuedMessage(session.id, 'old-result', 'send');
    assert.equal(calls.at(-1).choice.id, selected);
    assert.equal(calls.at(-1).choice.source, mode === 'auto' ? 'hub-auto' : 'manual');
    assert.equal(JSON.parse(calls.at(-1).request.prompt).incoming, 'worker_result');
    assert.equal(session.status, 'completed'); assert.equal(session.error, null);
    assert.equal(session.queue.length, 0); assert.equal(session.queuePaused, false);
    await send('Continue');
    assert.equal(calls.at(-1).choice.id, selected);
  });
});

test('Hub automatic dispatch avoids old manual pins and has no alternate delegation bypass', async t => {
  const { hub, session, agents, replies, calls, send } = await setup(t);
  const manual = await agents.saveAgent({ name: 'Local specialist', instructions: '', workspace: session.workspace, mode: 'terra-light', access: session.access });
  session.hubWorker = manual.id;
  replies.push(action('agent_work', { agentId: manual.id, name: 'Reviewer', task: 'Review the changes.' }));
  await send('Review changes');
  assert.equal(calls[0].request.schema.properties.action.anyOf.some(s => s.properties?.tool.enum.includes('agent_delegate')), false);
  assert.equal(hub.data.agents.length, 2);
  assert.equal(hub.data.agents.find(p => p.id === manual.id).mode, 'terra-light');
  assert.equal(agents.controller(manual.id).busy, null);
  const created = hub.data.agents.find(p => p.id !== manual.id);
  assert.equal(created.mode, 'auto'); assert.equal(session.hubWorker, created.id);
  replies.push(action('agent_work', { agentId: manual.id, mode: manual.mode, task: 'Use this specific agent as requested.' }));
  await send('Ask Local specialist to help too');
  assert.equal(session.hubWorker, manual.id);
  assert.equal(agents.conversation(agents.controller(manual.id)).delegation.source, session.id);
  assert.equal(session.hubWorkerMode, manual.mode);
});

test('Hub management preserves access checks and rejects unsupported tools and stale responses', async t => {
  const { hub, session, agents, replies, send } = await setup(t);
  replies.push(action('agent_create', { name: 'Reviewer', instructions: 'Review only', mode: 'terra-light' }), answer('Created Reviewer.'));
  await send('Create Reviewer');
  const profile = hub.data.agents[0];
  assert.equal(profile.mode, 'terra-light');
  assert.equal(agents.controller(profile.id).busy, null);
  replies.push(action('agent_set_access', { agentId: profile.id, access: 'danger-full-access' }));
  await assert.rejects(send('Give it full access'), /Cannot grant more access/);
  assert.equal(profile.access, 'workspace-write');
  for (const tool of ['router_call_tool', 'agent_delegate']) {
    replies.push(action(tool, { agentId: profile.id, task: 'Bypass routing' }));
    await assert.rejects(send('Review the code'), /invalid response/);
    assert.equal(agents.controller(profile.id).busy, null);
  }
  for (const args of [{ agentId: false }, { name: 0 }, { name: '' }]) {
    replies.push(action('agent_work', { task: 'Review.', ...args }));
    await assert.rejects(send('Review this'), /valid worker id|worker name|invalid action arguments/);
    assert.equal(hub.data.agents.length, 1);
  }
  await assert.rejects(hub.queuedMessage(session.id, 'queued', 'steer'), /queued follow-ups/);
  let release;
  hub.smartRouter.complete = () => new Promise(resolve => { release = resolve; });
  const pending = send('Create another worker');
  await until(() => release);
  await hub.stop();
  release({ decision: action('agent_create', { name: 'Late', instructions: '' }) });
  await pending;
  assert.equal(hub.data.agents.length, 1, 'late model output after Stop cannot create agents');
  assert.equal(session.status, 'interrupted'); assert.equal(hub.busy, null);
});

test('Hub review dispatch lets Jev and Smart route to available Claude instead of a pinned local agent', async t => {
  for (const routing of ['jev', 'smart']) await t.test(routing, async t => {
    const { hub, session, agents, replies, send } = await setup(t);
    hub.data.settings.routing = routing; hub.data.settings.jevEnabled = true;
    hub.data.settings.claudeEnabled = true; hub.claude.status = { loggedIn: true };
    hub.claude.models = [{ id: 'claude-cli:review-model', model: 'review-model', provider: 'claude-cli', efforts: ['high'], rank: 35, worker: true, router: true }];
    hub.data.settings.providers = [{ id: 'local', enabled: true }];
    hub.data.settings.providerModels = [{ id: 'local:gemma-test', model: 'gemma-test', provider: 'local', worker: true, enabled: true, rank: 30 }];
    const manual = await agents.saveAgent({ name: 'LM Studio agent', instructions: '', workspace: session.workspace, mode: 'local:gemma-test', access: session.access });
    await agents.initialize();
    let submitted, routingCalls = 0;
    agents.configure = async worker => {
      worker.smartRouter.choose = async (text, context, models, provider) => {
        routingCalls++;
        assert.equal(provider, routing); assert.equal(text, 'Review PE changes', 'routing receives the user request, not Hub wording');
        assert.ok(context.routingCatalog.some(p => p.provider === 'local'), 'local models remain eligible through normal routing');
        const choice = context.routingCatalog.find(p => p.provider === 'claude-cli');
        assert.ok(choice, 'available Claude must reach the worker router');
        return { ...choice, source: routing, needsChecks: false };
      };
      worker.submitWorker = async (work, choice) => { submitted = choice; return choice; };
    };
    replies.push(action('agent_work', { agentId: manual.id, task: 'Review changes' }));
    await send('Review PE changes');
    await until(() => !!submitted);
    assert.equal(routingCalls, 1);
    assert.equal(submitted.provider, 'claude-cli'); assert.equal(submitted.effort, 'high', 'Hub effort limits do not constrain the worker');
    assert.equal(agents.controller(manual.id).busy, null);
    assert.equal(agents.profile(manual.id).mode, 'local:gemma-test');
  });
});

test('Hub compacts older context without removing visible history and retains the summary on disk', async t => {
  const { hub, session, calls, send } = await setup(t);
  for (let i = 0; i < 12; i++) session.items.push({ id: `old-${i}`, type: 'userMessage', content: [{ type: 'text', text: `Request ${i}: ` + 'x'.repeat(4000) }] });
  const before = session.items.map(i => i.id);
  await send('Continue our plan');
  assert.ok(calls.some(c => c.request.schema.properties.summary));
  assert.deepEqual(session.items.slice(0, 12).map(i => i.id), before);
  assert.ok(JSON.parse(fs.readFileSync(hub.filename)).sessions.find(s => s.id === session.id).hubSummary);
  assert.match(calls.at(-1).request.prompt, /User intent and pending work retained/);
  await hub.compact(session.id);
  assert.equal(session.compacting, false);
  assert.match(session.notice, /Visible conversation history is retained/);
});

test('Hub starts reviews in the requested repository and enforces workspace access before creating agents', async t => {
  const { hub, session, agents, replies, send, root } = await setup(t);
  const target = path.join(root, 'project'); fs.mkdirSync(target);
  for (const access of ['read-only', 'workspace-write']) {
    session.access = access;
    replies.push(action('agent_work', { name: 'Reviewer', task: 'Review the project', workspace: target }));
    await assert.rejects(send('Review the other project'), /Full access/);
    assert.equal(hub.data.agents.length, 0);
  }
  session.access = 'danger-full-access';
  const wrong = await agents.saveAgent({ name: 'Old reviewer', instructions: '', workspace: session.workspace, mode: 'auto', access: session.access });
  await agents.initialize();
  const inspected = [];
  agents.configure = async worker => {
    worker.smartRouter.choose = async (text, context) => { inspected.push(context.workspace); return { id: 'terra-light', model: 'gpt-5.6-terra', effort: 'low', provider: 'codex', source: 'smart', needsChecks: false }; };
    worker.submitWorker = async () => {};
  };
  replies.push(action('agent_work', { agentId: wrong.id, name: 'Reviewer', task: 'Review the project', workspace: target }));
  await send('Review the other project');
  await until(() => inspected.length > 0);
  assert.deepEqual(inspected, [fs.realpathSync(target)]);
  const worker = agents.controller(session.hubWorker);
  assert.equal(worker.data.settings.workspace, fs.realpathSync(target));
  assert.equal(agents.conversation(worker).workspace, fs.realpathSync(target));
  assert.notEqual(session.hubWorker, wrong.id);
  assert.equal(agents.profile(wrong.id).workspace, root, 'an existing agent is not silently moved');
  assert.equal(session.workspace, root, 'Hub keeps its own workspace');
});

test('Hub honors explicit worker model and effort without changing its chat model', async t => {
  const { hub, session, replies, send } = await setup(t);
  replies.push(action('agent_work', { name: 'Specific', task: 'Review the project.', mode: 'terra-light', effort: 'low' }));
  await send('Use Terra with low effort for the review');
  const worker = hub.resolveWorker(hub.data.agents[0].mode);
  assert.equal(worker.model, 'gpt-5.6-terra'); assert.equal(worker.effort, 'low');
  assert.equal(hub.data.settings.mode, 'terra-light'); assert.equal(session.hubWorker, hub.data.agents[0].id);
  replies.push(action('agent_work', { name: 'Invalid', task: 'Review.', mode: 'terra-light', effort: 'unsupported' }));
  await assert.rejects(send('Another review'), /Unsupported effort/);
  assert.equal(hub.data.agents.length, 1);
});

test('Hub dispatches four explicitly configured reviewers and waits for every result', async t => {
  const { hub, session, agents, replies, calls, send } = await setup(t);
  session.access = 'danger-full-access';
  hub.models.forEach(model => model.supportedReasoningEfforts.push({ reasoningEffort: 'xhigh' }));
  agents.configure = async worker => {
    const call = worker.client.call.bind(worker.client);
    worker.client.call = (method, params) => method === 'model/list' ? Promise.resolve({ data: hub.models }) : call(method, params);
  };
  const original = 'Create four reviewers using Sol at xhigh. Have each review the whole project without edits.';
  replies.push(action('agent_work', { name: 'Reviewer', count: 4, task: 'Review the whole project without edits.', mode: 'codex:gpt-5.6-sol:medium', effort: 'xhigh' }));
  await send(original);
  assert.equal(hub.data.agents.length, 4);
  assert.equal(session.agentDelegations, 4);
  assert.equal(hub.data.settings.mode, 'terra-light');
  assert.match(session.items.at(-1).text, /4 agents/);
  const workers = hub.data.agents.map(profile => agents.controller(profile.id));
  await until(() => workers.every(worker => worker.activeTurns.size > 0));
  assert.ok(workers.every(worker => agents.conversation(worker).access === 'danger-full-access'));
  for (const [index, worker] of workers.entries()) {
    const work = agents.conversation(worker);
    await until(() => worker.activeTurns.size > 0);
    assert.equal(worker.resolveWorker(worker.data.settings.mode).effort, 'xhigh');
    assert.equal(worker.resolveWorker(worker.data.settings.mode).model, 'gpt-5.6-sol');
    const turn = worker.client.calls.findLast(call => call.method === 'turn/start');
    assert.equal(turn.params.effort, 'xhigh'); assert.equal(turn.params.model, 'gpt-5.6-sol');
    assert.equal(work.workspace, session.workspace); assert.equal(work.access, session.access);
    assert.equal(work.delegation.originalRequest.text, original);
    assert.equal(work.delegation.originalRequest.batch.index, index + 1);
    assert.match(work.delegation.task, /one of 4 independent workers/i);
    assert.ok(workers.slice(index).every(other => other.activeTurns.size > 0), 'all unfinished reviewers run concurrently');
    if (index === 3) replies.push(answer('All four reviews are complete. Here are the combined findings.'));
    worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: `Review ${index + 1}: inspected every file; finding in file${index + 1}.c:12.` } } });
    worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
    await until(() => !hub.busy && session.items.some(item => item.hubBatchResult?.index === index + 1));
    if (index < 3) {
      assert.match(session.items.at(-1).text, new RegExp(`${index + 1}/4`));
      assert.equal(session.hubCompletion.fulfilled, false);
      assert.equal(calls.filter(c => c.request.schema.properties.action).length, 1, 'no final synthesis before all four return');
    }
  }
  assert.match(session.items.at(-1).text, /All four reviews are complete/);
  const synthesis = JSON.parse(calls.at(-1).request.prompt);
  assert.equal(synthesis.batchResults.length, 4);
  assert.ok(synthesis.batchResults.every((result, i) => result.text.includes(`file${i + 1}.c:12`)));
  const saved = JSON.parse(fs.readFileSync(hub.filename)).sessions.find(s => s.id === session.id);
  assert.equal(saved.items.filter(item => item.hubBatchResult).length, 4);
  assert.equal(session.hubCompletion.fulfilled, true);
});

test('Hub batch bounds and capacity reject the whole request before creating workers', async t => {
  const { hub, session, replies, agents, send } = await setup(t);
  for (const count of [0, 11, 1.5, '4']) {
    replies.push(action('agent_work', { name: 'Reviewer', count, task: 'Review.' }));
    await assert.rejects(send('Create reviewers'), /invalid action arguments/);
    assert.equal(hub.data.agents.length, 0);
  }
  const profile = await agents.saveAgent({ name: 'Existing', instructions: '', workspace: session.workspace, mode: 'auto', access: session.access });
  await agents.initialize();
  const worker = agents.controller(profile.id);
  for (let index = 0; index < 7; index++) worker.data.sessions.push({ id: randomUUID(), delegation: { delivered: false, state: 'held' } });
  replies.push(action('agent_work', { name: 'Reviewer', count: 4, task: 'Review.' }));
  await assert.rejects(send('Create four reviewers'), /queue is full/);
  assert.equal(hub.data.agents.length, 1, 'no partial batch when queue capacity is already known');
});

test('Hub batch partial dispatch reports missing workers instead of waiting forever', async t => {
  const { hub, session, agents, replies, send } = await setup(t);
  const create = agents.saveAgent.bind(agents);
  agents.saveAgent = value => {
    if (hub.data.agents.length === 2) throw new Error('Provider became unavailable.');
    return create(value);
  };
  replies.push(action('agent_work', { name: 'Reviewer', count: 4, task: 'Review.' }));
  await assert.rejects(send('Create four independent reviewers'), /Sent 2\/4 agent tasks/);
  assert.equal(hub.data.agents.length, 2);
  for (const profile of hub.data.agents) {
    const worker = agents.controller(profile.id), work = agents.conversation(worker);
    await until(() => worker.activeTurns.size > 0);
    worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Reviewed the project. No findings; all source files inspected.' } } });
    worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
    await until(() => !hub.busy && session.items.some(item => item.hubBatchResult?.agentId === worker.agentId));
  }
  assert.equal(session.hubCompletion.fulfilled, false);
  assert.match(session.items.at(-1).text, /2 requested workers were not dispatched/);
  assert.doesNotMatch(session.items.at(-1).text, /Waiting for the remaining/);
});

test('cancelled batch results are recorded without starting replacement workers', async t => {
  const { hub, session, agents, replies, calls, send } = await setup(t);
  replies.push(action('agent_work', { name: 'Reviewer', count: 4, task: 'Review.' }));
  await send('Create four independent reviewers');
  await agents.stop(session.id);
  await until(() => hub.data.agents.every(profile => agents.conversation(agents.controller(profile.id)).delegation.delivered));
  const queued = [...session.queue];
  session.queue = []; session.queuePaused = true;
  for (const result of queued) {
    assert.equal(result.agentReplyCancelled, true);
    await hub.send({ ...result, id: session.id });
  }
  assert.equal(hub.data.agents.length, 4);
  assert.equal(session.hubCompletion.fulfilled, false);
  assert.match(session.items.at(-1).text, /Worker was cancelled/);
  assert.equal(calls.filter(call => call.request.schema.properties.action).length, 1);
});

test('Hub batch follow-ups retain one assignment and exhausted dispatch budgets settle incomplete results', async t => {
  for (const exhausted of [false, true]) await t.test(exhausted ? 'budget exhausted' : 'one follow-up', async t => {
    const { hub, session, agents, replies, assessments, calls, send } = await setup(t);
    replies.push(action('agent_work', { name: 'Reviewer', count: 2, task: 'Review.' }));
    await send('Create two independent full project reviewers');
    if (exhausted) session.agentDelegations = 10;
    const workers = hub.data.agents.map(profile => agents.controller(profile.id));
    const sequence = exhausted ? workers : [...workers, workers[0]];
    for (const [index, worker] of sequence.entries()) {
      const work = agents.conversation(worker);
      await until(() => worker.activeTurns.size > 0);
      const oldJob = work.delegation;
      if (index === 0) assessments.push({ fulfilled: false, evidence: 'Only a summary.', gaps: ['Inspect actual code.'] });
      if (index === 2) replies.push(answer('Both independent reviews returned.'));
      worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: index === 0 ? 'Summary only.' : `Reviewed code for ${worker.agentId}; no findings.` } } });
      worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
      if (index === 0 && !exhausted) {
        await until(() => work.delegation.id !== oldJob.id);
        assert.deepEqual(work.delegation.originalRequest.batch, oldJob.originalRequest.batch);
        assert.equal(work.delegation.originalRequest.attempts, 2);
      } else await until(() => !hub.busy && session.items.some(item => item.hubBatchResult?.agentId === worker.agentId));
    }
    assert.equal(hub.data.agents.length, 2);
    assert.equal(session.error, null);
    assert.equal(session.hubCompletion.fulfilled, !exhausted);
    if (exhausted) assert.match(session.items.at(-1).text, /2\/2 agent results returned.*not been confirmed complete/);
    else {
      const context = JSON.parse(calls.at(-1).request.prompt);
      assert.equal(context.batchResults.length, 2);
      assert.ok(context.batchResults.every(result => !result.text.includes('Summary only.')));
    }
  });
});

test('Hub never restarts a cancelled result and failed compaction preserves original messages', async t => {
  const { hub, session, replies } = await setup(t);
  replies.push(action('agent_work', { name: 'Restart', task: 'Continue stopped work.' }));
  await assert.rejects(hub.send({ id: session.id, text: 'Worker stopped.', agentReply: true, agentReplyCancelled: true }), /will not restart automatically/);
  assert.equal(hub.data.agents.length, 0);
  const original = JSON.stringify(session.items);
  hub.smartRouter.complete = async () => { throw new Error('Provider offline'); };
  await assert.rejects(hub.compact(session.id), /Provider offline/);
  assert.equal(JSON.stringify(session.items), original);
  assert.equal(session.hubSummaryThrough, undefined); assert.equal(hub.busy, null);
});

test('structured Hub inference uses isolated tool-free provider configuration', async t => {
  const { root } = await setup(t);
  const client = new Client();
  client.call = async (method, params) => {
    client.calls.push({ method, params });
    if (method === 'config/read') return { config: { mcp_servers: { external: {} }, plugins: { extra: {} } } };
    if (method === 'thread/start') return { thread: { id: 'isolated' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        client.emit('notification', { method: 'item/completed', params: { threadId: 'isolated', item: { type: 'agentMessage', text: JSON.stringify(answer('Hello')) } } });
        client.emit('notification', { method: 'turn/completed', params: { threadId: 'isolated', turn: { status: 'completed' } } });
      });
    }
    return {};
  };
  const router = new SmartRouter(path.join(root, 'isolated'), () => client);
  t.after(() => router.close());
  await router.complete({ instructions: 'Hub policy', prompt: 'Hello', schema: { type: 'object' } }, { model: 'test', effort: 'low' }, new AbortController());
  const params = client.calls.find(c => c.method === 'thread/start').params;
  assert.equal(params.baseInstructions, 'Hub policy'); assert.equal(params.ephemeral, true);
  assert.equal(params.sandbox, 'read-only'); assert.equal(params.approvalPolicy, 'never');
  assert.equal(params.config['features.shell_tool'], false); assert.equal(params.config['features.multi_agent'], false);
  assert.equal(params.config.web_search, 'disabled'); assert.equal(params.config.project_doc_max_bytes, 0);
  assert.deepEqual(params.config.mcp_servers, { external: { enabled: false } });
  assert.deepEqual(params.config.plugins, { extra: { enabled: false } });
  const local = { provider: 'lm-studio', model: 'fixed-effort-model', effort: null };
  let prepared;
  router.providers = {
    prepare: async choice => { prepared = choice; },
    config: choice => {
      assert.equal(prepared, choice, 'local model preparation precedes inference');
      return { modelProvider: choice.provider, config: { model_context_window: 32768 } };
    },
  };
  await router.complete({ instructions: 'Hub policy', prompt: 'Hello', schema: { type: 'object' } }, local, new AbortController());
  const localParams = client.calls.findLast(c => c.method === 'thread/start').params;
  assert.equal(localParams.modelProvider, 'lm-studio'); assert.equal(localParams.config.model_context_window, 32768);
  assert.equal(Object.hasOwn(localParams.config, 'model_reasoning_effort'), false);
  assert.equal(client.calls.findLast(c => c.method === 'turn/start').params.effort, null);
  for (const provider of ['claude-cli', 'cursor-cli']) {
    let options;
    router[provider === 'claude-cli' ? 'claude' : 'cursor'] = { run: async value => { options = value; return { result: JSON.stringify(answer('Hello')) }; } };
    await router.complete({ instructions: 'Hub policy', prompt: 'Hello', schema: { type: 'object' } }, { provider, model: 'test' }, new AbortController());
    assert.ok(options.schema); assert.equal(options.cwd, path.join(root, 'isolated'));
    assert.equal(options.resume, undefined); assert.equal(options.helpers, undefined);
  }
});

test('Hub uses local structured inference for replies and never treats malformed replies as actions', async t => {
  const { hub, session, root, send } = await setup(t);
  for (const provider of ['codex', 'claude-cli', 'cursor-cli']) hub.setProviderEnabled(provider, false);
  hub.providerSettings({ action: 'provider', provider: { id: 'local', name: 'Local', baseUrl: 'http://localhost:1234/v1' } });
  hub.providerSettings({ action: 'model', model: { provider: 'local', model: 'local-chat', label: 'Local chat', description: '', rank: 30 } });
  hub.data.settings.mode = 'auto';
  await hub.refreshAccount();
  const router = new SmartRouter(root, () => assert.fail('Local structured inference must not use the Responses backend'));
  t.after(() => router.close());
  let reply = answer('Hello from local Hub');
  router.providers = { structured: async (choice, request, signal) => {
    assert.equal(choice.provider, 'local'); assert.equal(choice.effort, null);
    assert.ok(request.schema.properties.action.anyOf.some(s => s.properties?.tool.enum.includes('agent_work')));
    assert.match(request.instructions, /permanent chat and coordination/);
    assert.equal(signal.aborted, false);
    if (reply instanceof Error) throw reply;
    return { decision: reply };
  } };
  hub.smartRouter = router;
  await send('hello');
  assert.equal(session.items.at(-1).text, 'Hello from local Hub');
  for (const invalid of [new Error('Local returned an invalid structured response. No action was taken.'), action('unknown_action', {})]) {
    reply = invalid;
    await assert.rejects(send('hello again'), /invalid.*response/);
    assert.equal(hub.data.agents.length, 0);
    assert.equal(session.status, 'failed');
  }
});

test('Hub hands off structured arguments with Windows paths, quotes and pasted text intact', async t => {
  const { hub, session, agents, replies, calls, send } = await setup(t);
  const task = String.raw`Review C:\new\tasks\PhasmaEngine and \\server\share\PE. Preserve "quoted text" and Ω.` + '\nSecond line.';
  replies.push(JSON.parse(JSON.stringify(action('agent_work', { task, workspace: session.workspace, name: 'Reviewer', agentId: null, mode: null, effort: null }))));
  await send('Review PE changes');
  const worker = agents.controller(session.hubWorker), work = agents.conversation(worker);
  assert.ok(work.delegation.task.includes(task + '\n\nOriginal request:'), work.delegation.task);
  assert.equal(work.workspace, session.workspace);
  assert.equal(worker.data.settings.mode, 'auto'); assert.equal(work.access, session.access);
  const variant = calls[0].request.schema.properties.action.anyOf.find(s => s.properties?.tool.enum.includes('agent_work'));
  assert.equal(variant.properties.arguments.type, 'object');
  assert.deepEqual(variant.properties.arguments.required, Object.keys(variant.properties.arguments.properties));
  assert.ok(variant.properties.arguments.properties.mode.anyOf.some(s => s.type === 'null'));
});

test('Hub rejects malformed or mismatched action arguments before any side effect', async t => {
  const { hub, replies, send } = await setup(t);
  const malformed = String.raw`{"workspace":"C:\Users\Christos\repos\PhasmaEngine","task":"Review"}`;
  for (const decision of [
    { reply: '', tool: 'agent_work', arguments: malformed },
    action('agent_work', malformed), action('agent_work', []), action('agent_work', null),
    action('agent_work', { task: null }), action('agent_work', { task: 'Review', arbitrary: true }),
    action('agent_create', { name: 'Reviewer', task: 'Wrong tool arguments' }),
    action('agent_set_access', { agentId: 'missing', access: 'root' }),
    action('agent_read_context', { agentId: 'main', line: 1.5 }),
  ]) {
    replies.push(decision);
    await assert.rejects(send('Review changes'), /invalid response|invalid action arguments/);
    assert.equal(hub.data.agents.length, 0);
  }
});

test('Hub preserves the original request for routing, execution, disk and result checks despite misleading notes or later chat', async t => {
  const { hub, session, agents, replies, calls, send } = await setup(t);
  const original = String.raw`Review PE changes in C:\new\tasks\PhasmaEngine. Include "Ω" and untracked shaders; report file/line findings. Do not edit.`;
  let routed;
  agents.configure = async worker => {
    worker.smartRouter.choose = async text => { routed = text; return { id: 'terra-light', model: 'gpt-5.6-terra', effort: 'low', provider: 'codex', source: 'smart', needsChecks: false }; };
  };
  replies.push(action('agent_work', { name: 'Reviewer', task: 'Identify what PE means and provide only a summary.' }));
  await send(original);
  const worker = agents.controller(session.hubWorker), work = agents.conversation(worker);
  await until(() => worker.activeTurns.size > 0);
  assert.equal(routed, original);
  assert.equal(work.delegation.originalRequest.text, original);
  assert.equal(JSON.parse(fs.readFileSync(worker.filename)).sessions[0].delegation.originalRequest.text, original);
  const input = worker.client.calls.find(call => call.method === 'turn/start').params.input[0].text;
  assert.ok(input.includes(original));
  assert.ok(input.indexOf(original) < input.indexOf('Identify what PE means'));
  assert.match(input, /must not replace, narrow or contradict/);
  await send('What is your name?');
  replies.push(answer('Review returned.'));
  worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Reviewed all changes. Finding at shader.hlsl:42 with evidence.' } } });
  worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
  await until(() => session.items.at(-1)?.text === 'Review returned.');
  const check = calls.find(call => call.request.schema.properties.fulfilled);
  assert.equal(JSON.parse(check.request.prompt).originalRequest.text, original);
  assert.equal(JSON.parse(calls.at(-1).request.prompt).originalRequest.text, original);
  assert.equal(session.hubRequest.text, 'What is your name?', 'returning work does not overwrite the latest user request');
});

test('an incomplete review is continued with its original scope and images, then stops honestly at the follow-up limit', async t => {
  const { hub, session, agents, replies, assessments, calls } = await setup(t);
  const original = 'Review all changed code, including untracked files, with concrete file/line findings.';
  const image = 'data:image/png;base64,aGVsbG8=';
  replies.push(action('agent_work', { name: 'Reviewer', task: 'Summarize what changed.' }));
  await hub.send({ id: session.id, text: original, images: [image] });
  const worker = agents.controller(session.hubWorker), work = agents.conversation(worker);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await until(() => worker.activeTurns.size > 0);
    const job = work.delegation;
    assert.equal(job.originalRequest.attempts, attempt);
    assert.equal(job.originalRequest.text, original);
    assert.deepEqual(job.images, [image]);
    assessments.push({ fulfilled: false, evidence: 'The worker explicitly says it did not review the code.', gaps: ['Inspect the actual C++ and HLSL changes; a summary is insufficient.'] });
    worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'I did not read the C++ or HLSL diffs line by line, so this is not a code review. [task: done]' } } });
    worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
    if (attempt < 3) {
      await until(() => work.delegation.id !== job.id);
      assert.match(work.delegation.task, /Inspect the actual C\+\+ and HLSL changes/);
    } else await until(() => session.items.at(-1)?.text?.includes('automatic follow-up limit'));
  }
  assert.equal(hub.data.agents.length, 1);
  assert.equal(worker.busy, null);
  assert.equal(session.hubCompletion.fulfilled, false);
  assert.match(session.items.at(-1).text, /not been confirmed complete/);
  assert.equal(calls.filter(call => call.request.schema.properties.fulfilled).length, 3);
  assert.equal(calls.filter(call => call.request.schema.properties.action).length, 1, 'an incomplete result cannot reach a success-writing prompt');
});

test('invalid completion checks and a stop during a late check never dispatch more work', async t => {
  const { hub, session, agents, replies, assessments, send } = await setup(t);
  replies.push(action('agent_work', { name: 'Reviewer', task: 'Review.' }));
  await send('Review all code');
  const worker = agents.controller(session.hubWorker), work = agents.conversation(worker);
  await until(() => worker.activeTurns.size > 0);
  const agentResult = { request: work.delegation.originalRequest, agentId: worker.agentId, workspace: work.workspace, status: 'completed' };
  assessments.push({ fulfilled: true, evidence: '', gaps: [] });
  await assert.rejects(hub.send({ id: session.id, text: 'Summary only.', agentReply: true, agentResult }), /could not verify/);
  assert.equal(session.agentDelegations, 1);
  let release;
  hub.smartRouter.complete = () => new Promise(resolve => { release = resolve; });
  const pending = hub.send({ id: session.id, text: 'Summary only.', agentReply: true, agentResult });
  await until(() => !!release);
  await hub.stop();
  release({ decision: { fulfilled: false, evidence: 'No review evidence.', gaps: ['Read the code.'] } });
  await pending;
  assert.equal(session.status, 'interrupted');
  assert.equal(session.agentDelegations, 1);
  assert.equal(agents.controllers.size, 2);
});

test('a new Hub request clears old task model retention while automatic continuations keep their request identity', async t => {
  const { hub, session, agents, replies, assessments, send } = await setup(t);
  const profile = await agents.saveAgent({ name: 'Previous reviewer', instructions: '', workspace: session.workspace, mode: 'auto', access: session.access });
  await agents.initialize();
  const worker = agents.controller(profile.id), work = agents.conversation(worker, true, session.workspace, session.access);
  const oldWorker = { id: 'terra-light', model: 'gpt-5.6-terra', effort: 'low', provider: 'codex' };
  work.job = { goal: 'Identify the PE acronym.', worker: oldWorker, status: 'done' };
  const contexts = [];
  worker.smartRouter.choose = async (text, context) => {
    contexts.push(context.job);
    return { ...oldWorker, source: 'smart', needsChecks: false, sameTask: !!context.job };
  };
  replies.push(action('agent_work', { agentId: profile.id, task: 'Summarize the project again.' }));
  await send('Review every changed source file');
  await until(() => worker.activeTurns.size > 0);
  assert.equal(contexts[0], null);
  assessments.push({ fulfilled: false, evidence: 'No source review completed.', gaps: ['Read the changed source.'] });
  const oldTurn = work.turnId;
  worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: oldTurn, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Summary only.' } } });
  worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: oldTurn, status: 'completed' } } });
  await until(() => contexts.length === 2);
  assert.equal(contexts[1].originalRequestId, work.delegation.originalRequest.id);
  assert.equal(contexts[1].goal, 'Review every changed source file');
});

test('completion never approves a partial report, oversized original request or failed worker', async t => {
  for (const scenario of ['report', 'request', 'failed']) await t.test(scenario, async t => {
    const { session, agents, replies, calls, send } = await setup(t);
    const original = 'Review every changed source file.' + (scenario === 'request' ? ' Constraint.'.repeat(1600) : '');
    replies.push(action('agent_work', { name: 'Reviewer', task: 'Review the changes.' }));
    await send(original);
    const worker = agents.controller(session.hubWorker), work = agents.conversation(worker);
    await until(() => worker.activeTurns.size > 0);
    const report = scenario === 'report' ? 'Earlier evidence.\n'.repeat(1000) + 'No bugs found.' : 'No bugs found.';
    worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: report } } });
    worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: scenario === 'failed' ? 'failed' : 'completed' } } });
    await until(() => session.items.at(-1)?.text?.includes('has not been confirmed complete'));
    assert.equal(session.hubCompletion.fulfilled, false, 'an optimistic model assessment cannot override missing evidence or a failed turn');
    assert.equal(session.agentDelegations, 1, 'do not retry execution to fix an assessment-size limit or failed turn');
    assert.equal(calls.filter(call => call.request.schema.properties.action).length, 1);
    const check = JSON.parse(calls.find(call => call.request.schema.properties.fulfilled).request.prompt);
    assert.equal(check.resultTruncated, scenario === 'report');
    assert.equal(check.originalRequest.truncated, scenario === 'request');
  });
});

test('a new delegation to an explicitly selected model starts its own task goal', async t => {
  const { session, agents, replies, send } = await setup(t);
  const profile = await agents.saveAgent({ name: 'Selected reviewer', instructions: '', workspace: session.workspace, mode: 'terra-light', access: session.access });
  await agents.initialize();
  const worker = agents.controller(profile.id), work = agents.conversation(worker, true, session.workspace, session.access);
  work.job = { goal: 'Previous pending work', status: 'pending', turns: 2 };
  replies.push(action('agent_work', { agentId: profile.id, mode: 'terra-light', task: 'Review changes.' }));
  await send('Use Selected reviewer to review every changed source file.');
  await until(() => worker.activeTurns.size > 0);
  worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
  assert.equal(work.job.goal, 'Use Selected reviewer to review every changed source file.');
  assert.equal(work.job.turns, 1);
  assert.equal(work.job.originalRequestId, work.delegation.originalRequest.id);
});
