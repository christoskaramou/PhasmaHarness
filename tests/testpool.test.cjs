const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const pool = require('../skills/test-pool/scripts/testpool.cjs');

const SCRIPT = path.resolve(__dirname, '../skills/test-pool/scripts/testpool.cjs');
const NODE = JSON.stringify(process.execPath);
const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout;
};

function repo(t, files = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'testpool-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'pool@example.test');
  git(dir, 'config', 'user.name', 'pool');
  git(dir, 'config', 'core.autocrlf', 'false');
  write(dir, { 'README.md': 'base\n', ...files });
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'base');
  return dir;
}
function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}
function catalog(dir, body) {
  write(dir, { '.testpool/catalog.json': JSON.stringify({ version: 1, ...body }, null, 2), '.testpool/.gitignore': 'runs/\n' });
}
// Marks the repository state as checked, so later edits are "changes since the last check".
function baseline(dir) {
  const r = spawnSync(process.execPath, [SCRIPT, 'baseline'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
}
const touch = (dir, name, text) => { write(dir, { [name]: text }); const later = new Date(Date.now() + 2000); fs.utimesSync(path.join(dir, name), later, later); };
const passCmd = `${NODE} -e "console.log('ok')"`;
const failCmd = `${NODE} -e "console.log('first line'); console.error('boom: expected 3 got 4'); process.exit(1)"`;
const testEntry = (id, extra = {}) => ({ id, name: `Test ${id}`, covers: `Behaviour protected by ${id} in the sample repo.`, command: passCmd, cost: 'cheap', ...extra });

// Fake Jev: answers every question with the choice picked by decide(instructions).
function fakeJev(decide, calls = []) {
  return async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, init, body });
    const answers = {};
    for (const [id, q] of Object.entries(body.questions)) {
      const choice = decide(q.instructions);
      const p = choice === 'run' ? 0.9 : choice === 'unsure' ? 0.4 : 0.05;
      answers[id] = { type: 'choice', choice: p >= 0.5 ? 'run' : 'skip', confidence: Math.max(p, 1 - p), probabilities: { run: p, skip: 1 - p } };
    }
    return { ok: true, status: 200, text: async () => JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 100, output_tokens: 5 } }) };
  };
}

test('catalog validation reports each broken field and fills defaults', () => {
  const good = pool.validate({ version: 1, setups: { build: { command: 'make' } }, tests: [testEntry('a', { needs: ['build'], paths: ['src/**'] })] });
  assert.deepEqual(good.errors, []);
  assert.equal(good.catalog.settings.maxBlocks, 2);
  assert.equal(good.catalog.tests[0].timeoutSec, 300);
  const bad = pool.validate({ version: 1, tests: [
    { id: 'Bad Id', name: 'x', covers: 'short', command: '' },
    testEntry('dup'), testEntry('dup', { cost: 'huge', needs: ['missing'], paths: 'src/**' }),
  ] });
  const text = bad.errors.join('\n');
  for (const expected of [/id must be lowercase/, /covers must describe/, /command must be a non-empty string/, /id is duplicated/, /cost must be one of/, /needs must list setup ids/, /paths must be an array/])
    assert.match(text, expected);
  assert.equal(bad.catalog, undefined);
});

test('path globs: ** crosses folders, * does not, braces alternate, Windows ignores case', () => {
  const m = pool.matcher(['Phasma/Runtime/Code/Script/**', '**/*.{cpp,h}', 'docs/*.md'], 'linux');
  assert.ok(m('Phasma/Runtime/Code/Script/Bindings/Lua.cpp'));
  assert.ok(m('Phasma/Runtime/Code/Script/CppScript.txt'));
  assert.ok(m('top.cpp') && m('a/b/c.h'));
  assert.ok(m('docs/index.md'));
  assert.ok(!m('docs/wiki/index.md'));
  assert.ok(!m('Phasma/Runtime/Code/Scene/Scene.txt'));
  assert.ok(!m('phasma/runtime/code/script/x.txt'));
  assert.ok(pool.matcher(['Phasma/Runtime/**'], 'win32')('phasma/runtime/x.txt'));
});

