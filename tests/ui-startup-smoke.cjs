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
  let modelRequests = 0, failModels = false, finishFetch;
  ipcMain.handle('providerModels', async () => {
    modelRequests++;
    await new Promise(resolve => { finishFetch = resolve; });
    if (failModels) throw new Error('Test model fetch failed');
    return [];
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
  controller.close();
  window.destroy();
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
// Chromium still owns files here during shutdown; cleanup is left to the temp directory.
