const { readSessionData } = require('../src/session-store.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Controller } = require('../src/controller.cjs');
const { MEASURED_REAP } = require('../src/tasks.cjs');
const { trimFleet } = require('../ui/agent-state.js');

class Fake extends EventEmitter {
  constructor() { super(); this.calls = []; this.seq = 0; this.turnIds = []; }
  async start() { }
  async call(method, params, timeout) {
    this.calls.push({ method, params, timeout });
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } };
    if (method === 'model/list') return {
      data: ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol', 'gpt-6-astra'].map(model => ({
        model, supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'].map(reasoningEffort => ({ reasoningEffort })),
      }))
    };
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || 'thread-test' } };
    if (method === 'thread/items/list') return { data: [], nextCursor: null };
    if (method === 'turn/start') {
      const id = `turn-${++this.seq}`;
      this.turnIds.push(id);
      if (this.beforeTurnResponse) await this.beforeTurnResponse({ params, id, emit: message => this.emit('notification', message) });
      return { turn: { id } };
    }
    if (method === 'thread/compact/start') return {};
    if (method === 'command/exec') return this.onExec ? this.onExec(params, timeout) : { exitCode: 0, stdout: '', stderr: '' };
    if (method === 'command/exec/terminate') return this.onTerminate ? this.onTerminate(params) : {};
    return {};
  }
  respond() { }
  rejectRequest() { }
  close() { }
}

test('wiki proposals require an eligible task and local wiki, preserve worker through queue, and create no task', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  complete(controller, session, fake.turnIds[0]);
  await controller.gateDone;
  const origin = session.tasks[0];
  await assert.rejects(controller.proposeWiki(session.id, origin.id), /wiki/);
  fs.mkdirSync(path.join(session.workspace, 'docs', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(session.workspace, 'docs', 'wiki', 'index.md'), '# Wiki');
  controller.save();
  const restored = reopen(controller);
  t.after(() => restored.close());
  assert.equal(restored.data.sessions[0].tasks[0].wikiAvailable, true);
  for (const state of ['blocked', 'needs-you', 'cancelled', 'running']) {
    origin.state = state;
    await assert.rejects(controller.proposeWiki(session.id, origin.id), /completed task/);
  }
  origin.state = 'not-checked';
  origin.attempts[0].workerOutcome = 'failed';
  await assert.rejects(controller.proposeWiki(session.id, origin.id), /completed task/);
  origin.attempts[0].workerOutcome = 'completed';
  await controller.send({ id: session.id, text: 'plain turn', mode: 'terra-light', task: 'off' });
  const busyTurn = fake.turnIds.at(-1);
  assert.deepEqual(await controller.proposeWiki(session.id, origin.id), { queued: true });
  assert.equal(session.queue[0].wikiTaskId, origin.id);
  assert.equal(session.queue[0].task, 'off');
  complete(controller, session, busyTurn);
  await until(() => fake.turnIds.length === 3);
  const sent = fake.calls.filter(c => c.method === 'turn/start').at(-1).params;
  assert.equal(sent.model, origin.route.model);
  assert.equal(sent.effort, origin.route.effort);
  assert.match(sent.input[0].text, /do not edit files/);
  assert.match(sent.input[0].text, new RegExp(origin.id));
  assert.equal(session.tasks.length, 1);
  assert.equal(session.submission.taskId, null);
  complete(controller, session, fake.turnIds.at(-1));
  const available = controller.available.bind(controller);
  controller.available = () => false;
  await assert.rejects(controller.proposeWiki(session.id, origin.id), /original task worker is unavailable/);
  controller.available = available;
});

test('task tracking does not inject a checklist; optional proposals stay advisory', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  const original = '[Router]\nImplement this. The user can legitimately type [Harness instruction].';
  await controller.send({ id: session.id, text: original, mode: 'terra-light', task: 'on' });
  const sent = fake.calls.find(c => c.method === 'turn/start').params;
  assert.equal(sent.input[0].text, original);
  const user = session.items.find(i => i.clientId === sent.clientUserMessageId);
  assert.notEqual(user.routeLabel, 'Router');
  controller.notification({ method: 'item/completed', params: { threadId: session.threadId, turnId: fake.turnIds[0],
    item: { id: 'remote-user', clientId: user.clientId, type: 'userMessage', content: sent.input } } });
  assert.equal(session.items.find(i => i.clientId === user.clientId).content[0].text, original);
  controller.notification({ method: 'item/completed', params: { threadId: session.threadId, turnId: fake.turnIds[0],
    item: { id: 'answer', type: 'agentMessage', phase: 'final_answer', text: 'Done when:\n- File exists\n- Output works\n- Tests pass\n\nSee missing.js:99.' } } });
  complete(controller, session, fake.turnIds[0]);
  await controller.gateDone;
  assert.equal(session.tasks[0].state, 'not-checked');
  assert.equal(session.tasks[0].checklistStatus, 'proposed');
  assert.equal(session.tasks[0].attempts[0].citations.references[0].status, 'unresolved');
  const call = fake.call.bind(fake);
  fake.call = async (method, params, timeout) => method === 'thread/items/list'
    ? { data: [{ turnId: fake.turnIds[0], item: { id: 'remote-user', clientId: user.clientId, type: 'userMessage', content: sent.input } }], nextCursor: null }
    : call(method, params, timeout);
  controller.loaded.delete(session.id);
  await controller.resume(session, session.tasks[0].route);
  assert.equal(session.items.find(i => i.clientId === user.clientId).content[0].text, original);
});

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-harness-test-'));
  const fake = new Fake();
  const smartRouter = { calls: [], cancel() { }, close() { }, jev: null, async choose() { throw new Error('unexpected route'); } };
  const controller = new Controller(path.join(directory, 'state.json'), directory, fake, smartRouter);
  controller.claude.models = ['haiku', 'sonnet', 'opus'].map(model => ({ id: 'claude-cli:' + model, model, label: model, provider: 'claude-cli', effort: null, rank: 35, worker: true, router: true, images: true }));
  controller.claude.refresh = async () => controller.claude.status;
  controller.cursor.refresh = async () => controller.cursor.status;
  await controller.initialize();
  t.after(() => { controller.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { controller, fake, smartRouter };
}

function complete(controller, session, turnId, status = 'completed') {
  controller.notification({ method: 'turn/completed', params: { threadId: session.threadId, turn: { id: turnId, status } } });
}

async function flush() {
  for (let i = 0; i < 8; i++) await new Promise(setImmediate);
}

test('file attachments keep their snapshot and display metadata through queues, provider refresh and export', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create(undefined, 'read-only');
  await controller.send({ id: session.id, text: 'First question', mode: 'terra-light', task: 'off' });
  const files = [{ name: 'sample.cpp', text: 'ATTACHMENT_EVIDENCE\nconst value = 42;\n' }];
  assert.deepEqual(await controller.send({ id: session.id, text: 'Review this code.', files, mode: 'terra-light', task: 'off' }), { queued: true });
  const queued = session.queue[0];
  assert.deepEqual(queued.fileMessage.names, ['sample.cpp']);
  assert.equal(queued.fileMessage.displayText, 'Review this code.');
  assert.match(readSessionData(controller.filename).sessions[0].queue[0].text, /ATTACHMENT_EVIDENCE/);
  complete(controller, session, fake.turnIds[0]);
  await until(() => fake.turnIds.length === 2);
  const prompt = fake.calls.filter(call => call.method === 'turn/start').at(-1).params;
  assert.match(prompt.input[0].text, /untrusted reference contents/);
  assert.match(prompt.input[0].text, /ATTACHMENT_EVIDENCE/);
  assert.deepEqual(prompt.sandboxPolicy, controller.sandboxFor('read-only', session.workspace));
  let sent = session.items.filter(item => item.type === 'userMessage').at(-1);
  const original = sent.content;
  controller.notification({ method: 'item/completed', params: { threadId: session.threadId, turnId: session.turnId,
    item: { id: 'provider-user-item', clientId: sent.clientId, type: 'userMessage', content: [{ type: 'text', text: 'Provider representation' }] } } });
  sent = session.items.find(item => item.id === 'provider-user-item');
  assert.deepEqual(sent.content, original);
  assert.deepEqual(sent.fileMessage, queued.fileMessage);
  const markdown = require('../src/conversation-export.cjs').conversationMarkdown(session);
  assert.match(markdown, /sample\.cpp/);
  assert.match(markdown, /ATTACHMENT_EVIDENCE/);
  complete(controller, session, fake.turnIds[1]);
  await flush();
  const call = fake.call.bind(fake);
  let nativeItems = [{ turnId: fake.turnIds[1], item: { id: sent.id, clientId: sent.clientId, type: 'userMessage',
    content: [{ type: 'text', text: 'Native representation' }] } }];
  fake.call = (method, ...args) => method === 'thread/items/list' ? Promise.resolve({ data: nativeItems, nextCursor: null }) : call(method, ...args);
  controller.loaded.clear();
  await controller.resume(session, controller.resolveWorker('terra-light'));
  assert.equal(session.items.filter(item => item.fileMessage).length, 1, 'a returned native item does not duplicate the attachment');
  nativeItems = [{ turnId: fake.turnIds[1], item: { id: 'native-summary', type: 'agentMessage', text: 'Native compacted history' } }];
  controller.loaded.clear();
  await controller.resume(session, controller.resolveWorker('terra-light'));
  const retained = session.items.filter(item => item.fileMessage);
  assert.equal(retained.length, 1, 'a native history replacement retains the original file snapshot');
  assert.deepEqual(retained[0].content, original);
});

test('invalid attachments reject before inference or queue mutation and file-only requests get a useful default', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  for (const files of [[{ name: '../outside.txt', text: 'data' }], [{ name: 'document.pdf', text: 'data' }], [{ name: 'large.txt', text: 'x'.repeat(65537) }]]) {
    await assert.rejects(controller.send({ id: session.id, text: 'Read it', files, mode: 'terra-light', task: 'off' }), /UTF-8|64 KB/);
  }
  assert.equal(fake.calls.some(call => call.method === 'turn/start'), false);
  assert.equal(session.queue?.length || 0, 0);
  await controller.send({ id: session.id, text: '', files: [{ name: 'empty.txt', text: '' }], mode: 'terra-light', task: 'off' });
  const sent = session.items.find(item => item.type === 'userMessage');
  assert.equal(sent.fileMessage.displayText, 'Review the attached file(s).');
});

test('provider connecting status follows parallel startup checks and clears after failure', async t => {
  const { controller, fake } = await setup(t);
  let finishClaude, finishCursor, finishNative, finishCodex;
  controller.bridge.start = async () => {};
  controller.claude.refresh = () => new Promise(resolve => { finishClaude = resolve; });
  controller.cursor.refresh = () => new Promise(resolve => { finishCursor = resolve; });
  const native = { status: { installed: false, loggedIn: false }, models: [],
    inspect() { this.status = { installed: true, loggedIn: false }; }, refresh: () => new Promise(resolve => { finishNative = resolve; }), close() {} };
  controller.nativeCLIs.set('native:antigravity', native);
  controller.data.settings.antigravityEnabled = true;
  fake.start = () => new Promise((_resolve, reject) => { finishCodex = reject; });
  const initializing = controller.initialize();
  assert.deepEqual(controller.snapshot().connectingProviders.sort(), ['claude-cli', 'cursor-cli', 'native:antigravity']);
  assert.equal(native.status.installed, true, 'an installed CLI is not shown as missing while its check runs');
  finishClaude(); await flush();
  assert.deepEqual(controller.snapshot().connectingProviders.sort(), ['codex', 'cursor-cli', 'native:antigravity'], 'Codex does not wait for slower CLI checks');
  finishCodex(new Error('offline')); finishCursor(); finishNative(); await initializing;
  assert.deepEqual(controller.snapshot().connectingProviders, []);
  assert.equal(controller.codex.connected, false);
  assert.equal(Object.hasOwn(controller.data, 'connectingProviders'), false, 'progress is never saved');
});

test('provider connecting status survives overlapping requests and clears on rejection', async t => {
  const { controller } = await setup(t);
  let finish;
  const pending = controller.withProviderConnection('local', () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(controller.withProviderConnection('local', async () => { throw new Error('offline'); }), /offline/);
  assert.deepEqual(controller.snapshot().connectingProviders, ['local']);
  finish(); await pending;
  assert.deepEqual(controller.snapshot().connectingProviders, []);
});

test('provider connecting status covers browser sign-in through success, failure and disconnect', async t => {
  const { controller, fake } = await setup(t);
  const call = fake.call.bind(fake);
  fake.call = (method, params) => method === 'account/login/start' ? Promise.resolve({ authUrl: 'https://auth.openai.com/login' }) : call(method, params);
  let opened;
  assert.deepEqual(await controller.loginChatGPT(url => { opened = url; }), { started: true });
  assert.equal(opened, 'https://auth.openai.com/login');
  assert.deepEqual(controller.snapshot().connectingProviders, ['codex']);
  await assert.rejects(controller.loginChatGPT(() => {}), /already open/);
  let finishRefresh;
  controller.refreshAccount = () => new Promise(resolve => { finishRefresh = resolve; });
  controller.notification({ method: 'account/login/completed', params: { success: true } });
  assert.equal(controller.snapshot().chatgptLoginPending, true);
  finishRefresh(); await flush();
  assert.deepEqual(controller.snapshot().connectingProviders, []);
  await controller.loginChatGPT(() => {});
  controller.notification({ method: 'account/login/completed', params: { success: false, error: 'Sign-in cancelled' } });
  await flush();
  assert.deepEqual(controller.snapshot().connectingProviders, []);
  assert.equal(controller.error, 'Sign-in cancelled');
  await assert.rejects(controller.loginChatGPT(() => { throw new Error('Cannot open browser'); }), /Cannot open browser/);
  assert.deepEqual(controller.snapshot().connectingProviders, []);
  await controller.loginChatGPT(() => {});
  fake.emit('disconnected', 'connection lost');
  assert.deepEqual(controller.snapshot().connectingProviders, []);
});

for (const stopped of [false, true]) test(`Claude ${stopped ? 'Stop' : 'completion'} publishes the idle state after saving`, async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  session.helperTools = false;
  let finish;
  controller.claude.run = ({ signal, onEvent }) => new Promise((resolve, reject) => {
    finish = () => resolve({ result: 'Finished.' });
    signal.addEventListener('abort', () => reject(new Error('Claude stopped.')), { once: true });
    onEvent({ type: 'assistant', message: { id: 'answer', content: [{ type: 'text', text: 'Finished.' }] } });
  });
  const nextState = () => new Promise((resolve, reject) => {
    const listener = state => { clearTimeout(timer); resolve({ busy: state.busy, status: state.sessions[0].status }); };
    const timer = setTimeout(() => { controller.off('state', listener); reject(new Error('No state update reached the UI')); }, 1000);
    controller.once('state', listener);
  });
  const running = nextState();
  const sent = controller.send({ id: session.id, text: 'review', mode: 'claude-cli:sonnet', task: stopped ? 'off' : 'on' });
  assert.equal((await running).busy, session.id);
  const idle = nextState();
  if (stopped) await controller.stop(); else finish();
  await sent;
  await controller.gateDone;
  const status = stopped ? 'interrupted' : 'completed';
  assert.equal(readSessionData(controller.filename).sessions[0].status, status);
  assert.deepEqual(await idle, { busy: null, status });
});

test('changed Harness-kept rules refresh an existing worker; an AGENTS.md edit is left to Codex and nothing is created', async t => {
  const { controller, fake } = await setup(t);
  controller.wikiStore = new (require('../src/workspace/wiki-store.cjs').WikiStore)(path.join(path.dirname(controller.filename), 'Workspaces'));
  const session = controller.create();
  await controller.send({ id: session.id, text: 'hello', mode: 'terra-light', task: 'off' });
  assert.equal(fs.existsSync(path.join(session.workspace, 'PhasmaHarness.md')), false);
  complete(controller, session, session.turnId);
  await flush();
  fs.writeFileSync(path.join(controller.wikiStore.ensure(session.workspace).root, 'kept-rules.md'), '- Use the violet convention.\n');
  await controller.send({ id: session.id, text: 'continue', mode: 'terra-light', task: 'off' });
  assert.match(fake.calls.filter(c => c.method === 'thread/resume').at(-1).params.developerInstructions, /violet convention/);
  complete(controller, session, session.turnId);
  await flush();
  const count = fake.calls.filter(c => c.method === 'thread/resume').length;
  fs.writeFileSync(path.join(session.workspace, 'AGENTS.md'), 'Codex reads this itself.');
  await controller.send({ id: session.id, text: 'again', mode: 'terra-light', task: 'off' });
  assert.equal(fake.calls.filter(c => c.method === 'thread/resume').length, count);
});

test('skill paths remain pinned until an ordinary worker finishes after Undo', async t => {
  const { controller } = await setup(t), session = controller.create();
  const skills = require('../src/skill-packages.cjs');
  controller.wikiStore = new (require('../src/workspace/wiki-store.cjs').WikiStore)(path.join(path.dirname(controller.filename), 'Workspaces'));
  const candidate = path.join(session.workspace, 'candidate');
  fs.mkdirSync(candidate, { recursive: true });
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), '# Pinned skill\nUse this version throughout the turn.');
  fs.writeFileSync(path.join(candidate, 'helper.cjs'), 'process.stdout.write("pinned");');
  const root = path.join(controller.wikiStore.location(session.workspace).root, '..', 'skills');
  const skill = skills.prepare(root, 'workflow', candidate, controller.skillDirectories(session), []), adopted = skills.adopt(skill);
  await controller.send({ id: session.id, text: 'Use the skill.', mode: 'terra-light', task: 'off' });
  const pinned = controller.skillDirectories(session).workflow;
  controller.toolHelpers.read(session, { skill: 'workflow' });
  assert.deepEqual(session.submission.skillReads, ['workflow']);
  skills.undo(adopted);
  controller.pruneSkillStore(session.workspace);
  assert.equal(controller.skillDirectories(session).workflow, pinned);
  assert.ok(fs.existsSync(path.join(pinned, 'helper.cjs')));
  complete(controller, session, session.turnId);
  await flush();
  assert.equal(controller.skillDirectories(session).workflow, require('../src/worker-instructions.cjs').skillDir('workflow'));
  assert.ok(!fs.existsSync(pinned));
});

test('adopted skills refresh existing Codex and CLI instructions without restarting or changing bundled files', async t => {
  const { controller, fake } = await setup(t), session = controller.create();
  const skills = require('../src/skill-packages.cjs');
  controller.wikiStore = new (require('../src/workspace/wiki-store.cjs').WikiStore)(path.join(path.dirname(controller.filename), 'Workspaces'));
  await controller.send({ id: session.id, text: 'hello', mode: 'terra-light', task: 'off' });
  complete(controller, session, session.turnId);
  await flush();
  const candidate = path.join(session.workspace, 'candidate');
  fs.mkdirSync(candidate);
  fs.writeFileSync(path.join(candidate, 'SKILL.md'), 'Refreshed skill marker. {{SKILL_DIR}}/helper.cjs');
  fs.writeFileSync(path.join(candidate, 'helper.cjs'), 'process.exit(0);');
  const root = path.join(controller.wikiStore.location(session.workspace).root, '..', 'skills');
  const snapshot = skills.prepare(root, 'workflow', candidate, controller.skillDirectories(session), []);
  const adopted = skills.adopt(snapshot), activePath = controller.skillDirectories(session).workflow.replace(/\\/g, '/');
  await controller.send({ id: session.id, text: 'continue', mode: 'terra-light', task: 'off' });
  assert.ok(fake.calls.filter(c => c.method === 'thread/resume').at(-1).params.developerInstructions.includes(activePath));
  assert.ok(JSON.stringify(fake.calls.filter(c => c.method === 'thread/inject_items').at(-1)).includes(activePath));
  assert.match(controller.toolHelpers.read(session, { skill: 'workflow' }).text, /Refreshed skill marker/);
  complete(controller, session, session.turnId);
  await flush();
  session.helperTools = false;
  for (const provider of ['claude', 'cursor']) {
    controller.data.settings[provider + 'Enabled'] = true;
    controller[provider].status = { installed: true, loggedIn: true };
    if (provider === 'cursor') {
      controller.cursor.models = [{ id: 'fixture', label: 'Fixture' }];
      controller.providerSettings({ action: 'enableDiscovered', provider: 'cursor-cli', model: 'fixture', label: 'Fixture' });
    }
    let received;
    controller[provider].run = async request => {
      received = request;
      const content = fs.readFileSync(path.join(activePath, 'SKILL.md'), 'utf8');
      request.onEvent({ type: 'assistant', session_id: 'native-' + provider, message: { content: [{
        type: 'tool_use', id: 'read-' + provider, name: 'Read', input: { file_path: path.join(activePath, 'SKILL.md') }
      }] } });
      request.onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read-' + provider,
        content: provider === 'cursor' ? [{ type: 'content', content: { type: 'text', text: content } }] : content }] } });
      return { result: 'ok' };
    };
    const mode = provider === 'claude' ? 'claude-cli:sonnet' : 'cursor-cli:fixture:default';
    await controller.send({ id: session.id, text: 'Continue.', mode, task: 'off' });
    assert.ok(received.instructions.includes(activePath), provider + ' receives the active package path with helpers disabled');
    assert.equal(session.items.find(item => item.id === 'read-' + provider).turnId, session.submission.turnId);
    const readHost = { comparisonOf: () => ({ record: { target: 'skill', skill: { name: 'workflow' } } }), skillDirectories: () => ({ workflow: activePath }) };
    assert.deepEqual(controller.comparisonSkillReads.call(readHost, session, session.submission), ['workflow'], provider + ' native reads retain the Harness turn ID');
  }
  skills.undo(adopted);
  assert.ok(!controller.workerInstructions(session).includes(activePath));
});

test('damaged skill stores keep normal turns working with one persistent fallback notice', async t => {
  const { controller, fake } = await setup(t), session = controller.create();
  controller.wikiStore = new (require('../src/workspace/wiki-store.cjs').WikiStore)(path.join(path.dirname(controller.filename), 'Workspaces'));
  const root = path.join(controller.wikiStore.location(session.workspace).root, '..', 'skills');
  fs.mkdirSync(root, { recursive: true });
  for (const saved of ['{broken', JSON.stringify({ workflow: '11111111-1111-4111-8111-111111111111' })]) {
    fs.writeFileSync(path.join(root, 'active.json'), saved);
    const before = session.items.filter(item => item.skillStoreWarning).length;
    for (let i = 0; i < 2; i++) {
      await controller.send({ id: session.id, text: 'Continue working.', mode: 'terra-light', task: 'off' });
      assert.ok(fake.calls.some(call => call.method === 'turn/start'));
      complete(controller, session, session.turnId);
      await flush();
    }
    assert.equal(session.items.filter(item => item.skillStoreWarning).length, before + 1);
    assert.equal(fs.readFileSync(path.join(root, 'active.json'), 'utf8'), saved);
  }
});

test('shared worker defaults reach Codex and CLI; AGENTS.md goes only to a bot that does not load it itself', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.wikiStore = new (require('../src/workspace/wiki-store.cjs').WikiStore)(path.join(path.dirname(controller.filename), 'private-wiki'));
  fs.writeFileSync(path.join(session.workspace, 'AGENTS.md'), 'Managed amberquartz instructions.');
  await controller.send({ id: session.id, text: 'hello', mode: 'terra-light', task: 'off' });
  const instructions = fake.calls.find(c => c.method === 'thread/start').params.developerInstructions;
  assert.ok(instructions.includes('Harness skills') && instructions.includes('Ponytail full'));
  assert.ok(!instructions.includes('private-wiki'), 'Harness data is not a wiki');
  assert.doesNotMatch(instructions, /Managed amberquartz instructions/, 'Codex loads AGENTS.md itself');
  assert.equal(fake.calls.find(c => c.method === 'thread/start').params.config.project_doc_max_bytes, undefined);
  assert.equal(fs.existsSync(path.join(session.workspace, 'PhasmaHarness.md')), false);
  complete(controller, session, session.turnId);
  await flush();
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  session.helperTools = false;
  let cli;
  controller.claude.run = async request => { cli = request; return { result: 'ok' }; };
  await controller.send({ id: session.id, text: 'normal mode', mode: 'claude-cli:sonnet', task: 'off' });
  assert.ok(cli.instructions.includes('Ponytail full'));
  assert.match(cli.instructions, /Managed amberquartz instructions/, 'without a CLAUDE.md, Claude Code would not see AGENTS.md');
  assert.equal(cli.managedInstructions, true);
  assert.equal(cli.helpers, null);
  assert.ok(cli.prompt.includes('normal mode'));
});

test('kept-rule edits refresh and inject into resumed Codex work without creating workspace entries', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.wikiStore = new (require('../src/workspace/wiki-store.cjs').WikiStore)(path.join(path.dirname(controller.filename), 'Workspaces'));
  await controller.send({ id: session.id, text: 'hello', mode: 'terra-light', task: 'off' });
  complete(controller, session, session.turnId);
  await flush();
  fs.writeFileSync(path.join(controller.wikiStore.ensure(session.workspace).root, 'kept-rules.md'), 'Refreshed managed convention.');
  await controller.send({ id: session.id, text: 'continue', mode: 'terra-light', task: 'off' });
  assert.match(fake.calls.findLast(c => c.method === 'thread/inject_items').params.items[0].content[0].text, /Refreshed managed convention/);
  assert.equal(fs.existsSync(path.join(session.workspace, 'INSTRUCTIONS.md')), false);
});

test('unrelated completion while the turn id is unknown is ignored', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  fake.beforeTurnResponse = async ({ params, emit }) => {
    emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'old-turn', status: 'completed' } } });
  };
  await controller.send({ id: session.id, text: 'first', mode: 'terra-light' });
  assert.equal(session.submission.turnId, 'turn-1');
  assert.equal(session.submission.state, 'acknowledged');
  assert.equal(controller.busy, session.id);
  assert.equal(session.status, 'running');
});

test('completion before the turn/start response is buffered and replayed', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  fake.beforeTurnResponse = async ({ params, id, emit }) => {
    emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id, status: 'completed' } } });
  };
  await controller.send({ id: session.id, text: 'first', mode: 'terra-light' });
  assert.equal(session.submission.state, 'completed');
  assert.equal(session.submission.turnId, 'turn-1');
  assert.equal(controller.busy, null);
  assert.equal(session.status, 'completed');
});

test('delayed completion of an older turn does not finish the current turn', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  await controller.send({ id: session.id, text: 'first', mode: 'terra-light' });
  const first = fake.turnIds[0];
  complete(controller, session, first);
  await controller.send({ id: session.id, text: 'second', mode: 'terra-light' });
  const second = fake.turnIds[1];
  complete(controller, session, first);
  assert.equal(controller.busy, session.id);
  assert.equal(session.submission.turnId, second);
  assert.equal(session.status, 'running');
  complete(controller, session, second);
  complete(controller, session, first);
  assert.equal(session.submission.turnId, second);
  assert.equal(session.submission.state, 'completed');
  assert.equal(controller.busy, null);
});

test('duplicate completion after finish does not drain twice', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  await controller.send({ id: session.id, text: 'first', mode: 'terra-light' });
  await controller.send({ id: session.id, text: 'queued', mode: 'terra-light' });
  complete(controller, session, fake.turnIds[0]);
  complete(controller, session, fake.turnIds[0]);
  await flush();
  assert.equal(fake.turnIds.length, 2);
  assert.equal(session.queue.length, 0);
  assert.equal(controller.busy, session.id);
});

