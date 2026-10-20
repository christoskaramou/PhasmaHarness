const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Controller } = require('../src/controller.cjs');
const { Agents } = require('../src/agents.cjs');
const { MCP_TOOLS, claudeAllowedHelpers } = require('../src/tools/router-bridge.cjs');
const test = (name, run) => nodeTest(name, { timeout: 5000 }, run);

class Fake extends EventEmitter {
  constructor() { super(); this.calls = []; this.responses = []; }
  async start() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } };
    if (method === 'model/list') return { data: this.models || [{ model: 'gpt-5.6-terra', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || randomUUID() } };
    if (method === 'thread/items/list') return { data: [], nextCursor: null };
    if (method === 'turn/start') return { turn: { id: randomUUID() } };
    if (method === 'turn/interrupt') queueMicrotask(() => this.emit('notification', { method: 'turn/completed', params: { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } } }));
    return {};
  }
  respond(id, result) { this.responses.push({ id, result }); }
  rejectRequest(id, reason) { this.responses.push({ id, error: reason }); }
  close() {}
}

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-agents-'));
  const workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  const factory = (file, cwd, options) => {
    const c = new Controller(file, cwd, new Fake(), { cancel() {}, close() {}, async choose() { throw new Error('Unexpected model routing'); } }, options);
    // These fixtures exercise execution-capable workers; Hub's restricted runtime is covered in coordinator.test.cjs.
    c.isCoordinator = () => false;
    c.claude.refresh = async () => c.claude.status;
    c.cursor.refresh = async () => c.cursor.status;
    return c;
  };
  const primary = factory(path.join(directory, 'sessions.json'), workspace);
  await primary.initialize(); primary.data.settings.mode = 'terra-light';
  const agents = new Agents(primary, async () => {}, factory);
  t.after(async () => {
    agents.closing = true; agents.pump();
    clearTimeout(agents.quotaTimer);
    await Promise.all(agents.initializing.values());
    await agents.downloads.close();
    for (const c of agents.allControllers()) c.close();
    fs.rmSync(directory, { force: true, recursive: true });
  });
  const add = async (name, cwd = workspace, access = 'workspace-write') => {
    const profile = await agents.saveAgent({ name, workspace: cwd, access, mode: 'terra-light', instructions: `Role: ${name}` });
    await agents.initializeController(agents.controller(profile.id));
    return agents.controller(profile.id);
  };
  const addWorker = async (...args) => {
    const bot = await add(...args), execution = agents.execution(bot.agentId);
    await agents.initializeController(execution);
    return execution;
  };
  return { agents, primary, workspace, directory, factory, add, addWorker };
}
async function until(check) {
  for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(check(), 'Condition did not become true within one second');
}
function complete(c, s, text = 'Verified result.') {
  c.notification({ method: 'item/completed', params: { threadId: s.threadId, turnId: s.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text } } });
  c.notification({ method: 'turn/completed', params: { threadId: s.threadId, turn: { id: s.turnId, status: 'completed' } } });
}
const start = (c, s) => c.send({ id: s.id, text: 'Inspect this project', mode: 'terra-light', task: 'off' });

test('direct tracked tasks reserve their budget before routing and do not charge later chat to it', async t => {
  const { agents, add } = await setup(t);
  const bot = await add('Direct task');
  const chat = agents.conversation(bot, true);
  let routedBudget;
  bot.smartRouter.choose = async () => {
    routedBudget = agents.budgets.forSession(chat);
    assert.ok(routedBudget, 'routing must already belong to the tracked task');
    assert.ok(JSON.parse(fs.readFileSync(bot.filename, 'utf8')).sessions[0].tasks[0].budgetId);
    return { ...bot.resolveWorker('terra-light'), assessment: { needsChecks: false } };
  };
  await bot.send({ id: chat.id, text: 'Complete this direct task.', mode: 'auto', task: 'on' });
  const task = chat.tasks[0];
  assert.equal(task.foreground, true);
  assert.equal(task.budgetId, routedBudget.id);
  assert.equal(chat.activeTaskId, task.id);
  assert.equal(agents.budgets.snapshot()[task.budgetId].usage.attempts, 1);
  complete(bot, chat);
  await until(() => !bot.busy);
  assert.equal(chat.activeTaskId, null);
  await start(bot, chat);
  assert.equal(agents.budgets.forSession(chat), null);
  assert.equal(agents.budgets.snapshot()[task.budgetId].usage.attempts, 1);
  complete(bot, chat);
});

test('a direct-task router usage limit pauses before any fallback request', async t => {
  const { agents, add } = await setup(t);
  const bot = await add('Router limit'), chat = agents.conversation(bot, true);
  let attempts = 0;
  bot.effectiveRouter = () => ({ ...bot.resolveWorker('terra-light'), id: attempts ? 'replacement-router' : 'original-router' });
  bot.smartRouter.choose = async () => {
    attempts++;
    if (attempts > 1) return bot.resolveWorker('terra-light');
    throw Object.assign(new Error('Router allowance exhausted'), { limitProvider: 'codex', limit: { reason: 'Router allowance exhausted' } });
  };
  await assert.rejects(bot.send({ id: chat.id, text: 'Do not change billing routes.', mode: 'auto', task: 'on' }), /Router allowance exhausted/);
  await until(() => !bot.busy && !agents.budgets.operations.size);
  assert.equal(attempts, 1);
  assert.equal(chat.tasks[0].budgetPaused, true);
  assert.equal(agents.budgets.forJob(chat.tasks[0]).state, 'paused');
  assert.equal(bot.client.calls.some(call => call.method === 'turn/start'), false);
  await agents.stop(chat.tasks[0].id);
});

test('state snapshots omit inline images, keep their counts and serve each image on demand', async t => {
  const { agents, add } = await setup(t);
  const bot = await add('Image owner');
  const chat = agents.conversation(bot, true);
  const image = 'data:image/png;base64,' + 'QUFB'.repeat(1000), queued = 'data:image/jpeg;base64,' + 'QkJC'.repeat(1000);
  await bot.send({ id: chat.id, text: 'Look at this.', images: [image], mode: 'terra-light', task: 'on' });
  await bot.send({ id: chat.id, text: 'And this.', images: [queued], mode: 'terra-light', task: 'on' });
  const item = chat.items.find(entry => entry.type === 'userMessage' && entry.content.some(part => part.type === 'image'));
  assert.equal(chat.queue[0].images[0], queued);
  chat.items.push({ id: 'tool-image', type: 'mcpToolCall', status: 'completed', result: [
    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'Q0ND'.repeat(1000) } },
    { type: 'image', mimeType: 'image/png', data: 'RERE'.repeat(1000) }, { type: 'text', data: 'plain tool text' }] });
  const snapshot = agents.snapshot(), text = JSON.stringify(snapshot);
  assert.equal(text.includes('QUFB'), false);
  assert.equal(text.includes('QkJC'), false);
  assert.equal(text.includes('Q0ND') || text.includes('RERE'), false, 'tool-result images stay on the runner');
  assert.match(text, /plain tool text/);
  const view = snapshot.agentStates[bot.agentId].sessions.find(session => session.id === chat.id);
  assert.deepEqual(view.items.find(entry => entry.id === item.id).content.filter(part => part.type === 'image'), [{ type: 'image', url: null }]);
  assert.deepEqual(view.queue[0].images, [null]);
  assert.equal(item.content.find(part => part.type === 'image').url, image);
  assert.equal(bot.image(chat.id, item.id, 0), image);
  chat.pendingMessage = { id: 'pending-image', type: 'userMessage', pending: true, content: [{ type: 'image', url: queued }] };
  assert.equal(bot.image(chat.id, 'pending-image', 0), queued, 'a message still being routed shows its image');
  assert.throws(() => bot.image(chat.id, item.id, 1), /no longer available/);
  assert.throws(() => bot.image(chat.id, item.id, '0'), /Invalid image request/);
});

test('paused direct work resumes privately with its original goal, checks and corrections while public chat stays free', async t => {
  const { agents, add, workspace } = await setup(t);
  const bot = await add('Direct owner');
  const chat = agents.conversation(bot, true);
  const image = 'data:image/png;base64,AA==', amendmentImage = 'data:image/png;base64,AQ==';
  const goal = 'Keep the entire accepted task. '.repeat(800);
  await bot.send({ id: chat.id, text: goal, images: [image], mode: 'terra-light', task: 'on' });
  const task = chat.tasks[0], budget = agents.budgets.forJob(task);
  assert.equal(bot.activeTurns.has(chat.id), true);
  task.corrections = 1;
  task.amendments.push({ text: 'Preserve this accepted amendment.', images: [amendmentImage] });
  task.attempts.push({ results: [{ name: 'Earlier check', status: 'failed', exitCode: 1 }], at: Date.now() });
  const originalChecks = JSON.parse(JSON.stringify(task.checks));
  budget.limitMs = 60; agents.budgets.persist(); agents.pump();
  await until(() => task.budgetPaused && !bot.busy && !agents.budgets.operations.size);
  const savedId = task.resumeJobId, used = budget.usedMs;
  bot.data.settings.checks[workspace] = [{ name: 'Changed later', command: 'node', args: ['-e', 'process.exit(1)'] }];
  await start(bot, chat);
  const publicTurn = chat.turnId;
  agents.budgets.update({ jobId: task.id, expectedVersion: budget.version, limitMinutes: 1, resume: true });
  await until(() => !!task.resumedAsJobId);
  const resumed = agents.findJob(savedId);
  await until(() => resumed.controller.activeTurns.has(resumed.session.id));
  assert.notEqual(resumed.controller, bot);
  assert.equal(resumed.controller.agentId, bot.agentId);
  assert.equal(resumed.job.owner, chat.id);
  assert.equal(resumed.job.budgetId, budget.id);
  assert.equal(resumed.job.originalRequest.text, goal);
  assert.equal(agents.executionText(resumed.job), goal);
  assert.equal(resumed.session.workspace, workspace);
  assert.equal(resumed.job.access, task.access);
  assert.deepEqual(resumed.job.images, [image, amendmentImage]);
  assert.deepEqual(resumed.job.taskChecks, originalChecks);
  assert.equal(resumed.session.tasks.at(-1).corrections, 1);
  assert.match(agents.instructions(resumed.controller, resumed.session), /Preserve this accepted amendment/);
  assert.match(agents.instructions(resumed.controller, resumed.session), /Earlier check/);
  assert.equal(budget.usedMs, used, 'resuming never resets consumed time');
  assert.equal(chat.turnId, publicTurn);
  assert.equal(bot.activeTurns.has(chat.id), true);
  agents.pump();
  assert.equal(agents.pendingJobs().filter(record => record.job.id === savedId).length, 1);
  await agents.stop(task.id);
  await until(() => resumed.job.delivered);
  assert.equal(bot.activeTurns.has(chat.id), true, 'stopping the old task leaves the new public turn running');
  assert.equal(chat.items.filter(item => item.deliveryId === savedId).length, 1);
  complete(bot, chat);
});

test('direct-task resume holds rather than losing images or changing the accepted workspace or model', async t => {
  const { agents, add, workspace } = await setup(t);
  const bot = await add('Held direct task'), chat = agents.conversation(bot, true);
  await bot.send({ id: chat.id, text: 'Preserve original inputs.', mode: 'terra-light', task: 'on' });
  const task = chat.tasks[0], budget = agents.budgets.forJob(task);
  agents.budgets.pause(budget);
  await until(() => !bot.busy && !agents.budgets.operations.size);
  task.originalImageCount = 1; delete task.inputImages;
  agents.budgets.update({ jobId: task.id, expectedVersion: budget.version, limitMinutes: 1, resume: true });
  assert.match(task.budgetResumeError, /images are unavailable/);
  assert.equal(agents.pendingJobs().length, 0);
  task.originalImageCount = 0; task.inputImages = [];
  task.amendments = Array.from({ length: 5 }, (_, index) => ({ text: 'Accepted image', images: ['data:image/png;base64,' + index] }));
  agents.pump();
  assert.match(task.budgetResumeError, /four-image/);
  task.amendments = [];
  task.workspace = path.join(workspace, 'changed'); fs.mkdirSync(task.workspace);
  agents.pump();
  assert.match(task.budgetResumeError, /workspace changed/);
  task.workspace = workspace; task.route.model = 'model-that-is-not-available';
  agents.pump();
  assert.match(task.budgetResumeError, /accepted task model is unavailable/);
  assert.equal(agents.pendingJobs().length, 0);
  await agents.stop(task.id);
});

test('paused task approvals cannot act after the public chat has moved on and snapshots omit cached inputs', async t => {
  const { agents, add } = await setup(t);
  const bot = await add('Approval owner'), chat = agents.conversation(bot, true);
  await bot.send({ id: chat.id, text: 'Task needing approval.', images: ['data:image/png;base64,AA=='], mode: 'terra-light', task: 'on' });
  const task = chat.tasks[0], budget = agents.budgets.forJob(task);
  const oldTurnId = chat.turnId;
  bot.serverRequest({ id: 'old-task-approval', method: 'item/commandExecution/requestApproval', params: { threadId: chat.threadId, turnId: chat.turnId, command: 'fixture' } });
  const approval = bot.requests.get('old-task-approval');
  assert.equal(approval.taskId, task.id);
  assert.equal(approval.budgetId, budget.id);
  agents.budgets.pause(budget);
  await until(() => !bot.busy && !agents.budgets.operations.size);
  await start(bot, chat);
  bot.serverRequest({ id: 'late-old-task-approval', method: 'item/commandExecution/requestApproval', params: { threadId: chat.threadId, turnId: oldTurnId, command: 'fixture' } });
  assert.equal(bot.requests.has('late-old-task-approval'), false);
  assert.match(bot.client.responses.find(response => response.id === 'late-old-task-approval').error, /no longer current/);
  bot.requests.set('old-task-approval', approval);
  assert.throws(() => bot.answer('old-task-approval', 'accept'), /paused|no longer current|stopped/);
  const view = agents.snapshot();
  assert.equal(view.agentStates[bot.agentId].sessions.find(item => item.id === chat.id).tasks[0].inputImages, undefined);
  assert.equal(view.agentStates.main.jobBudgets, undefined);
  assert.equal(view.jobBudgets[budget.id].requests, undefined);
  assert.ok(task.inputImages, 'server retains paused input needed for explicit continuation');
  complete(bot, chat);
  await agents.stop(task.id);
});

test('direct-task continuation retains one durable identity when the source link save fails', async t => {
  const { agents, add } = await setup(t);
  const bot = await add('Resume save'), chat = agents.conversation(bot, true);
  await bot.send({ id: chat.id, text: 'Continue once.', mode: 'terra-light', task: 'on' });
  const task = chat.tasks[0], budget = agents.budgets.forJob(task);
  agents.budgets.pause(budget);
  await until(() => !bot.busy && !agents.budgets.operations.size);
  agents.pump = () => {};
  task.budgetResumePending = true; budget.state = 'active';
  bot.save(); agents.budgets.persist();
  const execution = agents.execution(bot.agentId);
  await agents.initializeController(execution);
  const save = bot.save.bind(bot); let saves = 0;
  bot.save = () => { if (++saves === 2) throw new Error('Source continuation link save failed'); return save(); };
  assert.throws(() => agents.resumeForegroundTask({ controller: bot, session: chat, task }), /link save failed/);
  assert.equal(task.resumedAsJobId, undefined);
  assert.equal(task.budgetResumePending, true);
  assert.equal(chat.queuePaused, true);
  assert.equal(chat.queuePauseBudgetId, budget.id);
  assert.equal(agents.pendingJobs().length, 1, 'the accepted private job is still durable');
  bot.save = save;
  agents.resumeForegroundTask({ controller: bot, session: chat, task });
  assert.equal(task.resumedAsJobId, task.resumeJobId);
  assert.equal(agents.pendingJobs().length, 1, 'retry links the existing job rather than admitting another');
  assert.equal(chat.queuePaused, false);
  assert.equal(chat.queuePauseBudgetId, undefined);
});

test('an interrupted direct task and its helpers stay held for review after restart', async t => {
  const { agents, primary, add, addWorker, factory, workspace } = await setup(t);
  const bot = await add('Interrupted owner'), chat = agents.conversation(bot, true);
  await bot.send({ id: chat.id, text: 'Do not replay uncertain writes.', mode: 'terra-light', task: 'on' });
  const task = chat.tasks[0], budget = agents.budgets.forJob(task);
  const helper = await addWorker('Interrupted helper');
  const child = agents.delegate(bot, chat, helper.agentId, 'Inspect the original task.');
  assert.equal(agents.findJob(child.jobId).job.budgetId, budget.id);
  bot.save(); primary.save();
  const root = factory(primary.filename, workspace);
  const restored = new Agents(root, async () => {}, factory);
  t.after(() => { restored.closing = true; restored.budgets.close(); for (const c of restored.allControllers()) c.close(); });
  const loaded = restored.controller(bot.agentId).session(chat.id).tasks[0];
  assert.equal(loaded.budgetResumeReviewRequired, true);
  assert.equal(loaded.budgetResumePending, false);
  assert.equal(loaded.budgetPaused, true);
  const savedBudget = restored.budgets.forJob(loaded);
  assert.equal(savedBudget.state, 'paused');
  assert.throws(() => restored.budgets.update({ jobId: loaded.id, expectedVersion: savedBudget.version, limitMinutes: 120, resume: true }), /uncertain|review/i);
  restored.pump();
  assert.equal(restored.allControllers().some(c => c.client.calls.some(call => call.method === 'turn/start')), false);
  assert.equal(restored.budgets.held(restored.findJob(child.jobId).job), true);
});

test('host check facts reach the owner and exports without letting worker prose or reuse certify another job', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const owner = primary.create(); owner.queuePaused = true;
  primary.checks(workspace, [
    { id: 'compile', name: 'Compile', kind: 'build', argv: ['fixture-build'] },
    { id: 'start', name: 'Start', kind: 'launch', argv: ['fixture-launch'] },
  ]);
  const worker = await addWorker('Checked builder');
  worker.runCheck = async (_session, _task, check) => worker.classifyExec(check,
    { exitCode: check.kind === 'build' ? 0 : 1, stdout: 'Host fixture command output.' }, 5);
  const accepted = agents.delegate(primary, owner, worker.agentId, 'Build and launch the requested output.');
  const chat = worker.session(accepted.sessionId);
  await until(() => worker.activeTurns.has(chat.id));
  chat.tasks.at(-1).corrections = 1;
  complete(worker, chat, 'Everything builds, launches and plays perfectly.');
  await until(() => chat.delegation.delivered);
  const receipt = owner.items.find(item => item.deliveryId === accepted.jobId);
  assert.equal(receipt.verification.build.status, 'passed');
  assert.equal(receipt.verification.launch.status, 'failed');
  assert.equal(receipt.verification.gameplay.status, 'not-verified');
  assert.ok(receipt.verification.build.checks[0].at > 0);
  assert.equal(owner.queue[0].agentResult.verification.launch.status, 'failed');
  assert.match(require('../src/conversation-export.cjs').conversationMarkdown(owner), /Build: check passed.*Launch: check failed.*Gameplay: not verified/s);
  const next = agents.delegate(primary, owner, worker.agentId, 'Another independent task.');
  await until(() => worker.activeTurns.has(chat.id));
  assert.equal(agents.snapshot().jobVerification[next.jobId].build.status, 'not-verified');
  assert.equal(receipt.verification.build.status, 'passed');
});

test('published artifacts persist once, replace by version, and reach the result owner as file evidence', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const source = primary.create(); source.queuePaused = true;
  const worker = await addWorker('Builder');
  const accepted = agents.delegate(primary, source, worker.agentId, 'Produce the requested output.');
  const chat = worker.session(accepted.sessionId);
  await until(() => worker.activeTurns.has(chat.id));
  fs.writeFileSync(path.join(workspace, 'result.txt'), 'version one');
  const args = { artifactId: 'result', path: 'result.txt' };
  const first = await worker.bridgeTool(chat.id, 'agent_artifact', args);
  assert.equal(first.version, 1);
  assert.equal(first.scopeId, accepted.jobId);
  assert.equal((await worker.bridgeTool(chat.id, 'agent_artifact', args)).duplicate, true);
  assert.equal(chat.items.filter(item => item.type === 'agentArtifact').length, 1);
  await assert.rejects(worker.bridgeTool(chat.id, 'agent_artifact', { ...args, command: 'arbitrary shell' }));
  fs.writeFileSync(path.join(workspace, 'result.txt'), 'version two');
  await assert.rejects(worker.bridgeTool(chat.id, 'agent_artifact', args), /saved artifact version/);
  const save = worker.save;
  worker.save = () => { throw new Error('Artifact disk failure'); };
  await assert.rejects(worker.bridgeTool(chat.id, 'agent_artifact', { ...args, expectedVersion: 1 }), /Artifact disk failure/);
  assert.equal(chat.delegation.artifacts[0].version, 1);
  assert.equal(chat.items.find(item => item.id === first.receiptId).artifact.version, 1);
  worker.save = save;
  const second = await worker.bridgeTool(chat.id, 'agent_artifact', { ...args, expectedVersion: 1 });
  assert.equal(second.version, 2);
  complete(worker, chat, 'Output is available; checks have not run.');
  await until(() => chat.delegation.delivered);
  const receipt = source.items.find(item => item.deliveryId === accepted.jobId);
  assert.equal(receipt.artifacts[0].sha256, second.sha256);
  assert.match(source.queue.find(item => item.agentResult)?.text || receipt.pendingReply?.text, /publication does not verify build, launch or gameplay/);
  const action = { action: 'folder', sessionId: source.id, receiptId: receipt.id, artifactId: 'result', expectedVersion: 2 };
  let opened;
  assert.equal((await agents.artifactAction(action, async folder => { opened = folder; return ''; })).status, 'opened');
  assert.equal(opened, fs.realpathSync(workspace));
  await assert.rejects(agents.artifactAction({ ...action, expectedVersion: 1 }), /artifact changed/);
  await assert.rejects(agents.artifactAction({ ...action, path: '../outside' }), /saved artifact action/);
  await assert.rejects(agents.artifactAction({ ...action, action: 'run' }), /executable changed/);
  const { conversationMarkdown } = require('../src/conversation-export.cjs');
  assert.match(conversationMarkdown(source), /result.txt/);
  assert.match(conversationMarkdown(chat), /publication does not verify build, launch or gameplay/);
  await start(primary, source);
  assert.match(JSON.stringify(await primary.bridgeTool(source.id, 'agent_read_context', { agentId: 'main', query: 'result.txt' })), /result.txt/);
  complete(primary, source);
});

test('artifact publication requires live tracked work and rejects completion during inspection', async t => {
  const { agents, primary, workspace } = await setup(t);
  const source = primary.create();
  fs.writeFileSync(path.join(workspace, 'result.txt'), 'output');
  const args = { artifactId: 'result', path: 'result.txt' };
  await assert.rejects(agents.publishArtifact(primary, source, args), /active delegated or tracked task/);
  await start(primary, source);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_artifact', args), /active delegated or tracked task/);
  source.tasks = [{ id: 'tracked-task', state: 'working' }];
  source.submission.taskId = 'tracked-task';
  const published = await primary.bridgeTool(source.id, 'agent_artifact', args);
  assert.equal(published.scopeId, 'tracked-task');
  for (let i = 1; i < 16; i++) await primary.bridgeTool(source.id, 'agent_artifact', { ...args, artifactId: `output-${i}` });
  await assert.rejects(primary.bridgeTool(source.id, 'agent_artifact', { ...args, artifactId: 'overflow' }), /sixteen artifacts/);
  const artifactModule = require('../src/artifacts.cjs'), inspect = artifactModule.inspect;
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  t.mock.method(artifactModule, 'inspect', async (...values) => {
    const result = await inspect(...values); entered();
    await new Promise(resolve => { release = resolve; }); return result;
  });
  const pending = primary.bridgeTool(source.id, 'agent_artifact', args);
  const rejected = assert.rejects(pending, /changed or stopped/);
  await started;
  source.tasks[0].state = 'cancelled';
  release(); await rejected;
  assert.equal(source.items.filter(item => item.type === 'agentArtifact').length, 16);
  complete(primary, source);
});

