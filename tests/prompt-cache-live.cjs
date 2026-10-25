// Opt-in account-backed verification. Never part of npm test or the automatic test pool.
// node tests/prompt-cache-live.cjs --run codex cursor-cli
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Controller } = require('../src/controller.cjs');
const { Agents } = require('../src/agents.cjs');
const { readSessionData } = require('../src/session-store.cjs');

async function main() {
  assert.equal(process.argv[2], '--run', 'Opt in explicitly: this uses connected provider accounts.');
  const requested = process.argv.slice(3);
  assert.ok(requested.length && requested.every(p => ['codex', 'cursor-cli', 'claude-cli'].includes(p)));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-cache-live-'));
  const report = { root, results: [], logs: [], cleanup: [] };
  for (const provider of requested) {
    const project = path.join(root, provider); fs.mkdirSync(project);
    const entry = path.join(project, 'PhasmaHarness.md');
    fs.writeFileSync(entry, '# Verification workspace\nFor chat verification, reply with the requested code only. Do not use tools, delegate or change files.\n');
    const hub = new Controller(path.join(project, 'sessions.json'), project);
    hub.log = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (message, data) => report.logs.push({ provider, level, message, data })]));
    let agents, timer;
    try {
      await hub.initialize();
      Object.assign(hub.data.settings, { replySuggestions: false, chatScanModel: 'off', jevCompare: false, jevEnabled: false });
      if (provider === 'cursor-cli' && hub.cursor.status.loggedIn) {
        await hub.discoverCursor();
        const model = hub.cursor.models.find(row => row.id === 'composer-2.5');
        assert.ok(model, 'Configured bounded Cursor test model is unavailable.');
        hub.data.settings.providerModels = [{ id: 'cursor-cli:' + model.id, provider, model: model.id, label: model.label,
          worker: true, enabled: true, rank: 1, parameterized: model.parameterized }];
      }
      const available = hub.catalog().filter(choice => choice.provider === provider && hub.available(choice));
      const choice = available.find(row => row.id === 'terra-light') || available.find(row => row.effort === 'low') || available[0];
      if (!choice) { report.results.push({ provider, skipped: 'No connected model; no inference attempted.' }); continue; }
      agents = new Agents(hub, async () => {});
      const session = agents.conversation(hub, true, project, 'read-only');
      const code = randomUUID();
      const wire = [], inference = [];
      const createClient = hub.smartRouter.createClient;
      hub.smartRouter.createClient = (...args) => {
        const client = createClient(...args), call = client.call.bind(client);
        client.call = (method, params, ...rest) => {
          if (['thread/start', 'thread/resume', 'turn/start'].includes(method)) wire.push({ method, threadId: params.threadId,
            bytes: Buffer.byteLength(JSON.stringify(params.input || params.baseInstructions || '')) });
          return call(method, params, ...rest);
        };
        return client;
      };
      if (provider !== 'codex') {
        const runtime = hub[provider === 'cursor-cli' ? 'cursor' : 'claude'], run = runtime.run.bind(runtime);
        if (provider === 'cursor-cli') {
          const connect = runtime.connect.bind(runtime);
          runtime.connect = options => {
            const rpc = connect(options), call = rpc.call.bind(rpc);
            rpc.call = (method, params, ...rest) => {
              if (method === 'session/prompt') wire.push({ method, bytes: Buffer.byteLength(JSON.stringify(params.prompt)) });
              return call(method, params, ...rest);
            };
            return rpc;
          };
        }
        runtime.run = options => {
          wire.push({ method: options.resume ? 'session/resume' : 'session/start', sessionId: options.resume, bytes: Buffer.byteLength(options.prompt) });
          return run(options);
        };
      }
      const complete = hub.smartRouter.complete.bind(hub.smartRouter);
      hub.smartRouter.complete = async (...args) => { const result = await complete(...args); inference.push({ usage: result.usage, timing: result.timing }); return result; };
      for (let turn = 0; turn < 4; turn++) {
        if (turn === 2) {
          hub.smartRouter.close();
          session.coordinatorConversation = readSessionData(hub.filename).sessions.find(s => s.id === session.id).coordinatorConversation;
        }
        if (turn === 3) fs.appendFileSync(entry, '\nCurrent verification rule: append UPDATED to the requested code.\n');
        const before = wire.length, calls = inference.length, started = Date.now();
        timer = setTimeout(() => hub.stop().catch(error => report.logs.push({ level: 'error', message: error.message })), 120000);
        console.log('START', provider, turn + 1);
        await hub.send({ id: session.id, mode: choice.id, task: 'off', text: turn === 0
          ? `Remember the verification code ${code}. Reply with that code only. No tools or other work.`
          : 'What was my original verification code? Reply with it, following the current workspace verification rule. No tools or other work.' });
        clearTimeout(timer);
        const answer = session.items.findLast(item => item.type === 'agentMessage')?.text || '';
        assert.equal(session.status, 'completed', session.error);
        assert.ok(answer.includes(code), 'The resumed model lost the original code.');
        if (turn === 3) assert.match(answer, /UPDATED/);
        assert.equal(inference.length - calls, 1, 'A simple fixed-model message must make exactly one inference call.');
        const saved = session.coordinatorConversation;
        const row = { provider, model: choice.model, turn: turn + 1, ms: Date.now() - started, answer,
          sessionId: saved?.sessionId || saved?.threadId, wire: wire.slice(before), ...inference.at(-1) };
        report.results.push(row);
        if (turn === 1 || turn === 2) assert.equal(row.sessionId, report.results.at(-2).sessionId, 'The native session must survive follow-up and restart.');
      }
    } catch (error) { report.error = `${provider}: ${error.stack}`; process.exitCode = 1; }
    finally {
      clearTimeout(timer);
      report.cleanup.push({ provider, result: agents ? await agents.shutdown({ stopMs: 10000 }) : await hub.shutdown() });
      const file = path.resolve('.scratch/prompt-cache-live-' + requested.join('-') + '-report.json');
      fs.writeFileSync(file, JSON.stringify(report, null, 2)); console.log('REPORT', file);
    }
    if (report.error) break;
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
