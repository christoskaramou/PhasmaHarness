const fs = require('node:fs');
const path = require('node:path');
const { SessionStore } = require('./session-store.cjs');
const { randomUUID } = require('node:crypto');
const { CursorCLI } = require('./providers/cursor.cjs');
const { MuseCLI } = require('./providers/muse.cjs');
const { AntigravityCLI } = require('./providers/antigravity.cjs');
const { DeepSeekCLI } = require('./providers/deepseek.cjs');
const { ApiAgent } = require('./providers/api-agent.cjs');
const { TOOLS: AGENT_TOOLS } = require('./tools/agent-tools.cjs');
const { TOOLS: CONNECTOR_TOOLS, INSTRUCTIONS: CONNECTOR_INSTRUCTIONS } = require('./connectors/tools.cjs');
const { NATIVE_CLI_INFO } = require('./providers/native-cli.cjs');
const { ClaudeCLI, handoff } = require('./providers/claude.cjs');
const { CAPABILITIES, API: API_CAPABILITIES, capabilities, isCLI } = require('./providers/capabilities.cjs');
const { ProviderLimits } = require('./providers/limits.cjs');
const { NO_LOG } = require('./log.cjs');
const { NO_TRACE } = require('./trace.cjs');
const { EventEmitter } = require('node:events');
const { CodexClient } = require('./providers/codex.cjs');
const { PRESETS, ROUTER_PRESETS, route } = require('./routing/router.cjs');
const { SmartRouter } = require('./routing/smart-router.cjs');
const { MODEL: JEV_MODEL } = require('./providers/jev.cjs');
const { TOOL: CONTEXT_TOOL } = require('./workspace/context-search.cjs');
const { INSTRUCTIONS: HELPER_INSTRUCTIONS, TOOLS: HELPER_TOOLS, ToolHelpers } = require('./tools/tool-helpers.cjs');
const { RouterBridge } = require('./tools/router-bridge.cjs');
const { FINAL, canProposeWiki, hasProjectWiki, restartReason, summaryLine } = require('./tasks.cjs');
const { WORKER_INSTRUCTIONS, workerInstructions } = require('./worker-instructions.cjs');
const skillPackages = require('./skill-packages.cjs');
const { setupFingerprint, textHash, skillHashes, checksHash } = require('./setup-fingerprint.cjs');
const { projectInstructions, projectBody } = require('./workspace/project-instructions.cjs');
const { stripTaskStatus } = require('./routing/task-state.cjs');
const { withoutImages } = require('./image-input.cjs');
const { EFFORT_CAPS, DEFAULT_EFFORT_CAP, capCatalog } = require('./routing/effort-cap.cjs');
const processTree = require('./process-tree.cjs');
const { prepare: prepareFiles } = require('../ui/attachments.js');
const { CONTEXT_INSTRUCTIONS, ACCESS_MODES, sameEffort, DEFAULT_ROUTER, sessionAllowKey, accessMode, isMcpConfirmation } = require('./controller/shared.cjs');

class Controller extends EventEmitter {
  constructor(filename, defaultWorkspace, client = new CodexClient(), smartRouter = new SmartRouter(path.join(path.dirname(filename), 'router-workspace')), options = {}) {
    super();
    this.filename = filename;
    this.store = new SessionStore(filename, error => this.log?.warn('Session checkpoint deferred', { error: String(error) }));
    this.data = this.store.load({
      version: 1, settings: { workspace: defaultWorkspace, mode: 'auto', access: 'workspace-write' }, sessions: [],
    });
    if (this.data.version !== 1 || !Array.isArray(this.data.sessions)) throw new Error('Unrecognized session store. Your existing file has been preserved.');
    if (!this.data.settings.routing || this.data.settings.routing === 'rules') this.data.settings.routing = 'smart';
    this.data.settings.routerPreset ??= DEFAULT_ROUTER;
    const legacyRouter = ROUTER_PRESETS.find(p => p.id === this.data.settings.routerPreset);
    if (legacyRouter) this.data.settings.routerPreset = `codex:${legacyRouter.model}:${legacyRouter.effort || 'default'}`;
    accessMode(this.data.settings.access);
    this.client = client;
    this.smartRouter = smartRouter;
    this.claude = new ClaudeCLI();
    this.smartRouter.claude = this.claude;
    this.cursor = new CursorCLI(); this.smartRouter.cursor = this.cursor;
    this.nativeCLIs = options.nativeCLIs || new Map([['native:muse', new MuseCLI()], ['native:antigravity', new AntigravityCLI()], ['native:deepseek', new DeepSeekCLI()]]);
    this.smartRouter.nativeCLIs = this.nativeCLIs;
    this.toolHelpers = new ToolHelpers(path.join(path.dirname(filename), 'tool-outputs'), client, null);
    this.toolHelpers.skillDirectories = session => this.skillDirectories(session);
    this.bridge = new RouterBridge((sessionId, tool, args, signal) => this.bridgeTool(sessionId, tool, args, signal));
    this.helperApprovals = new Map();
    // "Allow for this session": Claude/Cursor tool targets the user allowed, per chat session, kept in memory only.
    this.sessionAllows = new Map(); this.approvalKeys = new Map();
    // Usage limits per provider (persisted until their reset) and the last Auto message per session, for failover.
    this.data.providerLimits ??= {};
    this.data.providerQuotas ??= {};
    this.limits = new ProviderLimits(this.data.providerLimits, () => Date.now(), this.data.providerQuotas);
    this.lastSends = new Map();
    this.loadedModelConfigs = new Map();
    // Opt-in Jev comparison log (set by the app) and the comparison in flight, if any.
    this.jevCompare = null; this.jevComparing = null;
    // Local decision trace (set by the app; see src/trace.cjs), wiki reads taken before maintenance turns for the
    // opt-in log-only wiki check, and the abort for checks still running when the app closes.
    this.trace = NO_TRACE; this.startedAt = Date.now();
    this.wikiSnapshots = new Map(); this.wikiChecks = new AbortController();
    this.log = NO_LOG; // replaced by the app's rotating log file
    // Worker cleanups after Stop (src/process-tree.cjs): new work waits while one runs, and stays blocked while one
    // could not be confirmed (data.workerCleanup, retried until confirmed, also after a restart).
    this.cleanupPending = new Set(); this.cleanupRetry = null; this.cleanupWait = null;
    this.onCleanupPending = id => { this.cleanupPending.add(id); };
    this.onCleanupDone = ({ id, remaining, record }) => {
      this.cleanupPending.delete(id);
      if (remaining.length) this.holdCleanup(record);
      this.cleanupChanged();
    };
    processTree.cleanup.on('pending', this.onCleanupPending).on('done', this.onCleanupDone);
    this.helperRequests = new Set();
    // Large tool output is always captured as excerpts; the setting is no longer shown, so an old "off" is not kept.
    this.data.settings.largeResponses = true;
    if (!EFFORT_CAPS.includes(this.data.settings.effortCap)) this.data.settings.effortCap = DEFAULT_EFFORT_CAP;
    this.contextSearch = null;
    this.wikiStore = options.wikiStore || null;
    this.contextRequests = new Set();
    this.routing = null;
    this.connection = 'connecting';
    this.connectingProviders = new Map();
    this.chatgptLoginPending = false;
    this.codex = { installed: null, connected: false };
    this.error = null;
    this.account = null;
    this.models = [];
    this.loaded = new Set();
    this.loadedInstructions = new Map();
    this.loading = new Map();
    this.requests = new Map();
    this.busy = null;
    this.stopping = new Set();
    this.activeTurns = new Map();
    this.timer = null;
    this.gate = null;
    this.gateDone = Promise.resolve();
    this.lookupProcess = options.lookupProcess || null;
    this.killMatched = options.killProcessTree || null;
    this.data.settings.checks ??= {};
    let restarted = false;
    for (const session of this.data.sessions) {
      if (session.queueSending) for (const message of session.queue || []) {
        message.uncertain = true; message.error = 'App closed during delivery. Check the conversation before resending.';
      }
      for (const message of session.queue || [])
        delete message.sending;
      session.queueSending = false;
      session.compacting = false;
      session.submission = null;
      session.activeTaskId = null;
      session.access ??= this.data.settings.access;
      accessMode(session.access);
      if (session.status === 'running') { session.status = 'interrupted'; session.queuePaused = true; restarted = true; }
      for (const task of session.tasks || []) if (!FINAL.has(task.state)) {
        task.reason = restartReason(task, this.data.executionBlock);
        task.state = 'needs-you';
        if (task.foreground && task.budgetId) {
          task.budgetPaused = true; task.budgetResumePending = false; task.budgetResumeReviewRequired = true;
          task.budgetResumeError = 'Execution was interrupted by a restart. Inspect the files and evidence, then send a new request; this task will not replay.';
        }
        task.summary = summaryLine(task);
        restarted = true;
      }
      for (const task of session.tasks || []) if (task.wikiMaintenance?.state === 'running') { task.wikiMaintenance.state = 'interrupted'; restarted = true; }
      const latestTask = session.tasks?.at(-1);
      if (latestTask) latestTask.wikiAvailable = canProposeWiki(latestTask) && (!!this.wikiStore || hasProjectWiki(session.workspace));
    }
    const cleared = this.recoverExecutionBlock();
    const cleaned = this.recoverWorkerCleanup();
    if (restarted || cleared || cleaned) { try { this.save(); } catch { /* the in-memory block and task state still apply */ } }
    client.on('notification', message => this.notification(message));
    client.on('request', message => this.serverRequest(message));
    client.on('disconnected', error => {
      this.chatgptLoginPending = false;
      const message = typeof error === 'string' ? error : error?.message;
      this.codex = { ...this.codex, connected: false, error: message };
      this.log.warn('Codex app-server disconnected', { error: message });
      // Dead Codex models must not stay routable.
      this.account = null; this.models = [];
      const routerProvider = this.routerChoices().find(p => p.id === this.data.settings.routerPreset)?.provider;
      // Claude/Cursor turns and CLI routing do not use this connection; only its MCP gateway approvals die with it.
      const independent = !this.gate && (!!this.cliAbort || (this.routing && isCLI(routerProvider)));
      if (independent) this.cancelHelpers('router-');
      else {
        this.cancelHelpers();
        this.smartRouter.cancel();
        this.contextSearch?.cancel();
        if (this.gate) this.gate.abort.abort();
        if (this.busy) {
          const session = this.session(this.busy);
          const submission = session.submission;
          if (submission && submission.state !== 'completed' && submission.state !== 'unconfirmed')
            this.finishTurn(session, submission, { status: 'interrupted', error: message, reason: 'connection lost' });
          else if (!this.gate) { session.status = 'interrupted'; session.compacting = false; this.busy = null; }
        }
        this.requests.clear();
      }
      const cli = this.catalog().some(p => p.provider !== 'codex' && this.available(p));
      this.connection = cli ? 'ready' : 'disconnected';
      this.error = cli ? null : message;
      this.adoptRouter();
      this.changed();
    });
  }

