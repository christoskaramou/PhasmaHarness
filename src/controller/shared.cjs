'use strict';
// Constants and small helpers shared by the Controller files.
const CONTEXT_INSTRUCTIONS = ' For project investigation, use project_context to find focused starting evidence when useful. It is a partial search: read project instructions normally, verify important claims in live source, and search further for missing or conflicting evidence. Do not repeat identical searches unless files or the question changed.';

// ponytail: drop the oldest notification while the turn id is unknown; raise this if turn/start responses regularly arrive after more than 64 events
const SUBMISSION_EVENT_LIMIT = 64;

const ACCESS_MODES = [
  { id: 'read-only', label: 'Ask', approvalPolicy: 'on-request', description: 'Read files and run read-only commands. Ask before changes or broader access.' },
  { id: 'workspace-write', label: 'Workspace access', approvalPolicy: 'on-request', description: 'Edit files and run commands in the workspace. Ask before access outside it or network access.' },
  { id: 'danger-full-access', label: 'Full access', approvalPolicy: 'never', description: 'Unrestricted file and network access, without Codex command approval prompts.' },
];

const treeEntries = known => [...known].slice(-500).map(([pid, entry]) => ({ pid, startedMs: entry.startedMs, exact: entry.exact }));

// Claude effort is a per-model setting that can change between turns; it does not change which worker ran a task.
function sameEffort(worker, route) {
  return worker.provider === 'claude-cli' || (worker.effort || null) === (route.effort || null);
}

// Prefer the cheapest tier for routing calls: Haiku, then Sonnet, then the existing order.
function cheapRouter(choices) {
  return choices.find(p => /haiku/i.test(p.model)) || choices.find(p => /sonnet/i.test(p.model)) || choices[0];
}

const DEFAULT_ROUTER = 'codex:gpt-5.6-terra:low';

const PROVIDER_NAMES = { codex: 'ChatGPT (Codex)', 'claude-cli': 'Claude', 'cursor-cli': 'Cursor' };

const LEGACY_CLAUDE_ROUTERS = ['claude-cli:haiku', 'claude-cli:sonnet', 'claude-cli:opus'];

// What "Allow for this session" remembers: the tool and its exact target, never the tool as a whole.
// Claude: the tool name from its own field plus the fields that name the target of well-known tools (the
// command, file, pattern or URL); any other tool (MCP, Task, …) must repeat its whole input exactly.
// Cursor (ACP) sends no tool input, only a title that names the target (`command`, Edit `path`, URL) and,
// for MCP calls, the arguments in its content. Plans, and requests without a specific target, are never remembered.
const CLAUDE_TARGETS = {
  Bash: ['command', 'dangerouslyDisableSandbox'], Read: ['file_path'], Write: ['file_path'], Edit: ['file_path'], MultiEdit: ['file_path'],
  NotebookEdit: ['notebook_path'], Glob: ['pattern', 'path'], Grep: ['pattern', 'path', 'glob', 'type'],
  WebFetch: ['url'], WebSearch: ['query'],
};
const NEVER_REMEMBERED = new Set(['ExitPlanMode', 'AskUserQuestion']);
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value ?? null);
}
function sessionAllowKey(tool) {
  if (!tool || typeof tool !== 'object' || tool.kind === 'plan') return null;
  if ('toolName' in tool) {
    const name = tool.toolName;
    if (typeof name !== 'string' || !name || NEVER_REMEMBERED.has(name)) return null;
    const input = tool.input && typeof tool.input === 'object' && !Array.isArray(tool.input) ? tool.input : {};
    const fields = Object.hasOwn(CLAUDE_TARGETS, name) ? CLAUDE_TARGETS[name] : null;
    if (fields && (typeof input[fields[0]] !== 'string' || !input[fields[0]])) return null;
    const target = fields ? Object.fromEntries(fields.map(key => [key, input[key] ?? null])) : input;
    return canonical(['claude', name, target, typeof tool.blockedPath === 'string' ? tool.blockedPath : null]);
  }
  const title = typeof tool.title === 'string' ? tool.title.trim() : '';
  if (!title || title === 'Unknown operation' || typeof tool.kind !== 'string' || !tool.kind) return null;
  // "other" requests (MCP calls) are told apart only by their arguments; without them nothing is remembered.
  if (tool.kind === 'other' && !(Array.isArray(tool.content) && tool.content.length)) return null;
  return canonical(['cursor', tool.kind, title, tool.kind === 'other' ? tool.content : null]);
}

function accessMode(value) {
  const mode = ACCESS_MODES.find(mode => mode.id === value);
  if (!mode) throw new Error('Unknown access mode.');
  return mode;
}

function isMcpConfirmation(params) {
  const schema = params?.requestedSchema;
  // Empty-schema confirmations only. Forms with fields need a validated form renderer.
  return ['form', 'openai/form', 'openaiForm'].includes(params?.mode) &&
    schema?.type === 'object' && schema.properties !== null && typeof schema.properties === 'object' &&
    !Array.isArray(schema.properties) && Object.keys(schema.properties).length === 0 &&
    (schema.required === undefined || (Array.isArray(schema.required) && schema.required.length === 0)) &&
    Object.keys(schema).every(key => ['$schema', 'type', 'properties', 'required', 'title', 'description', 'additionalProperties'].includes(key)) &&
    (schema.additionalProperties === undefined || typeof schema.additionalProperties === 'boolean');
}

module.exports = { CONTEXT_INSTRUCTIONS, SUBMISSION_EVENT_LIMIT, ACCESS_MODES, treeEntries, sameEffort, cheapRouter, DEFAULT_ROUTER, PROVIDER_NAMES, LEGACY_CLAUDE_ROUTERS, sessionAllowKey, accessMode, isMcpConfirmation };
