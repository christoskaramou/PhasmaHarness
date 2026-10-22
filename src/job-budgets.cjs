const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { randomUUID } = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { capabilities } = require('./providers/capabilities.cjs');

const DEFAULT_MINUTES = 120;
const MAX_MINUTES = 7 * 24 * 60;
const DEFAULT_ATTEMPTS = 20;
const MAX_ATTEMPTS = 10000;
const MAX_TOKENS = 1e12;
const HEARTBEAT_MS = 60000;

function normalizedUsage(value) {
  if (!value || typeof value !== 'object') return null;
  const count = n => Number.isSafeInteger(n) && n >= 0;
  let input = value.inputTokens, output = value.outputTokens, cached = value.cachedInputTokens;
  if (input !== undefined || output !== undefined) {
    if (!count(input) || !count(output)) return null;
  } else {
    if (!count(value.input_tokens) || !count(value.output_tokens)) return null;
    const read = value.cache_read_input_tokens ?? 0, write = value.cache_creation_input_tokens ?? 0;
    if (!count(read) || !count(write)) return null;
    input = value.input_tokens + read + write; output = value.output_tokens; cached = read;
  }
  if (!count(input + output) || (cached != null && (!count(cached) || cached > input))) return null;
  return { inputTokens: input, outputTokens: output, cachedInputTokens: cached ?? null, totalTokens: input + output };
}

function usageSummary(budget) {
  const entries = Object.values(budget.requests || {}), reported = entries.filter(entry => entry.usage);
  const costs = entries.filter(entry => entry.providerEstimateUsd != null);
  const tokens = reported.reduce((n, entry) => n + entry.usage.totalTokens, 0);
  const cost = costs.reduce((n, entry) => n + entry.providerEstimateUsd, 0);
  return { attempts: entries.length, reportedTokens: reported.length && Number.isSafeInteger(tokens) ? tokens : null,
    tokensComplete: entries.length > 0 && Number.isSafeInteger(tokens) && entries.every(entry => entry.complete && entry.usage && !entry.uncertain),
    missingFinalUsage: !Number.isSafeInteger(tokens) || entries.some(entry => entry.complete && (!entry.usage || entry.uncertain)),
    providerEstimateUsd: costs.length && Number.isFinite(cost) ? cost : null,
    costComplete: entries.length > 0 && Number.isFinite(cost) && entries.every(entry => entry.complete && !entry.uncertain && entry.providerEstimateUsd != null) };
}

function usageText(summary) {
  if (!summary) return '';
  return '\nUsage snapshot at worker-result delivery (provider estimates, not invoices; incomplete totals are lower bounds; later review is excluded):\n' + JSON.stringify(summary);
}

