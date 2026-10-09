// Run with Electron, not Node. No provider login or inference is performed.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Controller } = require('../src/controller.cjs');
const { confirmations } = require('../src/confirmations.cjs');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-ui-'));
app.setPath('userData', root);
// Xvfb runners may lack a working GPU readback path for offscreen screenshots.
app.disableHardwareAcceleration();
fs.mkdirSync(path.resolve(__dirname, '../.scratch'), { recursive: true });
const deadline = setTimeout(() => { console.error('UI startup timed out'); app.exit(1); }, 15000);
app.whenReady().then(async () => {
  const controller = new Controller(path.join(root, 'sessions.json'), root);
  ipcMain.handle('bootstrap', () => controller.snapshot());
  const browseCalls = [];
  ipcMain.handle('browseWorkspace', (_event, ...args) => { browseCalls.push(args); return { available: false, entries: [] }; });
  let previews = 0;
  ipcMain.handle('preview', () => { previews++; return { label: 'Auto', reason: 'Smoke test' }; });
  const sent = [];
  let failSend = false;
  ipcMain.handle('create', (_event, workspace, access) => controller.create(workspace, access));
  const savedChecks = [];
  ipcMain.handle('checks', (_event, workspace, list) => { savedChecks.push(list); return controller.checks(workspace, list); });
  ipcMain.handle('settings', (_event, values) => controller.settings(values));
  ipcMain.handle('providerSettings', (_event, value) => controller.providerSettings(value));
  ipcMain.handle('providerKey', () => controller.snapshot());
  ipcMain.handle('appInfo', () => ({ version: '0.1.0', packaged: true }));
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
  let modelRequests = 0, failModels = false, finishFetch, nextModels = [];
  ipcMain.handle('providerModels', async () => {
    modelRequests++;
    await new Promise(resolve => { finishFetch = resolve; });
    if (failModels) throw new Error('Test model fetch failed');
    return nextModels;
  });
  // Offscreen rendering keeps hidden-window captures current, including modal top layers.
  const window = new BrowserWindow({ show: false, webPreferences: { preload: path.resolve(__dirname, '../src/preload.cjs'), contextIsolation: true, sandbox: true, backgroundThrottling: false, offscreen: true } });
  const confirmation = confirmations(window);
  ipcMain.handle('answerConfirmation', (_event, id, accepted) => confirmation.answer(id, accepted));
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
  const submit = (text, wait = true) => window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#prompt').value = ${JSON.stringify(text)};
    document.querySelector('#prompt').dispatchEvent(new Event('input'));
    document.querySelector('#composer').dispatchEvent(new Event('submit', { cancelable: true }));
    for (let i = 0; ${wait} && i < 100 && submitting; i++) await new Promise(resolve => setTimeout(resolve, 20));
  })()`);
  const until = async (condition, what) => { for (let i = 0; i < 100 && !condition(); i++) await new Promise(r => setTimeout(r, 20)); assert.ok(condition(), what); };
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
  assert.deepEqual(writers, ['Codex', 'Claude', 'Cursor', 'Jev', 'Codex']);
  console.log('Reply labels name their provider passed');
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
  controller.providers = { configured: () => false, key: () => ({ remove() {} }) };
  controller.codex = { installed: true, connected: true };
  await window.webContents.executeJavaScript(`(async () => {
    document.querySelector('#api-name').value = 'LM Studio';
    document.querySelector('#api-url').value = 'http://localhost:1234/v1';
    document.querySelector('#api-add').click();
    await new Promise(r => setTimeout(r, 300));
  })()`);
  assert.deepEqual(controller.data.settings.providers.map(p => [p.id, p.name, p.baseUrl]), [['lm-studio', 'LM Studio', 'http://localhost:1234/v1']]);
  const apiRows = await window.webContents.executeJavaScript("[...document.querySelectorAll('.api-provider-row span')].map(e => e.textContent)");
  assert.deepEqual(apiRows, ['LM Studio · http://localhost:1234/v1']);
  const groups = await window.webContents.executeJavaScript("[...document.querySelectorAll('#provider-model-list .provider-model-group')].map(e => e.textContent)");
  assert.ok(groups.includes('LM Studio'), JSON.stringify(groups));
  controller.data.settings.providers = [];
  console.log('API providers can be added from Settings passed');
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
  // Removing a check and pressing the dialog's Save persists the removal (it used to need "Save checks").
  controller.data.settings.checks[controller.data.settings.workspace] = [{ id: 'c1', name: 'Syntax', argv: ['node', '--check', 'demo.js'], cwd: controller.data.settings.workspace, timeoutMs: 120000, readOnlySafe: false }];
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); renderChecks(); true');
  assert.equal(await window.webContents.executeJavaScript("document.querySelectorAll('#checks-list .check-row').length"), 1);
  await window.webContents.executeJavaScript(`(async () => {
    [...document.querySelectorAll('#checks-list .check-row button')].find(b => b.textContent === 'Remove').click();
    document.querySelector('#settings-form').dispatchEvent(new Event('submit', { cancelable: true }));
    await new Promise(r => setTimeout(r, 300));
  })()`);
  assert.deepEqual(savedChecks.at(-1), [], 'the removal was saved');
  assert.deepEqual(controller.data.settings.checks[controller.data.settings.workspace], []);
  console.log('Removed checks are saved by the dialog Save passed');
  // Settings shows the app version; the manual update check reports and links, and never downloads.
  await window.webContents.executeJavaScript("document.querySelector('#settings').click(); new Promise(r => setTimeout(r, 200))");
  await window.webContents.executeJavaScript("document.querySelector('#tab-version').click(); true");
  assert.deepEqual(await window.webContents.executeJavaScript(`({
    selected: document.querySelector('#tab-version').getAttribute('aria-selected'),
    visiblePanels: [...document.querySelectorAll('.settings-panel')].filter(panel => !panel.hidden).map(panel => panel.id),
    controlsMoved: ['app-version', 'copy-diagnostics', 'open-logs', 'check-updates', 'install-update', 'open-release', 'diagnostics-status', 'update-status'].every(id => document.querySelector('#' + id).closest('#panel-version'))
  })`), { selected: 'true', visiblePanels: ['panel-version'], controlsMoved: true });
  await new Promise(resolve => setTimeout(resolve, 100));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/settings-version.png'), (await window.webContents.capturePage()).toPNG());
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
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#panel-version').hidden"), true);
  console.log('Version and manual update check passed');
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
  assert.equal(await window.webContents.executeJavaScript("getComputedStyle(document.querySelector('#effort-cap option[value=high]')).color"), 'rgb(185, 198, 177)', 'other options keep their color');
  await window.webContents.executeJavaScript("document.querySelector('#settings').click(); new Promise(r => setTimeout(r, 200))");
  const settingsCap = await window.webContents.executeJavaScript("[document.querySelector('#settings-effort-cap').value, document.querySelector('#effort-cap-detail').textContent]");
  assert.equal(settingsCap[0], 'max');
  assert.match(settingsCap[1], /^⚠ No cap: Auto may pick max effort.*Your manual picks are not capped\.$/);
  await window.webContents.executeJavaScript("document.querySelector('#settings-effort-cap').value = 'high'; document.querySelector('#settings-effort-cap').onchange(); document.querySelector('#settings-form').dispatchEvent(new Event('submit', { cancelable: true })); new Promise(r => setTimeout(r, 300))");
  assert.equal(controller.data.settings.effortCap, 'high');
  assert.deepEqual((await cap()).filter((_, i) => i === 1 || i === 3), ['high', false]);
  const manual = controller.catalog().find(p => p.worker && controller.available(p));
  if (manual) {
    await window.webContents.executeJavaScript('applyState(' + JSON.stringify({ ...controller.snapshot(), settings: { ...controller.snapshot().settings, mode: manual.id } }) + '); true');
    assert.equal((await cap())[0], true, 'hidden for a manual model');
    await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); true');
  }
  // Codex-like composer: access on the left, model picker and cap on the right, each as wide as its selected text.
  const layout = await window.webContents.executeJavaScript(`(() => {
    const box = id => document.querySelector(id).getBoundingClientRect();
    const preset = document.querySelector('#preset');
    return { accessBeforeModel: box('#permissions').right < box('#preset').left, capAfterModel: box('#preset').right <= box('#effort-cap').left,
      inModel: !!preset.closest('.composer-model'), fitted: preset.style.width !== '' && box('#preset').width < 260 };
  })()`);
  assert.deepEqual(layout, { accessBeforeModel: true, capAfterModel: true, inModel: true, fitted: true });
  console.log('Effort cap passed');
  // Compare with Jev: shown only with a Jev key while Smart routes, with the agreement so far.
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').close(); true");
  const compareRow = () => window.webContents.executeJavaScript("[document.querySelector('#jev-compare-row').hidden, document.querySelector('#jev-compare-detail').textContent]");
  await window.webContents.executeJavaScript("document.querySelector('#settings').click(); new Promise(r => setTimeout(r, 200))");
  assert.equal((await compareRow())[0], true, 'hidden without a Jev key');
  controller.smartRouter.jev = { configured: true };
  controller.jevCompare = { summary: () => ({ compared: 4, errors: 1, sameWorker: 1, sameModel: 2, sameProvider: 3, manual: 2, manualSameModel: 1, costUsd: 0.0004 }) };
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').close(); true");
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + "); document.querySelector('#settings').click(); new Promise(r => setTimeout(r, 200))");
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
  controller.smartRouter.jev = { configured: true, health: { since: null, error: null, at: null } };
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + '); true');
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#jev-health').textContent"), '');
  controller.data.settings.contextRanking = savedRanking;
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#settings-output')"), null, 'large output is always captured, not a setting');
  console.log('Jev fallback status passed');
  controller.smartRouter.jev = undefined; controller.jevCompare = null;
  controller.trace = require('../src/trace.cjs').NO_TRACE;
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(controller.snapshot()) + "); document.querySelector('#settings').click(); new Promise(r => setTimeout(r, 200))");
  assert.equal(await window.webContents.executeJavaScript("document.querySelector('#wiki-check-row').hidden"), true, 'hidden without a Jev key');
  await window.webContents.executeJavaScript("document.querySelector('#settings-dialog').close(); true");
  console.log('Compare with Jev and wiki check settings passed');
  const { Agents } = require('../src/agents.cjs');
  const { EventEmitter } = require('node:events');
  const agents = new Agents(controller, async () => {}, (file, workspace, options) => {
    const client = new EventEmitter(); client.close = () => {};
    client.call = async () => { throw new Error('UI smoke must not start a provider'); };
    const worker = new Controller(file, workspace, client, { cancel() {}, close() {} }, options);
    worker.initialize = async () => { worker.connection = 'ready'; worker.models = controller.models; worker.account = controller.account; };
    return worker;
  });
  ipcMain.removeHandler('bootstrap'); ipcMain.handle('bootstrap', () => agents.snapshot());
  ipcMain.handle('saveAgent', (_event, profile) => agents.saveAgent(profile));
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
  await window.webContents.executeJavaScript('document.querySelector(\'#agent-list [data-agent="' + profile.id + '"]\').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: innerWidth - 2, clientY: innerHeight - 2 })); true');
  const menuView = await window.webContents.executeJavaScript(`(() => {
    const menu = document.querySelector('#agent-menu'), box = menu.getBoundingClientRect();
    return { open: menu.matches(':popover-open'), labels: [...menu.querySelectorAll('button')].map(b => b.textContent),
      color: getComputedStyle(menu.querySelector('[data-action=delete]')).color,
      inBounds: box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight };
  })()`);
  assert.equal(menuView.open, true);
  assert.deepEqual(menuView.labels, ['Open', 'Edit', 'Delete']);
  assert.equal(menuView.color, 'rgb(255, 145, 137)');
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
  await window.webContents.executeJavaScript(`document.querySelector('#prompt').value = 'Researcher draft'; imageDrafts.set(draftKey(), ['data:image/png;base64,']); selectAgent('main')`);
  assert.notEqual(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Researcher draft');
  assert.equal(await window.webContents.executeJavaScript('attachedImages().includes("data:image/png;base64,")'), false);
  await window.webContents.executeJavaScript('selectAgent(' + JSON.stringify(profile.id) + ')');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Researcher draft');
  assert.equal(await window.webContents.executeJavaScript('attachedImages().length'), 1);
  await window.webContents.executeJavaScript('imageDrafts.delete(draftKey()); document.querySelector("#prompt").value = ""; true');
  const worker = agents.controller(profile.id), workerSession = worker.create();
  worker.busy = workerSession.id; workerSession.status = 'running';
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  assert.equal(await window.webContents.executeJavaScript('state.busy'), workerSession.id);
  await window.webContents.executeJavaScript('api.stop(); true');
  await until(() => stoppedAgent === profile.id, 'Stop targets the selected agent');
  await window.webContents.executeJavaScript('selectAgent("main")');
  assert.equal(await window.webContents.executeJavaScript('state.busy'), controller.busy);
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#agent-list").textContent'), /ResearcherWorking/);
  stoppedAgent = null;
  await window.webContents.executeJavaScript('document.querySelector(\'#agent-list [data-agent="' + profile.id + '"]\').dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true })); true');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-menu [data-action=delete]").disabled'), true, 'Busy agents cannot be deleted from the menu');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#agent-menu [data-action=edit]").disabled'), true, 'Busy agents cannot be edited from the menu');
  await window.webContents.executeJavaScript('document.querySelector("#agent-menu [data-action=stop]").click(); true');
  await until(() => stoppedAgent === profile.id, 'Context menu Stop targets its agent, not the selected conversation');
  worker.busy = null;
  const waitingState = agents.snapshot();
  waitingState.agentStates[profile.id].waitingForAgents = [workerSession.id];
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(waitingState) + '); true');
  assert.match(await window.webContents.executeJavaScript('document.querySelector("#agent-list").textContent'), /ResearcherWaiting/);
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
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#sessions, #new-session, #workspace, #welcome h2, #welcome p")'), null, 'Session UI and the selected welcome text are removed');
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
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'Main draft stays');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#main-agent-list [data-action=delete]")'), null, 'Main cannot be deleted');
  const names = ['Researcher', 'Reviewer', 'Builder', 'Test runner', 'Documentation', 'Planner', 'Code search', 'UI designer', 'Release notes', 'Performance', 'Refactor', 'Verifier'];
  for (const name of names) await agents.saveAgent({ name, instructions: '', workspace: root, mode: 'auto', access: 'read-only' });
  await agents.initialize();
  controller.data.settings.fontScale = 150;
  window.setSize(840, 640);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  const agentLayout = await window.webContents.executeJavaScript(`(() => {
    const list = document.querySelector('#agent-list'), main = document.querySelector('#main-agent-list');
    const before = main.getBoundingClientRect().top; list.scrollTop = list.scrollHeight;
    return { scrolls: list.scrollHeight > list.clientHeight, room: list.clientHeight > 100, pinned: main.getBoundingClientRect().top === before,
      controlsFit: document.querySelector('#agent-actions').getBoundingClientRect().bottom <= innerHeight };
  })()`);
  assert.deepEqual(agentLayout, { scrolls: true, room: true, pinned: true, controlsFit: true });
  controller.data.settings.fontScale = 100; window.setSize(1320, 900);
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); selectAgent(' + JSON.stringify(agents.primary.data.agents[0].id) + ')');
  await window.webContents.executeJavaScript('document.querySelector("#toast").hidden = true; true');
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/agents-sidebar.png'), (await window.webContents.capturePage()).toPNG());
  console.log('Agent creation, persistent chat selection, chat-only task requests, deletion, pinned Main and sidebar scrolling passed');
  const compacted = [];
  ipcMain.handle('compact', (_event, id) => { compacted.push(id); });
  let clearPrompts = 0;
  ipcMain.handle('clearConversation', async (_event, id) => {
    const fresh = await agents.clearConversation(id, name => {
      clearPrompts++;
      return confirmation.ask({ title: 'Start a fresh conversation?', message: `Clear the current context for ${name} and start with a blank chat.`,
        details: [{ label: 'Fresh context', text: 'The current conversation, draft and attachments leave the chat.' },
          { label: 'Same agent', text: 'Role, workspace and access stay the same.' }],
        note: 'Your previous conversation is archived on this computer.', confirmLabel: 'Clear conversation', cancelLabel: 'Keep conversation', danger: true });
    });
    return { cleared: !!fresh, sessionId: fresh?.id, state: agents.snapshot() };
  });
  const commandAgent = await window.webContents.executeJavaScript('selectedAgent');
  const oldConversation = agents.conversation(agents.controller(commandAgent), true);
  const mainConversationId = agents.conversation(controller).id;
  oldConversation.items.push({ id: 'clear-history', type: 'agentMessage', text: 'Earlier agent history.' });
  await window.webContents.executeJavaScript('applyState(' + JSON.stringify(agents.snapshot()) + '); true');
  const sentBeforeCommands = sent.length, previewsBeforeCommands = previews;
  const typeCommand = text => window.webContents.executeJavaScript(`(() => {
    const prompt = document.querySelector('#prompt'); prompt.focus(); prompt.value = ${JSON.stringify(text)};
    prompt.setSelectionRange(prompt.value.length, prompt.value.length); prompt.dispatchEvent(new Event('input'));
    return [...document.querySelectorAll('#slash-options code')].map(node => node.textContent);
  })()`);
  const commandKey = key => window.webContents.executeJavaScript(`document.querySelector('#prompt').dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true })); true`);
  assert.deepEqual(await typeCommand('/'), ['/help', '/compact', '/clear', '/stop', '/agents', '/settings']);
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("#slash-menu").hidden'), false);
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/slash-menu.png'), (await window.webContents.capturePage()).toPNG());
  assert.deepEqual(await typeCommand('/C'), ['/compact', '/clear'], 'prefix matching ignores case');
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
  assert.deepEqual(await typeCommand('/'), ['/help', '/compact', '/clear', '/stop', '/agents', '/settings'], 'removing a prefix restores all commands');
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
  assert.deepEqual(await window.webContents.executeJavaScript('[...document.querySelectorAll("#commands-list code")].map(node => node.textContent)'), ['/help', '/compact', '/clear', '/stop', '/agents', '/settings']);
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
  const closeAnswer = confirmation.ask({ title: 'Close Harness?', message: 'Agents are still working. Closing Harness will stop all running tasks.',
    confirmLabel: 'Stop and close', cancelLabel: 'Keep working', danger: true });
  await waitForDialog();
  assert.equal(await window.webContents.executeJavaScript('document.activeElement.textContent'), 'Keep working');
  await new Promise(resolve => setTimeout(resolve, 200));
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/confirmation-close.png'), (await window.webContents.capturePage()).toPNG());
  await window.webContents.executeJavaScript('document.querySelector(".confirmation-close").click(); true');
  assert.equal(await closeAnswer, false);
  const errorWindow = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, sandbox: true } });
  await errorWindow.loadFile(path.resolve(__dirname, '../ui/startup-error.html'), { query: { message: '<test> startup failure' } });
  assert.equal(await errorWindow.webContents.executeJavaScript('document.querySelector(".confirmation-dialog").open'), true);
  assert.equal(await errorWindow.webContents.executeJavaScript('document.querySelector("#confirmation-description").textContent'), '<test> startup failure');
  assert.equal(await errorWindow.webContents.executeJavaScript('document.activeElement.textContent'), 'Close Harness');
  errorWindow.destroy();
  console.log('Styled clear/close/startup dialogs, cancel defaults, Escape and visible cursor styles passed');
  agents.closing = true;
  for (const c of agents.controllers.values()) c.close();
  window.destroy();
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error.stack); app.exit(1); });
// Chromium still owns files here during shutdown; cleanup is left to the temp directory.
