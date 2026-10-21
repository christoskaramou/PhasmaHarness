const { test } = require('node:test');
const assert = require('node:assert/strict');
const { registerRunnerCommands, assertRunnerOpen } = require('../src/runner-commands.cjs');
const { REMOTE_METHODS } = require('../src/remote.cjs');
const image = 'data:image/png;base64,YQ==';

function fixture(normalizeImage = async value => value) {
  const commands = new Map(), sent = [], stopped = [];
  const worker = { send: value => { sent.push(value); return { saved: true }; } };
  const agents = { closing: false, owner: () => worker,
    sync() {}, stop: id => { stopped.push(id); }, snapshot: () => ({ kept: true }) };
  const runner = { agents, controller: {}, updater: { state: { status: 'idle' } } };
  registerRunnerCommands((name, handler) => {
    assert.equal(commands.has(name), false, name); commands.set(name, handler);
  }, { runner, normalizeImage });
  const call = (name, ...args) => { assertRunnerOpen(agents, name); return commands.get(name)(...args); };
  return { commands, sent, stopped, runner, agents, call };
}

test('shared runner commands cover browser operations without importing desktop dependencies', () => {
  const { commands } = fixture();
  const transport = new Set(['artifactDownload', 'answerConfirmation', 'appInfo', 'runnerInfo']);
  for (const method of REMOTE_METHODS) assert.ok(commands.has(method) || transport.has(method), method);
  assert.ok(!commands.has('providerKey'));
  assert.ok(!commands.has('remoteInfo'));
});

test('image and attachment validation precedes submission and keeps message metadata under Harness control', async () => {
  let inspected = 0;
  const f = fixture(async () => { inspected++; throw new Error('Invalid image.'); });
  for (const message of [null, [], { id: 'chat', fileMessage: 'forged' }, { id: 'chat', images: Array(5).fill(image) },
    { id: 'chat', images: ['file:///private'] }, { id: 'chat', images: ['x'.repeat(12 * 1024 * 1024 + 1)] }])
    await assert.rejects(f.call('send', message));
  assert.equal(inspected, 0);
  await assert.rejects(f.call('send', { id: 'chat', text: 'image', images: [image] }), /Invalid image/);
  assert.equal(inspected, 1);
  assert.deepEqual(f.sent, []);
});

test('shared model discovery exposes native metadata and rejects unknown provider IDs', async () => {
  const f = fixture(), c = f.runner.controller;
  c.nativeCLIs = new Map([['native:muse', { models: [{ model: 'muse-fixture', label: 'Fixture Muse' }] }]]);
  c.models = [{ model: 'codex-fixture' }]; c.cursor = { models: [{ id: 'cursor-fixture' }] };
  c.data = { settings: { providers: [{ id: 'configured-api' }] } };
  c.providers = { models: async id => { assert.equal(id, 'configured-api'); return ['api-fixture']; } };
  for (const [id, model] of [['native:muse', 'muse-fixture'], ['codex', 'codex-fixture'], ['cursor-cli', 'cursor-fixture'], ['configured-api', 'api-fixture']])
    assert.equal((await f.call('providerModels', id))[0].id, model);
  for (const id of ['__proto__', 'unknown', {}, null]) await assert.rejects(f.call('providerModels', id), /Unknown provider/);
});

test('Stop cancels only matching image preparation and cannot admit it after validation completes', async () => {
  const pending = [];
  const f = fixture((value, signal) => new Promise(resolve => pending.push({ resolve, signal })));
  const a = f.call('send', { id: 'first', text: 'cancel me', images: [image] });
  const b = f.call('send', { id: 'second', text: 'keep me', images: [image] });
  f.call('stop', 'first');
  assert.equal(pending[0].signal.aborted, true);
  assert.equal(pending[1].signal.aborted, false);
  pending[0].resolve(image); pending[1].resolve(image);
  await assert.rejects(a, /cancelled before submission/);
  assert.deepEqual(await b, { saved: true });
  assert.deepEqual(f.sent.map(message => message.id), ['second']);
  assert.deepEqual(f.stopped, ['first']);
  const late = f.call('send', { id: 'third', text: 'closing', images: [image] });
  f.agents.closing = true; pending[2].resolve(image);
  await assert.rejects(late, /runner is stopping/);
  assert.deepEqual(f.sent.map(message => message.id), ['second']);
  assert.deepEqual(f.call('bootstrap'), { kept: true });
});

