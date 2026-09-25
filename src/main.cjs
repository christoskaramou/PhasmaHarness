const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, net, nativeImage, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Controller } = require('./controller.cjs');
const { JevKey } = require('./providers/jev-key.cjs');
const { JevClient } = require('./providers/jev.cjs');
const { ContextSearch } = require('./workspace/context-search.cjs');
const { BenchmarkStore, validateSnapshot, pruneSources, MAX_BYTES } = require('./routing/benchmarks.cjs');
const { Log } = require('./log.cjs');
const { buildDiagnostics } = require('./diagnostics.cjs');
const { Updater } = require('./updater.cjs');
const { JevCompareLog } = require('./routing/jev-compare.cjs');
const { DecisionLog } = require('./trace.cjs');

// Workers and helpers inherit this, so bundled rtk/rg win over any system copies.
process.env.PATH = path.join(__dirname, '..', 'tools', 'bin') + path.delimiter + process.env.PATH;
app.setPath('userData', path.join(app.getPath('appData'), 'Phasma Harness'));
app.setName('Phasma Harness');
// The installed app's shortcuts carry the appId (electron-builder), and Windows shows a shortcut's icon on the taskbar for
// windows with the same ID. Only the installed app uses it; a source-folder run keeps its own window icon.
if (process.platform === 'win32' && app.isPackaged) app.setAppUserModelId('com.phasma.harness');
let window, controller, quitting = false, closing = null, closed = false;
const log = new Log(path.join(app.getPath('userData'), 'logs'));
process.on('uncaughtExceptionMonitor', error => log.error('Uncaught exception', { message: error?.message, stack: String(error?.stack || '').slice(0, 1500) }));
process.on('unhandledRejection', reason => log.error('Unhandled rejection', { message: reason?.message || String(reason) }));
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (closing) return; window?.show(); window?.focus(); });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('Phasma Harness could not start', error.message);
    app.exit(1);
  });
}

