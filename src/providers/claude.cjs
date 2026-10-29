const { WORKER_INSTRUCTIONS } = require('../worker-instructions.cjs');
const { CLAUDE_MODEL_WINDOWS } = require('./limits.cjs');
const { stripTaskStatus } = require('../routing/task-state.cjs');
const { imageData } = require('../image-input.cjs');
const { spawn } = require('node:child_process');
const { spawnOwned, stopTree } = require('../process-tree.cjs');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash, randomUUID } = require('node:crypto');

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// How long a live follow-up waits for Claude to echo it back before it counts as uncertain.
const DELIVERY_MS = 30000;
// How long input stays open after the last background task ends; the CLI starts its wake-up turn within ~0.1 s (2026-10-28).
const WAKE_MS = 5000;
// Ask mode keeps a small tool set (smaller prompts, no subagents); anything beyond reading inside the workspace asks.
const ASK_TOOLS = ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'WebFetch', 'WebSearch'];
// Tools that only work with an interactive Claude Code user; in the Harness they would show as unanswerable prompts.
const INTERACTIVE_TOOLS = ['AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode'];
const ASK_NOTE = '\nHarness access: tool calls outside the pre-approved set wait for the user\'s approval. Prefer Read/Glob/Grep for inspection and group shell commands to keep approvals few.';

// Bots get Harness's rules and skills, not the user's personal Claude Code setup: user settings (their hooks,
// permissions, skills and subagents), the home CLAUDE.md and auto-memory stay out, and every plugin is off.
// The workspace's own CLAUDE.md files load as they do outside Harness; project settings/hooks and MCP servers remain available.
function withoutPersonalSetup() {
  const home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  let plugins = {};
  try {
    plugins = JSON.parse(fs.readFileSync(path.join(home, 'plugins', 'installed_plugins.json'), 'utf8')).plugins || {};
  } catch { /* none installed */ }

  const settings = {
    claudeMdExcludes: [...new Set([path.join(home, 'CLAUDE.md'), path.join(os.homedir(), 'CLAUDE.md')].map(file => file.replace(/\\/g, '/')))],
    enabledPlugins: Object.fromEntries(Object.keys(plugins).map(id => [id, false])),
    autoMemoryEnabled: false,
  };
  return ['--setting-sources', 'project,local', '--settings', JSON.stringify(settings)];
}

// Leaving out user settings also drops the user's MCP servers; Claude reads them straight from ~/.claude.json as an MCP
// config, so nothing is copied.
function personalMcp() {
  const file = path.join(process.env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
  try {
    return Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).mcpServers || {}).length ? [file] : [];
  } catch {
    return [];
  }
}

function executable() {
  const native = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return fs.existsSync(native) ? native : 'claude';
}

