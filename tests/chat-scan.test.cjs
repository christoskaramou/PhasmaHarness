const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const chatScan = require('../src/chat-scan.cjs');
const methods = require('../src/controller/chat-scan.cjs');

const tempRoot = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-chat-scan-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
const user = (id, text, extra = {}) => ({ id, type: 'userMessage', content: [{ type: 'text', text }], ...extra });
const items = [
  user('u1', 'Rename the loader module'),
  { type: 'commandExecution', command: 'cat .env', exitCode: 0, aggregatedOutput: 'api_key=sk-abcdefghijklmnop' },
  { type: 'agentMessage', text: 'Renamed fetchUser to loadUser everywhere, including the public export.' },
  { type: 'agentResult', internal: true, text: 'Comparison run report' },
];

test('the scanner sees the exchange redacted, the next message and the carried chat rules; only grounded flags count', () => {
  const carried = [{ id: 'r1', rule: 'Keep public export names.', error: 'renamed a public export' }];
  const { prompt, plain } = chatScan.exchangeInput({ items, task: { state: 'checks-passed', corrections: 0 }, reaction: 'No, keep the public export name fetchUser.',
    rules: '# Project instructions', carried });
  const input = JSON.parse(prompt);
  assert.doesNotMatch(prompt, /sk-abcdefghijklmnop/, 'secrets never reach the model');
  assert.doesNotMatch(prompt, /Comparison run report/, 'internal comparison results are left out');
  assert.equal(input.nextUserMessage, 'No, keep the public export name fetchUser.');
  assert.deepEqual(input.carriedRules, [{ id: 'r1', rule: 'Keep public export names.', targets: 'renamed a public export' }]);

  const flag = { worthy: true, problem: 'Renamed a public export the user wanted kept', moment: 'keep the public export name fetchUser', carried: [] };
  assert.equal(chatScan.checkScan(flag, plain, []).worthy, true);
  assert.equal(chatScan.checkScan({ ...flag, moment: 'The agent deleted the tests' }, plain, []).worthy, false, 'a quote not in the exchange');
  assert.equal(chatScan.checkScan({ ...flag, problem: '' }, plain, []).worthy, false, 'no problem named');
  const verdicts = chatScan.checkScan({ ...flag, carried: [{ id: 'r1', verdict: 'recurred' }, { id: 'other', verdict: 'avoided' }, { id: 'r1', verdict: 'maybe' }] }, plain, ['r1']).verdicts;
  assert.deepEqual(verdicts, [{ id: 'r1', verdict: 'recurred' }], 'verdicts only for rules it was shown, with a known answer');
  const outcome = value => chatScan.checkScan({ ...flag, outcome: value }, plain, []).outcome;
  assert.deepEqual([outcome('accepted'), outcome('corrected'), outcome('unclear'), outcome('toString'), outcome(undefined)],
    ['clean', 'corrected', null, null, null], 'how the user took the work, in proven-setup terms; anything else says nothing');
});

test('the strongest model writes a rule, a note or nothing, through the reflection guard', () => {
  const { plain } = chatScan.exchangeInput({ items, reaction: 'No, keep the public export name fetchUser.' });
  const moment = 'keep the public export name fetchUser';
  assert.deepEqual(chatScan.checkEscalation({ decision: 'rule', text: 'Keep public export names unless asked.', moment, reason: 'Callers broke.' }, plain),
    { kind: 'rule', text: 'Keep public export names unless asked.', moment, reason: 'Callers broke.' });
  assert.equal(chatScan.checkEscalation({ decision: 'note', text: 'Callers import fetchUser by name.', moment, reason: '' }, plain).kind, 'note');
  assert.equal(chatScan.checkEscalation({ decision: 'nothing', text: '', moment: '', reason: 'One-off.' }, plain).nothing, true);
  assert.match(chatScan.checkEscalation({ decision: 'rule', text: 'Skip the tests when renaming.', moment, reason: '' }, plain).rejected, /safety/);
  assert.match(chatScan.checkEscalation({ decision: 'note', text: 'Keep names.', moment: 'never said in the exchange', reason: '' }, plain).rejected, /not found/);
});

test('each exchange is scanned once, the strongest model runs at most five times a day, and notes ride matching tasks', t => {
  const root = tempRoot(t);
  assert.equal(chatScan.claimScan(root, 'task-1'), true);
  assert.equal(chatScan.claimScan(root, 'task-1'), false);
  const day = Date.parse('2026-10-21T10:00:00Z');
  assert.deepEqual(Array.from({ length: 6 }, () => chatScan.claimEscalation(root, day)), [true, true, true, true, true, false]);
  assert.equal(chatScan.claimEscalation(root, day + 24 * 60 * 60 * 1000), true, 'a new day starts again');

  const note = chatScan.addNote(root, { note: 'Callers import fetchUser by name.', problem: 'Renamed an export', moment: 'keep the name', goal: 'Rename the loader module' });
  assert.equal(chatScan.addNote(root, { note: 'Callers import fetchUser by name.', problem: 'x', moment: 'y', goal: 'z' }), null, 'the same note once');
  assert.equal(chatScan.notesOffer(chatScan.readNotes(root), 'Update the README'), null);
  assert.equal(chatScan.notesOffer(chatScan.readNotes(root), 'Rename the README'), null, 'one shared word is not enough');
  assert.match(chatScan.notesOffer(chatScan.readNotes(root), 'Rename the loader again'), /^Notes Harness took from earlier chats[^\n]*\n- Callers import fetchUser by name\.$/);
  assert.match(fs.readFileSync(path.join(root, chatScan.NOTES_PAGE), 'utf8'), /- Callers import fetchUser by name\./);
  chatScan.removeNote(root, note.id);
  assert.deepEqual(chatScan.readNotes(root), []);

  const old = Date.now() - 91 * 24 * 60 * 60 * 1000;
  fs.writeFileSync(path.join(root, chatScan.NOTES), JSON.stringify(Array.from({ length: 12 }, (_, index) => ({ id: `n${index}`, note: `Note ${index}`, at: old - index }))));
  assert.equal(chatScan.readNotes(root).length, 10, 'notes older than 90 days expire, except the newest ten');
});