class JobBudgets {
  constructor(agents, now = () => Date.now(), monotonic = () => performance.now()) {
    this.agents = agents; this.now = now; this.monotonic = monotonic;
    this.leases = new Map(); this.operations = new Map(); this.closed = false; this.dirty = false;
    this.inflight = new Map(); this.context = new AsyncLocalStorage();
    const data = agents.primary.data;
    data.jobBudgets ??= {};
    if (!data.jobBudgets || typeof data.jobBudgets !== 'object' || Array.isArray(data.jobBudgets))
      throw new Error('Saved job budgets need review. No job was resumed.');
    this.records = data.jobBudgets;
    // Rewritten each minute while work is active, so a restart does not charge the downtime after a crash.
    this.heartbeatFile = agents.primary.filename ? path.join(path.dirname(agents.primary.filename), 'job-heartbeat') : null;
    let alive = null;
    try { alive = Number(fs.readFileSync(this.heartbeatFile, 'utf8')); } catch { /* No heartbeat: charge until now. */ }
    let changed = false;
    for (const [id, budget] of Object.entries(this.records)) {
      if (!budget || !Number.isFinite(budget.limitMs) || budget.limitMs <= 0 ||
          budget.limitMs > MAX_MINUTES * 60000 || budget.id !== id || !Number.isInteger(budget.version) || budget.version < 1 ||
          !Number.isFinite(budget.usedMs) || budget.usedMs < 0 || !['active', 'paused'].includes(budget.state) ||
          (budget.activeSince != null && !Number.isFinite(budget.activeSince)))
        throw new Error('A saved job budget is invalid. No job was resumed.');
      if (budget.limitsEnabled === undefined) {
        budget.limitsEnabled = budget.version > 1 || budget.limitMs !== DEFAULT_MINUTES * 60000 ||
          (budget.limitAttempts ?? DEFAULT_ATTEMPTS) !== DEFAULT_ATTEMPTS || budget.limitTokens != null;
        changed = true;
      }
      if (typeof budget.limitsEnabled !== 'boolean') throw new Error('Saved job limits need review.');
      if (budget.activeSince != null) {
        const end = Number.isFinite(alive) && alive >= budget.activeSince ? Math.min(alive, this.now()) : this.now();
        budget.usedMs = Math.min(budget.limitsEnabled ? budget.limitMs : Infinity, budget.usedMs + Math.max(0, end - budget.activeSince));
        budget.activeSince = null; budget.estimated = true;
        budget.state = 'paused'; budget.version++;
        budget.reason = 'Runner restarted with active work. Review the assignment; elapsed time is estimated.';
        changed = true;
      }
      if (budget.requests === undefined) { budget.requests = {}; budget.limitAttempts = DEFAULT_ATTEMPTS; budget.limitTokens = null; changed = true; }
      if (!budget.requests || typeof budget.requests !== 'object' || Array.isArray(budget.requests) || (budget.limitsEnabled && Object.keys(budget.requests).length > MAX_ATTEMPTS) ||
          !Number.isInteger(budget.limitAttempts) || budget.limitAttempts < 1 || budget.limitAttempts > MAX_ATTEMPTS ||
          (budget.limitTokens !== null && (!Number.isSafeInteger(budget.limitTokens) || budget.limitTokens < 1 || budget.limitTokens > MAX_TOKENS)))
        throw new Error('Saved model usage limits need review. No job was resumed.');
      for (const [id, entry] of Object.entries(budget.requests)) {
        const usage = entry?.usage === null ? null : normalizedUsage(entry?.usage);
        if (!entry || entry.id !== id || typeof entry.complete !== 'boolean' ||
            (entry.usage !== null && !usage) || (entry.uncertain !== undefined && typeof entry.uncertain !== 'boolean') ||
            (entry.providerEstimateUsd !== null && (!Number.isFinite(entry.providerEstimateUsd) || entry.providerEstimateUsd < 0)))
          throw new Error('Saved model usage needs review. No job was resumed.');
        if (usage && JSON.stringify(usage) !== JSON.stringify(entry.usage)) { entry.usage = usage; changed = true; }
        if (!entry.complete) { entry.complete = true; entry.uncertain = true; changed = true; }
      }
    }
    if (changed) agents.primary.save();
  }

  register(job, source, limits = null) {
    const parent = source.delegation && !source.delegation.delivered ? source.delegation : null;
    const inherited = job.originalRequest?.budgetId || parent?.budgetId || this.forSession(source)?.id;
    if (limits && (inherited || !Number.isInteger(limits.limitMs) || limits.limitMs < 60000 || limits.limitMs > MAX_MINUTES * 60000 ||
        !Number.isInteger(limits.limitAttempts) || limits.limitAttempts < 1 || limits.limitAttempts > MAX_ATTEMPTS ||
        (limits.limitTokens !== null && (!Number.isSafeInteger(limits.limitTokens) || limits.limitTokens < 1 || limits.limitTokens > MAX_TOKENS)))) {
      throw new Error('Scheduled jobs need valid, independent time, attempt and token limits.');
    }
    if (inherited && !this.records[inherited]) throw new Error('The original job budget is unavailable. Review it before continuing.');
    if (inherited && this.records[inherited].state === 'paused') throw new Error(this.records[inherited].reason);
    job.budgetId = inherited || job.id;
    if (!inherited) this.records[job.id] = { id: job.id, version: 1, state: 'active', limitsEnabled: !!limits,
      limitMs: limits?.limitMs ?? DEFAULT_MINUTES * 60000, usedMs: 0, activeSince: null, reason: null,
      limitAttempts: limits?.limitAttempts ?? DEFAULT_ATTEMPTS, limitTokens: limits?.limitTokens ?? null, requests: {} };
    if (job.originalRequest) job.originalRequest.budgetId = job.budgetId;
    this.dirty = true;
    return !inherited;
  }

