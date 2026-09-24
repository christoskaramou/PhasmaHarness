const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Controller } = require('../src/controller.cjs');
const { MEASURED_REAP } = require('../src/tasks.cjs');

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

test('changed project instructions refresh an existing worker; unchanged entry does not reload', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  const entry = path.join(session.workspace, 'INSTRUCTIONS.md');
  await controller.send({ id: session.id, text: 'hello', mode: 'terra-light', task: 'off' });
  assert.ok(fs.existsSync(entry));
  complete(controller, session, session.turnId);
  await flush();
  fs.writeFileSync(entry, '# Project rule\nUse the violet convention.');
  await controller.send({ id: session.id, text: 'continue', mode: 'terra-light', task: 'off' });
  assert.match(fake.calls.filter(c => c.method === 'thread/resume').at(-1).params.developerInstructions, /violet convention/);
  complete(controller, session, session.turnId);
  await flush();
  const count = fake.calls.filter(c => c.method === 'thread/resume').length;
  await controller.send({ id: session.id, text: 'again', mode: 'terra-light', task: 'off' });
  assert.equal(fake.calls.filter(c => c.method === 'thread/resume').length, count);
});

test('shared worker defaults reach Codex and CLI with the selected workspace wiki', async t => {
  const { controller, fake } = await setup(t);
  const session = controller.create();
  controller.wikiStore = { location: () => ({ root: path.join(session.workspace, 'private-wiki') }) };
  await controller.send({ id: session.id, text: 'hello', mode: 'terra-light', task: 'off' });
  const instructions = fake.calls.find(c => c.method === 'thread/start').params.developerInstructions;
  assert.ok(instructions.includes('Harness skills') && instructions.includes('Ponytail full'));
  assert.ok(instructions.includes('private-wiki'));
  complete(controller, session, session.turnId);
  await flush();
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  session.helperTools = false;
  let cli;
  controller.claude.run = async request => { cli = request; return { result: 'ok' }; };
  await controller.send({ id: session.id, text: 'normal mode', mode: 'claude-cli:sonnet', task: 'off' });
  assert.ok(cli.instructions.includes('Ponytail full'));
  assert.ok(cli.instructions.includes('private-wiki'));
  assert.equal(cli.helpers, null);
  assert.ok(cli.prompt.includes('normal mode'));
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
  controller.notification({ method: 'turn/started', params: { threadId: session.threadId, turn: { id: previous } } });
  controller.notification({ method: 'thread/compacted', params: { threadId: session.threadId } });
  controller.notification({ method: 'thread/compacted', params: { threadId: session.threadId, turnId: 'other-turn' } });
  assert.equal(controller.busy, session.id);
  assert.equal(session.submission.turnId, null);
  controller.notification({ method: 'turn/started', params: { threadId: session.threadId, turn: { id: 'compact-1' } } });
  controller.notification({ method: 'thread/compacted', params: { threadId: session.threadId, turnId: 'compact-1' } });
  assert.equal(controller.busy, null);
  assert.equal(session.submission.state, 'completed');
  assert.match(session.notice, /Context compacted/);
  const items = JSON.stringify(session.items);
  await controller.compact(session.id);
  controller.notification({ method: 'turn/started', params: { threadId: session.threadId, turn: { id: 'compact-2' } } });
  complete(controller, session, 'compact-2');
  assert.equal(controller.busy, null);
  assert.equal(session.submission.turnId, 'compact-2');
  assert.equal(JSON.stringify(session.items), items);
});

