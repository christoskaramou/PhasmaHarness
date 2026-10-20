// Harness's own agent loop for API providers (LM Studio, DeepSeek API, any OpenAI-compatible endpoint), so they never
// need Codex. It streams chat completions, runs the model's tool calls and reports Claude-style events to sendCLI.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { spawnOwned, stopTree } = require('../process-tree.cjs');

const RG = path.join(__dirname, '..', '..', 'tools', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg');
const MAX_STEPS = 100;
const OUTPUT_LIMIT = 30000;
const READS = new Set(['read_file', 'list_files', 'search']);
const SHELL = process.platform === 'win32' ? 'PowerShell' : 'bash';

const TOOLS = [
  { name: 'read_file', description: 'Read a text file. Returns numbered lines; use offset and limit for large files.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'integer', minimum: 1 }, limit: { type: 'integer', minimum: 1 } }, required: ['path'] } },
  { name: 'list_files', description: 'List files under a folder (respects .gitignore). Optional glob, for example "*.cjs".',
    parameters: { type: 'object', properties: { path: { type: 'string' }, glob: { type: 'string' } } } },
  { name: 'search', description: 'Search file contents with a regular expression (ripgrep). Returns path:line:text.',
    parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, glob: { type: 'string' } }, required: ['pattern'] } },
  { name: 'write_file', description: 'Create or replace a whole file.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
  { name: 'edit_file', description: 'Replace one exact, unique occurrence of old_text with new_text in a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' }, old_text: { type: 'string' }, new_text: { type: 'string' } }, required: ['path', 'old_text', 'new_text'] } },
  { name: 'run_command', description: `Run a ${SHELL} command in the workspace and return its output.`,
    parameters: { type: 'object', properties: { command: { type: 'string' }, timeout_seconds: { type: 'integer', minimum: 1, maximum: 1800 } }, required: ['command'] } },
];

// The Claude/Cursor rules: reads inside the workspace run; edits run with Workspace access; commands and anything
// outside the workspace ask, unless the session has Full access.
function needsApproval(name, inside, access) {
  if (access === 'danger-full-access') return false;
  if (READS.has(name)) return !inside;
  if (name === 'write_file' || name === 'edit_file') return !(inside && access === 'workspace-write');
  return true;
}

// Real paths, so a link inside the workspace cannot reach outside it.
function inside(root, full) {
  let probe = full;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  const real = path.join(fs.realpathSync.native(probe), path.relative(probe, full));
  const relative = path.relative(fs.realpathSync.native(root), real);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function bounded(text) {
  return text.length > OUTPUT_LIMIT ? text.slice(0, OUTPUT_LIMIT) + `\n[truncated ${text.length - OUTPUT_LIMIT} characters]` : text;
}

async function runProcess(file, args, cwd, signal, timeoutMs = 120000) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnOwned(spawn, file, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  const collect = data => { if (output.length < OUTPUT_LIMIT * 2) output += data; };
  child.stdout.on('data', collect); child.stderr.on('data', collect);
  const stop = () => stopTree(child);
  const timer = setTimeout(stop, timeoutMs);
  signal?.addEventListener('abort', stop, { once: true });
  try {
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    if (signal?.aborted) throw new Error('Stopped.');
    return { code, output: bounded(output) };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', stop);
    await stopTree(child);
  }
}

async function execute(name, args, cwd, full, signal) {
  if (name === 'read_file') {
    const lines = (await fs.promises.readFile(full, 'utf8')).split(/\r?\n/);
    const start = Math.max(1, args.offset || 1), end = Math.min(lines.length, start - 1 + (args.limit || 2000));
    return bounded(lines.slice(start - 1, end).map((line, index) => `${start + index}\t${line}`).join('\n') +
      (end < lines.length ? `\n[${lines.length - end} more lines; use offset ${end + 1}]` : ''));
  }
  if (name === 'list_files' || name === 'search') {
    // A relative target keeps ripgrep's output paths relative to the workspace.
    const target = path.relative(cwd, full) || '.', glob = args.glob ? ['-g', String(args.glob)] : [];
    const rg = name === 'list_files' ? ['--files', ...glob, target] : ['-n', '--no-heading', ...glob, '-e', String(args.pattern), target];
    const { code, output } = await runProcess(RG, rg, cwd, signal);
    if (code > 1) throw new Error(output || 'Search failed.');
    return output.trim() || 'No matches.';
  }
  if (name === 'write_file') {
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, String(args.content));
    return `Wrote ${path.relative(cwd, full) || full}.`;
  }
  if (name === 'edit_file') {
    const text = await fs.promises.readFile(full, 'utf8'), old = String(args.old_text);
    const count = old ? text.split(old).length - 1 : 0;
    if (count !== 1) throw new Error(count ? `old_text occurs ${count} times; include more context.` : 'old_text was not found.');
    await fs.promises.writeFile(full, text.replace(old, () => String(args.new_text)));
    return `Edited ${path.relative(cwd, full) || full}.`;
  }
  const shell = process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', String(args.command)]] : ['/bin/bash', ['-lc', String(args.command)]];
  const { code, output } = await runProcess(shell[0], shell[1], cwd, signal, (args.timeout_seconds || 600) * 1000);
  return `Exit code ${code}\n${output}`;
}

