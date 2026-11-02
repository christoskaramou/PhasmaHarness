// Ctrl+F finds text in the shown chat; the filter button next to Overview sorts and filters bots.
const assert = require('node:assert/strict');

module.exports = async window => {
  const run = source => window.webContents.executeJavaScript(source);
  const find = await run(`(async () => {
    const fixture = document.createElement('div'); fixture.id = 'find-fixture';
    fixture.innerHTML = '<p>Alpha beta ALPHA</p><details><summary>More</summary><p>hidden alpha</p></details><p hidden>alpha never</p>';
    document.querySelector('#messages').append(fixture);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true }));
    const input = document.querySelector('#chat-find-input');
    const opened = !document.querySelector('#chat-find').hidden && document.activeElement === input;
    input.value = 'alpha'; input.dispatchEvent(new Event('input'));
    const count = document.querySelector('#chat-find-count').textContent;
    const enter = shiftKey => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true, cancelable: true }));
    enter(false); enter(false);
    const third = document.querySelector('#chat-find-count').textContent, detailsOpen = fixture.querySelector('details').open;
    enter(true);
    const back = document.querySelector('#chat-find-count').textContent;
    fixture.querySelector('p').append(' alpha');
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const live = document.querySelector('#chat-find-count').textContent;
    input.value = 'zzz'; input.dispatchEvent(new Event('input'));
    const none = [document.querySelector('#chat-find-count').textContent, input.classList.contains('no-results')];
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    const closed = document.querySelector('#chat-find').hidden && !CSS.highlights.has('chat-find');
    fixture.remove();
    return { opened, count, third, detailsOpen, back, live, none, closed };
  })()`);
  assert.deepEqual(find, { opened: true, count: '1 of 3', third: '3 of 3', detailsOpen: true, back: '2 of 3',
    live: '2 of 4', none: ['No results', true], closed: true });

  const sort = await run(`(() => {
    const saved = [localStorage.getItem('botSort'), localStorage.getItem('botFilter')];
    const rows = [{ name: 'beta', lastUserAt: 5 }, { name: 'Alpha', lastUserAt: 1 }, { name: 'gamma', lastUserAt: 9 }];
    const order = key => [...rows].sort(BOT_SORTS[key].compare).map(row => row.name);
    const button = document.querySelector('#agent-sort');
    button.click();
    const menu = document.querySelector('#agent-sort-menu');
    const open = menu.matches(':popover-open');
    const labels = [...menu.querySelectorAll('[role=menuitemradio]')].map(item => item.textContent);
    menu.querySelector('[data-sort=name]').click(); menu.querySelector('[data-filter=working]').click();
    const stored = [localStorage.getItem('botSort'), localStorage.getItem('botFilter')];
    const checked = [...menu.querySelectorAll('[aria-checked=true]')].map(item => item.textContent);
    const active = button.classList.contains('active');
    menu.querySelector('[data-sort=default]').click(); menu.querySelector('[data-filter=all]').click();
    const reset = !button.classList.contains('active');
    button.click();
    const shut = !menu.matches(':popover-open');
    for (const [key, value] of [['botSort', saved[0]], ['botFilter', saved[1]]])
      value === null ? localStorage.removeItem(key) : localStorage.setItem(key, value);
    return { name: order('name'), recent: order('recent'), oldest: order('oldest'), open, labels, stored, checked, active, reset, shut,
      working: ['Working', 'Waiting', 'Ready'].map(BOT_FILTERS.working.test) };
  })()`);
  assert.deepEqual(sort, {
    name: ['Alpha', 'beta', 'gamma'], recent: ['gamma', 'beta', 'Alpha'], oldest: ['Alpha', 'beta', 'gamma'], open: true,
    labels: ['Default order', 'Name (A–Z)', 'Your latest message', 'Longest without a message', 'All bots', 'Working', 'Needs attention', 'Idle'],
    stored: ['name', 'working'], checked: ['Name (A–Z)', 'Working'], active: true, reset: true, shut: true, working: [true, true, false] });
  console.log('Chat find (Ctrl+F, Enter/Shift+Enter, live updates, Escape) and bot sort/filter menu passed');
};
