const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CursorCLI } = require('../src/providers/cursor.cjs');

// Shapes as produced by Cursor CLI 2026.09.02 (listAvailableModels / buildModelParameterConfigOptions / setSessionConfigOption).
const LISTED = { models: [
  { value: 'grok-4.7', name: 'Grok 4.7', configOptions: [
    { id: 'effort', name: 'Effort', category: 'thought_level', type: 'select', currentValue: 'medium',
      options: [{ value: 'low', name: 'Low' }, { value: 'medium', name: 'Medium' }, { value: 'high', name: 'High' }, { value: 'xhigh', name: 'Extra High' }] },
    { id: 'fast', name: 'Fast', category: 'model_config', type: 'select', currentValue: 'false', options: [{ value: 'false', name: 'Off' }, { value: 'true', name: 'On' }] }] },
  { value: 'composer-2.5', name: 'Composer 2.5', configOptions: [] },
] };

function fake(cursor, { list = LISTED, applied } = {}) {
  const calls = [];
  cursor.connect = () => ({ call: async (method, params) => {
    calls.push({ method, params });
    if (method === 'initialize') return { agentCapabilities: {} };
    if (method === 'session/new') return { sessionId: 's1', models: { availableModels: [{ modelId: 'grok-4.7', name: 'Grok 4.7' }] } };
    if (method === 'cursor/list_available_models') { if (list instanceof Error) throw list; return list; }
    if (method === 'session/set_config_option') return { configOptions: [{ id: params.configId, category: 'thought_level', currentValue: applied ?? params.value }] };
    if (method === 'session/prompt') return { stopReason: 'end_turn' };
    return {};
  }, close() {} });
  return calls;
}

test('Cursor discovery reads each model\'s reasoning levels from cursor/list_available_models', async () => {
  const cursor = new CursorCLI();
  fake(cursor);
  const models = await cursor.discover();
  assert.deepEqual(models, [
    { id: 'grok-4.7', label: 'Grok 4.7', parameterized: true, efforts: ['low', 'medium', 'high', 'xhigh'], effortOption: 'effort',
      effortNames: { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra High' } },
    { id: 'composer-2.5', label: 'Composer 2.5', parameterized: true },
  ]);
  // An older CLI without the extension keeps the plain list.
  const old = new CursorCLI();
  fake(old, { list: new Error('Method not found') });
  assert.deepEqual(await old.discover(), [{ id: 'grok-4.7', label: 'Grok 4.7' }]);
});

test('Cursor run sets the chosen reasoning level through the parameterized picker, and verifies it', async () => {
  const cursor = new CursorCLI();
  let calls = fake(cursor);
  await cursor.run({ model: 'grok-4.7', effort: 'xhigh', effortOption: 'effort', parameterized: true, prompt: 'x', access: 'read-only' });
  assert.equal(calls[0].params.clientCapabilities._meta.parameterizedModelPicker, true);
  const order = calls.map(c => c.method);
  assert.ok(order.indexOf('session/set_model') < order.indexOf('session/set_config_option'));
  assert.deepEqual(calls.find(c => c.method === 'session/set_config_option').params, { sessionId: 's1', configId: 'effort', value: 'xhigh' });

  calls = fake(cursor, { applied: 'medium' });
  await assert.rejects(cursor.run({ model: 'grok-4.7', effort: 'xhigh', effortOption: 'effort', parameterized: true, prompt: 'x', access: 'read-only' }), /did not apply effort=xhigh/);

  // A model from the old variant list keeps the previous handshake: no picker capability, no config option.
  calls = fake(cursor);
  await cursor.run({ model: 'gpt-5.5-high', prompt: 'x', access: 'read-only' });
  assert.equal(calls[0].params.clientCapabilities._meta, undefined);
  assert.equal(calls.some(c => c.method === 'session/set_config_option'), false);
  // A parameterized model without levels declares the picker but sets no option.
  calls = fake(cursor);
  await cursor.run({ model: 'composer-2.5', parameterized: true, prompt: 'x', access: 'read-only' });
  assert.equal(calls[0].params.clientCapabilities._meta.parameterizedModelPicker, true);
  assert.equal(calls.some(c => c.method === 'session/set_config_option'), false);
});
