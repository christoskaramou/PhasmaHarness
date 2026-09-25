// Update check against the project's GitHub releases, and the pieces of an automatic update: the release's installer is
// downloaded only from this repository's release downloads, kept only if its size and SHA-256 match what GitHub
// reports for the asset, and run silently (see src/updater.cjs, which decides when).
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable, Transform } = require('node:stream');
const REPOSITORY = 'christoskaramou/PhasmaHarness';
const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;
const LATEST_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const DOWNLOADS = `https://github.com/${REPOSITORY}/releases/download/`;
const MAX_INSTALLER_BYTES = 1024 ** 3;
// electron-builder's NSIS installer: --updated keeps app data while replacing the old version, /S installs silently into
// the existing location, --force-run starts the new version when it is done.
const INSTALL_ARGS = ['--updated', '/S', '--force-run'];

function parseVersion(value) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value || '').trim());
  return match ? { parts: match.slice(1, 4).map(Number), pre: match[4] || '' } : null;
}

// Negative when a < b, 0 when equal, positive when a > b. A prerelease sorts before its release.
function compareVersions(a, b) {
  const left = parseVersion(a), right = parseVersion(b);
  if (!left || !right) throw new Error(`Cannot compare versions ${a} and ${b}.`);
  for (let i = 0; i < 3; i++) if (left.parts[i] !== right.parts[i]) return left.parts[i] - right.parts[i];
  if (left.pre === right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  return left.pre < right.pre ? -1 : 1;
}

async function checkForUpdate({ current, fetch, timeoutMs = 10000 }) {
  let response;
  try {
    response = await fetch(LATEST_URL, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Phasma-Harness' },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error(`Could not reach GitHub to check for updates (${error?.name === 'TimeoutError' ? 'timed out' : error?.message || 'network error'}).`);
  }
  if (response.status === 404) return { current, latest: null, newer: false, url: RELEASES_PAGE, note: 'No published release was found.' };
  if (response.status === 403 || response.status === 429) throw new Error('GitHub refused the update check (rate limited). Try again later.');
  if (!response.ok) throw new Error(`Update check failed (HTTP ${response.status}).`);
  const release = await response.json();
  const latest = String(release.tag_name || '').replace(/^v/, '');
  if (!parseVersion(latest)) throw new Error(`The latest release has an unexpected tag (${release.tag_name || 'none'}).`);
  const installer = (release.assets || []).find(asset => /\.exe$/i.test(asset.name || ''));
  return {
    current, latest, newer: compareVersions(latest, current) > 0,
    url: /^https:\/\/github\.com\//.test(release.html_url || '') ? release.html_url : RELEASES_PAGE,
    installer: installer?.name || null,
    asset: installerAsset(release, latest),
  };
}

// The installer an automatic update may download: this version's setup file, served from this repository's release
// downloads, with a SHA-256 digest and a plausible size. Anything else is only linked, never downloaded.
function installerAsset(release, version) {
  const asset = (release.assets || []).find(item => item?.name === `Phasma-Harness-Setup-${version}.exe`);
  const sha256 = /^sha256:([0-9a-f]{64})$/.exec(asset?.digest || '')?.[1];
  const url = String(asset?.browser_download_url || '');
  if (!sha256 || url !== DOWNLOADS + `v${version}/${asset.name}` || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_INSTALLER_BYTES) return null;
  return { name: asset.name, url, sha256, size: asset.size };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    fs.createReadStream(file).on('error', reject).on('data', chunk => hash.update(chunk)).on('end', () => resolve(hash.digest('hex')));
  });
}

// Streams the installer into directory while hashing it. Only a file with the asset's exact size and SHA-256 is kept;
// anything else is deleted. A verified copy from an earlier attempt is reused.
async function downloadInstaller({ asset, directory, fetch, onProgress = () => {}, signal }) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, asset.name), partial = file + '.partial';
  if (await sha256File(file).catch(() => null) === asset.sha256) return file;
  fs.rmSync(file, { force: true });
  let response;
  try { response = await fetch(asset.url, { headers: { 'User-Agent': 'Phasma-Harness' }, signal }); }
  catch (error) { throw new Error(`Could not download the update (${error?.name === 'AbortError' ? 'stopped' : error?.message || 'network error'}).`); }
  if (!response.ok || !response.body) throw new Error(`Could not download the update (HTTP ${response.status}).`);
  const hash = createHash('sha256');
  let received = 0;
  const meter = new Transform({ transform(chunk, _encoding, done) {
    received += chunk.length;
    if (received > asset.size) { done(new Error('The download is larger than the release says.')); return; }
    hash.update(chunk); onProgress(received / asset.size); done(null, chunk);
  } });
  try { await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(partial), ...(signal ? [{ signal }] : [])); }
  catch (error) { fs.rmSync(partial, { force: true }); throw new Error(`Could not download the update (${error.message}).`); }
  if (received !== asset.size || hash.digest('hex') !== asset.sha256) {
    fs.rmSync(partial, { force: true });
    throw new Error('The downloaded installer does not match the release checksum, so it was deleted.');
  }
  fs.renameSync(partial, file);
  return file;
}

// Starts the installer detached, so it outlives this app, and resolves once Windows has started it.
function startInstaller(file, spawnFn = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnFn(file, INSTALL_ARGS, { detached: true, stdio: 'ignore' });
    child.once('error', error => reject(new Error(`Could not start the installer (${error.message}).`)));
    child.once('spawn', () => { child.unref(); resolve(); });
  });
}

module.exports = { checkForUpdate, installerAsset, downloadInstaller, startInstaller, compareVersions, parseVersion, RELEASES_PAGE, LATEST_URL, INSTALL_ARGS };
