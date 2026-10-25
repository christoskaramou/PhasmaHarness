const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const samePath = (a, b) => typeof a === 'string' && (process.platform === 'win32'
  ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b));

// Only obsolete Main Bot transcripts in this Harness store's dedicated router workspace.
async function pruneCodex(client, directory, keep, now = Date.now(), signal) {
  for (const archived of [false, true]) {
    let cursor = null;
    do {
      signal?.throwIfAborted();
      const page = await client.call('thread/list', { cwd: directory, archived, cursor, limit: 100, sourceKinds: ['appServer'] }, 10000);
      for (const thread of page.data || []) {
        signal?.throwIfAborted();
        // Codex 0.163 and 0.164 report no pin flag; a thread filed in a section was organised by the user.
        if (!samePath(thread.cwd, directory) || keep.has(thread.id) || thread.isPinned || thread.section != null ||
            !['idle', 'notLoaded'].includes(thread.status?.type) ||
            !Number.isFinite(thread.updatedAt) || thread.updatedAt * 1000 >= now - RETENTION_MS) continue;
        await client.call('thread/delete', { threadId: thread.id }, 10000);
      }
      cursor = page.nextCursor;
    } while (cursor);
  }
}

function pruneClaude(directory, keep, home = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), now = Date.now()) {
  const projects = path.join(home, 'projects');
  let folders;
  try { folders = fs.readdirSync(projects, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  const encoded = fs.realpathSync(directory).normalize('NFC').replace(/[^a-zA-Z0-9]/g, '-');
  // Native builds use different hashes for long paths; validate the transcript's cwd as well.
  for (const folder of folders.filter(entry => entry.isDirectory() && (entry.name === encoded ||
    encoded.length > 200 && entry.name.startsWith(encoded.slice(0, 200) + '-')))) {
    const root = path.join(projects, folder.name);
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.jsonl$/i.test(entry.name)) continue;
      const id = entry.name.slice(0, -6), file = path.join(root, entry.name);
      const stat = fs.statSync(file);
      if (keep.has(id) || stat.mtimeMs >= now - RETENTION_MS || fs.existsSync(path.join(root, id))) continue;
      const fd = fs.openSync(file, 'r'), buffer = Buffer.alloc(65536);
      let head;
      try {
        head = buffer.subarray(0, fs.readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8');
        if (stat.size > buffer.length) head += '\n' + buffer.subarray(0,
          fs.readSync(fd, buffer, 0, buffer.length, stat.size - buffer.length)).toString('utf8');
      }
      finally { fs.closeSync(fd); }
      const records = head.split('\n').flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      if (records.some(record => record.sessionId === id && samePath(record.cwd, directory))) fs.unlinkSync(file);
    }
  }
}

module.exports = { pruneCodex, pruneClaude, RETENTION_MS };
