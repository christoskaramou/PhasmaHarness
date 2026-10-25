const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SmartRouter } = require('../src/routing/smart-router.cjs');
const { structuredResponse, invalidResponse } = require('../src/providers/structured.cjs');

const schema = { type: 'object', properties: { preset: { type: 'string', enum: ['allowed'] }, reason: { type: 'string', minLength: 1, maxLength: 40 } }, required: ['preset', 'reason'], additionalProperties: false };
const valid = { preset: 'allowed', reason: 'A bounded task' };
const request = { instructions: 'Choose a worker; never execute the task.', prompt: 'Untrusted request data', schema };

test('structured responses validate the entire document without repairing action arguments', () => {
  for (const value of [valid, JSON.stringify(valid), '```json\n' + JSON.stringify(valid) + '\n```']) assert.deepEqual(structuredResponse(value, schema), valid);
  for (const value of ['I will read private-file.cpp', 'Here is the result: ' + JSON.stringify(valid), '{"reason":"C:\\Private"}', [], null,
    { ...valid, preset: 'unavailable' }, { ...valid, reason: 42 }, { ...valid, reason: 'x'.repeat(41) }, { preset: 'allowed' }, { ...valid, action: 'delete' }]) {
    assert.throws(() => structuredResponse(value, schema), error => {
      assert.equal(error.code, 'INVALID_STRUCTURED_RESPONSE');
      assert.doesNotMatch(error.message, /private-file|Private|Unexpected token/);
      return true;
    });
  }
  const actionSchema = { type: 'object', properties: { action: { anyOf: [{ type: 'null' }, { type: 'object', properties: {
    line: { type: 'integer', minimum: 1 }, gaps: { type: 'array', items: { type: 'string' } },
  }, required: ['line', 'gaps'], additionalProperties: false }] } }, required: ['action'], additionalProperties: false };
  for (const action of [null, { line: 1, gaps: [] }, { line: 2, gaps: ['missing evidence'] }]) assert.deepEqual(structuredResponse({ action }, actionSchema), { action });
  for (const action of [{ line: 0, gaps: [] }, { line: 1.5, gaps: [] }, { line: 1, gaps: [5] }, '{"line":1}', {}]) assert.throws(() => structuredResponse({ action }, actionSchema));
  assert.throws(() => structuredResponse(valid, { ...schema, oneOf: [] }), /Unsupported.*schema/);
});

function adapter(provider, respond) {
  const calls = [];
  const router = new SmartRouter(__dirname);
  const choice = { provider, model: 'test-router', effort: 'medium' };
  if (provider === 'local') router.providers = { structured: async (_choice, options, signal) => {
    calls.push({ ...options, signal });
    return respond(calls.length, options, signal);
  } };
  else router[provider === 'cursor-cli' ? 'cursor' : 'claude'] = { run: async options => {
    calls.push(options);
    const result = await respond(calls.length, options, options.signal);
    return { result: result.decision, usage: result.usage };
  } };
  return { router, calls, choice };
}

test('CLI and local responses get one format retry, preserve the request and count both calls', async t => {
  for (const provider of ['cursor-cli', 'claude-cli', 'local']) await t.test(provider, async () => {
    const { router, calls, choice } = adapter(provider, async (n, _options, signal) => {
      assert.equal(signal.aborted, false);
      if (provider === 'local' && n === 1) throw Object.assign(invalidResponse(), { usage: { inputTokens: 10 } });
      return { decision: n === 1 ? "I'll read the repository" : valid, usage: { inputTokens: 10 } };
    });
    const result = await router.complete(request, choice, new AbortController());
    assert.deepEqual(result.decision, valid);
    assert.equal(result.timing.attempts, 2);
    assert.equal(result.usage.inputTokens, 20);
    assert.equal(calls.length, 2);
    assert.match(calls[1].prompt, /previous response did not match/);
    if (calls[1].instructions) assert.equal(calls[1].instructions, request.instructions);
    assert.match(calls[1].prompt, /Untrusted request data/);
    assert.deepEqual(calls[1].schema, schema);
    assert.equal(calls[1].signal, calls[0].signal, 'one deadline covers both attempts');
  });
});

test('two malformed replies stop cleanly, with no prose leaked and no third attempt', async () => {
  const { router, calls, choice } = adapter('cursor-cli', async () => ({ decision: 'secret provider text' }));
  await assert.rejects(router.complete(request, choice, new AbortController()), error => {
    assert.equal(error.code, 'INVALID_STRUCTURED_RESPONSE');
    assert.doesNotMatch(error.message, /secret|Unexpected token/);
    return true;
  });
  assert.equal(calls.length, 2);
});

test('Stop and usage limits never trigger a structured-output retry', async () => {
  const abort = new AbortController();
  const stopped = adapter('cursor-cli', async () => { abort.abort(); return { decision: 'invalid' }; });
  await assert.rejects(stopped.router.complete(request, stopped.choice, abort), { name: 'AbortError' });
  assert.equal(stopped.calls.length, 1);
  const limit = Object.assign(new Error('Quota reached'), { limit: { until: null } });
  const limited = adapter('claude-cli', async () => { throw limit; });
  await assert.rejects(limited.router.complete(request, limited.choice, new AbortController()), error => error === limit);
  assert.equal(limited.calls.length, 1);
});

