const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { RunnerWindow, autostart, loginOptions, hasPendingWork, backupStores } = require('../src/runner.cjs');

function fixture(settingsFile) {
  let quitting = false, status = 'Runner ready', startup = false;
  const calls = [];
  const app = { isPackaged: false, getAppPath: () => 'C:\\Work space\\Harness',
    getLoginItemSettings: options => { calls.push(['login-read', options]); return { openAtLogin: startup }; },
    setLoginItemSettings: options => { startup = options.openAtLogin; calls.push(['login-write', options]); } };
  const window = new EventEmitter();
  window.webContents = new EventEmitter();
  Object.assign(window, { isDestroyed: () => false, isMinimized: () => false,
    hide: () => calls.push('hide'), show: () => calls.push('show'), focus: () => calls.push('focus'), reload: () => calls.push('reload') });
  class Tray extends EventEmitter {
    setToolTip(value) { calls.push(['tooltip', value]); }
    setContextMenu(menu) { this.menu = menu; }
    destroy() { calls.push('tray-destroyed'); }
  }
  const desktop = new RunnerWindow({ app, window, Tray, Menu: { buildFromTemplate: value => value }, icon: 'fixture',
    settingsFile, isQuitting: () => quitting, quit: () => { quitting = true; calls.push('quit'); }, status: () => status });
  return { desktop, app, window, calls, setStatus: value => { status = value; } };
}

test('closing a window detaches the view and reopening preserves the same runner and approval waits', () => {
  const { desktop, window, calls } = fixture();
  const work = { job: 'active', pendingApproval: new Map([['approval', 'waiting']]), draft: 'keep typing' };
  let prevented = false;
  window.on('closed', () => { work.job = 'stopped'; });
  window.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(work.job, 'active');
  assert.equal(work.pendingApproval.size, 1);
  assert.equal(work.draft, 'keep typing');
  assert.ok(calls.includes('hide'));
  desktop.show();
  assert.deepEqual(calls.slice(-2), ['show', 'focus']);
  assert.equal(calls.includes('quit'), false);
});

