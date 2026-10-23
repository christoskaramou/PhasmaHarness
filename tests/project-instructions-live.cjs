// Opt-in real, billable CLI turns: node tests/project-instructions-live.cjs <AppData Wikis folder> [provider ...]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Controller } = require('../src/controller.cjs');
const { WikiStore } = require('../src/workspace/wiki-store.cjs');
const { ContextSearch } = require('../src/workspace/context-search.cjs');

async function main() {
  const directory = process.argv[2];
  assert.ok(directory && path.isAbsolute(directory), 'Pass the absolute AppData Wikis directory explicitly. This test uses real provider accounts.');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-entry-live-'));
  const workspace = path.join(root, 'workspace'); fs.mkdirSync(workspace);
  const wikiStore = new WikiStore(directory), wiki = wikiStore.ensure(workspace);
  const c = new Controller(path.join(root, 'sessions.json'), workspace, undefined, undefined, { wikiStore });
  c.contextSearch = new ContextSearch(workspace); c.contextSearch.wikiStore = wikiStore;
  Object.assign(c.data.settings, { museEnabled: true, antigravityEnabled: true, deepseekEnabled: true, toolSelection: 'off', chatScan: false });
  const results = [], log = [];
  c.log = Object.fromEntries(['info', 'warn', 'error'].map(level => [level, (message, data) => log.push({ level, message, data })]));
  c.on('state', () => {
    for (const [id, request] of c.requests) {
      const command = request.params?.command || '';
      // Native file reads of the two fixture directories are the only approvals this test grants.
      const data = String(command).replace(/\\\\/g, '\\');
      const allowed = /read|Get-Content|\bcat\b|\btype\b/i.test(data) &&
        [workspace, wiki.root].some(folder => data.toLowerCase().includes(folder.toLowerCase()) || data.includes(folder.replace(/\\/g, '/'))) &&
        !/write|delete|remove|mkdir|curl|invoke|https?:|[;&|>]/i.test(data);
      log.push({ level: 'approval', method: request.method, command, allowed });
      c.answer(id, { decision: allowed ? 'accept' : 'decline' });
    }
  });
  try {
    await c.initialize();
    if (c.cursor.status.loggedIn) {
      await c.discoverCursor();
      const model = c.cursor.models.find(m => m.id === 'composer-2.5') || c.cursor.models.find(m => m.id !== 'default');
      if (model) c.data.settings.providerModels = [{ id: 'cursor-cli:' + model.id, provider: 'cursor-cli', model: model.id,
        label: model.label, worker: true, enabled: true, rank: 1, parameterized: model.parameterized }];
    }
    const fullAccess = process.argv.includes('--allow-full-access');
    const providers = process.argv.slice(3).filter(arg => arg !== '--allow-full-access');
    for (const provider of providers.length ? providers : ['codex', 'claude-cli', 'cursor-cli', 'native:muse', 'native:antigravity', 'native:deepseek']) {
      const choices = c.catalog().filter(p => p.provider === provider && c.available(p));
      const selected = choices.find(p => /terra/.test(p.model) && p.effort === 'low') ||
        choices.find(p => /gemini.*flash-low|v4-flash/.test(p.model)) ||
        choices.find(p => /sonnet/.test(p.model) && p.effort === 'low') || choices[0];
      if (!selected) {
        const status = provider === 'claude-cli' ? c.claude.status : c.nativeCLIs.get(provider)?.status;
        results.push({ provider, status: 'unavailable', reason: status?.error || 'No signed-in, enabled model' });
        console.log('UNAVAILABLE', provider, results.at(-1).reason); continue;
      }
      const session = c.create(workspace, provider === 'native:antigravity' && fullAccess ? 'danger-full-access' : 'read-only');
      for (let turn = 1; turn <= 2; turn++) {
        const rule = randomUUID(), knowledge = randomUUID();
        fs.writeFileSync(path.join(workspace, 'PhasmaHarness.md'), '# Verification fixture\n\n' +
          'When asked to verify shared context, the current rule code is ' + rule + '. Use this supplied instruction, without opening or searching instruction files. ' +
          'Read verification.md in the active AppData wiki each turn, even on a resumed chat. Return only JSON with rule and wiki fields. Do not edit any files or delegate.\n');
        fs.writeFileSync(wiki.index, '# Verification wiki\n\n[Current verification code](verification.md)\n');
        fs.writeFileSync(path.join(wiki.root, 'verification.md'), '# Verification\n\nCurrent wiki code: ' + knowledge + '\n');
        const start = session.items.length, started = Date.now();
        const timeout = setTimeout(() => c.stop().catch(() => {}), 180000);
        console.log('START', provider, selected.model, 'turn', turn);
        try {
          await c.send({ id: session.id, mode: selected.id, task: 'off', text: 'Verify shared context using the current project instructions and active wiki. Return the two current codes.' });
          while (c.busy === session.id && Date.now() - started < 185000) await new Promise(resolve => setTimeout(resolve, 100));
          const items = session.items.slice(start);
          const answers = items.filter(i => i.type === 'agentMessage').map(i => i.text || '').join('\n');
          const passed = answers.includes(rule) && answers.includes(knowledge) && !session.error;
          const result = { provider, model: selected.model, turn, status: passed ? 'passed' : 'failed', elapsedMs: Date.now() - started,
            expected: { rule, wiki: knowledge }, answer: answers, error: session.error, items };
          results.push(result); console.log(passed ? 'PASS' : 'FAIL', provider, 'turn', turn, session.error || answers.slice(0, 300));
          if (!passed) break;
        } finally { clearTimeout(timeout); }
      }
    }
  } finally {
    const cleanup = await c.shutdown();
    const report = path.resolve('.scratch/project-instructions-live-' + Date.now() + '.json');
    fs.mkdirSync(path.dirname(report), { recursive: true });
    fs.writeFileSync(report, JSON.stringify({ root, workspace, wiki: wiki.root, results, log, cleanup }, null, 2));
    console.log('REPORT', report);
    // Keep isolated evidence for inspection; never remove the user's wiki or sessions.
  }
  if (results.some(r => r.status !== 'passed')) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
