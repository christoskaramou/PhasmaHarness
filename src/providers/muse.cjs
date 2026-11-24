const { spawn } = require('node:child_process');
const os = require('node:os');
const { spawnOwned, stopTree } = require('../process-tree.cjs');
const { findNativeCLI, deadline, takeTurn } = require('./native-cli.cjs');
const { imageData } = require('../image-input.cjs');
const { invalidResponse } = require('./structured.cjs');

const LABEL = 'Muse Code CLI';
const SUMMARY_PART = /^summary\.(0|[1-9]\d*)$/;
const progressTitles = new Map(Object.entries({
  workflow: 'Workflow', monitorFeed: 'Monitor event', compaction: 'Context compaction', hookRun: 'Hook',
  scheduledFire: 'Scheduled task', systemNotice: 'System notice', backgroundTerminalCompletion: 'Background task',
  overdueNotice: 'Overdue task', bodyCompletion: 'Completion receipt', sideChat: 'Side chat',
  reminderChild: 'Reminder agent', subagentInput: 'Subagent input', subagentResult: 'Subagent result',
  peerMessage: 'Peer message', webSearch: 'Web search', skillRead: 'Skill read', toolCall: 'Tool progress',
}));
const childItems = new Set(['reminderChild', 'subagentInput', 'subagentResult', 'peerMessage', 'sideChat']);
const publicValue = v => typeof v === 'string' ? v : Number.isFinite(v) ? String(v) : '';
const joinFacts = (...values) => values.map(publicValue).filter(Boolean).join(' · ');
function listed(value) { return Array.isArray(value) ? value.map(publicValue).filter(Boolean).join(', ') : ''; }
function references(refs) {
  if (!Array.isArray(refs)) return '';
  return refs.filter(ref => typeof ref === 'string').map(ref => {
    if (/^[a-z]:[\\/]/i.test(ref) || !/^[a-z][\w+.-]*:/i.test(ref)) return ref.split(/[?#]/, 1)[0];
    try {
      const url = new URL(ref);
      if (['file:', 'https:', 'http:'].includes(url.protocol)) return url.protocol + '//' + url.host + url.pathname;
    } catch {}
    return '';
  }).filter(Boolean).join(', ');
}

// Persist only display fields. A partial notification never replaces a known fact with undefined.
function reportFacts(host, id, kind, title, facts, status) {
  let known = host.publicItems.get(id);
  if (!known) host.publicItems.set(id, known = { rows: new Map() });
  for (const [label, value] of Object.entries(facts)) {
    const text = publicValue(value);
    if (text) known.rows.set(label, label ? label + ': ' + text : text);
  }
  if (publicValue(status)) known.status = status;
  const text = [...known.rows.values()].join('\n');
  const info = { type: 'info', id, kind, title, text, ...(known.status ? { status: known.status } : {}) };
  const signature = JSON.stringify(info);
  if (known.signature === signature) return;
  known.signature = signature;
  host.context.onEvent?.(info);
}

function reportSessionPlan(host, method, p) {
  if (method === 'session/todoListChanged' && Array.isArray(p.items)) {
    const text = p.items.map(todo => joinFacts(todo?.status, todo?.text, todo?.activeForm !== todo?.text && todo?.activeForm)).join('\n');
    reportFacts(host, 'todos:' + p.sessionId, 'progress', 'Plan', { '': text || 'No tasks' });
  }
  if (method === 'session/goalChanged') {
    const g = p.goal;
    const text = g ? [g.objective, g.currentWork, g.nextWork, Number.isFinite(g.percentComplete) && g.percentComplete + '%']
      .map(publicValue).filter(Boolean).join('\n') : 'Goal cleared';
    reportFacts(host, 'goal:' + p.sessionId, 'progress', 'Goal', { '': text }, g ? g.status : 'cleared');
  }
}

function progressItem(host, item) {
  const title = progressTitles.get(item.kind);
  if (!title || typeof item.itemId !== 'string' || !item.itemId) return;
  const id = 'activity:' + item.itemId;
  const facts = {};
  let status = item.status;
  switch (item.kind) {
    case 'workflow':
      Object.assign(facts, { Run: item.workflowRunId, Script: item.scriptId, Entry: item.entryId, Phase: item.declaredPhase,
        Plan: Array.isArray(item.phasePlan) && item.phasePlan.map(phase => publicValue(phase?.title)).filter(Boolean).join(' → '),
        Summary: item.finalSummary, Message: item.message, 'Duration (ms)': item.durationMs, 'Token budget': item.tokenBudget?.total,
        Trigger: item.triggerSource, 'Plan unavailable': item.phasePlanUnreadable });
      if (item.paused === true) status = 'paused';
      if (Array.isArray(item.children)) for (const child of item.children) {
        if (!child?.childId || !Number.isSafeInteger(child.attempt)) continue;
        const childKey = 'workflow-child:' + JSON.stringify([item.itemId, child.childId, child.attempt]);
        reportFacts(host, childKey, 'agent', 'Workflow child', { Child: child.childId, Attempt: child.attempt,
          Label: child.label, Phase: child.phase, 'Failure kind': child.failureKind, Reason: child.failureReason,
          'Duration (ms)': child.durationMs, Workflow: item.workflowRunId, Result: references([child.resultRef]) },
        child.failureKind && child.terminal === 'completed' ? 'failed' : child.terminal || child.status);
      }
      break;
    case 'toolCall': {
      const { statusProgress: p, statusStep: step, statusAttempt: a, statusChildren: c, statusHealth: h } = item;
      Object.assign(facts, { '': item.statusLine, Phase: item.statusPhase,
        Progress: p && joinFacts([p.current, p.total].map(publicValue).filter(Boolean).join('/'), p.unit),
        Step: step && joinFacts(step.label, [step.index, step.total].map(publicValue).filter(Boolean).join('/')),
        Attempt: a && joinFacts(a.system, a.operation, [a.attempt, a.maxAttempts].map(publicValue).filter(Boolean).join('/'), a.errorKind),
        'Retry delay (ms)': a?.retryDelayMs, 'Next attempt': a?.nextAttempt,
        Children: c && ['active', 'completed', 'failed', 'cancelled', 'total'].filter(k => Number.isFinite(c[k])).map(k => c[k] + ' ' + k).join(', '),
        Health: h && joinFacts(h.level, h.reason), Background: item.backgroundStatus });
      if (!Object.values(facts).some(publicValue) && !host.publicItems.has(id)) return;
      break;
    }
    case 'monitorFeed': Object.assign(facts, { Monitor: item.monitorId, Description: item.monitorDescription }); break;
    case 'systemNotice': Object.assign(facts, { '': item.text, Subject: item.noticeSubject?.label, Origin: item.noticeOrigin,
      Severity: item.noticeSeverity, Kind: item.noticeKind }); break;
    case 'hookRun': Object.assign(facts, { Hook: item.label || item.hookKey, Event: item.event, Reason: item.reason }); status = item.runStatus || status; break;
    case 'compaction': Object.assign(facts, { Trigger: item.trigger, Outcome: item.outcome, Reason: item.reason,
      'Tokens before': item.tokensBefore, 'Tokens after': item.tokensAfter }); break;
    case 'scheduledFire': Object.assign(facts, { Job: item.jobId, Delivery: item.deliveryNumber }); break;
    case 'reminderChild': Object.assign(facts, { Agent: item.reminderAgentId, Session: item.childSessionId, Task: item.taskId }); break;
    case 'sideChat': facts.Session = item.sideSessionId; break;
    case 'peerMessage': facts.Sender = item.peerMessage?.senderLabel; facts.Session = item.peerMessage?.senderSessionId; break;
    case 'subagentInput': case 'subagentResult':
      Object.assign(facts, { Agent: item.subagentId, Parent: item.parentSubagentId, Session: item.childSessionId });
      status = item.inputPhase || item.resultStatus || status;
      break;
    case 'webSearch': Object.assign(facts, { Action: item.action, Query: item.query, Matches: item.results?.length }); status = item.providerStatus || status; break;
    case 'skillRead': Object.assign(facts, { Skill: item.selector, Source: item.source }); break;
    case 'backgroundTerminalCompletion': facts.Call = item.backgroundTerminalCompletion?.toolCallId; status = item.backgroundTerminalCompletion?.terminalStatus || status; break;
    case 'bodyCompletion': facts.Summary = item.bodyCompletion?.resultSummary; status = item.bodyCompletion?.status || status; break;
  }
  // Generic fallback is for display, but some families may embed command output or a private child message.
  if (['overdueNotice', 'compaction', 'systemNotice'].includes(item.kind) && !facts['']) facts[''] = item.fallbackText;
  reportFacts(host, id, childItems.has(item.kind) ? 'agent' : 'progress', title, facts, status);
}

// A finished worker turn leaves its `muse serve` process running for the conversation's next turn, skipping spawn,
// initialize, permissionProfile/list, session/resume and unchanged model setup. At most three stay warm across all bots,
// each for 10 idle minutes, oldest first; another cwd, access level or MCP helper config starts a fresh process.
const WARM = new Map();
const WARM_MS = 10 * 60 * 1000, WARM_MAX = 3;

function dropWarm(sessionId, stop = true) {
  const entry = WARM.get(sessionId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  entry.host.child.removeListener('close', entry.onClose);
  if (entry.host.parkedSessionId === sessionId) entry.host.parkedSessionId = null;
  WARM.delete(sessionId);
  if (stop) return entry.owner.closeHost(entry.host);
  return entry;
}

function helperSignature(helpers) {
  if (!helpers) return null;
  const env = helpers.env ? Object.entries(helpers.env).sort(([a], [b]) => a.localeCompare(b)) : null;
  return { serverName: helpers.serverName, command: helpers.command, args: helpers.args || [], env };
}

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
    this.usageChildren = new Set();
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
    const host = { child, sdk, session: null, held: [], opening: false, context: null, reported: new Map(),
      publicItems: new Map(), messages: new Map(), summaryCursors: new Set(), tokenEvents: new Map(), failed: false, appliedModelKey: null, closing: null };
    // The code stays: INVALID_STRUCTURED_RESPONSE (a Hub reply that used a tool) gets the router's one retry.
    host.failure = new Promise((_, reject) => {
      host.fail = error => {
        host.failed = true;
        reject(Object.assign(new Error(error.message || 'Muse protocol failed.'), error.code ? { code: error.code } : {}));
      };
    });
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
    if (host.closing) return host.closing;
    host.closing = (async () => {
      const remaining = await stopTree(host.child);
      if (remaining.length) throw new Error('Muse cleanup is not confirmed. Resolve its process before retrying.');
      host.session?.hostExited({ kind: 'transportEof' });
      await host.rpc.close();
      this.hosts.delete(host);
    })().catch(error => { host.closing = null; throw error; });
    return host.closing;
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
          label: model.displayLabel || model.modelId, provider: 'native:muse', rank: 35, worker: true, router: true, images: true,
          efforts: (model.reasoningEffortVariants || []).map(variant => variant.tier).filter(Boolean),
          effort: model.defaultReasoningEffort || null,
          // The catalog's context limit (null when undeclared) is the model's window.
          ...(Number.isSafeInteger(model.contextLimit) && model.contextLimit > 0 ? { contextWindow: model.contextLimit } : {}) }));
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
    const profileId = this.models.find(model => model.model === options.model)?.profileId || null;
    await this.call(host, 'session/setModel', { sessionId: host.session.sessionId,
      model: { providerId: 'meta', modelId: options.model, ...(profileId ? { profileId } : {}) } }, options.signal, true);
    host.appliedModelKey = JSON.stringify([options.model, profileId]);
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
      const { viewCursor, field } = event.params;
      const summaryDelta = event.method === 'item/delta' && SUMMARY_PART.test(field);
      if (host.context && summaryDelta && viewCursor) {
        if (host.summaryCursors.has(viewCursor)) return;
        host.summaryCursors.add(viewCursor);
      }
      const { fold, io } = host.session.apply(event);
      io.catch(error => host.fail(error));
      if (event.method === 'session/tokenUsage') host.tokenEvents.set(event.params.viewCursor, event.params);
      if (!host.context) return;
      // The SDK applies view/page and the buffered live tail internally: those recovered
      // items never hit onNotification again. Project just changed items, not resumed history.
      if (fold.kind === 'deliveryGap' && !host.gapView) {
        const { items, sessionState } = host.session.fold;
        const before = new Map(items.list().map(item => [item.itemId, item]));
        const plans = ['session/todoListChanged', 'session/goalChanged'].map(method => [method, sessionState.get(method)]);
        const context = host.context;
        host.gapView = io.then(() => {
          if (host.context !== context || !host.session.fold.current) return;
          for (const item of items.list()) {
            const changed = before.get(item.itemId) !== item;
            if (changed || (item.kind === 'reasoning' && host.publicItems.has(item.itemId) && item.status === 'inProgress'))
              this.projectItem(host, item, changed, !changed);
          }
          for (const [method, previous] of plans) {
            const projected = sessionState.get(method);
            if (projected && projected !== previous) reportSessionPlan(host, method, projected);
          }
        }).catch(error => host.fail(error)).finally(() => { host.gapView = null; });
        return;
      }
      if (!event.method.startsWith('item/')) {
        const p = event.params;
        if (fold.kind === 'sessionState' && fold.outcome.applied) reportSessionPlan(host, event.method, p);
        if (fold.kind === 'turn' && ['turn/retryScheduled', 'turn/modelRetryScheduled'].includes(event.method)) {
          reportFacts(host, [event.method, p.turnId, p.nextAttempt].join(':'), 'progress', 'Retry scheduled', {
            Attempt: p.nextAttempt, Maximum: p.maxAttempts, 'Delay (ms)': p.retryDelayMs, Reason: p.reason || p.errorKind,
            System: p.system, 'HTTP status': p.httpStatus, 'Error kind': p.reason && p.errorKind !== p.reason && p.errorKind });
        }
        if (fold.kind === 'turn' && event.method === 'turn/foregroundCompleted')
          reportFacts(host, 'foreground:' + p.turnId, 'progress', 'Foreground completed', { 'Blocking agents': listed(p.blockingAgents) });
        if (fold.kind === 'monitorInbox' && p.itemId) {
          const key = 'monitor-inbox:' + p.itemId;
          if (event.method === 'monitor/inboxItemAdmitted') reportFacts(host, key, 'progress', 'Monitor notification',
            { Monitor: p.taskId, Event: p.eventKind }, 'queued');
          if (event.method === 'monitor/inboxItemDrained' && p.deliveryVisible)
            reportFacts(host, key, 'progress', 'Monitor notification', {}, 'delivered');
          if (event.method === 'monitor/inboxItemVoided') reportFacts(host, key, 'progress', 'Monitor notification', {}, 'voided');
        }
        return;
      }
      const itemId = event.params.item?.itemId || event.params.itemId;
      const item = host.session.fold.items.get(itemId);
      const snapshot = fold.kind === 'item' && fold.outcome.kind !== 'ignoredStaleRevision';
      if (item && (snapshot || (fold.kind === 'itemDelta' && summaryDelta) || item.kind === 'agentMessage' || item.kind === 'toolCall'))
        this.projectItem(host, item, snapshot, summaryDelta);
    } catch (error) { host.fail(error); }
  }

  projectItem(host, item, snapshot, summaryDelta) {
    if (snapshot) progressItem(host, item);
    if (item.kind === 'reasoning' || item.kind === 'subagent') {
      if ((summaryDelta && item.status === 'inProgress') || snapshot) this.publicItem(host, item, snapshot);
      return;
    }
    if (item.kind !== 'agentMessage' && item.kind !== 'toolCall') return;
    const signature = JSON.stringify(item);
    if (host.reported.get(item.itemId) === signature) return;
    host.reported.set(item.itemId, signature);
    this.item(host, item);
  }

  publicItem(host, item, snapshot) {
    const id = item.itemId;
    if (typeof id !== 'string' || !id) return;
    const known = host.publicItems.get(id) || {};
    host.publicItems.set(id, known);
    const remember = (key, value) => { if (typeof value === 'string' && value) known[key] = value; };
    let title, text;
    if (item.kind === 'subagent') {
      remember('role', item.role);
      remember('child', item.subagentId);
      remember('session', item.childSessionId);
      remember('objective', item.objective);
      remember('summary', item.result?.summary);
      remember('result', item.result?.text);
      remember('failure', item.failureReason);
      remember('definition', references([item.agentPath]));
      remember('parent', item.parentSubagentId);
      remember('workflow', item.workflowRunId);
      remember('placement', item.workspacePlacement);
      remember('duration', publicValue(item.durationMs));
      remember('depth', publicValue(item.depth));
      remember('outcome', item.result?.errorKind);
      remember('fallback', item.fallbackText);
      remember('truncated', item.truncated === true && 'Provider truncated this item');
      remember('drained', item.result?.drained === true && 'Result consumed');
      remember('artifacts', references(item.result?.artifactRefs));
      remember('evidence', references(item.result?.evidenceRefs));
      if (item.result) known.superseded = item.result.superseded === true;
      if (item.controlStatus || !known.status || item.status !== 'inProgress')
        remember('status', item.controlStatus || item.status);
      title = known.role || 'Subagent';
      text = [...new Set([known.child || known.session, known.objective, known.summary, known.result, known.failure,
        known.child && known.session && 'Session: ' + known.session, known.parent && 'Parent: ' + known.parent,
        known.definition && 'Agent definition: ' + known.definition, known.workflow && 'Workflow: ' + known.workflow,
        known.placement && 'Workspace: ' + known.placement, known.depth && 'Depth: ' + known.depth,
        known.duration && 'Duration: ' + known.duration + ' ms', known.outcome, known.drained,
        known.artifacts && 'Artifacts: ' + known.artifacts, known.evidence && 'Evidence: ' + known.evidence,
        known.superseded && 'Result superseded', known.fallback, known.truncated].filter(Boolean))].join('\n\n');
    } else {
      // MSP snapshots include text through that revision. The SDK indexes subsequent
      // deltas separately by summary part; only append text not covered by the snapshot.
      const store = host.session.fold.items;
      const parts = known.parts ||= new Map();
      if (snapshot && Array.isArray(item.summary)) item.summary.forEach((value, i) => {
        if (typeof value === 'string' && value) parts.set(i, { base: value, offset: store.accumulated(id, 'summary.' + i)?.length || 0 });
      });
      for (const field of store.accumulatedFields(id)) {
        const match = SUMMARY_PART.exec(field);
        if (!match) continue;
        const i = Number(match[1]);
        if (!Number.isSafeInteger(i)) continue;
        if (!parts.has(i)) parts.set(i, { base: '', offset: 0 });
      }
      text = [...parts].sort(([a], [b]) => a - b).map(([i, part]) =>
        part.base + (store.accumulated(id, 'summary.' + i) || '').slice(part.offset)).filter(Boolean).join('\n\n');
      // MSP permits a one-line display fallback on any item. reasoning.text is a different, raw surface.
      remember('fallback', item.fallbackText);
      if (!text.trim()) text = known.fallback || '';
      title = text ? 'Reasoning summary' : 'Reasoning';
      if (item.truncated === true) known.truncated = true;
      if (known.truncated) text = [text, 'Provider truncated this item'].filter(Boolean).join('\n\n');
      remember('status', item.status);
    }
    const info = { type: 'info', id, kind: item.kind === 'subagent' ? 'agent' : 'reasoning', title, text,
      ...(known.status ? { status: known.status } : {}) };
    const signature = JSON.stringify(info);
    if (host.reported.get(id) === signature) return;
    host.reported.set(id, signature);
    host.context.onEvent?.(info);
  }

  item(host, item) {
    const onEvent = host.context.onEvent || (() => {});
    if (item.kind === 'agentMessage') {
      const prior = host.messages.get(item.itemId);
      const phase = item.messagePhase === 'commentary' ? 'commentary' : item.messagePhase === 'finalAnswer' ? 'final_answer' : prior?.phase;
      const text = typeof item.text === 'string' && item.text || prior?.text || '';
      host.messages.set(item.itemId, { phase, text });
      if (phase || typeof item.text === 'string') onEvent({ type: 'assistant',
        message: { id: item.itemId, ...(phase ? { phase } : {}), content: [{ type: 'text', text }] } });
    }
    if (item.kind !== 'toolCall') return;
    // A Hub or routing reply is tool-free, as for every provider: a reply that uses a tool is not accepted (cursor.cjs).
    if (host.context.schema) return host.fail(invalidResponse());
    onEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: item.itemId,
      name: item.tool || 'Muse tool', input: item.args || {} }] } });
    if (item.status !== 'inProgress') onEvent({ type: 'user', message: { content: [{ type: 'tool_result',
      tool_use_id: item.itemId, is_error: item.status !== 'completed', content: item.visibleOutput || item.failureReason || item.status }] } });
  }

  async run(options) {
    // A tool-free structured one-off (a Secondary read, routing) runs in its own process beside a turn; worker turns take turns.
    const release = options.schema ? () => {} : await takeTurn(this, options.signal, LABEL);
    const poolable = !options.schema;
    const signature = poolable ? JSON.stringify([options.cwd, options.access, helperSignature(options.helpers)]) : null;
    const profileId = this.models.find(model => model.model === options.model)?.profileId || null;
    const modelKey = JSON.stringify([options.model, profileId]);
    let host, succeeded = false;
    try {
      const warm = poolable && options.resume && WARM.get(options.resume)?.owner === this ? dropWarm(options.resume, false) : null;
      const reused = warm && warm.signature === signature && !warm.host.failed && warm.host.child.exitCode === null
        && !warm.host.child.killed && warm.host.session?.sessionId === options.resume ? warm : null;
      if (warm && !reused) await this.closeHost(warm.host);
      let session;
      if (reused) {
        host = reused.host;
        session = host.session;
        host.reported.clear();
        host.publicItems.clear();
        host.messages.clear();
        host.summaryCursors.clear();
        host.tokenEvents.clear();
        host.context = options;
        options.onEvent?.({ type: 'system', session_id: session.sessionId });
        if (host.appliedModelKey !== modelKey) {
          await this.call(host, 'session/setModel', { sessionId: session.sessionId,
            model: { providerId: 'meta', modelId: options.model, ...(profileId ? { profileId } : {}) } }, options.signal, true);
          host.appliedModelKey = modelKey;
        }
      } else {
        host = await this.createHost(options.cwd, options.signal);
        // A Hub or routing reply runs read-only, as DeepSeek's does.
        session = await this.openSession(host, options.schema ? { ...options, access: 'read-only' } : options);
        host.context = options;
        options.onEvent?.({ type: 'system', session_id: session.sessionId });
      }
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

      if (host.gapView) await deadline(Promise.race([host.gapView, host.failure]), options.timeoutMs || 30 * 60 * 1000, LABEL, options.signal);
      const text = session.fold.items.list().filter(item => item.turnId === last.turnId && item.kind === 'agentMessage'
        && (host.messages.get(item.itemId)?.phase || item.messagePhase) !== 'commentary')
        .map(item => host.messages.get(item.itemId)?.text || item.text || '').join('\n\n');
      // Raw cache conventions vary; use Muse's counted-once per-completion projection.
      const ids = new Set(turns.map(known => known.turnId));
      const events = [...host.tokenEvents.values()].filter(event => ids.has(event.turnId));
      const counts = events.filter(event =>
        Number.isSafeInteger(event.promptTokens) && event.promptTokens >= 0 &&
        Number.isSafeInteger(event.usage?.outputTokens) && event.usage.outputTokens >= 0);
      const usage = counts.length && counts.length === events.length ? counts.reduce((total, event) => ({ input_tokens: total.input_tokens + event.promptTokens,
        output_tokens: total.output_tokens + event.usage.outputTokens }), { input_tokens: 0, output_tokens: 0 }) : null;
      const contextWindow = this.models.find(model => model.model === options.model)?.contextWindow;
      const result = { session_id: session.sessionId, result: text, ...(usage ? { usage, cacheUsageUnknown: true } : {}), ...(contextWindow ? { contextWindow } : {}) };
      succeeded = true;
      return result;
    } finally {
      if (host) host.context = null;
      try {
        const canPark = succeeded && poolable && !options.signal?.aborted && host && !host.failed
          && host.child.exitCode === null && !host.child.killed && host.session?.sessionId;
        if (canPark) this.park(host.session.sessionId, { host, signature });
        else if (host) await this.closeHost(host);
      } finally { release(); }
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

  async readUsage() {
    const LIMIT = 1024 * 1024;
    const executable = this.find();
    const child = spawnOwned(this.launch, executable.command, [...executable.args, 'usage', '--json'], {
      cwd: os.tmpdir(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.usageChildren.add(child);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    try {
      const output = await deadline(new Promise((resolve, reject) => {
        let stdout = '', stderr = '', settled = false;
        const finish = (error, value) => {
          if (settled) return;
          settled = true;
          error ? reject(error) : resolve(value);
        };
        const append = (chunk, isErr) => {
          if (settled) return;
          if (isErr) stderr += chunk; else stdout += chunk;
          if (stdout.length + stderr.length > LIMIT) finish(new Error('Muse usage output is too large.'));
        };
        child.stdout.on('data', chunk => append(chunk, false));
        child.stderr.on('data', chunk => append(chunk, true));
        child.once('error', error => finish(error.code === 'ENOENT' ? error : new Error(`Muse usage lookup could not start: ${error.message}`)));
        child.once('close', code => code === 0
          ? finish(null, stdout)
          : finish(new Error(stderr.trim()
            ? `Muse usage failed (exit ${code}): ${stderr.trim().slice(0, 200)}`
            : `Muse usage failed with exit code ${code}.`)));
      }), 15000, LABEL);
      let parsed;
      try { parsed = JSON.parse(output); }
      catch { throw new Error('Muse returned invalid usage JSON.'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Muse returned invalid usage JSON.');
      }
      return parsed;
    } finally {
      if (!(await stopTree(child)).length) this.usageChildren.delete(child);
    }
  }

  park(sessionId, entry) {
    dropWarm(sessionId, true)?.catch(() => {});
    entry.owner = this;
    entry.host.parkedSessionId = sessionId;
    entry.onClose = () => { if (WARM.get(sessionId) === entry) dropWarm(sessionId, true)?.catch(() => {}); };
    entry.host.child.once('close', entry.onClose);
    if (!entry.host.watchedFailure) {
      entry.host.watchedFailure = true;
      entry.host.failure.catch(() => {
        const id = entry.host.parkedSessionId;
        if (id && WARM.get(id)?.host === entry.host) dropWarm(id, true)?.catch(() => {});
      });
    }
    entry.timer = setTimeout(() => { if (WARM.get(sessionId) === entry) dropWarm(sessionId, true)?.catch(() => {}); }, WARM_MS);
    entry.timer.unref?.();
    WARM.set(sessionId, entry);
    while (WARM.size > WARM_MAX) dropWarm(WARM.keys().next().value, true)?.catch(() => {});
  }

  warmCount() {
    return [...WARM.values()].filter(entry => entry.owner === this).length;
  }

  close() {
    return Promise.all([
      ...[...WARM].filter(([, entry]) => entry.owner === this).map(([id]) => dropWarm(id, true)),
      ...[...this.hosts].map(host => this.closeHost(host)),
      ...[...this.usageChildren].map(async child => {
        if (!(await stopTree(child)).length) this.usageChildren.delete(child);
      }),
    ]);
  }
}

module.exports = { MuseCLI };
