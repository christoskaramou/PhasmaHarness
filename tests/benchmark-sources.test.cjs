// The benchmark registry keeps only the Artificial Analysis evaluations that cover every current model; older tables
// with other sources still load, and the AA cost figure keeps its per-task unit all the way to the routers.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BenchmarkStore, validateSnapshot, pruneSources, routerCatalog, SOURCES, POLICY, ROUTER_POLICY } = require('../src/routing/benchmarks.cjs');
const bundled = require('../benchmarks/snapshot.json');

test('the registry and the bundled table hold only the seven evaluations that cover every current model', () => {
  const seven = ['aa-critpt', 'aa-hle', 'aa-index', 'aa-lcr', 'aa-omniscience', 'aa-terminal', 'scicode'];
  assert.deepEqual(Object.keys(SOURCES).sort(), seven);
  assert.deepEqual([...new Set(bundled.records.map(row => row.source))].sort(), seven);
});

test('a saved or imported table with rows from dropped sources loads without them instead of being rejected', t => {
  const kept = bundled.records.find(row => row.source === 'aa-index');
  const dropped = { ...kept, source: 'deepswe', metrics: { passPercent: 50 } };
  const table = { schemaVersion: 1, updatedAt: bundled.updatedAt, records: [kept, dropped] };
  assert.throws(() => validateSnapshot(structuredClone(table)), 'an unregistered source is still invalid on its own');
  assert.deepEqual(validateSnapshot(pruneSources(structuredClone(table))).records, [kept], 'import (main.cjs) prunes first');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-bench-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'benchmarks.json');
  fs.writeFileSync(file, JSON.stringify(table));
  const store = new BenchmarkStore(file);
  assert.equal(store.warning, null, 'the saved table is not reported invalid');
  assert.deepEqual(store.data.records, [kept]);
});

test('the AA cost figure reaches the routers as the average cost per task, not the cost of the whole index', () => {
  assert.match(SOURCES['aa-index'].metrics.costUsd, /per AA task/);
  const [row] = routerCatalog([{ id: 'a', label: 'A', benchmarks: [{ source: 'aa-index', version: '1', harness: 'api', score: 53.6, costUsd: 1.82 }] }]);
  assert.equal(row.taskCostUsd, 1.82);
  assert.match(ROUTER_POLICY, /taskCostUsd = average API USD per Intelligence Index task/);
  assert.match(POLICY, /average API USD per index task/);
  assert.doesNotMatch(POLICY + ROUTER_POLICY, /whole index|indexCostUsd/);
});
