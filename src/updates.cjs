// Manual update check against the project's GitHub releases. Nothing is downloaded or installed:
// the result only says whether a newer release exists and links to its page.
const REPOSITORY = 'christoskaramou/PhasmaHarness';
const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases`;
const LATEST_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;

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
  // A private repository answers 404 to anonymous requests, the same as one with no releases.
  if (response.status === 404) return { current, latest: null, newer: false, url: RELEASES_PAGE, note: 'No published release was found. The repository may be private or has no releases yet.' };
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
  };
}

module.exports = { checkForUpdate, compareVersions, parseVersion, RELEASES_PAGE, LATEST_URL };
