const { test: nodeTest } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { Controller } = require('../src/controller.cjs');
const { Agents } = require('../src/agents.cjs');
const { REUSE_TOKENS, evaluateSwap, evaluateReach, evaluateHubSwap, difficultyScore, fit, required, contextTokens, countTask, recordDecision, COOLDOWN, DECLINED } = require('../src/routing/model-swap.cjs');
const test = (name, run) => nodeTest(name, { timeout: 15000 }, run);

const SCORES = { weak: 50, mid: 80, cheap: 65, strong: 100 };
const COSTS = { weak: 0.1, cheap: 0.3, mid: 1, strong: 3 };
const preset = (model, effort, provider = 'codex') => ({ id: `${provider}:${model}:${effort}`, provider, model, effort, label: `${model} · ${effort}`,
  worker: true, enabled: true, images: true, rank: 1 });
const catalog = ['weak', 'mid', 'cheap', 'strong'].flatMap(model => ['low', 'medium', 'high', 'xhigh'].map(effort => preset(model, effort)));
const measured = list => list.map(p => ({ ...p, benchmarks: SCORES[p.model] == null ? [] : [{ source: 'aa-index', version: '4', harness: 'aa', score: SCORES[p.model], costUsd: COSTS[p.model] }] }));
const assessment = (difficulty, more = {}) => ({ difficulty, taskKind: 'implementation', workspaceRelevant: false, needsChecks: false, risk: 'low', uncertainty: 'low', ...more });
const pick = (id, difficulty, more) => ({ ...catalog.find(p => p.id === id), reason: 'router reason', assessment: assessment(difficulty, more), source: 'model', router: { evidence: { changedFiles: 0 } } });
const chat = (model, chars = 0, provider = 'codex') => ({ routes: [{ id: `${provider}:${model}:medium`, provider, model, effort: 'medium' }],
  items: chars ? [{ type: 'agentMessage', text: 'x'.repeat(chars) }] : [] });

test('the difficulty score follows the router difficulty, nudged by kind, risk, uncertainty and changed files', () => {
  assert.equal(difficultyScore(assessment('low', { taskKind: 'general' })), 11);
  assert.equal(difficultyScore(assessment('medium', { taskKind: 'review' })), 40);
  assert.equal(difficultyScore(assessment('high')), 72);
  // Nudges stay inside their band: critical risk, high uncertainty, an audit and 30 changed files add at most 10.
  assert.equal(difficultyScore(assessment('xhigh', { taskKind: 'audit', risk: 'critical', uncertainty: 'high', workspaceRelevant: true }), { changedFiles: 30 }), 100);
  assert.equal(difficultyScore(assessment('high', { workspaceRelevant: true }), { changedFiles: 12 }), 74, 'changed files count only for workspace work');
  assert.equal(difficultyScore(assessment('high', { workspaceRelevant: false }), { changedFiles: 12 }), 72);
  // The capability a task needs matches the router's adequate shares at low and medium.
  assert.equal(Math.round(required(15)), 62);
  assert.equal(Math.round(required(40)), 73);
  // A too-weak model loses fit four times faster than a too-strong one gains waste.
  assert.equal(fit(50, 90), 9);
  assert.equal(fit(100, 15), 81);
  assert.equal(fit(null, 50), null, 'an unmeasured model has no fit, not zero');
});

test('the switching cost counts the conversation since the last compaction', () => {
  assert.equal(contextTokens([{ type: 'userMessage', content: [{ type: 'text', text: 'a'.repeat(4000) }] }, { type: 'commandExecution', command: 'b'.repeat(400), aggregatedOutput: 'c'.repeat(3600) }]), 2000);
  assert.equal(contextTokens([{ type: 'agentMessage', text: 'a'.repeat(40000) }, { type: 'contextCompaction' }, { type: 'agentMessage', text: 'b'.repeat(400) }]), 100);
  assert.equal(contextTokens([{ type: 'notice', text: 'a'.repeat(4000) }, { type: 'toolStep', title: 'x', text: 'b'.repeat(4000) }]), 0, 'Harness notes are not model context');
  // A tool call's arguments and output are context too (12 + 3,988 characters).
  assert.equal(contextTokens([{ type: 'mcpToolCall', tool: 'Read', arguments: { path: 'a' }, result: 'r'.repeat(3988) }]), 1000);
});

