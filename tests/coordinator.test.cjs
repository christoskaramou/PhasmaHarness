const { readSessionData } = require('../src/session-store.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const { Controller } = require('../src/controller.cjs');
const { Agents } = require('../src/agents.cjs');
const { SmartRouter, conversationDelta } = require('../src/routing/smart-router.cjs');

const answer = reply => ({ reply, action: null });

test('Main Bot receives current shared project rules and the active AppData wiki without worker-only defaults', async t => {
  const { hub, session, calls, send, root } = await setup(t);
  hub.wikiStore = new (require('../src/workspace/wiki-store.cjs').WikiStore)(path.join(root, 'Wikis'));
  const entry = path.join(session.workspace, 'PhasmaHarness.md');
  fs.writeFileSync(entry, 'Main project rule first.');
  await send('Hello');
  const instructions = () => calls.findLast(call => call.request.schema.properties.action).request.instructions;
  assert.match(instructions(), /Main project rule first/);
  assert.ok(instructions().includes(JSON.stringify(path.join(hub.wikiStore.location(session.workspace).root, 'index.md'))));
  assert.doesNotMatch(instructions(), /Harness skills/);
  fs.writeFileSync(entry, 'Main project rule updated.');
  await send('Continue');
  assert.match(instructions(), /Main project rule updated/);
  assert.doesNotMatch(instructions(), /Main project rule first/);
});

test('completed worker survives a Main Bot follow-up timeout without replaying the assignment', async t => {
  const { hub, session, agents, replies, send } = await setup(t);
  replies.push(action('agent_work', { name: 'Worker', task: 'Say hello.' }));
  await send('Ask Worker to say hello.');
  const worker = agents.execution(session.hubWorker), work = agents.conversation(worker);
  await until(() => worker.activeTurns.size > 0);
  hub.smartRouter.complete = async () => { throw new Error('The model took too long to respond.'); };
  worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId,
    item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Hello.' } } });
  worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
  await until(() => session.items.at(-1)?.text?.includes('My follow-up could not finish') && !session.queue?.length);
  assert.equal(session.status, 'completed');
  assert.equal(session.error, null);
  assert.equal(session.hubCompletion.fulfilled, false);
  assert.equal(work.delegation.delivered, true);
  assert.equal(session.items.filter(item => item.type === 'agentResult').length, 1);
  assert.equal(session.agentDelegations, 1);
  const saved = readSessionData(hub.filename);
  assert.equal(saved.sessions.find(chat => chat.id === session.id).status, 'completed');
});
const action = (tool, args) => ({ reply: '', action: { tool, arguments: args } });
test('failed worker reviews count batch receipts, but storage and budget failures stay visible', async t => {
  const { hub, session } = await setup(t);
  const input = { text: 'Done.', images: [], mode: 'terra-light', agentReply: true,
    agentResult: { agentId: 'main', status: 'completed', request: { id: 'request', text: 'Say hello.', batch: { id: 'batch', index: 1, count: 2 } } } };
  hub.smartRouter.complete = async () => { throw new Error('Review timeout'); };
  await hub.sendCoordinator(session, input);
  assert.equal(session.items.find(item => item.hubBatchResult)?.hubBatchResult.fulfilled, false);
  assert.equal(session.items.find(item => item.hubBatchResult)?.hubBatchResult.index, 1);
  hub.smartRouter.complete = async () => { throw Object.assign(new Error('Budget held'), { code: 'JOB_BUDGET_HOLD' }); };
  await assert.rejects(hub.sendCoordinator(session, input), /Budget held/);
  hub.smartRouter.complete = async () => { throw Object.assign(new Error('Budget save failed'), { budgetPersistenceFailed: true }); };
  await assert.rejects(hub.sendCoordinator(session, input), /Budget save failed/);
  const save = hub.save.bind(hub); let fail = true;
  hub.save = () => { if (fail) { fail = false; throw new Error('Storage unavailable'); } return save(); };
  await assert.rejects(hub.sendCoordinator(session, input), /Storage unavailable/);
  assert.equal(session.status, 'failed');
});
class Client extends EventEmitter {
  constructor() { super(); this.calls = []; }
  async start() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } };
    if (method === 'model/list') return { data: ['gpt-5.6-terra', 'gpt-5.6-sol'].map(model => ({ model, supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }] })) };
    if (method === 'thread/start') return { thread: { id: randomUUID() } };
    if (method === 'turn/start') return { turn: { id: randomUUID() } };
    if (method === 'thread/items/list') return { data: [] };
    return {};
  }
  close() {}
}
async function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-hub-'));
  const calls = [], replies = [], assessments = [];
  const factory = (file, cwd, options) => {
    const c = new Controller(file, cwd, new Client(), {
      cancel() {}, close() {},
      async choose() { return { id: 'terra-light', model: 'gpt-5.6-terra', effort: 'low', provider: 'codex', source: 'smart', needsChecks: false }; },
      async chooseHub(workers) { return workers.find(p => p.effort === 'low') || workers[0]; },
      async complete(request, choice, abort) {
        calls.push({ request, choice, abort });
        return { decision: request.schema.properties.summary ? { summary: 'User intent and pending work retained.' }
          : request.schema.properties.reflection ? { reflection: 'keep', rule: '', moment: '', reason: 'Fixture.' }
          : request.schema.properties.fulfilled ? assessments.shift() || { fulfilled: true, evidence: 'The fixture worker completed the requested task.', gaps: [] }
          : replies.shift() || answer('Hello.') };
      },
    }, options);
    c.claude.refresh = async () => c.claude.status;
    c.cursor.refresh = async () => c.cursor.status;
    return c;
  };
  const hub = factory(path.join(root, 'sessions.json'), root);
  await hub.initialize(); hub.data.settings.mode = 'terra-light';
  const agents = new Agents(hub, async () => {}, factory);
  const session = agents.conversation(hub, true, root, 'workspace-write');
  t.after(async () => {
    agents.closing = true; agents.pump();
    await agents.routines.close();
    await agents.workspaces.close();
    await Promise.all(agents.initializing.values());
    for (const c of agents.allControllers()) c.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const send = text => hub.send({ id: session.id, text });
  return { root, hub, session, agents, calls, replies, assessments, send };
}
async function until(check, timeout = 5000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (check()) return; await new Promise(r => setTimeout(r, 10)); }
  assert.ok(check(), 'Condition did not become true');
}

test('Hub planning receives the current chat access independently of its read-only runtime', async t => {
  const { hub, session, calls, send } = await setup(t);
  for (const access of ['danger-full-access', 'workspace-write', 'read-only']) {
    hub.permissions(session.id, access);
    await send('Explain which access my delegated workers may use.');
    await until(() => !hub.busy);
    const { request } = calls.filter(call => call.request.schema.properties.reply).at(-1);
    assert.equal(JSON.parse(request.prompt).access, access);
    assert.equal(session.access, access);
  }
});

