const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { randomUUID, createHash } = require('node:crypto');
const { unzipSync } = require('fflate');
const { inspect, MAX_BYTES } = require('../src/artifacts.cjs');
const { ArtifactDownloads } = require('../src/artifact-downloads.cjs');

async function fixture(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'harness-downloads-')));
  const workspace = path.join(directory, 'project'), cache = path.join(directory, 'credentials.artifact-downloads');
  await fs.mkdir(workspace);
  const manager = new ArtifactDownloads(cache);
  t.after(async () => {
    await manager.close();
    assert.equal(path.dirname(directory), await fs.realpath(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('harness-downloads-'));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { directory, workspace, cache, manager };
}
async function contents(lease) {
  const chunks = [];
  for await (const chunk of lease.stream()) chunks.push(chunk);
  return Buffer.concat(chunks);
}

test('downloads freeze verified files without changing sources and release bounded snapshots after use', async t => {
  const { workspace, cache, manager } = await fixture(t);
  const original = Buffer.alloc(2 * 1024 * 1024, 37), file = path.join(workspace, 'game.bin');
  await fs.writeFile(file, original);
  const record = await inspect(workspace, 'game.bin'), lease = await manager.prepare(record);
  assert.equal(lease.size, original.length);
  assert.equal(lease.sha256, record.sha256);
  assert.equal(manager.busy, true);
  await fs.writeFile(file, 'later source edit');
  assert.deepEqual(await contents(lease), original, 'a later edit cannot change an already verified snapshot');
  await lease.close(); await lease.close();
  assert.equal(manager.busy, false);
  assert.deepEqual(await fs.readdir(cache), []);
  assert.equal(await fs.readFile(file, 'utf8'), 'later source edit');
  await assert.rejects(manager.prepare(record), /artifact changed/);
  await fs.writeFile(path.join(workspace, 'empty.txt'), '');
  const empty = await manager.prepare(await inspect(workspace, 'empty.txt'));
  assert.deepEqual(await contents(empty), Buffer.alloc(0)); await empty.close();
});

test('folder downloads contain complete portable ZIP snapshots, empty folders and original executable permissions', async t => {
  const { workspace, manager } = await fixture(t);
  await fs.mkdir(path.join(workspace, 'assets'));
  await fs.mkdir(path.join(workspace, 'empty'));
  await fs.writeFile(path.join(workspace, 'game'), 'native game', { mode: 0o755 });
  await fs.writeFile(path.join(workspace, 'assets', 'Καλημέρα.txt'), 'game assets');
  const lease = await manager.prepare(await inspect(workspace, '.'));
  assert.equal(lease.filename, 'project.zip');
  const bytes = await contents(lease), files = unzipSync(bytes);
  assert.equal(Buffer.from(files.game).toString(), 'native game');
  assert.equal(Buffer.from(files['assets/Καλημέρα.txt']).toString(), 'game assets');
  assert.ok(files['empty/']);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), lease.sha256);
  const signature = Buffer.from([0x50, 0x4b, 1, 2]);
  let executableMode;
  const folderModes = {};
  for (let offset = bytes.indexOf(signature); offset >= 0; offset = bytes.indexOf(signature, offset + 4)) {
    const name = bytes.toString('utf8', offset + 46, offset + 46 + bytes.readUInt16LE(offset + 28));
    if (name === 'game') executableMode = bytes.readUInt32LE(offset + 38) >>> 16;
    if (name.endsWith('/')) folderModes[name] = bytes.readUInt32LE(offset + 38) >>> 16;
  }
  assert.equal(executableMode, Number((await fs.stat(path.join(workspace, 'game'))).mode) & 0xffff);
  for (const name of ['assets/', 'empty/']) {
    assert.equal(folderModes[name] & 0o170000, 0o040000, name + ' is a folder entry');
    assert.equal(folderModes[name] & 0o500, 0o500, name + ' stays readable and searchable after unzip, also when made on Windows');
  }
  await lease.close();
});

test('Stop cancels an active stream, releases its slot and permits later downloads', async t => {
  const { workspace, manager, cache } = await fixture(t);
  await fs.writeFile(path.join(workspace, 'result.bin'), Buffer.alloc(2 * 1024 * 1024));
  const record = await inspect(workspace, 'result.bin'), lease = await manager.prepare(record);
  const stream = lease.stream();
  await new Promise(resolve => stream.once('readable', resolve));
  assert.ok(stream.read(1));
  await manager.cancel();
  assert.equal(stream.destroyed, true);
  assert.deepEqual(manager.snapshot(), { active: 0, error: null });
  assert.deepEqual(await fs.readdir(cache), []);
  await (await manager.prepare(record)).close();
});

