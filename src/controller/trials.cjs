'use strict';
// Trial rules on real work (src/trials.cjs): carried by matching tasks, decided by their checks, kept in INSTRUCTIONS.md
// or dropped with a line in the chat. These are Controller methods (see ../controller.cjs); `this` is the Controller.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const trials = require('../trials.cjs');
const { projectInstructions } = require('../workspace/project-instructions.cjs');

module.exports = {
  // The trial rules a new task carries, as their own capped block, with what it carried.
  trialRulesFor(workspace, text, checks) {
    const none = { block: null, ids: [], lessonKeys: [] };
    if (!this.wikiStore)
      return none;

    try {
      const root = this.wikiStore.location(this.lessonWorkspace(workspace)).root;
      const { block, records } = trials.trialBlock(trials.matchingTrials(trials.readRules(root), text, checks.map(check => check.name)));
      return { block, ids: records.map(record => record.id), lessonKeys: records.map(record => record.lessonKey).filter(Boolean) };
    } catch {
      return none;
    }
  },

  // A settled task's checks decide the trial rules it carried. Never for comparison runs.
  recordTrials(session, task) {
    if (!task.trialRuleIds?.length || !this.wikiStore || this.comparisonOf(session))
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

  // A line in the chat the user follows: the owner's chat for a delegated job, else this one.
  ruleNotice(session, notice) {
    const job = session.delegation && !session.delegation.delivered ? session.delegation : null;
    const owner = job && this.agents ? this.agents.owner(job.owner || job.source) : this;
    const target = job && this.agents ? owner.session(job.owner || job.source) : session;
    target.items.push({ id: randomUUID(), type: 'notice', localOnly: true, createdAt: Date.now(), text: notice.text, ruleNotice: notice });
    owner.save();
    owner.changed();
  },

  // Undo of a kept rule: its line leaves INSTRUCTIONS.md and the rule is marked removed.
  undoRule(id, noticeId) {
    const item = this.session(id).items.find(entry => entry.id === noticeId && entry.ruleNotice?.kind === 'kept');
    if (!item || item.ruleNotice.undoneAt)
      throw new Error('There is no kept rule to undo here.');

    const { file, line, root, ruleId } = item.ruleNotice;
    const body = fs.readFileSync(file, 'utf8');
    if (!body.includes(line))
      throw new Error('The rule is no longer in INSTRUCTIONS.md as it was added; edit the file by hand.');

    fs.writeFileSync(file, trials.removeKeptLine(body, line));
    trials.updateRules(root, records => Object.assign(records.find(entry => entry.id === ruleId) || {},
      { state: 'removed', endedAt: Date.now(), reason: 'undone from the chat' }));
    item.ruleNotice.undoneAt = Date.now();
    this.save();
    this.changed();
    return item;
  },
};
