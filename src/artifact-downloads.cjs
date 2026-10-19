'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Zip, ZipPassThrough } = require('fflate');
const { Readable } = require('node:stream');
const { EventEmitter } = require('node:events');
const { scoped, samePath, MAX_BYTES } = require('./artifacts.cjs');

const OWNER = '{"kind":"phasma-artifact-download","version":1}';
const MAX_ENTRIES = 10000;
const changed = () => new Error('The artifact changed while preparing its download. Publish it again.');
const stable = (a, b) => a.ino === b.ino && a.dev === b.dev && a.size === b.size &&
  a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs && a.mode === b.mode && !b.isSymbolicLink();

async function removeSnapshot(directory, root) {
  if (!samePath(path.dirname(directory), root) || !/^download-[a-f0-9-]{36}$/.test(path.basename(directory)))
    throw new Error('Unrecognized temporary download.');
  const stat = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await fs.realpath(directory), directory))
    throw new Error('The temporary download directory changed.');
  const names = await fs.readdir(directory);
  if (!names.length) { await fs.rmdir(directory); return; }
  if (names.some(name => !['owner.json', 'payload'].includes(name)) ||
      await fs.readFile(path.join(directory, 'owner.json'), 'utf8') !== OWNER)
    throw new Error('Unrecognized temporary download contents.');
  await fs.rm(path.join(directory, 'payload'), { force: true });
  await fs.unlink(path.join(directory, 'owner.json'));
  await fs.rmdir(directory);
}

async function inventory(record, check) {
  const initial = await scoped(record.workspace, record.path);
  if (!samePath(initial.root, record.workspace)) throw changed();
  const entries = [], directories = [], queue = [initial];
  let bytes = 0;
  while (queue.length) {
    check();
    const item = queue.pop();
    if (entries.length + directories.length >= MAX_ENTRIES) throw new Error('Download at most 10,000 artifact entries at once.');
    const relative = path.relative(initial.filename, item.filename).split(path.sep).join('/');
    if (/[\\:\x00-\x1f]/.test(relative)) throw new Error('The artifact has a nonportable archive path.');
    if (item.stat.isDirectory()) {
      directories.push(item);
      const children = await fs.readdir(item.filename);
      for (const name of children.sort().reverse()) {
        check();
        if (entries.length + directories.length + queue.length >= MAX_ENTRIES)
          throw new Error('Download at most 10,000 artifact entries at once.');
        queue.push(await scoped(record.workspace, path.relative(initial.root, path.join(item.filename, name))));
      }
    } else {
      bytes += Number(item.stat.size);
      if (bytes > MAX_BYTES) throw new Error('Download artifact snapshots under 512 MB. Publish a smaller export or archive.');
      entries.push({ ...item, archivePath: relative });
    }
  }
  return { initial, entries, directories, bytes };
}

async function copyEntry(item, consume, check) {
  const input = await fs.open(item.filename, 'r');
  try {
    const before = await input.stat({ bigint: true });
    if (!before.isFile() || before.nlink > 1n || !stable(item.stat, before)) throw changed();
    const buffer = Buffer.alloc(65536), hash = createHash('sha256');
    let offset = 0;
    while (offset < Number(before.size)) {
      check();
      const { bytesRead } = await input.read(buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset);
      if (!bytesRead) throw changed();
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk); await consume(chunk); offset += bytesRead;
    }
    if (!stable(before, await input.stat({ bigint: true })) || !stable(before, await fs.lstat(item.filename, { bigint: true })))
      throw changed();
    return hash.digest('hex');
  } finally { await input.close(); }
}

async function archive(tree, consume, check) {
  let pending = Promise.resolve(), error;
  const zip = new Zip((failure, chunk) => {
    if (failure) error = failure;
    else pending = pending.then(() => consume(chunk));
  });
  for (const directory of tree.directories) {
    const name = path.relative(tree.initial.filename, directory.filename).split(path.sep).join('/');
    if (!name) continue;
    // Windows reports folders without execute bits; unzipped on Linux or macOS such a folder cannot be opened.
    const mode = Number(directory.stat.mode), searchable = mode | ((mode & 0o444) >> 2);
    const entry = new ZipPassThrough(name + '/'); entry.os = 3; entry.attrs = (searchable << 16) >>> 0;
    zip.add(entry); entry.push(new Uint8Array(), true); await pending;
  }
  for (const file of tree.entries) {
    check();
    const entry = new ZipPassThrough(file.archivePath); entry.os = 3; entry.attrs = (Number(file.stat.mode) << 16) >>> 0;
    zip.add(entry); await pending;
    await copyEntry(file, async chunk => { entry.push(chunk, false); await pending; if (error) throw error; }, check);
    entry.push(new Uint8Array(), true); await pending;
    if (error) throw error;
  }
  for (const item of [...tree.directories, ...tree.entries]) {
    check();
    if (!stable(item.stat, await fs.lstat(item.filename, { bigint: true }))) throw changed();
  }
  zip.end(); await pending;
  if (error) throw error;
}

class ArtifactDownloads extends EventEmitter {
  constructor(directory) { super(); this.directory = path.resolve(directory); this.active = new Set(); this.blocked = new Set(); this.closing = false; }
  get busy() { return this.active.size > 0 || this.blocked.size > 0 || !!this.recoveryError; }
  get error() { return this.recoveryError?.message || (this.blocked.size ? 'Download cleanup is unconfirmed. Review the runner cache.' : null); }
  snapshot() { return { active: this.active.size, error: this.error }; }

