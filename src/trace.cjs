// Local decision trace (logs/decisions.jsonl): what was decided and what happened, so routing and wiki checks can
// be judged on real outcomes. One JSON line per event, no prompts, replies, documents or keys: models, counts,
// durations, statuses, file references and content hashes only. Bounded: the file moves to .1 past 1 MB.
//   turn             one worker turn: route (source, model, effort, same task, switch, escalation), routing cost and
//                    latency, worker tokens and latency, turn status, and the status the worker reported
//   checks           a tracked message's configured checks once they are final (kept apart from the reported status)
//   wiki-assessment  one addition from an automatic wiki update, assessed by Jev (log only)
//   wiki-update      the per-update totals, including what the assessment itself cost
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const MAX_BYTES = 1024 * 1024;
const hash = text => createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);

function emptySummary() {
  return { turns: 0, wiki: { additions: 0, assessed: 0, unassessable: 0, support: {}, novelty: {}, jevCalls: 0, jevCostUsd: 0 } };
}

function tally(summary, entry) {
  if (entry.event === 'turn') summary.turns++;
  if (entry.event === 'wiki-update') {
    summary.wiki.jevCalls += entry.jev?.calls || 0;
    summary.wiki.jevCostUsd += Number.isFinite(entry.jev?.costUsd) ? entry.jev.costUsd : 0;
  }
  if (entry.event !== 'wiki-assessment') return;
  summary.wiki.additions++;
  if (!entry.verdict?.support) { summary.wiki.unassessable++; return; }
  summary.wiki.assessed++;
  summary.wiki.support[entry.verdict.support] = (summary.wiki.support[entry.verdict.support] || 0) + 1;
  summary.wiki.novelty[entry.verdict.novelty] = (summary.wiki.novelty[entry.verdict.novelty] || 0) + 1;
}

class DecisionLog {
  constructor(file) { this.file = file; this.load(); }
  load() {
    this.summaryData = emptySummary();
    for (const name of [this.file + '.1', this.file]) {
      let text = '';
      try { text = fs.readFileSync(name, 'utf8'); } catch { continue; }
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        try { tally(this.summaryData, JSON.parse(line)); } catch { /* a torn line is skipped */ }
      }
    }
  }
  record(entry) {
    const row = { at: Date.now(), ...entry };
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if ((fs.statSync(this.file, { throwIfNoEntry: false })?.size || 0) > MAX_BYTES) { fs.renameSync(this.file, this.file + '.1'); this.load(); }
      fs.appendFileSync(this.file, JSON.stringify(row) + '\n');
    } catch { /* tracing is best-effort */ }
    tally(this.summaryData, row);
  }
  summary() { return JSON.parse(JSON.stringify(this.summaryData)); }
}

// For tests and for code paths without an app: records nothing.
const NO_TRACE = { record() {}, summary: emptySummary };

module.exports = { DecisionLog, NO_TRACE, hash, MAX_BYTES };
