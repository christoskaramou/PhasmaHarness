const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { spawnOwned, stopTree } = require('./process-tree.cjs');
const { PRIVATE_PATH: PRIVATE } = require('./tasks.cjs');

const MAX_BYTES = 512 * 1024 * 1024;
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

async function scoped(workspace, relative) {
  if (typeof relative !== 'string' || !relative || relative.length > 1000 || /[:\x00-\x1f]/.test(relative) ||
      path.isAbsolute(relative) || relative.startsWith('\\')) throw new Error('Choose a relative workspace artifact path.');
  const root = await fs.realpath(workspace);
  if (root.startsWith('\\\\')) throw new Error('Artifact actions require a local workspace.');
  const filename = path.resolve(root, relative), actual = await fs.realpath(filename);
  const name = path.relative(root, actual);
  if (name === '..' || name.startsWith('..' + path.sep) || path.isAbsolute(name) || PRIVATE.test(name))
    throw new Error('Artifact is outside the workspace or is a private credential file.');
  const stat = await fs.lstat(filename, { bigint: true });
  if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink > 1n))
    throw new Error('Publish a regular file or folder, without links.');
  return { root, filename: actual, relativePath: name || '.', stat };
}

function executable(header, stat, filename, platform = process.platform) {
  if (platform === 'win32') {
    if (!/\.exe$/i.test(filename) || header.length < 64 || header.toString('ascii', 0, 2) !== 'MZ') return false;
    const offset = header.readUInt32LE(60);
    if (offset < 64 || offset + 24 > header.length || header.toString('binary', offset, offset + 4) !== 'PE\0\0') return false;
    const flags = header.readUInt16LE(offset + 22);
    return !!(flags & 2) && !(flags & 0x2000);
  }
  if ((Number(stat.mode) & 0o111) === 0 || header.length < 20) return false;
  if (platform === 'linux' && header.subarray(0, 4).equals(Buffer.from([0x7f, 69, 76, 70]))) {
    const type = header[5] === 2 ? header.readUInt16BE(16) : header.readUInt16LE(16);
    return [2, 3].includes(type) && !/\.so(?:\.|$)/.test(filename);
  }
  if (platform === 'darwin') return header.readUInt32LE(0) === 0xfeedfacf && header.readUInt32LE(12) === 2;
  return false;
}

async function inspect(workspace, relative, label) {
  const resolved = await scoped(workspace, relative);
  const record = { workspace: resolved.root, path: resolved.relativePath,
    label: label || path.basename(resolved.filename), kind: 'folder', size: null, sha256: null };
  if (resolved.stat.isDirectory()) return record;
  if (resolved.stat.size > BigInt(MAX_BYTES)) throw new Error('Publish artifact files under 512 MB, or publish their containing folder.');
  const handle = await fs.open(resolved.filename, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.ino !== resolved.stat.ino || before.dev !== resolved.stat.dev || before.nlink > 1n || before.size > BigInt(MAX_BYTES))
      throw new Error('The artifact changed while opening it. Publish it again.');
    const hash = createHash('sha256');
    const header = Buffer.alloc(Number(before.size < 65536n ? before.size : 65536n));
    await handle.read(header, 0, header.length, 0);
    const buffer = Buffer.alloc(64 * 1024);
    let position = 0;
    while (position < Number(before.size)) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, Number(before.size) - position), position);
      if (!bytesRead) throw new Error('The artifact changed while reading it. Publish it again.');
      hash.update(buffer.subarray(0, bytesRead)); position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const current = await fs.lstat(resolved.filename, { bigint: true });
    if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs ||
        current.ino !== before.ino || current.dev !== before.dev || current.isSymbolicLink())
      throw new Error('The artifact changed while reading it. Publish it again.');
    return { ...record, kind: executable(header, before, resolved.filename) ? 'program' : 'file',
      size: Number(before.size), sha256: hash.digest('hex') };
  } finally { await handle.close(); }
}