test('an old turn/started does not replace the owned turn', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  await controller.send({ id: session.id, text: 'first', mode: 'terra-light' });
  controller.notification({ method: 'turn/started', params: { threadId: session.threadId, turn: { id: 'turn-old' } } });
  controller.notification({ method: 'item/agentMessage/delta', params: { threadId: session.threadId, turnId: 'turn-old', itemId: 'old', delta: 'stale' } });
  assert.equal(session.turnId, fake.turnIds[0]);
  assert.equal(session.submission.turnId, fake.turnIds[0]);
  assert.equal(session.items.some(item => item.text === 'stale'), false);
});

test('delayed acknowledgement after cancel does not adopt an older completion', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  let release;
  let held = false;
  fake.beforeTurnResponse = ({ params, emit }) => {
    if (held) return;
    held = true;
    return new Promise(resolve => {
      emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id: 'old-turn', status: 'completed' } } });
      release = resolve;
    });
  };
  const pending = controller.send({ id: session.id, text: 'first', mode: 'terra-light' });
  while (!release) await new Promise(setImmediate);
  await controller.send({ id: session.id, text: 'queued', mode: 'terra-light' });
  await controller.stop();
  assert.equal(session.queuePaused, true);
  release();
  await pending;
  assert.equal(session.submission.turnId, 'turn-1');
  assert.notEqual(session.submission.state, 'completed');
  assert.equal(controller.busy, session.id);
  assert.equal(session.queue.length, 1);
  assert.equal(fake.calls.some(call => call.method === 'turn/interrupt' && call.params.turnId === 'turn-1'), true);
  complete(controller, session, 'turn-1');
  await flush();
  assert.equal(session.queue.length, 1);
  assert.equal(session.queuePaused, true);
  await controller.queuedMessage(session.id, session.queue[0].id, 'send');
  assert.equal(session.queuePaused, false);
  assert.equal(fake.turnIds.length, 2);
});

test('queue stays paused after Stop until Send now or a new Send', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  await controller.send({ id: session.id, text: 'first', mode: 'terra-light' });
  await controller.send({ id: session.id, text: 'queued', mode: 'terra-light' });
  await controller.stop();
  complete(controller, session, fake.turnIds[0], 'interrupted');
  await flush();
  assert.equal(session.queuePaused, true);
  assert.equal(session.queue.length, 1);
  assert.equal(fake.turnIds.length, 1);
  await controller.send({ id: session.id, text: 'new', mode: 'terra-light' });
  assert.equal(session.queuePaused, false);
  complete(controller, session, fake.turnIds[1]);
  await flush();
  assert.equal(session.queue.length, 0);
  assert.equal(fake.turnIds.length, 3);
});

test('CLI late completion does not finish the turn twice', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  let late;
  controller.claude.run = async request => {
    request.onEvent({ type: 'assistant', message: { id: 'claude-1', content: [{ type: 'text', text: 'answer' }] } });
    await controller.send({ id: session.id, text: 'next', mode: 'terra-light' });
    late = () => request.onEvent({ type: 'assistant', message: { id: 'claude-late', content: [{ type: 'text', text: 'late' }] } });
    return { result: 'answer', usage: { input_tokens: 1, output_tokens: 1 } };
  };
  await controller.send({ id: session.id, text: 'ask', mode: 'claude-cli:sonnet' });
  assert.equal(session.submission.state, 'completed');
  await flush();
  assert.equal(fake.turnIds.length, 1);
  const items = session.items.length;
  late();
  controller.notification({ method: 'turn/completed', params: { threadId: session.threadId, turn: { id: 'claude-late', status: 'completed' } } });
  await flush();
  assert.equal(session.items.length, items);
  assert.equal(fake.turnIds.length, 1);
  assert.equal(controller.busy, session.id);
});

// 2026-10-28: a bot's background "wait until Dota closes" command held its chat for an hour with no way to see or stop it.
test('a Claude turn lists its background tasks, reads and stops one, and drops them when the turn ends', async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  let request, finish;
  controller.claude.run = value => new Promise(resolve => {
    request = value;
    finish = () => resolve({ result: 'done', usage: { input_tokens: 1, output_tokens: 1 } });
  });
  session.queue = [{ id: 'first', text: 'continue', images: [], mode: 'claude-cli:sonnet', task: 'on' }];
  await controller.queuedMessage(session.id, 'first', 'send');
  await flush();
  const controls = [];
  request.onInput(async () => {}, async value => {
    controls.push(value);
    return value.subtype === 'get_task_output' ? { output: 'tick\n', total_bytes: 5, truncated: false } : {};
  });
  // The window gets a chat again only when its mark changes (trimFleet), as the fleet update sends it (agents.cjs).
  const sent = new Map();
  const fleet = () => trimFleet({ agentStates: { main: { ...controller.snapshot(), stateRevision: controller.stateRevision || 0,
    sharedRevision: controller.sharedRevision || 0, chatRevisions: Object.fromEntries(controller.chatRevisions || []) } } }, sent, false).agentStates.main;
  fleet();
  request.onEvent({ type: 'system', subtype: 'background_tasks_changed', tasks: [
    { task_id: 'b1', task_type: 'local_bash', description: 'Wait until Dota 2 closes' },
    { task_id: 'w', task_type: 'local_bash', description: 'CLI watcher', ambient: true }] });
  request.onEvent({ type: 'result', result: 'Paused until Dota closes.' });

  const relayed = fleet();
  assert.equal(relayed.sessionsKept, undefined, 'a background change alone sends the chat to the window again');
  const shown = relayed.sessions.find(chat => chat.id === session.id).background;
  assert.equal(shown.idle, true, 'Claude answered; only its task is left running');
  assert.deepEqual(shown.tasks.map(({ startedAt, ...task }) => task),
    [{ id: 'b1', description: 'Wait until Dota 2 closes', type: 'local_bash', agent: null }], 'the CLI’s own ambient watcher is not listed');
  assert.deepEqual(await controller.backgroundTask(session.id, 'b1', 'output'), { output: 'tick\n', total_bytes: 5, truncated: false });
  await controller.backgroundTask(session.id, 'b1', 'stop');
  assert.deepEqual(controls, [{ subtype: 'get_task_output', task_id: 'b1' }, { subtype: 'stop_task', task_id: 'b1' }]);
  await assert.rejects(controller.backgroundTask(session.id, 'w', 'stop'), /already ended/);

  finish();
  await flush();
  assert.equal(controller.snapshot().sessions.find(chat => chat.id === session.id).background, undefined);
  await assert.rejects(controller.backgroundTask(session.id, 'b1', 'output'), /already ended/);
});

test('a running Codex command shows its output and stops on its own while the turn goes on', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  await controller.send({ id: session.id, text: 'Build it', mode: 'terra-light', task: 'off' });
  const turnId = fake.turnIds[0];
  // A crash can leave an earlier turn's command "inProgress"; it is not running, so it cannot be stopped by its old id.
  session.items.push({ id: 'exec-0', turnId: 'turn-before', type: 'commandExecution', status: 'inProgress', command: 'npm run dev', processId: '7' });
  await assert.rejects(controller.backgroundTask(session.id, '7', 'stop'), /already ended/);
  controller.notification({ method: 'item/started', params: { threadId: session.threadId, turnId,
    item: { id: 'exec-1', type: 'commandExecution', status: 'inProgress', command: 'ninja', processId: '4242' } } });
  controller.notification({ method: 'item/commandExecution/outputDelta', params: { threadId: session.threadId, turnId, itemId: 'exec-1', delta: '[1/9] compile\n' } });

  assert.deepEqual(await controller.backgroundTask(session.id, '4242', 'output'), { output: '[1/9] compile\n', truncated: false });
  await controller.backgroundTask(session.id, '4242', 'stop');
  assert.deepEqual(fake.calls.find(call => call.method === 'thread/backgroundTerminals/terminate').params, { threadId: session.threadId, processId: '4242' });
  assert.equal(controller.busy, session.id, 'only the command stops');

  controller.notification({ method: 'item/completed', params: { threadId: session.threadId, turnId,
    item: { id: 'exec-1', type: 'commandExecution', status: 'failed', command: 'ninja', processId: '4242' } } });
  await assert.rejects(controller.backgroundTask(session.id, '4242', 'stop'), /already ended/);
  complete(controller, session, turnId);
});

// 2026-10-28: a queued message that started a Claude turn held queueSending for the whole turn, greying Send now.
test('a queued message that starts a CLI turn frees the queue while the turn runs', async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const runs = [];
  controller.claude.run = request => new Promise(resolve => {
    runs.push({ request, finish: () => resolve({ result: 'done', usage: { input_tokens: 1, output_tokens: 1 } }) });
  });
  session.queue = [{ id: 'first', text: 'continue', images: [], mode: 'claude-cli:sonnet', task: 'on' },
    { id: 'second', text: 'status?', images: [], mode: 'claude-cli:sonnet', task: 'on' }];
  const delivery = controller.queuedMessage(session.id, 'first', 'send');
  await flush();
  assert.equal(runs.length, 1);
  assert.equal(controller.busy, session.id, 'the turn is still running');
  assert.equal(session.queueSending, false, 'Send now stays available for the rest of the queue');
  assert.deepEqual(session.queue.map(message => message.id), ['second']);
  await delivery;
  runs[0].finish();
  await flush();
  assert.equal(runs.length, 2, 'the next queued message still sends when the turn ends');
  assert.match(runs[1].request.prompt, /status\?/);
  runs[1].finish();
  await flush();
});

// 2026-10-28: a failed test-pool report saved as the chat notice never expired and reappeared on every visit.
test('the next turn clears a test-pool notice but keeps other notices', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  session.notice = 'Codex rerouted gpt-a to gpt-b: capacity';
  await controller.send({ id: session.id, text: 'first', mode: 'terra-light' });
  assert.equal(session.notice, 'Codex rerouted gpt-a to gpt-b: capacity');
  complete(controller, session, fake.turnIds[0]);
  await flush();
  Object.assign(session, { notice: 'Test pool: 11 failed, 14 passed', noticeExpiresAt: null });
  await controller.send({ id: session.id, text: 'second', mode: 'terra-light' });
  assert.equal(session.notice, null);
});

test('compaction finishes through thread/compacted or turn/completed for the owned turn', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  await controller.send({ id: session.id, text: 'hello', mode: 'terra-light' });
  const previous = fake.turnIds[0];
  complete(controller, session, previous);
  await controller.compact(session.id);
  assert.equal(session.submission.kind, 'compaction');
  assert.equal(session.submission.state, 'acknowledged');
  assert.equal(session.submission.turnId, null);
  controller.loaded.delete(session.id);
  const duringCompaction = fake.calls.length;
  await controller.load(session.id);
  assert.equal(fake.calls.length, duringCompaction, 'a manual compaction awaiting its turn ID must not be reloaded either');
  controller.notification({ method: 'turn/started', params: { threadId: session.threadId, turn: { id: previous } } });
  controller.notification({ method: 'thread/compacted', params: { threadId: session.threadId } });
  controller.notification({ method: 'thread/compacted', params: { threadId: session.threadId, turnId: 'other-turn' } });
  assert.equal(controller.busy, session.id);
  assert.equal(session.submission.turnId, null);
  assert.equal(session.lastCompactedAt, undefined, 'unowned compaction events do not update the timestamp');
  controller.notification({ method: 'turn/started', params: { threadId: session.threadId, turn: { id: 'compact-1' } } });
  controller.notification({ method: 'thread/compacted', params: { threadId: session.threadId, turnId: 'compact-1' } });
  assert.equal(controller.busy, null);
  assert.equal(session.submission.state, 'completed');
  assert.match(session.notice, /Context compacted/);
  assert.ok(Number.isFinite(session.lastCompactedAt), 'successful Codex compaction records its time');
  assert.equal(session.codexInstructionHash, undefined);
  assert.equal(controller.loaded.has(session.id), false);
  const items = JSON.stringify(session.items);
  await controller.compact(session.id);
  controller.notification({ method: 'turn/started', params: { threadId: session.threadId, turn: { id: 'compact-2' } } });
  complete(controller, session, 'compact-2');
  assert.equal(controller.busy, null);
  assert.equal(session.submission.turnId, 'compact-2');
  assert.equal(JSON.stringify(session.items), items);
});

test('automatic compaction defers instruction refresh until the live turn settles, even when the chat is reopened', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  await controller.send({ id: session.id, text: 'hello', mode: 'terra-light', task: 'off' });
  const params = { threadId: session.threadId, turnId: fake.turnIds[0], item: { id: 'auto-compact', type: 'contextCompaction' } };
  controller.notification({ method: 'item/started', params });
  assert.equal(session.lastCompactedAt, undefined);
  controller.notification({ method: 'item/completed', params });
  assert.ok(Number.isFinite(session.lastCompactedAt));
  assert.equal(session.codexInstructionHash, undefined);
  assert.equal(controller.loaded.has(session.id), true, 'compaction does not unload the live thread');
  const beforeLoad = fake.calls.length;
  await controller.load(session.id);
  assert.equal(fake.calls.length, beforeLoad, 'opening an automatically compacted chat must not reload a live turn');
  controller.loaded.delete(session.id); // Settings changes can also invalidate the loaded marker during a turn.
  await controller.load(session.id);
  await controller.resume(session);
  assert.equal(fake.calls.length, beforeLoad, 'the shared resume guard also protects a separately invalidated live thread');
  assert.equal(controller.activeTurns.get(session.id), fake.turnIds[0]);
  assert.equal(session.codexInstructionHash, undefined, 'defer the instruction refresh until this turn settles');
  controller.notification({ method: 'item/completed', params: { threadId: session.threadId, turnId: fake.turnIds[0],
    item: { id: 'after-compaction', type: 'agentMessage', phase: 'final_answer', text: 'Continued after compaction.' } } });
  complete(controller, session, fake.turnIds[0]);
  assert.ok(session.items.some(item => item.text === 'Continued after compaction.'));
  await controller.send({ id: session.id, text: 'Continue after compaction', mode: 'terra-light', task: 'off' });
  assert.equal(fake.calls.filter(call => call.method === 'thread/inject_items').length, 1, 'refresh rules once after compaction');
  complete(controller, session, fake.turnIds.at(-1));
  await controller.send({ id: session.id, text: 'Continue normally', mode: 'terra-light', task: 'off' });
  assert.equal(fake.calls.filter(call => call.method === 'thread/inject_items').length, 1, 'unchanged later turns still reuse the rules');
  complete(controller, session, fake.turnIds.at(-1));
});

test('a queued group message keeps its context, after earlier exchanges and before the current request', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  await controller.send({ id: session.id, text: 'First turn', mode: 'terra-light', task: 'off' });
  session.directContext = [{ question: 'Older question', answer: 'Older answer' }];
  const contextText = 'New group messages:\n[{"speaker":"User","text":"The build is green"}]\n\nCurrent user request:\n';
  assert.deepEqual(await controller.send({ id: session.id, text: 'Reply to the group', contextText, mode: 'terra-light', task: 'off' }), { queued: true });
  assert.equal(session.queue[0].contextText, contextText);
  complete(controller, session, fake.turnIds[0]);
  await until(() => fake.turnIds.length === 2);
  const text = fake.calls.filter(call => call.method === 'turn/start').at(-1).params.input[0].text;
  const order = ['Older question', 'The build is green', 'Reply to the group'].map(part => text.indexOf(part));
  assert.ok(order.every((index, i) => index >= 0 && (i === 0 || index > order[i - 1])), text);
  assert.equal(text.split('Current user request:').length - 1, 1);
  complete(controller, session, fake.turnIds.at(-1));
});

test('settle waits until queue delivery finishes', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  fake.beforeTurnResponse = async ({ id, params, emit }) => {
    if (id === 'turn-1') {
      await controller.send({ id: session.id, text: 'second', mode: 'terra-light' });
      await controller.send({ id: session.id, text: 'third', mode: 'terra-light' });
    }
    emit({ method: 'turn/completed', params: { threadId: params.threadId, turn: { id, status: 'completed' } } });
  };
  await controller.send({ id: session.id, text: 'first', mode: 'terra-light' });
  await flush();
  assert.equal(fake.turnIds.length, 3);
  assert.equal(session.queue.length, 0);
  assert.equal(controller.busy, null);
  assert.deepEqual(fake.calls.filter(call => call.method === 'turn/start').map(call => call.params.input[0].text.split('\n\n[Harness instruction]')[0]), ['first', 'second', 'third']);
  assert.equal(session.tasks.length, 3, 'queued messages retain default tracking');
});

function arm(controller, fake) {
  fake.process = { pid: 4242 };
  controller.lookupProcess = () => ({ pid: 4242, creationTime: 'created' });
}

function addCheck(controller, session, argv, extra = {}) {
  controller.checks(session.workspace, [{ name: extra.name || 'unit', argv, cwd: session.workspace, timeoutMs: extra.timeoutMs || 5000, readOnlySafe: extra.readOnlySafe !== false }]);
}

// Bounded by time, not ticks: the check gate's git reads are asynchronous and take tens of milliseconds to start.
async function until(fn) {
  for (const end = Date.now() + 3000; Date.now() < end;) {
    if (fn()) return;
    await new Promise(setImmediate);
  }
  if (!fn()) throw new Error('condition was not reached');
}

function reopen(controller, options) {
  const filename = controller.filename;
  const workspace = controller.data.settings.workspace;
  controller.close();
  return new Controller(filename, workspace, new Fake(), { cancel() {}, close() {}, jev: null, async choose() { throw new Error('unexpected route'); } }, options);
}

test('a worker cleanup still running when a turn ends (Cursor ends every turn with one) delays its checks and the next worker call instead of blocking them', async t => {
  const processTree = require('../src/process-tree.cjs');
  const { controller, fake } = await setup(t);
  arm(controller, fake);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access'); // checks run without an approval prompt
  controller.checks(session.workspace, [{ name: 'unit', argv: ['unit'], cwd: session.workspace, timeoutMs: 5000, readOnlySafe: true }]);
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  const cleanupFor = id => { processTree.cleanup.emit('pending', id); setTimeout(() => processTree.cleanup.emit('done', { id, remaining: [], record: null }), 150); };
  cleanupFor('cursor-1');
  complete(controller, session, fake.turnIds.at(-1));
  await controller.gateDone;
  assert.equal(session.tasks.at(-1).state, 'checks-passed', 'the checks ran once the cleanup was confirmed');
  assert.equal(fake.calls.filter(call => call.method === 'command/exec').length, 1);

  // Worker calls made without send (corrections, wiki maintenance) and compaction wait the same way.
  cleanupFor('cursor-2');
  await assert.doesNotReject(controller.submitWorker(session, controller.resolveWorker('terra-light'), 'follow-up', [], 'client-2', null));
  complete(controller, session, fake.turnIds.at(-1));
  await new Promise(resolve => setImmediate(resolve));
  cleanupFor('cursor-3');
  await assert.doesNotReject(controller.compact(session.id));
});

test('Stop pressed while a sent message or a compaction waits for a worker cleanup means neither starts', async t => {
  const processTree = require('../src/process-tree.cjs');
  const { controller, fake } = await setup(t);
  const session = controller.create();
  const starts = () => fake.calls.filter(call => call.method === 'turn/start').length;
  const settled = (promise, ms = 3000) => Promise.race([promise.then(() => 'done', error => error.message), new Promise(resolve => setTimeout(() => resolve('still running'), ms))]);

  processTree.cleanup.emit('pending', 'cursor-s');
  const sent = controller.send({ id: session.id, text: 'right after the previous Stop', mode: 'terra-light', task: 'off' });
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(controller.busy, session.id, 'the message is under way (so Stop applies to it) while it waits');
  await controller.stop();
  processTree.cleanup.emit('done', { id: 'cursor-s', remaining: [], record: null });
  assert.match(await settled(sent), /stopped before sending/);
  assert.equal(starts(), 0, 'no turn started');
  assert.equal(session.status, 'interrupted');
  assert.equal(controller.busy, null);

  // A turn to compact, then a compaction waiting the same way.
  session.queuePaused = false;
  await controller.send({ id: session.id, text: 'something to compact', mode: 'terra-light', task: 'off' });
  complete(controller, session, fake.turnIds.at(-1));
  await new Promise(resolve => setImmediate(resolve));
  processTree.cleanup.emit('pending', 'cursor-c');
  const compacting = controller.compact(session.id);
  await new Promise(resolve => setTimeout(resolve, 60));
  await controller.stop();
  processTree.cleanup.emit('done', { id: 'cursor-c', remaining: [], record: null });
  assert.match(await settled(compacting), /stopped before starting/);
  assert.equal(fake.calls.filter(call => call.method === 'thread/compact/start').length, 0, 'no compaction started');
  assert.equal(controller.busy, null);
});

test('work waits for a slow cleanup until it has finished, however long, and Stop ends the wait at once', async t => {
  const processTree = require('../src/process-tree.cjs');
  const { controller, fake } = await setup(t);
  const session = controller.create();
  processTree.cleanup.emit('pending', 'slow');
  const sent = controller.send({ id: session.id, text: 'after a slow cleanup', mode: 'terra-light', task: 'off' });
  await new Promise(resolve => setTimeout(resolve, 8000)); // longer than any fixed limit would allow
  assert.equal(fake.calls.filter(call => call.method === 'turn/start').length, 0, 'nothing starts while the cleanup runs');
  const stopped = Date.now();
  await controller.stop();
  await assert.rejects(sent, /stopped before sending/);
  assert.ok(Date.now() - stopped < 1000, 'Stop does not wait for the cleanup');
  processTree.cleanup.emit('done', { id: 'slow', remaining: [], record: null });
});

test('a cleanup that ends unconfirmed while work waits for it refuses that work: a turn, its checks, and both compactions', async t => {
  const processTree = require('../src/process-tree.cjs');
  const unconfirmed = id => ({ id, remaining: [-1], record: { id, tags: [], roots: [], children: [] } });
  const settled = promise => Promise.race([promise.then(() => 'done', error => error.message), new Promise(resolve => setTimeout(() => resolve('still running'), 3000))]);
  const count = (fake, method) => fake.calls.filter(call => call.method === method).length;
  const blockedMessage = /could not be confirmed stopped/;

  { // A sent message (every worker call goes through submitWorker).
    const { controller, fake } = await setup(t);
    const session = controller.create();
    processTree.cleanup.emit('pending', 'u-send');
    const sent = controller.send({ id: session.id, text: 'hello', mode: 'terra-light', task: 'off' });
    await new Promise(resolve => setTimeout(resolve, 60));
    processTree.cleanup.emit('done', unconfirmed('u-send'));
    assert.match(await settled(sent), blockedMessage);
    assert.equal(count(fake, 'turn/start'), 0);
    assert.equal(controller.busy, null);
  }
  { // The checks after a turn.
    const { controller, fake } = await setup(t);
    arm(controller, fake);
    const session = controller.create();
    controller.permissions(session.id, 'danger-full-access');
    controller.checks(session.workspace, [{ name: 'unit', argv: ['unit'], cwd: session.workspace, timeoutMs: 5000, readOnlySafe: true }]);
    await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
    processTree.cleanup.emit('pending', 'u-checks');
    complete(controller, session, fake.turnIds.at(-1));
    await new Promise(resolve => setTimeout(resolve, 60));
    processTree.cleanup.emit('done', unconfirmed('u-checks'));
    await controller.gateDone;
    assert.equal(count(fake, 'command/exec'), 0);
    assert.deepEqual([session.tasks.at(-1).state, session.tasks.at(-1).reason], ['blocked', 'stopped task cleanup unconfirmed']);
    assert.equal(controller.busy, null);
  }
  { // A Codex compaction.
    const { controller, fake } = await setup(t);
    const session = controller.create();
    await controller.send({ id: session.id, text: 'something to compact', mode: 'terra-light', task: 'off' });
    complete(controller, session, fake.turnIds.at(-1));
    await new Promise(resolve => setImmediate(resolve));
    processTree.cleanup.emit('pending', 'u-compact');
    const compacting = controller.compact(session.id);
    await new Promise(resolve => setTimeout(resolve, 60));
    processTree.cleanup.emit('done', unconfirmed('u-compact'));
    assert.match(await settled(compacting), blockedMessage);
    assert.equal(count(fake, 'thread/compact/start'), 0);
    assert.equal(controller.busy, null);
  }
  { // A Claude compaction.
    const { controller } = await setup(t);
    const session = controller.create();
    Object.assign(session, { activeProvider: 'claude-cli', claudeSessionId: 'claude-session', routes: [{ provider: 'claude-cli', model: 'opus' }] });
    controller.claude.status = { installed: true, loggedIn: true };
    let runs = 0;
    controller.claude.run = async () => { runs++; };
    processTree.cleanup.emit('pending', 'u-claude');
    const compacting = controller.compact(session.id);
    await new Promise(resolve => setTimeout(resolve, 60));
    processTree.cleanup.emit('done', unconfirmed('u-claude'));
    assert.match(await settled(compacting), blockedMessage);
    assert.equal(runs, 0);
    assert.equal(controller.busy, null);
  }
});

test('Stop pressed while checks wait for a worker cleanup cancels them', async t => {
  const processTree = require('../src/process-tree.cjs');
  const { controller, fake } = await setup(t);
  arm(controller, fake);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  controller.checks(session.workspace, [{ name: 'unit', argv: ['unit'], cwd: session.workspace, timeoutMs: 5000, readOnlySafe: true }]);
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  processTree.cleanup.emit('pending', 'cursor-a');
  complete(controller, session, fake.turnIds.at(-1));
  await new Promise(resolve => setTimeout(resolve, 60)); // the checks are waiting for the cleanup
  const interrupts = fake.calls.filter(call => call.method === 'turn/interrupt').length;
  await controller.stop();
  processTree.cleanup.emit('done', { id: 'cursor-a', remaining: [], record: null });
  await controller.gateDone;
  assert.equal(fake.calls.filter(call => call.method === 'command/exec').length, 0, 'no check ran');
  assert.deepEqual([session.tasks.at(-1).state, session.tasks.at(-1).reason], ['cancelled', 'cancelled']);
  assert.equal(fake.calls.filter(call => call.method === 'turn/interrupt').length, interrupts, 'nothing was running to interrupt');
  assert.equal(controller.busy, null);
});

test('Stop pressed while a CLI worker call waits for a worker cleanup means it is never launched', async t => {
  const processTree = require('../src/process-tree.cjs');
  const { controller } = await setup(t);
  const session = controller.create();
  let launched = 0;
  controller.claude.run = () => { launched++; return new Promise(() => {}); };
  controller.busy = session.id;
  processTree.cleanup.emit('pending', 'cursor-b');
  const call = controller.submitWorker(session, controller.claude.models[0], 'next', [], 'client-b', null);
  await new Promise(resolve => setTimeout(resolve, 60));
  await controller.stop();
  processTree.cleanup.emit('done', { id: 'cursor-b', remaining: [], record: null });
  const outcome = await Promise.race([call.then(() => 'sent', error => error.message), new Promise(resolve => setTimeout(() => resolve('still running'), 3000))]);
  assert.match(outcome, /stopped before sending/);
  assert.equal(launched, 0);
  assert.equal(session.status, 'interrupted');
  assert.equal(controller.busy, null);
});

