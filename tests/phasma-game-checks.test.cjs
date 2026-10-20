const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CHECKER, phasmaGameChecks, verifyGameplay, enableMcpOptIn, restoreMcpOptIn, assetsRoot } = require('../src/phasma-game-checks.cjs');
const { validateChecks } = require('../src/tasks.cjs');

// The batch layout: a project with its own Player in runtime/, pointed back at the project like the acceptance seed.
function project(t, { skip = null, settings = { project_path: '..' }, assets = 'Assets' } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-phasma-game-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const files = {
    'phasma_project.json': JSON.stringify({ version: 1, name: 'Game', assets }),
    'runtime/phasma_settings.json': JSON.stringify(settings),
    'runtime/PhasmaPlayer.exe': '', 'runtime/minilua.exe': '',
  };
  for (const [file, text] of Object.entries(files).filter(([file]) => file !== skip)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text);
  }
  return root;
}

test('a Phasma project with its own Player gets build, launch and gameplay checks before any game exists', { skip: process.platform !== 'win32' && 'Windows Player' }, t => {
  const root = project(t);
  const checks = phasmaGameChecks(root);
  assert.deepEqual(checks.map(check => check.kind), ['build', 'launch', 'gameplay']);
  assert.deepEqual(checks.map(check => check.argv), ['build', 'launch', 'gameplay'].map(mode => [process.execPath, CHECKER, mode]));
  assert.equal(validateChecks(root, checks).length, 3, 'the recipe saves through the normal check validation');
});

test('no recipe without the Player, the compiler, or a Player pointed at this project', { skip: process.platform !== 'win32' && 'Windows Player' }, t => {
  for (const skip of ['phasma_project.json', 'runtime/phasma_settings.json', 'runtime/PhasmaPlayer.exe', 'runtime/minilua.exe'])
    assert.equal(phasmaGameChecks(project(t, { skip })), null, skip);
  assert.equal(phasmaGameChecks(project(t, { settings: { project_path: '../../elsewhere' } })), null, 'another project');
  const manifest = project(t, { settings: { project_manifest: '../phasma_project.json' }, assets: 'Content' });
  assert.equal(assetsRoot(manifest), path.join(manifest, 'Content'), 'the manifest names the assets folder');
});

test('the MCP opt-in is backed up and restored, whether or not the project had a config', async t => {
  for (const original of [null, '{"mcp":false}']) {
    const root = project(t);
    const assets = assetsRoot(root), config = path.join(assets, 'Agent', 'agent_config.json');
    if (original !== null) {
      fs.mkdirSync(path.dirname(config), { recursive: true });
      fs.writeFileSync(config, original);
    }
    await enableMcpOptIn(root, assets, 4321);
    assert.deepEqual(JSON.parse(fs.readFileSync(config, 'utf8')), { mcp: true, mcp_port: 4321 });
    // A killed check leaves the opt-in; the next enable or Harness's restore puts the original back first.
    await enableMcpOptIn(root, assets, 4322);
    await restoreMcpOptIn(root);
    assert.equal(fs.existsSync(config) ? fs.readFileSync(config, 'utf8') : null, original);
    assert.equal(fs.existsSync(path.join(root, 'runtime', 'harness-checks', 'agent_config.backup.json')), false);
  }
});

// A gamekit-shaped game: three legal moves finish it; act advances state_id; reset starts a new session. A real-time
// game's view moves on every observe while its decision epoch stays put.
function game({ staleAccepted = false, stuck = false, busyOnce = false, realtime = false } = {}) {
  let session = 1, stateId = 1, total = 0, busy = false, frame = 0;
  const view = () => ({ ok: true, session_id: `s${session}`, state_id: stateId, terminal: total >= 3, score: total >= 3 ? 1 : 0, busy,
    observation: { total, ...(realtime ? { frame: frame++ } : {}) }, actions: total >= 3 ? [] : [{ id: 'take' }] });
  return async (name, args) => {
    if (name === 'game_reset') {
      session++;
      stateId = 1;
      total = 0;
      return view();
    }
    if (name === 'game_observe') {
      const value = view();
      busy = false;
      return value;
    }
    if (!staleAccepted && (args.session_id !== `s${session}` || args.state_id !== stateId))
      return { ok: false, error: { code: 'stale_state' } };
    if (!stuck)
      stateId++;
    total++;
    busy = busyOnce;
    return view();
  };
}
const quick = { pause: async () => {} };
const DESCRIBE = { protocol_version: 1, game_id: 'take', reset_supported: true, state_tracking: 'public_state' };

test('generic gameplay passes games that follow the gamekit protocol: busy, real-time and without reset', async () => {
  const done = { moves: 3, finished: true, score: 1 };
  assert.deepEqual(await verifyGameplay(game(), DESCRIBE, quick), { ...done, reset: true });
  assert.deepEqual(await verifyGameplay(game({ busyOnce: true }), DESCRIBE, quick), { ...done, reset: true });
  assert.deepEqual(await verifyGameplay(game({ realtime: true }), { ...DESCRIBE, state_tracking: 'game_epoch' }, quick), { ...done, reset: true });
  assert.deepEqual(await verifyGameplay(game(), { ...DESCRIBE, reset_supported: false }, quick), { ...done, reset: false });
});

test('generic gameplay fails a game that accepts stale actions or does not advance its state', async () => {
  await assert.rejects(verifyGameplay(game({ staleAccepted: true }), DESCRIBE, quick), /old state must be rejected/);
  await assert.rejects(verifyGameplay(game({ staleAccepted: true }), { ...DESCRIBE, reset_supported: false }, quick), /old state must be rejected/);
  await assert.rejects(verifyGameplay(game({ stuck: true }), DESCRIBE, quick), /advance the state/);
});
