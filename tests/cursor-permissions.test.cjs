const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CursorCLI } = require('../src/providers/cursor.cjs');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

test('Cursor surfaces only correlated native child metadata and status-only reasoning episodes', async t => {
  const cursor = new CursorCLI(), events = [];
  t.after(() => cursor.close());
  cursor.connect = ({ onUpdate, onRequest }) => ({ close() {}, call: async (method, params) => {
    if (method === 'initialize') {
      assert.deepEqual(params.clientCapabilities, { fs: { readTextFile: false, writeTextFile: false }, terminal: false, _meta: { subagents: true } });
    }
    if (method === 'session/new') return { sessionId: 'parent' };
    if (method === 'session/prompt') {
      const send = (sessionId, sessionUpdate, fields) => onUpdate({ sessionId, update: { sessionUpdate, ...fields } });
      const thought = { content: { type: 'text', text: 'private' } };
      send('foreign', 'subagent_spawned', { subagentSessionId: 'stray' });
      send('parent', 'subagent_spawned', { subagentSessionId: 'child', name: 'Reviewer', task: 'Check imports',
        _meta: { cursor: { agentId: 'worker', model: 'model-x', toolCallId: 'task-1' } } });
      send('child', 'subagent_spawned', { subagentSessionId: 'nested', name: 'Nested' });
      await onRequest('cursor/task', { toolCallId: 'task-1', subagentType: { custom: 'auditor' }, description: 'Inspect dependencies', durationMs: 1200, prompt: 'private' });
      send('parent', 'plan', { entries: [{ status: 'in_progress', content: 'Review imports', priority: 'high' }] });
      send('parent', 'tool_call', { toolCallId: 'todo-1', title: 'Update Todos' });
      await onRequest('cursor/update_todos', { toolCallId: 'todo-1', todos: [{ id: 'i', content: 'Inspect files', status: 'pending' }], merge: false });
      await onRequest('cursor/update_todos', { toolCallId: 'todo-1', todos: [{ id: 'j', content: 'Test imports', status: 'completed' }], merge: true });
      await onRequest('cursor/update_todos', { toolCallId: 'foreign', todos: [{ id: 'k', content: 'stray', status: 'pending' }] });
      send('parent', 'tool_call', { toolCallId: 'plan-1', title: 'Create Plan: Imports' });
      send('parent', 'tool_call_update', { toolCallId: 'plan-1', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'Creating plan file...' } }] });
      send('parent', 'tool_call_update', { toolCallId: 'todo-1', status: 'in_progress', content: [{ type: 'content', content: { type: 'text', text: 'private-tool-output' } }] });
      send('child', 'agent_message_chunk', thought);
      send('parent', 'agent_thought_chunk', thought);
      send('parent', 'agent_thought_chunk', thought);
      send('parent', 'agent_message_chunk', { content: { type: 'text', text: 'Answer' } });
      send('parent', 'agent_thought_chunk', thought);
      send('parent', 'subagent_state_update', { subagentSessionId: 'child', state: 'completed' });
      send('child', 'agent_thought_chunk', thought); // A finished native run cannot start another episode.
      return { stopReason: 'end_turn' };
    }
    return {};
  } });
  const result = await cursor.run({ model: 'm', prompt: 'x', onEvent: event => events.push(event) });
  assert.equal(result.result, 'Answer');
  assert.doesNotMatch(JSON.stringify(events), /private|stray/);
  const children = events.filter(event => event.kind === 'agent');
  assert.equal(children[0].id, children.at(-1).id);
  assert.equal(children.at(-1).status, 'completed');
  assert.match(children.at(-1).text, /Duration: 1200 ms/);
  for (const value of ['Check imports', 'worker', 'model-x', 'auditor', 'Inspect dependencies']) assert.ok(children.at(-1).text.includes(value), value);
  assert.match(children.find(event => event.title === 'Nested').text, /Reviewer/);
  const progress = events.filter(event => event.kind === 'progress');
  assert.match(progress[0].text, /in_progress.*high.*Review imports/);
  assert.equal(progress[1].id, progress[2].id);
  assert.match(progress[2].text, /Inspect files[\s\S]*Test imports/);
  assert.equal(progress[3].text, 'Creating plan file...');
  const reasoning = events.filter(event => event.kind === 'reasoning');
  assert.deepEqual(reasoning.map(event => event.text), ['', '']);
  assert.notEqual(reasoning[0].id, reasoning[1].id);
});

test('Cursor Main resumes with no repeated schema while validation and tool denial stay enabled', async () => {
  const cursor = new CursorCLI(), sent = [], schema = { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] };
  cursor.connect = options => {
    assert.equal(options.noTools, true);
    return { close() {}, call: async (method, params) => {
      if (method === 'initialize') return { agentCapabilities: {} };
      if (method === 'session/load') { assert.equal(params.sessionId, 'kept'); return { sessionId: 'kept' }; }
      if (method === 'session/new') return { sessionId: 'kept' };
      if (method === 'session/prompt') {
        sent.push(params.prompt[0].text);
        options.onUpdate({ sessionId: 'kept', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '{"reply":"ok"}' } } });
        return { stopReason: 'end_turn' };
      }
      return {};
    } };
  };
  await cursor.run({ model: 'test', prompt: 'First', schema });
  const result = await cursor.run({ model: 'test', prompt: 'Next', schema, resume: 'kept', schemaInHistory: true });
  assert.deepEqual(JSON.parse(result.result), { reply: 'ok' });
  assert.match(sent[0], /Return only JSON/);
  assert.equal(sent[1], 'Next');
});

