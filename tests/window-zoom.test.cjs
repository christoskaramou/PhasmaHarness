'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { configureWindowZoom } = require('../src/window-zoom.cjs');

function setup(t, saved) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-zoom-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'zoom.json');
  if (saved !== undefined) fs.writeFileSync(file, JSON.stringify(saved));
  const contents = new EventEmitter();
  contents.setZoomFactor = value => { contents.zoom = value; };
  configureWindowZoom(contents, file, error => { throw error; });
  contents.emit('did-finish-load');
  const key = (key, extra = {}) => {
    let prevented = false;
    contents.emit('before-input-event', { preventDefault() { prevented = true; } },
      { type: 'keyDown', control: true, key, ...extra });
    return prevented;
  };
  return { contents, file, key };
}

test('whole-window zoom defaults to 115%, persists shortcuts and survives reload', t => {
  const { contents, file, key } = setup(t);
  assert.equal(contents.zoom, 1.15);
  assert.equal(key('='), true);
  assert.equal(contents.zoom, 1.2);
  key('+', { shift: true });
  assert.equal(contents.zoom, 1.25);
  key('-');
  assert.equal(JSON.parse(fs.readFileSync(file)), 120);
  contents.emit('did-finish-load');
  assert.equal(contents.zoom, 1.2);
  assert.equal(key('+', { control: false }), false);
  assert.equal(key('+', { alt: true }), false);
  key('+', { type: 'keyUp' });
  assert.equal(contents.zoom, 1.2);
});

test('zoom clamps at 50% and 300%, including keypad shortcuts', t => {
  const { contents, key } = setup(t, 295);
  key('Add', { code: 'NumpadAdd' });
  key('+');
  assert.equal(contents.zoom, 3);
  for (let i = 0; i < 60; i++) key('Subtract', { code: 'NumpadSubtract' });
  assert.equal(contents.zoom, .5);
});

test('saved zoom is validated before use', t => {
  for (const saved of [null, '150', 49, 301, 115.5]) assert.equal(setup(t, saved).contents.zoom, 1.15);
  assert.equal(setup(t, 150).contents.zoom, 1.5);
});
