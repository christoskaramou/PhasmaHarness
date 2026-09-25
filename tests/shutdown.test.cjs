// Quitting stops every process the app started: the running task first, then each worker's whole process tree,
// including children left behind by a worker that already exited (src/process-tree.cjs, Controller.shutdown).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const processTree = require('../src/process-tree.cjs');
const { linkDescendants, spawnOwned, stopTree, snapshotOwned, stopOwned, windowsTable, scan } = processTree;
const { Controller } = require('../src/controller.cjs');

const LINUX = process.platform === 'linux' && fs.existsSync('/proc/self/environ');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// Linux: a killed orphan can stay a zombie until init reaps it; that is not running.
function running(pid) {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z'; } catch { return false; }
}
async function allGone(pids) {
  for (let i = 0; i < 40 && pids.some(running); i++) await sleep(50);
  return pids.filter(running);
}

// A fake worker: starts a child and a detached child, records the pids, then keeps running like a CLI, or behaves
// like the Codex app-server (answers initialize, exits at end of input without stopping its children).
const WORKER = `
const { spawn } = require('node:child_process');
if (process.argv.includes('--version')) { console.log('codex-cli 99.0.0'); process.exit(0); }
const keep = ['-e', 'setInterval(() => {}, 1000)'];
const child = spawn(process.execPath, keep, { stdio: 'ignore' });
const detached = spawn(process.execPath, keep, { stdio: 'ignore', detached: true });
detached.unref();
require('node:fs').appendFileSync(process.env.FAKE_WORKER_PIDS, process.pid + ' ' + child.pid + ' ' + detached.pid + '\\n');
if (process.argv.includes('app-server')) {
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.on('line', line => { let m; try { m = JSON.parse(line); } catch { return; } if (m.method && m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\\n'); });
  lines.on('close', () => process.exit(0));
} else setInterval(() => {}, 1000);
`;

async function recorded(file, count) {
  for (let i = 0; i < 100; i++) {
    const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean) : [];
    if (lines.length >= count) return lines.map(line => line.split(' ').map(Number));
    await sleep(50);
  }
  throw new Error('The fake workers did not start.');
}

test('quitting records the worker trees first, waits for the task to stop, and a failed or hung Stop cannot block it', async t => {
  const order = [];
  const snapshot = processTree.snapshotOwned;
  processTree.snapshotOwned = known => { order.push(known ? 'snapshot again' : 'snapshot'); return known || new Map(); };
  t.after(() => { processTree.snapshotOwned = snapshot; });
  const controller = Object.create(Controller.prototype);
  controller.busy = 's1';
  controller.stop = async () => { order.push('stop'); setTimeout(() => { controller.busy = null; order.push('stopped'); }, 150); };
  controller.close = () => order.push('close');
  await controller.shutdown({ graceMs: 0 });
  assert.deepEqual(order, ['snapshot', 'stop', 'stopped', 'snapshot again', 'close'], 'trees are recorded before Stop can end any of them');

  const errors = [];
  for (const stop of [() => new Promise(() => {}), async () => { throw new Error('turn/interrupt timed out'); }]) {
    const stuck = Object.create(Controller.prototype);
    let closed = false;
    stuck.busy = 's2';
    stuck.stop = stop;
    stuck.close = () => { closed = true; };
    stuck.log = { error: (message, details) => errors.push(details.message) };
    const started = Date.now();
    await stuck.shutdown({ stopMs: 200, graceMs: 0 });
    assert.ok(closed && Date.now() - started >= 190, 'the app still closes after the time limit');
  }
  assert.deepEqual(errors, ['turn/interrupt timed out'], 'a failed Stop is logged, not shown as a blocking error');
});

test('a local check whose root already exited is not killed by pid on Windows; a POSIX process group still is', t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  t.after(() => Object.defineProperty(process, 'platform', platform));
  const controller = Object.create(Controller.prototype);
  const killed = [];
  controller.killProcessTree = pid => { killed.push(pid); return true; };
  Object.defineProperty(process, 'platform', { value: 'win32' });
  assert.equal(controller.killCheckRoot({ pid: 7, exitCode: null, signalCode: null }), true);
  assert.equal(controller.killCheckRoot({ pid: 8, exitCode: 1, signalCode: null }), false);
  assert.equal(controller.killCheckRoot({ pid: 9, exitCode: null, signalCode: 'SIGKILL' }), false);
  Object.defineProperty(process, 'platform', { value: 'linux' });
  controller.killCheckRoot({ pid: 10, exitCode: 0, signalCode: null });
  assert.deepEqual(killed, [7, 10]);
});

