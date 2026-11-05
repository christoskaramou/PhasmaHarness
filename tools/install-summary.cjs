// Installer report (src/install.ps1, install-linux.sh): which programs and packages were installed or skipped, with versions.
//   node tools/install-summary.cjs electron-cache       prints "cached" or "download" for the pinned Electron runtime
//   node tools/install-summary.cjs report key=status...  prints the summary; statuses come from the installer
//                                                        (node, git: "installed" or "present"; mode: "desktop" or "headless")
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const installedVersion = name => read(path.join(ROOT, 'node_modules', ...name.split('/'), 'package.json'))?.version || null;
const run = (command, args) => {
  // npm is npm.cmd on Windows, which only cmd.exe runs (the args here are fixed, never user input).
  const [file, list] = process.platform === 'win32' && command === 'npm' ? ['cmd.exe', ['/d', '/c', 'npm', ...args]] : [command, args];
  try { return execFileSync(file, list, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};

function electronCache() {
  const version = installedVersion('electron');
  const cache = process.env.ELECTRON_CACHE;
  const find = directory => {
    let entries = [];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return false; }
    return entries.some(entry => entry.isDirectory() ? find(path.join(directory, entry.name))
      : entry.name === `electron-v${version}-${process.platform}-${process.arch}.zip`);
  };
  console.log(version && cache && find(cache) ? 'cached' : 'download');
}

function report(args) {
  const status = Object.fromEntries(args.map(arg => arg.split('=')));
  const headless = status.mode === 'headless';
  const pkg = read(path.join(ROOT, 'package.json'));
  const lock = read(path.join(ROOT, 'package-lock.json'));
  const word = value => value === 'installed' ? 'installed now' : value === 'updated' ? 'updated now' : 'already installed, skipped';
  const lines = ['', 'Installed versions', `  Phasma Harness ${pkg.version}`,
    `  Node.js ${process.version} (${word(status.node)}), npm ${run('npm', ['--version']) || 'unknown'}`];
  const git = run('git', ['--version']);
  if (git) lines.push(`  Git ${git.replace(/^git version /, '')} (${word(status.git)})`);

  if (!headless) {
    const electron = installedVersion('electron');
    lines.push(`  Electron ${electron || 'missing'} (${status.electron === 'cached' ? 'runtime from the installer cache, download skipped' : 'runtime downloaded now'})`);
  }
  const tools = read(path.join(ROOT, 'tools', 'bin', 'last-install.json')) || {};
  const manifest = read(path.join(ROOT, 'tools', 'manifest.json')) || {};
  const names = { rtk: 'RTK', rg: 'ripgrep' };
  for (const [name, tool] of Object.entries(manifest))
    lines.push(`  ${names[name] || name} ${tool.version} (bundled tool, ${tools[name] === 'installed' ? 'installed now' : 'already installed and verified, skipped'})`);

  // npm ci always reinstalls every locked package, so none are skipped; the headless runner leaves out dev packages.
  const total = Object.keys(lock?.packages || {}).filter(key => key.startsWith('node_modules/'));
  const present = total.filter(key => fs.existsSync(path.join(ROOT, key)));
  lines.push(`  App packages: ${present.length} of ${total.length} in the lockfile installed from it${present.length < total.length ? `, ${total.length - present.length} skipped (${headless ? 'builds for other platforms, or dev packages' : 'builds for other platforms'})` : ''}`);
  for (const [group, list] of [['App libraries', pkg.dependencies], ['Developer packages', pkg.devDependencies]]) {
    const entries = Object.keys(list || {}).map(name => [name, installedVersion(name)]);
    const installed = entries.filter(([, version]) => version).map(([name, version]) => `${name} ${version}`);
    const skipped = entries.filter(([, version]) => !version).map(([name]) => `${name} ${list[name]}`);
    if (installed.length) lines.push(`  ${group}: ${installed.join(', ')}`);
    if (skipped.length) lines.push(`  ${group} skipped${headless ? ' (not needed by the headless runner)' : ''}: ${skipped.join(', ')}`);
  }
  console.log(lines.join('\n') + '\n');
}

const [command, ...rest] = process.argv.slice(2);
if (command === 'electron-cache') electronCache();
else if (command === 'report') report(rest);
else { console.error('Usage: install-summary.cjs electron-cache | report key=status...'); process.exit(2); }
