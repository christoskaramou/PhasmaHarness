'use strict';
// Providers, model catalog and routing models: which workers exist, which are usable, and usage limits.
// These are Controller methods (see ../controller.cjs); `this` is the Controller.
const { randomUUID } = require('node:crypto');
const { validateModel, validateProvider } = require('../providers/providers.cjs');
const { EFFORTS: CLAUDE_EFFORTS } = require('../providers/claude.cjs');
const { codexWindowReset } = require('../providers/limits.cjs');
const { PRESETS, ROUTER_PRESETS } = require('../routing/router.cjs');
const { DEFAULT_ROUTER, LEGACY_CLAUDE_ROUTERS, PROVIDER_NAMES, cheapRouter } = require('./shared.cjs');

module.exports = {
  // A saved provider choice always wins; only the plug (setProviderEnabled) changes it.
  // Without one (first run, or a store from before this setting), record what is in use now:
  // a provider whose CLI is signed in starts enabled. A provider whose state is unknown this run
  // (CLI failed to start or its status could not be read) is left unset and recorded on a later run.
  recordProviderDefaults() {
    const settings = this.data.settings;
    let changed = false;
    const record = (key, known, signedIn) => {
      if (typeof settings[key] === 'boolean' || !known) return;
      settings[key] = !!signedIn; changed = true;
    };
    record('chatgptEnabled', !!this.codex?.connected && typeof this.codex.signedIn === 'boolean', this.codex?.signedIn);
    record('claudeEnabled', this.claude.status.installed === false || !this.claude.status.error, this.claude.status.loggedIn);
    record('cursorEnabled', this.cursor.status.installed === false || !this.cursor.status.error, this.cursor.status.loggedIn);
    if (changed) this.save();
  },

  // Codex is optional: a missing CLI leaves Claude/Cursor usable.
  async connectCodex() {
    try {
      await this.client.start();
      this.codex = { installed: true, connected: true };
    } catch (error) {
      this.codex = { installed: error.code !== 'ENOENT', connected: false, error: error.message };
    }
    await this.refreshAccount();
  },

  async refreshAccount() {
    let account = null, models = [];
    if (this.codex.connected) {
      // A failed Codex load only removes Codex for this refresh; Claude/Cursor stay usable and a later refresh can recover.
      try {
        account = (await this.client.call('account/read', { refreshToken: false })).account;
        this.codex.signedIn = !!account;
        // Disconnected in the Harness: the Codex CLI stays signed in, but ChatGPT and its models are not used here.
        if (this.data.settings.chatgptEnabled === false) account = null;
        let cursor = null;
        if (account) do {
          const page = await this.client.call('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
          models.push(...(page.data || []));
          cursor = page.nextCursor || null;
        } while (cursor && models.length < 500);
        delete this.codex.error;
      } catch (error) { account = null; models = []; this.codex.error = error.message; }
    } else if (this.codex) this.codex.signedIn = false;
    // ChatGPT usage windows (best effort; other account types report none).
    if (account?.type === 'chatgpt') {
      try { this.codexUsage((await this.client.call('account/rateLimits/read', { excludeResetCreditDetails: true })).rateLimits); }
      catch { /* usage is informational */ }
    }
    const nextAccount = account ? { type: account.type, plan: account.planType, email: account.email || null } : null;
    if (JSON.stringify(this.account) !== JSON.stringify(nextAccount)) this.smartRouter.close?.();
    this.account = nextAccount;
    this.models = models;
    this.connection = this.account || this.catalog().some(p => p.provider !== 'codex' && this.available(p)) ? 'ready' : 'signed-out';
    this.error = this.connection === 'ready' ? null
      : this.codex.connected ? this.codex.error || 'Connect ChatGPT or enable an API provider in Settings.'
        : 'No provider is connected. Install or connect one in Settings → Providers.';
    this.adoptRouter();
    this.changed();
  },

  // Disconnect only stops the Harness from using a provider. The CLI logins are shared with Codex CLI, Claude Code
  // and Cursor outside the Harness, so they are never signed out from here.
  setProviderEnabled(id, enabled) {
    if (this.busy) throw new Error('Stop the current turn before changing providers.');
    const key = { codex: 'chatgptEnabled', 'claude-cli': 'claudeEnabled', 'cursor-cli': 'cursorEnabled' }[id];
    if (!key || typeof enabled !== 'boolean') throw new Error('Unknown provider.');
    this.data.settings[key] = enabled;
  },

  // Without ChatGPT, fall back to an available router instead of keeping an unusable Codex one.
  adoptRouter() {
    if (this.account || this.connection !== 'ready' || this.routerChoices().some(p => p.id === this.data.settings.routerPreset && this.available(p))) return;
    const router = cheapRouter(this.routerChoices().filter(p => this.available(p)));
    if (router) this.data.settings.routerPreset = router.id;
  },

  catalog() {
    return [...this.codexWorkers(), ...this.claudeWorkers(), ...this.providerWorkers()].sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
  },

  // Enabled provider models. A Cursor model whose reasoning levels Cursor reports becomes one worker per level
  // (cursor-cli:<model>:<level>), like Codex and Claude; enabling stays per model (its saved entry).
  providerWorkers() {
    return (this.data.settings.providerModels || []).flatMap(entry => {
      if (entry.provider !== 'cursor-cli') return [entry];
      const found = (this.cursor.models || []).find(m => m.id === entry.model);
      const base = entry.parameterized || found?.parameterized ? { ...entry, parameterized: true, parameters: entry.cursorParameters || [] } : entry;
      if (!found?.efforts?.length) return [base];
      return found.efforts.map((effort, i) => ({ ...base, baseId: entry.id, id: `cursor-cli:${found.id}:${effort}`,
        effort, effortOption: found.effortOption, preferred: effort === entry.cursorEffort,
        label: `${entry.label} · ${found.effortNames?.[effort] || effort}`, modelLabel: entry.label, rank: entry.rank + i / 100 }));
    });
  },

  // Older Cursor entries hold a variant ID from Cursor's old list (grok-4.7[context=256k,reasoning_effort=high,fast=true]);
  // the current list names the base model (grok-4.7) with separate parameters. Once that list is loaded, fold every
  // entry of a listed model into one entry per base model: enabled if any was, keeping the enabled variant's other
  // parameters and level (where the model still accepts them). Old IDs stay as aliases, and saved selections follow.
  migrateCursorEntries() {
    const models = (this.cursor.models || []).filter(m => m.parameterized);
    if (!models.length) return false;
    const settings = this.data.settings, groups = new Map(), result = [];
    for (const entry of settings.providerModels || []) {
      const found = entry.provider === 'cursor-cli' && models.find(m => m.id === String(entry.model).split('[')[0]);
      if (!found) { result.push(entry); continue; }
      if (!groups.has(found.id)) { groups.set(found.id, { found, entries: [] }); result.push(found.id); }
      groups.get(found.id).entries.push(entry);
    }
    let changed = false;
    const renamed = new Map();
    const merge = ({ found, entries }) => {
      const id = `cursor-cli:${found.id}:default`;
      const enabled = entries.filter(e => e.enabled !== false);
      const source = enabled.find(e => String(e.model).includes('[')) || enabled[0] || entries[0];
      const saved = (/\[(.*)\]$/.exec(source.model)?.[1] || '').split(',').map(pair => pair.split('='))
        .filter(([key, value]) => key && value !== undefined).map(([key, value]) => ({ id: key.trim(), value: value.trim() }))
        .filter(p => found.parameters?.[p.id]?.includes(p.value));
      const parameters = saved.length ? saved.filter(p => p.id !== found.effortOption) : (source.cursorParameters || []);
      const cursorEffort = saved.find(p => p.id === found.effortOption)?.value ?? source.cursorEffort;
      const aliases = [...new Set(entries.flatMap(e => [e.id, ...(e.aliases || [])]))].filter(a => a !== id);
      const merged = { ...(entries.find(e => e.model === found.id) || source), id, model: found.id, label: found.label, enabled: enabled.length > 0,
        parameterized: true, cursorParameters: parameters, ...(cursorEffort ? { cursorEffort } : {}), ...(aliases.length ? { aliases } : {}) };
      if (entries.length !== 1 || JSON.stringify(entries[0]) !== JSON.stringify(merged)) changed = true;
      for (const e of entries) if (e.id !== id) renamed.set(e.id, { merged, found });
      return merged;
    };
    settings.providerModels = result.map(item => typeof item === 'string' ? merge(groups.get(item)) : item);
    for (const key of ['mode', 'routerPreset']) {
      const hit = renamed.get(settings[key]);
      if (!hit) continue;
      const { merged, found } = hit;
      const effort = found.efforts?.includes(merged.cursorEffort) ? merged.cursorEffort : found.efforts?.includes('medium') ? 'medium' : found.efforts?.[0];
      settings[key] = effort ? `cursor-cli:${found.id}:${effort}` : merged.id;
      changed = true;
    }
    if (changed) this.save();
    return changed;
  },

  // Load Cursor's model list, then fold older saved entries into it.
  async discoverCursor() {
    const models = await this.cursor.discover();
    if (this.migrateCursorEntries()) this.loaded.clear();
    this.changed();
    return models;
  },

  // Like Codex: one worker per Claude model and supported effort (claude-cli:<model>:<effort>), so the router picks
  // the effort per task. A model without effort levels keeps one entry, claude-cli:<model>. Enabling is per model.
  claudeWorkers() {
    const disabled = new Set(this.data.settings.disabledModels || []);
    return this.claude.models.flatMap(p => {
      const enabled = !!this.data.settings.claudeEnabled && !disabled.has(p.id);
      const efforts = p.efforts?.length ? p.efforts : [null];
      return efforts.map(effort => ({
        ...p, baseId: p.id, id: effort ? `${p.id}:${effort}` : p.id, effort, enabled,
        label: effort ? `${p.label} · ${effort}` : p.label,
        rank: (Number.isFinite(p.rank) ? p.rank : 35) + (effort ? CLAUDE_EFFORTS.indexOf(effort) : 0),
      }));
    });
  },

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
  },

  resolveWorker(id) {
    if (!id || id === 'auto') return null;
    const direct = this.catalog().find(p => p.id === id && p.worker);
    if (direct) return direct;
    // An ID saved before efforts were per worker (claude-cli:<model>, cursor-cli:<model>:default, or an older Cursor
    // variant ID kept as an alias): that model at its saved level, else medium, else its lowest.
    const variants = this.catalog().filter(p => p.worker && (p.baseId === id || p.aliases?.includes(id)));
    if (variants.length) return variants.find(p => p.preferred) || variants.find(p => p.effort === 'medium') || variants[0];
    const legacy = [...PRESETS, ...ROUTER_PRESETS].find(p => p.id === id);
    if (!legacy) return null;
    const found = this.catalog().find(p => p.provider === 'codex' && p.model === legacy.model && p.effort === legacy.effort);
    return found
      ? { ...found, id: legacy.id, label: legacy.label, description: legacy.description }
      : { ...legacy, provider: 'codex', worker: true, router: false, images: true, enabled: true };
  },

  available(p) {
    if (p.provider === 'cursor-cli') return p.enabled !== false && this.data.settings.cursorEnabled !== false && this.cursor.status.loggedIn;
    if (p.provider === 'claude-cli') return p.enabled !== false && !!this.data.settings.claudeEnabled && this.claude.status.loggedIn;
    if (p.provider && p.provider !== 'codex') {
      // API providers run through the Codex app-server.
      return p.enabled !== false && this.codex.connected && !!this.data.settings.providers?.some(v => v.id === p.provider && v.enabled);
    }
    const live = this.models.some(m => m.model === p.model && (!p.effort || m.supportedReasoningEfforts.some(e => e.reasoningEffort === p.effort)));
    if (!live || p.enabled === false) return false;
    if (!this.account) return false;
    if (['free', 'go'].includes(this.account.plan)) return p.model.includes('terra') && (p.effort === 'low' || !p.effort);
    return true;
  },

  warmRouter() {
    if (this.data.settings.routing === 'jev' || this.connection !== 'ready' || !this.smartRouter.warm || this.planPreset()) return;
    const choice = this.routerChoices().find(p => p.id === this.data.settings.routerPreset && this.available(p));
    if (choice) this.smartRouter.warm(choice);
  },

  // Claude IDs come from discovery (claude-cli:<resolved model>), so there is no fixed alias to fall back to.
  // Keep a working router if one is set; otherwise prefer the cheapest Claude tier, Haiku.
  claudeRouterFallback() {
    if (this.routerChoices().some(p => p.id === this.data.settings.routerPreset && this.available(p))) return;
    const router = cheapRouter(this.routerChoices().filter(p => p.provider === 'claude-cli' && this.available(p)));
    if (router) this.data.settings.routerPreset = router.id;
  },

  // The configured router, or, while its provider is at a usage limit, the cheapest available router of another provider.
  effectiveRouter() {
    const configured = this.routerChoices().find(p => p.id === this.data.settings.routerPreset);
    if (!configured || !this.limits.limited(configured.provider || 'codex', configured.model)) return configured;
    return cheapRouter(this.routerChoices().filter(p => this.available(p) && !this.limits.limited(p.provider || 'codex', p.model))) || configured;
  },

  // After a worker turn: a success clears the provider's limit; a usage limit is recorded, and the same Auto message is
  // queued once more so the router picks another provider. Manual selections, repeats and non-Auto turns only report it.
  // A Stop (which pauses the queue) or a paused queue is never overridden by the retry.
  providerOutcome(session, provider, model, messageId, outcome) {
    provider ||= 'codex';
    const last = this.lastSends.get(session.id);
    if (outcome.status === 'completed') {
      // Only a limit that covers the model that just worked is lifted (a Claude Opus limit survives a Sonnet turn).
      if (this.limits.limited(provider, model)) { this.limits.clear(provider, model); this.save(); this.changed(); }
      if (last?.clientId === messageId) this.lastSends.delete(session.id);
      return;
    }
    if (!outcome.limit) return;
    const entry = this.limits.mark(provider, outcome.limit);
    this.log.warn('Usage limit', { provider, family: entry?.family || null, until: entry?.until, reason: String(outcome.limit.reason || '').slice(0, 200) });
    const family = entry?.family ? ` ${entry.family[0].toUpperCase()}${entry.family.slice(1)}` : '';
    const name = (PROVIDER_NAMES[provider] || this.data.settings.providers?.find(p => p.id === provider)?.name || provider) + family;
    const until = entry?.known ? ` until ${new Date(entry.until).toLocaleString()}` : '';
    const retry = last && last.clientId === messageId && !last.failover && !session.queuePaused &&
      this.catalog().some(p => p.worker && this.available(p) && !this.limits.limited(p.provider || 'codex', p.model));
    this.lastSends.delete(session.id);
    if (!retry) {
      session.error = `${name} reached its usage limit${until}. ${outcome.error || ''}`.trim();
      this.save(); this.changed(); return;
    }
    (session.queue ||= []).unshift({ id: randomUUID(), text: last.text, images: last.images, mode: 'auto', task: last.task, failover: true });
    session.error = null;
    session.notice = `${name} reached its usage limit${until}; sending your message again with another provider.`;
    session.noticeExpiresAt = Date.now() + 10000;
    this.save(); this.changed(); this.settle(session);
  },

  // Codex (ChatGPT) usage windows; a window at 100% marks Codex limited until it resets.
  // Opt-in (Settings → Routing → Compare with Jev): after a message is routed, ask Jev in the background which
  // worker it would pick and log it next to the one that runs. Log only: routing and the worker are unaffected,
  // and a comparison still running when the next message is sent makes that message skip it.
  compareWithJev(session, text, images, selected, previousState) {
    const settings = this.data.settings;
    if (settings.jevCompare !== true || settings.routing === 'jev' || !this.jevCompare || !this.smartRouter.jev?.configured || !this.smartRouter.shadowJev) return;
    if (!selected?.id || selected.directAnswer || selected.wikiTaskId || this.jevComparing) return;
    const usable = this.catalog().filter(p => p.worker && this.available(p) && (!images.length || p.images));
    const unlimited = usable.filter(p => !this.limits.limited(p.provider || 'codex', p.model));
    // A copy of the conversation as it was before this message, like the router saw it.
    const context = { ...session, ...previousState, items: [...(session.items || [])], routes: [...(session.routes || [])], directContext: [...(session.directContext || [])],
      configuredChecks: settings.checks?.[session.workspace] || [], routingCatalog: unlimited.length ? unlimited : usable, attachedImageCount: images.length };
    const used = { id: selected.id, provider: selected.provider || 'codex', model: selected.model, effort: selected.effort || null, source: selected.source === 'manual' ? 'manual' : 'router' };
    const abort = new AbortController();
    this.jevComparing = abort;
    this.smartRouter.shadowJev(text, context, AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]))
      .then(jev => this.jevCompare.record({ at: Date.now(), used, jev }),
        error => { if (!abort.signal.aborted) this.jevCompare.record({ at: Date.now(), used, error: String(error?.message || error).slice(0, 160) }); })
      .finally(() => { if (this.jevComparing === abort) this.jevComparing = null; if (!abort.signal.aborted) this.changed(); });
  },

  // A rolling update is merged into the last read only for the same limit bucket (other buckets are per-model quotas).
  // With credits, usage can continue past a full window, so only a failed turn marks the limit then.
  codexUsage(snapshot, merge = false) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const previous = merge ? this.limits.usage.codex || {} : {};
    if (merge && snapshot.limitId && snapshot.limitId !== (previous.limitId || 'codex')) return;
    const pick = key => snapshot[key] ?? previous[key] ?? null;
    const usage = { limitId: pick('limitId'), primary: pick('primary'), secondary: pick('secondary'), credits: pick('credits'), planType: pick('planType'), rateLimitReachedType: pick('rateLimitReachedType') };
    this.limits.setUsage('codex', usage);
    if (usage.credits?.hasCredits || usage.credits?.unlimited) return;
    const reset = codexWindowReset(usage, Date.now());
    if (reset !== undefined) this.limits.mark('codex', { until: reset, reason: 'ChatGPT usage limit reached.' });
  },

  codexLimitReset() {
    const reset = codexWindowReset(this.limits.usage.codex, Date.now());
    return reset ?? null;
  },

  // Before discovery, Claude router IDs were aliases (claude-cli:haiku). Map a saved alias to a discovered model,
  // or back to the default Codex router, so routing does not fail on an ID that no longer exists.
  migrateLegacyRouter() {
    this.migrateClaudeEfforts();
    if (!LEGACY_CLAUDE_ROUTERS.includes(this.data.settings.routerPreset)) return;
    // Keep the family the user chose: the model the CLI alias resolves to, else a discovered model of that family.
    const family = this.data.settings.routerPreset.slice('claude-cli:'.length);
    const claude = this.routerChoices().filter(p => p.provider === 'claude-cli' && this.available(p));
    const named = claude.filter(p => p.model.toLowerCase().includes(family));
    const same = claude.find(p => p.aliases?.includes(family)) || named.find(p => !p.model.endsWith('[1m]')) || named[0];
    if (same) { this.data.settings.routerPreset = same.id; return; }
    this.claudeRouterFallback();
    const preset = this.data.settings.routerPreset;
    if (LEGACY_CLAUDE_ROUTERS.includes(preset) && !this.routerChoices().some(p => p.id === preset)) this.data.settings.routerPreset = DEFAULT_ROUTER;
  },

  // Claude selections saved as claude-cli:<model> before efforts were per worker: the router moves to that model's
  // lowest effort (cheapest), a manual worker selection to the effort chosen earlier in Settings, else medium.
  migrateClaudeEfforts() {
    const settings = this.data.settings;
    if (!this.claude.models.length) return;
    const variants = id => this.catalog().filter(p => p.provider === 'claude-cli' && p.baseId === id && p.id !== id);
    const router = variants(settings.routerPreset);
    if (router.length) settings.routerPreset = router[0].id;
    const mode = variants(settings.mode);
    if (mode.length) {
      const chosen = settings.claudeEfforts?.[mode[0].model];
      settings.mode = (mode.find(p => p.effort === chosen) || mode.find(p => p.effort === 'medium') || mode[0]).id;
    }
    delete settings.claudeEfforts;
  },

  routerChoices() {
    return this.catalog().filter(p => p.router && p.enabled !== false &&
      (['codex', 'claude-cli', 'cursor-cli'].includes(p.provider) || this.data.settings.providers?.some(v => v.id === p.provider && v.enabled)));
  },

  providerSettings(value) {
    if (this.busy) throw new Error('Stop the current turn before changing providers or models.');
    if (value.action === 'provider') {
      const p = validateProvider(value.provider);
      const old = this.data.settings.providers?.find(v => v.id === p.id);
      if (old && old.baseUrl !== p.baseUrl) this.providers?.key(p.id).remove();
      this.data.settings.providers = [...(this.data.settings.providers || []).filter(v => v.id !== p.id), p];
    } else if (value.action === 'removeProvider') {
      const provider = (this.data.settings.providers || []).find(p => p.id === value.id);
      if (!provider) throw new Error('Unknown provider.');
      this.providers?.key(provider.id).remove();
      this.data.settings.providers = this.data.settings.providers.filter(p => p.id !== provider.id);
      this.data.settings.providerModels = (this.data.settings.providerModels || []).filter(m => m.provider !== provider.id);
      // Nothing may keep pointing at the removed provider's models (other providers' choices are left alone).
      const settings = this.data.settings, removed = id => String(id || '').startsWith(provider.id + ':');
      if (removed(settings.mode)) settings.mode = 'auto';
      if (removed(settings.routerPreset))
        settings.routerPreset = cheapRouter(this.routerChoices().filter(p => this.available(p)))?.id || DEFAULT_ROUTER;
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
      // A model from Cursor's current list is a base name: it runs with the parameterized model picker.
      if (m.provider === 'cursor-cli' && (this.cursor.models || []).some(c => c.id === m.model && c.parameterized)) m.parameterized = true;
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
      const m = this.catalog().find(p => p.id === value.id) || this.catalog().find(p => p.baseId === value.id) || this.routerChoices().find(p => p.id === value.id);
      if (!m || typeof value.enabled !== 'boolean') throw new Error('Invalid model selection.');
      if (m.provider === 'codex' && String(m.id).startsWith('codex:')) {
        return this.providerSettings({ action: 'toggleCodexModel', model: m.model, enabled: value.enabled });
      }
      if (m.provider === 'claude-cli' || ROUTER_PRESETS.some(p => p.id === m.id)) {
        // Claude models are enabled as a whole (all their efforts), like Codex.
        const key = m.baseId || m.id;
        this.data.settings.disabledModels = [...new Set([...(this.data.settings.disabledModels || []).filter(id => id !== key), ...(!value.enabled ? [key] : [])])];
      } else this.data.settings.providerModels.find(p => p.id === (m.baseId || m.id)).enabled = value.enabled;
    } else throw new Error('Unknown provider action.');
    if (!this.account && this.connection === 'signed-out' && this.catalog().some(p => p.provider !== 'codex' && this.available(p))) {
      this.connection = 'ready'; this.error = null;
      const router = this.routerChoices().find(p => this.available(p));
      if (router) this.data.settings.routerPreset = router.id;
    }
    this.loaded.clear(); this.save(); this.changed(); return this.snapshot();
  },

  planPreset() {
    if (this.catalog().some(p => p.enabled && p.worker && p.provider !== 'codex' && this.available(p))) return null;
    if (!(this.account?.type === 'chatgpt' && ['free', 'go'].includes(this.account.plan))) return null;
    const terra = this.resolveWorker('terra-light') || { ...PRESETS.find(p => p.id === 'terra-light'), provider: 'codex', worker: true, images: true };
    return { ...terra, source: 'plan', reason: `Your ${this.account.plan} plan uses Terra light. No model-routing call is needed.` };
  },
};