test('Stop after a worker exited still stops what it left (Windows: found from its record, verified by creation time)', async t => {
  const { EventEmitter } = require('node:events');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const { runAsync, taskkill } = scan;
  t.after(() => { Object.defineProperty(process, 'platform', platform); scan.runAsync = runAsync; scan.taskkill = taskkill; });
  // A worker (pid 5000) that exited on its own; its detached tool (5001) still runs. 5002 has the same parent pid but
  // started after the worker ended, so it belongs to whoever got that pid next.
  const child = spawnOwned(() => Object.assign(new EventEmitter(), { pid: 5000, exitCode: null, signalCode: null, stdout: { destroy() { child.released = true; } } }), 'claude.exe', []);
  const startedMs = processTree.owned.get(child.ownerKey).startedMs;
  child.exitCode = 0; child.emit('exit', 0);
  const endedMs = processTree.owned.get(child.ownerKey).endedMs;
  const filetime = ms => String((ms + 11644473600000) * 10000);
  let live = [[5001, 5000, startedMs], [5002, 5000, endedMs + 10000], [4, 0, startedMs - 1e9]];
  const scans = [], kills = [];
  scan.runAsync = async () => { scans.push(1); return { status: 0, stderr: '', stdout: live.map(([pid, ppid, ms]) => `${pid} ${ppid} ${filetime(ms)}`).join('\n') + '\nEND-OF-PROCESS-LIST\n' }; };
  scan.taskkill = args => { kills.push(args); live = live.filter(([pid]) => !args.includes(String(pid))); const proc = new EventEmitter(); setImmediate(() => proc.emit('exit', 0)); return proc; };
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const remaining = await stopTree(child);
  assert.deepEqual(kills, [['/F', '/PID', '5001']], 'only the verified leftover, by pid without /T, and never the exited root');
  assert.deepEqual(remaining, []);
  assert.equal(scans.length, 2, 'killed, then checked again');
  assert.equal(child.released, true, 'its pipes are released, so the turn can end');
});

test('Stop ends a turn whose worker exited while something it started still holds its output open', { skip: !LINUX && 'Linux /proc', timeout: 20000 }, async t => {
  // The holder clears its environment, so not even the owner tag finds it: only releasing the pipes ends the turn.
  const holderScript = "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: {}, detached: true, stdio: ['ignore', 'inherit', 'inherit'] }); c.unref(); console.log(c.pid);";
  const child = spawnOwned(spawn, process.execPath, ['-e', holderScript], { stdio: ['pipe', 'pipe', 'pipe'] });
  let holder = 0, closed = false;
  child.stdout.on('data', data => { holder ||= Number(String(data).trim()); });
  child.once('close', () => { closed = true; });
  t.after(() => { if (holder > 0) try { process.kill(holder, 'SIGKILL'); } catch {} });
  await once(child, 'exit');
  await sleep(300);
  assert.ok(holder > 0 && running(holder) && !closed, 'the worker exited but its output is still held open');
  await stopTree(child);
  for (let i = 0; i < 40 && !closed; i++) await sleep(25);
  assert.equal(closed, true);
});

test('a Stop whose cleanup cannot be confirmed says so, with a record to retry', async t => {
  const { EventEmitter } = require('node:events');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const { runAsync, taskkill } = scan;
  t.after(() => { Object.defineProperty(process, 'platform', platform); scan.runAsync = runAsync; scan.taskkill = taskkill; });
  const child = spawnOwned(() => Object.assign(new EventEmitter(), { pid: 6000, exitCode: null, signalCode: null }), 'claude.exe', []);
  child.exitCode = 0; child.emit('exit', 0);
  const events = [];
  const pending = id => events.push(['pending', id]), done = event => events.push(['done', event]);
  processTree.cleanup.on('pending', pending).on('done', done);
  t.after(() => processTree.cleanup.off('pending', pending).off('done', done));
  Object.defineProperty(process, 'platform', { value: 'win32' });
  scan.runAsync = async () => ({ error: new Error('Get-CimInstance failed') }); // the process list cannot be read
  assert.deepEqual(await stopTree(child), [-1]);
  assert.deepEqual(events[0], ['pending', child.ownerKey]);
  const [, { id, remaining, record }] = events[1];
  assert.equal(id, child.ownerKey);
  assert.deepEqual(remaining, [-1]);
  assert.equal(record.id, child.ownerKey);
  assert.deepEqual(record.roots.map(root => root.pid), [6000]);
  assert.ok(record.roots[0].endedMs, 'the exit time is kept, so a later process with that pid is never claimed');
  assert.deepEqual(record.tags, [`PHASMA_HARNESS_OWNER=${child.ownerKey}\0`]);
});

