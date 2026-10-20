'use strict';
const fs = require('node:fs/promises');
const sync = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { PRIVATE_PATH } = require('../tasks.cjs');
const { STARTER } = require('./project-instructions.cjs');
const run = promisify(execFile);
const MAX_FILES = 50000, MAX_BYTES = 8 * 1024 ** 3;
const INSTRUCTIONS = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', 'HERMES.md', 'INSTRUCTIONS.md', '.github/copilot-instructions.md'];
const identity = filename => process.platform === 'win32' ? filename.toLowerCase() : filename;
const inside = (root, filename) => { const relative = path.relative(root, filename); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
// A project-relative path with no empty, dot or .git parts, no drive and no absolute form, resolved inside root.
function resolveInside(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.includes('\0') || relative.includes(':') ||
      path.isAbsolute(relative) || relative.split(/[\\/]/).some(part => !part || part === '.' || part === '..' || part.toLowerCase() === '.git'))
    throw new Error('Invalid project input path.');
  const filename = path.resolve(root, relative);
  if (!inside(root, filename)) throw new Error('Project input escapes its workspace.');
  return filename;
}
// Harness's own files in a copy, never applied back: the copied external wiki, and the starter entry Harness writes
// into every writable workspace.
const JOB_WIKI = '.phasma-job-wiki';
const STARTER_HASH = createHash('sha256').update(STARTER).digest('hex');
// BigInt inodes: a 64-bit NTFS file id loses its low bits as a Number, so unrelated files could compare equal.
async function sameFile(a, b) {
  const [left, right] = await Promise.all([a, b].map(file => fs.stat(file, { bigint: true })));
  return left.dev === right.dev && left.ino === right.ino;
}

class JobWorkspaces {
  constructor(agents) {
    this.agents = agents;
    this.directory = path.resolve(path.dirname(agents.primary.filename), 'jobs');
    this.legacyDirectory = path.resolve(path.dirname(agents.primary.filename), 'job-workspaces');
    this.records = agents.primary.data.jobWorkspaces ||= {};
    if (typeof this.records !== 'object' || Array.isArray(this.records)) throw new Error('Saved job workspaces need review.');
    this.inputs = new Map();
    this.operation = null;
    let interrupted = false;
    for (const record of Object.values(this.records)) if (record.state === 'preparing') {
      record.state = 'failed'; record.error = 'Workspace setup was interrupted by a restart. Start a new batch after reviewing its saved files.';
      interrupted = true;
    }
    if (interrupted) agents.primary.save();
  }

  get busy() { return !!this.operation; }

  batchDirectory(id) {
    return path.join(this.directory, createHash('sha256').update(id).digest('hex').slice(0, 16));
  }

  validateSource(source) {
    if (source.startsWith('\\\\') || inside(source, this.directory) ||
        identity(source) === identity(path.parse(source).root) || identity(source) === identity(sync.realpathSync(os.homedir())))
      throw new Error('Choose a local project folder outside Harness storage, not your home or a drive root.');
  }

  reserve(source, batch) {
    source = sync.realpathSync(source);
    if (!batch || !/^[a-f0-9-]{36}$/.test(batch.id) || !Number.isInteger(batch.index) || batch.index < 1 || batch.index > 10)
      throw new Error('Invalid batch workspace identity.');
    this.validateSource(source);
    sync.mkdirSync(this.directory, { recursive: true });
    if (identity(sync.realpathSync(this.directory)) !== identity(this.directory)) throw new Error('Job storage cannot be redirected through a link.');
    const workspace = path.join(this.batchDirectory(batch.id), String(batch.index));
    if (sync.existsSync(workspace)) throw new Error('This batch workspace already exists. Start a new batch to preserve its files.');
    sync.mkdirSync(workspace, { recursive: true });
    const parent = this.record(source);
    const record = { source, workspace, layout: 2, projectRoot: parent?.projectRoot || parent?.source || source,
      batchId: batch.id, index: batch.index, state: 'preparing', createdAt: Date.now(), ignoredFilesExcluded: true };
    this.records[workspace] = record;
    try { this.agents.primary.save(); }
    catch (error) { delete this.records[workspace]; throw error; }
    return record;
  }

