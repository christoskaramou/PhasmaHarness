const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const setups = require('../src/setups.cjs');
const { SmartRouter } = require('../src/routing/smart-router.cjs');

const tempRoot = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-setups-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
let next = 0;
const run = (preset, outcome, extra = {}) => ({ taskId: `t${next++}`, at: Date.now(), kind: 'debugging', difficulty: 'low', preset, label: preset,
  provider: 'codex', outcome, tokens: 10000, ...extra });

test('a task says how its checks went: first time, after a correction (of its own), or still failing', () => {
  assert.equal(setups.taskOutcome({ state: 'checks-passed', corrections: 0 }), 'clean');
  assert.equal(setups.taskOutcome({ state: 'checks-passed', corrections: 1, startCorrections: 1 }), 'clean', 'corrections carried from a delegation do not count');
  assert.equal(setups.taskOutcome({ state: 'checks-passed', corrections: 1 }), 'corrected');
  assert.equal(setups.taskOutcome({ state: 'needs-you', attempts: [{ results: [{ status: 'failed' }] }] }), 'failed');
  for (const state of ['blocked', 'cancelled', 'not-checked'])
    assert.equal(setups.taskOutcome({ state, attempts: [{ results: [{ status: 'failed' }] }] }), null);
});

test('a preference needs two presets with three runs each and a real winner; ties and undone presets never win', t => {
  const root = tempRoot(t);
  for (let i = 0; i < 3; i++)
    assert.deepEqual(setups.recordSetup(root, run('terra', 'clean')), {}, 'one preset alone proves nothing');
  setups.recordSetup(root, run('sol', 'clean'));
  setups.recordSetup(root, run('sol', 'corrected'));
  const { proven } = setups.recordSetup(root, run('sol', 'clean'));
  assert.deepEqual([proven.kind, proven.preset, proven.evidence.map(stats => [stats.preset, stats.clean, stats.runs])],
    ['debugging', 'terra', [['terra', 3, 3], ['sol', 2, 3]]]);
  assert.deepEqual(setups.recordSetup(root, run('sol', 'clean')), {}, 'a kind with a preference is not re-derived');
  assert.match(fs.readFileSync(path.join(root, setups.PAGE), 'utf8'), /\*\*debugging\*\* work: terra/);

  const data = records => ({ records, preferences: [], blocked: [] });
  const even = [...Array(3)].flatMap(() => [run('terra', 'clean', { tokens: 9000 }), run('luna', 'clean', { provider: 'claude-cli', tokens: 1000 })]);
  assert.equal(setups.provenFor(data(even), 'debugging'), null, 'fewer tokens from another provider is not a win');
  const cheaper = [...Array(3)].flatMap(() => [run('terra', 'clean', { tokens: 9000 }), run('luna', 'clean', { tokens: 1000 })]);
  assert.equal(setups.provenFor(data(cheaper), 'debugging').preset, 'luna', 'within one provider, fewer tokens breaks the tie');
  const unreported = [...Array(3)].flatMap(() => [run('terra', 'clean'), run('cursor', 'clean', { tokens: null })]);
  assert.equal(setups.provenFor(data(unreported), 'debugging'), null);
  const hard = [...Array(3)].flatMap(() => [run('terra', 'clean', { difficulty: 'high' }), run('sol', 'failed', { difficulty: 'high' })]);
  assert.equal(setups.provenFor(data(hard), 'debugging'), null, 'only low and medium tasks count');
  assert.equal(setups.provenFor({ ...data(cheaper), blocked: [{ kind: 'debugging', preset: 'luna' }] }, 'debugging'), null, 'an undone preference never returns');
});

test('a task of that kind the preferred preset does not pass first time drops it; Undo drops it for good', t => {
  const root = tempRoot(t);
  for (let i = 0; i < 3; i++) {
    setups.recordSetup(root, run('terra', 'clean'));
    setups.recordSetup(root, run('sol', 'corrected'));
  }
  assert.equal(setups.readSetups(root).preferences[0].preset, 'terra');
  assert.deepEqual(setups.recordSetup(root, run('terra', 'clean', { difficulty: 'high' })), {});
  assert.deepEqual(setups.recordSetup(root, run('terra', 'corrected', { difficulty: 'high' })), {}, 'a hard task never used the preference');
  const { rolledBack } = setups.recordSetup(root, run('terra', 'corrected'));
  assert.equal(rolledBack.preset, 'terra');
  assert.deepEqual(setups.readSetups(root).preferences, []);

  setups.dropPreference(root, 'debugging', 'terra');
  assert.deepEqual(setups.readSetups(root).blocked.map(entry => [entry.kind, entry.preset]), [['debugging', 'terra']]);
});

test('Auto, through Smart or Jev, takes the proven preset on low and medium difficulty only, at its own effort', async () => {
  const picked = { id: 'picked', model: 'picked-model', effort: 'low' };
  const proven = { id: 'proven', model: 'proven-model', effort: 'medium' };
  const session = { routingCatalog: [picked, proven], routerChoice: { provider: 'codex', model: 'picked-model', effort: 'low' }, provenSetups: { debugging: 'proven' } };
  const decision = difficulty => ({ preset: 'picked', reason: 'test', difficulty, taskKind: 'debugging', workspaceRelevant: false, needsChecks: true,
    risk: 'low', uncertainty: 'low', sameTask: false, confident: true });
  const router = new SmartRouter(__dirname);
  router.inspect = async () => assert.fail('no workspace scan for these messages');
  let difficulty = 'low';
  router.classifyCodex = async () => ({ decision: decision(difficulty), usage: null });
  const smart = await router.choose('fix the crash', session, []);
  assert.deepEqual([smart.id, smart.effort, smart.routerPick, smart.proven], ['proven', 'medium', 'picked', true]);
  assert.match(smart.reason, /^Proven setup for debugging work in this project\./);

  router.jev = { configured: true, classify: async () => ({ decision: decision(difficulty), model: 'jev-1', usage: null, confidence: 0.9, answers: {} }) };
  assert.equal((await router.choose('fix the crash', session, [], 'jev')).id, 'proven', 'the same through Jev');
  difficulty = 'high';
  assert.equal((await router.choose('fix the crash', session, [], 'jev')).id, 'picked', 'hard tasks keep the router\'s choice');
  difficulty = 'low';
  assert.equal((await router.choose('fix the crash', { ...session, routingCatalog: [picked] }, [], 'jev')).id, 'picked', 'only while the preset is offered');
  assert.equal((await router.choose('fix the crash', { ...session, provenSetups: {} }, [])).id, 'picked');
});
