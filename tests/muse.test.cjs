const test = require('node:test');
const assert = require('node:assert/strict');

const { museFixture: fixture } = require('./fixtures/native-cli.cjs');

const runOptions = () => ({ cwd: process.cwd(), model: 'model-a', access: 'read-only', prompt: 'Reply briefly.' });

test('Muse native discovery checks the pinned protocol without inference', async t => {
  const { backend, calls, children } = await fixture(t);
  assert.equal((await backend.refresh()).loggedIn, true);
  assert.equal(backend.status.version, '1.4.10');
  assert.deepEqual(backend.models[0].efforts, ['high']);
  assert.equal(backend.models[0].router, true);
  assert.equal(backend.models[0].images, true);
  assert.equal(calls.some(([method]) => method === 'turn/start'), false);
  assert.equal(children[0].child.exitCode, 0);
});

test('a Muse catalog served under a provider profile counts as signed in and selects models with that profile', async t => {
  // Live 2026-10-19: Muse listed every model under profile "tbh"; dropping profiled rows left zero models and a false sign-out.
  const { backend, calls } = await fixture(t, { catalogProfile: 'tbh' });
  assert.equal((await backend.refresh()).loggedIn, true);
  assert.equal(backend.models[0].profileId, 'tbh');
  await backend.run(runOptions());
  assert.deepEqual(calls.findLast(([method]) => method === 'session/setModel')[1].model, { providerId: 'meta', modelId: 'model-a', profileId: 'tbh' });
});

test('Muse status names the signed-in account, or API key for a stored key', async t => {
  const signedIn = await fixture(t, { account: { state: 'accountLogin', label: 'user@example.com', credentialRequired: true } });
  assert.equal((await signedIn.backend.refresh()).account, 'user@example.com');
  const keyed = await fixture(t, { account: { state: 'apiKey', credentialRequired: true } });
  assert.equal((await keyed.backend.refresh()).account, 'API key');
  const unknown = await fixture(t);
  assert.equal(Object.hasOwn(await unknown.backend.refresh(), 'account'), false, 'no account shown when Muse reports none');
});

test('Antigravity names the Google account the Gemini tools share', t => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { googleAccount } = require('../src/providers/antigravity.cjs');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-google-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  assert.equal(googleAccount(home), null, 'no file, no account');
  fs.mkdirSync(path.join(home, '.gemini'));
  fs.writeFileSync(path.join(home, '.gemini', 'google_accounts.json'), JSON.stringify({ active: 'user@example.com', old: [] }));
  assert.equal(googleAccount(home), 'user@example.com');
  fs.writeFileSync(path.join(home, '.gemini', 'google_accounts.json'), JSON.stringify({ active: 'not an address' }));
  assert.equal(googleAccount(home), null);
});

test('Muse sign-in opens only the Meta approval link it prints', async () => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const { MuseCLI } = require('../src/providers/muse.cjs');
  const launch = () => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, kill() {} });
    setImmediate(() => {
      child.stdout.write('Read https://evil.example/device first\n');
      child.stdout.write('Approve code ABCD-1234 at https://auth.meta.com/device?user_code=ABCD-1234\n');
      setImmediate(() => {
        child.exitCode = 0;
        child.emit('close', 0);
      });
    });
    return child;
  };
  const backend = new MuseCLI(launch, () => ({ command: 'muse', args: [] }));
  backend.refresh = async () => ({ loggedIn: true });
  const opened = [];
  assert.deepEqual(await backend.login(url => opened.push(url)), { loggedIn: true });
  assert.deepEqual(opened, ['https://auth.meta.com/device?user_code=ABCD-1234']);
});

test('Muse streams folded public items, ignores raw reasoning and keeps the host warm until closed', async t => {
  const { backend, children } = await fixture(t);
  const events = [];
  const result = await backend.run({ ...runOptions(), onEvent: event => events.push(event) });
  assert.equal(result.result, 'Hello world');
  assert.equal(result.session_id, 'session-1');
  assert.equal(Object.hasOwn(result, 'usage'), false);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_REASONING/);
  assert.ok(events.some(event => event.message?.content?.some(part => part.text === 'Hello')));
  assert.equal(children[0].child.exitCode, null, 'finished worker turn stays warm');
  assert.equal(backend.warmCount(), 1);
  await backend.close();
  assert.equal(children[0].child.exitCode, 0);
  assert.equal(backend.warmCount(), 0);
});

