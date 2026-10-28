const { readSessionData } = require('../src/session-store.cjs');
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
fs.mkdirSync(path.resolve(__dirname, '../.scratch/mosaic'), { recursive: true });
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
  const linkedFiles = require('../src/workspace/linked-files.cjs');
  let browserAccessCall = false; // stands in for src/main.cjs's browserRequest check
  ipcMain.handle('linkImage', (_event, _id, target) => linkedFiles.image(root, target, browserAccessCall));
  ipcMain.handle('openFile', (_event, _id, target) => linkedFiles.open(root, target,
    browserAccessCall ? null : { openPath: async () => '', showItemInFolder: () => {} }));
  let previews = 0;
  ipcMain.handle('preview', () => { previews++; return { label: 'Auto', reason: 'Smoke test' }; });
  const imageRequests = [];
  ipcMain.handle('image', (_event, ...args) => { imageRequests.push(args); return 'data:image/jpeg;base64,/9j/4AAQ'; });
  ipcMain.handle('setAppearance', () => {});
  ipcMain.handle('replySuggestion', () => null);
  ipcMain.handle('benchmarkData', () => ({ data: { records: [] },
    summary: { records: 0, matched: 0, workers: 0, updatedAt: 'fixture', sources: [] } }));
  const sent = [];
  let failSend = false;
  ipcMain.handle('create', (_event, workspace, access) => controller.create(workspace, access));
  let voiceRequest = null, finishVoice = null, voiceAudio = null;
  ipcMain.handle('voiceInfo', () => ({ supported: true, language: 'Greek and English, detected each time', firstUse: false }));
  ipcMain.handle('voiceStart', (_event, request) => {
    voiceRequest = request;
    window.webContents.send('voice', { ...request, type: 'state', state: 'listening' });
    return { ...request, state: 'listening' };
  });
  ipcMain.handle('voiceStop', (_event, id) => ({ id, state: 'idle' }));
  // The page's recorded audio arrives here on Stop; the words come back once the test releases them.
  ipcMain.handle('voiceTranscribe', (_event, id, audio) => new Promise(resolve => {
    assert.equal(id, voiceRequest.id);
    voiceAudio = audio;
    finishVoice = text => {
      window.webContents.send('voice', { ...voiceRequest, type: 'text', state: 'transcribing', sequence: 1, text });
      window.webContents.send('voice', { ...voiceRequest, type: 'state', state: 'idle' });
      resolve({ ...voiceRequest, state: 'idle' });
    };
  }));
  const savedChecks = [];
  ipcMain.handle('checks', (_event, workspace, list) => { savedChecks.push(list); return controller.checks(workspace, list); });
  ipcMain.handle('phasmaGameChecks', () => null);
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
  let modelRequests = 0, cursorModelRequests = 0, failModels = false, finishFetch, nextModels = [], holdApiModels = false, holdCursorModels = true;
  ipcMain.handle('providerModels', async (_event, id) => {
    modelRequests++;
    if (id === 'cursor-cli')
      cursorModelRequests++;
    if (id !== 'cursor-cli' && !holdApiModels) return [];
    if (id === 'cursor-cli' && !holdCursorModels) return [];
    await new Promise(resolve => { finishFetch = resolve; });
    if (failModels) throw new Error('Test model fetch failed');
    return nextModels;
  });
  // Offscreen rendering keeps hidden-window captures current, including modal top layers.
  const window = new BrowserWindow({ show: false,
    ...(process.platform === 'win32' ? { titleBarStyle: 'hidden', titleBarOverlay: { height: 40 } } : {}),
    webPreferences: { preload: path.resolve(__dirname, '../src/preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  // Screenshots are only for local review. A GPU-less CI runner can fail a capture (UnknownVizError); there it saves an
  // empty image and says so instead of failing the run.
  if (process.env.CI) {
    const capture = window.webContents.capturePage.bind(window.webContents);
    window.webContents.capturePage = (...args) => capture(...args).catch(error => {
      console.log(`Screenshot skipped on CI: ${error.message}`);
      return require('electron').nativeImage.createEmpty();
    });
  }
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
  await require('./text-context-menu-check.cjs')(window);
  await require('./connector-ui-check.cjs')(window, root);
  deadline.refresh();
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
  assert.equal(sidebarSettings.text, 'Settings');
  assert.equal(sidebarSettings.name, 'Settings');
  assert.equal(sidebarSettings.title, 'Settings');
  assert.equal(sidebarSettings.ratio, 1, 'Mosaic gear keeps its CSS size');
  assert.equal(sidebarSettings.shieldShift, 'none', 'shield is centred in its hit area');
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
      document.querySelector(selector).dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
      return document.activeElement === prompt;
    });
  })()`);
  assert.ok(composerFocus, 'clicking composer whitespace focuses the text input');
  for (const edge of ['top', 'bottom', 'left', 'right']) {
    const point = await window.webContents.executeJavaScript(`(() => {
      document.querySelector('#prompt').blur();
      const box = document.querySelector('#composer').getBoundingClientRect();
      return { x: Math.round(${JSON.stringify(edge)} === 'left' ? box.left + 3 : ${JSON.stringify(edge)} === 'right' ? box.right - 3 : box.left + box.width / 2),
        y: Math.round(${JSON.stringify(edge)} === 'top' ? box.top + 3 : ${JSON.stringify(edge)} === 'bottom' ? box.bottom - 3 : box.top + box.height / 2) };
    })()`);
    window.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 });
    window.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 });
    assert.ok(await window.webContents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => resolve(document.activeElement === document.querySelector('#prompt'))))`),
      `clicking the composer's ${edge} padding focuses the input`);
  }

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
      const controls = ['#attach-files', '.composer-access', '#dictate', '#context-meter', '#send']
        .map(selector => document.querySelector(selector).getBoundingClientRect());
      const centers = controls.map(rect => rect.top + rect.height / 2);
      const inputRect = prompt.getBoundingClientRect();
      centers.push(inputRect.top + inputRect.height / 2);
      const order = ['#attach-files', '.composer-access', '#prompt', '.context-meter-wrap', '#dictate', '#send']
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
    assert.ok(Math.abs(result.empty - result.line) < 1, 'empty composer is one line: ' + JSON.stringify(result));
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
      actionsRemoved: ['clear-conversation', 'commands-help', 'chat-options'].every(id => !document.getElementById(id)),
      contextVisible: document.querySelector('#context-meter').checkVisibility(),
      connectionInHeader: !!document.querySelector('header #provider-connection')
    };
  })()`);
  assert.deepEqual(quietComposer, { endsAtComposer: true, actionsRemoved: true, contextVisible: true, connectionInHeader: true },
    'the composer has no persistent footer; advanced actions remain on demand');
  const appearanceState = () => window.webContents.executeJavaScript(`({
    mode: document.documentElement.dataset.appearance,
    background: getComputedStyle(document.body).backgroundColor,
    draft: document.querySelector('#prompt').value,
    sidebar: !!document.querySelector('#agents-sidebar #settings'),
    optionsClosed: !document.querySelector('#chat-options')
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
    assert.equal((await appearanceState()).background, 'rgb(18, 18, 18)', 'System follows live OS appearance changes');
    await chooseAppearance('light');
    assert.deepEqual(await appearanceState(), {
      mode: 'light', background: 'rgb(255, 255, 255)', draft: 'Keep this draft', sidebar: true, optionsClosed: true,
    });
    nativeTheme.themeSource = 'light';
    await chooseAppearance('dark');
    await themeFrame();
    assert.equal((await appearanceState()).background, 'rgb(18, 18, 18)', 'explicit Dark overrides a light OS');
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
    for (let tries = 0; tries < 50 && (await sidebarSize()).dragging; tries++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal((await sidebarSize()).dragging, false, 'sidebar drag released');
  };
  const initialSidebar = await sidebarSize();
  const dragDistance = Math.min(70, initialSidebar.max - initialSidebar.width);
  await dragSidebar(dragDistance);
  const resizedSidebar = await sidebarSize();
  assert.equal(resizedSidebar.width, initialSidebar.width + dragDistance);
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
  // A tone stands in for the microphone, so the page's real capture path (worklet, resampling, PCM) runs.
  await window.webContents.executeJavaScript(`navigator.mediaDevices.getUserMedia = async () => {
    const context = new AudioContext();
    const tone = context.createOscillator();
    const output = context.createMediaStreamDestination();
    tone.connect(output);
    tone.start();
    return output.stream;
  }; true`);
  await window.webContents.executeJavaScript('document.querySelector("#dictate").click(); true');
  await until(() => voiceRequest, 'dictation binds to the original chat');
  // "Starting…" until the microphone really records, then "Listening…".
  await window.webContents.executeJavaScript(`new Promise(resolve => { const wait = () => document.querySelector('#dictation-status').textContent === 'Listening…'
    ? resolve() : setTimeout(wait, 20); wait(); })`);
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 400))');
  const beforeVoice = sent.length;
  await submit('typed before speaking', false);
  await until(() => finishVoice, 'Send stops the microphone before reading its final words');
  await window.webContents.executeJavaScript('document.querySelector("#composer").dispatchEvent(new Event("submit", { cancelable: true })); true');
  assert.equal(sent.length, beforeVoice, 'dictation does not send before Stop completes');
  const audioBytes = voiceAudio?.byteLength || 0;
  // How much depends on the machine's audio clock (a Bluetooth headset in call mode runs it slowly), so only that audio arrived.
  assert.ok(audioBytes > 1000 && audioBytes % 2 === 0, `the page recorded 16-bit audio (${audioBytes} bytes)`);
  finishVoice('final dictated words');
  await until(() => sent.length === beforeVoice + 1, 'Send includes the final recognized words exactly once');
  assert.equal(sent.at(-1).text, 'typed before speaking final dictated words');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#dictation-status").hidden'), true);
  voiceRequest = null; finishVoice = null;
  await window.webContents.executeJavaScript('document.querySelector("#dictate").click(); true');
  await until(() => voiceRequest, 'a later dictation can start');
  const voiceSource = voiceRequest.sessionId;
  // Chat switches are ignored until the start call returns (slower machines reach main's voiceStart well before that).
  await window.webContents.executeJavaScript(`new Promise(resolve => { const wait = () => (submitting ? setTimeout(wait, 20) : resolve()); wait(); })`);
  await window.webContents.executeJavaScript('selectSession(null)');
  await until(() => finishVoice, 'switching chats stops dictation');
  finishVoice('words for the original chat');
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 20))');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '');
  assert.equal(await window.webContents.executeJavaScript('drafts.get(' + JSON.stringify(voiceSource) + ')'), 'words for the original chat');
  await window.webContents.executeJavaScript('selectedId = ' + JSON.stringify(voiceSource) + '; drafts.delete(selectedId); document.querySelector("#prompt").value = ""; render(); updatePreview();');
  console.log(`Local dictation records audio in the page (${audioBytes} bytes), final-word Send, duplicate Send guard and original-chat drafts passed`);
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
  deadline.refresh(); phase = 'document attachments';
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
  assert.equal(await window.webContents.executeJavaScript("!!document.querySelector('.message-bubble .task-status')"), true, 'task status stays visible outside the hover-only metadata');
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
  const replyMetadata = await window.webContents.executeJavaScript(`(() => {
    const message = document.querySelector('.message.assistant');
    const row = message.querySelector('.message-actions');
    const label = message.querySelector('.message-label');
    const initial = getComputedStyle(row).opacity;
    message.querySelector('.message-bubble').click();
    const clicked = getComputedStyle(row).opacity;
    const focused = document.activeElement === message;
    document.querySelector('#prompt').focus();
    return { initial, clicked, focused, hiddenAgain: getComputedStyle(row).opacity,
      labelAfterCopy: label.parentElement === row && label.previousElementSibling.classList.contains('message-copy'),
      leftAligned: getComputedStyle(row).justifyContent === 'flex-start',
      compactSpacing: parseFloat(getComputedStyle(message).marginBottom) === 8 };
  })()`);
  assert.deepEqual(replyMetadata, { initial: '0', clicked: '1', focused: true, hiddenAgain: '0',
    labelAfterCopy: true, leftAligned: true, compactSpacing: true });
  console.log('Reply labels name their provider passed');
  await window.webContents.executeJavaScript(`renderMessages({ items: [
    { id: 'hub-auto', type: 'userMessage', content: [{ type: 'text', text: 'Hello' }] },
    { id: 'hub-manual', type: 'userMessage', content: [{ type: 'text', text: 'Hello again' }] }
  ], routes: [
    { messageId: 'hub-auto', source: 'hub-auto', label: 'Balanced model · low' },
    { messageId: 'hub-manual', source: 'manual', label: 'Chosen model · medium' }
  ] });`);
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.message.user .message-label').length"), 0, 'user messages have no You label');
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('.routing-row').length"), 0,
    'manual and Hub model labels do not add redundant text or empty rows');
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('#messages details.activity').length"), 0, 'pinned Hub routes do not claim another routing call');
  const bubbles = await window.webContents.executeJavaScript(`(() => {
    renderMessages({ items: [
      { id: 'short-bubble', type: 'userMessage', content: [{ type: 'text', text: 'hi' }], createdAt: Date.now() },
      { id: 'long-bubble', type: 'userMessage', content: [{ type: 'text', text: 'Long message '.repeat(100) }] }
    ], routes: [] });
    const [short, long] = document.querySelectorAll('.message.user .message-bubble');
    const shortBox = short.getBoundingClientRect(), longBox = long.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(short.querySelector('.message-body'));
    const textBox = range.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(short.querySelector('.message-body')).lineHeight);
    const messages = document.querySelector('#messages').getBoundingClientRect();
    return { hugsText: shortBox.width - textBox.width <= 36,
      compact: shortBox.height <= lineHeight + 24,
      aligned: Math.abs(shortBox.right - messages.right) < 1,
      wraps: longBox.height > shortBox.height && longBox.width <= messages.width * .88 + 1,
      noOverflow: long.scrollWidth <= long.clientWidth + 1 };
  })()`);
  assert.deepEqual(bubbles, { hugsText: true, compact: true, aligned: true, wraps: true, noOverflow: true });
  assert.deepEqual(await window.webContents.executeJavaScript(`(() => {
    const now = Date.now();
    const labels = [-1000, 0, 59000, 60000, 120000, 3600000, 64800000, 172800000, 2592000000, 31536000000]
      .map(age => elapsedMessageTime(now - age, now));
    const time = document.querySelector('#messages .message-actions time');
    const dateTime = new Date(now - 120000).toISOString();
    time.dateTime = dateTime;
    const title = time.title;
    refreshMessageTimes();
    return { labels, refreshed: time.textContent, preserved: time.dateTime === dateTime && time.title === title };
  })()`), { labels: ['Just now', 'Just now', 'Just now', '1 minute ago', '2 minutes ago', '1 hour ago',
    '18 hours ago', '2 days ago', '1 month ago', '1 year ago'], refreshed: '2 minutes ago', preserved: true });

  for (const appearance of ['light', 'dark']) {
    const colors = await window.webContents.executeJavaScript(`(() => {
      const savedAppearance = document.documentElement.dataset.appearance;
      document.documentElement.dataset.appearance = '${appearance}';
      renderMessages({ items: [
        { id: 'user-grey', type: 'userMessage', content: [{ type: 'text', text: 'Hi <a href="https://example.com">link</a> <code>code</code>' }] },
        { id: 'agent-grey', type: 'agentMessage', text: 'Hello', phase: 'final_answer' },
        { id: 'commentary-grey', type: 'agentMessage', text: 'Working', phase: 'commentary' }
      ], routes: [] });
      const user = document.querySelector('.message.user .message-bubble');
      const agent = document.querySelector('.message.assistant .message-bubble');
      const commentary = document.querySelector('.message.commentary .message-bubble');
      const color = element => getComputedStyle(element).backgroundColor.match(/\\d+/g).slice(0, 3).map(Number);
      const result = { user: color(user), agent: color(agent), commentary: color(commentary),
        userText: getComputedStyle(user).color, linkText: getComputedStyle(user.querySelector('a')).color,
        codeBackground: color(user.querySelector('code')),
        leftAligned: Math.abs(agent.getBoundingClientRect().left - document.querySelector('#messages').getBoundingClientRect().left) < 1,
        fits: agent.getBoundingClientRect().width < 100 };
      document.documentElement.dataset.appearance = savedAppearance;
      return result;
    })()`);
    assert.deepEqual(colors.user, appearance === 'light' ? [234, 242, 254] : [38, 38, 38]);
    assert.deepEqual(colors.agent, appearance === 'light' ? [244, 245, 247] : [28, 28, 28]);
    assert.equal(colors.userText, appearance === 'light' ? 'rgb(32, 43, 60)' : 'rgb(236, 236, 236)');
    assert.equal(colors.linkText, appearance === 'light' ? 'rgb(40, 95, 187)' : 'rgb(133, 178, 255)');
    assert.deepEqual(colors.codeBackground, appearance === 'light' ? [245, 246, 248] : [28, 28, 28]);
    assert.deepEqual(colors.commentary, colors.agent);
    assert.equal(colors.leftAligned, true);
    assert.equal(colors.fits, true);
  }
  console.log('Compact content-sized bubbles and removed model-selection rows passed');
  const links = await window.webContents.executeJavaScript(String.raw`(async () => {
    const saved = { openFile: api.openFile, linkImage: api.linkImage, openLink: api.openLink }, opened = [], loaded = [];
    api.openFile = async target => { opened.push(target); };
    api.openLink = async target => { opened.push(target); };
    api.linkImage = async target => { loaded.push(target); return 'data:image/gif;base64,R0lGODlhAQABAAAAACw='; };
    const text = '<a data-path="%">bad</a> <span data-image="%"></span> [main](src/main.cjs:114) [doc](<C:/a b/c.md>) ' +
      '[web](https://example.com) ![shot](C:\\tmp\\shot.png) ![remote](https://example.com/i.png)';
    renderMessages({ items: [{ id: 'agent-links', type: 'agentMessage', text, phase: 'final_answer' }], routes: [] });
    renderMessages({ items: [{ id: 'agent-links', type: 'agentMessage', text: text + ' ', phase: 'final_answer' }], routes: [] });
    await new Promise(setTimeout);
    const body = document.querySelector('.message.assistant .message-body');
    for (const link of body.querySelectorAll('a')) link.click();
    Object.assign(api, saved);
    // The preload → IPC → linked-files path (handlers above), without opening anything.
    const real = { image: (await window.router.linkImage(null, ${JSON.stringify(path.join(__dirname, '..', 'ui', 'icon-192.png'))}, 'main')).slice(0, 22),
      missing: await window.router.openFile(null, ${JSON.stringify(path.join(root, 'missing.md'))}, 'main').then(() => 'opened', error => /File not found/.test(error.message)) };
    return { titles: [...body.querySelectorAll('a[data-path]')].map(link => link.title), opened, loaded,
      image: body.querySelector('.linked-image img')?.src.slice(0, 15), images: body.querySelectorAll('img').length,
      remote: body.querySelector('a[href="https://example.com/i.png"]')?.textContent, real };
  })()`);
  assert.deepEqual(links, { titles: ['src/main.cjs:114', 'C:/a b/c.md', 'C:\\tmp\\shot.png'],
    opened: ['src/main.cjs:114', 'C:/a b/c.md', 'https://example.com/', 'C:\\tmp\\shot.png', 'https://example.com/i.png'],
    loaded: ['C:\\tmp\\shot.png'], image: 'data:image/gif;', images: 1, remote: 'remote',
    real: { image: 'data:image/png;base64,', missing: true } });
  console.log('Chat file links, linked images and web image links passed');
  const codePaths = await window.webContents.executeJavaScript(String.raw`(async () => {
    const saved = api.openFile, opened = [];
    api.openFile = async target => { opened.push(target); };
    const tick = '\x60', code = value => tick + value + tick;
    const text = [code('ui/app.js:2146'), code('C:\\a b\\c.md'), code('api.openFile'), code('/clear'), code('tests/*.test.cjs'),
      '[' + code('src/x.js') + '](src/x.js)', '\n\n' + tick.repeat(3) + '\nsrc/main.cjs\n' + tick.repeat(3)].join(' ');
    renderMessages({ items: [{ id: 'agent-code-paths', type: 'agentMessage', text, phase: 'final_answer' }], routes: [] });
    const body = document.querySelector('.message.assistant .message-body');
    for (const link of body.querySelectorAll('a')) link.click();
    api.openFile = saved;
    return { opened, nested: body.querySelectorAll('a a').length, plain: [...body.querySelectorAll('code')].filter(c => !c.closest('a')).map(c => c.textContent.trim()) };
  })()`);
  assert.deepEqual(codePaths, { opened: ['ui/app.js:2146', 'C:\\a b\\c.md', 'src/x.js'], nested: 0,
    plain: ['api.openFile', '/clear', 'tests/*.test.cjs', 'src/main.cjs'] });
  console.log('Bare paths in inline code open as file links passed');
  fs.writeFileSync(path.join(root, 'linked-notes.md'), 'notes');
  fs.copyFileSync(path.join(__dirname, '..', 'ui', 'icon-192.png'), path.join(root, 'linked-shot.png'));
  browserAccessCall = true;
  browseCalls.length = 0;
  const phone = await window.webContents.executeJavaScript(String.raw`(async () => {
    await api.openFile(${JSON.stringify(path.join(root, 'linked-notes.md') + ':3')});
    const notes = $('#browser-dialog').open;
    await api.openFile('linked-shot.png');
    await new Promise(r => setTimeout(r, 200));
    const image = $('#browser-preview img')?.src.slice(0, 22);
    $('#browser-dialog').close();
    const outside = await api.openFile(${JSON.stringify(path.join(__dirname, '..', 'package.json'))}).then(() => 'opened', error => error.message);
    return { notes, image, outside: /inside the workspace/.test(outside), dialog: $('#browser-dialog').open };
  })()`);
  browserAccessCall = false;
  assert.deepEqual(phone, { notes: true, image: 'data:image/png;base64,', outside: true, dialog: false });
  assert.deepEqual(browseCalls.filter(call => call[1] === 'read').map(call => call[2]), ['linked-notes.md', 'linked-shot.png']);
  console.log('Browser-access file links open in Workspace files, images inside the workspace only passed');
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
  assert.deepEqual(await window.webContents.executeJavaScript(`(() => {
    const saved = [state.coordinator, state.hubMode, state.settings.mode];
    state.coordinator = true;
    const pinned = presetGroups()[0].variants[0];
    state.hubMode = pinned.id;
    state.settings.mode = 'auto';
    render();
    const main = document.querySelector('.composer-model').hidden
      && document.querySelector('#composer-model-label').hidden
      && !document.querySelector('#preset option[value=auto]') && currentMode() === pinned.id
      && !commandChoices('model').some(row => row.id === 'auto')
      && commandChoices('effort').length === 0;
    const capHidden = document.querySelector('#effort-cap').hidden;
    state.hubMode = null;
    render();
    const unselected = currentMode() === null && document.querySelector('#preset').value === '';
    state.coordinator = false;
    render();
    const worker = !!document.querySelector('#preset option[value=auto]') && currentMode() === 'auto'
      && commandChoices('model').length === 0 && commandChoices('effort').length === 0
      && document.querySelector('.composer-model').hidden && document.querySelector('#composer-model-label').hidden;
    [state.coordinator, state.hubMode, state.settings.mode] = saved;
    render();
    return { main, capHidden, unselected, worker };
  })()`), { main: true, capHidden: true, unselected: true, worker: true });
  console.log('Hub model menu excludes Auto and worker-only models; workers retain Auto');
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
  await providerAction("document.querySelector('.api-provider-row').open = false; document.querySelector('[data-connection-provider=lm-studio] .provider-plug').click()");
  assert.equal(controller.data.settings.providers[0].enabled, false);
  assert.deepEqual(controller.data.settings.providers.map(p => p.id), ['lm-studio', 'other'], 'toggling does not move another provider under the pointer');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('.api-provider-row .provider-account-text').textContent"), 'LM Studio · Disabled');
  assert.deepEqual(await window.webContents.executeJavaScript("[document.querySelector('.api-provider-row').open, document.querySelector('[data-connection-provider=lm-studio] .provider-plug').getAttribute('aria-pressed')]"), [false, 'false'], 'plug toggles without expanding settings');
  await providerAction("document.querySelector('[data-connection-provider=lm-studio] .provider-plug').click()");
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
  // A provider's model group starts collapsed under its title; one the user opens stays open when the list re-renders.
  const cursorGroup = `[...document.querySelectorAll('#provider-model-list .provider-model-section')].find(section => section.querySelector('summary').textContent === 'Cursor CLI')`;
  assert.equal(await window.webContents.executeJavaScript(`[...document.querySelectorAll('#provider-model-list .provider-model-section')].some(section => section.open)`), false, 'groups start collapsed');
  await window.webContents.executeJavaScript(`${cursorGroup}.querySelector('summary').click(); new Promise(r => setTimeout(r, 50))`);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderProviders(); true');
  assert.equal(await window.webContents.executeJavaScript(`${cursorGroup}.open`), true, 'an opened group stays open after re-render');
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
  // Later steps open the Providers tab, which renews Cursor's models; model pickers wait for that, so it answers at once.
  holdCursorModels = false;
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
  // Disconnected labels stay muted but more readable than the faint plugs; tabs keep their scroll place.
  const providerWindowSize = window.getSize();
  window.setSize(providerWindowSize[0], 480); await new Promise(resolve => setTimeout(resolve, 50));
  await window.webContents.executeJavaScript(`document.querySelector('#settings-dialog').showModal(); document.querySelector('#tab-providers').click();
    document.querySelector('.settings-body').scrollTop = 0;
    showProviderError("DeepSeek Harness could not start: Cannot find package 'zod'");
    new Promise(r => setTimeout(r, 150))`);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/provider-rows.png'), (await window.webContents.capturePage()).toPNG());
  const settingsLook = await window.webContents.executeJavaScript(`(() => {
    const row = [...document.querySelectorAll('.provider-account-row')].find(r => r.querySelector(':scope > .provider-plug.disconnected'));
    const color = node => getComputedStyle(node).color;
    const greyed = color(row.querySelector('strong')) === color(row)
      && color(row.querySelector('strong')) !== color(row.querySelector('.provider-plug'))
      && color(row.querySelector('strong')) !== color(document.querySelector('#settings-dialog'));
    const body = document.querySelector('.settings-body');
    // A connect or install error shows right under the provider rows, in view while they are.
    const status = document.querySelector('#provider-status'), box = status.getBoundingClientRect(), view = body.getBoundingClientRect();
    const errorInView = status.previousElementSibling.classList.contains('provider-accounts') && box.top >= view.top && box.bottom <= view.bottom;
    status.textContent = '';
    body.scrollTop = 200;
    const providers = body.scrollTop;
    document.querySelector('#tab-general').click();
    const general = body.scrollTop;
    body.scrollTop = 40;
    const generalSet = body.scrollTop;
    document.querySelector('#tab-providers').click();
    const back = body.scrollTop;
    document.querySelector('#tab-general').click();
    const generalBack = body.scrollTop;
    document.querySelector('#settings-dialog').close();
    return { greyed, errorInView, providers, general, back, generalSet, generalBack, errorBox: [box.top, box.bottom], view: [view.top, view.bottom] };
  })()`);
  assert.equal(settingsLook.greyed, true, 'disconnected labels are muted independently of their fainter plugs');
  assert.equal(settingsLook.errorInView, true, 'a connect error shows under the provider rows, in view: ' + JSON.stringify(settingsLook));
  assert.ok(settingsLook.providers > 0, 'the Providers tab scrolls in this fixture');
  assert.deepEqual([settingsLook.general, settingsLook.back, settingsLook.generalBack], [0, settingsLook.providers, settingsLook.generalSet],
    'each Settings tab keeps its own scroll place: ' + JSON.stringify(settingsLook));
  window.setSize(...providerWindowSize); await new Promise(resolve => setTimeout(resolve, 50));
  console.log('Greyed unconnected providers, connect errors under the rows and per-tab Settings scrolling passed');
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
  // A Phasma game workspace offers its built-in checks; they save through the normal checks path and are not offered twice.
  const recipe = ['build', 'launch', 'gameplay'].map(kind => ({ name: kind, kind, timeoutMs: 30000,
    argv: [process.execPath, 'C:\\Program Files\\Phasma Harness\\resources\\app\\src\\phasma-game-checks.cjs', kind] }));
  ipcMain.removeHandler('phasmaGameChecks');
  ipcMain.handle('phasmaGameChecks', (_event, workspace) => recipe.map(check => ({ ...check, cwd: workspace })));
  await window.webContents.executeJavaScript('renderChecks(); new Promise(r => setTimeout(r, 100))');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#checks-phasma').hidden"), false, 'the recipe is offered');
  await window.webContents.executeJavaScript("document.querySelector('#checks-phasma').click(); new Promise(r => setTimeout(r, 300))");
  assert.deepEqual(savedChecks.at(-1).map(check => [check.kind, check.argv]), recipe.map(check => [check.kind, check.argv]), 'the recipe saves its exact commands');
  await window.webContents.executeJavaScript('renderChecks(); new Promise(r => setTimeout(r, 100))');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#checks-phasma').hidden"), true, 'added checks are not offered twice');
  ipcMain.removeHandler('phasmaGameChecks');
  ipcMain.handle('phasmaGameChecks', () => null);
  controller.checks(controller.data.settings.workspace, []);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderChecks(); true');
  console.log('Phasma game checks are offered once and save their commands passed');
  await window.webContents.executeJavaScript("document.querySelector('#settings').click(); new Promise(r => setTimeout(r, 100))");
  const dialogSize = () => window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('#settings-dialog'), box = dialog.getBoundingClientRect();
    return { width: box.width, height: box.height, right: box.right, bottom: box.bottom, resize: getComputedStyle(dialog).resize,
      fits: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight,
      footerFits: document.querySelector('#settings-dialog .dialog-footer').getBoundingClientRect().bottom <= box.bottom };
  })()`);
  const originalDialog = await dialogSize();
  assert.equal(originalDialog.resize, 'both');
  const corner = { x: Math.floor(originalDialog.right - 4), y: Math.floor(originalDialog.bottom - 4) };
  window.webContents.sendInputEvent({ type: 'mouseMove', ...corner });
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...corner });
  window.webContents.sendInputEvent({ type: 'mouseMove', x: corner.x - 70, y: corner.y - 60 });
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: corner.x - 70, y: corner.y - 60 });
  await new Promise(r => setTimeout(r, 50));
  const resizedDialog = await dialogSize();
  assert.ok(resizedDialog.width < originalDialog.width, 'the Settings corner resizes horizontally');
  assert.ok(resizedDialog.height < originalDialog.height, 'the Settings corner resizes vertically');
  assert.ok(resizedDialog.fits && resizedDialog.footerFits);
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog .close-dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', altKey: true, bubbles: true, cancelable: true })); true");
  assert.equal((await dialogSize()).width, resizedDialog.width - 20, 'Alt and arrow keys resize the focused dialog');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/resized-settings.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').style.removeProperty('width'); document.querySelector('#settings-dialog').style.removeProperty('height'); true");
  console.log('Dialog corner and keyboard resizing with visible footer passed');
  const changeSetting = (id, value) => window.webContents.executeJavaScript(`(async () => {
    const control = document.getElementById(${JSON.stringify(id)}); control.value = ${JSON.stringify(value)};
    control.dispatchEvent(new Event('change', { bubbles: true }));
    await settingsWrites.catch(() => {}); await new Promise(r => setTimeout(r, 10));
  })()`);


  // The Main Bot's workspace is chosen in its Edit dialog (Settings has none); Browse fills the field and saves it.
  await window.webContents.executeJavaScript("editHub({ name: 'Hub' }); document.querySelector('#hub-browse').onclick()");
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#hub-workspace').value"), root, 'Browse fills in the chosen folder');
  await window.webContents.executeJavaScript("document.querySelector('#hub-dialog').close(); true");
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').open"), true);
  await changeSetting('settings-context', 'jev');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#settings-context').value"), 'local', 'a rejected option returns to the saved value');

  await changeSetting('settings-quick', 'off');
  assert.equal(controller.data.settings.jevQuickAnswers, false, 'the write queue recovers after rejection');
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const popup = document.querySelector('#saved-popup'), box = popup.getBoundingClientRect();
    const edge = document.querySelector('#settings-dialog').getBoundingClientRect();
    return popup.matches(':popover-open') && box.right <= edge.right && edge.right - box.right <= 40
      && box.bottom <= edge.bottom && edge.bottom - box.bottom <= 24;
  })()`), true, 'Saved shows at the bottom right of the Settings window');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/mosaic/saved-popup-settings.png'), (await window.webContents.capturePage()).toPNG());

  await changeSetting('settings-quick', 'on');
  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#settings-dialog .close-dialog').click(); await new Promise(r => setTimeout(r, 20));
    document.querySelector('#settings').click(); await new Promise(r => setTimeout(r, 100));
  })()`);

  assert.equal(await window.webContents.executeJavaScript("!!document.querySelector('#settings-close')"), false, 'Settings closes with its X; there is no Close button');
  const settingsLayout = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#tab-benchmarks').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    const panel = document.querySelector('#panel-benchmarks');
    const result = { visible: !panel.hidden, loaded: document.querySelector('#benchmark-status').textContent.includes('fixture'),
      fits: panel.scrollWidth <= panel.clientWidth };
    document.querySelector('#tab-general').click();
    const input = document.querySelector('#settings-show-tips');
    const compact = input.getBoundingClientRect().height;
    input.style.paddingBlock = '10px';
    result.ratio = compact / input.getBoundingClientRect().height;
    input.style.removeProperty('padding-block');
    return result;
  })()`);
  assert.ok(settingsLayout.visible && settingsLayout.loaded && settingsLayout.fits, 'benchmark tab loads inside settings');
  // The refresh worker is a model with its effort beside it, like the other model pickers.
  const refreshWorker = await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#tab-benchmarks').click();
    await new Promise(resolve => setTimeout(resolve, 50));
    document.querySelector('#benchmark-worker').scrollIntoView({ block: 'center' });
    return [benchmarkWorker(), document.querySelector('#benchmark-worker-effort').options.length];
  })()`);
  assert.ok(controller.snapshot().presets.some(p => p.id === refreshWorker[0]), 'the refresh worker is one model at one effort');
  assert.ok(refreshWorker[1] >= 1);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/benchmark-worker-setting.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("document.querySelector('#tab-general').click(); true");
  assert.ok(Math.abs(settingsLayout.ratio - .75) < .02, 'form fields are one-quarter shorter');
  const compactGear = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('#settings');
    return button.textContent.includes('Settings') && button.getBoundingClientRect().height >= 36;
  })()`);
  assert.ok(compactGear, 'Settings has a labelled, reachable sidebar row');
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
  for (const action of ["document.querySelector('#settings-dialog .close-dialog').click()", "document.querySelector('#settings-dialog').dispatchEvent(new Event('cancel', { cancelable: true }))"]) {
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
    document.querySelector('#settings-dialog .close-dialog').click(); await new Promise(r => setTimeout(r, 20));
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
  const blocker = 'Resolve the pending permission request before updating.';
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify({ ...controller.snapshot(), agents: [{ id: 'main', name: 'Bot' }], agentStates: { main: controller.snapshot() }, anyAgentBusy: false, updateBlockedReason: blocker }) + '); true');
  assert.equal((await banner())[3], true, 'the runner blocker survives selection of an agent snapshot');
  assert.ok((await banner())[1].includes(blocker), 'the banner explains the specific blocking work');

  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + "); document.querySelector('#update-dismiss').click(); true");
  assert.equal((await banner())[0], true, 'hidden after dismissing');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#update-available').hidden"), false, 'update icon survives banner dismissal');
  await window.webContents.executeJavaScript("document.querySelector('#update-available').click(); true");
  assert.equal((await banner())[0], false, 'icon reopens confirmation');
  assert.equal(installs, 1, 'icon does not install');
  await push({ status: 'current', latest: '0.2.0', installable: false });
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#update-available').hidden"), true, 'no icon when current');
  const requestedUpdate = { status: 'available', latest: '0.2.0', installable: true, confirmationRequest: 1 };
  await push(requestedUpdate);
  assert.equal((await banner())[0], false, 'agent request reopens a dismissed release');
  assert.match((await banner())[1], /Download and install.*app will restart/);
  assert.equal(installs, 1, 'agent request does not install');
  await window.webContents.executeJavaScript("document.querySelector('#update-dismiss').click(); true");
  await push(requestedUpdate);
  assert.equal((await banner())[0], true, 'same request stays dismissed');
  await push({ ...requestedUpdate, confirmationRequest: 2 });
  assert.equal((await banner())[0], false);
  await window.webContents.executeJavaScript("document.querySelector('#update-install').click(); new Promise(r => setTimeout(r, 100))");
  assert.equal(installs, 2, 'only the user click installs');
  await push({ status: 'current', latest: '0.2.0', installable: false });
  console.log('Update banner passed');
  // Effort cap next to Auto: saved as a setting, max marked with a warning, hidden for a manual model, mirrored in Settings.
  const cap = () => window.webContents.executeJavaScript("[document.querySelector('#effort-cap').hidden, document.querySelector('#effort-cap').value, document.querySelector('#effort-cap').selectedOptions[0].textContent, document.querySelector('#effort-cap').classList.contains('max-cap')]");
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
  await window.webContents.executeJavaScript("document.querySelector('#settings-effort-cap').value = 'high'; document.querySelector('#settings-effort-cap').dispatchEvent(new Event('change', { bubbles: true })); document.querySelector('#settings-dialog .close-dialog').click(); new Promise(r => setTimeout(r, 300))");
  assert.equal(controller.data.settings.effortCap, 'high');
  assert.deepEqual((await cap()).filter((_, i) => i === 1 || i === 3), ['high', false]);
  const manual = controller.catalog().find(p => p.worker && controller.available(p));
  if (manual) {
    await window.webContents.executeJavaScript('applyState(' + JSON.stringify({ ...controller.snapshot(), settings: { ...controller.snapshot().settings, mode: manual.id } }) + '); true');
    assert.equal((await cap())[0], true, 'hidden for a manual model');
    await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); true');
  }
  // Context usage is available directly in the composer, with a tooltip instead of a menu.
  for (const scale of ['1', '1.15', '1.3', '1.5']) {
    const layout = await window.webContents.executeJavaScript(`(async () => {
      const root = document.documentElement, savedScale = root.style.getPropertyValue('--font-scale');
      root.style.setProperty('--font-scale', '${scale}');
      const meter = document.querySelector('#context-meter');
      meter.focus();
      await new Promise(resolve => requestAnimationFrame(resolve));
      const tooltip = document.querySelector('#context-meter-tip');
      const box = tooltip.getBoundingClientRect();
      const result = { visible: box.width > 0, fits: box.left >= 0 && box.right <= innerWidth && box.top >= 0,
        wraps: tooltip.scrollWidth <= tooltip.clientWidth + 1, noGear: !document.querySelector('#chat-options') };
      document.querySelector('#prompt').focus();
      if (savedScale) root.style.setProperty('--font-scale', savedScale); else root.style.removeProperty('--font-scale');
      return result;
    })()`);
    assert.deepEqual(layout, { visible: true, fits: true, wraps: true, noGear: true }, 'context tooltip at scale ' + scale);
  }
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
  await providerAction("document.querySelector('#tab-routing').click()");
  const [hidden, detail] = await compareRow();
  assert.equal(hidden, false);
  assert.match(detail, /^Log only\. When on, .*do not change\. 4 compared: same model 50% \(and effort 25%\), same provider 75%; your manual picks 50% same model · Jev cost \$0\.0004 · 1 failed\.$/);
  await window.webContents.executeJavaScript("document.querySelector('#settings-router-preset').value = 'jev'; document.querySelector('#settings-router-preset').onchange(); true");
  assert.equal((await compareRow())[0], true, 'hidden while Jev is the router');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#settings-routing') === null"), true, 'only one Routing model control remains');
  assert.deepEqual(await window.webContents.executeJavaScript(`(() => {
    const label = document.querySelector('#settings-router-preset').closest('label');
    return { title: label.firstChild.textContent, quickAnswersNext: !!label.nextElementSibling.querySelector('#settings-quick'),
      explanationRemoved: !document.querySelector('#router-detail') };
  })()`), { title: 'Routing model (Auto)', quickAnswersNext: true, explanationRemoved: true });
  assert.match(await window.webContents.executeJavaScript("document.querySelector('#settings-router-preset option[value=jev]').textContent"), /version pending/);
  controller.smartRouter.jev.model = 'jev-9.8.7';
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); true');
  assert.match(await window.webContents.executeJavaScript("document.querySelector('#settings-router-preset option[value=jev]').textContent"), /jev-9\.8\.7/);
  await window.webContents.executeJavaScript("document.querySelector('#settings-router-preset').value = 'jev'; true");
  const priorRoutingModel = controller.data.settings.routerPreset;
  await window.webContents.executeJavaScript("document.querySelector('#settings-router-preset').dispatchEvent(new Event('change', { bubbles: true })); new Promise(r => setTimeout(r, 200))");
  assert.equal(controller.data.settings.routing, 'jev', 'Jev selection saves the routing method');
  assert.equal(controller.data.settings.routerPreset, priorRoutingModel, 'Jev retains the last model for fallback');
  const chosenRoutingModel = await window.webContents.executeJavaScript(`(async () => {
    const select = document.querySelector('#settings-router-preset');
    const option = [...select.options].find(option => option.value && option.value !== 'jev' && !option.disabled);
    if (!option) throw new Error('Fixture needs an available routing model');
    const expected = presetGroups(state.routerPresets, false).find(group => group.key === option.value).variants[0].id;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    return expected;
  })()`);
  assert.equal(controller.data.settings.routing, 'smart', 'model selection switches routing in the same save');
  assert.equal(controller.data.settings.routerPreset, chosenRoutingModel);
  await window.webContents.executeJavaScript("document.querySelector('#settings-router-preset').scrollIntoView({ block: 'center' }); new Promise(r => setTimeout(r, 100))");
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/router-model-setting.png'), (await window.webContents.capturePage()).toPNG());
  assert.equal((await compareRow())[0], false);
  // The chat checker is Off by default and saves any enabled model picked by hand; there is no Auto.
  await window.webContents.executeJavaScript("document.querySelector('#tab-general').click(); true");
  const chatChecker = await window.webContents.executeJavaScript(`(async () => {
    const select = document.querySelector('#settings-chat-scan');
    const first = [select.options[0].textContent, select.value];
    const option = [...select.options].find(option => option.value !== 'off' && !option.disabled);
    const expected = presetGroups(state.chatScanPresets, false).find(group => group.key === option.value).variants[0].id;
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    return [...first, expected];
  })()`);
  assert.deepEqual(chatChecker.slice(0, 2), ['Off', 'off']);
  assert.equal(controller.data.settings.chatScanModel, chatChecker[2]);
  await window.webContents.executeJavaScript("document.querySelector('#settings-chat-scan').scrollIntoView({ block: 'center' }); new Promise(r => setTimeout(r, 100))");
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/chat-checker-setting.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`(async () => {
    const select = document.querySelector('#settings-chat-scan');
    select.value = 'off';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
  })()`);
  assert.equal(controller.data.settings.chatScanModel, 'off', 'Off turns the checker off again');
  // Auto's model for simple messages: Auto (Harness picks) or any worker model, its effort in a picker beside it, with a
  // hint to pick a cheap, low-effort one.
  await window.webContents.executeJavaScript("document.querySelector('#tab-routing').click(); true");
  const lowPickers = () => window.webContents.executeJavaScript(`['#settings-low-model', '#settings-low-effort'].map(id => {
    const select = document.querySelector(id);
    return [select.value, select.disabled, select.selectedOptions[0]?.textContent, select.options.length];
  })`);
  const pickLow = (id, pick) => window.webContents.executeJavaScript(`(async () => {
    const select = document.querySelector('${id}');
    const option = [...select.options].filter(option => !option.disabled && option.value !== select.value && option.value !== 'auto')[${pick}];
    select.value = option.value;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
  })()`);
  assert.deepEqual((await lowPickers()).map(([value, disabled, text]) => [value, disabled, text]), [['auto', false, 'Auto'], ['', true, 'Chosen by Auto']], 'Auto by default, its effort chosen by Auto');
  assert.match(await window.webContents.executeJavaScript("document.querySelector('#low-model-detail').textContent"), /cheap model at low effort/);
  const efforts = presets => presets.map(p => p.effort || '');
  const multi = controller.snapshot().presets.filter(p => p.available && controller.snapshot().presets.filter(q => q.available && q.model === p.model && q.provider === p.provider).length > 1);
  const target = multi[0];
  assert.ok(target, 'the fixture offers a model with several efforts');
  await window.webContents.executeJavaScript(`(async () => {
    const select = document.querySelector('#settings-low-model');
    select.value = ${JSON.stringify(`${target.provider || 'codex'}|${target.model}`)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
  })()`);
  const variants = controller.snapshot().presets.filter(p => p.available && p.model === target.model && p.provider === target.provider);
  const lowest = variants.sort((a, b) => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].indexOf(a.effort) - ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].indexOf(b.effort))[0];
  assert.equal(controller.data.settings.autoLowModel, lowest.id, 'a picked model starts at its lowest effort');
  let [model, effort] = await lowPickers();
  assert.equal(effort[1], false, 'its effort picker is usable');
  assert.equal(effort[3], efforts(variants).length, 'and lists that model\'s efforts');
  await pickLow('#settings-low-effort', 0);
  assert.notEqual(controller.data.settings.autoLowModel, lowest.id, 'the effort beside it saves the same model at that effort');
  assert.equal(controller.data.settings.autoLowModel.split(':').slice(0, -1).join(':'), lowest.id.split(':').slice(0, -1).join(':'));
  [model, effort] = await lowPickers();
  assert.equal(model[0], `${target.provider || 'codex'}|${target.model}`, 'the model stays picked after saving');
  await window.webContents.executeJavaScript("document.querySelector('#settings-low-model').scrollIntoView({ block: 'center' }); new Promise(r => setTimeout(r, 100))");
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/low-model-setting.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`(async () => {
    const select = document.querySelector('#settings-low-model');
    select.value = 'auto';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
  })()`);
  assert.equal(controller.data.settings.autoLowModel, 'auto', 'Auto hands simple messages back to Harness');
  assert.deepEqual((await lowPickers()).map(([value, disabled]) => [value, disabled]), [['auto', false], ['', true]]);
  // While any provider connects, every model picker shows only "Connecting…"; once all are ready, open ones fill in place.
  const pickers = () => window.webContents.executeJavaScript(`['#preset', '#settings-router-preset', '#settings-chat-scan', '#agent-model', '#hub-model']
    .map(id => { const select = document.querySelector(id); return [id, select.disabled, [...select.options].map(option => option.textContent)]; })`);
  controller.connectingProviders.set('claude-cli', 1);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); new Promise(r => setTimeout(r, 50))');
  await window.webContents.executeJavaScript("document.querySelector('#settings-chat-scan').scrollIntoView({ block: 'center' }); new Promise(r => setTimeout(r, 50))");
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/pickers-connecting.png'), (await window.webContents.capturePage()).toPNG());
  const settingsPickers = (await pickers()).slice(0, 3);
  assert.deepEqual(settingsPickers, [['#preset', true, ['Connecting…']], ['#settings-router-preset', true, ['Connecting…']], ['#settings-chat-scan', true, ['Connecting…']]]);
  controller.connectingProviders.delete('claude-cli');
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); new Promise(r => setTimeout(r, 50))');
  const ready = await pickers();
  for (const [id, disabled, options] of ready.slice(0, 3)) {
    assert.equal(disabled, false, `${id} is usable again`);
    assert.ok(options.length > 1 && !options.includes('Connecting…'), `${id} fills in place without reopening Settings`);
  }
  assert.equal(await window.webContents.executeJavaScript("modelEffortChoice($('#settings-router-preset'), $('#settings-router-effort'), state.routerPresets)"), controller.data.settings.routerPreset, 'the saved choice shows again');
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').close(); true");
  // The agent dialog's model list and Save wait the same way.
  controller.connectingProviders.set('claude-cli', 1);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); editAgent(); new Promise(r => setTimeout(r, 50))');
  assert.deepEqual((await pickers())[3], ['#agent-model', true, ['Connecting…']]);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#agent-save').disabled"), true, 'no saving a blank model');
  controller.connectingProviders.delete('claude-cli');
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); new Promise(r => setTimeout(r, 50))');
  assert.deepEqual([(await pickers())[3][1], (await pickers())[3][2][0]], [false, 'Auto']);
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#agent-save').disabled"), false);
  await window.webContents.executeJavaScript("document.querySelector('#agent-dialog').close(); document.querySelector('#settings-dialog').showModal(); true");

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
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + "); document.querySelector('#settings').click(); new Promise(r => setTimeout(r, 200))");
  // Settings has no Wiki tab: the workspace's docs/wiki is reached through project_context, not a panel.
  assert.deepEqual(await window.webContents.executeJavaScript("[...document.querySelectorAll('.settings-tab')].map(tab => tab.dataset.tab)"),
    ['general', 'browser', 'routing', 'tools', 'providers', 'connectors', 'benchmarks', 'checks', 'about']);
  // Browser access, Routing and Tools each have their own tab with their options, and General keeps the rest.
  for (const [tab, controls] of Object.entries({ browser: ['#remote-port', '#remote-toggle'],
    routing: ['#settings-router-preset', '#settings-quick', '#settings-effort-cap', '#settings-low-model', '#settings-jev-compare'],
    tools: ['#settings-context', '#settings-tools'] })) {
    const shown = await window.webContents.executeJavaScript(`(async () => {
      document.querySelector('#tab-${tab}').click();
      await new Promise(r => setTimeout(r, 50));
      const panel = document.querySelector('#panel-${tab}');
      document.querySelector('.settings-body').scrollTop = 0;
      await new Promise(r => setTimeout(r, 100));
      return [panel.hidden, document.querySelector('#panel-general').hidden, document.querySelector('#tab-${tab} svg') !== null,
        ${JSON.stringify(controls)}.map(id => panel.contains(document.querySelector(id))),
        panel.querySelector(':scope > .settings-section:first-child + .hint')?.textContent || ''];
    })()`);
    const intro = shown.pop();
    assert.deepEqual(shown, [false, true, true, controls.map(() => true)], `${tab} tab shows its options, with an icon`);
    assert.ok(intro.length > 20, `${tab} tab explains itself under its title`);
    if (tab === 'routing')
      assert.match(intro, /only apply when a bot's model is set to Auto/);
    fs.writeFileSync(path.resolve(__dirname, `../.scratch/settings-tab-${tab}.png`), (await window.webContents.capturePage()).toPNG());
  }
  await window.webContents.executeJavaScript("document.querySelector('#tab-general').click(); document.querySelector('.settings-body').scrollTop = 0; new Promise(r => setTimeout(r, 100))");
  assert.match(await window.webContents.executeJavaScript("document.querySelector('#panel-general > .settings-section:first-child + .hint').textContent"), /every chat/);
  assert.equal(await window.webContents.executeJavaScript("['#remote-port', '#settings-router-preset', '#settings-context'].some(id => document.querySelector('#panel-general').contains(document.querySelector(id)))"), false,
    'General keeps none of them');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/settings-tab-general.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').close(); true");
  console.log('Compare with Jev settings passed');
  deadline.refresh(); phase = 'agent controls';
  const { Agents } = require('../src/agents.cjs');
  const { EventEmitter } = require('node:events');
  const agents = new Agents(controller, async () => {}, (file, workspace, options) => {
    const client = new EventEmitter(); client.close = () => {};
    client.call = async () => { throw new Error('UI smoke must not start a provider'); };
    const worker = new Controller(file, workspace, client, { cancel() {}, close() {} }, options);
    worker.initialize = async () => { worker.connection = 'ready'; worker.models = controller.models; worker.account = controller.account; };
    return worker;
  });
  assert.equal(agents.snapshot().agents[0].name, 'Assistant');
  ipcMain.removeHandler('bootstrap'); ipcMain.handle('bootstrap', () => agents.snapshot());
  ipcMain.removeHandler('settings'); ipcMain.handle('settings', (_event, values, agentId) => agents.settings(values, agentId));
  ipcMain.handle('permissions', (_event, id, access) => { agents.owner(id).permissions(id, access); return agents.snapshot(); });
  ipcMain.handle('saveAgent', (_event, profile) => agents.saveAgent(profile));
  ipcMain.handle('renameHub', (_event, name) => agents.renameHub(name));
  ipcMain.handle('saveGroup', (_event, value) => agents.saveGroup(value));
  ipcMain.handle('archive', (_event, id) => { agents.owner(id).archive(id); return agents.snapshot(); });
  ipcMain.handle('deleteSession', (_event, id) => agents.owner(id).deleteSession(id));
  ipcMain.handle('deleteAgent', (_event, id) => agents.deleteAgent(id));
  ipcMain.removeHandler('create'); ipcMain.handle('create', (_event, workspace, access, agentId) => agents.conversation(agents.controller(agentId), true, workspace, access));
  let stoppedAgent;
  ipcMain.handle('stop', (_event, id) => { stoppedAgent = agents.owner(id).agentId; });
  ipcMain.handle('load', () => agents.snapshot());
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); document.querySelector("#agent-new").click(); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-dialog").open'), true);
  // A new bot inherits its creator's workspace by default: the folder field is hidden and out of the form's checks.
  const inheritField = () => window.webContents.executeJavaScript(`[document.querySelector('#agent-inherit').checked,
    document.querySelector('#agent-workspace-row').hidden, document.querySelector('#agent-workspace').disabled]`);
  assert.deepEqual(await inheritField(), [true, true, true], 'Inherit is ticked by default and hides the folder');
  await window.webContents.executeJavaScript("document.querySelector('#agent-inherit').click(); true");
  assert.deepEqual(await inheritField(), [false, false, false], 'unticked shows the folder and Browse');
  await window.webContents.executeJavaScript("document.querySelector('#agent-inherit').click(); true");
  await window.webContents.executeJavaScript(`document.querySelector('#agent-name').value = 'Researcher';
    document.querySelector('#agent-instructions').value = 'Inspect source and report evidence.';
    document.querySelector('#agent-model').value = 'auto';
    document.querySelector('#agent-form').dispatchEvent(new Event('submit', { cancelable: true })); true`);
  await until(() => controller.data.agents.length === 1, 'the named agent was saved');
  const profile = controller.data.agents[0];
  assert.deepEqual([profile.inheritWorkspace, profile.createdBy], [true, 'main'], 'a bot made with + inherits from the Main Bot');
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
  await window.webContents.executeJavaScript('document.querySelector("#agents-overview").click(); document.querySelector(' + JSON.stringify(batchCard + '[data-action="edit"]') + ').click(); const role = document.querySelector("#agent-instructions"); role.value += " Keep the evidence."; role.dispatchEvent(new Event("change",{bubbles:true})); document.querySelector("#agent-dialog .close-dialog").click(); true');
  await until(() => !controller.data.agents[0].temporaryBatch, 'editing and saving keeps a batch worker');
  await window.webContents.executeJavaScript('document.querySelector("#agents-dialog").close(); true');
  await window.webContents.executeJavaScript('selectAgent("main")');
  assert.equal(await window.webContents.executeJavaScript('!!document.querySelector(' + JSON.stringify(batchNav) + ')'), true);
  // Renaming the Hub from its Overview card names it in the sidebar and keeps that name.
  // The batch worker's Save above still reloads state after the server saves; let it finish so it cannot apply an older name.
  await until(async () => await window.webContents.executeJavaScript("!document.querySelector('#agent-save').disabled"), 'the batch worker Save finished');
  await window.webContents.executeJavaScript(`document.querySelector('#agents-overview').click();
    document.querySelector('#agent-cards [data-agent="main"][data-action="edit"]').click();
    document.querySelector('#hub-name').value = 'Atlas';
    document.querySelector('#hub-model').value = [...document.querySelector('#hub-model').options].find(option => option.value).value;
    document.querySelector('#hub-model').dispatchEvent(new Event('change', { bubbles: true })); new Promise(r => setTimeout(r, 100))`);
  const chosenHubMode = await window.webContents.executeJavaScript('hubChoice()');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/hub-rename.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("document.querySelector('#hub-form').dispatchEvent(new Event('submit', { cancelable: true })); true");
  await until(async () => await window.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#main-agent-list');
    return list.textContent.includes('Atlas') && list.querySelectorAll('.agent-avatar i').length === 4;
  })()`), 'the renamed Hub retains its Mosaic identity in the sidebar');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#hub-dialog').open"), true, 'the Edit dialog stays open while it autosaves');
  await window.webContents.executeJavaScript("document.querySelector('#hub-dialog .close-dialog').click(); true");
  await until(async () => !(await window.webContents.executeJavaScript("document.querySelector('#hub-dialog').open")), 'X closes the main bot editor');
  assert.equal(agents.hubName(), 'Atlas');
  assert.equal(controller.data.settings.mode, chosenHubMode, 'the Hub saves the model and effort its two pickers show');
  const editedMainMode = controller.data.settings.mode;
  const workerModeBeforeHubEdit = agents.controller(profile.id).data.settings.mode;
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(profile.id) + ')');
  await window.webContents.executeJavaScript(`document.querySelector('#agent-cards [data-agent="main"][data-action="edit"]').click(); true`);
  assert.equal(await window.webContents.executeJavaScript('hubChoice()'), editedMainMode, 'reopening shows the saved model and effort');
  await window.webContents.executeJavaScript("document.querySelector('#hub-name').value = 'Hub'; document.querySelector('#hub-form').requestSubmit(); document.querySelector('#hub-dialog .close-dialog').click(); true");
  await until(() => agents.hubName() === 'Hub', 'Main edit saves while a worker is selected');
  assert.equal(agents.controller(profile.id).data.settings.mode, workerModeBeforeHubEdit);
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
  assert.equal(await window.webContents.executeJavaScript('document.activeElement === document.querySelector("#agent-menu")'), true);
  await window.webContents.executeJavaScript('document.querySelector("#agent-menu").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); true');
  await window.webContents.executeJavaScript('document.querySelector("#agent-menu").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); true');
  assert.equal(await window.webContents.executeJavaScript('document.activeElement.textContent'), 'Edit');
  await window.webContents.executeJavaScript('document.querySelector("#agent-menu").dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-dialog").open'), false, 'Enter does not activate menu buttons');
  await window.webContents.executeJavaScript('document.activeElement.click(); true');
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
  // The Main Bot's workspace and access live in its Edit dialog, not in Settings, and change only the Main Bot even while
  // another bot is selected.
  const mainAccessBefore = controller.data.settings.access, agentAccessBefore = agents.profile(profile.id).access;
  const editMainAccess = access => window.webContents.executeJavaScript(`editHub({ name: state.agents?.find(agent => agent.id === 'main')?.name || 'Hub' });
    document.querySelector('#hub-access').value = ${JSON.stringify(access)};
    document.querySelector('#hub-form').requestSubmit(); document.querySelector('#hub-dialog .close-dialog').click(); true`);
  assert.deepEqual(await window.webContents.executeJavaScript(`[!!document.querySelector('#settings-workspace'), !!document.querySelector('#settings-access'),
    !!document.querySelector('#hub-workspace'), !!document.querySelector('#hub-access')]`), [false, false, true, true], 'workspace and access moved from Settings to the Main Bot');
  const newMainAccess = mainAccessBefore === 'danger-full-access' ? 'read-only' : 'danger-full-access';
  await editMainAccess(newMainAccess);
  await until(() => controller.data.settings.access === newMainAccess, 'the Main Bot dialog saves its access');
  assert.equal(agents.profile(profile.id).access, agentAccessBefore, 'the selected bot keeps its own access');
  await until(async () => !(await window.webContents.executeJavaScript("document.querySelector('#hub-dialog').open")), 'the Main Bot dialog closed');
  await editMainAccess(mainAccessBefore);
  await until(() => controller.data.settings.access === mainAccessBefore, 'the Main Bot access restored');
  await until(async () => !(await window.webContents.executeJavaScript("document.querySelector('#hub-dialog').open")), 'the Main Bot dialog closed again');
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
  await window.webContents.executeJavaScript(`document.querySelector('#context-meter').focus(); document.querySelector('#context-meter').click(); true`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#context-meter").getAttribute("aria-disabled")'), 'true');
  assert.equal(await activeChatState(), beforeAppearanceChange, 'viewing context preserves the active job and draft');
  assert.equal(stoppedAgent, null, 'viewing context does not stop the running task');

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
  // A bot another bot made sits under it, one step in; it has no Edit, its chat is read only, and deleting its creator says it goes too.
  const [researcher, reviewer] = agents.primary.data.agents;
  reviewer.createdBy = researcher.id;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); selectAgent(' + JSON.stringify(reviewer.id) + ')');
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/subbots-sidebar.png'), (await window.webContents.capturePage()).toPNG());
  const subBotView = await window.webContents.executeJavaScript(`(async () => {
    const rows = [...document.querySelectorAll('#agent-list .agent-nav')];
    const index = id => rows.findIndex(row => row.dataset.agent === id);
    const left = id => rows[index(id)].getBoundingClientRect().left;
    const nested = index(${JSON.stringify(reviewer.id)}) === index(${JSON.stringify(researcher.id)}) + 1
      && left(${JSON.stringify(reviewer.id)}) > left(${JSON.stringify(researcher.id)});
    const prompt = document.querySelector('#prompt');
    const composer = [prompt.readOnly, prompt.placeholder, document.querySelector('#send').disabled, document.querySelector('#attach-files').disabled,
      document.querySelector('#permissions').disabled];
    let modelCommand = '';
    try { openCommandPanel('model'); } catch (error) { modelCommand = error.message; }
    document.querySelector('#agents-overview').click();
    const card = [...document.querySelectorAll('#agent-cards button[data-agent=${JSON.stringify(reviewer.id)}]')].map(button => button.dataset.action);
    document.querySelector('#agent-cards button[data-agent=${JSON.stringify(researcher.id)}][data-action=delete]').click();
    const deleteNote = [document.querySelector('#delete-subbots').hidden, document.querySelector('#delete-subbots').textContent];
    document.querySelector('#delete-dialog').close();
    document.querySelector('#agents-dialog').close();
    return { nested, composer, modelCommand, card, deleteNote };
  })()`);
  assert.deepEqual(subBotView, {
    nested: true,
    composer: [true, 'Read only: Researcher gives this bot its work.', true, true, true],
    modelCommand: "This bot follows Researcher's model and settings.",
    card: ['open', 'delete'],
    deleteNote: [false, 'The bots it made go with it: Reviewer.'],
  }, 'a sub-bot is nested, read only, not editable, and deleted with its creator');
  // They show only while their creator or one of them is selected; the creator counts them.
  const listed = () => window.webContents.executeJavaScript(`[[...document.querySelectorAll('#agent-list .agent-nav')].some(row => row.dataset.agent === ${JSON.stringify(reviewer.id)}),
    document.querySelector('#agent-list .agent-nav[data-agent=${JSON.stringify(researcher.id)}] .agent-subbots')?.textContent || null]`);
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(agents.primary.data.agents[2].id) + ')');
  assert.deepEqual(await listed(), [false, '1'], 'hidden while another bot is selected, counted on its creator');
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(researcher.id) + ')');
  assert.deepEqual(await listed(), [true, '1'], 'shown while its creator is selected');
  // Work a bot does for another bot shows in its chat: a sub-bot's always, read only; another bot's while the job is open,
  // then its own chat again.
  const giveWork = async (profile, delivered) => {
    const execution = agents.execution(profile.id);
    await agents.initializeController(execution);
    const job = agents.conversation(execution, true);
    job.items = [{ id: `task-${profile.id}`, type: 'userMessage', content: [{ type: 'text', text: 'Task from agent: say hello.' }], createdAt: Date.now() },
      { id: `answer-${profile.id}`, type: 'agentMessage', phase: 'final_answer', text: 'Hello from the background.', createdAt: Date.now() }];
    job.delegation = { id: `job-${profile.id}`, source: agents.conversation(controller, true).id, state: 'running', delivered };
    if (!delivered) execution.busy = job.id;
    return job;
  };
  const shown = () => window.webContents.executeJavaScript(`[document.querySelector('#messages').textContent.includes('Hello from the background.'),
    document.querySelector('#prompt').readOnly, document.querySelector('#prompt').placeholder]`);
  await giveWork(reviewer, true);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); selectAgent(' + JSON.stringify(reviewer.id) + ')');
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.deepEqual(await shown(), [true, true, 'Read only: Researcher gives this bot its work.'], 'a sub-bot’s chat shows its work, read only');
  delete reviewer.createdBy;
  agents.retainDelegatedChat(agents.execution(reviewer.id), agents.conversation(agents.execution(reviewer.id)));
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); selectAgent(' + JSON.stringify(reviewer.id) + ')');
  assert.deepEqual((await shown()).slice(0, 2), [true, false], 'a normal bot without a direct chat retains completed work and accepts input');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#welcome").hidden'), true);
  let ownChat = agents.conversation(agents.controller(researcher.id), true);
  ownChat.items.push({ id: 'own-message', type: 'agentMessage', phase: 'final_answer', text: 'Written in my own chat.', createdAt: Date.now() });
  const researcherJob = await giveWork(researcher, false);
  delete researcherJob.items[1].createdAt;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); selectAgent(' + JSON.stringify(researcher.id) + ')');
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/background-work.png'), (await window.webContents.capturePage()).toPNG());
  assert.deepEqual(await shown(), [true, true, 'Read only while this bot works on a task from another bot. You can write again when it returns.'],
    'a bot working for another bot shows that work, read only');
  const queuedView = agents.snapshot();
  queuedView.executionStates[researcher.id].sessions.find(chat => chat.id === researcherJob.id).items = [];
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(queuedView) + ')');
  assert.equal((await shown())[1], true, 'typing is disabled even before the delegated worker emits its first message');
  assert.deepEqual(await window.webContents.executeJavaScript('[selectedId, document.querySelector("#stop").hidden]'),
    [researcherJob.id, false], 'the empty queued execution retains its targeted Stop button');
  researcherJob.delegation.delivered = true;
  agents.execution(researcher.id).busy = null;
  agents.retainDelegatedChat(agents.execution(researcher.id), researcherJob);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); new Promise(r => setTimeout(r, 100))');
  const back = await shown();
  assert.deepEqual([back[0], back[1]], [true, false], 'once its result returns, work remains visible and the bot’s own chat is writable');
  assert.doesNotMatch(await window.webContents.executeJavaScript('document.body.textContent'), /Agent coordination failed/);
  assert.deepEqual(await window.webContents.executeJavaScript(`[selectedId, document.querySelector('#messages').textContent.includes('Written in my own chat.')]`),
    [ownChat.id, true], 'Send goes to the bot’s own chat again, with its messages');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/delegated-chat-completed.png'), (await window.webContents.capturePage()).toPNG());
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const text = document.querySelector('#messages').textContent;
    return text.indexOf('Task from agent: say hello.') < text.indexOf('Hello from the background.');
  })()`), true, 'messages without timestamps retain their position after delegated instructions');
  await window.webContents.executeJavaScript('selectAgent("main"); selectAgent(' + JSON.stringify(researcher.id) + ')');
  assert.deepEqual((await shown()).slice(0, 2), [true, false], 'completed work survives navigating away and back');
  ownChat = await agents.clearConversation(researcher.id, () => true);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + ')');
  assert.equal((await shown())[0], false, 'clearing a direct chat does not resurrect old delegated history');
  researcherJob.items = researcherJob.items.map(item => ({ ...item, id: 'new-' + item.id, createdAt: Date.now() }));
  agents.retainDelegatedChat(agents.execution(researcher.id), researcherJob);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + ')');
  assert.equal((await shown())[0], true, 'new delegated answers without timestamps remain visible after a clear');
  // A task resumed from the bot's own chat is not another bot's work (shown to the UI only, nothing runs).
  const ownView = agents.snapshot(), ownBackground = ownView.executionStates[researcher.id];
  ownBackground.sessions.find(chat => chat.id === ownBackground.conversationId).delegation = { id: 'own-resumed-task', state: 'running', owner: ownChat.id, source: ownChat.id };
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(ownView) + '); new Promise(r => setTimeout(r, 100))');
  const own = await shown();
  assert.deepEqual([own[0], own[1]], [true, false], 'a task resumed from the bot’s own chat keeps its retained history and stays writable');
  for (const profile of [reviewer, researcher])
    agents.conversation(agents.execution(profile.id), true).items = [];
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); selectAgent(' + JSON.stringify(researcher.id) + ')');
  console.log('Sub-bots sit under their creator, read only and without Edit passed');
  console.log('Background work shows read only in the bot’s chat passed');
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
  const commandNames = ['/help', '/compact', '/clear', '/stop', '/agents', '/settings', '/context', '/model', '/effort', '/access', '/switch', '/export', '/status', '/wiki'];
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
  await window.webContents.executeJavaScript('document.querySelector("#context-meter").focus(); document.querySelector("#prompt").dispatchEvent(new FocusEvent("blur")); true');
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
  for (const [command, mode] of [['model', 'codex:gpt-6-sol:low'], ['effort', 'codex:gpt-6-sol:high'], ['model', 'auto']]) {
    await openCommand(command);
    assert.equal(await window.webContents.executeJavaScript('document.querySelector("#command-dialog").open'), false);
    assert.deepEqual(await window.webContents.executeJavaScript('[document.querySelector("#agent-dialog").open, document.querySelector("#agent-dialog").dataset.agentId]'), [true, commandAgent]);
    // Models are grouped by provider; a model with several efforts gets its own Effort picker, where /effort lands.
    const picker = await window.webContents.executeJavaScript(`({ focused: document.activeElement.id,
      sections: [...document.querySelectorAll('#agent-model optgroup')].map(group => group.label),
      efforts: document.querySelector('#agent-effort').disabled ? null : [...document.querySelector('#agent-effort').options].map(option => option.value) })`);
    assert.ok(picker.sections.includes('Codex CLI / ChatGPT'), 'models sit under their provider: ' + JSON.stringify(picker.sections));
    if (command === 'effort') {
      assert.deepEqual([picker.focused, picker.efforts], ['agent-effort', ['low', 'high']], '/effort opens on the Effort picker');
      fs.writeFileSync(path.resolve(__dirname, '../.scratch/agent-model-effort.png'), (await window.webContents.capturePage()).toPNG());
      // Model and Effort share a row with Access under Model, and a narrow dialog keeps that arrangement.
      const layout = await window.webContents.executeJavaScript(`(() => {
        const box = id => document.querySelector(id).getBoundingClientRect();
        const place = () => {
          const model = box('#agent-model'), effort = box('#agent-effort'), access = box('#agent-access');
          return [Math.round(model.top) === Math.round(effort.top), effort.left > model.right, access.top > model.bottom, Math.round(access.left) === Math.round(model.left)];
        };
        const wide = place();
        document.querySelector('#agent-dialog').style.width = '360px';
        const narrow = place();
        document.querySelector('#agent-dialog').style.width = '';
        return { wide, narrow };
      })()`);
      assert.deepEqual(layout, { wide: [true, true, true, true], narrow: [true, true, true, true] }, 'Model and Effort stay on one row, Access under Model');
    }
    if (mode === 'auto' && command === 'model') {
      const auto = await window.webContents.executeJavaScript(`(() => {
        document.querySelector('#agent-model').value = 'auto';
        document.querySelector('#agent-model').dispatchEvent(new Event('change'));
        const effort = document.querySelector('#agent-effort');
        return [effort.hidden, effort.disabled, effort.selectedOptions[0]?.textContent];
      })()`);
      assert.deepEqual(auto, [false, true, 'Chosen by Auto'], 'with Auto the Effort picker stays in place, greyed out');
    }
    const [model, effort] = mode === 'auto' ? ['auto', ''] : ['codex|gpt-6-sol', mode.split(':').at(-1)];
    await window.webContents.executeJavaScript(`document.querySelector('#agent-model').value = ${JSON.stringify(model)};
      document.querySelector('#agent-model').dispatchEvent(new Event('change'));
      document.querySelector('#agent-effort').value = ${JSON.stringify(effort)};
      document.querySelector('#agent-effort').dispatchEvent(new Event('change', { bubbles: true }));
      document.querySelector('#agent-dialog .close-dialog').click(); true`);
    await until(() => commandWorker.data.settings.mode === mode, 'Edit saves the worker model and effort');
    assert.equal(controller.data.settings.mode, originalMainMode, 'Edit changes only the selected agent');
    // Autosave no longer reloads everything; the runner's state push (forwarded by main.cjs, not by this harness) brings it.
    await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); new Promise(resolve => setTimeout(resolve, 20))');
  }
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
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    fill: document.querySelector('#context-meter').style.getPropertyValue('--context-used'),
    known: !document.querySelector('#context-meter').classList.contains('unknown'),
    label: document.querySelector('#context-detail').textContent.includes('40% context used')
  })`), { fill: '40%', known: true, label: true });
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
  await window.webContents.executeJavaScript('selectAgent("main")');
  await openCommand('model');
  controller.data.settings.fontScale = 150; window.setSize(840, 640);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  assert.equal(await window.webContents.executeJavaScript(`(() => { const box = document.querySelector('#hub-dialog').getBoundingClientRect(); return box.top >= 0 && box.bottom <= innerHeight && box.left >= 0 && box.right <= innerWidth; })()`), true, 'picker fits the minimum window with large text');
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/command-model.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript('document.querySelector("#hub-dialog").close(); true'); controller.data.settings.fontScale = 100; window.setSize(1320, 900);
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(commandAgent) + ')');
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
    return { focus: document.activeElement === dialog, cursor: getComputedStyle(dialog).cursor, backdrop: getComputedStyle(dialog, '::backdrop').cursor,
      buttonsUnselectable: [...dialog.querySelectorAll('button')].every(button => getComputedStyle(button).userSelect === 'none'),
      fits: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight };
  })()`);
  assert.deepEqual(confirmationView, { focus: true, cursor: 'default', backdrop: 'default', buttonsUnselectable: true, fits: true });
  for (const target of ['.confirmation-cancel', '.confirmation-accept', 'input']) {
    await window.webContents.executeJavaScript(`(() => {
      const dialog = document.querySelector('.confirmation-dialog');
      if (${JSON.stringify(target)} === 'input') {
        const input = document.createElement('input'); input.id = 'implicit-submit-fixture'; dialog.querySelector('form').append(input);
      }
      dialog.querySelector(${JSON.stringify(target)}).focus();
    })()`);
    if (target !== 'input') assert.equal(await window.webContents.executeJavaScript('getComputedStyle(document.activeElement).outlineStyle'), 'none');
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
    window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
    await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
    assert.equal(await window.webContents.executeJavaScript('!!document.querySelector(".confirmation-dialog[open]")'), true, 'Enter neither activates buttons nor implicitly submits forms');
  }
  await window.webContents.executeJavaScript('document.querySelector("#implicit-submit-fixture").remove(); document.querySelector(".confirmation-dialog").focus(); true');
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
  assert.equal(await window.webContents.executeJavaScript('document.activeElement === document.querySelector(".confirmation-dialog")'), true, 'reopened confirmation does not select a button');
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
  assert.equal(await window.webContents.executeJavaScript('document.activeElement === document.querySelector(".confirmation-dialog")'), true);
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/confirmation-provider.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript('document.querySelector(".confirmation-close").click(); true');
  assert.equal(await closeAnswer, false);
  const errorWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await errorWindow.loadFile(path.resolve(__dirname, '../ui/startup-error.html'), { query: { message: '<test> startup failure' } });
  assert.equal(await errorWindow.webContents.executeJavaScript('document.querySelector(".confirmation-dialog").open'), true);
  assert.equal(await errorWindow.webContents.executeJavaScript('document.querySelector("#confirmation-description").textContent'), '<test> startup failure');
  assert.equal(await errorWindow.webContents.executeJavaScript('document.activeElement.matches("dialog")'), true);
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
    chat.delegation = { id: `fake-job-${index}`, source: ownerChat.id, task: chat.title, state: 'running', startIndex: 0, delivered: false };
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
  const deferredResult = { id: 'deferred-fixture', deliveryId: 'deferred-task', type: 'agentResult', localOnly: true, text: 'Saved build evidence.',
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
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-activity-summary").textContent'), /1 saved report · review/);
  assert.equal(artifactCalls.length, 0, 'rendering a result cannot launch an artifact');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".job-result .artifact-list")'), null, 'file controls are not duplicated in chat');
  await window.webContents.executeJavaScript('openJobDetails("deferred-task")');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".artifact-path img")'), null);
  assert.match(await window.webContents.executeJavaScript('document.querySelector(".artifact-list").textContent'), /Files available/);
  await window.webContents.executeJavaScript(`document.querySelector('.artifact-row button').click(); true`);
  await until(() => artifactCalls.length === 1, 'artifact folder action reaches the runner');
  await window.webContents.executeJavaScript(`document.querySelector('.artifact-row button:last-child').click(); true`);
  await until(() => artifactCalls.length === 2, 'artifact Run is explicit');
  assert.deepEqual(artifactCalls, ['folder', 'run'].map(action => ({ action, sessionId: ownerChat.id,
    receiptId: deferredResult.id, artifactId: 'game', expectedVersion: 3 })));
  await window.webContents.executeJavaScript('document.querySelector("#job-dialog .close-dialog").click(); true');
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
      const stored = readSessionData(controller.filename).sessions.find(chat => chat.id === ownerChat.id);
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
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-activity-list").textContent'), /Builder 1 · Build game 1/);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".job-result img")'), null, 'reports are untrusted text');
  assert.ok(controller.busy, 'reports appear before their busy owner can resume');
  ownerChat.items.push({ id: 'hidden-handoff-fixture', type: 'userMessage', agentReply: true,
    content: [{ type: 'text', text: 'Internal handoff diagnostic fixture' }] });
  await publish();
  const compactReport = await window.webContents.executeJavaScript(`(() => {
    const card = document.querySelector('.job-result');
    return { open: !!card.querySelector('details'), text: card.innerText,
      hiddenHandoff: !document.querySelector('#messages').textContent.includes('Internal handoff diagnostic fixture'),
      controls: [...card.querySelectorAll(':scope > .job-result-header button')].map(button => button.textContent) };
  })()`);
  assert.equal(compactReport.open, false);
  assert.equal(compactReport.hiddenHandoff, true);
  assert.doesNotMatch(compactReport.text, /Requested by|Report and handoff|Owner:/);
  assert.deepEqual(compactReport.controls, ['View task']);
  const longReport = await window.webContents.executeJavaScript(`(() => {
    const node = document.createElement('div'), text = 'Long report. '.repeat(40);
    renderAgentResult({ agentId: selectedAgent, agentName: 'Worker', ownerName: 'Hub', title: 'Assignment', status: 'completed', text, truncated: true,
      verification: { test: { status: 'failed', checks: [] } } }, node, current());
    return { warning: node.querySelector('.message-label').textContent, preview: node.querySelector('.job-result-preview').textContent,
      duplicate: !!node.querySelector('details'), fullChat: node.querySelector('button')?.textContent };
  })()`);
  assert.match(longReport.warning, /Checks failed/);
  assert.equal(longReport.preview.trim(), 'Long report. '.repeat(40).trim(), 'the complete answer remains in chat without a duplicate in task details');
  assert.equal(longReport.duplicate, false);
  assert.equal(longReport.fullChat, 'Open full chat');
  const historicalReport = await window.webContents.executeJavaScript(`(() => {
    const node = document.createElement('div');
    renderAgentResult({ agentName: 'PhasmaHarness', status: 'completed', text:
      'Both accepted; replies are pending.\\n[task: pending]\\nSub 1 replied Yellow.\\n[task: pending]\\nBoth bots replied **Yellow**:\\n\\n| Bot | Reply |\\n| --- | --- |\\n| Sub 1 | Yellow |\\n| Sub 2 | Yellow |\\n[task: done]\\n<img src=x onerror=alert(1)>' }, node, current());
    document.querySelector('#messages').append(node);
    return { text: node.textContent, table: !!node.querySelector('table'), bold: node.querySelector('.job-result-preview strong')?.textContent, image: !!node.querySelector('img') };
  })()`);
  assert.doesNotMatch(historicalReport.text, /pending|\[task:|Both accepted|Sub 1 replied/);
  assert.equal(historicalReport.table, true);
  assert.equal(historicalReport.bold, 'Yellow');
  assert.equal(historicalReport.image, false);
  const reportExamples = [
    'Explanation\n```text\n[task: pending]\n```\nKeep this example.',
    'Explanation\n> [task: pending]\nKeep this quotation.',
    'Explanation\n    [task: pending]\nKeep this indented code.',
  ];
  for (const text of reportExamples) {
    assert.equal(await window.webContents.executeJavaScript(`reportAnswer(${JSON.stringify({ text })})`), text);
  }
  assert.equal(await window.webContents.executeJavaScript(`reportAnswer({text: 'Old progress\\n[task: pending]\\nFinal answer'})`), 'Final answer');
  assert.equal(await window.webContents.executeJavaScript(`reportAnswer({text: 'Waiting\\n[task: pending]'})`), 'Waiting');
  assert.equal(await window.webContents.executeJavaScript(`reportAnswer({finalReport: true, text: 'Example\\n[task: pending]\\nExplanation'})`), 'Example\n[task: pending]\nExplanation');
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/historical-report.png'), (await window.webContents.capturePage()).toPNG());
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/compact-reports.png'), (await window.webContents.capturePage()).toPNG());
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
    state: 'queued', access: assignment.access, task: 'Private fixture assignment <img src=x onerror=alert(1)>', title: 'Build a game', startIndex: 0, delivered: false };
  assignment.delegation.artifacts = [fixtureArtifact];
  agents.budgets.register(assignment.delegation, ownerChat, { limitMs: 7200000, limitAttempts: 20, limitTokens: null }); agents.budgets.persist();
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
  // While a bot works on another bot's assignment, its chat shows that work, read only until the result returns.
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(splitProfile.id) + ')');
  const foregroundState = await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#job-activity').open = true;
    document.querySelector('#job-activity-list .job-row button').click();
    return { selectedId, readOnly: document.querySelector('#prompt').readOnly, sendable: !document.querySelector('#send').disabled,
      modal: document.querySelector('#job-dialog').matches(':modal'), details: document.querySelector('#job-dialog').open };
  })()`);
  assert.deepEqual([foregroundState.selectedId, foregroundState.readOnly, foregroundState.sendable], [assignment.id, true, false],
    'the bot’s chat shows the assignment, read only');
  assert.notEqual(foregroundChat.id, assignment.id);
  assert.equal(foregroundState.details, true);
  assert.equal(foregroundState.modal, false, 'assignment details stay nonmodal');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-artifacts").textContent'), /Open folder.*Run/s);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-artifacts img")'), null);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-budget-summary").textContent'), /120 min/);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-budget-usage").textContent'), /0 \/ 20 attempts/);
  timeBudget.requests['cost-fixture'] = { id: 'cost-fixture', kind: 'worker', provider: 'claude-cli', complete: true,
    usage: { inputTokens: 125, cachedInputTokens: 20, outputTokens: 10, totalTokens: 135 }, providerEstimateUsd: 0.0031 };
  agents.primary.save(); await publish();
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-budget-usage").textContent'), /1 \/ 20 attempts/);
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
    const summary = document.querySelector('#job-budget-summary'); summary.scrollIntoView({ block: 'start' }); const box = summary.getBoundingClientRect();
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
  // While a bot works, its composer shows Stop where Send was; details must not cover either.
  const sendIsReachable = () => window.webContents.executeJavaScript(`(() => {
    const send = document.querySelector('#send:not([hidden])') || document.querySelector('#stop'), box = send.getBoundingClientRect();
    return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest('#' + send.id) === send;
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
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-activity-list .job-row button").click(); document.querySelector("#job-update-text").value'), 'unsent update', 'reopening assignment details keeps the unsent update');
  await window.webContents.executeJavaScript(`document.querySelector('#job-activity-list .job-row button').click();
    document.querySelector('#prompt').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-dialog").open'), false, 'outside input dismisses assignment details');
  assignment.delegation.state = 'running';
  execution.requests.set(7, { id: 7, method: 'item/commandExecution/requestApproval',
    params: { threadId: 'split-thread', command: 'Private fixture check', reason: 'Review this background action.' } });
  await publish();
  // Watched approvals open without selecting an action.
  assert.deepEqual(await window.webContents.executeJavaScript('[document.querySelector("#request-dialog").open, document.activeElement.matches("button")]'),
    [true, false], 'the watched approval never selects a button');
  const deferred = await window.webContents.executeJavaScript(`(() => {
    const dialog = document.querySelector('#request-dialog'), cancel = new Event('cancel', { cancelable: true });
    dialog.dispatchEvent(cancel); if (!cancel.defaultPrevented) dialog.close(); return !cancel.defaultPrevented;
  })()`);
  assert.equal(deferred, true, 'background approvals can be deferred through Escape');
  assert.equal(execution.requests.size, 1, 'deferring an approval does not silently allow or reject it');
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('#job-activity-list button')].find(button => button.textContent === 'Review').click();
    true`);
  assert.equal(await window.webContents.executeJavaScript('document.activeElement.matches("dialog")'), true);
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Allow once').focus(); true`);
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
  window.webContents.sendInputEvent({ type: 'char', keyCode: '\r' });
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  assert.equal(answers.length, 0, 'Enter cannot activate a focused approval button');
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('dialog[open] button')].find(button => button.textContent === 'Allow once').click(); true`);
  await until(() => answers.length === 1, 'the background approval reached its controller');
  assert.deepEqual(answers[0], { id: 7, answer: { decision: 'accept' }, agentId: splitProfile.id, contextId: assignment.id });
  console.log('Watched assignment, nonmodal assignment details, received/applied updates and deferred scoped approvals passed');
  // An approval that opens on its own never selects an action.
  const foregroundFocus = await window.webContents.executeJavaScript(`(() => {
    const saved = { requests: state.requests, reviewing: reviewingExecution };
    reviewingExecution = null; shownRequest = null;
    state.requests = [{ id: 'focus-check', method: 'item/commandExecution/requestApproval', params: { threadId: 'none', command: 'echo focus', reason: 'Focus check' } }];
    renderRequest();
    const focused = document.activeElement.matches('button');
    state.requests = saved.requests; reviewingExecution = saved.reviewing; shownRequest = null;
    renderRequest();
    return focused;
  })()`);
  assert.equal(foregroundFocus, false);
  console.log('Approvals never auto-select buttons or activate them with Enter passed');
  timeBudget.limitTokens = null;
  timeBudget.requests['unknown-cost-fixture'] = { id: 'unknown-cost-fixture', kind: 'worker', provider: 'native:deepseek',
    complete: true, usage: null, providerEstimateUsd: null };
  ownerChat.items.push({ id: 'archived-assignment-result', type: 'agentResult', localOnly: true,
    deliveryId: 'replaced-assignment', agentId: splitProfile.id, agentName: 'Split bot', ownerName: 'Hub',
    title: 'Earlier assignment', assignment: 'Earlier assignment in full, preserved after reuse.', status: 'completed', text: 'Retained report after the worker was reused.', budgetId: timeBudget.id });
  await publish(); await window.webContents.executeJavaScript('selectAgent("main")');
  await window.webContents.executeJavaScript(`(() => {
    const result = [...document.querySelectorAll('.job-result')].find(row => row.textContent.includes('Retained report after the worker was reused.'));
    [...result.querySelectorAll('button')].find(button => button.textContent === 'View task').click();
  })()`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-dialog").open'), true);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-details-log").textContent'), /Earlier assignment in full, preserved after reuse/);
  assert.doesNotMatch(await window.webContents.executeJavaScript('document.querySelector("#job-dialog").innerText'), /Owner:|Revision|Not verified|Retained report after the worker was reused/);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/task-panel-minimal.png'), (await window.webContents.capturePage()).toPNG());
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-update-form").hidden'), true, 'completed assignments hide update controls');
  await window.webContents.executeJavaScript(`document.querySelector('#job-details-log').textContent += '\\n' + 'Readable assignment instructions.\\n'.repeat(30);
    document.querySelector('#job-details-log').scrollIntoView({ block: 'start' }); true`);
  const taskLayout = await window.webContents.executeJavaScript(`(() => {
    const log = document.querySelector('#job-details-log'), budget = document.querySelector('#job-budget');
    return { logOverflow: getComputedStyle(log).overflowY, logHeight: log.clientHeight,
      budgetOverflow: getComputedStyle(budget).overflowY, summaryPosition: getComputedStyle(budget.querySelector('summary')).position };
  })()`);
  assert.equal(taskLayout.logOverflow, 'visible');
  assert.ok(taskLayout.logHeight > 500, 'assignment text keeps its natural height');
  assert.equal(taskLayout.budgetOverflow, 'visible');
  assert.equal(taskLayout.summaryPosition, 'static');
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/task-panel-readable.png'), (await window.webContents.capturePage()).toPNG());
  timeBudget.limitsEnabled = false; await publish();
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-budget").hidden'), true, 'unlimited task bots have no limits controls');
  timeBudget.limitsEnabled = true; await publish();
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-budget-summary").textContent'), /6 min/);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-budget-usage").textContent'), /2 \/ 25 attempts/);
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
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-details-log").textContent'), /Continue my direct task.*1 attached image/s);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-details-log img")'), null);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-budget-save").textContent'), 'Resume');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-budget").hidden'), false);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-budget-limit").hidden'), true);
  assert.equal(await sendIsReachable(), true);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/direct-task-budget.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('#job-budget').open = true; true`);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/unlimited-task-resume.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('#job-budget-form').dispatchEvent(new Event('submit', { cancelable: true })); true`);
  await until(() => directTask.resumedAsJobId === directTask.resumeJobId, 'direct-task Resume admits one private continuation');
  assert.equal(agents.findJob(directTask.resumeJobId).job.owner, foregroundChat.id);
  assert.equal(agents.findJob(directTask.resumeJobId).job.budgetId, directBudget.id);
  assert.equal(directBudget.limitsEnabled, false, 'resuming an unlimited task does not add limits');
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
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-copy-location").textContent'), /preview-project-copy.*Changes stay here until you apply them/s);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-copy-apply").hidden'), true, 'no Apply while the job runs');
  assert.equal(await sendIsReachable(), true);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/isolated-job-workspace.png'), (await window.webContents.capturePage()).toPNG());
  // A returned job offers Apply; the runner shows the files and asks (stubbed here), and the toast reports the result.
  const applyCalls = [];
  ipcMain.handle('applyCopy', (_event, workspace) => {
    applyCalls.push(workspace);
    return { source: root, applied: ['greet.js'] };
  });
  previewJob.delivered = true;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(preparedView) + '); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-copy-apply").hidden'), false);
  await window.webContents.executeJavaScript('document.querySelector("#job-copy-apply").click(); true');
  await until(() => applyCalls.length === 1, 'Apply reaches the runner with the copy');
  assert.equal(applyCalls[0], previewCopy.workspace);
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 50))');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#toast").textContent'), /^Applied 1 file to /);
  await window.webContents.executeJavaScript('document.querySelector("#toast").hidden = true; true');
  previewJob.delivered = false;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(preparedView) + '); true');
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
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#job-verification").textContent'), /Build: Check passed/);
  assert.doesNotMatch(await window.webContents.executeJavaScript('document.querySelector("#job-verification").textContent'), /Not verified/);
  assert.equal(await sendIsReachable(), true);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Keep my next question');
  await window.webContents.executeJavaScript(`document.querySelector('#job-dialog .close-dialog').click();
    document.querySelector('.batch-report').scrollIntoView({ block: 'start', behavior: 'instant' }); true`);
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/batch-report.png'), (await window.webContents.capturePage()).toPNG());
  console.log('Batch reports retain partial outcomes, host evidence and a usable chat composer');
  phase = 'comparison card';
  const comparisons = require('../src/comparisons.cjs');
  const compareSetup = bot => ({ hash: `setup-${bot}`, provider: 'codex', model: 'gpt-5.6-terra', effort: 'low', instructions: { bot: { hash: bot } } });
  const compareRun = (label, variant, extra) => ({ index: label === 'A' ? 1 : 2, pair: 1, label, variant, name: `Comparison 1 · ${label}`,
    result: { status: 'completed', checks: { 'greet check': 'passed' }, corrections: 0, setups: [compareSetup(variant ? 'changed' : 'base')],
      restored: [], diff: ' greet.js | 2 +-', text: `Run ${label} updated greet.js.`, tokens: 120000, activeMs: 21000,
      workspace: path.join(root, `compare-copy-${label}`), ...extra } });
  const compareRecord = { id: 'ui-compare', version: 1, at: Date.now(), project: root, task: "Change greet.js so greet('Ann') returns 'Hello, Ann!'.",
    change: "Greeting functions must return 'Hello, stranger!' for an empty name.", target: 'bot', pairs: 1, model: 'gpt-5.6-terra · low', number: 1,
    threshold: comparisons.THRESHOLD, runs: [compareRun('A', false, { corrections: 1, restored: ['check.cjs'], tokens: 155000, activeMs: 30000 }), compareRun('B', true)] };
  comparisons.finish(compareRecord);
  // Nothing landed by itself here (say the project changed meanwhile), so each run offers Apply by hand.
  compareRecord.applied = { label: 'B', workspace: path.join(root, 'compare-copy-B'), error: 'Run B was not applied: you changed greet.js since the copy was made.' };
  ownerChat.items.push({ id: 'compare-request', type: 'userMessage', content: [{ type: 'text', text: 'Compare that instruction change.' }],
    comparisonId: compareRecord.id, hubBatch: { id: 'ui-compare-batch', count: 2, dispatched: 2 } });
  ownerChat.items.push({ id: 'compare-finished', type: 'agentMessage', phase: 'final_answer', localOnly: true,
    text: 'The change helped (the change needed fewer corrections (0 instead of 1)).', hubComparison: comparisons.publicView(compareRecord) });
  // A project rule that helped: the better run landed and the rule was added, each with an Undo.
  const ruleRecord = { ...compareRecord, id: 'ui-rule', number: 2, target: 'project',
    applied: { label: 'B', workspace: path.join(root, 'compare-copy-B'), files: ['greet.js'], changes: [] },
    adopted: { file: path.join(root, 'PhasmaHarness.md'), rule: compareRecord.change } };
  ownerChat.items.push({ id: 'rule-finished', type: 'agentMessage', phase: 'final_answer', localOnly: true, text: 'The change helped.',
    hubComparison: comparisons.publicView(ruleRecord) });
  const undoCalls = [];
  ipcMain.handle('undoComparison', (_event, ...args) => {
    undoCalls.push(args);
    return {};
  });
  // The comparison's own batch report stays out of the chat and the activity bar; the card replaces it.
  const compareView = agents.snapshot();
  compareView.batchReports['ui-compare-batch'] = { id: 'ui-compare-batch', sessionId: ownerChat.id, requestId: 'compare-request', requested: 2,
    dispatched: 2, returned: 2, summary: 'COMPARISON BATCH', entries: [] };
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(compareView) + '); true');
  assert.equal(await window.webContents.executeJavaScript('!!document.querySelector(\'.batch-report[data-batch-id="ui-compare-batch"]\')'), false);
  assert.doesNotMatch(await window.webContents.executeJavaScript('document.querySelector("#job-activity-summary").textContent'), /COMPARISON BATCH/);
  const cardText = index => window.webContents.executeJavaScript(`document.querySelectorAll(".comparison-card")[${index}]?.textContent || ""`);
  const cardButtons = index => window.webContents.executeJavaScript(`[...document.querySelectorAll(".comparison-card")[${index}].querySelectorAll('button')]
    .map(button => button.getAttribute('aria-label') || button.textContent)`);
  let card = await cardText(0);
  assert.match(card, /Comparison 1 · 2 runs on gpt-5\.6-terra · low · The change helped.*Verdict: helped, low confidence/s, 'no pick: the verdict shows at once');
  assert.match(card, /A · current setup.*B · with the change.*Run B was not applied: you changed greet\.js/s);
  assert.doesNotMatch(card, /is better|Reveal|Waiting for your pick/);
  assert.equal(await window.webContents.executeJavaScript('!!document.querySelector(".comparison-card")?.closest(".assistant")'), true,
    'the card sits under Bot\'s message');
  assert.match(card, /restored before its checks: check\.cjs/);
  assert.deepEqual((await cardButtons(0)).filter(label => label.startsWith('Apply')), ["Apply run A's changes to my project", "Apply run B's changes to my project"],
    'nothing landed by itself, so Apply is offered');
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('.comparison-card button')]
    .find(button => button.getAttribute('aria-label') === "Apply run B's changes to my project").click(); true`);
  await until(() => applyCalls.length === 2, 'Apply by hand goes through the same runner command');
  assert.equal(applyCalls[1], path.join(root, 'compare-copy-B'));
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 50))');
  await window.webContents.executeJavaScript('document.querySelector("#toast").hidden = true; true');

  card = await cardText(1);
  assert.match(card, /Comparison 2 · .*Applied run B's changes to your project: greet\.js\. ?Undo.*Added the rule to Harness's kept rules for this workspace\. ?Undo/s);
  const ruleButtons = await cardButtons(1);
  assert.equal(ruleButtons.some(label => label.startsWith('Apply')), false, 'what already landed is not offered again');
  assert.ok(ruleButtons.includes('Undo the applied changes') && ruleButtons.includes('Undo the added rule'));
  await window.webContents.executeJavaScript(`document.querySelectorAll('.comparison-card')[1].scrollIntoView({ block: 'start', behavior: 'instant' });
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/comparison-finished.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('.comparison-card button')]
    .find(button => button.getAttribute('aria-label') === 'Undo the added rule').click(); true`);
  await until(() => undoCalls.length === 1, 'Undo reaches the runner');
  assert.deepEqual(undoCalls[0], [ownerChat.id, 'ui-rule', 'rule']);
  const skillRecord = { ...ruleRecord, id: 'ui-skill', number: 3, target: 'skill', skill: { name: 'workflow' },
    adopted: { skill: 'workflow' } };
  ownerChat.items.push({ id: 'skill-finished', type: 'agentMessage', phase: 'final_answer', localOnly: true, text: 'The change helped.',
    hubComparison: comparisons.publicView(skillRecord) });
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  assert.match(await cardText(2), /Change to the workflow skill:.*Kept the workflow skill for this workspace/s);
  assert.ok((await cardButtons(2)).includes('Undo the skill change'));
  await window.webContents.executeJavaScript(`document.querySelectorAll('.comparison-card')[2].scrollIntoView({ block: 'start', behavior: 'instant' });
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/skill-comparison.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`[...document.querySelectorAll('.comparison-card')[2].querySelectorAll('button')]
    .find(button => button.getAttribute('aria-label') === 'Undo the skill change').click(); true`);
  await until(() => undoCalls.length === 2, 'Skill Undo reaches the shared runner');
  assert.deepEqual(undoCalls[1], [ownerChat.id, 'ui-skill', 'skill']);
  ownerChat.items.at(-1).hubComparison.adopted.undoneAt = Date.now();
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  assert.match(await cardText(2), /Restored the previous workflow skill/);
  assert.ok(!(await cardButtons(2)).includes('Undo the skill change'));
  delete ownerChat.items.at(-1).hubComparison.adopted.undoneAt;
  ownerChat.items.at(-1).hubComparison.adopted.expiredAt = Date.now();
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  assert.match(await cardText(2), /Undo expired with the 50-comparison history/);
  assert.ok(!(await cardButtons(2)).includes('Undo the skill change'));
  await window.webContents.executeJavaScript(`document.querySelectorAll('.comparison-card')[2].scrollIntoView({ block: 'start', behavior: 'instant' });
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/skill-comparison-expired.png'), (await window.webContents.capturePage()).toPNG());
  console.log('Comparison cards show the verdict at once, what landed with Undo, and Apply only when nothing landed');
  phase = 'rule notices';
  ownerChat.items.push({ id: 'rule-kept', type: 'notice', localOnly: true, createdAt: Date.now(),
    text: 'Kept the rule "Create done.txt first." in PhasmaHarness.md: 3 matching tasks passed its check without this failure.',
    ruleNotice: { kind: 'kept', ruleId: 'r1' } });
  ownerChat.items.push({ id: 'rule-dropped', type: 'notice', localOnly: true, createdAt: Date.now(),
    text: 'Dropped the trial rule "Export greet.": the failure it targets came back.', ruleNotice: { kind: 'dropped', ruleId: 'r2' } });
  ownerChat.items.push({ id: 'rule-rolled-back', type: 'notice', localOnly: true, createdAt: Date.now(),
    text: 'Took the rule "Create done.txt first." out of PhasmaHarness.md: the failure it targets came back after it was kept.',
    ruleNotice: { kind: 'rolledBack', ruleId: 'r1' } });
  ownerChat.items.push({ id: 'rule-trial', type: 'notice', localOnly: true, createdAt: Date.now(),
    text: 'Noticed: Renamed a public export. Trying the rule "Keep export names." on similar tasks.', ruleNotice: { kind: 'trialStarted', ruleId: 'r3' } });
  ownerChat.items.push({ id: 'chat-note', type: 'notice', localOnly: true, createdAt: Date.now(),
    text: 'Noticed: Renamed a public export. Saved a note for similar tasks: "Callers import fetchUser by name."', ruleNotice: { kind: 'noteAdded', noteId: 'n1' } });
  ownerChat.items.push({ id: 'setup-preferred', type: 'notice', localOnly: true, createdAt: Date.now(),
    text: 'Auto now uses Terra for debugging work in this project: 3 of 3 tasks passed their checks first time (Sol: 2 of 3).',
    ruleNotice: { kind: 'setupPreferred', setupKind: 'debugging', preset: 'terra' } });
  const undoRuleCalls = [];
  ipcMain.handle('undoRule', (_event, ...args) => {
    undoRuleCalls.push(args);
    return {};
  });
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  const notices = await window.webContents.executeJavaScript(`[...document.querySelectorAll('.message.notice')]
    .map(node => ({ text: node.textContent, undo: node.querySelector('button')?.getAttribute('aria-label') || null }))`);
  assert.deepEqual(notices.map(notice => notice.undo), ['Undo the kept rule', null, 'Put the rule back', 'Stop trying the rule', 'Remove the note', 'Stop preferring this model'],
    'kept, rolled-back, new trial and note notices offer Undo');
  assert.match(notices[0].text, /^Kept the rule "Create done\.txt first\." in PhasmaHarness\.md/);
  assert.match(notices[1].text, /^Dropped the trial rule "Export greet\.": the failure it targets came back\.$/);
  await window.webContents.executeJavaScript(`document.querySelector('.message.notice button').click(); true`);
  await until(() => undoRuleCalls.length === 1, 'Undo of a kept rule reaches the runner');
  assert.deepEqual(undoRuleCalls[0], [ownerChat.id, 'rule-kept']);
  assert.match(notices[2].text, /^Took the rule "Create done\.txt first\." out of PhasmaHarness\.md/);
  await window.webContents.executeJavaScript(`document.querySelectorAll('.message.notice')[2].querySelector('button').click(); true`);
  await until(() => undoRuleCalls.length === 2, 'Undo of a rollback reaches the runner');
  assert.deepEqual(undoRuleCalls[1], [ownerChat.id, 'rule-rolled-back']);
  console.log('Rule notices show kept, dropped, rolled-back, new trial and note notices, with Undo for all but dropped');
  ownerChat.items.push({ id: 'skill-notice', type: 'notice', localOnly: true, createdAt: Date.now(),
    text: 'Example workspace: using bundled workflow because its saved override is unavailable.',
    skillStoreWarning: 'unavailable:workflow:fixture', skillStoreWorkspace: 'fixture-workspace' });
  ipcMain.handle('dismissSkillNotice', (_event, ...args) => {
    assert.deepEqual(args, [ownerChat.id, 'skill-notice']);
    controller.dismissSkillNotice(...args);
  });
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Dismiss skill notice"]').scrollIntoView({block: 'center', behavior: 'instant'});
    new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/skill-notice.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript(`document.querySelector('[aria-label="Dismiss skill notice"]').click(); true`);
  await until(() => !ownerChat.items.some(item => item.id === 'skill-notice'), 'skill notice dismissal reaches the runner');
  assert.equal(controller.data.skillNotices['fixture-workspace']['unavailable:workflow'], 'unavailable:workflow:fixture');
  await until(() => window.webContents.executeJavaScript(`!document.querySelector('[aria-label="Dismiss skill notice"]')`), 'dismissed notice leaves the chat');
  console.log('Skill notice offers Dismiss and is removed from the saved chat');
  phase = 'send scrolls to the newest message';
  // A render from the Undo steps above may still land and keep the chat at its end; scroll up until it stays.
  const startScroll = await window.webContents.executeJavaScript(`(async () => {
    const chat = document.querySelector('#conversation');
    for (let i = 0; i < 20; i++) {
      chat.scrollTo({ top: 0, behavior: 'instant' });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      await new Promise(resolve => setTimeout(resolve, 100));
      if (chat.scrollHeight - chat.scrollTop - chat.clientHeight > 200)
        break;
    }
    return [chat.scrollHeight, chat.scrollTop, chat.clientHeight];
  })()`);
  assert.ok(startScroll[0] - startScroll[1] - startScroll[2] > 200, 'the chat starts scrolled well above its end: ' + startScroll);
  const beforeScrollSend = sent.length;
  await submit('Show me the newest message');
  await until(() => sent.length === beforeScrollSend + 1, 'the message is sent');
  ownerChat.items.push({ id: 'scroll-sent', type: 'userMessage', content: [{ type: 'text', text: 'Show me the newest message' }], createdAt: Date.now() });
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + ');' +
    ' new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  // The chat follows new messages with a smooth scroll; give it time to settle.
  const sentInView = () => window.webContents.executeJavaScript(`(() => {
    const conversation = document.querySelector('#conversation'), chat = conversation.getBoundingClientRect();
    const message = [...document.querySelectorAll('#messages .message.user')].at(-1);
    const box = message.getBoundingClientRect();
    return { shown: message.textContent.includes('Show me the newest message') && box.top >= chat.top && box.bottom <= chat.bottom + 1,
      at: [conversation.scrollTop, conversation.scrollHeight, conversation.clientHeight, Math.round(box.top), Math.round(box.bottom), Math.round(chat.bottom)] };
  })()`);
  let view = await sentInView();
  for (let i = 0; i < 50 && !view.shown; i++) {
    await new Promise(resolve => setTimeout(resolve, 20));
    view = await sentInView();
  }
  assert.ok(view.shown, 'the sent message is in view after sending from a scrolled-up chat: ' + view.at);
  // The roll is animated and takes the same time from far back in history as from close by. Hosted Windows runners
  // report reduced motion, which makes it instant, so motion is emulated here and the reduced path checked after.
  const motion = value => window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value }] });
  window.webContents.debugger.attach('1.3');
  await motion('no-preference');
  const rolls = await window.webContents.executeJavaScript(`(async () => {
    const chat = document.querySelector('#conversation'), frame = () => new Promise(resolve => requestAnimationFrame(resolve));
    const left = () => chat.scrollHeight - chat.scrollTop - chat.clientHeight, results = [];
    for (const from of [0, Math.round((chat.scrollHeight - chat.clientHeight) * 0.8)]) {
      // Let any smooth scroll from an earlier step finish first.
      await new Promise(resolve => setTimeout(resolve, 400));
      chat.scrollTo({ top: from, behavior: 'instant' });
      await frame();
      const distance = Math.round(left()), began = performance.now();
      let between = false;
      scrollChatToEnd();
      while (left() > 1 && performance.now() - began < 2000) {
        await frame();
        between ||= chat.scrollTop > from + 1 && left() > 1;
      }
      results.push({ from, distance, ms: Math.round(performance.now() - began), between });
    }
    return results;
  })()`);
  for (const roll of rolls)
    assert.ok(roll.between && roll.ms >= 250 && roll.ms <= 500, 'an animated roll of about 300 ms: ' + JSON.stringify(rolls));
  assert.ok(Math.abs(rolls[0].ms - rolls[1].ms) <= 80, 'the same time from far and near: ' + JSON.stringify(rolls));
  await motion('reduce');
  const reducedLeft = await window.webContents.executeJavaScript(`(async () => {
    const chat = document.querySelector('#conversation');
    await new Promise(resolve => setTimeout(resolve, 400));
    chat.scrollTo({ top: 0, behavior: 'instant' });
    scrollChatToEnd();
    return Math.round(chat.scrollHeight - chat.scrollTop - chat.clientHeight);
  })()`);
  assert.ok(reducedLeft <= 1, `with reduced motion the chat jumps to the newest message at once (${reducedLeft} px left)`);
  await motion('');
  window.webContents.debugger.detach();
  console.log(`Sending from a scrolled-up chat rolls to the newest message (${rolls.map(roll => `${roll.distance} px away: ${roll.ms} ms`).join(', ')})`);
  phase = 'group chat controls';
  const groupMember = agents.primary.data.agents.find(bot => bot.name.includes(' '));
  assert.ok(groupMember, 'mention fixture includes a bot with spaces in its name');
  await window.webContents.executeJavaScript(`document.querySelector('#agents-overview').click();
    document.querySelector('#groups-add').click(); true`);
  const groupAppearance = await window.webContents.executeJavaScript('document.documentElement.dataset.appearance');
  for (const theme of ['light', 'dark']) {
    await window.webContents.executeJavaScript(`document.documentElement.dataset.appearance = '${theme}'; new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const input = document.querySelector('#group-name'), label = input.parentElement, box = input.getBoundingClientRect();
      return getComputedStyle(label).flexDirection === 'column' && box.width >= label.clientWidth - 1
        && getComputedStyle(input).outlineStyle === 'none' && getComputedStyle(document.querySelector('#group-error')).display === 'none';
    })()`), true, `${theme} group name fills a separate row with no blue outline or empty error marker`);
    fs.writeFileSync(path.resolve(__dirname, '../.scratch/mosaic/group-form-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
  }
  await window.webContents.executeJavaScript(`document.documentElement.dataset.appearance = ${JSON.stringify(groupAppearance)};
    document.querySelector('#group-name').value = 'Game team';
    [...document.querySelectorAll('#group-members input')].find(input => input.value === ${JSON.stringify(groupMember.id)}).checked = true;
    document.querySelector('#group-form').requestSubmit(); true`);
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 80))');
  const group = controller.data.sessions.find(chat => chat.group && chat.title === 'Game team');
  assert.ok(group);
  assert.equal(await window.webContents.executeJavaScript('selectedId'), group.id);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#session-title").textContent'), 'Game team');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#group-owner").hidden'), false);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-activity").hidden'), true, 'unrelated Hub work stays out of the group activity');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#main-agent-list button").getAttribute("aria-pressed")'), 'false');
  const mentionDraft = (value, caret = value.length) => window.webContents.executeJavaScript(`(() => {
    const prompt = document.querySelector('#prompt'); prompt.value = ${JSON.stringify(value)}; prompt.focus();
    prompt.setSelectionRange(${caret}, ${caret}); prompt.dispatchEvent(new Event('input', { bubbles:true }));
    return [...document.querySelectorAll('#slash-options [data-member]')].map(button => button.dataset.member);
  })()`);
  const mentionKey = key => window.webContents.executeJavaScript(`document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown', {key:${JSON.stringify(key)}, bubbles:true, cancelable:true})); true`);
  const beforeMentions = sent.length;
  assert.deepEqual(await mentionDraft('@'), ['main', groupMember.id], 'typing @ lists only this group’s coordinator and members');
  for (const theme of ['light', 'dark']) {
    await window.webContents.executeJavaScript(`document.documentElement.dataset.appearance = '${theme}'; new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    assert.equal(await window.webContents.executeJavaScript(`(() => {
      const composer = document.querySelector('#composer'), style = getComputedStyle(composer), menu = document.querySelector('#slash-menu').getBoundingClientRect();
      const neutral = document.createElement('span'); neutral.style.color = 'var(--border-strong)'; composer.append(neutral);
      const same = style.borderColor === getComputedStyle(neutral).color; neutral.remove();
      return same && menu.top >= 0 && menu.left >= 0 && menu.right <= innerWidth && menu.bottom <= innerHeight;
    })()`), true, `${theme} composer retains its neutral border and member picker fits`);
    fs.writeFileSync(path.resolve(__dirname, '../.scratch/mosaic/group-mentions-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
  }
  await window.webContents.executeJavaScript(`document.documentElement.dataset.appearance = ${JSON.stringify(groupAppearance)}; true`);
  await mentionKey('ArrowDown'); await mentionKey('Enter');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '@' + groupMember.name + ' ');
  assert.equal(sent.length, beforeMentions, 'Enter selects the bot without sending');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#slash-menu").hidden'), true);
  assert.deepEqual(await mentionDraft('@' + groupMember.name.toUpperCase()), [groupMember.id], 'mention filtering is case-insensitive and supports spaces');
  await mentionKey('Tab');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '@' + groupMember.name + ' ');
  await mentionDraft('@' + groupMember.name + ' review this', 1 + groupMember.name.length);
  await window.webContents.executeJavaScript('document.querySelector("#slash-options [data-member]").click(); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '@' + groupMember.name + ' review this', 'clicking a member preserves the following draft');
  await mentionDraft('@'); await mentionKey('Escape');
  assert.deepEqual(await window.webContents.executeJavaScript('[document.querySelector("#slash-menu").hidden, document.querySelector("#prompt").value]'), [true, '@']);
  assert.deepEqual(await mentionDraft('@unknown-bot'), []);
  await mentionKey('Enter'); assert.equal(sent.length, beforeMentions);
  await mentionDraft('@' + groupMember.name + ' review this');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#slash-menu").hidden'), true, 'typing the message body closes suggestions');
  await mentionDraft('Email test@example.com');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#slash-menu").hidden'), true, 'an email is not a routed mention');
  await window.webContents.executeJavaScript(`document.querySelector('#prompt').value = 'Review this design';
    document.querySelector('#group-mention').value = ${JSON.stringify(groupMember.id)};
    document.querySelector('#group-mention').dispatchEvent(new Event('change')); true`);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '@' + groupMember.name + ' Review this design');
  await publish();
  assert.equal(await window.webContents.executeJavaScript('selectedId'), group.id, 'state updates keep the group selected');
  await window.webContents.executeJavaScript('selectAgent("main")');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#group-mention").hidden'), true);
  await mentionDraft('@');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#slash-menu").hidden'), true, 'direct chats do not offer group mentions');
  await window.webContents.executeJavaScript('document.querySelector("#group-list button").click(); true');
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 40))');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), '@' + groupMember.name + ' Review this design', 'group draft survives switching');
  // Group options live in the group's right-click menu, not in the chat header.
  const groupMenu = action => `document.querySelector('#group-list [data-group=${JSON.stringify(group.id)}]')
    .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    document.querySelector('#agent-menu [data-action=${action}]').click();`;
  await window.webContents.executeJavaScript(`(() => {
    const row = document.querySelector('#group-list [data-group]'), box = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 40, clientY: box.bottom - 8 }));
    return new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  })()`);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/mosaic/group-menu.png'), (await window.webContents.capturePage()).toPNG());
  assert.deepEqual(await window.webContents.executeJavaScript(`(() => {
    const labels = [...document.querySelectorAll('#agent-menu button')].map(item => item.textContent);
    document.querySelector('#agent-menu').hidePopover();
    return { labels, header: !!document.querySelector('#group-edit') };
  })()`), { labels: ['Open', 'Edit', 'Delete'], header: false }, 'a group right-click offers Open, Edit and Delete, and the header has no Group button');
  await window.webContents.executeJavaScript(`selectAgent('main').then(() => { ${groupMenu('open')} })`);
  await window.webContents.executeJavaScript('new Promise(resolve => setTimeout(resolve, 40))');
  assert.equal(await window.webContents.executeJavaScript('selectedId'), group.id, 'Open in the group menu opens the group');
  await window.webContents.executeJavaScript(`${groupMenu('edit')}
    document.querySelector('#group-name').value = 'Game team updated'; document.querySelector('#group-form').requestSubmit(); true`);
  await until(() => group.title === 'Game team updated', 'Enter in the name saves the group');
  // "Saved" shows in a popup at the dialog's bottom-right corner, above it, however the dialog is scrolled.
  const savedView = await window.webContents.executeJavaScript(`(() => {
    const popup = document.querySelector('#saved-popup'), box = popup.getBoundingClientRect();
    const dialog = document.querySelector('#group-dialog'), edge = dialog.getBoundingClientRect(); dialog.scrollTop = 0;
    // The popup ignores the pointer, so it takes part in the hit test only while this checks it is on top.
    popup.style.pointerEvents = 'auto';
    const atCenter = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    popup.style.pointerEvents = '';
    return { open: dialog.open, footerHidden: dialog.querySelector('.dialog-footer').hidden, shown: popup.matches(':popover-open'),
      text: popup.textContent, onTop: popup.contains(atCenter) || atCenter === popup,
      corner: box.right <= edge.right && edge.right - box.right <= 40 && box.bottom <= edge.bottom && edge.bottom - box.bottom <= 24 };
  })()`);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/mosaic/saved-popup.png'), (await window.webContents.capturePage()).toPNG());
  assert.deepEqual(savedView, { open: true, footerHidden: true, shown: true, text: 'Saved', corner: true, onTop: true },
    'the group editor autosaves and stays open, with no Save button, and Saved shows bottom right above it');
  // "Saved" is brief: it goes when you type again, and on its own after a moment.
  assert.equal(await window.webContents.executeJavaScript(`document.querySelector('#group-name').dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#saved-popup').matches(':popover-open')`), false, 'Saved clears as soon as you edit again');
  await window.webContents.executeJavaScript(`document.querySelector('#group-name').value = 'Game team brief'; document.querySelector('#group-form').requestSubmit(); true`);
  await until(() => group.title === 'Game team brief', 'the second name saved');
  await new Promise(resolve => setTimeout(resolve, 2300));
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#saved-popup').matches(':popover-open')"), false, 'Saved disappears on its own');
  await window.webContents.executeJavaScript(`document.querySelector('#group-name').value = 'Game team updated'; document.querySelector('#group-form').requestSubmit(); true`);
  await until(() => group.title === 'Game team updated', 'the name restored');
  // Every dialog's X matches Settings': the same size and icon, red under the pointer.
  const closeButtons = await window.webContents.executeJavaScript(`[...document.querySelectorAll('dialog .close-dialog, .confirmation-close')]
    .filter(button => button.closest('.dialog-heading'))
    .map(button => [getComputedStyle(button).width, getComputedStyle(button).height, button.querySelector('svg path')?.getAttribute('d') || button.textContent])`);
  assert.ok(closeButtons.length >= 9, 'every dialog has an X: ' + closeButtons.length);
  assert.deepEqual([...new Set(closeButtons.map(button => button.join(' ')))], ['26px 26px m6 6 12 12M18 6 6 18'], 'all X buttons share one size and icon');
  const groupClose = await window.webContents.executeJavaScript(`(() => {
    const box = document.querySelector('#group-dialog .close-dialog').getBoundingClientRect();
    return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2), box: [box.left, box.top, box.width, box.height].map(Math.round) };
  })()`);
  window.webContents.sendInputEvent({ type: 'mouseMove', x: groupClose.x, y: groupClose.y });
  await new Promise(resolve => setTimeout(resolve, 80));
  const closeHover = await window.webContents.executeJavaScript(`(() => {
    const probe = document.createElement('span'); probe.style.color = 'var(--error)'; document.body.append(probe);
    const red = getComputedStyle(probe).color; probe.remove();
    return [getComputedStyle(document.querySelector('#group-dialog .close-dialog')).color, red];
  })()`);
  const [left, top, width, height] = groupClose.box;
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/mosaic/close-hover.png'),
    (await window.webContents.capturePage({ x: Math.max(0, left - 60), y: Math.max(0, top - 20), width: width + 80, height: height + 40 })).toPNG());
  window.webContents.sendInputEvent({ type: 'mouseMove', x: 5, y: 5 });
  assert.equal(closeHover[0], closeHover[1], 'the X turns red on hover');
  await window.webContents.executeJavaScript(`document.querySelector('#group-name').value = 'Game team typed';
    document.querySelector('#group-dialog').dispatchEvent(new Event('cancel', { cancelable: true })); true`);
  await until(() => group.title === 'Game team typed', 'Esc saves a name still being typed');
  await until(async () => !(await window.webContents.executeJavaScript("document.querySelector('#group-dialog').open")), 'Esc closes the group editor after saving');
  await window.webContents.executeJavaScript(`${groupMenu('edit')}
    document.querySelector('#group-name').value = 'Game team updated'; document.querySelector('#group-dialog .close-dialog').click(); true`);
  await until(() => group.title === 'Game team updated', 'X saves before closing');
  await publish();
  assert.equal(await sendIsReachable(), true);
  // A direct group reply belongs to its worker context, including Stop and questions.
  const groupWorker = agents.execution(groupMember.id), beforeGroupBusy = groupWorker.busy;
  const groupWork = groupWorker.create(root, 'read-only');
  groupWork.groupChatId = group.id; groupWork.threadId = 'group-ui-thread'; groupWork.title = group.title;
  groupWorker.busy = groupWork.id;
  group.groupTurn = { agentId: groupMember.id, name: groupMember.name, sessionId: groupWork.id, state: 'running' };
  group.items.push({ id: 'group-ui-user', type: 'userMessage', localOnly: true, content: [{ type:'text', text: '@' + groupMember.name + ' What should we test next?' }] },
    { id: 'group-ui-reply', type: 'agentMessage', phase:'final_answer', localOnly:true, groupSpeaker: { id: groupMember.id, name: groupMember.name }, text: 'Test the current build and check the failing cases from this conversation.' });
  await window.webContents.executeJavaScript('document.querySelector("#prompt").value = ""; true');
  await publish();
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#stop").hidden'), false, 'Stop is available without a busy Hub');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#working-text").textContent'), /is replying/);
  assert.equal(await window.webContents.executeJavaScript('writer(current().items.at(-1), current())'), groupMember.name);
  assert.equal(await window.webContents.executeJavaScript(`(() => {
    const label = document.querySelector('#messages .group-speaker');
    return label?.textContent === ${JSON.stringify(groupMember.name)} && !label.closest('.message-actions') && label.getBoundingClientRect().height > 0;
  })()`), true, 'a group reply names its bot without hover');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#job-activity").hidden'), true, 'a direct reply adds no task handoff');
  let stoppedGroup;
  ipcMain.removeHandler('stop'); ipcMain.handle('stop', (_event, id) => { stoppedGroup = id; });
  await window.webContents.executeJavaScript('document.querySelector("#stop").click(); true');
  await until(() => stoppedGroup === group.id, 'Stop targets the group rather than the pinned Main chat');
  groupWorker.requests.set('group-input', { id: 'group-input', method: 'item/tool/requestUserInput', params: { threadId: groupWork.threadId,
    questions: [{ id:'target', question:'Which build should I check?', options:[] }] } });
  group.groupTurn.state = 'needs-input';
  let groupAnswer;
  ipcMain.removeHandler('answer'); ipcMain.handle('answer', async (_event, id, answer, agentId, contextId) => {
    groupAnswer = { id, answer, agentId, contextId }; groupWorker.requests.delete(id); await publish();
  });
  await publish();
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#request-dialog").open'), true);
  await window.webContents.executeJavaScript(`document.querySelector('#request-content input').value = 'Debug';
    [...document.querySelectorAll('#request-content button')].find(button => button.textContent === 'Send answers').click(); true`);
  await until(() => !!groupAnswer, 'the direct worker received its answer');
  assert.deepEqual(groupAnswer, { id: 'group-input', answer: { answers: { target: 'Debug' } }, agentId: groupMember.id, contextId: groupWork.id });
  groupWorker.busy = beforeGroupBusy; delete group.groupTurn;
  await publish();
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#stop").hidden'), true);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#request-dialog").open'), false);
  for (const theme of ['light', 'dark']) {
    await window.webContents.executeJavaScript(`document.documentElement.dataset.appearance = '${theme}'; new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    fs.writeFileSync(path.resolve(__dirname, '../.scratch/mosaic/group-direct-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
  }
  await window.webContents.executeJavaScript(`document.documentElement.dataset.appearance = ${JSON.stringify(groupAppearance)}; true`);
  ipcMain.removeHandler('stop'); ipcMain.handle('stop', (_event, id) => { stoppedAgent = agents.owner(id).agentId; });
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/group-chat.png'), (await window.webContents.capturePage()).toPNG());
  // Who replies: members appear unticked, ticks number the reply order, and the arrows and drag reorder it.
  const otherMember = agents.primary.data.agents.find(bot => bot.id !== groupMember.id);
  const repliers = await window.webContents.executeJavaScript(`(() => {
    ${groupMenu('edit')}
    const member = [...document.querySelectorAll('#group-members input')].find(input => input.value === ${JSON.stringify(otherMember.id)});
    member.checked = true; member.dispatchEvent(new Event('change', { bubbles: true }));
    const rows = () => [...document.querySelectorAll('#group-repliers .group-replier')];
    const before = rows().map(row => [row.dataset.id, row.querySelector('input').checked]);
    for (const row of rows()) row.querySelector('input').click();
    rows()[0].querySelector('[data-step="1"]').click();
    const swapped = rows().map(row => [row.dataset.id, row.querySelector('.replier-rank').textContent,
      row.querySelector('[data-step="-1"]').disabled, row.querySelector('[data-step="1"]').disabled]);
    const transfer = new DataTransfer(), [top, bottom] = rows(), box = bottom.getBoundingClientRect();
    top.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    bottom.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer, clientY: box.bottom - 1 }));
    top.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
    const list = document.querySelector('#group-repliers');
    return { before, swapped, dragged: replyOrder(), fits: list.scrollWidth <= list.clientWidth };
  })()`);
  assert.deepEqual(repliers.before, [[groupMember.id, false], [otherMember.id, false]], 'members join Who replies unticked, in member order');
  assert.deepEqual(repliers.swapped, [[otherMember.id, '1', true, false], [groupMember.id, '2', false, true]], 'the down arrow swaps the order and renumbers it');
  assert.deepEqual(repliers.dragged, [groupMember.id, otherMember.id], 'dragging a row below another moves it there');
  assert.equal(repliers.fits, true, 'Who replies rows fit without horizontal scrolling');
  for (const theme of ['light', 'dark']) {
    await window.webContents.executeJavaScript(`document.documentElement.dataset.appearance = '${theme}'; new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))`);
    fs.writeFileSync(path.resolve(__dirname, '../.scratch/mosaic/group-repliers-' + theme + '.png'), (await window.webContents.capturePage()).toPNG());
  }
  const repliersWindowSize = window.getSize();
  window.setSize(390, 844); await new Promise(resolve => setTimeout(resolve, 80));
  const narrow = await window.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#group-repliers'), arrow = list.querySelector('[data-step="1"]').getBoundingClientRect();
    return { width: innerWidth, fits: list.scrollWidth <= list.clientWidth, arrow: [Math.round(arrow.width), Math.round(arrow.height)] };
  })()`);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/mosaic/group-repliers-narrow.png'), (await window.webContents.capturePage()).toPNG());
  window.setSize(...repliersWindowSize); await new Promise(resolve => setTimeout(resolve, 50));
  console.log(`Who replies at ${narrow.width} px: rows fit ${narrow.fits}, arrow ${narrow.arrow.join('×')} px`);
  assert.equal(narrow.fits, true, 'Who replies rows fit a narrow window');
  assert.ok(narrow.arrow[0] >= 24 && narrow.arrow[1] >= 24, 'Who replies arrows stay tappable');
  await window.webContents.executeJavaScript(`document.documentElement.dataset.appearance = ${JSON.stringify(groupAppearance)};
    true`);
  await until(() => group.group.members.length === 2 && group.group.replyOrder.length === 2, 'ticks, arrows and drag autosaved the Who replies edit');
  assert.deepEqual(group.group.replyOrder, [groupMember.id, otherMember.id]);
  await window.webContents.executeJavaScript("document.querySelector('#group-dialog .close-dialog').click(); true");
  await until(async () => !(await window.webContents.executeJavaScript("document.querySelector('#group-dialog').open")), 'X closes the group editor');
  // The runner's state push (main.cjs forwards it; this harness publishes by hand) brings the saved order back.
  await publish();
  await window.webContents.executeJavaScript(`${groupMenu('edit')}
    const order = replyOrder(); document.querySelector('#group-dialog').close(); order`).then(order =>
    assert.deepEqual(order, [groupMember.id, otherMember.id], 'reopening the editor shows the saved order ticked'));
  assert.equal(await window.webContents.executeJavaScript(`${groupMenu('edit')}
    const archive = !!document.querySelector('#group-archive'); document.querySelector('#group-dialog').close(); archive`), false, 'the group editor has no Archive button');
  await window.webContents.executeJavaScript(`${groupMenu('delete')}
    document.querySelector('#delete-heading').textContent + '|' + document.querySelector('#delete-title').textContent`).then(text =>
    assert.equal(text, 'Delete group?|Game team updated', 'Delete asks to confirm, naming the group'));
  await window.webContents.executeJavaScript("document.querySelector('#delete-form').requestSubmit(); new Promise(resolve => setTimeout(resolve, 300))");
  const deleteRefusal = await window.webContents.executeJavaScript("document.querySelector('#delete-error').hidden ? '' : document.querySelector('#delete-error').textContent");
  await until(() => !controller.data.sessions.some(chat => chat.id === group.id), 'the group was deleted' + (deleteRefusal ? ': ' + deleteRefusal : ''));
  await until(async () => await window.webContents.executeJavaScript('document.querySelector("#group-section").hidden'), 'the deleted group leaves the sidebar');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#delete-dialog").open'), false);
  console.log('Group creation, targeted mention controls, preserved drafts, autosaved edits and delete passed');
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
  // Send now describes what each provider will actually do with the message.
  const sendNowTitles = await window.webContents.executeJavaScript(`(() => {
    const saved = state.coordinator;
    state.coordinator = false;
    const titles = ['codex', 'claude-cli', 'native:deepseek', 'cursor-cli', 'native:muse', 'test-api', 'native:antigravity'].map(sendNowTitle);
    state.coordinator = saved;
    return titles;
  })()`);
  assert.deepEqual(sendNowTitles, ['Send into the running turn now', 'Send to the provider’s own queue; it answers after the current step',
    'Cancel the current step, then send this in the same session', 'Cancel the current step, then send this in the same session',
    'Add this to the running turn now', 'Add this to the running turn now', 'Stop the current turn, then send this message with conversation context']);
  console.log('Send now describes each provider’s delivery passed');
  // A message on its way after Send now leaves the queue list at once; only a failed send brings it back.
  const queueRows = await window.webContents.executeJavaScript(`(() => {
    const session = current();
    const saved = session.queue;
    session.queue = [{ id: 'on-its-way', text: 'Use the new requirement', images: [] }];
    render();
    const queued = document.querySelectorAll('#message-queue .queued-message').length;
    session.queue[0].sending = true;
    render();
    const sending = document.querySelectorAll('#message-queue .queued-message').length;
    session.queue = saved;
    render();
    return [queued, sending];
  })()`);
  assert.deepEqual(queueRows, [1, 0], 'Send now removes the message and its Send now button from the queue list');
  console.log('A sent queued message leaves the queue list passed');
  phase = 'reply suggestions';
  // One call per answer; grey text while the draft matches its start; Right arrow at the end accepts; off hides it.
  const suggestionCalls = [];
  ipcMain.removeHandler('replySuggestion');
  ipcMain.handle('replySuggestion', (_event, id) => { suggestionCalls.push(id); return { itemId: 'suggest-answer', text: 'Now add tests for it.' }; });
  const suggestionUi = await window.webContents.executeJavaScript(`(async () => {
    document.querySelectorAll('dialog[open]').forEach(dialog => dialog.close());
    const settle = () => new Promise(resolve => setTimeout(resolve, 50));
    window.painted = () => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const session = current() || state.sessions.find(entry => !entry.archived);
    window.suggestionSaved = { session, selectedId, busy: state.busy, queue: session.queue };
    session.queue = [];
    selectedId = session.id;
    session.items.push({ id: 'suggest-answer', type: 'agentMessage', phase: 'final_answer', text: 'Here is the parser.' });
    state.busy = null;
    state.settings.replySuggestions = true;
    const prompt = document.querySelector('#prompt'), ghost = document.querySelector('#prompt-ghost');
    prompt.value = '';
    render(); render();
    await settle();
    const empty = { hidden: ghost.hidden, text: ghost.textContent, placeholder: prompt.placeholder, described: prompt.getAttribute('aria-description') };
    prompt.value = 'now add';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    const typed = { hidden: ghost.hidden, grey: ghost.lastChild?.textContent };
    const box = prompt.getBoundingClientRect(), overlay = ghost.getBoundingClientRect();
    const aligned = Math.abs(box.left - overlay.left) < 1 && Math.abs(box.top - overlay.top) < 1;
    await painted();
    const rect = document.querySelector('#composer').getBoundingClientRect();
    return { empty, typed, aligned, rect: { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) } };
  })()`);
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/reply-suggestion-typed.png'), (await window.webContents.capturePage(suggestionUi.rect)).toPNG());
  // Touch screens have no Right arrow: a button beside Send accepts the suggestion there, and only there.
  const acceptButton = () => window.webContents.executeJavaScript(`(() => { const button = document.querySelector('#suggestion-accept');
    const box = button.getBoundingClientRect(), composer = document.querySelector('#composer').getBoundingClientRect();
    const send = document.querySelector('#send').getBoundingClientRect();
    return [button.hidden, box.width > 20 && box.left >= composer.left && box.right <= send.left, matchMedia('(pointer: coarse)').matches]; })()`);
  assert.deepEqual(await acceptButton(), [false, false, false], 'with a mouse, the suggestion button stays out of the way');
  window.webContents.debugger.attach('1.3');
  await window.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  assert.deepEqual(await acceptButton(), [false, true, true], 'on a touch screen the suggestion has a button beside Send');
  await window.webContents.executeJavaScript('painted()');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/reply-suggestion-touch.png'), (await window.webContents.capturePage(suggestionUi.rect)).toPNG());
  assert.deepEqual(await window.webContents.executeJavaScript(`(() => {
    document.querySelector('#suggestion-accept').click();
    const prompt = document.querySelector('#prompt'), result = [prompt.value, document.querySelector('#suggestion-accept').hidden];
    prompt.value = 'now add';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    return result;
  })()`), ['now add tests for it.', true], 'tapping it accepts the suggestion');
  await window.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled', { enabled: false });
  window.webContents.debugger.detach();
  Object.assign(suggestionUi, await window.webContents.executeJavaScript(`(async () => {
    const prompt = document.querySelector('#prompt'), ghost = document.querySelector('#prompt-ghost');
    prompt.setSelectionRange(prompt.value.length, prompt.value.length);
    prompt.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
    const accepted = { value: prompt.value, hidden: ghost.hidden };
    prompt.value = 'something else';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    const diverged = ghost.hidden;
    prompt.value = '';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    // A long suggestion wraps with the draft and grows the composer instead of being cut off.
    suggestion = { itemId: 'suggest-answer', text: 'Please add tests for the parser that cover empty input, nested brackets, unicode names, very long lines, and the error messages users see when a file is broken.' };
    prompt.value = 'Please add';
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    await painted();
    const promptBox = prompt.getBoundingClientRect(), ghostBox = ghost.getBoundingClientRect();
    const long = { hidden: ghost.hidden, lines: Math.round(promptBox.height / parseFloat(getComputedStyle(prompt).lineHeight)),
      sameBox: Math.abs(promptBox.top - ghostBox.top) < 1 && Math.abs(promptBox.height - ghostBox.height) < 1, clipped: ghost.scrollHeight > ghost.clientHeight + 1 };
    const rect = document.querySelector('#composer').getBoundingClientRect();
    return { accepted, diverged, long, rect: { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) } };
  })()`));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/reply-suggestion-long.png'), (await window.webContents.capturePage(suggestionUi.rect)).toPNG());
  const suggestionOff = await window.webContents.executeJavaScript(`(async () => {
    state.settings.replySuggestions = false;
    render();
    const hidden = document.querySelector('#prompt-ghost').hidden;
    const saved = window.suggestionSaved;
    saved.session.items.pop();
    saved.session.queue = saved.queue;
    state.settings.replySuggestions = undefined;
    selectedId = saved.selectedId;
    state.busy = saved.busy;
    document.querySelector('#prompt').value = '';
    render();
    return hidden;
  })()`);
  // A suggestion that arrives after the user sent (the chat is busy) is dropped.
  ipcMain.removeHandler('replySuggestion');
  ipcMain.handle('replySuggestion', async () => {
    await new Promise(resolve => setTimeout(resolve, 200));
    return { itemId: 'suggest-late', text: 'Now add tests for it.' };
  });
  const lateHidden = await window.webContents.executeJavaScript(`(async () => {
    const session = current() || state.sessions.find(entry => !entry.archived), saved = { selectedId, busy: state.busy, queue: session.queue };
    selectedId = session.id;
    session.queue = [];
    session.items.push({ id: 'suggest-late', type: 'agentMessage', phase: 'final_answer', text: 'Done.' });
    state.busy = null;
    state.settings.replySuggestions = true;
    render();
    state.busy = session.id;
    await new Promise(resolve => setTimeout(resolve, 400));
    const hidden = document.querySelector('#prompt-ghost').hidden && suggestion === null;
    session.items.pop();
    session.queue = saved.queue;
    state.settings.replySuggestions = undefined;
    selectedId = saved.selectedId;
    state.busy = saved.busy;
    render();
    return hidden;
  })()`);
  assert.equal(lateHidden, true, 'a suggestion that arrives after sending is not shown');
  // A read-only chat (a sub-bot's, or a bot working on another bot's task) asks for no suggestion and shows none.
  ipcMain.removeHandler('replySuggestion');
  const readOnlyCalls = [];
  ipcMain.handle('replySuggestion', (_event, id) => {
    readOnlyCalls.push(id);
    return { itemId: 'suggest-watched', text: 'Now add tests for it.' };
  });
  const watchedHidden = await window.webContents.executeJavaScript(`(async () => {
    const session = current() || state.sessions.find(entry => !entry.archived);
    window.suggestionSaved = { selectedId, busy: state.busy, queue: session.queue, session };
    selectedId = session.id;
    session.queue = [];
    session.items.push({ id: 'suggest-watched', type: 'agentMessage', phase: 'final_answer', text: 'Done for the other bot.' });
    state.busy = null;
    state.settings.replySuggestions = true;
    state.watching = true;
    render();
    await new Promise(resolve => setTimeout(resolve, 200));
    return document.querySelector('#prompt-ghost').hidden;
  })()`);
  assert.deepEqual([watchedHidden, readOnlyCalls.length], [true, 0], 'a read-only chat asks for no suggestion and shows none');
  await window.webContents.executeJavaScript(`(() => {
    const saved = window.suggestionSaved;
    state.watching = false;
    saved.session.items.pop();
    saved.session.queue = saved.queue;
    state.settings.replySuggestions = undefined;
    selectedId = saved.selectedId;
    state.busy = saved.busy;
    render();
    return true;
  })()`);
  ipcMain.removeHandler('replySuggestion');
  assert.equal(suggestionCalls.length, 1, 'the same answer asks for a suggestion once');
  assert.deepEqual(suggestionUi.empty, { hidden: false, text: 'Now add tests for it.', placeholder: '', described: 'Suggested reply, Right arrow accepts: Now add tests for it.' });
  assert.deepEqual(suggestionUi.typed, { hidden: false, grey: ' tests for it.' });
  assert.equal(suggestionUi.aligned, true, 'the grey text sits over the composer');
  assert.deepEqual(suggestionUi.accepted, { value: 'now add tests for it.', hidden: true });
  assert.equal(suggestionUi.diverged, true, 'a different draft hides the suggestion');
  assert.deepEqual({ ...suggestionUi.long, lines: suggestionUi.long.lines >= 2 }, { hidden: false, lines: true, sameBox: true, clipped: false }, 'a long suggestion grows the composer and stays aligned');
  assert.equal(suggestionOff, true, 'turning the setting off hides the suggestion');
  console.log('Reply suggestions show, follow the draft and accept with Right arrow passed');
  phase = 'tips';
  // The same tip shows on the new-chat screen and in the popup from the bulb next to Settings: arrows move between tips,
  // "I got it" retires one, each new chat moves on, and Settings turns both off and on.
  controller.data.settings.chatScanModel = undefined;
  await window.webContents.executeJavaScript('localStorage.removeItem("harness.tips.gotIt"); applyState(' + JSON.stringify(agents.snapshot()) +
    '); selectSession(null); new Promise(r => setTimeout(r, 100))');
  const tips = () => window.webContents.executeJavaScript(`(() => {
    const read = area => ({ hidden: area.hidden, text: area.querySelector('.tips-text')?.textContent || '', counters: area.querySelectorAll('.tips-count').length,
      buttons: [...area.querySelectorAll('button')].map(button => button.textContent), ticks: area.querySelectorAll('input').length });
    return { welcome: !document.querySelector('#welcome').hidden, icon: !document.querySelector('#tips-button').hidden,
      card: read(document.querySelector('#tips')), popup: read(document.querySelector('#tips-popup')) };
  })()`);
  const click = selector => window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
  const busyChat = agents.allControllers().flatMap(context => context.data.sessions).find(session => session.items.length && !session.archived);
  // Opening a chat with messages and then a new chat moves on to another tip.
  const seenTips = [];
  let shownTips = await tips();
  for (let index = 0; index < 3; index++) {
    assert.deepEqual([shownTips.welcome, shownTips.icon, shownTips.card.hidden, shownTips.card.ticks], [true, true, false, 0]);
    seenTips.push(shownTips.card.text);
    await window.webContents.executeJavaScript(`selectSession(${JSON.stringify(busyChat.id)}).then(() => selectSession(null)).then(() => new Promise(r => setTimeout(r, 50)))`);
    shownTips = await tips();
  }
  assert.equal(new Set(seenTips).size, seenTips.length, 'each new chat shows a different tip');
  // The arrows go round every tip and back; with the checker off, its tip is one of them.
  const allTips = async () => {
    const texts = [(await tips()).card.text];
    for (let index = 0; index < 80; index++) {
      await click('#tips [aria-label="Next tip"]');
      const text = (await tips()).card.text;
      if (text === texts[0])
        break;
      texts.push(text);
    }
    return texts;
  };
  const everyTip = await allTips();
  assert.ok(everyTip.length >= 40, `many tips apply (${everyTip.length})`);
  for (let index = 0; index < everyTip.length && !/^Turn on the chat checker/.test(shownTips.card.text); index++) {
    await click('#tips [aria-label="Next tip"]');
    shownTips = await tips();
  }
  assert.match(shownTips.card.text, /^Turn on the chat checker/, 'the chat checker tip shows while the checker is off');
  assert.deepEqual([shownTips.card.buttons, shownTips.card.counters], [['‹', '›', 'I got it'], 0], 'arrows and I got it, no counter and no Show tips tick');

  // Hover shows the same tip in the popup; leaving hides it; a click keeps it open until a click outside.
  await window.webContents.executeJavaScript("document.querySelector('#tips-button').dispatchEvent(new MouseEvent('mouseenter')); true");
  shownTips = await tips();
  assert.deepEqual([shownTips.popup.hidden, shownTips.popup.text, shownTips.popup.buttons], [false, shownTips.card.text, shownTips.card.buttons], 'the popup shows the same tip');
  await window.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/tips.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript("document.querySelector('#tips-button').dispatchEvent(new MouseEvent('mouseleave')); new Promise(r => setTimeout(r, 350))");
  assert.equal((await tips()).popup.hidden, true, 'leaving the bulb hides the popup');
  await click('#tips-button');
  await window.webContents.executeJavaScript("document.querySelector('#tips-button').dispatchEvent(new MouseEvent('mouseleave')); new Promise(r => setTimeout(r, 350))");
  assert.equal((await tips()).popup.hidden, false, 'a click keeps it open');

  // The popup's arrows move both views; I got it retires the tip everywhere.
  await click('#tips-popup [aria-label="Next tip"]');
  shownTips = await tips();
  assert.ok(shownTips.popup.text && !/^Turn on the chat checker/.test(shownTips.popup.text), 'the arrow moved on');
  assert.equal(shownTips.card.text, shownTips.popup.text, 'card and popup move together');
  await click('#tips-popup [aria-label="Previous tip"]');
  assert.match((await tips()).card.text, /^Turn on the chat checker/);
  await click('#tips-popup .tips-got-it');
  shownTips = await tips();
  assert.ok(!/^Turn on the chat checker/.test(shownTips.card.text), 'I got it retires the tip');
  const afterGotIt = await allTips();
  assert.equal(afterGotIt.length, everyTip.length - 1, 'one tip fewer');
  assert.ok(!afterGotIt.some(text => /^Turn on the chat checker/.test(text)), 'the retired tip never comes round again');
  assert.match(await window.webContents.executeJavaScript('localStorage.getItem("harness.tips.gotIt")'), /checker/);
  await window.webContents.executeJavaScript("document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); true");
  assert.equal((await tips()).popup.hidden, true, 'a click outside closes it');

  // Settings → General → Show tips turns off the card and the bulb, and back on.
  await window.webContents.executeJavaScript(`(async () => {
    await document.querySelector('#settings').onclick();
    const select = document.querySelector('#settings-show-tips');
    select.value = 'off';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
  })()`);
  assert.equal(controller.data.settings.showTips, false);
  shownTips = await tips();
  assert.deepEqual([shownTips.card.hidden, shownTips.icon], [true, false]);
  await window.webContents.executeJavaScript(`(async () => {
    const select = document.querySelector('#settings-show-tips');
    select.value = 'on';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    document.querySelector('#settings-dialog').close();
    localStorage.removeItem('harness.tips.gotIt');
  })()`);
  assert.equal(controller.data.settings.showTips, true);
  shownTips = await tips();
  assert.deepEqual([shownTips.card.hidden, shownTips.icon], [false, true]);
  console.log('Tips show on new chats and from the bulb, with arrows, I got it, hover and pinned popups, and the Settings option turns them off and on');
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
      const icons = ['.composer-access svg', '.context-ring', '#dictate svg', '#send svg']
        .map(selector => document.querySelector(selector).getBoundingClientRect().width);
      const send = document.querySelector('#send').getBoundingClientRect();
      const ring = document.querySelector('.context-ring').getBoundingClientRect();
      const microphone = document.querySelector('#dictate svg').getBoundingClientRect();
      const attach = document.querySelector('#attach-files').getBoundingClientRect();
      const shield = document.querySelector('.composer-access').getBoundingClientRect();
      const rightGapDifference = Math.abs((microphone.left - ring.right) - (send.left - microphone.right));
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
    assert.ok(zoomLayout.rightGapDifference < 1, 'visible gaps between context ring, microphone and Send are equal');
    assert.ok(Math.abs(zoomLayout.leftGap) < 1, 'shield sits next to plus without extra gap');
    assert.ok(Math.abs(zoomLayout.sizeRatio - 1) < .01, 'composer buttons have consistent hit areas');
    assert.equal(zoomLayout.fontScale, '1', 'whole-page zoom does not also multiply text size');
  }
  console.log('Whole-interface zoom at 50%, 115%, 300% and consistent composer icons passed');
  const resultPreview = await window.webContents.executeJavaScript(`(() => {
    const saved = { state, fleetState };
    try {
      fleetState = null;
      state = { ...state, agents: [{ id: 'main', name: 'Main Bot' }], conversationId: 'preview', busy: null, requests: [], waitingForAgents: [],
        sessions: [{ id: 'preview', items: [
          { type: 'agentMessage', text: 'Queued the task.' },
          { type: 'agentResult', text: 'The wiki was read.', status: 'completed' },
          { type: 'agentResult', text: 'Hidden comparison.', internal: true },
          { type: 'agentResult', text: 'Outdated result.', superseded: true }
        ] }] };
      renderAgents();
      return document.querySelector('#main-agent-list button').title;
    } finally { state = saved.state; fleetState = saved.fleetState; renderAgents(); }
  })()`);
  assert.match(resultPreview, /The wiki was read\./);
  assert.doesNotMatch(resultPreview, /Queued the task|Hidden comparison|Outdated result/);
  console.log('Direct result sidebar preview replaces the queued acknowledgement passed');
  phase = 'Mosaic light and dark layouts';
  await require('./mosaic-ui-check.cjs')(window);
  agents.closing = true;
  agents.budgets.close();
  for (const c of agents.allControllers()) c.close();
  phase = 'group IPC round trip';
  await require('./group-chat-ui-check.cjs')(window, root, ipcMain);
  window.destroy();
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(`UI smoke failed during ${phase}:`, error.stack); app.exit(1); });
// Chromium still owns files here during shutdown; cleanup is left to the temp directory.