function projectFixture(root, session, { repository = true } = {}) {
  const project = path.join(root, 'project'); fs.mkdirSync(project);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=Harness fixture', '-c', 'user.email=fixture@invalid', ...args],
    { cwd: project, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  if (repository) git('init', '-q');
  fs.writeFileSync(path.join(project, 'code.c'), 'original source');
  if (repository) { git('add', '.'); git('commit', '-qm', 'Fixture baseline'); }
  fs.writeFileSync(path.join(project, 'code.c'), 'dirty source at setup');
  session.workspace = project;
  return project;
}

async function routineSetup(t) {
  const value = await setup(t), { agents, root } = value;
  let now = Date.parse('2026-10-18T08:00:00Z'), head = 'a'.repeat(40);
  agents.routines.now = () => now;
  agents.routines.readHead = async () => head;
  const addBot = async name => {
    const profile = await agents.saveAgent({ name, instructions: 'Answer in your own chat.', workspace: root, access: 'workspace-write', mode: 'terra-light' });
    const bot = agents.controller(profile.id);
    await agents.initializeController(bot);
    return { profile, bot, chat: agents.conversation(bot, true, root, 'workspace-write') };
  };
  // Saves a routine the way Hub does when the user asks for one in chat.
  const hubSave = async args => {
    value.replies.push(action('routine', { action: 'save', ...args }));
    await value.send('Set that up, please.');
    return Object.values(agents.routines.records).at(-1);
  };
  // Ends the bot's current turn; a queued message may start the next one straight away.
  const finish = async (bot, chat) => {
    const turnId = chat.turnId;
    bot.notification({ method: 'item/completed', params: { threadId: chat.threadId, turnId: chat.turnId,
      item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Done.' } } });
    bot.notification({ method: 'turn/completed', params: { threadId: chat.threadId, turn: { id: chat.turnId, status: 'completed' } } });
    await until(() => !bot.activeTurns.has(chat.id) || chat.turnId !== turnId);
  };
  const posted = chat => chat.items.filter(item => item.routineRun);
  return { ...value, addBot, hubSave, finish, posted, clock: at => { now = Date.parse(at); }, commit: id => { head = id.repeat(40); } };
}

test('a Hub routine sends its saved text back into its chat on schedule, once for missed times, and reports its agent', async t => {
  const { agents, hub, session, hubSave, posted, clock, replies } = await routineSetup(t);
  const routine = await hubSave({ text: 'Summarize the open tasks.', time: '09:00', timeZone: 'UTC', days: '1,2,3,4,5' });
  assert.equal(routine.agentId, 'main');
  assert.equal(routine.ownerId, session.id);
  assert.equal(routine.name, 'Summarize the open tasks.', 'an unnamed routine is named after its text');
  assert.match(session.items.at(-1).text, /Saved routine Summarize the open tasks\. for Hub: Mon–Fri at 09:00 \(UTC\)/);
  assert.equal(routine.next.at, Date.parse('2026-10-19T09:00Z'), '18 October 2026 is a Sunday, so the first run is Monday');

  replies.push(answer('Two tasks are open.'));
  clock('2026-10-22T12:00Z'); await agents.routines.tick();
  await until(() => !hub.busy && posted(session).length === 1);
  assert.equal(posted(session)[0].content[0].text, 'Summarize the open tasks.');
  assert.equal(posted(session)[0].routineRun.id, routine.id);
  assert.equal(session.items.at(-1).text, 'Two tasks are open.');
  assert.equal(routine.next.at, Date.parse('2026-10-23T09:00Z'), 'three missed weekdays produce one run');

  await agents.routines.tick();
  assert.equal(routine.run, null);
  assert.equal(routine.last.at, Date.parse('2026-10-22T12:00Z'));
  const [report] = await agents.tool(hub, session, 'routines_report', {});
  assert.deepEqual({ agent: report.agent, trigger: report.trigger, state: report.state, text: report.text },
    { agent: 'Hub', trigger: 'Mon–Fri at 09:00 (UTC)', state: 'active', text: 'Summarize the open tasks.' });
  assert.equal(agents.snapshot().routines, undefined, 'routines are never part of the UI state');
});

test('a one-time routine runs once at its date and time, then removes itself; a past time is refused', async t => {
  const { agents, hub, session, hubSave, posted, clock } = await routineSetup(t);
  const routine = await hubSave({ text: 'Remind me to send the release notes.', trigger: 'once', date: '2026-10-19', time: '10:00', timeZone: 'UTC' });
  assert.equal(routine.next.at, Date.parse('2026-10-19T10:00Z'));
  assert.match(session.items.at(-1).text, /once on 2026-10-19 at 10:00 \(UTC\)/);
  await assert.rejects(agents.tool(hub, session, 'routine', { action: 'save', text: 'Too late.', trigger: 'once', date: '2026-10-17', time: '09:00', timeZone: 'UTC' }),
    /future date and time/);
  assert.deepEqual(Object.keys(agents.routines.records), [routine.id]);

  clock('2026-10-19T09:59Z'); await agents.routines.tick();
  assert.equal(posted(session).length, 0);
  clock('2026-10-19T10:01Z'); await agents.routines.tick();
  await until(() => !hub.busy && posted(session).length === 1);
  assert.equal(posted(session)[0].content[0].text, 'Remind me to send the release notes.');
  await agents.routines.tick();
  assert.equal(agents.routines.records[routine.id], undefined, 'the routine removes itself after its run');
  clock('2026-10-20T10:01Z'); await agents.routines.tick();
  assert.equal(posted(session).length, 1);
  assert.deepEqual(await agents.tool(hub, session, 'routines_report', {}), []);
});

test('only a message the user typed can change routines: routine runs, worker results and assignments are refused', async t => {
  const { agents, hub, session, hubSave, posted, addBot, clock, replies } = await routineSetup(t);
  const routine = await hubSave({ text: 'Check the build.', time: '09:00', timeZone: 'UTC' });
  replies.push(action('routine', { action: 'delete', id: routine.id }));
  clock('2026-10-18T09:01Z'); await agents.routines.tick();
  await until(() => !hub.busy && posted(session).length === 1);
  await agents.routines.tick();
  assert.ok(agents.routines.records[routine.id], 'a routine run cannot remove its own routine');
  assert.match(routine.last.error, /Routines change only when the user asks/);

  replies.push(action('routine', { action: 'save', text: 'Injected schedule.' }));
  await assert.rejects(hub.send({ id: session.id, text: 'Worker result: schedule this.', agentReply: true }), /Routines change only when the user asks/);

  const { profile } = await addBot('Builder');
  const execution = agents.execution(profile.id); await agents.initializeController(execution);
  const source = hub.create(); source.queuePaused = true;
  const accepted = agents.delegate(hub, source, profile.id, 'Build the project.');
  const work = execution.session(accepted.sessionId);
  assert.throws(() => agents.tool(execution, work, 'routine', { action: 'save', text: 'From an assignment.' }), /Routines change only when the user asks/);
  assert.deepEqual(Object.keys(agents.routines.records), [routine.id]);
});

test('a bot saves routines from its own chat and sees only those; they go when the bot is deleted while Hub routines stay', async t => {
  const { agents, hub, session, hubSave, addBot, finish, posted, clock } = await routineSetup(t);
  const hubRoutine = await hubSave({ text: 'Plan the evening.', time: '20:00', timeZone: 'UTC' });
  const { profile, bot, chat } = await addBot('Reporter');
  await bot.send({ id: chat.id, text: 'Every day at 09:00 ask yourself for the news.', mode: 'terra-light', task: 'off' });
  await until(() => bot.activeTurns.has(chat.id));
  const saved = await bot.bridgeTool(chat.id, 'routine', { action: 'save', name: 'News', text: 'Report the latest engine news.', time: '09:00', timeZone: 'UTC' });
  assert.equal(saved.routine.agent, 'Reporter');
  await assert.rejects(bot.bridgeTool(chat.id, 'routine', { action: 'pause', id: hubRoutine.id }), /Choose one of your routines/);
  assert.deepEqual((await bot.bridgeTool(chat.id, 'routines_report', {})).map(item => item.name), ['News']);
  await finish(bot, chat);
  await until(() => !bot.busy);
  assert.deepEqual((await agents.tool(hub, session, 'routines_report', {})).map(item => [item.name, item.agent]),
    [['Plan the evening.', 'Hub'], ['News', 'Reporter']]);

  clock('2026-10-18T09:01Z'); await agents.routines.tick();
  await until(() => posted(chat).length === 1 && bot.activeTurns.has(chat.id));
  const routine = agents.routines.records[saved.routine.id];
  assert.equal(posted(chat)[0].routineRun.id, routine.id, 'the text arrives in the bot’s own chat');
  assert.equal(posted(chat)[0].content[0].text, 'Report the latest engine news.');
  await finish(bot, chat);
  await until(() => !bot.busy);
  await agents.routines.tick();
  assert.equal(routine.run, null);

  await agents.tool(hub, session, 'routine', { action: 'pause', id: routine.id });
  assert.equal(routine.enabled, false, 'Hub can change every routine');
  await agents.deleteAgent(profile.id);
  assert.deepEqual(Object.keys(agents.routines.records), [hubRoutine.id]);
});

test('a routine waits for its previous run, even across a restart, and an unready agent keeps the occurrence', async t => {
  const { Routines } = require('../src/routines.cjs');
  const { agents, addBot, finish, posted, clock } = await routineSetup(t);
  const { bot, chat } = await addBot('Reporter');
  await bot.send({ id: chat.id, text: 'Save a daily check.', mode: 'terra-light', task: 'off' });
  await until(() => bot.activeTurns.has(chat.id));
  const { routine: { id } } = await bot.bridgeTool(chat.id, 'routine', { action: 'save', text: 'Run the daily check.', time: '09:00', timeZone: 'UTC' });
  const queued = () => (chat.queue || []).filter(message => message.routineRun).length;

  clock('2026-10-18T09:01Z'); await agents.routines.tick();
  assert.equal(queued(), 1, 'a busy chat queues the routine message');
  const key = agents.routines.records[id].lastKey, now = agents.routines.now;
  await agents.routines.close();
  agents.routines = new Routines(agents, { now, readHead: async () => 'a'.repeat(40) });
  clock('2026-10-19T09:01Z'); await agents.routines.tick();
  assert.equal(queued(), 1, 'the queued run still counts after a restart, so the next day waits');
  assert.equal(agents.routines.records[id].lastKey, key);

  await finish(bot, chat);
  await until(() => posted(chat).length === 1 && bot.activeTurns.has(chat.id));
  await finish(bot, chat);
  await until(() => !bot.busy);
  await agents.routines.tick();
  await until(() => posted(chat).length === 2 && bot.activeTurns.has(chat.id));
  await finish(bot, chat);
  await until(() => !bot.busy);
  await agents.routines.tick();
  const record = agents.routines.records[id];
  assert.equal(record.run, null);

  bot.blockedReason = () => 'Blocked for the test.';
  clock('2026-10-20T09:01Z'); await agents.routines.tick();
  assert.equal(record.run, null);
  assert.equal(record.next.at, Date.parse('2026-10-20T09:00Z'), 'an agent that cannot take the message yet keeps the occurrence');
  delete bot.blockedReason;
  await agents.routines.tick();
  await until(() => posted(chat).length === 3 && bot.activeTurns.has(chat.id));
  await finish(bot, chat);
});

test('a routine is held when its chat gains access after saving, and saving again from chat re-approves it', async t => {
  const { agents, session, hubSave, posted, clock, replies, send } = await routineSetup(t);
  const routine = await hubSave({ text: 'Tidy the workspace.', time: '09:00', timeZone: 'UTC' });
  assert.equal(routine.access, 'workspace-write');
  session.access = 'danger-full-access';
  clock('2026-10-18T09:01Z'); await agents.routines.tick();
  assert.equal(routine.enabled, false);
  assert.match(routine.error, /access was raised/);
  assert.equal(posted(session).length, 0);
  replies.push(action('routine', { action: 'resume', id: routine.id }));
  await send('Keep that routine running with this access.');
  const resumed = agents.routines.records[routine.id];
  assert.equal(resumed.enabled, true);
  assert.equal(resumed.error, null);
  assert.equal(resumed.access, 'danger-full-access');

  const save = agents.primary.save;
  agents.primary.save = () => { throw new Error('Disk unavailable'); };
  await assert.rejects(agents.tool(agents.primary, session, 'routine', { action: 'save', text: 'Will not be saved.' }), /Disk unavailable/);
  agents.primary.save = save;
  assert.deepEqual(Object.keys(agents.routines.records), [routine.id]);
});

test('a Git routine takes the commit its finished run left as the new baseline, so its own commits do not start it again', async t => {
  const { agents, hub, session, hubSave, posted, clock, commit } = await routineSetup(t);
  const routine = await hubSave({ text: 'Review the newest commit.', trigger: 'git' });
  assert.equal(routine.head, 'a'.repeat(40));
  assert.match(routine.name, /Review the newest commit/);
  await agents.routines.tick(); assert.ok(!routine.run);

  commit('b'); clock('2026-10-18T08:01Z'); await agents.routines.tick();
  assert.equal(routine.head, 'b'.repeat(40));
  commit('c'); // the run's own commit
  await until(() => !hub.busy && posted(session).length === 1);
  await agents.routines.tick();
  assert.equal(routine.run, null);
  assert.equal(routine.head, 'c'.repeat(40), 'the baseline is taken as soon as the run settles, without waiting for a Git poll');
  assert.equal(routine.rebaseHead, undefined);

  agents.routines.gitNext = 0; clock('2026-10-18T08:03Z'); await agents.routines.tick();
  assert.equal(posted(session).length, 1, 'the run’s own commit does not start another run');

  commit('d'); agents.routines.gitNext = 0; clock('2026-10-18T08:04Z'); await agents.routines.tick();
  await until(() => !hub.busy && posted(session).length === 2);
  assert.equal(routine.head, 'd'.repeat(40), 'a later commit still starts the routine');
});

test('a paused Git routine cannot fire on a stale read, and shutdown waits for its Git read', async t => {
  const { agents, session, hubSave, posted, clock } = await routineSetup(t);
  const routine = await hubSave({ text: 'Check new commits.', trigger: 'git' });
  let release;
  agents.routines.readHead = () => new Promise(resolve => { release = resolve; });
  clock('2026-10-18T09:00Z');
  const tick = agents.routines.tick(); await until(() => !!release);
  assert.equal(agents.routines.busy, true);
  await agents.tool(agents.primary, session, 'routine', { action: 'pause', id: routine.id });
  release('b'.repeat(40)); await tick;
  assert.ok(!routine.run);
  assert.equal(posted(session).length, 0);

  routine.enabled = true; release = null; agents.routines.gitNext = 0; clock('2026-10-18T10:00Z');
  const second = agents.routines.tick(); await until(() => !!release);
  let closed = false; const close = agents.routines.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(closed, false);
  release('c'.repeat(40)); await Promise.all([second, close]);
  assert.ok(!routine.run);
});

test('a routine watches an actual local Git HEAD without network access or model polling', async t => {
  const { root, agents, hub, session, replies, send } = await setup(t);
  const project = projectFixture(root, session);
  replies.push(action('routine', { action: 'save', text: 'Report the current project state.', trigger: 'git' }));
  await send('Whenever I commit, report the project state.');
  const routine = Object.values(agents.routines.records)[0], initial = routine.head;
  assert.equal(routine.workspace, project);
  await agents.routines.tick(); assert.ok(!routine.run);
  execFileSync('git', ['-C', project, '-c', 'user.name=Harness fixture', '-c', 'user.email=fixture@invalid',
    'commit', '--allow-empty', '-qm', 'Second fixture state'], { windowsHide: true });
  agents.routines.gitNext = 0; await agents.routines.tick();
  assert.notEqual(routine.head, initial);
  assert.match(routine.head, /^[a-f0-9]{40,64}$/);
  await until(() => !hub.busy && session.items.some(item => item.routineRun));
});

test('the routine timer fires a due routine without manual polling and stops on close', async t => {
  const { agents, session, hubSave, posted } = await routineSetup(t);
  await hubSave({ text: 'Timer check.', time: '09:00', timeZone: 'UTC' });
  const started = Date.now(), base = Date.parse('2026-10-18T08:59:59.900Z');
  agents.routines.now = () => base + Date.now() - started;
  agents.routines.start();
  await until(() => posted(session).length === 1, 5000);
  await agents.routines.close();
  assert.equal(agents.routines.closed, true);
  agents.routines.start(); await agents.routines.tick();
  assert.equal(posted(session).length, 1);
});

test('a routine follows its chat through Clear, and its chat cannot be archived until the user asks to remove it', async t => {
  const { agents, hub, session, hubSave, posted, clock } = await routineSetup(t);
  const routine = await hubSave({ text: 'Morning check.', time: '09:00', timeZone: 'UTC' });
  assert.throws(() => hub.archive(session.id), /Ask to remove this chat’s routines/);
  const fresh = await agents.clearConversation('main', async () => true);
  assert.equal(routine.ownerId, fresh.id);
  clock('2026-10-18T09:01Z'); await agents.routines.tick();
  await until(() => !hub.busy && posted(fresh).length === 1);
  assert.equal(posted(session).length, 0);
});

test('a restricted worker can retrieve its long assigned input without reading a Full-access owner history', async t => {
  const { agents, session, root } = await setup(t);
  const profile = await agents.saveAgent({ name: 'Reader', instructions: 'Read the assignment.', workspace: root, access: 'read-only', mode: 'terra-light' });
  const worker = agents.execution(profile.id); await agents.initializeController(worker);
  session.access = 'danger-full-access'; session.queuePaused = true;
  session.items.push({ type: 'agentMessage', text: 'PRIVATE_OWNER_HISTORY' });
  const input = 'Inspect the supplied input.\n' + 'context '.repeat(2500) + '\nALLOWED_TAIL_CONTENT';
  const message = { id: randomUUID(), type: 'userMessage', content: [{ type: 'text', text: input }] };
  session.items.push(message);
  const accepted = agents.delegate(agents.primary, session, profile.id, 'Inspect the supplied input.', [], { id: message.id, text: message.content[0].text });
  await until(() => !!worker.activeTurns.size);
  const work = worker.session(accepted.sessionId);
  assert.equal(work.access, 'read-only');
  const context = await worker.bridgeTool(work.id, 'agent_read_context', { agentId: 'main', query: 'ALLOWED_TAIL_CONTENT' });
  assert.equal(context.origin.scope, 'assignment-input');
  assert.ok(context.excerpts.some(excerpt => excerpt.text.includes('ALLOWED_TAIL_CONTENT')));
  const full = await worker.bridgeTool(work.id, 'agent_read_context', { agentId: 'main' });
  assert.doesNotMatch(JSON.stringify(full), /PRIVATE_OWNER_HISTORY/);
  work.delegation.delivered = true;
  assert.throws(() => agents.readContext(work, { agentId: 'main' }), /requires Full access/);
});

test('group mentions dispatch only the named bot without Hub inference and return into the owning group', async t => {
  const { root, hub, session, agents, calls } = await setup(t);
  const coder = await agents.saveAgent({ name: 'Coder', instructions: 'Handle coding questions.', workspace: root, access: 'read-only', mode: 'terra-light' });
  const reviewer = await agents.saveAgent({ name: 'Review bot', instructions: 'Review work.', workspace: root, access: 'workspace-write', mode: 'terra-light' });
  session.items.push({ type: 'agentMessage', text: 'PRIVATE_MAIN_CHAT_CONTEXT' }); hub.save();
  const group = agents.saveGroup({ name: 'Game team', members: [coder.id, reviewer.id] });
  assert.equal(agents.conversation(hub).id, session.id, 'a group never replaces the pinned Hub chat');
  await hub.send({ id: group.id, text: '@Coder inspect the project and explain the result.' });
  assert.equal(calls.length, 0, 'an explicit mention needs no Hub routing call');
  assert.equal(hub.busy, null);
  const worker = agents.execution(coder.id);
  await until(() => worker.activeTurns.size);
  const work = agents.conversation(worker), job = work.delegation;
  assert.equal(job.owner, group.id);
  assert.equal(job.originalRequest.groupId, group.id);
  assert.equal(job.access, 'read-only', 'membership never raises the worker ceiling');
  assert.equal(job.originalRequest.mentionAgentId, coder.id);
  assert.equal(group.items[0].groupMention.jobId, job.id);
  assert.equal(agents.executions.has(reviewer.id), false, 'the other member receives no inference');
  assert.throws(() => agents.saveGroup({ id: group.id, name: group.title, members: [reviewer.id] }), /before removing/);
  const groupContext = JSON.stringify(agents.readContext(work, { agentId: 'main' }));
  assert.match(groupContext, /inspect the project and explain the result/);
  assert.doesNotMatch(groupContext, /PRIVATE_MAIN_CHAT_CONTEXT/);
  assert.throws(() => hub.archive(group.id), /outstanding work/);
  assert.throws(() => hub.deleteSession(group.id), /outstanding work/);
  await hub.send({ id: session.id, text: 'Are you available while Coder works?' });
  assert.equal(session.items.at(-1).text, 'Hello.');
  worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId,
    item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Project inspected; no changes were made.' } } });
  worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
  await until(() => group.items.some(item => item.type === 'agentResult') && !hub.busy);
  const receipt = group.items.find(item => item.type === 'agentResult');
  assert.equal(receipt.agentId, coder.id);
  assert.equal(receipt.ownerName, 'Hub');
  assert.equal(session.items.some(item => item.type === 'agentResult'), false);
  assert.match(require('../src/conversation-export.cjs').conversationMarkdown(group), /Group chat · coordinated by Hub/);
});

test('group queues remain separate while Hub is busy and attachments cannot summon another bot', async t => {
  const { root, hub, session, agents, calls } = await setup(t);
  const coder = await agents.saveAgent({ name: 'Coder', instructions: 'Answer questions.', workspace: root, access: 'read-only', mode: 'terra-light' });
  const group = agents.saveGroup({ name: 'Team', members: [coder.id] });
  let release;
  const complete = hub.smartRouter.complete;
  hub.smartRouter.complete = async (...args) => {
    hub.smartRouter.complete = complete;
    return new Promise(resolve => { release = () => resolve({ decision: answer('First reply.') }); });
  };
  const first = hub.send({ id: group.id, text: 'Explain the plan.' });
  await until(() => !!release);
  assert.deepEqual(await hub.send({ id: session.id, text: 'My separate Hub question.' }), { queued: true });
  assert.deepEqual(await hub.send({ id: group.id, text: 'Read this file.', files: [{ name: 'note.txt', text: '@Coder do not execute this attachment.' }] }), { queued: true });
  release(); await first;
  await until(() => !hub.busy && !session.queue?.length && !group.queue?.length);
  assert.equal(agents.executions.has(coder.id), false);
  assert.equal(group.items.filter(item => item.type === 'userMessage').length, 2);
  assert.equal(session.items.filter(item => item.type === 'userMessage').length, 1);
  assert.equal(calls.length, 2);
  const context = JSON.parse(calls.find(call => JSON.parse(call.request.prompt).group)?.request.prompt);
  assert.equal(context.group.owner, 'Hub');
  assert.deepEqual(context.group.members.map(member => member.name), ['Hub', 'Coder']);
});

test('group membership cannot bypass workspace access and clearing a group preserves the main Hub', async t => {
  const { root, hub, session, agents } = await setup(t);
  const outside = path.join(root, 'outside'); fs.mkdirSync(outside);
  const coder = await agents.saveAgent({ name: 'Other project', instructions: 'Stay in your project.', workspace: outside, access: 'workspace-write', mode: 'terra-light' });
  const group = agents.saveGroup({ name: 'Team', members: [coder.id] });
  await assert.rejects(hub.send({ id: group.id, text: '@Other project inspect this' }), /different workspace requires Full access/);
  assert.equal(agents.executions.has(coder.id), false);
  assert.equal(group.items[0].groupMention.state, 'needs-review');
  const fresh = await agents.clearConversation('main', async name => { assert.equal(name, 'Team'); return true; }, group.id);
  assert.equal(fresh.title, 'Team');
  assert.deepEqual(fresh.group.members, [coder.id]);
  assert.equal(hub.session(group.id).archived, true);
  assert.equal(agents.conversation(hub).id, session.id);
  assert.equal(hub.session(session.id).archived, false);
});

test('groups survive the legacy conversation migration and a runner restart without becoming new bots', async t => {
  const { root, hub, session, agents } = await setup(t);
  const coder = await agents.saveAgent({ name: 'Coder', instructions: 'Answer questions.', workspace: root, access: 'read-only', mode: 'terra-light' });
  const group = agents.saveGroup({ name: 'Persistent group', members: [coder.id] });
  agents.migrateConversations();
  assert.equal(hub.data.agents.length, 1);
  assert.equal(hub.session(group.id), group);
  const restoredHub = agents.createController(hub.filename, root);
  await restoredHub.initialize();
  const restored = new Agents(restoredHub, async () => {}, agents.createController);
  t.after(() => { restored.closing = true; restored.budgets.close(); for (const controller of restored.allControllers()) controller.close(); });
  assert.equal(restoredHub.data.agents.length, 1);
  assert.equal(restoredHub.session(group.id).group.owner, 'main');
  assert.equal(restored.conversation(restoredHub).id, session.id);
  assert.equal(restored.snapshot().agentStates.main.sessions.find(chat => chat.id === group.id).title, 'Persistent group');
});

test('stopping one group cancels only its assignments and preserves another group sharing Hub', async t => {
  const { root, hub, agents } = await setup(t);
  const profiles = [];
  for (const name of ['Coder', 'Reviewer']) {
    const profile = await agents.saveAgent({ name, instructions: 'Answer questions.', workspace: root, access: 'read-only', mode: 'terra-light' });
    const worker = agents.execution(profile.id); await agents.initializeController(worker); worker.connection = 'disconnected';
    profiles.push(profile);
  }
  const first = agents.saveGroup({ name: 'First group', members: [profiles[0].id] });
  const second = agents.saveGroup({ name: 'Second group', members: [profiles[1].id] });
  await hub.send({ id: first.id, text: '@Coder inspect one task.' });
  await hub.send({ id: second.id, text: '@Reviewer inspect another task.' });
  const firstJob = agents.conversation(agents.execution(profiles[0].id)).delegation;
  const secondJob = agents.conversation(agents.execution(profiles[1].id)).delegation;
  await agents.stop(first.id);
  assert.equal(firstJob.cancelled, true);
  assert.equal(firstJob.delivered, true);
  assert.equal(first.queuePaused, true);
  assert.equal(secondJob.cancelled, undefined);
  assert.equal(secondJob.delivered, false);
  assert.equal(secondJob.state, 'queued');
  assert.equal(second.items.some(item => item.type === 'agentResult'), false);
});

test('Hub retains complete file snapshots in its request and conversation while using compact display metadata', async t => {
  const { hub, session, calls } = await setup(t);
  await hub.send({ id: session.id, text: 'Review this file.', files: [{ name: 'notes.md', text: 'ATTACHMENT_EVIDENCE' }] });
  assert.match(session.hubRequest.text, /ATTACHMENT_EVIDENCE/);
  const sent = session.items.find(item => item.type === 'userMessage');
  assert.deepEqual(sent.fileMessage, { displayText: 'Review this file.', names: ['notes.md'] });
  assert.match(JSON.stringify(calls[0].request), /ATTACHMENT_EVIDENCE/);
});

test('Hub keeps its chat model, preserves old history and never starts a native worker turn', async t => {
  const { hub, session, agents, calls, send } = await setup(t);
  session.threadId = 'existing-main-thread';
  session.items.push({ id: 'old', type: 'agentMessage', text: 'Existing conversation', phase: 'final_answer' });
  hub.data.settings.mode = 'auto';
  await send('Hello');
  const model = calls[0].choice.id;
  hub.effectiveRouter = () => { throw new Error('Must use the pinned model'); };
  await send('How does this work?');
  assert.equal(calls[1].choice.id, model);
  assert.deepEqual(session.routes.map(route => route.source), ['hub-auto', 'hub-auto'], 'initial and pinned Auto turns keep their selection origin');
  assert.deepEqual(readSessionData(hub.filename).sessions.find(s => s.id === session.id).routes.map(route => route.source), ['hub-auto', 'hub-auto']);
  assert.equal(readSessionData(hub.filename).hubMode, model);
  assert.match(calls[1].request.prompt, /Existing conversation/);
  assert.equal(hub.client.calls.some(c => c.method.startsWith('thread/') || c.method === 'turn/start'), false);
  assert.equal(agents.snapshot().agents[0].name, 'Hub');
  await assert.rejects(agents.deleteAgent('main'), /cannot be deleted/);
  hub.available = () => false;
  await assert.rejects(send('Again'), /Hub Auto needs/);
  assert.equal(calls.length, 2, 'no replacement can run when all models are unavailable');
});

test('Hub Auto replaces a disconnected Claude pin with OpenAI and retains the conversation', async t => {
  const { hub, session, calls, send } = await setup(t);
  hub.data.settings.mode = 'auto';
  hub.setProviderEnabled('codex', false);
  await hub.refreshAccount();
  hub.setProviderEnabled('claude-cli', true);
  hub.claude.status = { loggedIn: true };
  hub.claude.models = [{ id: 'claude-cli:balanced', model: 'balanced', provider: 'claude-cli', efforts: ['medium'], rank: 30, worker: true, router: true }];
  await hub.refreshAccount();
  let selections = 0;
  const chooseHub = hub.smartRouter.chooseHub;
  hub.smartRouter.chooseHub = async (...args) => { selections++; return chooseHub(...args); };
  await send('Remember this conversation');
  assert.equal(calls[0].choice.provider, 'claude-cli');
  const oldPin = hub.data.hubMode;
  hub.setProviderEnabled('claude-cli', false);
  hub.setProviderEnabled('codex', true);
  await hub.refreshAccount();
  await send('Continue after switching providers');
  assert.equal(calls[1].choice.provider, 'codex');
  assert.match(calls[1].request.prompt, /Remember this conversation/);
  assert.equal(calls[1].choice.source, 'hub-auto');
  assert.notEqual(hub.data.hubMode, oldPin);
  assert.equal(hub.data.hubModeSource, 'auto');
  assert.equal(hub.data.settings.mode, 'auto');
  assert.equal(readSessionData(hub.filename).hubMode, calls[1].choice.id);
  await send('Continue again');
  assert.equal(selections, 2, 'the healthy replacement stays pinned');
  assert.equal(calls[2].choice.id, calls[1].choice.id);
  assert.equal(hub.data.sessions[0].id, session.id);
  assert.equal(hub.client.calls.some(c => c.method === 'turn/start'), false);
});

test('Hub Auto replaces removed or rate-limited pins without overriding manual model choices', async t => {
  for (const unavailable of ['removed', 'limited']) await t.test(unavailable, async t => {
    const { hub, calls, send } = await setup(t);
    hub.data.settings.mode = 'auto';
    await send('Hello');
    const oldPin = hub.resolveWorker(hub.data.hubMode);
    if (unavailable === 'removed') hub.models = hub.models.filter(p => p.model !== oldPin.model);
    else hub.limits.limited = (_provider, model) => model === oldPin.model;
    await send('Next');
    assert.notEqual(calls[1].choice.model, oldPin.model);
  });
  const { hub, calls, send } = await setup(t);
  await send('A manually chosen model');
  const oldPin = hub.data.hubMode;
  hub.models = hub.models.filter(p => p.model !== calls[0].choice.model);
  assert.ok(hub.catalog().some(p => hub.available(p)), 'a replacement exists');
  hub.smartRouter.chooseHub = async () => assert.fail('a manual choice must not be silently changed');
  await assert.rejects(send('Next'), /chat model is unavailable/);
  assert.equal(hub.data.hubMode, oldPin);
  assert.equal(hub.data.hubModeSource, 'manual');
  assert.equal(calls.length, 1);
});

test('Hub Auto asks either router to choose from arbitrary available models across subscriptions', async t => {
  for (const routing of ['jev', 'smart']) for (const provider of ['codex', 'claude-cli', 'cursor-cli']) {
    await t.test(`${routing} with ${provider}`, async t => {
      const { hub, calls, send } = await setup(t);
      hub.data.settings.routing = routing; hub.data.settings.mode = 'auto';
      hub.data.hubMode = 'terra-light'; // Migrate an earlier automatic choice outside the policy.
      const model = 'future-balanced-model-v3', small = 'future-small-model-v2', flagship = 'future-large-model-v4';
      const models = [small, flagship, model], efforts = ['high', 'medium', 'low'];
      if (provider === 'codex') {
        hub.models = models.map(model => ({ model, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) }));
        hub.data.settings.disabledCodexModels = [];
      } else {
        hub.account = null;
        if (provider === 'claude-cli') {
          hub.data.settings.claudeEnabled = true; hub.claude.status = { loggedIn: true };
          hub.claude.models = models.map(model => ({ id: `claude-cli:${model}`, model, provider, efforts, rank: 35, worker: true, router: true }));
        } else {
          hub.data.settings.cursorEnabled = true; hub.cursor.status = { loggedIn: true };
          hub.cursor.models = models.map(id => ({ id, efforts, effortOption: 'reasoning_effort', parameterized: true }));
          hub.data.settings.providerModels = models.map(model => ({ id: `cursor-cli:${model}:default`, model, provider, enabled: true, rank: 35, worker: true, router: true }));
        }
      }
      const before = hub.catalog(), selections = [];
      hub.data.settings.jevEnabled = true;
      hub.smartRouter.chooseHub = async (workers, selectedProvider) => {
        selections.push(selectedProvider);
        assert.deepEqual(new Set(workers.map(p => p.model)), new Set(models), 'no model family is excluded');
        assert.ok(workers.every(p => ['low', 'medium'].includes(p.effort)));
        return workers.find(p => p.model === model && p.effort === 'low');
      };
      await send('Hello');
      assert.deepEqual(selections, [routing]);
      assert.equal(calls[0].choice.model, model); assert.equal(calls[0].choice.provider, provider); assert.equal(calls[0].choice.effort, 'low');
      const medium = before.find(p => p.model === model && p.effort === 'medium');
      hub.data.hubMode = medium.id;
      await send('Continue');
      assert.equal(calls[1].choice.id, medium.id, 'a qualifying pinned model stays fixed');
      const high = before.find(p => p.model === flagship && p.effort === 'high');
      assert.deepEqual(selections, [routing], 'a pinned choice needs no new routing call');
      const manual = await hub.coordinatorChoice(high.id, new AbortController());
      assert.equal(manual.id, high.id, 'explicit manual selection remains available');
      assert.equal(manual.source, 'manual');
      assert.equal((await hub.coordinatorChoice('auto', new AbortController())).model, model, 'returning to Auto asks the router again');
      assert.deepEqual(hub.catalog(), before, 'worker catalog and efforts are unchanged');
    });
  }
});

test('Hub Auto rejects unsupported effort while accepting previously unknown models', async t => {
  const { hub, calls, send } = await setup(t);
  hub.data.settings.mode = 'auto'; hub.data.settings.disabledCodexModels = [];
  const entries = (model, efforts) => ({ model, supportedReasoningEfforts: efforts.map(reasoningEffort => ({ reasoningEffort })) });
  hub.models = [entries('model-one', ['none', 'minimal', 'high', 'xhigh'])];
  await assert.rejects(send('Hello'), /Hub Auto needs.*Low or Medium/);
  assert.equal(calls.length, 0); assert.equal(hub.data.hubMode, undefined);
  hub.models.push(entries('unknown-model', ['medium', 'high']));
  await send('Hello');
  assert.equal(calls[0].choice.model, 'unknown-model'); assert.equal(calls[0].choice.effort, 'medium');
  hub.data.hubMode = null;
  hub.data.settings.disabledCodexModels = ['unknown-model'];
  await assert.rejects(send('Again'), /Hub Auto needs/);
  hub.data.settings.disabledCodexModels = [];
  hub.limits.limited = (_provider, model) => model === 'unknown-model';
  await assert.rejects(send('Again'), /Hub Auto needs/);
  assert.equal(calls.length, 1, 'disabled or rate-limited candidates never start inference');
});

test('Hub Auto switches to LM Studio alone, retains default effort and reuses its pin without a classifier', async t => {
  const { root, hub, calls, send } = await setup(t);
  hub.data.settings.mode = 'auto';
  await send('Remember our plan');
  for (const provider of ['codex', 'claude-cli', 'cursor-cli']) hub.setProviderEnabled(provider, false);
  hub.providerSettings({ action: 'provider', provider: { id: 'lm-studio', name: 'LM Studio', baseUrl: 'http://localhost:1234/v1', enabled: true } });
  hub.providerSettings({ action: 'model', model: { provider: 'lm-studio', model: 'new-local-model', label: 'Local model', description: '', rank: 30, effort: null, router: false } });
  await hub.refreshAccount();
  assert.equal(hub.account, null);
  const selector = new SmartRouter(root);
  selector.complete = async () => assert.fail('One eligible model needs no classifier');
  let selections = 0;
  hub.smartRouter.chooseHub = async (...args) => { selections++; return selector.chooseHub(...args); };
  await send('Continue locally');
  const local = calls[1].choice;
  assert.equal(local.provider, 'lm-studio'); assert.equal(local.model, 'new-local-model');
  assert.equal(local.effort, null); assert.equal(local.source, 'hub-auto');
  assert.match(calls[1].request.prompt, /Remember our plan/);
  assert.equal(readSessionData(hub.filename).hubMode, local.id);
  await send('Continue again');
  assert.equal(selections, 1, 'default effort remains a valid Auto pin');
  assert.equal(calls[2].choice.id, local.id); assert.equal(calls[2].choice.effort, null);
  hub.limits.limited = provider => provider === 'lm-studio';
  await assert.rejects(send('Limited'), /Hub Auto needs/);
  hub.limits.limited = () => false;
  hub.data.settings.providerModels[0].enabled = false;
  await assert.rejects(send('Disabled'), /Hub Auto needs/);
  assert.equal(calls.length, 3, 'unavailable local models never start inference');
});

test('Jev and Smart can choose fixed-effort Hub models without assigning a reasoning level', async () => {
  const router = new SmartRouter(__dirname);
  const workers = [
    { id: 'local-a:default', provider: 'local-a', model: 'fixed-a', effort: null },
    { id: 'local-b:default', provider: 'local-b', model: 'fixed-b' },
    { id: 'other:high', provider: 'other', model: 'reasoning', effort: 'high' },
  ];
  router.benchmarks.catalog = rows => rows;
  const pick = (catalog, instructions) => {
    assert.deepEqual(catalog.map(p => p.id), workers.slice(0, 2).map(p => p.id));
    assert.ok(catalog.every(p => !p.effort));
    assert.match(instructions, /no configurable effort/i);
    return catalog[0].id;
  };
  router.jev = { configured: true, evaluate: async ({ catalog }, questions) => {
    assert.ok(Object.values(questions.preset.criteria).every(label => label.endsWith('provider default')));
    return { answers: { preset: { choice: pick(catalog, questions.preset.instructions) } } };
  } };
  router.complete = async ({ prompt, instructions }) => ({ decision: { preset: pick(JSON.parse(prompt).catalog, instructions), reason: 'Available fixed-effort chat model.' } });
  for (const provider of ['jev', 'smart']) {
    const choice = await router.chooseHub(workers, provider, workers[1], new AbortController());
    assert.equal(choice.id, workers[0].id); assert.equal(choice.effort, null);
  }
});

test('Hub selection gives Jev and Smart the same evidence-based policy without names or escalation', async () => {
  const router = new SmartRouter(__dirname);
  const models = ['new-strong-model', 'new-small-model', 'new-balanced-model', 'unmeasured-model'];
  const workers = models.flatMap((model, i) => ['low', 'medium', 'high'].map(effort => ({ id: `${model}:${effort}`, model, effort,
    description: `Discovered model ${i}`, provider: 'custom-provider', label: `${model} ${effort}` })));
  router.benchmarks.catalog = rows => rows.map(p => ({ ...p, benchmarks: p.model === models[3] ? [] : [{ source: 'aa-index', version: 'test', harness: 'api', score: [90, 10, 50][models.indexOf(p.model)] }] }));
  const seen = [];
  const pick = (catalog, instructions) => {
    seen.push({ catalog, instructions });
    assert.equal(catalog.length, 4); assert.ok(catalog.every(p => ['low', 'medium'].includes(p.effort)));
    assert.deepEqual(new Set(catalog.map(p => p.model)), new Set([models[2], models[3]]), 'measured extremes are excluded independently of names');
    assert.equal(catalog.find(p => p.model === models[3]).index, undefined, 'unknown evidence is retained');
    assert.ok(catalog.every(p => p.description && p.provider === 'custom-provider'));
    assert.match(instructions, /mid-tier.*available catalog/);
    assert.doesNotMatch(instructions, /Sol|Sonnet|Opus|Astra|Haiku|Luna/);
    const measured = catalog.filter(p => p.effort === 'low' && Number.isFinite(p.index)).sort((a, b) => a.index - b.index);
    return measured[0].id;
  };
  router.jev = { configured: true, evaluate: async ({ catalog }, questions) => ({
    answers: { preset: { choice: pick(catalog, questions.preset.instructions), confidence: 0.1 } }, usage: { inputTokens: 7 },
  }) };
  router.complete = async ({ instructions, prompt, schema }) => {
    const catalog = JSON.parse(prompt).catalog;
    assert.deepEqual(schema.properties.preset.enum, catalog.map(p => p.id));
    return { decision: { preset: pick(catalog, instructions), reason: 'Balanced capability and cost for coordination.' }, usage: { inputTokens: 9 } };
  };
  const classifier = { model: 'configured-router', effort: 'low' };
  for (const provider of ['jev', 'smart']) {
    const result = await router.chooseHub(workers, provider, classifier, new AbortController());
    assert.equal(result.model, models[2]); assert.equal(result.effort, 'low');
    assert.equal(result.routerUsage.inputTokens, provider === 'jev' ? 7 : 9);
  }
  assert.deepEqual(seen[0], seen[1], 'both routers receive identical policy and catalog evidence');
  router.jev.evaluate = async () => { throw new Error('Temporarily unavailable'); };
  const fallback = await router.chooseHub(workers, 'jev', classifier, new AbortController());
  assert.equal(fallback.model, models[2]); assert.match(fallback.routerFallback, /Smart selected/);
  router.complete = async () => ({ decision: { preset: `${models[2]}:high`, reason: 'Invalid higher effort.' } });
  await assert.rejects(router.chooseHub(workers, 'smart', classifier, new AbortController()), /unavailable Hub model or effort/);
  router.complete = async () => ({ decision: { preset: `${models[0]}:low`, reason: 'Invalid top-tier model at Low effort.' } });
  await assert.rejects(router.chooseHub(workers, 'smart', classifier, new AbortController()), /unavailable Hub model or effort/);
  router.jev.evaluate = async () => ({ answers: { preset: { choice: 'invented-model' } } });
  await assert.rejects(router.chooseHub(workers, 'jev', classifier, new AbortController()), /unavailable Hub model or effort/);
  const abort = new AbortController();
  router.jev.evaluate = async () => { abort.abort(); throw Object.assign(new Error('Stopped'), { name: 'AbortError' }); };
  router.complete = async () => { assert.fail('Stop must not start fallback inference'); };
  await assert.rejects(router.chooseHub(workers, 'jev', classifier, abort), { name: 'AbortError' });
});

test('stopping Hub during automatic selection discards late model choices', async t => {
  const { hub, session, calls, send } = await setup(t);
  hub.data.settings.mode = 'auto';
  let release;
  hub.smartRouter.chooseHub = async workers => { await new Promise(resolve => { release = resolve; }); return workers[0]; };
  const pending = send('Hello');
  await until(() => !!release);
  assert.equal(hub.routing, session.id); assert.equal(hub.busy, session.id);
  await hub.stop(); release(); await pending;
  assert.equal(calls.length, 0); assert.equal(hub.data.hubMode, undefined);
  assert.equal(hub.busy, null); assert.equal(hub.routing, null); assert.equal(hub.activeTurns.size, 0);
  assert.equal(session.status, 'interrupted');
});

test('Hub capability bands handle ties, sparse evidence and duplicate provider/effort rows', async () => {
  const router = new SmartRouter(__dirname);
  for (const [scores, expected] of [
    [[10, 50, 90], [1]], [[50, 50, 50], [0, 1, 2]], [[10, 10, 90], [0, 1]],
    [[10, 90], [0, 1]], [[null, null, null], [0, 1, 2]], [[10, 20, 30, 40, 50, 60, 70, 80], [2, 3, 4, 5]],
  ]) {
    const workers = scores.flatMap((score, i) => ['low', 'medium'].map(effort => ({ id: `provider:model-${i}:${effort}`, model: `model-${i}`, effort, score })));
    workers.push(...workers.filter(p => p.model === 'model-0').map(p => ({ ...p, id: 'other-' + p.id })));
    router.benchmarks.catalog = rows => rows.map(p => ({ ...p, benchmarks: p.score === null ? [] : [{ source: 'aa-index', version: 'test', harness: 'api', score: p.score }] }));
    router.complete = async ({ prompt }) => {
      const catalog = JSON.parse(prompt).catalog;
      assert.deepEqual([...new Set(catalog.map(p => p.model))], expected.map(i => `model-${i}`));
      return { decision: { preset: catalog[0].id, reason: 'A balanced choice from the offered catalog.' } };
    };
    await router.chooseHub(workers, 'smart', { model: 'classifier' }, new AbortController());
  }
});

test('Hub creates Auto workers with inherited access and images, stays responsive, and receives results', async t => {
  const { hub, session, agents, calls, replies, send } = await setup(t);
  const image = 'data:image/png;base64,aGVsbG8=';
  replies.push(action('agent_work', { name: 'Fixer', task: 'Inspect the image and fix the issue.' }));
  await hub.send({ id: session.id, text: 'Fix this issue', images: [image] });
  const profile = hub.data.agents[0], worker = agents.execution(profile.id);
  assert.equal(profile.mode, 'auto'); assert.equal(profile.access, 'workspace-write');
  await until(() => worker.activeTurns.size > 0);
  const work = agents.conversation(worker);
  assert.deepEqual(work.delegation.images, [image]);
  assert.match(work.delegation.task, /agent_read_context/);
  assert.equal(hub.busy, null, 'Hub is free to chat while its worker runs');
  assert.equal(worker.busy, work.id);
  await send('Can we chat while that runs?');
  assert.equal(session.items.at(-1).text, 'Hello.');
  assert.equal(worker.busy, work.id, 'Hub chatting does not stop its worker');
  replies.push(answer('The worker fixed it and verified the result.'));
  worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Fixed and checked.' } } });
  worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
  await until(() => session.items.at(-1)?.text === 'The worker fixed it and verified the result.');
  assert.match(calls.at(-1).request.prompt, /Fixed and checked/);
  assert.equal(session.hubWorker, profile.id);
  replies.push(action('agent_work', { agentId: profile.id, task: 'Also handle this follow-up.' }));
  await send('Also fix the related issue');
  assert.equal(hub.data.agents.length, 1, 'follow-up reuses the same worker');
  assert.equal(agents.conversation(worker).id, work.id);
});

test('Hub answers helper questions through the mailbox without launching another assignment', async t => {
  const { hub, session, agents, calls, replies, send } = await setup(t);
  replies.push(action('agent_work', { name: 'Builder', task: 'Build the requested output.' }));
  await send('Build a JSON output');
  const worker = agents.execution(hub.data.agents[0].id), chat = agents.conversation(worker);
  await until(() => !!chat.turnId);
  const messageId = `agent-mail-${chat.id}-main-question-1`;
  await send('Can we chat while that runs?');
  const delegationsBeforeQuestion = session.agentDelegations;
  replies.push(action('agent_message', { agentId: worker.agentId, messageId: 'answer-1', kind: 'answer', replyTo: messageId, text: 'Use JSON.' }), answer('Answered the helper.'));
  await worker.bridgeTool(chat.id, 'agent_message', { agentId: 'main', messageId: 'question-1', kind: 'question', text: 'Which format?' });
  await until(() => session.items.at(-1)?.text === 'Answered the helper.');
  const context = calls.map(call => JSON.parse(call.request.prompt)).find(context => context.incoming === 'agent_message');
  assert.equal(context.agentMail.messageId, messageId);
  assert.equal(context.originalRequest.text, 'Build a JSON output');
  assert.equal(chat.queue.find(message => message.agentMail).agentMail.replyTo, messageId);
  assert.equal(hub.data.agents.length, 1);
  assert.equal(session.agentDelegations, delegationsBeforeQuestion);
  assert.equal(calls.some(call => call.request.schema.properties.fulfilled), false, 'mail is not an assignment-completion report');
});

test('Hub queues another request for an explicitly selected busy worker with honest feedback', async t => {
  const { hub, session, agents, replies, send } = await setup(t);
  replies.push(action('agent_work', { name: 'Builder', task: 'First task.' }));
  await send('Do the first task');
  const worker = agents.execution(hub.data.agents[0].id), chat = agents.conversation(worker);
  await until(() => !!chat.turnId);
  const first = chat.delegation.id;
  replies.push(action('agent_work', { agentId: worker.agentId, task: 'Second task.' }));
  await send('Queue another task with the same builder');
  assert.equal(chat.delegation.id, first);
  assert.equal(chat.delegationQueue.length, 1);
  assert.match(session.items.at(-1).text, /Queued the task/);
  assert.equal(chat.delegationQueue[0].originalRequest.text, 'Queue another task with the same builder');
});

test('Hub saves its effective mode and resumes old worker results with its pinned model', async t => {
  for (const mode of ['auto', 'terra-light']) await t.test(mode, async t => {
    const { hub, session, calls, send } = await setup(t);
    hub.data.settings.mode = 'removed-local-model';
    await hub.send({ id: session.id, text: 'Hello', mode });
    const selected = calls.at(-1).choice.id;
    assert.equal(hub.data.settings.mode, mode);
    assert.equal(readSessionData(hub.filename).settings.mode, mode);
    hub.smartRouter.chooseHub = async () => assert.fail('A returned result must reuse the pin');
    session.queuePaused = true;
    session.queue = [{ id: 'old-result', text: 'The review completed.', mode: 'removed-local-model', task: 'off', agentReply: true }];
    await hub.queuedMessage(session.id, 'old-result', 'send');
    assert.equal(calls.at(-1).choice.id, selected);
    assert.equal(calls.at(-1).choice.source, mode === 'auto' ? 'hub-auto' : 'manual');
    assert.equal(JSON.parse(calls.at(-1).request.prompt).incoming, 'worker_result');
    assert.equal(session.status, 'completed'); assert.equal(session.error, null);
    assert.equal(session.queue.length, 0); assert.equal(session.queuePaused, false);
    await send('Continue');
    assert.equal(calls.at(-1).choice.id, selected);
  });
});

test('Hub automatic dispatch avoids old manual pins and has no alternate delegation bypass', async t => {
  const { hub, session, agents, replies, calls, send } = await setup(t);
  const manual = await agents.saveAgent({ name: 'Local specialist', instructions: '', workspace: session.workspace, mode: 'terra-light', access: session.access });
  session.hubWorker = manual.id;
  replies.push(action('agent_work', { agentId: manual.id, name: 'Reviewer', task: 'Review the changes.' }));
  await send('Review changes');
  assert.equal(calls[0].request.schema.properties.action.anyOf.some(s => s.properties?.tool.enum.includes('agent_delegate')), false);
  assert.equal(hub.data.agents.length, 2);
  assert.equal(hub.data.agents.find(p => p.id === manual.id).mode, 'terra-light');
  assert.equal(agents.controller(manual.id).busy, null);
  const created = hub.data.agents.find(p => p.id !== manual.id);
  assert.equal(created.mode, 'auto'); assert.equal(session.hubWorker, created.id);
  replies.push(action('agent_work', { agentId: manual.id, mode: manual.mode, task: 'Use this specific agent as requested.' }));
  await send('Ask Local specialist to help too');
  assert.equal(session.hubWorker, manual.id);
  assert.equal(agents.conversation(agents.execution(manual.id)).delegation.source, session.id);
  assert.equal(session.hubWorkerMode, manual.mode);
});

test('Hub creates several agents at once from one request, with an accurate count', async t => {
  const { hub, session, calls, replies, send } = await setup(t);
  const names = ['Orion', 'Nimbus', 'Saffron', 'Cobalt', 'Kestrel', 'Juniper', 'Ember', 'Atlas', 'Willow', 'Quartz'];
  const lastReply = () => session.items.filter(item => item.type === 'agentMessage').at(-1).text;

  replies.push(action('agent_create', { names, instructions: 'General helper' }));
  await send('create 10 agents with random names');
  const strict = action('agent_create', { name: null, instructions: 'General helper', mode: null, effort: null, names });
  assert.doesNotThrow(() => require('../src/providers/structured.cjs').structuredResponse(strict, calls.at(-1).request.schema),
    'real providers validate the list against Hub\'s response schema');
  assert.deepEqual(hub.data.agents.map(agent => agent.name), names, 'the request is the approval: one action creates every agent');
  assert.match(lastReply(), /^Created 10 agents: Orion, .*Quartz\.$/);
  assert.equal(session.pendingAgents, undefined);

  replies.push(action('agent_create', { names: ['Orion', 'Vega'], instructions: 'General helper' }));
  await send('create Orion and Vega');
  assert.equal(hub.data.agents.length, 11);
  assert.match(lastReply(), /^Created 1 of 2 agents: Vega\.\nNot created: Orion \(.+\)$/);
});

test('Hub cannot delete agents', async t => {
  const { hub, replies, send } = await setup(t);
  replies.push(action('agent_create', { name: 'Keeper', instructions: 'Help' }), answer('Created Keeper.'));
  await send('Create Keeper');
  const keeper = hub.data.agents[0];
  replies.push(action('agent_delete', { agentId: keeper.id }));
  await assert.rejects(send('Delete Keeper'), /invalid response/);
  assert.equal(hub.data.agents.length, 1, 'the agent survives');
});

test('the Hub never runs on a worker-only model: a saved manual or Auto pick reroutes among structured-capable models', async t => {
  // Live 2026-10-19: Hub set to muse-spark-1.3-contributor failed every turn ("Muse structured routing is not enabled…").
  const { hub } = await setup(t);
  const workerOnly = { id: 'native:muse:m', provider: 'native:muse', model: 'm', effort: null, worker: true, router: false, enabled: true };
  const capable = { id: 'native:deepseek:d', provider: 'native:deepseek', model: 'd', effort: null, worker: true, router: true, enabled: true };
  hub.catalog = () => [workerOnly, capable];
  hub.available = () => true;
  const offered = [];
  hub.smartRouter.chooseHub = async eligible => {
    offered.push(eligible.map(p => p.id));
    return eligible[0];
  };
  assert.equal((await hub.coordinatorChoice(workerOnly.id, new AbortController())).id, capable.id);
  assert.equal(hub.data.settings.mode, 'auto', 'the worker-only manual pick runs as Auto');

  Object.assign(hub.data, { hubMode: workerOnly.id, hubModeSource: 'auto' });
  assert.equal((await hub.coordinatorChoice('auto', new AbortController())).id, capable.id, 'a saved worker-only Auto pick is replaced');
  assert.deepEqual(offered, [[capable.id], [capable.id]]);
});

test('a renamed Hub answers to its name and keeps that name reserved for new workers', async t => {
  const { hub, agents, calls, replies, send } = await setup(t);
  agents.renameHub('Atlas');
  replies.push(answer('I am Atlas.'));
  await send('What is your name?');
  assert.match(calls.at(-1).request.instructions, /(?:^|\n)You are Atlas, the Hub:/);
  replies.push(action('agent_create', { name: 'atlas', instructions: 'Help' }));
  await assert.rejects(send('Create a worker called atlas'), /belongs to the Hub/);
  assert.equal(hub.data.agents.length, 0, 'a worker never takes the Hub name');
});

test('Hub management preserves access checks and rejects unsupported tools and stale responses', async t => {
  const { hub, session, agents, replies, send } = await setup(t);
  replies.push(action('agent_create', { name: 'Reviewer', instructions: 'Review only', mode: 'terra-light' }), answer('Created Reviewer.'));
  await send('Create Reviewer');
  const profile = hub.data.agents[0];
  assert.equal(profile.mode, 'terra-light');
  assert.equal(agents.controller(profile.id).busy, null);
  replies.push(action('agent_set_access', { agentId: profile.id, access: 'danger-full-access' }));
  await assert.rejects(send('Give it full access'), /Cannot grant more access/);
  assert.equal(profile.access, 'workspace-write');
  for (const tool of ['router_call_tool', 'agent_delegate']) {
    replies.push(action(tool, { agentId: profile.id, task: 'Bypass routing' }));
    await assert.rejects(send('Review the code'), /invalid response/);
    assert.equal(agents.controller(profile.id).busy, null);
  }
  for (const args of [{ agentId: false }, { name: 0 }, { name: '' }]) {
    replies.push(action('agent_work', { task: 'Review.', ...args }));
    await assert.rejects(send('Review this'), /valid worker id|worker name|invalid action arguments/);
    assert.equal(hub.data.agents.length, 1);
  }
  await assert.rejects(hub.queuedMessage(session.id, 'queued', 'steer'), /no longer available/);
  let release;
  hub.smartRouter.complete = () => new Promise(resolve => { release = resolve; });
  const pending = send('Create another worker');
  await until(() => release);
  await hub.stop();
  release({ decision: action('agent_create', { name: 'Late', instructions: '' }) });
  await pending;
  assert.equal(hub.data.agents.length, 1, 'late model output after Stop cannot create agents');
  assert.equal(session.status, 'interrupted'); assert.equal(hub.busy, null);
});

test('Hub review dispatch lets Jev and Smart route to available Claude instead of a pinned local agent', async t => {
  for (const routing of ['jev', 'smart']) await t.test(routing, async t => {
    const { hub, session, agents, replies, send } = await setup(t);
    hub.data.settings.routing = routing; hub.data.settings.jevEnabled = true;
    hub.data.settings.claudeEnabled = true; hub.claude.status = { loggedIn: true };
    hub.claude.models = [{ id: 'claude-cli:review-model', model: 'review-model', provider: 'claude-cli', efforts: ['high'], rank: 35, worker: true, router: true }];
    hub.data.settings.providers = [{ id: 'local', enabled: true }];
    hub.data.settings.providerModels = [{ id: 'local:gemma-test', model: 'gemma-test', provider: 'local', worker: true, enabled: true, rank: 30 }];
    const manual = await agents.saveAgent({ name: 'LM Studio agent', instructions: '', workspace: session.workspace, mode: 'local:gemma-test', access: session.access });
    await agents.initialize();
    let submitted, routingCalls = 0;
    agents.configure = async worker => {
      worker.smartRouter.choose = async (text, context, models, provider) => {
        routingCalls++;
        assert.equal(provider, routing); assert.equal(text, 'Review PE changes', 'routing receives the user request, not Hub wording');
        assert.ok(context.routingCatalog.some(p => p.provider === 'local'), 'local models remain eligible through normal routing');
        const choice = context.routingCatalog.find(p => p.provider === 'claude-cli');
        assert.ok(choice, 'available Claude must reach the worker router');
        return { ...choice, source: routing, needsChecks: false };
      };
      worker.submitWorker = async (work, choice) => { submitted = choice; return choice; };
    };
    replies.push(action('agent_work', { agentId: manual.id, task: 'Review changes' }));
    await send('Review PE changes');
    await until(() => !!submitted);
    assert.equal(routingCalls, 1);
    assert.equal(submitted.provider, 'claude-cli'); assert.equal(submitted.effort, 'high', 'Hub effort limits do not constrain the worker');
    assert.equal(agents.controller(manual.id).busy, null);
    assert.equal(agents.profile(manual.id).mode, 'local:gemma-test');
  });
});

test('Hub compacts older context without removing visible history and retains the summary on disk', async t => {
  const { hub, session, calls, send } = await setup(t);
  for (let i = 0; i < 12; i++) session.items.push({ id: `old-${i}`, type: 'userMessage', content: [{ type: 'text', text: `Request ${i}: ` + 'x'.repeat(4000) }] });
  const before = session.items.map(i => i.id);
  await send('Continue our plan');
  assert.ok(calls.some(c => c.request.schema.properties.summary));
  assert.deepEqual(session.items.slice(0, 12).map(i => i.id), before);
  assert.ok(readSessionData(hub.filename).sessions.find(s => s.id === session.id).hubSummary);
  assert.match(calls.at(-1).request.prompt, /User intent and pending work retained/);
  await hub.compact(session.id);
  assert.equal(session.compacting, false);
  assert.match(session.notice, /Visible conversation history is retained/);
});

test('Hub starts reviews in the requested repository and enforces workspace access before creating agents', async t => {
  const { hub, session, agents, replies, send, root } = await setup(t);
  const target = path.join(root, 'project'); fs.mkdirSync(target);
  for (const access of ['read-only', 'workspace-write']) {
    session.access = access;
    replies.push(action('agent_work', { name: 'Reviewer', task: 'Review the project', workspace: target }));
    await assert.rejects(send('Review the other project'), /Full access/);
    assert.equal(hub.data.agents.length, 0);
  }
  session.access = 'danger-full-access';
  const wrong = await agents.saveAgent({ name: 'Old reviewer', instructions: '', workspace: session.workspace, mode: 'auto', access: session.access });
  await agents.initialize();
  const inspected = [];
  agents.configure = async worker => {
    worker.smartRouter.choose = async (text, context) => { inspected.push(context.workspace); return { id: 'terra-light', model: 'gpt-5.6-terra', effort: 'low', provider: 'codex', source: 'smart', needsChecks: false }; };
    worker.submitWorker = async () => {};
  };
  replies.push(action('agent_work', { agentId: wrong.id, name: 'Reviewer', task: 'Review the project', workspace: target }));
  await send('Review the other project');
  await until(() => inspected.length > 0);
  assert.deepEqual(inspected, [fs.realpathSync(target)]);
  const worker = agents.execution(session.hubWorker);
  assert.equal(worker.data.settings.workspace, fs.realpathSync(target));
  assert.equal(agents.conversation(worker).workspace, fs.realpathSync(target));
  assert.notEqual(session.hubWorker, wrong.id);
  assert.equal(agents.profile(wrong.id).workspace, root, 'an existing agent is not silently moved');
  assert.equal(session.workspace, root, 'Hub keeps its own workspace');
});

test('Hub honors explicit worker model and effort without changing its chat model', async t => {
  const { hub, session, replies, calls, send } = await setup(t);
  replies.push(action('agent_work', { name: 'Specific', task: 'Review the project.', mode: 'terra-light', effort: 'low' }));
  await send('Use Terra with low effort for the review');
  const worker = hub.resolveWorker(hub.data.agents[0].mode);
  assert.equal(worker.model, 'gpt-5.6-terra'); assert.equal(worker.effort, 'low');
  assert.equal(hub.data.settings.mode, 'terra-light'); assert.equal(session.hubWorker, hub.data.agents[0].id);
  // A rejected model choice goes back to Hub once, with the choices; nothing is created until a valid one arrives.
  replies.push(action('agent_work', { name: 'Invalid', task: 'Review.', mode: 'terra-light', effort: 'unsupported' }),
    action('agent_work', { name: 'Corrected', task: 'Review.', mode: 'terra-light', effort: 'low' }));
  await send('Another review');
  const retry =JSON.parse(calls.find(call => call.request.prompt?.includes('Unsupported effort')).request.prompt).toolResults.at(-1);
  assert.match(retry.result.error, /Unsupported effort/);
  assert.ok(retry.result.choices.some(choice => choice.mode !== 'auto'), 'Hub sees the available models');
  assert.deepEqual(hub.data.agents.map(profile => profile.name), ['Specific', 'Corrected']);
  assert.equal(session.error, null);

  // A second rejection ends the turn with a reply instead of failing it or trying again.
  replies.push(action('agent_work', { name: 'Invalid', task: 'Review.', mode: 'terra-light', effort: 'unsupported' }),
    action('agent_work', { name: 'Missing', task: 'Review.', mode: 'codex:no-such-model:low' }));
  await send('A third review');
  assert.match(session.items.at(-1).text, /^Model unavailable\..*Nothing was sent\.$/);
  assert.equal(hub.data.agents.length, 2);
  assert.equal(session.error, null);
});

test('a tracked job that runs on the Hub is marked admitted before its first model call, so a crash cannot replay it', async t => {
  const { hub, session, send } = await setup(t);
  session.delegation = { id: 'hub-job', admissionTracked: true, delivered: false };
  let admittedAtFirstCall;
  const complete = hub.smartRouter.complete;
  hub.smartRouter.complete = async (...args) => {
    admittedAtFirstCall ??= session.delegation.admittedAt;
    return complete.apply(hub.smartRouter, args);
  };
  await send('Do the assigned work');
  assert.equal(typeof admittedAtFirstCall, 'number');
  const saved = readSessionData(hub.filename).sessions.find(entry => entry.id === session.id);
  assert.equal(saved.delegation.admittedAt, admittedAtFirstCall, 'saved to disk before the model call');
});

test('a batch with an unavailable model reserves nothing; Hub corrects it once and exactly one batch is sent', async t => {
  const { root, hub, session, agents, replies, send } = await setup(t);
  projectFixture(root, session);
  session.access = 'danger-full-access';
  replies.push(action('agent_work', { name: 'Reviewer', count: 2, task: 'Review.', mode: 'codex:no-such-model:low' }),
    action('agent_work', { name: 'Reviewer', count: 2, task: 'Review.' }));
  await send('Two independent reviews');
  assert.equal(hub.data.agents.length, 2);
  const batches = new Set(Object.values(agents.workspaces.records).map(record => record.batchId));
  assert.equal(batches.size, 1, 'the rejected batch reserved no project copies');
  assert.equal(session.items.find(item => item.hubBatch)?.hubBatch.dispatched, 2);
});

test('Hub dispatches four configured reviewers in two background slots and waits for every result', async t => {
  const { root, hub, session, agents, replies, calls, send } = await setup(t);
  const project = projectFixture(root, session);
  session.access = 'danger-full-access';
  hub.models.forEach(model => model.supportedReasoningEfforts.push({ reasoningEffort: 'xhigh' }));
  agents.configure = async worker => {
    const call = worker.client.call.bind(worker.client);
    worker.client.call = (method, params) => method === 'model/list' ? Promise.resolve({ data: hub.models }) : call(method, params);
  };
  const original = 'Create four reviewers using Sol at xhigh. Have each review the whole project without edits.';
  replies.push(action('agent_work', { name: 'Reviewer', count: 4, task: 'Review the whole project without edits.', mode: 'codex:gpt-5.6-sol:medium', effort: 'xhigh' }));
  await send(original);
  assert.equal(hub.data.agents.length, 4);
  assert.equal(session.agentDelegations, 4);
  assert.equal(hub.data.settings.mode, 'terra-light');
  assert.match(session.items.at(-1).text, /4 agents/);
  const batchId = session.items.find(item => item.hubBatch)?.hubBatch.id;
  assert.ok(batchId);
  assert.ok(hub.data.agents.every(profile => profile.temporaryBatch === batchId));
  assert.ok(readSessionData(hub.filename).agents.every(profile => profile.temporaryBatch === batchId));
  const workers = hub.data.agents.map(profile => agents.execution(profile.id));
  assert.equal(agents.snapshot().batchReports[batchId].summary, '4 waiting');
  await until(() => workers.filter(worker => worker.activeTurns.size > 0).length === 2, 20000);
  assert.ok(workers.every(worker => agents.conversation(worker).access === 'danger-full-access'));
  for (const [index, worker] of workers.entries()) {
    const work = agents.conversation(worker);
    await until(() => worker.activeTurns.size > 0, 20000);
    assert.equal(worker.resolveWorker(worker.data.settings.mode).effort, 'xhigh');
    assert.equal(worker.resolveWorker(worker.data.settings.mode).model, 'gpt-5.6-sol');
    const turn = worker.client.calls.findLast(call => call.method === 'turn/start');
    assert.equal(turn.params.effort, 'xhigh'); assert.equal(turn.params.model, 'gpt-5.6-sol');
    assert.notEqual(work.workspace, session.workspace); assert.equal(work.access, session.access);
    assert.equal(work.delegation.workspaceCopy.source, project);
    assert.equal(fs.readFileSync(path.join(work.workspace, 'code.c'), 'utf8'), 'dirty source at setup');
    assert.equal(work.delegation.originalRequest.text, original);
    assert.equal(work.delegation.originalRequest.batch.index, index + 1);
    assert.match(work.delegation.task, /one of 4 independent workers/i);
    assert.ok(workers.filter(other => other.activeTurns.size > 0).length <= 2, 'background execution remains bounded');
    if (index === 3) replies.push(answer('All four reviews are complete. Here are the combined findings.'));
    worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: `Review ${index + 1}: inspected every file; finding in file${index + 1}.c:12.` } } });
    worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
    await until(() => !hub.busy && session.items.some(item => item.hubBatchResult?.index === index + 1));
    if (index < 3) {
      assert.match(session.items.at(-1).text, new RegExp(`${index + 1}/4`));
      assert.equal(session.hubCompletion.fulfilled, false);
      assert.equal(calls.filter(c => c.request.schema.properties.action).length, 1, 'no final synthesis before all four return');
      assert.equal(agents.snapshot().batchReports[batchId].summary, `${index + 1} returned, not verified · ${3 - index} waiting`);
    }
  }
  assert.equal(agents.snapshot().batchReports[batchId].summary, '4 returned, not verified', 'no host checks, so no job counts as verified');
  assert.match(session.items.at(-1).text, /All four reviews are complete/);
  const synthesis = JSON.parse(calls.at(-1).request.prompt);
  assert.equal(synthesis.batchResults.length, 4);
  assert.ok(synthesis.batchResults.every((result, i) => result.text.includes(`file${i + 1}.c:12`)));
  const saved = readSessionData(hub.filename).sessions.find(s => s.id === session.id);
  assert.equal(saved.items.filter(item => item.hubBatchResult).length, 4);
  assert.equal(session.hubCompletion.fulfilled, true);
  assert.equal(fs.readFileSync(path.join(project, 'code.c'), 'utf8'), 'dirty source at setup');
  const receipts = session.items.filter(item => item.type === 'agentResult');
  assert.equal(receipts.length, 4);
  assert.ok(receipts.every(item => item.workspaceCopy?.source === project));
  // Four copies, one setup: per-job context (copy paths) is not part of the fingerprint.
  assert.equal(new Set(receipts.map(item => item.workspaceCopy.workspace)).size, 4);
  assert.equal(new Set(receipts.map(item => item.setup?.hash)).size, 1);
  assert.deepEqual([receipts[0].setup.model, receipts[0].setup.effort], ['gpt-5.6-sol', 'xhigh']);
  assert.ok(receipts[0].setup.instructions.bot, 'the workers\' bot instructions are part of their setup');
  const exported = require('../src/conversation-export.cjs').conversationMarkdown(session);
  assert.match(exported, /Project copy:/);
  assert.ok(receipts.every(item => exported.includes(item.workspaceCopy.workspace)));
  const kept = await agents.saveAgent({ ...hub.data.agents[0] });
  assert.equal(kept.temporaryBatch, undefined, 'editing and saving keeps a batch worker as a permanent bot');
  assert.ok(agents.execution(kept.id).data.sessions.length);
  assert.equal(session.items.filter(item => item.type === 'agentResult').length, 4);
  await assert.rejects(agents.saveAgent({ ...kept, id: undefined, name: 'Invalid temporary bot', workspace: project }, batchId), /Unknown batch workspace/);
});

