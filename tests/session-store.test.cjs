const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SessionStore, readSessionData } = require('../src/session-store.cjs');
const { backupStores } = require('../src/runner.cjs');
const { randomUUID } = require('node:crypto');

function fixture(t, data = { version: 1, settings: {}, sessions: [{ id: 'chat', items: [] }] }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'sessions.json'), store = new SessionStore(file);
  store.load(data); store.save(data);
  return { file, journal: file + '.journal', store, data };
}

test('session journal replays metadata, transcript edits, removals and session order', t => {
  const { file, store, data } = fixture(t);
  data.settings.access = 'read-only'; data.agents = [{ id: 'worker' }];
  data.sessions[0].items.push({ text: 'First' }, { text: 'Streaming' });
  store.save(data);
  data.sessions[0].items[1].text = 'Completed'; data.sessions[0].archived = true;
  data.sessions.unshift({ id: 'next', items: [{ text: 'Next chat' }] });
  store.save(data);
  assert.deepEqual(readSessionData(file), data);
  delete data.agents; delete data.sessions[1].archived; data.sessions[1].items.pop(); store.save(data);
  assert.deepEqual(new SessionStore(file).load({ sessions: [] }), data);
  data.sessions.splice(1); store.save(data);
  assert.deepEqual(readSessionData(file), data);
});

test('legacy snapshot loads unchanged and appended text does not rewrite old history', t => {
  const { file, journal, data } = fixture(t);
  data.sessions[0].items = Array.from({ length: 2500 }, (_, i) => ({ id: String(i), text: 'x'.repeat(1000) }));
  const legacy = JSON.stringify(data); fs.writeFileSync(file, legacy);
  const store = new SessionStore(file); assert.deepEqual(store.load({ sessions: [] }), data);
  store.save(data); assert.equal(fs.statSync(journal).size, 0, 'unchanged saves write nothing');
  data.sessions[0].items.push({ text: 'A small new reply' }); store.save(data);
  assert.equal(fs.readFileSync(file, 'utf8'), legacy, 'snapshot was not rewritten');
  assert.ok(fs.statSync(journal).size < 500, 'a tiny reply adds under 500 bytes to a 2.5 MB history');
  assert.deepEqual(readSessionData(file), data);
  const bytes = fs.statSync(journal).size; store.save(data); assert.equal(fs.statSync(journal).size, bytes);
});

test('torn final journal record is ignored and repaired before the next append', t => {
  const { file, journal, store, data } = fixture(t);
  data.sessions[0].items.push({ text: 'Acknowledged' }); store.save(data);
  const committed = fs.readFileSync(journal);
  fs.appendFileSync(journal, '{"revision":2,"fields":{"partial":"');
  const next = new SessionStore(file), recovered = next.load({ sessions: [] });
  assert.deepEqual(recovered, data);
  recovered.sessions[0].items.push({ text: 'After restart' }); next.save(recovered);
  assert.ok(fs.readFileSync(journal).subarray(0, committed.length).equals(committed));
  assert.deepEqual(readSessionData(file), recovered);
});

test('malformed complete records and revision gaps fail closed without changing evidence', t => {
  const { file, journal } = fixture(t);
  const snapshot = fs.readFileSync(file, 'utf8');
  for (const record of ['not json', 'null', '{"revision":2}', '{"revision":1,"fields":{"sessions":[]},"removed":[],"sessions":[],"order":[]}']) {
    fs.writeFileSync(journal, record + '\n');
    assert.throws(() => new SessionStore(file).load({ sessions: [] }));
    assert.equal(fs.readFileSync(file, 'utf8'), snapshot); assert.equal(fs.readFileSync(journal, 'utf8'), record + '\n');
  }
});

test('checkpoint tolerates a crash before journal truncation without replaying old changes', t => {
  const { file, journal, store, data } = fixture(t);
  data.sessions[0].items.push({ text: 'Only once' }); store.save(data);
  const oldJournal = fs.readFileSync(journal); store.checkpoint(data);
  fs.writeFileSync(journal, oldJournal);
  const next = new SessionStore(file), recovered = next.load({ sessions: [] });
  assert.deepEqual(recovered, data);
  recovered.sessions[0].items.push({ text: 'Later' }); next.save(recovered);
  assert.deepEqual(readSessionData(file), recovered);
});

test('failed append flush rolls back and retry preserves exactly one copy', t => {
  const { file, journal, store, data } = fixture(t);
  const realSync = fs.fsyncSync; let fail = true;
  const sync = t.mock.method(fs, 'fsyncSync', fd => { if (fail) { fail = false; throw new Error('Injected flush failure'); } realSync(fd); });
  data.sessions[0].items.push({ text: 'Retry safely' });
  assert.throws(() => store.save(data), /Injected flush failure/);
  sync.mock.restore();
  assert.equal(fs.statSync(journal).size, 0); assert.equal(readSessionData(file).sessions[0].items.length, 0);
  store.save(data); assert.deepEqual(readSessionData(file), data);
});

