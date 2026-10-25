const { test } = require('node:test');
const assert = require('node:assert/strict');
const { CursorCLI } = require('../src/providers/cursor.cjs');

// A fake ACP connection per connect(), recording its calls; Cursor's start-up steps are the ones a warm turn skips.
function fakeCursor(t) {
  const cursor = new CursorCLI(), conns = [];
  t.after(() => cursor.close());
  cursor.connect = options => {
    const conn = { options, closed: false, fail: false, silent: false, calls: [] };
    conn.rpc = {
      cwd: options.cwd, child: null, notify() {},
      open: () => !conn.closed,
      close() { conn.closed = true; },
      call: async (method, params) => {
        conn.calls.push(method);
        if (conn.silent) throw new Error('Cursor session/set_mode timed out.');
        if (method === 'session/new') return { sessionId: 'sess-' + conns.indexOf(conn) + '-' + options.cwd };
        if (method === 'session/load') return { sessionId: params.sessionId };
        if (method === 'session/prompt') {
          if (conn.fail) throw new Error('boom');
          return { stopReason: 'end_turn' };
        }
        return {};
      },
    };
    conns.push(conn);
    return conn.rpc;
  };
  return { cursor, conns };
}

test('a conversation\'s next Cursor turn reuses its process, checks it answers, and sets only what changed', async t => {
  const { cursor, conns } = fakeCursor(t);
  const { session_id: id } = await cursor.run({ cwd: 'w', model: 'm1', prompt: 'a' });
  assert.equal(cursor.warmCount(), 1);
  await cursor.run({ cwd: 'w', model: 'm1', prompt: 'b', resume: id });
  assert.equal(conns.length, 1, 'no second process');
  assert.deepEqual(conns[0].calls, ['initialize', 'session/new', 'session/set_model', 'session/set_mode', 'session/prompt', 'session/set_mode', 'session/prompt']);
  await cursor.run({ cwd: 'w', model: 'm2', prompt: 'c', resume: id, access: 'read-only' });
  assert.deepEqual(conns[0].calls.slice(-3), ['session/set_mode', 'session/set_model', 'session/prompt']);
  // Another folder (or other helper tools) is a different connection: the parked one closes.
  await cursor.run({ cwd: 'other', model: 'm2', prompt: 'd', resume: id });
  assert.equal(conns.length, 2);
  assert.equal(conns[0].closed, true);
  assert.equal(conns[1].calls[1], 'session/load');
  cursor.close();
  assert.equal(conns[1].closed, true);
  assert.equal(cursor.warmCount(), 0);
});

test('a parked Cursor process that stops answering is replaced before the prompt', async t => {
  const { cursor, conns } = fakeCursor(t);
  const { session_id: id } = await cursor.run({ cwd: 'w', model: 'm', prompt: 'a' });
  conns[0].silent = true;
  await cursor.run({ cwd: 'w', model: 'm', prompt: 'b', resume: id });
  assert.equal(conns[0].closed, true);
  assert.deepEqual(conns[1].calls.slice(0, 2), ['initialize', 'session/load']);
});

test('a failed or stopped Cursor turn is not kept, and a parked connection ignores late messages', async t => {
  const { cursor, conns } = fakeCursor(t);
  const events = [];
  const { session_id: id } = await cursor.run({ cwd: 'w', model: 'm', prompt: 'a', onEvent: event => events.push(event) });
  const seen = events.length;
  conns[0].options.onUpdate({ sessionId: id, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'late' } } });
  assert.equal(events.length, seen, 'nothing reaches the finished turn');
  conns[0].fail = true;
  await assert.rejects(cursor.run({ cwd: 'w', model: 'm', prompt: 'b', resume: id }), /boom/);
  assert.equal(conns[0].closed, true);
  assert.equal(cursor.warmCount(), 0);
  const stop = new AbortController();
  stop.abort();
  await cursor.run({ cwd: 'w', model: 'm', prompt: 'c', resume: id, signal: stop.signal }).catch(() => {});
  assert.equal(conns.at(-1).closed, true);
  assert.equal(cursor.warmCount(), 0);
});

test('at most three Cursor processes stay warm across all bots, each for 10 idle minutes; one-offs are not kept', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const a = fakeCursor(t), b = fakeCursor(t);
  await a.cursor.run({ cwd: 'review', model: 'm', prompt: 'judge', schema: { type: 'object' } }).catch(() => {});
  assert.equal(a.cursor.warmCount(), 0, 'a classifier is never resumed');
  await a.cursor.run({ cwd: 'a1', model: 'm', prompt: 'p' });
  await a.cursor.run({ cwd: 'a2', model: 'm', prompt: 'p' });
  await b.cursor.run({ cwd: 'b1', model: 'm', prompt: 'p' });
  await b.cursor.run({ cwd: 'b2', model: 'm', prompt: 'p' });
  assert.equal(a.cursor.warmCount() + b.cursor.warmCount(), 3, 'one cap for every bot');
  assert.equal(a.conns[1].closed, true, 'the oldest goes first');
  a.cursor.close();
  assert.equal(b.cursor.warmCount(), 2, 'closing one bot leaves the others warm');
  t.mock.timers.tick(10 * 60 * 1000);
  assert.equal(b.cursor.warmCount(), 0);
  assert.ok([...a.conns, ...b.conns].every(conn => conn.closed));
});