test('Hub acknowledges a saved correction immediately and retains its original request scope', async t => {
  const { hub, session, agents, replies, calls, send } = await setup(t);
  replies.push(action('agent_work', { name: 'Builder', task: 'Build the requested game.' }));
  await send('Build a playable platform game.');
  const worker = agents.execution(hub.data.agents[0].id), chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  const call = worker.client.call.bind(worker.client);
  let acknowledge;
  worker.client.call = (method, params) => method === 'turn/steer' ? new Promise(resolve => { acknowledge = resolve; }) : call(method, params);
  replies.push(action('agent_revise', { jobId: chat.delegation.id, expectedRevision: 1, amendmentId: 'blue-game', text: 'Use a blue background.' }));
  await send('Make its background blue.');
  assert.match(session.items.at(-1).text, /^Change received · revision 2/);
  assert.equal(chat.delegation.amendments[0].state, 'received');
  assert.equal(hub.busy, null);
  assert.equal(calls.filter(call => call.request.schema.properties.action).length, 2, 'the acknowledgment needs no extra model round');
  acknowledge({});
  await until(() => chat.delegation.amendments[0].state === 'applied');
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(chat.delegation.originalRequest.text, 'Build a playable platform game.');
  assert.match(agents.requestFor(chat.delegation).text, /Build a playable platform game[\s\S]*Use a blue background/);
});

