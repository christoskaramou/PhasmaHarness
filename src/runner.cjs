const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { Controller } = require('./controller.cjs');
const { Agents } = require('./agents.cjs');
const { WikiStore } = require('./workspace/wiki-store.cjs');
const { Providers } = require('./providers/providers.cjs');
const { JevKey } = require('./providers/jev-key.cjs');
const { JevClient } = require('./providers/jev.cjs');
const { ContextSearch } = require('./workspace/context-search.cjs');
const { BenchmarkStore } = require('./routing/benchmarks.cjs');
const { JevCompareLog } = require('./routing/jev-compare.cjs');
const { DecisionLog } = require('./trace.cjs');
const { containRunner } = require('./runner-containment.cjs');
const { Updater } = require('./updater.cjs');
const { Dictation } = require('./dictation.cjs');
const { DocumentReader } = require('./documents.cjs');
const { sweepAgentFiles } = require('./providers/antigravity.cjs');
const { readSessionData, atomicWrite } = require('./session-store.cjs');

// The fixed wikis folder. The earlier one ("workspace-data") is renamed once; if that fails, it stays in use so no
// project knowledge is lost.
function wikisFolder(base, log) {
  const wikis = path.join(base, 'Wikis');
  const previous = path.join(base, 'workspace-data');
  if (fs.existsSync(wikis) || !fs.existsSync(previous))
    return wikis;

  try {
    fs.renameSync(previous, wikis);
    return wikis;
  } catch (error) {
    log?.warn('Wikis folder not renamed; using the previous one', { error: error.message });
    return previous;
  }
}

async function createRunner({ app, data = app?.getPath('userData'), safeStorage, fetch = globalThis.fetch, log, quit }) {
  if (!data || !path.isAbsolute(data)) throw new Error('Choose an absolute runner data directory.');
  const version = app?.getVersion() || require('../package.json').version;
  const wikiStore = new WikiStore(wikisFolder(app && !app.isPackaged ? app.getAppPath() : data, log));
  const store = path.join(data, 'sessions.json');
  backupStores(store);
  const containment = await containRunner(data);
  if (!app && !containment.recoverySafe) throw new Error('Start the headless runner through its managed systemd service.');
  app?.once('will-quit', () => containment.detach?.());
  const workspace = app ? os.homedir() : path.join(data, 'projects');
  if (!app) fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  const controller = new Controller(store, workspace, undefined, undefined, { wikiStore });
  controller.runnerRecoverySafe = containment.recoverySafe === true;
  controller.log = log;
  controller.jevCompare = new JevCompareLog(path.join(log.directory, 'jev-compare.jsonl'));
  controller.trace = new DecisionLog(path.join(log.directory, 'decisions.jsonl'));
  controller.smartRouter.benchmarks = new BenchmarkStore(path.join(data, 'benchmarks.json'));
  const jevKey = new JevKey(path.join(data, 'jev-key.enc'), safeStorage);
  const jevReported = { model: null };
  const configure = async worker => {
    worker.log = log;
    worker.trace = controller.trace;
    worker.smartRouter.benchmarks = controller.smartRouter.benchmarks;
    worker.providers = new Providers(path.join(data, 'provider-keys'), safeStorage, () => controller.data.settings.providers || [], fetch);
    if (worker !== controller) worker.providers.local = controller.providers.local;
    worker.smartRouter.providers = worker.providers;
    worker.smartRouter.jev = new JevClient(jevKey, fetch, () => controller.data.settings.jevEnabled !== false, jevReported);
    worker.contextSearch = new ContextSearch(os.homedir(), worker.smartRouter.jev);
    worker.contextSearch.wikiStore = wikiStore;
  };
  let agents;
  try {
    await configure(controller);
    agents = new Agents(controller, configure);
  } catch (error) {
    await controller.shutdown();
    // Losing the lease ends this process within 5 s, so the desktop keeps it while it shows the error; will-quit releases it.
    if (!app) containment.detach?.();
    throw error;
  }
  agents.settingsTools = new (require('./settings-tools.cjs').SettingsTools)({ agents, controller, wikiStore });
  const voice = new Dictation({ modelDirectory: path.join(data, 'speech-models'), fetch });
  const documents = new DocumentReader();
  agents.updateBlockedReason = () => voice.busy ? 'Finish dictation before updating.'
    : documents.busy ? 'Wait for document processing before updating.' : updateBlockedReason(agents);
  const updater = new Updater({ current: version, fetch, directory: path.join(data, 'updates'),
    ...(containment.launchInstaller ? { launch: containment.launchInstaller } : {}),
    installable: !!app?.isPackaged && process.platform === 'win32', busy: () => agents.updateBlockedReason(),
    pause: () => {
      agents.closing = true;
      return () => { agents.closing = false; agents.pump(); };
    },
    quit: () => { log.info('Installing update', { from: version, to: updater.state.latest }); quit(); },
  });
  agents.checkUpdate = () => updater.checkFromAgent();
  return { controller, agents, wikiStore, updater, voice, documents, containment,
    async initialize() {
      sweepAgentFiles([...agents.allControllers().flatMap(context => [context.data.settings.workspace,
        ...context.data.sessions.map(session => session.workspace)]), ...(controller.data.agents || []).map(profile => profile.workspace),
      ...Object.values(agents.workspaces.records).map(record => record?.workspace)]);
      await agents.downloads.recover();
      if (agents.downloads.error) log.warn('Download cleanup needs review', { message: agents.downloads.error });
      if (agents.closing) return;
      await controller.initialize();
      if (agents.closing) return;
      await agents.initialize();
      if (agents.closing) return;
      agents.routines.start();
      controller.warmRouter();
    },
    async shutdown(options) {
      try {
        const [work, speech, files] = await Promise.allSettled([agents.shutdown(options), voice.close(), documents.close()]);
        if (files.status === 'rejected') throw files.reason;
        if (speech.status === 'rejected') throw speech.reason;
        if (work.status === 'rejected') throw work.reason;
        return work.value;
      }
      finally {
        containment.detach?.();
      }
    },
  };
}

