const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { WikiStore } = require('../src/workspace/wiki-store.cjs');
const { ContextSearch } = require('../src/workspace/context-search.cjs');

test('Harness data isolates same-name workspaces and stays out of search; the workspace docs/wiki is searched even when git-ignored', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-wiki-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const a = path.join(root, 'a', 'project'), b = path.join(root, 'b', 'project');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });
  const store = new WikiStore(path.join(root, 'workspace-data'));
  const first = store.ensure(a), second = store.ensure(b);
  assert.notEqual(first.root, second.root);
  fs.writeFileSync(path.join(first.root, 'lessons.md'), '# Amberquartz lesson\nAmberquartz Harness-side note.');
  fs.writeFileSync(second.index, '# Copperfalcon\nCopperfalcon secret project decision.');
  assert.match(fs.readFileSync(store.ensure(b).index, 'utf8'), /Copperfalcon/);

  const search = new ContextSearch(a, null);
  assert.equal((await search.search(a, 'Amberquartz', 'local')).hits.length, 0, 'Harness data is not the wiki');
  assert.equal((await search.search(a, 'Copperfalcon', 'local')).hits.length, 0);

  execSync('git init -q', { cwd: a, windowsHide: true });
  fs.writeFileSync(path.join(a, '.gitignore'), 'docs/wiki/\n');
  fs.mkdirSync(path.join(a, 'docs', 'wiki', 'architecture'), { recursive: true });
  fs.writeFileSync(path.join(a, 'docs', 'wiki', 'index.md'), '# Existing project wiki');
  fs.writeFileSync(path.join(a, 'docs', 'wiki', 'architecture', 'runtime.md'), '# Amberquartz runtime\nAmberquartz queues preserve completion order.');
  const result = await search.search(a, 'Amberquartz runtime', 'local');
  assert.ok(result.hits.some(h => h.source === 'wiki' && h.path === 'docs/wiki/architecture/runtime.md'));
  assert.equal(result.hits.filter(h => h.path === 'docs/wiki/architecture/runtime.md').length, 1);

  // Old custom content is imported once into Harness's folder without replacing current notes.
  fs.writeFileSync(store.settingsFile, JSON.stringify({ [store.identity(a)]: path.join(a, 'docs/wiki') }));
  assert.equal(new WikiStore(store.directory).ensure(a).root, first.root);
  assert.equal(fs.readFileSync(path.join(a, 'docs/wiki/index.md'), 'utf8'), '# Existing project wiki');
  const imported = fs.readdirSync(first.root).find(name => name.startsWith('imported-'));
  assert.equal(fs.readFileSync(path.join(first.root, imported, 'index.md'), 'utf8'), '# Existing project wiki');
  fs.writeFileSync(path.join(first.root, imported, 'index.md'), '# Updated imported notes');
  new WikiStore(store.directory).ensure(a);
  assert.equal(fs.readFileSync(path.join(first.root, imported, 'index.md'), 'utf8'), '# Updated imported notes');
});

// GitHub's Windows runners have a short (8.3) temp path, C:\Users\RUNNER~1\...; this reproduces that anywhere 8.3 names exist.
test('a workspace wiki reached through Windows short (8.3) names is still searched', { skip: process.platform !== 'win32' }, async t => {
  const long = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-wiki-short-'));
  t.after(() => fs.rmSync(long, { recursive: true, force: true }));
  let short = '';
  try {
    short = execSync(`for %I in ("${long}") do @echo %~sI`, { encoding: 'utf8', windowsHide: true }).trim();
  } catch { /* no short names */ }
  if (!short || short.toLowerCase() === long.toLowerCase()) {
    t.skip('No 8.3 names on this volume.');
    return;
  }

  const workspace = path.join(short, 'project');
  fs.mkdirSync(path.join(workspace, 'docs', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'docs', 'wiki', 'runtime.md'), '# Amberquartz runtime\nAmberquartz queues preserve completion order.');
  const result = await new ContextSearch(workspace, null).search(workspace, 'Amberquartz runtime', 'local');
  assert.ok(result.hits.some(h => h.source === 'wiki' && h.path === 'docs/wiki/runtime.md'));
});
