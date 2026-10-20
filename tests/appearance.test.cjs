const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const script = fs.readFileSync(path.join(__dirname, '../ui/appearance.js'), 'utf8');

function launch(saved, unavailable = false, router = undefined) {
  const store = new Map(saved === undefined ? [] : [['appearance', saved]]);
  const events = new Map();
  const controlEvents = new Map();
  const root = { dataset: {} };
  const control = {
    value: '',
    addEventListener: (name, callback) => controlEvents.set(name, callback),
  };
  const document = {
    documentElement: root,
    addEventListener: (name, callback) => events.set(name, callback),
    querySelector: selector => {
      assert.equal(selector, '#settings-appearance');
      return control;
    },
  };
  const localStorage = {
    getItem: key => {
      if (unavailable) throw new Error('Storage unavailable');
      return store.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (unavailable) throw new Error('Storage unavailable');
      store.set(key, value);
    },
  };

  vm.runInNewContext(script, { document, localStorage, router });
  const initialAppearance = root.dataset.appearance;
  events.get('DOMContentLoaded')();

  return {
    root, control, store, initialAppearance,
    change(value) {
      control.value = value;
      controlEvents.get('change')();
    },
  };
}

test('appearance uses System initially and rejects obsolete or corrupt saved values before paint', () => {
  for (const saved of [undefined, 'forest', 'LIGHT', '<script>']) {
    const page = launch(saved);
    assert.equal(page.initialAppearance, 'system');
    assert.equal(page.control.value, 'system');
  }
});

test('appearance changes persist locally and are restored before the controls initialize', () => {
  const page = launch();

  for (const mode of ['dark', 'light', 'system']) {
    page.change(mode);
    assert.equal(page.root.dataset.appearance, mode);
    assert.equal(page.store.get('appearance'), mode);
    assert.equal(launch(page.store.get('appearance')).initialAppearance, mode);
  }

  page.change('invalid');
  assert.equal(page.root.dataset.appearance, 'system');
  assert.equal(page.control.value, 'system');
  assert.equal(page.store.get('appearance'), 'system');
});

test('appearance remains usable when local storage is blocked', () => {
  const page = launch('dark', true);
  assert.equal(page.initialAppearance, 'system');

  page.change('light');
  assert.equal(page.root.dataset.appearance, 'light');
  assert.equal(page.control.value, 'light');
});

test('appearance is shared with the desktop window so its launch background matches', () => {
  const calls = [];
  const page = launch('light', false, { setAppearance: async mode => calls.push(mode) });
  page.change('dark');
  page.change('invalid');
  assert.deepEqual(calls, ['light', 'dark']);
  launch('dark', false, { setAppearance: () => Promise.reject(new Error('Window closed')) });
});


test('agent-confirmed appearance changes update the control and persistent theme without an IPC loop', () => {
  let receive;
  const shared = [];
  const page = launch('light', false, { onAppearance: callback => { receive = callback; }, setAppearance: mode => { shared.push(mode); } });
  receive('dark');
  assert.equal(page.root.dataset.appearance, 'dark');
  assert.equal(page.control.value, 'dark');
  assert.equal(page.store.get('appearance'), 'dark');
  assert.deepEqual(shared, ['light']);
  receive('invalid');
  assert.equal(page.root.dataset.appearance, 'dark');
});
