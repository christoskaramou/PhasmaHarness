const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const LIMIT = 128 * 1024;

function scoped(root, relative = '') {
  if (typeof relative !== 'string' || path.isAbsolute(relative) || relative.toLowerCase().split(/[\\/]/).includes('.git')) throw new Error('Choose a workspace file.');
  const filename = path.resolve(root, relative), rel = path.relative(root, filename);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('Path is outside the workspace.');
  return filename;
}
async function checked(root, relative) {
  const filename = scoped(root, relative);
  const actual = await fs.realpath(filename);
  scoped(root, path.relative(root, actual));
  return actual;
}
async function git(root, args) {
  return (await exec('git', ['--no-optional-locks', '-C', root, ...args], { windowsHide: true, timeout: 15000, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })).stdout;
}
async function preview(root, relative) {
  const filename = await checked(root, relative), stat = await fs.stat(filename);
  if (!stat.isFile()) throw new Error('Choose a regular file.');
  const handle = await fs.open(filename, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, LIMIT));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const data = buffer.subarray(0, bytesRead);
    return { path: relative, absolutePath: filename, size: stat.size, truncated: stat.size > LIMIT,
      text: data.includes(0) ? 'Binary file: text preview unavailable.' : data.toString('utf8') };
  } finally { await handle.close(); }
}
async function changes(root) {
  let repo;
  try { repo = (await git(root, ['rev-parse', '--show-toplevel'])).trim(); }
  catch { return { available: false, entries: [] }; }
  const parts = (await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])).split('\0');
  const entries = [];
  for (let i = 0; i < parts.length && parts[i]; i++) {
    const status = parts[i].slice(0, 2), repoPath = parts[i].slice(3);
    const relative = path.relative(root, path.resolve(repo, repoPath)).replace(/\\/g, '/');
    scoped(root, relative);
    const old = /[RC]/.test(status) ? parts[++i] : null;
    const oldPath = old ? path.relative(root, path.resolve(repo, old)).replace(/\\/g, '/') : null;
    if (status === '??') entries.push({ path: relative, kind: 'untracked', status: '?' });
    else {
      if (status[0] !== ' ') entries.push({ path: relative, oldPath, kind: 'staged', status: status[0] });
      if (status[1] !== ' ') entries.push({ path: relative, kind: 'unstaged', status: status[1] });
    }
  }
  return { available: true, entries: entries.slice(0, 1000), truncated: entries.length > 1000 };
}
async function browse(root, action, relative = '', kind = '') {
  root = await fs.realpath(root);
  if (action === 'files') {
    const entries = [], pending = ['']; let visited = 0, truncated = false;
    while (pending.length && entries.length < 1000 && visited++ < 200) {
      const result = await browse(root, 'list', pending.shift());
      truncated ||= result.truncated;
      for (const entry of result.entries) {
        if (entry.directory) { if (pending.length < 200) pending.push(entry.path); else truncated = true; }
        else if (entries.length < 1000) entries.push(entry);
        else truncated = true;
      }
    }
    return { entries, truncated: truncated || pending.length > 0 };
  }
  if (action === 'changes') return changes(root);
  if (action === 'read') return preview(root, relative);
  if (action === 'list') {
    const directory = await checked(root, relative);
    const entries = (await fs.readdir(directory, { withFileTypes: true })).filter(e => e.name !== '.git' && (e.isDirectory() || e.isFile()))
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    return { entries: entries.slice(0, 1000).map(e => ({ name: e.name, path: path.relative(root, path.join(directory, e.name)).replace(/\\/g, '/'), directory: e.isDirectory() })), truncated: entries.length > 1000 };
  }
  if (action === 'diff') {
    scoped(root, relative);
    if (!['staged', 'unstaged', 'untracked'].includes(kind)) throw new Error('Invalid change type.');
    const list = await changes(root);
    const entry = list.entries.find(e => e.path === relative && e.kind === kind);
    if (!entry) throw new Error('This change is no longer present. Refresh the list.');
    if (kind === 'untracked') return { ...await preview(root, relative), note: 'Untracked file (not a Git diff).' };
    const paths = [relative];
    if (entry.oldPath) { try { scoped(root, entry.oldPath); paths.push(entry.oldPath); } catch { /* A rename can originate outside a nested workspace. */ } }
    const text = await git(root, ['--literal-pathspecs', 'diff', '--no-ext-diff', '--no-textconv', '--no-color', '--relative', ...(kind === 'staged' ? ['--cached'] : []), '--', ...paths]);
    return { path: relative, absolutePath: scoped(root, relative), text: text.slice(0, LIMIT) || 'No textual diff (possibly a binary or conflicted file).', truncated: text.length > LIMIT };
  }
  throw new Error('Unknown workspace action.');
}
module.exports = { browse };
