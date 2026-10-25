const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { EventEmitter } = require('node:events');
const { SmartRouter, conversationDelta } = require('../src/routing/smart-router.cjs');
const { Providers } = require('../src/providers/providers.cjs');
const { cacheRequest, cacheUsage } = require('../src/providers/prompt-cache.cjs');
const { pruneCodex, pruneClaude, RETENTION_MS } = require('../src/providers/conversation-retention.cjs');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cache-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const schema = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'], additionalProperties: false };
const signal = () => new AbortController();
const policy = 'Follow the original request and never use tools. '.repeat(120);

for (const provider of ['claude-cli', 'cursor-cli', 'native:deepseek']) test(`${provider}: 100 Main messages reuse one session, including a Harness restart`, async t => {
  const root = directory(t), calls = [], context = { conversation: [], agents: [{ name: 'Bot' }] };
  let state, router, nextId = 0;
  const runtime = { run: async options => {
    calls.push(options);
    const session_id = options.resume || `session-${++nextId}`;
    options.onEvent({ type: 'system', session_id });
    return { session_id, result: '{"reply":"ok"}' };
  } };
  const create = () => {
    router = new SmartRouter(root);
    router.claude = router.cursor = runtime;
    router.nativeCLIs = new Map([[provider, runtime]]);
  };
  create();
  const ask = (instructions = policy, model = 'test') => router.complete({ instructions, schema, prompt: JSON.stringify(context),
    conversation: { key: 'chat', context, state, save: value => { state = JSON.parse(JSON.stringify(value)); } } }, { provider, model }, signal());
  let beforeBytes = 0;
  for (let i = 0; i < 100; i++) {
    context.conversation.push({ id: String(i), role: 'user', text: `Request ${i}: ` + 'Long conversation data. '.repeat(30) });
    beforeBytes += Buffer.byteLength(policy + JSON.stringify(context));
    if (i === 50) { router.close(); create(); }
    await ask();
  }
  assert.equal(calls.length, 100);
  assert.equal(nextId, 1);
  assert.ok(calls.slice(1).every(call => call.resume === 'session-1' && !call.prompt.includes(policy)));
  assert.ok(calls.every(call => call.persistSession && call.schema === schema && !call.helpers));
  assert.ok(calls.slice(1).every(call => JSON.parse(call.prompt).newMessages.length === 1));
  assert.ok(calls.reduce((n, call) => n + Buffer.byteLength(call.prompt), 0) < beforeBytes / 20, 'new input text grows linearly, not by replaying the whole chat each time');
  await ask(policy + ' Updated rule.'); assert.equal(nextId, 2);
  await ask(policy + ' Updated rule.', 'other-model'); assert.equal(nextId, 3);
  context.conversation = [{ id: 'fresh', text: 'Cleared' }]; await ask(); assert.equal(nextId, 4);
  runtime.run = async () => { throw new Error('Connection failed'); };
  await assert.rejects(ask(), /Connection failed/); assert.equal(state, null, 'uncertain native state is never reused silently');
  router.close();
});

test('edited earlier messages invalidate a Main continuation even when the last ID matches', () => {
  const before = { conversation: [{ id: 'a', text: 'one' }, { id: 'b', text: 'two' }] };
  assert.equal(conversationDelta(before, { conversation: [{ id: 'a', text: 'changed' }, before.conversation[1]] }), null);
  assert.equal(conversationDelta(null, before), null);
  assert.equal(conversationDelta({ conversation: 'damaged' }, before), null);
});

