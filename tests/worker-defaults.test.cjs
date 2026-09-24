const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ClaudeCLI } = require('../src/providers/claude.cjs');
const { CursorCLI } = require('../src/providers/cursor.cjs');
const { WORKER_INSTRUCTIONS } = require('../src/worker-instructions.cjs');

test('a relocated checkout loads full bundled skills without global skill folders', t => {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness skills '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.cpSync(path.resolve(__dirname, '../skills'), path.join(root, 'skills'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src'));
  fs.copyFileSync(path.resolve(__dirname, '../src/worker-instructions.cjs'), path.join(root, 'src/worker-instructions.cjs'));
  const loaded = require(path.join(root, 'src/worker-instructions.cjs'));
  for (const name of loaded.DEFAULT_SKILLS) {
    const directory = path.join(root, 'skills', name);
    const body = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8')
      .replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '')
      .replaceAll('{{SKILL_DIR}}', directory.replace(/\\/g, '/'));
    assert.ok(loaded.WORKER_INSTRUCTIONS.includes(body));
  }
  assert.ok(!/[\\/]\.(agents|codex)[\\/]skills/.test(loaded.WORKER_INSTRUCTIONS));
  assert.ok(fs.existsSync(path.join(root, 'skills/large-responses/scripts/output.cjs')));
});

test('Claude and Cursor workers receive defaults; classifiers remain isolated', async () => {
  const claude = new ClaudeCLI();
  let args;
  claude.start = values => {
    args = values;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.write(JSON.stringify({ type: 'result', result: 'ok' }) + '\n');
      child.emit('close', 0);
    });
    return child;
  };
  const cursor = new CursorCLI();
  let prompt;
  // Replace ACP transport, retaining run() request construction.
  cursor.connect = () => ({ call: async (method, params) => {
    if (method === 'session/new') return { sessionId: 'test' };
    if (method === 'session/prompt') { prompt = params.prompt[0].text; return { stopReason: 'end_turn' }; }
    return {};
  }, close() {} });
  for (const schema of [undefined, { type: 'object' }]) {
    await claude.run({ model: 'test', prompt: 'hello', access: 'read-only', schema });
    const system = args[args.indexOf('--append-system-prompt') + 1];
    assert.equal(system.includes('Ponytail full'), !schema);
    await cursor.run({ model: 'test', prompt: 'hello', access: 'read-only', schema });
    assert.equal(prompt.includes('Bundled skill: caveman'), !schema);
    if (!schema) assert.ok(prompt.includes(WORKER_INSTRUCTIONS));
  }
});
