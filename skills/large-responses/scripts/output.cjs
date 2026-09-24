// Local bounded output capture/retrieval. Node standard library only; no model calls.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

const CACHE = path.join(fs.realpathSync(os.tmpdir()), 'agent-large-responses');
const BUDGET = 8000;
const USAGE = `Usage: node output.cjs <action> ...
  inspect <file> [--query text] [--line n] [--count n] [--column n]
  read <file> [--line n] [--count n] [--column n]
  search <file> --query "words"
  capture -- <command> [args...]
  cleanup [--days n]`;

function fingerprint(file) {
  const source = fs.realpathSync(file);
  if (!fs.statSync(source).isFile()) throw new Error('Source must be a regular file');
  const hash = createHash('sha256'), buffer = Buffer.alloc(65536), fd = fs.openSync(source, 'r');
  let bytes = 0;
  try { for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0; bytes += n) hash.update(buffer.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return { source, bytes, sha256: hash.digest('hex'), estimatedTokens: Math.ceil(bytes / 4) };
}

async function* lines(file) {
  let number = 0;
  for await (const line of readline.createInterface({ input: fs.createReadStream(file, 'utf8'), crlfDelay: Infinity })) yield [++number, line];
}

function slice(text, offset, budget) {
  const part = text.slice(offset, offset + Math.min(2000, budget));
  return { part, clipped: offset > 0 || offset + part.length < text.length };
}

async function excerpts(file, query, start, count, column) {
  const meta = fingerprint(file), found = [], needle = query?.toLowerCase();
  let used = 0, exhausted = false;
  for await (const [number, text] of lines(meta.source)) {
    if (query !== undefined ? !text.toLowerCase().includes(needle) : number < start) continue;
    if (found.length >= count || used >= BUDGET) { exhausted = true; break; }
    const offset = query !== undefined ? Math.max(column - 1, text.toLowerCase().indexOf(needle) - 200) : column - 1;
    const { part, clipped } = slice(text, offset, BUDGET - used);
    found.push({ line: number, column: offset + 1, text: part, clipped });
    used += part.length;
  }
  return { ...meta, excerpts: found, moreMayExist: exhausted, note: 'Bounded excerpts; omitted content remains in the source. Columns refer to decoded text.' };
}

// ponytail: single-pass term-count ranking over 30-line chunks replaces the old SQLite FTS5 index; use node:sqlite FTS5 if ranking quality on huge sources matters.
async function search(file, query, limit = 3) {
  const meta = fingerprint(file);
  const terms = [...new Set((query.match(/[\p{L}\p{N}_]+/gu) || []).map(t => t.toLowerCase()))].slice(0, 20);
  if (!terms.length) throw new Error('Query needs at least one word');
  const top = [];
  let chunk = [], size = 0, first = 1;
  const flush = () => {
    const text = chunk.join('\n').toLowerCase();
    const score = terms.reduce((sum, t) => sum + text.split(t).length - 1, 0);
    if (score) { top.push({ score, first, chunk }); top.sort((a, b) => b.score - a.score || a.first - b.first); top.length = Math.min(top.length, limit); }
  };
  for await (const [number, text] of lines(meta.source)) {
    if (chunk.length && (chunk.length >= 30 || size + text.length > 6000)) { flush(); chunk = []; size = 0; first = number; }
    chunk.push(text); size += text.length;
  }
  if (chunk.length) flush();
  if (fingerprint(file).sha256 !== meta.sha256) throw new Error('Source changed while searching; capture a stable snapshot');
  const hits = [];
  let used = 0;
  for (const { first, chunk } of top) {
    const match = Math.max(0, chunk.findIndex(line => terms.some(t => line.toLowerCase().includes(t))));
    for (let i = Math.max(0, match - 2); i < Math.min(chunk.length, Math.max(0, match - 2) + 12) && used < BUDGET; i++) {
      const positions = terms.map(t => chunk[i].toLowerCase().indexOf(t)).filter(p => p >= 0);
      const offset = i === match && positions.length ? Math.max(0, Math.min(...positions) - 200) : 0;
      const { part, clipped } = slice(chunk[i], offset, BUDGET - used);
      hits.push({ line: first + i, column: offset + 1, text: part, clipped });
      used += part.length;
    }
  }
  return { ...meta, excerpts: hits, note: 'Ranked partial evidence. Use read for complete source lines; no hits is not proof of absence.' };
}

function capture(command) {
  if (!command.length) throw new Error('Specify an already-authorized command after --');
  fs.mkdirSync(CACHE, { recursive: true });
  const folder = fs.mkdtempSync(path.join(CACHE, 'output-'));
  const stdout = path.join(folder, 'stdout.txt'), stderr = path.join(folder, 'stderr.txt');
  const out = fs.openSync(stdout, 'w'), err = fs.openSync(stderr, 'w');
  let result;
  try { result = spawnSync(command[0], command.slice(1), { stdio: ['ignore', out, err], windowsHide: true }); }
  finally { fs.closeSync(out); fs.closeSync(err); }
  if (result.error) throw new Error(`${command[0]}: ${result.error.message}${process.platform === 'win32' ? ' (run .cmd/.bat through cmd /c)' : ''}`);
  const exitCode = result.status ?? 1;
  return [{ exitCode, signal: result.signal, stdout: fingerprint(stdout), stderr: fingerprint(stderr) }, exitCode];
}

function cleanup(days) {
  let removed = 0;
  if (fs.existsSync(CACHE)) for (const entry of fs.readdirSync(CACHE, { withFileTypes: true })) {
    const folder = path.join(CACHE, entry.name);
    if (entry.name.startsWith('output-') && entry.isDirectory() && fs.statSync(folder).mtimeMs < Date.now() - days * 86400000) {
      fs.rmSync(folder, { recursive: true, force: true });
      removed++;
    }
  }
  return { removedOwnedTemporaryFolders: removed };
}

function parse(argv) {
  const [action, ...rest] = argv;
  if (!action || action === '--help' || action === '-h') { console.log(USAGE); process.exit(0); }
  if (action === 'capture') return { action, command: rest[0] === '--' ? rest.slice(1) : rest };
  const args = { action, line: 1, count: 20, column: 1, days: 7 };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i].match(/^--(query|line|count|column|days)$/);
    if (!flag) { if (args.path) throw new Error('Unexpected argument: ' + rest[i]); args.path = rest[i]; continue; }
    if (i + 1 >= rest.length) throw new Error(rest[i] + ' needs a value');
    args[flag[1]] = flag[1] === 'query' ? rest[++i] : Number(rest[++i]);
    if (flag[1] !== 'query' && !(Number.isSafeInteger(args[flag[1]]) && args[flag[1]] >= 1)) throw new Error(flag[1] + ' must be a positive integer');
  }
  if (!['inspect', 'read', 'search', 'cleanup'].includes(action)) throw new Error('Unknown action: ' + action + '\n' + USAGE);
  if (action !== 'cleanup' && !args.path) throw new Error(action + ' needs a file path');
  if (action === 'search' && !args.query) throw new Error('search needs --query');
  if (action === 'read') args.query = undefined;
  return args;
}

async function main() {
  const args = parse(process.argv.slice(2));
  let result, status = 0;
  if (args.action === 'capture') [result, status] = capture(args.command);
  else if (args.action === 'cleanup') result = cleanup(args.days);
  else if (args.action === 'search') result = await search(args.path, args.query);
  else result = await excerpts(args.path, args.query, args.line, Math.min(args.count, 100), args.column);
  console.log(JSON.stringify(result));
  process.exitCode = status;
}

main().catch(error => { console.error(JSON.stringify({ error: error.message })); process.exitCode = 1; });
