const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { spawnOwned, stopTree } = require('../process-tree.cjs');
const { findNativeCLI, deadline, takeTurn } = require('./native-cli.cjs');
const { imageData } = require('../image-input.cjs');
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
// agy hard-truncates a single user message from the tail around ~256 KiB (observed 2026-11-23: 257,546 bytes kept).
// Reject above 200 KiB pre-flight instead of letting agy silently drop newest history and the live prompt.
const MAX_MESSAGE_BYTES = 200 * 1024;
const preflight = message => Object.assign(new Error(message), { preserveSession: true });

// A finished poolable worker turn keeps its agy process running for the conversation's next turn, which then skips
// CLI startup and MCP server spawns. Like Claude/Cursor: at most three stay warm across all bots, each for 10 minutes
// after its last turn, oldest first. Turns with other cwd/model/effort/access/helpers, tool-free turns, or images start fresh.
const WARM = new Map();
const WARM_MS = 10 * 60 * 1000, WARM_MAX = 3;

function dropWarm(sessionId, stop = true) {
  const entry = WARM.get(sessionId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  if (entry.onClose) entry.child.removeListener('close', entry.onClose);
  if (entry.onError) entry.child.removeListener('error', entry.onError);
  if (entry.onStdinError) entry.child.stdin?.removeListener('error', entry.onStdinError);
  if (entry.onStdout) entry.child.stdout?.removeListener('data', entry.onStdout);
  WARM.delete(sessionId);
  if (stop) {
    const stopping = entry.owner.closeHost(entry.host);
    stopping.catch(() => {});
    return { entry, stopping };
  }
  return { entry, stopping: null };
}

function helperSignature(helpers) {
  if (!helpers) return null;
  const env = helpers.env && typeof helpers.env === 'object'
    ? Object.entries(helpers.env).filter(([key]) => key !== 'ELECTRON_RUN_AS_NODE').sort(([a], [b]) => a.localeCompare(b))
    : [];
  return [helpers.serverName || null, helpers.command || null, Array.isArray(helpers.args) ? helpers.args : [], env];
}

function agentText(name, mcpServers) {
  const definition = { name, description: 'Current PhasmaHarness worker', mainAgent: true, subagent: false,
    tools: ['view_file', 'grep_search', 'run_command', 'write_to_file', 'replace_file_content', 'generate_image', 'search_web'], commandExecutionPolicy: 'eager', mcpServers };
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

// Antigravity reports no context window (checked live 2026-11-04: not in ACP, print-mode JSON or `agy models`), so its
// models' published sizes stand in. ponytail: matched by family prefix (gemini-3.8-flash-high, claude-opus-4-6-thinking,
// gpt-oss-120b-medium as listed by `agy models` 2026-11-04); unknown families get none and cold start assumes 200,000.
// Update this table when Antigravity adds a family with another size.
const CONTEXT_WINDOWS = [[/^gemini-/, 1048576], [/^claude-/, 200000], [/^gpt-oss-/, 131072]];
const contextWindow = model => CONTEXT_WINDOWS.find(([family]) => family.test(model || ''))?.[1];

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
    this.launch = launch; this.find = find; this.hosts = new Set(); this.usageHosts = new Set();
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
    this.hosts.add(host);
    const survivors = await stopTree(host.child), agent = host.agent;
    if (!survivors.length) this.hosts.delete(host);
    // agy reads its agent file at startup, so the generated file goes even when the process tree outlives the stop.
    host.agent = null;
    agent?.remove();
    if (survivors.length) throw new Error('Antigravity cleanup is not confirmed. Resolve its running process before retrying.');
  }

  park(sessionId, entry) {
    dropWarm(sessionId, true);
    const host = entry.host, child = host.child;
    const warm = {
      ...entry,
      owner: this,
      child,
      onClose: () => { if (WARM.get(sessionId) === warm) dropWarm(sessionId, true); },
      onError: () => { if (WARM.get(sessionId) === warm) dropWarm(sessionId, true); },
      onStdinError: () => { if (WARM.get(sessionId) === warm) dropWarm(sessionId, true); },
      onStdout: text => {
        if (typeof text === 'string' && !text.trim()) return;
        if (WARM.get(sessionId) === warm) dropWarm(sessionId, true);
      },
    };
    child.once('close', warm.onClose);
    child.on('error', warm.onError);
    child.stdin?.on('error', warm.onStdinError);
    child.stdout?.on('data', warm.onStdout);
    warm.timer = setTimeout(() => { if (WARM.get(sessionId) === warm) dropWarm(sessionId, true); }, WARM_MS);
    warm.timer.unref?.();
    WARM.set(sessionId, warm);
    this.hosts.delete(host);
    while (WARM.size > WARM_MAX) dropWarm(WARM.keys().next().value, true);
  }

  warmCount() { return [...WARM.values()].filter(entry => entry.owner === this).length; }

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
          provider: 'native:antigravity', rank: 35, worker: true, router: true, efforts: [], effort: null, images: true });
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
    // A second call waits for the first; a stop whose cleanup was never confirmed still refuses (see the finally below).
    const release = await takeTurn(this, options.signal, LABEL);
    if (this.hosts.size) { release(); throw preflight('Antigravity already has an active process or pending cleanup.'); }
    // A Hub/routing reply (schema) or cancelled-result acknowledgement (noTools) is tool-free (a tool step below rejects it),
    // so only tool-using worker turns need Full access.
    const toolFree = !!options.schema || !!options.noTools;
    if (!toolFree && options.access !== 'danger-full-access') { release(); throw preflight('Antigravity currently requires Full access. Ask and Workspace permissions are not verified for its headless interface.'); }
    let parsedImages = [];
    if (options.images?.length) {
      if (toolFree) { release(); throw preflight('Antigravity structured tool-free replies cannot inspect direct image attachments; use a worker turn or Jev image assist.'); }
      try { parsedImages = options.images.map(imageData); }
      catch (error) { release(); throw Object.assign(error, { preserveSession: true }); }
    }
    if (options.signal?.aborted) { release(); throw Object.assign(new Error('Antigravity stopped.'), { name: 'AbortError' }); }
    let host, agent, imageDir = null, imagePaths = [], succeeded = false, trailingBuffer = false, cleanupListeners = null, resolvedSessionId = null;
    const poolable = !toolFree && !parsedImages.length;
    let signature = null;
    try {
      if (parsedImages.length) {
        imageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agy-img-'));
        try { fs.chmodSync(imageDir, 0o700); } catch { /* Windows ignores POSIX mode bits */ }
        imagePaths = parsedImages.map(({ mime, data }, index) => {
          const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
          const file = path.join(imageDir, `image-${index + 1}.${ext}`);
          fs.writeFileSync(file, Buffer.from(data, 'base64'), { mode: 0o600 });
          return file;
        });
      }
      const imageNote = imagePaths.length
        ? `Attached image files (inspect with read_file or view_file):\n${imagePaths.map(file => `- ${file}`).join('\n')}` : '';
      const modeNote = options.schema && !(options.resume && options.schemaInHistory)
        ? `Return only a JSON object matching this schema. No tools are available.\n${JSON.stringify(options.schema)}`
        : options.noTools && !options.schema ? 'No tools are available for this turn. Reply in text only.' : '';
      const content = [options.instructions, toolFree ? '' : options.helpers?.instructions, modeNote,
        options.prompt, imageNote].filter(Boolean).join('\n\n');
      const contentBytes = Buffer.byteLength(content, 'utf8');
      if (contentBytes > MAX_MESSAGE_BYTES) {
        throw preflight(`Message (${contentBytes.toLocaleString('en-US')} bytes) exceeds Antigravity CLI's safe single-message limit (${MAX_MESSAGE_BYTES.toLocaleString('en-US')} bytes) and would be truncated. Shorten the message or start a new chat.`);
      }
      if (poolable) {
        signature = JSON.stringify([fs.realpathSync(options.cwd), options.model || null, options.effort || null, options.access, helperSignature(options.helpers)]);
      }
      const existingWarm = options.resume && WARM.get(options.resume)?.owner === this
        ? dropWarm(options.resume, false)?.entry
        : null;
      const canReuse = Boolean(
        existingWarm &&
        poolable &&
        existingWarm.signature === signature &&
        existingWarm.host.child.exitCode === null &&
        !existingWarm.host.child.killed &&
        existingWarm.host.child.stdin?.writable &&
        !existingWarm.host.child.stdin?.writableEnded
      );
      if (existingWarm && !canReuse) await this.closeHost(existingWarm.host);
      const reused = canReuse;
      if (reused) {
        host = existingWarm.host;
        this.hosts.add(host);
      } else {
        agent = agentFile(options.cwd, toolFree ? null : options.helpers);
        // A tool-free reply runs without auto-approve, so a tool agy reaches for asks (agy 2026-10-31: "request-review") instead of running.
        const args = ['--agent', agent.name, '--input-format', 'stream-json', '--output-format', 'stream-json',
          '--disable-slash-commands', ...(toolFree ? [] : ['--dangerously-skip-permissions'])];
        if (imageDir) args.push('--add-dir', imageDir);
        if (options.model) args.push('--model', options.model);
        if (options.resume) args.push('--conversation', options.resume);
        if (options.effort) args.push('--effort', options.effort);
        host = this.start(args, options.cwd, toolFree ? {} : options.helpers?.env);
        host.agent = agent;
      }
      const result = await deadline(new Promise((resolve, reject) => {
        let buffer = '', received = 0, initialized = reused, sessionId = reused ? options.resume : undefined, settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          error ? reject(error) : resolve(value);
        };
        const tools = new Set(), onEvent = options.onEvent || (() => {});
        const onStdinError = error => finish(error);
        const onError = error => finish(error);
        const onClose = () => finish(new Error('Antigravity exited before confirming a result. Review its saved session before retrying.'));
        const onStderr = () => {};
        const event = value => {
          if (options.signal?.aborted) throw Object.assign(new Error('Antigravity stopped.'), { name: 'AbortError' });
          if (value.event === 'init') {
            if (initialized || value.init?.agent !== agent?.name || value.init?.permission_mode !== (toolFree ? 'request-review' : 'always-proceed') ||
                typeof value.conversation_id !== 'string' || !value.conversation_id ||
                (options.resume && value.conversation_id !== options.resume)) throw new Error('Antigravity did not confirm the requested worker, session and permission mode.');
            initialized = true; sessionId = value.conversation_id;
            onEvent({ type: 'system', session_id: sessionId });
            host.child.stdin.write(JSON.stringify({ event: 'user', message: { content } }) + '\n');
          } else if (value.event === 'step_update') {
            const step = value.step_update;
            if (!initialized || step?.conversation_id !== sessionId) throw new Error('Antigravity returned an unrelated step.');
            if (step.step_type === 'agent_response' && typeof step.text_delta === 'string') onEvent({ type: 'stream_event',
              event: { type: 'content_block_delta', delta: { type: 'text_delta', text: step.text_delta } } });
            if (step.step_type === 'tool' && typeof step.tool_name === 'string' && Number.isSafeInteger(step.step_index)) {
              // A Hub/routing reply or noTools turn is tool-free, as for every provider: a reply that uses a tool is not accepted (cursor.cjs).
              if (options.schema) throw invalidResponse();
              if (options.noTools) throw preflight('Antigravity cannot use tools during a read-only cancelled-result reply.');
              const id = sessionId + ':' + step.step_index;
              if (!tools.has(id)) {
                tools.add(id);
                onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: step.tool_name, input: step.tool_info?.parameters || {} }] } });
              }
              const failed = ['ERROR', 'FAILED', 'CANCELED', 'CANCELLED', 'REJECTED'].includes(step.state);
              if (step.state === 'DONE' || failed) {
                const err = step.tool_info?.error;
                const errText = typeof err === 'string' ? err : typeof err?.message === 'string' ? err.message : err ? JSON.stringify(err) : '';
                onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id,
                  is_error: failed || !!err, content: errText || step.tool_info?.output || (failed ? step.state : '') }] } });
              }
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
            const window = contextWindow(options.model);
            finish(null, { result: result.response, session_id: sessionId, ...(usage ? { usage } : {}), ...(window ? { contextWindow: window } : {}),
              cacheUsageUnknown: !usage || result.usage.cache_read_tokens === undefined });
          } else throw new Error('Unsupported Antigravity stream event. Update the adapter before continuing.');
        };
        const onStdout = text => {
          if (settled) {
            if (typeof text === 'string' && text.trim()) trailingBuffer = true;
            return;
          }
          try {
            received += text.length; buffer += text;
            if (received > LIMIT * 2 || buffer.length > LIMIT) throw new Error('Antigravity output is too large.');
            let newline;
            while (!settled && (newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
              if (line.trim()) event(JSON.parse(line));
            }
            if (settled && buffer.trim()) trailingBuffer = true;
          } catch (error) { finish(error); }
        };
        cleanupListeners = () => {
          host.child.stdin.removeListener('error', onStdinError);
          host.child.removeListener('error', onError);
          host.child.removeListener('close', onClose);
          host.child.stderr.removeListener('data', onStderr);
          host.child.stdout.removeListener('data', onStdout);
        };
        host.child.stdin.on('error', onStdinError);
        host.child.on('error', onError);
        host.child.on('close', onClose);
        host.child.stderr.on('data', onStderr);
        host.child.stdout.on('data', onStdout);
        if (reused) {
          try {
            if (options.signal?.aborted) throw Object.assign(new Error('Antigravity stopped.'), { name: 'AbortError' });
            onEvent({ type: 'system', session_id: sessionId });
            host.child.stdin.write(JSON.stringify({ event: 'user', message: { content } }) + '\n');
          } catch (error) {
            finish(error);
          }
        }
      }), options.timeoutMs || 30 * 60 * 1000, LABEL, options.signal);
      resolvedSessionId = result.session_id;
      succeeded = true;
      return result;
    } finally {
      cleanupListeners?.();
      const canPark = Boolean(
        succeeded &&
        poolable &&
        host &&
        resolvedSessionId &&
        !options.signal?.aborted &&
        !trailingBuffer &&
        host.child.exitCode === null &&
        !host.child.killed &&
        host.child.stdin?.writable &&
        !host.child.stdin?.writableEnded
      );
      // A confirmed result stands; an unconfirmed stop keeps the host pending, so the next run refuses until it is resolved.
      try {
        if (host) {
          if (canPark) {
            const pendingAgent = host.agent;
            host.agent = null;
            try { pendingAgent?.remove(); }
            catch (error) {
              await this.closeHost(host);
              throw error;
            }
            this.park(resolvedSessionId, { host, signature });
          } else {
            await this.closeHost(host);
          }
        } else {
          agent?.remove();
        }
      } catch (error) {
        if (!succeeded) throw error;
      } finally {
        if (imageDir) try { fs.rmSync(imageDir, { recursive: true, force: true }); } catch { /* Best-effort temp image cleanup. */ }
        release();
      }
    }
  }

  async closeUsageHost(host) {
    const survivors = await stopTree(host.child);
    if (!survivors.length) this.usageHosts.delete(host);
  }

  async readCommand(command, label = 'usage') {
    const executable = this.find();
    const { ELECTRON_RUN_AS_NODE, ...hostEnv } = process.env;
    const child = spawnOwned(this.launch, executable.command, [...executable.args, '-p', command, '--output-format', 'json'], {
      cwd: os.tmpdir(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...hostEnv, NO_BROWSER: 'true' },
    });
    const host = { child };
    this.usageHosts.add(host);
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    try {
      const { output } = await deadline(new Promise((resolve, reject) => {
        let output = '', diagnostic = '', settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          error ? reject(error) : resolve(value);
        };
        const data = (text, stderr) => {
          if (settled) return;
          if (stderr) diagnostic += text; else output += text;
          if (output.length + diagnostic.length > LIMIT) finish(new Error(`Antigravity ${label} output is too large.`));
        };
        child.stdout.on('data', text => data(text, false));
        child.stderr.on('data', text => data(text, true));
        child.stdin.on('error', () => {});
        child.once('error', error => finish(error));
        child.once('close', code => code === 0
          ? finish(null, { output, diagnostic })
          : finish(new Error(diagnostic.trim()
            ? `Antigravity ${label} failed (exit ${code}): ${diagnostic.trim().slice(0, 200)}`
            : `Antigravity ${label} failed with exit code ${code}.`)));
        child.stdin.end();
      }), 15000, LABEL);
      let parsed;
      try { parsed = JSON.parse(output); }
      catch { throw new Error(`Antigravity returned invalid ${label} JSON.`); }
      if (!parsed || typeof parsed !== 'object' || parsed.status !== 'SUCCESS') {
        throw new Error(parsed?.error ? `Antigravity ${label} failed: ${parsed.error}` : `Antigravity ${label} did not succeed.`);
      }
      return parsed;
    } finally {
      await this.closeUsageHost(host);
    }
  }

  readUsage() { return this.readCommand('/usage', 'usage'); }
  readCredits() { return this.readCommand('/credits', 'credits'); }

  async login() { throw new Error('Run agy in your terminal to complete its native sign-in, then reconnect in Harness.'); }
  close() {
    const warmStops = [];
    for (const [id, entry] of [...WARM]) {
      if (entry.owner !== this) continue;
      const dropped = dropWarm(id, true);
      if (dropped?.stopping) warmStops.push(dropped.stopping);
    }
    return Promise.all([
      ...warmStops,
      ...[...this.hosts].map(host => this.closeHost(host)),
      ...[...this.usageHosts].map(host => this.closeUsageHost(host)),
    ]);
  }
}

module.exports = { AntigravityCLI, sweepAgentFiles, googleAccount, contextWindow, MAX_MESSAGE_BYTES };
