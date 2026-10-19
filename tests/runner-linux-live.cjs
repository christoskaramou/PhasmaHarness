const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { serviceUnit } = require('../src/runner-linux.cjs');
const { containRunner } = require('../src/runner-containment.cjs');

if (process.platform !== 'linux') { console.log('Linux service acceptance requires Linux/systemd.'); process.exit(77); }
const run = promisify(execFile);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const birth = pid => {
  try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19]; } catch { return null; }
};
const alive = row => birth(row.pid) === row.birth;

if (process.argv[2] === '--hold') {
  process.on('SIGTERM', () => {});
  if (process.argv[3] === 'parent') {
    const child = spawn(process.execPath, [__filename, '--hold'], { detached: true, stdio: 'ignore' });
    child.unref();
    fs.writeFileSync(process.argv[4], JSON.stringify({ pid: child.pid, birth: birth(child.pid) }));
  }
  setInterval(() => {}, 1000);
} else if (process.argv[2] === '--service') {
  (async () => {
    const scope = process.argv[3];
    const verified = await containRunner(scope);
    assert.equal(verified.recoverySafe, true);
    const firstFile = path.join(scope, 'first.json');
    if (fs.existsSync(firstFile)) {
      const first = JSON.parse(fs.readFileSync(firstFile, 'utf8'));
      assert.ok(first.children.every(row => !alive(row)), 'old workers must be gone before safe recovery');
      fs.writeFileSync(path.join(scope, 'second.json'), JSON.stringify({ pid: process.pid, verified }));
    } else {
      const descendantFile = path.join(scope, 'descendant.json');
      const child = spawn(process.execPath, [__filename, '--hold', 'parent', descendantFile], { detached: true, stdio: 'ignore' });
      child.unref();
      for (let i = 0; i < 100 && !fs.existsSync(descendantFile); i++) await pause(20);
      const descendant = JSON.parse(fs.readFileSync(descendantFile, 'utf8'));
      fs.writeFileSync(firstFile, JSON.stringify({ pid: process.pid, verified,
        children: [{ pid: child.pid, birth: birth(child.pid) }, descendant] }));
    }
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
  })().catch(error => { console.error(error.stack); process.exit(1); });
} else {
  (async () => {
    try { await run('/usr/bin/systemctl', ['--user', 'show', '--property=Version'], { timeout: 5000, maxBuffer: 16384 }); }
    catch { console.log('Linux service acceptance skipped: a running user systemd manager is required.'); process.exitCode = 77; return; }
    const scope = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-linux-service-')));
    const unit = serviceUnit(scope);
    let first, success = false;
    try {
      await run('/usr/bin/systemd-run', ['--user', '--collect', '--unit=' + unit, '--property=Type=exec',
        '--property=Restart=on-failure', '--property=RestartSec=200ms', '--property=TimeoutStopSec=20s',
        '--property=KillMode=control-group', '--property=SendSIGKILL=yes', '--property=ExitType=main',
        '--property=NoNewPrivileges=yes', '--property=ProtectControlGroups=yes', '--property=Delegate=no',
        '--property=RuntimeMaxSec=60s', '--property=StartLimitIntervalSec=1h', '--property=StartLimitBurst=2',
        '--', process.execPath, __filename, '--service', scope], { timeout: 10000, maxBuffer: 16384 });
      const read = filename => { try { return JSON.parse(fs.readFileSync(path.join(scope, filename), 'utf8')); } catch { return null; } };
      for (let i = 0; i < 100 && !(first = read('first.json')); i++) await pause(100);
      assert.ok(first, 'the managed runner must verify its service and start its private fixture workers');
      assert.ok(first.children.every(alive), 'both detached fixture descendants must be running before the crash');
      await run('/usr/bin/systemctl', ['--user', 'kill', '--kill-whom=main', '--signal=SIGKILL', unit], { timeout: 5000 });
      let second;
      for (let i = 0; i < 300 && !(second = read('second.json')); i++) await pause(100);
      assert.ok(second, 'systemd must clean the old cgroup and restart within the bounded policy');
      assert.notEqual(second.pid, first.pid);
      assert.ok(first.children.every(row => !alive(row)));
      assert.equal(second.verified.recoverySafe, true);
      console.log('Linux service passed: verified scope, detached descendants, forced crash, cgroup cleanup and fenced restart.');
      success = true;
    } finally {
      if (!success) {
        const log = await run('/usr/bin/journalctl', ['--user', '-u', unit, '-n', '25', '--no-pager'], { timeout: 5000 }).catch(() => ({ stdout: '' }));
        console.error(log.stdout);
      }
      await run('/usr/bin/systemctl', ['--user', 'stop', unit], { timeout: 30000 }).catch(error => {
        if (!/not loaded|not found/.test(String(error.stderr))) throw error;
      });
      const remaining = first?.children.filter(alive) || [];
      assert.deepEqual(remaining, [], 'fixture workers survived service cleanup');
      assert.equal(path.dirname(scope), fs.realpathSync(os.tmpdir()));
      assert.ok(path.basename(scope).startsWith('harness-linux-service-'));
      fs.rmSync(scope, { recursive: true, force: true });
    }
  })().catch(error => { console.error(error.stack); process.exitCode = 1; });
}
