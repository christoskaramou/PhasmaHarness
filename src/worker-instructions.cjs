const fs = require('node:fs');
const path = require('node:path');
const DEFAULT_SKILLS = ['workflow', 'caveman', 'i-have-adhd', 'ponytail', 'large-responses', 'rtk'];
const WORKER_INSTRUCTIONS = [
  'Harness default skills follow in full, active by default. Ponytail full applies to coding. No separate activation or installation needed.',
  'User overrides and applicable project instructions take precedence over skill preferences. Normal mode disables Caveman, action-first formatting and Ponytail. Individual stop commands disable the named behavior throughout the conversation until re-enabled. Repeating these defaults does not reactivate disabled behaviors.',
  'Action-first formatting is a reading preference, not a medical assumption. Preserve material findings, uncertainty, security, accessibility and requested functionality. Explain fully when asked. Clarity overrides compression. Do not invent time estimates or claim unmeasured savings. Complete authorized work rather than stopping at proposals.',
  'Skill paths refer to this Harness installation. Respect filesystem permissions. RTK and ripgrep are bundled in the Harness tools/bin folder, first on PATH; skill helpers run with node. If a bundled tool is missing or broken, report it (repair: npm ci or node tools/fetch.cjs in the Harness folder) and do not install system copies.',
  ...DEFAULT_SKILLS.map(name => {
    const directory = path.resolve(__dirname, '..', 'skills', name);
    const file = path.join(directory, 'SKILL.md');
    const body = fs.readFileSync(file, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replaceAll('{{SKILL_DIR}}', directory.replace(/\\/g, '/'));
    return '\nBundled skill: ' + name + '\nSource: ' + file + '\n' + body;
  }),
].join('\n\n');
module.exports = { WORKER_INSTRUCTIONS, DEFAULT_SKILLS };