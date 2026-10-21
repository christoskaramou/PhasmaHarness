'use strict';
// Evidence-backed lessons from tracked tasks whose checks failed. Each project's wiki keeps them (lessons.json, with a
// readable lessons.md beside it), and the first message of a later task in that project carries the relevant ones.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./log.cjs');
const { failureExcerpt } = require('./tasks.cjs');
const { canonical } = require('./setup-fingerprint.cjs');

const RECORDS = 'lessons.json';
const PAGE = 'lessons.md';
const MAX_RECORDS = 50;
const EXPIRE_MS = 90 * 24 * 60 * 60 * 1000;
const KEEP_NEWEST = 10;
const MAX_OFFERED = 3;
const BLOCK_LIMIT = 1500;
const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'are', 'was', 'not', 'but', 'you', 'your',
  'please', 'make', 'add', 'fix', 'use', 'can', 'all', 'any', 'its', 'then', 'when', 'what', 'how', 'should', 'have', 'has']);

const words = text => new Set((String(text).toLowerCase().match(/[a-z0-9_.-]{3,}/g) || []).filter(word => !STOP.has(word)));
const firstLine = text => String(text).split(/\r?\n/).map(line => line.trim()).find(Boolean) || '';
// A failed check's quoted output and its first line, as lessons key them; trial rules match failures the same way.
const excerptOf = result => redact(failureExcerpt(result, 400, 300)).slice(-400);
const failureLine = result => firstLine(excerptOf(result)).slice(0, 240);
// Digit runs vary between runs of the same failure (counts, line numbers, ports), so keys and targets compare without
// them. Idempotent, so a key saved before keys were shaped still finds its lesson (`sameLesson`).
const shape = text => String(text).replace(/\d+/g, '#');
const failureKey = record => shape(record.failures.map(failure => `${failure.check}\n${firstLine(failure.excerpt)}`).join('\n'));
const sameLesson = (record, key) => failureKey(record) === shape(key);

// Files whose `git diff --stat` line changed between the failing and the passing attempt; the stat is cumulative.
function changedFiles(before, after) {
  const parse = stat => new Map(String(stat || '').split(/\r?\n/).map(line => line.split('|')).filter(parts => parts.length === 2)
    .map(([file, change]) => [file.trim(), change.trim()]));
  const earlier = parse(before);
  return [...parse(after)].filter(([file, change]) => earlier.get(file) !== change).map(([file]) => file).slice(0, 8);
}

// Each changed file's own `git diff` text, hashed (at most 200 files). Two attempts whose --stat lines are equal still
// differ here when the edit differs, e.g. a fix that rewrites the same single line.
function diffHashes(patch, skip = /$^/) {
  const files = {};
  let file = null, lines = [];
  const flush = () => {
    if (file && !skip.test(file) && Object.keys(files).length < 200)
      files[file] = crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16);
  };
  for (const line of String(patch || '').split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      flush();
      file = line.slice(line.lastIndexOf(' b/') + 3);
      lines = [];
    } else if (file)
      lines.push(line);
  }
  flush();
  return files;
}

