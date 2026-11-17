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

// 2026-11-10: the window got every bot's chats every 5 s and with every command's reply, 64 MB each on the user's data.
test('a state stream sends everything once and then only changes; a reply is not counted as sent and applies only on its own push', t => {
  const { stateStream, acceptState, keepSessions, FULL_STATE_MS } = require('../ui/agent-state.js');
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const chat = (id, text) => ({ id, status: 'idle', items: [{ id: id + '-item', type: 'agentMessage', text }] });
  const fleet = (a, b) => ({ agentStates: { a: { stateRevision: a, sessions: [chat('a1', 'a' + a)] }, b: { stateRevision: b, sessions: [chat('b1', 'b' + b)] } } });
  const texts = () => [page.agentStates.a.sessions[0].items[0].text, page.agentStates.b.sessions[0].items[0].text];
  const stream = stateStream(), applied = {};
  let page = null;
  const apply = sent => {
    const next = structuredClone(sent);
    if (!acceptState(next, applied)) return false;
    page = keepSessions(next, page);
    return true;
  };
  assert.equal(stream.started, false);
  const first = stream.push(fleet(1, 1));
  assert.ok(first.agentStates.a.sessions && first.agentStates.b.sessions && stream.started, 'the first state is complete');
  apply(first);
  t.mock.timers.tick(6000);
  const idle = stream.push(fleet(1, 1));
  assert.deepEqual([idle.agentStates.a.sessionsKept, idle.agentStates.b.sessionsKept], [true, true], 'nothing is sent again after 5 s');
  apply(idle);

  const reply = stream.reply(fleet(2, 1));
  assert.equal(reply.stateBase, idle.stateSeq, 'a reply names the push it builds on');
  assert.deepEqual([reply.agentStates.a.sessions[0].items[0].text, reply.agentStates.b.sessionsKept], ['a2', true]);
  const push = stream.push(fleet(3, 1));
  assert.equal(push.agentStates.a.sessions?.[0].items[0].text, 'a3', 'what a reply carried is not counted as sent');
  // The page applied the newer push first: the older reply is dropped, not put over the newer chats.
  assert.equal(apply(push), true);
  assert.equal(apply(reply), false);
  assert.deepEqual(texts(), ['a3', 'b1']);
  assert.equal(apply(stream.reply(fleet(4, 1))), true, 'a reply built on the push the page shows applies');
  assert.deepEqual(texts(), ['a4', 'b1']);
  assert.equal(acceptState({ sessions: [] }, applied), true, 'a state with no number applies as before');
  assert.equal(acceptState({ stateBase: -1 }, applied), false, 'a reply for a page with no stream is dropped');
  assert.equal(acceptState({ stateBase: applied.seq + 1 }, applied), true, 'a reply ahead of a lagging page applies; its pushes follow');
  assert.equal(acceptState({ stateBase: applied.seq }, {}), false, 'a page that holds nothing waits for its first state');

  t.mock.timers.tick(FULL_STATE_MS);
  assert.ok(stream.push(fleet(4, 1)).agentStates.b.sessions, 'everything goes again after FULL_STATE_MS, as a repair');
  assert.equal(stream.push(fleet(4, 1)).agentStates.b.sessionsKept, true);
  stream.reset();
  assert.equal(stream.started, false);
  assert.ok(stream.push(fleet(4, 1)).agentStates.b.sessions, 'a page that holds nothing gets everything');
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

// 2026-11-12, the user: a streaming chat went whole on every update (5.9 MB for 5,500 messages, up to 10 a second).
test('a resent chat carries only its changed and new messages, merged by id; reorders, duplicate ids and full states go whole', t => {
  const { stateStream, acceptState, keepSessions, FULL_STATE_MS } = require('../ui/agent-state.js');
  t.mock.timers.enable({ apis: ['Date'], now: 1000 });
  const fleet = (revision, items) => ({ agentStates: { main: { stateRevision: revision, sessions: [{ id: 'c', status: 'running', items }] } } });
  const message = (id, text) => ({ id, type: 'agentMessage', text });
  const stream = stateStream(), applied = {};
  let page = null;
  const apply = next => { next = structuredClone(next); if (!acceptState(next, applied)) return null; const merged = keepSessions(next, page); if (merged) page = merged; return merged; };
  const sentItems = next => next.agentStates.main.sessions[0];
  const shown = () => page.agentStates.main.sessions[0].items.map(item => item.text);

  let state = [message('a', 'A'), message('b', 'B'), message('c', 'C')];
  apply(stream.push(fleet(1, state)));
  assert.equal(sentItems(stream.push(fleet(2, state))).itemsFrom, undefined, 'the first change after a full state goes whole');
  apply(stream.push(fleet(2, state)));
  state = [message('a', 'A'), message('b', 'B, streamed'), message('c', 'C'), message('d', 'D')];
  const delta = stream.push(fleet(3, state));
  assert.deepEqual([sentItems(delta).items.map(item => item.id), sentItems(delta).itemsFrom, sentItems(delta).itemCount], [['b', 'd'], 3, 4]);
  const kept = page.agentStates.main.sessions[0].items[0];
  apply(delta);
  assert.deepEqual(shown(), ['A', 'B, streamed', 'C', 'D']);
  assert.equal(page.agentStates.main.sessions[0].items[0], kept, 'an unchanged message keeps the copy the window holds');
  assert.equal(page.agentStates.main.sessions[0].itemsFrom, undefined);

  // A reply trims against what the page was pushed, and is not recorded: the chat it carried goes whole on the next push.
  state = [...state.slice(0, 3), message('d', 'D, done')];
  const reply = stream.reply(fleet(4, state));
  assert.deepEqual(sentItems(reply).items.map(item => item.id), ['d']);
  assert.ok(apply(reply));
  assert.deepEqual(sentItems(stream.push(fleet(4, state))).items.map(item => item.id), ['a', 'b', 'c', 'd']);

  // A copy that does not match (a missed update) asks for a full state instead of merging.
  const mismatch = stream.push(fleet(5, [...state, message('e', 'E')]));
  const short = structuredClone(page); short.agentStates.main.sessions[0].items.pop();
  assert.equal(keepSessions(structuredClone(mismatch), short), null);
  page = keepSessions(structuredClone(mismatch), page);
  state = [...state, message('e', 'E')];
  assert.deepEqual(shown(), ['A', 'B, streamed', 'C', 'D, done', 'E']);

  // Removed or reordered earlier messages, and duplicate ids, go whole.
  state = [state[1], state[0], ...state.slice(2)];
  assert.equal(sentItems(stream.push(fleet(6, state))).itemsFrom, undefined, 'reordered');
  state = [...state, message('a', 'again')];
  assert.equal(sentItems(stream.push(fleet(7, state))).itemsFrom, undefined, 'duplicate id');
  state = state.slice(1, 3);
  assert.equal(sentItems(stream.push(fleet(8, state))).itemsFrom, undefined, 'removed');
  assert.ok(sentItems(stream.push(fleet(9, [...state, message('f', 'F')]))).itemsFrom !== undefined, 'deltas resume');

  // The 10-minute full state sends every chat whole and records no message texts; deltas start again after it.
  t.mock.timers.tick(FULL_STATE_MS);
  const full = stream.push(fleet(10, [...state, message('f', 'F')]));
  assert.equal(sentItems(full).itemsFrom, undefined);
  assert.equal(sentItems(full).items.length, 3);
  assert.equal(sentItems(stream.push(fleet(11, [...state, message('f', 'F')]))).itemsFrom, undefined);
  assert.ok(sentItems(stream.push(fleet(12, [...state, message('f', 'F2')]))).itemsFrom !== undefined);
});

// A send's reply adds the message and pendingMessage, and the turn then clears pendingMessage back to what the last push
// held: a delta built on that push would leave the page with the reply's copy (a stuck pending message, and a message
// count that asks for a full state on every send).
test('a chat a reply carried goes whole on its next push, then deltas resume', () => {
  const { stateStream, acceptState, keepSessions } = require('../ui/agent-state.js');
  const fleet = (revision, chat) => ({ agentStates: { main: { stateRevision: revision, sessions: [chat] } } });
  const message = (id, text) => ({ id, type: 'agentMessage', text });
  const stream = stateStream(), applied = {};
  let page = null;
  const apply = next => { next = structuredClone(next); if (!acceptState(next, applied)) return false; page = keepSessions(next, page); return !!page; };
  const held = () => page.agentStates.main.sessions[0];
  const items = [message('a', 'A'), message('b', 'B')];
  apply(stream.push(fleet(1, { id: 'c', status: 'idle', items })));
  apply(stream.push(fleet(2, { id: 'c', status: 'idle', items })));

  assert.ok(apply(stream.reply(fleet(3, { id: 'c', status: 'idle', pendingMessage: 'Q', items: [...items, message('q', 'Q')] }))));
  assert.equal(held().pendingMessage, 'Q');
  const started = { id: 'c', status: 'running', items: [...items, message('q', 'Q'), message('r', 'R')] };
  const next = stream.push(fleet(4, started));
  assert.equal(next.agentStates.main.sessions[0].itemsFrom, undefined, 'the chat goes whole once');
  assert.ok(apply(next));
  assert.deepEqual(held(), started);

  const streamed = { ...started, items: [...started.items.slice(0, 3), message('r', 'R, streamed')] };
  const delta = stream.push(fleet(5, streamed));
  assert.deepEqual(delta.agentStates.main.sessions[0].items.map(item => item.id), ['r'], 'deltas resume');
  assert.ok(apply(delta));
  assert.deepEqual(held(), streamed);
  // A reply that carried nothing for the chat leaves its deltas alone.
  stream.reply(fleet(5, streamed));
  assert.notEqual(stream.push(fleet(6, { ...streamed, title: 'T' })).agentStates.main.sessions[0].itemsFrom, undefined);
});

test('a chat delta sends only changed fields and route entries; a chat-scoped push compares only the newest messages, a reply all of them', () => {
  const { stateStream, acceptState, keepSessions } = require('../ui/agent-state.js');
  const many = Array.from({ length: 80 }, (_, i) => ({ id: 'm' + i, type: 'agentMessage', text: 'm' + i }));
  const fleet = (shared, own, chat) => ({ agentStates: { main: { stateRevision: shared, sharedRevision: shared, chatRevisions: { c: own }, sessions: [chat] } } });
  const chat = (items, extra = {}) => ({ id: 'c', status: 'running', title: 'T', items, routes: [{ messageId: 'm0', label: 'A' }], tasks: [], queue: [], ...extra });
  const stream = stateStream(), applied = {};
  let page = null;
  const apply = next => { next = structuredClone(next); if (!acceptState(next, applied)) return false; page = keepSessions(next, page); return !!page; };
  const held = () => page.agentStates.main.sessions[0];
  apply(stream.push(fleet(1, 0, chat(many))));
  apply(stream.push(fleet(2, 0, chat(many))));

  // Streamed text (a chat-scoped change): only the newest message goes, with no unchanged field.
  let items = many.map((item, i) => (i === 79 ? { ...item, text: 'm79 streaming' } : item));
  const streamed = stream.push(fleet(2, 3, chat(items)));
  assert.deepEqual(Object.keys(streamed.agentStates.main.sessions[0]).sort(), ['id', 'itemCount', 'items', 'itemsFrom']);
  assert.ok(apply(streamed));
  assert.equal(held().items[79].text, 'm79 streaming');
  assert.equal(held().title, 'T', 'unchanged fields stay');

  // An old message edited alongside a chat-scoped change is left to a later exact comparison.
  items = items.map((item, i) => (i === 3 ? { ...item, text: 'm3 undone' } : item));
  assert.deepEqual(stream.push(fleet(2, 4, chat(items))).agentStates.main.sessions[0].items, [], 'the tail had nothing new');

  // A shared change compares everything; fields, removed fields and route entries go as changes.
  const next = chat(items, { title: 'Renamed', routes: [{ messageId: 'm0', label: 'A, done' }, { messageId: 'm80', label: 'B' }] });
  delete next.queue;
  const shared = stream.push(fleet(6, 4, next)).agentStates.main.sessions[0];
  assert.deepEqual(shared.items.map(item => item.id), ['m3'], 'the exact comparison finds the old edit the tail missed');
  assert.equal(shared.title, 'Renamed');
  assert.deepEqual(shared.removedFields, ['queue']);
  assert.deepEqual(shared.listChanges.routes, { from: 1, length: 2, entries: [[0, { messageId: 'm0', label: 'A, done' }], [1, { messageId: 'm80', label: 'B' }]] });
  page = keepSessions(structuredClone({ agentStates: { main: { stateRevision: 6, sessions: [shared] } } }), page);
  assert.equal(held().title, 'Renamed');
  assert.equal('queue' in held(), false);
  assert.deepEqual(held().routes.map(route => route.label), ['A, done', 'B']);
  assert.equal(held().items[3].text, 'm3 undone');

  // A reply compares every message, so an old edit beside a chat-scoped change goes at once.
  items = items.map((item, i) => (i === 4 ? { ...item, text: 'm4 undone' } : item));
  const reply = stream.reply(fleet(6, 7, chat(items, { title: 'Renamed', routes: next.routes, queue: undefined })));
  assert.deepEqual(reply.agentStates.main.sessions[0].items.map(item => item.id), ['m4']);
  assert.ok(apply(reply));
  assert.equal(held().items[4].text, 'm4 undone');

  // A shorter route list cannot be patched by position: the chat goes whole.
  assert.equal(stream.push(fleet(7, 5, chat(items, { routes: [] }))).agentStates.main.sessions[0].itemsFrom, undefined);
});

// 2026-11-14: all 1,522 of the user's job budgets went with every update (0.56 MB, about 2.6 ms to send and read).
test('job budgets go whole once, then only the changed and removed ones; a page without them asks for everything', t => {
  const { stateStream, keepSessions, FULL_STATE_MS } = require('../ui/agent-state.js');
  const stream = stateStream();
  const fleet = jobBudgets => ({ agentStates: { main: { stateRevision: 1, sharedRevision: 1, sessions: [] } }, jobBudgets });
  const page = keepSessions(stream.push(fleet({ a: { state: 'active', usedMs: 1 }, b: { state: 'active', usedMs: 2 } })), null);
  assert.deepEqual(Object.keys(page.jobBudgets), ['a', 'b']);
  const quiet = stream.push(fleet({ a: { state: 'active', usedMs: 1 }, b: { state: 'paused', usedMs: 2 }, c: { state: 'active', usedMs: 0 } }));
  assert.deepEqual([Object.keys(quiet.jobBudgets), quiet.jobBudgetsDelta], [['b', 'c'], true], 'only the changed and new budgets');
  const merged = keepSessions(quiet, page);
  assert.deepEqual(merged.jobBudgets, { a: { state: 'active', usedMs: 1 }, b: { state: 'paused', usedMs: 2 }, c: { state: 'active', usedMs: 0 } });
  assert.equal(merged.jobBudgetsDelta, undefined);
  const removed = stream.push(fleet({ a: { state: 'active', usedMs: 1 }, c: { state: 'active', usedMs: 0 } }));
  assert.deepEqual([removed.jobBudgets, removed.jobBudgetsRemoved], [{}, ['b']]);
  assert.deepEqual(Object.keys(keepSessions(removed, merged).jobBudgets), ['a', 'c']);
  assert.equal(keepSessions(stream.push(fleet({ a: { state: 'paused', usedMs: 1 } })), { agentStates: {} }), null, 'no budgets held: ask for everything');
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + FULL_STATE_MS });
  const repair = stream.push(fleet({ a: { state: 'paused', usedMs: 1 } }));
  assert.deepEqual([Object.keys(repair.jobBudgets), repair.jobBudgetsDelta], [['a'], undefined], 'the 10-minute full state sends them all');
});
