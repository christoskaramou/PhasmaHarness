const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// API-provider IDs cannot contain ':', so native adapters never shadow an existing API account.
const NATIVE_CLI_INFO = Object.freeze({
  'native:muse': { label: 'Muse Code CLI', setting: 'museEnabled', slug: 'muse-cli' },
  'native:antigravity': { label: 'Antigravity CLI', setting: 'antigravityEnabled', slug: 'antigravity-cli' },
  'native:deepseek': { label: 'DeepSeek Harness CLI', setting: 'deepseekEnabled', slug: 'deepseek-cli' },
});

function executableOnPath(name, env = process.env, platform = process.platform) {
  for (const directory of (env.PATH || '').split(path.delimiter)) {
    const file = path.join(directory, platform === 'win32' ? name + '.exe' : name);
    try { if (fs.statSync(file).isFile()) return file; } catch {}
  }
  return null;
}

// shortcut: every bot has its own native backends, so start-up searched PATH (a stat per folder) once per bot and CLI.
// The live environment's answer is kept for 10 s; a CLI installed in that window shows on the next check after it.
const recentFinds = new Map();
function findNativeCLI(id, env = process.env, platform = process.platform) {
  if (env !== process.env || platform !== process.platform)
    return searchNativeCLI(id, env, platform);

  const recent = recentFinds.get(id);
  if (recent && Date.now() - recent.at < 10000) {
    if (recent.error)
      throw recent.error;
    return recent.found;
  }

  try {
    const found = searchNativeCLI(id, env, platform);
    recentFinds.set(id, { at: Date.now(), found });
    return found;
  } catch (error) {
    recentFinds.set(id, { at: Date.now(), error });
    throw error;
  }
}

function searchNativeCLI(id, env, platform) {
  const home = env.USERPROFILE || env.HOME || os.homedir();
  const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const name = { 'antigravity-cli': 'agy', 'muse-cli': 'muse', 'deepseek-cli': 'dsh' }[id];
  if (!name) throw new Error('Unknown native provider.');
  const direct = executableOnPath(name, env, platform);
  if (direct) return { command: direct, args: [] };
  const candidates = platform === 'win32'
    ? [path.join(local, 'agy', 'bin', `${name}.exe`), path.join(local, 'Programs', name, `${name}.exe`), path.join(home, '.local', 'bin', `${name}.exe`)]
    : [path.join(home, '.local', 'bin', name), path.join(home, '.muse', 'bin', name)];
  if (id === 'muse-cli' && platform === 'win32') {
    const root = path.join(local, 'Programs', 'muse');
    try {
      const versions = fs.readdirSync(root).filter(file => /^muse-bin-[0-9].*\.exe$/.test(file))
        .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
      candidates.unshift(...versions.map(file => path.join(root, file)));
    } catch {}
  }
  for (const command of candidates) if (fs.existsSync(command)) return { command, args: [] };
  // npm's Windows shims are .cmd files, so the package script runs under the Node the shim would use: the prefix's own
  // node.exe, else Node on PATH. Harness's own Electron is the last resort: dsh's native loader accepts only the Electron
  // builds it lists, and Harness's 44.9.3 is not one (2026-10-25).
  const script = { 'deepseek-cli': ['@deepseek-ai', 'dsh', 'lib', 'bin.js'] }[id];
  if (script) {
    // Any npm prefix on PATH (a custom prefix, nvm) first, then the default ones.
    const roots = [...(env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, 'node_modules')),
      path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'npm', 'node_modules'),
      path.join(home, '.npm-global', 'lib', 'node_modules'), '/usr/local/lib/node_modules'];
    for (const root of roots) {
      const file = path.join(root, ...script);
      if (!fs.existsSync(file))
        continue;
      const prefixNode = path.join(root, '..', 'node.exe');
      const node = (platform === 'win32' && fs.existsSync(prefixNode) ? prefixNode : null) || executableOnPath('node', env, platform);
      return { command: node || process.execPath, args: [file] };
    }
  }
  const error = new Error(`${name} is not installed. Install it from Settings → Providers.`);
  error.code = 'ENOENT'; throw error;
}

function deadline(promise, milliseconds, label, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const abort = () => finish(Object.assign(new Error(`${label} stopped.`), { name: 'AbortError' }));
    const timer = setTimeout(() => finish(Object.assign(new Error(`${label} timed out; delivery was not confirmed.`), { code: 'DELIVERY_UNCERTAIN' })), milliseconds);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    Promise.resolve(promise).then(value => finish(null, value), error => finish(error));
  });
}

// Waits for a cancelled step to end. Refusing after `ms` keeps a Send now message queued (a plain error, not an
// uncertain delivery) instead of starting a second writer next to a step that may still run.
function stepStopped(promise, label, ms = 15000) {
  let timer;
  const refused = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not stop the current step. The message stays queued.`)), ms);
  });
  return Promise.race([promise.catch(() => null), refused]).finally(() => clearTimeout(timer));
}

module.exports = { findNativeCLI, executableOnPath, deadline, stepStopped, NATIVE_CLI_INFO };