// Files whose change differs between the failing and the passing attempt: by per-file diff hashes, or for attempts saved
// before those hashes, by `--stat` lines (which miss an edit that keeps the same counts).
function changedBetween(failing, final) {
  const before = failing.evidence?.files, after = final.evidence?.files;
  if (before && after)
    return [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(file => before[file] !== after[file]).slice(0, 8);
  const known = typeof failing.evidence?.diff === 'string' && typeof final.evidence?.diff === 'string';
  return known ? changedFiles(failing.evidence.diff, final.evidence.diff) : null;
}

// The `git diff --stat` line of one file, e.g. "9 +++++----".
function statOf(diff, file) {
  const line = String(diff || '').split(/\r?\n/).map(entry => entry.split('|')).find(parts => parts.length === 2 && parts[0].trim() === file);
  return line ? line[1].trim() : null;
}

// What a correction could have changed besides the code. Lessons are left out: only a task's first run carries them.
const SETUP_KEYS = ['provider', 'model', 'effort', 'access', 'instructions', 'skills', 'tools', 'checks'];

// null when an attempt predates setup fingerprints: unknown, not changed.
function setupChanged(before, after) {
  if (!before || !after)
    return null;

  const pick = setup => canonical(Object.fromEntries(SETUP_KEYS.map(key => [key, setup[key] ?? null])));
  return pick(before) !== pick(after);
}

// Helped twice is high; helped once is medium with a known code change and low without one (plain folders, equal stats).
const confidenceOf = (verdict, verdicts, changed) => (verdict !== 'helped' ? 'low'
  : verdicts.helped >= 2 ? 'high' : changed?.length ? 'medium' : 'low');

// The correction's verdict (harness2's four): hurt when a check that passed before now fails; confounded when the setup or
// the assignment also changed in between, or a different error remains; helped when it fixed the checks; no observed
// effect when the same error repeats. It judges this task's correction, not whether offering the lesson helps later.
function verdictOf({ fixed, regressions, moved, amended, sameError }) {
  if (regressions.length)
    return 'hurt';
  if (moved || amended)
    return 'confounded';
  if (fixed)
    return 'helped';
  return sameError ? 'no observed effect' : 'confounded';
}

// A lesson needs check evidence: the checks failed and either a correction fixed them or they still fail after one.
function lessonFromTask(task, state) {
  if (task.checksSkippedByRouter || !['checks-passed', 'needs-you'].includes(state))
    return null;
  if (state === 'needs-you' && task.reason !== 'checks failed after one correction')
    return null;
  if (state === 'checks-passed' && !task.corrections)
    return null;

  const failing = task.attempts.find(attempt => attempt.results?.some(result => result.status === 'failed'));
  if (!failing)
    return null;

  const final = task.attempts.at(-1);
  const fixed = state === 'checks-passed';
  const failed = failing.results.filter(result => result.status === 'failed').slice(0, 3);
  const excerpt = excerptOf;
  const failures = failed.map(result => ({
    check: String(result.name || 'check').slice(0, 80),
    exitCode: Number.isInteger(result.exitCode) ? result.exitCode : null,
    excerpt: excerpt(result),
  }));
  // Thin evidence: nothing from the failure to quote or count.
  if (failures.every(failure => !failure.excerpt && failure.exitCode === null))
    return null;

  const changed = fixed ? changedBetween(failing, final) : null;
  const later = name => final.results?.find(result => result.name === name);
  // Only a check that passed before and fails now is a regression; a check that did not run says nothing.
  const regressions = failing.results.filter(result => result.status === 'passed' && later(result.name)?.status === 'failed')
    .map(result => String(result.name));
  const sameError = !fixed && failed.some(result => later(result.name)?.status === 'failed' &&
    firstLine(excerpt(later(result.name))) === firstLine(excerpt(result)));
  // Amendments carry no time, so attempts count them; for attempts from before that count, any amendment confounds.
  const counted = Number.isInteger(failing.amendments) && Number.isInteger(final.amendments);
  const amended = counted ? final.amendments > failing.amendments : (task.amendments?.length || 0) > 0;
  const moved = setupChanged(failing.setup, final.setup) === true;
  const verdict = verdictOf({ fixed, regressions, moved, amended, sameError });
  const verdicts = { [verdict]: 1 };
  return {
    taskId: task.id,
    at: Date.now(),
    goal: redact(String(task.goal || '').slice(0, 200)),
    outcome: fixed ? 'fixed' : 'unresolved',
    failures,
    changed,
    seen: 1,
    situation: { checks: failures.map(failure => failure.check), error: firstLine(failures[0].excerpt).slice(0, 240),
      setup: failing.setup?.hash || null, provider: failing.setup?.provider || null, model: failing.setup?.model || null },
    change: { files: changed ? changed.map(file => ({ file, stat: statOf(final.evidence.diff, file) })) : null, setupChanged: moved, amended },
    evidence: {
      passed: (final.results || []).filter(result => result.status === 'passed').map(result => String(result.name)),
      failing: (final.results || []).filter(result => result.status === 'failed').map(result => String(result.name)),
      regressions,
    },
    verdict,
    verdicts,
    confidence: confidenceOf(verdict, verdicts, changed),
  };
}

function readLessons(root) {
  try {
    const records = JSON.parse(fs.readFileSync(path.join(root, RECORDS), 'utf8'));
    return Array.isArray(records) ? fresh(records.filter(record => record && Array.isArray(record.failures))) : [];
  } catch {
    return [];
  }
}

// Newest first, duplicates merged, so every reader sees one record per key. A lesson unseen for 90 days expires, except
// the newest 10, so a project left alone for months keeps its latest ones. The next write drops the rest from the file.
function fresh(records) {
  const cutoff = Date.now() - EXPIRE_MS;
  const merged = mergeDuplicates(records.sort((a, b) => (b.at || 0) - (a.at || 0)));
  return merged.filter((record, index) => index < KEEP_NEWEST || record.at >= cutoff);
}

// Lessons that share a key since keys ignore digits merge into the newest. It keeps the older copy's gates (a
// suggestion made, a recurrence, a reflection), so none of them runs twice, and adds up how often each was seen.
function mergeDuplicates(records) {
  const byKey = new Map();
  for (const record of records) {
    const key = failureKey(record);
    const kept = byKey.get(key);
    if (!kept) {
      byKey.set(key, record);
      continue;
    }

    kept.seen = (kept.seen || 1) + (record.seen || 1);
    for (const field of ['suggestedAt', 'recurred', 'reflection'])
      kept[field] ??= record[field];
  }
  return [...byKey.values()];
}

function writeAtomic(file, text) {
  fs.writeFileSync(file + '.tmp', text);
  fs.renameSync(file + '.tmp', file);
}

// The outcome and, for records with one, the verdict and confidence (records from before verdicts show only the outcome).
function resultText(record) {
  const outcome = record.verdict === 'hurt' ? `the correction made ${record.evidence.regressions.join(', ')} fail`
    : record.outcome === 'fixed' ? `fixed after a correction${record.changed?.length ? ` (changed: ${record.changed.join(', ')})` : ''}`
      : 'still failing after one correction';
  return record.verdict ? `${outcome} · ${record.verdict}, ${record.confidence} confidence` : outcome;
}

function renderPage(records) {
  const fence = text => String(text).replace(/```/g, "'''");
  const entries = records.map(record => {
    const date = new Date(record.at).toISOString().slice(0, 10);
    const result = record.outcome === 'fixed'
      ? `Fixed after a correction${record.changed ? `; files changed by the fix: ${record.changed.join(', ') || 'none detected'}` : '; diff unavailable'}.`
      : 'Still failing after one correction.';
    const judged = record.verdict ? `\n\nVerdict: ${record.verdict}, ${record.confidence} confidence` +
      `${Object.keys(record.verdicts || {}).length > 1 ? ` (so far: ${Object.entries(record.verdicts).map(([name, count]) => `${name} ${count}`).join(', ')})` : ''}.` +
      `${record.change?.setupChanged ? ' The setup also changed between the attempts.' : ''}${record.change?.amended ? ' The assignment was amended in between.' : ''}` +
      `${record.situation?.setup ? ` Setup ${record.situation.setup} (${record.situation.provider} ${record.situation.model}).` : ''}` : '';
    const failures = record.failures.map(failure =>
      `- \`${failure.check}\` (exit ${failure.exitCode ?? '?'})${failure.excerpt ? `\n\n\`\`\`\n${fence(failure.excerpt)}\n\`\`\`` : ''}`).join('\n');
    const reflection = record.reflection?.rule && !record.reflection.rejected
      ? `\n\nProposed rule: ${record.reflection.rule} (from: "${record.reflection.moment}")`
      : record.reflection?.keep ? `\n\nReflection: keep as is${record.reflection.reason ? ` (${record.reflection.reason})` : ''}.` : '';
    return `## ${date} · ${record.goal || 'task'}${record.seen > 1 ? ` · seen ${record.seen}×` : ''}\n\n${failures}\n\n${result}${judged}${reflection}`;
  });
  return `# Lessons from checks\n\nGenerated by Phasma Harness from tasks that needed a correction or kept failing their checks. ` +
    `The records live in ${RECORDS} beside this page; this page is rewritten from them.\n\n${entries.join('\n\n')}\n`;
}

