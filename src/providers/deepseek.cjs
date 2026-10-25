const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { Readable, Writable } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnOwned, stopTree, stopStartedSince } = require('../process-tree.cjs');
const { findNativeCLI, deadline, stepStopped } = require('./native-cli.cjs');
const { structuredResponse } = require('./structured.cjs');
const { imageData } = require('../image-input.cjs');

const LABEL = 'DeepSeek Harness CLI';
// dsh answers initialize in about 12 s under Harness's own runtime (8 s under Node) and took 16 s on a fresh build's
// first runs (2026-10-21); a healthy start continues at once, so only a hung dsh waits this long.
const START_MS = 60000;

// dsh 0.2.1-rc.2's acp profile reads its sandbox mode and approval policy once at launch from DSH_PERMISSION_MODE and
// advertises no ACP session modes, so a host serves one access level and is replaced when the level changes.
const ACCESS = { 'read-only': 'read-only', 'workspace-write': 'workspace-write', 'danger-full-access': 'danger-full-access' };

// Model choices are grouped by provider; a choice's opaque value is what session/set_config_option takes back.
const modelChoices = session => (session.configOptions?.find(option => option.id === 'model')?.options || [])
  .flatMap(entry => entry.options || [entry]).filter(choice => typeof choice.value === 'string' && choice.value);

class DeepSeekCLI {
  constructor(launch = spawn, find = () => findNativeCLI('deepseek-cli')) {
    this.launch = launch; this.find = find; this.hosts = new Set();
    this.models = []; this.status = { installed: false, loggedIn: false }; this.host = null;
  }

  inspect() {
    try { this.find(); this.status = { ...this.status, installed: true }; }
    catch { this.status = { installed: false, loggedIn: false }; }
    return this.status;
  }

  // The ACP bridge reports its own version, not dsh's; the package script's version is read when dsh runs from one.
  version(executable) {
    try { return JSON.parse(fs.readFileSync(path.join(path.dirname(executable.args[0]), '..', 'package.json'), 'utf8')).version; }
    catch { return undefined; }
  }

