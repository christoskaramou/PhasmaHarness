const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { CursorCLI } = require('./providers/cursor.cjs');
const { ClaudeCLI, handoff } = require('./providers/claude.cjs');
const { CAPABILITIES, capabilities, isCLI } = require('./providers/capabilities.cjs');
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
const { WORKER_INSTRUCTIONS } = require('./worker-instructions.cjs');
const { projectInstructions } = require('./workspace/project-instructions.cjs');
const { stripTaskStatus } = require('./routing/task-state.cjs');
const { EFFORT_CAPS, DEFAULT_EFFORT_CAP, capCatalog } = require('./routing/effort-cap.cjs');
const { snapshotOwned, settleOwned, stopOwned } = require('./process-tree.cjs');
const { CONTEXT_INSTRUCTIONS, ACCESS_MODES, sameEffort, DEFAULT_ROUTER, sessionAllowKey, accessMode, isMcpConfirmation } = require('./controller/shared.cjs');

class Controller extends EventEmitter {
  constructor(filename, defaultWorkspace, client = new CodexClient(), smartRouter = new SmartRouter(path.join(path.dirname(filename), 'router-workspace')), options = {}) {
    super();
    this.filename = filename;
    this.data = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {
      version: 1, settings: { workspace: defaultWorkspace, mode: 'auto', access: 'workspace-write' }, sessions: [],
    };
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
    this.toolHelpers = new ToolHelpers(path.join(path.dirname(filename), 'tool-outputs'), client, null);
    this.bridge = new RouterBridge((sessionId, tool, args, signal) => this.bridgeTool(sessionId, tool, args, signal));
    this.helperApprovals = new Map();
    // "Allow for this session": Claude/Cursor tool targets the user allowed, per chat session, kept in memory only.
    this.sessionAllows = new Map(); this.approvalKeys = new Map();
    // Usage limits per provider (persisted until their reset) and the last Auto message per session, for failover.
    this.data.providerLimits ??= {};
    this.limits = new ProviderLimits(this.data.providerLimits);
    this.lastSends = new Map();
    // Opt-in Jev comparison log (set by the app) and the comparison in flight, if any.
    this.jevCompare = null; this.jevComparing = null;
    // Local decision trace (set by the app; see src/trace.cjs), wiki reads taken before maintenance turns for the
    // opt-in log-only wiki check, and the abort for checks still running when the app closes.
    this.trace = NO_TRACE; this.startedAt = Date.now();
    this.wikiSnapshots = new Map(); this.wikiChecks = new AbortController();
    this.log = NO_LOG; // replaced by the app's rotating log file
    this.helperRequests = new Set();
    // Large tool output is always captured as excerpts; the setting is no longer shown, so an old "off" is not kept.
    this.data.settings.largeResponses = true;
    if (!EFFORT_CAPS.includes(this.data.settings.effortCap)) this.data.settings.effortCap = DEFAULT_EFFORT_CAP;
    this.contextSearch = null;
    this.wikiStore = options.wikiStore || null;
    this.contextRequests = new Set();
    this.routing = null;
    this.connection = 'connecting';
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
      session.queueSending = false;
      session.compacting = false;
      session.submission = null;
      session.access ??= this.data.settings.access;
      accessMode(session.access);
      if (session.status === 'running') session.status = 'interrupted';
      for (const task of session.tasks || []) if (!FINAL.has(task.state)) {
        task.reason = restartReason(task, this.data.executionBlock);
        task.state = 'needs-you';
        task.summary = summaryLine(task);
        restarted = true;
      }
      for (const task of session.tasks || []) if (task.wikiMaintenance?.state === 'running') { task.wikiMaintenance.state = 'interrupted'; restarted = true; }
      const latestTask = session.tasks?.at(-1);
      if (latestTask) latestTask.wikiAvailable = canProposeWiki(latestTask) && (!!this.wikiStore || hasProjectWiki(session.workspace));
    }
    const cleared = this.recoverExecutionBlock();
    if (restarted || cleared) { try { this.save(); } catch { /* the in-memory block and task state still apply */ } }
    client.on('notification', message => this.notification(message));
    client.on('request', message => this.serverRequest(message));
    client.on('disconnected', error => {
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

  async initialize() {
    await this.claude.refresh();
    this.migrateLegacyRouter();
    await this.cursor.refresh();
    // Cursor reasoning levels come from its model list; load it once in the background when Cursor models are enabled.
    if (this.cursor.status.loggedIn && this.data.settings.cursorEnabled !== false && (this.data.settings.providerModels || []).some(p => p.provider === 'cursor-cli'))
      this.discoverCursor().catch(() => {});
    try {
      this.data.settings.toolSelection ??= this.smartRouter.jev?.configured ? 'jev' : 'off';
      // One-time adoption of the requested Jev integration; subsequent explicit settings win.
      if (!this.data.settings.helpersVersion) {
        if (this.smartRouter.jev?.configured) this.data.settings.routing = 'jev';
        this.data.settings.helpersVersion = 1;
      }
      await this.bridge.start();
      await this.connectCodex();
    } catch (error) { this.connection = 'disconnected'; this.error = error.message; }
    this.recordProviderDefaults();
    this.changed();
  }

  snapshot() {
    return {
      benchmarks: this.smartRouter.benchmarks?.summary(this.catalog().filter(p => p.worker && p.enabled && this.available(p))),
      cursor: { ...this.cursor.status, enabled: this.data.settings.cursorEnabled !== false },
      claude: { ...this.claude.status, enabled: !!this.data.settings.claudeEnabled },
      codex: this.codex,
      ...this.data, settings: { ...this.data.settings, mode: this.planPreset() ? 'auto' : this.data.settings.mode }, planRouting: this.planPreset(), connection: this.connection, error: this.error, account: this.account, busy: this.busy,
      routing: this.routing, routerModel: this.data.settings.routing === 'jev' ? JEV_MODEL : this.routerChoices().find(p => p.id === this.data.settings.routerPreset)?.model || null,
      jev: { configured: !!this.smartRouter.jev?.configured, model: JEV_MODEL, compare: this.jevCompare?.summary() || null, health: this.smartRouter.jev?.health || null },
      decisions: this.trace.summary(),
      contextRoot: this.contextSearch?.root || null,
      helperCapabilities: {
        projectContext: { codex: true, responsesApi: true, claudeCli: true, cursorCli: true },
        jevToolRecommendations: { codex: true, responsesApi: true, claudeCli: 'codex-thread-mcp-catalog', cursorCli: 'codex-thread-mcp-catalog' },
        largeOutputCapture: { codex: 'helper-gateway-only', responsesApi: 'helper-gateway-only', claudeCli: 'helper-mcp-only', cursorCli: 'helper-mcp-only' },
        note: 'Large-output capture applies to router_call_tool / project_context helper responses. It does not intercept native Codex, Claude, or Cursor tools. Claude/Cursor session MCP connects phasma_harness for project_context / router_read_output. router_find_tools / router_call_tool are intentionally Codex-scoped (Codex MCP catalog/gateway); without a Codex thread they return unsupported. Do not build parallel CLI catalogs for parity. This app does not rewrite project MCP configs or silently elevate MCP approvals.',
      },
      accessModes: ACCESS_MODES,
      providerLimits: this.limits.active(),
      providerUsage: this.limits.usage,
      providerCapabilities: CAPABILITIES,
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
    };
  }

  save() {
    clearTimeout(this.timer); this.timer = null;
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    fs.writeFileSync(this.filename + '.tmp', JSON.stringify(this.data));
    fs.renameSync(this.filename + '.tmp', this.filename);
  }

  changed() {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      try { this.save(); } catch (error) { this.error = `Could not save sessions: ${error.message}`; }
      this.emit('state', this.snapshot());
    }, 100);
  }

