const { spawn } = require('node:child_process');
const os = require('node:os');
const { spawnOwned, stopTree } = require('../process-tree.cjs');
const { findNativeCLI, deadline } = require('./native-cli.cjs');
const { imageData } = require('../image-input.cjs');
const { invalidResponse } = require('./structured.cjs');

const LABEL = 'Muse Code CLI';

function metaLink(value) {
  try {
    const { protocol, hostname } = new URL(value);
    return protocol === 'https:' && (hostname === 'meta.com' || hostname.endsWith('.meta.com'));
  } catch {
    return false;
  }
}

const PROFILES ={ 'read-only': ':read-only', 'workspace-write': ':ask-me', 'danger-full-access': ':unrestricted' };

class MuseCLI {
  constructor(launch = spawn, find = () => findNativeCLI('muse-cli')) {
    this.launch = launch;
    this.find = find;
    this.hosts = new Set();
    this.models = [];
    this.status = { installed: false, loggedIn: false };
  }

  inspect() {
    try { this.find(); this.status = { ...this.status, installed: true }; }
    catch { this.status = { installed: false, loggedIn: false }; }
    return this.status;
  }

  async createHost(cwd, signal) {
    const sdk = await import('@muse-code/sdk');
    const executable = this.find();
    const child = spawnOwned(this.launch, executable.command, [...executable.args, 'serve', '--disable-request-user-input'], {
      cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],    });
    const host = { child, sdk, session: null, held: [], opening: false, context: null, reported: new Map(), tokenEvents: new Map() };
    // The code stays: INVALID_STRUCTURED_RESPONSE (a Hub reply that used a tool) gets the router's one retry.
    host.failure = new Promise((_, reject) => { host.fail = error => reject(Object.assign(new Error(error.message || 'Muse protocol failed.'), error.code ? { code: error.code } : {})); });
    host.failure.catch(() => {});
    this.hosts.add(host);
    child.stdout.setEncoding('utf8');
    child.stderr.resume();
    child.once('error', () => host.fail(new Error('Muse Code could not start. Check the native installation.')));
    child.stdin.on('error', () => host.fail(new Error('Muse Code disconnected; execution was not confirmed.')));
    host.rpc = new sdk.Connection({ incoming: child.stdout,
      write: chunk => new Promise((resolve, reject) => child.stdin.write(chunk, error => error ? reject(error) : resolve())),
      close: () => child.stdin.end() });
    host.rpc.onProtocolError(() => host.fail(new Error('Muse Code returned an invalid protocol message. Update Muse Code and reconnect.')));
    host.rpc.onNotification(event => this.notification(host, event));
    host.rpc.closed.then(() => host.fail(new Error('Muse Code disconnected; execution was not confirmed.')));
    try {
      host.info = await this.call(host, 'initialize', { clientInfo: { name: 'phasma_harness', version: require('../../package.json').version },
        capabilities: { experimentalApi: true, requestedCapabilities: ['sessionMcp'] } }, signal);
      // Muse updates itself; a newer build only adds optional fields within a schema version, and the SDK treats a
      // fingerprint mismatch as a warning (checkServedFingerprint), so only another schema version is refused.
      if (host.info.schema?.version !== 1) {
        throw new Error('Unsupported Muse Code protocol. Update Harness and Muse Code together before continuing.');
      }
      host.rpc.notify('initialized', {});
      return host;
    } catch (error) { await this.closeHost(host); throw error; }
  }

  call(host, method, params, signal, command = false) {
    const request = command ? host.rpc.command(method, params, { maxAttempts: 1 }) : host.rpc.request(method, params);
    return deadline(Promise.race([request, host.failure]), 30000, LABEL, signal);
  }

  async closeHost(host) {
    if (!host || !this.hosts.has(host)) return;
    const remaining = await stopTree(host.child);
    if (remaining.length) throw new Error('Muse cleanup is not confirmed. Resolve its process before retrying.');
    host.session?.hostExited({ kind: 'transportEof' });
    await host.rpc.close();
    this.hosts.delete(host);
  }

  async refresh() {
    let host;
    try {
      host = await this.createHost(os.tmpdir());
      const catalog = await this.call(host, 'model/list', {});
      // Muse can serve its whole catalog under a provider profile (2026-10-19: every row "tbh"); rows of another profile are skipped.
      const profile = catalog.profileId || null;
      this.models = (catalog.models || []).filter(model => model.modelId && model.providerId === 'meta' && (model.profileId || null) === profile)
        .map(model => ({ id: `native:muse:${model.modelId}`, model: model.modelId, profileId: profile,
          label: model.displayLabel || model.modelId, provider: 'native:muse', rank: 35, worker: true, router: true,
          efforts: (model.reasoningEffortVariants || []).map(variant => variant.tier).filter(Boolean),
          effort: model.defaultReasoningEffort || null }));
      // Muse names the credential in effect: the signed-in account, or a stored or environment API key.
      const credential = await this.call(host, 'account/read', {}).catch(() => null);
      const account = credential?.state === 'accountLogin' ? credential.label : ['apiKey', 'envKey'].includes(credential?.state) ? 'API key' : null;
      this.status = { installed: true, loggedIn: this.models.length > 0, version: host.info.serverInfo?.version,
        protocolVersion: host.info.schema.version, sandbox: host.info.sandboxAvailability || 'unknown',
        ...(account ? { account } : {}),
        ...(this.models.length ? {} : { error: 'Sign in to Muse Code with your Meta account, then refresh.' }) };
    } catch (error) {
      this.models = [];
      this.status = { installed: error.code !== 'ENOENT', loggedIn: false,
        error: error.code === 'ENOENT' || /Unsupported Muse/.test(error.message) ? error.message : 'Muse Code is not ready. Check its native sign-in and configuration.' };
    } finally { if (host) await this.closeHost(host); }
    return this.status;
  }

  async openSession(host, options) {
    const profile = PROFILES[options.access];
    if (!profile) throw new Error('Unsupported Muse access level.');
    if (options.access === 'workspace-write' && host.info.sandboxAvailability !== 'available') {
      throw new Error('Muse cannot enforce workspace access on this host. Use a supported sandbox host or explicitly select Full access.');
    }
    const catalog = await this.call(host, 'permissionProfile/list', {}, options.signal);
    if (!catalog.profiles?.some(row => row.profileId === profile && row.available)) throw new Error('The required Muse permission profile is unavailable.');
    if (options.helpers && !host.info.grantedCapabilities?.includes('sessionMcp')) throw new Error('Muse did not grant session MCP helpers.');
    const config = options.helpers ? { mcpServers: { [options.helpers.serverName]: {
      transport: 'stdio', command: options.helpers.command, args: options.helpers.args, env: options.helpers.env, mode: 'required',
    } } } : undefined;
    host.opening = true;
    const verb = options.resume ? 'session/resume' : 'session/start';
    const params = { permissionProfile: profile, ...(config ? { config } : {}), ...(options.resume
      ? { sessionId: options.resume, excludeItems: true }
      : { workspaceRoot: options.cwd, providerId: 'meta', modelId: options.model }) };
    const opened = await this.call(host, verb, params, options.signal, true);
    if (!opened.session?.sessionId) throw new Error('Muse returned no session identity.');
    if (options.resume && opened.session.sessionId !== options.resume) throw new Error('Muse loaded a different conversation. No message was sent.');
    if (opened.session.activeTurnId) throw new Error('This Muse session still has active work. Resolve it before retrying.');
    const snapshot = opened.session.permissionState || (await this.call(host, 'session/read',
      { sessionId: opened.session.sessionId }, options.signal)).session?.permissionState;
    if (snapshot?.profileId !== profile) throw new Error('Muse did not confirm the requested permission profile. No prompt was sent.');
    if (options.access !== 'danger-full-access' && snapshot.reviewerAuthority !== 'human') throw new Error('Muse did not confirm human approval authority.');
    host.session = new host.sdk.Session({ sessionId: opened.session.sessionId, connection: host.rpc,
      durability: host.sdk.readSessionDurability(host.info), opening: { verb, result: opened } });
    host.session.onApproval(request => this.permission(host, request));
    host.session.onApprovalError(() => host.fail(new Error('Muse permission delivery failed. No further action was approved.')));
    host.session.onGapError(() => host.fail(new Error('Muse history is incomplete. Review the session before continuing.')));
    host.opening = false;
    for (const event of host.held.splice(0)) this.notification(host, event);
    const profileId = this.models.find(model => model.model === options.model)?.profileId;
    await this.call(host, 'session/setModel', { sessionId: host.session.sessionId,
      model: { providerId: 'meta', modelId: options.model, ...(profileId ? { profileId } : {}) } }, options.signal, true);
    return host.session;
  }

  async permission(host, request) {
    const allow = request.availableChoices?.find(choice => choice.scope === 'once' && choice.decision === 'approved');
    const deny = request.availableChoices?.find(choice => choice.scope === 'once' && ['denied', 'abort'].includes(choice.decision));
    if (!deny) throw new Error('Muse supplied no safe rejection choice.');
    const context = host.context;
    let accepted = false;
    if (allow && context && !context.signal?.aborted && typeof context.approve === 'function') {
      try { accepted = await context.approve({ title: `Allow Muse ${request.toolName} once?`, rawInput: request.rawArgs }, { signal: context.signal }); }
      catch {}
    }
    return { choiceId: accepted && !context.signal?.aborted ? allow.choiceId : deny.choiceId };
  }

  notification(host, event) {
    try {
      if (host.opening && !host.session) {
        if (host.held.length >= 1000) throw new Error('Muse sent too much history before confirming the session.');
        host.held.push(event);
        return;
      }
      if (!host.session || event.params?.sessionId !== host.session.sessionId) return;
      host.session.apply(event).io.catch(error => host.fail(error));
      if (event.method === 'session/tokenUsage') host.tokenEvents.set(event.params.viewCursor, event.params);
      if (!host.context || !event.method.startsWith('item/')) return;
      const itemId = event.params.item?.itemId || event.params.itemId;
      const item = host.session.fold.items.get(itemId);
      if (!item || host.reported.get(itemId) === JSON.stringify(item)) return;
      host.reported.set(itemId, JSON.stringify(item));
      this.item(host, item);
    } catch (error) { host.fail(error); }
  }

  item(host, item) {
    const onEvent = host.context.onEvent || (() => {});
    if (item.kind === 'agentMessage' && typeof item.text === 'string') onEvent({ type: 'assistant',
      message: { id: item.itemId, content: [{ type: 'text', text: item.text }] } });
    if (item.kind !== 'toolCall') return;
    // A Hub or routing reply is tool-free, as for every provider: a reply that uses a tool is not accepted (cursor.cjs).
    if (host.context.schema) return host.fail(invalidResponse());
    onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: item.itemId,
      name: item.tool || 'Muse tool', input: item.args || {} }] } });
    if (item.status !== 'inProgress') onEvent({ type: 'user', message: { content: [{ type: 'tool_result',
      tool_use_id: item.itemId, is_error: item.status !== 'completed', content: item.visibleOutput || item.failureReason || item.status }] } });
  }

  async run(options) {
    if (this.active) throw new Error('Muse Code already has an active turn.');
    this.active = true;
    let host;
    try {
      host = await this.createHost(options.cwd, options.signal);
      // A Hub or routing reply runs read-only, as DeepSeek's does.
      const session = await this.openSession(host, options.schema ? { ...options, access: 'read-only' } : options);
      host.context = options;
      options.onEvent?.({ type: 'system', session_id: session.sessionId });
      const input = [{ type: 'text', text: [options.instructions, options.helpers?.instructions,
        options.schema && !(options.resume && options.schemaInHistory) ? `Return only a JSON object matching this schema. No tools are available.\n${JSON.stringify(options.schema)}` : '',
        options.prompt].filter(Boolean).join('\n\n') }];
      for (const { mime, data } of (options.images || []).map(imageData)) input.push({ type: 'image', mediaType: mime, base64Data: data });
      const submit = (parts, ifBusy) => deadline(Promise.race([session.sendUserTurn({ input: parts, ifBusy,
        ...(options.effort ? { reasoningEffort: options.effort } : {}) }), host.failure]), 30000, LABEL, options.signal);
      const turn = await submit(input, 'queue');
      // Muse takes follow-ups natively: a steer lands in the running turn (same turnId) and is delivered on its
      // acknowledgement; a queued one becomes a new turn this run also waits for, and is delivered only when that turn
      // completes. If the run ends first, the message stays queued as uncertain instead of being dropped.
      const turns = [turn], submissions = new Set(), waiting = new Map(), done = new Set();
      let accepting = true;
      options.onInput?.((message, { steer } = {}) => {
        if (!accepting || options.signal?.aborted)
          return Promise.reject(new Error('Muse is no longer accepting messages.'));

        const parts = [{ type: 'text', text: message.text }];
        for (const { mime, data } of (message.images || []).map(imageData)) parts.push({ type: 'image', mediaType: mime, base64Data: data });
        const acked = submit(parts, steer ? 'steer' : 'queue').then(next => {
          const joined = turns.some(known => known.turnId === next.turnId);
          if (!joined)
            turns.push(next);
          return { next, joined };
        });
        submissions.add(acked);
        acked.finally(() => submissions.delete(acked)).catch(() => {});
        return acked.then(({ next, joined }) => {
          if (joined || done.has(next.turnId))
            return undefined;
          // Acknowledged after the run stopped waiting: its turn will never be watched, so say so instead of hanging.
          if (!accepting)
            throw new Error('Muse closed before the queued message ran. Check the conversation before resending.');
          return new Promise((resolve, reject) => { waiting.set(next.turnId, { resolve, reject }); });
        });
      });

      let last = turn;
      try {
        for (let index = 0; ;) {
          if (index < turns.length) {
            last = turns[index++];
            const outcome = await deadline(Promise.race([last.completed, host.failure]), options.timeoutMs || 30 * 60 * 1000, LABEL, options.signal);
            if (outcome.kind !== 'completed' || outcome.params.terminal !== 'completed') {
              // Muse reports why a turn ended (a model, billing or account error); show that instead of a generic failure.
              const reason = String(outcome.params?.error?.message || outcome.params?.reason || '').slice(0, 1000);
              throw new Error(reason ? `${LABEL} could not complete this turn: ${reason}` : 'Muse did not complete this turn. Review its saved session before retrying.');
            }
            done.add(last.turnId);
            waiting.get(last.turnId)?.resolve();
            waiting.delete(last.turnId);
            continue;
          }

          if (!submissions.size)
            break;
          await Promise.allSettled([...submissions]);
        }
      } finally {
        accepting = false;
        options.onInput?.(null);
        for (const { reject } of waiting.values()) reject(new Error('Muse closed before the queued message ran. Check the conversation before resending.'));
        waiting.clear();
      }

      const text = session.fold.items.list().filter(item => item.turnId === last.turnId && item.kind === 'agentMessage').map(item => item.text || '').join('\n\n');
      // Raw cache conventions vary; use Muse's counted-once per-completion projection.
      const ids = new Set(turns.map(known => known.turnId));
      const events = [...host.tokenEvents.values()].filter(event => ids.has(event.turnId));
      const counts = events.filter(event =>
        Number.isSafeInteger(event.promptTokens) && event.promptTokens >= 0 &&
        Number.isSafeInteger(event.usage?.outputTokens) && event.usage.outputTokens >= 0);
      const usage = counts.length && counts.length === events.length ? counts.reduce((total, event) => ({ input_tokens: total.input_tokens + event.promptTokens,
        output_tokens: total.output_tokens + event.usage.outputTokens }), { input_tokens: 0, output_tokens: 0 }) : null;
      return { session_id: session.sessionId, result: text, ...(usage ? { usage, cacheUsageUnknown: true } : {}) };
    } finally {
      try { if (host) await this.closeHost(host); }
      finally { this.active = false; }
    }
  }

  // `muse login` prints a code to approve in the browser; its window is hidden, so open the Meta link it prints.
  async login(open = () => {}) {
    // Signing in again cannot fix an unsupported protocol, so the Meta page stays closed.
    if (/Unsupported Muse/.test(this.status.error || '')) throw new Error(this.status.error);
    const executable = this.find();
    const child = spawnOwned(this.launch, executable.command, [...executable.args, 'login'],
      { cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    let output = '';
    let opened = false;
    const read = chunk => {
      output = (output + chunk).slice(-16000);
      const complete = output.slice(0, output.lastIndexOf('\n') + 1);
      const link = complete.match(/https:\/\/[^\s\u001b"']+/g)?.find(metaLink);
      if (link && !opened) {
        opened = true;
        open(link);
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', read);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', read);
    const finished = new Promise((resolve, reject) => {
      child.once('error', () => reject(new Error('Muse sign-in could not start.')));
      child.once('close', code => code === 0 ? resolve() : reject(new Error('Muse sign-in did not complete. Run muse login in your terminal, then refresh.')));
    });
    try { await deadline(finished, 10 * 60 * 1000, 'Muse sign-in'); }
    finally {
      if ((await stopTree(child)).length) throw new Error('Muse sign-in cleanup is not confirmed.');
    }
    return this.refresh();
  }

  close() { return Promise.all([...this.hosts].map(host => this.closeHost(host))); }
}

module.exports = { MuseCLI };
