const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, net, clipboard, Tray, Menu, nativeTheme } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
app.setPath('userData', path.join(app.getPath('appData'), 'Phasma Harness'));
app.setName('Phasma Harness');
const quitForInstall = process.argv.includes('--quit-for-install');
// A control launch must hand off without loading dependencies or starting another runner.
const ownsRunner = app.requestSingleInstanceLock({ quitForInstall: quitForInstall ? process.execPath : null });
if (!ownsRunner || quitForInstall) { app.quit(); return; }
const { createRunner, RunnerWindow } = require('./runner.cjs');
const { configureWindowZoom } = require('./window-zoom.cjs');
const { configureTextContextMenu } = require('./text-context-menu.cjs');
const { confirmations } = require('./confirmations.cjs');
const { validateSnapshot, pruneSources, MAX_BYTES } = require('./routing/benchmarks.cjs');
const { Log } = require('./log.cjs');
const { buildDiagnostics } = require('./diagnostics.cjs');
const { AsyncLocalStorage } = require('node:async_hooks');
const { RemoteRunner } = require('./remote.cjs');
const { registerRunnerCommands, assertRunnerOpen } = require('./runner-commands.cjs');
const { RemoteSettings } = require('./remote-settings.cjs');
const { microphoneAllowed } = require('./dictation.cjs');
const { trimFleet } = require('../ui/agent-state.js');