  forJob(job) { return job?.budgetId ? this.records[job.budgetId] : null; }
  forSession(session) {
    return this.forJob(session.delegation && !session.delegation.delivered ? session.delegation : null) ||
      this.forJob((session.tasks || []).find(task => task.id === session.activeTaskId)) ||
      (session.agentReplyActive && session.replyBudgetId ? this.records[session.replyBudgetId] : null);
  }
  forMessage(session, message) {
    if (session.delegation && !session.delegation.delivered) return this.forJob(session.delegation);
    const id = message?.agentResult?.request?.budgetId || message?.agentMail?.budgetId;
    if (id && !this.records[id]) throw new Error('The original job budget is unavailable. Review it before continuing.');
    return id ? this.records[id] : null;
  }
  persist() {
    try { this.agents.primary.save(); }
    catch (error) { error.budgetPersistenceFailed = true; throw error; }
    this.dirty = false;
  }
  held(job) { return !!job?.budgetId && (!this.forJob(job) || this.forJob(job).state === 'paused'); }
  elapsed(budget) {
    const lease = this.leases.get(budget.id);
    return budget.usedMs + (lease == null ? 0 : Math.max(0, this.monotonic() - lease));
  }
  summary(id) {
    const budget = this.records[id];
    return budget ? { id, at: this.now(), usedMs: this.elapsed(budget), limitMs: budget.limitsEnabled ? budget.limitMs : null,
      limitAttempts: budget.limitsEnabled ? budget.limitAttempts : null, limitTokens: budget.limitsEnabled ? budget.limitTokens : null, ...usageSummary(budget) } : null;
  }
  scoped(session, operation) { return this.context.run({ id: this.forSession(session)?.id || null }, operation); }
  beginRequest(controller, session, fields = {}) {
    const scope = this.context.getStore();
    const budget = scope ? this.records[scope.id] : session && this.forSession(session);
    if (scope?.id && !budget) throw Object.assign(new Error('The original job budget is unavailable.'), { code: 'JOB_BUDGET_HOLD' });
    if (!budget) return null;
    if (this.closed || this.agents.closing) throw new Error('The runner is stopping.');
    if (budget.state === 'paused') throw Object.assign(new Error(budget.reason), { code: 'JOB_BUDGET_HOLD' });
    const usage = usageSummary(budget);
    const reason = !budget.limitsEnabled ? null : usage.attempts >= budget.limitAttempts ? 'The job’s model-attempt limit was reached.'
      : budget.limitTokens !== null && !capabilities(fields.provider).usage ? 'This provider cannot report tokens for the configured token limit.'
      : budget.limitTokens !== null && usage.missingFinalUsage ? 'Earlier model usage is unavailable. Review it before continuing with a token limit.'
      : budget.limitTokens !== null && usage.reportedTokens >= budget.limitTokens ? 'The job’s reported-token limit was reached.' : null;
    if (reason) { this.pause(budget, reason); throw Object.assign(new Error(reason), { code: 'JOB_BUDGET_HOLD' }); }
    const id = fields.id || randomUUID();
    if (Object.hasOwn(budget.requests, id)) throw new Error('This model attempt is already recorded. Review it before resubmitting.');
    budget.requests[id] = { id, kind: fields.kind || 'worker', provider: fields.provider || 'codex', model: fields.model || null,
      complete: false, usage: null, providerEstimateUsd: null, at: this.now() };
    this.dirty = true;
    try { this.persist(); }
    catch (error) { budget.requests[id].complete = true; budget.requests[id].uncertain = true; throw error; }
    this.inflight.set(id, { budgetId: budget.id, cancel: fields.cancel });
    return { budgetId: budget.id, id };
  }

