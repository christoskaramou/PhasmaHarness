const { test } = require('node:test');
const assert = require('node:assert/strict');
const { verifyHelp } = require('../src/providers/contracts.cjs');
const { isSubBot, inheritedSource, backgroundView } = require('../ui/agent-state.js');
const { reportAnswer } = require('../ui/report-format.js');

test('provider checks reject removed required flags rather than accepting longer lookalikes', () => {
  verifyHelp('codex', 'Options:\n  --stdio\n  -c, --config <KEY=VALUE>');
  assert.throws(() => verifyHelp('codex', '--stdio --config-file <FILE>'), /missing --config/);
  assert.throws(() => verifyHelp('codex', ''), /missing --stdio, --config/);
  assert.throws(() => verifyHelp('unknown', '--config'), /Unknown provider/);
});

test('shared delegation rules lock queued normal bots, release completed bots and keep sub-bots managed', () => {
  const context = { conversationId: 'job', sessions: [{ id: 'job', items: [], delegation: { owner: 'main-chat', delivered: false } }] };
  const fleet = { agents: [{ id: 'worker', createdBy: 'main' }], executionStates: { worker: context }, agentStates: { worker: { sessions: [] } } };
  assert.equal(backgroundView(fleet, 'worker'), context, 'queued work has no messages yet');
  context.sessions[0].delegation.delivered = true; assert.equal(backgroundView(fleet, 'worker'), null);
  fleet.agents[0].createdBy = 'parent'; assert.equal(isSubBot(fleet.agents[0]), true);
  assert.equal(backgroundView(fleet, 'worker'), context);
  const child = { id: 'child', createdBy: 'parent', inheritAccess: true, access: 'danger-full-access' };
  assert.equal(inheritedSource(child, 'access', [child], 'workspace').value, 'read-only', 'missing owner fails closed');
  assert.equal(inheritedSource(child, 'access', [child, { id: 'parent', createdBy: 'child', inheritAccess: true }], 'workspace').value, 'read-only');
});

test('shared report parser retains the final substantive reply and quoted task markers', () => {
  assert.equal(reportAnswer({ text: 'Queued\n[task: pending]\nCompleted\n[task: done]' }), 'Completed');
  assert.equal(reportAnswer({ text: 'Answer\n```\n[task: pending]\n```\n[task: done]' }), 'Answer\n```\n[task: pending]\n```');
  assert.equal(reportAnswer({ finalReport: true, text: 'Literal [task: done]' }), 'Literal [task: done]');
});
