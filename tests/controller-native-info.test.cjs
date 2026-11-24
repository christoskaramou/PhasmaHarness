const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Controller } = require('../src/controller.cjs');
const { SessionStore, readSessionData } = require('../src/session-store.cjs');
const { claudeDisplayEvents, handoff } = require('../src/providers/claude.cjs');

function fixture() {
  const session = { id: 'chat', threadId: 'th', access: 'read-only', items: [], routes: [], submission: { threadId: 'th', turnId: 'turn', kind: 'turn' } };
  const controller = Object.assign(Object.create(Controller.prototype), {
    data: { sessions: [session], settings: {} }, changed() {}, save() {}, workerInstructions: () => '', workspace: () => '.',
    loadedModelConfigs: new Map(), loadedInstructions: new Map(), loaded: new Set(),
  });
  const notify = (method, p) => controller.notification({ method, params: { turnId: 'turn', threadId: 'th', ...p } });
  return { controller, session, notify };
}

test('Codex task-plan snapshots and proposed-plan text stream independently and keep the native final', () => {
  const { session, notify } = fixture();
  const plan = status => notify('turn/plan/updated', { explanation: 'Investigate', plan: [{ step: 'Read files', status }] });
  plan('pending'); plan('completed');
  notify('item/plan/delta', { itemId: 'p', delta: 'Proposed' });
  assert.deepEqual(session.items.map(i => [i.type, i.kind, i.text]), [
    ['info', 'progress', 'Investigate\ncompleted: Read files'], ['plan', undefined, 'Proposed']]);
  notify('item/completed', { item: { type: 'plan', id: 'p', text: 'Final proposal' } });
  assert.equal(session.items.length, 2); assert.equal(session.items[1].text, 'Final proposal');
  assert.equal(handoff(session.items), '');
});

test('Codex child thread metadata joins the originating turn, never child prose or an unrelated turn', () => {
  const { controller, session, notify } = fixture();
  controller.notification({ method: 'thread/started', params: { thread: { id: 'kid', parentThreadId: 'th', agentNickname: 'Iris',
    agentRole: 'explorer', preview: 'PRIVATE', source: { subAgent: { thread_spawn: { parent_thread_id: 'th', depth: 1 } } } } } });
  notify('item/reasoning/summaryTextDelta', { threadId: 'kid', turnId: 'childTurn', itemId: 'r', summaryIndex: 0, delta: 'Early ' });
  assert.equal(session.items.length, 0, 'a parent thread id alone is not an originating turn id');
  notify('item/started', { item: { type: 'subAgentActivity', id: 's', kind: 'started', agentThreadId: 'kid', agentPath: '/work' } });
  session.submission.turnId = 'next';
  notify('item/agentMessage/delta', { threadId: 'kid', turnId: 'childTurn', itemId: 'secret', delta: 'PRIVATE' });
  notify('thread/status/changed', { threadId: 'kid', status: { type: 'idle' } });
  assert.equal(session.items.length, 2);
  assert.match(session.items[0].text, /Iris/); assert.match(session.items[0].text, /explorer/);
  assert.match(session.items[0].text, /idle/); assert.equal(session.items[0].turnId, 'turn');
  notify('item/reasoning/textDelta', { threadId: 'kid', turnId: 'childTurn', itemId: 'r', delta: 'PRIVATE' });
  notify('item/reasoning/summaryTextDelta', { threadId: 'kid', turnId: 'childTurn', itemId: 'r', summaryIndex: 0, delta: 'Public check' });
  notify('item/completed', { threadId: 'kid', turnId: 'childTurn', item: { type: 'reasoning', id: 'r', summary: [], content: ['PRIVATE'] } });
  assert.deepEqual(session.items.slice(1).map(i => [i.title, i.text, i.status, i.turnId]), [['Iris · Thinking', 'Early Public check', 'completed', 'turn']]);
  controller.codexChildMetadata.clear();
  notify('thread/status/changed', { threadId: 'kid', status: { type: 'active', activeFlags: ['waitingOnApproval'] } });
  assert.match(session.items[0].text, /Iris.*explorer.*waitingOnApproval/);
  session.completedTurnIds = ['turn'];
  notify('item/started', { turnId: 'turn', item: { type: 'subAgentActivity', id: 'later', kind: 'started', agentThreadId: 'another-kid' } });
  assert.equal(session.items.at(-1).turnId, 'turn');
  assert.match(session.items.at(-1).text, /another-kid/);
  assert.doesNotMatch(JSON.stringify(session), /PRIVATE/);
});

