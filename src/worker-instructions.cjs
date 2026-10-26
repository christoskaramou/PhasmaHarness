const fs = require('node:fs');
const path = require('node:path');

// Full skill bodies are read on demand (router_read_output { skill } or the file); workers get only this index.
const SKILLS = {
  'i-have-adhd': 'full action-first formatting rules',
  ponytail: 'full Ponytail rules: intensity levels, review and audit modes',
  workflow: 'full Harness workflow and wiki rules',
  'large-responses': 'capture and search bulky command/tool output with exact line references (Node helper)',
  rtk: 'RTK usage details',
  caveman: 'OPT-IN ultra-compressed replies; use only when the user asks for caveman mode or fewer words',
  'test-pool': 'after a fix or task, add its regression test to .testpool; handle "Test pool:" failure reports',
};
const DEFAULT_SKILLS = Object.keys(SKILLS);
const skillDir = name => path.resolve(__dirname, '..', 'skills', name);

function readSkill(name, directories = {}) {
  if (!Object.hasOwn(SKILLS, name)) throw new Error(`Unknown Harness skill. Available: ${DEFAULT_SKILLS.join(', ')}.`);
  return fs.readFileSync(path.join(directories[name] || skillDir(name), 'SKILL.md'), 'utf8');
}

function skillContent(text) {
  const header = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  const field = header && /^description:[ \t]*(.*)(?:\r?\n((?:[ \t]+[^\r\n]*(?:\r?\n|$))*))?/m.exec(header[1]);
  let description = field?.[1].trim() || '';
  if (/^[>|][+-]?$/.test(description)) description = (field[2] || '').trim().replace(/\s*\r?\n\s*/g, ' ');
  else if (description.startsWith('"')) {
    try { description = JSON.parse(description); } catch { throw new Error('Skill description must be valid quoted text.'); }
  } else if (description.startsWith("'")) {
    if (!description.endsWith("'") || description.length < 2) throw new Error('Skill description must be valid quoted text.');
    description = description.slice(1, -1).replaceAll("''", "'");
  }
  if (typeof description !== 'string' || description.length > 2000) throw new Error('Skill description must be text under 2,000 characters.');
  return { body: header ? text.slice(header[0].length) : text, description };
}

function skillDescription(name, text) {
  const description = skillContent(text).description || SKILLS[name];
  const indexed = name === 'caveman' && !description.startsWith('OPT-IN') ? 'OPT-IN: ' + description : description;
  return indexed.length > 300 ? indexed.slice(0, 297).trimEnd() + '...' : indexed;
}

const DEFAULT_INSTRUCTIONS = `Harness defaults (user/project rules override; "normal mode" stops style rules; named stop commands disable that behavior for this chat):
- Replies: outcome first; number steps; short lists; no pleasantries, tangents or recaps. Explain fully on request. Keep material findings, uncertainty, security, accessibility and requested scope. No invented estimates or unmeasured savings. Style is a reading preference, not a medical assumption.
- Requests: build their mechanism, units and reference; remove what they say to remove, for good; add nothing unasked; offer extras in one line; a question gets an answer, not an edit. A message with no request (hi, thanks, ok) gets a short reply; resume unfinished work only when asked. Marked-up images: name each mark back and handle those spots first. If two readings fit, ask one short question first.
- Coding (Ponytail full): smallest complete fix at the shared choke point. Prefer omission, reuse, stdlib, existing dependencies, minimum diff; no unasked abstractions. Mark shortcuts "ponytail:" with ceiling/upgrade path. Never cut validation, security, data-loss protection or requested scope.
- Workflow: one agent unless delegation requested. Preserve unrelated work. No commit/push unless asked; no Co-Authored-By lines. Report actual checks and each log warning or error with its cause. Reuse evidence; targeted searches/ranges before full reads; batch independent lookups; stop testing once relevant checks pass. Complete authorized work.
- Output: ~2,000 tokens per routine tool result; above ~8,000 capture/search a file (large-responses). Truncated output is incomplete evidence.
- Shell: bundled rtk/rg lead PATH. Prefix programs with rtk (rtk proxy <cmd> for raw output); shell built-ins and PowerShell cmdlets (Get-Content, Select-String, cd) run without it. If missing, report/use native tools; never install system copies.
- Knowledge: the workspace's AGENTS.md and docs/wiki; verify live source; edit them only when asked or the project's rules say so, citing sources and dates; no diaries or competing stores. Never recreate the retired PhasmaHarness.md.
- Model selection/project_context are built in; no duplicate skills. Respect filesystem/tool permissions.
- Task status: last line of every final reply must be [task: done] if complete, [task: pending] if work remains, or [task: needs-input] if awaiting the user's answer/decision. Harness hides this line.
Harness skills: read when applicable via router_read_output {"skill":"<name>"} or file; reread changed paths. If native file access is blocked, use router_read_output.
Preserve source frontmatter and {{SKILL_DIR}} when editing; substitute the returned directory only when running commands.`;

function workerInstructions(directories = {}) {
  return DEFAULT_INSTRUCTIONS + '\n' + DEFAULT_SKILLS.map(name => `- ${name}: ${skillDescription(name, readSkill(name, directories))} (${path.join(directories[name] || skillDir(name), 'SKILL.md').replace(/\\/g, '/')})`).join('\n');
}
const WORKER_INSTRUCTIONS = workerInstructions();
module.exports = { WORKER_INSTRUCTIONS, DEFAULT_SKILLS, readSkill, skillDir, workerInstructions, skillContent, skillDescription };