test('changes since the last check: edits, reverts and new commits count; committing checked work does not', t => {
  const dir = repo(t, { 'src/a.cpp': 'a\n', 'src/b.cpp': 'b\n' });
  const settings = pool.validate({ version: 1, tests: [] }).catalog.settings;
  // First check: only recent uncommitted edits count, not old ones.
  write(dir, { 'src/a.cpp': 'a2\n', 'src/old.cpp': 'old\n' });
  const old = new Date(Date.now() - 5 * 3600e3);
  fs.utimesSync(path.join(dir, 'src/old.cpp'), old, old);
  let prev = pool.snapshot(dir);
  assert.deepEqual(pool.changedFiles(dir, null, prev, settings), ['src/a.cpp']);
  // Nothing new.
  let now = pool.snapshot(dir);
  assert.deepEqual(pool.changedFiles(dir, prev, now, settings), []);
  // Edited again, a new file, and a revert of a checked edit.
  touch(dir, 'src/b.cpp', 'b2\n');
  write(dir, { 'src/new.h': 'n\n' });
  now = pool.snapshot(dir);
  assert.deepEqual(pool.changedFiles(dir, prev, now, settings), ['src/b.cpp', 'src/new.h']);
  prev = now;
  git(dir, 'checkout', '--', 'src/a.cpp');
  now = pool.snapshot(dir);
  assert.deepEqual(pool.changedFiles(dir, prev, now, settings), ['src/a.cpp']);
  prev = now;
  // Committing already-checked content is not a change; a file edited and committed within one turn is.
  git(dir, 'add', 'src/b.cpp', 'src/new.h');
  git(dir, 'commit', '-qm', 'checked work');
  now = pool.snapshot(dir);
  assert.deepEqual(pool.changedFiles(dir, prev, now, settings), []);
  prev = now;
  touch(dir, 'src/c.cpp', 'c\n');
  git(dir, 'add', 'src/c.cpp');
  git(dir, 'commit', '-qm', 'same turn');
  now = pool.snapshot(dir);
  assert.deepEqual(pool.changedFiles(dir, prev, now, settings), ['src/c.cpp']);
});

test('selection: path rules, always, sticky failures and platforms', () => {
  const { catalog } = pool.validate({ version: 1, tests: [
    testEntry('render', { paths: ['src/render/**'] }),
    testEntry('audio', { paths: ['src/audio/**'] }),
    testEntry('judge'),
    testEntry('smoke', { always: true, paths: ['nothing/**'] }),
    testEntry('win-only', { platforms: ['win32'], paths: ['src/**'] }),
    testEntry('was-failing', { paths: ['elsewhere/**'] }),
  ] });
  const state = { failing: { 'was-failing': { count: 0 } } };
  const picked = pool.select(catalog, ['src/render/pass.cpp'], state, { platform: 'linux' });
  assert.deepEqual(picked.run.map(c => [c.test.id, c.reason]), [['smoke', 'always'], ['was-failing', 'failed last check']]);
  assert.deepEqual(picked.ask.map(c => c.test.id), ['render', 'judge']);
  assert.deepEqual(picked.ask[0].hits, ['src/render/pass.cpp']);
  assert.deepEqual(picked.skipped, [{ id: 'audio', reason: 'no matching change' }]);
  assert.deepEqual(pool.select(catalog, [], state, { platform: 'linux' }), { run: [], ask: [], skipped: [] }, 'no changes, nothing to do');
  state.failing['was-failing'].count = 3;
  assert.ok(!pool.select(catalog, ['src/render/pass.cpp'], state, { platform: 'linux' }).run.some(c => c.test.id === 'was-failing'), 'sticky reruns are capped');
});

