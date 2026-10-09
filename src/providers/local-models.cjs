'use strict';
const { createHash } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

const DEFAULT_CONTEXT = 32768;
const tokens = value => Number.isSafeInteger(value) && value > 0 ? value : null;
const unsupported = { supported: false };

// Shared by all agents: a provider cannot reload a model underneath an in-flight request.
class LocalModels {
  constructor(providers) {
    this.providers = providers;
    this.kinds = new Map(); this.states = new Map(); this.locks = new Map();
  }
  key(choice) { return `${this.providers.provider(choice.provider).baseUrl}|${choice.model}`; }
  cached(choice) { return choice?.provider && !['codex', 'claude-cli', 'cursor-cli'].includes(choice.provider) ? this.states.get(this.key(choice)) : null; }
  async request(p, endpoint, body, signal, optional = false) {
    const root = p.baseUrl.replace(/\/v1$/, '');
    let response;
    try { response = await this.providers.fetch(root + endpoint, {
      method: body ? 'POST' : 'GET', headers: this.providers.headers(p.id), redirect: 'error',
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.any([AbortSignal.timeout(body ? 180000 : 10000), ...(signal ? [signal] : [])]),
    }); } catch (error) { if (optional && !signal?.aborted) return null; throw error; }
    if (optional && !response.ok) return null;
    if (!response.ok) throw new Error(`${p.name}: model management failed (HTTP ${response.status}). Check that the server is running and the model fits in memory.`);
    try { return await response.json(); } catch (error) { if (optional) return null; throw error; }
  }
  async detect(p, signal) {
    const cached = this.kinds.get(p.baseUrl);
    if (cached && cached.until > Date.now()) return cached.kind;
    let kind = null;
    const lm = await this.request(p, '/api/v1/models', null, signal, true);
    if (Array.isArray(lm?.models) && lm.models.some(m => typeof m.key === 'string' && Array.isArray(m.loaded_instances))) kind = 'lm-studio';
    if (!kind) {
      const ollama = await this.request(p, '/api/version', null, signal, true);
      if (typeof ollama?.version === 'string') kind = 'ollama';
    }
    if (!kind) {
      const llama = await this.request(p, '/models', null, signal, true);
      if (Array.isArray(llama?.data) && llama.data.some(m => typeof m.id === 'string' && typeof m.status?.value === 'string')) kind = 'llama.cpp';
    }
    this.kinds.set(p.baseUrl, { kind, until: Date.now() + (kind ? 300000 : 10000) });
    return kind;
  }
  async inspect(choice, signal) {
    if (!choice?.provider || ['codex', 'claude-cli', 'cursor-cli'].includes(choice.provider)) return unsupported;
    if (typeof choice.model !== 'string' || !/^[\w./:@-]{1,160}$/.test(choice.model)) throw new Error('Invalid model ID.');
    const p = this.providers.provider(choice.provider), kind = await this.detect(p, signal);
    if (!kind) return unsupported;
    const state = { supported: true, kind, loaded: false, contextLength: null, canResize: kind !== 'llama.cpp', runtimeModel: choice.model };
    if (kind === 'lm-studio') {
      const body = await this.request(p, '/api/v1/models', null, signal);
      const model = body.models?.find(m => m.key === choice.model || m.loaded_instances?.some(i => i.id === choice.model));
      if (!model || model.type === 'embedding') throw new Error(`${p.name}: download the selected language model first.`);
      const instance = model.loaded_instances?.find(i => i.id === choice.model) || [...(model.loaded_instances || [])].sort((a, b) => b.config?.context_length - a.config?.context_length)[0];
      Object.assign(state, { modelKey: model.key, maxContextLength: tokens(model.max_context_length), instance,
        loaded: !!instance, runtimeModel: instance?.id || model.key, contextLength: tokens(instance?.config?.context_length) });
    } else if (kind === 'ollama') {
      const tags = await this.request(p, '/api/tags', null, signal);
      const name = choice.model.includes(':') ? choice.model : `${choice.model}:latest`;
      const model = tags.models?.find(m => m.name === name || m.model === name || m.name === choice.model);
      if (!model) throw new Error(`${p.name}: download the selected model first.`);
      if (model.remote_model || model.remote_host || /:.*cloud$/.test(name)) return unsupported;
      const info = await this.request(p, '/api/show', { model: name }, signal);
      if (info.remote_model || info.remote_host) return unsupported;
      state.maxContextLength = tokens(Object.entries(info.model_info || {}).find(([k]) => k.endsWith('.context_length'))?.[1]);
      const prefix = `phasma-harness/${createHash('sha256').update(`${name}:${model.digest}`).digest('hex').slice(0, 20)}:ctx-`;
      const running = await this.request(p, '/api/ps', null, signal);
      const instances = (running.models || []).filter(m => m.name === name || m.name?.startsWith(prefix));
      const managed = instances.filter(m => m.name.startsWith(prefix)).sort((a, b) => b.context_length - a.context_length)[0];
      const instance = managed || instances[0];
      Object.assign(state, { modelKey: name, aliasPrefix: prefix, managed: !!managed, instances,
        loaded: !!instance, runtimeModel: instance?.name || name, contextLength: tokens(instance?.context_length) });
    } else {
      const body = await this.request(p, '/models', null, signal);
      const model = body.data?.find(m => m.id === choice.model);
      if (!model) throw new Error(`${p.name}: add the selected model to the server first.`);
      state.loaded = model.status?.value === 'loaded';
      state.loading = model.status?.value === 'loading';
      if (state.loaded) {
        const props = await this.request(p, `/props?model=${encodeURIComponent(choice.model)}&autoload=false`, null, signal);
        state.contextLength = tokens(props.default_generation_settings?.n_ctx);
      }
    }
    this.states.set(this.key(choice), state);
    return state;
  }
  async status(choice) {
    const state = await this.inspect(choice);
    const p = this.providers.provider(choice.provider);
    return { supported: state.supported, loaded: state.loaded, contextLength: state.contextLength,
      canResize: state.canResize, busy: this.locks.has(p.baseUrl), loading: state.loading };
  }
  async exclusive(choice, action, signal) {
    signal?.throwIfAborted();
    const key = this.providers.provider(choice.provider).baseUrl;
    const previous = this.locks.get(key) || Promise.resolve();
    const work = previous.then(() => { signal?.throwIfAborted(); return action(); });
    const pending = work.then(() => {}, () => {});
    this.locks.set(key, pending);
    pending.then(() => { if (this.locks.get(key) === pending) this.locks.delete(key); });
    if (!signal) return work;
    return new Promise((resolve, reject) => {
      const stopped = () => reject(signal.reason);
      signal.addEventListener('abort', stopped, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', stopped));
      if (signal.aborted) stopped();
    });
  }
  async prepare(choice, signal, minimum = DEFAULT_CONTEXT) {
    if (!choice?.provider || ['codex', 'claude-cli', 'cursor-cli'].includes(choice.provider)) return unsupported;
    const result = await this.exclusive(choice, () => this.load(choice, signal, minimum), signal);
    signal?.throwIfAborted();
    return result;
  }
  async load(choice, signal, minimum = DEFAULT_CONTEXT) {
    let state = await this.inspect(choice, signal);
    if (!state.supported) return state;
    const p = this.providers.provider(choice.provider);
    const target = Math.min(state.maxContextLength || minimum, Math.max(minimum, state.contextLength || 0));
    if (state.loaded && state.contextLength >= target && (state.kind !== 'ollama' || state.managed)) return state;
    signal?.throwIfAborted();
    // Finish a started reload under the lock; Stop prevents the message but cannot cancel server allocation.
    signal = undefined;
    if (state.kind === 'lm-studio') {
      const settings = Object.fromEntries(['eval_batch_size', 'flash_attention', 'num_experts', 'offload_kv_cache_to_gpu']
        .filter(k => state.instance?.config?.[k] !== undefined).map(k => [k, state.instance.config[k]]));
      if (state.instance) await this.request(p, '/api/v1/models/unload', { instance_id: state.instance.id }, signal);
      const loaded = await this.request(p, '/api/v1/models/load', { model: state.modelKey, ...settings, context_length: target, echo_load_config: true }, signal);
      if (loaded.status !== 'loaded') throw new Error(`${p.name}: model loading did not complete.`);
      // The load API can choose a new instance ID; send to that exact instance.
      state = await this.inspect({ ...choice, model: loaded.instance_id }, signal);
    } else if (state.kind === 'ollama') {
      const alias = state.aliasPrefix + target;
      const created = await this.request(p, '/api/create', { model: alias, from: state.modelKey, parameters: { num_ctx: target }, stream: false }, signal);
      if (created.status !== 'success') throw new Error(`${p.name}: could not create the Harness context preset.`);
      await this.request(p, '/api/generate', { model: alias, stream: false, keep_alive: '5m' }, signal);
      state = await this.inspect(choice, signal);
    } else {
      if (!state.loaded && !state.loading) await this.request(p, '/models/load', { model: choice.model }, signal);
      const deadline = AbortSignal.any([AbortSignal.timeout(180000), ...(signal ? [signal] : [])]);
      while (!state.loaded) {
        await delay(250, null, { signal: deadline });
        state = await this.inspect(choice, deadline);
      }
    }
    if (!state.loaded || !state.contextLength) throw new Error(`${p.name}: the loaded context size could not be verified. Update the server and retry.`);
    if (state.canResize && state.contextLength < target) throw new Error(`${p.name}: the server loaded less context than requested. Free memory or choose a smaller model.`);
    this.states.set(this.key(choice), state);
    return state;
  }
  async unload(choice) {
    const p = this.providers.provider(choice.provider);
    if (this.locks.has(p.baseUrl)) throw new Error('Wait for the local provider to finish before unloading.');
    return this.exclusive(choice, async () => {
      const state = await this.inspect(choice);
      if (!state.supported) throw new Error('This provider does not support model unloading.');
      if (state.kind === 'lm-studio' && state.instance) await this.request(p, '/api/v1/models/unload', { instance_id: state.instance.id });
      else if (state.kind === 'ollama') {
        for (const instance of state.instances) await this.request(p, '/api/generate', { model: instance.name, stream: false, keep_alive: 0 });
      } else if (state.kind === 'llama.cpp' && (state.loaded || state.loading)) await this.request(p, '/models/unload', { model: choice.model });
      const after = await this.inspect(choice);
      if (after.loaded || after.loading) throw new Error(`${p.name}: the model is still loaded. Try again when the server is idle.`);
      return after;
    });
  }
}
module.exports = { LocalModels, DEFAULT_CONTEXT };
