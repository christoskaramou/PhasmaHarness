const { WORKER_INSTRUCTIONS } = require('../worker-instructions.cjs');
const { spawn } = require('node:child_process');
const { spawnOwned, stopTree, stopStartedSince } = require('../process-tree.cjs');
const { stepStopped } = require('./native-cli.cjs');
const { cursorLimitText } = require('./limits.cjs');
const { imageData } = require('../image-input.cjs');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { atomicWrite } = require('../session-store.cjs');
const { invalidResponse } = require('./structured.cjs');

const stop = stopTree;

function launchCursor(args, cwd) {
  if (process.platform === 'win32') {
    const script = path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'cursor-agent', 'cursor-agent.ps1');
    if (!fs.existsSync(script)) throw Object.assign(new Error('Cursor CLI is not installed. Install it from Settings → Providers.'), { code: 'ENOENT' });
    const root = path.dirname(script);
    const version = fs.readdirSync(path.join(root, 'versions')).filter(v => /^\d{4}\.\d{2}\.\d{2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(v)).sort().at(-1);
    if (!version) throw new Error('Cursor CLI installation is incomplete. Run its installer again.');
    const directory = path.join(root, 'versions', version);
    return spawnOwned(spawn, path.join(directory, 'node.exe'), [path.join(directory, 'index.js'), ...args], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  const local = path.join(require('node:os').homedir(), '.local', 'bin', 'cursor-agent');
  return spawnOwned(spawn, fs.existsSync(local) ? local : 'cursor-agent', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

// An ACP edit result carries the whole file before and after (190 KB per edit seen); keep the changed lines with three
// lines of context and the first kept line's number. Already-compact blocks come back unchanged.
function compactDiff(block) {
  if (block?.type !== 'diff' || typeof block.newText !== 'string' || (block.oldText != null && typeof block.oldText !== 'string')) return block;
  const before = block.oldText == null ? [] : block.oldText.split('\n'), after = block.newText.split('\n');
  let prefix = 0, suffix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  while (suffix < before.length - prefix && suffix < after.length - prefix && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3), trimmed = Math.max(0, suffix - 3);
  if (!start && !trimmed) return block;
  return { ...block, ...(block.oldText == null ? {} : { oldText: before.slice(start, before.length - trimmed).join('\n') }),
    newText: after.slice(start, after.length - trimmed).join('\n'), startLine: (block.startLine || 1) + start };
}

// Cursor reports most tool output in rawOutput (a read's text, a grep's match count); content carries only edit diffs.
// shortcut: text values keep 64,000 characters (the largest skill file seen is 36 KB); raise it if a check needs more.
function toolOutput(update) {
  if (Array.isArray(update.content) && update.content.length) return update.content.map(compactDiff);
  const clip = value => typeof value === 'string' ? (value.length > 64000 ? value.slice(0, 64000) + `\n[… ${value.length - 64000} more characters not kept]` : value)
    : Array.isArray(value) ? value.map(clip) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clip(item)])) : value;
  return update.rawOutput === undefined ? update.content || [] : clip(update.rawOutput);
}

function parseStatus(output) {
  const text = String(output || '').replace(/\x1b\[[0-9;]*m/g, '');
  const match = text.match(/logged in as\s+(\S+)/i);
  if (!match) return { installed: true, loggedIn: false };
  const identity = match[1].replace(/[.,;:!?)]+$/, '');
  return { installed: true, loggedIn: true, email: /@/.test(identity) ? identity : null, identity };
}

// A finished turn leaves its Cursor process running for the conversation's next turn, which then skips spawn,
// initialize, session/load and model setup (about 6 s, measured 2026-10-25). An idle process tree is about 270 MB, so at
// most three stay warm across all bots (every bot has its own CursorCLI), each for 10 minutes. Oldest first.
const WARM = new Map();
function drop(sessionId) {
  const entry = WARM.get(sessionId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  WARM.delete(sessionId);
  return entry;
}

class CursorCLI {
  constructor(launch = launchCursor) { this.launch = launch; this.children = new Set(); this.status = { installed: null, loggedIn: false }; this.models = []; }
  park(sessionId, entry) {
    drop(sessionId)?.rpc.close();
    entry.owner = this;
    entry.timer = setTimeout(() => drop(sessionId)?.rpc.close(), 10 * 60 * 1000);
    entry.timer.unref?.();
    WARM.set(sessionId, entry);
    while (WARM.size > 3) drop(WARM.keys().next().value)?.rpc.close();
  }
  unpark(sessionId) { return WARM.get(sessionId)?.owner === this ? drop(sessionId) : null; }
  warmCount() { return [...WARM.values()].filter(entry => entry.owner === this).length; }
  closeWarm() { for (const [id, entry] of [...WARM]) if (entry.owner === this) drop(id)?.rpc.close(); }
  start(args, cwd) {
    const child = this.launch(args, cwd); this.children.add(child);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8'); child.stdin.on('error', () => {});
    child.once('close', () => this.children.delete(child)); return child;
  }
  command(args, timeout = 20000) {
    return new Promise((resolve, reject) => {
      const child = this.start(args); let output = '';
      const timer = setTimeout(() => { stop(child); reject(new Error('Cursor CLI timed out.')); }, timeout);
      child.stdout.on('data', d => { output += d; if (output.length > 1000000) { stop(child); reject(new Error('Cursor CLI output is too large.')); } });
      child.stderr.on('data', () => {});
      child.once('error', e => { clearTimeout(timer); reject(e); });
      child.once('close', code => { clearTimeout(timer); code ? reject(new Error('Cursor CLI command failed. Check its login.')) : resolve(output.replace(/\x1b\[[0-9;]*m/g, '')); });
      child.stdin.end();
    });
  }
  async refresh() {
    try { this.status = parseStatus(await this.command(['status'])); }
    catch (e) { this.status = { installed: e.code !== 'ENOENT', loggedIn: false, error: e.message }; }
    return this.status;
  }
  async login() {
    if (this.loginPending) throw new Error('Cursor login is already running.');
    this.loginPending = true;
    // Warm processes belong to the account that started them.
    this.closeWarm();
    try { await this.command(['login'], 300000); return await this.refresh(); }
    finally { this.loginPending = false; }
  }
  async logout() {
    if (this.loginPending) throw new Error('Cursor login is already running.');
    this.closeWarm();
    try { await this.command(['logout'], 60000); }
    catch (error) {
      if (error.code === 'ENOENT') throw new Error('Cursor CLI is not installed. Install it from Settings → Providers.');
    }
    return await this.refresh();
  }
  async discover() {
    const rpc = this.connect({ model: 'auto' });
    try {
      await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'phasma-harness', version: '0.1.0' } });
      const session = await rpc.call('session/new', { cwd: require('node:os').homedir(), mcpServers: [] });
      let models = (session.models?.availableModels || []).map(m => ({ id: m.modelId, label: m.name }));
      // Current Cursor CLIs list every base model with its parameters through this extension (read-only, no model switch).
      // The reasoning parameter has category "thought_level"; its values are used exactly as Cursor reports them.
      try {
        const listed = await rpc.call('cursor/list_available_models', {});
        const parsed = (Array.isArray(listed?.models) ? listed.models : []).filter(m => typeof m?.value === 'string' && m.value).map(m => {
          const option = (Array.isArray(m.configOptions) ? m.configOptions : [])
            .find(o => o?.category === 'thought_level' && typeof o.id === 'string' && Array.isArray(o.options) && o.options.length > 1);
          const values = option ? option.options.filter(o => typeof o?.value === 'string' && o.value) : [];
          // Every parameter this model accepts, to validate values saved in older variant IDs (grok-4.7[fast=true,…]).
          const parameters = Object.fromEntries((Array.isArray(m.configOptions) ? m.configOptions : [])
            .filter(o => typeof o?.id === 'string' && Array.isArray(o.options))
            .map(o => [o.id, o.options.map(v => v?.value).filter(v => typeof v === 'string')]));
          return { id: m.value, label: typeof m.name === 'string' && m.name ? m.name : m.value, parameterized: true, parameters,
            ...(values.length > 1 ? { efforts: values.map(o => o.value), effortOption: option.id,
              effortNames: Object.fromEntries(values.map(o => [o.value, typeof o.name === 'string' && o.name ? o.name : o.value])) } : {}) };
        });
        if (parsed.length) models = parsed;
      } catch { /* Older CLI without the extension: keep the plain model list. */ }
      this.models = models;
      if (!this.models.length) throw new Error('Cursor returned no model IDs. Refresh its CLI and try again.');
      return this.models;
    } finally { rpc.close(); }
  }
  connect({ cwd, model, signal, noTools = false, onUpdate = () => {}, onRequest = async () => ({ outcome: 'cancelled' }) }) {
    if (noTools) {
      cwd = path.join(cwd, 'cursor-review');
      const directory = path.join(cwd, '.cursor');
      fs.mkdirSync(directory, { recursive: true });
      if (fs.realpathSync(directory) !== path.resolve(directory)) throw new Error('Cursor review settings must not be redirected through a link.');
      // Ask mode still has read tools; keep classifiers in an empty directory with explicit denials.
      const file = path.join(directory, 'cli.json');
      const text = JSON.stringify({ permissions: { allow: [], deny: ['Read(**)', 'Write(**)', 'Shell(*)', 'WebFetch(*)', 'Mcp(*:*)'] } });
      if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== text) atomicWrite(file, text);
    }
    // CLI aliases differ from ACP model IDs. run() selects the exact ACP ID before prompting.
    const child = this.start(['--model', 'auto', 'acp'], cwd);
    const pending = new Map(); let next = 0, buffer = '', closed = false;
    const write = value => { if (!closed) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...value }) + '\n'); };
    const fail = e => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(e); } pending.clear(); };
    const close = () => { if (closed) return; closed = true; stop(child); fail(new Error('Cursor connection closed.')); signal?.removeEventListener('abort', close); };
    const call = (method, params, timeout = 20000) => new Promise((resolve, reject) => {
      if (closed) return reject(new Error('Cursor connection closed.'));
      const id = ++next;
      const timer = timeout ? setTimeout(() => { pending.delete(id); reject(new Error(`Cursor ${method} timed out.`)); close(); }, timeout) : null;
      pending.set(id, { resolve, reject, timer }); write({ id, method, params });
    });
    child.stdout.on('data', d => {
      if (closed) return;
      buffer += d;
      if (buffer.length > 16 * 1024 * 1024) { close(); return; }
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (!line) continue;
        let msg; try { msg = JSON.parse(line); } catch { fail(new Error('Invalid Cursor ACP response.')); close(); return; }
        if (msg.method && msg.id !== undefined) {
          Promise.resolve().then(() => onRequest(msg.method, msg.params)).then(result => write({ id: msg.id, result }), () => write({ id: msg.id, error: { code: -32603, message: 'Request could not be completed.' } }));
        } else if (msg.method === 'session/update') onUpdate(msg.params);
        else if (pending.has(msg.id)) {
          const p = pending.get(msg.id); pending.delete(msg.id); clearTimeout(p.timer);
          msg.error ? p.reject(new Error(msg.error.message || 'Cursor request failed.')) : p.resolve(msg.result);
        }
      }
    });
    child.stderr.on('data', () => {});
    child.once('error', e => { fail(e); close(); }); child.once('close', () => { closed = true; fail(new Error('Cursor connection closed.')); signal?.removeEventListener('abort', close); });
    signal?.addEventListener('abort', close, { once: true }); if (signal?.aborted) close();
    return { call, close, child, cwd, open: () => !closed, notify: (method, params) => write({ method, params }) };
  }
  async run({ cwd, model, effort, effortOption, parameterized, parameters = [], prompt, images = [], resume, access, signal, onEvent = () => {}, onActivity, approve = async () => false, schema, schemaInHistory = false, helpers, onInput, instructions = WORKER_INSTRUCTIONS }) {
    // Models from cursor/list_available_models are base names with separate parameters: Cursor accepts them, and their
    // reasoning option, only from a client that declares the parameterized model picker.
    const setEffort = typeof effort === 'string' && effort && typeof effortOption === 'string' && effortOption;
    const picker = parameterized === true || setEffort;
    // Each prompt has its own reply id, approval signal and start time (Send now replaces the prompt in this session).
    let sessionId, output = '', segment = '', prompting = false, toolError = null, messageId = randomUUID(), promptAbort = new AbortController(), promptStartedAt = Date.now();
    const tools = new Map();
    // The conversation's parked connection is reused when it serves the same folder, tools and model picker.
    const mcpServers = (!schema && helpers?.cursorServers) ? helpers.cursorServers : [];
    const key = JSON.stringify([cwd, !!schema, !!picker, mcpServers]);
    const mode = schema || access === 'read-only' ? 'ask' : 'agent';
    const parked = resume ? this.unpark(resume) : null;
    let reused = parked?.key === key && parked.rpc.open?.() !== false ? parked : null;
    if (parked && !reused) parked.rpc.close();
    if (reused) {
      // The prompt call has no time limit, so a parked process must first answer a bounded call; a silent one is replaced.
      try {
        await reused.rpc.call('session/set_mode', { sessionId: resume, modeId: mode }, 20000);
        reused.applied.mode = mode;
      } catch {
        reused.rpc.close();
        reused = null;
      }
    }
    const rpc = reused?.rpc || this.connect({ cwd, model, noTools: !!schema,
      onUpdate: p => rpc.route.onUpdate(p), onRequest: (method, p) => rpc.route.onRequest(method, p) });
    const applied = reused?.applied || {};
    let init = reused?.init, keep = false;
    // Stop closes this turn's connection, new or reused; a parked connection answers no one.
    const abort = () => rpc.close();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) rpc.close();
    rpc.route = {
      onUpdate: p => {
        if (!prompting || p.sessionId !== sessionId) return;
        const u = p.update;
        if (schema && u?.sessionUpdate === 'tool_call') {
          // Cursor can start read/search tools without a permission request. Never accept a tool-using classifier's result.
          toolError = invalidResponse();
          rpc.close();
          return;
        }
        if (['agent_message_chunk', 'agent_thought_chunk'].includes(u?.sessionUpdate) && u.content?.type === 'text' && u.content.text) onActivity?.();
        if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
          if (!segment && output) output += '\n\n';
          output += u.content.text; segment += u.content.text;
          onEvent({ type: 'assistant', session_id: sessionId, message: { id: messageId, content: [{ type: 'text', text: segment }] } });
        }
        // Text written after a tool call is a new message below its card, not an addition to the text above it.
        if (u?.sessionUpdate === 'tool_call' && segment) { messageId = randomUUID(); segment = ''; }
        // Cursor often names a tool and fills its input in a later update (a grep starts as "grep" with {}).
        if (u?.sessionUpdate === 'tool_call' || (u?.sessionUpdate === 'tool_call_update' && (u.title || u.rawInput))) {
          const known = tools.get(u.toolCallId) || {};
          const tool = { name: u.title || known.name || u.kind || 'Cursor tool', input: u.rawInput || known.input || {} };
          tools.set(u.toolCallId, tool);
          onEvent({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: u.toolCallId, ...tool }] } });
        }
        if (u?.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(u.status)) onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: u.toolCallId, is_error: u.status === 'failed', content: toolOutput(u) }] } });
      },
      onRequest: async (method, p) => {
        if (method === 'session/request_permission') {
          // Ask and Workspace access both ask the user in the Harness, like Codex and Claude; classifiers never get tools.
          // The prompt's own signal: after Send now a late answer cannot approve the replacement prompt's tools.
          const asked = promptAbort.signal;
          const allowed = !schema && (access === 'danger-full-access' || await approve(p.toolCall, { signal: asked }) === true) && !asked.aborted;
          const option = p.options?.find(o => o.kind === (allowed ? 'allow_once' : 'reject_once'));
          return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
        }
        if (method === 'cursor/create_plan') return { outcome: { outcome: !schema && await approve({ title: p.name || 'Approve Cursor plan', rawInput: p.plan, kind: 'plan' }) ? 'accepted' : 'rejected' } };
        if (method === 'cursor/ask_question') return { outcome: { outcome: 'skipped', reason: 'Ask the user in the chat response.' } };
        return { outcome: 'cancelled' };
      } };
    try {
      init ??= await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false,
        ...(picker ? { _meta: { parameterizedModelPicker: true } } : {}) }, clientInfo: { name: 'phasma-harness', version: '0.1.0' } });
      if (images.length && !init.agentCapabilities?.promptCapabilities?.image) throw new Error('Cursor CLI did not advertise image support.');
      // Authentication is completed by the official login command, never token extraction.
      // Classifiers keep an empty MCP list. Workers get the bundled helper MCP via session mcpServers.
      if (reused) sessionId = resume;
      else {
        const s = await rpc.call(resume ? 'session/load' : 'session/new', { ...(resume ? { sessionId: resume } : {}), cwd: rpc.cwd || cwd, mcpServers });
        if (resume && s.sessionId && s.sessionId !== resume) throw new Error('Cursor loaded a different conversation. No message was sent.');
        sessionId = resume || s.sessionId;
      }
      if (!sessionId) throw new Error('Cursor did not return a session ID.');
      onEvent({ type: 'system', session_id: sessionId });
      // A reused connection keeps its model, parameters and mode; only what differs is set again.
      if (applied.model !== model) {
        await rpc.call('session/set_model', { sessionId, modelId: model });
        applied.model = model; applied.config = null;
      }
      const config = JSON.stringify([picker ? parameters : null, setEffort ? effort : null]);
      if (applied.config !== config) {
        // Other saved parameters of the model (e.g. context, fast), then the reasoning level.
        if (picker) for (const p of parameters) {
          if (typeof p?.id === 'string' && typeof p.value === 'string' && p.id !== effortOption)
            await rpc.call('session/set_config_option', { sessionId, configId: p.id, value: p.value });
        }
        if (setEffort) {
          const updated = await rpc.call('session/set_config_option', { sessionId, configId: effortOption, value: effort });
          const current = (updated?.configOptions || []).find(o => o?.id === effortOption);
          if (current?.currentValue !== effort) throw new Error(`Cursor did not apply ${effortOption}=${effort} for ${model}.`);
        }
        applied.config = config;
      }
      if (applied.mode !== mode) {
        await rpc.call('session/set_mode', { sessionId, modeId: mode });
        applied.mode = mode;
      }
      prompting = true;
      const helperNote = (!schema && helpers?.instructions) ? '\n\nApp helper note (not Cursor system policy):' + helpers.instructions : '';
      const pictures = urls => {
        if (urls.length && !init.agentCapabilities?.promptCapabilities?.image) throw new Error('Cursor CLI did not advertise image support.');
        return urls.map(url => imageData(url)).map(({ mime, data }) => ({ type: 'image', mimeType: mime, data }));
      };
      const send = parts => {
        promptAbort = new AbortController(); promptStartedAt = Date.now(); messageId = randomUUID(); output = ''; segment = '';
        return rpc.call('session/prompt', { sessionId, prompt: parts }, 0);
      };
      let current = send([{ type: 'text', text: (schema || !instructions ? '' : 'Harness worker defaults (subject to user overrides):\n' + instructions + '\n\nCurrent request:\n') + prompt + helperNote + (schema && !(resume && schemaInHistory) ? '\nReturn only JSON matching this schema: ' + JSON.stringify(schema) : '') }, ...pictures(images)]);
      let steering = null, finished = false;
      // ACP runs one prompt at a time: Send now cancels the step, closes its approvals, stops what it started, then
      // prompts again in the same session and process. Unconfirmed cleanup keeps the message queued.
      const steer = async message => {
        const parts = [{ type: 'text', text: message.text }, ...pictures(message.images || [])];
        const previous = current;
        promptAbort.abort();
        const { interrupted, remaining } = stopStartedSince(rpc.child, promptStartedAt, `${rpc.child?.ownerKey || 'cursor'}/${randomUUID()}`,
          async () => {
            rpc.notify('session/cancel', { sessionId });
            return stepStopped(previous, 'Cursor');
          }, async () => {});
        await interrupted;
        if ((await remaining).length)
          throw new Error('Cursor has not confirmed that the cancelled step stopped. The message stays queued.');
        // A Stop or failure during cleanup ended the run: nothing may be sent on its closing connection.
        if (finished || signal?.aborted)
          throw new Error('Cursor stopped before the message was sent. The message stays queued.');

        current = send(parts);
      };
      if (!schema) onInput?.((message, { steer: now } = {}) => {
        if (!now)
          return Promise.reject(new Error('Cursor takes one prompt at a time. Use Send now to replace the current step.'));
        if (finished || steering || signal?.aborted)
          return Promise.reject(new Error('Cursor is no longer accepting messages.'));

        steering = steer(message).finally(() => { steering = null; });
        return steering;
      });

      let result;
      try {
        for (;;) {
          const mine = current;
          result = await mine;
          if (steering)
            await steering.catch(() => {});
          if (current === mine)
            break;
        }
      } finally {
        finished = true;
        onInput?.(null);
      }

      if (result.stopReason !== 'end_turn') throw new Error(`Cursor stopped: ${result.stopReason || 'unknown reason'}`);
      // Cursor reports usage and rate limits as a closing line of the reply, not as an error.
      const limit = cursorLimitText(output);
      if (limit) throw Object.assign(new Error(`Cursor: ${limit}.`), { limit: { until: null, reason: `Cursor: ${limit}.` } });
      keep = true;
      return { result: output, session_id: sessionId };
    } catch (error) { throw toolError || error; }
    finally {
      signal?.removeEventListener('abort', abort);
      // After its turn a connection approves nothing; only a structured one-off (never resumed) is not kept.
      rpc.route = { onUpdate: () => {}, onRequest: async () => ({ outcome: 'cancelled' }) };
      if (keep && (resume || !schema) && !signal?.aborted && rpc.open?.() !== false) this.park(sessionId, { rpc, key, init, applied });
      else rpc.close();
      if (toolError && rpc.child && (await stopTree(rpc.child)).length) throw new Error('Cursor review process cleanup is not confirmed.');
    }
  }
  close() { this.closeWarm(); for (const c of this.children) stop(c); }
}
module.exports = { CursorCLI, launchCursor, parseStatus, compactDiff, toolOutput };
