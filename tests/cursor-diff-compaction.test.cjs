const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { execFileSync } = require('node:child_process');
const { compactDiff } = require('../src/providers/cursor.cjs');
const { Controller } = require('../src/controller.cjs');
const { readSessionData } = require('../src/session-store.cjs');
const { collectWorkspace } = require('../src/workspace/workspace-context.cjs');

const lines = (count, label = 'line') => Array.from({ length: count }, (_, i) => `${label} ${i + 1}`);

test('a Cursor edit result keeps only the changed lines with three lines of context and their start line', () => {
  const before = lines(100), after = [...before]; after[49] = 'changed 50';
  const block = compactDiff({ type: 'diff', path: 'a.lua', oldText: before.join('\n'), newText: after.join('\n') });
  assert.equal(block.startLine, 47);
  assert.deepEqual(block.oldText.split('\n'), before.slice(46, 53));
  assert.deepEqual(block.newText.split('\n'), after.slice(46, 53));
  assert.equal(block.path, 'a.lua');
  // Compacting again changes nothing, so stored results are not rewritten on every load.
  assert.equal(compactDiff(block), block);
});

test('Cursor diff compaction keeps new files, deletions, CRLF text and non-diff content intact', () => {
  const created = { type: 'diff', path: 'new.lua', oldText: null, newText: lines(50).join('\n') };
  assert.equal(compactDiff(created), created);
  const deleted = { type: 'diff', path: 'gone.lua', oldText: lines(50).join('\n') + '\n', newText: '' };
  assert.equal(compactDiff(deleted), deleted);
  const text = { type: 'content', content: { type: 'text', text: 'x'.repeat(5000) } };
  assert.equal(compactDiff(text), text);
  const crlf = lines(40).join('\r\n'), edited = crlf.replace('line 20\r', 'line twenty\r');
  const block = compactDiff({ type: 'diff', path: 'w.txt', oldText: crlf, newText: edited });
  assert.equal(block.startLine, 17);
  // Each kept line keeps its own CR, so the excerpt is the file's exact text.
  assert.equal(block.newText, (lines(40).slice(16, 23).join('\r\n') + '\r').replace('line 20\r', 'line twenty\r'));
  assert.ok(edited.includes(block.newText));
  // An unchanged file keeps only its last lines.
  const same = compactDiff({ type: 'diff', path: 's.txt', oldText: lines(30).join('\n'), newText: lines(30).join('\n') });
  assert.equal(same.newText, lines(30).slice(27).join('\n'));
});

test('stored Cursor edit results shrink once on load, after a backup of the store', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-diffs-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'sessions.json');
  const before = lines(2000), after = [...before]; after[999] = 'changed';
  const edit = { id: 'call-1', type: 'mcpToolCall', server: 'Cursor CLI', tool: 'Edit File', status: 'completed', result: [
    { type: 'diff', path: 'big.lua', oldText: before.join('\n'), newText: after.join('\n') }] };
  const other = { id: 'call-2', type: 'mcpToolCall', server: 'Claude CLI', tool: 'Read', status: 'completed', result: 'file text' };
  fs.writeFileSync(file, JSON.stringify({ version: 1, settings: { workspace: directory, mode: 'auto', access: 'workspace-write' },
    sessions: [{ id: 's1', items: [{ id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'edit' }] }, edit, other], routes: [] }] }));
  const router = { cancel() {}, close() {}, jev: null };
  const controller = new Controller(file, directory, new EventEmitter(), router);
  const items = controller.data.sessions[0].items;
  assert.equal(items.length, 3);
  assert.equal(items[1].result[0].startLine, 997);
  assert.equal(items[1].result[0].newText.split('\n').length, 7);
  assert.equal(items[2].result, 'file text');
  const saved = readSessionData(file).sessions[0].items;
  assert.deepEqual(saved, items);
  const backup = readSessionData(file + '.pre-diff-compaction.bak').sessions[0].items;
  assert.equal(backup[1].result[0].newText, after.join('\n'));
  // A later load finds nothing to compact and leaves the backup as it was.
  const backupTime = fs.statSync(file + '.pre-diff-compaction.bak').mtimeMs;
  const again = new Controller(file, directory, new EventEmitter(), router);
  assert.deepEqual(again.data.sessions[0].items, items);
  assert.equal(fs.statSync(file + '.pre-diff-compaction.bak').mtimeMs, backupTime);
});

test('the routing workspace scan samples changed files in a stable order with staged and unstaged diffs', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-scan-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'core.autocrlf=false', ...args], { cwd: directory, stdio: 'pipe' });
  git('init', '-q');
  for (const name of ['a.cpp', 'b.md', 'c.js']) fs.writeFileSync(path.join(directory, name), 'one\ntwo\n');
  git('add', '.'); git('commit', '-q', '-m', 'base');
  fs.writeFileSync(path.join(directory, 'a.cpp'), 'one\nstaged\n'); git('add', 'a.cpp');
  fs.writeFileSync(path.join(directory, 'a.cpp'), 'one\nstaged\nunstaged\n');
  fs.writeFileSync(path.join(directory, 'c.js'), 'one\nthree\n');
  fs.writeFileSync(path.join(directory, 'd.txt'), 'new file\n');
  const first = await collectWorkspace(directory, 'look at b.md');
  assert.equal(first.available, true);
  assert.deepEqual(first.files.map(f => f.path), ['b.md', 'a.cpp', 'c.js', 'd.txt']);
  const a = first.files.find(f => f.path === 'a.cpp').text;
  assert.ok(a.indexOf('STAGED\n') < a.indexOf('+staged') && a.indexOf('+staged') < a.indexOf('UNSTAGED\n') && a.indexOf('UNSTAGED\n') < a.indexOf('+unstaged'));
  assert.match(first.files.find(f => f.path === 'b.md').text, /FILE\none/);
  assert.deepEqual(await collectWorkspace(directory, 'look at b.md'), first);
});

