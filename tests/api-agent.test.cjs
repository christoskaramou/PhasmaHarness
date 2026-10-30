const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ApiAgent, needsApproval } = require('../src/providers/api-agent.cjs');

const stream = chunks => new Response(new ReadableStream({ start(output) {
  for (const chunk of chunks) output.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`));
  output.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); output.close();
} }), { status: 200 });
const call = (index, id, name, args) => ({ choices: [{ delta: { tool_calls: [{ index, id, function: { name, arguments: JSON.stringify(args) } }] } }] });

function fixture(t, steps) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-api-agent-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'project'), outside = path.join(root, 'outside.txt');
  fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'notes.txt'), 'alpha\nbeta\n');
  fs.writeFileSync(outside, 'private');
  if (typeof steps === 'function') steps = steps(outside);
  const requests = [];
  const providers = {
    local: { inspect: async () => ({ supported: false }) },
    modelRequest: async (_choice, body) => { requests.push(structuredClone(body)); return stream(steps[requests.length - 1]); },
  };
  return { agent: new ApiAgent(providers, path.join(root, 'sessions')), workspace, outside, requests };
}

const run = (agent, workspace, access, approvals, prompt = 'Do the task.') => agent.run({
  provider: 'local', model: 'test', cwd: workspace, prompt, access, signal: new AbortController().signal,
  approve: async tool => { approvals.push(tool); return tool.toolName !== 'read_file'; }, onEvent: () => {},
});

test('resumed API work refreshes instructions while retaining its conversation', async t => {
  const reply = [{ choices: [{ delta: { content: 'ok' } }] }];
  const { agent, workspace, requests } = fixture(t, [reply, reply]);
  const options = { provider: 'local', model: 'test', cwd: workspace, access: 'read-only', signal: new AbortController().signal, onEvent() {} };
  const first = await agent.run({ ...options, prompt: 'Remember this request.', instructions: 'Old project rule.' });
  await agent.run({ ...options, resume: first.session_id, prompt: 'Continue.', instructions: 'Current managed project rule.',
    recoveryPrompt: () => assert.fail('valid provider history must never build recovery text') });
  assert.match(requests[1].messages[0].content, /Current managed project rule/);
  assert.doesNotMatch(requests[1].messages[0].content, /Old project rule/);
  assert.ok(requests[1].messages.some(message => message.content === 'Remember this request.'));
  assert.equal(requests[1].messages.filter(message => message.role === 'system').length, 1);
});

test('API history preserves reasoning and exact message prefixes across restart, with stable cache affinity', async t => {
  const details = [{ type: 'reasoning.encrypted', data: 'opaque-provider-content', index: 0 }];
  const { agent, workspace, requests } = fixture(t, [
    [{ choices: [{ delta: { content: 'Remembered.', reasoning_content: 'provider reasoning', reasoning_details: details } }],
      usage: { prompt_tokens: 100, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 50, cache_write_tokens: 20 } } }],
    [{ choices: [{ delta: { content: 'Continued.' } }], usage: { prompt_tokens: 160, completion_tokens: 4 } }],
  ]);
  const keys = [], modelRequest = agent.providers.modelRequest;
  agent.providers.modelRequest = async (...args) => { keys.push(args[5]); return modelRequest(...args); };
  const options = { provider: 'local', model: 'test', cwd: workspace, instructions: 'Stable system rules.', access: 'read-only', signal: new AbortController().signal, onEvent() {} };
  const first = await agent.run({ ...options, prompt: 'Remember me.' });
  assert.equal(first.usage.total_input_tokens, 100);
  assert.equal(first.usage.cache_read_input_tokens, 50);
  const restarted = new ApiAgent(agent.providers, agent.directory);
  const second = await restarted.run({ ...options, resume: first.session_id, prompt: 'Continue.' });
  assert.equal(second.session_id, first.session_id); assert.equal(keys[0], keys[1]);
  assert.deepEqual(requests[1].messages.slice(0, 2), requests[0].messages);
  assert.equal(requests[1].messages[2].reasoning_content, 'provider reasoning');
  assert.deepEqual(requests[1].messages[2].reasoning_details, details);
  assert.equal(second.usage.cache_read_input_tokens, null, 'missing cache reporting is unknown, not zero');
  fs.writeFileSync(path.join(agent.directory, first.session_id + '.json'), '{broken');
  await assert.rejects(restarted.run({ ...options, resume: first.session_id, prompt: 'Do not lose history.' }), /saved API conversation is unavailable/);
  assert.equal(requests.length, 2, 'no incomplete conversation reaches the provider');
});

test('a missing usage report in a tool loop marks the total as incomplete', async t => {
  const { agent, workspace } = fixture(t, [
    [call(0, 'read', 'read_file', { path: 'notes.txt' })],
    [{ choices: [{ delta: { content: 'Done.' } }], usage: { prompt_tokens: 100, completion_tokens: 4 } }],
  ]);
  const result = await run(agent, workspace, 'read-only', []);
  assert.equal(result.usageIncomplete, true);
  assert.equal(result.usage.total_input_tokens, 100, 'reported tokens remain a lower bound, not a complete or zero-cost turn');
});

// 2026-10-30: image_read returns an image, which an API tool message cannot carry.
test('an image a Harness tool returns reaches the API model as a user message after the tool results, not as base64 text', async t => {
  const { agent, workspace, requests } = fixture(t, [
    [call(0, 'read', 'image_read', { image: 1 })],
    [{ choices: [{ delta: { content: 'A chart.' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }],
  ]);
  const bridge = { tools: [{ name: 'image_read', description: 'Show an image.', inputSchema: { type: 'object', properties: {} } }],
    call: async () => ({ content: [{ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }, { type: 'text', text: 'Image 1' }] }) };
  const result = await agent.run({ provider: 'local', model: 'test', cwd: workspace, prompt: 'Read image 1.', access: 'read-only', bridge,
    signal: new AbortController().signal, approve: async () => true, onEvent: () => {} });
  assert.equal(result.result, 'A chart.');
  const [tool, picture] = requests[1].messages.slice(-2);
  assert.deepEqual(tool, { role: 'tool', tool_call_id: 'read', content: 'Image 1\nThe returned image follows in the next message.' });
  assert.deepEqual(picture, { role: 'user', content: [{ type: 'text', text: 'The images your tool calls returned:' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgo=' } }] });
});

for (const damaged of ['missing', 'corrupt']) test(`API ${damaged} history recovers before inference when Harness supplies its own transcript`, async t => {
  const { agent, workspace, requests } = fixture(t, [[{ choices: [{ delta: { content: 'Recovered.' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }]]);
  fs.mkdirSync(agent.directory, { recursive: true });
  if (damaged === 'corrupt') fs.writeFileSync(path.join(agent.directory, 'lost.json'), '{broken');
  let recovered = 0;
  const result = await agent.run({ provider: 'api', model: 'test', cwd: workspace, prompt: 'Continue', resume: 'lost',
    recoveryPrompt: () => { recovered++; return 'Earlier user request: remember alpha. Earlier answer: alpha. Current user request: Continue'; },
    instructions: 'Current rules', access: 'read-only', signal: new AbortController().signal, onEvent() {} });
  assert.equal(requests.length, 1); assert.notEqual(result.session_id, 'lost');
  assert.equal(recovered, 1);
  assert.match(JSON.stringify(requests[0].messages), /remember alpha/);
  assert.match(requests[0].messages[0].content, /Current rules/);
});

test('an oversized required API recovery fails before inference instead of silently dropping history', async t => {
  const { agent, workspace, requests } = fixture(t, []);
  await assert.rejects(agent.run({ provider: 'api', model: 'test', cwd: workspace, prompt: 'Continue', resume: 'missing',
    recoveryPrompt: () => require('../src/providers/claude.cjs').handoff([{ type: 'agentMessage', text: 'x'.repeat(1000001) }]),
    access: 'read-only', signal: new AbortController().signal, onEvent() {} }), /too large to transfer/);
  assert.equal(requests.length, 0);
});

test('the API loop reads and edits inside the workspace, asks for commands and outside reads, and returns tool results', async t => {
  const { agent, workspace, requests } = fixture(t, outside => [
    [call(0, 'a', 'read_file', { path: 'notes.txt' }), call(1, 'b', 'edit_file', { path: 'notes.txt', old_text: 'beta', new_text: 'gamma' }),
      call(2, 'c', 'run_command', { command: 'node -e "console.log(41 + 1)"' }), call(3, 'd', 'read_file', { path: outside })],
    [{ choices: [{ delta: { content: 'Done.' } }] }],
  ]);
  const approvals = [];
  const result = await run(agent, workspace, 'workspace-write', approvals);

  assert.equal(result.result, 'Done.');
  assert.equal(fs.readFileSync(path.join(workspace, 'notes.txt'), 'utf8'), 'alpha\ngamma\n', 'an edit inside the workspace runs without asking');
  assert.deepEqual(approvals.map(tool => tool.toolName), ['run_command', 'read_file'], 'only the command and the outside read ask');
  const outputs = Object.fromEntries(requests[1].messages.filter(message => message.role === 'tool').map(message => [message.tool_call_id, message.content]));
  assert.match(outputs.a, /1\talpha\n2\tbeta/);
  assert.match(outputs.c, /Exit code 0\n42/);
  assert.match(outputs.d, /declined/);
  assert.doesNotMatch(outputs.d, /private/, 'a declined outside read returns nothing from the file');
  assert.ok(fs.existsSync(path.join(path.dirname(workspace), 'sessions', `${result.session_id}.json`)), 'the chat is saved for the next turn');
});

test('Ask access asks before edits inside the workspace; Full access never asks', async t => {
  const steps = () => [[call(0, 'a', 'edit_file', { path: 'notes.txt', old_text: 'alpha', new_text: 'omega' })], [{ choices: [{ delta: { content: 'ok' } }] }]];
  const ask = fixture(t, steps()), askApprovals = [];
  await run(ask.agent, ask.workspace, 'read-only', askApprovals);
  assert.deepEqual(askApprovals.map(tool => tool.toolName), ['edit_file']);

  const full = fixture(t, steps()), fullApprovals = [];
  await run(full.agent, full.workspace, 'danger-full-access', fullApprovals);
  assert.equal(fullApprovals.length, 0);
  assert.match(fs.readFileSync(path.join(full.workspace, 'notes.txt'), 'utf8'), /omega/);
});

test('approval rules match the Claude and Cursor access table', () => {
  for (const [name, inside, access, expected] of [
    ['read_file', true, 'read-only', false], ['read_file', false, 'workspace-write', true],
    ['edit_file', true, 'read-only', true], ['edit_file', true, 'workspace-write', false], ['write_file', false, 'workspace-write', true],
    ['run_command', true, 'workspace-write', true], ['run_command', true, 'danger-full-access', false],
  ]) assert.equal(needsApproval(name, inside, access), expected, `${name} inside=${inside} ${access}`);
});

test('Codex and CLI choices skip the API structured path, so a Codex Hub never looks up an API provider', async () => {
  const { Providers } = require('../src/providers/providers.cjs');
  const providers = new Providers(os.tmpdir(), null, () => [], async () => { throw new Error('no request expected'); });
  const request = { instructions: 'Reply.', prompt: '{}', schema: { type: 'object' } };
  for (const provider of ['codex', 'claude-cli', 'cursor-cli', 'native:muse'])
    assert.equal(await providers.structured({ provider, model: 'gpt-6.1-sol' }, request, new AbortController().signal), null, provider);
});

test('an unreachable provider says where it looked and what to do next', async () => {
  const { Providers } = require('../src/providers/providers.cjs');
  const refused = async () => { throw new Error('net::ERR_CONNECTION_REFUSED'); };
  for (const [baseUrl, next] of [['http://localhost:1234/v1', /Start it, then click Renew/], ['https://api.deepseek.com/v1', /Check the URL and your connection/]]) {
    const providers = new Providers(os.tmpdir(), null, () => [{ id: 'harness-test-unreachable', name: 'P', baseUrl, enabled: true }], refused);
    await assert.rejects(providers.models('harness-test-unreachable'),
      error => error.message.startsWith(`P is not reachable at ${baseUrl} (net::ERR_CONNECTION_REFUSED).`) && next.test(error.message));
  }
});

test('a follow-up joins the next model call, counts as delivered only then, and keeps a finished answer going', async t => {
  const { agent, workspace, requests } = fixture(t, [
    [call(0, 'a', 'read_file', { path: 'notes.txt' })],
    [{ choices: [{ delta: { content: 'First answer.' } }] }],
    [{ choices: [{ delta: { content: 'Answer with the correction.' } }] }],
  ]);
  let input = null, delivered = [];
  const modelRequest = agent.providers.modelRequest;
  agent.providers.modelRequest = async (choice, body, ...rest) => {
    // While the model writes its final answer, the user sends a correction.
    if (requests.length === 1) input({ id: 'late', text: 'Also mention beta.', images: [] }).then(() => delivered.push('late'));
    return modelRequest(choice, body, ...rest);
  };
  const result = await agent.run({ provider: 'local', model: 'test', cwd: workspace, prompt: 'Read the notes.', access: 'workspace-write',
    signal: new AbortController().signal, approve: async () => true, onEvent: () => {},
    onInput: fn => {
      if (fn && !input) {
        input = fn;
        fn({ id: 'early', text: 'Keep it short.', images: [] }).then(() => delivered.push('early'));
      }
    } });

  assert.equal(result.result, 'Answer with the correction.', 'a correction during the final call gets its own answer');
  const userTexts = request => request.messages.filter(message => message.role === 'user').map(message => message.content);
  assert.deepEqual(userTexts(requests[0]), ['Read the notes.', 'Keep it short.'], 'a follow-up sent before the first call joins it');
  assert.deepEqual(userTexts(requests[2]), ['Read the notes.', 'Keep it short.', 'Also mention beta.']);
  assert.deepEqual(delivered, ['early', 'late']);
  await assert.rejects(input({ id: 'after', text: 'Too late.', images: [] }), /no longer accepting/);
});

test('a follow-up whose model call fails is uncertain, not delivered', async t => {
  const { agent, workspace } = fixture(t, [[call(0, 'a', 'read_file', { path: 'notes.txt' })]]);
  let input = null, delivered = false, calls = 0;
  const modelRequest = agent.providers.modelRequest;
  agent.providers.modelRequest = async (...args) => {
    calls++;
    // The first call runs a tool; the follow-up joins the second call, which fails.
    if (calls === 1) {
      input.sent = input({ id: 'carried', text: 'Also check beta.', images: [] });
      input.sent.then(() => { delivered = true; }, () => {});
      return modelRequest(...args);
    }
    throw new Error('Model unavailable.');
  };
  await assert.rejects(agent.run({ provider: 'local', model: 'test', cwd: workspace, prompt: 'Read the notes.', access: 'workspace-write',
    signal: new AbortController().signal, approve: async () => true, onEvent: () => {}, onInput: fn => { if (fn) input = fn; } }), /Model unavailable/);
  await assert.rejects(input.sent, /closed/);
  assert.equal(delivered, false);
});

test('a follow-up still waiting when the turn fails goes back to Harness instead of being lost', async t => {
  const { agent, workspace } = fixture(t, [[call(0, 'a', 'read_file', { path: 'notes.txt' })]]);
  let input = null;
  agent.providers.modelRequest = async () => {
    const waiting = input({ id: 'queued', text: 'One more thing.', images: [] });
    waiting.catch(() => {});
    input.waiting = waiting;
    throw new Error('Model unavailable.');
  };
  await assert.rejects(agent.run({ provider: 'local', model: 'test', cwd: workspace, prompt: 'Read the notes.', access: 'workspace-write',
    signal: new AbortController().signal, approve: async () => true, onEvent: () => {}, onInput: fn => { if (fn) input = fn; } }), /Model unavailable/);
  await assert.rejects(input.waiting, /ended before this message reached the model/);
});