test('after Stop, new work waits for worker cleanup and stays blocked, also across a restart, until it is confirmed', async t => {
  const processTree = require('../src/process-tree.cjs');
  const { controller, fake } = await setup(t);
  const session = controller.create();
  // A cleanup in flight: a message sent now waits for it instead of failing.
  processTree.cleanup.emit('pending', 'worker-1');
  assert.equal(controller.blockedReason(), null, 'a cleanup still running is not a block; the start of the work waits for it');
  const waiting = controller.send({ id: session.id, text: 'right after Stop', mode: 'terra-light', task: 'off' });
  setTimeout(() => processTree.cleanup.emit('done', { id: 'worker-1', remaining: [], record: null }), 100);
  await assert.doesNotReject(waiting);
  complete(controller, session, fake.turnIds.at(-1));
  await new Promise(resolve => setImmediate(resolve));

  // A cleanup that could not be confirmed: nothing new starts, it is kept on disk and retried.
  const record = { id: 'worker-2', tags: ['PHASMA_HARNESS_OWNER=gone-run/2\0'], roots: [{ pid: 999999, startedMs: Date.now() - 5000, endedMs: Date.now() - 4000 }], children: [] };
  processTree.cleanup.emit('done', { id: 'worker-2', remaining: [-1], record });
  await assert.rejects(controller.send({ id: session.id, text: 'blocked', mode: 'terra-light', task: 'off' }), /could not be confirmed stopped/);
  await assert.rejects(controller.compact(session.id), /could not be confirmed stopped/);
  assert.ok(controller.cleanupRetry, 'retried in the background');
  assert.deepEqual(readSessionData(controller.filename).workerCleanup.map(item => item.id), ['worker-2'], 'kept for a restart');
  const sweep = processTree.sweepRecord;
  processTree.sweepRecord = async record => ({ remaining: [-1], record });
  try { await controller.retryCleanupNow(); } finally { processTree.sweepRecord = sweep; }
  assert.match(controller.blockedReason(), /could not be confirmed stopped/, 'a failed retry keeps the block');

  // A restart finishes the cleanup first (its processes are gone), and work can start again.
  const restarted = reopen(controller);
  t.after(() => restarted.close());
  await restarted.initialize();
  assert.equal(restarted.data.workerCleanup, undefined);
  assert.equal(restarted.blockedReason(), null);
});

test('task mode is stored through queue edit and send', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  arm(controller, fake);
  await controller.send({ id: session.id, text: 'first', mode: 'terra-light', task: 'off' });
  const queued = await controller.send({ id: session.id, text: 'second', mode: 'terra-light' });
  assert.equal(queued.queued, true);
  const edited = await controller.queuedMessage(session.id, session.queue[0].id, 'edit');
  assert.equal(edited.task, 'on');
  await controller.send({ id: session.id, text: edited.text, images: edited.images, mode: edited.mode, task: edited.task });
  complete(controller, session, fake.turnIds[0]);
  await flush();
  assert.equal(session.tasks.length, 1);
  assert.equal(session.tasks[0].goal, 'second');
  complete(controller, session, fake.turnIds[1]);
  await controller.gateDone;
  assert.equal(session.tasks[0].state, 'not-checked');
});

test('default tracking ignores classification and legacy Auto tracks', async t => {
  const { controller, fake, smartRouter } = await setup(t);
  const session = controller.create();
  arm(controller, fake);
  smartRouter.choose = async () => ({ provider: 'codex', model: 'gpt-5.6-terra', effort: 'low', label: 'Terra', id: 'terra', images: true, assessment: { taskKind: 'implementation', workspaceRelevant: true, risk: 'medium', uncertainty: 'low' } });
  await controller.send({ id: session.id, text: 'fix the leak', mode: 'auto' });
  assert.equal(session.tasks.length, 1);
  complete(controller, session, fake.turnIds[0]);
  await controller.gateDone;
  smartRouter.choose = async () => ({ provider: 'codex', model: 'gpt-5.6-terra', effort: 'low', label: 'Terra', id: 'terra', images: true, assessment: { taskKind: 'general', workspaceRelevant: false, risk: 'low', uncertainty: 'low' } });
  await controller.send({ id: session.id, text: 'explain a mutex', mode: 'auto', task: 'auto' });
  assert.equal(session.tasks.length, 2);
  complete(controller, session, fake.turnIds[1]);
  await controller.gateDone;
});

test('router controls checks independently of task kind; manual and skip overrides remain safe', async t => {
  const { controller, fake, smartRouter } = await setup(t);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit-tests']);
  let needsChecks = false;
  smartRouter.choose = async (_text, context) => {
    assert.equal(context.configuredChecks[0].argv[0], 'unit-tests');
    return { ...controller.resolveWorker('terra-light'), assessment: { taskKind: 'review', needsChecks } };
  };
  const send = async (text, mode = 'auto', task = 'on') => {
    await controller.send({ id: session.id, text, mode, task });
    complete(controller, session, fake.turnIds.at(-1));
    await controller.gateDone;
  };
  await send('review without running tests');
  assert.equal(fake.calls.filter(c => c.method === 'command/exec').length, 0);
  assert.match(session.tasks.at(-1).summary, /Checks skipped by router/);
  needsChecks = true;
  await send('review and reproduce the failure');
  assert.equal(fake.calls.filter(c => c.method === 'command/exec').length, 1);
  assert.equal(session.tasks.at(-1).state, 'checks-passed');
  const tasks = session.tasks.length;
  await send('skip checks explicitly', 'auto', 'off');
  assert.equal(session.tasks.length, tasks);
  assert.equal(fake.calls.filter(c => c.method === 'command/exec').length, 1);
  await send('manual model with no routing assessment', 'terra-light');
  assert.equal(fake.calls.filter(c => c.method === 'command/exec').length, 2);
});

test('passed checks never start a wiki turn by themselves; a workspace docs/wiki only enables Propose', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit-tests']);
  fs.mkdirSync(path.join(session.workspace, 'docs', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(session.workspace, 'docs', 'wiki', 'index.md'), '# Wiki');
  await controller.send({ id: session.id, text: 'Implement retry handling', mode: 'terra-light' });
  complete(controller, session, fake.turnIds[0]);
  await controller.gateDone;
  const task = session.tasks[0];
  assert.equal(task.state, 'checks-passed');
  assert.ok(!task.wikiMaintenance);
  assert.equal(task.wikiAvailable, true);
  assert.equal(fake.turnIds.length, 1, 'no second, automatic turn');
  assert.equal(controller.busy, null);
  assert.equal(controller.maintainWiki, undefined);
});

test('configured checks stay frozen and hold the slot', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['first']);
  let release;
  fake.onExec = () => new Promise(resolve => { release = resolve; });
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  controller.checks(session.workspace, [{ name: 'other', argv: ['second'], cwd: session.workspace, timeoutMs: 5000, readOnlySafe: true }]);
  complete(controller, session, fake.turnIds[0]);
  // The check is running once its command starts (the gate first reads the diff asynchronously).
  await until(() => controller.gate && session.tasks[0].state === 'checking' && release);
  assert.equal(controller.busy, session.id);
  const other = controller.create();
  await assert.rejects(controller.send({ id: other.id, text: 'elsewhere', mode: 'terra-light' }), /still be running/);
  release({ exitCode: 0, stdout: 'ok', stderr: '' });
  await controller.gateDone;
  assert.equal(fake.calls.find(call => call.method === 'command/exec').params.command[0], 'first');
  assert.equal(Object.hasOwn(fake.calls.find(call => call.method === 'command/exec').params, 'outputBytesCap'), false);
  assert.equal(session.tasks[0].state, 'checks-passed');
  assert.equal(controller.busy, null);
});

test('Stop during approval, between checks, and before correction cancels the task', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  arm(controller, fake);
  addCheck(controller, session, ['one']);
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  complete(controller, session, fake.turnIds[0]);
  await until(() => controller.requests.size === 1);
  await controller.stop();
  await controller.gateDone;
  assert.equal(session.tasks[0].state, 'cancelled');
  assert.equal(fake.calls.some(call => call.method === 'command/exec'), false);
  assert.equal(session.queuePaused, true);

  const between = controller.create();
  controller.permissions(between.id, 'danger-full-access');
  controller.checks(between.workspace, [
    { name: 'one', argv: ['one'], cwd: between.workspace, timeoutMs: 5000, readOnlySafe: true },
    { name: 'two', argv: ['two'], cwd: between.workspace, timeoutMs: 5000, readOnlySafe: true },
  ]);
  let ran = 0;
  fake.onExec = () => {
    ran += 1;
    if (ran === 1) setImmediate(() => controller.stop());
    return { exitCode: 0, stdout: 'ok', stderr: '' };
  };
  await controller.send({ id: between.id, text: 'implement', mode: 'terra-light', task: 'on' });
  complete(controller, between, fake.turnIds.at(-1));
  await controller.gateDone;
  assert.equal(between.tasks[0].state, 'cancelled');
  assert.equal(between.tasks[0].attempts[0].results.length, 1);
  assert.equal(ran, 1);

  const correcting = controller.create();
  controller.permissions(correcting.id, 'danger-full-access');
  addCheck(controller, correcting, ['unit']);
  fake.onExec = () => {
    setImmediate(() => controller.stop());
    return { exitCode: 1, stdout: 'bad', stderr: '' };
  };
  await controller.send({ id: correcting.id, text: 'implement', mode: 'terra-light', task: 'on' });
  const turns = fake.turnIds.length;
  complete(controller, correcting, fake.turnIds.at(-1));
  await controller.gateDone;
  assert.equal(correcting.tasks[0].state, 'cancelled');
  assert.equal(fake.turnIds.length, turns);
});

test('a late check result after Stop does not change the cancelled task', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  let release;
  fake.onExec = () => new Promise(resolve => { release = resolve; });
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  await controller.send({ id: session.id, text: 'later', mode: 'terra-light', task: 'on' });
  complete(controller, session, fake.turnIds[0]);
  await until(() => release);
  await controller.stop();
  release({ exitCode: 0, stdout: 'late', stderr: '' });
  await controller.gateDone;
  assert.equal(session.tasks[0].state, 'cancelled');
  assert.equal(session.tasks[0].attempts[0].results.length, 0);
  assert.equal(session.queuePaused, true);
  assert.equal(session.queue[0].text, 'later');
  await controller.send({ id: session.id, text: 'next', mode: 'terra-light', task: 'off' });
  assert.equal(controller.busy, session.id);
  assert.equal(fake.turnIds.length, 2);
});

test('Stop during termination still cancels when terminate is confirmed', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  const holds = [];
  fake.onExec = () => { throw new Error('command/exec timed out'); };
  fake.onTerminate = () => new Promise(resolve => { holds.push(resolve); });
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  complete(controller, session, fake.turnIds[0]);
  await until(() => holds.length === 1);
  const stopping = controller.stop();
  await until(() => holds.length === 2);
  holds[1]();
  await stopping;
  holds[0]();
  await controller.gateDone;
  assert.equal(session.tasks[0].state, 'cancelled');
  assert.equal(controller.data.executionBlock, null);
});

test('an unconfirmed terminate blocks every session until the parent is gone', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  fake.onExec = () => { throw new Error('command/exec timed out'); };
  fake.onTerminate = () => { throw new Error('command/exec/terminate timed out'); };
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  complete(controller, session, fake.turnIds[0]);
  await controller.gateDone;
  assert.equal(session.tasks[0].state, 'blocked');
  assert.equal(session.tasks[0].reason, 'check execution unconfirmed');
  assert.equal(controller.data.executionBlock.creationTime, 'created');
  const other = controller.create();
  await assert.rejects(controller.send({ id: session.id, text: 'again', mode: 'terra-light' }), /still be running/);
  await assert.rejects(controller.send({ id: other.id, text: 'elsewhere', mode: 'terra-light' }), /still be running/);
  controller.acknowledgeTask(session.id, session.tasks[0].id);
  assert.equal(session.tasks[0].acknowledged, true);
  assert.ok(controller.data.executionBlock);
});

test('disconnect during a check blocks the task', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  let rejectExec;
  fake.onExec = () => new Promise((_resolve, reject) => { rejectExec = reject; });
  fake.onTerminate = () => { throw new Error('Codex disconnected'); };
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  complete(controller, session, fake.turnIds[0]);
  await until(() => rejectExec);
  fake.emit('disconnected', new Error('Codex disconnected'));
  rejectExec(new Error('Codex disconnected'));
  await controller.gateDone;
  assert.equal(session.tasks[0].state, 'blocked');
  assert.equal(session.tasks[0].reason, 'check execution unconfirmed');
  assert.ok(controller.data.executionBlock);
});

test('a check longer than 90 seconds uses its own deadline', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['slow'], { timeoutMs: 120000 });
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  complete(controller, session, fake.turnIds[0]);
  await controller.gateDone;
  const exec = fake.calls.find(call => call.method === 'command/exec');
  assert.equal(exec.params.timeoutMs, 120000);
  assert.equal(exec.timeout, 150000);
  assert.equal(session.tasks[0].state, 'checks-passed');
});

test('blocked checks keep failed output and do not correct', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.permissions(session.id, 'read-only');
  arm(controller, fake);
  addCheck(controller, session, ['unit'], { readOnlySafe: false });
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  complete(controller, session, fake.turnIds[0]);
  await controller.gateDone;
  assert.equal(session.tasks[0].state, 'blocked');
  assert.equal(session.tasks[0].attempts[0].results[0].detail, 'not read-only safe');

  const missing = controller.create();
  controller.permissions(missing.id, 'danger-full-access');
  controller.checks(missing.workspace, [
    { name: 'unit', argv: ['unit'], cwd: missing.workspace, timeoutMs: 5000, readOnlySafe: true },
    { name: 'missing', argv: ['missing'], cwd: missing.workspace, timeoutMs: 5000, readOnlySafe: true },
  ]);
  let ran = 0;
  fake.onExec = () => {
    ran += 1;
    if (ran === 1) return { exitCode: 1, stdout: 'boom', stderr: '' };
    throw new Error('failed to spawn command: program not found');
  };
  await controller.send({ id: missing.id, text: 'implement', mode: 'terra-light', task: 'on' });
  const turns = fake.turnIds.length;
  complete(controller, missing, fake.turnIds.at(-1));
  await controller.gateDone;
  assert.equal(missing.tasks[0].state, 'blocked');
  assert.equal(missing.tasks[0].attempts[0].results[0].stdout, 'boom');
  assert.match(missing.tasks[0].attempts[0].results[1].detail, /program not found/);
  assert.equal(fake.turnIds.length, turns);

  const offline = controller.create();
  controller.permissions(offline.id, 'danger-full-access');
  addCheck(controller, offline, ['unit']);
  await controller.send({ id: offline.id, text: 'implement', mode: 'terra-light', task: 'on' });
  controller.connection = 'disconnected';
  complete(controller, offline, fake.turnIds.at(-1));
  await controller.gateDone;
  assert.equal(offline.tasks[0].attempts.at(-1).results[0].detail, 'no provider connected');
});

test('one failed check corrects once on the same model and keeps the first evidence', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  let failed = true;
  fake.onExec = () => failed ? { exitCode: 1, stdout: 'boom', stderr: '' } : { exitCode: 0, stdout: 'ok', stderr: '' };
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  assert.equal(session.userTurn, true);
  const model = fake.calls.find(call => call.method === 'turn/start').params.model;
  complete(controller, session, fake.turnIds[0]);
  await until(() => fake.turnIds.length === 2);
  assert.equal(session.userTurn, false, 'a correction carrying check output is not the user’s turn, so it cannot change routines');
  const evidence = path.join(path.dirname(controller.filename), 'tool-outputs', session.id, `task-${session.tasks[0].id}.json`);
  const first = JSON.parse(fs.readFileSync(evidence, 'utf8'));
  assert.equal(first.attempts[0].results[0].status, 'failed');
  assert.equal(fake.calls.filter(call => call.method === 'turn/start').at(-1).params.model, model);
  assert.match(fake.calls.filter(call => call.method === 'turn/start').at(-1).params.input[0].text, /\[Router\]/);
  failed = false;
  complete(controller, session, fake.turnIds[1]);
  await controller.gateDone;
  assert.equal(session.tasks[0].state, 'checks-passed');
  assert.equal(JSON.parse(fs.readFileSync(evidence, 'utf8')).attempts.length, 2);
});

