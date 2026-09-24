// Opt-in measurement for MEASURED_REAP in src/tasks.cjs: when the Codex app-server process exits, do the processes a
// check started through it (including a detached one) stop too? No model calls, no login needed, no project changes.
//   node tests/codex-reap-live.cjs [workspace]
// Runs two cases with dangerFullAccess: the app closing Codex's input (normal exit) and Codex being terminated (crash).
// Only a Windows result can update MEASURED_REAP; elsewhere the run just exercises the script.
const fs = require('node:fs');
const os = require('node:os');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { CodexClient } = require('../src/providers/codex.cjs');
const { windowsTable, linkDescendants } = require('../src/process-tree.cjs');
const { MEASURED_REAP } = require('../src/tasks.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const WINDOWS = process.platform === 'win32';

// Linux stand-in for windowsTable(): pid, parent pid and start time from /proc.
function linuxTable() {
  const boot = Number(/^btime (\d+)$/m.exec(fs.readFileSync('/proc/stat', 'utf8'))[1]) * 1000;
  const rows = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (fields[0] === 'Z') continue; // exited, only waiting to be reaped
      rows.push({ pid: Number(name), ppid: Number(fields[1]), startedMs: boot + Number(fields[19]) * 10 });
    } catch {}
  }
  return rows;
}
const table = () => (WINDOWS ? windowsTable() : linuxTable());

// A foreground child plus one started detached, both lasting two minutes unless stopped.
const COMMAND = WINDOWS
  ? ['powershell.exe', '-NoProfile', '-NonInteractive', '-Command', "Start-Process -WindowStyle Hidden -FilePath ping.exe -ArgumentList '-n','120','127.0.0.1'; ping.exe -n 120 127.0.0.1 | Out-Null"]
  : ['sh', '-c', 'setsid sleep 120 & sleep 120'];

function stop(pid) {
  if (WINDOWS) spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  else try { process.kill(pid, 'SIGKILL'); } catch {}
}

async function measure(workspace, how) {
  const client = new CodexClient(workspace);
  client.on('disconnected', () => {});
  await client.start();
  const root = client.process.pid;
  const rootRow = table().find(row => row.pid === root);
  if (!rootRow) throw new Error('Codex process not found in the process list.');
  const known = new Map([[root, { startedMs: rootRow.startedMs, exact: true }]]);
  const exec = client.call('command/exec', {
    command: COMMAND, processId: randomUUID(), cwd: workspace, timeoutMs: 120000, sandboxPolicy: { type: 'dangerFullAccess' },
  }, 150000).then(result => ({ result }), error => ({ error: error.message }));
  // Record the tree while it runs; stop once it has not grown for a second.
  let stable = 0, size = 1;
  for (let i = 0; i < 60 && stable < 4; i++) {
    await sleep(250);
    linkDescendants(table(), known);
    stable = known.size > 2 && known.size === size ? stable + 1 : 0;
    size = known.size;
  }
  const early = await Promise.race([exec, sleep(0).then(() => null)]);
  if (early) throw new Error(`The check command ended early: ${JSON.stringify(early).slice(0, 300)}`);
  const descendants = [...known].filter(([pid]) => pid !== root);
  if (descendants.length < 2) throw new Error(`Expected the check's processes under Codex, found ${descendants.length}.`);
  if (how === 'input-closed') client.process.stdin.end(); // what the app does when it closes
  else client.process.kill(); // an abrupt exit, like a crash
  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) {
    await sleep(250);
    gone = !table().some(row => row.pid === root && Math.abs(row.startedMs - rootRow.startedMs) < 1000);
  }
  await sleep(3000); // give any cleanup time to finish
  const after = table();
  const survivors = descendants.filter(([pid, entry]) => after.some(row => row.pid === pid && Math.abs(row.startedMs - entry.startedMs) < 1000));
  for (const [pid] of survivors) stop(pid);
  if (!gone) stop(root);
  client.close(true);
  return { how, codexExited: gone, processes: descendants.length, survivors: survivors.length };
}

async function main() {
  const workspace = fs.realpathSync(process.argv[2] || os.tmpdir());
  const cases = [];
  for (const how of ['input-closed', 'terminated']) {
    const result = await measure(workspace, how);
    cases.push(result);
    console.log(`${how}: Codex exited ${result.codexExited ? 'yes' : 'NO'}, check processes ${result.processes}, still running afterwards ${result.survivors}`);
  }
  const { findCodex } = require('../src/providers/codex.cjs');
  const version = (await findCodex()).version;
  const label = version?.core ? version.core.join('.') + (version.pre?.length ? '-' + version.pre.join('.') : '') : null;
  const reaps = cases.every(result => result.codexExited && result.survivors === 0);
  const report = { measured: new Date().toISOString().slice(0, 10), codexVersion: label, platform: process.platform, sandbox: 'dangerFullAccess', reaps, cases, current: MEASURED_REAP };
  console.log(JSON.stringify(report, null, 2));
  if (!WINDOWS) console.log('Not Windows: MEASURED_REAP stays as it is.');
  else if (!reaps) console.log(`Codex ${label} does not stop every check process when it exits: leave MEASURED_REAP unchanged.`);
  else if (label === MEASURED_REAP.codexVersion) console.log('MEASURED_REAP already names this version.');
  else console.log(`Codex ${label} stops every check process when it exits. Update src/tasks.cjs:\n// Measured ${report.measured}, codex-cli ${label}, Windows, dangerFullAccess only.\nconst MEASURED_REAP = Object.freeze({ codexVersion: '${label}', platform: 'win32', sandbox: 'dangerFullAccess' });`);
}

main().catch(error => { console.error(error.stack || error.message); process.exit(1); });