async function verify(record, folder = false) {
  if (!record || typeof record.workspace !== 'string' || typeof record.path !== 'string') throw new Error('Unknown artifact.');
  const root = await fs.realpath(record.workspace);
  if (!samePath(root, record.workspace)) throw new Error('The artifact workspace moved. Publish it again.');
  if (folder) {
    const directory = await scoped(root, record.kind === 'folder' ? record.path : path.dirname(record.path));
    if (!directory.stat.isDirectory()) throw new Error('The artifact folder changed. Publish it again.');
    return directory.filename;
  }
  const current = await inspect(root, record.path, record.label);
  if (current.kind !== 'program' || record.kind !== 'program' || current.sha256 !== record.sha256 || current.size !== record.size)
    throw new Error('The executable changed or is unavailable. Publish the current artifact before running it.');
  return path.resolve(root, record.path);
}

function gameEnvironment() {
  const allowed = new Set(['systemroot', 'windir', 'temp', 'tmp', 'path', 'userprofile', 'home', 'appdata',
    'localappdata', 'programdata', 'programfiles', 'programfiles(x86)', 'comspec', 'pathext',
    'processor_architecture', 'number_of_processors', 'lang', 'lc_all', 'display', 'wayland_display', 'xdg_runtime_dir']);
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.has(key.toLowerCase())));
}

class ArtifactRuns extends EventEmitter {
  constructor(launch = spawn, stop = stopTree) {
    super(); this.launch = launch; this.stopTree = stop; this.runs = new Map(); this.closing = false;
  }
  get busy() { return this.runs.size > 0; }
  snapshot() {
    return [...this.runs.values()].map(({ child, stopping, error, ...run }) => ({ ...run,
      status: error ? 'cleanup-blocked' : stopping ? 'stopping' : 'running', error: error || null }));
  }
  async play(record, filename) {
    if (this.closing) throw new Error('The runner is stopping.');
    if ([...this.runs.values()].some(run => run.filename === filename)) throw new Error('This artifact is already running.');
    const run = { id: randomUUID(), filename, label: record.label, workspace: record.workspace, path: record.path };
    const child = spawnOwned(this.launch, filename, [], {
      cwd: path.dirname(filename), env: gameEnvironment(), shell: false, windowsHide: false,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    run.child = child; this.runs.set(run.id, run);
    child.once('close', () => { this.stop(run.id).catch(() => {}); });
    try {
      await new Promise((resolve, reject) => {
        child.once('spawn', resolve); child.once('error', reject);
      });
      if (this.closing || !this.runs.has(run.id)) throw new Error('The runner stopped this launch.');
    } catch (error) {
      await this.stop(run.id).catch(() => {});
      throw new Error('The artifact could not start. Review its build output and runtime dependencies.');
    }
    this.emit('state');
    return { id: run.id, status: 'started', note: 'Process started; this does not verify gameplay or rendering.' };
  }
  async stop(id) {
    const run = this.runs.get(id);
    if (!run) return { status: 'stopped' };
    if (run.stopping) return run.stopping;
    run.error = null;
    run.stopping = Promise.resolve().then(async () => {
      const remaining = await this.stopTree(run.child);
      if (remaining.length) throw new Error('Artifact process cleanup is unconfirmed. Retry Stop before updating or quitting.');
      this.runs.delete(id); this.emit('state'); return { status: 'stopped' };
    }).catch(error => {
      run.error = error.message; run.stopping = null; this.emit('state'); throw error;
    });
    this.emit('state');
    return run.stopping;
  }
  async shutdown() {
    this.closing = true;
    await Promise.allSettled([...this.runs.keys()].map(id => this.stop(id)));
  }
}

function summary(records) {
  if (!records?.length) return '';
  return '\nPublished artifacts (file availability only; publication does not verify build, launch or gameplay):\n' +
    JSON.stringify(records.map(({ id, workspace, path, kind, size, sha256, version, revision }) =>
      ({ id, workspace, path, kind, size, sha256, version, revision })));
}

module.exports = { inspect, verify, scoped, samePath, executable, ArtifactRuns, MAX_BYTES, summary, gameEnvironment };