test('a Bot exchange belongs to the one job it delegated; none or several are skipped', () => {
  const worker = { id: 'w', items: [user('job', 'Rename the loader module'), { type: 'agentMessage', text: 'Renamed it.' }],
    tasks: [{ id: 'task-w', assignmentId: 'job-1', startIndex: 0, trialRuleIds: [], keptRuleIds: [] }] };
  const result = deliveryId => ({ type: 'agentResult', deliveryId, sessionId: 'w', workspace: 'C:/project', text: 'Done.' });
  const hub = { isCoordinator: () => true, agents: { owner: () => ({ session: () => worker }) } };
  const bot = { items: [user('old', 'Earlier'), user('u1', 'Please rename the loader'), result('job-1'), { type: 'agentMessage', text: 'It is renamed.' }] };
  const exchange = methods.exchangeOf.call(hub, bot);
  assert.deepEqual([exchange.id, exchange.task.id, exchange.workspace, exchange.request], ['u1', 'task-w', 'C:/project', 'Please rename the loader']);
  assert.equal(exchange.taskSession, worker, 'the task is recorded against the worker\'s chat');
  assert.deepEqual(exchange.items.map(item => item.type), ['userMessage', 'userMessage', 'agentMessage', 'agentResult', 'agentMessage'],
    'the request, the worker run, then the result and Bot\'s reply');
  assert.equal(methods.exchangeOf.call(hub, { items: [...bot.items, result('job-2')] }), null, 'two jobs: no single project');
  assert.equal(methods.exchangeOf.call(hub, { items: [user('u2', 'Hi'), { type: 'agentMessage', text: 'Hello.' }] }), null, 'no job: nothing to learn about a project');
});

test('a delegated job, a comparison run and a router correction are never scanned', () => {
  const calls = [];
  const self = { wikiStore: {}, comparisonOf: session => session.comparison || null, exchangeOf: () => calls.push('exchange') && null, log: { warn: () => calls.push('warn') } };
  methods.scanAfterUserTurn.call(self, { delegation: { delivered: false } }, 'Rename it');
  methods.scanAfterUserTurn.call(self, { comparison: { id: 'c' } }, 'Rename it');
  methods.scanAfterUserTurn.call(self, {}, '[Router] The checks failed.');
  assert.deepEqual(calls, []);
  methods.scanAfterUserTurn.call(self, {}, 'Rename it');
  assert.deepEqual(calls, ['exchange']);
});

test('how the user took a task without checks becomes its proven-setup record, from its own chat or Bot\'s', t => {
  const root = tempRoot(t);
  const recorded = [];
  let decision;
  const self = { agents: null, data: { settings: {} }, chatScanner: () => ({ id: 'checker', provider: 'codex' }), available: () => true, lessonWorkspace: workspace => workspace,
    wikiStore: { ensure: () => ({ root }) }, learnedRules: () => '', backgroundCall: (owner, preset, request, then) => then(decision),
    recordSetup: (...args) => recorded.push(args) };
  const worker = { id: 'w', workspace: 'C:/project' };
  let next = 0;
  const scan = (task, outcome, session = worker, request = user('u', 'Fix the crash')) => {
    decision = { worthy: false, problem: '', moment: '', carried: [], outcome };
    const exchange = { id: `x${next++}`, items: [request, { type: 'agentMessage', text: 'Fixed.' }], task, taskSession: worker, workspace: 'C:/project' };
    methods.runScan.call(self, session, exchange, 'Thanks');
  };

  scan({ id: 't1', state: 'not-checked' }, 'accepted', { id: 'hub' });
  assert.deepEqual(recorded.map(([session, task, chat]) => [session.id, task.id, chat.outcome, chat.noticeIn.id]), [['w', 't1', 'clean', 'hub']],
    'recorded against the chat that ran the task, with its notices where the user wrote');
  scan({ id: 't2', state: 'checks-passed' }, 'corrected');
  scan({ id: 't3', state: 'running' }, 'corrected');
  scan({ id: 't4', state: 'not-checked', sameTask: true }, 'accepted');
  scan({ id: 't5', state: 'not-checked' }, 'unclear');
  scan({ id: 't7', state: 'not-checked' }, 'accepted', worker, user('r', 'Summarise new commits', { routineRun: { id: 'routine' } }));
  assert.equal(recorded.length, 1, 'never a task with checks, an unsettled one, a same-task follow-up, an unclear reply or a routine run');
  scan({ id: 't6', state: 'not-checked' }, 'corrected');
  assert.deepEqual(recorded.map(([, task, chat]) => [task.id, chat.outcome]), [['t1', 'clean'], ['t6', 'corrected']]);
});
