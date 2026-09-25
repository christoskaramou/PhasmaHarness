const test = require('node:test');
const assert = require('node:assert/strict');
const { checkForUpdate, compareVersions, LATEST_URL, RELEASES_PAGE } = require('../src/updates.cjs');

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
    url: 'https://github.com/christoskaramou/PhasmaHarness/releases/tag/v0.2.0', installer: 'Phasma-Harness-Setup-0.2.0.exe' });
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
