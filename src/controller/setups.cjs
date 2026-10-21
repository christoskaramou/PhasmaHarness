'use strict';
// Proven setups (src/setups.cjs) wired into the task gate and Auto: a settled task routed by Auto records how its checks
// went on its preset; Auto reads the project's preferences before routing. These are Controller methods (see
// ../controller.cjs); `this` is the Controller.
const setups = require('../setups.cjs');

const tokensOf = (session, task) => {
  const usage = (task.attempts || []).map(attempt => session.routes?.find(route => route.turnId === attempt.turnId)?.turnUsage);
  return usage.length && usage.every(Boolean) ? usage.reduce((sum, turn) => sum + (turn.inputTokens || 0) + (turn.outputTokens || 0), 0) : null;
};

module.exports = {
  // Only tasks Auto routed (they carry its kind of work) whose checks ran; never comparison runs.
  recordSetup(session, task) {
    const outcome = setups.taskOutcome(task);
    if (!outcome || !task.kind || !task.route?.id || task.checksSkippedByRouter || !this.wikiStore || this.comparisonOf(session))
      return;

    try {
      const root = this.wikiStore.ensure(this.lessonWorkspace(session.workspace)).root;
      const record = { taskId: task.id, at: Date.now(), kind: task.kind, difficulty: task.difficulty || null, preset: task.route.id,
        label: task.route.label || task.route.model, provider: task.route.provider, outcome, tokens: tokensOf(session, task) };
      const { proven, rolledBack } = setups.recordSetup(root, record);
      if (proven)
        this.setupNotice(session, root, proven);
      if (rolledBack) {
        const why = outcome === 'failed' ? 'its checks still failed' : 'it needed a correction';
        this.ruleNotice(session, { text: `Auto stopped preferring ${rolledBack.label || rolledBack.preset} for ${rolledBack.kind} work in this project: ${why} on "${task.goal}".`,
          root, kind: 'setupDropped' });
      }
    } catch (error) {
      this.log.warn('Proven setup not recorded', { task: task.id, error: error.message });
    }
  },

  setupNotice(session, root, proven) {
    const [best, next] = proven.evidence;
    const tokens = best.tokens ? `, about ${Math.round(best.tokens / 1000)}k tokens each` : '';
    this.ruleNotice(session, { text: `Auto now uses ${proven.label || proven.preset} for ${proven.kind} work in this project: ${best.clean} of ${best.runs} ` +
      `tasks passed their checks first time${tokens} (${next.label || next.preset}: ${next.clean} of ${next.runs}).`,
    root, kind: 'setupPreferred', setupKind: proven.kind, preset: proven.preset });
  },

  // The project's preferences for Auto, as { kind of work: preset id }.
  provenSetupsFor(workspace) {
    if (!this.wikiStore)
      return {};

    try {
      const root = this.wikiStore.location(this.lessonWorkspace(workspace)).root;
      return Object.fromEntries(setups.readSetups(root).preferences.map(entry => [entry.kind, entry.preset]));
    } catch {
      return {};
    }
  },
};
