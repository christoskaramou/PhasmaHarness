'use strict';
// Trial rules on real work (src/trials.cjs): carried by matching tasks, decided by their checks, kept in INSTRUCTIONS.md,
// dropped, or rolled back once kept, with a line in the chat. These are Controller methods (see ../controller.cjs); `this`
// is the Controller.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const trials = require('../trials.cjs');
const chatScan = require('../chat-scan.cjs');
const setups = require('../setups.cjs');
const { projectInstructions } = require('../workspace/project-instructions.cjs');

const readText = file => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');

const keptBecause = record => (record.check ? `${trials.KEEP_AFTER} matching tasks passed its check without this failure`
  : `${trials.KEEP_AFTER} matching tasks avoided this mistake`);

module.exports = {
  // The trial and on-demand rules a new task carries, each as its own capped block, and the kept rules its
  // INSTRUCTIONS.md gives it.
  trialRulesFor(workspace, text, checks) {
    const none = { block: null, ids: [], keptIds: [], lessonKeys: [] };
    if (!this.wikiStore)
      return none;

    try {
      const project = this.lessonWorkspace(workspace);
      const root = this.wikiStore.location(project).root;
      const names = checks.map(check => check.name);
      const records = trials.forgetDeletedKept(root, readText(path.join(project, 'INSTRUCTIONS.md')));
      const onTrial = trials.trialBlock(trials.matchingTrials(records, text, names));
      const onDemand = trials.keptBlock(trials.matchingOnDemand(records, text, names));
      // A batch copy's worker reads the copy's own INSTRUCTIONS.md.
      const kept = [...trials.carriedKept(records, readText(path.join(workspace, 'INSTRUCTIONS.md')), names, text), ...onDemand.records];
      return {
        block: [onTrial.block, onDemand.block].filter(Boolean).join('\n\n') || null,
        ids: onTrial.records.map(record => record.id),
        keptIds: kept.map(record => record.id),
        lessonKeys: [...onTrial.records, ...kept].map(record => record.lessonKey).filter(Boolean),
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
    if (record.state === 'dropped') {
      this.ruleNotice(session, { text: `Dropped the trial rule "${record.rule}": ${record.reason}.`, root, ruleId: record.id, kind: 'dropped' });
      return;
    }

    if (record.state === 'rolled back') {
      this.rollBackRule(session, root, project, record);
      return;
    }

    if (record.onDemand) {
      this.ruleNotice(session, { text: `Kept the rule "${record.rule}" for the tasks it matches: ${keptBecause(record)}, and the ${trials.MAX_KEPT} rules ` +
        'in INSTRUCTIONS.md are all ones you put back.', root, ruleId: record.id, kind: 'kept' });
      return;
    }

    this.keepRule(session, root, project, record);
  },

  // A won trial's line joins INSTRUCTIONS.md. A rule it displaces is marked on demand before its line leaves the file,
  // so the next task never mistakes the missing line for a hand deletion.
  keepRule(session, root, project, record) {
    const file = path.join(project, 'INSTRUCTIONS.md');
    let line;
    try {
      projectInstructions(project, true);
      line = trials.keepInInstructions(file, record);
    } catch (error) {
      trials.updateRules(root, records => Object.assign(records.find(entry => entry.id === record.id) || {}, { state: 'trial', keptAt: null, reason: error.message }));
      this.log.warn('Trial rule not kept', { rule: record.id, error: error.message });
      return;
    }

    const moved = trials.updateRules(root, records => {
      Object.assign(records.find(entry => entry.id === record.id) || {}, { line });
      const out = records.find(entry => entry.id === record.displaces && entry.state === 'kept' && !entry.onDemand && entry.line);
      if (!out)
        return null;

      Object.assign(out, { onDemand: true, line: null, movedLine: out.line });
      trials.makeRoomOnDemand(records, out.id);
      return { ...out };
    });
    if (moved) {
      try {
        fs.writeFileSync(file, trials.removeKeptLine(readText(file), moved.movedLine));
      } catch (error) {
        this.log.warn('Moved rule left in INSTRUCTIONS.md', { rule: moved.id, error: error.message });
      }
    }

    const note = moved ? ` "${moved.rule}" moved out of INSTRUCTIONS.md to keep it at ${trials.MAX_KEPT} rules; it is still used on the tasks it matches.` : '';
    this.ruleNotice(session, { text: `Kept the rule "${record.rule}" in INSTRUCTIONS.md: ${keptBecause(record)}.${note}`,
      root, ruleId: record.id, kind: 'kept', file, line, displacedId: moved?.id || null });
  },

  // A kept rule whose failure came back leaves INSTRUCTIONS.md, or stops riding the tasks it matches. A line already
  // gone was deleted by hand: no notice.
  rollBackRule(session, root, project, record) {
    if (record.onDemand) {
      this.ruleNotice(session, { text: `Stopped adding the rule "${record.rule}" to the tasks it matches: ${record.reason}.`,
        root, ruleId: record.id, kind: 'rolledBack' });
      return;
    }

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

    this.ruleNotice(session, { text: `Took the rule "${record.rule}" out of INSTRUCTIONS.md: ${record.reason}.`,
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

  undoRule(id, noticeId) {
    const kinds = ['kept', 'rolledBack', 'trialStarted', 'noteAdded', 'setupPreferred'];
    const item = this.session(id).items.find(entry => entry.id === noticeId && kinds.includes(entry.ruleNotice?.kind));
    if (!item || item.ruleNotice.undoneAt)
      throw new Error('There is no rule change to undo here.');

    const { kind, root, ruleId, noteId } = item.ruleNotice;
    if (kind === 'rolledBack')
      this.undoRollback(item.ruleNotice);
    else if (kind === 'kept')
      this.undoKeep(item.ruleNotice);
    else if (kind === 'noteAdded')
      chatScan.removeNote(root, noteId);
    else if (kind === 'setupPreferred')
      setups.dropPreference(root, item.ruleNotice.setupKind, item.ruleNotice.preset);
    else
      this.undoTrial(root, ruleId);

    item.ruleNotice.undoneAt = Date.now();
    this.save();
    this.changed();
    return item;
  },

  // Undo of a kept rule: its line leaves INSTRUCTIONS.md (if it had one), the rule is marked removed, and a rule it moved
  // out goes back in, if it is still kept for matching tasks.
  undoKeep({ file, line, root, ruleId, displacedId }) {
    // A rule moved out of INSTRUCTIONS.md since then has no line left there.
    const record = trials.readRules(root).find(entry => entry.id === ruleId);
    if (line && !record?.onDemand) {
      const body = fs.readFileSync(file, 'utf8');
      if (!body.includes(line))
        throw new Error('The rule is no longer in INSTRUCTIONS.md as it was added; edit the file by hand.');

      fs.writeFileSync(file, trials.removeKeptLine(body, line));
    }

    trials.updateRules(root, records => Object.assign(records.find(entry => entry.id === ruleId) || {},
      { state: 'removed', endedAt: Date.now(), reason: 'undone from the chat' }));
    const moved = trials.readRules(root).find(entry => entry.id === displacedId && entry.state === 'kept' && entry.onDemand && entry.movedLine);
    if (!moved)
      return;

    const restored = trials.keepInInstructions(file, moved);
    trials.updateRules(root, records => Object.assign(records.find(entry => entry.id === displacedId) || {}, { onDemand: false, line: restored, movedLine: null }));
  },

  // Undo of a rule the chat scanner put on trial takes it off; one kept since then is undone from its kept notice.
  undoTrial(root, ruleId) {
    const record = trials.readRules(root).find(entry => entry.id === ruleId);
    if (record?.state !== 'trial')
      throw new Error('The rule left its trial since; undo it from its later notice.');

    trials.updateRules(root, records => Object.assign(records.find(entry => entry.id === ruleId) || {},
      { state: 'removed', endedAt: Date.now(), reason: 'undone from the chat' }));
  },

  // Undo of a rollback puts the rule back (its line, or on demand) and pins it, so it is never rolled back automatically
  // again; the user's choice may go past MAX_KEPT.
  undoRollback({ file, root, ruleId }) {
    const record = trials.readRules(root).find(entry => entry.id === ruleId);
    if (record?.state !== 'rolled back')
      throw new Error('The rule changed since it was taken out; edit INSTRUCTIONS.md by hand.');

    const line = record.onDemand ? null : trials.keepInInstructions(file, record);
    trials.updateRules(root, records => Object.assign(records.find(entry => entry.id === ruleId) || {},
      { state: 'kept', pinned: true, endedAt: null, reason: null, line }));
  },
};
