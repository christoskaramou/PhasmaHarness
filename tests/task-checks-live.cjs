// Opt-in transport/gate smoke; no worker inference, project edits, or user state.
// node tests/task-checks-live.cjs <workspace>
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Controller } = require('../src/controller.cjs');
const { CodexClient } = require('../src/providers/codex.cjs');
const { createTask } = require('../src/tasks.cjs');

async function main() {
  if (!process.argv[2]) throw new Error('Pass a workspace path.');
  const workspace = fs.realpathSync(process.argv[2]);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'phasma-check-smoke-'));
  const client = new CodexClient(workspace);
  const router = { cancel() {}, close() {}, jev: null };
  const controller = new Controller(path.join(directory, 'state.json'), workspace, client, router);
  const rows = [];
  try {
    await client.start();
    controller.codex = { installed: true, connected: true };
    controller.connection = 'ready';
    const access = process.argv[3] || 'danger-full-access';
    const session = controller.create(workspace, access);
    // Only this smoke's fixed read-only Git check is approved, without a UI.
    controller.approveCheck = async (_session, check) => check.id === 'git-root';
    const checks = [{ id: 'git-root', name: 'Git workspace', argv: ['git', 'rev-parse', '--is-inside-work-tree'], cwd: workspace, timeoutMs: 10000, readOnlySafe: true }];
    for (let i = 0; i < 3; i++) {
      for (const enabled of [false, true]) {
        const task = createTask({ messageId: `smoke-${i}-${enabled}`, goal: 'Measure completion checks', checks: enabled ? checks : [], access: session.access });
        session.tasks ||= [];
        session.tasks.push(task);
        controller.busy = session.id;
        const start = performance.now();
        await controller.runGate(session, task, { token: task.id, turnId: task.id }, { status: 'completed' }, false);
        const elapsedMs = Math.round(performance.now() - start);
        assert.equal(task.state, enabled ? 'checks-passed' : 'not-checked');
        assert.equal(controller.busy, null);
        assert.ok(!controller.data.executionBlock);
        const result = task.attempts[0].results[0];
        if (enabled) assert.match(result.stdout, /true/);
        rows.push({ enabled, elapsedMs, commandMs: result?.durationMs ?? 0 });
      }
    }
    const report = { date: new Date().toISOString(), workspace, codexVersion: client.version, sandbox: controller.sandboxFor(access, workspace).type, rows,
      limitations: 'Synthetic completed worker; real gate, process lookup, persistence and command/exec. No model, build, UI, or cancellation smoke.' };
    fs.writeFileSync(path.join(directory, 'report.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ...report, evidence: directory }, null, 2));
  } finally {
    controller.close();
    client.close(true);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
