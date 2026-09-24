const { WORKER_INSTRUCTIONS } = require('../worker-instructions.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function stop(child) {
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => child.kill());
  } else child.kill();
}

function launchCursor(args, cwd) {
  if (process.platform === 'win32') {
    const script = path.join(process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'), 'cursor-agent', 'cursor-agent.ps1');
    if (!fs.existsSync(script)) throw Object.assign(new Error('Cursor CLI is not installed. Install it from Settings → Providers.'), { code: 'ENOENT' });
    const root = path.dirname(script);
    const version = fs.readdirSync(path.join(root, 'versions')).filter(v => /^\d{4}\.\d{2}\.\d{2}(?:-\d{2}-\d{2}-\d{2})?-[a-f0-9]+$/.test(v)).sort().at(-1);
    if (!version) throw new Error('Cursor CLI installation is incomplete. Run its installer again.');
    const directory = path.join(root, 'versions', version);
    return spawn(path.join(directory, 'node.exe'), [path.join(directory, 'index.js'), ...args], { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  }
  const local = path.join(require('node:os').homedir(), '.local', 'bin', 'cursor-agent');
  return spawn(fs.existsSync(local) ? local : 'cursor-agent', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
}

function parseStatus(output) {
  const text = String(output || '').replace(/\x1b\[[0-9;]*m/g, '');
  const match = text.match(/logged in as\s+(\S+)/i);
  if (!match) return { installed: true, loggedIn: false };
  const identity = match[1].replace(/[.,;:!?)]+$/, '');
  return { installed: true, loggedIn: true, email: /@/.test(identity) ? identity : null, identity };
}

class CursorCLI {
  constructor(launch = launchCursor) { this.launch = launch; this.children = new Set(); this.status = { installed: false, loggedIn: false }; this.models = []; }
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
    try { await this.command(['login'], 300000); return await this.refresh(); }
    finally { this.loginPending = false; }
  }
  async logout() {
    if (this.loginPending) throw new Error('Cursor login is already running.');
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
      this.models = (session.models?.availableModels || []).map(m => ({ id: m.modelId, label: m.name }));
      if (!this.models.length) throw new Error('Cursor returned no model IDs. Refresh its CLI and try again.');
      return this.models;
    } finally { rpc.close(); }
  }
  connect({ cwd, model, signal, onUpdate = () => {}, onRequest = async () => ({ outcome: 'cancelled' }) }) {
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
    return { call, close };
  }
  async run({ cwd, model, prompt, images = [], resume, access, signal, onEvent = () => {}, approve = async () => false, schema, helpers, instructions = WORKER_INSTRUCTIONS }) {
    let sessionId, output = '', prompting = false; const messageId = randomUUID();
    const rpc = this.connect({ cwd, model, signal,
      onUpdate: p => {
        if (!prompting || p.sessionId !== sessionId) return;
        const u = p.update;
        if (u?.sessionUpdate === 'agent_message_chunk' && u.content?.type === 'text') {
          output += u.content.text;
          onEvent({ type: 'assistant', session_id: sessionId, message: { id: messageId, content: [{ type: 'text', text: output }] } });
        }
        if (u?.sessionUpdate === 'tool_call') onEvent({ type: 'assistant', session_id: sessionId, message: { content: [{ type: 'tool_use', id: u.toolCallId, name: u.title || u.kind || 'Cursor tool', input: u.rawInput || {} }] } });
        if (u?.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(u.status)) onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: u.toolCallId, is_error: u.status === 'failed', content: u.content || [] }] } });
      },
      onRequest: async (method, p) => {
        if (method === 'session/request_permission') {
          // Ask and Workspace access both ask the user in the Harness, like Codex and Claude; classifiers never get tools.
          const allowed = !schema && (access === 'danger-full-access' || await approve(p.toolCall) === true);
          const option = p.options?.find(o => o.kind === (allowed ? 'allow_once' : 'reject_once'));
          return { outcome: option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } };
        }
        if (method === 'cursor/create_plan') return { outcome: { outcome: !schema && await approve({ title: p.name || 'Approve Cursor plan', rawInput: p.plan }) ? 'accepted' : 'rejected' } };
        if (method === 'cursor/ask_question') return { outcome: { outcome: 'skipped', reason: 'Ask the user in the chat response.' } };
        return { outcome: 'cancelled' };
      } });
    try {
      const init = await rpc.call('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'phasma-harness', version: '0.1.0' } });
      if (images.length && !init.agentCapabilities?.promptCapabilities?.image) throw new Error('Cursor CLI did not advertise image support.');
      // Authentication is completed by the official login command, never token extraction.
      // Classifiers keep an empty MCP list. Workers get the bundled helper MCP via session mcpServers.
      const mcpServers = (!schema && helpers?.cursorServers) ? helpers.cursorServers : [];
      const s = await rpc.call(resume ? 'session/load' : 'session/new', { ...(resume ? { sessionId: resume } : {}), cwd, mcpServers });
      sessionId = resume || s.sessionId;
      if (!sessionId) throw new Error('Cursor did not return a session ID.');
      onEvent({ type: 'system', session_id: sessionId });
      await rpc.call('session/set_model', { sessionId, modelId: model });
      await rpc.call('session/set_mode', { sessionId, modeId: schema || access === 'read-only' ? 'ask' : 'agent' });
      prompting = true;
      const helperNote = (!schema && helpers?.instructions) ? '\n\nApp helper note (not Cursor system policy):' + helpers.instructions : '';
      const result = await rpc.call('session/prompt', { sessionId, prompt: [{ type: 'text', text: (schema ? '' : 'Harness worker defaults (subject to user overrides):\n' + instructions + '\n\nCurrent request:\n') + prompt + helperNote + (schema ? '\nReturn only JSON matching this schema: ' + JSON.stringify(schema) : '') }, ...images.map(url => ({ type: 'image', mimeType: 'image/png', data: url.split(',')[1] }))] }, 0);
      if (result.stopReason !== 'end_turn') throw new Error(`Cursor stopped: ${result.stopReason || 'unknown reason'}`);
      return { result: output, session_id: sessionId };
    } finally { rpc.close(); }
  }
  close() { for (const c of this.children) stop(c); }
}
module.exports = { CursorCLI, launchCursor, parseStatus };
