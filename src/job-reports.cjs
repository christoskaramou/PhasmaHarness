'use strict';

const KINDS = ['build', 'launch', 'gameplay', 'test'];
const LABELS = { build: 'Build', launch: 'Launch', gameplay: 'Gameplay', test: 'Tests' };

function verification(task, assignment) {
  const result = Object.fromEntries(KINDS.map(kind => [kind, { status: 'not-verified', checks: [] }]));
  if (!task) return result;
  const attempt = Array.isArray(task.attempts) ? task.attempts.at(-1) : null;
  if (!attempt || (assignment && (attempt.assignmentId !== assignment.id || attempt.assignmentRevision !== (assignment.revision || 1)))) return result;
  for (const check of Array.isArray(task.checks) ? task.checks : []) {
    const kind = check?.kind || 'test';
    if (!KINDS.includes(kind)) continue;
    const valid = typeof check?.id === 'string' && Array.isArray(check.argv) && check.argv.length > 0 && check.argv.every(part => typeof part === 'string');
    const row = valid && Array.isArray(attempt.results) ? attempt.results.find(row => row?.id === check.id) : null;
    const status = !valid ? 'unknown' : !row ? 'not-verified' : row.status === 'passed' && row.exitCode === 0 ? 'passed'
      : row.status === 'failed' ? 'failed' : row.status === 'blocked' ? 'blocked' : 'unknown';
    result[kind].checks.push({ id: check?.id, name: check?.name, status, at: row?.finishedAt || attempt.at,
      argv: valid ? [...check.argv] : [], cwd: check?.cwd, exitCode: row?.exitCode ?? null,
      durationMs: row?.durationMs ?? null, detail: row?.detail || null });
  }
  for (const group of Object.values(result)) {
    const checks = group.checks;
    group.status = checks.some(check => check.status === 'failed') ? 'failed'
      : checks.some(check => ['unknown', 'blocked'].includes(check.status)) ? 'needs-review'
      : checks.length && checks.every(check => check.status === 'passed') ? 'passed' : 'not-verified';
  }
  return result;
}

function verificationText(evidence, detailed = false) {
  const status = { passed: 'check passed', failed: 'check failed', 'needs-review': 'needs review', 'not-verified': 'not verified' };
  return '\n\nHost verification (at check time; later edits are not covered):\n' + KINDS.map(kind => {
    const group = evidence?.[kind];
    let text = `${LABELS[kind]}: ${status[group?.status] || 'not verified'}`;
    if (detailed) for (const check of group?.checks || []) {
      const date = new Date(check.at);
      text += `\n  ${check.name}: ${check.status}\n  Command: ${JSON.stringify(check.argv)}\n  Directory: ${check.cwd}` +
        `\n  Exit: ${check.exitCode ?? 'not recorded'}; recorded: ${Number.isFinite(date.getTime()) ? date.toISOString() : 'unknown'}`;
      if (check.detail) text += '\n  Detail: ' + check.detail;
    }
    return text;
  }).join('\n');
}

