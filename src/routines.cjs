'use strict';
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const { ACCESS_MODES } = require('./controller/shared.cjs');
const calendar = require('./routine-time.cjs');
const execute = promisify(execFile);
const rank = access => ACCESS_MODES.findIndex(mode => mode.id === access);
const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const ARGS = ['action', 'id', 'name', 'text', 'trigger', 'date', 'time', 'timeZone', 'days'];

// A routine is text that Harness sends back to the agent, in the chat where it was saved, on a schedule, once at a date and
// time (then it removes itself) or on each new local Git commit. Routines change only when the user asks in that chat; they are never shown as settings.
class Routines {
  constructor(agents, { now = Date.now, readHead = null } = {}) {
    this.agents = agents; this.now = now; this.records = agents.primary.data.routines ||= {};
    if (!this.records || typeof this.records !== 'object' || Array.isArray(this.records)) throw new Error('Saved routines need review.');
    this.abort = new AbortController(); this.operation = null; this.timer = null; this.started = false; this.closed = false;
    this.pendingSaves = 0; this.gitNext = 0;
    this.gitReads = new Set();
    this.readHead = readHead || (async workspace => {
      const { stdout } = await execute('git', ['-C', workspace, 'rev-parse', '--verify', 'HEAD'], {
        windowsHide: true, timeout: 5000, maxBuffer: 65536, signal: this.abort.signal,
      });
      const head = stdout.trim();
      if (!/^[a-f0-9]{40,64}$/.test(head)) throw new Error('Git HEAD is unavailable.');
      return head;
    });
    for (const [id, routine] of Object.entries(this.records)) {
      if (!routine || routine.schemaVersion !== 2 || routine.id !== id || typeof routine.text !== 'string' ||
          typeof routine.agentId !== 'string' || typeof routine.ownerId !== 'string' || !routine.schedule) {
        throw new Error('A saved routine has an unsupported format. Its store was retained for review.');
      }
    }
  }

  get busy() { return !!this.operation || this.pendingSaves > 0; }

  async head(workspace) {
    const operation = Promise.resolve().then(() => this.readHead(workspace));
    this.gitReads.add(operation);
    try { return await operation; }
    finally { this.gitReads.delete(operation); }
  }

  hub(controller) {
    return controller === this.agents.primary;
  }

  // Only a message the user typed in an agent's own chat may change routines: `send` marks that turn, and assignments,
  // automatic results and mail, routine runs, wiki proposals and Harness's own correction turns are not marked.
  userTurn(controller, session) {
    return !controller.executionContext && !session.delegation && session.userTurn === true;
  }

  visible(controller, routine) {
    return this.hub(controller) || routine.agentId === controller.agentId;
  }

  chat(routine) {
    const target = routine.agentId === 'main' ? this.agents.primary : this.agents.controllers.get(routine.agentId);
    const session = target?.data.sessions.find(item => item.id === routine.ownerId && !item.archived);
    return { target, session };
  }

  schedule(args, previous) {
    const type = args.trigger || previous?.type || 'calendar';
    if (!['calendar', 'once', 'git'].includes(type)) throw new Error('Choose a calendar, once or git trigger.');
    if (type === 'git') return { type };
    const zone = args.timeZone || previous?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (type === 'once') {
      const { schedule } = calendar.once({ date: args.date || previous?.date, time: args.time || previous?.time || '09:00', timeZone: zone });
      return { type, ...schedule };
    }

    const days = args.days === undefined ? previous?.days || [0, 1, 2, 3, 4, 5, 6]
      : String(args.days).split(',').map(day => /^\s*\d\s*$/.test(day) ? Number(day) : NaN);
    return { type, ...calendar.calendar({ time: args.time || previous?.time || '09:00', timeZone: zone, days }) };
  }