  session(id) {
    const session = this.data.sessions.find(s => s.id === id);
    if (!session) throw new Error('Session not found.');
    return session;
  }

  workspace(value) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || !fs.statSync(value).isDirectory()) throw new Error('Choose an existing workspace folder.');
    return fs.realpathSync(value);
  }

  settings(values) {
    if (!values || typeof values !== 'object') throw new Error('Invalid settings.');
    const next = { ...this.data.settings };
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
    if (values.fontScale !== undefined) {
      if (![85, 100, 115, 130, 150].includes(values.fontScale)) throw new Error('Invalid font scale.');
      next.fontScale = values.fontScale;
    }
    if (values.toolSelection !== undefined || values.largeResponses !== undefined) {
      if (this.busy && ((values.toolSelection !== undefined && values.toolSelection !== next.toolSelection) ||
        (values.largeResponses !== undefined && values.largeResponses !== next.largeResponses))) throw new Error('Stop the current turn before changing tool helpers.');
      if (values.toolSelection !== undefined) {
        if (!['off', 'jev'].includes(values.toolSelection)) throw new Error('Unknown tool selection mode.');
        if (values.toolSelection === 'jev' && !this.smartRouter.jev?.configured) throw new Error('Add your Jev API key in Settings first.');
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
      if (values.routing === 'jev' && !this.smartRouter.jev?.configured) throw new Error('Add your Jev API key in Settings first.');
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
      if (values.jevCompare && !next.jevCompare && !this.smartRouter.jev?.configured) throw new Error('Add your Jev API key in Settings first.');
      next.jevCompare = values.jevCompare;
      if (!values.jevCompare) this.jevComparing?.abort();
    }
    if (values.wikiAssessment !== undefined) {
      if (typeof values.wikiAssessment !== 'boolean') throw new Error('Invalid wiki check setting.');
      if (values.wikiAssessment && !next.wikiAssessment && !this.smartRouter.jev?.configured) throw new Error('Add your Jev API key in Settings first.');
      next.wikiAssessment = values.wikiAssessment;
    }
    if (values.contextRanking !== undefined) {
      if (!['local', 'jev'].includes(values.contextRanking)) throw new Error('Unknown context ranking mode.');
      if (values.contextRanking === 'jev' && !this.smartRouter.jev?.configured) throw new Error('Add your Jev API key in Settings first.');
      next.contextRanking = values.contextRanking;
    }
    if (next.toolSelection !== this.data.settings.toolSelection || next.largeResponses !== this.data.settings.largeResponses) this.loaded.clear();
    this.data.settings = next; this.save(); this.changed();
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
    if (session.access !== access) this.sessionAllows.delete(session.id); // an access change starts approvals fresh
    session.access = access;
    this.save(); this.changed(); return this.snapshot();
  }

  rename(id, title) {
    if (typeof title !== 'string' || !title.trim()) throw new Error('Enter a session name.');
    this.session(id).title = title.trim().slice(0, 120); this.save(); this.changed();
  }

  archive(id) {
    if (this.busy === id) throw new Error('Stop this session before hiding it.');
    this.session(id).archived = true; this.save(); this.changed();
  }

  deleteSession(id) {
    const session = this.session(id);
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
    this.providers?.setModel?.(choice);
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
    const params = {
      ...providerConfig, model: choice.model,
      cwd: this.workspace(session.workspace), approvalPolicy: permissions.approvalPolicy, approvalsReviewer: 'user',
      sandbox: permissions.id, serviceTier: 'default',
      config: {
        tool_output_token_limit: 4000, model_verbosity: 'low', ...providerConfig.config,
        ...(session.featurePolicy === 'tracked' ? { 'features.goals': false, 'features.multi_agent': false } : {}),
      },
      developerInstructions: workerInstructions + (contextEnabled ? CONTEXT_INSTRUCTIONS : '') + (helpersEnabled ? HELPER_INSTRUCTIONS +
        ` Jev tool recommendations are ${this.data.settings.toolSelection === 'jev' ? 'enabled' : 'disabled (discovery uses local ranking)'}. Large-response capture is ${this.data.settings.largeResponses ? 'enabled' : 'disabled'}.` : ''),
    };
    if (session.threadId) {
      await this.client.call('thread/unsubscribe', { threadId: session.threadId });
      await this.client.call('thread/resume', { ...params, threadId: session.threadId, excludeTurns: true });
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
            item.clientId = saved.clientId;
            item.routeLabel = saved.routeLabel;
          }
        }
        // Local Jev exchanges have no native turn. Retain their position on resume.
        const previous = session.items;
        for (let i = previous.length - 1; i >= 0; i--) if (previous[i].localOnly) {
          const next = previous.slice(i + 1).find(item => items.some(remote => remote.id === item.id));
          const index = next ? items.findIndex(item => item.id === next.id) : items.length;
          items.splice(index, 0, previous[i]);
        }
        session.items = items.filter(item => this.visible(item));
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
    this.loadedInstructions.set(session.id, workerInstructions);
    this.loaded.add(session.id);
  }

  async load(id) {
    const session = this.session(id);
    if (isCLI(session.activeProvider)) return this.snapshot();
    if (this.connection === 'ready' && session.threadId && !this.loaded.has(id)) {
      await this.resume(session); this.changed();
    }
    return this.snapshot();
  }

  async send({ id, text, mode, images = [], task = 'on', wikiTaskId = null, failover = false }) {
    if (!['auto', 'on', 'off'].includes(task)) throw new Error('Invalid task mode.');
    if (task === 'auto') task = 'on'; // Existing queued messages use the new default.
    if (this.data.executionBlock) throw new Error('A check may still be running.');
    if (this.connection !== 'ready') throw new Error(this.error || 'Codex is still connecting.');
    if (!Array.isArray(images) || images.length > 4 || images.some(url => typeof url !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url)) || images.reduce((n, url) => n + url.length, 0) > 12 * 1024 * 1024) throw new Error('Invalid images: attach up to four PNG images under 8 MB total.');
    if (typeof text !== 'string' || (!text.trim() && !images.length) || text.length > 200000) throw new Error('Enter a message under 200,000 characters or attach an image.');
    if (!text.trim()) text = 'Analyze the attached image(s). Explain what you see and any relevant issue; ask for clarification if the intended task is unclear.';
    const session = this.session(id);
    let wikiWorker;
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
      if (this.busy !== id) throw new Error('Another turn is running. Switch to that session to queue a message.');
      if ((session.queue?.length || 0) >= 10) throw new Error('The queue is full (10 messages).');
      session.queuePaused = false;
      (session.queue ||= []).push({ id: randomUUID(), text, images, mode: mode || this.data.settings.mode, task, ...(wikiTaskId ? { wikiTaskId } : {}) });
      this.save(); this.changed();
      return { queued: true };
    }
    session.queuePaused = false;
    const chosenMode = mode || this.data.settings.mode;
    let selected = wikiWorker ? { ...wikiWorker, wikiTaskId, source: 'manual', reason: 'Wiki proposal using the original task worker.' }
      : this.planPreset() || (chosenMode === 'auto' ? route(text) : { ...this.resolveWorker(chosenMode), source: 'manual', reason: 'Your manual selection.' });
    if (chosenMode !== 'auto' && !selected?.model) throw new Error('Unknown model selection.');
    if (this.planPreset() && !this.models.some(m => m.model === selected.model && m.supportedReasoningEfforts.some(e => e.reasoningEffort === selected.effort)))
      throw new Error('Terra light is not currently available on your account. Refresh your Codex login or restart the app.');
    const provider = this.data.settings.routing;
    const useSmart = !this.planPreset() && chosenMode === 'auto';
    const previousState = { status: session.status, error: session.error };
    this.busy = id; session.status = 'running'; session.error = null; session.turnId = null;
    const clientId = randomUUID();
    // Only an Auto message may be re-sent to another provider when its provider hits a usage limit, and only once.
    this.lastSends.delete(id);
    if (useSmart && !wikiTaskId) this.lastSends.set(id, { clientId, text, images, task, failover: failover === true });
    session.pendingMessage = {
      id: clientId, clientId, type: 'userMessage', pending: true, createdAt: Date.now(),
      content: [{ type: 'text', text }, ...images.map(url => ({ type: 'image', url }))]
    };
    this.changed();
    try {
      if (this.stopping.has(id)) throw new Error('Turn was stopped before sending.');
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
        const context = { ...session, ...previousState, configuredChecks: this.data.settings.checks?.[session.workspace] || [], routingCatalog: routingCatalog(), routerChoice: router, jevQuickAnswers: this.data.settings.jevQuickAnswers, attachedImageCount: images.length };
        const smart = async () => {
          try { return await this.smartRouter.choose(text, { ...context, routerChoice: router }, this.models, 'smart', router?.id); }
          catch (error) {
            // The router's own provider hit its usage limit: record it and route once with another provider's router.
            if (!error.limit || error.name === 'AbortError' || this.stopping.has(id)) throw error;
            this.limits.mark(error.limitProvider, error.limit);
            const next = this.effectiveRouter();
            if (!next || next.id === router?.id || !this.available(next)) throw error;
            router = next;
            return this.smartRouter.choose(text, { ...context, routingCatalog: routingCatalog(), routerChoice: router }, this.models, 'smart', router.id);
          }
        };
        try {
          try { selected = provider === 'jev' ? await this.smartRouter.choose(text, context, this.models, provider, router?.id) : await smart(); }
          catch (error) {
            // Jev unavailable (down, timeout, key removed): route the same message with the smart router instead of failing.
            // A stop is never retried, and without a usable smart router the Jev error stands.
            if (provider !== 'jev' || error.name === 'AbortError' || this.stopping.has(id) || !smartReady()) throw error;
            selected = await smart();
            const note = `Jev was unavailable (${String(error.message).slice(0, 160)}); the smart router chose instead.`;
            selected = { ...selected, routerFallback: note, reason: selected.reason ? `${note} ${selected.reason}` : note };
          }
        } finally { this.routing = null; this.warmRouter(); }
        selected = { ...selected, effortCap: this.data.settings.effortCap };
        if (this.stopping.has(id)) throw new Error('Turn was stopped before sending.');
      }
      if (selected.directAnswer) {
        if (!session.items.some(i => i.type === 'userMessage')) session.title = text.trim().replace(/\s+/g, ' ').slice(0, 65);
        session.items.push({ ...session.pendingMessage, pending: false, localOnly: true },
          { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: selected.directAnswer, routeLabel: 'Jev · quick answer', localOnly: true, createdAt: Date.now() });
        (session.directContext ||= []).push({ question: text, answer: selected.directAnswer });
        session.routes.push({ ...selected, label: 'Jev quick answer', at: Date.now(), messageId: clientId });
        session.pendingMessage = null; session.status = 'completed'; session.updated = Date.now(); this.busy = null;
        this.save(); this.changed(); this.settle(session);
        return selected;
      }
      if (!this.available(selected)) throw new Error('Selected model is disabled or not available.');
      if (images.length && selected.images === false) throw new Error('Enable image support for this model before sending images.');
      if (!failover && !this.planPreset()) this.compareWithJev(session, text, images, selected, previousState);
      if (failover) selected = { ...selected, failover: true }; // recorded on the route for the decision trace
      // One model per task: whether this message continues the current task (the router's sameTask; a manual pick
      // continues a task its worker reported as pending or waiting for input). The turn's end then updates the task
      // or starts a new one (updateJob).
      if (!wikiTaskId) session.jobDecision = { messageId: clientId, goal: text,
        continues: selected.sameTask === true || (selected.sameTask === undefined && ['pending', 'needs-input'].includes(session.job?.status)) };
      const tracked = this.openTask(session, selected, text, clientId, task);
      return await this.submitWorker(session, selected, text, images, clientId, tracked);
    } catch (error) {
      if (error.turnFailed) throw error;
      await this.failSend(session, null, clientId, error, (session.tasks || []).find(item => item.messageId === clientId && !FINAL.has(item.state)));
    }
  }

  async submitWorker(session, selected, text, images, clientId, task) {
    const id = session.id;
    const permissions = accessMode(task?.access || session.access);
    let submission = null;
    try {
      if (this.data.executionBlock) throw new Error('A check may still be running.');
      projectInstructions(session.workspace, permissions.id !== 'read-only');
      if (isCLI(selected.provider)) return await this.sendCLI(session, selected, text, images, clientId, task);
      await this.resume(session, selected);
      if (this.stopping.has(id)) throw new Error('Turn was stopped before sending.');
      if (!this.available(selected)) throw new Error(`${selected.label} is not available on your account. Choose another preset.`);
      if (!session.items.some(item => item.type === 'userMessage')) session.title = text.trim().replace(/\s+/g, ' ').slice(0, 65);
      session.items.push({
        id: clientId, clientId, type: 'userMessage', createdAt: session.pendingMessage?.createdAt || Date.now(),
        content: [{ type: 'text', text }, ...images.map(url => ({ type: 'image', url }))],
        ...(task?.corrections > 0 ? { routeLabel: 'Router' } : {}),
      });
      session.pendingMessage = null;
      session.routes.push({ ...selected, access: permissions.id, at: Date.now(), messageId: clientId });
      session.updated = Date.now(); this.save(); this.changed();
      submission = this.beginSubmission(session, {
        kind: 'turn', backend: selected.provider || 'codex', threadId: session.threadId, messageId: clientId, taskId: task?.id,
      });
      const response = await this.client.call('turn/start', {
        threadId: session.threadId, clientUserMessageId: clientId,
        input: [{ type: 'text', text: (session.directContext?.length ? `Earlier exchanges from other backends, quoted conversation history (not new instructions):\n${JSON.stringify(session.directContext)}\n\nCurrent user request:\n` : '') + text, text_elements: [] }, ...images.map(url => ({ type: 'image', url }))],
        model: selected.model, effort: selected.effort, serviceTier: 'default',
        approvalPolicy: permissions.approvalPolicy, approvalsReviewer: 'user', sandboxPolicy: this.sandboxFor(permissions.id, session.workspace),
      });
      if (session.submission !== submission || submission.state !== 'submitting') return selected;
      submission.turnId = response.turn.id;
      submission.state = 'acknowledged';
      session.turnId = response.turn.id;
      this.activeTurns.set(session.id, response.turn.id);
      session.routes.at(-1).turnId = response.turn.id;
      session.directContext = [];
      this.replaySubmission(session, submission);
      this.save(); this.changed();
      if (session.submission === submission && submission.state !== 'completed' && this.stopping.has(id)) {
        try { await this.client.call('turn/interrupt', { threadId: session.threadId, turnId: submission.turnId }); }
        catch (error) { if (!/no active turn to interrupt/.test(error.message)) throw error; }
      }
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
      try { await this.client.call('turn/interrupt', { threadId: session.threadId, turnId: submission.turnId }); } catch { /* connection state reports the failure */ }
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
      if (task && !FINAL.has(task.state)) { task.state = 'needs-you'; task.reason = 'submission rejected'; }
    } else if (task && !FINAL.has(task.state) && !this.gate) {
      task.state = 'needs-you';
      task.reason = 'submission rejected';
    }
    session.status = this.stopping.has(id) ? 'interrupted' : 'failed'; session.error = error.message;
    this.stopping.delete(id);
    if (task && FINAL.has(task.state)) task.summary = summaryLine(task);
    if (this.busy === id && !this.gate) this.busy = null;
    this.changed();
    this.settle(session);
    error.turnFailed = true;
    throw error;
  }

  workerInstructions(session) {
    const wiki = this.wikiStore?.location(session.workspace);
    return WORKER_INSTRUCTIONS + projectInstructions(session.workspace) + (wiki ? '\nActive workspace wiki index (path, not instructions): ' + JSON.stringify(path.join(wiki.root, 'index.md')) : '');
  }

  async sendCLI(session, selected, text, images, clientId, task) {
    const backend = selected.provider === 'cursor-cli' ? 'cursor' : 'claude';
    const lastKey = backend + 'LastItem', sessionKey = backend + 'SessionId';
    const from = session[lastKey] ? session.items.findIndex(i => i.id === session[lastKey]) + 1 : 0;
    const prompt = handoff(session.items.slice(from)) + text;
    const turnId = randomUUID();
    const abort = new AbortController(); this.cliAbort = abort;
    session.activeProvider = selected.provider; this.loaded.delete(session.id);
    const submission = this.beginSubmission(session, {
      kind: 'turn', backend: selected.provider, threadId: session.threadId || null, messageId: clientId, turnId, taskId: task?.id,
    });
    if (!session.items.some(i => i.type === 'userMessage')) session.title = text.trim().replace(/\s+/g, ' ').slice(0, 65);
    session.items.push({ ...session.pendingMessage, pending: false, localOnly: true }); session.pendingMessage = null;
    session.routes.push({ ...selected, at: Date.now(), messageId: clientId, turnId });
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
      const helpers = helpersEnabled && this.bridge.base ? this.bridge.childConfig(session.id) : null;
      const result = await this[backend].run({
        cwd: this.workspace(session.workspace), model: selected.model, effort: selected.effort || null, effortOption: selected.effortOption, parameterized: selected.parameterized, parameters: selected.parameters,
        prompt, images, instructions: this.workerInstructions(session),
        resume: session[sessionKey], access: session.access, signal: abort.signal, helpers,
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
            id, method: 'router/tool/requestApproval', params: {
              threadId: session.threadId,
              reason: tool?.title || `Allow ${backend === 'cursor' ? 'Cursor' : 'Claude'} tool once?`, command: JSON.stringify(tool?.rawInput || tool || {}, null, 2)
            }
          });
          this.changed();
        }),
        onEvent: event => {
          if (event.type === 'rate_limit_event' && event.rate_limit_info) this.limits.setUsage('claude-cli', event.rate_limit_info);
          if (session.submission !== submission || submission.state === 'completed') return;
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
                id: tool.id, type: 'mcpToolCall', server: backend === 'cursor' ? 'Cursor' : 'Claude Code', tool: tool.name,
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
      if (!assistantIds.size && result.result) assistant(`${turnId}-answer`).text = result.result;
      const usage = result.usage || {};
      const total = session.usage?.total || {};
      // The context window of the model that did the most input work (background helper models are smaller).
      const main = Object.values(result.modelUsage || {}).filter(m => Number.isFinite(m?.contextWindow))
        .sort((a, b) => ((b.inputTokens || 0) + (b.cacheReadInputTokens || 0)) - ((a.inputTokens || 0) + (a.cacheReadInputTokens || 0)))[0];
      session.usage = {
        total: {
          inputTokens: (total.inputTokens || 0) + (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
          cachedInputTokens: (total.cachedInputTokens || 0) + (usage.cache_read_input_tokens || 0), outputTokens: (total.outputTokens || 0) + (usage.output_tokens || 0)
        },
        ...(lastUsage ? { last: { ...lastUsage, totalTokens: lastUsage.inputTokens + lastUsage.outputTokens } } : {}),
        ...(main ? { modelContextWindow: main.contextWindow } : {}),
      };
      // The whole turn (every model call in it), for the decision trace; `last` above is only its final call.
      // A provider that reports no usage (Cursor) keeps it unknown, never zero.
      const route = session.routes.find(item => item.messageId === clientId);
      const reported = result.usage && typeof result.usage === 'object' && ['input_tokens', 'output_tokens'].some(key => Number.isFinite(result.usage[key]));
      if (route && reported) route.turnUsage = { inputTokens: (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
        cachedInputTokens: usage.cache_read_input_tokens || 0, outputTokens: usage.output_tokens || 0 };
      if (result.permission_denials?.length) outcome.error = 'Some Claude tool calls were declined or not permitted under the selected access. Review the response before changing access.';
    } catch (error) { outcome = { status: abort.signal.aborted ? 'interrupted' : 'failed', error: error.message, limit: abort.signal.aborted ? null : error.limit }; }
    finally {
      const answer = session.items.filter(i => assistantIds.has(i.id)).map(i => stripTaskStatus(i.text)).join('\n');
      (session.directContext ||= []).push({ question: text, answer: answer || `[${backend} turn ${outcome.status}]` });
      if (outcome.status === 'completed') session[lastKey] = session.items.at(-1)?.id;
      else { session[lastKey] = null; session[sessionKey] = null; }
      this.cliAbort = null; turnOver = true;
      // An approval still open when the CLI turn ends can no longer be used.
      for (const [id, resolve] of this.helperApprovals) if (id.startsWith('cli-')) { resolve(false); this.requests.delete(id); this.helperApprovals.delete(id); this.approvalKeys.delete(id); }
      this.finishTurn(session, submission, outcome);
      this.providerOutcome(session, selected.provider, selected.model, clientId, outcome);
      this.save();
    }
    return selected;
  }

  settle(session) {
    if (!session || this.busy || this.data.executionBlock || session.queueSending || this.connection !== 'ready' || session.queuePaused) return;
    setImmediate(() => {
      if (this.busy || this.data.executionBlock || session.queueSending || this.connection !== 'ready' || session.queuePaused || !this.data.sessions.includes(session)) return;
      const next = session.queue?.[0];
      if (!next || next.error) return;
      this.queuedMessage(session.id, next.id, 'send').catch(() => { });
    });
  }

  async queuedMessage(id, messageId, action) {
    const session = this.session(id);
    if (action === 'steer' && !capabilities(session.activeProvider).steer) throw new Error('This CLI supports queued follow-ups here. Stop the turn to send the correction immediately.');
    const message = session.queue?.find(m => m.id === messageId);
    if (!message || session.queueSending) throw new Error('This queued message is no longer available.');
    if (action === 'remove' || action === 'edit') {
      if (action === 'edit' && message.uncertain) throw new Error('Check the conversation before resending an unconfirmed message.');
      const previousQueue = session.queue;
      session.queue = session.queue.filter(m => m !== message);
      try { this.save(); } catch (error) { session.queue = previousQueue; throw error; }
      this.changed(); return action === 'edit' ? message : undefined;
    }
    if (!['send', 'steer'].includes(action)) throw new Error('Invalid queue action.');
    if (message.uncertain) throw new Error('Delivery was not confirmed. Check the conversation before removing this message.');
    const turnId = this.activeTurns.get(id);
    const activeTask = (session.tasks || []).find(item => !FINAL.has(item.state));
    if (action === 'steer' && activeTask?.state === 'checking') throw new Error('Checks are running. Stop the task before steering.');
    if (action === 'steer' && (this.busy !== id || !turnId || session.compacting || this.stopping.has(id))) throw new Error('Wait for an active turn before steering.');
    if (action === 'send' && this.busy) throw new Error('Wait for the active turn to finish.');
    if (action === 'send') session.queuePaused = false;
    session.queueSending = true; this.changed();
    try {
      if (action === 'steer') {
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
    } finally { session.queueSending = false; this.save(); this.changed(); this.settle(session); }
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
      await this.claude.run({
        cwd: this.workspace(session.workspace), model, prompt: '/compact', resume: session.claudeSessionId, access: 'read-only',
        signal: abort.signal, instructions: this.workerInstructions(session),
        onEvent: event => { if (event.session_id) session.claudeSessionId = event.session_id; },
      });
      session.notice = 'Context compacted. The visible chat history is retained.';
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
    if (this.data.executionBlock) throw new Error('A check may still be running.');
    if (this.connection !== 'ready') throw new Error('No provider is connected.');
    if (this.busy) throw new Error('Wait for the current task to finish before compacting.');
    const session = this.session(id);
    if (!capabilities(session.activeProvider).compact) throw new Error('Cursor manages its context automatically and has no manual compaction.');
    if (session.activeProvider === 'claude-cli') return this.compactClaude(session);
    if (!session.threadId || !session.items.some(item => item.type === 'userMessage')) throw new Error('Send a message before compacting this chat.');
    if (this.loading.has(id)) throw new Error('Wait for this chat to finish loading.');
    this.busy = id; session.compacting = true; session.error = null; session.pendingMessage = null;
    let submission = null;
    this.changed();
    try {
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
      }
      session.compacting = false; session.error = error.message;
      this.stopping.delete(id);
      if (this.busy === id) this.busy = null;
      this.changed(); throw error;
    }
  }

  async stop() {
    if (!this.busy) return;
    const session = this.session(this.busy);
    session.queuePaused = true;
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
    if (turnId) {
      try { await this.client.call('turn/interrupt', { threadId: session.threadId, turnId }); }
      catch (error) { if (!/no active turn to interrupt/.test(error.message)) throw error; }
    }
    this.changed();
  }

  answer(id, answer) {
    const request = this.requests.get(id);
    if (!request) throw new Error('This request has already been resolved.');
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
  // recorded first, so a child whose parent exits in the meantime is still found. Returns { stopped, remaining }.
  async shutdown({ stopMs = 5000, graceMs = 2000, killMs = 5000 } = {}) {
    if (this.busy) {
      const end = Date.now() + stopMs;
      let timer;
      await Promise.race([this.stop().catch(() => {}), new Promise(resolve => { timer = setTimeout(resolve, stopMs); })]);
      clearTimeout(timer);
      while (this.busy && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
    }
    const known = snapshotOwned();
    try { this.close(); } catch (error) { this.log.error('Close failed during shutdown', { message: error.message }); }
    await settleOwned(graceMs);
    return stopOwned({ known, deadline: Date.now() + killMs });
  }

  close() {
    this.jevComparing?.abort();
    this.wikiChecks.abort();
    this.claude.close(); this.cursor.close();
    this.cancelHelpers();
    this.smartRouter.cancel();
    this.smartRouter.close?.();
    this.contextSearch?.cancel();
    this.bridge?.close();
    this.save();
    this.client.removeAllListeners('notification');
    this.client.removeAllListeners('request');
    this.client.removeAllListeners('disconnected');
    this.client.close();
  }
}

// The Controller's methods are split by area; each file below adds its methods to the class.
for (const methods of [
  require('./controller/providers.cjs'),
  require('./controller/turns.cjs'),
  require('./controller/helpers.cjs'),
  require('./controller/task-gate.cjs'),
]) {
  for (const [name, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(methods))) {
    if (Object.hasOwn(Controller.prototype, name)) throw new Error(`Controller.${name} is defined twice.`);
    Object.defineProperty(Controller.prototype, name, { ...descriptor, enumerable: false });
  }
}

module.exports = { Controller };