test('a corrected check failure becomes a lesson that the next task in the project carries, and corrections never do', async t => {
  const { controller, fake } = await setup(t);
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  controller.wikiStore = new WikiStore(path.join(path.dirname(controller.filename), 'wiki-store'));
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  // The reflection after each lesson runs on the router's model; answer it, and only it.
  const reflections = [];
  controller.effectiveRouter = () => controller.resolveWorker('terra-light');
  controller.smartRouter.complete = async request => {
    assert.ok(request.schema.properties.reflection, 'the only structured call here is the reflection');
    reflections.push(request);
    return { decision: { reflection: 'rule', rule: 'Make sure fetchUser is a function before wiring retries.', moment: 'TypeError: fetchUser is not a function', reason: 'The check called it.' } };
  };
  let failed = true;
  fake.onExec = () => failed ? { exitCode: 1, stdout: 'TypeError: fetchUser is not a function\n  at retry.js:12', stderr: '' } : { exitCode: 0, stdout: 'ok', stderr: '' };
  const inputs = () => fake.calls.filter(call => call.method === 'turn/start').map(call => call.params.input[0].text);

  await controller.send({ id: session.id, text: 'Add retry handling to fetchUser', mode: 'terra-light', task: 'on' });
  assert.doesNotMatch(inputs()[0], /Lessons Harness recorded/, 'no lessons exist yet');
  complete(controller, session, fake.turnIds[0]);
  await until(() => fake.turnIds.length === 2);
  assert.doesNotMatch(inputs()[1], /Lessons Harness recorded/, 'a correction never carries lessons');
  failed = false;
  complete(controller, session, fake.turnIds[1]);
  await controller.gateDone;
  assert.equal(session.tasks[0].state, 'checks-passed');

  const root = controller.wikiStore.location(session.workspace).root;
  const [lesson] = JSON.parse(fs.readFileSync(path.join(root, 'lessons.json'), 'utf8'));
  assert.equal(lesson.outcome, 'fixed');
  assert.equal(lesson.failures[0].check, 'unit');
  assert.match(lesson.failures[0].excerpt, /TypeError: fetchUser is not a function/);
  assert.match(fs.readFileSync(path.join(root, 'lessons.md'), 'utf8'), /Fixed after a correction/);
  // The richer fields come from what the real gate records on each attempt: its setup and the amendment count.
  const attempts = session.tasks[0].attempts;
  assert.deepEqual(attempts.map(attempt => attempt.amendments), [0, 0]);
  assert.ok(attempts.every(attempt => attempt.setup?.hash), 'both attempts carry a setup fingerprint');
  assert.deepEqual(lesson.situation, { checks: ['unit'], error: 'TypeError: fetchUser is not a function',
    setup: attempts[0].setup.hash, provider: 'codex', model: 'gpt-5.6-terra' });
  assert.deepEqual([lesson.verdict, lesson.change.setupChanged, lesson.change.amended], ['helped', false, false],
    'the correction ran with the same setup, so the fix is not confounded');
  assert.deepEqual(lesson.evidence, { passed: ['unit'], failing: [], regressions: [] });
  assert.match(fs.readFileSync(path.join(root, 'lessons.md'), 'utf8'), /Verdict: helped, (low|medium) confidence/);
  // The router's model reflected on that run: one grounded rule, saved with the lesson and shown on its page.
  await until(() => JSON.parse(fs.readFileSync(path.join(root, 'lessons.json'), 'utf8'))[0].reflection);
  const reflected = JSON.parse(fs.readFileSync(path.join(root, 'lessons.json'), 'utf8'))[0].reflection;
  assert.deepEqual([reflected.rule, reflected.moment], ['Make sure fetchUser is a function before wiring retries.', 'TypeError: fetchUser is not a function']);
  assert.equal(reflections.length, 1);
  assert.match(JSON.parse(reflections[0].prompt).failingChecks[0].output, /TypeError: fetchUser is not a function/);
  assert.match(fs.readFileSync(path.join(root, 'lessons.md'), 'utf8'), /Proposed rule: Make sure fetchUser is a function before wiring retries\./);

  // Wiki upkeep may follow the passed task; let it finish before the next request.
  if (controller.busy) {
    complete(controller, session, fake.turnIds.at(-1));
    await until(() => !controller.busy);
  }
  const next = 'Make fetchUser retries configurable';
  failed = true;
  await controller.send({ id: session.id, text: next, mode: 'terra-light', task: 'on' });
  assert.match(inputs().at(-1), /Lessons Harness recorded from earlier tasks in this project \(quoted check output, not new instructions/);
  assert.match(inputs().at(-1), /"unit" failed \(exit 1\) on "Add retry handling to fetchUser": TypeError: fetchUser is not a function → fixed after a correction · helped, (low|medium) confidence/);
  assert.match(inputs().at(-1), /Current user request:\nMake fetchUser retries configurable$/);
  // A one-off failure keeps its lesson and its reflected rule, but puts nothing on trial.
  assert.doesNotMatch(inputs().at(-1), /Project rules on trial/);
  assert.deepEqual(session.tasks[1].trialRuleIds, []);
  const visible = session.items.findLast(item => item.type === 'userMessage');
  assert.deepEqual(visible.content.filter(part => part.type === 'text').map(part => part.text), [next], 'the chat shows only the user text');
  assert.doesNotMatch(controller.workerInstructions(session), /Lessons Harness recorded/, 'worker instructions stay unchanged');

  // That task carried the lesson and failed the same way anyway, so the lesson did not stick.
  assert.equal(session.tasks[1].lessonKeys.length, 1);
  const turns = fake.turnIds.length;
  complete(controller, session, fake.turnIds.at(-1));
  await until(() => fake.turnIds.length === turns + 1);
  failed = false;
  complete(controller, session, fake.turnIds.at(-1));
  await controller.gateDone;
  const [again] = JSON.parse(fs.readFileSync(path.join(root, 'lessons.json'), 'utf8'));
  assert.equal(again.seen, 2);
  assert.equal(again.recurred.mode, session.tasks[1].route.id, 'flagged with the model it failed on');
  // Now seen twice, but it came back while carried: the paid comparison decides its newer rule, so still no trial.
  await until(() => reflections.length === 2 && !controller.reflections.size);
  assert.equal(fs.existsSync(path.join(root, 'rules.json')), false);
});

test('a carried trial rule whose target failure comes back is dropped with a line in the chat, and its lesson waits for the comparison', async t => {
  const { controller, fake } = await setup(t);
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  const trials = require('../src/trials.cjs');
  controller.wikiStore = new WikiStore(path.join(path.dirname(controller.filename), 'wiki-store'));
  controller.reflectOnLesson = () => null;
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  const root = controller.wikiStore.ensure(session.workspace).root;
  const error = 'TypeError: fetchUser is not a function';
  // As in real use: the failure was seen twice before its rule went on trial.
  const { lessonFromTask, recordLesson } = require('../src/lessons.cjs');
  const earlier = lessonFromTask({ id: 'earlier', goal: 'Add retry handling to fetchUser', corrections: 1, attempts: [
    { results: [{ name: 'unit', status: 'failed', exitCode: 1, stdout: `${error}\n  at retry.js:12`, stderr: '' }] },
    { results: [{ name: 'unit', status: 'passed', exitCode: 0, stdout: 'ok', stderr: '' }] }] }, 'checks-passed');
  recordLesson(root, earlier);
  recordLesson(root, earlier);
  trials.startTrial(root, { rule: 'Make sure fetchUser is a function before wiring retries.', lessonKey: `unit\n${error}`, check: 'unit', error,
    goal: 'Add retry handling to fetchUser', source: 'a reflection' });
  let failed = true;
  fake.onExec = () => failed ? { exitCode: 1, stdout: `${error}\n  at retry.js:12`, stderr: '' } : { exitCode: 0, stdout: 'ok', stderr: '' };

  await controller.send({ id: session.id, text: 'Make fetchUser retries configurable', mode: 'terra-light', task: 'on' });
  const first = fake.calls.filter(call => call.method === 'turn/start').at(-1).params.input[0].text;
  assert.match(first, /^Project rules on trial \(learned from earlier failures here; follow them unless they conflict with the request\):\n- Make sure fetchUser is a function before wiring retries\./);
  const turns = fake.turnIds.length;
  complete(controller, session, fake.turnIds.at(-1));
  await until(() => fake.turnIds.length === turns + 1);
  failed = false;
  complete(controller, session, fake.turnIds.at(-1));
  await controller.gateDone;

  assert.deepEqual(trials.readRules(root).map(rule => [rule.state, rule.carried.map(entry => entry.outcome)]), [['dropped', ['hit']]]);
  const notice = session.items.findLast(item => item.type === 'notice');
  assert.equal(notice.text, 'Dropped the trial rule "Make sure fetchUser is a function before wiring retries.": the failure it targets came back.');
  const [lesson] = JSON.parse(fs.readFileSync(path.join(root, 'lessons.json'), 'utf8'));
  assert.ok(lesson.recurred, 'carrying the trial rule counts as carrying its lesson');
});

test('a trial rule carried by three matching tasks that pass its check first time is kept in the kept rules, with an Undo', async t => {
  const { controller, fake } = await setup(t);
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  const trials = require('../src/trials.cjs');
  controller.wikiStore = new WikiStore(path.join(path.dirname(controller.filename), 'wiki-store'));
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  fake.onExec = () => ({ exitCode: 0, stdout: 'ok', stderr: '' });
  const root = controller.wikiStore.ensure(session.workspace).root;
  const rule = 'Make sure fetchUser is a function before wiring retries.';
  trials.startTrial(root, { rule, lessonKey: 'k', check: 'unit', error: 'TypeError: fetchUser is not a function', goal: 'Add retry handling to fetchUser', source: 'a reflection' });
  const inputs = () => fake.calls.filter(call => call.method === 'turn/start').map(call => call.params.input[0].text);

  for (const text of ['Add a timeout to fetchUser', 'Log fetchUser retries', 'Cache fetchUser results']) {
    await controller.send({ id: session.id, text, mode: 'terra-light', task: 'on' });
    assert.match(inputs().at(-1), /^Project rules on trial[^\n]*\n- Make sure fetchUser is a function before wiring retries\./);
    complete(controller, session, fake.turnIds.at(-1));
    await controller.gateDone;
    // Wiki upkeep may follow a passed task; let it finish before the next request.
    if (controller.busy) {
      complete(controller, session, fake.turnIds.at(-1));
      await until(() => !controller.busy);
    }
  }

  const [kept] = trials.readRules(root);
  assert.equal(kept.state, 'kept');
  assert.deepEqual(kept.carried.map(entry => entry.outcome), ['clean', 'clean', 'clean']);
  const file = path.join(root, 'kept-rules.md');
  assert.equal(fs.existsSync(path.join(session.workspace, 'PhasmaHarness.md')), false);
  assert.match(fs.readFileSync(file, 'utf8'), /## Rules Harness learned\n\n- Make sure fetchUser is a function before wiring retries\. \(kept \d{4}-\d\d-\d\d\)\n/);
  const notice = session.items.findLast(item => item.type === 'notice');
  assert.match(notice.text, /^Kept the rule "Make sure fetchUser is a function before wiring retries\." in Harness's kept rules for this workspace: 3 matching tasks passed its check/);

  controller.undoRule(session.id, notice.id);
  assert.equal(fs.readFileSync(file, 'utf8').includes(rule), false, 'Undo takes the line out again');
  assert.equal(trials.readRules(root)[0].state, 'removed');
  assert.throws(() => controller.undoRule(session.id, notice.id), /no rule change to undo/);
  await controller.send({ id: session.id, text: 'Add jitter to fetchUser retries', mode: 'terra-light', task: 'on' });
  assert.doesNotMatch(inputs().at(-1), /Project rules on trial/, 'a removed rule rides nothing');
});

test('a kept rule whose target failure comes back leaves the kept rules with a line in the chat; Undo puts it back for good', async t => {
  const { controller, fake } = await setup(t);
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  const trials = require('../src/trials.cjs');
  const { lessonFromTask, recordLesson } = require('../src/lessons.cjs');
  controller.wikiStore = new WikiStore(path.join(path.dirname(controller.filename), 'wiki-store'));
  controller.reflectOnLesson = () => null;
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  const root = controller.wikiStore.ensure(session.workspace).root;
  const error = 'TypeError: fetchUser is not a function';
  const rule = 'Make sure fetchUser is a function before wiring retries.';
  const line = `- ${rule} (kept 2026-10-21)`;
  const file = path.join(root, 'kept-rules.md');
  fs.writeFileSync(file, `# Project instructions\n\nStay small.\n\n${trials.HEADING}\n\n${line}\n`);
  trials.updateRules(root, records => records.push({ id: 'kept', rule, lessonKey: `unit\n${error}`, check: 'unit', error, goal: 'Add retry handling to fetchUser',
    source: 'a reflection', state: 'kept', since: 1, keptAt: Date.parse('2026-10-21T10:00:00Z'), line, carried: [] }));
  recordLesson(root, lessonFromTask({ id: 'earlier', goal: 'Add retry handling to fetchUser', corrections: 1, attempts: [
    { results: [{ name: 'unit', status: 'failed', exitCode: 1, stdout: `${error}\n  at retry.js:12`, stderr: '' }] },
    { results: [{ name: 'unit', status: 'passed', exitCode: 0, stdout: 'ok', stderr: '' }] }] }, 'checks-passed'));
  let failed = true;
  fake.onExec = () => failed ? { exitCode: 1, stdout: `${error}\n  at retry.js:12`, stderr: '' } : { exitCode: 0, stdout: 'ok', stderr: '' };

  await controller.send({ id: session.id, text: 'Make fetchUser retries configurable', mode: 'terra-light', task: 'on' });
  assert.deepEqual(session.tasks[0].keptRuleIds, ['kept'], 'Harness gives the task the kept rule');
  const turns = fake.turnIds.length;
  complete(controller, session, fake.turnIds.at(-1));
  await until(() => fake.turnIds.length === turns + 1);
  failed = false;
  complete(controller, session, fake.turnIds.at(-1));
  await controller.gateDone;

  assert.equal(trials.readRules(root)[0].state, 'rolled back');
  assert.equal(fs.readFileSync(file, 'utf8'), '# Project instructions\n\nStay small.\n', 'the line and its empty heading are gone');
  const notice = session.items.findLast(item => item.type === 'notice');
  assert.equal(notice.text, `Took the rule "${rule}" out of Harness's kept rules: the failure it targets came back after it was kept.`);
  const [lesson] = JSON.parse(fs.readFileSync(path.join(root, 'lessons.json'), 'utf8'));
  assert.ok(lesson.recurred, 'carrying the kept rule counts as carrying its lesson');

  controller.undoRule(session.id, notice.id);
  assert.ok(fs.readFileSync(file, 'utf8').includes(`${trials.HEADING}\n\n${line}\n`), 'Undo puts the same line back');
  assert.deepEqual([trials.readRules(root)[0].state, trials.readRules(root)[0].pinned], ['kept', true]);
  assert.throws(() => controller.undoRule(session.id, notice.id), /no rule change to undo/);
  // Wiki upkeep may follow the passed task; let it finish before the next request.
  if (controller.busy) {
    complete(controller, session, fake.turnIds.at(-1));
    await until(() => !controller.busy);
  }

  // The user deletes the line by hand: the next task finds it gone, and the rule is removed for good.
  fs.writeFileSync(file, '# Project instructions\n\nStay small.\n');
  await controller.send({ id: session.id, text: 'Log fetchUser retries', mode: 'terra-light', task: 'on' });
  assert.deepEqual(session.tasks.at(-1).keptRuleIds, []);
  assert.deepEqual([trials.readRules(root)[0].state, trials.readRules(root)[0].reason], ['removed', 'deleted from the kept rules by hand']);
});

test('a rule kept with ten rules already kept moves the one tasks matched least recently out, and Undo moves it back', async t => {
  const { controller, fake } = await setup(t);
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  const trials = require('../src/trials.cjs');
  controller.wikiStore = new WikiStore(path.join(path.dirname(controller.filename), 'wiki-store'));
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  fake.onExec = () => ({ exitCode: 0, stdout: 'ok', stderr: '' });
  const root = controller.wikiStore.ensure(session.workspace).root;
  const keptAt = Date.parse('2026-10-01T10:00:00Z');
  const lines = Array.from({ length: trials.MAX_KEPT }, (_, index) => `- Kept rule ${index}. (kept 2026-10-01)`);
  const file = path.join(root, 'kept-rules.md');
  fs.writeFileSync(file, `# Project instructions\n\nStay small.\n\n${trials.HEADING}\n\n${lines.join('\n')}\n`);
  trials.updateRules(root, records => records.push(...lines.map((line, index) => ({ id: `k${index}`, rule: `Kept rule ${index}.`, lessonKey: null, check: 'unit',
    error: 'x', goal: 'Unrelated docs work', source: 'a reflection', state: 'kept', since: 1, keptAt, lastMatchedAt: index === 6 ? 5 : 1000 + index, line, carried: [] }))));
  const winner = 'Make sure fetchUser is a function before wiring retries.';
  const started = trials.startTrial(root, { rule: winner, lessonKey: 'k', check: 'unit', error: 'TypeError: fetchUser is not a function',
    goal: 'Add retry handling to fetchUser', source: 'a reflection' });
  trials.updateRules(root, records => records.find(record => record.id === started.id).carried.push(
    { taskId: 'x1', at: 1, outcome: 'clean' }, { taskId: 'x2', at: 2, outcome: 'clean' }));

  await controller.send({ id: session.id, text: 'Cache fetchUser results', mode: 'terra-light', task: 'on' });
  assert.equal(session.tasks[0].keptRuleIds.length, trials.MAX_KEPT, 'the task carried all ten through the kept rules');
  complete(controller, session, fake.turnIds.at(-1));
  await controller.gateDone;

  const body = fs.readFileSync(file, 'utf8');
  assert.equal(body.includes('- Kept rule 6.'), false, 'the rule tasks matched least recently moved out');
  assert.match(body, /- Kept rule 9\. \(kept 2026-10-01\)\n- Make sure fetchUser is a function before wiring retries\. \(kept \d{4}-\d\d-\d\d\)\n$/);
  const moved = trials.readRules(root).find(record => record.id === 'k6');
  assert.deepEqual([moved.state, moved.onDemand, moved.line, moved.movedLine], ['kept', true, null, lines[6]]);
  const notice = session.items.findLast(item => item.type === 'notice');
  assert.equal(notice.text, `Kept the rule "${winner}" in Harness's kept rules for this workspace: 3 matching tasks passed its check without this failure. ` +
    '"Kept rule 6." moved out of the kept rules to keep them at 10; it is still used on the tasks it matches.');
  // Wiki upkeep may follow the passed task; let it finish before the next request.
  if (controller.busy) {
    complete(controller, session, fake.turnIds.at(-1));
    await until(() => !controller.busy);
  }
  await controller.send({ id: session.id, text: 'More unrelated docs work', mode: 'terra-light', task: 'on' });
  const first = fake.calls.filter(call => call.method === 'turn/start').at(-1).params.input[0].text;
  assert.match(first, /^Project rules learned from earlier failures here \(follow them unless they conflict with the request\):\n- Kept rule 6\.\n/,
    'a task it matches carries it in its first message');
  assert.ok(session.tasks.at(-1).keptRuleIds.includes('k6'));

  controller.undoRule(session.id, notice.id);
  const restored = fs.readFileSync(file, 'utf8');
  assert.equal(restored.includes(winner), false);
  assert.ok(restored.includes(`${lines[6]}\n`), 'Undo moves the displaced rule back');
  assert.deepEqual([trials.readRules(root).find(record => record.id === 'k6').onDemand, trials.readRules(root).find(record => record.id === started.id).state],
    [false, 'removed']);
});

test('an on-demand rule whose target failure comes back stops riding tasks, and Undo puts it back on demand for good', async t => {
  const { controller, fake } = await setup(t);
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  const trials = require('../src/trials.cjs');
  controller.wikiStore = new WikiStore(path.join(path.dirname(controller.filename), 'wiki-store'));
  controller.reflectOnLesson = () => null;
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  const root = controller.wikiStore.ensure(session.workspace).root;
  const error = 'TypeError: fetchUser is not a function';
  const rule = 'Make sure fetchUser is a function before wiring retries.';
  trials.updateRules(root, records => records.push({ id: 'od', rule, lessonKey: `unit\n${error}`, check: 'unit', error, goal: 'Add retry handling to fetchUser',
    source: 'a reflection', state: 'kept', onDemand: true, line: null, since: 1, keptAt: 1, carried: [] }));
  let failed = true;
  fake.onExec = () => failed ? { exitCode: 1, stdout: `${error}\n  at retry.js:12`, stderr: '' } : { exitCode: 0, stdout: 'ok', stderr: '' };

  await controller.send({ id: session.id, text: 'Make fetchUser retries configurable', mode: 'terra-light', task: 'on' });
  assert.deepEqual(session.tasks[0].keptRuleIds, ['od']);
  const turns = fake.turnIds.length;
  complete(controller, session, fake.turnIds.at(-1));
  await until(() => fake.turnIds.length === turns + 1);
  failed = false;
  complete(controller, session, fake.turnIds.at(-1));
  await controller.gateDone;

  assert.equal(trials.readRules(root)[0].state, 'rolled back');
  const notice = session.items.findLast(item => item.type === 'notice');
  assert.equal(notice.text, `Stopped adding the rule "${rule}" to the tasks it matches: the failure it targets came back after it was kept.`);
  controller.undoRule(session.id, notice.id);
  const [record] = trials.readRules(root);
  assert.deepEqual([record.state, record.onDemand, record.pinned, record.line], ['kept', true, true, null]);
});

// The chat scanner's fake models: the scan answers by its schema, the strongest model by its own. The checker is off until
// a model is picked in Settings.
function chatModels(controller, { flagFirst = true, verdict = 'avoided', escalation, checker = 'codex:gpt-5.6-sol:high', outcome = () => 'unclear' }) {
  const chatScan = require('../src/chat-scan.cjs');
  const calls = [];
  controller.effectiveRouter = () => controller.resolveWorker('terra-light');
  if (checker)
    controller.settings({ chatScanModel: checker });
  controller.smartRouter.complete = async (request, preset) => {
    // The same checker also reads each response as it ends; it accepts them all here.
    if (request.schema === require('../src/critique.cjs').SCHEMA)
      return { decision: { verdict: 'accept', findings: [] } };

    calls.push({ schema: request.schema, preset: preset.id, prompt: JSON.parse(request.prompt) });
    if (request.schema === chatScan.ESCALATION_SCHEMA)
      return { decision: escalation };

    const scans = calls.filter(call => call.schema === chatScan.SCAN_SCHEMA).length;
    const worthy = flagFirst && scans === 1;
    const carried = JSON.parse(request.prompt).carriedRules.map(rule => ({ id: rule.id, verdict }));
    return { decision: { worthy, problem: worthy ? 'Renamed a public export the user wanted kept' : '', moment: worthy ? 'keep the exported name fetchUser' : '', carried,
      outcome: outcome(scans) } };
  };
  return calls;
}

// One exchange in the chat: the user's message, the worker's reply, and the turn's end with its checks. Returns the
// worker's first message.
async function chatExchange(controller, fake, session, text, reply, mode = 'terra-light') {
  await controller.send({ id: session.id, text, mode, task: 'on' });
  const input = fake.calls.filter(call => call.method === 'turn/start').at(-1).params.input[0].text;
  const turn = fake.turnIds.at(-1);
  controller.notification({ method: 'item/completed', params: { threadId: session.threadId, turnId: turn,
    item: { id: `a-${turn}`, type: 'agentMessage', phase: 'final_answer', text: reply } } });
  complete(controller, session, turn);
  await controller.gateDone;
  // Wiki upkeep may follow a passed task; let it finish before the next request.
  if (controller.busy) {
    complete(controller, session, fake.turnIds.at(-1));
    await until(() => !controller.busy);
  }
  return input;
}

test('a correction in the chat becomes a trial rule through the scanner and the strongest model, and three avoided mistakes keep it', async t => {
  const { controller, fake } = await setup(t);
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  const trials = require('../src/trials.cjs');
  const chatScan = require('../src/chat-scan.cjs');
  controller.wikiStore = new WikiStore(path.join(path.dirname(controller.filename), 'wiki-store'));
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  fake.onExec = () => ({ exitCode: 0, stdout: 'ok', stderr: '' });
  const rule = 'Keep public export names unless the user asks to rename them.';
  const calls = chatModels(controller, { escalation: { decision: 'rule', text: rule, moment: 'keep the exported name fetchUser', reason: 'Callers import it.' } });
  const warnings = [];
  controller.log.warn = (...args) => warnings.push(args);
  // The test catalog has no measured scores; name the strongest model so the escalation's target shows.
  const big = controller.resolveWorker('claude-cli:opus');
  controller.strongestPreset = () => big;
  const root = controller.wikiStore.ensure(session.workspace).root;
  const scans = () => calls.filter(call => call.schema === chatScan.SCAN_SCHEMA).length;

  await chatExchange(controller, fake, session, 'Rename the loader module', 'Renamed fetchUser to loadUser, including the public export.');
  await chatExchange(controller, fake, session, 'No, keep the exported name fetchUser; callers import it by name.', 'Restored the export name.');
  await until(() => session.items.some(item => item.ruleNotice?.kind === 'trialStarted'));
  assert.deepEqual(calls.map(call => [call.schema === chatScan.SCAN_SCHEMA ? 'scan' : 'escalation', call.preset]), [['scan', 'codex:gpt-5.6-sol:high'], ['escalation', big.id]]);
  assert.equal(calls[0].prompt.nextUserMessage, 'No, keep the exported name fetchUser; callers import it by name.');
  const [record] = trials.readRules(root);
  assert.deepEqual([record.rule, record.state, record.check, record.source, record.goal], [rule, 'trial', null, 'the chat', 'Rename the loader module']);
  const notice = session.items.find(item => item.ruleNotice?.kind === 'trialStarted');
  assert.equal(notice.text, `Noticed: Renamed a public export the user wanted kept. Trying the rule "${rule}" on similar tasks.`);

  // Three matching tasks carry it; each is judged when the user's next message arrives, never by the project's checks.
  for (const text of ['Rename the loader tests', 'Move the loader module docs', 'Rename the loader config']) {
    const input = await chatExchange(controller, fake, session, text, 'Done, names kept.');
    assert.deepEqual(session.tasks.at(-1).trialRuleIds, [record.id]);
    assert.match(input, /^Project rules on trial[^\n]*\n- Keep public export names/);
  }
  await until(() => trials.readRules(root)[0].carried.length === 2 || warnings.length);
  assert.deepEqual(warnings, []);
  assert.deepEqual(trials.readRules(root)[0].carried.map(entry => entry.outcome), ['clean', 'clean'], 'two judged so far, none by the checks');
  await chatExchange(controller, fake, session, 'Thanks, that is all for now', 'Glad to help.');
  await until(() => trials.readRules(root)[0].state === 'kept');
  assert.equal(scans(), 5, 'each exchange scanned once');
  assert.match(fs.readFileSync(path.join(root, 'kept-rules.md'), 'utf8'), /- Keep public export names unless the user asks to rename them\. \(kept /);
  await until(() => session.items.some(item => item.ruleNotice?.kind === 'kept'));
  assert.equal(session.items.findLast(item => item.ruleNotice?.kind === 'kept').text, `Kept the rule "${rule}" in Harness's kept rules for this workspace: 3 matching tasks avoided this mistake.`);
  assert.throws(() => controller.undoRule(session.id, notice.id), /left its trial/);
});

test('a preset that passes a kind of work\'s checks first time more often than another becomes Auto\'s choice there, with Undo', async t => {
  const { controller, fake, smartRouter } = await setup(t);
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  const setups = require('../src/setups.cjs');
  controller.wikiStore = new WikiStore(path.join(path.dirname(controller.filename), 'wiki-store'));
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  let failing = 0;
  fake.onExec = () => failing-- > 0 ? { exitCode: 1, stdout: 'Error: off by one', stderr: '' } : { exitCode: 0, stdout: 'ok', stderr: '' };
  const contexts = [];
  let preset = 'terra-light';
  smartRouter.choose = async (_text, context) => {
    contexts.push(context.provenSetups);
    return { ...controller.resolveWorker(preset), source: 'model', reason: 'test', assessment: { taskKind: 'debugging', difficulty: 'low' } };
  };
  const task = async (text, { on, corrected = false }) => {
    preset = on;
    failing = corrected ? 1 : 0;
    await controller.send({ id: session.id, text, mode: 'auto', task: 'on' });
    complete(controller, session, fake.turnIds.at(-1));
    if (corrected) {
      const turns = fake.turnIds.length;
      await until(() => fake.turnIds.length === turns + 1);
      complete(controller, session, fake.turnIds.at(-1));
    }
    await controller.gateDone;
    // Wiki upkeep may follow a passed task; let it finish before the next request.
    if (controller.busy) {
      complete(controller, session, fake.turnIds.at(-1));
      await until(() => !controller.busy);
    }
  };

  for (let i = 0; i < 3; i++) {
    await task(`Fix crash ${i}`, { on: 'terra-light' });
    await task(`Fix bug ${i}`, { on: 'codex:gpt-5.6-sol:high', corrected: i === 0 });
  }
  assert.deepEqual([session.tasks[0].kind, session.tasks[0].difficulty], ['debugging', 'low']);
  const root = controller.wikiStore.ensure(session.workspace).root;
  assert.deepEqual(setups.readSetups(root).records.map(record => [record.preset, record.outcome]).slice(0, 2), [['terra-light', 'clean'], ['codex:gpt-5.6-sol:high', 'corrected']]);
  const notice = session.items.findLast(item => item.ruleNotice?.kind === 'setupPreferred');
  assert.match(notice.text, /^Auto now uses .+ for debugging work in this project: 3 of 3 tasks passed their checks first time/);

  await task('Fix crash again', { on: 'terra-light' });
  assert.deepEqual(contexts.at(-1), { debugging: 'terra-light' }, 'Auto routes with the preference');
  controller.undoRule(session.id, notice.id);
  await task('Fix one more crash', { on: 'terra-light' });
  assert.deepEqual(contexts.at(-1), {}, 'Undo drops it');
});

// Cascade: an Auto task whose checks still fail after its one correction goes, once, to the strongest offered worker.
async function cascadeSetup(t, failures) {
  const { controller, fake, smartRouter } = await setup(t);
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  controller.wikiStore = new WikiStore(path.join(path.dirname(controller.filename), 'wiki-store'));
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  let failing = failures;
  fake.onExec = () => failing-- > 0 ? { exitCode: 1, stdout: 'Error: off by one in pager.js', stderr: '' } : { exitCode: 0, stdout: 'ok', stderr: '' };
  smartRouter.choose = async () => ({ ...controller.resolveWorker('terra-light'), source: 'model', reason: 'test', assessment: { taskKind: 'debugging', difficulty: 'medium' } });
  // The test catalog has no measured scores; name the strongest model so the repair's target shows.
  const big = controller.resolveWorker('codex:gpt-5.6-sol:high');
  const asked = [];
  controller.repairPreset = (difficulty, images) => {
    asked.push([difficulty, images]);
    return big;
  };
  const turns = () => fake.calls.filter(call => call.method === 'turn/start');
  const settle = async count => {
    await until(() => fake.turnIds.length === count);
    complete(controller, session, fake.turnIds.at(-1));
  };
  return { controller, fake, session, big, asked, turns, settle };
}

test('checks still failing after one correction hand an Auto task once to the strongest worker, which proven setups count as the first worker failing', async t => {
  const { controller, session, big, asked, turns, settle } = await cascadeSetup(t, 2);
  const setups = require('../src/setups.cjs');

  await controller.send({ id: session.id, text: 'Fix the off-by-one in pager.js', mode: 'auto', task: 'on' });
  await settle(1);
  await settle(2);
  await settle(3);
  await controller.gateDone;

  const task = session.tasks[0];
  assert.equal(task.state, 'checks-passed');
  assert.deepEqual(asked, [['medium', false]]);
  assert.deepEqual([task.repair.from, task.repair.route.id], ['terra-light', big.id]);
  const repairTurn = turns()[2].params;
  assert.deepEqual([repairTurn.model, repairTurn.effort], [big.model, big.effort], 'the repair runs on the strongest worker');
  const repairText = repairTurn.input[0].text;
  assert.match(repairText, /You are taking it over/);
  assert.match(repairText, /Original request:\nFix the off-by-one in pager\.js/, 'the request rides along, since a Codex thread never sees CLI turns');
  assert.match(repairText, /off by one in pager\.js/);
  assert.equal(session.routes.at(-1).escalatedFrom, 'terra-light');
  assert.equal(session.job.worker.id, big.id, 'a follow-up on this task continues on the model that fixed it');

  const root = controller.wikiStore.ensure(session.workspace).root;
  assert.deepEqual(setups.readSetups(root).records.map(record => [record.preset, record.outcome]), [['terra-light', 'failed']]);
});

test('the cascade runs once, a manual pick escalates at its own effort, it can be turned off, and a failed repair says who took over', async t => {
  const auto = await cascadeSetup(t, 3);
  await auto.controller.send({ id: auto.session.id, text: 'Fix the pager', mode: 'auto', task: 'on' });
  await auto.settle(1);
  await auto.settle(2);
  await auto.settle(3);
  await auto.controller.gateDone;
  await flush();
  const task = auto.session.tasks[0];
  assert.equal(task.state, 'needs-you');
  assert.equal(auto.turns().length, 3, 'no second repair');
  assert.equal(task.summary, `Needs you: checks still failed after ${auto.big.label} took over`);

  const manual = await cascadeSetup(t, 2);
  const picked = manual.controller.resolveWorker('terra-light');
  await manual.controller.send({ id: manual.session.id, text: 'Fix the pager', mode: 'terra-light', task: 'on' });
  await manual.settle(1);
  await manual.settle(2);
  await manual.settle(3);
  await manual.controller.gateDone;
  await flush();
  assert.equal(manual.session.tasks[0].state, 'checks-passed');
  assert.equal(manual.turns()[2].params.model, manual.big.model, 'a manual pick escalates too');
  assert.deepEqual(manual.asked, [[picked.effort || 'medium', false]], 'at the manual pick\'s own effort');

  const off = await cascadeSetup(t, 2);
  off.controller.settings({ escalateFailedChecks: false });
  await off.controller.send({ id: off.session.id, text: 'Fix the pager', mode: 'auto', task: 'on' });
  await off.settle(1);
  await off.settle(2);
  await off.controller.gateDone;
  await flush();
  assert.equal(off.session.tasks[0].state, 'needs-you');
  assert.deepEqual([off.turns().length, off.asked], [2, []], 'Escalate failed checks off stops at Needs you');
  assert.equal(off.session.tasks[0].summary, 'Needs you: checks failed after one correction');
  assert.throws(() => off.controller.settings({ escalateFailedChecks: 'no' }), /Invalid on\/off setting/);
});

test('a repair takes the Escalation model as set, else the best measured model at the task\'s effort within the cap, and none without scores', async t => {
  const { controller } = await setup(t);
  // Settings → Escalation model: a pick is used as set and needs no scores.
  assert.throws(() => controller.settings({ escalationModel: 'no-such-model' }), /Unknown escalation model/);
  controller.settings({ escalationModel: 'codex:gpt-5.6-sol:high' });
  assert.equal(controller.repairPreset('low').id, 'codex:gpt-5.6-sol:high');
  controller.settings({ escalationModel: 'auto' });
  assert.equal(controller.repairPreset('high'), null, 'unmeasured: nothing says which model is stronger');

  const scores = { 'gpt-6-astra': 70, opus: 60 };
  controller.smartRouter.benchmarks = { catalog: list => list.map(p => ({ ...p, benchmarks: [{ source: 'aa-index', version: '4', harness: 'aa', score: scores[p.model] || 40 }] })) };
  const medium = controller.repairPreset('medium');
  assert.deepEqual([medium.model, medium.effort], ['gpt-6-astra', 'medium']);
  controller.data.settings.effortCap = 'medium';
  const capped = controller.repairPreset('xhigh');
  assert.deepEqual([capped.model, capped.effort], ['gpt-6-astra', 'medium'], 'the effort cap still holds');
  assert.equal(controller.strongestPreset().model, 'gpt-6-astra', 'the chat scanner\'s pick is unchanged');

  // A picked Escalation model holds above the cap too, and also writes chat rules; at a usage limit it gives way to the
  // Auto pick.
  controller.data.settings.escalationModel = 'codex:gpt-5.6-sol:high';
  assert.equal(controller.repairPreset('low').id, 'codex:gpt-5.6-sol:high');
  assert.equal(controller.strongestPreset().id, 'codex:gpt-5.6-sol:high');
  const limits = controller.limits;
  controller.limits = { limited: (_provider, model) => model === 'gpt-5.6-sol' };
  assert.equal(controller.repairPreset('medium').model, 'gpt-6-astra');
  controller.limits = limits;
});

// The chat checker: a Git workspace with one file the user had already changed before the task started (or a plain
// folder), the checker's verdicts in order, and a stronger worker a repair can take.
async function checkerSetup(t, { verdicts = [], checks = true, git = true } = {}) {
  const { controller, fake, smartRouter } = await setup(t);
  const { execFileSync } = require('node:child_process');
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  controller.wikiStore = new WikiStore(path.join(path.dirname(controller.filename), 'wiki-store'));
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-checker-'));
  t.after(() => fs.rmSync(repo, { recursive: true, force: true }));
  fs.writeFileSync(path.join(repo, 'pager.js'), 'function last(items) {\n  return items[items.length];\n}\n');
  fs.writeFileSync(path.join(repo, 'notes.js'), 'const draft = 1;\n');
  if (git) {
    const gitRun = (...args) => execFileSync('git', args, { cwd: repo, windowsHide: true });
    gitRun('init', '-q');
    gitRun('config', 'core.autocrlf', 'false');
    gitRun('config', 'user.email', 'test@example.invalid');
    gitRun('config', 'user.name', 'Test');
    gitRun('add', '.');
    gitRun('commit', '-q', '-m', 'start');
  }
  fs.writeFileSync(path.join(repo, 'notes.js'), 'const draft = 2; // USER_EDIT_BEFORE_TASK\n');

  const session = controller.create(repo);
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  if (checks)
    addCheck(controller, session, ['unit']);
  fake.onExec = () => ({ exitCode: 0, stdout: 'ok', stderr: '' });
  smartRouter.choose = async () => ({ ...controller.resolveWorker('terra-light'), source: 'model', reason: 'test', assessment: { taskKind: 'debugging', difficulty: 'medium' } });
  controller.settings({ chatScanModel: controller.chatScanChoices().find(p => p.model === 'gpt-5.6-terra').id });
  // The test catalog has no measured scores; name the stronger worker a repair takes.
  const big = controller.resolveWorker('codex:gpt-5.6-sol:high');
  controller.repairPreset = () => big;
  const looks = [];
  smartRouter.complete = async (request, choice) => {
    looks.push({ shown: JSON.parse(request.prompt), choice });
    return { decision: verdicts[looks.length - 1] || { verdict: 'accept', findings: [] } };
  };
  const turns = () => fake.calls.filter(call => call.method === 'turn/start');

  // Each turn ends with a final answer, so the checker has a reply to read.
  const settle = async count => {
    await until(() => fake.turnIds.length === count);
    const turn = fake.turnIds.at(-1);
    controller.notification({ method: 'item/completed', params: { threadId: session.threadId, turnId: turn,
      item: { id: `a-${turn}`, type: 'agentMessage', phase: 'final_answer', text: 'Fixed last() so it returns the final item.' } } });
    complete(controller, session, turn);
  };

  // One task: the worker's first turn fixes pager.js and adds a helper file, then `count` turns settle.
  const run = async (count, mode = 'auto') => {
    await controller.send({ id: session.id, text: 'Fix the off-by-one in last()', mode, task: 'on' });
    fs.writeFileSync(path.join(repo, 'pager.js'), 'function last(items) {\n  return items[items.length - 1];\n}\n');
    fs.writeFileSync(path.join(repo, 'helper.js'), 'module.exports = items => items.length === 0;\n');
    for (let turn = 1; turn <= count; turn++)
      await settle(turn);

    await controller.gateDone;
    await flush();
    return session.tasks[0];
  };
  return { controller, session, big, looks, turns, run };
}

const finding = (source, quote, problem = 'An empty list returns undefined instead of null.') => ({ source, quote, problem });

test('the chat checker reads a response without checks, sends grounded findings back to the same worker and accepts the revision', async t => {
  const { controller, looks, turns, run } = await checkerSetup(t, { checks: false, verdicts: [{ verdict: 'revise', findings: [
    finding('pager.js', 'return items[items.length - 1];'),
    finding('reply', 'returns the final item', 'The reply does not say what an empty list returns.'),
    finding('pager.js', 'return items.at(-1) ?? null;', 'Quotes code that is not there.'),
    finding('notes.js', 'const draft = 2; // USER_EDIT_BEFORE_TASK', 'Not part of this task.'),
  ] }] });
  const task = await run(2);

  assert.equal(looks.length, 2, 'the draft and the revision');
  assert.equal(looks[0].choice.id, controller.chatScanner().id, 'the chat checker picked in Settings looks');
  const shown = looks[0].shown;
  assert.deepEqual(shown.changes.map(change => change.file), ['pager.js', 'helper.js'], 'the task\'s own changes and the file it created');
  assert.doesNotMatch(JSON.stringify(shown), /USER_EDIT_BEFORE_TASK/, 'a change made before the task is not shown');
  assert.deepEqual([shown.request, shown.reply, shown.checks], ['Fix the off-by-one in last()', 'Fixed last() so it returns the final item.', 'none ran']);

  const revision = turns()[1].params;
  assert.equal(revision.model, 'gpt-5.6-terra', 'the worker that wrote the changes revises them');
  const text = revision.input[0].text;
  assert.match(text, /A checker model \(.+\) read your response/);
  assert.match(text, /pager\.js: An empty list returns undefined/);
  assert.match(text, /reply: The reply does not say/);
  assert.doesNotMatch(text, /Quotes code that is not there|Not part of this task/, 'ungrounded findings are dropped');

  assert.equal(task.state, 'not-checked');
  assert.deepEqual([task.critique.state, task.critique.revised, task.critique.looks], ['accepted', true, 2]);
  assert.equal(task.summary, `No checks configured · ${task.critique.model} accepted it after one revision`);
});

test('the chat checker\'s escalate hands an Auto task to a stronger worker with its findings, which proven setups count as the first worker failing', async t => {
  const setups = require('../src/setups.cjs');
  const flagged = { verdict: 'escalate', findings: [finding('reply', 'returns the final item', 'The request asked for an empty-list fix; the reply describes another change.')] };
  const { controller, session, big, looks, turns, run } = await checkerSetup(t, { checks: false, verdicts: [flagged] });
  const task = await run(2);

  const repair = turns()[1].params;
  assert.deepEqual([repair.model, repair.effort], [big.model, big.effort]);
  assert.match(repair.input[0].text, /a checker flagged its response\. You are taking it over/);
  assert.match(repair.input[0].text, /Original request:\nFix the off-by-one in last\(\)/);
  assert.match(repair.input[0].text, /reply: The request asked for an empty-list fix/);
  assert.equal(looks.length, 2, 'the stronger worker\'s response is checked too');
  assert.equal(task.summary, `No checks configured · ${task.critique.model} accepted it after ${big.label} took over`);

  const root = controller.wikiStore.ensure(session.workspace).root;
  assert.deepEqual(setups.readSetups(root).records.map(record => [record.preset, record.outcome]), [['terra-light', 'failed']],
    'never credited to the first worker');
});

test('the chat checker looks at most three times: a second revise escalates, an escalation that cannot run is the revise, a manual pick escalates at its own effort, and what is left is reported', async t => {
  const revise = { verdict: 'revise', findings: [finding('pager.js', 'return items[items.length - 1];')] };
  const escalate = { ...revise, verdict: 'escalate' };

  const twice = await checkerSetup(t, { verdicts: [revise, revise, revise] });
  const task = await twice.run(3);
  assert.deepEqual(twice.turns().map(turn => turn.params.model), ['gpt-5.6-terra', 'gpt-5.6-terra', twice.big.model],
    'the draft, its revision, then the stronger worker');
  assert.equal(twice.looks.length, 3);
  assert.equal(task.state, 'checks-passed', 'the checks still decide the state');
  assert.equal(task.summary, `Configured checks passed · ${task.critique.model} still found 1 problem: review the result`);

  const stuck = await checkerSetup(t, { verdicts: [escalate, escalate] });
  stuck.controller.repairPreset = () => null;
  const unscored = await stuck.run(2);
  assert.equal(stuck.turns().length, 2, 'no stronger worker: the escalation became the one revision');
  assert.deepEqual([stuck.looks.length, unscored.critique.state], [2, 'flagged']);

  const manual = await checkerSetup(t, { verdicts: [escalate] });
  const asked = [];
  manual.controller.repairPreset = effort => {
    asked.push(effort);
    return manual.big;
  };
  const picked = await manual.run(2, 'terra-light');
  assert.deepEqual(manual.turns().map(turn => turn.params.model), ['gpt-5.6-terra', manual.big.model], 'a manual pick escalates too');
  assert.deepEqual([asked, picked.critique.state], [[manual.controller.resolveWorker('terra-light').effort || 'medium'], 'accepted'], 'at its own effort');
});

test('each chat checker switch turns its step off: no look, no revise (straight to the stronger worker), no escalation (a revise, then a report)', async t => {
  const revise = { verdict: 'revise', findings: [finding('pager.js', 'return items[items.length - 1];')] };
  const escalate = { ...revise, verdict: 'escalate' };

  const noLook = await checkerSetup(t, { verdicts: [revise] });
  noLook.controller.settings({ checkResponses: false });
  const unchecked = await noLook.run(1);
  assert.deepEqual([noLook.looks.length, noLook.controller.baselines?.size || 0, unchecked.summary], [0, 0, 'Configured checks passed · coverage not assessed']);

  const noRevise = await checkerSetup(t, { verdicts: [revise] });
  noRevise.controller.settings({ checkerRevise: false });
  await noRevise.run(2);
  assert.deepEqual(noRevise.turns().map(turn => turn.params.model), ['gpt-5.6-terra', noRevise.big.model], 'findings go straight to the stronger worker');

  const noEscalate = await checkerSetup(t, { verdicts: [escalate, escalate] });
  noEscalate.controller.settings({ checkerEscalate: false });
  const reported = await noEscalate.run(2);
  assert.deepEqual([noEscalate.turns().map(turn => turn.params.model), reported.critique.state], [['gpt-5.6-terra', 'gpt-5.6-terra'], 'flagged']);

  const neither = await checkerSetup(t, { verdicts: [revise] });
  neither.controller.settings({ checkerRevise: false, checkerEscalate: false });
  const shown = await neither.run(1);
  assert.deepEqual([neither.turns().length, neither.looks.length, shown.critique.state], [1, 1, 'flagged'], 'with both off, problems are only shown');
  assert.throws(() => neither.controller.settings({ checkResponses: 'off' }), /Invalid on\/off setting/);
});

test('with the checker off, failing or quoting nothing it was shown, the work stays as it is; a plain folder is checked on its reply alone', async t => {
  const off = await checkerSetup(t);
  off.controller.settings({ chatScanModel: 'off' });
  const unchecked = await off.run(1);
  assert.deepEqual([off.looks.length, unchecked.summary], [0, 'Configured checks passed · coverage not assessed']);
  assert.equal(off.controller.baselines?.size || 0, 0, 'no snapshot without a checker');

  const failing = await checkerSetup(t);
  failing.controller.smartRouter.complete = async () => {
    throw new Error('provider unavailable');
  };
  const failed = await failing.run(1);
  assert.deepEqual([failing.turns().length, failed.critique.state, failed.summary], [1, 'failed', 'Configured checks passed · coverage not assessed']);

  const invented = await checkerSetup(t, { verdicts: [{ verdict: 'escalate', findings: [finding('pager.js', 'return items.at(-1) ?? null;')] }] });
  const kept = await invented.run(1);
  assert.equal(invented.turns().length, 1, 'an escalate quoting nothing it was shown is an accept');
  assert.deepEqual([kept.critique.state, kept.critique.dropped], ['accepted', 1]);

  const plain = await checkerSetup(t, { git: false, checks: false });
  const replyOnly = await plain.run(1);
  assert.deepEqual(plain.looks[0].shown.changes, [], 'no Git: the reply alone');
  assert.equal(plain.looks[0].shown.reply, 'Fixed last() so it returns the final item.');
  assert.equal(replyOnly.summary, `No checks configured · checked by ${replyOnly.critique.model}, no problems found`);
});

test('without checks, the chat checker reading your replies teaches Auto which preset gets a kind of work right first time', async t => {
  const { controller, fake, smartRouter } = await setup(t);
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  const setups = require('../src/setups.cjs');
  controller.wikiStore = new WikiStore(path.join(path.dirname(controller.filename), 'wiki-store'));
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  // Each scan reads the exchange before it: terra's three are accepted, sol's first is corrected.
  const replies = ['accepted', 'corrected', 'accepted', 'accepted', 'accepted', 'accepted'];
  chatModels(controller, { flagFirst: false, escalation: null, outcome: scans => replies[scans - 1] || 'unclear' });
  let preset;
  smartRouter.choose = async () => ({ ...controller.resolveWorker(preset), source: 'model', reason: 'test', assessment: { taskKind: 'debugging', difficulty: 'low' } });

  for (let i = 0; i < 3; i++) {
    preset = 'terra-light';
    await chatExchange(controller, fake, session, `Fix crash ${i}`, 'Fixed it.', 'auto');
    preset = 'codex:gpt-5.6-sol:high';
    await chatExchange(controller, fake, session, `Fix bug ${i}`, 'Fixed it.', 'auto');
  }
  await chatExchange(controller, fake, session, 'Thanks, all good', 'Glad to help.', 'auto');
  await until(() => session.items.some(item => item.ruleNotice?.kind === 'setupPreferred'));

  const root = controller.wikiStore.ensure(session.workspace).root;
  assert.deepEqual(setups.readSetups(root).records.slice(0, 2).map(record => [record.preset, record.outcome, record.source]),
    [['terra-light', 'clean', 'chat'], ['codex:gpt-5.6-sol:high', 'corrected', 'chat']]);
  const notice = session.items.findLast(item => item.ruleNotice?.kind === 'setupPreferred');
  assert.match(notice.text, /^Auto now uses .+ for debugging work in this project: 3 of 3 tasks needed no correction from you/);
});

test('tips are on unless turned off, and the setting takes only on or off', async t => {
  const { controller } = await setup(t);
  assert.equal(controller.data.settings.showTips, undefined, 'on by default');
  controller.settings({ showTips: false });
  assert.equal(controller.data.settings.showTips, false);
  assert.throws(() => controller.settings({ showTips: 'no' }), /Invalid tips setting/);
});

test('the chat checker is off until a model is picked, and Off turns it off again', async t => {
  const { controller, fake } = await setup(t);
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  controller.wikiStore = new WikiStore(path.join(path.dirname(controller.filename), 'wiki-store'));
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  const calls = chatModels(controller, { escalation: null, checker: null });
  assert.equal(controller.chatScanner(), null, 'off by default');
  assert.throws(() => controller.settings({ chatScanModel: 'auto' }), /Unknown chat checker model/, 'no Auto: the model is picked by hand');

  await chatExchange(controller, fake, session, 'Rename the loader module', 'Renamed it.');
  await chatExchange(controller, fake, session, 'No, keep the exported name fetchUser.', 'Restored it.');
  await flush();
  assert.deepEqual(calls, []);
  controller.settings({ chatScanModel: 'codex:gpt-5.6-sol:high' });
  assert.equal(controller.chatScanner().id, 'codex:gpt-5.6-sol:high');
  controller.settings({ chatScanModel: 'off' });
  assert.throws(() => controller.settings({ autoLowModel: 'no-such-model' }), /Unknown model for simple messages/);
  controller.settings({ autoLowModel: 'codex:gpt-5.6-sol:high' });
  assert.equal(controller.data.settings.autoLowModel, 'codex:gpt-5.6-sol:high', 'any worker model, picked by hand');
  controller.settings({ autoLowModel: 'auto' });
  await chatExchange(controller, fake, session, 'Thanks, that is all', 'Glad to help.');
  await flush();
  assert.deepEqual(calls, []);

  // A picked checker with Find rules from your replies off scans nothing either.
  controller.settings({ chatScanModel: 'codex:gpt-5.6-sol:high', scanReplies: false });
  await chatExchange(controller, fake, session, 'Rename the loader module again', 'Renamed it.');
  await chatExchange(controller, fake, session, 'No, keep the exported name fetchUser.', 'Restored it.');
  await flush();
  assert.deepEqual(calls, []);
});

test('a failover re-send is the same message again, not a reaction, so nothing is scanned', async t => {
  const { controller, fake } = await setup(t);
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  controller.wikiStore = new WikiStore(path.join(path.dirname(controller.filename), 'wiki-store'));
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  const calls = chatModels(controller, { escalation: null });

  await chatExchange(controller, fake, session, 'Rename the loader module', 'Renamed it.');
  await controller.send({ id: session.id, text: 'Rename the loader module', mode: 'terra-light', task: 'on', failover: true });
  await flush();
  assert.deepEqual(calls, []);
});

test('a note from the chat rides matching tasks as context, and Undo removes it', async t => {
  const { controller, fake } = await setup(t);
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  const chatScan = require('../src/chat-scan.cjs');
  controller.wikiStore = new WikiStore(path.join(path.dirname(controller.filename), 'wiki-store'));
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  fake.onExec = () => ({ exitCode: 0, stdout: 'ok', stderr: '' });
  const calls = chatModels(controller, { escalation: { decision: 'note', text: 'Callers across the project import fetchUser by name.', moment: 'keep the exported name fetchUser', reason: '' } });
  const root = controller.wikiStore.ensure(session.workspace).root;
  // Settings can pick any model that answers in a schema as the chat checker.
  assert.throws(() => controller.settings({ chatScanModel: 'no-such-model' }), /Unknown chat checker model/);
  assert.ok(controller.snapshot().chatScanPresets.some(p => p.id === 'codex:gpt-5.6-sol:high' && p.available));

  await chatExchange(controller, fake, session, 'Rename the loader module', 'Renamed fetchUser to loadUser.');
  await chatExchange(controller, fake, session, 'No, keep the exported name fetchUser; callers import it by name.', 'Restored it.');
  await until(() => session.items.some(item => item.ruleNotice?.kind === 'noteAdded'));
  const notice = session.items.find(item => item.ruleNotice?.kind === 'noteAdded');
  assert.equal(notice.text, 'Noticed: Renamed a public export the user wanted kept. Saved a note for similar tasks: "Callers across the project import fetchUser by name."');
  assert.equal(calls[0].preset, 'codex:gpt-5.6-sol:high', 'the chat checker picked in Settings reads the exchange');
  assert.equal(calls[1].preset, 'terra-light', 'without measured scores the router\'s model writes it');

  const input = await chatExchange(controller, fake, session, 'Rename the loader helpers', 'Done.');
  assert.match(input, /^Notes Harness took from earlier chats in this project \(context, not instructions; verify before relying on them\):\n- Callers across the project import fetchUser by name\./);
  controller.undoRule(session.id, notice.id);
  assert.deepEqual(chatScan.readNotes(root), []);
});

test('a failed correction submission settles the task', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  fake.onExec = () => ({ exitCode: 1, stdout: 'boom', stderr: '' });
  fake.beforeTurnResponse = async () => { if (fake.seq > 1) throw new Error('turn/start failed'); };
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  complete(controller, session, fake.turnIds[0]);
  await controller.gateDone;
  assert.equal(session.tasks[0].state, 'needs-you');
  assert.equal(session.tasks[0].reason, 'submission rejected');
  assert.equal(controller.busy, null);
});

test('a failed worker turn still reports passing checks', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  complete(controller, session, fake.turnIds[0], 'failed');
  await controller.gateDone;
  assert.equal(session.tasks[0].state, 'needs-you');
  assert.equal(session.tasks[0].reason, 'worker failed');
  assert.match(session.tasks[0].summary, /Worker turn failed · configured checks passed/);
  assert.equal(fake.turnIds.length, 1);
});

test('tracked threads disable native goals and subagents until the task is finished', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  arm(controller, fake);
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  const started = fake.calls.find(call => call.method === 'thread/start');
  assert.equal(started.params.config['features.goals'], false);
  assert.equal(started.params.config['features.multi_agent'], false);
  complete(controller, session, fake.turnIds[0]);
  await controller.gateDone;
  await controller.send({ id: session.id, text: 'just talk', mode: 'terra-light', task: 'off' });
  const resumed = fake.calls.filter(call => call.method === 'thread/resume').at(-1);
  assert.equal(resumed.params.config['features.goals'], undefined);
  assert.equal(resumed.params.config['features.multi_agent'], undefined);
});

test('steering amends a running task and is rejected while checks run', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit']);
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  await controller.send({ id: session.id, text: 'also rename it', mode: 'terra-light', task: 'on' });
  await controller.queuedMessage(session.id, session.queue[0].id, 'steer');
  assert.equal(session.tasks[0].amendments[0].text, 'also rename it');
  assert.equal(session.tasks[0].goal, 'implement');
  await controller.send({ id: session.id, text: 'steer again', mode: 'terra-light' });
  let release;
  fake.onExec = () => new Promise(resolve => { release = resolve; });
  complete(controller, session, fake.turnIds[0]);
  await until(() => session.tasks[0].state === 'checking' && release);
  await assert.rejects(controller.queuedMessage(session.id, session.queue.at(-1).id, 'steer'), /Checks are running/);
  release({ exitCode: 0, stdout: '', stderr: '' });
  await controller.gateDone;
});