test('artifact Run refuses active writers and stale receipts, then uses a tracked launch without shell input', async t => {
  const { agents, primary, workspace } = await setup(t);
  const source = primary.create();
  await start(primary, source);
  source.tasks = [{ id: 'tracked-game', state: 'working' }]; source.submission.taskId = 'tracked-game';
  const header = Buffer.alloc(128), filename = process.platform === 'win32' ? 'game.exe' : 'game';
  if (process.platform === 'win32') { header.write('MZ'); header.writeUInt32LE(64, 60); header.write('PE\0\0', 64); header.writeUInt16LE(2, 86); }
  else if (process.platform === 'darwin') { header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(2, 12); }
  else { header.set([0x7f, 69, 76, 70, 2, 1]); header.writeUInt16LE(2, 16); }
  fs.writeFileSync(path.join(workspace, filename), header, { mode: 0o700 });
  const published = await primary.bridgeTool(source.id, 'agent_artifact', { artifactId: 'game', path: filename });
  const action = { action: 'run', sessionId: source.id, receiptId: published.receiptId, artifactId: 'game', expectedVersion: 1 };
  let launches = 0, child;
  agents.artifactRuns.launch = (_file, args, options) => {
    launches++; assert.deepEqual(args, []); assert.equal(options.shell, false);
    child = new EventEmitter(); queueMicrotask(() => child.emit('spawn')); return child;
  };
  agents.artifactRuns.stopTree = async () => [];
  await assert.rejects(agents.artifactAction(action), /active work to finish/);
  assert.equal(launches, 0);
  source.tasks[0].state = 'not-checked';
  complete(primary, source);
  await until(() => !primary.busy);
  const run = await agents.artifactAction(action);
  assert.equal(run.status, 'started'); assert.equal(launches, 1);
  assert.equal(agents.snapshot().artifactRuns[0].id, run.id);
  await agents.artifactRuns.stop(run.id);
  const artifactModule = require('../src/artifacts.cjs'), verify = artifactModule.verify;
  t.mock.method(artifactModule, 'verify', async (...values) => {
    const resolved = await verify(...values);
    source.items = source.items.filter(item => item.id !== action.receiptId);
    return resolved;
  });
  await assert.rejects(agents.artifactAction(action), /artifact changed/);
  assert.equal(launches, 1, 'removing a receipt during verification cannot launch it');
});

test('artifact downloads validate saved receipts and idle workspaces before and after preparing bytes', async t => {
  const { agents, primary, workspace } = await setup(t);
  const source = primary.create();
  await start(primary, source);
  source.tasks = [{ id: 'tracked-export', state: 'working' }]; source.submission.taskId = 'tracked-export';
  fs.writeFileSync(path.join(workspace, 'result.txt'), 'portable result');
  const published = await primary.bridgeTool(source.id, 'agent_artifact', { artifactId: 'export', path: 'result.txt' });
  const action = { action: 'download', sessionId: source.id, receiptId: published.receiptId, artifactId: 'export', expectedVersion: 1 };
  await assert.rejects(agents.artifactDownload(action), /active work to finish/);
  source.tasks[0].state = 'not-checked'; complete(primary, source);
  await until(() => !primary.busy);
  await assert.rejects(agents.artifactDownload({ ...action, path: '../other' }), /saved artifact action/);
  await assert.rejects(agents.artifactDownload({ ...action, expectedVersion: 2 }), /artifact changed/);
  const lease = await agents.artifactDownload(action), chunks = [];
  for await (const chunk of lease.stream()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), 'portable result');
  assert.equal(agents.snapshot().downloads.active, 1);
  await lease.close();
  const prepare = agents.downloads.prepare.bind(agents.downloads);
  const receipt = source.items.find(item => item.id === action.receiptId);
  t.mock.method(agents.downloads, 'prepare', async (...args) => {
    const snapshot = await prepare(...args);
    receipt.artifact = { ...receipt.artifact };
    return snapshot;
  });
  await assert.rejects(agents.artifactDownload(action), /artifact changed/);
  assert.equal(agents.downloads.busy, false, 'even an identical replacement invalidates the in-flight receipt');
  t.mock.method(agents.downloads, 'prepare', async (...args) => {
    const snapshot = await prepare(...args);
    primary.loading.set(source.id, Promise.resolve());
    return snapshot;
  });
  try { await assert.rejects(agents.artifactDownload(action), /active work to finish/); }
  finally { primary.loading.delete(source.id); }
  assert.equal(agents.downloads.busy, false);
});

test('a real budget timer pauses its helper tree, preserves foreground chat, and resumes within the same allowance', async t => {
  const { agents, primary, add, addWorker } = await setup(t);
  const source = primary.create(); await start(primary, source);
  const publicBot = await add('Builder'), builder = agents.execution(publicBot.agentId);
  await agents.initializeController(builder);
  const helper = await addWorker('Helper'), other = await addWorker('Other');
  const accepted = agents.delegate(primary, source, builder.agentId, 'Build the original output.');
  const work = builder.session(accepted.sessionId);
  await until(() => builder.activeTurns.has(work.id));
  work.items.push({ id: 'retained-budget-evidence', type: 'agentMessage', text: 'Earlier work must remain visible.' });
  const child = agents.delegate(builder, work, helper.agentId, 'Help with the original output.');
  const help = helper.session(child.sessionId);
  await until(() => helper.activeTurns.has(help.id));
  const unrelated = agents.delegate(primary, source, other.agentId, 'Independent output.');
  const independent = other.session(unrelated.sessionId);
  const budget = agents.budgets.forJob(work.delegation);
  budget.limitMs = 60; agents.primary.save(); agents.pump();
  await until(() => budget.state === 'paused' && !builder.busy && !helper.busy && !agents.budgets.operations.size);
  assert.equal(work.delegation.delivered, false);
  assert.equal(work.delegation.cancelled, undefined);
  assert.equal(help.delegation.budgetId, budget.id);
  assert.equal(source.items.some(item => item.deliveryId === accepted.jobId), false, 'a budget hold is not a completed result');
  await until(() => other.activeTurns.has(independent.id));
  assert.equal(agents.budgets.held(independent.delegation), false);
  const chat = agents.conversation(publicBot, true);
  await start(publicBot, chat);
  assert.equal(publicBot.activeTurns.has(chat.id), true, 'the separate foreground conversation stays available');
  complete(publicBot, chat, 'I can answer while the job is paused.');
  const used = budget.usedMs;
  agents.budgets.update({ jobId: accepted.jobId, expectedVersion: budget.version, limitMinutes: 1, resume: true });
  await until(() => builder.activeTurns.has(work.id));
  assert.equal(budget.usedMs, used, 'Resume retains consumed time');
  assert.equal(work.delegation.budgetResumes, 1);
  assert.equal(work.items.some(item => item.id === 'retained-budget-evidence'), true);
  assert.equal(work.delegation.historyStartIndex, 0);
  assert.match(agents.executionText(work.delegation), /Inspect the current files and earlier evidence/);
  await agents.stop(accepted.jobId);
  await until(() => work.delegation.delivered && help.delegation.delivered);
  assert.equal(other.activeTurns.has(independent.id), true);
  complete(other, independent); complete(primary, source);
});

test('native worker usage retains a provider estimate and never turns a partial token report into zero', async t => {
  const { agents, primary, addWorker } = await setup(t);
  primary.data.settings.claudeEnabled = true;
  primary.claude.status = { installed: true, loggedIn: true };
  primary.claude.models = [{ id: 'claude-cli:sonnet', model: 'sonnet', label: 'Sonnet fixture', provider: 'claude-cli',
    effort: null, rank: 35, worker: true, router: true, images: true }];
  const worker = await addWorker('Metered builder');
  agents.profile(worker.agentId).mode = 'claude-cli:sonnet';
  worker.data.settings.mode = 'claude-cli:sonnet';
  worker.claude.status = { installed: true, loggedIn: true };
  worker.claude.models = primary.claude.models;
  let runs = 0, incomplete = false;
  worker.claude.run = async () => {
    runs++;
    return { result: 'Fixture output; no build or runtime check was performed.',
      usage: incomplete ? { input_tokens: 10 } : { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 2 },
      ...(!incomplete ? { total_cost_usd: 0.0012 } : {}) };
  };
  const source = primary.create(); source.queuePaused = true;
  const first = agents.delegate(primary, source, worker.agentId, 'Produce a fixture output.');
  const work = worker.session(first.sessionId);
  await until(() => work.delegation.delivered);
  assert.equal(work.status, 'completed', work.error);
  assert.equal(runs, 1);
  const usage = agents.budgets.snapshot()[work.delegation.budgetId].usage;
  assert.equal(usage.reportedTokens, 17);
  assert.equal(usage.providerEstimateUsd, 0.0012);
  assert.equal(usage.tokensComplete, true);
  assert.equal(usage.costComplete, true);
  const receipt = source.items.find(item => item.deliveryId === first.jobId);
  assert.equal(receipt.budgetSummary.providerEstimateUsd, 0.0012);
  assert.equal(receipt.budgetSummary.reportedTokens, 17);
  assert.match(source.queue[0]?.text || receipt.pendingReply?.text, /provider estimates, not invoices/);
  const { conversationMarkdown } = require('../src/conversation-export.cjs');
  assert.match(conversationMarkdown(source), /later review is excluded/);
  assert.match(conversationMarkdown(source), /0\.0012/);
  incomplete = true; worker.connection = 'disconnected';
  const second = agents.delegate(primary, source, worker.agentId, 'Produce another fixture output.');
  const budget = agents.budgets.forJob(work.delegation);
  agents.budgets.update({ jobId: second.jobId, expectedVersion: budget.version,
    limitMinutes: 120, limitTokens: 100, resume: false });
  worker.connection = 'ready'; agents.pump();
  await until(() => budget.state === 'paused' && !worker.busy && !agents.budgets.operations.size);
  assert.equal(work.delegation.delivered, false, 'missing usage holds the unfinished assignment rather than retrying it');
  assert.equal(agents.budgets.snapshot()[budget.id].usage.reportedTokens, null);
  assert.equal(agents.budgets.snapshot()[budget.id].usage.providerEstimateUsd, null);
  assert.equal(runs, 2);
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 0, 'a metering failure cannot switch to another billing route');
  await agents.stop(second.jobId);
});

test('Codex live usage stops at a reported limit without double-counting cached input or later reports', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Token builder'), source = primary.create(); source.queuePaused = true;
  worker.connection = 'disconnected';
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build within the reported limit.');
  const work = worker.session(accepted.sessionId), budget = agents.budgets.forJob(work.delegation);
  agents.budgets.update({ jobId: accepted.jobId, expectedVersion: budget.version, limitMinutes: 120, limitTokens: 100, resume: false });
  worker.connection = 'ready'; agents.pump();
  await until(() => worker.activeTurns.has(work.id));
  const report = { method: 'thread/tokenUsage/updated', params: { threadId: work.threadId, turnId: work.turnId,
    tokenUsage: { total: { inputTokens: 90, cachedInputTokens: 30, outputTokens: 10 },
      last: { inputTokens: 90, cachedInputTokens: 30, outputTokens: 10 } } } };
  worker.notification(report); worker.notification(report);
  await until(() => budget.state === 'paused' && !worker.busy && !agents.budgets.operations.size);
  const usage = agents.budgets.snapshot()[budget.id].usage;
  assert.equal(usage.reportedTokens, 100);
  assert.equal(usage.attempts, 1);
  assert.equal(usage.tokensComplete, false, 'interrupted usage stays a known lower bound');
  assert.equal(usage.providerEstimateUsd, null);
  assert.equal(work.delegation.delivered, false);
  await agents.stop(accepted.jobId);
});

test('a bot answers foreground chat while its separate assignment remains active', async t => {
  const { agents, primary, add } = await setup(t);
  const bot = await add('Builder'), chat = agents.conversation(bot, true), owner = primary.create();
  const accepted = agents.delegate(primary, owner, bot.agentId, 'Build the requested game');
  const execution = agents.owner(accepted.sessionId), work = execution.session(accepted.sessionId);
  await until(() => execution.activeTurns.has(work.id));
  assert.notEqual(execution, bot);
  assert.equal(agents.conversation(bot).id, chat.id);
  assert.equal(bot.busy, null);
  await bot.send({ id: chat.id, text: 'Are apples red?', mode: 'terra-light', task: 'off' });
  assert.ok(bot.activeTurns.has(chat.id));
  assert.ok(execution.activeTurns.has(work.id));
  assert.equal(agents.backgroundSlots.size, 1, 'the direct question uses no background slot');
  const snapshot = agents.snapshot();
  assert.equal(snapshot.agentStates[bot.agentId].conversationId, chat.id);
  assert.equal(snapshot.executionStates[bot.agentId].conversationId, work.id);
  await agents.stop(chat.id);
  assert.ok(execution.activeTurns.has(work.id), 'stopping chat does not stop an externally owned assignment');
  await until(() => !bot.busy);
  await agents.stop(accepted.jobId);
  await until(() => !execution.busy);
  assert.equal(owner.items.find(item => item.deliveryId === accepted.jobId).status, 'cancelled');
});

test('reported quota pauses accepted work without consuming an attempt, while chat and threshold changes remain available', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), bot = agents.controller(worker.agentId);
  const source = primary.create(), chat = agents.conversation(bot, true);
  primary.codexUsage({ secondary: { usedPercent: 92, resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
  primary.runnerRecoverySafe = true;
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build the game');
  const work = worker.session(accepted.sessionId);
  assert.equal(work.delegation.state, 'queued');
  assert.equal(work.delegation.executionAttempts, 0);
  assert.match(work.delegation.quotaPause.reason, /92%.*90%/);
  const listed = agents.tool(primary, source, 'agents_list', {}).find(bot => bot.id === 'main').ownedJobs;
  assert.equal(listed[0].state, 'paused');
  assert.match(listed[0].error, /92%.*90%/);
  assert.equal(worker.client.calls.some(call => call.method === 'turn/start'), false);
  await bot.send({ id: chat.id, text: 'A direct question', mode: 'terra-light', task: 'off' });
  assert.ok(bot.activeTurns.has(chat.id));
  assert.equal(agents.backgroundSlots.size, 0);
  for (const value of [0, 101, 1.5, '95', NaN]) {
    assert.throws(() => agents.settings({ backgroundUsageLimit: value }), /whole percentage/);
  }
  agents.settings({ backgroundUsageLimit: 95 });
  await until(() => worker.activeTurns.has(work.id));
  assert.equal(work.delegation.quotaPause, undefined);
  assert.equal(work.delegation.executionAttempts, 1);
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('native Claude allowance admission holds workers before inference, preserves direct chat and resumes within the chosen threshold', async t => {
  const { agents, primary, add, addWorker } = await setup(t);
  primary.data.settings.claudeEnabled = true;
  primary.claude.status = { installed: true, loggedIn: true, authMethod: 'claude.ai', email: 'fixture@invalid', subscriptionType: 'max' };
  primary.claude.authVerified = true;
  primary.claude.models = [{ id: 'claude-cli:sonnet', model: 'sonnet', label: 'Sonnet fixture', provider: 'claude-cli',
    effort: null, rank: 35, worker: true, router: true, images: true }];
  let lookups = 0, runs = 0, percent = 92;
  primary.claude.readUsage = async () => {
    lookups++;
    return { rate_limits_available: true, rate_limits: {
      seven_day: { utilization: percent, resets_at: new Date(Date.now() + 3600000).toISOString() },
    } };
  };
  const worker = await addWorker('Native quota builder');
  agents.profile(worker.agentId).mode = worker.data.settings.mode = 'claude-cli:sonnet';
  worker.claude.status = { ...primary.claude.status }; worker.claude.models = primary.claude.models;
  worker.claude.run = async () => { runs++; return { result: 'Fixture output; no game verification performed.' }; };
  const source = primary.create(); source.queuePaused = true;
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build within the native allowance.');
  const work = worker.session(accepted.sessionId);
  await until(() => !!work.quotaWaiting);
  assert.equal(runs, 0);
  assert.equal(agents.budgets.snapshot()[work.delegation.budgetId].usage.attempts, 0);
  assert.match(work.quotaWaiting.reason, /Claude Code.*92%/);
  assert.equal(lookups, 1);
  assert.equal(primary.limits.backgroundGuard('claude-cli', 90, 'sonnet', primary.claude.accountKey()).usedPercent, 92);
  assert.equal(JSON.parse(fs.readFileSync(primary.filename, 'utf8')).providerQuotas['claude-cli'].seven_day.usedPercent, 92);
  const bot = await add('Direct chat');
  const chat = agents.conversation(bot, true, primary.data.settings.workspace);
  await bot.send({ id: chat.id, text: 'A direct question', mode: 'terra-light', task: 'off' });
  assert.ok(bot.activeTurns.has(chat.id));
  assert.equal(lookups, 1, 'direct chat never waits for a native allowance lookup');
  agents.settings({ backgroundUsageLimit: 95 });
  await until(() => work.delegation.delivered);
  assert.equal(runs, 1);
  assert.equal(lookups, 1, 'same-account admissions share the recent metadata report');
  agents.settings({ backgroundUsageLimit: 90 });
  worker.claude.onUsageChange();
  const next = agents.delegate(primary, source, worker.agentId, 'Continue after a later allowance refresh.');
  const nextWork = worker.session(next.sessionId);
  await until(() => !!nextWork.quotaWaiting || !!nextWork.delegation.quotaPause);
  percent = 20;
  agents.quotaWake({ provider: 'claude-cli', until: Date.now() + 25 });
  await until(() => nextWork.delegation.delivered);
  assert.equal(runs, 2);
  assert.equal(lookups, 3, 'a held native job refreshes metadata without spending model attempts while waiting');
});

test('native Claude quota lookups coalesce, invalidate on native usage and reject late replies after cancellation or account changes', async t => {
  const { agents, primary, addWorker } = await setup(t);
  primary.data.settings.claudeEnabled = true;
  primary.claude.status = { installed: true, loggedIn: true, authMethod: 'claude.ai', email: 'fixture@invalid', subscriptionType: 'max' };
  primary.claude.authVerified = true;
  const worker = await addWorker('Native admission');
  const session = agents.conversation(worker, true, primary.data.settings.workspace);
  session.agentReplyActive = true;
  let release, lookups = 0;
  primary.claude.readUsage = () => { lookups++; return new Promise(resolve => { release = resolve; }); };
  const report = { rate_limits_available: true, rate_limits: { seven_day: { utilization: 93, resets_at: null } } };
  const first = agents.refreshClaudeQuota(), second = agents.refreshClaudeQuota();
  assert.equal(first, second);
  release(report); await first;
  assert.equal(lookups, 1);
  worker.claude.onUsageChange();
  const third = agents.refreshClaudeQuota();
  assert.equal(lookups, 2);
  const originalAccount = primary.claude.accountKey();
  primary.claude.status.email = 'different-fixture@invalid';
  release(report); await third;
  assert.equal(primary.limits.backgroundGuard('claude-cli', 90, 'sonnet', primary.claude.accountKey()), null);
  assert.equal(primary.limits.backgroundGuard('claude-cli', 90, 'sonnet', originalAccount).usedPercent, 93);
  const stopped = agents.acquire(worker, session, { provider: 'claude-cli', model: 'sonnet' });
  assert.equal(lookups, 3);
  primary.claude.status.email = 'another-fixture@invalid';
  release(report);
  assert.match((await stopped).blocked, /sign-in changed/);
  const cancelled = agents.acquire(worker, session, { provider: 'claude-cli', model: 'sonnet' });
  assert.equal(lookups, 4);
  worker.stopping.add(session.id);
  release({ rate_limits_available: false });
  assert.deepEqual(await cancelled, { stopped: true });
  assert.equal(worker.client.calls.some(call => call.method === 'turn/start'), false);
});

test('a quota update during preparation holds the provider submission and Stop cancels its wait', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create();
  let release, preparing = false;
  const ready = worker.readyToStart.bind(worker);
  worker.readyToStart = session => {
    if (preparing) return ready(session);
    preparing = true;
    return new Promise(resolve => { release = resolve; });
  };
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build the game');
  const work = worker.session(accepted.sessionId);
  await until(() => preparing);
  primary.codexUsage({ primary: { usedPercent: 95, resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
  primary.changed();
  release(null);
  await until(() => !!work.quotaWaiting && agents.backgroundSlots.size === 0);
  assert.equal(worker.client.calls.some(call => call.method === 'turn/start'), false);
  assert.equal(agents.backgroundSlots.size, 0);
  await agents.stop(accepted.jobId);
  await until(() => !worker.busy);
  assert.equal(agents.capacityWaits.size, 0);
  assert.equal(worker.client.calls.some(call => call.method === 'turn/start'), false);
  assert.equal(work.delegation.cancelled, true);
});

test('an exhausted provider keeps background work for review rather than failing over to another account', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create();
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build the game');
  const work = worker.session(accepted.sessionId);
  await until(() => !!work.turnId);
  worker.lastSends.set(work.id, { clientId: work.submission.messageId, text: 'Build the game', images: [], task: 'on' });
  worker.notification({ method: 'turn/completed', params: { threadId: work.threadId, turn: {
    id: work.turnId, status: 'failed', error: { message: 'Usage exhausted.', codexErrorInfo: 'usageLimitExceeded' },
  } } });
  await until(() => !worker.busy);
  assert.equal(work.delegation.state, 'interrupted');
  assert.equal(work.delegation.delivered, false);
  assert.equal(work.queuePaused, true);
  assert.match(work.delegation.error, /paused for review/);
  assert.equal(work.queue?.some(message => message.failover) || false, false);
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(source.items.some(item => item.type === 'agentResult'), false);
});

test('queued quota holds survive restart and Stop without submitting a provider turn', async t => {
  const { agents, primary, addWorker, factory, workspace } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create();
  primary.runnerRecoverySafe = true;
  primary.codexUsage({ secondary: { usedPercent: 91, resetsAt: Math.floor(Date.now() / 1000) + 3600 } });
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build the game');
  primary.save(); worker.save();
  const root = factory(primary.filename, workspace);
  root.runnerRecoverySafe = true;
  await root.initialize();
  const restored = new Agents(root, async () => {}, factory);
  t.after(() => { restored.closing = true; clearTimeout(restored.quotaTimer); for (const c of restored.allControllers()) c.close(); });
  await restored.initialize();
  const execution = restored.owner(accepted.sessionId), work = execution.session(accepted.sessionId);
  assert.equal(work.delegation.state, 'queued');
  assert.equal(work.delegation.executionAttempts, 0);
  assert.equal(work.delegation.quotaPause.usedPercent, 91);
  await restored.stop(accepted.jobId);
  assert.equal(work.delegation.cancelled, true);
  assert.equal(work.delegation.delivered, true);
  assert.equal(execution.client.calls.some(call => call.method === 'turn/start'), false);
});

test('a background routing limit does not spend another provider account', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create();
  agents.profile(worker.agentId).mode = 'auto';
  agents.sync(worker);
  let calls = 0;
  worker.smartRouter.choose = async () => {
    calls++;
    throw Object.assign(new Error('Router allowance exhausted.'), {
      limitProvider: 'codex', limit: { until: null, reason: 'Router allowance exhausted.' },
    });
  };
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build the game');
  const work = worker.session(accepted.sessionId);
  await until(() => !worker.busy && work.delegation.state === 'interrupted');
  assert.equal(calls, 1);
  assert.equal(work.delegation.delivered, false);
  assert.match(work.delegation.error, /paused for review/);
  assert.equal(worker.client.calls.some(call => call.method === 'turn/start'), false);
});

test('Auto waits on a known allowance limit before routing and resumes after the limit clears', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create();
  agents.profile(worker.agentId).mode = 'auto';
  agents.sync(worker);
  let calls = 0;
  worker.smartRouter.choose = async () => {
    calls++;
    return { ...worker.resolveWorker('terra-light'), source: 'model' };
  };
  primary.limits.mark('codex', { until: Date.now() + 60000 });
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build the game');
  const work = worker.session(accepted.sessionId);
  assert.match(work.delegation.quotaPause.reason, /usage limit/);
  assert.equal(calls, 0);
  primary.limits.clear('codex'); primary.changed();
  await until(() => worker.activeTurns.has(work.id));
  assert.equal(calls, 1);
  assert.equal(work.delegation.quotaPause, undefined);
});

test('a reported reset wakes a queued quota hold without a UI action', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create();
  primary.codexUsage({ secondary: { usedPercent: 95, resetsAt: (Date.now() + 400) / 1000 } });
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build the game');
  const work = worker.session(accepted.sessionId);
  assert.ok(work.delegation.quotaPause);
  assert.equal(worker.client.calls.some(call => call.method === 'turn/start'), false);
  await until(() => worker.activeTurns.has(work.id));
  assert.equal(work.delegation.quotaPause, undefined);
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('a quota hold without a reported reset is rechecked instead of waiting forever', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const { UNKNOWN_RESET_MS } = require('../src/providers/limits.cjs');
  const worker = await addWorker('Builder'), source = primary.create();
  primary.codexUsage({ secondary: { usedPercent: 95 } });
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build the game');
  const work = worker.session(accepted.sessionId);
  assert.ok(work.delegation.quotaPause);
  assert.ok(agents.quotaWakeAt > Date.now() + UNKNOWN_RESET_MS - 60000, 'a recheck is scheduled');
  const call = primary.client.call.bind(primary.client);
  primary.client.call = async (method, params) => method === 'account/rateLimits/read'
    ? (call(method, params), { rateLimits: { secondary: { usedPercent: 20 } } }) : call(method, params);
  clearTimeout(agents.quotaTimer);
  agents.quotaWoke();
  await until(() => worker.activeTurns.has(work.id));
  assert.equal(work.delegation.quotaPause, undefined);
  assert.ok(primary.client.calls.some(entry => entry.method === 'account/rateLimits/read'));
});

test('execution contexts survive restart without becoming additional sidebar bots', async t => {
  const { agents, primary, add, factory, workspace } = await setup(t);
  const bot = await add('Builder'), owner = primary.create();
  const accepted = agents.delegate(primary, owner, bot.agentId, 'Inspect the project');
  const execution = agents.owner(accepted.sessionId);
  await agents.initializing.get(execution);
  execution.save(); primary.save();
  const root = factory(primary.filename, workspace), restored = new Agents(root, async () => {}, factory);
  t.after(() => { restored.closing = true; for (const c of restored.allControllers()) c.close(); });
  assert.equal(root.data.agents.length, 1);
  assert.equal(restored.controllers.size, 2);
  assert.equal(restored.executions.size, 1);
  assert.equal(restored.owner(accepted.sessionId).executionContext, true);
  assert.equal(restored.snapshot().agents.length, 2);
  assert.equal(restored.owner(accepted.sessionId).session(accepted.sessionId).delegation.delivered, false);
});

test('failed execution registration retries an empty store but never rewrites unregistered history', async t => {
  const { agents, primary, add, directory } = await setup(t);
  const bot = await add('Builder'), saved = primary.save.bind(primary);
  primary.save = () => { throw new Error('Registry save failure'); };
  assert.throws(() => agents.execution(bot.agentId), /Registry save failure/);
  assert.equal(agents.executions.has(bot.agentId), false);
  primary.save = saved;
  const execution = agents.execution(bot.agentId);
  await agents.initializeController(execution);
  assert.deepEqual(primary.data.workerContexts, [bot.agentId]);
  const other = await add('Reviewer');
  const file = path.join(directory, 'workers', other.agentId, 'sessions.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const original = JSON.stringify({ sessions: [{ id: randomUUID(), items: [{ text: 'Retained original evidence.' }] }] });
  fs.writeFileSync(file, original);
  assert.throws(() => agents.execution(other.agentId), /unregistered.*retained for review/);
  assert.equal(fs.readFileSync(file, 'utf8'), original);
  assert.equal(agents.executions.has(other.agentId), false);
  assert.deepEqual(primary.data.workerContexts, [bot.agentId]);
});

test('a background reply waits in the public inbox without occupying foreground chat capacity', async t => {
  const { agents, primary, add, addWorker } = await setup(t);
  const builder = await addWorker('Builder'), other = await addWorker('Other'), reviewer = await add('Reviewer');
  const source = primary.create(), owner = agents.conversation(reviewer, true);
  await start(primary, source);
  const accepted = agents.delegate(primary, source, builder.agentId, 'Build the artifact');
  agents.delegate(primary, source, other.agentId, 'Independent inspection');
  await until(() => builder.activeTurns.size && other.activeTurns.size);
  agents.tool(primary, source, 'agent_transfer_owner', {
    jobId: accepted.jobId, agentId: reviewer.agentId, expectedOwnerVersion: 1, handoffId: 'public-review',
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reviewer.busy, null);
  assert.ok(owner.queue.some(message => message.agentMail?.handoff));
  await reviewer.send({ id: owner.id, text: 'A quick question', mode: 'terra-light', task: 'off' });
  assert.ok(reviewer.activeTurns.has(owner.id));
  assert.equal(agents.backgroundSlots.size, 2);
  complete(reviewer, owner, 'A quick answer.');
  await until(() => !reviewer.busy);
  assert.equal(reviewer.client.calls.filter(call => call.method === 'turn/start').length, 1);
  complete(builder, builder.session(accepted.sessionId), 'Built artifact.');
  await until(() => reviewer.activeTurns.has(owner.id));
  assert.ok(owner.items.some(item => item.type === 'agentResult' && item.deliveryId === accepted.jobId));
  assert.equal(other.activeTurns.size, 1);
});

test('job details updates stay within the selected background assignment and deduplicate retries', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create();
  worker.connection = 'disconnected';
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build the game');
  const args = { jobId: accepted.jobId, expectedRevision: 1, amendmentId: 'details-update', text: 'Use keyboard controls.' };
  const result = agents.reviseUserJob(args);
  assert.equal(result.status, 'received');
  assert.equal(worker.session(accepted.sessionId).delegation.revision, 2);
  assert.equal(agents.reviseUserJob(args).duplicate, true);
  assert.equal(worker.session(accepted.sessionId).queue?.length || 0, 0);
  assert.equal(worker.session(accepted.sessionId).items.filter(item => item.amendment).length, 1);
  assert.throws(() => agents.reviseUserJob({ ...args, amendmentId: 'stale', text: 'Use a mouse instead.' }), /changed/);
  assert.equal(worker.session(accepted.sessionId).queue?.length || 0, 0);
  assert.equal(agents.controller(worker.agentId).busy, null);
});

test('queued assignment changes persist once and become Applied only when the provider accepts them', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const chat = agents.conversation(worker, true);
  await start(worker, chat);
  const originalTurn = chat.turnId;
  primary.isCoordinator = () => true;
  const original = { id: 'original-user-request', text: 'Build the requested game.' };
  const accepted = agents.delegate(primary, source, worker.agentId, 'Preserve the requested scope.', [], original);
  primary.isCoordinator = () => false;
  const args = { jobId: accepted.jobId, expectedRevision: 1, amendmentId: 'blue-theme', text: 'Use a blue background.' };
  assert.equal(agents.tool(primary, source, 'agent_revise', args).status, 'received');
  const job = chat.delegationQueue[0];
  assert.equal(job.amendments[0].state, 'received');
  assert.equal(agents.tool(primary, source, 'agent_revise', args).duplicate, true);
  assert.throws(() => agents.tool(primary, source, 'agent_revise', { ...args, text: 'Different content.' }), /different change/);
  assert.throws(() => agents.tool(primary, source, 'agent_revise', { ...args, amendmentId: 'stale' }), /Refresh its revision/);
  assert.equal(chat.turnId, originalTurn);
  assert.equal(JSON.parse(fs.readFileSync(worker.filename)).sessions[0].delegationQueue[0].revision, 2);
  complete(worker, chat, 'Unrelated foreground task finished.');
  await until(() => chat.delegation?.id === accepted.jobId && chat.turnId && chat.turnId !== originalTurn);
  assert.equal(chat.delegation.amendments[0].state, 'applied');
  assert.equal(chat.delegation.originalRequest.text, original.text);
  assert.match(worker.client.calls.filter(call => call.method === 'turn/start').at(-1).params.input[0].text, /Use a blue background/);
  source.queuePaused = true;
  complete(worker, chat, 'Built the blue game.');
  await until(() => chat.delegation.delivered);
  assert.match(source.queue.find(message => message.agentResult).agentResult.request.text, /Build the requested game[\s\S]*Use a blue background/);
  assert.equal(source.items.find(item => item.type === 'agentResult').amendments[0].state, 'applied');
});

test('native steering acknowledges a revision without restarting the worker', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build the requested game.');
  const chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  const call = worker.client.call.bind(worker.client);
  let acknowledge;
  worker.client.call = (method, params) => method === 'turn/steer' ? new Promise(resolve => { acknowledge = resolve; }) : call(method, params);
  const args = { jobId: accepted.jobId, expectedRevision: 1, amendmentId: 'jump-change', text: 'Make jumps higher.' };
  assert.equal(agents.tool(primary, source, 'agent_revise', args).status, 'received');
  assert.equal(chat.delegation.amendments[0].state, 'received');
  assert.throws(() => agents.tool(worker, chat, 'agent_delegate', { agentId: 'main', task: 'Start old-scope work.' }), /accepted assignment change/);
  acknowledge({});
  await until(() => chat.delegation.amendments[0].state === 'applied');
  assert.equal(chat.delegation.state, 'running');
  assert.equal(chat.submission.assignmentRevision, 2);
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(agents.tool(primary, source, 'agent_revise', args).status, 'applied');
});

test('an uncertain steering acknowledgement leaves the change Received and blocks automatic replacement', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build once.');
  const chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  const call = worker.client.call.bind(worker.client);
  worker.client.call = (method, params) => method === 'turn/steer' ? Promise.reject(new Error('Steering acknowledgement timed out')) : call(method, params);
  agents.tool(primary, source, 'agent_revise', { jobId: accepted.jobId, expectedRevision: 1, amendmentId: 'uncertain-change', text: 'Use blue.' });
  await until(() => chat.delegation.state === 'revision-blocked');
  assert.equal(chat.delegation.amendments[0].state, 'received');
  assert.match(chat.delegation.revisionError, /timed out/);
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 1);
  source.queuePaused = true;
  await agents.stop(accepted.jobId);
  await until(() => chat.delegation.delivered);
  assert.equal(chat.delegation.cancelled, true);
});

