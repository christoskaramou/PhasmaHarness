const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ClaudeCLI, handoff } = require('../src/providers/claude.cjs');
const { CursorCLI } = require('../src/providers/cursor.cjs');
const { WORKER_INSTRUCTIONS } = require('../src/worker-instructions.cjs');
const { withoutPersonalSetup } = require('../src/providers/codex.cjs');

test('saving delegated history preserves large answers without removing the provider transfer limit', () => {
  const items = [{ type: 'agentMessage', text: 'x'.repeat(1000001) }];
  assert.throws(() => handoff(items), /too large to transfer/);
  assert.ok(handoff(items, Infinity).includes(items[0].text));
});

test('workers are told rtk starts programs only: shell built-ins and PowerShell cmdlets run without it', () => {
  const skill = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'skills', 'rtk', 'SKILL.md'), 'utf8');
  assert.match(WORKER_INSTRUCTIONS, /Prefix programs with rtk/);
  assert.match(WORKER_INSTRUCTIONS, /shell built-ins and PowerShell cmdlets \(Get-Content, Select-String, cd\) run without it/);
  assert.match(skill, /rtk proxy Get-Content fails/);
  assert.doesNotMatch(WORKER_INSTRUCTIONS + skill, /Prefix shell commands with rtk/);
});

test('workers get the request rules: build what was asked, marked-up images, two readings, logs, no Co-Authored-By', () => {
  assert.match(WORKER_INSTRUCTIONS, /remove what they say to remove, for good/);
  assert.match(WORKER_INSTRUCTIONS, /a question gets an answer, not an edit/);
  assert.match(WORKER_INSTRUCTIONS, /name each mark back/);
  assert.match(WORKER_INSTRUCTIONS, /If two readings fit, ask one short question first/);
  assert.match(WORKER_INSTRUCTIONS, /no Co-Authored-By lines/);
  assert.match(WORKER_INSTRUCTIONS, /each log warning or error with its cause/);
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
    const body = fs.readFileSync(path.join(directory, 'SKILL.md'), 'utf8');
    assert.equal(loaded.readSkill(name), body, `${name} is readable on demand from the relocated checkout`);
    assert.ok(loaded.WORKER_INSTRUCTIONS.includes(path.join(directory, 'SKILL.md').replace(/\\/g, '/')), `${name} is indexed with its relocated path`);
  }
  assert.ok(loaded.WORKER_INSTRUCTIONS.length < 6500, 'workers get the short defaults and index, not full skill bodies');
  assert.match(loaded.WORKER_INSTRUCTIONS, /caveman: OPT-IN/);
  assert.ok(!/[\\/]\.(agents|codex)[\\/]skills/.test(loaded.WORKER_INSTRUCTIONS));
  assert.ok(fs.existsSync(path.join(root, 'skills/large-responses/scripts/output.cjs')));
});

