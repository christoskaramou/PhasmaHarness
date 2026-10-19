const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ClaudeCLI } = require('../src/providers/claude.cjs');

function fixture(response, { malformed = false, cleanupBlocked = false } = {}) {
  const requests = [], children = [], launches = [];
  let blocked = cleanupBlocked;
  const cli = new ClaudeCLI((file, args, options) => {
    launches.push({ file, args, options });
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
      kill() { this.exitCode = 0; this.emit('exit', 0); this.emit('close', 0); } });
    children.push(child);
    child.stdin.on('data', data => {
      const request = JSON.parse(data.toString()); requests.push(request);
      process.nextTick(() => {
        const message = request.request_id === 'quota-init'
          ? { type: 'control_response', response: { request_id: 'quota-init', subtype: 'success', response: {} } }
          : { type: 'control_response', response: { request_id: 'quota-read', ...response } };
        const output = malformed ? '{bad json\n' : JSON.stringify(message) + '\n';
        child.stdout.write(output.slice(0, 20)); child.stdout.write(output.slice(20));
      });
    });
    return child;
  }, async child => {
    if (blocked === 'throw') throw new Error('Lookup failed');
    if (blocked) return [-1];
    child.kill(); return [];
  });
  return { cli, requests, children, launches, unblock: () => { blocked = false; } };
}

test('Claude usage metadata uses only native control requests, disables tools/hooks/MCP, skips transcript scans and confirms cleanup', async () => {
  const report = { rate_limits_available: true, subscription_type: 'max', rate_limits: { seven_day: { utilization: 92, resets_at: '2026-10-25T09:00:00Z' } } };
  const { cli, requests, launches, children } = fixture({ subtype: 'success', response: report });
  assert.deepEqual(await cli.readUsage(), report);
  assert.deepEqual(requests.map(request => request.request.subtype), ['initialize', 'get_usage']);
  assert.equal(requests[1].request.skip_behaviors, true);
  assert.ok(requests.every(request => request.type === 'control_request'));
  assert.equal(launches[0].options.windowsHide, true);
  for (const flag of ['--no-session-persistence', '--strict-mcp-config']) assert.ok(launches[0].args.includes(flag));
  assert.equal(launches[0].args[launches[0].args.indexOf('--tools') + 1], '');
  assert.deepEqual(JSON.parse(launches[0].args[launches[0].args.indexOf('--mcp-config') + 1]), { mcpServers: {} });
  assert.equal(children[0].exitCode, 0);
  assert.equal(cli.children.size, 0);
});

test('Claude usage preserves unavailable reports, rejects unsupported or malformed metadata and retains uncertain cleanup for retry', async () => {
  const absent = fixture({ subtype: 'success', response: { rate_limits_available: false, rate_limits: null } });
  assert.equal((await absent.cli.readUsage()).rate_limits_available, false);
  const unsupported = fixture({ subtype: 'error', error: 'Not supported' });
  await assert.rejects(unsupported.cli.readUsage(), /did not provide/);
  const invalid = fixture({}, { malformed: true });
  await assert.rejects(invalid.cli.readUsage(), /invalid event/);
  const blocked = fixture({ subtype: 'success', response: { rate_limits_available: false } }, { cleanupBlocked: true });
  await assert.rejects(blocked.cli.readUsage(), { code: 'CLEANUP_UNCERTAIN' });
  await assert.rejects(blocked.cli.readUsage(), { code: 'CLEANUP_UNCERTAIN' });
  assert.equal(blocked.launches.length, 1, 'unconfirmed cleanup cannot start another metadata process');
  blocked.unblock();
  await blocked.cli.readUsage();
  assert.equal(blocked.launches.length, 2);
  assert.equal(blocked.cli.children.size, 0);
  const failed = fixture({ subtype: 'success', response: {} }, { cleanupBlocked: 'throw' });
  await assert.rejects(failed.cli.readUsage(), { code: 'CLEANUP_UNCERTAIN' });
  await assert.rejects(failed.cli.readUsage(), { code: 'CLEANUP_UNCERTAIN' });
  assert.equal(failed.launches.length, 1);
  failed.unblock(); await failed.cli.readUsage();
});

test('Claude allowance identity follows native auth metadata without exposing it as the key', () => {
  const { cli } = fixture({});
  assert.equal(cli.accountKey(), null);
  cli.status = { loggedIn: true, authMethod: 'claude.ai', email: 'fixture@invalid', subscriptionType: 'max' };
  const first = cli.accountKey();
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.doesNotMatch(first, /fixture/);
  cli.status.authMethod = 'api_key';
  assert.notEqual(cli.accountKey(), first);
});

test('native streaming allowance changes invalidate the metadata cache without replacing the model result', async () => {
  const cli = new ClaudeCLI();
  let changes = 0;
  cli.onUsageChange = () => { changes++; };
  cli.start = () => {
    const child = new EventEmitter();
    Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin.on('data', () => process.nextTick(() => {
      child.stdout.write(JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed_warning', utilization: 0.92, rateLimitType: 'seven_day' } }) + '\n');
      child.stdout.write(JSON.stringify({ type: 'result', result: 'Unchanged fixture result.' }) + '\n');
      child.emit('close', 0);
    }));
    return child;
  };
  const result = await cli.run({ model: 'fixture', prompt: 'Fixture prompt.', access: 'danger-full-access', signal: new AbortController().signal });
  assert.equal(changes, 1);
  assert.equal(result.result, 'Unchanged fixture result.');
});
