// Quitting stops every process the app started: the running task first, then each worker's whole process tree,
// including children left behind by a worker that already exited (src/process-tree.cjs, Controller.shutdown).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { linkDescendants, spawnOwned, stopTree, snapshotOwned, stopOwned, windowsTable } = require('../src/process-tree.cjs');
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

test('quitting waits for the running task to stop before closing, and gives up waiting after the limit', async () => {
  const order = [];
  const controller = Object.create(Controller.prototype);
  controller.busy = 's1';
  controller.stop = async () => { order.push('stop'); setTimeout(() => { controller.busy = null; order.push('stopped'); }, 150); };
  controller.close = () => order.push('close');
  await controller.shutdown({ graceMs: 0 });
  assert.deepEqual(order, ['stop', 'stopped', 'close']);

  const stuck = Object.create(Controller.prototype);
  let closed = false;
  stuck.busy = 's2';
  stuck.stop = () => new Promise(() => {});
  stuck.close = () => { closed = true; };
  const started = Date.now();
  await stuck.shutdown({ stopMs: 200, graceMs: 0 });
  assert.ok(closed && Date.now() - started >= 190, 'a task that does not stop still lets the app close');
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
