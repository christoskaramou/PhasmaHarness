// Opt-in account-backed run (2026-11-20): node tests/supervisor-live.cjs --list | --run [model id] [--large]
// One bot with Workers and Advisor on (Auto) gets a task of independent parts in a temporary project; the report says what
// the supervisor did: its agent tool calls, the workers it made and the model each job ran at, advisor calls and its answer.
// Harness's own tool approvals are accepted; any other approval (a command outside the sandbox) is declined and recorded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { Controller } = require('../src/controller.cjs');
const { Agents } = require('../src/agents.cjs');

const TASK = 'Add three independent CommonJS modules to this project, each with its own node:test file under test/: ' +
  'src/math.js (add, multiply, clamp), src/strings.js (reverse, capitalize, slugify) and src/dates.js (isLeapYear, daysInMonth). ' +
  'Then run npm test and report the result.';
// --large: several independent features in separate folders. Neither task mentions workers: the supervisor decides.
const LARGE_TASK = 'Build four independent features, each in its own folder with its own tests; they share no code. ' +
  '1. features/csv/: parse(text) returning an array of rows, handling quoted fields with commas and newlines, escaped double quotes ' +
  'and CRLF line endings, and stringify(rows) that quotes only when needed. ' +
  '2. features/cache/: an LRU cache class with get, set, delete and size, a maximum size, and an optional per-entry TTL in ' +
  'milliseconds, with an injectable clock for tests. ' +
  '3. features/router/: a URL path router with add(pattern, handler) supporting :params and a trailing * wildcard, and match(path) ' +
  'returning the handler and params, where the most specific pattern wins. ' +
  '4. features/markdown/: render(text) converting a Markdown subset (headings # to ###, paragraphs, **bold**, *italic*, `code`, ' +
  'unordered lists and links) to HTML, escaping HTML in text. ' +
  'Each feature needs thorough node:test tests in features/<name>/<name>.test.js. Finally run npm test and report the results.';
const LIMIT_MS = 30 * 60 * 1000;
const clip = (text, size = 400) => { const value = typeof text === 'string' ? text : JSON.stringify(text); return value && value.length > size ? value.slice(0, size) + '…' : value; };

