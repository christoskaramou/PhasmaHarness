const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

// Windows needs 256 px for the exe and installer and small sizes for the taskbar and title bar.
test('the app icon is a Windows icon with small and 256 px images, used by the build, the window and the source setup', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const file = path.join(root, pkg.build.win.icon);
  assert.equal(pkg.build.win.icon, 'ui/icon.ico');
  assert.ok(pkg.build.files.includes('ui/**/*'), 'packaged with the app for the window icon');
  const data = fs.readFileSync(file);
  assert.equal(data.readUInt16LE(0), 0);
  assert.equal(data.readUInt16LE(2), 1, 'ICO type');
  const count = data.readUInt16LE(4);
  const sizes = Array.from({ length: count }, (_, i) => data[6 + i * 16] || 256);
  for (const size of [16, 24, 32, 48, 256]) assert.ok(sizes.includes(size), `has ${size} px`);
  for (let i = 0; i < count; i++) {
    const bytes = data.readUInt32LE(6 + i * 16 + 8), offset = data.readUInt32LE(6 + i * 16 + 12);
    assert.ok(offset + bytes <= data.length, 'image data inside the file');
  }
  assert.match(fs.readFileSync(path.join(root, 'src', 'main.cjs'), 'utf8'), /icon: path\.join\(__dirname, '\.\.', 'ui', 'icon\.ico'\)/);
  assert.match(fs.readFileSync(path.join(root, 'Install Phasma Harness.cmd'), 'utf8'), /IconLocation = \(Join-Path \$folder 'ui\\icon\.ico'\)/);
});
