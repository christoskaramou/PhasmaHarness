const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CursorCLI } = require('../src/providers/cursor.cjs');

// Replace the ACP transport; capture the permission handler run() installs and answer one request with it.
async function decide({ access, schema, approve }) {
  const cursor = new CursorCLI();
  let onRequest;
  cursor.connect = options => {
    onRequest = options.onRequest;
    return { call: async (method) => {
      if (method === 'session/new') return { sessionId: 's' };
      if (method === 'session/prompt') return { stopReason: 'end_turn' };
      return {};
    }, close() {} };
  };
  await cursor.run({ model: 'm', prompt: 'x', access, schema, approve });
  const result = await onRequest('session/request_permission', {
    toolCall: { title: 'Run ninja' },
    options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }],
  });
  return { choice: result.outcome.optionId };
}

test('Cursor asks the Harness in Ask and Workspace access, auto-allows only Full access, and never gives classifiers tools', async () => {
  for (const access of ['read-only', 'workspace-write']) {
    const asked = [];
    const approve = async tool => { asked.push(tool); return asked.length === 1; };
    assert.equal((await decide({ access, approve })).choice, 'yes');
    assert.deepEqual(asked, [{ title: 'Run ninja' }], `${access} asks the user`);
    assert.equal((await decide({ access, approve: async () => false })).choice, 'no');
  }
  let askedFull = false;
  assert.equal((await decide({ access: 'danger-full-access', approve: async () => { askedFull = true; return false; } })).choice, 'yes');
  assert.equal(askedFull, false);
  let askedClassifier = false;
  assert.equal((await decide({ access: 'danger-full-access', schema: { type: 'object' }, approve: async () => { askedClassifier = true; return true; } })).choice, 'no');
  assert.equal(askedClassifier, false);
  assert.equal((await decide({ access: 'read-only' })).choice, 'no', 'no approval callback means decline');
});

// A fake ACP transport whose first prompt waits until session/cancel, like Cursor, and records what was sent.
function steerable() {
  const cursor = new CursorCLI(), prompts = [], notes = [];
  let onRequest, cancel;
  cursor.connect = options => {
    onRequest = options.onRequest;
    return {
      child: null,
      notify: (method, params) => { notes.push([method, params]); if (method === 'session/cancel') cancel?.(); },
      call: async (method, params) => {
        if (method === 'session/new') return { sessionId: 's' };
        if (method !== 'session/prompt') return {};
        prompts.push(params);
        if (prompts.length === 1) return new Promise(resolve => { cancel = () => resolve({ stopReason: 'cancelled' }); });
        return { stopReason: 'end_turn' };
      },
      close() {},
    };
  };
  return { cursor, prompts, notes, request: (...args) => onRequest(...args) };
}

test('Send now cancels the Cursor step and prompts again in the same session; a plain follow-up is refused', async () => {
  const { cursor, prompts, notes } = steerable();
  let input = null;
  const running = cursor.run({ model: 'm', prompt: 'Build it.', access: 'workspace-write', onInput: fn => { if (fn) input = fn; } });
  for (let i = 0; i < 200 && !(input && prompts.length); i++) await new Promise(resolve => setTimeout(resolve, 5));
  await assert.rejects(input({ id: 'q', text: 'Later.', images: [] }, { steer: false }), /one prompt at a time/);
  await input({ id: 'now', text: 'Use the new requirement.', images: [] }, { steer: true });
  await running;
  assert.deepEqual(notes, [['session/cancel', { sessionId: 's' }]]);
  assert.deepEqual(prompts.map(params => params.sessionId), ['s', 's']);
  assert.equal(prompts[1].prompt[0].text, 'Use the new requirement.');
  await assert.rejects(input({ id: 'late', text: 'Too late.', images: [] }, { steer: true }), /no longer accepting/);
});

test('an Allow answered after Cursor Send now does not approve anything', async () => {
  const { cursor, prompts, request } = steerable();
  let input = null, answer;
  const running = cursor.run({ model: 'm', prompt: 'Build it.', access: 'workspace-write', onInput: fn => { if (fn) input = fn; },
    approve: () => new Promise(resolve => { answer = resolve; }) });
  for (let i = 0; i < 200 && !(input && prompts.length); i++) await new Promise(resolve => setTimeout(resolve, 5));
  const asked = request('session/request_permission', { toolCall: { title: 'Run ninja' },
    options: [{ optionId: 'yes', kind: 'allow_once' }, { optionId: 'no', kind: 'reject_once' }] });
  await input({ id: 'now', text: 'Change course.', images: [] }, { steer: true });
  answer(true);
  assert.equal((await asked).outcome.optionId, 'no', 'the old step’s approval was withdrawn by Send now');
  await running;
});