test('Jev decisions: run, unsure cheap runs, unsure expensive is suggested, confident skip', () => {
  const settings = pool.validate({ version: 1, tests: [] }).catalog.settings;
  const ask = ['a', 'b', 'c', 'd'].map(id => ({ test: { id, cost: id === 'c' ? 'expensive' : 'cheap' }, hits: [] }));
  const answer = p => ({ choice: p >= 0.5 ? 'run' : 'skip', confidence: 0.9, probabilities: { run: p, skip: 1 - p } });
  const d = pool.jevDecisions(ask, { answers: { t0: answer(0.9), t1: answer(0.4), t2: answer(0.4), t3: answer(0.05) } }, settings);
  assert.deepEqual(d.run.map(c => c.test.id), ['a', 'b']);
  assert.match(d.run[1].reason, /unsure/);
  assert.deepEqual(d.suggested.map(s => s.id), ['c']);
  assert.deepEqual(d.skipped.map(s => s.id), ['d']);
});

test('Jev client sends one question per candidate and never echoes the key', async () => {
  const calls = [];
  const questions = pool.jevQuestions([{ test: { id: 'x', name: 'X', cost: 'cheap', covers: 'Covers the X feature well.', origin: { problem: 'X crashed' } }, hits: ['src/x.cpp'] }],
    { x: { runs: 4, fails: 1, lastFail: '2026-09-20T10:00:00Z' } });
  assert.match(questions.t0.instructions, /X crashed/);
  assert.match(questions.t0.instructions, /src\/x\.cpp/);
  assert.match(questions.t0.instructions, /4 runs, 1 failures, last failure 2026-09-20/);
  const result = await pool.askJev('secret-key', { diff: 'd' }, questions, fakeJev(() => 'run', calls));
  assert.equal(calls[0].url, pool.JEV_URL);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret-key');
  assert.equal(calls[0].body.model, 'jev-1.13.0');
  assert.equal(result.answers.t0.choice, 'run');
  const rejected = await pool.askJev('secret-key', {}, questions, async () => ({ ok: false, status: 401, text: async () => 'bad key secret-key' })).catch(e => e);
  assert.equal(rejected.message, 'Jev rejected the API key');
  const broken = await pool.askJev('secret-key', {}, questions, async () => { throw new Error('connect secret-key'); }).catch(e => e);
  assert.doesNotMatch(broken.message, /secret-key/);
  await assert.rejects(pool.askJev('k', {}, questions, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ model: 'jev-1.13.0', answers: { t0: { type: 'choice', choice: 'maybe' } } }) })), /invalid decision/);
});

test('steps: pass, failure tail, 77 skip, missing requirement, test env without the Jev key', async t => {
  const dir = repo(t);
  const runDir = path.join(dir, 'out');
  fs.mkdirSync(runDir);
  const env = { TESTPOOL_ROOT: dir };
  process.env.JEV_API_KEY = 'never-in-tests';
  t.after(() => { delete process.env.JEV_API_KEY; });
  const pass = await pool.runStep('p', { command: `${NODE} -e "if (process.env.JEV_API_KEY || process.env.TESTPOOL_TEST_ID !== 'p' || !process.env.TESTPOOL_ROOT) process.exit(5)"` }, dir, runDir, env);
  assert.equal(pass.status, 'pass', JSON.stringify(pass));
  const fail = await pool.runStep('f', { command: failCmd }, dir, runDir, env);
  assert.equal(fail.status, 'fail');
  assert.equal(fail.reason, 'exit 1');
  assert.ok(fail.tail.some(l => /boom: expected 3 got 4/.test(l)));
  assert.match(fs.readFileSync(fail.logFile, 'utf8'), /first line/);
  const skip = await pool.runStep('s', { command: `${NODE} -e "console.log('editor already open on port 8765'); process.exit(77)"` }, dir, runDir, env);
  assert.deepEqual([skip.status, skip.reason], ['skip', 'editor already open on port 8765']);
  const missing = await pool.runStep('m', { command: passCmd, requires: ['${root}/build/Player.exe'] }, dir, runDir, env);
  assert.deepEqual([missing.status, missing.reason], ['skip', `missing ${dir.replace(/\\/g, '/')}/build/Player.exe`]);
});

