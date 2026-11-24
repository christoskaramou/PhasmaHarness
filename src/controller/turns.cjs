'use strict';
// Codex submissions and turn events: buffering, replay, turn completion, notifications and server requests.
// These are Controller methods (see ../controller.cjs); `this` is the Controller.
const { randomUUID } = require('node:crypto');
const { codexTurnLimited } = require('../providers/limits.cjs');
const { TOOL: CONTEXT_TOOL } = require('../workspace/context-search.cjs');
const { FINAL } = require('../tasks.cjs');
const { SUBMISSION_EVENT_LIMIT } = require('./shared.cjs');
const { readTaskStatus, stripTaskStatus } = require('../routing/task-state.cjs');
const { normalizedUsage } = require('../job-budgets.cjs');
const { codexInfo, codexDetailsText, appendCodexSummary } = require('../providers/codex.cjs');

function infoId(turnId, id) { return 'info:' + JSON.stringify([turnId, id]); }

module.exports = {
  infoItem(turnId, event, saved) {
    if (!turnId || typeof event.id !== 'string' || !event.id || !['agent', 'reasoning', 'progress'].includes(event.kind)) return null;
    return { ...saved, type: 'info', id: infoId(turnId, event.id), turnId, kind: event.kind,
      title: event.title || saved?.title || ({ agent: 'Agent', reasoning: 'Thinking', progress: 'Progress' })[event.kind],
      text: typeof event.text === 'string' ? event.text : saved?.text || '',
      status: event.status || saved?.status, localOnly: true, createdAt: saved?.createdAt ?? Date.now() };
  },

  recordInfo(session, turnId, event, claudeTask) {
    const key = infoId(turnId, event.id);
    const saved = session.items.findLast(item => item.type === 'info' && (item.id === key || (claudeTask && item.claudeTask?.id === event.id)));
    const item = this.infoItem(saved?.turnId || turnId, event, saved);
    if (item && claudeTask) item.claudeTask = claudeTask;
    this.storeInfo(session, item);
  },

  codexSummaryDelta(session, turnId, id, p, title) {
    if (!id || !turnId || typeof p.delta !== 'string') return;
    const key = infoId(turnId, id);
    const saved = session.items.findLast(i => i.id === key);
    const summary = appendCodexSummary(saved?.summaryParts, p.summaryIndex, p.delta);
    if (!summary) return;
    const item = this.infoItem(turnId, { id, kind: 'reasoning', title, text: summary.text, status: 'inProgress' }, saved);
    this.storeInfo(session, { ...item, summaryParts: summary.parts });
  },

  storeInfo(session, item) {
    if (!item) return;
    const index = session.items.findLastIndex(i => i.id === item.id && i.type === 'info');
    let older = index >= 0 && index !== session.items.length - 1;
    if (index < 0) {
      const end = session.submission?.turnId === item.turnId ? -1 : session.items.findLastIndex(i => i.turnId === item.turnId);
      if (end >= 0 && end < session.items.length - 1) {
        session.items = session.items.slice(); session.items.splice(end + 1, 0, item); older = true;
      } else session.items.push(item);
    }
    else {
      // A long-running child may finish outside the journal and window's streaming tails.
      if (older) session.items = session.items.slice();
      session.items[index] = item;
    }
    session.updated = Date.now(); this.changed(older ? undefined : session);
    if (item.details && this.pendingChildInfo?.size) {
      for (const [child, events] of this.pendingChildInfo) {
        if (item.details.agentThreadId !== child && !item.details['agent:' + child]) continue;
        this.pendingChildInfo.delete(child);
        for (const event of events) this.codexChildProgress(event.method, event.p);
      }
    }
  },

  codexInfoItem(session, turnId, native, status, history) {
    if (['enteredReviewMode', 'exitedReviewMode'].includes(native?.type)) {
      const id = 'review-mode';
      const saved = history?.get(infoId(turnId, id)) || session.items.findLast(i => i.id === infoId(turnId, id));
      // The exit item can repeat the full review answer. Keep it in the answer lane only.
      return this.infoItem(turnId, { id, kind: 'progress', title: 'Code review', text: native.type === 'enteredReviewMode' ? native.review : undefined,
        status: native.type === 'enteredReviewMode' ? 'inProgress' : 'completed' }, saved);
    }
    if (!['reasoning', 'subAgentActivity', 'collabAgentToolCall'].includes(native?.type)) return null;
    const id = native.type === 'subAgentActivity' && native.agentThreadId ? 'child:' + native.agentThreadId : native.id;
    const child = native.type === 'subAgentActivity' && native.agentThreadId;
    const origin = child && (session.items.find(item => item.details?.agentThreadId === child) ||
      (history && [...history.values()].find(item => item.details?.agentThreadId === child)));
    turnId = origin?.turnId || turnId;
    const key = infoId(turnId, id);
    const saved = history?.get(key) || origin || session.items.findLast(item => item.id === key);
    const event = codexInfo(native, status, saved, this.codexChildMetadata);
    const item = event && this.infoItem(turnId, { ...event, id }, saved);
    if (item && event.details) item.details = event.details;
    if (item && native.type === 'reasoning') {
      if (status === 'inProgress' && event.text && Array.isArray(native.summary))
        item.summaryParts = { ...native.summary.filter(part => typeof part === 'string') };
      if (status !== 'inProgress') delete item.summaryParts;
    }
    return item;
  },

  codexChildNotification(method, p) {
    const thread = p.thread;
    const id = thread?.id || p.threadId;
    const spawn = thread?.source?.subAgent?.thread_spawn;
    const parent = thread?.parentThreadId || spawn?.parent_thread_id;
    const cached = this.codexChildMetadata?.get(id);
    if (!id || (!parent && method === 'thread/started')) return;
    // No child transcript subscription. Join metadata only on an explicit parent/receiver relationship.
    for (const session of this.data.sessions) {
      if (parent && parent !== session.threadId && !session.items.some(i => i.details?.agentThreadId === parent)) continue;
      const owns = i => i.type === 'info' && (i.details?.agentThreadId === id || i.details?.['agent:' + id]);
      const saved = session.items.find(i => i.details?.agentThreadId === id) || session.items.find(owns);
      if (!saved && !parent && !cached) continue;
      if (cached && cached.session !== session.id) continue;
      const meta = { ...saved?.details?.['thread:' + id], ...cached, session: session.id };
      const status = p.status || thread?.status;
      for (const [key, value] of Object.entries({ parent, name: thread?.agentNickname || spawn?.agent_nickname,
        role: thread?.agentRole || spawn?.agent_role, path: spawn?.agent_path, depth: spawn?.depth,
        model: thread?.model, effort: thread?.reasoningEffort, state: status?.type && [status.type, ...(status.activeFlags || [])].join(' · ') })) {
        if (typeof value === 'string' || typeof value === 'number') meta[key] = value;
      }
      (this.codexChildMetadata ||= new Map()).set(id, meta);
      if (saved) {
        const details = { ...saved.details, ['thread:' + id]: meta };
        this.storeInfo(session, { ...saved, details, text: codexDetailsText(details) });
      }
      return;
    }
  },

  codexChildProgress(method, p) {
    const summary = ['item/reasoning/summaryTextDelta', 'item/reasoning/summaryPartAdded', 'item/reasoning/textDelta'].includes(method);
    const native = ['item/started', 'item/completed'].includes(method) && p.item;
    if (!p.turnId || (!summary && !['reasoning', 'collabAgentToolCall', 'subAgentActivity'].includes(native?.type) && method !== 'turn/plan/updated')) return;
    for (const session of this.data.sessions) {
      const origin = session.items.find(i => i.details?.agentThreadId === p.threadId) ||
        session.items.find(i => i.details?.['agent:' + p.threadId]);
      if (!origin) continue;
      const title = this.codexChildMetadata?.get(p.threadId)?.name || origin.details?.agentPath || p.threadId;
      const id = JSON.stringify(['child', p.threadId, p.turnId, p.itemId || native?.id || method]);
      if (method === 'item/reasoning/summaryTextDelta') this.codexSummaryDelta(session, origin.turnId, id, p, title + ' · Thinking');
      else if (summary) {
        if (!session.items.findLast(i => i.id === infoId(origin.turnId, id)))
          this.recordInfo(session, origin.turnId, { id, title: title + ' · Thinking', kind: 'reasoning', status: 'inProgress' });
      } else if (native) {
        const info = this.codexInfoItem(session, origin.turnId, { ...native, id }, method === 'item/started' ? 'inProgress' : 'completed');
        if (info) this.storeInfo(session, { ...info, title: info.title.startsWith(title + ' · ') ? info.title : title + ' · ' + info.title });
      } else this.codexPlanProgress(session, origin.turnId, id, title + ' · Plan progress', p);
      return;
    }
    // thread/started can precede the parent's spawn receipt. Keep public activity, not the
    // child's transcript, until that receipt gives it a turn. Never guess the active turn.
    if (!this.codexChildMetadata?.has(p.threadId)) return;
    const pending = this.pendingChildInfo ||= new Map();
    const events = pending.get(p.threadId) || [];
    const safe = { threadId: p.threadId, turnId: p.turnId, itemId: p.itemId, summaryIndex: p.summaryIndex };
    if (method === 'item/reasoning/summaryTextDelta') {
      const last = events.at(-1);
      if (last?.method === method && last.p.turnId === p.turnId && last.p.itemId === p.itemId && last.p.summaryIndex === p.summaryIndex) {
        last.p.delta += p.delta; return;
      }
      safe.delta = p.delta;
    } else if (summary) {
      method = 'item/reasoning/summaryPartAdded';
      if (events.some(e => e.method === method && e.p.turnId === p.turnId && e.p.itemId === p.itemId)) return;
    } else if (native?.type === 'reasoning') safe.item = { type: native.type, id: native.id,
      summary: Array.isArray(native.summary) ? native.summary.filter(s => typeof s === 'string') : [] };
    else if (native) {
      safe.item = Object.fromEntries(['id', 'type', 'tool', 'prompt', 'model', 'reasoningEffort', 'senderThreadId',
        'agentPath', 'agentThreadId', 'kind', 'status', 'receiverThreadIds'].map(k => [k, native[k]]));
      safe.item.agentsStates = Object.fromEntries(Object.entries(native.agentsStates || {}).map(([id, state]) =>
        [id, { status: state?.status, message: state?.message }]));
    } else { safe.explanation = p.explanation; safe.plan = p.plan?.map(({ step, status }) => ({ step, status })); }
    if (events.length >= SUBMISSION_EVENT_LIMIT) events.shift();
    events.push({ method, p: safe }); pending.set(p.threadId, events);
  },

  codexPlanProgress(session, turnId, id, title, p) {
    if (!Array.isArray(p.plan)) return;
    const key = infoId(turnId, id);
    const saved = session.items.findLast(item => item.id === key);
    const explanation = p.explanation || saved?.planExplanation;
    const steps = p.plan.filter(s => typeof s?.step === 'string').map(s => s.status + ': ' + s.step);
    const item = this.infoItem(turnId, { id, kind: 'progress', title, text: [explanation, ...steps].filter(Boolean).join('\n') }, saved);
    if (item) this.storeInfo(session, { ...item, planExplanation: explanation });
  },

  visible(item) {
    return item && ['userMessage', 'agentMessage', 'plan', 'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'webSearch', 'imageGeneration', 'contextCompaction'].includes(item.type);
  },

  beginSubmission(session, fields) {
    const submission = {
      token: randomUUID(), kind: fields.kind, backend: fields.backend, threadId: fields.threadId ?? null,
      messageId: fields.messageId ?? null, turnId: fields.turnId ?? null, taskId: fields.taskId ?? null,
      state: fields.turnId ? 'acknowledged' : 'submitting', buffer: fields.turnId ? null : [],
      startedAt: Date.now(), // what the provider starts from here on belongs to this turn (see Controller.interruptTurn)
      ...(session.delegation && !session.delegation.delivered ? {
        assignmentId: session.delegation.id, assignmentRevision: session.delegation.executionRevision || session.delegation.revision || 1,
      } : {}),
    };
    submission.budget = this.agents?.budgets.beginRequest(this, session, {
      id: submission.token, kind: fields.kind, provider: fields.backend, model: fields.model,
    }) || null;
    const route = session.routes.find(route => route.messageId === fields.messageId);
    if (route && submission.budget) route.budget = submission.budget;
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
    return method === 'turn/started' || method === 'turn/completed' || method === 'turn/plan/updated' || method === 'thread/compacted' ||
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
    // Tagged with its message: the UI shows it only while this is the chat's latest turn.
    session.warning = outcome.status === 'completed' && outcome.warning ? { text: outcome.warning, messageId: submission.messageId } : null;
    const budgetRoute = session.routes.find(route => route.messageId === submission.messageId);
    const finalUsage = budgetRoute?.budgetUsageInvalid ? null
      : budgetRoute && Object.hasOwn(budgetRoute, 'budgetFinalUsage') ? budgetRoute.budgetFinalUsage : budgetRoute?.turnUsage;
    this.agents?.budgets.report(submission.budget, {
      usage: finalUsage,
      providerEstimateUsd: budgetRoute?.providerEstimateUsd, uncertain: outcome.status !== 'completed' || !!budgetRoute?.budgetUsageInvalid,
    }, true);
    if (outcome.status === 'failed') this.log.warn('Turn failed', { session: session.id, provider: session.activeProvider || 'codex', kind: submission.kind, error: String(outcome.error || '').slice(0, 300) });
    const maintenanceRoute = session.routes.find(route => route.messageId === submission.messageId && route.wikiMaintenanceTaskId);
    if (maintenanceRoute) {
      const origin = session.tasks?.find(task => task.id === maintenanceRoute.wikiMaintenanceTaskId);
      if (origin?.wikiMaintenance) {
        origin.wikiMaintenance.state = outcome.status === 'completed' ? 'finished' : 'interrupted';
        origin.wikiMaintenance.result = stripTaskStatus(session.items.filter(item => item.turnId === submission.turnId && item.type === 'agentMessage' && item.phase !== 'commentary').at(-1)?.text) || outcome.error || '';
        this.writeTaskFile(session, origin);
      }
    }
    if (submission.kind === 'turn' && !maintenanceRoute) this.updateJob(session, submission, outcome);
    if (submission.kind === 'turn') {
      try { this.traceTurn(session, submission, outcome, !!maintenanceRoute); } catch { /* tracing never affects a turn */ }
    }
    if (submission.kind === 'compaction' && outcome.status === 'completed') {
      delete session.codexInstructionHash;
      this.loaded.delete(session.id);
      session.notice = 'Context compacted. The visible chat history is retained.';
      session.lastCompactedAt = Date.now();
      session.noticeExpiresAt = Date.now() + 5000;
    }
    const stopping = this.stopping.has(session.id);
    this.stopping.delete(session.id);
    // The test pool runs once this turn has settled (see testPoolAfterTurn).
    if (submission.kind === 'turn' && outcome.status === 'completed' && !stopping && !maintenanceRoute)
      (this.testPoolDue ||= new Set()).add(session.id);
    const task = submission.taskId ? (session.tasks || []).find(item => item.id === submission.taskId) : null;
    session.updated = Date.now();
    if (task && !FINAL.has(task.state)) {
      this.busy = session.id;
      this.changed();
      this.gateDone = this.runGate(session, task, submission, outcome, stopping);
      return;
    }
    if (this.busy === session.id) this.busy = null;
    session.replyBudgetId = null;
    session.activeTaskId = null;
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
    if (decision?.originalRequestId) session.job.originalRequestId = decision.originalRequestId;
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
        failover: !!route.failover, switched: !!previous && ((previous.provider || 'codex') !== (route.provider || 'codex') || previous.model !== route.model),
        effortCap: source === 'manual' ? null : route.effortCap || null },
      assessment: route.assessment ? { taskKind: route.assessment.taskKind, difficulty: route.assessment.difficulty, risk: route.assessment.risk, uncertainty: route.assessment.uncertainty, needsChecks: route.assessment.needsChecks } : null,
      routing: router ? { classifier: router.model || null, calls: router.timings?.classifications?.length || null, durationMs: router.durationMs ?? null,
        tokens: router.usage?.totalTokens ?? null, costUsd: router.estimatedCostUsd ?? null, confidence: router.confidence ?? null } : null,
      worker: { durationMs: route.at ? Date.now() - route.at : null,
        tokens: usage ? { input: usage.inputTokens ?? null, cached: usage.cachedInputTokens ?? null, output: usage.outputTokens ?? null } : null },
      outcome: { status: outcome.status, limit: !!outcome.limit, reportedTask: reported },
    });
  },

  notification({ method, params: p }) {
    if (method === 'account/login/completed') {
      const refresh = p.success ? this.refreshAccount() : Promise.reject(new Error(p.error || 'ChatGPT sign-in did not complete.'));
      refresh.catch(error => { this.error = error.message; }).finally(() => { this.chatgptLoginPending = false; this.changed(); });
      return;
    }
    if (method === 'serverRequest/resolved') { this.requests.delete(p.requestId); this.changed(); return; }
    if (method === 'account/rateLimits/updated') { this.codexUsage(p.rateLimits, true); this.changed(); return; }
    if (method === 'thread/started') { this.codexChildNotification(method, p); return; }
    if (!p?.threadId) return;
    const session = this.data.sessions.find(s => s.threadId === p.threadId);
    if (!session && method === 'thread/status/changed') this.codexChildNotification(method, p);
    if (!session) { if (p?.threadId) this.codexChildProgress(method, p); return; }
    // The pre-acknowledgement buffer can itself be saved. Strip private fields before buffering.
    if (['rawResponseItem/completed', 'rawResponse/completed'].includes(method)) return;
    const review = method === 'item/autoApprovalReview/started' || method === 'item/autoApprovalReview/completed';
    if (review) p = { threadId: p.threadId, turnId: p.turnId, reviewId: p.reviewId, review: { status: p.review?.status,
      riskLevel: p.review?.riskLevel, rationale: p.review?.rationale } };
    if (method === 'item/reasoning/textDelta') {
      method = 'item/reasoning/summaryPartAdded';
      p = { threadId: p.threadId, turnId: p.turnId, itemId: p.itemId };
      const duplicate = session.submission?.buffer?.some(e => e.method === method && e.params.turnId === p.turnId && e.params.itemId === p.itemId);
      if (duplicate) return;
    }
    const publicItem = item => item.type === 'reasoning' ? { id: item.id, type: 'reasoning',
      summary: Array.isArray(item.summary) ? item.summary.filter(part => typeof part === 'string') : [] } : item;
    if (p.item?.type === 'reasoning') p = { ...p, item: publicItem(p.item) };
    if (Array.isArray(p.turn?.items)) p = { ...p, turn: { ...p.turn, items: p.turn.items
      .filter(i => ['reasoning', 'collabAgentToolCall', 'subAgentActivity', 'enteredReviewMode', 'exitedReviewMode', 'plan'].includes(i.type)).map(publicItem) } };
    if (['item/started', 'item/completed'].includes(method) && (p.turnId !== session.submission?.turnId || session.submission?.state === 'completed') &&
        ['subAgentActivity', 'collabAgentToolCall'].includes(p.item?.type)) {
      const info = this.codexInfoItem(session, p.turnId, p.item, method === 'item/completed' ? 'completed' : 'inProgress');
      if (info && (this.knownTurn(session, p.turnId) || session.items.some(item => item.id === info.id))) {
        this.storeInfo(session, info); return;
      }
    }
    if (this.bufferEarly(session, { method, params: p })) return;
    if (this.ignoredTurnEvent(session, method, p)) return;
    if (review && p.reviewId) {
      const text = [p.review.riskLevel && 'Risk: ' + p.review.riskLevel, p.review.rationale].filter(Boolean).join('\n');
      this.recordInfo(session, p.turnId, { id: 'approval-review:' + p.reviewId, title: 'Approval review', kind: 'progress',
        text: text || undefined, status: p.review.status }); return;
    }
    if (method === 'turn/plan/updated' && Array.isArray(p.plan)) {
      this.codexPlanProgress(session, p.turnId, 'turn-plan', 'Plan progress', p); return;
    }
    if (method === 'item/mcpToolCall/progress' && typeof p.message === 'string' && p.itemId) {
      this.recordInfo(session, p.turnId, { id: 'mcp-progress:' + p.itemId, kind: 'progress', title: 'Tool progress', text: p.message }); return;
    }
    if (method === 'item/reasoning/summaryPartAdded') {
      const id = infoId(p.turnId, p.itemId);
      if (!session.items.findLast(item => item.id === id)) this.recordInfo(session, p.turnId, { id: p.itemId, kind: 'reasoning', status: 'inProgress' });
      return;
    }
    if (method === 'thread/goal/updated' && p.goal?.objective && Number.isFinite(p.goal.createdAt)) {
      const id = 'goal:' + p.goal.createdAt;
      const saved = session.items.findLast(item => item.type === 'info' && item.id === infoId(item.turnId, id));
      if (saved || p.turnId) this.recordInfo(session, saved?.turnId || p.turnId, { id, title: 'Goal', kind: 'progress', text: p.goal.objective, status: p.goal.status });
      return;
    }
    if (method === 'thread/goal/cleared') {
      const goal = session.items.findLast(item => item.kind === 'progress' && item.title === 'Goal' && item.id.startsWith('info:') &&
        item.id.includes(',"goal:'));
      if (goal) this.storeInfo(session, { ...goal, status: 'cleared' });
      return;
    }
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
          turn.budgetUsageInvalid = !normalizedUsage(total) || !normalizedUsage(last) ||
            total.inputTokens < last.inputTokens || total.outputTokens < last.outputTokens;
          if (!turn.budgetUsageInvalid) this.agents?.budgets.report(turn.budget, { usage: turn.turnUsage });
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
      for (const item of p.turn.items || []) {
        if (item.type === 'plan') this.notification({ method: 'item/completed', params: { threadId: p.threadId, turnId: p.turn.id, item } });
        else this.storeInfo(session, this.codexInfoItem(session, p.turn.id, item, status));
      }
      const submission = session.submission, messageId = submission?.messageId;
      const route = session.routes.find(r => r.turnId === p.turn.id) || session.routes.at(-1);
      const provider = route?.provider || 'codex';
      const limit = status === 'failed' && codexTurnLimited(p.turn.error)
        ? { until: provider === 'codex' ? this.codexLimitReset() : null, reason: p.turn.error.message || 'Usage limit reached.' } : null;
      const outcome = { status, error: p.turn.error?.message || null, limit };
      this.finishTurn(session, submission, outcome);
      if (submission?.kind !== 'compaction') this.providerOutcome(session, provider, route?.model, messageId, outcome);
      if (submission?.kind !== 'compaction' && status === 'completed') session.codexTurnEndedAt = Date.now();
      // The fresh thread's first turn after a cold start: its usage has arrived by now (thread/tokenUsage/updated).
      if (route?.coldStartPending)
        this.coldStartLogged(session, route, { record: route.coldStartPending.record, step: session.items.find(item => item.id === route.coldStartPending.stepId) },
          route, status);
    }
    if (method === 'item/reasoning/summaryTextDelta' && typeof p.delta === 'string' && p.itemId) {
      this.codexSummaryDelta(session, p.turnId, p.itemId, p, 'Thinking');
      return;
    }
    if (method === 'item/started' || method === 'item/completed') {
      const info = this.codexInfoItem(session, p.turnId, p.item, method === 'item/started' ? 'inProgress' : 'completed');
      if (info) {
        this.storeInfo(session, info); return;
      }
    }
    if ((method === 'item/started' || method === 'item/completed') && this.visible(p.item)) {
      if (method === 'item/completed' && p.item.type === 'contextCompaction') {
        session.lastCompactedAt = Date.now();
        delete session.codexInstructionHash;
      }
      p.item.turnId = p.turnId;
      p.item.routeLabel = session.routes.at(-1)?.label;
      // findLastIndex: a turn's items sit at the chat's end; a forward search cost 50 µs per step on 5,600 items (2026-11-14).
      const index = session.items.findLastIndex(i => i.id === p.item.id || (p.item.clientId && i.clientId === p.item.clientId));
      if (index >= 0 && p.item.type === 'plan' && !p.item.text) p.item.text = session.items[index].text;
      p.item.createdAt = (index >= 0 ? session.items[index].createdAt : null) || Date.now();
      if (index < 0) session.items.push(p.item);
      else session.items[index] = {
        ...session.items[index], ...p.item,
        ...(p.item.type === 'userMessage' && session.items[index].clientId ? {
          content: session.items[index].content, routeLabel: session.items[index].routeLabel, fileMessage: session.items[index].fileMessage,
        } : {})
      };
    }
    // findLast: streamed items sit at the chat's end (see the Claude turn's assistant()).
    if (method === 'item/agentMessage/delta' || method === 'item/plan/delta') {
      let item = session.items.findLast(i => i.id === p.itemId);
      if (!item) { item = { id: p.itemId, turnId: p.turnId, type: method === 'item/plan/delta' ? 'plan' : 'agentMessage', text: '', routeLabel: session.routes.at(-1)?.label, createdAt: Date.now() }; session.items.push(item); }
      item.text += p.delta;
    }
    if (method === 'item/commandExecution/outputDelta') {
      const item = session.items.findLast(i => i.id === p.itemId);
      if (item) item.aggregatedOutput = ((item.aggregatedOutput || '') + p.delta).slice(-60000);
    }
    if (method === 'error') session.error = p.error?.message || p.message;
    // Streamed text, command output, a step's start or end and token usage touch only this chat (its newest messages, its
    // current route): scoped, a push compares only that chat's tail instead of every message of every chat of the bot
    // (7.4 ms on a 5,600-message chat, 2026-11-13). Other events can change the bot's own state too.
    const streamed = ['item/agentMessage/delta', 'item/plan/delta', 'item/commandExecution/outputDelta', 'item/started', 'item/completed', 'thread/tokenUsage/updated'].includes(method);
    session.updated = Date.now(); this.changed(streamed ? session : undefined);
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
    const session = this.data.sessions.find(session => session.threadId === message.params?.threadId);
    const earlier = message.params?.turnId && session?.tasks?.find(task => task.foreground && task.budgetId &&
      task.attempts.some(attempt => attempt.turnId === message.params.turnId));
    if (earlier && (FINAL.has(earlier.state) || earlier.budgetPaused || earlier.cancelled)) {
      this.client.rejectRequest(message.id, 'This task changed or stopped. This action is no longer current.'); return;
    }
    if (session && !this.assignmentCurrent(session)) { this.client.rejectRequest(message.id, 'This task changed or stopped. This action is no longer current.'); return; }
    if (session?.activeTaskId) message = { ...message, taskId: session.activeTaskId, budgetId: this.agents?.budgets.forSession(session)?.id || null };
    if (session?.delegation && !session.delegation.delivered) {
      if (!this.assignmentCurrent(session)) { this.client.rejectRequest(message.id, 'The assignment changed. This action is no longer current.'); return; }
      message = { ...message, assignment: { id: session.delegation.id, revision: session.delegation.revision || 1 } };
    }
    this.requests.set(message.id, message); this.changed();
  },
};
