const { test } = require('node:test');
const assert = require('node:assert/strict');
const suggestions = require('../src/controller/suggestions.cjs');

// A controller stand-in with just what replySuggestion reads.
function chat({ enabled = true, items, route = { id: 'codex:gpt:low', provider: 'codex', model: 'gpt' }, reply = { suggestion: 'Now add tests for it.' } } = {}) {
  const calls = [];
  const session = { id: 's', items: items || [
    { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Write a parser.' }] },
    { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: 'Here is the parser.' },
  ], routes: route ? [route] : [], queue: [] };
  const controller = Object.assign({
    data: { settings: { replySuggestions: enabled } }, busy: null, log: { warn() {} },
    session: id => { assert.equal(id, 's'); return session; },
    resolveWorker: id => (id === route?.id ? route : null),
    available: () => true,
    smartRouter: { complete: async (request, choice) => { calls.push({ request, choice }); return { decision: reply }; } },
  }, suggestions);
  return { controller, session, calls };
}

test('a reply suggestion comes from the model that wrote the last answer, once per answer', async () => {
  const { controller, calls } = chat();
  assert.deepEqual(await controller.replySuggestion('s'), { itemId: 'a1', text: 'Now add tests for it.' });
  assert.deepEqual(await controller.replySuggestion('s'), { itemId: 'a1', text: 'Now add tests for it.' });
  assert.equal(calls.length, 1, 'the same answer never costs a second call');
  assert.equal(calls[0].choice.model, 'gpt');
  assert.deepEqual(JSON.parse(calls[0].request.prompt).conversation.map(entry => entry.role), ['user', 'assistant']);
  assert.ok(calls[0].request.schema.required.includes('suggestion'));
});

test('no suggestion when the setting is off, a turn is running, the user spoke last, or the model cannot reply in JSON', async () => {
  assert.equal(await chat({ enabled: false }).controller.replySuggestion('s'), null);

  const busy = chat();
  busy.controller.busy = 's';
  assert.equal(await busy.controller.replySuggestion('s'), null);

  const userLast = chat({ items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Hi' }] }] });
  assert.equal(await userLast.controller.replySuggestion('s'), null);

  const muse = chat({ route: { id: 'native:muse:m', provider: 'native:muse', model: 'm' } });
  assert.equal(await muse.controller.replySuggestion('s'), null);
  assert.equal(muse.calls.length, 0);

  const empty = chat({ reply: { suggestion: '   ' } });
  assert.equal(await empty.controller.replySuggestion('s'), null, 'an empty suggestion shows nothing');

  const failing = chat();
  failing.controller.smartRouter.complete = async () => { throw new Error('Model unavailable.'); };
  assert.equal(await failing.controller.replySuggestion('s'), null, 'a failed call shows nothing and does not throw');
});

test('Main Bot result returns make no extra suggestion call, while ordinary chats retain suggestions', async () => {
  const { controller, session, calls } = chat();
  controller.isCoordinator = () => true;
  session.items[0].agentReply = true;
  assert.equal(await controller.replySuggestion('s'), null);
  assert.equal(calls.length, 0);
  delete session.items[0].agentReply;
  assert.ok(await controller.replySuggestion('s'));
  assert.equal(calls.length, 1);
});
