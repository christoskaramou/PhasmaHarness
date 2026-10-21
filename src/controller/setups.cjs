'use strict';
// Proven setups (src/setups.cjs) wired into the task gate, the chat scanner and Auto: a settled task routed by Auto
// records how its checks went on its preset, or, without checks, how the user took it; Auto reads the project's
// preferences before routing. These are Controller methods (see ../controller.cjs); `this` is the Controller.
const setups = require('../setups.cjs');

const tokensOf = (session, task) => {
  const usage = (task.attempts || []).map(attempt => session.routes?.find(route => route.turnId === attempt.turnId)?.turnUsage);
  return usage.length && usage.every(Boolean) ? usage.reduce((sum, turn) => sum + (turn.inputTokens || 0) + (turn.outputTokens || 0), 0) : null;
};

module.exports = {
  // Only tasks Auto routed (they carry its kind of work) whose checks ran, or that the chat checker judged (`chat`: its
  // outcome and the chat the user wrote in, which gets the notices); never comparison runs. `session` holds the task.
  recordSetup(session, task, chat = null) {
    const outcome = chat ? chat.outcome : setups.taskOutcome(task);
    const skipped = !chat && task.checksSkippedByRouter;
    if (!outcome || !task.kind || !task.route?.id || skipped || !this.wikiStore || this.comparisonOf(session))
      return;

    try {
      const root = this.wikiStore.ensure(this.lessonWorkspace(session.workspace)).root;
      const record = { taskId: task.id, at: Date.now(), kind: task.kind, difficulty: task.difficulty || null, preset: task.route.id,
        label: task.route.label || task.route.model, provider: task.route.provider, outcome, tokens: tokensOf(session, task),
        ...(chat ? { source: 'chat' } : {}) };
      const { proven, rolledBack } = setups.recordSetup(root, record);
      const noticeIn = chat?.noticeIn || session;
      if (proven)
        this.setupNotice(noticeIn, root, proven);
      if (rolledBack) {
        const why = outcome === 'failed' ? 'its checks still failed' : chat ? 'you corrected it' : 'it needed a correction';
        this.ruleNotice(noticeIn, { text: `Auto stopped preferring ${rolledBack.label || rolledBack.preset} for ${rolledBack.kind} work in this project: ${why} on "${task.goal}".`,
          root, kind: 'setupDropped' });
      }
    } catch (error) {
      this.log.warn('Proven setup not recorded', { task: task.id, error: error.message });
    }
  },

  setupNotice(session, root, proven) {
    const [best, next] = proven.evidence;
    const tokens = best.tokens ? `, about ${Math.round(best.tokens / 1000)}k tokens each` : '';
    const judged = proven.evidence.reduce((sum, stats) => sum + stats.chat, 0);
    const runs = proven.evidence.reduce((sum, stats) => sum + stats.runs, 0);
    const how = !judged ? 'passed their checks first time' : judged === runs ? 'needed no correction from you' : 'were right first time, by their checks or your replies';
    this.ruleNotice(session, { text: `Auto now uses ${proven.label || proven.preset} for ${proven.kind} work in this project: ${best.clean} of ${best.runs} ` +
      `tasks ${how}${tokens} (${next.label || next.preset}: ${next.clean} of ${next.runs}).`,
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
