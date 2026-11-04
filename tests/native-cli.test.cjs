const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { Controller } = require('../src/controller.cjs');
const { SmartRouter } = require('../src/routing/smart-router.cjs');
const { NATIVE_CLI_INFO, findNativeCLI } = require('../src/providers/native-cli.cjs');
const { buildDiagnostics } = require('../src/diagnostics.cjs');

function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-native-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

class NoCodex extends EventEmitter {
  async start() { throw Object.assign(new Error('Codex is not installed.'), { code: 'ENOENT' }); }
  async call() { throw new Error('Codex must not be used.'); }
  close() {}
}

async function controllerFixture(t, enabled) {
  const root = directory(t), calls = [];
  const backend = { models: [{ id: 'native:deepseek:model-a', model: 'model-a', label: 'DeepSeek A', provider: 'native:deepseek',
    worker: true, router: true, efforts: [], effort: null, rank: 35 }], status: { installed: true, loggedIn: true, version: 'fixture' },
    inspect() { calls.push('inspect'); return this.status; },
    async refresh() { calls.push('refresh'); return this.status; },
    async run(options) { calls.push(options); options.onEvent?.({ type: 'system', session_id: 'native-session' }); return { result: 'Native reply' }; },
    close() {},
  };
  const controller = new Controller(path.join(root, 'state.json'), root, new NoCodex(), { cancel() {}, close() {}, jev: null },
    { nativeCLIs: new Map([['native:deepseek', backend]]) });
  controller.data.settings.deepseekEnabled = enabled;
  controller.claude.refresh = async () => (controller.claude.status = { installed: false, loggedIn: false });
  controller.cursor.refresh = async () => (controller.cursor.status = { installed: false, loggedIn: false });
  await controller.initialize();
  t.after(() => controller.close());
  return { controller, backend, calls, root };
}

