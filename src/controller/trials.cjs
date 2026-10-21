'use strict';
// Trial rules on real work (src/trials.cjs): carried by matching tasks, decided by their checks, kept in INSTRUCTIONS.md,
// dropped, or rolled back once kept, with a line in the chat. These are Controller methods (see ../controller.cjs); `this`
// is the Controller.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const trials = require('../trials.cjs');
const { projectInstructions } = require('../workspace/project-instructions.cjs');

const readText = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

module.exports = {
  // The trial rules a new task carries, as their own capped block, and the kept rules its INSTRUCTIONS.md gives it.
  trialRulesFor(workspace, text, checks) {
    const none = { block: null, ids: [], keptIds: [], lessonKeys: [] };
    if (!this.wikiStore)
      return none;

    try {
      const project = this.lessonWorkspace(workspace);
      const root = this.wikiStore.location(project).root;
      const names = checks.map(check => check.name);
      const records = trials.forgetDeletedKept(root, readText(path.join(project, 'INSTRUCTIONS.md')));
      const { block, records: carried } = trials.trialBlock(trials.matchingTrials(records, text, names));
      // A batch copy's worker reads the copy's own INSTRUCTIONS.md.
      const kept = trials.carriedKept(records, readText(path.join(workspace, 'INSTRUCTIONS.md')), names);
      return {
        block,
        ids: carried.map(record => record.id),
        keptIds: kept.map(record => record.id),
        lessonKeys: [...carried, ...kept].map(record => record.lessonKey).filter(Boolean),
      };
    } catch {
      return none;
    }
  },

  // A settled task's checks decide the trial and kept rules it carried. Never for comparison runs.
  recordTrials(session, task) {
    const carried = task.trialRuleIds?.length || task.keptRuleIds?.length;
    if (!carried || !this.wikiStore || this.comparisonOf(session))
      return;

    try {
      const project = this.lessonWorkspace(session.workspace);
      const root = this.wikiStore.ensure(project).root;
      for (const record of trials.recordOutcomes(root, task))
        this.settleTrial(session, root, project, record);
    } catch (error) {
      this.log.warn('Trial rules not updated', { task: task.id, error: error.message });
    }
  },

  settleTrial(session, root, project, record) {
    if (record.full) {
      this.ruleNotice(session, { text: `The rule "${record.rule}" held up in ${trials.KEEP_AFTER} matching tasks, but the Rules Harness learned section ` +
        `already has ${trials.MAX_KEPT} rules, so it stays on trial for now.`, root, ruleId: record.id, kind: 'full' });
      return;
    }

    if (record.state === 'dropped') {
      this.ruleNotice(session, { text: `Dropped the trial rule "${record.rule}": the failure it targets came back.`, root, ruleId: record.id, kind: 'dropped' });
      return;
    }

    if (record.state === 'rolled back') {
      this.rollBackRule(session, root, project, record);
      return;
    }

    try {
      projectInstructions(project, true);
      const line = trials.keepInInstructions(path.join(project, 'INSTRUCTIONS.md'), record);
      trials.updateRules(root, records => Object.assign(records.find(entry => entry.id === record.id) || {}, { line }));
      this.ruleNotice(session, { text: `Kept the rule "${record.rule}" in INSTRUCTIONS.md: ${trials.KEEP_AFTER} matching tasks passed its check without this failure.`,
        root, ruleId: record.id, kind: 'kept', file: path.join(project, 'INSTRUCTIONS.md'), line });
    } catch (error) {
      trials.updateRules(root, records => Object.assign(records.find(entry => entry.id === record.id) || {}, { state: 'trial', keptAt: null, reason: error.message }));
      this.log.warn('Trial rule not kept', { rule: record.id, error: error.message });
    }
  },

  // A kept rule whose failure came back leaves INSTRUCTIONS.md. A line already gone was deleted by hand: no notice.
  rollBackRule(session, root, project, record) {
    const file = path.join(project, 'INSTRUCTIONS.md');
    const restate = change => trials.updateRules(root, records => Object.assign(records.find(entry => entry.id === record.id) || {}, change));
    try {
      const body = readText(file);
      if (!body.includes(record.line)) {
        restate({ state: 'removed', reason: 'deleted from INSTRUCTIONS.md by hand' });
        return;
      }

      fs.writeFileSync(file, trials.removeKeptLine(body, record.line));
    } catch (error) {
      restate({ state: 'kept', endedAt: null, reason: null });
      this.log.warn('Kept rule not rolled back', { rule: record.id, error: error.message });
      return;
    }

    this.ruleNotice(session, { text: `Took the rule "${record.rule}" out of INSTRUCTIONS.md: the failure it targets came back after it was kept.`,
      root, ruleId: record.id, kind: 'rolledBack', file, line: record.line });
  },

  // A line in the chat the user follows: the owner's chat for a delegated job, else this one.
  ruleNotice(session, notice) {
    const job = session.delegation && !session.delegation.delivered ? session.delegation : null;
    const owner = job && this.agents ? this.agents.owner(job.owner || job.source) : this;
    const target = job && this.agents ? owner.session(job.owner || job.source) : session;
    target.items.push({ id: randomUUID(), type: 'notice', localOnly: true, createdAt: Date.now(), text: notice.text, ruleNotice: notice });
    owner.save();
    owner.changed();
  },

  // Undo of a kept rule: its line leaves INSTRUCTIONS.md and the rule is marked removed. Undo of a rollback puts the line
  // back and pins the rule, so it is never rolled back automatically again; the user's choice may go past MAX_KEPT.
  undoRule(id, noticeId) {
    const item = this.session(id).items.find(entry => entry.id === noticeId && ['kept', 'rolledBack'].includes(entry.ruleNotice?.kind));
    if (!item || item.ruleNotice.undoneAt)
      throw new Error('There is no rule change to undo here.');

    const { file, line, root, ruleId, kind } = item.ruleNotice;
    if (kind === 'rolledBack') {
      const record = trials.readRules(root).find(entry => entry.id === ruleId);
      if (record?.state !== 'rolled back')
        throw new Error('The rule changed since it was taken out; edit INSTRUCTIONS.md by hand.');

      const restored = trials.keepInInstructions(file, record);
      trials.updateRules(root, records => Object.assign(records.find(entry => entry.id === ruleId) || {},
        { state: 'kept', pinned: true, endedAt: null, reason: null, line: restored }));
    } else {
      const body = fs.readFileSync(file, 'utf8');
      if (!body.includes(line))
        throw new Error('The rule is no longer in INSTRUCTIONS.md as it was added; edit the file by hand.');

      fs.writeFileSync(file, trials.removeKeptLine(body, line));
      trials.updateRules(root, records => Object.assign(records.find(entry => entry.id === ruleId) || {},
        { state: 'removed', endedAt: Date.now(), reason: 'undone from the chat' }));
    }
    item.ruleNotice.undoneAt = Date.now();
    this.save();
    this.changed();
    return item;
  },
};