test('restart marks unfinished tasks needs-you and does not rerun them', async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  session.tasks = ['running', 'checking', 'correcting'].map(state => ({
    id: `task-${state}`, state, goal: state, amendments: [], checks: [], attempts: [], corrections: 0, reason: null,
  }));
  controller.save();
  const next = reopen(controller);
  t.after(() => next.close());
  const tasks = next.data.sessions.find(item => item.id === session.id).tasks;
  assert.deepEqual(tasks.map(task => task.state), ['needs-you', 'needs-you', 'needs-you']);
  assert.match(tasks[0].reason, /worker turn/);
  assert.match(tasks[1].reason, /may still be running/);
  assert.match(tasks[2].reason, /correction/);
  assert.equal(next.client.calls.some(call => call.method === 'command/exec'), false);
});

test('a persisted execution block refuses every session and acknowledgement does not clear it', async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  session.tasks = [{ id: 'task-1', state: 'checking', goal: 'g', amendments: [], checks: [], attempts: [], corrections: 0, reason: null }];
  controller.data.executionBlock = { pid: 4242, creationTime: 'same', processId: 'p', sessionId: session.id, taskId: 'task-1', children: [] };
  controller.save();
  const killed = [];
  const next = reopen(controller, {
    lookupProcess: () => ({ pid: 4242, creationTime: 'same' }),
    killProcessTree: () => { killed.push(4242); return false; },
  });
  t.after(() => next.close());
  const restored = next.data.sessions.find(item => item.id === session.id);
  const other = next.create();
  await assert.rejects(next.send({ id: restored.id, text: 'again', mode: 'terra-light' }), /still be running/);
  await assert.rejects(next.send({ id: other.id, text: 'elsewhere', mode: 'terra-light' }), /still be running/);
  next.acknowledgeTask(restored.id, 'task-1');
  assert.equal(restored.tasks[0].acknowledged, true);
  assert.ok(next.data.executionBlock);
  assert.deepEqual(killed, [4242]);
});

test('a reused pid is not killed and a surviving child keeps the block', async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  controller.data.executionBlock = { pid: 4242, creationTime: 'original', processId: 'p', sessionId: session.id, taskId: 'task-1', children: [], runtime: { ...MEASURED_REAP } };
  controller.save();
  const killed = [];
  const reused = reopen(controller, {
    lookupProcess: () => ({ pid: 4242, creationTime: 'reused' }),
    killProcessTree: () => { killed.push(4242); return false; },
  });
  t.after(() => reused.close());
  assert.equal(reused.data.executionBlock, null);
  assert.deepEqual(killed, []);

  const again = await setup(t);
  const blocked = again.controller.create();
  again.controller.data.executionBlock = {
    pid: 50, creationTime: 'parent', processId: 'p', sessionId: blocked.id, taskId: 'task-2',
    children: [{ pid: 99, creationTime: 'child' }], runtime: { ...MEASURED_REAP },
  };
  again.controller.save();
  const childKilled = [];
  const kept = reopen(again.controller, {
    lookupProcess: pid => pid === 99 ? { pid: 99, creationTime: 'child' } : { status: 'absent' },
    killProcessTree: pid => { childKilled.push(pid); return false; },
  });
  t.after(() => kept.close());
  assert.equal(kept.data.executionBlock.children[0].pid, 99);
  assert.deepEqual(childKilled, []);
  await assert.rejects(kept.send({ id: blocked.id, text: 'no', mode: 'terra-light' }), /still be running/);
});

test('a failed process lookup or an unmeasured runtime keeps the execution block', async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  controller.data.executionBlock = { pid: 4242, creationTime: 'original', processId: 'p', sessionId: session.id, taskId: 'task-1', children: [], runtime: { ...MEASURED_REAP } };
  controller.save();
  const unknown = reopen(controller, { lookupProcess: () => ({ status: 'unknown' }), killProcessTree: () => { throw new Error('must not kill'); } });
  t.after(() => unknown.close());
  assert.equal(unknown.data.executionBlock.pid, 4242);

  unknown.data.executionBlock = { pid: 4242, creationTime: 'original', processId: 'p', sessionId: session.id, taskId: 'task-1', children: [], runtime: { ...MEASURED_REAP, codexVersion: '0.154.0' } };
  unknown.save();
  const other = reopen(unknown, { lookupProcess: () => ({ status: 'absent' }), killProcessTree: () => { throw new Error('must not kill'); } });
  t.after(() => other.close());
  assert.equal(other.data.executionBlock.codexVersion || other.data.executionBlock.runtime.codexVersion, '0.154.0');
});

test('failed tree termination cannot clear an unmeasured runtime when its parent disappears', async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  controller.data.executionBlock = { pid: 4242, creationTime: 'original', processId: 'p', sessionId: session.id, children: [], runtime: { ...MEASURED_REAP, codexVersion: '0.154.0' } };
  controller.save();
  let probes = 0;
  const next = reopen(controller, {
    lookupProcess: () => ++probes === 1 ? { pid: 4242, creationTime: 'original' } : { status: 'absent' },
    killProcessTree: () => false,
  });
  t.after(() => next.close());
  assert.ok(next.data.executionBlock);
});

test('Claude models become one worker per effort, like Codex; the chosen effort reaches the CLI run', async t => {
  const { controller } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  controller.claude.models = [
    { id: 'claude-cli:claude-opus-5-5', model: 'claude-opus-5-5', label: 'claude-opus-5-5', provider: 'claude-cli', effort: null, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], rank: 35, worker: true, router: true, images: true },
    { id: 'claude-cli:claude-haiku-4-5', model: 'claude-haiku-4-5', label: 'claude-haiku-4-5', provider: 'claude-cli', effort: null, efforts: [], rank: 35, worker: true, router: true, images: true },
  ];
  const claude = controller.catalog().filter(p => p.provider === 'claude-cli');
  assert.deepEqual(claude.map(p => p.id), ['claude-cli:claude-haiku-4-5', 'claude-cli:claude-opus-5-5:low', 'claude-cli:claude-opus-5-5:medium',
    'claude-cli:claude-opus-5-5:high', 'claude-cli:claude-opus-5-5:xhigh', 'claude-cli:claude-opus-5-5:max']);
  assert.equal(claude.find(p => p.id.endsWith(':xhigh')).label, 'claude-opus-5-5 · xhigh');
  assert.equal(claude[0].effort, null, 'a model without effort levels keeps one entry and the CLI default');
  assert.ok(controller.routerChoices().some(p => p.id === 'claude-cli:claude-opus-5-5:low'), 'the router can pick any effort');

  const session = controller.create();
  session.helperTools = false;
  let cli;
  controller.claude.run = async request => { cli = request; return { result: 'ok' }; };
  await controller.send({ id: session.id, text: 'go', mode: 'claude-cli:claude-opus-5-5:xhigh', task: 'off' });
  assert.equal(cli.effort, 'xhigh');
  assert.equal(typeof cli.approve, 'function');
  // A pre-change ID (no effort) still resolves: medium.
  assert.equal(controller.resolveWorker('claude-cli:claude-opus-5-5').id, 'claude-cli:claude-opus-5-5:medium');

  // Enabling is per model: disabling one variant disables every effort of that model.
  controller.providerSettings({ action: 'toggle', id: 'claude-cli:claude-opus-5-5', enabled: false });
  assert.deepEqual(controller.data.settings.disabledModels, ['claude-cli:claude-opus-5-5']);
  assert.equal(controller.catalog().filter(p => p.baseId === 'claude-cli:claude-opus-5-5' && p.enabled).length, 0);
  controller.providerSettings({ action: 'toggle', id: 'claude-cli:claude-opus-5-5:high', enabled: true });
  assert.deepEqual(controller.data.settings.disabledModels, []);
});

test('Claude selections saved before per-effort workers migrate: router to the cheapest effort, manual worker to the chosen one', async t => {
  const { controller } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  controller.claude.models = [{ id: 'claude-cli:claude-sonnet-5', model: 'claude-sonnet-5', label: 'claude-sonnet-5', provider: 'claude-cli', effort: null, efforts: ['low', 'medium', 'high'], rank: 35, worker: true, router: true, images: true }];
  Object.assign(controller.data.settings, { routerPreset: 'claude-cli:claude-sonnet-5', mode: 'claude-cli:claude-sonnet-5', claudeEfforts: { 'claude-sonnet-5': 'high' } });
  controller.migrateLegacyRouter();
  assert.equal(controller.data.settings.routerPreset, 'claude-cli:claude-sonnet-5:low');
  assert.equal(controller.data.settings.mode, 'claude-cli:claude-sonnet-5:high');
  assert.equal(controller.data.settings.claudeEfforts, undefined);
  controller.data.settings.mode = 'claude-cli:claude-sonnet-5';
  controller.migrateLegacyRouter();
  assert.equal(controller.data.settings.mode, 'claude-cli:claude-sonnet-5:medium', 'no earlier choice: medium');
});

