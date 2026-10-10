const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { JevKey } = require('./jev-key.cjs');
const { LocalModels } = require('./local-models.cjs');

function validateProvider(value) {
  if (!value || !/^[a-z][a-z0-9-]{0,39}$/.test(value.id) || ['codex', 'claude-cli', 'cursor-cli'].includes(value.id)) throw new Error('Use a provider ID containing lowercase letters, numbers and hyphens.');
  const url = new URL(value.baseUrl);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('Use HTTPS, or HTTP for a local provider.');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80) throw new Error('Enter a provider name.');
  return { id: value.id, name: value.name.trim(), baseUrl: url.href.replace(/\/$/, ''), enabled: value.enabled !== false };
}

function validateModel(value, providers) {
  if (!value || !providers.some(p => p.id === value.provider)) throw new Error('Select an existing provider.');
  if (typeof value.model !== 'string' || !(value.provider === 'cursor-cli' ? /^[\w.:[\],=+-]{1,240}$/ : /^[\w./:@-]{1,160}$/).test(value.model)) throw new Error('Enter a valid model ID.');
  if (!['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh'].includes(value.effort || '')) throw new Error('Invalid effort.');
  if (typeof value.label !== 'string' || !value.label.trim() || value.label.length > 100 || typeof value.description !== 'string' || value.description.length > 800) throw new Error('Enter a model label and a description up to 800 characters.');
  if (!Number.isFinite(value.rank) || value.rank < 0 || value.rank > 1000) throw new Error('Model order must be between 0 and 1,000.');
  if (value.provider === 'cursor-cli' && value.effort) throw new Error('Cursor effort is part of its model ID. Choose Provider default.');
  const effort = value.effort || null;
  return { id: `${value.provider}:${value.model}:${effort || 'default'}`, provider: value.provider, model: value.model, label: value.label.trim(), effort,
    description: value.description.trim(), rank: value.rank, enabled: value.enabled !== false, router: value.router !== false, worker: value.worker !== false, images: value.images === true };
}

