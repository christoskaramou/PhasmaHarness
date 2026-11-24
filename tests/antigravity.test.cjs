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
  assert.equal(f.backend.models[0].images, true);
  assert.deepEqual(f.calls, []);
  assert.equal(f.backend.hosts.size, 0);
  const missing = await antigravityFixture(t, { authError: true });
  assert.equal((await missing.backend.refresh()).loggedIn, false);
  assert.deepEqual(missing.backend.models, []);
  assert.equal(missing.children.length, 1);
  await assert.rejects(missing.backend.login(), /Run agy in your terminal/);
});

test('unsupported permissions and invalid/structured images fail before configuration or provider submission, while worker turns stage valid images and clean up', async t => {
  const cwd = workspace(t), f = await antigravityFixture(t);
  for (const access of ['read-only', 'workspace-write', undefined]) await assert.rejects(f.backend.run({ ...turn(cwd), access }), /requires Full access/);
  await assert.rejects(f.backend.run({ ...turn(cwd), images: ['image'] }), /Invalid image/);
  await assert.rejects(f.backend.run({ ...turn(cwd), schema: { type: 'object' }, images: ['data:image/png;base64,iVBORw0KGgo='] }), /structured tool-free replies/);
  const abort = new AbortController(); abort.abort();
  await assert.rejects(f.backend.run({ ...turn(cwd), signal: abort.signal }), { name: 'AbortError' });
  assert.equal(f.children.length, 0);
  assert.equal(fs.existsSync(path.join(cwd, '.agents')), false);

  const img = 'data:image/png;base64,iVBORw0KGgo=';
  await f.backend.run({ ...turn(cwd), images: [img] });
  assert.equal(f.children.length, 1);
  const addDirIdx = f.children[0].args.indexOf('--add-dir');
  assert.ok(addDirIdx > -1, 'worker turn with direct images passes --add-dir for the temp image directory');
  const tempDir = f.children[0].args[addDirIdx + 1];
  assert.match(f.calls[0].message.content, /Attached image files \(inspect with read_file or view_file\):/);
  assert.ok(f.calls[0].message.content.includes(path.join(tempDir, 'image-1.png')));
  assert.equal(fs.existsSync(tempDir), false, 'temporary staged image directory is cleaned up after the turn');
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
  assert.equal(result.contextWindow, 1048576, 'a Gemini model gets its published window from the built-in table');
  assert.equal(f.calls.length, 1);
  assert.match(f.calls[0].message.content, /Do the assignment.*Use your assigned tools.*Hello/s);
  assert.equal(f.calls[0].event, 'user');
  const record = f.children[0];
  assert.match(record.definition, /phasma_harness/);
  assert.doesNotMatch(record.definition, /private-fixture-token|this-worker/);
  assert.ok(record.config.tools.includes('generate_image'), 'Antigravity worker keeps built-in generate_image');
  assert.ok(record.config.tools.includes('search_web'), 'Antigravity worker keeps built-in search_web');
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
  // A second call waits for the first instead of failing, and its own Stop ends the wait before it starts anything.
  const waitAbort = new AbortController(), waiting = f.backend.run({ ...turn(cwd), signal: waitAbort.signal });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.children.length, 1, 'the second call waits');
  waitAbort.abort();
  await assert.rejects(waiting, { name: 'AbortError' });
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
  assert.equal((await backend.run({ ...turn(cwd), images: ['data:image/png;base64,iVBORw0KGgo='] })).result, 'Hello world');
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

test('Antigravity context table: published sizes by model family, none for an unknown family', () => {
  const { contextWindow } = require('../src/providers/antigravity.cjs');
  // Model IDs as listed by `agy models` on 2026-11-04.
  assert.equal(contextWindow('gemini-3.8-flash-high'), 1048576);
  assert.equal(contextWindow('claude-opus-4-6-thinking'), 200000);
  assert.equal(contextWindow('claude-sonnet-4-6'), 200000);
  assert.equal(contextWindow('gpt-oss-120b-medium'), 131072);
  assert.equal(contextWindow('mystery-model'), undefined);
  assert.equal(contextWindow(undefined), undefined);
});

test('Antigravity projects each identified child without treating the parent step as its lifecycle', async t => {
  const session = 'agy-fixture-session', events = [];
  const step = subagents => ({ event: 'step_update', step_update: { conversation_id: session,
    step_index: 2, state: 'DONE', subagent_info: { subagents }, text_delta: 'PRIVATE_THOUGHT' } });
  const raw = [step([{ conversation_id: 'one', type_name: 'Explorer', role: 'Find tests', initial_prompt: 'PRIVATE_PROMPT' },
    { conversation_id: 'two', type_name: 'Explorer' }, { role: 'Unknown child' }]),
    step([{ conversation_id: 'one' }, { conversation_id: 'two', role: 'Read docs' }]),
    { event: 'step_update', step_update: { conversation_id: session, step_index: 3, state: 'DONE',
      step_type: 'agent_response', usage: { thinking_tokens: 42 } } },
    { event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'OK' } }]
    .map(value => JSON.stringify(value) + '\n').join('');
  const { backend } = await antigravityFixture(t, { raw });
  await backend.run({ ...turn(workspace(t)), onEvent: value => events.push(value) });
  assert.deepEqual(events.filter(e => e.type === 'info'), [
    { type: 'info', kind: 'agent', id: 'one', title: 'Explorer', text: 'Find tests\none' },
    { type: 'info', kind: 'agent', id: 'two', title: 'Explorer', text: 'two' },
    { type: 'info', kind: 'agent', id: 'two', title: 'Explorer', text: 'Read docs\ntwo' },
    { type: 'info', kind: 'reasoning', id: 'reasoning:3', title: 'Reasoning', text: '42 thinking tokens' },
  ]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE|Unknown child/);
});