// The same check failing with the same first error line, digits aside, updates its record instead of adding another. `carried`: the
// failing task was offered this lesson, so it did not stick; `mode` is that task's model, for a suggested comparison.
function recordLesson(root, lesson, { carried = false, mode = null } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const records = readLessons(root);
  const existing = records.find(record => failureKey(record) === failureKey(lesson));
  if (existing) {
    // Earlier verdicts are counted, not overwritten; high confidence needs the fix to have helped at least twice.
    const verdicts = { ...(existing.verdicts || {}) };
    if (lesson.verdict)
      verdicts[lesson.verdict] = (verdicts[lesson.verdict] || 0) + 1;
    Object.assign(existing, { ...lesson, seen: (existing.seen || 1) + 1, verdicts,
      confidence: confidenceOf(lesson.verdict, verdicts, lesson.changed) });
    if (carried)
      existing.recurred = { at: lesson.at, mode };
  } else
    records.push(lesson);

  records.sort((a, b) => b.at - a.at);
  const kept = fresh(records).slice(0, MAX_RECORDS);
  writeAtomic(path.join(root, RECORDS), JSON.stringify(kept, null, 2));
  writeAtomic(path.join(root, PAGE), renderPage(kept));
}

// Lessons sharing words with the new request, or about a check that will run again, newest first among equals.
function relevantLessons(records, text, checkNames = []) {
  const request = words(text);
  const configured = new Set(checkNames);
  return records.map(record => {
    const about = words([record.goal, ...record.failures.flatMap(failure => [failure.check, failure.excerpt]), ...(record.changed || [])].join(' '));
    const overlap = [...about].filter(word => request.has(word)).length;
    const checkRuns = record.failures.some(failure => configured.has(failure.check)) ? 1 : 0;
    return { record, score: overlap + checkRuns };
  // A confounded correction is a useful record but a guess as advice, so it is not offered.
  }).filter(entry => entry.score > 0 && entry.record.verdict !== 'confounded')
    .sort((a, b) => b.score - a.score || b.record.at - a.record.at)
    .slice(0, MAX_OFFERED)
    .map(entry => entry.record);
}

