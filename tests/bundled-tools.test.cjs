const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HELPER = path.resolve(__dirname, '../skills/large-responses/scripts/output.cjs');
const helper = (...args) => spawnSync(process.execPath, [HELPER, ...args], { encoding: 'utf8' });

test('manifest pins hash-checked RTK and ripgrep builds for Windows and Linux', () => {
  const manifest = require('../tools/manifest.json');
  assert.deepEqual(Object.keys(manifest).sort(), ['rg', 'rtk']);
  for (const tool of Object.values(manifest)) for (const platform of ['win32-x64', 'linux-x64', 'linux-arm64']) {
    const build = tool.builds[platform];
    assert.match(build.url, /^https:\/\/github\.com\/[\w-]+\/[\w-]+\/releases\/download\//);
    assert.ok(build.url.includes(tool.version));
    assert.match(build.sha256, /^[0-9a-f]{64}$/);
  }
});

test('large-response helper reads, searches and captures without Python', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-output-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'build.log');
  fs.writeFileSync(log, Array.from({ length: 200 }, (_, i) => i === 150 ? 'error LNK2019: unresolved symbol Foo' : `line ${i + 1}`).join('\n'));

  const read = JSON.parse(helper('read', log, '--line', '10', '--count', '2').stdout);
  assert.deepEqual(read.excerpts.map(e => [e.line, e.text]), [[10, 'line 10'], [11, 'line 11']]);
  assert.equal(read.moreMayExist, true);

  const search = JSON.parse(helper('search', log, '--query', 'unresolved LNK2019').stdout);
  assert.ok(search.excerpts.some(e => e.line === 151 && e.text.includes('LNK2019')));

  const failed = helper('capture', '--', process.execPath, '-e', 'console.log("out"); process.exit(3)');
  assert.equal(failed.status, 3);
  const captured = JSON.parse(failed.stdout);
  assert.equal(captured.exitCode, 3);
  assert.equal(fs.readFileSync(captured.stdout.source, 'utf8').trim(), 'out');
  fs.rmSync(path.dirname(captured.stdout.source), { recursive: true, force: true });

  const bad = helper('search', log);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /needs --query/);
});
