const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { spawnOwned, stopTree } = require('../process-tree.cjs');
const { findNativeCLI, deadline } = require('./native-cli.cjs');
const { invalidResponse } = require('./structured.cjs');

// agy signs in with the Google account the Gemini tools share; its own log confirms "authenticated successfully as"
// the address google_accounts.json marks active (checked 2026-10-19).
function googleAccount(home = os.homedir()) {
  try {
    const active = JSON.parse(fs.readFileSync(path.join(home, '.gemini', 'google_accounts.json'), 'utf8')).active;
    return typeof active === 'string' && /^[^@\s]+@[^@\s]+$/.test(active) ? active : null;
  } catch {
    return null;
  }
}

const LABEL = 'Antigravity CLI';
const LIMIT = 16 * 1024 * 1024;

function agentText(name, mcpServers) {
  const definition = { name, description: 'Current PhasmaHarness worker', mainAgent: true, subagent: false,
    tools: ['view_file', 'grep_search', 'run_command', 'write_to_file', 'replace_file_content'], commandExecutionPolicy: 'eager', mcpServers };
  return '---\n' + Object.entries(definition).map(([key, value]) => key + ': ' + JSON.stringify(value)).join('\n') +
    '\n---\nFollow the current Harness assignment. Coordinate through the assigned Harness tools.\n';
}

// A crash can leave generated worker files behind. Run before any worker starts; only unchanged Harness files are removed.
function sweepAgentFiles(workspaces) {
  for (const workspace of new Set(workspaces.filter(Boolean))) {
    let directory, names;
    try {
      directory = path.join(fs.realpathSync(workspace), '.agents', 'agents');
      if (fs.realpathSync(directory) !== directory) continue;
      names = fs.readdirSync(directory);
    } catch { continue; }
    for (const name of names) {
      const match = /^(phasma-[0-9a-f-]{36})\.md$/.exec(name), file = path.join(directory, name);
      if (!match) continue;
      try {
        const stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536) continue;
        const content = fs.readFileSync(file, 'utf8'), servers = JSON.parse(/^mcpServers: (.*)$/m.exec(content)?.[1] || 'null');
        if (Array.isArray(servers) && servers.length <= 1 && content === agentText(match[1], servers)) fs.unlinkSync(file);
      } catch { /* Anything unreadable stays for review. */ }
    }
  }
}

