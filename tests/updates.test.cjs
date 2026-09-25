const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { checkForUpdate, installerAsset, downloadInstaller, startInstaller, INSTALL_ARGS, compareVersions, LATEST_URL, RELEASES_PAGE } = require('../src/updates.cjs');

const reply = (status, body) => async () => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('versions compare numerically and a prerelease sorts before its release', () => {
  assert.ok(compareVersions('0.10.0', '0.9.9') > 0);
  assert.equal(compareVersions('v1.2.3', '1.2.3'), 0);
  assert.ok(compareVersions('1.0.0-beta.1', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0', '1.0.0-rc.1') > 0);
  assert.throws(() => compareVersions('latest', '1.0.0'), /Cannot compare/);
});

test('update check reports a newer release with its installer and page', async () => {
  let asked;
  const result = await checkForUpdate({ current: '0.1.0', fetch: async (url, options) => {
    asked = { url, options };
    return reply(200, { tag_name: 'v0.2.0', html_url: 'https://github.com/christoskaramou/PhasmaHarness/releases/tag/v0.2.0',
      assets: [{ name: 'notes.txt' }, { name: 'Phasma-Harness-Setup-0.2.0.exe' }] })();
  } });
  assert.equal(asked.url, LATEST_URL);
  assert.equal(asked.options.headers['User-Agent'], 'Phasma-Harness');
  assert.deepEqual(result, { current: '0.1.0', latest: '0.2.0', newer: true,
    url: 'https://github.com/christoskaramou/PhasmaHarness/releases/tag/v0.2.0', installer: 'Phasma-Harness-Setup-0.2.0.exe', asset: null });
});

test('update check: same version, missing releases, odd links and failures', async () => {
  const same = await checkForUpdate({ current: '0.2.0', fetch: reply(200, { tag_name: 'v0.2.0', html_url: 'https://evil.example/x', assets: [] }) });
  assert.equal(same.newer, false);
  assert.equal(same.url, RELEASES_PAGE, 'only GitHub links are offered');
  const none = await checkForUpdate({ current: '0.1.0', fetch: reply(404, {}) });
  assert.equal(none.newer, false);
  assert.equal(none.note, 'No published release was found.');
  await assert.rejects(checkForUpdate({ current: '0.1.0', fetch: reply(403, {}) }), /rate limited/);
  await assert.rejects(checkForUpdate({ current: '0.1.0', fetch: reply(500, {}) }), /HTTP 500/);
  await assert.rejects(checkForUpdate({ current: '0.1.0', fetch: reply(200, { tag_name: 'nightly' }) }), /unexpected tag/);
  await assert.rejects(checkForUpdate({ current: '0.1.0', fetch: async () => { throw new TypeError('fetch failed'); } }), /Could not reach GitHub.*fetch failed/);
});

const DOWNLOAD = 'https://github.com/christoskaramou/PhasmaHarness/releases/download/';
const sha = data => createHash('sha256').update(data).digest('hex');
const releaseAsset = (data, extra = {}) => ({ name: 'Phasma-Harness-Setup-0.2.0.exe', size: data.length, digest: `sha256:${sha(data)}`,
  browser_download_url: `${DOWNLOAD}v0.2.0/Phasma-Harness-Setup-0.2.0.exe`, ...extra });

test('only this version\'s installer from this repository\'s downloads, with a digest, can be installed automatically', () => {
  const data = Buffer.from('installer');
  assert.deepEqual(installerAsset({ assets: [{ name: 'notes.txt' }, releaseAsset(data)] }, '0.2.0'),
    { name: 'Phasma-Harness-Setup-0.2.0.exe', url: `${DOWNLOAD}v0.2.0/Phasma-Harness-Setup-0.2.0.exe`, sha256: sha(data), size: data.length });
  assert.equal(installerAsset({ assets: [releaseAsset(data)] }, '0.3.0'), null, 'another version\'s installer');
  assert.equal(installerAsset({ assets: [releaseAsset(data, { digest: undefined })] }, '0.2.0'), null, 'no digest');
  assert.equal(installerAsset({ assets: [releaseAsset(data, { digest: 'sha1:abc' })] }, '0.2.0'), null);
  assert.equal(installerAsset({ assets: [releaseAsset(data, { browser_download_url: 'https://evil.example/Phasma-Harness-Setup-0.2.0.exe' })] }, '0.2.0'), null);
  assert.equal(installerAsset({ assets: [releaseAsset(data, { browser_download_url: 'https://github.com/someone/fork/releases/download/v0.2.0/Phasma-Harness-Setup-0.2.0.exe' })] }, '0.2.0'), null);
  assert.equal(installerAsset({ assets: [releaseAsset(data, { size: 2 * 1024 ** 3 })] }, '0.2.0'), null, 'implausible size');
});

test('the installer download keeps only a file with the release size and SHA-256', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-update-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const data = Buffer.alloc(300000, 7);
  const asset = installerAsset({ assets: [releaseAsset(data)] }, '0.2.0');
  let fetched = 0, progress = [];
  const fetch = async url => { fetched++; assert.equal(url, asset.url); return new Response(data); };
  const file = await downloadInstaller({ asset, directory, fetch, onProgress: value => progress.push(value) });
  assert.equal(file, path.join(directory, asset.name));
  assert.equal(sha(fs.readFileSync(file)), asset.sha256);
  assert.equal(progress.at(-1), 1);
  assert.equal(await downloadInstaller({ asset, directory, fetch }), file);
  assert.equal(fetched, 1, 'a verified earlier download is reused');
  fs.rmSync(file);
  await assert.rejects(downloadInstaller({ asset, directory, fetch: async () => new Response(Buffer.alloc(data.length, 8)) }), /does not match the release checksum/);
  await assert.rejects(downloadInstaller({ asset, directory, fetch: async () => new Response(Buffer.alloc(data.length + 1, 7)) }), /larger than the release says/);
  await assert.rejects(downloadInstaller({ asset, directory, fetch: async () => new Response('missing', { status: 404 }) }), /HTTP 404/);
  await assert.rejects(downloadInstaller({ asset, directory, fetch: async () => { throw new TypeError('fetch failed'); } }), /Could not download the update \(fetch failed\)/);
  assert.deepEqual(fs.readdirSync(directory), [], 'nothing unverified is left behind');
});

test('the installer starts detached and silently, and a failed start is reported', async () => {
  const calls = [];
  const fake = event => (file, args, options) => {
    const child = new EventEmitter(); child.unref = () => calls.push('unref');
    calls.push({ file, args, options }); setImmediate(() => child.emit(event, new Error('blocked by antivirus')));
    return child;
  };
  await startInstaller('C:\\setup.exe', fake('spawn'));
  assert.deepEqual(calls[0], { file: 'C:\\setup.exe', args: ['--updated', '/S', '--force-run'], options: { detached: true, stdio: 'ignore' } });
  assert.deepEqual(INSTALL_ARGS, ['--updated', '/S', '--force-run']);
  assert.equal(calls[1], 'unref');
  await assert.rejects(startInstaller('C:\\setup.exe', fake('error')), /Could not start the installer \(blocked by antivirus\)/);
});
