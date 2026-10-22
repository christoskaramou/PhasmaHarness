const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCipheriv, createDecipheriv, randomBytes, randomUUID } = require('node:crypto');
const { atomicWrite } = require('../src/session-store.cjs');
const { Connectors, validate } = require('../src/connectors.cjs');
const { serve } = require('./fixtures/connector-server.cjs');
const key = randomBytes(32);
const encryption = { isEncryptionAvailable: () => true,
  encryptString: text => { const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv); const data = Buffer.concat([cipher.update(text), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
  decryptString: data => { const decipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12)); decipher.setAuthTag(data.subarray(12, 28)); return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString(); } };
function setup(t, crypto = encryption, store = { version: 1, defaultsVersion: 1, connectors: [] }, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-connectors-'));
  if (store) atomicWrite(path.join(directory, 'connectors.json'), JSON.stringify(store));
  const manager = new Connectors(directory, crypto, options);
  t.after(async () => { await manager.close(); fs.rmSync(directory, { recursive: true, force: true }); }); return manager;
}
async function remote(t, options) { const server = await serve(options); t.after(() => server.close()); return server; }
const args = { text: 'shared' };
function controller(manager, access = 'read-only') {
  const session = { id: 'chat', access, workspace: manager.directory, activeProvider: 'codex', submission: {}, threadId: null };
  const context = { ...require('../src/controller/helpers.cjs'), ...require('../src/controller/connectors.cjs'),
    connectors: manager, session: () => session, busy: session.id, activeTurns: new Map([[session.id, 'turn-1']]), stopping: new Set(),
    assignmentCurrent: () => true, requests: new Map(), helperApprovals: new Map(), changed() {}, data: { settings: {} },
    toolHelpers: { pack: (_session, result) => result } };
  return { context, session };
}
async function waitFor(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail('Timed out waiting for connector action');
}
test('default documentation connectors persist once and respect later edits and removals', async t => {
  const manager = setup(t, encryption, null);
  assert.deepEqual(manager.records.map(record => [record.name, record.url]), [
    ['Context7', 'https://mcp.context7.com/mcp'],
    ['Microsoft Learn', 'https://learn.microsoft.com/api/mcp'],
    ['OpenAI Docs', 'https://developers.openai.com/mcp'],
  ]);
  assert.ok(manager.records.every(record => record.enabled && record.confirmCalls && record.auth === 'none'));
  assert.equal(manager.connections.size, 0, 'startup does not contact public services');
  const [context7, learn] = manager.records;
  await manager.save({ ...context7, name: 'My docs', url: 'https://example.com/docs', enabled: false, confirmCalls: false, auth: 'bearer', token: 'personal-test-key' });
  await manager.action(learn.id, 'remove');
  const before = fs.readFileSync(manager.file, 'utf8');
  const restored = new Connectors(manager.directory, encryption); t.after(() => restored.close());
  assert.deepEqual(restored.records, manager.records);
  assert.equal(restored.credentials.read(restored.record(context7.id)).token, 'personal-test-key');
  assert.equal(fs.readFileSync(manager.file, 'utf8'), before, 'restarts neither rewrite settings nor recreate removed defaults');
  assert.equal(JSON.parse(before).defaultsVersion, 1);
});