test('a cleanup retry keeps the descendants it found, so one whose parent exits before the next retry is still stopped', async t => {
  const { EventEmitter } = require('node:events');
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const { run, runAsync, taskkill, taskkillSync } = scan;
  t.after(() => { Object.defineProperty(process, 'platform', platform); Object.assign(scan, { run, runAsync, taskkill, taskkillSync }); });
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const T = Date.now() - 60000;
  const filetime = ms => String((ms + 11644473600000) * 10000);
  // The worker (100) has exited; its child C (200) and grandchild G (300) are running and cannot be killed yet.
  let live = [[200, 100, T + 500], [300, 200, T + 600], [4, 0, T - 1e9]], killable = false;
  const table = () => ({ status: 0, stderr: '', stdout: live.map(([pid, ppid, ms]) => `${pid} ${ppid} ${filetime(ms)}`).join('\n') + '\nEND-OF-PROCESS-LIST\n' });
  const kill = args => { if (killable) live = live.filter(([pid]) => !args.includes(String(pid))); };
  scan.runAsync = async () => table(); scan.run = () => table();
  scan.taskkill = args => { kill(args); const proc = new EventEmitter(); setImmediate(() => proc.emit('exit', 0)); return proc; };
  scan.taskkillSync = args => { kill(args); return { status: 0 }; };
  const original = { id: 'w', tags: ['PHASMA_HARNESS_OWNER=w\0'], roots: [{ pid: 100, startedMs: T, endedMs: T + 1000 }], children: [] };

  const first = await processTree.sweepRecord(original, 300);
  assert.deepEqual(first.remaining.sort(), [200, 300]);
  assert.deepEqual(first.record.children.map(child => child.pid).sort(), [100, 200, 300], 'what the retry found is kept');

  // Then C exits, leaving G, and G can be killed now.
  live = live.filter(([pid]) => pid !== 200); killable = true;
  assert.deepEqual((await processTree.sweepRecord(original, 300)).remaining, [], 'from the original record G cannot be linked (a false "confirmed")');
  assert.ok(live.some(([pid]) => pid === 300), 'and it is still running');
  const second = await processTree.sweepRecord(first.record, 2000);
  assert.deepEqual(second.remaining, []);
  assert.ok(!live.some(([pid]) => pid === 300), 'from the kept record it is found and stopped');

  // The controller stores the grown record after a retry, and at start, and keeps records added meanwhile.
  const controller = Object.create(Controller.prototype);
  Object.assign(controller, { data: { sessions: [], workerCleanup: [original, { id: 'later', tags: [], roots: [], children: [] }] }, save() {}, cleanupChanged() {} });
  controller.applyCleanupResults(new Map([['w', first]]));
  assert.deepEqual(controller.data.workerCleanup.map(record => record.id), ['w', 'later']);
  assert.equal(controller.data.workerCleanup[0], first.record);
  live = [[200, 100, T + 500], [300, 200, T + 600], [4, 0, T - 1e9]]; killable = false;
  const starting = Object.create(Controller.prototype);
  Object.assign(starting, { data: { sessions: [], workerCleanup: [original] } });
  assert.equal(starting.recoverWorkerCleanup(300), true);
  clearTimeout(starting.cleanupRetry);
  assert.deepEqual(starting.data.workerCleanup[0].children.map(child => child.pid).sort(), [100, 200, 300]);
});

test('quitting keeps what it could not stop blocked for the next start', async t => {
  const stopOwnedReal = processTree.stopOwned;
  const record = { id: 'run:x', tags: ['PHASMA_HARNESS_OWNER=x/'], roots: [], children: [] };
  processTree.stopOwned = () => ({ stopped: 2, remaining: [-1], record });
  t.after(() => { processTree.stopOwned = stopOwnedReal; });
  const controller = Object.create(Controller.prototype);
  let saved = 0;
  Object.assign(controller, { data: { sessions: [] }, busy: null, close() {}, save() { saved++; } });
  const result = await controller.shutdown({ graceMs: 0 });
  assert.deepEqual(result, { stopped: 2, remaining: [-1] });
  assert.deepEqual(controller.data.workerCleanup, [record]);
  assert.ok(saved >= 1);
  assert.match(controller.blockedReason(), /could not be confirmed stopped/);
});

