'use strict';
// Codex submissions and turn events: buffering, replay, turn completion, notifications and server requests.
// These are Controller methods (see ../controller.cjs); `this` is the Controller.
const { randomUUID } = require('node:crypto');
const { codexTurnLimited } = require('../providers/limits.cjs');
const { TOOL: CONTEXT_TOOL } = require('../workspace/context-search.cjs');
const { FINAL } = require('../tasks.cjs');
const { SUBMISSION_EVENT_LIMIT } = require('./shared.cjs');
const { readTaskStatus, stripTaskStatus } = require('../routing/task-state.cjs');

module.exports = {
  visible(item) {
    return item && ['userMessage', 'agentMessage', 'plan', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'contextCompaction'].includes(item.type);
  },

  beginSubmission(session, fields) {
    const submission = {
      token: randomUUID(), kind: fields.kind, backend: fields.backend, threadId: fields.threadId ?? null,
      messageId: fields.messageId ?? null, turnId: fields.turnId ?? null, taskId: fields.taskId ?? null,
      state: fields.turnId ? 'acknowledged' : 'submitting', buffer: fields.turnId ? null : [],
    };
    session.submission = submission;
    if (submission.turnId) {
      session.turnId = submission.turnId;
      this.activeTurns.set(session.id, submission.turnId);
    }
    return submission;
  },

  knownTurn(session, turnId) {
    if (!turnId) return false;
    if ((session.completedTurnIds || []).includes(turnId)) return true;
    return (session.routes || []).some(route => route.turnId === turnId);
  },

  bufferEarly(session, message) {
    const submission = session.submission;
    if (!submission || submission.turnId || submission.state !== 'submitting' || !submission.buffer) return false;
    if (message.params?.threadId !== submission.threadId) return false;
    if (submission.buffer.length >= SUBMISSION_EVENT_LIMIT) submission.buffer.shift();
    submission.buffer.push(message);
    return true;
  },

  replaySubmission(session, submission) {
    const events = submission.buffer || [];
    submission.buffer = null;
    for (const event of events) {
      if (session.submission !== submission || submission.state === 'completed') return;
      const turnId = event.params?.turn?.id || event.params?.turnId;
      if (turnId !== submission.turnId) continue;
      this.notification(event);
    }
  },

  releaseCompactionBuffer(session, submission) {
    const events = submission.buffer || [];
    submission.buffer = null;
    submission.state = 'acknowledged';
    for (const event of events) {
      if (session.submission !== submission || submission.state === 'completed') return;
      if (!submission.turnId && event.method === 'turn/started') {
        const id = event.params?.turn?.id;
        if (!id || this.knownTurn(session, id)) continue;
        submission.turnId = id;
      }
      if (!submission.turnId) continue;
      const turnId = event.params?.turn?.id || event.params?.turnId;
      if (turnId !== submission.turnId) continue;
      this.notification(event);
    }
  },

  turnEvent(method) {
    return method === 'turn/started' || method === 'turn/completed' || method === 'thread/compacted' ||
      method === 'thread/tokenUsage/updated' || method === 'model/rerouted' || method === 'error' ||
      (typeof method === 'string' && method.startsWith('item/'));
  },

  ignoredTurnEvent(session, method, p) {
    if (!this.turnEvent(method)) return false;
    const submission = session.submission;
    if (!submission || submission.state === 'completed' || submission.state === 'unconfirmed') return true;
    if (p?.threadId && submission.threadId && p.threadId !== submission.threadId) return true;
    if (method === 'turn/started' && submission.kind === 'compaction' && submission.state === 'acknowledged' && !submission.turnId)
      return this.knownTurn(session, p?.turn?.id);
    if (method === 'thread/compacted')
      return !(submission.kind === 'compaction' && submission.turnId && p?.turnId === submission.turnId);
    const turnId = p?.turn?.id || p?.turnId;
    if (!submission.turnId) return true;
    if (turnId && turnId !== submission.turnId) return true;
    if (!turnId && method !== 'error') return true;
    return false;
  },

  finishTurn(session, submission, outcome) {
    if (!submission || session.submission !== submission) return;
    if (submission.state === 'completed' || submission.state === 'unconfirmed') return;
    submission.state = 'completed';
    submission.buffer = null;
    if (submission.turnId) {
      const ids = session.completedTurnIds ||= [];
      if (!ids.includes(submission.turnId)) ids.push(submission.turnId);
      if (ids.length > 50) ids.splice(0, ids.length - 50); // ponytail: compaction only compares recent turn ids; persist a longer history if sessions outgrow this
    }
    this.cancelHelpers();
    for (const [id, request] of this.requests) if (request.params?.threadId === session.threadId) this.requests.delete(id);
    this.activeTurns.delete(session.id);
    session.turnId = null;
    session.compacting = false;
    session.status = outcome.status;
    session.error = outcome.error || null;
    if (outcome.status === 'failed') this.log.warn('Turn failed', { session: session.id, provider: session.activeProvider || 'codex', kind: submission.kind, error: String(outcome.error || '').slice(0, 300) });
    const maintenanceRoute = session.routes.find(route => route.messageId === submission.messageId && route.wikiMaintenanceTaskId);
    if (maintenanceRoute) {
      const origin = session.tasks?.find(task => task.id === maintenanceRoute.wikiMaintenanceTaskId);
      if (origin?.wikiMaintenance) {
        origin.wikiMaintenance.state = outcome.status === 'completed' ? 'finished' : 'interrupted';
        origin.wikiMaintenance.result = stripTaskStatus(session.items.filter(item => item.turnId === submission.turnId && item.type === 'agentMessage' && item.phase !== 'commentary').at(-1)?.text) || outcome.error || '';
        this.writeTaskFile(session, origin);
        // Opt-in, log only: judge what this update added (see src/workspace/wiki-assess.cjs).
        const before = this.wikiSnapshots.get(origin.id);
        this.wikiSnapshots.delete(origin.id);
        // Deferred, so the turn finishes and the session is free before the wiki is read again and compared.
        if (before && outcome.status === 'completed') this.wikiCheckDone = new Promise(resolve => setImmediate(() => resolve(this.assessWiki(session, origin, before))));
      }
    }
    if (submission.kind === 'turn' && !maintenanceRoute) this.updateJob(session, submission, outcome);
    if (submission.kind === 'turn') {
      try { this.traceTurn(session, submission, outcome, !!maintenanceRoute); } catch { /* tracing never affects a turn */ }
    }
    if (submission.kind === 'compaction' && outcome.status === 'completed') {
      session.notice = 'Context compacted. The visible chat history is retained.';
      session.noticeExpiresAt = Date.now() + 5000;
    }
    const stopping = this.stopping.has(session.id);
    this.stopping.delete(session.id);
    const task = submission.taskId ? (session.tasks || []).find(item => item.id === submission.taskId) : null;
    session.updated = Date.now();
    if (task && !FINAL.has(task.state)) {
      this.busy = session.id;
      this.changed();
      this.gateDone = this.runGate(session, task, submission, outcome, stopping);
      return;
    }
    if (this.busy === session.id) this.busy = null;
    this.changed();
    this.settle(session);
  },

  // One model per task: after each worker turn, record the task (its first request), the worker now running it and
  // the status the worker reported in its last line ([task: done|pending|needs-input]; "unknown" without one, and
  // "pending" for a failed or stopped turn). Corrections and other internal turns continue the current task.
  updateJob(session, submission, outcome) {
    const route = session.routes.find(r => r.messageId === submission.messageId);
    if (!route || route.directAnswer || route.wikiTaskId) return;
    const decision = session.jobDecision?.messageId === submission.messageId ? session.jobDecision : null;
    if (decision) session.jobDecision = null;
    const final = session.items.filter(item => item.turnId === submission.turnId && item.type === 'agentMessage' && item.phase !== 'commentary').at(-1);
    const status = outcome.status === 'completed' ? readTaskStatus(final?.text).status || 'unknown' : 'pending';
    const worker = { id: route.id, provider: route.provider || 'codex', model: route.model, effort: route.effort || null, label: route.label || route.id };
    const now = Date.now();
    if (!session.job || (decision && !decision.continues)) {
      const message = session.items.find(item => item.type === 'userMessage' && item.clientId === submission.messageId);
      const goal = decision?.goal ?? (message?.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      session.job = { goal: String(goal || '').slice(0, 2000), startedAt: now, worker, status, turns: 1, updatedAt: now };
    } else session.job = { ...session.job, worker, status, turns: (session.job.turns || 0) + 1, updatedAt: now };
  },

  // Decision trace: one entry per worker turn, with no prompt or reply text (see src/trace.cjs). The status the worker
  // reported is kept apart from the configured checks, which are traced when they are final (traceChecks).
  traceTurn(session, submission, outcome, maintenance) {
    const index = session.routes.findIndex(route => route.messageId === submission.messageId);
    const route = session.routes[index];
    if (!route || route.directAnswer) return;
    const previous = session.routes.slice(0, index).reverse().find(r => !r.directAnswer && !r.wikiMaintenanceTaskId);
    const task = submission.taskId ? (session.tasks || []).find(item => item.id === submission.taskId) : null;
    const final = session.items.filter(item => item.turnId === submission.turnId && item.type === 'agentMessage' && item.phase !== 'commentary').at(-1);
    const reported = outcome.status === 'completed' ? readTaskStatus(final?.text).status || 'unknown' : null;
    const usage = route.turnUsage || null; // the whole turn (Codex and Claude; Cursor reports none)
    const router = route.router || null;
    const source = { manual: 'manual', model: 'smart', jev: 'jev' }[route.source] || route.source || null;
    this.trace.record({
      event: 'turn', session: session.id, message: submission.messageId,
      kind: maintenance ? 'wiki-maintenance' : route.wikiTaskId ? 'wiki-proposal' : task && task.messageId !== submission.messageId ? 'correction' : 'message',
      route: { source, provider: route.provider || 'codex', model: route.model, effort: route.effort || null,
        sameTask: typeof route.sameTask === 'boolean' ? route.sameTask : null, routerPick: route.routerPick || null, escalatedFrom: route.escalatedFrom || null,
        failover: !!route.failover, switched: !!previous && ((previous.provider || 'codex') !== (route.provider || 'codex') || previous.model !== route.model) },
      assessment: route.assessment ? { taskKind: route.assessment.taskKind, risk: route.assessment.risk, uncertainty: route.assessment.uncertainty, needsChecks: route.assessment.needsChecks } : null,
      routing: router ? { classifier: router.model || null, calls: router.timings?.classifications?.length || null, durationMs: router.durationMs ?? null,
        tokens: router.usage?.totalTokens ?? null, costUsd: router.estimatedCostUsd ?? null, confidence: router.confidence ?? null } : null,
      worker: { durationMs: route.at ? Date.now() - route.at : null,
        tokens: usage ? { input: usage.inputTokens ?? null, cached: usage.cachedInputTokens ?? null, output: usage.outputTokens ?? null } : null },
      outcome: { status: outcome.status, limit: !!outcome.limit, reportedTask: reported },
    });
  },

  notification({ method, params: p }) {
    if (method === 'account/login/completed' && p.success) { this.refreshAccount().catch(error => { this.error = error.message; this.changed(); }); return; }
    if (method === 'serverRequest/resolved') { this.requests.delete(p.requestId); this.changed(); return; }
    if (method === 'account/rateLimits/updated') { this.codexUsage(p.rateLimits, true); this.changed(); return; }
    const session = this.data.sessions.find(s => s.threadId === p?.threadId);
    if (!session) return;
    if (this.bufferEarly(session, { method, params: p })) return;
    if (this.ignoredTurnEvent(session, method, p)) return;
    if (method === 'turn/started') {
      const submission = session.submission;
      if (submission?.kind === 'compaction' && !submission.turnId) submission.turnId = p.turn.id;
      session.turnId = p.turn.id; session.status = 'running';
      this.activeTurns.set(session.id, p.turn.id);
      if (session.routes.length && submission?.kind !== 'compaction') session.routes.at(-1).turnId = p.turn.id;
      if (this.stopping.has(session.id)) this.stop().catch(error => { session.error = error.message; this.changed(); });
    }
    if (method === 'thread/tokenUsage/updated') {
      session.usage = p.tokenUsage;
      const turn = session.routes.find(r => r.turnId === p.turnId);
      if (turn) {
        turn.usageReport = p.tokenUsage;
        // The whole turn for the decision trace: the thread total now, minus the total before the turn's first model
        // call (that report's total less its own call). Repeated reports of the same total change nothing.
        const { total, last } = p.tokenUsage || {};
        if (total && last) {
          const keys = ['inputTokens', 'cachedInputTokens', 'outputTokens'];
          turn.usageBase ??= Object.fromEntries(keys.map(key => [key, (total[key] || 0) - (last[key] || 0)]));
          turn.turnUsage = Object.fromEntries(keys.map(key => [key, Math.max(0, (total[key] || 0) - turn.usageBase[key])]));
        }
      }
    }
    if (method === 'model/rerouted') {
      session.notice = `Codex rerouted ${p.fromModel} to ${p.toModel}: ${p.reason}`;
      session.noticeExpiresAt = Date.now() + 5000;
      const turn = session.routes.find(r => r.turnId === p.turnId);
      if (turn) turn.actualModel = p.toModel;
    }
    // codex-cli 0.153.4 requires thread/compacted.turnId. A notification without that id was ignored above.
    if (method === 'thread/compacted') this.finishTurn(session, session.submission, { status: 'completed', error: null });
    if (method === 'turn/completed') {
      const status = ['completed', 'failed', 'interrupted'].includes(p.turn.status) ? p.turn.status : 'failed';
      const submission = session.submission, messageId = submission?.messageId;
      const route = session.routes.find(r => r.turnId === p.turn.id) || session.routes.at(-1);
      const provider = route?.provider || 'codex';
      const limit = status === 'failed' && codexTurnLimited(p.turn.error)
        ? { until: provider === 'codex' ? this.codexLimitReset() : null, reason: p.turn.error.message || 'Usage limit reached.' } : null;
      const outcome = { status, error: p.turn.error?.message || null, limit };
      this.finishTurn(session, submission, outcome);
      if (submission?.kind !== 'compaction') this.providerOutcome(session, provider, route?.model, messageId, outcome);
    }
    if ((method === 'item/started' || method === 'item/completed') && this.visible(p.item)) {
      p.item.turnId = p.turnId;
      p.item.routeLabel = session.routes.at(-1)?.label;
      const index = session.items.findIndex(i => i.id === p.item.id || (p.item.clientId && i.clientId === p.item.clientId));
      p.item.createdAt = (index >= 0 ? session.items[index].createdAt : null) || Date.now();
      if (index < 0) session.items.push(p.item);
      else session.items[index] = {
        ...session.items[index], ...p.item,
        ...(p.item.type === 'userMessage' && session.items[index].clientId ? { content: session.items[index].content, routeLabel: session.items[index].routeLabel } : {})
      };
    }
    if (method === 'item/agentMessage/delta') {
      let item = session.items.find(i => i.id === p.itemId);
      if (!item) { item = { id: p.itemId, turnId: p.turnId, type: 'agentMessage', text: '', routeLabel: session.routes.at(-1)?.label, createdAt: Date.now() }; session.items.push(item); }
      item.text += p.delta;
    }
    if (method === 'item/commandExecution/outputDelta') {
      const item = session.items.find(i => i.id === p.itemId);
      if (item) item.aggregatedOutput = ((item.aggregatedOutput || '') + p.delta).slice(-60000);
    }
    if (method === 'error') session.error = p.error?.message || p.message;
    session.updated = Date.now(); this.changed();
  },

  serverRequest(message) {
    if (message.method === 'item/tool/call') {
      const handler = message.params?.tool === CONTEXT_TOOL.name ? this.contextToolCall(message) : this.helperToolCall(message);
      handler.catch(() => { }); // Transport closure is reported by the client disconnect handler.
      return;
    }
    const supported = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
      'item/permissions/requestApproval', 'item/tool/requestUserInput', 'tool/requestUserInput', 'mcpServer/elicitation/request'];
    if (!supported.includes(message.method)) {
      this.client.rejectRequest(message.id, `This client cannot handle ${message.method}.`);
      return;
    }
    this.requests.set(message.id, message); this.changed();
  },
};
