'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { remoteKey, originValue } = require('./remote.cjs');

class RemoteSettings {
  constructor(directory, encryption = null) {
    this.directory = directory; this.encryption = encryption;
    this.filename = path.join(directory, 'credentials.phasma-remote.json');
    this.value = { enabled: false, port: 8788, origin: null, sessions: [] };
    if (fs.existsSync(this.filename)) {
      const stat = fs.lstatSync(this.filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536)
        throw new Error('Browser settings must be an ordinary private file.');
      try { this.value = this.validate(JSON.parse(fs.readFileSync(this.filename, 'utf8'))); }
      catch { throw new Error('Browser settings are invalid. Review credentials.phasma-remote.json on the runner.'); }
    }
  }

  validate(value) {
    if (!value || typeof value.enabled !== 'boolean' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
        (value.origin !== null && typeof value.origin !== 'string') || !Array.isArray(value.sessions) || value.sessions.length > 64 ||
        value.sessions.some(row => !Array.isArray(row) || row.length !== 2 || typeof row[0] !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(row[0]) || !Number.isSafeInteger(row[1]) || row[1] < 0) ||
        Object.keys(value).some(key => !['enabled', 'port', 'origin', 'sessions'].includes(key)))
      throw new Error('Invalid browser settings.');
    return { enabled: value.enabled, port: value.port, origin: value.origin === null ? null : originValue(value.origin),
      sessions: value.sessions.map(row => [...row]) };
  }

  key() { return remoteKey(this.directory, false, this.encryption); }
  resetKey() { return remoteKey(this.directory, true, this.encryption); }

  save(change) {
    const next = this.validate({ ...this.value, ...change });
    if (fs.existsSync(this.filename)) {
      const stat = fs.lstatSync(this.filename);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Browser settings changed. Review them before continuing.');
    }
    fs.mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const temporary = this.filename + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600, flush: true });
      fs.renameSync(temporary, this.filename);
      this.value = next;
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return this.value;
  }
}

module.exports = { RemoteSettings };
