const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectRules, loadsRulesItself } = require('../src/workspace/project-instructions.cjs');

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-rules-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('project rules are the root AGENTS.md, read fresh, never a subfolder copy, and nothing is written', t => {
  const root = workspace(t);
  assert.equal(projectRules(root), '');
  fs.mkdirSync(path.join(root, 'child'));
  fs.writeFileSync(path.join(root, 'child', 'AGENTS.md'), 'Child rule.');
  fs.writeFileSync(path.join(root, 'CLAUDE.md'), 'Claude-only rule.');
  assert.equal(projectRules(root), '', 'only the root AGENTS.md counts');

  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Rule one.');
  assert.equal(projectRules(root), 'Rule one.');
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Rule two.');
  assert.equal(projectRules(root), 'Rule two.', 'an edit shows on the next read');
  assert.deepEqual(fs.readdirSync(root).sort(), ['AGENTS.md', 'CLAUDE.md', 'child']);
});

test('an oversized or non-file AGENTS.md points the bot at the file instead of failing the turn', t => {
  const root = workspace(t);
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'x'.repeat(64 * 1024 + 1));
  assert.match(projectRules(root), /over 64 KiB.*read .*AGENTS\.md/);

  fs.rmSync(path.join(root, 'AGENTS.md'));
  fs.mkdirSync(path.join(root, 'AGENTS.md'));
  assert.equal(projectRules(root), '');
});

test('Harness passes AGENTS.md only to bots that do not load it themselves', t => {
  const root = workspace(t);
  for (const provider of ['codex', 'cursor-cli', 'native:antigravity', 'native:deepseek'])
    assert.equal(loadsRulesItself(provider, root), true, provider);

  for (const provider of ['native:muse', 'deepseek', 'claude-cli', undefined])
    assert.equal(loadsRulesItself(provider, root), false, String(provider));

  fs.writeFileSync(path.join(root, 'CLAUDE.md'), '@AGENTS.md\n');
  assert.equal(loadsRulesItself('claude-cli', root), true, 'Claude Code loads CLAUDE.md, which imports AGENTS.md');
});

test('Harness data stays in AppData across reinstalls', () => {
  assert.equal(require('../package.json').build.nsis.deleteAppDataOnUninstall, false);
});
