const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { projectInstructions, STARTER } = require('../src/workspace/project-instructions.cjs');

test('entry creation is opt-in, existing rules survive, and invalid entries are explicit errors', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-entry-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'INSTRUCTIONS.md');
  assert.match(projectInstructions(root), /missing/);
  assert.equal(fs.existsSync(file), false);
  assert.ok(projectInstructions(root, true).includes(STARTER));
  fs.writeFileSync(file, '# Custom rules\nKeep this exactly.');
  assert.match(projectInstructions(root, true), /Keep this exactly/);
  assert.equal(fs.readFileSync(file, 'utf8'), '# Custom rules\nKeep this exactly.');
  fs.writeFileSync(file, 'x'.repeat(65537));
  assert.throws(() => projectInstructions(root, true), /exceeds/);
  fs.unlinkSync(file);
  fs.mkdirSync(file);
  assert.throws(() => projectInstructions(root), /regular file/);
});