test('a transfer cleanup failure still attempts snapshot cleanup', async () => {
  let cancelled = false;
  const commands = new Map(), runner = { controller: {}, agents: { downloads: { cancel: async () => { cancelled = true; } } } };
  registerRunnerCommands((name, handler) => commands.set(name, handler), {
    runner, stopDownloads: async () => { throw new Error('Transfer cleanup failed.'); },
  });
  await assert.rejects(commands.get('stopDownloads')(), /Transfer cleanup failed/);
  assert.equal(cancelled, true);
});

test('removing or replacing a chat owner during image validation cannot resurrect its old controller', async () => {
  let finish;
  const f = fixture(() => new Promise(resolve => { finish = resolve; }));
  const pending = f.call('send', { id: 'removed', images: [image] });
  f.agents.owner = () => ({ send() { throw new Error('Unexpected replacement submission.'); } });
  finish(image);
  await assert.rejects(pending, /chat changed before submission/);
  assert.deepEqual(f.sent, []);
});

test('normalized images cannot exceed the message bound even when small sources expand during decoding', async () => {
  const f = fixture(async () => 'data:image/png;base64,' + 'a'.repeat(7 * 1024 * 1024));
  await assert.rejects(f.call('send', { id: 'chat', images: [image, image] }), /decoded images are too large/);
  assert.deepEqual(f.sent, []);
});

test('Apply shows the files and its safety notes before writing, and writes nothing on a conflict or Cancel', async () => {
  const commands = new Map(), asked = [], applied = [];
  let answer = false;
  let preview = { workspace: 'C:/jobs/1', source: 'C:/project', snapshot: 'C:/jobs/input', conflicts: [], changes: [] };
  const workspaces = {
    changes: async () => preview,
    apply: async (workspace, seen) => {
      applied.push(seen);
      return { source: preview.source, applied: seen.changes.map(change => change.path) };
    },
  };
  const runner = { agents: { closing: false, workspaces }, controller: {}, updater: { state: { status: 'idle' } } };
  registerRunnerCommands((name, handler) => commands.set(name, handler), { runner, ask: async options => {
    asked.push(options);
    return answer;
  } });
  const apply = () => commands.get('applyCopy')('C:/jobs/1');

  assert.match((await apply()).message, /Nothing to apply/);
  preview = { ...preview, conflicts: ['a.txt', 'b.txt'] };
  await assert.rejects(apply(), /You changed a\.txt, b\.txt in C:\/project since this copy was made\. Nothing was applied\./);
  assert.equal(asked.length, 0, 'no dialog for nothing or a conflict');

  preview = { ...preview, conflicts: [], changes: Array.from({ length: 32 }, (_, index) => ({ path: `f${index}.txt`, kind: index ? 'modified' : 'added' })) };
  assert.equal((await apply()).cancelled, true);
  assert.equal(applied.length, 0);
  const dialog = asked.at(-1);
  assert.equal(dialog.title, 'Apply 32 files to your project?');
  assert.deepEqual(dialog.details[0], { label: 'Add', text: 'f0.txt' });
  assert.equal(dialog.details.length, 31);
  assert.deepEqual(dialog.details.at(-1), { label: 'More', text: 'and 2 more files' });
  assert.match(dialog.note, /uncommitted changes; nothing is staged or committed[\s\S]*Ignored files[\s\S]*C:\/jobs\/input/);

  answer = true;
  assert.equal((await apply()).applied.length, 32);
  assert.equal(applied[0], preview, 'exactly the previewed changes go to apply');
});

test('Undo from a comparison card goes to the owner of its chat', async () => {
  const commands = new Map(), calls = [];
  const owner = { undoComparison: (...args) => { calls.push(args); return { undone: true }; } };
  const runner = { agents: { closing: false, owner: () => owner }, controller: {}, updater: { state: { status: 'idle' } } };
  registerRunnerCommands((name, handler) => commands.set(name, handler), { runner, ask: async () => false });
  assert.deepEqual(await commands.get('undoComparison')('chat', 'comparison', 'rule'), { undone: true });
  assert.deepEqual(calls, [['chat', 'comparison', 'rule']]);
});
