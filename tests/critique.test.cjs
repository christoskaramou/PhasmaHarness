'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { taskChanges, critiqueInput, checkCritique, revisionText, escalationText, CHANGES_LIMIT, MAX_FINDINGS } = require('../src/critique.cjs');

const section = (file, body) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1,2 +1,2 @@\n${body}\n`;

test('a task\'s changes leave private files out, keep new text files, skip binary ones and stop at the size limit', t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-critique-unit-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.writeFileSync(path.join(workspace, 'new.js'), 'const a = 1;\nconst b = 2;');
  fs.writeFileSync(path.join(workspace, 'image.bin'), Buffer.from([1, 0, 2]));
  const patch = section('src/a.js', '-old\n+new') + section('.env', '-A=1\n+A=2') + section('config/secrets.json', '+{}');

  const { changes, truncated } = taskChanges(patch, ['new.js', 'image.bin', 'missing.js'], workspace);
  assert.deepEqual(changes.map(change => change.file), ['src/a.js', 'new.js']);
  assert.match(changes[1].text, /^New file new\.js\n\+const a = 1;\n\+const b = 2;$/);
  assert.equal(truncated, false);

  const big = section('big.js', '+' + 'x'.repeat(11000));
  const many = taskChanges(Array.from({ length: 8 }, () => big).join(''), [], workspace);
  assert.equal(many.truncated, true);
  assert.ok(many.changes.reduce((size, change) => size + change.text.length, 0) <= CHANGES_LIMIT);
});

test('a finding counts only when it quotes the reply or a file it was shown, verbatim, and never asks to weaken tests', () => {
  const changes = { changes: [{ file: 'src/a.js', text: section('src/a.js', '-  return items[items.length];\n+  return items[items.length - 1];\n+  // next') }], truncated: false };
  const task = { goal: 'Fix last()', attempts: [{ results: [{ name: 'unit', status: 'passed' }] }] };
  const input = critiqueInput(task, changes, 'Fixed it so last() returns the final item.\n\n[task: done]');
  const shown = JSON.parse(input.prompt);
  assert.equal(shown.reply, 'Fixed it so last() returns the final item.', 'the status line is not part of the reply');
  assert.equal(shown.checks, 'all passed: unit');
  assert.equal(JSON.parse(critiqueInput({ goal: 'Fix last()' }, { changes: [], truncated: false }, 'Done.').prompt).checks, 'none ran');

  const finding = (source, quote, problem = 'Empty lists return undefined.') => ({ source, quote, problem });
  const result = checkCritique({ verdict: 'revise', findings: [
    finding('src/a.js', 'return items[items.length - 1];\n// next'),
    finding('src/a.js', 'RETURN   items[items.length - 1];'),
    finding('reply', 'returns the final item'),
    finding('src/a.js', 'return items.at(-1);'),
    finding('src/b.js', 'return items[items.length - 1];'),
    finding('src/a.js', 'items'),
    finding('src/a.js', 'return items[items.length - 1];', 'Skip the unit tests for this file.'),
  ] }, input);
  assert.deepEqual(result.findings.map(item => item.quote), ['return items[items.length - 1]; // next', 'RETURN items[items.length - 1];', 'returns the final item'],
    'diff markers, whitespace and case aside; another file, an absent quote, a short quote and weakening tests are dropped');
  assert.deepEqual([result.verdict, result.dropped], ['revise', 4]);

  const capped = checkCritique({ verdict: 'revise', findings: Array.from({ length: 8 }, () => finding('src/a.js', 'return items[items.length - 1];')) }, input);
  assert.equal(capped.findings.length, MAX_FINDINGS);
  assert.deepEqual(checkCritique({ verdict: 'escalate', findings: [finding('src/a.js', 'return items.at(-1);')] }, input),
    { verdict: 'accept', findings: [], dropped: 1 }, 'an escalate with nothing grounded is an accept');
  assert.deepEqual(checkCritique({ verdict: 'accept', findings: [finding('src/a.js', 'return items[items.length - 1];')] }, input).findings, []);
  assert.deepEqual(checkCritique(null, input), { verdict: 'accept', findings: [], dropped: 0 });

  assert.match(revisionText('terra', result.findings), /^A checker model \(terra\) read your response[\s\S]*- src\/a\.js: Empty lists return undefined\.\n {2}Quote: return items/);
  assert.match(escalationText('terra', result.findings), /^A checker model \(terra\) read its response and found:\n- src\/a\.js/);
});
