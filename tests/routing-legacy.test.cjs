// Legacy Auto (Harness picks the model; no longer offered, kept for saved chats and tests) and pinned bots.
const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Controller } = require('../src/controller.cjs');
const { Agents } = require('../src/agents.cjs');
const test = (name, run) => nodeTest(name, { timeout: 15000 }, run);

const SCORES = { weak: 50, mid: 80, cheap: 65, strong: 100 };
const COSTS = { weak: 0.1, cheap: 0.3, mid: 1, strong: 3 };
const preset = (model, effort, provider = 'codex') => ({ id: `${provider}:${model}:${effort}`, provider, model, effort, label: `${model} · ${effort}`,
  worker: true, enabled: true, images: true, rank: 1 });
const catalog = ['weak', 'mid', 'cheap', 'strong'].flatMap(model => ['low', 'medium', 'high', 'xhigh'].map(effort => preset(model, effort)));
const measured = list => list.map(p => ({ ...p, benchmarks: SCORES[p.model] == null ? [] : [{ source: 'aa-index', version: '4', harness: 'aa', score: SCORES[p.model], costUsd: COSTS[p.model] }] }));
const assessment = (difficulty, more = {}) => ({ difficulty, taskKind: 'implementation', workspaceRelevant: false, needsChecks: false, risk: 'low', uncertainty: 'low', ...more });
const pick = (id, difficulty, more) => ({ ...catalog.find(p => p.id === id), reason: 'router reason', assessment: assessment(difficulty, more), source: 'model', router: { evidence: { changedFiles: 0 } } });
class Fake extends EventEmitter {
  constructor() { super(); this.calls = []; }
  async start() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } };
    if (method === 'model/list') return { data: [{ model: 'gpt-5.6-terra', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || randomUUID() } };
    if (method === 'thread/items/list') return { data: [], nextCursor: null };
    if (method === 'turn/start') return { turn: { id: randomUUID() } };
    return {};
  }
  respond() {}
  rejectRequest() {}
  close() {}
}