  recover() {
    if (!this.recovering) {
      this.recoveryError = null;
      this.recovering = this.recoverSnapshots().catch(error => { this.recoveryError = error; })
        .finally(() => { this.recovering = null; this.emit('state'); });
    }
    return this.recovering;
  }

  async recoverSnapshots() {
    const root = await fs.realpath(this.directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
    if (!root) {
      for (const directory of this.blocked) {
        const stat = await fs.lstat(directory).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (!stat) this.blocked.delete(directory);
      }
      return;
    }
    const stat = await fs.lstat(this.directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Use an ordinary local download cache.');
    const candidates = new Set([...this.blocked, ...(await fs.readdir(root))
      .filter(name => /^download-[a-f0-9-]{36}$/.test(name)).map(name => path.join(root, name))]);
    for (const directory of candidates) {
      if ([...this.active].some(job => job.directory === directory)) continue;
      try { await removeSnapshot(directory, root); this.blocked.delete(directory); }
      catch { this.blocked.add(directory); }
    }
  }

  async prepare(record, signal) {
    if (this.closing) throw new Error('The runner is stopping.');
    if (this.blocked.size || this.recoveryError) await this.recover();
    if (this.closing) throw new Error('The runner is stopping.');
    if (this.error) throw new Error(this.error);
    if (this.active.size >= 2) throw new Error('Wait for one of the two current downloads to finish.');
    const job = { abort: new AbortController(), ready: false };
    job.done = new Promise(resolve => { job.resolve = resolve; });
    const abort = () => job.abort.abort(); signal?.addEventListener('abort', abort, { once: true });
    job.detach = () => signal?.removeEventListener('abort', abort);
    if (signal?.aborted) abort();
    const deadline = Date.now() + 30000;
    const check = () => {
      if (job.abort.signal.aborted || this.closing) throw new Error('Download cancelled.');
      if (Date.now() >= deadline) throw new Error('Preparing the download timed out. Publish a smaller export.');
    };
    this.active.add(job);
    try {
      this.emit('state');
      const tree = await inventory(record, check);
      if ((record.kind === 'folder') !== tree.initial.stat.isDirectory()) throw changed();
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const root = await fs.realpath(this.directory);
      if ((await fs.lstat(this.directory)).isSymbolicLink() || root.startsWith('\\\\')) throw new Error('Use an ordinary local download cache.');
      const space = await fs.statfs(root, { bigint: true });
      const expected = record.kind === 'folder' ? Math.min(MAX_BYTES, tree.bytes + 64 * 1024 * 1024) : tree.bytes;
      const reserved = [...this.active].filter(other => other !== job).reduce((sum, other) => sum + (other.expected || 0), 0);
      if (space.bavail * space.bsize < BigInt(expected + reserved) + 64n * 1024n * 1024n)
        throw new Error('Not enough free space to prepare this download alongside current transfers.');
      job.expected = expected;
      job.root = root; job.directory = path.join(root, 'download-' + randomUUID());
      await fs.mkdir(job.directory, { mode: 0o700 });
      await fs.writeFile(path.join(job.directory, 'owner.json'), OWNER, { flag: 'wx', mode: 0o600 });
      job.handle = await fs.open(path.join(job.directory, 'payload'), 'wx+', 0o600);
      let size = 0; const hash = createHash('sha256');
      const consume = async chunk => {
        check(); size += chunk.length;
        if (size > MAX_BYTES) throw new Error('Download artifact snapshots under 512 MB.');
        hash.update(chunk); await job.handle.writeFile(chunk);
      };
      if (record.kind === 'folder') await archive(tree, consume, check);
      else {
        const digest = await copyEntry(tree.entries[0], consume, check);
        if (digest !== record.sha256 || size !== record.size) throw changed();
      }
      check(); job.ready = true;
      const base = path.basename(record.path === '.' ? record.workspace : record.path);
      return { size, sha256: hash.digest('hex'), filename: base + (record.kind === 'folder' ? '.zip' : ''),
        get closed() { return !!job.finishing; },
        stream: () => {
          if (job.finishing || job.stream) throw new Error('This download is already closed or in use.');
          job.stream = size ? job.handle.createReadStream({ start: 0, end: size - 1, autoClose: false }) : Readable.from([]);
          return job.stream;
        }, close: () => this.finish(job) };
    } catch (error) { await this.finish(job); throw error; }
  }

  finish(job) {
    if (job.finishing) return job.finishing;
    job.finishing = (async () => {
      try {
        job.stream?.destroy(); await job.handle?.close();
        if (job.directory) await removeSnapshot(job.directory, job.root);
      } catch (error) { if (job.directory) this.blocked.add(job.directory); throw error; }
      finally { job.detach(); this.active.delete(job); job.resolve(); this.emit('state'); }
    })();
    return job.finishing;
  }

  async cancel() {
    const jobs = [...this.active];
    for (const job of jobs) job.abort.abort();
    await Promise.allSettled(jobs.map(job => job.ready ? this.finish(job) : job.done));
    if (this.blocked.size || this.recoveryError) await this.recover();
    if (this.error) throw new Error(this.error);
  }

  async close() { this.closing = true; await this.cancel(); }
}

module.exports = { ArtifactDownloads };