test('Antigravity keeps distinct response steps and fresh turn-only reasoning counts', async t => {
  const conversation_id = 'agy-fixture-session', events = [];
  const raw = [
    ...['Reviewing the files.', 'Two files changed.'].map((text_delta, step_index) => ({ event: 'step_update',
      step_update: { conversation_id, step_type: 'agent_response', step_index, text_delta } })),
    { event: 'result', result: { conversation_id, num_turns: 1, status: 'SUCCESS', response: 'Two files changed.', usage: { thinking_tokens: 3 } } },
  ].map(value => JSON.stringify(value) + '\n').join('');
  const { backend } = await antigravityFixture(t, { raw });
  await backend.run({ ...turn(workspace(t)), onEvent: e => events.push(e) });
  const ids = events.filter(e => e.event?.type === 'message_start').map(e => e.event.message.id);
  assert.equal(new Set(ids).size, 2);
  assert.deepEqual(events.filter(e => e.message?.phase).map(e => [e.message.id, e.message.phase]),
    [[ids[0], 'commentary'], [ids[1], 'final_answer']]);
  assert.equal(events.find(e => e.kind === 'reasoning').text, '3 thinking tokens');
});

test('Antigravity keeps child file references and records public checkpoint and timing without reading nested contents', async t => {
  const conversation_id = 'agy-fixture-session', events = [];
  const step = (step_type, step_index, fields) => ({ event: 'step_update',
    step_update: { conversation_id, step_type, step_index, state: 'DONE', ...fields } });
  const log = 'file:///tmp/child.json';
  const raw = [step('subagent', 1, { subagent_info: { subagents: [{ log_uri: log + '?token=PRIVATE',
    workspace_uris: ['file:///tmp/work', 'data:text/plain,PRIVATE'], initial_prompt: 'PRIVATE'.repeat(10000) }] } }),
    step('subagent', 1, { subagent_info: { subagents: [{ log_uri: log, conversation_id: 'child', role: 'Reader' }] } }),
    step('subagent', 1, { subagent_info: { subagents: [{ conversation_id: 'child', type_name: 'Explorer' }] } }),
    ...Array.from({ length: 2 }, () => step('subagent', 10, { subagent_info: { subagents: Array.from({ length: 256 }, (_, i) =>
      ({ conversation_id: 'batch-' + i, role: 'Review', initial_prompt: 'PRIVATE'.repeat(80) })) } })),
    step('checkpoint', 2, { state: 'ACTIVE' }), step('checkpoint', 2, { duration_seconds: 2.5, text_delta: 'PRIVATE' }),
    step('system_message', 3, { text_delta: 'PRIVATE' }), step('agent_response', 4, { duration_seconds: 0 }),
    { event: 'result', result: { conversation_id, status: 'SUCCESS', response: 'OK' } }].map(x => JSON.stringify(x) + '\n').join('');
  const { backend } = await antigravityFixture(t, { raw });
  await backend.run({ ...turn(workspace(t)), onEvent: e => events.push(e) });
  const children = events.filter(e => e.kind === 'agent' && !e.id.startsWith('batch-'));
  assert.equal(events.filter(e => e.id?.startsWith('batch-')).length, 256, 'one row per child across repeated large snapshots');
  assert.deepEqual(children.map(e => e.id), [log, log, log]);
  assert.match(children.at(-1).text, /Reader\nchild\nLog: file:\/\/\/tmp\/child.json\nWorkspace: file:\/\/\/tmp\/work/);
  assert.equal(children.at(-1).status, undefined);
  assert.deepEqual(events.filter(e => e.kind === 'progress').map(e => [e.id, e.title, e.status, e.text]), [
    ['step:2', 'Checkpoint', 'ACTIVE', ''], ['step:2', 'Checkpoint', 'DONE', 'Duration: 2.5 s'],
    ['step:3', 'System update', 'DONE', ''], ['step:4', 'Agent response', 'DONE', 'Duration: 0 s'],
  ]);
  assert.doesNotMatch(JSON.stringify(events), /PRIVATE/);
});

