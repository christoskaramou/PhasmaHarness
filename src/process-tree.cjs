// Finds and stops every process a local check (or any worker the app started) started, including detached or
// reparented descendants. Linux: an inherited environment tag, found in /proc/<pid>/environ. Windows: orphans keep
// ParentProcessId, so a tree recorded while the process runs (plus a final snapshot) links detached children back to it.
const fs = require('node:fs');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const TAG = 'PHASMA_HARNESS_CHECK';
// Every worker process this app run starts carries OWNER=<run>/<n>; see spawnOwned.
const OWNER = 'PHASMA_HARNESS_OWNER';
const RUN = randomUUID();
const FILETIME_EPOCH_MS = 11644473600000;
// Enumeration errors must terminate: a non-terminating CIM error otherwise exits 0 with no rows, which would read as "nothing left".
const LIST = 'foreach ($p in Get-CimInstance Win32_Process -ErrorAction Stop) { "$($p.ProcessId) $($p.ParentProcessId) $($p.CreationDate.ToFileTimeUtc())" }';
const END = 'END-OF-PROCESS-LIST';
const scan = { // replaceable in tests
  run: (file, args, options) => spawnSync(file, args, options),
  // The same without blocking: resolves with { status, stdout, stderr } or { error }.
  runAsync: (file, args, options) => new Promise(resolve => {
    let child;
    try { child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (error) { resolve({ error }); return; }
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    const timer = setTimeout(() => child.kill(), options?.timeout || 15000);
    child.once('error', error => { clearTimeout(timer); resolve({ error }); });
    child.once('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
  }),
  taskkill: args => spawn('taskkill.exe', args, { windowsHide: true, stdio: 'ignore' }),
  taskkillSync: args => spawnSync('taskkill.exe', args, { windowsHide: true, timeout: 15000, stdio: 'ignore' }),
};
const TABLE = ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; ${LIST}; '${END}'`];
const TABLE_OPTIONS = { encoding: 'utf8', timeout: 15000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 };

function parseRows(text) {
  return String(text || '').split(/\r?\n/).map(line => line.trim().split(' ')).filter(parts => parts.length === 3 && parts.every(part => /^\d+$/.test(part)))
    .map(([pid, ppid, filetime]) => ({ pid: Number(pid), ppid: Number(ppid), startedMs: Number(filetime) / 10000 - FILETIME_EPOCH_MS }));
}

// Throws unless the scan provably completed: exit 0, nothing on stderr, the end marker last, and at least one row.
const windowsTable = () => tableFrom(scan.run('powershell.exe', TABLE, TABLE_OPTIONS));
const windowsTableAsync = async () => tableFrom(await scan.runAsync('powershell.exe', TABLE, TABLE_OPTIONS));
function tableFrom(result) {
  const lines = String(result?.stdout || '').trim().split(/\r?\n/);
  if (result?.error || result?.status !== 0 || String(result?.stderr || '').trim() || lines.at(-1)?.trim() !== END) throw new Error('Process list unavailable.');
  const rows = parseRows(lines.slice(0, -1).join('\n'));
  if (!rows.length) throw new Error('Process list unavailable.');
  return rows;
}

// `known` maps pid -> { startedMs, exact, endedMs? }. Observed processes must match their creation time exactly; only a
// root, recorded from the wall clock just before spawn and not yet observed, gets a narrow window. endedMs is when the
// process was known to be gone: a child of it must have started by then, and a later process with its pid is not ours.
const same = (entry, startedMs) => entry.exact ? Math.abs(startedMs - entry.startedMs) < 1 : startedMs >= entry.startedMs - 1000 && startedMs <= entry.startedMs + 2000;
const after = (parent, startedMs) => startedMs >= parent.startedMs - (parent.exact ? 0 : 1000) && (parent.endedMs === undefined || startedMs <= parent.endedMs);
const alive = (entry, row) => !!entry && entry.endedMs === undefined && same(entry, row.startedMs);

// Grows `known` with every process whose known parent started before it (and, for an ended parent, before it ended).
// `now` is when `table` was read. Returns whether `known` changed.
function linkDescendants(table, known, now = Date.now()) {
  let changed = false;
  const live = new Map(table.map(row => [row.pid, row]));
  for (const [pid, entry] of known) {
    const row = live.get(pid);
    if (entry.endedMs !== undefined) {
      // Ended, so never ours again; a newcomer with its pid started after it ended, which tightens the bound.
      if (row && !same(entry, row.startedMs) && row.startedMs <= entry.endedMs) { entry.endedMs = row.startedMs - 1; changed = true; }
      continue;
    }
    if (!row) { entry.endedMs = now; changed = true; continue; }
    if (!same(entry, row.startedMs)) { known.delete(pid); changed = true; } // reused before we saw it end: neither it nor its children are ours
    else if (!entry.exact) { known.set(pid, { startedMs: row.startedMs, exact: true }); changed = true; }
  }
  for (let grew = true; grew;) {
    grew = false;
    for (const row of table) {
      const existing = known.get(row.pid);
      if (existing && (existing.endedMs === undefined || same(existing, row.startedMs))) continue; // known; an ended one is not revived
      const parent = known.get(row.ppid);
      if (parent && after(parent, row.startedMs)) { known.set(row.pid, { startedMs: row.startedMs, exact: true }); grew = changed = true; }
    }
  }
  return changed;
}

const hasProc = () => process.platform === 'linux' && fs.existsSync('/proc/self/environ');
const linuxTagged = id => tagged(`${TAG}=${id}\0`);

// Live (not zombie) processes whose environment contains `needle`, except this one.
function tagged(needle) {
  const found = [];
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
  linkDescendants(table, known, Date.now());
  return table.filter(row => alive(known.get(row.pid), row)).map(row => row.pid);
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

// Worker processes this app run started (Codex app-servers, Claude and Cursor CLIs, local checks), recorded with their
// spawn and exit times so their trees, and nothing else, can be stopped when the app quits.
const owned = new Map(); // key -> { pid, startedMs, endedMs? }
let spawned = 0;

// spawn() through `launch`, tagging the process (and so, on Linux, its descendants) and recording it.
function spawnOwned(launch, file, args, options = {}) {
  const key = `${RUN}/${++spawned}`;
  const startedMs = Date.now();
  const child = launch(file, args, { ...options, env: { ...(options.env || process.env), [OWNER]: key } });
  if (!child) return child;
  child.ownerKey = key;
  if (Number.isInteger(child.pid)) {
    const entry = { pid: child.pid, startedMs };
    owned.set(key, entry);
    child.once('exit', () => { entry.endedMs = Date.now(); });
    // Bounded: the oldest ended entries go first.
    for (const [old, item] of owned) { if (owned.size <= 1000) break; if (item.endedMs !== undefined) owned.delete(old); }
  }
  return child;
}

// Cleanup of worker processes. A target names what to stop: `roots()` gives root records { pid, startedMs, endedMs? }
// (re-read on every scan), `tags` the Linux owner tags, `known` the Windows tree recorded so far (it grows). A running
// Linux root (`spare`) gets until `graceUntil` to exit on its own signal before it is killed too.
function aliveIn(target, table) {
  if (process.platform === 'win32') {
    linkDescendants(table, withRoots(target.known, target.roots()), Date.now());
    return table.filter(row => alive(target.known.get(row.pid), row)).map(row => row.pid);
  }
  if (hasProc()) return target.tags.flatMap(tag => tagged(tag));
  return [...target.roots()].filter(root => root.endedMs === undefined).map(root => root.pid);
}
const killable = (target, pids) => (Date.now() < (target.graceUntil || 0) ? pids.filter(pid => pid !== target.spare) : pids);
// Only verified pids (no /T: taskkill's own tree walk goes by parent pid alone); new children show up on the rescan.
const taskkillArgs = pids => { const batches = []; for (let i = 0; i < pids.length; i += 40) batches.push(['/F', ...pids.slice(i, i + 40).flatMap(pid => ['/PID', String(pid)])]); return batches; };
const exited = proc => new Promise(resolve => { proc.once('exit', resolve); proc.once('error', resolve); });

// Blocking: kills the target's live processes and re-checks until none remain or the deadline passes.
// Returns { stopped, remaining }; a failed scan counts as unconfirmed (-1).
function stopTarget(target, deadline) {
  const scanNow = () => aliveIn(target, process.platform === 'win32' ? windowsTable() : null);
  let found;
  try { found = scanNow(); } catch { return { stopped: 0, remaining: [-1] }; }
  const stopped = found.length;
  while (found.length && Date.now() < deadline) {
    const pids = killable(target, found);
    if (process.platform === 'win32') for (const args of taskkillArgs(pids)) scan.taskkillSync(args);
    else for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    sleep(150);
    try { found = scanNow(); } catch { return { stopped, remaining: [-1] }; }
  }
  return { stopped, remaining: found };
}

// The same without blocking. Resolves with the pids still running ([-1] when the process list could not be read).
async function sweepTarget(target, deadline) {
  for (;;) {
    let found;
    try { found = aliveIn(target, process.platform === 'win32' ? await windowsTableAsync() : null); } catch { return [-1]; }
    if (!found.length || Date.now() >= deadline) return found;
    const pids = killable(target, found);
    if (process.platform === 'win32') for (const args of taskkillArgs(pids)) await exited(scan.taskkill(args));
    else for (const pid of pids) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    await new Promise(resolve => setTimeout(resolve, 150));
  }
}

const workerTarget = key => ({ roots: () => (owned.has(key) ? [owned.get(key)] : []), tags: [`${OWNER}=${key}\0`], known: new Map() });
const runTarget = known => ({ roots: () => owned.values(), tags: [`${OWNER}=${RUN}/`], known });

// A cleanup that could not be confirmed, in a form that survives a restart: the roots and the recorded tree
// (Windows) and the owner tag (Linux).
function cleanupRecord(id, target) {
  const entry = (pid, e) => ({ pid, startedMs: e.startedMs, exact: e.exact === true, ...(e.endedMs !== undefined && { endedMs: e.endedMs }) });
  return {
    id, tags: target.tags,
    roots: [...target.roots()].map(root => ({ pid: root.pid, startedMs: root.startedMs, ...(root.endedMs !== undefined && { endedMs: root.endedMs }) })),
    children: [...target.known].slice(-500).map(([pid, e]) => entry(pid, e)),
  };
}
function recordTarget(record) {
  const roots = (record.roots || []).filter(root => Number.isInteger(root?.pid));
  return {
    roots: () => roots, tags: (record.tags || []).filter(tag => typeof tag === 'string' && tag.startsWith(`${OWNER}=`)),
    known: new Map((record.children || []).map(c => [c.pid, { startedMs: c.startedMs, exact: c.exact === true, ...(c.endedMs !== undefined && { endedMs: c.endedMs }) }])),
  };
}
// Retrying a recorded cleanup: blocking (at start-up) or not (while the app runs). A record is confirmed clean when
// nothing remains; `record` is its grown version (descendants found by this retry included), to keep for the next.
function stopRecord(record, ms = 5000) {
  const target = recordTarget(record);
  return { ...stopTarget(target, Date.now() + ms), record: cleanupRecord(record.id, target) };
}
async function sweepRecord(record, ms = 5000) {
  const target = recordTarget(record);
  return { remaining: await sweepTarget(target, Date.now() + ms), record: cleanupRecord(record.id, target) };
}

// Stop-time cleanups report here: 'pending' (id) when one starts, 'done' ({ id, remaining, record }) when it ends;
// `record` is set only when something could not be confirmed stopped. The controller keeps new work blocked meanwhile.
const cleanup = new EventEmitter();
cleanup.setMaxListeners(0);
const sweeps = new Map(); // id -> in-flight cleanup

// Stops a process the app started together with everything it started, also after the process itself has exited
// (a detached tool can outlive it and hold its output open). Windows: taskkill /T at once while the root still lives,
// never by pid once it has exited (the pid may be someone else's by then). Then, without blocking, whatever is left of
// its tree is killed and checked again (Windows: its recorded tree, verified by creation time; Linux: its owner tag).
// Once the root has exited, our ends of its pipes are closed, so a turn waiting for its output ends even if something
// that could not be found still holds them. Resolves with what is still running (see `cleanup`).
function stopTree(child) {
  if (!child) return Promise.resolve([]);
  const running = child.exitCode == null && child.signalCode == null;
  if (process.platform === 'win32' && child.pid) {
    if (running) scan.taskkill(['/PID', String(child.pid), '/T', '/F']).on('error', () => child.kill());
  } else if (running) child.kill();
  const release = () => { for (const stream of [child.stdin, child.stdout, child.stderr]) stream?.destroy?.(); };
  if (!running) release(); else child.once?.('exit', release);
  const id = child.ownerKey;
  if (!id || !owned.has(id)) return Promise.resolve([]);
  if (sweeps.has(id)) return sweeps.get(id);
  const target = workerTarget(id);
  if (running && process.platform !== 'win32') Object.assign(target, { spare: child.pid, graceUntil: Date.now() + 1000 });
  cleanup.emit('pending', id);
  const sweep = sweepTarget(target, Date.now() + 5000).catch(() => [-1]).then(remaining => {
    sweeps.delete(id);
    cleanup.emit('done', { id, remaining, record: remaining.length ? cleanupRecord(id, target) : null });
    return remaining;
  });
  sweeps.set(id, sweep);
  return sweep;
}

// Adds recorded roots to `known` (Windows). The newest process with a pid wins; an ended root keeps its exit time.
function withRoots(known, roots = owned.values()) {
  for (const root of roots) {
    const mine = { startedMs: root.startedMs, exact: false }, seen = known.get(root.pid);
    if (seen && same(mine, seen.startedMs)) {
      if (root.endedMs !== undefined && !(seen.endedMs <= root.endedMs)) seen.endedMs = root.endedMs;
      continue;
    }
    if (seen && seen.startedMs > root.startedMs) continue; // a later process holds this pid
    known.set(root.pid, root.endedMs === undefined ? mine : { ...mine, endedMs: root.endedMs });
  }
  return known;
}

// Windows: records the live worker trees (adding to `known`) before anything is asked to exit, so a child whose parent
// exits first is still linked. Returns the map to pass to stopOwned (empty elsewhere, or when the scan fails).
function snapshotOwned(known = new Map()) {
  if (process.platform === 'win32' && [...owned.values()].some(root => root.endedMs === undefined)) try { aliveIn(runTarget(known), windowsTable()); } catch { /* stopOwned rescans */ }
  return known;
}

// Resolves once every recorded worker has exited, or after `ms`.
async function settleOwned(ms) {
  for (const end = Date.now() + ms; [...owned.values()].some(root => root.endedMs === undefined) && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 50));
}

// Quitting: kills whatever this app run's workers left running and re-checks until nothing remains or the deadline
// passes. Returns { stopped, remaining, record } (record: what to retry at the next start when something remains).
function stopOwned({ known = new Map(), deadline = Date.now() + 5000 } = {}) {
  if (!owned.size) return { stopped: 0, remaining: [], record: null };
  const target = runTarget(known);
  const result = stopTarget(target, deadline);
  return { ...result, record: result.remaining.length ? cleanupRecord(`run:${RUN}`, target) : null };
}

module.exports = { TAG, OWNER, Watch, leftovers, stopLeftovers, linkDescendants, parseRows, windowsTable, scan,
  spawnOwned, stopTree, snapshotOwned, settleOwned, stopOwned, stopRecord, sweepRecord, cleanup, owned };
