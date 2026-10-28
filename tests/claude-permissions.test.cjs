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

test('Claude Main continuations persist and resume while retaining the tool-free contract', async () => {
  const { cli, state, send } = fake();
  const run = cli.run({ model: 'test', prompt: 'Continue.', schema: { type: 'object' }, resume: 'kept-main', persistSession: true });
  await new Promise(setImmediate);
  assert.equal(flag(state.args, '--resume'), 'kept-main');
  assert.equal(state.args.includes('--no-session-persistence'), false);
  assert.equal(flag(state.args, '--tools'), '');
  assert.equal(flag(state.args, '--permission-mode'), 'dontAsk');
  assert.equal(flag(state.args, '--mcp-config'), '{"mcpServers":{}}');
  send({ type: 'result', result: '{}' }); await run;
});

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
    assert.deepEqual(asked[0], { title: 'Allow Claude to use Bash?', rawInput: { tool: 'Bash', command: 'ninja -C build' },
      toolName: 'Bash', input: { command: 'ninja -C build' }, blockedPath: undefined });
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

test('Claude usage limits: a blocked reply or a rejected window is a limit, unless extra usage covers it', async () => {
  const outcome = async events => {
    const { cli, state, send } = fake();
    const run = cli.run({ model: 'claude-opus-5-5', prompt: 'x', access: 'workspace-write', approve: async () => false });
    await new Promise(setImmediate);
    for (const event of events) send(event);
    await new Promise(setImmediate);
    state.child.emit('close', 1);
    return run.then(() => null, error => error);
  };
  const failed = { type: 'result', is_error: true, result: "You've hit your limit · resets 5pm" };
  const weekly = await outcome([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 2000000000, rateLimitType: 'seven_day_opus' } }, failed]);
  assert.match(weekly.message, /hit your limit/);
  assert.deepEqual(weekly.limit, { until: 2000000000000, reason: weekly.message, type: 'seven_day_opus', family: 'opus' });
  const session = await outcome([{ type: 'assistant', error: 'rate_limit', message: { content: [] } }, failed]);
  assert.equal(session.limit.family, null, 'a session window limits all of Claude');
  const overage = await outcome([{ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType: 'five_hour', isUsingOverage: true, overageStatus: 'allowed' } },
    { type: 'result', is_error: true, subtype: 'error_max_turns', errors: ['Reached the maximum number of turns'] }]);
  assert.equal(overage.limit, undefined, 'another failure while extra usage covers the window is not a usage limit');
});


test('Claude streams follow-ups during full-access work and waits for acknowledgement before closing', async () => {
  const { cli, state, send } = fake();
  let input;
  const run = cli.run({ model: 'claude-opus-5-5', prompt: 'first', access: 'danger-full-access',
    onInput: value => { input = value; } });
  assert.equal(state.ended, false);
  assert.ok(state.args.includes('--replay-user-messages'));
  let accepted = false;
  const delivery = input({ id: 'follow-up', text: 'correct this', images: [] }).then(() => { accepted = true; });
  assert.equal(state.input[1].uuid, 'follow-up');
  assert.equal(state.input[1].message.content[0].text, 'correct this');
  send({ type: 'result', result: 'first finished' });
  assert.equal(state.ended, false, 'an unacknowledged input keeps the pipe open');
  assert.equal(accepted, false);
  send({ type: 'user', uuid: 'follow-up', message: { role: 'user', content: [{ type: 'text', text: 'correct this' }] } });
  await delivery;
  send({ type: 'result', result: 'corrected' });
  assert.equal((await run).result, 'corrected');
  assert.equal(input, null);
});

test('several Claude results in one process add their usage but keep the last running cost and model totals', async () => {
  const { cli, send } = fake();
  let input;
  const run = cli.run({ model: 'claude-opus-5-5', prompt: 'first', access: 'danger-full-access',
    onInput: value => { input = value; } });
  const delivery = input({ id: 'follow-up', text: 'Reply with only: OK', images: [] });
  // Real numbers (Opus 5.5, 2026-10-28): usage is per result, total_cost_usd and modelUsage are the session's running totals.
  send({ type: 'result', result: 'first finished', total_cost_usd: 0.46631159999999994,
    usage: { input_tokens: 20, cache_read_input_tokens: 309258, cache_creation_input_tokens: 28825, output_tokens: 8689 },
    modelUsage: { 'claude-opus-5-5': { inputTokens: 20, cacheReadInputTokens: 309258, cacheCreationInputTokens: 28825, outputTokens: 8689 } } });
  send({ type: 'user', uuid: 'follow-up', message: { role: 'user', content: [{ type: 'text', text: 'Reply with only: OK' }] } });
  await delivery;
  const last = { 'claude-opus-5-5': { inputTokens: 22, cacheReadInputTokens: 325822, cacheCreationInputTokens: 62833, outputTokens: 8693 } };
  send({ type: 'result', result: 'OK', total_cost_usd: 0.7417763999999999, modelUsage: last,
    usage: { input_tokens: 2, cache_read_input_tokens: 16564, cache_creation_input_tokens: 34008, output_tokens: 4 } });
  const result = await run;
  assert.deepEqual(result.usage, { input_tokens: 22, cache_read_input_tokens: 325822, cache_creation_input_tokens: 62833, output_tokens: 8693 });
  assert.equal(result.total_cost_usd, 0.7417763999999999);
  assert.deepEqual(result.modelUsage, last);
});

