const { randomUUID } = require('node:crypto');

const GENERAL = {
  backgroundUsageLimit: 'Whole percentage from 1 to 100', routingModel: 'jev or an ID from routerChoices',
  effortCap: ['low', 'medium', 'high', 'xhigh', 'max'],
  jevEnabled: 'boolean', jevQuickAnswers: 'boolean', jevCompare: 'boolean', wikiAssessment: 'boolean',
  contextRanking: ['local', 'jev'], toolSelection: ['off', 'jev'], largeResponses: 'boolean',
};
const LOCAL = { workspace: 'Absolute folder path', access: ['read-only', 'workspace-write', 'danger-full-access'], mode: 'auto or a model ID' };
const SPECIAL = {
  appearance: ['system', 'dark', 'light'], onExit: ['close', 'tray'], startAtSignIn: 'boolean',
  browserAccess: '{ enabled: boolean, port: integer, origin: HTTPS address or null }',
  providerConnection: '{ id: provider ID, enabled: boolean }',
  providers: 'Provider action: { action: provider, provider: { id, name, baseUrl, enabled } } or { action: removeProvider, id }',
  models: 'Model action: { action: toggle, id, enabled }, { action: toggleCodexModel, model, enabled }, or { action: enableDiscovered, provider, model, label }',
  providerKey: '{ id: provider ID, key: new secret or null to remove }; reads show configured flags only',
  jevKey: 'New secret or null to remove; reads show configured status only',
  checks: 'Array of workspace checks using the existing Checks format', wikiFolder: 'Absolute wiki folder or null to reset',
  benchmarks: 'Validated benchmark snapshot or null to reset to bundled evidence',
};
const MANUAL = new Set(['access', 'workspace', 'browserAccess', 'providers', 'providerConnection', 'providerKey', 'jevKey', 'checks', 'wikiFolder', 'startAtSignIn']);
const object = value => value && typeof value === 'object' && !Array.isArray(value);
// How long an agent's settings request waits for the user before it counts as declined.
const CONFIRM_MS = 120000;

class SettingsTools {
  constructor({ agents, controller, wikiStore }) {
    Object.assign(this, { agents, controller, wikiStore });
    this.requests = [];
    this.host = {};
    agents.on('state', () => setImmediate(() => this.flush()));
  }

  get busy() { return this.applying || this.requests.some(item => ['confirming', 'queued'].includes(item.status)); }
  snapshot() { return this.requests.map(({ id, name, agentId, status, error }) => ({ id, name, agentId, status, ...(error ? { error } : {}) })); }
  changed() { this.controller.changed(); }
  target(caller, agentId) { return this.agents.controller(agentId || caller.agentId || 'main'); }

  read(caller, args) {
    if (!object(args) || Object.keys(args).some(key => !['names', 'agentId'].includes(key))) throw new Error('Use names and agentId only.');
    const target = this.target(caller, args.agentId), primary = this.controller;
    const available = { ...GENERAL, ...LOCAL, ...SPECIAL, about: 'Read-only version information' };
    const names = args.names === undefined ? Object.keys(available) : args.names;
    if (!Array.isArray(names) || names.some(name => !Object.hasOwn(available, name))) throw new Error('Unknown setting name. Read without names to list supported settings.');
    const settings = {};
    for (const name of names) {
      let value;
      if (name === 'routingModel') value = primary.data.settings.routing === 'jev' ? 'jev' : primary.data.settings.routerPreset;
      else if (Object.hasOwn(GENERAL, name)) value = primary.data.settings[name] ?? null;
      else if (Object.hasOwn(LOCAL, name)) value = target.data.settings[name];
      else if (name === 'checks') value = primary.data.settings.checks?.[target.data.settings.workspace] || [];
      else if (name === 'wikiFolder') value = this.wikiFolder(target.data.settings.workspace);
      else if (name === 'models') value = primary.catalog();
      else if (name === 'providers' || name === 'providerKey') value = (primary.data.settings.providers || []).map(({ id, name: label, baseUrl, enabled }) =>
        ({ id, name: label, ...(name === 'providerKey' ? {} : { baseUrl, enabled }), configured: !!primary.providers?.configured(id) }));
      else if (name === 'jevKey') value = { configured: !!primary.smartRouter.jev?.keyStore?.configured };
      else if (name === 'benchmarks') value = args.names ? primary.smartRouter.benchmarks.data
        : { records: primary.smartRouter.benchmarks.data.records?.length || 0, note: 'Read names:[benchmarks] for the complete evidence snapshot.' };
      else if (name === 'providerConnection') {
        const state = primary.snapshot();
        value = { codex: primary.data.settings.chatgptEnabled !== false, 'claude-cli': !!primary.data.settings.claudeEnabled,
          'cursor-cli': primary.data.settings.cursorEnabled !== false,
          ...Object.fromEntries(Object.entries(state.nativeCLIs || {}).map(([id, state]) => [id, state.enabled])) };
      } else value = this.host.read?.(name) ?? (name === 'about' ? { version: require('../package.json').version, packaged: false } : null);
      settings[name] = { value, ...(name === 'routingModel' && value === 'jev' ? { providerModel: primary.smartRouter.jev?.model || null } : {}), format: available[name], writable: !!this.host.ask && name !== 'about' && !MANUAL.has(name) &&
        (!['appearance', 'onExit', 'startAtSignIn', 'browserAccess', 'providerKey', 'jevKey'].includes(name) || !!this.host.write),
        confirmationRequired: name !== 'about' && !MANUAL.has(name) };
    }
    return { agentId: target.agentId, settings, routerChoices: primary.routerChoices(), changes: this.snapshot(),
      note: 'Security settings are manual-only. Secrets are never returned. Write one setting per call; queued changes apply after active work finishes. Queued requests are cancelled on app restart.' };
  }