test('Claude and Cursor workers receive defaults; classifiers remain isolated', async () => {
  const claude = new ClaudeCLI();
  let args, managedPrompt;
  claude.start = values => {
    args = values;
    if (args.includes('--append-system-prompt-file')) managedPrompt = require('node:fs').readFileSync(args[args.indexOf('--append-system-prompt-file') + 1], 'utf8');
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
  await claude.run({ model: 'test', prompt: 'continue', access: 'read-only', resume: 'old-chat',
    managedInstructions: true, instructions: 'Managed instruction marker.' });
  assert.equal(managedPrompt, 'Managed instruction marker.');
  assert.equal(args[args.indexOf('--append-subagent-system-prompt-file') + 1], args[args.indexOf('--append-system-prompt-file') + 1]);
  assert.equal(args[args.indexOf('--system-prompt-snapshot') + 1], 'off');
  assert.equal(require('node:fs').existsSync(args[args.indexOf('--append-system-prompt-file') + 1]), false);
  const exclusions = JSON.parse(args[args.indexOf('--settings') + 1]).claudeMdExcludes;
  assert.ok(exclusions.includes('**/CLAUDE.md') && exclusions.includes('**/AGENTS.md'));
  await cursor.run({ model: 'test', prompt: 'continue', access: 'read-only', instructions: 'Managed instruction marker.' });
  assert.match(prompt, /Managed instruction marker/);
});

// A stand-in home with a personal CLAUDE.md, one installed plugin, user MCP servers and personal Codex skills.
function personalHome(t) {
  const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'harness home '));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const claude = path.join(home, '.claude');
  fs.mkdirSync(path.join(claude, 'plugins'), { recursive: true });
  fs.writeFileSync(path.join(claude, 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'superpowers@official': [{}] } }));
  fs.writeFileSync(path.join(claude, '.claude.json'), JSON.stringify({ mcpServers: { docs: { command: 'docs' } } }));
  for (const skill of ['.agents/skills/mine', '.codex/skills/also-mine', '.codex/skills/.system/builtin']) {
    fs.mkdirSync(path.join(home, skill), { recursive: true });
    fs.writeFileSync(path.join(home, skill, 'SKILL.md'), '---\nname: x\n---\n');
  }
  return { home, claude };
}

function withEnv(t, values) {
  const saved = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined)
        delete process.env[key];
      else
        process.env[key] = value;
    }
  });
}

test('Claude bots leave out the personal setup: user settings, home CLAUDE.md, auto-memory and plugins off, user MCP servers kept', async t => {
  const path = require('node:path');
  const { claude: config } = personalHome(t);
  withEnv(t, { CLAUDE_CONFIG_DIR: config });
  const cli = new ClaudeCLI();
  let args;
  cli.start = values => {
    args = values;
    const child = new EventEmitter();
    child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
    setImmediate(() => {
      child.stdout.write(JSON.stringify({ type: 'result', result: 'ok' }) + '\n');
      child.emit('close', 0);
    });
    return child;
  };
  for (const schema of [undefined, { type: 'object' }]) {
    await cli.run({ model: 'test', prompt: 'hello', access: 'danger-full-access', schema });
    assert.equal(args[args.indexOf('--setting-sources') + 1], 'project,local', 'user settings (hooks, skills, subagents) stay out');
    assert.deepEqual(JSON.parse(args[args.indexOf('--settings') + 1]), {
      claudeMdExcludes: [path.join(config, 'CLAUDE.md'), path.join(require('node:os').homedir(), 'CLAUDE.md')].map(file => file.replace(/\\/g, '/')),
      enabledPlugins: { 'superpowers@official': false },
      autoMemoryEnabled: false,
    });
    const after = args.slice(args.indexOf('--mcp-config') + 1);
    const mcp = after.slice(0, after.findIndex(arg => arg.startsWith('--')));
    assert.deepEqual(mcp, schema ? ['{"mcpServers":{}}'] : [path.join(config, '.claude.json')], 'workers keep the user MCP servers; classifiers get none');
  }
});

test('Codex bots leave out the personal setup: hooks, plugins, memories, notify, personality and personal skills off, built-in skills kept', t => {
  const path = require('node:path');
  const { home } = personalHome(t);
  withEnv(t, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex') });
  const args = withoutPersonalSetup();
  assert.deepEqual(args.slice(0, 10), ['-c', 'features.hooks=false', '-c', 'features.plugins=false', '-c', 'features.memories=false',
    '-c', 'notify=[]', '-c', 'personality="none"']);
  const skills = args.find(arg => arg.startsWith('skills.config='));
  assert.match(skills, /^skills\.config=\[/);
  for (const skill of ['.agents/skills/mine', '.codex/skills/also-mine'])
    assert.ok(skills.includes(JSON.stringify(path.join(home, skill, 'SKILL.md').replace(/\\/g, '/')) + ', enabled=false'), skill);
  assert.ok(!skills.includes('builtin'), 'Codex keeps its own .system skills');
});
