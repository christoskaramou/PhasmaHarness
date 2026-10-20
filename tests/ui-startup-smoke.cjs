// Run with Electron, not Node. No provider login or inference is performed.
const { app, BrowserWindow, ipcMain, nativeTheme } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { Controller } = require('../src/controller.cjs');
const { JevClient } = require('../src/providers/jev.cjs');
const { confirmations } = require('../src/confirmations.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ui-'));
app.setPath('userData', root);
// Xvfb runners may lack a working GPU readback path for offscreen screenshots.
app.disableHardwareAcceleration();
fs.mkdirSync(path.resolve(__dirname, '../.scratch'), { recursive: true });
const startedAt = Date.now();
let phase = 'Electron startup';
const deadline = setTimeout(() => { console.error(`UI smoke timed out during ${phase} after ${Date.now() - startedAt} ms`); app.exit(1); }, 30000);
app.whenReady().then(async () => {
  phase = 'renderer startup';
  const controller = new Controller(path.join(root, 'sessions.json'), root);
  const documents = new (require('../src/documents.cjs').DocumentReader)();
  ipcMain.handle('readDocument', (_event, value) => documents.read(value));
  ipcMain.handle('bootstrap', () => controller.snapshot());
  const browseCalls = [];
  ipcMain.handle('browseWorkspace', (_event, ...args) => { browseCalls.push(args); return { available: false, entries: [] }; });
  let previews = 0;
  ipcMain.handle('preview', () => { previews++; return { label: 'Auto', reason: 'Smoke test' }; });
  const imageRequests = [];
  ipcMain.handle('image', (_event, ...args) => { imageRequests.push(args); return 'data:image/jpeg;base64,/9j/4AAQ'; });
  ipcMain.handle('setAppearance', () => {});
  ipcMain.handle('benchmarkData', () => ({ data: { records: [] },
    summary: { records: 0, matched: 0, workers: 0, updatedAt: 'fixture', sources: [] } }));
  const sent = [];
  let failSend = false;
  ipcMain.handle('create', (_event, workspace, access) => controller.create(workspace, access));
  let voiceRequest = null, finishVoice = null;
  ipcMain.handle('voiceInfo', () => ({ supported: true, languages: [{ id: 'offline', name: 'English' }] }));
  ipcMain.handle('voiceStart', (_event, request) => {
    voiceRequest = request;
    window.webContents.send('voice', { ...request, type: 'state', state: 'listening' });
    return { ...request, state: 'listening' };
  });
  ipcMain.handle('voiceStop', (_event, id) => new Promise(resolve => {
    assert.equal(id, voiceRequest.id);
    finishVoice = text => {
      window.webContents.send('voice', { ...voiceRequest, type: 'text', state: 'stopping', sequence: 1, text });
      window.webContents.send('voice', { ...voiceRequest, type: 'state', state: 'idle' });
      resolve({ ...voiceRequest, state: 'idle' });
    };
  }));
  const savedChecks = [];
  ipcMain.handle('checks', (_event, workspace, list) => { savedChecks.push(list); return controller.checks(workspace, list); });
  ipcMain.handle('settings', (_event, values) => controller.settings(values));
  let chosenWorkspace = root;
  ipcMain.handle('chooseWorkspace', () => chosenWorkspace);
  ipcMain.handle('providerSettings', (_event, value) => controller.providerSettings(value));
  const providerKeys = new Map();
  let localModelLoaded = false, localModelError = false;
  const localModelActions = [];
  ipcMain.handle('localModel', (_event, choice, action) => {
    localModelActions.push({ choice, action });
    if (localModelError) throw new Error('Local server unavailable');
    if (action === 'load') localModelLoaded = true;
    if (action === 'unload') localModelLoaded = false;
    return { supported: true, loaded: localModelLoaded, contextLength: localModelLoaded ? 32768 : null, canResize: true, busy: false };
  });
  ipcMain.handle('providerKey', (_event, id, key) => { if (key) providerKeys.set(id, key); else providerKeys.delete(id); return controller.snapshot(); });
  ipcMain.handle('appInfo', () => ({ version: '0.1.0', packaged: true }));
  let runnerStart = false, runnerExit = 'tray';
  ipcMain.handle('runnerInfo', () => ({ status: 'Runner ready', running: true, background: true, onExit: runnerExit,
    autostart: { supported: true, enabled: runnerStart } }));
  ipcMain.handle('runnerOnExit', (_event, value) => (runnerExit = value));
  ipcMain.handle('runnerAutostart', (_event, enabled) => ({ supported: true, enabled: (runnerStart = enabled) }));
  let browserAccess = { running: false, port: 8788, origin: null, connectionURL: null };
  ipcMain.handle('remoteInfo', () => browserAccess);
  ipcMain.handle('remoteStart', (_event, value) => (browserAccess = { running: true, ...value, origin: value.origin || 'http://127.0.0.1:8788', connectionURL: 'fixture-private-link' }));
  ipcMain.handle('remoteStop', () => (browserAccess = { ...browserAccess, running: false, connectionURL: null }));
  ipcMain.handle('remoteDisconnectAll', () => browserAccess);
  ipcMain.handle('remoteResetLink', () => browserAccess);
  let updateResult = { current: '0.1.0', latest: '0.2.0', newer: true, url: 'https://github.com/x/y/releases/tag/v0.2.0', installer: 'Phasma-Harness-Setup-0.2.0.exe' };
  ipcMain.handle('checkUpdates', () => { if (updateResult instanceof Error) throw updateResult; return updateResult; });
  let installs = 0;
  ipcMain.handle('updateStatus', () => ({ status: 'idle' }));
  ipcMain.handle('installUpdate', () => { installs++; });
  let holdSend = false;
  ipcMain.handle('send', (_event, message) => {
    if (failSend) throw new Error('Test send failed');
    sent.push(message);
    // A Claude or Cursor send resolves only when its turn ends.
    if (holdSend) return new Promise(() => {});
    return { queued: true };
  });
  let modelRequests = 0, cursorModelRequests = 0, failModels = false, finishFetch, nextModels = [], holdApiModels = false;
  ipcMain.handle('providerModels', async (_event, id) => {
    modelRequests++;
    if (id === 'cursor-cli')
      cursorModelRequests++;
    if (id !== 'cursor-cli' && !holdApiModels) return [];
    await new Promise(resolve => { finishFetch = resolve; });
    if (failModels) throw new Error('Test model fetch failed');
    return nextModels;
  });
  // Offscreen rendering keeps hidden-window captures current, including modal top layers.
  const window = new BrowserWindow({ show: false,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { height: 40 } } : {}),
    webPreferences: { preload: path.resolve(__dirname, '../src/preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  require('../src/window-zoom.cjs').configureWindowZoom(window.webContents, path.join(root, 'zoom.json'), error => { throw error; });
  const confirmation = confirmations(window);
  ipcMain.handle('answerConfirmation', (_event, id, accepted) => confirmation.answer(id, accepted));
  await window.loadFile(path.resolve(__dirname, '../ui/index.html'));
  const titlebar = await window.webContents.executeJavaScript(`(() => {
    const header = document.querySelector('main > header');
    const action = document.querySelector('#browse-session');
    const overlay = navigator.windowControlsOverlay;
    const safe = overlay?.getTitlebarAreaRect();
    return {
      draggable: getComputedStyle(header).webkitAppRegion,
      clickable: getComputedStyle(action).webkitAppRegion,
      visible: overlay?.visible || false,
      clear: !overlay?.visible || document.querySelector('.header-actions').getBoundingClientRect().right <= safe.right
    };
  })()`);
  assert.equal(titlebar.draggable, 'drag');
  assert.equal(titlebar.clickable, 'no-drag');
  assert.equal(titlebar.clear, true, 'header actions stay out of the native window controls');
  if (process.platform === 'win32') assert.equal(titlebar.visible, true);
  console.log('Native titlebar overlay, drag region and header safe area passed');
  assert.equal(window.webContents.getZoomFactor(), 1.15, 'new windows default to 115% whole-page zoom');
  for (let i = 0; i < 3; i++) window.webContents.emit('before-input-event', { preventDefault() {} },
    { type: 'keyDown', control: true, key: '-' });
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#settings-font") === null'), true);
  // A cold Windows runner can spend 10+ seconds starting Chromium before any checks run.
  deadline.refresh(); phase = 'settings checks';
  console.log(`Renderer ready after ${Date.now() - startedAt} ms; starting UI checks`);
  const result = await window.webContents.executeJavaScript(`(() => {
    const errors = [];
    window.addEventListener('error', event => errors.push(event.message));
    return { banner: document.querySelector('#banner').textContent };
  })()`);
  assert.equal(result.banner, '');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#provider-connection').hidden"), false, 'startup shows connection progress');
  const sidebarSettings = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#settings');
    const icon = button.querySelector('svg');
    const width = icon.getBoundingClientRect().width;
    icon.setAttribute('width', '1em');
    const previousWidth = icon.getBoundingClientRect().width;
    icon.setAttribute('width', '.8em');
    return { text: button.textContent.trim(), name: button.getAttribute('aria-label'), title: button.title,
      ratio: width / previousWidth,
      shieldShift: getComputedStyle(document.querySelector('.composer-access svg')).transform };
  })()`);
  assert.equal(sidebarSettings.text, '');
  assert.equal(sidebarSettings.name, 'Settings');
  assert.equal(sidebarSettings.title, 'Settings');
  assert.ok(Math.abs(sidebarSettings.ratio - .8) < .01, 'sidebar gear is 20% smaller: ' + JSON.stringify(sidebarSettings));
  assert.equal(sidebarSettings.shieldShift, 'matrix(1, 0, 0, 1, -4, 0)', 'shield moves closer to plus');
  const shieldFocus = await window.webContents.executeJavaScript(`(() => {
    const access = document.querySelector('#permissions');
    const disabled = access.disabled;
    access.disabled = false;
    access.focus();
    const result = {
      focused: document.activeElement === access,
      outline: getComputedStyle(access.parentElement).outlineStyle,
      stroke: getComputedStyle(access.parentElement.querySelector('svg')).strokeWidth
    };
    access.blur();
    access.disabled = disabled;
    return result;
  })()`);
  assert.deepEqual(shieldFocus, { focused: true, outline: 'none', stroke: '3px' },
    'focused access selector highlights only the shield, never a surrounding box');
    const composerFocus = await window.webContents.executeJavaScript(`(() => {
    const prompt = document.querySelector('#prompt');
    return ['#composer', '.composer-bottom', '.composer-controls'].every(selector => {
      prompt.blur();
      document.querySelector(selector).click();
      return document.activeElement === prompt;
    });
  })()`);
  assert.ok(composerFocus, 'clicking composer whitespace focuses the text input');
  const composerLayout = await window.webContents.executeJavaScript(`(() => {
    const prompt = document.querySelector('#prompt');
    const root = document.documentElement;
    const savedScale = root.style.getPropertyValue('--font-scale');
    const savedPrompt = prompt.value;
    const results = [];
  for (const scale of [1, 1.5]) {
      root.style.setProperty('--font-scale', scale);
      const line = parseFloat(getComputedStyle(prompt).lineHeight);
      prompt.value = ''; resizeComposer();
      const empty = prompt.getBoundingClientRect().height;
      prompt.value = 'first\\nsecond\\nthird'; resizeComposer();
      const three = prompt.getBoundingClientRect().height;
      prompt.value = 'wrapped content '.repeat(500); resizeComposer();
      const capped = prompt.getBoundingClientRect().height;
      const scrolls = prompt.scrollHeight > prompt.clientHeight;
      prompt.value = 'short'; resizeComposer();
      const shrunk = prompt.getBoundingClientRect().height;
      const controls = ['#attach-files', '.composer-access', '#dictate', '.chat-options > summary', '#send']
        .map(selector => document.querySelector(selector).getBoundingClientRect());
      const centers = controls.map(rect => rect.top + rect.height / 2);
      const inputRect = prompt.getBoundingClientRect();
      centers.push(inputRect.top + inputRect.height / 2);
      const order = ['#attach-files', '.composer-access', '#prompt', '#chat-options', '#dictate', '#send']
        .map(selector => document.querySelector(selector).getBoundingClientRect());
      const ordered = order.every((rect, i) => !i || rect.left >= order[i - 1].right - 1);
      const access = document.querySelector('#permissions');
      const wasFull = access.classList.contains('full-access');
      access.classList.add('full-access');
      const red = getComputedStyle(access.parentElement).color.match(/\\d+/g).map(Number);
      access.classList.toggle('full-access', wasFull);
      const inlineBottom = document.querySelector('#composer').getBoundingClientRect().bottom - controls[0].bottom;
      const inlineWidth = prompt.getBoundingClientRect().width;
      prompt.value = 'W'.repeat(Math.ceil(inlineWidth / measure.measureText('W').width) + 1);
      resizeComposer();
      const expanded = document.querySelector('#composer').classList.contains('composer-expanded');
      const aboveControls = prompt.getBoundingClientRect().bottom <= document.querySelector('.composer-controls').getBoundingClientRect().top;
      const fullWidth = Math.abs(prompt.getBoundingClientRect().width - document.querySelector('.composer-bottom').clientWidth) < 1;
      const bottomOffset = document.querySelector('#composer').getBoundingClientRect().bottom - document.querySelector('#attach-files').getBoundingClientRect().bottom;
      const shield = getComputedStyle(document.querySelector('.composer-access'));
      const bareShield = parseFloat(shield.borderTopWidth) === 0 && shield.backgroundColor === 'rgba(0, 0, 0, 0)';
      prompt.value = 'short'; resizeComposer();
      const collapsed = !document.querySelector('#composer').classList.contains('composer-expanded');
      const icons = ['#attach-files svg', '#dictate svg', '#send svg'].map(selector => {
        const icon = document.querySelector(selector);
        const rect = icon.getBoundingClientRect();
        const button = icon.closest('button').getBoundingClientRect();
        return Math.abs(rect.top + rect.height / 2 - button.top - button.height / 2);
      });
      results.push({ expanded, aboveControls, fullWidth, collapsed, bareShield, bottomDrift: Math.abs(bottomOffset - inlineBottom), scale, line, empty, three, capped, scrolls, shrunk, ordered, redAccess: red[0] > red[1] && red[0] > red[2],
        centerSpread: Math.max(...centers) - Math.min(...centers),
        heightSpread: Math.max(...controls.slice(1).map(r => r.height)) - Math.min(...controls.slice(1).map(r => r.height)),
        iconOffset: Math.max(...icons) });
    }
    prompt.value = savedPrompt; resizeComposer();
    if (savedScale) root.style.setProperty('--font-scale', savedScale);
    else root.style.removeProperty('--font-scale');
    return results;
  })()`);
  for (const result of composerLayout) {
    assert.ok(Math.abs(result.empty - result.line) < 1, 'empty composer is one line');
    assert.ok(Math.abs(result.three - 3 * result.line) < 1, 'newlines grow the composer');
    assert.ok(Math.abs(result.capped - 6 * result.line) < 1, 'wrapped text caps at six lines');
    assert.equal(result.scrolls, true);
    assert.ok(Math.abs(result.shrunk - result.line) < 1, 'deleting text shrinks the composer');
    assert.equal(result.expanded && result.aboveControls && result.fullWidth, true, 'overflow moves text to a full-width row above controls');
    assert.equal(result.collapsed, true, 'short drafts return to the inline row');
    assert.equal(result.bareShield, true, 'access shield has no outer box');
    assert.ok(result.bottomDrift < 1, 'controls stay anchored to the composer bottom');
    assert.equal(result.ordered, true, 'composer controls and input form one ordered row');
    assert.equal(result.redAccess, true, 'full access is shown in red');
    assert.ok(result.centerSpread < 1, 'all composer controls and input share a vertical center');
    assert.ok(result.heightSpread < 1, 'composer controls except plus share the smaller height');
    assert.ok(result.iconOffset < 1, 'icons are centered inside their buttons');
  }
  console.log('Composer growth, six-line limit and control alignment passed at both font scales');
  const composerScroll = await window.webContents.executeJavaScript(`(async () => {
    const conversation = document.querySelector('#conversation');
    const prompt = document.querySelector('#prompt');
    const saved = prompt.value;
    const content = document.createElement('div');
    content.style.height = '2000px';
    conversation.append(content);
    const settle = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    prompt.value = '';
    await settle();
    conversation.scrollTo({ top: conversation.scrollHeight, behavior: 'instant' });
    await settle();
    const gap = () => conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight;
    const beforeHeight = conversation.clientHeight;
    prompt.value = 'long draft '.repeat(500);
    await settle();
    const grownGap = gap();
    const shrankViewport = conversation.clientHeight < beforeHeight;
    const noOverlap = conversation.getBoundingClientRect().bottom <= document.querySelector('.composer-area').getBoundingClientRect().top + 1;
    prompt.value = '';
    await settle();
    const shrunkGap = gap();
    conversation.scrollTo({ top: 100, behavior: 'instant' });
    await settle();
    const historyTop = conversation.scrollTop;
    prompt.value = 'long draft '.repeat(500);
    await settle();
    const historyAfterGrowth = conversation.scrollTop;
    prompt.value = '';
    await settle();
    const historyAfterShrink = conversation.scrollTop;
    content.remove();
    prompt.value = saved;
    await settle();
    return { grownGap, shrunkGap, shrankViewport, noOverlap, historyTop, historyAfterGrowth, historyAfterShrink };
  })()`);
  assert.equal(composerScroll.shrankViewport, true);
  assert.equal(composerScroll.noOverlap, true);
  assert.ok(Math.abs(composerScroll.grownGap) < 2, 'composer growth keeps the newest chat visible');
  assert.ok(Math.abs(composerScroll.shrunkGap) < 2, 'composer shrink keeps the newest chat visible');
  assert.ok(Math.abs(composerScroll.historyAfterGrowth - composerScroll.historyTop) < 2, 'growth preserves history reading position');
  assert.ok(Math.abs(composerScroll.historyAfterShrink - composerScroll.historyTop) < 2, 'shrink preserves history reading position');
  console.log('Composer resize preserves bottom-following and history reading position');
  const quietComposer = await window.webContents.executeJavaScript(`(() => {
    const area = document.querySelector('.composer-area');
    return {
      endsAtComposer: area.lastElementChild.id === 'composer',
      actionsHidden: ['clear-conversation', 'commands-help', 'context-meter', 'usage']
        .every(id => !document.getElementById(id).checkVisibility()),
      connectionInHeader: !!document.querySelector('header #provider-connection')
    };
  })()`);
  assert.deepEqual(quietComposer, { endsAtComposer: true, actionsHidden: true, connectionInHeader: true },
    'the composer has no persistent footer; advanced actions remain on demand');
  const appearanceState = () => window.webContents.executeJavaScript(`({
    mode: document.documentElement.dataset.appearance,
    background: getComputedStyle(document.body).backgroundColor,
    draft: document.querySelector('#prompt').value,
    sidebar: !!document.querySelector('#agents-sidebar #settings'),
    optionsClosed: !document.querySelector('#chat-options').open
  })`);
  const chooseAppearance = mode => window.webContents.executeJavaScript(`(() => {
    const control = document.querySelector('#settings-appearance');
    control.value = ${JSON.stringify(mode)};
    control.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  const savedThemeSource = nativeTheme.themeSource;
  const themeFrame = () => new Promise(resolve => setTimeout(resolve, 40));
  const callsBeforeAppearance = { sent: sent.length, previews };
  try {
    assert.equal((await appearanceState()).mode, 'system');
    await window.webContents.executeJavaScript('document.querySelector("#prompt").value = "Keep this draft"; true');
    nativeTheme.themeSource = 'light';
    await themeFrame();
    assert.equal((await appearanceState()).background, 'rgb(255, 255, 255)');
    nativeTheme.themeSource = 'dark';
    await themeFrame();
    assert.equal((await appearanceState()).background, 'rgb(25, 25, 25)', 'System follows live OS appearance changes');
    await chooseAppearance('light');
    assert.deepEqual(await appearanceState(), {
      mode: 'light', background: 'rgb(255, 255, 255)', draft: 'Keep this draft', sidebar: true, optionsClosed: true,
    });
    nativeTheme.themeSource = 'light';
    await chooseAppearance('dark');
    await themeFrame();
    assert.equal((await appearanceState()).background, 'rgb(25, 25, 25)', 'explicit Dark overrides a light OS');
    assert.deepEqual({ sent: sent.length, previews }, callsBeforeAppearance, 'appearance does not call providers or routing');
    await new Promise(resolve => {
      window.webContents.once('did-finish-load', resolve);
      window.reload();
    });
    assert.equal((await appearanceState()).mode, 'dark', 'appearance is restored on reload');
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("#settings-appearance").value'), 'dark');
    await chooseAppearance('system');
    assert.equal((await appearanceState()).background, 'rgb(255, 255, 255)');
  } finally {
    nativeTheme.themeSource = savedThemeSource;
  }
  const initialWindowSize = window.getSize();
  const sidebarSize = () => window.webContents.executeJavaScript(`({ width: document.querySelector('#agents-sidebar').getBoundingClientRect().width,
    saved: localStorage.getItem('sidebarWidth'), now: document.querySelector('#sidebar-resizer').getAttribute('aria-valuenow'),
    dragging: document.body.classList.contains('resizing-sidebar'), max: innerWidth - 486 })`);
  const resizeKey = key => window.webContents.executeJavaScript(`document.querySelector('#sidebar-resizer').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); true`);
  const dragSidebar = async (delta, cancel = false) => {
    const x = await window.webContents.executeJavaScript("Math.round(document.querySelector('#sidebar-resizer').getBoundingClientRect().left + 3)");
    window.webContents.sendInputEvent({ type: 'mouseMove', x, y: 200 });
    window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', x, y: 200, clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseMove', x: x + delta, y: 200 });
    await new Promise(r => setTimeout(r, 30));
    if (cancel) await resizeKey('Escape');
    window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', x: x + delta, y: 200, clickCount: 1 });
    await new Promise(r => setTimeout(r, 30));
  };
  const initialSidebar = await sidebarSize();
  await dragSidebar(70);
  const resizedSidebar = await sidebarSize();
  assert.equal(resizedSidebar.width, initialSidebar.width + 70);
  assert.equal(resizedSidebar.saved, String(resizedSidebar.width));
  assert.equal(resizedSidebar.now, resizedSidebar.saved);
  assert.equal(resizedSidebar.dragging, false);
  await dragSidebar(-40, true);
  assert.deepEqual(await sidebarSize(), resizedSidebar, 'Escape cancels the resize without changing the saved width');
  await window.loadFile(path.resolve(__dirname, '../ui/index.html'));
  assert.equal((await sidebarSize()).width, resizedSidebar.width, 'sidebar width survives a reload');
  await resizeKey('ArrowLeft');
  assert.equal((await sidebarSize()).width, resizedSidebar.width - 10);
  window.setSize(1320, 900); await new Promise(r => setTimeout(r, 50));
  await resizeKey('End');
  assert.equal((await sidebarSize()).width, 520);
  window.setSize(840, 640); await new Promise(r => setTimeout(r, 50));
  const constrainedSidebar = await sidebarSize();
  assert.ok(constrainedSidebar.width <= constrainedSidebar.max, 'chat retains room when the window shrinks');
  assert.equal(constrainedSidebar.saved, '520');
  window.setSize(1320, 900); await new Promise(r => setTimeout(r, 50));
  assert.equal((await sidebarSize()).width, 520, 'growing the window restores the preferred width');
  await resizeKey('Home');
  assert.equal((await sidebarSize()).width, 200);
  window.setSize(...initialWindowSize); await new Promise(r => setTimeout(r, 50));
  await window.webContents.executeJavaScript("document.querySelector('#sidebar-resizer').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); true");
  assert.equal((await sidebarSize()).width, initialSidebar.width);
  assert.equal((await sidebarSize()).saved, null);
  console.log('Sidebar drag, keyboard controls, cancel, persistence and viewport limits passed');
  controller.account = { type: 'chatgpt', plan: 'pro' };
  controller.models = [{ model: 'gpt-6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }];
  controller.connection = 'ready';
  // Directly exercise the same renderer function as the IPC state event.
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + ')');
  await window.webContents.executeJavaScript(`document.querySelector('#prompt').value = 'hello'; document.querySelector('#prompt').dispatchEvent(new Event('input'));`);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#send').disabled"), false, 'connected providers enable sending');
  console.log('Connected-state UI smoke passed');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#provider-connection').hidden"), true);
  controller.chatgptLoginPending = true;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderProviders(); true');
  const connecting = await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-connection-provider="codex"]');
    return { visible: !document.querySelector('#provider-connection').hidden, usageHidden: document.querySelector('#usage').hidden,
      busy: row.getAttribute('aria-busy'), disabled: row.querySelector('button').disabled, status: row.querySelector('.provider-connecting').textContent };
  })()`);
  assert.deepEqual(connecting, { visible: true, usageHidden: true, busy: 'true', disabled: true, status: 'Waiting for sign-in…' });
  controller.chatgptLoginPending = false;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + ')');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#provider-connection').hidden"), true);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('[data-connection-provider=codex] button').disabled"), false);
  const fleet = controller.snapshot();
  fleet.agentStates = { main: { ...fleet }, worker: { ...fleet, connectingProviders: ['claude-cli'] } };
  fleet.agents = [{ id: 'main', name: 'Main' }, { id: 'worker', name: 'Worker' }];
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(fleet) + ')');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#provider-connection').hidden"), false, 'another agent connecting remains visible');
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + ')');
  console.log('Provider connecting indicators and browser sign-in cleanup passed');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#task-card')"), null);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#skip-checks')"), null);
  const submit = (text, wait = true) => window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#prompt').value = ${JSON.stringify(text)};
    document.querySelector('#prompt').dispatchEvent(new Event('input'));
    document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true }));
    for (let i = 0; ${wait} && i < 100 && submitting; i++) await new Promise(resolve => setTimeout(resolve, 20));
  })()`);
  const until = async (condition, what) => { for (let i = 0; i < 100 && !condition(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(condition(), what); };
  phase = 'dictation checks';
  await window.webContents.executeJavaScript('document.querySelector("#dictate").click(); true');
  await until(() => voiceRequest, 'dictation binds to the original chat');
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 20))');
  const beforeVoice = sent.length;
  await submit('typed before speaking', false);
  await until(() => finishVoice, 'Send stops the microphone before reading its final words');
  await window.webContents.executeJavaScript('document.querySelector("#composer").dispatchEvent(new Event("submit", { cancelable: true })); true');
  assert.equal(sent.length, beforeVoice, 'dictation does not send before Stop completes');
  finishVoice('final dictated words');
  await until(() => sent.length === beforeVoice + 1, 'Send includes the final recognized words exactly once');
  assert.equal(sent.at(-1).text, 'typed before speaking final dictated words');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#dictation-status").hidden'), true);
  voiceRequest = null; finishVoice = null;
  await window.webContents.executeJavaScript('document.querySelector("#dictate").click(); true');
  await until(() => voiceRequest, 'a later dictation can start');
  const voiceSource = voiceRequest.sessionId;
  await window.webContents.executeJavaScript('selectSession(null)');
  await until(() => finishVoice, 'switching chats stops dictation');
  finishVoice('words for the original chat');
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 20))');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '');
  assert.equal(await window.webContents.executeJavaScript('drafts.get(' + JSON.stringify(voiceSource) + ')'), 'words for the original chat');
  await window.webContents.executeJavaScript('selectedId = ' + JSON.stringify(voiceSource) + '; drafts.delete(selectedId); document.querySelector("#prompt").value = ""; render(); updatePreview();');
  console.log('Local dictation indicator, final-word Send, duplicate Send guard and original-chat draft preservation passed (fake audio)');
  phase = 'composer checks';
  let before = sent.length;
  await submit('test message');
  await until(() => sent.length > before, 'the message reached the app');
  assert.equal(sent.at(-1).task, 'on', 'checks run automatically behind the scenes');
  console.log('Background checks UI smoke passed');
  // While a Claude or Cursor turn runs its send has not returned; the next message can still be sent (and is queued).
  holdSend = true; before = sent.length;
  await submit('first, a long Claude turn');
  await until(() => sent.length === before + 1, 'the first message reached the app');
  await window.webContents.executeJavaScript(`document.querySelector('#prompt').value = 'a follow-up'; document.querySelector('#prompt').dispatchEvent(new Event('input')); true`);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#send').disabled"), false, 'the composer is not locked by the running send');
  await submit('a follow-up');
  await until(() => sent.length === before + 2, 'the follow-up was sent too');
  assert.equal(sent.at(-1).text, 'a follow-up');
  holdSend = false;
  // A send that fails puts the message back into the composer.
  failSend = true;
  await submit('this one fails');
  let restored = '';
  for (let i = 0; i < 100 && restored !== 'this one fails'; i++) { await new Promise(r => setTimeout(r, 20)); restored = await window.webContents.executeJavaScript("document.querySelector('#prompt').value"); }
  assert.equal(restored, 'this one fails', 'the failed message is back in the composer');
  failSend = false;
  await window.webContents.executeJavaScript(`document.querySelector('#prompt').value = ''; document.querySelector('#prompt').dispatchEvent(new Event('input')); true`);
  console.log('Sending while a turn runs passed');
  phase = 'file attachments';
  const attachment = { name: '<reference>.cpp', text: 'const value = 42;\n<img src=x onerror="window.ATTACHMENT_RAN=1">' };
  await window.webContents.executeJavaScript(`readAttachments([new File([${JSON.stringify(attachment.text)}], ${JSON.stringify(attachment.name)}, { type: 'text/plain' })])`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".file-preview span").textContent'), attachment.name);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#send").disabled'), false, 'a file-only draft can be sent');
  await window.webContents.executeJavaScript('readAttachments([new File(["not supported"], "document.pdf")])');
  assert.deepEqual(await window.webContents.executeJavaScript('attachedFiles().map(file => file.name)'), [attachment.name], 'a rejected selection keeps the current attachments');
  before = sent.length;
  await submit('');
  await until(() => sent.length === before + 1, 'file-only send reaches the app');
  assert.deepEqual(sent.at(-1).files, [attachment]);
  assert.equal(await window.webContents.executeJavaScript('attachedFiles().length'), 0);
  failSend = true;
  await window.webContents.executeJavaScript('readAttachments([new File(["retained snapshot"], "pending.txt")])');
  await submit('Keep this file.');
  await until(async () => await window.webContents.executeJavaScript('document.querySelector("#prompt").value === "Keep this file." && attachedFiles().length === 1'), 'failed file send restores the draft');
  assert.equal(await window.webContents.executeJavaScript('attachedFiles()[0].text'), 'retained snapshot');
  failSend = false;
  await window.webContents.executeJavaScript(`fileDrafts.set(draftKey(), [{ name: 'new.txt', text: 'New draft file' }]);
    document.querySelector('#prompt').value = 'New draft';
    restoreDraft(selectedId, 'Old draft', [], new Error('Fixture failure'), [{ name: 'old.txt', text: 'Old draft file' }]); true`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'New draft');
  assert.deepEqual(await window.webContents.executeJavaScript('attachedFiles().map(file => file.name)'), ['new.txt', 'old.txt']);
  const preparedFile = require('../ui/attachments.js').prepare('Review this snapshot.', [attachment]);
  const fileMessage = { id: 'file-snapshot', type: 'userMessage', content: [{ type: 'text', text: preparedFile.text }], fileMessage: preparedFile.fileMessage };
  await window.webContents.executeJavaScript(`fileDrafts.delete(draftKey()); document.querySelector('#prompt').value = '';
    current().items.push(${JSON.stringify(fileMessage)}); render(); true`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#messages .sent-file summary").textContent'), attachment.name);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#messages .sent-file pre").textContent'), attachment.text);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#messages .sent-file").open'), false);
  assert.equal(await window.webContents.executeJavaScript('window.ATTACHMENT_RAN'), undefined);
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll("#messages img").length'), 0);
  await window.webContents.executeJavaScript('readAttachments([new File(["A pending file"], "pending.txt")])');
  await window.webContents.executeJavaScript('document.querySelector("#toast").hidden = true; clearTimeout(toastTimer); true');
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/file-attachments.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript('fileDrafts.delete(draftKey()); renderImages(); true');
  await window.webContents.executeJavaScript(`sentHistory = null; document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); true`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Review this snapshot.');
  assert.deepEqual(await window.webContents.executeJavaScript('attachedFiles()'), [attachment]);
  await window.webContents.executeJavaScript(`current().items.pop(); fileDrafts.delete(draftKey()); drafts.delete(draftKey());
    document.querySelector('#prompt').value = ''; sentHistory = null; render(); renderImages(); true`);
  const focusKept = await window.webContents.executeJavaScript(`(() => {
    fileDrafts.set(draftKey(), [{ name: 'focus.txt', text: 'Keep focus' }]); renderImages();
    const remove = document.querySelector('#image-previews .file-remove'); remove.focus(); render();
    const kept = document.activeElement === remove && remove.isConnected;
    fileDrafts.delete(draftKey()); renderImages(); return kept;
  })()`);
  assert.equal(focusKept, true, 'a state update must not rebuild the attachment tray under the focused remove button');
  await window.webContents.executeJavaScript(`current().items.push({ id: 'image-message', type: 'userMessage',
    content: [{ type: 'text', text: 'See the image.' }, { type: 'image', url: null }] }); render(); true`);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#messages img.message-image").src'), 'data:image/jpeg;base64,/9j/4AAQ');
  assert.deepEqual(imageRequests.at(-1).slice(1), ['image-message', 0]);
  await window.webContents.executeJavaScript('current().items.pop(); render(); true');
  console.log('Text/code file snapshots, binary rejection, safe collapsed display, recall and failed-send preservation passed');
  phase = 'document attachments';
  const documentFixtures = require('./fixtures/documents.cjs');
  const documentResults = await window.webContents.executeJavaScript(`(async () => {
    fileDrafts.delete(draftKey()); document.querySelector('#prompt').value = '';
    await readAttachments([new File([new Uint8Array(${JSON.stringify([...documentFixtures.pdf()])})], 'brief.pdf'),
      new File([new Uint8Array(${JSON.stringify([...documentFixtures.docx()])})], 'brief.docx')]);
    return attachedFiles();
  })()`);
  assert.equal(documentResults.length, 2, await window.webContents.executeJavaScript('document.querySelector("#banner").textContent'));
  assert.deepEqual(documentResults[0], { name: 'brief.pdf', format: 'pdf', text: 'Build three small games.' });
  assert.equal(documentResults[1].format, 'docx');
  assert.equal(documentResults[1].text, 'Καλημέρα & hello\nBuild three small games.');
  assert.match(await window.webContents.executeJavaScript('document.querySelector(".file-preview").textContent'), /brief.pdf · text/);
  assert.match(await window.webContents.executeJavaScript('document.querySelector(".file-preview span").title'), /Extracted text only/);
  const hostileXml = '<!DOCTYPE test [<!ENTITY injected "secret">]><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"/>';
  await window.webContents.executeJavaScript('readAttachments([new File([new Uint8Array(' + JSON.stringify([...documentFixtures.docx(hostileXml)]) + ')], "unsafe.docx")])');
  assert.deepEqual(await window.webContents.executeJavaScript('attachedFiles().map(file => file.name)'), ['brief.pdf', 'brief.docx']);
  assert.equal(await window.webContents.executeJavaScript('(() => { try { HarnessDocuments.wordText([{ xml: "<invalid>" }]); return false; } catch { return true; } })()'), true);
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    try { HarnessDocuments.wordText([{ xml: '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' + '<w:p/>'.repeat(20001) + '</w:document>' }]); return false; }
    catch (error) { return /too much formatting/.test(error.message); }
  })()`), true);
  before = sent.length;
  await submit('Read these documents.');
  await until(() => sent.length === before + 1, 'extracted document text reaches the selected provider input');
  assert.deepEqual(sent.at(-1).files, documentResults);
  assert.equal(documents.busy, false);
  console.log('Real local PDF and DOCX extraction, Unicode, text-only labeling, hostile XML rejection and document Send passed');
  await window.webContents.executeJavaScript(`renderMessages({ items: [
    { id: 'visible', type: 'agentMessage', text: 'Visible result' },
    { id: 'maintenance', type: 'userMessage', content: [{ type: 'text', text: 'Hidden maintenance' }] },
    { id: 'maintenance-answer', turnId: 'wiki-turn', type: 'agentMessage', text: 'Hidden wiki assessment' }
  ], routes: [{ messageId: 'maintenance', turnId: 'wiki-turn', wikiMaintenanceTaskId: 'task' }] });`);
  const chat = await window.webContents.executeJavaScript("document.querySelector('#messages').textContent");
  assert.match(chat, /Visible result/);
  assert.doesNotMatch(chat, /Hidden/);
  // The worker's task status line is shown as a small tag, never as reply text (also while it streams in).
  await window.webContents.executeJavaScript(`renderMessages({ items: [
    { id: 'asked', type: 'agentMessage', phase: 'final_answer', text: 'Which cascade flickers?\\n\\n[task: needs-input]' },
    { id: 'streaming', type: 'agentMessage', phase: 'final_answer', text: 'Fixed the bias.\\n[task: do' }
  ], routes: [] });`);
  const tagged = await window.webContents.executeJavaScript("[document.querySelector('#messages').textContent, [...document.querySelectorAll('.task-status')].map(e => e.textContent)]");
  assert.doesNotMatch(tagged[0], /\[task/);
  assert.match(tagged[0], /Which cascade flickers\?/);
  assert.deepEqual(tagged[1], ['Needs your input']);
  console.log('Task status line shown as a tag passed');
  // Each reply is labelled with the provider that wrote it, not always "Codex".
  await window.webContents.executeJavaScript(`renderMessages({ items: [
    { id: 'by-codex', turnId: 't-codex', type: 'agentMessage', phase: 'final_answer', text: 'one', routeLabel: 'gpt-6-astra · high' },
    { id: 'by-claude', turnId: 't-claude', type: 'agentMessage', phase: 'final_answer', text: 'two', routeLabel: 'claude-sonnet-5 · high' },
    { id: 'by-cursor', turnId: 't-cursor', type: 'agentMessage', phase: 'final_answer', text: 'three', routeLabel: 'Grok 4.7' },
    { id: 'by-jev', type: 'agentMessage', phase: 'final_answer', text: 'four', routeLabel: 'Jev · quick answer' },
    { id: 'old', type: 'agentMessage', phase: 'final_answer', text: 'five' }
  ], routes: [{ turnId: 't-codex', provider: 'codex' }, { turnId: 't-claude', provider: 'claude-cli' }, { turnId: 't-cursor', provider: 'cursor-cli' }] });`);
  const writers = await window.webContents.executeJavaScript("[...document.querySelectorAll('.message-label')].map(e => e.firstChild.textContent)");
  assert.deepEqual(writers, ['Codex CLI', 'Claude CLI', 'Cursor CLI', 'Jev', 'Codex CLI']);
  console.log('Reply labels name their provider passed');
  await window.webContents.executeJavaScript(`renderMessages({ items: [
    { id: 'hub-auto', type: 'userMessage', content: [{ type: 'text', text: 'Hello' }] },
    { id: 'hub-manual', type: 'userMessage', content: [{ type: 'text', text: 'Hello again' }] }
  ], routes: [
    { messageId: 'hub-auto', source: 'hub-auto', label: 'Balanced model · low' },
    { messageId: 'hub-manual', source: 'manual', label: 'Chosen model · medium' }
  ] });`);
  assert.deepEqual(await window.webContents.executeJavaScript("[...document.querySelectorAll('.routing-row')].map(e => e.textContent)"), [
    'Model: Balanced model · low · Auto-selected for Hub', 'Model: Chosen model · medium · manual selection',
  ]);
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('#messages details.activity').length"), 0, 'pinned Hub routes do not claim another routing call');
  console.log('Hub Auto and manual selection labels passed');
  await window.webContents.executeJavaScript(`window.fetchTest = Promise.all([loadDiscoveredModels('cursor-cli'), loadDiscoveredModels('cursor-cli')]).catch(() => null); true;`);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#models-loading').hidden"), false);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#provider-connection').hidden"), false);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('[data-connection-provider=cursor-cli]').getAttribute('aria-busy')"), 'true');
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
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#provider-connection').hidden"), true, 'failed provider request clears progress');
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
  assert.deepEqual(sections.map(([label]) => label), ['Codex CLI / ChatGPT', 'Claude CLI'], 'models are listed under their provider, Codex first');
  assert.deepEqual(sections[0][1], ['gpt-6-sol']);
  assert.deepEqual(sections[1][1], ['claude-opus-5-5']);
  assert.equal(picker.autoHidden, true);
  assert.equal(picker.autoMode, 'auto');
  assert.equal(await window.webContents.executeJavaScript("providerCaps('cursor-cli').usage"), false);
  assert.equal(await window.webContents.executeJavaScript("providerCaps('claude-cli').steer"), false);
  assert.equal(await window.webContents.executeJavaScript("providerCaps(undefined).steer"), true);
  console.log('Claude per-effort model rows and provider capabilities passed');
  // The Hub's model menu leaves out worker-only models (Muse, Antigravity); a worker's menu keeps them.
  assert.deepEqual(await window.webContents.executeJavaScript(`(() => {
    const saved = [state.coordinator, state.presets];
    state.presets = [...state.presets, { id: 'native:muse:m', provider: 'native:muse', model: 'm', label: 'm', available: true, router: false }];
    const offered = coordinator => {
      state.coordinator = coordinator;
      return presetGroups().some(group => group.provider === 'native:muse');
    };
    const result = [offered(true), offered(false)];
    [state.coordinator, state.presets] = saved;
    return result;
  })()`), [false, true]);
  console.log('Hub model menu excludes worker-only models passed');
  // Disconnected in the Harness while the CLIs stay signed in: no models listed, detail says the CLI is still signed in.
  controller.account = null; controller.models = [];
  controller.codex = { installed: true, connected: true, signedIn: true };
  controller.data.settings.claudeEnabled = false;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderProviders(); true');
  const providers = await window.webContents.executeJavaScript("document.querySelector('#panel-providers').textContent");
  assert.match(providers, /Codex CLI · disconnected/);
  assert.match(providers, /Claude CLI · disconnected/);
  assert.doesNotMatch(await window.webContents.executeJavaScript("document.querySelector('#provider-model-list').textContent"), /claude-opus-5-5/, 'Claude models are hidden');
  assert.doesNotMatch(await window.webContents.executeJavaScript("document.querySelector('#provider-model-list').textContent"), /gpt-6-sol/);
  console.log('Disconnected providers hide models and keep CLI logins passed');
  // Usage and limits per provider.
  controller.account = { type: 'chatgpt', plan: 'pro' }; controller.data.settings.claudeEnabled = true;
  controller.limits.setUsage('codex', { primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
  controller.limits.mark('claude-cli', { until: Date.now() + 3600 * 1000, reason: 'limit' });
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderProviders(); true');
  const usageText = await window.webContents.executeJavaScript("[...document.querySelectorAll('.provider-usage')].map(e => e.textContent + '|' + e.className)");
  assert.ok(!usageText.some(t => /Used:|42%/.test(t)), 'no plan usage percentages, for any provider: ' + JSON.stringify(usageText));
  assert.equal(JSON.stringify(controller.snapshot()).includes('providerUsage'), false, 'and none are sent to the window');
  assert.ok(usageText.some(t => /^Usage limit reached · resets .*\|provider-usage limited$/.test(t)), JSON.stringify(usageText));
  // A model-family limit alone names its family.
  controller.limits.clear('claude-cli');
  controller.limits.mark('claude-cli', { until: Date.now() + 3600 * 1000, reason: 'limit', family: 'opus' });
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderProviders(); true');
  const familyText = await window.webContents.executeJavaScript("[...document.querySelectorAll('.provider-usage')].map(e => e.textContent)");
  assert.ok(familyText.some(t => /^Opus usage limit reached · resets /.test(t)), JSON.stringify(familyText));
  controller.limits.clear('claude-cli', 'opus'); controller.account = null; controller.data.settings.claudeEnabled = false;
  console.log('Provider usage and limits are shown passed');
  // Adding an API provider from Settings.
  controller.providers = { configured: id => providerKeys.has(id), key: id => ({ remove() { providerKeys.delete(id); } }) };
  controller.codex = { installed: true, connected: true };
  holdApiModels = true; failModels = false; finishFetch = null;
  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#api-name').value = 'LM Studio';
    document.querySelector('#api-url').value = 'http://localhost:1234/v1';
    document.querySelector('#api-add').click();
    await new Promise(r => setTimeout(r, 300));
  })()`);
  assert.deepEqual(controller.data.settings.providers.map(p => [p.id, p.name, p.baseUrl]), [['lm-studio', 'LM Studio', 'http://localhost:1234/v1']]);
  assert.deepEqual(await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-connection-provider="lm-studio"]');
    return [row.querySelector('.provider-detail').hidden, row.querySelector('.provider-connecting').textContent, row.querySelector('button').disabled];
  })()`), [true, 'Connecting…', true]);
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').showModal(); document.querySelector('#tab-providers').click(); new Promise(r => setTimeout(r, 100))");
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/providers-connecting.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("document.querySelector('#tab-general').click(); document.querySelector('#settings-dialog').close(); new Promise(r => setTimeout(r, 100))");
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/connection-indicator.png'), (await window.webContents.capturePage()).toPNG());
  holdApiModels = false;
  while (!finishFetch) await new Promise(setImmediate);
  finishFetch();
  await window.webContents.executeJavaScript("loadDiscoveredModels('lm-studio')");
  const apiRow = await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('.api-provider-row');
    return { text: row.querySelector('.provider-account-text').textContent, endpoint: row.querySelector('.provider-endpoint').textContent,
      grouped: !!row.closest('.provider-accounts'), outsideAdd: !row.closest('#api-providers'), collapsed: !row.open };
  })()`);
  assert.deepEqual(apiRow, { text: 'LM Studio · Enabled', endpoint: 'http://localhost:1234/v1', grouped: true, outsideAdd: true, collapsed: true });
  const groups = await window.webContents.executeJavaScript("[...document.querySelectorAll('#provider-model-list .provider-model-group')].map(e => e.textContent)");
  assert.ok(groups.includes('LM Studio'), JSON.stringify(groups));
  const providerAction = code => window.webContents.executeJavaScript(`(async () => { ${code}; await new Promise(r => setTimeout(r, 50)); })()`);
  controller.providerSettings({ action: 'enableDiscovered', provider: 'lm-studio', model: 'gemma' });
  const previousMode = controller.data.settings.mode;
  controller.data.settings.mode = 'lm-studio:gemma:default';
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); true');
  await providerAction('await refreshLocalModel(true)');
  assert.deepEqual(await window.webContents.executeJavaScript("[document.querySelector('#local-model-controls').hidden, document.querySelector('#local-model-toggle').textContent, document.querySelector('#local-model-unload').hidden]"), [false, '○ Load', true]);
  await providerAction("document.querySelector('#local-model-toggle').click()");
  assert.equal(localModelLoaded, true);
  assert.equal(localModelActions.find(a => a.action === 'load').choice.model, 'gemma');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#local-model-toggle').classList.contains('loaded')"), true);
  assert.match(await window.webContents.executeJavaScript("document.querySelector('#local-model-toggle').title"), /32,768/);
  await providerAction('state.anyAgentBusy = true; renderLocalModel()');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#local-model-unload').disabled"), true);
  await providerAction("state.anyAgentBusy = false; renderLocalModel(); document.querySelector('#local-model-unload').click()");
  assert.equal(localModelLoaded, false);
  localModelError = true;
  await providerAction('await refreshLocalModel(true)');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#local-model-toggle').textContent"), 'Retry status');
  localModelError = false;
  await providerAction("document.querySelector('#local-model-toggle').click()");
  assert.equal(localModelLoaded, false, 'retry only checks status');
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').close(); true");
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/local-model-controls.png'), (await window.webContents.capturePage()).toPNG());
  controller.data.settings.mode = previousMode;
  controller.data.settings.providerModels = controller.data.settings.providerModels.filter(p => p.model !== 'gemma');
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); true');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#local-model-controls').hidden"), true);
  console.log('Local model status, load, unload, busy protection and retry passed');
  controller.providerSettings({ action: 'provider', provider: { id: 'other', name: 'Other', baseUrl: 'https://example.com/v1', enabled: false } });
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderProviders(); true');
  await providerAction("document.querySelector('.api-provider-row summary').click(); document.querySelector('.api-provider-row input[type=password]').value = 'test-provider-key'; renderProviders()");
  assert.deepEqual(await window.webContents.executeJavaScript("[document.querySelector('.api-provider-row').open, document.querySelector('.api-provider-row input[type=password]').value]"), [true, 'test-provider-key'], 'expanded provider and key draft survive model refresh');
  await providerAction("document.querySelector('.api-provider-row').open = false; document.querySelector('.api-provider-row .provider-plug').click()");
  assert.equal(controller.data.settings.providers[0].enabled, false);
  assert.deepEqual(controller.data.settings.providers.map(p => p.id), ['lm-studio', 'other'], 'toggling does not move another provider under the pointer');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('.api-provider-row .provider-account-text').textContent"), 'LM Studio · Disabled');
  assert.deepEqual(await window.webContents.executeJavaScript("[document.querySelector('.api-provider-row').open, document.querySelector('.api-provider-row .provider-plug').getAttribute('aria-pressed')]"), [false, 'false'], 'plug toggles without expanding settings');
  await providerAction("document.querySelector('.api-provider-row .provider-plug').click()");
  assert.equal(controller.data.settings.providers[0].enabled, true);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('.api-provider-row').open"), false);
  await providerAction("document.querySelector('.api-provider-row summary').click()");
  await providerAction("document.querySelector('.api-provider-row .jev-actions button').click()");
  assert.equal(providerKeys.get('lm-studio'), 'test-provider-key');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('.api-provider-row input[type=password]').hidden"), true);
  await providerAction("document.querySelector('.api-provider-row .jev-actions button').click()");
  assert.equal(providerKeys.has('lm-studio'), false);
  await providerAction("document.querySelector('.api-provider-row .provider-remove').click()");
  await providerAction("document.querySelector('.confirmation-cancel').click()");
  assert.equal(controller.data.settings.providers.length, 2, 'cancel keeps the provider');
  await providerAction("document.querySelector('.api-provider-row .provider-remove').click()");
  await providerAction("document.querySelector('.confirmation-accept').click()");
  assert.deepEqual(controller.data.settings.providers.map(p => p.id), ['other']);
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.api-provider-row').length"), 1);
  controller.data.settings.providers = [];
  console.log('API provider rows, expansion, key actions and confirmed removal passed');
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
  const cursorRows = await window.webContents.executeJavaScript(`[...document.querySelectorAll('#provider-model-list .provider-model-row')].map(r => r.textContent).filter(t => t.endsWith('· Cursor CLI'))`);
  assert.deepEqual(cursorRows, ['GPT-5.5 · Cursor CLI', 'Grok 4.7 · Cursor CLI', 'Kimi K3 · Cursor CLI']);
  console.log('Cursor settings list the full model list, one row per model, no efforts passed');
  // A provider's model group collapses under its title and stays collapsed when the list re-renders.
  const cursorGroup = `[...document.querySelectorAll('#provider-model-list .provider-model-section')].find(section => section.querySelector('summary').textContent === 'Cursor CLI')`;
  assert.equal(await window.webContents.executeJavaScript(`${cursorGroup}.open`), true, 'groups start expanded');
  await window.webContents.executeJavaScript(`${cursorGroup}.querySelector('summary').click(); new Promise(r => setTimeout(r, 50))`);
  await window.webContents.executeJavaScript('renderProviders(); true');
  assert.equal(await window.webContents.executeJavaScript(`${cursorGroup}.open`), false, 'collapsed group stays collapsed after re-render');
  await window.webContents.executeJavaScript(`${cursorGroup}.querySelector('summary').click(); new Promise(r => setTimeout(r, 50))`);
  console.log('Collapsible provider model groups passed');
  deadline.refresh(); phase = 'provider settings';
  // A failed model fetch shows its error in the group once, without "Fetching…" or a retry on every redraw.
  failModels = true; finishFetch = null; cursorModelRequests = 0;
  await window.webContents.executeJavaScript('discoveredModels.clear(); renderProviders(); true');
  while (!finishFetch) await new Promise(setImmediate);
  assert.match(await window.webContents.executeJavaScript(`[...document.querySelectorAll('#provider-model-list .provider-loading')]
    .filter(line => line.querySelector('.models-spinner')).map(line => line.textContent).join('|')`), /Fetching Cursor CLI models…/, 'a model fetch in progress shows the spinner');
  finishFetch();
  await new Promise(resolve => setTimeout(resolve, 200));
  await window.webContents.executeJavaScript('renderProviders(); renderProviders(); true');
  const failedGroup = await window.webContents.executeJavaScript("document.querySelector('#provider-model-list').textContent");
  assert.match(failedGroup, /Test model fetch failed/);
  assert.doesNotMatch(failedGroup, /Fetching Cursor CLI models|Error invoking remote method/);
  assert.equal(cursorModelRequests, 1, 'a failed fetch is not retried on redraw');
  await window.webContents.executeJavaScript("discoveredModels.set('cursor-cli', []); modelFetchErrors.clear(); true");
  failModels = false;
  console.log('Failed model fetch shows its error once and waits for Renew passed');
  // An installed CLI with a newer release shows Update with both versions; current CLIs show no button.
  controller.cliUpdates = { 'cursor-cli': { installed: '2026.10.01-e373342', latest: '2026.10.16-e3cb207' } };
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderProviders(); true');
  const installButtons = await window.webContents.executeJavaScript(`[...document.querySelectorAll('.provider-install')]
    .map(button => [button.closest('[data-connection-provider]').dataset.connectionProvider, button.textContent, button.title])`);
  assert.deepEqual(installButtons.filter(([, text]) => text === 'Update'), [['cursor-cli', 'Update', '2026.10.01-e373342 → 2026.10.16-e3cb207']]);
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').showModal(); document.querySelector('#tab-providers').click(); new Promise(r => setTimeout(r, 100))");
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/provider-update.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('#provider-model-list').scrollIntoView({ block: 'start' }); new Promise(r => setTimeout(r, 100))`);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/model-groups.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("document.querySelector('#tab-general').click(); document.querySelector('#settings-dialog').close(); true");
  controller.cliUpdates = {};
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderProviders(); true');
  console.log('Update button for a newer CLI release passed');
  // Install stays hidden while a provider's check runs; it shows once the check reports the CLI missing.
  const deepseekInstall = () => window.webContents.executeJavaScript(`document.querySelector('[data-connection-provider="native:deepseek"] .provider-install')?.hidden`);
  assert.equal(await deepseekInstall(), false, 'DeepSeek is not installed in this fixture');
  controller.connectingProviders.set('native:deepseek', 1);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderProviders(); true');
  assert.equal(await deepseekInstall(), true, 'no Install while the check is still running');
  controller.connectingProviders.delete('native:deepseek');
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderProviders(); true');
  assert.equal(await deepseekInstall(), false, 'Install once the check reports it missing');
  console.log('Install hidden while a provider connects passed');
  // Clicking Install shows the spinner and "Installing…" on that row until the action ends.
  let releaseInstall = null;
  ipcMain.handle('installProvider', () => new Promise(resolve => { releaseInstall = () => resolve(controller.snapshot()); }));
  await window.webContents.executeJavaScript(`document.querySelector('[data-connection-provider="native:deepseek"] .provider-install').click(); true`);
  while (!releaseInstall) await new Promise(setImmediate);
  const installing = await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('[data-connection-provider="native:deepseek"]');
    const status = row.querySelector('.provider-connecting');
    return [row.classList.contains('connecting'), !status.hidden, status.textContent.trim(), !!status.querySelector('.models-spinner')];
  })()`);
  assert.deepEqual(installing, [true, true, 'Installing…', true]);
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').showModal(); document.querySelector('#tab-providers').click(); new Promise(r => setTimeout(r, 150))");
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/provider-installing.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("document.querySelector('#tab-general').click(); document.querySelector('#settings-dialog').close(); true");
  releaseInstall();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('[data-connection-provider="native:deepseek"]').classList.contains('connecting')`), false);
  ipcMain.removeHandler('installProvider');
  console.log('Provider action spinner passed');
  // Check removal saves immediately without closing Settings.
  controller.data.settings.checks[controller.data.settings.workspace] = [{ id: 'c1', name: 'Syntax', argv: ['node', '--check', 'demo.js'], cwd: controller.data.settings.workspace, timeoutMs: 120000, readOnlySafe: false }];
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderChecks(); true');
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('#checks-list .check-row').length"), 1);
  await window.webContents.executeJavaScript(`document.querySelector('#checks-list .check-kind').value = 'build';
    document.querySelector('#checks-list .check-kind').dispatchEvent(new Event('change', { bubbles: true })); true`);
  await until(() => savedChecks.at(-1)?.[0]?.kind === 'build', 'check purpose saves through the normal settings path');
  await window.webContents.executeJavaScript(`(async () => {
    [...document.querySelectorAll('#checks-list .check-row button')].find(b => b.textContent === 'Remove').click();
    await new Promise(r => setTimeout(r, 300));
  })()`);
  assert.deepEqual(savedChecks.at(-1), [], 'the removal was saved');
  assert.deepEqual(controller.data.settings.checks[controller.data.settings.workspace], []);
  console.log('Removed checks save immediately passed');
  await window.webContents.executeJavaScript("document.querySelector('#settings').click(); new Promise(r => setTimeout(r, 100))");
  const dialogSize = () => window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('#settings-dialog'), box = dialog.getBoundingClientRect();
    return { width: box.width, height: box.height, right: box.right, bottom: box.bottom, resize: getComputedStyle(dialog).resize,
      fits: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
      footerFits: document.querySelector('#settings-close').getBoundingClientRect().bottom <= box.bottom };
  })()`);
  const originalDialog = await dialogSize();
  assert.equal(originalDialog.resize, 'both');
  const corner = { x: Math.floor(originalDialog.right - 4), y: Math.floor(originalDialog.bottom - 4) };
  window.webContents.sendInputEvent({ type: 'mouseMove', ...corner });
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...corner });
  window.webContents.sendInputEvent({ type: 'mouseMove', x: corner.x + 70, y: corner.y - 60 });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: corner.x + 70, y: corner.y - 60 });
  await new Promise(r => setTimeout(r, 50));
  const resizedDialog = await dialogSize();
  assert.ok(resizedDialog.width > originalDialog.width, 'the Settings corner resizes horizontally');
  assert.ok(resizedDialog.height < originalDialog.height, 'the Settings corner resizes vertically');
  assert.ok(resizedDialog.fits && resizedDialog.footerFits);
  await window.webContents.executeJavaScript("document.querySelector('#settings-close').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true })); true");
  assert.equal((await dialogSize()).width, resizedDialog.width - 20, 'Alt and arrow keys resize the focused dialog');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/resized-settings.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').style.removeProperty('width'); document.querySelector('#settings-dialog').style.removeProperty('height'); true");
  console.log('Dialog corner and keyboard resizing with visible footer passed');
  const changeSetting = (id, value) => window.webContents.executeJavaScript(`(async () => {
    const control = document.getElementById(${JSON.stringify(id)}); control.value = ${JSON.stringify(value)};
    control.dispatchEvent(new Event('change', { bubbles: true }));
    await settingsWrites.catch(() => {}); await new Promise(r => setTimeout(r, 10));
  })()`);


  await changeSetting('settings-background-usage', '95');
  assert.equal(controller.data.settings.backgroundUsageLimit, 95);
  await changeSetting('settings-background-usage', '0');
  assert.equal(controller.data.settings.backgroundUsageLimit, 95, 'an invalid threshold leaves the saved reserve intact');
  await changeSetting('settings-background-usage', '90');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#background-usage-detail')"), null);
  const originalWorkspace = controller.data.settings.workspace;
  await window.webContents.executeJavaScript("document.querySelector('#settings-browse').onclick()");
  assert.equal(controller.data.settings.workspace, fs.realpathSync(root), 'choosing a workspace saves immediately');
  chosenWorkspace = originalWorkspace;
  await window.webContents.executeJavaScript("document.querySelector('#settings-browse').onclick()");
  assert.equal(controller.data.settings.workspace, originalWorkspace);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').open"), true);
  await changeSetting('settings-context', 'jev');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#settings-context').value"), 'local', 'a rejected option returns to the saved value');

  await changeSetting('settings-quick', 'off');
  assert.equal(controller.data.settings.jevQuickAnswers, false, 'the write queue recovers after rejection');

  await changeSetting('settings-quick', 'on');
  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#settings-close').click(); await new Promise(r => setTimeout(r, 20));
    document.querySelector('#settings').click(); await new Promise(r => setTimeout(r, 100));
  })()`);

  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#settings-close').textContent"), 'Close');
  const settingsLayout = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#tab-benchmarks').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    const panel = document.querySelector('#panel-benchmarks');
    const result = { visible: !panel.hidden, loaded: document.querySelector('#benchmark-status').textContent.includes('fixture'),
      fits: panel.scrollWidth <= panel.clientWidth };
    document.querySelector('#tab-general').click();
    const input = document.querySelector('#settings-background-usage');
    const compact = input.getBoundingClientRect().height;
    input.style.paddingBlock = '10px';
    result.ratio = compact / input.getBoundingClientRect().height;
    input.style.removeProperty('padding-block');
    return result;
  })()`);
  assert.ok(settingsLayout.visible && settingsLayout.loaded && settingsLayout.fits, 'benchmark tab loads inside settings');
  assert.ok(Math.abs(settingsLayout.ratio - .75) < .02, 'number field is one-quarter shorter');
  const compactGear = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#settings');
    return button.getBoundingClientRect().width < 50;
  })()`);
  assert.ok(compactGear, 'sidebar gear hit area fits the icon');
  for (const choice of ['close', 'tray']) {
    await window.webContents.executeJavaScript(`(async () => {
      const select = document.querySelector('#settings-runner-exit');
      select.value = '${choice}';
      await select.onchange({ target: select });
    })()`);
    assert.equal(runnerExit, choice);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('#settings-runner-exit').value"), choice);
  }
  // Incomplete checks survive tab changes and block Close, the X and Escape until fixed or removed.
  await window.webContents.executeJavaScript(`document.querySelector('#tab-checks').click(); document.querySelector('#checks-add').click();
    document.querySelector('#checks-list .check-name').value = 'Auto saved check';
    document.querySelector('#checks-list .check-name').dispatchEvent(new Event('change', { bubbles: true })); true`);
  await window.webContents.executeJavaScript('settingsWrites.catch(() => {})');
  for (const action of ["document.querySelector('#settings-close').click()", "document.querySelector('#settings-dialog .close-dialog').click()", "document.querySelector('#settings-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))"]) {
    await window.webContents.executeJavaScript(action + '; new Promise(r => setTimeout(r, 20))');
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').open"), true);
  }
  await window.webContents.executeJavaScript("document.querySelector('#tab-general').click(); document.querySelector('#tab-checks').click(); true");
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#checks-list .check-name').value"), 'Auto saved check');
  await window.webContents.executeJavaScript(`(async () => {
    const command = document.querySelector('#checks-list .check-command'); command.value = 'node --check demo.js';
    command.dispatchEvent(new Event('change', { bubbles: true })); await settingsWrites;
  })()`);
  assert.equal(controller.data.settings.checks[controller.data.settings.workspace][0].name, 'Auto saved check');
  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#checks-list button').click(); await settingsWrites;
    document.querySelector('#settings-close').click(); await new Promise(r => setTimeout(r, 20));
  })()`);
  assert.deepEqual(controller.data.settings.checks[controller.data.settings.workspace], []);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').open"), false);
  console.log('Settings autosave, rejection recovery and check draft protection passed');
  // Settings shows the app version; the manual update check reports and links, and never downloads.
  await window.webContents.executeJavaScript("document.querySelector('#settings').click(); new Promise(r => setTimeout(r, 200))");
  await window.webContents.executeJavaScript("document.querySelector('#tab-about').click(); true");
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    selected: document.querySelector('#tab-about').getAttribute('aria-selected'),
    visiblePanels: [...document.querySelectorAll('.settings-panel')].filter(panel => !panel.hidden).map(panel => panel.id),
    controlsMoved: ['app-version', 'copy-diagnostics', 'open-logs', 'check-updates', 'install-update', 'open-release', 'diagnostics-status', 'update-status'].every(id => document.querySelector('#' + id).closest('#panel-about'))
  })`), { selected: 'true', visiblePanels: ['panel-about'], controlsMoved: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/settings-about.png'), (await window.webContents.capturePage()).toPNG());
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#app-version').textContent"), 'Version 0.1.0');
  const checkUpdates = () => window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#check-updates').click();
    await new Promise(r => setTimeout(r, 200));
    return [document.querySelector('#update-status').textContent, document.querySelector('#open-release').hidden];
  })()`);
  const [newer, newerHidden] = await checkUpdates();
  assert.match(newer, /Version 0\.2\.0 is available \(Phasma-Harness-Setup-0\.2\.0\.exe\)/);
  assert.equal(newerHidden, false);
  updateResult = { current: '0.2.0', latest: '0.2.0', newer: false, url: 'https://github.com/x/y/releases' };
  assert.deepEqual(await checkUpdates(), ['Up to date: 0.2.0 is the latest release.', true]);
  updateResult = new Error('Could not reach GitHub to check for updates (timed out).');
  const [failed] = await checkUpdates();
  assert.match(failed, /Could not reach GitHub/);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#check-updates').disabled"), false);
  updateResult = { current: '0.1.0', latest: '0.2.0', newer: true, installable: true, url: 'https://github.com/x/y/releases/tag/v0.2.0', installer: 'Phasma-Harness-Setup-0.2.0.exe' };
  const [installable] = await checkUpdates();
  assert.match(installable, /Version 0\.2\.0 is available\. Update and restart downloads and installs it/);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#install-update').hidden"), false);
  await window.webContents.executeJavaScript("document.querySelector('#tab-general').click(); true");
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#panel-about').hidden"), true);
  console.log('About and manual update check passed');
  // The automatic update banner: offered when the installed app finds a release, disabled while a turn runs.
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').close(); true");
  const banner = () => window.webContents.executeJavaScript("[document.querySelector('#update-banner').hidden, document.querySelector('#update-text').textContent, document.querySelector('#update-install').hidden, document.querySelector('#update-install').disabled]");
  const push = async state => { window.webContents.send('update', state); await new Promise(r => setTimeout(r, 100)); };
  await push({ status: 'available', latest: '0.2.0', installable: false, url: 'https://github.com/x/y/releases/tag/v0.2.0' });
  assert.equal((await banner())[0], true, 'a source folder gets no banner');
  await push({ status: 'available', latest: '0.2.0', installable: true, url: 'https://github.com/x/y/releases/tag/v0.2.0' });
  assert.deepEqual(await banner(), [false, 'Phasma Harness 0.2.0 is available.', false, false]);
  await window.webContents.executeJavaScript("document.querySelector('#update-install').click(); new Promise(r => setTimeout(r, 100))");
  assert.equal(installs, 1);
  await push({ status: 'downloading', latest: '0.2.0', installable: true, progress: 42 });
  assert.deepEqual(await banner(), [false, 'Downloading Phasma Harness 0.2.0… 42%', true, true]);
  await push({ status: 'error', latest: '0.2.0', installable: true, error: 'The downloaded installer does not match the release checksum, so it was deleted.' });
  assert.match((await banner())[1], /^Update failed: The downloaded installer does not match/);
  await push({ status: 'available', latest: '0.2.0', installable: true });
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify({ ...controller.snapshot(), busy: 'someone' }) + '); true');
  assert.equal((await banner())[3], true, 'disabled while a turn runs');
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + "); document.querySelector('#update-dismiss').click(); true");
  assert.equal((await banner())[0], true, 'hidden after dismissing');
  console.log('Update banner passed');
  // Effort cap next to Auto: saved as a setting, max marked with a warning, hidden for a manual model, mirrored in Settings.
  const cap = () => window.webContents.executeJavaScript("[document.querySelector('#effort-cap').hidden, document.querySelector('#effort-cap').value, document.querySelector('#effort-cap').selectedOptions[0].textContent, document.querySelector('#effort-cap').classList.contains('max-cap')]");
  assert.ok(await window.webContents.executeJavaScript("!!(document.querySelector('#permissions').compareDocumentPosition(document.querySelector('#effort-cap')) & Node.DOCUMENT_POSITION_FOLLOWING)"), 'the cap comes after the access control');
  await window.webContents.executeJavaScript("document.querySelector('#preset').value = 'auto'; document.querySelector('#preset').onchange(); new Promise(r => setTimeout(r, 200))");
  assert.deepEqual(await cap(), [false, 'high', 'Up to high effort', false]);
  await window.webContents.executeJavaScript("document.querySelector('#effort-cap').value = 'max'; document.querySelector('#effort-cap').onchange(); new Promise(r => setTimeout(r, 200))");
  assert.equal(controller.data.settings.effortCap, 'max');
  assert.deepEqual(await cap(), [false, 'max', '⚠ Up to max effort', true]);
  assert.equal(await window.webContents.executeJavaScript("getComputedStyle(document.querySelector('#effort-cap option[value=high]')).color"),
    await window.webContents.executeJavaScript('getComputedStyle(document.body).color'), 'non-warning options retain the theme text color');
  await window.webContents.executeJavaScript("document.querySelector('#settings').click(); new Promise(r => setTimeout(r, 200))");
  const settingsCap = await window.webContents.executeJavaScript("[document.querySelector('#settings-effort-cap').value, document.querySelector('#effort-cap-detail').textContent]");
  assert.equal(settingsCap[0], 'max');
  assert.match(settingsCap[1], /^⚠ No cap: Auto may pick max effort.*Your manual picks are not capped\.$/);
  await window.webContents.executeJavaScript("document.querySelector('#settings-effort-cap').value = 'high'; document.querySelector('#settings-effort-cap').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#settings-close').click(); new Promise(r => setTimeout(r, 300))");
  assert.equal(controller.data.settings.effortCap, 'high');
  assert.deepEqual((await cap()).filter((_, i) => i === 1 || i === 3), ['high', false]);
  const manual = controller.catalog().find(p => p.worker && controller.available(p));
  if (manual) {
    await window.webContents.executeJavaScript('applyState(' + JSON.stringify({ ...controller.snapshot(), settings: { ...controller.snapshot().settings, mode: manual.id } }) + '); true');
    assert.equal((await cap())[0], true, 'hidden for a manual model');
    await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); true');
  }
  // Advanced model controls stay reachable inside the compact disclosure.
  const layout = await window.webContents.executeJavaScript(`(() => {
    const options = document.querySelector('#chat-options');
    options.open = true;
    const box = id => document.querySelector(id).getBoundingClientRect();
    const preset = document.querySelector('#preset');
    const panel = box('.chat-options-panel');
    const fits = id => box(id).width > 0 && box(id).left >= panel.left && box(id).right <= panel.right;
    return { inModel: !!preset.closest('.composer-model'), inOptions: !!preset.closest('#chat-options'),
      routingFits: fits('#quick-routing'), modelFits: fits('#preset'), capFits: fits('#effort-cap') };
  })()`);
  assert.deepEqual(layout, { inModel: true, inOptions: true, routingFits: true, modelFits: true, capFits: true });
  await window.webContents.executeJavaScript('document.querySelector("#chat-options").open = true; new Promise(r => setTimeout(r, 200))');
  // With real usage text the panel must not scroll sideways (seen 2026-10-19 with "322.4K input · 3% cached · 1.8K output").
  for (const scale of ['1', '1.15', '1.3', '1.5']) {
    const sideways = await window.webContents.executeJavaScript(`(async () => {
      const root = document.documentElement, savedScale = root.style.getPropertyValue('--font-scale');
      const usage = document.querySelector('#usage'), saved = [usage.hidden, usage.textContent];
      root.style.setProperty('--font-scale', '${scale}');
      usage.hidden = false; usage.textContent = '322.4K input · 3% cached · 1.8K output';
      await new Promise(r => setTimeout(r, 50));
      const panel = document.querySelector('.chat-options-panel'), edge = panel.getBoundingClientRect().right;
      const result = { scrolls: panel.scrollWidth > panel.clientWidth,
        usageVisible: usage.scrollWidth <= usage.clientWidth + 1 && usage.scrollHeight <= usage.clientHeight + 1 && getComputedStyle(usage).whiteSpace === 'normal',
        wider: [...panel.querySelectorAll('*')].filter(node => node.getBoundingClientRect().right > edge + 1).map(node => node.id || node.className || node.tagName).slice(0, 6) };
      [usage.hidden, usage.textContent] = saved;
      if (savedScale) root.style.setProperty('--font-scale', savedScale); else root.style.removeProperty('--font-scale');
      return result;
    })()`);
    assert.deepEqual(sideways, { scrolls: false, usageVisible: true, wider: [] }, `Options panel scrolls sideways at font scale ${scale}: ` + JSON.stringify(sideways));
  }
  await window.webContents.executeJavaScript(`(async () => {
    document.documentElement.style.setProperty('--font-scale', '1.3');
    const usage = document.querySelector('#usage');
    usage.dataset.saved = JSON.stringify([usage.hidden, usage.textContent]);
    usage.hidden = false; usage.textContent = '322.4K input · 3% cached · 1.8K output';
    await new Promise(r => setTimeout(r, 100));
  })()`);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/options-panel-130.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`(() => {
    const usage = document.querySelector('#usage'), [hidden, text] = JSON.parse(usage.dataset.saved);
    usage.hidden = hidden; usage.textContent = text; delete usage.dataset.saved;
    document.documentElement.style.setProperty('--font-scale', (state.settings.fontScale || 100) / 100);
    return true;
  })()`);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/options-panel.png'), (await window.webContents.capturePage()).toPNG());
  // The context ring's tooltip opens inside the Options panel instead of being clipped by it.
  const tip = await window.webContents.executeJavaScript(`(async () => {
    // The ring is disabled without usage here, so show its tooltip the way hover would.
    document.querySelector('#context-meter-tip').style.display = 'block';
    await new Promise(r => setTimeout(r, 100));
    const panel = document.querySelector('.chat-options-panel').getBoundingClientRect();
    const box = document.querySelector('#context-meter-tip').getBoundingClientRect();
    return { shown: box.width > 0, inside: box.left >= panel.left && box.right <= panel.right && box.top >= panel.top };
  })()`);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/options-tooltip.png'), (await window.webContents.capturePage()).toPNG());
  assert.deepEqual(tip, { shown: true, inside: true }, 'context tooltip stays inside the Options panel');
  await window.webContents.executeJavaScript("document.querySelector('#context-meter-tip').style.display = ''; true");
  await window.webContents.executeJavaScript('document.querySelector("#chat-options").open = false; true');
  console.log('Effort cap passed');
  // Compare with Jev: shown only with a Jev key while Smart routes, with the agreement so far.
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').close(); true");
  const compareRow = () => window.webContents.executeJavaScript("[document.querySelector('#jev-compare-row').hidden, document.querySelector('#jev-compare-detail').textContent]");
  await window.webContents.executeJavaScript("document.querySelector('#settings').click(); new Promise(r => setTimeout(r, 200))");
  assert.equal((await compareRow())[0], true, 'hidden without a Jev key');
  const jevPanel = await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#tab-providers').click();
    const panel = document.querySelector('#jev-provider');
    const input = document.querySelector('#jev-key');
    const collapsed = !panel.open && !input.checkVisibility();
    panel.querySelector('summary').click();
    input.value = 'unsaved-test-key';
    renderProviders();
    panel.querySelector('summary').focus();
    return { collapsed, expanded: panel.open && input.checkVisibility(), draft: input.value,
      text: document.querySelector('#jev-status').textContent, plug: document.querySelector('#jev-plug').className,
      selectable: getComputedStyle(panel.querySelector('summary')).userSelect };
  })()`);
  assert.deepEqual(jevPanel, { collapsed: true, expanded: true, draft: 'unsaved-test-key', text: 'No key saved', plug: 'provider-plug disconnected', selectable: 'none' });
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 20))');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#jev-provider').open"), false, 'Jev expander supports keyboard activation');
  await window.webContents.executeJavaScript("document.querySelector('#tab-general').click(); true");
  controller.smartRouter.jev = new JevClient({ configured: true, read() { throw new Error('A plug toggle must not read the key'); } }, () => { throw new Error('No live Jev request in UI smoke'); }, () => controller.data.settings.jevEnabled !== false);
  controller.jevCompare = { summary: () => ({ compared: 4, errors: 1, sameWorker: 1, sameModel: 2, sameProvider: 3, manual: 2, manualSameModel: 1, costUsd: 0.0004 }) };
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').close(); true");
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + "); document.querySelector('#settings').click(); new Promise(r => setTimeout(r, 200))");
  assert.deepEqual(await window.webContents.executeJavaScript("[document.querySelector('#jev-provider').open, document.querySelector('#jev-key').value, document.querySelector('#jev-plug').className]"), [false, '', 'provider-plug connected']);
  await providerAction("document.querySelector('#tab-providers').click(); document.querySelector('#jev-plug').click()");
  assert.equal(controller.data.settings.jevEnabled, false);
  assert.deepEqual(await window.webContents.executeJavaScript("[document.querySelector('#jev-provider').open, document.querySelector('#jev-status').textContent, document.querySelector('#jev-test').disabled, document.querySelector('#jev-remove').disabled]"), [false, 'Disabled', true, false]);
  await window.webContents.executeJavaScript("document.querySelector('#jev-plug').focus()");
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Space' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Space' });
  await providerAction('');
  assert.equal(controller.data.settings.jevEnabled, true, 'plug supports keyboard re-enabling');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#jev-provider').open"), false);
  await providerAction("document.querySelector('#tab-general').click()");
  const [hidden, detail] = await compareRow();
  assert.equal(hidden, false);
  assert.match(detail, /^Log only\. When on, .*do not change\. 4 compared: same model 50% \(and effort 25%\), same provider 75%; your manual picks 50% same model · Jev cost \$0\.0004 · 1 failed\.$/);
  await window.webContents.executeJavaScript("document.querySelector('#settings-routing').value = 'jev'; document.querySelector('#settings-routing').onchange(); true");
  assert.equal((await compareRow())[0], true, 'hidden while Jev is the router');
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').close(); true");
  // The log-only wiki check: shown with a Jev key, whatever the router, with the verdicts so far.
  controller.trace = { record() {}, summary: () => ({ turns: 3, wiki: { additions: 5, assessed: 3, unassessable: 2, support: { supported: 2, partial: 1 }, novelty: { addition: 2, covered: 1 }, jevCalls: 1, jevCostUsd: 0.0002 } }) };
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + "); document.querySelector('#settings').click(); new Promise(r => setTimeout(r, 200))");
  const wikiCheck = await window.webContents.executeJavaScript("[document.querySelector('#wiki-check-row').hidden, document.querySelector('#wiki-check-detail').textContent]");
  assert.equal(wikiCheck[0], false);
  assert.match(wikiCheck[1], /^Log only\. When on, .*nothing in the wiki changes\..* 5 additions: 3 judged \(2 supported, 1 partial; 2 addition, 1 covered\), 2 not assessable · Jev cost \$0\.0002\.$/);
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').close(); true");
  // Jev failing: the Jev section says since when and which saved settings are on their fallbacks.
  const savedRanking = controller.data.settings.contextRanking;
  controller.data.settings.contextRanking = 'jev';
  controller.smartRouter.jev = { configured: true, health: { since: Date.now(), error: 'Jev timed out after 15 seconds.', at: Date.now() } };
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); true');
  assert.match(await window.webContents.executeJavaScript("document.querySelector('#jev-health').textContent"), /^Unavailable since .+: Jev timed out after 15 seconds\. Meanwhile .*project search uses local ranking/);
  assert.deepEqual(await window.webContents.executeJavaScript("[document.querySelector('#jev-status').textContent, document.querySelector('#jev-plug').className]"), ['Unavailable', 'provider-plug unavailable']);
  controller.smartRouter.jev = { configured: true, health: { since: null, error: null, at: null } };
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); true');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#jev-health').textContent"), '');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#jev-status').textContent"), 'Key saved');
  controller.data.settings.contextRanking = savedRanking;
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#settings-output')"), null, 'large output is always captured, not a setting');
  console.log('Jev fallback status passed');
  controller.smartRouter.jev = undefined; controller.jevCompare = null;
  controller.trace = require('../src/trace.cjs').NO_TRACE;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + "); document.querySelector('#settings').click(); new Promise(r => setTimeout(r, 200))");
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#wiki-check-row').hidden"), true, 'hidden without a Jev key');
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').close(); true");
  console.log('Compare with Jev and wiki check settings passed');
  phase = 'agent controls';
  const { Agents } = require('../src/agents.cjs');
  const { EventEmitter } = require('node:events');
  const agents = new Agents(controller, async () => {}, (file, workspace, options) => {
    const client = new EventEmitter(); client.close = () => {};
    client.call = async () => { throw new Error('UI smoke must not start a provider'); };
    const worker = new Controller(file, workspace, client, { cancel() {}, close() {} }, options);
    worker.initialize = async () => { worker.connection = 'ready'; worker.models = controller.models; worker.account = controller.account; };
    return worker;
  });
  assert.equal(agents.snapshot().agents[0].name, 'Hub');
  ipcMain.removeHandler('bootstrap'); ipcMain.handle('bootstrap', () => agents.snapshot());
  ipcMain.removeHandler('settings'); ipcMain.handle('settings', (_event, values, agentId) => agents.settings(values, agentId));
  ipcMain.handle('permissions', (_event, id, access) => { agents.owner(id).permissions(id, access); return agents.snapshot(); });
  ipcMain.handle('saveAgent', (_event, profile) => agents.saveAgent(profile));
  ipcMain.handle('renameHub', (_event, name) => agents.renameHub(name));
  ipcMain.handle('saveGroup', (_event, value) => agents.saveGroup(value));
  ipcMain.handle('archive', (_event, id) => { agents.owner(id).archive(id); return agents.snapshot(); });
  ipcMain.handle('deleteAgent', (_event, id) => agents.deleteAgent(id));
  ipcMain.removeHandler('create'); ipcMain.handle('create', (_event, workspace, access, agentId) => agents.conversation(agents.controller(agentId), true, workspace, access));
  let stoppedAgent;
  ipcMain.handle('stop', (_event, id) => { stoppedAgent = agents.owner(id).agentId; });
  ipcMain.handle('load', () => agents.snapshot());
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); document.querySelector("#agent-new").click(); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-dialog").open'), true);
  await window.webContents.executeJavaScript(`document.querySelector('#agent-name').value = 'Researcher';
    document.querySelector('#agent-instructions').value = 'Inspect source and report evidence.';
    document.querySelector('#agent-model').value = 'auto';
    document.querySelector('#agent-form').dispatchEvent(new Event('submit', { cancelable: true })); true`);
  await until(() => controller.data.agents.length === 1, 'the named agent was saved');
  const profile = controller.data.agents[0];
  for (let i = 0; i < 100 && await window.webContents.executeJavaScript('selectedAgent') !== profile.id; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await window.webContents.executeJavaScript('selectedAgent'), profile.id);
  assert.equal(profile.access, 'read-only');
  assert.equal(profile.instructions, 'Inspect source and report evidence.');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-list [data-action=delete]")'), null, 'Sidebar deletion uses the context menu');
  await window.webContents.executeJavaScript('selectAgent("main")');
  const completedBatchChat = agents.conversation(agents.controller(profile.id), true);
  profile.temporaryBatch = randomUUID(); controller.save();
  const batchNav = '#agent-list [data-agent="' + profile.id + '"]';
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  assert.equal(await window.webContents.executeJavaScript('!!document.querySelector(' + JSON.stringify(batchNav) + ')'), false);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-roster-label").textContent'), 'Other bots · 0');
  const waitingBatch = agents.snapshot(), batchPendingState = waitingBatch.agentStates[profile.id];
  batchPendingState.sessions.find(chat => chat.id === batchPendingState.conversationId).queue = [{ id: randomUUID(), text: 'Saved pending work.' }];
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(waitingBatch) + '); true');
  assert.equal(await window.webContents.executeJavaScript('!!document.querySelector(' + JSON.stringify(batchNav) + ')'), true, 'queued batch work stays visible');
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); document.querySelector("#agents-overview").click(); true');
  const batchCard = '#agent-cards [data-agent="' + profile.id + '"]';
  await window.webContents.executeJavaScript('document.querySelector(' + JSON.stringify(batchCard + '[data-action="open"]') + ').click(); true');
  await until(async () => await window.webContents.executeJavaScript('selectedAgent') === profile.id, 'a finished batch worker opens from Overview');
  assert.equal(await window.webContents.executeJavaScript('!!document.querySelector(' + JSON.stringify(batchNav) + ')'), true, 'the selected batch chat stays in the sidebar');
  await window.webContents.executeJavaScript('selectAgent("main")');
  await window.webContents.executeJavaScript('document.querySelector("#agents-overview").click(); document.querySelector(' + JSON.stringify(batchCard + '[data-action="edit"]') + ').click(); document.querySelector("#agent-form").dispatchEvent(new Event("submit",{cancelable:true})); true');
  await until(() => !controller.data.agents[0].temporaryBatch, 'editing and saving keeps a batch worker');
  await window.webContents.executeJavaScript('document.querySelector("#agents-dialog").close(); true');
  await window.webContents.executeJavaScript('selectAgent("main")');
  assert.equal(await window.webContents.executeJavaScript('!!document.querySelector(' + JSON.stringify(batchNav) + ')'), true);
  // Renaming the Hub from its Overview card names it in the sidebar and keeps that name.
  // The batch worker's Save above still reloads state after the server saves; let it finish so it cannot apply an older name.
  await until(async () => await window.webContents.executeJavaScript("!document.querySelector('#agent-save').disabled"), 'the batch worker Save finished');
  await window.webContents.executeJavaScript(`document.querySelector('#agents-overview').click();
    document.querySelector('#agent-cards [data-agent="main"][data-action="rename"]').click();
    document.querySelector('#hub-name').value = 'Atlas'; new Promise(r => setTimeout(r, 100))`);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/hub-rename.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("document.querySelector('#hub-form').dispatchEvent(new Event('submit', { cancelable: true })); true");
  await until(async () => await window.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#main-agent-list');
    return list.textContent.includes('Atlas') && list.querySelector('.agent-avatar')?.textContent === 'A';
  })()`), 'the renamed Hub shows its name and initial in the sidebar');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#hub-dialog').open"), false);
  assert.equal(agents.hubName(), 'Atlas');
  agents.renameHub('Hub');
  await window.webContents.executeJavaScript('document.querySelector("#agents-dialog").close(); applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  console.log('Hub rename from Overview passed');
  // Update reads the fleet state, so it still shows with a worker selected.
  controller.cliUpdates = { 'cursor-cli': { installed: '2026.10.01-e373342', latest: '2026.10.16-e3cb207' } };
  const workerCursor = agents.controller(profile.id).cursor, cursorStatus = workerCursor.status;
  workerCursor.status = { ...cursorStatus, installed: true };
  await window.webContents.executeJavaScript(`selectAgent(${JSON.stringify(profile.id)})`);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); renderProviders(); true');
  assert.equal(await window.webContents.executeJavaScript('selectedAgent'), profile.id);
  const workerRows = await window.webContents.executeJavaScript(`[...document.querySelectorAll('.provider-account-row')]
    .map(row => [row.dataset.connectionProvider, row.dataset.installed, row.querySelector('.provider-install')?.textContent || ''])`);
  assert.deepEqual(workerRows.filter(([, , button]) => button === 'Update').map(([id]) => id), ['cursor-cli'], JSON.stringify(workerRows));
  controller.cliUpdates = {};
  workerCursor.status = cursorStatus;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); selectAgent("main")');
  console.log('Update button with a worker selected passed');
  assert.equal(agents.conversation(agents.controller(profile.id)).id, completedBatchChat.id);
  await window.webContents.executeJavaScript('document.querySelector(\'#agent-list [data-agent="' + profile.id + '"]\').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: innerWidth - 2, clientY: innerHeight - 2 })); true');
  const menuView = await window.webContents.executeJavaScript(`(() => {
    const menu = document.querySelector('#agent-menu'), box = menu.getBoundingClientRect();
    return { open: menu.matches(':popover-open'), labels: [...menu.querySelectorAll('button')].map(b => b.textContent),
      color: getComputedStyle(menu.querySelector('[data-action=delete]')).color,
      inBounds: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight };
  })()`);
  assert.equal(menuView.open, true);
  assert.deepEqual(menuView.labels, ['Open', 'Edit', 'Delete']);
  assert.equal(menuView.color, await window.webContents.executeJavaScript('getComputedStyle(document.querySelector("#delete-confirm")).color'),
    'Delete retains the theme danger color');
  assert.equal(menuView.inBounds, true, 'menu stays visible near window edges');
  await window.webContents.executeJavaScript('document.querySelector("#agent-menu").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); true');
  assert.equal(await window.webContents.executeJavaScript('document.activeElement.textContent'), 'Edit');
  await window.webContents.executeJavaScript('document.querySelector("#agent-menu").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); true');
  for (let i = 0; i < 100 && !await window.webContents.executeJavaScript('document.querySelector("#agent-dialog").open'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-dialog").dataset.agentId'), profile.id);
  assert.equal(await window.webContents.executeJavaScript('selectedAgent'), 'main', 'Right-click does not switch conversations');
  await window.webContents.executeJavaScript('document.querySelector("#agent-dialog").close(); true');
  await window.webContents.executeJavaScript('document.querySelector("#main-agent-list .agent-nav").dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true })); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-menu").matches(":popover-open")'), true);
  assert.equal(await window.webContents.executeJavaScript('!!document.querySelector("#agent-menu [data-action=delete]")'), false, 'Main has no Delete menu option');
  await window.webContents.executeJavaScript('document.querySelector("#agent-menu").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); true');
  assert.equal(await window.webContents.executeJavaScript('document.activeElement.dataset.agent'), 'main', 'Escape returns focus to the agent');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-menu").matches(":popover-open")'), false);
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(profile.id) + ')');
  await window.webContents.executeJavaScript('api.browseWorkspace(null, "changes")');
  assert.equal(browseCalls.at(-1).at(-1), profile.id, 'new conversations browse the selected agent workspace');
  const mainAccessBefore = controller.data.settings.access, agentAccessBefore = agents.profile(profile.id).access;
  await window.webContents.executeJavaScript("document.querySelector('#settings').onclick()");
  await changeSetting('settings-access', 'danger-full-access');
  assert.equal(agents.profile(profile.id).access, 'danger-full-access');
  assert.equal(controller.data.settings.access, mainAccessBefore, 'settings autosave targets the selected agent');
  await changeSetting('settings-access', agentAccessBefore);
  await window.webContents.executeJavaScript('closeSettings()');
  await window.webContents.executeJavaScript(`document.querySelector('#prompt').value = 'Researcher draft'; imageDrafts.set(draftKey(), ['data:image/png;base64,']); selectAgent('main')`);
  assert.notEqual(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Researcher draft');
  assert.equal(await window.webContents.executeJavaScript('attachedImages().includes("data:image/png;base64,")'), false);
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(profile.id) + ')');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Researcher draft');
  assert.equal(await window.webContents.executeJavaScript('attachedImages().length'), 1);
  await window.webContents.executeJavaScript('imageDrafts.delete(draftKey()); document.querySelector("#prompt").value = ""; true');
  const worker = agents.controller(profile.id), workerSession = agents.conversation(worker, true);
  worker.busy = workerSession.id; workerSession.status = 'running';
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  assert.equal(await window.webContents.executeJavaScript('state.busy'), workerSession.id);
  await window.webContents.executeJavaScript('api.stop(); true');
  await until(() => stoppedAgent === profile.id, 'Stop targets the selected agent');
  await window.webContents.executeJavaScript('selectAgent("main")');
  assert.equal(await window.webContents.executeJavaScript('state.busy'), controller.busy);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-list .agent-nav").getAttribute("aria-label")'), 'Researcher · Working');
  const activeChatState = () => window.webContents.executeJavaScript(`JSON.stringify({
    selectedAgent, busy: state.busy, draft: document.querySelector('#prompt').value,
    jobs: state.sessions.map(session => [session.id, session.status, session.queue])
  })`);
  const beforeAppearanceChange = await activeChatState();
  await chooseAppearance('dark');
  assert.equal(await activeChatState(), beforeAppearanceChange, 'changing appearance preserves active jobs, draft and selection');
  await chooseAppearance('system');
  stoppedAgent = null;
  const optionsOpen = () => window.webContents.executeJavaScript('document.querySelector("#chat-options").open');
  await window.webContents.executeJavaScript(`(() => {
    const options = document.querySelector('#chat-options');
    options.querySelector('summary').click();
    options.querySelector('#preset').click();
  })()`);
  assert.equal(await optionsOpen(), true, 'clicking a control inside Options keeps it open');
  await window.webContents.executeJavaScript('document.querySelector("#prompt").focus(); document.querySelector("#prompt").click(); true');
  assert.equal(await optionsOpen(), false, 'clicking outside Options dismisses it');
  await window.webContents.executeJavaScript(`(() => {
    const summary = document.querySelector('#chat-options > summary');
    summary.click();
    summary.focus();
  })()`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await until(async () => !await optionsOpen(), 'Escape dismisses Options');
  assert.equal(await window.webContents.executeJavaScript('document.activeElement.matches("#chat-options > summary")'), true,
    'Escape restores focus to the Options trigger');
  assert.equal(await activeChatState(), beforeAppearanceChange, 'dismissing Options preserves the active job and draft');
  assert.equal(stoppedAgent, null, 'dismissing Options must not stop the running task');
  console.log('Options inside click, outside click and Escape dismissal passed');
  await window.webContents.executeJavaScript('document.querySelector(\'#agent-list [data-agent="' + profile.id + '"]\').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-menu [data-action=delete]").disabled'), true, 'Busy agents cannot be deleted from the menu');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-menu [data-action=edit]").disabled'), true, 'Busy agents cannot be edited from the menu');
  await window.webContents.executeJavaScript('document.querySelector("#agent-menu [data-action=stop]").click(); true');
  await until(() => stoppedAgent === profile.id, 'Context menu Stop targets its agent, not the selected conversation');
  worker.busy = null;
  const waitingState = agents.snapshot();
  waitingState.agentStates[profile.id].waitingForAgents = [workerSession.id];
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(waitingState) + '); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-list .agent-nav").getAttribute("aria-label")'), 'Researcher · Waiting');
  stoppedAgent = null;
  await window.webContents.executeJavaScript('document.querySelector(\'#agent-list [data-agent="' + profile.id + '"]\').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); document.querySelector("#agent-menu [data-action=stop]").click(); true');
  await until(() => stoppedAgent === profile.id, 'Stop remains available while an agent waits for nested tasks');
  worker.busy = workerSession.id;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  await window.webContents.executeJavaScript('document.querySelector("#agents-overview").click(); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agents-dialog").open'), true);
  stoppedAgent = null;
  await window.webContents.executeJavaScript('document.querySelector("#agent-cards [data-action=stop]").click(); true');
  await until(() => stoppedAgent === profile.id, 'Overview Stop targets the card agent, not the selected agent');
  await window.webContents.executeJavaScript('document.querySelector(\'#agent-cards [data-agent="' + profile.id + '"][data-action=open]\').click(); true');
  for (let i = 0; i < 100 && await window.webContents.executeJavaScript('selectedId') !== workerSession.id; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await window.webContents.executeJavaScript('selectedAgent'), profile.id);
  assert.equal(await window.webContents.executeJavaScript('selectedId'), workerSession.id, 'Open task goes to the active conversation');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agents-dialog").open'), false);
  await window.webContents.executeJavaScript('selectAgent("main")');
  const sourceSession = agents.conversation(controller, true);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); selectSession(' + JSON.stringify(sourceSession.id) + ')');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-delegate, #delegate-dialog, [data-action=delegate]")'), null, 'Task requests use agent tools, not Delegate controls');
  window.setSize(1320, 900);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#sessions, #new-session, #workspace, #welcome p")'), null,
    'The old session-management controls remain removed');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#welcome h2").textContent'), 'What would you like to work on?');
  worker.connection = 'connecting'; worker.busy = null;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#agent-cards").textContent'), /Starting/);
  worker.connection = 'ready'; worker.busy = workerSession.id;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); document.querySelector("#agents-overview").click(); true');
  await new Promise(resolve => setTimeout(resolve, 250));
  const screenshot = path.resolve(__dirname, '../.scratch/agents-ui.png');
  fs.writeFileSync(screenshot, (await window.webContents.capturePage()).toPNG());
  worker.busy = null; workerSession.status = 'idle';
  await window.webContents.executeJavaScript('document.querySelector("#prompt").value = "Main draft stays"; true');
  await window.webContents.executeJavaScript('document.querySelector("#agents-dialog").close(); applyState(' + JSON.stringify(agents.snapshot()) + '); selectAgent(' + JSON.stringify(profile.id) + ')');
  await window.webContents.executeJavaScript('document.querySelector(\'#agent-list [data-agent="' + profile.id + '"]\').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); document.querySelector("#agent-menu [data-action=delete]").click(); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#delete-dialog").open'), true);
  await window.webContents.executeJavaScript(`(() => {
    const range = document.createRange(); range.selectNodeContents(document.querySelector('#delete-title'));
    getSelection().removeAllRanges(); getSelection().addRange(range);
    document.querySelector('#delete-dialog .close-dialog').click();
  })()`);
  await window.webContents.executeJavaScript('document.querySelector(\'#agent-list [data-agent="' + profile.id + '"]\').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); document.querySelector("#agent-menu [data-action=delete]").click(); true');
  assert.equal(await window.webContents.executeJavaScript('getSelection().toString()'), '', 'A reopened delete dialog does not retain text selection');
  await window.webContents.executeJavaScript('document.querySelector("#delete-confirm").click(); true');
  await until(() => !agents.profile(profile.id), 'Delete removes the selected agent');
  for (let i = 0; i < 100 && await window.webContents.executeJavaScript('selectedAgent') !== 'main'; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(await window.webContents.executeJavaScript('selectedAgent'), 'main');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#session-title').textContent"), 'Hub');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Main draft stays');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#main-agent-list [data-action=delete]")'), null, 'Main cannot be deleted');
  const names = ['Researcher', 'Reviewer', 'Builder', 'Test runner', 'Documentation', 'Planner', 'Code search', 'UI designer', 'Release notes', 'Performance', 'Refactor', 'Verifier'];
  for (const name of names) await agents.saveAgent({ name, instructions: '', workspace: root, mode: 'auto', access: 'read-only' });
  await agents.initialize();
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  const narrowOverview = await window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('#agents-dialog');
    dialog.style.width = '400px'; dialog.style.height = '420px'; document.querySelector('#agents-overview').click();
    const box = dialog.getBoundingClientRect();
    return { scrolls: dialog.scrollHeight > dialog.clientHeight,
      fits: [...document.querySelectorAll('.agent-card')].every(card => card.getBoundingClientRect().right <= box.right),
      columns: getComputedStyle(document.querySelector('#agent-cards')).gridTemplateColumns.split(' ').length };
  })()`);
  assert.deepEqual(narrowOverview, { scrolls: true, fits: true, columns: 1 }, 'Overview cards fit a narrowed dialog');
  await new Promise(r => setTimeout(r, 100));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/resized-agents.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("document.querySelector('#agents-dialog').close(); document.querySelector('#agents-dialog').style.removeProperty('width'); document.querySelector('#agents-dialog').style.removeProperty('height'); true");
  const fontScaling = await window.webContents.executeJavaScript(`(() => {
    const root = document.documentElement, previous = root.style.getPropertyValue('--font-scale');
    const text = [...document.body.querySelectorAll('*')].filter(node =>
      node.matches('input,textarea,select') || [...node.childNodes].some(child => child.nodeType === Node.TEXT_NODE && child.textContent.trim()));
    const failures = [];
    try {
      root.style.setProperty('--font-scale', '1');
      const baseline = text.map(node => ({ node, size: parseFloat(getComputedStyle(node).fontSize) }));
      const add = document.querySelector('#agent-new svg'), icon = add.getBoundingClientRect().width;
      for (const scale of [.85, 1.15, 1.3, 1.5]) {
        root.style.setProperty('--font-scale', String(scale));
        for (const { node, size } of baseline) {
          const actual = parseFloat(getComputedStyle(node).fontSize);
          if (Math.abs(actual - size * scale) > .1) failures.push({ element: node.id || node.className || node.tagName, scale, actual, expected: size * scale });
        }
        if (Math.abs(add.getBoundingClientRect().width - icon * scale) > .1) failures.push({ element: 'add agent icon', scale });
      }
    } finally { root.style.setProperty('--font-scale', previous); }
    return { checked: text.length, failures };
  })()`);
  assert.ok(fontScaling.checked > 100, 'the font audit covers controls, conversation, sidebar and dialogs');
  assert.deepEqual(fontScaling.failures, [], 'all Harness text and the add-agent icon follow every Font Size option');
  controller.data.settings.fontScale = 150;
  window.setSize(840, 640);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  const agentLayout = await window.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#agent-list'), main = document.querySelector('#main-agent-list');
    const add = document.querySelector('#agent-new').getBoundingClientRect();
    const access = document.querySelector('#permissions'), roster = document.querySelector('#agent-roster-label').getBoundingClientRect();
    const overview = document.querySelector('#agents-overview').getBoundingClientRect();
    const before = main.getBoundingClientRect().top; list.scrollTop = list.scrollHeight;
    return { scrolls: list.scrollHeight > list.clientHeight, room: list.clientHeight > 100, pinned: main.getBoundingClientRect().top === before,
      accessFits: access.getBoundingClientRect().right <= access.parentElement.getBoundingClientRect().right,
      headingFits: roster.right <= overview.left || roster.bottom <= overview.top,
      controlsFit: add.bottom <= main.getBoundingClientRect().top && main.getBoundingClientRect().bottom <= list.getBoundingClientRect().top && add.bottom <= innerHeight };
  })()`);
  assert.deepEqual(agentLayout, { scrolls: true, room: true, pinned: true, accessFits: true, headingFits: true, controlsFit: true });
  await window.webContents.executeJavaScript('document.querySelector("#agent-list").scrollTop = 0; document.querySelector("#toast").hidden = true; true');
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/agents-font-150.png'), (await window.webContents.capturePage()).toPNG());
  controller.data.settings.fontScale = 100; window.setSize(1320, 900);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); selectAgent(' + JSON.stringify(agents.primary.data.agents[0].id) + ')');
  await window.webContents.executeJavaScript('document.querySelector("#toast").hidden = true; true');
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/agents-sidebar.png'), (await window.webContents.capturePage()).toPNG());
  for (const mode of ['light', 'dark']) {
    await chooseAppearance(mode);
    await themeFrame();
    fs.writeFileSync(path.resolve(__dirname, `../.scratch/app-${mode}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await chooseAppearance('system');
  console.log('Agent creation, persistent chat selection, chat-only task requests, deletion, pinned Main and sidebar scrolling passed');
  phase = 'slash commands';
  const compacted = [];
  ipcMain.handle('compact', (_event, id) => { compacted.push(id); });
  let clearPrompts = 0;
  ipcMain.handle('clearConversation', async (_event, id, groupId) => {
    const fresh = await agents.clearConversation(id, name => {
      clearPrompts++;
      return confirmation.ask({ title: 'Start a fresh conversation?', message: `Clear the current context for ${name} and start with a blank chat.`,
        details: [{ label: 'Fresh context', text: 'The current conversation, draft and attachments leave the chat.' },
          { label: 'Same agent', text: 'Role, workspace and access stay the same.' }],
        note: 'Your previous conversation is archived on this computer.', confirmLabel: 'Clear conversation', cancelLabel: 'Keep conversation', danger: true });
    }, groupId);
    return { cleared: !!fresh, sessionId: fresh?.id, state: agents.snapshot() };
  });
  const commandAgent = await window.webContents.executeJavaScript('selectedAgent');
  const oldConversation = agents.conversation(agents.controller(commandAgent), true);
  const mainConversationId = agents.conversation(controller).id;
  oldConversation.items.push({ id: 'clear-history', type: 'agentMessage', text: 'Earlier agent history.' });
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  const commandNames = ['/help', '/compact', '/clear', '/stop', '/agents', '/settings', '/context', '/model', '/effort', '/access', '/switch', '/export', '/status'];
  const sentBeforeCommands = sent.length, previewsBeforeCommands = previews;
  const typeCommand = text => window.webContents.executeJavaScript(`(() => {
    const prompt = document.querySelector('#prompt'); prompt.focus(); prompt.value = ${JSON.stringify(text)};
    prompt.setSelectionRange(prompt.value.length, prompt.value.length); prompt.dispatchEvent(new Event('input'));
    return [...document.querySelectorAll('#slash-options code')].map(node => node.textContent);
  })()`);
  const commandKey = key => window.webContents.executeJavaScript(`document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); true`);
  assert.deepEqual(await typeCommand('/'), commandNames);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#slash-menu").hidden'), false);
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/slash-menu.png'), (await window.webContents.capturePage()).toPNG());
  assert.deepEqual(await typeCommand('/C'), ['/compact', '/clear', '/context'], 'prefix matching ignores case');
  await commandKey('ArrowDown');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").getAttribute("aria-activedescendant")'), 'slash-clear');
  await commandKey('ArrowUp'); await commandKey('Tab');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '/compact');
  assert.equal(compacted.length, 0, 'Tab completes without running the command');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#slash-menu").hidden'), true);
  await typeCommand('/c'); await commandKey('Escape');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#slash-menu").hidden'), true);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '/c');
  assert.deepEqual(await typeCommand('/zz'), []);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#slash-empty").hidden'), false);
  assert.deepEqual(await typeCommand('/'), commandNames, 'removing a prefix restores all commands');
  assert.deepEqual(await typeCommand('/se'), ['/settings']);
  await commandKey('Enter');
  for (let i = 0; i < 100 && !await window.webContents.executeJavaScript('document.querySelector("#settings-dialog").open'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#settings-dialog").open'), true);
  await window.webContents.executeJavaScript('document.querySelector("#settings-dialog").close(); true');
  await typeCommand('/he');
  await window.webContents.executeJavaScript('document.querySelector("#slash-help").click(); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#commands-dialog").open'), true);
  await window.webContents.executeJavaScript('document.querySelector("#commands-dialog").close(); true');
  await typeCommand('/clear extra');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#slash-menu").hidden'), true, 'arguments are not command completions');
  await typeCommand('/');
  // Hidden offscreen windows change activeElement without emitting native blur events.
  await window.webContents.executeJavaScript('document.querySelector("#commands-help").focus(); document.querySelector("#prompt").dispatchEvent(new FocusEvent("blur")); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#slash-menu").hidden'), true, 'leaving the composer dismisses suggestions');
  controller.data.settings.fontScale = 150; window.setSize(840, 640);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  await typeCommand('/');
  assert.equal(await window.webContents.executeJavaScript(`(() => { const box = document.querySelector('#slash-menu').getBoundingClientRect(); return box.top >= 0 && box.left >= 0 && box.right <= innerWidth && box.bottom <= innerHeight; })()`), true, 'command menu fits the minimum window at 150% text');
  controller.data.settings.fontScale = 100; window.setSize(1320, 900);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  assert.equal(sent.length, sentBeforeCommands);
  assert.equal(previews, previewsBeforeCommands, 'filtering command suggestions does not invoke routing');
  console.log('Slash suggestions, filtering, keyboard completion, mouse selection and responsive layout passed');
  await submit('/help');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#commands-dialog").open'), true);
  assert.deepEqual(await window.webContents.executeJavaScript('[...document.querySelectorAll("#commands-list code")].map(node => node.textContent)'), commandNames);
  await window.webContents.executeJavaScript('document.querySelector("#commands-dialog").close(); true');
  await submit('/compact'); await until(() => compacted.length === 1, 'slash compact uses existing compaction');
  assert.equal(compacted[0], oldConversation.id);
  stoppedAgent = null; await submit('/stop'); await until(() => stoppedAgent === commandAgent, 'slash stop targets the selected named agent, not Main');
  await submit('/agents'); assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agents-dialog").open'), true);
  await window.webContents.executeJavaScript('document.querySelector("#agents-dialog").close(); true');
  await submit('/settings');
  for (let i = 0; i < 100 && !await window.webContents.executeJavaScript('document.querySelector("#settings-dialog").open'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#settings-dialog").open'), true);
  await window.webContents.executeJavaScript('document.querySelector("#settings-dialog").close(); true');
  const waitForDialog = () => window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    let attempts = 0; const check = () => {
      if (document.querySelector('.confirmation-dialog')?.open) return resolve(true);
      if (++attempts > 100) return reject(new Error('Confirmation did not open'));
      setTimeout(check, 10);
    }; check();
  })`);
  const waitForCommand = () => window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    let attempts = 0; const check = () => {
      if (!submitting) return resolve(true);
      if (++attempts > 100) return reject(new Error('Command did not finish'));
      setTimeout(check, 10);
    }; check();
  })`);
  const openCommand = async name => {
    await typeCommand('/' + name);
    await window.webContents.executeJavaScript(`runCommand(${JSON.stringify(name)}, ${JSON.stringify('/' + name)})`);
  };
  const closeCommand = () => window.webContents.executeJavaScript('document.querySelector("#command-dialog").close(); true');
  const pickChoice = id => window.webContents.executeJavaScript(`pickCommandChoice(${JSON.stringify(id)})`);
  const panelText = () => window.webContents.executeJavaScript('document.querySelector("#command-content").textContent');
  const filterChoices = query => window.webContents.executeJavaScript(`(() => {
    const search = document.querySelector('#command-search'); search.value = ${JSON.stringify(query)}; search.dispatchEvent(new Event('input'));
    return [...document.querySelectorAll('#command-content button')].map(button => button.dataset.choice);
  })()`);
  const commandWorker = agents.controller(commandAgent), originalMainMode = controller.data.settings.mode, originalMainAccess = agents.conversation(controller).access;
  controller.account = { type: 'chatgpt', plan: 'pro' };
  controller.models = [{ model: 'gpt-6-sol', supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'high' }] }];
  for (const c of agents.controllers.values()) { c.models = controller.models; c.account = controller.account; }
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  await openCommand('model');
  assert.deepEqual(await filterChoices('GPT-6-SOL'), ['codex|gpt-6-sol'], 'models are searchable and grouped across efforts');
  await pickChoice('codex|gpt-6-sol');
  assert.equal(commandWorker.data.settings.mode, 'codex:gpt-6-sol:low');
  assert.equal(controller.data.settings.mode, originalMainMode, 'model command changes only the selected agent');
  await openCommand('effort');
  await window.webContents.executeJavaScript('document.querySelector("#command-dialog").dispatchEvent(new Event("close")); true');
  assert.deepEqual(await filterChoices(''), ['codex:gpt-6-sol:low', 'codex:gpt-6-sol:high'], 'effort choices match model support');
  await pickChoice('codex:gpt-6-sol:high');
  assert.equal(commandWorker.data.settings.mode, 'codex:gpt-6-sol:high');
  await openCommand('model');
  await filterChoices('auto');
  await window.webContents.executeJavaScript(`document.querySelector('#command-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })); true`);
  await until(() => commandWorker.data.settings.mode === 'auto', 'Enter selects a filtered model');
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 20))');
  await openCommand('effort'); await pickChoice('medium');
  assert.equal(controller.data.settings.effortCap, 'medium', 'Auto uses the existing shared effort cap');
  await openCommand('access'); await pickChoice('read-only');
  assert.equal(oldConversation.access, 'read-only');
  assert.equal(agents.conversation(controller).access, originalMainAccess, 'access command leaves Main unchanged');
  commandWorker.busy = oldConversation.id;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  await openCommand('access');
  assert.equal(await window.webContents.executeJavaScript('[...document.querySelectorAll("#command-content button")].every(button => button.disabled)'), true);
  await pickChoice('danger-full-access');
  assert.equal(oldConversation.access, 'read-only', 'busy access changes remain blocked even through a stale choice');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#command-error").textContent'), /unavailable/);
  await closeCommand(); commandWorker.busy = null;
  oldConversation.usage = { modelContextWindow: 1000, last: { inputTokens: 350, outputTokens: 50 } };
  oldConversation.lastCompactedAt = Date.UTC(2026, 9, 9, 12);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  await openCommand('context');
  assert.match(await panelText(), /400 \/ 1,000 tokens \(40%\)/);
  assert.match(await panelText(), /About 600 tokens/);
  assert.doesNotMatch(await panelText(), /No compaction time recorded/);
  oldConversation.activeProvider = 'cursor-cli';
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  assert.match(await panelText(), /Unavailable/);
  assert.doesNotMatch(await panelText(), /About 600 tokens/, 'unsupported providers do not show stale estimates');
  delete oldConversation.lastCompactedAt; oldConversation.usage = null;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  assert.match(await panelText(), /No compaction time recorded/);
  await closeCommand(); oldConversation.activeProvider = 'codex';
  oldConversation.tasks = [{ id: 'command-task', goal: 'Inspect <b>source</b>', state: 'running' }];
  oldConversation.queue = [{ id: 'command-queue', text: 'Review next', images: [] }];
  const child = [...agents.controllers.values()].find(c => c.agentId !== 'main' && c !== commandWorker);
  const childSession = agents.conversation(child, true);
  childSession.delegation = { source: oldConversation.id, state: 'queued', delivered: false };
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  await openCommand('status');
  assert.match(await panelText(), /Waiting for child agents/);
  assert.match(await panelText(), /Inspect <b>source<\/b>/);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#command-content b")'), null, 'status data renders as text');
  assert.match(await panelText(), /Review next/);
  assert.match(await panelText(), new RegExp(agents.profile(child.agentId).name + ': queued'));
  await closeCommand(); delete oldConversation.tasks; delete oldConversation.queue; delete childSession.delegation;
  const exported = [], exportPath = path.join(root, 'conversation.md'); let exportCancelled = true, exportFails = false;
  require('electron').dialog.showSaveDialog = async (_window, options) => {
    assert.equal(options.filters[0].extensions[0], 'md');
    return { canceled: exportCancelled, filePath: exportFails ? root : exportPath };
  };
  ipcMain.handle('exportConversation', (_event, id) => {
    exported.push(id); return require('../src/conversation-export.cjs').exportConversation(window, agents.owner(id).session(id));
  });
  await openCommand('export');
  assert.equal(exported.at(-1), oldConversation.id);
  assert.equal(fs.existsSync(exportPath), false, 'canceling export writes no file');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '/export', 'canceling export retains the command');
  exportCancelled = false; exportFails = true; await openCommand('export');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '/export', 'a save error retains the command for retry');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#toast").textContent'), /EISDIR|EPERM|EACCES/);
  exportFails = false;
  exportCancelled = false; await openCommand('export');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '');
  assert.match(fs.readFileSync(exportPath, 'utf8'), /Earlier agent history\./, 'export saves the selected agent conversation');
  assert.equal(previews, previewsBeforeCommands, 'new commands stay local');
  await window.webContents.executeJavaScript('drafts.set(' + JSON.stringify(mainConversationId) + ', "/help"); true');
  await openCommand('switch');
  assert.deepEqual(await filterChoices('HUB'), ['main']);
  await pickChoice('main');
  assert.equal(await window.webContents.executeJavaScript('selectedAgent'), 'main');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '/help');
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(commandAgent) + ')');
  await openCommand('switch');
  assert.deepEqual(await filterChoices('no-such-agent'), []);
  assert.match(await panelText(), /No matching choices/);
  await filterChoices('');
  await window.webContents.executeJavaScript(`document.querySelector('#command-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })); true`);
  assert.equal(await window.webContents.executeJavaScript('document.activeElement === document.querySelector("#command-content button:last-child")'), true, 'Up from search focuses the last choice');
  await window.webContents.executeJavaScript('document.querySelector("#command-search").focus(); true');
  await window.webContents.executeJavaScript(`document.querySelector('#command-search').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); true`);
  assert.equal(await window.webContents.executeJavaScript('document.activeElement.dataset.choice'), 'main');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESC' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'ESC' });
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 20))');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#command-dialog").open'), false, 'Escape closes the picker');
  assert.equal(await window.webContents.executeJavaScript('selectedAgent'), commandAgent);
  const emptyAgent = [...agents.controllers.values()].find(c => c.agentId !== 'main' && !agents.conversation(c));
  assert.ok(emptyAgent, 'fixture has an agent without a conversation');
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(emptyAgent.agentId) + ')');
  await openCommand('access'); await pickChoice('read-only');
  assert.equal(emptyAgent.data.settings.access, 'read-only');
  assert.equal(agents.profile(emptyAgent.agentId).access, 'read-only', 'access is saved before the first conversation');
  await window.webContents.executeJavaScript('selectAgent("main").then(() => selectAgent(' + JSON.stringify(emptyAgent.agentId) + '))');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#permissions").value'), 'read-only');
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(commandAgent) + ')');
  await openCommand('model');
  controller.data.settings.fontScale = 150; window.setSize(840, 640);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  assert.equal(await window.webContents.executeJavaScript(`(() => { const box = document.querySelector('#command-dialog').getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth; })()`), true, 'picker fits the minimum window with large text');
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/command-model.png'), (await window.webContents.capturePage()).toPNG());
  await closeCommand(); controller.data.settings.fontScale = 100; window.setSize(1320, 900);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  assert.equal(sent.length, sentBeforeCommands);
  console.log('Context, model, effort, access, switch, export and status commands passed');
  phase = 'confirmation dialogs';
  await typeCommand('/cl');
  await window.webContents.executeJavaScript('document.querySelector("#slash-clear").click(); true');
  await waitForDialog();
  assert.equal(clearPrompts, 1);
  assert.equal(agents.conversation(agents.controller(commandAgent)).id, oldConversation.id);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '/clear');
  const confirmationView = await window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('.confirmation-dialog'), box = dialog.getBoundingClientRect();
    return { focus: document.activeElement.textContent, cursor: getComputedStyle(dialog).cursor, backdrop: getComputedStyle(dialog, '::backdrop').cursor,
      buttonsUnselectable: [...dialog.querySelectorAll('button')].every(button => getComputedStyle(button).userSelect === 'none'),
      fits: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight };
  })()`);
  assert.deepEqual(confirmationView, { focus: 'Keep conversation', cursor: 'default', backdrop: 'default', buttonsUnselectable: true, fits: true });
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/confirmation-clear.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript('document.querySelector(".confirmation-cancel").click(); true');
  await waitForCommand();
  assert.equal(agents.conversation(agents.controller(commandAgent)).id, oldConversation.id);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '/clear');
  await submit('/clear', false); await waitForDialog();
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
  await waitForCommand();
  assert.equal(agents.conversation(agents.controller(commandAgent)).id, oldConversation.id, 'Escape cancels without clearing');
  await submit('/clear', false); await waitForDialog();
  assert.equal(await window.webContents.executeJavaScript('document.activeElement.textContent'), 'Keep conversation', 'reopened confirmation has a safe default');
  await window.webContents.executeJavaScript('document.querySelector(".confirmation-accept").click(); true');
  await waitForCommand();
  for (let i = 0; i < 100 && await window.webContents.executeJavaScript('selectedId') === oldConversation.id; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.notEqual(await window.webContents.executeJavaScript('selectedId'), oldConversation.id);
  assert.equal(await window.webContents.executeJavaScript('current().items.length'), 0);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '');
  assert.equal(agents.conversation(controller).id, mainConversationId);
  await submit('/not-a-command');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#toast").textContent'), /Unknown command/);
  assert.equal(sent.length, sentBeforeCommands, 'slash commands never become model prompts');
  assert.equal(previews, previewsBeforeCommands, 'slash commands do not invoke routing previews');
  console.log('Slash commands, selected-agent targeting and confirmed clear passed');
  const selectableButtons = await window.webContents.executeJavaScript(`(() => {
    const buttons = [...document.querySelectorAll('button,button *,[role=button],[role=button] *,input[type=button],input[type=submit],input[type=reset]')];
    return buttons.filter(element => getComputedStyle(element).userSelect !== 'none').map(element => element.outerHTML);
  })()`);
  assert.deepEqual(selectableButtons, [], 'all button labels, including nested content and dynamic dialogs, must be unselectable');
  assert.notEqual(await window.webContents.executeJavaScript('getComputedStyle(document.querySelector("#prompt")).userSelect'), 'none', 'the composer keeps text selection');
  console.log('Button text selection disabled throughout Harness');
  const closeAnswer = confirmation.ask({ title: 'Remove provider?', message: 'Remove this provider from Harness settings?',
    confirmLabel: 'Remove', cancelLabel: 'Keep provider', danger: true });
  await waitForDialog();
  assert.equal(await window.webContents.executeJavaScript('document.activeElement.textContent'), 'Keep provider');
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/confirmation-provider.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript('document.querySelector(".confirmation-close").click(); true');
  assert.equal(await closeAnswer, false);
  const errorWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await errorWindow.loadFile(path.resolve(__dirname, '../ui/startup-error.html'), { query: { message: '<test> startup failure' } });
  assert.equal(await errorWindow.webContents.executeJavaScript('document.querySelector(".confirmation-dialog").open'), true);
  assert.equal(await errorWindow.webContents.executeJavaScript('document.querySelector("#confirmation-description").textContent'), '<test> startup failure');
  assert.equal(await errorWindow.webContents.executeJavaScript('document.activeElement.textContent'), 'Close Harness');
  errorWindow.destroy();
  console.log('Styled clear/provider/startup dialogs, cancel defaults, Escape and visible cursor styles passed');
  phase = 'asynchronous chat under fake worker output';
  const ownerChat = agents.conversation(controller, true);
  ownerChat.queue = []; ownerChat.queuePaused = true; ownerChat.error = null;
  controller.busy = null;
  const background = [];
  for (let index = 0; index < 2; index++) {
    const profile = await agents.saveAgent({ name: `Builder ${index + 1}`, instructions: 'Fake build fixture.', workspace: root, access: ownerChat.access, mode: 'auto' });
    const worker = agents.controller(profile.id);
    await agents.initializeController(worker);
    const chat = agents.conversation(worker, true);
    chat.title = `Build game ${index + 1}`; chat.status = 'running'; worker.busy = chat.id;
    chat.delegation = { id: `fake-job-${index}`, source: ownerChat.id, state: 'running', startIndex: 0, delivered: false };
    chat.items.push({ id: `fake-output-${index}`, type: 'commandExecution', command: 'Fake build',
      status: 'inProgress', aggregatedOutput: 'Background output\n'.repeat(2000) });
    background.push({ worker, chat });
  }
  const publish = () => window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  phase = 'async fixture publishing';
  await publish();
  await window.webContents.executeJavaScript('selectAgent("main")');
  background[0].chat.capacityWaiting = true;
  await publish();
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-activity-list").textContent'), /Builder 1 · Queued/);
  delete background[0].chat.capacityWaiting;
  background[0].chat.delegation.quotaPause = { reason: 'Background work paused: ChatGPT reported 92% usage (background threshold 90%).' };
  await publish();
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-activity-list").textContent'), /Builder 1 · Paused.*92%.*90%/s);
  delete background[0].chat.delegation.quotaPause;
  background[0].chat.delegation.state = 'revising';
  background[0].chat.delegation.amendments = [{ id: 'ui-change', text: 'Use a blue background.', revision: 2, state: 'received' }];
  await publish();
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-activity-list").textContent'), /Updating….*Change received · revision 2/s);
  background[0].chat.delegation.state = 'running';
  background[0].chat.delegation.amendments[0].state = 'applied';
  await publish();
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-activity-list").textContent'), /Change applied · revision 2/);
  delete background[0].chat.delegation.amendments;
  const updateReceipt = { id: 'ui-update-receipt', type: 'agentMail', localOnly: true, kind: 'note', fromName: 'You',
    text: 'Use a blue background.', amendment: { id: 'ui-change', revision: 2, state: 'received' } };
  background[0].chat.items.push(updateReceipt);
  const workerQueue = background[0].chat.queue, workerProvider = background[0].chat.activeProvider;
  background[0].chat.queue = [{ id: 'ui-direct-change', text: 'Use blue.', images: [] }];
  background[0].chat.activeProvider = 'native:deepseek';
  await publish();
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(background[0].worker.agentId) + ')');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".queue-steer").textContent'), 'Send now');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".queue-steer").disabled'), false);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#messages").textContent'), /Assignment update from You · Received · revision 2/);
  updateReceipt.amendment.state = 'applied';
  await publish();
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#messages").textContent'), /Assignment update from You · Applied · revision 2/);
  background[0].chat.items = background[0].chat.items.filter(item => item !== updateReceipt);
  background[0].chat.queue = workerQueue; background[0].chat.activeProvider = workerProvider;
  await window.webContents.executeJavaScript('selectAgent("main")');
  const originalQueue = ownerChat.queue, originalPause = ownerChat.queuePaused;
  ownerChat.queuePaused = true;
  ownerChat.queue = Array.from({ length: 10 }, (_, i) => ({ id: `full-${i}`, text: 'Queued user message', images: [] }));
  const deferredResult = { id: 'deferred-fixture', type: 'agentResult', localOnly: true, text: 'Saved build evidence.',
    agentName: 'Builder 1', ownerName: 'Hub', status: 'completed', pendingReply: { id: 'deferred-fixture', agentReply: true } };
  const fixtureArtifact = { id: 'game', scopeId: 'split-assignment', version: 3, kind: 'program',
    path: 'Game <img src=x onerror=alert(1)>.exe', label: 'Game', workspace: root };
  deferredResult.artifacts = [fixtureArtifact];
  const artifactCalls = [], stoppedRuns = [];
  ipcMain.handle('artifactAction', (_event, args) => { artifactCalls.push(args); return { status: 'opened' }; });
  ipcMain.handle('stopArtifactRun', async (_event, id) => {
    stoppedRuns.push(id); await agents.artifactRuns.stop(id); await publish();
  });
  ownerChat.items.push(deferredResult);
  await publish();
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-activity-summary").textContent'), /1 result waiting/);
  assert.equal(artifactCalls.length, 0, 'rendering a result cannot launch an artifact');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".artifact-path img")'), null);
  assert.match(await window.webContents.executeJavaScript('document.querySelector(".artifact-list").textContent'), /Files available/);
  await window.webContents.executeJavaScript(`document.querySelector('.artifact-row button').click(); true`);
  await until(() => artifactCalls.length === 1, 'artifact folder action reaches the runner');
  await window.webContents.executeJavaScript(`document.querySelector('.artifact-row button:last-child').click(); true`);
  await until(() => artifactCalls.length === 2, 'artifact Run is explicit');
  assert.deepEqual(artifactCalls, ['folder', 'run'].map(action => ({ action, sessionId: ownerChat.id,
    receiptId: deferredResult.id, artifactId: 'game', expectedVersion: 3 })));
  const fixtureRunId = '00000000-0000-4000-8000-000000000001';
  agents.artifactRuns.runs.set(fixtureRunId, { id: fixtureRunId, label: 'Game', path: 'game.exe', workspace: root, child: null });
  await publish();
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-activity-summary").textContent'), /1 running test/);
  await window.webContents.executeJavaScript(`document.querySelector('.artifact-run button').click(); true`);
  await until(() => stoppedRuns.length === 1 && !agents.artifactRuns.busy, 'test Stop uses its stable run ID');
  assert.deepEqual(stoppedRuns, [fixtureRunId]);
  ownerChat.items = ownerChat.items.filter(item => item !== deferredResult);
  ownerChat.queue = originalQueue; ownerChat.queuePaused = originalPause;
  await publish();
  phase = 'queued assignment and mailbox UI';
  const queuedJob = { id: 'fake-queued-job', source: ownerChat.id, state: 'queued', access: ownerChat.access,
    title: 'Build game three', task: 'Queued game request', delivered: false };
  background[1].chat.delegationQueue = [queuedJob];
  await publish();
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(background[1].worker.agentId) + ')');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-activity-list").textContent'), /Owner: Hub.*Open owner/s);
  await window.webContents.executeJavaScript('selectAgent("main")');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-activity-list").textContent'), /Builder 2 · Queued.*Owner: Hub · Build game three/s);
  background[1].chat.delegation.owner = background[0].chat.id;
  const ownershipReceipt = { id: 'fake-owner-handoff', type: 'agentMail', kind: 'note', localOnly: true,
    fromName: 'Hub', text: 'Hub handed result ownership to Builder 1.',
    handoff: { jobId: background[1].chat.delegation.id, state: 'committed', ownerId: background[0].worker.agentId } };
  ownerChat.items.push(ownershipReceipt);
  await publish();
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-activity-list").textContent'), /Owner: Builder 1.*Open owner/s);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#messages").textContent'), /Result ownership handoff · Recorded/);
  await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('#messages button')].find(button => button.textContent === 'Open receiving chat');
    if (!button) throw new Error('Missing handoff navigation');
    button.click();
    return new Promise(resolve => setTimeout(resolve, 50));
  })()`);
  assert.equal(await window.webContents.executeJavaScript('selectedAgent'), background[0].worker.agentId);
  delete background[1].chat.delegation.owner;
  ownerChat.items = ownerChat.items.filter(item => item !== ownershipReceipt);
  await publish();
  await window.webContents.executeJavaScript('selectAgent("main")');
  let stoppedQueued;
  ipcMain.removeHandler('stop');
  ipcMain.handle('stop', async (_event, id) => {
    if (id === queuedJob.id) { stoppedQueued = id; await agents.stop(id); }
    else stoppedAgent = agents.owner(id).agentId;
  });
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#job-activity').open = true;
    const row = [...document.querySelectorAll('#job-activity-list .job-row')].find(row => row.textContent.includes('Build game three'));
    row.querySelector('button:last-child').click();
  })()`);
  await until(() => stoppedQueued === queuedJob.id && queuedJob.delivered, 'queued Stop uses the assignment ID');
  assert.equal(background[1].worker.busy, background[1].chat.id, 'queued Stop keeps the recipient’s active task running');
  background[1].worker.activeTurns.set(background[1].chat.id, 'fake-active-turn');
  const mail = agents.sendMessage(background[1].worker, background[1].chat,
    { agentId: 'main', messageId: 'ui-question', kind: 'question', text: 'Which format? <img src=x onerror=alert(1)>' });
  background[1].worker.activeTurns.delete(background[1].chat.id);
  await publish();
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#messages").textContent'), /Question from Builder 2 · Received/);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#messages img")'), null);
  await window.webContents.executeJavaScript(`(() => {
    const panel = [...document.querySelectorAll('#messages details')].find(panel => panel.textContent.includes('Which format?'));
    panel.open = true;
    if (!panel.textContent.includes('Which format? <img')) throw new Error('Mailbox text was not retained safely');
  })()`);
  ownerChat.items = ownerChat.items.filter(item => item.id !== mail.messageId && item.deliveryId !== queuedJob.id);
  ownerChat.queue = []; background[1].chat.delegationQueue = [];
  await publish();
  await window.webContents.executeJavaScript('document.querySelector("#prompt").value = "Build notes: "; document.querySelector("#prompt").dispatchEvent(new Event("input", { bubbles: true })); document.querySelector("#toast").hidden = true; true');
  const samples = { baselineInput: [], loadedInput: [], navigation: [], receipt: [], eventDisplay: [], stopFeedback: [] };
  const inputSample = async list => {
    list.push(await window.webContents.executeJavaScript(`(async () => {
      const input = document.querySelector('#prompt'), start = performance.now();
      input.focus(); input.value += 'x'; input.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(requestAnimationFrame);
      if (document.activeElement !== input || !input.value.endsWith('x')) throw new Error('Typing lost focus or text');
      return performance.now() - start;
    })()`));
  };
  phase = 'async baseline typing';
  for (let index = 0; index < 20; index++) await inputSample(samples.baselineInput);
  await window.webContents.executeJavaScript('document.querySelector("#job-activity").open = true; true');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-activity-summary").textContent'), /2 background tasks.*Owner: Hub/);
  const flood = setInterval(() => {
    for (const { chat } of background) chat.items[0].aggregatedOutput += 'More build output\n'.repeat(100);
    window.webContents.send('state', agents.snapshot());
  }, 30);
  try {
    phase = 'async loaded typing and navigation';
    for (let index = 0; index < 20; index++) {
      await inputSample(samples.loadedInput);
      const navigationStart = performance.now();
      await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(background[0].worker.agentId) + ')');
      await window.webContents.executeJavaScript('selectAgent("main")');
      samples.navigation.push(performance.now() - navigationStart);
      assert.ok(background.every(({ worker, chat }) => worker.busy === chat.id), 'navigation leaves both workers active');
    }
    controller.busy = ownerChat.id;
    phase = 'async persisted receipts';
    for (let index = 0; index < 20; index++) {
      const receiptStart = performance.now();
      const receipt = await controller.send({ id: ownerChat.id, text: `Make game two cooperative ${index}`, task: 'off' });
      samples.receipt.push(performance.now() - receiptStart);
      assert.equal(receipt.queued, true);
      const stored = JSON.parse(fs.readFileSync(controller.filename, 'utf8')).sessions.find(chat => chat.id === ownerChat.id);
      assert.match(stored.queue.at(-1).text, /Make game two cooperative/);
      ownerChat.queue.pop();
    }
    ownerChat.queue.push({ id: 'fake-correction', text: 'Make game two cooperative', images: [], mode: 'auto' });
    controller.save();
    await publish();
    assert.match(await window.webContents.executeJavaScript('document.querySelector("#message-queue").textContent'), /Queued: Make game two cooperative/);
    assert.doesNotMatch(await window.webContents.executeJavaScript('document.querySelector("#message-queue").textContent'), /Applied/);
    for (let index = 0; index < 20; index++) {
      background[0].chat.title = `Build game one · update ${index}`;
      phase = 'async job event display';
      const eventStart = performance.now();
      window.webContents.send('state', agents.snapshot());
      await until(async () => (await window.webContents.executeJavaScript('document.querySelector("#job-activity-list").textContent')).includes(`update ${index}`), 'job event reaches the UI');
      samples.eventDisplay.push(performance.now() - eventStart);
    }
    await window.webContents.executeJavaScript('document.querySelector("#job-activity").open = true; true');
    phase = 'async Stop feedback';
    window.setSize(840, 640);
    await window.webContents.executeJavaScript('document.documentElement.style.setProperty("--font-scale", "1.5"); true');
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      return [...document.querySelectorAll('#job-activity-list button')].every(button => {
        const box = button.getBoundingClientRect();
        return box.left >= 0 && box.right <= innerWidth;
      });
    })()`), true, 'task actions fit a narrow window with large text');
    window.setSize(1320, 900);
    await window.webContents.executeJavaScript('document.documentElement.style.setProperty("--font-scale", "1"); true');
    const draftBeforeStop = await window.webContents.executeJavaScript('document.querySelector("#prompt").value');
    for (let index = 0; index < 20; index++) {
      background[1].chat.delegation.id = `fake-stop-${index}`;
      await publish();
      samples.stopFeedback.push(await window.webContents.executeJavaScript(`(async () => {
        const button = document.querySelectorAll('#job-activity-list .job-row button:last-child')[1];
        const start = performance.now(); button.click();
        await new Promise(requestAnimationFrame);
        if (!button.disabled || button.textContent !== 'Stopping…') throw new Error('Stop gave no immediate feedback');
        return performance.now() - start;
      })()`));
    }
    await until(() => stoppedAgent === background[1].worker.agentId, 'Stop targets game two directly');
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), draftBeforeStop);
  } finally { clearInterval(flood); }
  ownerChat.queue = []; ownerChat.queuePaused = true;
  phase = 'async returned reports';
  for (let index = 0; index < background.length; index++) {
    const { worker, chat } = background[index];
    worker.busy = null; chat.status = index ? 'interrupted' : 'completed';
    chat.delegation.cancelled = !!index;
    chat.items.push({ id: `fake-result-${index}`, type: 'agentMessage', text: index ? 'Stopped safely.' : 'Game one is ready for review. <img src=x onerror=alert(1)>' });
    agents.deliver(worker, chat);
  }
  await publish();
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".job-result").length'), 2);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#messages").textContent'), /Builder 1 · Result received/);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#messages").textContent'), /Builder 2 · Cancelled/);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".job-result img")'), null, 'reports are untrusted text');
  assert.ok(controller.busy, 'reports appear before their busy owner can resume');
  window.setSize(840, 640);
  await window.webContents.executeJavaScript('document.documentElement.style.setProperty("--font-scale", "1.5"); true');
  const activityFits = await window.webContents.executeJavaScript(`(() => {
    const box = document.querySelector('#job-activity').getBoundingClientRect();
    return box.left >= 0 && box.right <= innerWidth;
  })()`);
  assert.equal(activityFits, true, 'activity remains reachable in a narrow window with large text');
  window.setSize(1320, 900);
  await window.webContents.executeJavaScript('document.documentElement.style.setProperty("--font-scale", "1"); true');
  phase = 'async screenshot';
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/async-chat.png'), (await window.webContents.capturePage()).toPNG());
  const p95 = list => [...list].sort((a, b) => a - b)[Math.ceil(list.length * 0.95) - 1];
  const latency = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, { count: values.length, p95Ms: p95(values) }]));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/async-chat-latency.json'), JSON.stringify({ measuredAt: new Date().toISOString(), fakeWorkers: 2, modelLatency: 'Not measured; no inference', latency }, null, 2));
  assert.ok(latency.loadedInput.p95Ms < 100, `Input p95 ${latency.loadedInput.p95Ms} ms exceeds 100 ms`);
  assert.ok(latency.navigation.p95Ms < 100, `Navigation p95 ${latency.navigation.p95Ms} ms exceeds 100 ms`);
  assert.ok(latency.receipt.p95Ms < 250, `Receipt p95 ${latency.receipt.p95Ms} ms exceeds 250 ms`);
  assert.ok(latency.eventDisplay.p95Ms < 500, `Event p95 ${latency.eventDisplay.p95Ms} ms exceeds 500 ms`);
  assert.ok(latency.stopFeedback.p95Ms < 100, 'Stop feedback exceeds 100 ms');
  console.log('Async handoffs, saved reports, queued corrections and background-load latency passed:', JSON.stringify(latency));
  phase = 'separate foreground and assignment details';
  const splitProfile = await agents.saveAgent({ name: 'Split bot', instructions: 'Private protocol fixture.', workspace: root,
    access: ownerChat.access, mode: 'auto' });
  const foreground = agents.controller(splitProfile.id), execution = agents.execution(splitProfile.id);
  await agents.initializeController(foreground); await agents.initializeController(execution);
  execution.connection = 'disconnected';
  const foregroundChat = agents.conversation(foreground, true), assignment = agents.conversation(execution, true);
  assignment.delegation = { id: 'split-assignment', revision: 1, source: ownerChat.id, owner: ownerChat.id,
    state: 'queued', access: assignment.access, task: 'Private fixture assignment', title: 'Build a game', startIndex: 0, delivered: false };
  assignment.delegation.artifacts = [fixtureArtifact];
  agents.budgets.register(assignment.delegation, ownerChat); agents.budgets.persist();
  const timeBudget = agents.budgets.forJob(assignment.delegation), budgetCalls = [];
  ipcMain.handle('jobBudget', async (_event, args) => {
    budgetCalls.push(args); const result = agents.budgets.update(args); await publish(); return result;
  });
  assignment.items.push({ type: 'agentMessage', text: 'Saved evidence <img src=x onerror=alert(1)>' });
  assignment.status = 'running'; execution.busy = assignment.id;
  ipcMain.handle('reviseJob', async (_event, args) => { const result = agents.reviseUserJob(args); await publish(); return result; });
  const answers = [];
  ipcMain.handle('answer', async (_event, id, answer, agentId, contextId) => {
    answers.push({ id, answer, agentId, contextId }); execution.requests.delete(id); await publish();
  });
  await publish();
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(splitProfile.id) + ')');
  const foregroundState = await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#prompt').value = 'Keep my question';
    document.querySelector('#prompt').dispatchEvent(new Event('input'));
    document.querySelector('#job-activity').open = true;
    document.querySelector('#job-activity-list .job-row button').click();
    return { busy: state.busy, selectedId, ready: !document.querySelector('#send').disabled,
      modal: document.querySelector('#job-dialog').matches(':modal'), details: document.querySelector('#job-dialog').open };
  })()`);
  assert.equal(foregroundState.busy, null);
  assert.equal(foregroundState.selectedId, foregroundChat.id);
  assert.equal(foregroundState.ready, true);
  assert.equal(foregroundState.details, true);
  assert.equal(foregroundState.modal, false, 'assignment details do not trap foreground input');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-artifacts").textContent'), /Open folder.*Run/s);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-artifacts img")'), null);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-budget-summary").textContent'), /120 min/);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-budget-usage").textContent'), /Reported tokens: Not reported\. Provider estimate: Not reported/);
  timeBudget.requests['cost-fixture'] = { id: 'cost-fixture', kind: 'worker', provider: 'claude-cli', complete: true,
    usage: { inputTokens: 125, cachedInputTokens: 20, outputTokens: 10, totalTokens: 135 }, providerEstimateUsd: 0.0031 };
  agents.primary.save(); await publish();
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-budget-usage").textContent'), /Reported tokens: 135\. Provider estimate: \$0\.0031/);
  await window.webContents.executeJavaScript(`document.querySelector('#job-budget').open = true;
    document.querySelector('#job-budget-limit').value = '5';
    document.querySelector('#job-budget-attempts').value = '25';
    document.querySelector('#job-budget-tokens').value = '500';
    document.querySelector('#job-budget-limit').dispatchEvent(new Event('input'));
    document.querySelector('#job-budget-form').dispatchEvent(new Event('submit', { cancelable: true })); true`);
  await until(() => budgetCalls.length === 1 && timeBudget.limitMs === 300000, 'time limit saves by explicit action');
  assert.deepEqual(budgetCalls[0], { jobId: timeBudget.id, expectedVersion: 1, limitMinutes: 5, limitAttempts: 25, limitTokens: 500, resume: false });
  for (let i = 0; i < 100 && await window.webContents.executeJavaScript('!!viewedJob.budgetPending'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#job-budget-save'); button.scrollIntoView({ block: 'nearest' });
    const box = button.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('#job-budget-save') === button;
  })()`), true, 'the expanded budget form retains a reachable Save button');
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const summary = document.querySelector('#job-budget-summary'), box = summary.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('summary') === summary;
  })()`), true, 'the budget disclosure remains reachable after scrolling to its controls');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/job-budget.png'), (await window.webContents.capturePage()).toPNG());
  execution.busy = null; agents.budgets.refresh();
  timeBudget.state = 'paused'; timeBudget.usedMs = timeBudget.limitMs; timeBudget.version++;
  timeBudget.reason = 'Active-time budget reached. Review the saved work and extend the limit to continue.';
  agents.primary.save(); await publish();
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-budget-save").textContent'), 'Resume');
  await window.webContents.executeJavaScript(`document.querySelector('#job-budget-limit').value = '6';
    document.querySelector('#job-budget-limit').dispatchEvent(new Event('input'));
    document.querySelector('#job-budget-form').dispatchEvent(new Event('submit', { cancelable: true })); true`);
  await until(() => budgetCalls.length === 2 && timeBudget.state === 'active', 'budget Resume is an explicit separate action');
  assert.equal(budgetCalls[1].resume, true);
  assert.equal(timeBudget.usedMs, 300000, 'the UI cannot reset the consumed allowance');
  execution.busy = assignment.id;
  await window.webContents.executeJavaScript('document.querySelector("#job-budget").open = false; true');
  const sendIsReachable = () => window.webContents.executeJavaScript(`(() => {
    const send = document.querySelector('#send'), box = send.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('#send') === send;
  })()`);
  assert.equal(await sendIsReachable(), true, 'details reserve space instead of covering the Send button');
  window.setSize(840, 640);
  await window.webContents.executeJavaScript('document.documentElement.style.setProperty("--font-scale", "1.5"); true');
  assert.equal(await sendIsReachable(), true, 'foreground Send remains reachable beside details in a narrow window');
  window.setSize(1320, 900);
  await window.webContents.executeJavaScript('document.documentElement.style.setProperty("--font-scale", "1"); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-details-log img")'), null);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-details-log").textContent'), /<img src=x/);
  await window.webContents.executeJavaScript(`document.querySelector('#job-update-text').value = 'Use keyboard controls.';
    document.querySelector('#job-update-form').dispatchEvent(new Event('submit', { cancelable: true })); true`);
  await until(() => assignment.delegation.revision === 2, 'the details update was accepted');
  for (let i = 0; i < 100 && !await window.webContents.executeJavaScript('document.querySelector("#job-update-feedback").textContent.startsWith("Received")'); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-update-feedback").textContent'), /^Received/);
  assignment.delegation.amendments[0].state = 'applied';
  await publish();
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-update-feedback").textContent'), /^Applied/);
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/foreground-job-details.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript('document.querySelector("#job-update-text").value = "unsent update"; document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-dialog").open'), false);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Keep my question');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-activity-list .job-row button").click(); document.querySelector("#job-update-text").value'), 'unsent update', 'reopening assignment details keeps the unsent update');
  await window.webContents.executeJavaScript(`document.querySelector('#job-activity-list .job-row button').click();
    document.querySelector('#prompt').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-dialog").open'), false, 'outside input dismisses assignment details');
  assignment.delegation.state = 'running';
  execution.requests.set(7, { id: 7, method: 'item/commandExecution/requestApproval',
    params: { threadId: 'split-thread', command: 'Private fixture check', reason: 'Review this background action.' } });
  await publish();
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#request-dialog").open'), false,
    'a background approval cannot open a modal over chat by itself');
  await window.webContents.executeJavaScript(`document.querySelector('#job-activity').open = true;
    [...document.querySelectorAll('#job-activity-list button')].find(button => button.textContent === 'Review').click(); true`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#request-dialog").open'), true);
  const deferred = await window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('#request-dialog'), cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel); if (!cancel.defaultPrevented) dialog.close(); return !cancel.defaultPrevented;
  })()`);
  assert.equal(deferred, true, 'background approvals can be deferred through Escape');
  assert.equal(execution.requests.size, 1, 'deferring an approval does not silently allow or reject it');
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('#job-activity-list button')].find(button => button.textContent === 'Review').click();
    true`);
  assert.equal(await window.webContents.executeJavaScript('document.activeElement.textContent'), 'Allow once');
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  await until(() => answers.length === 1, 'the background approval reached its controller');
  assert.deepEqual(answers[0], { id: 7, answer: { decision: 'accept' }, agentId: splitProfile.id, contextId: assignment.id });
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Keep my question');
  console.log('Separate foreground, nonmodal assignment details, received/applied updates and deferred scoped approvals passed');
  timeBudget.limitTokens = null;
  timeBudget.requests['unknown-cost-fixture'] = { id: 'unknown-cost-fixture', kind: 'worker', provider: 'native:deepseek',
    complete: true, usage: null, providerEstimateUsd: null };
  ownerChat.items.push({ id: 'archived-assignment-result', type: 'agentResult', localOnly: true,
    deliveryId: 'replaced-assignment', agentId: splitProfile.id, agentName: 'Split bot', ownerName: 'Hub',
    title: 'Earlier assignment', status: 'completed', text: 'Retained report after the worker was reused.', budgetId: timeBudget.id });
  await publish(); await window.webContents.executeJavaScript('selectAgent("main")');
  await window.webContents.executeJavaScript(`(() => {
    const result = [...document.querySelectorAll('.job-result')].find(row => row.textContent.includes('Earlier assignment'));
    [...result.querySelectorAll('button')].find(button => button.textContent === 'Details').click();
  })()`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-dialog").open'), true);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-details-log").textContent'), /worker was reused/);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-budget-summary").textContent'), /6 min/);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-budget-usage").textContent'), /Reported tokens: 135 \(incomplete\)\. Provider estimate: \$0\.0031 \(incomplete\)/);
  await window.webContents.executeJavaScript('document.querySelector("#job-dialog .close-dialog").click(); true');
  console.log('Saved result details retain their report and shared budget after worker reuse');
  phase = 'direct tracked task details';
  const directTask = require('../src/tasks.cjs').createTask({ messageId: 'direct-ui-input',
    goal: 'Continue my direct task <img src=x onerror=alert(1)>', access: foregroundChat.access, checks: [] });
  Object.assign(directTask, { foreground: true, workspace: root, state: 'cancelled', budgetPaused: true,
    originalImageCount: 1, inputImages: ['data:image/png;base64,AA=='], startIndex: foregroundChat.items.length,
    requestedMode: 'auto', resumeJobId: require('node:crypto').randomUUID() });
  foregroundChat.tasks = [directTask];
  agents.budgets.register(directTask, foregroundChat);
  const directBudget = agents.budgets.forJob(directTask);
  Object.assign(directBudget, { state: 'paused', reason: 'Time limit reached. Review before continuing.', usedMs: 1000 });
  foregroundChat.queuePaused = true; foregroundChat.queuePauseBudgetId = directBudget.id;
  foreground.save(); agents.budgets.persist(); await publish();
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(splitProfile.id) + ')');
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#job-activity').open = true;
    const row = [...document.querySelectorAll('#job-activity-list .job-row')].find(row => row.textContent.includes('Continue my direct task'));
    row.querySelector('button').click();
  })()`);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-activity-summary").textContent'), /1 task/);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-update-form").hidden'), true);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-details-log").textContent'), /Original request.*Continue my direct task.*1 original image/s);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-details-log img")'), null);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-budget-save").textContent'), 'Resume');
  assert.equal(await sendIsReachable(), true);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/direct-task-budget.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('#job-budget').open = true;
    document.querySelector('#job-budget-form').dispatchEvent(new Event('submit', { cancelable: true })); true`);
  await until(() => directTask.resumedAsJobId === directTask.resumeJobId, 'direct-task Resume admits one private continuation');
  assert.equal(agents.findJob(directTask.resumeJobId).job.owner, foregroundChat.id);
  assert.equal(agents.findJob(directTask.resumeJobId).job.budgetId, directBudget.id);
  ipcMain.removeHandler('stop');
  let stoppedDirectTask;
  ipcMain.handle('stop', async (_event, id) => { stoppedDirectTask = id; await agents.stop(id); await publish(); });
  await window.webContents.executeJavaScript('document.querySelector("#job-dialog .close-dialog").click(); true');
  await publish();
  await window.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('#job-activity-list .job-row')].find(row => row.textContent.includes('Continue the saved direct task'));
    row.querySelector('button:last-child').click();
  })()`);
  await until(() => stoppedDirectTask === directTask.resumeJobId, 'the private continuation Stop uses its stable job identity');
  console.log('Direct tracked tasks expose a nonmodal Resume, preserve inputs and retain one result owner');
  phase = 'isolated workspace details';
  const preparedView = agents.snapshot(), previewCopy = { source: root, workspace: path.join(root, 'preview-project-copy'), state: 'preparing' };
  const previewJob = preparedView.executionStates[splitProfile.id].sessions.find(chat => chat.id === assignment.id).delegation;
  previewJob.workspaceCopy = previewCopy;
  preparedView.jobWorkspaces[previewCopy.workspace] = previewCopy;
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(splitProfile.id) + ')');
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(preparedView) + '); true');
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#job-activity').open = true;
    const row = [...document.querySelectorAll('#job-activity-list .job-row')].find(row => row.textContent.includes('Build a game'));
    row.querySelector('button').click();
  })()`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-dialog").open'), true);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-details-status").textContent'), /Preparing workspace/);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-copy-location").textContent'), /preview-project-copy.*no automatic merge/s);
  assert.equal(await sendIsReachable(), true);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/isolated-job-workspace.png'), (await window.webContents.capturePage()).toPNG());
  previewCopy.state = 'failed'; previewCopy.error = previewJob.error = 'Missing project inputs. No worker was started.';
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(preparedView) + '); true');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-details-status").textContent'), /Needs review/);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-details-error").textContent'), /No worker was started/);
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#job-dialog').close();
    const row = [...document.querySelectorAll('#job-activity-list .job-row')].find(row => row.textContent.includes('Build a game'));
    row.querySelector('button').click();
  })()`);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(resolve))');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-dialog").open && !!viewedJob'), true, 'a queued close event cannot erase a reopened assignment');
  await window.webContents.executeJavaScript('document.querySelector("#job-dialog .close-dialog").click(); true');
  console.log('Workspace preparation and failures remain visible beside a usable chat composer');
  phase = 'restart reconciliation';
  const heldView = agents.snapshot(), reconcileCalls = [];
  ipcMain.handle('reconcileJob', async (_event, args) => { reconcileCalls.push(args); return { jobId: args.jobId, status: 'interrupted' }; });
  const heldJob = heldView.executionStates[splitProfile.id].sessions.find(chat => chat.id === assignment.id).delegation;
  Object.assign(heldJob, { state: 'interrupted', recovery: { previousState: 'running', kind: 'uncertain' } });
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(heldView) + '); true');
  await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#job-activity').open = true;
    const row = [...document.querySelectorAll('#job-activity-list .job-row')].find(row => row.textContent.includes('Build a game'));
    row.querySelector('button').click();
  })()`);
  const recoveryView = () => window.webContents.executeJavaScript(`({ shown: !document.querySelector('#job-recovery').hidden,
    start: !document.querySelector('#job-recovery-start').hidden, text: document.querySelector('#job-recovery-text').textContent })`);
  let held = await recoveryView();
  assert.deepEqual([held.shown, held.start], [true, false], 'uncertain work offers no rerun');
  assert.match(held.text, /may have changed files or run commands/);
  Object.assign(heldJob, { recovery: { previousState: 'queued', kind: 'not-started' }, recoveryVersion: 1 });
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(heldView) + '); true');
  held = await recoveryView();
  assert.deepEqual([held.shown, held.start], [true, true]);
  assert.match(held.text, /before this assignment started/);
  await window.webContents.executeJavaScript('document.querySelector("#job-recovery-return").click(); true');
  await until(() => reconcileCalls.length === 1, 'Return reaches the runner');
  assert.deepEqual(reconcileCalls[0], { jobId: 'split-assignment', action: 'return' });
  assert.equal(await sendIsReachable(), true);
  await window.webContents.executeJavaScript('document.querySelector("#job-dialog .close-dialog").click(); true');
  console.log('Restart-held assignments show the exact decision, and uncertain work offers no rerun');
  phase = 'batch report and host verification';
  const proof = require('../src/job-reports.cjs').verification({ checks: [{ id: 'compiler', name: 'Compiler', kind: 'build', argv: ['fixture-build'], cwd: root }],
    attempts: [{ assignmentId: 'report-proof', assignmentRevision: 1, at: 100, results: [{ id: 'compiler', status: 'passed', exitCode: 0 }] }] }, { id: 'report-proof', revision: 1 });
  ownerChat.items.push({ id: 'batch-request', type: 'userMessage', content: [{ type: 'text', text: 'Make four games.' }],
    hubBatch: { id: 'ui-batch', count: 4, dispatched: 3 } });
  ownerChat.items.push({ id: 'verified-report', type: 'agentResult', localOnly: true, deliveryId: 'report-proof', agentId: splitProfile.id,
    agentName: 'Checked builder', ownerId: 'main', ownerName: 'Hub', title: 'First output', text: 'Source output available.', status: 'completed',
    verification: proof, workspaceCopy: { source: root, workspace: path.join(root, 'first-copy') } });
  const reportView = agents.snapshot();
  reportView.batchReports['ui-batch'] = { id: 'ui-batch', sessionId: ownerChat.id, requestId: 'batch-request', requested: 4, dispatched: 3, returned: 2,
    summary: '1 returned, checks passed · 1 failed · 1 waiting · 1 not dispatched', entries: [
      { index: 1, jobId: 'report-proof', name: 'Checked builder', owner: 'Hub', state: 'returned', workspace: path.join(root, 'first-copy'), verification: proof, text: 'Output <img src=x onerror=alert(1)>' },
      { index: 2, name: 'Second builder', owner: 'Hub', state: 'failed', error: 'Compiler failed.' },
      { index: 3, name: 'Third builder', owner: 'Hub', state: 'running' },
      { index: 4, name: 'Fourth builder', state: 'not-dispatched', error: 'Worker unavailable.' },
    ] };
  await window.webContents.executeJavaScript('selectAgent("main")');
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(reportView) + '); true');
  await window.webContents.executeJavaScript(`(() => {
    const button = [...document.querySelectorAll('#job-activity-list button')].find(button => button.textContent === 'Batch report');
    button.click(); document.querySelector('#prompt').value = 'Keep my next question';
    document.querySelector('#prompt').dispatchEvent(new Event('input'));
  })()`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".batch-report").open'), true);
  assert.equal(await window.webContents.executeJavaScript('document.querySelectorAll(".batch-entry").length'), 4);
  assert.match(await window.webContents.executeJavaScript('document.querySelector(".batch-report").textContent'), /4 jobs: 1 returned, checks passed · 1 failed · 1 waiting · 1 not dispatched.*Compiler failed.*Not dispatched/s);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-activity-summary").textContent'),
    /Batch report · 1 returned, checks passed · 1 failed · 1 waiting · 1 not dispatched/);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".batch-entry [data-kind=build]").textContent'), 'Check passed');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".batch-entry [data-kind=launch]").textContent'), 'Not verified');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".batch-report img")'), null);
  await window.webContents.executeJavaScript('document.querySelector(".batch-entry button").click(); true');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-verification").textContent'), /Build: Check passed.*Gameplay: Not verified/s);
  assert.equal(await sendIsReachable(), true);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Keep my next question');
  await window.webContents.executeJavaScript(`document.querySelector('#job-dialog .close-dialog').click();
    document.querySelector('.batch-report').scrollIntoView({ block: 'start', behavior: 'instant' }); true`);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/batch-report.png'), (await window.webContents.capturePage()).toPNG());
  console.log('Batch reports retain partial outcomes, host evidence and a usable chat composer');
  phase = 'group chat controls';
  const groupMember = agents.primary.data.agents[0];
  await window.webContents.executeJavaScript(`document.querySelector('#agents-overview').click();
    document.querySelector('#groups-add').click();
    document.querySelector('#group-name').value = 'Game team';
    document.querySelector('#group-members input').checked = true;
    document.querySelector('#group-form').requestSubmit(); true`);
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 80))');
  const group = controller.data.sessions.find(chat => chat.group && chat.title === 'Game team');
  assert.ok(group);
  assert.equal(await window.webContents.executeJavaScript('selectedId'), group.id);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#session-title").textContent'), 'Game team');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#group-owner").hidden'), false);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-activity").hidden'), true, 'unrelated Hub work stays out of the group activity');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#main-agent-list button").getAttribute("aria-pressed")'), 'false');
  await window.webContents.executeJavaScript(`document.querySelector('#prompt').value = 'Review this design';
    document.querySelector('#group-mention').value = ${JSON.stringify(groupMember.id)};
    document.querySelector('#group-mention').dispatchEvent(new Event('change')); true`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '@' + groupMember.name + ' Review this design');
  await publish();
  assert.equal(await window.webContents.executeJavaScript('selectedId'), group.id, 'state updates keep the group selected');
  await window.webContents.executeJavaScript('selectAgent("main")');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#group-mention").hidden'), true);
  await window.webContents.executeJavaScript('document.querySelector("#group-list button").click(); true');
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 40))');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '@' + groupMember.name + ' Review this design', 'group draft survives switching');
  await window.webContents.executeJavaScript(`document.querySelector('#group-edit').click();
    document.querySelector('#group-name').value = 'Game team updated'; document.querySelector('#group-form').requestSubmit(); true`);
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 50))');
  assert.equal(group.title, 'Game team updated');
  assert.equal(await sendIsReachable(), true);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/group-chat.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('#group-edit').click();
    document.querySelector('#group-archive').click(); true`);
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 50))');
  assert.equal(group.archived, true);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#group-section").hidden'), true);
  console.log('Group creation, targeted mention controls, preserved drafts, edits and archive passed');
  phase = 'routines are chat-only';
  // Routines are created, changed and removed only by asking in chat; nothing in the UI or the IPC exposes them.
  const routineUi = await window.webContents.executeJavaScript(`({
    elements: ['#routines-dialog', '#routine-open', '#routine-activity', '#routine-manage', 'script[src="routines.js"]']
      .filter(selector => document.querySelector(selector)),
    repeat: [...document.querySelectorAll('button')].filter(button => button.textContent.trim() === 'Repeat').length,
    bridge: typeof window.router?.send === 'function',
    api: ['routineSave', 'routineChange'].filter(name => typeof window.router[name] === 'function'),
  })`);
  assert.deepEqual(routineUi, { elements: [], repeat: 0, bridge: true, api: [] }, 'no routine dialog, button, status row, Repeat action or IPC remains');
  console.log('Routines have no UI or IPC surface passed');
  await documents.close();
  await window.webContents.executeJavaScript(`document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    document.documentElement.style.setProperty('--font-scale', '1');
    document.querySelector('#prompt').value = 'Zoom check'; renderSendButton(); true`);
  let zoomPercent = 100;
  for (const percent of [50, 115, 300]) {
    while (zoomPercent !== percent) {
      const direction = percent > zoomPercent ? 5 : -5;
      window.webContents.emit('before-input-event', { preventDefault() {} },
        { type: 'keyDown', control: true, key: direction > 0 ? '+' : '-' });
      zoomPercent += direction;
    }
    assert.ok(Math.abs(window.webContents.getZoomFactor() - percent / 100) < .001);
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    const zoomLayout = await window.webContents.executeJavaScript(`(() => {
      const icons = ['.composer-access svg', '#chat-options summary svg', '#dictate svg', '#send svg']
        .map(selector => document.querySelector(selector).getBoundingClientRect().width);
      const send = document.querySelector('#send').getBoundingClientRect();
      const gear = document.querySelector('#chat-options summary svg').getBoundingClientRect();
      const microphone = document.querySelector('#dictate svg').getBoundingClientRect();
      const attach = document.querySelector('#attach-files').getBoundingClientRect();
      const shield = document.querySelector('.composer-access').getBoundingClientRect();
      const rightGapDifference = Math.abs((microphone.left - gear.right) - (send.left - microphone.right));
      const leftGap = shield.left - attach.right;
      const sizeRatio = send.width / attach.width;
      const plus = document.querySelector('#attach-files svg').getBoundingClientRect().width;
      return { icons, plus, rightGapDifference, leftGap, sizeRatio, plusFont: parseFloat(getComputedStyle(document.querySelector('#attach-files')).fontSize),
        fits: send.right <= innerWidth && send.bottom <= innerHeight,
        fontScale: document.documentElement.style.getPropertyValue('--font-scale') };
    })()`);
    assert.ok(zoomLayout.icons.every(size => Math.abs(size - 15) < .1), 'other composer icons have equal CSS size at every zoom: ' + JSON.stringify(zoomLayout));
    assert.ok(Math.abs(zoomLayout.plus - zoomLayout.plusFont * .75) < .1, 'plus icon is 25% smaller');
    assert.equal(zoomLayout.fits, true, 'composer controls remain inside the zoomed window');
    assert.ok(zoomLayout.rightGapDifference < 1, 'visible gaps between gear, microphone and Send are equal');
    assert.ok(Math.abs(zoomLayout.leftGap) < 1, 'shield sits next to plus without extra gap');
    assert.ok(Math.abs(zoomLayout.sizeRatio - 5 / 6) < .01, 'other buttons shrink by one-sixth while plus stays unchanged');
    assert.equal(zoomLayout.fontScale, '1', 'whole-page zoom does not also multiply text size');
  }
  console.log('Whole-interface zoom at 50%, 115%, 300% and consistent composer icons passed');
  agents.closing = true;
  agents.budgets.close();
  for (const c of agents.allControllers()) c.close();
  window.destroy();
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(`UI smoke failed during ${phase}:`, error.stack); app.exit(1); });
// Chromium still owns files here during shutdown; cleanup is left to the temp directory.
