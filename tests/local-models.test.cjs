'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Providers } = require('../src/providers/providers.cjs');

const choice = { provider: 'local', model: 'gemma' };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function setup(handler) {
  const calls = [];
  const provider = { id: 'local', name: 'Local', baseUrl: 'http://localhost:1234/prefix/v1', enabled: true };
  const providers = new Providers('', {}, () => [provider], async (url, options) => {
    assert.equal(options.redirect, 'error');
    const endpoint = url.replace('http://localhost:1234/prefix', '');
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ endpoint, body });
    return await handler(endpoint, body, options) || json({}, 404);
  });
  providers.configured = () => false;
  return { providers, calls, provider };
}
function lm({ context = 8192, max = 131072, fail = false, chat } = {}) {
  let instance = context ? { id: 'gemma', config: { context_length: context, flash_attention: true } } : null;
  const fixture = setup((endpoint, body) => {
    if (endpoint === '/api/v1/models') return json({ models: [{ key: 'gemma', type: 'llm', max_context_length: max, loaded_instances: instance ? [instance] : [] }] });
    if (endpoint === '/api/v1/models/unload') { assert.equal(body.instance_id, instance.id); instance = null; return json({}); }
    if (endpoint === '/api/v1/models/load') {
      if (fail) return json({ error: 'not enough memory, private server details' }, 500);
      instance = { id: 'gemma-runtime', config: { context_length: body.context_length } };
      return json({ status: 'loaded', instance_id: instance.id });
    }
    if (endpoint === '/v1/chat/completions' && chat) return chat(body);
  });
  return { ...fixture, evict: () => { instance = null; } };
}

test('LM Studio reloads 8k to 32k, preserves settings, uses the returned instance and configures compaction', async () => {
  const { providers, calls } = lm();
  const before = await providers.local.status(choice);
  assert.equal(before.loaded, true); assert.equal(before.contextLength, 8192);
  assert.equal(calls.some(c => c.body), false, 'status never loads a model');
  const result = await providers.prepare(choice);
  assert.equal(result.contextLength, 32768); assert.equal(result.runtimeModel, 'gemma-runtime');
  assert.equal(calls.find(c => c.endpoint === '/api/v1/models/load').body.flash_attention, true);
  await providers.prepare(choice);
  assert.equal(calls.filter(c => c.endpoint === '/api/v1/models/load').length, 1);
  await providers.local.unload(choice);
  assert.equal((await providers.local.status(choice)).loaded, false);
  await providers.prepare(choice);
  assert.equal((await providers.local.status(choice)).contextLength, 32768);
});

const hubSchema = { type: 'object', properties: { reply: { type: 'string' }, action: { type: 'null' } }, required: ['reply', 'action'], additionalProperties: false };
const hubRequest = { instructions: 'You are Hub. Only return the requested JSON.', prompt: 'Say hello.', schema: hubSchema, images: [] };
const hubReply = { reply: 'Hello!', action: null };
const completion = (content = JSON.stringify(hubReply), finish_reason = 'stop') => json({ choices: [{ finish_reason, message: { content } }], usage: { prompt_tokens: 32, completion_tokens: 16, prompt_tokens_details: { cached_tokens: 8 } } });

test('local structured inference uses the schema-enabled chat endpoint and prepared runtime model', async () => {
  const { providers, calls } = lm({ chat: () => completion() });
  const result = await providers.structured(choice, { ...hubRequest, images: ['data:image/png;base64,aGVsbG8='] }, new AbortController().signal);
  assert.deepEqual(result.decision, hubReply);
  assert.deepEqual(result.usage, { inputTokens: 32, cachedInputTokens: 8, outputTokens: 16 });
  const request = calls.find(c => c.endpoint === '/v1/chat/completions').body;
  assert.equal(request.model, 'gemma-runtime');
  assert.deepEqual(request.response_format, { type: 'json_schema', json_schema: { name: 'harness_response', strict: true, schema: hubSchema } });
  assert.equal(request.messages[0].role, 'system'); assert.match(request.messages[0].content, /You are Hub/);
  assert.deepEqual(request.messages[1], { role: 'user', content: [{ type: 'text', text: hubRequest.prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,aGVsbG8=' } }] });
  assert.equal(request.stream, false); assert.equal(request.max_tokens, 4096);
  assert.equal(request.tools, undefined); assert.equal(request.reasoning_effort, undefined);
  assert.equal(calls.some(c => c.endpoint === '/v1/responses'), false);
});

test('local structured usage preserves missing counters as unknown and accepts an explicit zero report', async () => {
  for (const usage of [undefined, {}, { prompt_tokens: 32 }, { prompt_tokens: -1, completion_tokens: 1 }]) {
    const { providers } = lm({ chat: () => json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(hubReply) } }], usage }) });
    const result = await providers.structured(choice, hubRequest, new AbortController().signal);
    assert.equal(result.usage, null);
  }
  const { providers } = lm({ chat: () => json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(hubReply) } }],
    usage: { prompt_tokens: 0, completion_tokens: 0 } }) });
  const result = await providers.structured(choice, hubRequest, new AbortController().signal);
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, cachedInputTokens: null });
});

