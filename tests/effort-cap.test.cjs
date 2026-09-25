const test = require('node:test');
const assert = require('node:assert/strict');
const { withinCap, capCatalog, sameModel, EFFORT_CAPS, DEFAULT_EFFORT_CAP } = require('../src/routing/effort-cap.cjs');

const w = (model, effort, provider = 'codex') => ({ id: `${provider}:${model}:${effort || 'default'}`, provider, model, effort });
const ids = list => list.map(p => p.id);
const LIST = [w('astra', 'low'), w('astra', 'high'), w('astra', 'xhigh'), w('astra', 'max'), w('astra', 'ultra'),
  w('opus', 'medium', 'claude-cli'), w('opus', 'max', 'claude-cli'), w('grok', null, 'cursor-cli'), w('deep', 'high'), w('deep', 'max'), w('odd', 'turbo', 'cursor-cli')];

test('the effort cap keeps levels at or below it, models without levels, and every model at its lowest level', () => {
  assert.deepEqual(EFFORT_CAPS, ['low', 'medium', 'high', 'xhigh', 'max']);
  assert.equal(DEFAULT_EFFORT_CAP, 'high');
  assert.deepEqual(ids(capCatalog(LIST, 'xhigh')), ['codex:astra:low', 'codex:astra:high', 'codex:astra:xhigh', 'claude-cli:opus:medium',
    'cursor-cli:grok:default', 'codex:deep:high', 'cursor-cli:odd:turbo']);
  assert.deepEqual(ids(capCatalog(LIST, 'low')), ['codex:astra:low', 'claude-cli:opus:medium', 'cursor-cli:grok:default', 'codex:deep:high', 'cursor-cli:odd:turbo'],
    'a model with nothing that low keeps its lowest level, in the original order');
  assert.deepEqual(capCatalog(LIST, 'max'), LIST, 'max is no cap, including levels above max');
  assert.ok(withinCap({ effort: 'none' }, 'low') && withinCap({ effort: 'minimal' }, 'low') && withinCap({ effort: null }, 'low'));
  assert.ok(!withinCap({ effort: 'max' }, 'xhigh'));
  assert.ok(withinCap({ effort: 'max' }, 'unknown-cap'), 'an unknown cap does not restrict');
  assert.deepEqual(capCatalog([], 'low'), []);
});

test('a continued task can keep its model at the highest effort still allowed', () => {
  const capped = capCatalog(LIST, 'high');
  assert.equal(sameModel({ provider: 'codex', model: 'astra', effort: 'max' }, capped).id, 'codex:astra:high');
  assert.equal(sameModel({ provider: 'claude-cli', model: 'opus', effort: 'max' }, capped).id, 'claude-cli:opus:medium');
  assert.equal(sameModel({ provider: 'codex', model: 'missing', effort: 'max' }, capped), null);
});
