// Installed binaries only: help/version queries never submit a prompt or use a provider account.
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { findCodex } = require('../src/providers/codex.cjs');
const { ClaudeCLI } = require('../src/providers/claude.cjs');
const { CursorCLI } = require('../src/providers/cursor.cjs');
const { findNativeCLI } = require('../src/providers/native-cli.cjs');
const { CONTRACTS, verifyHelp } = require('../src/providers/contracts.cjs');

async function command(executable, args) {
  const result = await promisify(execFile)(executable.command, [...executable.args, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  return result.stdout + '\n' + result.stderr;
}

async function checkProviders(required = []) {
  for (const id of required) if (!Object.hasOwn(CONTRACTS, id)) throw new Error(`Unknown required provider: ${id}`);
  let failures = 0;
  for (const [id, contract] of Object.entries(CONTRACTS)) {
    try {
      let run;
      if (id === 'claude') { const cli = new ClaudeCLI(); run = args => cli.command(args); }
      else if (id === 'cursor') { const cli = new CursorCLI(); run = args => cli.command(args); }
      else {
        const executable = id === 'codex' ? await findCodex() : findNativeCLI(id + '-cli');
        run = args => command(executable, args);
      }
      const version = (await run(['--version'])).trim();
      verifyHelp(id, await run(contract.args));
      console.log(`PASS ${id}: ${version.replace(/\s+/g, ' ')}; required CLI interface present`);
    } catch (error) {
      if (error.code === 'ENOENT' && !required.includes(id)) console.log(`SKIP ${id}: not installed`);
      else { failures++; console.error(`FAIL ${id}: ${error.message}`); }
    }
  }
  if (failures) throw new Error(`${failures} provider compatibility check(s) failed.`);
}

if (require.main === module) checkProviders(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { checkProviders };
