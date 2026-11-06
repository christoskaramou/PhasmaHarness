const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ActivityLog } = require('../src/activity-log.cjs');

// 2026-11-06, the user: a log per bot (Hub included) of every chat message, tool call and helper step.
function fixture(t, options) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-activity-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const session = { id: 's1', title: 'Fix the build', status: 'completed', items: [{ id: 'old', type: 'userMessage', content: [{ type: 'text', text: 'Earlier history' }] }],
    routes: [], queue: [], tasks: [] };
  const controller = { agentId: 'bot1', busy: null, agents: { agentName: () => 'Builder' }, data: { sessions: [session] } };
  const log = new ActivityLog(directory, options);
  const read = () => fs.readFileSync(log.file('bot1', 'Builder'), 'utf8');
  return { log, controller, session, read, directory };
}

test('the activity log starts with the chat so far, then records each message, tool call and helper step once it settles, with secrets redacted', async t => {
  const { log, controller, session, read, directory } = fixture(t);
  // A cleared chat Harness keeps archived stays out (2026-11-06: a cleared Deepseek chat showed up in its log).
  controller.data.sessions.push({ id: 'old-chat', title: 'Cleared chat', archived: true, items: [{ id: 'x1', type: 'userMessage', content: [{ type: 'text', text: 'cleared message' }] }] });
  log.capture(controller);
  assert.doesNotMatch(read(), /cleared message|Cleared chat/);
  assert.match(read(), /^Activity log for Builder\..*\n.*\[Fix the build\] Chat history before the activity log started\n.*\[Fix the build\] You:\n {4}Earlier history\n$/);

  // A turn runs: the message, a running command (waits), and a reply still streaming (waits).
  controller.busy = 's1'; session.status = 'running';
  session.items.push({ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'Build it with key sk-abcdefghijklmnop' }, { type: 'image', url: 'data:' }] },
    { id: 'c1', type: 'commandExecution', status: 'inProgress', command: 'npm run build', aggregatedOutput: '' },
    { id: 'a1', type: 'agentMessage', phase: 'final_answer', text: 'Buil' });
  session.routes.push({ id: 'codex:m:high', label: 'Model · high', source: 'smart', reason: 'Build work.' });
  session.queue.push({ id: 'q1', text: 'then deploy', secondary: true });
  log.capture(controller);
  let text = read();
  assert.match(text, /^Activity log for Builder\./);
  assert.match(text, /\[Fix the build\] You:\n {4}Build it with key \[redacted\] \[1 image\]/);
  assert.match(text, /Route Model · high \(smart\):\n {4}Build work\./);
  assert.match(text, /Queued \(Secondary model\):\n {4}then deploy/);
  assert.doesNotMatch(text, /npm run build|Buil$/m, 'running and streaming items wait');

  // They settle: the command, the reply, a helper step and the task; each is written once.
  Object.assign(session.items[2], { status: 'completed', exitCode: 0, aggregatedOutput: 'built' });
  session.items[3].text = 'Built.';
  session.items.push({ id: 's1-step', type: 'toolStep', title: 'Jev reads image 1', lines: ['Q: a chart?', 'A: yes'] });
  session.tasks.push({ id: 't1', state: 'passed', summary: 'Build passed.' });
  controller.busy = null; session.status = 'completed';
  log.capture(controller); log.capture(controller);
  text = read();
  assert.match(text, /Command \[completed, exit 0\]:\n {4}npm run build\n {4}built/);
  assert.match(text, /Builder:\n {4}Built\./);
  assert.match(text, /Step: Jev reads image 1:\n {4}Q: a chart\?\n {4}A: yes/);
  assert.match(text, /Task passed:\n {4}Build passed\./);
  assert.equal(text.match(/Builder:\n/g).length, 1, 'written once');

  // A failed turn, and a chat cleared under it.
  session.status = 'failed'; session.error = 'The model took too long.';
  session.items = [];
  log.capture(controller);
  text = read();
  assert.match(text, /Turn failed:\n {4}The model took too long\./);
  assert.match(text, /Chat history was cleared or replaced/);

  // A restart goes on where it stopped: the chat is not written again, and what happened in between is.
  session.items.push({ id: 'u9', type: 'userMessage', content: [{ type: 'text', text: 'after the restart' }] });
  new ActivityLog(directory).capture(controller);
  text = read();
  assert.equal(text.match(/Earlier history/g).length, 1);
  assert.match(text, /You:\n {4}after the restart\n$/);
  // A chat started while it runs is new: its messages, without the "history before" line.
  controller.data.sessions.push({ id: 's2', title: 'New chat', items: [{ id: 'n1', type: 'userMessage', createdAt: Date.now(), content: [{ type: 'text', text: 'brand new' }] }] });
  log.capture(controller);
  text = read();
  assert.match(text, /\[New chat\] You:\n {4}brand new/);
  assert.doesNotMatch(text, /\[New chat\] Chat history before/);
  // A bot with no chat yet still has its log.
  new ActivityLog(directory).capture({ agentId: 'muse', agents: { agentName: () => 'Muse Test' }, data: { sessions: [] } });
  assert.equal(fs.readFileSync(path.join(directory, 'Muse Test-muse.log'), 'utf8'), 'Activity log for Muse Test. Chat messages, tool calls and helper steps, as they happen.\n');
});