async function start() {
  const home = os.homedir();
  const { WikiStore } = require('./workspace/wiki-store.cjs');
  // A source checkout keeps wikis beside the app, as before. An installed app keeps them with the
  // other user data, because updates replace the install folder.
  const dataRoot = app.isPackaged ? app.getPath('userData') : app.getAppPath();
  const wikiStore = new WikiStore(path.join(dataRoot, 'workspace-data'));
  controller = new Controller(path.join(app.getPath('userData'), 'sessions.json'), home, undefined, undefined, { wikiStore });
  controller.log = log;
  controller.jevCompare = new JevCompareLog(path.join(log.directory, 'jev-compare.jsonl'));
  controller.trace = new DecisionLog(path.join(log.directory, 'decisions.jsonl'));
  log.info('Started', { version: app.getVersion(), electron: process.versions.electron, platform: `${process.platform} ${process.arch} ${os.release()}`, packaged: app.isPackaged });
  controller.smartRouter.benchmarks = new BenchmarkStore(path.join(app.getPath('userData'), 'benchmarks.json'));
  const { Providers } = require('./providers/providers.cjs');
  controller.providers = new Providers(path.join(app.getPath('userData'), 'provider-keys'), safeStorage, () => controller.data.settings.providers || [], (...args) => net.fetch(...args));
  await controller.providers.start();
  controller.smartRouter.providers = controller.providers;
  const jevKey = new JevKey(path.join(app.getPath('userData'), 'jev-key.enc'), safeStorage);
  controller.smartRouter.jev = new JevClient(jevKey, (...args) => net.fetch(...args));
  controller.contextSearch = new ContextSearch(home, controller.smartRouter.jev);
  const updater = new Updater({
    current: app.getVersion(), fetch: (...args) => net.fetch(...args), directory: path.join(app.getPath('userData'), 'updates'),
    installable: app.isPackaged && process.platform === 'win32', busy: () => !!controller.busy,
    quit: () => { log.info('Installing update', { from: app.getVersion(), to: updater.state.latest }); quitting = true; app.quit(); },
  });
  updater.on('state', state => { if (window && !window.isDestroyed()) window.webContents.send('update', state); });
  // Before the window can offer "Update and restart": cleaning up later could delete a download already under way.
  if (updater.installable) updater.cleanup();
  controller.contextSearch.wikiStore = wikiStore;
  const rendererURL = pathToFileURL(path.join(__dirname, '..', 'ui', 'index.html')).href;
  window = new BrowserWindow({
    width: 1320, height: 900, minWidth: 840, minHeight: 640,
    resizable: true, maximizable: true,
    title: 'Phasma Harness', backgroundColor: '#151719', show: false,
    ...(process.platform === 'win32' ? { icon: path.join(__dirname, '..', 'ui', 'icon.ico') } : {}),
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  controller.on('state', state => { if (!window.isDestroyed()) window.webContents.send('state', state); });
  const handle = (name, fn) => ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== rendererURL) throw new Error('Untrusted caller.');
    try { return await fn(...args); }
    catch (error) { log.warn(`Action ${name} failed`, { error: String(error?.message || error).slice(0, 300) }); throw error; }
  });
  handle('bootstrap', () => controller.snapshot());
  handle('workspaceWiki', id => wikiStore.ensure(id ? controller.session(id).workspace : controller.data.settings.workspace));
  handle('chooseWorkspaceWiki', async (id, reset = false) => {
    const workspace = id ? controller.session(id).workspace : controller.data.settings.workspace;
    if (reset === true) {
      const answer = await dialog.showMessageBox(window, {
        type: 'question', buttons: ['Reset', 'Cancel'], defaultId: 1, cancelId: 1,
        message: 'Reset this workspace wiki to the default folder?',
        detail: `The wiki will point to the default folder again. Pages in the current folder are not moved or deleted.\n\nCurrent: ${wikiStore.ensure(workspace).root}`,
      });
      return answer.response === 0 ? wikiStore.setLocation(workspace, null) : wikiStore.ensure(workspace);
    }
    const selection = await dialog.showOpenDialog(window, { title: 'Choose wiki folder for this workspace', properties: ['openDirectory'] });
    if (selection.canceled) return wikiStore.ensure(workspace);
    return wikiStore.setLocation(workspace, selection.filePaths[0]);
  });
  handle('openWorkspaceWiki', async id => {
    const wiki = wikiStore.ensure(id ? controller.session(id).workspace : controller.data.settings.workspace);
    const error = await shell.openPath(wiki.root);
    if (error) throw new Error(error);
  });
  handle('browseWorkspace', (id, action, relative, kind) => require('./workspace/workspace-browser.cjs').browse(
    id ? controller.session(id).workspace : controller.data.settings.workspace, action, relative, kind));
  handle('settings', values => { const snapshot = controller.settings(values); controller.warmRouter(); return snapshot; });
  const benchmarkWorkers = () => controller.catalog().filter(p => p.worker && p.enabled && controller.available(p));
  handle('benchmarkData', () => ({ data: controller.smartRouter.benchmarks.data, summary: controller.smartRouter.benchmarks.summary(benchmarkWorkers()) }));
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
    controller.migrateLegacyRouter();
    if (status.loggedIn) controller.claudeRouterFallback();
    await controller.refreshAccount(); controller.save(); return controller.snapshot();
  });
  handle('claudeRefresh', async () => {
    if (controller.busy) throw new Error('Wait for the current turn to finish.');
    await controller.claude.refresh();
    // A refresh never changes whether the Harness uses Claude; only the plug does.
    controller.migrateLegacyRouter();
    if (controller.claude.status.loggedIn) controller.claudeRouterFallback();
    await controller.refreshAccount(); controller.save(); return controller.snapshot();
  });
  handle('claudeLogout', async () => {
    controller.setProviderEnabled('claude-cli', false);
    await controller.refreshAccount(); controller.save(); return controller.snapshot();
  });
  handle('connectChatGPT', async () => {
    if (controller.busy) throw new Error('Stop the current turn before changing accounts.');
    // Use the existing Codex CLI login when there is one; start the ChatGPT sign-in only when it is signed out.
    controller.setProviderEnabled('codex', true);
    await controller.refreshAccount(); controller.save();
    if (controller.account) return controller.snapshot();
    const login = await controller.client.call('account/login/start', { type: 'chatgpt' });
    const url = new URL(login.authUrl);
    if (url.protocol !== 'https:') throw new Error('Unexpected login URL.');
    await shell.openExternal(url.href);
    return { started: true };
  });
  handle('logoutChatGPT', async () => {
    // Stops using ChatGPT in the Harness only; the Codex CLI and other Codex apps stay signed in.
    controller.setProviderEnabled('codex', false);
    await controller.refreshAccount(); controller.save(); return controller.snapshot();
  });
  let installing = null;
  handle('installProvider', async id => {
    if (controller.busy) throw new Error('Wait for the current turn to finish before installing.');
    if (installing) throw new Error(`Wait for the ${installing} install to finish.`);
    const { installer, install } = require('./providers/install.cjs');
    const { label, command } = installer(id);
    const answer = await dialog.showMessageBox(window, {
      type: 'question', buttons: ['Install', 'Cancel'], defaultId: 0, cancelId: 1,
      message: `Install ${label}?`, detail: `This runs the official installer:\n\n${command}`,
    });
    if (answer.response !== 0 || installing) return controller.snapshot();
    installing = label;
    try {
      await install(id);
      let installed;
      if (id === 'codex') { await controller.connectCodex(); installed = controller.codex.installed; }
      else {
        installed = (await controller[id === 'claude-cli' ? 'claude' : 'cursor'].refresh()).installed;
        await controller.refreshAccount();
      }
      controller.save();
      if (!installed) throw new Error(`${label} installer finished, but ${label} is still not detected. Check the installer output or install it manually, then restart the app.`);
      return controller.snapshot();
    } finally { installing = null; }
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
  handle('renewModels', async () => {
    if (controller.busy) throw new Error('Stop the current turn before refreshing models.');
    const notes = [];
    try { await controller.refreshAccount(); }
    catch (error) { notes.push(error.message); }
    if (controller.claude.status.loggedIn) {
      try { await controller.claude.discover(); }
      catch (error) { notes.push(error.message); }
    }
    if (controller.cursor.status.loggedIn) {
      controller.cursor.models = [];
      try { await controller.discoverCursor(); }
      catch (error) { notes.push(error.message); }
    }
    controller.changed();
    const snapshot = controller.snapshot();
    if (notes.length) snapshot.modelRefreshNote = notes.join(' ');
    return snapshot;
  });
  handle('providerModels', async id => {
    if (id === 'cursor-cli') {
      if (!controller.cursor.models.length) await controller.discoverCursor();
      return controller.cursor.models.map(m => ({ id: m.id, label: m.label || m.id }));
    }
    if (id === 'codex') return controller.models.map(m => ({ id: m.model, label: m.model }));
    return (await controller.providers.models(id)).map(model => ({ id: model, label: model }));
  });

  handle('jevSaveKey', value => {
    if (controller.busy) throw new Error('Stop the current turn before changing the Jev key.');
    jevKey.save(value); controller.smartRouter.jev.resetHealth(); controller.changed(); return controller.snapshot();
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
  handle('create', (workspace, access) => controller.create(workspace, access));
  handle('permissions', (id, access) => controller.permissions(id, access));
  handle('load', id => controller.load(id));
  handle('rename', (id, title) => controller.rename(id, title));
  handle('archive', id => controller.archive(id));
  handle('deleteSession', id => controller.deleteSession(id));
  handle('findContext', (id, query, mode) => controller.findContext(id, query, mode));
  handle('cancelContext', () => { if (!controller.busy) controller.contextSearch.cancel(); });
  handle('preview', (id, text, mode) => controller.preview(id, text, mode));
  handle('send', message => {
    const images = message.images || [];
    if (!Array.isArray(images) || images.length > 4 || images.some(url => typeof url !== 'string') || images.reduce((n, url) => n + url.length, 0) > 12 * 1024 * 1024) throw new Error('Attach up to four images, under 8 MB total.');
    return controller.send({ ...message, images: images.map(url => {
      if (!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(url)) throw new Error('Use PNG, JPEG or WebP images.');
      const image = nativeImage.createFromDataURL(url);
      const size = image.getSize();
      if (image.isEmpty() || size.width * size.height > 25000000) throw new Error('Invalid image or image exceeds 25 megapixels.');
      return image.toDataURL();
    }) });
  });
  handle('stop', () => controller.stop());
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
  handle('updateStatus', () => updater.state);
  handle('installUpdate', () => updater.install());
  handle('copyText', text => {
    if (typeof text !== 'string' || text.length > 2000000) throw new Error('Message is too large to copy.');
    clipboard.writeText(text);
  });
  handle('queuedMessage', (id, messageId, action) => controller.queuedMessage(id, messageId, action));
  handle('compact', id => controller.compact(id));
  handle('checks', (workspace, list) => controller.checks(workspace, list));
  handle('acknowledgeTask', (id, taskId) => controller.acknowledgeTask(id, taskId));
  handle('proposeWiki', (id, taskId) => controller.proposeWiki(id, taskId));
  handle('answer', (id, answer) => controller.answer(id, answer));
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
  window.on('close', event => {
    if (controller.busy && !quitting) {
      event.preventDefault();
      const choice = dialog.showMessageBoxSync(window, {
        type: 'question', title: 'A task is still running', message: 'Stop the running task and close Phasma Harness?',
        buttons: ['Keep working', 'Stop and close'], defaultId: 0, cancelId: 0,
      });
      // Quitting stops the task itself (Controller.shutdown), within a time limit, so a failed or hung Stop cannot keep the app open.
      if (choice === 1) { quitting = true; app.quit(); }
    }
  });
  await window.loadURL(rendererURL);
  window.show();
  await controller.initialize();
  controller.warmRouter();
  // The installed app checks for a newer release shortly after it starts and then every 12 hours, quietly: a failed
  // check is only logged. Installing always waits for the user's "Update and restart".
  if (updater.installable) {
    const check = () => updater.check().catch(error => log.info('Automatic update check failed', { message: error.message }));
    setTimeout(check, 10000).unref();
    setInterval(check, 12 * 60 * 60 * 1000).unref();
  }
}

app.on('window-all-closed', () => app.quit());
// For tests/quit-live.cjs, which runs this file in Electron.
module.exports = { controller: () => controller };
// Quitting waits for the workers: the window goes away at once, then Controller.shutdown stops the task and every
// process the app started (bounded, about 12 s at most) before the app exits.
app.on('before-quit', event => {
  if (controller?.busy && !quitting) { event.preventDefault(); window?.close(); return; }
  if (closed || !controller) return;
  event.preventDefault();
  if (closing) return;
  quitting = true;
  if (window && !window.isDestroyed()) window.hide();
  closing = controller.shutdown()
    .then(result => { if (result.stopped || result.remaining.length) log.info('Stopped leftover processes', result); },
      error => log.error('Shutdown cleanup failed', { message: error.message }))
    .finally(() => {
      try { controller.providers?.close(); } catch (error) { console.error(error.message); }
      closed = true;
      app.quit();
    });
});