test('Cursor tool cards keep the output Cursor sends in rawOutput and the name and input it fills in later', async () => {
  const { CursorCLI, toolOutput } = require('../src/providers/cursor.cjs');
  const cursor = new CursorCLI(), events = [];
  // Shapes recorded from Cursor CLI ACP on 2026-10-25: read output and grep counts arrive only as rawOutput.
  cursor.connect = ({ onUpdate }) => ({
    cwd: 'w', close() {},
    call: async method => {
      if (method === 'session/new') return { sessionId: 's' };
      if (method !== 'session/prompt') return {};
      const send = update => onUpdate({ sessionId: 's', update });
      send({ sessionUpdate: 'tool_call', toolCallId: 'r', title: 'Read note.txt', kind: 'read', status: 'pending', rawInput: { path: 'note.txt' } });
      send({ sessionUpdate: 'tool_call_update', toolCallId: 'r', status: 'completed', rawOutput: { content: 'pelican harbor lantern\n' } });
      send({ sessionUpdate: 'tool_call', toolCallId: 'g', title: 'grep', kind: 'search', status: 'pending', rawInput: {} });
      send({ sessionUpdate: 'tool_call_update', toolCallId: 'g', title: 'grep "harbor"', rawInput: { pattern: 'harbor', path: 'note.txt' } });
      send({ sessionUpdate: 'tool_call_update', toolCallId: 'g', status: 'in_progress' });
      send({ sessionUpdate: 'tool_call_update', toolCallId: 'g', status: 'completed', rawOutput: { totalMatches: 1, truncated: false } });
      return { stopReason: 'end_turn' };
    },
  });
  await cursor.run({ model: 'm', prompt: 'Read it.', onEvent: event => events.push(event) });
  const uses = events.flatMap(e => e.type === 'assistant' ? e.message.content.filter(c => c.type === 'tool_use') : []);
  assert.deepEqual(uses.filter(u => u.id === 'g').at(-1), { type: 'tool_use', id: 'g', name: 'grep "harbor"', input: { pattern: 'harbor', path: 'note.txt' } });
  const results = Object.fromEntries(events.flatMap(e => e.type === 'user' ? e.message.content : []).map(r => [r.tool_use_id, r.content]));
  assert.deepEqual(results, { r: { content: 'pelican harbor lantern\n' }, g: { totalMatches: 1, truncated: false } });
  const diff = { type: 'diff', path: 'a', oldText: 'x', newText: 'y' };
  assert.deepEqual(toolOutput({ content: [diff], rawOutput: { ignored: true } }), [diff], 'edit diffs still come from content');
  assert.deepEqual(toolOutput({ status: 'completed' }), []);
  assert.match(toolOutput({ rawOutput: { content: 'x'.repeat(70000) } }).content, /^x{64000}\n\[… 6000 more characters not kept\]$/);
});

test('Cursor text written after a tool call becomes a new message below the tool card', async () => {
  const { CursorCLI } = require('../src/providers/cursor.cjs');
  const cursor = new CursorCLI(), events = [];
  cursor.connect = ({ onUpdate }) => ({
    cwd: 'w', close() {},
    call: async method => {
      if (method === 'session/new') return { sessionId: 's' };
      if (method !== 'session/prompt') return {};
      const send = update => onUpdate({ sessionId: 's', update });
      const say = text => send({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
      say('Counting from README.md'); say(' with a search.');
      send({ sessionUpdate: 'tool_call', toolCallId: 'g', title: 'grep', kind: 'search', rawInput: {} });
      send({ sessionUpdate: 'tool_call_update', toolCallId: 'g', status: 'completed', rawOutput: { totalMatches: 5 } });
      say('**5** matching lines.');
      return { stopReason: 'end_turn' };
    },
  });
  const result = await cursor.run({ model: 'm', prompt: 'Count.', onEvent: event => events.push(event) });
  cursor.close();
  const order = events.flatMap(e => e.type === 'assistant' ? e.message.content.map(c => c.type === 'text' ? `${e.message.id}:${c.text}` : `tool:${c.id}`) : []);
  const [first, , , last] = order;
  assert.equal(first.split(':')[1], 'Counting from README.md');
  assert.ok(order.indexOf('tool:g') < order.findIndex(entry => entry.endsWith(':**5** matching lines.')), 'the later text comes after the card');
  assert.notEqual(first.split(':')[0], last.split(':')[0], 'a separate message');
  assert.equal(result.result, 'Counting from README.md with a search.\n\n**5** matching lines.');
});