async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(check(), 'Condition did not become true within two seconds');
}

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-swap-'));
  const workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  const factory = (file, cwd, options) => {
    const c = new Controller(file, cwd, new Fake(), { cancel() {}, close() {}, async choose() { throw new Error('Unexpected model routing'); } }, options);
    c.isCoordinator = () => false;
    c.claude.refresh = async () => c.claude.status;
    c.cursor.refresh = async () => c.cursor.status;
    return c;
  };
  const primary = factory(path.join(directory, 'sessions.json'), workspace);
  await primary.initialize(); primary.data.settings.mode = 'terra-light';
  const agents = new Agents(primary, async () => {}, factory);
  t.after(async () => {
    agents.closing = true; agents.pump();
    clearTimeout(agents.quotaTimer);
    await Promise.all(agents.initializing.values());
    await agents.downloads.close();
    for (const c of agents.allControllers()) c.close();
    fs.rmSync(directory, { force: true, recursive: true });
  });
  // Saved on legacy Auto by an earlier version (it is no longer offered for a new bot).
  const profile = await agents.saveAgent({ name: 'Auto bot', workspace, access: 'workspace-write', mode: 'terra-light', instructions: 'Role: test' });
  agents.profile(profile.id).mode = 'auto';
  const bot = agents.controller(profile.id);
  bot.data.settings.mode = 'auto';
  await agents.initializeController(bot);
  bot.catalog = () => catalog;
  bot.available = () => true;
  bot.effectiveRouter = bot.secondaryPick = () => ({ id: 'router', provider: 'codex', model: 'router', effort: 'low' });
  bot.smartRouter.benchmarks = { catalog: measured, summary: () => null };
  const picks = [];
  bot.smartRouter.choose = async () => picks.shift();
  const session = agents.conversation(bot, true);
  const turns = () => bot.client.calls.filter(call => call.method === 'turn/start').map(call => call.params.model);
  const complete = () => {
    bot.notification({ method: 'item/completed', params: { threadId: session.threadId, turnId: session.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Done.' } } });
    bot.notification({ method: 'turn/completed', params: { threadId: session.threadId, turn: { id: session.turnId, status: 'completed' } } });
  };
  const send = text => bot.send({ id: session.id, text, mode: 'auto', task: 'off' });
  // The bot's first task runs on the router's pick without a question.
  picks.push(pick('codex:weak:medium', 'medium'));
  await send('Start the work');
  assert.equal(session.pendingMessage, null);
  complete(); await until(() => !bot.busy);
  return { agents, bot, session, picks, turns, complete, send };
}

test('an unsure Jev assessment gets the smart router\'s second opinion, whose choice stands', async t => {
  const { bot, session, turns, complete, send } = await setup(t);
  bot.data.settings.routing = 'jev';
  const calls = [];
  let jev;
  bot.smartRouter.choose = async (text, context, models, provider) => {
    calls.push(provider);
    return provider === 'jev' ? jev : { ...pick('codex:strong:high', 'high', { taskKind: 'audit' }), source: 'model' };
  };
  // 2026-11-01: Jev rated security audits "lookup, low" at confidence 0.13, so the model for simple messages ran them.
  jev = { ...pick('codex:weak:low', 'low', { taskKind: 'lookup' }), source: 'jev', router: { confidence: 0.13 } };
  await send('Audit the session handling for permission leaks');
  assert.deepEqual(calls, ['jev', 'smart']);
  const route = session.routes.at(-1);
  assert.deepEqual([route.jevOpinion.confidence, route.jevOpinion.assessment.difficulty, route.assessment.difficulty], [0.13, 'low', 'high']);
  assert.match(route.reason, /Jev was unsure \(confidence 0\.13, low difficulty\); the smart router assessed this message\. router reason$/);
  complete(); await until(() => !bot.busy);

  // A sure Jev is not second-guessed.
  calls.length = 0;
  jev = { ...pick('codex:weak:medium', 'medium'), source: 'jev', router: { confidence: 0.9 } };
  await send('Explain the queue');
  assert.deepEqual(calls, ['jev']); assert.equal(session.routes.at(-1).jevOpinion, undefined);
  complete(); await until(() => !bot.busy);

  // A failed second opinion leaves Jev's choice.
  calls.length = 0;
  jev = { ...pick('codex:weak:low', 'low'), source: 'jev', router: { confidence: 0.2 } };
  bot.smartRouter.choose = async (text, context, models, provider) => { calls.push(provider); if (provider !== 'jev') throw new Error('Router offline.'); return jev; };
  await send('List the files');
  assert.deepEqual([calls, session.routes.at(-1).id, session.routes.at(-1).jevOpinion], [['jev', 'smart'], 'codex:weak:low', undefined]);
  assert.deepEqual(turns(), ['weak', 'strong', 'weak', 'weak'], 'the second opinion runs');
  complete(); await until(() => !bot.busy);
});

test('a pinned bot is never routed, and a model question saved by v0.3.31 is shown as Not sent after a restart', async t => {
  const { agents, bot, session, turns, complete } = await setup(t);
  await agents.saveAgent({ ...agents.profile(bot.agentId), mode: 'terra-light' });
  assert.equal(agents.controller(bot.agentId), bot);
  assert.equal(bot.data.settings.mode, 'terra-light');
  bot.smartRouter.choose = async () => assert.fail('a pinned bot is not routed');
  await bot.send({ id: session.id, text: 'Pinned work', task: 'off' });
  assert.deepEqual(turns(), ['weak', 'gpt-5.6-terra']);
  complete(); await until(() => !bot.busy);

  session.pendingMessage = { id: 'm', clientId: 'm', type: 'userMessage', pending: true, content: [], modelSwap: { id: 'q', status: 'pending' } };
  bot.save();
  const reopened = new Controller(bot.filename, bot.workspace, new Fake(), { cancel() {}, close() {} });
  const unsent = reopened.data.sessions.find(s => s.id === session.id).pendingMessage;
  assert.equal(unsent.modelSwap, undefined);
  assert.equal(unsent.error, 'The app closed during the model question. Send it again.', 'shown as Not sent, not as still routing');
  reopened.close();
});

test('settings saved before per-bot routers migrate: Jev routing, the global effort cap and the Escalation model', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-legacy-'));
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
  const file = path.join(directory, 'sessions.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: [],
    settings: { workspace: directory, mode: 'auto', access: 'workspace-write', routing: 'jev', effortCap: 'medium', escalationModel: 'codex:strong:high' } }));
  const loaded = new Controller(file, directory, new Fake(), { cancel() {}, close() {} });
  t.after(() => loaded.close());
  assert.deepEqual([loaded.routerKindSaved(), loaded.data.settings.effortCap, loaded.data.settings.dreamModel], ['jev', 'medium', 'codex:strong:high']);
  fs.writeFileSync(file, JSON.stringify({ version: 1, sessions: [], settings: { workspace: directory, mode: 'auto', access: 'workspace-write', effortCap: 'bogus', escalationModel: 'auto' } }));
  const fresh = new Controller(file, directory, new Fake(), { cancel() {}, close() {} });
  t.after(() => fresh.close());
  assert.deepEqual([fresh.routerKindSaved(), fresh.data.settings.effortCap, fresh.data.settings.dreamModel], ['secondary', 'high', undefined],
    'no Jev routing saved: the Secondary model; an unknown cap: the default; Escalation on Auto: no Dream model');
});

test('a bot still on legacy Auto with no router runs Hub’s model at its default effort, without routing', async t => {
  const { agents, bot, session, turns, complete, send } = await setup(t);
  agents.primary.catalog = () => catalog;
  agents.primary.available = () => true;
  agents.primary.data.settings.mode = 'codex:mid:high';
  delete bot.secondaryPick; // the real one: Off means no router
  for (const router of [{ router: 'off' }, { router: 'secondary', secondaryModel: 'off' }]) {
    Object.assign(bot.data.settings, { secondaryModel: undefined }, router);
    bot.smartRouter.choose = async () => assert.fail('no router is called');
    await send('Plain work');
    assert.deepEqual([session.routes.at(-1).model, session.routes.at(-1).effort], ['mid', 'medium'], JSON.stringify(router));
    complete(); await until(() => !bot.busy);
  }
  assert.deepEqual(turns(), ['weak', 'mid', 'mid']);
  // The Codex-connecting check and the send agree on that mode.
  assert.equal(bot.runMode('auto'), 'autoeffort:codex:mid');
  // A message saved with the retired Auto (queued before the upgrade) runs a bot's current model, not every model.
  bot.data.settings.mode = 'codex:strong:low';
  assert.equal(bot.runMode('auto'), 'codex:strong:low');
  assert.equal(agents.primary.runMode('auto'), 'codex:mid:high', 'Hub too');
});