test('a timed-out step is killed with the processes it started', async t => {
  const dir = repo(t);
  const pidFile = path.join(dir, 'pids');
  write(dir, { 'hang.js': `const { spawn } = require('child_process');
const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('fs').writeFileSync(${JSON.stringify(pidFile)}, process.pid + ' ' + c.pid);
setInterval(() => {}, 1000);` });
  const started = Date.now();
  const r = await pool.runStep('hang', { command: `${NODE} hang.js`, timeoutSec: 1 }, dir, dir, {});
  assert.equal(r.status, 'timeout');
  assert.ok(Date.now() - started < 10000);
  await new Promise(resolve => setTimeout(resolve, 300));
  // A killed process may linger as an unreaped zombie (state Z) under a container init; that is not running.
  const running = pid => { try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z'; } catch { try { process.kill(pid, 0); return process.platform !== 'linux'; } catch { return false; } } };
  for (const pid of fs.readFileSync(pidFile, 'utf8').split(' ').map(Number)) assert.ok(!running(pid), `process ${pid} still running`);
});

test('a step that exits but leaves a process holding its output still finishes', async t => {
  const dir = repo(t);
  const pidFile = path.join(dir, 'pid');
  write(dir, { 'leave.js': `const { spawn } = require('child_process');
const c = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true });
c.unref();
require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));` });
  pool.timing.graceMs = 300;
  t.after(() => { pool.timing.graceMs = 10000; try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch {} });
  const started = Date.now();
  const r = await pool.runStep('leave', { command: `${NODE} leave.js`, timeoutSec: 20 }, dir, dir, {});
  assert.equal(r.status, 'pass');
  assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
});

test('check: Jev picks among path-matched tests, a shared setup runs once, results and state are recorded', async t => {
  const dir = repo(t, { 'src/render/pass.cpp': 'v1\n', 'src/audio/mix.cpp': 'v1\n' });
  catalog(dir, {
    setups: { build: { command: `${NODE} -e "require('fs').appendFileSync('builds.txt', 'x')"` } },
    tests: [
      testEntry('render-smoke', { paths: ['src/render/**'], needs: ['build'], covers: 'Renderer passes draw a frame.' }),
      testEntry('render-regress', { paths: ['src/render/**'], needs: ['build'], command: failCmd, covers: 'Pass ordering bug from 2026-09.' }),
      testEntry('render-docs', { paths: ['src/**'], covers: 'Only the docs generator output.' }),
      testEntry('audio', { paths: ['src/audio/**'] }),
    ],
  });
  write(dir, { 'builds.txt': '' });
  git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'pool');
  baseline(dir);
  touch(dir, 'src/render/pass.cpp', 'v2\n');
  const calls = [];
  const result = await pool.check(dir, { jevKey: 'k', fetch: fakeJev(text => (/docs generator/.test(text) ? 'skip' : 'run'), calls), lastMessage: 'Fixed pass ordering.' });
  assert.equal(calls.length, 1, 'one Jev call for all candidates');
  assert.equal(Object.keys(calls[0].body.questions).length, 3, 'audio never reaches Jev: no matching change');
  assert.deepEqual(calls[0].body.state.changedFiles, ['src/render/pass.cpp']);
  assert.match(calls[0].body.state.diff, /\+v2/);
  assert.equal(calls[0].body.state.agentReply, 'Fixed pass ordering.');
  assert.deepEqual(result.outcome.results.map(r => [r.id, r.status]), [['render-regress', 'fail'], ['render-smoke', 'pass']]);
  assert.equal(fs.readFileSync(path.join(dir, 'builds.txt'), 'utf8'), 'x', 'setup ran once for both tests');
  assert.equal(result.failed, 1);
  assert.match(result.report, /^Test pool: 1 failed, 1 passed, 2 not needed\./);
  assert.match(result.report, /FAILED render-regress - exit 1/);
  assert.match(result.report, /\| boom: expected 3 got 4/);
  assert.match(result.report, /Not needed: render-docs \(Jev skip/);
  const last = JSON.parse(fs.readFileSync(path.join(dir, '.testpool/runs/last.json'), 'utf8'));
  assert.equal(last.results.length, 2);
  const history = fs.readFileSync(path.join(dir, '.testpool/runs/history.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(history.map(h => [h.id, h.status]), [['setup-build', 'pass'], ['render-regress', 'fail'], ['render-smoke', 'pass']]);
  assert.ok(result.state.failing['render-regress']);
  assert.equal(spawnSync('git', ['-C', dir, 'status', '--porcelain'], { encoding: 'utf8' }).stdout.includes('.testpool/runs'), false, 'run output is ignored by git');

  // No new changes: nothing runs and Jev is not asked.
  const idle = await pool.check(dir, { jevKey: 'k', fetch: fakeJev(() => 'run', calls) });
  assert.equal(calls.length, 1);
  assert.equal(idle.outcome.results.length, 0);
  // An unrelated change reruns the failing test without asking Jev about it.
  touch(dir, 'src/audio/mix.cpp', 'v2\n');
  const again = await pool.check(dir, { jevKey: 'k', fetch: fakeJev(() => 'skip', calls) });
  assert.ok(again.outcome.results.some(r => r.id === 'render-regress' && r.why === 'failed last check'));
});

test('without a Jev key only path-matched cheap and medium tests run; expensive ones are suggested', async t => {
  const dir = repo(t, { 'src/x.cpp': '1\n' });
  catalog(dir, { tests: [testEntry('quick', { paths: ['src/**'] }), testEntry('gpu', { paths: ['src/**'], cost: 'expensive' }), testEntry('judged')] });
  baseline(dir);
  touch(dir, 'src/x.cpp', '2\n');
  const r = await pool.check(dir, { jevKey: null });
  assert.deepEqual(r.outcome.results.map(x => x.id), ['quick']);
  assert.deepEqual(r.plan.suggested.map(s => s.id), ['gpu', 'judged']);
  assert.match(r.report, /Suggested, not run: gpu \(no JEV_API_KEY\), judged \(no JEV_API_KEY\)/);
  // A Jev outage falls back the same way and says so.
  touch(dir, 'src/x.cpp', '3\n');
  const down = await pool.check(dir, { jevKey: 'k', fetch: async () => ({ ok: false, status: 503, text: async () => '' }) });
  assert.deepEqual(down.outcome.results.map(x => x.id), ['quick']);
  assert.match(down.report, /Jev unavailable: Jev request failed \(HTTP 503\)/);
});

test('a failed setup blocks its tests and is reported as the failure', async t => {
  const dir = repo(t, { 'src/x.cpp': '1\n' });
  catalog(dir, { setups: { build: { command: failCmd } }, tests: [testEntry('needs-build', { paths: ['src/**'], needs: ['build'] }), testEntry('plain', { paths: ['src/**'] })] });
  baseline(dir);
  touch(dir, 'src/x.cpp', '2\n');
  const r = await pool.check(dir, { jevKey: null });
  assert.deepEqual(r.outcome.results.map(x => [x.id, x.status]), [['needs-build', 'blocked'], ['plain', 'pass']]);
  assert.equal(r.failed, 1);
  assert.match(r.report, /FAILED setup build - exit 1/);
});

test('the time budget stops starting new tests', async t => {
  const dir = repo(t, { 'src/x.cpp': '1\n' });
  catalog(dir, { settings: { budgetSec: 0 }, tests: [testEntry('a', { paths: ['src/**'], command: `${NODE} -e "setTimeout(() => {}, 50)"` }), testEntry('b', { paths: ['src/**'] })] });
  baseline(dir);
  touch(dir, 'src/x.cpp', '2\n');
  const r = await pool.check(dir, { jevKey: null });
  assert.deepEqual(r.outcome.results.map(x => [x.id, x.status]), [['a', 'pass'], ['b', 'not-run']]);
});

test('hook replies per agent: Claude and Codex block with exit 2, Cursor sends a follow-up, retries are capped', async t => {
  const dir = repo(t, { 'src/x.cpp': '1\n' });
  catalog(dir, { settings: { maxBlocks: 2 }, tests: [testEntry('broken', { paths: ['src/**'], command: failCmd })] });
  baseline(dir);
  const edit = n => touch(dir, 'src/x.cpp', `${n}\n`);
  edit(2);
  const first = await pool.hook('claude', { cwd: dir, session_id: 's1', last_assistant_message: 'done' }, { jevKey: null });
  assert.equal(first.code, 2);
  assert.match(first.stderr, /FAILED broken/);
  edit(3);
  assert.equal((await pool.hook('claude', { cwd: dir, session_id: 's1' }, { jevKey: null })).code, 2);
  edit(4);
  const capped = await pool.hook('claude', { cwd: dir, session_id: 's1' }, { jevKey: null });
  assert.equal(capped.code, 0, 'third block in a row is not sent');
  assert.match(JSON.parse(capped.stdout).systemMessage, /Still failing after 2 automatic retries/);
  edit(5);
  assert.equal((await pool.hook('codex', { cwd: dir, session_id: 's1' }, { jevKey: null })).code, 2, 'separate count per agent session');
  edit(6);
  const cursor = await pool.hook('cursor', { workspace_roots: [dir], conversation_id: 'c1', status: 'completed', loop_count: 0 }, { jevKey: null });
  assert.equal(cursor.code, 0);
  assert.match(JSON.parse(cursor.stdout).followup_message, /FAILED broken/);
  edit(7);
  assert.deepEqual(await pool.hook('cursor', { workspace_roots: [dir], status: 'aborted' }, { jevKey: null }), { code: 0 });
  // Fixed: the next reply passes and Claude sees a one-line summary.
  write(dir, { '.testpool/catalog.json': fs.readFileSync(path.join(dir, '.testpool/catalog.json'), 'utf8').replace(JSON.stringify(failCmd).slice(1, -1), JSON.stringify(passCmd).slice(1, -1)) });
  edit(8);
  const ok = await pool.hook('claude', { cwd: dir, session_id: 's1' }, { jevKey: null });
  assert.equal(ok.code, 0);
  assert.match(JSON.parse(ok.stdout).systemMessage, /^Test pool: 1 passed/);
  // No new changes: silent.
  assert.deepEqual(await pool.hook('claude', { cwd: dir, session_id: 's1' }, { jevKey: null }), { code: 0 });
});

test('a new failing test gets its own retries even after the cap was reached', async t => {
  const dir = repo(t, { 'src/x.cpp': '1\n', 'lib/y.cpp': '1\n' });
  catalog(dir, { settings: { maxBlocks: 1, stickyRuns: 0 }, tests: [testEntry('one', { paths: ['src/**'], command: failCmd }), testEntry('two', { paths: ['lib/**'], command: failCmd })] });
  baseline(dir);
  touch(dir, 'src/x.cpp', '2\n');
  assert.equal((await pool.hook('claude', { cwd: dir, session_id: 's' }, { jevKey: null })).code, 2);
  touch(dir, 'src/x.cpp', '3\n');
  assert.equal((await pool.hook('claude', { cwd: dir, session_id: 's' }, { jevKey: null })).code, 0);
  touch(dir, 'lib/y.cpp', '2\n');
  assert.equal((await pool.hook('claude', { cwd: dir, session_id: 's' }, { jevKey: null })).code, 2);
});

test('hook stays silent outside pools and reports an invalid catalog to Claude only', async t => {
  const plain = repo(t);
  assert.deepEqual(await pool.hook('claude', { cwd: plain }), { code: 0 });
  const dir = repo(t);
  write(dir, { '.testpool/catalog.json': '{"version": 1, "tests": [{"id": "x"}]}' });
  const r = await pool.hook('claude', { cwd: dir });
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.stdout).systemMessage, /catalog.json is invalid/);
  assert.deepEqual(await pool.hook('codex', { cwd: dir }), { code: 0 });
});

test('a second run waits for the lock, then gives up without running', async t => {
  const dir = repo(t, { 'src/x.cpp': '1\n' });
  catalog(dir, { tests: [testEntry('a', { paths: ['src/**'] })] });
  fs.mkdirSync(path.join(dir, '.testpool/runs'), { recursive: true });
  const holder = spawnSync(process.execPath, ['-e', 'console.log(process.ppid)']); // any live pid works; use ours
  fs.writeFileSync(path.join(dir, '.testpool/runs/lock'), JSON.stringify({ pid: process.pid, at: Date.now() }));
  assert.ok(holder);
  assert.deepEqual(await pool.check(dir, { jevKey: null, lockWaitSec: 0 }), { busy: true });
  fs.writeFileSync(path.join(dir, '.testpool/runs/lock'), JSON.stringify({ pid: 2 ** 22 + 12345, at: Date.now() }));
  assert.ok(!(await pool.check(dir, { jevKey: null, lockWaitSec: 0 })).busy, 'a lock from a dead process is taken over');
});

test('CLI: init, validate, list, dry-run check, run and the hook entry point', t => {
  const dir = repo(t, { 'src/x.cpp': '1\n' });
  const cli = (args, input) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: dir, encoding: 'utf8', input, env: { ...process.env, JEV_API_KEY: '' } });
  assert.match(cli(['init']).stdout, /Pool ready/);
  assert.equal(fs.readFileSync(path.join(dir, '.testpool/.gitignore'), 'utf8'), 'runs/\n');
  assert.match(cli(['validate']).stdout, /OK: 0 tests/);
  catalog(dir, { tests: [testEntry('quick', { paths: ['src/**'] }), testEntry('broken', { paths: ['src/**'], command: failCmd })] });
  assert.match(cli(['list']).stdout, /quick {2}\[cheap\] {2}Test quick/);
  baseline(dir);
  touch(dir, 'src/x.cpp', '2\n');
  const dry = cli(['check', '--dry-run']);
  assert.match(dry.stdout, /Would run: quick \(paths match \(no JEV_API_KEY\)\), broken/);
  assert.ok(!fs.existsSync(path.join(dir, '.testpool/runs/last.json')), 'dry run runs nothing');
  const run = cli(['run', 'quick']);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /1 passed/);
  assert.equal(cli(['run', 'nope']).status, 1);
  const hooked = cli(['hook', '--agent', 'claude'], JSON.stringify({ cwd: dir, session_id: 'cli' }));
  assert.equal(hooked.status, 2);
  assert.match(hooked.stderr, /FAILED broken/);
  write(dir, { '.testpool/catalog.json': '{ nope' });
  assert.equal(cli(['validate']).status, 1);
});