function hasPendingWork(agents) {
  return !!updateBlockedReason(agents);
}

function updateBlockedReason(agents) {
  if (agents.settingsTools?.busy) return 'Wait for settings changes to finish before updating.';
  if (agents.busy) return 'Finish or stop the current turn first; updating restarts the app.';
  if (agents.routines?.busy || agents.workspaces?.busy || agents.artifactRuns?.busy || agents.downloads?.busy ||
      agents.revisionOperations?.size || agents.budgets?.inflight.size)
    return 'Wait for background work or cleanup to finish before updating.';
  if (agents.pendingJobs().some(({ job }) => !job || !['interrupted', 'revision-blocked', 'delivery-pending'].includes(job.state)) ||
      agents.foregroundTasks?.().length)
    return 'Finish or stop pending tasks in Overview before updating.';
  for (const controller of agents.allControllers()) {
    if (controller.connection === 'connecting' || controller.connectingProviders?.size || controller.chatgptLoginPending)
      return 'Wait for provider sign-in or connection to finish before updating.';
    if (controller.requests.size) return 'Resolve the pending permission request before updating.';
    if (controller.loading.size || controller.activeTurns?.size || controller.stopping.size ||
        controller.cleanupPending?.size || controller.blockedReason())
      return 'Wait for active work or process cleanup to finish before updating.';
    for (const session of controller.data.sessions) {
      const failedDraft = session.status === 'failed' && session.pendingMessage?.error && !session.submission;
      // Stopped or crashed before sending (cancelled assignments included): restart keeps the draft for retry.
      const stoppedDraft = session.status === 'interrupted' && !session.submission;
      if (session.submission || session.queueSending || (session.pendingMessage && !failedDraft && !stoppedDraft))
        return 'Resolve the pending message submission before updating.';
      // Paused messages and saved reports survive restart and cannot start work on their own.
      if (!session.queuePaused && (session.queue?.length || session.items?.some(item => item.pendingReply)))
        return 'Send or pause queued messages and results before updating.';
    }
  }
  return null;
}

