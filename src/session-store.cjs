const fs = require('node:fs');
const path = require('node:path');

/** @typedef {Record<string, any> & {id: string, items: any[]}} Session */
/** @typedef {Record<string, any> & {sessions: Session[]}} StoreData */
/** @typedef {{id: string, fields: Record<string, any>, removed: string[], items?: {start: number, values: any[]}}} SessionChange */
/** @typedef {{revision: number, fields: Record<string, any>, removed: string[], sessions: SessionChange[], order: string[]}} Change */

/** @param {string} directory */
function syncDirectory(directory) {
  // Windows does not support opening directory handles through fs.openSync.
  if (process.platform === 'win32') return;
  const fd = fs.openSync(directory, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Flush the replacement before exposing its name. @param {string} filename @param {string} text */
function atomicWrite(filename, text) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = filename + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'w', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, filename);
    syncDirectory(path.dirname(filename));
  } finally { fs.rmSync(temporary, { force: true }); }
}

/** @param {unknown} value @returns {value is Record<string, any>} */
function object(value) { return !!value && typeof value === 'object' && !Array.isArray(value); }

/** @param {unknown} fields @param {unknown} removed @param {string[]} reserved */
function validFields(fields, removed, reserved) {
  return object(fields) && Array.isArray(removed) && removed.every(key => typeof key === 'string') &&
    ![...Object.keys(fields), ...removed].some(key => reserved.includes(key));
}

/** @param {Record<string, any>} target @param {Record<string, any>} fields @param {string[]} removed */
function patch(target, fields, removed) {
  for (const key of removed) delete target[key];
  // defineProperty preserves JSON keys such as __proto__ as data.
  for (const [key, value] of Object.entries(fields))
    Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
}

/** @param {StoreData} data @param {Change} change */
function apply(data, change) {
  if (!validFields(change.fields, change.removed, ['sessions', '_journalRevision']) ||
      !Array.isArray(change.sessions) || !Array.isArray(change.order) || !change.order.every(id => typeof id === 'string') ||
      new Set(change.order).size !== change.order.length || new Set(change.sessions.map(edit => edit?.id)).size !== change.sessions.length)
    throw new Error('Invalid session journal record. Existing files were preserved.');
  patch(data, change.fields, change.removed);
  const sessions = new Map(data.sessions.map(session => [session.id, session]));
  for (const edit of change.sessions) {
    if (!edit || typeof edit.id !== 'string' || !validFields(edit.fields, edit.removed, ['items']) ||
        edit.removed.includes('id') || (Object.hasOwn(edit.fields, 'id') && edit.fields.id !== edit.id)) throw new Error('Invalid session journal edit.');
    const session = sessions.get(edit.id) || { id: edit.id, items: [] };
    patch(session, edit.fields, edit.removed);
    if (edit.items) {
      if (!Number.isInteger(edit.items.start) || edit.items.start < 0 || edit.items.start > (session.items || []).length || !Array.isArray(edit.items.values))
        throw new Error('Invalid session journal transcript.');
      session.items = (session.items || []).slice(0, edit.items.start).concat(edit.items.values);
    }
    sessions.set(edit.id, session);
  }
  data.sessions = change.order.map(id => {
    const session = sessions.get(id);
    if (!session) throw new Error('Missing session in journal.');
    return session;
  });
}

/** @param {string} filename */
function recover(filename) {
  /** @type {StoreData} */
  const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const checkpointRevision = data._journalRevision ?? 0;
  if (!Number.isSafeInteger(checkpointRevision) || checkpointRevision < 0) throw new Error('Invalid session checkpoint revision.');
  let revision = checkpointRevision;
  delete data._journalRevision;
  const journal = filename + '.journal';
  const bytes = fs.existsSync(journal) ? fs.readFileSync(journal) : Buffer.alloc(0);
  // A partial final append was never acknowledged. Complete malformed records fail closed.
  const end = bytes.lastIndexOf(10) + 1;
  let records = 0;
  for (const line of bytes.subarray(0, end).toString('utf8').split('\n').filter(Boolean)) {
    /** @type {Change} */
    const change = JSON.parse(line);
    if (!change || !Number.isSafeInteger(change.revision) || change.revision < 1) throw new Error('Invalid session journal revision.');
    if (change.revision <= checkpointRevision) continue; // checkpoint may have reached disk before journal cleanup
    if (change.revision !== revision + 1) throw new Error('Session journal has a revision gap.');
    apply(data, change);
    revision = change.revision;
    records++;
  }
  return { data, revision, bytes: end, records };
}

/** Read snapshots and their committed journal together. @param {string} filename @returns {StoreData} */
function readSessionData(filename) { return recover(filename).data; }

/** @param {Record<string, any>} value @param {string[]} excluded */
function encodeFields(value, excluded) {
  return new Map(Object.entries(value).filter(([key, value]) => !excluded.includes(key) && value !== undefined)
    .map(([key, value]) => [key, JSON.stringify(value)]));
}

/** @param {Map<string, string>} before @param {Map<string, string>} after */
function difference(before, after) {
  return { fields: Object.fromEntries([...after].filter(([key, text]) => before.get(key) !== text).map(([key, text]) => [key, JSON.parse(text)])),
    removed: [...before.keys()].filter(key => !after.has(key)) };
}

