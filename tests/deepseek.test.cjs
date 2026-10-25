const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Readable, Writable } = require('node:stream');

const { DeepSeekCLI } = require('../src/providers/deepseek.cjs');
const { findNativeCLI, NATIVE_CLI_INFO } = require('../src/providers/native-cli.cjs');
const { installer } = require('../src/providers/install.cjs');
const { capabilities } = require('../src/providers/capabilities.cjs');

const FLASH = '["deepseek-official","deepseek-v4-flash"]';
const CATALOG_FLASH = '["deepseek-official","deepseek-flash"]';
const PRO = '["deepseek-official","deepseek-v4-pro"]';
// Live dsh 0.2.1-rc.2 lists its acp default first, then its named catalog.
const configOptions = current => [
  { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: current,
    options: [{ group: 'deepseek-official', name: 'DeepSeek', options: [{ value: FLASH, name: 'deepseek-v4-flash' },
      { value: CATALOG_FLASH, name: 'DeepSeek-V4.1-Flash' }, { value: PRO, name: 'DeepSeek-V4-Pro' }] }] },
  { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'high',
    options: [{ value: 'low', name: 'Low' }, { value: 'high', name: 'High' }] },
];

// A fake `dsh --profile acp` peer. Like the real one it sends only the call id with a permission request.
async function fixture(t, options = {}) {
  const { AgentSideConnection, ndJsonStream } = await import('@agentclientprotocol/sdk');
  const calls = [], children = [];
  const launch = (_command, args, spawnOptions) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.exitCode = null; child.signalCode = null;
    child.kill = () => {
      if (child.exitCode !== null) return;
      child.exitCode = 0; child.stdin.end(); child.stdout.end(); child.stderr.end();
      child.emit('exit', 0); child.emit('close', 0);
    };
    children.push({ child, args, options: spawnOptions });
    const stream = ndJsonStream(Writable.toWeb(child.stdout), Readable.toWeb(child.stdin));
    let helpers, cancelPending, cancelled = false, seeCancel;
    const cancelSeen = new Promise(resolve => { seeCancel = resolve; });
    const rpc = new AgentSideConnection(connection => ({
      async initialize(params) {
        calls.push(['initialize', params]);
        return { protocolVersion: options.protocol || 1, agentInfo: { name: 'deepseek-harness-acp', version: '0.0.1' },
          agentCapabilities: { sessionCapabilities: { close: {}, list: {}, ...(options.resume === false ? {} : { resume: {} }) },
            promptCapabilities: { image: options.images === true } }, authMethods: [] };
      },
      async newSession(params) {
        calls.push(['newSession', params]);
        helpers = params.mcpServers?.find(server => server.name === 'phasma_harness');
        return { sessionId: 'session-1', configOptions: configOptions(FLASH) };
      },
      async resumeSession(params) {
        calls.push(['resumeSession', params]);
        helpers = params.mcpServers?.find(server => server.name === 'phasma_harness');
        return { ...(options.resumedSessionId ? { sessionId: options.resumedSessionId } : {}), configOptions: configOptions(FLASH) };
      },
      async setSessionConfigOption(params) { calls.push(['config', params]); return { configOptions: configOptions(params.value) }; },
      async prompt(params) {
        calls.push(['prompt', params]);
        const update = (sessionId, body) => connection.sessionUpdate({ sessionId, update: body });
        if (options.permission) {
          await update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'tool-1', title: 'bash', kind: 'other', status: 'in_progress',
            ...(options.noRawInput ? {} : { rawInput: { command: 'build' } }) });
          const asked = connection.requestPermission({ sessionId: params.sessionId, toolCall: { toolCallId: 'tool-1' },
            options: [{ optionId: 'allow-once', kind: 'allow_once', name: 'Allow once' }, { optionId: 'reject-once', kind: 'reject_once', name: 'Reject' }] })
            .then(permission => { calls.push(['permission', permission]); });
          // Like dsh, a cancel ends the first prompt at once, even while its approval is still open.
          if (options.cancelFirst && methodCalls(calls, 'prompt').length === 1) await Promise.race([asked, cancelSeen]);
          else await asked;
        }
        if (options.wait) return new Promise(() => {});
        // Like dsh, a prompt cancelled while it waited (here on an approval) ends as cancelled.
        if (options.cancelFirst && methodCalls(calls, 'prompt').length === 1) {
          if (cancelled) return { stopReason: 'cancelled' };
          return new Promise(resolve => { cancelPending = () => resolve({ stopReason: 'cancelled' }); });
        }
        if (options.noise) {
          await update('foreign-session', { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'FOREIGN' } });
          await update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'image', mimeType: 'image/png', data: 'aGk=' } });
          await update(params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'unknown', status: 'in_progress' });
          await update(params.sessionId, { sessionUpdate: 'usage_update', used: 1, size: 2 });
        }
        const answer = await options.onPrompt?.({ params, helpers });
        await update(params.sessionId, { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'PRIVATE_REASONING' } });
        await update(params.sessionId, { sessionUpdate: 'usage_update', used: 10, size: 100 });
        await update(params.sessionId, { sessionUpdate: 'tool_call', toolCallId: 'tool-2', title: 'read_file', kind: 'other', status: 'in_progress', rawInput: { path: 'a' } });
        await update(params.sessionId, { sessionUpdate: 'tool_call_update', toolCallId: 'tool-2', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'ok' } }] });
        for (const text of answer === undefined ? options.text || ['Hello ', 'world'] : [answer]) {
          await update(params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
        }
        return { stopReason: options.stopReason || 'end_turn' };
      },
      async cancel(params) { calls.push(['cancel', params]); cancelled = true; cancelPending?.(); seeCancel(); },
    }), stream);
    rpc.closed.catch(() => {});
    return child;
  };
  const backend = new DeepSeekCLI(launch, options.find || (() => ({ command: 'dsh-fixture', args: [] })));
  t.after(() => backend.close());
  return { backend, calls, children };
}

