'use strict';
// The chat scanner (src/chat-scan.cjs) wired into the chat: a real user message ends the exchange before it, which the
// chat checker (the model picked in Settings; Off by default) scans in the background; a worthy one goes to the
// strongest model, whose rule goes on trial and whose note rides matching tasks. The same model checks each response as
// it ends (checkResponse in task-gate.cjs). These are Controller methods (see
// ../controller.cjs); `this` is the Controller.
const fs = require('node:fs');
const path = require('node:path');
const { projectRules } = require('../workspace/project-instructions.cjs');
const { redact } = require('../log.cjs');
const chatScan = require('../chat-scan.cjs');
const trials = require('../trials.cjs');
const { checkReflection } = require('../reflection.cjs');

const sentence = text => (/[.!?]$/.test(text) ? text : `${text}.`);
const textOf = item => (item?.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');

module.exports = {
  // Never throws or delays the send: the exchange is taken now, before this message opens its own task, and scanned on
  // the next tick.
  scanAfterUserTurn(session, text) {
    try {
      const delegated = session.delegation && !session.delegation.delivered;
      if (!this.wikiStore || text.startsWith('[Router]') || delegated || this.comparisonOf(session))
        return;

      const exchange = this.exchangeOf(session);
      if (!exchange)
        return;

      setImmediate(() => {
        try {
          this.runScan(session, exchange, text);
        } catch (error) {
          this.log.warn('Chat scan skipped', { error: error.message });
        }
      });
    } catch (error) {
      this.log.warn('Chat scan skipped', { error: error.message });
    }
  },

  // The exchange the new message reacts to: in a worker chat, the last task's run; in Bot's chat, the last request with
  // the run of the one job it delegated (none or several: skipped, since the rule would have no single project).
  // `taskSession` is the chat that holds the task.
  exchangeOf(session) {
    if (!this.isCoordinator()) {
      const task = (session.tasks || []).at(-1);
      const items = Number.isInteger(task?.startIndex) ? session.items.slice(task.startIndex) : [];
      if (!items.some(item => item.type === 'agentMessage'))
        return null;

      return { id: task.id, items, task, taskSession: session, workspace: session.workspace, request: task.goal || textOf(items[0]) };
    }

    const start = session.items.findLastIndex(item => item.type === 'userMessage' && !item.agentReply && !item.routineRun);
    const items = start >= 0 ? session.items.slice(start) : [];
    const results = items.filter(item => item.type === 'agentResult' && !item.internal);
    if (new Set(results.map(item => item.deliveryId)).size !== 1)
      return null;

    const result = results.at(-1);
    const worker = this.agents?.owner(result.sessionId).session(result.sessionId);
    const task = (worker?.tasks || []).findLast(entry => entry.assignmentId === result.deliveryId) || null;
    const run = task && Number.isInteger(task.startIndex) ? worker.items.slice(task.startIndex) : [];
    return { id: items[0].id, items: [items[0], ...run, ...items.slice(1)], task, taskSession: worker, workspace: result.workspace,
      request: textOf(items[0]) };
  },

  // The chat checker reads the exchange: its verdicts decide the chat rules the task carried, and a worthy mistake goes to
  // the rule writer. Each exchange once,
  // within the background usage limit.
  runScan(session, exchange, reaction) {
    const owner = this.agents?.primary || this;
    const scanner = this.chatScanner();
    if (!scanner || owner.data.settings.scanReplies === false || !owner.available(scanner))
      return null;
    if (this.agents?.backgroundQuota(this, session, scanner))
      return null;

    const project = this.lessonWorkspace(exchange.workspace);
    const root = this.wikiStore.ensure(project).root;
    if (!chatScan.claimScan(root, exchange.id))
      return null;

    const records = trials.readRules(root);
    const carriedIds = [...(exchange.task?.trialRuleIds || []), ...(exchange.task?.keptRuleIds || [])];
    const carried = records.filter(record => !record.check && carriedIds.includes(record.id));
    const rules = this.learnedRules(project, records);
    const input = chatScan.exchangeInput({ ...exchange, reaction, rules, carried });
    const request = { instructions: chatScan.SCAN_INSTRUCTIONS, prompt: input.prompt, schema: chatScan.SCAN_SCHEMA };
    return this.backgroundCall(owner, scanner, request, decision => {
      const scan = chatScan.checkScan(decision, input.plain, carried.map(record => record.id));
      if (exchange.task && scan.verdicts.length) {
        for (const record of trials.recordChatVerdicts(root, exchange.task, scan.verdicts))
          this.settleTrial(session, root, project, record);
      }

      return scan.worthy ? this.escalateExchange(session, exchange, reaction, root, rules, scan) : null;
    });
  },

  // At most five strongest-model calls per project per day; its rule goes on trial, its note joins the notes.
  escalateExchange(session, exchange, reaction, root, rules, scan) {
    const owner = this.agents?.primary || this;
    const big = this.strongestPreset();
    if (!big || this.agents?.backgroundQuota(this, session, big) || !chatScan.claimEscalation(root))
      return null;

    const input = chatScan.exchangeInput({ ...exchange, reaction, rules, flagged: scan }, chatScan.ESCALATION_LIMIT);
    const request = { instructions: chatScan.ESCALATION_INSTRUCTIONS, prompt: input.prompt, schema: chatScan.ESCALATION_SCHEMA };
    return this.backgroundCall(owner, big, request, decision => {
      const result = chatScan.checkEscalation(decision, input.plain);
      const goal = redact(exchange.request || '').slice(0, 1000);
      if (result.kind === 'rule')
        this.trialFromChat(session, root, goal, scan, result);
      else if (result.kind === 'note')
        this.noteFromChat(session, root, goal, scan, result);
    });
  },

  trialFromChat(session, root, goal, scan, result) {
    const before = new Set(trials.readRules(root).map(record => record.id));
    const record = trials.startTrial(root, { rule: result.text, lessonKey: null, check: null, error: scan.problem, goal, source: 'the chat' });
    if (!record || before.has(record.id))
      return;

    this.ruleNotice(session, { text: `Noticed: ${sentence(scan.problem)} Trying the rule "${record.rule}" on similar tasks.`,
      root, ruleId: record.id, kind: 'trialStarted' });
  },

  noteFromChat(session, root, goal, scan, result) {
    const note = chatScan.addNote(root, { note: result.text, problem: scan.problem, moment: result.moment, goal });
    if (!note)
      return;

    this.ruleNotice(session, { text: `Noticed: ${sentence(scan.problem)} Saved a note for similar tasks: "${note.note}"`,
      root, noteId: note.id, kind: 'noteAdded' });
  },

  // memory_note: an agent saves a fact itself. Nothing grounds it, so it only passes the reflection's safety guard, is
  // marked as the agent's, is capped per project per day, and posts a notice with Undo; the dream may forget it later.
  noteFromAgent(session, text, agentName = 'An agent') {
    if (!this.wikiStore)
      throw new Error('Notes are unavailable here.');
    if (this.comparisonOf(session))
      throw new Error('Comparison runs do not save notes.');

    const checked = checkReflection({ reflection: 'rule', rule: text, moment: text, reason: '' }, String(text || ''));
    if (checked.rejected)
      throw new Error(`Note not saved: ${checked.rejected.replace(/^rule/, 'note')}.`);

    const root = this.wikiStore.ensure(this.lessonWorkspace(session.workspace)).root;
    const today = chatScan.readNotes(root).filter(note => note.source === 'agent' && note.at > Date.now() - 24 * 60 * 60 * 1000);
    if (today.length >= chatScan.MAX_AGENT_NOTES_PER_DAY)
      throw new Error(`Note not saved: ${chatScan.MAX_AGENT_NOTES_PER_DAY} agent notes were saved in this project today.`);

    const request = [...session.items].reverse().find(item => item.type === 'userMessage');
    const goal = redact(textOf(request)).slice(0, 1000);
    const note = chatScan.addNote(root, { note: checked.rule, problem: `Saved by ${agentName}`, moment: '', goal, source: 'agent' });
    if (!note)
      return { saved: false, reason: 'The same note is already saved.' };

    this.ruleNotice(session, { text: `${agentName} saved a note for similar tasks: "${note.note}"`, root, noteId: note.id, kind: 'noteAdded' });
    return { saved: true, id: note.id };
  },

  // One structured call in the background, aborted on close like reflections.
  backgroundCall(owner, preset, request, then) {
    const abort = new AbortController();
    (this.reflections ||= new Set()).add(abort);
    return owner.smartRouter.complete({ ...request, timeoutMs: 60000 }, preset, abort)
      .then(({ decision }) => then(decision))
      .catch(error => {
        if (!abort.signal.aborted)
          this.log.warn('Chat scan failed', { model: preset.label || preset.model, error: error.message });
      })
      .finally(() => this.reflections.delete(abort));
  },

  // Every enabled model can be the chat checker (Settings).
  chatScanChoices() {
    return this.catalog().filter(p => (p.worker || p.router) && p.enabled !== false);
  },

  // The chat checker the user picked in Settings; none (Off, the default) means no scanning. Only that model checks: while
  // it is unavailable nothing is scanned.
  chatScanner() {
    // The bot's Secondary model; none while it is Off. Never saved: the chat checker picked before Secondary models.
    // Only the model the user picked reads chats: at its usage limit nothing is checked, rather than handing the
    // exchange to another provider's router (secondaryPick does that for routing only).
    return this.secondaryPick();
  },

  // The checker saved for the whole app before Secondary models; dreaming (per project, across bots) still reads it.
  sharedChatScanner() {
    const owner = this.agents?.primary || this;
    const picked = owner.chatScanChoices().find(p => p.id === owner.data.settings.chatScanModel);
    return picked && owner.available(picked) ? picked : null;
  },

  // The chat rule writer (and the dream's fallback model): the bot's own model at its highest effort within its cap; a
  // bot without one (legacy Auto), or with it at a usage limit, uses Hub's Secondary model as picked. Both send the chat,
  // so at that model's limit too there is none and the work is skipped, never moved to another provider's model.
  strongestPreset() {
    const top = this.higherEffort?.();
    // A bot with a model of its own uses only that one: at its usage limit there is none, not Hub's Secondary model.
    if (top || this.ownVariants?.().length) return top || null;
    return (this.agents?.primary || this).secondaryPick();
  },

  // The cascade's repair worker: the task's own model at its highest effort within the bot's cap, with image support
  // when the task had images. None when the task already ran at that effort.
  repairPreset(route, images = false) {
    const repair = this.higherEffort(route);
    return repair && (!images || repair.images !== false) ? repair : null;
  },

  // What the project already says: its AGENTS.md, the rules Harness kept and the rules riding matching tasks.
  learnedRules(project, records) {
    const body = projectRules(project) + this.keptRulesText(project);
    const riding = records.filter(record => record.state === 'trial' || (record.state === 'kept' && record.onDemand)).map(record => `- ${record.rule}`);
    return [body, ...riding].join('\n');
  },

  // The notes a new task carries as context.
  notesFor(workspace, text) {
    if (!this.wikiStore)
      return null;

    try {
      return chatScan.notesOffer(chatScan.readNotes(this.wikiStore.location(this.lessonWorkspace(workspace)).root), text);
    } catch {
      return null;
    }
  },
};