test('Jev direct answers drain through settle', async t => {
  const { controller, fake, smartRouter } = await setup(t);
  const session = controller.create();
  await controller.send({ id: session.id, text: 'first', mode: 'terra-light' });
  await controller.send({ id: session.id, text: 'quick', mode: 'auto' });
  await controller.send({ id: session.id, text: 'third', mode: 'terra-light' });
  smartRouter.choose = async () => ({
    id: 'terra-light', provider: 'codex', model: 'gpt-5.6-terra', effort: 'low', label: 'Terra light', images: true,
    source: 'jev', directAnswer: 'Yes.',
  });
  complete(controller, session, fake.turnIds[0]);
  await flush();
  assert.equal(session.items.some(item => item.text === 'Yes.'), true);
  assert.equal(fake.turnIds.length, 2);
  assert.equal(session.queue.length, 0);
  assert.match(fake.calls.filter(call => call.method === 'turn/start').at(-1).params.input[0].text, /Current user request:\nthird$/);
  assert.equal(session.tasks.length, 2, 'only the worker turns are tracked');
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

async function until(fn) {
  for (let i = 0; i < 40; i++) {
    if (fn()) return;
    await new Promise(setImmediate);
  }
  throw new Error('condition was not reached');
}

function reopen(controller, options) {
  const filename = controller.filename;
  const workspace = controller.data.settings.workspace;
  controller.close();
  return new Controller(filename, workspace, new Fake(), { cancel() {}, close() {}, jev: null, async choose() { throw new Error('unexpected route'); } }, options);
}

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

test('default tracking ignores classification, legacy Auto tracks, and direct answers are not tasks', async t => {
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
  smartRouter.choose = async () => ({ directAnswer: 'Just a definition.', provider: 'codex', model: 'gpt-5.6-terra', effort: 'low' });
  await controller.send({ id: session.id, text: 'what is a mutex', mode: 'auto', task: 'auto' });
  assert.equal(session.tasks.length, 2);
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

test('successful checks schedule one internal wiki assessment; failures and unverified tasks never do', async t => {
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
  assert.equal(task.wikiMaintenance.state, 'running');
  assert.equal(fake.turnIds.length, 2);
  assert.equal(session.tasks.length, 1);
  assert.equal(controller.busy, session.id);
  const maintenance = fake.calls.filter(c => c.method === 'turn/start').at(-1).params;
  assert.match(maintenance.input[0].text, /EVERY requirement/);
  assert.match(maintenance.input[0].text, /incomplete evidence means no wiki edits/);
  assert.match(maintenance.input[0].text, /Do not change project instructions/);
  assert.equal(await controller.maintainWiki(session, task), false, 'never dispatch twice');
  complete(controller, session, fake.turnIds[1]);
  assert.equal(task.wikiMaintenance.state, 'finished');
  assert.equal(controller.busy, null);
  for (const state of ['not-checked', 'blocked', 'needs-you', 'cancelled']) {
    assert.equal(await controller.maintainWiki(session, { ...task, state, wikiMaintenance: null }), false);
  }
  task.wikiMaintenance.state = 'running';
  controller.save();
  const restored = reopen(controller);
  t.after(() => restored.close());
  assert.equal(restored.data.sessions[0].tasks[0].wikiMaintenance.state, 'interrupted');
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
  await until(() => controller.gate && session.tasks[0].state === 'checking');
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
  const model = fake.calls.find(call => call.method === 'turn/start').params.model;
  complete(controller, session, fake.turnIds[0]);
  await until(() => fake.turnIds.length === 2);
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
  await until(() => session.tasks[0].state === 'checking');
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
    return { result: 'ok' };
  };
  await controller.send({ id: session.id, text: 'build', mode: 'claude-cli:sonnet', task: 'off' });
  assert.deepEqual(results, [true, true, false, true]);
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
  const routers = [];
  smartRouter.choose = async (_text, session) => {
    routers.push(session.routerChoice.id);
    if (session.routerChoice.provider === 'claude-cli') throw Object.assign(new Error('Smart routing stopped: limit'), { limit: { until: null, reason: 'limit' }, limitProvider: 'claude-cli' });
    return { ...session.routingCatalog.find(p => (p.provider || 'codex') === 'codex'), source: 'model', reason: 'test' };
  };
  const session = controller.create();
  await controller.send({ id: session.id, text: 'hi', mode: 'auto', task: 'off' });
  assert.equal(routers[0], 'claude-cli:haiku');
  assert.ok(routers[1] && !routers[1].startsWith('claude-cli:'));
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

test('Codex usage windows are shown and a full window marks the limit until its reset', async t => {
  const { controller } = await setup(t);
  const resetsAt = Math.floor(Date.now() / 1000) + 600;
  controller.notification({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt }, secondary: null } } });
  assert.equal(controller.snapshot().providerUsage.codex.primary.usedPercent, 42);
  assert.equal(controller.limits.limited('codex'), null);
  controller.notification({ method: 'account/rateLimits/updated', params: { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300, resetsAt } } } });
  assert.equal(controller.limits.limited('codex').until, resetsAt * 1000);
  assert.equal(controller.snapshot().providerUsage.codex.primary.usedPercent, 100);
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
  assert.equal(controller.snapshot().providerUsage.codex.secondary.usedPercent, 10);
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
