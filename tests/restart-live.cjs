// Live restart test for the real app (src/main.cjs): /restart and harness_restart end in agents.restart, and the app must
// start again by itself (2026-11-24: on Windows it closed and stayed closed). Run with Node; it starts Electron itself:
//   xvfb-run -a node tests/restart-live.cjs        (Linux; no xvfb-run where a display exists, as under WSLg)
// The first app asks for a restart once its window exists; the second one, started by that restart, reports and quits.
// A temporary HOME and data folder: no provider login, no inference, the installed app is untouched.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

if (!process.versions.electron) {
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-restart-live-'));
  const read = name => { try { return fs.readFileSync(path.join(root, name), 'utf8'); } catch { return null; } };
  const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
  const child = spawn(require('electron'), [...(process.platform === 'linux' ? ['--no-sandbox'] : []), __filename],
    { stdio: 'inherit', env: { ...process.env, HOME: root, USERPROFILE: root, PHASMA_HARNESS_DATA_DIR: path.join(root, 'data'), HARNESS_RESTART_LIVE: root } });
  (async () => {
    let second;
    for (let i = 0; i < 900 && !(second = read('second')); i++) await new Promise(resolve => setTimeout(resolve, 100));
    const first = read('first');
    try {
      if (!first) throw new Error('The app never asked for its restart.');
      if (!second) throw new Error(`The app (pid ${first}) asked for a restart and no second app started within 90 s.`);
      if (first === second) throw new Error('The same process reported twice.');
      for (let i = 0; i < 100 && alive(Number(first)); i++) await new Promise(resolve => setTimeout(resolve, 100));
      if (alive(Number(first))) throw new Error('The first app is still running.');
      console.log(`Restart passed: app ${first} closed and app ${second} started by itself.`);
    } catch (error) { console.error('Restart FAILED: ' + error.message); process.exitCode = 1; }
    finally {
      if (child.exitCode === null) child.kill();
      for (let i = 0; i < 100 && second && alive(Number(second)); i++) await new Promise(resolve => setTimeout(resolve, 100));
      const log = read(path.join('data', 'logs', 'harness.log'));
      if (process.exitCode && log) console.error(log.split('\n').slice(-15).join('\n'));
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  })();
} else {
  const root = process.env.HARNESS_RESTART_LIVE;
  const { app, BrowserWindow } = require('electron');
  const main = require('../src/main.cjs');
  const ready = () => main.controller()?.agents?.restart && BrowserWindow.getAllWindows().length;
  const wait = setInterval(() => {
    if (!ready()) return;
    clearInterval(wait);
    if (fs.existsSync(path.join(root, 'first'))) {
      fs.writeFileSync(path.join(root, 'second'), String(process.pid));
      setTimeout(() => app.quit(), 500);
    } else {
      fs.writeFileSync(path.join(root, 'first'), String(process.pid));
      setTimeout(() => main.controller().agents.restart('live test'), 2000);
    }
  }, 200);
}