const runOptions = () => ({ cwd: process.cwd(), model: FLASH, access: 'read-only', prompt: 'Reply briefly.' });
const methodCalls = (calls, name) => calls.filter(([method]) => method === name);

test('DeepSeek is registered, installable and reports Send now by cancel and re-prompt, no compact or usage', () => {
  assert.deepEqual(NATIVE_CLI_INFO['native:deepseek'], { label: 'DeepSeek Harness CLI', setting: 'deepseekEnabled', slug: 'deepseek-cli' });
  assert.match(installer('native:deepseek').command, /npm install --global @deepseek-ai\/dsh@latest$/);
  assert.deepEqual({ ...capabilities('native:deepseek') }, { cli: true, steer: false, compact: false, usage: false, liveSteer: true });
});

test('DeepSeek is found as the npm package script, and a missing executable reads as not installed', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-deepseek-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { PATH: root, LOCALAPPDATA: root, USERPROFILE: root, APPDATA: root };
  assert.throws(() => findNativeCLI('deepseek-cli', env, 'win32'), { code: 'ENOENT' });
  const lib = path.join(root, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  fs.writeFileSync(path.join(lib, 'bin.js'), 'fixture');
  fs.writeFileSync(path.join(lib, '..', 'package.json'), JSON.stringify({ version: '9.9.9' }));
  const found = findNativeCLI('deepseek-cli', env, 'win32');
  assert.deepEqual(found, { command: process.execPath, args: [path.join(lib, 'bin.js')] });
  const { backend } = await fixture(t, { find: () => found });
  assert.equal((await backend.refresh()).version, '9.9.9');

  const missing = await fixture(t, { find: () => findNativeCLI('deepseek-cli', { PATH: root, LOCALAPPDATA: root, USERPROFILE: path.join(root, 'none'), APPDATA: path.join(root, 'none') }, 'win32') });
  assert.equal(missing.backend.inspect().installed, false);
  const status = await missing.backend.refresh();
  assert.equal(status.installed, false);
  assert.equal(status.loggedIn, false);
  assert.match(status.error, /dsh is not installed/);
  assert.equal(missing.children.length, 0);
});

