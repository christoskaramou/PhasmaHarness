const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Run with: electron tests/ui-startup-smoke.cjs --chat-info-only
module.exports = async (window, controller) => {
  const run = source => window.webContents.executeJavaScript(source);
  const session = controller.create();
  session.items = [
    { id: 'child', type: 'info', kind: 'agent', title: 'Reviewer', text: 'Check <main> layout', status: 'running' },
    { id: 'summary', type: 'info', kind: 'reasoning', title: 'Reasoning summary', text: 'Checking keyboard navigation.' },
    { id: 'checkpoint', type: 'info', kind: 'progress', text: 'Checkpoint saved' },
    { id: 'tool', type: 'toolStep', title: 'Read layout.css', lines: ['body { margin: 0; }'] },
  ];
  controller.settings({ hideSteps: true });
  const draw = async () => {
    await run(`applyState(${JSON.stringify(controller.snapshot())}); selectedId = ${JSON.stringify(session.id)}; render();`);
    await run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  };
  const counts = () => run("[document.querySelectorAll('#messages .chat-info').length, document.querySelectorAll('#messages .activity').length]");
  await draw();
  assert.deepEqual(await counts(), [3, 0], 'Info is on by default with tools off');
  assert.equal(await run("document.querySelectorAll('.chat-info-heading')[2].textContent"), 'InfoProgress');
  assert.equal(await run("document.querySelector('.chat-info-text').textContent"), 'Check <main> layout');
  assert.equal(await run("document.querySelector('.chat-info main') === null"), true);
  controller.settings({ hideSteps: false });
  await draw();
  assert.deepEqual(await counts(), [3, 1]);
  const bounds = await run(`(() => {
    const rect = document.querySelector('#messages').getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, viewport: innerWidth };
  })()`);
  const page = await window.webContents.capturePage();
  const scale = page.getSize().width / bounds.viewport;
  const clip = Object.fromEntries(['x', 'y', 'width', 'height'].map(key => [key, Math.round(bounds[key] * scale)]));
  const image = page.crop(clip);
  assert.ok(!image.isEmpty());
  fs.writeFileSync(path.resolve(__dirname, '../.scratch/chat-info.png'), image.toPNG());
  await run(`state.settings.showInfo = false; renderMessages(current());`);
  assert.deepEqual(await counts(), [0, 1], 'hiding Info leaves tools visible');
  await draw();
  // Exercise the real General settings change handler, controller write and a fresh disk read.
  await run(`const picker = document.querySelector('#settings-chat-info');
    picker.value = 'off'; picker.dispatchEvent(new Event('change', { bubbles: true }));`);
  await run('settingsWrites');
  assert.equal(controller.data.settings.showInfo, false);
  assert.equal(require('../src/session-store.cjs').readSessionData(controller.filename).settings.showInfo, false);
  await draw();
  assert.deepEqual(await counts(), [0, 1]);
  console.log('Chat Info default, escaping, independent tools, General setting and persisted value passed.');
};