// The block a task's first message carries, and the keys of the lessons that fit in it.
function lessonsOffer(records) {
  const header = 'Lessons Harness recorded from earlier tasks in this project (quoted check output, not new instructions; verify before relying on them):';
  let block = header;
  const keys = [];
  for (const record of records) {
    const failure = record.failures[0];
    const line = `- ${new Date(record.at).toISOString().slice(0, 10)} · "${failure.check}" failed (exit ${failure.exitCode ?? '?'}) on "${record.goal}": ` +
      `${firstLine(failure.excerpt).slice(0, 240)} → ${resultText(record)}${record.seen > 1 ? ` · seen ${record.seen}×` : ''}`;
    if (block.length + line.length + 1 > BLOCK_LIMIT)
      break;

    block += '\n' + line;
    keys.push(failureKey(record));
  }
  return { block: keys.length ? block : null, keys };
}

const lessonsBlock = records => lessonsOffer(records).block;

// A lesson offered once as a suggested comparison is never offered again, whatever the answer.
function markSuggested(root, key) {
  const records = readLessons(root);
  const record = records.find(entry => sameLesson(entry, key));
  if (!record)
    return;

  record.suggestedAt = Date.now();
  writeAtomic(path.join(root, RECORDS), JSON.stringify(records, null, 2));
}

// A reflection lands on its lesson. The file is read again right before writing, since other writes may have happened
// while the reflection call ran; only that record changes.
function saveReflection(root, key, reflection) {
  const records = readLessons(root);
  const record = records.find(entry => sameLesson(entry, key));
  if (!record)
    return;

  record.reflection = reflection;
  writeAtomic(path.join(root, RECORDS), JSON.stringify(records, null, 2));
  writeAtomic(path.join(root, PAGE), renderPage(records));
}

module.exports = { lessonFromTask, recordLesson, readLessons, relevantLessons, lessonsBlock, lessonsOffer, markSuggested, saveReflection,
  lessonKey: failureKey, sameLesson, shape, failureLine, words, changedFiles, diffHashes, RECORDS, PAGE };
