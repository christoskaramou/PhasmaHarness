const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { WikiStore } = require('../src/workspace/wiki-store.cjs');
const { ContextSearch } = require('../src/workspace/context-search.cjs');

test('local wikis isolate same-name workspaces, retain edits, use explicit locations, and join only their own context search', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-wiki-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, 'a', 'project'), b = path.join(root, 'b', 'project');
  fs.mkdirSync(a, { recursive: true }); fs.mkdirSync(b, { recursive: true });
  const store = new WikiStore(path.join(root, 'workspace-data'));
  const first = store.ensure(a), second = store.ensure(b);
  assert.notEqual(first.root, second.root);
  fs.mkdirSync(path.join(first.root, 'architecture'));
  fs.writeFileSync(path.join(first.root, 'architecture', 'runtime.md'), '# Amberquartz runtime\nAmberquartz queues preserve completion order.');
  fs.writeFileSync(second.index, '# Copperfalcon\nCopperfalcon secret project decision.');
  assert.match(fs.readFileSync(store.ensure(b).index, 'utf8'), /Copperfalcon/);
  const search = new ContextSearch(a, null);
  search.wikiStore = store;
  const result = await search.search(a, 'Amberquartz runtime', 'local');
  assert.ok(result.hits.some(h => h.source === 'wiki' && h.path === path.join(first.root, 'architecture', 'runtime.md')));
  assert.equal((await search.search(a, 'Copperfalcon', 'local')).hits.length, 0);
  fs.mkdirSync(path.join(a, 'docs/wiki'), { recursive: true });
  fs.writeFileSync(path.join(a, 'docs/wiki/index.md'), '# Existing project wiki');
  assert.equal(store.ensure(a).managed, true);
  assert.ok((await search.search(a, 'Amberquartz', 'local')).hits.length);
  store.setLocation(a, path.join(a, 'docs/wiki'));
  assert.equal(new WikiStore(store.directory).ensure(a).managed, false);
  assert.equal((await search.search(a, 'Amberquartz', 'local')).hits.length, 0);
  assert.ok((await search.search(a, 'Existing project wiki', 'local')).hits.length);
  store.setLocation(a, null);
  assert.ok((await search.search(a, 'Amberquartz', 'local')).hits.length);
  assert.equal(fs.readFileSync(path.join(a, 'docs/wiki/index.md'), 'utf8'), '# Existing project wiki');
  assert.equal(new WikiStore(store.directory).ensure(a).root, first.root);
  assert.throws(() => store.setLocation(a, 'relative'));
});

// GitHub's Windows runners have a short (8.3) temp path, C:\Users\RUNNER~1\...; this reproduces that anywhere 8.3 names exist.
test('a workspace and wiki store reached through Windows short (8.3) names are still searched', { skip: process.platform !== 'win32' }, async t => {
  const long = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-wiki-short-'));
  t.after(() => fs.rmSync(long, { recursive: true, force: true }));
  let short = '';
  try { short = execSync(`for %I in ("${long}") do @echo %~sI`, { encoding: 'utf8', windowsHide: true }).trim(); } catch {}
  if (!short || short.toLowerCase() === long.toLowerCase()) { t.skip('No 8.3 names on this volume.'); return; }
  const workspace = path.join(short, 'project');
  fs.mkdirSync(workspace);
  const store = new WikiStore(path.join(short, 'workspace-data'));
  const wiki = store.ensure(workspace);
  fs.writeFileSync(path.join(wiki.root, 'runtime.md'), '# Amberquartz runtime\nAmberquartz queues preserve completion order.');
  const search = new ContextSearch(workspace, null);
  search.wikiStore = store;
  const result = await search.search(workspace, 'Amberquartz runtime', 'local');
  assert.ok(result.hits.some(h => h.source === 'wiki' && h.path === path.join(wiki.root, 'runtime.md')));
});