async function workspacePreparation(t, repository) {
  const { root, hub, session, agents, replies, calls, send } = await setup(t);
  const project = projectFixture(root, session, { repository });
  const script = path.join(project, 'check.cjs');
  fs.writeFileSync(script, "require('node:fs').writeFileSync('check-output.txt', 'checked in this copy');");
  hub.data.settings.checks[project] = [{ id: 'copy-check', name: 'Copy check', argv: [process.execPath, script], cwd: project, timeoutMs: 1000 }];
  const prepare = agents.workspaces.prepare.bind(agents.workspaces);
  let release;
  agents.workspaces.prepare = async (...args) => {
    await new Promise((resolve, reject) => {
      const signal = args[2], stopped = () => reject(signal.reason);
      release = () => { signal.removeEventListener('abort', stopped); resolve(); };
      signal.addEventListener('abort', stopped, { once: true });
    });
    agents.workspaces.prepare = prepare;
    return prepare(...args);
  };
  replies.push(action('agent_work', { name: 'Independent output', count: 2, task: 'Build one output in your own copy.' }));
  await send('Build two independent outputs.');
  const workers = hub.data.agents.map(profile => agents.execution(profile.id));
  assert.equal(agents.workspaces.busy, true);
  assert.equal(hub.busy, null, 'Hub returns after saving the jobs, without waiting for the project copies');
  assert.equal(workers.some(worker => worker.client.calls.some(call => call.method === 'turn/start')), false);
  replies.push(answer('I can answer while the project copies are being prepared.'));
  await send('Are you available?');
  assert.match(session.items.at(-1).text, /I can answer/);
  release();
  await until(() => workers.every(worker => worker.activeTurns.size), 20000);
  const worker = workers[0], work = agents.conversation(worker), copy = work.delegation.workspaceCopy;
  const instructions = agents.instructions(worker, work);
  if (repository) assert.match(instructions, /independent Git storage/);
  else {
    assert.match(instructions, /plain folder with no Git history/);
    assert.match(instructions, /git diff --no-index/);
    assert.ok(instructions.includes(JSON.stringify(path.join(path.dirname(work.workspace), 'input'))));
  }
  assert.equal(work.access, 'workspace-write');
  assert.equal(work.delegation.taskChecks[0].cwd, work.workspace);
  assert.equal(work.delegation.taskChecks[0].argv[1], path.join(work.workspace, 'check.cjs'));
  execFileSync(process.execPath, work.delegation.taskChecks[0].argv.slice(1), { cwd: work.delegation.taskChecks[0].cwd, windowsHide: true });
  assert.equal(fs.existsSync(path.join(project, 'check-output.txt')), false);
  assert.equal(fs.readFileSync(path.join(copy.workspace, 'check-output.txt'), 'utf8'), 'checked in this copy');
  const nested = agents.workspaces.reserve(copy.workspace, { id: randomUUID(), index: 1 });
  const nestedProfile = await agents.saveAgent({ name: 'Nested verifier', instructions: 'Verify the copied project.',
    workspace: nested.workspace, access: 'workspace-write', mode: 'auto' });
  const nestedJob = agents.delegate(hub, session, nestedProfile.id, 'Verify the nested project copy.');
  await until(() => !!agents.findJob(nestedJob.jobId).job.taskChecks, 20000);
  const nestedChecks = agents.findJob(nestedJob.jobId).job.taskChecks;
  assert.equal(nestedChecks[0].cwd, nested.workspace);
  assert.equal(nestedChecks[0].argv[1], path.join(nested.workspace, 'check.cjs'));
  assert.match(JSON.stringify(await worker.bridgeTool(work.id, 'agent_read_context', { agentId: 'main', query: 'Build two independent outputs' })), /Build two independent outputs/);
  const note = await worker.bridgeTool(work.id, 'agent_message', { agentId: 'main', messageId: 'isolated-question', kind: 'question', text: 'Question from the project copy.' });
  assert.equal(session.items.some(item => item.id === note.messageId), true);
  await until(() => !hub.busy && !session.queue.length);
  const outside = await agents.saveAgent({ name: 'Original checkout', instructions: 'Stay in the original project.', workspace: project, access: 'workspace-write', mode: 'auto' });
  await assert.rejects(worker.bridgeTool(work.id, 'agent_delegate', { agentId: outside.id, task: 'Edit the files.' }), /helper in its own project copy/);
  const coordinatorProfile = await agents.saveAgent({ name: 'User-created Full-access copy bot', instructions: 'Ask Hub for a helper.', workspace: copy.workspace, access: 'danger-full-access', mode: 'terra-light' });
  const coordinator = agents.controller(coordinatorProfile.id); await agents.initializeController(coordinator);
  const coordinatorChat = agents.conversation(coordinator, true);
  await coordinator.send({ id: coordinatorChat.id, text: 'Ask Hub to coordinate a helper in this project copy.', mode: 'terra-light', task: 'off' });
  const hubExecution = agents.execution('main'); await agents.initializeController(hubExecution);
  const hubWork = agents.conversation(hubExecution, true);
  hubWork.items.push({ type: 'agentMessage', text: 'UNRELATED_PROJECT_HISTORY' }); hubExecution.save();
  replies.push(action('agent_work', { name: 'Hub-assisted helper', task: 'Check the files in the requesting job copy.' }));
  await coordinator.bridgeTool(coordinatorChat.id, 'agent_delegate', { agentId: 'main', task: 'Have a helper check these files in this job copy.' });
  await until(() => hub.data.agents.some(profile => profile.name === 'Hub-assisted helper'));
  const helper = hub.data.agents.find(profile => profile.name === 'Hub-assisted helper');
  assert.equal(helper.temporaryBatch, copy.batchId, 'helpers inherit their batch lifetime without changing explicit user-created bots');
  assert.equal(coordinatorProfile.temporaryBatch, undefined);
  assert.equal(helper.workspace, work.workspace, 'a Hub handoff does not return execution to the original checkout');
  assert.equal(helper.access, 'workspace-write', 'a handoff does not increase the receiving Hub permission ceiling');
  assert.equal(hubWork.delegation.projectScope, work.workspace);
  const scopedCall = calls.find(call => call.request.schema.properties.action && JSON.parse(call.request.prompt).workspace === copy.workspace);
  assert.ok(scopedCall); assert.doesNotMatch(scopedCall.request.prompt, /UNRELATED_PROJECT_HISTORY/);
  const helperExecution = agents.execution(helper.id), helperChat = agents.conversation(helperExecution);
  assert.doesNotMatch(JSON.stringify(agents.readContext(helperChat, { agentId: 'main', query: 'UNRELATED_PROJECT_HISTORY' })), /UNRELATED_PROJECT_HISTORY/);
  await assert.rejects(hubExecution.coordinatorTool(hubWork, 'agent_work', { name: 'Escaping helper', task: 'Edit elsewhere.', workspace: project }, [], new AbortController(), { id: 'scoped-request', text: 'Edit elsewhere.' }), /original project copy/);
}

