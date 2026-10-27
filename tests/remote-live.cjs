// Isolated HTTP/Electron acceptance: native providers and inference are replaced, transport and UI are real.
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const wrapper = !process.versions.electron;
const root = wrapper ? fs.mkdtempSync(path.join(os.tmpdir(), 'harness-remote-live-')) : process.env.PHASMA_REMOTE_TEST_ROOT;
if (!root || path.dirname(path.resolve(root)) !== fs.realpathSync(os.tmpdir()) ||
    !path.basename(root).startsWith('harness-remote-live-')) throw new Error('Unexpected remote fixture directory.');

if (wrapper) {
  const { spawnOwned, stopTree } = require('../src/process-tree.cjs');
  const child = spawnOwned(spawn, require('electron'), [__filename, '--background'], {
    windowsHide: true, stdio: 'inherit', env: { ...process.env, PHASMA_REMOTE_TEST_ROOT: root },
  });
  let expired = false;
  const timer = setTimeout(() => { expired = true; stopTree(child).catch(console.error); }, 70000);
  child.once('error', error => console.error(error.message));
  child.once('close', async code => {
    clearTimeout(timer);
    const remaining = await stopTree(child);
    if (expired || code || remaining.length) process.exitCode = 1;
    if (fs.existsSync(path.join(root, 'port'))) {
      const port = Number(fs.readFileSync(path.join(root, 'port'), 'utf8'));
      try { await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(1000) });
        throw new Error('The private browser listener survived Quit.'); }
      catch (error) { if (error.message === 'The private browser listener survived Quit.') { console.error(error.message); process.exitCode = 1; } }
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
} else {
  app.setPath('appData', root);
  app.disableHardwareAcceleration();
  BrowserWindow.prototype.show = function () {};
  const { Controller } = require('../src/controller.cjs');
  Controller.prototype.warmRouter = () => {};
  Controller.prototype.isCoordinator = () => false;
  Controller.prototype.initialize = async function () {
    this.account = { type: 'chatgpt', planType: 'fixture' };
    this.models = [{ model: 'gpt-5.6-terra', displayName: 'Fixture worker', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }];
    const models = this.models;
    this.codex = { installed: true, connected: true, signedIn: true };
    this.data.settings.museEnabled = false;
    const muse = this.nativeCLIs.get('native:muse');
    muse.status = { installed: true, loggedIn: true }; muse.refresh = async () => muse.status;
    muse.models = [{ id: 'native:muse:muse-fixture', provider: 'native:muse', model: 'muse-fixture', label: 'Fixture Muse',
      rank: 35, worker: true, router: false, efforts: [], effort: null }];
    muse.login = () => { throw new Error('Browser must not start native sign-in.'); };
    const deepseek = this.nativeCLIs.get('native:deepseek');
    deepseek.status = { installed: true, loggedIn: false }; deepseek.refresh = async () => deepseek.status;
    deepseek.login = () => { throw new Error('Browser must not start native sign-in.'); };
    this.data.settings.mode = 'terra-light'; this.data.settings.routerPreset = 'codex:gpt-5.6-terra:low';
    this.data.settings.routing = 'smart'; this.data.settings.jevEnabled = false;
    this.client.start = async () => {};
    this.client.call = async (method, params) => {
      if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'fixture' } };
      if (method === 'model/list') return { data: models };
      if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || randomUUID() } };
      if (method === 'thread/items/list') return { data: [], nextCursor: null };
      if (method === 'turn/start') return { turn: { id: randomUUID() } };
      if (method === 'turn/interrupt') queueMicrotask(() => this.notification({ method: 'turn/completed',
        params: { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } } }));
      return {};
    };
    await this.bridge.start(); this.connection = 'ready'; this.changed();
  };
  const main = require('../src/main.cjs');
  let phase = 'runner startup';
  const deadline = setTimeout(() => { console.error('Remote UI check timed out during ' + phase); app.exit(1); }, 60000);
  const until = async predicate => {
    for (let i = 0; i < 240; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    throw new Error('Remote UI condition timed out.');
  };
  app.whenReady().then(async () => {
    await until(() => BrowserWindow.getAllWindows()[0] && main.controller()?.connection === 'ready');
    const desktop = BrowserWindow.getAllWindows()[0];
    await until(() => !desktop.webContents.isLoadingMainFrame());
    const c = main.controller(), session = c.agents.conversation(c, true, root, 'read-only'); c.load(session.id);
    const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    phase = 'starting browser access';
    const info = await desktop.webContents.executeJavaScript(`window.router.remoteStart({port:${port},origin:null})`);
    assert.equal(info.running, true);
    const userData = app.getPath('userData'), sealed = fs.readFileSync(path.join(userData, 'credentials.phasma-remote.enc'));
    assert.equal(fs.existsSync(path.join(userData, 'credentials.phasma-remote')), false, 'the desktop never keeps a plaintext browser key');
    assert.equal(sealed.includes(new URLSearchParams(new URL(info.connectionURL).hash.slice(1)).get('key')), false);
    fs.writeFileSync(path.join(root, 'port'), String(port));
    const phone = new BrowserWindow({ width: 390, height: 844, useContentSize: true, show: false,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false } });
    const errors = [];
    phone.webContents.on('console-message', (_event, level, message) => { if (level >= 3) errors.push(String(message)); });
    phase = 'phone authentication and initial UI';
    await phone.loadURL(info.connectionURL);
    await until(() => phone.webContents.executeJavaScript('!!window.router && !!document.querySelector("#session-title")?.textContent.includes("Assistant")'));
    assert.equal(await phone.webContents.executeJavaScript('window.router.remote'), true);
    assert.equal(await phone.webContents.executeJavaScript('location.hash'), '', 'the shared key leaves the visible URL immediately');
    assert.equal(await phone.webContents.executeJavaScript('document.querySelector(".remote-login").hidden'), true);
    assert.equal(await phone.webContents.executeJavaScript('window.router.remoteInfo().then(()=>false,()=>true)'), true);
    phase = 'browser provider connections';
    await phone.webContents.executeJavaScript('document.querySelector("#settings").click(); document.querySelector("#tab-providers").click(); true');
    const plug = id => `document.querySelector('[data-connection-provider="${id}"] .provider-plug')`;
    await until(() => phone.webContents.executeJavaScript(`!!${plug('native:muse')} && !${plug('native:muse')}.disabled`));
    await phone.webContents.executeJavaScript(`${plug('native:muse')}.click(); true`);
    await until(() => c.data.settings.museEnabled === true);
    await until(() => phone.webContents.executeJavaScript(`${plug('native:muse')}.getAttribute('aria-label').startsWith('Disconnect')`));
    await phone.webContents.executeJavaScript('document.querySelector("#renew-models").click(); true');
    await until(() => phone.webContents.executeJavaScript('document.querySelector("#provider-status").textContent.includes("Models refreshed")'));
    assert.equal(c.data.settings.museEnabled, true, 'Renew preserves the enabled plug');
    await phone.webContents.executeJavaScript(`${plug('native:muse')}.click(); true`);
    await until(() => c.data.settings.museEnabled === false && !c.agents.providerChanging);
    assert.equal(c.nativeCLIs.get('native:muse').status.loggedIn, true);
    await phone.webContents.executeJavaScript(`${plug('native:deepseek')}.click(); true`);
    await until(() => phone.webContents.executeJavaScript('document.querySelector("#provider-status").textContent.includes("runner host")'));
    assert.notEqual(c.data.settings.deepseekEnabled, true);
    await phone.webContents.executeJavaScript(`${plug('codex')}.click(); true`);
    await until(() => c.data.settings.chatgptEnabled === false && !c.agents.providerChanging);
    await until(() => phone.webContents.executeJavaScript(`${plug('codex')}.getAttribute('aria-label').startsWith('Connect ')`));
    await phone.webContents.executeJavaScript(`${plug('codex')}.click(); true`);
    await until(() => c.data.settings.chatgptEnabled === true && !c.agents.providerChanging);
    await phone.webContents.executeJavaScript('document.querySelector("#tab-general").click(); document.querySelector("#settings-dialog").close(); true');
    phase = 'remote document extraction';
    const pdf = require('./fixtures/documents.cjs').pdf('Remote document proof');
    const document = await phone.webContents.executeJavaScript(`HarnessDocuments.read('proof.pdf',new Uint8Array(${JSON.stringify([...pdf])}).buffer)`);
    assert.equal(document.format, 'pdf');
    assert.match(document.text, /Remote document proof/);
    phase = 'held remote submission';
    const before = Date.now();
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAUSURBVAiZY2RgYPjPwMDAwMQABQAOKAEDtjjK0wAAAABJRU5ErkJggg==';
    await phone.webContents.executeJavaScript(`window.router.send({id:${JSON.stringify(session.id)},clientId:${JSON.stringify(randomUUID())},text:'Hold this remote request',images:[${JSON.stringify(image)}],mode:'terra-light',task:'off'})`);
    assert.ok(Date.now() - before < 1000, 'a saved remote submission returns before the held model turn');
    assert.equal(c.busy, session.id);
    desktop.close();
    assert.equal(desktop.isDestroyed(), false);
    await phone.webContents.executeJavaScript('document.querySelector("#prompt").value="typing while work runs"; true');
    assert.equal(await phone.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'typing while work runs');
    phase = 'remote Stop';
    await phone.webContents.executeJavaScript(`window.router.stop(${JSON.stringify(session.id)})`);
    await until(() => !c.busy);
    phase = 'browser ZIP download';
    fs.mkdirSync(path.join(root, 'export', 'assets'), { recursive: true });
    fs.writeFileSync(path.join(root, 'export', 'game.txt'), 'portable game fixture');
    fs.writeFileSync(path.join(root, 'export', 'assets', 'Καλημέρα.txt'), 'required assets');
    const artifact = { ...await require('../src/artifacts.cjs').inspect(root, 'export'),
      id: 'export', scopeId: 'fixture', version: 1, publishedAt: Date.now() };
    session.items.push({ id: 'artifact-fixture-export', type: 'agentArtifact', localOnly: true, artifact, createdAt: Date.now() });
    c.save(); c.changed();
    await until(() => phone.webContents.executeJavaScript('[...document.querySelectorAll(".artifact-row button")].some(b=>b.textContent==="Download ZIP")'));
    assert.equal(await phone.webContents.executeJavaScript('[...document.querySelectorAll(".artifact-row button")].some(b=>b.textContent==="Open folder")'), false);
    const destination = path.join(root, 'received.zip');
    const downloaded = new Promise((resolve, reject) => {
      phone.webContents.session.once('will-download', (_event, item, contents) => {
        try {
          assert.equal(contents, phone.webContents);
          assert.equal(item.getFilename(), 'export.zip');
          item.setSavePath(destination);
          item.once('done', (_downloadEvent, status) => status === 'completed' ? resolve() : reject(new Error('Download ' + status)));
        } catch (error) { item.cancel(); reject(error); }
      });
    });
    await phone.webContents.executeJavaScript('[...document.querySelectorAll(".artifact-row button")].find(b=>b.textContent==="Download ZIP").click(); true');
    await downloaded;
    const received = require('fflate').unzipSync(fs.readFileSync(destination));
    assert.equal(Buffer.from(received['game.txt']).toString(), 'portable game fixture');
    assert.equal(Buffer.from(received['assets/Καλημέρα.txt']).toString(), 'required assets');
    await until(() => !c.agents.downloads.busy);
    phase = 'browser download Stop control';
    await c.agents.downloads.prepare(artifact);
    await until(() => phone.webContents.executeJavaScript('[...document.querySelectorAll("#job-activity-list button")].some(b=>b.textContent==="Stop downloads")'));
    await phone.webContents.executeJavaScript('document.querySelector("#job-activity").open=true; [...document.querySelectorAll("#job-activity-list button")].find(b=>b.textContent==="Stop downloads").click(); true');
    await until(() => !c.agents.downloads.busy);
    assert.equal(await phone.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'typing while work runs');
    session.items.push({ id: randomUUID(), type: 'agentMessage', text: 'Unicode separator\u2028received', localOnly: true, createdAt: Date.now() });
    c.save(); c.changed();
    await until(() => phone.webContents.executeJavaScript('document.querySelector("#messages").textContent.includes("Unicode separator")'));
    phase = 'originating-view confirmation';
    await phone.webContents.executeJavaScript('window.remoteClear=window.router.clearConversation("main"); true');
    await until(() => phone.webContents.executeJavaScript('!!document.querySelector("dialog.confirmation-dialog[open]")'));
    await phone.webContents.executeJavaScript('document.querySelector("dialog.confirmation-dialog[open] .confirmation-cancel").click(); true');
    assert.equal((await phone.webContents.executeJavaScript('window.remoteClear')).cleared, false);
    phase = 'phone settings and layout';
    await phone.webContents.executeJavaScript('document.querySelector("#settings").click(); true');
    await until(() => phone.webContents.executeJavaScript('document.querySelector("#settings-dialog").open'));
    assert.equal(await phone.webContents.executeJavaScript('getComputedStyle(document.querySelector("#remote-settings")).display'), 'none');
    await phone.webContents.executeJavaScript('document.querySelector("#settings-appearance").value="dark"; document.querySelector("#settings-appearance").dispatchEvent(new Event("change",{bubbles:true})); true');
    assert.equal(await phone.webContents.executeJavaScript('document.documentElement.dataset.appearance'), 'dark');
    phone.webContents.setZoomFactor(1.5);
    await phone.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    const settingsLayout = await phone.webContents.executeJavaScript('(()=>{const d=document.querySelector("#settings-dialog");return {open:d.open,scroll:d.scrollWidth,width:d.clientWidth}})()');
    fs.mkdirSync(path.resolve(__dirname, '../.scratch'), { recursive: true });
    fs.writeFileSync(path.resolve(__dirname, '../.scratch/remote-phone-settings.png'), (await phone.webContents.capturePage()).toPNG());
    assert.equal(settingsLayout.open, true);
    assert.ok(settingsLayout.width > 100);
    assert.ok(settingsLayout.scroll <= settingsLayout.width + 1, 'phone Settings remains readable with enlarged text');
    await phone.webContents.executeJavaScript('document.querySelector("#settings-appearance").value="light"; document.querySelector("#settings-appearance").dispatchEvent(new Event("change",{bubbles:true})); true');
    phone.webContents.setZoomFactor(1);
    assert.equal(await phone.webContents.executeJavaScript('document.querySelector("#prompt").value'), 'typing while work runs');
    await phone.webContents.executeJavaScript('document.querySelector("#settings-dialog").close(); true');
    await phone.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
    fs.mkdirSync(path.resolve(__dirname, '../.scratch'), { recursive: true });
    fs.writeFileSync(path.resolve(__dirname, '../.scratch/remote-phone.png'), (await phone.webContents.capturePage()).toPNG());
    const layout = await phone.webContents.executeJavaScript('({width:innerWidth,body:document.body.scrollWidth,prompt:document.querySelector("#prompt").getBoundingClientRect().toJSON()})');
    fs.writeFileSync(path.resolve(__dirname, '../.scratch/remote-phone-layout.json'), JSON.stringify(layout, null, 2));
    assert.ok(layout.body <= layout.width + 1, 'the phone page has no horizontal overflow');
    assert.ok(layout.prompt.width >= 220, 'the phone composer retains usable space');
    assert.deepEqual(errors, [], 'the browser UI has no renderer errors');
    phase = 'phone logout';
    await phone.webContents.executeJavaScript('window.router.disconnect()');
    await until(() => phone.webContents.executeJavaScript('!document.querySelector(".remote-login").hidden'));
    assert.equal(c.busy, null);
    const oldKey = new URLSearchParams(new URL(info.connectionURL).hash.slice(1)).get('key');
    const reset = await desktop.webContents.executeJavaScript('window.router.remoteResetLink()');
    assert.notEqual(reset.connectionURL, info.connectionURL);
    const oldLink = await fetch(`http://127.0.0.1:${port}/api/pair`, { method: 'POST',
      headers: { Origin: info.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: oldKey }) });
    assert.equal(oldLink.status, 401, 'resetting the connection link invalidates the old shared key');
    phone.destroy();
    phase = 'Quit after browser cleanup failure';
    await c.agents.downloads.prepare(artifact);
    const remote = require('../src/remote.cjs').RemoteRunner.prototype, close = remote.close;
    remote.close = async function () { await close.call(this); throw new Error('Fixture browser cleanup failure.'); };
    app.once('will-quit', () => {
      clearTimeout(deadline);
      if (c.agents.downloads.busy) { console.error('Browser cleanup failure skipped runner shutdown.'); app.exit(1); return; }
      console.log('Remote UI passed: authenticated phone, saved submission, independent Stop, ZIP download with assets, hidden desktop, scoped confirmation, logout and Quit despite browser cleanup failure.');
    });
    app.quit();
  }).catch(error => { clearTimeout(deadline); console.error(error.stack); app.exit(1); });
}
