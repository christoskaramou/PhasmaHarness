const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Controller } = require('../src/controller.cjs');

class Fake extends EventEmitter {
  constructor() { super(); this.calls = []; this.seq = 0; this.turnIds = []; }
  async start() { }
  async call(method, params) {
    this.calls.push({ method, params });
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
    return {};
  }
  respond() { }
  rejectRequest() { }
  close() { }
}

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-harness-test-'));
  const fake = new Fake();
  const smartRouter = { calls: [], cancel() { }, close() { }, jev: null, async choose() { throw new Error('unexpected route'); } };
  const controller = new Controller(path.join(directory, 'state.json'), directory, fake, smartRouter);
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
  assert.deepEqual(fake.calls.filter(call => call.method === 'turn/start').map(call => call.params.input[0].text), ['first', 'second', 'third']);
});
