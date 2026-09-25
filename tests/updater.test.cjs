const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Updater } = require('../src/updater.cjs');
const { LATEST_URL } = require('../src/updates.cjs');

const DATA = Buffer.alloc(50000, 3);
const NAME = 'Phasma-Harness-Setup-0.2.0.exe';
const URL = `https://github.com/christoskaramou/PhasmaHarness/releases/download/v0.2.0/${NAME}`;
const RELEASE = { tag_name: 'v0.2.0', html_url: 'https://github.com/christoskaramou/PhasmaHarness/releases/tag/v0.2.0',
  assets: [{ name: NAME, size: DATA.length, digest: `sha256:${createHash('sha256').update(DATA).digest('hex')}`, browser_download_url: URL }] };

function setup(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-updater-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const log = { downloads: 0, spawned: [], quit: 0, states: [] };
  const fetch = async url => {
    if (url === LATEST_URL) return { status: 200, ok: true, json: async () => RELEASE };
    assert.equal(url, URL); log.downloads++; return new Response(DATA);
  };
  const spawn = (file, args) => {
    const child = new EventEmitter(); child.unref = () => {};
    log.spawned.push({ file, args }); setImmediate(() => child.emit(options.spawnFails ? 'error' : 'spawn', new Error('blocked')));
    return child;
  };
  let busy = false;
  const updater = new Updater({ current: '0.1.0', fetch, directory, installable: options.installable ?? true, busy: () => options.busy?.() ?? busy, quit: () => log.quit++, spawn });
  updater.on('state', state => log.states.push(state.status));
  return { updater, log, directory, setBusy: value => { busy = value; } };
}

test('the installed app downloads, verifies, runs the installer silently and quits, only when asked and idle', async t => {
  const { updater, log, directory, setBusy } = setup(t);
  const result = await updater.check();
  assert.equal(result.installable, true);
  assert.equal(updater.state.status, 'available');
  assert.equal(log.downloads, 0, 'checking never downloads');
  setBusy(true);
  await assert.rejects(updater.install(), /Finish or stop the current turn first/);
  assert.equal(log.downloads, 0);
  setBusy(false);
  await updater.install();
  assert.equal(log.downloads, 1);
  assert.deepEqual(log.spawned, [{ file: path.join(directory, NAME), args: ['--updated', '/S', '--force-run'] }]);
  assert.equal(log.quit, 1);
  assert.deepEqual([...new Set(log.states)], ['available', 'downloading', 'installing']);
  assert.equal(updater.state.progress, 100);
});

test('a failed installer start keeps the app running; a turn that starts during the download postpones the install', async t => {
  const failing = setup(t, { spawnFails: true });
  await failing.updater.check();
  await assert.rejects(failing.updater.install(), /Could not start the installer/);
  assert.equal(failing.log.quit, 0);
  assert.equal(failing.updater.state.status, 'error');
  let calls = 0;
  const racing = setup(t, { busy: () => calls++ > 0 });
  await racing.updater.check();
  await assert.rejects(racing.updater.install(), /A turn started during the download/);
  assert.equal(racing.log.spawned.length, 0);
  assert.ok(fs.existsSync(path.join(racing.directory, NAME)), 'the verified installer is kept for the next attempt');
});

test('a source folder or an unusable asset only reports the release', async t => {
  const { updater, log } = setup(t, { installable: false });
  const result = await updater.check();
  assert.equal(result.newer, true);
  assert.equal(result.installable, false);
  await assert.rejects(updater.install(), /installed app/);
  assert.equal(log.downloads, 0);
});

test('old installers and unfinished downloads are removed at start; a newer one is kept', async t => {
  const { updater, directory } = setup(t);
  for (const name of ['Phasma-Harness-Setup-0.0.9.exe', 'Phasma-Harness-Setup-0.1.0.exe', 'Phasma-Harness-Setup-0.2.0.exe', 'Phasma-Harness-Setup-0.2.0.exe.partial', 'notes.txt'])
    fs.writeFileSync(path.join(directory, name), 'x');
  updater.cleanup();
  assert.deepEqual(fs.readdirSync(directory).sort(), ['Phasma-Harness-Setup-0.2.0.exe', 'notes.txt']);
  new Updater({ current: '0.1.0', directory: path.join(directory, 'missing') }).cleanup();
});
