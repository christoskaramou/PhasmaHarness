const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectInstructions, projectEntry, currentProjectEntry, legacyInstructionFiles, STARTER } = require('../src/workspace/project-instructions.cjs');
const { WikiStore } = require('../src/workspace/wiki-store.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'source');
  fs.mkdirSync(workspace);
  return { root, workspace, store: new WikiStore(path.join(root, 'AppData', 'Wikis')) };
}

test('one workspace entry imports the root legacy rules once, deduplicates mirrors and ignores later legacy edits', t => {
  const { workspace } = fixture(t);
  fs.mkdirSync(path.join(workspace, 'Engine'));
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'HERMES.md']) fs.writeFileSync(path.join(workspace, name), 'Shared amberquartz rule.');
  fs.writeFileSync(path.join(workspace, 'Engine', 'INSTRUCTIONS.md'), 'Subfolder copperfalcon rule.');
  fs.mkdirSync(path.join(workspace, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.cursor', 'rules', 'quality.mdc'), '---\nalwaysApply: true\n---\nCursor quality rule.');
  fs.writeFileSync(path.join(workspace, 'manual.md'), 'Ordinary documentation.');
  const initial = projectInstructions(workspace, true);
  assert.equal(initial.match(/Shared amberquartz rule/g).length, 1);
  assert.doesNotMatch(initial, /copperfalcon|Workspace scope/, 'subfolder rule files are never imported');
  assert.doesNotMatch(initial, /Ordinary documentation/);
  assert.match(initial, /Imported from: \.cursor\/rules\/quality.mdc[\s\S]*Cursor quality rule/);
  assert.equal(projectEntry(workspace), path.join(workspace, 'PhasmaHarness.md'));
  assert.equal(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), 'Shared amberquartz rule.', 'automatic initialization never deletes originals');
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Stale legacy rule.');
  assert.doesNotMatch(projectInstructions(workspace), /Stale legacy rule/);
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'HERMES.md', 'Engine/INSTRUCTIONS.md']) fs.unlinkSync(path.join(workspace, name));
  assert.match(projectInstructions(workspace, true), /Shared amberquartz rule/);
  assert.equal(fs.existsSync(path.join(workspace, 'INSTRUCTIONS.md')), false);
  assert.equal(fs.existsSync(path.join(workspace, 'AGENTS.md')), false);
  assert.equal(currentProjectEntry(path.join(workspace, 'INSTRUCTIONS.md')), projectEntry(workspace));
  fs.writeFileSync(projectEntry(workspace), 'Fresh canonical rule.');
  assert.match(projectInstructions(workspace), /Fresh canonical rule/);
  assert.doesNotMatch(projectInstructions(workspace), /amberquartz/);
});

test('invalid legacy import preserves all originals and creates no partial entry', t => {
  const { workspace } = fixture(t);
  const original = path.join(workspace, 'AGENTS.md');
  fs.writeFileSync(original, 'x'.repeat(65537));
  assert.throws(() => projectInstructions(workspace, true), /exceeds/);
  assert.equal(fs.existsSync(projectEntry(workspace)), false);
  assert.equal(fs.statSync(original).size, 65537);
  fs.writeFileSync(original, 'Valid rule.');
  fs.linkSync(original, projectEntry(workspace));
  assert.throws(() => projectInstructions(workspace), /unlinked/);
});