test('Muse projects native child lifecycle and only SDK-folded public summary parts', async t => {
  const events = [];
  const { backend } = await fixture(t, { onPrompt: () => {
    const [host] = backend.hosts;
    const emit = (method, params) => backend.notification(host, { method, params: { sessionId: host.session.sessionId, ...params } });
    const child = { itemId: 'job', turnId: 't', kind: 'subagent' };
    emit('item/started', { item: { ...child, revision: 1, role: 'Reviewer', objective: 'Read tests', subagentId: 'native-child', controlStatus: 'running' } });
    emit('item/completed', { item: { ...child, revision: 2, controlStatus: 'resultReady', result: { text: 'Checked', summary: 'Done', structuredData: { private: 'PRIVATE' } } } });
    const reason = { itemId: 'r', turnId: 't', kind: 'reasoning', status: 'inProgress', text: 'PRIVATE' };
    emit('item/started', { item: { ...reason, revision: 1, summary: ['First'] } });
    const delta = (field, delta, viewCursor) => emit('item/delta', { itemId: 'r', field, delta, viewCursor });
    delta('summary.0', ' part', 'c1');
    delta('summary.0', ' part', 'c1');
    delta('encryptedContent', 'PRIVATE', 'c2');
    emit('item/updated', { item: { ...reason, revision: 2, summary: ['First part'] } });
    delta('summary.1', 'Second', 'c3');
    emit('item/updated', { item: { ...reason, revision: 1, summary: ['stale'] } });
    emit('item/completed', { item: { ...reason, revision: 3, status: 'completed', summary: ['First part', 'Second'] } });
    return 'OK';
  } });
  await backend.run({ ...runOptions(), onEvent: e => events.push(e) });
  assert.deepEqual(events.filter(e => e.kind === 'agent'), [
    { type: 'info', id: 'job', kind: 'agent', title: 'Reviewer', text: 'native-child\n\nRead tests', status: 'running' },
    { type: 'info', id: 'job', kind: 'agent', title: 'Reviewer', text: 'native-child\n\nRead tests\n\nDone\n\nChecked', status: 'resultReady' },
  ]);
  assert.deepEqual(events.filter(e => e.kind === 'reasoning').map(e => [e.id, e.text, e.status]), [
    ['r', 'First', 'inProgress'], ['r', 'First part', 'inProgress'],
    ['r', 'First part\n\nSecond', 'inProgress'], ['r', 'First part\n\nSecond', 'completed'],
    ['private', '', 'completed'],
  ]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test('Muse SDK wire surfaces native progress, child provenance and commentary without exposing tool IO or private child bodies', async t => {
  const events = [];
  const { backend, children } = await fixture(t, { onPrompt: ({ params }) => {
    const send = (method, payload) => children[0].child.stdout.write(JSON.stringify({ jsonrpc: '2.0', method,
      params: { sessionId: params.sessionId, ...payload } }) + '\n');
    const item = (kind, itemId, fields) => send('item/updated', { item: { kind, itemId, turnId: params.commandId,
      revision: 1, status: 'inProgress', ...fields } });
    const delta = (field, text, cursor) => send('item/delta', { itemId: 'reason', field, delta: text, viewCursor: cursor });
    delta('summary.1', 'Second', 'before-start');
    item('reasoning', 'reason', { summary: ['First'], signature: 'PRIVATE' });
    delta('summary.1', 'Second', 'before-start');
    item('reasoning', 'reason', { revision: 2, summary: ['First', 'Final second'], status: 'completed' });
    delta('summary.1', 'LATE', 'after-done');
    item('reasoning', 'fallback', { summary: [], fallbackText: 'Reviewing options', text: 'PRIVATE' });
    item('reasoning', 'fallback', { revision: 2, summary: ['Checking the selected option'], truncated: true });
    item('reasoning', 'fallback', { revision: 3, status: 'completed', text: 'PRIVATE' });
    send('turn/modelRetryScheduled', { turnId: params.commandId, viewCursor: 'retry', attempt: 1, nextAttempt: 2,
      maxAttempts: 3, retryDelayMs: 1000, system: 'meta', httpStatus: 429, errorKind: 'rateLimit' });
    item('workflow', 'wf', { workflowRunId: 'run', phasePlan: [{ key: 'p', title: 'Audit' }], children: [
      { childId: 'unit', attempt: 1, label: 'Lint', status: 'running' }] });
    item('workflow', 'wf', { revision: 2, status: 'completed', finalSummary: 'Finished', children: [
      { childId: 'unit', attempt: 1, terminal: 'completed', durationMs: 10 }] });
    item('subagent', 'job', { subagentId: 'child', parentSubagentId: 'parent', workspacePlacement: 'isolated', objective: 'Check',
      result: { evidenceRefs: ['https://user:PRIVATE@example.test/check?token=PRIVATE'], artifactRefs: ['report.txt'] } });
    item('toolCall', 'tool', { tool: 'read', statusLine: 'Reading', statusProgress: { current: 1, total: 3, unit: 'files' } });
    item('monitorFeed', 'monitor', { monitorId: 'monitor-tool', monitorDescription: 'Build watcher', text: 'PRIVATE' });
    send('monitor/inboxItemAdmitted', { itemId: 'notice', taskId: 'watch', eventKind: 'line', body: 'PRIVATE' });
    send('monitor/inboxItemDrained', { itemId: 'notice', deliveryVisible: true });
    item('subagentInput', 'input', { subagentId: 'child', inputPhase: 'delivered', text: 'PRIVATE' });
    item('peerMessage', 'peer', { peerMessage: { senderLabel: 'Worker', body: 'PRIVATE' } });
    send('session/todoListChanged', { viewCursor: 'todos', items: [{ status: 'inProgress', text: 'Check API' }] });
    send('session/goalChanged', { viewCursor: 'goal', goal: { objective: 'Verify', currentWork: 'Testing', percentComplete: 51, status: 'active' } });
    item('agentMessage', 'comment', { text: 'Investigating.', messagePhase: 'commentary', status: 'completed' });
    item('agentMessage', 'comment', { revision: 2, status: 'completed' });
    item('agentMessage', 'late-phase', { text: 'Checking the other path.' });
    item('agentMessage', 'late-phase', { revision: 2, status: 'completed', messagePhase: 'commentary' });
    return 'Final.';
  } });
  const result = await backend.run({ ...runOptions(), onEvent: e => events.push(e) });
  assert.equal(result.result, 'Final.');
  assert.equal(events.find(e => e.message?.id === 'comment').message.phase, 'commentary');
  const phaseUpdates = events.filter(e => e.message?.id === 'late-phase').map(e => e.message);
  assert.deepEqual(phaseUpdates.map(m => [m.phase, m.content[0].text]), [
    [undefined, 'Checking the other path.'], ['commentary', 'Checking the other path.'],
  ]);
  const infos = events.filter(e => e.type === 'info');
  assert.doesNotMatch(JSON.stringify(infos), /PRIVATE|LATE/);
  const last = key => infos.findLast(e => e.id === key);
  assert.match(infos.find(e => e.title === 'Retry scheduled').text, /Reason: rateLimit\nSystem: meta\nHTTP status: 429/);
  assert.deepEqual(infos.filter(e => e.id === 'reason').map(e => e.text), ['First\n\nSecond', 'First\n\nFinal second']);
  assert.deepEqual(infos.filter(e => e.id === 'fallback').map(e => [e.text, e.status]), [
    ['Reviewing options', 'inProgress'],
    ['Checking the selected option\n\nProvider truncated this item', 'inProgress'],
    ['Checking the selected option\n\nProvider truncated this item', 'completed'],
  ]);
  assert.match(last('job').text, /Parent: parent/);
  assert.match(last('job').text, /Evidence: https:\/\/example.test\/check/);
  assert.match(last('activity:wf').text, /Plan: Audit[\s\S]*Summary: Finished/);
  const child = infos.filter(e => e.title === 'Workflow child');
  assert.equal(child.length, 2);
  assert.equal(child[0].id, child[1].id);
  assert.match(child[1].text, /Lint/);
  assert.equal(child[1].status, 'completed');
  assert.match(last('activity:monitor').text, /Build watcher/);
  assert.equal(last('monitor-inbox:notice').status, 'delivered');
  assert.match(last('activity:tool').text, /1\/3 · files/);
  assert.equal(last('activity:input').status, 'delivered');
  assert.match(last('activity:peer').text, /Worker/);
  assert.ok(infos.some(e => e.title === 'Plan' && e.text.includes('Check API')));
  assert.ok(infos.some(e => e.title === 'Goal' && e.text.includes('51%')));
});

test('Muse projects an Info item recovered only by the SDK gap-fill page, once', async t => {
  const events = [];
  const { backend } = await fixture(t, { onPrompt: async ({ params }) => {
    const [host] = backend.hosts;
    const request = host.rpc.request.bind(host.rpc);
    const recovered = { method: 'item/completed', params: { sessionId: params.sessionId, viewCursor: 'next',
      item: { kind: 'reasoning', itemId: 'gap-summary', turnId: params.commandId, revision: 3,
        status: 'completed', summary: ['Recovered public summary'], text: 'PRIVATE' } } };
    host.rpc.request = (method, args) => method === 'view/page' ? Promise.resolve({ events: [recovered], nextCursor: null }) : request(method, args);
    backend.notification(host, { method: 'view/gap', params: { sessionId: params.sessionId, after: 'before', next: 'next' } });
    await host.gapView;
    backend.notification(host, recovered); // late live twin of the served page
    return 'OK';
  } });
  await backend.run({ ...runOptions(), onEvent: e => events.push(e) });
  assert.deepEqual(events.filter(e => e.id === 'gap-summary').map(e => e.text), ['Recovered public summary']);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test('Muse resumes with the selected profile and session-bound MCP helpers', async t => {
  const { backend, calls } = await fixture(t);
  await backend.run({ ...runOptions(), resume: 'session-1', helpers: { serverName: 'phasma_harness', command: 'node', args: ['bridge.cjs'], env: { TOKEN: 'fixture' } } });
  const request = calls.find(([method]) => method === 'session/resume')[1];
  assert.equal(request.permissionProfile, ':read-only');
  assert.equal(request.config.mcpServers.phasma_harness.env.TOKEN, 'fixture');
  assert.equal(request.excludeItems, true);
  assert.ok(calls.find(([method]) => method === 'session/setModel'));
  const moved = await fixture(t, { resumedSessionId: 'session-2' });
  await assert.rejects(moved.backend.run({ ...runOptions(), resume: 'session-1' }), /different conversation/);
  assert.equal(moved.calls.some(([method]) => method === 'turn/start'), false, 'a worker that skips unchanged instructions never prompts another session');
});

test('Muse usage counts native prompt projections once and never adds raw cache counters twice', async t => {
  const tokenEvents = [
    { viewCursor: 'call-one', promptTokens: 45, usage: { inputTokens: 5, cacheReadTokens: 40, outputTokens: 7 } },
    { viewCursor: 'call-one', promptTokens: 45, usage: { inputTokens: 5, cacheReadTokens: 40, outputTokens: 7 } },
    { viewCursor: 'call-two', promptTokens: 10, usage: { inputTokens: 10, outputTokens: 3 } },
  ];
  const { backend } = await fixture(t, { tokenEvents, usage: { inputTokens: 999, cachedTokens: 999, outputTokens: 999 } });
  const result = await backend.run(runOptions());
  assert.deepEqual(result.usage, { input_tokens: 55, output_tokens: 10 });
  assert.equal(result.cacheUsageUnknown, true);
  const invalid = await fixture(t, { tokenEvents: [...tokenEvents,
    { viewCursor: 'invalid', promptTokens: 'unknown', usage: { outputTokens: 100 } }] });
  assert.equal(Object.hasOwn(await invalid.backend.run(runOptions()), 'usage'), false);
});

test('Muse refuses unconfirmed permissions and unsupported sandboxes before sending a prompt', async t => {
  const mismatch = await fixture(t, { profile: ':unrestricted' });
  await assert.rejects(mismatch.backend.run(runOptions()), /did not confirm/);
  assert.equal(mismatch.calls.some(([method]) => method === 'turn/start'), false);
  const noSandbox = await fixture(t, { sandbox: 'unavailable' });
  await assert.rejects(noSandbox.backend.run({ ...runOptions(), access: 'workspace-write' }), /cannot enforce workspace/);
  assert.equal(noSandbox.calls.some(([method]) => method === 'session/start'), false);
});

test('Muse approvals never accept a persistent grant or approve when the UI is unavailable', async t => {
  const { backend } = await fixture(t);
  const request = { toolName: 'shell', rawArgs: 'build', availableChoices: [
    { choiceId: 'forever', decision: 'approvedForSession', scope: 'session' },
    { choiceId: 'no', decision: 'denied', scope: 'once' },
    { choiceId: 'yes', decision: 'approved', scope: 'once' },
  ] };
  assert.deepEqual(await backend.permission({ context: { approve: async () => true } }, request), { choiceId: 'yes' });
  assert.deepEqual(await backend.permission({ context: { approve: async () => { throw new Error('Detached'); } } }, request), { choiceId: 'no' });
  assert.deepEqual(await backend.permission({ context: null }, request), { choiceId: 'no' });
});

test('Muse does not set ELECTRON_RUN_AS_NODE and survives a stdin write error mid-turn', async t => {
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_RUN_AS_NODE;
  t.after(() => { if (saved !== undefined) process.env.ELECTRON_RUN_AS_NODE = saved; });
  const { backend, calls, children } = await fixture(t, { wait: true });
  const running = backend.run(runOptions());
  for (let i = 0; i < 100 && !calls.some(([method]) => method === 'turn/start'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(Object.hasOwn(children[0].options.env, 'ELECTRON_RUN_AS_NODE'), false);
  children[0].child.stdin.emit('error', new Error('write EPIPE'));
  await assert.rejects(running, /disconnected/);
});

test('Muse cancellation cleans up and failures never become successful reports', async t => {
  const { backend, calls, children } = await fixture(t, { wait: true });
  const abort = new AbortController();
  const running = backend.run({ ...runOptions(), signal: abort.signal });
  for (let i = 0; i < 100 && !calls.some(([method]) => method === 'turn/start'); i++) await new Promise(resolve => setTimeout(resolve, 5));
  abort.abort();
  await assert.rejects(running, /stopped/);
  assert.equal(children[0].child.exitCode, 0);
  assert.equal(backend.active, null);
  const failed = await fixture(t, { terminal: 'failed' });
  await assert.rejects(failed.backend.run(runOptions()), /did not complete/);
  // Muse's own reason (here its live 402 billing reply) reaches the user instead of a generic failure.
  const billing = await fixture(t, { terminal: 'failed', turnError: 'API error 402: Billing verification failed. Please check your payment method. (billing_error)' });
  await assert.rejects(billing.backend.run(runOptions()), /^Error: Muse Code CLI could not complete this turn: API error 402: Billing verification failed/);
});

test('Muse takes Send now as a native steer into the running turn and a follow-up as its own queued turn', async t => {
  const wait = async (check) => { for (let i = 0; i < 200 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 5)); };
  for (const steer of [true, false]) {
    const { backend, calls } = await fixture(t, { live: true });
    let input = null;
    const running = backend.run({ ...runOptions(), onInput: fn => { if (fn) input = fn; } });
    await wait(() => input && calls.some(([method]) => method === 'turn/start'));
    await input({ id: 'next', text: 'Use the new requirement.', images: [] }, { steer });
    const result = await running;
    // The SDK may re-send a turn/start under the same commandId to check on it; count each command once.
    const starts = [...new Map(calls.filter(([method]) => method === 'turn/start').map(([, params]) => [params.commandId, params.ifBusy])).values()];
    assert.deepEqual(starts, ['queue', steer ? 'steer' : 'queue']);
    assert.equal(result.result, steer ? 'Steered answer' : 'Queued answer', 'the run waits for the turn that answers the follow-up');
    await assert.rejects(input({ id: 'after', text: 'Too late.', images: [] }, { steer }), /no longer accepting/);
  }
});

test('a queued Muse follow-up counts as delivered only when its turn runs; a failed run leaves it for review', async t => {
  const { backend, calls } = await fixture(t, { live: true, liveFailFirst: true });
  let input = null;
  const running = backend.run({ ...runOptions(), onInput: fn => { if (fn) input = fn; } });
  for (let i = 0; i < 200 && !(input && calls.some(([method]) => method === 'turn/start')); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const delivery = input({ id: 'next', text: 'Then do this.', images: [] }, { steer: false });
  delivery.catch(() => {});
  await assert.rejects(running, /could not complete this turn: Model unavailable/);
  await assert.rejects(delivery, /closed before the queued message ran/, 'acknowledged but never run: kept as uncertain, not delivered');
});

test('Muse incompatible schemas and missing authentication stay unavailable', async t => {
  // Muse updates itself ahead of the pinned SDK (1.4.13 against 1.4.12 on 2026-10-25): a newer fingerprint still connects.
  const newer = await fixture(t, { fingerprint: 'sha256:newer-build' });
  const connected = await newer.backend.refresh();
  assert.equal(connected.loggedIn, true);
  assert.equal(newer.backend.models.length, 1);
  const mismatch = await fixture(t, { schemaVersion: 2 });
  assert.match((await mismatch.backend.refresh()).error, /Unsupported Muse/);
  const opened = [];
  await assert.rejects(mismatch.backend.login(url => opened.push(url)), /Unsupported Muse/);
  assert.equal(opened.length, 0, 'an unsupported protocol does not open the Meta sign-in page');
  assert.ok(!mismatch.children.some(({ args }) => args.includes('login')), 'muse login is not started');
  const signedOut = await fixture(t, { authError: true });
  assert.equal((await signedOut.backend.refresh()).loggedIn, false);
});

// 2026-10-31, the user: no blocks nobody tested. Muse answers Hub and routing replies as DeepSeek and Cursor do: read-only,
// the schema in its prompt, and a reply that uses a tool is not accepted. Before, Harness refused before asking Muse.
test('Muse answers a Hub or routing reply read-only with the schema in its prompt, and a tool call rejects that reply', async t => {
  const json = '{"reply":"Yes","action":null}', schema = { type: 'object', properties: { reply: { type: 'string' } } };
  const { backend, calls } = await fixture(t, { onPrompt: async () => json });
  const { access, ...hubCall } = runOptions(); // a Hub or routing call passes no access
  assert.equal((await backend.run({ ...hubCall, schema })).result, json);
  assert.equal(calls.find(([method]) => method === 'session/start')[1].permissionProfile, ':read-only');
  assert.match(calls.find(([method]) => method === 'turn/start')[1].input[0].text, /Return only a JSON object matching this schema\. No tools are available\.\n\{"type":"object"/);
  const tooled = await fixture(t, { toolCall: true });
  await assert.rejects(tooled.backend.run({ ...hubCall, schema }), { code: 'INVALID_STRUCTURED_RESPONSE' });
  await tooled.backend.refresh();
  assert.equal(tooled.backend.models[0].router, true, 'Muse models can be the routing model too');
});

test('Muse returns the model catalog context limit as the context window', async t => {
  // Live 2026-11-04: model/list gave contextLimit 1007997 for every Muse model.
  const { backend } = await fixture(t, { contextLimit: 1007997 });
  await backend.refresh();
  assert.equal((await backend.run(runOptions())).contextWindow, 1007997);
  const undeclared = await fixture(t, { contextLimit: null });
  await undeclared.backend.refresh();
  assert.equal(Object.hasOwn(await undeclared.backend.run(runOptions()), 'contextWindow'), false, 'no window when the catalog declares none');
});

test('a resumed Muse worker turn reuses its warm host when launch settings match and skips redundant setup', async t => {
  const answers = ['First reply', 'Second reply', 'Third reply'];
  const { backend, calls, children } = await fixture(t, { onPrompt: async () => answers.shift() });
  const helpers = { serverName: 'phasma_harness', command: 'node', args: ['bridge.cjs'], env: { A: '1', B: '2' }, instructions: 'Turn 1' };
  const events1 = [];
  const first = await backend.run({ ...runOptions(), helpers, onEvent: event => events1.push(event) });
  assert.equal(first.result, 'First reply');
  assert.equal(children.length, 1);
  assert.equal(backend.warmCount(), 1);
  const callsAfterFirst = calls.length;

  // Same cwd/access/helpers (with reordered env keys, changed helpers.instructions and effort) + same model -> reuse & skip setModel.
  const events2 = [];
  const helpers2 = { serverName: 'phasma_harness', command: 'node', args: ['bridge.cjs'], env: { B: '2', A: '1' }, instructions: 'Turn 2' };
  const second = await backend.run({ ...runOptions(), resume: first.session_id, helpers: helpers2, effort: 'high', onEvent: event => events2.push(event) });
  assert.equal(second.result, 'Second reply');
  assert.equal(children.length, 1, 'no second process spawned');
  assert.equal(backend.warmCount(), 1);
  const secondCalls = calls.slice(callsAfterFirst).map(([method]) => method);
  assert.deepEqual(secondCalls, ['turn/start'], 'skips initialize, permissionProfile/list, session/resume and unchanged session/setModel');
  assert.ok(events2.some(event => event.message?.content?.some(part => part.text === 'Second reply')), 'streams Turn 2 items cleanly');

  // Even when a fixture reuses itemId "answer" across turns, clearing host.reported lets Turn 2 stream to onEvent.
  const plain = await fixture(t);
  const plainEvents1 = [], plainEvents2 = [];
  const r1 = await plain.backend.run({ ...runOptions(), onEvent: e => plainEvents1.push(e) });
  await plain.backend.run({ ...runOptions(), resume: r1.session_id, onEvent: e => plainEvents2.push(e) });
  assert.equal(plain.children.length, 1);
  assert.ok(plainEvents2.some(e => e.message?.content?.some(part => part.text === 'Hello world')));
});

test('changing Muse model reuses the warm host with session/setModel; changing cwd, access or helpers respawns', async t => {
  const { backend, calls, children } = await fixture(t, { onPrompt: async ({ params }) => `ok:${params.input[0].text}` });
  const helpers = { serverName: 'phasma_harness', command: 'node', args: ['bridge.cjs'], env: { TOKEN: 'one' } };
  const { session_id: id } = await backend.run({ ...runOptions(), helpers });
  assert.equal(children.length, 1);

  // Model change reuses the same process and sends session/setModel.
  const beforeModel = calls.length;
  await backend.run({ ...runOptions(), resume: id, model: 'model-b', helpers });
  assert.equal(children.length, 1);
  assert.deepEqual(calls.slice(beforeModel).map(([m]) => m), ['session/setModel', 'turn/start']);

  // Changing access closes the warm process and spawns a fresh one with session/resume.
  await backend.run({ ...runOptions(), resume: id, model: 'model-b', access: 'danger-full-access', helpers });
  assert.equal(children.length, 2);
  assert.equal(children[0].child.exitCode, 0);
  assert.equal(calls.filter(([m]) => m === 'session/resume').length, 1);

  // Changing helpers closes the warm process and spawns a fresh one.
  await backend.run({ ...runOptions(), resume: id, model: 'model-b', access: 'danger-full-access',
    helpers: { ...helpers, env: { TOKEN: 'two' } } });
  assert.equal(children.length, 3);
  assert.equal(children[1].child.exitCode, 0);

  // Changing cwd closes the warm process and spawns a fresh one.
  await backend.run({ ...runOptions(), cwd: require('node:os').tmpdir(), resume: id, model: 'model-b', access: 'danger-full-access',
    helpers: { ...helpers, env: { TOKEN: 'two' } } });
  assert.equal(children.length, 4);
  assert.equal(children[2].child.exitCode, 0);
});

test('failed, aborted and schema Muse turns are never parked', async t => {
  const failed = await fixture(t, { terminal: 'failed' });
  await assert.rejects(failed.backend.run(runOptions()), /did not complete/);
  assert.equal(failed.backend.warmCount(), 0);
  assert.equal(failed.children[0].child.exitCode, 0);

  const aborted = await fixture(t, { wait: true });
  const controller = new AbortController();
  const running = aborted.backend.run({ ...runOptions(), signal: controller.signal });
  for (let i = 0; i < 100 && !aborted.calls.some(([m]) => m === 'turn/start'); i++) await new Promise(r => setTimeout(r, 5));
  controller.abort();
  await assert.rejects(running, /stopped/);
  assert.equal(aborted.backend.warmCount(), 0);
  assert.equal(aborted.children[0].child.exitCode, 0);

  const oneOff = await fixture(t, { onPrompt: async () => '{"ok":true}' });
  const { access: _, ...hubCall } = runOptions();
  await oneOff.backend.run({ ...hubCall, schema: { type: 'object' } });
  assert.equal(oneOff.backend.warmCount(), 0);
  assert.equal(oneOff.children[0].child.exitCode, 0);
});

test('a parked Muse host ignores late notifications, denies late approvals and recovers if it dies while parked', async t => {
  const { backend, children } = await fixture(t, { onPrompt: async () => 'Turn 1' });
  const events = [];
  const { session_id: id } = await backend.run({ ...runOptions(), approve: async () => true, onEvent: e => events.push(e) });
  const seen = events.length;
  const [host] = [...backend.hosts];
  assert.equal(host.context, null);

  // Late item notification while parked must not reach the finished turn's onEvent.
  backend.notification(host, { method: 'item/completed', params: { sessionId: id,
    item: { itemId: 'late-1', turnId: 't-late', kind: 'agentMessage', revision: 1, status: 'completed', text: 'late text' } } });
  assert.equal(events.length, seen);

  // Late approval while parked must reject safely without invoking approve().
  const choice = await backend.permission(host, { toolName: 'shell', rawArgs: 'rm', availableChoices: [
    { choiceId: 'allow', decision: 'approved', scope: 'once' },
    { choiceId: 'deny', decision: 'denied', scope: 'once' },
  ] });
  assert.deepEqual(choice, { choiceId: 'deny' });

  // Simulate parked host dying before next resumed turn -> dropped cleanly and replaced transparently.
  children[0].child.kill();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(backend.warmCount(), 0);
  const recovered = await backend.run({ ...runOptions(), resume: id });
  assert.equal(recovered.result, 'Turn 1');
  assert.equal(children.length, 2);
  assert.equal(backend.warmCount(), 1);
});

test('at most three Muse processes stay warm across bots, expire after 10 idle minutes and close per owner', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { EXPECTED_SCHEMA_FINGERPRINT } = await import('@muse-code/sdk');
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const { MuseCLI } = require('../src/providers/muse.cjs');
  // Use distinct session IDs across turns so each run parks its own session in WARM.
  let counter = 0;
  const makeUnique = () => {
    const base = { calls: [], children: [] };
    const launch = (cmd, args, opts) => {
      const sid = `sess-${++counter}`;
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.exitCode = null; child.signalCode = null;
      child.kill = () => { if (child.exitCode === null) { child.exitCode = 0; child.stdin.end(); child.stdout.end(); child.stderr.end(); child.emit('exit', 0); child.emit('close', 0); } };
      base.children.push({ child, args, opts });
      let buf = '';
      const send = m => child.stdout.write(JSON.stringify(m) + '\n');
      child.stdin.on('data', chunk => {
        buf += chunk;
        for (let nl; (nl = buf.indexOf('\n')) >= 0;) {
          const req = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
          base.calls.push([req.method, req.params]);
          if (req.id === undefined) continue;
          let res = {};
          if (req.method === 'initialize') res = { schema: { version: 1, fingerprint: EXPECTED_SCHEMA_FINGERPRINT }, serverInfo: { name: 'muse', version: '1.4.10' }, experimentalApi: true, grantedCapabilities: ['sessionMcp'], sessionDurability: 'durable', sandboxAvailability: 'available' };
          if (req.method === 'permissionProfile/list') res = { profiles: [{ profileId: ':read-only', available: true }] };
          if (req.method === 'session/start' || req.method === 'session/resume') res = { session: { sessionId: sid, activeTurnId: null, permissionState: { profileId: ':read-only', reviewerAuthority: 'human' } }, viewCursor: 'c' };
          if (req.method === 'turn/start') {
            const turnId = req.params.commandId;
            res = { commandId: turnId, disposition: 'started', startedNewTurn: true, status: 'accepted', turnId };
            send({ jsonrpc: '2.0', id: req.id, result: res });
            send({ jsonrpc: '2.0', method: 'turn/started', params: { sessionId: sid, viewCursor: 'c', turnId } });
            send({ jsonrpc: '2.0', method: 'item/completed', params: { sessionId: sid, viewCursor: 'c', item: { itemId: `ans-${turnId}`, turnId, kind: 'agentMessage', revision: 1, status: 'completed', text: 'ok' } } });
            send({ jsonrpc: '2.0', method: 'turn/completed', params: { sessionId: sid, viewCursor: 'c', turnId, terminal: 'completed' } });
            continue;
          }
          send({ jsonrpc: '2.0', id: req.id, result: res });
        }
      });
      return child;
    };
    const backend = new MuseCLI(launch, () => ({ command: 'muse', args: [] }));
    t.after(() => backend.close());
    return { backend, ...base };
  };
  const botA = makeUnique(), botB = makeUnique();
  await botA.backend.run(runOptions());
  await botA.backend.run(runOptions());
  await botB.backend.run(runOptions());
  await botB.backend.run(runOptions());
  assert.equal(botA.backend.warmCount() + botB.backend.warmCount(), 3, 'global warm cap of 3');
  assert.equal(botA.children[0].child.exitCode, 0, 'oldest warm host evicted and closed');
  await botA.backend.close();
  assert.equal(botA.backend.warmCount(), 0);
  assert.equal(botB.backend.warmCount(), 2, 'closing botA leaves botB warm');
  t.mock.timers.tick(10 * 60 * 1000);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(botB.backend.warmCount(), 0, 'idle timer expires after 10 minutes');
  assert.ok([...botA.children, ...botB.children].every(c => c.child.exitCode === 0));
});