test('local structured responses reject plain text and incomplete output without leaking model text', async () => {
  for (const chat of [() => completion('Hello! Private model text'), () => completion(JSON.stringify(hubReply), 'length')]) {
    const { providers } = lm({ chat });
    await assert.rejects(providers.structured(choice, hubRequest, new AbortController().signal), error => {
      assert.match(error.message, /structured response|incomplete response/);
      assert.doesNotMatch(error.message, /Private model text|Unexpected token/);
      return true;
    });
  }
});

test('local structured requests retain context growth, retry and Stop protection', async () => {
  let attempts = 0;
  const { providers, calls } = lm({ context: 32768, chat: () => ++attempts === 1
    ? json({ error: { message: 'request (50000 tokens) exceeds the available context size (32768 tokens)' } }, 400) : completion() });
  await providers.structured(choice, hubRequest, new AbortController().signal);
  assert.equal(attempts, 2);
  assert.equal(calls.find(c => c.endpoint === '/api/v1/models/load').body.context_length, 65536);
  const large = lm({ context: 32768, chat: () => completion() });
  await large.providers.structured(choice, { ...hubRequest, prompt: 'a'.repeat(150000) }, new AbortController().signal);
  assert.equal(large.calls.find(c => c.endpoint === '/api/v1/models/load').body.context_length, 65536);
  const abort = new AbortController(); abort.abort();
  const before = calls.length;
  await assert.rejects(providers.structured(choice, hubRequest, abort.signal), { name: 'AbortError' });
  assert.equal(calls.length, before);
});

test('structured inference retains the provider lock and discards replies after Stop', async () => {
  let started, release;
  const pending = new Promise(resolve => { started = resolve; });
  const fixture = lm({ chat: () => { started(); return new Promise(resolve => { release = resolve; }); } });
  const abort = new AbortController();
  const request = fixture.providers.structured(choice, hubRequest, abort.signal);
  await pending;
  await assert.rejects(fixture.providers.local.unload(choice), /finish before unloading/);
  const stopped = assert.rejects(request, { name: 'AbortError' });
  abort.abort(); release(completion());
  await stopped;
  await fixture.providers.local.exclusive(choice, () => {});
  assert.equal(fixture.providers.local.locks.size, 0);
});

test('structured inference uses each managed server format and JSON mode for hosted providers', async () => {
  for (const kind of ['ollama', 'llama.cpp']) {
    const { providers, calls } = setup(endpoint => endpoint === '/v1/chat/completions' ? completion() : null);
    const state = { supported: true, kind, runtimeModel: 'managed-local', contextLength: 32768 };
    providers.local.inspect = providers.local.load = async () => state;
    await providers.structured(choice, hubRequest, new AbortController().signal);
    const request = calls[0].body;
    assert.equal(request.model, 'managed-local');
    assert.deepEqual(kind === 'llama.cpp' ? request.response_format.schema : request.response_format.json_schema.schema, hubSchema);
  }
  // Hosted APIs (DeepSeek and others) are called directly instead of falling back to Codex.
  const hosted = setup(endpoint => endpoint === '/v1/chat/completions' ? completion() : null);
  await hosted.providers.structured(choice, hubRequest, new AbortController().signal);
  assert.deepEqual(hosted.calls.find(c => c.endpoint === '/v1/chat/completions').body.response_format, { type: 'json_object' });
});

test('larger loaded contexts are retained, small model limits are respected, eviction triggers reload', async () => {
  const larger = lm({ context: 65536 });
  assert.equal((await larger.providers.prepare(choice)).contextLength, 65536);
  assert.equal(larger.calls.some(c => c.body), false);
  const small = lm({ max: 16384 });
  assert.equal((await small.providers.prepare(choice)).contextLength, 16384);
  small.evict();
  await small.providers.prepare(choice);
  assert.equal(small.calls.filter(c => c.endpoint === '/api/v1/models/load').length, 2);
});

test('concurrent agents share preparation and unloading refuses an active provider', async () => {
  const { providers, calls } = lm({ context: null });
  await Promise.all([providers.prepare(choice), providers.prepare(choice)]);
  assert.equal(calls.filter(c => c.endpoint === '/api/v1/models/load').length, 1);
  let release, started;
  const entered = new Promise(resolve => { started = resolve; });
  const work = providers.local.exclusive(choice, () => { started(); return new Promise(resolve => { release = resolve; }); });
  await entered;
  await assert.rejects(providers.local.unload(choice), /finish before unloading/);
  const stop = new AbortController();
  const waiting = providers.prepare(choice, stop.signal); stop.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
  assert.equal(providers.local.locks.size, 1, 'Stop returns while the previous request keeps its lock');
  release(); await work; await new Promise(setImmediate);
  assert.equal(providers.local.locks.size, 0);
});

