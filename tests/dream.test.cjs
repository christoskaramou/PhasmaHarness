const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const dream = require('../src/dream.cjs');
const chatScan = require('../src/chat-scan.cjs');
const trials = require('../src/trials.cjs');
const methods = require('../src/controller/dream.cjs');
const trialMethods = require('../src/controller/trials.cjs');

const tempRoot = t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-dream-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};
// Message times are minutes into the last hour, inside the dream's 30-day read window.
const T = Date.now() - 60 * 60 * 1000;
const at = minute => T + minute * 60000;
const user = (text, minute, extra = {}) => ({ type: 'userMessage', createdAt: at(minute), content: [{ type: 'text', text }], ...extra });
const said = text => ({ type: 'agentMessage', text });
const chat = (id, items, workspace = 'C:/project') => ({ id, workspace, items });

const chats = [
  chat('a', [user('Add a settings page', 10), said('Added it with tabs and two spaces of indentation.'),
    user('No, this project uses tabs for indentation, not spaces.', 20), said('Fixed.')]),
  chat('b', [user('Write the export helper', 30), said('Done, indented with spaces.'),
    user('Again spaces. This repo indents with tabs everywhere.', 40), said('Switched to tabs.')]),
  chat('c', [user('[Router] The checks failed.', 50), user('Routine digest', 60, { routineRun: { id: 'r' } }),
    user('My key is sk-abcdefghijklmnop', 70)]),
];

test('the dream sees each chat as one source, the longest waiting first, redacted, without router corrections or routine runs', () => {
  const input = dream.dreamInput({ sessions: chats, lessons: [], rules: '# Rules', ruleRecords: [], notes: [] });
  const shown = JSON.parse(input.prompt);
  assert.deepEqual(shown.chats.map(entry => entry.source), ['chat-1', 'chat-2', 'chat-3']);
  assert.match(shown.chats[0].exchanges[0].user, /^Add a settings page/, 'the chat with the oldest unread message comes first');
  assert.doesNotMatch(input.prompt, /sk-abcdefghijklmnop|\[Router\]|Routine digest/);
  assert.equal(shown.chats[1].exchanges[1].agent, 'Done, indented with spaces.', 'each message with what the agent said before it');
  assert.equal(input.newEvidence, 5);
  assert.deepEqual(input.positions, { a: at(20), b: at(40), c: at(70) }, 'each chat read up to its last message shown');
  const later = dream.dreamInput({ sessions: chats, read: { a: at(20), b: at(30) } });
  assert.equal(later.newEvidence, 2, 'only messages past each chat\'s read position count');
  assert.deepEqual(JSON.parse(later.prompt).chats.map(entry => entry.exchanges.length), [1, 1]);
  assert.match(JSON.parse(later.prompt).chats[0].exchanges[0].user, /^Again spaces/);
  const old = dream.dreamInput({ sessions: [chat('o', [user('A very old request from last year', -60 * 24 * 60)])] });
  assert.equal(old.newEvidence, 0, 'messages older than the 30-day window are skipped');
});

test('a chat that did not fit keeps its place and is read first next time; a long chat is read six messages at a time', () => {
  const long = chat('long', Array.from({ length: 10 }, (_, index) => user(`Request number ${index} about the loader`, index)));
  const first = dream.dreamInput({ sessions: [long] });
  assert.equal(first.newEvidence, 10);
  const numbers = input => JSON.parse(input.prompt).chats[0].exchanges.map(exchange => exchange.user.split(' ')[2]);
  assert.deepEqual(numbers(first), ['0', '1', '2', '3', '4', '5'], 'oldest first');
  assert.deepEqual(numbers(dream.dreamInput({ sessions: [long], read: first.positions })), ['6', '7', '8', '9'], 'the rest next time');

  // Six 600-character messages make a chat of about 3,700 characters, so only three fit the 14,000-character budget.
  const big = (id, minute) => chat(id, Array.from({ length: 6 }, (_, index) => user(`${id} ${'x'.repeat(700)}`, minute + index / 10)));
  const crowd = [big('newest', 50), big('second', 2), big('newer', 40), big('first', 1), big('third', 3)];
  const crowded = dream.dreamInput({ sessions: crowd });
  assert.deepEqual(Object.keys(crowded.positions), ['first', 'second', 'third'], 'the budget fills with the longest waiting chats');
  const next = dream.dreamInput({ sessions: crowd, read: crowded.positions });
  assert.deepEqual(Object.keys(next.positions), ['newer', 'newest'], 'the chats left out are read next time');
});

