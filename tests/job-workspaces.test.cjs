const { readSessionData } = require('../src/session-store.cjs');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { JobWorkspaces } = require('../src/workspace/job-workspaces.cjs');
const { STARTER } = require('../src/workspace/project-instructions.cjs');

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'user.name=Harness fixture',
    '-c', 'user.email=fixture@invalid', ...args], { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function fixture(t, { repository = true } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-job-workspaces-'));
  const source = path.join(directory, 'source'), data = path.join(directory, 'data');
  fs.mkdirSync(source); fs.mkdirSync(data);
  if (repository) git(source, 'init', '-q');
  fs.writeFileSync(path.join(source, 'source.txt'), 'committed source');
  fs.writeFileSync(path.join(source, '.gitignore'), 'build/\n.env\nAGENTS.md\n');
  if (repository) { git(source, 'add', '.'); git(source, 'commit', '-qm', 'Fixture baseline'); }
  const primary = { filename: path.join(data, 'sessions.json'), data: {}, save() { fs.writeFileSync(this.filename, JSON.stringify(this.data)); } };
  const agents = { primary }, workspaces = new JobWorkspaces(agents);
  t.after(() => {
    assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { directory, source, primary, agents, workspaces };
}

test('plain project folders retain one independent frozen batch input, ignore rules, instructions and the active wiki without creating Git metadata', async t => {
  const { directory, source, primary, workspaces } = fixture(t, { repository: false });
  fs.writeFileSync(path.join(source, 'AGENTS.md'), 'Keep these ignored project instructions.');
  fs.writeFileSync(path.join(source, 'new.txt'), 'Fresh project input');
  fs.writeFileSync(path.join(source, 'credentials.json'), 'FIXTURE_ONLY_PRIVATE');
  fs.mkdirSync(path.join(source, 'build')); fs.writeFileSync(path.join(source, 'build/old.exe'), 'Ignored output');
  const wiki = path.join(directory, 'wiki'); fs.mkdirSync(wiki);
  fs.writeFileSync(path.join(wiki, 'index.md'), 'Project decisions.');
  const locations = [];
  primary.wikiStore = { location: () => ({ root: wiki }), setLocation: (...args) => locations.push(args) };
  const id = randomUUID();
  const first = await workspaces.prepare(source, { id, index: 1 });
  assert.equal(first.head, null);
  assert.equal(fs.existsSync(path.join(first.workspace, '.git')), false);
  assert.equal(fs.existsSync(path.join(source, '.git')), false);
  assert.equal(fs.existsSync(path.join(first.workspace, 'credentials.json')), false);
  assert.equal(fs.existsSync(path.join(first.workspace, 'build')), false);
  assert.equal(fs.readFileSync(path.join(first.workspace, 'AGENTS.md'), 'utf8'), 'Keep these ignored project instructions.');
  assert.equal(fs.readFileSync(path.join(first.workspace, '.phasma-job-wiki/index.md'), 'utf8'), 'Project decisions.');
  fs.writeFileSync(path.join(source, 'new.txt'), 'Changed after the batch snapshot');
  fs.writeFileSync(path.join(first.workspace, 'source.txt'), 'First bot edits');
  const second = await workspaces.prepare(source, { id, index: 2 });
  assert.equal(fs.readFileSync(path.join(second.workspace, 'new.txt'), 'utf8'), 'Fresh project input');
  assert.equal(fs.readFileSync(path.join(second.workspace, 'source.txt'), 'utf8'), 'committed source');
  assert.equal(fs.readFileSync(path.join(source, 'source.txt'), 'utf8'), 'committed source');
  assert.equal(workspaces.same(source, second.workspace), true);
  assert.equal(locations.length, 2);
});

test('empty plain folders produce usable isolated workspaces; home and drive roots are refused', async t => {
  const { source, workspaces } = fixture(t, { repository: false });
  fs.unlinkSync(path.join(source, 'source.txt')); fs.unlinkSync(path.join(source, '.gitignore'));
  const copy = await workspaces.prepare(source, { id: randomUUID(), index: 1 });
  assert.equal(fs.statSync(copy.workspace).isDirectory(), true);
  assert.equal(copy.inputFiles, 0);
  assert.equal(copy.inputBytes, 0);
  assert.deepEqual(fs.readdirSync(copy.workspace), []);
  for (const folder of [os.homedir(), path.parse(source).root]) {
    assert.throws(() => workspaces.reserve(folder, { id: randomUUID(), index: 1 }), /home or a drive root/);
    await assert.rejects(workspaces.prepare(folder, { id: randomUUID(), index: 1 }), /home or a drive root/);
  }
});

test('plain folder inputs keep link and mutation guards, and unrelated Git failures cannot trigger fallback', async t => {
  const { source, workspaces } = fixture(t, { repository: false });
  fs.linkSync(path.join(source, 'source.txt'), path.join(source, 'linked.txt'));
  await assert.rejects(workspaces.prepare(source, { id: randomUUID(), index: 1 }), /unlinked files/);
  fs.unlinkSync(path.join(source, 'linked.txt'));
  const copy = workspaces.copy.bind(workspaces);
  workspaces.copy = async (...args) => {
    if (args[0] === source) fs.writeFileSync(path.join(source, 'source.txt'), 'Changed during setup');
    return copy(...args);
  };
  await assert.rejects(workspaces.prepare(source, { id: randomUUID(), index: 1 }), /changed during workspace setup/);
  workspaces.git = async () => { throw Object.assign(new Error('Unrelated Git failure'), { code: 128, stderr: 'fatal: operation failed' }); };
  await assert.rejects(workspaces.prepare(source, { id: randomUUID(), index: 1 }), /Unrelated Git failure/);
  assert.equal(Object.keys(workspaces.records).length, 0);
});

test('broken Git metadata in a project or ancestor never falls back to plain folder copying', async t => {
  const { directory, source, workspaces } = fixture(t, { repository: false });
  const projectMetadata = path.join(source, '.git');
  fs.writeFileSync(projectMetadata, 'gitdir: missing-fixture-metadata');
  await assert.rejects(workspaces.prepare(source, { id: randomUUID(), index: 1 }), /Git metadata needs repair|gitfile does not point to a valid repository/);
  fs.unlinkSync(projectMetadata);
  fs.writeFileSync(path.join(directory, '.git'), 'gitdir: missing-fixture-metadata');
  await assert.rejects(workspaces.prepare(source, { id: randomUUID(), index: 1 }), /Git metadata needs repair|gitfile does not point to a valid repository/);
  assert.equal(Object.keys(workspaces.records).length, 0);
});

test('cancelled plain folder discovery removes only its temporary Git ignore-reader and admits no workspace', async t => {
  const { source, workspaces } = fixture(t, { repository: false });
  const abort = new AbortController(), temporary = [];
  const gitCommand = workspaces.git.bind(workspaces);
  workspaces.git = async (cwd, args, signal) => {
    if (args.includes('--bare')) { temporary.push(cwd); abort.abort(new Error('User cancelled folder setup')); }
    return gitCommand(cwd, args, signal);
  };
  await assert.rejects(workspaces.prepare(source, { id: randomUUID(), index: 1 }, abort.signal), /abort|cancelled/i);
  assert.equal(temporary.length, 1);
  assert.equal(fs.existsSync(temporary[0]), false);
  assert.equal(fs.readFileSync(path.join(source, 'source.txt'), 'utf8'), 'committed source');
  assert.equal(Object.keys(workspaces.records).length, 0);
});

test('batch copies preserve dirty and untracked inputs, instructions and one frozen snapshot without hard links', async t => {
  const { source, workspaces } = fixture(t);
  fs.writeFileSync(path.join(source, 'source.txt'), 'uncommitted change');
  fs.writeFileSync(path.join(source, 'new.txt'), 'untracked source');
  fs.writeFileSync(path.join(source, 'AGENTS.md'), 'Project rules, including ignored instruction files.');
  fs.writeFileSync(path.join(source, '.env'), 'PRIVATE_TEST_CREDENTIAL');
  fs.mkdirSync(path.join(source, 'build')); fs.writeFileSync(path.join(source, 'build', 'old.exe'), 'old generated output');
  const before = git(source, 'status', '--porcelain=v1', '--untracked-files=all');
  const id = randomUUID(), first = await workspaces.prepare(source, { id, index: 1 });
  assert.equal(first.layout, 2);
  assert.ok(path.relative(path.dirname(workspaces.agents.primary.filename), first.workspace).length <= 24,
    'managed paths leave room for Windows compiler and dependency suffixes');
  fs.writeFileSync(path.join(source, 'source.txt'), 'later local edit');
  const second = await workspaces.prepare(source, { id, index: 2 });
  for (const copy of [first, second]) {
    assert.equal(fs.readFileSync(path.join(copy.workspace, 'source.txt'), 'utf8'), 'uncommitted change');
    assert.equal(fs.readFileSync(path.join(copy.workspace, 'new.txt'), 'utf8'), 'untracked source');
    assert.match(fs.readFileSync(path.join(copy.workspace, 'AGENTS.md'), 'utf8'), /Project rules/);
    assert.equal(fs.existsSync(path.join(copy.workspace, '.env')), false);
    assert.equal(fs.existsSync(path.join(copy.workspace, 'build')), false);
    assert.equal(git(copy.workspace, 'remote'), '');
    assert.match(git(copy.workspace, 'diff'), /uncommitted change/);
    assert.equal(fs.statSync(path.join(copy.workspace, 'source.txt')).nlink, 1);
    assert.equal(fs.existsSync(path.join(copy.workspace, '.git', 'objects', 'info', 'alternates')), false);
  }
  fs.writeFileSync(path.join(first.workspace, 'source.txt'), 'worker output');
  assert.equal(fs.readFileSync(path.join(second.workspace, 'source.txt'), 'utf8'), 'uncommitted change');
  assert.equal(fs.readFileSync(path.join(source, 'source.txt'), 'utf8'), 'later local edit');
  assert.equal(git(source, 'status', '--porcelain=v1', '--untracked-files=all'), before);
  assert.equal(workspaces.same(source, first.workspace), true);
  assert.equal(workspaces.same(first.workspace, second.workspace), true);
});

test('legacy workspace registrations remain readable and copies of copies retain their original project boundary', async t => {
  const { source, primary, agents, workspaces } = fixture(t);
  const id = randomUUID(), workspace = path.join(workspaces.legacyDirectory, id, '1', 'project');
  fs.mkdirSync(workspace, { recursive: true });
  const record = { source, workspace, batchId: id, index: 1, state: 'ready' };
  workspaces.records[workspace] = record; primary.save();
  const restored = new JobWorkspaces(agents);
  assert.equal(restored.record(workspace), record);
  assert.equal(restored.same(workspace, source), true);
  const original = await restored.prepare(source, { id: randomUUID(), index: 1 });
  const nested = await restored.prepare(original.workspace, { id: randomUUID(), index: 1 });
  assert.equal(nested.projectRoot, source);
  assert.equal(restored.same(nested.workspace, original.workspace), true);
  assert.equal(restored.same(nested.workspace, source), true);
});

test('source changes during capture refuse admission while preserving the checkout', async t => {
  const { source, workspaces } = fixture(t);
  const copy = workspaces.copy.bind(workspaces); let first = true;
  workspaces.copy = async (...args) => {
    await copy(...args);
    if (first) { first = false; fs.writeFileSync(path.join(source, 'source.txt'), 'concurrent edit'); }
  };
  await assert.rejects(workspaces.prepare(source, { id: randomUUID(), index: 1 }), /inputs changed/);
  assert.equal(Object.keys(workspaces.records).length, 0);
  assert.equal(fs.readFileSync(path.join(source, 'source.txt'), 'utf8'), 'concurrent edit');
});

test('dirty submodule files have independent Git stores and stay inside their job copy', async t => {
  const { directory, source, workspaces } = fixture(t);
  const library = path.join(directory, 'library'); fs.mkdirSync(library);
  git(library, 'init', '-q'); fs.writeFileSync(path.join(library, 'library.c'), 'original library');
  git(library, 'add', '.'); git(library, 'commit', '-qm', 'Library fixture');
  git(source, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', library, 'vendor/library');
  git(source, 'commit', '-qam', 'Submodule fixture');
  const original = path.join(source, 'vendor', 'library', 'library.c');
  fs.writeFileSync(original, 'dirty local library');
  const copy = await workspaces.prepare(source, { id: randomUUID(), index: 1 });
  const copied = path.join(copy.workspace, 'vendor', 'library');
  assert.equal(fs.readFileSync(path.join(copied, 'library.c'), 'utf8'), 'dirty local library');
  assert.equal(fs.statSync(path.join(copied, '.git')).isDirectory(), true);
  assert.equal(git(copied, 'remote'), '');
  fs.writeFileSync(path.join(copied, 'library.c'), 'worker library edit');
  assert.equal(fs.readFileSync(original, 'utf8'), 'dirty local library');
});

test('the active external wiki is copied once and every worker uses its own index', async t => {
  const { directory, source, primary, workspaces } = fixture(t);
  const { WikiStore } = require('../src/workspace/wiki-store.cjs');
  primary.wikiStore = new WikiStore(path.join(directory, 'wiki-store'));
  const wiki = path.join(directory, 'active-wiki'); fs.mkdirSync(wiki);
  fs.writeFileSync(path.join(wiki, 'index.md'), 'Approved project knowledge');
  fs.writeFileSync(path.join(wiki, 'topic.md'), 'Verified source references');
  primary.wikiStore.setLocation(source, wiki);
  const id = randomUUID(), first = await workspaces.prepare(source, { id, index: 1 });
  fs.writeFileSync(path.join(wiki, 'topic.md'), 'Later wiki edit');
  const second = await workspaces.prepare(source, { id, index: 2 });
  for (const copy of [first, second]) {
    const local = primary.wikiStore.location(copy.workspace).root;
    assert.ok(local.startsWith(copy.workspace + path.sep));
    assert.equal(fs.readFileSync(path.join(local, 'topic.md'), 'utf8'), 'Verified source references');
    assert.equal(git(copy.workspace, 'status', '--porcelain=v1'), '');
  }
  assert.equal(primary.wikiStore.location(source).root, wiki);
  assert.equal(fs.readFileSync(path.join(wiki, 'topic.md'), 'utf8'), 'Later wiki edit');
});

test('tracked credentials and aborted captures admit no runnable workspace', async t => {
  const { source, workspaces } = fixture(t);
  fs.writeFileSync(path.join(source, '.env'), 'FIXTURE_SECRET'); git(source, 'add', '-f', '.env');
  await assert.rejects(workspaces.prepare(source, { id: randomUUID(), index: 1 }), /tracked credential/);
  const abort = new AbortController(); abort.abort(new Error('User stopped setup'));
  await assert.rejects(workspaces.prepare(source, { id: randomUUID(), index: 1 }, abort.signal), /User stopped/);
  assert.equal(Object.keys(workspaces.records).length, 0);
});

test('committed credentials remain blocked after a working-tree deletion', async t => {
  const { source, workspaces } = fixture(t);
  fs.writeFileSync(path.join(source, '.env'), 'FIXTURE_ONLY');
  git(source, 'add', '-f', '.env'); git(source, 'commit', '-qm', 'Credential-path fixture');
  git(source, 'rm', '-q', '.env');
  await assert.rejects(workspaces.prepare(source, { id: randomUUID(), index: 1 }), /committed credential/);
  assert.equal(Object.keys(workspaces.records).length, 0);
});

test('linked inputs, redirected storage, source subfolders and nested Harness storage fail closed', async t => {
  const { directory, source, workspaces } = fixture(t);
  fs.linkSync(path.join(source, 'source.txt'), path.join(source, 'linked.txt'));
  await assert.rejects(workspaces.prepare(source, { id: randomUUID(), index: 1 }), /unlinked files/);
  fs.unlinkSync(path.join(source, 'linked.txt'));
  const subfolder = path.join(source, 'sub'); fs.mkdirSync(subfolder);
  await assert.rejects(workspaces.prepare(subfolder, { id: randomUUID(), index: 1 }), /repository root/);
  assert.throws(() => workspaces.reserve(directory, { id: randomUUID(), index: 1 }), /outside Harness storage/);
  const redirected = path.join(directory, 'redirected'); fs.mkdirSync(redirected);
  fs.rmSync(workspaces.directory, { recursive: true });
  fs.symlinkSync(redirected, workspaces.directory, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => workspaces.reserve(source, { id: randomUUID(), index: 1 }), /redirected/);
});

test('saved project aliases cannot grant unrelated workspaces access and failed saves admit no copy', async t => {
  const { directory, source, primary, workspaces } = fixture(t);
  const record = await workspaces.prepare(source, { id: randomUUID(), index: 1 });
  const other = path.join(directory, 'other'); fs.mkdirSync(other);
  assert.equal(workspaces.same(source, other), false);
  const original = record.workspace;
  record.workspace = other;
  assert.throws(() => workspaces.same(source, other), /moved or was redirected/);
  record.workspace = original;
  primary.save = () => { throw new Error('Workspace registry disk failure'); };
  await assert.rejects(workspaces.prepare(source, { id: randomUUID(), index: 1 }), /registry disk failure/);
  assert.equal(Object.keys(workspaces.records).length, 1);
});

test('setup restart remains held and cancellation never creates a ready empty project', async t => {
  const { source, primary, agents, workspaces } = fixture(t);
  const record = workspaces.reserve(source, { id: randomUUID(), index: 1 });
  const restored = new JobWorkspaces(agents);
  assert.equal(restored.record(record.workspace).state, 'failed');
  assert.match(record.error, /interrupted by a restart/);
  assert.equal(readSessionData(primary.filename).jobWorkspaces[record.workspace].state, 'failed');
  assert.equal(git(source, 'status', '--porcelain=v1'), '');
  const next = workspaces.reserve(source, { id: randomUUID(), index: 1 });
  let started = false;
  workspaces.prepare = async (_source, _batch, signal) => {
    started = true;
    await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  };
  agents.pendingJobs = () => []; agents.budgets = { held: () => false }; agents.closing = true;
  agents.closing = false; agents.pump = () => {}; agents.emit = () => {}; agents.snapshot = () => primary.data;
  workspaces.start(next); assert.equal(started, true);
  workspaces.cancelUnused(); await workspaces.operation.promise;
  assert.equal(next.state, 'failed');
  assert.match(next.error, /cancelled/);
  assert.equal(workspaces.busy, false);
});

test('an aborted first copy leaves no input.json for siblings, and paused jobs keep their setup', async t => {
  const { source, primary, agents, workspaces } = fixture(t);
  const id = randomUUID(), abort = new AbortController();
  const copy = workspaces.copy;
  workspaces.copy = async () => { abort.abort(new Error('stopped')); abort.signal.throwIfAborted(); };
  await assert.rejects(workspaces.prepare(source, { id, index: 1 }, abort.signal), /stopped/);
  workspaces.copy = copy;
  const ready = await workspaces.prepare(source, { id, index: 2 });
  assert.equal(fs.readFileSync(path.join(ready.workspace, 'source.txt'), 'utf8'), 'committed source');

  const record = workspaces.reserve(source, { id: randomUUID(), index: 1 });
  workspaces.prepare = (_source, _batch, signal) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  agents.pendingJobs = () => [{ job: { workspaceCopy: { workspace: record.workspace } } }];
  agents.budgets = { held: () => true };
  agents.pump = () => {}; agents.emit = () => {}; agents.snapshot = () => primary.data;
  workspaces.start(record);
  workspaces.cancelUnused();
  assert.equal(record.state, 'preparing');
  agents.pendingJobs = () => [];
  workspaces.cancelUnused(); await workspaces.operation.promise;
  assert.equal(record.state, 'failed');
});

test('an untracked nested repository is copied like a submodule and a case-duplicate instruction file is copied once', async t => {
  const { source, workspaces } = fixture(t);
  const nested = path.join(source, 'tools', 'helper');
  fs.mkdirSync(nested, { recursive: true });
  git(nested, 'init', '-q'); fs.writeFileSync(path.join(nested, 'helper.js'), 'committed helper');
  git(nested, 'add', '.'); git(nested, 'commit', '-qm', 'Helper fixture');
  fs.writeFileSync(path.join(nested, 'helper.js'), 'dirty helper');
  fs.writeFileSync(path.join(source, 'Agents.md'), 'Project rules');
  git(source, 'add', 'Agents.md', '--force'); git(source, 'commit', '-qm', 'Instructions');
  const copy = await workspaces.prepare(source, { id: randomUUID(), index: 1 });
  const copied = path.join(copy.workspace, 'tools', 'helper');
  assert.equal(fs.readFileSync(path.join(copied, 'helper.js'), 'utf8'), 'dirty helper');
  assert.equal(fs.statSync(path.join(copied, '.git')).isDirectory(), true);
  assert.equal(git(copied, 'remote'), '');
  assert.deepEqual(fs.readdirSync(copy.workspace).filter(name => name.toLowerCase() === 'agents.md').length, 1);
  assert.equal(fs.readFileSync(path.join(copy.workspace, 'Agents.md'), 'utf8'), 'Project rules');
});

// Apply: a copy's own changes against its snapshot, written back into the project only where the project is unchanged.
async function applyFixture(t, repository) {
  const value = fixture(t, { repository });
  const { source, workspaces } = value;
  fs.writeFileSync(path.join(source, 'other.txt'), 'other');
  if (repository) {
    git(source, 'add', 'other.txt');
    git(source, 'commit', '-qm', 'Other file');
  }
  fs.writeFileSync(path.join(source, 'dirty.txt'), 'dirty before the snapshot');
  fs.writeFileSync(path.join(source, 'later.txt'), 'before');
  const copy = await workspaces.prepare(source, { id: randomUUID(), index: 1 });
  return { ...value, copy };
}

test('Apply writes a copy\'s own edits, additions in new folders and deletions into an unchanged project, once', async t => {
  for (const repository of [true, false]) await t.test(repository ? 'git' : 'plain folder', async t => {
    const { source, workspaces, copy } = await applyFixture(t, repository);
    const read = file => fs.readFileSync(path.join(source, file), 'utf8');
    fs.writeFileSync(path.join(copy.workspace, 'source.txt'), 'edited by the bot');
    fs.mkdirSync(path.join(copy.workspace, 'src', 'new'), { recursive: true });
    fs.writeFileSync(path.join(copy.workspace, 'src', 'new', 'added.txt'), 'added by the bot');
    fs.rmSync(path.join(copy.workspace, 'other.txt'));
    fs.mkdirSync(path.join(copy.workspace, 'build'));
    fs.writeFileSync(path.join(copy.workspace, 'build', 'out.exe'), 'ignored output');
    // A different project file changed since the snapshot is no conflict.
    fs.writeFileSync(path.join(source, 'later.txt'), 'changed in the project meanwhile');

    const preview = await workspaces.changes(copy.workspace);
    assert.deepEqual(preview.changes.map(change => `${change.kind} ${change.path}`),
      ['deleted other.txt', 'modified source.txt', 'added src/new/added.txt'], 'no dirty snapshot input, ignored output or later project edit');
    assert.deepEqual(preview.conflicts, []);
    assert.equal(preview.source, fs.realpathSync(source));

    const result = await workspaces.apply(copy.workspace, preview);
    assert.deepEqual(result.applied.sort(), ['other.txt', 'source.txt', 'src/new/added.txt']);
    assert.equal(read('source.txt'), 'edited by the bot');
    assert.equal(read('src/new/added.txt'), 'added by the bot');
    assert.equal(fs.existsSync(path.join(source, 'other.txt')), false);
    assert.equal(read('dirty.txt'), 'dirty before the snapshot');
    assert.equal(read('later.txt'), 'changed in the project meanwhile');
    assert.equal(fs.existsSync(path.join(source, 'build')), false);
    assert.deepEqual((await workspaces.changes(copy.workspace)).changes, [], 'applying again finds nothing to apply');
  });
});

test('Apply refuses project files changed since the copy, and skips an addition the project already has', async t => {
  for (const repository of [true, false]) await t.test(repository ? 'git' : 'plain folder', async t => {
    const { source, workspaces, copy } = await applyFixture(t, repository);
    fs.writeFileSync(path.join(copy.workspace, 'source.txt'), 'edited by the bot');
    fs.writeFileSync(path.join(source, 'source.txt'), 'edited by the user');
    fs.writeFileSync(path.join(copy.workspace, 'both.txt'), 'bot version');
    fs.writeFileSync(path.join(source, 'both.txt'), 'user version');
    fs.writeFileSync(path.join(copy.workspace, 'same.txt'), 'identical');
    fs.writeFileSync(path.join(source, 'same.txt'), 'identical');

    const preview = await workspaces.changes(copy.workspace);
    assert.deepEqual(preview.conflicts, ['both.txt', 'source.txt']);
    assert.deepEqual(preview.changes, [], 'an identical addition is already there');
    await assert.rejects(workspaces.apply(copy.workspace, { ...preview, changes: [] }), /changed since the preview/);
    assert.equal(fs.readFileSync(path.join(source, 'source.txt'), 'utf8'), 'edited by the user');
    assert.equal(fs.readFileSync(path.join(source, 'both.txt'), 'utf8'), 'user version');
  });
});

test('Apply leaves out Harness\'s own files: the job wiki, the starter entry and a comparison\'s instructions', async t => {
  const { directory, source, primary, workspaces } = fixture(t, { repository: false });
  const wiki = path.join(directory, 'wiki');
  fs.mkdirSync(wiki);
  fs.writeFileSync(path.join(wiki, 'index.md'), 'Project decisions.');
  primary.wikiStore = { location: () => ({ root: wiki }), setLocation() {} };
  const id = randomUUID();
  const first = await workspaces.prepare(source, { id, index: 1 });
  fs.writeFileSync(path.join(first.workspace, '.phasma-job-wiki', 'index.md'), 'Edited by wiki upkeep.');
  fs.writeFileSync(path.join(first.workspace, 'INSTRUCTIONS.md'), STARTER);
  assert.deepEqual((await workspaces.changes(first.workspace)).changes, []);

  fs.writeFileSync(path.join(first.workspace, 'INSTRUCTIONS.md'), '# Rules written by the bot');
  assert.deepEqual((await workspaces.changes(first.workspace)).changes.map(change => change.path), ['INSTRUCTIONS.md']);
  const second = await workspaces.prepare(source, { id, index: 2 });
  workspaces.records[second.workspace].comparisonId = randomUUID();
  fs.writeFileSync(path.join(second.workspace, 'INSTRUCTIONS.md'), 'A comparison change.');
  assert.deepEqual((await workspaces.changes(second.workspace)).changes, []);
});

test('Apply refuses while a bot works in the copy, after the copy changes past its preview, and through a link', async t => {
  const { directory, source, agents, workspaces, copy } = await applyFixture(t, true);
  fs.writeFileSync(path.join(copy.workspace, 'source.txt'), 'edited by the bot');
  agents.pendingJobs = () => [{ job: { workspaceCopy: { workspace: copy.workspace } } }];
  await assert.rejects(workspaces.changes(copy.workspace), /still working in this project copy/);
  agents.pendingJobs = () => [];

  const preview = await workspaces.changes(copy.workspace);
  fs.writeFileSync(path.join(copy.workspace, 'source.txt'), 'edited again after the preview');
  await assert.rejects(workspaces.apply(copy.workspace, preview), /changed since the preview/);
  assert.equal(fs.readFileSync(path.join(source, 'source.txt'), 'utf8'), 'committed source');

  const outside = path.join(directory, 'outside');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(source, 'linked'), 'junction');
  fs.mkdirSync(path.join(copy.workspace, 'linked'));
  fs.writeFileSync(path.join(copy.workspace, 'linked', 'escape.txt'), 'must not leave the project');
  await assert.rejects(workspaces.changes(copy.workspace), /cannot write through a link/);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('Undo puts applied files back from the snapshot, and refuses when one changed after it was applied', async t => {
  for (const repository of [true, false]) await t.test(repository ? 'git' : 'plain folder', async t => {
    const { source, workspaces, copy } = await applyFixture(t, repository);
    const read = file => fs.readFileSync(path.join(source, file), 'utf8');
    fs.writeFileSync(path.join(copy.workspace, 'source.txt'), 'edited by the bot');
    fs.mkdirSync(path.join(copy.workspace, 'src'));
    fs.writeFileSync(path.join(copy.workspace, 'src', 'added.txt'), 'added by the bot');
    fs.rmSync(path.join(copy.workspace, 'other.txt'));
    const preview = await workspaces.changes(copy.workspace);
    await workspaces.apply(copy.workspace, preview);

    fs.writeFileSync(path.join(source, 'source.txt'), 'edited by the user after Apply');
    await assert.rejects(workspaces.undo(copy.workspace, preview.changes), /source\.txt changed since it was applied\. Nothing was undone/);
    assert.equal(read('src/added.txt'), 'added by the bot', 'a refused undo touches nothing');

    fs.writeFileSync(path.join(source, 'source.txt'), 'edited by the bot');
    const result = await workspaces.undo(copy.workspace, preview.changes);
    assert.deepEqual(result.restored.sort(), ['other.txt', 'source.txt', 'src/added.txt']);
    assert.equal(read('source.txt'), 'committed source');
    assert.equal(read('other.txt'), 'other');
    assert.equal(fs.existsSync(path.join(source, 'src', 'added.txt')), false);
  });
});