test('instruction import reads only the workspace root, never subfolders, nested repositories or managed workspaces', t => {
  const { workspace } = fixture(t);
  fs.mkdirSync(path.join(workspace, '.git'));
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Parent workspace rule.');
  fs.mkdirSync(path.join(workspace, 'Engine'));
  fs.writeFileSync(path.join(workspace, 'Engine', 'INSTRUCTIONS.md'), 'Local scoped rule.');
  for (const name of ['repository', 'worktree', 'managed']) {
    const child = path.join(workspace, name);
    fs.mkdirSync(path.join(child, 'nested'), { recursive: true });
    if (name === 'repository') fs.mkdirSync(path.join(child, '.git'));
    else fs.writeFileSync(path.join(child, name === 'worktree' ? '.git' : 'PhasmaHarness.md'), name === 'worktree' ? 'gitdir: elsewhere' : 'Managed project rule.');
    fs.writeFileSync(path.join(child, 'AGENTS.md'), 'Independent project rule.');
    fs.writeFileSync(path.join(child, 'nested', 'INSTRUCTIONS.md'), 'x'.repeat(65537));
  }
  const readOnly = projectInstructions(workspace);
  assert.match(readOnly, /Parent workspace rule/);
  assert.doesNotMatch(readOnly, /Local scoped rule|Independent project rule|Managed project rule/);
  assert.equal(fs.existsSync(projectEntry(workspace)), false);
  const writable = projectInstructions(workspace, true);
  assert.match(writable, /Parent workspace rule/);
  assert.doesNotMatch(writable, /Local scoped rule|Independent project rule|Managed project rule/);
  assert.match(projectInstructions(path.join(workspace, 'managed')), /Managed project rule/);
  assert.equal(fs.statSync(path.join(workspace, 'repository', 'nested', 'INSTRUCTIONS.md')).size, 65537);
});

test('legacy workspace-data instruction copies are not project rules', t => {
  const { workspace } = fixture(t);
  const copy = path.join(workspace, 'workspace-data', 'harness', 'runs', 'project');
  fs.mkdirSync(copy, { recursive: true });
  fs.writeFileSync(path.join(copy, 'AGENTS.md'), 'Stale generated project rule.');
  assert.doesNotMatch(projectInstructions(workspace, true), /Stale generated project rule/);
});

test('instruction loading keeps root provider rules and never imports a child folder\'s rules', t => {
  const { workspace } = fixture(t);
  for (const folder of ['.cursor/rules', '.github', 'plain-project']) fs.mkdirSync(path.join(workspace, folder), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Root agent rule.');
  fs.writeFileSync(path.join(workspace, '.cursor/rules/root.mdc'), 'Root Cursor rule.');
  fs.writeFileSync(path.join(workspace, '.github/copilot-instructions.md'), 'Root Copilot rule.');
  fs.writeFileSync(path.join(workspace, 'plain-project/AGENTS.md'), 'Plain child rule.');
  const body = projectInstructions(workspace);
  assert.match(body, /Root agent rule/);
  assert.match(body, /Root Cursor rule/);
  assert.match(body, /Root Copilot rule/);
  assert.doesNotMatch(body, /Plain child rule/);
  assert.equal(fs.existsSync(projectEntry(workspace)), false);
  assert.match(projectInstructions(path.join(workspace, 'plain-project')), /Plain child rule/);
  assert.doesNotMatch(projectInstructions(workspace, true), /Plain child rule/, 'creating the entry imports root rules only');
});

test('instruction discovery never enumerates excluded projects or unrelated Main Bot folders', t => {
  const { workspace } = fixture(t);
  for (const name of ['repository', 'worktree', 'managed', 'workspace-data', 'plain-project']) {
    const child = path.join(workspace, name);
    fs.mkdirSync(child);
    if (name === 'repository') fs.mkdirSync(path.join(child, '.git'));
    if (name === 'worktree') fs.writeFileSync(path.join(child, '.git'), 'gitdir: elsewhere');
    if (name === 'managed') fs.writeFileSync(path.join(child, 'PhasmaHarness.md'), 'Child canonical rule.');
    fs.writeFileSync(path.join(child, 'AGENTS.md'), 'Child rule.');
  }
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Root rule.');
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (directory, options) => {
    const relative = path.relative(workspace, directory);
    if (relative) throw new Error('Must not enter: ' + relative);
    return readdir(directory, options);
  });
  assert.deepEqual(legacyInstructionFiles(workspace).map(e => e.relative), ['AGENTS.md']);
  t.mock.restoreAll();
});

