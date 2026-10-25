const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const ENTRY_NAME = 'PhasmaHarness.md';
const LEGACY = /(^|\/)(AGENTS(?:\.override)?|CLAUDE(?:\.local)?|GEMINI|\.?HERMES|INSTRUCTIONS)\.md$|(^|\/)\.github\/copilot-instructions\.md$|(^|\/)\.cursor\/rules\/.*\.mdc$/i;
const STARTER = '# Project instructions\n\n' +
  'This is the shared entry point for every agent launched by Harness in this workspace.\n\n' +
  '## Working rules\n\n' +
  '- Inspect relevant live source before editing. Preserve unrelated changes. Run focused checks and report what was actually verified.\n' +
  '- Keep project rules in PhasmaHarness.md. Provider entry files such as CLAUDE.md or AGENTS.md may exist only as pointers to it; put no separate rules in them.\n\n' +
  '## Project knowledge\n\n' +
  'Use the active workspace wiki index supplied by Harness with each worker request (Settings > Wiki). Its location can change; do not create a competing wiki here. Search focused pages with project_context when available, then verify claims in live source. Do not load the whole wiki.\n\n' +
  '## Improving these instructions\n\n' +
  'After a recurring correction, verified pitfall, or workflow change, propose a small update with supporting source references and a verification date. Keep this entry short; put detailed architecture and decisions in the wiki. Remove obsolete or duplicate guidance when proposing replacements. Apply updates only when the user authorizes them. Do not store secrets, raw conversations, or session diaries.\n';

function readEntry(root, relative) {
  const file = path.join(root, relative), stat = fs.lstatSync(file);
  if (fs.realpathSync(file) !== file || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
    throw new Error('Project instructions must be ordinary, unlinked regular files: ' + file);
  if (stat.size > 64 * 1024) throw new Error('Project instruction exceeds 64 KiB: ' + file);
  const body = fs.readFileSync(file, 'utf8');
  if (Buffer.byteLength(body) > 64 * 1024 || body.includes('\0')) throw new Error('Invalid project instruction text: ' + file);
  return { relative, body };
}

// Only the workspace root holds rules: its PhasmaHarness.md or, while that is missing, the root's own provider files and
// its .cursor/rules and .github files. Subfolders are never searched, so a snapshot or another project inside the folder
// adds no rules and a large folder is not walked on every turn. Linked folders are not followed.
function legacyInstructionFiles(workspace) {
  const root = fs.realpathSync(workspace), names = [];
  const visit = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
      const name = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isDirectory()) {
        if (['.cursor', '.cursor/rules', '.github'].includes(name)) visit(name);
      } else if (LEGACY.test(name) && (!name.includes('/') || /^\.cursor\/rules\/[^/]+\.mdc$/i.test(name) ||
        /^\.github\/copilot-instructions\.md$/i.test(name))) names.push(name);
    }
  };
  visit('');
  const entries = names.sort().map(name => readEntry(root, name));
  if (entries.reduce((bytes, entry) => bytes + Buffer.byteLength(entry.body), 0) > 512 * 1024)
    throw new Error('Legacy project instructions exceed 512 KiB. Consolidate them before starting work.');
  return entries;
}

function consolidatedInstructions(entries) {
  const groups = new Map();
  for (const { relative, body } of entries) {
    const key = body.trim();
    const group = groups.get(key) || { body, files: [] };
    group.files.push(relative); groups.set(key, group);
  }
  const body = STARTER + (groups.size ? '\n## Imported project rules\n\nThe sections below preserve the workspace root\'s existing provider rules. Maintain these rules here; old entry filenames and mirror-sync instructions refer to this consolidated file. The active wiki supplied by Harness replaces old docs/wiki pointers.\n' : '') +
    [...groups.values()].map(group => '\n### Imported from: ' + group.files.join(', ') + '\n\n' + group.body.trim() + '\n').join('');
  if (Buffer.byteLength(body) > 64 * 1024) throw new Error('Consolidated project instructions exceed 64 KiB. Move detailed knowledge into the wiki.');
  return body;
}

function projectEntry(workspace, create = false) {
  const root = fs.realpathSync(workspace), file = path.join(root, ENTRY_NAME);
  if (create && !fs.existsSync(file)) {
    const body = consolidatedInstructions(legacyInstructionFiles(root));
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, body, { flag: 'wx', flush: true });
      // Publish only complete content, without replacing a concurrently created entry.
      fs.linkSync(temporary, file);
    }
    catch (error) { if (error.code !== 'EEXIST') throw new Error('Cannot create project entry ' + file + ': ' + error.message); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
  if (fs.lstatSync(file, { throwIfNoEntry: false })) readEntry(root, ENTRY_NAME);
  return file;
}

function projectBody(workspace, create = false) {
  const file = projectEntry(workspace, create);
  try { return readEntry(path.dirname(file), ENTRY_NAME).body; }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    // Ask mode must not write into the workspace just to initialize its entry.
    return 'The shared entry is missing and was not created in read-only mode.\n' + consolidatedInstructions(legacyInstructionFiles(workspace));
  }
}

function projectInstructions(workspace, create = false) {
  const body = projectBody(workspace, create), file = path.join(fs.realpathSync(workspace), ENTRY_NAME);
  return '\nShared project entry: ' + JSON.stringify(file) +
    '\nThese are the current project rules for this turn, replacing earlier snapshots and legacy provider entry files. ' +
    'Maintain project rules in PhasmaHarness.md. Provider entry files such as CLAUDE.md or AGENTS.md may point to it so interactive tools load it; keep rules out of them. ' +
    'The active wiki path supplied by Harness replaces old docs/wiki locations. Existing access permissions still apply. ' +
    'Use Harness agent tools for delegation so workers receive the same project rules.\n' + body;
}

// Legacy Undo cards must not recreate INSTRUCTIONS.md after consolidation.
function currentProjectEntry(file) {
  if (!file) return file;
  return path.basename(file).toLowerCase() === 'instructions.md' ? projectEntry(path.dirname(file), true) : file;
}

module.exports = { projectInstructions, projectBody, projectEntry, currentProjectEntry, legacyInstructionFiles, consolidatedInstructions, ENTRY_NAME, STARTER };