test('replacement waits for the old turn to stop and preserves its evidence outside the revised report', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build the requested game.');
  const chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  chat.activeProvider = 'native:deepseek';
  const call = worker.client.call.bind(worker.client), oldTurn = chat.turnId;
  worker.client.call = (method, params) => method === 'turn/interrupt' ? Promise.resolve({}) : call(method, params);
  agents.tool(primary, source, 'agent_revise', { jobId: accepted.jobId, expectedRevision: 1, amendmentId: 'replacement', text: 'Use a blue background.' });
  await until(() => worker.stopping.has(chat.id));
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(chat.delegation.amendments[0].state, 'received');
  worker.notification({ method: 'item/completed', params: { threadId: chat.threadId, turnId: oldTurn, item: { id: 'old-evidence', type: 'agentMessage', phase: 'final_answer', text: 'Old incomplete red game.' } } });
  worker.notification({ method: 'turn/completed', params: { threadId: chat.threadId, turn: { id: oldTurn, status: 'interrupted' } } });
  await until(() => chat.turnId && chat.turnId !== oldTurn && worker.activeTurns.size);
  assert.equal(chat.delegation.amendments[0].state, 'applied');
  assert.ok(chat.items.some(item => item.id === 'old-evidence'));
  assert.equal(source.items.filter(item => item.type === 'agentResult').length, 0);
  source.queuePaused = true;
  complete(worker, chat, 'Revised blue game and verification evidence.');
  await until(() => chat.delegation.delivered);
  const report = source.items.find(item => item.type === 'agentResult');
  assert.match(report.text, /Revised blue game/);
  assert.doesNotMatch(report.text, /Old incomplete red game/);
  assert.equal(report.revision, 2);
});

test('revision replacement cancels old helpers and their late reports cannot restart the parent', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), helper = await addWorker('Helper'), source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build with help.');
  const chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  agents.delegate(worker, chat, helper.agentId, 'Old revision helper task.');
  const child = agents.conversation(helper);
  await until(() => helper.activeTurns.size);
  const oldTurn = chat.turnId;
  agents.tool(primary, source, 'agent_revise', { jobId: accepted.jobId, expectedRevision: 1, amendmentId: 'replace-subtree', text: 'Change the game layout.' });
  await until(() => child.delegation.delivered && chat.turnId && chat.turnId !== oldTurn);
  assert.equal(child.delegation.cancelled, true);
  const receipt = chat.items.find(item => item.type === 'agentResult');
  assert.equal(receipt.superseded, true);
  assert.equal(receipt.pendingReply, undefined);
  assert.equal(chat.queue?.filter(message => message.agentReply).length || 0, 0);
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 2);
});

test('assignment revisions enforce ownership and roll back an unacknowledged save', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), other = await addWorker('Other'), source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build once.');
  const chat = agents.conversation(worker), stranger = agents.conversation(other, true);
  await until(() => worker.activeTurns.size);
  await start(other, stranger);
  const args = { jobId: accepted.jobId, expectedRevision: 1, amendmentId: 'validated-change', text: 'Use blue.' };
  assert.throws(() => agents.tool(other, stranger, 'agent_revise', args), /Only the owner/);
  assert.throws(() => agents.tool(primary, source, 'agent_revise', { ...args, access: 'danger-full-access' }), /Invalid agent tool/);
  for (const invalid of [{ expectedRevision: 0 }, { expectedRevision: '1' }, { amendmentId: '../bad' }, { text: '' }, { text: 'x'.repeat(8001) }]) {
    assert.throws(() => agents.tool(primary, source, 'agent_revise', { ...args, ...invalid }), /stable amendmentId/);
  }
  const save = worker.save.bind(worker);
  worker.save = () => { if (chat.delegation.revision === 2) throw new Error('Revision disk failure'); return save(); };
  assert.throws(() => agents.tool(primary, source, 'agent_revise', args), /Revision disk failure/);
  worker.save = save;
  assert.equal(chat.delegation.revision, 1);
  assert.equal(chat.delegation.amendments, undefined);
  assert.equal(chat.delegation.state, 'running');
  assert.equal(agents.revisionOperations.size, 0);
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/steer').length, 0);
});

test('Stop during revision replacement cannot restart the cancelled job', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build once.');
  const chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  chat.activeProvider = 'native:deepseek';
  const call = worker.client.call.bind(worker.client), oldTurn = chat.turnId;
  worker.client.call = (method, params) => method === 'turn/interrupt' ? Promise.resolve({}) : call(method, params);
  agents.tool(primary, source, 'agent_revise', { jobId: accepted.jobId, expectedRevision: 1, amendmentId: 'stop-race', text: 'Use blue.' });
  await until(() => worker.stopping.has(chat.id));
  source.queuePaused = true;
  await agents.stop(accepted.jobId);
  worker.notification({ method: 'turn/completed', params: { threadId: chat.threadId, turn: { id: oldTurn, status: 'interrupted' } } });
  await until(() => chat.delegation.delivered);
  agents.pump();
  assert.equal(chat.delegation.cancelled, true);
  assert.equal(chat.delegation.amendments[0].state, 'received');
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('a replacement rejected before provider acceptance never claims its change was Applied', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build once.');
  const chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  chat.activeProvider = 'native:deepseek';
  const call = worker.client.call.bind(worker.client);
  worker.client.call = (method, params) => method === 'turn/start' ? Promise.reject(new Error('Provider refused replacement')) : call(method, params);
  source.queuePaused = true;
  agents.tool(primary, source, 'agent_revise', { jobId: accepted.jobId, expectedRevision: 1, amendmentId: 'rejected-change', text: 'Use blue.' });
  await until(() => chat.delegation.delivered);
  assert.equal(chat.delegation.amendments[0].state, 'received');
  const report = source.items.find(item => item.type === 'agentResult');
  assert.equal(report.status, 'failed');
  assert.match(report.error, /Provider refused replacement/);
  assert.equal(report.amendments[0].state, 'received');
});

test('revision changes invalidate earlier approvals and reject stale helper actions', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build once.');
  const chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  const request = { id: 'earlier-approval', method: 'item/commandExecution/requestApproval',
    params: { threadId: chat.threadId, turnId: chat.turnId, command: 'old-proposed-command' } };
  worker.serverRequest(request);
  assert.equal(worker.requests.get(request.id).assignment.revision, 1);
  const call = worker.client.call.bind(worker.client);
  worker.client.call = (method, params) => method === 'turn/interrupt' ? Promise.resolve({}) : call(method, params);
  agents.tool(primary, source, 'agent_revise', { jobId: accepted.jobId, expectedRevision: 1, amendmentId: 'invalidate-approval', text: 'Use blue.' });
  assert.throws(() => worker.answer(request.id, { decision: 'accept' }), /assignment changed/);
  assert.match(worker.client.responses.find(response => response.id === request.id).error, /earlier approval/);
  worker.serverRequest({ ...request, id: 'late-old-approval' });
  assert.equal(worker.requests.has('late-old-approval'), false);
  assert.match(worker.client.responses.find(response => response.id === 'late-old-approval').error, /no longer current/);
  await assert.rejects(worker.bridgeTool(chat.id, 'agent_create', { name: 'Stale child', instructions: '' }), /no active turn/);
  assert.equal(primary.data.agents.some(profile => profile.name === 'Stale child'), false);
});

test('Apply now consumes a direct queued correction atomically and retains its attached image', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  agents.delegate(primary, source, worker.agentId, 'Build the requested game.');
  const chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  const image = 'data:image/png;base64,aW1hZ2U=';
  await worker.send({ id: chat.id, text: 'Match this blue reference.', images: [image], mode: 'terra-light' });
  const message = chat.queue[0];
  assert.equal(message.assignmentRevision, 1);
  const save = worker.save.bind(worker);
  worker.save = () => { if (chat.delegation.revision === 2) throw new Error('Direct change disk failure'); return save(); };
  await assert.rejects(worker.queuedMessage(chat.id, message.id, 'steer'), /Direct change disk failure/);
  worker.save = save;
  assert.equal(chat.queue[0], message);
  assert.equal(chat.delegation.revision, 1);
  assert.equal(chat.delegation.images.length, 0);
  assert.equal(chat.items.filter(item => item.amendment).length, 0);
  const received = await worker.queuedMessage(chat.id, message.id, 'steer');
  assert.equal(received.status, 'received');
  await until(() => chat.delegation.amendments[0].state === 'applied');
  assert.equal(chat.queue.length, 0);
  assert.deepEqual(chat.delegation.images, [image]);
  assert.equal(chat.items.find(item => item.amendment).amendment.state, 'applied');
  assert.match(JSON.stringify(agents.readContext(source, { agentId: worker.agentId })), /Change applied, revision 2/);
  const steer = worker.client.calls.find(call => call.method === 'turn/steer');
  assert.deepEqual(steer.params.input.at(-1), { type: 'image', url: image });
  const saved = JSON.parse(fs.readFileSync(worker.filename)).sessions[0];
  assert.equal(saved.queue.length, 0);
  assert.equal(saved.delegation.revision, 2);
});

test('a direct queued correction cannot overwrite a newer accepted revision', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build the requested game.');
  const chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  await worker.send({ id: chat.id, text: 'Change the layout.', mode: 'terra-light' });
  const message = chat.queue[0];
  agents.tool(primary, source, 'agent_revise', { jobId: accepted.jobId, expectedRevision: 1, amendmentId: 'newer-owner-change', text: 'Use blue.' });
  await until(() => chat.delegation.amendments[0].state === 'applied');
  await assert.rejects(worker.queuedMessage(chat.id, message.id, 'steer'), /Refresh its revision/);
  assert.equal(chat.queue[0], message);
  assert.equal(chat.delegation.revision, 2);
  assert.equal(chat.delegation.amendments.length, 1);
});

test('unconfirmed cleanup holds a replacement without marking the change Applied', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build once.');
  const chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  chat.activeProvider = 'native:deepseek';
  worker.data.executionBlock = { processId: 'unconfirmed-fixture-check' };
  agents.tool(primary, source, 'agent_revise', { jobId: accepted.jobId, expectedRevision: 1, amendmentId: 'cleanup-wait', text: 'Use blue.' });
  await until(() => !worker.busy && !agents.revisionOperations.size);
  agents.pump();
  assert.equal(chat.delegation.state, 'revising');
  assert.equal(chat.delegation.amendments[0].state, 'received');
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 1);
  delete worker.data.executionBlock;
});

test('a cancelled-result continuation can summarize but cannot regain write access or create work', async t => {
  const { agents, add } = await setup(t);
  const worker = await add('Requester', undefined, 'danger-full-access'), chat = agents.conversation(worker, true);
  await worker.send({ id: chat.id, text: 'The requested helper was cancelled. Summarize the outcome.', mode: 'terra-light', task: 'off', agentReply: true, agentReplyCancelled: true });
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').at(-1).params.sandboxPolicy.type, 'readOnly');
  assert.equal(chat.access, 'danger-full-access', 'the user conversation access setting is retained');
  assert.throws(() => agents.tool(worker, chat, 'agent_create', { name: 'Unrequested replacement', instructions: '' }), /cancelled result/);
  assert.throws(() => agents.tool(worker, chat, 'agent_delegate', { agentId: 'main', task: 'Repeat cancelled work.' }), /cancelled result/);
  assert.ok(agents.tool(worker, chat, 'agents_list', {}).length);
  complete(worker, chat, 'Cancelled outcome recorded.');
  await until(() => !worker.busy);
  await worker.send({ id: chat.id, text: 'New user request.', mode: 'terra-light', task: 'off' });
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').at(-1).params.sandboxPolicy.type, 'dangerFullAccess');
});

test('ownership handoffs keep one worker running and deliver its result only to the accepted owner', async t => {
  const { agents, primary, workspace, add, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), next = await add('Reviewer');
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const owner = agents.conversation(next, true);
  await start(next, owner);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build the requested artifact.');
  const chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  const args = { jobId: accepted.jobId, agentId: next.agentId, handoffId: 'review-owner', expectedOwnerVersion: 1 };
  const result = agents.tool(primary, source, 'agent_transfer_owner', args);
  assert.equal(result.owner, owner.id);
  assert.equal(chat.delegation.source, source.id, 'original cancellation ancestry is retained');
  assert.equal(chat.delegation.owner, owner.id);
  assert.equal(agents.pendingDelegations(source.id), false);
  assert.equal(agents.pendingDelegations(owner.id), false);
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(agents.tool(primary, source, 'agent_transfer_owner', args).duplicate, true);
  assert.equal(chat.delegation.ownerChanges.length, 1);
  complete(worker, chat, 'Build and launch evidence.');
  await until(() => chat.delegation.delivered);
  assert.equal(owner.items.filter(item => item.type === 'agentResult').length, 1);
  assert.equal(source.items.filter(item => item.type === 'agentResult').length, 0);
  assert.match(owner.items.find(item => item.type === 'agentResult').text, /Build and launch evidence/);
  assert.equal(owner.queue.find(message => message.agentResult).agentResult.request.text, chat.delegation.task);
  chat.delegation.delivered = false; // Simulate receiver acknowledgement preceding the worker's final save.
  assert.throws(() => agents.tool(next, owner, 'agent_transfer_owner', {
    jobId: accepted.jobId, agentId: 'main', handoffId: 'after-result', expectedOwnerVersion: 2,
  }), /already received/);
  chat.delegation.delivered = true;
  assert.equal(next.busy, owner.id, 'unrelated foreground work is preserved');
});

test('a transferred job keeps both chats from deletion, and a lost owner chat holds it for review instead of blocking startup', async t => {
  const { agents, primary, workspace, factory, add, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), next = await add('Reviewer');
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const owner = agents.conversation(next, true);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build the requested artifact.');
  await until(() => worker.activeTurns.size);
  agents.tool(primary, source, 'agent_transfer_owner', { jobId: accepted.jobId, agentId: next.agentId, handoffId: 'review-owner', expectedOwnerVersion: 1 });
  complete(primary, source, 'Handed over.');
  await until(() => !primary.busy);

  assert.throws(() => primary.deleteSession(source.id), /outstanding work/);
  assert.throws(() => next.deleteSession(owner.id), /outstanding work/);

  // Saved data from before the delete guard: the new owner chat is gone.
  next.data.sessions = next.data.sessions.filter(session => session.id !== owner.id);
  next.save();
  primary.save();
  const restarted = factory(primary.filename, workspace);
  await restarted.initialize();
  let reopened;
  t.after(async () => {
    if (!reopened) {
      restarted.close();
      return;
    }

    reopened.closing = true;
    await reopened.downloads.close();
    for (const c of reopened.allControllers()) c.close();
  });

  assert.doesNotThrow(() => { reopened = new Agents(restarted, async () => {}, factory); });
  const job = reopened.pendingJobs().find(record => record.job.id === accepted.jobId).job;
  assert.equal(job.state, 'interrupted');
  assert.match(job.error, /Review/);
});

test('assignment Stop preserves an older transferred subtree after its worker conversation is reused', async t => {
  const { agents, primary, add, addWorker } = await setup(t);
  const source = primary.create();
  await start(primary, source);
  const builder = await addWorker('Builder'), helper = await addWorker('Helper'), reviewer = await add('Reviewer');
  const receiver = agents.conversation(reviewer, true); receiver.queuePaused = true;
  const first = agents.delegate(primary, source, builder.agentId, 'First independent assignment.');
  const work = builder.session(first.sessionId);
  await until(() => builder.activeTurns.has(work.id));
  const oldChild = agents.delegate(builder, work, helper.agentId, 'Continue the first assignment under a new result owner.');
  const child = helper.session(oldChild.sessionId);
  await until(() => helper.activeTurns.has(child.id));
  agents.tool(builder, work, 'agent_transfer_owner', { jobId: oldChild.jobId, agentId: reviewer.agentId,
    handoffId: 'retain-old-helper', expectedOwnerVersion: 1 });
  complete(builder, work, 'My part of the first assignment is finished.');
  await until(() => work.delegation.delivered && !builder.busy);
  const second = agents.delegate(primary, source, builder.agentId, 'Second independent assignment.');
  assert.equal(second.sessionId, first.sessionId);
  await until(() => builder.activeTurns.has(work.id));
  await agents.stop(second.jobId);
  await until(() => work.delegation.delivered);
  assert.equal(work.delegation.cancelled, true);
  assert.equal(child.delegation.cancelled, undefined, 'the old helper is outside the selected assignment ancestry');
  assert.equal(child.delegation.owner, receiver.id);
  assert.equal(helper.activeTurns.has(child.id), true);
  await agents.stop(first.jobId);
  await until(() => child.delegation.delivered);
  assert.equal(child.delegation.cancelled, true, 'the original immutable ancestor still addresses the retained subtree');
  complete(primary, source);
});

