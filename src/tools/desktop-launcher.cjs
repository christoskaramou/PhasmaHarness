'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');

const MAX_PATH = 1000;
const MAX_ARGS = 64;
const MAX_ARG_LEN = 2000;
const MAX_WAIT_MS = 15000;
const DEFAULT_WAIT_MS = 3000;

const STRIPPED_ENV = new Set([
  'electron_run_as_node',
  'phasma_bridge_url',
  'phasma_bridge_token',
  'phasma_session_id',
]);

const TOOL = {
  type: 'function',
  name: 'launch_desktop_app',
  description:
    'Launch a local desktop GUI executable directly from the Phasma Harness host process on the user\'s interactive desktop (outside isolated agent shells such as Antigravity exebox), keeping the window open after the turn ends. Full access only. Pass `executable` (and optional `args`, `cwd`, `waitForWindowMs`) to launch, or pass `pid` alone to check whether a previously launched desktop app is still running with a visible window.',
  inputSchema: {
    type: 'object',
    properties: {
      executable: { type: 'string', minLength: 1, maxLength: MAX_PATH, description: 'Path to an existing executable file (resolved against workspace if relative).' },
      args: { type: 'array', maxItems: MAX_ARGS, items: { type: 'string', maxLength: MAX_ARG_LEN }, description: 'Explicit argument list passed with shell=false.' },
      cwd: { type: 'string', minLength: 1, maxLength: MAX_PATH, description: 'Working directory (defaults to the executable\'s parent directory).' },
      waitForWindowMs: { type: 'integer', minimum: 0, maximum: MAX_WAIT_MS, description: 'Optional ms to wait for a visible host window (default 3000 on Windows).' },
      pid: { type: 'integer', minimum: 1, description: 'Read-only status check for a PID previously started by launch_desktop_app.' },
    },
    additionalProperties: false,
  },
};

const INSTRUCTIONS =
  ' When the user asks to open a desktop GUI app visibly on their screen and your shell runs in an isolated/hidden desktop (such as Antigravity exebox), use launch_desktop_app (Full access only) so Harness launches it directly on the user\'s Default desktop and keeps it open across turns.';

const launchedPids = new Set();

function cleanEnvironment(baseEnv = process.env) {
  return Object.fromEntries(
    Object.entries(baseEnv).filter(([key]) => !STRIPPED_ENV.has(key.toLowerCase())),
  );
}

function resolveExistingPath(raw, workspace, label) {
  if (typeof raw !== 'string' || !raw.trim() || raw.length > MAX_PATH) {
    throw new Error(`Invalid ${label}.`);
  }
  const trimmed = raw.trim();
  return path.isAbsolute(trimmed) ? path.normalize(trimmed) : path.resolve(workspace || process.cwd(), trimmed);
}

function probeWindowsDesktop(pid, waitMs = 0, execFileFn = execFile) {
  if (process.platform !== 'win32') {
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { alive = false; }
    return Promise.resolve({ desktop: process.env.DISPLAY || process.env.WAYLAND_DISPLAY || null, alive, mainWindowHandle: null, windowTitle: '' });
  }
  const safePid = Number(pid);
  const safeWait = Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(Number(waitMs) || 0)));
  const ps = [
    '$ErrorActionPreference = "SilentlyContinue"',
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    'public class PhasmaDesktopProbe {',
    '  [DllImport("user32.dll")] public static extern IntPtr GetThreadDesktop(uint tid);',
    '  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern bool GetUserObjectInformationW(IntPtr h, int idx, StringBuilder buf, int len, out int needed);',
    '}',
    '"@',
    '$sb = New-Object System.Text.StringBuilder 256; $need = 0',
    '[void][PhasmaDesktopProbe]::GetUserObjectInformationW([PhasmaDesktopProbe]::GetThreadDesktop([PhasmaDesktopProbe]::GetCurrentThreadId()), 2, $sb, 512, [ref]$need)',
    '$desktop = $sb.ToString()',
    `$deadline = [DateTime]::UtcNow.AddMilliseconds(${safeWait})`,
    '$alive = $false; $hwnd = [Int64]0; $title = ""',
    'do {',
    `  $p = Get-Process -Id ${safePid} -ErrorAction SilentlyContinue`,
    '  if ($null -eq $p) { $alive = $false; break }',
    '  $alive = $true',
    '  try { $p.Refresh() } catch {}',
    '  $hwnd = [Int64]$p.MainWindowHandle',
    '  $title = [string]$p.MainWindowTitle',
    '  if ($hwnd -ne 0) { break }',
    '  if ([DateTime]::UtcNow -ge $deadline) { break }',
    '  Start-Sleep -Milliseconds 150',
    '} while ($true)',
    '@{ desktop = $desktop; alive = $alive; mainWindowHandle = $hwnd; windowTitle = $title } | ConvertTo-Json -Compress',
  ].join('\n');

  return new Promise(resolve => {
    execFileFn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true,
      timeout: Math.max(8000, safeWait + 5000),
      maxBuffer: 256 * 1024,
    }, (error, stdout) => {
      if (error || !stdout) {
        let alive = false;
        try { process.kill(safePid, 0); alive = true; } catch { alive = false; }
        resolve({ desktop: null, alive, mainWindowHandle: 0, windowTitle: '' });
        return;
      }
      try {
        const line = String(stdout).trim().split(/\r?\n/).pop();
        const parsed = JSON.parse(line);
        resolve({
          desktop: typeof parsed.desktop === 'string' ? parsed.desktop : null,
          alive: Boolean(parsed.alive),
          mainWindowHandle: Number.isFinite(Number(parsed.mainWindowHandle)) ? Number(parsed.mainWindowHandle) : 0,
          windowTitle: typeof parsed.windowTitle === 'string' ? parsed.windowTitle : '',
        });
      } catch {
        resolve({ desktop: null, alive: false, mainWindowHandle: 0, windowTitle: '' });
      }
    });
  });
}