  report(handle, result = {}, complete = false) {
    if (!handle) return;
    const budget = this.records[handle.budgetId], entry = budget?.requests?.[handle.id];
    if (!entry) return;
    const usage = normalizedUsage(result.usage);
    if (usage && (!entry.usage || usage.totalTokens >= entry.usage.totalTokens)) entry.usage = usage;
    if (Number.isFinite(result.providerEstimateUsd) && result.providerEstimateUsd >= 0)
      entry.providerEstimateUsd = Math.max(entry.providerEstimateUsd ?? 0, result.providerEstimateUsd);
    entry.complete ||= complete;
    entry.uncertain ||= result.uncertain === true;
    if (complete) this.inflight.delete(handle.id);
    this.dirty = true;
    const summary = usageSummary(budget);
    if (budget.state === 'active' && budget.limitsEnabled && budget.limitTokens !== null &&
        (summary.reportedTokens >= budget.limitTokens || summary.missingFinalUsage))
      this.pause(budget, summary.missingFinalUsage ? 'A model attempt ended without usable token usage. Review it before continuing.' : 'The job’s reported-token limit was reached.');
    try { this.persist(); }
    catch (error) {
      if (budget.state === 'active') this.pause(budget, 'Model usage could not be saved. Review it before continuing.');
      this.agents.primary.log.warn('Model usage persistence failed', { error: error.message });
    }
  }
  snapshot() {
    return Object.fromEntries(Object.entries(this.records).map(([id, budget]) => {
      const { requests, ...saved } = budget;
      return [id, { ...saved, usage: usageSummary(budget), usedMs: this.elapsed(budget),
      inflightRequests: [...this.inflight.values()].filter(request => request.budgetId === id).length,
      stopping: budget.state === 'paused' && (this.operations.has(id) || [...this.inflight.values()].some(request => request.budgetId === id) || this.agents.allControllers().some(controller =>
        controller.data.sessions.some(session => budget.stoppedSessions?.includes(session.id) &&
          ((controller.busy === session.id && this.forSession(session)?.id === id) || controller.stopping.has(session.id) ||
            controller.loading.has(session.id) || controller.cleanupPending.size || controller.blockedReason())))) }];
    }));
  }

