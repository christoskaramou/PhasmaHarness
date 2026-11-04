'use strict';
// Dreaming (src/dream.cjs) wired into the task gate: after a task settles, at most once a day per project and only with
// enough new evidence, the strongest model reviews the project's memory across its chats in the background. Its rules go
// on trial, its notes join the notes, and each change posts a notice with Undo in the chat whose task settled. These are
// Controller methods (see ../controller.cjs); `this` is the Controller.
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { redact } = require('../log.cjs');
const { readLessons, lessonKey } = require('../lessons.cjs');
const dream = require('../dream.cjs');
const chatScan = require('../chat-scan.cjs');
const trials = require('../trials.cjs');

const sentence = text => (/[.!?]$/.test(text) ? text : `${text}.`);

// Settings → General → Dream model, one for every bot: the model picked there while it is usable, else Hub's model at its
// highest effort.
function dreamPreset(controller) {
  const owner = controller.agents?.primary || controller;
  const id = owner.data.settings.dreamModel;
  // A Dream model the user set dreams or nothing: unavailable or at its usage limit, the dream waits rather than
  // running on another model (2026-11-04, the user's rule). "hub" is Hub's model at its highest effort.
  if (id && id !== 'hub') {
    const picked = owner.catalog().find(p => p.worker && p.id === id);
    return picked && owner.available(picked) && !owner.limits?.limited(picked.provider || 'codex', picked.model) ? picked : null;
  }
  return owner.strongestPreset();
}

