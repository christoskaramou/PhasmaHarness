const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateProvider, validateModel } = require('./providers/providers.cjs');
const { CursorCLI } = require('./providers/cursor.cjs');
const { ClaudeCLI, MODELS: CLAUDE_MODELS, handoff } = require('./providers/claude.cjs');
const { EventEmitter } = require('node:events');
const { CodexClient } = require('./providers/codex.cjs');
const { PRESETS, ROUTER_PRESETS, route } = require('./routing/router.cjs');
const { SmartRouter, routerModel } = require('./routing/smart-router.cjs');
const { MODEL: JEV_MODEL } = require('./providers/jev.cjs');
const { TOOL: CONTEXT_TOOL } = require('./workspace/context-search.cjs');
const { ToolHelpers, TOOLS: HELPER_TOOLS, INSTRUCTIONS: HELPER_INSTRUCTIONS } = require('./tools/tool-helpers.cjs');
const { RouterBridge } = require('./tools/router-bridge.cjs');

const WORKER_INSTRUCTIONS = 'Use one agent unless the user explicitly requests delegation. Preserve unrelated work. Do not commit or push unless the user explicitly asks. Report the checks actually performed and any remaining uncertainty. ' +
  'Default response style: lead with the answer or outcome, number actual steps, keep lists short, and omit tangents and pleasantries. Give one next action only when work remains. Explain fully when asked; never omit material findings or uncertainty. Respect requests for normal mode or a different style. These behaviors and project-context, model-selection and large-response helpers are built into this app; do not install or invoke duplicate skills to provide them. ' +
  'Minimize usage without sacrificing correctness: answer self-contained conversational questions directly, without workspace reconnaissance. For project work, follow AGENTS.md, reuse evidence already in this conversation, and use targeted searches and line ranges before full-file reads. Keep routine tool output around 2000 tokens; save large logs to a file and inspect relevant sections. Truncated output is incomplete evidence: retrieve missing sections when needed. Batch independent lookups, avoid repeated unchanged reads, and stop testing once the relevant checks pass unless new evidence requires more. Keep replies concise unless detail is requested. Do not launch paid model benchmarks or repeated live API probes unless explicitly requested; prefer offline tests for routine changes.';

const CONTEXT_INSTRUCTIONS = ' For project investigation, use project_context to find focused starting evidence when useful. It is a partial search: read project instructions normally, verify important claims in live source, and search further for missing or conflicting evidence. Do not repeat identical searches unless files or the question changed.';

const ACCESS_MODES = [
  { id: 'read-only', label: 'Ask', approvalPolicy: 'on-request', description: 'Read files and run read-only commands. Ask before changes or broader access.' },
  { id: 'workspace-write', label: 'Workspace access', approvalPolicy: 'on-request', description: 'Edit files and run commands in the workspace. Ask before access outside it or network access.' },
  { id: 'danger-full-access', label: 'Full access', approvalPolicy: 'never', description: 'Unrestricted file and network access, without Codex command approval prompts.' },
];

function accessMode(value) {
  const mode = ACCESS_MODES.find(mode => mode.id === value);
  if (!mode) throw new Error('Unknown access mode.');
  return mode;
}

function isMcpConfirmation(params) {
  const schema = params?.requestedSchema;
  // Empty-schema confirmations only. Forms with fields need a validated form renderer.
  return ['form', 'openai/form', 'openaiForm'].includes(params?.mode) &&
    schema?.type === 'object' && schema.properties !== null && typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties) && Object.keys(schema.properties).length === 0 &&
    (schema.required === undefined || (Array.isArray(schema.required) && schema.required.length === 0)) &&
    Object.keys(schema).every(key => ['$schema', 'type', 'properties', 'required', 'title', 'description', 'additionalProperties'].includes(key)) &&
    (schema.additionalProperties === undefined || typeof schema.additionalProperties === 'boolean');
}

class Controller extends EventEmitter {
  constructor(filename, defaultWorkspace, client = new CodexClient(), smartRouter = new SmartRouter(path.join(path.dirname(filename), 'router-workspace'))) {
    super();
    this.filename = filename;
    this.data = fs.existsSync(filename) ? JSON.parse(fs.readFileSync(filename, 'utf8')) : {
      version: 1, settings: { workspace: defaultWorkspace, mode: 'auto', access: 'workspace-write' }, sessions: [],
    };
    if (this.data.version !== 1 || !Array.isArray(this.data.sessions)) throw new Error('Unrecognized session store. Your existing file has been preserved.');
    if (!this.data.settings.routing || this.data.settings.routing === 'rules') this.data.settings.routing = 'smart';
    this.data.settings.routerPreset ??= 'codex:gpt-5.6-terra:low';
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
    this.helperRequests = new Set();
    this.data.settings.largeResponses ??= true;
    this.contextSearch = null;
    this.contextRequests = new Set();
    this.routing = null;
    this.connection = 'connecting';
    this.error = null;
    this.account = null;
    this.models = [];
    this.loaded = new Set();
    this.loading = new Map();
    this.requests = new Map();
    this.busy = null;
    this.stopping = new Set();
    this.activeTurns = new Map();
    this.timer = null;
    for (const session of this.data.sessions) {
      if (session.queueSending) for (const message of session.queue || []) {
        message.uncertain = true; message.error = 'App closed during delivery. Check the conversation before resending.';
      }
      session.queueSending = false;
      session.compacting = false;
      session.access ??= this.data.settings.access;
      accessMode(session.access);
      if (session.status === 'running') session.status = 'interrupted';
    }
    client.on('notification', message => this.notification(message));
    client.on('request', message => this.serverRequest(message));
    client.on('disconnected', error => {
      if (this.cliAbort) { this.connection = 'disconnected'; this.error = error; this.cancelHelpers(); this.cliAbort.abort(); return; }
      this.cancelHelpers();
      this.smartRouter.cancel();
      this.contextSearch?.cancel();
      this.connection = 'disconnected'; this.error = error;
      if (this.busy) { this.session(this.busy).status = 'interrupted'; this.session(this.busy).compacting = false; }
      this.busy = null; this.requests.clear(); this.changed();
    });
  }

