// Explicit live evaluation only; excluded from *.test.cjs and the unattended test pool.
// electron tests/routing-decisions-live.cjs --list
// electron tests/routing-decisions-live.cjs --router=<catalog-id> [--router=<catalog-id> ...]
const cases = require('./fixtures/routing-difficulty.json');

async function evaluate(router, choice, workers) {
  const samples = [];
  const provider = choice.provider === 'jev' ? 'jev' : 'smart';
  const target = provider === 'jev' ? router.jev : router;
  const method = provider === 'jev' ? 'classify' : 'classifyCodex';
  const classify = target[method];
  let observed;
  // Prompt-only evaluation supplies no new evidence at the post-scan stage.
  target[method] = async (...args) => {
    if (observed) return { decision: observed.decision };
    observed = await classify.apply(target, args);
    return observed;
  };
  try {
    for (const task of cases) {
      observed = null;
      const started = Date.now();
      const sample = { case: task.id, expected: task.expected, router: choice.id };
      try {
        const result = await router.choose(task.text, { workspace: router.directory, routingCatalog: workers, routerChoice: choice,
          items: [], routes: [], configuredChecks: [], jevQuickAnswers: false }, [], provider);
        Object.assign(sample, { raw: observed.decision, selected: result.id, model: result.model, provider: result.provider || 'codex', effort: result.effort || null,
          assessment: result.assessment, reason: result.reason, usage: result.router.usage, attempts: observed.timing?.attempts,
          difficultyMatch: result.assessment.difficulty === task.expected, effortMatch: result.effort === task.expected });
      } catch (error) { sample.error = error.message; sample.raw = observed?.decision; }
      samples.push({ ...sample, elapsedMs: Date.now() - started });
    }
    return samples;
  } finally { target[method] = classify; }
}

async function main() {
  const { app, safeStorage, net } = require('electron');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { Controller } = require('../src/controller.cjs');
  const { Providers } = require('../src/providers/providers.cjs');
  const { SmartRouter } = require('../src/routing/smart-router.cjs');
  const { BenchmarkStore } = require('../src/routing/benchmarks.cjs');
  const { capCatalog } = require('../src/routing/effort-cap.cjs');
  const { JevClient, MODEL } = require('../src/providers/jev.cjs');
  const { JevKey } = require('../src/providers/jev-key.cjs');
  const ids = [...new Set(process.argv.filter(arg => arg.startsWith('--router=')).map(arg => arg.slice(9)))];
  if (process.argv.includes('--jev-only') && !ids.includes('jev')) ids.push('jev');
  if (!ids.length && !process.argv.includes('--list')) {
    console.log('Use --list for available router IDs, then --router=<id> for each router to evaluate. Each router makes four live classifications with at most one format retry per prompt. No workers or repository excerpts.');
    app.exit(0); return;
  }
  const home = path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Phasma Harness');
  app.setPath('userData', home);
  await app.whenReady();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-routing-decisions-'));
  const settings = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8')).settings;
  const filename = path.join(directory, 'sessions.json');
  // Never load the user's conversations or change their routing preferences.
  fs.writeFileSync(filename, JSON.stringify({ version: 1, settings: { ...settings, workspace: directory, jevEnabled: false, jevQuickAnswers: false, checks: {} }, sessions: [] }));
  const controller = new Controller(filename, directory);
  const routers = [];
  const report = { at: new Date().toISOString(), cases, samples: [], note: 'Prompt and catalog only, no source excerpts, history or workers. Only explicitly requested routers are called. Four independent cases per router; post-scan classification is reused because no evidence was added. Production difficulty policy and deadlines apply, including at most one format retry for Smart. Enabled catalog is frozen and capped at Xhigh for all samples. Provider caches are uncontrolled; one sample is not an accuracy guarantee.' };
  const output = path.join(directory, 'results.json');
  try {
    controller.providers = new Providers(path.join(home, 'provider-keys'), safeStorage, () => controller.data.settings.providers || [], (...args) => net.fetch(...args));
    controller.smartRouter.providers = controller.providers;
    await controller.initialize();
    if (controller.cursor.status.loggedIn) await controller.discoverCursor();
    const workers = capCatalog(controller.catalog().filter(p => p.worker && controller.available(p) && !controller.limits.limited(p.provider || 'codex', p.model)), 'xhigh');
    const jev = new JevClient(new JevKey(path.join(home, 'jev-key.enc'), safeStorage), (...args) => net.fetch(...args));
    const offered = [...workers, ...(jev.configured && settings.jevEnabled !== false ? [{ id: 'jev', provider: 'jev', model: MODEL }] : [])];
    if (process.argv.includes('--list')) { console.log(JSON.stringify(offered.map(({ id, model, effort, provider }) => ({ id, model, effort, provider })), null, 2)); return; }
    const choices = ids.map(id => { const choice = offered.find(p => p.id === id); if (!choice) throw new Error('Requested router is unavailable: ' + id); return choice; });
    const benchmarks = new BenchmarkStore(path.join(home, 'benchmarks.json'));
    report.benchmarkSnapshot = benchmarks.id;
    report.catalog = workers.map(({ id, model, effort, provider }) => ({ id, model, effort, provider }));
    for (const choice of choices) {
      const router = new SmartRouter(path.join(directory, 'router-' + routers.length), undefined, undefined, async () => ({ available: false, coverage: 'not-requested', files: [], signals: [], limitations: ['Prompt and catalog only.'] }));
      Object.assign(router, { benchmarks, providers: controller.providers, claude: controller.claude, cursor: controller.cursor, jev });
      routers.push(router);
      report.timeoutMs = router.timeoutMs;
      const samples = await evaluate(router, choice, workers);
      report.samples.push(...samples);
      fs.writeFileSync(output, JSON.stringify(report, null, 2));
      for (const sample of samples) console.log(JSON.stringify(sample));
    }
    console.log('Report: ' + output);
    process.exitCode = report.samples.some(s => s.error || !s.difficultyMatch || !s.effortMatch) ? 1 : 0;
  } finally {
    for (const router of routers) router.close();
    controller.close();
  }
}

module.exports = { evaluate };
if (require.main === module || require('node:path').resolve(process.argv[1] || '') === __filename)
  main().then(() => require('electron').app.exit(process.exitCode || 0), error => { console.error(error.message); require('electron').app.exit(1); });