test('failed Antigravity tool steps emit is_error tool_result events with readable error text', async t => {
  const cwd = workspace(t), session = 'agy-fixture-session', events = [];
  const line = value => JSON.stringify(value) + '\n';
  const raw =
    line({ event: 'step_update', step_update: { conversation_id: session, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'read_file', tool_info: { parameters: { Path: 'missing.txt' } } } }) +
    line({ event: 'step_update', step_update: { conversation_id: session, step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'read_file', tool_info: { parameters: { Path: 'missing.txt' }, error: { type: 'TOOL_ERROR', message: 'file does not exist' } } } }) +
    line({ event: 'step_update', step_update: { conversation_id: session, step_index: 3, state: 'CANCELED', step_type: 'tool', tool_name: 'generate_image', tool_info: { parameters: { ImageName: 'icon' } } } }) +
    line({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'Done', num_turns: 1, usage: { input_tokens: 5, output_tokens: 2 } } });
  const f = await antigravityFixture(t, { raw });
  const result = await f.backend.run({ ...turn(cwd), onEvent: event => events.push(event) });
  assert.equal(result.result, 'Done');
  const uses = events.flatMap(e => e.type === 'assistant' ? (e.message?.content || []).filter(c => c.type === 'tool_use') : []);
  const results = events.flatMap(e => e.type === 'user' ? (e.message?.content || []).filter(c => c.type === 'tool_result') : []);
  assert.deepEqual(uses.map(u => [u.id, u.name]), [[session + ':2', 'read_file'], [session + ':3', 'generate_image']]);
  assert.deepEqual(results, [
    { type: 'tool_result', tool_use_id: session + ':2', is_error: true, content: 'file does not exist' },
    { type: 'tool_result', tool_use_id: session + ':3', is_error: true, content: 'CANCELED' },
  ]);
});

