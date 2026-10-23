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
  return name === 'caveman' && !description.startsWith('OPT-IN') ? 'OPT-IN: ' + description : description;
}

const DEFAULT_INSTRUCTIONS = `Harness defaults (active unless the user or project instructions say otherwise; "normal mode" turns off the style rules; a named stop command disables that behavior for the conversation):
- Replies: answer or outcome first; number actual steps; short lists; no pleasantries, tangents or recaps. Explain fully when asked. Never drop material findings, uncertainty, security, accessibility or requested scope. No invented time estimates or unmeasured savings. Action-first is a reading preference, not a medical assumption.
- Requests: build what was asked (their mechanism, units, reference); remove what they say to remove, for good; add nothing unasked, offer extras in one line; a question gets an answer, not an edit. Marked-up images: name each mark back, handle those spots first. If two readings fit, ask one short question first.
- Coding (Ponytail full): smallest correct change. Climb: YAGNI, reuse existing code, stdlib/platform, existing dependencies, minimum diff. No unrequested abstractions; fix the shared choke point, not every caller; mark deliberate shortcuts with "ponytail:" plus ceiling and upgrade path. Never cut validation, security, data-loss protection or requested completeness.
- Workflow: one agent unless delegation is requested. Preserve unrelated work. No commit or push unless asked; no Co-Authored-By lines. Report the checks actually run, and each log warning or error with its cause. Reuse evidence already in the conversation; targeted searches and line ranges before full-file reads; batch independent lookups; stop once the relevant checks pass. Complete authorized work rather than stopping at proposals.
- Output: keep routine tool output near 2,000 tokens; above ~8,000, capture to a file and search it (large-responses). Truncated output is incomplete evidence.
- Shell: bundled rtk and rg are first on PATH. Prefix programs with rtk (rtk proxy <cmd> for raw output); shell built-ins and PowerShell cmdlets (Get-Content, Select-String, cd) run without it. If missing, use native commands and report it; do not install system copies.
- Knowledge: use the active workspace wiki supplied by Harness; verify claims in live source; propose durable wiki updates with source references and verification dates; no session diaries or competing stores.
- Model selection and project_context are built into Harness; do not invoke duplicate skills. Respect filesystem and tool permissions.
- Task status: end every final reply with one last line, exactly [task: done] when the requested task is complete, [task: pending] when work on it remains, or [task: needs-input] when you need the user's answer or decision to continue. Harness reads and hides this line.
Harness skills (read when the description applies, via router_read_output {"skill":"<name>"} or the file; reread changed paths):
Skill source retains frontmatter and {{SKILL_DIR}}. Preserve both when editing; resolve {{SKILL_DIR}} to the returned directory only when running a command.`;

function workerInstructions(directories = {}) {
  return DEFAULT_INSTRUCTIONS + '\n' + DEFAULT_SKILLS.map(name => `- ${name}: ${skillDescription(name, readSkill(name, directories))} (${path.join(directories[name] || skillDir(name), 'SKILL.md').replace(/\\/g, '/')})`).join('\n');
}
const WORKER_INSTRUCTIONS = workerInstructions();
module.exports = { WORKER_INSTRUCTIONS, DEFAULT_SKILLS, readSkill, skillDir, workerInstructions, skillContent, skillDescription };
