// Finds and stops every process a local check started, including detached or reparented descendants.
// Linux: an inherited environment tag, found in /proc/<pid>/environ. Windows: orphans keep ParentProcessId, so a
// tree recorded while the check runs (plus a final snapshot) links detached children back to the check.
const fs = require('node:fs');
const { spawn, spawnSync } = require('node:child_process');

const TAG = 'PHASMA_HARNESS_CHECK';
const FILETIME_EPOCH_MS = 11644473600000;
// Enumeration errors must terminate: a non-terminating CIM error otherwise exits 0 with no rows, which would read as "nothing left".
const LIST = 'foreach ($p in Get-CimInstance Win32_Process -ErrorAction Stop) { "$($p.ProcessId) $($p.ParentProcessId) $($p.CreationDate.ToFileTimeUtc())" }';
const END = 'END-OF-PROCESS-LIST';
const scan = { run: (file, args, options) => spawnSync(file, args, options) }; // replaceable in tests

function parseRows(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim().split(' ')).filter(parts => parts.length === 3 && parts.every(part => /^\d+$/.test(part)))
    .map(([pid, ppid, filetime]) => ({ pid: Number(pid), ppid: Number(ppid), startedMs: Number(filetime) / 10000 - FILETIME_EPOCH_MS }));
}

// Throws unless the scan provably completed: exit 0, nothing on stderr, the end marker last, and at least one row.
function windowsTable() {
  const result = scan.run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ${LIST}; '${END}'`],
    { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 });
  const lines = String(result?.stdout || '').trim().split(/\r?\n/);
  if (result?.error || result?.status !== 0 || String(result?.stderr || '').trim() || lines.at(-1)?.trim() !== END) throw new Error('Process list unavailable.');
  const rows = parseRows(lines.slice(0, -1).join('\n'));
  if (!rows.length) throw new Error('Process list unavailable.');
  return rows;
}

// `known` maps pid -> { startedMs, exact }. Observed processes must match their creation time exactly; only the root,
// recorded from the wall clock just before spawn and not yet observed, gets a narrow window.
const same = (entry, startedMs) => entry.exact ? Math.abs(startedMs - entry.startedMs) < 1 : startedMs >= entry.startedMs - 1000 && startedMs <= entry.startedMs + 2000;
const after = (parent, startedMs) => startedMs >= parent.startedMs - (parent.exact ? 0 : 1000);

// Grows `known` with every process whose known parent started before it. Returns whether `known` changed.
function linkDescendants(table, known) {
  let changed = false;
  const live = new Map(table.map(row => [row.pid, row]));
  for (const [pid, entry] of known) {
    const row = live.get(pid);
    if (!row) continue;
    if (!same(entry, row.startedMs)) { known.delete(pid); changed = true; } // reused pid: neither it nor its children are ours
    else if (!entry.exact) { known.set(pid, { startedMs: row.startedMs, exact: true }); changed = true; }
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const row of table) {
      if (known.has(row.pid)) continue;
      const parent = known.get(row.ppid);
      if (parent && after(parent, row.startedMs)) { known.set(row.pid, { startedMs: row.startedMs, exact: true }); grew = changed = true; }
    }
  }
  return changed;
}

function linuxTagged(id) {
  const needle = `${TAG}=${id}\0`, found = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (!fs.readFileSync(`/proc/${name}/environ`, 'latin1').includes(needle)) continue;
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      if (stat.slice(stat.lastIndexOf(')') + 2)[0] !== 'Z') found.push(Number(name));
    } catch { /* exited, or another user's process */ }
  }
  return found;
}

// Live processes that belong to the check `id` rooted at `pid` (recorded at `spawnedAt`).
function leftovers({ id, pid, spawnedAt, known = new Map() }) {
  if (process.platform !== 'win32') return linuxTagged(id);
  if (!pid) throw new Error('Check process was never recorded.');
  if (!known.has(pid)) known.set(pid, { startedMs: spawnedAt, exact: false });
  const table = windowsTable();
  linkDescendants(table, known);
  return table.filter(row => known.has(row.pid) && same(known.get(row.pid), row.startedMs)).map(row => row.pid);
}

function kill(pid) {
  if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15000 });
  else try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
}

const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// Kills everything the check left behind and re-scans until nothing remains (or 5 s pass).
// Returns { stopped, remaining }; a failed scan counts as unconfirmed.
function stopLeftovers(owner) {
  let found;
  try { found = leftovers(owner); } catch { return { stopped: 0, remaining: [owner.pid || -1] }; }
  const stopped = found.length;
  for (let deadline = Date.now() + 5000; found.length && Date.now() < deadline;) {
    for (const pid of found) kill(pid);
    sleep(100);
    try { found = leftovers(owner); } catch { return { stopped, remaining: [owner.pid || -1] }; }
  }
  return { stopped, remaining: found };
}

// Windows only: records the check's tree every ~400 ms so short-lived intermediates still link their children.
class Watch {
  constructor(pid, spawnedAt, onChange = () => {}) {
    this.known = new Map([[pid, { startedMs: spawnedAt, exact: false }]]);
    if (process.platform !== 'win32' || !pid) return;
    let buffer = '', rows = '';
    // A failed snapshot prints ERR and is discarded, never merged as a partial tree.
    this.child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$ProgressPreference = 'SilentlyContinue'; while ($true) { try { $rows = @(${LIST}); $rows; '--' } catch { 'ERR' }; Start-Sleep -Milliseconds 400 }`], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.child.on('error', () => {});
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', data => {
      buffer += data;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (line === 'ERR') { rows = ''; continue; }
        if (line !== '--') { rows += line + '\n'; continue; }
        const changed = linkDescendants(parseRows(rows), this.known);
        rows = '';
        if (changed) onChange(this.known);
      }
    });
  }
  stop() { if (this.child?.pid) spawnSync('taskkill.exe', ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, timeout: 15000 }); }
}

module.exports = { TAG, Watch, leftovers, stopLeftovers, linkDescendants, parseRows, windowsTable, scan };
