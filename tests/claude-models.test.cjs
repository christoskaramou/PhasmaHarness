const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ClaudeCLI } = require('../src/providers/claude.cjs');

test('Claude discovers versioned models without inference, deduplicates aliases and preserves context variants', async () => {
  let requests = [], args, killed = 0;
  const cli = new ClaudeCLI((_file, options) => {
    args = options;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    child.kill = () => { killed++; child.emit('close', 0); };
    child.stdin.on('data', data => {
      requests.push(JSON.parse(data));
      const payload = JSON.stringify({ type: 'control_response', response: { request_id: 'models', response: { models: [
        { value: 'default', resolvedModel: 'claude-opus-5[1m]' },
        { value: 'opus[1m]', resolvedModel: 'claude-opus-5[1m]' },
        { value: 'claude-fable-5-1[1m]', resolvedModel: 'claude-fable-5-1' },
        { value: 'haiku', resolvedModel: 'claude-haiku-4-5' },
      ] } } }) + '\n';
      process.nextTick(() => { child.stdout.write(payload.slice(0, 30)); child.stdout.write(payload.slice(30)); });
    });
    return child;
  });
  const models = await cli.discover();
  assert.deepEqual(models.map(m => m.model), ['claude-opus-5[1m]', 'claude-fable-5-1[1m]', 'claude-haiku-4-5']);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.subtype, 'initialize');
  assert.ok(args.includes('--no-session-persistence'));
  assert.ok(args.includes('--strict-mcp-config'));
  assert.equal(killed, 1);
  assert.equal(cli.models, models);
});

test('Claude refresh keeps authentication on discovery failure, and clears models on logout', async () => {
  const cli = new ClaudeCLI();
  cli.command = async () => JSON.stringify({ loggedIn: true, email: 'test@example.com', subscriptionType: 'max' });
  cli.discover = async () => { throw new Error('discovery unavailable'); };
  const status = await cli.refresh();
  assert.equal(status.loggedIn, true);
  assert.equal(status.email, 'test@example.com');
  assert.equal(status.subscriptionType, 'max');
  assert.match(status.modelsError, /unavailable/);
  cli.models = [{ model: 'old' }];
  cli.command = async () => JSON.stringify({ loggedIn: false });
  await cli.refresh();
  assert.deepEqual(cli.models, []);
  assert.equal(cli.status.email, null);
  assert.equal(cli.status.subscriptionType, null);
});
