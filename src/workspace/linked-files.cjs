const fs = require('node:fs/promises');
const path = require('node:path');
const { fileURLToPath } = require('node:url');

const IMAGE_LIMIT = 10 * 1024 * 1024;
const IMAGES = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
// Types the default app only displays. Scripts, shortcuts, installers and unknown types are shown in their folder instead,
// because a link in agent text can be shaped by web content and opening those would run them.
const OPENABLE = new Set([...Object.keys(IMAGES), ...`.pdf .txt .md .markdown .log .csv .tsv .json .jsonc .yaml .yml .toml .ini
  .cfg .xml .html .htm .css .scss .diff .patch .c .cc .cpp .cxx .h .hh .hpp .hxx .inl .cs .hlsl .hlsli .slang .glsl .wgsl
  .ts .tsx .rs .go .java .kt .swift .docx .xlsx .pptx .mp3 .wav .ogg .flac .mp4 .webm .mov`.split(/\s+/)]);

// A chat link target: absolute, workspace-relative or file: URL, with an optional :line[:col] or #L line suffix.
async function resolve(root, target) {
  if (typeof target !== 'string' || !target.trim() || target.length > 4096) throw new Error('Invalid file link.');
  let value = target.trim();
  try { value = /^file:/i.test(value) ? fileURLToPath(value) : value.replace(/^\/(?=[a-z]:[\\/])/i, ''); }
  catch { throw new Error('Invalid file link.'); }
  value = value.replace(/#L\d+(?:-L?\d+)?$/i, '').replace(/(?<=[^\\/:]):\d+(?:[:-]\d+)?$/, '');
  // Reaching a network path would send the Windows sign-in hash to whatever host the link names.
  if (/^[\\/]{2}/.test(value)) throw new Error('Network paths cannot be opened from chat links.');
  if (!path.isAbsolute(value) && !root) throw new Error('Choose a workspace to open relative file links.');
  try { return await fs.realpath(path.resolve(root || '', value)); }
  catch { throw new Error(`File not found: ${value}`); }
}

// Browser access reaches only the chat's workspace, as browseWorkspace does; returns the workspace-relative path.
async function inside(root, filename) {
  const relative = root ? path.relative(await fs.realpath(root), filename) : '..';
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative))
    throw new Error('Browser access opens only files inside the workspace.');
  return relative.replace(/\\/g, '/');
}

// Without a desktop shell (browser access) nothing opens on this computer: the page gets the workspace file to show.
async function open(root, target, shell) {
  const filename = await resolve(root, target);
  const directory = (await fs.stat(filename)).isDirectory();
  if (!shell) {
    if (directory) throw new Error('Open folders in the desktop app.');
    return { path: await inside(root, filename) };
  }
  if (!directory && !OPENABLE.has(path.extname(filename).toLowerCase())) return shell.showItemInFolder(filename);
  // openPath reports failures (such as no associated app) as a string instead of throwing.
  if (await shell.openPath(filename)) shell.showItemInFolder(filename);
}

async function image(root, target, workspaceOnly = false) {
  const filename = await resolve(root, target);
  if (workspaceOnly) await inside(root, filename);
  const type = IMAGES[path.extname(filename).toLowerCase()];
  if (!type) throw new Error('Not an image.');
  if ((await fs.stat(filename)).size > IMAGE_LIMIT) throw new Error('Image is too large to show.');
  return `data:${type};base64,${(await fs.readFile(filename)).toString('base64')}`;
}

module.exports = { resolve, open, image };
