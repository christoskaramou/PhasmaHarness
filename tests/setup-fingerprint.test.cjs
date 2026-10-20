const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setupFingerprint, folderHash, checksHash } = require('../src/setup-fingerprint.cjs');

test('the same setup hashes the same in any key order, and any change changes it', () => {
  const one = setupFingerprint({ provider: 'codex', model: 'm', tools: { helpers: true, context: false } });
  const two = setupFingerprint({ tools: { context: false, helpers: true }, model: 'm', provider: 'codex' });
  assert.equal(one.hash, two.hash);
  assert.equal(one.v, 1);
  assert.notEqual(setupFingerprint({ provider: 'codex', model: 'other', tools: { helpers: true, context: false } }).hash, one.hash);
});

test('editing any file of a skill folder changes its hash', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-skill-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'scripts'));
  fs.writeFileSync(path.join(root, 'SKILL.md'), 'Rules.');
  fs.writeFileSync(path.join(root, 'scripts', 'run.cjs'), 'one');
  const before = folderHash(root);
  assert.equal(folderHash(root), before);
  fs.writeFileSync(path.join(root, 'scripts', 'run.cjs'), 'two!');
  assert.notEqual(folderHash(root), before);
  assert.equal(folderHash(path.join(root, 'missing')), null);
});

test('the same checks in two batch copies hash the same; different checks do not', () => {
  const copy = workspace => [{ name: 'build', kind: 'build', timeoutMs: 30000, argv: ['node', path.join(workspace, 'build.cjs')] }];
  const first = path.join(os.tmpdir(), 'jobs', 'batch', '1'), second = path.join(os.tmpdir(), 'jobs', 'batch', '2');
  assert.equal(checksHash(copy(first), first), checksHash(copy(second), second));
  assert.notEqual(checksHash(copy(first), first), checksHash([{ ...copy(first)[0], timeoutMs: 60000 }], first));
  assert.equal(checksHash([], first), null);
});

test('a project-path check remapped into two batch copies by copyChecks keeps one hash', t => {
  const { Agents } = require('../src/agents.cjs');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-check-copies-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  fs.mkdirSync(source);
  const configured = [{ name: 'build', kind: 'build', argv: [process.execPath, path.join(source, 'check.cjs'), 'build'], cwd: source, timeoutMs: 30000 }];
  const hashes = ['1', '2'].map(index => {
    const copy = { workspace: path.join(root, 'jobs', index), source };
    fs.mkdirSync(copy.workspace, { recursive: true });
    const checks = Agents.prototype.copyChecks.call({}, copy, configured);
    assert.equal(checks[0].argv[1], path.join(copy.workspace, 'check.cjs'), 'the command now points into the copy');
    return checksHash(checks, copy.workspace);
  });
  assert.ok(hashes[0]);
  assert.equal(hashes[0], hashes[1]);
});
