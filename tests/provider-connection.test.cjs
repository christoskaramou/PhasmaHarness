const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Controller } = require('../src/controller.cjs');
const { providerConnection, renewModels } = require('../src/provider-connection.cjs');
const { NATIVE_CLI_INFO } = require('../src/providers/native-cli.cjs');

function fixture() {
  const calls = [], settings = { chatgptEnabled: false, claudeEnabled: false, cursorEnabled: false, deepseekEnabled: false, museEnabled: false };
  const backend = label => ({ status: { installed: true, loggedIn: true }, async refresh() { calls.push(label); return this.status; },
    async discover() { calls.push(label + '-models'); },
    login() { throw new Error('Interactive sign-in must never start.'); }, logout() { throw new Error('Native sign-out must never run.'); } });
  const controller = { data: { settings }, busy: null, loading: new Map(), stopping: new Set(), connectingProviders: new Map(),
    codex: { installed: true, connected: true, signedIn: true }, claude: backend('claude'), cursor: backend('cursor'),
    nativeCLIs: new Map([['native:deepseek', backend('deepseek')], ['native:muse', backend('muse')], ['native:antigravity', backend('antigravity')]]),
    withProviderConnection: Controller.prototype.withProviderConnection, setProviderEnabled: Controller.prototype.setProviderEnabled,
    blockedReason: Controller.prototype.blockedReason, changed() { calls.push('state'); },
    async refreshAccount() { calls.push('account'); this.account = settings.chatgptEnabled && this.codex.signedIn ? { type: 'chatgpt' } : null; },
    async connectCodex() { calls.push('codex-start'); this.codex.connected = true; await this.refreshAccount(); },
    async discoverCursor() { calls.push('cursor-models'); }, migrateLegacyRouter() {}, claudeRouterFallback() {}, adoptRouter() {},
    save() { if (this.failSave) throw new Error('Storage failed.'); calls.push('save'); } };
  const agents = { busy: false, closing: false, allControllers: () => [controller],
    async refresh() { assert.equal(this.providerChanging, true); calls.push('sync'); },
    async refreshClaudeQuota() { calls.push('quota'); }, pump() { calls.push('pump'); },
    snapshot: () => ({ settings: { ...settings }, connecting: [...controller.connectingProviders.keys()] }) };
  controller.agents = agents;
  return { controller, agents, calls, settings };
}

test('browser connection enables only ready host-native accounts and clears progress before returning saved state', async () => {
  for (const [id, key] of [['codex', 'chatgptEnabled'], ['claude-cli', 'claudeEnabled'], ['cursor-cli', 'cursorEnabled'],
    ['native:deepseek', NATIVE_CLI_INFO['native:deepseek'].setting], ['native:muse', NATIVE_CLI_INFO['native:muse'].setting],
    ['native:antigravity', NATIVE_CLI_INFO['native:antigravity'].setting]]) {
    const f = fixture(), result = await providerConnection(f, id, 'connect');
    assert.equal(f.settings[key], true, id);
    assert.equal(result.settings[key], true);
    assert.deepEqual(result.connecting, []);
    assert.equal(f.agents.providerChanging, false);
    assert.ok(f.calls.includes('save')); assert.ok(f.calls.includes('sync'));
  }
});

test('Refresh preserves a disabled plug and Disconnect leaves native account authentication intact', async () => {
  const f = fixture();
  await providerConnection(f, 'native:muse', 'refresh');
  assert.equal(f.settings.museEnabled, false);
  assert.equal(f.controller.nativeCLIs.get('native:muse').status.loggedIn, true);
  await providerConnection(f, 'native:muse', 'connect');
  await providerConnection(f, 'native:muse', 'disconnect');
  assert.equal(f.settings.museEnabled, false);
  assert.equal(f.controller.nativeCLIs.get('native:muse').status.loggedIn, true);
});

test('signed-out, missing and incompatible accounts never enable or start native login', async () => {
  for (const status of [{ installed: true, loggedIn: false }, { installed: false, loggedIn: false },
    { installed: true, loggedIn: false, error: 'Unsupported protocol version.' }]) {
    const f = fixture(); f.controller.nativeCLIs.get('native:deepseek').status = status;
    await assert.rejects(providerConnection(f, 'native:deepseek', 'connect'), /runner host/);
    assert.equal(f.settings.deepseekEnabled, false);
    assert.equal(f.agents.providerChanging, false);
    assert.ok(!f.calls.includes('muse'));
  }
});