test('an incomplete saved Main cache rebuilds from chat history instead of sending a context-free delta', async t => {
  const router = new SmartRouter(directory(t)), calls = [];
  let state;
  router.cursor = { run: async options => { calls.push(options); return { session_id: 'saved', result: '{"reply":"ok"}' }; } };
  const context = { conversation: [{ id: 'first', text: 'Keep this request.' }] };
  const ask = () => router.complete({ instructions: policy, schema, prompt: JSON.stringify(context),
    conversation: { key: 'damaged', context, state, save: value => { state = structuredClone(value); } } }, { provider: 'cursor-cli', model: 'test' }, signal());
  await ask(); router.close(); delete state.sessionId;
  context.conversation.push({ id: 'next', text: 'Continue' });
  await ask();
  assert.equal(calls[1].resume, undefined);
  assert.ok(calls[1].prompt.includes(policy) && calls[1].prompt.includes('Keep this request.'));
  router.close();
});

test('a new same-sized image with identical trailing bytes is delivered to a resumed Main session', async t => {
  const router = new SmartRouter(directory(t)), calls = [];
  router.cursor = { run: async options => { calls.push(options); return { session_id: 'image-chat', result: '{"reply":"ok"}' }; } };
  const tail = 'x'.repeat(80), first = 'AAAA' + tail, second = 'BBBB' + tail;
  const context = { conversation: [{ id: 'image-request', text: 'Inspect it' }] };
  const ask = images => router.complete({ instructions: policy, schema, prompt: JSON.stringify(context), images,
    conversation: { key: 'images', context } }, { provider: 'cursor-cli', model: 'test' }, signal());
  await ask([first]); await ask([first]); await ask([second]);
  assert.deepEqual(calls[1].images, []);
  assert.deepEqual(calls[2].images, [second]);
  router.close();
});

test('API Main keeps an append-only prefix across 100 replies and restart; changes refresh its system policy', async t => {
  const root = directory(t), requests = [], headers = [];
  const providers = new Providers(root, null, () => [{ id: 'api', name: 'API', enabled: true, baseUrl: 'https://api.openai.com/v1' }], async (_url, options) => {
    requests.push(JSON.parse(options.body)); headers.push(options.headers);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"reply":"ok"}' } }],
      usage: { prompt_tokens: 2000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: requests.length > 1 ? 1800 : 0 } } });
  });
  providers.headers = () => ({});
  providers.local = { inspect: async () => ({ supported: false }), exclusive: async (_choice, fn) => fn() };
  let router, state;
  const create = () => { router = new SmartRouter(root); router.providers = providers; };
  create();
  const context = { conversation: [], agents: ['one'] };
  const ask = instructions => router.complete({ instructions, schema, prompt: JSON.stringify(context),
    conversation: { key: 'api-chat', context, state, save: value => { state = structuredClone(value); } } }, { provider: 'api', model: 'test' }, signal());
  for (let i = 0; i < 100; i++) {
    if (i === 50) { router.close(); create(); }
    context.conversation.push({ id: String(i), text: 'Question ' + i });
    const result = await ask(policy);
    assert.equal(result.usage.cachedInputTokens, i ? 1800 : 0);
    const current = requests.at(-1);
    assert.equal(current.messages.length, 2 + i * 2);
    if (i) assert.deepEqual(current.messages.slice(0, -2), requests[i - 1].messages);
    assert.equal(current.messages.filter(m => m.role === 'system').length, 1);
    assert.equal(current.prompt_cache_key, requests[0].prompt_cache_key);
  }
  await ask('New policy.');
  assert.equal(requests.at(-1).messages.length, 2);
  assert.match(requests.at(-1).messages[0].content, /^New policy/);
});