test('DeepSeek discovers models without inference and closes the probe process', async t => {
  const { backend, calls, children } = await fixture(t);
  const status = await backend.refresh();
  assert.equal(status.loggedIn, true);
  assert.equal(status.account, 'API key', 'dsh runs on an API key, so the row names that instead of a user');
  // Every model dsh reports is listed under dsh's own name, like the other CLI providers; none is hidden or renamed.
  assert.deepEqual(backend.models.map(model => [model.id, model.model, model.label]), [
    [`native:deepseek:${FLASH}`, FLASH, 'deepseek-v4-flash'], [`native:deepseek:${CATALOG_FLASH}`, CATALOG_FLASH, 'DeepSeek-V4.1-Flash'],
    [`native:deepseek:${PRO}`, PRO, 'DeepSeek-V4-Pro']]);
  assert.equal(methodCalls(calls, 'prompt').length, 0);
  assert.deepEqual(children[0].args.slice(-2), ['--profile', 'acp']);
  assert.equal(children[0].options.env.DSH_PERMISSION_MODE, 'read-only');
  assert.equal(children[0].child.exitCode, 0);
  assert.equal(backend.hosts.size, 0);
});

test('DeepSeek refuses an incompatible protocol', async t => {
  const { backend } = await fixture(t, { protocol: 99 });
  const status = await backend.refresh();
  assert.equal(status.loggedIn, false);
  assert.match(status.error, /Unsupported DeepSeek/);
  assert.equal(backend.hosts.size, 0);
});

test('DeepSeek streams public text and tools, hides thoughts, keeps a warm session and reports no usage', async t => {
  const { backend, calls } = await fixture(t);
  const events = [];
  const result = await backend.run({ ...runOptions(), onEvent: event => events.push(event) });
  assert.equal(result.result, 'Hello world');
  assert.equal(Object.hasOwn(result, 'usage'), false);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_REASONING/);
  assert.equal(events.find(event => event.type === 'assistant').message.content[0].name, 'read_file');
  assert.equal(events.find(event => event.type === 'user').message.content[0].is_error, false);
  await backend.run({ ...runOptions(), resume: result.session_id });
  assert.equal(methodCalls(calls, 'initialize').length, 1);
  assert.equal(methodCalls(calls, 'newSession').length, 1);
  assert.equal(methodCalls(calls, 'resumeSession').length, 0);
  assert.equal(methodCalls(calls, 'config').length, 0);
});

test('DeepSeek resumes an explicit session with helpers and selects only an advertised model', async t => {
  const { backend, calls } = await fixture(t);
  await backend.run({ ...runOptions(), model: PRO, resume: 'saved-session',
    helpers: { serverName: 'phasma_harness', command: 'node', args: ['bridge.cjs'], env: { TOKEN: 'fixture' } } });
  const request = methodCalls(calls, 'resumeSession')[0][1];
  assert.equal(request.sessionId, 'saved-session');
  assert.deepEqual(request.mcpServers[0].env, [{ name: 'TOKEN', value: 'fixture' }]);
  assert.deepEqual(methodCalls(calls, 'config')[0][1], { sessionId: 'saved-session', configId: 'model', value: PRO });
  await assert.rejects(backend.run({ ...runOptions(), model: 'not-a-model', resume: 'saved-session' }), /requested DeepSeek model is unavailable/);
  assert.equal(backend.hosts.size, 0, 'a failed turn closes its host');

  const moved = await fixture(t, { resumedSessionId: 'other-session' });
  await assert.rejects(moved.backend.run({ ...runOptions(), resume: 'saved-session' }), /different conversation/);
  assert.equal(methodCalls(moved.calls, 'prompt').length, 0, 'a worker that skips unchanged instructions never prompts another session');

  const unavailable = await fixture(t, { resume: false });
  await assert.rejects(unavailable.backend.run({ ...runOptions(), resume: 'saved' }), /cannot resume/);
  assert.equal(methodCalls(unavailable.calls, 'newSession').length, 0);
});