const installer = require('../skills/test-pool/scripts/install.cjs');

test('installer: skill copies for Claude and agents, Stop hooks merged into existing settings, idempotent, reversible', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'testpool-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const read = rel => JSON.parse(fs.readFileSync(path.join(home, rel), 'utf8'));
  write(home, {
    '.claude/settings.json': JSON.stringify({ model: 'opus', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify-send done' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] } }),
    '.cursor/hooks.json': JSON.stringify({ version: 1, hooks: { afterFileEdit: [{ command: 'fmt' }] } }),
  });
  const quiet = () => {};
  installer.install({ home, log: quiet });
  installer.install({ home, log: quiet }); // twice: still one entry each
  for (const dir of ['.claude/skills/test-pool', '.agents/skills/test-pool']) {
    const md = fs.readFileSync(path.join(home, dir, 'SKILL.md'), 'utf8');
    assert.ok(!md.includes('{{SKILL_DIR}}'));
    assert.ok(md.includes(`${path.join(home, dir).replace(/\\/g, '/')}/scripts/testpool.cjs`), `${dir} points at its own runner`);
    assert.ok(fs.existsSync(path.join(home, dir, 'scripts/testpool.cjs')));
  }
  const runner = path.join(home, '.agents/skills/test-pool/scripts/testpool.cjs').replace(/\\/g, '/');
  const claude = read('.claude/settings.json');
  assert.equal(claude.model, 'opus');
  assert.deepEqual(claude.hooks.PreToolUse, [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }]);
  assert.deepEqual(claude.hooks.Stop.map(g => g.hooks.map(h => h.command)), [['notify-send done'], [`node "${runner}" hook --agent claude`]]);
  assert.equal(claude.hooks.Stop[1].hooks[0].timeout, 1800);
  assert.deepEqual(read('.codex/hooks.json').hooks.Stop, [{ hooks: [{ type: 'command', command: `node "${runner}" hook --agent codex`, timeout: 1800 }] }]);
  const cursor = read('.cursor/hooks.json');
  assert.deepEqual(cursor, { version: 1, hooks: { afterFileEdit: [{ command: 'fmt' }], stop: [{ command: `node "${runner}" hook --agent cursor`, timeout: 1800 }] } });
  assert.ok(fs.existsSync(path.join(home, '.claude/settings.json.testpool-backup')), 'existing settings backed up');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json.testpool-backup'), 'utf8')).hooks.Stop.length, 1, 'backup is the original');

  installer.install({ home, log: quiet, claudeAsync: true });
  assert.equal(read('.claude/settings.json').hooks.Stop[1].hooks[0].asyncRewake, true);

  installer.install({ home, log: quiet, uninstall: true });
  assert.deepEqual(read('.claude/settings.json').hooks.Stop, [{ hooks: [{ type: 'command', command: 'notify-send done' }] }]);
  assert.equal(read('.codex/hooks.json').hooks, undefined);
  assert.deepEqual(read('.cursor/hooks.json').hooks, { afterFileEdit: [{ command: 'fmt' }] });
  assert.ok(!fs.existsSync(path.join(home, '.claude/skills/test-pool')) && !fs.existsSync(path.join(home, '.agents/skills/test-pool')));
});