test('instruction discovery at home keeps root rules without visiting protected personal folders', t => {
  const { workspace } = fixture(t);
  for (const directory of ['AppData/Local/Temp/msdtadmin', 'Downloads', '.cursor/rules'])
    fs.mkdirSync(path.join(workspace, directory), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Home workspace rule.');
  fs.writeFileSync(path.join(workspace, '.cursor/rules/root.mdc'), 'Root Cursor rule.');
  fs.writeFileSync(path.join(workspace, 'Downloads/AGENTS.md'), 'Unrelated downloaded rule.');
  t.mock.method(os, 'homedir', () => workspace);
  const readdir = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (directory, options) => {
    const relative = path.relative(workspace, directory).replace(/\\/g, '/');
    if (/^(AppData|Downloads)(\/|$)/.test(relative))
      throw Object.assign(new Error('Access is denied: ' + directory), { code:'EACCES' });
    return readdir(directory, options);
  });
  for (const create of [false, true]) {
    const body = projectInstructions(workspace, create);
    assert.match(body, /Home workspace rule/);
    assert.match(body, /Root Cursor rule/);
    assert.doesNotMatch(body, /Unrelated downloaded rule/);
  }
  assert.equal(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), 'Home workspace rule.');
  t.mock.restoreAll();
});

test('instruction discovery at a drive root never enters system or user folders', t => {
  const volume = path.parse(process.cwd()).root;
  t.mock.method(fs, 'readdirSync', directory => {
    assert.equal(directory, volume, 'only the volume root may be listed');
    return ['Users', 'Windows', 'System Volume Information'].map(name => ({ name, isDirectory:() => true }));
  });
  assert.deepEqual(legacyInstructionFiles(volume), []);
  t.mock.restoreAll();
});

test('an unreadable applicable instruction still fails without publishing incomplete rules', t => {
  const { workspace } = fixture(t), file = path.join(workspace, 'AGENTS.md');
  fs.writeFileSync(file, 'Required root rule.');
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (name, options) => {
    if (name === file) throw Object.assign(new Error('Access is denied: ' + file), { code:'EACCES' });
    return read(name, options);
  });
  for (const create of [false, true]) assert.throws(() => projectInstructions(workspace, create), { code:'EACCES' });
  assert.equal(fs.existsSync(projectEntry(workspace)), false);
  t.mock.restoreAll();
});

test('canonical instructions are preserved without scanning legacy files or child projects', t => {
  const { workspace } = fixture(t), entry = path.join(workspace, 'PhasmaHarness.md');
  const body = '# Deliberate rules\nPreserve my exact text and spacing.\n';
  fs.writeFileSync(entry, body);
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'x'.repeat(65537));
  t.mock.method(fs, 'readdirSync', () => { throw new Error('Canonical reads must not scan folders'); });
  for (const create of [false, true]) {
    assert.ok(projectInstructions(workspace, create).includes(body));
    assert.equal(fs.readFileSync(entry, 'utf8'), body);
  }
  t.mock.restoreAll();
});

test('a genuinely oversized consolidation fails without writing, truncating or removing rules', t => {
  const { workspace } = fixture(t);
  for (const name of ['AGENTS.md', 'CLAUDE.md']) fs.writeFileSync(path.join(workspace, name), name + '\n' + 'x'.repeat(35000));
  const originals = fs.readdirSync(workspace).map(name => [name, fs.readFileSync(path.join(workspace, name))]);
  for (const create of [false, true]) assert.throws(() => projectInstructions(workspace, create), /Consolidated project instructions exceed/);
  assert.equal(fs.existsSync(projectEntry(workspace)), false);
  assert.deepEqual(fs.readdirSync(workspace).sort(), originals.map(([name]) => name).sort());
  for (const [name, bytes] of originals) assert.deepEqual(fs.readFileSync(path.join(workspace, name)), bytes);
});

test('instruction discovery rejects linked files and never follows directory links', t => {
  const { root, workspace } = fixture(t);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'AGENTS.md'), 'Outside rule.');
  fs.symlinkSync(outside, path.join(workspace, 'linked-project'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.doesNotMatch(projectInstructions(workspace), /Outside rule/);
  fs.linkSync(path.join(outside, 'AGENTS.md'), path.join(workspace, 'AGENTS.md'));
  for (const create of [false, true]) assert.throws(() => projectInstructions(workspace, create), /unlinked/);
  assert.equal(fs.existsSync(projectEntry(workspace)), false);
});