test('Claude tool approvals use the Harness prompt and are withdrawn when the turn ends', async t => {
  const { controller } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const session = controller.create();
  session.helperTools = false;
  let second;
  controller.claude.run = async ({ approve }) => {
    const first = approve({ title: 'Allow Claude to use Bash?', rawInput: { tool: 'Bash', command: 'ninja' } });
    const [id, request] = [...controller.requests].find(([key]) => key.startsWith('cli-'));
    assert.equal(request.params.reason, 'Allow Claude to use Bash?');
    assert.match(request.params.command, /ninja/);
    controller.answer(id, { decision: 'accept' });
    assert.equal(await first, true);
    second = approve({ rawInput: { tool: 'WebFetch' } });
    assert.equal([...controller.requests.values()].at(-1).params.reason, 'Allow Claude tool once?');
    return { result: 'ok' };
  };
  await controller.send({ id: session.id, text: 'build', mode: 'claude-cli:sonnet', task: 'off' });
  assert.equal(await second, false, 'an unanswered approval is declined when the turn ends');
  assert.equal([...controller.requests.keys()].some(id => id.startsWith('cli-')), false);
});

test('Claude router fallback uses a discovered Haiku ID and keeps a working router', async t => {
  const { controller } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  controller.claude.models = ['claude-opus-5-5', 'claude-haiku-4-5', 'claude-sonnet-5'].map(model => ({ id: 'claude-cli:' + model, model, label: model, provider: 'claude-cli', effort: null, efforts: [], rank: 35, worker: true, router: true, images: true }));
  controller.data.settings.routerPreset = 'claude-cli:haiku';
  controller.claudeRouterFallback();
  assert.equal(controller.data.settings.routerPreset, 'claude-cli:claude-haiku-4-5');
  controller.data.settings.routerPreset = 'claude-cli:claude-sonnet-5';
  controller.claudeRouterFallback();
  assert.equal(controller.data.settings.routerPreset, 'claude-cli:claude-sonnet-5');
  controller.data.settings.disabledModels = ['claude-cli:claude-haiku-4-5', 'claude-cli:claude-sonnet-5'];
  controller.claudeRouterFallback();
  assert.equal(controller.data.settings.routerPreset, 'claude-cli:claude-opus-5-5');
});

test('router fallbacks prefer the cheapest Claude tier and migrate the old alias IDs', async t => {
  const { controller } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const models = ids => ids.map(model => ({ id: 'claude-cli:' + model, model, label: model, provider: 'claude-cli', effort: null, efforts: [], rank: 35, worker: true, router: true, images: true }));
  controller.claude.models = models(['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5']);
  controller.data.settings.routerPreset = 'claude-cli:gone';
  controller.claudeRouterFallback();
  assert.equal(controller.data.settings.routerPreset, 'claude-cli:claude-sonnet-5', 'Sonnet before the alphabetically first Fable');
  // Without ChatGPT, adoptRouter uses the same preference.
  controller.account = null; controller.connection = 'ready';
  controller.claude.models = models(['claude-fable-5-1', 'claude-haiku-4-5']);
  controller.data.settings.routerPreset = 'claude-cli:gone';
  controller.adoptRouter();
  assert.equal(controller.data.settings.routerPreset, 'claude-cli:claude-haiku-4-5');
  // A saved alias maps to a discovered model, or back to the Codex default when Claude is unavailable.
  controller.data.settings.routerPreset = 'claude-cli:haiku';
  controller.migrateLegacyRouter();
  assert.equal(controller.data.settings.routerPreset, 'claude-cli:claude-haiku-4-5');
  controller.claude.status = { installed: true, loggedIn: false };
  controller.data.settings.routerPreset = 'claude-cli:opus';
  controller.migrateLegacyRouter();
  assert.equal(controller.data.settings.routerPreset, 'codex:gpt-5.6-terra:low');
});

test('a withdrawn Claude approval disappears from the Harness, and late requests after the turn are declined', async t => {
  const { controller } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const session = controller.create();
  session.helperTools = false;
  let late;
  controller.claude.run = async ({ approve }) => {
    const cancel = new AbortController();
    const pending = approve({ title: 'Allow Claude to use Bash?' }, { signal: cancel.signal });
    assert.equal([...controller.requests.keys()].filter(id => id.startsWith('cli-')).length, 1);
    cancel.abort();
    assert.equal(await pending, false);
    assert.equal([...controller.requests.keys()].filter(id => id.startsWith('cli-')).length, 0);
    late = approve;
    return { result: 'ok' };
  };
  await controller.send({ id: session.id, text: 'x', mode: 'claude-cli:sonnet', task: 'off' });
  assert.equal(await late({ title: 'late' }), false);
  assert.equal([...controller.requests.keys()].some(id => id.startsWith('cli-')), false, 'no prompt for a finished turn');
});

test('a saved Claude router alias keeps its family when that family is discovered', async t => {
  const { controller } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const model = (id, aliases = []) => ({ id: 'claude-cli:' + id, model: id, label: id, provider: 'claude-cli', effort: null, efforts: [], aliases, rank: 35, worker: true, router: true, images: true });
  controller.claude.models = [model('claude-haiku-4-5', ['haiku']), model('claude-opus-5-5[1m]', ['opus[1m]']), model('claude-opus-5-5', ['opus']), model('claude-sonnet-5')];
  for (const [saved, expected] of [['claude-cli:opus', 'claude-cli:claude-opus-5-5'], ['claude-cli:sonnet', 'claude-cli:claude-sonnet-5'], ['claude-cli:haiku', 'claude-cli:claude-haiku-4-5']]) {
    controller.data.settings.routerPreset = saved;
    controller.migrateLegacyRouter();
    assert.equal(controller.data.settings.routerPreset, expected, saved);
  }
  // Without that family, the cheapest available Claude router is used.
  controller.claude.models = [model('claude-haiku-4-5'), model('claude-sonnet-5')];
  controller.data.settings.routerPreset = 'claude-cli:opus';
  controller.migrateLegacyRouter();
  assert.equal(controller.data.settings.routerPreset, 'claude-cli:claude-haiku-4-5');
});

test('Jev failure falls back to the smart router; a stop or a missing smart router does not', async t => {
  const { controller, fake, smartRouter } = await setup(t);
  controller.data.settings.routing = 'jev';
  const worker = { id: 'terra-light', provider: 'codex', model: 'gpt-5.6-terra', effort: 'low', label: 'Terra light', images: true, source: 'model', reason: 'Simple task.' };
  const calls = [];
  smartRouter.choose = async (_text, _session, _models, provider) => {
    calls.push(provider);
    if (provider === 'jev') throw new Error('Jev routing stopped: HTTP 503.');
    return worker;
  };
  const session = controller.create();
  await controller.send({ id: session.id, text: 'hello', mode: 'auto', task: 'off' });
  assert.deepEqual(calls, ['jev', 'smart']);
  assert.equal(fake.turnIds.length, 1, 'the worker turn started');
  assert.match(session.routes.at(-1).routerFallback, /Jev was unavailable \(Jev routing stopped: HTTP 503\.\)/);
  assert.match(session.routes.at(-1).reason, /smart router chose instead\. Simple task\./);
  complete(controller, session, session.turnId);
  await flush();

  // Stop during Jev routing: no second routing call.
  calls.length = 0;
  smartRouter.choose = async (_text, _session, _models, provider) => { calls.push(provider); throw Object.assign(new Error('Routing stopped.'), { name: 'AbortError' }); };
  await assert.rejects(controller.send({ id: session.id, text: 'again', mode: 'auto', task: 'off' }), /Routing stopped/);
  assert.deepEqual(calls, ['jev']);

  // No usable smart router: the Jev error is reported, nothing else is called.
  calls.length = 0;
  controller.data.settings.routerPreset = 'codex:missing:low';
  smartRouter.choose = async (_text, _session, _models, provider) => { calls.push(provider); throw new Error('Jev routing stopped: timeout.'); };
  await assert.rejects(controller.send({ id: session.id, text: 'third', mode: 'auto', task: 'off' }), /Jev routing stopped: timeout/);
  assert.deepEqual(calls, ['jev']);
});

test('disconnecting a provider in the Harness hides its models without signing the CLI out', async t => {
  const { controller, fake } = await setup(t);
  assert.ok(controller.account);
  assert.ok(controller.catalog().some(p => p.provider === 'codex'));
  controller.setProviderEnabled('codex', false);
  fake.calls.length = 0;
  await controller.refreshAccount();
  assert.equal(controller.account, null, 'ChatGPT is not used by the Harness');
  assert.deepEqual(controller.models, []);
  assert.equal(controller.catalog().some(p => p.provider === 'codex'), false, 'no ChatGPT models are listed');
  assert.equal(controller.codex.signedIn, true, 'the Codex CLI is still signed in');
  assert.equal(fake.calls.some(c => c.method === 'account/logout'), false);
  assert.equal(fake.calls.some(c => c.method === 'model/list'), false);
  controller.setProviderEnabled('codex', true);
  await controller.refreshAccount();
  assert.ok(controller.account, 'reconnecting reuses the existing login');
  assert.ok(controller.models.length);

  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const claude = controller.catalog().find(p => p.provider === 'claude-cli');
  assert.equal(controller.available(claude), true);
  controller.setProviderEnabled('claude-cli', false);
  assert.equal(controller.available(claude), false);
  assert.equal(controller.claude.status.loggedIn, true);

  controller.cursor.status = { installed: true, loggedIn: true };
  const cursor = { id: 'cursor-cli:auto:default', provider: 'cursor-cli', model: 'auto', enabled: true };
  assert.equal(controller.available(cursor), false, 'first run recorded Cursor as not in use; a later CLI login does not change that');
  controller.setProviderEnabled('cursor-cli', true);
  assert.equal(controller.available(cursor), true);
  controller.setProviderEnabled('cursor-cli', false);
  assert.equal(controller.available(cursor), false);
  assert.equal(controller.snapshot().cursor.enabled, false);
  assert.throws(() => controller.setProviderEnabled('nope', false), /Unknown provider/);
});

test('provider choices: first run records what is in use, later runs respect the saved choice', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-harness-providers-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'state.json');
  const start = async ({ claude, cursor }) => {
    const controller = new Controller(file, directory, new Fake(), { calls: [], cancel() {}, close() {}, jev: null });
    controller.claude.refresh = async () => (controller.claude.status = claude);
    controller.cursor.refresh = async () => (controller.cursor.status = cursor);
    await controller.initialize();
    controller.close();
    return controller;
  };
  // First run: ChatGPT (Fake is signed in) and Claude are signed in, Cursor is signed out.
  let c = await start({ claude: { installed: true, loggedIn: true }, cursor: { installed: true, loggedIn: false } });
  assert.deepEqual([c.data.settings.chatgptEnabled, c.data.settings.claudeEnabled, c.data.settings.cursorEnabled], [true, true, false]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).settings.chatgptEnabled, true, 'recorded on disk');

  // The user disconnects ChatGPT; after a restart with the Codex CLI still signed in it stays disconnected.
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  saved.settings.chatgptEnabled = false;
  fs.writeFileSync(file, JSON.stringify(saved));
  c = await start({ claude: { installed: true, loggedIn: true }, cursor: { installed: true, loggedIn: true } });
  assert.equal(c.account, null, 'a saved disconnect wins over the CLI login');
  assert.equal(c.data.settings.chatgptEnabled, false);
  assert.equal(c.data.settings.cursorEnabled, false, 'a later Cursor login does not override the recorded choice');

  // Unknown state (status could not be read) records nothing, so a transient failure cannot disable a provider.
  const fresh = path.join(directory, 'fresh.json');
  const d = new Controller(fresh, directory, new Fake(), { calls: [], cancel() {}, close() {}, jev: null });
  d.claude.refresh = async () => (d.claude.status = { installed: true, loggedIn: false, error: 'Could not read Claude Code login status.' });
  d.cursor.refresh = async () => (d.cursor.status = { installed: true, loggedIn: false, error: 'Cursor CLI timed out.' });
  await d.initialize();
  d.close();
  assert.equal(d.data.settings.claudeEnabled, undefined);
  assert.equal(d.data.settings.cursorEnabled, undefined);
});

test('an enabled Cursor model with reasoning levels becomes one worker per level; enabling stays per model', async t => {
  const { controller } = await setup(t);
  controller.cursor.status = { installed: true, loggedIn: true };
  controller.data.settings.cursorEnabled = true;
  controller.cursor.models = [{ id: 'grok-4.7', label: 'Grok 4.7', parameterized: true, efforts: ['low', 'high', 'xhigh'], effortOption: 'effort', effortNames: { xhigh: 'Extra High' } },
    { id: 'composer-2.5', label: 'Composer 2.5', parameterized: true }];
  controller.providerSettings({ action: 'enableDiscovered', provider: 'cursor-cli', model: 'grok-4.7', label: 'Grok 4.7' });
  controller.providerSettings({ action: 'enableDiscovered', provider: 'cursor-cli', model: 'composer-2.5', label: 'Composer 2.5' });
  const cursor = controller.catalog().filter(p => p.provider === 'cursor-cli');
  assert.deepEqual(cursor.map(p => [p.id, p.effort || null, p.label]), [
    ['cursor-cli:grok-4.7:low', 'low', 'Grok 4.7 · low'], ['cursor-cli:grok-4.7:high', 'high', 'Grok 4.7 · high'], ['cursor-cli:grok-4.7:xhigh', 'xhigh', 'Grok 4.7 · Extra High'],
    ['cursor-cli:composer-2.5:default', null, 'Composer 2.5']].sort((a, b) => cursor.findIndex(p => p.id === a[0]) - cursor.findIndex(p => p.id === b[0])));
  assert.ok(cursor.every(p => p.parameterized));
  assert.equal(cursor.find(p => p.id === 'cursor-cli:grok-4.7:xhigh').effortOption, 'effort');
  assert.equal(controller.resolveWorker('cursor-cli:grok-4.7:default').id, 'cursor-cli:grok-4.7:low', 'saved pre-level ID: medium, else the lowest');
  controller.providerSettings({ action: 'toggle', id: 'cursor-cli:grok-4.7:high', enabled: false });
  assert.equal(controller.catalog().filter(p => p.baseId === 'cursor-cli:grok-4.7:default' && p.enabled).length, 0);

  const session = controller.create();
  session.helperTools = false;
  controller.providerSettings({ action: 'toggle', id: 'cursor-cli:grok-4.7:default', enabled: true });
  let run;
  controller.cursor.run = async request => { run = request; return { result: 'ok' }; };
  await controller.send({ id: session.id, text: 'go', mode: 'cursor-cli:grok-4.7:xhigh', task: 'off' });
  assert.deepEqual([run.model, run.effort, run.effortOption, run.parameterized], ['grok-4.7', 'xhigh', 'effort', true]);
});

test('older Cursor variant entries fold into one entry per base model; no duplicates, saved parameters and level kept', async t => {
  const { controller } = await setup(t);
  controller.cursor.status = { installed: true, loggedIn: true };
  controller.data.settings.cursorEnabled = true;
  const entry = (model, label, enabled) => ({ id: `cursor-cli:${model}:default`, provider: 'cursor-cli', model, label, effort: null, rank: 40, enabled, worker: true, router: true, images: false, description: '' });
  // The real state after the previous version: old variant entries (unticked) plus the new base entries (ticked).
  controller.data.settings.providerModels = [
    entry('grok-4.7[context=256k,reasoning_effort=high,fast=true]', 'grok-4.7', false),
    entry('composer-2.5[fast=true]', 'composer-2.5', true),
    entry('grok-4.6[effort=high,fast=true]', 'grok-4.6', true),
    entry('grok-4.7', 'Grok 4.7', true),
    entry('old-model[x=1]', 'old-model', true),
  ];
  controller.data.settings.mode = 'cursor-cli:grok-4.6[effort=high,fast=true]:default';
  controller.cursor.models = [
    { id: 'grok-4.7', label: 'Grok 4.7', parameterized: true, efforts: ['low', 'medium', 'high', 'xhigh'], effortOption: 'reasoning_effort',
      parameters: { reasoning_effort: ['low', 'medium', 'high', 'xhigh'], context: ['128k', '256k'], fast: ['false', 'true'] } },
    { id: 'grok-4.6', label: 'Grok 4.6', parameterized: true, efforts: ['low', 'medium', 'high', 'xhigh'], effortOption: 'effort',
      parameters: { effort: ['low', 'medium', 'high', 'xhigh'], fast: ['false', 'true'] } },
    { id: 'composer-2.5', label: 'Composer 2.5', parameterized: true, parameters: { fast: ['false', 'true'] } },
  ];
  assert.equal(controller.migrateCursorEntries(), true);
  const saved = controller.data.settings.providerModels;
  assert.deepEqual(saved.map(e => [e.id, e.model, e.label, e.enabled]), [
    ['cursor-cli:grok-4.7:default', 'grok-4.7', 'Grok 4.7', true],
    ['cursor-cli:composer-2.5:default', 'composer-2.5', 'Composer 2.5', true],
    ['cursor-cli:grok-4.6:default', 'grok-4.6', 'Grok 4.6', true],
    ['cursor-cli:old-model[x=1]:default', 'old-model[x=1]', 'old-model', true],
  ], 'one entry per model; a model Cursor no longer lists is left as it was');
  const grok47 = saved[0], grok46 = saved[2], composer = saved[1];
  assert.deepEqual(grok47.cursorParameters, [], 'the enabled plain entry wins over the unticked variant');
  assert.deepEqual(grok46.cursorParameters, [{ id: 'fast', value: 'true' }]);
  assert.equal(grok46.cursorEffort, 'high');
  assert.deepEqual(composer.cursorParameters, [{ id: 'fast', value: 'true' }]);
  assert.ok(grok47.aliases.includes('cursor-cli:grok-4.7[context=256k,reasoning_effort=high,fast=true]:default'));
  assert.equal(controller.data.settings.mode, 'cursor-cli:grok-4.6:high', 'the saved manual selection follows, at its saved level');

  const ids = controller.catalog().filter(p => p.provider === 'cursor-cli').map(p => p.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate worker IDs');
  assert.deepEqual(ids.filter(id => id.startsWith('cursor-cli:grok-4.7')), ['cursor-cli:grok-4.7:low', 'cursor-cli:grok-4.7:medium', 'cursor-cli:grok-4.7:high', 'cursor-cli:grok-4.7:xhigh']);
  const high = controller.catalog().find(p => p.id === 'cursor-cli:grok-4.6:high');
  assert.deepEqual([high.model, high.parameterized, high.effortOption, high.parameters], ['grok-4.6', true, 'effort', [{ id: 'fast', value: 'true' }]]);
  assert.equal(controller.catalog().find(p => p.id === 'cursor-cli:composer-2.5:default').parameterized, true);
  // Old IDs (queued messages, task routes) still resolve.
  assert.equal(controller.resolveWorker('cursor-cli:grok-4.6[effort=high,fast=true]:default').id, 'cursor-cli:grok-4.6:high');
  assert.equal(controller.migrateCursorEntries(), false, 'idempotent');
});

test('"Allow for this session" remembers the exact Claude/Cursor action per session; Codex gets its native decision', async t => {
  const { controller, fake } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const session = controller.create();
  session.helperTools = false;
  const pending = () => [...controller.requests.values()].filter(r => r.id.startsWith('cli-'));
  let results = [];
  controller.claude.run = async ({ approve }) => {
    const bash = command => ({ title: 'Allow Claude to use Bash?', rawInput: { tool: 'Bash', command }, toolName: 'Bash', input: { command, description: 'varies' } });
    const first = approve(bash('ninja -C build'));
    const [request] = pending();
    assert.equal(controller.snapshot().requests.find(r => r.id === request.id).canAllowSession, true);
    controller.answer(request.id, { decision: 'acceptForSession' });
    results.push(await first);
    results.push(await approve({ ...bash('ninja -C build'), input: { command: 'ninja -C build', description: 'another wording' } }));
    const other = approve(bash('rm -rf build'));
    assert.equal(pending().length, 1, 'a different command still asks');
    controller.answer(pending()[0].id, { decision: 'decline' });
    results.push(await other);
    const plan = approve({ title: 'Approve Cursor plan', rawInput: {}, kind: 'plan' });
    assert.equal(controller.snapshot().requests.find(r => r.id === pending()[0].id).canAllowSession, false, 'plans are never remembered');
    assert.throws(() => controller.answer(pending()[0].id, { decision: 'acceptForSession' }), /Invalid approval/);
    controller.answer(pending()[0].id, { decision: 'accept' });
    results.push(await plan);
    const unnamed = approve({ title: 'Allow Gemini to run a tool?', toolName: null, input: {} });
    assert.equal(controller.snapshot().requests.find(r => r.id === pending()[0].id).canAllowSession, false,
      'a Gemini request without a tool name offers one-time approval only');
    assert.throws(() => controller.answer(pending()[0].id, { decision: 'acceptForSession' }), /Invalid approval/);
    controller.answer(pending()[0].id, { decision: 'accept' });
    results.push(await unnamed);
    return { result: 'ok' };
  };
  await controller.send({ id: session.id, text: 'build', mode: 'claude-cli:sonnet', task: 'off' });
  assert.deepEqual(results, [true, true, false, true, true]);
  assert.equal(pending().length, 0, 'the remembered action did not prompt');
  // Another session does not inherit it, and an access change clears it.
  assert.equal(controller.sessionAllows.get(session.id).size, 1);
  await controller.permissions(session.id, 'read-only');
  assert.equal(controller.sessionAllows.has(session.id), false);

  // Codex approvals pass acceptForSession through; permission grants become session-scoped.
  const responses = [];
  fake.respond = (id, result) => responses.push([id, result]);
  controller.requests.set('c1', { id: 'c1', method: 'item/commandExecution/requestApproval', params: { threadId: 't' } });
  controller.requests.set('p1', { id: 'p1', method: 'item/permissions/requestApproval', params: { threadId: 't', permissions: { network: true } } });
  assert.equal(controller.snapshot().requests.find(r => r.id === 'c1').canAllowSession, true);
  controller.answer('c1', { decision: 'acceptForSession' });
  controller.answer('p1', { decision: 'acceptForSession' });
  assert.deepEqual(responses, [['c1', { decision: 'acceptForSession' }], ['p1', { permissions: { network: true }, scope: 'session' }]]);
});

test('"Allow for this session" keys never cover more than the approved action', () => {
  const { sessionAllowKey } = require('../src/controller/shared.cjs');
  const claude = (toolName, input, extra = {}) => sessionAllowKey({ title: `Allow Claude to use ${toolName}?`, rawInput: { tool: toolName, ...input }, toolName, input, ...extra });
  // MCP and other tools repeat their whole input; the generic title is never the target.
  const merge = number => claude('mcp__github__merge_pull_request', { owner: 'o', repo: 'r', pull_number: number });
  assert.ok(merge(12));
  assert.notEqual(merge(12), merge(99));
  assert.equal(merge(12), claude('mcp__github__merge_pull_request', { pull_number: 12, repo: 'r', owner: 'o' }), 'key order does not matter');
  assert.notEqual(claude('mcp__shell__run', { command: 'git', args: ['status'] }), claude('mcp__shell__run', { command: 'git', args: ['push', '--force'] }));
  // An input field named "tool" cannot pose as another tool.
  assert.notEqual(claude('mcp__x__run', { tool: 'Bash', command: 'ls' }), claude('Bash', { command: 'ls' }));
  // Known tools key on their target; a missing target, plans and questions are not remembered.
  assert.equal(claude('Bash', { command: 'ls', description: 'a' }), claude('Bash', { command: 'ls', description: 'b' }));
  assert.notEqual(claude('Bash', { command: 'npm test' }), claude('Bash', { command: 'npm test', dangerouslyDisableSandbox: true }), 'leaving the sandbox is a different action');
  assert.equal(claude('Bash', { description: 'no command' }), null);
  assert.notEqual(claude('Read', { file_path: '/a' }), claude('Read', { file_path: '/a' }, { blockedPath: '/a' }));
  assert.notEqual(claude('Grep', { pattern: 'x', path: '/a' }), claude('Grep', { pattern: 'x', path: '/b' }));
  assert.equal(claude('ExitPlanMode', { plan: 'p' }), null);
  assert.equal(claude('AskUserQuestion', { questions: [] }), null);
  // Cursor: the title names the command or file; MCP arguments come from the content.
  const cursor = (kind, title, content) => sessionAllowKey({ toolCallId: String(Math.random()), title, kind, status: 'pending', content });
  assert.equal(cursor('execute', '`ls -la`'), cursor('execute', '`ls -la`'), 'the call id is not part of the key');
  assert.notEqual(cursor('execute', '`ls -la`'), cursor('execute', '`rm -rf /`'));
  const args = pull => [{ type: 'content', content: { type: 'text', text: JSON.stringify({ pull }) } }];
  assert.notEqual(cursor('other', 'github: merge_pull_request', args(12)), cursor('other', 'github: merge_pull_request', args(99)));
  assert.equal(cursor('execute', ''), null);
  assert.equal(sessionAllowKey({ toolCallId: 'x', kind: 'execute' }), null);
  assert.equal(cursor('other', 'Unknown operation'), null);
  // Mail through an MCP tool: a different recipient or body is a different action, for Claude and for Cursor.
  const mail = (to, body) => claude('mcp__mail__send_email', { to, subject: 'Build status', body });
  assert.notEqual(mail('team@example.com', 'green'), mail('boss@example.com', 'green'));
  assert.notEqual(mail('team@example.com', 'green'), mail('team@example.com', 'red'));
  const cursorMail = (to, body) => cursor('other', 'mail: send_email', [{ type: 'content', content: { type: 'text', text: JSON.stringify({ to, body }) } }]);
  assert.notEqual(cursorMail('team@example.com', 'green'), cursorMail('boss@example.com', 'red'));
  assert.equal(cursor('other', 'mail: send_email'), null, 'an MCP request without its arguments is never remembered');
  assert.equal(sessionAllowKey({ title: 'Approve Cursor plan', rawInput: {}, kind: 'plan' }), null);
});

test('usage limits: an Auto message fails over once to another provider; manual selections only report it', async t => {
  const { controller, fake, smartRouter } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const routed = [];
  // Prefer Claude while it is offered; the controller leaves limited providers out of the catalog.
  smartRouter.choose = async (_text, session) => {
    routed.push(session.routingCatalog.map(p => p.provider || 'codex'));
    const pick = session.routingCatalog.find(p => p.provider === 'claude-cli') || session.routingCatalog.find(p => (p.provider || 'codex') === 'codex');
    return { ...pick, source: 'model', reason: 'test' };
  };
  const reset = Date.now() + 3600 * 1000;
  let claudeRuns = 0;
  controller.claude.run = async () => {
    claudeRuns++;
    throw Object.assign(new Error("You've hit your session limit"), { limit: { until: reset, reason: 'limit', type: 'five_hour' } });
  };
  const session = controller.create();
  session.helperTools = false;
  await controller.send({ id: session.id, text: 'build it', mode: 'auto', task: 'off' });
  await flush();
  assert.equal(claudeRuns, 1);
  assert.equal(controller.limits.limited('claude-cli').until, reset);
  assert.ok(routed[1] && !routed[1].includes('claude-cli'), 'the retry was routed without Claude');
  assert.equal(fake.turnIds.length, 1, 'the retry went to Codex');
  assert.match(session.notice, /Claude reached its usage limit until .*another provider/);
  assert.equal(controller.snapshot().providerLimits['claude-cli'].until, reset);
  // The retried message hits Codex's limit too: reported, never retried again.
  controller.notification({ method: 'turn/completed', params: { threadId: session.threadId, turn: { id: fake.turnIds[0], status: 'failed', error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } } } });
  await flush();
  assert.equal(fake.turnIds.length, 1);
  assert.ok(controller.limits.limited('codex'));
  assert.match(session.error, /ChatGPT \(Codex\) reached its usage limit/);
  assert.equal((session.queue || []).length, 0);

  // Manual selection: no failover.
  controller.limits.clear('claude-cli'); controller.limits.clear('codex');
  await controller.send({ id: session.id, text: 'manual', mode: 'claude-cli:sonnet', task: 'off' });
  await flush();
  assert.equal(claudeRuns, 2);
  assert.equal((session.queue || []).length, 0);
  assert.match(session.error, /Claude reached its usage limit until/);

  // A later success on a provider clears its limit.
  controller.claude.run = async () => ({ result: 'ok' });
  await controller.send({ id: session.id, text: 'again', mode: 'claude-cli:sonnet', task: 'off' });
  assert.equal(controller.limits.limited('claude-cli'), null);
});

