const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ProviderLimits, codexTurnLimited, cursorLimitText, codexWindowReset, UNKNOWN_RESET_MS } = require('../src/providers/limits.cjs');
const { CursorCLI } = require('../src/providers/cursor.cjs');

test('limit detection follows what each CLI reports', () => {
  assert.equal(codexTurnLimited({ codexErrorInfo: 'usageLimitExceeded' }), true);
  assert.equal(codexTurnLimited({ codexErrorInfo: 'rateLimitExceeded' }), true);
  assert.equal(codexTurnLimited({ codexErrorInfo: 'serverOverloaded' }), false);
  assert.equal(codexTurnLimited({ codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 429 } } }), false);
  assert.equal(cursorLimitText('Partial work.\n\nUpgrade your plan to continue'), 'Upgrade your plan to continue');
  assert.equal(cursorLimitText('\n\nAdd a payment method to continue'), 'Add a payment method to continue');
  assert.equal(cursorLimitText('You could upgrade your plan to continue working.'), null);
  assert.equal(codexWindowReset({ primary: { usedPercent: 99, resetsAt: 10 } }, 0), undefined);
  assert.equal(codexWindowReset({ primary: { usedPercent: 100, resetsAt: 10 }, secondary: { usedPercent: 100, resetsAt: 20 } }, 0), 20000);
  assert.equal(codexWindowReset({ secondary: { usedPercent: 100, resetsAt: null } }, 0), null);
  // A full window whose reset has passed is stale, not a limit.
  assert.equal(codexWindowReset({ primary: { usedPercent: 100, resetsAt: 10 } }, 10000), undefined);
  assert.equal(codexWindowReset({ primary: { usedPercent: 100, resetsAt: 10 }, secondary: { usedPercent: 100, resetsAt: 20 } }, 15000), 20000);
});

test('model-family limits cover only their family and never replace each other or the provider-wide one', () => {
  let now = 1000;
  const limits = new ProviderLimits({}, () => now);
  limits.mark('claude-cli', { until: 9000, family: 'opus' });
  assert.ok(limits.limited('claude-cli', 'claude-opus-5-5'));
  assert.equal(limits.limited('claude-cli', 'claude-sonnet-5'), null);
  assert.equal(limits.limited('claude-cli'), null, 'the provider as a whole is still usable');
  limits.mark('claude-cli', { until: 8000, family: 'sonnet' });
  assert.ok(limits.limited('claude-cli', 'claude-opus-5-5'), 'a Sonnet limit keeps the Opus one');
  limits.mark('claude-cli', { until: 3000 });
  assert.ok(limits.limited('claude-cli', 'claude-haiku-5'));
  assert.deepEqual(Object.keys(limits.active()).sort(), ['claude-cli', 'claude-cli:opus', 'claude-cli:sonnet']);
  now = 3000;
  assert.equal(limits.limited('claude-cli', 'claude-haiku-5'), null);
  assert.ok(limits.limited('claude-cli', 'claude-opus-5-5'), 'a shorter provider-wide limit expiring does not lift the weekly Opus one');
  limits.clear('claude-cli', 'claude-sonnet-5');
  assert.equal(limits.limited('claude-cli', 'claude-sonnet-5'), null, 'a Sonnet success lifts only what covers Sonnet');
  assert.ok(limits.limited('claude-cli', 'claude-opus-5-5'));
});

test('limits expire at their reset, or after a default wait when none was reported', () => {
  let now = 1000;
  const store = {};
  const limits = new ProviderLimits(store, () => now);
  limits.mark('claude-cli', { until: 5000, reason: 'x' });
  limits.mark('cursor-cli', { until: null });
  assert.equal(limits.limited('claude-cli').known, true);
  assert.equal(limits.limited('cursor-cli').until, 1000 + UNKNOWN_RESET_MS);
  now = 5000;
  assert.equal(limits.limited('claude-cli'), null);
  assert.equal(store['claude-cli'], undefined, 'expired entries leave the persisted store');
  assert.deepEqual(Object.keys(limits.active()), ['cursor-cli']);
});

test('Cursor turns ending with its plan-limit line fail with a limit', async () => {
  const cursor = new CursorCLI();
  let onUpdate;
  cursor.connect = options => { onUpdate = options.onUpdate; return { call: async method => {
    if (method === 'session/new') return { sessionId: 's' };
    if (method === 'session/prompt') { onUpdate({ sessionId: 's', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '\n\nUpgrade your plan to continue' } } }); return { stopReason: 'end_turn' }; }
    return {};
  }, close() {} }; };
  await assert.rejects(cursor.run({ model: 'auto', prompt: 'x', access: 'read-only' }), error => error.limit && /Upgrade your plan/.test(error.message));
});