  async createHost(cwd, access, signal) {
    const { ClientSideConnection, ndJsonStream } = await import('@agentclientprotocol/sdk');
    const executable = this.find();
    const env = { ...process.env, DSH_PERMISSION_MODE: ACCESS[access] || 'read-only' };
    if (executable.command === process.execPath) env.ELECTRON_RUN_AS_NODE = '1';
    const child = spawnOwned(this.launch, executable.command, [...executable.args, '--profile', 'acp'], {
      cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env,
    });
    const host = { child, cwd, access, context: null, stderr: '', sessions: new Map(), version: this.version(executable) };
    this.hosts.add(host);
    child.stderr.setEncoding('utf8'); child.stderr.on('data', data => { host.stderr = (host.stderr + data).slice(-4000); });
    host.exited = new Promise(resolve => { child.once('close', resolve); child.once('error', resolve); });
    const stream = ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout), { maxMessageBytes: 16 * 1024 * 1024 });
    host.rpc = new ClientSideConnection(() => ({
      requestPermission: request => this.permission(host, request),
      sessionUpdate: event => this.update(host, event),
    }), stream);
    try {
      host.info = await deadline(host.rpc.initialize({ protocolVersion: 1, clientInfo: { name: 'PhasmaHarness', version: require('../../package.json').version },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } }), START_MS, LABEL, signal);
      if (host.info.protocolVersion !== 1 || !host.info.agentInfo?.name) throw new Error('Unsupported DeepSeek Harness protocol. Update DeepSeek Harness and reconnect.');
      return host;
    } catch (error) {
      // A dsh that quits at start says why on stderr (its first line); "ACP connection closed" alone does not. Its
      // output is complete once it has closed, which a crash does at once; a Stop does not wait for it.
      if (!signal?.aborted) await Promise.race([host.exited, new Promise(resolve => setTimeout(resolve, 1000).unref())]);
      const reason = host.stderr.split('\n').find(line => line.trim());
      if (reason && error instanceof Error) error.message += `: ${reason.trim()}`;
      await this.closeHost(host);
      throw error;
    }
  }

  async closeHost(host) {
    if (!host) return;
    if (this.host === host) this.host = null;
    if (this.reviewHost === host) this.reviewHost = null;
    const remaining = await stopTree(host.child);
    if (remaining.length) throw new Error('DeepSeek Harness cleanup is not confirmed. Resolve the running process before retrying.');
    this.hosts.delete(host);
  }

  mcpServers(helpers) {
    if (!helpers) return [];
    return [{ name: helpers.serverName, command: helpers.command, args: helpers.args,
      env: Object.entries(helpers.env).map(([name, value]) => ({ name, value: String(value) })) }];
  }

  async openSession(host, options) {
    const args = { cwd: options.cwd, mcpServers: options.schema ? [] : this.mcpServers(options.helpers) };
    if (options.resume && !host.sessions.has(options.resume) && !host.info.agentCapabilities?.sessionCapabilities?.resume) {
      throw new Error('This DeepSeek Harness version cannot resume the saved session. Update DeepSeek Harness before continuing.');
    }
    const session = host.sessions.get(options.resume) || (options.resume
      ? await deadline(host.rpc.resumeSession({ ...args, sessionId: options.resume }), 30000, LABEL, options.signal)
      : await deadline(host.rpc.newSession(args), 30000, LABEL, options.signal));
    if (options.resume && session.sessionId && session.sessionId !== options.resume) throw new Error('DeepSeek Harness loaded a different conversation. No message was sent.');
    const sessionId = session.sessionId || options.resume;
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('DeepSeek Harness returned no session identity.');
    const opened = { ...session, sessionId };
    host.sessions.set(sessionId, opened);
    const current = opened.configOptions?.find(option => option.id === 'model')?.currentValue;
    if (options.model && current !== options.model) {
      if (!modelChoices(opened).some(choice => choice.value === options.model)) throw new Error('The requested DeepSeek model is unavailable. Refresh models first.');
      const changed = await deadline(host.rpc.setSessionConfigOption({ sessionId, configId: 'model', value: options.model }), 15000, LABEL, options.signal);
      opened.configOptions = changed.configOptions;
    }
    return opened;
  }

  async refresh() {
    let host;
    try {
      host = await this.createHost(os.tmpdir(), 'read-only');
      this.status = { installed: true, loggedIn: false, version: host.version, protocolVersion: 1 };
      const session = await this.openSession(host, { cwd: os.tmpdir(), schema: {} });
      this.models = modelChoices(session).map(choice => ({ id: `native:deepseek:${choice.value}`, model: choice.value,
        label: choice.name || choice.value, provider: 'native:deepseek', rank: 35, worker: true, router: true, efforts: [], effort: null,
        images: !!host.info.agentCapabilities?.promptCapabilities?.image }));
      if (!this.models.length) throw new Error('DeepSeek Harness returned no available models.');
      // The ACP surface reports no sign-in state; a missing API key fails the first turn instead.
      this.status.loggedIn = true;
      this.status.account = 'API key';
    } catch (error) {
      this.models = [];
      // The cause itself, so a failed connect says why (such as a package missing from an installed Harness).
      this.status = { ...this.status, installed: error.code !== 'ENOENT', loggedIn: false,
        error: error.code === 'ENOENT' || /Unsupported DeepSeek|cannot resume/.test(error.message) ? error.message
          : `DeepSeek Harness could not start: ${String(error.message).slice(0, 300)}` };
    } finally { if (host) await this.closeHost(host); }
    return this.status;
  }

  async permission(host, request) {
    // The prompt's own signal: a Send now replacement aborts it, so a late answer cannot approve the new prompt's tools.
    const context = host.context, signal = context?.signal;
    if (!context || context.schema || signal?.aborted) return { outcome: { outcome: 'cancelled' } };
    const allow = request.options?.find(option => option.kind === 'allow_once');
    if (!allow || typeof context.approve !== 'function') return { outcome: { outcome: 'cancelled' } };
    // dsh sends only the call id with the request; the tool name and arguments come from the tool_call update before it.
    const call = context.calls.get(request.toolCall?.toolCallId);
    const rawInput = call?.rawInput && typeof call.rawInput === 'object' && !Array.isArray(call.rawInput) && Object.keys(call.rawInput).length ? call.rawInput : null;
    let accepted = false;
    try {
      accepted = await context.approve({ title: call?.title ? `Allow ${call.title} once?` : 'Allow DeepSeek tool once?',
        // Without concrete input every call of one tool would share a session-allow key; a null name is never remembered.
        toolName: rawInput ? call.title || null : null, input: rawInput || {}, rawInput: call?.rawInput ?? request.toolCall }, { signal });
    } catch { return { outcome: { outcome: 'cancelled' } }; }
    if (!accepted || signal?.aborted) return { outcome: { outcome: 'cancelled' } };
    return { outcome: { outcome: 'selected', optionId: allow.optionId } };
  }

  update(host, notification) {
    const context = host.context, event = notification?.update;
    if (!context || notification.sessionId !== context.sessionId || !event) return;
    if (event.sessionUpdate === 'agent_message_chunk' && event.content?.type === 'text' && typeof event.content.text === 'string') {
      context.text += event.content.text;
      context.onEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: event.content.text } } });
    }
    if (event.sessionUpdate === 'tool_call') {
      context.calls.set(event.toolCallId, { title: event.title, rawInput: event.rawInput });
      context.onEvent({ type: 'assistant', message: { content: [
        { type: 'tool_use', id: event.toolCallId, name: event.title || 'DeepSeek tool', input: event.rawInput || {} } ] } });
    }
    if (event.sessionUpdate === 'tool_call_update' && ['completed', 'failed'].includes(event.status)) context.onEvent({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: event.toolCallId, is_error: event.status === 'failed', content: event.content || [] } ] } });
  }

  async run(options) {
    if (this.active) throw new Error('DeepSeek Harness already has an active turn.');
    this.active = true;
    let host, context;
    try {
      const access = options.schema ? 'read-only' : options.access;
      if (this.host && (this.host.cwd !== options.cwd || this.host.access !== access || this.host.rpc.signal.aborted)) await this.closeHost(this.host);
      if (this.reviewHost && (this.reviewHost.cwd !== options.cwd || this.reviewHost.rpc.signal.aborted)) await this.closeHost(this.reviewHost);
      host = options.schema ? (options.persistSession
        ? this.reviewHost || (this.reviewHost = await this.createHost(options.cwd, access, options.signal))
        : await this.createHost(options.cwd, access, options.signal))
        : this.host || (this.host = await this.createHost(options.cwd, access, options.signal));
      const session = await this.openSession(host, options);
      context = { ...options, sessionId: session.sessionId, text: '', calls: new Map(), onEvent: options.onEvent || (() => {}) };
      host.context = context;
      context.onEvent({ type: 'system', session_id: session.sessionId });
      const prompt = [{ type: 'text', text: [options.instructions || '', options.helpers?.instructions || '',
        options.schema && !(options.resume && options.schemaInHistory) ? `Return only a JSON object matching this schema. No tools are available.\n${JSON.stringify(options.schema)}` : '', options.prompt].filter(Boolean).join('\n\n') }];
      prompt.push(...this.images(host, options.images));
      let current = this.prompt(host, context, options, prompt), steering = null, finished = false;
      // ACP allows one prompt in flight, so Send now replaces the current step inside the same session and process.
      if (!options.schema) options.onInput?.((message, { steer } = {}) => {
        if (!steer)
          return Promise.reject(new Error('DeepSeek Harness takes one prompt at a time. Use Send now to replace the current step.'));
        if (finished || steering || options.signal?.aborted)
          return Promise.reject(new Error('DeepSeek Harness is no longer accepting messages.'));

        steering = this.steer(host, context, options, message, current, () => finished).then(next => { current = next; })
          .finally(() => { steering = null; });
        return steering;
      });

      let result;
      try {
        for (;;) {
          const mine = current;
          result = await deadline(mine, options.timeoutMs || 30 * 60 * 1000, LABEL, options.signal);
          if (steering)
            await steering.catch(() => {});
          if (current === mine)
            break;
        }
      } finally {
        finished = true;
        options.onInput?.(null);
      }

      if (result.stopReason !== 'end_turn') throw new Error(result.stopReason === 'cancelled' ? 'DeepSeek Harness stopped.' : `DeepSeek Harness turn ended without completion: ${result.stopReason}`);
      return { result: context.text, session_id: session.sessionId,
        ...(options.schema ? { structured_output: structuredResponse(context.text, options.schema) } : {}) };
    } catch (error) {
      // Invalid JSON ends a completed turn; Main's repair continues that in-memory session.
      if (host && !(options.persistSession && error.code === 'INVALID_STRUCTURED_RESPONSE')) await this.closeHost(host);
      throw error;
    }
    finally {
      if (host) host.context = null;
      try { if (options.schema && !options.persistSession && host && this.hosts.has(host)) await this.closeHost(host); }
      finally { this.active = false; }
    }
  }

  images(host, urls = []) {
    if (urls.length && !host.info.agentCapabilities?.promptCapabilities?.image) throw new Error('This DeepSeek model does not support image prompts.');
    return urls.map(imageData).map(({ mime, data }) => ({ type: 'image', mimeType: mime, data }));
  }

  // Each prompt gets its own signal for approvals and its own start time for cleanup.
  prompt(host, context, options, parts) {
    context.promptAbort = new AbortController();
    context.signal = options.signal ? AbortSignal.any([options.signal, context.promptAbort.signal]) : context.promptAbort.signal;
    context.promptStartedAt = Date.now();
    context.text = '';
    return host.rpc.prompt({ sessionId: context.sessionId, prompt: parts });
  }

  // Cancel the step, answer its open approvals as cancelled, confirm the commands it started are gone, then prompt
  // again in the same session. If cleanup is not confirmed the message stays queued with that error.
  async steer(host, context, options, message, previous, finished = () => false) {
    const parts = [{ type: 'text', text: message.text }, ...this.images(host, message.images)];
    context.promptAbort.abort();
    const { interrupted, remaining } = stopStartedSince(host.child, context.promptStartedAt, `${host.child.ownerKey || 'deepseek'}/${randomUUID()}`,
      async () => {
        await host.rpc.cancel({ sessionId: context.sessionId });
        return stepStopped(previous, LABEL);
      }, async () => {});
    await interrupted;
    if ((await remaining).length)
      throw new Error('DeepSeek Harness has not confirmed that the cancelled step stopped. The message stays queued.');
    // A Stop or failure during cleanup ended the run: nothing may be sent on its closing connection.
    if (finished() || options.signal?.aborted)
      throw new Error('DeepSeek Harness stopped before the message was sent. The message stays queued.');

    return this.prompt(host, context, options, parts);
  }

  // dsh has no sign-in over ACP; its API key lives in its own credential store or environment. Connect calls this after
  // a failed refresh, so that refresh's cause comes first.
  async login() {
    throw new Error(this.status.error || 'DeepSeek Harness has no sign-in here. Add a DeepSeek API key to dsh (DEEPSEEK_API_KEY or its settings), then connect again.');
  }

  close() { return Promise.all([...this.hosts].map(host => this.closeHost(host))); }
}

module.exports = { DeepSeekCLI };