test('Auto keeps the current model unless the suggestion fits better by a margin that grows with the conversation', () => {
  const available = measured(catalog);
  // No model yet, or the router picks the same model: nothing to decide.
  assert.equal(evaluateSwap({ selected: pick('codex:strong:high', 'high'), session: { routes: [], items: [] }, available }), null);
  assert.equal(evaluateSwap({ selected: pick('codex:cheap:low', 'low'), session: chat('cheap'), available }), null);
  // The current model is no longer offered (disabled, cap, usage limit): the router's pick runs.
  assert.equal(evaluateSwap({ selected: pick('codex:strong:high', 'high'), session: chat('gone'), available }), null);

  // A hard task on a weak model: a wide gain, so Auto asks.
  const hard = evaluateSwap({ selected: pick('codex:strong:high', 'high'), session: chat('weak', 4000), available });
  assert.equal(hard.propose, true);
  assert.equal(hard.current.id, 'codex:weak:high', 'the current model at the effort this difficulty needs');
  assert.deepEqual({ difficulty: hard.decision.difficulty, current: hard.decision.current.fit, suggested: hard.decision.suggested.fit, gain: hard.decision.gain, margin: hard.decision.margin },
    { difficulty: 72, current: 25, suggested: 94, gain: 69, margin: 16 });
  assert.match(hard.decision.reason, /^strong · high fits this task better by 69 points, over the 16-point margin/);

  // A moderately weaker model: the same gain is enough in a short chat but not in a long one, or across providers.
  const xhigh = pick('codex:strong:xhigh', 'xhigh');
  const short = evaluateSwap({ selected: xhigh, session: chat('mid', 4000), available });
  assert.equal(short.decision.difficulty, 92); assert.equal(short.decision.gain, 31); assert.equal(short.decision.margin, 16); assert.equal(short.propose, true);
  const long = evaluateSwap({ selected: xhigh, session: chat('mid', 120000), available });
  assert.equal(long.decision.margin, 15 + 25, 'context costs at most 25 points'); assert.equal(long.propose, false);
  assert.match(long.decision.reason, /^Kept mid · xhigh: strong · xhigh would fit this task better by 31, under the 40-point margin/);
  const other = evaluateSwap({ selected: xhigh, session: chat('mid', 40000, 'claude-cli'), available: measured([...catalog, preset('mid', 'xhigh', 'claude-cli')]) });
  assert.equal(other.decision.context.crossProvider, true); assert.equal(other.decision.margin, 15 + 10 + 8);
  assert.equal(other.propose, false);
  assert.equal(other.keep.id, 'claude-cli:mid:xhigh', 'without a swap the current model and provider run');

  // An easy task on a strong model: the router keeps it (adequate), and its own pick only wins in a near-empty chat.
  const easy = pick('codex:strong:low', 'low', { taskKind: 'lookup' });
  const fresh = evaluateSwap({ selected: easy, session: chat('strong'), available });
  assert.equal(fresh.suggested.id, 'codex:cheap:low', 'the router\'s pick for this task alone');
  assert.equal(fresh.decision.gain, 18); assert.equal(fresh.propose, true);
  const busy = evaluateSwap({ selected: easy, session: chat('strong', 16000), available });
  assert.equal(busy.propose, false); assert.equal(busy.keep.id, easy.id, 'the router\'s own choice (the current model) runs');
  // 2026-11-01 review: a setup the project's checks proved (smart-router.cjs provenChoice) is the router's final choice;
  // a raw pick ignoring it was offered against a card that did not match what Keep ran.
  assert.equal(evaluateSwap({ selected: { ...easy, proven: true }, session: chat('strong'), available }), null);

  // No measured score for the current model: Auto does not swap it.
  const unmeasured = evaluateSwap({ selected: pick('codex:strong:high', 'high'), session: chat('mystery'), available: measured([...catalog, preset('mystery', 'high')]) });
  assert.equal(unmeasured.decision.gain, null); assert.equal(unmeasured.propose, false);
  assert.match(unmeasured.decision.reason, /no measured score/);
});

test('after a swap decision Auto waits, and after Keep current it does not ask again for similar tasks', () => {
  const available = measured(catalog), now = Date.now();
  const session = chat('weak', 4000), hard = pick('codex:strong:high', 'high');
  recordDecision(session, 'swapped', evaluateSwap({ selected: hard, session, available, now }), now);
  for (let task = 0; task < COOLDOWN.tasks; task++) {
    const blocked = evaluateSwap({ selected: hard, session, available, now });
    assert.equal(blocked.propose, false, `cooldown task ${task + 1}`);
    assert.equal(blocked.decision.cooldown.kind, 'swapped');
    assert.match(blocked.decision.reason, /but Auto swapped models recently/);
    countTask(session);
  }
  assert.equal(evaluateSwap({ selected: hard, session, available, now }).propose, true, 'the cooldown ends after its tasks');
  recordDecision(session, 'swapped', evaluateSwap({ selected: hard, session, available, now }), now);
  assert.equal(evaluateSwap({ selected: hard, session, available, now: now + COOLDOWN.ms }).propose, true, '…or after its time');

  // Keep current: no question for similar tasks to the same model until 10 tasks or 2 hours pass.
  recordDecision(session, 'declined', evaluateSwap({ selected: hard, session, available, now }), now);
  for (let task = 0; task < COOLDOWN.tasks; task++) countTask(session);
  const similar = evaluateSwap({ selected: hard, session, available, now });
  assert.equal(similar.propose, false); assert.equal(similar.decision.cooldown.kind, 'similar');
  assert.equal(evaluateSwap({ selected: pick('codex:strong:xhigh', 'xhigh', { taskKind: 'audit', risk: 'critical' }), session, available, now }).propose, true,
    'a task more than 15 points harder is not similar');
  assert.equal(evaluateSwap({ selected: hard, session, available, now: now + DECLINED.ms }).propose, true);
  for (let task = COOLDOWN.tasks; task < DECLINED.tasks; task++) countTask(session);
  assert.equal(evaluateSwap({ selected: hard, session, available, now }).propose, true);

  // An unanswered question only starts the short cooldown.
  recordDecision(session, 'expired', evaluateSwap({ selected: hard, session, available, now }), now);
  for (let task = 0; task < COOLDOWN.tasks; task++) countTask(session);
  assert.equal(evaluateSwap({ selected: hard, session, available, now }).propose, true);
});