test('the deadline includes retries and cancels providers even when they never settle', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let first;
  const { router, calls, choice } = adapter('cursor-cli', async n => n === 1 ? new Promise(resolve => { first = resolve; }) : new Promise(() => {}));
  const pending = router.complete({ ...request, timeoutMs: 50 }, choice, new AbortController());
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  await new Promise(setImmediate);
  t.mock.timers.tick(30);
  first({ decision: 'invalid' });
  await new Promise(setImmediate);
  assert.equal(calls.length, 2);
  t.mock.timers.tick(20);
  await rejected;
  assert.equal(calls[1].signal.aborted, true);
  assert.equal(router.timeoutMs, 180000);
});

test('an idle deadline permits active reasoning beyond the wall deadline and ignores activity after completion', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let finish;
  const { router, calls, choice } = adapter('cursor-cli', () => new Promise(resolve => { finish = resolve; }));
  const pending = router.complete({ ...request, timeoutMs: 50, idleTimeout: true }, choice, new AbortController());
  await new Promise(setImmediate);
  for (let i = 0; i < 5; i++) {
    t.mock.timers.tick(40);
    calls[0].onActivity();
    assert.equal(calls[0].signal.aborted, false, 'ongoing output is not a hung provider');
  }
  finish({ decision: valid });
  assert.deepEqual((await pending).decision, valid);
  calls[0].onActivity();
  t.mock.timers.tick(1000);
  assert.equal(calls[0].signal.aborted, false, 'late activity cannot resurrect the cleared timer');
});

test('idle deadlines still stop silent providers and user Stop wins over continuing activity', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const stop of [false, true]) {
    const abort = new AbortController();
    const { router, calls, choice } = adapter('cursor-cli', () => new Promise(() => {}));
    const pending = router.complete({ ...request, timeoutMs: 50, idleTimeout: true }, choice, abort);
    const rejected = assert.rejects(pending, { name: stop ? 'AbortError' : 'TimeoutError' });
    await new Promise(setImmediate);
    t.mock.timers.tick(40); calls[0].onActivity();
    t.mock.timers.tick(40);
    assert.equal(calls[0].signal.aborted, false);
    if (stop) abort.abort();
    else t.mock.timers.tick(10);
    calls[0].onActivity();
    await rejected;
    assert.equal(calls[0].signal.aborted, true);
    assert.equal(calls.length, 1, 'a stopped request is never retried');
  }
});

test('CLI answer and thinking deltas renew idle time, but metadata and empty chunks do not', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { router, calls, choice } = adapter('claude-cli', () => new Promise(() => {}));
  const pending = router.complete({ ...request, timeoutMs: 50, idleTimeout: true }, choice, new AbortController());
  const rejected = assert.rejects(pending, { name: 'TimeoutError' });
  await new Promise(setImmediate);
  for (const event of [
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'progress' } } },
    { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '{' } } },
    { type: 'assistant', message: { content: [{ type: 'text', text: '}' }] } },
  ]) {
    t.mock.timers.tick(40); calls[0].onEvent(event);
    assert.equal(calls[0].signal.aborted, false);
  }
  t.mock.timers.tick(40);
  calls[0].onEvent({ type: 'system' });
  calls[0].onEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '' } } });
  t.mock.timers.tick(10);
  await rejected;
});

test('Codex responses use the same validation and retry and release their listeners', async t => {
  const client = new EventEmitter();
  client.start = async () => {};
  client.close = () => {};
  let turns = 0;
  client.call = async method => {
    if (method === 'config/read') return { config: {} };
    if (method === 'thread/start') return { thread: { id: 'router-test' } };
    if (method === 'turn/start') {
      turns++;
      queueMicrotask(() => {
        client.emit('notification', { method: 'item/completed', params: { threadId: 'router-test', item: { type: 'agentMessage', text: turns === 1 ? '{broken' : JSON.stringify(valid) } } });
        client.emit('notification', { method: 'turn/completed', params: { threadId: 'router-test', turn: { status: 'completed' } } });
      });
    }
    return {};
  };
  const router = new SmartRouter(__dirname, () => client);
  t.after(() => router.close());
  const result = await router.complete(request, { provider: 'codex', model: 'test' }, new AbortController());
  assert.deepEqual(result.decision, valid);
  assert.equal(turns, 2);
  assert.equal(client.listenerCount('notification'), 0);
});

test('only the active Codex thread can renew a structured review deadline', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const threadId of ['active', 'unrelated']) {
    const client = new EventEmitter(); client.start = async () => {}; client.close = () => {};
    client.call = async method => method === 'config/read' ? { config: {} }
      : method === 'thread/start' ? { thread: { id: 'active' } } : {};
    const router = new SmartRouter(__dirname, () => client);
    const pending = router.complete({ ...request, timeoutMs: 50, idleTimeout: true }, { provider: 'codex', model: 'test' }, new AbortController());
    const rejected = threadId === 'unrelated' ? assert.rejects(pending, { name: 'TimeoutError' }) : null;
    await new Promise(setImmediate);
    for (const method of ['item/reasoning/summaryTextDelta', 'item/reasoning/textDelta', 'item/agentMessage/delta']) {
      t.mock.timers.tick(40);
      client.emit('notification', { method, params: { threadId, delta: 'progress' } });
      if (rejected) break;
    }
    if (rejected) { t.mock.timers.tick(10); await rejected; }
    else {
      client.emit('notification', { method: 'item/completed', params: { threadId, item: { type: 'agentMessage', text: JSON.stringify(valid) } } });
      client.emit('notification', { method: 'turn/completed', params: { threadId, turn: { status: 'completed' } } });
      assert.deepEqual((await pending).decision, valid);
    }
    assert.equal(client.listenerCount('notification'), 0);
    router.close();
  }
});
