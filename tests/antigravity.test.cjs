const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { antigravityFixture } = require('./fixtures/native-cli.cjs');

function workspace(t) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agy-test-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  return cwd;
}

const turn = cwd => ({ cwd, access: 'danger-full-access', model: 'gemini-fixture-high', instructions: 'Do the assignment.', prompt: 'Hello' });

test('Antigravity metadata checks native setup without inference, and its models can route', async t => {
  const f = await antigravityFixture(t);
  assert.equal((await f.backend.refresh()).loggedIn, true);
  assert.deepEqual(f.children.map(child => child.args), [['-p', '/usage', '--output-format', 'json'], ['models']]);
  assert.equal(f.backend.models.length, 1);
  assert.equal(f.backend.models[0].provider, 'native:antigravity');
  assert.equal(f.backend.models[0].router, true);
  assert.equal(f.backend.models[0].images, false);
  assert.deepEqual(f.calls, []);
  assert.equal(f.backend.hosts.size, 0);
  const missing = await antigravityFixture(t, { authError: true });
  assert.equal((await missing.backend.refresh()).loggedIn, false);
  assert.deepEqual(missing.backend.models, []);
  assert.equal(missing.children.length, 1);
  await assert.rejects(missing.backend.login(), /Run agy in your terminal/);
});

test('unsupported permissions and images fail before configuration or provider submission', async t => {
  const cwd = workspace(t), f = await antigravityFixture(t);
  for (const access of ['read-only', 'workspace-write', undefined]) await assert.rejects(f.backend.run({ ...turn(cwd), access }), /requires Full access/);
  await assert.rejects(f.backend.run({ ...turn(cwd), images: ['image'] }), /text only/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.backend.run({ ...turn(cwd), signal: abort.signal }), { name: 'AbortError' });
  assert.equal(f.children.length, 0);
  assert.equal(fs.existsSync(path.join(cwd, '.agents')), false);
});

// 2026-10-31, the user: no blocks nobody tested. Antigravity answers Hub and routing replies as DeepSeek and Cursor do: the
// schema in its prompt, and a reply that uses a tool is not accepted. Before, Harness refused before asking agy.
test('Antigravity answers a Hub or routing reply with the schema in its prompt, and a tool step rejects that reply', async t => {
  const cwd = workspace(t), json = '{"reply":"Yes","action":null}', schema = { type: 'object', properties: { reply: { type: 'string' } } };
  const line = value => JSON.stringify(value) + '\n', session = 'agy-fixture-session';
  const f = await antigravityFixture(t, { raw: line({ event: 'step_update', step_update: { conversation_id: session, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: json } }) +
    line({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: json, num_turns: 1, usage: { input_tokens: 10, output_tokens: 3 } } }) });
  const { access, ...hubCall } = turn(cwd); // a Hub or routing call passes no access
  assert.equal((await f.backend.run({ ...hubCall, schema })).result, json);
  assert.match(f.calls[0].message.content, /Return only a JSON object matching this schema\. No tools are available\.\n\{"type":"object"/);
  assert.ok(!f.children[0].args.includes('--dangerously-skip-permissions'), 'a tool-free reply never auto-approves tools');
  const tooled = await antigravityFixture(t); // its stream calls a tool
  await assert.rejects(tooled.backend.run({ ...hubCall, schema }), { code: 'INVALID_STRUCTURED_RESPONSE' });
});

