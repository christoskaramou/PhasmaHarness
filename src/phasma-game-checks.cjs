'use strict';
// Built-in Phasma game checks: compile the game's Lua, launch its Player, then play it through the gamekit MCP protocol.
// The recipe targets the layout Harness game batches use: a Phasma project (phasma_project.json) with its own Player build
// in runtime/, pointed at the project by runtime/phasma_settings.json. The game may not exist yet; workers create it.
// Run as: <Harness or node> phasma-game-checks.cjs <mode>; Harness passes its timeout in HARNESS_CHECK_TIMEOUT_MS.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const net = require('node:net');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');

const MODES = [
  { mode: 'build', name: 'Compile game Lua', timeoutMs: 30000 },
  { mode: 'launch', name: 'Launch the Player and its game', timeoutMs: 90000 },
  { mode: 'gameplay', name: 'Play, reset and reject stale actions', timeoutMs: 120000 },
];
// The checker stops this long before Harness's own timeout, so it can stop the Player and restore the MCP opt-in file.
const CLEANUP_MS = 15000;

// The assets folder of the project the runtime/ Player opens, resolved the way the Player does (ProjectSelection.cpp):
// runtime/phasma_settings.json names a manifest or a project folder; the manifest's "assets" is relative to its folder.
// Null unless that project is this workspace, so a check never runs some other project's game.
function assetsRoot(root) {
  try {
    const runtime = path.join(root, 'runtime');
    const settings = JSON.parse(fs.readFileSync(path.join(runtime, 'phasma_settings.json'), 'utf8'));
    const manifest = settings.project_manifest ? path.resolve(runtime, settings.project_manifest)
      : settings.project_path ? path.join(path.resolve(runtime, settings.project_path), 'phasma_project.json') : null;
    if (!manifest || path.relative(root, manifest) !== 'phasma_project.json')
      return null;

    const { assets } = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    return typeof assets === 'string' && assets ? path.resolve(root, assets) : null;
  } catch {
    return null;
  }
}

function phasmaGameChecks(workspace) {
  const ready = process.platform === 'win32' && ['PhasmaPlayer.exe', 'minilua.exe'].every(file => fs.existsSync(path.join(workspace, 'runtime', file)));
  if (!ready || !assetsRoot(workspace))
    return null;

  return MODES.map(({ mode, name, timeoutMs }) => ({ name, kind: mode, cwd: workspace, timeoutMs, argv: [process.execPath, __filename, mode] }));
}

// Generic gamekit play: legal actions advance the state, reset (when the game has one) starts a new session, and an action
// against an old state is rejected without changing the game. Game rules belong to the game's own tests.
async function verifyGameplay(tool, describe, { steps = 50, pause = () => new Promise(resolve => setTimeout(resolve, 100)) } = {}) {
  const call = async (name, args = {}) => {
    const value = await tool(name, args);
    assert.notEqual(value.ok, false, `${name} failed: ${JSON.stringify(value.error || value)}`);
    return value;
  };
  const settled = async state => {
    for (let i = 0; state.busy && i < 50; i++) {
      await pause();
      state = await call('game_observe');
    }
    assert.ok(!state.busy, 'the game stayed busy');
    return state;
  };
  const playable = state => assert.ok(Array.isArray(state.actions) && state.actions.length, 'a running game must offer legal actions');
  const resettable = describe.reset_supported !== false;
  const start = () => (resettable ? call('game_reset', { seed: 7 }) : call('game_observe'));

  const first = await settled(await start());
  assert.equal(first.terminal, false, resettable ? 'a reset game must not start finished' : 'the game must not start finished');
  playable(first);

  let state = first, moves = 0;
  while (!state.terminal && moves < steps) {
    const next = await settled(await call('game_act', { session_id: state.session_id, state_id: state.state_id, action_id: state.actions[0].id }));
    assert.equal(next.session_id, state.session_id, 'an action must stay in its session');
    assert.ok(next.state_id > state.state_id, 'each legal action must advance the state');
    if (!next.terminal)
      playable(next);
    state = next;
    moves++;
  }

  let current = state;
  if (resettable) {
    current = await settled(await start());
    assert.equal(current.terminal, false, 'a reset game must not start finished');
    assert.notEqual(current.session_id, first.session_id, 'reset must start a new session');
  }
  const stale = await tool('game_act', { session_id: first.session_id, state_id: first.state_id, action_id: first.actions[0].id });
  assert.equal(stale.ok, false, 'an action against an old state must be rejected');
  assert.equal(stale.error?.code, 'stale_state', 'an old state must be rejected as stale');

  // A real-time game's view keeps moving; its decision epoch (state_id) is what a rejected action must not change.
  const after = await call('game_observe');
  assert.equal(after.session_id, current.session_id, 'a rejected action must not change the session');
  if (describe.state_tracking === 'game_epoch')
    assert.equal(after.state_id, current.state_id, 'a rejected action must not change the game');
  else
    assert.deepEqual(after.observation, current.observation, 'a rejected action must not change the game');
  return { moves, finished: state.terminal, score: state.score, reset: resettable };
}