test('only documented API endpoints receive cache hints, and caller history remains unmodified', () => {
  const body = { model: 'anthropic/claude-sonnet-4', messages: [{ role: 'system', content: 'Stable rules' }] };
  for (const endpoint of ['https://api.deepseek.com', 'http://localhost:1234/v1', 'https://api.openai.com.example.com/v1', 'https://custom.example/v1'])
    assert.deepEqual(cacheRequest(endpoint, body, 'secret-chat'), { body, headers: {} });
  const openai = cacheRequest('https://api.openai.com/v1', body, 'chat');
  assert.equal(openai.body.prompt_cache_key.length, 64);
  assert.notEqual(openai.body.prompt_cache_key, cacheRequest('https://api.openai.com/v1', body, 'another').body.prompt_cache_key);
  assert.equal(cacheRequest('https://api.x.ai/v1', body, 'chat').headers['x-grok-conv-id'], openai.body.prompt_cache_key);
  const anthropic = cacheRequest('https://openrouter.ai/api/v1', body, 'chat').body;
  assert.equal(anthropic.session_id, openai.body.prompt_cache_key);
  assert.deepEqual(anthropic.cache_control, { type: 'ephemeral' });
  assert.equal(cacheRequest('https://openrouter.ai/api/v1', { ...body, model: 'deepseek/deepseek-chat' }, 'chat').body.cache_control, undefined);
  const qwen = cacheRequest('https://openrouter.ai/api/v1', { ...body, model: 'qwen/qwen3-coder-plus',
    messages: [...body.messages, { role: 'user', content: 'old question' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'new question' }] }, 'chat').body;
  assert.deepEqual(qwen.messages[0].content[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(qwen.messages.at(-1).content[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(qwen.messages[1].content[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(cacheRequest('https://openrouter.ai/api/v1', { ...body, model: 'qwen/qwen3.5-plus-02-15' }, 'chat').body.messages, body.messages);
  assert.equal(body.messages[0].content, 'Stable rules');
});

test('independent API routing and improvement calls share a stable cache hint without sharing chat history', async t => {
  const requests = [];
  const providers = new Providers(directory(t), null, () => [{ id: 'api', name: 'API', enabled: true, baseUrl: 'https://api.openai.com/v1' }], async (_url, options) => {
    requests.push(JSON.parse(options.body));
    return Response.json({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{"reply":"ok"}' } }] });
  });
  providers.headers = () => ({});
  providers.local = { inspect: async () => ({ supported: false }), exclusive: async (_choice, fn) => fn() };
  for (const prompt of ['First private chat', 'Different private chat'])
    await providers.structured({ provider: 'api', model: 'test' }, { instructions: policy, schema, prompt }, signal().signal);
  assert.equal(requests[0].prompt_cache_key, requests[1].prompt_cache_key);
  assert.equal(requests[1].messages.length, 2);
  assert.ok(!JSON.stringify(requests[1]).includes('First private chat'));
});

test('usage retains unknown cache counts and validates provider-reported reads/writes', () => {
  assert.equal(cacheUsage({ prompt_tokens: 200, completion_tokens: 5 }).cachedInputTokens, null);
  assert.equal(cacheUsage({ prompt_tokens: 200, completion_tokens: 5, prompt_cache_hit_tokens: 180 }).cachedInputTokens, 180);
  assert.equal(cacheUsage({ prompt_tokens: 200, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 999 } }).cachedInputTokens, null);
  assert.equal(cacheUsage({ prompt_tokens: -1, completion_tokens: 5 }), null);
  const usage = cacheUsage({ prompt_tokens: 200, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 150, cache_write_tokens: 40 } });
  assert.equal(usage.cacheWriteInputTokens, 40);
});

for (const missing of [false, true]) test(`Codex Main restart: missing thread ${missing}, restrictions and timing survive`, async t => {
  const root = directory(t), calls = [];
  class Client extends EventEmitter {
    async start() {} close() {}
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/start') return { thread: { id: 'kept' } };
      if (method === 'thread/resume' && missing) throw new Error('thread not found');
      if (method === 'turn/start') queueMicrotask(() => {
        this.emit('notification', { method: 'item/completed', params: { threadId: params.threadId, item: { type: 'agentMessage', text: '{"reply":"ok"}' } } });
        this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { status: 'completed' } } });
      });
      return {};
    }
  }
  let state;
  const context = { conversation: [{ id: 'one', text: 'Remember me' }] };
  const ask = router => router.complete({ instructions: policy, schema, prompt: JSON.stringify(context),
    conversation: { key: 'chat', context, state, save: value => { state = structuredClone(value); } } }, { provider: 'codex', model: 'test' }, signal());
  let router = new SmartRouter(root, () => new Client()); await ask(router); router.close();
  context.conversation.push({ id: 'two', text: 'Continue' });
  router = new SmartRouter(root, () => new Client()); const result = await ask(router); router.close();
  for (const value of Object.values(result.timing)) assert.ok(Number.isFinite(value) && value >= 0);
  assert.equal(calls.filter(call => call.method === 'thread/start').length, missing ? 2 : 1);
  const resume = calls.find(call => call.method === 'thread/resume').params;
  assert.equal(resume.threadId, 'kept'); assert.equal(resume.config['features.shell_tool'], false);
  assert.equal(resume.approvalPolicy, 'never'); assert.equal(resume.sandbox, 'read-only');
  assert.equal(calls.find(call => call.method === 'thread/start').params.ephemeral, false);
  const last = JSON.parse(calls.findLast(call => call.method === 'turn/start').params.input[0].text);
  assert.equal(missing ? last.conversation.length : last.newMessages.length, missing ? 2 : 1);
});

for (const provider of ['claude-cli', 'cursor-cli', 'native:deepseek', 'api']) test(`${provider}: repaired Main response keeps the normal instruction fingerprint`, async t => {
  const root = directory(t), router = new SmartRouter(root), calls = [];
  const context = { conversation: [] }; let state, serial = 0;
  const native = { run: async options => {
    calls.push(options);
    return { session_id: options.resume || `session-${++serial}`, result: calls.length === 2 ? 'invalid JSON' : '{"reply":"ok"}' };
  } };
  router.claude = router.cursor = native; router.nativeCLIs = new Map([[provider, native]]);
  router.providers = { structured: async (_choice, options) => {
    calls.push(options);
    if (calls.length === 2) throw require('../src/providers/structured.cjs').invalidResponse();
    return { decision: { reply: 'ok' }, messages: [...(options.messages || [{ role: 'system', content: options.instructions },
      { role: 'user', content: options.prompt }]), { role: 'assistant', content: '{"reply":"ok"}' }] };
  } };
  const ask = text => {
    context.conversation.push({ id: String(context.conversation.length), text });
    return router.complete({ instructions: policy, prompt: JSON.stringify(context), schema,
      conversation: { key: 'repair', context, state, save: value => { state = structuredClone(value); } } }, { provider, model: 'test' }, signal());
  };
  await ask('Remember this'); const fingerprint = state.fingerprint;
  await ask('Repair this'); assert.equal(state.fingerprint, fingerprint);
  assert.match(calls[2].prompt, /previous response did not match/);
  if (provider !== 'api') {
    assert.equal(calls[2].resume, calls[1].resume, 'repair continues the native session that accepted the request');
    assert.doesNotMatch(calls[2].prompt, /Repair this|Remember this/, 'only a format correction is sent, not the original message again');
  }
  if (provider === 'api') {
    assert.equal(calls[2].messages.length, 4, 'repair reuses the accepted prefix instead of starting over');
    assert.equal(calls[2].messages.filter(message => /Repair this/.test(JSON.stringify(message.content))).length, 1);
  }
  await ask('Continue normally'); assert.equal(state.fingerprint, fingerprint);
  if (provider === 'api') assert.ok(calls[3].messages.length > 3);
  else assert.equal(calls[3].resume, state.sessionId);
  assert.doesNotMatch(calls[3].prompt, /previous response did not match/);
  router.close();
});

test('group context excludes progress before clipping and sends no repeated instructions or empty preamble', () => {
  const { context } = require('../src/group-chats.cjs');
  const agents = { hubName: () => 'Main Bot' };
  const session = { title: 'Team', items: [{ id: 'request', type: 'userMessage', text: 'Original request' },
    ...Array.from({ length: 45 }, (_, i) => ({ id: `progress-${i}`, type: 'agentMessage', phase: 'commentary', text: `Progress ${i}` })),
    { id: 'answer', type: 'agentMessage', text: 'Final answer' }, { id: 'next', type: 'userMessage', text: 'Follow up' }] };
  const text = context(agents, session, 'next');
  assert.match(text, /Original request/); assert.match(text, /Final answer/);
  assert.doesNotMatch(text, /Progress|Reply here as yourself|Do not delegate/);
  assert.equal(context(agents, session, 'next', 'answer'), '');
});

for (const provider of ['claude-cli', 'cursor-cli', 'native:deepseek']) test(`${provider}: first-response repair retains accepted input and exhausted repair clears stale continuation`, async t => {
  const router = new SmartRouter(directory(t)), calls = []; let state, fail = false;
  const runtime = { run: async options => {
    calls.push(options); options.onEvent({ type: 'system', session_id: 'accepted' });
    return { result: fail || calls.length === 1 ? 'invalid' : '{"reply":"ok"}' };
  } };
  router.claude = router.cursor = runtime; router.nativeCLIs = new Map([[provider, runtime]]);
  const context = { conversation: [{ id: 'first', text: 'Only one copy of my request' }] };
  const ask = () => router.complete({ instructions: policy, schema, prompt: JSON.stringify(context), images: ['test-image'],
    conversation: { key: 'first-repair', context, state, save: value => { state = structuredClone(value); } } }, { provider, model: 'test' }, signal());
  await ask();
  assert.equal(calls.length, 2); assert.equal(calls[1].resume, 'accepted');
  assert.doesNotMatch(calls[1].prompt, /Only one copy/);
  assert.deepEqual(calls[1].images, [], 'repair does not resend accepted attachments');
  fail = true;
  await assert.rejects(ask(), /invalid.*response/i);
  assert.equal(calls.length, 4); assert.equal(state, null); assert.equal(router.conversations.has('first-repair'), false);
  fail = false; await ask();
  assert.equal(calls[4].resume, undefined, 'a later explicit request cannot resurrect invalidated saved state');
  assert.match(calls[4].prompt, /Only one copy/);
  router.close();
});

test('a runtime that rejects invalid JSON after its turn (DeepSeek) is repaired in that session without resending the request', async t => {
  const router = new SmartRouter(directory(t)), calls = [];
  let state;
  const runtime = { run: async options => {
    calls.push(options);
    const id = options.resume || 'accepted';
    options.onEvent({ type: 'system', session_id: id });
    if (calls.length === 2) throw require('../src/providers/structured.cjs').invalidResponse();
    return { session_id: id, result: '{"reply":"ok"}' };
  } };
  router.nativeCLIs = new Map([['native:deepseek', runtime]]);
  const context = { conversation: [] };
  const ask = text => {
    context.conversation.push({ id: String(context.conversation.length), text });
    return router.complete({ instructions: policy, schema, prompt: JSON.stringify(context),
      conversation: { key: 'deepseek-repair', context, state, save: value => { state = structuredClone(value); } } }, { provider: 'native:deepseek', model: 'test' }, signal());
  };
  await ask('First request'); await ask('Second request');
  assert.equal(calls.length, 3);
  assert.equal(calls[2].resume, 'accepted');
  assert.match(calls[2].prompt, /previous response did not match/);
  assert.doesNotMatch(calls[2].prompt, /Second request/, 'the accepted request is not sent twice');
  await ask('Third request');
  assert.equal(calls[3].resume, 'accepted');
  assert.deepEqual(JSON.parse(calls[3].prompt).newMessages.map(message => message.text), ['Third request']);
  router.close();
});

test('Claude Main starts over with the full context when its saved transcript was deleted', async t => {
  const root = directory(t), calls = [];
  let state, serial = 0, router;
  const claude = { run: async options => {
    calls.push(options);
    if (options.resume === 'deleted') throw new Error('No conversation found with session ID: deleted');
    const id = options.resume || `fresh-${++serial}`;
    options.onEvent({ type: 'system', session_id: id });
    return { session_id: id, result: '{"reply":"ok"}' };
  } };
  const context = { conversation: [{ id: 'one', text: 'Earlier request' }] };
  const create = () => { router = new SmartRouter(root); router.claude = claude; };
  const ask = () => router.complete({ instructions: policy, schema, prompt: JSON.stringify(context),
    conversation: { key: 'claude-chat', context, state, save: value => { state = structuredClone(value); } } }, { provider: 'claude-cli', model: 'test' }, signal());
  create(); await ask(); router.close();
  state.sessionId = 'deleted';
  context.conversation.push({ id: 'two', text: 'After a month' });
  create(); await ask();
  assert.equal(calls.length, 3);
  assert.equal(calls[1].resume, 'deleted');
  assert.equal(calls[2].resume, undefined);
  for (const text of [policy, 'Earlier request', 'After a month']) assert.ok(calls[2].prompt.includes(text));
  assert.equal(state.sessionId, 'fresh-2');
  router.close();
});

test('Codex JSON repair is a conversation message, so the next normal request reuses the same thread', async t => {
  const calls = [], context = { conversation: [] }; let turns = 0, starts = 0, state;
  class Client extends EventEmitter {
    async start() {} close() {}
    async call(method, params) {
      calls.push({ method, params });
      if (method === 'config/read') return { config: {} };
      if (method === 'thread/start') return { thread: { id: `thread-${++starts}` } };
      if (method === 'turn/start') queueMicrotask(() => {
        this.emit('notification', { method: 'item/completed', params: { threadId: params.threadId,
          item: { type: 'agentMessage', text: ++turns === 2 ? 'invalid' : '{"reply":"ok"}' } } });
        this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { status: 'completed' } } });
      });
      return {};
    }
  }
  const router = new SmartRouter(directory(t), () => new Client());
  for (const text of ['First', 'Repair', 'Continue']) {
    context.conversation.push({ id: text, text });
    await router.complete({ instructions: policy, schema, prompt: JSON.stringify(context),
      conversation: { key: 'chat', context, state, save: value => { state = structuredClone(value); } } }, { provider: 'codex', model: 'test' }, signal());
  }
  assert.equal(starts, 1); assert.equal(turns, 4);
  const prompts = calls.filter(call => call.method === 'turn/start').map(call => call.params.input[0].text);
  assert.match(prompts[2], /previous response did not match/);
  assert.doesNotMatch(prompts[3], /previous response did not match/);
  router.close();
});

