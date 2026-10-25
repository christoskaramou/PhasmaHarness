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

test('a long answer reaches the suggestion model with its ending and a marked omission, not cut mid-sentence', async () => {
  const answer = 'Start. ' + 'x'.repeat(3000) + ' It ends with this sentence.';
  const { controller, calls } = chat({ items: [
    { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Explain it.' }] },
    { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: answer },
  ] });
  await controller.replySuggestion('s');
  const sent = JSON.parse(calls[0].request.prompt).conversation[1].text;
  assert.ok(sent.startsWith('Start. ') && sent.endsWith('It ends with this sentence.'));
  assert.match(sent, /\[… 1535 characters omitted …\]/);
  assert.ok(sent.length < 1600);
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

test('direct group replies do not reuse an earlier Main Bot route for suggestions', async () => {
  const { controller, session, calls } = chat();
  session.group = { members:['worker'] };
  session.groupTurn = { agentId:'worker', state:'waiting' };
  assert.equal(await controller.replySuggestion('s'), null, 'waiting for a member is still active work');
  session.items.at(-1).groupSpeaker = { id:'worker', name:'Worker' };
  delete session.groupTurn;
  assert.equal(await controller.replySuggestion('s'), null, 'a member reply must not trigger the old Main model');
  assert.equal(calls.length, 0);
  session.items.push({ id:'a2', type:'agentMessage', text:'Main Bot answered a new question.' });
  assert.ok(await controller.replySuggestion('s'), 'ordinary Main replies still allow suggestions');
  assert.equal(calls.length, 1);
});

test('a reply suggestion uses the answer’s model at its lowest available effort', async () => {
  const route = { id: 'codex:gpt:xhigh', provider: 'codex', model: 'gpt', effort: 'xhigh' };
  const { controller, calls } = chat({ route });
  controller.catalog = () => [route, { id: 'codex:gpt', provider: 'codex', model: 'gpt' }, { id: 'codex:gpt:medium', provider: 'codex', model: 'gpt', effort: 'medium' },
    { id: 'codex:gpt:low', provider: 'codex', model: 'gpt', effort: 'low' }, { id: 'claude:gpt:low', provider: 'claude-cli', model: 'gpt', effort: 'low' },
    { id: 'codex:other:minimal', provider: 'codex', model: 'other', effort: 'minimal' }];
  await controller.replySuggestion('s');
  assert.equal(calls[0].choice.id, 'codex:gpt:low');
});