function agentFile(cwd, helpers) {
  const root = fs.realpathSync(cwd);
  let directory = root;
  for (const name of ['.agents', 'agents']) {
    directory = path.join(directory, name);
    try { fs.mkdirSync(directory, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (fs.lstatSync(directory).isSymbolicLink() || fs.realpathSync(directory) !== directory || !fs.statSync(directory).isDirectory()) {
      throw new Error('Antigravity agent configuration requires ordinary workspace directories.');
    }
  }
  const name = 'phasma-' + randomUUID(), file = path.join(directory, name + '.md');
  // Bridge credentials are inherited by this process tree; never put them in project files.
  const content = agentText(name, helpers ? [{ name: helpers.serverName, command: helpers.command, args: helpers.args,
    env: { ELECTRON_RUN_AS_NODE: '1' } }] : []);
  fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
  return { name, remove() {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return;
    if (fs.realpathSync(path.dirname(file)) !== directory || !stat.isFile() || stat.nlink !== 1 ||
        stat.size !== Buffer.byteLength(content) ||
        fs.readFileSync(file, 'utf8') !== content) throw new Error('Antigravity worker configuration changed; it was preserved for review.');
    fs.unlinkSync(file);
  } };
}

function usageCounts(usage) {
  if (!usage || !['input_tokens', 'output_tokens'].every(key => Number.isSafeInteger(usage[key]) && usage[key] >= 0)) return null;
  // Antigravity counts cached input separately and includes thinking in output already.
  const cached = usage.cache_read_tokens;
  if (cached !== undefined && (!Number.isSafeInteger(cached) || cached < 0)) return null;
  if (!Number.isSafeInteger(usage.input_tokens + usage.output_tokens + (cached || 0))) return null;
  return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens,
    ...(cached !== undefined ? { cache_read_input_tokens: cached } : {}) };
}

class AntigravityCLI {
  constructor(launch = spawn, find = () => findNativeCLI('antigravity-cli')) {
    this.launch = launch; this.find = find; this.hosts = new Set();
    this.models = []; this.status = { installed: false, loggedIn: false };
  }

  inspect() {
    try { this.find(); this.status = { ...this.status, installed: true }; }
    catch { this.status = { installed: false, loggedIn: false }; }
    return this.status;
  }

  start(args, cwd, env = {}) {
    const executable = this.find();
    // agy is native; only its MCP child (agent file) needs ELECTRON_RUN_AS_NODE, and helpers.env carries it.
    const { ELECTRON_RUN_AS_NODE, ...hostEnv } = { ...process.env, ...env };
    const child = spawnOwned(this.launch, executable.command, [...executable.args, ...args], {
      cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...hostEnv, NO_BROWSER: 'true' },
    });
    const host = { child };
    this.hosts.add(host);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    return host;
  }

  async closeHost(host) {
    const survivors = await stopTree(host.child), agent = host.agent;
    if (!survivors.length) this.hosts.delete(host);
    // agy reads its agent file at startup, so the generated file goes even when the process tree outlives the stop.
    host.agent = null;
    agent?.remove();
    if (survivors.length) throw new Error('Antigravity cleanup is not confirmed. Resolve its running process before retrying.');
  }

  async metadata(args) {
    const host = this.start(args, os.tmpdir());
    try {
      return await deadline(new Promise((resolve, reject) => {
        let output = '', diagnostic = '';
        const data = (text, stderr) => {
          if (stderr) diagnostic += text; else output += text;
          if (output.length + diagnostic.length > LIMIT) reject(new Error('Antigravity metadata is too large.'));
        };
        host.child.stdout.on('data', text => data(text, false)); host.child.stderr.on('data', text => data(text, true));
        host.child.stdin.on('error', reject); host.child.once('error', reject);
        host.child.once('close', code => code === 0 ? resolve({ output, diagnostic }) : reject(new Error('Antigravity native setup is not ready. Run agy in your terminal, then reconnect.')));
        host.child.stdin.end();
      }), 15000, LABEL);
    } finally { await this.closeHost(host); }
  }

  async refresh() {
    if (this.hosts.size) throw new Error('Stop the current Antigravity process before refreshing.');
    try {
      const check = JSON.parse((await this.metadata(['-p', '/usage', '--output-format', 'json'])).output);
      if (check.status !== 'SUCCESS' || !check.command) throw new Error('Complete Antigravity native sign-in, then reconnect.');
      const { output, diagnostic } = await this.metadata(['models']);
      const rows = (output + '\n' + diagnostic).replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/);
      const models = new Map();
      for (const row of rows) {
        const match = row.match(/^\s*([a-z][a-z0-9._/-]*-[a-z0-9._/-]+)(?:\t+| {2,})(.+?)\s*$/);
        if (!match) continue;
        models.set(match[1], { id: `native:antigravity:${match[1]}`, model: match[1], label: match[2],
          provider: 'native:antigravity', rank: 35, worker: true, router: true, efforts: [], effort: null, images: false });
      }
      this.models = [...models.values()];
      if (!this.models.length) throw new Error('Antigravity returned no recognized models. Update it, then reconnect.');
      const account = googleAccount();
      this.status = { installed: true, loggedIn: true, ...(account ? { account } : {}) };
    } catch (error) {
      this.models = [];
      this.status = { installed: error.code !== 'ENOENT', loggedIn: false, error: error.message };
      if (this.hosts.size) throw error;
    }
    return this.status;
  }

  async run(options) {
    if (this.active || this.hosts.size) throw new Error('Antigravity already has an active process or pending cleanup.');
    // A Hub or routing reply is tool-free (a tool step below rejects it), so only worker turns need Full access.
    if (!options.schema && options.access !== 'danger-full-access') throw new Error('Antigravity currently requires Full access. Ask and Workspace permissions are not verified for its headless interface.');
    if (options.images?.length) throw new Error('Antigravity headless input accepts text only. Choose another worker for images.');
    if (options.signal?.aborted) throw Object.assign(new Error('Antigravity stopped.'), { name: 'AbortError' });
    this.active = true;
    let host, agent, succeeded = false;
    try {
      agent = agentFile(options.cwd, options.helpers);
      // A tool-free reply runs without auto-approve, so a tool agy reaches for asks (agy 2026-10-31: "request-review") instead of running.
      const args = ['--agent', agent.name, '--input-format', 'stream-json', '--output-format', 'stream-json',
        '--disable-slash-commands', ...(options.schema ? [] : ['--dangerously-skip-permissions'])];
      if (options.model) args.push('--model', options.model);
      if (options.resume) args.push('--conversation', options.resume);
      if (options.effort) args.push('--effort', options.effort);
      host = this.start(args, options.cwd, options.helpers?.env);
      host.agent = agent;
      const result = await deadline(new Promise((resolve, reject) => {
        let buffer = '', received = 0, initialized = false, sessionId, settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          error ? reject(error) : resolve(value);
        };
        const tools = new Set(), onEvent = options.onEvent || (() => {});
        host.child.stdin.on('error', error => finish(error)); host.child.once('error', error => finish(error));
        host.child.once('close', () => finish(new Error('Antigravity exited before confirming a result. Review its saved session before retrying.')));
        host.child.stderr.on('data', () => {});
        const event = value => {
          if (options.signal?.aborted) throw Object.assign(new Error('Antigravity stopped.'), { name: 'AbortError' });
          if (value.event === 'init') {
            if (initialized || value.init?.agent !== agent.name || value.init?.permission_mode !== (options.schema ? 'request-review' : 'always-proceed') ||
                typeof value.conversation_id !== 'string' || !value.conversation_id ||
                (options.resume && value.conversation_id !== options.resume)) throw new Error('Antigravity did not confirm the requested worker, session and permission mode.');
            initialized = true; sessionId = value.conversation_id;
            onEvent({ type: 'system', session_id: sessionId });
            const content = [options.instructions, options.helpers?.instructions,
              options.schema && !(options.resume && options.schemaInHistory) ? `Return only a JSON object matching this schema. No tools are available.\n${JSON.stringify(options.schema)}` : '',
              options.prompt].filter(Boolean).join('\n\n');
            host.child.stdin.write(JSON.stringify({ event: 'user', message: { content } }) + '\n');
          } else if (value.event === 'step_update') {
            const step = value.step_update;
            if (!initialized || step?.conversation_id !== sessionId) throw new Error('Antigravity returned an unrelated step.');
            if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') onEvent({ type: 'stream_event',
              event: { type: 'content_block_delta', delta: { type: 'text_delta', text: step.text_delta } } });
            if (step.step_type === 'tool' && typeof step.tool_name === 'string' && Number.isSafeInteger(step.step_index)) {
              // A Hub or routing reply is tool-free, as for every provider: a reply that uses a tool is not accepted (cursor.cjs).
              if (options.schema) throw invalidResponse();
              const id = sessionId + ':' + step.step_index;
              if (!tools.has(id)) {
                tools.add(id);
                onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: step.tool_name, input: step.tool_info?.parameters || {} }] } });
              }
              if (step.state === 'DONE') onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id,
                is_error: !!step.tool_info?.error, content: step.tool_info?.error || step.tool_info?.output || '' }] } });
            }
          } else if (value.event === 'result') {
            const result = value.result;
            if (!initialized || result?.conversation_id !== sessionId) throw new Error('Antigravity returned an unrelated result.');
            if (result.status !== 'SUCCESS') {
              const limited = /quota|rate.?limit|usage.?limit|resource.exhausted|too many requests/i.test(result.error || '');
              throw new Error(`Antigravity ${limited ? 'usage limit reached' : 'turn ended with ' + String(result.status)}. Review its saved session before retrying.`);
            }
            if (typeof result.response !== 'string') throw new Error('Antigravity returned no response.');
            // Resumed-session counters may include older turns; keep usage unknown until verified.
            const usage = !options.resume && result.num_turns === 1 ? usageCounts(result.usage) : null;
            onEvent({ type: 'assistant', message: { content: [{ type: 'text', text: result.response }] } });
            finish(null, { result: result.response, session_id: sessionId, ...(usage ? { usage } : {}), cacheUsageUnknown: !usage || result.usage.cache_read_tokens === undefined });
          } else throw new Error('Unsupported Antigravity stream event. Update the adapter before continuing.');
        };
        host.child.stdout.on('data', text => {
          if (settled) return;
          try {
            received += text.length; buffer += text;
            if (received > LIMIT * 2 || buffer.length > LIMIT) throw new Error('Antigravity output is too large.');
            let newline;
            while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
              if (line.trim()) event(JSON.parse(line));
            }
          } catch (error) { finish(error); }
        });
      }), options.timeoutMs || 30 * 60 * 1000, LABEL, options.signal);
      succeeded = true;
      return result;
    } finally {
      // A confirmed result stands; an unconfirmed stop keeps the host pending, so the next run refuses until it is resolved.
      try { if (host) await this.closeHost(host); else agent?.remove(); }
      catch (error) { if (!succeeded) throw error; }
      finally { this.active = false; }
    }
  }

  async login() { throw new Error('Run agy in your terminal to complete its native sign-in, then reconnect in Harness.'); }
  close() { return Promise.all([...this.hosts].map(host => this.closeHost(host))); }
}

module.exports = { AntigravityCLI, sweepAgentFiles, googleAccount };