  async save(controller, session, args) {
    if (this.closed || this.agents.closing) throw new Error('The runner is stopping.');
    const previous = args.id ? this.records[args.id] : null;
    if (args.id && (!previous || !this.visible(controller, previous))) throw new Error('Choose one of your routines. Use routines_report for ids.');
    if (!previous && Object.keys(this.records).length >= 20) throw new Error('Remove an unused routine before creating another (20 routines).');

    const text = args.text ?? previous?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > 16000) throw new Error('Give the routine the request to send, under 16,000 characters.');
    const name = (args.name ?? previous?.name ?? '').trim() || text.trim().replace(/\s+/g, ' ').slice(0, 60).trim();
    if (name.length > 80) throw new Error('Name the routine under 80 characters.');
    const schedule = this.schedule(args, previous?.schedule);
    const now = this.now();
    const next = schedule.type === 'calendar' ? calendar.next(now, schedule, previous?.lastKey)
      : schedule.type === 'once' ? calendar.once(schedule).next : null;
    if (schedule.type === 'once' && next.at <= now) throw new Error('Choose a future date and time for a one-time routine.');

    const owner = previous ? this.chat(previous) : { target: controller, session };
    if (!owner.session) throw new Error('This routine’s chat is no longer available. Remove it and save a new one.');
    // Saving approves the routine at the lower of the routine chat's and the asking chat's access.
    const access = ACCESS_MODES[Math.min(rank(owner.session.access), rank(session.access))]?.id;
    if (!access) throw new Error('This chat’s access needs review before saving a routine.');