for (const repository of [true, false]) {
  test(`batch preparation leaves Hub available and keeps checks, context and helpers in their project copy (${repository ? 'Git' : 'plain folder'})`,
    t => workspacePreparation(t, repository));
}

test('Hub batch bounds and capacity reject the whole request before creating workers', async t => {
  const { hub, session, replies, agents, send } = await setup(t);
  for (const count of [0, 11, 1.5, '4']) {
    replies.push(action('agent_work', { name: 'Reviewer', count, task: 'Review.' }));
    await assert.rejects(send('Create reviewers'), /invalid action arguments/);
    assert.equal(hub.data.agents.length, 0);
  }
  const profile = await agents.saveAgent({ name: 'Existing', instructions: '', workspace: session.workspace, mode: 'auto', access: session.access });
  await agents.initialize();
  const worker = agents.execution(profile.id);
  for (let index = 0; index < 7; index++) worker.data.sessions.push({ id: randomUUID(), delegation: { delivered: false, state: 'held' } });
  replies.push(action('agent_work', { name: 'Reviewer', count: 4, task: 'Review.' }));
  await assert.rejects(send('Create four reviewers'), /queue is full/);
  assert.equal(hub.data.agents.length, 1, 'no partial batch when queue capacity is already known');
});

test('host check failures override a positive model review without starting another worker retry', async t => {
  const { hub, session, agents, replies, assessments, send } = await setup(t);
  hub.checks(session.workspace, [{ id: 'build', name: 'Compile', kind: 'build', argv: ['fixture-build'] }]);
  replies.push(action('agent_work', { name: 'Builder', task: 'Build the output.' }));
  await send('Build the requested output.');
  const worker = agents.execution(hub.data.agents[0].id), chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  const jobId = chat.delegation.id;
  worker.runCheck = async (_session, _task, check) => worker.classifyExec(check, { exitCode: 1, stdout: 'Compiler failed.' }, 1);
  chat.tasks.at(-1).corrections = 1;
  assessments.push({ fulfilled: true, evidence: 'The worker claims success.', gaps: [] });
  worker.notification({ method: 'item/completed', params: { threadId: chat.threadId, turnId: chat.turnId,
    item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Everything built successfully.' } } });
  worker.notification({ method: 'turn/completed', params: { threadId: chat.threadId, turn: { id: chat.turnId, status: 'completed' } } });
  await until(() => !hub.busy && session.hubCompletion);
  assert.equal(session.hubCompletion.fulfilled, false);
  assert.ok(session.hubCompletion.gaps.some(gap => /Build: host check failed/.test(gap)));
  assert.equal(chat.delegation.id, jobId);
  assert.equal(session.agentDelegations, 1);
  assert.match(session.items.at(-1).text, /not been confirmed complete/);
});

test('Hub batch partial dispatch reports missing workers instead of waiting forever', async t => {
  const { root, hub, session, agents, replies, send } = await setup(t);
  projectFixture(root, session);
  const create = agents.saveAgent.bind(agents);
  agents.saveAgent = value => {
    if (hub.data.agents.length === 2) throw new Error('Provider became unavailable.');
    return create(value);
  };
  replies.push(action('agent_work', { name: 'Reviewer', count: 4, task: 'Review.' }));
  await assert.rejects(send('Create four independent reviewers'), /Sent 2\/4 agent tasks/);
  assert.equal(hub.data.agents.length, 2);
  for (const profile of hub.data.agents) {
    const worker = agents.execution(profile.id), work = agents.conversation(worker);
    await until(() => worker.activeTurns.size > 0, 20000);
    worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Reviewed the project. No findings; all source files inspected.' } } });
    worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
    await until(() => !hub.busy && session.items.some(item => item.hubBatchResult?.agentId === worker.agentId));
  }
  assert.equal(session.hubCompletion.fulfilled, false);
  assert.match(session.items.at(-1).text, /2 requested workers were not dispatched/);
  assert.doesNotMatch(session.items.at(-1).text, /Waiting for the remaining/);
});

test('batch setup failures return every failed result without inference or silently sharing the checkout', async t => {
  const { root, hub, session, agents, replies, send } = await setup(t);
  const project = path.join(root, 'broken-git-project'); fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, '.git'), 'gitdir: missing-fixture-metadata');
  fs.writeFileSync(path.join(project, 'keep.txt'), 'untouched'); session.workspace = project;
  replies.push(action('agent_work', { name: 'Output', count: 2, task: 'Create one output.' }));
  await send('Make two independent outputs.');
  await until(() => !hub.busy && session.items.filter(item => item.hubBatchResult).length === 2, 20000);
  const receipts = session.items.filter(item => item.type === 'agentResult');
  assert.equal(receipts.length, 2);
  assert.ok(receipts.every(item => item.status === 'failed' && /Workspace setup failed/.test(item.error)));
  assert.equal(session.hubCompletion.fulfilled, false);
  assert.equal(agents.pendingJobs().length, 0);
  assert.ok(hub.data.agents.every(profile => !agents.execution(profile.id).client.calls.some(call => call.method === 'turn/start')));
  assert.equal(fs.readFileSync(path.join(project, 'keep.txt'), 'utf8'), 'untouched');
  assert.deepEqual(fs.readdirSync(project).sort(), ['.git', 'keep.txt']);
  assert.equal(fs.readFileSync(path.join(project, '.git'), 'utf8'), 'gitdir: missing-fixture-metadata');
});

test('cancelled batch results are recorded without starting replacement workers', async t => {
  const { root, hub, session, agents, replies, calls, send } = await setup(t);
  projectFixture(root, session);
  replies.push(action('agent_work', { name: 'Reviewer', count: 4, task: 'Review.' }));
  await send('Create four independent reviewers');
  await agents.stop(session.id);
  await until(() => hub.data.agents.every(profile => agents.conversation(agents.execution(profile.id)).delegation.delivered));
  const queued = [...session.queue];
  session.queue = []; session.queuePaused = true;
  for (const result of queued) {
    assert.equal(result.agentReplyCancelled, true);
    await hub.send({ ...result, id: session.id });
  }
  assert.equal(hub.data.agents.length, 4);
  assert.equal(session.hubCompletion.fulfilled, false);
  assert.match(session.items.at(-1).text, /Worker was cancelled/);
  assert.equal(calls.filter(call => call.request.schema.properties.action).length, 1);
});

test('Hub batch follow-ups retain one assignment and exhausted dispatch budgets settle incomplete results', async t => {
  for (const exhausted of [false, true]) await t.test(exhausted ? 'budget exhausted' : 'one follow-up', async t => {
    const { root, hub, session, agents, replies, assessments, calls, send } = await setup(t);
    projectFixture(root, session);
    replies.push(action('agent_work', { name: 'Reviewer', count: 2, task: 'Review.' }));
    await send('Create two independent full project reviewers');
    if (exhausted) session.agentDelegations = 10;
    const workers = hub.data.agents.map(profile => agents.execution(profile.id));
    const sequence = exhausted ? workers : [...workers, workers[0]];
    for (const [index, worker] of sequence.entries()) {
      const work = agents.conversation(worker);
      await until(() => worker.activeTurns.size > 0, 20000);
      const oldJob = work.delegation;
      if (index === 0) assessments.push({ fulfilled: false, evidence: 'Only a summary.', gaps: ['Inspect actual code.'] });
      if (index === 2) replies.push(answer('Both independent reviews returned.'));
      worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: index === 0 ? 'Summary only.' : `Reviewed code for ${worker.agentId}; no findings.` } } });
      worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
      if (index === 0 && !exhausted) {
        await until(() => work.delegation.id !== oldJob.id);
        assert.deepEqual(work.delegation.originalRequest.batch, oldJob.originalRequest.batch);
        assert.equal(work.delegation.originalRequest.attempts, 2);
      } else await until(() => !hub.busy && session.items.some(item => item.hubBatchResult?.agentId === worker.agentId));
    }
    assert.equal(hub.data.agents.length, 2);
    assert.equal(session.error, null);
    assert.equal(session.hubCompletion.fulfilled, !exhausted);
    if (exhausted) assert.match(session.items.at(-1).text, /2\/2 agent results returned.*not been confirmed complete/);
    else {
      const context = JSON.parse(calls.at(-1).request.prompt);
      assert.equal(context.batchResults.length, 2);
      assert.ok(context.batchResults.every(result => !result.text.includes('Summary only.')));
    }
  });
});