async function build(root, assets, evidence, deadline) {
  const { spawnOwned, stopTree } = require('./process-tree.cjs');
  const scripts = [];
  const walk = async directory => {
    for (const entry of await fsp.readdir(directory, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'game scripts cannot contain links');
      const file = path.join(directory, entry.name);
      if (entry.isDirectory())
        await walk(file);
      else if (entry.name.endsWith('.lua'))
        scripts.push(file);
    }
  };
  assert.ok(fs.existsSync(path.join(assets, 'Scripts')), 'the project has no Scripts folder in its assets');
  await walk(path.join(assets, 'Scripts'));
  assert.ok(scripts.length, 'the project has no Lua scripts');

  // shortcut: minilua is plain Lua 5.1, so LuaJIT-only syntax (goto, labels) fails here; compile in the Player if games use it.
  const work = path.join(root, 'runtime', 'harness-checks');
  await fsp.mkdir(work, { recursive: true });
  const compile = path.join(work, 'compile.lua'), list = path.join(work, 'scripts.txt');
  await fsp.writeFile(list, scripts.join('\n'));
  await fsp.writeFile(compile, 'for file in io.lines(...) do assert(loadfile(file)) end\n');
  let child;
  try {
    child = spawnOwned(spawn, path.join(root, 'runtime', 'minilua.exe'), [compile, list], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', text => { output += text; });
    child.stderr.on('data', text => { output += text; });
    const code = await Promise.race([
      new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Lua compile did not finish in time')), Math.max(0, deadline - Date.now())).unref()),
    ]);
    assert.equal(code, 0, output.trim() || `minilua exited with ${code}`);
    evidence.compiledScripts = scripts.length;
  } finally {
    const remaining = child ? await stopTree(child) : [];
    evidence.cleanup = remaining.length ? 'unconfirmed' : 'confirmed';
    await fsp.rm(compile, { force: true });
    await fsp.rm(list, { force: true });
  }
}

// The Player starts its MCP server (which runs any Lua) only when <assets>/Agent/agent_config.json opts in, so the checker
// opts in for one run. The original is backed up first and restored after the run, by Harness after a stopped check
// (`restoreMcpOptIn`), or at the start of the next run.
function optInFiles(root, assets) {
  return { config: path.join(assets, 'Agent', 'agent_config.json'), backup: path.join(root, 'runtime', 'harness-checks', 'agent_config.backup.json') };
}

const missing = error => {
  if (error.code !== 'ENOENT')
    throw error;
  return null;
};

async function restoreMcpOptIn(root, assets = assetsRoot(root)) {
  if (!assets)
    return;

  const { config, backup } = optInFiles(root, assets);
  const saved = await fsp.readFile(backup, 'utf8').catch(missing);
  if (saved === null)
    return;

  const { text } = JSON.parse(saved);
  if (text === null)
    await fsp.rm(config, { force: true });
  else
    await fsp.writeFile(config, text);
  await fsp.rm(backup, { force: true });
}

async function enableMcpOptIn(root, assets, port) {
  await restoreMcpOptIn(root, assets);
  const { config, backup } = optInFiles(root, assets);
  const text = await fsp.readFile(config, 'utf8').catch(missing);
  await fsp.mkdir(path.dirname(backup), { recursive: true });
  await fsp.writeFile(backup, JSON.stringify({ text }));
  await fsp.mkdir(path.dirname(config), { recursive: true });
  await fsp.writeFile(config, JSON.stringify({ mcp: true, mcp_port: port }));
}

async function play(root, assets, mode, evidence, deadline) {
  const { spawnOwned, stopTree } = require('./process-tree.cjs');
  const left = () => {
    const ms = deadline - Date.now();
    if (ms <= 0)
      throw new Error(`the ${mode} check ran out of time`);
    return ms;
  };
  const pause = ms => new Promise(resolve => setTimeout(resolve, Math.min(ms, left())));
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));

  const runtime = path.join(root, 'runtime');
  let child, launchError;
  try {
    await enableMcpOptIn(root, assets, port);
    child = spawnOwned(spawn, path.join(runtime, 'PhasmaPlayer.exe'), [], { cwd: runtime, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
    child.once('error', error => { launchError = error; });
    let session, counter = 0;
    const rpc = async (method, params) => {
      const id = method.startsWith('notifications/') ? undefined : ++counter;
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST', signal: AbortSignal.timeout(Math.min(9000, left())),
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(session ? { 'Mcp-Session-Id': session } : {}) },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      });
      session = response.headers.get('Mcp-Session-Id') || session;
      const text = await response.text();
      assert.ok(response.ok, `Player MCP returned ${response.status}: ${text.slice(0, 300)}`);
      const value = text.trim() ? JSON.parse(text) : {};
      assert.ok(!value.error, JSON.stringify(value.error));
      return value.result;
    };
    const tool = async (name, args = {}) => {
      const result = await rpc('tools/call', { name, arguments: args });
      const text = result.content.filter(item => item.type === 'text').map(item => item.text).join('\n');
      assert.ok(!result.isError, text);
      return JSON.parse(text);
    };

    let ready = false, last;
    while (!ready && !launchError && child.exitCode === null && Date.now() < deadline) {
      try {
        await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Phasma Harness checks', version: '1' } });
        await rpc('notifications/initialized', {});
        evidence.fps = Number((await tool('execute_lua', { code: 'return tostring(engine.get_metrics().fps or 0)' })).output);
        ready = evidence.fps > 0;
      } catch (error) { last = error; }
      if (!ready)
        await pause(300);
    }
    assert.ok(ready, launchError?.message || (child.exitCode !== null && `the Player exited with ${child.exitCode}`) ||
      `the Player did not render frames in time${last ? ` (${last.message})` : ''}`);

    const describe = await tool('game_describe');
    assert.equal(describe.protocol_version, 1, 'the game must attach the gamekit driver (protocol 1)');
    assert.ok(typeof describe.game_id === 'string' && describe.game_id, 'the game must name itself in Driver.attach');
    evidence.gameId = describe.game_id;
    // Optional descriptor (batch games write one): when present, the running game must be the one it names.
    const descriptor = path.join(assets, 'game.json');
    if (fs.existsSync(descriptor)) {
      const { gameId, title } = JSON.parse(await fsp.readFile(descriptor, 'utf8'));
      assert.equal(describe.game_id, gameId, 'the running game must match game.json');
      evidence.title = title;
    }
    if (mode === 'launch')
      return;

    evidence.play = await verifyGameplay(tool, describe, { pause: () => pause(100) });
    evidence.screenshot = path.join(runtime, 'harness-checks', 'gameplay.png');
    await fsp.rm(evidence.screenshot, { force: true });
    await tool('execute_lua', { code: `engine.take_screenshot(${JSON.stringify(evidence.screenshot.replace(/\\/g, '/'))}) return 'requested'` });
    for (let i = 0; i < 160 && !(await fsp.stat(evidence.screenshot).catch(() => null))?.size; i++)
      await pause(50);
    const image = await fsp.readFile(evidence.screenshot);
    assert.equal(image.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'the screenshot must be a PNG');
  } finally {
    const remaining = child ? await stopTree(child) : [];
    evidence.cleanup = remaining.length ? 'unconfirmed' : 'confirmed';
    await restoreMcpOptIn(root, assets);
  }
}

