const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { Controller } = require('../src/controller.cjs');
const { install, installer, run } = require('../src/providers/install.cjs');
const { createTask } = require('../src/tasks.cjs');

class NoCodex extends EventEmitter {
  async start() { throw Object.assign(new Error('Codex CLI is not installed.'), { code: 'ENOENT' }); }
  async call() { throw new Error('Codex is not connected.'); }
  close() {}
}

async function start(t, { claude }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-no-codex-'));
  const controller = new Controller(path.join(directory, 'state.json'), directory, new NoCodex(), { cancel() {}, close() {}, jev: null });
  controller.data.settings.claudeEnabled = claude;
  controller.claude.refresh = async () => (controller.claude.status = { installed: claude, loggedIn: claude });
  controller.cursor.refresh = async () => (controller.cursor.status = { installed: false, loggedIn: false });
  await controller.initialize();
  t.after(() => { controller.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return controller;
}

test('without Codex, a signed-in Claude makes the app ready and becomes the router', async t => {
  const controller = await start(t, { claude: true });
  assert.equal(controller.connection, 'ready');
  assert.equal(controller.snapshot().codex.installed, false);
  assert.match(controller.data.settings.routerPreset, /^claude-cli:/);
});

test('without any provider, the app asks to install one instead of failing', async t => {
  const controller = await start(t, { claude: false });
  assert.equal(controller.connection, 'signed-out');
  assert.match(controller.error, /Install or connect one in Settings → Providers/);
  assert.equal(controller.snapshot().claude.installed, false);
});

class LiveCodex extends EventEmitter {
  constructor(fail = false) { super(); this.fail = fail; }
  async start() {}
  async call(method) {
    if (this.fail) throw new Error('account/read timed out. Check Codex connectivity before retrying.');
    return method === 'account/read' ? { account: { type: 'chatgpt', planType: 'pro' } }
      : { data: [{ model: 'gpt-5.6-terra', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }], nextCursor: null };
  }
  close() {}
}

async function withClaude(t, client) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-codex-live-'));
  const controller = new Controller(path.join(directory, 'state.json'), directory, client, { cancel() {}, close() {}, jev: null });
  controller.data.settings.claudeEnabled = true;
  controller.claude.refresh = async () => (controller.claude.status = { installed: true, loggedIn: true });
  controller.cursor.refresh = async () => controller.cursor.status;
  await controller.initialize();
  t.after(() => { controller.close(); fs.rmSync(directory, { recursive: true, force: true }); });
  return controller;
}
const codexRoutable = controller => controller.catalog().some(p => p.provider === 'codex' && controller.available(p));

test('a Codex crash leaves an active Claude turn, its permission prompt and the app running', async t => {
  const client = new LiveCodex();
  const controller = await withClaude(t, client);
  assert.equal(controller.codex.connected, true);
  assert.equal(codexRoutable(controller), true);
  assert.match(controller.data.settings.routerPreset, /^codex:/);

  controller.cliAbort = new AbortController();
  const answers = {};
  for (const id of ['cli-permission', 'router-gateway']) {
    controller.helperApprovals.set(id, value => { answers[id] = value; });
    controller.requests.set(id, { id });
  }
  client.emit('disconnected', 'Codex disconnected (1).');
  assert.equal(controller.cliAbort.signal.aborted, false);
  assert.equal(controller.connection, 'ready');
  assert.equal(controller.codex.connected, false);
  assert.deepEqual(answers, { 'router-gateway': false });
  assert.ok(controller.requests.has('cli-permission'));
  assert.equal(codexRoutable(controller), false);
  assert.match(controller.data.settings.routerPreset, /^claude-cli:/);

  controller.cliAbort = null;
  controller.claude.status = { installed: true, loggedIn: false };
  client.emit('disconnected', 'Codex disconnected (1).');
  assert.equal(controller.connection, 'disconnected');
});

test('a Codex account/model load failure leaves Claude usable and a later refresh recovers Codex', async t => {
  const client = new LiveCodex(true);
  const controller = await withClaude(t, client);
  assert.equal(controller.connection, 'ready');
  assert.equal(codexRoutable(controller), false);
  assert.match(controller.data.settings.routerPreset, /^claude-cli:/);
  assert.match(controller.snapshot().codex.error, /account\/read timed out/);

  client.fail = false;
  await controller.refreshAccount();
  assert.equal(codexRoutable(controller), true);
  assert.equal(controller.snapshot().codex.error, undefined);
});

function localRunner(controller) {
  const workspace = fs.realpathSync(path.dirname(controller.filename));
  const check = (argv, timeoutMs = 20000) => ({ id: 'c', name: 'probe', argv: [process.execPath, '-e', argv], cwd: workspace, timeoutMs, readOnlySafe: false });
  const runOne = async (access, spec, onGate = () => {}) => {
    const session = controller.create(workspace, access);
    const task = createTask({ messageId: 'm', goal: 'g', checks: [spec], access });
    const gate = { sessionId: session.id, taskId: task.id, token: 'x', abort: new AbortController(), processId: null, approvals: new Set() };
    controller.gate = gate; controller.busy = session.id;
    const pending = controller.runCheck(session, task, spec, gate);
    onGate(gate);
    const result = await pending;
    controller.gate = null; controller.busy = null;
    return result;
  };
  return { workspace, check, runOne };
}
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function gone(pid) {
  for (let i = 0; i < 60 && alive(pid); i++) await new Promise(r => setTimeout(r, 100));
  return !alive(pid);
}
const DETACHED = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();console.log('child '+c.pid)";

test('without Codex, configured checks run locally: pass, fail, timeout, stop and an honest approval prompt', async t => {
  const controller = await start(t, { claude: true });
  const { check, runOne } = localRunner(controller);
  const passed = await runOne('danger-full-access', check('console.log("ok")'));
  assert.equal(passed.status, 'passed'); assert.match(passed.stdout, /ok/);
  assert.ok(!controller.data.executionBlock);
  const failed = await runOne('danger-full-access', check('process.exit(3)'));
  assert.deepEqual([failed.status, failed.detail], ['failed', 'exit 3']);
  const slow = await runOne('danger-full-access', check('setInterval(() => {}, 1000)', 1000));
  assert.deepEqual([slow.status, slow.detail], ['failed', 'timed out']);
  const stopped = await runOne('danger-full-access', check('setInterval(() => {}, 1000)'), () => setTimeout(() => controller.stop(), 1500));
  assert.equal(stopped, null);
  assert.ok(!controller.data.executionBlock);
  const denied = await runOne('workspace-write', check('console.log("never")'), () => setImmediate(() => {
    const [id, request] = [...controller.requests].find(([key]) => key.startsWith('check-'));
    assert.match(request.params.reason, /without the Codex sandbox/);
    controller.helperApprovals.get(id)(false);
  }));
  assert.deepEqual([denied.status, denied.detail], ['blocked', 'approval denied']);
});

test('a check that exits while a detached child keeps running does not pass silently: the child is stopped', async t => {
  const controller = await start(t, { claude: true });
  const { check, runOne } = localRunner(controller);
  const result = await runOne('danger-full-access', check(DETACHED));
  const child = Number(result.stdout.match(/child (\d+)/)[1]);
  assert.equal(result.status, 'passed');
  assert.match(result.detail, /stopped 1 leftover process/);
  assert.ok(await gone(child), 'detached child must not survive the check');
  assert.ok(!controller.data.executionBlock);
});

test('check ownership is saved before the command starts; a failed save starts nothing', async t => {
  const controller = await start(t, { claude: true });
  const { workspace, check, runOne } = localRunner(controller);
  const marker = path.join(workspace, 'ran.txt');
  const save = controller.save.bind(controller);
  controller.save = () => { if (controller.data.executionBlock) throw new Error('disk full'); save(); };
  const refused = await runOne('danger-full-access', check(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`));
  controller.save = save;
  assert.deepEqual([refused.status, refused.detail], ['blocked', 'could not persist the execution block']);
  await new Promise(r => setTimeout(r, 300));
  assert.equal(fs.existsSync(marker), false);

  let onDisk;
  const running = runOne('danger-full-access', check('setTimeout(() => {}, 1500)'), () => setTimeout(() => {
    onDisk = JSON.parse(fs.readFileSync(controller.filename, 'utf8')).executionBlock;
  }, 600));
  assert.equal((await running).status, 'passed');
  assert.ok(onDisk?.processId && Number.isInteger(onDisk.pid) && onDisk.runtime.local, 'the running check must be recorded on disk');
});

test('a reused pid is never owned: exact creation time once observed, a narrow window before', () => {
  const { linkDescendants } = require('../src/process-tree.cjs');
  const T = 1_800_000_000_000;
  const approx = new Map([[10, { startedMs: T, exact: false }]]);
  assert.equal(linkDescendants([{ pid: 10, ppid: 1, startedMs: T + 5000 }, { pid: 11, ppid: 10, startedMs: T + 5100 }], approx), true);
  assert.deepEqual([...approx.keys()], [], 'a pid reused 5 s after spawn and its child are not the check');

  const exact = new Map([[10, { startedMs: T, exact: true }]]);
  linkDescendants([{ pid: 10, ppid: 1, startedMs: T + 3 }, { pid: 11, ppid: 10, startedMs: T + 50 }], exact);
  assert.deepEqual([...exact.keys()], [], 'an observed root must match exactly');

  const own = new Map([[10, { startedMs: T, exact: false }]]);
  assert.equal(linkDescendants([{ pid: 10, ppid: 1, startedMs: T + 40 }, { pid: 11, ppid: 10, startedMs: T + 90 }], own), true);
  assert.deepEqual([...own], [[10, { startedMs: T + 40, exact: true }], [11, { startedMs: T + 90, exact: true }]]);
  assert.equal(linkDescendants([{ pid: 10, ppid: 1, startedMs: T + 40 }, { pid: 11, ppid: 10, startedMs: T + 90 }], own), false);
});

test('a failed Windows process scan is never read as "nothing remains"', () => {
  const { windowsTable, scan } = require('../src/process-tree.cjs');
  const run = scan.run;
  const row = '4 0 133000000000000000';
  const outcomes = [
    [{ status: 0, stdout: '', stderr: 'Get-CimInstance : Access denied' }, 'CIM error with exit 0 and empty stdout'],
    [{ status: 0, stdout: '', stderr: '' }, 'no end marker'],
    [{ status: 0, stdout: 'END-OF-PROCESS-LIST\n', stderr: '' }, 'empty table'],
    [{ status: 0, stdout: row + '\n', stderr: '' }, 'rows without the end marker (truncated)'],
    [{ status: 0, stdout: row + '\nEND-OF-PROCESS-LIST\n', stderr: 'warning' }, 'anything on stderr'],
    [{ status: 1, stdout: row + '\nEND-OF-PROCESS-LIST\n', stderr: '' }, 'non-zero exit'],
    [{ error: new Error('spawn failed') }, 'spawn failure'],
  ];
  try {
    for (const [result, label] of outcomes) {
      scan.run = () => result;
      assert.throws(() => windowsTable(), /Process list unavailable/, label);
    }
    scan.run = () => ({ status: 0, stdout: row + '\r\nEND-OF-PROCESS-LIST\r\n', stderr: '' });
    assert.equal(windowsTable().length, 1);
  } finally { scan.run = run; }
});

test('a real CIM enumeration error fails the scan, and the execution block is retained', { skip: process.platform !== 'win32' && 'Windows process scan' }, async t => {
  const { windowsTable, scan } = require('../src/process-tree.cjs');
  const { spawnSync } = require('node:child_process');
  const run = scan.run;
  const broken = (file, args, options) => spawnSync(file, args.map(arg => arg.replace('Win32_Process', 'Win32_PhasmaMissingClass')), options);
  const controller = await start(t, { claude: true });
  const { check, runOne } = localRunner(controller);
  try {
    scan.run = broken;
    assert.throws(() => windowsTable(), /Process list unavailable/);

    const result = await runOne('danger-full-access', check('console.log("ok")'));
    assert.deepEqual([result.status, result.detail], ['unknown', 'check execution unconfirmed']);
    assert.ok(controller.data.executionBlock?.runtime.local, 'an unverified check keeps its execution block');
    assert.ok(JSON.parse(fs.readFileSync(controller.filename, 'utf8')).executionBlock, 'and it is on disk for restart');
    assert.equal(controller.recoverExecutionBlock(), false, 'recovery cannot clear it while scans fail');

    scan.run = run;
    assert.equal(controller.recoverExecutionBlock(), true, 'a working scan confirms nothing remains');
  } finally { scan.run = run; }
});

test('a missing executable fails the check without leaving an execution block', async t => {
  const controller = await start(t, { claude: true });
  const { workspace, runOne } = localRunner(controller);
  const result = await runOne('danger-full-access', { id: 'c', name: 'missing', argv: ['phasma-no-such-program-xyz'], cwd: workspace, timeoutMs: 5000, readOnlySafe: false });
  assert.equal(result.status, 'blocked');
  assert.match(result.detail, /phasma-no-such-program-xyz was not found/);
  assert.ok(!controller.data.executionBlock);
  assert.ok(!JSON.parse(fs.readFileSync(controller.filename, 'utf8')).executionBlock);
});

test('recorded descendants reach disk even when the tree stops changing (Windows watcher)', { skip: process.platform !== 'win32' && 'Linux finds descendants by environment tag' }, async t => {
  const controller = await start(t, { claude: true });
  const { check, runOne } = localRunner(controller);
  let onDisk;
  const result = await runOne('danger-full-access', check(`setTimeout(() => { ${DETACHED} }, 300); setTimeout(() => {}, 5000)`), () => setTimeout(() => {
    onDisk = JSON.parse(fs.readFileSync(controller.filename, 'utf8')).executionBlock;
  }, 4200));
  const child = Number(result.stdout.match(/child (\d+)/)[1]);
  assert.ok(onDisk.children.some(entry => entry.pid === child && entry.exact), 'the detached child must be saved for crash recovery');
  assert.match(result.detail, /stopped 1 leftover process/);
  assert.ok(await gone(child));
});

test('crash recovery stops a surviving local check tree, including a detached child, then clears the block', async t => {
  const controller = await start(t, { claude: true });
  const { spawn } = require('node:child_process');
  const spawnedAt = Date.now();
  const root = spawn(process.execPath, ['-e', DETACHED + ';setInterval(()=>{},1000)'], { env: { ...process.env, PHASMA_HARNESS_CHECK: 'crashed' }, stdio: ['ignore', 'pipe', 'ignore'] });
  const child = await new Promise(resolve => root.stdout.on('data', d => { const m = String(d).match(/child (\d+)/); if (m) resolve(Number(m[1])); }));
  root.kill();
  assert.ok(await gone(root.pid));
  assert.ok(alive(child), 'the detached child outlives its crashed parent');
  controller.data.executionBlock = { processId: 'crashed', pid: root.pid, spawnedAt, children: [], runtime: { local: true, platform: process.platform } };
  assert.equal(controller.recoverExecutionBlock(), true);
  assert.ok(!controller.data.executionBlock);
  assert.ok(await gone(child));
  if (process.platform === 'win32') {
    controller.data.executionBlock = { processId: 'lost', spawnedAt, children: [], runtime: { local: true, platform: 'win32' } };
    assert.equal(controller.recoverExecutionBlock(), false, 'an unrecorded Windows root cannot be verified, so the block stays');
  }
});

test('Claude turns feed the context meter and support manual compaction', async t => {
  const controller = await start(t, { claude: true });
  const runs = [];
  controller.claude.run = async options => {
    runs.push(options);
    if (options.prompt === '/compact') { options.onEvent({ type: 'system', subtype: 'compact_boundary', session_id: 'claude-2' }); return { type: 'result', result: '' }; }
    options.onEvent({ type: 'assistant', session_id: 'claude-1', message: { id: 'a1', content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 10, cache_read_input_tokens: 40000, cache_creation_input_tokens: 90, output_tokens: 20 } } });
    return { type: 'result', result: 'hi', usage: { input_tokens: 10, output_tokens: 20 },
      modelUsage: { 'claude-haiku': { inputTokens: 5, contextWindow: 100000 }, 'claude-sonnet': { inputTokens: 10, cacheReadInputTokens: 40000, contextWindow: 200000 } } };
  };
  const session = controller.create(fs.realpathSync(path.dirname(controller.filename)), 'read-only');
  await controller.send({ id: session.id, text: 'hello', mode: 'claude-cli:sonnet', task: 'off' });
  assert.equal(session.usage.last.totalTokens, 40120);
  assert.equal(session.usage.modelContextWindow, 200000);

  await controller.compact(session.id);
  assert.equal(runs.at(-1).prompt, '/compact');
  assert.equal(runs.at(-1).resume, 'claude-1');
  assert.equal(session.claudeSessionId, 'claude-2');
  assert.equal(session.usage.last, undefined);
  assert.match(session.notice, /compacted/);
  controller.data.sessions.find(s => s.id === session.id).activeProvider = 'cursor-cli';
  await assert.rejects(controller.compact(session.id), /Cursor manages its context automatically/);
});

test('a failed installer download fails the install instead of piping nothing into a shell', async () => {
  const fake = () => { const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); setImmediate(() => child.emit('close', 0)); return child; };
  let seen;
  await install('cursor-cli', { spawnProcess: (file, args) => { seen = args.at(-1); return fake(); } });
  assert.match(seen, process.platform === 'win32' ? /^\$ErrorActionPreference = 'Stop'; / : /^set -o pipefail; /);
  const failing = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-Command', "$ErrorActionPreference = 'Stop'; irm http://127.0.0.1:9/install | iex"]]
    : ['bash', ['-lc', 'set -o pipefail; (exit 22) | bash']];
  await assert.rejects(run('Probe', ...failing, { timeoutMs: 30000 }), /Probe install failed \(exit [1-9]/);
});

test('installer timeout stops the whole process tree and rejects', async () => {
  const parent = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log('grandchild '+c.pid);setInterval(()=>{},1000)";
  const error = await run('Probe', process.execPath, ['-e', parent], { timeoutMs: 1500 }).then(() => null, e => e);
  assert.match(error?.message, /Probe install timed out/);
  const pid = Number(error.message.match(/grandchild (\d+)/)[1]);
  const alive = () => { try { process.kill(pid, 0); return true; } catch { return false; } };
  for (let i = 0; i < 50 && alive(); i++) await new Promise(r => setTimeout(r, 100));
  assert.equal(alive(), false, 'grandchild holding the output pipes must be killed');
});

test('provider installer runs the official command and reports failures', async () => {
  assert.throws(() => installer('nope'), /Unknown provider/);
  const runs = [];
  const fakeSpawn = code => (file, args) => {
    runs.push([file, args]);
    const child = new EventEmitter();
    child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
    setImmediate(() => { child.stderr.write('permission denied\n'); child.emit('close', code); });
    return child;
  };
  await install('claude-cli', { spawnProcess: fakeSpawn(0) });
  const [file, args] = runs[0];
  if (process.platform === 'win32') assert.deepEqual([file, args.at(-1)], ['powershell.exe', "$ErrorActionPreference = 'Stop'; irm https://claude.ai/install.ps1 | iex"]);
  else assert.deepEqual([file, args], ['bash', ['-lc', 'set -o pipefail; curl -fsSL https://claude.ai/install.sh | bash']]);
  await assert.rejects(install('codex', { spawnProcess: fakeSpawn(1) }), /Codex CLI install failed \(exit 1\)\. permission denied/);
});
