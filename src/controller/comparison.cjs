'use strict';
// The Hub's two-run comparison (src/comparisons.cjs). It runs without approvals: the user's request, or a lesson that
// did not stick, starts it; when both runs are back the verdict shows, the better run lands in the project and a rule
// that helped is kept, each with an Undo. These are Controller methods (see ../controller.cjs); `this` is the Controller.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const comparisons = require('../comparisons.cjs');
const { DEFAULT_MINUTES, DEFAULT_ATTEMPTS } = require('../job-budgets.cjs');
const { readLessons, relevantLessons, markSuggested, lessonKey } = require('../lessons.cjs');
const { projectInstructions } = require('../workspace/project-instructions.cjs');
const { capCatalog } = require('../routing/effort-cap.cjs');

const DAY = 24 * 60 * 60 * 1000;
const list = files => files.slice(0, 5).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '');

module.exports = {
  // Asking for a comparison is the approval: it starts at once.
  async compareTool(session, args, images, abort, request) {
    const plan = await this.planComparison(session, args);
    return this.startComparison(session, plan.args, images, abort, request);
  },

  async planComparison(session, args) {
    if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 14000)
      throw new Error('Give the comparison a task under 14,000 characters.');
    if (typeof args.change !== 'string' || !args.change.trim() || args.change.length > 4000)
      throw new Error('Give the instruction change to test, under 4,000 characters.');
    if (!Object.hasOwn(comparisons.TARGETS, args.target))
      throw new Error('Choose whether the change goes into the worker instructions (bot) or the project INSTRUCTIONS.md (project).');

    const pairs = args.pairs ?? 1;
    if (!Number.isInteger(pairs) || pairs < 1 || pairs > 3)
      throw new Error('Choose one to three pairs.');

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
    const mode = args.mode && args.mode !== 'auto' ? this.agents.agentMode(args.mode, args.effort) : await this.comparisonMode(session, args.task, workspace, checks);
    return {
      args: { task: args.task.trim(), change: args.change.trim(), target: args.target, pairs, workspace, mode },
      summary: { runs: pairs * 2, model: this.resolveWorker(mode)?.label || mode, budgetMinutes: DEFAULT_MINUTES, budgetAttempts: DEFAULT_ATTEMPTS,
        checks: checks.map(check => check.name), protectedFiles: comparisons.protectedFiles(checks, workspace) },
    };
  },

  // Without a named model, Auto picks one for this request once, and every run uses it, so the runs never differ in model.
  async comparisonMode(session, text, workspace, checks) {
    const router = this.effectiveRouter();
    const catalog = capCatalog(this.catalog().filter(worker => worker.worker && this.available(worker)), this.data.settings.effortCap);
    if (!router || !this.available(router) || !catalog.length)
      throw new Error('Auto routing is unavailable, so name a model for the comparison.');

    const choice = await this.smartRouter.choose(text, { ...session, workspace, configuredChecks: checks, routingCatalog: catalog, routerChoice: router },
      this.models, 'smart', router.id);
    if (!choice?.id || choice.directAnswer)
      throw new Error('Auto did not pick a worker model for this task, so name one for the comparison.');

    return this.agents.agentMode(choice.id);
  },

  // Before Bot dispatches a fresh request: a lesson about it that failed again while it was offered tests, once, a
  // permanent project rule on this very task. Harness decides, not the Hub model; if a comparison cannot start (no
  // checks, one already running, no model) the task is just dispatched.
  async suggestedComparison(session, args, request, images, abort) {
    if ((args.count ?? 1) !== 1 || session.group || session.delegation || !this.wikiStore)
      return null;

    let lesson, root, plan;
    try {
      const workspace = this.workspace(args.workspace ?? session.workspace);
      root = this.wikiStore.location(this.lessonWorkspace(workspace)).root;
      // The request's words only: every task in a project with that check would otherwise match on its name.
      // A reflection that chose "keep as is" means no comparison for that lesson (harness2's KEEP_BASE).
      lesson = relevantLessons(readLessons(root).filter(record => record.recurred && !record.suggestedAt && !record.reflection?.keep && record.situation?.error),
        request.text)[0];
      if (!lesson)
        return null;

      // The rule the reflection wrote from the run, else a template from the failure.
      const reflected = !lesson.reflection?.rejected && lesson.reflection?.rule;
      const rule = reflected || `"${lesson.failures[0].check}" has failed more than once with: ${lesson.situation.error} Make sure your change handles this before you finish.`;
      // A model the user asked Bot for wins; otherwise the model the lesson failed on.
      plan = await this.planComparison(session, { task: request.text, change: rule, target: 'project', workspace,
        mode: args.mode ?? lesson.recurred.mode ?? undefined, effort: args.mode !== undefined ? args.effort : undefined });
    } catch {
      return null;
    }

    markSuggested(root, lessonKey(lesson));
    const started = await this.startComparison(session, plan.args, images, abort, request, true);
    return { ...started, reply: `This kind of task failed the same way before, even with the saved lesson ("${lesson.failures[0].check}": ` +
      `${lesson.situation.error}). So I am running it twice on ${plan.summary.model}: as usual, and with this rule in INSTRUCTIONS.md:\n\n` +
      `> ${plan.args.change}\n\nThe better result goes into your project, and the rule is kept if it helps. The card below updates as they finish.` };
  },

  async startComparison(session, args, images, abort, request, suggested = false) {
    const message = session.items.find(item => item.id === request.id);
    if (!message)
      throw new Error('The original user message is missing.');

    const checks = this.data.settings.checks?.[args.workspace] || [];
    const record = { id: randomUUID(), version: 1, at: Date.now(), state: 'running', project: args.workspace,
      task: args.task, change: args.change, target: args.target, pairs: args.pairs, mode: args.mode,
      model: this.resolveWorker(args.mode)?.label || args.mode, threshold: comparisons.THRESHOLD, suggested,
      // Numbers the comparison for its bots' names and its card.
      number: this.data.comparisonCount = (this.data.comparisonCount || 0) + 1,
      // Computed once, so both runs of every pair start with the same lessons.
      lessonBlock: this.lessonsFor(args.workspace, args.task, checks),
      runs: comparisons.planRuns(args.pairs), sessionId: session.id, requestId: request.id };
    (this.data.comparisons ||= {})[record.id] = record;
    // Marks the request, so the chat hides this batch's report: the comparison card replaces it.
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
    return { reply: `Started the comparison: ${args.pairs * 2} runs on ${record.model}, judged by ${checks.map(check => check.name).join(', ')}. ` +
      'The card below updates as they finish.', comparisonId: record.id };
  },

  // A returned run is measured without a model call. Until the last one the card updates quietly (`quiet` replies are
  // not shown); the last one settles everything: verdict, the better run applied, a rule that helped kept.
  async collectComparison(session, request, cancelled) {
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
    await this.settleComparison(record);
    const verdict ={ helped: 'The change helped', hurt: 'The change hurt', cheaper: 'The change made it cheaper', confounded: 'The runs could not be compared fairly',
      'no observed effect': 'The change made no clear difference' }[record.verdict] || record.verdict;
    return { reply: [`${verdict} (${record.pairVerdicts.map(pair => pair.reason).join('; ')}).`, ...comparisons.outcomeLines(record)].join(' '), record };
  },

  // A finished comparison lands: the better run applied, a rule that helped kept, the record saved to the wiki and
  // dropped from Harness data, and its bots removed.
  async settleComparison(record) {
    record.applied = await this.applyBestRun(record);
    record.adopted = this.adoptRule(record);
    this.saveComparisonRecord(record);
    delete this.data.comparisons[record.id];
    this.save();
    await this.removeComparisonBots();
  },

  // At startup: comparisons that finished before results were automatic still wait for a pick nobody can give now.
  async settleWaitingComparisons() {
    for (const record of Object.values(this.data.comparisons || {})) {
      if (record.state !== 'finished' || record.revealedAt)
        continue;

      record.revealedAt = Date.now();
      await this.settleComparison(record);
      const session = this.data.sessions.find(entry => entry.id === record.sessionId);
      if (session)
        this.comparisonCard(session, record);
    }
    this.save();
  },

  async applyBestRun(record) {
    const run = comparisons.bestRun(record);
    if (!run)
      return { error: 'No run passed every check, so nothing was applied to the project.' };

    try {
      const preview = await this.agents.workspaces.changes(run.result.workspace);
      if (preview.conflicts.length)
        return { label: run.label, workspace: run.result.workspace,
          error: `Run ${run.label} was not applied: you changed ${list(preview.conflicts)} since the copy was made. Apply it from the card if you still want it.` };

      const result = await this.agents.workspaces.apply(run.result.workspace, preview);
      return { label: run.label, workspace: run.result.workspace, files: result.applied, changes: preview.changes };
    } catch (error) {
      return { label: run.label, workspace: run.result.workspace, error: `Run ${run.label} was not applied: ${error.message}` };
    }
  },

  // A project rule that helped joins the project entry.
  adoptRule(record) {
    if (record.target !== 'project' || record.verdict !== 'helped')
      return null;

    const file = path.join(record.project, 'INSTRUCTIONS.md');
    try {
      projectInstructions(record.project, true);
      const body = fs.readFileSync(file, 'utf8');
      if (body.includes(record.change))
        return { file, rule: record.change, existing: true };

      const next = `${body.trimEnd()}\n\n${record.change}\n`;
      if (Buffer.byteLength(next) > 64 * 1024)
        throw new Error('it would push INSTRUCTIONS.md past 64 KiB.');

      fs.writeFileSync(file, next);
      return { file, rule: record.change };
    } catch (error) {
      return { error: error.message };
    }
  },

  // Undo from the card: `apply` restores the applied files from the snapshot (refused if they changed since); `rule`
  // removes the added rule again.
  async undoComparison(id, comparisonId, part) {
    const message = this.session(id).items.find(item => item.hubComparison?.id === comparisonId);
    const view = message?.hubComparison;
    if (part === 'apply') {
      if (!view?.applied?.files?.length || view.applied.undoneAt)
        throw new Error('There is no applied run to undo.');

      await this.agents.workspaces.undo(view.applied.workspace, view.applied.changes);
      view.applied.undoneAt = Date.now();
    } else if (part === 'rule') {
      if (!view?.adopted?.file || view.adopted.existing || view.adopted.undoneAt)
        throw new Error('There is no added rule to undo.');

      const body = fs.readFileSync(view.adopted.file, 'utf8'), added = `\n\n${view.adopted.rule}\n`;
      if (!body.includes(added))
        throw new Error('The rule changed in INSTRUCTIONS.md since it was added; edit the file by hand.');

      fs.writeFileSync(view.adopted.file, body.replace(added, '\n'));
      view.adopted.undoneAt = Date.now();
    } else throw new Error('Choose what to undo.');

    this.save();
    this.changed();
    return view;
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

  // Removes the idle bots of comparisons that are over (finished, or no longer in Harness data), so they do not pile up
  // in the sidebar. Their project copies stay, so Apply and Undo still work. A busy bot is kept for a later sweep.
  async removeComparisonBots() {
    for (const profile of [...this.agents.primary.data.agents]) {
      let copy = null;
      try {
        copy = profile.temporaryBatch ? this.agents.workspaces.record(profile.workspace) : null;
      } catch { /* a moved copy is left for the user to review */ }
      const record = copy?.comparisonId && this.data.comparisons?.[copy.comparisonId];
      if (!copy?.comparisonId || (record && !record.revealedAt))
        continue;

      try {
        await this.agents.deleteAgent(profile.id);
      } catch (error) {
        this.log.warn('Comparison bot kept', { agent: profile.name, reason: error.message });
      }
    }
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
