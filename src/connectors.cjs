const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Client, StreamableHTTPClientTransport, UnauthorizedError } = require('@modelcontextprotocol/client');
const { AjvJsonSchemaValidator } = require('@modelcontextprotocol/client/validators/ajv');
const { atomicWrite } = require('./session-store.cjs');
const { ConnectorStdio } = require('./connectors/transport.cjs');
const { webUrl, identity, ConnectorCredentials, ConnectorOAuth } = require('./connectors/auth.cjs');

const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const DEFAULT_CONNECTORS = [
  ['8f4b1b28-d34e-4b0e-933a-cd5b8dddb051', 'Context7', 'https://mcp.context7.com/mcp'],
  ['8f4b1b28-d34e-4b0e-933a-cd5b8dddb052', 'Microsoft Learn', 'https://learn.microsoft.com/api/mcp'],
  ['8f4b1b28-d34e-4b0e-933a-cd5b8dddb053', 'OpenAI Docs', 'https://developers.openai.com/mcp'],
];
const MAX_CONNECTORS = 50 + DEFAULT_CONNECTORS.length; // Upgrades must retain all 50 existing connectors.
const object = value => !!value && typeof value === 'object' && !Array.isArray(value);
function validate(input) {
  if (!object(input) || Object.keys(input).some(key => !['id', 'name', 'transport', 'url', 'command', 'args', 'cwd', 'auth', 'clientId', 'enabled', 'confirmCalls', 'token', 'env'].includes(key))) throw new Error('Invalid connector settings.');
  if (input.id !== undefined && !UUID.test(input.id)) throw new Error('Invalid connector ID.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 80) throw new Error('Enter a connector name up to 80 characters.');
  for (const field of ['enabled', 'confirmCalls']) if (input[field] !== undefined && typeof input[field] !== 'boolean') throw new Error('Invalid connector permission.');
  const record = { id: input.id || randomUUID(), name: input.name.trim(), transport: input.transport, enabled: input.enabled !== false, confirmCalls: input.confirmCalls !== false };
  if (record.transport === 'http') {
    if (typeof input.url !== 'string' || input.url.length > 2048) throw new Error('Enter an MCP server URL.');
    record.url = webUrl(input.url).href; record.auth = input.auth || 'none';
    if (!['none', 'bearer', 'oauth'].includes(record.auth)) throw new Error('Choose an authentication method.');
    if (input.clientId && (typeof input.clientId !== 'string' || input.clientId.length > 500)) throw new Error('Invalid OAuth client ID.');
    if (record.auth === 'oauth' && input.clientId) record.clientId = input.clientId;
  } else if (record.transport === 'stdio') {
    if (typeof input.command !== 'string' || !input.command.trim() || input.command.length > 2048 || /[\r\n\0]/.test(input.command)) throw new Error('Enter the program to run.');
    if (!Array.isArray(input.args) || input.args.length > 100 || input.args.some(arg => typeof arg !== 'string' || arg.length > 8192 || arg.includes('\0'))) throw new Error('Use a list of program arguments.');
    if (input.cwd && (typeof input.cwd !== 'string' || !path.isAbsolute(input.cwd) || input.cwd.includes('\0'))) throw new Error('Use an absolute working directory.');
    record.command = input.command.trim(); record.args = input.args; if (input.cwd) record.cwd = input.cwd;
  } else throw new Error('Choose a local program or remote MCP server.');
  if (input.token !== undefined && (typeof input.token !== 'string' || input.token.length > 16384 || /[\r\n\0]/.test(input.token))) throw new Error('Invalid bearer token.');
  if (input.env !== undefined && (!object(input.env) || Object.keys(input.env).length > 60 || Object.entries(input.env).some(([key, value]) =>
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.length > 16384 || /[\r\n\0]/.test(value)))) throw new Error('Use KEY=value environment variables.');
  return record;
}

function readStore(file) {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
function parseStore(text) {
  try {
    const saved = JSON.parse(text.replace(/^\uFEFF/, ''));
    if (!object(saved) || saved.version !== 1 || !Array.isArray(saved.connectors)) throw new Error();
    const defaultsVersion = saved.defaultsVersion === undefined ? 0 : saved.defaultsVersion;
    if (!Number.isSafeInteger(defaultsVersion) || defaultsVersion < 0 || saved.connectors.length > (defaultsVersion ? MAX_CONNECTORS : 50)) throw new Error();
    const records = saved.connectors.map(input => {
      if (!object(input) || !UUID.test(input.id) || input.token !== undefined || input.env !== undefined) throw new Error();
      return validate(input);
    });
    if (new Set(records.map(record => record.id)).size !== records.length) throw new Error();
    return { records, defaultsVersion };
  } catch { throw new Error('Invalid connectors.json. Last loaded connectors were kept. Use version 1, unique connector IDs and Settings for credentials.'); }
}

class Connectors extends EventEmitter {
  constructor(directory, encryption, { fetcher = fetch } = {}) {
    super(); this.directory = directory; this.file = path.join(directory, 'connectors.json'); this.fetch = fetcher;
    this.credentials = new ConnectorCredentials(path.join(directory, 'connector-keys'), encryption);
    this.records = []; this.connections = new Map(); this.status = new Map(); this.auth = new Map(); this.operations = new Set(); this.blocked = new Set(); this.closing = false; this.mutations = Promise.resolve();
    this.cleaning = new Set();
    this.diskText = readStore(this.file);
    const saved = this.diskText === null ? { records: [], defaultsVersion: 0 } : parseStore(this.diskText);
    this.records = saved.records; this.defaultsVersion = saved.defaultsVersion;
    if (this.defaultsVersion < 1) {
      const missing = DEFAULT_CONNECTORS.filter(([id, name, url]) => !this.records.some(record =>
        record.id === id || record.name.toLowerCase() === name.toLowerCase() || record.url?.replace(/\/$/, '') === url));
      this.defaultsVersion = 1;
      this.persist([...this.records, ...missing.map(([id, name, url]) => validate({ id, name, url, transport: 'http' }))]);
    }
  }
  changed() { this.emit('change'); }
  record(id) { const record = this.records.find(record => record.id === id); if (!record) throw new Error('Connector no longer exists.'); return record; }
  snapshot() {
    return this.records.map(record => ({ ...record, credentialsSaved: this.credentials.has(record),
      state: record.enabled ? 'disconnected' : 'disabled', ...this.status.get(record.id), signingIn: !!this.auth.get(record.id)?.server }));
  }
  assertUnchanged() {
    if (readStore(this.file) !== this.diskText) throw new Error('connectors.json changed while saving. Reload Connectors and retry. Nothing was overwritten.');
  }
  persist(records) {
    this.assertUnchanged();
    const text = JSON.stringify({ version: 1, defaultsVersion: this.defaultsVersion, connectors: records });
    atomicWrite(this.file, text); this.diskText = text; this.records = records; this.changed();
  }
  mutate(work) { const next = this.mutations.then(work); this.mutations = next.catch(() => {}); return next; }
  reload() { return this.mutate(() => this.reloadNow()); }
  async list() { await this.reload(); return this.snapshot(); }
  async reloadNow() {
    if (this.closing) throw new Error('The runner is stopping.');
    const text = readStore(this.file);
    if (text === this.diskText) return;
    if (text === null) throw new Error('connectors.json is missing. Last loaded connectors were kept; save an empty connectors array to remove them.');
    const saved = parseStore(text);
    const records = saved.records.map(record => {
      const previous = this.records.find(item => item.id === record.id);
      return previous && JSON.stringify(previous) === JSON.stringify(record) ? previous : record;
    });
    const changed = this.records.filter(record => !records.includes(record));
    await Promise.all(changed.map(record => this.disconnect(record.id)));
    if (this.closing) throw new Error('The runner is stopping.');
    const added = records.filter(record => !this.records.includes(record));
    this.records = records; this.diskText = text;
    this.defaultsVersion = Math.max(this.defaultsVersion, saved.defaultsVersion);
    for (const record of changed) if (!records.some(item => item.id === record.id)) this.credentials.remove(record);
    this.changed();
    await Promise.all(added.filter(record => record.enabled).map(record => this.connect(record.id)));
  }
  save(input) { return this.mutate(async () => { await this.reloadNow(); return this.saveNow(input); }); }
  async saveNow(input) {
    if (this.closing) throw new Error('The runner is stopping.');
    const record = validate(input), previous = this.records.find(item => item.id === record.id);
    if (input.id && !previous) throw new Error('Connector no longer exists.');
    if (!previous && this.records.length >= MAX_CONNECTORS) throw new Error(`Use at most ${MAX_CONNECTORS} connectors.`);
    await this.disconnect(record.id);
    this.assertUnchanged();
    const keyFile = input.token || input.env !== undefined ? this.credentials.file(record) : null;
    const previousKey = keyFile ? readStore(keyFile) : null;
    try {
      if (keyFile) {
        const secrets = this.credentials.read(record);
        if (input.token) secrets.token = input.token;
        if (input.env !== undefined) secrets.env = input.env;
        this.credentials.write(record, secrets);
      }
      this.persist(previous ? this.records.map(item => item.id === record.id ? record : item) : [...this.records, record]);
    } catch (error) {
      if (keyFile && readStore(keyFile) !== previousKey) {
        if (previousKey === null) fs.rmSync(keyFile, { force: true });
        else atomicWrite(keyFile, previousKey);
      }
      throw error;
    }
    if (record.enabled) await this.connect(record.id);
    return this.snapshot();
  }
  action(id, action) { return this.mutate(async () => { await this.reloadNow(); return this.actionNow(id, action); }); }
  async actionNow(id, action) {
    if (this.closing) throw new Error('The runner is stopping.');
    const record = this.record(id);
    if (!['connect', 'disconnect', 'remove', 'sign-in', 'forget-auth', 'cancel-sign-in'].includes(action)) throw new Error('Unknown connector action.');
    if (action === 'sign-in') return this.signIn(id);
    if (action === 'connect') {
      if (!record.enabled) this.persist(this.records.map(item => item.id === id ? { ...item, enabled: true } : item));
      await this.disconnect(id); await this.connect(id);
    } else {
      await this.disconnect(id);
      if (action === 'disconnect') this.persist(this.records.map(item => item.id === id ? { ...item, enabled: false } : item));
      if (action === 'remove') { this.persist(this.records.filter(item => item.id !== id)); this.credentials.remove(record); }
      if (action === 'forget-auth') this.credentials.remove(record);
    }
    return { connectors: this.snapshot() };
  }
  oauth(record) {
    let provider = this.auth.get(record.id);
    if (!provider || identity(provider.record) !== identity(record)) {
      provider?.close(); provider = new ConnectorOAuth(record, this.credentials, () => this.changed()); this.auth.set(record.id, provider);
    }
    return provider;
  }
  async signIn(id) {
    const record = this.record(id);
    if (record.transport !== 'http' || record.auth !== 'oauth' || !record.enabled) throw new Error('Enable a remote OAuth connector first.');
    if (!this.credentials.encryption?.isEncryptionAvailable()) throw new Error('OS key protection is unavailable on this host.');
    await this.disconnect(id);
    const provider = this.oauth(record);
    await provider.listen(async params => {
      try {
        await provider.transport.finishAuth(params);
        if (provider.revoked || this.record(id) !== record) throw new Error('Connector changed.');
        await this.disconnectClients(id);
        this.status.delete(id);
        await this.connect(id);
        if (this.status.get(id)?.state !== 'connected') throw new Error('Authorization did not establish a connection.');
      } catch (error) { if (!provider.revoked) this.status.set(id, { state: 'needs-sign-in', error: 'Sign-in failed. Try again.' }); throw error; }
    });
    await this.connect(id, true);
    return { connectors: this.snapshot(), ...(provider.url ? { url: provider.url } : {}) };
  }
  async connect(id, interactive = false) {
    const record = this.record(id);
    if (!record.enabled) return;
    this.blocked.delete(id);
    if (!interactive && record.auth === 'oauth' && !Object.keys(this.credentials.read(record).oauth?.tokens || {}).length) {
      this.status.set(id, { state: 'needs-sign-in', error: 'Sign in to connect this server.' }); this.changed(); return this.snapshot();
    }
    try { await this.open(record, 'settings', record.cwd || this.directory, interactive); }
    catch { /* open records a safe status; Settings remains usable. */ }
    return this.snapshot();
  }
  async open(record, owner, workspace, interactive = false) {
    if (this.closing || this.blocked.has(record.id) || !record.enabled || this.record(record.id) !== record) throw new Error('Connector is disabled or changed.');
    const key = `${record.id}:${owner}`, existing = this.connections.get(key);
    if (existing) return existing.ready;
    const cleaning = [...this.cleaning].find(entry => entry.key === key);
    if (cleaning) { await cleaning.closing; return this.open(record, owner, workspace, interactive); }
    if (!interactive && this.status.get(record.id)?.state === 'needs-sign-in') throw new Error('Sign in from Settings > Connectors.');
    const entry = { key, owner, id: record.id, abort: new AbortController(), client: new Client({ name: 'phasma-harness', version: require('../package.json').version }) };
    this.connections.set(key, entry); this.status.set(record.id, { state: 'connecting' }); this.changed();
    entry.ready = (async () => {
      try {
        const secrets = this.credentials.read(record);
        if (record.transport === 'stdio') entry.transport = new ConnectorStdio(record.command, record.args, record.cwd || workspace, secrets.env || {});
        else {
          if (record.auth === 'bearer' && !secrets.token) throw new Error('Enter a bearer token.');
          const provider = record.auth === 'oauth' ? this.oauth(record) : undefined;
          entry.transport = new StreamableHTTPClientTransport(new URL(record.url), { authProvider: provider,
            requestInit: record.auth === 'bearer' ? { headers: { Authorization: `Bearer ${secrets.token}` } } : undefined,
            fetch: (url, init) => { webUrl(typeof url === 'string' || url instanceof URL ? url : url.url); return this.fetch(url, { ...init, redirect: 'error' }); } });
          if (interactive && provider) provider.transport = entry.transport;
        }
        entry.client.onclose = () => { if (this.connections.get(key) === entry) { this.connections.delete(key); if (![...this.connections.values()].some(other => other.id === record.id && other.tools)) this.status.set(record.id, { state: 'disconnected' }); this.changed(); } };
        await entry.client.connect(entry.transport, { signal: entry.abort.signal, timeout: 15000 });
        entry.tools = [];
        if (entry.client.getServerCapabilities()?.tools) {
          let cursor;
          const seen = new Set();
          do {
            const page = await entry.client.listTools(cursor ? { cursor } : {}, { signal: entry.abort.signal, timeout: 15000 });
            entry.tools.push(...page.tools); cursor = page.nextCursor;
            if (entry.tools.length > 1000 || (cursor && seen.has(cursor))) throw new Error('Connector tool list is too large or repeats pages.');
            if (cursor) seen.add(cursor);
          } while (cursor);
        }
        if (new Set(entry.tools.map(tool => tool.name)).size !== entry.tools.length || entry.tools.some(tool => typeof tool.name !== 'string' || tool.name.length > 250 || !object(tool.inputSchema))) throw new Error('Connector returned an invalid tool list.');
        const validator = new AjvJsonSchemaValidator();
        entry.validators = new Map(entry.tools.map(tool => [tool.name, validator.getValidator(tool.inputSchema)]));
        if (this.closing || entry.abort.signal.aborted || this.connections.get(key) !== entry || this.record(record.id) !== record) throw new Error('Connector changed while connecting.');
        this.status.set(record.id, { state: 'connected', toolCount: entry.tools.length }); this.changed(); return entry;
      } catch (error) {
        if (this.connections.get(key) === entry) this.connections.delete(key);
        let cleanupError;
        try { await this.closeEntry(entry); } catch (failure) { cleanupError = failure; }
        const auth = error instanceof UnauthorizedError || /Sign in from Settings|bearer token/.test(error.message);
        const message = cleanupError ? cleanupError.message : auth ? 'Authorization required. Open this connector in Settings.' : 'Connection failed. Check the server URL or program and credentials.';
        if (this.records.includes(record) && !this.closing && ![...this.connections.values()].some(other => other.id === record.id)) this.status.set(record.id, { state: auth ? 'needs-sign-in' : 'error', error: message });
        this.changed(); throw new Error(message);
      }
    })();
    return entry.ready;
  }
  async discover(args = {}) {
    if (!object(args) || Object.keys(args).some(key => !['query', 'connectorId', 'cursor'].includes(key)) ||
        (args.query !== undefined && (typeof args.query !== 'string' || args.query.length > 300)) ||
        (args.connectorId !== undefined && !UUID.test(args.connectorId)) || (args.cursor !== undefined && (!Number.isSafeInteger(args.cursor) || args.cursor < 0))) throw new Error('Invalid connector search.');
    await this.reload();
    const records = this.records.filter(record => record.enabled && (!args.connectorId || record.id === args.connectorId));
    const entries = await Promise.all(records.map(record => this.open(record, 'settings', record.cwd || this.directory).catch(() => null)));
    const words = (args.query || '').toLowerCase().split(/\s+/).filter(Boolean), tools = [];
    for (let i = 0; i < records.length; i++) for (const tool of entries[i]?.tools || []) {
      if (words.every(word => `${records[i].name} ${tool.name} ${tool.description || ''}`.toLowerCase().includes(word)))
        tools.push({ id: `${records[i].id}/${tool.name}`, connector: records[i].name, name: tool.name, description: tool.description || '', inputSchema: tool.inputSchema });
    }
    const start = args.cursor || 0;
    return { connectors: this.snapshot().filter(record => records.some(item => item.id === record.id)).map(({ id, name, state, error }) => ({ id, name, state, ...(error ? { error } : {}) })), tools: tools.slice(start, start + 20), total: tools.length, nextCursor: start + 20 < tools.length ? start + 20 : null };
  }
  target(id) {
    if (typeof id !== 'string' || id.length > 290 || id[36] !== '/' || !UUID.test(id.slice(0, 36))) throw new Error('Discover the connector tool before calling it.');
    return { record: this.record(id.slice(0, 36)), name: id.slice(37) };
  }
  async call(record, name, args, owner, workspace, signal, current = () => true) {
    if (!object(args) || Buffer.byteLength(JSON.stringify(args)) > 65536) throw new Error('Connector arguments must be an object under 64 KB.');
    await this.reload();
    if (signal?.aborted || !current()) throw new Error('Connector call stopped.');
    const abort = new AbortController(), operation = { owner, id: record.id, abort }; this.operations.add(operation);
    let cleanup;
    const stopped = () => abort.abort(); signal?.addEventListener('abort', stopped, { once: true });
    abort.signal.addEventListener('abort', () => {
      const current = this.connections.get(`${record.id}:${owner}`);
      if (current) { cleanup = this.closeEntry(current); cleanup.catch(() => {}); }
    }, { once: true });
    let entry;
    try {
      entry = await this.open(record, owner, workspace);
      const validate = entry.validators.get(name);
      if (!validate) throw new Error('Tool is no longer available. Discover tools again.');
      if (!validate(args).valid) throw new Error('Arguments do not match this connector tool’s input schema.');
      await this.reload();
      if (abort.signal.aborted || this.blocked.has(record.id) || this.record(record.id) !== record || !record.enabled || !current()) throw new Error('Connector call stopped or settings changed.');
      try { return await entry.client.callTool({ name, arguments: args }, { signal: abort.signal, timeout: 120000, resetTimeoutOnProgress: false }); }
      catch { abort.abort(); throw new Error('Connector call failed or stopped. Its action may have completed; check before retrying.'); }
    } finally {
      signal?.removeEventListener('abort', stopped); this.operations.delete(operation);
      if (cleanup) await cleanup;
    }
  }
  cancelOwners(ids) { for (const operation of this.operations) if (ids.includes(operation.owner)) operation.abort.abort(); }
  closeEntry(entry) {
    if (entry.closing) return entry.closing;
    this.cleaning.add(entry);
    entry.closing = (async () => {
      entry.abort.abort();
      if (this.connections.get(entry.key) === entry) this.connections.delete(entry.key);
      try { await entry.client.close(); }
      finally { if (entry.transport instanceof ConnectorStdio) await entry.transport.close(); }
    })();
    entry.closing.then(() => this.cleaning.delete(entry), () => {});
    return entry.closing;
  }
  async disconnectClients(id) {
    const entries = [...new Set([...this.connections.values(), ...this.cleaning])].filter(entry => entry.id === id);
    for (const operation of this.operations) if (operation.id === id) operation.abort.abort();
    const results = await Promise.allSettled(entries.map(entry => this.closeEntry(entry)));
    const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
  }
  async disconnect(id) { this.blocked.add(id); const provider = this.auth.get(id); if (provider) { provider.revoked = true; provider.close(); } this.auth.delete(id); await this.disconnectClients(id); this.status.delete(id); this.changed(); }
  async close() { this.closing = true; const results = await Promise.allSettled(this.records.map(record => this.disconnect(record.id))); await this.mutations; const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason; }
}
module.exports = { Connectors, validate };