test('a failed ownership commit preserves the old owner and a saved acceptance can be retried once', async t => {
  const { agents, primary, workspace, add, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), next = await add('Reviewer');
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const owner = agents.conversation(next, true);
  owner.queuePaused = true;
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build once.');
  await until(() => worker.activeTurns.size);
  const chat = agents.conversation(worker), save = worker.save.bind(worker);
  worker.save = () => { if (chat.delegation.owner === owner.id) throw new Error('Commit disk failure'); return save(); };
  const args = { jobId: accepted.jobId, agentId: next.agentId, handoffId: 'commit-retry', expectedOwnerVersion: 1 };
  assert.throws(() => agents.tool(primary, source, 'agent_transfer_owner', args), /Commit disk failure/);
  assert.equal(chat.delegation.owner, source.id);
  const saved = JSON.parse(fs.readFileSync(next.filename, 'utf8')).sessions.find(session => session.id === owner.id);
  assert.equal(saved.items.find(item => item.handoff).handoff.state, 'accepted');
  assert.equal(saved.queue?.length || 0, 0, 'an uncommitted offer never wakes a model');
  assert.throws(() => agents.tool(primary, source, 'agent_transfer_owner', { ...args, agentId: 'main' }), /different offer/);
  worker.save = save;
  agents.tool(primary, source, 'agent_transfer_owner', args);
  assert.equal(chat.delegation.owner, owner.id);
  assert.equal(owner.items.filter(item => item.handoff).length, 1);
  assert.equal(owner.queue.filter(message => message.agentMail?.handoff).length, 1);
});

test('accepting an external result does not hold up an unrelated delegated assignment', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), review = await addWorker('Reviewer');
  const next = agents.controller(review.agentId);
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  source.queuePaused = true;
  agents.delegate(primary, source, review.agentId, 'Review a separate change.');
  const work = agents.conversation(review), owner = agents.conversation(next, true);
  await until(() => review.activeTurns.size);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build a separate artifact.');
  const chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  agents.tool(primary, source, 'agent_transfer_owner', {
    jobId: accepted.jobId, agentId: next.agentId, handoffId: 'independent-owner', expectedOwnerVersion: 1,
  });
  assert.equal(work.queue?.length || 0, 0, 'external mail does not occupy the active assignment inbox');
  assert.ok(owner.items.find(item => item.handoff));
  assert.equal(next.busy, null, 'the public owner remains free while both background slots are occupied');
  owner.queuePaused = true;
  complete(review, work, 'Separate review finished.');
  await until(() => work.delegation.delivered);
  assert.equal(chat.delegation.delivered, false, 'the transferred worker is still running');
  assert.equal(agents.pendingDelegations(work.id), false, 'ownership is not an unrelated assignment dependency');
  assert.match(source.items.find(item => item.type === 'agentResult').text, /Separate review finished/);
  assert.equal(review.client.calls.filter(call => call.method === 'turn/start').length, 1);
  agents.pump();
  assert.equal(owner.queue.filter(message => message.agentMail?.handoff).length, 1, 'the owner retains its handoff without changing the worker inbox');
});

test('external ownership mail waits while the receiver processes its own helper result', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), review = await addWorker('Reviewer'), helper = await addWorker('Review helper');
  const next = agents.controller(review.agentId);
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  source.queuePaused = true;
  agents.delegate(primary, source, review.agentId, 'Review a separate change.');
  const work = agents.conversation(review), owner = agents.conversation(next, true);
  await until(() => review.activeTurns.size);
  agents.delegate(review, work, helper.agentId, 'Check the separate change.');
  const help = agents.conversation(helper);
  await until(() => helper.activeTurns.size);
  complete(review, work, 'Waiting for review helper.');
  await until(() => !review.busy);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build a separate artifact.');
  const chat = agents.conversation(worker);
  await until(() => worker.activeTurns.size);
  agents.tool(primary, source, 'agent_transfer_owner', {
    jobId: accepted.jobId, agentId: next.agentId, handoffId: 'deferred-owner', expectedOwnerVersion: 1,
  });
  const note = owner.queue.find(message => message.agentMail?.handoff);
  assert.equal(work.queue?.length || 0, 0);
  (work.queue ||= []).push(note);
  await assert.rejects(review.queuedMessage(work.id, note.id, 'send'), /another assignment/);
  work.queue = [];
  complete(worker, chat, 'External artifact finished.');
  await until(() => chat.delegation.delivered);
  assert.equal(review.client.calls.filter(call => call.method === 'turn/start').length, 1);
  complete(helper, help, 'Only the review helper findings.');
  await until(() => review.activeTurns.size);
  const turn = review.client.calls.filter(call => call.method === 'turn/start').at(-1);
  assert.match(turn.params.input[0].text, /Only the review helper findings/);
  assert.doesNotMatch(turn.params.input[0].text, /External artifact finished/);
  work.queuePaused = true;
  complete(review, work, 'Separate review finished using its helper.');
  await until(() => work.delegation.delivered);
  assert.match(source.items.find(item => item.type === 'agentResult').text, /Separate review finished using its helper/);
  assert.equal(owner.items.filter(item => item.type === 'agentResult').length, 1);
  assert.equal(work.items.filter(item => item.type === 'agentResult').length, 1);
});

test('two background slots preserve foreground chat and admit queued work when a slot frees', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const workers = await Promise.all(['First', 'Second', 'Third'].map(name => addWorker(name)));
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const jobs = workers.map(worker => agents.delegate(primary, source, worker.agentId, 'Run independently.'));
  await until(() => workers.slice(0, 2).every(worker => worker.activeTurns.size));
  const queued = agents.conversation(workers[2]);
  await until(() => queued.capacityWaiting);
  assert.equal(workers[2].client.calls.filter(call => call.method === 'turn/start').length, 0);
  complete(primary, source, 'Accepted the background jobs.');
  await until(() => !primary.busy);
  await primary.send({ id: source.id, text: 'Answer a quick foreground question.', mode: 'terra-light', task: 'off' });
  assert.ok(primary.activeTurns.size, 'foreground chat does not wait for a background slot');
  assert.equal(agents.backgroundSlots.size, 2);
  source.queuePaused = true;
  complete(workers[0], agents.conversation(workers[0]));
  await until(() => workers[2].activeTurns.size);
  assert.equal(queued.capacityWaiting, undefined);
  assert.equal(queued.delegation.id, jobs[2].jobId);
  assert.ok(workers[1].activeTurns.size, 'the other active worker is unaffected');
  assert.equal(agents.backgroundSlots.size, 2);
});

test('a worker context left signed out by a transient Codex load error retries and starts its queued job', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  agents.accountRetryMs = 20;
  const worker = await addWorker('Late start');
  const call = worker.client.call.bind(worker.client);
  let failures = 2;
  worker.client.call = (method, params) => {
    if (method === 'account/read' && failures > 0) {
      failures--;
      return Promise.reject(new Error('workspace routing discovery timed out'));
    }

    return call(method, params);
  };
  await worker.refreshAccount();
  assert.equal(worker.connection, 'signed-out');

  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  agents.delegate(primary, source, worker.agentId, 'Run after the account loads.');
  await until(() => worker.activeTurns.size);

  assert.equal(worker.connection, 'ready');
  assert.equal(failures, 0, 'the retry repeats until the account loads');
  assert.equal(agents.accountRetries.size, 0);
});

test('another bot\'s stopping check delays queued background work instead of failing it', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const [held, queued] = await Promise.all(['Held', 'Queued'].map(name => addWorker(name)));
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  held.data.executionBlock = { reason: 'stopping', processId: 'stopping-check' };
  agents.delegate(primary, source, queued.agentId, 'Run after the check stops.');
  const chat = agents.conversation(queued);
  await until(() => chat.capacityWaiting);
  assert.equal(queued.client.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.notEqual(chat.status, 'failed');

  held.data.executionBlock = null;
  held.changed();
  await until(() => queued.activeTurns.size);
  assert.equal(chat.delegation.state, 'running');
});

test('a failed admission before checks blocks the task and frees the bot', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Checking', workspace, 'danger-full-access');
  const source = primary.create(workspace, 'danger-full-access');
  await start(primary, source);
  const checks = [{ id: 'build', name: 'Build', argv: ['fixture-build'], cwd: workspace, timeoutMs: 30000, kind: 'build' }];
  agents.delegate(primary, source, worker.agentId, 'Build.', [], null, null, { checks });
  await until(() => worker.activeTurns.size);
  worker.readyToStart = () => Promise.reject(new Error('Allowance cleanup is unconfirmed.'));
  const chat = agents.conversation(worker);
  complete(worker, chat);
  await until(() => !worker.busy);

  const task = chat.tasks.at(-1);
  assert.equal(task.state, 'blocked');
  assert.match(task.reason, /Allowance cleanup is unconfirmed/);
});

test('a rejected turn start closes its budget request instead of leaving it in flight', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Rejected');
  const call = worker.client.call.bind(worker.client);
  worker.client.call = (method, params) => method === 'turn/start' ? Promise.reject(new Error('Unsupported model.')) : call(method, params);
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  agents.delegate(primary, source, worker.agentId, 'Run.');
  const chat = agents.conversation(worker);
  await until(() => chat.error === 'Unsupported model.');

  assert.equal(agents.budgets.inflight.size, 0);
});

test('a controlled host check retains its slot without failing queued jobs or foreground chat, while uncertain checks still fence admission', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const workers = await Promise.all(['Checking', 'Building', 'Queued'].map(name => addWorker(name, workspace, 'danger-full-access')));
  const source = primary.create(workspace, 'danger-full-access');
  await start(primary, source);
  let failCheck;
  const checking = workers[0], call = checking.client.call.bind(checking.client);
  checking.client.process = { pid: 12345 };
  checking.lookupProcess = () => ({ status: 'present', pid: 12345, creationTime: 'fixture-identity' });
  checking.client.call = (method, params) => {
    if (method === 'command/exec') return new Promise((resolve, reject) => { failCheck = reject; });
    if (method === 'command/exec/terminate') throw new Error('Check termination is unconfirmed.');
    return call(method, params);
  };
  const checks = [{ id: 'held-build', name: 'Controlled build', argv: ['fixture-build'], cwd: workspace, timeoutMs: 30000, kind: 'build' }];
  agents.delegate(primary, source, checking.agentId, 'Build.', [], null, null, { checks });
  for (const worker of workers.slice(1)) agents.delegate(primary, source, worker.agentId, 'Run independently.');
  await until(() => workers.slice(0, 2).every(worker => worker.activeTurns.size));
  const queued = agents.conversation(workers[2]);
  await until(() => queued.capacityWaiting);
  complete(primary, source, 'Jobs accepted.');
  await until(() => !primary.busy);
  source.queuePaused = true;
  complete(checking, agents.conversation(checking));
  await until(() => !!failCheck);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(queued.capacityWaiting, true, 'an active check must leave the waiting job queued');
  assert.equal(workers[2].client.calls.filter(entry => entry.method === 'turn/start').length, 0);
  assert.equal(agents.backgroundSlots.size, 2, 'the checking worker still consumes its existing slot');
  await primary.send({ id: source.id, text: 'A foreground question during a build.', mode: 'terra-light', task: 'off' });
  assert.ok(primary.activeTurns.size);
  complete(primary, source, 'Foreground answer.');
  await until(() => !primary.busy);
  complete(workers[1], agents.conversation(workers[1]));
  await until(() => workers[2].activeTurns.size);
  assert.equal(agents.backgroundSlots.size, 2);
  assert.ok(checking.gate && checking.data.executionBlock, 'the original check is still controlled and running');
  assert.match(checking.blockedReason(), /check may still be running/, 'the same bot cannot start competing work');
  failCheck(new Error('Connection closed before the check result.'));
  await until(() => agents.conversation(checking).tasks[0].state === 'blocked');
  assert.ok(checking.data.executionBlock, 'unconfirmed termination keeps its durable recovery block');
  const foreground = agents.controller(workers[2].agentId), chat = agents.conversation(foreground, true);
  await assert.rejects(start(foreground, chat), /check may still be running/);
  assert.ok(workers[2].activeTurns.size, 'already admitted independent work is retained');
});

test('provider metadata holds a saved background assignment and admits it once after synchronization', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const worker = await addWorker('Waiting for metadata'), source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  agents.providerChanging = true;
  const job = agents.delegate(primary, source, worker.agentId, 'Keep this saved assignment.');
  complete(primary, source, 'Assignment accepted.');
  await until(() => !primary.busy);
  agents.providerChanging = false;
  let finish;
  const muse = primary.nativeCLIs.get('native:muse');
  muse.refresh = () => new Promise(resolve => { finish = () => resolve(muse.status); });
  const pending = require('../src/provider-connection.cjs').providerConnection({ controller: primary, agents }, 'native:muse', 'refresh');
  agents.pump();
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.ok(agents.pendingJobs().some(record => record.job.id === job.jobId));
  finish(); await pending;
  await until(() => worker.activeTurns.size);
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(agents.conversation(worker).delegation.id, job.jobId);
});

test('Stop cancels a capacity wait without ever starting its provider turn', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const workers = await Promise.all(['First', 'Second', 'Waiting'].map(name => addWorker(name)));
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const jobs = workers.map(worker => agents.delegate(primary, source, worker.agentId, 'Run independently.'));
  const queued = agents.conversation(workers[2]);
  await until(() => queued.capacityWaiting);
  await agents.stop(jobs[2].jobId);
  await until(() => !workers[2].busy && queued.delegation.delivered);
  assert.equal(queued.delegation.cancelled, true);
  assert.equal(agents.capacityWaits.size, 0);
  assert.equal(queued.capacityWaiting, undefined);
  assert.equal(workers[2].client.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.ok(workers.slice(0, 2).every(worker => worker.activeTurns.size));
});

test('waiting on a helper releases background capacity and closing cancels remaining waits', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const lead = await addWorker('Lead'), other = await addWorker('Other'), helper = await addWorker('Helper'), waiting = await addWorker('Waiting');
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  agents.delegate(primary, source, lead.agentId, 'Finish with help.');
  agents.delegate(primary, source, other.agentId, 'Independent job.');
  await until(() => lead.activeTurns.size && other.activeTurns.size);
  const parent = agents.conversation(lead);
  agents.delegate(lead, parent, helper.agentId, 'Help the lead.');
  const child = agents.conversation(helper);
  await until(() => child.capacityWaiting);
  complete(lead, parent, 'Waiting for my helper.');
  await until(() => helper.activeTurns.size);
  assert.equal(parent.delegation.delivered, false);
  assert.equal(agents.backgroundSlots.size, 2);
  const queued = agents.delegate(primary, source, waiting.agentId, 'Wait for a free slot.');
  const chat = waiting.session(queued.sessionId);
  await until(() => chat.capacityWaiting);
  agents.closing = true;
  agents.pump();
  await until(() => !waiting.busy);
  assert.equal(waiting.client.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.equal(agents.capacityWaits.size, 0);
});