test('a log written before the index existed becomes the earlier part, and the current file starts with the whole chat', async t => {
  const { log, controller, read, directory } = fixture(t);
  fs.writeFileSync(path.join(directory, 'Builder-bot1.log'), 'partial log from before\n');
  log.capture(controller);
  assert.equal(fs.readFileSync(path.join(directory, 'Builder-bot1.1.log'), 'utf8'), 'partial log from before\n');
  assert.match(read(), /Chat history before the activity log started[\s\S]*Earlier history/);
});

test('each bot has its own activity log file, which rolls over and keeps three', async t => {
  const { log, controller, session, read, directory } = fixture(t, { maxBytes: 300 });
  log.capture(controller);
  for (let index = 0; index < 8; index++) {
    session.items.push({ id: `u${index}`, type: 'userMessage', content: [{ type: 'text', text: `message ${index} ${'x'.repeat(80)}` }] });
    log.capture(controller);
  }
  // Named after the bot, with its id, so it is easy to find after the bot is deleted.
  assert.deepEqual(fs.readdirSync(directory).filter(entry => entry.endsWith('.log')).sort(), ['Builder-bot1.1.log', 'Builder-bot1.2.log', 'Builder-bot1.log']);
  assert.match(read(), /message 7/);
  const hub = { ...controller, agentId: undefined, agents: { agentName: () => 'Assistant' }, data: { sessions: [{ ...session, id: 'h1', items: [] }] } };
  log.capture(hub);
  hub.data.sessions[0].items.push({ id: 'h-u1', type: 'userMessage', content: [{ type: 'text', text: 'hello Hub' }] });
  log.capture(hub);
  assert.match(fs.readFileSync(path.join(directory, 'Assistant-main.log'), 'utf8'), /Activity log for Assistant\.[\s\S]*You:\n {4}hello Hub/);
  // Renamed (here after a restart), its files follow the name, rolled-over parts too; nothing splits or is lost.
  const restarted = new ActivityLog(directory, { maxBytes: 300 });
  assert.equal(restarted.file('bot1', 'Renamed'), path.join(directory, 'Renamed-bot1.log'));
  assert.deepEqual(fs.readdirSync(directory).filter(entry => entry.includes('bot1')).sort(), ['Renamed-bot1.1.log', 'Renamed-bot1.2.log', 'Renamed-bot1.log']);
  assert.match(fs.readFileSync(path.join(directory, 'Renamed-bot1.log'), 'utf8'), /message 7/);
  // The first version's <bot id>.log, next to a current file the app already writes: it becomes that file's earlier part.
  fs.writeFileSync(path.join(directory, 'bot3.log'), 'first version\n');
  fs.writeFileSync(path.join(directory, 'Third-bot3.log'), 'current\n');
  assert.equal(new ActivityLog(directory).file('bot3', 'Third'), path.join(directory, 'Third-bot3.log'));
  assert.deepEqual([fs.readFileSync(path.join(directory, 'Third-bot3.1.log'), 'utf8'), fs.readFileSync(path.join(directory, 'Third-bot3.log'), 'utf8'),
    fs.existsSync(path.join(directory, 'bot3.log'))], ['first version\n', 'current\n', false]);
  assert.equal(new ActivityLog(directory).file('bot2', 'New: bot?'), path.join(directory, 'New bot-bot2.log'), 'characters Windows refuses are left out');
});