test('failed load is reported without private server data and is never marked loaded', async () => {
  const { providers } = lm({ context: null, fail: true });
  await assert.rejects(providers.prepare(choice), error => /memory/.test(error.message) && !/private/.test(error.message));
  assert.equal((await providers.local.status(choice)).loaded, false);
});

test('hosted and unsupported endpoints receive no management writes or context overrides', async () => {
  const { providers, calls } = setup(() => json({}, 404));
  assert.equal((await providers.prepare(choice)).supported, false);
  assert.equal(calls.length, 3);
  await providers.prepare(choice); assert.equal(calls.length, 3, 'unsupported detection is cached');
  assert.equal(calls.some(c => c.body), false);
  assert.equal((await providers.prepare({ provider: 'codex' })).supported, false);
});

test('Ollama creates a context preset without changing the original, loads and unloads it', async () => {
  let running = [], created;
  const { providers, calls } = setup((endpoint, body) => {
    if (endpoint === '/api/version') return json({ version: '0.13.3' });
    if (endpoint === '/api/tags') return json({ models: [{ name: 'gemma:latest', digest: 'abc' }] });
    if (endpoint === '/api/ps') return json({ models: running });
    if (endpoint === '/api/show') return json({ model_info: { 'gemma.context_length': 131072 } });
    if (endpoint === '/api/create') { created = body; return json({ status: 'success' }); }
    if (endpoint === '/api/generate') { running = body.keep_alive === 0 ? [] : [{ name: body.model, context_length: created.parameters.num_ctx }]; return json({ done: true }); }
  });
  const result = await providers.prepare(choice);
  assert.equal(result.contextLength, 32768); assert.match(result.runtimeModel, /^phasma-harness\/.+:ctx-32768$/);
  assert.equal(created.from, 'gemma:latest'); assert.notEqual(created.model, created.from);
  await providers.prepare(choice);
  assert.equal(calls.filter(c => c.endpoint === '/api/create').length, 1);
  await providers.local.unload(choice); assert.equal(running.length, 0);
  assert.equal(calls.some(c => c.endpoint.includes('delete') || c.endpoint.includes('pull')), false);
});

test('llama.cpp router loads/unloads and reports its real server context without claiming it can resize', async () => {
  let loaded = false;
  const { providers, calls } = setup((endpoint) => {
    if (endpoint === '/models') return json({ data: [{ id: 'gemma', status: { value: loaded ? 'loaded' : 'unloaded' } }] });
    if (endpoint.startsWith('/props?')) return json({ default_generation_settings: { n_ctx: 8192 } });
    if (endpoint === '/models/load') { loaded = true; return json({ success: true }); }
    if (endpoint === '/models/unload') { loaded = false; return json({ success: true }); }
  });
  assert.equal((await providers.local.status(choice)).loaded, false);
  assert.equal(calls.some(c => c.endpoint.startsWith('/props?')), false, 'status must not auto-load');
  const state = await providers.prepare(choice);
  assert.equal(state.canResize, false); assert.equal(state.contextLength, 8192);
  await providers.local.unload(choice); assert.equal(loaded, false);
});

async function request(providers, messages) {
  const signal = new AbortController().signal;
  const local = await providers.local.inspect(choice, signal);
  return providers.modelRequest(choice, { model: 'gemma', messages }, local, signal, 'chat/completions');
}

test('base64 image bytes do not drive model allocation', async () => {
  const { providers, calls } = lm({ context: 32768, chat: () => completion() });
  const image = { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'a'.repeat(500000) } };
  assert.equal((await request(providers, [{ role: 'user', content: [image] }])).status, 200);
  assert.equal(calls.some(c => c.endpoint === '/api/v1/models/load'), false);
});

test('a model at its context limit gets one request and an actionable error', async () => {
  const overflowing = () => json({ error: { message: 'request (50000 tokens) exceeds the available context size (32768 tokens)' } }, 400);
  const { providers, calls } = lm({ context: 32768, max: 32768, chat: overflowing });
  const response = await request(providers, [{ role: 'user', content: 'hey' }]);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /Compact the conversation/);
  assert.equal(calls.filter(c => c.endpoint === '/v1/chat/completions').length, 1);
});

test('Ollama cloud-backed models never create a local context preset or change the request model', async () => {
  const { providers, calls } = setup((endpoint) => {
    if (endpoint === '/api/version') return json({ version: '0.13.3' });
    if (endpoint === '/api/tags') return json({ models: [{ name: 'gemma:latest', digest: 'cloud-alias' }] });
    if (endpoint === '/api/show') return json({ remote_host: 'https://ollama.com', remote_model: 'gemma:cloud' });
    if (endpoint === '/v1/chat/completions') return completion();
  });
  assert.equal((await providers.prepare(choice)).supported, false);
  assert.equal((await request(providers, [{ role: 'user', content: 'hello' }])).status, 200);
  assert.equal(calls.find(c => c.endpoint === '/v1/chat/completions').body.model, 'gemma');
  assert.equal(calls.some(c => ['/api/create', '/api/generate'].includes(c.endpoint)), false);
});

