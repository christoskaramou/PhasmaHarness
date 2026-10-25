const fs = require('node:fs');
const path = require('node:path');

const LIMIT = 64 * 1024;

// The workspace root's AGENTS.md, read fresh for the bots that do not load it themselves. Harness never creates or edits
// it: the workspace's rule files and wiki belong to the user and to the agents they ask.
function projectRules(workspace) {
  const file = path.join(workspace, 'AGENTS.md');
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return '';
  }

  if (!stat.isFile())
    return '';

  if (stat.size > LIMIT)
    return `The workspace's AGENTS.md is over 64 KiB, so Harness did not pass it; read ${JSON.stringify(file)} with your file tools.\n`;

  return fs.readFileSync(file, 'utf8');
}

// Bots that load the workspace's own rule files themselves (checked 2026-10-25): Codex, Cursor, Antigravity and the
// DeepSeek CLI read AGENTS.md; Claude Code reads CLAUDE.md, and AGENTS.md only through an @AGENTS.md import. Muse skips
// AGENTS.md in workspaces it does not trust, so it gets the file from Harness, as do API models and Harness's own calls.
function loadsRulesItself(provider, workspace) {
  if (provider === 'claude-cli')
    return fs.existsSync(path.join(workspace, 'CLAUDE.md'));

  return ['codex', 'cursor-cli', 'native:antigravity', 'native:deepseek'].includes(provider);
}

module.exports = { projectRules, loadsRulesItself };
