'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Providers } = require('../src/providers/providers.cjs');
const { once } = require('node:events');
const { Writable } = require('node:stream');

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
function lm({ context = 8192, max = 131072, fail = false, response } = {}) {
  let instance = context ? { id: 'gemma', config: { context_length: context, flash_attention: true } } : null;
  const fixture = setup((endpoint, body) => {
    if (endpoint === '/api/v1/models') return json({ models: [{ key: 'gemma', type: 'llm', max_context_length: max, loaded_instances: instance ? [instance] : [] }] });
    if (endpoint === '/api/v1/models/unload') { assert.equal(body.instance_id, instance.id); instance = null; return json({}); }
    if (endpoint === '/api/v1/models/load') {
      if (fail) return json({ error: 'not enough memory, private server details' }, 500);
      instance = { id: 'gemma-runtime', config: { context_length: body.context_length } };
      return json({ status: 'loaded', instance_id: instance.id });
    }
    if (endpoint === '/v1/responses') return response ? response(body) : new Response('data: {"type":"response.completed"}\n\n', { headers: { 'content-type': 'text/event-stream' } });
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
  assert.equal(providers.config(choice).config.model_context_window, 32768);
  assert.equal(providers.config(choice).config.model_auto_compact_token_limit, 24576);
  await providers.prepare(choice);
  assert.equal(calls.filter(c => c.endpoint === '/api/v1/models/load').length, 1);
  await providers.local.unload(choice);
  assert.equal((await providers.local.status(choice)).loaded, false);
  await providers.prepare(choice);
  assert.equal((await providers.local.status(choice)).contextLength, 32768);
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
  assert.equal(providers.config(choice).config.model_context_window, undefined);
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
  assert.equal(providers.config(choice).config.model_context_window, 8192);
  await providers.local.unload(choice); assert.equal(loaded, false);
});

async function forward(providers, body) {
  const { Readable } = require('node:stream');
  const req = Readable.from([Buffer.from(JSON.stringify({ model: 'gemma', ...body }))]);
  req.url = `/${providers.token}/local/v1/responses`; req.method = 'POST'; req.headers = {};
  let output = '';
  const res = new Writable({ write(chunk, _encoding, callback) { output += chunk; callback(); } });
  res.writeHead = function (status) { this.status = status; this.headersSent = true; return this; };
  const finished = once(res, 'finish');
  await providers.forward(req, res); await finished;
  return { status: res.status, output };
}

test('Responses proxy loads before forwarding and strips portable state as before', async () => {
  const { providers, calls } = lm({ context: null });
  const res = await forward(providers, { input: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'input_text', text: 'hey' }] }], previous_response_id: 'old' });
  assert.equal(res.status, 200);
  const forwarded = calls.find(c => c.endpoint === '/v1/responses').body;
  assert.equal(forwarded.model, 'gemma-runtime'); assert.equal(forwarded.input.length, 1);
  assert.equal(forwarded.previous_response_id, undefined); assert.equal(forwarded.max_output_tokens, 4096);
});

test('large prompts grow context, while base64 image bytes do not drive model allocation', async () => {
  const large = lm({ context: 32768 });
  assert.equal((await forward(large.providers, { input: 'a'.repeat(150000) })).status, 200);
  assert.equal(large.calls.find(c => c.endpoint === '/api/v1/models/load').body.context_length, 65536);
  const image = lm({ context: 32768 });
  await forward(image.providers, { input: [{ type: 'message', content: [{ type: 'input_image', image_url: 'data:image/png;base64,' + 'a'.repeat(500000) }] }] });
  assert.equal(image.calls.some(c => c.endpoint === '/api/v1/models/load'), false);
});

test('HTTP context overflow retries once at a larger context and model limits give an actionable error', async () => {
  let attempts = 0;
  const overflowing = () => json({ error: { message: 'request (50000 tokens) exceeds the available context size (32768 tokens)' } }, 400);
  const fixture = lm({ context: 32768, response: () => ++attempts === 1 ? overflowing() : new Response('done') });
  assert.equal((await forward(fixture.providers, { input: 'hey' })).status, 200);
  assert.equal(attempts, 2);
  assert.equal(fixture.calls.find(c => c.endpoint === '/api/v1/models/load').body.context_length, 65536);
  const limited = lm({ context: 32768, max: 32768, response: overflowing });
  const result = await forward(limited.providers, { input: 'hey' });
  assert.equal(result.status, 400); assert.match(result.output, /Compact the conversation/);
  assert.equal(limited.calls.filter(c => c.endpoint === '/v1/responses').length, 1);
});

test('Ollama cloud-backed models never create a local context preset or change the request model', async () => {
  const { providers, calls } = setup((endpoint) => {
    if (endpoint === '/api/version') return json({ version: '0.13.3' });
    if (endpoint === '/api/tags') return json({ models: [{ name: 'gemma:latest', digest: 'cloud-alias' }] });
    if (endpoint === '/api/show') return json({ remote_host: 'https://ollama.com', remote_model: 'gemma:cloud' });
    if (endpoint === '/v1/responses') return new Response('done');
  });
  assert.equal((await providers.prepare(choice)).supported, false);
  assert.equal((await forward(providers, { input: 'hello' })).status, 200);
  assert.equal(calls.find(c => c.endpoint === '/v1/responses').body.model, 'gemma');
  assert.equal(calls.some(c => ['/api/create', '/api/generate'].includes(c.endpoint)), false);
});