test('at start, a recorded cleanup is finished before new work', { skip: !LINUX && 'Linux /proc' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-recover-'));
  const leftover = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', env: { ...process.env, PHASMA_HARNESS_OWNER: 'earlier-run/7' } });
  t.after(() => { try { leftover.kill('SIGKILL'); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  await sleep(200);
  const file = path.join(root, 'sessions.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, settings: { workspace: root, mode: 'auto', access: 'workspace-write' }, sessions: [],
    workerCleanup: [{ id: 'earlier-run/7', tags: ['PHASMA_HARNESS_OWNER=earlier-run/7\0'], roots: [], children: [] }] }));
  const controller = new Controller(file, root); // loading the sessions finishes recorded cleanups first
  t.after(() => controller.close());
  assert.equal(controller.data.workerCleanup, undefined);
  assert.equal(controller.blockedReason(), null);
  assert.deepEqual(await allGone([leftover.pid]), []);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).workerCleanup, undefined, 'and saved as done');
});

test('a worker that already exited is never killed by pid on Windows (the pid may be someone else\'s now)', t => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform');
  const taskkill = scan.taskkill;
  const calls = [];
  Object.defineProperty(process, 'platform', { value: 'win32' });
  scan.taskkill = args => { calls.push(args); return { on() {} }; };
  t.after(() => { Object.defineProperty(process, 'platform', platform); scan.taskkill = taskkill; });
  let kills = 0;
  const child = { pid: 4242, exitCode: null, signalCode: null, kill: () => kills++ };
  stopTree(child);
  assert.deepEqual(calls, [['/PID', '4242', '/T', '/F']], 'a running worker is stopped with its tree');
  stopTree({ ...child, exitCode: 0 });
  stopTree({ ...child, signalCode: 'SIGTERM' });
  assert.equal(calls.length, 1, 'an exited one is not');
  assert.equal(kills, 0);
});

test('an ended process bounds its children: a later process with its pid (or that pid\'s children) is never claimed', () => {
  const T = 1_800_000_000_000;
  // Seen alive, then gone: it ended by the second scan, so a later child of that pid is someone else's.
  const known = new Map([[10, { startedMs: T, exact: true }]]);
  linkDescendants([{ pid: 10, ppid: 1, startedMs: T }], known, T + 1000);
  linkDescendants([{ pid: 11, ppid: 10, startedMs: T + 500 }], known, T + 2000);
  assert.equal(known.get(10).endedMs, T + 2000);
  assert.ok(known.has(11), 'an orphan started while its parent lived is still linked');
  linkDescendants([{ pid: 11, ppid: 10, startedMs: T + 500 }, { pid: 12, ppid: 10, startedMs: T + 3000 }], known, T + 4000);
  assert.equal(known.has(12), false, 'started after the parent ended');

  // A root that exited at a known time: its pid reused by a newcomer, whose children are not ours.
  const ended = new Map([[20, { startedMs: T, exact: false, endedMs: T + 5000 }]]);
  linkDescendants([
    { pid: 20, ppid: 1, startedMs: T + 3000 }, // the newcomer, after our root ended (exit seen late)
    { pid: 21, ppid: 20, startedMs: T + 1000 }, // our orphan
    { pid: 22, ppid: 20, startedMs: T + 4000 }, // the newcomer's child
  ], ended, T + 6000);
  assert.equal(ended.get(20).endedMs, T + 2999, 'the newcomer\'s start tightens the bound');
  assert.deepEqual([...ended.keys()].sort(), [20, 21]);
  assert.equal(ended.get(20).exact, false, 'the newcomer is not adopted as the root');
});

test('stopping a worker stops its whole tree, detached children included', { skip: !LINUX && 'Linux /proc' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-stop-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'worker.cjs'), pids = path.join(root, 'pids');
  fs.writeFileSync(script, WORKER);
  const child = spawnOwned(spawn, process.execPath, [script], { stdio: 'ignore', env: { ...process.env, FAKE_WORKER_PIDS: pids } });
  const [tree] = await recorded(pids, 1);
  assert.equal(tree.filter(running).length, 3);
  stopTree(child);
  assert.deepEqual(await allGone(tree), []);
});