test('a crashed renderer reconnects on open and explicit Quit is distinct from window close', () => {
  const { desktop, window, calls } = fixture();
  window.webContents.emit('render-process-gone');
  desktop.show();
  assert.deepEqual(calls.slice(-3), ['reload', 'show', 'focus']);
  desktop.tray.menu.find(item => item.label === 'Quit runner').click();
  let prevented = false;
  window.emit('close', { preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
  assert.equal(calls.at(-1), 'quit');
  desktop.dispose();
  assert.equal(calls.at(-1), 'tray-destroyed');
});

test('tray updates coalesce repeated worker output and display pending attention', () => {
  const { desktop, calls, setStatus } = fixture();
  const reads = calls.filter(call => call[0] === 'login-read').length;
  for (let i = 0; i < 100; i++) desktop.refresh();
  assert.equal(calls.filter(call => call[0] === 'login-read').length, reads);
  setStatus('Needs attention');
  desktop.refresh();
  assert.ok(calls.some(call => call[0] === 'tooltip' && call[1].includes('Needs attention')));
});

test('start at sign-in uses matching executable arguments and never enables itself', () => {
  const { app, calls } = fixture();
  const options = loginOptions(app, 'C:\\Electron\\electron.exe');
  assert.deepEqual(options.args, ['"C:\\Work space\\Harness"', '--background']);
  assert.equal(autostart(app, undefined, 'win32').enabled, false);
  assert.equal(calls.some(call => call[0] === 'login-write'), false);
  assert.equal(autostart(app, true, 'win32').enabled, true);
  assert.deepEqual(calls.find(call => call[0] === 'login-write')[1].args, calls.at(-1)[1].args);
  assert.equal(autostart(app, false, 'win32').enabled, false);
  assert.throws(() => autostart(app, 'yes', 'win32'), /Choose whether/);
});

test('updates wait for routine admission, queued jobs, messages, approvals and cleanup as well as active turns', () => {
  const worker = { loading: new Set(), requests: new Map(), stopping: new Set(), blockedReason: () => null,
    data: { sessions: [{ queue: [] }] } };
  let pending = [];
  const background = { ...worker, data: { sessions: [] } };
  const agents = { busy: false, pendingJobs: () => pending, allControllers: () => [worker, background],
    initializing: new Map([[worker, Promise.resolve()]]) };
  assert.equal(hasPendingWork(agents), false);
  agents.routines = { busy: false, records: { future: { enabled: true } } };
  assert.equal(hasPendingWork(agents), false, 'future routines alone do not block an update');
  agents.routines.busy = true;
  assert.equal(hasPendingWork(agents), true);
  agents.routines.busy = false;
  agents.artifactRuns = { busy: true };
  assert.equal(hasPendingWork(agents), true);
  agents.artifactRuns.busy = false;
  agents.downloads = { busy: true };
  assert.equal(hasPendingWork(agents), true, 'updates wait for downloads and uncertain snapshot cleanup');
  agents.downloads.busy = false;
  agents.workspaces = { busy: true };
  assert.equal(hasPendingWork(agents), true);
  agents.workspaces.busy = false;
  agents.budgets = { inflight: new Map([['pending-inference', {}]]) };
  assert.equal(hasPendingWork(agents), true);
  agents.budgets.inflight.clear();
  agents.foregroundTasks = () => [{ task: { budgetPaused: true } }];
  assert.equal(hasPendingWork(agents), true);
  agents.foregroundTasks = () => [];
  pending = [{ id: 'accepted' }];
  assert.equal(hasPendingWork(agents), true);
  pending = [];
  worker.data.sessions[0].queue.push({ id: 'saved-message' });
  assert.equal(hasPendingWork(agents), true);
  worker.data.sessions[0].queue = [];
  worker.data.sessions[0].items = [{ pendingReply: { id: 'deferred-review' } }];
  assert.equal(hasPendingWork(agents), true);
  worker.data.sessions[0].items = [];
  agents.revisionOperations = new Map([['pending-change', {}]]);
  assert.equal(hasPendingWork(agents), true);
  agents.revisionOperations.clear();
  worker.requests.set('approval', {});
  assert.equal(hasPendingWork(agents), true);
  worker.requests.clear();
  background.connection = 'connecting';
  assert.equal(hasPendingWork(agents), true);
  background.connection = 'ready';
  background.connectingProviders = new Map([['native:deepseek', 1]]);
  assert.equal(hasPendingWork(agents), true);
  background.connectingProviders.clear();
  background.chatgptLoginPending = true;
  assert.equal(hasPendingWork(agents), true);
  background.chatgptLoginPending = false;
  background.data.sessions.push({ queue: [{ id: 'background-follow-up' }] });
  assert.equal(hasPendingWork(agents), true);
  background.data.sessions = [];
  worker.blockedReason = () => 'Cleanup unconfirmed';
  assert.equal(hasPendingWork(agents), true);
});

test('runner recovery keeps verified original stores once and refuses a broken backup', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-recovery-backup-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'sessions.json'), id = randomUUID();
  const original = JSON.stringify({ agents: [{ id }], workerContexts: ['main', id], sessions: [{ id: 'owner', status: 'running' }] });
  fs.writeFileSync(filename, original);
  const child = path.join(directory, 'agents', id, 'sessions.json');
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.writeFileSync(child, JSON.stringify({ sessions: [{ id: 'worker', delegation: { state: 'running', delivered: false } }] }));
  const executions = ['main', id].map(agentId => path.join(directory, 'workers', agentId, 'sessions.json'));
  for (const file of executions) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ sessions: [{ id: randomUUID(), items: [{ text: 'Execution evidence' }] }] }));
  }
  backupStores(filename);
  const backup = filename + '.pre-runner-recovery-v1.bak', childBackup = child + '.pre-runner-recovery-v1.bak';
  assert.equal(fs.readFileSync(backup, 'utf8'), original);
  assert.equal(fs.readFileSync(childBackup, 'utf8'), fs.readFileSync(child, 'utf8'));
  for (const file of executions) assert.equal(fs.readFileSync(file + '.pre-runner-recovery-v1.bak', 'utf8'), fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(filename, JSON.stringify({ agents: [{ id }], sessions: [{ id: 'owner', status: 'interrupted' }] }));
  backupStores(filename);
  assert.equal(fs.readFileSync(backup, 'utf8'), original, 'later launches do not overwrite the original recovery copy');
  fs.writeFileSync(backup, 'incomplete json');
  assert.throws(() => backupStores(filename), /Could not verify the recovery backup.*move sessions\.json\.pre-runner-recovery-v1\.bak aside/);
  assert.equal(JSON.parse(fs.readFileSync(filename)).sessions[0].status, 'interrupted', 'failed verification does not rewrite the live store');
});