test('DeepSeek maps each access level to the launch permission mode and replaces the host when it changes', async t => {
  const { backend, children } = await fixture(t);
  for (const access of ['read-only', 'workspace-write', 'danger-full-access', 'something-else']) await backend.run({ ...runOptions(), access });
  assert.deepEqual(children.map(entry => entry.options.env.DSH_PERMISSION_MODE), ['read-only', 'workspace-write', 'danger-full-access', 'read-only']);
  assert.deepEqual(children.map(entry => entry.child.exitCode), [0, 0, 0, null], 'only the current host is still running');
  await backend.run({ ...runOptions(), access: 'something-else' });
  assert.equal(children.length, 4, 'the same access reuses its host');
});

test('DeepSeek approvals use the tool the call announced and select only the one-time choice', async t => {
  const { backend, calls } = await fixture(t, { permission: true });
  let tool;
  await backend.run({ ...runOptions(), approve: async request => { tool = request; return true; } });
  assert.equal(tool.toolName, 'bash');
  assert.deepEqual(tool.input, { command: 'build' });
  assert.deepEqual(methodCalls(calls, 'permission')[0][1], { outcome: { outcome: 'selected', optionId: 'allow-once' } });
  await backend.run({ ...runOptions(), approve: async () => false });
  assert.deepEqual(methodCalls(calls, 'permission').at(-1)[1], { outcome: { outcome: 'cancelled' } });
  await backend.run(runOptions());
  assert.deepEqual(methodCalls(calls, 'permission').at(-1)[1], { outcome: { outcome: 'cancelled' } });
  await backend.run({ ...runOptions(), approve: async () => { throw new Error('UI detached'); } });
  assert.deepEqual(methodCalls(calls, 'permission').at(-1)[1], { outcome: { outcome: 'cancelled' } });
});

test('DeepSeek permission requests without concrete input are never remembered for the session', async t => {
  const { sessionAllowKey } = require('../src/controller/shared.cjs');
  const { backend } = await fixture(t, { permission: true, noRawInput: true });
  let tool;
  await backend.run({ ...runOptions(), approve: async request => { tool = request; return true; } });
  assert.equal(sessionAllowKey(tool), null);
  const known = await fixture(t, { permission: true });
  await known.backend.run({ ...runOptions(), approve: async request => { tool = request; return true; } });
  assert.notEqual(sessionAllowKey(tool), null);
});

test('DeepSeek structured calls use a private read-only host, enforce the local schema and never approve', async t => {
  const { backend, calls, children } = await fixture(t, { permission: true, text: ['{"label":"ready"}'] });
  const schema = { type: 'object', properties: { label: { type: 'string', pattern: '^ready$' } }, required: ['label'], additionalProperties: false };
  const result = await backend.run({ ...runOptions(), access: 'danger-full-access', helpers: { serverName: 'phasma_harness', command: 'node', args: [], env: {} },
    schema, approve: async () => { throw new Error('Must not ask'); } });
  assert.deepEqual(result.structured_output, { label: 'ready' });
  assert.deepEqual(methodCalls(calls, 'newSession')[0][1].mcpServers, []);
  assert.equal(children[0].options.env.DSH_PERMISSION_MODE, 'read-only');
  assert.deepEqual(methodCalls(calls, 'permission')[0][1], { outcome: { outcome: 'cancelled' } });
  assert.equal(children[0].child.exitCode, 0);

  const malformed = await fixture(t, { text: ['{"label":"nope"}'] });
  await assert.rejects(malformed.backend.run({ ...runOptions(), schema }), /invalid structured response/);
});

test('DeepSeek Main reuses its private host and session without durable-resume support or repeated schemas', async t => {
  const { backend, calls, children } = await fixture(t, { resume: false, text: ['{"label":"ready"}'] });
  const schema = { type: 'object', properties: { label: { type: 'string' } }, required: ['label'] };
  const first = await backend.run({ ...runOptions(), schema, persistSession: true });
  await backend.run({ ...runOptions(), schema, persistSession: true, schemaInHistory: true, resume: first.session_id });
  assert.equal(children.length, 1);
  assert.equal(methodCalls(calls, 'newSession').length, 1);
  assert.equal(methodCalls(calls, 'resumeSession').length, 0);
  assert.match(methodCalls(calls, 'prompt')[0][1].prompt[0].text, /Return only a JSON/);
  assert.doesNotMatch(methodCalls(calls, 'prompt')[1][1].prompt[0].text, /Return only a JSON/);
  await backend.run(runOptions());
  assert.equal(children.length, 2, 'ordinary work cannot reuse the private Main host');
  await backend.close(); assert.ok(children.every(row => row.child.exitCode === 0));
});

