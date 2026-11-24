'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { launchDesktopApp, cleanEnvironment, launchedPids, TOOL } = require('../src/tools/desktop-launcher.cjs');
const { MCP_TOOLS, claudeAllowedHelpers } = require('../src/tools/router-bridge.cjs');
const helperMethods = require('../src/controller/helpers.cjs');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-desktop-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('launch_desktop_app is exposed over MCP and restricted to Full access in claudeAllowedHelpers', () => {
  assert.ok(MCP_TOOLS.some(tool => tool.name === TOOL.name));
  assert.equal(claudeAllowedHelpers('read-only').includes('mcp__phasma_harness__launch_desktop_app'), false);
  assert.equal(claudeAllowedHelpers('workspace-write').includes('mcp__phasma_harness__launch_desktop_app'), false);
  assert.equal(claudeAllowedHelpers('danger-full-access').includes('mcp__phasma_harness__launch_desktop_app'), true);
});

test('cleanEnvironment strips ELECTRON_RUN_AS_NODE and bridge credentials while keeping normal env', () => {
  const cleaned = cleanEnvironment({
    PATH: 'C:\\Windows\\System32',
    ELECTRON_RUN_AS_NODE: '1',
    PHASMA_BRIDGE_URL: 'http://127.0.0.1:9999',
    PHASMA_BRIDGE_TOKEN: 'secret-token',
    PHASMA_SESSION_ID: 'sess-1',
    CUSTOM_APP_VAR: 'keep',
  });
  assert.deepEqual(cleaned, { PATH: 'C:\\Windows\\System32', CUSTOM_APP_VAR: 'keep' });
});

test('launchDesktopApp spawns detached visible GUI process with shell=false and supports PID status checks', async t => {
  const dir = makeTempDir(t);
  const exe = path.join(dir, 'PhasmaAnimator.exe');
  fs.writeFileSync(exe, 'stub');
  let spawned = null;
  let unrefCalled = false;
  const fakeSpawn = (file, args, options) => {
    const child = new EventEmitter();
    child.pid = 424242;
    child.unref = () => { unrefCalled = true; };
    spawned = { file, args, options };
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  let probeAlive = true;
  const fakeProbe = async (pid, waitMs) => ({
    desktop: 'Default',
    alive: probeAlive,
    mainWindowHandle: probeAlive ? 131456 : 0,
    windowTitle: probeAlive ? 'Phasma Animator' : '',
    probedWaitMs: waitMs,
  });

  t.after(() => launchedPids.delete(424242));

  const res = await launchDesktopApp(
    { executable: 'PhasmaAnimator.exe', args: ['--api', 'vulkan', '--display', '1'], waitForWindowMs: 500 },
    { workspace: dir, spawnFn: fakeSpawn, probeFn: fakeProbe },
  );
  assert.equal(res.status, 'started');
  assert.equal(res.pid, 424242);
  assert.equal(res.desktop, 'Default');
  assert.equal(res.alive, true);
  assert.equal(res.mainWindowHandle, 131456);
  assert.equal(res.windowTitle, 'Phasma Animator');
  assert.equal(unrefCalled, true);
  assert.equal(spawned.file, exe);
  assert.deepEqual(spawned.args, ['--api', 'vulkan', '--display', '1']);
  assert.equal(spawned.options.cwd, dir);
  assert.equal(spawned.options.shell, false);
  assert.equal(spawned.options.detached, true);
  assert.equal(spawned.options.windowsHide, false);
  assert.equal(spawned.options.stdio, 'ignore');

  // Read-only follow-up status check for the launched PID (simulates verifying window still up on next turn)
  const check = await launchDesktopApp({ pid: 424242 }, { workspace: dir, probeFn: fakeProbe });
  assert.equal(check.status, 'running');
  assert.equal(check.desktop, 'Default');
  assert.equal(check.mainWindowHandle, 131456);

  // Unknown PID is rejected
  await assert.rejects(
    launchDesktopApp({ pid: 999999 }, { workspace: dir, probeFn: fakeProbe }),
    /was not started by launch_desktop_app/,
  );

  // Once exited, PID is cleaned from launchedPids
  probeAlive = false;
  const gone = await launchDesktopApp({ pid: 424242 }, { workspace: dir, probeFn: fakeProbe });
  assert.equal(gone.status, 'exited');
  assert.equal(launchedPids.has(424242), false);
});

test('launchDesktopApp rejects invalid paths, directories, unknown fields, and non-Full access via bridgeTool', async t => {
  const dir = makeTempDir(t);
  const exe = path.join(dir, 'app.exe');
  fs.writeFileSync(exe, 'stub');

  await assert.rejects(launchDesktopApp({ executable: path.join(dir, 'missing.exe') }, { workspace: dir }), /Executable not found/);
  await assert.rejects(launchDesktopApp({ executable: dir }, { workspace: dir }), /not a file/);
  await assert.rejects(launchDesktopApp({ executable: exe, cwd: path.join(dir, 'no-dir') }, { workspace: dir }), /Working directory not found/);
  await assert.rejects(launchDesktopApp({ executable: exe, extra: true }, { workspace: dir }), /Unsupported launch_desktop_app argument/);
  await assert.rejects(launchDesktopApp({ executable: exe, args: [123] }, { workspace: dir }), /Invalid args/);
  await assert.rejects(launchDesktopApp({ executable: exe, pid: 1 }, { workspace: dir }), /not both/);

  for (const [access, cancelled] of [['read-only', false], ['workspace-write', false], ['danger-full-access', true]]) {
    const controller = {
      busy: 's1',
      stopping: new Set(),
      activeTurns: new Map([['s1', 't1']]),
      cliAbort: null,
      session: () => ({ id: 's1', workspace: dir, access, agentReplyCancelledActive: cancelled, activeProvider: 'native:antigravity' }),
      assignmentCurrent: () => true,
      workspace: w => w,
    };
    await assert.rejects(
      helperMethods.bridgeTool.call(controller, 's1', 'launch_desktop_app', { executable: exe }, null),
      /requires Full access/,
    );
  }
});
