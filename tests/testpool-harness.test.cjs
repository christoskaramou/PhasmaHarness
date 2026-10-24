'use strict';
// Harness runs the test pool itself after a bot's turn. Run: node --test tests/testpool-harness.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const gate = require('../src/controller/task-gate.cjs');

const made = [];
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };

// A repository whose one pooled test fails when src.txt contains BROKEN. Jev is off, so no network is used.
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-harness-'));
  made.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t');
  git(root, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'src.txt'), 'ok\n');
  fs.mkdirSync(path.join(root, '.testpool'));
  fs.writeFileSync(path.join(root, '.testpool', '.gitignore'), 'runs/\n');
  fs.writeFileSync(path.join(root, '.testpool', 'catalog.json'), JSON.stringify({
    version: 1, settings: { jev: 'off', maxBlocks: 2 }, setups: {},
    tests: [{ id: 'src-ok', name: 'src stays ok', covers: 'src.txt must never contain the word BROKEN', paths: ['src.txt'],
      command: 'node -e "process.exit(require(\'fs\').readFileSync(\'src.txt\',\'utf8\').includes(\'BROKEN\') ? 1 : 0)"', cost: 'cheap', timeoutSec: 30 }],
  }));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

// The task-gate methods on a stand-in controller that records what it sends.
function controller(fields = {}) {
  const sent = [];
  return { ...gate, testPoolDue: new Set(), isCoordinator: () => false, executionContext: false, smartRouter: null,
    log: { warn() {} }, changed() {}, send: async message => { sent.push(message); }, sent, ...fields };
}

const chat = (root, access = 'danger-full-access') => ({ id: 'chat', access, workspace: root,
  items: [{ type: 'agentMessage', phase: 'final_answer', text: 'Edited src.txt.' }] });