test('a live follow-up Claude never echoes times out without keeping a finished turn open', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { cli, state, send } = fake();
  let input;
  const run = cli.run({ model: 'claude-opus-5-5', prompt: 'first', access: 'danger-full-access',
    onInput: value => { input = value; } });
  const delivery = input({ id: 'never-echoed', text: 'one more thing', images: [] });
  const timedOut = assert.rejects(delivery, /timed out/);
  send({ type: 'result', result: 'first finished' });
  await new Promise(setImmediate);
  assert.equal(state.ended, false, 'the pending follow-up keeps the pipe open at first');
  t.mock.timers.tick(30000);
  await timedOut;
  await new Promise(setImmediate);
  assert.equal(state.ended, true, 'the turn closes Claude input once the follow-up is given up');
  assert.equal(input, null);
  assert.equal((await run).result, 'first finished');
});

// 2026-10-28: a bot's background "wait until Dota closes" command kept Claude alive after its answer; Harness had closed
// its input at the result, so the chat stayed busy for an hour and Send now could not reach Claude.
test('Claude takes follow-ups while a background task runs after its result and closes input when the task ends', async () => {
  const { cli, state, send } = fake();
  let input;
  const run = cli.run({ model: 'claude-opus-5-5', prompt: 'wait for it', access: 'danger-full-access',
    onInput: value => { input = value; } });
  const watcher = { task_id: 'w', task_type: 'local_bash', description: 'CLI watcher', ambient: true };
  send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'wait' }, watcher] });
  send({ type: 'result', result: 'started' });
  await new Promise(setImmediate);
  assert.equal(state.ended, false, 'the running task keeps Claude input open after the result');
  assert.equal(typeof input, 'function', 'follow-ups still go straight to Claude');

  const delivery = input({ id: 'status', text: 'status', images: [] });
  send({ type: 'user', uuid: 'status', message: { role: 'user', content: [{ type: 'text', text: 'status' }] } });
  await delivery;
  send({ type: 'result', result: 'still waiting' });
  await new Promise(setImmediate);
  assert.equal(state.ended, false, 'the answered follow-up leaves input open while the task runs');

  send({ type: 'system', subtype: 'background_tasks_changed', tasks: [watcher] });
  await new Promise(setImmediate);
  assert.equal(state.ended, true, 'input closes once only ambient tasks remain');
  assert.equal(input, null);
  assert.equal((await run).result, 'still waiting');
});

test('a background task that ends while Claude answers a follow-up keeps input open until that answer', async () => {
  const { cli, state, send } = fake();
  let input;
  const run = cli.run({ model: 'claude-opus-5-5', prompt: 'wait for it', access: 'danger-full-access',
    onInput: value => { input = value; } });
  send({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', task_type: 'local_bash', description: 'wait' }] });
  send({ type: 'result', result: 'started' });
  const delivery = input({ id: 'status', text: 'status', images: [] });
  send({ type: 'user', uuid: 'status', message: { role: 'user', content: [{ type: 'text', text: 'status' }] } });
  await delivery;

  send({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
  await new Promise(setImmediate);
  assert.equal(state.ended, false, 'Claude is still answering the follow-up');

  send({ type: 'result', result: 'answered' });
  await new Promise(setImmediate);
  assert.equal(state.ended, true);
  assert.equal((await run).result, 'answered');
});

test('Harness asks the running Claude for a task’s output and to stop it, matching each answer by request id', async () => {
  const { cli, state, send } = fake();
  let control;
  const run = cli.run({ model: 'claude-opus-5-5', prompt: 'wait for it', access: 'danger-full-access',
    onInput: (value, request) => { control = value ? request : null; } });
  const output = control({ subtype: 'get_task_output', task_id: 'b1' });
  const stop = control({ subtype: 'stop_task', task_id: 'gone' });
  const [read, stopped] = state.input.slice(1);
  assert.deepEqual(read.request, { subtype: 'get_task_output', task_id: 'b1' });
  assert.equal(read.type, 'control_request');
  assert.notEqual(read.request_id, stopped.request_id);

  send({ type: 'control_response', response: { request_id: stopped.request_id, subtype: 'error', error: 'No task gone' } });
  send({ type: 'control_response', response: { request_id: read.request_id, subtype: 'success', response: { output: 'tick\n', total_bytes: 5, truncated: false } } });
  assert.deepEqual(await output, { output: 'tick\n', total_bytes: 5, truncated: false });
  await assert.rejects(stop, /No task gone/);

  const pending = control({ subtype: 'stop_task', task_id: 'b2' });
  send({ type: 'result', result: 'done' });
  await assert.rejects(pending, /closed before answering|no longer accepting/);
  assert.equal((await run).result, 'done');
  assert.equal(control, null);
});

test('Claude retains uncertainty when its process closes before acknowledging live input', async () => {
  const { cli, state } = fake();
  let input;
  const run = cli.run({ model: 'claude-opus-5-5', prompt: 'first', access: 'danger-full-access',
    onInput: value => { input = value; } });
  const delivery = input({ id: 'follow-up', text: 'correction' });
  const failedDelivery = assert.rejects(delivery, /closed before confirming/);
  const failedRun = assert.rejects(run);
  state.child.emit('close', 1);
  await Promise.all([failedDelivery, failedRun]);
  assert.equal(input, null);
});
