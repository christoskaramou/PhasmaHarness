const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { Controller } = require('../src/controller.cjs');
const { Agents } = require('../src/agents.cjs');
const { readSessionData } = require('../src/session-store.cjs');

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a steady stream of changes reaches the UI every 100 ms and saves at most once a second, ending saved', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-throttle-'));
  const controller = new Controller(path.join(directory, 'sessions.json'), directory, new EventEmitter(), { cancel() {}, close() {}, jev: null });
  t.after(() => { clearTimeout(controller.timer); clearTimeout(controller.saveTimer); fs.rmSync(directory, { recursive: true, force: true }); });
  const session = { id: 's1', items: [{ id: 'a1', type: 'agentMessage', text: '' }], routes: [] };
  controller.data.sessions.push(session); controller.save();
  const texts = [];
  controller.on('state', state => texts.push(state.sessions[0].items[0].text));
  let saves = 0; const save = controller.store.save.bind(controller.store);
  controller.store.save = data => { saves++; return save(data); };
  // Deltas every 20 ms used to keep resetting the timer, so nothing reached the UI until the stream paused.
  for (let i = 0; i < 25; i++) { session.items[0].text += 'x'; controller.changed(); await wait(20); }
  assert.ok(texts.length >= 4, `only ${texts.length} updates during the stream`);
  assert.ok(saves <= 2, `${saves} saves during half a second of streaming`);
  await wait(1200);
  assert.equal(texts.at(-1), 'x'.repeat(25));
  assert.equal(readSessionData(controller.filename).sessions[0].items[0].text, 'x'.repeat(25));
});

test('saves reuse one journal handle, a checkpoint releases it, and a failed write starts clean on the next save', t => {
  const { SessionStore } = require('../src/session-store.cjs');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-journal-'));
  const file = path.join(directory, 'sessions.json'), store = new SessionStore(file);
  t.after(() => { store.closeJournal(); fs.rmSync(directory, { recursive: true, force: true }); });
  const data = { version: 1, sessions: [{ id: 's1', items: [] }] };
  store.save(data);
  let opens = 0; const open = fs.openSync;
  t.mock.method(fs, 'openSync', (target, ...rest) => { if (String(target).endsWith('.journal')) opens++; return open(target, ...rest); });
  for (let i = 0; i < 5; i++) { data.sessions[0].items.push({ id: 'i' + i, type: 'agentMessage', text: 'x' + i }); store.save(data); }
  assert.equal(opens, 1, 'one journal open for five saves');
  assert.deepEqual(readSessionData(file).sessions[0].items.map(item => item.id), ['i0', 'i1', 'i2', 'i3', 'i4']);
  store.checkpoint(data);
  assert.equal(store.fd, null);
  const write = fs.writeSync;
  t.mock.method(fs, 'writeSync', () => { throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); });
  data.sessions[0].items.push({ id: 'lost', type: 'agentMessage', text: 'not saved' });
  assert.throws(() => store.save(data), /disk full/);
  assert.equal(store.fd, null, 'a failed write drops its handle');
  fs.writeSync = write;
  data.sessions[0].items.at(-1).id = 'kept';
  store.save(data);
  assert.deepEqual(readSessionData(file).sessions[0].items.map(item => item.id), ['i0', 'i1', 'i2', 'i3', 'i4', 'kept']);
});

test('the window gets at most one fleet state per 100 ms, the last built after the final change', async () => {
  const fleet = Object.assign(new EventEmitter(), { value: 0, snapshot() { return { value: this.value }; } });
  const emitted = [];
  fleet.on('state', state => emitted.push({ at: Date.now(), value: state.value }));
  const emitFleet = Agents.prototype.emitFleet.bind(fleet);
  const start = Date.now();
  emitFleet();
  assert.equal(emitted.length, 1, 'a change after a quiet spell is sent at once');
  for (let i = 1; i <= 30; i++) { fleet.value = i; emitFleet(); await wait(10); }
  await wait(150);
  const gaps = emitted.slice(1).map((entry, i) => entry.at - emitted[i].at);
  assert.ok(gaps.every(gap => gap >= 95), `pushes ${JSON.stringify(gaps)} ms apart`);
  assert.ok(emitted.length <= Math.ceil((Date.now() - start) / 100) + 1);
  assert.equal(emitted.at(-1).value, 30);
});