async function main(mode) {
  const root = process.cwd();
  const timeoutMs = Number(process.env.HARNESS_CHECK_TIMEOUT_MS) || MODES.find(entry => entry.mode === mode)?.timeoutMs || 60000;
  const deadline = Date.now() + Math.max(1000, timeoutMs - CLEANUP_MS);
  const evidence = { mode, workspace: root, startedAt: new Date().toISOString(), status: 'failed' };
  try {
    assert.ok(MODES.some(entry => entry.mode === mode), `unknown check mode ${mode}`);
    const assets = assetsRoot(root);
    assert.ok(assets, 'runtime/phasma_settings.json must point the Player at this project (phasma_project.json with "assets")');
    if (mode === 'build')
      await build(root, assets, evidence, deadline);
    else
      await play(root, assets, mode, evidence, deadline);
    assert.equal(evidence.cleanup, 'confirmed', 'every started process must be stopped');
    evidence.status = 'passed';
  } catch (error) {
    evidence.error = error.message;
    process.exitCode = 1;
  }
  console.log(JSON.stringify(evidence));
}

if (require.main === module)
  main(process.argv[2]);

module.exports = { CHECKER: __filename, phasmaGameChecks, verifyGameplay, restoreMcpOptIn, enableMcpOptIn, assetsRoot };
