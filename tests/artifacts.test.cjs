const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { inspect, verify, executable, ArtifactRuns, MAX_BYTES, summary } = require('../src/artifacts.cjs');
const { PRIVATE_PATH } = require('../src/tasks.cjs');

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harness-artifacts-'));
  const workspace = path.join(directory, 'project');
  await fs.mkdir(workspace);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { workspace, directory };
}
function pe() {
  const header = Buffer.alloc(128);
  header.write('MZ'); header.writeUInt32LE(64, 60); header.write('PE\0\0', 64); header.writeUInt16LE(2, 86);
  return header;
}
async function program(workspace) {
  const file = path.join(workspace, process.platform === 'win32' ? 'game.exe' : 'game');
  const buffer = process.platform === 'win32' ? pe() : Buffer.alloc(64);
  if (process.platform === 'linux') { buffer.set([0x7f, 69, 76, 70, 2, 1]); buffer.writeUInt16LE(2, 16); }
  if (process.platform === 'darwin') { buffer.writeUInt32LE(0xfeedfacf); buffer.writeUInt32LE(2, 12); }
  await fs.writeFile(file, buffer, { mode: 0o700 });
  return path.basename(file);
}

test('publication records bounded files and folders; running requires the published executable digest', async t => {
  const { workspace } = await fixture(t);
  await fs.writeFile(path.join(workspace, 'readme.txt'), 'available, not verified');
  const file = await inspect(workspace, 'readme.txt');
  assert.equal(file.kind, 'file');
  assert.equal(file.sha256, createHash('sha256').update('available, not verified').digest('hex'));
  assert.equal(file.size, 23);
  assert.equal((await inspect(workspace, '.')).kind, 'folder');
  assert.equal(await verify(file, true), await fs.realpath(workspace));
  await assert.rejects(verify(file), /executable changed/);
  const name = await program(workspace), app = await inspect(workspace, name);
  assert.equal(app.kind, 'program');
  assert.equal(await verify(app), path.join(await fs.realpath(workspace), name));
  await fs.appendFile(path.join(workspace, name), 'changed');
  await assert.rejects(verify(app), /executable changed/);
  await fs.unlink(path.join(workspace, name));
  assert.equal(await verify(app, true), await fs.realpath(workspace), 'a deleted output still has an inspectable folder');
  await fs.mkdir(path.join(workspace, 'output.exe'));
  const folder = await inspect(workspace, 'output.exe');
  await fs.rmdir(path.join(workspace, 'output.exe'));
  await fs.writeFile(path.join(workspace, 'output.exe'), pe());
  await assert.rejects(verify(folder, true), /artifact folder changed/, 'Open folder must never open a replacement executable');
  assert.match(summary([file]), /file availability only; publication does not verify build, launch or gameplay/);
});

