const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { SettingsTools } = require('../src/settings-tools.cjs');

function setup() {
  const agents = new EventEmitter();
  const saved = [], prompts = [];
  const worker = { agentId: 'main', loading: new Set(), activeTurns: new Map(), stopping: new Set(),
    requests: new Map(), cleanupPending: new Set(), blockedReason: () => null,
    data: { settings: { mode: 'auto', workspace: '/project', access: 'workspace-write', effortCap: 'high',
      checks: {}, privateCredential: 'NEVER RETURN THIS', providers: [{ id: 'local', name: 'Local', baseUrl: 'http://localhost/v1', enabled: true }] } },
    providers: { configured: () => true }, smartRouter: { jev: { keyStore: { configured: true } }, benchmarks: { data: { records: [] } } },
    catalog: () => [{ id: 'model', enabled: true }], routerChoices: () => [{ id: 'router' }],
    snapshot: () => ({ nativeCLIs: {} }), changed() {}, warmRouter() {},
  };
  Object.assign(agents, { busy: true, closing: false, allControllers: () => [worker],
    controller(id) { if (id !== 'main') throw new Error('Unknown agent'); return worker; },
    agentName: () => 'Bot', settings(values, id) { saved.push({ values, id }); Object.assign(worker.data.settings, values); },
    refresh: async () => {},
  });
  const service = new SettingsTools({ agents, controller: worker, wikiStore: { ensure: () => ({ root: '/wiki' }) } });
  service.host = { ask: async request => { prompts.push(request); return true; }, write: async (name, value) => saved.push({ name, value }), read: () => null };
  return { agents, worker, service, saved, prompts };
}

test('settings reads enumerate supported options without returning unrelated data or secrets', () => {
  const { service, worker } = setup();
  const result = service.read(worker, {});
  assert.equal(result.settings.effortCap.value, 'high');
  assert.equal(result.settings.providerKey.value[0].configured, true);
  assert.equal(result.settings.providerKey.value[0].baseUrl, undefined);
  assert.equal(result.settings.jevKey.value.configured, true);
  assert.equal(result.settings.about.writable, false);
  assert.ok(!JSON.stringify(result).includes('NEVER RETURN THIS'));
  assert.deepEqual(Object.keys(service.read(worker, { names: ['mode'] }).settings), ['mode']);
  assert.throws(() => service.read(worker, { names: ['privateCredential'] }), /Unknown setting/);
  assert.throws(() => service.read(worker, { path: '/arbitrary.json' }), /names and agentId/);
});

test('every approved settings write waits for idle and reports the actual applied result', async () => {
  const { service, worker, agents, saved, prompts } = setup();
  const receipt = await service.write(worker, { name: 'effortCap', value: 'medium' });
  assert.equal(prompts.length, 1);
  assert.equal(receipt.status, 'queued');
  await service.flush();
  assert.equal(saved.length, 0);
  agents.busy = false;
  worker.cleanupPending.add('child');
  await service.flush();
  assert.equal(saved.length, 0, 'cleanup must finish first');
  worker.cleanupPending.clear();
  await service.flush();
  assert.deepEqual(saved, [{ values: { effortCap: 'medium' }, id: 'main' }]);
  assert.equal(service.read(worker, { names: ['effortCap'] }).settings.effortCap.value, 'medium');
  assert.equal(service.snapshot()[0].status, 'applied');
  assert.equal(service.busy, false);
});

test('declining or missing user confirmation never writes a setting', async () => {
  const { service, worker, agents, saved } = setup();
  service.host.ask = async () => false;
  assert.equal((await service.write(worker, { name: 'effortCap', value: 'low' })).status, 'declined');
  delete service.host.ask;
  assert.equal((await service.write(worker, { name: 'effortCap', value: 'low' })).status, 'declined');
  agents.busy = false;
  await service.flush();
  assert.equal(saved.length, 0);
});

test('invalid settings cannot route to arbitrary files or methods', async () => {
  const { service, worker, prompts } = setup();
  for (const args of [{ name: '__proto__', value: {} }, { name: 'quitRunner', value: true },
    { name: 'effortCap', value: 'infinite' }, { name: 'mode', value: 'auto', path: '/file' }])
    await assert.rejects(service.write(worker, args));
  assert.equal(prompts.length, 0);
});

test('failed writes report failure instead of success and discard the submitted value', async () => {
  const { service, worker, agents } = setup();
  service.host.write = async () => { throw new Error('Disk full'); };
  await service.write(worker, { name: 'appearance', value: 'dark' });
  agents.busy = false;
  await service.flush();
  assert.equal(service.snapshot()[0].status, 'failed');
  assert.match(service.snapshot()[0].error, /Disk full/);
  assert.equal(service.requests[0].value, undefined);
});


test('security settings stay readable but cannot be changed even with confirmation available', async () => {
  const { service, worker, saved, prompts } = setup();
  for (const name of ['access', 'workspace', 'browserAccess', 'providers', 'providerConnection', 'providerKey', 'jevKey', 'checks', 'wikiFolder', 'startAtSignIn']) {
    assert.equal(service.read(worker, { names: [name] }).settings[name].writable, false, name);
    await assert.rejects(service.write(worker, { name, value: null }), /manual-only/);
  }
  assert.equal(prompts.length, 0);
  assert.equal(saved.length, 0);
});


test('a failed confirmation cannot leave a pending change blocking the runner forever', async () => {
  const { service, worker, saved } = setup();
  service.host.ask = async () => { throw new Error('Window unavailable'); };
  await assert.rejects(service.write(worker, { name: 'effortCap', value: 'medium' }), /Window unavailable/);
  assert.equal(service.busy, false);
  assert.equal(service.snapshot()[0].status, 'failed');
  assert.equal(service.requests[0].value, undefined);
  assert.equal(saved.length, 0);
});


test('Routing model changes method and model together while retaining the Jev fallback', async () => {
  const { service, worker, agents, saved } = setup();
  worker.data.settings.routerPreset = 'router';
  await service.write(worker, { name: 'routingModel', value: 'jev' });
  agents.busy = false;
  await service.flush();
  assert.equal(service.read(worker, { names: ['routingModel'] }).settings.routingModel.value, 'jev');
  assert.equal(worker.data.settings.routerPreset, 'router');
  await service.write(worker, { name: 'routingModel', value: 'router' });
  await service.flush();
  assert.deepEqual(saved[1].values, { routing: 'smart', routerPreset: 'router' });
  assert.equal(service.read(worker, { names: ['routingModel'] }).settings.routingModel.value, 'router');
});