test('retention errors warn once per day and do not change saved Main references', async t => {
  const router = new SmartRouter(directory(t)), saved = [{ threadId: 'keep' }], warnings = [];
  router.savedConversations = () => saved; router.retentionWarning = error => warnings.push(error.message);
  let calls = 0;
  const client = { call: async () => { calls++; throw new Error('Unsupported cleanup'); } };
  await router.pruneConversations('codex', client);
  await router.pruneConversations('codex', client);
  assert.equal(calls, 1); assert.deepEqual(warnings, ['Unsupported cleanup']);
  assert.deepEqual(saved, [{ threadId: 'keep' }]);
});

test('a slow retention lookup remains inside Main timeout and cannot start inference after cancellation', async t => {
  let started = false;
  class Client extends EventEmitter {
    async start() {} close() {}
    async call(method) {
      if (method === 'thread/list') return new Promise(() => {});
      if (method === 'turn/start') started = true;
      return {};
    }
  }
  const router = new SmartRouter(directory(t), () => new Client());
  router.savedConversations = () => [];
  await assert.rejects(router.complete({ instructions: policy, prompt: '{}', schema, timeoutMs: 10,
    conversation: { key: 'stop', context: { conversation: [] } } }, { provider: 'codex', model: 'test' }, signal()), /too long/);
  assert.equal(started, false); router.close();
});