test('one native turn streams public text and generic helper events, keeps credentials off disk and resumes explicitly', async t => {
  const cwd = workspace(t), f = await antigravityFixture(t, { afterResult: '{"event":"init"}\n' }), events = [];
  const helpers = { serverName: 'phasma_harness', command: process.execPath, args: ['assigned-helper.cjs'],
    env: { PHASMA_BRIDGE_TOKEN: 'private-fixture-token', PHASMA_SESSION_ID: 'this-worker' }, instructions: 'Use your assigned tools.' };
  const result = await f.backend.run({ ...turn(cwd), helpers, onEvent: event => events.push(event) });
  assert.equal(result.result, 'Hello world');
  assert.deepEqual(result.usage, { input_tokens: 10, output_tokens: 3, cache_read_input_tokens: 5 });
  assert.equal(result.cacheUsageUnknown, false);
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].message.content, /Do the assignment.*Use your assigned tools.*Hello/s);
  assert.equal(f.calls[0].event, 'user');
  const record = f.children[0];
  assert.match(record.definition, /phasma_harness/);
  assert.doesNotMatch(record.definition, /private-fixture-token|this-worker/);
  assert.equal(record.options.env.PHASMA_BRIDGE_TOKEN, 'private-fixture-token');
  assert.equal(fs.existsSync(record.file), false);
  assert.equal(record.child.exitCode, 0);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE_REASONING/);
  assert.ok(events.some(event => event.message?.content?.some(item => item.name === 'call_mcp_tool')));
  assert.ok(events.some(event => event.message?.content?.some(item => item.type === 'tool_result' && item.content === 'helper receipt')));
  const resumed = await f.backend.run({ ...turn(cwd), resume: result.session_id });
  assert.ok(f.children[1].args.includes('--conversation'));
  assert.equal(resumed.session_id, result.session_id);
  assert.equal(resumed.usage, undefined, 'unverified cumulative resume counters must not be billed twice');
  assert.equal(resumed.cacheUsageUnknown, true);
  assert.equal(f.backend.hosts.size, 0);
});

test('the native agy process never inherits ELECTRON_RUN_AS_NODE, even from helper env', async t => {
  const cwd = workspace(t), f = await antigravityFixture(t);
  const helpers = { serverName: 'phasma_harness', command: process.execPath, args: ['helper.cjs'], env: { ELECTRON_RUN_AS_NODE: '1', TOKEN: 'x' } };
  await f.backend.run({ ...turn(cwd), helpers });
  assert.equal(Object.hasOwn(f.children[0].options.env, 'ELECTRON_RUN_AS_NODE'), false);
  assert.equal(f.children[0].options.env.TOKEN, 'x');
  assert.equal(f.children[0].config.mcpServers[0].env.ELECTRON_RUN_AS_NODE, '1');
});

test('missing, malformed or overflowing native usage stays unknown while explicit zero remains a valid report', async t => {
  const cwd = workspace(t);
  for (const usage of [{}, { input_tokens: -1, output_tokens: 2 },
    { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 },
    { input_tokens: 10, output_tokens: 1, cache_read_tokens: Number.MAX_SAFE_INTEGER }]) {
    const f = await antigravityFixture(t, { usage });
    assert.equal((await f.backend.run(turn(cwd))).usage, undefined);
  }
  const f = await antigravityFixture(t, { usage: { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0 } });
  assert.deepEqual((await f.backend.run(turn(cwd))).usage, { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 });
});

test('foreign init, permissions and results, invalid streams and incomplete exits fail closed without automatic replay', async t => {
  const cwd = workspace(t);
  for (const [option, expression, inputs] of [
    [{ wrongAgent: true }, /did not confirm/, 0], [{ permissionMode: 'request-review' }, /did not confirm/, 0],
    [{ foreignResume: true }, /did not confirm/, 0], [{ foreignResult: true }, /unrelated result/, 1],
    [{ raw: 'not-json\n' }, /JSON|Unexpected/, 1], [{ raw: '{"event":"control_request"}\n' }, /Unsupported/, 1],
    [{ exitEarly: true }, /before confirming/, 1], [{ resultStatus: 'WAITING' }, /WAITING/, 1],
    [{ resultStatus: 'ERROR', resultError: 'quota exhausted' }, /usage limit reached/, 1],
  ]) {
    const f = await antigravityFixture(t, option);
    await assert.rejects(f.backend.run({ ...turn(cwd), ...(option.foreignResume ? { resume: 'previous' } : {}) }), expression);
    assert.equal(f.calls.length, inputs);
    assert.equal(f.children.length, 1);
    assert.equal(f.backend.hosts.size, 0);
    assert.equal(fs.existsSync(f.children[0].file), false);
  }
});