test('Codex public goals, review decisions and MCP progress are separate from raw actions and final answers', () => {
  const { session, notify } = fixture();
  notify('thread/goal/updated', { goal: { createdAt: 42, objective: 'Run checks', status: 'active' } });
  notify('thread/goal/cleared', {});
  notify('item/mcpToolCall/progress', { itemId: 'tool', message: 'Checking image 2 of 3' });
  notify('item/autoApprovalReview/completed', { reviewId: 'review', review: { status: 'denied', riskLevel: 'high', rationale: 'Outside scope' },
    action: { type: 'writeStdin', stdin: 'PRIVATE' } });
  notify('item/started', { item: { type: 'enteredReviewMode', id: 'a', review: 'Review changes' } });
  notify('item/completed', { item: { type: 'exitedReviewMode', id: 'b', review: 'duplicate final answer' } });
  assert.deepEqual(session.items.map(i => [i.title, i.text, i.status]), [
    ['Goal', 'Run checks', 'cleared'], ['Tool progress', 'Checking image 2 of 3', undefined],
    ['Approval review', 'Risk: high\nOutside scope', 'denied'], ['Code review', 'Review changes', 'completed']]);
  assert.doesNotMatch(JSON.stringify(session.items), /PRIVATE|duplicate final answer/);
});

test('Claude publishes status summaries, compaction checkpoints and token-only thinking, not private payloads', () => {
  const { controller, session } = fixture();
  const emit = claudeDisplayEvents(e => { if (e.type === 'info') controller.recordInfo(session, 'turn', e); });
  const sys = (subtype, fields) => emit({ type: 'system', subtype, ...fields });
  sys('task_summary', { detail: 'Reading', uuid: '1' }); sys('task_summary', { detail: 'Testing', uuid: '2' });
  emit({ type: 'tool_use_summary', summary: 'Checked the source', uuid: '3' });
  sys('thinking_tokens', { estimated_tokens: 128, estimated_tokens_delta: 128, user_message_uuid: 'q' });
  sys('status', { status: 'compacting' });
  sys('compact_boundary', { compact_metadata: { trigger: 'auto', pre_tokens: 1000, post_tokens: 100, preserved_segment: { head_uuid: 'PRIVATE' } } });
  assert.deepEqual(session.items.map(i => i.kind), ['progress', 'progress', 'reasoning', 'progress']);
  const text = JSON.stringify(session.items);
  for (const expected of ['Testing', 'Checked the source', 'Thinking', 'auto']) assert.ok(text.includes(expected));
  assert.doesNotMatch(text, /PRIVATE|Reading/);
});

test('Claude resumed tasks retain the original turn and scope; task progress is separate from shell output', () => {
  const { session, controller } = fixture();
  const parser = turn => claudeDisplayEvents((e, task) => {
    if (e.type === 'info') controller.recordInfo(session, turn, e, task);
  }, 'session', session.items);
  const sys = (emit, subtype, fields) => emit({ type: 'system', subtype, session_id: 'session', ...fields });
  const first = parser('first');
  sys(first, 'task_started', { task_id: 'a', run_id: '1', task_type: 'local_agent', subagent_type: 'Explore',
    prompt: 'Check fixtures', parent_task_id: 'parent', spawn_depth: 2, description: 'Inspect' });
  session.items = JSON.parse(JSON.stringify(session.items));
  const second = parser('next');
  sys(second, 'task_notification', { task_id: 'a', run_id: '1', status: 'completed', summary: 'Tested', usage: { tool_uses: 3, duration_ms: 27 } });
  sys(second, 'task_started', { task_id: 'a', run_id: '2', task_type: 'local_agent', description: 'New run' });
  sys(second, 'task_notification', { task_id: 'a', run_id: '1', status: 'stopped', summary: 'Stale' });
  sys(second, 'task_started', { task_id: 'm', task_type: 'mcp_task', description: 'Build' });
  sys(second, 'task_progress', { task_id: 'm', summary: 'Halfway', output: 'PRIVATE' });
  assert.deepEqual(session.items.map(i => [i.turnId, i.kind, i.status]), [
    ['first', 'agent', 'completed'], ['next', 'agent', 'running'], ['next', 'progress', 'running']]);
  assert.match(session.items[0].text, /Tested[\s\S]*Check fixtures[\s\S]*parent[\s\S]*Depth: 2[\s\S]*Tool uses: 3/);
  assert.equal(session.items[2].text, 'Halfway');
  assert.doesNotMatch(JSON.stringify(session.items), /PRIVATE|Stale/);
  assert.equal(handoff(session.items), '');
});