module.exports = {
  // Never throws or delays the gate. Returns the pending call, or null when no dream is due.
  maybeDream(session) {
    try {
      return this.startDream(session).pending || null;
    } catch (error) {
      this.log.warn('Dream skipped', { error: error.message });
      return null;
    }
  },

  // Settings > General > Dream now: a dream for the open chat's project, without the once-a-day wait, the five-new-items
  // minimum or the Dream switch (the user asked for this one). It still needs something unread, a usable model and room in
  // the background usage limit, and still reads chats only with the chat checker's consent. Resolves to the run's record.
  async dreamNow(id) {
    const session = this.session(id);
    const started = this.startDream(session, { manual: true });
    if (started.skipped)
      throw new Error(started.skipped);

    const run = await started.pending;
    return { ...run, project: started.project };
  },

  // Starts a dream: { pending } (resolving to the saved run) or { skipped: why }.
  startDream(session, { manual = false } = {}) {
    if (!this.wikiStore)
      return { skipped: 'Project memory is unavailable here.' };
    if (this.comparisonOf(session))
      return { skipped: 'Comparison runs do not dream.' };
    if (!session.workspace)
      return { skipped: 'Open a chat in a project folder first.' };

    const project = this.lessonWorkspace(session.workspace);
    const root = this.wikiStore.ensure(project).root;
    if (!manual && !dream.due(root))
      return { skipped: 'A dream already ran today.' };

    const owner = this.agents?.primary || this;
    // Settings > General > Dream; on unless turned off.
    if (!manual && owner.data.settings.dream === false)
      return { skipped: 'Dream is off.' };

    const model = dreamPreset(this);
    if (!model || !owner.available(model))
      return { skipped: 'No model is available to dream with.' };
    if (this.agents?.backgroundQuota(this, session, model))
      return { skipped: 'Background work is at its usage limit.' };

    const state = dream.readDreams(root);
    const ruleRecords = trials.readRules(root);
    const notes = chatScan.readNotes(root);
    // Chats are read only with the user's consent to chat reading (a Secondary model saved for Hub, or, while none is
    // saved, the checker picked before Secondary models; and Find rules from your replies on); otherwise the dream works
    // from lessons alone. The old router standing in for an unsaved Secondary model is not consent, and Off is a refusal.
    const consent = owner.secondarySaved?.() ? owner.secondaryPick() : this.sharedChatScanner();
    const readChats = !!consent && owner.data.settings.scanReplies !== false;
    const sessions = readChats ? this.projectSessions(project) : [];
    const input = dream.dreamInput({ sessions, lessons: readLessons(root), rules: this.learnedRules(project, ruleRecords), ruleRecords, notes,
      since: state.lastAt, read: state.read, earlier: state.earlier });
    if (input.newEvidence < (manual ? 1 : dream.MIN_NEW))
      return { skipped: manual ? `Nothing new to read in ${path.basename(project)}${readChats ? '' : ' (your replies are read only while Hub has a Secondary model)'}.`
        : 'Not enough new evidence yet.' };
    if (!dream.claimDream(root, Date.now(), manual))
      return { skipped: 'A dream already ran today.' };

    const label = model.label || model.model;
    const request = { instructions: dream.INSTRUCTIONS, prompt: input.prompt, schema: dream.SCHEMA, timeoutMs: 120000 };
    const abort = new AbortController();
    (this.reflections ||= new Set()).add(abort);
    const read = { chats: Object.keys(input.positions).length, messages: input.shown };
    const pending = owner.smartRouter.complete(request, model, abort)
      .then(({ decision }) => {
        const results = dream.checkDream(decision, { sources: input.sources, memory: input.memory, noteIds: notes.map(note => note.id) });
        const changes = results.filter(result => !result.rejected && result.kind !== 'seen');
        const done = changes.map(result => [result, this.applyDream(session, root, input.sources, notes, result)]).filter(([, applied]) => applied);
        const seen = results.filter(result => result.kind === 'seen' && !result.rejected)
          .map(result => ({ id: randomUUID(), problem: result.text, moment: result.moment, at: Date.now() }));
        // An earlier mistake a rule or note was built on is used up; positions move only now, past what this dream read.
        const usedEarlier = done.flatMap(([result]) => (result.sources || []).map(id => input.sources.get(id)?.earlier?.id)).filter(Boolean);
        const run = { at: Date.now(), model: label, hash: input.hash, manual, read, applied: done.map(([, applied]) => applied), seen: seen.length,
          rejected: results.filter(result => result.rejected) };
        dream.saveRun(root, run, { positions: input.positions, chatIds: readChats ? sessions.map(chat => chat.id) : null, seen, usedEarlier });
        return run;
      })
      .catch(error => {
        if (abort.signal.aborted)
          return { at: Date.now(), model: label, manual, read, error: 'The app closed during the dream.' };
        this.log.warn('Dream failed', { model: label, error: error.message });
        const run = { at: Date.now(), model: label, hash: input.hash, manual, read, error: error.message };
        dream.saveRun(root, run);
        return run;
      })
      .finally(() => this.reflections.delete(abort));
    return { pending, project };
  },

  // The chats of every agent whose project is this one (batch copies count toward their source project).
  projectSessions(project) {
    // A bot whose own Secondary model is Off (saved or inherited) keeps its chats out of the dream.
    const controllers = (this.agents?.allControllers?.() || [this]).filter(controller => controller.data?.settings?.secondaryModel !== 'off');
    return controllers.flatMap(controller => controller.data?.sessions || [])
      .filter(session => !session.archived && session.workspace && this.lessonWorkspace(session.workspace) === project);
  },

  // One checked action: what it changed, for the run record, or null when nothing changed.
  applyDream(session, root, sources, notes, result) {
    if (result.kind === 'forget') {
      const note = notes.find(entry => entry.id === result.id);
      if (!note || !chatScan.removeNote(root, note.id))
        return null;

      this.ruleNotice(session, { text: `While reviewing past sessions, forgot the note "${note.note}": ${sentence(result.reason || 'no longer needed')}`,
        root, note, kind: 'noteForgotten' });
      return { kind: 'forget', id: note.id, text: note.note, reason: result.reason };
    }

    // Requests from the chats it quoted, so the rule or note rides tasks like them; a quoted lesson gives a rule its check.
    const quoted = result.sources.map(id => sources.get(id));
    const lesson = quoted.find(source => source.lesson?.situation?.error)?.lesson;
    const goal = redact(quoted.flatMap(source => source.requests || [source.lesson?.goal || source.earlier?.problem || '']).join(' ')).slice(0, 1000);
    if (result.kind === 'note') {
      const note = chatScan.addNote(root, { note: result.text, problem: result.reason, moment: result.moments[0], goal });
      if (!note)
        return null;

      this.ruleNotice(session, { text: `While reviewing past sessions, saved a note for similar tasks: "${note.note}"`,
        root, noteId: note.id, kind: 'noteAdded' });
      return { kind: 'note', text: note.note, reason: result.reason };
    }

    const before = new Set(trials.readRules(root).map(record => record.id));
    const record = trials.startTrial(root, lesson
      ? { rule: result.text, lessonKey: lessonKey(lesson), check: lesson.failures[0].check, error: lesson.situation.error, goal: lesson.goal, source: 'a dream' }
      : { rule: result.text, lessonKey: null, check: null, error: result.reason, goal, source: 'a dream' });
    if (!record || before.has(record.id))
      return null;

    this.ruleNotice(session, { text: `While reviewing past sessions, noticed a repeated mistake: ${sentence(result.reason || 'it came up more than once')} ` +
      `Trying the rule "${record.rule}" on similar tasks.`, root, ruleId: record.id, kind: 'trialStarted' });
    return { kind: 'rule', text: record.rule, reason: result.reason };
  },
};
