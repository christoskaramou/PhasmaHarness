// Explicit paid probe, excluded from *.test.cjs. Compares a saved router source with current code.
// node tests/routing-cost-live.cjs <before-smart-router.cjs> <results.json>
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const { SmartRouter } = require('../src/routing/smart-router.cjs');
const { CodexClient } = require('../src/providers/codex.cjs');
const { PRESETS } = require('../src/routing/router.cjs');

async function main() {
  const [baselinePath, outputPath] = process.argv.slice(2);
  if (!baselinePath || !outputPath) throw new Error('Pass saved baseline source and results path. This probe makes paid classifier calls.');
  const sourcePath = path.resolve(__dirname, '../src/routing/smart-router.cjs');
  const baseline = fs.readFileSync(baselinePath, 'utf8');
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', baseline)(createRequire(sourcePath), module, module.exports, path.dirname(sourcePath));
  const settings = JSON.parse(fs.readFileSync(path.join(process.env.APPDATA || path.join(os.homedir(), '.config'), 'Phasma Harness', 'sessions.json'))).settings;
  const match = /^codex:(.+):([^:]+)$/.exec(settings.routerPreset || '');
  if (!match) throw new Error('This probe requires a configured Codex Smart classifier.');
  const choice = { provider: 'codex', model: match[1], effort: match[2] === 'default' ? null : match[2] };
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-routing-cost-'));
  const client = new CodexClient(directory);
  const routers = {};
  try {
    await client.start();
    let cursor, models = [];
    do {
      const page = await client.call('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
      models.push(...page.data); cursor = page.nextCursor;
    } while (cursor);
    if (!models.some(m => m.model === choice.model)) throw new Error('Configured classifier is unavailable.');
    const defaults = new Set(PRESETS.map(p => p.model));
    const workers = models.filter(m => Array.isArray(settings.disabledCodexModels)
      ? !settings.disabledCodexModels.includes(m.model) : defaults.has(m.model)).flatMap(m =>
      (m.supportedReasoningEfforts?.length ? m.supportedReasoningEfforts.map(e => e.reasoningEffort) : [null]).map(effort =>
        ({ id: `codex:${m.model}:${effort || 'default'}`, provider: 'codex', model: m.model, effort, label: `${m.model} ${effort || ''}` })));
    if (!workers.length) throw new Error('No enabled Codex workers.');
    client.close(true);
    for (const [name, Type] of [['before', module.exports.SmartRouter], ['after', SmartRouter]]) {
      const router = new Type(directory);
      routers[name] = router;
      await router.warm(choice); // Startup only, no inference.
    }
    const report = { at: new Date().toISOString(), classifier: choice, workerCount: workers.length,
      baselineSha256: createHash('sha256').update(baseline).digest('hex'),
      currentSha256: createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex'),
      note: 'Two requests, one sample per version. Warm app-servers; provider caches uncontrolled. Actual successful classifier usage includes discarded baseline calls. No worker is executed.', samples: [] };
    for (const [index, prompt] of ['Hello!', 'Translate "good morning" into Greek.'].entries()) {
      for (const version of index ? ['after', 'before'] : ['before', 'after']) {
        const router = routers[version], pending = [], calls = [];
        const original = SmartRouter.prototype.classifyCodex;
        router.classifyCodex = function (...args) {
          const promise = original.apply(this, args).then(result => {
            calls.push({ usage: result.usage, workspaceRelevant: result.decision.workspaceRelevant });
            return result;
          });
          pending.push(promise); return promise;
        };
        const start = Date.now();
        const result = await router.choose(prompt, { workspace: path.resolve(__dirname, '..'), items: [], routes: [], routingCatalog: workers, routerChoice: choice }, models);
        const routeMs = Date.now() - start;
        await Promise.all(pending); // Include baseline calls that continued after routing returned.
        const totals = Object.fromEntries(['inputTokens', 'cachedInputTokens', 'outputTokens', 'totalTokens'].map(key => [key, calls.reduce((n, c) => n + (c.usage?.[key] || 0), 0)]));
        const sample = { version, prompt, routeMs, allCallsMs: Date.now() - start, calls, totals, reported: result.router.usage, selected: result.id };
        report.samples.push(sample);
        fs.mkdirSync(path.dirname(path.resolve(outputPath)), { recursive: true });
        fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
        console.log(JSON.stringify({ version, prompt, calls: calls.length, ...totals, routeMs }));
      }
    }
  } finally {
    client.close(true);
    for (const router of Object.values(routers)) router.close();
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