test('Antigravity noTools mode runs tool-free without Full access, rejects tool steps, and pre-flight errors preserve the session', async t => {
  const cwd = workspace(t), session = 'agy-fixture-session';
  const line = value => JSON.stringify(value) + '\n';
  const textOnly = await antigravityFixture(t, { raw:
    line({ event: 'step_update', step_update: { conversation_id: session, step_index: 1, state: 'DONE', step_type: 'agent_response', text_delta: 'Cancelled noted.' } }) +
    line({ event: 'result', result: { conversation_id: session, status: 'SUCCESS', response: 'Cancelled noted.', num_turns: 1, usage: { input_tokens: 10, output_tokens: 3 } } }) });
  const helpers = { serverName: 'phasma_harness', command: process.execPath, args: ['helper.cjs'], env: { TOKEN: 'x' }, instructions: 'Helper instructions.' };
  const result = await textOnly.backend.run({ ...turn(cwd), access: 'read-only', noTools: true, helpers });
  assert.equal(result.result, 'Cancelled noted.');
  assert.ok(!textOnly.children[0].args.includes('--dangerously-skip-permissions'), 'noTools never auto-approves tools');
  assert.deepEqual(textOnly.children[0].config.mcpServers, [], 'noTools mounts no MCP servers');
  assert.match(textOnly.calls[0].message.content, /No tools are available/);

  const tooled = await antigravityFixture(t); // fixture stream attempts a tool call
  await assert.rejects(tooled.backend.run({ ...turn(cwd), access: 'read-only', noTools: true }), error => /cannot use tools/.test(error.message) && error.preserveSession === true);

  // Ordinary read-only turns still fail pre-flight with preserveSession so an existing session is not wiped.
  const denied = await antigravityFixture(t);
  await assert.rejects(denied.backend.run({ ...turn(cwd), access: 'read-only' }), error => /requires Full access/.test(error.message) && error.preserveSession === true);
  assert.equal(denied.children.length, 0);
});

test('Antigravity pre-flight rejects oversized single messages before spawn and bounded handoff keeps the newest messages', async t => {
  const { handoff } = require('../src/providers/claude.cjs');
  const { MAX_MESSAGE_BYTES } = require('../src/providers/antigravity.cjs');
  assert.ok(Number.isSafeInteger(MAX_MESSAGE_BYTES) && MAX_MESSAGE_BYTES > 0 && MAX_MESSAGE_BYTES <= 220 * 1024);

  const cwd = workspace(t), f = await antigravityFixture(t);
  await assert.rejects(f.backend.run({ ...turn(cwd), prompt: 'a'.repeat(MAX_MESSAGE_BYTES + 100) }),
    error => /single-message limit/.test(error.message) && error.preserveSession === true);
  assert.equal(f.children.length, 0, 'oversized prompt is rejected before spawning agy');

  // Trim mode keeps newest messages, drops oldest, and handles an oversized single message with surrogate pairs cleanly.
  const items = Array.from({ length: 80 }, (_, i) => ({
    id: `m-${i}`, type: i % 2 === 0 ? 'userMessage' : 'agentMessage', phase: 'final_answer',
    content: [{ type: 'text', text: `MSG_${String(i).padStart(3, '0')}_` + 'x'.repeat(6000) }],
    text: `MSG_${String(i).padStart(3, '0')}_` + 'x'.repeat(6000),
  }));
  const trimmed = handoff(items, 50000, null, { trim: true });
  assert.ok(Buffer.byteLength(trimmed, 'utf8') <= 50000, 'bounded handoff stays within byte budget');
  assert.match(trimmed, /MSG_079_/, 'newest message is preserved');
  assert.doesNotMatch(trimmed, /MSG_000_/, 'oldest message is dropped first');
  assert.match(trimmed, /older omitted to fit provider limit/);

  const singleHuge = [{ id: 'big', type: 'agentMessage', phase: 'final_answer', text: '🚀'.repeat(20000) + 'TAIL_MARKER' }];
  const clipped = handoff(singleHuge, 4000, null, { trim: true });
  assert.ok(Buffer.byteLength(clipped, 'utf8') <= 4000);
  assert.match(clipped, /TAIL_MARKER/, 'oversized newest message preserves its tail');
  assert.ok(!/[\uD800-\uDFFF]/.test(clipped.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, '')), 'no unpaired UTF-16 surrogates');
});

