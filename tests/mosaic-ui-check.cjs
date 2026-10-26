const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ipcMain } = require('electron');

// Uses the real renderer and isolated smoke-test data; never calls a model or remote connector.
module.exports = async window => {
  const run = source => window.webContents.executeJavaScript(source);
  const output = path.resolve(__dirname, '../.scratch/mosaic');
  fs.mkdirSync(output, { recursive: true });
  const frame = () => run('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const capture = async name => { await frame(); fs.writeFileSync(path.join(output, name + '.png'), (await window.webContents.capturePage()).toPNG()); };
  window.webContents.setZoomFactor(1);
  window.setSize(1440, 960);
  ipcMain.removeHandler('connectorList');
  ipcMain.handle('connectorList', () => ['Context7', 'Microsoft Learn', 'OpenAI Docs', 'Phasma Editor'].map((name, id) => ({ id: String(id), name, state: 'connected', transport: 'http', toolCount: 5, confirmCalls: true })));
  await run(`(() => {
    window.mosaicSaved = { state, fleetState, selectedAgent, selectedId, draft: $('#prompt').value, appearance: document.documentElement.dataset.appearance };
    fleetState = null; selectedAgent = 'main'; selectedId = 'mosaic-chat';
    const session = { ...current(), id: selectedId, workspace: state.settings.workspace, access: 'read-only', queue: [], routes: [], items: [
      { id: 'mosaic-user', type: 'userMessage', content: [{ type: 'text', text: 'Ask PhasmaHarness to read the wiki and explain the project.' }] },
      { id: 'mosaic-result', type: 'agentResult', agentId: 'harness', agentName: 'PhasmaHarness', status: 'completed', deliveryId: 'mosaic-result', text: 'The project wiki lives in AppData.\\n\\nPhasma Harness connects your coding bots, workspace instructions and shared tools in one place.\\n\\nInstructions and wiki read. No files changed.' }
    ] };
    state = { ...state, connection: 'ready', busy: null, requests: [], waitingForAgents: [], coordinator: false, conversationId: selectedId, sessions: [session], agents: [
      { id: 'main', name: 'Main Bot' }, { id: 'harness', name: 'PhasmaHarness', workspace: 'C:/repos/PhasmaHarness' },
      { id: 'engine', name: 'PhasmaEngine', workspace: 'C:/repos/PhasmaEngine' },
      { id: 'engine-child', name: 'Engine Core', createdBy: 'engine', workspace: 'C:/repos/PhasmaEngine' },
      { id: 'projects', name: 'PhasmaProjects', workspace: 'C:/repos/PhasmaProjects' },
      { id: 'hero', name: 'AgainstTheHero', workspace: 'C:/repos/AgainstTheHero' },
      { id: 'render', name: 'RenderLens', workspace: 'C:/repos/RenderLens' }
    ] };
    $('#prompt').value = ''; render(); renderMessages(session); renderSidebarWidth();
  })()`);
  try {
    assert.deepEqual(await run(`(() => {
      const search = $('#agent-search'); search.value = 'engine core'; search.dispatchEvent(new Event('input'));
      const result = [...$('#agent-list').querySelectorAll('[data-agent]')].map(node => node.dataset.agent);
      search.value = ''; search.dispatchEvent(new Event('input')); return result;
    })()`), ['engine', 'engine-child'], 'search reveals a matching child under its creator');
    assert.equal(await run(`(() => { const search = $('#agent-search'); search.value = 'unknown'; search.dispatchEvent(new Event('input')); const empty = $('#agent-list').textContent; search.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true})); return empty.includes('No matching bots') && !search.value; })()`), true);
    assert.equal(await run(`(() => { const icon = $('#main-agent-list .mosaic-mark'); return icon.children.length === 4 && [...icon.children].every(tile => tile.getBoundingClientRect().width > 0 && tile.getBoundingClientRect().height > 0); })()`), true, 'tile identities are visible, not zero-sized');
    assert.equal(await run(`$('#composer-model-choice')`), null, 'model selection stays in Edit, not the composer');
    assert.equal(await run(`(() => { selectedAgent = 'engine-child'; render(); const locked = $('#prompt').readOnly; selectedAgent = 'main'; render(); return locked; })()`), true, 'creator-owned sub-bots keep chat locked');
    for (const mode of ['light', 'dark']) {
      await run(`document.documentElement.dataset.appearance = '${mode}'; true`);
      await capture(`chat-${mode}`);
      await run(`$('#settings-dialog').showModal(); $('#tab-connectors').click(); HarnessConnectors.show()`);
      const contrast = await run(`(() => {
        const luminance = color => { const rgb = color.match(/[\\d.]+/g).slice(0,3).map(n => { const s = Number(n)/255; return s <= .04045 ? s/12.92 : ((s+.055)/1.055)**2.4; }); return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722; };
        return ['.connector-state', '#connector-add', '.settings-tab.active'].map(selector => { const style = getComputedStyle($(selector)); const a = luminance(style.color), b = luminance(style.backgroundColor); return (Math.max(a,b)+.05)/(Math.min(a,b)+.05); });
      })()`);
      assert.ok(contrast.every(ratio => ratio >= 4.5), `${mode} status, selected tab and primary button text meet 4.5:1 contrast: ${contrast}`);
      await capture(`settings-${mode}`);
      assert.equal(await run(`(() => { const rail = $('.settings-tabs').getBoundingClientRect(), body = $('.settings-body').getBoundingClientRect(); return rail.right <= body.left + 1 && $('.settings-body').scrollWidth <= $('.settings-body').clientWidth; })()`), true, 'desktop Settings has a separate rail and no horizontal overflow');
      await run(`$('.connector-actions summary').click(); HarnessConnectors.show()`);
      assert.equal(await run(`$('.connector-actions').open`), true, 'background refresh preserves the open actions');
      await run(`$('.connector-actions summary').dispatchEvent(new KeyboardEvent('keydown', { key:'Escape', bubbles:true, cancelable:true })); true`);
      assert.equal(await run(`$('.connector-actions').open`), false);
      await run(`$('#tab-providers').click(); $('.settings-body').scrollTop = 0; true`);
      assert.equal(await run(`(() => {
        const connected = $('.provider-plug.connected'), disconnected = $('.provider-plug.disconnected');
        return connected && disconnected && getComputedStyle(connected).color !== getComputedStyle(disconnected).color
          && [...document.querySelectorAll('.provider-plug')].every(plug => getComputedStyle(plug).opacity === '1');
      })()`), true, `${mode} connection status stays visible even when provider controls are locked`);
      await capture(`providers-${mode}`);
      await run(`$('#settings-dialog').close(); true`);
      await run(`$('#job-details-heading').textContent = 'Task'; $('#job-details-log').textContent = 'Read the project instructions and wiki.\\n'.repeat(150); $('#job-dialog').show(); true`);
      for (const zoom of [.5, .75, 1, 1.15, 2, 3]) {
        window.webContents.setZoomFactor(zoom); await frame();
        for (const scroll of [0, 100000]) {
          await run(`$('#job-dialog').scrollTop = ${scroll}; true`); await frame();
          const close = await run(`(() => {
            const button = $('#job-dialog .close-dialog'), box = button.getBoundingClientRect();
            const overlay = navigator.windowControlsOverlay, safe = overlay?.getTitlebarAreaRect();
            return { visible: box.top >= 0 && box.bottom <= innerHeight && box.right <= innerWidth
              && document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2) === button,
              clear: !overlay?.visible || box.top >= safe.bottom || box.right <= safe.right };
          })()`);
          assert.deepEqual(close, { visible: true, clear: true }, `${mode} Task close stays visible outside native controls at ${zoom * 100}% zoom, scroll ${scroll}`);
        }
        if (zoom === .5 || zoom === 3) await capture(`task-${mode}-${zoom * 100}`);
      }
      await run(`$('#job-dialog .close-dialog').click(); true`);
      assert.equal(await run(`$('#job-dialog').open`), false, 'Task close still dismisses the panel');
      window.webContents.setZoomFactor(1); await frame();
    }
    // Desktop widths, then a phone held upright and on its side (about 412x800 and 915x360 visible in its browser).
    for (const [width, height] of [[1100, 820], [600, 820], [412, 800], [915, 360], [390, 820]]) {
      window.setSize(width, height); await frame();
      await run(`renderSidebarWidth(); $('#settings-dialog').showModal(); true`);
      const geometry = await run(`(() => { const body = $('.settings-body'), dialog = $('#settings-dialog').getBoundingClientRect(); return { fits: body.scrollWidth <= body.clientWidth + 1 && dialog.left >= 0 && dialog.right <= innerWidth + 1, close: $('#settings-close').getBoundingClientRect().bottom <= dialog.bottom }; })()`);
      assert.deepEqual(geometry, { fits: true, close: true }, `Settings fits at ${width}px`);
      await capture(`settings-dark-${width}x${height}`);
      assert.equal(await run(`$('.settings-tabs').getAttribute('aria-orientation')`), width <= 720 || height <= 500 ? 'horizontal' : 'vertical');
      await run(`$('#settings-dialog').close(); true`);
      assert.equal(await run(`$('#send').getBoundingClientRect().right <= innerWidth && $('#composer').scrollWidth <= $('#composer').clientWidth + 1`), true, `composer fits at ${width}px`);
      assert.equal(await run(`$('#composer').getBoundingClientRect().bottom <= innerHeight`), true, `composer is on screen at ${width}x${height}`);
      await capture(`chat-dark-${width}x${height}`);
      // Phones show one screen at a time (like Grok): the chat fills the screen with a back button, or the bot list does.
      const phone = width <= 720 || height <= 500;
      // As a phone browser sees it: no desktop window buttons to keep clear of.
      if (phone) { await run(`document.body.classList.add('remote-view'); true`); await frame(); }
      const chat = await run(`(() => { const title = $('#session-title');
        return { sidebar: getComputedStyle($('.sidebar')).display !== 'none', back: $('#phone-back').getBoundingClientRect().width > 0,
          titleFits: title.scrollWidth <= title.clientWidth + 1 }; })()`);
      assert.deepEqual(chat, phone ? { sidebar: false, back: true, titleFits: true } : { sidebar: true, back: false, titleFits: chat.titleFits },
        `chat screen at ${width}x${height}`);
      if (phone)
        await capture(`phone-chat-dark-${width}x${height}`);
      if (phone) {
        // Back shows the bot list; opening a chat adds one history entry, so the phone's back gesture returns to the list.
        // (Tapping a row opens a chat through selectAgent, which needs the full fleet state this check does not load.)
        await run(`$('#phone-back').click(); true`); await frame();
        const list = await run(`(() => ({ main: getComputedStyle($('main')).display === 'none',
          full: $('.sidebar').getBoundingClientRect().width >= innerWidth - 1,
          label: $('#main-agent-list .agent-nav-label').getBoundingClientRect().width > 20 }))()`);
        assert.deepEqual(list, { main: true, full: true, label: true }, `back shows the bot list, filling the screen at ${width}x${height}`);
        await capture(`list-dark-${width}x${height}`);
        assert.equal(await run(`(() => { const last = [...document.querySelectorAll('#agent-list .agent-nav')].at(-1), sidebar = $('.sidebar');
          sidebar.scrollTop = sidebar.scrollHeight; const box = last.getBoundingClientRect(), bottom = $('.sidebar-bottom').getBoundingClientRect();
          const shown = box.bottom <= bottom.top + 1 && box.top >= 0 && bottom.bottom <= innerHeight + 1; sidebar.scrollTop = 0; return shown; })()`), true, `every bot can be scrolled into view at ${width}x${height}`);
        await run('showPhoneChat(); true'); await frame();
        assert.deepEqual(await run(`[document.body.classList.contains('phone-list'), history.state?.phoneChat]`), [false, true], 'opening a chat adds a history entry');
        await run(`$('#phone-back').click(); new Promise(r => setTimeout(r, 150))`); await frame();
        assert.equal(await run(`document.body.classList.contains('phone-list')`), true, 'back (the gesture or the button) returns to the list');
        await run('showPhoneChat(); true'); await frame();
        await run(`document.body.classList.remove('remote-view'); true`);
      }
    }
    console.log('Mosaic light/dark screenshots, search hierarchy, visible tiles, connector actions and 390/600/1100px and phone layouts passed');
  } finally {
    await run(`(() => { $('#settings-dialog').close(); const saved = window.mosaicSaved; state=saved.state; fleetState=saved.fleetState; selectedAgent=saved.selectedAgent; selectedId=saved.selectedId; $('#prompt').value=saved.draft; document.documentElement.dataset.appearance=saved.appearance; render(); delete window.mosaicSaved; })()`);
  }
};
