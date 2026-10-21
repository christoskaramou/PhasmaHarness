'use strict';
// After a lesson is recorded, the router's model reflects on that task's run (src/reflection.cjs) in the background and
// its proposal lands on the lesson. These are Controller methods (see ../controller.cjs); `this` is the Controller.
const fs = require('node:fs');
const path = require('node:path');
const { capabilities } = require('../providers/capabilities.cjs');
const { SCHEMA, INSTRUCTIONS, reflectionInput, checkReflection } = require('../reflection.cjs');
const { readLessons, saveReflection, lessonKey } = require('../lessons.cjs');
const trials = require('../trials.cjs');

module.exports = {
  // One call per lesson input on the user's router model (cached by the input's hash), skipped while background work is
  // paused at the usage limit. Returns the pending call, or null when nothing was asked.
  reflectOnLesson(session, task, lesson, root, project) {
    const owner = this.agents?.primary || this;
    const router = owner.effectiveRouter();
    if (!router || !owner.available(router) || capabilities(router.provider || 'codex').structured === false)
      return null;
    if (this.agents?.backgroundQuota(this, session, router))
      return null;

    let rules = '';
    try {
      rules = fs.readFileSync(path.join(project, 'INSTRUCTIONS.md'), 'utf8');
    } catch { /* no project entry yet */ }
    const { prompt, plain, hash } = reflectionInput(task, session.items.slice(task.startIndex || 0), rules);
    const key = lessonKey(lesson);
    if (readLessons(root).find(record => lessonKey(record) === key)?.reflection?.hash === hash)
      return null;

    const abort = new AbortController();
    (this.reflections ||= new Set()).add(abort);
    return owner.smartRouter.complete({ instructions: INSTRUCTIONS, prompt, schema: SCHEMA, timeoutMs: 60000 }, router, abort)
      .then(({ decision }) => {
        const result = checkReflection(decision, plain);
        saveReflection(root, key, { hash, at: Date.now(), model: router.label || router.model, ...result });
        this.trialFromReflection(root, key, result);
      })
      .catch(error => {
        if (!abort.signal.aborted)
          this.log.warn('Reflection failed', { task: task.id, error: error.message });
      })
      .finally(() => this.reflections.delete(abort));
  },

  // A grounded rule goes on trial (src/trials.cjs) only for a failure seen at least twice (harness2: a repeated failure
  // is evidence, a one-off is not), and not while its lesson waits for its paid comparison: it failed again while a
  // lesson or rule was carried, so the two-run test decides that rule first.
  trialFromReflection(root, key, result) {
    if (!result.rule || result.rejected)
      return;

    const record = readLessons(root).find(entry => lessonKey(entry) === key);
    if (!record?.situation?.error || (record.seen || 1) < 2 || (record.recurred && !record.suggestedAt))
      return;

    trials.startTrial(root, { rule: result.rule, lessonKey: key, check: record.failures[0].check, error: record.situation.error,
      goal: record.goal, source: 'a reflection' });
  },
};