test('public checkpoints and task-list patches do not expose snapshot contents or rendered thinking', () => {
  const { controller, session } = fixture();
  const raw = [];
  const emit = claudeDisplayEvents(e => e.type === 'info' ? controller.recordInfo(session, 'turn', e) : raw.push(e));
  const sys = (subtype, fields) => emit({ type: 'system', subtype, uuid: subtype, ...fields });
  sys('thinking', { content: 'PRIVATE' });
  sys('file_snapshot', { content: 'PRIVATE', snapshot_files: [{ key: 'plan', path: 'PRIVATE', content: 'PRIVATE' }] });
  sys('task_list_statuses', { statuses: [{ id: '1', status: 'pending' }, { id: '2', status: 'pending' }] });
  sys('task_list_statuses', { statuses: [{ id: '2', status: 'completed' }] });
  emit({ type: 'user', tool_use_result: { taskId: '1', success: true, statusChange: { from: 'pending', to: 'in_progress' } } });
  assert.deepEqual(session.items.map(i => i.text), ['', 'plan', '1: in_progress\n2: completed']);
  assert.doesNotMatch(JSON.stringify([session, raw]), /PRIVATE/);
});

test('normal Codex worker requests automatic summaries without changing collaboration policy', async () => {
  const { controller, session } = fixture();
  session.featurePolicy = 'tracked';
  const requests = [];
  Object.assign(controller, {
    activeTurns: new Map(), stopping: new Set(), readyToStart: () => null, available: () => true,
    forModel: (_s, _m, text, images) => ({ text, images }), coldStart: async () => null, resume: controller.loadThread,
    client: { async call(method, params) {
      requests.push({ method, params });
      if (method === 'thread/items/list') return { data: [] };
      if (method === 'turn/start') return { turn: { id: 'turn' } };
    } },
    withTaskLessons: (_task, prefix, text) => prefix + text, commitQuickAck() {}, runSetup() {}, sandboxFor: () => ({}),
  });
  await controller.submitWorker(session, { provider: 'codex', model: 'test' }, 'Question', [], 'message');
  assert.equal(requests.find(r => r.method === 'turn/start').params.summary, 'auto');
  assert.equal(requests.find(r => r.method === 'thread/resume').params.config['features.multi_agent'], false);
});