// Workers and helpers inherit this, so bundled rtk/rg win over any system copies.
process.env.PATH = path.join(__dirname, '..', 'tools', 'bin') + path.delimiter + process.env.PATH;
require('./process-tree.cjs').cleanPowerShellModulePath();
// The installed app's shortcuts carry the appId (electron-builder), and Windows shows a shortcut's icon on the taskbar for
// windows with the same ID. Only the installed app uses it; a source-folder run keeps its own window icon.
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('com.phasma.harness');
let window, controller, agents, runner, desktop, quitting = false, closing = null, closed = false, installQuitRequested = false;
let browserAccess, browserSettings, browserStarting, browserError = null;
const browserRequest = new AsyncLocalStorage();
let showRequested = !process.argv.includes('--background');
const log = new Log(path.join(app.getPath('userData'), 'logs'));
// The renderer keeps its appearance in local storage and reports it here, so the window paints that background before the page loads.
const appearanceFile = path.join(app.getPath('userData'), 'appearance.json');
function windowBackground() {
  let mode = 'system';
  try { mode = JSON.parse(fs.readFileSync(appearanceFile, 'utf8')); } catch { /* System until the renderer reports a choice. */ }
  const dark = mode === 'dark' || (mode !== 'light' && nativeTheme.shouldUseDarkColors);
  return dark ? '#121212' : '#ffffff';
}
function windowControls() {
  const color = windowBackground();
  return { color, symbolColor: color === '#ffffff' ? '#202b3c' : '#ececec', height: 40 };
}
process.on('uncaughtExceptionMonitor', error => log.error('Uncaught exception', { message: error?.message, stack: String(error?.stack || '').slice(0, 1500) }));
process.on('unhandledRejection', reason => log.error('Unhandled rejection', { message: reason?.message || String(reason) }));
{
  const reopen = () => { if (closing) return; showRequested = true; desktop?.show(); };
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    if (data?.quitForInstall) {
      const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
      if (typeof data.quitForInstall !== 'string' || normalize(data.quitForInstall) !== normalize(process.execPath)) return;
      installQuitRequested = true;
      quitting = true;
      if (controller) app.quit();
      return;
    }
    reopen();
  });
  app.on('activate', reopen);
  app.whenReady().then(() => installQuitRequested ? app.quit() : start()).catch(async error => {
    log.error('Startup failed', { message: error.message });
    if (installQuitRequested) { app.quit(); return; }
    try {
      const previous = window;
      quitting = true;
      window = new BrowserWindow({ width: 640, height: 480, title: 'Phasma Harness', backgroundColor: windowBackground(), show: false, autoHideMenuBar: true,
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
      if (previous && !previous.isDestroyed()) previous.destroy();
      await window.loadFile(path.join(__dirname, '..', 'ui', 'startup-error.html'), { query: { message: error.message } });
      window.on('closed', () => app.quit());
      window.show();
    } catch (failure) { log.error('Error window failed', { message: failure.message }); app.exit(1); }
  });
}

async function start() {
  runner = await createRunner({ app, safeStorage, fetch: (...args) => net.fetch(...args), log,
    quit: () => { quitting = true; app.quit(); } });
  ({ controller, agents } = runner);
  if (installQuitRequested) { app.quit(); return; }
  const { updater, voice } = runner;
  log.info('Started', { version: app.getVersion(), electron: process.versions.electron, platform: `${process.platform} ${process.arch} ${os.release()}`, packaged: app.isPackaged });
  updater.on('state', state => { if (window && !window.isDestroyed()) window.webContents.send('update', state); });
  updater.on('state', state => browserAccess?.broadcast('update', state));
  // Before the window can offer "Update and restart": cleaning up later could delete a download already under way.
  if (updater.installable) updater.cleanup();
  const rendererURL = pathToFileURL(path.join(__dirname, '..', 'ui', 'index.html')).href;
  window = new BrowserWindow({
    width: 1320, height: 900, minWidth: 840, minHeight: 640,
    resizable: true, maximizable: true,
    title: 'Phasma Harness', backgroundColor: windowBackground(), show: false,
    ...(process.platform === 'win32' ? {
      icon: path.join(__dirname, '..', 'ui', 'icon.ico'),
      titleBarStyle: 'hidden', titleBarOverlay: windowControls(),
    } : {}),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  configureWindowZoom(window.webContents, path.join(app.getPath('userData'), 'zoom.json'),
    error => log.warn('Could not save window zoom', { message: error.message }));
  configureTextContextMenu(window);
  const updateWindowAppearance = () => {
    if (window.isDestroyed()) return;
    window.setBackgroundColor(windowBackground());
    if (process.platform === 'win32') window.setTitleBarOverlay(windowControls());
  };
  nativeTheme.on('updated', updateWindowAppearance);
  window.once('closed', () => nativeTheme.removeListener('updated', updateWindowAppearance));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  // Only the microphone, for the app's own page, while a dictation is recording; everything else stays denied.
  const microphone = (contents, permission, url, mediaTypes) => microphoneAllowed({ permission, mediaTypes, url, rendererURL,
    fromWindow: contents === window.webContents, recording: voice.recording });
  window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) =>
    callback(microphone(contents, permission, details?.requestingUrl, details?.mediaTypes)));
  // Permission checks other than the microphone keep Electron's default answer.
  window.webContents.session.setPermissionCheckHandler((contents, permission, _origin, details) =>
    permission !== 'media' || microphone(contents, permission, details?.requestingUrl, [details?.mediaType]));
  // Hiding or leaving the window asks the page to hand over what it recorded; a closed or crashed page loses it.
  const stopVoice = () => voice.stop().catch(error => log.warn('Dictation cleanup failed', { error: error.message }));
  const dropVoice = () => voice.stop(undefined, { discard: true }).catch(error => log.warn('Dictation cleanup failed', { error: error.message }));
  for (const event of ['hide', 'blur', 'minimize']) window.on(event, stopVoice);
  window.on('closed', dropVoice);
  window.webContents.on('render-process-gone', dropVoice);
  voice.on('event', event => {
    if (!window.isDestroyed()) window.webContents.send('voice', event);
  });
  desktop = new RunnerWindow({ app, window, Tray, Menu, icon: path.join(__dirname, '..', 'ui', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    settingsFile: path.join(app.getPath('userData'), 'runner-window.json'),
    isQuitting: () => quitting || !!closing, quit: () => app.quit(),
    status: () => agents.allControllers().some(worker => worker.requests.size) ? 'Needs attention'
      : agents.busy ? 'Work in progress' : 'Runner ready',
    onError: error => log.error('Runner settings failed', { message: error.message }),
  });
  // Each update used to carry every bot's chats (6 MB on the user's data). The window now gets only the bots that changed,
  // and everything every 5 s or after a reload, so an edit that skipped changed()/save() still shows within 5 s.
  const sentChats = new Map();
  let fullAt = 0;
  window.webContents.on('did-finish-load', () => sentChats.clear());
  agents.on('state', state => {
    desktop.refresh();
    if (!window.isDestroyed()) {
      const full = Date.now() - fullAt >= 5000;
      if (full) fullAt = Date.now();
      window.webContents.send('state', trimFleet(state, sentChats, full));
    }
    browserAccess?.broadcast('state', state);
  });
  const sharedChanges = new Set(['benchmarkApply', 'benchmarkReset', 'cursorLogin', 'cursorRefresh', 'cursorLogout', 'claudeLogin', 'claudeRefresh', 'claudeLogout', 'connectChatGPT', 'logoutChatGPT', 'installProvider', 'providerSettings', 'providerKey', 'nativeProviderAction', 'jevSaveKey', 'jevRemoveKey', 'jevTest', 'checks']);
  const connectionActions = { connectChatGPT: 'codex', claudeLogin: 'claude-cli', claudeRefresh: 'claude-cli', cursorLogin: 'cursor-cli', cursorRefresh: 'cursor-cli', jevTest: 'jev' };
  const commands = new Map();
  const invoke = async (name, args) => {
    const fn = commands.get(name);
    if (!fn) throw new Error('Unknown runner command.');
    try {
      assertRunnerOpen(agents, name);
      if (sharedChanges.has(name) && agents.providerChanging) throw new Error('Wait for the current provider connection to finish.');
      if (sharedChanges.has(name) && agents.busy) throw new Error('Stop all agents before changing shared settings or providers.');
      const provider = ['providerModels', 'nativeProviderAction'].includes(name) ? args[0] : connectionActions[name];
      const result = provider ? await controller.withProviderConnection(provider, () => fn(...args)) : await fn(...args);
      if (sharedChanges.has(name)) await agents.refresh();
      return result?.sessions && result?.settings
        ? { ...agents.snapshot(), ...(result.modelRefreshNote ? { modelRefreshNote: result.modelRefreshNote } : {}) } : result;
    }
    catch (error) { log.warn(`Action ${name} failed`, { error: String(error?.message || error).slice(0, 300) }); throw error; }
  };
  const handle = (name, fn) => {
    commands.set(name, fn);
    ipcMain.handle(name, (event, ...args) => {
      if (event.sender !== window.webContents || event.senderFrame?.url !== rendererURL) throw new Error('Untrusted caller.');
      return invoke(name, args);
    });
  };
  handle('runnerInfo', () => desktop.info());
  handle('runnerOnExit', value => desktop.setOnExit(value));
  handle('runnerAutostart', enabled => desktop.setAutostart(enabled));
  handle('quitRunner', () => { setImmediate(() => app.quit()); });
  handle('setAppearance', mode => {
    if (!['system', 'dark', 'light'].includes(mode)) throw new Error('Invalid appearance.');
    fs.writeFileSync(appearanceFile, JSON.stringify(mode));
    updateWindowAppearance();
  });
  const localConfirmation = confirmations(window);
  const confirmation = { ask: options => browserRequest.getStore()?.ask(options) || localConfirmation.ask(options),
    answer: (...args) => localConfirmation.answer(...args) };
  registerRunnerCommands(handle, { runner, ask: options => confirmation.ask(options),
    openFolder: folder => shell.openPath(folder), stopDownloads: () => browserAccess?.stopDownloads(),
    normalizeImage: (url, signal) => runner.documents.image(url, signal) });
  handle('answerConfirmation', (id, accepted) => confirmation.answer(id, accepted));
  const browserInfo = () => ({ ...(browserAccess?.info() || { running: false, port: browserSettings?.value.port || 8788,
    origin: browserSettings?.value.origin || null }), connectionURL: browserAccess?.connectionURL() || null, error: browserError });
  const openBrowser = async value => {
    if (quitting || closing) throw new Error('The runner is stopping.');
    browserSettings ||= new RemoteSettings(app.getPath('userData'), safeStorage);
    const configuration = browserSettings.validate({ ...browserSettings.value, ...value, enabled: true });
    const access = new RemoteRunner({ key: browserSettings.key(), sessions: configuration.sessions,
      saveSessions: sessions => browserSettings.save({ sessions }), snapshot: () => agents.snapshot(),
      artifactDownload: (args, signal) => agents.artifactDownload(args, signal),
      invoke: (name, args, ask) => browserRequest.run({ ask }, () => invoke(name, args)) });
    try {
      await access.listen(configuration);
      if (quitting || closing) throw new Error('The runner is stopping.');
      browserSettings.save({ enabled: true, port: configuration.port, origin: configuration.origin });
      browserAccess = access; browserError = null;
      return browserInfo();
    } catch (error) { await access.close(); throw error; }
  };
  const startBrowser = value => {
    if (browserAccess?.server || browserStarting) return Promise.reject(new Error('Browser access is already running or starting.'));
    browserStarting = openBrowser(value).finally(() => { browserStarting = null; });
    return browserStarting;
  };
  handle('remoteInfo', browserInfo);
  handle('remoteStart', value => startBrowser(value));
  handle('remoteStop', async () => {
    if (browserStarting) await browserStarting.catch(() => {});
    await browserAccess?.close();
    browserSettings?.save({ enabled: false });
    return browserInfo();
  });
  handle('remoteDisconnectAll', async () => {
    if (browserAccess) await browserAccess.revokeSessions();
    else browserSettings?.save({ sessions: [] });
    return browserInfo();
  });
  handle('remoteResetLink', async () => {
    browserSettings ||= new RemoteSettings(app.getPath('userData'), safeStorage);
    if (browserAccess) await browserAccess.revokeSessions();
    else browserSettings.save({ sessions: [] });
    const key = browserSettings.resetKey();
    if (browserAccess) browserAccess.key = key;
    return browserInfo();
  });
  handle('voiceInfo', () => voice.info());
  handle('voiceStart', value => {
    if (!value || !window.isVisible() || !window.isFocused()) throw new Error('Open Harness to dictate a message.');
    const session = agents.owner(value.sessionId).session(value.sessionId);
    if (session.archived) throw new Error('Choose an active chat.');
    return voice.start({ id: value.id, sessionId: session.id });
  });
  handle('voiceStop', id => {
    if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('Choose the current dictation.');
    return voice.stop(id, { discard: true });
  });
  // The recorded audio; Dictation checks it is the open recording's and valid PCM before it reaches the engine.
  handle('voiceTranscribe', (id, audio) => voice.transcribe(id, audio));
  handle('openWorkspaceWiki', async (id, agentId) => {
    const root = path.join(id ? agents.owner(id).session(id).workspace : agents.controller(agentId).data.settings.workspace, 'docs', 'wiki');
    if (!fs.existsSync(root))
      throw new Error('This workspace has no docs/wiki folder.');

    const error = await shell.openPath(root);
    if (error) throw new Error(error);
  });
  const benchmarkWorkers = () => controller.catalog().filter(p => p.worker && p.enabled && controller.available(p));
  handle('benchmarkRefresh', () => {
    const workspace = path.join(app.getPath('userData'), 'benchmark-refresh');
    fs.mkdirSync(workspace, { recursive: true });
    return { prompt: controller.smartRouter.benchmarks.refreshPrompt(benchmarkWorkers()), workspace };
  });
  handle('benchmarkImport', async () => {
    const selection = await dialog.showOpenDialog(window, { title: 'Preview benchmark update', properties: ['openFile'], filters: [{ name: 'Benchmark JSON', extensions: ['json'] }] });
    if (selection.canceled) return null;
    const filename = selection.filePaths[0];
    if (fs.statSync(filename).size > MAX_BYTES) throw new Error('Benchmark file exceeds 1 MB.');
    return validateSnapshot(pruneSources(JSON.parse(fs.readFileSync(filename, 'utf8'))));
  });
  handle('benchmarkApply', data => {
    if (controller.busy) throw new Error('Finish the current turn before replacing benchmark evidence.');
    controller.smartRouter.benchmarks.replace(data);
    controller.changed(); return controller.snapshot();
  });
  handle('benchmarkReset', () => {
    if (controller.busy) throw new Error('Finish the current turn before replacing benchmark evidence.');
    controller.smartRouter.benchmarks.replace(require('../benchmarks/snapshot.json'));
    controller.changed(); return controller.snapshot();
  });
  for (const action of ['cursorLogin', 'cursorRefresh', 'cursorLogout']) handle(action, async () => {
    if (controller.busy) throw new Error('Wait for the current turn to finish.');
    if (action === 'cursorLogin') {
      // Use the existing Cursor CLI login when there is one; sign in only when it is signed out.
      controller.setProviderEnabled('cursor-cli', true);
      if (!(await controller.cursor.refresh()).loggedIn) await controller.cursor.login();
    } else if (action === 'cursorLogout') {
      controller.setProviderEnabled('cursor-cli', false);
      await controller.cursor.refresh();
    } else await controller.cursor.refresh();
    await controller.refreshAccount(); controller.save(); return controller.snapshot();
  });
  handle('claudeLogin', async () => {
    if (controller.busy) throw new Error('Wait for the current turn to finish before signing in.');
    // Use the existing Claude Code login when there is one; sign in only when it is signed out.
    let status = await controller.claude.refresh();
    if (!status.loggedIn) status = await controller.claude.login(url => shell.openExternal(url));
    if (status.loggedIn) controller.setProviderEnabled('claude-cli', true);
    if (status.loggedIn) await agents.refreshClaudeQuota(true);
    controller.migrateLegacyRouter();
    if (status.loggedIn) controller.claudeRouterFallback();
    await controller.refreshAccount(); controller.save(); return controller.snapshot();
  });
  handle('claudeRefresh', async () => {
    if (controller.busy) throw new Error('Wait for the current turn to finish.');
    await controller.claude.refresh();
    // A refresh never changes whether the Harness uses Claude; only the plug does.
    if (controller.claude.status.loggedIn) await agents.refreshClaudeQuota(true);
    controller.migrateLegacyRouter();
    if (controller.claude.status.loggedIn) controller.claudeRouterFallback();
    await controller.refreshAccount(); controller.save(); return controller.snapshot();
  });
  handle('claudeLogout', async () => {
    controller.setProviderEnabled('claude-cli', false);
    await controller.refreshAccount(); controller.save(); return controller.snapshot();
  });
  sharedChanges.add('nativeProviderAction');
  handle('nativeProviderAction', async (id, action) => {
    const backend = controller.nativeCLIs.get(id);
    if (!backend || !['connect', 'refresh', 'disconnect'].includes(action)) throw new Error('Unknown native provider action.');
    if (action === 'disconnect') controller.setProviderEnabled(id, false);
    else {
      let status = await backend.refresh();
      if (action === 'connect' && !status.loggedIn) status = await backend.login(url => shell.openExternal(url));
      if (action === 'connect' && !status.loggedIn) throw new Error(status.error || 'Complete the native CLI sign-in before connecting.');
      if (action === 'connect' && status.loggedIn) controller.setProviderEnabled(id, true);
    }
    await controller.refreshAccount(); controller.adoptRouter(); controller.save(); controller.changed();
    return controller.snapshot();
  });
  handle('connectChatGPT', async () => {
    if (controller.busy) throw new Error('Stop the current turn before changing accounts.');
    // Use the existing Codex CLI login when there is one; start the ChatGPT sign-in only when it is signed out.
    controller.setProviderEnabled('codex', true);
    await controller.refreshAccount(); controller.save();
    if (controller.account) return controller.snapshot();
    return controller.loginChatGPT(url => shell.openExternal(url));
  });
  handle('logoutChatGPT', async () => {
    // Stops using ChatGPT in the Harness only; the Codex CLI and other Codex apps stay signed in.
    controller.setProviderEnabled('codex', false);
    await controller.refreshAccount(); controller.save(); return controller.snapshot();
  });
  handle('installProvider', async id => {
    if (controller.busy) throw new Error('Wait for the current turn to finish before installing.');
    const { installer, install, installing, inTurn } = require('./providers/install.cjs');
    // An installed CLI with a newer release updates; otherwise the official installer runs.
    const update = controller.cliInstalled(id) ? controller.cliUpdates?.[id] : null;
    const { label, command } = installer(id, !!update);
    if (installing(id)) throw new Error(`Wait for the ${label} install to finish.`);
    const accepted = await confirmation.ask(update
      ? { title: `Update ${label}?`, message: `Harness will update ${label} from ${update.installed} to ${update.latest} with its official updater.`,
        confirmLabel: 'Update', details: [{ label: 'Update command', text: command }] }
      : { title: `Install ${label}?`, message: 'Harness will run the official installer on this computer.', confirmLabel: 'Install',
        details: [{ label: 'Installer command', text: command }] });
    if (!accepted || installing(id)) return controller.snapshot();

    // Other CLIs may be installing meanwhile (src/providers/install.cjs); an npm install waits its turn, so agents are
    // checked when it starts.
    return inTurn(id, command, async () => {
      if (agents.busy) throw new Error('Stop all agents before installing a provider.');

      // Running Codex app-servers hold the Codex binary open, and Windows refuses to replace it until they stop.
      const codexContexts = update && id === 'codex' ? [...agents.allControllers()] : [];
      for (const context of codexContexts) {
        context.smartRouter.close?.();
        context.client.close();
      }

      try {
        await install(id, { update: !!update });
      } finally {
        await Promise.all(codexContexts.map(context => context.connectCodex()));
      }

      let installed;
      if (id === 'codex') {
        if (!codexContexts.length)
          await controller.connectCodex();
        installed = controller.codex.installed;
      } else if (controller.nativeCLIs.has(id)) installed = controller.nativeCLIs.get(id).inspect().installed;
      else {
        installed = (await controller[id === 'claude-cli' ? 'claude' : 'cursor'].refresh()).installed;
        await controller.refreshAccount();
      }
      controller.save();
      if (!installed) throw new Error(`${label} installer finished, but ${label} is still not detected. Check the installer output or install it manually, then restart the app.`);

      const updates = await controller.refreshCliUpdates();
      const stale = update && updates[id];
      if (stale) throw new Error(`${label} updater finished, but ${label} is still ${stale.installed} (newest ${stale.latest}). Check the updater output or update it manually.`);
      return controller.snapshot();
    });
  });
  handle('providerSettings', value => controller.providerSettings(value));
  handle('providerKey', (id, key) => {
    if (controller.busy) throw new Error('Stop the current turn before changing keys.');
    // Keys can be changed while a provider is disabled.
    if (!(controller.data.settings.providers || []).some(p => p.id === id)) throw new Error('Unknown provider.');
    const store = controller.providers.key(id);
    if (key === null) store.remove(); else store.save(key);
    controller.loaded.clear(); controller.changed(); return controller.snapshot();
  });
  handle('localModel', async (choice, action = 'status') => {
    if (!['status', 'load', 'unload'].includes(action)) throw new Error('Unknown model action.');
    if (!controller.catalog().some(p => p.provider === choice?.provider && p.model === choice?.model)) throw new Error('Choose an enabled model first.');
    if (action !== 'status') {
      if (agents.busy) throw new Error('Wait for all agents to finish before loading or unloading a model.');
      if (action === 'load') await controller.providers.prepare(choice);
      else await controller.providers.local.unload(choice);
    }
    return controller.providers.local.status(choice);
  });

  handle('jevSaveKey', value => {
    if (controller.busy) throw new Error('Stop the current turn before changing the Jev key.');
    jevKey.save(value); controller.smartRouter.jev.resetHealth(); controller.changed();
    controller.checkJev();
    return controller.snapshot();
  });
  handle('jevRemoveKey', () => {
    if (controller.busy) throw new Error('Stop the current turn before removing the Jev key.');
    jevKey.remove(); controller.smartRouter.jev.resetHealth();
    return controller.settings({ routing: controller.data.settings.routing === 'jev' ? 'smart' : controller.data.settings.routing, contextRanking: 'local', toolSelection: 'off', jevCompare: false, wikiAssessment: false });
  });
  handle('jevTest', async () => {
    if (controller.busy) throw new Error('Wait for the current turn to finish before testing Jev.');
    try { return await controller.smartRouter.jev.test(); } finally { controller.changed(); }
  });
  handle('diagnostics', async () => {
    const version = async run => { try { return (await run()).trim().split(/\s+/).find(part => /\d+\.\d+/.test(part)) || '?'; } catch { return 'not available'; } };
    const [claude, cursor] = await Promise.all([
      version(() => controller.claude.command(['--version'], undefined, 5000)),
      version(() => controller.cursor.command(['--version'], 5000)),
    ]);
    return buildDiagnostics({
      controller, logLines: log.tail(150), cli: { codex: controller.client.version || '?', claude, cursor },
      app: { version: app.getVersion(), electron: process.versions.electron, node: process.versions.node, platform: process.platform, arch: process.arch,
        osRelease: os.release(), packaged: app.isPackaged, dataLocation: app.getPath('userData') },
    });
  });
  handle('openLogs', () => shell.openPath(log.directory));
  handle('appInfo', () => ({ version: app.getVersion(), packaged: app.isPackaged }));
  handle('checkUpdates', async () => {
    const result = await updater.check();
    log.info('Update check', { current: result.current, latest: result.latest, newer: result.newer });
    return result;
  });
  handle('installUpdate', () => updater.install());
  handle('copyText', text => {
    if (typeof text !== 'string' || text.length > 2000000) throw new Error('Message is too large to copy.');
    return clipboard.writeText(text);
  });
  handle('exportConversation', async id => {
    if (typeof id !== 'string' || !id) throw new Error('Choose a conversation to export.');
    return require('./conversation-export.cjs').exportConversation(window, agents.owner(id).session(id), agents.snapshot().batchReports);
  });
  handle('checks', (workspace, list) => controller.checks(workspace, list));
  handle('phasmaGameChecks', workspace => (typeof workspace === 'string' && path.isAbsolute(workspace)
    ? require('./phasma-game-checks.cjs').phasmaGameChecks(workspace) : null));
  handle('chooseWorkspace', async () => {
    const selection = await dialog.showOpenDialog(window, { title: 'Choose workspace', properties: ['openDirectory'], defaultPath: controller.data.settings.workspace });
    if (selection.canceled) return null;
    return selection.filePaths[0];
  });
  handle('openLink', async value => {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Only web links can be opened.');
    await shell.openExternal(url.href);
  });
  agents.settingsTools.host = {
    ask: options => confirmation.ask(options),
    read: name => {
      if (name === 'appearance') {
        try { return JSON.parse(fs.readFileSync(appearanceFile, 'utf8')); } catch { return 'system'; }
      }
      if (name === 'onExit') return desktop.onExit;
      if (name === 'startAtSignIn') return desktop.info().autostart.enabled;
      if (name === 'browserAccess') {
        const { running, port, origin } = browserInfo();
        return { enabled: running, port, origin };
      }
      if (name === 'about') return { version: app.getVersion(), packaged: app.isPackaged };
    },
    write: async (name, value) => {
      const methods = { appearance: 'setAppearance', onExit: 'runnerOnExit', startAtSignIn: 'runnerAutostart' };
      if (Object.hasOwn(methods, name)) {
        await commands.get(methods[name])(value);
        if (name === 'appearance' && !window.isDestroyed()) window.webContents.send('appearance', value);
      } else throw new Error('Unknown desktop setting.');
    },
  };
  await window.loadURL(rendererURL);
  if (showRequested) desktop.show();
  await runner.initialize();
  // Background check for newer CLI releases; it shows an Update button on the provider row.
  controller.cliUpdateCheck = require('./providers/install.cjs').updates;
  controller.refreshCliUpdates();
  controller.checkJev();
  try {
    browserSettings = new RemoteSettings(app.getPath('userData'), safeStorage);
    const serve = process.argv.find(value => value === '--serve' || value.startsWith('--serve='));
    const origin = process.argv.find(value => value.startsWith('--remote-origin='))?.slice('--remote-origin='.length);
    if (!browserAccess?.server && (serve || browserSettings.value.enabled)) await startBrowser({
      ...(serve?.includes('=') ? { port: Number(serve.slice('--serve='.length)) } : {}), ...(origin ? { origin } : {}),
    });
  } catch (error) { browserError = error.message; log.warn('Browser access did not start', { message: error.message }); }
  // The installed app checks for a newer release shortly after it starts and then every 12 hours, quietly: a failed
  // check is only logged. Installing always waits for the user's "Update and restart".
  if (updater.installable) {
    const check = () => updater.check().catch(error => log.info('Automatic update check failed', { message: error.message }));
    setTimeout(check, 10000).unref();
    setInterval(check, 12 * 60 * 60 * 1000).unref();
  }
}

// For tests/quit-live.cjs, which runs this file in Electron.
module.exports = { controller: () => controller };
// Quitting waits for the workers: the window goes away at once, then Controller.shutdown stops the task and every
// process the app started (bounded, about 12 s at most) before the app exits.
app.on('before-quit', event => {
  if (closed || !controller) return;
  event.preventDefault();
  if (closing) return;
  quitting = true;
  if (window && !window.isDestroyed()) window.hide();
  closing = (async () => {
    try { await browserAccess?.close(); }
    catch (error) { log.error('Browser cleanup failed', { message: error.message }); }
    return runner ? runner.shutdown() : controller.shutdown();
  })()
    .then(result => { if (result.stopped || result.remaining.length) log.info('Stopped leftover processes', result); },
      error => log.error('Shutdown cleanup failed', { message: error.message }))
    .finally(() => {
      desktop?.dispose();
      closed = true;
      app.quit();
    });
});
