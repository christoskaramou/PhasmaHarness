const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ClaudeCLI } = require('../src/providers/claude.cjs');

// Fake Claude process: records args and stdin lines, lets the test script stdout.
function fake() {
  const state = { args: null, input: [], ended: false, child: null };
  const cli = new ClaudeCLI();
  cli.start = args => {
    state.args = args;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => child.emit('close', 1);
    let buffer = '';
    child.stdin.on('data', d => {
      buffer += d;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) { state.input.push(JSON.parse(buffer.slice(0, end))); buffer = buffer.slice(end + 1); child.emit('input'); }
    });
    child.stdin.on('finish', () => { state.ended = true; setImmediate(() => child.emit('close', 0)); });
    state.child = child;
    return child;
  };
  const send = event => state.child.stdout.write(JSON.stringify(event) + '\n');
  const nextInput = () => new Promise(resolve => state.child.once('input', resolve));
  return { cli, state, send, nextInput };
}
const flag = (args, name) => args.includes(name) ? args[args.indexOf(name) + 1] : undefined;

for (const [access, mode] of [['workspace-write', 'acceptEdits'], ['read-only', 'default']]) {
  test(`Claude ${access} asks the Harness for tools outside the pre-approved set`, async () => {
    const { cli, state, send, nextInput } = fake();
    const asked = [];
    const run = cli.run({ model: 'claude-sonnet-5', prompt: 'build it', access, approve: async tool => { asked.push(tool); return asked.length === 1; } });
    await new Promise(setImmediate);
    assert.equal(flag(state.args, '--permission-mode'), mode);
    assert.equal(flag(state.args, '--permission-prompt-tool'), 'stdio');
    assert.equal(flag(state.args, '--disallowedTools'), 'AskUserQuestion,EnterPlanMode,ExitPlanMode', 'no unanswerable interactive prompts');
    assert.match(flag(state.args, '--append-system-prompt'), /wait for the user's approval/);
    if (access === 'read-only') {
      // Reads outside the workspace must ask, so Read is not pre-approved; a small tool set keeps prompts cheap.
      assert.equal(flag(state.args, '--allowedTools'), undefined);
      assert.equal(flag(state.args, '--tools'), 'Read,Glob,Grep,Bash,Edit,Write,WebFetch,WebSearch');
    } else {
      assert.equal(flag(state.args, '--allowedTools'), 'Read,Glob,Grep');
      assert.equal(state.args.includes('--tools'), false, 'Workspace keeps the tool set it had before');
    }
    assert.equal(state.input[0].type, 'user');
    assert.equal(state.ended, false, 'stdin stays open for approval answers');

    let answered = nextInput();
    send({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', tool_use_id: 't1', input: { command: 'ninja -C build' } } });
    await answered;
    assert.deepEqual(asked[0], { title: 'Allow Claude to use Bash?', rawInput: { tool: 'Bash', command: 'ninja -C build' } });
    assert.deepEqual(state.input[1], { type: 'control_response', response: { request_id: 'r1', subtype: 'success',
      response: { behavior: 'allow', updatedInput: { command: 'ninja -C build' }, toolUseID: 't1' } } });

    answered = nextInput();
    send({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'WebFetch', tool_use_id: 't2', input: { url: 'https://example.com' } } });
    await answered;
    assert.equal(state.input[2].response.response.behavior, 'deny');
    assert.equal(state.input[2].response.response.toolUseID, 't2');

    answered = nextInput();
    send({ type: 'control_request', request_id: 'r3', request: { subtype: 'hook_callback' } });
    await answered;
    assert.equal(state.input[3].response.subtype, 'error', 'unknown requests are answered, never left hanging');

    send({ type: 'result', result: 'done' });
    assert.equal((await run).result, 'done');
    assert.equal(state.ended, true);
  });
}

test('Claude keeps the previous non-interactive permissions without an approval callback, for classifiers and full access', async () => {
  const cases = [
    [{ access: 'workspace-write' }, 'dontAsk', f => assert.equal(flag(f, '--allowedTools'), 'Read,Glob,Grep,Edit,Write')],
    [{ access: 'read-only' }, 'dontAsk', f => assert.equal(flag(f, '--tools'), 'Read,Glob,Grep')],
    [{ access: 'workspace-write', approve: async () => true, schema: { type: 'object' } }, 'dontAsk', f => assert.equal(flag(f, '--tools'), '')],
    [{ access: 'danger-full-access', approve: async () => true }, 'bypassPermissions', () => {}],
  ];
  for (const [options, mode, check] of cases) {
    const { cli, state, send } = fake();
    const run = cli.run({ model: 'claude-haiku-4-5', prompt: 'x', ...options });
    await new Promise(setImmediate);
    assert.equal(flag(state.args, '--permission-mode'), mode);
    assert.equal(state.args.includes('--permission-prompt-tool'), false);
    assert.equal(state.ended, true);
    check(state.args);
    send({ type: 'result', result: 'ok' });
    await run;
  }
});

test('Claude passes a supported effort level and ignores anything else', async () => {
  for (const [effort, expected] of [['high', 'high'], ['max', 'max'], [null, undefined], ['ultra', undefined], ['--dangerous', undefined]]) {
    const { cli, state, send } = fake();
    const run = cli.run({ model: 'claude-opus-5-5', effort, prompt: 'x', access: 'danger-full-access' });
    await new Promise(setImmediate);
    assert.equal(flag(state.args, '--effort'), expected);
    send({ type: 'result', result: 'ok' });
    await run;
  }
});

test('stopping during a pending approval stops Claude and declines the request', async () => {
  const { cli, state, send } = fake();
  const abort = new AbortController();
  let release;
  const run = cli.run({ model: 'claude-sonnet-5', prompt: 'x', access: 'workspace-write', signal: abort.signal,
    approve: () => new Promise(resolve => { release = resolve; }) });
  await new Promise(setImmediate);
  send({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'x' } } });
  await new Promise(setImmediate);
  abort.abort();
  await assert.rejects(run, /Claude stopped/);
  release(true);
  await new Promise(setImmediate);
  assert.equal(state.input.length, 1, 'no allow is sent after stopping');
});

