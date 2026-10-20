const test = require('node:test');
const assert = require('node:assert/strict');

const { museFixture: fixture } = require('./fixtures/native-cli.cjs');

const runOptions = () => ({ cwd: process.cwd(), model: 'model-a', access: 'read-only', prompt: 'Reply briefly.' });

test('Muse native discovery checks the pinned protocol without inference', async t => {
  const { backend, calls, children } = await fixture(t);
  assert.equal((await backend.refresh()).loggedIn, true);
  assert.equal(backend.status.version, '1.4.10');
  assert.deepEqual(backend.models[0].efforts, ['high']);
  assert.equal(backend.models[0].router, false);
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

test('Muse streams folded public items, ignores reasoning and does not invent usage', async t => {
  const { backend, children } = await fixture(t);
  const events = [];
  const result = await backend.run({ ...runOptions(), onEvent: event => events.push(event) });
  assert.equal(result.result, 'Hello world');
  assert.equal(result.session_id, 'session-1');
  assert.equal(Object.hasOwn(result, 'usage'), false);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_REASONING/);
  assert.ok(events.some(event => event.message?.content?.some(part => part.text === 'Hello')));
  assert.equal(children[0].child.exitCode, 0);
});

test('Muse resumes with the selected profile and session-bound MCP helpers', async t => {
  const { backend, calls } = await fixture(t);
  await backend.run({ ...runOptions(), resume: 'session-1', helpers: { serverName: 'phasma_harness', command: 'node', args: ['bridge.cjs'], env: { TOKEN: 'fixture' } } });
  const request = calls.find(([method]) => method === 'session/resume')[1];
  assert.equal(request.permissionProfile, ':read-only');
  assert.equal(request.config.mcpServers.phasma_harness.env.TOKEN, 'fixture');
  assert.equal(request.excludeItems, true);
  assert.ok(calls.find(([method]) => method === 'session/setModel'));
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
  assert.equal(backend.active, false);
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
  const mismatch = await fixture(t, { fingerprint: 'unknown-schema' });
  assert.match((await mismatch.backend.refresh()).error, /Unsupported Muse/);
  const signedOut = await fixture(t, { authError: true });
  assert.equal((await signedOut.backend.refresh()).loggedIn, false);
  await assert.rejects(signedOut.backend.run({ ...runOptions(), schema: {} }), /structured routing is not enabled/);
});