test('a mistake seen once is kept, and a later dream can match it with a new chat', t => {
  const root = tempRoot(t);
  const first = dream.dreamInput({ sessions: [chats[0]] });
  const shownFirst = { sources: first.sources, memory: '', noteIds: [] };
  const [seen] = dream.checkDream({ actions: [{ kind: 'seen', id: '', reason: '', text: 'Used spaces where the project uses tabs',
    moments: ['this project uses tabs for indentation'] }] }, shownFirst);
  assert.deepEqual([seen.kind, seen.text, seen.moment], ['seen', 'Used spaces where the project uses tabs', 'this project uses tabs for indentation']);
  assert.equal(dream.checkDream({ actions: [{ kind: 'seen', id: '', reason: '', text: 'Something else', moments: ['words nobody ever wrote here'] }] },
    shownFirst)[0].rejected, 'quoted moment not found in what it was shown');

  dream.saveRun(root, { at: Date.now() }, { positions: first.positions, seen: [{ id: 'e1', problem: seen.text, moment: seen.moment, at: Date.now() }] });
  dream.saveRun(root, { at: Date.now() }, { seen: [{ id: 'e2', problem: 'Same again', moment: seen.moment, at: Date.now() }] });
  const state = dream.readDreams(root);
  assert.deepEqual([state.earlier.map(entry => entry.id), state.read], [['e1'], first.positions], 'kept once, positions saved');
  assert.match(fs.readFileSync(path.join(root, dream.PAGE), 'utf8'), /## Seen once so far[\s\S]*Used spaces where the project uses tabs/);

  const later = dream.dreamInput({ sessions: [chats[1]], earlier: state.earlier, read: state.read });
  const shownLater = { sources: later.sources, memory: '', noteIds: [] };
  assert.equal(JSON.parse(later.prompt).earlier[0].source, 'earlier-1');
  const [rule] = dream.checkDream({ actions: [{ kind: 'rule', id: '', reason: 'tabs', text: 'Indent with tabs in this project.',
    moments: ['this project uses tabs for indentation', 'This repo indents with tabs everywhere'] }] }, shownLater);
  assert.deepEqual(rule.sources.sort(), ['chat-1', 'earlier-1'], 'the earlier mistake and the new chat are two sources');
  assert.equal(dream.checkDream({ actions: [{ kind: 'seen', id: '', reason: '', text: 'Again the same', moments: ['this project uses tabs for indentation'] }] },
    shownLater)[0].rejected, 'quoted moment not found in what it was shown', 'seen grows only from new evidence');
  dream.saveRun(root, { at: Date.now() }, { usedEarlier: ['e1'] });
  assert.deepEqual(dream.readDreams(root).earlier, [], 'used up by the rule');
});

test('a rule or note needs verbatim quotes from two different sources; a note to forget must be one it was shown', () => {
  const notes = [{ id: 'n1', note: 'The user prefers spaces.' }];
  const input = dream.dreamInput({ sessions: chats, notes, since: 0 });
  const check = action => dream.checkDream({ actions: [{ id: '', text: '', reason: 'indentation', moments: [], ...action }] },
    { sources: input.sources, memory: input.memory, noteIds: ['n1'] })[0];
  const quotes = ['this project uses tabs for indentation', 'This repo indents with tabs everywhere'];

  const rule = check({ kind: 'rule', text: 'Indent with tabs in this project.', moments: quotes });
  assert.deepEqual([rule.kind, rule.text, rule.sources.length], ['rule', 'Indent with tabs in this project.', 2]);
  assert.equal(check({ kind: 'note', text: 'Indent with tabs.', moments: [quotes[0], 'uses tabs for indentation, not spaces'] }).rejected,
    'seen in only one source');
  assert.equal(check({ kind: 'rule', text: 'Indent with tabs.', moments: [quotes[0], 'the user wants four spaces always'] }).rejected,
    'quoted moment not found in what it was shown');
  assert.equal(check({ kind: 'rule', text: 'Skip the lint checks when indenting.', moments: quotes }).rejected, 'rule failed the safety guard');
  assert.equal(check({ kind: 'rule', text: 'Indent with tabs.' }).rejected, 'no quotes');

  assert.equal(check({ kind: 'forget', id: 'n1', moments: ['This repo indents with tabs everywhere'] }).id, 'n1');
  assert.equal(check({ kind: 'forget', id: 'n2', moments: ['This repo indents with tabs everywhere'] }).rejected, 'not a note it was shown');
  assert.equal(dream.checkDream({ actions: new Array(9).fill({ kind: 'bogus' }) }, { sources: input.sources, memory: '', noteIds: [] }).length,
    dream.MAX_ACTIONS, 'at most four actions');
});

test('a dream is claimed once a day, so a failed call does not retry until tomorrow', t => {
  const root = tempRoot(t);
  assert.equal(dream.due(root), true);
  const now = Date.now();
  assert.equal(dream.claimDream(root, now), true);
  assert.equal(dream.claimDream(root, now + dream.DREAM_EVERY_MS - 1), false);
  assert.equal(dream.due(root, now + dream.DREAM_EVERY_MS), true);
  dream.saveRun(root, { at: 2000, model: 'Big', applied: [{ kind: 'note', text: 'Indent with tabs.' }], rejected: [{ kind: 'rule', rejected: 'seen in only one source' }] });
  assert.match(fs.readFileSync(path.join(root, dream.PAGE), 'utf8'), /note: Indent with tabs\.[\s\S]*Refused rule: seen in only one source/);
});

test('a due dream with enough evidence asks the strongest model once; its rule goes on trial and its forgotten note comes back on Undo', async t => {
  const root = tempRoot(t);
  chatScan.addNote(root, { note: 'The user prefers spaces for indentation.', problem: 'p', moment: 'm', goal: 'indent' });
  const noteId = chatScan.readNotes(root)[0].id;
  const calls = [];
  const session = { id: 'w', workspace: 'C:/project', items: [] };
  const self = {
    wikiStore: { ensure: () => ({ root }) }, comparisonOf: () => null, lessonWorkspace: workspace => workspace, agents: null,
    available: () => true, strongestPreset: () => ({ id: 'big', model: 'big', label: 'Big' }), learnedRules: () => '',
    chatScanner: () => ({ id: 'checker' }),
    data: { settings: {}, sessions: [...chats, chat('elsewhere', [user('Unrelated other project text', 90)], 'C:/other')] },
    log: { warn: (...args) => calls.push(['warn', ...args]) }, save() {}, changed() {}, session: () => session,
    smartRouter: { complete: async request => {
      calls.push(request);
      return { decision: { actions: [
        { kind: 'rule', text: 'Indent with tabs in this project.', id: '', reason: 'The user corrected spaces to tabs twice',
          moments: ['this project uses tabs for indentation', 'This repo indents with tabs everywhere'] },
        { kind: 'forget', text: '', id: noteId, reason: 'Later chats say tabs', moments: ['This repo indents with tabs everywhere'] },
        { kind: 'note', text: 'Indent with tabs.', id: '', reason: 'once', moments: ['this project uses tabs for indentation'] },
      ] } };
    } },
  };
  Object.assign(self, methods, trialMethods);

  await methods.maybeDream.call(self, session);
  assert.equal(calls.length, 1, 'one call');
  assert.doesNotMatch(calls[0].prompt, /Unrelated other project/, 'only this project\'s chats');
  const rule = trials.readRules(root)[0];
  assert.deepEqual([rule.rule, rule.state, rule.source, rule.check], ['Indent with tabs in this project.', 'trial', 'a dream', null]);
  assert.deepEqual(chatScan.readNotes(root), [], 'the contradicted note is forgotten; the one-source note is refused');
  const run = dream.readDreams(root).runs[0];
  assert.deepEqual([run.model, run.applied.map(action => action.kind), run.rejected.map(action => action.rejected)],
    ['Big', ['rule', 'forget'], ['seen in only one source']]);
  assert.deepEqual(session.items.map(item => item.ruleNotice.kind), ['trialStarted', 'noteForgotten']);

  trialMethods.undoRule.call(self, 'w', session.items[1].id);
  assert.equal(chatScan.readNotes(root)[0]?.id, noteId, 'Undo brings the forgotten note back');

  await methods.maybeDream.call(self, session);
  assert.equal(calls.length, 1, 'not again the same day');
});

test('no dream without enough new evidence, without consent to read chats, in a comparison run, or past the background limit', async t => {
  const root = tempRoot(t);
  let asked = 0;
  const base = {
    wikiStore: { ensure: () => ({ root }) }, comparisonOf: () => null, lessonWorkspace: workspace => workspace, agents: null,
    available: () => true, strongestPreset: () => ({ id: 'big', model: 'big' }), learnedRules: () => '', log: { warn() {} },
    chatScanner: () => ({ id: 'checker' }), data: { settings: {}, sessions: [chat('a', [user('One message', 10)])] }, smartRouter: { complete: async () => { asked++; return { decision: { actions: [] } }; } },
  };
  Object.assign(base, methods);
  const session = { workspace: 'C:/project' };
  assert.equal(methods.maybeDream.call(base, session), null);
  assert.equal(dream.due(root), true, 'too little evidence leaves the dream due');
  base.data.sessions = chats;
  assert.equal(methods.maybeDream.call({ ...base, chatScanner: () => null }, session), null, 'chat checker Off: chats are not read');
  assert.equal(methods.maybeDream.call({ ...base, data: { ...base.data, settings: { scanReplies: false } } }, session), null,
    'Find rules from your replies off: chats are not read');
  assert.equal(methods.maybeDream.call({ ...base, comparisonOf: () => ({}) }, session), null);
  assert.equal(methods.maybeDream.call({ ...base, agents: { backgroundQuota: () => true } }, session), null);
  assert.equal(asked, 0);
  await methods.maybeDream.call(base, session);
  assert.equal(asked, 1);
});

test('whether the dream reads chats comes from the saved chat checker setting, not a default', async t => {
  const chatScanMethods = require('../src/controller/chat-scan.cjs');
  const run = async settings => {
    const root = tempRoot(t);
    let asked = 0;
    const self = {
      ...methods, chatScanChoices: chatScanMethods.chatScanChoices, chatScanner: chatScanMethods.chatScanner,
      catalog: () => [{ id: 'claude-cli:claude-haiku-5-5:high', worker: true }, { id: 'big', worker: true }],
      wikiStore: { ensure: () => ({ root }) }, comparisonOf: () => null, lessonWorkspace: workspace => workspace, agents: null,
      available: () => true, strongestPreset: () => ({ id: 'big', model: 'big' }), learnedRules: () => '', log: { warn() {} },
      data: { settings, sessions: chats }, smartRouter: { complete: async () => { asked++; return { decision: { actions: [] } }; } },
    };
    await methods.maybeDream.call(self, { workspace: 'C:/project' });
    return asked;
  };
  assert.equal(await run({ chatScanModel: 'claude-cli:claude-haiku-5-5:high' }), 1, 'a picked checker: chats are read');
  assert.equal(await run({ chatScanModel: 'claude-cli:claude-haiku-5-5:high', scanReplies: false }), 0, 'Find rules from your replies off');
  assert.equal(await run({}), 0, 'no checker saved');
  assert.equal(await run({ chatScanModel: 'off' }), 0, 'checker set to Off');
});

test('Dream off in Settings: no dream until it is turned back on', async t => {
  const root = tempRoot(t);
  let asked = 0;
  const self = {
    ...methods, wikiStore: { ensure: () => ({ root }) }, comparisonOf: () => null, lessonWorkspace: workspace => workspace, agents: null,
    available: () => true, strongestPreset: () => ({ id: 'big', model: 'big' }), learnedRules: () => '', log: { warn() {} },
    chatScanner: () => ({ id: 'checker' }), data: { settings: { dream: false }, sessions: chats },
    smartRouter: { complete: async () => { asked++; return { decision: { actions: [] } }; } },
  };
  assert.equal(methods.maybeDream.call(self, { workspace: 'C:/project' }), null);
  assert.equal(asked, 0);
  assert.equal(dream.due(root), true, 'turning it back on dreams at the next settled task');
  self.data.settings.dream = true;
  await methods.maybeDream.call(self, { workspace: 'C:/project' });
  assert.equal(asked, 1);
});

test('read positions move only after a successful dream; a failed one leaves the chats unread for the next', async t => {
  const make = (complete, root = tempRoot(t)) => ({ root, self: {
    ...methods, ...trialMethods, wikiStore: { ensure: () => ({ root }) }, comparisonOf: () => null, lessonWorkspace: workspace => workspace,
    agents: null, available: () => true, strongestPreset: () => ({ id: 'big', model: 'big' }), learnedRules: () => '',
    log: { warn() {} }, chatScanner: () => ({ id: 'checker' }), data: { settings: {}, sessions: chats }, save() {}, changed() {},
    smartRouter: { complete },
  } });

  const failed = make(async () => { throw new Error('model offline'); });
  await methods.maybeDream.call(failed.self, { id: 's', workspace: 'C:/project', items: [] });
  assert.deepEqual(dream.readDreams(failed.root).read, {}, 'nothing marked read');
  assert.match(dream.readDreams(failed.root).runs[0].error, /model offline/);

  const ok = make(async () => ({ decision: { actions: [
    { kind: 'seen', text: 'Used spaces where the project uses tabs', id: '', reason: '', moments: ['this project uses tabs for indentation'] },
  ] } }));
  await methods.maybeDream.call(ok.self, { id: 's', workspace: 'C:/project', items: [] });
  const state = dream.readDreams(ok.root);
  assert.deepEqual(state.read, { a: at(20), b: at(40), c: at(70) }, 'every chat it read, up to its last message shown');
  assert.deepEqual(state.earlier.map(entry => entry.problem), ['Used spaces where the project uses tabs']);
  assert.equal(state.runs[0].seen, 1);

  // A day later, a new chat repeats the mistake: the rule cites the earlier one, which is used up.
  fs.writeFileSync(path.join(ok.root, dream.RECORDS), JSON.stringify({ ...state, lastAt: 0 }));
  ok.self.data.sessions = [...chats, chat('d', [said('Indented with spaces again.'), user('Tabs please, as I said before in this project.', 55),
    user('One more request', 56), user('And another request', 57), user('And a fourth request', 58), user('And a fifth request here', 59)])];
  ok.self.smartRouter.complete = async () => ({ decision: { actions: [{ kind: 'rule', text: 'Indent with tabs in this project.', id: '',
    reason: 'Spaces used where the project uses tabs, twice', moments: ['this project uses tabs for indentation', 'Tabs please, as I said before'] }] } });
  await methods.maybeDream.call(ok.self, { id: 's', workspace: 'C:/project', items: [] });
  const after = dream.readDreams(ok.root);
  assert.equal(trials.readRules(ok.root)[0]?.rule, 'Indent with tabs in this project.');
  assert.deepEqual(after.earlier, [], 'the earlier mistake is used up');
  assert.equal(after.read.d, at(59));
});

test('Dream now runs without the daily wait, the five-message minimum or the Dream switch, and says why when it cannot', async t => {
  const root = tempRoot(t);
  let asked = 0;
  const session = { id: 's', workspace: 'C:/project', items: [] };
  const self = {
    ...methods, ...trialMethods, wikiStore: { ensure: () => ({ root }) }, comparisonOf: () => null, lessonWorkspace: workspace => workspace,
    agents: null, available: () => true, strongestPreset: () => ({ id: 'big', model: 'big', label: 'Big' }), learnedRules: () => '',
    log: { warn() {} }, chatScanner: () => ({ id: 'checker' }), session: () => session, save() {}, changed() {},
    data: { settings: { dream: false }, sessions: [chat('a', [said('Indented with spaces.'), user('Please use tabs in this project.', 5)])] },
    smartRouter: { complete: async () => { asked++; return { decision: { actions: [] } }; } },
  };
  dream.claimDream(root, Date.now());
  assert.equal(dream.due(root), false, 'a dream already ran today');

  const run = await methods.dreamNow.call(self, 's');
  assert.equal(asked, 1, 'one message, Dream off and a dream earlier today do not stop it');
  assert.deepEqual([run.manual, run.read, run.applied, run.model, run.project], [true, { chats: 1, messages: 1 }, [], 'Big', 'C:/project']);
  assert.match(fs.readFileSync(path.join(root, dream.PAGE), 'utf8'), /\(Dream now\) · Big · nothing to change/);

  await assert.rejects(methods.dreamNow.call(self, 's'), /Nothing new to read in project\./, 'what it read is not read again');
  await assert.rejects(methods.dreamNow.call({ ...self, chatScanner: () => null }, 's'), /only while a chat checker is picked/);
  await assert.rejects(methods.dreamNow.call({ ...self, strongestPreset: () => null }, 's'), /No model is available/);
  await assert.rejects(methods.dreamNow.call({ ...self, agents: { backgroundQuota: () => true } }, 's'), /usage limit/);
  await assert.rejects(methods.dreamNow.call({ ...self, session: () => ({ id: 'x', items: [] }) }, 'x'), /project folder/);
  assert.equal(asked, 1);
});