async function* events(body) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let index; (index = buffer.indexOf('\n')) >= 0;) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return;
      try { yield JSON.parse(data); } catch { /* keep-alive or a partial vendor line */ }
    }
  }
}

class ApiAgent {
  constructor(providers, directory) {
    this.providers = providers; this.directory = directory;
  }

  load(id) {
    try { return JSON.parse(fs.readFileSync(path.join(this.directory, `${id}.json`), 'utf8')).messages; } catch { return null; }
  }

  save(id, messages) {
    fs.mkdirSync(this.directory, { recursive: true });
    // DeepSeek's reasoning is passed back only within the turn that produced it.
    const kept = messages.map(({ reasoning_content, ...message }) => message);
    fs.writeFileSync(path.join(this.directory, `${id}.json`), JSON.stringify({ version: 1, messages: kept }));
  }

  async complete(choice, body, signal, onText) {
    const local = await this.providers.local.inspect(choice, signal);
    const response = await this.providers.modelRequest(choice, body, local, signal, 'chat/completions');
    if (!response.ok) throw new Error((await response.json().catch(() => null))?.error?.message || `Provider request failed (HTTP ${response.status}).`);
    const message = { role: 'assistant', content: '' }, calls = [];
    let usage = null, reasoning = '';
    for await (const chunk of events(response.body)) {
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (delta.content) { message.content += delta.content; onText(delta.content); }
      if (delta.reasoning_content) reasoning += delta.reasoning_content;
      for (const call of delta.tool_calls || []) {
        const slot = calls[call.index ?? calls.length] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (call.id) slot.id = call.id;
        if (call.function?.name) slot.function.name += call.function.name;
        if (call.function?.arguments) slot.function.arguments += call.function.arguments;
      }
    }
    const toolCalls = calls.filter(Boolean).map(call => ({ ...call, id: call.id || `call_${randomUUID()}` }));
    if (toolCalls.length) message.tool_calls = toolCalls;
    if (reasoning) message.reasoning_content = reasoning;
    return { message, usage };
  }

  async tool(call, { cwd, access, approve, bridge, signal }) {
    const name = call.function.name;
    let args;
    try { args = JSON.parse(call.function.arguments || '{}'); } catch { return { error: true, text: 'Tool arguments were not valid JSON.' }; }
    if (bridge?.tools.some(tool => tool.name === name)) {
      try {
        const result = await bridge.call(name, args, signal);
        return { error: false, text: bounded(typeof result === 'string' ? result : JSON.stringify(result)) };
      } catch (error) { return { error: true, text: error.message }; }
    }
    if (!TOOLS.some(tool => tool.name === name)) return { error: true, text: `Unknown tool: ${name}.` };
    const full = name === 'run_command' ? cwd : path.resolve(cwd, String(args.path || '.'));
    if (needsApproval(name, name === 'run_command' || inside(cwd, full), access)) {
      const what = name === 'run_command' ? String(args.command) : full;
      const allowed = await approve({ title: `Allow ${name.replace('_', ' ')}: ${what.slice(0, 200)}?`, toolName: name,
        input: name === 'run_command' ? { command: what } : { path: full }, rawInput: args }, { signal });
      if (!allowed) return { error: true, text: 'The user declined this action under the current access setting.' };
    }
    try { return { error: false, text: await execute(name, args, cwd, full, signal) }; }
    catch (error) { return { error: true, text: error.message }; }
  }

