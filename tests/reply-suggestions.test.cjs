const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const suggestions = require('../src/controller/suggestions.cjs');

// A controller stand-in with just what replySuggestion reads.
function chat({ enabled = true, items, route = { id: 'codex:gpt:low', provider: 'codex', model: 'gpt' }, reply = { suggestion: 'Now add tests for it.' } } = {}) {
  const calls = [];
  const session = { id: 's', items: items || [
    { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Write a parser.' }] },
    { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: 'Here is the parser.' },
  ], routes: route ? [route] : [], queue: [] };
  const controller = Object.assign({
    data: { settings: { replySuggestions: enabled } }, busy: null, log: { warn() {} }, changed() {},
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

test('no suggestion when the setting is off, a turn is running or the user spoke last; a Muse chat gets one like any other', async () => {
  assert.equal(await chat({ enabled: false }).controller.replySuggestion('s'), null);

  const busy = chat();
  busy.controller.busy = 's';
  assert.equal(await busy.controller.replySuggestion('s'), null);

  const userLast = chat({ items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Hi' }] }] });
  assert.equal(await userLast.controller.replySuggestion('s'), null);

  const muse = chat({ route: { id: 'native:muse:m', provider: 'native:muse', model: 'm' } });
  assert.deepEqual(await muse.controller.replySuggestion('s'), { itemId: 'a1', text: 'Now add tests for it.' });
  assert.equal(muse.calls[0].choice.provider, 'native:muse');

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

// /wiki (2026-10-25): the quick model suggests wiki changes from the chat and the docs/wiki index; nothing is written.
test('/wiki suggestions come from the chat and the wiki index, as a notice that writes nothing', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-wiki-suggest-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  fs.mkdirSync(path.join(workspace, 'docs', 'wiki'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'docs', 'wiki', 'index.md'), '# Wiki\n- [Rendering](rendering.md)\n');
  const reply = { suggestions: [{ page: 'docs/wiki/rendering.md', change: 'Shadow maps use 4 cascades (src/shadow.cpp:12).', reason: 'A decision.' }] };
  const { controller, session, calls } = chat({ reply });
  Object.assign(session, { workspace });
  Object.assign(controller, { save() {}, changed() {} });
  assert.equal(await controller.suggestWiki('s'), 1);
  const sent = JSON.parse(calls[0].request.prompt);
  assert.match(sent.wikiIndex, /Rendering/);
  assert.deepEqual(sent.conversation.map(entry => entry.role), ['user', 'assistant']);
  assert.ok(calls[0].request.schema.required.includes('suggestions'));
  const notice = session.items.at(-1);
  assert.equal(notice.type, 'notice');
  assert.deepEqual(notice.wikiSuggestion.suggestions, reply.suggestions);
  assert.deepEqual(fs.readdirSync(path.join(workspace, 'docs', 'wiki')), ['index.md'], 'nothing is written');

  const none = chat({ reply: { suggestions: [] } });
  Object.assign(none.session, { workspace });
  Object.assign(none.controller, { save() {}, changed() {} });
  assert.equal(await none.controller.suggestWiki('s'), 0);
  assert.equal(none.session.items.at(-1).wikiSuggestion, undefined);
  assert.match(none.session.items.at(-1).text, /No durable wiki update/);

  const fresh = chat({ route: null });
  await assert.rejects(fresh.controller.suggestWiki('s'), /send it a message first/);
});

test('/wiki and reply suggestions skip a reply Jev gave itself and use the last worker model', async t => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-wiki-jev-'));
  t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
  const { controller, session, calls } = chat({ reply: { suggestions: [] } });
  session.routes.push({ id: 'jev', model: 'jev-1.14.0', label: 'Jev', directAnswer: 'Yes.' });
  Object.assign(session, { workspace });
  Object.assign(controller, { save() {}, changed() {} });
  assert.equal(await controller.suggestWiki('s'), 0);
  assert.equal(calls[0].choice.model, 'gpt', 'the worker before the Jev answer writes the suggestions');
});

test('/suggestion asks for one suggestion even when the setting is off, and the setting still stops the automatic one', async () => {
  const { controller, calls } = chat({ enabled: false });
  assert.equal(await controller.replySuggestion('s'), null, 'automatic suggestions stay off');
  assert.deepEqual(await controller.suggestNext('s'), { itemId: 'a1', text: 'Now add tests for it.' });
  assert.equal(calls.length, 1, 'one extra call, for this answer only');
  assert.deepEqual(await controller.suggestNext('s'), { itemId: 'a1', text: 'Now add tests for it.' });
  assert.equal(calls.length, 1, 'the same answer is not asked twice');
});

test('/tldr summarizes the last answer as a local notice with the quick model', async () => {
  const { controller, session, calls } = chat({ reply: { tldr: 'The parser is written.' } });
  Object.assign(controller, { save() {}, changed() {} });
  assert.equal(await controller.summarizeLast('s'), 'The parser is written.');
  assert.equal(calls[0].choice.model, 'gpt');
  assert.equal(JSON.parse(calls[0].request.prompt).message, 'Here is the parser.');
  const notice = session.items.at(-1);
  assert.equal(notice.type, 'notice');
  assert.equal(notice.localOnly, true);
  assert.equal(notice.tldr, true, 'shown even when steps are hidden');
  assert.equal(notice.provider, 'codex', 'labelled with the summarizing model, like an answer');
  assert.equal(notice.text, 'TL;DR: The parser is written.');
  const empty = chat({ items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Hi' }] }] });
  await assert.rejects(empty.controller.summarizeLast('s'), /no answer to summarize/);
});

// 2026-11-13, the user: a stuck worker asks for advice, token-efficiently.
test('ask_advisor uses the chat model at its highest effort, caps input and calls, and repeats earlier advice for the same error', async () => {
  const { controller, session, calls } = chat({ route: { messageId: 'turn1', model: 'm', provider: 'codex', label: 'M' }, reply: { advice: '1. Check the path.' } });
  controller.catalog = () => [{ model: 'm', provider: 'codex', effort: 'low', label: 'M low' }, { model: 'm', provider: 'codex', effort: 'xhigh', label: 'M xhigh' }];
  const ask = error => controller.askAdvisor(session, { goal: 'Build', tried: 'Ran make twice', error });
  assert.deepEqual(await ask('ENOENT x'), { advice: '1. Check the path.', by: 'M xhigh' });
  assert.equal(calls[0].choice.effort, 'xhigh');
  assert.deepEqual(session.items.filter(item => item.advisor).map(item => [item.type, item.text]), [['notice', '**Advisor:** 1. Check the path.']], 'shown as a chat bubble');
  assert.equal((await ask('  enoent   X ')).repeated, true, 'the same error costs nothing');
  assert.equal(calls.length, 1);
  await ask('Other error');
  await assert.rejects(ask('Third error'), /already asked 2 times/);
  await assert.rejects(controller.askAdvisor(session, { goal: 'x', tried: 'y'.repeat(2001), error: 'z' }), /at most 2000 characters/);
  session.routes.push({ messageId: 'turn2', model: 'm', provider: 'codex' });
  await ask('Third error');
  assert.equal(calls.length, 3, 'a new turn has its own two calls');
});

test('ask_advisor uses the Advisor model picked in Settings', async () => {
  const { controller, calls } = chat({ route: { messageId: 'turn1', model: 'm', provider: 'codex' }, reply: { advice: '1. Retry.' } });
  controller.catalog = () => [{ id: 'm-low', model: 'm', provider: 'codex', effort: 'low' }, { id: 'big:xhigh', model: 'big', provider: 'claude-cli', effort: 'xhigh', label: 'Big xhigh' }];
  controller.data.settings.advisorModel = 'big:xhigh';
  assert.equal((await controller.askAdvisor(controller.session('s'), { goal: 'g', tried: 't', error: 'e' })).by, 'Big xhigh');
  assert.equal(calls[0].choice.id, 'big:xhigh');
});

// 2026-11-13, the user: /advisor any time, and every case where the advisor is unavailable.
test('an unavailable Advisor model falls back to the chat model and says so; with neither, the reason is given', async () => {
  const { controller, session, calls } = chat({ route: { messageId: 'turn1', model: 'm', provider: 'codex' }, reply: { advice: '1. Retry.' } });
  controller.catalog = () => [{ id: 'm:xhigh', model: 'm', provider: 'codex', effort: 'xhigh', label: 'M xhigh' }, { id: 'big:xhigh', model: 'big', provider: 'claude-cli', effort: 'xhigh', label: 'Big xhigh' }];
  controller.data.settings.advisorModel = 'big:xhigh';
  controller.available = p => p.id !== 'big:xhigh';
  const result = await controller.askAdvisor(session, { goal: 'g', tried: 't', error: 'e1' });
  assert.equal(result.by, 'M xhigh');
  assert.match(result.note, /picked advisor \(Big xhigh\) is unavailable; M xhigh advised instead/);
  assert.match(session.items.at(-1).text, /_The picked advisor \(Big xhigh\) is unavailable/);
  controller.available = () => false;
  await assert.rejects(controller.askAdvisor(session, { goal: 'g', tried: 't', error: 'e2' }), /No advisor is available: The picked advisor \(Big xhigh\) is unavailable, and this chat’s model is unavailable too/);
  assert.equal(calls.length, 1);
});

test('/advisor asks about the chat with an optional question, shown as a bubble; a chat with no answer uses the bot’s own model', async () => {
  const { controller, session, calls } = chat({ route: { messageId: 'turn1', model: 'm', provider: 'codex' }, reply: { advice: '1. Add a test.' } });
  controller.catalog = () => [{ id: 'm:xhigh', model: 'm', provider: 'codex', effort: 'xhigh', label: 'M xhigh' }];
  await controller.adviseChat('s', 'Is the parser safe?');
  const sent = JSON.parse(calls[0].request.prompt);
  assert.deepEqual(sent, { question: 'Is the parser safe?', latestRequest: 'Write a parser.', latestAnswer: 'Here is the parser.' });
  assert.equal(session.items.at(-1).text, '**Advisor (you asked: Is the parser safe?):** 1. Add a test.');
  await assert.rejects(controller.adviseChat('s', 'x'.repeat(4001)), /under 4000 characters/);

  const empty = chat({ items: [], route: null, reply: { advice: '1. Start small.' } });
  empty.controller.catalog = () => [{ id: 'f:high', model: 'f', provider: 'claude-cli', effort: 'high' }, { id: 'f:xhigh', model: 'f', provider: 'claude-cli', effort: 'xhigh', label: 'F xhigh' }];
  await assert.rejects(empty.controller.adviseChat('s'), /Type your message after \/advisor/);
  await assert.rejects(empty.controller.adviseChat('s', '   '), /Type your message after \/advisor/);
  empty.controller.data.settings.mode = 'autoeffort:claude-cli:f';
  assert.equal((await empty.controller.adviseChat('s', 'Where do I start?')).by, 'F xhigh');
});

test('the default advisor is the bot’s model at the highest effort its Effort cap allows; Off has no advisor', async () => {
  const { controller, session, calls } = chat({ route: { messageId: 'turn1', model: 'm', provider: 'codex' }, reply: { advice: '1. Retry.' } });
  controller.catalog = () => ['low', 'high', 'xhigh'].map(effort => ({ id: `m:${effort}`, model: 'm', provider: 'codex', effort, label: `M ${effort}` }));
  controller.data.settings.effortCap = 'high';
  assert.equal((await controller.askAdvisor(session, { goal: 'g', tried: 't', error: 'e' })).by, 'M high');
  controller.data.settings.effortCap = 'max';
  assert.equal((await controller.askAdvisor(session, { goal: 'g', tried: 't', error: 'e2' })).by, 'M xhigh');
  controller.data.settings.advisorModel = 'off';
  await assert.rejects(controller.adviseChat('s', 'Why?'), /No advisor is available: This bot’s Advisor is Off/);
  assert.equal(calls.length, 2);
  // 2026-11-24, the user: a failed slash command says why in its chat, as a local bubble.
  controller.save = () => {};
  assert.equal(controller.commandFailed('s', 'advisor', new Error('No advisor is available.')), true);
  const failure = session.items.at(-1);
  assert.deepEqual([failure.type, failure.localOnly, failure.commandFailure, failure.text], ['notice', true, true, '**/advisor failed:** No advisor is available.']);
  assert.equal(controller.commandFailed('missing', 'advisor', new Error('x')), false, 'no chat to write in');
});