test('a task Hub rates outside an Auto worker\'s reach, too hard or more than it needs, is measured against a new worker\'s model', () => {
  const available = measured(catalog);
  // A hard task on a weak model: a new Auto worker would get the strongest model.
  const hard = evaluateReach({ level: 'high', session: chat('weak'), available });
  assert.equal(hard.outside, true);
  assert.deepEqual([hard.current.id, hard.suggested.id], ['codex:weak:high', 'codex:strong:high']);
  assert.deepEqual({ difficulty: hard.decision.difficulty, current: hard.decision.current.fit, suggested: hard.decision.suggested.fit, gain: hard.decision.gain, margin: hard.decision.margin, direction: hard.decision.direction },
    { difficulty: 70, current: 27, suggested: 93, gain: 66, margin: 15, direction: 'hard' });
  assert.equal(hard.decision.reason, 'This high task (difficulty 70) is beyond weak · high: strong · high fits it better by 66, over the 15-point margin.');

  // An easy task on the strongest model: the cheapest adequate one fits better, unless the worker's conversation outweighs it.
  const easy = evaluateReach({ level: 'low', session: chat('strong'), available });
  assert.equal(easy.outside, true); assert.equal(easy.suggested.id, 'codex:cheap:low');
  assert.equal(easy.decision.reason, 'strong · low is more than this low task (difficulty 15) needs: cheap · low fits it better by 17, over the 15-point margin.');
  const long = evaluateReach({ level: 'low', session: chat('strong', 16000), available });
  assert.equal(long.outside, false); assert.equal(long.decision.margin, 19);
  assert.match(long.decision.reason, /^Within strong · low's reach: cheap · low would fit this low task \(difficulty 15\) better by only 17, under the 19-point margin\.$/);
  // A new worker starts empty on any provider, so only the conversation counts.
  const other = evaluateReach({ level: 'high', session: chat('weak', 4000, 'claude-cli'), available: measured([...catalog, preset('weak', 'high', 'claude-cli')]) });
  assert.equal(other.decision.context.crossProvider, false); assert.equal(other.decision.margin, 16);

  // A model the project's checks proved for some kind of work stays for low and medium work, whose kind Hub does not say.
  assert.equal(evaluateReach({ level: 'low', session: chat('strong'), available, proven: ['codex:strong:medium'] }), null);
  assert.equal(evaluateReach({ level: 'high', session: chat('weak'), available, proven: ['codex:weak:medium'] }).outside, true, 'hard work has no proven setup');

  // Nothing to compare: no model yet, the same model, a model no longer offered, the model for simple messages, no rating.
  assert.equal(evaluateReach({ level: 'high', session: { routes: [], items: [] }, available }), null);
  assert.equal(evaluateReach({ level: 'high', session: chat('strong'), available }), null);
  assert.equal(evaluateReach({ level: 'high', session: chat('gone'), available }), null);
  assert.equal(evaluateReach({ level: 'low', session: chat('strong'), available, autoLowModel: 'codex:mid:low' }), null);
  assert.equal(evaluateReach({ level: 'extreme', session: chat('weak'), available }), null);
});

test('Hub\'s own model: its rating of a request against a fresh pick among its Low and Medium models, with the base margin', () => {
  const available = measured(catalog.filter(p => ['low', 'medium'].includes(p.effort)));
  const at = id => available.find(p => p.id === id);
  const hard = evaluateHubSwap({ current: at('codex:weak:medium'), level: 'high', available });
  assert.deepEqual([hard.propose, hard.suggested.id, hard.decision.gain, hard.decision.margin, hard.decision.hub], [true, 'codex:strong:medium', 66, 15, true]);
  assert.equal(hard.decision.reason, 'strong · medium fits requests like this (high, difficulty 70) better by 66 points, over the 15-point margin.');
  const easy = evaluateHubSwap({ current: at('codex:strong:medium'), level: 'low', available });
  assert.deepEqual([easy.propose, easy.suggested.id, easy.decision.gain], [true, 'codex:cheap:low', 17]);
  // A near model stays: mid fits a high request within the margin.
  const near = evaluateHubSwap({ current: at('codex:mid:medium'), level: 'high', available });
  assert.deepEqual([near.propose, near.decision.gain], [false, 6]);
  assert.match(near.decision.reason, /^Kept mid · medium: strong · medium would fit requests like this \(high, difficulty 70\) better by 6, under the 15-point margin\.$/);
  // The cooldowns are a bot's.
  const holder = {};
  recordDecision(holder, 'declined', hard);
  const state = holder.modelSwapState;
  assert.deepEqual([evaluateHubSwap({ current: at('codex:weak:medium'), level: 'high', available, state }).propose,
    evaluateHubSwap({ current: at('codex:weak:medium'), level: 'high', available, state }).decision.cooldown.kind], [false, 'declined']);
  // Nothing to decide: the same model, no rating, a model no longer offered.
  assert.equal(evaluateHubSwap({ current: at('codex:mid:medium'), level: 'medium', available }), null);
  assert.equal(evaluateHubSwap({ current: at('codex:weak:medium'), level: null, available }), null);
  assert.equal(evaluateHubSwap({ current: preset('gone', 'medium'), level: 'high', available }), null);
});

class Fake extends EventEmitter {
  constructor() { super(); this.calls = []; }
  async start() {}
  async call(method, params) {
    this.calls.push({ method, params });
    if (method === 'account/read') return { account: { type: 'chatgpt', planType: 'pro' } };
    if (method === 'model/list') return { data: [{ model: 'gpt-5.6-terra', supportedReasoningEfforts: [{ reasoningEffort: 'low' }] }] };
    if (method === 'thread/start' || method === 'thread/resume') return { thread: { id: params.threadId || randomUUID() } };
    if (method === 'thread/items/list') return { data: [], nextCursor: null };
    if (method === 'turn/start') return { turn: { id: randomUUID() } };
    return {};
  }
  respond() {}
  rejectRequest() {}
  close() {}
}

async function until(check) {
  for (let i = 0; i < 200; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.ok(check(), 'Condition did not become true within two seconds');
}

async function setup(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-swap-'));
  const workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  const factory = (file, cwd, options) => {
    const c = new Controller(file, cwd, new Fake(), { cancel() {}, close() {}, async choose() { throw new Error('Unexpected model routing'); } }, options);
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
  const profile = await agents.saveAgent({ name: 'Auto bot', workspace, access: 'workspace-write', mode: 'auto', instructions: 'Role: test' });
  const bot = agents.controller(profile.id);
  await agents.initializeController(bot);
  bot.catalog = () => catalog;
  bot.available = () => true;
  bot.effectiveRouter = () => ({ id: 'router', provider: 'codex', model: 'router', effort: 'low' });
  bot.smartRouter.benchmarks = { catalog: measured, summary: () => null };
  const picks = [];
  bot.smartRouter.choose = async () => picks.shift();
  const session = agents.conversation(bot, true);
  const turns = () => bot.client.calls.filter(call => call.method === 'turn/start').map(call => call.params.model);
  const complete = () => {
    bot.notification({ method: 'item/completed', params: { threadId: session.threadId, turnId: session.turnId, item: { id: randomUUID(), type: 'agentMessage', phase: 'final_answer', text: 'Done.' } } });
    bot.notification({ method: 'turn/completed', params: { threadId: session.threadId, turn: { id: session.turnId, status: 'completed' } } });
  };
  const send = text => bot.send({ id: session.id, text, mode: 'auto', task: 'off' });
  // The bot's first task runs on the router's pick without a question.
  picks.push(pick('codex:weak:medium', 'medium'));
  await send('Start the work');
  assert.equal(session.pendingMessage, null);
  complete(); await until(() => !bot.busy);
  return { agents, bot, session, picks, turns, complete, send };
}

test('a swap the score supports waits for Swap before the task starts, without blocking the queue', async t => {
  const { bot, session, picks, turns, complete, send } = await setup(t);
  picks.push(pick('codex:strong:high', 'high'));
  const sending = send('Now the hard part');
  await until(() => session.pendingMessage?.modelSwap);
  const question = session.pendingMessage.modelSwap;
  assert.equal(question.status, 'pending');
  assert.equal(question.current.label, 'weak · high'); assert.equal(question.suggested.label, 'strong · high');
  assert.ok(question.gain >= question.margin && question.difficulty === 72 && question.context.tokens > 0);
  assert.ok(question.expiresAt > Date.now());
  assert.deepEqual(turns(), ['weak'], 'nothing starts while the question is open');
  // Messages sent meanwhile queue as during any turn.
  picks.push(pick('codex:strong:high', 'high'));
  assert.deepEqual(await send('And then this'), { queued: true });
  assert.throws(() => bot.answerModelSwap(session.id, 'other-question', 'swap'), /no longer open/);
  assert.throws(() => bot.answerModelSwap(session.id, question.id, 'maybe'), /Create a new bot, Swap here or Keep current/);
  bot.answerModelSwap(session.id, question.id, 'swap');
  await sending;
  assert.deepEqual(turns(), ['weak', 'strong']);
  const route = session.routes.at(-1);
  assert.equal(route.id, 'codex:strong:high');
  assert.equal(route.modelSwap.outcome, 'swapped'); assert.equal(route.modelSwap.choice, 'you chose Swap here');
  assert.match(route.reason, /^strong · high fits this task better by \d+ points, over the \d+-point margin for switching\. \(you chose Swap here\) router reason$/);
  assert.equal(session.modelSwapState.last.kind, 'swapped');
  assert.equal(session.pendingMessage, null);
  // The queued message runs on the new model; the router's pick is that model, so nothing is asked.
  complete();
  await until(() => turns().length === 3);
  assert.deepEqual(turns(), ['weak', 'strong', 'strong']);
  assert.equal(session.routes.at(-1).modelSwap, undefined);
  complete(); await until(() => !bot.busy);
});

test('Keep current runs the current model, and an unanswered question keeps it too, then cools down', async t => {
  const { bot, session, picks, turns, complete, send } = await setup(t);
  picks.push(pick('codex:strong:high', 'high'));
  const kept = send('Hard task one');
  await until(() => session.pendingMessage?.modelSwap);
  bot.answerModelSwap(session.id, session.pendingMessage.modelSwap.id, 'keep');
  await kept;
  assert.deepEqual(turns(), ['weak', 'weak']);
  assert.equal(session.routes.at(-1).id, 'codex:weak:high', 'the current model at the effort the task needs');
  assert.equal(session.routes.at(-1).routerPick, 'codex:strong:high');
  assert.equal(session.routes.at(-1).benchmarks[0].score, 50, 'the route carries the kept model\'s own measurements');
  assert.equal(session.routes.at(-1).modelSwap.outcome, 'declined');
  assert.equal(session.modelSwapState.last.kind, 'declined');
  complete(); await until(() => !bot.busy);

  // Within the cooldown Auto keeps the model without asking, and says why.
  // The default effort cap (high) offers no xhigh presets, so the router picks within it.
  picks.push(pick('codex:strong:high', 'xhigh', { taskKind: 'audit', risk: 'critical' }));
  await send('A different hard task');
  assert.equal(session.routes.at(-1).id, 'codex:weak:high');
  assert.equal(session.routes.at(-1).modelSwap.outcome, 'kept');
  assert.equal(session.routes.at(-1).modelSwap.cooldown.kind, 'declined');
  complete(); await until(() => !bot.busy);

  // After the cooldown, an unanswered question keeps the current model.
  session.modelSwapState.last.tasks = 3;
  bot.modelSwapPromptMs = 20;
  picks.push(pick('codex:strong:high', 'xhigh', { taskKind: 'audit', risk: 'critical' }));
  await send('Another hard task');
  assert.deepEqual(turns(), ['weak', 'weak', 'weak', 'weak']);
  assert.equal(session.routes.at(-1).modelSwap.outcome, 'expired');
  assert.equal(session.routes.at(-1).modelSwap.choice, 'no answer, so the current model stays');
  assert.equal(session.modelSwapState.last.kind, 'expired');
  complete(); await until(() => !bot.busy);
});

test('Stop during a swap question stops the turn before anything is sent, and the bot takes new work', async t => {
  const { bot, session, picks, turns, complete, send } = await setup(t);
  picks.push(pick('codex:strong:high', 'high'));
  const stopped = send('Hard task');
  await until(() => session.pendingMessage?.modelSwap);
  await bot.stop();
  await assert.rejects(stopped, /Turn was stopped before sending/);
  assert.equal(bot.busy, null);
  assert.equal(bot.swapPrompts.size, 0);
  assert.deepEqual(turns(), ['weak']);
  assert.equal(session.modelSwapState, undefined, 'a stop is not a decision');
  assert.equal(session.status, 'interrupted');

  // Group replies and returning results never pause to ask: the current model runs.
  const route = await bot.modelSwapChoice(session, { ...pick('codex:strong:high', 'high'), proven: true }, catalog, false);
  assert.equal(route.id, 'codex:weak:high');
  assert.equal(route.modelSwap.outcome, 'unasked');
  assert.equal(route.proven, undefined, 'the kept model is not the proven setup the router picked');
  // The router's choice of user-picked or continued-task workers is not second-guessed.
  for (const choice of [{ ...pick('codex:strong:high', 'high'), sameTask: true }, { ...pick('codex:strong:high', 'high'), userPick: true }])
    assert.equal((await bot.modelSwapChoice(session, choice, catalog, true)).id, 'codex:strong:high');

  // The bot takes new work: the next question opens and is answered.
  picks.push(pick('codex:strong:high', 'high'));
  const next = send('Hard task again');
  await until(() => session.pendingMessage?.modelSwap);
  bot.answerModelSwap(session.id, session.pendingMessage.modelSwap.id, 'keep');
  await next;
  assert.deepEqual(turns(), ['weak', 'weak']);
  complete(); await until(() => !bot.busy);

  // 2026-11-01 review: a lost connection cleared busy but left the question open, so a later answer started a turn the
  // chat no longer counted as running. It now ends the question like Stop.
  delete session.modelSwapState; // past the cooldown of Keep current above
  picks.push(pick('codex:strong:high', 'high'));
  const lost = send('Hard task once more');
  await until(() => session.pendingMessage?.modelSwap);
  const late = session.pendingMessage.modelSwap.id;
  bot.client.emit('disconnected', new Error('app-server exited'));
  await assert.rejects(lost, /stopped before sending/);
  assert.deepEqual([bot.swapPrompts.size, bot.busy], [0, null]);
  assert.throws(() => bot.answerModelSwap(session.id, late, 'swap'), /no longer open/);
  assert.deepEqual(turns(), ['weak', 'weak'], 'nothing was sent');
});

test('a bot\'s rated agent_delegate sends a task outside an Auto bot\'s reach to its own idle bot like it, or a new one under it', async t => {
  const { agents, bot } = await setup(t);
  agents.pump = () => {}; // the jobs stay queued: this checks where they go
  const workspace = agents.profile(bot.agentId).workspace;
  // Hub's and bots' tasks run in the target's background conversation: there it is on the weak model.
  const background = agents.execution(bot.agentId);
  await Promise.all(agents.initializing.values());
  background.autoCatalog = () => measured(catalog);
  agents.conversation(background, true, workspace, 'workspace-write').routes = [{ id: 'codex:weak:medium', provider: 'codex', model: 'weak', effort: 'medium' }];
  const leadProfile = await agents.saveAgent({ name: 'Lead', workspace, access: 'danger-full-access', mode: 'terra-light', instructions: 'Lead.' });
  const lead = agents.controller(leadProfile.id);
  await agents.initializeController(lead);
  const chat = agents.conversation(lead, true, workspace, 'danger-full-access');
  const send = args => agents.tool(lead, chat, 'agent_delegate', { agentId: bot.agentId, task: 'Audit the session handling.', ...args });

  await assert.rejects(send({ difficulty: 'extreme' }), /low, medium, high or xhigh/);
  // 2026-11-01 SwapLab's review: a task delegate then refused left the new worker behind. The checks now come first.
  const count = agents.primary.data.agents.length;
  await assert.rejects(send({ difficulty: 'high', task: ' ' }), /under 16,000 characters/);
  chat.agentDelegations = 3;
  await assert.rejects(send({ difficulty: 'high' }), /already sent three agent tasks/);
  chat.agentDelegations = 0;
  assert.equal(agents.primary.data.agents.length, count, 'no worker was created');
  // Too hard for the weak model: a new Auto bot under Lead, with the target's role and its lower access, takes it.
  const first = await send({ difficulty: 'high' });
  const created = agents.primary.data.agents.find(profile => profile.name === 'Auto bot 2');
  assert.deepEqual([first.agent, first.reach.from, first.reach.created, first.reach.direction], ['Auto bot 2', 'Auto bot', true, 'hard']);
  assert.deepEqual([created.createdBy, created.mode, created.instructions, created.access], [lead.agentId, 'auto', 'Role: test', 'workspace-write']);
  assert.match(first.reach.reason, /^This high task \(difficulty 70\) is beyond weak · high: strong · high fits it better by 66/);

  // Another bot's sub-bot is not Lead's to use; Lead's own idle one like the target is.
  const other = await agents.saveAgent({ name: 'Other lead', workspace, access: 'workspace-write', mode: 'auto', instructions: 'Other.' });
  await agents.saveAgent({ name: 'Theirs', workspace, access: 'workspace-write', mode: 'auto', instructions: 'Role: test', createdBy: other.id });
  // 2026-11-01 review: one of Lead's whose background conversation, where the task would run, is in another project was
  // picked by its bot's workspace. It is passed over.
  const elsewhere = await agents.saveAgent({ name: 'Elsewhere', workspace, access: 'workspace-write', mode: 'auto', instructions: 'Role: test', createdBy: lead.agentId });
  const away = agents.execution(elsewhere.id);
  await Promise.all(agents.initializing.values());
  const otherProject = path.join(path.dirname(workspace), 'other'); fs.mkdirSync(otherProject, { recursive: true });
  agents.conversation(away, true, otherProject, 'workspace-write');
  // 2026-11-01 live test: a redirect reused a worker whose long session cost $1.38 to continue for a one-word task. Long
  // fits (the strongest model) but holds a session past REUSE_TOKENS, mostly tool output.
  const long = await agents.saveAgent({ name: 'Long', workspace, access: 'workspace-write', mode: 'auto', instructions: 'Role: test', createdBy: lead.agentId });
  const longWork = agents.execution(long.id);
  await Promise.all(agents.initializing.values());
  longWork.autoCatalog = () => measured(catalog);
  const longChat = agents.conversation(longWork, true, workspace, 'workspace-write');
  longChat.routes = [{ id: 'codex:strong:medium', provider: 'codex', model: 'strong', effort: 'medium' }];
  longChat.items.push({ type: 'mcpToolCall', tool: 'Read', arguments: { path: 'src/agents.cjs' }, result: 'x'.repeat(4 * (REUSE_TOKENS + 1000)) });
  const mine = await agents.saveAgent({ name: 'Mine', workspace, access: 'workspace-write', mode: 'auto', instructions: 'Role: test', createdBy: lead.agentId });

  // 2026-11-01 ReachLab's audit: the redirect ran before delegate's refusals, so a task delegate refuses was redirected to
  // a copy of its target, or left a new worker behind. delegate's own checks now come first.
  const refuse = async (sender, senderChat, agentId, pattern) => {
    const before = agents.primary.data.agents.length;
    await assert.rejects(agents.tool(sender, senderChat, 'agent_delegate', { agentId, task: 'Audit it.', difficulty: 'high' }), pattern);
    assert.equal(agents.primary.data.agents.length, before, `no new worker for ${pattern}`);
  };
  await refuse(bot, agents.conversation(bot), bot.agentId, /Choose another agent/); // itself, though its background model is weak
  const theirs = agents.primary.data.agents.find(profile => profile.name === 'Theirs');
  const theirWork = agents.execution(theirs.id);
  await Promise.all(agents.initializing.values());
  theirWork.autoCatalog = () => measured(catalog);
  agents.conversation(theirWork, true, workspace, 'workspace-write').routes = [{ id: 'codex:weak:medium', provider: 'codex', model: 'weak', effort: 'medium' }];
  await refuse(lead, chat, theirs.id, /works for the bot that made it/); // another bot's sub-bot
  chat.delegation = { id: randomUUID(), delivered: false, ancestors: [bot.agentId], source: chat.id, revision: 1 };
  await refuse(lead, chat, bot.agentId, /Circular agent task chains/); // up its own chain
  delete chat.delegation;
  const forSession = agents.budgets.forSession.bind(agents.budgets);
  agents.budgets.forSession = () => ({ state: 'paused' });
  await refuse(lead, chat, bot.agentId, /paused at its time budget/);
  agents.budgets.forSession = forSession;
  const second = await send({ difficulty: 'high' });
  assert.deepEqual([second.agent, second.reach.created], ['Mine', false]);
  assert.equal(agents.conversation(agents.executions.get(mine.id)).delegation.source, chat.id, 'Mine has the task, not Long, listed first');
  // With Mine busy, Long is still passed over: a new worker costs less than its session.
  const fourth = await send({ difficulty: 'high' });
  assert.deepEqual([fourth.agent, fourth.reach.created], ['Auto bot 3', true]);
  chat.agentDelegations = 0; // a request sends at most three; the next one is a new request's

  // Without a rating the task goes where it was sent.
  const third = await send({});
  assert.equal(third.agent, 'Auto bot'); assert.equal(third.reach, undefined);
});

test('an unsure Jev assessment gets the smart router\'s second opinion, whose choice stands', async t => {
  const { bot, session, turns, complete, send } = await setup(t);
  bot.data.settings.routing = 'jev';
  const calls = [];
  let jev;
  bot.smartRouter.choose = async (text, context, models, provider) => {
    calls.push(provider);
    return provider === 'jev' ? jev : { ...pick('codex:strong:high', 'high', { taskKind: 'audit' }), source: 'model' };
  };
  // 2026-11-01: Jev rated security audits "lookup, low" at confidence 0.13, so the model for simple messages ran them.
  jev = { ...pick('codex:weak:low', 'low', { taskKind: 'lookup' }), source: 'jev', router: { confidence: 0.13 } };
  const sending = send('Audit the session handling for permission leaks');
  await until(() => session.pendingMessage?.modelSwap);
  assert.deepEqual(calls, ['jev', 'smart']);
  bot.answerModelSwap(session.id, session.pendingMessage.modelSwap.id, 'keep');
  await sending;
  const route = session.routes.at(-1);
  assert.deepEqual([route.jevOpinion.confidence, route.jevOpinion.assessment.difficulty, route.assessment.difficulty], [0.13, 'low', 'high']);
  assert.match(route.reason, /Jev was unsure \(confidence 0\.13, low difficulty\); the smart router assessed this message\. router reason$/);
  complete(); await until(() => !bot.busy);

  // A sure Jev is not second-guessed.
  calls.length = 0;
  jev = { ...pick('codex:weak:medium', 'medium'), source: 'jev', router: { confidence: 0.9 } };
  await send('Explain the queue');
  assert.deepEqual(calls, ['jev']); assert.equal(session.routes.at(-1).jevOpinion, undefined);
  complete(); await until(() => !bot.busy);

  // A failed second opinion leaves Jev's choice.
  calls.length = 0;
  jev = { ...pick('codex:weak:low', 'low'), source: 'jev', router: { confidence: 0.2 } };
  bot.smartRouter.choose = async (text, context, models, provider) => { calls.push(provider); if (provider !== 'jev') throw new Error('Router offline.'); return jev; };
  await send('List the files');
  assert.deepEqual([calls, session.routes.at(-1).id, session.routes.at(-1).jevOpinion], [['jev', 'smart'], 'codex:weak:low', undefined]);
  assert.deepEqual(turns(), ['weak', 'weak', 'weak', 'weak']);
  complete(); await until(() => !bot.busy);
});

test('Create a new bot makes a top-level bot on the suggested model, and this bot keeps its time and asks again', async t => {
  const { agents, bot, session, picks, turns, send } = await setup(t);
  agents.pump = () => {}; // the new bot's job stays queued: this checks the hand-off
  const resolve = agents.primary.resolveWorker.bind(agents.primary);
  agents.primary.resolveWorker = id => catalog.find(p => p.id === id) || resolve(id);
  agents.primary.available = () => true;
  picks.push(pick('codex:strong:high', 'high'));
  const sending = send('Audit the session handling');
  await until(() => session.pendingMessage?.modelSwap);
  const question = session.pendingMessage.modelSwap.id;
  const before = { updated: session.updated, routes: session.routes.length };
  bot.answerModelSwap(session.id, question, 'subbot');
  await sending;

  assert.deepEqual(turns(), ['weak'], 'this bot sent nothing');
  const helper = agents.primary.data.agents.find(profile => profile.name === 'Auto bot helper');
  assert.deepEqual([helper.createdBy, helper.mode, helper.instructions], ['main', 'codex:strong:high', 'Role: test']);
  assert.equal(agents.isSubBot(helper), false, 'the new bot is not a sub-bot');
  const job = agents.conversation(agents.executions.get(helper.id)).delegation;
  assert.equal(job.source, session.id); assert.match(job.task, /Audit the session handling/);
  const [message, note] = session.items.slice(-2);
  assert.deepEqual([message.type, message.content[0].text, message.pending], ['userMessage', 'Audit the session handling', false]);
  assert.equal(note.text, 'Sent this task to the new bot **Auto bot helper**, which runs strong · high. This bot keeps weak · high and its conversation; the new bot’s result comes back here.');
  assert.deepEqual([note.modelSwap.outcome, note.modelSwap.choice, note.modelSwap.status, note.modelSwap.subBot.name], ['delegated', 'you chose Create a new bot', 'answered', 'Auto bot helper']);
  assert.deepEqual([bot.busy, session.status, session.pendingMessage, session.modelSwapState], [null, 'completed', null, undefined]);
  assert.equal(session.updated, before.updated, 'this bot\'s last-activity time is unchanged');
  assert.equal(session.routes.length, before.routes, 'no route is added for the hand-off');
  assert.equal(session.routes.at(-1).id, 'codex:weak:medium', 'this bot\'s model for new work is unchanged');
  assert.equal((session.tasks || []).some(task => task.messageId === message.clientId), false, 'the message is the new bot\'s task, not this bot\'s');
  assert.throws(() => bot.answerModelSwap(session.id, question, 'swap'), /no longer open/);

  // The next message to this bot asks the same question again: a new bot leaves no cooldown behind.
  picks.push(pick('codex:strong:high', 'high'));
  const again = send('Another hard one');
  await until(() => session.pendingMessage?.modelSwap);
  assert.equal(session.pendingMessage.modelSwap.cooldown ?? null, null, 'no cooldown after a new bot');
  bot.answerModelSwap(session.id, session.pendingMessage.modelSwap.id, 'keep');
  await again;
  assert.deepEqual(turns(), ['weak', 'weak']);
});

test('a pinned bot never routes or swaps, and a swap question does not survive a restart', async t => {
  const { agents, bot, session, turns, complete } = await setup(t);
  await agents.saveAgent({ ...agents.profile(bot.agentId), mode: 'terra-light' });
  assert.equal(agents.controller(bot.agentId), bot);
  assert.equal(bot.data.settings.mode, 'terra-light');
  bot.smartRouter.choose = async () => assert.fail('a pinned bot is not routed');
  await bot.send({ id: session.id, text: 'Pinned work', task: 'off' });
  assert.deepEqual(turns(), ['weak', 'gpt-5.6-terra']);
  assert.equal(session.routes.at(-1).modelSwap, undefined);
  complete(); await until(() => !bot.busy);

  session.pendingMessage = { id: 'm', clientId: 'm', type: 'userMessage', pending: true, content: [], modelSwap: { id: 'q', status: 'pending' } };
  bot.save();
  const reopened = new Controller(bot.filename, bot.workspace, new Fake(), { cancel() {}, close() {} });
  const unsent = reopened.data.sessions.find(s => s.id === session.id).pendingMessage;
  assert.equal(unsent.modelSwap, undefined);
  assert.equal(unsent.error, 'The app closed during the model question. Send it again.', 'shown as Not sent, not as still routing');
  reopened.close();
});
