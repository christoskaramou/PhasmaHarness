'use strict';
// How a failing pool check is handed back to each agent. Run: node --test tests/testpool-hook.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const tp = require('../skills/test-pool/scripts/testpool.cjs');

// Temporary folders made by these tests are removed at the end.
const made = [];
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
const git = (cwd, ...args) => { const r = spawnSync('git', args, { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };

// A repository whose one pooled test fails when src.txt contains BROKEN. Jev is off, so no network is used.
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-hook-'));
  made.push(root);
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 't@t'); git(root, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(root, 'src.txt'), 'ok\n');
  fs.mkdirSync(path.join(root, '.testpool'));
  fs.writeFileSync(path.join(root, '.testpool', '.gitignore'), 'runs/\n');
  fs.writeFileSync(path.join(root, '.testpool', 'catalog.json'), JSON.stringify({
    version: 1, settings: { jev: 'off', maxBlocks: 2 }, setups: {},
    tests: [{ id: 'src-ok', name: 'src stays ok', covers: 'src.txt must never contain the word BROKEN', paths: ['src.txt'],
      command: 'node -e "process.exit(require(\'fs\').readFileSync(\'src.txt\',\'utf8\').includes(\'BROKEN\') ? 1 : 0)"', cost: 'cheap', timeoutSec: 30 }],
  }));
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'init');
  return root;
}

async function failingHook(agent) {
  const root = repo();
  const input = { session_id: `s-${agent}`, cwd: root, last_assistant_message: 'edited src.txt' };
  assert.equal((await tp.hook(agent, input)).code, 0); // first check records the clean state
  fs.writeFileSync(path.join(root, 'src.txt'), 'BROKEN\n');
  return tp.hook(agent, input);
}

test('Codex gets the failure as a JSON block decision with exit 0', async () => {
  const r = await failingHook('codex');
  assert.equal(r.code, 0);
  assert.equal(r.stderr, undefined);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, 'block');
  assert.match(out.reason, /^Test pool: 1 failed/);
  assert.match(out.reason, /FAILED src-ok/);
});

test('Claude Code still gets exit 2 with the report on stderr', async () => {
  const r = await failingHook('claude');
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^Test pool: 1 failed/);
});

test('Cursor still gets a followup_message', async () => {
  const r = await failingHook('cursor');
  assert.equal(r.code, 0);
  assert.match(JSON.parse(r.stdout).followup_message, /^Test pool: 1 failed/);
});

test('Codex retries stop after maxBlocks and the report is no longer a block', async () => {
  const root = repo();
  const input = { session_id: 's-cap', cwd: root };
  await tp.hook('codex', input);
  const outputs = [];
  for (let i = 0; i < 3; i++) {
    fs.writeFileSync(path.join(root, 'src.txt'), `BROKEN ${i}\n`);
    outputs.push(await tp.hook('codex', input));
  }
  assert.equal(JSON.parse(outputs[0].stdout).decision, 'block');
  assert.equal(JSON.parse(outputs[1].stdout).decision, 'block');
  assert.equal(outputs[2].stdout, undefined);
  assert.match(outputs[2].stderr, /Still failing after 2 automatic retries/);
});