test('Codex public reasoning and agent activity reconcile across deltas, native history and reload', async () => {
  const { controller, session, notify } = fixture();
  const reasoning = { type: 'reasoning', id: 'r', summary: [], content: ['PRIVATE'] };
  session.submission.state = 'submitting'; session.submission.turnId = null; session.submission.buffer = [];
  notify('item/started', { item: reasoning });
  notify('item/reasoning/textDelta', { itemId: 'r', delta: 'PRIVATE' });
  notify('rawResponseItem/completed', { item: { type: 'reasoning', encrypted_content: 'PRIVATE' } });
  assert.doesNotMatch(JSON.stringify(session), /PRIVATE/);
  session.submission.turnId = 'turn'; session.submission.state = 'acknowledged';
  controller.replaySubmission(session, session.submission);
  for (const [summaryIndex, delta] of [[0, 'Exam'], [1, 'Check'], [0, 'ine']])
    notify('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex, delta });
  notify('item/completed', { item: reasoning });
  assert.equal(session.items[0].text, 'Examine\n\nCheck');
  notify('item/completed', { item: { ...reasoning, summary: ['', '  '] } });
  assert.equal(session.items[0].text, 'Examine\n\nCheck', 'blank final parts cannot erase a streamed public summary');
  notify('item/completed', { item: { ...reasoning, summary: ['Final public summary'] } });
  const call = { type: 'collabAgentToolCall', id: 'call', tool: 'spawnAgent', prompt: 'Inspect', model: 'model',
    receiverThreadIds: ['child'], agentsStates: { child: { status: 'running', message: 'Reading' } } };
  notify('item/started', { item: call });
  const end = { type: call.type, id: call.id, agentsStates: { child: { status: 'completed' } } };
  notify('item/completed', { item: end });
  const child = { type: 'subAgentActivity', id: 'a1', agentPath: 'root/check', agentThreadId: 'child', kind: 'started' };
  const childEnd = { type: child.type, id: 'a2', agentThreadId: 'child', kind: 'completed' };
  notify('item/started', { item: child }); notify('item/completed', { item: childEnd });
  const history = [reasoning, call, end, child, childEnd];
  controller.client = { call: async method => method === 'thread/items/list' ?
    { data: history.map(item => ({ item, turnId: 'turn' })) } : {} };
  await controller.loadThread(session, { provider: 'codex', model: 'test' });
  assert.deepEqual(session.items.map(i => [i.kind, i.title, i.status]), [
    ['reasoning', 'Thinking', 'completed'], ['agent', 'spawnAgent', 'completed'], ['agent', 'Subagent', 'completed']]);
  assert.equal(session.items[0].text, 'Final public summary');
  assert.match(session.items[1].text, /Inspect[\s\S]*child · completed · Reading/);
  assert.match(session.items[2].text, /root\/check/);
  assert.doesNotMatch(JSON.stringify(session.items), /PRIVATE/);
  assert.equal(handoff(session.items), '');
});

test('Claude agent lifecycle and thinking are scoped; raw thinking and child replies never reach display', () => {
  const { controller, session } = fixture();
  const other = [];
  const display = claudeDisplayEvents(e => e.type === 'info' ? controller.recordInfo(session, 'turn', e) : other.push(e));
  const sys = (subtype, fields) => display({ type: 'system', subtype, ...fields });
  const task = { task_id: 'a', task_type: 'local_agent', subagent_type: 'Explore', description: 'Inspect' };
  const bash = { task_id: 'b', task_type: 'local_bash', description: 'Compile' };
  sys('background_tasks_changed', { tasks: [task, bash] });
  sys('task_started', { ...task, run_id: '1' }); sys('task_started', bash);
  sys('task_progress', { task_id: 'a', summary: 'Reading files' });
  sys('task_updated', { task_id: 'a', patch: { status: 'paused' } });
  assert.deepEqual([session.items[0].text, session.items[0].status], ['Reading files\nBackground task', 'paused']);
  sys('task_notification', { task_id: 'a', status: 'completed', summary: 'Read 3 files' });
  sys('task_notification', { task_id: 'b', status: 'completed', summary: 'Compiled' });
  sys('background_tasks_changed', { tasks: [] });
  assert.equal(session.items.length, 1);
  assert.deepEqual([session.items[0].title, session.items[0].text, session.items[0].status], ['Explore · a', 'Read 3 files\nBackground task', 'completed']);
  for (const child of [null, 'subtool']) {
    const frame = event => display({ type: 'stream_event', event, parent_tool_use_id: child });
    frame({ type: 'message_start', message: { id: 'm' } });
    frame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'PRIVATE' } });
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'PRIVATE' } });
    frame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'PRIVATE' } });
    frame({ type: 'content_block_stop', index: 0 });
    display({ type: 'assistant', parent_tool_use_id: child, message: { id: 'm', content: [
      { type: 'thinking', thinking: 'PRIVATE', signature: 'PRIVATE', ...(child ? {} : { summary: 'Public' }) },
      { type: 'redacted_thinking', data: 'PRIVATE' }, { type: 'text', text: child ? 'PRIVATE' : 'Answer' }] } });
  }
  assert.equal(session.items.filter(i => i.kind === 'reasoning').length, 4);
  assert.doesNotMatch(JSON.stringify(session.items), /Public/, 'Claude 2.1.330 has no typed thinking-block summary field');
  assert.match(JSON.stringify(other), /Answer/);
  assert.doesNotMatch(JSON.stringify([session, other]), /PRIVATE/);
});

test('late cumulative info survives journal reload without merging turns or entering handoff', t => {
  const { session, controller } = fixture();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-info-'));
  const file = path.join(directory, 'sessions.json'), store = new SessionStore(file);
  t.after(() => { store.closeJournal(); fs.rmSync(directory, { recursive: true, force: true }); });
  store.load(controller.data);
  const info = { type: 'info', id: 'same', kind: 'agent', title: 'Worker', text: 'Progress' };
  controller.recordInfo(session, 't1', info);
  for (let i = 0; i < 60; i++) session.items.push({ type: 'plan', id: String(i) });
  store.save(controller.data);
  controller.recordInfo(session, 't1', { id: 'same', kind: 'agent', status: 'completed' });
  controller.recordInfo(session, 't2', { ...info, text: 'New' });
  store.save(controller.data);
  const items = readSessionData(file).sessions[0].items;
  assert.deepEqual(items.filter(i => i.type === 'info').map(i => [i.text, i.status]), [['Progress', 'completed'], ['New', undefined]]);
  assert.equal(handoff(items), '');
});