test('an unreadable store never leaves a partial recovery backup that blocks later starts', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-recovery-partial-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'sessions.json'), id = randomUUID();
  const child = path.join(directory, 'agents', id, 'sessions.json');
  fs.writeFileSync(filename, JSON.stringify({ agents: [{ id }], sessions: [] }));
  fs.mkdirSync(path.dirname(child), { recursive: true });
  fs.writeFileSync(child, '{"sessions": [');
  assert.throws(() => backupStores(filename), /Could not verify the recovery backup for sessions\.json/);
  assert.deepEqual(fs.readdirSync(path.dirname(child)), ['sessions.json'], 'no partial backup or temporary copy is left');
  fs.writeFileSync(child, JSON.stringify({ sessions: [] }));
  backupStores(filename);
  assert.equal(fs.readFileSync(child + '.pre-runner-recovery-v1.bak', 'utf8'), JSON.stringify({ sessions: [] }));
});

test('runner recovery rejects an agent path outside its private store tree', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-recovery-path-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'sessions.json');
  fs.writeFileSync(filename, JSON.stringify({ agents: [{ id: '../outside' }], sessions: [] }));
  assert.throws(() => backupStores(filename), /Invalid saved agent ID/);
  assert.equal(fs.existsSync(filename + '.pre-runner-recovery-v1.bak'), false);
  const id = randomUUID();
  fs.writeFileSync(filename, JSON.stringify({ agents: [{ id }], workerContexts: ['../outside'], sessions: [] }));
  assert.throws(() => backupStores(filename), /Unknown saved worker context/);
  assert.equal(fs.existsSync(filename + '.pre-runner-recovery-v1.bak'), false);
});

test('a desktop startup failure keeps the runner lease so the error stays readable; a headless failure releases it', async t => {
  const containment = require.resolve('../src/runner-containment.cjs'), runnerPath = require.resolve('../src/runner.cjs');
  const original = require.cache[containment], detached = [];
  require.cache[containment] = { id: containment, filename: containment, loaded: true,
    exports: { containRunner: async () => ({ recoverySafe: true, detach: () => detached.push(true) }) } };
  delete require.cache[runnerPath];
  const { createRunner } = require(runnerPath);
  t.after(() => { require.cache[containment] = original; delete require.cache[runnerPath]; });
  for (const desktop of [true, false]) {
    const data = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-runner-failure-'));
    t.after(() => fs.rmSync(data, { recursive: true, force: true }));
    fs.writeFileSync(path.join(data, 'sessions.json'), JSON.stringify({ version: 1, settings: { workspace: data, mode: 'auto', access: 'workspace-write' }, sessions: [], jobBudgets: { broken: { id: 'another' } } }));
    const app = desktop ? { isPackaged: false, getAppPath: () => data, getVersion: () => '0.0.0', once() {} } : undefined;
    const log = { directory: data, info() {}, warn() {}, error() {} };
    detached.length = 0;
    await assert.rejects(createRunner({ app, data, log, safeStorage: { isEncryptionAvailable: () => false } }), /job budget is invalid/);
    assert.equal(detached.length, desktop ? 0 : 1);
  }
});


test('exit preference persists, validates and uses the normal quit path', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-exit-'));
  try {
    const file = path.join(directory, 'runner-window.json');
    const first = fixture(file);
    assert.equal(first.desktop.info().onExit, 'tray');
    first.desktop.setOnExit('close');
    const restored = fixture(file);
    assert.equal(restored.desktop.info().onExit, 'close');
    assert.throws(() => restored.desktop.setOnExit('invalid'), /Choose/);
    let prevented = false;
    restored.window.emit('close', { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.ok(restored.calls.includes('quit'));
    assert.ok(!restored.calls.includes('hide'));
    first.desktop.setOnExit('tray');
    assert.equal(fixture(file).desktop.info().onExit, 'tray');
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
