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

/** Flush the replacement before exposing its name. Pieces are written about 4 MB at a time, never joined into one
 * string (a checkpoint of the user's 148 MB store spent about 300 ms joining it, 2026-11-12).
 * @param {string} filename @param {string | Iterable<string>} content */
function atomicWrite(filename, content) {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const temporary = filename + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'w', 0o600);
    try {
      if (typeof content === 'string') fs.writeFileSync(fd, content);
      else {
        let batch = [], size = 0;
        for (const piece of content) {
          batch.push(piece); size += piece.length;
          if (size >= 4e6) { fs.writeFileSync(fd, batch.join('')); batch = []; size = 0; }
        }
        if (batch.length) fs.writeFileSync(fd, batch.join(''));
      }
      fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
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
  if (!validFields(change.fields, change.removed, ['sessions', '_journalRevision', '_pack']) ||
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

// Large messages (tool results, 136 of the user's largest store's 149 MB on 2026-11-13) live in a pack beside the store,
// appended once and referenced as {"$pack": [offset, length]}, so a checkpoint rewrites only the rest. A store without a
// pack (every earlier Harness) loads as before; an earlier Harness cannot read a store that has one.
const PACK_MIN = 16384;
/** @param {any} item */
const packRef = item => object(item) && Object.keys(item).length === 1 && Array.isArray(item.$pack) ? item.$pack : null;
/** @param {string} filename */
const packPrefix = filename => path.basename(filename) + '.pack-';

/** Replaces pack references with their messages. @param {string} filename @param {StoreData} data */
function unpack(filename, data) {
  const name = data._pack;
  delete data._pack;
  /** @type {Map<object, number[]>} */
  const objects = new Map();
  if (name === undefined) return { name: null, size: 0, objects };
  if (typeof name !== 'string' || !name.startsWith(packPrefix(filename)) || !/^\d+$/.test(name.slice(packPrefix(filename).length)))
    throw new Error('Invalid session pack name. Existing files were preserved.');
  const bytes = fs.readFileSync(path.join(path.dirname(filename), name));
  for (const session of Array.isArray(data.sessions) ? data.sessions : []) {
    if (!Array.isArray(session?.items)) continue;
    session.items.forEach((item, index) => {
      const ref = packRef(item);
      if (!ref) return;
      const [offset, length] = ref;
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length)
        throw new Error('Session pack is shorter than its store. Existing files were preserved.');
      const value = JSON.parse(bytes.toString('utf8', offset, offset + length));
      session.items[index] = value;
      if (value && typeof value === 'object') objects.set(value, ref);
    });
  }
  return { name, size: bytes.length, objects };
}

/** @param {string} filename */
function recover(filename) {
  /** @type {StoreData} */
  const data = JSON.parse(fs.readFileSync(filename, 'utf8'));
  const checkpointRevision = data._journalRevision ?? 0;
  if (!Number.isSafeInteger(checkpointRevision) || checkpointRevision < 0) throw new Error('Invalid session checkpoint revision.');
  let revision = checkpointRevision;
  delete data._journalRevision;
  const pack = unpack(filename, data);
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
  return { data, revision, bytes: end, records, pack };
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

// Re-encoding every message of every chat on each save took about 40 ms for a 37 MB store (measured 2026-11-04), on the
// runner thread all bots share. A chat's messages are reused from the last save unless its message list was replaced;
// its last TAIL messages and any new ones are always encoded again (streaming and status edits land there). An edit to
// an older message in place is caught by a full pass at least every FULL_MS.
const TAIL = 20, FULL_MS = 10000;

// Tool calls are 133 MB of the user's largest store's 148 (2026-11-12): encoding them again took 120 ms of every full
// pass and 270 ms of every checkpoint. A call at the same place whose own fields are still the same values or objects
// keeps its last encoding; Harness replaces a call's fields whole (the CLI streams, compactStoredDiffs) and never edits
// inside its result or arguments. ponytail: an edit made inside them in place would be saved only with the call's next
// own change; if one is ever needed, replace the field instead.
/** @type {WeakMap<object, any[]>} */
const toolFields = new WeakMap();
/** @param {any} item @param {{items: string[], objects?: any[]} | undefined} before @param {number} index */
function encodeItem(item, before, index) {
  if (item?.type !== 'mcpToolCall') return JSON.stringify(item) ?? 'null';
  const fields = Object.entries(item).flat(), kept = toolFields.get(item);
  toolFields.set(item, fields);
  if (before?.objects?.[index] === item && kept?.length === fields.length && kept.every((value, at) => value === fields[at])) return /** @type {string} */ (before?.items[index]);
  return JSON.stringify(item);
}
/** An object's encoded fields, without braces. @param {Map<string, string>} fields */
const fieldsText = fields => [...fields].filter(([, text]) => text !== undefined).map(([key, text]) => JSON.stringify(key) + ':' + text).join(',');

/** The store as JSON, in pieces (atomicWrite), from encode()'s texts; each chat's items come last.
 * @param {any} data @param {{fields: Map<string, string>, chats: {fields: Map<string, string>, items: string[]}[]}} encoded @param {number} revision
 * @param {(number[] | null)[][]} refs @param {string | null} pack */
function* storeText(data, encoded, revision, refs, pack) {
  const top = fieldsText(encoded.fields);
  yield '{' + top + (top ? ',' : '') + '"sessions":[';
  for (const [index, session] of data.sessions.entries()) {
    const fields = fieldsText(encoded.chats[index].fields);
    yield (index ? ',{' : '{') + fields;
    if (Array.isArray(session.items)) {
      yield (fields ? ',' : '') + '"items":[';
      for (const [at, item] of encoded.chats[index].items.entries()) {
        const ref = refs[index][at], text = ref ? '{"$pack":[' + ref[0] + ',' + ref[1] + ']}' : item;
        yield at ? ',' + text : text;
      }
      yield ']';
    } else if (session.items !== undefined) yield (fields ? ',' : '') + '"items":' + JSON.stringify(session.items);
    yield '}';
  }
  yield '],' + (pack ? '"_pack":' + JSON.stringify(pack) + ',' : '') + '"_journalRevision":' + revision + '}';
}

/** Writes texts at the pack's end and flushes them; returns each one's [offset, length]. @param {number} fd @param {number} start @param {string[]} texts */
function appendPack(fd, start, texts) {
  const refs = [];
  /** @type {Buffer[]} */
  let batch = [];
  let at = start, size = 0;
  const flush = () => {
    const buffer = Buffer.concat(batch);
    for (let written = 0; written < buffer.length;) {
      const count = fs.writeSync(fd, buffer, written, buffer.length - written, at - buffer.length + written);
      if (!count) throw new Error('Session pack write made no progress.');
      written += count;
    }
    batch = []; size = 0;
  };
  for (const text of texts) {
    const buffer = Buffer.from(text);
    refs.push([at, buffer.length]);
    batch.push(buffer); size += buffer.length; at += buffer.length;
    if (size >= 4e6) flush();
  }
  if (batch.length) flush();
  fs.fsyncSync(fd);
  return refs;
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
    /** @type {Map<string, {fields: Map<string, string>, items: string[], list?: any[]}>} */
    this.sessions = new Map();
    this.fullAt = 0;
    this.order = '';
    /** The pack the store on disk names. @type {{name: string | null, size: number}} */
    this.pack = { name: null, size: 0 };
    /** Each chat's messages at the last checkpoint and where the large ones are in the pack. @type {Map<string, {items: string[], refs: (number[] | null)[]}>} */
    this.packed = new Map();
  }

  /** @param {StoreData} fallback @returns {StoreData} */
  load(fallback) {
    if (!this.exists) return fallback;
    const recovered = recover(this.filename);
    if (recovered.data.version !== 1 || !Array.isArray(recovered.data.sessions))
      throw new Error('Unrecognized session store. Your existing file has been preserved.');
    this.revision = recovered.revision; this.bytes = recovered.bytes; this.records = recovered.records;
    this.remember(recovered.data);
    // A message still the object read from the pack is unchanged (journal replay replaces messages, never edits them).
    const { name, size, objects } = recovered.pack;
    this.pack = { name, size };
    this.packed = new Map(recovered.data.sessions.map(session => [session.id, { items: this.sessions.get(session.id)?.items || [],
      refs: (session.items || []).map(item => objects.get(item) || null) }]));
    return recovered.data;
  }

  /** @param {StoreData} data @param {ReturnType<SessionStore['encode']>} [encoded] */
  remember(data, encoded = this.encode(data)) {
    this.fields = encoded.fields;
    this.sessions = encoded.sessions;
    this.fullAt = Date.now();
    this.order = JSON.stringify(data.sessions.map(session => session.id));
  }

  /** Every chat's fields and messages encoded, reusing unchanged tool calls (encodeItem). @param {StoreData} data */
  encode(data) {
    const chats = data.sessions.map(session => {
      const before = this.sessions.get(session.id), list = session.items || [];
      return { fields: encodeFields(session, ['items']), items: list.map((item, index) => encodeItem(item, before, index)),
        list: session.items, objects: list.slice() };
    });
    // chats keeps the chats' order (the checkpoint); sessions finds them by id (save).
    return { fields: encodeFields(data, ['sessions', '_journalRevision']), chats,
      sessions: new Map(data.sessions.map((session, index) => [session.id, chats[index]])) };
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
    const full = Date.now() - this.fullAt >= FULL_MS;
    for (const session of data.sessions) {
      const before = this.sessions.get(session.id);
      const list = session.items || [];
      let encodedItems;
      if (!full && before?.list === session.items && session.items) {
        const keep = Math.max(0, Math.min(before.items.length, list.length) - TAIL);
        encodedItems = before.items.slice(0, keep);
        for (let index = keep; index < list.length; index++) encodedItems.push(encodeItem(list[index], before, index));
      } else encodedItems = list.map((item, index) => encodeItem(item, before, index));
      const next = { fields: encodeFields(session, ['items']), items: encodedItems, list: session.items, objects: list.slice() };
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
    if (full) this.fullAt = Date.now();
    // A checkpoint failure must not turn an acknowledged journal commit into a failed save.
    if (this.bytes >= 8 * 1024 * 1024 || this.records >= 1000) {
      try { this.checkpoint(data); } catch (error) { this.onCheckpointError(error); }
    }
  }

  /** @param {StoreData} data */
  checkpoint(data) {
    // Written from the encodings (the same JSON, with each chat's items last), and remembered only once on disk.
    const encoded = this.encode(data);
    const { refs, pack } = this.packItems(data, encoded);
    atomicWrite(this.filename, storeText(data, encoded, this.revision, refs, pack.name));
    this.exists = true;
    this.remember(data, encoded);
    const replaced = this.pack.name !== pack.name;
    this.pack = pack;
    this.packed = new Map(data.sessions.map((session, index) => [session.id, { items: encoded.chats[index].items, refs: refs[index] }]));
    if (replaced) this.removeOldPacks();
    this.closeJournal();
    const fd = fs.openSync(this.filename + '.journal', 'w', 0o600);
    this.bytes = 0; this.records = 0;
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }

  /** Where each large message is in the pack: unchanged ones where they were at the last checkpoint, new ones appended
   * and flushed. When over half the pack (and 32 MB) is no longer used, a new pack is written with only what is.
   * @param {StoreData} data @param {ReturnType<SessionStore['encode']>} encoded */
  packItems(data, encoded) {
    /** @type {[number, number, string][]} */
    const pending = [];
    let live = 0;
    const refs = data.sessions.map((session, chat) => {
      const before = this.packed.get(session.id);
      return encoded.chats[chat].items.map((text, index) => {
        if (text.length < PACK_MIN) return null;
        const ref = before?.items[index] === text ? before.refs[index] : null;
        if (ref) live += ref[1]; else pending.push([chat, index, text]);
        return ref;
      });
    });
    const directory = path.dirname(this.filename), old = this.pack.name;
    let fresh = !old || this.pack.size - live > live + 32 * 1024 * 1024;
    if (!pending.length && !fresh) return { refs, pack: this.pack };
    let fd = null, start = 0;
    if (!fresh) {
      fd = fs.openSync(path.join(directory, /** @type {string} */ (old)), 'r+');
      start = fs.fstatSync(fd).size;
      if (start < this.pack.size) { fs.closeSync(fd); fd = null; fresh = true; } // shorter than written: start a new one
    }
    let name = old;
    if (fresh) {
      pending.length = 0;
      encoded.chats.forEach((chat, index) => chat.items.forEach((text, at) => {
        if (text.length >= PACK_MIN) { refs[index][at] = null; pending.push([index, at, text]); }
      }));
      if (!pending.length) return { refs, pack: { name: null, size: 0 } };
      name = packPrefix(this.filename) + (old ? Number(old.slice(packPrefix(this.filename).length)) + 1 : 1);
      fs.mkdirSync(directory, { recursive: true });
      fd = fs.openSync(path.join(directory, name), 'w', 0o600);
    }
    let written;
    try { written = appendPack(/** @type {number} */ (fd), start, pending.map(entry => entry[2])); }
    finally { fs.closeSync(/** @type {number} */ (fd)); }
    if (fresh) syncDirectory(directory);
    pending.forEach(([chat, index], at) => { refs[chat][index] = written[at]; });
    const last = written.at(-1), end = last ? last[0] + last[1] : start;
    return { refs, pack: { name, size: end } };
  }

  /** Packs the store no longer names (replaced ones, and any left by an interrupted checkpoint). */
  removeOldPacks() {
    const directory = path.dirname(this.filename), prefix = packPrefix(this.filename);
    for (const file of fs.readdirSync(directory))
      if (file !== this.pack.name && file.startsWith(prefix) && /^\d+$/.test(file.slice(prefix.length)))
        try { fs.rmSync(path.join(directory, file), { force: true }); } catch { /* removed at the next replacement */ }
  }

  closeJournal() {
    if (this.fd == null) return;
    try { fs.closeSync(this.fd); } catch { /* already closed */ }
    this.fd = null;
  }
}

module.exports = { SessionStore, readSessionData, atomicWrite };
