const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const FINAL = new Set(['checks-passed', 'not-checked', 'blocked', 'needs-you', 'cancelled']);
// Measured 2026-09-25 with tests/codex-reap-live.cjs, codex-cli 0.156.1, Windows, dangerFullAccess only: after Codex
// exited (input closed, and terminated) none of the check's processes, including a detached one, were still running.
const MEASURED_REAP = Object.freeze({ codexVersion: '0.156.1', platform: 'win32', sandbox: 'dangerFullAccess' });
const OUTPUT_CAP = 64 * 1024;

function hasProjectWiki(workspace) {
  try {
    const root = fs.realpathSync(workspace);
    const filename = fs.realpathSync(path.join(root, 'docs', 'wiki', 'index.md'));
    const relative = path.relative(root, filename);
    return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && fs.statSync(filename).isFile();
  } catch { return false; }
}

function canProposeWiki(task) {
  return !!task && ['checks-passed', 'not-checked'].includes(task.state) && task.attempts?.at(-1)?.workerOutcome === 'completed';
}

function parseChecklist(text) {
  const lines = String(text || '').slice(0, OUTPUT_CAP).trimStart().split(/\r?\n/);
  if (!/^(?:\*\*)?Done when:(?:\*\*)?\s*$/i.test(lines[0])) return { proposedChecklist: null, checklistStatus: 'none-proposed' };
  const items = [];
  for (const line of lines.slice(1)) {
    if (!line.trim() && !items.length) continue;
    const match = line.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/);
    if (!match) break;
    if (match[1].length > 500 || items.length === 6) return { proposedChecklist: null, checklistStatus: 'unparseable' };
    items.push(match[1].trim());
  }
  return { proposedChecklist: items.length >= 3 ? items : null, checklistStatus: items.length >= 3 ? 'proposed' : 'unparseable' };
}

// Paths never read as evidence: VCS internals, environment files, credentials, secrets and keys.
const PRIVATE_PATH = /(^|[\\/])(\.git|\.env(?:\..*)?|auth\.json|credentials[^\\/]*|secrets?[^\\/]*|id_rsa|id_ed25519)([\\/]|$)|\.(pem|key|pfx|p12)$/i;