class Providers {
  constructor(directory, encryption, getProviders, fetcher = fetch) {
    this.directory = directory; this.encryption = encryption; this.getProviders = getProviders; this.fetch = fetcher;
    this.token = randomBytes(32).toString('hex'); this.modelEfforts = new Map();
    this.local = new LocalModels(this);
  }
  key(id) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(id)) throw new Error('Invalid provider ID.');
    return new JevKey(path.join(this.directory, `${id}.enc`), this.encryption, id);
  }
  configured(id) { return this.key(id).configured; }
  provider(id) {
    const provider = this.getProviders().find(p => p.id === id);
    if (!provider?.enabled) throw new Error('Provider is disabled or missing.');
    return validateProvider(provider);
  }
  async models(id) {
    const p = this.provider(id);
    const response = await this.fetch(`${p.baseUrl}/models`, { headers: this.headers(id), redirect: 'error', signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Model discovery failed (HTTP ${response.status}). Check the endpoint and key.`);
    const body = await response.json();
    if (!Array.isArray(body.data)) throw new Error('This endpoint did not return a compatible model list. Enter a model ID manually.');
    return body.data.slice(0, 1000).map(m => m.id).filter(id => typeof id === 'string' && /^[\w./:@-]{1,160}$/.test(id) && !id.startsWith('phasma-harness/'));
  }
  headers(id) { return { 'Content-Type': 'application/json', ...(this.configured(id) ? { Authorization: `Bearer ${this.key(id).read()}` } : {}) }; }
  async start() {
    this.server = http.createServer((req, res) => this.forward(req, res));
    this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening');
    this.base = `http://127.0.0.1:${this.server.address().port}/${this.token}`;
  }
  setModel(choice) { if (choice?.provider && choice.provider !== 'codex') this.modelEfforts.set(`${choice.provider}:${choice.model}`, choice.effort || null); }
  prepare(choice, signal) { return this.local.prepare(choice, signal); }
  config(choice) {
    this.setModel(choice);
    if (!choice?.provider || choice.provider === 'codex') return { modelProvider: 'openai', config: {} };
    const p = this.provider(choice.provider);
    const context = this.local.cached(choice)?.contextLength;
    return { modelProvider: `phasma_${p.id}`, config: { [`model_providers.phasma_${p.id}`]: {
      name: p.name, base_url: `${this.base}/${p.id}/v1`, wire_api: 'responses', requires_openai_auth: false,
      supports_websockets: false, request_max_retries: 0, stream_max_retries: 0,
    }, ...(context ? { model_context_window: context, model_auto_compact_token_limit: Math.floor(context * 0.75) } : {}), web_search: 'disabled', model_supports_reasoning_summaries: false, 'features.code_mode.enabled': false, 'features.multi_agent': false, 'features.apps': false, 'features.plugins': false, 'features.remote_plugin': false } };
  }
  async structured(choice, { instructions, prompt, schema, images = [] }, signal) {
    signal.throwIfAborted();
    const local = await this.local.inspect(choice, signal);
    if (!local.supported) return null;
    const p = this.provider(choice.provider);
    const body = { model: choice.model, stream: false,
      messages: [{ role: 'system', content: instructions + '\nReturn only JSON matching this schema: ' + JSON.stringify(schema) },
        { role: 'user', content: [{ type: 'text', text: prompt }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))] }],
      response_format: local.kind === 'llama.cpp' ? { type: 'json_schema', schema } : { type: 'json_schema', json_schema: { name: 'harness_response', strict: true, schema } },
      ...(choice.effort ? { reasoning_effort: choice.effort } : {}) };
    return this.local.exclusive(choice, async () => {
      const response = await this.modelRequest(choice, body, local, signal, 'chat/completions');
      if (!response.ok) throw new Error((await response.json()).error.message);
      let result;
      try { result = await response.json(); }
      catch { signal.throwIfAborted(); throw new Error(`${p.name} returned an invalid structured response. No action was taken. Try another model.`); }
      signal.throwIfAborted();
      if (result.choices?.[0]?.finish_reason !== 'stop') throw new Error(`${p.name} returned an incomplete response. No action was taken. Shorten the request or try another model.`);
      const usage = result.usage ? { inputTokens: result.usage.prompt_tokens || 0,
        cachedInputTokens: result.usage.prompt_tokens_details?.cached_tokens || 0, outputTokens: result.usage.completion_tokens || 0 } : null;
      try { return { decision: require('./structured.cjs').structuredResponse(result.choices[0].message?.content, schema), usage }; }
      catch (error) { throw Object.assign(error, { usage }); }
    }, signal);
  }
  async modelRequest(choice, body, local, signal, endpoint = 'responses') {
    const p = this.provider(choice.provider);
    let loaded;
    if (local.supported) {
      // Image bytes are not text tokens; both inference APIs reserve context for the actual prompt and schema.
      const prompt = JSON.stringify(body, (key, value) => ['image_url', 'image', 'file_data'].includes(key) ? undefined : value);
      const minimum = Math.max(32768, 2 ** Math.ceil(Math.log2(Buffer.byteLength(prompt) / 3 + 4096)));
      loaded = await this.local.load(choice, signal, Math.min(minimum, 262144));
      signal.throwIfAborted();
      body.model = loaded.runtimeModel;
      const limit = endpoint === 'responses' ? 'max_output_tokens' : 'max_tokens';
      body[limit] = Math.min(body[limit] || 4096, 4096, Math.floor(loaded.contextLength / 4));
    }
    const send = () => this.fetch(`${p.baseUrl}/${endpoint}`, { method: 'POST', headers: this.headers(p.id), body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]) });
    let response = await send();
    let message = `Provider request failed (HTTP ${response.status}). Check model compatibility, key and API balance.`;
    if (!response.ok && local.supported) {
      const error = (await response.text()).slice(0, 16384);
      const required = Number(error.match(/request \((\d+) tokens\)/i)?.[1] || error.match(/"n_prompt_tokens"\s*:\s*(\d+)/)?.[1]);
      if (loaded.canResize && required > 0 && required + 4096 > loaded.contextLength) {
        const larger = await this.local.load(choice, signal, Math.min(262144, 2 ** Math.ceil(Math.log2(required + 4096))));
        signal.throwIfAborted();
        if (larger.contextLength > loaded.contextLength) { body.model = larger.runtimeModel; loaded = larger; response = await send(); }
      }
      message = /context|n_ctx|token.*limit/i.test(error)
        ? `${p.name}: this request exceeds the model's context. ${loaded.canResize ? 'Compact the conversation, shorten the message, or choose a larger-context model.' : 'Increase the server context size, or compact the conversation.'}`
        : `${p.name}: request failed (HTTP ${response.status}). Check the model and server.`;
    }
    return response.ok ? response : new Response(JSON.stringify({ error: { message } }), { status: response.status, headers: { 'Content-Type': 'application/json' } });
  }
  async forward(req, res) {
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const parts = (req.url || '').split('/');
      if (parts[1] !== this.token || req.headers.origin || req.method !== 'POST' || parts.slice(3).join('/') !== 'v1/responses') { res.writeHead(403).end(); return; }
      const p = this.provider(parts[2]);
      const chunks = []; let size = 0;
      for await (const chunk of req) { size += chunk.length; if (size > 32 * 1024 * 1024) throw new Error('Request too large'); chunks.push(chunk); }
      const body = JSON.parse(Buffer.concat(chunks));
      // Provider reasoning state and server IDs are not portable between model vendors.
      if (Array.isArray(body.input)) body.input = body.input.filter(i => !['reasoning', 'item_reference'].includes(i.type)).map(i => {
        const { id, namespace, ...item } = i;
        if (namespace && item.name) item.name = `${namespace}__${item.name}`;
        if (item.type === 'custom_tool_call') { item.type = 'function_call'; item.arguments = JSON.stringify({ input: item.input }); delete item.input; }
        if (item.type === 'custom_tool_call_output') item.type = 'function_call_output';
        return item;
      });
      if (Array.isArray(body.tools)) body.tools = body.tools.filter(t => t.type === 'function');
      if (this.modelEfforts.get(`${p.id}:${body.model}`) === null) delete body.reasoning;
      delete body.previous_response_id; delete body.service_tier; delete body.prompt_cache_key; delete body.include;
      if (body.text) delete body.text.verbosity;
      body.store = false;
      const choice = { provider: p.id, model: body.model };
      const local = await this.local.inspect(choice, abort.signal);
      const forward = async () => {
        const response = await this.modelRequest(choice, body, local, abort.signal);
        if (!response.ok) { res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(await response.text()); return; }
        res.writeHead(200, { 'Content-Type': response.headers.get('content-type') || 'text/event-stream' });
        for await (const chunk of response.body) { if (!res.write(Buffer.from(chunk))) await once(res, 'drain', { signal: abort.signal }); }
        res.end();
      };
      if (local.supported) await this.local.exclusive(choice, forward, abort.signal);
      else await forward();
    } catch {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Provider connection failed or returned an incompatible response.' } }));
      else res.destroy();
    }
  }
  close() { this.server?.closeAllConnections(); this.server?.close(); }
}

module.exports = { Providers, validateProvider, validateModel };