  async initialize() {
    await this.claude.refresh();
    await this.cursor.refresh();
    try {
      this.data.settings.toolSelection ??= this.smartRouter.jev?.configured ? 'jev' : 'off';
      // One-time adoption of the requested Jev integration; subsequent explicit settings win.
      if (!this.data.settings.helpersVersion) {
        if (this.smartRouter.jev?.configured) this.data.settings.routing = 'jev';
        this.data.settings.helpersVersion = 1;
      }
      await this.bridge.start();
      await this.client.start();
      await this.refreshAccount();
    } catch (error) { this.connection = 'disconnected'; this.error = error.message; }
    this.changed();
  }

  async refreshAccount() {
    const account = await this.client.call('account/read', { refreshToken: false });
    const models = [];
    let cursor = null;
    do {
      const page = await this.client.call('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
      models.push(...(page.data || []));
      cursor = page.nextCursor || null;
    } while (cursor && models.length < 500);
    const nextAccount = account.account ? { type: account.account.type, plan: account.account.planType, email: account.account.email || null } : null;
    if (JSON.stringify(this.account) !== JSON.stringify(nextAccount)) this.smartRouter.close?.();
    this.account = nextAccount;
    this.models = models;
    this.connection = this.account || this.catalog().some(p => p.provider !== 'codex' && this.available(p)) ? 'ready' : 'signed-out';
    this.error = this.connection === 'signed-out' ? 'Connect ChatGPT or enable an API provider in Settings.' : null;
    this.changed();
  }

  catalog() {
    return [...this.codexWorkers(), ...CLAUDE_MODELS.map(p => ({
      ...p, enabled: !!this.data.settings.claudeEnabled && !(this.data.settings.disabledModels || []).includes(p.id),
    })), ...(this.data.settings.providerModels || [])].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  }

  codexWorkers() {
    const models = this.models || [];
    const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    const hasExplicit = Array.isArray(this.data.settings.disabledCodexModels);
    const disabled = new Set(this.data.settings.disabledCodexModels || []);
    // Default-on: existing worker models. Other discovered models require opt-in.
    const defaults = new Set(PRESETS.map(p => p.model));
    return models.flatMap((entry, index) => {
      const supported = (entry.supportedReasoningEfforts || []).map(e => e.reasoningEffort);
      const usable = efforts.filter(e => supported.includes(e));
      const list = usable.length ? usable : [null];
      const enabled = hasExplicit ? !disabled.has(entry.model) : defaults.has(entry.model);
      return list.map(effort => ({
        id: `codex:${entry.model}:${effort || 'default'}`,
        provider: 'codex',
        model: entry.model,
        effort,
        label: effort ? `${entry.model} · ${effort}` : entry.model,
        description: `Codex model ${entry.model}${effort ? ` at ${effort} reasoning effort` : ''}.`,
        rank: 20 + index * 10 + (effort ? efforts.indexOf(effort) : 0),
        enabled,
        worker: true,
        router: true,
        images: true,
      }));
    });
  }

  resolveWorker(id) {
    if (!id || id === 'auto') return null;
    const direct = this.catalog().find(p => p.id === id && p.worker);
    if (direct) return direct;
    const legacy = [...PRESETS, ...ROUTER_PRESETS].find(p => p.id === id);
    if (!legacy) return null;
    const found = this.catalog().find(p => p.provider === 'codex' && p.model === legacy.model && p.effort === legacy.effort);
    return found
      ? { ...found, id: legacy.id, label: legacy.label, description: legacy.description }
      : { ...legacy, provider: 'codex', worker: true, router: false, images: true, enabled: true };
  }

  available(p) {
    if (p.provider === 'cursor-cli') return p.enabled !== false && this.cursor.status.loggedIn;
    if (p.provider === 'claude-cli') return p.enabled !== false && !!this.data.settings.claudeEnabled && this.claude.status.loggedIn;
    if (p.provider && p.provider !== 'codex') {
      return p.enabled !== false && !!this.data.settings.providers?.some(v => v.id === p.provider && v.enabled);
    }
    const live = this.models.some(m => m.model === p.model && (!p.effort || m.supportedReasoningEfforts.some(e => e.reasoningEffort === p.effort)));
    if (!live || p.enabled === false) return false;
    if (!this.account) return false;
    if (['free', 'go'].includes(this.account.plan)) return p.model.includes('terra') && (p.effort === 'low' || !p.effort);
    return true;
  }

  warmRouter() {
    if (this.data.settings.routing === 'jev' || this.connection !== 'ready' || !this.smartRouter.warm || this.planPreset()) return;
    const choice = this.routerChoices().find(p => p.id === this.data.settings.routerPreset && this.available(p));
    if (choice) this.smartRouter.warm(choice);
  }

  routerChoices() {
    return this.catalog().filter(p => p.router && p.enabled !== false &&
      (['codex', 'claude-cli', 'cursor-cli'].includes(p.provider) || this.data.settings.providers?.some(v => v.id === p.provider && v.enabled)));
  }

  providerSettings(value) {
    if (this.busy) throw new Error('Stop the current turn before changing providers or models.');
    if (value.action === 'provider') {
      const p = validateProvider(value.provider);
      const old = this.data.settings.providers?.find(v => v.id === p.id);
      if (old && old.baseUrl !== p.baseUrl) this.providers?.key(p.id).remove();
      this.data.settings.providers = [...(this.data.settings.providers || []).filter(v => v.id !== p.id), p];
    } else if (value.action === 'model' || value.action === 'enableDiscovered') {
      const ranks = this.catalog().map(p => p.rank);
      const nextRank = Math.min(1000, Math.max(0, ...(ranks.length ? ranks : [30])) + 5);
      const draft = value.action === 'enableDiscovered' ? {
        provider: value.provider,
        model: value.model,
        label: (value.label || value.model || '').trim() || value.model,
        description: typeof value.description === 'string' ? value.description : '',
        effort: value.provider === 'cursor-cli' ? '' : (value.effort || ''),
        rank: Number.isFinite(value.rank) ? value.rank : nextRank,
        enabled: true,
        worker: true,
        router: true,
        images: value.images === true,
      } : value.model;
      const m = validateModel(draft, [{ id: 'codex' }, { id: 'cursor-cli' }, ...(this.data.settings.providers || [])]);
      this.data.settings.providerModels = [...(this.data.settings.providerModels || []).filter(v => v.id !== m.id), m];
    } else if (value.action === 'toggleCodexModel') {
      if (typeof value.model !== 'string' || !value.model.trim() || typeof value.enabled !== 'boolean') throw new Error('Invalid Codex model selection.');
      if (!Array.isArray(this.data.settings.disabledCodexModels)) {
        const defaults = new Set(PRESETS.map(p => p.model));
        this.data.settings.disabledCodexModels = (this.models || []).map(m => m.model).filter(id => !defaults.has(id));
      }
      const disabled = new Set(this.data.settings.disabledCodexModels);
      if (value.enabled) disabled.delete(value.model); else disabled.add(value.model);
      this.data.settings.disabledCodexModels = [...disabled];
    } else if (value.action === 'toggle') {
      const m = this.catalog().find(p => p.id === value.id) || this.routerChoices().find(p => p.id === value.id);
      if (!m || typeof value.enabled !== 'boolean') throw new Error('Invalid model selection.');
      if (m.provider === 'codex' && String(m.id).startsWith('codex:')) {
        return this.providerSettings({ action: 'toggleCodexModel', model: m.model, enabled: value.enabled });
      }
      if ([...ROUTER_PRESETS, ...CLAUDE_MODELS].some(p => p.id === m.id)) {
        this.data.settings.disabledModels = [...new Set([...(this.data.settings.disabledModels || []).filter(id => id !== m.id), ...(!value.enabled ? [m.id] : [])])];
      } else this.data.settings.providerModels.find(p => p.id === m.id).enabled = value.enabled;
    } else throw new Error('Unknown provider action.');
    if (!this.account && this.connection === 'signed-out' && this.catalog().some(p => p.provider !== 'codex' && this.available(p))) {
      this.connection = 'ready'; this.error = null;
      const router = this.routerChoices().find(p => this.available(p));
      if (router) this.data.settings.routerPreset = router.id;
    }
    this.loaded.clear(); this.save(); this.changed(); return this.snapshot();
  }

  planPreset() {
    if (this.catalog().some(p => p.enabled && p.worker && p.provider !== 'codex' && this.available(p))) return null;
    if (!(this.account?.type === 'chatgpt' && ['free', 'go'].includes(this.account.plan))) return null;
    const terra = this.resolveWorker('terra-light') || { ...PRESETS.find(p => p.id === 'terra-light'), provider: 'codex', worker: true, images: true };
    return { ...terra, source: 'plan', reason: `Your ${this.account.plan} plan uses Terra light. No model-routing call is needed.` };
  }

  snapshot() {
    return {
      benchmarks: this.smartRouter.benchmarks?.summary(this.catalog().filter(p => p.worker && p.enabled && this.available(p))),
      cursor: this.cursor.status,
      claude: { ...this.claude.status, enabled: !!this.data.settings.claudeEnabled },
      ...this.data, settings: { ...this.data.settings, mode: this.planPreset() ? 'auto' : this.data.settings.mode }, planRouting: this.planPreset(), connection: this.connection, error: this.error, account: this.account, busy: this.busy,
      routing: this.routing, routerModel: this.data.settings.routing === 'jev' ? JEV_MODEL : this.routerChoices().find(p => p.id === this.data.settings.routerPreset)?.model || null,
      jev: { configured: !!this.smartRouter.jev?.configured, model: JEV_MODEL },
      contextRoot: this.contextSearch?.root || null,
      helperCapabilities: {
        projectContext: { codex: true, responsesApi: true, claudeCli: true, cursorCli: true },
        jevToolRecommendations: { codex: true, responsesApi: true, claudeCli: 'codex-thread-mcp-catalog', cursorCli: 'codex-thread-mcp-catalog' },
        largeOutputCapture: { codex: 'helper-gateway-only', responsesApi: 'helper-gateway-only', claudeCli: 'helper-mcp-only', cursorCli: 'helper-mcp-only' },
        note: 'Large-output capture applies to router_call_tool / project_context helper responses. It does not intercept native Codex, Claude, or Cursor tools. Claude/Cursor session MCP connects phasma_harness for project_context / router_read_output. router_find_tools / router_call_tool are intentionally Codex-scoped (Codex MCP catalog/gateway); without a Codex thread they return unsupported. Do not build parallel CLI catalogs for parity. This app does not rewrite project MCP configs or silently elevate MCP approvals.',
      },
      accessModes: ACCESS_MODES,
      requests: [...this.requests.values()].map(request => ({ ...request,
        canAccept: request.method !== 'mcpServer/elicitation/request' || isMcpConfirmation(request.params),
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
    this.providers?.setModel?.(choice);
    if (choice && session.activeProvider !== (choice.provider || 'codex')) this.loaded.delete(session.id);
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
    const params = {
      ...providerConfig, model: choice.model,
      cwd: this.workspace(session.workspace), approvalPolicy: permissions.approvalPolicy, approvalsReviewer: 'user',
      sandbox: permissions.id, serviceTier: 'default',
      config: { tool_output_token_limit: 4000, model_verbosity: 'low', ...providerConfig.config },
      developerInstructions: WORKER_INSTRUCTIONS + (contextEnabled ? CONTEXT_INSTRUCTIONS : '') + (helpersEnabled ? HELPER_INSTRUCTIONS +
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
        items.push(...page.data.map(entry => ({ ...entry.item, routeLabel: session.routes.find(r => r.turnId === entry.turnId)?.label })));
        cursor = page.nextCursor;
      } while (cursor);
      if (items.length) {
        for (const item of items) item.createdAt ??= session.items.find(saved => saved.id === item.id || (item.clientId && saved.clientId === item.clientId))?.createdAt;
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
    this.loaded.add(session.id);
  }

  async load(id) {
    const session = this.session(id);
    if (['claude-cli', 'cursor-cli'].includes(session.activeProvider)) return this.snapshot();
    if (this.connection === 'ready' && session.threadId && !this.loaded.has(id)) {
      await this.resume(session); this.changed();
    }
    return this.snapshot();
  }

  async send({ id, text, mode, images = [] }) {
    if (this.connection !== 'ready') throw new Error(this.error || 'Codex is still connecting.');
    if (!Array.isArray(images) || images.length > 4 || images.some(url => typeof url !== 'string' || !/^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(url)) || images.reduce((n, url) => n + url.length, 0) > 12 * 1024 * 1024) throw new Error('Invalid images: attach up to four PNG images under 8 MB total.');
    if (typeof text !== 'string' || (!text.trim() && !images.length) || text.length > 200000) throw new Error('Enter a message under 200,000 characters or attach an image.');
    if (!text.trim()) text = 'Analyze the attached image(s). Explain what you see and any relevant issue; ask for clarification if the intended task is unclear.';
    const session = this.session(id);
    if (this.busy) {
      if (this.busy !== id) throw new Error('Another turn is running. Switch to that session to queue a message.');
      if ((session.queue?.length || 0) >= 10) throw new Error('The queue is full (10 messages).');
      (session.queue ||= []).push({ id: randomUUID(), text, images, mode: mode || this.data.settings.mode });
      this.save(); this.changed();
      return { queued: true };
    }
    const permissions = accessMode(session.access);
    const chosenMode = mode || this.data.settings.mode;
    let selected = this.planPreset() || (chosenMode === 'auto' ? route(text) : { ...this.resolveWorker(chosenMode), source: 'manual', reason: 'Your manual selection.' });
    if (chosenMode !== 'auto' && !selected?.model) throw new Error('Unknown model selection.');
    if (this.planPreset() && !this.models.some(m => m.model === selected.model && m.supportedReasoningEfforts.some(e => e.reasoningEffort === selected.effort)))
      throw new Error('Terra light is not currently available on your account. Refresh your Codex login or restart the app.');
    const provider = this.data.settings.routing;
    const useSmart = !this.planPreset() && chosenMode === 'auto';
    const previousState = { status: session.status, error: session.error };
    this.busy = id; session.status = 'running'; session.error = null; session.turnId = null;
    const clientId = randomUUID();
    session.pendingMessage = { id: clientId, clientId, type: 'userMessage', pending: true, createdAt: Date.now(),
      content: [{ type: 'text', text }, ...images.map(url => ({ type: 'image', url }))] };
    this.changed();
    let submitted = false;
    try {
      if (this.stopping.has(id)) throw new Error('Turn was stopped before sending.');
      if (useSmart) {
        if (provider === 'smart' && !this.routerChoices().some(p => p.id === this.data.settings.routerPreset && this.available(p))) throw new Error('The selected router model is disabled or unavailable. Choose an enabled router in Settings.');
        this.routing = id; this.changed();
        try { selected = await this.smartRouter.choose(text, { ...session, ...previousState, routingCatalog: this.catalog().filter(p => p.worker && this.available(p) && (!images.length || p.images)), routerChoice: this.routerChoices().find(p => p.id === this.data.settings.routerPreset), jevQuickAnswers: this.data.settings.jevQuickAnswers, attachedImageCount: images.length }, this.models, provider, this.data.settings.routerPreset); }
        finally { this.routing = null; this.warmRouter(); }
        if (this.stopping.has(id)) throw new Error('Turn was stopped before sending.');
      }
      if (selected.directAnswer) {
        if (!session.items.some(i => i.type === 'userMessage')) session.title = text.trim().replace(/\s+/g, ' ').slice(0, 65);
        session.items.push({ ...session.pendingMessage, pending: false, localOnly: true },
          { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: selected.directAnswer, routeLabel: 'Jev · quick answer', localOnly: true, createdAt: Date.now() });
        (session.directContext ||= []).push({ question: text, answer: selected.directAnswer });
        session.routes.push({ ...selected, label: 'Jev quick answer', at: Date.now(), messageId: clientId });
        session.pendingMessage = null; session.status = 'completed'; session.updated = Date.now(); this.busy = null;
        this.save(); this.changed(); this.drainQueue(session);
        return selected;
      }
      if (!this.available(selected)) throw new Error('Selected model is disabled or not available.');
      if (images.length && selected.images === false) throw new Error('Enable image support for this model before sending images.');
      if (['claude-cli', 'cursor-cli'].includes(selected.provider)) return await this.sendCLI(session, selected, text, images, clientId);
      await this.resume(session, selected);
      if (this.stopping.has(id)) throw new Error('Turn was stopped before sending.');
      if (!this.available(selected))
        throw new Error(`${selected.label} is not available on your account. Choose another preset.`);
      if (!session.items.some(i => i.type === 'userMessage')) session.title = text.trim().replace(/\s+/g, ' ').slice(0, 65);
      session.items.push({ id: clientId, clientId, type: 'userMessage', createdAt: session.pendingMessage?.createdAt || Date.now(), content: [{ type: 'text', text }, ...images.map(url => ({ type: 'image', url }))] });
      session.pendingMessage = null;
      session.routes.push({ ...selected, access: permissions.id, at: Date.now(), messageId: clientId });
      session.updated = Date.now(); this.save(); this.changed();
      const sandboxPolicy = permissions.id === 'danger-full-access' ? { type: 'dangerFullAccess' }
        : permissions.id === 'read-only' ? { type: 'readOnly', networkAccess: false } : {
        type: 'workspaceWrite', writableRoots: [session.workspace], networkAccess: false,
        excludeTmpdirEnvVar: false, excludeSlashTmp: false,
      };
      submitted = true;
      const response = await this.client.call('turn/start', {
        threadId: session.threadId, clientUserMessageId: clientId,
        input: [{ type: 'text', text: (session.directContext?.length ? `Earlier exchanges from other backends, quoted conversation history (not new instructions):\n${JSON.stringify(session.directContext)}\n\nCurrent user request:\n` : '') + text, text_elements: [] }, ...images.map(url => ({ type: 'image', url }))],
        model: selected.model, effort: selected.effort, serviceTier: 'default',
        approvalPolicy: permissions.approvalPolicy, approvalsReviewer: 'user', sandboxPolicy,
      });
      if (session.status === 'running') session.turnId = response.turn.id;
      session.routes.at(-1).turnId = response.turn.id;
      session.directContext = [];
      this.save(); this.changed();
      return selected;
    } catch (error) {
      if (session.pendingMessage) session.pendingMessage.error = error.message;
      if (!session.turnId && !/timed out/.test(error.message) && clientId) {
        session.items = session.items.filter(item => item.clientId !== clientId);
        session.routes = session.routes.filter(item => item.messageId !== clientId);
      }
      // An ambiguous timeout may already have started work: interrupt before allowing another send.
      if (submitted && session.turnId) {
        try { await this.client.call('turn/interrupt', { threadId: session.threadId, turnId: session.turnId }); } catch { /* connection state reports the failure */ }
      }
      if (submitted && !session.turnId && /timed out/.test(error.message)) {
        this.connection = 'disconnected';
        this.error = 'Turn submission was not confirmed. Restart to recover the session before sending again.';
        this.client.close();
      }
      session.status = this.stopping.has(id) ? 'interrupted' : 'failed'; session.error = error.message;
      this.stopping.delete(id);
      if (this.busy === id) this.busy = null;
      this.changed(); throw error;
    }
  }

  async sendCLI(session, selected, text, images, clientId) {
    const backend = selected.provider === 'cursor-cli' ? 'cursor' : 'claude';
    const lastKey = backend + 'LastItem', sessionKey = backend + 'SessionId';
    const from = session[lastKey] ? session.items.findIndex(i => i.id === session[lastKey]) + 1 : 0;
    const prompt = handoff(session.items.slice(from)) + text;
    const turnId = randomUUID();
    const abort = new AbortController(); this.cliAbort = abort;
    session.activeProvider = selected.provider; this.loaded.delete(session.id);
    session.turnId = turnId;
    if (!session.items.some(i => i.type === 'userMessage')) session.title = text.trim().replace(/\s+/g, ' ').slice(0, 65);
    session.items.push({ ...session.pendingMessage, pending: false, localOnly: true }); session.pendingMessage = null;
    session.routes.push({ ...selected, at: Date.now(), messageId: clientId, turnId });
    const assistantIds = new Set(); let current;
    const assistant = id => {
      let item = session.items.find(i => i.id === id);
      if (!item) { item = { id, type: 'agentMessage', text: '', phase: 'final_answer', routeLabel: selected.label, localOnly: true, createdAt: Date.now() }; session.items.push(item); }
      assistantIds.add(id); return item;
    };
    this.save(); this.changed();
    try {
      const helpersEnabled = session.helperTools !== false;
      const contextEnabled = helpersEnabled && !!this.contextSearch?.supports(session.workspace);
      if (helpersEnabled) {
        session.helperTools = true;
        if (contextEnabled) session.contextTool = true;
      }
      const helpers = helpersEnabled && this.bridge.base ? this.bridge.childConfig(session.id) : null;
      const result = await this[backend].run({ cwd: this.workspace(session.workspace), model: selected.model, prompt, images,
        resume: session[sessionKey], access: session.access, signal: abort.signal, helpers,
        approve: tool => new Promise(resolve => {
          if (abort.signal.aborted) return resolve(false);
          const id = 'cli-' + randomUUID();
          this.helperApprovals.set(id, resolve);
          this.requests.set(id, { id, method: 'router/tool/requestApproval', params: { threadId: session.threadId,
            reason: tool?.title || 'Allow Cursor tool once?', command: JSON.stringify(tool?.rawInput || tool || {}, null, 2) } });
          this.changed();
        }),
        onEvent: event => {
          if (event.session_id) session[sessionKey] = event.session_id;
          if (event.type === 'stream_event') {
            const e = event.event;
            if (e.type === 'message_start') current = e.message.id;
            if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') assistant(current || `${turnId}-answer`).text += e.delta.text;
          }
          if (event.type === 'assistant') {
            const content = event.message?.content || [];
            const body = content.filter(c => c.type === 'text').map(c => c.text).join('\n');
            if (body) assistant(event.message.id || current || `${turnId}-answer`).text = body;
            for (const tool of content.filter(c => c.type === 'tool_use')) {
              if (!session.items.some(i => i.id === tool.id)) session.items.push({ id: tool.id, type: 'mcpToolCall', server: backend === 'cursor' ? 'Cursor' : 'Claude Code', tool: tool.name,
                arguments: tool.input, status: 'inProgress', localOnly: true, createdAt: Date.now() });
            }
          }
          if (event.type === 'user') for (const output of event.message?.content || []) {
            const item = session.items.find(i => i.id === output.tool_use_id);
            if (item) { item.status = output.is_error ? 'failed' : 'completed'; item.result = output.content; }
          }
          this.changed();
        } });
      if (!assistantIds.size && result.result) assistant(`${turnId}-answer`).text = result.result;
      const usage = result.usage || {};
      const total = session.usage?.total || {};
      session.usage = { total: { inputTokens: (total.inputTokens || 0) + (usage.input_tokens || 0) + (usage.cache_read_input_tokens || 0) + (usage.cache_creation_input_tokens || 0),
        cachedInputTokens: (total.cachedInputTokens || 0) + (usage.cache_read_input_tokens || 0), outputTokens: (total.outputTokens || 0) + (usage.output_tokens || 0) } };
      session.status = 'completed';
      if (result.permission_denials?.length) session.error = 'Claude Code could not run some tools under the selected permissions. Review the response before changing access.';
    } catch (error) { session.status = abort.signal.aborted ? 'interrupted' : 'failed'; session.error = error.message; }
    finally {
      const answer = session.items.filter(i => assistantIds.has(i.id)).map(i => i.text).join('\n');
      (session.directContext ||= []).push({ question: text, answer: answer || `[${backend} turn ${session.status}]` });
      if (session.status === 'completed') session[lastKey] = session.items.at(-1)?.id;
      else { session[lastKey] = null; session[sessionKey] = null; }
      session.updated = Date.now(); session.turnId = null;
      this.cancelHelpers(); this.cliAbort = null; this.busy = null; this.stopping.delete(session.id);
      this.save(); this.changed();
      if (session.status === 'completed') this.drainQueue(session);
    }
    return selected;
  }

  drainQueue(session) {
    setImmediate(() => {
      const next = session.queue?.[0];
      if (!this.busy && this.connection === 'ready' && next && !next.error && this.data.sessions.includes(session))
        this.queuedMessage(session.id, next.id, 'send').catch(() => {});
    });
  }

  async queuedMessage(id, messageId, action) {
    const session = this.session(id);
    if (action === 'steer' && ['claude-cli', 'cursor-cli'].includes(session.activeProvider)) throw new Error('This CLI supports queued follow-ups here. Stop the turn to send the correction immediately.');
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
    if (action === 'steer' && (this.busy !== id || !turnId || session.compacting || this.stopping.has(id))) throw new Error('Wait for an active turn before steering.');
    if (action === 'send' && this.busy) throw new Error('Wait for the active turn to finish.');
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
      } else await this.send({ ...message, id });
      session.queue = session.queue.filter(m => m !== message);
    } catch (error) {
      message.error = error.message;
      message.uncertain = /timed out|closed|disconnect/i.test(error.message);
      throw error;
    } finally { session.queueSending = false; this.save(); this.changed(); }
  }

  async compact(id) {
    if (this.connection !== 'ready') throw new Error('Codex is not connected.');
    if (this.busy) throw new Error('Wait for the current task to finish before compacting.');
    const session = this.session(id);
    if (['claude-cli', 'cursor-cli'].includes(session.activeProvider)) throw new Error('This CLI manages its context automatically. Manual compaction is available for Codex sessions.');
    if (!session.threadId || !session.items.some(item => item.type === 'userMessage')) throw new Error('Send a message before compacting this chat.');
    if (this.loading.has(id)) throw new Error('Wait for this chat to finish loading.');
    this.busy = id; session.compacting = true; session.error = null; session.pendingMessage = null;
    this.changed();
    try {
      await this.resume(session);
      if (this.stopping.has(id)) throw new Error('Compaction was stopped before starting.');
      await this.client.call('thread/compact/start', { threadId: session.threadId });
      // The response acknowledges dispatch; completion arrives as a notification.
    } catch (error) {
      session.compacting = false; session.error = error.message;
      this.stopping.delete(id);
      if (this.busy === id) this.busy = null;
      if (/timed out/.test(error.message)) { this.connection = 'disconnected'; this.error = 'Compaction status is unknown. Restart to reconnect.'; this.client.close(); }
      this.changed(); throw error;
    }
  }

  async stop() {
    if (!this.busy) return;
    const session = this.session(this.busy);
    if (this.cliAbort && ['claude-cli', 'cursor-cli'].includes(session.activeProvider)) { this.cancelHelpers(); this.cliAbort.abort(); return; }
    this.stopping.add(session.id);
    this.cancelHelpers();
    this.contextSearch?.cancel();
    if (this.routing === session.id) this.smartRouter.cancel();
    const turnId = this.activeTurns.get(session.id);
    if (turnId) {
      try { await this.client.call('turn/interrupt', { threadId: session.threadId, turnId }); }
      catch (error) { if (!/no active turn to interrupt/.test(error.message)) throw error; }
    }
    this.changed();
  }

  visible(item) {
    return item && ['userMessage', 'agentMessage', 'plan', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'contextCompaction'].includes(item.type);
  }

  notification({ method, params: p }) {
    if (method === 'account/login/completed' && p.success) { this.refreshAccount().catch(error => { this.error = error.message; this.changed(); }); return; }
    if (method === 'serverRequest/resolved') { this.requests.delete(p.requestId); this.changed(); return; }
    const session = this.data.sessions.find(s => s.threadId === p?.threadId);
    if (!session) return;
    if (method === 'turn/started') {
      session.turnId = p.turn.id; session.status = 'running';
      this.activeTurns.set(session.id, p.turn.id);
      if (session.routes.length && !session.compacting) session.routes.at(-1).turnId = p.turn.id;
      if (this.stopping.has(session.id)) this.stop().catch(error => { session.error = error.message; this.changed(); });
    }
    if (method === 'thread/tokenUsage/updated') {
      session.usage = p.tokenUsage;
      const turn = session.routes.find(r => r.turnId === p.turnId);
      if (turn) turn.usageReport = p.tokenUsage;
    }
    if (method === 'model/rerouted') {
      session.notice = `Codex rerouted ${p.fromModel} to ${p.toModel}: ${p.reason}`;
      session.noticeExpiresAt = Date.now() + 5000;
      const turn = session.routes.find(r => r.turnId === p.turnId);
      if (turn) turn.actualModel = p.toModel;
    }
    if (method === 'thread/compacted' && session.compacting && !this.activeTurns.has(session.id)) {
      session.compacting = false;
      session.notice = 'Context compacted. The visible chat history is retained.';
      session.noticeExpiresAt = Date.now() + 5000;
      this.stopping.delete(session.id);
      if (this.busy === session.id) this.busy = null;
    }
    if (method === 'turn/completed') {
      const drain = p.turn.status === 'completed' && !session.compacting && !this.stopping.has(session.id) && !session.queueSending;
      if (session.compacting && p.turn.status === 'completed') {
        session.notice = 'Context compacted. The visible chat history is retained.';
        session.noticeExpiresAt = Date.now() + 5000;
      }
      session.compacting = false;
      this.cancelHelpers();
      session.status = p.turn.status; session.turnId = null; session.error = p.turn.error?.message || null;
      if (this.busy === session.id) this.busy = null;
      this.stopping.delete(session.id);
      this.activeTurns.delete(session.id);
      for (const [id, request] of this.requests) if (request.params.threadId === session.threadId) this.requests.delete(id);
      if (drain) this.drainQueue(session);
    }
    if ((method === 'item/started' || method === 'item/completed') && this.visible(p.item)) {
      p.item.routeLabel = session.routes.at(-1)?.label;
      const index = session.items.findIndex(i => i.id === p.item.id || (p.item.clientId && i.clientId === p.item.clientId));
      p.item.createdAt = (index >= 0 ? session.items[index].createdAt : null) || Date.now();
      if (index < 0) session.items.push(p.item);
      else session.items[index] = { ...session.items[index], ...p.item,
        ...(p.item.type === 'userMessage' && session.items[index].clientId ? { content: session.items[index].content } : {}) };
    }
    if (method === 'item/agentMessage/delta') {
      let item = session.items.find(i => i.id === p.itemId);
      if (!item) { item = { id: p.itemId, type: 'agentMessage', text: '', routeLabel: session.routes.at(-1)?.label, createdAt: Date.now() }; session.items.push(item); }
      item.text += p.delta;
    }
    if (method === 'item/commandExecution/outputDelta') {
      const item = session.items.find(i => i.id === p.itemId);
      if (item) item.aggregatedOutput = ((item.aggregatedOutput || '') + p.delta).slice(-60000);
    }
    if (method === 'error') session.error = p.error?.message || p.message;
    session.updated = Date.now(); this.changed();
  }

  serverRequest(message) {
    if (message.method === 'item/tool/call') {
      const handler = message.params?.tool === CONTEXT_TOOL.name ? this.contextToolCall(message) : this.helperToolCall(message);
      handler.catch(() => {}); // Transport closure is reported by the client disconnect handler.
      return;
    }
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
      'item/permissions/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput', 'mcpServer/elicitation/request'];
    if (!supported.includes(message.method)) {
      this.client.rejectRequest(message.id, `This client cannot handle ${message.method}.`);
      return;
    }
    this.requests.set(message.id, message); this.changed();
  }

  async findContext(id, query, mode) {
    if (this.busy) throw new Error('Wait for the current turn to finish before using the search panel.');
    if (!this.contextSearch) throw new Error('Context search is unavailable.');
    return this.contextSearch.search(id ? this.session(id).workspace : this.data.settings.workspace, query, mode);
  }

  async contextToolCall(message) {
    const p = message.params;
    const session = this.data.sessions.find(s => s.threadId === p?.threadId);
    if (!session?.contextTool || this.busy !== session.id || this.stopping.has(session.id) ||
        this.activeTurns.get(session.id) !== p.turnId || p.tool !== CONTEXT_TOOL.name || p.namespace ||
        !p.arguments || Object.keys(p.arguments).some(key => key !== 'query') || this.contextRequests.has(message.id)) {
      this.client.rejectRequest(message.id, 'Unsupported or inactive project-context call.'); return;
    }
    this.contextRequests.add(message.id);
    try {
      const result = await this.contextSearch.search(session.workspace, p.arguments.query, this.data.settings.contextRanking || 'local');
      const output = session.helperTools ? this.toolHelpers.pack(session, result, { tool: CONTEXT_TOOL.name, workspace: session.workspace }, this.data.settings.largeResponses) : result;
      this.client.respond(message.id, { contentItems: [{ type: 'inputText', text: JSON.stringify(output) }], success: true });
    } catch {
      this.client.respond(message.id, { contentItems: [{ type: 'inputText', text: 'Context search failed or was stopped. Continue ordinary read-only project search if the task is still active.' }], success: false });
    } finally { this.contextRequests.delete(message.id); }
  }


  async bridgeTool(sessionId, tool, args, signal) {
    const session = this.session(sessionId);
    if (this.busy !== session.id || this.stopping.has(session.id) || !['claude-cli', 'cursor-cli'].includes(session.activeProvider)) {
      throw new Error('Helper MCP call rejected: no active Claude/Cursor turn for this session.');
    }
    if (signal?.aborted || this.cliAbort?.signal.aborted) throw new Error('Helper call stopped.');
    this.toolHelpers.jev = this.smartRouter.jev;
    if (tool === CONTEXT_TOOL.name) {
      if (!session.contextTool || !this.contextSearch) throw new Error('Project context is unavailable for this session.');
      if (!args || Object.keys(args).some(key => key !== 'query')) throw new Error('Invalid project-context arguments.');
      const result = await this.contextSearch.search(session.workspace, args.query, this.data.settings.contextRanking || 'local');
      return session.helperTools ? this.toolHelpers.pack(session, result, { tool: CONTEXT_TOOL.name, workspace: session.workspace }, this.data.settings.largeResponses) : result;
    }
    if (!session.helperTools || !HELPER_TOOLS.some(item => item.name === tool)) throw new Error('Unsupported or inactive tool-helper call.');
    if (tool === 'router_find_tools') {
      if (!args || Object.keys(args).some(key => key !== 'query')) throw new Error('Invalid discovery arguments.');
      if (!session.threadId) {
        return {
          source: 'unsupported', recommendation: null, candidates: [], catalogCount: 0,
          note: 'UNSUPPORTED on Claude/Cursor without a Codex thread: router_find_tools lists Codex-connected MCP servers. Use Claude/Cursor native tools, or continue in a Codex/Responses worker after connecting MCP servers there. project_context and router_read_output remain available through the bundled phasma_harness MCP.',
        };
      }
      const result = await this.toolHelpers.find(session.threadId, args.query, this.data.settings.toolSelection === 'jev');
      const decisions = session.toolDecisions ||= [];
      decisions.push({ at: Date.now(), source: result.source, recommendation: result.recommendation, confidence: result.confidence,
        usage: result.usage, durationMs: result.durationMs, warning: result.warning });
      session.toolDecisions = decisions.slice(-20); this.changed();
      return this.toolHelpers.pack(session, result, { tool: 'router_find_tools' }, this.data.settings.largeResponses);
    }
    if (tool === 'router_read_output') return this.toolHelpers.read(session, args);
    if (tool === 'router_call_tool') {
      if (!args || Object.keys(args).some(key => !['id', 'arguments'].includes(key)) || !args.arguments || typeof args.arguments !== 'object' || Array.isArray(args.arguments) || JSON.stringify(args.arguments).length > 65536) {
        throw new Error('Invalid MCP arguments.');
      }
      if (!session.threadId) {
        throw new Error('UNSUPPORTED on Claude/Cursor without a Codex thread: router_call_tool executes Codex-connected MCP tools only. Use native Claude/Cursor tools, or a Codex/Responses worker for the MCP gateway.');
      }
      const target = await this.toolHelpers.tool(session.threadId, args.id);
      if (this.busy !== session.id || this.stopping.has(session.id)) throw new Error('Task stopped.');
      if (session.access !== 'danger-full-access') {
        const id = `router-${randomUUID()}`;
        const approved = await new Promise(resolve => {
          this.helperApprovals.set(id, resolve);
          this.requests.set(id, { id, method: 'router/tool/requestApproval', params: { threadId: session.threadId,
            reason: `Allow connected tool ${target.server}/${target.name} once? Jev selection does not grant permission.`,
            command: JSON.stringify({ server: target.server, tool: target.name, arguments: args.arguments }, null, 2) } });
          this.changed();
        });
        if (!approved) throw new Error('Connected tool call declined or stopped.');
      }
      if (this.busy !== session.id || this.stopping.has(session.id)) throw new Error('Task stopped.');
      const raw = await this.client.call('mcpServer/tool/call', { threadId: session.threadId, server: target.server, tool: target.name, arguments: args.arguments });
      return this.toolHelpers.pack(session, raw, { server: target.server, tool: target.name, capturedAt: new Date().toISOString() }, this.data.settings.largeResponses);
    }
    throw new Error(`Unknown helper tool: ${tool}`);
  }

  cancelHelpers() {
    this.toolHelpers.cancel();
    for (const [id, resolve] of this.helperApprovals) { resolve(false); this.requests.delete(id); }
    this.helperApprovals.clear();
  }

  async helperToolCall(message) {
    const p = message.params, session = this.data.sessions.find(s => s.threadId === p?.threadId);
    const active = () => session?.helperTools && this.busy === session.id && !this.stopping.has(session.id) && this.activeTurns.get(session.id) === p.turnId;
    if (!active() || p.namespace || !HELPER_TOOLS.some(tool => tool.name === p.tool) || this.helperRequests.has(message.id) ||
        !p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments)) {
      this.client.rejectRequest(message.id, 'Unsupported or inactive tool-helper call.'); return;
    }
    this.helperRequests.add(message.id);
    try {
      const a = p.arguments;
      let result;
      this.toolHelpers.jev = this.smartRouter.jev;
      if (p.tool === 'router_find_tools') {
        if (Object.keys(a).some(key => key !== 'query')) throw new Error('Invalid discovery arguments.');
        result = await this.toolHelpers.find(session.threadId, a.query, this.data.settings.toolSelection === 'jev');
        const decisions = session.toolDecisions ||= [];
        decisions.push({ at: Date.now(), source: result.source, recommendation: result.recommendation, confidence: result.confidence,
          usage: result.usage, durationMs: result.durationMs, warning: result.warning });
        session.toolDecisions = decisions.slice(-20); this.changed();
        result = this.toolHelpers.pack(session, result, { tool: 'router_find_tools' }, this.data.settings.largeResponses);
      } else if (p.tool === 'router_read_output') result = this.toolHelpers.read(session, a);
      else {
        if (Object.keys(a).some(key => !['id', 'arguments'].includes(key)) || !a.arguments || typeof a.arguments !== 'object' || Array.isArray(a.arguments) || JSON.stringify(a.arguments).length > 65536) throw new Error('Invalid MCP arguments.');
        const tool = await this.toolHelpers.tool(session.threadId, a.id);
        if (!active()) throw new Error('Task stopped.');
        // Direct app-server calls must not bypass the user's Ask/workspace permissions.
        if (session.access !== 'danger-full-access') {
          const id = `router-${randomUUID()}`;
          const approved = await new Promise(resolve => {
            this.helperApprovals.set(id, resolve);
            this.requests.set(id, { id, method: 'router/tool/requestApproval', params: { threadId: session.threadId,
              reason: `Allow connected tool ${tool.server}/${tool.name} once? Jev selection does not grant permission.`,
              command: JSON.stringify({ server: tool.server, tool: tool.name, arguments: a.arguments }, null, 2) } });
            this.changed();
          });
          if (!approved) throw new Error('Connected tool call declined or stopped.');
        }
        if (!active()) throw new Error('Task stopped.');
        const raw = await this.client.call('mcpServer/tool/call', { threadId: session.threadId, server: tool.server, tool: tool.name, arguments: a.arguments });
        result = this.toolHelpers.pack(session, raw, { server: tool.server, tool: tool.name, capturedAt: new Date().toISOString() }, this.data.settings.largeResponses);
      }
      if (!active()) throw new Error('Task stopped; late tool output ignored.');
      // Keep native image/audio blocks intact instead of converting their base64 data to model text.
      let contentItems;
      if (Array.isArray(result.content) && result.content.some(item => item.type === 'image' || item.type === 'audio')) {
        contentItems = result.content.map(item => item.type === 'image' ? { type: 'inputImage', imageUrl: `data:${item.mimeType};base64,${item.data}` }
          : item.type === 'audio' ? { type: 'inputAudio', audioUrl: `data:${item.mimeType};base64,${item.data}` }
          : { type: 'inputText', text: item.type === 'text' ? item.text : JSON.stringify(item) });
        if (result.structuredContent !== undefined) contentItems.push({ type: 'inputText', text: JSON.stringify(result.structuredContent) });
      } else contentItems = [{ type: 'inputText', text: JSON.stringify(result) }];
      this.client.respond(message.id, { contentItems, success: result.isError !== true });
    } catch (error) {
      this.client.respond(message.id, { contentItems: [{ type: 'inputText', text: `Tool helper failed: ${error.message}. No automatic retry. Use native tools only if the task and permissions still allow it.` }], success: false });
    } finally { this.helperRequests.delete(message.id); }
  }

  answer(id, answer) {
    const request = this.requests.get(id);
    if (!request) throw new Error('This request has already been resolved.');
    if (this.helperApprovals.has(id)) {
      if (!['accept', 'decline'].includes(answer.decision)) throw new Error('Invalid approval response.');
      this.helperApprovals.get(id)(answer.decision === 'accept');
      this.helperApprovals.delete(id); this.requests.delete(id); this.changed(); return;
    }
    let result;
    if (/commandExecution|fileChange/.test(request.method)) {
      if (!['accept', 'decline'].includes(answer.decision)) throw new Error('Invalid approval response.');
      result = { decision: answer.decision };
    } else if (/permissions/.test(request.method)) {
      result = { permissions: answer.decision === 'accept' ? request.params.permissions : {}, scope: 'turn' };
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

  close() {
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

module.exports = { Controller };