test('committed ownership survives notification failure and restart without replaying the assignment', async t => {
  const { agents, primary, workspace, directory, factory, add, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), next = await add('Reviewer');
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const owner = agents.conversation(next, true);
  owner.queuePaused = true;
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build once.');
  await until(() => worker.activeTurns.size);
  const save = next.save.bind(next);
  next.save = () => {
    if (owner.items.some(item => item.handoff?.state === 'committed')) throw new Error('Notification disk failure');
    return save();
  };
  const transferred = agents.tool(primary, source, 'agent_transfer_owner', {
    jobId: accepted.jobId, agentId: next.agentId, handoffId: 'notify-retry', expectedOwnerVersion: 1,
  });
  assert.equal(transferred.status, 'transferred');
  assert.equal(transferred.notificationPending, true);
  assert.equal(owner.queue?.length || 0, 0, 'an unsaved notice cannot start a model turn');
  assert.equal(owner.items.find(item => item.handoff).handoff.state, 'accepted');
  assert.equal(JSON.parse(fs.readFileSync(worker.filename, 'utf8')).sessions[0].delegation.owner, owner.id);
  next.save = save;
  agents.closing = true;
  const restarted = new Agents(factory(path.join(directory, 'sessions.json'), workspace), async () => {}, factory);
  t.after(() => { restarted.closing = true; for (const controller of restarted.allControllers()) controller.close(); });
  const recovered = restarted.conversation(restarted.controller(next.agentId));
  const receipt = recovered.items.find(item => item.handoff);
  assert.equal(receipt.handoff.state, 'committed');
  assert.match(receipt.text, /Review the worker conversation before resuming/);
  assert.equal(recovered.queue?.filter(message => message.agentMail?.handoff).length || 0, 0);
  assert.equal(restarted.controller(worker.agentId).client.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('ownership transfers reject non-owners, stale versions, access escalation and dependency cycles', async t => {
  const { agents, primary, workspace, add, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), next = await add('Reviewer'), broad = await add('Broad', workspace, 'danger-full-access');
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const accepted = agents.delegate(primary, source, worker.agentId, 'Build once.');
  await until(() => worker.activeTurns.size);
  const args = { jobId: accepted.jobId, agentId: next.agentId, handoffId: 'owner-check', expectedOwnerVersion: 1 };
  assert.throws(() => agents.tool(worker, agents.conversation(worker), 'agent_transfer_owner', args), /Only the current owner/);
  assert.throws(() => agents.tool(primary, source, 'agent_transfer_owner', { ...args, expectedOwnerVersion: 2 }), /Ownership changed/);
  assert.throws(() => agents.tool(primary, source, 'agent_transfer_owner', { ...args, agentId: broad.agentId }), /access levels/);
  const job = agents.conversation(worker).delegation, access = job.access;
  delete job.access;
  assert.throws(() => agents.tool(primary, source, 'agent_transfer_owner', args), /Invalid assignment access/);
  job.access = access;
  const legacy = agents.conversation(next, true);
  legacy.delegation = { id: randomUUID(), source: agents.conversation(worker).id, owner: agents.conversation(worker).id,
    state: 'queued', access: 'workspace-write', delivered: false };
  assert.throws(() => agents.tool(primary, source, 'agent_transfer_owner', args), /circular dependency/);
});

test('cancelling a completed parent still stops transferred descendants and preserves unrelated new-owner work', async t => {
  const { agents, primary, workspace, add, addWorker } = await setup(t);
  const lead = await addWorker('Lead'), worker = await addWorker('Builder'), next = await add('Reviewer');
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  const parent = agents.delegate(primary, source, lead.agentId, 'Build an artifact with help.');
  await until(() => lead.activeTurns.size);
  const parentChat = agents.conversation(lead), owner = agents.conversation(next, true);
  await start(next, owner);
  const child = agents.delegate(lead, parentChat, worker.agentId, 'Build the artifact.');
  await until(() => worker.activeTurns.size);
  agents.tool(lead, parentChat, 'agent_transfer_owner', {
    jobId: child.jobId, agentId: next.agentId, handoffId: 'release-child', expectedOwnerVersion: 1,
  });
  complete(lead, parentChat, 'Reviewer now owns the requested result.');
  await until(() => parentChat.delegation.delivered);
  const chat = agents.conversation(worker);
  assert.ok(chat.delegation.ancestorJobIds.includes(parent.jobId));
  await agents.stop(parent.jobId);
  await until(() => chat.delegation.delivered);
  assert.equal(chat.delegation.cancelled, true);
  assert.equal(next.busy, owner.id);
  assert.equal(owner.items.find(item => item.type === 'agentResult').status, 'cancelled');
});

test('Main creates a persistent idle agent through a dynamic tool using conversation permissions', async t => {
  const { agents, primary, workspace } = await setup(t);
  primary.data.settings.access = 'danger-full-access';
  const source = primary.create(workspace, 'read-only');
  await start(primary, source);
  await primary.helperToolCall({ id: 78, params: { threadId: source.threadId, turnId: source.turnId, tool: 'agent_create', arguments: { name: 'Reviewer', instructions: 'Review the code.' } } });
  const output = primary.client.responses.find(r => r.id === 78);
  assert.equal(output.result.success, true);
  const profile = JSON.parse(output.result.contentItems[0].text);
  assert.equal(profile.name, 'Reviewer');
  assert.equal(profile.workspace, workspace);
  assert.equal(profile.access, 'read-only');
  assert.equal(profile.mode, 'auto');
  assert.ok(agents.snapshot().agents.some(agent => agent.id === profile.id));
  assert.ok(JSON.parse(fs.readFileSync(primary.filename)).agents.some(agent => agent.id === profile.id));
  const child = agents.controller(profile.id);
  await agents.initializeController(child);
  assert.equal(child.busy, null);
  assert.equal(child.client.calls.some(call => call.method === 'turn/start'), false);
  const task = agents.delegate(primary, source, profile.id, 'Review source.');
  assert.equal(agents.owner(task.sessionId).session(task.sessionId).access, 'read-only');
  await agents.stop(task.sessionId);
  source.queuePaused = true;
  complete(primary, source);
});

test('named and delegated agents can create agents through every provider bridge', async t => {
  const { agents, add, directory } = await setup(t);
  const workspace = path.join(directory, 'other'); fs.mkdirSync(workspace);
  const parent = await add('Parent', workspace, 'danger-full-access');
  const session = parent.create(workspace, 'workspace-write');
  await start(parent, session);
  session.delegation = { delivered: false, state: 'running' };
  session.agentReplyActive = true;
  for (const provider of ['codex', 'claude-cli', 'cursor-cli']) {
    session.activeProvider = provider;
    const profile = await parent.bridgeTool(session.id, 'agent_create', { name: provider, instructions: 'Help with the task.', mode: 'auto' });
    assert.equal(profile.workspace, workspace);
    assert.equal(profile.access, 'workspace-write');
    assert.equal(profile.mode, 'auto');
    assert.equal(agents.controller(profile.id).busy, null);
  }
  delete session.delegation; delete session.agentReplyActive;
  session.activeProvider = 'codex';
  complete(parent, session);
});

test('agent creation rejects inactive calls, edits, permission overrides and invalid profiles', async t => {
  const { agents, primary, workspace } = await setup(t);
  const source = primary.create(workspace, 'read-only');
  const args = { name: 'Helper', instructions: 'Inspect files.' };
  await assert.rejects(primary.bridgeTool(source.id, 'agent_create', args), /no active turn/);
  await primary.helperToolCall({ id: 79, params: { threadId: 'inactive', turnId: 'no', tool: 'agent_create', arguments: args } });
  assert.match(primary.client.responses.find(r => r.id === 79).error, /inactive/);
  await start(primary, source);
  const profile = await primary.bridgeTool(source.id, 'agent_create', args);
  for (const override of [{ id: profile.id }, { workspace }, { access: 'danger-full-access' }, { task: 'Start automatically' }]) {
    await assert.rejects(primary.bridgeTool(source.id, 'agent_create', { ...args, ...override }), /Invalid/);
  }
  for (const invalid of [{ name: '' }, { name: 'Hub' }, { name: 'Helper' }, { instructions: null }, { mode: 'missing-model' }, { mode: null }]) {
    await assert.rejects(primary.bridgeTool(source.id, 'agent_create', { ...args, name: 'New helper', ...invalid }));
  }
  const save = primary.save;
  primary.save = () => { throw new Error('Disk full'); };
  await assert.rejects(primary.bridgeTool(source.id, 'agent_create', { ...args, name: 'Unsaved' }), /Disk full/);
  primary.save = save;
  assert.equal(agents.primary.data.agents.length, 1);
  primary.stopping.add(source.id);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_create', args), /no active turn/);
  primary.stopping.delete(source.id);
  agents.closing = true;
  await assert.rejects(primary.bridgeTool(source.id, 'agent_create', args), /closing/);
  agents.closing = false;
  complete(primary, source);
});

test('the Hub can be renamed; it keeps the name, and no bot can take it, "hub" or "main"', async t => {
  const { agents, primary, workspace } = await setup(t);
  const helper = await agents.saveAgent({ name: 'Researcher', instructions: '', workspace, mode: 'auto', access: 'read-only' });
  for (const invalid of ['', ' ', 'x'.repeat(61), 'main', 'researcher', null])
    assert.throws(() => agents.renameHub(invalid), /name/, String(invalid));

  const save = primary.save;
  primary.save = () => { throw new Error('Disk full'); };
  assert.throws(() => agents.renameHub('Atlas'), /Disk full/);
  primary.save = save;
  assert.equal(agents.hubName(), 'Hub', 'a failed save keeps the old name');

  assert.equal(agents.renameHub('  Atlas '), 'Atlas');
  assert.equal(JSON.parse(fs.readFileSync(primary.filename, 'utf8')).hubName, 'Atlas');
  assert.equal(agents.snapshot().agents[0].name, 'Atlas');
  assert.equal(agents.agentName('main'), 'Atlas');
  assert.equal(require('../src/group-chats.cjs').members(agents, { group: { members: [helper.id] } })[0].name, 'Atlas');
  for (const name of ['Atlas', 'atlas', 'Hub', 'main'])
    await assert.rejects(agents.saveAgent({ id: helper.id, name, instructions: '', workspace, mode: 'auto', access: 'read-only' }), /belongs to the Hub/, name);
});

test('agents discover available models and create children with default or requested efforts across provider bridges', async t => {
  const { agents, primary, workspace, add } = await setup(t);
  primary.models[0].supportedReasoningEfforts = ['low', 'medium', 'high'].map(reasoningEffort => ({ reasoningEffort }));
  agents.configure = async controller => { controller.client.models = primary.models; };
  primary.data.settings.claudeEnabled = true;
  primary.claude.status = { loggedIn: true };
  primary.claude.models = [{ id: 'claude-cli:review-model', provider: 'claude-cli', model: 'review-model', label: 'Review', worker: true, rank: 35, efforts: ['low', 'medium', 'high'] }];
  primary.data.settings.cursorEnabled = true;
  primary.cursor.status = { loggedIn: true };
  primary.cursor.models = [{ id: 'review-model', parameterized: true, efforts: ['low', 'medium', 'high'] }];
  primary.data.settings.providerModels = [
    { id: 'cursor-cli:review-model:default', provider: 'cursor-cli', model: 'review-model', label: 'Review', worker: true, enabled: true, rank: 40, cursorEffort: 'low' },
    { id: 'cursor-cli:plain:default', provider: 'cursor-cli', model: 'plain', effort: null, worker: true, enabled: true, rank: 45 },
    { id: 'cursor-cli:disabled:default', provider: 'cursor-cli', model: 'disabled', worker: true, enabled: false, rank: 50 },
  ];
  const parent = await add('Parent');
  const expected = [
    { mode: 'auto', model: 'Auto', efforts: [] },
    { mode: 'codex:gpt-5.6-terra:medium', provider: 'codex', model: 'gpt-5.6-terra', effort: 'medium', efforts: ['low', 'medium', 'high'] },
    { mode: 'claude-cli:review-model:medium', provider: 'claude-cli', model: 'review-model', effort: 'medium', efforts: ['low', 'medium', 'high'] },
    { mode: 'cursor-cli:review-model:low', provider: 'cursor-cli', model: 'review-model', effort: 'low', efforts: ['low', 'medium', 'high'] },
    { mode: 'cursor-cli:plain:default', provider: 'cursor-cli', model: 'plain', effort: 'default', efforts: ['default'] },
  ];
  let codexChild;
  for (const creator of [primary, parent]) {
    const source = creator.create(workspace, 'read-only');
    await start(creator, source);
    for (const provider of ['codex', 'claude-cli', 'cursor-cli']) {
      source.activeProvider = provider;
      const choices = await creator.bridgeTool(source.id, 'agent_models', {});
      assert.deepEqual(choices, expected);
      const choice = choices.find(p => p.provider === provider);
      for (const effort of [undefined, 'high']) {
        const profile = await creator.bridgeTool(source.id, 'agent_create', { name: `${creator.agentId} ${provider} ${effort || 'default'}`, instructions: 'Help.', mode: choice.mode, ...(effort ? { effort } : {}) });
        const selected = primary.resolveWorker(profile.mode);
        assert.equal(selected.provider, provider);
        assert.equal(selected.model, choice.model);
        assert.equal(selected.effort, effort || choice.effort);
        assert.equal(profile.access, 'read-only');
        assert.equal(agents.controller(profile.id).data.settings.mode, profile.mode);
        assert.equal(JSON.parse(fs.readFileSync(primary.filename)).agents.find(a => a.id === profile.id).mode, profile.mode);
        if (provider === 'codex' && effort) codexChild = profile;
      }
    }
    const plain = await creator.bridgeTool(source.id, 'agent_create', { name: `${creator.agentId} plain`, instructions: '', mode: 'cursor-cli:plain:default', effort: 'default' });
    assert.equal(plain.mode, 'cursor-cli:plain:default');
    assert.equal(creator.data.settings.mode, 'terra-light', 'creation leaves the parent model unchanged');
    source.activeProvider = 'codex';
    complete(creator, source);
  }
  const child = agents.controller(codexChild.id);
  await agents.initializeController(child);
  const chat = agents.conversation(child, true);
  await child.send({ id: chat.id, text: 'Inspect source.', mode: child.data.settings.mode, task: 'off' });
  const turn = child.client.calls.findLast(call => call.method === 'turn/start');
  assert.equal(turn.params.model, 'gpt-5.6-terra');
  assert.equal(turn.params.effort, 'high');
  complete(child, chat);
});

test('agent model requests fail without creating profiles when unavailable, malformed or unsupported', async t => {
  const { agents, primary } = await setup(t);
  const source = primary.create();
  await assert.rejects(primary.bridgeTool(source.id, 'agent_models', {}), /no active turn/);
  await start(primary, source);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_models', { extra: true }), /Invalid/);
  const disk = fs.readFileSync(primary.filename, 'utf8');
  for (const selection of [{ mode: 'missing' }, { mode: null }, { mode: 1 }, { mode: {} }, { effort: 'high' }, { mode: 'auto', effort: 'low' }, ...['high', '', null, 1, {}].map(effort => ({ mode: 'terra-light', effort }))]) {
    await assert.rejects(primary.bridgeTool(source.id, 'agent_create', { name: 'Invalid', instructions: '', ...selection }));
  }
  assert.equal(agents.primary.data.agents.length, 0);
  assert.equal(fs.readFileSync(primary.filename, 'utf8'), disk);
  primary.data.settings.disabledCodexModels = ['gpt-5.6-terra'];
  assert.deepEqual(await primary.bridgeTool(source.id, 'agent_models', {}), [{ mode: 'auto', model: 'Auto', efforts: [] }]);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_create', { name: 'Disabled', instructions: '', mode: 'terra-light' }), /unavailable/);
  primary.data.settings.disabledCodexModels = [];
  primary.account = null;
  await assert.rejects(primary.bridgeTool(source.id, 'agent_create', { name: 'Disconnected', instructions: '', mode: 'terra-light' }), /unavailable/);
  assert.equal(agents.primary.data.agents.length, 0);
  complete(primary, source);
});

test('new and existing Codex chats expose agent tools through a session-bound MCP bridge', async t => {
  const { primary } = await setup(t);
  const source = primary.create();
  await start(primary, source);
  const started = primary.client.calls.find(call => call.method === 'thread/start');
  assert.equal(started.params.config['features.multi_agent'], false, 'untracked agent chats must not expose provider-native subagents');
  assert.match(started.params.developerInstructions, /MUST call agent_create and confirm its returned id/);
  const server = started.params.config['mcp_servers.phasma_harness'];
  assert.deepEqual(server.enabled_tools, ['agent_revise', 'agent_transfer_owner', 'agents_list', 'agent_models', 'agent_create', 'agent_delegate', 'agent_read_context', 'agent_stop', 'agent_set_access', 'agent_message', 'agent_artifact', 'routine', 'routines_report', 'harness_check_update']);
  assert.ok(!MCP_TOOLS.some(tool => tool.name === 'agent_delete') && !claudeAllowedHelpers('danger-full-access').includes('mcp__phasma_harness__agent_delete'));
  assert.equal(server.env.PHASMA_SESSION_ID, source.id);
  assert.equal(server.env.ELECTRON_RUN_AS_NODE, '1');
  assert.ok(MCP_TOOLS.some(tool => tool.name === 'agent_create'));
  assert.ok(claudeAllowedHelpers('read-only').includes('mcp__phasma_harness__agent_create'));
  assert.ok(claudeAllowedHelpers('read-only').includes('mcp__phasma_harness__agent_read_context'));
  assert.ok(MCP_TOOLS.some(tool => tool.name === 'agent_read_context'));
  assert.equal(server.tools.agent_read_context.approval_mode, 'approve');
  for (const name of ['agent_models', 'agent_stop', 'agent_set_access', 'agent_message']) {
    assert.ok(MCP_TOOLS.some(tool => tool.name === name));
    assert.ok(claudeAllowedHelpers('read-only').includes('mcp__phasma_harness__' + name));
    assert.equal(server.tools[name].approval_mode, 'approve');
  }
  complete(primary, source);
  const threadId = source.threadId;
  source.helperTools = false;
  primary.loaded.delete(source.id);
  await start(primary, source);
  const resumed = primary.client.calls.findLast(call => call.method === 'thread/resume');
  assert.equal(resumed.params.threadId, threadId);
  assert.equal(resumed.params.config['features.multi_agent'], false, 'resumed agent chats must keep provider-native subagents disabled');
  assert.deepEqual(resumed.params.config['mcp_servers.phasma_harness'], server);
  assert.equal(primary.client.calls.filter(call => call.method === 'thread/start').length, 1);
  const injection = primary.client.calls.findLast(call => call.method === 'thread/inject_items');
  assert.equal(injection.params.threadId, threadId);
  assert.equal(injection.params.items[0].role, 'developer');
  assert.match(injection.params.items[0].content[0].text, /MUST call agent_create and confirm its returned id/);
  assert.equal(server.tools.agent_create.approval_mode, 'approve');
  const response = await fetch(`${server.env.PHASMA_BRIDGE_URL}/v1/call`, {
    method: 'POST', headers: { Authorization: `Bearer ${server.env.PHASMA_BRIDGE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: source.id, tool: 'agent_create', arguments: { name: 'From existing chat', instructions: 'Review files.' } }),
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).result.name, 'From existing chat');
  await assert.rejects(primary.bridgeTool(source.id, 'router_call_tool', {}), /Only agent tools/);
  complete(primary, source);
});

test('saving an agent returns while startup is pending and reuses provider discovery', async t => {
  const { agents, primary, workspace, factory } = await setup(t);
  let release;
  agents.configure = () => new Promise(resolve => { release = resolve; });
  agents.createController = (...args) => {
    const worker = factory(...args);
    worker.claude.refresh = worker.cursor.refresh = async () => { throw new Error('Repeated provider discovery'); };
    return worker;
  };
  let profile;
  try {
    const saving = agents.saveAgent({ name: 'Fast save', workspace, mode: 'terra-light', access: 'read-only', instructions: 'Review source.' });
    saving.then(value => { profile = value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(profile, 'Saving must not wait for provider startup');
    assert.equal(agents.snapshot().agentStates[profile.id].connection, 'connecting');
    assert.equal(agents.controller(profile.id).client.calls.length, 0);
    assert.equal(JSON.parse(fs.readFileSync(primary.filename)).agents[0].id, profile.id);
  } finally { release(); }
  const worker = agents.controller(profile.id);
  await agents.initializeController(worker);
  assert.equal(worker.connection, 'ready');
  assert.deepEqual(worker.claude.status, primary.claude.status);
  assert.deepEqual(worker.cursor.models, primary.cursor.models);
});

test('background startup errors stay visible on the saved agent', async t => {
  const { agents, workspace } = await setup(t);
  agents.configure = async () => { throw new Error('Port unavailable'); };
  const profile = await agents.saveAgent({ name: 'Offline', workspace, mode: 'auto', access: 'read-only', instructions: '' });
  await agents.initializeController(agents.controller(profile.id));
  const snapshot = agents.snapshot().agentStates[profile.id];
  assert.equal(snapshot.connection, 'disconnected');
  assert.match(snapshot.error, /Agent startup failed: Port unavailable/);
  assert.ok(agents.profile(profile.id));
});

test('quitting during configuration does not start an agent afterward', async t => {
  const { agents, workspace } = await setup(t);
  let release, closed = 0;
  agents.configure = () => new Promise(resolve => { release = resolve; });
  const profile = await agents.saveAgent({ name: 'Starting', workspace, mode: 'auto', access: 'read-only', instructions: '' });
  const worker = agents.controller(profile.id);
  const close = worker.close.bind(worker);
  worker.close = () => { closed++; return close(); };
  agents.closing = true; release();
  await agents.initializeController(worker);
  assert.equal(worker.client.calls.length, 0);
  assert.equal(closed, 1);
});

test('agents preserve separate profiles, sessions and instructions across restart', async t => {
  const { agents, primary, add, factory, workspace } = await setup(t);
  const worker = await add('Reviewer');
  const session = worker.create();
  assert.equal(primary.data.sessions.length, 0);
  assert.match(worker.workerInstructions(session), /Role: Reviewer/);
  assert.equal(agents.owner(session.id), worker);
  assert.equal(agents.snapshot().agentStates[worker.agentId].sessions[0].id, session.id);
  worker.save(); primary.save();
  const restoredRoot = factory(primary.filename, workspace);
  const restored = new Agents(restoredRoot, async () => {}, factory);
  assert.equal(restored.profile(worker.agentId).name, 'Reviewer');
  assert.equal(restored.owner(session.id).session(session.id).id, session.id);
  assert.equal(restored.controller(worker.agentId).limits.store, restoredRoot.limits.store);
  for (const c of restored.allControllers()) c.close();
});

test('clear requires confirmation, archives history and starts fresh context for Main and named agents', async t => {
  const { agents, primary, add, factory, workspace } = await setup(t);
  const worker = await add('Reviewer');
  for (const controller of [primary, worker]) {
    const old = agents.conversation(controller, true, workspace, 'read-only');
    old.threadId = 'old-codex'; old.claudeSessionId = 'old-claude'; old.cursorSessionId = 'old-cursor';
    old.items.push({ id: 'history', type: 'agentMessage', text: 'OLD_CONTEXT_MUST_NOT_BE_SENT' });
    old.usage = { total: { inputTokens: 90000 } }; controller.save();
    controller.loaded.add(old.id); controller.sessionAllows.set(old.id, new Set(['old-approval']));
    const before = fs.readFileSync(controller.filename, 'utf8');
    assert.equal(await agents.clearConversation(controller.agentId, () => false), null);
    assert.equal(fs.readFileSync(controller.filename, 'utf8'), before);
    const fresh = await agents.clearConversation(controller.agentId, name => { assert.equal(name, controller === primary ? 'Hub' : 'Reviewer'); return true; });
    assert.notEqual(fresh.id, old.id);
    assert.equal(fresh.workspace, workspace); assert.equal(fresh.access, 'read-only');
    assert.deepEqual(fresh.items, []); assert.equal(fresh.usage, null);
    assert.equal(fresh.threadId, null); assert.equal(fresh.claudeSessionId, undefined); assert.equal(fresh.cursorSessionId, undefined);
    assert.equal(controller.data.sessions.find(s => s.id === old.id).archived, true);
    assert.equal(controller.data.sessions.find(s => s.id === old.id).items[0].text, 'OLD_CONTEXT_MUST_NOT_BE_SENT');
    assert.equal(controller.loaded.has(old.id), false); assert.equal(controller.sessionAllows.has(old.id), false);
    assert.equal(agents.conversation(controller).id, fresh.id);
    await start(controller, fresh);
    assert.ok(controller.client.calls.some(call => call.method === 'thread/start'));
    assert.notEqual(fresh.threadId, 'old-codex');
    assert.doesNotMatch(JSON.stringify(controller.client.calls), /OLD_CONTEXT_MUST_NOT_BE_SENT/);
    complete(controller, fresh);
  }
  const restoredRoot = factory(primary.filename, workspace), restored = new Agents(restoredRoot, async () => {}, factory);
  assert.equal(restored.primary.data.agents.length, 1, 'archived history does not become extra sidebar agents');
  assert.equal(restored.conversation(restored.primary).id, agents.conversation(primary).id);
  assert.equal(restored.profile(worker.agentId).instructions, 'Role: Reviewer');
  for (const controller of restored.allControllers()) controller.close();
});

test('clear rejects pending work, rechecks after confirmation and rolls back a failed save', async t => {
  const { agents, primary, add } = await setup(t);
  const old = agents.conversation(primary, true);
  old.items.push({ id: 'history', type: 'agentMessage', text: 'Keep this history.' }); primary.save();
  let confirmations = 0;
  const confirm = () => { confirmations++; return true; };
  primary.busy = old.id;
  await assert.rejects(agents.clearConversation('main', confirm), /pending work/);
  primary.busy = null; old.queue = [{ id: 'queued', text: 'Keep pending input.' }];
  await assert.rejects(agents.clearConversation('main', confirm), /queued/);
  old.queue = [];
  const child = await add('Child'), task = agents.conversation(child, true);
  task.delegation = { source: old.id, state: 'queued', delivered: false }; child.connection = 'disconnected';
  await assert.rejects(agents.clearConversation('main', confirm), /delegated tasks/);
  delete task.delegation;
  assert.equal(confirmations, 0);
  let answer;
  const clearing = agents.clearConversation('main', () => new Promise(resolve => { answer = resolve; }));
  primary.busy = old.id; answer(true);
  await assert.rejects(clearing, /pending work/); primary.busy = null;
  const previous = primary.data.sessions, before = fs.readFileSync(primary.filename, 'utf8'), save = primary.save;
  primary.save = () => { throw new Error('Disk full'); };
  await assert.rejects(agents.clearConversation('main', confirm), /Disk full/); primary.save = save;
  assert.equal(primary.data.sessions, previous); assert.equal(primary.data.agentSessionId, old.id);
  assert.equal(fs.readFileSync(primary.filename, 'utf8'), before); assert.equal(old.archived, false);
});

test('one conversation is retained per agent and old chats migrate once without losing IDs or history', async t => {
  const { agents, primary, factory, workspace } = await setup(t);
  const kept = agents.conversation(primary, true, workspace, 'read-only');
  assert.equal(agents.conversation(primary, true).id, kept.id);
  const old = primary.create(); old.title = 'Earlier investigation'; old.items.push({ id: 'evidence', type: 'agentMessage', text: 'Keep this evidence.' }); primary.save();
  const restored = factory(primary.filename, workspace);
  const migrated = new Agents(restored, async () => {}, factory);
  t.after(() => { migrated.closing = true; for (const c of migrated.allControllers()) c.close(); });
  assert.equal(migrated.conversation(restored).id, kept.id);
  assert.equal(restored.data.agents.length, 1);
  const moved = migrated.controller(restored.data.agents[0].id);
  assert.equal(migrated.conversation(moved).id, old.id);
  assert.equal(moved.session(old.id).items[0].text, 'Keep this evidence.');
  assert.equal(restored.data.sessions.length, 1);
  restored.data.sessions.push(old); restored.save(); // Reproduce a crash before removing the source copy.
  migrated.migrateConversations();
  assert.equal(restored.data.agents.length, 1);
  assert.equal(restored.data.sessions.length, 1);
  assert.equal(migrated.snapshot().agents[0].name, 'Hub');
});

test('agent deletion protects Main and pending work, persists removal, and keeps recovery files', async t => {
  const { agents, primary, add } = await setup(t);
  const worker = await add('Delete me');
  const chat = agents.conversation(worker, true);
  await assert.rejects(agents.deleteAgent('main'), /cannot be deleted/);
  await assert.rejects(agents.deleteAgent(), /Unknown agent/);
  worker.busy = chat.id;
  await assert.rejects(agents.deleteAgent(worker.agentId), /Stop this agent/);
  worker.busy = null;
  chat.delegation = { source: 'source', state: 'queued', delivered: false };
  await assert.rejects(agents.deleteAgent(worker.agentId), /delegated tasks/);
  delete chat.delegation;
  const save = primary.save.bind(primary); primary.save = () => { throw new Error('Disk full'); };
  await assert.rejects(agents.deleteAgent(worker.agentId), /Disk full/);
  assert.ok(agents.profile(worker.agentId)); assert.equal(agents.controller(worker.agentId), worker);
  primary.save = save;
  await agents.deleteAgent(worker.agentId);
  assert.throws(() => agents.controller(worker.agentId), /Unknown agent/);
  assert.equal(JSON.parse(fs.readFileSync(primary.filename)).agents.length, 0);
  assert.equal(JSON.parse(fs.readFileSync(worker.filename)).sessions[0].id, chat.id);
});

test('all provider bridges can change another agent access and stop it, but never delete it', async t => {
  const { agents, primary, workspace, add } = await setup(t);
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  for (const provider of ['codex', 'claude-cli', 'cursor-cli']) {
    source.activeProvider = provider;
    const worker = await add(provider, workspace, 'read-only'), chat = agents.conversation(worker, true);
    chat.items.push({ id: 'kept', type: 'agentMessage', text: 'Conversation retained for recovery.' }); worker.save();
    worker.loaded.add(chat.id); worker.sessionAllows.set(chat.id, new Set(['old-approval']));
    const updated = await primary.bridgeTool(source.id, 'agent_set_access', { agentId: worker.agentId, access: 'workspace-write' });
    assert.deepEqual(updated, { agentId: worker.agentId, name: provider, access: 'workspace-write', status: 'updated' });
    assert.equal(agents.profile(worker.agentId).access, 'workspace-write');
    assert.equal(chat.access, 'workspace-write');
    assert.equal(worker.data.settings.access, 'workspace-write');
    assert.equal(worker.loaded.has(chat.id), false);
    assert.equal(worker.sessionAllows.has(chat.id), false);
    assert.equal(JSON.parse(fs.readFileSync(primary.filename)).agents.find(a => a.id === worker.agentId).access, 'workspace-write');
    assert.equal(JSON.parse(fs.readFileSync(worker.filename)).sessions.find(s => s.id === chat.id).access, 'workspace-write');
    const stopped = await primary.bridgeTool(source.id, 'agent_stop', { agentId: worker.agentId });
    assert.equal(stopped.status, 'stopped');
    assert.equal(chat.queuePaused, true);
    await assert.rejects(primary.bridgeTool(source.id, 'agent_delete', { agentId: worker.agentId }), /Only agent tools|Unsupported or inactive/);
    assert.ok(agents.profile(worker.agentId));
    assert.equal(JSON.parse(fs.readFileSync(worker.filename)).sessions[0].items[0].text, 'Conversation retained for recovery.');
  }
  source.activeProvider = 'codex'; complete(primary, source);
});

test('no agent can delete another agent; only the user can', async t => {
  const { agents, primary, workspace, add } = await setup(t);
  const worker = await add('Target');
  const source = primary.create(workspace, 'danger-full-access');
  await start(primary, source);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_delete', { agentId: worker.agentId }), /Only agent tools/);
  assert.ok(agents.profile(worker.agentId), 'the agent survives the request');
  assert.ok(!require('../src/tools/agent-tools.cjs').TOOLS.some(tool => tool.name === 'agent_delete'), 'agents are not offered a delete tool');
  complete(primary, source);
  await until(() => !primary.busy);

  await agents.deleteAgent(worker.agentId);
  assert.equal(agents.profile(worker.agentId), undefined, 'the user can still delete it');
});

test('named agents can stop Main and change its access but cannot delete Main', async t => {
  const { agents, primary, add, directory } = await setup(t);
  const other = path.join(directory, 'manager-workspace'); fs.mkdirSync(other);
  const manager = await add('Manager', other), source = agents.conversation(manager, true);
  const main = agents.conversation(primary, true);
  await start(primary, main); await start(manager, source);
  const stopped = await manager.bridgeTool(source.id, 'agent_stop', { agentId: 'main' });
  assert.ok(['stopped', 'stopping'].includes(stopped.status));
  await until(() => !primary.busy);
  assert.equal(main.queuePaused, true);
  assert.ok(primary.client.calls.some(call => call.method === 'turn/interrupt' && call.params.threadId === main.threadId));
  await assert.rejects(manager.bridgeTool(source.id, 'agent_delete', { agentId: 'main' }), /Only agent tools/);
  await assert.rejects(manager.bridgeTool(source.id, 'agent_set_access', { agentId: 'main', access: 'read-only' }), /different workspace/);
  complete(manager, source);
  manager.permissions(source.id, 'danger-full-access');
  await start(manager, source);
  const changed = await manager.bridgeTool(source.id, 'agent_set_access', { agentId: 'main', access: 'read-only' });
  assert.equal(changed.name, 'Hub'); assert.equal(main.access, 'read-only');
  assert.equal(primary.data.settings.access, 'read-only');
  assert.equal(JSON.parse(fs.readFileSync(primary.filename)).settings.access, 'read-only');
  complete(manager, source);
});

test('management rejects escalation, self-targeting, inactive calls and pending work', async t => {
  const { agents, primary, workspace, add } = await setup(t);
  const worker = await add('Target'), chat = agents.conversation(worker, true);
  const source = primary.create(workspace, 'read-only');
  primary.data.settings.access = 'danger-full-access';
  for (const name of ['agent_stop', 'agent_set_access']) {
    await assert.rejects(primary.bridgeTool(source.id, name, { agentId: worker.agentId, ...(name === 'agent_set_access' ? { access: 'read-only' } : {}) }), /no active turn/);
  }
  await start(primary, source);
  for (const access of ['workspace-write', 'danger-full-access']) {
    await assert.rejects(primary.bridgeTool(source.id, 'agent_set_access', { agentId: worker.agentId, access }), /Cannot grant more access/);
  }
  for (const name of ['agent_stop', 'agent_set_access']) {
    const args = { agentId: worker.agentId, ...(name === 'agent_set_access' ? { access: 'read-only' } : {}) };
    for (const invalid of [{ ...args, agentId: 'main' }, { ...args, agentId: '../sessions.json' }, { ...args, agentId: '' }, { ...args, workspace }, {}]) await assert.rejects(primary.bridgeTool(source.id, name, invalid));
  }
  await assert.rejects(primary.bridgeTool(source.id, 'agent_set_access', { agentId: worker.agentId, access: 'admin' }), /Unknown access/);
  chat.queue = [{ id: 'pending', text: 'Keep this task.' }]; chat.queuePaused = true;
  await assert.rejects(agents.deleteAgent(worker.agentId), /queued/, 'the user\'s delete also waits for queued work');
  await assert.rejects(primary.bridgeTool(source.id, 'agent_set_access', { agentId: worker.agentId, access: 'read-only' }), /pending work/);
  chat.queue = []; worker.busy = chat.id;
  await assert.rejects(agents.deleteAgent(worker.agentId), /pending work/);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_set_access', { agentId: worker.agentId, access: 'read-only' }), /pending work/);
  worker.busy = null;
  assert.equal(chat.access, 'workspace-write');
  complete(primary, source);
});

test('children and grandchildren inherit current conversation access at every level', async t => {
  const { agents, primary, workspace } = await setup(t);
  const source = primary.create(workspace, 'read-only');
  for (const access of ['read-only', 'workspace-write', 'danger-full-access']) {
    primary.permissions(source.id, access);
    primary.data.settings.access = access === 'danger-full-access' ? 'read-only' : 'danger-full-access';
    await start(primary, source);
    const profile = await primary.bridgeTool(source.id, 'agent_create', { name: 'Child ' + access, instructions: 'Help with the current task.' });
    assert.equal(profile.access, access);
    complete(primary, source);
    const child = agents.controller(profile.id);
    await agents.initializeController(child);
    const chat = agents.conversation(child, true);
    assert.equal(chat.access, access);
    await start(child, chat);
    const grandchild = await child.bridgeTool(chat.id, 'agent_create', { name: 'Grandchild ' + access, instructions: 'Help the child.' });
    assert.equal(grandchild.access, access);
    assert.equal(grandchild.workspace, workspace);
    assert.equal(agents.controller(grandchild.id).busy, null);
    complete(child, chat);
  }
});

test('successive delegated tasks reuse the conversation and deliver only their own results once', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Researcher');
  const source = agents.conversation(primary, true); source.queuePaused = true;
  const chat = agents.conversation(worker, true);
  worker.permissions(chat.id, 'read-only');
  chat.items.push({ id: 'private', type: 'agentMessage', phase: 'final_answer', text: 'Old unrelated answer' });
  const run = async answer => {
    const job = agents.delegate(primary, source, worker.agentId, 'Inspect source');
    assert.equal(job.sessionId, chat.id);
    assert.equal(chat.access, 'read-only', 'Delegation cannot raise the persistent conversation permissions');
    await until(() => !!chat.turnId);
    assert.equal(chat.delegation.id, job.jobId, 'the accepted assignment retains its identity');
    complete(worker, chat, answer); await worker.gateDone; agents.pump();
    await until(() => chat.delegation.delivered);
  };
  await run('First answer');
  await run('Second answer');
  assert.equal(worker.data.sessions.length, 1);
  assert.equal(source.queue.length, 2);
  assert.notEqual(source.queue[0].id, source.queue[1].id);
  assert.doesNotMatch(source.queue[0].text, /Old unrelated/);
  assert.doesNotMatch(source.queue[1].text, /Old unrelated|First answer/);
  assert.match(source.queue[1].text, /Second answer/);
  agents.pump(); assert.equal(source.queue.length, 2);
  const receipts = source.items.filter(item => item.type === 'agentResult');
  assert.deepEqual(receipts.map(item => item.text), ['First answer', 'Second answer']);
  assert.equal(receipts[0].ownerName, 'Hub');
  assert.equal(receipts[0].agentId, worker.agentId);
  assert.equal(receipts[0].sessionId, chat.id);
  assert.notEqual(receipts[0].deliveryId, receipts[1].deliveryId);
  assert.equal(JSON.parse(fs.readFileSync(primary.filename, 'utf8')).sessions.find(s => s.id === source.id)
    .items.filter(item => item.type === 'agentResult').length, 2, 'receipts persist before the owner resumes');
});

test('a full owner queue retains a visible result once, and a failed save can retry safely', async t => {
  const { agents, primary, add } = await setup(t);
  const worker = await add('Researcher');
  const source = agents.conversation(primary, true); source.queuePaused = true;
  source.queue = Array.from({ length: 10 }, (_, i) => ({ id: String(i), text: 'User message', images: [] }));
  const chat = agents.conversation(worker, true);
  chat.delegation = { id: randomUUID(), source: source.id, state: 'running', startIndex: 0, delivered: false };
  chat.status = 'completed';
  chat.items.push({ id: randomUUID(), type: 'agentMessage', text: 'Result evidence.\n[task: done]' });
  const save = primary.save;
  primary.save = () => { throw new Error('Disk full'); };
  try { assert.throws(() => agents.deliver(worker, chat), /Disk full/); }
  finally { primary.save = save; }
  assert.equal(source.items.length, 0, 'an unsaved receipt is rolled back');
  assert.equal(source.agentDeliveries.length, 0);
  assert.equal(chat.delegation.delivered, false);
  agents.deliver(worker, chat);
  assert.equal(source.items.length, 1);
  assert.equal(source.items[0].text, 'Result evidence.');
  assert.equal(source.queue.length, 10, 'user messages are preserved when the queue is full');
  chat.delegation.delivered = false;
  agents.deliver(worker, chat);
  assert.equal(source.items.length, 1, 'a delivery retry cannot duplicate the report');
  const context = agents.readContext(chat, { agentId: 'main' });
  assert.match(JSON.stringify(context), /Result evidence/);
  assert.equal(source.items[0].pendingReply.id, source.items[0].id);
  source.queue.shift();
  primary.save = () => { throw new Error('Deferred delivery disk failure'); };
  try { assert.throws(() => agents.flushReplies(primary, source), /Deferred delivery disk failure/); }
  finally { primary.save = save; }
  assert.equal(source.queue.length, 9);
  assert.ok(source.items[0].pendingReply, 'a failed queue save retains the saved report notification');
  agents.flushReplies(primary, source);
  agents.flushReplies(primary, source);
  assert.equal(source.queue.length, 10);
  assert.equal(source.queue.filter(message => message.agentReply).length, 1);
  assert.equal(source.items[0].pendingReply, undefined);
  assert.equal(source.queuePaused, true);
  assert.equal(JSON.parse(fs.readFileSync(primary.filename)).sessions.find(s => s.id === source.id).queue.at(-1).id, source.items[0].id);
});

test('restart retains a deferred report without automatically reviewing it', async t => {
  const { agents, primary, workspace, directory, factory, add } = await setup(t);
  const worker = await add('Researcher');
  const source = agents.conversation(primary, true);
  source.queue = Array.from({ length: 10 }, (_, i) => ({ id: String(i), text: 'User message', images: [] }));
  const chat = agents.conversation(worker, true);
  chat.delegation = { id: randomUUID(), source: source.id, state: 'running', startIndex: 0, delivered: false };
  chat.status = 'completed';
  chat.items.push({ id: randomUUID(), type: 'agentMessage', text: 'Persisted evidence.' });
  agents.deliver(worker, chat);
  assert.ok(source.items[0].pendingReply);
  agents.closing = true;
  const restarted = new Agents(factory(path.join(directory, 'sessions.json'), workspace), async () => {}, factory);
  t.after(() => { restarted.closing = true; for (const c of restarted.allControllers()) c.close(); });
  const owner = restarted.primary.session(source.id);
  assert.equal(owner.queuePaused, true);
  owner.queue.shift();
  restarted.flushReplies(restarted.primary, owner);
  restarted.flushReplies(restarted.primary, owner);
  assert.equal(owner.queue.filter(message => message.agentReply).length, 1);
  assert.equal(owner.items[0].text, 'Persisted evidence.');
  assert.equal(restarted.primary.client.calls.filter(call => call.method === 'turn/start').length, 0);
});

test('a helper report behind a full queue still prevents premature parent completion', async t => {
  const { agents, primary, workspace, addWorker } = await setup(t);
  const lead = await addWorker('Lead'), helper = await addWorker('Helper');
  const source = primary.create(workspace, 'workspace-write');
  await start(primary, source);
  agents.delegate(primary, source, lead.agentId, 'Complete using a helper.');
  const parent = agents.conversation(lead);
  await until(() => lead.activeTurns.size);
  agents.delegate(lead, parent, helper.agentId, 'Find required evidence.');
  const child = agents.conversation(helper);
  await until(() => helper.activeTurns.size);
  parent.queue = Array.from({ length: 10 }, (_, i) => ({ id: String(i), text: 'Follow-up', images: [] }));
  parent.queuePaused = true;
  complete(lead, parent, 'Waiting for required evidence.');
  await until(() => !lead.busy);
  complete(helper, child, 'Required helper evidence.');
  await until(() => child.delegation.delivered);
  agents.pump();
  assert.equal(parent.delegation.delivered, false);
  assert.ok(parent.items.find(item => item.type === 'agentResult').pendingReply);
  parent.queue.shift();
  agents.pump();
  assert.equal(parent.delegation.delivered, false);
  assert.equal(parent.queue.filter(message => message.agentReply).length, 1);
});

test('an unavailable owner cannot silently acknowledge or discard a worker result', async t => {
  const { agents, primary, add } = await setup(t);
  const worker = await add('Researcher'), source = agents.conversation(primary, true);
  source.queuePaused = true;
  const chat = agents.conversation(worker, true);
  chat.delegation = { id: randomUUID(), source: source.id, owner: 'missing-owner', state: 'running', startIndex: 0, delivered: false };
  chat.status = 'completed';
  chat.items.push({ id: randomUUID(), type: 'agentMessage', text: 'Retained evidence.' });
  agents.deliver(worker, chat);
  assert.equal(chat.delegation.delivered, false);
  assert.equal(chat.delegation.state, 'delivery-pending');
  assert.match(chat.delegation.deliveryError, /retained for review/);
  assert.equal(agents.pendingJobs().length, 1);
  chat.delegation.owner = source.id;
  agents.pump();
  assert.equal(chat.delegation.delivered, true);
  assert.equal(source.items.find(item => item.type === 'agentResult').text, 'Retained evidence.');
});

test('busy recipients persist FIFO assignments without changing active work or permissions', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), other = await addWorker('Reviewer');
  const source = agents.conversation(primary, true), otherSource = agents.conversation(other, true);
  source.queuePaused = otherSource.queuePaused = true;
  source.access = 'read-only';
  const chat = agents.conversation(worker, true);
  await start(worker, chat);
  const active = { turn: chat.turnId, title: chat.title, access: chat.access };
  const first = agents.delegate(primary, source, worker.agentId, 'First assignment');
  const second = agents.delegate(other, otherSource, worker.agentId, 'Second assignment');
  assert.equal(first.status, 'queued');
  assert.deepEqual({ turn: chat.turnId, title: chat.title, access: chat.access }, active);
  assert.deepEqual(chat.delegationQueue.map(job => job.id), [first.jobId, second.jobId]);
  assert.equal(JSON.parse(fs.readFileSync(worker.filename, 'utf8')).sessions.find(s => s.id === chat.id).delegationQueue.length, 2);
  await assert.rejects(agents.clearConversation(worker.agentId, async () => true), /pending|delegated/);
  assert.throws(() => agents.settings({ access: 'danger-full-access' }, worker.agentId), /Stop/);
  complete(worker, chat, 'Original task');
  await until(() => chat.delegation?.id === first.jobId && !!chat.turnId);
  assert.equal(chat.access, 'read-only');
  complete(worker, chat, 'First result');
  await until(() => chat.delegation?.id === second.jobId && !!chat.turnId);
  assert.equal(chat.access, 'read-only', 'a later assignment cannot escalate permissions');
  complete(worker, chat, 'Second result');
  await until(() => chat.delegation.delivered);
  assert.deepEqual(source.items.filter(item => item.type === 'agentResult').map(item => item.text), ['First result']);
  assert.deepEqual(otherSource.items.filter(item => item.type === 'agentResult').map(item => item.text), ['Second result']);
});

test('queued Stop and failed acceptance leave an unrelated active task intact', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = agents.conversation(primary, true), chat = agents.conversation(worker, true);
  source.queuePaused = true;
  await start(worker, chat);
  const turn = chat.turnId;
  const save = worker.save;
  worker.save = () => { throw new Error('Disk full'); };
  try { assert.throws(() => agents.delegate(primary, source, worker.agentId, 'Unsaved work'), /Disk full/); }
  finally { worker.save = save; }
  assert.equal(chat.delegationQueue?.length || 0, 0);
  assert.equal(source.agentDelegations || 0, 0);
  const job = agents.delegate(primary, source, worker.agentId, 'Queued work');
  await agents.stop(job.jobId);
  assert.equal(chat.turnId, turn);
  assert.equal(worker.busy, chat.id);
  assert.equal(source.items.find(item => item.type === 'agentResult').status, 'cancelled');
  assert.equal(agents.pendingDelegations(source.id), false);
  const next = agents.delegate(primary, source, worker.agentId, 'Next queued assignment');
  complete(worker, chat);
  await until(() => chat.delegation?.id === next.jobId && !!chat.turnId);
  await agents.stop(next.jobId);
  await until(() => chat.delegation.delivered);
  await agents.stop(next.jobId);
  assert.equal(source.items.find(item => item.deliveryId === next.jobId).status, 'cancelled', 'the queued ID still targets the same assignment after promotion');
});

test('a cancelled queued job never starts when delivering its cancellation receipt fails', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = agents.conversation(primary, true), chat = agents.conversation(worker, true);
  source.queuePaused = true;
  await start(worker, chat);
  const job = agents.delegate(primary, source, worker.agentId, 'Never start this');
  const save = primary.save;
  primary.save = () => { throw new Error('Disk full'); };
  try {
    await assert.rejects(agents.stop(job.jobId), /Disk full/);
    assert.equal(JSON.parse(fs.readFileSync(worker.filename, 'utf8')).sessions.find(s => s.id === chat.id).delegationQueue[0].cancelled, true);
    complete(worker, chat);
    await until(() => !worker.busy);
    assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.equal(source.items.filter(item => item.type === 'agentResult').length, 0);
  } finally { primary.save = save; }
  agents.pump();
  assert.equal(source.items.find(item => item.deliveryId === job.jobId).status, 'cancelled');
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('queued dependency cycles and global overflow fail before another acceptance', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const hub = agents.execution('main'); await agents.initializeController(hub);
  const worker = await addWorker('Builder'), source = agents.conversation(hub, true), chat = agents.conversation(worker, true);
  source.queuePaused = true;
  await start(worker, chat);
  agents.delegate(hub, source, worker.agentId, 'First request');
  assert.throws(() => agents.delegate(worker, chat, 'main', 'Cycle back'), /Circular/);
  for (let index = 1; index < 10; index++) {
    source.agentDelegations = 0;
    agents.delegate(hub, source, worker.agentId, `Independent request ${index}`);
  }
  source.agentDelegations = 0;
  assert.throws(() => agents.delegate(hub, source, worker.agentId, 'Overflow'), /queue is full/);
  assert.equal(chat.delegationQueue.length, 10);
  await agents.stop(source.id);
  assert.equal(worker.busy, chat.id, 'stopping the requester cancels queued children, not the recipient’s unrelated task');
  assert.equal(agents.pendingDelegations(source.id), false);
  complete(worker, chat);
});

test('mailbox questions reach a waiting owner, with correlated answers and duplicate suppression', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = agents.conversation(primary, true);
  const job = agents.delegate(primary, source, worker.agentId, 'Build something');
  const chat = worker.session(job.sessionId);
  await until(() => !!chat.turnId);
  const question = await worker.bridgeTool(chat.id, 'agent_message', { agentId: 'main', messageId: 'question-1', kind: 'question', text: 'Which format?' });
  const duplicate = await worker.bridgeTool(chat.id, 'agent_message', { agentId: 'main', messageId: 'question-1', kind: 'question', text: 'Which format?' });
  assert.equal(duplicate.messageId, question.messageId);
  assert.equal(duplicate.duplicate, true);
  assert.equal(source.items.filter(item => item.type === 'agentMail').length, 1);
  assert.equal(JSON.parse(fs.readFileSync(primary.filename, 'utf8')).sessions.find(s => s.id === source.id).items.filter(item => item.type === 'agentMail').length, 1);
  await until(() => !!source.turnId);
  assert.equal(chat.delegation.delivered, false, 'the helper is still working while the owner reads its question');
  const answer = await primary.bridgeTool(source.id, 'agent_message', { agentId: worker.agentId, messageId: 'answer-1', kind: 'answer', replyTo: question.messageId, text: 'Use JSON.' });
  assert.equal(chat.items.find(item => item.id === answer.messageId).replyTo, question.messageId);
  assert.equal(chat.items.find(item => item.id === answer.messageId).jobId, job.jobId);
  assert.equal(chat.queue.filter(message => message.agentMail).length, 1, 'a busy recipient retains the answer without interrupting its turn');
  await assert.rejects(worker.bridgeTool(chat.id, 'agent_message', { agentId: 'main', messageId: 'question-1', text: 'Changed text' }), /different message/);
  complete(primary, source, 'Answered the helper.');
  const firstTurn = chat.turnId;
  complete(worker, chat, 'Need the queued answer');
  await until(() => !!chat.turnId && chat.turnId !== firstTurn);
  assert.equal(chat.delegation.delivered, false);
  source.queuePaused = true;
  complete(worker, chat, 'Built using JSON.');
  await until(() => chat.delegation.delivered);
  assert.equal(source.items.filter(item => item.type === 'agentResult').length, 1);
});

test('a helper whose turn ends on an open question waits for the answer before its job is delivered', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = agents.conversation(primary, true);
  const job = agents.delegate(primary, source, worker.agentId, 'Build something');
  const chat = worker.session(job.sessionId);
  await until(() => !!chat.turnId);
  const question = await worker.bridgeTool(chat.id, 'agent_message', { agentId: 'main', messageId: 'format', kind: 'question', text: 'Which format?' });
  const firstTurn = chat.turnId;
  complete(worker, chat, 'Waiting for the format.');
  await until(() => !!source.turnId);
  assert.equal(chat.delegation.delivered, false, 'the question is still being read');
  await primary.bridgeTool(source.id, 'agent_message', { agentId: worker.agentId, messageId: 'format-answer', kind: 'answer', replyTo: question.messageId, text: 'Use JSON.' });
  source.queuePaused = true;
  complete(primary, source, 'Answered the helper.');
  await until(() => !!chat.turnId && chat.turnId !== firstTurn);
  assert.equal(chat.delegation.delivered, false);
  complete(worker, chat, 'Built using JSON.');
  await until(() => chat.delegation.delivered);
  assert.match(JSON.stringify(source.items.filter(item => item.type === 'agentResult')), /Built using JSON/);
});

test('a question its recipient reads without answering does not hold the job forever', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = agents.conversation(primary, true);
  const job = agents.delegate(primary, source, worker.agentId, 'Build something');
  const chat = worker.session(job.sessionId);
  await until(() => !!chat.turnId);
  await worker.bridgeTool(chat.id, 'agent_message', { agentId: 'main', messageId: 'format', kind: 'question', text: 'Which format?' });
  complete(worker, chat, 'Built with a default format.');
  await until(() => !!source.turnId);
  assert.equal(chat.delegation.delivered, false);
  source.queuePaused = true;
  complete(primary, source, 'No answer needed.');
  await until(() => chat.delegation.delivered);
});

test('a question its owner cannot read, paused or failed, releases the job instead of holding it', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Builder'), source = agents.conversation(primary, true);
  const job = agents.delegate(primary, source, worker.agentId, 'Build something');
  const chat = worker.session(job.sessionId);
  await until(() => !!chat.turnId);
  source.queuePaused = true;
  await worker.bridgeTool(chat.id, 'agent_message', { agentId: 'main', messageId: 'format', kind: 'question', text: 'Which format?' });
  assert.equal(source.queue.length, 1);
  complete(worker, chat, 'Built with a default format.');
  await until(() => chat.delegation.delivered);
  assert.ok(!source.turnId, 'the paused owner never read the question');
});

test('mail retries keep their original receipt when job completion changes the destination context', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const owner = agents.execution('main');
  await agents.initializeController(owner);
  const source = agents.conversation(owner, true), publicChat = agents.conversation(primary, true);
  source.queuePaused = true;
  const worker = await addWorker('Builder');
  const job = agents.delegate(owner, source, worker.agentId, 'Build something');
  const chat = worker.session(job.sessionId);
  await until(() => !!chat.turnId);
  const message = { agentId: 'main', messageId: 'saved-note', text: 'Retain this observation.' };
  const accepted = await worker.bridgeTool(chat.id, 'agent_message', message);
  assert.equal(accepted.sessionId, source.id);
  chat.delegation.delivered = true;
  const retry = await worker.bridgeTool(chat.id, 'agent_message', message);
  assert.equal(retry.duplicate, true);
  assert.equal(retry.sessionId, source.id);
  assert.equal(source.items.filter(item => item.id === accepted.messageId).length, 1);
  assert.equal(publicChat.items.some(item => item.id === accepted.messageId), false);
  await assert.rejects(worker.bridgeTool(chat.id, 'agent_message', { ...message, text: 'Changed text' }), /different message/);
});

test('mailboxes preserve access, reject bad replies and roll back failed saves', async t => {
  const { agents, primary, add } = await setup(t);
  const worker = await add('Builder'), source = agents.conversation(primary, true), chat = agents.conversation(worker, true);
  await start(primary, source);
  chat.queuePaused = true;
  const message = { agentId: worker.agentId, messageId: 'stable', text: 'A note' };
  source.access = 'read-only';
  await assert.rejects(primary.bridgeTool(source.id, 'agent_message', message), /exceeds/);
  source.access = 'workspace-write';
  await assert.rejects(primary.bridgeTool(source.id, 'agent_message', { ...message, kind: 'answer', replyTo: 'unknown' }), /received question/);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_message', { ...message, jobId: 'unknown' }), /pending assignment/);
  const save = worker.save;
  worker.save = () => { throw new Error('Disk full'); };
  try { await assert.rejects(primary.bridgeTool(source.id, 'agent_message', message), /Disk full/); }
  finally { worker.save = save; }
  assert.equal(chat.queue?.length || 0, 0);
  assert.equal(chat.items.filter(item => item.type === 'agentMail').length, 0);
  for (let index = 0; index < 10; index++) {
    source.activeProvider = ['codex', 'claude-cli', 'cursor-cli'][index % 3];
    await primary.bridgeTool(source.id, 'agent_message', { ...message, messageId: `note-${index}` });
  }
  await assert.rejects(primary.bridgeTool(source.id, 'agent_message', { ...message, messageId: 'overflow' }), /coordination limit|mailbox is full/);
  assert.equal(chat.queue.length, 10);
  const other = await add('Other sender'), otherChat = agents.conversation(other, true);
  await start(other, otherChat);
  await assert.rejects(other.bridgeTool(otherChat.id, 'agent_message', { ...message, messageId: 'another-sender' }), /mailbox is full/);
  complete(other, otherChat);
  complete(primary, source);
});

test('direct user follow-ups run before queued coordination messages', async t => {
  const { agents, primary, add } = await setup(t);
  const worker = await add('Builder'), source = agents.conversation(primary, true), chat = agents.conversation(worker, true);
  await start(primary, source);
  await start(worker, chat);
  await worker.bridgeTool(chat.id, 'agent_message', { agentId: 'main', messageId: 'background-note', text: 'A background note.' });
  await primary.send({ id: source.id, text: 'User correction first', mode: 'terra-light', task: 'off' });
  const turn = source.turnId;
  complete(primary, source);
  await until(() => !!source.turnId && source.turnId !== turn);
  assert.match(source.items.filter(item => item.type === 'userMessage').at(-1).content[0].text, /User correction first/);
  assert.equal(source.queue.filter(message => message.agentMail).length, 1);
  const userTurn = source.turnId;
  complete(primary, source);
  await until(() => !!source.turnId && source.turnId !== userTurn);
  assert.match(source.items.filter(item => item.type === 'userMessage').at(-1).content[0].text, /background note/);
  complete(primary, source); complete(worker, chat);
});

test('five Full-access workers in the same workspace start independently and Stop targets one agent', async t => {
  const { agents, primary, add } = await setup(t);
  const workers = [primary];
  for (let i = 0; i < 4; i++) workers.push(await add(`Agent ${i}`));
  const sessions = workers.map(c => c.create(undefined, 'danger-full-access'));
  const starts = Promise.allSettled(workers.map((c, i) => start(c, sessions[i])));
  await until(() => sessions.every(s => !!s.turnId));
  assert.ok((await starts).every(result => result.status === 'fulfilled'));
  assert.equal(new Set(sessions.map(s => s.threadId)).size, 5, 'every worker has its own provider conversation');
  assert.ok(sessions.every(s => !s.waitingForAgent && s.access === 'danger-full-access'));
  await start(workers[0], sessions[0]);
  assert.equal(sessions[0].queue.length, 1, 'messages to the same busy agent still queue');
  assert.ok(sessions.slice(1).every(s => !s.queue?.length), 'other agents do not share that queue');
  sessions[0].queuePaused = true;
  await agents.stop(sessions[2].id);
  await until(() => !workers[2].busy);
  for (let i = 0; i < workers.length; i++) if (i !== 2) {
    assert.equal(workers[i].busy, sessions[i].id, 'Stopping one agent leaves the other agents running');
    complete(workers[i], sessions[i]);
  }
});

test('nested workspaces run independently without reducing permissions', async t => {
  const { agents, primary, add, workspace } = await setup(t);
  const nested = path.join(workspace, 'nested'); fs.mkdirSync(nested);
  const worker = await add('Nested', nested);
  const source = primary.create(), target = worker.create();
  await start(primary, source);
  await start(worker, target);
  assert.ok(target.turnId); assert.equal(target.access, 'workspace-write');
  await agents.stop(target.id);
  await until(() => !worker.busy);
  assert.equal(worker.client.calls.filter(c => c.method === 'turn/start').length, 1);
  assert.ok(primary.busy);
  complete(primary, source);
});

test('Full access does not block an independent worker in another workspace', async t => {
  const { agents, primary, add, directory } = await setup(t);
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  const worker = await add('Other', other);
  const source = primary.create(undefined, 'danger-full-access'), target = worker.create();
  await start(primary, source);
  await start(worker, target);
  assert.ok(source.turnId && target.turnId);
  assert.equal(primary.busy, source.id);
  complete(primary, source);
  complete(worker, target);
});

test('delegation inherits lower permissions and returns once across automatic follow-up requests', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Researcher');
  const source = primary.create(undefined, 'read-only');
  await start(primary, source);
  const turn = source.turnId;
  await primary.helperToolCall({ id: 77, params: { threadId: source.threadId, turnId: turn, tool: 'agent_delegate', arguments: { agentId: worker.agentId, task: 'Find the relevant files.' } } });
  const output = primary.client.responses.find(r => r.id === 77);
  assert.equal(output.result.success, true);
  const { sessionId } = JSON.parse(output.result.contentItems[0].text);
  const child = worker.session(sessionId);
  assert.equal(child.access, 'read-only');
  assert.throws(() => agents.tool(worker, child, 'agent_delegate', { agentId: worker.agentId, task: 'recurse' }), /another|cannot delegate/);
  complete(primary, source); agents.pump();
  await until(() => !!child.turnId);
  complete(worker, child, 'The implementation is in src/example.cjs.');
  await worker.gateDone; agents.pump();
  await until(() => !!source.agentReplyActive && !!source.turnId);
  const replies = primary.client.calls.filter(c => c.method === 'turn/start' && c.params.input[0].text.includes('src/example.cjs'));
  assert.equal(replies.length, 1);
  agents.pump(); assert.equal(source.agentDeliveries.filter(id => id === child.delegation.id).length, 1);
  const followup = agents.tool(primary, source, 'agent_delegate', { agentId: worker.agentId, task: 'Verify the result with this pasted text:\n  const value = 42;\n' });
  assert.equal(followup.sessionId, child.id);
  assert.equal(source.agentDelegations, 2, 'automatic result continuations retain the task request count');
  complete(primary, source);
  await until(() => !!child.turnId);
  source.queuePaused = true;
  complete(worker, child);
});

test('every provider can send pasted text to Main and receive its result', async t => {
  const { agents, primary, add } = await setup(t);
  const requester = await add('Requester', undefined, 'read-only'), source = agents.conversation(requester, true);
  const pasted = 'Review this exact text:\n\n  const value = "<tag>";\n\tkeepIndent();\n';
  for (const provider of ['codex', 'claude-cli', 'cursor-cli']) {
    await start(requester, source);
    source.activeProvider = provider;
    const result = await requester.bridgeTool(source.id, 'agent_delegate', { agentId: 'main', task: pasted });
    assert.equal(result.agent, 'Hub');
    const hub = agents.owner(result.sessionId), target = hub.session(result.sessionId);
    assert.ok(target.delegation.task.endsWith(pasted), 'pasted whitespace and content are preserved');
    assert.match(target.delegation.task, /Task from agent "Requester"/);
    assert.equal(target.access, 'read-only', 'Main keeps the lower permission level');
    source.activeProvider = 'codex';
    complete(requester, source); source.queuePaused = true;
    await until(() => !!target.turnId);
    complete(hub, target, `Reviewed pasted text for ${provider}.`);
    await hub.gateDone; agents.pump();
    assert.match(source.queue[0].text, /Result from agent "Hub"/);
    assert.ok(source.queue[0].text.includes(provider));
    await requester.queuedMessage(source.id, source.queue[0].id, 'remove');
  }
});

test('nested requests wait for child results, reject cycles and return the completed result once', async t => {
  const { agents, primary, add, addWorker } = await setup(t);
  const requester = await add('Requester'), helper = await addWorker('Helper');
  const source = agents.conversation(requester, true);
  await start(requester, source);
  const mainJob = await requester.bridgeTool(source.id, 'agent_delegate', { agentId: 'main', task: 'Check the pasted evidence with Helper.' });
  complete(requester, source);
  const hub = agents.owner(mainJob.sessionId), main = hub.session(mainJob.sessionId);
  await until(() => !!main.turnId);
  const helperJob = await hub.bridgeTool(main.id, 'agent_delegate', { agentId: helper.agentId, task: 'Verify this quoted evidence.' });
  complete(hub, main, 'Asked Helper to verify it.');
  const child = helper.session(helperJob.sessionId);
  await until(() => !!child.turnId);
  assert.equal(main.delegation.delivered, false, 'Main must wait before returning the final result');
  assert.equal(source.queue?.length || 0, 0);
  assert.ok(agents.snapshot().executionStates.main.waitingForAgents.includes(main.id));
  await assert.rejects(helper.bridgeTool(child.id, 'agent_delegate', { agentId: requester.agentId, task: 'Create a cycle' }), /Circular/);
  await assert.rejects(helper.bridgeTool(child.id, 'agent_delegate', { agentId: 'main', task: 'Create a cycle' }), /Circular/);
  await assert.rejects(helper.bridgeTool(child.id, 'agent_delegate', { agentId: helper.agentId, task: 'Self request' }), /another agent/);
  complete(helper, child, 'Verified helper evidence.');
  await until(() => main.agentReplyActive && !!main.turnId);
  assert.equal(main.delegation.delivered, false);
  complete(hub, main, 'Final result incorporating verified helper evidence.');
  await until(() => source.agentReplyActive && !!source.turnId);
  const replies = requester.client.calls.filter(call => call.method === 'turn/start' && call.params.input[0].text.includes('Final result incorporating'));
  assert.equal(replies.length, 1);
  assert.equal(source.agentDeliveries.filter(id => id === main.delegation.id).length, 1);
  source.agentDelegations = 3;
  await assert.rejects(requester.bridgeTool(source.id, 'agent_delegate', { agentId: 'main', task: 'Over budget' }), /already sent three/);
  complete(requester, source);
});

test('stopping a requester cancels its nested tasks without restarting conversations', async t => {
  const { agents, primary, add, addWorker } = await setup(t);
  const requester = await add('Requester'), helper = await addWorker('Helper');
  const source = agents.conversation(requester, true);
  await start(requester, source);
  const mainJob = await requester.bridgeTool(source.id, 'agent_delegate', { agentId: 'main', task: 'Ask Helper for evidence.' });
  complete(requester, source);
  const hub = agents.owner(mainJob.sessionId), main = hub.session(mainJob.sessionId);
  await until(() => !!main.turnId);
  helper.connection = 'disconnected';
  const helperJob = await hub.bridgeTool(main.id, 'agent_delegate', { agentId: helper.agentId, task: 'Inspect evidence.' });
  complete(hub, main);
  const child = helper.session(helperJob.sessionId);
  assert.equal(child.delegation.state, 'queued');
  await agents.stop(source.id);
  await until(() => main.delegation.delivered);
  assert.equal(main.delegation.delivered, true);
  assert.equal(child.delegation.delivered, true);
  assert.equal(main.status, 'interrupted');
  assert.equal(child.status, 'interrupted');
  assert.equal(agents.pendingDelegations(source.id), false);
  for (const [controller, session] of [[requester, source], [hub, main], [helper, child]]) {
    assert.equal(controller.busy, null);
    assert.equal(session.queuePaused, true);
  }
});

test('inactive tools, broader workspaces and shared setting changes are rejected', async t => {
  const { agents, primary, add, directory } = await setup(t);
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  const worker = await add('Other', other);
  const source = primary.create();
  await primary.helperToolCall({ id: 1, params: { threadId: 'inactive', turnId: 'no', tool: 'agent_delegate', arguments: { agentId: worker.agentId, task: 'work' } } });
  assert.match(primary.client.responses[0].error, /inactive/);
  await start(primary, source);
  assert.throws(() => agents.tool(primary, source, 'agent_delegate', { agentId: worker.agentId, task: 'outside' }), /different workspace/);
  assert.throws(() => agents.settings({ routing: 'smart' }), /Stop all/);
  assert.throws(() => agents.tool(primary, source, 'agents_list', { unexpected: true }), /Invalid/);
  complete(primary, source);
});

test('agents search bounded visible context and Main through every provider bridge', async t => {
  const { agents, primary, add, workspace } = await setup(t);
  const worker = await add('Researcher'), target = agents.conversation(worker, true);
  target.items.push(
    { id: 'question', type: 'userMessage', content: [{ type: 'text', text: 'Investigate the renderer.' }, { type: 'image', url: 'PRIVATE_IMAGE_BYTES' }] },
    { id: 'private', type: 'reasoning', text: 'PRIVATE_REASONING' },
    { id: 'answer', type: 'agentMessage', text: 'Renderer evidence: wrong material binding.\n[task: done]' },
    { id: 'tool', type: 'commandExecution', command: 'rg material', aggregatedOutput: 'renderer.cpp:45 material binding', exitCode: 0 },
    { id: 'mcp', type: 'mcpToolCall', server: 'source', tool: 'read', result: { content: [{ type: 'text', text: 'Recorded tool evidence' }] } },
    { id: 'pending', type: 'userMessage', pending: true, content: [{ type: 'text', text: 'PRIVATE_PENDING_MESSAGE' }] },
  );
  target.instructions = 'PRIVATE_INSTRUCTIONS';
  const source = primary.create(workspace, 'read-only');
  await start(primary, source);
  const roster = await primary.bridgeTool(source.id, 'agents_list', {});
  assert.ok(roster.some(agent => agent.id === 'main' && agent.name === 'Hub'));
  const result = await primary.bridgeTool(source.id, 'agent_read_context', { agentId: worker.agentId, query: 'MATERIAL' });
  assert.equal(result.origin.agentId, worker.agentId);
  assert.equal(result.origin.sessionId, target.id);
  assert.equal(result.excerpts.length, 3);
  assert.match(result.excerpts[0].text, /wrong material binding/);
  const full = await primary.bridgeTool(source.id, 'agent_read_context', { agentId: worker.agentId });
  assert.doesNotMatch(JSON.stringify(full), /PRIVATE_|\[task: done\]/);
  assert.match(JSON.stringify(full), /Recorded tool evidence/);
  const lines = await primary.bridgeTool(source.id, 'agent_read_context', { agentId: worker.agentId, line: result.excerpts[0].line });
  assert.equal(lines.excerpts[0].text, result.excerpts[0].text);
  assert.equal(lines.sha256, result.sha256);
  assert.equal(worker.busy, null, 'reading never starts a task on the target');
  await primary.helperToolCall({ id: 180, params: { threadId: source.threadId, turnId: source.turnId, tool: 'agent_read_context', arguments: { agentId: worker.agentId, query: 'Recorded tool' } } });
  assert.equal(primary.client.responses.find(r => r.id === 180).result.success, true);
  target.items.push({ id: 'large', type: 'agentMessage', text: ('evidence '.repeat(400) + '\n').repeat(40) });
  const page = await primary.bridgeTool(source.id, 'agent_read_context', { agentId: worker.agentId, query: 'evidence' });
  assert.ok(page.excerpts.length <= 30);
  assert.ok(page.excerpts.reduce((count, row) => count + row.text.length, 0) <= 8000);
  assert.equal(page.more, true);
  assert.notEqual(page.sha256, result.sha256, 'changed transcripts have a different fingerprint');
  const clipped = page.excerpts.find(row => row.clipped);
  assert.ok(clipped);
  const rest = await primary.bridgeTool(source.id, 'agent_read_context', { agentId: worker.agentId, line: clipped.line, column: 2001 });
  assert.equal(rest.excerpts[0].column, 2001);
  assert.ok(rest.excerpts[0].text.length);
  complete(primary, source, 'Main context evidence.');
  await start(worker, target);
  target.delegation = { delivered: false, state: 'running' };
  for (const provider of ['codex', 'claude-cli', 'cursor-cli']) {
    target.activeProvider = provider;
    const main = await worker.bridgeTool(target.id, 'agent_read_context', { agentId: 'main', query: 'Main context evidence' });
    assert.match(main.excerpts[0].text, /Main context evidence/);
    assert.equal(main.origin.name, 'Hub');
  }
  delete target.delegation; target.activeProvider = 'codex';
  complete(worker, target);
});

test('context reads reject inactive, invalid and broader-access requests without exposing stored files', async t => {
  const { agents, primary, add, directory, workspace } = await setup(t);
  const other = path.join(directory, 'other-context'); fs.mkdirSync(other);
  const worker = await add('Outside', other), target = agents.conversation(worker, true);
  target.items.push({ id: 'outside', type: 'agentMessage', text: 'Outside context' });
  const source = primary.create(workspace, 'read-only'), args = { agentId: worker.agentId };
  await assert.rejects(primary.bridgeTool(source.id, 'agent_read_context', args), /no active turn/);
  await start(primary, source);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_read_context', args), /requires Full access/);
  source.access = 'danger-full-access';
  assert.match(JSON.stringify(await primary.bridgeTool(source.id, 'agent_read_context', args)), /Outside context/);
  source.access = 'read-only'; target.workspace = workspace; target.access = 'danger-full-access';
  await assert.rejects(primary.bridgeTool(source.id, 'agent_read_context', args), /requires Full access/);
  target.access = 'read-only';
  for (const invalid of [{ agentId: '../sessions.json' }, { agentId: '' }, {}, { ...args, path: primary.filename }, { ...args, line: 0 }, { ...args, column: 1.5 }, { ...args, query: '' }, { ...args, query: 'x'.repeat(501) }]) {
    await assert.rejects(primary.bridgeTool(source.id, 'agent_read_context', invalid));
  }
  assert.deepEqual((await primary.bridgeTool(source.id, 'agent_read_context', { ...args, query: 'no matching evidence' })).excerpts, []);
  const empty = await add('Empty');
  assert.equal((await primary.bridgeTool(source.id, 'agent_read_context', { agentId: empty.agentId })).origin.sessionId, null);
  assert.equal(empty.data.sessions.length, 0, 'reading an empty agent does not create a conversation');
  await agents.deleteAgent(worker.agentId);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_read_context', args), /Unknown agent/);
  complete(primary, source);
  await assert.rejects(primary.bridgeTool(source.id, 'agent_read_context', { agentId: 'main' }), /no active turn/);
});

test('restarting legacy delegated work requires review instead of resending it', async t => {
  const { agents, primary, addWorker, factory, workspace } = await setup(t);
  const worker = await addWorker('Researcher');
  const source = primary.create();
  worker.connection = 'disconnected';
  const { sessionId } = agents.delegate(primary, source, worker.agentId, 'Inspect files');
  const queued = agents.delegate(primary, source, worker.agentId, 'Later work');
  worker.save(); primary.save();
  const restoredRoot = factory(primary.filename, workspace);
  const restored = new Agents(restoredRoot, async () => {}, factory);
  const session = restored.owner(sessionId).session(sessionId);
  assert.equal(session.delegation.state, 'interrupted');
  assert.equal(session.delegation.delivered, false, 'the owner must still see unresolved work');
  assert.equal(session.delegation.recovery.kind, 'not-started');
  assert.match(session.error, /restart/);
  assert.equal(restored.owner(sessionId).client.calls.length, 0);
  assert.equal(session.delegationQueue[0].id, queued.jobId);
  assert.equal(session.delegationQueue[0].state, 'interrupted');
  assert.equal(session.delegationQueue[0].recovery.kind, 'not-started');
  assert.match(session.delegationQueue[0].error, /restarted/);
  restored.pump();
  assert.equal(restored.owner(sessionId).client.calls.length, 0, 'restart does not silently replay queued assignments');
  assert.ok(restored.snapshot().agentStates.main.waitingForAgents.includes(source.id));
  assert.equal(JSON.parse(fs.readFileSync(worker.filename)).sessions.find(s => s.id === sessionId).delegation.delivered, false);
  for (const c of restored.allControllers()) c.close();
});

test('contained restart resumes never-submitted assignments once and retains their queue order', async t => {
  const { agents, primary, addWorker, factory, workspace } = await setup(t);
  primary.runnerRecoverySafe = true;
  const worker = await addWorker('Researcher'), source = primary.create();
  worker.connection = 'disconnected';
  const first = agents.delegate(primary, source, worker.agentId, 'First inspection');
  const second = agents.delegate(primary, source, worker.agentId, 'Second inspection');
  const root = factory(primary.filename, workspace);
  root.runnerRecoverySafe = true;
  const restored = new Agents(root, async () => {}, factory);
  t.after(() => { restored.closing = true; for (const c of restored.allControllers()) c.close(); });
  const target = restored.owner(first.sessionId), chat = target.session(first.sessionId);
  assert.equal(chat.delegation.state, 'queued');
  assert.equal(chat.delegation.recovery.resumed, true);
  assert.equal(target.client.calls.length, 0, 'recovery persists before provider initialization');
  await root.initialize();
  await restored.initialize();
  await until(() => target.activeTurns.has(chat.id));
  assert.equal(chat.delegation.id, first.jobId);
  assert.equal(chat.delegation.executionAttempts, 1);
  assert.equal(target.client.calls.filter(call => call.method === 'turn/start').length, 1);
  complete(target, chat);
  await until(() => chat.delegation.id === second.jobId && target.activeTurns.has(chat.id));
  assert.equal(target.client.calls.filter(call => call.method === 'turn/start').length, 2);
  assert.equal(chat.delegation.executionAttempts, 1);
});

test('a job still waiting for a background slot at a crash resumes once; admitted or older records stay held', async t => {
  for (const variant of ['tracked', 'legacy', 'admitted']) {
    const { agents, primary, addWorker, factory, workspace } = await setup(t);
    primary.runnerRecoverySafe = true;
    const source = primary.create();
    const workers = [await addWorker('First'), await addWorker('Second'), await addWorker('Third')];
    const accepted = workers.map((worker, index) => agents.delegate(primary, source, worker.agentId, `Inspection ${index + 1}`));
    const chats = workers.map((worker, index) => worker.session(accepted[index].sessionId));
    await until(() => workers[0].activeTurns.has(chats[0].id) && workers[1].activeTurns.has(chats[1].id) && chats[2].capacityWaiting);
    assert.ok(chats[0].delegation.admittedAt && chats[1].delegation.admittedAt, 'admission is saved before the provider call');
    assert.equal(chats[2].delegation.admittedAt, undefined, 'a job waiting for a slot has not been admitted');
    assert.equal(chats[2].delegation.state, 'running');
    if (variant === 'legacy') delete chats[2].delegation.admissionTracked;
    if (variant === 'admitted') chats[2].delegation.admittedAt = Date.now();
    for (const worker of workers) worker.save();

    // The crash: a new runner reads the same stores while the old one is gone.
    const root = factory(primary.filename, workspace);
    root.runnerRecoverySafe = true;
    const restored = new Agents(root, async () => {}, factory);
    t.after(() => { restored.closing = true; for (const c of restored.allControllers()) c.close(); });
    const job = index => restored.owner(chats[index].id).session(chats[index].id).delegation;
    for (const index of [0, 1]) {
      assert.equal(job(index).state, 'interrupted', `${variant}: an admitted job is never replayed`);
      assert.equal(job(index).recovery.kind, 'uncertain');
    }
    if (variant !== 'tracked') {
      assert.equal(job(2).state, 'interrupted', `${variant}: stays held for review`);
      assert.equal(job(2).recovery.kind, 'uncertain');
      continue;
    }

    const target = restored.owner(chats[2].id), chat = target.session(chats[2].id);
    assert.equal(chat.delegation.state, 'queued');
    assert.equal(chat.delegation.recovery.resumed, true);
    assert.equal(chat.delegation.executionAttempts, 0);
    assert.equal(chat.status, 'idle');
    assert.equal((chat.tasks || []).filter(task => task.assignmentId === chat.delegation.id).length, 0, 'the unchecked start leaves no stale task');
    await root.initialize();
    await restored.initialize();
    await until(() => target.activeTurns.has(chat.id));
    assert.equal(target.client.calls.filter(call => call.method === 'turn/start').length, 1);
    assert.ok(chat.delegation.admittedAt);
    complete(target, chat);
    const owner = restored.owner(source.id).session(source.id);
    await until(() => chat.delegation.delivered);
    assert.equal(owner.items.filter(item => item.type === 'agentResult' && item.deliveryId === accepted[2].jobId).length, 1, 'delivered once');
  }
});

test('restart refuses attempted, paused or permission-changed assignments even with containment', async t => {
  for (const reason of ['attempted', 'paused', 'permissions', 'owner permissions', 'parent revision', 'workspace', 'uncontained']) {
    const { agents, primary, addWorker, factory, workspace } = await setup(t);
    primary.runnerRecoverySafe = true;
    const worker = await addWorker('Researcher'), source = primary.create();
    worker.connection = 'disconnected';
    const accepted = agents.delegate(primary, source, worker.agentId, 'Inspect files');
    const chat = worker.session(accepted.sessionId);
    if (reason === 'attempted') chat.delegation.executionAttempts = 1;
    if (reason === 'paused') source.queuePaused = true;
    if (reason === 'permissions') source.access = 'read-only';
    if (reason === 'owner permissions') {
      const reviewer = await addWorker('Reviewer', workspace, 'read-only');
      chat.delegation.owner = agents.conversation(reviewer, true).id;
    }
    if (reason === 'parent revision') {
      source.delegation = { id: 'parent-assignment', revision: 2, delivered: true };
      chat.delegation.ancestorJobIds = ['parent-assignment'];
      chat.delegation.parentRevision = 1;
    }
    if (reason === 'workspace') chat.delegation.recoveryWorkspace = workspace + '-different';
    worker.save(); primary.save();
    const root = factory(primary.filename, workspace);
    root.runnerRecoverySafe = reason !== 'uncontained';
    const restored = new Agents(root, async () => {}, factory);
    t.after(() => { restored.closing = true; for (const c of restored.allControllers()) c.close(); });
    const target = restored.owner(chat.id);
    assert.equal(target.session(chat.id).delegation.state, 'interrupted', reason);
    await root.initialize(); await restored.initialize();
    assert.equal(target.client.calls.filter(call => call.method === 'turn/start').length, 0, reason);
  }
});

test('an interrupted assignment cannot resume automatically through a late result receipt', async t => {
  const { agents, primary, addWorker, factory, workspace } = await setup(t);
  primary.runnerRecoverySafe = true;
  const worker = await addWorker('Researcher'), source = primary.create();
  const accepted = agents.delegate(primary, source, worker.agentId, 'Inspect files');
  const chat = worker.session(accepted.sessionId);
  await until(() => worker.activeTurns.has(chat.id));
  worker.save(); primary.save();
  const root = factory(primary.filename, workspace);
  root.runnerRecoverySafe = true;
  const restored = new Agents(root, async () => {}, factory);
  t.after(() => { restored.closing = true; for (const c of restored.allControllers()) c.close(); });
  const target = restored.owner(chat.id), recovered = target.session(chat.id);
  assert.equal(recovered.queuePaused, true);
  recovered.queue = [{ id: 'late-result', text: 'A child finished.', images: [], agentReply: true, agentAssignmentId: accepted.jobId }];
  await root.initialize(); await restored.initialize();
  target.settle(recovered);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(target.client.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.equal(recovered.delegation.delivered, false);
});

test('work a restart interrupted mid-run returns to its owner only by the user decision and never runs again', async t => {
  const { agents, primary, addWorker, factory, workspace } = await setup(t);
  primary.runnerRecoverySafe = true;
  const worker = await addWorker('Researcher'), source = primary.create();
  const accepted = agents.delegate(primary, source, worker.agentId, 'Inspect files');
  const chat = worker.session(accepted.sessionId);
  await until(() => worker.activeTurns.has(chat.id));
  worker.save(); primary.save();
  const root = factory(primary.filename, workspace);
  root.runnerRecoverySafe = true;
  const restored = new Agents(root, async () => {}, factory);
  t.after(() => { restored.closing = true; for (const c of restored.allControllers()) c.close(); });
  await root.initialize(); await restored.initialize();
  const target = restored.owner(chat.id), job = target.session(chat.id).delegation;
  assert.deepEqual([job.state, job.recovery.kind], ['interrupted', 'uncertain']);
  restored.pump();
  assert.equal(root.session(source.id).items.some(item => item.deliveryId === accepted.jobId), false, 'without a decision the owner never hears back');
  assert.throws(() => restored.reconcileJob({ jobId: accepted.jobId, action: 'start' }), /may already have run/);
  const save = root.save.bind(root);
  root.save = () => { throw new Error('Owner store unavailable'); };
  assert.throws(() => restored.reconcileJob({ jobId: accepted.jobId, action: 'return' }), /Owner store unavailable/);
  root.save = save;
  assert.deepEqual([job.state, job.delivered, job.recovery.decision], ['interrupted', false, undefined], 'a failed delivery keeps the job held');
  assert.equal(root.session(source.id).items.some(item => item.deliveryId === accepted.jobId), false);
  assert.deepEqual(restored.reconcileJob({ jobId: accepted.jobId, action: 'return' }), { jobId: accepted.jobId, status: 'interrupted' });
  const results = root.session(source.id).items.filter(item => item.deliveryId === accepted.jobId);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'interrupted');
  assert.match(results[0].error, /not run again.*inspect its workspace/);
  const saved = JSON.parse(fs.readFileSync(target.filename)).sessions.find(s => s.id === chat.id).delegation;
  assert.deepEqual([saved.delivered, saved.recovery.decision.action], [true, 'return']);
  assert.throws(() => restored.reconcileJob({ jobId: accepted.jobId, action: 'return' }), /already returned|Unknown assignment/);
  assert.equal(target.client.calls.filter(call => call.method === 'turn/start').length, 0, 'nothing was run again');
});

test('a Return whose worker save fails after the owner saved the result is delivered once after another restart', async t => {
  const { agents, primary, addWorker, factory, workspace } = await setup(t);
  primary.runnerRecoverySafe = true;
  const worker = await addWorker('Researcher'), source = primary.create();
  const accepted = agents.delegate(primary, source, worker.agentId, 'Inspect files');
  await until(() => worker.activeTurns.has(accepted.sessionId));
  worker.save(); primary.save();
  const restart = async () => {
    const root = factory(primary.filename, workspace);
    root.runnerRecoverySafe = true;
    const restored = new Agents(root, async () => {}, factory);
    t.after(() => { restored.closing = true; for (const c of restored.allControllers()) c.close(); });
    await root.initialize(); await restored.initialize();
    return { root, restored, target: restored.owner(accepted.sessionId) };
  };
  const first = await restart();
  first.target.save = () => { throw new Error('Worker store unavailable'); };
  assert.throws(() => first.restored.reconcileJob({ jobId: accepted.jobId, action: 'return' }), /Worker store unavailable/);
  first.restored.closing = true;
  const second = await restart();
  first.target.save = () => {}; // the crashed instance never writes again
  const job = second.target.session(accepted.sessionId).delegation;
  assert.deepEqual([job.state, job.delivered], ['interrupted', false], 'the worker store still holds the job');
  second.restored.reconcileJob({ jobId: accepted.jobId, action: 'return' });
  assert.equal(job.delivered, true);
  assert.equal(second.root.session(source.id).items.filter(item => item.deliveryId === accepted.jobId).length, 1, 'no second result');
});

test('a never-started assignment held after restart starts once on the user decision, after a failed save leaves it held', async t => {
  const { agents, primary, addWorker, factory, workspace } = await setup(t);
  primary.runnerRecoverySafe = true;
  const worker = await addWorker('Researcher'), source = primary.create();
  worker.connection = 'disconnected';
  const accepted = agents.delegate(primary, source, worker.agentId, 'Inspect files');
  const blocked = agents.delegate(primary, source, worker.agentId, 'Later inspection');
  source.queuePaused = true; // an owner pause holds queued work at restart
  worker.save(); primary.save();
  const root = factory(primary.filename, workspace);
  root.runnerRecoverySafe = true;
  const restored = new Agents(root, async () => {}, factory);
  t.after(() => { restored.closing = true; for (const c of restored.allControllers()) c.close(); });
  await root.initialize(); await restored.initialize();
  const target = restored.owner(accepted.sessionId), chat = target.session(accepted.sessionId), job = chat.delegation;
  assert.deepEqual([job.state, job.recovery.kind], ['interrupted', 'not-started']);
  assert.throws(() => restored.reconcileJob({ jobId: blocked.jobId, action: 'start' }), /earlier assignment/);
  const save = target.save.bind(target);
  target.save = () => { throw new Error('Worker store unavailable'); };
  assert.throws(() => restored.reconcileJob({ jobId: accepted.jobId, action: 'start' }), /Worker store unavailable/);
  target.save = save;
  assert.deepEqual([job.state, chat.queuePaused, job.recovery.resumed], ['interrupted', true, undefined]);
  assert.equal(target.client.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.deepEqual(restored.reconcileJob({ jobId: accepted.jobId, action: 'start' }), { jobId: accepted.jobId, status: 'queued' });
  assert.equal(JSON.parse(fs.readFileSync(target.filename)).sessions.find(s => s.id === chat.id).delegation.recovery.decision.action, 'start');
  await until(() => target.activeTurns.has(chat.id));
  assert.equal(target.client.calls.filter(call => call.method === 'turn/start').length, 1);
  assert.equal(job.executionAttempts, 1);
  assert.throws(() => restored.reconcileJob({ jobId: accepted.jobId, action: 'start' }), /held after a restart/);
  complete(target, chat);
  await until(() => job.delivered);
  restored.pump();
  assert.equal(chat.delegationQueue.find(entry => entry.id === blocked.jobId).state, 'interrupted', 'the second held job waits for its own decision');
  assert.equal(target.client.calls.filter(call => call.method === 'turn/start').length, 1);
  restored.reconcileJob({ jobId: blocked.jobId, action: 'start' });
  await until(() => chat.delegation.id === blocked.jobId && target.activeTurns.has(chat.id));
  assert.equal(target.client.calls.filter(call => call.method === 'turn/start').length, 2);
});

test('a second restart after resumed work started records that run as uncertain', async t => {
  const { agents, primary, addWorker, factory, workspace } = await setup(t);
  primary.runnerRecoverySafe = true;
  const worker = await addWorker('Researcher'), source = primary.create();
  worker.connection = 'disconnected';
  const accepted = agents.delegate(primary, source, worker.agentId, 'Inspect files');
  const restart = async () => {
    const root = factory(primary.filename, workspace);
    root.runnerRecoverySafe = true;
    const restored = new Agents(root, async () => {}, factory);
    t.after(() => { restored.closing = true; for (const c of restored.allControllers()) c.close(); });
    await root.initialize(); await restored.initialize();
    const target = restored.owner(accepted.sessionId);
    return { restored, target, job: target.session(accepted.sessionId).delegation };
  };
  const first = await restart();
  assert.equal(first.job.recovery.resumed, true);
  await until(() => first.target.activeTurns.has(accepted.sessionId));
  first.target.save();
  first.restored.closing = true;
  const second = await restart();
  assert.deepEqual([second.job.state, second.job.recovery.kind, second.job.recovery.resumed], ['interrupted', 'uncertain', undefined]);
  assert.throws(() => second.restored.reconcileJob({ jobId: accepted.jobId, action: 'start' }), /may already have run/);
});

test('a durable Stop intent prevents resurrection when the crash precedes child-store cancellation', async t => {
  const { agents, primary, addWorker, factory, workspace } = await setup(t);
  primary.runnerRecoverySafe = true;
  const worker = await addWorker('Researcher'), source = primary.create();
  worker.connection = 'disconnected';
  const accepted = agents.delegate(primary, source, worker.agentId, 'Inspect files');
  const save = primary.save.bind(primary);
  let saves = 0;
  primary.save = () => { if (++saves > 1) throw new Error('Crash before child cancellation'); return save(); };
  await assert.rejects(agents.stop(source.id), /Crash before child cancellation/);
  assert.ok(JSON.parse(fs.readFileSync(primary.filename)).cancelledAgentJobs.includes(accepted.jobId));
  assert.equal(JSON.parse(fs.readFileSync(worker.filename)).sessions.find(s => s.id === accepted.sessionId).delegation.cancelled, undefined);
  primary.save = save;
  const root = factory(primary.filename, workspace);
  root.runnerRecoverySafe = true;
  assert.equal(root.session(source.id).queuePaused, undefined, 'the crash happened before the source pause was saved');
  const restored = new Agents(root, async () => {}, factory);
  t.after(() => { restored.closing = true; for (const c of restored.allControllers()) c.close(); });
  const target = restored.owner(accepted.sessionId), chat = target.session(accepted.sessionId);
  assert.equal(chat.delegation.cancelled, true);
  await root.initialize(); await restored.initialize();
  assert.equal(target.client.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.equal(chat.delegation.delivered, true);
  assert.equal(root.session(source.id).items.find(item => item.deliveryId === accepted.jobId).status, 'cancelled');
});

test('Stop interrupts every active descendant even when its cancellation record cannot be saved', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const first = await addWorker('First'), second = await addWorker('Second'), source = primary.create();
  await start(primary, source);
  agents.delegate(primary, source, first.agentId, 'Inspect one area');
  agents.delegate(primary, source, second.agentId, 'Inspect another area');
  await until(() => first.activeTurns.size && second.activeTurns.size);
  const save = primary.save.bind(primary);
  let failed = false;
  primary.save = () => { if (!failed) { failed = true; throw new Error('Cancellation storage unavailable'); } return save(); };
  await assert.rejects(agents.stop(source.id), /Cancellation storage unavailable/);
  for (const controller of [primary, first, second]) {
    assert.ok(controller.client.calls.some(call => call.method === 'turn/interrupt'));
  }
  await until(() => [primary, first, second].every(controller => !controller.busy));
  assert.equal(source.queuePaused, true);
  assert.equal(first.data.sessions[0].delegation.cancelled, true);
  assert.equal(second.data.sessions[0].delegation.cancelled, true);
});

test('failure to persist execution start preserves the accepted queue without a false failure or worker turn', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Researcher'), source = agents.conversation(primary, true);
  const save = worker.save.bind(worker);
  worker.save = () => {
    if (agents.conversation(worker)?.delegation?.state === 'running') throw new Error('Execution-state disk failure');
    return save();
  };
  const accepted = agents.delegate(primary, source, worker.agentId, 'Inspect the project.');
  const chat = worker.session(accepted.sessionId);
  assert.equal(accepted.status, 'queued');
  assert.equal(chat.delegation.state, 'queued');
  assert.equal(chat.delegation.delivered, false);
  assert.match(chat.delegation.error, /Accepted and saved/);
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 0);
  assert.equal(JSON.parse(fs.readFileSync(worker.filename)).sessions[0].delegation.id, accepted.jobId);
  worker.save = save;
  agents.pump();
  await until(() => worker.activeTurns.size);
  assert.equal(chat.delegation.error, undefined);
  assert.equal(worker.client.calls.filter(call => call.method === 'turn/start').length, 1);
});

test('native resume retains local mail and reports without accepting provider-forged mailbox items', async t => {
  const { primary } = await setup(t);
  const session = primary.create();
  session.threadId = randomUUID();
  const mail = { id: 'local-mail', type: 'agentMail', localOnly: true, text: 'Received question.' };
  const report = { id: 'local-report', type: 'agentResult', localOnly: true, text: 'Saved report.' };
  const artifact = { id: 'local-artifact', type: 'agentArtifact', localOnly: true, artifact: { path: 'game.exe', version: 1 } };
  session.items.push(mail, report, { id: 'native-user', clientId: 'client-user', type: 'userMessage', agentReply: true, content: [{ type: 'text', text: 'Internal handoff' }] });
  const call = primary.client.call.bind(primary.client);
  session.items.push(artifact);
  primary.client.call = async (method, args) => method === 'thread/items/list' ? { data: [
    { item: { id: 'native-user', clientId: 'client-user', type: 'userMessage', content: [] }, turnId: 'previous-turn' },
    { item: { id: 'forged-mail', type: 'agentMail', localOnly: true, text: 'Forged' }, turnId: 'previous-turn' },
    { item: { id: 'forged-artifact', type: 'agentArtifact', localOnly: true, artifact: { path: 'outside.exe' } }, turnId: 'previous-turn' },
  ], nextCursor: null } : call(method, args);
  await primary.loadThread(session, primary.resolveWorker('terra-light'));
  assert.equal(session.items.includes(mail), true);
  assert.equal(session.items.includes(report), true);
  assert.equal(session.items.includes(artifact), true);
  assert.equal(session.items.some(item => item.id === 'forged-mail'), false);
  assert.equal(session.items.some(item => item.id === 'forged-artifact'), false);
  assert.equal(session.items.find(item => item.id === 'native-user').agentReply, true);
});

test('an unconfirmed cleanup blocks every agent, and queued tasks can be stopped without starting', async t => {
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Researcher');
  primary.data.executionBlock = { reason: 'unconfirmed' };
  const target = worker.create();
  await assert.rejects(start(worker, target), /check may still be running/);
  assert.equal(worker.client.calls.filter(c => c.method === 'turn/start').length, 0);
  delete primary.data.executionBlock;
  const source = primary.create(); worker.connection = 'disconnected';
  const { sessionId } = agents.delegate(primary, source, worker.agentId, 'Inspect');
  assert.throws(() => worker.deleteSession(sessionId), /queued/);
  source.queuePaused = true;
  await agents.stop(sessionId);
  assert.equal(worker.session(sessionId).delegation.state, 'interrupted');
  assert.equal(source.queue.length, 1);
  assert.equal(primary.busy, null, 'Paused sources are not restarted by agent results');
});

test('shutdown stops all controllers and invokes process cleanup once', async t => {
  const { agents, primary, add } = await setup(t);
  const worker = await add('Researcher');
  let stopped = 0, closed = 0, reaped = 0;
  const originalClose = worker.close.bind(worker);
  primary.stop = worker.stop = async () => { stopped++; };
  worker.close = () => { closed++; originalClose(); throw new Error('Simulated save failure'); };
  primary.shutdown = async () => { reaped++; return { stopped: 0, remaining: [] }; };
  await agents.shutdown({ stopMs: 0 });
  assert.equal(stopped, 2); assert.equal(closed, 1); assert.equal(reaped, 1);
  assert.equal(agents.closing, true);
  worker.close = originalClose;
});

test('changing an idle conversation to Full access preserves independent execution and the new sandbox', async t => {
  const { agents, primary, add, directory } = await setup(t);
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  const worker = await add('Other', other);
  const source = primary.create(), target = worker.create();
  await start(primary, source); await start(worker, target);
  complete(primary, source);
  primary.permissions(source.id, 'danger-full-access');
  await start(primary, source);
  assert.equal(primary.client.calls.filter(c => c.method === 'turn/start').length, 2);
  assert.equal(primary.client.calls.filter(c => c.method === 'turn/start').at(-1).params.sandboxPolicy.type, 'dangerFullAccess');
  assert.equal(worker.busy, target.id);
  complete(worker, target);
  complete(primary, source);
});

test('a result waits while its source agent works in another conversation', async t => {
  const { agents, primary, addWorker, directory } = await setup(t);
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  const worker = await addWorker('Other', other);
  const source = primary.create(undefined, 'danger-full-access'), unrelated = primary.create();
  const { sessionId } = agents.delegate(primary, source, worker.agentId, 'Inspect your project');
  const child = worker.session(sessionId);
  await until(() => !!child.turnId);
  await start(primary, unrelated);
  complete(worker, child, 'Delegated result.'); await worker.gateDone; agents.pump();
  assert.equal(source.queue.length, 1);
  assert.equal(primary.busy, unrelated.id);
  complete(primary, unrelated); agents.pump();
  await until(() => primary.busy === source.id && !!source.turnId);
  assert.equal(source.agentReplyActive, true);
  complete(primary, source);
});

test('Jev plug state persists, keeps preferences and keys, and stops calls across agents', async t => {
  const { agents, primary, add } = await setup(t);
  const child = await add('Jev worker');
  const { JevClient } = require('../src/providers/jev.cjs');
  let reads = 0, requests = 0;
  const key = { configured: true, read() { reads++; return 'test-key'; } };
  for (const c of [primary, child]) c.smartRouter.jev = new JevClient(key, async () => { requests++; throw new Error('stub transport'); }, () => primary.data.settings.jevEnabled !== false);
  Object.assign(primary.data.settings, { routing: 'jev', contextRanking: 'jev', toolSelection: 'jev', jevCompare: true, wikiAssessment: true });
  assert.throws(() => agents.settings({ jevEnabled: 'false' }), /Invalid Jev enabled/);
  agents.settings({ jevEnabled: false }, child.agentId);
  assert.equal(JSON.parse(fs.readFileSync(primary.filename, 'utf8')).settings.jevEnabled, false);
  assert.equal(primary.snapshot().jev.keySaved, true);
  assert.equal(primary.snapshot().jev.configured, false);
  assert.equal(primary.routingProvider, 'smart');
  assert.equal(child.routingProvider, 'smart');
  for (const c of [primary, child]) await assert.rejects(c.smartRouter.jev.test(), /Jev is disabled/);
  assert.equal(reads, 0); assert.equal(requests, 0);
  assert.equal(key.configured, true);
  child.busy = 'working';
  assert.throws(() => agents.settings({ jevEnabled: true }), /Stop all agents/);
  child.busy = null;
  agents.settings({ jevEnabled: true });
  assert.equal(primary.routingProvider, 'jev');
  assert.equal(child.smartRouter.jev.configured, true);
  assert.deepEqual(['contextRanking', 'toolSelection', 'jevCompare', 'wikiAssessment'].map(k => primary.data.settings[k]), ['jev', 'jev', true, true]);
  await assert.rejects(child.smartRouter.jev.test(), /transport error/);
  assert.equal(reads, 1); assert.equal(requests, 1);
});

nodeTest('Stop ends the commands a Codex turn started, spares the app-server and its helpers, and holds unconfirmed cleanup', { timeout: 60000 }, async t => {
  const processTree = require('../src/process-tree.cjs');
  const { spawn } = require('node:child_process');
  const { agents, primary, addWorker } = await setup(t);
  const worker = await addWorker('Command runner'), source = primary.create(); source.queuePaused = true;
  // Stands in for the worker's Codex app-server: it starts one helper at once (like an MCP server) and one long-lived
  // command per input line, printing each pid.
  const script = "const { spawn } = require('child_process'); const run = () => console.log(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }).pid); run(); require('readline').createInterface({ input: process.stdin }).on('line', run);";
  const server = processTree.spawnOwned(spawn, process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'ignore'] });
  const pids = [];
  server.stdout.setEncoding('utf8');
  server.stdout.on('data', data => pids.push(...data.split(/\s+/).filter(Boolean).map(Number)));
  const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
  const wait = async check => { for (let i = 0; i < 400 && !check(); i++) await new Promise(resolve => setTimeout(resolve, 50)); assert.ok(check()); };
  const { runAsync, procTable } = processTree.scan;
  t.after(() => {
    Object.assign(processTree.scan, { runAsync, procTable });
    for (const pid of [...pids, server.pid]) try { process.kill(pid); } catch { /* gone */ }
  });
  await wait(() => pids.length === 1);
  const helper = pids[0];
  // Keep the pre-existing helper outside the process scanner's 50 ms turn-start tolerance.
  await new Promise(resolve => setTimeout(resolve, 100));
  worker.client.process = server;
  const runCommand = async (session, processId) => {
    server.stdin.write('run\n');
    const count = pids.length;
    await wait(() => pids.length === count + 1);
    worker.notification({ method: 'item/started', params: { threadId: session.threadId, turnId: session.turnId,
      item: { id: randomUUID(), type: 'commandExecution', command: 'node wait.cjs', cwd: session.workspace, processId, source: 'unifiedExecStartup', status: 'inProgress' } } });
    return pids.at(-1);
  };

  const first = agents.delegate(primary, source, worker.agentId, 'Run the long command.');
  const work = worker.session(first.sessionId);
  await wait(() => worker.activeTurns.has(work.id));
  const command = await runCommand(work, '46789');
  assert.ok(alive(command));
  await agents.stop(first.jobId);
  await wait(() => !worker.cleanupPending.size);
  assert.ok(worker.client.calls.some(call => call.method === 'thread/backgroundTerminals/terminate' && call.params.processId === '46789' && call.params.threadId === work.threadId));
  assert.equal(alive(command), false, 'the stopped turn left its command running');
  assert.ok(alive(helper) && alive(server.pid), 'only the turn\'s command is stopped, never the app-server or what it started earlier');
  assert.equal(worker.data.workerCleanup, undefined);
  assert.equal(worker.blockedReason(), null);
  await wait(() => source.items.find(item => item.deliveryId === first.jobId)?.status === 'cancelled');

  // When the processes cannot be checked, the cleanup is unconfirmed and new execution stays blocked.
  const second = agents.delegate(primary, source, worker.agentId, 'Run it again.');
  const again = worker.session(second.sessionId);
  await wait(() => worker.activeTurns.has(again.id));
  const survivor = await runCommand(again, '46790');
  processTree.scan.runAsync = async () => ({ error: new Error('Get-CimInstance failed') });
  processTree.scan.procTable = () => { throw new Error('/proc unavailable'); };
  await agents.stop(second.jobId);
  await wait(() => !worker.cleanupPending.size);
  assert.equal(worker.data.workerCleanup?.length, 1);
  assert.match(worker.blockedReason(), /could not be confirmed stopped/);
  assert.ok(alive(survivor) && alive(helper) && alive(server.pid));
  assert.deepEqual(worker.data.workerCleanup[0].roots, [], 'a retry never reaches the app-server');

  // The retry finds the same turn's command from the saved anchor once the list can be read, and only then confirms.
  Object.assign(processTree.scan, { runAsync, procTable });
  await worker.retryCleanupNow();
  assert.equal(alive(survivor), false, 'a retry confirmed the cleanup while the command still ran');
  assert.equal(worker.data.workerCleanup, undefined);
  assert.equal(worker.blockedReason(), null);
  assert.ok(alive(helper) && alive(server.pid));
});


test('agents can check app updates but cannot supply installation consent', async t => {
  const { agents, primary } = await setup(t);
  let checks = 0;
  agents.checkUpdate = async () => { checks++; return { confirmationRequired: true }; };
  const session = { access: 'read-only' };
  assert.deepEqual(await agents.tool(primary, session, 'harness_check_update', {}), { confirmationRequired: true });
  assert.throws(() => agents.tool(primary, session, 'harness_check_update', { confirmed: true }), /no arguments/);
  assert.equal(checks, 1);
  assert.ok(MCP_TOOLS.some(tool => tool.name === 'harness_check_update'));
});

test('turning reply suggestions on reaches a bot that is mid-turn', async t => {
  const { agents, add } = await setup(t);
  const bot = await add('Writer');
  bot.busy = bot.create().id;
  agents.settings({ replySuggestions: true }, 'main');
  bot.busy = null;
  assert.equal(bot.data.settings.replySuggestions, true, 'the bot asks for a suggestion as soon as its turn ends');
});