test('window updates carry only the bots whose chats changed, and the window keeps the rest', () => {
  const { trimFleet, keepSessions } = require('../ui/agent-state.js');
  const chats = id => [{ id: id + '-chat', items: [{ id: id + '-item', type: 'agentMessage', text: id }] }];
  const fleet = revisions => ({ sessions: chats('main'), settings: {},
    agentStates: { main: { stateRevision: revisions[0], sessions: chats('main') }, bot: { stateRevision: revisions[1], sessions: chats('bot') } },
    executionStates: { bot: { stateRevision: revisions[2], sessions: chats('job') } } });
  const sent = new Map();
  const first = trimFleet(fleet([1, 1, 1]), sent, false);
  assert.equal(first.sessions, undefined, 'the Main Bot chats are not repeated at the top level');
  assert.ok(first.agentStates.bot.sessions && first.executionStates.bot.sessions);
  const window = keepSessions(structuredClone(first), null);
  const second = trimFleet(fleet([1, 2, 1]), sent, false);
  assert.deepEqual([second.agentStates.main.sessionsKept, second.agentStates.bot.sessionsKept, second.executionStates.bot.sessionsKept], [true, undefined, true]);
  assert.equal(second.agentStates.main.sessions, undefined);
  const merged = keepSessions(structuredClone(second), window);
  assert.deepEqual(merged.agentStates.main.sessions, chats('main'));
  assert.deepEqual(merged.executionStates.bot.sessions, chats('job'));
  assert.equal(merged.agentStates.main.sessionsKept, undefined);
  assert.equal(keepSessions(structuredClone(second), null), null, 'a window without copies asks for a full state');
  // Another bot's code adds a message without this bot's own change notice: the message count still marks it changed.
  const added = fleet([1, 2, 1]); added.agentStates.main.sessions[0].items.push({ id: 'receipt', type: 'agentResult' });
  assert.equal(trimFleet(added, sent, false).agentStates.main.sessionsKept, undefined);
  assert.equal(trimFleet(added, sent, false).agentStates.main.sessionsKept, true);
  const full = trimFleet(fleet([1, 2, 1]), sent, true);
  assert.ok(Object.values(full.agentStates).every(context => context.sessions));
  const plain = { sessions: [], settings: {} };
  assert.equal(trimFleet(plain, sent, false), plain);
  assert.equal(keepSessions(plain, null), plain);
});

test('a change confined to one chat resends only that chat, and the window fills in the rest in order', () => {
  const { trimFleet, keepSessions } = require('../ui/agent-state.js');
  const chat = (id, text) => ({ id, status: 'idle', items: [{ id: id + '-item', type: 'agentMessage', text }] });
  const fleet = (shared, revisions, texts) => ({ agentStates: { main: { stateRevision: 9, sharedRevision: shared, chatRevisions: revisions,
    sessions: ['a', 'b', 'c'].map(id => chat(id, texts[id] || id)) } } });
  const sent = new Map();
  const window = keepSessions(structuredClone(trimFleet(fleet(1, {}, {}), sent, false)), null);
  const scoped = trimFleet(fleet(1, { b: 2 }, { b: 'streaming' }), sent, false);
  assert.deepEqual(scoped.agentStates.main.sessions.map(item => item.id), ['b'], 'only the changed chat is sent');
  assert.deepEqual(scoped.agentStates.main.sessionIds, ['a', 'b', 'c']);
  const merged = keepSessions(structuredClone(scoped), window);
  assert.deepEqual(merged.agentStates.main.sessions.map(item => item.items[0].text), ['a', 'streaming', 'c']);
  assert.equal(merged.agentStates.main.sessionIds, undefined);
  assert.equal(keepSessions(structuredClone(scoped), null), null, 'a window without copies asks for a full state');
  assert.equal(keepSessions(structuredClone(scoped), { agentStates: { main: { sessions: [chat('a', 'a')] } } }), null,
    'a missing kept chat asks for a full state');
  const shared = trimFleet(fleet(3, { b: 2 }, { b: 'streaming' }), sent, false);
  assert.equal(shared.agentStates.main.sessionIds, undefined, 'an unscoped change resends every chat');
  assert.equal(shared.agentStates.main.sessions.length, 3);
});

test('changed(session) marks one chat, changed() and save() mark them all, and the throttled save marks nothing new', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-chat-revision-'));
  const controller = new Controller(path.join(directory, 'sessions.json'), directory, new EventEmitter(), { cancel() {}, close() {}, jev: null });
  t.after(() => { clearTimeout(controller.timer); clearTimeout(controller.saveTimer); controller.store.closeJournal(); fs.rmSync(directory, { recursive: true, force: true }); });
  const session = { id: 's1', items: [], routes: [] };
  controller.data.sessions.push(session);
  controller.save();
  const shared = controller.sharedRevision;
  controller.changed(session);
  assert.equal(controller.sharedRevision, shared);
  assert.ok(controller.chatRevisions.get('s1') > shared);
  controller.flushSave();
  assert.equal(controller.sharedRevision, shared, 'persisting reported changes is not a change to every chat');
  controller.changed();
  assert.ok(controller.sharedRevision > controller.chatRevisions.get('s1'));
  const before = controller.sharedRevision;
  controller.save();
  assert.ok(controller.sharedRevision > before);
});

test('a change notice and a save both advance the bot revision that decides whether its chats are resent', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-revision-'));
  const controller = new Controller(path.join(directory, 'sessions.json'), directory, new EventEmitter(), { cancel() {}, close() {}, jev: null });
  t.after(() => { clearTimeout(controller.timer); clearTimeout(controller.saveTimer); controller.store.closeJournal(); fs.rmSync(directory, { recursive: true, force: true }); });
  const start = controller.stateRevision || 0;
  controller.changed();
  controller.save();
  assert.equal(controller.stateRevision, start + 2);
});
