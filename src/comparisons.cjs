'use strict';
// Two-run comparisons: the same task in project copies from one snapshot, one run of each pair with a single
// instruction change. Measurements and verdicts need no model calls. The A/B mapping stays in Harness data until
// the user reveals it; the project wiki gets comparisons.json and a readable page once a comparison finishes.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { canonical } = require('./setup-fingerprint.cjs');
const { projectEntry, legacyInstructionFiles, consolidatedInstructions } = require('./workspace/project-instructions.cjs');

const RECORDS = 'comparisons.json';
const PAGE = 'comparisons.md';
const MAX_RECORDS = 50;
// When checks and corrections tie, tokens (or active time) must be at least this much lower to count as "cheaper".
const THRESHOLD = 0.2;
const TARGETS = { bot: 'worker instructions', project: 'project PhasmaHarness.md', skill: 'skill package' };

const excerpt = (text, limit) => (String(text).length > limit ? String(text).slice(0, limit - 1) + '…' : String(text));
const fileHash = file => {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return null;
  }
};

// Each pair gets labels A and B; which of them carries the change is random.
function planRuns(pairs) {
  const runs = [];
  for (let pair = 1; pair <= pairs; pair++) {
    const changed = crypto.randomInt(2);
    runs.push({ index: pair * 2 - 1, pair, label: 'A', variant: changed === 0 });
    runs.push({ index: pair * 2, pair, label: 'B', variant: changed === 1 });
  }
  return runs;
}

// Paths inside the workspace that check commands name, relative to it (flags and outside programs drop out later).
function checkPaths(checks, workspace) {
  const paths = new Set();
  for (const check of checks) {
    for (const part of check.argv) {
      const relative = path.relative(workspace, path.resolve(check.cwd, part));
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative))
        paths.add(relative);
    }
  }
  return [...paths];
}

const isFile = file => !!fs.statSync(file, { throwIfNoEntry: false })?.isFile();
const protectedFiles = (checks, workspace) =>
  checkPaths(checks, workspace).filter(relative => isFile(path.join(workspace, relative))).map(relative => relative.split(path.sep).join('/'));

// Puts back every check file that differs from the snapshot, so no run is judged by checks it edited.
// shortcut: only files named in a check's command are protected; a runner's own suite (npm test) is not.
function restoreCheckFiles(checks, workspace, input) {
  const restored = [];
  for (const relative of checkPaths(checks, workspace)) {
    const saved = path.join(input, relative), file = path.join(workspace, relative);
    if (!isFile(saved) || fileHash(saved) === fileHash(file))
      continue;

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(saved, file);
    restored.push(relative.split(path.sep).join('/'));
  }
  return restored;
}

