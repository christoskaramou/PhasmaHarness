const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage, net, nativeImage, clipboard } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { Controller } = require('./controller.cjs');
const { JevKey } = require('./jev-key.cjs');
const { JevClient } = require('./jev.cjs');
const { ContextSearch } = require('./context-search.cjs');
const { BenchmarkStore, validateSnapshot, MAX_BYTES } = require('./benchmarks.cjs');

app.setPath('userData', path.join(app.getPath('appData'), 'Phasma Harness'));
app.setName('Phasma Harness');
let window, controller, quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(start).catch(error => {
    dialog.showErrorBox('Phasma Harness could not start', error.message);
    app.exit(1);
  });
}

async function start() {
  const home = os.homedir();
  controller = new Controller(path.join(app.getPath('userData'), 'sessions.json'), home);
  controller.smartRouter.benchmarks = new BenchmarkStore(path.join(app.getPath('userData'), 'benchmarks.json'));
  const { Providers } = require('./providers.cjs');
  controller.providers = new Providers(path.join(app.getPath('userData'), 'provider-keys'), safeStorage, () => controller.data.settings.providers || [], (...args) => net.fetch(...args));
  await controller.providers.start();
  controller.smartRouter.providers = controller.providers;
  const jevKey = new JevKey(path.join(app.getPath('userData'), 'jev-key.enc'), safeStorage);
  controller.smartRouter.jev = new JevClient(jevKey, (...args) => net.fetch(...args));
  controller.contextSearch = new ContextSearch(home, controller.smartRouter.jev);
  const rendererURL = pathToFileURL(path.join(__dirname, 'ui', 'index.html')).href;
  window = new BrowserWindow({
    width: 1320, height: 900, minWidth: 840, minHeight: 640,
    resizable: true, maximizable: true,
    title: 'Phasma Harness', backgroundColor: '#151719', show: false,
    autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  controller.on('state', state => { if (!window.isDestroyed()) window.webContents.send('state', state); });
  const handle = (name, fn) => ipcMain.handle(name, async (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame?.url !== rendererURL) throw new Error('Untrusted caller.');
    return fn(...args);
  });
  handle('bootstrap', () => controller.snapshot());
  handle('browseWorkspace', (id, action, relative, kind) => require('./workspace-browser.cjs').browse(
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
    return validateSnapshot(JSON.parse(fs.readFileSync(filename, 'utf8')));
  });
  handle('benchmarkApply', data => {
    if (controller.busy) throw new Error('Finish the current turn before replacing benchmark evidence.');
    controller.smartRouter.benchmarks.replace(data);
    controller.changed(); return controller.snapshot();
  });
  handle('benchmarkReset', () => {
    if (controller.busy) throw new Error('Finish the current turn before replacing benchmark evidence.');
    controller.smartRouter.benchmarks.replace(require('./benchmarks/snapshot.json'));
    controller.changed(); return controller.snapshot();
  });
  for (const action of ['cursorLogin', 'cursorRefresh', 'cursorLogout']) handle(action, async () => {
    if (controller.busy) throw new Error('Wait for the current turn to finish.');
    if (action === 'cursorLogin') await controller.cursor.login();
    else if (action === 'cursorLogout') await controller.cursor.logout();
    else await controller.cursor.refresh();
    await controller.refreshAccount(); controller.save(); return controller.snapshot();
  });
  handle('claudeLogin', async () => {
    if (controller.busy) throw new Error('Wait for the current turn to finish before signing in.');
    const status = await controller.claude.login(url => shell.openExternal(url));
    if (status.loggedIn) controller.data.settings.claudeEnabled = true;
    if (status.loggedIn && !controller.routerChoices().some(p => p.id === controller.data.settings.routerPreset && controller.available(p))) controller.data.settings.routerPreset = 'claude-cli:haiku';
    await controller.refreshAccount(); controller.save(); return controller.snapshot();
  });
  handle('claudeRefresh', async () => {
    if (controller.busy) throw new Error('Wait for the current turn to finish.');
    await controller.claude.refresh();
    if (controller.claude.status.loggedIn) controller.data.settings.claudeEnabled = true;
    if (controller.claude.status.loggedIn && !controller.routerChoices().some(p => p.id === controller.data.settings.routerPreset && controller.available(p))) controller.data.settings.routerPreset = 'claude-cli:haiku';
    await controller.refreshAccount(); controller.save(); return controller.snapshot();
  });
  handle('claudeLogout', async () => {
    if (controller.busy) throw new Error('Wait for the current turn to finish.');
    await controller.claude.logout();
    controller.data.settings.claudeEnabled = false;
    await controller.refreshAccount(); controller.save(); return controller.snapshot();
  });
  handle('connectChatGPT', async () => {
    if (controller.busy) throw new Error('Stop the current turn before changing accounts.');
    const login = await controller.client.call('account/login/start', { type: 'chatgpt' });
    const url = new URL(login.authUrl);
    if (url.protocol !== 'https:') throw new Error('Unexpected login URL.');
    await shell.openExternal(url.href);
    return { started: true };
  });
  handle('logoutChatGPT', async () => {
    if (controller.busy) throw new Error('Stop the current turn before changing accounts.');
    try {
      await controller.client.call('account/logout', {});
    } catch (error) {
      throw new Error(error.message || 'Could not sign out of ChatGPT from this app. Sign out in Codex CLI if needed.');
    }
    await controller.refreshAccount(); controller.save(); return controller.snapshot();
  });
  handle('providerSettings', value => controller.providerSettings(value));
  handle('providerKey', (id, key) => {
    if (controller.busy) throw new Error('Stop the current turn before changing keys.');
    controller.providers.provider(id);
    const store = controller.providers.key(id);
    if (key === null) store.remove(); else store.save(key);
    controller.loaded.clear(); controller.changed(); return controller.snapshot();
  });
  handle('renewModels', async () => {
    if (controller.busy) throw new Error('Stop the current turn before refreshing models.');
    const notes = [];
    try { await controller.refreshAccount(); }
    catch (error) { notes.push(error.message); }
    if (controller.cursor.status.loggedIn) {
      controller.cursor.models = [];
      try { await controller.cursor.discover(); }
      catch (error) { notes.push(error.message); }
    }
    controller.changed();
    const snapshot = controller.snapshot();
    if (notes.length) snapshot.modelRefreshNote = notes.join(' ');
    return snapshot;
  });
  handle('providerModels', async id => {
    if (id === 'cursor-cli') {
      if (!controller.cursor.models.length) await controller.cursor.discover();
      return controller.cursor.models.map(m => ({ id: m.id, label: m.label || m.id }));
    }
    if (id === 'codex') return controller.models.map(m => ({ id: m.model, label: m.model }));
    return (await controller.providers.models(id)).map(model => ({ id: model, label: model }));
  });

  handle('jevSaveKey', value => {
    if (controller.busy) throw new Error('Stop the current turn before changing the Jev key.');
    jevKey.save(value); controller.changed(); return controller.snapshot();
  });
  handle('jevRemoveKey', () => {
    if (controller.busy) throw new Error('Stop the current turn before removing the Jev key.');
    jevKey.remove();
    return controller.settings({ routing: controller.data.settings.routing === 'jev' ? 'smart' : controller.data.settings.routing, contextRanking: 'local', toolSelection: 'off' });
  });
  handle('jevTest', async () => {
    if (controller.busy) throw new Error('Wait for the current turn to finish before testing Jev.');
    return controller.smartRouter.jev.test();
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
  handle('copyText', text => {
    if (typeof text !== 'string' || text.length > 2000000) throw new Error('Message is too large to copy.');
    clipboard.writeText(text);
  });
  handle('queuedMessage', (id, messageId, action) => controller.queuedMessage(id, messageId, action));
  handle('compact', id => controller.compact(id));
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
      if (choice === 1) controller.stop().then(() => { quitting = true; app.quit(); }).catch(error => dialog.showErrorBox('Could not stop task', error.message));
    }
  });
  await window.loadURL(rendererURL);
  window.show();
  await controller.initialize();
  controller.warmRouter();
}

app.on('window-all-closed', () => app.quit());
app.on('before-quit', event => {
  if (controller?.busy && !quitting) { event.preventDefault(); window?.close(); return; }
  try { controller?.providers?.close(); controller?.close(); } catch (error) { console.error(error.message); }
});
