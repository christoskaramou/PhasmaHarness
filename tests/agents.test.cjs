const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Controller } = require('../src/controller.cjs');
const { Agents } = require('../src/agents.cjs');
const { MCP_TOOLS, claudeAllowedHelpers } = require('../src/tools/router-bridge.cjs');
const test = (name, run) => nodeTest(name, { timeout: 5000 }, run);

class Fake extends EventEmitter {
  constructor() { super(); this.calls = []; this.responses = []; }
  async start() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } };
    if (method === 'model/list') return { data: this.models || [{ model: 'gpt-5.6-terra', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || randomUUID() } };
    if (method === 'thread/items/list') return { data: [], nextCursor: null };
    if (method === 'turn/start') return { turn: { id: randomUUID() } };
    if (method === 'turn/interrupt') queueMicrotask(() => this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } } }));
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); }
  rejectRequest(id, reason) { this.responses.push({ id, error: reason }); }
  close() {}
}

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agents-'));
  const workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  const factory = (file, cwd, options) => {
    const c = new Controller(file, cwd, new Fake(), { cancel() {}, close() {}, async choose() { throw new Error('Unexpected model routing'); } }, options);
    c.claude.refresh = async () => c.claude.status;
    c.cursor.refresh = async () => c.cursor.status;
    return c;
  };
  const primary = factory(path.join(directory, 'sessions.json'), workspace);
  await primary.initialize(); primary.data.settings.mode = 'terra-light';
  const agents = new Agents(primary, async () => {}, factory);
  t.after(async () => {
    agents.closing = true; agents.pump();
    await Promise.all(agents.initializing.values());
    for (const c of agents.controllers.values()) c.close();
    fs.rmSync(directory, { force: true, recursive: true });
  });
  const add = async (name, cwd = workspace, access = 'workspace-write') => {
    const profile = await agents.saveAgent({ name, workspace: cwd, access, mode: 'terra-light', instructions: `Role: ${name}` });
    await agents.initializeController(agents.controller(profile.id));
    return agents.controller(profile.id);
  };
  return { agents, primary, workspace, directory, factory, add };
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(check(), 'Condition did not become true within one second');
}
function complete(c, s, text = 'Verified result.') {
  c.notification({ method: 'item/completed', params: { threadId: s.threadId, turnId: s.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text } } });
  c.notification({ method: 'turn/completed', params: { threadId: s.threadId, turn: { id: s.turnId, status: 'completed' } } });
}
const start = (c, s) => c.send({ id: s.id, text: 'Inspect this project', mode: 'terra-light', task: 'off' });

test('Main creates a persistent idle agent through a dynamic tool using conversation permissions', async t => {
  const { agents, primary, workspace } = await setup(t);
  primary.data.settings.access = 'danger-full-access';
  const source = primary.create(workspace, 'read-only');
  await start(primary, source);
  await primary.helperToolCall({ id: 78, params: { threadId: source.threadId, turnId: source.turnId, tool: 'agent_create', arguments: { name: 'Reviewer', instructions: 'Review the code.' } } });
  const output = primary.client.responses.find(r => r.id === 78);
  assert.equal(output.result.success, true);
  const profile = JSON.parse(output.result.contentItems[0].text);
  assert.equal(profile.name, 'Reviewer');
  assert.equal(profile.workspace, workspace);
  assert.equal(profile.access, 'read-only');
  assert.equal(profile.mode, 'auto');
  assert.ok(agents.snapshot().agents.some(agent => agent.id === profile.id));
  assert.ok(JSON.parse(fs.readFileSync(primary.filename)).agents.some(agent => agent.id === profile.id));
  const child = agents.controller(profile.id);
  await agents.initializeController(child);
  assert.equal(child.busy, null);
  assert.equal(child.client.calls.some(call => call.method === 'turn/start'), false);
  const task = agents.delegate(primary, source, profile.id, 'Review source.', true);
  assert.equal(child.session(task.sessionId).access, 'read-only');
  await agents.stop(task.sessionId);
  source.queuePaused = true;
  complete(primary, source);
});

test('named and delegated agents can create agents through every provider bridge', async t => {
  const { agents, add, directory } = await setup(t);
  const workspace = path.join(directory, 'other'); fs.mkdirSync(workspace);
  const parent = await add('Parent', workspace, 'danger-full-access');
  const session = parent.create(workspace, 'workspace-write');
  await start(parent, session);
  session.delegation = { delivered: false, state: 'running' };
  session.agentReplyActive = true;
  for (const provider of ['codex', 'claude-cli', 'cursor-cli']) {
    session.activeProvider = provider;
    const profile = await parent.bridgeTool(session.id, 'agent_create', { name: provider, instructions: 'Help with the task.', mode: 'auto' });
    assert.equal(profile.workspace, workspace);
    assert.equal(profile.access, 'workspace-write');
    assert.equal(profile.mode, 'auto');
    assert.equal(agents.controller(profile.id).busy, null);
  }
  delete session.delegation; delete session.agentReplyActive;
  session.activeProvider = 'codex';
  complete(parent, session);
});

test('agent creation rejects inactive calls, edits, permission overrides and invalid profiles', async t => {
  const { agents, primary, workspace } = await setup(t);
  const source = primary.create(workspace, 'read-only');
  const args = { name: 'Helper', instructions: 'Inspect files.' };
  await assert.rejects(primary.bridgeTool(source.id, 'agent_create', args), /no active turn/);
  await primary.helperToolCall({ id: 79, params: { threadId: 'inactive', turnId: 'no', tool: 'agent_create', arguments: args } });
  assert.match(primary.client.responses.find(r => r.id === 79).error, /inactive/);
  await start(primary, source);
  const profile = await primary.bridgeTool(source.id, 'agent_create', args);
  for (const override of [{ id: profile.id }, { workspace }, { access: 'danger-full-access' }, { task: 'Start automatically' }]) {
    await assert.rejects(primary.bridgeTool(source.id, 'agent_create', { ...args, ...override }), /Invalid/);
  }
  for (const invalid of [{ name: '' }, { name: 'Main' }, { name: 'Helper' }, { instructions: null }, { mode: 'missing-model' }, { mode: null }]) {
    await assert.rejects(primary.bridgeTool(source.id, 'agent_create', { ...args, name: 'New helper', ...invalid }));
  }
  const save = primary.save;
  primary.save = () => { throw new Error('Disk full'); };
  await assert.rejects(primary.bridgeTool(source.id, 'agent_create', { ...args, name: 'Unsaved' }), /Disk full/);
  primary.save = save;
  assert.equal(agents.primary.data.agents.length, 1);
  primary.stopping.add(source.id);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_create', args), /no active turn/);
  primary.stopping.delete(source.id);
  agents.closing = true;
  await assert.rejects(primary.bridgeTool(source.id, 'agent_create', args), /closing/);
  agents.closing = false;
  complete(primary, source);
});

