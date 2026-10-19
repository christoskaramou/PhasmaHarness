const { fork, spawn } = require('node:child_process');
const { EventEmitter, once } = require('node:events');
const { PassThrough } = require('node:stream');
const assert = require('node:assert/strict');
const { containRunner, waitForContainment, handoffInstaller } = require('../src/runner-containment.cjs');
const { INSTALL_ARGS } = require('../src/updates.cjs');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

async function containedFixture() {
  const info = await containRunner(process.env.HARNESS_CONTAIN_SCOPE);
  const code = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});
    process.stdout.write(JSON.stringify({middle:process.pid,leaf:child.pid})+'\\n');
    setInterval(()=>{},1000);`;
  const middle = spawn(process.execPath, ['-e', code], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  middle.once('error', error => { throw error; });
  middle.stdout.once('data', data => {
    process.send({ ...info, ...JSON.parse(data.toString()), runner: process.pid });
  });
  middle.stderr.resume();
  process.on('message', async command => {
    if (command === 'exit') process.exit(0);
    if (command === 'lose-lease') info.detach();
    if (command?.installer) {
      try { await info.launchInstaller(command.installer); process.exit(0); }
      catch (error) { process.stderr.write(error.stack + '\n'); process.exit(1); }
    }
  });
}

if (process.argv.includes('--contained-root')) {
  containedFixture().catch(error => { process.stderr.write(error.stack + '\n'); process.exit(1); });
} else {
  const test = require('node:test');
  const tree = require('../src/process-tree.cjs');
  const monitor = () => Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() });

  test('containment startup requires the private challenge and an acknowledged ready message', async () => {
    const child = monitor(), writes = [];
    child.stdin.on('data', text => writes.push(text.toString()));
    const ready = waitForContainment(child);
    child.stdout.write('challenge:0123456789abcdef');
    child.stdout.write('0123456789abcdef\r\n');
    assert.deepEqual(writes, ['ack:0123456789abcdef0123456789abcdef\n']);
    child.stdout.write('ready\n');
    await ready;
  });

  test('invalid, missing and failed containment handshakes never acknowledge startup', async () => {
    for (const output of ['ready\n', 'challenge:invalid\n', 'x'.repeat(4097)]) {
      const child = monitor(), ready = waitForContainment(child);
      child.stdout.write(output);
      await assert.rejects(ready, /invalid monitor/);
    }
    const child = monitor(), ready = waitForContainment(child);
    child.stderr.write('Fixture containment failure');
    child.emit('close', 1);
    await assert.rejects(ready, /Fixture containment failure/);
    await assert.rejects(waitForContainment(monitor(), 20), /startup timed out/);
  });

  test('installer handoffs use fixed update arguments and distinguish refusal from uncertain acceptance', async () => {
    const file = path.join(os.tmpdir(), 'Phasma-Harness-Setup-0.0.0.exe');
    const child = monitor();
    child.stdin.on('data', text => {
      assert.deepEqual(JSON.parse(text), { type: 'installer', file, args: INSTALL_ARGS });
      child.stdout.write('installer-accepted\n');
    });
    await handoffInstaller(child, file);
    await assert.rejects(handoffInstaller(monitor(), 'relative.exe'), /Invalid installer path/);
    const refused = monitor(), refusal = handoffInstaller(refused, file);
    refused.stdout.write('installer-error:' + Buffer.from('Missing installer.').toString('base64') + '\n');
    await assert.rejects(refusal, error => /Missing installer/.test(error.message) && !error.launchUncertain);
    await assert.rejects(handoffInstaller(monitor(), file, 20), error => error.launchUncertain === true);
  });

  test('a store-scoped lifetime job refuses an overlapping runner and fences cleanup before restart',
    { skip: process.platform !== 'win32', timeout: 40000 }, async t => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-restart-fence-'));
      const env = { ...process.env, HARNESS_CONTAIN_SCOPE: directory }; delete env.NODE_TEST_CONTEXT;
      const children = [], known = [];
      t.after(() => {
        for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
        tree.stopRecord({ id: 'restart-fence-fixture', roots: [], tags: [], children: known }, 2000);
        fs.rmSync(directory, { recursive: true, force: true });
      });
      const launch = () => {
        const child = fork(__filename, ['--contained-root'], { execArgv: [], env, windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
        children.push(child); child.stdout.resume();
        let errors = '';
        child.stderr.on('data', text => { errors = (errors + text).slice(-2000); });
        const ready = Promise.race([
          once(child, 'message').then(([info]) => info),
          once(child, 'exit').then(() => { throw new Error(errors || 'Fixture exited before ready.'); }),
        ]);
        return { child, ready };
      };
      const first = launch(), info = await first.ready;
      assert.equal(info.recoverySafe, true);
      const ids = [info.runner, info.helperPid, info.middle, info.leaf];
      known.push(...tree.windowsTable().filter(row => ids.includes(row.pid)).map(row => ({ pid: row.pid, startedMs: row.startedMs, exact: true })));
      const overlap = launch();
      await assert.rejects(overlap.ready, /previous runner|connection timed out/);
      assert.equal(first.child.exitCode, null, 'a refused runner must not terminate the existing owner');
      const exited = once(first.child, 'exit'); first.child.kill(); await exited;
      const next = launch(), nextInfo = await next.ready;
      const table = tree.windowsTable();
      assert.ok(known.every(row => !table.some(live => live.pid === row.pid && live.startedMs === row.startedMs)),
        'old runner descendants are gone before the next runner is admitted');
      const nextIds = [nextInfo.runner, nextInfo.helperPid, nextInfo.middle, nextInfo.leaf];
      known.push(...table.filter(row => nextIds.includes(row.pid)).map(row => ({ pid: row.pid, startedMs: row.startedMs, exact: true })));
    });

  for (const ending of ['runner crash', 'graceful exit', 'monitor crash', 'installer handoff', 'control-lease loss']) {
    test(`Windows job contains detached descendants after ${ending}`, { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      let directory, installer;
      if (ending === 'installer handoff') {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-installer-fixture-'));
        installer = path.join(directory, 'Phasma-Harness-Setup-0.0.0.exe');
        env.HARNESS_INSTALL_MARKER = path.join(directory, 'started.txt');
        const code = `public class InstallerFixture { public static void Main(string[] args) {
          System.IO.File.WriteAllText(System.Environment.GetEnvironmentVariable("HARNESS_INSTALL_MARKER"),
            System.Diagnostics.Process.GetCurrentProcess().Id.ToString()+"\\n"+System.String.Join("|",args));
          if(args.Length==0 || args[0]!="--probe") System.Threading.Thread.Sleep(20000);
        } }`;
        const command = `Add-Type -TypeDefinition @'\n${code}\n'@ -OutputType ConsoleApplication -OutputAssembly '${installer.replace(/'/g, "''")}'`;
        const systemModules = path.join(process.env.WINDIR || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0');
        const compiled = spawnSync(path.join(systemModules, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
          { windowsHide: true, encoding: 'utf8', timeout: 10000, env: { ...env, PSModulePath: path.join(systemModules, 'Modules') } });
        assert.equal(compiled.status, 0, compiled.stderr);
        const probe = spawnSync(installer, ['--probe'], { env, windowsHide: true, timeout: 3000, encoding: 'utf8' });
        assert.equal(probe.status, 0, probe.stderr);
        assert.ok(fs.existsSync(env.HARNESS_INSTALL_MARKER), 'the private installer fixture can start');
        fs.unlinkSync(env.HARNESS_INSTALL_MARKER);
      }
      const child = fork(__filename, ['--contained-root'], { execArgv: [], env, windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
      child.stdout.resume();
      let errors = '';
      child.stderr.on('data', text => { errors = (errors + text).slice(-2000); });
      let known = [];
      t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) child.kill();
        if (known.length) {
          const cleanup = tree.stopRecord({ id: 'containment-fixture', roots: [], tags: [], children: known }, 2000);
          assert.deepEqual(cleanup.remaining, [], 'private fixture cleanup must be confirmed before removing its installer');
        }
        if (directory) fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      });
      const info = await Promise.race([
        once(child, 'message').then(([message]) => message),
        once(child, 'exit').then(() => { throw new Error(`Contained fixture exited before ready: ${errors}`); }),
        new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`Contained fixture startup timed out: ${errors}`)), 12000); timer.unref(); }),
      ]);
      const ids = [info.runner, info.helperPid, info.middle, info.leaf];
      const before = tree.windowsTable();
      known = before.filter(row => ids.includes(row.pid)).map(row => ({ pid: row.pid, startedMs: row.startedMs, exact: true }));
      assert.equal(known.length, 4, 'all private fixture processes were observed');
      const exited = once(child, 'exit');
      if (ending === 'control-lease loss') child.send('lose-lease');
      else if (ending === 'installer handoff') child.send({ installer });
      else if (ending === 'runner crash') child.kill();
      else if (ending === 'graceful exit') child.send('exit');
      else tree.stopRecord({ id: 'monitor-fixture', roots: [], tags: [], children: known.filter(row => row.pid === info.helperPid) }, 2000);
      await exited;
      if (installer) {
        assert.equal(child.exitCode, 0, errors);
        for (let attempt = 0; attempt < 100 && !fs.existsSync(env.HARNESS_INSTALL_MARKER); attempt++) await new Promise(resolve => setTimeout(resolve, 50));
        const errorFile = installer + '.launch-error.txt';
        assert.equal(fs.existsSync(env.HARNESS_INSTALL_MARKER), true, 'the outside-job fixture installer started after runner exit: ' +
          (fs.existsSync(errorFile) ? fs.readFileSync(errorFile, 'utf8') : errors));
        const [pid, args] = fs.readFileSync(env.HARNESS_INSTALL_MARKER, 'utf8').split('\n');
        assert.equal(args, INSTALL_ARGS.join('|'));
        const process = tree.windowsTable().find(row => row.pid === Number(pid));
        assert.ok(process, 'the installer survives the old runner job');
        known.push({ pid: process.pid, startedMs: process.startedMs, exact: true });
      }
      for (let attempt = 0; attempt < 5; attempt++) {
        const after = tree.windowsTable();
        const remaining = known.filter(entry => ids.includes(entry.pid) && after.some(row => row.pid === entry.pid && Math.abs(row.startedMs - entry.startedMs) < 1));
        if (!remaining.length) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      assert.fail('A contained private fixture process survived its runner or monitor');
    });
  }

  test('the Windows job name is stable for recovery but not derivable from the data path alone', t => {
    const { scopeJobName } = require('../src/runner-containment.cjs');
    const { createHash } = require('node:crypto');
    const first = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-job-name-')), second = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-job-name-'));
    t.after(() => { fs.rmSync(first, { recursive: true, force: true }); fs.rmSync(second, { recursive: true, force: true }); });
    const name = scopeJobName(first);
    assert.match(name, /^[a-f0-9]{64}$/);
    assert.equal(scopeJobName(first), name, 'a restart finds the same job');
    assert.notEqual(name, createHash('sha256').update(fs.realpathSync(first).toLowerCase()).digest('hex'));
    assert.notEqual(scopeJobName(second), name);
    fs.writeFileSync(path.join(second, 'credentials.runner-job'), 'tampered');
    assert.throws(() => scopeJobName(second), /job key is invalid/);
  });
}
