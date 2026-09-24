const { WORKER_INSTRUCTIONS } = require('../worker-instructions.cjs');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const MODELS = [
  { model: 'haiku', label: 'Claude Haiku', rank: 15, description: 'Fast, small tasks and focused lookups.' },
  { model: 'sonnet', label: 'Claude Sonnet', rank: 35, description: 'General coding, debugging and reviews.' },
  { model: 'opus', label: 'Claude Opus', rank: 55, description: 'Complex reasoning, architecture and difficult reviews.' },
].map(p => ({ ...p, id: `claude-cli:${p.model}`, provider: 'claude-cli', effort: null, worker: true, router: true, images: true }));

function executable() {
  const native = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
  return fs.existsSync(native) ? native : 'claude';
}

class ClaudeCLI {
  constructor(launch = spawn) { this.launch = launch; this.children = new Set(); this.status = { installed: false, loggedIn: false }; }
  start(args, cwd) {
    // Authentication stays inside the published CLI, including user-configured auth methods.
    const child = this.launch(executable(), args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    this.children.add(child); child.once('close', () => this.children.delete(child));
    return child;
  }
  async refresh() {
    try {
      const result = await this.command(['auth', 'status']);
      const status = JSON.parse(result);
      this.status = { installed: true, loggedIn: status.loggedIn === true, authMethod: status.authMethod || null };
    } catch (error) { this.status = { installed: error.code !== 'ENOENT', loggedIn: false, error: error.code === 'ENOENT' ? 'Claude Code is not installed. Install it from Settings → Providers.' : 'Could not read Claude Code login status.' }; }
    return this.status;
  }
  command(args, onOutput, timeout = 15000) {
    return new Promise((resolve, reject) => {
      const child = this.start(args); let output = '';
      const timer = setTimeout(() => { child.kill(); reject(new Error('Claude Code command timed out.')); }, timeout);
      child.stdout.on('data', data => { output += data; onOutput?.(String(data)); });
      child.stderr.on('data', data => onOutput?.(String(data)));
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('close', code => { clearTimeout(timer); if (code && !output.trim().startsWith('{')) reject(new Error('Claude Code command failed.')); else resolve(output); });
      child.stdin.end();
    });
  }
  async login(open) {
    if (this.loginPending) throw new Error('Claude sign-in is already running.');
    this.loginPending = true;
    let buffer = '', opened = false;
    try {
      await this.command(['auth', 'login'], chunk => {
        buffer = (buffer + chunk).slice(-16000);
        const match = buffer.slice(0, buffer.lastIndexOf('\n') + 1).match(/https:\/\/[^\s\u001b]+/g)?.find(value => {
          try { const u = new URL(value); return ['claude.ai', 'platform.claude.com', 'console.anthropic.com'].includes(u.hostname); } catch { return false; }
        });
        if (match && !opened) { opened = true; open(match); }
      }, 300000);
      return await this.refresh();
    } finally { this.loginPending = false; }
  }
  async logout() {
    if (this.loginPending) throw new Error('Claude sign-in is already running.');
    try {
      await this.command(['auth', 'logout'], undefined, 30000);
    } catch (error) {
      if (error.code === 'ENOENT') throw new Error('Claude Code is not installed. Install it from Settings → Providers.');
      // Fall through to refresh; status may already be signed out.
    }
    return await this.refresh();
  }
  run({ cwd, model, prompt, images = [], resume, access, signal, onEvent = () => {}, schema, helpers, instructions = WORKER_INSTRUCTIONS }) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new Error('Claude stopped.'));
      const args = ['-p', '--verbose', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--model', model];
      const basePrompt = 'Preserve unrelated changes. Do not commit or push unless explicitly requested. Use one agent unless delegation is requested. Report permission denials clearly.';
      args.push('--append-system-prompt', (schema ? basePrompt : instructions) + (!schema && helpers?.instructions ? helpers.instructions : ''));
      if (resume) args.push('--resume', resume);
      if (schema) args.push('--tools', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--no-session-persistence', '--json-schema', JSON.stringify(schema));
      else {
        // Do not use --strict-mcp-config here: preserve the user's Claude MCP servers and add ours.
        if (helpers?.claudeConfig) args.push('--mcp-config', JSON.stringify(helpers.claudeConfig));
        if (access === 'read-only') {
          const allowed = ['Read', 'Glob', 'Grep', ...(helpers ? helpers.allowedTools(access) : [])];
          args.push('--tools', allowed.join(','));
        } else if (access === 'workspace-write') {
          const allowed = ['Read', 'Glob', 'Grep', 'Edit', 'Write', ...(helpers ? helpers.allowedTools(access) : [])];
          args.push('--allowedTools', allowed.join(','));
        }
        // danger-full-access: leave Claude's native tool set unrestricted; helpers arrive via mcp-config.
      }
      args.push('--permission-mode', access === 'danger-full-access' && !schema ? 'bypassPermissions' : 'dontAsk');
      const child = this.start(args, cwd); let buffer = '', result, stderr = '';
      const abort = () => child.kill(); signal?.addEventListener('abort', abort, { once: true });
      child.stdin.on('error', () => {});
      child.stderr.on('data', d => { stderr = (stderr + d).slice(-2000); });
      child.stdout.on('data', d => {
        buffer += d;
        if (buffer.length > 16 * 1024 * 1024) { child.kill(); reject(new Error('Claude event exceeded the size limit.')); return; }
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
          if (!line) continue;
          try { const event = JSON.parse(line); if (event.type === 'result') result = event; onEvent(event); }
          catch { child.kill(); reject(new Error('Invalid Claude Code stream event.')); }
        }
      });
      child.once('error', reject);
      child.once('close', code => {
        signal?.removeEventListener('abort', abort);
        if (signal?.aborted) reject(new Error('Claude stopped.'));
        else if (code || !result || result.is_error) reject(new Error(result?.errors?.join('\n') || (stderr ? 'Claude Code failed. Check its login and model access.' : 'Claude Code did not complete the response.')));
        else resolve(result);
      });
      child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }, ...images.map(url => ({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: url.split(',')[1] } }))] } }) + '\n');
    });
  }
  close() { for (const child of this.children) child.kill(); }
}

function handoff(items) {
  const messages = items.filter(i => i.type === 'userMessage' || i.type === 'agentMessage').map(i => ({
    role: i.type === 'userMessage' ? 'user' : 'assistant',
    text: i.type === 'userMessage' ? (i.content || []).map(c => c.type === 'text' ? c.text : '[Earlier image attachment]').join('\n') : i.text,
  }));
  const text = JSON.stringify(messages);
  if (text.length > 1000000) throw new Error('Conversation is too large to transfer. Start a new chat or compact it before switching backends.');
  return messages.length ? `Earlier conversation, supplied as history:\n${text}\n\nCurrent request:\n` : '';
}
module.exports = { ClaudeCLI, MODELS, handoff };