test('a finished Antigravity worker turn parks and reuses its process on matching resumed turns', async t => {
  const cwd = workspace(t), f = await antigravityFixture(t);
  const helpers = { serverName: 'phasma_harness', command: process.execPath, args: ['helper.cjs'],
    env: { PHASMA_BRIDGE_TOKEN: 'tok-1', ELECTRON_RUN_AS_NODE: '1' }, instructions: 'Initial helper instructions.' };
  const events1 = [], events2 = [];
  const first = await f.backend.run({ ...turn(cwd), helpers, effort: 'medium', onEvent: e => events1.push(e) });
  assert.equal(f.children.length, 1);
  assert.equal(f.backend.warmCount(), 1);
  assert.equal(f.backend.hosts.size, 0, 'an idle warm host does not block hosts.size');
  assert.equal(f.children[0].child.exitCode, null);
  assert.deepEqual(fs.readdirSync(path.join(cwd, '.agents', 'agents')), [], 'agent file is removed before parking');

  const second = await f.backend.run({
    ...turn(cwd),
    resume: first.session_id,
    effort: 'medium',
    instructions: 'Updated turn instructions.',
    helpers: { ...helpers, instructions: 'Updated helper instructions.' },
    prompt: 'Second turn',
    onEvent: e => events2.push(e),
  });
  assert.equal(f.children.length, 1, 'reuses the parked process instead of spawning a second one');
  assert.equal(f.backend.warmCount(), 1);
  assert.equal(f.backend.hosts.size, 0);
  assert.equal(f.calls.length, 2, 'both prompts were written to the same process stdin');
  assert.match(f.calls[1].message.content, /Updated turn instructions.*Updated helper instructions.*Second turn/s);
  assert.equal(second.session_id, first.session_id);
  assert.equal(second.usage, undefined, 'resumed turn keeps usage unknown');
  assert.equal(second.cacheUsageUnknown, true);
  assert.ok(events2.some(e => e.type === 'system' && e.session_id === first.session_id));
  assert.ok(events2.some(e => e.type === 'stream_event'));
  assert.ok(events2.some(e => e.type === 'assistant' && e.message?.content?.some(c => c.type === 'text')));
});

test('changing model, effort, cwd, helpers, or adding images closes the parked Antigravity host and starts fresh', async t => {
  const cwd1 = workspace(t), cwd2 = workspace(t), f = await antigravityFixture(t);
  const baseHelpers = { serverName: 'phasma_harness', command: process.execPath, args: ['h1.cjs'], env: { TOKEN: 'a' } };
  let res = await f.backend.run({ ...turn(cwd1), helpers: baseHelpers, effort: 'low' });
  assert.equal(f.children.length, 1);

  // Model change
  res = await f.backend.run({ ...turn(cwd1), resume: res.session_id, helpers: baseHelpers, effort: 'low', model: 'claude-sonnet-4-6' });
  assert.equal(f.children[0].child.exitCode, 0);
  assert.equal(f.children.length, 2);
  assert.ok(f.children[1].args.includes('--conversation'));

  // Effort change
  res = await f.backend.run({ ...turn(cwd1), resume: res.session_id, helpers: baseHelpers, effort: 'high', model: 'claude-sonnet-4-6' });
  assert.equal(f.children[1].child.exitCode, 0);
  assert.equal(f.children.length, 3);

  // Helpers env change
  const helpers2 = { ...baseHelpers, env: { TOKEN: 'b' } };
  res = await f.backend.run({ ...turn(cwd1), resume: res.session_id, helpers: helpers2, effort: 'high', model: 'claude-sonnet-4-6' });
  assert.equal(f.children[2].child.exitCode, 0);
  assert.equal(f.children.length, 4);

  // Cwd change
  res = await f.backend.run({ ...turn(cwd2), resume: res.session_id, helpers: helpers2, effort: 'high', model: 'claude-sonnet-4-6' });
  assert.equal(f.children[3].child.exitCode, 0);
  assert.equal(f.children.length, 5);

  // Images turn (not poolable) closes previous parked host and does not park itself
  await f.backend.run({ ...turn(cwd2), resume: res.session_id, helpers: helpers2, effort: 'high', model: 'claude-sonnet-4-6',
    images: ['data:image/png;base64,iVBORw0KGgo='] });
  assert.equal(f.children[4].child.exitCode, 0);
  assert.equal(f.children[5].child.exitCode, 0);
  assert.equal(f.children.length, 6);
  assert.equal(f.backend.warmCount(), 0);
});