  refresh() {
    clearTimeout(this.timer);
    if (this.closed) return;
    if (this.agents.closing) { this.close(); return; }
    const active = new Set();
    for (const request of this.inflight.values()) if (this.records[request.budgetId]?.state === 'active') active.add(request.budgetId);
    for (const controller of this.agents.allControllers()) for (const session of controller.data.sessions) {
      const budget = this.forSession(session);
      if (budget?.state === 'active' && controller.busy === session.id && !session.capacityWaiting && !session.quotaWaiting)
        active.add(budget.id);
    }
    let changed = false, delay = Infinity;
    for (const budget of Object.values(this.records)) {
      const running = active.has(budget.id), leased = this.leases.has(budget.id);
      if (leased && (!running || budget.state === 'paused')) {
        budget.usedMs = this.elapsed(budget); budget.activeSince = null;
        this.leases.delete(budget.id); changed = true;
      } else if (running && !leased) {
        this.leases.set(budget.id, this.monotonic()); budget.activeSince = this.now(); changed = true;
      }
      if (budget.state !== 'active' || !budget.limitsEnabled) continue;
      const usage = usageSummary(budget);
      const missingProviderUsage = Object.values(budget.requests).some(entry => !entry.complete && !capabilities(entry.provider).usage);
      const reason = usage.attempts > budget.limitAttempts ? 'The job’s model-attempt limit was reached.'
        : budget.limitTokens !== null && (usage.missingFinalUsage || missingProviderUsage) ? 'Model usage is unavailable for the configured token limit. Review it before continuing.'
        : budget.limitTokens !== null && usage.reportedTokens >= budget.limitTokens ? 'The job’s reported-token limit was reached.' : null;
      if (reason) { this.pause(budget, reason); continue; }
      const remaining = budget.limitMs - this.elapsed(budget);
      if (remaining <= 0) { this.pause(budget); continue; }
      if (running) delay = Math.min(delay, remaining);
    }
    this.dirty ||= changed;
    if (this.leases.size && !this.heartbeat) {
      this.beat();
      this.heartbeat = setInterval(() => this.beat(), HEARTBEAT_MS);
      this.heartbeat.unref?.();
    } else if (!this.leases.size && this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (Number.isFinite(delay)) {
      this.timer = setTimeout(() => {
        try { this.refresh(); this.agents.pump(); }
        catch (error) { this.agents.primary.log.warn('Job budget update failed', { error: error.message }); }
        this.agents.emit('state', this.agents.snapshot());
      }, Math.min(2147483647, Math.max(1, Math.ceil(delay))));
      this.timer.unref?.();
    }
    if (this.dirty) this.persist();
  }

  pause(budget, reason = 'Active-time budget reached. Review the saved work and extend the limit to continue.') {
    budget.usedMs = this.elapsed(budget); this.leases.delete(budget.id); budget.activeSince = null;
    budget.state = 'paused'; budget.version++;
    budget.reason = reason;
    for (const { controller, session, task } of this.agents.foregroundTasks?.() || []) {
      if (task.budgetId !== budget.id || session.activeTaskId !== task.id || controller.busy !== session.id) continue;
      task.budgetPaused = true; task.resumeJobId ||= randomUUID();
      try { controller.save(); } catch (error) { this.agents.primary.log.warn('Could not save paused direct task', { error: error.message }); }
    }
    const controllers = this.agents.allControllers().filter(controller => controller.busy &&
      this.forSession(controller.session(controller.busy))?.id === budget.id);
    budget.stoppedSessions = controllers.map(controller => controller.busy);
    this.dirty = true;
    try { this.persist(); }
    catch (error) {
      budget.reason += ' Saving the pause failed: ' + error.message;
      this.agents.primary.log.warn('Could not save job budget pause', { error: error.message });
    }
    for (const request of this.inflight.values()) if (request.budgetId === budget.id) {
      try { request.cancel?.(); } catch (error) { this.agents.primary.log.warn('Budget request cancellation failed', { error: error.message }); }
    }
    for (const controller of controllers) controller.stopping.add(controller.busy);
    const operation = Promise.allSettled(controllers.map(controller => controller.stop(budget.id))).then(results => {
      const failure = results.find(result => result.status === 'rejected')?.reason;
      if (failure) { budget.reason += ' Stop is unconfirmed: ' + failure.message; this.dirty = true; }
    }).finally(() => {
      this.operations.delete(budget.id);
      try { this.agents.pump(); }
      catch (error) { this.agents.primary.log.warn('Paused job coordination failed', { error: error.message }); }
      this.agents.emit('state', this.agents.snapshot());
    });
    this.operations.set(budget.id, operation);
  }

  update(args) {
    if (!args || typeof args.jobId !== 'string' || !Number.isInteger(args.expectedVersion) || args.expectedVersion < 1 ||
        !Number.isInteger(args.limitMinutes) || args.limitMinutes < 1 || args.limitMinutes > MAX_MINUTES ||
        (args.limitAttempts !== undefined && (!Number.isInteger(args.limitAttempts) || args.limitAttempts < 1 || args.limitAttempts > MAX_ATTEMPTS)) ||
        (args.limitTokens !== undefined && args.limitTokens !== null && (!Number.isSafeInteger(args.limitTokens) || args.limitTokens < 1 || args.limitTokens > MAX_TOKENS)) ||
        (args.limitsEnabled !== undefined && typeof args.limitsEnabled !== 'boolean') ||
        typeof args.resume !== 'boolean' || Object.keys(args).some(key => !['jobId', 'expectedVersion', 'limitMinutes', 'limitAttempts', 'limitTokens', 'resume', 'limitsEnabled'].includes(key)))
      throw new Error('Choose valid whole-number time, attempt and token limits.');
    if (this.closed || this.agents.closing) throw new Error('The runner is stopping.');
    let budget;
    try { budget = this.forJob(this.agents.findJob(args.jobId).job); }
    catch { budget = this.records[args.jobId]; }
    if (!budget || budget.version !== args.expectedVersion) throw new Error('The job budget changed. Reopen its details.');
    const limitsEnabled = args.limitsEnabled ?? true;
    if (!limitsEnabled && (budget.limitsEnabled || !args.resume)) throw new Error('Only an unlimited task can resume without limits.');
    const records = this.agents.pendingJobs().filter(({ job }) => job.budgetId === budget.id);
    const tasks = (this.agents.foregroundTasks?.() || []).filter(({ task }) => task.budgetId === budget.id);
    const reviews = this.agents.allControllers().flatMap(controller => controller.data.sessions
      .filter(session => [...(session.queue || []), ...session.items.flatMap(item => item.pendingReply ? [item.pendingReply] : [])]
        .some(message => message.agentResult?.request?.budgetId === budget.id || message.agentMail?.budgetId === budget.id))
      .map(session => ({ controller, session })));
    if (!records.length && !tasks.length && !reviews.length && ![...this.inflight.values()].some(request => request.budgetId === budget.id))
      throw new Error('This job has already finished.');
    const limitMs = args.limitMinutes * 60000;
    const limitAttempts = args.limitAttempts ?? budget.limitAttempts;
    const limitTokens = args.limitTokens === undefined ? budget.limitTokens : args.limitTokens;
    const usage = usageSummary(budget);
    if (args.resume && limitsEnabled && limitMs <= this.elapsed(budget)) throw new Error('Extend the total time limit beyond the time already used.');
    if (args.resume && limitsEnabled && limitAttempts <= usage.attempts) throw new Error('Extend the model-attempt limit beyond the attempts already recorded.');
    if (args.resume && limitsEnabled && limitTokens !== null && (usage.missingFinalUsage || usage.reportedTokens >= limitTokens))
      throw new Error('The reported-token limit is exhausted or earlier usage is unknown. Review the usage and change the limit explicitly.');
    if (args.resume && (this.operations.has(budget.id) || [...this.inflight.values()].some(request => request.budgetId === budget.id) || tasks.some(({ controller, session, task }) =>
      (session.activeTaskId === task.id && (controller.busy === session.id || controller.activeTurns.has(session.id) || controller.loading.has(session.id) || controller.stopping.has(session.id))) ||
      controller.cleanupPending.size || controller.blockedReason()) || records.some(({ controller, session, job }) =>
      this.agents.revisionOperations.has(job.id) || controller.busy === session.id || controller.activeTurns.has(session.id) ||
      controller.loading.has(session.id) || controller.stopping.has(session.id) || controller.cleanupPending.size || controller.blockedReason())))
      throw new Error('Wait for this job’s earlier execution and cleanup to stop before resuming.');
    if (args.resume && records.some(({ job }) => ['interrupted', 'revision-blocked', 'delivery-pending'].includes(job.state)))
      throw new Error('This assignment has uncertain execution or delivery. Review it before resuming.');
    if (args.resume && tasks.some(({ task }) => task.budgetResumeReviewRequired))
      throw new Error('This task has uncertain execution after a restart. Review its files and evidence, then send a new request.');
    const before = { ...budget };
    if (args.resume) for (const { controller, task } of tasks) {
      if (task.cancelled || task.resumedAsJobId) continue;
      task.resumeJobId ||= randomUUID(); task.budgetResumePending = true; controller.save();
    }
    if (args.resume) this.resumeSavedWork(budget, records, reviews);
    Object.assign(budget, { limitMs, limitAttempts, limitTokens, limitsEnabled, version: budget.version + 1, ...(args.resume ? { state: 'active', reason: null } : {}) });
    try { this.agents.primary.save(); } catch (error) { Object.assign(budget, before); throw error; }
    this.agents.pump(); this.agents.emit('state', this.agents.snapshot());
    return this.snapshot()[budget.id];
  }

  resumeSavedWork(budget, records, reviews) {
    for (const { controller, session, job } of records) {
      if (job.cancelled || job.state !== 'running' || session.status !== 'interrupted') continue;
      job.state = 'queued'; job.startIndex = session.items.length;
      job.budgetResumes = (job.budgetResumes || 0) + 1; controller.save();
    }
    for (const { controller, session } of reviews) if (budget.stoppedSessions?.includes(session.id)) {
      session.queuePaused = false; controller.save();
    }
  }

  beat() {
    if (!this.heartbeatFile) return;
    try { fs.writeFileSync(this.heartbeatFile, String(this.now())); }
    catch (error) { this.agents.primary.log.warn('Job heartbeat could not be saved', { error: error.message }); }
  }

  close() {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); clearInterval(this.heartbeat); this.heartbeat = null;
    for (const request of this.inflight.values()) try { request.cancel?.(); } catch { /* controller shutdown retains its own cancellation path */ }
    for (const budget of Object.values(this.records)) if (this.leases.has(budget.id)) {
      budget.usedMs = this.elapsed(budget); budget.activeSince = null; this.dirty = true;
    }
    this.leases.clear();
    if (this.dirty) try { this.persist(); }
    catch (error) { this.agents.primary.log.warn('Could not checkpoint job budgets', { error: error.message }); }
  }
}

module.exports = { JobBudgets, DEFAULT_MINUTES, MAX_MINUTES, DEFAULT_ATTEMPTS, normalizedUsage, usageSummary, usageText };