test('Hub never restarts a cancelled result and failed compaction preserves original messages', async t => {
  const { hub, session, replies } = await setup(t);
  replies.push(action('agent_work', { name: 'Restart', task: 'Continue stopped work.' }));
  await assert.rejects(hub.send({ id: session.id, text: 'Worker stopped.', agentReply: true, agentReplyCancelled: true }), /will not restart automatically/);
  assert.equal(hub.data.agents.length, 0);
  const original = JSON.stringify(session.items);
  hub.smartRouter.complete = async () => { throw new Error('Provider offline'); };
  await assert.rejects(hub.compact(session.id), /Provider offline/);
  assert.equal(JSON.stringify(session.items), original);
  assert.equal(session.hubSummaryThrough, undefined); assert.equal(hub.busy, null);
});

test('conversation deltas carry new messages, extended tool results, changed and removed fields', () => {
  const sent = { conversation: [{ id: 'a' }], toolResults: [{ tool: 'x' }], agents: [1], agentMail: { id: 1 } };
  const delta = conversationDelta(sent, { conversation: [{ id: 'a' }, { id: 'b' }], toolResults: [{ tool: 'x' }, { tool: 'y' }], agents: [2] });
  assert.deepEqual(delta.newMessages, [{ id: 'b' }]);
  assert.deepEqual(delta.newToolResults, [{ tool: 'y' }]);
  assert.deepEqual(delta.agents, [2]);
  assert.equal(delta.agentMail, null, 'a field that disappeared is sent as null');
  assert.deepEqual(conversationDelta(sent, { ...sent, toolResults: [] }).toolResults, [], 'a new request resets toolResults');
  assert.equal(conversationDelta(sent, { conversation: [{ id: 'z' }] }), null, 'a chat that no longer extends the thread cannot be diffed');
});

test('a Hub chat keeps one Codex thread and sends only what changed; anything else starts a fresh thread', async t => {
  const { root } = await setup(t);
  const client = new Client();
  let threads = 0, loseThread = null;
  client.call = async (method, params) => {
    client.calls.push({ method, params });
    if (method === 'config/read') return { config: {} };
    if (method === 'thread/start') return { thread: { id: `thread-${++threads}` } };
    if (method === 'turn/start') {
      if (params.threadId === loseThread) {
        loseThread = null;
        throw new Error('thread not found');
      }
      queueMicrotask(() => {
        client.emit('notification', { method: 'item/completed', params: { threadId: params.threadId, item: { type: 'agentMessage', text: JSON.stringify(answer('ok')) } } });
        client.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { status: 'completed' } } });
      });
    }
    return {};
  };
  const router = new SmartRouter(path.join(root, 'kept'), () => client);
  t.after(() => router.close());
  const ask = (context, instructions = 'Hub policy') => router.complete({ instructions, prompt: JSON.stringify(context), schema: { type: 'object' },
    conversation: { key: 'chat-1', context } }, { model: 'test', effort: 'low' }, new AbortController());
  const turns = () => client.calls.filter(call => call.method === 'turn/start');
  const sent = turn => JSON.parse(turn.params.input[0].text);

  const first = { conversation: [{ id: 'm1', role: 'user', text: 'Hi' }], agents: ['A'], toolResults: [] };
  await ask(first);
  const second = { ...first, conversation: [...first.conversation, { id: 'm2', role: 'assistant', text: 'Hello' }, { id: 'm3', role: 'user', text: 'Next' }] };
  await ask(second);
  assert.equal(threads, 1, 'the second call continues the kept thread');
  assert.equal(turns()[1].params.threadId, 'thread-1');
  assert.deepEqual(sent(turns()[1]).newMessages.map(message => message.id), ['m2', 'm3']);
  assert.equal(Object.hasOwn(sent(turns()[1]), 'agents'), false, 'unchanged fields are not resent');
  assert.equal(client.calls.some(call => call.method === 'thread/unsubscribe'), false, 'the kept thread stays subscribed');

  await ask({ ...second, toolResults: [{ tool: 'agents_list', result: [] }] });
  assert.deepEqual(sent(turns().at(-1)).newToolResults, [{ tool: 'agents_list', result: [] }]);

  loseThread = 'thread-1';
  await ask({ ...second, toolResults: [{ tool: 'agents_list', result: [] }], agents: ['A', 'B'] });
  assert.equal(threads, 2, 'a lost kept thread is replaced in the same call');
  assert.deepEqual(sent(turns().at(-1)).agents, ['A', 'B'], 'the replacement gets the full prompt');

  await ask({ conversation: [{ id: 'other', role: 'user', text: 'Cleared chat' }], agents: ['A'], toolResults: [] });
  assert.equal(threads, 3, 'a chat that no longer extends the thread starts fresh');
  assert.equal(sent(turns().at(-1)).conversation[0].id, 'other');
  await ask({ conversation: [{ id: 'other', role: 'user', text: 'Cleared chat' }], agents: ['A'], toolResults: [] }, 'Renamed Hub policy');
  assert.equal(threads, 4, 'changed instructions start a fresh thread');
});