test('failed checkpoint rename preserves the journal and failed truncation flush permits the next save', t => {
  const { file, journal, store, data } = fixture(t);
  data.sessions[0].items.push({ text: 'Durable' }); store.save(data);
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Injected rename failure'); });
  assert.throws(() => store.checkpoint(data), /Injected rename failure/); rename.mock.restore();
  assert.deepEqual(readSessionData(file), data); assert.equal(fs.existsSync(file + '.tmp'), false);
  const realOpen = fs.openSync, realSync = fs.fsyncSync; let journalFd;
  const open = t.mock.method(fs, 'openSync', (name, ...args) => { const fd = realOpen(name, ...args); if (name === journal) journalFd = fd; return fd; });
  const sync = t.mock.method(fs, 'fsyncSync', fd => { if (fd === journalFd) throw new Error('Injected truncation flush failure'); realSync(fd); });
  assert.throws(() => store.checkpoint(data), /Injected truncation flush failure/);
  open.mock.restore(); sync.mock.restore();
  data.sessions[0].items.push({ text: 'After failed checkpoint' }); store.save(data);
  assert.deepEqual(readSessionData(file), data);
});

test('automatic checkpoint failure preserves acknowledged work and later saves recover', t => {
  const { file, store, data } = fixture(t), errors = [];
  store.onCheckpointError = error => errors.push(error.message);
  store.records = 999;
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Injected checkpoint failure'); });
  data.sessions[0].items.push({ text: 'Acknowledged before checkpoint' }); store.save(data);
  rename.mock.restore();
  assert.deepEqual(errors, ['Injected checkpoint failure']); assert.deepEqual(readSessionData(file), data);
  data.sessions[0].items.push({ text: 'New work' }); store.save(data);
  assert.equal(fs.statSync(file + '.journal').size, 0); assert.deepEqual(readSessionData(file), data);
});

test('startup backups include journal-only agents, worker contexts and messages as standalone JSON', t => {
  const { file, store, data } = fixture(t), id = randomUUID();
  data.agents = [{ id }]; data.workerContexts = [id]; store.save(data);
  const children = ['agents', 'workers'].map(directory => path.join(path.dirname(file), directory, id, 'sessions.json'));
  for (const child of children) {
    const childStore = new SessionStore(child), childData = { version: 1, settings: {}, sessions: [{ id: 'work', items: [] }] };
    childStore.load(childData); childStore.save(childData);
    childData.sessions[0].items.push({ text: 'Latest persisted result' }); childStore.save(childData);
  }
  backupStores(file);
  for (const name of [file, ...children]) {
    const backup = name + '.pre-runner-recovery-v1.bak';
    assert.deepEqual(JSON.parse(fs.readFileSync(backup, 'utf8')), readSessionData(name));
    assert.equal(fs.existsSync(backup + '.journal'), false);
  }
});

test('a save re-encodes only what may have changed, and an older message edited in place is still saved by the next full pass', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-store-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const filename = path.join(directory, 'sessions.json');
  const store = new SessionStore(filename);
  const items = Array.from({ length: 50 }, (_, index) => ({ id: `m${index}`, type: 'agentMessage', text: `old ${index}` }));
  const data = { version: 1, sessions: [{ id: 'chat', items }, { id: 'other', items: [{ id: 'o', text: 'x' }] }] };
  store.save(data); store.save(data);
  const reload = () => { const fresh = new SessionStore(filename); const loaded = fresh.load({ sessions: [] }); fresh.closeJournal(); return loaded; };
  items.at(-1).text = 'streamed'; items.push({ id: 'new', text: 'new' });
  store.save(data);
  assert.deepEqual(reload().sessions[0].items.slice(-2).map(item => item.text), ['streamed', 'new'], 'tail edits and new messages save at once');
  data.sessions[1].items = [{ id: 'o', text: 'replaced' }];
  store.save(data);
  assert.equal(reload().sessions[1].items[0].text, 'replaced', 'a replaced list saves at once');
  items[0].text = 'edited long ago';
  store.save(data);
  assert.equal(reload().sessions[0].items[0].text, 'old 0', 'an old in-place edit waits for the full pass');
  store.fullAt = 0;
  store.save(data);
  assert.equal(reload().sessions[0].items[0].text, 'edited long ago', 'and the full pass saves it');
  store.closeJournal();
});