test('a router at its usage limit is replaced by another provider\'s router for that message', async t => {
  const { controller, smartRouter } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  controller.data.settings.routerPreset = 'claude-cli:haiku';
  const routers = [], catalogs = [];
  smartRouter.choose = async (_text, session) => {
    routers.push(session.routerChoice.id);
    catalogs.push(session.routingCatalog.map(p => p.provider || 'codex'));
    if (session.routerChoice.provider === 'claude-cli') throw Object.assign(new Error('Smart routing stopped: limit'), { limit: { until: null, reason: 'limit' }, limitProvider: 'claude-cli' });
    return { ...session.routingCatalog.find(p => (p.provider || 'codex') === 'codex'), source: 'model', reason: 'test' };
  };
  const session = controller.create();
  await controller.send({ id: session.id, text: 'hi', mode: 'auto', task: 'off' });
  assert.equal(routers[0], 'claude-cli:haiku');
  assert.ok(routers[1] && !routers[1].startsWith('claude-cli:'));
  assert.ok(catalogs[0].includes('claude-cli'), 'Claude workers were offered before the limit');
  assert.ok(!catalogs[1].includes('claude-cli'), 'the replacement router is not offered the limited Claude workers');
  assert.ok(controller.limits.limited('claude-cli'));
  assert.equal(controller.effectiveRouter().provider, 'codex', 'later messages skip the limited router directly');
  assert.equal(controller.data.settings.routerPreset, 'claude-cli:haiku', 'the saved router choice is kept');
});

test('usage limits: Stop is never overridden by the failover, and the refused attempt runs no checks', async t => {
  const { controller, fake, smartRouter } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  smartRouter.choose = async (_text, session) => ({ ...session.routingCatalog.find(p => (p.provider || 'codex') === 'codex'), source: 'model', reason: 'test' });
  const session = controller.create();
  session.helperTools = false;
  controller.data.settings.checks[session.workspace] = [{ id: 'c1', name: 'Build', argv: ['node', '--version'], cwd: session.workspace, timeoutMs: 10000, readOnlySafe: true }];
  let checks = 0;
  controller.runCheck = async () => { checks++; return { id: 'c1', name: 'Build', status: 'passed' }; };
  const limited = turn => controller.notification({ method: 'turn/completed', params: { threadId: session.threadId,
    turn: { id: turn, status: 'failed', error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' } } } });
  // Stopped while Codex was refusing the turn: reported, not resent.
  await controller.send({ id: session.id, text: 'build it', mode: 'auto', task: 'on' });
  await controller.stop();
  limited(fake.turnIds[0]);
  await flush(); await controller.gateDone; await flush();
  assert.equal(fake.turnIds.length, 1);
  assert.equal((session.queue || []).length, 0, 'nothing was queued after Stop');
  assert.match(session.error, /usage limit/);
  // Not stopped: the refused attempt ends without running checks, and the message goes to Claude.
  controller.limits.clear('codex');
  let claudeRuns = 0;
  controller.claude.run = async () => { claudeRuns++; return { result: 'done' }; };
  smartRouter.choose = async (_text, session) => ({ ...(session.routingCatalog.find(p => (p.provider || 'codex') === 'codex') || session.routingCatalog.find(p => p.provider === 'claude-cli')), source: 'model', reason: 'test' });
  await controller.send({ id: session.id, text: 'build again', mode: 'auto', task: 'on' });
  limited(fake.turnIds[1]);
  await flush(); await controller.gateDone; await flush(); await controller.gateDone; await flush();
  const refused = session.tasks.find(task => task.goal === 'build again' && task.reason === 'usage limit');
  assert.equal(refused?.state, 'needs-you');
  assert.equal(claudeRuns, 1, 'the message was resent to Claude');
  assert.equal(checks, 1, 'only the resent turn ran the configured check');
});

test('a Claude Opus weekly limit leaves the other Claude models usable, and only an Opus success lifts it', async t => {
  const { controller, smartRouter } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const routed = [];
  smartRouter.choose = async (_text, session) => {
    routed.push(session.routingCatalog.filter(p => p.provider === 'claude-cli').map(p => p.model));
    return { ...(session.routingCatalog.find(p => p.model === 'opus') || session.routingCatalog.find(p => p.model === 'sonnet')), source: 'model', reason: 'test' };
  };
  const models = [];
  controller.claude.run = async ({ model }) => {
    models.push(model);
    if (model === 'opus') throw Object.assign(new Error('Opus limit'), { limit: { until: Date.now() + 3600000, reason: 'limit', type: 'seven_day_opus', family: 'opus' } });
    return { result: 'ok' };
  };
  const session = controller.create();
  session.helperTools = false;
  await controller.send({ id: session.id, text: 'review', mode: 'auto', task: 'off' });
  await flush();
  assert.deepEqual(models, ['opus', 'sonnet'], 'the retry stayed on Claude with another model');
  assert.ok(!routed[1].includes('opus') && routed[1].includes('sonnet'));
  assert.match(session.notice, /Claude Opus reached its usage limit/);
  assert.ok(controller.limits.limited('claude-cli', 'opus'), 'a Sonnet success does not lift the Opus limit');
  assert.equal(controller.limits.limited('claude-cli', 'sonnet'), null);
});

test('Compare with Jev only logs Jev\'s pick next to the model that ran, one comparison at a time', async t => {
  const { controller, fake, smartRouter } = await setup(t);
  const records = [];
  controller.jevCompare = { record: entry => records.push(entry), summary: () => ({ compared: records.length }) };
  smartRouter.choose = async (_text, session) => ({ ...session.routingCatalog.find(p => p.model === 'gpt-5.6-terra' && p.effort === 'low'), source: 'model', reason: 'test' });
  const shadows = [];
  let release;
  smartRouter.shadowJev = (text, context, signal) => {
    shadows.push({ text, items: context.items.map(item => item.content?.[0]?.text), catalog: context.routingCatalog.length, signal });
    return new Promise(resolve => { release = () => resolve({ id: 'codex:gpt-6-astra:high', provider: 'codex', model: 'gpt-6-astra', effort: 'high', confidence: 0.7, costUsd: 0.0001 }); });
  };
  const session = controller.create();
  // Off by default, and it needs a Jev key.
  await controller.send({ id: session.id, text: 'first', mode: 'auto', task: 'off' });
  complete(controller, session, fake.turnIds[0]); await flush();
  assert.equal(shadows.length, 0);
  assert.throws(() => controller.settings({ jevCompare: true }), /Jev API key/);
  smartRouter.jev = { configured: true };
  controller.settings({ jevCompare: true });
  // A saved "on" never blocks saving settings when the key file is gone.
  smartRouter.jev = { configured: false };
  controller.settings({ jevCompare: true, fontScale: 115 });
  assert.equal(controller.data.settings.fontScale, 115);
  smartRouter.jev = { configured: true };
  await controller.send({ id: session.id, text: 'second', mode: 'auto', task: 'off' });
  assert.equal(shadows.length, 1);
  assert.deepEqual(shadows[0].items, ['first'], 'Jev sees the conversation as it was before this message');
  assert.ok(shadows[0].catalog > 0);
  assert.equal(session.routes.at(-1).model, 'gpt-5.6-terra', 'the routed model runs unchanged');
  complete(controller, session, fake.turnIds[1]); await flush();
  // While a comparison is in flight the next message skips it; no calls pile up.
  await controller.send({ id: session.id, text: 'third', mode: 'codex:gpt-5.6-sol:high', task: 'off' });
  complete(controller, session, fake.turnIds[2]); await flush();
  assert.equal(shadows.length, 1);
  release(); await flush();
  assert.deepEqual(records[0].used, { id: session.routes[1].id, provider: 'codex', model: 'gpt-5.6-terra', effort: 'low', source: 'router' });
  assert.equal(records[0].jev.model, 'gpt-6-astra');
  assert.ok(!JSON.stringify(records).includes('second'), 'no message text is logged');
  // Manual choices are compared too; with Jev as the router there is nothing to compare.
  await controller.send({ id: session.id, text: 'fourth', mode: 'codex:gpt-5.6-sol:high', task: 'off' });
  release(); await flush();
  assert.equal(records[1].used.source, 'manual');
  complete(controller, session, fake.turnIds[3]); await flush();
  controller.data.settings.routing = 'jev';
  await controller.send({ id: session.id, text: 'fifth', mode: 'codex:gpt-5.6-sol:high', task: 'off' });
  assert.equal(shadows.length, 2);
  assert.deepEqual(controller.snapshot().jev.compare, { compared: 2 });
  // Turning it off stops a comparison in flight without logging it.
  complete(controller, session, fake.turnIds[4]); await flush();
  controller.data.settings.routing = 'smart';
  await controller.send({ id: session.id, text: 'sixth', mode: 'auto', task: 'off' });
  const signal = shadows.at(-1).signal;
  controller.settings({ jevCompare: false });
  assert.equal(signal.aborted, true);
});

test('one model per task: the task, its worker and the worker\'s reported status follow each turn', async t => {
  const { controller, fake, smartRouter } = await setup(t);
  const terra = id => controller.catalog().find(p => p.id === id);
  let next;
  smartRouter.choose = async () => ({ ...next, source: 'model', reason: 'test' });
  const session = controller.create();
  const reply = (turn, text) => {
    controller.notification({ method: 'item/completed', params: { threadId: session.threadId, turnId: turn, item: { id: `a-${turn}`, type: 'agentMessage', phase: 'final_answer', text } } });
    complete(controller, session, turn);
  };
  // The first message starts a task on the routed worker; the worker's last line sets its status.
  next = { ...terra('codex:gpt-5.6-terra:low'), sameTask: false };
  await controller.send({ id: session.id, text: 'Fix the shadow map flicker', mode: 'auto', task: 'off' });
  reply(fake.turnIds[0], 'Which cascade flickers?\n\n[task: needs-input]');
  await flush();
  assert.deepEqual({ ...session.job, startedAt: 0, updatedAt: 0 }, { goal: 'Fix the shadow map flicker', startedAt: 0, updatedAt: 0, status: 'needs-input', turns: 1,
    worker: { id: 'codex:gpt-5.6-terra:low', provider: 'codex', model: 'gpt-5.6-terra', effort: 'low', label: terra('codex:gpt-5.6-terra:low').label } });
  // A reply continues it (the router said so); no status line means "unknown".
  next = { ...terra('codex:gpt-5.6-terra:low'), sameTask: true };
  await controller.send({ id: session.id, text: 'The second one', mode: 'auto', task: 'off' });
  reply(fake.turnIds[1], 'Fixed the bias.');
  await flush();
  assert.equal(session.job.goal, 'Fix the shadow map flicker');
  assert.equal(session.job.turns, 2);
  assert.equal(session.job.status, 'unknown');
  // A manual pick after "unknown" starts a new task, so a worker that never reports cannot pin the first task forever.
  await controller.send({ id: session.id, text: 'Manual question', mode: 'codex:gpt-5.6-terra:low', task: 'off' });
  reply(fake.turnIds[2], 'Answer.\n**[task: pending]**');
  await flush();
  assert.equal(session.job.goal, 'Manual question');
  assert.equal(session.job.status, 'pending', 'a formatted status line is read too');
  fake.turnIds.splice(2, 1); // keep the indexes below
  // A manual pick continues a task reported as pending and becomes its worker.
  await controller.send({ id: session.id, text: 'use the stronger one for this', mode: 'codex:gpt-5.6-sol:high', task: 'off' });
  reply(fake.turnIds[2], 'Done.\n[task: done]');
  await flush();
  assert.equal(session.job.goal, 'Manual question', 'the pending task continued');
  assert.equal(session.job.turns, 2);
  assert.equal(session.job.worker.id, 'codex:gpt-5.6-sol:high');
  assert.equal(session.job.status, 'done');
  // The router says the next prompt is a different task: a new task starts; a failed turn leaves it pending.
  next = { ...terra('codex:gpt-5.6-terra:low'), sameTask: false };
  await controller.send({ id: session.id, text: 'Now translate the README intro into Greek', mode: 'auto', task: 'off' });
  complete(controller, session, fake.turnIds[3], 'failed');
  await flush();
  assert.equal(session.job.goal, 'Now translate the README intro into Greek');
  assert.equal(session.job.turns, 1);
  assert.equal(session.job.status, 'pending');
  // After "done", a manual pick starts a new task.
  session.job.status = 'done';
  await controller.send({ id: session.id, text: 'Something else', mode: 'codex:gpt-5.6-sol:high', task: 'off' });
  reply(fake.turnIds[4], 'ok\n[task: done]');
  await flush();
  assert.equal(session.job.goal, 'Something else');
});

test('task status lines stay out of handoffs to another provider', async t => {
  const { controller } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const session = controller.create();
  session.helperTools = false;
  controller.claude.run = async ({ onEvent }) => {
    onEvent({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'All set.\n\n[task: done]' }] } });
    return { result: 'All set.\n\n[task: done]' };
  };
  await controller.send({ id: session.id, text: 'rename the file', mode: 'claude-cli:sonnet', task: 'off' });
  await flush();
  assert.equal(session.job.status, 'done');
  assert.ok(session.directContext.length);
  assert.ok(!JSON.stringify(session.directContext).includes('[task:'), JSON.stringify(session.directContext));
});

test('CLI follow-ups include delegated history arriving during a turn exactly once', async t => {
  const { controller } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const session = controller.create(); session.helperTools = false;
  const prompts = [];
  controller.claude.run = async ({ prompt, onEvent }) => {
    prompts.push(prompt);
    if (prompts.length === 1) session.items.push({ id: 'delegated-late', delegatedFrom: 'worker-chat', type: 'agentMessage', text: 'Late delegated history.' });
    onEvent({ type: 'assistant', message: { id: 'reply-' + prompts.length, content: [{ type: 'text', text: 'Finished.' }] } });
    return { result: 'Finished.' };
  };
  for (let turn = 0; turn < 3; turn++) {
    await controller.send({ id: session.id, text: 'Continue ' + turn, mode: 'claude-cli:sonnet', task: 'off' });
    await flush();
  }
  assert.doesNotMatch(prompts[0], /Late delegated history/);
  assert.match(prompts[1], /Late delegated history/);
  assert.doesNotMatch(prompts[2], /Late delegated history/);
});

test('decision trace: turns and final checks, with no text, and no automatic wiki turn', async t => {
  const { controller, fake } = await setup(t);
  const records = [];
  controller.trace = { record: entry => records.push(entry), summary: () => ({ turns: 0, wiki: {} }) };
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  arm(controller, fake);
  addCheck(controller, session, ['unit-tests']);
  fs.mkdirSync(path.join(session.workspace, 'docs', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(session.workspace, 'docs', 'wiki', 'index.md'), '# Wiki\n');
  await controller.send({ id: session.id, text: 'Implement retry handling', mode: 'terra-light' });
  controller.notification({ method: 'item/completed', params: { threadId: session.threadId, turnId: fake.turnIds[0], item: { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: 'Added retries.\n[task: done]' } } });
  complete(controller, session, fake.turnIds[0]);
  await controller.gateDone;
  const turn = records.find(r => r.event === 'turn' && r.kind === 'message');
  assert.deepEqual(turn.route, { source: 'manual', provider: 'codex', model: 'gpt-5.6-terra', effort: 'low', sameTask: null, routerPick: null, escalatedFrom: null, failover: false, switched: false, effortCap: null });
  assert.deepEqual(turn.outcome, { status: 'completed', limit: false, reportedTask: 'done' });
  const checks = records.find(r => r.event === 'checks');
  assert.deepEqual({ state: checks.state, checks: checks.checks }, { state: 'checks-passed', checks: { configured: 1, ran: 1, passed: 1, failed: 0, blocked: 0 } }, 'checks are traced apart from the reported status');
  assert.ok(!records.some(r => r.kind === 'wiki-maintenance'));
  assert.equal(fake.turnIds.length, 1);
  assert.ok(!JSON.stringify(records).includes('Implement retry'), 'no prompt or reply text in the trace');
});

test('traced worker tokens cover the whole turn, not only its last model call', async t => {
  const { controller, fake } = await setup(t);
  const records = [];
  controller.trace = { record: entry => records.push(entry), summary: () => ({ turns: 0, wiki: {} }) };
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const session = controller.create();
  session.helperTools = false;
  // Claude: two model calls in one turn; the result carries the turn's total.
  controller.claude.run = async ({ onEvent }) => {
    onEvent({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 20 }, content: [{ type: 'tool_use', id: 't1', name: 'Read', input: {} }] } });
    onEvent({ type: 'assistant', message: { id: 'm2', usage: { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 30 }, content: [{ type: 'text', text: 'Done.' }] } });
    return { result: 'Done.', usage: { input_tokens: 200, cache_read_input_tokens: 100, output_tokens: 50 } };
  };
  await controller.send({ id: session.id, text: 'read it', mode: 'claude-cli:sonnet', task: 'off' });
  await flush();
  assert.deepEqual(records.find(r => r.event === 'turn').worker.tokens, { input: 300, cached: 100, output: 50 });
  // Cursor reports no usage: unknown stays null, never zero.
  controller.data.settings.cursorEnabled = true;
  controller.cursor.status = { installed: true, loggedIn: true };
  controller.cursor.models = [{ id: 'composer-2.5', label: 'Composer 2.5', parameterized: true }];
  controller.providerSettings({ action: 'enableDiscovered', provider: 'cursor-cli', model: 'composer-2.5', label: 'Composer 2.5' });
  controller.cursor.run = async () => ({ result: 'Done.' });
  const cursorSession = controller.create();
  cursorSession.helperTools = false;
  await controller.send({ id: cursorSession.id, text: 'read it', mode: 'cursor-cli:composer-2.5:default', task: 'off' });
  await flush();
  const cursorTurn = records.filter(r => r.event === 'turn').at(-1);
  assert.equal(cursorTurn.route.provider, 'cursor-cli');
  assert.equal(cursorTurn.worker.tokens, null);
  // A Cursor tool card takes the name and input Cursor fills in later, and keeps a rawOutput result.
  controller.cursor.run = async ({ onEvent }) => {
    onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'g1', name: 'grep', input: {} }] } });
    onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'g1', name: 'grep "harbor"', input: { pattern: 'harbor' } }] } });
    onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'g1', content: { totalMatches: 1 } }] } });
    return { result: 'Done.' };
  };
  await controller.send({ id: cursorSession.id, text: 'search it', mode: 'cursor-cli:composer-2.5:default', task: 'off' });
  await flush();
  const card = cursorSession.items.find(item => item.id === 'g1');
  assert.deepEqual([card.tool, card.arguments, card.status, card.result], ['grep "harbor"', { pattern: 'harbor' }, 'completed', { totalMatches: 1 }]);
  // Codex: reports after each model call carry the thread total and that call; the turn is their difference.
  const codex = controller.create();
  await controller.send({ id: codex.id, text: 'go', mode: 'terra-light', task: 'off' });
  const turn = fake.turnIds.at(-1);
  const report = (total, last) => controller.notification({ method: 'thread/tokenUsage/updated', params: { threadId: codex.threadId, turnId: turn,
    tokenUsage: { total: { inputTokens: total[0], cachedInputTokens: total[1], outputTokens: total[2] }, last: { inputTokens: last[0], cachedInputTokens: last[1], outputTokens: last[2] } } } });
  report([1100, 400, 90], [100, 0, 20]); // the thread had 1000/400/70 before this turn
  report([1300, 500, 140], [200, 100, 50]);
  report([1300, 500, 140], [200, 100, 50]); // a repeated report changes nothing
  complete(controller, codex, turn);
  await flush();
  assert.deepEqual(records.filter(r => r.event === 'turn').at(-1).worker.tokens, { input: 300, cached: 100, output: 70 });
});

test('Claude token counts include subagent calls, update while the turn runs and keep a stopped turn’s calls', async t => {
  const { controller } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const session = controller.create();
  session.helperTools = false;
  let emit, finish, reached;
  controller.claude.run = ({ signal, onEvent }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Claude stopped.')), { once: true });
    emit = onEvent;
    finish = resolve;
    reached();
  });
  const running = () => new Promise(resolve => { reached = resolve; });
  const call = (id, input, cached, output, extra = {}) =>
    ({ type: 'assistant', ...extra, message: { id, usage: { input_tokens: input, cache_read_input_tokens: cached, output_tokens: output }, content: [] } });
  const callStart = (id, input, cached) =>
    ({ type: 'stream_event', event: { type: 'message_start', message: { id, usage: { input_tokens: input, cache_read_input_tokens: cached, output_tokens: 1 } } } });

  // One main call streamed three times and one subagent call: each counts once, as soon as it streams.
  let started = running();
  const sent = controller.send({ id: session.id, text: 'review', mode: 'claude-cli:sonnet', task: 'off' });
  await started;
  emit(callStart('m1', 20, 80));
  emit(call('m1', 20, 80, 4));
  emit(call('m1', 20, 80, 10));
  emit(call('s1', 10, 40, 7, { parent_tool_use_id: 'toolu_agent' }));
  const first = { inputTokens: 150, cachedInputTokens: 120, outputTokens: 17 };
  assert.deepEqual(session.usage.total, first);
  assert.deepEqual(session.routes.at(-1).turnUsage, first);
  // Claude's result counts only the main conversation.
  finish({ result: 'Done.', usage: { input_tokens: 20, cache_read_input_tokens: 80, output_tokens: 10 } });
  await sent;
  await until(() => !controller.busy);
  assert.deepEqual(session.usage.total, first);
  assert.deepEqual(session.routes.at(-1).budgetFinalUsage, first);

  // A stopped turn keeps what it streamed, including a call cut off after message_start, and usage recorded elsewhere
  // meanwhile stays.
  started = running();
  const stopped = controller.send({ id: session.id, text: 'again', mode: 'claude-cli:sonnet', task: 'off' });
  await started;
  emit(call('m2', 30, 120, 6));
  session.usage.total.outputTokens += 1000;
  emit(callStart('m3', 5, 150));
  await controller.stop();
  await stopped;
  assert.equal(session.status, 'interrupted');
  const total = { inputTokens: 150 + 150 + 155, cachedInputTokens: 120 + 120 + 150, outputTokens: 17 + 6 + 1000 + 1 };
  assert.deepEqual(session.usage.total, total);
  assert.deepEqual(readSessionData(controller.filename).sessions.find(item => item.id === session.id).usage.total, total);
  assert.deepEqual(session.routes.at(-1).turnUsage, { inputTokens: 305, cachedInputTokens: 270, outputTokens: 7 });
});

test('a snapshot builds the model catalog a fixed number of times, not once per preset', async t => {
  const { controller } = await setup(t);
  // The free plan makes the plan check read the catalog; it once ran for every preset (every bot, every window update).
  controller.account = { type: 'chatgpt', plan: 'free' };
  const catalog = controller.catalog.bind(controller);
  let builds = 0;
  controller.catalog = () => { builds++; return catalog(); };
  const snapshot = controller.snapshot();
  assert.ok(snapshot.presets.length > 10, 'enough presets to show a per-preset cost');
  // 7 fixed builds (router and chat-scan lists, plan check) against 83 for 19 presets when the plan was checked per preset.
  assert.ok(builds < snapshot.presets.length, `catalog built ${builds} times for ${snapshot.presets.length} presets`);
});

test('a Claude turn does not wait for Codex to connect; Codex and Auto turns still do', async t => {
  const { controller } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  controller.claude.run = async () => ({ result: 'Done.' });
  const session = controller.create();
  session.helperTools = false;
  controller.connection = 'connecting';

  await controller.send({ id: session.id, text: 'review', mode: 'claude-cli:sonnet', task: 'off' });
  await until(() => !controller.busy);
  assert.equal(session.status, 'completed');
  assert.ok(session.items.some(item => item.type === 'agentMessage' && item.text === 'Done.'));

  await assert.rejects(controller.send({ id: session.id, text: 'again', mode: 'terra-light', task: 'off' }), /Codex is still connecting/);
  await assert.rejects(controller.send({ id: session.id, text: 'again', mode: 'auto', task: 'off' }), /Codex is still connecting/);
});

test('Claude output tokens come from message_delta and the result, not the partial counts on assistant events', async t => {
  const { controller } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const session = controller.create();
  session.helperTools = false;
  let emit, finish, reached;
  const started = new Promise(resolve => { reached = resolve; });
  controller.claude.run = ({ onEvent }) => new Promise(resolve => {
    emit = onEvent;
    finish = resolve;
    reached();
  });
  const usage = (input, cached, output) => ({ input_tokens: input, cache_read_input_tokens: cached, output_tokens: output });

  const sent = controller.send({ id: session.id, text: 'review', mode: 'claude-cli:sonnet', task: 'off' });
  await started;
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1', usage: usage(20, 80, 1) } } });
  emit({ type: 'assistant', message: { id: 'm1', usage: usage(20, 80, 3), content: [] } });
  emit({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 400 } } });
  assert.equal(session.usage.total.outputTokens, 400);

  // A call whose message_delta never arrived, and a subagent call (subagents send no message_delta).
  emit({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm2', usage: usage(10, 90, 1) } } });
  emit({ type: 'assistant', message: { id: 'm2', usage: usage(10, 90, 2), content: [] } });
  emit({ type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { id: 's1', usage: usage(30, 0, 5), content: [] } });
  assert.deepEqual(session.usage.total, { inputTokens: 230, cachedInputTokens: 170, outputTokens: 407 });

  // The result counts the main conversation exactly: 400 + 500 output.
  finish({ result: 'Done.', usage: usage(30, 170, 900) });
  await sent;
  await until(() => !controller.busy);
  const total = { inputTokens: 230, cachedInputTokens: 170, outputTokens: 905 };
  assert.deepEqual(session.usage.total, total);
  assert.deepEqual(session.routes.at(-1).turnUsage, total);
});

// Real Claude Code results (Opus 5.5, 2026-10-28): turn A, then turn D resuming A's session, and turn B with one subagent.
const OPUS_RESULTS = {
  A: { session_id: 'f44ece8e', usage: { input_tokens: 20, cache_read_input_tokens: 309258, cache_creation_input_tokens: 28825, output_tokens: 8689 },
    modelUsage: { 'claude-opus-5-5': { inputTokens: 20, cacheReadInputTokens: 309258, cacheCreationInputTokens: 28825, outputTokens: 8689, contextWindow: 1000000 } },
    total_cost_usd: 0.46631159999999994 },
  D: { session_id: 'f44ece8e', usage: { input_tokens: 2, cache_read_input_tokens: 16564, cache_creation_input_tokens: 34008, output_tokens: 4 },
    modelUsage: { 'claude-opus-5-5': { inputTokens: 22, cacheReadInputTokens: 325822, cacheCreationInputTokens: 62833, outputTokens: 8693, contextWindow: 1000000 } },
    total_cost_usd: 0.7417763999999999 },
  B: { session_id: 'deb75872', usage: { input_tokens: 4, cache_read_input_tokens: 46159, cache_creation_input_tokens: 9285, output_tokens: 515 },
    modelUsage: { 'claude-opus-5-5': { inputTokens: 10, cacheReadInputTokens: 89563, cacheCreationInputTokens: 33699, outputTokens: 1666, contextWindow: 1000000 } },
    total_cost_usd: 0.24762260000000003 },
};

