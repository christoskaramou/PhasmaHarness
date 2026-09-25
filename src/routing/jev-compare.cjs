// Opt-in "Compare with Jev" log: for each message, Jev's worker choice next to the worker that actually ran
// (the Smart router's pick or your manual choice). It only records; it never changes routing.
// One JSON line per message, no message text. The summary is kept in memory and updated per record.
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024;
const same = (a, b) => (a.provider || 'codex') === (b.provider || 'codex');

function tally(summary, entry) {
  if (entry.error) { summary.errors++; return; }
  summary.compared++;
  if (entry.jev.id === entry.used.id) summary.sameWorker++;
  if (same(entry.jev, entry.used) && entry.jev.model === entry.used.model) summary.sameModel++;
  if (same(entry.jev, entry.used)) summary.sameProvider++;
  if (entry.used.source === 'manual') { summary.manual++; if (same(entry.jev, entry.used) && entry.jev.model === entry.used.model) summary.manualSameModel++; }
  summary.costUsd += Number.isFinite(entry.jev.costUsd) ? entry.jev.costUsd : 0;
}

class JevCompareLog {
  constructor(file) { this.file = file; this.load(); }
  static empty() { return { compared: 0, errors: 0, sameWorker: 0, sameModel: 0, sameProvider: 0, manual: 0, manualSameModel: 0, costUsd: 0 }; }
  // The summary covers what is on disk: the current file and the one kept at rotation.
  load() {
    this.summaryData = JevCompareLog.empty();
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
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      if ((fs.statSync(this.file, { throwIfNoEntry: false })?.size || 0) > MAX_BYTES) { fs.renameSync(this.file, this.file + '.1'); this.load(); }
      fs.appendFileSync(this.file, JSON.stringify(entry) + '\n');
    } catch { /* comparison logging is best-effort */ }
    tally(this.summaryData, entry);
  }
  summary() { return { ...this.summaryData }; }
}

module.exports = { JevCompareLog, MAX_BYTES };
