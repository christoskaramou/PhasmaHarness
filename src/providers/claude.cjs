const { WORKER_INSTRUCTIONS } = require('../worker-instructions.cjs');
const { CLAUDE_MODEL_WINDOWS } = require('./limits.cjs');
const { stripTaskStatus } = require('../routing/task-state.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Ask mode keeps a small tool set (smaller prompts, no subagents); anything beyond reading inside the workspace asks.
const ASK_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'];
// Tools that only work with an interactive Claude Code user; in the Harness they would show as unanswerable prompts.
const INTERACTIVE_TOOLS = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];
const ASK_NOTE = '\nHarness access: tool calls outside the pre-approved set wait for the user\'s approval. Prefer Read/Glob/Grep for inspection and group shell commands to keep approvals few.';

function executable() {
  const native = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return fs.existsSync(native) ? native : 'claude';
}

class ClaudeCLI {
  constructor(launch = spawn) { this.launch = launch; this.children = new Set(); this.models = []; this.status = { installed: false, loggedIn: false }; }
  start(args, cwd) {
    // Authentication stays inside the published CLI, including user-configured auth methods.
    const child = this.launch(executable(), args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    this.children.add(child); child.once('close', () => this.children.delete(child));
    return child;
  }
  async refresh() {
    try {
      const result = await this.command(['auth', 'status']);
      const status = JSON.parse(result);
      this.status = { installed: true, loggedIn: status.loggedIn === true, authMethod: status.authMethod || null,
        email: status.loggedIn === true && typeof status.email === 'string' ? status.email : null,
        subscriptionType: status.loggedIn === true && typeof status.subscriptionType === 'string' ? status.subscriptionType : null };
    } catch (error) { this.status = { installed: error.code !== 'ENOENT', loggedIn: false, error: error.code === 'ENOENT' ? 'Claude Code is not installed. Install it from Settings → Providers.' : 'Could not read Claude Code login status.' }; }
    if (this.status.loggedIn) {
      this.models = [];
      try { await this.discover(); delete this.status.modelsError; }
      catch (error) { this.status.modelsError = error.message; }
    } else this.models = [];
    return this.status;
  }
  discover() {
    return new Promise((resolve, reject) => {
      const child = this.start(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--settings', '{"disableAllHooks":true}'], os.tmpdir());
      let buffer = '', settled = false;
      const finish = (error, models) => {
        if (settled) return;
        settled = true; clearTimeout(timer); child.kill();
        if (error) reject(error); else { this.models = models; resolve(models); }
      };
      const timer = setTimeout(() => finish(new Error('Claude model discovery timed out.')), 15000);
      child.on('error', error => finish(error));
      child.on('close', () => finish(new Error('Claude model discovery ended without a model list.')));
      child.stdin.on('error', error => finish(error));
      child.stderr.on('data', () => {});
      child.stdout.on('data', data => {
        buffer += data;
        if (buffer.length > 1024 * 1024) return finish(new Error('Claude model response exceeded the size limit.'));
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          try {
            const event = JSON.parse(line);
            if (event.type !== 'control_response' || event.response?.request_id !== 'models') continue;
            const entries = event.response.response?.models;
            if (!Array.isArray(entries) || !entries.length) throw new Error('Claude returned no available models.');
            const models = new Map();
            for (const entry of entries) {
              let model = entry.resolvedModel || entry.value;
              if (typeof model !== 'string' || !model.trim()) throw new Error('Claude returned an invalid model.');
              if (entry.value?.endsWith('[1m]') && !model.endsWith('[1m]')) model += '[1m]';
              const efforts = entry.supportsEffort && Array.isArray(entry.supportedEffortLevels) ? EFFORTS.filter(e => entry.supportedEffortLevels.includes(e)) : [];
              // Remember which CLI aliases (opus, sonnet[1m], …) resolve to this model, so saved alias IDs can be migrated.
              const aliases = [...(models.get(model)?.aliases || []), ...(typeof entry.value === 'string' && !entry.value.startsWith('claude-') ? [entry.value] : [])];
              models.set(model, { id: `claude-cli:${model}`, model, label: model, provider: 'claude-cli', effort: null, efforts, aliases,
                rank: 35, worker: true, router: true, images: true });
            }
            finish(null, [...models.values()]);
          } catch (error) { finish(error); }
        }
      });
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'models', request: { subtype: 'initialize', hooks: {} } }) + '\n');
    });
  }
  command(args, onOutput, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const child = this.start(args); let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Claude Code command timed out.')); }, timeout);
      child.stdout.on('data', data => { output += data; onOutput?.(String(data)); });
      child.stderr.on('data', data => onOutput?.(String(data)));
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); if (code && !output.trim().startsWith('{')) reject(new Error('Claude Code command failed.')); else resolve(output); });
      child.stdin.end();
    });
  }
  async login(open) {
    if (this.loginPending) throw new Error('Claude sign-in is already running.');
    this.loginPending = true;
    let buffer = '', opened = false;
    try {
      await this.command(['auth', 'login'], chunk => {
        buffer = (buffer + chunk).slice(-16000);
        const match = buffer.slice(0, buffer.lastIndexOf('\n') + 1).match(/https:\/\/[^\s\u001b]+/g)?.find(value => {
          try { const u = new URL(value); return ['claude.ai', 'platform.claude.com', 'console.anthropic.com'].includes(u.hostname); } catch { return false; }
        });
        if (match && !opened) { opened = true; open(match); }
      }, 300000);
      return await this.refresh();
    } finally { this.loginPending = false; }
  }
  async logout() {
    if (this.loginPending) throw new Error('Claude sign-in is already running.');
    try {
      await this.command(['auth', 'logout'], undefined, 30000);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Claude Code is not installed. Install it from Settings → Providers.');
      // Fall through to refresh; status may already be signed out.
    }
    return await this.refresh();
  }
  run({ cwd, model, effort, prompt, images = [], resume, access, signal, onEvent = () => {}, approve, schema, helpers, instructions = WORKER_INSTRUCTIONS }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Claude stopped.'));
      const args = ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--model', model];
      if (EFFORTS.includes(effort)) args.push('--effort', effort);
      // With an approval callback, the Harness access setting applies: pre-approved tools run, anything else asks the user in the Harness.
      const ask = !schema && typeof approve === 'function' && ['read-only', 'workspace-write'].includes(access);
      const basePrompt = 'Preserve unrelated changes. Do not commit or push unless explicitly requested. Use one agent unless delegation is requested. Report permission denials clearly.';
      args.push('--append-system-prompt', (schema ? basePrompt : instructions) + (!schema && helpers?.instructions ? helpers.instructions : '') + (ask ? ASK_NOTE : ''));
      if (resume) args.push('--resume', resume);
      if (schema) args.push('--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--json-schema', JSON.stringify(schema));
      else {
        // Do not use --strict-mcp-config here: preserve the user's Claude MCP servers and add ours.
        if (helpers?.claudeConfig) args.push('--mcp-config', JSON.stringify(helpers.claudeConfig));
        if (ask) {
          const helperTools = helpers ? helpers.allowedTools(access) : [];
          if (access === 'read-only') {
            // Ask: reads inside the workspace and commands Claude Code classifies as read-only run;
            // reads outside the workspace, other commands, edits and web access ask.
            args.push('--tools', [...ASK_TOOLS, ...helperTools].join(','));
            if (helperTools.length) args.push('--allowedTools', helperTools.join(','));
          } else {
            // Workspace (acceptEdits): reads anywhere, edits and filesystem commands inside the workspace run;
            // other commands, edits outside the workspace and web access ask.
            args.push('--allowedTools', ['Read', 'Glob', 'Grep', ...helperTools].join(','));
          }
          args.push('--disallowedTools', INTERACTIVE_TOOLS.join(','), '--permission-prompt-tool', 'stdio');
        } else if (access === 'read-only') {
          const allowed = ['Read', 'Glob', 'Grep', ...(helpers ? helpers.allowedTools(access) : [])];
          args.push('--tools', allowed.join(','));
        } else if (access === 'workspace-write') {
          const allowed = ['Read', 'Glob', 'Grep', 'Edit', 'Write', ...(helpers ? helpers.allowedTools(access) : [])];
          args.push('--allowedTools', allowed.join(','));
        }
        // danger-full-access: leave Claude's native tool set unrestricted; helpers arrive via mcp-config.
      }
      args.push('--permission-mode', access === 'danger-full-access' && !schema ? 'bypassPermissions'
        : ask ? (access === 'workspace-write' ? 'acceptEdits' : 'default') : 'dontAsk');
      let settled = false, rateLimited = false, limitInfo = null;
      const done = (fn, value) => { if (!settled) { settled = true; fn(value); } };
      const child = this.start(args, cwd); let buffer = '', result, stderr = '';
      const abort = () => child.kill(); signal?.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => {});
      let closed = false;
      const pending = new Map();
      const reply = (request_id, response) => {
        pending.delete(request_id);
        if (settled || closed || signal?.aborted || !child.stdin.writable || child.stdin.writableEnded) return;
        child.stdin.write(JSON.stringify({ type: 'control_response', response: { request_id, ...response } }) + '\n');
      };
      const permission = async event => {
        const request = event.request || {};
        if (request.subtype !== 'can_use_tool') return reply(event.request_id, { subtype: 'error', error: `Unsupported control request: ${request.subtype}` });
        const input = request.input && typeof request.input === 'object' ? request.input : {};
        let allowed = false;
        const cancel = new AbortController();
        pending.set(event.request_id, cancel);
        try {
          allowed = !signal?.aborted && await approve({
            title: request.title || `Allow Claude to use ${request.display_name || request.tool_name}?` + (request.blocked_path ? ` (${request.blocked_path})` : ''),
            // Shown to the user; an input field named "tool" must not hide the real tool name.
            rawInput: Object.hasOwn(input, 'tool') ? { tool: request.tool_name, input } : { tool: request.tool_name, ...input },
            // What "Allow for this session" keys on (see sessionAllowKey).
            toolName: String(request.tool_name || ''), input, blockedPath: request.blocked_path,
          }, { signal: cancel.signal }) === true;
        } catch { allowed = false; }
        if (cancel.signal.aborted) return pending.delete(event.request_id);
        reply(event.request_id, { subtype: 'success', response: allowed
          ? { behavior: 'allow', updatedInput: input, toolUseID: request.tool_use_id }
          : { behavior: 'deny', message: 'The user declined this in Phasma Harness.', toolUseID: request.tool_use_id } });
      };
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
      child.stdout.on('data', d => {
        buffer += d;
        if (settled) return;
        if (buffer.length > 16 * 1024 * 1024) { done(reject, new Error('Claude event exceeded the size limit.')); child.kill(); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); }
          catch { done(reject, new Error('Invalid Claude Code stream event.')); child.kill(); return; }
          if (ask && event.type === 'control_request') { permission(event).catch(() => {}); continue; }
          if (ask && event.type === 'control_cancel_request') { pending.get(event.request_id)?.abort(); continue; }
          if (event.type === 'result') { result = event; if (ask) child.stdin.end(); }
          // Plan usage limits: the rate-limit event carries the window and its reset; a blocked reply is marked "rate_limit".
          if (event.type === 'rate_limit_event' && event.rate_limit_info) limitInfo = event.rate_limit_info;
          if (event.type === 'assistant' && event.error === 'rate_limit') rateLimited = true;
          onEvent(event);
        }
      });
      child.once('error', error => done(reject, error));
      child.once('close', code => {
        closed = true;
        signal?.removeEventListener('abort', abort);
        for (const cancel of pending.values()) cancel.abort();
        if (signal?.aborted) done(reject, new Error('Claude stopped.'));
        else if (code || !result || result.is_error) {
          const message = result?.errors?.join('\n') || (result?.is_error && typeof result.result === 'string' && result.result.trim())
            || (stderr ? 'Claude Code failed. Check its login and model access.' : 'Claude Code did not complete the response.');
          const error = new Error(message);
          // A blocked reply is a limit; so is a rejected window, unless paid extra usage covers the overflow.
          const overage = limitInfo?.isUsingOverage === true || ['allowed', 'allowed_warning'].includes(limitInfo?.overageStatus);
          if (rateLimited || (limitInfo?.status === 'rejected' && !overage))
            error.limit = { until: Number.isFinite(limitInfo?.resetsAt) ? limitInfo.resetsAt * 1000 : null, reason: message, type: limitInfo?.rateLimitType || null,
              family: CLAUDE_MODEL_WINDOWS[limitInfo?.rateLimitType] || null };
          done(reject, error);
        }
        else done(resolve, result);
      });
      const message = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }, ...images.map(url => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: url.split(',')[1] } }))] } }) + '\n';
      // Approval answers travel over stdin, so it stays open until the result arrives.
      if (ask) child.stdin.write(message); else child.stdin.end(message);
    });
  }
  close() { for (const child of this.children) child.kill(); }
}

function handoff(items) {
  const messages = items.filter(i => i.type === 'userMessage' || i.type === 'agentMessage').map(i => ({
    role: i.type === 'userMessage' ? 'user' : 'assistant',
    text: i.type === 'userMessage' ? (i.content || []).map(c => c.type === 'text' ? c.text : '[Earlier image attachment]').join('\n') : stripTaskStatus(i.text),
  }));
  const text = JSON.stringify(messages);
  if (text.length > 1000000) throw new Error('Conversation is too large to transfer. Start a new chat or compact it before switching backends.');
  return messages.length ? `Earlier conversation, supplied as history:\n${text}\n\nCurrent request:\n` : '';
}
module.exports = { ClaudeCLI, handoff, EFFORTS };