test('Claude read-only passes helper tools as both available and pre-approved; the write helper stays out', async () => {
  const { cli, state, send } = fake();
  const helpers = { allowedTools: access => access === 'read-only' ? ['mcp__h__read'] : ['mcp__h__read', 'mcp__h__call'], instructions: '' };
  const run = cli.run({ model: 'm', prompt: 'x', access: 'read-only', helpers, approve: async () => true });
  await new Promise(setImmediate);
  assert.equal(flag(state.args, '--tools'), 'Read,Glob,Grep,Bash,Edit,Write,WebFetch,WebSearch,mcp__h__read');
  assert.equal(flag(state.args, '--allowedTools'), 'mcp__h__read');
  send({ type: 'result', result: 'ok' });
  await run;
});

test('a Claude cancel withdraws its approval, and events after the run settles are ignored', async () => {
  const { cli, state, send, nextInput } = fake();
  const signals = [];
  let asks = 0;
  const run = cli.run({ model: 'm', prompt: 'x', access: 'workspace-write',
    approve: (tool, options) => { asks++; signals.push(options.signal); return new Promise(resolve => options.signal.addEventListener('abort', () => resolve(false))); } });
  await new Promise(setImmediate);
  send({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'x' } } });
  await new Promise(setImmediate);
  send({ type: 'control_cancel_request', request_id: 'r1' });
  await new Promise(setImmediate);
  assert.equal(signals[0].aborted, true, 'the Harness prompt is withdrawn');
  assert.equal(state.input.length, 1, 'no answer is written for a cancelled request');
  state.child.stdout.write('not json\n');
  await assert.rejects(run, /Invalid Claude Code stream event/);
  state.child.stdout.write(JSON.stringify({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: {} } }) + '\n');
  await new Promise(setImmediate);
  assert.equal(asks, 1, 'no approval is requested after the run has settled');
});