test('invalid commands and active work refuse connection changes before metadata or storage is touched', async () => {
  for (const [id, action] of [['__proto__', 'connect'], ['api-provider', 'connect'], ['native:muse', 'login'], ['native:muse', false]]) {
    const f = fixture(); await assert.rejects(providerConnection(f, id, action)); assert.deepEqual(f.calls, []);
  }
  for (const change of [f => { f.agents.busy = true; }, f => { f.controller.loading.set('chat', {}); },
    f => { f.controller.connectingProviders.set('codex', 1); }, f => { f.controller.data.executionBlock = true; }]) {
    const f = fixture(); change(f);
    await assert.rejects(providerConnection(f, 'native:muse', 'connect'), /Wait for current work/);
    assert.deepEqual(f.calls, []); assert.equal(f.settings.museEnabled, false);
  }
});

test('metadata holds execution admission, rejects conflicting configuration and releases after success or failure', async () => {
  const f = fixture(); let finish;
  f.controller.nativeCLIs.get('native:muse').refresh = () => new Promise(resolve => { finish = resolve; });
  const pending = providerConnection(f, 'native:muse', 'connect');
  assert.equal(f.agents.providerChanging, true);
  assert.match(f.controller.blockedReason(), /provider connection/);
  await assert.rejects(providerConnection(f, 'native:deepseek', 'connect'), /Wait for current work/);
  finish({ loggedIn: true }); await pending;
  assert.equal(f.controller.blockedReason(), null);
  const failure = fixture(); failure.controller.failSave = true;
  await assert.rejects(providerConnection(failure, 'codex', 'connect'), /Storage failed/);
  assert.equal(failure.settings.chatgptEnabled, false);
  assert.equal(failure.controller.account, null);
  assert.equal(failure.agents.providerChanging, false);
  assert.deepEqual([...failure.controller.connectingProviders], []);
});

test('shutdown during metadata cannot enable an account or launch fresh account reads', async () => {
  const f = fixture(); let finish;
  f.controller.nativeCLIs.get('native:muse').refresh = () => new Promise(resolve => { finish = resolve; });
  const pending = providerConnection(f, 'native:muse', 'connect');
  f.agents.closing = true; finish({ loggedIn: true });
  await assert.rejects(pending, /runner is stopping/);
  assert.equal(f.settings.museEnabled, false);
  assert.ok(!f.calls.includes('account')); assert.ok(!f.calls.includes('save'));
  assert.equal(f.agents.providerChanging, false);
});

test('model refresh shares execution admission, propagates models and preserves plug settings with clear metadata failures', async () => {
  const f = fixture();
  f.controller.nativeCLIs.get('native:deepseek').status.loggedIn = false;
  f.controller.nativeCLIs.get('native:muse').refresh = async () => { throw new Error('Model metadata unavailable.'); };
  const result = await renewModels(f);
  assert.match(result.modelRefreshNote, /Model metadata unavailable/);
  assert.ok(f.calls.includes('claude-models')); assert.ok(f.calls.includes('cursor-models'));
  assert.ok(!f.calls.includes('deepseek')); assert.ok(f.calls.includes('sync'));
  assert.deepEqual(result.settings, fixture().settings);
  assert.equal(f.agents.providerChanging, false);
  const busy = fixture(); busy.agents.busy = true;
  await assert.rejects(renewModels(busy), /Wait for current work/);
  assert.deepEqual(busy.calls, []);
});

test('a failed shared settings synchronization blocks execution until restart rather than using stale accounts', async () => {
  const f = fixture();
  f.agents.refresh = async () => { throw new Error('Worker settings could not save.'); };
  await assert.rejects(providerConnection(f, 'native:muse', 'connect'), /Restart Harness/);
  assert.match(f.controller.blockedReason(), /Provider settings could not synchronize/);
  assert.equal(f.agents.providerChanging, false);
  await assert.rejects(providerConnection(f, 'native:muse', 'disconnect'), /Wait for current work/);
});
