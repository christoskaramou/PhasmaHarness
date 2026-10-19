const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { randomUUID, createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { INSTALL_ARGS } = require('./updates.cjs');

// The Global job name must stay stable so a restart finds the previous runner's job, but a name derived from the data path
// alone lets another local user pre-create that job. A private per-installation secret keeps it unguessable.
function scopeJobName(scope) {
  const file = path.join(scope, 'credentials.runner-job');
  try { fs.writeFileSync(file, randomUUID(), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const secret = fs.readFileSync(file, 'utf8');
  if (!/^[a-f0-9-]{36}$/.test(secret)) throw new Error('The runner job key is invalid. Remove credentials.runner-job and start Harness again.');
  return createHash('sha256').update(secret + '\0' + fs.realpathSync(scope).toLowerCase()).digest('hex');
}

let pending;
function containRunner(scope) {
  if (process.platform === 'linux') return require('./runner-linux.cjs').containLinux(scope);
  if (process.platform !== 'win32') return Promise.resolve({ supported: false });
  if (pending) return pending;
  const script = path.join(__dirname, 'runner-job.ps1');
  if (!fs.existsSync(script)) return Promise.reject(new Error('The runner lifetime helper is missing.'));
  const pipeName = 'phasma-harness-runner-' + randomUUID();
  const jobName = scope ? scopeJobName(scope) : createHash('sha256').update(pipeName).digest('hex');
  pending = startMonitor(script, pipeName, jobName).then(async monitor => {
    const socket = await connectMonitor(monitor, pipeName);
    monitor.stdin = socket; monitor.stdout = socket;
    socket.once('close', () => monitor.emit('close'));
    await waitForContainment(monitor);
    let installerPromise, installerFile, detached = false;
    return { supported: true, recoverySafe: !!scope, helperPid: monitor.pid, detach() {
      if (detached) return;
      detached = true; socket.destroy(); monitor.release();
    }, launchInstaller(file) {
      if (installerPromise) {
        if (file === installerFile) return installerPromise;
        return Promise.reject(Object.assign(new Error('Another installer handoff is already pending.'), { launchUncertain: true }));
      }
      installerFile = file;
      installerPromise = handoffInstaller(monitor, file).catch(error => {
        if (!error.launchUncertain) installerPromise = null;
        throw error;
      });
      return installerPromise;
    } };
  });
  return pending;
}

function startMonitor(script, pipeName, jobName) {
  const systemModules = path.join(process.env.WINDIR || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0');
  const shell = path.join(systemModules, 'powershell.exe');
  // A direct Node child belongs to libuv's kill-on-exit job; the independent monitor must outlive it.
  const starter = spawn(shell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    path.join(path.dirname(script), 'runner-job-start.ps1'), '-RunnerPid', String(process.pid), '-PipeName', pipeName, '-JobName', jobName],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PSModulePath: path.join(systemModules, 'Modules') } });
  const monitor = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, stderr: starter.stderr });
  monitor.release = () => { starter.stdout.destroy(); starter.stderr.destroy(); starter.unref(); };
  return new Promise((resolve, reject) => {
    let output = '', errors = '', settled = false;
    const fail = error => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } else monitor.failure = error; };
    const timer = setTimeout(() => fail(new Error('Runner lifetime monitor launch timed out.')), 10000);
    starter.on('error', fail);
    starter.stderr.setEncoding('utf8');
    starter.stderr.on('data', text => { errors = (errors + text).slice(-2000); });
    starter.stdout.setEncoding('utf8');
    starter.stdout.on('data', text => {
      output += text;
      const match = /^started:([1-9][0-9]*)\r?\n$/.exec(output);
      if (match && !settled) { monitor.pid = Number(match[1]); settled = true; clearTimeout(timer); resolve(monitor); }
      else if (output.length > 1000) fail(new Error('Invalid lifetime monitor launch response.'));
    });
    starter.once('exit', code => { if (code !== 0) fail(new Error('Runner lifetime monitor launch failed: ' + errors.slice(-500))); });
  });
}

async function connectMonitor(monitor, pipeName) {
  let failure, errors = '';
  monitor.on('error', error => { failure = error; });
  monitor.stderr.setEncoding('utf8');
  monitor.stderr.on('data', text => { errors = (errors + text).slice(-2000); });
  for (const end = Date.now() + 10000; Date.now() < end;) {
    if (failure || monitor.failure) throw new Error('Runner lifetime monitor could not start: ' + (failure?.message || monitor.failure?.message || errors));
    const socket = net.createConnection('\\\\.\\pipe\\' + pipeName);
    const connected = await new Promise(resolve => { socket.once('connect', () => resolve(true)); socket.once('error', () => resolve(false)); });
    if (connected) return socket;
    socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Runner lifetime monitor connection timed out; no worker was started. ' + errors.slice(-500));
}

function waitForContainment(monitor, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let buffer = '', errorText = '', acknowledged = false, settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) { monitor.stdin.end(); reject(new Error(`Runner process containment failed: ${error.message}`)); }
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('startup timed out; no worker was started')), timeoutMs);
    monitor.on('error', finish);
    monitor.stdin.on('error', finish);
    monitor.once('close', () => finish(new Error(errorText.trim().slice(0, 500) || 'the monitor exited before startup')));
    monitor.stderr.setEncoding('utf8');
    monitor.stderr.on('data', text => { errorText = (errorText + text).slice(-2000); });
    monitor.stdout.setEncoding('utf8');
    monitor.stdout.on('data', text => {
      if (settled) return;
      buffer += text;
      if (buffer.length > 4096) return finish(new Error('invalid monitor response'));
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
        if (!acknowledged && /^challenge:[a-f0-9]{32}$/.test(line)) {
          acknowledged = true; monitor.stdin.write(`ack:${line.slice(10)}\n`);
        } else if (acknowledged && line === 'ready') finish();
        else finish(new Error('invalid monitor handshake'));
        if (settled) return;
      }
    });
  });
}

function handoffInstaller(monitor, file, timeoutMs = 10000) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || !/^Phasma-Harness-Setup-.+\.exe$/i.test(path.basename(file))) return Promise.reject(new Error('Invalid installer path.'));
  return new Promise((resolve, reject) => {
    let buffer = '', settled = false;
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      monitor.stdout.off('data', onData); monitor.off('close', onClosed); monitor.off('error', onClosed); monitor.stdin.off('error', onClosed);
      if (error) reject(error); else resolve();
    };
    const onClosed = () => finish(Object.assign(new Error('Installer handoff was not confirmed. Keep the runner paused and review the update.'), { launchUncertain: true }));
    const onData = text => {
      buffer += text;
      if (buffer.length > 4096) return onClosed();
      const end = buffer.indexOf('\n');
      if (end < 0) return;
      const line = buffer.slice(0, end).trim();
      if (line === 'installer-accepted') finish();
      else if (/^installer-error:[A-Za-z0-9+/=]+$/.test(line)) finish(new Error(Buffer.from(line.slice(16), 'base64').toString('utf8')));
      else onClosed();
    };
    const timer = setTimeout(onClosed, timeoutMs);
    monitor.stdout.on('data', onData); monitor.once('close', onClosed); monitor.once('error', onClosed); monitor.stdin.once('error', onClosed);
    monitor.stdin.write(JSON.stringify({ type: 'installer', file, args: INSTALL_ARGS }) + '\n', error => { if (error) onClosed(); });
  });
}

module.exports = { containRunner, waitForContainment, handoffInstaller, scopeJobName };