test('Main transcript retention preserves live, pinned, recent and unrelated Codex threads across pages', async t => {
  const root = directory(t), now = Date.now(), deleted = [], lists = [];
  const old = { cwd: root, updatedAt: (now - RETENTION_MS - 10000) / 1000, status: { type: 'notLoaded' }, isPinned: false };
  const client = { call: async (method, params) => {
    if (method === 'thread/delete') { deleted.push(params.threadId); return {}; }
    lists.push(params);
    if (params.archived) return { data: [{ ...old, id: 'archived-old' }] };
    if (params.cursor) return { data: [{ ...old, id: 'page-two' }] };
    return { nextCursor: 'next', data: [{ ...old, id: 'obsolete' }, { ...old, id: 'kept' },
      { ...old, id: 'pinned', isPinned: true }, { ...old, id: 'active', status: { type: 'active' } },
      { ...old, id: 'recent', updatedAt: now / 1000 }, { ...old, id: 'unknown-age', updatedAt: null },
      { ...old, id: 'unrelated', cwd: path.join(root, 'different') }] };
  } };
  await pruneCodex(client, root, new Set(['kept']), now);
  assert.deepEqual(deleted, ['obsolete', 'page-two', 'archived-old']);
  assert.ok(lists.every(params => params.cwd === root));
  await assert.rejects(pruneCodex({ call: async () => { throw new Error('Deletion unsupported'); } }, root, new Set()), /unsupported/);
});

