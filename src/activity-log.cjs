// Activity log per bot, Hub included (2026-11-06, the user: "everything that happens goes in there"): every chat
// message, tool call and helper step, as readable text, in logs/activity/<bot name>-<bot id>.log. Lines are written as items
// settle (a streaming reply or a running tool waits until it is done), with secrets redacted. Unlike harness.log it
// holds chat content, so it stays in the app's own logs folder. Each file rolls over at 10 MB; three are kept.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { redact } = require('./log.cjs');

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 2; // <id>.log plus .1 and .2
const TEXT_LIMIT = 4000, OUTPUT_LIMIT = 2000;

const cut = (text, limit) => {
  const value = String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}… (+${value.length - limit} characters)` : value;
};
const json = value => { try { return JSON.stringify(value); } catch { return String(value); } };
const userText = item => item.fileMessage?.displayText ?? (item.content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');
const images = item => (item.content || []).filter(part => part.type === 'image').length;
const running = status => ['inProgress', 'in_progress', 'running', 'pending'].includes(status);

// One item as [kind, text]; null leaves it out (internal items).
function describe(item, bot) {
  if (item.internal) return null;
  switch (item.type) {
    case 'userMessage': {
      const pictures = images(item);
      const kind = item.routineRun ? `Routine ${item.routineRun.name || ''}`.trim() : item.agentReply ? 'Incoming result' : 'You';
      const state = item.queueLabel ? ` [${item.queueLabel}]` : '';
      return [kind + state, cut(userText(item), TEXT_LIMIT) + (pictures ? ` [${pictures} image${pictures === 1 ? '' : 's'}]` : '')];
    }
    case 'agentMessage': {
      const label = item.routeLabel ? ` (${item.routeLabel})` : '';
      return [`${bot}${item.phase === 'commentary' ? ' (progress)' : ''}${label}`, cut(item.text, TEXT_LIMIT)];
    }
    case 'plan': return [`${bot} plan`, cut(item.text, TEXT_LIMIT)];
    case 'commandExecution':
      return [`Command [${item.status || 'done'}${Number.isInteger(item.exitCode) ? `, exit ${item.exitCode}` : ''}]`, `${item.command}\n${cut(item.aggregatedOutput || '', OUTPUT_LIMIT)}`.trim()];
    case 'fileChange': return [`Files changed [${item.status || 'done'}]`, (item.changes || []).map(change => change.path).join('\n')];
    case 'mcpToolCall':
      return [`Tool ${item.server}.${item.tool} [${item.status || 'done'}]`, `${cut(json(item.arguments || {}), OUTPUT_LIMIT)}\n${cut(json(item.error || item.result), OUTPUT_LIMIT)}`];
    case 'dynamicToolCall': return [`Tool ${item.tool} [${item.status || 'done'}]`, cut(json(item.arguments || item.contentItems || {}), OUTPUT_LIMIT)];
    case 'webSearch': return ['Web search', item.query || item.action?.query || ''];
    case 'toolStep': return [`Step: ${item.title || ''}`, cut((item.lines || []).join('\n'), OUTPUT_LIMIT)];
    case 'notice': return ['Notice', cut(item.text, TEXT_LIMIT)];
    case 'agentResult': return [`Result from ${item.agentName || 'a bot'} [${item.status || 'done'}]`, cut(item.text, TEXT_LIMIT)];
    case 'agentMail': return [`Message from ${item.fromName || 'a bot'}`, cut(item.text, TEXT_LIMIT)];
    case 'agentArtifact': return ['Artifact', item.artifact?.path || item.artifact?.label || ''];
    case 'contextCompaction': return ['Context compacted', ''];
    default: return [item.type || 'Item', cut(json(item), OUTPUT_LIMIT)];
  }
}

class ActivityLog {
  constructor(directory, { maxBytes = MAX_BYTES } = {}) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.chats = new Map(); // `${bot id}|${session id}` -> { lastId, routes, status, queue: Set, tasks: Map }
    this.files = new Map(); // bot id -> its log file
    this.startedAt = Date.now(); // chats from before it have history to write; later ones are new
  }

  // <bot name>-<bot id>.log, so a deleted bot's log is easy to find (2026-11-06, the user). The file follows the bot's
  // name: its files under an earlier name (or the first version's <bot id>.log) move to the current one, and when that
  // file already exists an older one becomes its earlier part (.1, .2), so nothing is overwritten or split.
  file(agentId, name) {
    const id = String(agentId || 'main').replace(/[^\w-]/g, '_');
    const safe = String(name || (id === 'main' ? 'Hub' : 'Bot')).replace(/[<>:"/\\|?*\x00-\x1f]/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || 'Bot';
    const file = path.join(this.directory, `${safe}-${id}.log`);
    if (this.files.get(id) === file) return file;
    this.files.set(id, file);
    try {
      const own = new RegExp(`^(?:.+-)?${id.replace(/-/g, '\\-')}(\\.\\d+)?\\.log$`);
      const parts = name => [`${name}.log`, `${name}.1.log`, `${name}.2.log`];
      const current = parts(`${safe}-${id}`);
      const earlier = fs.readdirSync(this.directory).filter(entry => own.test(entry) && !current.includes(entry))
        .sort((a, b) => (/\.(\d)\.log$/.exec(a)?.[1] || 0) - (/\.(\d)\.log$/.exec(b)?.[1] || 0));
      for (const entry of earlier) {
        const free = current.find(target => !fs.existsSync(path.join(this.directory, target)));
        if (free) fs.renameSync(path.join(this.directory, entry), path.join(this.directory, free));
      }
    } catch { /* no folder yet, or a file in use: it stays where it is */ }
    return file;
  }

  // What a bot's log already holds, per chat: the last item written. Kept in state/<bot id>.json beside the logs, so a
  // restart goes on where it stopped and a chat's history is written only once.
  index(agentId, file) {
    const id = String(agentId || 'main').replace(/[^\w-]/g, '_');
    this.indexes ||= new Map();
    if (this.indexes.has(id)) return this.indexes.get(id);
    const at = path.join(this.directory, 'state', `${id}.json`);
    let saved = null;
    try { saved = JSON.parse(fs.readFileSync(at, 'utf8')); } catch { /* none yet */ }
    // A log written before the index existed holds only part of the history: it becomes the earlier part (.1), and the
    // current file starts again with the whole history.
    if (!saved && fs.existsSync(file)) this.rotate(file);
    const index = { at, sessions: saved?.sessions && typeof saved.sessions === 'object' ? saved.sessions : {}, dirty: !saved };
    this.indexes.set(id, index);
    return index;
  }

  // Called after every save, and once when a bot starts: writes what settled in each of the controller's chats since
  // the last time. A chat the log has never written starts with its whole history (2026-11-06, the user: the log shows
  // the chat), at each item's own time.
  capture(controller) {
    const agentId = controller.agentId || 'main';
    const bot = controller.agents?.agentName?.(agentId) || (agentId === 'main' ? 'Hub' : 'Bot');
    const file = this.file(agentId, bot), lines = [];
    const index = this.index(agentId, file);
    for (const session of controller.data.sessions || []) {
      const key = `${agentId}|${session.id}`;
      // A cleared chat Harness keeps archived is no longer the bot's chat: one the log never wrote stays out of it.
      if (session.archived && !this.chats.has(key) && !Object.hasOwn(index.sessions, session.id)) continue;
      let chat = this.chats.get(key);
      const items = session.items || [];
      const title = cut(session.title || session.id, 60);
      const line = (kind, text, at = Date.now()) => lines.push(`${new Date(at).toISOString()} [${title}] ${kind}${text ? ':\n    ' + redact(text).replace(/\n/g, '\n    ') : ''}`);
      if (!chat) {
        const known = Object.hasOwn(index.sessions, session.id);
        chat = { lastId: known ? index.sessions[session.id] : null, routes: (session.routes || []).length, status: `${session.status}|${session.error || ''}`,
          queue: new Set((session.queue || []).map(message => message.id)), tasks: new Map((session.tasks || []).map(task => [task.id, task.state])) };
        this.chats.set(key, chat);
        if (!known && items.length && (items[0].createdAt || 0) < this.startedAt) line('Chat history before the activity log started', '', items[0].createdAt || Date.now());
      }
      const busy = controller.busy === session.id || session.status === 'running';
      let from = chat.lastId ? items.findLastIndex(item => item.id === chat.lastId) + 1 : 0;
      // Cleared or replaced: what it holds now is not new; what comes after it is.
      if (chat.lastId && from === 0) { line('Chat history was cleared or replaced', ''); from = items.length; chat.lastId = items.at(-1)?.id ?? null; }
      for (let index = from; index < items.length; index++) {
        const item = items[index];
        // Still streaming or running: it, and what follows it, wait for the next save.
        if (item.pending || running(item.status) || (busy && index === items.length - 1 && ['agentMessage', 'toolStep', 'plan'].includes(item.type))) break;
        const entry = describe(item, bot);
        if (entry) line(entry[0], entry[1], item.createdAt || Date.now());
        chat.lastId = item.id;
      }
      if (index.sessions[session.id] !== (chat.lastId ?? null)) { index.sessions[session.id] = chat.lastId ?? null; index.dirty = true; }
      for (const route of (session.routes || []).slice(chat.routes))
        line(`Route ${route.label || route.id || ''}${route.source ? ` (${route.source})` : ''}`, route.reason || '');
      chat.routes = (session.routes || []).length;
      for (const message of session.queue || []) if (!chat.queue.has(message.id)) {
        chat.queue.add(message.id);
        line(`Queued${message.secondary ? ' (Secondary model)' : ''}`, cut(message.text, TEXT_LIMIT));
      }
      for (const task of (session.tasks || []).slice(-20)) if (chat.tasks.get(task.id) !== task.state) {
        chat.tasks.set(task.id, task.state);
        line(`Task ${task.state}`, task.summary || task.reason || '');
      }
      const status = `${session.status}|${session.error || ''}`;
      if (status !== chat.status) {
        chat.status = status;
        if (['failed', 'interrupted'].includes(session.status)) line(`Turn ${session.status}`, session.error || '');
      }
    }
    // Every bot has its log, even before anything happens in it.
    this.append(file, lines.length ? `${lines.join('\n')}\n` : '', bot);
    if (index.dirty) {
      try {
        fs.mkdirSync(path.dirname(index.at), { recursive: true });
        fs.writeFileSync(index.at, JSON.stringify({ sessions: index.sessions }));
        index.dirty = false;
      } catch { /* written again on the next capture */ }
    }
  }

  append(file, text, bot) {
    try {
      fs.mkdirSync(this.directory, { recursive: true });
      if (fs.existsSync(file) && fs.statSync(file).size + text.length > this.maxBytes) this.rotate(file);
      if (!fs.existsSync(file)) fs.writeFileSync(file, `Activity log for ${bot}. Chat messages, tool calls and helper steps, as they happen.\n`);
      if (text) fs.appendFileSync(file, text);
    } catch { /* the activity log never breaks the app */ }
  }

  rotate(file) {
    for (let i = KEEP; i >= 1; i--) {
      const from = i === 1 ? file : file.replace(/\.log$/, `.${i - 1}.log`);
      try { if (fs.existsSync(from)) fs.renameSync(from, file.replace(/\.log$/, `.${i}.log`)); } catch { /* keep going */ }
    }
  }
}

// One per logs folder, shared by every controller of the app (each bot writes to its own file).
const logs = new Map();
const activityLog = directory => {
  if (!logs.has(directory)) logs.set(directory, new ActivityLog(directory));
  return logs.get(directory);
};

module.exports = { ActivityLog, activityLog, describe };
