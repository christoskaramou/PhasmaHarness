const path = require('node:path');
const { createHash } = require('node:crypto');
const { JevKey } = require('./jev-key.cjs');
const { LocalModels } = require('./local-models.cjs');
const { capabilities } = require('./capabilities.cjs');
const { cacheRequest, cacheUsage } = require('./prompt-cache.cjs');

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
    const response = await this.fetch(`${p.baseUrl}/models`, { headers: this.headers(id), redirect: 'error', signal: AbortSignal.timeout(15000) })
      .catch(error => {
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(p.baseUrl).hostname);
        const next = local ? 'Start it, then click Renew.' : 'Check the URL and your connection, then click Renew.';
        throw new Error(`${p.name} is not reachable at ${p.baseUrl} (${error.message}). ${next}`);
      });
    if (!response.ok) throw new Error(`Model discovery failed (HTTP ${response.status}). Check the endpoint and key.`);
    const body = await response.json();
    if (!Array.isArray(body.data)) throw new Error('This endpoint did not return a compatible model list. Enter a model ID manually.');
    return body.data.slice(0, 1000).map(m => m.id).filter(id => typeof id === 'string' && /^[\w./:@-]{1,160}$/.test(id) && !id.startsWith('phasma-harness/'));
  }
  headers(id) { return { 'Content-Type': 'application/json', ...(this.configured(id) ? { Authorization: `Bearer ${this.key(id).read()}` } : {}) }; }
  prepare(choice, signal) { return this.local.prepare(choice, signal); }
  // Only Codex turns load Codex threads; API providers run in src/providers/api-agent.cjs.
  config() { return { modelProvider: 'openai', config: {} }; }
  async structured(choice, { instructions, prompt, schema, images = [], messages, cacheKey }, signal) {
    signal.throwIfAborted();
    // Codex and the CLI providers answer through their own runtimes; only API providers have an endpoint here.
    if (!capabilities(choice.provider).api)
      return null;

    const local = await this.local.inspect(choice, signal);
    const p = this.provider(choice.provider);
    // Remote OpenAI-compatible APIs (DeepSeek and others) reliably accept JSON mode; the schema is in the prompt and
    // structuredResponse validates the result. Local servers take the schema itself.
    const format = !local.supported ? { type: 'json_object' } : local.kind === 'llama.cpp' ? { type: 'json_schema', schema }
      : { type: 'json_schema', json_schema: { name: 'harness_response', strict: true, schema } };
    const body = { model: choice.model, stream: false,
      messages: messages || [{ role: 'system', content: instructions + '\nReturn only JSON matching this schema: ' + JSON.stringify(schema) },
        { role: 'user', content: [{ type: 'text', text: prompt }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))] }],
      response_format: format,
      ...(choice.effort ? { reasoning_effort: choice.effort } : {}) };
    return this.local.exclusive(choice, async () => {
      const requestKey = cacheKey || createHash('sha256').update(JSON.stringify([choice.provider, choice.model, instructions, schema])).digest('hex');
      const response = await this.modelRequest(choice, body, local, signal, 'chat/completions', requestKey);
      if (!response.ok) throw new Error((await response.json()).error.message);
      let result;
      try { result = await response.json(); }
      catch { signal.throwIfAborted(); throw new Error(`${p.name} returned an invalid structured response. No action was taken. Try another model.`); }
      signal.throwIfAborted();
      if (result.choices?.[0]?.finish_reason !== 'stop') throw new Error(`${p.name} returned an incomplete response. No action was taken. Shorten the request or try another model.`);
      const usage = cacheUsage(result.usage);
      try { return { decision: require('./structured.cjs').structuredResponse(result.choices[0].message?.content, schema), usage,
        ...(cacheKey ? { messages: [...body.messages, result.choices[0].message] } : {}) }; }
      catch (error) { throw Object.assign(error, { usage }); }
    }, signal);
  }
  async modelRequest(choice, body, local, signal, endpoint, cacheKey) {
    const p = this.provider(choice.provider);
    let loaded;
    if (local.supported) {
      // Image bytes are not text tokens; context is reserved for the actual prompt and schema.
      const prompt = JSON.stringify(body, (key, value) => ['image_url', 'image', 'file_data'].includes(key) ? undefined : value);
      const minimum = Math.max(32768, 2 ** Math.ceil(Math.log2(Buffer.byteLength(prompt) / 3 + 4096)));
      loaded = await this.local.load(choice, signal, Math.min(minimum, 262144));
      signal.throwIfAborted();
      body.model = loaded.runtimeModel;
      body.max_tokens = Math.min(body.max_tokens || 4096, 4096, Math.floor(loaded.contextLength / 4));
    }
    const send = () => {
      const cached = cacheRequest(p.baseUrl, body, cacheKey);
      return this.fetch(`${p.baseUrl}/${endpoint}`, { method: 'POST', headers: { ...this.headers(p.id), ...cached.headers }, body: JSON.stringify(cached.body), redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(600000)]) });
    };
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
}

module.exports = { Providers, validateProvider, validateModel };