  start(record) {
    if (this.operation || record.state !== 'preparing' || this.agents.closing) return;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error('Workspace setup exceeded ten minutes. Review its saved files before starting another batch.')), 10 * 60000);
    timer.unref?.();
    const operation = { record, abort };
    this.operation = operation;
    operation.promise = this.prepare(record.source, { id: record.batchId, index: record.index }, abort.signal).then(() => {
      record.state = 'ready'; delete record.error;
      this.agents.primary.save();
    }).catch(error => {
      record.state = 'failed'; record.error = String(error.message).slice(0, 1000);
      try { this.agents.primary.save(); } catch (failure) { record.error += ' Saving this failure also failed: ' + failure.message; }
    }).finally(() => {
      clearTimeout(timer);
      if (this.operation === operation) this.operation = null;
      if (!this.agents.closing) {
        this.agents.pump(); this.agents.emit('state', this.agents.snapshot());
      }
    });
  }

  cancelUnused() {
    const operation = this.operation;
    if (!operation) return;
    const needed = this.agents.pendingJobs().some(({ job }) => !job.cancelled &&
      (job.workspaceCopy?.workspace === operation.record.workspace ||
        (!this.inputs.has(operation.record.batchId) && job.workspaceCopy?.batchId === operation.record.batchId)));
    if (!needed) operation.abort.abort(new Error('Workspace setup was cancelled. Saved files were retained.'));
  }

  async close() {
    this.operation?.abort.abort(new Error('Runner stopped during workspace setup. Saved files were retained.'));
    await this.operation?.promise;
  }

  record(workspace) {
    const actual = identity(sync.realpathSync(workspace));
    const record = Object.values(this.records).find(record => record && identity(record.workspace) === identity(path.resolve(workspace)));
    if (!record) {
      if ([this.directory, this.legacyDirectory].some(directory => inside(directory, path.resolve(workspace)) || inside(directory, sync.realpathSync(workspace))))
        throw new Error('This project copy has no saved workspace registration. Review its files before starting work.');
      return null;
    }
    if (!/^[a-f0-9-]{36}$/.test(record.batchId) || !Number.isInteger(record.index) || record.index < 1 || record.index > 10 ||
        (record.layout !== undefined && record.layout !== 2)) throw new Error('The saved job workspace layout needs review.');
    const expected = record.layout === 2 ? path.join(this.batchDirectory(record.batchId), String(record.index))
      : path.join(this.legacyDirectory, record.batchId, String(record.index), 'project');
    if (identity(expected) !== actual || identity(sync.realpathSync(expected)) !== actual)
      throw new Error('The saved job workspace moved or was redirected. Review it before continuing.');
    return record;
  }

  same(first, second) {
    const a = identity(sync.realpathSync(first)), b = identity(sync.realpathSync(second));
    const left = this.record(first), right = this.record(second);
    return (left ? identity(left.projectRoot || left.source) : a) === (right ? identity(right.projectRoot || right.source) : b);
  }

  async git(cwd, args, signal) {
    const { stdout } = await run('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'pack.threads=1',
      '-c', 'core.hooksPath=' + path.join(this.directory, 'empty-hooks'), ...args], {
      cwd, signal, windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
    });
    return stdout;
  }

  async inventory(root, signal, prefix = '', result = { files: [], repositories: [], bytes: 0, gitBytes: 0 }) {
    signal?.throwIfAborted();
    root = await fs.realpath(root);
    let top;
    try { top = (await this.git(root, ['rev-parse', '--show-toplevel'], signal)).trim(); }
    catch (error) {
      if (error.code === 128 && /not a git repository/i.test(error.stderr || '')) return this.folderInventory(root, signal, prefix, result);
      throw error;
    }
    if (identity(await fs.realpath(top)) !== identity(root)) throw new Error('Batch isolation requires the repository root as its workspace.');
    const entries = (await this.git(root, ['ls-files', '--stage', '-z'], signal)).split('\0').filter(Boolean);
    const untracked = (await this.git(root, ['ls-files', '--others', '--exclude-standard', '-z'], signal)).split('\0').filter(Boolean);
    const head = (await this.git(root, ['rev-parse', 'HEAD'], signal)).trim();
    const tree = (await this.git(root, ['ls-tree', '-lr', '-z', 'HEAD'], signal)).split('\0').filter(Boolean);
    for (const entry of tree) {
      const tab = entry.indexOf('\t'), fields = entry.slice(0, tab).trim().split(/\s+/);
      if (PRIVATE_PATH.test(prefix + entry.slice(tab + 1))) throw new Error('A committed credential file prevents isolated copying.');
      if (fields[1] === 'blob') result.gitBytes += Number(fields[3]);
    }
    if (!Number.isSafeInteger(result.gitBytes) || result.gitBytes > MAX_BYTES) throw new Error('Committed Git inputs exceed 8 GiB. Narrow the repository before copying it.');
    result.repositories.push({ path: prefix, head });
    const names = new Set([...await this.nestedRepositories(root, untracked, signal, prefix, result), ...INSTRUCTIONS]);
    for (const entry of entries) {
      const tab = entry.indexOf('\t'), metadata = entry.slice(0, tab).split(' '), name = entry.slice(tab + 1);
      if (metadata[2] !== '0') throw new Error('Resolve the repository merge conflicts before starting an isolated batch.');
      if (PRIVATE_PATH.test(prefix + name)) throw new Error('A tracked credential file prevents isolated copying: ' + prefix + name);
      if (metadata[0] === '160000') {
        const directory = await this.scoped(root, name);
        await this.inventory(directory, signal, prefix + name + '/', result);
      } else names.add(name);
    }
    await this.addInputs(root, names, signal, prefix, result);
    return result;
  }

  async folderInventory(root, signal, prefix, result) {
    for (let directory = root; ; directory = path.dirname(directory)) {
      signal?.throwIfAborted();
      const metadata = await fs.lstat(path.join(directory, '.git')).catch(error => {
        if (error.code !== 'ENOENT') throw error;
        return null;
      });
      if (metadata) throw new Error('Git metadata needs repair before this project can start a batch.');
      if (path.dirname(directory) === directory) break;
    }
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-folder-inputs-'));
    try {
      await this.git(temporary, ['init', '--bare', '--quiet', '--template='], signal);
      const names = (await this.git(root, ['--git-dir=' + temporary, '--work-tree=' + root,
        'ls-files', '--others', '--exclude-standard', '-z'], signal)).split('\0').filter(Boolean);
      await this.addInputs(root, new Set([...await this.nestedRepositories(root, names, signal, prefix, result), ...INSTRUCTIONS]), signal, prefix, result);
      return result;
    } finally {
      if (identity(await fs.realpath(path.dirname(temporary))) !== identity(await fs.realpath(os.tmpdir())))
        throw new Error('Temporary input storage was redirected; cleanup needs review.');
      await fs.rm(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }

  // Git lists an untracked nested repository as "name/"; it is copied like a submodule. Returns the plain untracked names.
  async nestedRepositories(root, untracked, signal, prefix, result) {
    for (const name of untracked.filter(name => name.endsWith('/'))) {
      await this.inventory(await this.scoped(root, name.slice(0, -1)), signal, prefix + name, result);
    }
    return untracked.filter(name => !name.endsWith('/'));
  }

  async addInputs(root, names, signal, prefix, result) {
    const seen = new Map();
    for (const name of [...names].sort()) {
      signal?.throwIfAborted();
      const relative = prefix + name;
      if (PRIVATE_PATH.test(relative)) continue;
      let filename;
      try { filename = await this.scoped(root, name); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const stat = await fs.lstat(filename);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('Batch inputs must be ordinary, unlinked files: ' + relative);
      // A case-insensitive disk resolves AGENTS.md and a tracked Agents.md to one file, which must be copied once.
      const folded = name.toLowerCase(), earlier = seen.get(folded);
      if (earlier && await sameFile(earlier, filename)) continue;
      seen.set(folded, filename);
      result.bytes += stat.size;
      if (result.bytes > MAX_BYTES || result.files.length >= MAX_FILES) throw new Error('Batch input exceeds 50,000 files or 8 GiB. Narrow the project inputs before continuing.');
      result.files.push({ path: relative, size: stat.size, mode: stat.mode & 0o777, hash: await this.hash(filename, signal) });
    }
  }

  async scoped(root, relative) {
    const filename = resolveInside(root, relative);
    let current = root;
    for (const part of relative.split(/[\\/]/)) {
      current = path.join(current, part);
      if ((await fs.lstat(current)).isSymbolicLink()) throw new Error('Batch inputs cannot follow a link: ' + relative);
    }
    return filename;
  }

  async hash(filename, signal) {
    const hash = createHash('sha256');
    for await (const chunk of sync.createReadStream(filename, { signal })) hash.update(chunk);
    return hash.digest('hex');
  }

  async wiki(source, signal) {
    const configured = this.agents.primary.wikiStore?.location(source).root;
    const root = [configured, path.join(source, 'docs', 'wiki')].find(folder => folder && sync.existsSync(path.join(folder, 'index.md')));
    if (!root) return null;
    const actual = await fs.realpath(root), relative = path.relative(source, actual);
    const target = inside(source, actual) && relative ? relative : '.phasma-job-wiki';
    if (target === '.phasma-job-wiki' && sync.existsSync(path.join(source, target))) throw new Error('The reserved job wiki folder already exists in the source project.');
    const result = { source: actual, target, files: [], bytes: 0 };
    const visit = async (directory, prefix = '') => {
      for (const name of (await fs.readdir(directory)).sort()) {
        signal?.throwIfAborted();
        const relative = prefix + name;
        if (name.toLowerCase() === '.git' || PRIVATE_PATH.test(relative)) continue;
        const filename = await this.scoped(actual, relative), stat = await fs.lstat(filename);
        if (stat.isDirectory()) { await visit(filename, relative + '/'); continue; }
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('Wiki inputs must be ordinary, unlinked files: ' + relative);
        result.bytes += stat.size;
        if (result.files.length >= MAX_FILES || result.bytes > MAX_BYTES) throw new Error('The active wiki exceeds the batch input limit.');
        result.files.push({ path: relative, size: stat.size, mode: stat.mode & 0o777, hash: await this.hash(filename, signal) });
      }
    };
    await visit(actual);
    return result;
  }

  async copyWiki(source, destination, wiki, signal) {
    for (const file of wiki.files) {
      signal?.throwIfAborted();
      const input = await this.scoped(source, file.path), output = path.join(destination, file.path);
      await fs.mkdir(path.dirname(output), { recursive: true });
      if (!sync.existsSync(output)) {
        await fs.copyFile(input, output, sync.constants.COPYFILE_EXCL | sync.constants.COPYFILE_FICLONE);
        await fs.chmod(output, file.mode);
      }
      if (await this.hash(output, signal) !== file.hash) throw new Error('The active wiki changed during workspace setup: ' + file.path);
    }
  }

  async clone(source, destination, signal) {
    await fs.mkdir(path.dirname(destination), { recursive: true });
    // shortcut: keep only HEAD; include requested local refs when batches need historical or branch comparisons.
    await this.git(path.dirname(destination), ['clone', '--no-local', '--no-hardlinks', '--depth', '1',
      '--no-checkout', '--template=', '--', source, destination], signal);
    await this.git(destination, ['remote', 'remove', 'origin'], signal);
    await this.git(destination, ['reset', '--mixed', 'HEAD'], signal);
    await fs.mkdir(path.join(destination, '.git', 'hooks-disabled'));
    await this.git(destination, ['config', '--local', 'core.hooksPath', '.git/hooks-disabled'], signal);
    await this.git(destination, ['config', '--local', 'core.fsmonitor', 'false'], signal);
  }

  async copy(source, destination, manifest, signal, wikiBytes = 0) {
    signal?.throwIfAborted();
    const disk = await fs.statfs(this.directory);
    if (disk.bavail * disk.bsize < manifest.bytes + manifest.gitBytes + wikiBytes + 64 * 1024 ** 2) throw new Error('Not enough free space for an independent job workspace. No worker was started.');
    await fs.mkdir(destination, { recursive: true });
    for (const repository of manifest.repositories) {
      const relative = repository.path.replace(/\/$/, '');
      await this.clone(path.join(source, relative), path.join(destination, relative), signal);
      const head = (await this.git(path.join(destination, relative), ['rev-parse', 'HEAD'], signal)).trim();
      if (head !== repository.head) throw new Error('The source revision changed during workspace setup. Start a new batch.');
    }
    for (const file of manifest.files) {
      signal?.throwIfAborted();
      const input = await this.scoped(source, file.path), output = path.join(destination, file.path);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(input, output, sync.constants.COPYFILE_EXCL | sync.constants.COPYFILE_FICLONE);
      await fs.chmod(output, file.mode);
      if (await this.hash(output, signal) !== file.hash) throw new Error('Project input changed during workspace setup: ' + file.path);
    }
  }

  async prepare(source, batch, signal) {
    if (!batch || !/^[a-f0-9-]{36}$/.test(batch.id) || !Number.isInteger(batch.index) || batch.index < 1 || batch.index > 10)
      throw new Error('Invalid batch workspace identity.');
    signal?.throwIfAborted();
    source = await fs.realpath(source);
    this.validateSource(source);
    await fs.mkdir(path.join(this.directory, 'empty-hooks'), { recursive: true });
    if (identity(await fs.realpath(this.directory)) !== identity(this.directory)) throw new Error('Job storage cannot be redirected through a link.');
    let input = this.inputs.get(batch.id);
    if (!input) {
      const manifest = await this.inventory(source, signal);
      const wiki = await this.wiki(source, signal);
      if (manifest.bytes + (wiki?.bytes || 0) > MAX_BYTES || manifest.files.length + (wiki?.files.length || 0) > MAX_FILES)
        throw new Error('Project and wiki inputs exceed the batch input limit.');
      const destination = path.join(this.batchDirectory(batch.id), 'input');
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const manifestFile = path.join(path.dirname(destination), 'input.json');
      await fs.writeFile(manifestFile, JSON.stringify({ source, ...manifest, wiki }), { flag: 'wx' });
      try {
        await this.copy(source, destination, manifest, signal, wiki?.bytes || 0);
        if (wiki) await this.copyWiki(wiki.source, path.join(destination, wiki.target), wiki, signal);
        const after = await this.inventory(source, signal);
        if (JSON.stringify(after) !== JSON.stringify(manifest)) throw new Error('Project inputs changed during workspace setup. Start a new batch.');
        if (JSON.stringify(await this.wiki(source, signal)) !== JSON.stringify(wiki)) throw new Error('The active wiki changed during workspace setup. Start a new batch.');
      } catch (error) {
        // An unrecorded half-written input would make every sibling job fail with EEXIST.
        await fs.rm(destination, { recursive: true, force: true });
        await fs.rm(manifestFile, { force: true });
        throw error;
      }
      input = { source, workspace: destination, manifest, wiki };
      this.inputs.set(batch.id, input);
    }
    if (identity(input.source) !== identity(source)) throw new Error('A batch cannot switch its original workspace.');
    const workspace = path.join(this.batchDirectory(batch.id), String(batch.index));
    signal?.throwIfAborted();
    const needed = this.agents.pendingJobs?.().some(({ job }) => !job.cancelled && job.workspaceCopy?.workspace === workspace);
    if (needed === false) throw new Error('Workspace setup was cancelled for this job. Saved input files were retained.');
    await this.copy(input.workspace, workspace, input.manifest, signal, input.wiki?.bytes || 0);
    if (input.wiki) {
      const wiki = path.join(workspace, input.wiki.target);
      await this.copyWiki(path.join(input.workspace, input.wiki.target), wiki, input.wiki, signal);
      this.agents.primary.wikiStore?.setLocation(workspace, wiki);
      if (input.wiki.target === '.phasma-job-wiki' && input.manifest.repositories.length) {
        await fs.mkdir(path.join(workspace, '.git', 'info'), { recursive: true });
        await fs.appendFile(path.join(workspace, '.git', 'info', 'exclude'), '\n/.phasma-job-wiki/\n');
      }
    }
    const parent = this.record(source);
    const record = { source, workspace, layout: 2, projectRoot: parent?.projectRoot || parent?.source || source,
      batchId: batch.id, index: batch.index, head: input.manifest.repositories[0]?.head || null,
      inputFiles: input.manifest.files.length, inputBytes: input.manifest.bytes, createdAt: Date.now(), ignoredFilesExcluded: true };
    const current = this.records[workspace];
    this.records[workspace] = current ? Object.assign(current, record) : record;
    try { this.agents.primary.save(); }
    catch (error) { delete this.records[workspace]; throw error; }
    return record;
  }

  // A bot still working in the copy (an undelivered job there, or a chat turn running in it) could change it mid-apply.
  inUse(workspace) {
    const same = folder => !!folder && identity(path.resolve(folder)) === identity(workspace);
    const jobs = this.agents.pendingJobs?.() || [];
    const controllers = [...(this.agents.allControllers?.() || [])];
    return jobs.some(({ job }) => same(job.workspaceCopy?.workspace) || same(job.projectScope)) ||
      controllers.some(controller => controller.busy && same(controller.data.sessions.find(session => session.id === controller.busy)?.workspace));
  }

  // Apply, step 1: what a ready copy changed against its batch snapshot (input.json), and which of those files the
  // project it came from has changed since. Ignored files and Harness's own files are left out.
  async changes(workspace) {
    const record = this.record(workspace);
    if (!record) throw new Error('This folder is not a project copy.');
    if (record.state !== undefined && record.state !== 'ready') throw new Error('This project copy is not ready.');
    if (this.inUse(record.workspace)) throw new Error('A bot is still working in this project copy. Apply its changes once it has finished.');

    const snapshot = path.join(this.batchDirectory(record.batchId), 'input');
    const input = JSON.parse(await fs.readFile(path.join(this.batchDirectory(record.batchId), 'input.json'), 'utf8'));
    const source = await fs.realpath(input.source);
    if (identity(source) !== identity(record.source)) throw new Error('This project copy and its snapshot name different projects.');

    let current;
    try { current = await this.inventory(record.workspace); }
    catch (error) { throw new Error(`Apply needs ordinary files in the project copy. ${error.message}`); }

    const skipped = file => file.split('/')[0] === JOB_WIKI || (file === 'INSTRUCTIONS.md' && !!record.comparisonId);
    const before = new Map(input.files.map(file => [file.path, file]));
    const after = new Map(current.files.map(file => [file.path, file]));
    const changes = [];
    for (const [file, entry] of after) {
      const base = before.get(file);
      const starter = !base && file === 'INSTRUCTIONS.md' && entry.hash === STARTER_HASH;
      if (!skipped(file) && !starter && base?.hash !== entry.hash)
        changes.push({ path: file, kind: base ? 'modified' : 'added', base: base?.hash || null, copy: entry.hash, mode: entry.mode });
    }
    for (const [file, base] of before) {
      // A file the copy now ignores is still there; only a missing one was deleted.
      if (!after.has(file) && !skipped(file) && !await this.present(path.join(record.workspace, file)))
        changes.push({ path: file, kind: 'deleted', base: base.hash, copy: null });
    }

    const conflicts = [], pending = [];
    for (const change of changes) {
      const now = await this.fileHash(await this.target(source, change.path));
      if (now === change.copy)
        continue;

      if (now === change.base)
        pending.push(change);
      else
        conflicts.push(change.path);
    }
    return { workspace: record.workspace, source, snapshot, changes: pending.sort((a, b) => a.path.localeCompare(b.path)), conflicts: conflicts.sort() };
  }

  // Apply, step 2: writes exactly the previewed changes, or nothing if the copy or the project moved on since. Each
  // file is checked again just before its own write; deletions go first, since a case-only rename is one file on Windows.
  async apply(workspace, preview) {
    const fresh = await this.changes(workspace);
    const key = list => JSON.stringify(list.map(change => [change.path, change.kind, change.base, change.copy]));
    if (fresh.conflicts.length || key(fresh.changes) !== key(preview.changes))
      throw new Error('The project copy or your project changed since the preview. Nothing was applied; open Apply again to review it.');

    const applied = [];
    const order = [...fresh.changes].sort((a, b) => (b.kind === 'deleted') - (a.kind === 'deleted'));
    for (const change of order) {
      const target = await this.target(fresh.source, change.path);
      const from = path.join(fresh.workspace, change.path);
      if (await this.fileHash(target) !== change.base || (change.copy && await this.fileHash(from) !== change.copy))
        throw new Error(`${change.path} changed while applying. Applied before it: ${applied.join(', ') || 'nothing'}.`);

      if (change.kind === 'deleted') {
        await fs.rm(target);
      } else {
        await fs.mkdir(path.dirname(target), { recursive: true });
        const temporary = `${target}.harness-apply-${process.pid}`;
        try {
          await fs.copyFile(from, temporary);
          await fs.chmod(temporary, change.mode);
          await fs.rename(temporary, target);
        } catch (error) {
          await fs.rm(temporary, { force: true });
          throw new Error(`${change.path} could not be written (${error.message}). Applied before it: ${applied.join(', ') || 'nothing'}.`);
        }
      }
      applied.push(change.path);
    }
    return { source: fresh.source, applied };
  }

  // Like scoped(), but trailing folders may not exist yet; an existing link on the way is refused.
  async target(root, relative) {
    const filename = resolveInside(root, relative);
    let current = root;
    for (const part of relative.split(/[\\/]/)) {
      current = path.join(current, part);
      const stat = await fs.lstat(current).catch(error => {
        if (error.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) break;
      if (stat.isSymbolicLink()) throw new Error('Apply cannot write through a link: ' + relative);
    }
    return filename;
  }

  async present(filename) {
    return !!await fs.lstat(filename).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
  }

  // A file's content hash, null when it is missing, or a marker no hash equals when it is not an ordinary file.
  async fileHash(filename) {
    const stat = await fs.lstat(filename).catch(error => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat) return null;
    return stat.isFile() ? this.hash(filename) : 'not-a-file';
  }
}

const summary = copy => copy ? '\n\nProject copy: ' + copy.workspace + '\nSource project: ' + copy.source + '\nChanges remain in the copy; no automatic merge.' : '';
module.exports = { JobWorkspaces, summary };
