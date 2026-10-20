'use strict';
const fs = require('node:fs');

function configureWindowZoom(contents, file, onError) {
  let percent = 115;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Number.isInteger(saved) && saved >= 50 && saved <= 300) percent = saved;
  } catch { /* New or invalid preferences use the default. */ }

  contents.on('did-finish-load', () => contents.setZoomFactor(percent / 100));
  contents.on('before-input-event', (event, input) => {
    if (!input.control || input.alt || input.meta) return;
    const increase = ['+', '='].includes(input.key) || input.code === 'NumpadAdd';
    const decrease = ['-', '_'].includes(input.key) || input.code === 'NumpadSubtract';
    if (!increase && !decrease) return;
    event.preventDefault();
    if (input.type !== 'keyDown') return;

    const next = Math.max(50, Math.min(300, percent + (increase ? 5 : -5)));
    if (next === percent) return;
    percent = next;
    contents.setZoomFactor(percent / 100);
    try {
      fs.writeFileSync(file + '.tmp', JSON.stringify(percent));
      fs.renameSync(file + '.tmp', file);
    } catch (error) { onError(error); }
  });
}

module.exports = { configureWindowZoom };