  async initialize(shared = null) {
    // A file check first, so an installed CLI never shows "not installed" while slower checks run.
    for (const backend of this.nativeCLIs.values()) backend.inspect();
    const checks = [];
    let claude = Promise.resolve();
    if (shared) {
      this.claude.status = { ...shared.claude.status }; this.claude.models = shared.claude.models;
      this.cursor.status = { ...shared.cursor.status }; this.cursor.models = shared.cursor.models;
    } else {
      claude = this.withProviderConnection('claude-cli', () => this.claude.refresh());
      checks.push(this.withProviderConnection('cursor-cli', () => this.cursor.refresh()));
    }
    for (const [id, backend] of this.nativeCLIs) {
      if (shared?.nativeCLIs?.has(id)) {
        backend.status = { ...shared.nativeCLIs.get(id).status }; backend.models = shared.nativeCLIs.get(id).models;
      } else if (this.data.settings[NATIVE_CLI_INFO[id].setting]) checks.push(this.withProviderConnection(id, () => backend.refresh()));
    }

    // Codex (and the API providers that run through it) no longer waits for every CLI check, which took ~17 s.
    // The legacy router migration still reads Claude first, as before.
    checks.push(claude.then(async () => {
      this.migrateLegacyRouter();
      try {
        this.data.settings.toolSelection ??= this.smartRouter.jev?.configured ? 'jev' : 'off';
        // One-time adoption of the requested Jev integration; subsequent explicit settings win.
        if (!this.data.settings.helpersVersion) {
          if (this.smartRouter.jev?.configured) this.data.settings.routing = 'jev';
          this.data.settings.helpersVersion = 1;
        }
        if (this.agents?.closing) return;
        await this.bridge.start();
        if (!this.agents?.closing) await this.connectCodex();
      } catch (error) { this.connection = 'disconnected'; this.error = error.message; }
    }));
    await Promise.all(checks);
    if (this.agents?.closing) return;

    // The UI shows only "not installed" or "not connected"; keep the reason a startup check failed.
    if (!shared) {
      for (const [provider, status] of [['claude-cli', this.claude.status], ['cursor-cli', this.cursor.status]]) {
        if (status.error)
          this.log.warn('Provider check failed', { provider, installed: status.installed, error: String(status.error).slice(0, 300) });
      }
    }

    // Cursor reasoning levels come from its model list; load it once in the background when Cursor models are enabled.
    if (!shared && this.cursor.status.loggedIn && this.data.settings.cursorEnabled !== false && (this.data.settings.providerModels || []).some(p => p.provider === 'cursor-cli'))
      this.discoverCursor().catch(() => {});
    this.recordProviderDefaults();
    this.changed();
  }

  get routingProvider() { return this.data.settings.jevEnabled === false && this.data.settings.routing === 'jev' ? 'smart' : this.data.settings.routing; }

  snapshot() {
    // Comparisons hold which run carries the change; the chat card gets a public view instead.
    const { jobBudgets, routines, comparisons, ...visibleData } = this.data;
    return {
      benchmarks: this.smartRouter.benchmarks?.summary(this.catalog().filter(p => p.worker && p.enabled && this.available(p))),
      cursor: { ...this.cursor.status, enabled: this.data.settings.cursorEnabled !== false },
      claude: { ...this.claude.status, enabled: !!this.data.settings.claudeEnabled, quotaAccountKey: this.claude.accountKey?.() || null },
      nativeCLIs: Object.fromEntries([...this.nativeCLIs].map(([id, backend]) => [id, {
        ...backend.status, label: NATIVE_CLI_INFO[id].label, enabled: !!this.data.settings[NATIVE_CLI_INFO[id].setting],
      }])),
      codex: this.codex,
      cliUpdates: this.cliUpdates || {},
      coordinator: this.isCoordinator(), hubMode: this.data.hubMode || null,
      connectingProviders: [...new Set([...this.connectingProviders.keys(), ...(this.chatgptLoginPending ? ['codex'] : [])])],
      chatgptLoginPending: this.chatgptLoginPending,
      ...visibleData, settings: { ...this.data.settings, mode: this.planPreset() ? 'auto' : this.data.settings.mode }, planRouting: this.planPreset(), connection: this.connection, error: this.error, account: this.account, busy: this.busy,
      sessions: this.data.sessions.map(session => withoutImages({ ...session, tasks: (session.tasks || []).map(({ inputImages, ...task }) => task) })),
      routing: this.routing, routingProvider: this.routingProvider, routerModel: this.routingProvider === 'jev' ? this.smartRouter.jev?.model || JEV_MODEL : this.routerChoices().find(p => p.id === this.data.settings.routerPreset)?.model || null,
      jev: { configured: !!this.smartRouter.jev?.configured, keySaved: !!(this.smartRouter.jev?.keyStore?.configured ?? this.smartRouter.jev?.configured), enabled: this.data.settings.jevEnabled !== false, model: this.smartRouter.jev?.model || null, requestedModel: JEV_MODEL, compare: this.jevCompare?.summary() || null, health: this.smartRouter.jev?.health || null },
      decisions: this.trace.summary(),
      helperCapabilities: {
        projectContext: { codex: true, responsesApi: true, claudeCli: true, cursorCli: true },
        jevToolRecommendations: { codex: true, responsesApi: true, claudeCli: 'codex-thread-mcp-catalog', cursorCli: 'codex-thread-mcp-catalog' },
        largeOutputCapture: { codex: 'helper-gateway-only', responsesApi: 'helper-gateway-only', claudeCli: 'helper-mcp-only', cursorCli: 'helper-mcp-only' },
        note: 'Large-output capture applies to router_call_tool / project_context helper responses. It does not intercept native Codex, Claude, or Cursor tools. Claude/Cursor session MCP connects phasma_harness for project_context / router_read_output. router_find_tools / router_call_tool are intentionally Codex-scoped (Codex MCP catalog/gateway); without a Codex thread they return unsupported. Do not build parallel CLI catalogs for parity. This app does not rewrite project MCP configs or silently elevate MCP approvals.',
      },
      accessModes: ACCESS_MODES,
      providerLimits: this.limits.active(),
      providerQuotas: this.data.providerQuotas,
      // api: what an API provider (an id without a colon) supports; the UI applies it like capabilities() does.
      providerCapabilities: { ...CAPABILITIES, api: API_CAPABILITIES },
      requests: [...this.requests.values()].map(request => ({
        ...request,
        canAccept: request.method !== 'mcpServer/elicitation/request' || isMcpConfirmation(request.params),
        canAllowSession: this.helperApprovals.has(request.id) ? this.approvalKeys.has(request.id)
          : /^item\/(commandExecution|fileChange|permissions)\/requestApproval$/.test(request.method),
      })),
      providerCatalog: this.catalog().map(p => ({ ...p, available: this.available(p) })),
      providers: (this.data.settings.providers || []).map(p => ({ ...p, configured: !!this.providers?.configured(p.id) })),
      nativeModels: this.models,
      presets: this.catalog().filter(p => p.worker).map(p => {
        const plan = this.planPreset();
        const planMatch = plan && p.model === plan.model && p.effort === plan.effort;
        return { ...p, available: (!plan || planMatch || p.id === plan.id) && this.available(p) };
      }),
      routerPresets: this.routerChoices().map(p => ({ ...p, available: this.available(p) })),
      chatScanPresets: this.chatScanChoices().map(p => ({ ...p, available: this.available(p) })),
    };
  }

  save() {
    // Persisting must not cancel a pending UI state update.
    this.store.save(this.data);
  }

  changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.save(); } catch (error) { this.error = `Could not save sessions: ${error.message}`; }
      this.emit('state', this.snapshot());
    }, 100);
  }

  session(id) {
    const session = this.data.sessions.find(s => s.id === id);
    if (!session) throw new Error('Session not found.');
    return session;
  }

  image(id, itemId, index) {
    if (typeof itemId !== 'string' || !Number.isInteger(index) || index < 0) throw new Error('Invalid image request.');
    const session = this.session(id), item = [...session.items, session.pendingMessage].find(entry => entry?.id === itemId);
    const part = item?.content?.filter(part => part.type === 'image')[index];
    if (typeof part?.url !== 'string' || !part.url.startsWith('data:image/')) throw new Error('This image is no longer available.');
    return part.url;
  }

  workspace(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || !fs.statSync(value).isDirectory()) throw new Error('Choose an existing workspace folder.');
    return fs.realpathSync(value);
  }

  settings(values) {
    if (!values || typeof values !== 'object') throw new Error('Invalid settings.');
    const next = { ...this.data.settings };
    if (values.jevEnabled !== undefined) {
      if (typeof values.jevEnabled !== 'boolean') throw new Error('Invalid Jev enabled setting.');
      if (this.busy) throw new Error('Stop the current turn before changing Jev.');
      if (values.jevEnabled && !(this.smartRouter.jev?.keyStore?.configured ?? this.smartRouter.jev?.configured)) throw new Error('Add your Jev API key in Providers first.');
      next.jevEnabled = values.jevEnabled;
    }
    if (values.routingBias !== undefined) {
      // Legacy field ignored — the router choice is not adjusted after classification.
    }
    if (values.jevQuickAnswers !== undefined) {
      if (typeof values.jevQuickAnswers !== 'boolean') throw new Error('Invalid quick-answer setting.');
      next.jevQuickAnswers = values.jevQuickAnswers;
    }
    if (values.routerPreset !== undefined) {
      if (!this.routerChoices().some(p => p.id === values.routerPreset)) throw new Error('Unknown router preset.');
      if (values.routerPreset !== (next.routerPreset || 'luna-light') && !this.available(this.routerChoices().find(p => p.id === values.routerPreset))) throw new Error('This router preset is unavailable on your account.');
      next.routerPreset = values.routerPreset;
    }
    if (values.chatScanModel !== undefined) {
      const choice = this.chatScanChoices().find(p => p.id === values.chatScanModel);
      if (values.chatScanModel !== 'off' && !choice)
        throw new Error('Unknown chat checker model.');
      if (choice && !this.available(choice))
        throw new Error('This chat checker model is unavailable on your account.');

      next.chatScanModel = values.chatScanModel;
    }
    if (values.fontScale !== undefined) {
      if (![85, 100, 115, 130, 150].includes(values.fontScale)) throw new Error('Invalid font scale.');
      next.fontScale = values.fontScale;
    }
    if (values.replySuggestions !== undefined) {
      if (typeof values.replySuggestions !== 'boolean') throw new Error('Invalid reply suggestions setting.');
      next.replySuggestions = values.replySuggestions;
    }
    if (values.showTips !== undefined) {
      if (typeof values.showTips !== 'boolean')
        throw new Error('Invalid tips setting.');

      next.showTips = values.showTips;
    }
    if (values.toolSelection !== undefined || values.largeResponses !== undefined) {
      if (this.busy && ((values.toolSelection !== undefined && values.toolSelection !== next.toolSelection) ||
        (values.largeResponses !== undefined && values.largeResponses !== next.largeResponses))) throw new Error('Stop the current turn before changing tool helpers.');
      if (values.toolSelection !== undefined) {
        if (!['off', 'jev'].includes(values.toolSelection)) throw new Error('Unknown tool selection mode.');
        if (values.toolSelection === 'jev' && !this.smartRouter.jev?.configured) throw new Error('Add a Jev API key and enable Jev in Providers first.');
        next.toolSelection = values.toolSelection;
      }
      if (values.largeResponses !== undefined) {
        if (typeof values.largeResponses !== 'boolean') throw new Error('Invalid large response setting.');
        next.largeResponses = values.largeResponses;
      }
    }
    if (values.workspace !== undefined) next.workspace = this.workspace(values.workspace);
    if (values.mode !== undefined) {
      if (values.mode !== 'auto' && !this.resolveWorker(values.mode)) throw new Error('Unknown preset.');
      next.mode = values.mode;
    }
    if (values.effortCap !== undefined) {
      if (!EFFORT_CAPS.includes(values.effortCap)) throw new Error('Unknown effort cap.');
      next.effortCap = values.effortCap;
    }
    if (values.routing !== undefined) {
      if (!['smart', 'jev'].includes(values.routing)) throw new Error('Unknown routing method.');
      if (values.routing === 'jev' && !this.smartRouter.jev?.configured) throw new Error('Add a Jev API key and enable Jev in Providers first.');
      next.routing = values.routing;
    }
    if (values.access !== undefined) {
      accessMode(values.access);
      if (this.busy && values.access !== next.access) throw new Error('Stop the current turn before changing access.');
      next.access = values.access;
    }
    if (values.jevCompare !== undefined) {
      if (typeof values.jevCompare !== 'boolean') throw new Error('Invalid Jev comparison setting.');
      // Only turning it on needs a key; a saved "on" never blocks saving other settings (it is skipped without a key).
      if (values.jevCompare && !next.jevCompare && !this.smartRouter.jev?.configured) throw new Error('Add a Jev API key and enable Jev in Providers first.');
      next.jevCompare = values.jevCompare;
      if (!values.jevCompare) this.jevComparing?.abort();
    }
    if (values.wikiAssessment !== undefined) {
      if (typeof values.wikiAssessment !== 'boolean') throw new Error('Invalid wiki check setting.');
      if (values.wikiAssessment && !next.wikiAssessment && !this.smartRouter.jev?.configured) throw new Error('Add a Jev API key and enable Jev in Providers first.');
      next.wikiAssessment = values.wikiAssessment;
    }
    if (values.contextRanking !== undefined) {
      if (!['local', 'jev'].includes(values.contextRanking)) throw new Error('Unknown context ranking mode.');
      if (values.contextRanking === 'jev' && !this.smartRouter.jev?.configured) throw new Error('Add a Jev API key and enable Jev in Providers first.');
      next.contextRanking = values.contextRanking;
    }
    if (next.toolSelection !== this.data.settings.toolSelection || next.largeResponses !== this.data.settings.largeResponses) this.loaded.clear();
    if (next.jevEnabled !== this.data.settings.jevEnabled) { this.jevComparing?.abort(); this.smartRouter.jev?.resetHealth?.(); }
    const jevSwitchedOn = this.data.settings.jevEnabled === false && next.jevEnabled !== false;
    this.data.settings = next; this.save(); this.changed();
    if (jevSwitchedOn)
      this.checkJev();
    return this.snapshot();
  }

  create(workspace, access = this.data.settings.access) {
    accessMode(access);
    const session = {
      id: randomUUID(), threadId: null, title: 'New session', workspace: this.workspace(workspace || this.data.settings.workspace),
      access, created: Date.now(), updated: Date.now(), status: 'idle', archived: false, items: [], routes: [], usage: null,
    };
    this.data.sessions.unshift(session); this.save(); this.changed(); return session;
  }

  permissions(id, access) {
    accessMode(access);
    const session = this.session(id);
    if (this.busy === id) throw new Error('Stop the current turn before changing permissions.');
    if (this.loading.has(id)) throw new Error('Wait for the session to finish loading before changing permissions.');
    if (this.agents && !this.executionContext && !session.group && !session.archived && this.agents.conversation(this) === session)
      return this.agents.settings({ access }, this.agentId);
    if (session.access !== access) this.sessionAllows.delete(session.id); // an access change starts approvals fresh
    session.access = access;
    this.save(); this.changed(); return this.snapshot();
  }

  rename(id, title) {
    if (typeof title !== 'string' || !title.trim()) throw new Error('Enter a session name.');
    this.session(id).title = title.trim().slice(0, 120); this.save(); this.changed();
  }

  archive(id) {
    if (this.agents?.routines && Object.values(this.agents.routines.records).some(routine => routine.ownerId === id)) throw new Error('Ask to remove this chat’s routines before archiving it.');
    if (this.agents?.pendingDelegations(id)) throw new Error('Stop this chat’s outstanding work before archiving it.');
    if (this.session(id).delegation?.state === 'queued') throw new Error('Stop this queued agent task before hiding it.');
    if (this.busy === id) throw new Error('Stop this session before hiding it.');
    this.session(id).archived = true; this.save(); this.changed();
  }

  deleteSession(id) {
    const session = this.session(id);
    if (this.agents?.routines && Object.values(this.agents.routines.records).some(routine => routine.ownerId === id)) throw new Error('Ask to remove this chat’s routines before deleting it.');
    if (this.agents?.pendingDelegations(id) || this.agents?.pendingJobs().some(({ job }) => job.source === id || job.owner === id))
      throw new Error('Stop this chat’s outstanding work before deleting it.');
    if (session.delegation?.state === 'queued') throw new Error('Stop this queued agent task before deleting it.');
    if (this.busy === id || this.activeTurns.has(id) || session.status === 'running') throw new Error('Stop this session before deleting it.');
    if (this.loading.has(id)) throw new Error('Wait for the session to finish loading before deleting it.');
    if (session.threadId && [...this.requests.values()].some(request => request.params.threadId === session.threadId))
      throw new Error('Resolve this session\'s pending request before deleting it.');
    const previous = this.data.sessions;
    this.data.sessions = previous.filter(s => s.id !== id);
    this.sessionAllows.delete(id);
    try { this.save(); }
    catch (error) { this.data.sessions = previous; throw error; }
    this.loaded.delete(id); this.stopping.delete(id);
    this.toolHelpers.remove(id);
    this.changed(); return this.snapshot();
  }

  preview(id, text, mode) {
    if (this.planPreset()) return this.planPreset();
    const choice = mode || this.data.settings.mode;
    return choice === 'auto' ? route(text) : this.resolveWorker(choice) || route(text, choice);
  }

  resume(session, choice) {
    this.applyFeaturePolicy(session);
    if (choice && session.activeProvider !== (choice.provider || 'codex')) this.loaded.delete(session.id);
    if (this.loadedInstructions.get(session.id) !== this.workerInstructions(session)) this.loaded.delete(session.id);
    if (this.loaded.has(session.id)) return Promise.resolve();
    if (this.loading.has(session.id)) return this.loading.get(session.id);
    const pending = this.loadThread(session, choice).finally(() => this.loading.delete(session.id));
    this.loading.set(session.id, pending);
    return pending;
  }

  async loadThread(session, choice) {
    choice ||= [...session.routes].reverse().find(r => !r.directAnswer) || PRESETS[0];
    const providerConfig = this.providers?.config(choice) || { config: {} };
    const permissions = accessMode(session.access);
    const contextEnabled = session.threadId ? session.contextTool : !!this.contextSearch?.supports(session.workspace);
    const helpersEnabled = session.threadId ? session.helperTools : true;
    const workerInstructions = this.workerInstructions(session);
    const agentHelpers = (this.agents || this.connectors) && this.bridge.base ? this.bridge.childConfig(session.id) : null;
    const params = {
      ...providerConfig, model: choice.model,
      cwd: this.workspace(session.workspace), approvalPolicy: permissions.approvalPolicy, approvalsReviewer: 'user',
      sandbox: permissions.id, serviceTier: 'default',
      config: {
        tool_output_token_limit: 4000, model_verbosity: 'low', ...providerConfig.config,
        project_doc_max_bytes: 0,
        ...agentHelpers?.codexConfig,
        ...(session.featurePolicy === 'tracked' ? { 'features.goals': false } : {}),
        ...(this.agents || session.featurePolicy === 'tracked' ? { 'features.multi_agent': false } : {}),
      },
      developerInstructions: workerInstructions + (this.connectors ? CONNECTOR_INSTRUCTIONS : '') + (contextEnabled ? CONTEXT_INSTRUCTIONS : '') + (helpersEnabled ? HELPER_INSTRUCTIONS +
        ` Jev tool recommendations are ${this.data.settings.toolSelection === 'jev' ? 'enabled' : 'disabled (discovery uses local ranking)'}. Large-response capture is ${this.data.settings.largeResponses ? 'enabled' : 'disabled'}.` : ''),
    };
    if (session.threadId) {
      await this.client.call('thread/unsubscribe', { threadId: session.threadId });
      await this.client.call('thread/resume', { ...params, threadId: session.threadId, excludeTurns: true });
      await this.client.call('thread/inject_items', { threadId: session.threadId, items: [{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: workerInstructions }] }] });
      const items = [];
      let cursor = null;
      do {
        let page;
        try { page = await this.client.call('thread/items/list', { threadId: session.threadId, cursor, limit: 100, sortDirection: 'asc' }); }
        catch (error) { if (/not supported/i.test(error.message)) break; throw error; }
        items.push(...page.data.map(entry => ({ ...entry.item, turnId: entry.turnId, routeLabel: session.routes.find(r => r.turnId === entry.turnId)?.label })));
        cursor = page.nextCursor;
      } while (cursor);
      if (items.length) {
        for (const item of items) {
          const saved = session.items.find(saved => saved.id === item.id || (item.clientId && saved.clientId === item.clientId));
          item.createdAt ??= saved?.createdAt;
          if (item.type === 'userMessage' && saved?.clientId) {
            item.content = saved.content;
            item.fileMessage = saved.fileMessage;
            item.clientId = saved.clientId;
            item.routeLabel = saved.routeLabel;
            if (saved.agentReply) item.agentReply = true;
          }
        }
        // Native compaction must not discard attachment snapshots or local receipts.
        const previous = session.items;
        const local = new Set(previous.filter(item => item.localOnly || item.fileMessage));
        for (let i = previous.length - 1; i >= 0; i--) if (local.has(previous[i])) {
          if (previous[i].fileMessage && items.some(item => item.type === 'userMessage' &&
              (item.id === previous[i].id || (item.clientId && item.clientId === previous[i].clientId)))) continue;
          const next = previous.slice(i + 1).find(item => items.some(remote => remote.id === item.id));
          const index = next ? items.findIndex(item => item.id === next.id) : items.length;
          items.splice(index, 0, previous[i]);
        }
        session.items = items.filter(item => this.visible(item) || local.has(item));
      }
    } else {
      const started = await this.client.call('thread/start', {
        ...params,
        model: this.planPreset()?.model || choice.model || 'gpt-5.6-sol',
        dynamicTools: [...(contextEnabled ? [CONTEXT_TOOL] : []), ...HELPER_TOOLS],
      });
      session.threadId = started.thread.id;
      session.contextTool = contextEnabled;
      session.helperTools = true;
      this.save();
    }
    session.activeProvider = choice.provider || 'codex';
    this.loadedModelConfigs.set(session.id, JSON.stringify(providerConfig));
    this.loadedInstructions.set(session.id, workerInstructions);
    this.loaded.add(session.id);
  }

  async load(id) {
    if (this.isCoordinator()) return this.snapshot();
    const session = this.session(id);
    if (isCLI(session.activeProvider)) return this.snapshot();
    if (this.connection === 'ready' && session.threadId && !this.loaded.has(id)) {
      await this.resume(session); this.changed();
    }
    return this.snapshot();
  }

  async send({ id, text, mode, images = [], files = [], fileMessage = null, task = 'on', wikiTaskId = null, failover = false, agentReply = false, agentReplyCancelled = false, agentResult = null, agentMail = null, routineRun = null }) {
    if (!['auto', 'on', 'off'].includes(task)) throw new Error('Invalid task mode.');
    if (task === 'auto') task = 'on'; // Existing queued messages use the new default.
    if (this.blockedReason()) throw new Error(this.blockedReason());
    if (this.connection !== 'ready') throw new Error(this.error || 'Codex is still connecting.');
    if (!Array.isArray(images) || images.length > 4 || images.some(url => typeof url !== 'string' || !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(url)) || images.reduce((n, url) => n + url.length, 0) > 12 * 1024 * 1024) throw new Error('Invalid images: attach up to four PNG or JPEG images under 8 MB total.');
    if (typeof text !== 'string') throw new Error('Enter a message.');
    const attached = prepareFiles(text, files);
    if (attached.fileMessage) { text = attached.text; fileMessage = attached.fileMessage; }
    if (files.length + images.length > 4) throw new Error('Attach up to four files or images.');
    if ((!text.trim() && !images.length) || text.length > 200000) throw new Error('Enter a message under 200,000 characters or attach a file.');
    if (!text.trim()) text = 'Analyze the attached image(s). Explain what you see and any relevant issue; ask for clarification if the intended task is unclear.';
    const session = this.session(id);
    let wikiWorker;
    if (session.archived) throw new Error('This conversation is archived. Start a new conversation to continue.');
    if (wikiTaskId) {
      const origin = (session.tasks || []).find(t => t.id === wikiTaskId);
      if (!canProposeWiki(origin) || (!this.wikiStore && !hasProjectWiki(session.workspace))) throw new Error('This task is not eligible for a wiki proposal.');
      wikiWorker = this.resolveWorker(origin.route?.id);
      const plan = this.planPreset();
      if (!wikiWorker || !this.available(wikiWorker) || wikiWorker.provider !== origin.route.provider || wikiWorker.model !== origin.route.model || !sameEffort(wikiWorker, origin.route) ||
          (plan && (plan.model !== wikiWorker.model || plan.effort !== wikiWorker.effort))) throw new Error('The original task worker is unavailable. No replacement model was selected.');
      mode = wikiWorker.id;
      task = 'off';
    }
    if (this.busy) {
      if (this.busy !== id && !(this.isCoordinator() && (session.group || this.session(this.busy).group))) {
        throw new Error('Another turn is running. Switch to that session to queue a message.');
      }
      if ((session.queue?.length || 0) >= 10) throw new Error('The queue is full (10 messages).');
      session.queuePaused = false;
      (session.queue ||= []).push({ id: randomUUID(), text, images, mode: mode || this.data.settings.mode, task, agentReply, agentReplyCancelled,
        ...(fileMessage ? { fileMessage } : {}),
        ...(session.delegation && !session.delegation.delivered ? { assignmentRevision: session.delegation.revision || 1 } : {}),
        ...(agentResult ? { agentResult } : {}), ...(agentMail ? { agentMail } : {}), ...(wikiTaskId ? { wikiTaskId } : {}),
        ...(routineRun ? { routineRun } : {}) });
      this.save(); this.changed();
      this.flushLiveQueue(session);
      return { queued: true };
    }
    session.queuePaused = false;
    session.activeTaskId = null;
    const chosenMode = mode || this.data.settings.mode;
    session.agentReplyCancelledActive = agentReplyCancelled === true;
    session.routineRunActive = routineRun?.occurrenceId || null;
    // Only a message the user sent counts as their own turn; results, mail, routine runs and wiki proposals do not.
    session.userTurn = !agentReply && !routineRun && !wikiTaskId;
    session.replyBudgetId = agentReply ? this.agents?.budgets.forMessage(session, { agentResult, agentMail })?.id || null : null;
    // The user's message is their reaction to the exchange before it, which the chat scanner reads in the background. A
    // failover re-send is the same message again, not a reaction.
    if (session.userTurn && !failover)
      this.scanAfterUserTurn(session, text);
    if (this.isCoordinator()) return this.sendCoordinator(session, { text, images, fileMessage, mode: chosenMode, agentReply, agentReplyCancelled, agentResult, agentMail, routineRun });
    const originalRequest = session.delegation && this.agents?.executionText(session.delegation) === text
      ? this.agents.requestFor(session.delegation) : null;
    const routingText = originalRequest?.text || text;
    let selected = wikiWorker ? { ...wikiWorker, wikiTaskId, source: 'manual', reason: 'Wiki proposal using the original task worker.' }
      : this.planPreset() || (chosenMode === 'auto' ? route(routingText) : { ...this.resolveWorker(chosenMode), source: 'manual', reason: 'Your manual selection.' });
    if (chosenMode !== 'auto' && !selected?.model) throw new Error('Unknown model selection.');
    if (this.planPreset() && !this.models.some(m => m.model === selected.model && m.supportedReasoningEfforts.some(e => e.reasoningEffort === selected.effort)))
      throw new Error('Terra light is not currently available on your account. Refresh your Codex login or restart the app.');
    const provider = this.routingProvider;
    const useSmart = !this.planPreset() && chosenMode === 'auto';
    const previousState = { status: session.status, error: session.error };
    this.busy = id; session.status = 'running'; session.error = null; session.turnId = null;
    session.agentReplyActive = agentReply === true;
    if (!agentReply && !failover) { session.agentDelegations = 0; session.agentMessages = 0; }
    const clientId = randomUUID();
    // Only an Auto message may be re-sent to another provider when its provider hits a usage limit, and only once.
    this.lastSends.delete(id);
    if (useSmart && !wikiTaskId) this.lastSends.set(id, { clientId, text, images, task, failover: failover === true,
      ...(fileMessage ? { fileMessage } : {}), ...(agentReply ? { agentReply: true } : {}), ...(routineRun ? { routineRun } : {}) });
    session.pendingMessage = {
      id: clientId, clientId, type: 'userMessage', pending: true, createdAt: Date.now(),
      requestedMode: chosenMode,
      ...(fileMessage ? { fileMessage } : {}),
      ...(agentReply ? { agentReply: true } : {}),
      ...(routineRun ? { routineRun } : {}),
      content: [{ type: 'text', text }, ...images.map(url => ({ type: 'image', url }))]
    };
    this.changed();
    try {
      if (this.agents) this.openTask(session, null, text, clientId, task);
      if (this.agents) {
        const refusal = await this.agents.acquire(this, session);
        if (refusal) throw new Error(refusal.blocked || 'Turn was stopped before sending.');
      }
      if (this.stopping.has(id)) throw new Error('Turn was stopped before sending.');

      this.markAdmitted(session);

      if (useSmart) {
        let router = this.effectiveRouter();
        const smartReady = () => !!router && this.available(router);
        if (provider === 'smart' && !smartReady()) throw new Error('The selected router model is disabled or unavailable. Choose an enabled router in Settings.');
        this.routing = id; this.changed();
        // Only workers within the effort cap are offered, so Smart, Jev, escalation and failover all choose within it.
        // Workers of a provider at its usage limit are left out while another provider can take the message.
        const usable = capCatalog(this.catalog().filter(p => p.worker && this.available(p) && (!images.length || p.images)), this.data.settings.effortCap);
        const routingCatalog = () => {
          const unlimited = usable.filter(p => !this.limits.limited(p.provider || 'codex', p.model));
          return unlimited.length ? unlimited : usable;
        };
        const context = { ...session, ...previousState, configuredChecks: this.data.settings.checks?.[session.workspace] || [], routingCatalog: routingCatalog(), routerChoice: router, jevQuickAnswers: this.data.settings.jevQuickAnswers, attachedImageCount: images.length,
          // The presets this project's checks proved per kind of work (src/setups.cjs).
          provenSetups: this.provenSetupsFor(session.workspace) };
        // A fresh delegation is not forced onto the model of an older, possibly misinterpreted task.
        if (originalRequest && session.job?.originalRequestId !== originalRequest.id) context.job = null;
        const smart = async () => {
          try { return await this.smartRouter.choose(routingText, { ...context, routerChoice: router }, this.models, 'smart', router?.id); }
          catch (error) {
            // The router's own provider hit its usage limit: record it and route once with another provider's router.
            if (!error.limit || error.name === 'AbortError' || this.stopping.has(id)) throw error;
            if ((session.delegation && !session.delegation.delivered) || agentReply || this.agents?.budgets.forSession(session)) {
              this.providerOutcome(session, error.limitProvider, null, clientId, { status: 'failed', limit: error.limit });
              throw error;
            }
            this.limits.mark(error.limitProvider, error.limit);
            const next = this.effectiveRouter();
            if (!next || next.id === router?.id || !this.available(next)) throw error;
            router = next;
            return this.smartRouter.choose(routingText, { ...context, routingCatalog: routingCatalog(), routerChoice: router }, this.models, 'smart', router.id);
          }
        };
        try {
          try { selected = provider === 'jev' ? await this.smartRouter.choose(routingText, context, this.models, provider, router?.id) : await smart(); }
          catch (error) {
            // Jev unavailable (down, timeout, key removed): route the same message with the smart router instead of failing.
            // A stop is never retried, and without a usable smart router the Jev error stands.
            if (provider !== 'jev' || error.name === 'AbortError' || this.stopping.has(id) || !smartReady()) throw error;
            if (error.limit && ((session.delegation && !session.delegation.delivered) || agentReply || this.agents?.budgets.forSession(session))) {
              this.providerOutcome(session, error.limitProvider || 'jev', null, clientId, { status: 'failed', limit: error.limit });
              throw error;
            }
            selected = await smart();
            const note = `Jev was unavailable (${String(error.message).slice(0, 160)}); the smart router chose instead.`;
            selected = { ...selected, routerFallback: note, reason: selected.reason ? `${note} ${selected.reason}` : note };
          }
        } finally { this.routing = null; this.warmRouter(); }
        selected = { ...selected, effortCap: this.data.settings.effortCap };
        if (this.stopping.has(id)) throw new Error('Turn was stopped before sending.');
      }
      if (selected.directAnswer) {
        const tracked = (session.tasks || []).find(task => task.messageId === clientId);
        if (tracked) {
          tracked.state = 'not-checked'; tracked.checksSkippedByRouter = tracked.checks.length > 0;
          tracked.checks = Object.freeze([]); tracked.summary = summaryLine(tracked);
        }
        if (!session.items.some(i => i.type === 'userMessage')) session.title = text.trim().replace(/\s+/g, ' ').slice(0, 65);
        session.items.push({ ...session.pendingMessage, pending: false, localOnly: true },
          { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: selected.directAnswer, routeLabel: 'Jev · quick answer', localOnly: true, createdAt: Date.now() });
        (session.directContext ||= []).push({ question: text, answer: selected.directAnswer });
        session.routes.push({ ...selected, label: 'Jev quick answer', at: Date.now(), messageId: clientId });
        session.pendingMessage = null; session.status = 'completed'; session.updated = Date.now(); session.activeTaskId = null; this.busy = null;
        this.save(); this.changed(); this.settle(session);
        return selected;
      }
      if (!this.available(selected)) throw new Error('Selected model is disabled or not available.');
      if (images.length && selected.images === false) throw new Error('Enable image support for this model before sending images.');
      if (!failover && !this.planPreset()) this.compareWithJev(session, routingText, images, selected, previousState);
      if (failover) selected = { ...selected, failover: true }; // recorded on the route for the decision trace
      // One model per task: whether this message continues the current task (the router's sameTask; a manual pick
      // continues a task its worker reported as pending or waiting for input). The turn's end then updates the task
      // or starts a new one (updateJob).
      if (!wikiTaskId) session.jobDecision = { messageId: clientId, goal: routingText, ...(originalRequest ? { originalRequestId: originalRequest.id } : {}),
        continues: (!originalRequest || session.job?.originalRequestId === originalRequest.id) && (selected.sameTask === true || (selected.sameTask === undefined && ['pending', 'needs-input'].includes(session.job?.status))) };
      const tracked = this.openTask(session, selected, text, clientId, task);
      return await this.submitWorker(session, selected, text, images, clientId, tracked);
    } catch (error) {
      if (error.turnFailed) throw error;
      await this.failSend(session, null, clientId, error, (session.tasks || []).find(item => item.messageId === clientId && !FINAL.has(item.state)));
    }
  }

  async submitWorker(session, selected, text, images, clientId, task) {
    const id = session.id;
    const permissions = accessMode(session.agentReplyCancelledActive ? 'read-only' : task?.access || session.access);
    let submission = null;
    try {
      // A worker's cleanup still running (Cursor's ends every turn) delays the next call; only an unconfirmed one refuses
      // it, and a Stop pressed meanwhile means nothing starts.
      let refusal = this.readyToStart(session);
      if (refusal?.then) refusal = await refusal; // awaited only when it waited, so timing is unchanged otherwise
      if (refusal) throw new Error(refusal.blocked || 'Turn was stopped before sending.');
      if (this.agents) {
        const admission = await this.agents.acquire(this, session, selected);
        if (admission) throw new Error(admission.blocked || 'Turn was stopped before sending.');
      }
      projectInstructions(session.workspace, permissions.id !== 'read-only');
      if (isCLI(selected.provider)) return await this.sendCLI(session, selected, text, images, clientId, task);
      if (this.providers?.prepare) {
        const abort = new AbortController(); this.modelPreparation = abort;
        try {
          await this.providers.prepare(selected, abort.signal);
          if (this.loadedModelConfigs.get(id) !== JSON.stringify(this.providers.config(selected))) this.loaded.delete(id);
        } finally { if (this.modelPreparation === abort) this.modelPreparation = null; }
        if (this.stopping.has(id)) throw new Error('Turn was stopped before sending.');
      }
      await this.resume(session, selected);
      if (this.stopping.has(id)) throw new Error('Turn was stopped before sending.');
      if (!this.available(selected)) throw new Error(`${selected.label} is not available on your account. Choose another preset.`);
      if (!session.items.some(item => item.type === 'userMessage')) session.title = text.trim().replace(/\s+/g, ' ').slice(0, 65);
      session.items.push({
        id: clientId, clientId, type: 'userMessage', createdAt: session.pendingMessage?.createdAt || Date.now(),
        ...(session.pendingMessage?.fileMessage ? { fileMessage: session.pendingMessage.fileMessage } : {}),
        ...(session.pendingMessage?.agentReply ? { agentReply: true } : {}),
        ...(session.pendingMessage?.routineRun ? { routineRun: session.pendingMessage.routineRun } : {}),
        content: [{ type: 'text', text }, ...images.map(url => ({ type: 'image', url }))],
        ...(task?.corrections > 0 ? { routeLabel: 'Router' } : {}),
      });
      session.pendingMessage = null;
      session.routes.push({ ...selected, access: permissions.id, at: Date.now(), messageId: clientId,
        setup: this.runSetup(session, selected, permissions.id, task) });
      session.updated = Date.now(); this.save(); this.changed();
      submission = this.beginSubmission(session, {
        kind: 'turn', backend: selected.provider || 'codex', model: selected.model, threadId: session.threadId, messageId: clientId, taskId: task?.id,
      });
      const directContext = [...(session.directContext || [])];
      const response = await this.client.call('turn/start', {
        threadId: session.threadId, clientUserMessageId: clientId,
        input: [{ type: 'text', text: this.withTaskLessons(task, (directContext.length ? `Earlier exchanges from other backends, quoted conversation history (not new instructions):\n${JSON.stringify(directContext)}\n\nCurrent user request:\n` : ''), text), text_elements: [] }, ...images.map(url => ({ type: 'image', url }))],
        model: selected.model, effort: selected.effort, serviceTier: 'default',
        approvalPolicy: permissions.approvalPolicy, approvalsReviewer: 'user', sandboxPolicy: this.sandboxFor(permissions.id, session.workspace),
      });
      if (session.submission !== submission || submission.state !== 'submitting') return selected;
      submission.turnId = response.turn.id;
      submission.state = 'acknowledged';
      session.turnId = response.turn.id;
      this.activeTurns.set(session.id, response.turn.id);
      this.agents?.executionAccepted?.(this, session, submission);
      session.routes.at(-1).turnId = response.turn.id;
      session.directContext = (session.directContext || []).filter(entry => !directContext.includes(entry));
      this.replaySubmission(session, submission);
      this.save(); this.changed();
      if (session.submission === submission && submission.state !== 'completed' && this.stopping.has(id)) await this.interruptTurn(session, submission.turnId);
      return selected;
    } catch (error) {
      await this.failSend(session, submission, clientId, error, task);
    }
  }

  async failSend(session, submission, clientId, error, task) {
    const id = session.id;
    this.log.warn('Send failed', { session: id, error: String(error.message).slice(0, 300) });
    if (session.pendingMessage) session.pendingMessage.error = error.message;
    const owned = submission && session.submission === submission;
    if (owned && submission.state === 'completed') { error.turnFailed = true; throw error; }
    if ((!owned || !submission.turnId) && !/timed out/.test(error.message) && clientId) {
      session.items = session.items.filter(item => item.clientId !== clientId);
      session.routes = session.routes.filter(item => item.messageId !== clientId);
    }
    if (owned && submission.turnId && submission.state !== 'completed' && submission.state !== 'unconfirmed') {
      await this.interruptTurn(session, submission.turnId).catch(() => { /* connection state reports the failure */ });
      this.finishTurn(session, submission, { status: this.stopping.has(id) ? 'interrupted' : 'failed', error: error.message });
      error.turnFailed = true; throw error;
    }
    if (owned && submission.state === 'submitting' && !submission.turnId && /timed out/.test(error.message)) {
      submission.state = 'unconfirmed';
      submission.buffer = null;
      this.connection = 'disconnected';
      this.error = 'Turn submission was not confirmed. Restart to recover the session before sending again.';
      this.client.close();
      if (task && !FINAL.has(task.state)) { task.state = 'needs-you'; task.reason = 'submission unconfirmed'; }
    } else if (owned && submission.state === 'submitting') {
      submission.buffer = null;
      session.submission = null;
      // Rejected before a turn existed: no model usage, and the budget must not keep it in flight.
      this.agents?.budgets.report(submission.budget, { usage: { inputTokens: 0, outputTokens: 0 } }, true);
      if (task && !FINAL.has(task.state)) { task.state = 'needs-you'; task.reason = 'submission rejected'; }
    } else if (task && !FINAL.has(task.state) && !this.gate) {
      task.state = 'needs-you';
      task.reason = 'submission rejected';
    }
    session.status = this.stopping.has(id) ? 'interrupted' : 'failed'; session.error = error.message;
    this.stopping.delete(id);
    if (task && FINAL.has(task.state)) task.summary = summaryLine(task);
    if (this.busy === id && !this.gate) this.busy = null;
    if (!this.gate) session.activeTaskId = null;
    this.changed();
    this.settle(session);
    error.turnFailed = true;
    throw error;
  }

  // A new tracked task's first worker message carries the project's relevant lessons; the visible message and
  // the worker instructions stay unchanged. Without lessons this is `context + text`, exactly as before.
  withTaskLessons(task, context, text) {
    const lessons = task?.lessonBlock && !task.corrections && !task.attempts?.length ? task.lessonBlock + '\n\n' : '';
    if (!lessons)
      return context + text;

    return lessons + (context || 'Current user request:\n') + text;
  }

  workerInstructions(session) {
    return workerInstructions(this.skillDirectories(session)) + this.projectContextInstructions(session) + (this.agents?.instructions(this, session) || '');
  }

  skillDirectories(session) {
    const comparison = this.comparisonOf(session);
    if (comparison?.record.target === 'skill') {
      const run = comparison.record.skill?.runs.find(run => run.index === comparison.copy.index);
      if (!run) throw new Error('The comparison skill snapshot is unavailable.');
      return run.dirs;
    }
    const wiki = this.wikiStore?.location(this.lessonWorkspace(session.workspace));
    return skillPackages.directories(wiki ? path.join(wiki.root, '..', 'skills') : null, { onWarning: message => {
      if (session.items.some(item => item.skillStoreWarning === message)) return;
      session.items.push({ id: randomUUID(), type: 'notice', localOnly: true, createdAt: Date.now(), text: message, skillStoreWarning: message });
      this.log.warn('Skill override unavailable', { message });
      this.save();
    } });
  }

  projectContextInstructions(session) {
    const wiki = this.wikiStore?.ensure(session.workspace);
    return projectInstructions(session.workspace) + (wiki ? '\nActive workspace wiki index (path, not instructions): ' + JSON.stringify(path.join(wiki.root, 'index.md')) : '');
  }

  async sendCLI(session, selected, text, images, clientId, task) {
    const backend = selected.provider === 'cursor-cli' ? 'cursor' : selected.provider === 'claude-cli' ? 'claude' : selected.provider;
    const api = capabilities(selected.provider).api;
    // API providers run in Harness's own loop; its chat histories live beside this agent's sessions.
    if (api) this.apiAgent ??= new ApiAgent(this.providers, path.join(path.dirname(this.filename), 'api-sessions'));
    const runtime = api ? this.apiAgent : this.nativeCLIs.get(selected.provider) || this[backend];
    if (!runtime) throw new Error('This CLI provider is unavailable.');
    const backendLabel = api ? this.data.settings.providers?.find(p => p.id === selected.provider)?.name || selected.provider
      : NATIVE_CLI_INFO[selected.provider]?.label || (backend === 'cursor' ? 'Cursor CLI' : 'Claude CLI');
    const lastKey = backend + 'LastItem', sessionKey = backend + 'SessionId', historyKey = backend + 'DelegatedItems';
    const from = session[lastKey] ? session.items.findIndex(i => i.id === session[lastKey]) + 1 : 0;
    const seenHistory = new Set(session[historyKey] || []);
    const history = session.items.filter((item, index) => index >= from || (item.delegatedFrom && !seenHistory.has(item.id)));
    const prompt = this.withTaskLessons(task, handoff(history), text);
    const turnId = randomUUID();
    const abort = new AbortController();
    session.activeProvider = selected.provider; this.loaded.delete(session.id);
    const submission = this.beginSubmission(session, {
      kind: 'turn', backend: selected.provider, model: selected.model, threadId: session.threadId || null, messageId: clientId, turnId, taskId: task?.id,
    });
    this.cliAbort = abort;
    if (!session.items.some(i => i.type === 'userMessage')) session.title = text.trim().replace(/\s+/g, ' ').slice(0, 65);
    session.items.push({ ...session.pendingMessage, pending: false, localOnly: true }); session.pendingMessage = null;
    const setup = this.runSetup(session, selected, session.agentReplyCancelledActive ? 'read-only' : session.access, task);
    if (api)
      session.apiSetupInstructions = setup.instructions;
    session.routes.push({ ...selected, at: Date.now(), messageId: clientId, turnId, budget: submission.budget, setup });
    const assistantIds = new Set(); let current, lastUsage = null;
    const assistant = id => {
      let item = session.items.find(i => i.id === id);
      if (!item) { item = { id, turnId, type: 'agentMessage', text: '', phase: 'final_answer', routeLabel: selected.label, localOnly: true, createdAt: Date.now() }; session.items.push(item); }
      assistantIds.add(id); return item;
    };
    this.save(); this.changed();
    let outcome = { status: 'completed', error: null }, turnOver = false;
    try {
      const helpersEnabled = session.helperTools !== false;
      const contextEnabled = helpersEnabled && !!this.contextSearch?.supports(session.workspace);
      if (helpersEnabled) {
        session.helperTools = true;
        if (contextEnabled) session.contextTool = true;
      }
      const helpers = (helpersEnabled || this.connectors) && this.bridge.base ? this.bridge.childConfig(session.id) : null;
      const bridge = api ? { tools: [...AGENT_TOOLS, ...CONNECTOR_TOOLS, HELPER_TOOLS.find(tool => tool.name === 'router_read_output'), ...(contextEnabled ? [CONTEXT_TOOL] : [])],
        call: (name, args, signal) => this.bridgeTool(session.id, name, args, signal) } : undefined;
      const result = await runtime.run({
        provider: selected.provider, bridge,
        ...(capabilities(selected.provider).liveQueue || capabilities(selected.provider).liveSteer ? { onInput: input => {
          if (session.submission !== submission) return;
          this.liveInput = input;
          this.liveInputCaps = capabilities(selected.provider);
          this.liveInputMode = session.items.find(item => item.clientId === clientId)?.requestedMode;
          if (input) setImmediate(() => this.flushLiveQueue(session));
        } } : {}),
        cwd: this.workspace(session.workspace), model: selected.model, effort: selected.effort || null, effortOption: selected.effortOption, parameterized: selected.parameterized, parameters: selected.parameters,
        prompt, images, instructions: this.workerInstructions(session) + (this.connectors ? CONNECTOR_INSTRUCTIONS : ''), managedInstructions: true,
        resume: session[sessionKey], access: session.agentReplyCancelledActive ? 'read-only' : session.access, signal: abort.signal, helpers,
        approve: (tool, options = {}) => new Promise(resolve => {
          if (abort.signal.aborted || turnOver || options.signal?.aborted) return resolve(false);
          const allowKey = sessionAllowKey(tool);
          if (allowKey && this.sessionAllows.get(session.id)?.has(allowKey)) return resolve(true);
          const id = 'cli-' + randomUUID();
          this.helperApprovals.set(id, resolve);
          if (allowKey) this.approvalKeys.set(id, { sessionId: session.id, key: allowKey });
          // The CLI withdrew this request (or its process ended): drop the prompt.
          options.signal?.addEventListener('abort', () => {
            if (this.helperApprovals.get(id) !== resolve) return;
            this.helperApprovals.delete(id); this.approvalKeys.delete(id); this.requests.delete(id); resolve(false); this.changed();
          }, { once: true });
          this.requests.set(id, {
            id, method: 'router/tool/requestApproval', taskId: session.activeTaskId,
            budgetId: this.agents?.budgets.forSession(session)?.id || null, params: {
              threadId: session.threadId,
              reason: tool?.title || `Allow ${backendLabel} tool once?`, command: JSON.stringify(tool?.rawInput || tool || {}, null, 2)
            }
          });
          this.changed();
        }),
        onEvent: event => {
          if (session.submission !== submission || submission.state === 'completed') return;
          if (event.type === 'assistant' || (event.type === 'stream_event' && event.event?.type === 'message_start')) this.agents?.executionAccepted?.(this, session, submission);
          if (event.session_id) session[sessionKey] = event.session_id;
          if (event.type === 'stream_event') {
            const e = event.event;
            if (e.type === 'message_start') current = e.message.id;
            if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') assistant(current || `${turnId}-answer`).text += e.delta.text;
          }
          if (event.type === 'assistant') {
            const u = event.message?.usage;
            if (u) lastUsage = { inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), cachedInputTokens: u.cache_read_input_tokens || 0, outputTokens: u.output_tokens || 0 };
            const content = event.message?.content || [];
            const body = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
            if (body) assistant(event.message.id || current || `${turnId}-answer`).text = body;
            for (const tool of content.filter(c => c.type === 'tool_use')) {
              if (!session.items.some(i => i.id === tool.id)) session.items.push({
                id: tool.id, type: 'mcpToolCall', server: backendLabel, tool: tool.name,
                arguments: tool.input, status: 'inProgress', localOnly: true, createdAt: Date.now()
              });
            }
          }
          if (event.type === 'user') for (const output of event.message?.content || []) {
            const item = session.items.find(i => i.id === output.tool_use_id);
            if (item) { item.status = output.is_error ? 'failed' : 'completed'; item.result = output.content; }
          }
          this.changed();
        }
      });
      this.agents?.executionAccepted?.(this, session, submission);
      if (!assistantIds.size && result.result) assistant(`${turnId}-answer`).text = result.result;
      const usage = result.usage || {};
      const reported = result.usage && typeof result.usage === 'object' && ['input_tokens', 'output_tokens'].some(key => Number.isFinite(result.usage[key]));
      const total = session.usage?.total || {};
      // The context window of the model that did the most input work (background helper models are smaller).
      const main = Object.values(result.modelUsage || {}).filter(m => Number.isFinite(m?.contextWindow))
        .sort((a, b) => ((b.inputTokens || 0) + (b.cacheReadInputTokens || 0)) - ((a.inputTokens || 0) + (a.cacheReadInputTokens || 0)))[0];
      session.usage = reported || lastUsage ? {
        total: {
          inputTokens: (total.inputTokens || 0) + (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
          cachedInputTokens: (total.cachedInputTokens || 0) + (usage.cache_read_input_tokens || 0), outputTokens: (total.outputTokens || 0) + (usage.output_tokens || 0)
        },
        ...(lastUsage ? { last: { ...lastUsage, totalTokens: lastUsage.inputTokens + lastUsage.outputTokens } } : {}),
        ...(main ? { modelContextWindow: main.contextWindow } : {}),
        ...(session.usage?.incomplete ? { incomplete: true } : {}),
        ...(result.cacheUsageUnknown || session.usage?.cacheUnknown ? { cacheUnknown: true } : {}),
      } : { ...session.usage, incomplete: true };
      // The whole turn (every model call in it), for the decision trace; `last` above is only its final call.
      // A provider that reports no usage (Cursor) keeps it unknown, never zero.
      const route = session.routes.find(item => item.messageId === clientId);
      if (route) route.budgetFinalUsage = result.usage ?? null;
      if (route && Number.isFinite(result.total_cost_usd) && result.total_cost_usd >= 0)
        route.providerEstimateUsd = result.total_cost_usd;
      if (route && reported) route.turnUsage = { inputTokens: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
        cachedInputTokens: usage.cache_read_input_tokens || 0, outputTokens: usage.output_tokens || 0 };
      if (result.permission_denials?.length) outcome.error = 'Some Claude tool calls were declined or not permitted under the selected access. Review the response before changing access.';
    } catch (error) { outcome = { status: abort.signal.aborted ? 'interrupted' : 'failed', error: error.message, limit: abort.signal.aborted ? null : error.limit }; }
    finally {
      const answer = session.items.filter(i => assistantIds.has(i.id)).map(i => stripTaskStatus(i.text)).join('\n');
      (session.directContext ||= []).push({ question: text, answer: answer || `[${backend} turn ${outcome.status}]` });
      if (outcome.status === 'completed') {
        session[lastKey] = session.items.at(-1)?.id;
        session[historyKey] = [...new Set([...seenHistory, ...history.filter(item => item.delegatedFrom).map(item => item.id)])];
      }
      else { session[lastKey] = null; session[sessionKey] = null; }
      this.cliAbort = null; this.liveInput = null; this.liveInputCaps = null; turnOver = true;
      // An approval still open when the CLI turn ends can no longer be used.
      for (const [id, resolve] of this.helperApprovals) if (id.startsWith('cli-')) { resolve(false); this.requests.delete(id); this.helperApprovals.delete(id); this.approvalKeys.delete(id); }
      this.finishTurn(session, submission, outcome);
      this.providerOutcome(session, selected.provider, selected.model, clientId, outcome);
      this.save();
    }
    return selected;
  }

  canReceiveQueued(session, message) {
    return !message.agentReply || !session.delegation || session.delegation.delivered ||
      message.agentAssignmentId === undefined || message.agentAssignmentId === session.delegation.id;
  }

  assignmentCurrent(session) {
    const direct = (session?.tasks || []).find(task => task.id === session?.activeTaskId);
    if (direct && (direct.cancelled || this.agents?.budgets.held(direct))) return false;
    const job = session?.delegation, submission = session?.submission;
    return !job || job.delivered || (!job.cancelled && !this.agents?.budgets.held(job) && !['revising', 'revision-blocked'].includes(job.state) &&
      (!submission?.assignmentId || submission.assignmentId !== job.id || submission.assignmentRevision === (job.revision || 1)));
  }

  settle(session) {
    if (session)
      this.testPoolAfterTurn(session);

    if (!session || this.busy || this.blockedReason() || session.queueSending || this.connection !== 'ready' || session.queuePaused) return;
    setImmediate(() => {
      if (this.busy || this.blockedReason() || session.queueSending || this.connection !== 'ready' || session.queuePaused || !this.data.sessions.includes(session)) return;
      const next = session.queue?.find(message => !message.agentReply) ||
        session.queue?.find(message => this.canReceiveQueued(session, message));
      if (!next || next.error) return;
      if (next.agentReply && this.agents && !this.agents.canStartReply(this, session, next)) return;
      this.queuedMessage(session.id, next.id, 'send').catch(() => { });
    });
  }

  async queuedMessage(id, messageId, action) {
    const session = this.session(id);
    const message = session.queue?.find(m => m.id === messageId);
    if (!message || session.queueSending) throw new Error('This queued message is no longer available.');
    if (action === 'steer' && this.agents && !message.agentReply && !message.uncertain && session.delegation && !session.delegation.delivered) {
      return this.agents.revise(this, session, { jobId: session.delegation.id,
        expectedRevision: message.assignmentRevision || session.delegation.revision || 1, amendmentId: message.id, text: message.text }, message);
    }
    if (['send', 'steer', 'live'].includes(action) && !this.canReceiveQueued(session, message)) throw new Error('This message belongs to another assignment and waits for the current work to finish.');
    if (action === 'remove' || action === 'edit') {
      if (action === 'edit' && message.uncertain) throw new Error('Check the conversation before resending an unconfirmed message.');
      const previousQueue = session.queue;
      session.queue = session.queue.filter(m => m !== message);
      try { this.save(); } catch (error) { session.queue = previousQueue; throw error; }
      this.changed(); return action === 'edit' ? message : undefined;
    }
    if (!['send', 'steer', 'live'].includes(action)) throw new Error('Invalid queue action.');
    if (message.uncertain) throw new Error('Delivery was not confirmed. Check the conversation before removing this message.');
    const turnId = this.activeTurns.get(id);
    const activeTask = (session.tasks || []).find(item => !FINAL.has(item.state));
    if (action === 'steer' && activeTask?.state === 'checking') throw new Error('Checks are running. Stop the task before steering.');
    if (['steer', 'live'].includes(action) && (this.busy !== id ||
        (!turnId && capabilities(session.activeProvider).steer && !this.isCoordinator()) ||
        session.compacting || this.stopping.has(id))) throw new Error('Wait for an active turn before steering.');
    if (action === 'send' && this.busy) throw new Error('Wait for the active turn to finish.');
    if (action === 'send') session.queuePaused = false;
    if (action === 'live' && (!this.liveInput || session.delegation || message.agentReply || activeTask?.state === 'checking'))
      throw new Error('Live input is unavailable for this turn.');
    // Sending: the queue list hides it at once, though it stays queued until the provider takes it; a failure shows it again.
    message.sending = true;
    session.queueSending = true;
    try {
      this.save(); this.changed();
      if ((action === 'steer' || action === 'live') && this.liveInput && !this.isCoordinator() && !message.agentReply && !message.wikiTaskId && !message.routineRun) {
        this.lastSends.delete(session.id);
        // Send now applies within the turn where the provider can (liveSteer); otherwise it joins the provider's own queue.
        await this.liveInput(message, { steer: action === 'steer' && !!this.liveInputCaps?.liveSteer });
        this.recordLiveMessage(session, message, activeTask);
      } else if (action === 'steer' && session.activeProvider === 'claude-cli' && !this.isCoordinator()) {
        // Claude without live input is finishing its turn; a restart would drop its saved session. The message sends next.
        return;
      } else if (action === 'steer' && (!capabilities(session.activeProvider).steer || this.isCoordinator())) {
        await this.restartWithMessage(session, message, activeTask);
      } else if (action === 'steer') {
        await this.client.call('turn/steer', {
          threadId: session.threadId, expectedTurnId: turnId, clientUserMessageId: message.id,
          input: [{ type: 'text', text: message.text, text_elements: [] }, ...message.images.map(url => ({ type: 'image', url }))],
        });
        if (!session.items.some(i => i.clientId === message.id)) session.items.push({
          id: message.id, clientId: message.id, type: 'userMessage', createdAt: Date.now(),
          content: [{ type: 'text', text: message.text }, ...message.images.map(url => ({ type: 'image', url }))],
        });
        if (activeTask?.state === 'running') activeTask.amendments.push({ id: message.id, text: message.text });
      } else await this.send({ ...message, id });
      session.queue = session.queue.filter(m => m !== message);
    } catch (error) {
      message.error = error.message;
      message.uncertain = /timed out|closed|disconnect/i.test(error.message);
      throw error;
    } finally { delete message.sending; session.queueSending = false; this.save(); this.changed(); this.settle(session); this.flushLiveQueue(session); }
  }

  flushLiveQueue(session) {
    if (!this.liveInput || !this.liveInputCaps?.liveQueue || this.busy !== session.id || session.queueSending || session.queuePaused ||
        session.compacting || this.stopping.has(session.id) || session.delegation || this.isCoordinator()) return;
    const message = session.queue?.[0];
    if (!message || message.error || message.uncertain || message.agentReply || message.routineRun || message.wikiTaskId ||
        (message.mode && message.mode !== this.liveInputMode)) return;
    this.queuedMessage(session.id, message.id, 'live').catch(() => {});
  }

  // What shaped this worker run (src/setup-fingerprint.cjs), from the values this turn actually hands the provider.
  // `kept` can override instruction hashes for a recorded setup, or is null when
  // that earlier set is unknown. Per-job context (copy paths, resume notes) is left out so identical setups match.
  runSetup(session, selected, access, task, kept) {
    const provider = selected.provider || 'codex';
    let project = null;
    try {
      project = projectBody(session.workspace);
    } catch { /* no project entry */ }
    const profile = this.agents && this.agentId && this.agentId !== 'main' ? this.agents.profile(this.agentId) : null;
    const instructions = kept !== undefined ? kept
      : { harness: textHash(WORKER_INSTRUCTIONS), project: textHash(project), bot: textHash(profile?.instructions) };
    // withTaskLessons prepends the lesson block only to a task's first, uncorrected run.
    const lessons = task?.lessonBlock && !task.corrections && !task.attempts?.length ? textHash(task.lessonBlock) : null;
    const helpers = session.helperTools !== false;
    return setupFingerprint({
      provider, model: selected.model || null, effort: selected.effort || null, access,
      providerVersion: (provider === 'codex' ? this.client.version : this.nativeCLIs.get(provider)?.status?.version) || null,
      instructions, lessons, skills: skillHashes(this.skillDirectories(session)),
      tools: { helpers, context: helpers && (session.contextTool ?? !!this.contextSearch?.supports(session.workspace)),
        toolSelection: this.data.settings.toolSelection || 'off', largeResponses: this.data.settings.largeResponses !== false },
      checks: task ? checksHash(task.checks, session.workspace) : null,
    });
  }

  // Saved once the slot is granted, before routing or any provider call, on worker and Hub turns alike: after a crash
  // only a job without it may resume as never started.
  markAdmitted(session) {
    const delegation = session.delegation && !session.delegation.delivered ? session.delegation : null;
    if (delegation?.admissionTracked && !delegation.admittedAt) {
      delegation.admittedAt = Date.now();
      this.save();
    }
  }

  recordLiveMessage(session, message, task) {
    if (!session.items.some(item => item.clientId === message.id)) session.items.push({
      id: message.id, clientId: message.id, type: 'userMessage', localOnly: true, createdAt: Date.now(),
      ...(message.fileMessage ? { fileMessage: message.fileMessage } : {}),
      content: [{ type: 'text', text: message.text }, ...message.images.map(url => ({ type: 'image', url }))],
    });
    if (task?.state === 'running') task.amendments.push({ id: message.id, text: message.text });
  }

  async restartWithMessage(session, message, task) {
    const generation = (this.stopGeneration || 0) + 1;
    if (task?.foreground && this.agents) await this.agents.stopForegroundTask({ controller: this, session, task });
    else {
      this.stopping.add(session.id);
      await this.stop();
    }
    const deadline = Date.now() + 15000;
    while (this.busy === session.id && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
    if (this.busy) throw new Error('The previous turn has not stopped. Message remains queued.');
    if (this.stopGeneration !== generation) throw new Error('Send now was cancelled by Stop.');
    if (this.blockedReason()) throw new Error(this.blockedReason());
    await this.send({ ...message, id: session.id });
  }

  // Claude Code's own /compact on the resumed Claude session; the visible chat stays as is.
  async compactClaude(session) {
    const model = [...session.routes].reverse().find(route => route.provider === 'claude-cli')?.model;
    if (!session.claudeSessionId || !model) throw new Error('Send a message before compacting this chat.');
    if (!this.claude.status.loggedIn) throw new Error('Claude is not connected.');
    const abort = new AbortController();
    this.busy = session.id; this.cliAbort = abort; session.compacting = true; session.error = null;
    this.changed();
    try {
      let refusal = this.readyToStart(session);
      if (refusal?.then) refusal = await refusal; // awaited only when it waited, so timing is unchanged otherwise
      if (refusal) throw new Error(refusal.blocked || 'Compaction was stopped before starting.');
      await this.claude.run({
        cwd: this.workspace(session.workspace), model, prompt: '/compact', resume: session.claudeSessionId, access: 'read-only',
        signal: abort.signal, instructions: this.workerInstructions(session),
        onEvent: event => { if (event.session_id) session.claudeSessionId = event.session_id; },
      });
      session.notice = 'Context compacted. The visible chat history is retained.';
      session.lastCompactedAt = Date.now();
      if (session.usage) delete session.usage.last;
    } catch (error) {
      session.error = abort.signal.aborted ? 'Compaction stopped.' : error.message;
      throw error;
    } finally {
      session.compacting = false; this.cliAbort = null; this.stopping.delete(session.id);
      if (this.busy === session.id) this.busy = null;
      this.save(); this.changed(); this.settle(session);
    }
  }

  async compact(id) {
    if (this.blockedReason()) throw new Error(this.blockedReason());
    if (this.connection !== 'ready') throw new Error('No provider is connected.');
    if (this.busy) throw new Error('Wait for the current task to finish before compacting.');
    const session = this.session(id);
    if (this.isCoordinator()) return this.compactCoordinator(session);
    if (!capabilities(session.activeProvider).compact) throw new Error('Cursor manages its context automatically and has no manual compaction.');
    if (session.activeProvider === 'claude-cli') return this.compactClaude(session);
    if (!session.threadId || !session.items.some(item => item.type === 'userMessage')) throw new Error('Send a message before compacting this chat.');
    if (this.loading.has(id)) throw new Error('Wait for this chat to finish loading.');
    this.busy = id; session.compacting = true; session.error = null; session.pendingMessage = null;
    let submission = null;
    this.changed();
    try {
      let refusal = this.readyToStart(session);
      if (refusal?.then) refusal = await refusal; // awaited only when it waited, so timing is unchanged otherwise
      if (refusal) throw new Error(refusal.blocked || 'Compaction was stopped before starting.');
      await this.resume(session);
      if (this.stopping.has(id)) throw new Error('Compaction was stopped before starting.');
      submission = this.beginSubmission(session, { kind: 'compaction', backend: 'codex', threadId: session.threadId });
      await this.client.call('thread/compact/start', { threadId: session.threadId });
      if (session.submission !== submission || submission.state !== 'submitting') return;
      this.releaseCompactionBuffer(session, submission);
    } catch (error) {
      if (submission && session.submission === submission && submission.state === 'submitting' && /timed out/.test(error.message)) {
        submission.state = 'unconfirmed';
        submission.buffer = null;
        this.connection = 'disconnected';
        this.error = 'Compaction status is unknown. Restart to reconnect.';
        this.client.close();
      } else if (submission && session.submission === submission && submission.state === 'submitting') {
        submission.buffer = null;
        session.submission = null;
        this.agents?.budgets.report(submission.budget, { usage: { inputTokens: 0, outputTokens: 0 } }, true);
      }
      session.compacting = false; session.error = error.message;
      this.stopping.delete(id);
      if (this.busy === id) this.busy = null;
      this.changed(); throw error;
    }
  }

  async stop(budgetId = null) {
    this.stopGeneration = (this.stopGeneration || 0) + 1;
    if (!this.busy) return;
    this.modelPreparation?.abort();
    const session = this.session(this.busy);
    session.queuePaused = true;
    if (budgetId) session.queuePauseBudgetId = budgetId;
    else delete session.queuePauseBudgetId;
    if (this.coordinatorAbort) { this.stopping.add(session.id); this.coordinatorAbort.abort(); return; }
    // Waiting for a worker cleanup before a turn or its checks: nothing has started, so the waiter only has to see it.
    if (this.cleanupWait === session.id) { this.stopping.add(session.id); this.changed(); return; }
    if (this.gate?.sessionId === session.id) {
      this.stopping.add(session.id);
      this.gate.abort.abort();
      this.cancelHelpers();
      const processId = this.gate.processId;
      if (processId && !this.gate.localKill) {
        try {
          await this.client.call('command/exec/terminate', { processId }, 5000);
          this.clearExecutionBlock(processId);
        } catch { /* the check records an unconfirmed block when terminate fails */ }
      }
      this.changed();
      return;
    }
    if (this.cliAbort && isCLI(session.activeProvider)) { this.cancelHelpers(); this.cliAbort.abort(); return; }
    this.stopping.add(session.id);
    this.cancelHelpers();
    this.contextSearch?.cancel();
    if (this.routing === session.id) this.smartRouter.cancel();
    const turnId = this.activeTurns.get(session.id) || session.submission?.turnId;
    if (turnId) await this.interruptTurn(session, turnId);
    this.changed();
  }

  // Interrupting a Codex turn leaves the commands it started running (Codex keeps them as the thread's background
  // terminals), so they are ended too. New work waits until their processes are confirmed gone and stays blocked when
  // that cannot be confirmed (processTree.cleanup, holdCleanup).
  interruptTurn(session, turnId) {
    const { threadId } = session;
    const interrupt = async () => {
      try { await this.client.call('turn/interrupt', { threadId, turnId }); }
      catch (error) { if (!/no active turn to interrupt/.test(error.message)) throw error; }
    };
    const terminate = () => Promise.all(session.items
      .filter(item => item.type === 'commandExecution' && item.turnId === turnId && item.status === 'inProgress' && item.processId)
      .map(item => this.client.call('thread/backgroundTerminals/terminate', { threadId, processId: item.processId }, 5000).catch(() => {})));
    const since = session.submission?.turnId === turnId ? session.submission.startedAt : undefined;
    return processTree.stopStartedSince(this.client.process, since, `${this.client.process?.ownerKey}/${turnId}`, interrupt, terminate).interrupted;
  }

  answer(id, answer) {
    const request = this.requests.get(id);
    if (!request) throw new Error('This request has already been resolved.');
    if (request.assignment) {
      const session = this.data.sessions.find(session => session.delegation?.id === request.assignment.id);
      if (!session || !this.assignmentCurrent(session) || (session.delegation.revision || 1) !== request.assignment.revision) {
        this.client.rejectRequest(id, 'The assignment changed. This earlier approval is no longer valid.');
        this.requests.delete(id); this.changed();
        throw new Error('The assignment changed. Review its new request before approving an action.');
      }
    }
    if (request.budgetId && this.agents?.budgets.records[request.budgetId]?.state === 'paused')
      throw new Error('This task is paused. Its earlier approval is no longer current.');
    if (request.taskId) {
      const source = this.data.sessions.find(session => session.tasks?.some(task => task.id === request.taskId));
      const task = source?.tasks.find(task => task.id === request.taskId);
      if (!task || task.cancelled || FINAL.has(task.state) || task.budgetPaused || this.stopping.has(source.id) || !this.assignmentCurrent(source))
        throw new Error('This task changed or stopped. Its earlier approval is no longer current.');
    }
    if (this.helperApprovals.has(id)) {
      const allow = this.approvalKeys.get(id);
      if (!['accept', 'decline', ...(allow ? ['acceptForSession'] : [])].includes(answer.decision)) throw new Error('Invalid approval response.');
      if (answer.decision === 'acceptForSession') {
        if (!this.sessionAllows.has(allow.sessionId)) this.sessionAllows.set(allow.sessionId, new Set());
        this.sessionAllows.get(allow.sessionId).add(allow.key);
      }
      this.helperApprovals.get(id)(answer.decision !== 'decline');
      this.helperApprovals.delete(id); this.approvalKeys.delete(id); this.requests.delete(id); this.changed(); return;
    }
    let result;
    if (/commandExecution|fileChange/.test(request.method)) {
      // Codex remembers acceptForSession itself for the rest of its session.
      if (!['accept', 'acceptForSession', 'decline'].includes(answer.decision)) throw new Error('Invalid approval response.');
      result = { decision: answer.decision };
    } else if (/permissions/.test(request.method)) {
      const granted = answer.decision === 'accept' || answer.decision === 'acceptForSession';
      result = { permissions: granted ? request.params.permissions : {}, scope: answer.decision === 'acceptForSession' ? 'session' : 'turn' };
    } else if (/requestUserInput/.test(request.method)) {
      result = { answers: {} };
      for (const q of request.params.questions) {
        const value = answer.answers?.[q.id];
        if (typeof value !== 'string') throw new Error('Answer each question.');
        result.answers[q.id] = { answers: [value] };
      }
    } else {
      if (!['accept', 'decline'].includes(answer.decision)) throw new Error('Invalid approval response.');
      if (answer.decision === 'accept' && !isMcpConfirmation(request.params))
        throw new Error('This MCP form needs input that this client cannot display yet.');
      result = { action: answer.decision, content: answer.decision === 'accept' ? {} : null, _meta: null };
    }
    this.client.respond(id, result); this.requests.delete(id); this.changed();
  }

  applyFeaturePolicy(session) {
    const tracked = (session.tasks || []).some(task => !FINAL.has(task.state));
    const policy = tracked ? 'tracked' : 'default';
    if (session.featurePolicy && session.featurePolicy !== policy) this.loaded.delete(session.id);
    session.featurePolicy = policy;
  }

  // Quitting: stop the running task and wait (bounded) for it to wind down, stop background work, give workers a moment
  // to exit (Codex closes on end of input), then kill and verify every process tree the app started. The trees are
  // recorded before anything is stopped (and again before closing), so a child whose parent exits in the meantime is
  // still found. A Stop that fails or hangs only costs its time limit. Returns { stopped, remaining }.
  async shutdown({ stopMs = 5000, graceMs = 2000, killMs = 5000 } = {}) {
    const known = processTree.snapshotOwned();
    if (this.busy) {
      const end = Date.now() + stopMs;
      let timer;
      const stopped = this.stop().catch(error => this.log?.error('Stop failed during shutdown', { message: error.message }));
      await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(resolve, stopMs); })]);
      clearTimeout(timer);
      while (this.busy && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
      processTree.snapshotOwned(known);
    }
    try { this.close(); } catch (error) { this.log?.error('Close failed during shutdown', { message: error.message }); }
    await processTree.settleOwned(graceMs);
    const result = processTree.stopOwned({ known, deadline: Date.now() + killMs });
    // Whatever could not be confirmed stopped keeps new work blocked at the next start until it is.
    if (result.record) { this.holdCleanup(result.record, false); try { this.save(); } catch { /* logged by the caller */ } }
    return { stopped: result.stopped, remaining: result.remaining };
  }

  // Why new work may not start: a check, or a stopped worker's processes, could not be confirmed stopped. A cleanup
  // still running is not a block: the one place work starts (submitWorker, the checks in runGate, compaction) waits
  // for it with the session busy, so Stop during the wait cancels what was waiting (waitForCleanup, stop()).
  blockedReason({ otherContext = false } = {}) {
    if (this.agents?.providerSyncError) return this.agents.providerSyncError;
    if (this.agents?.providerChanging) return 'A provider connection is changing. Try again when it finishes.';
    const controlledCheck = otherContext && this.gate?.checkRunning && this.ownsGate(this.gate) &&
      this.connection === 'ready' && this.gate.processId === this.data.executionBlock?.processId;
    if (this.data.executionBlock && !controlledCheck) return 'A check may still be running.';
    if (this.data.workerCleanup?.length) return 'Processes from a stopped task could not be confirmed stopped. Phasma Harness keeps trying; restart it if this persists.';
    return null;
  }

  // The one check before work starts (submitWorker, the checks in runGate, both compactions), always with the session
  // busy. It waits for cleanups in flight, then returns why the work must not start, looked at after the wait: Stop
  // ({ stopped: true }) or a block ({ blocked }: a cleanup that just ended unconfirmed, a check that may still run).
  // Null means start. With no cleanup running it answers at once (not a promise), so callers await it only if it is one.
  readyToStart(session) {
    const refusal = () => {
      if (this.stopping.has(session.id)) return { stopped: true };
      const blocked = this.blockedReason();
      return blocked ? { blocked } : null;
    };
    const ready = () => this.cleanupPending?.size ? this.waitForCleanup(session).then(refusal) : refusal();
    return this.agents ? this.agents.acquire(this, session).then(stopped => stopped || ready()) : ready();
  }

  // Lasts until every cleanup in flight has finished (each is bounded by its own scans and deadline), or until Stop,
  // which is recorded for the waiter (see stop()). Use readyToStart, which also checks what the wait may have changed.
  async waitForCleanup(session) {
    if (!this.cleanupPending?.size) return;
    const id = session?.id ?? null;
    this.cleanupWait = id;
    try {
      while (this.cleanupPending.size && !this.stopping.has(id)) await new Promise(resolve => setTimeout(resolve, 50));
    } finally { if (this.cleanupWait === id) this.cleanupWait = null; }
  }

  holdCleanup(record, retry = true) {
    if (!record) return;
    this.data.workerCleanup = [...(this.data.workerCleanup || []).filter(item => item.id !== record.id), record];
    this.log?.error('Stopped task processes could not be confirmed stopped', { id: record.id, roots: record.roots.length, children: record.children.length });
    try { this.save(); } catch { /* the in-memory block still applies */ }
    if (retry) this.retryCleanup();
  }

  // Retries unconfirmed cleanups every 15 s (without blocking) until each is confirmed.
  retryCleanup(delayMs = 15000) {
    if (this.cleanupRetry || !this.data.workerCleanup?.length) return;
    this.cleanupRetry = setTimeout(() => this.retryCleanupNow().catch(() => {}), delayMs);
    this.cleanupRetry.unref?.();
  }

  // Each retry keeps what it learned: descendants it found are saved with the record, so one whose parent exits
  // before the next retry is still linked then.
  async retryCleanupNow() {
    clearTimeout(this.cleanupRetry); this.cleanupRetry = null;
    const results = new Map();
    for (const record of this.data.workerCleanup || []) results.set(record.id, await processTree.sweepRecord(record));
    this.applyCleanupResults(results);
    this.retryCleanup();
  }

  // At start: finishes cleanups recorded by an earlier run (the caller saves). Returns whether there were any.
  recoverWorkerCleanup(ms = 5000) {
    const records = this.data.workerCleanup || [];
    if (!records.length) return false;
    this.applyCleanupResults(new Map(records.map(record => [record.id, processTree.stopRecord(record, ms)])), false);
    this.retryCleanup();
    return true;
  }

  // Drops confirmed records and replaces the others with their grown versions (records added meanwhile are kept).
  applyCleanupResults(results, notify = true) {
    const left = (this.data.workerCleanup || []).filter(record => !results.get(record.id) || results.get(record.id).remaining.length)
      .map(record => results.get(record.id)?.record || record);
    if (left.length) this.data.workerCleanup = left; else delete this.data.workerCleanup;
    if (!notify) return;
    try { this.save(); } catch { /* retried with the next change */ }
    this.cleanupChanged();
  }

  cleanupChanged() {
    this.changed();
    if (!this.blockedReason()) for (const session of this.data.sessions) this.settle(session);
  }

  close() {
    this.jevComparing?.abort();
    this.wikiChecks.abort();
    this.claude.close(); this.cursor.close();
    for (const backend of this.nativeCLIs.values()) Promise.resolve(backend.close()).catch(error => this.log.error('Native CLI close failed', { message: error.message }));
    this.cancelHelpers();
    for (const abort of this.reflections || []) abort.abort();
    this.smartRouter.cancel();
    this.smartRouter.close?.();
    this.contextSearch?.cancel();
    this.bridge?.close();
    this.save();
    this.store.checkpoint(this.data);
    this.client.removeAllListeners('notification');
    this.coordinatorAbort?.abort();
    this.client.removeAllListeners('request');
    this.client.removeAllListeners('disconnected');
    this.client.close();
    processTree.cleanup.off('pending', this.onCleanupPending).off('done', this.onCleanupDone);
    clearTimeout(this.cleanupRetry); this.cleanupRetry = null;
    clearTimeout(this.timer); this.timer = null;
  }
}

// The Controller's methods are split by area; each file below adds its methods to the class.
for (const methods of [
  require('./controller/coordinator.cjs'),
  require('./controller/providers.cjs'),
  require('./controller/turns.cjs'),
  require('./controller/helpers.cjs'),
  require('./controller/connectors.cjs'),
  require('./controller/task-gate.cjs'),
  require('./controller/suggestions.cjs'),
  require('./controller/comparison.cjs'),
  require('./controller/reflection.cjs'),
  require('./controller/trials.cjs'),
  require('./controller/chat-scan.cjs'),
  require('./controller/setups.cjs'),
]) {
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(methods))) {
    if (Object.hasOwn(Controller.prototype, name)) throw new Error(`Controller.${name} is defined twice.`);
    Object.defineProperty(Controller.prototype, name, { ...descriptor, enumerable: false });
  }
}

module.exports = { Controller };