test('agents discover available models and create children with default or requested efforts across provider bridges', async t => {
  const { agents, primary, workspace, add } = await setup(t);
  primary.models[0].supportedReasoningEfforts = ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort }));
  agents.configure = async controller => { controller.client.models = primary.models; };
  primary.data.settings.claudeEnabled = true;
  primary.claude.status = { loggedIn: true };
  primary.claude.models = [{ id: 'claude-cli:review-model', provider: 'claude-cli', model: 'review-model', label: 'Review', worker: true, rank: 35, efforts: ['low', 'medium', 'high'] }];
  primary.data.settings.cursorEnabled = true;
  primary.cursor.status = { loggedIn: true };
  primary.cursor.models = [{ id: 'review-model', parameterized: true, efforts: ['low', 'medium', 'high'] }];
  primary.data.settings.providerModels = [
    { id: 'cursor-cli:review-model:default', provider: 'cursor-cli', model: 'review-model', label: 'Review', worker: true, enabled: true, rank: 40, cursorEffort: 'low' },
    { id: 'cursor-cli:plain:default', provider: 'cursor-cli', model: 'plain', effort: null, worker: true, enabled: true, rank: 45 },
    { id: 'cursor-cli:disabled:default', provider: 'cursor-cli', model: 'disabled', worker: true, enabled: false, rank: 50 },
  ];
  const parent = await add('Parent');
  const expected = [
    { mode: 'auto', model: 'Auto', efforts: [] },
    { mode: 'codex:gpt-5.6-terra:medium', provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium', efforts: ['low', 'medium', 'high'] },
    { mode: 'claude-cli:review-model:medium', provider: 'claude-cli', model: 'review-model', effort: 'medium', efforts: ['low', 'medium', 'high'] },
    { mode: 'cursor-cli:review-model:low', provider: 'cursor-cli', model: 'review-model', effort: 'low', efforts: ['low', 'medium', 'high'] },
    { mode: 'cursor-cli:plain:default', provider: 'cursor-cli', model: 'plain', effort: 'default', efforts: ['default'] },
  ];
  let codexChild;
  for (const creator of [primary, parent]) {
    const source = creator.create(workspace, 'read-only');
    await start(creator, source);
    for (const provider of ['codex', 'claude-cli', 'cursor-cli']) {
      source.activeProvider = provider;
      const choices = await creator.bridgeTool(source.id, 'agent_models', {});
      assert.deepEqual(choices, expected);
      const choice = choices.find(p => p.provider === provider);
      for (const effort of [undefined, 'high']) {
        const profile = await creator.bridgeTool(source.id, 'agent_create', { name: `${creator.agentId} ${provider} ${effort || 'default'}`, instructions: 'Help.', mode: choice.mode, ...(effort ? { effort } : {}) });
        const selected = primary.resolveWorker(profile.mode);
        assert.equal(selected.provider, provider);
        assert.equal(selected.model, choice.model);
        assert.equal(selected.effort, effort || choice.effort);
        assert.equal(profile.access, 'read-only');
        assert.equal(agents.controller(profile.id).data.settings.mode, profile.mode);
        assert.equal(JSON.parse(fs.readFileSync(primary.filename)).agents.find(a => a.id === profile.id).mode, profile.mode);
        if (provider === 'codex' && effort) codexChild = profile;
      }
    }
    const plain = await creator.bridgeTool(source.id, 'agent_create', { name: `${creator.agentId} plain`, instructions: '', mode: 'cursor-cli:plain:default', effort: 'default' });
    assert.equal(plain.mode, 'cursor-cli:plain:default');
    assert.equal(creator.data.settings.mode, 'terra-light', 'creation leaves the parent model unchanged');
    source.activeProvider = 'codex';
    complete(creator, source);
  }
  const child = agents.controller(codexChild.id);
  await agents.initializeController(child);
  const chat = agents.conversation(child, true);
  await child.send({ id: chat.id, text: 'Inspect source.', mode: child.data.settings.mode, task: 'off' });
  const turn = child.client.calls.findLast(call => call.method === 'turn/start');
  assert.equal(turn.params.model, 'gpt-5.6-terra');
  assert.equal(turn.params.effort, 'high');
  complete(child, chat);
});

test('agent model requests fail without creating profiles when unavailable, malformed or unsupported', async t => {
  const { agents, primary } = await setup(t);
  const source = primary.create();
  await assert.rejects(primary.bridgeTool(source.id, 'agent_models', {}), /no active turn/);
  await start(primary, source);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_models', { extra: true }), /Invalid/);
  const disk = fs.readFileSync(primary.filename, 'utf8');
  for (const selection of [{ mode: 'missing' }, { mode: null }, { mode: 1 }, { mode: {} }, { effort: 'high' }, { mode: 'auto', effort: 'low' }, ...['high', '', null, 1, {}].map(effort => ({ mode: 'terra-light', effort }))]) {
    await assert.rejects(primary.bridgeTool(source.id, 'agent_create', { name: 'Invalid', instructions: '', ...selection }));
  }
  assert.equal(agents.primary.data.agents.length, 0);
  assert.equal(fs.readFileSync(primary.filename, 'utf8'), disk);
  primary.data.settings.disabledCodexModels = ['gpt-5.6-terra'];
  assert.deepEqual(await primary.bridgeTool(source.id, 'agent_models', {}), [{ mode: 'auto', model: 'Auto', efforts: [] }]);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_create', { name: 'Disabled', instructions: '', mode: 'terra-light' }), /unavailable/);
  primary.data.settings.disabledCodexModels = [];
  primary.account = null;
  await assert.rejects(primary.bridgeTool(source.id, 'agent_create', { name: 'Disconnected', instructions: '', mode: 'terra-light' }), /unavailable/);
  assert.equal(agents.primary.data.agents.length, 0);
  complete(primary, source);
});

