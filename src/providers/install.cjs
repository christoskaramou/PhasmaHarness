const { spawn } = require('node:child_process');

// Official vendor installers. Codex is pinned to the app-server version the Harness is tested with; bump it here only.
const CODEX_VERSION = '0.156.1';
const INSTALLERS = {
  codex: { label: 'Codex CLI', win32: `npm install --global @openai/codex@${CODEX_VERSION}`, posix: `npm install --global @openai/codex@${CODEX_VERSION}` },
  'claude-cli': { label: 'Claude Code', win32: 'irm https://claude.ai/install.ps1 | iex', posix: 'curl -fsSL https://claude.ai/install.sh | bash' },
  'cursor-cli': { label: 'Cursor CLI', win32: "irm 'https://cursor.com/install?win32=true' | iex", posix: 'curl -fsS https://cursor.com/install | bash' },
};
const TIMEOUT_MS = 15 * 60 * 1000;

function installer(id) {
  const entry = INSTALLERS[id];
  if (!entry) throw new Error('Unknown provider.');
  return { label: entry.label, command: process.platform === 'win32' ? entry.win32 : entry.posix };
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

function install(id, options) {
  const { label, command } = installer(id);
  // pipefail/Stop: a failed download must fail the install instead of piping nothing into a successful shell.
  // Login shell on Linux so nvm/npm-global PATH setup applies when the app was launched from a desktop entry.
  const [file, args] = process.platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `$ErrorActionPreference = 'Stop'; ${command}`]]
    : ['bash', ['-lc', `set -o pipefail; ${command}`]];
  return run(label, file, args, options);
}

module.exports = { install, installer, run, INSTALLERS, CODEX_VERSION };