function backupStores(filename) {
  if (!fs.existsSync(filename)) return;
  const data = readSessionData(filename);
  const files = [filename];
  for (const profile of data.agents || []) {
    if (!/^[a-f0-9-]{36}$/.test(profile.id)) throw new Error('Invalid saved agent ID; recovery backup was not changed.');
    files.push(path.join(path.dirname(filename), 'agents', profile.id, 'sessions.json'));
  }
  if (data.workerContexts !== undefined && !Array.isArray(data.workerContexts)) throw new Error('Invalid saved worker contexts.');
  if (new Set(data.workerContexts || []).size !== (data.workerContexts || []).length) throw new Error('Duplicate saved worker contexts.');
  for (const id of data.workerContexts || []) {
    if (id !== 'main' && !(data.agents || []).some(profile => profile.id === id)) throw new Error('Unknown saved worker context.');
    files.push(path.join(path.dirname(filename), 'workers', id, 'sessions.json'));
  }
  for (const file of files) {
    if (!fs.existsSync(file)) continue;
    const backup = file + '.pre-runner-recovery-v1.bak';
    try {
      if (!fs.existsSync(backup)) {
        // Verified before it takes the backup name: an interrupted copy or an unreadable store never leaves a backup that blocks startup.
        const temporary = backup + '.' + randomUUID() + '.tmp';
        try {
          atomicWrite(temporary, JSON.stringify(readSessionData(file)));
          JSON.parse(fs.readFileSync(temporary, 'utf8'));
          fs.renameSync(temporary, backup);
        } finally { fs.rmSync(temporary, { force: true }); }
      }
      if (!fs.lstatSync(backup).isFile()) throw new Error('The backup path is not a regular file.');
      JSON.parse(fs.readFileSync(backup, 'utf8'));
    } catch (error) {
      throw new Error(`Could not verify the recovery backup for ${path.basename(file)}: ${error.message} ` +
        `Check ${file}, then move ${path.basename(backup)} aside to start again.`);
    }
  }
}

function loginOptions(app, executable = process.execPath) {
  return { path: executable, args: [...(app.isPackaged ? [] : [`"${app.getAppPath()}"`]), '--background'] };
}

function autostart(app, enabled, platform = process.platform) {
  if (!['win32', 'darwin'].includes(platform)) {
    if (enabled !== undefined) throw new Error('Start at sign-in is supported on Windows and macOS.');
    return { supported: false, enabled: false };
  }
  const options = loginOptions(app);
  if (enabled !== undefined) {
    if (typeof enabled !== 'boolean') throw new Error('Choose whether to start at sign-in.');
    app.setLoginItemSettings({ ...options, openAtLogin: enabled, enabled });
  }
  const saved = app.getLoginItemSettings(options);
  return { supported: true, enabled: !!saved.openAtLogin && saved.executableWillLaunchAtLogin !== false,
    ...(saved.status === 'requires-approval' ? { needsApproval: true } : {}) };
}

class RunnerWindow {
  constructor({ app, window, Tray, Menu, icon, isQuitting, quit, status = () => 'Runner ready', onError = () => {}, settingsFile }) {
    Object.assign(this, { app, window, Menu, isQuitting, quit, status, onError });
    this.settingsFile = settingsFile;
    this.onExit = 'tray';
    if (settingsFile) {
      try {
        const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
        if (['close', 'tray'].includes(saved.onExit)) this.onExit = saved.onExit;
      } catch (error) {
        if (error.code !== 'ENOENT') onError(error);
      }
    }
    this.tray = new Tray(icon);
    this.tray.on('click', () => this.show());
    window.on('close', event => {
      if (isQuitting()) return;
      event.preventDefault();
      if (this.onExit === 'close') quit();
      else window.hide();
    });
    window.webContents.on('render-process-gone', () => { this.rendererGone = true; });
    this.refresh();
  }

  show() {
    if (this.isQuitting() || this.window.isDestroyed()) return;
    if (this.rendererGone) { this.rendererGone = false; this.window.reload(); }
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
  }

  info() { return { running: true, background: true, onExit: this.onExit, status: this.status(), autostart: autostart(this.app) }; }

  setOnExit(value) {
    if (!['close', 'tray'].includes(value)) throw new Error('Choose Close App or Stay on Tray.');
    if (this.settingsFile) {
      fs.writeFileSync(this.settingsFile + '.tmp', JSON.stringify({ onExit: value }));
      fs.renameSync(this.settingsFile + '.tmp', this.settingsFile);
    }
    this.onExit = value;
    return value;
  }

  setAutostart(enabled) {
    const result = autostart(this.app, enabled);
    this.refresh(true);
    return result;
  }

  refresh(force = false) {
    const status = this.status();
    if (!force && status === this.menuStatus) return;
    this.menuStatus = status;
    const start = autostart(this.app);
    this.tray.setToolTip(`Phasma Harness · ${status}`);
    this.tray.setContextMenu(this.Menu.buildFromTemplate([
      { label: 'Open Harness', click: () => this.show() },
      { label: status, enabled: false },
      { type: 'separator' },
      { label: 'Start at sign-in', type: 'checkbox', checked: start.enabled, enabled: start.supported,
        click: item => { try { this.setAutostart(item.checked); } catch (error) { this.onError(error); this.refresh(true); } } },
      { label: 'Quit runner', click: this.quit },
    ]));
  }

  dispose() { this.tray.destroy(); }
}

module.exports = { createRunner, hasPendingWork, updateBlockedReason, RunnerWindow, autostart, loginOptions, backupStores };
