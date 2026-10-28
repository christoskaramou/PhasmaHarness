const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { resolve, open, image } = require('../src/workspace/linked-files.cjs');

async function workspace(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'harness-links-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'src'));
  for (const name of ['src/main.cjs', 'notes.md', 'run.bat', 'shot.png']) await fs.writeFile(path.join(root, name), name === 'shot.png' ? Buffer.from([137, 80, 78, 71]) : 'x');
  return root;
}

test('chat link targets resolve relative, absolute and file: forms without their line suffix', async t => {
  const root = await workspace(t), main = path.join(root, 'src', 'main.cjs');
  assert.equal(await resolve(root, 'src/main.cjs:114'), main);
  assert.equal(await resolve(root, 'src/main.cjs:114:7'), main);
  assert.equal(await resolve(root, 'src/main.cjs#L5-L9'), main);
  assert.equal(await resolve(null, main + ':3'), main);
  assert.equal(await resolve(null, pathToFileURL(main).href + ':3'), main);
  if (process.platform === 'win32') assert.equal(await resolve(null, '/' + main.replace(/\\/g, '/')), main);
  await assert.rejects(resolve(root, 'missing.md'), /File not found/);
  await assert.rejects(resolve(null, 'notes.md'), /Choose a workspace/);
});

test('chat links never reach network paths', async t => {
  const root = await workspace(t);
  for (const target of ['\\\\attacker\\share\\x.png', '//attacker/share/x.png', 'file://attacker/share/x.png', '\\\\?\\C:\\x.png'])
    await assert.rejects(resolve(root, target), /Network paths|Invalid/, target);
});

test('documents open, scripts are only shown in their folder, and failed opens fall back to the folder', async t => {
  const root = await workspace(t), calls = [];
  const shell = { openPath: async file => { calls.push(['open', file]); return path.basename(file) === 'shot.png' ? 'No app' : ''; },
    showItemInFolder: file => calls.push(['show', file]) };
  for (const target of ['notes.md', 'run.bat', 'src', 'shot.png']) await open(root, target, shell);
  assert.deepEqual(calls.map(([kind, file]) => [kind, path.relative(root, file)]),
    [['open', 'notes.md'], ['show', 'run.bat'], ['open', 'src'], ['open', 'shot.png'], ['show', 'shot.png']]);
});

test('browser access gets workspace files back to show and never reaches outside the workspace', async t => {
  const root = await workspace(t), outside = await workspace(t);
  assert.deepEqual(await open(root, path.join(root, 'src', 'main.cjs') + ':114', null), { path: 'src/main.cjs' });
  assert.deepEqual(await open(root, 'run.bat', null), { path: 'run.bat' }, 'shown as text on the page, never run');
  await assert.rejects(open(root, 'src', null), /folders/);
  await assert.rejects(open(root, path.join(outside, 'notes.md'), null), /inside the workspace/);
  await assert.rejects(open(root, '../' + path.basename(outside) + '/notes.md', null), /inside the workspace/);
  await assert.rejects(open(null, path.join(outside, 'notes.md'), null), /inside the workspace/);
  assert.match(await image(root, 'shot.png', true), /^data:image\/png;base64,/);
  await assert.rejects(image(root, path.join(outside, 'shot.png'), true), /inside the workspace/);
});

test('linked images load as data URLs and other files do not', async t => {
  const root = await workspace(t);
  assert.equal(await image(root, 'shot.png'), 'data:image/png;base64,iVBORw==');
  await assert.rejects(image(root, 'notes.md'), /Not an image/);
});