// 2026-11-12: tool calls were 133 MB of the user's largest store, encoded again on every full pass and checkpoint.
test('saves and checkpoints reuse an unchanged tool call’s encoding, and save one whose fields were replaced', t => {
  const { file, store, data } = fixture(t);
  const call = { id: 't1', type: 'mcpToolCall', status: 'completed', arguments: { command: 'ls' }, result: [{ type: 'text', text: 'big' }] };
  data.sessions[0].items.push({ id: 'm1', type: 'userMessage', text: 'Q' }, call);
  data.sessions.push({ id: 'bare', title: 'No items', hidden: undefined });
  store.save(data);
  const stringify = JSON.stringify;
  let encodedCalls = 0;
  t.mock.method(JSON, 'stringify', (value, ...rest) => { if (value?.type === 'mcpToolCall') encodedCalls++; return stringify(value, ...rest); });
  store.fullAt = 0; data.sessions[0].title = 'Full pass'; store.save(data);
  assert.equal(encodedCalls, 0, 'the full pass reuses the unchanged call');
  store.fullAt = 0; call.result = [{ type: 'text', text: 'compacted' }]; store.save(data);
  assert.equal(encodedCalls, 1, 'a replaced field is encoded again');
  assert.deepEqual(readSessionData(file).sessions[0].items[1].result, call.result);
  data.sessions[0].items[1] = { ...call, status: 'failed' }; store.fullAt = 0; store.save(data);
  assert.equal(readSessionData(file).sessions[0].items[1].status, 'failed', 'a new object at the same place is saved');

  encodedCalls = 0;
  store.checkpoint(data);
  assert.equal(encodedCalls, 0, 'the checkpoint is written from the encodings');
  t.mock.restoreAll();
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { ...JSON.parse(stringify(data)), _journalRevision: store.revision });
  assert.deepEqual(new SessionStore(file).load(null), JSON.parse(stringify(data)));
});

// 2026-11-13: rewriting 136 MB of large messages took most of each 300 ms checkpoint of the user's largest store.
test('large messages are written once to a pack beside the store, and a pack mostly unused is replaced', t => {
  const { file, store, data } = fixture(t);
  const big = id => ({ id, type: 'mcpToolCall', status: 'completed', result: [{ type: 'text', text: id.repeat(20000) }] });
  data.sessions[0].items.push({ id: 'm1', type: 'userMessage', text: 'Q' }, big('a'), big('b'));
  store.checkpoint(data);
  const pack = file + '.pack-1', main = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(main._pack, 'sessions.json.pack-1');
  assert.deepEqual(main.sessions[0].items.slice(1).map(item => Object.keys(item)), [['$pack'], ['$pack']], 'the store names the pack');
  assert.ok(fs.statSync(file).size < 1000);
  assert.deepEqual(readSessionData(file), data);
  const size = fs.statSync(pack).size;
  store.checkpoint(data);
  assert.equal(fs.statSync(pack).size, size, 'unchanged messages are not written again');

  const reloaded = new SessionStore(file), copy = reloaded.load(null);
  assert.deepEqual(copy, data);
  reloaded.checkpoint(copy);
  assert.equal(fs.statSync(pack).size, size, 'nor after a restart');
  copy.sessions[0].items[2].status = 'failed'; copy.sessions[0].items.push(big('c'));
  reloaded.save(copy);
  reloaded.checkpoint(copy);
  assert.ok(fs.statSync(pack).size > size, 'edited and new messages are appended');
  assert.deepEqual(readSessionData(file), copy);

  // Over half unused and over 32 MB: one large message replaced many times.
  const named = () => JSON.parse(fs.readFileSync(file, 'utf8'))._pack;
  for (let n = 0; n < 20 && named() === 'sessions.json.pack-1'; n++) { copy.sessions[0].items[1] = { ...big('a'), result: [{ type: 'text', text: String(n % 10).repeat(4e6) }] }; reloaded.checkpoint(copy); }
  assert.equal(named(), 'sessions.json.pack-2');
  assert.ok(!fs.existsSync(pack), 'the replaced pack is removed');
  assert.ok(fs.statSync(file + '.pack-2').size < 5e6, 'only the messages in use are kept');
  assert.deepEqual(readSessionData(file), copy);
  reloaded.closeJournal(); store.closeJournal();
});

test('a checkpoint that fails after appending to the pack leaves the last store readable; a missing pack fails closed', t => {
  const { file, store, data } = fixture(t);
  data.sessions[0].items.push({ id: 'a', type: 'agentMessage', text: 'a'.repeat(20000) });
  store.checkpoint(data);
  const saved = structuredClone(data);
  data.sessions[0].items.push({ id: 'b', type: 'agentMessage', text: 'b'.repeat(20000) });
  const rename = t.mock.method(fs, 'renameSync', () => { throw new Error('Injected rename failure'); });
  assert.throws(() => store.checkpoint(data), /Injected rename failure/); rename.mock.restore();
  assert.deepEqual(readSessionData(file), saved);
  store.checkpoint(data);
  assert.deepEqual(readSessionData(file), data);
  store.closeJournal();
  fs.rmSync(file + '.pack-1');
  assert.throws(() => new SessionStore(file).load(null), /ENOENT/);
  assert.ok(fs.existsSync(file), 'the store is preserved');
});

test('a store saved before packs loads, and its next checkpoint moves large messages to a pack', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'sessions.json');
  const data = { version: 1, settings: {}, sessions: [{ id: 'chat', items: [{ id: 'a', type: 'agentMessage', text: 'a'.repeat(20000) }] }] };
  fs.writeFileSync(file, JSON.stringify({ ...data, _journalRevision: 0 }));
  const store = new SessionStore(file);
  assert.deepEqual(store.load(null), data);
  store.checkpoint(data);
  assert.ok(fs.existsSync(file + '.pack-1'));
  assert.deepEqual(readSessionData(file), data);
  store.closeJournal();
});
