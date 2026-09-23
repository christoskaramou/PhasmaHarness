const path = require('node:path');
const http = require('node:http');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const { JevKey } = require('./jev-key.cjs');

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
    return body.data.slice(0, 1000).map(m => m.id).filter(id => typeof id === 'string' && /^[\w./:@-]{1,160}$/.test(id));
  }
  headers(id) { return { 'Content-Type': 'application/json', ...(this.configured(id) ? { Authorization: `Bearer ${this.key(id).read()}` } : {}) }; }
  async start() {
    this.server = http.createServer((req, res) => this.forward(req, res));
    this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening');
    this.base = `http://127.0.0.1:${this.server.address().port}/${this.token}`;
  }
  setModel(choice) { if (choice?.provider && choice.provider !== 'codex') this.modelEfforts.set(`${choice.provider}:${choice.model}`, choice.effort || null); }
  config(choice) {
    this.setModel(choice);
    if (!choice?.provider || choice.provider === 'codex') return { modelProvider: 'openai', config: {} };
    const p = this.provider(choice.provider);
    return { modelProvider: `phasma_${p.id}`, config: { [`model_providers.phasma_${p.id}`]: {
      name: p.name, base_url: `${this.base}/${p.id}/v1`, wire_api: 'responses', requires_openai_auth: false,
      supports_websockets: false, request_max_retries: 0, stream_max_retries: 0,
    }, web_search: 'disabled', model_supports_reasoning_summaries: false, 'features.code_mode.enabled': false, 'features.multi_agent': false, 'features.apps': false, 'features.plugins': false, 'features.remote_plugin': false } };
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
      const response = await this.fetch(`${p.baseUrl}/responses`, { method: 'POST', headers: this.headers(p.id), body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(600000)]) });
      if (!response.ok) { res.writeHead(response.status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: `Provider request failed (HTTP ${response.status}). Check model compatibility, key and API balance.` } })); return; }
      res.writeHead(200, { 'Content-Type': response.headers.get('content-type') || 'text/event-stream' });
      for await (const chunk of response.body) { if (!res.write(Buffer.from(chunk))) await once(res, 'drain', { signal: abort.signal }); }
      res.end();
    } catch {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: { message: 'Provider connection failed or returned an incompatible response.' } }));
      else res.destroy();
    }
  }
  close() { this.server?.closeAllConnections(); this.server?.close(); }
}

module.exports = { Providers, validateProvider, validateModel };