test('structured Hub inference uses isolated tool-free provider configuration', async t => {
  const { root } = await setup(t);
  const client = new Client();
  client.call = async (method, params) => {
    client.calls.push({ method, params });
    if (method === 'config/read') return { config: { mcp_servers: { external: {} }, plugins: { extra: {} } } };
    if (method === 'thread/start') return { thread: { id: 'isolated' } };
    if (method === 'turn/start') {
      queueMicrotask(() => {
        client.emit('notification', { method: 'item/completed', params: { threadId: 'isolated', item: { type: 'agentMessage', text: JSON.stringify(answer('Hello')) } } });
        client.emit('notification', { method: 'turn/completed', params: { threadId: 'isolated', turn: { status: 'completed' } } });
      });
    }
    return {};
  };
  const router = new SmartRouter(path.join(root, 'isolated'), () => client);
  t.after(() => router.close());
  await router.complete({ instructions: 'Hub policy', prompt: 'Hello', schema: { type: 'object' } }, { model: 'test', effort: 'low' }, new AbortController());
  const params = client.calls.find(c => c.method === 'thread/start').params;
  assert.equal(params.baseInstructions, 'Hub policy'); assert.equal(params.ephemeral, true);
  assert.equal(params.sandbox, 'read-only'); assert.equal(params.approvalPolicy, 'never');
  assert.equal(params.config['features.shell_tool'], false); assert.equal(params.config['features.multi_agent'], false);
  assert.equal(params.config.web_search, 'disabled'); assert.equal(params.config.project_doc_max_bytes, 0);
  assert.deepEqual(params.config.mcp_servers, { external: { enabled: false } });
  assert.deepEqual(params.config.plugins, { extra: { enabled: false } });
  // API providers answer through their own endpoint (providers.structured) and never start a Codex thread.
  const local = { provider: 'lm-studio', model: 'fixed-effort-model', effort: null };
  const codexStarts = client.calls.filter(c => c.method === 'thread/start').length;
  let structuredChoice;
  router.providers = {
    structured: async choice => {
      structuredChoice = choice;
      return { decision: answer('Hello'), usage: null };
    },
  };
  await router.complete({ instructions: 'Hub policy', prompt: 'Hello', schema: { type: 'object' } }, local, new AbortController());
  assert.equal(structuredChoice, local);
  assert.equal(client.calls.filter(c => c.method === 'thread/start').length, codexStarts);
  for (const provider of ['claude-cli', 'cursor-cli']) {
    let options;
    router[provider === 'claude-cli' ? 'claude' : 'cursor'] = { run: async value => { options = value; return { result: JSON.stringify(answer('Hello')) }; } };
    await router.complete({ instructions: 'Hub policy', prompt: 'Hello', schema: { type: 'object' } }, { provider, model: 'test' }, new AbortController());
    assert.ok(options.schema); assert.equal(options.cwd, path.join(root, 'isolated'));
    assert.equal(options.resume, undefined); assert.equal(options.helpers, undefined);
  }
});

test('Hub uses local structured inference for replies and never treats malformed replies as actions', async t => {
  const { hub, session, root, send } = await setup(t);
  for (const provider of ['codex', 'claude-cli', 'cursor-cli']) hub.setProviderEnabled(provider, false);
  hub.providerSettings({ action: 'provider', provider: { id: 'local', name: 'Local', baseUrl: 'http://localhost:1234/v1' } });
  hub.providerSettings({ action: 'model', model: { provider: 'local', model: 'local-chat', label: 'Local chat', description: '', rank: 30 } });
  hub.data.settings.mode = 'auto';
  await hub.refreshAccount();
  const router = new SmartRouter(root, () => assert.fail('Local structured inference must not use the Responses backend'));
  t.after(() => router.close());
  let reply = answer('Hello from local Hub');
  router.providers = { structured: async (choice, request, signal) => {
    assert.equal(choice.provider, 'local'); assert.equal(choice.effort, null);
    assert.ok(request.schema.properties.action.anyOf.some(s => s.properties?.tool.enum.includes('agent_work')));
    assert.match(request.instructions, /permanent chat and coordination/);
    assert.equal(signal.aborted, false);
    if (reply instanceof Error) throw reply;
    return { decision: reply };
  } };
  hub.smartRouter = router;
  await send('hello');
  assert.equal(session.items.at(-1).text, 'Hello from local Hub');
  for (const invalid of [new Error('Local returned an invalid structured response. No action was taken.'), action('unknown_action', {})]) {
    reply = invalid;
    await assert.rejects(send('hello again'), /invalid.*response/);
    assert.equal(hub.data.agents.length, 0);
    assert.equal(session.status, 'failed');
  }
});

test('Hub hands off structured arguments with Windows paths, quotes and pasted text intact', async t => {
  const { hub, session, agents, replies, calls, send } = await setup(t);
  const task = String.raw`Review C:\new\tasks\PhasmaEngine and \\server\share\PE. Preserve "quoted text" and Ω.` + '\nSecond line.';
  replies.push(JSON.parse(JSON.stringify(action('agent_work', { task, workspace: session.workspace, name: 'Reviewer', agentId: null, mode: null, effort: null }))));
  await send('Review PE changes');
  const worker = agents.execution(session.hubWorker), work = agents.conversation(worker);
  assert.ok(work.delegation.task.includes(task + '\n\nOriginal request:'), work.delegation.task);
  assert.equal(work.workspace, session.workspace);
  assert.equal(worker.data.settings.mode, 'auto'); assert.equal(work.access, session.access);
  const variant = calls[0].request.schema.properties.action.anyOf.find(s => s.properties?.tool.enum.includes('agent_work'));
  assert.equal(variant.properties.arguments.type, 'object');
  assert.deepEqual(variant.properties.arguments.required, Object.keys(variant.properties.arguments.properties));
  assert.ok(variant.properties.arguments.properties.mode.anyOf.some(s => s.type === 'null'));
});

test('Hub rejects malformed or mismatched action arguments before any side effect', async t => {
  const { hub, replies, send } = await setup(t);
  const malformed = String.raw`{"workspace":"C:\Users\Christos\repos\PhasmaEngine","task":"Review"}`;
  for (const decision of [
    { reply: '', tool: 'agent_work', arguments: malformed },
    action('agent_work', malformed), action('agent_work', []), action('agent_work', null),
    action('agent_work', { task: null }), action('agent_work', { task: 'Review', arbitrary: true }),
    action('agent_create', { name: 'Reviewer', task: 'Wrong tool arguments' }),
    action('agent_set_access', { agentId: 'missing', access: 'root' }),
    action('agent_read_context', { agentId: 'main', line: 1.5 }),
  ]) {
    replies.push(decision);
    await assert.rejects(send('Review changes'), /invalid response|invalid action arguments/);
    assert.equal(hub.data.agents.length, 0);
  }
});

test('Hub preserves the original request for routing, execution, disk and result checks despite misleading notes or later chat', async t => {
  const { hub, session, agents, replies, calls, send } = await setup(t);
  const original = String.raw`Review PE changes in C:\new\tasks\PhasmaEngine. Include "Ω" and untracked shaders; report file/line findings. Do not edit.`;
  let routed;
  agents.configure = async worker => {
    worker.smartRouter.choose = async text => { routed = text; return { id: 'terra-light', model: 'gpt-5.6-terra', effort: 'low', provider: 'codex', source: 'smart', needsChecks: false }; };
  };
  replies.push(action('agent_work', { name: 'Reviewer', task: 'Identify what PE means and provide only a summary.' }));
  await send(original);
  const worker = agents.execution(session.hubWorker), work = agents.conversation(worker);
  await until(() => worker.activeTurns.size > 0);
  assert.equal(routed, original);
  assert.equal(work.delegation.originalRequest.text, original);
  assert.equal(readSessionData(worker.filename).sessions[0].delegation.originalRequest.text, original);
  const input = worker.client.calls.find(call => call.method === 'turn/start').params.input[0].text;
  assert.ok(input.includes(original));
  assert.ok(input.indexOf(original) < input.indexOf('Identify what PE means'));
  assert.match(input, /must not replace, narrow or contradict/);
  await send('What is your name?');
  replies.push(answer('Review returned.'));
  worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Reviewed all changes. Finding at shader.hlsl:42 with evidence.' } } });
  worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
  await until(() => session.items.at(-1)?.text === 'Review returned.');
  const check = calls.find(call => call.request.schema.properties.fulfilled);
  assert.equal(JSON.parse(check.request.prompt).originalRequest.text, original);
  assert.equal(JSON.parse(calls.at(-1).request.prompt).originalRequest.text, original);
  assert.equal(session.hubRequest.text, 'What is your name?', 'returning work does not overwrite the latest user request');
});

test('an incomplete review is continued with its original scope and images, then stops honestly at the follow-up limit', async t => {
  const { hub, session, agents, replies, assessments, calls } = await setup(t);
  const original = 'Review all changed code, including untracked files, with concrete file/line findings.';
  const image = 'data:image/png;base64,aGVsbG8=';
  replies.push(action('agent_work', { name: 'Reviewer', task: 'Summarize what changed.' }));
  await hub.send({ id: session.id, text: original, images: [image] });
  const worker = agents.execution(session.hubWorker), work = agents.conversation(worker);
  for (let attempt = 1; attempt <= 3; attempt++) {
    await until(() => worker.activeTurns.size > 0);
    const job = work.delegation;
    assert.equal(job.originalRequest.attempts, attempt);
    assert.equal(job.originalRequest.text, original);
    assert.deepEqual(job.images, [image]);
    assessments.push({ fulfilled: false, evidence: 'The worker explicitly says it did not review the code.', gaps: ['Inspect the actual C++ and HLSL changes; a summary is insufficient.'] });
    worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'I did not read the C++ or HLSL diffs line by line, so this is not a code review. [task: done]' } } });
    worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
    if (attempt < 3) {
      await until(() => work.delegation.id !== job.id);
      assert.match(work.delegation.task, /Inspect the actual C\+\+ and HLSL changes/);
    } else await until(() => session.items.at(-1)?.text?.includes('automatic follow-up limit'));
  }
  assert.equal(hub.data.agents.length, 1);
  assert.equal(worker.busy, null);
  assert.equal(session.hubCompletion.fulfilled, false);
  assert.match(session.items.at(-1).text, /not been confirmed complete/);
  assert.equal(calls.filter(call => call.request.schema.properties.fulfilled).length, 3);
  assert.equal(calls.filter(call => call.request.schema.properties.action).length, 1, 'an incomplete result cannot reach a success-writing prompt');
});

test('invalid completion checks and a stop during a late check never dispatch more work', async t => {
  const { hub, session, agents, replies, assessments, send } = await setup(t);
  replies.push(action('agent_work', { name: 'Reviewer', task: 'Review.' }));
  await send('Review all code');
  const worker = agents.execution(session.hubWorker), work = agents.conversation(worker);
  await until(() => worker.activeTurns.size > 0);
  const agentResult = { request: work.delegation.originalRequest, agentId: worker.agentId, workspace: work.workspace, status: 'completed' };
  assessments.push({ fulfilled: true, evidence: '', gaps: [] });
  await hub.send({ id: session.id, text: 'Summary only.', agentReply: true, agentResult });
  assert.equal(session.hubCompletion.fulfilled, false);
  assert.match(session.items.at(-1).text, /could not verify/);
  assert.equal(session.agentDelegations, 1);
  let release;
  hub.smartRouter.complete = () => new Promise(resolve => { release = resolve; });
  const pending = hub.send({ id: session.id, text: 'Summary only.', agentReply: true, agentResult });
  await until(() => !!release);
  await hub.stop();
  release({ decision: { fulfilled: false, evidence: 'No review evidence.', gaps: ['Read the code.'] } });
  await pending;
  assert.equal(session.status, 'interrupted');
  assert.equal(session.agentDelegations, 1);
  assert.equal(agents.controllers.size, 2);
});

test('a new Hub request clears old task model retention while automatic continuations keep their request identity', async t => {
  const { hub, session, agents, replies, assessments, send } = await setup(t);
  const profile = await agents.saveAgent({ name: 'Previous reviewer', instructions: '', workspace: session.workspace, mode: 'auto', access: session.access });
  await agents.initialize();
  const worker = agents.execution(profile.id), work = agents.conversation(worker, true, session.workspace, session.access);
  const oldWorker = { id: 'terra-light', model: 'gpt-5.6-terra', effort: 'low', provider: 'codex' };
  work.job = { goal: 'Identify the PE acronym.', worker: oldWorker, status: 'done' };
  const contexts = [];
  worker.smartRouter.choose = async (text, context) => {
    contexts.push(context.job);
    return { ...oldWorker, source: 'smart', needsChecks: false, sameTask: !!context.job };
  };
  replies.push(action('agent_work', { agentId: profile.id, task: 'Summarize the project again.' }));
  await send('Review every changed source file');
  await until(() => worker.activeTurns.size > 0);
  assert.equal(contexts[0], null);
  assessments.push({ fulfilled: false, evidence: 'No source review completed.', gaps: ['Read the changed source.'] });
  const oldTurn = work.turnId;
  worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: oldTurn, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Summary only.' } } });
  worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: oldTurn, status: 'completed' } } });
  await until(() => contexts.length === 2);
  assert.equal(contexts[1].originalRequestId, work.delegation.originalRequest.id);
  assert.equal(contexts[1].goal, 'Review every changed source file');
});

test('completion never approves a partial report, oversized original request or failed worker', async t => {
  for (const scenario of ['report', 'request', 'failed']) await t.test(scenario, async t => {
    const { session, agents, replies, calls, send } = await setup(t);
    const original = 'Review every changed source file.' + (scenario === 'request' ? ' Constraint.'.repeat(1600) : '');
    replies.push(action('agent_work', { name: 'Reviewer', task: 'Review the changes.' }));
    await send(original);
    const worker = agents.execution(session.hubWorker), work = agents.conversation(worker);
    await until(() => worker.activeTurns.size > 0);
    const report = scenario === 'report' ? 'Earlier evidence.\n'.repeat(1000) + 'No bugs found.' : 'No bugs found.';
    worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: report } } });
    worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: scenario === 'failed' ? 'failed' : 'completed' } } });
    await until(() => session.items.at(-1)?.text?.includes('has not been confirmed complete'));
    assert.equal(session.hubCompletion.fulfilled, false, 'an optimistic model assessment cannot override missing evidence or a failed turn');
    assert.equal(session.agentDelegations, 1, 'do not retry execution to fix an assessment-size limit or failed turn');
    assert.equal(calls.filter(call => call.request.schema.properties.action).length, 1);
    const check = JSON.parse(calls.find(call => call.request.schema.properties.fulfilled).request.prompt);
    assert.equal(check.resultTruncated, scenario === 'report');
    assert.equal(check.originalRequest.truncated, scenario === 'request');
  });
});

test('a new delegation to an explicitly selected model starts its own task goal', async t => {
  const { session, agents, replies, send } = await setup(t);
  const profile = await agents.saveAgent({ name: 'Selected reviewer', instructions: '', workspace: session.workspace, mode: 'terra-light', access: session.access });
  await agents.initialize();
  const worker = agents.execution(profile.id), work = agents.conversation(worker, true, session.workspace, session.access);
  work.job = { goal: 'Previous pending work', status: 'pending', turns: 2 };
  replies.push(action('agent_work', { agentId: profile.id, mode: 'terra-light', task: 'Review changes.' }));
  await send('Use Selected reviewer to review every changed source file.');
  await until(() => worker.activeTurns.size > 0);
  worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
  assert.equal(work.job.goal, 'Use Selected reviewer to review every changed source file.');
  assert.equal(work.job.turns, 1);
  assert.equal(work.job.originalRequestId, work.delegation.originalRequest.id);
});