test('default connector upgrade preserves existing settings and credentials without duplicates', async t => {
  const manager = setup(t);
  const existing = [
    validate({ name: 'Editor', transport: 'stdio', command: 'editor-mcp', args: [], enabled: false }),
    validate({ name: 'Renamed library docs', transport: 'http', url: 'https://mcp.context7.com/mcp/', enabled: false, auth: 'bearer', confirmCalls: false }),
    validate({ name: 'microsoft learn', transport: 'http', url: 'https://example.com/custom-learn', enabled: false, auth: 'oauth', clientId: 'personal-client', confirmCalls: false }),
  ];
  manager.credentials.write(existing[1], { token: 'keep-this-secret' });
  const keyFiles = fs.readdirSync(manager.credentials.directory).map(name => [name, fs.readFileSync(path.join(manager.credentials.directory, name), 'hex')]);
  atomicWrite(manager.file, '\uFEFF' + JSON.stringify({ version: 1, connectors: existing }));
  const upgraded = new Connectors(manager.directory, encryption); t.after(() => upgraded.close());
  assert.deepEqual(upgraded.records.slice(0, existing.length), existing);
  assert.equal(upgraded.records.length, 4);
  assert.equal(upgraded.records.at(-1).name, 'OpenAI Docs');
  assert.equal(upgraded.credentials.read(existing[1]).token, 'keep-this-secret');
  assert.deepEqual(fs.readdirSync(manager.credentials.directory).map(name => [name, fs.readFileSync(path.join(manager.credentials.directory, name), 'hex')]), keyFiles);
  assert.equal(upgraded.connections.size, 0);
});

test('default connector upgrade keeps a full legacy store and rejects corrupt migration metadata', async t => {
  const existing = Array.from({ length: 50 }, (_, i) => validate({ name: 'Existing ' + i, transport: 'http', url: 'https://example.com/' + i, enabled: false }));
  const manager = setup(t, encryption, { version: 1, connectors: existing });
  assert.deepEqual(manager.records.slice(0, 50), existing);
  assert.equal(manager.records.length, 53);
  const restored = new Connectors(manager.directory, encryption); t.after(() => restored.close());
  assert.deepEqual(restored.records, manager.records);
  await assert.rejects(manager.save({ name: 'Too many', transport: 'http', url: 'https://example.com/extra' }), /at most/);
  for (const defaultsVersion of [-1, '1', null, 1.5]) {
    const invalid = JSON.stringify({ version: 1, defaultsVersion, connectors: existing });
    atomicWrite(manager.file, invalid);
    assert.throws(() => new Connectors(manager.directory, encryption), /Invalid connectors.json/);
    assert.equal(fs.readFileSync(manager.file, 'utf8'), invalid);
  }
});

test('default documentation connectors use the shared discovery and approval path for every backend', async t => {
  const server = await remote(t);
  const manager = setup(t, encryption, null, { fetcher: (_url, options) => fetch(server.url, options) });
  const { context, session } = controller(manager);
  for (const provider of ['codex', 'claude-cli', 'cursor-cli', 'native:deepseek', 'native:muse', 'native:antigravity', 'api-fixture']) {
    session.activeProvider = provider;
    const catalog = await context.bridgeTool(session.id, 'connector_tools', {});
    assert.equal(catalog.tools.length, 3, provider);
    for (const record of manager.records) {
      assert.ok(catalog.tools.some(tool => tool.id === record.id + '/echo'));
      const call = context.bridgeTool(session.id, 'connector_call', { id: record.id + '/echo', arguments: args });
      await waitFor(() => context.requests.size);
      assert.equal(context.requests.size, 1); context.helperApprovals.values().next().value(true);
      assert.equal(JSON.parse((await call).content[0].text).text, 'shared');
    }
  }
  assert.equal(server.state.calls.length, 21);
});