test('failed, aborted, timed-out, schema, noTools, and image turns never park in Antigravity', async t => {
  const cwd = workspace(t);

  // Schema
  const schemaF = await antigravityFixture(t, { raw: JSON.stringify({ event: 'result', result: { conversation_id: 'agy-fixture-session', status: 'SUCCESS', response: '{"ok":true}', num_turns: 1 } }) + '\n' });
  await schemaF.backend.run({ cwd, model: 'gemini-fixture-high', prompt: 'json', schema: { type: 'object' } });
  assert.equal(schemaF.backend.warmCount(), 0);
  assert.equal(schemaF.children[0].child.exitCode, 0);

  // noTools
  const noToolsF = await antigravityFixture(t, { raw: JSON.stringify({ event: 'result', result: { conversation_id: 'agy-fixture-session', status: 'SUCCESS', response: 'ok', num_turns: 1 } }) + '\n' });
  await noToolsF.backend.run({ ...turn(cwd), access: 'read-only', noTools: true });
  assert.equal(noToolsF.backend.warmCount(), 0);
  assert.equal(noToolsF.children[0].child.exitCode, 0);

  // Failed turn
  const failF = await antigravityFixture(t, { resultStatus: 'ERROR', resultError: 'boom' });
  await assert.rejects(failF.backend.run(turn(cwd)), /ERROR/);
  assert.equal(failF.backend.warmCount(), 0);
  assert.equal(failF.children[0].child.exitCode, 0);

  // Aborted & timed-out turns
  const waitF = await antigravityFixture(t, { wait: true });
  const ac = new AbortController();
  const p = waitF.backend.run({ ...turn(cwd), signal: ac.signal });
  await new Promise(r => setImmediate(r));
  ac.abort();
  await assert.rejects(p, { name: 'AbortError' });
  assert.equal(waitF.backend.warmCount(), 0);
  assert.equal(waitF.children[0].child.exitCode, 0);

  await assert.rejects(waitF.backend.run({ ...turn(cwd), timeoutMs: 5 }), /timed out/);
  assert.equal(waitF.backend.warmCount(), 0);
  assert.equal(waitF.children[1].child.exitCode, 0);
});

test('a parked Antigravity host that exits or emits unsolicited stdout while idle is dropped and replaced', async t => {
  const cwd = workspace(t), f = await antigravityFixture(t);
  const first = await f.backend.run(turn(cwd));
  assert.equal(f.backend.warmCount(), 1);

  // Unexpected stdout while parked drops and closes it
  f.children[0].child.stdout.write('unsolicited noise\n');
  await new Promise(r => setImmediate(r));
  assert.equal(f.backend.warmCount(), 0);
  assert.equal(f.children[0].child.exitCode, 0);

  const second = await f.backend.run({ ...turn(cwd), resume: first.session_id });
  assert.equal(f.children.length, 2, 'spawns a fresh process when parked host was dropped');
  assert.equal(f.backend.warmCount(), 1);

  // Unexpected crash/exit while parked drops it
  f.children[1].child.kill();
  await new Promise(r => setImmediate(r));
  assert.equal(f.backend.warmCount(), 0);

  await f.backend.run({ ...turn(cwd), resume: second.session_id });
  assert.equal(f.children.length, 3);
  assert.equal(f.backend.warmCount(), 1);
});

test('at most three Antigravity processes stay warm across bots, expire after 10 minutes, and close() stops only owned ones', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cwd = workspace(t);
  const a = await antigravityFixture(t), b = await antigravityFixture(t);

  await a.backend.run({ ...turn(cwd), resume: 'sess-1' });
  await a.backend.run({ ...turn(cwd), resume: 'sess-2' });
  await b.backend.run({ ...turn(cwd), resume: 'sess-3' });
  await b.backend.run({ ...turn(cwd), resume: 'sess-4' });

  assert.equal(a.backend.warmCount() + b.backend.warmCount(), 3, 'global cap of 3 warm processes across instances');
  assert.equal(a.children[0].child.exitCode, 0, 'oldest entry is evicted and closed first');
  assert.equal(a.backend.warmCount(), 1);
  assert.equal(b.backend.warmCount(), 2);

  await a.backend.close();
  assert.equal(a.backend.warmCount(), 0);
  assert.equal(a.children[1].child.exitCode, 0);
  assert.equal(b.backend.warmCount(), 2, 'closing one instance leaves other instances warm');

  t.mock.timers.tick(10 * 60 * 1000);
  await new Promise(r => setImmediate(r));
  assert.equal(b.backend.warmCount(), 0, 'idle warm processes expire after 10 minutes');
  assert.ok(b.children.every(rec => rec.child.exitCode === 0));
});