test('Cursor structured connections use private read/write/command denials without changing worker settings', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-review-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = path.join(root, '.cursor'); fs.mkdirSync(original);
  fs.writeFileSync(path.join(original, 'hooks.json'), '{"user":"preserved"}');
  const launched = [];
  const cursor = new CursorCLI((_args, cwd) => {
    launched.push(cwd);
    return Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { this.exitCode = 0; this.emit('exit', 0); this.emit('close', 0); } });
  });
  const review = cursor.connect({ cwd: root, noTools: true });
  assert.equal(review.cwd, path.join(root, 'cursor-review'));
  assert.equal(launched[0], review.cwd);
  const settings = JSON.parse(fs.readFileSync(path.join(review.cwd, '.cursor/cli.json'), 'utf8'));
  assert.deepEqual(settings.permissions.allow, []);
  assert.ok(settings.permissions.deny.includes('Read(**)'));
  assert.ok(settings.permissions.deny.includes('Write(**)'));
  assert.ok(settings.permissions.deny.includes('Shell(*)'));
  assert.equal(fs.existsSync(path.join(review.cwd, '.cursor/hooks.json')), false, 'do not rely on unverified ACP hook enforcement');
  review.close();
  const worker = cursor.connect({ cwd: root });
  assert.equal(worker.cwd, root);
  assert.equal(fs.readFileSync(path.join(original, 'hooks.json'), 'utf8'), '{"user":"preserved"}');
  assert.equal(fs.existsSync(path.join(original, 'cli.json')), false);
  worker.close();
});

test('a Cursor structured review that attempts a tool is cancelled before its answer can be accepted', async () => {
  const cursor = new CursorCLI();
  let stopped = false, rejectPrompt;
  cursor.connect = ({ onUpdate }) => ({ call: async method => {
    if (method === 'session/new') return { sessionId: 's' };
    if (method !== 'session/prompt') return {};
    return new Promise((_resolve, reject) => {
      rejectPrompt = reject;
      queueMicrotask(() => onUpdate({ sessionId: 's', update: { sessionUpdate: 'tool_call', title: 'Grep' } }));
    });
  }, close() { stopped = true; rejectPrompt?.(new Error('Connection closed')); } });
  await assert.rejects(cursor.run({ model: 'm', prompt: 'Review only the report.', schema: {} }), { code: 'INVALID_STRUCTURED_RESPONSE' });
  assert.equal(stopped, true);
});

// Replace the ACP transport; capture the permission handler run() installs and answer one request with it.
async function decide({ access, schema, approve }) {
  const cursor = new CursorCLI();
  let onRequest, result;
  const ask = () => onRequest('session/request_permission', {
    toolCall: { title: 'Run ninja' },
    options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
  });
  cursor.connect = options => {
    onRequest = options.onRequest;
    return { call: async (method) => {
      if (method === 'session/new') return { sessionId: 's' };
      // Cursor asks while the prompt runs.
      if (method === 'session/prompt') { result = await ask(); return { stopReason: 'end_turn' }; }
      return {};
    }, close() {} };
  };
  await cursor.run({ model: 'm', prompt: 'x', access, schema, approve });
  // After the turn the connection may be parked for the next one; it approves nothing.
  assert.deepEqual(await ask(), { outcome: 'cancelled' });
  return { choice: result.outcome.optionId };
}

test('Cursor asks the Harness in Ask and Workspace access, auto-allows only Full access, and never gives classifiers tools', async () => {
  for (const access of ['read-only', 'workspace-write']) {
    const asked = [];
    const approve = async tool => { asked.push(tool); return asked.length === 1; };
    assert.equal((await decide({ access, approve })).choice, 'yes');
    assert.deepEqual(asked, [{ title: 'Run ninja' }], `${access} asks the user`);
    assert.equal((await decide({ access, approve: async () => false })).choice, 'no');
  }
  let askedFull = false;
  assert.equal((await decide({ access: 'danger-full-access', approve: async () => { askedFull = true; return false; } })).choice, 'yes');
  assert.equal(askedFull, false);
  let askedClassifier = false;
  assert.equal((await decide({ access: 'danger-full-access', schema: { type: 'object' }, approve: async () => { askedClassifier = true; return true; } })).choice, 'no');
  assert.equal(askedClassifier, false);
  assert.equal((await decide({ access: 'read-only' })).choice, 'no', 'no approval callback means decline');
});

