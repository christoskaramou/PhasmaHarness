// Isolated Electron lifecycle check: no native providers, credentials, inference or login-item writes.
const { app, BrowserWindow } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const childClient = process.argv.includes('--probe-client');
const wrapper = !process.versions.electron;
const root = wrapper ? fs.mkdtempSync(path.join(os.tmpdir(), 'harness-runner-live-')) : process.env.PHASMA_RUNNER_TEST_ROOT;
if (!root || !path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(root).startsWith('harness-runner-live-')) throw new Error('Unexpected lifecycle test directory.');
if (wrapper) {
  const { spawnOwned, stopTree } = require('../src/process-tree.cjs');
  const child = spawnOwned(spawn, require('electron'), [__filename, '--background'], {
    windowsHide: true, stdio: 'inherit', env: { ...process.env, PHASMA_RUNNER_TEST_ROOT: root },
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; stopTree(child).catch(console.error); }, 40000);
  child.once('error', error => console.error(error.message));
  child.once('close', async code => {
    clearTimeout(timer);
    await stopTree(child);
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) { console.error(error.message); process.exitCode = 1; }
    if (timedOut || code !== 0) {
      console.error(timedOut ? 'Runner did not exit before the lifecycle deadline.' : `Runner exited with code ${code}.`);
      process.exitCode = 1;
    }
  });
} else {
app.setPath('appData', root);
const { Controller } = require('../src/controller.cjs');
Controller.prototype.initialize = async function () { this.connection = 'ready'; };
Controller.prototype.warmRouter = () => {};
let shows = 0;
BrowserWindow.prototype.show = function () { shows++; };
const main = require('../src/main.cjs');

if (!childClient) {
  const watchdog = setTimeout(() => { console.error('Runner lifecycle check timed out.'); app.exit(1); }, 30000);
  app.whenReady().then(async () => {
    for (let i = 0; i < 200; i++) {
      const window = BrowserWindow.getAllWindows()[0];
      if (window && !window.webContents.isLoadingMainFrame() && main.controller()?.connection === 'ready') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    const controller = main.controller();
    assert.ok(controller);
    const window = BrowserWindow.getAllWindows()[0];
    await window.webContents.executeJavaScript("document.querySelector('#prompt').value = 'draft survives close'; true");
    const session = controller.create(root, 'read-only');
    controller.busy = session.id;
    controller.requests.set('waiting-approval', { id: 'waiting-approval' });
    window.close();
    assert.equal(window.isDestroyed(), false);
    assert.equal(controller.busy, session.id);
    assert.equal(controller.requests.has('waiting-approval'), true);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('#prompt').value"), 'draft survives close');
    const child = spawn(process.execPath, [__filename, '--probe-client', '--background'], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PHASMA_RUNNER_TEST_ROOT: root },
    });
    child.stdout.resume(); child.stderr.resume();
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`Second client exited ${code}`)));
    });
    assert.equal(main.controller(), controller);
    assert.equal(BrowserWindow.getAllWindows().length, 1);
    assert.ok(shows > 0, 'a second client reconnects to the existing view');
    assert.equal(controller.busy, session.id);
    assert.equal(await window.webContents.executeJavaScript("document.querySelector('#prompt').value"), 'draft survives close');
    const info = await window.webContents.executeJavaScript('window.router.runnerInfo()');
    assert.equal(info.background, true);
    assert.equal(info.status, 'Needs attention');
    const untrusted = new BrowserWindow({ show: false, webPreferences: {
      preload: path.resolve(__dirname, '../src/preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true,
    } });
    await untrusted.loadURL('data:text/html,<p>untrusted client</p>');
    const rejected = await untrusted.webContents.executeJavaScript("window.router.bootstrap().then(() => false, error => error.message.includes('Untrusted caller'))");
    assert.equal(rejected, true);
    untrusted.destroy();
    controller.busy = null;
    controller.requests.clear();
    console.log('Runner lifecycle passed: close/reconnect preserves draft, work and approvals; one owner; untrusted clients rejected.');
    app.once('will-quit', () => {
      clearTimeout(watchdog);
    });
    app.quit();
  }).catch(error => { clearTimeout(watchdog); console.error(error.stack); app.exit(1); });
}
}
