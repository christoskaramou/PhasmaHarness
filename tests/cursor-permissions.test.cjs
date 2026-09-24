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