test('Cursor reports activity only for nonempty answer or reasoning chunks in its active prompt', async () => {
  const cursor = new CursorCLI();
  let activity = 0;
  cursor.connect = ({ onUpdate, noTools }) => ({
    cwd: 'private-review-workspace',
    call: async (method, params) => {
      const chunk = (sessionId, sessionUpdate, text) => onUpdate({ sessionId, update: { sessionUpdate, content: { type: 'text', text } } });
      if (method === 'session/new') {
        assert.equal(noTools, true);
        assert.equal(params.cwd, 'private-review-workspace');
        chunk('s', 'agent_thought_chunk', 'before prompt'); return { sessionId: 's' };
      }
      if (method !== 'session/prompt') return {};
      chunk('different', 'agent_thought_chunk', 'another session');
      chunk('s', 'agent_thought_chunk', '');
      chunk('s', 'session_info_update', 'heartbeat');
      assert.equal(activity, 0);
      chunk('s', 'agent_thought_chunk', 'reasoning');
      chunk('s', 'agent_message_chunk', '{}');
      assert.equal(activity, 2);
      return { stopReason: 'end_turn' };
    }, close() {},
  });
  const result = await cursor.run({ model: 'm', prompt: 'Review the report.', schema: {}, onActivity: () => activity++ });
  assert.equal(result.result, '{}', 'reasoning stays out of the JSON result');
});

// A fake ACP transport whose first prompt waits until session/cancel, like Cursor, and records what was sent.
function steerable() {
  const cursor = new CursorCLI(), prompts = [], notes = [];
  let onRequest, cancel;
  cursor.connect = options => {
    onRequest = options.onRequest;
    return {
      child: null,
      notify: (method, params) => { notes.push([method, params]); if (method === 'session/cancel') cancel?.(); },
      call: async (method, params) => {
        if (method === 'session/new') return { sessionId: 's' };
        if (method !== 'session/prompt') return {};
        prompts.push(params);
        if (prompts.length === 1) return new Promise(resolve => { cancel = () => resolve({ stopReason: 'cancelled' }); });
        return { stopReason: 'end_turn' };
      },
      close() {},
    };
  };
  return { cursor, prompts, notes, request: (...args) => onRequest(...args) };
}

test('Send now cancels the Cursor step and prompts again in the same session; a plain follow-up is refused', async () => {
  const { cursor, prompts, notes } = steerable();
  let input = null;
  const running = cursor.run({ model: 'm', prompt: 'Build it.', access: 'workspace-write', onInput: fn => { if (fn) input = fn; } });
  for (let i = 0; i < 200 && !(input && prompts.length); i++) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(input({ id: 'q', text: 'Later.', images: [] }, { steer: false }), /one prompt at a time/);
  await input({ id: 'now', text: 'Use the new requirement.', images: [] }, { steer: true });
  await running;
  assert.deepEqual(notes, [['session/cancel', { sessionId: 's' }]]);
  assert.deepEqual(prompts.map(params => params.sessionId), ['s', 's']);
  assert.equal(prompts[1].prompt[0].text, 'Use the new requirement.');
  await assert.rejects(input({ id: 'late', text: 'Too late.', images: [] }, { steer: true }), /no longer accepting/);
});

test('a Stop while Cursor Send now is still cancelling the step never sends the message', async () => {
  const cursor = new CursorCLI(), prompts = [];
  let failFirst;
  // Like the real connection: Stop closes it and fails the pending prompt; session/cancel alone does not end the step.
  cursor.connect = () => ({
    child: null,
    notify: () => {},
    call: async (method, params) => {
      if (method === 'session/new') return { sessionId: 's' };
      if (method !== 'session/prompt') return {};
      prompts.push(params);
      if (prompts.length === 1) return new Promise((_, reject) => { failFirst = reject; });
      return { stopReason: 'end_turn' };
    },
    close() { failFirst?.(new Error('Cursor connection closed.')); },
  });
  const abort = new AbortController();
  let input = null;
  const running = cursor.run({ model: 'm', prompt: 'Build it.', access: 'workspace-write', signal: abort.signal,
    onInput: fn => { if (fn) input = fn; } });
  for (let i = 0; i < 200 && !(input && prompts.length); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const sent = input({ id: 'now', text: 'Use the new requirement.', images: [] }, { steer: true });
  const refused = assert.rejects(sent, /stopped before the message was sent/);
  await new Promise(resolve => setTimeout(resolve, 20));
  abort.abort();
  await refused;
  await assert.rejects(running);
  assert.equal(prompts.length, 1, 'nothing is sent on the closing connection');
});

test('an Allow answered after Cursor Send now does not approve anything', async () => {
  const { cursor, prompts, request } = steerable();
  let input = null, answer;
  const running = cursor.run({ model: 'm', prompt: 'Build it.', access: 'workspace-write', onInput: fn => { if (fn) input = fn; },
    approve: () => new Promise(resolve => { answer = resolve; }) });
  for (let i = 0; i < 200 && !(input && prompts.length); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const asked = request('session/request_permission', { toolCall: { title: 'Run ninja' },
    options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] });
  await input({ id: 'now', text: 'Change course.', images: [] }, { steer: true });
  answer(true);
  assert.equal((await asked).outcome.optionId, 'no', 'the old step’s approval was withdrawn by Send now');
  await running;
});