test('an editable test-pool skill cannot replace the trusted host checker', async () => {
  const root = repo(), candidate = path.join(root, 'candidate'), marker = path.join(root, 'candidate-ran');
  fs.mkdirSync(path.join(candidate, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(candidate, 'scripts', 'testpool.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const bot = controller({ skillDirectories: () => ({ 'test-pool': candidate }) }), session = chat(root);
  await bot.runTestPool(root, session);
  fs.writeFileSync(path.join(root, 'src.txt'), 'BROKEN');
  await bot.runTestPool(root, session);
  assert.equal(fs.existsSync(marker), false);
  assert.match(bot.sent[0].text, /FAILED src-ok/);
});

test('a failing pool after a Full-access turn goes back to the bot as a Test pool message', async () => {
  const root = repo();
  const bot = controller();
  const session = chat(root);
  await bot.runTestPool(root, session); // the first run records the clean state
  fs.writeFileSync(path.join(root, 'src.txt'), 'BROKEN\n');
  await bot.runTestPool(root, session);
  assert.equal(bot.sent.length, 1);
  assert.equal(bot.sent[0].id, 'chat');
  assert.equal(bot.sent[0].routineRun.name, 'Test pool', 'shown as the test pool, not as the user');
  assert.match(bot.sent[0].text, /Test pool: 1 failed[\s\S]*FAILED src-ok/);
  fs.writeFileSync(path.join(root, 'src.txt'), 'ok again\n');
  await bot.runTestPool(root, session);
  assert.equal(bot.sent.length, 1, 'a pass sends nothing to the bot');
  assert.match(session.notice, /^Test pool: 1 passed/);
  assert.ok(session.noticeExpiresAt > Date.now(), 'a pass notice goes away by itself');
});

test('a job’s failing pool only shows as a notice: its result already went back', async () => {
  const root = repo();
  const job = controller({ executionContext: true });
  const session = chat(root);
  await job.runTestPool(root, session);
  fs.writeFileSync(path.join(root, 'src.txt'), 'BROKEN\n');
  await job.runTestPool(root, session);
  assert.equal(job.sent.length, 0);
  assert.match(session.notice, /FAILED src-ok/);
  assert.equal(session.noticeExpiresAt, null, 'a failure stays until the next run');
});

test('the pool runs after Full-access turns only, not after Read-only, Workspace, Cursor or Main Bot turns', () => {
  const root = repo();
  const runs = [];
  const turn = (session, fields = {}) => {
    const bot = controller({ startTestPool: where => runs.push(where), ...fields });
    bot.testPoolDue.add(session.id);
    bot.testPoolAfterTurn(session);
    bot.testPoolAfterTurn(session);
  };
  turn(chat(root));
  turn(chat(path.join(root, '.testpool')));
  turn(chat(root, 'read-only'));
  turn(chat(root, 'workspace-write'));
  turn({ ...chat(root), activeProvider: 'cursor' });
  turn(chat(root), { isCoordinator: () => true });
  turn(chat(os.tmpdir()));
  assert.deepEqual(runs, [root, root], 'once per settled turn, found from a subfolder, only where the bot could already run anything');
});

test('pooled tests get neither Harness’s Electron-as-Node switch nor its Jev key', async () => {
  const root = repo();
  const catalog = path.join(root, '.testpool', 'catalog.json');
  const pool = JSON.parse(fs.readFileSync(catalog, 'utf8'));
  pool.tests.push({ id: 'clean-env', name: 'clean environment', covers: 'pooled tests start without ELECTRON_RUN_AS_NODE or JEV_API_KEY', always: true,
    command: 'node -e "process.exit(process.env.ELECTRON_RUN_AS_NODE || process.env.JEV_API_KEY ? 1 : 0)"', cost: 'cheap', timeoutSec: 30 });
  fs.writeFileSync(catalog, JSON.stringify(pool));
  const bot = controller({ smartRouter: { jev: { configured: true, keyStore: { read: () => 'jev-secret' } } } });
  const session = chat(root);
  await bot.runTestPool(root, session);
  assert.equal(bot.sent.length, 0, bot.sent[0]?.text);
  assert.match(session.notice, /^Test pool: 1 passed/);
});

test('late pool failures never send into cleared, busy, changed or restricted chats', async () => {
  for (const change of ['clear', 'busy', 'new turn', 'access', 'shutdown']) {
    const root = repo(), session = chat(root), bot = controller({ data: { sessions: [session] } });
    await bot.runTestPool(root, session);
    const file = path.join(root, '.testpool', 'catalog.json');
    const pool = JSON.parse(fs.readFileSync(file));
    pool.tests[0].command = 'node hold.cjs';
    fs.writeFileSync(file, JSON.stringify(pool));
    fs.writeFileSync(path.join(root, 'hold.cjs'), "const fs = require('fs'); fs.writeFileSync('started', ''); setInterval(() => { if (fs.existsSync('release')) process.exit(1); }, 10);");
    fs.writeFileSync(path.join(root, 'src.txt'), 'BROKEN');
    const running = bot.runTestPool(root, session);
    for (let i = 0; i < 300 && !fs.existsSync(path.join(root, 'started')); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(fs.existsSync(path.join(root, 'started')));
    if (change === 'clear') bot.data.sessions = [{ ...session, archived: true }];
    if (change === 'busy') bot.busy = session.id;
    if (change === 'new turn') session.items.push({ type: 'agentMessage', text: 'A newer answer.' });
    if (change === 'access') session.access = 'read-only';
    if (change === 'shutdown') bot.testPoolsClosed = true;
    fs.writeFileSync(path.join(root, 'release'), '');
    await running;
    assert.deepEqual(bot.sent, [], change);
    assert.match(bot.data.sessions[0].notice, /FAILED src-ok/, change);
  }
});

function holdingPool() {
  const root = repo(), file = path.join(root, '.testpool', 'catalog.json');
  const pool = JSON.parse(fs.readFileSync(file));
  Object.assign(pool.tests[0], { always: true, command: 'node hold.cjs' });
  fs.writeFileSync(file, JSON.stringify(pool));
  fs.writeFileSync(path.join(root, 'hold.cjs'), "require('fs').appendFileSync('started', process.pid + '\\n'); setTimeout(() => {}, 60000);");
  return root;
}

async function startedPool(root) {
  const marker = path.join(root, 'started'), end = Date.now() + 10000;
  while (!fs.existsSync(marker) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(fs.existsSync(marker), 'the real pooled command started');
  return Number(fs.readFileSync(marker, 'utf8').trim());
}

test('controller shutdown cancels a real test pool quietly, stops its child and drops queued checks', { timeout: 30000 }, async t => {
  const { Controller } = require('../src/controller.cjs');
  const { EventEmitter } = require('node:events');
  const root = holdingPool(), warnings = [], infos = [];
  const client = Object.assign(new EventEmitter(), { close() {} });
  const bot = new Controller(path.join(root, 'sessions.json'), root, client, { cancel() {}, close() {} }, { nativeCLIs: new Map() });
  bot.log = { warn: (...args) => warnings.push(args), info: (...args) => infos.push(args), error: (...args) => warnings.push(args) };
  t.after(async () => { await bot.shutdown({ stopMs: 0, graceMs: 0, killMs: 5000 }); });
  const first = bot.create(root, 'danger-full-access'), queued = bot.create(root, 'danger-full-access');
  first.items = chat(root).items; queued.items = chat(root).items;
  const pending = bot.startTestPool(root, first);
  const pid = await startedPool(root);
  bot.startTestPool(root, queued);
  const result = await bot.shutdown({ stopMs: 0, graceMs: 100, killMs: 5000 });
  await pending;
  assert.deepEqual(result.remaining, []);
  if (process.platform === 'linux') {
    let state;
    try { state = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0]; } catch { /* already reaped */ }
    assert.ok(!state || state === 'Z', 'the pooled command stopped (an unreaped zombie is not running)');
  } else {
    assert.throws(() => process.kill(pid, 0), 'the pooled command did not survive shutdown');
  }
  assert.equal(fs.readFileSync(path.join(root, 'started'), 'utf8').trim().split('\n').length, 1);
  assert.equal(bot.testPoolProcesses.size, 0);
  assert.deepEqual(warnings, []);
  assert.equal(infos.filter(([message]) => message === 'Test pool cancelled during shutdown').length, 1);
  await bot.startTestPool(root, queued);
  await bot.runTestPool(root, queued);
  assert.equal(fs.readFileSync(path.join(root, 'started'), 'utf8').trim().split('\n').length, 1, 'closed controllers cannot start another pool');
});

test('an unexpected test-pool exit still warns when cancellation was not requested', { timeout: 30000 }, async t => {
  const root = holdingPool(), warnings = [], infos = [];
  const bot = controller({ log: { warn: (...args) => warnings.push(args), info: (...args) => infos.push(args) } });
  t.after(() => bot.stopTestPools());
  const pending = bot.runTestPool(root, chat(root));
  await startedPool(root);
  const run = [...bot.testPoolProcesses][0];
  assert.deepEqual(await require('../src/process-tree.cjs').stopTree(run.child), []);
  await pending;
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0][0], 'Test pool exited unexpectedly');
  assert.deepEqual(infos, []);
});

test('pool serialization keeps every waiting chat and treats Windows case aliases as one repository', async () => {
  const root = repo(), calls = [], releases = [];
  const make = name => controller({ runTestPool: async (_root, session, last) => {
    calls.push([name, session.id, last]);
    await new Promise(resolve => releases.push(resolve));
  } });
  const first = make('first'), second = make('second'), third = make('third');
  const sessions = [chat(root), { ...chat(root), id: 'two' }, { ...chat(root), id: 'three' }];
  const pending = first.startTestPool(root, sessions[0]);
  const alias = process.platform === 'win32' ? root.toUpperCase() : root;
  second.startTestPool(alias, sessions[1]);
  third.startTestPool(root, sessions[2]);
  assert.equal(calls.length, 1, 'aliases share the active run');
  const last = sessions[1].items.at(-1);
  sessions[1].items.push({ type: 'agentMessage', text: 'Newer turn while waiting' });
  releases.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls[1], ['second', 'two', last], 'queued work retains its original turn identity');
  releases.shift()(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls[2][0], 'third');
  releases.shift()(); await pending;
  assert.equal(calls.length, 3);
});