  async run(options) {
    const { provider, model, effort, cwd, prompt, images = [], instructions, resume, access, signal, approve, onEvent, bridge, onInput } = options;
    const previous = resume ? this.load(resume) : null;
    const id = previous ? resume : randomUUID();
    const messages = previous || [{ role: 'system', content: `${instructions || ''}\n\nYou work in ${cwd} on ${process.platform}. ` +
      'Use the tools to inspect and change files and to run commands; relative paths start at the workspace. Report what you changed and verified.' }];
    const userContent = (text, urls) => urls.length ? [{ type: 'text', text }, ...urls.map(url => ({ type: 'image_url', image_url: { url } }))] : text;
    messages.push({ role: 'user', content: userContent(prompt, images) });
    const tools = [...TOOLS, ...(bridge?.tools || []).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.inputSchema }))]
      .map(tool => ({ type: 'function', function: tool }));
    const total = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 };
    let reported = false, answer = '';
    // Harness owns this loop, so a follow-up joins the conversation before the next model call. It counts as
    // delivered only once that call succeeds; one still waiting when the turn ends goes back to the Harness queue.
    const pending = [], sent = [];
    let accepting = true;
    onInput?.(message => {
      if (!accepting || signal.aborted)
        return Promise.reject(new Error('This turn is no longer accepting messages.'));
      return new Promise((resolve, reject) => pending.push({ message, resolve, reject }));
    });
    const deliver = () => {
      for (const item of pending.splice(0)) {
        messages.push({ role: 'user', content: userContent(item.message.text, item.message.images || []) });
        sent.push(item);
      }
    };

    try {
      onEvent({ type: 'system', session_id: id });
      for (let step = 0; ; step++) {
        if (step === MAX_STEPS) throw new Error(`The model was still calling tools after ${MAX_STEPS} steps, so the turn was stopped.`);
        signal.throwIfAborted();
        deliver();
        const answered = await this.step({ provider, model, effort, cwd, access, approve, bridge, signal, onEvent, messages, tools, total });
        for (const item of sent.splice(0))
          item.resolve();
        if (answered.reported)
          reported = true;

        if (answered.final && !pending.length) {
          answer = answered.final.content;
          break;
        }
      }
    } finally {
      accepting = false;
      onInput?.(null);
      for (const item of pending.splice(0)) item.reject(new Error('The turn ended before this message reached the model.'));
      // The call carrying these failed: the provider may or may not have read them, so they stay queued as uncertain.
      for (const item of sent.splice(0))
        item.reject(new Error('The model call with this message failed and its connection closed. Check the conversation before resending.'));
    }

    this.save(id, messages);
    return { result: answer, session_id: id, ...(reported ? { usage: total } : {}) };
  }

  // One model call and the tools it asked for. Returns the final message when the model asked for no tools.
  async step({ provider, model, effort, cwd, access, approve, bridge, signal, onEvent, messages, tools, total }) {
    const messageId = randomUUID();
    onEvent({ type: 'stream_event', event: { type: 'message_start', message: { id: messageId } } });
    const body = { model, messages, tools, stream: true, stream_options: { include_usage: true }, ...(effort ? { reasoning_effort: effort } : {}) };
    const { message, usage } = await this.complete({ provider, model }, body, signal,
      text => onEvent({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } }));
    const cached = usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens ?? 0;
    const stepUsage = usage ? { input_tokens: (usage.prompt_tokens || 0) - cached, output_tokens: usage.completion_tokens || 0, cache_read_input_tokens: cached } : null;
    if (stepUsage) {
      for (const key of Object.keys(total)) total[key] += stepUsage[key];
    }

    const calls = message.tool_calls || [];
    onEvent({ type: 'assistant', message: { id: messageId, ...(stepUsage ? { usage: stepUsage } : {}), content: [
      ...(message.content ? [{ type: 'text', text: message.content }] : []),
      ...calls.map(call => ({ type: 'tool_use', id: call.id, name: call.function.name, input: (() => { try { return JSON.parse(call.function.arguments || '{}'); } catch { return call.function.arguments; } })() })),
    ] } });
    messages.push(message);
    for (const call of calls) {
      const output = await this.tool(call, { cwd, access, approve, bridge, signal });
      onEvent({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: call.id, is_error: output.error, content: output.text }] } });
      messages.push({ role: 'tool', tool_call_id: call.id, content: output.text });
    }

    return { reported: !!stepUsage, final: calls.length ? null : message };
  }
}

module.exports = { ApiAgent, TOOLS, needsApproval };
