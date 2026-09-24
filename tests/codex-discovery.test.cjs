const { test } = require('node:test');
const assert = require('node:assert/strict');
const { codexVersion } = require('../src/providers/codex.cjs');

test('slow CLI version probes leave the event loop responsive', async () => {
  let ticks = 0;
  const timer = setInterval(() => ticks++, 10);
  try {
    const version = await codexVersion({ command: process.execPath, args: ['-e', 'setTimeout(() => console.log("codex-cli 0.155.0"), 250)', '--'] });
    assert.deepEqual(version.core, [0, 155, 0]);
    assert.ok(ticks >= 5, 'UI and IPC must remain runnable while probing');
    assert.equal(await codexVersion({ command: 'nonexistent-harness-cli-executable', args: [] }), null);
  } finally { clearInterval(timer); }
});