// A project-instructions comparison writes the same base into every copy and adds the change to the changed run's copy.
// Deterministic, so running it again after a restart writes the same files.
function prepareCopy(record, copy, input) {
  if (record?.target !== 'project')
    return;

  const run = record.runs.find(entry => entry.index === copy.index);
  if (!run)
    throw new Error('This project copy is not part of its comparison.');

  let base;
  try {
    base = fs.readFileSync(projectEntry(input), 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    base = consolidatedInstructions(legacyInstructionFiles(input));
  }

  const file = projectEntry(copy.workspace);

  const body = run.variant ? `${base.trimEnd()}\n\n${record.change.trim()}\n` : base;
  if (Buffer.byteLength(body) > 64 * 1024) throw new Error('Comparison instructions exceed 64 KiB.');
  fs.writeFileSync(file, body);
  // A tracked entry would show the edit in git diff and tell the runs apart; skip-worktree hides it in both copies.
  spawnSync('git', ['update-index', '--skip-worktree', '--', 'PhasmaHarness.md'], { cwd: copy.workspace, windowsHide: true, timeout: 4000 });
}

// What a returned run measured, from its delivered result item.
function runResult(item, cancelled) {
  const usage = item?.budgetSummary || {};
  const checks = Object.fromEntries(Object.values(item?.verification || {})
    .flatMap(group => group.checks || [])
    .map(check => [check.name, check.status]));
  return {
    status: cancelled ? 'cancelled' : item?.status || 'missing',
    checks,
    corrections: item?.corrections ?? null,
    setups: (item?.attempts || []).map(attempt => attempt.setup || null),
    restored: [...new Set((item?.attempts || []).flatMap(attempt => attempt.restored || []))],
    diff: item?.attempts?.at(-1)?.diff || null,
    text: excerpt(item?.text || '', 4000),
    tokens: usage.tokensComplete ? usage.reportedTokens : null,
    usd: usage.costComplete ? usage.providerEstimateUsd : null,
    activeMs: Number.isFinite(usage.usedMs) ? usage.usedMs : null,
    agentId: item?.agentId || null,
    sessionId: item?.sessionId || null,
    workspace: item?.workspace || null,
  };
}

function comparable(setup, { target = null, lessons = true } = {}) {
  const { hash, ...rest } = setup;
  return canonical({ ...rest,
    instructions: { ...rest.instructions, ...(typeof target === 'string' ? { [target]: null } : {}) },
    ...(target?.skill ? { skills: { ...rest.skills, [target.skill]: null } } : {}),
    ...(lessons ? {} : { lessons: null }) });
}

// Why a pair cannot be compared, or null. Every attempt of a run must share one setup (lessons ride only on the
// first), and the two runs' first setups must differ in the changed instructions and nothing else.
function confounder(base, change, target) {
  for (const run of [base, change]) {
    const result = run.result;
    if (result?.skillError) return result.skillError;
    if (!result || result.status !== 'completed')
      return `run ${run.label} ${result?.status === 'cancelled' ? 'was cancelled' : 'did not complete'}`;
    if (result.corrections === null || !result.setups.length || result.setups.some(setup => !setup))
      return `run ${run.label} has no recorded task setup`;
    if (Object.values(result.checks).some(status => !['passed', 'failed'].includes(status)) || !Object.keys(result.checks).length)
      return `run ${run.label}'s checks did not run cleanly`;
    const first = comparable(result.setups[0], { lessons: false });
    if (result.setups.some(setup => comparable(setup, { lessons: false }) !== first))
      return `run ${run.label}'s setup changed between attempts`;
  }

  const [a, b] = [base, change].map(run => run.result.setups[0]);
  if (comparable(a, { target }) !== comparable(b, { target }))
    return 'the two runs differ in more than the change';
  if (target?.skill ? a.skills?.[target.skill] === b.skills?.[target.skill]
    : canonical(a.instructions?.[target] ?? null) === canonical(b.instructions?.[target] ?? null))
    return 'the change did not reach its run';
  return null;
}

const passedChecks = result => Object.entries(result.checks).filter(([, status]) => status === 'passed').map(([name]) => name);
const percent = ratio => `${Math.round(Math.abs(1 - ratio) * 100)}%`;

// Checks decide first, then corrections, then tokens (or active time) beyond the threshold.
function pairVerdict(base, change, target, threshold = THRESHOLD) {
  const problem = confounder(base, change, target);
  if (problem)
    return { verdict: 'confounded', reason: problem };

  const before = passedChecks(base.result), after = passedChecks(change.result);
  const lost = before.filter(name => !after.includes(name)), gained = after.filter(name => !before.includes(name));
  if (lost.length && gained.length)
    return { verdict: 'no observed effect', reason: `mixed checks: with the change ${gained.join(', ')} passed but ${lost.join(', ')} failed` };
  if (lost.length)
    return { verdict: 'hurt', reason: `with the change ${lost.join(', ')} failed, which passed without it` };
  if (gained.length)
    return { verdict: 'helped', reason: `with the change ${gained.join(', ')} passed, which failed without it` };
  if (after.length < Object.keys(change.result.checks).length)
    return { verdict: 'no observed effect', reason: 'both runs failed the same checks' };

  const [was, now] = [base.result.corrections, change.result.corrections];
  if (now < was)
    return { verdict: 'helped', reason: `the change needed fewer corrections (${now} instead of ${was})` };
  if (now > was)
    return { verdict: 'no observed effect', reason: `the change needed more corrections (${now} instead of ${was})` };

  // Tokens decide a tie; active time (noisier: provider load, network, check duration) only when either run did not
  // report its tokens completely. Costing less is "cheaper", not "helped": it says nothing about the work's quality.
  const ratio = (value, reference) => (Number.isFinite(value) && Number.isFinite(reference) && reference > 0 ? value / reference : null);
  const tokens = ratio(change.result.tokens, base.result.tokens);
  const [name, value, fewer] = tokens !== null ? ['tokens', tokens, 'fewer']
    : ['active time', ratio(change.result.activeMs, base.result.activeMs), 'less'];
  if (value === null)
    return { verdict: 'no observed effect', reason: 'same checks and corrections; neither tokens nor time were measured for both runs' };
  if (value <= 1 - threshold)
    return { verdict: 'cheaper', reason: `same checks and corrections; ${percent(value)} ${fewer} ${name}` };
  if (value >= 1 + threshold)
    return { verdict: 'no observed effect', reason: `same checks and corrections; ${percent(value)} more ${name}` };
  return { verdict: 'no observed effect', reason: `same checks and corrections; ${name} within ${percent(1 - threshold)}` };
}

// A strict majority of the comparable pairs decides; one pair, a split or a confounded pair is low confidence.
function overallVerdict(pairs) {
  const valid = pairs.filter(pair => pair.verdict !== 'confounded');
  if (!valid.length)
    return { verdict: 'confounded', confidence: 'low' };

  const counts = {};
  for (const pair of valid)
    counts[pair.verdict] = (counts[pair.verdict] || 0) + 1;
  const [top, count] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  const verdict = count * 2 > valid.length ? top : 'no observed effect';
  const unanimous = count === pairs.length;
  const confidence = !unanimous || pairs.length === 1 ? 'low' : pairs.length === 2 ? 'medium' : 'high';
  return { verdict, confidence };
}

function finish(record) {
  const pairVerdicts = [];
  for (let pair = 1; pair <= record.pairs; pair++) {
    const runs = record.runs.filter(run => run.pair === pair);
    const base = runs.find(run => !run.variant), change = runs.find(run => run.variant);
    pairVerdicts.push({ pair, ...pairVerdict(base, change, record.target === 'skill' ? { skill: record.skill?.name } : record.target, record.threshold) });
  }
  // Nothing waits on the user: the verdict and which run had the change show as soon as the last run is back.
  Object.assign(record, { state: 'finished', finishedAt: Date.now(), revealedAt: Date.now(), pairVerdicts, ...overallVerdict(pairVerdicts) });
}

// The run whose result lands in the project: one that passed every check, then fewer corrections, then fewer tokens;
// a full tie goes to the current setup. None when no run passed every check.
function bestRun(record) {
  const passed = run => run.result?.status === 'completed' && Object.keys(run.result.checks).length > 0 &&
    Object.values(run.result.checks).every(status => status === 'passed');
  const tokens = run => run.result.tokens ?? Number.MAX_SAFE_INTEGER;
  return record.runs.filter(passed).sort((a, b) => a.result.corrections - b.result.corrections || tokens(a) - tokens(b) ||
    Number(a.variant) - Number(b.variant))[0] || null;
}

// What the chat card shows; the change mapping and verdict appear once the comparison is finished.
function publicView(record) {
  const revealed = !!record.revealedAt;
  const runs = record.runs.map(run => ({ index: run.index, pair: run.pair, label: run.label, name: run.name || null, jobId: run.jobId || null,
    ...(run.result ? { result: { ...run.result, setups: undefined, setup: run.result.setups[0]?.hash || null } } : {}),
    ...(revealed ? { changed: run.variant } : {}) }));
  return { id: record.id, number: record.number || null, state: record.state, project: record.project, task: excerpt(record.task, 400), target: record.target,
    change: record.change, skill: record.skill?.name || null, model: record.model, pairs: record.pairs, revealed, error: record.error || null, suggested: !!record.suggested,
    runs, ...(revealed ? { verdict: record.verdict, confidence: record.confidence, pairVerdicts: record.pairVerdicts,
      applied: record.applied || null, adopted: record.adopted || null } : {}) };
}

function readComparisons(root, { strict = false } = {}) {
  try {
    const records = JSON.parse(fs.readFileSync(path.join(root, RECORDS), 'utf8'));
    if (strict && (!Array.isArray(records) || records.some(record => !record?.id))) throw new Error('Invalid comparison history; skill cleanup was deferred.');
    return Array.isArray(records) ? records.filter(record => record?.id) : [];
  } catch (error) {
    if (strict && error.code !== 'ENOENT') throw error;
    return [];
  }
}

function writeAtomic(file, text) {
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}

const seconds = ms => (Number.isFinite(ms) ? `${Math.round(ms / 1000)} s` : 'unknown');

function runLine(run) {
  const result = run.result || {};
  const checks = Object.entries(result.checks || {}).map(([name, status]) => `${name} ${status}`).join(', ') || 'none';
  return `Run ${run.label} (${run.variant ? 'with the change' : 'current setup'}): ${result.status || 'missing'}; checks: ${checks}; ` +
    `corrections ${result.corrections ?? '?'}; tokens ${result.tokens ?? 'not fully reported'}; active time ${seconds(result.activeMs)}` +
    `${result.restored?.length ? `; check files restored: ${result.restored.join(', ')}` : ''}; setup ${result.setups?.[0]?.hash || 'unknown'}.`;
}

// What happened to the project afterwards, in one line each.
function outcomeLines(record) {
  const lines = [];
  if (record.applied?.files?.length)
    lines.push(`Applied run ${record.applied.label}'s changes to the project: ${record.applied.files.join(', ')}.`);
  else if (record.applied?.error)
    lines.push(record.applied.error);
  if (record.adopted?.skill)
    lines.push(`Kept the ${record.adopted.skill} skill for this workspace.`);
  else if (record.adopted?.trial)
    lines.push('Put the rule on trial: matching tasks carry it, and it is kept after 3 of them pass that check without this failure.');
  else if (record.adopted?.file)
    lines.push(`Added the rule to ${record.adopted.file}.`);
  else if (record.adopted?.error)
    lines.push(`The change was not kept: ${record.adopted.error}`);
  return lines;
}

function renderPage(records) {
  const entries = records.map(record => {
    const head = `## ${new Date(record.at).toISOString().slice(0, 10)} · ${excerpt(record.task.split(/\r?\n/)[0], 100)}\n\n` +
      `Change to the ${TARGETS[record.target]}${record.suggested ? ' (started by Harness: a lesson did not stick)' : ''}:\n\n` +
      `> ${excerpt(record.change, 1000).replace(/\r?\n/g, '\n> ')}\n\nModel ${record.model}; ${record.pairs} pair${record.pairs > 1 ? 's' : ''}.`;
    const pairs = record.pairVerdicts.map(pair => {
      const runs = record.runs.filter(run => run.pair === pair.pair).map(run => `  - ${runLine(run)}`).join('\n');
      return `- Pair ${pair.pair}: ${pair.verdict}; ${pair.reason}.\n${runs}`;
    }).join('\n');
    const outcome = outcomeLines(record).join(' ');
    return `${head}\n\nVerdict: ${record.verdict}, ${record.confidence} confidence.${outcome ? ' ' + outcome : ''}\n\n${pairs}`;
  });
  return `# Setup comparisons\n\nGenerated by Phasma Harness from two-run comparisons. The records live in ${RECORDS} beside this page; ` +
    `this page is rewritten from them. One pair is weak evidence.\n\n${entries.join('\n\n')}\n`;
}

function saveComparison(root, record) {
  fs.mkdirSync(root, { recursive: true });
  const { lessonBlock, ...saved } = record;
  const records = [saved, ...readComparisons(root, { strict: true }).filter(entry => entry.id !== record.id)].sort((a, b) => b.at - a.at);
  records.length = Math.min(records.length, MAX_RECORDS);
  writeAtomic(path.join(root, RECORDS), JSON.stringify(records, null, 2));
  writeAtomic(path.join(root, PAGE), renderPage(records));
}

module.exports = { RECORDS, PAGE, MAX_RECORDS, THRESHOLD, TARGETS, planRuns, protectedFiles, restoreCheckFiles, prepareCopy, runResult,
  pairVerdict, overallVerdict, finish, bestRun, outcomeLines, publicView, readComparisons, saveComparison };
