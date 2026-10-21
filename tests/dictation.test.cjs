const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Dictation, cleanText, microphoneAllowed, voiced } = require('../src/dictation.cjs');

const model = content => ({ file: `${content}.bin`, bytes: Buffer.byteLength(content), sha256: crypto.createHash('sha256').update(content).digest('hex') });
const MODELS = { base: model('base-model'), small: model('small-model') };

// A fake engine worker: "load" answers with the given GPU flag, "transcribe" with the given text.
function fixture(t, options = {}) {
  const directory = options.directory || fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dictation-'));
  if (!options.directory)
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const children = [], events = [], fetches = [];
  const voice = new Dictation({ platform: 'win32', arch: 'x64', modelDirectory: directory, models: MODELS, stopMs: 20,
    resolve: name => (options.engine === false ? (() => { throw new Error('missing'); })() : name),
    fetch: async url => {
      fetches.push(url);
      const file = path.basename(new URL(url).pathname);
      const content = options.wrong ? 'tampered' : file.replace(/\.bin$/, '');
      return new Response(Buffer.from(content));
    },
    launch: (file, args, config) => {
      const child = new EventEmitter();
      Object.assign(child, { file, config, messages: [] });
      child.send = message => {
        child.messages.push(message);
        setImmediate(() => {
          if (child.dead)
            return;
          if (options.crash && message.type === 'transcribe')
            return child.kill();
          child.emit('message', message.type === 'load' ? { type: 'ready', id: message.id, gpu: !!options.gpu }
            : { type: 'text', id: message.id, text: options.text ?? ' [BLANK_AUDIO] Hello there' });
        });
      };
      child.kill = () => {
        child.dead = true;
        child.emit('exit', null);
      };
      children.push(child);
      return child;
    } });
  voice.on('event', value => events.push(value));
  t.after(() => voice.close());
  return { voice, directory, children, events, fetches };
}
const request = () => ({ id: crypto.randomUUID(), sessionId: crypto.randomUUID() });
const speech = (seconds = 1) => Int16Array.from({ length: 16000 * seconds }, (_, index) => Math.round(Math.sin(index / 8) * 8000)).buffer;
async function until(condition) {
  for (let index = 0; index < 200 && !condition(); index++)
    await new Promise(resolve => setTimeout(resolve, 5));
  assert.ok(condition(), 'condition was not reached');
}

test('recorded audio is checked before the engine, silence never reaches it, and words go to the original chat', async t => {
  const { voice, children, events } = fixture(t);
  process.env.PHASMA_TEST_SECRET = 'do not forward';
  try {
    const source = request();
    assert.equal(voice.start(source).state, 'listening');
    assert.equal(voice.recording, true);
    assert.throws(() => voice.start(request()), /Finish the current/);
    await assert.rejects(voice.transcribe(crypto.randomUUID(), speech()), /current dictation/);
    await assert.rejects(voice.transcribe(source.id, new ArrayBuffer(3)), /not valid audio/);
    await assert.rejects(voice.transcribe(source.id, new ArrayBuffer(16000 * 2 * 301)), /longer than five minutes/);

    assert.equal((await voice.transcribe(source.id, new Int16Array(16000).buffer)).state, 'idle');
    assert.equal(events.some(event => event.type === 'text'), false, 'silence gives no words');
    await until(() => children[0]?.messages.length === 1);
    assert.deepEqual(children[0].messages.map(message => message.type), ['load'], 'only the warm-up load reached the engine');
    assert.equal(children[0].config.env.PHASMA_TEST_SECRET, undefined, 'the worker gets a stripped environment');
    assert.equal(children[0].config.env.ELECTRON_RUN_AS_NODE, '1');
    assert.equal(children[0].config.windowsHide, true);

    const next = request();
    voice.start(next);
    await voice.transcribe(next.id, speech());
    const words = events.filter(event => event.type === 'text');
    assert.deepEqual(words.map(event => [event.text, event.sequence, event.sessionId]), [['Hello there', 1, next.sessionId]]);
    assert.equal(children[0].messages.at(-1).pcm.length, 16000, 'the engine gets the 16-bit samples');
    assert.equal(voice.snapshot().state, 'idle');
    assert.equal(voice.busy, false);
  } finally {
    delete process.env.PHASMA_TEST_SECRET;
  }
});