  // Reading where the wiki lives creates nothing and never fails the whole read (a moved workspace reports null).
  wikiFolder(workspace) {
    try {
      return this.wikiStore.location(workspace).root;
    } catch {
      return null;
    }
  }

  async write(caller, args) {
    if (!object(args) || Object.keys(args).some(key => !['name', 'value', 'agentId'].includes(key)) ||
        !Object.hasOwn(args, 'value') || !Object.hasOwn({ ...GENERAL, ...LOCAL, ...SPECIAL }, args.name))
      throw new Error('Choose a supported setting name, value and optional agentId.');
    const { name } = args;
    if (MANUAL.has(name)) throw new Error('This security setting is manual-only. Change it in Settings.');
    const target = this.target(caller, args.agentId);
    if (this.agents.closing) throw new Error('The runner is stopping.');
    if (this.requests.filter(item => ['confirming', 'queued'].includes(item.status)).length >= 10) throw new Error('Ten settings changes are already waiting. Finish the current reply first.');
    const json = JSON.stringify(args.value);
    if (typeof json !== 'string') throw new Error('Setting value must be JSON.');
    if (json.length > (name === 'benchmarks' ? 1024 * 1024 : 32768)) throw new Error('Setting value is too large.');
    const value = JSON.parse(json);
    if (Object.hasOwn(GENERAL, name) || Object.hasOwn(LOCAL, name)) {
      const format = GENERAL[name] || LOCAL[name];
      if ((Array.isArray(format) && !format.includes(value)) || (format === 'boolean' && typeof value !== 'boolean')) throw new Error('Invalid setting value.');
    }
    const record = { id: randomUUID(), name, agentId: target.agentId, value, status: 'confirming' };
    this.requests = this.requests.filter((item, index) =>
      ['confirming', 'queued', 'applying'].includes(item.status) || index >= this.requests.length - 19);
    this.requests.push(record);
    this.changed();
    // The confirmation belongs to the turn that asked: it expires, and an answer after that turn ended applies nothing.
    const sessionId = caller.busy, turnId = sessionId ? caller.activeTurns.get(sessionId) : null;
    let timer;
    try {
      const accepted = await Promise.race([
        this.host.ask?.({ title: 'Allow settings change?', message: `${this.agents.agentName(caller.agentId)} wants to change ${name}.`,
          details: [{ label: 'Agent', text: this.agents.agentName(target.agentId) },
            { label: 'New value', text: json }],
          confirmLabel: 'Apply change', cancelLabel: 'Keep setting' }),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), CONFIRM_MS); timer.unref?.(); }),
      ]);
      const live = !turnId || (caller.busy === sessionId && caller.activeTurns.get(sessionId) === turnId);
      if (!accepted || !live) {
        record.status = accepted ? 'cancelled' : 'declined';
        delete record.value;
        this.changed();
        return this.snapshot().find(item => item.id === record.id);
      }
    } catch (error) {
      record.status = 'failed';
      record.error = 'Could not obtain user confirmation.';
      delete record.value;
      this.changed();
      throw error;
    } finally { clearTimeout(timer); }
    if (this.agents.closing) {
      record.status = 'cancelled';
      delete record.value;
      this.changed();
      return this.snapshot().find(item => item.id === record.id);
    }
    record.status = 'queued';
    this.changed();
    setImmediate(() => this.flush());
    return { id: record.id, status: 'queued', name, agentId: record.agentId,
      message: 'Finish this reply so the change can apply. Queued is not applied; read_settings reports the outcome.' };
  }

  async flush() {
    if (this.applying || this.agents.closing || this.agents.busy || this.agents.providerChanging ||
        this.agents.allControllers().some(c => c.loading.size || c.activeTurns.size || c.stopping.size || c.requests.size ||
          c.connectingProviders?.size || c.chatgptLoginPending || c.cleanupPending.size || c.blockedReason())) return;
    const record = this.requests.find(item => item.status === 'queued');
    if (!record) return;
    this.applying = true;
    record.status = 'applying';
    try {
      await this.apply(record);
      record.status = 'applied';
    } catch (error) {
      record.status = 'failed';
      record.error = String(error.message).slice(0, 400);
    } finally {
      delete record.value;
      this.applying = false;
      this.changed();
    }
  }

  async apply({ name, value, agentId }) {
    if (MANUAL.has(name)) throw new Error('This security setting is manual-only.');
    const primary = this.controller;
    this.agents.controller(agentId);
    if (Object.hasOwn(GENERAL, name) || Object.hasOwn(LOCAL, name)) {
      const values = name === 'routingModel' ? (value === 'jev' ? { routing: 'jev' } : { routing: 'smart', routerPreset: value }) : { [name]: value };
      this.agents.settings(values, agentId);
      primary.warmRouter();
    } else if (name === 'models') {
      const actions = ['toggle', 'toggleCodexModel', 'enableDiscovered'];
      if (!object(value) || !actions.includes(value.action)) throw new Error('Invalid provider/model action.');
      primary.providerSettings(value);
      await this.agents.refresh();
    } else if (name === 'benchmarks') {
      primary.smartRouter.benchmarks.replace(value === null ? require('../benchmarks/snapshot.json') : value);
    } else {
      if (!this.host.write) throw new Error('Change this setting in the desktop app.');
      await this.host.write(name, value);
    }
  }
}

module.exports = { SettingsTools };
