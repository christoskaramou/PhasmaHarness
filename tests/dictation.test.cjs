const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { randomUUID } = require('node:crypto');
const { Dictation } = require('../src/dictation.cjs');

function fixture(options = {}) {
  const children = [], calls = [], events = [];
  const voice = new Dictation({ platform: 'win32', stopMs: 10, killMs: 10,
    command: async (file, args, config) => {
      calls.push({ file, args, config });
      return { stdout: JSON.stringify({ type: 'info', languages: [{ id: 'installed', culture: 'en-US', name: 'English' }] }) };
    },
    launch: (file, args, config) => {
      calls.push({ file, args, config });
      const child = new EventEmitter();
      Object.assign(child, { pid: 123, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
        kill: () => { child.killed = true; child.emit('close', null); } });
      children.push(child);
      return child;
    }, ...options });
  voice.on('event', value => events.push(value));
  return { voice, children, calls, events };
}
const request = () => ({ id: randomUUID(), sessionId: randomUUID() });
const output = (child, value) => child.stdout.write(JSON.stringify(value) + '\n');

test('dictation discovers languages without opening audio and uses a hidden fixed child with a minimal environment', async () => {
  const { voice, calls, children, events } = fixture();
  process.env.PHASMA_TEST_SECRET = 'do not forward';
  try {
    assert.equal((await voice.info()).supported, true);
    assert.equal(children.length, 0);
    const source = request();
    await voice.start(source);
    assert.equal(calls.length, 2);
    assert.equal(calls[1].config.windowsHide, true);
    assert.equal(calls[1].config.shell, false);
    assert.equal(calls[1].config.env.PHASMA_TEST_SECRET, undefined);
    assert.deepEqual(calls[1].args.slice(-2), ['-RecognizerId', 'installed']);
    assert.throws(() => voice.start(request()), /Finish the current/);
    output(children[0], { type: 'ready' });
    assert.equal(voice.snapshot().state, 'listening');
    assert.equal(events.at(-1).sessionId, source.sessionId);
    await voice.stop(source.id);
    assert.equal(children[0].killed, true);
    assert.equal(voice.busy, false);
  } finally { delete process.env.PHASMA_TEST_SECRET; await voice.close(); }
});

test('dictation preserves split UTF8 and final words before Stop completes; stale Stop cannot stop a new recording', async () => {
  const { voice, children, events } = fixture();
  const first = request();
  await voice.start(first);
  const text = Buffer.from(JSON.stringify({ type: 'text', text: 'γειά σου' }) + '\n');
  const split = text.indexOf(Buffer.from('γ')) + 1;
  children[0].stdout.write(text.subarray(0, split));
  children[0].stdout.write(text.subarray(split));
  children[0].stdin.on('finish', () => {
    output(children[0], { type: 'text', text: 'final words' }); children[0].emit('close', 0);
  });
  await voice.stop(first.id);
  assert.deepEqual(events.filter(event => event.type === 'text').map(event => [event.text, event.sequence, event.sessionId]),
    [['γειά σου', 1, first.sessionId], ['final words', 2, first.sessionId]]);
  const second = request();
  await voice.start(second);
  await voice.stop(first.id);
  assert.equal(voice.snapshot().id, second.id);
  assert.equal(children[1].killed, undefined);
  await voice.close();
});

test('dictation Stop during language discovery never opens the microphone', async () => {
  let release;
  const { voice, children } = fixture({ command: () => new Promise(resolve => { release = resolve; }) });
  const source = request();
  const starting = voice.start(source), stopping = voice.stop(source.id);
  release({ stdout: JSON.stringify({ type: 'info', languages: [] }) });
  await Promise.all([starting, stopping]);
  assert.equal(children.length, 0);
  assert.equal(voice.busy, false);
  await voice.close();
});

test('dictation keeps failed cleanup occupied until the owned child confirms exit', async () => {
  const { voice, children } = fixture();
  const source = request();
  await voice.start(source);
  children[0].kill = () => false;
  await assert.rejects(voice.stop(source.id), /cleanup is not confirmed/);
  assert.equal(voice.snapshot().state, 'cleanup-blocked');
  assert.throws(() => voice.start(request()), /Finish the current/);
  children[0].emit('close', 0);
  assert.equal(voice.busy, false);
  await voice.close();
});

test('dictation rejects unsupported platforms, invalid metadata and malformed speech output without model fallback', async () => {
  const unsupported = fixture({ platform: 'linux' });
  assert.equal((await unsupported.voice.info()).supported, false);
  assert.equal(unsupported.calls.length, 0);
  await assert.rejects(unsupported.voice.start(request()), /unavailable/);
  const invalid = fixture({ command: async () => ({ stdout: '{"type":"info","languages":[{}]}' }) });
  await assert.rejects(invalid.voice.start(request()), /invalid/);
  assert.equal(invalid.children.length, 0);
  const { voice, children, events } = fixture();
  await voice.start(request());
  children[0].stdout.write('bad event\n');
  await voice.close();
  assert.equal(voice.busy, false);
  assert.ok(events.some(event => /invalid event/.test(event.error || '')));
});