async function claudeChat(t) {
  const { controller } = await setup(t);
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  const runs = [];
  const chat = { controller, runs, reply: null };
  controller.claude.run = async options => {
    runs.push(options);
    const result = chat.reply(options.onEvent);
    options.onEvent({ type: 'system', subtype: 'init', session_id: result.session_id });
    return { result: 'Done.', ...result };
  };
  chat.session = controller.create();
  chat.session.helperTools = false;
  chat.turn = async text => {
    await controller.send({ id: chat.session.id, text, mode: 'claude-cli:sonnet', task: 'off' });
    await until(() => !controller.busy);
    return chat.session.routes.at(-1);
  };
  return chat;
}

test('a completed Claude turn counts the change in Claude’s cost tracker, subagent calls and resumed sessions included', async t => {
  const chat = await claudeChat(t);
  chat.reply = () => OPUS_RESULTS.A;
  const a = await chat.turn('A');
  assert.deepEqual(a.turnUsage, { inputTokens: 338103, cachedInputTokens: 309258, outputTokens: 8689 });
  assert.equal(a.providerEstimateUsd, 0.46631159999999994);

  // The tracker carries A's totals into the resumed turn; the turn is the difference.
  chat.reply = () => OPUS_RESULTS.D;
  const d = await chat.turn('Reply with only: OK');
  assert.equal(chat.runs.at(-1).resume, 'f44ece8e');
  assert.deepEqual(d.turnUsage, { inputTokens: 50574, cachedInputTokens: 16564, outputTokens: 4 });
  assert.deepEqual(d.budgetFinalUsage, d.turnUsage);
  assert.ok(Math.abs(d.providerEstimateUsd - 0.2754648) < 1e-9, String(d.providerEstimateUsd));
  assert.deepEqual(chat.session.usage.total, { inputTokens: 388677, cachedInputTokens: 325822, outputTokens: 8693 });

  // B: the stream holds partial output and misses the subagent's last call; the tracker has the whole turn.
  const subagent = await claudeChat(t);
  subagent.reply = onEvent => {
    onEvent({ type: 'assistant', message: { id: 'm1', usage: { input_tokens: 4, cache_read_input_tokens: 46159, cache_creation_input_tokens: 9285, output_tokens: 3 }, content: [] } });
    onEvent({ type: 'assistant', parent_tool_use_id: 'toolu_agent', message: { id: 's1', usage: { input_tokens: 6, cache_read_input_tokens: 43402, cache_creation_input_tokens: 0, output_tokens: 22 }, content: [] } });
    assert.deepEqual(subagent.session.usage.total, { inputTokens: 98856, cachedInputTokens: 89561, outputTokens: 25 });
    return OPUS_RESULTS.B;
  };
  const b = await subagent.turn('B');
  const whole = { inputTokens: 123272, cachedInputTokens: 89563, outputTokens: 1666 };
  assert.deepEqual(b.turnUsage, whole);
  assert.deepEqual(b.budgetFinalUsage, whole);
  assert.deepEqual(subagent.session.usage.total, whole);
  assert.equal(b.providerEstimateUsd, 0.24762260000000003);
});

test('a resumed Claude session without saved totals keeps the streamed count once, then counts exactly, compaction included', async t => {
  const chat = await claudeChat(t);
  chat.session.claudeSessionId = 'f44ece8e'; // a chat from before Harness kept Claude's running totals
  chat.reply = onEvent => {
    onEvent({ type: 'assistant', message: { id: 'm1', usage: OPUS_RESULTS.D.usage, content: [] } });
    return OPUS_RESULTS.D;
  };
  const d = await chat.turn('Reply with only: OK');
  assert.equal(chat.runs.at(-1).resume, 'f44ece8e');
  assert.deepEqual(d.turnUsage, { inputTokens: 50574, cachedInputTokens: 16564, outputTokens: 4 });
  assert.equal(d.providerEstimateUsd, 0.7417763999999999, 'Claude’s running total, as before');
  assert.deepEqual(chat.session.claudeUsageBase,
    { sessionId: 'f44ece8e', inputTokens: 388677, cachedInputTokens: 325822, outputTokens: 8693, costUsd: 0.7417763999999999 });

  // Compaction moves the totals on and counts in the chat, so the next turn is only its own calls.
  const tracked = (input, read, write, output, cost) => ({ session_id: 'f44ece8e', usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: cost,
    modelUsage: { 'claude-opus-5-5': { inputTokens: input, cacheReadInputTokens: read, cacheCreationInputTokens: write, outputTokens: output } } });
  chat.reply = () => tracked(30, 335822, 62833, 9693, 0.80);
  await chat.controller.compact(chat.session.id);
  assert.equal(chat.runs.at(-1).prompt, '/compact');
  assert.deepEqual(chat.session.usage.total, { inputTokens: 50574 + 10008, cachedInputTokens: 16564 + 10000, outputTokens: 4 + 1000 });

  chat.reply = () => tracked(31, 336822, 62933, 9700, 0.81);
  const next = await chat.turn('Next');
  assert.deepEqual(next.turnUsage, { inputTokens: 1101, cachedInputTokens: 1000, outputTokens: 7 });
  assert.ok(Math.abs(next.providerEstimateUsd - 0.01) < 1e-9, String(next.providerEstimateUsd));
});

test('Codex usage windows are tracked and a full window marks the limit until its reset', async t => {
  const { controller } = await setup(t);
  const resetsAt = Math.floor(Date.now() / 1000) + 600;
  controller.notification({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt }, secondary: null } } });
  assert.equal(controller.limits.usage.codex.primary.usedPercent, 42);
  assert.equal(controller.limits.limited('codex'), null);
  controller.notification({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt } } } });
  assert.equal(controller.limits.limited('codex').until, resetsAt * 1000);
  assert.equal(controller.limits.usage.codex.primary.usedPercent, 100);
});

test('Codex usage: stale windows, other limit buckets and credits never mark a limit', async t => {
  const { controller } = await setup(t);
  const past = Math.floor(Date.now() / 1000) - 60, future = Math.floor(Date.now() / 1000) + 600;
  controller.codexUsage({ limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: past }, secondary: null });
  assert.equal(controller.limits.current('codex'), null, 'a full window whose reset has passed is stale');
  controller.notification({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'codex', primary: null, secondary: { usedPercent: 10, windowDurationMins: 10080, resetsAt: future } } } });
  assert.equal(controller.limits.current('codex'), null, 'merging a sparse update does not revive the stale window as a limit');
  controller.notification({ method: 'account/rateLimits/updated', params: { rateLimits: { limitId: 'gpt-6-astra', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: future } } } });
  assert.equal(controller.limits.current('codex'), null, 'another bucket is not the Codex plan window');
  assert.equal(controller.limits.usage.codex.secondary.usedPercent, 10);
  controller.codexUsage({ limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: future }, credits: { hasCredits: true, unlimited: false, balance: '5' } });
  assert.equal(controller.limits.current('codex'), null, 'credits cover a full window');
});

test('API providers: add, enable a discovered model, and remove the provider with its models and key', async t => {
  const { controller } = await setup(t);
  const removedKeys = [];
  controller.providers = { configured: () => false, key: id => ({ remove: () => removedKeys.push(id) }) };
  controller.providerSettings({ action: 'provider', provider: { id: 'lm-studio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', enabled: true } });
  controller.providerSettings({ action: 'enableDiscovered', provider: 'lm-studio', model: 'qwen3-coder-30b-a3b', label: 'qwen3-coder-30b-a3b' });
  const worker = controller.catalog().find(p => p.provider === 'lm-studio');
  assert.equal(worker.id, 'lm-studio:qwen3-coder-30b-a3b:default');
  assert.equal(controller.available(worker), true, 'runs through the connected Codex app-server');
  assert.throws(() => controller.providerSettings({ action: 'provider', provider: { id: 'codex', name: 'x', baseUrl: 'https://x.test' } }), /provider ID/);
  assert.throws(() => controller.providerSettings({ action: 'provider', provider: { id: 'remote', name: 'x', baseUrl: 'http://example.com' } }), /HTTPS/);
  controller.data.settings.mode = worker.id;
  controller.data.settings.routerPreset = worker.id;
  controller.providerSettings({ action: 'removeProvider', id: 'lm-studio' });
  assert.equal(controller.data.settings.mode, 'auto', 'a manual choice of a removed model goes back to Auto');
  assert.ok(controller.routerChoices().some(p => p.id === controller.data.settings.routerPreset && controller.available(p)), 'routing gets an available router');
  // Other providers' saved choices stay, even while their models are not listed (for example Claude signed out).
  controller.providerSettings({ action: 'provider', provider: { id: 'lm-studio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', enabled: true } });
  controller.data.settings.mode = 'claude-cli:claude-opus-5-5:high';
  controller.data.settings.routerPreset = 'claude-cli:claude-haiku-5';
  controller.providerSettings({ action: 'removeProvider', id: 'lm-studio' });
  assert.equal(controller.data.settings.mode, 'claude-cli:claude-opus-5-5:high');
  assert.equal(controller.data.settings.routerPreset, 'claude-cli:claude-haiku-5');
  assert.deepEqual(controller.data.settings.providers, []);
  assert.equal(controller.catalog().some(p => p.provider === 'lm-studio'), false);
  assert.deepEqual(removedKeys, ['lm-studio', 'lm-studio']);
  assert.throws(() => controller.providerSettings({ action: 'removeProvider', id: 'lm-studio' }), /Unknown provider/);
});

test('API providers run in Harness\'s own loop without Codex, continue the chat, and Stop ends the request', async t => {
  const { controller, fake } = await setup(t);
  const stream = chunks => new Response(new ReadableStream({ start(output) {
    for (const chunk of chunks) output.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
    output.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); output.close();
  } }), { status: 200 });
  const bodies = [];
  let started;
  controller.providers = {
    configured: () => false,
    local: { inspect: async () => ({ supported: false }) },
    modelRequest: async (_choice, body, _local, signal) => {
      bodies.push(structuredClone(body));
      if (body.messages.at(-1).content.endsWith('stop this')) {
        started();
        await new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      }
      return stream([{ choices: [{ delta: { content: 'Hello ' } }] }, { choices: [{ delta: { content: 'from the API.' } }] },
        { choices: [], usage: { prompt_tokens: 12, completion_tokens: 4 } }]);
    },
  };
  controller.providerSettings({ action: 'provider', provider: { id: 'local', name: 'Local', baseUrl: 'http://localhost:1234/v1' } });
  controller.providerSettings({ action: 'enableDiscovered', provider: 'local', model: 'gemma' });
  const mode = 'local:gemma:default', session = controller.create();

  await controller.send({ id: session.id, text: 'hello', mode, task: 'off' });
  await until(() => !controller.busy);
  assert.equal(session.items.filter(item => item.type === 'agentMessage').at(-1).text, 'Hello from the API.');
  assert.equal(fake.calls.some(call => ['thread/start', 'thread/resume', 'turn/start'].includes(call.method)), false, 'Codex is never used');
  assert.equal(session.usage.total.inputTokens, 12);

  await controller.send({ id: session.id, text: 'and again', mode, task: 'off' });
  await until(() => !controller.busy);
  assert.deepEqual(bodies.at(-1).messages.filter(message => message.role !== 'system').map(message => message.role), ['user', 'assistant', 'user'], 'the saved chat continues');

  const oversized = { id: 'oversized-history', type: 'agentMessage', text: 'x'.repeat(1000001) };
  session.items.unshift(oversized);
  const continued = session.localSessionId;
  await controller.send({ id: session.id, text: 'Continue the long conversation', mode, task: 'off' });
  await until(() => !controller.busy);
  assert.equal(session.status, 'completed');
  assert.equal(session.localSessionId, continued, 'valid API history needs no transfer regardless of Harness history size');
  assert.ok(JSON.stringify(bodies.at(-1)).length < 1000000, 'ordinary continuation does not serialize the recovery history');
  session.items = session.items.filter(item => item !== oversized);

  const lost = session.localSessionId;
  fs.unlinkSync(path.join(controller.apiAgent.directory, lost + '.json'));
  await controller.send({ id: session.id, text: 'recover this conversation', mode, task: 'off' });
  await until(() => !controller.busy);
  assert.equal(session.status, 'completed');
  assert.notEqual(session.localSessionId, lost);
  assert.equal(bodies.length, 4, 'missing local history recovers with one provider call');
  const recovered = bodies.at(-1).messages.at(-1).content;
  assert.match(recovered, /hello/); assert.match(recovered, /and again/);
  assert.match(recovered, /recover this conversation/);
  assert.equal(recovered.split('recover this conversation').length - 1, 1, 'recovery includes the current request once');

  const waiting = new Promise(resolve => { started = resolve; });
  const pending = controller.send({ id: session.id, text: 'stop this', mode, task: 'off' });
  await waiting; await controller.stop();
  await pending.catch(() => {});
  await until(() => !controller.busy);
  assert.equal(session.status, 'interrupted');
});

test('archived Main chats keep their native continuation protected from Claude cleanup and retain it when reopened', async t => {
  const { controller } = await setup(t);
  const session = controller.create(), root = session.workspace, id = require('node:crypto').randomUUID();
  session.coordinatorConversation = { sessionId: id };
  controller.archive(session.id);
  const home = path.join(root, 'claude-store'), bucket = path.join(home, 'projects', fs.realpathSync(root).replace(/[^a-zA-Z0-9]/g, '-'));
  fs.mkdirSync(bucket, { recursive: true });
  const file = path.join(bucket, id + '.jsonl');
  fs.writeFileSync(file, JSON.stringify({ sessionId: id, cwd: root }) + '\n');
  const old = new Date(Date.now() - 40 * 86400000); fs.utimesSync(file, old, old);
  const saved = controller.smartRouter.savedConversations();
  assert.ok(saved.some(chat => chat.sessionId === id));
  require('../src/providers/conversation-retention.cjs').pruneClaude(root, new Set(saved.map(chat => chat.sessionId)), home);
  assert.ok(fs.existsSync(file), 'archiving retains the native transcript even past the retention period');
  session.archived = false;
  assert.equal(controller.smartRouter.savedConversations()[0].sessionId, id);
  assert.equal(readSessionData(controller.filename).sessions.find(chat => chat.id === session.id).coordinatorConversation.sessionId, id);
});

test('diagnostics list versions, provider state and limits without emails, keys or chat content', async t => {
  const { buildDiagnostics } = require('../src/diagnostics.cjs');
  const { controller } = await setup(t);
  controller.claude.status = { installed: true, loggedIn: true, email: 'someone@example.com' };
  controller.data.settings.providers = [{ id: 'lm', name: 'LM', baseUrl: 'http://localhost:1234/v1', enabled: true }];
  const session = controller.create();
  session.title = 'Secret project plan';
  controller.limits.mark('cursor-cli', { until: null });
  const text = buildDiagnostics({ controller, app: { version: '0.1.0', electron: '44.4.3', packaged: false }, cli: { codex: '0.156.1', claude: '2.1.281' },
    logLines: ['2026 INFO Started', 'token=sk-abcdefghijklmnopqrstu'] });
  assert.match(text, /Phasma Harness 0\.1\.0 · Electron 44\.4\.3/);
  assert.match(text, /Codex CLI 0\.156\.1 · running: yes/);
  assert.match(text, /Claude Code 2\.1\.281 · signed in: yes/);
  assert.match(text, /API provider lm · localhost:1234/);
  assert.match(text, /Usage limits: cursor-cli until .*\(estimated\)/);
  assert.doesNotMatch(text, /someone@example\.com|Secret project|sk-abcdefghijklmnopqrstu/);
});

test('the effort cap narrows what Auto routing is offered and is recorded with the route; manual picks are not capped', async t => {
  const { controller, fake, smartRouter } = await setup(t);
  assert.equal(controller.data.settings.effortCap, 'high', 'default');
  assert.throws(() => controller.settings({ effortCap: 'ultra' }), /Unknown effort cap/);
  controller.settings({ effortCap: 'medium' });
  const session = controller.create();
  let offered = null;
  smartRouter.choose = async (_text, context) => { offered = context.routingCatalog; return { ...controller.resolveWorker('terra-light'), assessment: { taskKind: 'general' } }; };
  await controller.send({ id: session.id, text: 'hello', mode: 'auto', task: 'off' });
  const codex = offered.filter(p => p.provider === 'codex');
  assert.ok(codex.length);
  assert.deepEqual([...new Set(codex.map(p => p.effort))].sort(), ['low', 'medium']);
  assert.equal(session.routes.at(-1).effortCap, 'medium');
  complete(controller, session, session.turnId);
  await flush();
  const high = controller.catalog().find(p => p.provider === 'codex' && p.effort === 'xhigh' && controller.available(p));
  await controller.send({ id: session.id, text: 'manual', mode: high.id, task: 'off' });
  assert.equal(session.routes.at(-1).effort, 'xhigh', 'a manual pick is not capped');
  assert.equal(session.routes.at(-1).effortCap, undefined);
});


test('Send now restarts non-steering providers only after the previous turn stops', async t => {
  const { controller } = await setup(t);
  for (const provider of ['cursor-cli', 'native:muse', 'native:deepseek', 'native:antigravity', 'test-api']) {
    const session = controller.create();
    session.activeProvider = provider;
    controller.busy = session.id;
    controller.activeTurns.set(session.id, 'old-turn');
    const message = { id: 'correction', text: 'Use the new requirement', images: [], mode: 'manual', task: 'off' };
    session.queue = [message];
    const events = [];
    controller.stop = async () => {
      controller.stopGeneration = (controller.stopGeneration || 0) + 1;
      events.push('stop');
      setTimeout(() => { events.push('stopped'); controller.busy = null; }, 10);
    };
    controller.send = async value => { events.push('send'); assert.equal(value.text, message.text); };
    await controller.queuedMessage(session.id, message.id, 'steer');
    assert.deepEqual(events, ['stop', 'stopped', 'send']);
    assert.equal(session.queue.length, 0);
  }
});

test('live delivery keeps a queued correction until acknowledgement and preserves uncertain delivery', async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  session.activeProvider = 'claude-cli';
  controller.busy = session.id;
  controller.activeTurns.set(session.id, 'live-turn');
  const message = { id: 'live-note', text: 'new requirement', images: [] };
  session.queue = [message];
  let acknowledge;
  controller.liveInput = () => new Promise(resolve => { acknowledge = resolve; });
  const delivery = controller.queuedMessage(session.id, message.id, 'live');
  assert.equal(session.queue.length, 1);
  assert.equal(session.queueSending, true);
  assert.equal(message.sending, true, 'the queue list hides it while it is on its way');
  acknowledge();
  await delivery;
  assert.equal(session.queue.length, 0);
  assert.equal(session.items.filter(item => item.clientId === message.id).length, 1);
  session.queue = [{ ...message, id: 'uncertain-note' }];
  controller.liveInput = async () => { throw new Error('Claude input disconnected before delivery was confirmed.'); };
  await assert.rejects(controller.queuedMessage(session.id, 'uncertain-note', 'live'), /disconnected/);
  assert.deepEqual([session.queue[0].uncertain, session.queue[0].sending], [true, undefined], 'a failed send shows in the queue again');
});

test('a message the app closed on while sending shows in the queue again after a restart, as unconfirmed', async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  session.queue = [{ id: 'mid-send', text: 'new requirement', images: [], sending: true }];
  session.queueSending = true;
  controller.save();
  const restarted = reopen(controller);
  const [message] = restarted.session(session.id).queue;
  assert.deepEqual([message.sending, message.uncertain], [undefined, true]);
});

test('Send now steers where the provider can, automatic delivery uses its own queue, and steer-only providers are never fed the queue', async t => {
  const { controller } = await setup(t);
  const { capabilities } = require('../src/providers/capabilities.cjs');
  for (const [provider, action, steer] of [['test-api', 'steer', true], ['claude-cli', 'steer', true], ['claude-cli', 'live', false]]) {
    const session = controller.create();
    session.activeProvider = provider;
    controller.busy = session.id;
    controller.activeTurns.set(session.id, 'live-turn');
    session.queue = [{ id: 'now-' + provider, text: 'Use the new requirement', images: [] }];
    const calls = [];
    controller.liveInput = async (message, options) => { calls.push(options.steer); };
    controller.liveInputCaps = capabilities(provider);
    await controller.queuedMessage(session.id, 'now-' + provider, action);
    assert.deepEqual(calls, [steer], `${provider} ${action}`);
    assert.equal(session.queue.length, 0);
  }

  // A provider that can only interrupt (cancel and prompt again) must not consume ordinary queued messages.
  const session = controller.create();
  controller.busy = session.id;
  session.queue = [{ id: 'later', text: 'Next thing', images: [] }];
  let fed = false;
  controller.liveInput = async () => { fed = true; };
  controller.liveInputCaps = { liveSteer: true };
  controller.flushLiveQueue(session);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fed, false);
  assert.equal(session.queue.length, 1);
});

test('a tracked worker run saves its setup fingerprint on its route and on its task attempt', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.permissions(session.id, 'danger-full-access');
  controller.checks(session.workspace, [{ name: 'one', argv: ['one'], cwd: session.workspace, timeoutMs: 5000, readOnlySafe: true }]);
  fake.onExec = () => ({ exitCode: 0, stdout: 'ok', stderr: '' });
  await controller.send({ id: session.id, text: 'implement', mode: 'terra-light', task: 'on' });
  complete(controller, session, fake.turnIds.at(-1));
  await controller.gateDone;
  const attempt = session.tasks[0].attempts[0];
  assert.deepEqual(attempt.setup, session.routes.at(-1).setup);
  assert.match(attempt.setup.hash, /^[0-9a-f]{16}$/);
  assert.deepEqual([attempt.setup.v, attempt.setup.provider, attempt.setup.model, attempt.setup.effort, attempt.setup.access],
    [1, 'codex', 'gpt-5.6-terra', 'low', session.access]);
  assert.ok(attempt.setup.checks, 'the frozen checks are part of the setup');
  assert.ok(attempt.setup.instructions.harness.hash);
  assert.equal(attempt.setup.instructions.bot, null, 'the main agent has no bot instructions');
  assert.ok(Object.values(attempt.setup.skills).every(Boolean), 'every bundled skill is hashed');
});

test('Send now on a Claude turn that is finishing keeps the message queued instead of stopping the turn', async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  session.activeProvider = 'claude-cli';
  session.claudeSessionId = 'kept-claude-session';
  controller.busy = session.id;
  controller.activeTurns.set(session.id, 'finishing-turn');
  session.queue = [{ id: 'late', text: 'One more thing', images: [] }];
  // The final result arrived: Claude no longer accepts live input while its process closes.
  controller.liveInput = null;
  controller.stop = async () => { assert.fail('must not stop a finishing turn'); };
  await controller.queuedMessage(session.id, 'late', 'steer');
  assert.deepEqual(session.queue.map(message => message.id), ['late'], 'it sends next, once the turn ends');
  assert.equal(session.queue[0].error, undefined);
  assert.equal(session.claudeSessionId, 'kept-claude-session');
});

test('Send now preserves the queued message if another Stop cancels restart', async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  session.activeProvider = 'cursor-cli'; controller.busy = session.id;
  controller.activeTurns.set(session.id, 'old-turn');
  session.queue = [{ id: 'note', text: 'change', images: [] }];
  controller.stop = async () => { controller.stopGeneration = 2; controller.busy = null; };
  controller.send = async () => { assert.fail('must not restart'); };
  await assert.rejects(controller.queuedMessage(session.id, 'note', 'steer'), /cancelled by Stop/);
  assert.equal(session.queue.length, 1);
});


test('Claude queues are forwarded during work in order, without replaying uncertain or different-model messages', async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  controller.busy = session.id;
  session.activeProvider = 'claude-cli';
  controller.activeTurns.set(session.id, 'live-turn');
  controller.liveInputMode = controller.data.settings.mode;
  // sendCLI sets both together from the running provider's capabilities.
  controller.liveInputCaps = require('../src/providers/capabilities.cjs').capabilities('claude-cli');
  const delivered = [];
  const acknowledgements = [];
  controller.liveInput = message => new Promise(resolve => {
    delivered.push(message.text); acknowledgements.push(resolve);
  });
  await controller.send({ id: session.id, text: 'first correction' });
  await controller.send({ id: session.id, text: 'second correction' });
  assert.deepEqual(delivered, ['first correction']);
  acknowledgements.shift()();
  await new Promise(setImmediate);
  assert.deepEqual(delivered, ['first correction', 'second correction']);
  acknowledgements.shift()();
  await new Promise(setImmediate);
  assert.equal(session.queue.length, 0);
  await controller.send({ id: session.id, text: 'different model', mode: 'different' });
  assert.equal(delivered.length, 2);
  assert.equal(session.queue.length, 1);
});

// 2026-10-29: "status?" reached Claude while it ran a 10-minute foreground wait. The queue hid it for 30 s, then showed it
// as Paused with Send now greyed out, although Claude still held it.
test('a message Claude holds shows as waiting, frees the queue, and Send now asks Claude for it at once', async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  controller.busy = session.id;
  session.activeProvider = 'claude-cli';
  controller.activeTurns.set(session.id, 'live-turn');
  controller.liveInputMode = controller.data.settings.mode;
  controller.liveInputCaps = require('../src/providers/capabilities.cjs').capabilities('claude-cli');
  const calls = [];
  let acknowledge;
  controller.liveInput = (message, options) => {
    calls.push([message.text, options.steer]);
    if (calls.length > 1)
      return Promise.resolve();

    options.written();
    return new Promise(resolve => { acknowledge = resolve; });
  };
  await controller.send({ id: session.id, text: 'status?' });
  const [message] = session.queue;
  assert.deepEqual([message.waiting, message.sending, session.queueSending], [true, undefined, false], 'shown, with the queue free');
  await assert.rejects(controller.queuedMessage(session.id, message.id, 'edit'), /already has this message/);
  await assert.rejects(controller.queuedMessage(session.id, message.id, 'remove'), /already has this message/);

  await controller.queuedMessage(session.id, message.id, 'steer');
  assert.deepEqual(calls, [['status?', false], ['status?', true]]);
  assert.equal(session.queue[0], message, 'it stays until Claude echoes it');

  controller.save();
  const [reopened] = reopen(controller).session(session.id).queue;
  assert.deepEqual([reopened.uncertain, reopened.waiting], [true, undefined], 'an app restart cannot know whether Claude took it');

  acknowledge();
  await new Promise(setImmediate);
  assert.equal(session.queue.length, 0);
  assert.equal(session.items.filter(item => item.clientId === message.id).length, 1);
});


test('Send now cannot resume through an unconfirmed cleanup block', async t => {
  const { controller } = await setup(t);
  const session = controller.create();
  session.activeProvider = 'cursor-cli'; controller.busy = session.id;
  controller.activeTurns.set(session.id, 'old-turn');
  session.queue = [{ id: 'note', text: 'change', images: [] }];
  controller.stop = async () => {
    controller.stopGeneration = 1; controller.busy = null;
    controller.blockedReason = () => 'Worker cleanup is unconfirmed.';
  };
  controller.send = async () => { assert.fail('must not overlap old execution'); };
  await assert.rejects(controller.queuedMessage(session.id, 'note', 'steer'), /cleanup is unconfirmed/);
  assert.equal(session.queue.length, 1);
  assert.equal(session.queueSending, false);
});