test('Stop asks the page for its audio; without it in time, or when discarded, the recording ends without words', async t => {
  const { voice, events } = fixture(t);
  const first = request();
  voice.start(first);
  await voice.stop();
  assert.equal(voice.snapshot().state, 'stopping');
  assert.equal(voice.recording, false, 'the microphone is no longer granted');
  await until(() => voice.snapshot().state === 'idle');

  const second = request();
  voice.start(second);
  await voice.stop(second.id);
  assert.equal((await voice.transcribe(second.id, speech())).state, 'idle', 'audio sent after the request still counts');
  assert.equal(events.filter(event => event.type === 'text').length, 1);

  const third = request();
  voice.start(third);
  await voice.stop(third.id, { discard: true });
  assert.equal(voice.snapshot().state, 'idle');
  await assert.rejects(voice.transcribe(third.id, speech()), /current dictation/);
});

test('the pinned model downloads once and is checksum-checked; a GPU machine moves to the small model', async t => {
  const { voice, directory, children, fetches, events } = fixture(t, { gpu: true });
  const source = request();
  voice.start(source);
  await voice.transcribe(source.id, speech());
  await until(() => children[0].messages.filter(message => message.type === 'load').length === 2);
  assert.deepEqual(children[0].messages.filter(message => message.type === 'load').map(message => path.basename(message.filePath)), ['base-model.bin', 'small-model.bin']);
  assert.deepEqual(fetches.map(url => path.basename(url)), ['base-model.bin', 'small-model.bin']);
  assert.ok(events.some(event => event.progress?.percent === 100), 'the first download shows its progress');
  assert.equal(fs.existsSync(path.join(directory, 'base-model.bin.part')), false);

  // Next run: small is already there, so it loads directly with no download.
  const again = fixture(t, { gpu: true, directory });
  const next = request();
  again.voice.start(next);
  await again.voice.transcribe(next.id, speech());
  assert.deepEqual(again.children[0].messages.filter(message => message.type === 'load').map(message => path.basename(message.filePath)), ['small-model.bin']);
  assert.deepEqual(again.fetches, []);
});

test('a download that does not match its checksum is deleted and the error reaches the chat', async t => {
  const { voice, directory, events } = fixture(t, { wrong: true });
  const source = request();
  voice.start(source);
  const result = await voice.transcribe(source.id, speech());
  assert.match(result.error, /checksum|larger than expected/);
  assert.ok(events.some(event => /checksum|larger than expected/.test(event.error || '')));
  assert.deepEqual(fs.readdirSync(directory), []);
});

test('an engine that stops mid-transcription reports it, and the next recording starts a fresh one', async t => {
  const { voice, children } = fixture(t, { crash: true });
  const source = request();
  voice.start(source);
  assert.match((await voice.transcribe(source.id, speech())).error, /stopped unexpectedly/);
  const next = request();
  voice.start(next);
  await until(() => children.length === 2);
});

test('without an engine build or a model folder, dictation says so instead of starting', async t => {
  const { voice } = fixture(t, { engine: false });
  assert.deepEqual(await voice.info(), { supported: false, reason: 'Local dictation is not available on this system.' });
  assert.throws(() => voice.start(request()), /not available/);
});

test('Whisper tags and noise are dropped, speech is told from silence, and only the app page gets the microphone while recording', () => {
  assert.equal(cleanText(' [BLANK_AUDIO]'), '');
  assert.equal(cleanText(' ಠ_ಠ'), '');
  assert.equal(cleanText(' Hello (music) world '), 'Hello world');
  assert.equal(cleanText(' Γεια σου κόσμε'), 'Γεια σου κόσμε');
  assert.equal(voiced(new Int16Array(16000)), false);
  assert.equal(voiced(new Int16Array(speech(0.25))), false, 'too short');
  assert.equal(voiced(new Int16Array(speech(1))), true);

  const allowed = { permission: 'media', mediaTypes: ['audio'], url: 'file:///ui/index.html', rendererURL: 'file:///ui/index.html', fromWindow: true, recording: true };
  assert.equal(microphoneAllowed(allowed), true);
  for (const change of [{ mediaTypes: ['audio', 'video'] }, { mediaTypes: [] }, { url: 'https://example.com/' }, { recording: false }, { fromWindow: false },
    { permission: 'notifications' }])
    assert.equal(microphoneAllowed({ ...allowed, ...change }), false, JSON.stringify(change));
});
