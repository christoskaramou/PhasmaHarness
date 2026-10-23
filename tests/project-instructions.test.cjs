const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectInstructions, projectEntry, currentProjectEntry, STARTER } = require('../src/workspace/project-instructions.cjs');
const { WikiStore } = require('../src/workspace/wiki-store.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const workspace = path.join(root, 'source');
  fs.mkdirSync(workspace);
  return { root, workspace, store: new WikiStore(path.join(root, 'AppData', 'Wikis')) };
}

test('one workspace entry preserves scoped legacy rules once, deduplicates mirrors and ignores later legacy edits', t => {
  const { workspace } = fixture(t);
  fs.mkdirSync(path.join(workspace, 'Engine'));
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'HERMES.md']) fs.writeFileSync(path.join(workspace, name), 'Shared amberquartz rule.');
  fs.writeFileSync(path.join(workspace, 'Engine', 'INSTRUCTIONS.md'), 'Scoped copperfalcon rule.');
  fs.mkdirSync(path.join(workspace, '.cursor', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.cursor', 'rules', 'quality.mdc'), '---\nalwaysApply: true\n---\nCursor quality rule.');
  fs.writeFileSync(path.join(workspace, 'manual.md'), 'Ordinary documentation.');
  const initial = projectInstructions(workspace, true);
  assert.equal(initial.match(/Shared amberquartz rule/g).length, 1);
  assert.match(initial, /Workspace scope: Engine[\s\S]*Scoped copperfalcon/);
  assert.doesNotMatch(initial, /Ordinary documentation/);
  assert.match(initial, /Workspace scope: \.\n\nImported from: \.cursor\/rules\/quality.mdc[\s\S]*Cursor quality rule/);
  assert.equal(projectEntry(workspace), path.join(workspace, 'PhasmaHarness.md'));
  assert.equal(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8'), 'Shared amberquartz rule.', 'automatic initialization never deletes originals');
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Stale legacy rule.');
  assert.doesNotMatch(projectInstructions(workspace), /Stale legacy rule/);
  for (const name of ['AGENTS.md', 'CLAUDE.md', 'HERMES.md', 'Engine/INSTRUCTIONS.md']) fs.unlinkSync(path.join(workspace, name));
  assert.match(projectInstructions(workspace, true), /Scoped copperfalcon/);
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