test('DeepSeek Main keeps its private session after invalid JSON, so the repair continues it without durable resume', async t => {
  let prompts = 0;
  const { backend, calls, children } = await fixture(t, { resume: false, onPrompt: () => ++prompts === 1 ? '{"label":"nope"}' : '{"label":"ready"}' });
  const schema = { type: 'object', properties: { label: { type: 'string', pattern: '^ready$' } }, required: ['label'], additionalProperties: false };
  let sessionId;
  await assert.rejects(backend.run({ ...runOptions(), schema, persistSession: true, onEvent: event => { sessionId ||= event.session_id; } }), /invalid structured response/);
  const repaired = await backend.run({ ...runOptions(), schema, persistSession: true, schemaInHistory: true, resume: sessionId });
  assert.deepEqual(repaired.structured_output, { label: 'ready' });
  assert.equal(children.length, 1);
  assert.equal(methodCalls(calls, 'newSession').length, 1);
  assert.equal(methodCalls(calls, 'resumeSession').length, 0);
  await backend.close();
});

test('DeepSeek ignores foreign or malformed updates and fails turns that do not complete', async t => {
  const { backend } = await fixture(t, { noise: true });
  const result = await backend.run(runOptions());
  assert.equal(result.result, 'Hello world');
  const failed = await fixture(t, { stopReason: 'refusal' });
  await assert.rejects(failed.backend.run(runOptions()), /without completion: refusal/);
  assert.equal(failed.backend.active, false);
});

test('DeepSeek image prompts follow the advertised capability and keep each media type', async t => {
  const none = await fixture(t);
  await assert.rejects(none.backend.run({ ...runOptions(), images: ['data:image/png;base64,aGk='] }), /does not support image/);
  const { backend, calls } = await fixture(t, { images: true });
  await backend.run({ ...runOptions(), images: ['data:image/jpeg;base64,aGVsbG8='] });
  assert.deepEqual(methodCalls(calls, 'prompt')[0][1].prompt.filter(part => part.type === 'image'), [{ type: 'image', mimeType: 'image/jpeg', data: 'aGVsbG8=' }]);
});

test('DeepSeek sets ELECTRON_RUN_AS_NODE only when it runs a JS script through this executable', async t => {
  const saved = process.env.ELECTRON_RUN_AS_NODE;
  delete process.env.ELECTRON_RUN_AS_NODE;
  t.after(() => { if (saved !== undefined) process.env.ELECTRON_RUN_AS_NODE = saved; });
  const native = await fixture(t);
  await native.backend.refresh();
  assert.equal(Object.hasOwn(native.children[0].options.env, 'ELECTRON_RUN_AS_NODE'), false);
  const script = await fixture(t, { find: () => ({ command: process.execPath, args: ['bin.js'] }) });
  await script.backend.refresh();
  assert.equal(script.children[0].options.env.ELECTRON_RUN_AS_NODE, '1');
  assert.deepEqual(script.children[0].args, ['bin.js', '--profile', 'acp']);
});

test('DeepSeek cancellation stops its process tree and releases the active turn', async t => {
  const { backend, calls, children } = await fixture(t, { wait: true });
  const abort = new AbortController();
  const running = backend.run({ ...runOptions(), signal: abort.signal });
  for (let i = 0; i < 100 && !methodCalls(calls, 'prompt').length; i++) await new Promise(resolve => setTimeout(resolve, 5));
  abort.abort();
  await assert.rejects(running, /stopped/);
  assert.equal(children[0].child.exitCode, 0);
  assert.equal(backend.hosts.size, 0);
  assert.equal(backend.active, false);
});