test('artifact paths reject escape, links, credentials, absolute paths and oversized files', async t => {
  const { workspace, directory } = await fixture(t);
  await fs.writeFile(path.join(directory, 'outside.txt'), 'outside');
  for (const relative of ['../outside.txt', path.join(directory, 'outside.txt'), 'C:\\outside.txt', '//server/share', 'game.exe:stream', 'bad\0name'])
    await assert.rejects(inspect(workspace, relative));
  for (const relative of ['.env', 'auth.json', 'credentials.json', 'secrets.yaml', 'id_ed25519', 'private.pem']) {
    await fs.writeFile(path.join(workspace, relative), 'private');
    await assert.rejects(inspect(workspace, relative), /private credential/);
  }
  await fs.mkdir(path.join(workspace, '.git'));
  await fs.writeFile(path.join(workspace, '.git', 'config'), 'private');
  await assert.rejects(inspect(workspace, '.git/config'), /private credential/);
  await fs.writeFile(path.join(workspace, 'source.txt'), 'data');
  await fs.link(path.join(workspace, 'source.txt'), path.join(workspace, 'linked.txt'));
  await assert.rejects(inspect(workspace, 'linked.txt'), /without links/);
  const large = await fs.open(path.join(workspace, 'large.bin'), 'w');
  try { await large.truncate(MAX_BYTES + 1); } finally { await large.close(); }
  await assert.rejects(inspect(workspace, 'large.bin'), /512 MB/);
  // Junctions do not require Windows developer mode or symlink privileges.
  await fs.symlink(directory, path.join(workspace, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inspect(workspace, 'escape/outside.txt'), /outside the workspace/);
  await fs.symlink(workspace, path.join(directory, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
  const frozen = { ...(await inspect(workspace, '.')), workspace: path.join(directory, 'alias') };
  await assert.rejects(verify(frozen, true), /workspace moved/);
});

test('native file recognition excludes scripts, DLLs and non-executable Unix files', () => {
  const header = pe();
  assert.equal(executable(header, {}, 'game.exe', 'win32'), true);
  assert.equal(executable(header, {}, 'game.cmd', 'win32'), false);
  header.writeUInt16LE(0x2002, 86);
  assert.equal(executable(header, {}, 'dll.exe', 'win32'), false);
  const elf = Buffer.alloc(32); elf.set([0x7f, 69, 76, 70, 2, 1]); elf.writeUInt16LE(3, 16);
  assert.equal(executable(elf, { mode: 0o700 }, 'game', 'linux'), true);
  assert.equal(executable(elf, { mode: 0o600 }, 'game', 'linux'), false);
  assert.equal(executable(elf, { mode: 0o700 }, 'game.so', 'linux'), false);
  const macho = Buffer.alloc(32); macho.writeUInt32LE(0xfeedfacf); macho.writeUInt32LE(2, 12);
  assert.equal(executable(macho, { mode: 0o700 }, 'game', 'darwin'), true);
  macho.writeUInt32LE(6, 12);
  assert.equal(executable(macho, { mode: 0o700 }, 'library', 'darwin'), false);
});

test('artifact runs use fixed arguments, filtered environment and tracked Stop with retryable cleanup', async t => {
  const prior = process.env.PHASMA_ARTIFACT_SECRET;
  process.env.PHASMA_ARTIFACT_SECRET = 'must not reach the game';
  t.after(() => { if (prior === undefined) delete process.env.PHASMA_ARTIFACT_SECRET; else process.env.PHASMA_ARTIFACT_SECRET = prior; });
  const calls = [], children = [];
  let remaining = [123];
  const manager = new ArtifactRuns((file, args, options) => {
    calls.push({ file, args, options });
    const child = new EventEmitter(); children.push(child);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  }, async child => { assert.ok(children.includes(child)); return remaining; });
  const record = { label: 'Game', workspace: path.resolve('project'), path: 'game.exe' };
  const filename = path.join(record.workspace, record.path);
  const run = await manager.play(record, filename);
  assert.deepEqual(calls[0].args, []);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.cwd, record.workspace);
  assert.equal(calls[0].options.env.PHASMA_ARTIFACT_SECRET, undefined);
  assert.equal(manager.busy, true);
  await assert.rejects(manager.play(record, filename), /already running/);
  await assert.rejects(manager.stop(run.id), /cleanup is unconfirmed/);
  assert.equal(manager.snapshot()[0].status, 'cleanup-blocked');
  remaining = [];
  await manager.stop(run.id);
  assert.equal(manager.busy, false);
  assert.equal((await manager.stop(run.id)).status, 'stopped', 'Stop retries cannot affect another process');
  const second = await manager.play(record, filename);
  await manager.shutdown();
  assert.equal(manager.busy, false);
  assert.notEqual(second.id, run.id);
  await assert.rejects(manager.play(record, filename), /runner is stopping/);
});

test('failed launches and naturally closed tests clean their owned process trees', async () => {
  let child, cleanups = 0;
  const manager = new ArtifactRuns(() => {
    child = new EventEmitter(); queueMicrotask(() => child.emit('error', new Error('native failure'))); return child;
  }, async () => { cleanups++; return []; });
  await assert.rejects(manager.play({ label: 'Broken' }, path.resolve('broken.exe')), /could not start/);
  assert.equal(manager.busy, false);
  manager.launch = () => { child = new EventEmitter(); queueMicrotask(() => child.emit('spawn')); return child; };
  await manager.play({ label: 'Game' }, path.resolve('game.exe'));
  child.emit('close');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(manager.busy, false);
  assert.equal(cleanups, 2);
});

test('Quit during a pending spawn cannot report a successful test launch', async () => {
  let child;
  const manager = new ArtifactRuns(() => { child = new EventEmitter(); return child; }, async () => []);
  const pending = manager.play({ label: 'Game' }, path.resolve('game.exe'));
  const rejected = assert.rejects(pending, /could not start/);
  await manager.shutdown();
  child.emit('spawn');
  await rejected;
  assert.equal(manager.busy, false);
});

test('common credential files are refused, one list shared with workspace copies, ordinary source is not', async t => {
  const { workspace } = await fixture(t);
  const secrets = ['.npmrc', '.netrc', '.git-credentials', '.docker/config.json', '.kube/config', 'service-account-prod.json',
    'client_secret.json', 'api-credentials.txt', 'release.keystore', '.ssh/id_ecdsa', '.claude/.credentials.json',
    '.azure/msal_token_cache.json', '.codex/auth.json', 'ID_RSA'];
  for (const relative of secrets) {
    await fs.mkdir(path.dirname(path.join(workspace, relative)), { recursive: true });
    await fs.writeFile(path.join(workspace, relative), 'private');
    await assert.rejects(inspect(workspace, relative), /private credential/, relative);
    assert.ok(PRIVATE_PATH.test(relative), relative);
  }
  await fs.writeFile(path.join(workspace, 'index.js'), 'ok');
  assert.equal((await inspect(workspace, 'index.js')).kind, 'file');
});