    this.pendingSaves++;
    try {
      const workspace = owner.session.workspace;
      const head = schedule.type === 'git' ? await this.head(workspace) : null;
      if (this.closed || this.agents.closing || (previous && this.records[previous.id] !== previous)) throw new Error('The runner or routine changed before it could be saved.');
      const routine = { ...previous, schemaVersion: 2, id: previous?.id || randomUUID(), version: (previous?.version || 0) + 1,
        agentId: previous?.agentId || (this.hub(controller) ? 'main' : controller.agentId), ownerId: owner.session.id,
        createdBy: previous?.createdBy || (this.hub(controller) ? 'main' : controller.agentId),
        name, text, schedule, access, workspace, head, enabled: true, error: null,
        next, createdAt: previous?.createdAt || now, updatedAt: this.now() };
      delete routine.rebaseHead;
      this.records[routine.id] = routine;
      try {
        this.agents.primary.save();
      } catch (error) {
        if (previous) this.records[routine.id] = previous;
        else delete this.records[routine.id];
        throw error;
      }

      this.agents.primary.changed(); this.arm();
      return { routine: this.entry(routine), summary: `Saved routine ${this.line(routine)}` };
    } finally { this.pendingSaves--; }
  }

  async change(controller, session, { id, action }) {
    const routine = this.records[id];
    if (!routine || !this.visible(controller, routine)) throw new Error('Choose one of your routines. Use routines_report for ids.');
    if (action === 'resume') return this.save(controller, session, { id });

    const previous = { ...routine };
    if (action === 'delete') delete this.records[id];
    else Object.assign(routine, { enabled: false, version: routine.version + 1, updatedAt: this.now() });
    try {
      this.agents.primary.save();
    } catch (error) {
      if (action === 'delete') this.records[id] = previous;
      else Object.assign(routine, previous);
      throw error;
    }

    this.agents.primary.changed(); this.arm();
    return { summary: `${action === 'delete' ? 'Removed' : 'Paused'} routine ${routine.name}.` };
  }

  fromChat(controller, session, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !ARGS.includes(key))) throw new Error('Invalid routine arguments.');
    if (!this.userTurn(controller, session)) throw new Error('Routines change only when the user asks in this chat. Messages, results, assignments and routine runs cannot change them.');
    if (args.action === 'save') return this.save(controller, session, args);
    if (!['pause', 'resume', 'delete'].includes(args.action) || typeof args.id !== 'string') throw new Error('Choose save, or pause, resume or delete with a routine id.');
    return this.change(controller, session, args);
  }

  describe(routine) {
    if (routine.schedule.type === 'git') return `on each new commit in ${routine.workspace}`;
    if (routine.schedule.type === 'once') return `once on ${routine.schedule.date} at ${routine.schedule.time} (${routine.schedule.timeZone})`;
    const days = routine.schedule.days.length === 7 ? 'daily'
      : routine.schedule.days.join(',') === '1,2,3,4,5' ? 'Mon–Fri' : routine.schedule.days.map(day => DAY_NAMES[day]).join(', ');
    return `${days} at ${routine.schedule.time} (${routine.schedule.timeZone})`;
  }

  line(routine) {
    const next = routine.next ? ' · next ' + new Intl.DateTimeFormat('en-GB', { timeZone: routine.schedule.timeZone,
      dateStyle: 'medium', timeStyle: 'short' }).format(routine.next.at) : '';
    return `${routine.name} for ${this.agents.agentName(routine.agentId)}: ${this.describe(routine)}${next}.`;
  }

  entry(routine) {
    return { id: routine.id, name: routine.name, agentId: routine.agentId, agent: this.agents.agentName(routine.agentId),
      createdBy: this.agents.agentName(routine.createdBy), text: routine.text.slice(0, 600), trigger: this.describe(routine),
      nextRun: routine.next ? new Date(routine.next.at).toISOString() : null,
      state: routine.error ? 'needs review: ' + routine.error : routine.enabled ? (routine.run ? 'running' : 'active') : 'paused',
      lastRun: routine.last ? { at: new Date(routine.last.at).toISOString(), ...(routine.last.error ? { error: routine.last.error } : {}) } : null };
  }

  report(controller) {
    return Object.values(this.records).filter(routine => this.visible(controller, routine)).map(routine => this.entry(routine));
  }

  hold(routine, message) {
    routine.enabled = false; routine.error = message;
    routine.version++; routine.updatedAt = this.now();
  }

  start() { if (!this.closed) { this.started = true; this.arm(0); } }
  arm(delay = null) {
    clearTimeout(this.timer);
    if (!this.started || this.closed) return;
    const routines = Object.values(this.records);
    if (!routines.some(routine => routine.enabled || routine.run)) return;
    const active = routines.some(routine => routine.run);
    const times = routines.filter(routine => routine.enabled && routine.next).map(routine => routine.next.at - this.now());
    const wait = delay ?? Math.max(1000, Math.min(active ? 5000 : 30000, ...times));
    this.timer = setTimeout(() => this.tick().catch(error => this.agents.primary.log.warn('Routine scheduler held', { error: error.message })), wait);
    this.timer.unref?.();
  }

  // A run lasts while its message waits in the queue or its turn runs; a new occurrence waits for it.
  live(routine) {
    const run = routine.run;
    const { target } = this.chat(routine);
    const session = target?.data.sessions.find(item => item.id === run.sessionId);
    if (!session) return false;
    const mine = message => message?.routineRun?.occurrenceId === run.occurrenceId;
    return (session.queue || []).some(mine) || mine(session.pendingMessage) ||
      (target.busy === session.id && session.routineRunActive === run.occurrenceId);
  }

  refreshRun(routine) {
    if (!routine.run) return false;
    if (this.live(routine)) return true;
    routine.last = { at: routine.run.at, finishedAt: this.now(), ...(routine.run.error ? { error: routine.run.error } : {}) };
    routine.run = null; routine.updatedAt = this.now();
    // A one-time routine removes itself once its run has finished.
    if (routine.schedule.type === 'once') {
      delete this.records[routine.id];
      this.agents.primary.save();
      return true;
    }

    // Saved with the finished run, so a restart before the HEAD read still treats the run's own commits as the baseline.
    if (routine.schedule.type === 'git')
      routine.rebaseHead = true;

    this.agents.primary.save();
    return false;
  }

  // Returns false when the agent cannot take the message yet; the occurrence then waits for a later tick.
  fire(routine, occurrence, head) {
    const { target, session } = this.chat(routine);
    if (!target || !session) throw new Error('This routine’s chat is no longer available. Remove it and save a new one.');
    if (rank(session.access) > rank(routine.access)) throw new Error('This chat’s access was raised after the routine was saved. Ask to update the routine to keep it running.');
    if (routine.schedule.type === 'git' && !this.agents.workspaces.same(session.workspace, routine.workspace)) {
      throw new Error('This chat now works in another folder. Ask to update the routine.');
    }

    const busyElsewhere = target.busy && target.busy !== session.id;
    if (target.connection !== 'ready' || target.blockedReason() || busyElsewhere || (session.queue?.length || 0) >= 10) return false;

    const run = { occurrenceId: occurrence.key, sessionId: session.id, at: this.now() };
    routine.run = run; routine.lastKey = occurrence.key;
    routine.sequence = (routine.sequence || 0) + 1;
    if (routine.schedule.type === 'calendar') routine.next = calendar.next(this.now(), routine.schedule, occurrence.key);
    else if (routine.schedule.type === 'once') routine.next = null;
    else routine.head = head;
    this.agents.primary.save();

    target.send({ id: session.id, text: routine.text, routineRun: { id: routine.id, name: routine.name, occurrenceId: occurrence.key } })
      .catch(error => {
        if (routine.run === run) run.error = error.message;
        else if (routine.last) routine.last.error = error.message;
        this.agents.primary.save(); this.agents.primary.changed();
      });
    return true;
  }

  async tick() {
    if (this.operation) return this.operation;
    if (this.closed || this.agents.closing) { this.arm(); return; }
    this.operation = this.cycle().finally(() => { this.operation = null; this.arm(); });
    return this.operation;
  }

  async cycle() {
    const now = this.now(), pollGit = now >= this.gitNext, heads = new Map();
    if (pollGit) this.gitNext = now + 30000;
    for (const routine of Object.values(this.records)) {
      if (this.closed || this.agents.closing) return;
      try {
        const version = routine.version;
        if (this.refreshRun(routine) || !routine.enabled) continue;
        let occurrence = routine.next, head = null;
        if (routine.schedule.type === 'git') {
          if (!pollGit && !routine.rebaseHead) continue;
          const workspace = routine.workspace;
          if (!heads.has(workspace)) heads.set(workspace, this.head(workspace));
          head = await heads.get(workspace);
          if (this.closed || this.agents.closing) return;
          if (this.records[routine.id] !== routine || routine.version !== version || !routine.enabled) continue;
          // Commits made before a run settled, the run's own included, become the new baseline.
          if (routine.rebaseHead) {
            routine.head = head;
            delete routine.rebaseHead;
            this.agents.primary.save();
            continue;
          }

          if (head === routine.head) continue;
          occurrence = { at: now, key: 'git:' + ((routine.sequence || 0) + 1) + ':' + head };
        }
        if (!occurrence || occurrence.at > now) continue;
        if (this.fire(routine, occurrence, head)) this.agents.primary.changed();
      } catch (error) {
        if (this.closed || this.agents.closing) return;
        this.hold(routine, error.message); this.agents.primary.save(); this.agents.primary.changed();
      }
    }
  }

  // Deleting an agent deletes the routines that run on it; Hub's routines stay. Returns a rollback.
  removeAgent(id) {
    const removed = Object.values(this.records).filter(routine => routine.agentId === id);
    for (const routine of removed) delete this.records[routine.id];
    return () => {
      for (const routine of removed) this.records[routine.id] = routine;
    };
  }

  async close() {
    this.closed = true; clearTimeout(this.timer); this.abort.abort();
    await Promise.allSettled([this.operation, ...this.gitReads]);
  }
}

module.exports = { Routines };
