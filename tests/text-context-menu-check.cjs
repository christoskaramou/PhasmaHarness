const { Menu, clipboard, ClipboardItem, nativeImage } = require('electron');
const assert = require('node:assert/strict');
const { configureTextContextMenu } = require('../src/text-context-menu.cjs');

module.exports = async window => {
  const run = source => window.webContents.executeJavaScript(source);
  const originalPopup = Menu.prototype.popup;
  let opened;
  Menu.prototype.popup = function (options) { opened = { menu: this, options }; };
  configureTextContextMenu(window);
  // An empty clipboard (CI runners) reads as an item with no types, which ClipboardItem refuses.
  const saved = await Promise.all((await clipboard.read()).filter(item => item.types.length).map(async item =>
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

    // 2026-10-31, the user: right click → Copy on opened images.
    await run(`(() => { const canvas = document.createElement('canvas'); canvas.width = 60; canvas.height = 40;
      const g = canvas.getContext('2d'); g.fillStyle = '#c00'; g.fillRect(0, 0, 60, 40);
      const image = document.createElement('img'); image.id = 'context-image'; image.src = canvas.toDataURL('image/png');
      document.querySelector('#context-test').append(image); return image.decode().then(() => true); })()`);
    // Electron 44's clipboard is async (read/ClipboardItem); the copied image arrives as image/png.
    const copiedSize = async () => {
      const item = (await clipboard.read()).find(entry => entry.types.includes('image/png'));
      if (!item) return null;
      const data = await item.getType('image/png');
      return nativeImage.createFromBuffer(Buffer.isBuffer(data) ? data : Buffer.from(await data.arrayBuffer())).getSize();
    };
    const picture = await rightClick('#context-image');
    assert.equal(picture.mediaType, 'image');
    assert.deepEqual(opened.menu.items.map(item => item.label), ['Copy image']);
    opened.menu.items[0].click();
    for (let i = 0; i < 100 && !await copiedSize(); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.deepEqual(await copiedSize(), { width: 60, height: 40 }, 'the image itself is on the clipboard');
    console.log('Native context menu: report copy, composer paste, locked fields and Copy image passed');
  } finally {
    Menu.prototype.popup = originalPopup;
    await clipboard.write(saved);
    await run("document.querySelector('#context-test')?.remove(); true");
  }
};
