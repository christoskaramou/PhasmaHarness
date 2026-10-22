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