test('Hub compare starts on request with one Auto model, keeps only the change different, restores edited checks, then applies the better run and keeps a rule that helped', async t => {
  for (const target of ['bot', 'project']) await t.test(target, async t => {
    const { root, hub, session, agents, replies, calls, send } = await setup(t);
    const project = projectFixture(root, session);
    session.access = 'danger-full-access';
    fs.writeFileSync(path.join(project, 'check.cjs'), "process.exit(require('node:fs').existsSync('done.txt') ? 0 : 1);");
    hub.data.settings.checks[project] = [{ id: 'done-check', name: 'Done check', argv: [process.execPath, path.join(project, 'check.cjs')], cwd: project, timeoutMs: 10000 }];
    hub.lessonsFor = () => 'Lessons block for this comparison.';
    const change = 'Always create done.txt before anything else.';
    // No model named: Auto picks one for the request and both runs use it. The request itself is the approval.
    replies.push(action('compare', { task: 'Create done.txt.', change, target }));
    await send(`Compare creating done.txt with the instruction change "${change}"`);
    const record = Object.values(hub.data.comparisons)[0];
    assert.equal(record.state, 'running');
    assert.equal(record.mode, agents.agentMode('terra-light'), 'the model the router picked, pinned for both runs');
    assert.equal(hub.data.agents.length, 2);
    const started = session.items.at(-1);
    assert.match(started.text, /^Started the comparison: 2 runs on .+, judged by Done check\. The card below updates as they finish\.$/);
    assert.equal(started.hubComparison.state, 'running', 'the card sits under the start message');
    assert.ok(session.items.find(item => item.type === 'userMessage' && item.comparisonId), 'its batch report is replaced by the card');
    assert.equal(JSON.stringify(agents.snapshot()).includes('"variant"'), false, 'the change mapping stays out of the renderer state while it runs');
    const runs = record.runs.map(run => {
      const profile = hub.data.agents.find(agent => agent.name === run.name), worker = agents.execution(profile.id);
      return { run, profile, worker };
    });
    for (const { run, profile } of runs)
      assert.equal(profile.instructions.includes(change), target === 'bot' && run.variant);

    assert.deepEqual(hub.data.agents.map(agent => agent.name).sort(), ['Comparison 1 · A', 'Comparison 1 · B']);
    await until(() => runs.every(({ worker }) => worker.activeTurns.size), 20000);
    await hub.removeComparisonBots();
    assert.equal(hub.data.agents.length, 2, 'a running comparison keeps its bots');
    for (const { run, worker } of runs) {
      const work = agents.conversation(worker);
      const input = JSON.stringify(worker.client.calls.find(call => call.method === 'turn/start').params);
      assert.match(input, /Lessons block for this comparison/);
      assert.doesNotMatch(input, /instruction change|agent_read_context/, 'workers see the task, not the compare message');
      const developer = worker.client.calls.find(call => call.method === 'thread/start').params.developerInstructions;
      // Bot instructions and the project entry both travel in the developer instructions.
      assert.equal(developer.includes(change), run.variant, 'the change reaches only its run\'s provider');
      const entry = fs.readFileSync(path.join(work.workspace, 'PhasmaHarness.md'), 'utf8');
      assert.equal(entry.includes(change), target === 'project' && run.variant);
    }

    const finish = async (worker, text) => {
      const work = agents.conversation(worker), turns = worker.client.calls.filter(call => call.method === 'turn/start').length;
      worker.notification({ method: 'item/completed', params: { threadId: work.threadId, turnId: work.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text } } });
      worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: { id: work.turnId, status: 'completed' } } });
      return turns;
    };
    // The changed run gets it right first time. The other edits its check to pass, is judged by the restored one,
    // and needs a correction.
    const changed = runs.find(({ run }) => run.variant), current = runs.find(({ run }) => !run.variant);
    fs.writeFileSync(path.join(agents.conversation(changed.worker).workspace, 'done.txt'), 'done by the changed run');
    await finish(changed.worker, 'Created done.txt.');
    await until(() => started.hubComparison.runs.some(run => run.result) && !hub.busy, 20000);
    assert.equal(session.items.filter(item => item.hubComparison).length, 1, 'progress updates the card in place');
    assert.equal(session.items.filter(item => !item.internal && /runs returned/.test(item.text || '')).length, 0);
    const currentWork = agents.conversation(current.worker);
    fs.writeFileSync(path.join(currentWork.workspace, 'check.cjs'), 'process.exit(0);');
    const turns = await finish(current.worker, 'Made the check pass.');
    await until(() => current.worker.client.calls.filter(call => call.method === 'turn/start').length > turns && current.worker.activeTurns.size, 20000);
    fs.writeFileSync(path.join(currentWork.workspace, 'done.txt'), 'done by the current run');
    await finish(current.worker, 'Created done.txt.');
    await until(() => record.state === 'finished' && !hub.busy, 20000);

    // Nothing waits on the user: verdict, the better run applied, a project rule that helped kept, bots removed.
    const holders = session.items.filter(item => item.hubComparison);
    assert.deepEqual(holders, [session.items.at(-1)], 'the card moved down to the newest comparison message');
    const label = changed.run.label;
    assert.equal(session.items.at(-1).text, `The change helped (the change needed fewer corrections (0 instead of 1)). Applied run ${label}'s changes to the project: done.txt.` +
      (target === 'project' ? ` Added the rule to ${path.join(fs.realpathSync(project), 'PhasmaHarness.md')}.` : ''));
    const visible = session.items.filter(item => !item.internal);
    assert.equal(visible.filter(item => item.type === 'agentResult' || item.agentReply).length, 0, 'no per-run receipts or handoffs in the chat');
    const card = holders[0].hubComparison;
    assert.equal(card.revealed, true);
    assert.equal(card.verdict, 'helped', JSON.stringify(card.pairVerdicts));
    assert.equal(card.number, 1);
    const shown = name => card.runs.find(run => run.label === name).result;
    assert.deepEqual(shown(current.run.label).restored, ['check.cjs']);
    assert.equal(shown(current.run.label).corrections, 1);
    assert.equal(fs.readFileSync(path.join(project, 'done.txt'), 'utf8'), 'done by the changed run', 'the better run landed in the project');
    assert.equal(fs.readFileSync(path.join(project, 'check.cjs'), 'utf8').includes('existsSync'), true, 'the project check is untouched');
    assert.equal(calls.filter(call => call.request.schema.properties.fulfilled).length, 0, 'no completion check or follow-up for comparison runs');
    assert.equal(calls.filter(call => call.request.schema.properties.action).length, 1, 'one Hub call: the request');
    assert.equal(hub.data.comparisons[record.id], undefined);
    assert.deepEqual(hub.data.agents, [], 'the finished comparison\'s bots are removed');
    const entryFile = path.join(fs.realpathSync(project), 'PhasmaHarness.md');
    if (target === 'project') {
      assert.ok(fs.readFileSync(entryFile, 'utf8').trimEnd().endsWith(change), 'the rule that helped joins the project entry');
      await hub.undoComparison(session.id, record.id, 'rule');
      assert.equal(fs.readFileSync(entryFile, 'utf8').includes(change), false, 'Undo takes the rule out again');
    } else assert.equal(card.adopted, null, 'only project rules are added to the project entry');
    await hub.undoComparison(session.id, record.id, 'apply');
    assert.equal(fs.existsSync(path.join(project, 'done.txt')), false, 'Undo removes what the comparison applied');
    await assert.rejects(hub.undoComparison(session.id, record.id, 'apply'), /no applied run to undo/);
  });
});

test('a lesson that did not stick tests a permanent rule on the next matching task by itself, once, and only on a matching task', async t => {
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  const { root, hub, session, agents, replies, send, calls } = await setup(t);
  const project = projectFixture(root, session);
  fs.writeFileSync(path.join(project, 'check.cjs'), "process.exit(require('node:fs').existsSync('done.txt') ? 0 : 1);");
  hub.data.settings.checks[project] = [{ id: 'done-check', name: 'Done check', argv: [process.execPath, path.join(project, 'check.cjs')], cwd: project, timeoutMs: 10000 }];
  hub.wikiStore = new WikiStore(path.join(root, 'wiki-store'));
  const lessons = hub.wikiStore.ensure(project).root;
  const failure = { check: 'Done check', exitCode: 1, excerpt: 'done.txt is missing' };
  fs.writeFileSync(path.join(lessons, 'lessons.json'), JSON.stringify([{ taskId: 'earlier', at: Date.now(), goal: 'Create done.txt', outcome: 'fixed',
    failures: [failure], changed: [], seen: 2, situation: { checks: ['Done check'], error: 'done.txt is missing' },
    verdict: 'helped', verdicts: { helped: 2 }, confidence: 'medium', recurred: { at: Date.now(), mode: 'codex:gpt-5.6-terra:low' } }]));
  const lesson = () => JSON.parse(fs.readFileSync(path.join(lessons, 'lessons.json'), 'utf8'))[0];

  replies.push(action('agent_work', { name: 'Poet', task: 'Write a haiku about rain.' }));
  await send('Write a haiku about rain');
  assert.deepEqual(hub.data.agents.map(agent => agent.name), ['Poet'], 'an unrelated request is just dispatched');
  assert.equal(hub.data.comparisons, undefined);

  replies.push(action('agent_work', { name: 'Builder', task: 'Create done.txt.' }));
  await send('Create done.txt in the project');
  const record = Object.values(hub.data.comparisons)[0];
  assert.ok(record, 'a matching request starts the comparison with no question');
  assert.equal(record.suggested, true);
  assert.equal(record.target, 'project');
  assert.equal(record.mode, 'codex:gpt-5.6-terra:low', 'pinned to the model the lesson failed on');
  assert.match(record.change, /^"Done check" has failed more than once with: done\.txt is missing/);
  assert.equal(record.task, 'Create done.txt in the project', 'the runs get the original request');
  const request = session.items.findLast(item => item.type === 'userMessage');
  assert.equal(request.comparisonId, record.id, 'the batch hangs on the original request');
  assert.deepEqual(hub.data.agents.map(agent => agent.name).sort(), ['Comparison 1 · A', 'Comparison 1 · B', 'Poet']);
  assert.match(session.items.at(-1).text, /^This kind of task failed the same way before, even with the saved lesson \("Done check": done\.txt is missing\)\. So I am running it twice on .+: as usual, and with this rule in PhasmaHarness\.md:/);
  assert.equal(session.items.at(-1).hubComparison.state, 'running');
  assert.ok(lesson().suggestedAt, 'tested once per lesson');
  assert.equal(calls.filter(call => call.request.schema.properties.action).length, 2, 'no extra Hub call to start it');

  replies.push(answer('Done.'));
  await send('Create done.txt again');
  assert.equal(session.items.at(-1).text, 'Done.', 'the same lesson never starts a second comparison');
  assert.equal(Object.keys(hub.data.comparisons).length, 1);
  assert.ok(agents);
});

test('a comparison left waiting for a pick (from before results were automatic) settles at startup', async t => {
  const { root, hub, session } = await setup(t);
  const result = { status: 'completed', checks: { 'Done check': 'failed' }, corrections: 1, setups: [{ hash: 'h' }], restored: [], tokens: 10, activeMs: 10 };
  const record = { id: randomUUID(), at: Date.now(), state: 'finished', project: root, task: 'Create done.txt.', change: 'Rule.', target: 'project',
    pairs: 1, model: 'Terra', threshold: 0.2, sessionId: session.id, verdict: 'no observed effect', confidence: 'low',
    pairVerdicts: [{ pair: 1, verdict: 'no observed effect', reason: 'both runs failed the same checks' }],
    runs: [{ index: 1, pair: 1, label: 'A', variant: true, result }, { index: 2, pair: 1, label: 'B', variant: false, result }] };
  hub.data.comparisons = { [record.id]: record };
  session.items.push({ id: 'waiting-card', type: 'agentMessage', phase: 'final_answer', text: 'Both runs are back. Which did better?',
    hubComparison: { id: record.id, revealed: false } });
  await hub.settleWaitingComparisons();
  assert.equal(hub.data.comparisons[record.id], undefined);
  const card = session.items.find(item => item.id === 'waiting-card').hubComparison;
  assert.equal(card.revealed, true);
  assert.equal(card.verdict, 'no observed effect');
  assert.match(card.applied.error, /No run passed every check/);
});

test('a reflected rule is what a lesson that did not stick tests, and a reflection that chose keep tests nothing', async t => {
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  for (const reflection of [{ rule: 'Create done.txt before reporting the task finished.', moment: 'done.txt is missing', hash: 'h' }, { keep: true, reason: 'Noise.', hash: 'h' }])
    await t.test(reflection.keep ? 'keep' : 'rule', async t => {
      const { root, hub, session, replies, send } = await setup(t);
      const project = projectFixture(root, session);
      fs.writeFileSync(path.join(project, 'check.cjs'), "process.exit(require('node:fs').existsSync('done.txt') ? 0 : 1);");
      hub.data.settings.checks[project] = [{ id: 'done-check', name: 'Done check', argv: [process.execPath, path.join(project, 'check.cjs')], cwd: project, timeoutMs: 10000 }];
      hub.wikiStore = new WikiStore(path.join(root, 'wiki-store'));
      fs.writeFileSync(path.join(hub.wikiStore.ensure(project).root, 'lessons.json'), JSON.stringify([{ taskId: 'earlier', at: Date.now(), goal: 'Create done.txt',
        outcome: 'fixed', failures: [{ check: 'Done check', exitCode: 1, excerpt: 'done.txt is missing' }], changed: [], seen: 2,
        situation: { checks: ['Done check'], error: 'done.txt is missing' }, verdict: 'helped', verdicts: { helped: 2 }, confidence: 'medium',
        recurred: { at: Date.now(), mode: 'codex:gpt-5.6-terra:low' }, reflection }]));
      replies.push(action('agent_work', { name: 'Builder', task: 'Create done.txt.' }));
      await send('Create done.txt in the project');
      const record = Object.values(hub.data.comparisons || {})[0];
      if (reflection.keep) {
        assert.equal(record, undefined, 'keep as is: the task is just done, no two runs');
        assert.deepEqual(hub.data.agents.map(agent => agent.name), ['Builder']);
      } else assert.equal(record.change, reflection.rule, 'the rule written from the run, not the template');
    });
});

test('a suggested comparison that helped puts its rule on trial, not into PhasmaHarness.md, and Undo takes it off', async t => {
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  const trials = require('../src/trials.cjs');
  const { root, hub, session } = await setup(t);
  const project = fs.realpathSync(projectFixture(root, session));
  hub.wikiStore = new WikiStore(path.join(root, 'wiki-store'));
  const result = { status: 'completed', checks: { 'Done check': 'failed' }, corrections: 1, setups: [{ hash: 'h' }], restored: [], tokens: 10, activeMs: 10 };
  const record = { id: randomUUID(), at: Date.now(), state: 'finished', revealedAt: Date.now(), project, task: 'Create done.txt.', change: 'Create done.txt first.',
    target: 'project', pairs: 1, model: 'Terra', threshold: 0.2, sessionId: session.id, suggested: true, verdict: 'helped', confidence: 'low',
    lesson: { key: 'k', check: 'Done check', error: 'done.txt is missing', goal: 'Create done.txt' },
    pairVerdicts: [{ pair: 1, verdict: 'helped', reason: 'with the change Done check passed, which failed without it' }],
    runs: [{ index: 1, pair: 1, label: 'A', variant: true, result }, { index: 2, pair: 1, label: 'B', variant: false, result }] };
  hub.data.comparisons = { [record.id]: record };
  const item = { id: 'card', type: 'agentMessage', phase: 'final_answer', text: 'The change helped.' };
  session.items.push(item);
  await hub.settleComparison(record);
  hub.comparisonCard(session, record, item);

  const rulesRoot = hub.wikiStore.location(project).root;
  assert.deepEqual(trials.readRules(rulesRoot).map(rule => [rule.rule, rule.state, rule.check, rule.source]),
    [['Create done.txt first.', 'trial', 'Done check', 'a suggested comparison']], 'one pair is weak evidence: the rule goes on trial');
  assert.equal(fs.existsSync(path.join(project, 'PhasmaHarness.md')) && fs.readFileSync(path.join(project, 'PhasmaHarness.md'), 'utf8').includes('Create done.txt first.'), false);
  assert.equal(item.hubComparison.adopted.trial, true);
  // Kept since then: Undo takes its line out of PhasmaHarness.md too.
  const file = require('../src/workspace/project-instructions.cjs').projectEntry(project, true);
  fs.writeFileSync(file, '# Project instructions\n\nStay small.\n');
  const line = trials.keepInInstructions(file, { rule: 'Create done.txt first.', keptAt: Date.now() });
  trials.updateRules(rulesRoot, records => Object.assign(records[0], { state: 'kept', keptAt: Date.now(), line }));
  await hub.undoComparison(session.id, record.id, 'rule');
  assert.equal(trials.readRules(rulesRoot)[0].state, 'removed');
  assert.equal(fs.readFileSync(file, 'utf8'), '# Project instructions\n\nStay small.\n');
});