test('Codex retention cleans old router threads without a pin flag (0.163, 0.164) and keeps ones filed in a section', async t => {
  const root = directory(t), deleted = [];
  const old = { cwd: root, updatedAt: 1, status: { type: 'notLoaded' }, section: null };
  const client = { call: async (method, params) => {
    if (method === 'thread/delete') { deleted.push(params.threadId); return {}; }
    return params.archived ? { data: [] } : { data: [{ ...old, id: 'obsolete' },
      { ...old, id: 'sectioned', section: { id: 'section-1', name: 'Keep' } }, { ...old, id: 'pinned', isPinned: true }] };
  } };
  await pruneCodex(client, root, new Set());
  assert.deepEqual(deleted, ['obsolete']);
});

test('Claude retention removes only old unused router transcripts with matching ownership; corrupt and nested records survive', t => {
  const root = directory(t), home = path.join(root, 'claude'), workspace = path.join(root, 'router'); fs.mkdirSync(workspace);
  const bucket = path.join(home, 'projects', fs.realpathSync(workspace).replace(/[^a-zA-Z0-9]/g, '-')); fs.mkdirSync(bucket, { recursive: true });
  const now = Date.now(), old = new Date(now - RETENTION_MS - 10000), files = {};
  for (const name of ['obsolete', 'large', 'kept', 'recent', 'unrelated', 'corrupt', 'nested']) {
    const id = require('node:crypto').randomUUID(), file = path.join(bucket, id + '.jsonl'); files[name] = { id, file };
    fs.writeFileSync(file, name === 'corrupt' ? '{broken' : JSON.stringify({ sessionId: id, cwd: name === 'unrelated' ? root : workspace }) + '\n');
    if (name === 'large') fs.writeFileSync(file, JSON.stringify({ attachment: 'x'.repeat(150000) }) + '\n' + JSON.stringify({ sessionId: id, cwd: workspace }) + '\n');
    if (name !== 'recent') fs.utimesSync(file, old, old);
    if (name === 'nested') fs.mkdirSync(path.join(bucket, id));
  }
  pruneClaude(workspace, new Set([files.kept.id]), home, now);
  for (const [name, value] of Object.entries(files)) assert.equal(fs.existsSync(value.file), !['obsolete', 'large'].includes(name), name);
});