test('DeepSeek sign-in explains that dsh keeps its own API key', async t => {
  const { backend } = await fixture(t);
  await assert.rejects(backend.login(), /DEEPSEEK_API_KEY/);
});

test('a DeepSeek connect that fails says why, not that an API key is missing', async t => {
  const { backend } = await fixture(t);
  backend.createHost = async () => {
    const error = new Error("Cannot find package 'zod' imported from schema-deserialize.js");
    error.code = 'ERR_MODULE_NOT_FOUND';
    throw error;
  };
  const status = await backend.refresh();
  assert.deepEqual([status.installed, status.loggedIn], [true, false]);
  await assert.rejects(backend.login(), /^Error: DeepSeek Harness could not start: Cannot find package 'zod'/);
});

test('Send now cancels the DeepSeek step and prompts again in the same session without restarting the process', async t => {
  const { backend, calls, children } = await fixture(t, { cancelFirst: true, text: ['Replaced answer.'] });
  let input = null;
  const running = backend.run({ ...runOptions(), onInput: fn => { if (fn) input = fn; } });
  for (let i = 0; i < 200 && !(input && methodCalls(calls, 'prompt').length); i++) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(input({ id: 'queued', text: 'Later.', images: [] }, { steer: false }), /one prompt at a time/);
  await input({ id: 'now', text: 'Use the new requirement.', images: [] }, { steer: true });
  const result = await running;
  assert.equal(result.result, 'Replaced answer.');
  assert.deepEqual(methodCalls(calls, 'cancel').map(([, params]) => params.sessionId), ['session-1']);
  assert.deepEqual(methodCalls(calls, 'prompt').map(([, params]) => params.sessionId), ['session-1', 'session-1']);
  assert.equal(methodCalls(calls, 'prompt')[1][1].prompt[0].text, 'Use the new requirement.');
  assert.equal(children.length, 1, 'the same dsh process serves the replacement prompt');
  await assert.rejects(input({ id: 'after', text: 'Too late.', images: [] }, { steer: true }), /no longer accepting/);
});

test('a Stop while DeepSeek Send now is still cancelling the step never sends the message', async t => {
  const { backend, calls } = await fixture(t, { wait: true });
  const abort = new AbortController();
  let input = null;
  const running = backend.run({ ...runOptions(), signal: abort.signal, onInput: fn => { if (fn) input = fn; } });
  for (let i = 0; i < 200 && !(input && methodCalls(calls, 'prompt').length); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const refused = assert.rejects(input({ id: 'now', text: 'Use the new requirement.', images: [] }, { steer: true }), /stopped before the message was sent/);
  await new Promise(resolve => setTimeout(resolve, 20));
  abort.abort();
  await refused;
  await assert.rejects(running, /stopped/);
  assert.equal(methodCalls(calls, 'prompt').length, 1, 'nothing is sent on the closing connection');
});

test('an approval answered after Send now cannot approve anything for the replacement prompt', async t => {
  let answer;
  const { backend, calls } = await fixture(t, { permission: true, cancelFirst: true });
  let input = null;
  const running = backend.run({ ...runOptions(), access: 'workspace-write', onInput: fn => { if (fn) input = fn; },
    // Only the first prompt's approval is held; the replacement prompt's own request is denied at once.
    approve: () => answer ? Promise.resolve(false) : new Promise(resolve => { answer = resolve; }) });
  for (let i = 0; i < 200 && !answer; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await input({ id: 'now', text: 'Change course.', images: [] }, { steer: true });
  for (let i = 0; i < 200 && methodCalls(calls, 'prompt').length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  answer(true);
  for (let i = 0; i < 200 && methodCalls(calls, 'permission').length < 2; i++) await new Promise(resolve => setTimeout(resolve, 5));
  await running.catch(() => {});
  // Both requests end cancelled: the replacement's own (denied) and the old step's late Allow.
  assert.deepEqual(methodCalls(calls, 'permission').map(([, permission]) => permission.outcome), [{ outcome: 'cancelled' }, { outcome: 'cancelled' }],
    'the late Allow does not apply');
  assert.equal(methodCalls(calls, 'prompt').length, 2);
});