test('Stop and timeout confirm cleanup and remove only the generated worker configuration', async t => {
  const cwd = workspace(t), f = await antigravityFixture(t, { wait: true });
  fs.mkdirSync(path.join(cwd, '.agents', 'agents'), { recursive: true });
  const userFile = path.join(cwd, '.agents', 'agents', 'keep.md'); fs.writeFileSync(userFile, 'User configuration');
  const abort = new AbortController();
  const pending = f.backend.run({ ...turn(cwd), signal: abort.signal });
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.backend.run(turn(cwd)), /active process/);
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(f.children[0].child.exitCode, 0);
  await assert.rejects(f.backend.run({ ...turn(cwd), timeoutMs: 5 }), /timed out/);
  assert.deepEqual(fs.readdirSync(path.dirname(userFile)), ['keep.md']);
  assert.equal(fs.readFileSync(userFile, 'utf8'), 'User configuration');
  const earlyAbort = new AbortController(), beforeInit = f.backend.run({ ...turn(cwd), signal: earlyAbort.signal });
  const inputs = f.calls.length;
  earlyAbort.abort();
  await assert.rejects(beforeInit, { name: 'AbortError' });
  assert.equal(f.calls.length, inputs, 'an aborted startup must not submit a prompt');
});

test('configuration failures and native spawn failures cannot leave a runnable worker or delete changed files', async t => {
  const cwd = workspace(t), f = await antigravityFixture(t, { spawnError: new Error('fixture spawn failed') });
  await assert.rejects(f.backend.run(turn(cwd)), /spawn failed/);
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.agents', 'agents')), []);
  const edited = await antigravityFixture(t, { onPrompt: ({ record }) => { fs.writeFileSync(record.file, 'Changed by user'); } });
  assert.equal((await edited.backend.run(turn(cwd))).result, 'Hello world', 'a confirmed result is not discarded over a preserved file');
  assert.equal(fs.readFileSync(edited.children[0].file, 'utf8'), 'Changed by user');
  assert.equal(edited.children[0].child.exitCode, 0);
});

test('linked configuration directories cannot redirect writes outside the selected workspace', async t => {
  const cwd = workspace(t), outside = workspace(t), f = await antigravityFixture(t);
  fs.symlinkSync(outside, path.join(cwd, '.agents'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.backend.run(turn(cwd)), /ordinary workspace directories/);
  assert.deepEqual(fs.readdirSync(outside), []);
  assert.equal(f.children.length, 0);
});

test('a confirmed result survives unconfirmed cleanup, which still removes the worker file and blocks the next run', async t => {
  const tree = require('../src/process-tree.cjs'), modulePath = require.resolve('../src/providers/antigravity.cjs'), stopTree = tree.stopTree;
  tree.stopTree = async () => [4242];
  delete require.cache[modulePath];
  const { AntigravityCLI } = require(modulePath);
  tree.stopTree = stopTree; delete require.cache[modulePath];
  const cwd = workspace(t), f = await antigravityFixture(t), backend = new AntigravityCLI(f.backend.launch, f.backend.find);
  assert.equal((await backend.run(turn(cwd))).result, 'Hello world');
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.agents', 'agents')), []);
  assert.equal(backend.hosts.size, 1);
  await assert.rejects(backend.run(turn(cwd)), /pending cleanup/);
});

test('the startup sweep removes only unchanged generated worker files left by a crash', async t => {
  const { sweepAgentFiles } = require('../src/providers/antigravity.cjs');
  const cwd = workspace(t), f = await antigravityFixture(t);
  await f.backend.run(turn(cwd));
  const leftover = f.children[0].file, directory = path.dirname(leftover);
  fs.writeFileSync(leftover, f.children[0].definition);
  const changed = path.join(directory, 'phasma-00000000-0000-4000-8000-000000000001.md');
  fs.writeFileSync(changed, f.children[0].definition.replace('Follow', 'Please follow'));
  const renamed = path.join(directory, 'phasma-00000000-0000-4000-8000-000000000002.md');
  fs.writeFileSync(renamed, f.children[0].definition);
  fs.writeFileSync(path.join(directory, 'keep.md'), 'User configuration');
  sweepAgentFiles([cwd, cwd, null, path.join(cwd, 'missing')]);
  assert.deepEqual(fs.readdirSync(directory).sort(), [path.basename(changed), path.basename(renamed), 'keep.md'].sort());
});