function batchReports({ sessions, assignments, names, budgets, copies }) {
  const candidates = new Map();
  const put = (batch, entry, attempt = 1, at = 0, active = false) => {
    if (!batch || typeof batch.id !== 'string' || !Number.isInteger(batch.index) || batch.index < 1 || batch.index > 10) return;
    const key = batch.id + ':' + batch.index, previous = candidates.get(key);
    const rank = [attempt, active ? 1 : 0, at];
    const kept = previous && (previous.rank[0] > rank[0] || (previous.rank[0] === rank[0] &&
        (previous.rank[1] > rank[1] || (previous.rank[1] === rank[1] && previous.rank[2] > rank[2]))));
    const next = { ...entry, index: batch.index }, [winner, loser] = kept ? [previous.entry, next] : [next, previous?.entry];
    // Follow-up attempts reuse the worker's workspace, so artifacts published by earlier attempts stay on the card.
    if (loser && winner.workspace && winner.workspace === loser.workspace) {
      const merged = new Map();
      for (const artifact of [...(loser.artifacts || []), ...(winner.artifacts || [])]) {
        const id = artifact.id ?? artifact.path, old = merged.get(id);
        if (!old || (artifact.version || 0) > (old.version || 0) ||
            ((artifact.version || 0) === (old.version || 0) && (artifact.publishedAt || 0) >= (old.publishedAt || 0))) merged.set(id, artifact);
      }
      winner.artifacts = [...merged.values()];
    }
    if (!kept) candidates.set(key, { rank, entry: next });
  };
  for (const session of sessions) for (const item of session.items || []) {
    if (item.type !== 'agentResult' || !item.localOnly || !item.batch) continue;
    put(item.batch, { jobId: item.deliveryId, agentId: item.agentId, name: item.agentName,
      ownerId: item.ownerId, owner: item.ownerName, sessionId: item.sessionId,
      state: item.status === 'cancelled' ? 'cancelled' : item.status === 'failed' ? 'failed'
        : item.status === 'interrupted' ? 'interrupted' : 'returned', error: item.error || null,
      text: item.text || '', workspace: item.workspaceCopy?.workspace || item.workspace || null,
      artifacts: item.artifacts || [], verification: item.verification || verification(null), usage: item.budgetSummary || null,
    }, item.batchAttempt || 1, item.createdAt || 0);
  }
  for (const { session, job, agentId, needsInput, waiting } of assignments) {
    if (job.delivered || !job.originalRequest?.batch) continue;
    const budget = budgets[job.budgetId], copy = job.workspaceCopy && copies[job.workspaceCopy.workspace];
    const owner = sessions.find(session => session.id === (job.owner || job.source));
    const task = (session.tasks || []).findLast(task => task.assignmentId === job.id);
    // A job held after a restart needs the user's Return or Start decision before its budget review hold matters.
    const state = job.cancelled ? 'stopping' : job.state === 'interrupted' ? 'needs-review'
      : budget?.state === 'paused' ? budget.stopping ? 'pausing' : 'paused' : job.quotaPause ? 'paused'
      : copy?.state === 'preparing' ? 'preparing' : ['interrupted', 'revision-blocked', 'delivery-pending'].includes(job.state) || copy?.state === 'failed' ? 'needs-review'
        : needsInput ? 'needs-input' : waiting ? 'waiting' : session.capacityWaiting || job.state === 'queued' ? 'queued'
          : job.state === 'revising' ? 'updating' : job.state === 'running' ? 'running' : 'needs-review';
    put(job.originalRequest.batch, { jobId: job.id, agentId, name: names[agentId] || 'Bot',
      ownerId: owner?.agentId || null, owner: names[owner?.agentId] || 'Bot', sessionId: session.id,
      state, error: job.error || budget?.reason || null, text: '', workspace: session.workspace,
      artifacts: job.artifacts || [], verification: verification(task, job), usage: budget?.usage || null,
    }, job.originalRequest.attempts || 1, 0, true);
  }
  const reports = {};
  for (const session of sessions) for (const message of session.items || []) {
    const batch = message.hubBatch;
    if (!batch || typeof batch.id !== 'string' || !Number.isInteger(batch.count) || batch.count < 1 || batch.count > 10) continue;
    const entries = [];
    for (let index = 1; index <= batch.count; index++) {
      let entry = candidates.get(batch.id + ':' + index)?.entry;
      if (!entry) {
        const legacy = (session.items || []).findLast(item => item.hubBatchResult?.id === batch.id && item.hubBatchResult.index === index);
        entry = { index, state: legacy ? 'returned' : index <= batch.dispatched ? 'needs-review' : 'not-dispatched',
          name: names[legacy?.hubBatchResult?.agentId] || `Job ${index}`, verification: verification(null), artifacts: [],
          error: legacy ? null : batch.error || (index <= batch.dispatched ? 'Saved job details need review.' : null) };
      }
      entries.push(entry);
    }
    const outcomes = Object.fromEntries(Object.keys(OUTCOMES).map(key => [key, 0]));
    for (const entry of entries) outcomes[outcome(entry)]++;
    reports[batch.id] = { id: batch.id, sessionId: session.id, requestId: message.id,
      requested: batch.count, dispatched: batch.dispatched || 0, error: batch.error || null, entries, outcomes,
      summary: Object.entries(OUTCOMES).filter(([key]) => outcomes[key]).map(([key, label]) => `${outcomes[key]} ${label}`).join(' · '),
      returned: entries.filter(entry => ['returned', 'failed', 'cancelled', 'interrupted'].includes(entry.state)).length };
  }
  return reports;
}

// The batch summary counts each outcome separately; a returned job counts as passed only when every configured host check passed.
const OUTCOMES = { passed: 'returned, checks passed', unverified: 'returned, not verified', failed: 'failed', interrupted: 'interrupted', cancelled: 'cancelled',
  review: 'need review', waiting: 'waiting', 'not-dispatched': 'not dispatched' };

function outcome(entry) {
  if (['failed', 'interrupted', 'cancelled', 'not-dispatched'].includes(entry.state)) return entry.state;
  if (entry.state === 'needs-review') return 'review';
  if (entry.state !== 'returned') return 'waiting';
  const groups = KINDS.map(kind => entry.verification?.[kind]).filter(group => group?.checks?.length);
  if (groups.some(group => group.status === 'failed')) return 'failed';
  return groups.length && groups.every(group => group.status === 'passed') ? 'passed' : 'unverified';
}

function batchText(report) {
  if (!report) return '';
  return `\n\n### Batch report — ${report.requested} jobs: ${report.summary}\n` + report.entries.map(entry =>
    `\n${entry.index}. ${entry.name} — ${entry.state}${entry.owner ? '\nOwner: ' + entry.owner : ''}` +
    `${entry.workspace ? '\nWorkspace: ' + entry.workspace : ''}${entry.error || entry.text ? '\n' + (entry.error || entry.text) : ''}` +
    `${entry.artifacts?.length ? '\nPublished files: ' + entry.artifacts.map(artifact => artifact.path).join(', ') : ''}` +
    '\nProvider estimate: ' + (Number.isFinite(entry.usage?.providerEstimateUsd) && entry.usage.providerEstimateUsd >= 0
      ? '$' + entry.usage.providerEstimateUsd + (entry.usage.costComplete ? '' : ' (incomplete)') : 'Not reported') +
    verificationText(entry.verification, true)).join('\n') + '\n\nReturned is not verified completion. Check evidence covers its recorded execution time. Cost estimates are not invoices.\n';
}

function verificationGaps(evidence) {
  return KINDS.filter(kind => evidence?.[kind]?.checks?.length && evidence[kind].status !== 'passed')
    .map(kind => `${LABELS[kind]}: host check ${String(evidence[kind].status || 'not-verified').replace(/-/g, ' ')}. Review the check evidence; no further worker retry was started.`);
}

module.exports = { KINDS, verification, verificationText, verificationGaps, batchReports, batchText };