test('HTTP connector tools are shared, validated, persisted and disabled centrally', async t => {
  const server = await remote(t), manager = setup(t);
  const [saved] = await manager.save({ name: 'Fixture', transport: 'http', url: server.url });
  assert.equal(saved.state, 'connected'); const record = manager.record(saved.id);
  const catalog = await manager.discover({ query: 'echo' }); assert.equal(catalog.tools.length, 1);
  assert.equal(catalog.tools[0].id, record.id + '/echo');
  await assert.rejects(manager.call(record, 'echo', { text: 4 }, 'bot1', manager.directory), /input schema/);
  assert.equal(server.state.calls.length, 0);
  for (const owner of ['bot1', 'bot2']) assert.equal(JSON.parse((await manager.call(record, 'echo', args, owner, manager.directory)).content[0].text).text, 'shared');
  assert.equal(server.state.calls.length, 2);
  const restored = new Connectors(manager.directory, encryption); assert.equal(restored.snapshot()[0].id, record.id); await restored.close();
  await manager.action(record.id, 'disconnect'); await assert.rejects(manager.call(record, 'echo', args, 'bot1', manager.directory), /disabled|changed/);
  assert.equal((await manager.discover()).tools.length, 0);
});
test('bearer secrets stay encrypted and cannot follow a changed endpoint', async t => {
  const server = await remote(t, { bearer: 'private-fixture-token' }), manager = setup(t);
  const [saved] = await manager.save({ name: 'Private', transport: 'http', url: server.url, auth: 'bearer', token: 'private-fixture-token' });
  assert.equal(saved.state, 'connected'); assert.equal(saved.credentialsSaved, true);
  assert.doesNotMatch(JSON.stringify(saved), /private-fixture-token/);
  for (const name of fs.readdirSync(manager.credentials.directory)) assert.doesNotMatch(fs.readFileSync(path.join(manager.credentials.directory, name), 'utf8'), /private-fixture-token/);
  assert.doesNotMatch(fs.readFileSync(manager.file, 'utf8'), /private-fixture-token/);
  const second = await remote(t, { bearer: 'private-fixture-token' });
  const [changed] = await manager.save({ id: saved.id, name: saved.name, transport: 'http', url: second.url, auth: 'bearer' });
  assert.equal(changed.state, 'needs-sign-in'); assert.equal(changed.credentialsSaved, false);
  await manager.action(saved.id, 'forget-auth'); assert.equal(fs.readdirSync(manager.credentials.directory).length, 0);
});
test('unavailable key protection fails closed while unauthenticated connectors still work', async t => {
  const server = await remote(t), manager = setup(t, { isEncryptionAvailable: () => false });
  await assert.rejects(manager.save({ name: 'Secret', transport: 'http', url: server.url, token: 'secret' }), /key protection/);
  assert.equal(manager.snapshot().length, 0);
  assert.equal((await manager.save({ name: 'Public', transport: 'http', url: server.url }))[0].state, 'connected');
});
test('OAuth uses state and PKCE, persists tokens, refreshes, and forgets authorization', async t => {
  const server = await remote(t, { oauth: true }), manager = setup(t);
  const [saved] = await manager.save({ name: 'OAuth', transport: 'http', url: server.url, auth: 'oauth' });
  assert.equal(saved.state, 'needs-sign-in');
  const flow = await manager.action(saved.id, 'sign-in'); assert.ok(flow.url, JSON.stringify(flow));
  const authorization = await fetch(flow.url, { redirect: 'manual' }), callback = authorization.headers.get('location');
  const bad = new URL(callback); bad.searchParams.set('state', 'wrong'); assert.equal((await fetch(bad)).status, 400);
  const finish = await fetch(callback); assert.equal(finish.status, 200, await finish.text()); assert.equal(manager.snapshot()[0].state, 'connected');
  assert.equal(server.state.tokens, 1); assert.equal(server.state.registrations, 1);
  await manager.disconnect(saved.id);
  await manager.connect(saved.id); assert.equal(manager.snapshot()[0].state, 'connected');
  server.state.tokens++; // Force the resource server to reject the old access token.
  await manager.disconnect(saved.id); await manager.connect(saved.id);
  assert.equal(manager.snapshot()[0].state, 'connected'); assert.equal(server.state.tokens, 3);
  await manager.action(saved.id, 'forget-auth'); assert.equal(manager.snapshot()[0].credentialsSaved, false);
});
test('cancelled OAuth providers cannot resurrect forgotten credentials', async t => {
  const server = await remote(t, { oauth: true }), manager = setup(t);
  const [saved] = await manager.save({ name: 'OAuth', transport: 'http', url: server.url, auth: 'oauth' });
  await manager.action(saved.id, 'sign-in'); const provider = manager.auth.get(saved.id);
  await manager.action(saved.id, 'remove');
  assert.throws(() => provider.saveTokens({ access_token: 'late' }, { issuer: server.url }), /cancelled/);
  assert.equal(manager.snapshot().length, 0); assert.equal(fs.readdirSync(manager.credentials.directory).length, 0);
});
test('stopping one bot cancels only its connector call without retrying actions', async t => {
  const server = await remote(t), manager = setup(t);
  const [saved] = await manager.save({ name: 'HTTP', transport: 'http', url: server.url }); const record = manager.record(saved.id);
  const pending = manager.call(record, 'echo', { text: 'pending', delay: 1000 }, 'first', manager.directory);
  const rejected = assert.rejects(pending, /stopped|Connection/);
  await waitFor(() => server.state.calls.length);
  manager.cancelOwners(['first']); await rejected;
  assert.equal(JSON.parse((await manager.call(record, 'echo', args, 'second', manager.directory)).content[0].text).text, 'shared');
  assert.equal(server.state.calls.length, 2);
});
test('local MCP processes use isolated bot workspaces, minimal env and owned cleanup', { timeout: 30000 }, async t => {
  const manager = setup(t), workspace = path.join(manager.directory, 'workspace'); fs.mkdirSync(workspace);
  process.env.PHASMA_TEST_PRIVATE = 'must-not-inherit'; t.after(() => delete process.env.PHASMA_TEST_PRIVATE);
  const [saved] = await manager.save({ name: 'Local', transport: 'stdio', command: process.execPath, args: [path.join(__dirname, 'fixtures/connector-server.cjs')], env: { CONNECTOR_FIXTURE_SECRET: 'injected' } });
  assert.equal(saved.state, 'connected', JSON.stringify(saved)); const record = manager.record(saved.id), pids = [];
  for (const owner of ['one', 'two']) {
    const result = JSON.parse((await manager.call(record, 'echo', args, owner, workspace)).content[0].text);
    assert.equal(result.cwd, workspace); assert.equal(result.secret, 'injected'); assert.equal(result.inherited, null); pids.push(result.pid);
  }
  assert.notEqual(pids[0], pids[1]); await manager.action(saved.id, 'disconnect');
  // Linux may still expose an exited process until Node reaps it on a later event-loop turn.
  await waitFor(() => pids.every(pid => {
    try { process.kill(pid, 0); return false; }
    catch (error) { assert.equal(error.code, 'ESRCH'); return true; }
  }));
});
test('connector settings reject unsafe URLs, malformed fields and extra authority', () => {
  for (const url of ['http://example.com/mcp', 'https://user:password@example.com/mcp', 'file:///secret', 'https://example.com/#token']) assert.throws(() => validate({ name: 'Bad', transport: 'http', url }));
  assert.throws(() => validate({ name: 'Bad', transport: 'stdio', command: 'node', args: [], cwd: '../relative' }));
  assert.throws(() => validate({ name: 'Bad', transport: 'http', url: 'https://example.com', permission: 'admin' }));
});
test('every backend uses the same Harness approval; Full access also requires connector opt-in', async t => {
  const server = await remote(t), manager = setup(t);
  const [saved] = await manager.save({ name: 'Shared', transport: 'http', url: server.url });
  const { context, session } = controller(manager);
  for (const provider of ['codex', 'claude-cli', 'cursor-cli', 'native:deepseek', 'native:muse', 'native:antigravity', 'api-fixture']) {
    session.activeProvider = provider;
    const discovered = await context.bridgeTool(session.id, 'connector_tools', {}); assert.equal(discovered.tools.length, 1, provider);
    const promise = context.bridgeTool(session.id, 'connector_call', { id: saved.id + '/echo', arguments: args });
    await waitFor(() => context.requests.size);
    assert.equal(context.requests.size, 1, provider); context.helperApprovals.values().next().value(true);
    assert.equal(JSON.parse((await promise).content[0].text).text, 'shared'); assert.equal(context.requests.size, 0);
  }
  session.access = 'danger-full-access';
  const blocked = context.bridgeTool(session.id, 'connector_call', { id: saved.id + '/echo', arguments: args });
  await waitFor(() => context.requests.size);
  assert.equal(context.requests.size, 1); context.helperApprovals.values().next().value(false); await assert.rejects(blocked, /declined/);
  assert.equal(server.state.calls.length, 7);
  await manager.save({ id: saved.id, name: 'Shared', transport: 'http', url: server.url, confirmCalls: false });
  await context.bridgeTool(session.id, 'connector_call', { id: saved.id + '/echo', arguments: args }); assert.equal(context.requests.size, 0);
  session.access = 'workspace-write';
  const workspace = context.bridgeTool(session.id, 'connector_call', { id: saved.id + '/echo', arguments: args });
  await waitFor(() => context.requests.size);
  assert.equal(context.requests.size, 1); context.helperApprovals.values().next().value(false); await assert.rejects(workspace, /declined/);
});
test('old approvals cannot execute after turn replacement, access changes, settings edits or Stop', async t => {
  const server = await remote(t), manager = setup(t);
  const [saved] = await manager.save({ name: 'Shared', transport: 'http', url: server.url });
  for (const change of ['turn', 'access', 'settings', 'abort']) {
    const { context, session } = controller(manager), abort = new AbortController();
    const promise = context.bridgeTool(session.id, 'connector_call', { id: saved.id + '/echo', arguments: args }, abort.signal);
    await waitFor(() => context.requests.size);
    const fail = assert.rejects(promise, /changed|stopped/), approve = context.helperApprovals.values().next().value;
    if (change === 'turn') context.activeTurns.set(session.id, 'turn-2');
    if (change === 'access') session.access = 'workspace-write';
    if (change === 'settings') await manager.save({ id: saved.id, name: 'Edited', transport: 'http', url: server.url });
    if (change === 'abort') abort.abort();
    approve(true); await fail; assert.equal(context.requests.size, 0);
  }
  assert.equal(server.state.calls.length, 0);
});
test('API models discover and execute shared tools through the real API loop without Codex', async t => {
  const server = await remote(t), manager = setup(t), { ApiAgent } = require('../src/providers/api-agent.cjs');
  const [saved] = await manager.save({ name: 'Shared', transport: 'http', url: server.url, confirmCalls: false });
  const { context, session } = controller(manager, 'danger-full-access'); session.activeProvider = 'api-fixture';
  const requests = [];
  const providers = { local: { inspect: async () => ({ supported: false }) }, modelRequest: async (_choice, body) => {
    requests.push(structuredClone(body));
    const call = requests.length === 1 ? { name: 'connector_tools', arguments: '{}' } : { name: 'connector_call', arguments: JSON.stringify({ id: saved.id + '/echo', arguments: args }) };
    const chunk = requests.length < 3 ? { tool_calls: [{ index: 0, id: 'tool-' + requests.length, function: call }] } : { content: 'Finished.' };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: chunk }] })}\n\ndata: [DONE]\n\n`, { headers: { 'Content-Type': 'text/event-stream' } });
  } };
  const agent = new ApiAgent(providers, path.join(manager.directory, 'api'));
  const result = await agent.run({ provider: 'api-fixture', model: 'fixture', cwd: manager.directory, prompt: 'Echo shared.', access: session.access, signal: new AbortController().signal,
    onEvent() {}, approve: async () => { throw new Error('Approval must be handled by Harness'); },
    bridge: { tools: require('../src/connectors/tools.cjs').TOOLS, call: (name, value, signal) => context.bridgeTool(session.id, name, value, signal) } });
  assert.equal(result.result, 'Finished.'); assert.equal(server.state.calls.length, 1);
  assert.ok(requests[0].tools.some(tool => tool.function.name === 'connector_call'));
  assert.match(requests[2].messages.findLast(message => message.role === 'tool').content, /shared/);
});
test('the bundled MCP adapter preserves external MCP content instead of double encoding it', { timeout: 15000 }, async t => {
  const server = await remote(t), manager = setup(t);
  const [saved] = await manager.save({ name: 'Shared', transport: 'http', url: server.url, confirmCalls: false });
  const { context, session } = controller(manager, 'danger-full-access');
  const { RouterBridge } = require('../src/tools/router-bridge.cjs'), { Client } = require('@modelcontextprotocol/client');
  const { ConnectorStdio } = require('../src/connectors/transport.cjs');
  const bridge = new RouterBridge((...args) => context.bridgeTool(...args)); await bridge.start(); t.after(() => bridge.close());
  const config = bridge.childConfig(session.id), client = new Client({ name: 'test', version: '1' });
  const transport = new ConnectorStdio(config.command, config.args, manager.directory, config.env);
  try {
    await client.connect(transport);
    const catalog = await client.listTools(); assert.ok(catalog.tools.some(tool => tool.name === 'connector_tools'));
    const result = await client.callTool({ name: 'connector_call', arguments: { id: saved.id + '/echo', arguments: args } });
    assert.equal(JSON.parse(result.content[0].text).text, 'shared');
  } finally { await client.close(); await transport.close(); }
});
test('Stop cancels a bot while its MCP handshake is still pending', async t => {
  const server = await remote(t), manager = setup(t);
  const [saved] = await manager.save({ name: 'Shared', transport: 'http', url: server.url });
  server.state.delayInitialize = 5000;
  const pending = manager.call(manager.record(saved.id), 'echo', args, 'connecting-bot', manager.directory);
  const rejected = assert.rejects(pending, /Connection|stopped/);
  await waitFor(() => server.state.initializations === 2); manager.cancelOwners(['connecting-bot']); await rejected;
  assert.equal(server.state.calls.length, 0);
  assert.ok(!manager.connections.has(saved.id + ':connecting-bot'));
});
test('Disconnect waits for cleanup even when abort removed its connection from the registry', async t => {
  const manager = setup(t);
  const [saved] = await manager.save({ name: 'Inactive fixture', transport: 'http', url: 'http://127.0.0.1:1/mcp', enabled: false });
  let finish; const cleaning = new Promise(resolve => { finish = resolve; });
  const entry = { key: saved.id + ':bot', owner: 'bot', id: saved.id, abort: new AbortController(), client: { close: () => cleaning } };
  manager.connections.set(entry.key, entry);
  const operation = { id: saved.id, owner: 'bot', abort: new AbortController() };
  operation.abort.signal.addEventListener('abort', () => manager.closeEntry(entry)); manager.operations.add(operation);
  let settled = false; const stopping = manager.disconnectClients(saved.id).then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false);
  finish(); await stopping; manager.operations.delete(operation); assert.equal(settled, true);
});
test('Disconnect and shutdown wait for cleanup already started by Stop', async t => {
  for (const shutdown of [false, true]) {
    const manager = setup(t);
    const [saved] = await manager.save({ name: 'Stopped fixture', transport: 'http', url: 'http://127.0.0.1:1/mcp', enabled: false });
    let finish; const cleaning = new Promise(resolve => { finish = resolve; });
    const entry = { key: saved.id + ':bot', owner: 'bot', id: saved.id, abort: new AbortController(), client: { close: () => cleaning } };
    manager.connections.set(entry.key, entry);
    const operation = { id: saved.id, owner: 'bot', abort: new AbortController() };
    operation.abort.signal.addEventListener('abort', () => manager.closeEntry(entry)); manager.operations.add(operation);
    manager.cancelOwners(['bot']);
    assert.equal(manager.connections.size, 0, 'Stop removes the connection before its process exits');
    let settled = false;
    const stopping = (shutdown ? manager.close() : manager.disconnectClients(saved.id)).then(() => { settled = true; });
    try { await new Promise(resolve => setImmediate(resolve)); assert.equal(settled, false, shutdown ? 'shutdown waits' : 'Disconnect waits'); }
    finally { finish(); await stopping; manager.operations.delete(operation); }
  }
});

test('cancelled-result summaries cannot call connectors and restricted tasks cannot inherit Full access', async t => {
  const server = await remote(t), manager = setup(t);
  const [saved] = await manager.save({ name: 'Shared', transport: 'http', url: server.url, confirmCalls: false });
  const { context, session } = controller(manager, 'danger-full-access');
  session.agentReplyCancelledActive = true;
  await assert.rejects(context.bridgeTool(session.id, 'connector_call', { id: saved.id + '/echo', arguments: args }), /cancelled result/);
  assert.equal(context.requests.size, 0); assert.equal(server.state.calls.length, 0);
  session.agentReplyCancelledActive = false; session.activeTaskId = 'restricted'; session.tasks = [{ id: 'restricted', access: 'read-only' }];
  const pending = context.bridgeTool(session.id, 'connector_call', { id: saved.id + '/echo', arguments: args });
  await waitFor(() => context.requests.size);
  assert.equal(context.requests.size, 1); context.helperApprovals.values().next().value(false);
  await assert.rejects(pending, /declined/); assert.equal(server.state.calls.length, 0);
});

test('external connector additions load through Settings and bot discovery without restarting', async t => {
  const server = await remote(t), manager = setup(t), commands = new Map();
  require('../src/runner-commands.cjs').registerRunnerCommands((name, fn) => commands.set(name, fn), {
    runner: { controller: {}, agents: {}, connectors: manager },
  });
  const first = { id: randomUUID(), name: 'Editor', transport: 'http', url: server.url };
  atomicWrite(manager.file, JSON.stringify({ version: 1, connectors: [first] }));
  assert.equal((await commands.get('connectorList')())[0].state, 'connected');
  const existing = manager.record(first.id), connection = manager.connections.get(first.id + ':settings');
  const second = { ...first, id: randomUUID(), name: 'Second editor' };
  atomicWrite(manager.file, '\uFEFF' + JSON.stringify({ version: 1, connectors: [first, second] }, null, 2));
  assert.equal((await manager.discover()).total, 2);
  assert.equal(manager.record(first.id), existing, 'unchanged records preserve approvals and connections');
  assert.equal(manager.connections.get(first.id + ':settings'), connection);
  assert.equal(JSON.parse((await manager.call(manager.record(second.id), 'echo', args, 'bot', manager.directory)).content[0].text).text, 'shared');
  await manager.save({ name: 'Added in Settings', transport: 'http', url: server.url });
  assert.equal(JSON.parse(fs.readFileSync(manager.file, 'utf8')).connectors.length, 3, 'saving merges the externally loaded entries');
});

test('partial, invalid and missing connector files keep the last valid configuration and recover', async t => {
  const server = await remote(t), manager = setup(t);
  const [saved] = await manager.save({ name: 'Keep', transport: 'http', url: server.url });
  const good = fs.readFileSync(manager.file, 'utf8'), original = manager.record(saved.id);
  const record = JSON.parse(good).connectors[0];
  for (const invalid of ['{"private-token":"do-not-display', JSON.stringify({ version: 2, connectors: [] }),
    JSON.stringify({ version: 1, connectors: [record, record] }), JSON.stringify({ version: 1, connectors: [{ ...record, token: 'do-not-display' }] })]) {
    fs.writeFileSync(manager.file, invalid);
    await assert.rejects(manager.list(), error => /Invalid connectors.json/.test(error.message) && !error.message.includes('do-not-display'));
    await assert.rejects(manager.save({ name: 'Must not overwrite', transport: 'http', url: server.url }), /Invalid connectors.json/);
    assert.equal(fs.readFileSync(manager.file, 'utf8'), invalid);
    assert.equal(manager.record(saved.id), original);
  }
  fs.unlinkSync(manager.file);
  await assert.rejects(manager.list(), /missing/);
  assert.equal(manager.record(saved.id), original);
  atomicWrite(manager.file, good);
  assert.equal((await manager.list())[0].state, 'connected');
  atomicWrite(manager.file, JSON.stringify({ version: 1, connectors: [] }));
  assert.deepEqual(await manager.list(), []);
  assert.equal(manager.connections.size, 0);
});

test('external edits revoke old approvals and disabled connectors stop pending calls', async t => {
  const first = await remote(t), second = await remote(t), manager = setup(t);
  const [saved] = await manager.save({ name: 'Editor', transport: 'http', url: first.url });
  const { context, session } = controller(manager);
  const pending = context.bridgeTool(session.id, 'connector_call', { id: saved.id + '/echo', arguments: args });
  const rejected = assert.rejects(pending, /changed/);
  await waitFor(() => context.requests.size);
  const replacement = { ...manager.record(saved.id), url: second.url };
  atomicWrite(manager.file, JSON.stringify({ version: 1, connectors: [replacement] }));
  context.helperApprovals.values().next().value(true);
  await rejected;
  assert.equal(first.state.calls.length + second.state.calls.length, 0, 'old approval cannot reach either endpoint');
  const calling = manager.call(manager.record(saved.id), 'echo', { text: 'pending', delay: 1000 }, 'bot', manager.directory);
  const stopped = assert.rejects(calling, /stopped|changed/);
  await waitFor(() => second.state.calls.length);
  atomicWrite(manager.file, JSON.stringify({ version: 1, connectors: [{ ...replacement, enabled: false }] }));
  assert.equal((await manager.list())[0].state, 'disabled');
  await stopped;
  assert.equal(manager.connections.size, 0);
});

test('a Settings save cannot overwrite a file changed while connection cleanup awaited', async t => {
  const server = await remote(t), manager = setup(t);
  const [saved] = await manager.save({ name: 'Original', transport: 'http', url: server.url, auth: 'bearer', token: 'original-test-token' });
  const original = manager.record(saved.id), disconnect = manager.disconnect.bind(manager);
  let entered, release;
  const enteredCleanup = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  manager.disconnect = async id => { entered(); await gate; return disconnect(id); };
  const pending = manager.save({ ...original, name: 'Settings edit', token: 'must-not-replace-original' });
  const rejected = assert.rejects(pending, /changed while saving/);
  await enteredCleanup;
  const external = JSON.stringify({ version: 1, connectors: [{ ...original, name: 'External edit' }] });
  atomicWrite(manager.file, external); release(); await rejected;
  assert.equal(fs.readFileSync(manager.file, 'utf8'), external);
  assert.equal(manager.credentials.read(original).token, 'original-test-token', 'a rejected save must also preserve credentials');
  assert.equal((await manager.list())[0].name, 'External edit');
});

test('a failed settings write restores the previous encrypted credentials', async t => {
  const manager = setup(t);
  const [saved] = await manager.save({ name: 'Token', transport: 'http', url: 'https://example.com/mcp', auth: 'bearer', token: 'original-test-token', enabled: false });
  const record = manager.record(saved.id), before = fs.readFileSync(manager.file, 'utf8');
  const encrypted = fs.readFileSync(manager.credentials.file(record), 'utf8');
  manager.persist = () => { throw new Error('simulated store write failure'); };
  await assert.rejects(manager.save({ ...record, token: 'new-test-token' }), /simulated store write failure/);
  assert.equal(fs.readFileSync(manager.file, 'utf8'), before);
  assert.equal(fs.readFileSync(manager.credentials.file(record), 'utf8'), encrypted);
  await assert.rejects(manager.save({ name: 'New', transport: 'http', url: 'https://example.com/new', auth: 'bearer', token: 'new-test-token', enabled: false }), /simulated store write failure/);
  assert.equal(fs.readdirSync(manager.credentials.directory).length, 1, 'failed creation leaves no credential file');
});

test('a JSON edit during a slow handshake is checked again before executing a tool', async t => {
  const server = await remote(t), manager = setup(t);
  const [saved] = await manager.save({ name: 'Editor', transport: 'http', url: server.url });
  server.state.delayInitialize = 150;
  const pending = manager.call(manager.record(saved.id), 'echo', args, 'slow-bot', manager.directory);
  const rejected = assert.rejects(pending, /changed|stopped/);
  await waitFor(() => server.state.initializations === 2);
  atomicWrite(manager.file, JSON.stringify({ version: 1, connectors: [{ ...manager.record(saved.id), enabled: false }] }));
  await rejected;
  assert.equal(server.state.calls.length, 0);
});
