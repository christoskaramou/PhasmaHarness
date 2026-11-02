'use strict';
// Auto on a bot keeps the bot's model unless a swap is worth losing its conversation (src/routing/model-swap.cjs), and a
// swap the score supports waits for the user's answer before the task starts: Create a new bot (a new top-level bot
// runs the task on the suggested model), Swap here or Keep current. Unanswered, it keeps the current model. These are
// Controller methods (see ../controller.cjs); `this` is the Controller.
const { randomUUID } = require('node:crypto');
const { evaluateSwap, evaluateReach, evaluateHubSwap, countTask, recordDecision, contextTokens, PROMPT_MS, REUSE_TOKENS } = require('../routing/model-swap.cjs');
const { ACCESS_MODES } = require('./shared.cjs');

const OUTCOMES = { swap: 'swapped', keep: 'declined', subbot: 'delegated', timeout: 'expired' };
const CHOSEN = { swapped: 'you chose Swap here', declined: 'you chose Keep current', delegated: 'you chose Create a new bot',
  expired: 'no answer, so the current model stays', stopped: 'stopped', kept: 'Auto kept it', unasked: 'delegated, group and result turns do not pause to ask' };

module.exports = {
  // A rated task for an existing Auto worker: Hub's agent_work or a bot's agent_delegate, with the sender's difficulty
  // rating (`this` is the sender). Delegated tasks run in the worker's background conversation, whose model is the one
  // compared. Within that model's reach the worker takes the task: null. Outside it, too hard for the model or more than
  // the task needs, the task goes to an idle Auto worker the sender may give work to, in the same workspace with the same
  // role and access, whose model reaches it or that has none yet, with the shortest conversation under REUSE_TOKENS
  // (`to`). Else the sender creates one like `from` (`to`
  // null), named after it (`base`) with its role and its access or the sender's, whichever is lower, which routes for itself.
  // `workspace` and `ancestors` come from agents.delegate's dry run, which has already refused what it would refuse.
  workerForReach(session, agentId, level, workspace, ancestors = []) {
    const background = id => { const worker = this.agents.executions.get(id); return worker && { worker, conversation: this.agents.conversation(worker) }; };
    const reachOf = id => {
      const { worker, conversation } = background(id) || {};
      if (!conversation) return null;
      const catalog = worker.autoCatalog();
      const available = worker.smartRouter.benchmarks?.catalog ? worker.smartRouter.benchmarks.catalog(catalog) : catalog;
      return evaluateReach({ level, session: conversation, available, autoLowModel: worker.data.settings.autoLowModel,
        proven: Object.values(worker.provenSetupsFor(conversation.workspace)) });
    };
    // The workspace a task would run in: the background conversation's, as agents.delegate uses, else the bot's.
    const runsIn = entry => background(entry.id)?.conversation?.workspace || entry.workspace;
    if (this.agents.controller(agentId).data.settings.mode !== 'auto') return null;
    const result = reachOf(agentId);
    if (!result) return null;
    this.log.info('Task reach', { sender: this.agentId, worker: agentId, level, from: result.decision.current.id, to: result.decision.suggested.id,
      gain: result.decision.gain, margin: result.decision.margin, outside: result.outside });
    if (!result.outside) return null;

    // A sub-bot takes work only from the bot that made it, and a task never goes back up its own chain.
    const sender = this === this.agents.primary ? 'main' : this.agentId;
    const excluded = new Set([agentId, sender, ...ancestors]);
    const mayUse = id => !this.agents.isSubBot(this.agents.profile(id)) || this.agents.profile(id).createdBy === sender;
    const roster = this.agents.tool(this, session, 'agents_list', {});
    const own = roster.find(entry => entry.id === agentId), profile = this.agents.profile(agentId);
    // Of the idle workers that fit, the shortest conversation (REUSE_TOKENS): the task continues the worker's whole session.
    const history = entry => contextTokens(background(entry.id)?.conversation?.items);
    const other = roster.filter(entry => !excluded.has(entry.id) && entry.mode === 'auto' && !entry.busy && mayUse(entry.id) &&
      entry.access === own.access && this.agents.workspaces.same(runsIn(entry), workspace) &&
      this.agents.profile(entry.id)?.instructions === profile.instructions && !reachOf(entry.id)?.outside)
      .map(entry => ({ entry, tokens: history(entry) })).filter(candidate => candidate.tokens <= REUSE_TOKENS)
      .sort((a, b) => a.tokens - b.tokens)[0]?.entry;
    const rank = access => ACCESS_MODES.findIndex(mode => mode.id === access);
    return { from: { id: agentId, name: profile.name, base: profile.name.slice(0, 44).trim(), instructions: profile.instructions,
      access: rank(own.access) < rank(session.access) ? own.access : session.access }, to: other?.id || null, decision: result.decision };
  },

  // The worker for a new task on an Auto bot. canAsk is false where nobody sees the question (group replies, results
  // coming back to this bot); a swap the score supports then keeps the current model.
  async modelSwapChoice(session, selected, catalog, canAsk) {
    if (selected.sameTask === true || selected.userPick) return selected;
    const available = this.smartRouter.benchmarks?.catalog ? this.smartRouter.benchmarks.catalog(catalog) : catalog;
    const result = evaluateSwap({ selected, session, available });
    if (!result) { countTask(session); return selected; }
    // The route keeps the router's metadata (assessment, router usage, source) and takes the other preset's own fields,
    // its benchmarks included.
    const entry = id => available.find(p => p.id === id) || {};
    const runOn = (p, outcome) => {
      const route = { ...selected };
      if (p.id !== selected.id) {
        for (const key of Object.keys(entry(selected.id))) delete route[key];
        // A proven setup (smart-router.cjs provenChoice) is the router's pick, not the model that runs instead.
        delete route.proven;
        Object.assign(route, entry(p.id), { routerPick: selected.routerPick || selected.id });
      }
      const modelSwap = { ...result.decision, outcome, choice: CHOSEN[outcome] };
      return { ...route, reason: `${modelSwap.reason}${outcome === 'kept' ? '' : ` (${modelSwap.choice})`} ${selected.reason || ''}`.trim(), modelSwap };
    };
    if (!result.propose || !canAsk) {
      countTask(session);
      return runOn(result.keep, result.propose ? 'unasked' : 'kept');
    }

    const prompt = { id: randomUUID(), status: 'pending', expiresAt: Date.now() + (this.modelSwapPromptMs ?? PROMPT_MS), ...result.decision };
    if (session.pendingMessage) session.pendingMessage.modelSwap = prompt;
    this.changed();
    const answer = await new Promise(resolve => {
      let timer;
      const done = value => { clearTimeout(timer); if (this.swapPrompts?.get(session.id)?.id === prompt.id) this.swapPrompts.delete(session.id); resolve(value); };
      timer = setTimeout(() => done('timeout'), this.modelSwapPromptMs ?? PROMPT_MS);
      (this.swapPrompts ||= new Map()).set(session.id, { id: prompt.id, resolve: done });
    });
    if (session.pendingMessage?.modelSwap?.id === prompt.id) delete session.pendingMessage.modelSwap;
    const outcome = answer === 'stopped' ? 'stopped' : OUTCOMES[answer];
    // A new bot leaves this bot with no cooldown: its next message asks the same question again.
    if (outcome !== 'stopped' && outcome !== 'delegated') recordDecision(session, outcome, result);
    this.log.info('Auto model swap', { session: session.id, from: result.decision.current.id, to: result.decision.suggested.id,
      difficulty: result.decision.difficulty, gain: result.decision.gain, margin: result.decision.margin, outcome });
    this.save(); this.changed();
    return runOn(outcome === 'swapped' ? result.suggested : result.keep, outcome);
  },

  // Hub's own model on Auto, after a request it rated for itself (its reply's difficulty): a model that fits that rating
  // better by the margin is offered under the reply, with Swap and Keep current, for the messages after it. Nothing waits
  // for the answer; the next message to Hub without one keeps the model. `this` is the Hub.
  hubSwapQuestion(session, item, choice, level) {
    const eligible = this.hubEligible();
    const available = this.smartRouter.benchmarks?.catalog ? this.smartRouter.benchmarks.catalog(eligible) : eligible;
    const result = evaluateHubSwap({ current: available.find(p => p.id === choice.id), level, available, state: this.data.modelSwapState });
    countTask(this.data);
    if (!result) return;
    this.log.info('Hub model swap', { from: result.decision.current.id, to: result.decision.suggested.id, difficulty: result.decision.difficulty,
      gain: result.decision.gain, margin: result.decision.margin, propose: result.propose });
    if (!result.propose) return;
    item.modelSwap = { id: randomUUID(), status: 'pending', ...result.decision };
    this.data.hubSwapQuestion = { sessionId: session.id, itemId: item.id, id: item.modelSwap.id };
  },

  // The open Hub question: a new message to Hub without an answer keeps its model.
  expireHubSwap() {
    const swap = this.hubSwapOpen();
    if (swap) this.settleHubSwap(swap, 'expired');
  },

  hubSwapOpen() {
    const open = this.data.hubSwapQuestion;
    if (!open) return null;
    delete this.data.hubSwapQuestion;
    const swap = this.data.sessions.find(chat => chat.id === open.sessionId)?.items.find(item => item.id === open.itemId)?.modelSwap;
    return swap?.id === open.id && swap.status === 'pending' ? swap : null;
  },

  settleHubSwap(swap, outcome) {
    Object.assign(swap, { status: 'answered', outcome, choice: outcome === 'swapped' ? 'you chose Swap' : CHOSEN[outcome] });
    recordDecision(this.data, outcome, { current: swap.current, suggested: swap.suggested, decision: swap });
    if (outcome === 'swapped') Object.assign(this.data, { hubMode: swap.suggested.id, hubModeSource: 'auto' });
    this.log.info('Hub model swap answered', { from: swap.current.id, to: swap.suggested.id, outcome });
  },

  // The user's answer to a pending swap question: a bot's before its task (Create a new bot, Swap here or Keep current),
  // or Hub's under a reply (Swap or Keep current).
  answerModelSwap(id, promptId, choice) {
    if (!['subbot', 'swap', 'keep'].includes(choice)) throw new Error('Choose Create a new bot, Swap here or Keep current.');
    const waiting = this.swapPrompts?.get(id);
    if (waiting?.id === promptId) {
      waiting.resolve(choice);
      return { answered: choice };
    }
    const open = this.data.hubSwapQuestion;
    if (!this.isCoordinator() || open?.id !== promptId || open.sessionId !== id) throw new Error('This model question is no longer open.');
    if (choice === 'subbot') throw new Error('Hub’s own model has no sub-bot option. Choose Swap or Keep current.');
    // A model chosen for Hub since then is never swapped.
    if (this.data.hubModeSource !== 'auto') throw new Error('Hub now uses a model you chose, so Auto does not swap it.');
    const swap = this.hubSwapOpen();
    if (!swap) throw new Error('This model question is no longer open.');
    this.settleHubSwap(swap, OUTCOMES[choice]);
    this.save(); this.changed();
    return { answered: choice };
  },

  // Create a new bot: a new top-level bot (not under this one), on the suggested model, takes the message as its task. This
  // bot sends nothing and keeps its model, conversation and idle time (its last turn's end is not changed); the new bot's
  // result comes back to this chat (agents.deliver). The message and what happened to it stay in this chat. Called from
  // send in place of the worker turn; a refusal fails the send like any other ("Not sent: …"), before a bot exists where it can.
  async handToNewBot(session, route, text, images, clientId) {
    const swap = route.modelSwap, own = this.agents.profile(this.agentId);
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('A new bot task must be under 16,000 characters.');
    this.agents.checkDelegationCapacity(this, session);
    const profile = await this.agents.saveAgent({ name: this.agents.freeName(`${own.name.slice(0, 44).trim()} helper`), instructions: own.instructions,
      mode: swap.suggested.id, workspace: session.workspace, access: session.access, createdBy: 'main' }, null);
    // The message was never this bot's task: its tracking record goes, so the sub-bot's job does not hang from it.
    session.tasks = (session.tasks || []).filter(task => task.messageId !== clientId);
    session.activeTaskId = null;
    const sent = this.agents.delegate(this, session, profile.id, text, images);
    const pending = session.pendingMessage;
    session.items.push({ ...pending, id: clientId, clientId, pending: false, localOnly: true, createdAt: pending?.createdAt || Date.now() });
    session.items.push({ id: randomUUID(), type: 'agentMessage', phase: 'final_answer', localOnly: true, createdAt: Date.now(), routeLabel: 'Harness',
      text: `Sent this task to the new bot **${profile.name}**, which runs ${swap.suggested.label}. This bot keeps ${swap.current.label} and its conversation; the new bot’s result comes back here.`,
      modelSwap: { ...swap, status: 'answered', subBot: { id: profile.id, name: profile.name, jobId: sent.jobId } } });
    if (!session.items.some(item => item.type === 'userMessage' && !item.agentReply && item.id !== clientId)) session.title = text.trim().replace(/\s+/g, ' ').slice(0, 65);
    session.pendingMessage = null;
    // The old bot's last-activity time stays as it was (cold start measures idle time from it), so `updated` is not bumped.
    session.status = 'completed'; session.error = null;
    this.lastSends.delete(session.id);
    this.stopping.delete(session.id);
    if (this.busy === session.id) this.busy = null;
    this.save(); this.changed();
    this.settle(session);
    return route;
  },

  // Stop and close end a pending question; the turn then stops before anything is sent.
  endModelSwap(id) {
    const waiting = this.swapPrompts?.get(id);
    if (!waiting) return false;
    waiting.resolve('stopped');
    return true;
  },
};
