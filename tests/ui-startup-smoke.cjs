// Run with Electron, not Node. No provider login or inference is performed.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Controller } = require('../src/controller.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ui-'));
app.setPath('userData', root);
const deadline = setTimeout(() => { console.error('UI startup timed out'); app.exit(1); }, 15000);
app.whenReady().then(async () => {
  const controller = new Controller(path.join(root, 'sessions.json'), root);
  ipcMain.handle('bootstrap', () => controller.snapshot());
  ipcMain.handle('browseWorkspace', () => ({ available: false, entries: [] }));
  ipcMain.handle('preview', () => ({ label: 'Auto', reason: 'Smoke test' }));
  const sent = [];
  let failSend = false;
  ipcMain.handle('create', (_event, workspace, access) => controller.create(workspace, access));
  ipcMain.handle('send', (_event, message) => {
    if (failSend) throw new Error('Test send failed');
    sent.push(message);
    return { queued: true };
  });
  let modelRequests = 0, failModels = false, finishFetch, nextModels = [];
  ipcMain.handle('providerModels', async () => {
    modelRequests++;
    await new Promise(resolve => { finishFetch = resolve; });
    if (failModels) throw new Error('Test model fetch failed');
    return nextModels;
  });
  const window = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../src/preload.cjs'), contextIsolation: true, sandbox: true } });
  await window.loadFile(path.resolve(__dirname, '../ui/index.html'));
  const result = await window.webContents.executeJavaScript(`(() => {
    const errors = [];
    window.addEventListener('error', event => errors.push(event.message));
    return { banner: document.querySelector('#banner').textContent };
  })()`);
  assert.equal(result.banner, '');
  controller.account = { type: 'chatgpt', plan: 'pro' };
  controller.models = [{ model: 'gpt-6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }];
  controller.connection = 'ready';
  // Directly exercise the same renderer function as the IPC state event.
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + ')');
  await window.webContents.executeJavaScript(`document.querySelector('#prompt').value = 'hello'; document.querySelector('#prompt').dispatchEvent(new Event('input'));`);
  assert.match(await window.webContents.executeJavaScript("document.querySelector('#connection-label').textContent"), /Connected Providers: 1/);
  console.log('Connected-state UI smoke passed');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#task-card')"), null);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#skip-checks')"), null);
  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#prompt').value = 'test message';
    document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true }));
    while (submitting) await new Promise(resolve => setTimeout(resolve, 10));
  })()`);
  assert.equal(sent.at(-1).task, 'on', 'checks run automatically behind the scenes');
  console.log('Background checks UI smoke passed');
  await window.webContents.executeJavaScript(`renderMessages({ items: [
    { id: 'visible', type: 'agentMessage', text: 'Visible result' },
    { id: 'maintenance', type: 'userMessage', content: [{ type: 'text', text: 'Hidden maintenance' }] },
    { id: 'maintenance-answer', turnId: 'wiki-turn', type: 'agentMessage', text: 'Hidden wiki assessment' }
  ], routes: [{ messageId: 'maintenance', turnId: 'wiki-turn', wikiMaintenanceTaskId: 'task' }] });`);
  const chat = await window.webContents.executeJavaScript("document.querySelector('#messages').textContent");
  assert.match(chat, /Visible result/);
  assert.doesNotMatch(chat, /Hidden/);
  await window.webContents.executeJavaScript(`window.fetchTest = Promise.all([loadDiscoveredModels('cursor-cli'), loadDiscoveredModels('cursor-cli')]).catch(() => null); true;`);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#models-loading').hidden"), false);
  while (!finishFetch) await new Promise(setImmediate);
  finishFetch();
  await window.webContents.executeJavaScript('window.fetchTest');
  assert.equal(modelRequests, 1);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#models-loading').hidden"), true);
  failModels = true; finishFetch = null;
  await window.webContents.executeJavaScript(`window.fetchTest = loadDiscoveredModels('cursor-cli').catch(() => null); true;`);
  while (!finishFetch) await new Promise(setImmediate);
  finishFetch();
  await window.webContents.executeJavaScript('window.fetchTest');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#models-loading').hidden"), true);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#renew-models').disabled"), false);
  console.log('Model-fetch indicator, deduplication and failure cleanup passed');
  controller.data.settings.claudeEnabled = true;
  controller.claude.status = { installed: true, loggedIn: true };
  controller.claude.models = [{ id: 'claude-cli:claude-opus-5-5', model: 'claude-opus-5-5', label: 'claude-opus-5-5', provider: 'claude-cli', effort: null,
    efforts: ['low', 'high', 'max'], rank: 35, worker: true, router: true, images: true }];
  controller.data.settings.disabledCodexModels = []; // gpt-6-sol enabled too, to check provider sections
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderProviders(); true');
  const models = await window.webContents.executeJavaScript("document.querySelector('#provider-model-list').textContent");
  assert.match(models, /claude-opus-5-5 · low\/high\/max/, 'one Claude row per model listing its efforts, like Codex');
  // Manual selection: one entry per model, and an effort select with every effort that model supports.
  const picker = await window.webContents.executeJavaScript(`(() => {
    showMode('claude-cli:claude-opus-5-5:high');
    const effort = document.querySelector('#effort');
    const result = { model: document.querySelector('#preset').selectedOptions[0].textContent, efforts: [...effort.options].map(o => o.textContent), effort: effort.value, hidden: effort.hidden, mode: currentMode(),
      models: [...document.querySelector('#preset').options].map(o => o.textContent) };
    effort.value = 'max'; result.after = currentMode();
    showMode('auto'); result.autoHidden = effort.hidden; result.autoMode = currentMode();
    return result;
  })()`);
  assert.equal(picker.model, 'claude-opus-5-5');
  assert.deepEqual(picker.efforts, ['low', 'high', 'max']);
  assert.equal(picker.effort, 'high');
  assert.equal(picker.hidden, false);
  assert.equal(picker.mode, 'claude-cli:claude-opus-5-5:high');
  assert.equal(picker.after, 'claude-cli:claude-opus-5-5:max');
  assert.equal(picker.models.filter(m => m === 'claude-opus-5-5').length, 1, 'one entry per model, not per effort');
  const sections = await window.webContents.executeJavaScript(`[...document.querySelectorAll('#preset optgroup')].map(g => [g.label, [...g.children].map(o => o.textContent)])`);
  assert.deepEqual(sections.map(([label]) => label), ['Codex / ChatGPT', 'Claude'], 'models are listed under their provider, Codex first');
  assert.deepEqual(sections[0][1], ['gpt-6-sol']);
  assert.deepEqual(sections[1][1], ['claude-opus-5-5']);
  assert.equal(picker.autoHidden, true);
  assert.equal(picker.autoMode, 'auto');
  assert.equal(await window.webContents.executeJavaScript("providerCaps('cursor-cli').usage"), false);
  assert.equal(await window.webContents.executeJavaScript("providerCaps('claude-cli').steer"), false);
  assert.equal(await window.webContents.executeJavaScript("providerCaps(undefined).steer"), true);
  console.log('Claude per-effort model rows and provider capabilities passed');
  // Disconnected in the Harness while the CLIs stay signed in: no models listed, detail says the CLI is still signed in.
  controller.account = null; controller.models = [];
  controller.codex = { installed: true, connected: true, signedIn: true };
  controller.data.settings.claudeEnabled = false;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderProviders(); true');
  const providers = await window.webContents.executeJavaScript("document.querySelector('#panel-providers').textContent");
  assert.match(providers, /ChatGPT · disconnected/);
  assert.match(providers, /Claude · disconnected/);
  assert.doesNotMatch(await window.webContents.executeJavaScript("document.querySelector('#provider-model-list').textContent"), /claude-opus-5-5/, 'Claude models are hidden');
  assert.doesNotMatch(await window.webContents.executeJavaScript("document.querySelector('#provider-model-list').textContent"), /gpt-6-sol/);
  console.log('Disconnected providers hide models and keep CLI logins passed');
  // Settings loads Cursor's full model list even when some models are already enabled; rows show model names only.
  failModels = false; finishFetch = null;
  nextModels = [{ id: 'grok-4.7', label: 'Grok 4.7' }, { id: 'kimi-k3', label: 'Kimi K3' }, { id: 'gpt-5.5', label: 'GPT-5.5' }];
  controller.cursor.status = { installed: true, loggedIn: true };
  controller.data.settings.cursorEnabled = true;
  controller.cursor.models = [{ id: 'grok-4.7', label: 'Grok 4.7', parameterized: true, efforts: ['low', 'high'], effortOption: 'effort', parameters: {} }];
  controller.data.settings.providerModels = [{ id: 'cursor-cli:grok-4.7:default', provider: 'cursor-cli', model: 'grok-4.7', label: 'Grok 4.7', effort: null, rank: 40, enabled: true, worker: true, router: true, images: false, description: '', parameterized: true }];
  await window.webContents.executeJavaScript('discoveredModels.clear(); applyState(' + JSON.stringify(controller.snapshot()) + '); renderProviders(); true');
  while (!finishFetch) await new Promise(setImmediate);
  finishFetch();
  await new Promise(resolve => setTimeout(resolve, 200));
  const cursorRows = await window.webContents.executeJavaScript(`[...document.querySelectorAll('#provider-model-list .provider-model-row')].map(r => r.textContent).filter(t => t.endsWith('· Cursor'))`);
  assert.deepEqual(cursorRows, ['GPT-5.5 · Cursor', 'Grok 4.7 · Cursor', 'Kimi K3 · Cursor']);
  console.log('Cursor settings list the full model list, one row per model, no efforts passed');
  controller.close();
  window.destroy();
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
// Chromium still owns files here during shutdown; cleanup is left to the temp directory.
