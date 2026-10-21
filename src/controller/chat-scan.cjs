'use strict';
// The chat scanner (src/chat-scan.cjs) wired into the chat: a real user message ends the exchange before it, which the
// chat checker (the model picked in Settings; Off by default) scans in the background; a worthy one goes to the
// strongest model, whose rule goes on trial and whose note rides matching tasks. These are Controller methods (see
// ../controller.cjs); `this` is the Controller.
const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('../log.cjs');
const { capabilities } = require('../providers/capabilities.cjs');
const { capCatalog } = require('../routing/effort-cap.cjs');
const { strongest } = require('../routing/smart-router.cjs');
const chatScan = require('../chat-scan.cjs');
const trials = require('../trials.cjs');

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
  exchangeOf(session) {
    if (!this.isCoordinator()) {
      const task = (session.tasks || []).at(-1);
      const items = Number.isInteger(task?.startIndex) ? session.items.slice(task.startIndex) : [];
      if (!items.some(item => item.type === 'agentMessage'))
        return null;

      return { id: task.id, items, task, workspace: session.workspace, request: task.goal || textOf(items[0]) };
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
    return { id: items[0].id, items: [items[0], ...run, ...items.slice(1)], task, workspace: result.workspace, request: textOf(items[0]) };
  },

  // The chat checker reads the exchange: its verdicts decide the chat rules the task carried, and a worthy mistake goes
  // to the strongest model. Each exchange once, within the background usage limit.
  runScan(session, exchange, reaction) {
    const owner = this.agents?.primary || this;
    const scanner = this.chatScanner();
    if (!scanner || !owner.available(scanner) || capabilities(scanner.provider || 'codex').structured === false)
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

  // Every enabled model that answers in a schema can be the chat checker (Settings).
  chatScanChoices() {
    return this.catalog().filter(p => (p.worker || p.router) && p.enabled !== false && capabilities(p.provider || 'codex').structured !== false);
  },

  // The chat checker the user picked in Settings; none (Off, the default) means no scanning. Only that model checks: while
  // it is unavailable nothing is scanned.
  chatScanner() {
    const owner = this.agents?.primary || this;
    const picked = owner.chatScanChoices().find(p => p.id === owner.data.settings.chatScanModel);
    return picked && owner.available(picked) ? picked : null;
  },

  // The strongest enabled worker that answers in a schema, within the effort cap and usage limits, at medium effort when
  // it has one. Without measured scores (offline, models too new) the router's model writes it, so a flag is not lost.
  strongestPreset() {
    const owner = this.agents?.primary || this;
    const structured = owner.catalog().filter(p => p.worker && owner.available(p) && capabilities(p.provider || 'codex').structured !== false);
    const capped = capCatalog(structured, owner.data.settings.effortCap).filter(p => !owner.limits?.limited(p.provider || 'codex', p.model));
    // Measured scores join the presets here, as the router's own catalog gets them.
    const usable = owner.smartRouter.benchmarks?.catalog(capped) || capped;
    const best = strongest(usable);
    if (!best)
      return owner.effectiveRouter();

    const same = usable.filter(p => p.model === best.model && (p.provider || 'codex') === (best.provider || 'codex'));
    return same.find(p => p.effort === 'medium') || best;
  },

  // What the project already says: its INSTRUCTIONS.md and the rules riding matching tasks.
  learnedRules(project, records) {
    let body = '';
    try {
      body = fs.readFileSync(path.join(project, 'INSTRUCTIONS.md'), 'utf8');
    } catch { /* no project entry yet */ }
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