function resolveCitations(workspace, text) {
  // ponytail: inspect up to 20 explicit file:line references and 64 KiB per file; other formats remain unassessed.
  const references = [], seen = new Set();
  const pattern = /\[[^\]\n]+\]\(<?([^\n)]+?)>?\)|`([^`\n]+)`|((?:[A-Za-z]:[\\/])?[\w./\\-]+:\d+(?:-\d+)?)/g;
  let root;
  try { root = fs.realpathSync(workspace); } catch { return { references, note: 'Workspace unavailable; references unassessed.' }; }
  const privatePath = PRIVATE_PATH;
  const allowed = filename => {
    const relative = path.relative(root, filename);
    return relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative) && !privatePath.test(relative);
  };
  for (const match of String(text || '').slice(0, OUTPUT_CAP).matchAll(pattern)) {
    const target = match[1] || match[2] || match[3];
    const citation = target.match(/^(.+?):(\d+)(?:-(\d+))?$/);
    if (!citation || seen.has(target)) continue;
    if (references.length === 20) return { references, note: 'Reference limit reached; remaining references unassessed.' };
    seen.add(target);
    const row = { citation: target, status: 'unassessed', detail: 'Outside workspace, private, or unsupported path.' };
    references.push(row);
    if (/^[a-z]+:\/\//i.test(citation[1])) continue;
    const filename = path.resolve(root, citation[1]);
    if (!allowed(filename)) continue;
    let handle;
    try {
      const actual = fs.realpathSync(filename);
      if (!allowed(actual)) continue;
      handle = fs.openSync(actual, 'r');
      const stat = fs.fstatSync(handle);
      if (!stat.isFile() || stat.size > OUTPUT_CAP) { row.detail = 'Not a regular file or exceeds 64 KiB read limit.'; continue; }
      const buffer = Buffer.alloc(OUTPUT_CAP + 1);
      const count = fs.readSync(handle, buffer, 0, buffer.length, 0);
      if (count > OUTPUT_CAP || buffer.subarray(0, count).includes(0)) { row.detail = 'Large or binary file.'; continue; }
      const contents = buffer.subarray(0, count).toString('utf8');
      const lineCount = contents ? contents.split('\n').length - Number(contents.endsWith('\n')) : 0;
      const start = Number(citation[2]), end = Number(citation[3] || citation[2]);
      const valid = Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start && end <= lineCount;
      row.status = valid ? 'resolved' : 'unresolved';
      row.detail = valid ? 'Path and line range resolved in current file; claim not assessed.' : 'Line range is outside the current file.';
    } catch (error) {
      row.status = error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'unresolved' : 'unassessed';
      row.detail = row.status === 'unresolved' ? 'Current file not found.' : 'File could not be inspected.';
    } finally { if (handle !== undefined) fs.closeSync(handle); }
  }
  return { references, note: references.length ? null : 'No supported file:line references assessed.' };
}

function shouldTrack(toggle) {
  return toggle !== 'off';
}

function parentExitReaps(runtime) {
  return !!runtime && runtime.codexVersion === MEASURED_REAP.codexVersion && runtime.platform === MEASURED_REAP.platform && runtime.sandbox === MEASURED_REAP.sandbox;
}

function createTask({ messageId, goal, checks, access }) {
  const frozen = (checks || []).map(check => Object.freeze({ ...check, argv: Object.freeze([...check.argv]) }));
  return {
    id: randomUUID(), messageId, goal: String(goal || ''), amendments: [],
    checks: Object.freeze(frozen), access, attempts: [], corrections: 0,
    reason: null, state: 'running', acknowledged: false, route: null,
    proposedChecklist: null, checklistStatus: 'pending',
  };
}

function gateOutcome({ workerOutcome, results = [], corrections = 0, cancelled = false }) {
  if (cancelled || workerOutcome === 'interrupted') return 'cancelled';
  const blocked = results.some(result => result.status === 'blocked' || result.status === 'unknown');
  const failed = results.some(result => result.status === 'failed');
  if (workerOutcome === 'failed') return 'needs-you';
  if (blocked) return 'blocked';
  if (!results.length) return 'not-checked';
  if (results.every(result => result.status === 'passed')) return 'checks-passed';
  if (failed && corrections < 1) return 'correcting';
  if (failed) return 'needs-you';
  return 'blocked';
}

function capStream(value) {
  const text = String(value || '');
  if (text.length < OUTPUT_CAP) return { text, truncated: false };
  return { text: text.slice(0, OUTPUT_CAP), truncated: true };
}

function summaryLine(task) {
  const attempt = task.attempts?.at(-1);
  const results = attempt?.results || [];
  const workerFailed = attempt?.workerOutcome === 'failed';
  if (task.state === 'cancelled') return 'Cancelled';
  if (task.state === 'checking') return 'Running configured checks';
  if (task.state === 'correcting') return 'Sending one correction';
  if (workerFailed && task.state === 'needs-you') {
    const checks = !results.length ? (task.checksSkippedByRouter ? 'checks skipped by router' : 'no checks configured')
      : results.every(result => result.status === 'passed') ? 'configured checks passed'
        : 'checks did not all pass';
    return `Worker turn failed · ${checks}`;
  }
  if (task.state === 'checks-passed') return 'Configured checks passed · coverage not assessed';
  if (task.state === 'not-checked') return `${task.checksSkippedByRouter ? 'Checks skipped by router' : 'No checks configured'} · coverage not assessed`;
  if (task.state === 'blocked') {
    const blocked = results.find(result => result.status === 'blocked' || result.status === 'unknown');
    return `Blocked: ${blocked?.detail || task.reason || 'check did not run'}`;
  }
  if (task.state === 'needs-you') {
    return task.corrections > 0 && results.some(result => result.status === 'failed')
      ? 'Needs you: checks failed after one correction'
      : `Needs you: ${task.reason || 'review the result'}`;
  }
  return 'Running';
}

// Lines that name a real failure: compiler/linker errors ("error:", "error C2065:", "error LNK2019:"), fatal
// errors, CMake errors, Vulkan validation messages, exceptions ("TypeError:", "AssertionError:"), failed
// assertions, panics, and test/build summary lines (Ninja/pytest "FAILED", Go "--- FAIL:"). Plain
// "failed"/"not found" (such as CMake feature probes) is not enough.
const ERROR_LINE = /\berror\b(?:\s+[A-Z]+\d+)?\s*:|\b\w*(?:Error|Exception):|\bfatal error\b|CMake Error|VUID-|Validation Error|\bAssertion\b.*\bfailed\b|\bpanicked\b|undefined reference|^\s*FAILED\b|^\s*--- FAIL:/i;

// What a correction sees from a failed check. It is exactly what it was before (the last 2,000 characters of stdout,
// or of stderr when stdout is empty) whenever that already shows an error line or the output has none. Only when the
// error lines are elsewhere (earlier in a long log, or in stderr) are up to six of them, at most 600 characters, put
// first, and the whole excerpt still stays within 2,000 characters.
function failureExcerpt(result, budget = 2000, extra = 600) {
  const tail = capStream(result.stdout || result.stderr || '').text.slice(-budget);
  if (tail.split(/\r?\n/).some(line => ERROR_LINE.test(line))) return tail;
  const errors = [];
  let size = 0;
  scan: for (const stream of [result.stdout, result.stderr]) {
    for (const line of capStream(stream || '').text.split(/\r?\n/)) {
      const clipped = line.trim().slice(0, 240);
      if (!clipped || !ERROR_LINE.test(clipped) || errors.includes(clipped) || size + clipped.length + 1 > extra) continue;
      errors.push(clipped); size += clipped.length + 1;
      if (errors.length >= 6) break scan;
    }
  }
  if (!errors.length) return tail;
  const head = `Error lines from the full output:\n${errors.join('\n')}\nOutput tail:\n`;
  return head + tail.slice(-(budget - head.length));
}

function correctionText(task) {
  const failed = (task.attempts.at(-1)?.results || []).filter(result => result.status === 'failed');
  const lines = failed.map(result => {
    const output = failureExcerpt(result);
    return `- ${result.name}: exit ${result.exitCode ?? '?'}${result.truncated ? ' (truncated)' : ''}${output ? `\n${output}` : ''}`;
  });
  const amendments = (task.amendments || []).map(item => item.text).filter(Boolean);
  return `The configured checks failed. Fix these and leave the rest of the work intact.\n${lines.join('\n')}${amendments.length ? `\n\nAccepted steering:\n${amendments.join('\n')}` : ''}`;
}

function validateChecks(workspace, list) {
  if (!Array.isArray(list) || list.length > 10) throw new Error('Configure at most 10 checks.');
  const root = fs.realpathSync(workspace);
  return list.map(check => {
    if (!check || typeof check !== 'object' || typeof check.name !== 'string' || !check.name.trim() || check.name.length > 80) throw new Error('Check name is required.');
    if (!Array.isArray(check.argv) || !check.argv.length || check.argv.some(part => typeof part !== 'string' || !part)) throw new Error('Check command must be a non-empty argument list.');
    const cwd = fs.realpathSync(check.cwd || root);
    const relative = path.relative(root, cwd);
    if (!relative && cwd !== root || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('Check directory must stay inside the workspace.');
    const timeoutMs = check.timeoutMs ?? 120000;
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 30 * 60 * 1000) throw new Error('Check timeout must be between 1 second and 30 minutes.');
    return {
      id: typeof check.id === 'string' && /^[\w-]{1,80}$/.test(check.id) ? check.id : randomUUID(),
      name: check.name.trim(), argv: [...check.argv], cwd, timeoutMs, readOnlySafe: check.readOnlySafe === true,
    };
  });
}

function lookupState(value) {
  if (!value || value.status === 'unknown') return 'unknown';
  if (value.status === 'absent') return 'absent';
  if (value.creationTime) return 'present';
  return 'unknown';
}

function identityFromProbe(result, pid) {
  if (!result || result.error || result.status !== 0) return { status: 'unknown' };
  const creationTime = String(result.stdout || '').trim();
  if (!creationTime) return { status: 'absent' };
  if (!/^\d+$/.test(creationTime)) return { status: 'unknown' };
  return { status: 'present', pid, creationTime };
}

function childBlocksClear(block, lookup) {
  for (const child of block.children || []) {
    const live = lookup(child.pid);
    const state = lookupState(live);
    if (state === 'unknown') return true;
    if (state === 'present' && live.creationTime === child.creationTime) return true;
  }
  return false;
}

function confirmTermination(block, lookup) {
  if (!block) return { clear: true, kill: false };
  const parent = lookup(block.pid);
  const state = lookupState(parent);
  if (state === 'unknown') return { clear: false, kill: false };
  if (state === 'present' && parent.creationTime === block.creationTime) return { clear: false, kill: true };
  if (childBlocksClear(block, lookup)) return { clear: false, kill: false };
  if (parentExitReaps(block.runtime)) return { clear: true, kill: false };
  return { clear: false, kill: false };
}

function restartReason(task, block) {
  if (task.state === 'checking' || block?.taskId === task.id) return 'a check may still be running';
  if (task.state === 'correcting') return 'app closed during correction';
  return 'app closed during the worker turn';
}

module.exports = {
  hasProjectWiki, canProposeWiki,
  parseChecklist, resolveCitations,
  FINAL, MEASURED_REAP, OUTPUT_CAP, PRIVATE_PATH, shouldTrack, createTask, gateOutcome, summaryLine, correctionText, failureExcerpt,
  validateChecks, confirmTermination, restartReason, capStream, identityFromProbe, lookupState, parentExitReaps, childBlocksClear,
};
