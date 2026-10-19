const { spawn, execFile } = require('node:child_process');

const npmLatest = pkg => ({ url: `https://registry.npmjs.org/${pkg}/latest`, field: 'version' });
const ANTIGRAVITY_PLATFORM = `${process.platform === 'win32' ? 'windows' : process.platform}_${process.arch === 'x64' ? 'amd64' : process.arch}`;

// Official vendor installers; each installs the newest release. `update` is used when an installer skips a CLI that is already
// installed, `latest` is where that installer reads the newest version, and `cli` prints the installed one with --version.
const INSTALLERS = {
  codex: { label: 'Codex CLI', win32: 'npm install --global @openai/codex@latest', posix: 'npm install --global @openai/codex@latest',
    cli: 'codex', latest: npmLatest('@openai/codex') },
  'claude-cli': { label: 'Claude Code CLI', win32: 'irm https://claude.ai/install.ps1 | iex', posix: 'curl -fsSL https://claude.ai/install.sh | bash',
    cli: 'claude', latest: { url: 'https://downloads.claude.ai/claude-code-releases/latest' } },
  'cursor-cli': { label: 'Cursor CLI', win32: "irm 'https://cursor.com/install?win32=true' | iex", posix: 'curl -fsS https://cursor.com/install | bash',
    cli: 'cursor-agent', latest: { url: process.platform === 'win32' ? 'https://cursor.com/install?win32=true' : 'https://cursor.com/install', pattern: /\d{4}\.\d{2}\.\d{2}-[a-f0-9]+/ } },
  'native:deepseek': { label: 'DeepSeek Harness CLI', win32: 'npm install --global @deepseek-ai/dsh@latest', posix: 'npm install --global @deepseek-ai/dsh@latest',
    cli: 'dsh', latest: npmLatest('@deepseek-ai/dsh') },
  'native:muse': { label: 'Muse Code CLI', win32: 'irm https://dev.meta.ai/install.ps1 | iex', posix: 'curl -fsSL https://dev.meta.ai/install.sh | sh',
    // The installer only replaces Muse's launcher; a synchronous launcher check downloads the new release.
    update: { win32: "$env:MUSE_SYNC_UPDATE = '1'; muse --version", posix: 'MUSE_SYNC_UPDATE=1 muse --version' },
    cli: 'muse', latest: { url: 'https://api.meta.ai/muse-code/channels/muse-stable', field: 'version' } },
  'native:antigravity': { label: 'Antigravity CLI', win32: 'irm https://antigravity.google/cli/install.ps1 | iex', posix: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    // The installer exits when agy is already installed.
    update: { win32: 'agy update', posix: 'agy update' },
    cli: 'agy', latest: { url: `https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${ANTIGRAVITY_PLATFORM}.json`, field: 'version' } },
};
const TIMEOUT_MS = 15 * 60 * 1000;
const VERSION = /\d+(?:\.\d+)+(?:-[\w.]+)?/g;

function installer(id, update = false) {
  const entry = INSTALLERS[id];
  if (!entry) throw new Error('Unknown provider.');
  const commands = update && entry.update ? entry.update : entry;
  return { label: entry.label, command: process.platform === 'win32' ? commands.win32 : commands.posix };
}

// The longest version-like token, so "Muse Code 1.4.10 (1.4.10-R6427.1)" reads as its full release.
function versionIn(text) {
  return String(text).match(VERSION)?.sort((a, b) => b.length - a.length)[0] || null;
}

function compareNumbers(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] || 0) !== (b[i] || 0))
      return (a[i] || 0) - (b[i] || 0);
  }

  return 0;
}

// True when latest is a newer release than installed: by numeric core, then a release beats its own prerelease
// (0.2.1 over 0.2.1-rc.2, never the reverse), then by the numbers in the suffix (rc.3 over rc.2, R6428 over R6427).
function newer(latest, installed) {
  const parts = version => {
    const [, core, suffix = ''] = version.match(/^(\d+(?:\.\d+)*)(?:-(.*))?$/);
    return { core: core.split('.').map(Number), suffix: (suffix.match(/\d+/g) || []).map(Number), pre: /^(?:alpha|beta|rc|pre|canary)/i.test(suffix) };
  };
  const a = parts(latest), b = parts(installed);
  const core = compareNumbers(a.core, b.core);
  if (core)
    return core > 0;
  if (a.pre !== b.pre)
    return b.pre;

  return compareNumbers(a.suffix, b.suffix) > 0;
}

async function latestVersion(id, fetcher = fetch) {
  const source = INSTALLERS[id]?.latest;
  const response = await fetcher(source.url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok)
    return null;

  const text = await response.text();
  const value = source.field ? JSON.parse(text)[source.field] : source.pattern ? text.match(source.pattern)?.[0] : text.trim();
  return typeof value === 'string' ? versionIn(value) : null;
}

function installedVersion(id, run = execFile) {
  const [file, args] = process.platform === 'win32'
    ? ['cmd.exe', ['/d', '/s', '/c', `${INSTALLERS[id].cli} --version`]]
    : ['bash', ['-lc', `${INSTALLERS[id].cli} --version`]];
  return new Promise(resolve => run(file, args, { windowsHide: true, timeout: 15000 },
    (error, stdout, stderr) => resolve(error ? null : versionIn(`${stdout}\n${stderr}`))));
}

// Installed CLIs with a newer official release, as { id: { installed, latest } }. A failed lookup means no update is offered.
async function updates(ids, { fetcher = fetch, run = execFile } = {}) {
  const found = await Promise.all(ids.map(async id => {
    const [installed, latest] = await Promise.all([installedVersion(id, run), latestVersion(id, fetcher).catch(() => null)]);
    return installed && latest && newer(latest, installed) ? [id, { installed, latest }] : null;
  }));
  return Object.fromEntries(found.filter(Boolean));
}

function killTree(child) {
  if (process.platform === 'win32') spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
}

// Resolves on exit 0; rejects on failure or timeout after stopping the whole process tree.
function run(label, file, args, { spawnProcess = spawn, timeoutMs = TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    // Own process group on POSIX so the timeout can kill installers the shell started.
    const child = spawnProcess(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let output = '', settled = false;
    const tail = () => output.trim().split(/\r?\n/).slice(-6).join(' ');
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      error ? reject(error) : resolve();
    };
    const keep = data => { output = (output + data).slice(-4000); };
    const timer = setTimeout(() => {
      killTree(child);
      child.stdout.destroy(); child.stderr.destroy();
      finish(new Error(`${label} install timed out after ${Math.round(timeoutMs / 1000)} s and was stopped. ${tail()}`));
    }, timeoutMs);
    child.stdout.on('data', keep); child.stderr.on('data', keep);
    child.once('error', error => finish(new Error(`${label} installer could not start: ${error.message}`)));
    child.once('close', code => finish(code === 0 ? null : new Error(`${label} install failed (exit ${code ?? 'killed'}). ${tail()}`)));
  });
}

function install(id, options = {}) {
  const { label, command } = installer(id, options.update);
  // pipefail/Stop: a failed download must fail the install instead of piping nothing into a successful shell.
  // Login shell on Linux so nvm/npm-global PATH setup applies when the app was launched from a desktop entry.
  const [file, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference = 'Stop'; ${command}`]]
    : ['bash', ['-lc', `set -o pipefail; ${command}`]];
  return run(label, file, args, options);
}

module.exports = { install, installer, run, INSTALLERS, updates, newer, versionIn };