test('installer refuses to overwrite invalid settings or a different skill with the same name', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'testpool-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  write(home, { '.agents/skills/test-pool/SKILL.md': '---\nname: something-else\n---\n' });
  assert.throws(() => installer.install({ home, log: () => {} }), /not the test-pool skill/);
  fs.rmSync(path.join(home, '.agents'), { recursive: true });
  write(home, { '.claude/settings.json': '{ "model": "opus", }' });
  assert.throws(() => installer.install({ home, log: () => {} }), /settings\.json is not valid JSON/);
  assert.equal(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8'), '{ "model": "opus", }');
});

test('the installed hook command runs the pool and blocks on a failing test', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'testpool-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  installer.install({ home, log: () => {} });
  const command = JSON.parse(fs.readFileSync(path.join(home, '.claude/settings.json'), 'utf8')).hooks.Stop[0].hooks[0].command;
  const dir = repo(t, { 'src/x.cpp': '1\n' });
  catalog(dir, { tests: [testEntry('broken', { paths: ['src/**'], command: failCmd })] });
  baseline(dir);
  touch(dir, 'src/x.cpp', '2\n');
  const r = spawnSync(command, { shell: true, cwd: os.tmpdir(), input: JSON.stringify({ cwd: dir, session_id: 'x' }), encoding: 'utf8', env: { ...process.env, JEV_API_KEY: '' } });
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stderr, /FAILED broken/);
});