test('native binary discovery handles standard installs and missing executables without a shell', t => {
  const root = directory(t);
  const muse = path.join(root, 'Programs', 'muse');
  fs.mkdirSync(muse, { recursive: true });
  fs.writeFileSync(path.join(muse, 'muse-bin-1.4.9-R1.exe'), 'fixture');
  fs.writeFileSync(path.join(muse, 'muse-bin-1.4.10-R1.exe'), 'fixture');
  const env = { PATH: root, LOCALAPPDATA: root, USERPROFILE: root, APPDATA: root };
  assert.match(findNativeCLI('muse-cli', env, 'win32').command, /1\.4\.10/);
  assert.throws(() => findNativeCLI('antigravity-cli', env, 'win32'), { code: 'ENOENT' });
  const npm = path.join(root, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib');
  fs.mkdirSync(npm, { recursive: true });
  fs.writeFileSync(path.join(npm, 'bin.js'), 'fixture');
  const found = findNativeCLI('deepseek-cli', env, 'win32');
  assert.equal(found.command, process.execPath);
  assert.equal(found.args[0], path.join(npm, 'bin.js'));
  assert.ok(Object.keys(NATIVE_CLI_INFO).every(id => id.startsWith('native:')));
});

test('a native-only account becomes ready, dispatches without Codex and keeps missing usage unknown', async t => {
  const { controller, calls, root } = await controllerFixture(t, true);
  controller.wikiStore = new (require('../src/workspace/wiki-store.cjs').WikiStore)(path.join(root, 'Workspaces'));
  fs.writeFileSync(path.join(root, 'AGENTS.md'), 'Native managed instruction marker.');
  assert.equal(controller.connection, 'ready');
  assert.equal(controller.data.settings.routerPreset, 'native:deepseek:model-a');
  const session = controller.create(root, 'read-only');
  await controller.send({ id: session.id, text: 'hello', mode: 'native:deepseek:model-a', task: 'off' });
  const run = calls.find(call => typeof call === 'object');
  assert.equal(run.model, 'model-a');
  assert.equal(run.access, 'read-only');
  assert.doesNotMatch(run.instructions, /Native managed instruction marker/, 'the DeepSeek CLI loads AGENTS.md itself');
  assert.equal(run.managedInstructions, true);
  assert.equal(session['native:deepseekSessionId'], 'native-session');
  assert.equal(session.usage.total, undefined);
  assert.equal(session.usage.incomplete, true);
  assert.equal(session.routes.at(-1).turnUsage, undefined);
  assert.ok(session.items.some(item => item.text === 'Native reply'));
  assert.equal(controller.snapshot().nativeCLIs['native:deepseek'].version, 'fixture');
  const report = buildDiagnostics({ controller });
  assert.match(report, /DeepSeek Harness CLI fixture/);
  assert.doesNotMatch(report, /hello|Native reply/);
});

test('disabled native accounts are inspected without starting authentication or metadata subprocesses', async t => {
  const { controller, calls } = await controllerFixture(t, false);
  assert.deepEqual(calls, ['inspect']);
  assert.equal(controller.catalog().find(model => model.provider === 'native:deepseek').enabled, false);
});

test('resumed native workers send instructions once, refresh edits/access, and recover after a failed turn', async t => {
  const { controller, backend, calls, root } = await controllerFixture(t, true);
  controller.wikiStore = new (require('../src/workspace/wiki-store.cjs').WikiStore)(path.join(root, 'Workspaces'));
  const entry = path.join(controller.wikiStore.ensure(root).root, 'kept-rules.md');
  fs.writeFileSync(entry, 'Stable project rules.');
  const session = controller.create(root, 'read-only');
  const send = text => controller.send({ id: session.id, text, mode: 'native:deepseek:model-a', task: 'off' });
  for (let i = 0; i < 30; i++) await send(`Question ${i}`);
  const runs = () => calls.filter(call => typeof call === 'object');
  assert.equal(runs().length, 30, 'one model turn per message');
  assert.match(runs()[0].instructions, /Stable project rules/);
  assert.ok(runs().slice(1).every(call => call.instructions === '' && call.resume === 'native-session'));
  assert.ok(runs().slice(1).every(call => !call.prompt.includes('Earlier conversation')), 'native history is not replayed');
  assert.equal(require('../src/session-store.cjs').readSessionData(controller.filename).sessions.find(s => s.id === session.id)['native:deepseekInstructionHash'], session['native:deepseekInstructionHash']);
  fs.writeFileSync(entry, 'Changed project rules.'); await send('Read the updated rule.');
  assert.match(runs().at(-1).instructions, /Changed project rules/);
  await send('Continue'); assert.equal(runs().at(-1).instructions, '');
  session.access = 'workspace-write'; await send('Continue with new access');
  assert.match(runs().at(-1).instructions, /Changed project rules/);
  const run = backend.run; backend.run = async () => { throw new Error('Fixture disconnect'); };
  await send('Fail safely'); assert.equal(session.status, 'failed');
  backend.run = run; await send('Recover');
  assert.equal(runs().at(-1).resume, null);
  assert.match(runs().at(-1).instructions, /Changed project rules/);
  assert.match(runs().at(-1).prompt, /Question 0/, 'a fresh provider session receives history instead of losing it');
});

test('native structured routing selects its runtime and cannot fall back to Claude', async t => {
  const root = directory(t);
  const router = new SmartRouter(root);
  const calls = [];
  router.nativeCLIs = new Map([['native:deepseek', { run: async options => {
    calls.push(options); return { structured_output: { ok: true } };
  } }]]);
  router.claude = { run() { throw new Error('Wrong account'); } };
  const result = await router.completeOnce({ prompt: 'data', instructions: 'Return JSON', schema: {} },
    { provider: 'native:deepseek', model: 'model-a', effort: null }, new AbortController());
  assert.deepEqual(result.decision, { ok: true });
  assert.equal(calls[0].model, 'model-a');
  router.nativeCLIs.clear();
  await assert.rejects(router.completeOnce({ prompt: 'data', instructions: '', schema: {} },
    { provider: 'native:deepseek', model: 'model-a' }, new AbortController()), /provider is unavailable/);
});

test('an idle worker with a large context starts a fresh session from a summary instead of resuming', async t => {
  const { controller, calls, root } = await controllerFixture(t, true);
  const summaries = [], pendingDuring = [];
  controller.smartRouter.complete = async request => {
    summaries.push(JSON.parse(request.prompt)); if (session.pendingColdStep) pendingDuring.push(session.pendingColdStep.title);
    if (controller.failSummary) throw new Error('Fixture router down');
    return { decision: { summary: `SUMMARY-${summaries.length}` }, usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 10 } };
  };
  const logs = []; controller.log = { info: (message, data) => logs.push({ message, data }), warn() {}, error() {} };
  // A picked Secondary model writes the summary (the old router no longer stands in).
  Object.assign(controller.data.settings, { coldStartMinutes: 30, coldStartTokens: 1000, secondaryModel: controller.data.settings.routerPreset });
  const session = controller.create(root, 'read-only');
  const send = text => controller.send({ id: session.id, text, mode: 'native:deepseek:model-a', task: 'off' });
  const runs = () => calls.filter(call => typeof call === 'object');
  const idle = minutes => { session['native:deepseekTurnEndedAt'] = Date.now() - minutes * 60000; };
  for (let i = 0; i < 6; i++) await send(`Question ${i} ` + 'x'.repeat(1000));
  assert.ok(runs().slice(1).every(call => call.resume === 'native-session'), 'recent turns resume');

  idle(20); await send('Warm follow-up');
  assert.equal(runs().at(-1).resume, 'native-session', 'within the idle time the cache may still be warm');
  assert.equal(summaries.length, 0);

  idle(31); await send('After a long break');
  const cold = runs().at(-1);
  assert.equal(cold.resume, null, 'a new native session');
  assert.notEqual(cold.instructions, '', 'the new session gets its instructions');
  assert.match(cold.prompt, /SUMMARY-1/);
  assert.doesNotMatch(cold.prompt, /Question 0/, 'older messages arrive only as the summary');
  assert.match(cold.prompt, /Question 5/, 'the latest messages stay verbatim');
  assert.match(summaries[0].messages[0].text, /Question 0/);
  assert.equal(session.coldSummary, 'SUMMARY-1');
  assert.equal(session.usage.total.inputTokens, 100, 'the summary call is counted');
  const steps = () => session.items.filter(item => item.coldStart);
  const step = steps().at(-1), stepAt = session.items.indexOf(step);
  assert.ok(pendingDuring.some(title => /summarizing/.test(title)), 'the row is held as pending while the summary runs');
  assert.equal(session.pendingColdStep, null);
  assert.equal(step.title, 'Cold start · DeepSeek A · completed', 'the step names who summarized, like a tool call');
  assert.equal(session.items[stepAt - 1].type, 'userMessage', 'the step follows the message it ran for');
  assert.match(session.items[stepAt - 1].content[0].text, /After a long break/);
  assert.match(step.lines.join(' '), /Why: this chat was idle 31 min \(setting: 30\).*estimated from the visible chat.*What: DeepSeek A summarizes .*latest 4 messages.*Done: 1 summary call \(100 in \/ 10 out tokens\)/);
  assert.doesNotMatch(cold.prompt, /Cold start/, 'the step is not sent to the model');
  const logged = logs.find(entry => entry.message === 'Cold start')?.data;
  assert.equal(logged.avoidedEstimated, true, 'DeepSeek reports no usage, so the avoided context is estimated');
  assert.ok(logged.avoidedInputTokens >= 1000);
  assert.deepEqual([logged.summaryCalls, logged.summaryInputTokens, logged.summaryOutputTokens, logged.summaryModel], [1, 100, 10, 'native:deepseek:model-a']);
  assert.equal(logged.freshInputTokens, null, 'unknown, never zero');
  assert.equal(logged.status, 'completed'); assert.ok(logged.idleMinutes >= 31);
  assert.deepEqual({ session: session.id, ...session.routes.at(-1).coldStart }, logged);

  await send('Right after'); assert.equal(runs().at(-1).resume, 'native-session');
  assert.equal(summaries.length, 1);

  // Without usage reports, the size after a cold start is the summary plus the messages after it, not the whole chat.
  idle(31); await send('Short break');
  assert.equal(runs().at(-1).resume, 'native-session', 'the summary and the messages after it are under the size setting');
  assert.equal(summaries.length, 1);
  for (let i = 0; i < 3; i++) await send(`Later ${i} ` + 'y'.repeat(1500));
  idle(31); await send('Another break');
  assert.match(steps().at(-1).lines.join(' '), /estimated from the earlier summary and the messages after it/);
  assert.equal(summaries[1].summary, 'SUMMARY-1', 'a later cold start extends the summary');
  assert.ok(!summaries[1].messages.some(message => /Question 0/.test(message.text)));
  assert.match(runs().at(-1).prompt, /SUMMARY-2/);
  assert.match(steps().at(-1).lines.join(' '), /extending the earlier summary/);

  for (let i = 0; i < 3; i++) await send(`More ${i} ` + 'z'.repeat(1500));
  controller.failSummary = true; idle(31); await send('Router is down');
  assert.equal(runs().at(-1).resume, 'native-session', 'a failed summary falls back to resuming');
  assert.equal(steps().at(-1).title, 'Cold start · DeepSeek A · failed');
  assert.match(steps().at(-1).lines.join(' '), /Failed: Fixture router down.*Resumed the existing DeepSeek A session/);
  assert.equal(session.status, 'completed');
  controller.failSummary = false;

  controller.data.settings.coldStartMinutes = 0; idle(600); const before = summaries.length; await send('Turned off');
  assert.equal(runs().at(-1).resume, 'native-session'); assert.equal(summaries.length, before);
  controller.data.settings.coldStartMinutes = 30; controller.data.settings.coldStartTokens = 10000000; idle(600); await send('Small context');
  assert.equal(runs().at(-1).resume, 'native-session', 'below the context size it resumes');
  assert.throws(() => controller.settings({ coldStartMinutes: -1 }), /0 to 10080/);
  assert.throws(() => controller.settings({ coldStartTokens: 5 }), /1,000 to 10,000,000/);
});

test('a native worker with connectors and helper tools gets the connector note once', async t => {
  const { controller, calls, root } = await controllerFixture(t, true);
  controller.connectors = new (require('../src/connectors.cjs').Connectors)(root); controller.bridge.base = 'http://127.0.0.1:1';
  t.after(() => { controller.bridge.base = null; controller.connectors = null; });
  const session = controller.create(root, 'read-only');
  await controller.send({ id: session.id, text: 'hello', mode: 'native:deepseek:model-a', task: 'off' });
  const run = calls.find(call => typeof call === 'object');
  const text = run.instructions + (run.helpers?.instructions || '');
  assert.equal(text.split('Shared services are configured in Harness Settings').length - 1, 1);
});