test('quitting stops every worker tree, including children of a worker that exited on its own', { skip: !LINUX && 'Linux /proc' }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-quit-'));
  const home = process.env.HOME;
  t.after(() => { process.env.HOME = home; delete process.env.FAKE_WORKER_PIDS; fs.rmSync(root, { recursive: true, force: true }); });
  // The real launch paths: ~/.local/bin/claude, ~/.local/bin/cursor-agent and the npm Codex package.
  process.env.HOME = root;
  process.env.FAKE_WORKER_PIDS = path.join(root, 'pids');
  const bin = path.join(root, '.local', 'bin'), codex = path.join(root, '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(codex, { recursive: true });
  for (const name of ['claude', 'cursor-agent']) fs.writeFileSync(path.join(bin, name), `#!${process.execPath}\n${WORKER}`, { mode: 0o755 });
  fs.writeFileSync(path.join(codex, 'codex.js'), WORKER);

  const controller = new Controller(path.join(root, 'sessions.json'), root);
  controller.client.on('disconnected', () => {});
  await controller.client.start();
  controller.claude.start([], root);
  controller.cursor.start([], root);
  const trees = await recorded(process.env.FAKE_WORKER_PIDS, 3);
  const all = trees.flat();
  assert.equal(all.filter(running).length, 9);

  const result = await controller.shutdown({ graceMs: 3000 });
  assert.deepEqual(await allGone(all), []);
  assert.deepEqual(result.remaining, []);
  assert.ok(result.stopped >= 2, 'the children Codex left behind when it exited were stopped by the final sweep');
});

test('Windows: Stop after the worker exited stops the process it left running', { skip: process.platform !== 'win32' && 'Windows process tree' }, async t => {
  const root = spawnOwned(spawn, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "Start-Process -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','120','127.0.0.1'; Start-Sleep -Seconds 120"], { windowsHide: true, stdio: 'ignore' });
  t.after(() => stopTree(root));
  let tree = new Map();
  for (let i = 0; i < 60 && tree.size < 1; i++) {
    await sleep(250);
    tree = new Map([...snapshotOwned()].filter(([pid, entry]) => pid !== root.pid && entry.endedMs === undefined));
  }
  assert.ok(tree.size >= 1, 'the ping is recorded');
  root.kill(); // the worker exits on its own, leaving the ping
  await once(root, 'exit');
  assert.deepEqual(await stopTree(root), []);
  const table = windowsTable();
  assert.deepEqual([...tree].filter(([pid, entry]) => table.some(row => row.pid === pid && Math.abs(row.startedMs - entry.startedMs) < 1)), []);
});

test('Windows: a worker tree is found from its recorded root and stopped after the root exits first', { skip: process.platform !== 'win32' && 'Windows process tree' }, async t => {
  const command = "Start-Process -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','120','127.0.0.1'; ping.exe -n 120 127.0.0.1 | Out-Null";
  const live = known => { const table = windowsTable(); return [...known].filter(([pid, entry]) => table.some(row => row.pid === pid && Math.abs(row.startedMs - entry.startedMs) < 1)); };
  for (const snapshot of [true, false]) {
    const root = spawnOwned(spawn, 'powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, stdio: 'ignore' });
    t.after(() => stopTree(root));
    // Record the tree until it has stopped growing (both pings and their console hosts).
    let known = new Map(), size = 0, stable = 0;
    for (let i = 0; i < 60 && stable < 3; i++) {
      await sleep(250);
      known = snapshotOwned();
      const count = [...known].filter(([pid, entry]) => pid !== root.pid && entry.endedMs === undefined).length;
      stable = count >= 2 && count === size ? stable + 1 : 0;
      size = count;
    }
    const tree = new Map([...known].filter(([pid, entry]) => pid !== root.pid && entry.endedMs === undefined));
    assert.ok(tree.size >= 2, `both pings are recorded (found ${tree.size})`);
    // The root exits first (as Codex does at end of input), leaving its children behind.
    root.kill();
    await once(root, 'exit');
    // With the snapshot the tree is already known; without it, the orphans are linked through the exited root.
    const result = stopOwned({ known: snapshot ? known : new Map(), deadline: Date.now() + 20000 });
    assert.deepEqual(result.remaining, []);
    assert.deepEqual(live(tree), [], `nothing of the tree is left (${snapshot ? 'with' : 'without'} a snapshot)`);
  }
});
