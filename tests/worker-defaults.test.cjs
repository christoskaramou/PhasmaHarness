const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ClaudeCLI } = require('../src/providers/claude.cjs');
const { CursorCLI } = require('../src/providers/cursor.cjs');
const { WORKER_INSTRUCTIONS } = require('../src/worker-instructions.cjs');

test('workers are told rtk starts programs only: shell built-ins and PowerShell cmdlets run without it', () => {
  const skill = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'skills', 'rtk', 'SKILL.md'), 'utf8');
  assert.match(WORKER_INSTRUCTIONS, /Prefix programs with rtk/);
  assert.match(WORKER_INSTRUCTIONS, /shell built-ins and PowerShell cmdlets \(Get-Content, Select-String, cd\) run without it/);
  assert.match(skill, /rtk proxy Get-Content fails/);
  assert.doesNotMatch(WORKER_INSTRUCTIONS + skill, /Prefix shell commands with rtk/);
});

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
    assert.equal(loaded.readSkill(name), body, `${name} is readable on demand from the relocated checkout`);
    assert.ok(loaded.WORKER_INSTRUCTIONS.includes(path.join(directory, 'SKILL.md').replace(/\\/g, '/')), `${name} is indexed with its relocated path`);
  }
  assert.ok(loaded.WORKER_INSTRUCTIONS.length < 4000, 'workers get the short defaults and index, not full skill bodies');
  assert.match(loaded.WORKER_INSTRUCTIONS, /caveman: OPT-IN/);
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
    assert.equal(prompt.includes('Harness skills'), !schema);
    if (!schema) assert.ok(prompt.includes(WORKER_INSTRUCTIONS));
  }
});