class ClaudeCLI {
  constructor(launch = spawn, cleanup = stopTree) {
    this.launch = launch; this.cleanup = cleanup; this.children = new Set(); this.models = []; this.status = { installed: null, loggedIn: false };
  }
  start(args, cwd) {
    // Authentication stays inside the published CLI, including user-configured auth methods.
    const child = spawnOwned(this.launch, executable(), args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    this.children.add(child); child.once('close', () => this.children.delete(child));
    return child;
  }
  async refresh() {
    this.authVerified = false;
    try {
      const result = await this.command(['auth', 'status']);
      const status = JSON.parse(result);
      this.status = { installed: true, loggedIn: status.loggedIn === true, authMethod: status.authMethod || null,
        email: status.loggedIn === true && typeof status.email === 'string' ? status.email : null,
        subscriptionType: status.loggedIn === true && typeof status.subscriptionType === 'string' ? status.subscriptionType : null };
      this.authVerified = this.status.loggedIn;
    } catch (error) { this.status = { installed: error.code !== 'ENOENT', loggedIn: false, error: error.code === 'ENOENT' ? 'Claude Code is not installed. Install it from Settings → Providers.' : 'Could not read Claude Code login status.' }; }
    if (this.status.loggedIn) {
      this.models = [];
      try { await this.discover(); delete this.status.modelsError; }
      catch (error) { this.status.modelsError = error.message; }
    } else this.models = [];
    return this.status;
  }
  accountKey() {
    return this.status.loggedIn ? createHash('sha256').update(JSON.stringify([
      this.status.authMethod || null, this.status.email || null, this.status.subscriptionType || null,
    ])).digest('hex') : null;
  }
  metadataHost() {
    return this.start(['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--settings', '{"disableAllHooks":true}'], os.tmpdir());
  }
  async readUsage() {
    if (this.usageCleanupHost) {
      let remaining;
      try { remaining = await this.cleanup(this.usageCleanupHost); } catch { remaining = [-1]; }
      if (!Array.isArray(remaining) || remaining.length)
        throw Object.assign(new Error('Claude usage lookup cleanup is unconfirmed.'), { code: 'CLEANUP_UNCERTAIN' });
      this.usageCleanupHost = null;
    }
    return new Promise((resolve, reject) => {
      const child = this.metadataHost();
      let buffer = '', settled = false, initialized = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        try { child.stdin.end(); } catch { /* Cleanup still owns this child. */ }
        Promise.resolve().then(() => this.cleanup(child)).then(remaining => {
          if (!Array.isArray(remaining) || remaining.length) {
            this.usageCleanupHost = child;
            reject(Object.assign(new Error('Claude usage lookup cleanup is unconfirmed.'), { code: 'CLEANUP_UNCERTAIN' }));
          }
          else if (error) reject(error);
          else resolve(value);
        }, () => {
          this.usageCleanupHost = child;
          reject(Object.assign(new Error('Claude usage lookup cleanup is unconfirmed.'), { code: 'CLEANUP_UNCERTAIN' }));
        });
      };
      const timer = setTimeout(() => finish(new Error('Claude usage lookup timed out.')), 10000);
      child.once('error', () => finish(new Error('Claude usage lookup could not start.')));
      child.once('close', () => finish(new Error('Claude usage lookup ended without a report.')));
      child.stdin.on('error', () => {});
      child.stderr.on('data', () => {});
      child.stdout.on('data', data => {
        buffer += data;
        if (buffer.length > 1024 * 1024) { finish(new Error('Claude usage report exceeded its size limit.')); return; }
        let newline;
        while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline).trim(); buffer = buffer.slice(newline + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); }
          catch { finish(new Error('Claude usage lookup returned an invalid event.')); return; }
          if (event.type !== 'control_response') continue;
          const response = event.response;
          if (response?.request_id === 'quota-init' && !initialized) {
            if (response.subtype === 'error') { finish(new Error('Claude usage initialization is unavailable.')); return; }
            initialized = true;
            child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'quota-read',
              request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n');
          } else if (response?.request_id === 'quota-read' && initialized) {
            if (response.subtype !== 'success' || !response.response || typeof response.response !== 'object')
              finish(new Error('This Claude Code version did not provide a usage report.'));
            else finish(null, response.response);
          }
        }
      });
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'quota-init',
        request: { subtype: 'initialize', hooks: {} } }) + '\n');
    });
  }
  discover() {
    return new Promise((resolve, reject) => {
      const child = this.metadataHost();
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
  run({ cwd, model, effort, prompt, images = [], resume, access, signal, onEvent = () => {}, approve, schema, helpers, onInput, instructions = WORKER_INSTRUCTIONS, managedInstructions = false, persistSession = false }) {
    let promptDirectory;
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Claude stopped.'));
      const args = ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--model', model,
        ...withoutPersonalSetup()];
      if (onInput && !schema) args.push('--replay-user-messages');
      if (EFFORTS.includes(effort)) args.push('--effort', effort);
      // With an approval callback, the Harness access setting applies: pre-approved tools run, anything else asks the user in the Harness.
      const ask = !schema && typeof approve === 'function' && ['read-only', 'workspace-write'].includes(access);
      const basePrompt = 'Preserve unrelated changes. Do not commit or push unless explicitly requested. Use one agent unless delegation is requested. Report permission denials clearly.';
      const systemPrompt = (schema ? basePrompt : instructions) + (!schema && helpers?.instructions ? helpers.instructions : '') + (ask ? ASK_NOTE : '');
      if (managedInstructions && !schema) {
        // File flags avoid Windows' command-line limit and pass the same rules to native nested agents.
        promptDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-claude-instructions-'));
        const file = path.join(promptDirectory, 'instructions.txt');
        fs.writeFileSync(file, systemPrompt, { mode: 0o600, flag: 'wx' });
        args.push('--append-system-prompt-file', file, '--append-subagent-system-prompt-file', file, '--system-prompt-snapshot', 'off');
      } else args.push('--append-system-prompt', systemPrompt);
      if (resume) args.push('--resume', resume);
      if (schema) args.push('--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', ...(!persistSession ? ['--no-session-persistence'] : []), '--json-schema', JSON.stringify(schema));
      else {
        // Not --strict-mcp-config: the user's own MCP servers stay, with ours added.
        const mcp = [...personalMcp(), ...(helpers?.claudeConfig ? [JSON.stringify(helpers.claudeConfig)] : [])];
        if (mcp.length)
          args.push('--mcp-config', ...mcp);
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
      const deliveries = new Map(), controls = new Map();
      const done = (fn, value) => {
        if (settled) return;
        settled = true;
        onInput?.(null);
        for (const delivery of deliveries.values()) delivery.reject(new Error('Claude closed before confirming message delivery.'));
        deliveries.clear();
        for (const request of controls.values()) request.reject(new Error('Claude closed before answering.'));
        fn(value);
      };
      const child = this.start(args, cwd); let buffer = '', result, stderr = '';
      // The whole tree: Claude's tool commands and MCP servers would otherwise outlive it.
      const abort = () => stopTree(child); signal?.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => {});
      let closed = false;
      // After a result Claude keeps running while a background task of it (background Bash, Monitor) runs, and answers
      // again when one ends, in a turn of its own that may start more tasks. Its input stays open until Claude is idle
      // with no task left and no such turn follows, so follow-ups reach it instead of waiting for the task.
      let idle = false, background = 0, tasksSeen = false, wake = null;
      // A resumed session first answers what it was left owing (a stopped task's notification) in a turn of its own, with
      // its own result; the prompt counts as taken only once Claude echoes it back (--replay-user-messages).
      const promptId = randomUUID();
      let promptPending = !!onInput && !schema;
      const closeIfIdle = () => {
        clearTimeout(wake);
        if (!idle || deliveries.size || background || !child.stdin.writable || child.stdin.writableEnded) return;
        onInput?.(null);
        child.stdin.end();
      };
      // Once this run has had a task, a finished task's wake-up can follow Claude's answer (a task that ended mid-turn) or
      // the last task ending, so input closes only if no turn starts in time. A run without tasks closes at once.
      const settleInput = () => {
        if (!tasksSeen && !promptPending)
          return closeIfIdle();

        clearTimeout(wake);
        wake = setTimeout(closeIfIdle, WAKE_MS);
        wake.unref?.();
      };
      // Requests Harness makes of the running CLI (stop_task, get_task_output); like follow-ups they need its input open.
      let controlCount = 0;
      const control = request => new Promise((resolve, reject) => {
        if (settled || closed || !child.stdin.writable || child.stdin.writableEnded)
          return reject(new Error('Claude is no longer accepting requests.'));
        const id = `harness-${++controlCount}`;
        const timer = setTimeout(() => controls.get(id)?.reject(new Error('Claude did not answer in time.')), 10000);
        controls.set(id, {
          resolve: value => { clearTimeout(timer); controls.delete(id); resolve(value); },
          reject: error => { clearTimeout(timer); controls.delete(id); reject(error); },
        });
        child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
      });
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
        if (buffer.length > 16 * 1024 * 1024) { done(reject, new Error('Claude event exceeded the size limit.')); stopTree(child); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          if (!line) continue;
          let event;
          try { event = JSON.parse(line); }
          catch { done(reject, new Error('Invalid Claude Code stream event.')); stopTree(child); return; }
          if (event.type === 'control_response' && controls.has(event.response?.request_id)) {
            const answer = event.response;
            if (answer.subtype === 'success') controls.get(answer.request_id).resolve(answer.response || {});
            else controls.get(answer.request_id).reject(new Error(answer.error || 'Claude refused the request.'));
            continue;
          }
          if (ask && event.type === 'control_request') { permission(event).catch(() => {}); continue; }
          if (ask && event.type === 'control_cancel_request') { pending.get(event.request_id)?.abort(); continue; }
          if (event.type === 'user' && deliveries.has(event.uuid)) {
            deliveries.get(event.uuid).resolve();
            deliveries.delete(event.uuid);
            idle = false;
          }
          if (event.type === 'user' && event.uuid === promptId) {
            promptPending = false;
            idle = false;
          }
          // A turn Claude starts by itself, such as a finished task's wake-up, is not idle either.
          if (event.type === 'assistant' || (event.type === 'system' && event.subtype === 'init')) {
            idle = false;
            clearTimeout(wake);
          }
          if (event.type === 'system' && event.subtype === 'background_tasks_changed' && Array.isArray(event.tasks)) {
            // Each event lists every live task; ambient ones are the CLI's own watchers, not the bot's work.
            background = event.tasks.filter(task => !task?.ambient).length;
            tasksSeen ||= background > 0;
            if (!background && idle)
              settleInput();
          }
          if (event.type === 'result') {
            // usage covers one result's calls; total_cost_usd and modelUsage are the session's running totals, so the
            // last result already holds them.
            if (result && onInput) {
              for (const key of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
                if (Number.isFinite(result.usage?.[key]) && Number.isFinite(event.usage?.[key]))
                  event.usage[key] += result.usage[key];
              }
            }
            result = event;
            idle = true;
            settleInput();
          }
          // Plan usage limits: the rate-limit event carries the window and its reset; a blocked reply is marked "rate_limit".
          if (event.type === 'rate_limit_event' && event.rate_limit_info) {
            limitInfo = event.rate_limit_info;
            this.onUsageChange?.();
          }
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
      const message = JSON.stringify({ type: 'user', uuid: promptId, parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'text', text: prompt }, ...images.map(url => imageData(url)).map(({ mime, data }) => ({ type: 'image', source: { type: 'base64', media_type: mime, data } }))] } }) + '\n';
      // Live input and approval answers share stdin until Claude finishes processing queued messages.
      if (ask || onInput) child.stdin.write(message); else child.stdin.end(message);
      if (onInput && !schema) onInput(({ id, text, images = [] }) => {
        if (settled || closed || signal?.aborted || !child.stdin.writable || child.stdin.writableEnded)
          return Promise.reject(new Error('Claude is no longer accepting messages.'));
        const content = [{ type: 'text', text }, ...images.map(imageData).map(({ mime, data }) =>
          ({ type: 'image', source: { type: 'base64', media_type: mime, data } }))];
        return new Promise((resolve, reject) => {
          // A delivery that fails or times out is dropped, so a turn that already finished still closes Claude's input.
          const drop = error => {
            clearTimeout(timer);
            deliveries.delete(id);
            reject(error);
            settleInput();
          };
          const timer = setTimeout(() => drop(new Error('Claude message delivery timed out. Check the conversation before resending.')), DELIVERY_MS);
          deliveries.set(id, {
            resolve: () => { clearTimeout(timer); resolve(); },
            reject: drop,
          });
          child.stdin.write(JSON.stringify({ type: 'user', uuid: id,
            message: { role: 'user', content }, parent_tool_use_id: null }) + '\n', error => {
            if (error) deliveries.get(id)?.reject(new Error('Claude input disconnected before delivery was confirmed.'));
          });
        });
      }, control);
    }).finally(() => {
      if (promptDirectory) fs.rmSync(promptDirectory, { recursive: true, force: true });
    });
  }
  close() {
    for (const child of this.children) stopTree(child);
    if (this.usageCleanupHost && !this.children.has(this.usageCleanupHost)) stopTree(this.usageCleanupHost);
  }
}

function handoff(items, maxLength = 1000000) {
  // Progress notes (commentary) are not history the next model needs; final answers carry the outcome.
  const messages = items.filter(i => i.type === 'userMessage' || (i.type === 'agentMessage' && i.phase !== 'commentary')).map(i => ({
    role: i.type === 'userMessage' ? 'user' : 'assistant',
    text: i.type === 'userMessage' ? (i.contextText || '') + (i.content || []).map(c => c.type === 'text' ? c.text : '[Earlier image attachment]').join('\n') : stripTaskStatus(i.text),
  }));
  const text = JSON.stringify(messages);
  if (text.length > maxLength) throw new Error('Conversation is too large to transfer. Start a new chat or compact it before switching backends.');
  return messages.length ? `Earlier conversation, supplied as history:\n${text}\n\nCurrent request:\n` : '';
}
module.exports = { ClaudeCLI, handoff, EFFORTS };
