const fs = require('node:fs');
const path = require('node:path');

const STARTER = `# Project instructions

This is the shared entry point for every model working in this workspace.

## Working rules

- Read applicable AGENTS.md, CLAUDE.md and other provider/project instructions. Preserve them. If rules conflict, identify the conflict rather than silently replacing rules.
- Inspect relevant live source before editing. Preserve unrelated changes. Run focused checks and report what was actually verified.

## Project knowledge

Use the active workspace wiki index supplied by Harness with each worker request (Settings > Wiki). Its location can change; do not create a competing wiki here. Search focused pages with project_context when available, then verify claims in live source. Do not load the whole wiki.

## Improving these instructions

After a recurring correction, verified pitfall, or workflow change, propose a small update with supporting source references and a verification date. Keep this entry short; put detailed architecture and decisions in the wiki. Remove obsolete or duplicate guidance when proposing replacements. Apply updates only when the user authorizes them. Do not store secrets, raw conversations, or session diaries.
`;

function projectInstructions(workspace, create = false) {
  const file = path.join(fs.realpathSync(workspace), 'INSTRUCTIONS.md');
  if (create) {
    try { fs.writeFileSync(file, STARTER, { flag: 'wx' }); }
    catch (error) { if (error.code !== 'EEXIST') throw new Error(`Cannot create project entry ${file}: ${error.message}`); }
  }
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return '\nProject entry is missing: ' + JSON.stringify(file) + '. It was not created in read-only mode. Follow existing project instructions.';
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('INSTRUCTIONS.md must be a regular file inside the workspace, not a link.');
  if (stat.size > 64 * 1024) throw new Error('INSTRUCTIONS.md exceeds 64 KiB. Keep the entry short and move detailed material to the wiki.');
  const body = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(body) > 64 * 1024 || body.includes('\0')) throw new Error('INSTRUCTIONS.md must be a text file under 64 KiB.');
  return '\nShared project entry: ' + JSON.stringify(file) + '\nApply these project rules alongside applicable provider files. Surface conflicting rules; do not rewrite them automatically. The active wiki path supplied by Harness overrides stale wiki-location pointers only.\n' + body;
}

module.exports = { projectInstructions, STARTER };
