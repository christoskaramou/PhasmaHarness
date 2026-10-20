'use strict';
// The Hub's opt-in two-run comparison (src/comparisons.cjs): proposal, confirmed start, result collection and the
// blind pick. These are Controller methods (see ../controller.cjs); `this` is the Controller.
const { randomUUID } = require('node:crypto');
const comparisons = require('../comparisons.cjs');
const { DEFAULT_MINUTES, DEFAULT_ATTEMPTS } = require('../job-budgets.cjs');

const DAY = 24 * 60 * 60 * 1000;
const retry = message => Object.assign(new Error(message), { retryable: true });

module.exports = {
  // A first call proposes and saves the plan; only the next user message can confirm it (confirm=true).
  async compareTool(session, args, images, abort, request, pending) {
    if (args.confirm) {
      if (!pending)
        throw new Error('No comparison is waiting for confirmation. Propose it first.');

      return this.startComparison(session, pending.args, images, abort, request);
    }

    const plan = this.planComparison(session, args);
    session.pendingComparison = plan;
    this.save();
    return { reply: comparisons.confirmText(plan.summary), proposed: true };
  },

  planComparison(session, args) {
    if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 14000)
      throw new Error('Give the comparison a task under 14,000 characters.');
    if (typeof args.change !== 'string' || !args.change.trim() || args.change.length > 4000)
      throw new Error('Give the instruction change to test, under 4,000 characters.');
    if (!Object.hasOwn(comparisons.TARGETS, args.target))
      throw new Error('Choose whether the change goes into the worker instructions (bot) or the project INSTRUCTIONS.md (project).');

    const pairs = args.pairs ?? 1;
    if (!Number.isInteger(pairs) || pairs < 1 || pairs > 3)
      throw new Error('Choose one to three pairs.');

    const mode = this.agents.agentMode(args.mode, args.effort);
    if (mode === 'auto')
      throw retry('A comparison needs one pinned model and effort for every run; Auto could pick different ones. Use agent_models.');

    const workspace = this.workspace(args.workspace ?? session.workspace);
    if (session.access !== 'danger-full-access' && !this.agents.workspaces.same(session.workspace, workspace))
      throw new Error('Comparing in a different workspace requires Full access.');

    const checks = this.data.settings.checks?.[workspace] || [];
    if (!checks.length)
      throw new Error(`Configure checks for ${workspace} first: a comparison is judged by its checks.`);

    // shortcut: a running comparison older than a day no longer blocks, in case a run never returned.
    const running = Object.values(this.data.comparisons || {}).find(record =>
      record.state === 'running' && record.project === workspace && Date.now() - record.at < DAY);
    if (running)
      throw new Error('A comparison is already running in this project. Wait for its results first.');

    this.agents.checkDelegationCapacity(this, session, pairs * 2);
    return {
      args: { task: args.task.trim(), change: args.change.trim(), target: args.target, pairs, workspace, mode },
      summary: { task: args.task.trim(), change: args.change.trim(), target: args.target, runs: pairs * 2,
        model: this.resolveWorker(mode)?.label || mode, budgetMinutes: DEFAULT_MINUTES, budgetAttempts: DEFAULT_ATTEMPTS,
        checks: checks.map(check => check.name), protectedFiles: comparisons.protectedFiles(checks, workspace) },
    };
  },

  async startComparison(session, args, images, abort, request) {
    const message = session.items.find(item => item.id === request.id);
    if (!message)
      throw new Error('The original user message is missing.');

    const checks = this.data.settings.checks?.[args.workspace] || [];
    const record = { id: randomUUID(), version: 1, at: Date.now(), state: 'running', project: args.workspace,
      task: args.task, change: args.change, target: args.target, pairs: args.pairs, mode: args.mode,
      model: this.resolveWorker(args.mode)?.label || args.mode, threshold: comparisons.THRESHOLD,
      // Computed once, so both runs of every pair start with the same lessons.
      lessonBlock: this.lessonsFor(args.workspace, args.task, checks),
      runs: comparisons.planRuns(args.pairs), picks: {}, sessionId: session.id, requestId: request.id };
    (this.data.comparisons ||= {})[record.id] = record;
    // Marks the confirming message, so the chat hides this batch's report: the comparison card replaces it.
    message.comparisonId = record.id;
    this.save();

    let result;
    try {
      // The workers see only the task, never the user's compare message, which names the change.
      result = await this.coordinatorTool(session, 'agent_work', { task: args.task, count: args.pairs * 2, name: 'Compare',
        mode: args.mode, workspace: args.workspace }, images, abort, { ...request, text: args.task, comparison: { id: record.id } });
    } catch (error) {
      delete this.data.comparisons[record.id];
      this.save();
      throw error;
    }

    record.runs.forEach((run, index) => Object.assign(run, { name: result.agents[index]?.agent || null, jobId: result.agents[index]?.jobId || null }));
    record.batchId = message.hubBatch?.id || null;
    this.save();
    return { reply: `Started the comparison: ${args.pairs * 2} runs on ${record.model}. The card below updates as they finish.`, comparisonId: record.id };
  },

  // A returned run is measured without a model call. Until the last one the card updates quietly; the last one
  // finishes the comparison and asks for the pick. `quiet` replies are not shown in the chat.
  collectComparison(session, request, cancelled) {
    const record = this.data.comparisons?.[request.comparison.id];
    const run = record?.runs.find(entry => entry.index === request.batch?.index);
    if (!record || !run || record.state !== 'running')
      return { reply: 'A run returned for a comparison that is no longer running; it was not compared.' };

    const item = session.items.findLast(entry => entry.type === 'agentResult' && entry.requestId === request.id && entry.batch?.index === run.index);
    run.result = comparisons.runResult(item, cancelled);
    const returned = record.runs.filter(entry => entry.result).length;
    if (returned < record.runs.length) {
      this.comparisonCard(session, record);
      this.save();
      return { reply: `Comparison: ${returned}/${record.runs.length} runs returned.`, quiet: true };
    }

    comparisons.finish(record);
    this.saveComparisonRecord(record);
    this.save();
    const ask = record.pairs > 1 ? `All ${record.runs.length} runs are back. Which did better in each pair?` : 'Both runs are back. Which did better?';
    return { reply: `${ask} Pick below, or reveal.`, comparisonId: record.id };
  },

  // The card lives under the newest comparison message: given a new message it moves there, otherwise it updates in place.
  comparisonCard(session, record, target = null) {
    const holder = session.items.find(item => item.hubComparison?.id === record.id);
    if (holder && target && holder !== target)
      delete holder.hubComparison;

    const item = target || holder;
    if (item)
      item.hubComparison = comparisons.publicView(record);
  },

  saveComparisonRecord(record) {
    if (!this.wikiStore)
      return;

    try {
      comparisons.saveComparison(this.wikiStore.ensure(this.lessonWorkspace(record.project)).root, record);
    } catch (error) {
      this.log.warn('Comparison not saved to the project wiki', { comparison: record.id, error: error.message });
    }
  },

  // A pick per pair (A, B or none); the last pick, or Reveal, shows which run had the change and the verdict.
  comparisonPick(id, comparisonId, pair, pick) {
    const session = this.session(id);
    const message = session.items.find(item => item.hubComparison?.id === comparisonId);
    const record = this.data.comparisons?.[comparisonId];
    if (!message || !record || record.state !== 'finished')
      throw new Error('This comparison has no results to judge.');

    if (pick !== 'reveal') {
      if (!Number.isInteger(pair) || pair < 1 || pair > record.pairs || !['A', 'B', 'none'].includes(pick))
        throw new Error('Choose A, B or no preference for one pair.');

      record.picks[pair] = pick;
    }
    if (pick === 'reveal' || Object.keys(record.picks).length === record.pairs)
      record.revealedAt = Date.now();

    message.hubComparison = comparisons.publicView(record);
    if (record.revealedAt) {
      this.saveComparisonRecord(record);
      delete this.data.comparisons[comparisonId];
    }
    this.save();
    this.changed();
    return message.hubComparison;
  },

  // The running comparison a worker's project copy belongs to, or null (also after it finished).
  comparisonOf(session) {
    let copy;
    try {
      copy = this.agents?.workspaces?.record(session.workspace);
    } catch {
      return null;
    }
    const record = copy?.comparisonId ? this.agents.primary.data.comparisons?.[copy.comparisonId] : null;
    return record?.state === 'running' ? { copy, record } : null;
  },
};