class SessionStore {
  /** @param {string} filename @param {(error: unknown) => void} onCheckpointError */
  constructor(filename, onCheckpointError = () => {}) {
    this.filename = filename;
    this.onCheckpointError = onCheckpointError;
    this.revision = 0;
    /** @type {number | null} */
    this.fd = null;
    this.bytes = 0;
    this.records = 0;
    this.exists = fs.existsSync(filename);
    this.fields = new Map();
    /** @type {Map<string, {fields: Map<string, string>, items: string[]}>} */
    this.sessions = new Map();
    this.order = '';
  }

  /** @param {StoreData} fallback @returns {StoreData} */
  load(fallback) {
    if (!this.exists) return fallback;
    const recovered = recover(this.filename);
    if (recovered.data.version !== 1 || !Array.isArray(recovered.data.sessions))
      throw new Error('Unrecognized session store. Your existing file has been preserved.');
    this.revision = recovered.revision; this.bytes = recovered.bytes; this.records = recovered.records;
    this.remember(recovered.data);
    return recovered.data;
  }

  /** @param {StoreData} data */
  remember(data) {
    this.fields = encodeFields(data, ['sessions', '_journalRevision']);
    this.sessions = new Map(data.sessions.map(session => [session.id, {
      fields: encodeFields(session, ['items']), items: (session.items || []).map(item => JSON.stringify(item)),
    }]));
    this.order = JSON.stringify(data.sessions.map(session => session.id));
  }

  /** Saves are synchronous: callers must know their task state is durable before submitting work. @param {StoreData} data */
  save(data) {
    if (!this.exists || !fs.existsSync(this.filename) || !fs.existsSync(this.filename + '.journal')) return this.checkpoint(data);
    const fields = encodeFields(data, ['sessions', '_journalRevision']);
    const change = difference(this.fields, fields);
    const order = data.sessions.map(session => session.id);
    /** @type {SessionChange[]} */
    const sessions = [];
    const encoded = new Map();
    for (const session of data.sessions) {
      const before = this.sessions.get(session.id);
      const next = { fields: encodeFields(session, ['items']), items: (session.items || []).map(item => JSON.stringify(item)) };
      encoded.set(session.id, next);
      const edit = difference(before?.fields || new Map(), next.fields);
      let start = 0;
      while (start < next.items.length && before?.items[start] === next.items[start]) start++;
      const items = start !== next.items.length || start !== before?.items.length
        ? { start, values: (session.items || []).slice(start) } : undefined;
      if (items || edit.removed.length || Object.keys(edit.fields).length) sessions.push({ id: session.id, ...edit, ...(items ? { items } : {}) });
    }
    if (!sessions.length && !change.removed.length && !Object.keys(change.fields).length && JSON.stringify(order) === this.order) return;
    const text = JSON.stringify({ revision: this.revision + 1, ...change, sessions, order }) + '\n';
    const journal = this.filename + '.journal', existed = fs.existsSync(journal);
    // Reopening the journal for every save let on-access antivirus rescan the whole file each time (about 100 ms per MB,
    // 0.45 s for a 4 MB journal, measured 2026-10-25); one handle stays open until the next checkpoint or failed write.
    if (!existed) this.closeJournal();
    const fd = this.fd ??= fs.openSync(journal, existed ? 'r+' : 'w+', 0o600);
    try {
      fs.ftruncateSync(fd, this.bytes);
      const buffer = Buffer.from(text);
      for (let written = 0; written < buffer.length;) {
        const count = fs.writeSync(fd, buffer, written, buffer.length - written, this.bytes + written);
        if (!count) throw new Error('Session journal write made no progress.');
        written += count;
      }
      fs.fsyncSync(fd);
      if (!existed) syncDirectory(path.dirname(journal));
    } catch (error) {
      // A failed write is retried from the last acknowledged boundary, not after a partial record.
      try { fs.ftruncateSync(fd, this.bytes); fs.fsyncSync(fd); } catch { /* the next save or restart retries recovery */ }
      this.closeJournal();
      throw error;
    }
    this.revision++; this.bytes += Buffer.byteLength(text); this.records++;
    this.fields = fields; this.sessions = encoded; this.order = JSON.stringify(order);
    // A checkpoint failure must not turn an acknowledged journal commit into a failed save.
    if (this.bytes >= 8 * 1024 * 1024 || this.records >= 1000) {
      try { this.checkpoint(data); } catch (error) { this.onCheckpointError(error); }
    }
  }

  /** @param {StoreData} data */
  checkpoint(data) {
    atomicWrite(this.filename, JSON.stringify({ ...data, _journalRevision: this.revision }));
    this.exists = true;
    this.remember(data);
    this.closeJournal();
    const fd = fs.openSync(this.filename + '.journal', 'w', 0o600);
    this.bytes = 0; this.records = 0;
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  closeJournal() {
    if (this.fd == null) return;
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
    this.fd = null;
  }
}

module.exports = { SessionStore, readSessionData, atomicWrite };
