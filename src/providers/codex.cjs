const { spawn, execFile } = require('node:child_process');
const { spawnOwned, stopTree } = require('../process-tree.cjs');
const execFileAsync = require('node:util').promisify(execFile);
const { EventEmitter } = require('node:events');
const { createInterface } = require('node:readline');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function npmCodex() {
  const roots = [
    path.join(process.env.APPDATA || '', 'npm/node_modules/@openai/codex'),
    path.join(os.homedir(), '.npm-global/lib/node_modules/@openai/codex'),
    '/usr/local/lib/node_modules/@openai/codex',
  ];
  for (const root of roots) {
    const script = path.join(root, 'bin/codex.js');
    if (!fs.existsSync(script)) continue;
    if (process.platform !== 'win32') return { command: process.execPath, args: [script] };
    // The npm wrapper spawns its native child without windowsHide.
    const target = { x64: 'x86_64', arm64: 'aarch64' }[process.arch];
    if (!target) continue;
    let vendor = path.join(root, 'vendor');
    try {
      const manifest = createRequire(script).resolve(`@openai/codex-win32-${process.arch}/package.json`);
      vendor = path.join(path.dirname(manifest), 'vendor');
    } catch {}
    const command = path.join(vendor, `${target}-pc-windows-msvc`, 'bin/codex.exe');
    if (fs.existsSync(command)) return { command, args: [] };
  }
  return null;
}

function installedCodexExes() {
  if (process.platform !== 'win32') return [];
  const roots = [
    path.join(process.env.LOCALAPPDATA || '', 'OpenAI', 'Codex', 'bin'),
    path.join(os.homedir(), '.codex', 'plugins', '.plugin-appserver'),
  ];
  const exes = [];
  for (const root of roots) {
    const direct = path.join(root, 'codex.exe');
    if (fs.existsSync(direct)) exes.push(direct);
    let entries = [];
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const exe = path.join(root, entry.name, 'codex.exe');
      if (fs.existsSync(exe)) exes.push(exe);
    }
  }
  return exes;
}

function parseCodexVersion(text) {
  const match = String(text || '').match(/(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/);
  if (!match) return null;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], pre: match[4] ? match[4].split('.') : null };
}

function compareCodexVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (!a.pre && !b.pre) return 0;
  if (!a.pre) return 1;
  if (!b.pre) return -1;
  const length = Math.max(a.pre.length, b.pre.length);
  for (let i = 0; i < length; i++) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const left = /^\d+$/.test(a.pre[i]) ? Number(a.pre[i]) : a.pre[i];
    const right = /^\d+$/.test(b.pre[i]) ? Number(b.pre[i]) : b.pre[i];
    if (left === right) continue;
    if (typeof left === 'number' && typeof right === 'number') return left - right;
    return String(left) < String(right) ? -1 : 1;
  }
  return 0;
}

function formatCodexVersion(version) {
  if (!version?.core) return null;
  const label = version.core.join('.');
  return version.pre?.length ? `${label}-${version.pre.join('.')}` : label;
}

async function codexVersion(candidate) {
  const result = await execFileAsync(candidate.command, [...(candidate.args || []), '--version'], {
    windowsHide: true, encoding: 'utf8', timeout: 15000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  }).catch(error => error);
  return parseCodexVersion(`${result.stdout || ''}\n${result.stderr || ''}`);
}

let found = null;
let finding = null;
async function findCodex() {
  if (found && fs.existsSync(found.command)) return found;
  if (finding) return finding;
  finding = discoverCodex();
  try { return await finding; } finally { finding = null; }
}
async function discoverCodex() {
  const candidates = [];
  const npm = npmCodex();
  if (npm) candidates.push(npm);
  for (const command of installedCodexExes()) candidates.push({ command, args: [] });
  if (!candidates.length) {
    for (const directory of (process.env.PATH || '').split(path.delimiter)) {
      const filename = path.join(directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
      if (fs.existsSync(filename)) candidates.push({ command: filename, args: [] });
    }
  }
  if (!candidates.length && process.platform !== 'win32') {
    const shell = await execFileAsync('bash', ['-lc', 'command -v codex'], { encoding: 'utf8', timeout: 15000 }).catch(() => null);
    const filename = shell?.stdout.trim();
    if (filename && fs.existsSync(filename)) {
      // npm's shim needs `node` on PATH, which a desktop-launched app may lack; Electron runs the script as node instead.
      const real = fs.realpathSync(filename);
      candidates.push(real.endsWith('.js') ? { command: process.execPath, args: [real] } : { command: filename, args: [] });
    }
  }
  if (!candidates.length) throw Object.assign(new Error('Codex CLI is not installed. Install it from Settings → Providers.'), { code: 'ENOENT' });
  let best = candidates[0];
  const versions = await Promise.all(candidates.map(codexVersion));
  let bestVersion = versions[0];
  for (const [index, candidate] of candidates.entries()) {
    const version = versions[index];
    if (version && (!bestVersion || compareCodexVersions(version, bestVersion) > 0)) {
      best = candidate;
      bestVersion = version;
    }
  }
  best.version = bestVersion;
  return (found = best);
}

class CodexClient extends EventEmitter {
  constructor(cwd) {
    super();
    this.cwd = cwd;
    this.pending = new Map();
    this.counter = 0;
    this.process = null;
    this.stderr = '';
  }

  async start() {
    this.closed = false;
    const executable = await findCodex();
    if (this.closed) throw new Error('Codex connection closed during discovery.');
    this.version = formatCodexVersion(executable.version);
    this.process = spawnOwned(spawn, executable.command, [...executable.args, 'app-server', '--stdio'], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.cwd,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    this.process.stdin.on('error', error => this.fail(error));
    this.process.on('error', error => this.fail(error));
    this.process.on('exit', (code, signal) => this.fail(new Error(`Codex disconnected (${signal || code}). Restart the app to reconnect.`)));
    this.process.stderr.on('data', data => { this.stderr = (this.stderr + data.toString()).slice(-12000); });
    createInterface({ input: this.process.stdout }).on('line', line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.method && message.id !== undefined) this.emit('request', message);
      else if (message.method) this.emit('notification', message);
      else if (this.pending.has(message.id)) {
        const pending = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else pending.resolve(message.result);
      }
    });
    await this.call('initialize', {
      clientInfo: { name: 'phasma_harness', title: 'Phasma Harness', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    this.write({ method: 'initialized', params: {} });
  }

  write(message) {
    if (!this.process || this.process.killed || !this.process.stdin.writable) throw new Error('Codex is not connected.');
    this.process.stdin.write(JSON.stringify(message) + '\n');
  }

  call(method, params = {}, timeout = 90000) {
    const id = ++this.counter;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out. Check Codex connectivity before retrying.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.write({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  respond(id, result) { this.write({ id, result }); }
  rejectRequest(id, message) { this.write({ id, error: { code: -32601, message } }); }

  fail(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    this.emit('disconnected', error.message);
  }

  close(force = false) {
    this.closed = true;
    if (this.process && !this.process.killed) this.process.stdin.end();
    if (force) {
      this.fail(new Error('Routing connection closed.'));
      if (this.process?.pid && this.process.exitCode === null) stopTree(this.process);
    }
  }
}

module.exports = { CodexClient, findCodex, codexVersion, parseCodexVersion, compareCodexVersions };