async function launchDesktopApp(rawArgs, { workspace = process.cwd(), spawnFn = spawn, probeFn = probeWindowsDesktop, signal = null } = {}) {
  if (!rawArgs || typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    throw new Error('Invalid launch_desktop_app arguments.');
  }
  const allowed = new Set(['executable', 'args', 'cwd', 'waitForWindowMs', 'pid']);
  for (const key of Object.keys(rawArgs)) {
    if (!allowed.has(key)) throw new Error(`Unsupported launch_desktop_app argument: ${key}.`);
  }
  if (signal?.aborted) throw new Error('Desktop app launch stopped.');

  // Read-only status probe for a previously launched PID
  if (rawArgs.pid !== undefined) {
    if (rawArgs.executable !== undefined || rawArgs.args !== undefined || rawArgs.cwd !== undefined) {
      throw new Error('Pass either `executable` to launch or `pid` to check status, not both.');
    }
    const pid = rawArgs.pid;
    if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid pid.');
    if (!launchedPids.has(pid)) throw new Error(`PID ${pid} was not started by launch_desktop_app in this Harness session.`);
    const waitMs = rawArgs.waitForWindowMs ?? 0;
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) throw new Error('Invalid waitForWindowMs.');
    const info = await probeFn(pid, waitMs);
    if (!info.alive) launchedPids.delete(pid);
    return { status: info.alive ? 'running' : 'exited', pid, ...info };
  }

  const file = resolveExistingPath(rawArgs.executable, workspace, 'executable');
  let stat;
  try { stat = fs.statSync(file); } catch { throw new Error(`Executable not found: ${file}`); }
  if (!stat.isFile()) throw new Error(`Executable path is not a file: ${file}`);

  const argv = rawArgs.args === undefined ? [] : rawArgs.args;
  if (!Array.isArray(argv) || argv.length > MAX_ARGS || argv.some(a => typeof a !== 'string' || a.length > MAX_ARG_LEN)) {
    throw new Error('Invalid args: expected an array of strings.');
  }

  const workDir = rawArgs.cwd === undefined ? path.dirname(file) : resolveExistingPath(rawArgs.cwd, workspace, 'cwd');
  let dirStat;
  try { dirStat = fs.statSync(workDir); } catch { throw new Error(`Working directory not found: ${workDir}`); }
  if (!dirStat.isDirectory()) throw new Error(`Working directory is not a directory: ${workDir}`);

  const waitMs = rawArgs.waitForWindowMs === undefined ? (process.platform === 'win32' ? DEFAULT_WAIT_MS : 0) : rawArgs.waitForWindowMs;
  if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > MAX_WAIT_MS) {
    throw new Error('Invalid waitForWindowMs.');
  }

  const child = spawnFn(file, argv, {
    cwd: workDir,
    env: cleanEnvironment(process.env),
    shell: false,
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
  });

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for desktop app to spawn.')), 5000);
    const cleanup = () => {
      clearTimeout(timer);
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
    };
    const onSpawn = () => { cleanup(); resolve(); };
    const onError = error => { cleanup(); reject(new Error(`Failed to launch desktop app: ${error.message}`)); };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });

  child.unref?.();
  if (Number.isSafeInteger(child.pid) && child.pid > 0) launchedPids.add(child.pid);

  const probe = Number.isSafeInteger(child.pid) && child.pid > 0
    ? await probeFn(child.pid, waitMs)
    : { desktop: null, alive: false, mainWindowHandle: 0, windowTitle: '' };
  if (Number.isSafeInteger(child.pid) && !probe.alive) launchedPids.delete(child.pid);

  return {
    status: probe.alive ? 'started' : 'exited',
    pid: child.pid ?? null,
    executable: file,
    cwd: workDir,
    args: argv,
    ...probe,
  };
}

module.exports = {
  TOOL,
  INSTRUCTIONS,
  launchDesktopApp,
  probeWindowsDesktop,
  cleanEnvironment,
  launchedPids,
};