test('new and existing Codex chats expose agent tools through a session-bound MCP bridge', async t => {
  const { primary } = await setup(t);
  const source = primary.create();
  await start(primary, source);
  const started = primary.client.calls.find(call => call.method === 'thread/start');
  assert.equal(started.params.config['features.multi_agent'], false, 'untracked agent chats must not expose provider-native subagents');
  assert.match(started.params.developerInstructions, /MUST call agent_create and confirm its returned id/);
  const server = started.params.config['mcp_servers.phasma_harness'];
  assert.deepEqual(server.enabled_tools, ['agents_list', 'agent_models', 'agent_create', 'agent_delegate', 'agent_read_context', 'agent_stop', 'agent_delete', 'agent_set_access']);
  assert.equal(server.env.PHASMA_SESSION_ID, source.id);
  assert.equal(server.env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(MCP_TOOLS.some(tool => tool.name === 'agent_create'));
  assert.ok(claudeAllowedHelpers('read-only').includes('mcp__phasma_harness__agent_create'));
  assert.ok(claudeAllowedHelpers('read-only').includes('mcp__phasma_harness__agent_read_context'));
  assert.ok(MCP_TOOLS.some(tool => tool.name === 'agent_read_context'));
  assert.equal(server.tools.agent_read_context.approval_mode, 'approve');
  for (const name of ['agent_models', 'agent_stop', 'agent_delete', 'agent_set_access']) {
    assert.ok(MCP_TOOLS.some(tool => tool.name === name));
    assert.ok(claudeAllowedHelpers('read-only').includes('mcp__phasma_harness__' + name));
    assert.equal(server.tools[name].approval_mode, 'approve');
  }
  complete(primary, source);
  const threadId = source.threadId;
  source.helperTools = false;
  primary.loaded.delete(source.id);
  await start(primary, source);
  const resumed = primary.client.calls.findLast(call => call.method === 'thread/resume');
  assert.equal(resumed.params.threadId, threadId);
  assert.equal(resumed.params.config['features.multi_agent'], false, 'resumed agent chats must keep provider-native subagents disabled');
  assert.deepEqual(resumed.params.config['mcp_servers.phasma_harness'], server);
  assert.equal(primary.client.calls.filter(call => call.method === 'thread/start').length, 1);
  const injection = primary.client.calls.findLast(call => call.method === 'thread/inject_items');
  assert.equal(injection.params.threadId, threadId);
  assert.equal(injection.params.items[0].role, 'developer');
  assert.match(injection.params.items[0].content[0].text, /MUST call agent_create and confirm its returned id/);
  assert.equal(server.tools.agent_create.approval_mode, 'approve');
  const response = await fetch(`${server.env.PHASMA_BRIDGE_URL}/v1/call`, {
    method: 'POST', headers: { Authorization: `Bearer ${server.env.PHASMA_BRIDGE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: source.id, tool: 'agent_create', arguments: { name: 'From existing chat', instructions: 'Review files.' } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.name, 'From existing chat');
  await assert.rejects(primary.bridgeTool(source.id, 'router_call_tool', {}), /Only agent tools/);
  complete(primary, source);
});

test('saving an agent returns while startup is pending and reuses provider discovery', async t => {
  const { agents, primary, workspace, factory } = await setup(t);
  let release;
  agents.configure = () => new Promise(resolve => { release = resolve; });
  agents.createController = (...args) => {
    const worker = factory(...args);
    worker.claude.refresh = worker.cursor.refresh = async () => { throw new Error('Repeated provider discovery'); };
    return worker;
  };
  let profile;
  try {
    const saving = agents.saveAgent({ name: 'Fast save', workspace, mode: 'terra-light', access: 'read-only', instructions: 'Review source.' });
    saving.then(value => { profile = value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(profile, 'Saving must not wait for provider startup');
    assert.equal(agents.snapshot().agentStates[profile.id].connection, 'connecting');
    assert.equal(agents.controller(profile.id).client.calls.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(primary.filename)).agents[0].id, profile.id);
  } finally { release(); }
  const worker = agents.controller(profile.id);
  await agents.initializeController(worker);
  assert.equal(worker.connection, 'ready');
  assert.deepEqual(worker.claude.status, primary.claude.status);
  assert.deepEqual(worker.cursor.models, primary.cursor.models);
});

test('background startup errors stay visible on the saved agent', async t => {
  const { agents, workspace } = await setup(t);
  agents.configure = async () => { throw new Error('Port unavailable'); };
  const profile = await agents.saveAgent({ name: 'Offline', workspace, mode: 'auto', access: 'read-only', instructions: '' });
  await agents.initializeController(agents.controller(profile.id));
  const snapshot = agents.snapshot().agentStates[profile.id];
  assert.equal(snapshot.connection, 'disconnected');
  assert.match(snapshot.error, /Agent startup failed: Port unavailable/);
  assert.ok(agents.profile(profile.id));
});

test('quitting during configuration does not start an agent afterward', async t => {
  const { agents, workspace } = await setup(t);
  let release, closed = 0;
  agents.configure = worker => { worker.providers = { close() { closed++; } }; return new Promise(resolve => { release = resolve; }); };
  const profile = await agents.saveAgent({ name: 'Starting', workspace, mode: 'auto', access: 'read-only', instructions: '' });
  const worker = agents.controller(profile.id);
  agents.closing = true; release();
  await agents.initializeController(worker);
  assert.equal(worker.client.calls.length, 0);
  assert.equal(closed, 1);
});

test('agents preserve separate profiles, sessions and instructions across restart', async t => {
  const { agents, primary, add, factory, workspace } = await setup(t);
  const worker = await add('Reviewer');
  const session = worker.create();
  assert.equal(primary.data.sessions.length, 0);
  assert.match(worker.workerInstructions(session), /Role: Reviewer/);
  assert.equal(agents.owner(session.id), worker);
  assert.equal(agents.snapshot().agentStates[worker.agentId].sessions[0].id, session.id);
  worker.save(); primary.save();
  const restoredRoot = factory(primary.filename, workspace);
  const restored = new Agents(restoredRoot, async () => {}, factory);
  assert.equal(restored.profile(worker.agentId).name, 'Reviewer');
  assert.equal(restored.owner(session.id).session(session.id).id, session.id);
  assert.equal(restored.controller(worker.agentId).limits.store, restoredRoot.limits.store);
  for (const c of restored.controllers.values()) c.close();
});

test('clear requires confirmation, archives history and starts fresh context for Main and named agents', async t => {
  const { agents, primary, add, factory, workspace } = await setup(t);
  const worker = await add('Reviewer');
  for (const controller of [primary, worker]) {
    const old = agents.conversation(controller, true, workspace, 'read-only');
    old.threadId = 'old-codex'; old.claudeSessionId = 'old-claude'; old.cursorSessionId = 'old-cursor';
    old.items.push({ id: 'history', type: 'agentMessage', text: 'OLD_CONTEXT_MUST_NOT_BE_SENT' });
    old.usage = { total: { inputTokens: 90000 } }; controller.save();
    controller.loaded.add(old.id); controller.sessionAllows.set(old.id, new Set(['old-approval']));
    const before = fs.readFileSync(controller.filename, 'utf8');
    assert.equal(await agents.clearConversation(controller.agentId, () => false), null);
    assert.equal(fs.readFileSync(controller.filename, 'utf8'), before);
    const fresh = await agents.clearConversation(controller.agentId, name => { assert.equal(name, controller === primary ? 'Main' : 'Reviewer'); return true; });
    assert.notEqual(fresh.id, old.id);
    assert.equal(fresh.workspace, workspace); assert.equal(fresh.access, 'read-only');
    assert.deepEqual(fresh.items, []); assert.equal(fresh.usage, null);
    assert.equal(fresh.threadId, null); assert.equal(fresh.claudeSessionId, undefined); assert.equal(fresh.cursorSessionId, undefined);
    assert.equal(controller.data.sessions.find(s => s.id === old.id).archived, true);
    assert.equal(controller.data.sessions.find(s => s.id === old.id).items[0].text, 'OLD_CONTEXT_MUST_NOT_BE_SENT');
    assert.equal(controller.loaded.has(old.id), false); assert.equal(controller.sessionAllows.has(old.id), false);
    assert.equal(agents.conversation(controller).id, fresh.id);
    await start(controller, fresh);
    assert.ok(controller.client.calls.some(call => call.method === 'thread/start'));
    assert.notEqual(fresh.threadId, 'old-codex');
    assert.doesNotMatch(JSON.stringify(controller.client.calls), /OLD_CONTEXT_MUST_NOT_BE_SENT/);
    complete(controller, fresh);
  }
  const restoredRoot = factory(primary.filename, workspace), restored = new Agents(restoredRoot, async () => {}, factory);
  assert.equal(restored.primary.data.agents.length, 1, 'archived history does not become extra sidebar agents');
  assert.equal(restored.conversation(restored.primary).id, agents.conversation(primary).id);
  assert.equal(restored.profile(worker.agentId).instructions, 'Role: Reviewer');
  for (const controller of restored.controllers.values()) controller.close();
});

test('clear rejects pending work, rechecks after confirmation and rolls back a failed save', async t => {
  const { agents, primary, add } = await setup(t);
  const old = agents.conversation(primary, true);
  old.items.push({ id: 'history', type: 'agentMessage', text: 'Keep this history.' }); primary.save();
  let confirmations = 0;
  const confirm = () => { confirmations++; return true; };
  primary.busy = old.id;
  await assert.rejects(agents.clearConversation('main', confirm), /pending work/);
  primary.busy = null; old.queue = [{ id: 'queued', text: 'Keep pending input.' }];
  await assert.rejects(agents.clearConversation('main', confirm), /queued/);
  old.queue = [];
  const child = await add('Child'), task = agents.conversation(child, true);
  task.delegation = { source: old.id, state: 'queued', delivered: false }; child.connection = 'disconnected';
  await assert.rejects(agents.clearConversation('main', confirm), /delegated tasks/);
  delete task.delegation;
  assert.equal(confirmations, 0);
  let answer;
  const clearing = agents.clearConversation('main', () => new Promise(resolve => { answer = resolve; }));
  primary.busy = old.id; answer(true);
  await assert.rejects(clearing, /pending work/); primary.busy = null;
  const previous = primary.data.sessions, before = fs.readFileSync(primary.filename, 'utf8'), save = primary.save;
  primary.save = () => { throw new Error('Disk full'); };
  await assert.rejects(agents.clearConversation('main', confirm), /Disk full/); primary.save = save;
  assert.equal(primary.data.sessions, previous); assert.equal(primary.data.agentSessionId, old.id);
  assert.equal(fs.readFileSync(primary.filename, 'utf8'), before); assert.equal(old.archived, false);
});

test('one conversation is retained per agent and old chats migrate once without losing IDs or history', async t => {
  const { agents, primary, factory, workspace } = await setup(t);
  const kept = agents.conversation(primary, true, workspace, 'read-only');
  assert.equal(agents.conversation(primary, true).id, kept.id);
  const old = primary.create(); old.title = 'Earlier investigation'; old.items.push({ id: 'evidence', type: 'agentMessage', text: 'Keep this evidence.' }); primary.save();
  const restored = factory(primary.filename, workspace);
  const migrated = new Agents(restored, async () => {}, factory);
  t.after(() => { migrated.closing = true; for (const c of migrated.controllers.values()) c.close(); });
  assert.equal(migrated.conversation(restored).id, kept.id);
  assert.equal(restored.data.agents.length, 1);
  const moved = migrated.controller(restored.data.agents[0].id);
  assert.equal(migrated.conversation(moved).id, old.id);
  assert.equal(moved.session(old.id).items[0].text, 'Keep this evidence.');
  assert.equal(restored.data.sessions.length, 1);
  restored.data.sessions.push(old); restored.save(); // Reproduce a crash before removing the source copy.
  migrated.migrateConversations();
  assert.equal(restored.data.agents.length, 1);
  assert.equal(restored.data.sessions.length, 1);
  assert.equal(migrated.snapshot().agents[0].name, 'Main');
});

test('agent deletion protects Main and pending work, persists removal, and keeps recovery files', async t => {
  const { agents, primary, add } = await setup(t);
  const worker = await add('Delete me');
  const chat = agents.conversation(worker, true);
  await assert.rejects(agents.deleteAgent('main'), /cannot be deleted/);
  await assert.rejects(agents.deleteAgent(), /Unknown agent/);
  worker.busy = chat.id;
  await assert.rejects(agents.deleteAgent(worker.agentId), /Stop this agent/);
  worker.busy = null;
  chat.delegation = { source: 'source', state: 'queued', delivered: false };
  await assert.rejects(agents.deleteAgent(worker.agentId), /delegated tasks/);
  delete chat.delegation;
  const save = primary.save.bind(primary); primary.save = () => { throw new Error('Disk full'); };
  await assert.rejects(agents.deleteAgent(worker.agentId), /Disk full/);
  assert.ok(agents.profile(worker.agentId)); assert.equal(agents.controller(worker.agentId), worker);
  primary.save = save;
  await agents.deleteAgent(worker.agentId);
  assert.throws(() => agents.controller(worker.agentId), /Unknown agent/);
  assert.equal(JSON.parse(fs.readFileSync(primary.filename)).agents.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(worker.filename)).sessions[0].id, chat.id);
});

test('all provider bridges can change another agent access, stop it and delete its profile', async t => {
  const { agents, primary, workspace, add } = await setup(t);
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  for (const provider of ['codex', 'claude-cli', 'cursor-cli']) {
    source.activeProvider = provider;
    const worker = await add(provider, workspace, 'read-only'), chat = agents.conversation(worker, true);
    chat.items.push({ id: 'kept', type: 'agentMessage', text: 'Conversation retained for recovery.' }); worker.save();
    worker.loaded.add(chat.id); worker.sessionAllows.set(chat.id, new Set(['old-approval']));
    const updated = await primary.bridgeTool(source.id, 'agent_set_access', { agentId: worker.agentId, access: 'workspace-write' });
    assert.deepEqual(updated, { agentId: worker.agentId, name: provider, access: 'workspace-write', status: 'updated' });
    assert.equal(agents.profile(worker.agentId).access, 'workspace-write');
    assert.equal(chat.access, 'workspace-write');
    assert.equal(worker.data.settings.access, 'workspace-write');
    assert.equal(worker.loaded.has(chat.id), false);
    assert.equal(worker.sessionAllows.has(chat.id), false);
    assert.equal(JSON.parse(fs.readFileSync(primary.filename)).agents.find(a => a.id === worker.agentId).access, 'workspace-write');
    assert.equal(JSON.parse(fs.readFileSync(worker.filename)).sessions.find(s => s.id === chat.id).access, 'workspace-write');
    const stopped = await primary.bridgeTool(source.id, 'agent_stop', { agentId: worker.agentId });
    assert.equal(stopped.status, 'stopped');
    assert.equal(chat.queuePaused, true);
    const removed = await primary.bridgeTool(source.id, 'agent_delete', { agentId: worker.agentId });
    assert.deepEqual(removed, { agentId: worker.agentId, name: provider, status: 'deleted', conversationsRetained: true });
    assert.equal(agents.profile(worker.agentId), undefined);
    assert.equal(JSON.parse(fs.readFileSync(worker.filename)).sessions[0].items[0].text, 'Conversation retained for recovery.');
    assert.equal(removed.sessions, undefined, 'management does not expose other agents transcripts');
  }
  source.activeProvider = 'codex'; complete(primary, source);
});

test('named agents can stop Main and change its access but cannot delete Main', async t => {
  const { agents, primary, add, directory } = await setup(t);
  const other = path.join(directory, 'manager-workspace'); fs.mkdirSync(other);
  const manager = await add('Manager', other), source = agents.conversation(manager, true);
  const main = agents.conversation(primary, true);
  await start(primary, main); await start(manager, source);
  const stopped = await manager.bridgeTool(source.id, 'agent_stop', { agentId: 'main' });
  assert.ok(['stopped', 'stopping'].includes(stopped.status));
  await until(() => !primary.busy);
  assert.equal(main.queuePaused, true);
  assert.ok(primary.client.calls.some(call => call.method === 'turn/interrupt' && call.params.threadId === main.threadId));
  await assert.rejects(manager.bridgeTool(source.id, 'agent_delete', { agentId: 'main' }), /Main.*cannot be deleted/);
  await assert.rejects(manager.bridgeTool(source.id, 'agent_set_access', { agentId: 'main', access: 'read-only' }), /different workspace/);
  complete(manager, source);
  manager.permissions(source.id, 'danger-full-access');
  await start(manager, source);
  const changed = await manager.bridgeTool(source.id, 'agent_set_access', { agentId: 'main', access: 'read-only' });
  assert.equal(changed.name, 'Main'); assert.equal(main.access, 'read-only');
  assert.equal(primary.data.settings.access, 'read-only');
  assert.equal(JSON.parse(fs.readFileSync(primary.filename)).settings.access, 'read-only');
  complete(manager, source);
});

test('management rejects escalation, self-targeting, inactive calls and pending work', async t => {
  const { agents, primary, workspace, add } = await setup(t);
  const worker = await add('Target'), chat = agents.conversation(worker, true);
  const source = primary.create(workspace, 'read-only');
  primary.data.settings.access = 'danger-full-access';
  for (const name of ['agent_stop', 'agent_delete', 'agent_set_access']) {
    await assert.rejects(primary.bridgeTool(source.id, name, { agentId: worker.agentId, ...(name === 'agent_set_access' ? { access: 'read-only' } : {}) }), /no active turn/);
  }
  await start(primary, source);
  for (const access of ['workspace-write', 'danger-full-access']) {
    await assert.rejects(primary.bridgeTool(source.id, 'agent_set_access', { agentId: worker.agentId, access }), /Cannot grant more access/);
  }
  for (const name of ['agent_stop', 'agent_delete', 'agent_set_access']) {
    const args = { agentId: worker.agentId, ...(name === 'agent_set_access' ? { access: 'read-only' } : {}) };
    for (const invalid of [{ ...args, agentId: 'main' }, { ...args, agentId: '../sessions.json' }, { ...args, agentId: '' }, { ...args, workspace }, {}]) await assert.rejects(primary.bridgeTool(source.id, name, invalid));
  }
  await assert.rejects(primary.bridgeTool(source.id, 'agent_set_access', { agentId: worker.agentId, access: 'admin' }), /Unknown access/);
  chat.queue = [{ id: 'pending', text: 'Keep this task.' }]; chat.queuePaused = true;
  await assert.rejects(primary.bridgeTool(source.id, 'agent_delete', { agentId: worker.agentId }), /queued/);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_set_access', { agentId: worker.agentId, access: 'read-only' }), /pending work/);
  chat.queue = []; worker.busy = chat.id;
  await assert.rejects(primary.bridgeTool(source.id, 'agent_delete', { agentId: worker.agentId }), /pending work/);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_set_access', { agentId: worker.agentId, access: 'read-only' }), /pending work/);
  worker.busy = null;
  assert.equal(chat.access, 'workspace-write');
  let release;
  agents.initializing.set(worker, new Promise(resolve => { release = resolve; }));
  const deleting = primary.bridgeTool(source.id, 'agent_delete', { agentId: worker.agentId });
  complete(primary, source); release();
  await assert.rejects(deleting, /active turn/);
  assert.ok(agents.profile(worker.agentId), 'a request that ended while awaiting startup cannot delete later');
});

test('children and grandchildren inherit current conversation access at every level', async t => {
  const { agents, primary, workspace } = await setup(t);
  const source = primary.create(workspace, 'read-only');
  for (const access of ['read-only', 'workspace-write', 'danger-full-access']) {
    primary.permissions(source.id, access);
    primary.data.settings.access = access === 'danger-full-access' ? 'read-only' : 'danger-full-access';
    await start(primary, source);
    const profile = await primary.bridgeTool(source.id, 'agent_create', { name: 'Child ' + access, instructions: 'Help with the current task.' });
    assert.equal(profile.access, access);
    complete(primary, source);
    const child = agents.controller(profile.id);
    await agents.initializeController(child);
    const chat = agents.conversation(child, true);
    assert.equal(chat.access, access);
    await start(child, chat);
    const grandchild = await child.bridgeTool(chat.id, 'agent_create', { name: 'Grandchild ' + access, instructions: 'Help the child.' });
    assert.equal(grandchild.access, access);
    assert.equal(grandchild.workspace, workspace);
    assert.equal(agents.controller(grandchild.id).busy, null);
    complete(child, chat);
  }
});

test('successive delegated tasks reuse the conversation and deliver only their own results once', async t => {
  const { agents, primary, add } = await setup(t);
  const worker = await add('Researcher');
  const source = agents.conversation(primary, true); source.queuePaused = true;
  const chat = agents.conversation(worker, true);
  worker.permissions(chat.id, 'read-only');
  chat.items.push({ id: 'private', type: 'agentMessage', phase: 'final_answer', text: 'Old unrelated answer' });
  const run = async answer => {
    const job = agents.delegate(primary, source, worker.agentId, 'Inspect source');
    assert.equal(job.sessionId, chat.id);
    assert.equal(chat.access, 'read-only', 'Delegation cannot raise the persistent conversation permissions');
    await until(() => !!chat.turnId);
    assert.throws(() => agents.delegate(primary, source, worker.agentId, 'More work'), /work pending/);
    complete(worker, chat, answer); await worker.gateDone; agents.pump();
    await until(() => chat.delegation.delivered);
  };
  await run('First answer');
  await run('Second answer');
  assert.equal(worker.data.sessions.length, 1);
  assert.equal(source.queue.length, 2);
  assert.notEqual(source.queue[0].id, source.queue[1].id);
  assert.doesNotMatch(source.queue[0].text, /Old unrelated/);
  assert.doesNotMatch(source.queue[1].text, /Old unrelated|First answer/);
  assert.match(source.queue[1].text, /Second answer/);
  agents.pump(); assert.equal(source.queue.length, 2);
});

test('three workers run concurrently; the fourth waits and starts when a slot is free', async t => {
  const { agents, primary, add, directory } = await setup(t);
  const workers = [primary];
  for (let i = 0; i < 3; i++) { const cwd = path.join(directory, `project-${i}`); fs.mkdirSync(cwd); workers.push(await add(`Agent ${i}`, cwd)); }
  const sessions = workers.map(c => c.create());
  await Promise.all(workers.slice(0, 3).map((c, i) => start(c, sessions[i])));
  assert.equal(agents.leases.size, 3);
  const fourth = start(workers[3], sessions[3]);
  await until(() => !!sessions[3].waitingForAgent);
  assert.equal(workers[3].client.calls.filter(c => c.method === 'turn/start').length, 0);
  complete(workers[1], sessions[1]); agents.pump();
  await fourth;
  assert.ok(sessions[3].turnId);
  await agents.stop(sessions[2].id);
  await until(() => !workers[2].busy);
  assert.ok(primary.busy, 'Stopping one agent leaves the other agents running');
  complete(primary, sessions[0]); complete(workers[3], sessions[3]);
});

test('overlapping workspaces serialize turns; a stopped waiter never starts', async t => {
  const { agents, primary, add, workspace } = await setup(t);
  const nested = path.join(workspace, 'nested'); fs.mkdirSync(nested);
  const worker = await add('Nested', nested);
  const source = primary.create(), target = worker.create();
  await start(primary, source);
  const waiting = start(worker, target);
  const rejected = assert.rejects(waiting, /stopped/);
  await until(() => !!target.waitingForAgent);
  await agents.stop(target.id); await rejected;
  assert.equal(worker.client.calls.filter(c => c.method === 'turn/start').length, 0);
  assert.ok(primary.busy);
  complete(primary, source);
});

test('Full access holds an exclusive slot even for a different workspace', async t => {
  const { agents, primary, add, directory } = await setup(t);
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  const worker = await add('Other', other);
  const source = primary.create(undefined, 'danger-full-access'), target = worker.create();
  await start(primary, source);
  const waiting = start(worker, target);
  assert.ok(target.waitingForAgent);
  complete(primary, source); agents.pump(); await waiting;
  complete(worker, target);
});

test('delegation inherits lower permissions and returns once across automatic follow-up requests', async t => {
  const { agents, primary, add } = await setup(t);
  const worker = await add('Researcher');
  const source = primary.create(undefined, 'read-only');
  await start(primary, source);
  const turn = source.turnId;
  await primary.helperToolCall({ id: 77, params: { threadId: source.threadId, turnId: turn, tool: 'agent_delegate', arguments: { agentId: worker.agentId, task: 'Find the relevant files.' } } });
  const output = primary.client.responses.find(r => r.id === 77);
  assert.equal(output.result.success, true);
  const { sessionId } = JSON.parse(output.result.contentItems[0].text);
  const child = worker.session(sessionId);
  assert.equal(child.access, 'read-only');
  assert.throws(() => agents.tool(worker, child, 'agent_delegate', { agentId: worker.agentId, task: 'recurse' }), /another|cannot delegate/);
  complete(primary, source); agents.pump();
  await until(() => !!child.turnId);
  complete(worker, child, 'The implementation is in src/example.cjs.');
  await worker.gateDone; agents.pump();
  await until(() => !!source.agentReplyActive && !!source.turnId);
  const replies = primary.client.calls.filter(c => c.method === 'turn/start' && c.params.input[0].text.includes('src/example.cjs'));
  assert.equal(replies.length, 1);
  agents.pump(); assert.equal(source.agentDeliveries.filter(id => id === child.delegation.id).length, 1);
  const followup = agents.tool(primary, source, 'agent_delegate', { agentId: worker.agentId, task: 'Verify the result with this pasted text:\n  const value = 42;\n' });
  assert.equal(followup.sessionId, child.id);
  assert.equal(source.agentDelegations, 2, 'automatic result continuations retain the task request count');
  complete(primary, source);
  await until(() => !!child.turnId);
  source.queuePaused = true;
  complete(worker, child);
});

test('every provider can send pasted text to Main and receive its result', async t => {
  const { agents, primary, add } = await setup(t);
  const requester = await add('Requester', undefined, 'read-only'), source = agents.conversation(requester, true);
  const pasted = 'Review this exact text:\n\n  const value = "<tag>";\n\tkeepIndent();\n';
  for (const provider of ['codex', 'claude-cli', 'cursor-cli']) {
    await start(requester, source);
    source.activeProvider = provider;
    const result = await requester.bridgeTool(source.id, 'agent_delegate', { agentId: 'main', task: pasted });
    assert.equal(result.agent, 'Main');
    const target = primary.session(result.sessionId);
    assert.ok(target.delegation.task.endsWith(pasted), 'pasted whitespace and content are preserved');
    assert.match(target.delegation.task, /Task from agent "Requester"/);
    assert.equal(target.access, 'read-only', 'Main keeps the lower permission level');
    source.activeProvider = 'codex';
    complete(requester, source); source.queuePaused = true;
    await until(() => !!target.turnId);
    complete(primary, target, `Reviewed pasted text for ${provider}.`);
    await primary.gateDone; agents.pump();
    assert.match(source.queue[0].text, /Result from agent "Main"/);
    assert.ok(source.queue[0].text.includes(provider));
    await requester.queuedMessage(source.id, source.queue[0].id, 'remove');
  }
});

test('nested requests wait for child results, reject cycles and return the completed result once', async t => {
  const { agents, primary, add } = await setup(t);
  const requester = await add('Requester'), helper = await add('Helper');
  const source = agents.conversation(requester, true);
  await start(requester, source);
  const mainJob = await requester.bridgeTool(source.id, 'agent_delegate', { agentId: 'main', task: 'Check the pasted evidence with Helper.' });
  complete(requester, source);
  const main = primary.session(mainJob.sessionId);
  await until(() => !!main.turnId);
  const helperJob = await primary.bridgeTool(main.id, 'agent_delegate', { agentId: helper.agentId, task: 'Verify this quoted evidence.' });
  complete(primary, main, 'Asked Helper to verify it.');
  const child = helper.session(helperJob.sessionId);
  await until(() => !!child.turnId);
  assert.equal(main.delegation.delivered, false, 'Main must wait before returning the final result');
  assert.equal(source.queue?.length || 0, 0);
  assert.ok(agents.snapshot().agentStates.main.waitingForAgents.includes(main.id));
  await assert.rejects(helper.bridgeTool(child.id, 'agent_delegate', { agentId: requester.agentId, task: 'Create a cycle' }), /Circular/);
  await assert.rejects(helper.bridgeTool(child.id, 'agent_delegate', { agentId: 'main', task: 'Create a cycle' }), /Circular/);
  await assert.rejects(helper.bridgeTool(child.id, 'agent_delegate', { agentId: helper.agentId, task: 'Self request' }), /another agent/);
  complete(helper, child, 'Verified helper evidence.');
  await until(() => main.agentReplyActive && !!main.turnId);
  assert.equal(main.delegation.delivered, false);
  complete(primary, main, 'Final result incorporating verified helper evidence.');
  await until(() => source.agentReplyActive && !!source.turnId);
  const replies = requester.client.calls.filter(call => call.method === 'turn/start' && call.params.input[0].text.includes('Final result incorporating'));
  assert.equal(replies.length, 1);
  assert.equal(source.agentDeliveries.filter(id => id === main.delegation.id).length, 1);
  source.agentDelegations = 3;
  await assert.rejects(requester.bridgeTool(source.id, 'agent_delegate', { agentId: 'main', task: 'Over budget' }), /already sent three/);
  complete(requester, source);
});

test('stopping a requester cancels its nested tasks without restarting conversations', async t => {
  const { agents, primary, add } = await setup(t);
  const requester = await add('Requester'), helper = await add('Helper');
  const source = agents.conversation(requester, true);
  await start(requester, source);
  const mainJob = await requester.bridgeTool(source.id, 'agent_delegate', { agentId: 'main', task: 'Ask Helper for evidence.' });
  complete(requester, source);
  const main = primary.session(mainJob.sessionId);
  await until(() => !!main.turnId);
  helper.connection = 'disconnected';
  const helperJob = await primary.bridgeTool(main.id, 'agent_delegate', { agentId: helper.agentId, task: 'Inspect evidence.' });
  complete(primary, main);
  const child = helper.session(helperJob.sessionId);
  assert.equal(child.delegation.state, 'queued');
  await agents.stop(source.id);
  await until(() => main.delegation.delivered);
  assert.equal(main.delegation.delivered, true);
  assert.equal(child.delegation.delivered, true);
  assert.equal(main.status, 'interrupted');
  assert.equal(child.status, 'interrupted');
  assert.equal(agents.pendingDelegations(source.id), false);
  for (const [controller, session] of [[requester, source], [primary, main], [helper, child]]) {
    assert.equal(controller.busy, null);
    assert.equal(session.queuePaused, true);
  }
});

test('inactive tools, broader workspaces and shared setting changes are rejected', async t => {
  const { agents, primary, add, directory } = await setup(t);
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  const worker = await add('Other', other);
  const source = primary.create();
  await primary.helperToolCall({ id: 1, params: { threadId: 'inactive', turnId: 'no', tool: 'agent_delegate', arguments: { agentId: worker.agentId, task: 'work' } } });
  assert.match(primary.client.responses[0].error, /inactive/);
  await start(primary, source);
  assert.throws(() => agents.tool(primary, source, 'agent_delegate', { agentId: worker.agentId, task: 'outside' }), /different workspace/);
  assert.throws(() => agents.settings({ routing: 'smart' }), /Stop all/);
  assert.throws(() => agents.tool(primary, source, 'agents_list', { unexpected: true }), /Invalid/);
  complete(primary, source);
});

test('agents search bounded visible context and Main through every provider bridge', async t => {
  const { agents, primary, add, workspace } = await setup(t);
  const worker = await add('Researcher'), target = agents.conversation(worker, true);
  target.items.push(
    { id: 'question', type: 'userMessage', content: [{ type: 'text', text: 'Investigate the renderer.' }, { type: 'image', url: 'PRIVATE_IMAGE_BYTES' }] },
    { id: 'private', type: 'reasoning', text: 'PRIVATE_REASONING' },
    { id: 'answer', type: 'agentMessage', text: 'Renderer evidence: wrong material binding.\n[task: done]' },
    { id: 'tool', type: 'commandExecution', command: 'rg material', aggregatedOutput: 'renderer.cpp:45 material binding', exitCode: 0 },
    { id: 'mcp', type: 'mcpToolCall', server: 'source', tool: 'read', result: { content: [{ type: 'text', text: 'Recorded tool evidence' }] } },
    { id: 'pending', type: 'userMessage', pending: true, content: [{ type: 'text', text: 'PRIVATE_PENDING_MESSAGE' }] },
  );
  target.instructions = 'PRIVATE_INSTRUCTIONS';
  const source = primary.create(workspace, 'read-only');
  await start(primary, source);
  const roster = await primary.bridgeTool(source.id, 'agents_list', {});
  assert.ok(roster.some(agent => agent.id === 'main' && agent.name === 'Main'));
  const result = await primary.bridgeTool(source.id, 'agent_read_context', { agentId: worker.agentId, query: 'MATERIAL' });
  assert.equal(result.origin.agentId, worker.agentId);
  assert.equal(result.origin.sessionId, target.id);
  assert.equal(result.excerpts.length, 3);
  assert.match(result.excerpts[0].text, /wrong material binding/);
  const full = await primary.bridgeTool(source.id, 'agent_read_context', { agentId: worker.agentId });
  assert.doesNotMatch(JSON.stringify(full), /PRIVATE_|\[task: done\]/);
  assert.match(JSON.stringify(full), /Recorded tool evidence/);
  const lines = await primary.bridgeTool(source.id, 'agent_read_context', { agentId: worker.agentId, line: result.excerpts[0].line });
  assert.equal(lines.excerpts[0].text, result.excerpts[0].text);
  assert.equal(lines.sha256, result.sha256);
  assert.equal(worker.busy, null, 'reading never starts a task on the target');
  await primary.helperToolCall({ id: 180, params: { threadId: source.threadId, turnId: source.turnId, tool: 'agent_read_context', arguments: { agentId: worker.agentId, query: 'Recorded tool' } } });
  assert.equal(primary.client.responses.find(r => r.id === 180).result.success, true);
  target.items.push({ id: 'large', type: 'agentMessage', text: ('evidence '.repeat(400) + '\n').repeat(40) });
  const page = await primary.bridgeTool(source.id, 'agent_read_context', { agentId: worker.agentId, query: 'evidence' });
  assert.ok(page.excerpts.length <= 30);
  assert.ok(page.excerpts.reduce((count, row) => count + row.text.length, 0) <= 8000);
  assert.equal(page.more, true);
  assert.notEqual(page.sha256, result.sha256, 'changed transcripts have a different fingerprint');
  const clipped = page.excerpts.find(row => row.clipped);
  assert.ok(clipped);
  const rest = await primary.bridgeTool(source.id, 'agent_read_context', { agentId: worker.agentId, line: clipped.line, column: 2001 });
  assert.equal(rest.excerpts[0].column, 2001);
  assert.ok(rest.excerpts[0].text.length);
  complete(primary, source, 'Main context evidence.');
  await start(worker, target);
  target.delegation = { delivered: false, state: 'running' };
  for (const provider of ['codex', 'claude-cli', 'cursor-cli']) {
    target.activeProvider = provider;
    const main = await worker.bridgeTool(target.id, 'agent_read_context', { agentId: 'main', query: 'Main context evidence' });
    assert.match(main.excerpts[0].text, /Main context evidence/);
    assert.equal(main.origin.name, 'Main');
  }
  delete target.delegation; target.activeProvider = 'codex';
  complete(worker, target);
});

test('context reads reject inactive, invalid and broader-access requests without exposing stored files', async t => {
  const { agents, primary, add, directory, workspace } = await setup(t);
  const other = path.join(directory, 'other-context'); fs.mkdirSync(other);
  const worker = await add('Outside', other), target = agents.conversation(worker, true);
  target.items.push({ id: 'outside', type: 'agentMessage', text: 'Outside context' });
  const source = primary.create(workspace, 'read-only'), args = { agentId: worker.agentId };
  await assert.rejects(primary.bridgeTool(source.id, 'agent_read_context', args), /no active turn/);
  await start(primary, source);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_read_context', args), /requires Full access/);
  source.access = 'danger-full-access';
  assert.match(JSON.stringify(await primary.bridgeTool(source.id, 'agent_read_context', args)), /Outside context/);
  source.access = 'read-only'; target.workspace = workspace; target.access = 'danger-full-access';
  await assert.rejects(primary.bridgeTool(source.id, 'agent_read_context', args), /requires Full access/);
  target.access = 'read-only';
  for (const invalid of [{ agentId: '../sessions.json' }, { agentId: '' }, {}, { ...args, path: primary.filename }, { ...args, line: 0 }, { ...args, column: 1.5 }, { ...args, query: '' }, { ...args, query: 'x'.repeat(501) }]) {
    await assert.rejects(primary.bridgeTool(source.id, 'agent_read_context', invalid));
  }
  assert.deepEqual((await primary.bridgeTool(source.id, 'agent_read_context', { ...args, query: 'no matching evidence' })).excerpts, []);
  const empty = await add('Empty');
  assert.equal((await primary.bridgeTool(source.id, 'agent_read_context', { agentId: empty.agentId })).origin.sessionId, null);
  assert.equal(empty.data.sessions.length, 0, 'reading an empty agent does not create a conversation');
  await agents.deleteAgent(worker.agentId);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_read_context', args), /Unknown agent/);
  complete(primary, source);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_read_context', { agentId: 'main' }), /no active turn/);
});

test('restarting interrupts delegated work instead of resending it', async t => {
  const { agents, primary, add, factory, workspace } = await setup(t);
  const worker = await add('Researcher');
  const source = primary.create();
  worker.connection = 'disconnected';
  const { sessionId } = agents.delegate(primary, source, worker.agentId, 'Inspect files');
  worker.save(); primary.save();
  const restoredRoot = factory(primary.filename, workspace);
  const restored = new Agents(restoredRoot, async () => {}, factory);
  const session = restored.owner(sessionId).session(sessionId);
  assert.equal(session.delegation.state, 'interrupted');
  assert.match(session.error, /restart/);
  assert.equal(restored.owner(sessionId).client.calls.length, 0);
  for (const c of restored.controllers.values()) c.close();
});

test('an unconfirmed cleanup blocks every agent, and queued tasks can be stopped without starting', async t => {
  const { agents, primary, add } = await setup(t);
  const worker = await add('Researcher');
  primary.data.executionBlock = { reason: 'unconfirmed' };
  const target = worker.create();
  await assert.rejects(start(worker, target), /check may still be running/);
  assert.equal(worker.client.calls.filter(c => c.method === 'turn/start').length, 0);
  delete primary.data.executionBlock;
  const source = primary.create(); worker.connection = 'disconnected';
  const { sessionId } = agents.delegate(primary, source, worker.agentId, 'Inspect');
  assert.throws(() => worker.deleteSession(sessionId), /queued/);
  source.queuePaused = true;
  await agents.stop(sessionId);
  assert.equal(worker.session(sessionId).delegation.state, 'interrupted');
  assert.equal(source.queue.length, 1);
  assert.equal(primary.busy, null, 'Paused sources are not restarted by agent results');
});

test('shutdown stops all controllers and invokes process cleanup once', async t => {
  const { agents, primary, add } = await setup(t);
  const worker = await add('Researcher');
  let stopped = 0, closed = 0, reaped = 0;
  const originalClose = worker.close.bind(worker);
  primary.stop = worker.stop = async () => { stopped++; };
  worker.close = () => { closed++; originalClose(); throw new Error('Simulated save failure'); };
  primary.shutdown = async () => { reaped++; return { stopped: 0, remaining: [] }; };
  await agents.shutdown({ stopMs: 0 });
  assert.equal(stopped, 2); assert.equal(closed, 1); assert.equal(reaped, 1);
  assert.equal(agents.closing, true);
  worker.close = originalClose;
});

test('changing an idle conversation to Full access does not reuse a weaker lease', async t => {
  const { agents, primary, add, directory } = await setup(t);
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  const worker = await add('Other', other);
  const source = primary.create(), target = worker.create();
  await start(primary, source); await start(worker, target);
  complete(primary, source);
  primary.permissions(source.id, 'danger-full-access');
  const waiting = start(primary, source);
  assert.ok(source.waitingForAgent);
  assert.equal(primary.client.calls.filter(c => c.method === 'turn/start').length, 1);
  complete(worker, target); agents.pump(); await waiting;
  assert.equal(agents.leases.get(primary).exclusive, true);
  complete(primary, source);
});

test('a result waits while its source agent works in another conversation', async t => {
  const { agents, primary, add, directory } = await setup(t);
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  const worker = await add('Other', other);
  const source = primary.create(undefined, 'danger-full-access'), unrelated = primary.create();
  const { sessionId } = agents.delegate(primary, source, worker.agentId, 'Inspect your project');
  const child = worker.session(sessionId);
  await until(() => !!child.turnId);
  await start(primary, unrelated);
  complete(worker, child, 'Delegated result.'); await worker.gateDone; agents.pump();
  assert.equal(source.queue.length, 1);
  assert.equal(primary.busy, unrelated.id);
  complete(primary, unrelated); agents.pump();
  await until(() => primary.busy === source.id && !!source.turnId);
  assert.equal(source.agentReplyActive, true);
  complete(primary, source);
});
