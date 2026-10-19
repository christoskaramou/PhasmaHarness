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

test('background quota reserve uses valid saved reports, respects resets and never invents unknown allowance', () => {
  let now = 1000;
  const quotas = {}, limits = new ProviderLimits({}, () => now, quotas);
  assert.equal(limits.backgroundGuard('codex'), null);
  limits.setUsage('codex', { primary: { usedPercent: 92, resetsAt: 10 }, credits: { unlimited: true } });
  assert.equal(limits.backgroundGuard('codex').usedPercent, 92);
  assert.equal(limits.backgroundGuard('codex').until, 10000);
  assert.equal(limits.backgroundGuard('codex', 95), null);
  limits.setUsage('codex', { primary: { usedPercent: '0' }, secondary: { usedPercent: -1 } });
  assert.equal(limits.backgroundGuard('codex').usedPercent, 92, 'malformed updates do not erase a valid reserve');
  const restored = new ProviderLimits({}, () => now, JSON.parse(JSON.stringify(quotas)));
  assert.equal(restored.backgroundGuard('codex').usedPercent, 92);
  assert.equal(restored.backgroundGuard('native:muse'), null);
  now = 10000;
  assert.equal(restored.backgroundGuard('codex'), null);
  limits.setUsage('codex', { secondary: { usedPercent: 95 } });
  now += UNKNOWN_RESET_MS * 2;
  assert.equal(limits.backgroundGuard('codex').until, null, 'no reset time is guessed');
  limits.setUsage('codex', { secondary: { usedPercent: 12 } });
  assert.equal(limits.backgroundGuard('codex'), null);
  limits.setUsage('codex', { secondary: { usedPercent: 105 } });
  assert.equal(limits.backgroundGuard('codex').usedPercent, 105, 'a report beyond 100% is not discarded');
});

test('Claude allowance reserves distinguish overall and model windows, persist only known data and bind it to native account metadata', () => {
  let now = Date.parse('2026-10-18T09:00:00Z');
  const quotas = {}, limits = new ProviderLimits({}, () => now, quotas);
  const report = { rate_limits_available: true, subscription_type: 'max', behaviors: { private: 'do not persist' },
    session: { private: 'do not persist' }, rate_limits: {
      five_hour: { utilization: 20, resets_at: '2026-10-18T10:00:00Z' },
      seven_day: { utilization: 40, resets_at: '2026-10-25T09:00:00Z' },
      seven_day_opus: { utilization: 95, resets_at: '2026-10-25T09:00:00Z' },
      seven_day_sonnet: { utilization: '90', resets_at: null },
    } };
  limits.setUsage('claude-cli', report, 'account-one');
  assert.equal(limits.backgroundGuard('claude-cli', 90, 'claude-sonnet-5', 'account-one'), null);
  assert.equal(limits.backgroundGuard('claude-cli', 90, 'claude-opus-5', 'account-two'), null);
  assert.equal(limits.backgroundGuard('claude-cli', 90, 'claude-opus-5', 'account-one').usedPercent, 95);
  assert.equal(quotas['claude-cli'].seven_day_sonnet, undefined);
  assert.doesNotMatch(JSON.stringify(limits.usage), /do not persist/);
  limits.setUsage('claude-cli', { rate_limits_available: false }, 'account-one');
  assert.equal(limits.usage['claude-cli'].available, false);
  assert.equal(limits.backgroundGuard('claude-cli', 90, 'claude-opus-5', 'account-one').usedPercent, 95);
  const restored = new ProviderLimits({}, () => now, JSON.parse(JSON.stringify(quotas)));
  assert.equal(restored.backgroundGuard('claude-cli', 90, 'claude-opus-5', 'account-one').usedPercent, 95);
  now = Date.parse('2026-10-25T09:00:00Z');
  assert.equal(restored.backgroundGuard('claude-cli', 90, 'claude-opus-5', 'account-one'), null);
});

test('Claude CLI/SDK and opaque model allowance windows remain explicit, with unknown scopes protected conservatively', () => {
  const limits = new ProviderLimits();
  limits.setUsage('claude-cli', { rate_limits_available: true, rate_limits: {
    seven_day_oauth_apps: { utilization: 91, resets_at: 'not an ISO date' },
  } }, 'account');
  assert.equal(limits.backgroundGuard('claude-cli', 90, 'claude-sonnet-5', 'account').until, null);
  limits.setUsage('claude-cli', { rate_limits_available: true, rate_limits: {
    seven_day_oauth_apps: { utilization: 12 },
    model_scoped: [{ display_name: 'Fable', utilization: 94 }, { display_name: 'Opus', utilization: 96 }],
  } }, 'account');
  assert.match(limits.backgroundGuard('claude-cli', 90, 'claude-sonnet-5', 'account').reason, /Fable.*model scope is unavailable/);
  assert.match(limits.backgroundGuard('claude-cli', 90, 'claude-opus-5', 'account').reason, /Opus/);
  limits.setUsage('claude-cli', { rate_limits_available: true, rate_limits: {
    model_scoped: [{ display_name: 'Opus', utilization: 96 }, { display_name: 'Fable', utilization: 'unknown' }],
  } }, 'account');
  assert.match(limits.backgroundGuard('claude-cli', 90, 'claude-sonnet-5', 'account').reason, /Fable/);
  limits.setUsage('claude-cli', { rate_limits_available: true, rate_limits: {
    model_scoped: [{ display_name: 'Opus', utilization: 96 }],
  } }, 'other-account');
  assert.match(limits.backgroundGuard('claude-cli', 90, 'claude-sonnet-5', 'account').reason, /Fable/);
  limits.setUsage('claude-cli', { rate_limits_available: true, rate_limits: {
    model_scoped: [{ display_name: 'Opus', utilization: 96 }],
  } }, 'account');
  assert.equal(limits.backgroundGuard('claude-cli', 90, 'claude-sonnet-5', 'account'), null);
  assert.match(limits.backgroundGuard('claude-cli', 90, 'claude-opus-5', 'account').reason, /Opus/);
  limits.setUsage('claude-cli', { rate_limits_available: true, rate_limits: { model_scoped: [] } }, 'account');
  assert.equal(limits.backgroundGuard('claude-cli', 90, 'claude-sonnet-5', 'account'), null);
  limits.setUsage('claude-cli', { rate_limits_available: true, rate_limits: {
    model_scoped: [{ display_name: 'Opus' + ' '.repeat(100) + 'unmapped', utilization: 96 }],
  } }, 'account');
  assert.match(limits.backgroundGuard('claude-cli', 90, 'claude-sonnet-5', 'account').reason, /model scope is unavailable/);
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