async function main() {
  const mode = process.argv[2];
  assert.ok(['--list', '--run'].includes(mode), 'This uses real provider accounts. Opt in with --list or --run.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-supervisor-live-'));
  const workspace = path.join(root, 'project'); fs.mkdirSync(workspace);
  fs.writeFileSync(path.join(workspace, 'package.json'), JSON.stringify({ name: 'live-project', private: true, scripts: { test: 'node --test' } }, null, 2));
  fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Live project\n\nPlain CommonJS, no dependencies. Tests use node:test and node:assert.\n');
  const task = process.argv.includes('--large') ? LARGE_TASK : TASK;
  const report = { root, task, tools: [], delegations: [], requests: [], log: [] };
  const log = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (message, data) => report.log.push({ level, message, data: clip(data, 300) })]));
  const hub = new Controller(path.join(root, 'sessions.json'), workspace);
  Object.assign(hub.data.settings, { access: 'workspace-write', chatScan: false, jevEnabled: false, jevCompare: false, toolSelection: 'off',
    secondaryModel: 'off', router: 'off', replySuggestions: false, escalateFailedChecks: false });
  hub.log = log;
  let agents;
  try {
    await hub.initialize();
    const models = new Map();
    for (const choice of hub.catalog().filter(p => p.worker && (p.provider || 'codex') === 'codex' && hub.available(p)))
      models.set(choice.model, [...(models.get(choice.model) || []), choice]);
    if (mode === '--list') {
      console.log(JSON.stringify([...models].map(([model, variants]) => ({ model, efforts: variants.map(v => [v.id, v.effort]) })), null, 2));
      return;
    }
    const asked = process.argv.slice(3).find(arg => !arg.startsWith('--'));
    const variants = asked ? models.get(hub.resolveWorker(asked)?.model) || [] : [...models.values()].find(list => ['low', 'medium'].every(e => list.some(v => v.effort === e))) || [];
    const medium = asked ? variants.find(v => v.id === asked) : variants.find(v => v.effort === 'medium');
    assert.ok(medium, 'No connected Codex model with low and medium effort.');
    hub.data.settings.mode = medium.id;
    report.supervisorModel = medium.id;

    agents = new Agents(hub, async worker => { worker.log = log; });
    // Every agent tool call and delegation, with who made it.
    const tool = agents.tool.bind(agents), delegate = agents.delegate.bind(agents);
    agents.tool = (controller, session, name, args, ...rest) => {
      const entry = { at: Date.now(), by: agents.agentName(controller.agentId || 'main'), name, args: clip(args, 300) };
      report.tools.push(entry);
      try {
        const result = tool(controller, session, name, args, ...rest);
        if (result && typeof result.then === 'function') return result.then(value => { entry.result = clip(value, 300); return value; }, error => { entry.error = error.message; throw error; });
        entry.result = clip(result, 300); return result;
      } catch (error) { entry.error = error.message; throw error; }
    };
    agents.delegate = (sourceController, source, agentId, task, ...rest) => {
      const result = delegate(sourceController, source, agentId, task, ...rest);
      report.delegations.push({ at: Date.now(), from: agents.agentName(sourceController.agentId || 'main'), to: agents.agentName(agentId),
        role: agents.profile(agentId)?.role || null, jobMode: agents.findJob(result.jobId).job.mode, task: clip(task, 500) });
      return result;
    };

    const lead = await agents.saveAgent({ name: 'Lead', instructions: 'Software engineer for this project.', workspace, access: 'workspace-write',
      mode: medium.id, workerModel: 'chat', advisorModel: 'chat' });
    const leadBot = agents.controller(lead.id);
    await agents.initializeController(leadBot);
    const chat = agents.conversation(leadBot, true, workspace, 'workspace-write');

    // Harness's own tools are approved like a user would; anything else is declined, so nothing runs outside the sandbox.
    const answered = new Set();
    const approve = () => {
      for (const controller of agents.allControllers()) for (const request of controller.requests.values()) {
        if (answered.has(request.id)) continue;
        answered.add(request.id);
        const own = request.method === 'router/tool/requestApproval' || (request.method === 'mcpServer/elicitation/request' && /phasma/i.test(request.params?.serverName || ''));
        report.requests.push({ by: agents.agentName(controller.agentId || 'main'), method: request.method, decision: own ? 'accept' : 'decline', params: clip(request.params, 300) });
        try { controller.answer(request.id, { decision: own ? 'accept' : 'decline' }); } catch (error) { report.requests.at(-1).error = error.message; }
      }
    };
    const started = Date.now();
    report.started = new Date(started).toISOString();
    const sent = leadBot.send({ id: chat.id, text: task, mode: medium.id, task: 'on' });
    sent.catch(error => { report.sendError = error.message; });
    // Settled: no bot busy and no work pending for 15 s in a row.
    let quietSince = null;
    while (Date.now() - started < LIMIT_MS) {
      approve();
      // A message that failed and paused its queue waits for the user: it is not work in progress.
      const busy = agents.allControllers().some(c => c.busy || c.requests.size || c.data.sessions.some(s => s.queue?.some(m => !m.error) || s.pendingMessage)) || agents.pendingJobs().length;
      quietSince = busy ? null : quietSince ?? Date.now();
      if (quietSince && Date.now() - quietSince > 15000) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    report.minutes = Math.round((Date.now() - started) / 600) / 100;
    report.timedOut = Date.now() - started >= LIMIT_MS;

    // What each bot became, ran at and said.
    report.bots = agents.primary.data.agents.map(profile => ({ name: profile.name, role: profile.role || null, createdBy: agents.agentName(profile.createdBy || 'main'),
      mode: profile.mode, access: profile.access }));
    report.turns = agents.allControllers().flatMap(controller => controller.data.sessions.flatMap(session => (session.routes || [])
      .filter(route => route.model).map(route => ({ bot: agents.agentName(controller.agentId || 'main'), at: route.at, model: route.model, effort: route.effort || null, source: route.source })))).sort((a, b) => (a.at || 0) - (b.at || 0));
    report.leadMessages = chat.items.filter(item => ['userMessage', 'agentMessage', 'notice'].includes(item.type))
      .map(item => ({ type: item.type, agentReply: !!item.agentReply, text: clip(item.type === 'userMessage' ? (item.content || []).map(part => part.text || '').join('') : item.text, 1500) }));
    report.failedQueued = agents.allControllers().flatMap(c => c.data.sessions.flatMap(s => (s.queue || []).filter(m => m.error)
      .map(m => ({ bot: agents.agentName(c.agentId || 'main'), text: clip(m.text, 160), error: clip(m.error, 300) }))));
    report.files = fs.readdirSync(workspace, { recursive: true }).filter(file => !String(file).startsWith('node_modules')).map(String).sort();
    const test = spawnSync(process.execPath, ['--test'], { cwd: workspace, encoding: 'utf8', timeout: 120000 });
    report.npmTest = { status: test.status, tail: clip((test.stdout || '') + (test.stderr || ''), 1200) };
  } finally {
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    if (mode === '--run') console.log(path.join(root, 'report.json'));
    if (agents) { agents.closing = true; await agents.shutdown?.().catch(() => {}); }
    for (const controller of agents ? agents.allControllers() : [hub]) { try { controller.close(); } catch { /* closing */ } }
  }
}

main().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
