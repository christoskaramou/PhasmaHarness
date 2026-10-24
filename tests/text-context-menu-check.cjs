const { Menu, clipboard, ClipboardItem } = require('electron');
const assert = require('node:assert/strict');
const { configureTextContextMenu } = require('../src/text-context-menu.cjs');

module.exports = async window => {
  const run = source => window.webContents.executeJavaScript(source);
  const originalPopup = Menu.prototype.popup;
  let opened;
  Menu.prototype.popup = function (options) { opened = { menu: this, options }; };
  configureTextContextMenu(window);
  const saved = await Promise.all((await clipboard.read()).map(async item =>
    new ClipboardItem(Object.fromEntries(await Promise.all(item.types.map(async type => [type, await item.getType(type)]))))));
  try {
    await run(`(() => {
      const fixture = document.createElement('div'); fixture.id = 'context-test';
      fixture.style = 'position:fixed;inset:0;z-index:99999;background:white;color:black;padding:40px;user-select:text';
      fixture.innerHTML = '<p id="context-report">A completed worker report</p><textarea id="context-input"></textarea>';
      document.body.append(fixture);
    })()`);
    const rightClick = async selector => {
      opened = null;
      const point = await run(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: Math.round(r.left + 10), y: Math.round(r.top + 10) }; })()`);
      const event = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('No native context-menu event')), 3000);
        window.webContents.once('context-menu', (_event, params) => { clearTimeout(timeout); resolve(params); });
      });
      window.webContents.sendInputEvent({ type: 'mouseDown', button: 'right', clickCount: 1, ...point });
      window.webContents.sendInputEvent({ type: 'mouseUp', button: 'right', clickCount: 1, ...point });
      return event;
    };
    await run(`(() => { const r = document.createRange(); r.selectNodeContents(document.querySelector('#context-report')); getSelection().removeAllRanges(); getSelection().addRange(r); })()`);
    const report = await rightClick('#context-report');
    assert.equal(report.selectionText, 'A completed worker report');
    assert.deepEqual(opened.menu.items.map(item => [item.role, item.enabled]), [['copy', true], ['paste', false]]);
    assert.equal(opened.options.window, window);
    window.webContents.copy();
    for (let i = 0; i < 100 && await clipboard.readText() !== report.selectionText; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await clipboard.readText(), report.selectionText);

    await run(`getSelection().removeAllRanges(); document.querySelector('#context-input').focus(); true`);
    await rightClick('#context-input');
    assert.equal(opened.menu.items.find(item => item.role === 'paste').enabled, true);
    window.webContents.paste();
    for (let i = 0; i < 100 && await run("document.querySelector('#context-input').value") !== report.selectionText; i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(await run("document.querySelector('#context-input').value"), report.selectionText);
    for (const property of ['readOnly', 'disabled']) {
      await run(`document.querySelector('#context-input').${property} = true; true`);
      await rightClick('#context-input');
      assert.ok(!opened || !opened.menu.items.find(item => item.role === 'paste').enabled, property + ' fields cannot paste');
      await run(`document.querySelector('#context-input').${property} = false; true`);
    }
    await run('getSelection().removeAllRanges(); true');
    await rightClick('#context-test');
    assert.equal(opened, null, 'blank space does not get an unrelated text menu');
    console.log('Native context menu: report copy, composer paste and locked fields passed');
  } finally {
    Menu.prototype.popup = originalPopup;
    await clipboard.write(saved);
    await run("document.querySelector('#context-test')?.remove(); true");
  }
};
