// Paid routing-only comparison. Run explicitly with Electron; never included in *.test.cjs.
// electron tests/routing-decisions-live.cjs
const { app, safeStorage, net } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Controller } = require('../src/controller.cjs');
const { SmartRouter } = require('../src/routing/smart-router.cjs');
const { CodexClient } = require('../src/providers/codex.cjs');
const { BenchmarkStore } = require('../src/routing/benchmarks.cjs');
const { JevClient } = require('../src/providers/jev.cjs');
const { JevKey } = require('../src/providers/jev-key.cjs');
const { collectWorkspace } = require('../src/workspace/workspace-context.cjs');
const home = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Phasma Harness');
// safeStorage uses this profile's encryption key; the default Electron profile cannot decrypt Harness keys.
app.setPath('userData', home);

const cases = [
  { id: 'greeting', text: 'Hello!', workspace: false, kinds: ['general'] },
  { id: 'translation', text: 'Translate "the deadlock corrupted the database" into Greek. Only translate the sentence.', workspace: false, kinds: ['general'] },
  { id: 'lookup', text: 'Where in Phasma Harness is the decision to run configured checks made? Locate the function; do not change code.', workspace: true, kinds: ['lookup'] },
  { id: 'mechanical', text: 'Change only the checkbox label "Skip checks for this message" to "Skip checks once" in ui/index.html.', workspace: true, kinds: ['mechanical', 'implementation'] },
  { id: 'review', text: 'Review src/process-tree.cjs and its controller callers for unsafe PID reuse and incorrect crash recovery. Report concrete correctness findings; do not edit files.', workspace: true, kinds: ['review'] },
  { id: 'debugging', text: 'A configured check exits but a detached child remains alive, and Harness reports it passed. Investigate the root cause in the local check runner and fix it without killing unrelated processes.', workspace: true, kinds: ['debugging'] },
  { id: 'architecture', text: 'Design provider-independent parent/child task scheduling for Phasma Harness, avoiding deadlocks, preserving cancellation and inherited permissions. Explain the design; do not implement yet.', workspace: true, kinds: ['architecture'] },
  { id: 'followup', text: 'Yes, focus on the PID reuse case first.', workspace: true, kinds: ['review', 'debugging'], history: [
    { type: 'userMessage', content: [{ type: 'text', text: 'Review the local check runner for PID reuse and crash recovery bugs. Do not edit files.' }] },
    { type: 'agentMessage', phase: 'final_answer', text: 'I can inspect PID identity matching and orphan cleanup. Which should I examine first?' },
  ] },
];

app.whenReady().then(async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-routing-decisions-'));
  const workspace = path.resolve(__dirname, '..');
  const jevOnly = process.argv.includes('--jev-only');
  const diagnose = process.argv.includes('--failed-only');
  const failed = diagnose ? JSON.parse(fs.readFileSync(path.join(workspace, 'benchmarks/results/routing-decisions.json'))).samples.filter(s => s.error && s.router !== 'jev') : [];
  const output = path.join(workspace, `benchmarks/results/routing-decisions${diagnose ? '-diagnostics' : jevOnly ? '-jev' : ''}.json`);
  let controller;
  const routers = [];
  try {
    // Only copy settings; never open or mutate the real sessions with a Controller.
    const settings = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'))).settings;
    const filename = path.join(directory, 'sessions.json');
    fs.writeFileSync(filename, JSON.stringify({ version: 1, settings, sessions: [] }));
    controller = new Controller(filename, workspace);
    await controller.initialize();
    const workers = controller.catalog().filter(p => p.worker && controller.available(p));
    if (!workers.length) throw new Error('No available enabled workers.');
    const benchmarks = new BenchmarkStore(path.join(home, 'benchmarks.json'));
    const jev = new JevClient(new JevKey(path.join(home, 'jev-key.enc'), safeStorage), (...args) => net.fetch(...args));
    if (!jev.configured) throw new Error('Jev is not configured.');
    const choices = ['luna', 'terra', 'sol'].map(family => {
      const found = ['gpt-6-' + family, 'gpt-5.6-' + family].map(name => controller.models.find(m => m.model === name && m.supportedReasoningEfforts?.some(e => e.reasoningEffort === 'low'))).find(Boolean);
      if (!found) throw new Error('No available ' + family + ' low classifier.');
      return { name: family, provider: 'codex', model: found.model, effort: 'low' };
    });
    const report = { at: new Date().toISOString(), benchmarkSnapshot: benchmarks.id,
      note: 'One sample per case/router, low effort for GPT classifiers; routing only, no workers. Full enabled/available app catalog. Direct Jev answers disabled for comparison. Workspace evidence is cached per case and shared. Pass checks cover task kind and workspace relevance, not objective worker-model quality. Provider caches uncontrolled.',
      workers: workers.map(({ id, model, effort, provider }) => ({ id, model, effort, provider })), cases, samples: [] };
    const evidenceCache = new Map();
    for (const choice of [{ name: 'jev', provider: 'jev', model: 'jev-1.13.0' }, ...(jevOnly ? [] : choices)]) {
      if (diagnose && !failed.some(s => s.router === choice.name)) continue;
      const observed = [];
      const router = new SmartRouter(path.join(directory, choice.name), cwd => {
        const client = new CodexClient(cwd);
        client.on('notification', ({ method, params }) => {
          if (method === 'item/completed' && params?.item?.type === 'agentMessage') {
            try {
              const decision = JSON.parse(params.item.text);
              observed.push({ ...decision, reasonLength: decision.reason?.length });
            } catch { observed.push({ invalidJSON: true }); }
          }
        });
        return client;
      }, 45000, async (root, text) => {
        if (!evidenceCache.has(text)) evidenceCache.set(text, collectWorkspace(root, text, AbortSignal.timeout(10000)));
        return evidenceCache.get(text);
      });
      router.benchmarks = benchmarks;
      router.jev = jev;
      routers.push({ choice, router, observed });
      if (choice.provider !== 'jev') await router.warm(choice);
    }
    for (const task of cases) {
      const samples = await Promise.all(routers.filter(({ choice }) => !diagnose || failed.some(s => s.case === task.id && s.router === choice.name)).map(async ({ choice, router, observed }) => {
        observed.length = 0;
        const started = Date.now();
        try {
          const result = await router.choose(task.text, { workspace, items: task.history || [], routes: [], status: 'completed', routingCatalog: workers, routerChoice: choice, jevQuickAnswers: false }, controller.models, choice.name === 'jev' ? 'jev' : 'smart');
          const kindOK = task.kinds.includes(result.assessment.taskKind), workspaceOK = result.assessment.workspaceRelevant === task.workspace;
          return { case: task.id, router: choice.name, classifier: choice.model, elapsedMs: Date.now() - started, selected: result.id, label: result.label, assessment: result.assessment, reason: result.reason, usage: result.router.usage, evidence: result.router.evidence, kindOK, workspaceOK, observedDecisions: [...observed] };
        } catch (error) { return { case: task.id, router: choice.name, classifier: choice.model, elapsedMs: Date.now() - started, error: error.message, observedDecisions: [...observed] }; }
      }));
      report.samples.push(...samples);
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      for (const sample of samples) console.log(JSON.stringify({ ...sample, evidence: undefined, reason: undefined }));
    }
  } finally {
    for (const { router } of routers) router.close();
    controller?.close();
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}).then(() => app.exit(0), error => { console.error(error.message); app.exit(1); });
