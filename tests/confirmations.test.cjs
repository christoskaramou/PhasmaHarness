const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { confirmations } = require('../src/confirmations.cjs');

function setup() {
  const window = new EventEmitter(), contents = window.webContents = new EventEmitter(), sent = [];
  window.isDestroyed = () => false;
  contents.isLoadingMainFrame = () => false;
  contents.send = (channel, options) => sent.push({ channel, options });
  return { window, contents, sent, confirmation: confirmations(window) };
}
test('confirmation replies match one pending request and require explicit acceptance', async () => {
  const { confirmation, sent } = setup();
  const first = confirmation.ask({ title: 'Clear?' }), second = confirmation.ask({ title: 'Close?' });
  assert.equal(sent[0].channel, 'confirmation');
  assert.equal(sent[1].options.title, 'Close?');
  assert.notEqual(sent[0].options.id, sent[1].options.id);
  assert.throws(() => confirmation.answer(sent[0].options.id, 'true'), /Invalid/);
  confirmation.answer(sent[1].options.id, false);
  confirmation.answer(sent[0].options.id, true);
  assert.equal(await first, true); assert.equal(await second, false);
  confirmation.answer(sent[0].options.id, false);
});
test('closing, reloading or losing the renderer cancels pending confirmations', async () => {
  for (const event of ['closed', 'render-process-gone', 'did-start-navigation']) {
    const { confirmation, window, contents } = setup();
    const result = confirmation.ask({ title: 'Clear?' });
    if (event === 'closed') window.emit(event);
    else contents.emit(event, {}, 'file:///index.html', false, true);
    assert.equal(await result, false);
  }
  const { confirmation, window, contents, sent } = setup();
  contents.isLoadingMainFrame = () => true;
  assert.equal(await confirmation.ask({}), false);
  contents.isLoadingMainFrame = () => false;
  window.isDestroyed = () => true;
  assert.equal(await confirmation.ask({}), false);
  assert.equal(sent.length, 0);
});
