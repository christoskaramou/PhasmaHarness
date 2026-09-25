// Live quit test for the real app (src/main.cjs). Run with Electron on Linux:
//   xvfb-run -a npx electron --no-sandbox tests/quit-live.cjs
// Fake Codex, Claude and Cursor programs under a temporary HOME each start a child and a detached child. With a task
// "running" whose Stop fails, the window is closed and "Stop and close" chosen: the app must still quit within its time
// limit, log the failed Stop, and leave nothing the workers started running. No provider login or inference.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
if (process.platform !== 'linux') { console.log('Quit test skipped: Linux only.'); process.exit(0); }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-quit-live-'));
const pidsFile = path.join(root, 'pids');
const node = execFileSync('sh', ['-c', 'command -v node'], { encoding: 'utf8' }).trim();
const WORKER = `
const { spawn } = require('node:child_process');
if (process.argv.includes('--version')) { console.log('codex-cli 99.0.0'); process.exit(0); }
const keep = ['-e', 'setInterval(() => {}, 1000)'];
const child = spawn(process.execPath, keep, { stdio: 'ignore' });
const detached = spawn(process.execPath, keep, { stdio: 'ignore', detached: true });
detached.unref();
require('node:fs').appendFileSync(${JSON.stringify(pidsFile)}, process.pid + ' ' + child.pid + ' ' + detached.pid + '\\n');
if (process.argv.includes('app-server')) {
  const lines = require('node:readline').createInterface({ input: process.stdin });
  lines.on('line', line => { let m; try { m = JSON.parse(line); } catch { return; } if (m.method && m.id !== undefined) process.stdout.write(JSON.stringify({ id: m.id, result: {} }) + '\\n'); });
  lines.on('close', () => process.exit(0));
} else setInterval(() => {}, 1000);
`;
const bin = path.join(root, '.local', 'bin'), codex = path.join(root, '.npm-global', 'lib', 'node_modules', '@openai', 'codex', 'bin');
fs.mkdirSync(bin, { recursive: true }); fs.mkdirSync(codex, { recursive: true });
for (const name of ['claude', 'cursor-agent']) fs.writeFileSync(path.join(bin, name), `#!${node}\n${WORKER}`, { mode: 0o755 });
fs.writeFileSync(path.join(codex, 'codex.js'), WORKER);
process.env.HOME = root;
delete process.env.XDG_CONFIG_HOME;

const { app, dialog, BrowserWindow } = require('electron');
const errorBoxes = [];
dialog.showMessageBoxSync = () => 1; // "Stop and close"
dialog.showErrorBox = (title, message) => errorBoxes.push(`${title}: ${message}`);
const main = require('../src/main.cjs');

const recorded = () => (fs.existsSync(pidsFile) ? fs.readFileSync(pidsFile, 'utf8').trim().split('\n').filter(Boolean) : []);
const fail = message => {
  console.error(`Quit test failed: ${message}`);
  for (const pid of recorded().flatMap(line => line.split(' ').map(Number))) try { process.kill(pid, 'SIGKILL'); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
  app.exit(1);
};
const watchdog = setTimeout(() => fail('the app did not quit within 40 s'), 40000);
const running = pid => { try { return fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1][0] !== 'Z'; } catch { return false; } };
let closedAt = 0;

app.whenReady().then(async () => {
  // Codex starts with the app; Claude and Cursor are started through their real launch paths.
  for (let i = 0; i < 150 && (!recorded().length || !BrowserWindow.getAllWindows().length); i++) await new Promise(r => setTimeout(r, 100));
  const controller = main.controller();
  controller.claude.start([], root);
  controller.cursor.start([], root);
  for (let i = 0; i < 150 && recorded().length < 3; i++) await new Promise(r => setTimeout(r, 100));
  if (recorded().length < 3) return fail(`expected 3 fake workers (Codex, Claude, Cursor), found ${recorded().length}`);
  controller.busy = 'quit-live';
  controller.stop = () => Promise.reject(new Error('interrupt failed (quit test)'));
  closedAt = Date.now();
  BrowserWindow.getAllWindows()[0].close();
});

app.on('will-quit', () => {
  clearTimeout(watchdog);
  const pids = recorded().flatMap(line => line.split(' ').map(Number));
  const left = pids.filter(running);
  const log = fs.readFileSync(path.join(app.getPath('userData'), 'logs', 'harness.log'), 'utf8');
  const seconds = ((Date.now() - closedAt) / 1000).toFixed(1);
  for (const pid of left) try { process.kill(pid, 'SIGKILL'); } catch {}
  fs.rmSync(root, { recursive: true, force: true });
  if (errorBoxes.length) return fail(`an error box blocked closing: ${errorBoxes.join('; ')}`);
  if (!/Stop failed during shutdown/.test(log)) return fail('the failed Stop was not logged');
  if (left.length) return fail(`${left.length} of ${pids.length} worker processes were still running`);
  console.log(`Quit test passed: ${pids.length} worker processes, none left; quit ${seconds} s after closing`);
});