test('a failed write cannot publish a partial migrated entry, and old Undo initializes the shared entry', t => {
  const { workspace } = fixture(t);
  const legacy = path.join(workspace, 'INSTRUCTIONS.md');
  fs.writeFileSync(legacy, 'Keep the learned rule.');
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (file, body, options) => {
    if (String(file).endsWith('.tmp')) {
      write(file, body.slice(0, 5), options);
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    }
    return write(file, body, options);
  });
  assert.throws(() => projectEntry(workspace, true), /disk full/);
  assert.deepEqual(fs.readdirSync(workspace), ['INSTRUCTIONS.md']);
  t.mock.restoreAll();
  const current = currentProjectEntry(legacy);
  assert.match(fs.readFileSync(current, 'utf8'), /Keep the learned rule/);
  assert.equal(fs.statSync(current).nlink, 1);
});

test('legacy kept rules survive read-only loading before the first writable turn migrates the entry', t => {
  const { workspace, store } = fixture(t);
  const trials = require('../src/trials.cjs');
  const methods = require('../src/controller/trials.cjs');
  const root = store.ensure(workspace).root;
  const rule = { id: 'kept', state: 'kept', rule: 'Check empty names.', line: '- Check empty names.', check: 'unit', carried: [] };
  trials.updateRules(root, records => records.push(rule));
  fs.writeFileSync(path.join(workspace, 'INSTRUCTIONS.md'), rule.line);
  const result = methods.trialRulesFor.call({ wikiStore: store, lessonWorkspace: () => workspace }, workspace, 'names', [{ name: 'unit' }]);
  assert.deepEqual(result.keptIds, ['kept']);
  assert.equal(trials.readRules(root)[0].state, 'kept');
  assert.match(require('../src/controller/chat-scan.cjs').learnedRules(workspace, []), /Check empty names/);
  assert.equal(fs.existsSync(projectEntry(workspace)), false);
});

test('read-only initialization can read legacy rules but writes no entry or managed instruction folder', t => {
  const { workspace, store } = fixture(t);
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Read-only source rule.');
  assert.match(projectInstructions(workspace), /Read-only source rule/);
  assert.equal(fs.existsSync(projectEntry(workspace)), false);
  assert.equal(fs.existsSync(store.directory), false);
});

test('reopening keeps the workspace entry and AppData wiki outside installed application files', t => {
  const { workspace, store } = fixture(t);
  fs.writeFileSync(store.ensure(workspace).index, 'User wiki edits.');
  fs.writeFileSync(projectEntry(workspace, true), 'User instruction edits.');
  const reopened = new WikiStore(store.directory);
  assert.equal(fs.readFileSync(reopened.ensure(workspace).index, 'utf8'), 'User wiki edits.');
  assert.match(projectInstructions(workspace, true), /User instruction edits/);
  assert.equal(require('../package.json').build.nsis.deleteAppDataOnUninstall, false);
});

test('entry creation is opt-in, existing rules survive, and invalid entries are explicit errors', t => {
  const { workspace } = fixture(t);
  const file = projectEntry(workspace);
  assert.match(projectInstructions(workspace), /missing/);
  assert.equal(fs.existsSync(file), false);
  assert.ok(projectInstructions(workspace, true).includes(STARTER));
  fs.writeFileSync(file, '# Custom rules\nKeep this exactly.');
  assert.match(projectInstructions(workspace, true), /Keep this exactly/);
  assert.equal(fs.readFileSync(file, 'utf8'), '# Custom rules\nKeep this exactly.');
  fs.writeFileSync(file, 'x'.repeat(65537));
  assert.throws(() => projectInstructions(workspace, true), /exceeds/);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => projectInstructions(workspace), /regular file/);
});

test('project rules allow CLAUDE.md and AGENTS.md pointers to the shared entry', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness pointers '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'PhasmaHarness.md'), STARTER);
  const text = projectInstructions(root);
  assert.doesNotMatch(text, /recreate legacy|create parallel/i, 'bots are not told to remove or avoid pointer files');
  assert.match(text, /CLAUDE\.md or AGENTS\.md may (exist only as pointers|point) to it/);
});