test('parallel snapshots reserve disk space and invalid cache recovery stays explicit and retryable', async t => {
  const { workspace, manager, cache } = await fixture(t);
  await fs.writeFile(cache, 'foreign cache file');
  await manager.recover();
  assert.match(manager.error, /ordinary local download cache/);
  assert.equal(manager.busy, true);
  await fs.unlink(cache); await manager.recover();
  assert.equal(manager.busy, false);
  await fs.writeFile(path.join(workspace, 'result.bin'), Buffer.alloc(2 * 1024 * 1024));
  const record = await inspect(workspace, 'result.bin');
  t.mock.method(fs, 'statfs', async () => ({ bavail: 67n * 1024n * 1024n, bsize: 1n }));
  const first = await manager.prepare(record);
  await assert.rejects(manager.prepare(record), /alongside current transfers/);
  assert.equal(manager.active.size, 1);
  await first.close();
  await (await manager.prepare(record)).close();
});

test('folder exports reject private files, links and oversized inputs without leaking partial output', async t => {
  const { workspace, cache, manager, directory } = await fixture(t);
  await fs.writeFile(path.join(workspace, 'credentials.phasma-remote'), 'private');
  await assert.rejects(manager.prepare(await inspect(workspace, '.')), /private credential/);
  await fs.unlink(path.join(workspace, 'credentials.phasma-remote'));
  await fs.writeFile(path.join(directory, 'outside.txt'), 'outside');
  await fs.link(path.join(directory, 'outside.txt'), path.join(workspace, 'linked.txt'));
  await assert.rejects(manager.prepare(await inspect(workspace, '.')), /without links/);
  await fs.unlink(path.join(workspace, 'linked.txt'));
  const large = await fs.open(path.join(workspace, 'large.bin'), 'w');
  await large.truncate(MAX_BYTES + 1); await large.close();
  await assert.rejects(manager.prepare(await inspect(workspace, '.')), /under 512 MB/);
  assert.equal(manager.busy, false);
  assert.equal(await fs.stat(cache).catch(() => null), null, 'disallowed inputs never allocate a snapshot');
});

test('cancellation stops a folder inventory before scanning its remaining children', async t => {
  const { workspace, manager } = await fixture(t);
  for (let i = 0; i < 4; i++) await fs.writeFile(path.join(workspace, `file-${i}.txt`), 'result');
  const record = await inspect(workspace, '.'), abort = new AbortController(), realpath = fs.realpath;
  let visited = 0;
  t.mock.method(fs, 'realpath', async filename => {
    const result = await realpath(filename);
    if (path.dirname(filename) === workspace && /^file-\d\.txt$/.test(path.basename(filename))) {
      visited++; if (visited === 1) abort.abort();
    }
    return result;
  });
  await assert.rejects(manager.prepare(record, abort.signal), /cancelled/);
  assert.equal(visited, 1, 'Stop must not continue walking every remaining file');
  assert.equal(manager.busy, false);
});

test('source mutation, cancellation, parallel admission and Quit cannot publish unfinished snapshots', async t => {
  const { workspace, cache, manager } = await fixture(t);
  const filename = path.join(workspace, 'source.bin');
  await fs.writeFile(filename, Buffer.alloc(131072, 29));
  const record = await inspect(workspace, 'source.bin'), originalOpen = fs.open;
  let changed = false;
  fs.open = async (...args) => {
    const handle = await originalOpen(...args);
    if (args[0] === filename && args[1] === 'r') {
      const read = handle.read.bind(handle);
      handle.read = async (...values) => {
        const result = await read(...values);
        if (!changed) { changed = true; await fs.writeFile(filename, 'changed during read'); }
        return result;
      };
    }
    return handle;
  };
  try { await assert.rejects(manager.prepare(record), /artifact changed/); }
  finally { fs.open = originalOpen; }
  assert.deepEqual(await fs.readdir(cache), []);
  const current = await inspect(workspace, 'source.bin');
  const a = await manager.prepare(current), b = await manager.prepare(current);
  await assert.rejects(manager.prepare(current), /two current downloads/);
  await a.close(); await b.close();
  const abort = new AbortController(); abort.abort();
  await assert.rejects(manager.prepare(current, abort.signal), /cancelled/);
  await manager.prepare(current);
  await manager.close();
  assert.equal(manager.busy, false);
  assert.deepEqual(await fs.readdir(cache), []);
  await assert.rejects(manager.prepare(current), /runner is stopping/);
});

test('restart removes recognized orphaned snapshots and preserves foreign cache contents for review', async t => {
  const { workspace, cache, manager } = await fixture(t);
  await fs.writeFile(path.join(workspace, 'result.txt'), 'saved');
  await manager.prepare(await inspect(workspace, 'result.txt'));
  const job = [...manager.active][0];
  await job.handle.close(); manager.active.delete(job); job.resolve();
  await manager.recover();
  assert.deepEqual(await fs.readdir(cache), []);
  const foreign = path.join(cache, 'download-' + randomUUID());
  await fs.mkdir(foreign); await fs.writeFile(path.join(foreign, 'owner.json'), 'foreign');
  await manager.recover();
  assert.equal(manager.busy, true);
  await assert.rejects(manager.prepare(await inspect(workspace, 'result.txt')), /cleanup is unconfirmed/);
  assert.equal(await fs.readFile(path.join(foreign, 'owner.json'), 'utf8'), 'foreign');
  await fs.unlink(path.join(foreign, 'owner.json')); await fs.rmdir(foreign);
  await manager.recover(); assert.equal(manager.busy, false);
});
