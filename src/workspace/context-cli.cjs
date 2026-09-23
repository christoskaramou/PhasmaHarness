const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { ContextSearch } = require('./context-search.cjs');
const run = promisify(execFile);
const HELP = `Usage: node src/workspace/context-cli.cjs --workspace <project path> --query <question> [--jev] [--json]
Read-only project context search. Local ranking is the default.
--jev sends bounded excerpts to TypeSafe, using the encrypted key saved by Phasma Harness.
--json returns the full result as JSON; otherwise output is concise text with source locations.
Works with the selected project folder. Phasma Harness need not be open.`;

class InputError extends Error {}
function parse(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = { jev: false, json: false }, seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (seen.has(arg)) throw new InputError('Duplicate option. Use --help for usage.');
    seen.add(arg);
    if (arg === '--jev' || arg === '--json') options[arg.slice(2)] = true;
    else if (arg === '--workspace' || arg === '--query') {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw new InputError('An option is missing its value. Use --help for usage.');
      options[arg.slice(2)] = args[++i];
    } else throw new InputError('Unknown option. Use --help for usage.');
  }
  if (!options.workspace || !path.isAbsolute(options.workspace)) throw new InputError('Specify an absolute --workspace path.');
  if (!options.query?.trim() || options.query.length > 1000) throw new InputError('Specify a --query between 1 and 1,000 characters.');
  return options;
}

function validateWorkspace(workspace) {
  try {
    if (!path.isAbsolute(workspace) || !fs.statSync(workspace).isDirectory()) throw new Error();
    return fs.realpathSync(workspace);
  } catch { throw new InputError('Choose an existing absolute workspace folder.'); }
}

function format(result) {
  const lines = [`Project context: ${result.query}`, `Workspace: ${result.workspace}`,
    `Ranking: ${result.mode}; ${result.hits.length} excerpts; ${(result.durationMs / 1000).toFixed(1)}s`];
  if (result.jev) lines.push(`Jev: ${result.jev.usage.inputTokens} input tokens; estimated $${result.jev.estimatedCostUsd.toFixed(6)}`);
  lines.push(...result.warnings.map(w => `Note: ${w}`), result.note);
  for (const hit of result.hits) {
    const location = hit.source === 'memory' ? `HISTORICAL MEMORY: ${hit.path}${hit.origin ? ' (' + hit.origin + ')' : ''}`
      : `${hit.source}: ${path.join(result.workspace, hit.path).replace(/\\/g, '/')}:${hit.line}`;
    lines.push('', location, hit.text);
  }
  if (!result.hits.length) lines.push('No matching excerpts. Continue targeted file search with other terms.');
  return lines.join('\n');
}

async function search(options, root, jev = null) {
  const engine = new ContextSearch(root, jev);
  const stop = () => engine.cancel(); process.once('SIGINT', stop);
  try { return { ...await engine.search(root, options.query, options.jev ? 'jev' : 'local'), workspace: root }; }
  finally { process.off('SIGINT', stop); }
}

async function throughElectron(options, root) {
  // safeStorage needs Electron, but the CLI never opens a window or the Router's session store.
  const tempRoot = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(tempRoot, 'codex-context-'));
  const env = { ...process.env, PHASMA_HARNESS_CONTEXT_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const controller = new AbortController(), stop = () => controller.abort();
  process.once('SIGINT', stop);
  try {
    if (process.platform === 'win32') {
      // safeStorage's Windows wrapping key is profile-specific. Copy only encrypted OS-crypt metadata.
      const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
      const state = JSON.parse(fs.readFileSync(path.join(appData, 'Phasma Harness', 'Local State'), 'utf8'));
      fs.writeFileSync(path.join(profile, 'Local State'), JSON.stringify({ os_crypt: state.os_crypt }), { mode: 0o600 });
    }
    const { stdout } = await run(require('electron'), [__filename, '--workspace', root, '--query', options.query, '--jev', '--json'], {
      cwd: __dirname, env, windowsHide: true, encoding: 'utf8', timeout: 40000, maxBuffer: 256 * 1024, signal: controller.signal,
    });
    return JSON.parse(stdout);
  } catch {
    if (controller.signal.aborted) throw new InputError('Search stopped.');
    const result = await search({ ...options, jev: false }, root);
    result.requested = 'jev'; result.warnings.push('Jev helper unavailable; used local ranking.');
    return result;
  } finally {
    process.off('SIGINT', stop);
    // The child has exited. Delete only the unique profile allocated directly under this temp root.
    if (path.dirname(path.resolve(profile)) === tempRoot && path.basename(profile).startsWith('codex-context-'))
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* Windows may briefly retain a cache handle. */ }
  }
}

async function main(args) {
  const options = parse(args);
  if (options.help) return HELP;
  const root = validateWorkspace(options.workspace);
  let result;
  if (options.jev && !process.versions.electron) result = await throughElectron(options, root);
  else {
    let jev;
    if (options.jev) {
      const { app, safeStorage } = require('electron');
      app.setName('Phasma Harness');
      if (process.env.PHASMA_HARNESS_CONTEXT_PROFILE) app.setPath('userData', process.env.PHASMA_HARNESS_CONTEXT_PROFILE);
      await app.whenReady();
      const { JevKey } = require('../providers/jev-key.cjs');
      const { JevClient } = require('../providers/jev.cjs');
      jev = new JevClient(new JevKey(path.join(app.getPath('appData'), 'Phasma Harness', 'jev-key.enc'), safeStorage));
    }
    result = await search(options, root, jev);
  }
  return options.json ? JSON.stringify(result) : format(result);
}

// Electron loads its entry script through browser_init, so require.main points at the loader.
if (require.main === module || (process.versions.electron && path.resolve(process.argv[1] || '') === __filename)) main(process.argv.slice(2)).then(output => {
  process.stdout.write(output + '\n', () => { if (process.versions.electron) require('electron').app.exit(0); });
}).catch(error => {
  const message = error instanceof InputError ? error.message : error.name === 'AbortError' || error.name === 'TimeoutError'
    ? 'Search stopped or timed out.' : 'Context search failed. Check that Node, ripgrep, and the workspace are available.';
  process.stderr.write(message + '\n', () => {
    if (process.versions.electron) require('electron').app.exit(1);
    else process.exitCode = 1;
  });
});

module.exports = { parse, format, validateWorkspace, main };
