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
const { capCatalog } = require('../routing/effort-cap.cjs');
const trials = require('../trials.cjs');
const skillPackages = require('../skill-packages.cjs');
const { DEFAULT_SKILLS, skillContent } = require('../worker-instructions.cjs');
const { skillHashes, canonical } = require('../setup-fingerprint.cjs');

const DAY = 24 * 60 * 60 * 1000;
const list = files => files.slice(0, 5).join(', ') + (files.length > 5 ? ` and ${files.length - 5} more` : '');

module.exports = {
  comparisonSkillReads(session, submission) {
    const comparison = this.comparisonOf?.(session);
    if (comparison?.record.target !== 'skill') return [];
    const name = comparison.record.skill.name, reads = new Set(submission.skillReads || []);
    if (reads.has(name)) return [...reads];
    const folder = this.skillDirectories(session)[name], entry = path.join(folder, 'SKILL.md');
    const normalize = text => String(text).replace(/^\s*\d+(?:[\t:|]|→)\s?/gm, '').replace(/\s+/g, ' ').trim();
    let body;
    try { body = skillContent(fs.readFileSync(entry, 'utf8')).body; } catch { return [...reads]; }
    const identity = file => {
      try {
        const real = fs.realpathSync(file);
        return process.platform === 'win32' ? real.toLowerCase() : real;
      } catch { return null; }
    };
    const file = identity(entry);
    // ACP wraps text in content blocks; MCP and native tools also return arrays and numbered lines.
    const outputText = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(outputText).join('\n')
      : value && typeof value === 'object' ? outputText(value.text ?? value.content ?? value.resource?.text ?? '') : '';
    const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
    const missing = new Set(body.split(/\r?\n/).map(normalize).filter(Boolean));
    const hasBody = missing.size > 0;
    for (const item of session.items) {
      if (item.turnId !== submission.turnId || item.status !== 'completed' ||
          !['commandExecution', 'mcpToolCall', 'dynamicToolCall'].includes(item.type) || (item.exitCode != null && item.exitCode !== 0)) continue;
      const args = item.arguments || {}, location = args.workdir || args.cwd;
      const cwd = typeof location === 'string' ? location : session.workspace || folder;
      const paths = new Set(strings(item.arguments || item.command || ''));
      // Revisit quoted operands: shell wrappers can contain another quoted path.
      for (const input of paths) {
        for (const match of input.matchAll(/"([^"]+)"|'([^']+)'|([^\s"'`;|<>]+)/g)) paths.add(match[1] || match[2] || match[3]);
      }
      if (![...paths].some(input => /(?:^|[\\/])SKILL\.md$/i.test(input) && identity(path.resolve(cwd, input)) === file)) continue;
      const output = item.aggregatedOutput ?? item.result;
      if (output?.isError) continue;
      const text = normalize(outputText(output));
      // Partial reads may accumulate, but one matching line must not stand in for the whole body.
      for (const line of missing) if (text.includes(line)) missing.delete(line);
      if ((normalize(body) && text.includes(normalize(body))) || (hasBody && !missing.size)) reads.add(name);
    }
    return [...reads];
  },

  // Asking for a comparison is the approval: it starts at once.
  async compareTool(session, args, images, abort, request) {
    const plan = await this.planComparison(session, args);
    return this.startComparison(session, plan.args, images, abort, request);
  },

  async planComparison(session, args) {
    if (typeof args.task !== 'string' || !args.task.trim() || args.task.length > 14000)
      throw new Error('Give the comparison a task under 14,000 characters.');
    if (typeof args.change !== 'string' || !args.change.trim() || args.change.length > 4000)
      throw new Error('Describe the change to test, under 4,000 characters.');
    if (!Object.hasOwn(comparisons.TARGETS, args.target))
      throw new Error('Choose worker instructions (bot), project rules (project), or a skill package (skill).');

    const pairs = args.pairs ?? 1;
    if (!Number.isInteger(pairs) || pairs < 1 || pairs > 3)
      throw new Error('Choose one to three pairs.');

    const workspace = this.workspace(args.workspace ?? session.workspace);
    if (session.access !== 'danger-full-access' && !this.agents.workspaces.same(session.workspace, workspace))
      throw new Error('Comparing in a different workspace requires Full access.');

    let candidate;
    if (args.target === 'skill') {
      if (session.access === 'read-only') throw new Error('Comparing and adopting skills requires Workspace or Full access.');
      if (!this.wikiStore) throw new Error('Workspace storage is required for skill comparisons.');
      if (!DEFAULT_SKILLS.includes(args.skill)) throw new Error('Choose an existing Harness skill.');
      if (typeof args.candidatePath !== 'string' || !args.candidatePath.trim()) throw new Error('Give the candidate skill folder inside the workspace.');
      candidate = path.resolve(workspace, args.candidatePath);
      const relative = path.relative(workspace, candidate);
      if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
        throw new Error('The candidate skill folder must be inside the workspace.');
      skillPackages.packageFiles(candidate);
      skillPackages.requireIgnoredCandidate(workspace, candidate);
    }

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
      args: { task: args.task.trim(), change: args.change.trim(), target: args.target, pairs, workspace, mode,
        ...(candidate ? { skill: args.skill, candidatePath: candidate } : {}) },
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

      // The rule the reflection wrote from the run, else a template from the failure; never one taken out before.
      const reflected = !lesson.reflection?.rejected && lesson.reflection?.rule;
      const template = `"${lesson.failures[0].check}" has failed more than once with: ${lesson.situation.error} Make sure your change handles this before you finish.`;
      const rules = trials.readRules(root);
      const rule = [reflected, template].find(text => text && !trials.retired(rules, text));
      if (!rule)
        return null;

      // A model the user asked Bot for wins; otherwise the model the lesson failed on.
      plan = await this.planComparison(session, { task: request.text, change: rule, target: 'project', workspace,
        mode: args.mode ?? lesson.recurred.mode ?? undefined, effort: args.mode !== undefined ? args.effort : undefined });
    } catch {
      return null;
    }

    markSuggested(root, lessonKey(lesson));
    const started = await this.startComparison(session, plan.args, images, abort, request,
      { key: lessonKey(lesson), check: lesson.failures[0].check, error: lesson.situation.error, goal: lesson.goal });
    return { ...started, reply: `This kind of task failed the same way before, even with the saved lesson ("${lesson.failures[0].check}": ` +
      `${lesson.situation.error}). So I am running it twice on ${plan.summary.model}: as usual, and with this rule added to the project rules:\n\n` +
      `> ${plan.args.change}\n\nThe better result goes into your project, and the rule is kept if it helps. The card below updates as they finish.` };
  },

  // `lesson`: the lesson that did not stick, when Harness started this comparison itself.
  async startComparison(session, args, images, abort, request, lesson = null) {
    const message = session.items.find(item => item.id === request.id);
    if (!message)
      throw new Error('The original user message is missing.');

    const checks = this.data.settings.checks?.[args.workspace] || [];
    const record = { id: randomUUID(), version: 1, at: Date.now(), state: 'running', project: args.workspace,
      task: args.task, change: args.change, target: args.target, pairs: args.pairs, mode: args.mode,
      model: this.resolveWorker(args.mode)?.label || args.mode, threshold: comparisons.THRESHOLD, suggested: !!lesson, lesson,
      // Numbers the comparison for its bots' names and its card.
      number: this.data.comparisonCount = (this.data.comparisonCount || 0) + 1,
      // Computed once, so both runs of every pair start with the same lessons.
      lessonBlock: this.lessonsFor(args.workspace, args.task, checks),
      runs: comparisons.planRuns(args.pairs), sessionId: session.id, requestId: request.id };
    if (args.target === 'skill') {
      this.pruneSkillStore(args.workspace);
      const root = path.join(this.wikiStore.ensure(this.lessonWorkspace(args.workspace)).root, '..', 'skills');
      record.skill = skillPackages.prepare(root, args.skill, args.candidatePath,
        this.skillDirectories({ ...session, workspace: args.workspace }), record.runs);
      record.skill.candidateRelative = path.relative(args.workspace, args.candidatePath).replace(/\\/g, '/');
    }
    (this.data.comparisons ||= {})[record.id] = record;
    // Marks the request, so the chat hides this batch's report: the comparison card replaces it.
    message.comparisonId = record.id;

    let result;
    try {
      this.save();
      // The workers see only the task, never the user's compare message, which names the change.
      result = await this.coordinatorTool(session, 'agent_work', { task: args.task, count: args.pairs * 2, name: 'Compare',
        mode: args.mode, workspace: args.workspace }, images, abort, { ...request, text: args.task, comparison: { id: record.id } });
    } catch (error) {
      if (record.skill) {
        const pending = this.agents.pendingJobs().filter(({ session: work }) =>
          this.agents.workspaces.record(work.workspace)?.comparisonId === record.id);
        try { for (const { job } of pending) await this.agents.stopDurably(job.id); }
        catch (failure) {
          record.error = `Comparison dispatch failed; cleanup is pending: ${failure.message}`;
          this.save();
          throw new Error(record.error);
        }
      }
      delete this.data.comparisons[record.id];
      delete message.comparisonId;
      this.save();
      if (record.skill) this.pruneSkillStore(record.project);
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
    if (record.target === 'skill') {
      const frozen = record.skill?.runs.find(entry => entry.index === run.index);
      try {
        if (!frozen || canonical(skillHashes(frozen.dirs)) !== canonical(frozen.hashes) ||
            run.result.setups.some(setup => canonical(setup?.skills) !== canonical(frozen.hashes)))
          run.result.skillError = 'the skill files differ from the frozen comparison setup';
      } catch { run.result.skillError = 'the frozen skill files are unavailable'; }
    }
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
    const recorded = this.saveComparisonRecord(record);
    delete this.data.comparisons[record.id];
    this.save();
    await this.removeComparisonBots();
    if (record.skill && recorded) this.pruneSkillStore(record.project);
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
    const projects = new Set(this.data.sessions.flatMap(session => session.items.filter(item => item.hubComparison?.target === 'skill').map(item => item.hubComparison.project)));
    for (const project of projects) this.pruneSkillStore(project);
    this.save();
  },

  async applyBestRun(record) {
    if (record.target === 'skill') {
      const owner = this.session(record.sessionId);
      if (owner.access === 'read-only' || (owner.access !== 'danger-full-access' && !this.agents.workspaces.same(owner.workspace, record.project)))
        return { error: 'The owner no longer has write access to this workspace, so nothing was applied.' };
    }
    if (record.target === 'skill' && (record.verdict === 'confounded' || record.runs.some(run => run.result?.skillError)))
      return { error: 'The skill comparison was not reliable, so nothing was applied.' };
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

  // A project rule that helped: one the user asked to compare joins Harness's kept rules; one Harness found itself goes on
  // trial (src/trials.cjs), since a single pair is weak evidence and real tasks decide whether it stays.
  adoptRule(record) {
    if (record.target === 'skill' && record.verdict === 'helped') {
      try {
        if (record.runs.some(run => run.result?.skillError)) throw new Error('A comparison snapshot changed.');
        const owner = this.session(record.sessionId);
        if (owner.access === 'read-only' || (owner.access !== 'danger-full-access' && !this.agents.workspaces.same(owner.workspace, record.project)))
          throw new Error('The owner no longer has write access to this workspace.');
        if (record.skill?.requiresRead !== false && (!record.runs.some(run => run.variant) ||
            (record.skill?.descriptionChanged !== true && !record.runs.some(run => !run.variant)) ||
            record.runs.some(run => (run.variant || record.skill?.descriptionChanged !== true) && !run.result?.skillReads?.includes(record.skill.name))))
          throw new Error('The skill was not observed being read in every required run; it was not kept.');
        return skillPackages.adopt(record.skill);
      } catch (error) { return { error: error.message }; }
    }
    if (record.target !== 'project' || record.verdict !== 'helped')
      return null;

    if (record.suggested) {
      try {
        const root = this.wikiStore.ensure(this.lessonWorkspace(record.project)).root;
        const trial = trials.startTrial(root, { rule: record.change, lessonKey: record.lesson?.key || null, check: record.lesson?.check,
          error: record.lesson?.error, goal: record.lesson?.goal || record.task, source: 'a suggested comparison' });
        if (!trial)
          return { error: 'the same rule was taken out before, so it does not go back on trial' };

        return { trial: true, root, ruleId: trial.id, rule: record.change };
      } catch (error) {
        return { error: error.message };
      }
    }

    try {
      const file = path.join(this.wikiStore.ensure(this.lessonWorkspace(record.project)).root, trials.KEPT_FILE);
      const body = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (body.includes(record.change))
        return { file, rule: record.change, existing: true };

      const next = `${body.trimEnd()}\n\n${record.change}\n`;
      if (Buffer.byteLength(next) > 64 * 1024)
        throw new Error('it would push kept-rules.md past 64 KiB.');

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
    } else if (part === 'skill') {
      if (!view?.adopted?.skill || view.adopted.undoneAt || view.adopted.expiredAt) throw new Error('There is no retained skill change to undo.');
      const owner = this.session(id);
      if (owner.access === 'read-only' || (owner.access !== 'danger-full-access' && !this.agents.workspaces.same(owner.workspace, view.project)))
        throw new Error('Undoing a skill requires write access to its workspace.');
      skillPackages.undo(view.adopted);
      view.adopted.undoneAt = Date.now();
      const root = this.wikiStore.location(this.lessonWorkspace(view.project)).root;
      const saved = comparisons.readComparisons(root).find(record => record.id === comparisonId);
      this.saveComparisonRecord({ ...(saved || view), sessionId: id, adopted: view.adopted });
      this.pruneSkillStore(view.project);
    } else if (part === 'rule' && view?.adopted?.trial) {
      if (view.adopted.undoneAt)
        throw new Error('There is no added rule to undo.');

      // A rule kept since then leaves the kept rules too, so no line stays there untracked.
      const file = path.join(view.adopted.root, trials.KEPT_FILE);
      trials.updateRules(view.adopted.root, records => {
        const rule = records.find(entry => entry.id === view.adopted.ruleId);
        const body = rule?.state === 'kept' && rule.line && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
        if (body.includes(rule?.line))
          fs.writeFileSync(file, trials.removeKeptLine(body, rule.line));

        if (rule && ['trial', 'kept'].includes(rule.state))
          Object.assign(rule, { state: 'removed', endedAt: Date.now(), reason: 'undone from the comparison card' });
      });
      view.adopted.undoneAt = Date.now();
    } else if (part === 'rule') {
      if (!view?.adopted?.file || view.adopted.existing || view.adopted.undoneAt)
        throw new Error('There is no added rule to undo.');

      const file = view.adopted.file;
      const body = fs.readFileSync(file, 'utf8'), added = `\n\n${view.adopted.rule}\n`;
      if (!body.includes(added))
        throw new Error(`The rule changed in ${file} since it was added; edit the file by hand.`);

      fs.writeFileSync(file, body.replace(added, '\n'));
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
      return false;

    try {
      const controllers = this.agents?.allControllers() || [this];
      const recovered = controllers.flatMap(controller => (controller.data?.sessions || []).flatMap(session => session.items
        .map(item => item.hubComparison && { at: item.createdAt || Date.now(), ...item.hubComparison })
        .filter(view => view && view.project === record.project)));
      const complete = entry => ({ at: Date.now(), task: '', change: '', pairVerdicts: [], runs: [], ...entry });
      comparisons.saveComparison(this.wikiStore.ensure(this.lessonWorkspace(record.project)).root, complete(record), {
        recovered: recovered.map(complete), onWarning: message => this.comparisonNotice?.(record, message),
      });
      return true;
    } catch (error) {
      this.log.warn('Comparison not saved to the project wiki', { comparison: record.id, error: error.message });
      this.comparisonNotice?.(record, `Comparison history could not be saved: ${error.message}. The chat card retains the result, including any completed Undo.`);
      return false;
    }
  },

  comparisonNotice(record, text) {
    this.log.warn('Comparison history notice', { comparison: record.id, message: text });
    const session = this.data.sessions.find(session => session.id === record.sessionId) || this.data.sessions.find(session => session.workspace === record.project);
    if (session && !session.items.some(item => item.comparisonWarning === text))
      session.items.push({ id: randomUUID(), type: 'notice', localOnly: true, createdAt: Date.now(), comparisonWarning: text, text });
  },

  pruneSkillStore(project) {
    if (!this.wikiStore) return;
    try {
      const wiki = this.wikiStore.location(this.lessonWorkspace(project)).root, root = path.join(wiki, '..', 'skills');
      const controllers = this.agents?.allControllers() || [this];
      const primary = this.agents?.primary || this;
      // Other projects may run continuously; only active readers of this project retain its revisions.
      const workspaceKey = workspace => {
        const resolved = path.resolve(this.lessonWorkspace(workspace));
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      };
      if (controllers.some(controller => {
        if (controller.cleanupPending?.size || controller.data.workerCleanup?.length) return true;
        const wikiKey = process.platform === 'win32' ? wiki.toLowerCase() : wiki;
        if (controller.busy && controller.turnSkillDirectories?.get(controller.busy)?.has(wikiKey)) return true;
        const active = controller.data.sessions.filter(session => session.id &&
          ((controller.busy && controller.busy === session.id) || controller.activeTurns?.has(session.id)));
        return ((controller.busy || controller.activeTurns?.size) && !active.length) ||
          active.some(session => !session.workspace || workspaceKey(session.workspace) === workspaceKey(project));
      })) {
        (primary.skillCleanupDue ||= new Set()).add(project);
        return;
      }
      primary.skillCleanupDue?.delete(project);
      const saved = comparisons.readComparisons(wiki, { strict: true });
      const cards = controllers.flatMap(controller => controller.data.sessions.flatMap(session => session.items
        .map(item => item.hubComparison).filter(view => view?.adopted?.root === root)));
      const retained = new Map(saved.map(record => [record.id, record]));
      for (const card of cards) retained.set(card.id, retained.has(card.id) ? { ...retained.get(card.id), adopted: card.adopted } : card);
      const records = [...retained.values()]
        .sort((a, b) => (b.number || 0) - (a.number || 0) || (b.at || 0) - (a.at || 0)).slice(0, comparisons.MAX_RECORDS);
      records.push(...saved.filter(record => record.recovery && !records.some(entry => entry.id === record.id)));
      const pending = Object.values(primary.data.comparisons || {});
      const busy = new Set((this.agents?.pendingJobs() || []).map(({ session }) => this.agents.workspaces.record(session.workspace)?.comparisonId));
      pending.push(...saved.filter(record => busy.has(record.id)));
      const removed = new Set(skillPackages.prune(root, records, pending));
      for (const controller of controllers) {
        let changed = false;
        for (const session of controller.data.sessions) for (const item of session.items) {
          const adopted = item.hubComparison?.adopted;
          if (adopted?.root === root && !adopted.undoneAt && (removed.has(adopted.revision) || removed.has(adopted.previous))) {
            adopted.expiredAt = Date.now(); changed = true;
          }
        }
        if (changed) controller.save();
      }
    } catch (error) { this.log.warn('Skill snapshot cleanup deferred', { error: error.message }); }
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

  // A project-rule comparison's changed run gets the rule from Harness, so no file in either copy differs.
  comparedRule(session) {
    const comparison = this.comparisonOf(session);
    const run = comparison?.record.target === 'project' && comparison.record.runs.find(entry => entry.index === comparison.copy.index);
    return run?.variant ? `\nProject rule under comparison (follow it unless it conflicts with the request):\n${comparison.record.change.trim()}\n` : '';
  },
};
