const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Controller } = require('../src/controller.cjs');
const { SmartRouter } = require('../src/routing/smart-router.cjs');
const { NATIVE_CLI_INFO, findNativeCLI } = require('../src/providers/native-cli.cjs');
const { buildDiagnostics } = require('../src/diagnostics.cjs');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-native-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

class NoCodex extends EventEmitter {
  async start() { throw Object.assign(new Error('Codex is not installed.'), { code: 'ENOENT' }); }
  async call() { throw new Error('Codex must not be used.'); }
  close() {}
}

async function controllerFixture(t, enabled) {
  const root = directory(t), calls = [];
  const backend = { models: [{ id: 'native:deepseek:model-a', model: 'model-a', label: 'DeepSeek A', provider: 'native:deepseek',
    worker: true, router: true, efforts: [], effort: null, rank: 35 }], status: { installed: true, loggedIn: true, version: 'fixture' },
    inspect() { calls.push('inspect'); return this.status; },
    async refresh() { calls.push('refresh'); return this.status; },
    async run(options) { calls.push(options); options.onEvent?.({ type: 'system', session_id: 'native-session' }); return { result: 'Native reply' }; },
    close() {},
  };
  const controller = new Controller(path.join(root, 'state.json'), root, new NoCodex(), { cancel() {}, close() {}, jev: null },
    { nativeCLIs: new Map([['native:deepseek', backend]]) });
  controller.data.settings.deepseekEnabled = enabled;
  controller.claude.refresh = async () => (controller.claude.status = { installed: false, loggedIn: false });
  controller.cursor.refresh = async () => (controller.cursor.status = { installed: false, loggedIn: false });
  await controller.initialize();
  t.after(() => controller.close());
  return { controller, backend, calls, root };
}

test('native binary discovery handles standard installs and missing executables without a shell', t => {
  const root = directory(t);
  const muse = path.join(root, 'Programs', 'muse');
  fs.mkdirSync(muse, { recursive: true });
  fs.writeFileSync(path.join(muse, 'muse-bin-1.4.9-R1.exe'), 'fixture');
  fs.writeFileSync(path.join(muse, 'muse-bin-1.4.10-R1.exe'), 'fixture');
  const env = { PATH: root, LOCALAPPDATA: root, USERPROFILE: root, APPDATA: root };
  assert.match(findNativeCLI('muse-cli', env, 'win32').command, /1\.4\.10/);
  assert.throws(() => findNativeCLI('antigravity-cli', env, 'win32'), { code: 'ENOENT' });
  const npm = path.join(root, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  fs.mkdirSync(npm, { recursive: true });
  fs.writeFileSync(path.join(npm, 'bin.js'), 'fixture');
  const found = findNativeCLI('deepseek-cli', env, 'win32');
  assert.equal(found.command, process.execPath);
  assert.equal(found.args[0], path.join(npm, 'bin.js'));
  assert.ok(Object.keys(NATIVE_CLI_INFO).every(id => id.startsWith('native:')));
});

test('a native-only account becomes ready, dispatches without Codex and keeps missing usage unknown', async t => {
  const { controller, calls, root } = await controllerFixture(t, true);
  controller.wikiStore = new (require('../src/workspace/wiki-store.cjs').WikiStore)(path.join(root, 'Workspaces'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Native managed instruction marker.');
  assert.equal(controller.connection, 'ready');
  assert.equal(controller.data.settings.routerPreset, 'native:deepseek:model-a');
  const session = controller.create(root, 'read-only');
  await controller.send({ id: session.id, text: 'hello', mode: 'native:deepseek:model-a', task: 'off' });
  const run = calls.find(call => typeof call === 'object');
  assert.equal(run.model, 'model-a');
  assert.equal(run.access, 'read-only');
  assert.match(run.instructions, /Native managed instruction marker/);
  assert.ok(run.instructions.includes(JSON.stringify(path.join(controller.wikiStore.location(root).root, 'index.md'))));
  assert.equal(run.managedInstructions, true);
  assert.equal(session['native:deepseekSessionId'], 'native-session');
  assert.equal(session.usage.total, undefined);
  assert.equal(session.usage.incomplete, true);
  assert.equal(session.routes.at(-1).turnUsage, undefined);
  assert.ok(session.items.some(item => item.text === 'Native reply'));
  assert.equal(controller.snapshot().nativeCLIs['native:deepseek'].version, 'fixture');
  const report = buildDiagnostics({ controller });
  assert.match(report, /DeepSeek Harness CLI fixture/);
  assert.doesNotMatch(report, /hello|Native reply/);
});

test('disabled native accounts are inspected without starting authentication or metadata subprocesses', async t => {
  const { controller, calls } = await controllerFixture(t, false);
  assert.deepEqual(calls, ['inspect']);
  assert.equal(controller.catalog().find(model => model.provider === 'native:deepseek').enabled, false);
});

test('native structured routing selects its runtime and cannot fall back to Claude', async t => {
  const root = directory(t);
  const router = new SmartRouter(root);
  const calls = [];
  router.nativeCLIs = new Map([['native:deepseek', { run: async options => {
    calls.push(options); return { structured_output: { ok: true } };
  } }]]);
  router.claude = { run() { throw new Error('Wrong account'); } };
  const result = await router.completeOnce({ prompt: 'data', instructions: 'Return JSON', schema: {} },
    { provider: 'native:deepseek', model: 'model-a', effort: null }, new AbortController());
  assert.deepEqual(result.decision, { ok: true });
  assert.equal(calls[0].model, 'model-a');
  router.nativeCLIs.clear();
  await assert.rejects(router.completeOnce({ prompt: 'data', instructions: '', schema: {} },
    { provider: 'native:deepseek', model: 'model-a' }, new AbortController()), /provider is unavailable/);
});
