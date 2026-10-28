const fs = require('node:fs');
const path = require('node:path');

const saved = new Map(); // key file -> whether it exists (see configured)

class JevKey {
  constructor(filename, encryption, label = 'Jev') { this.filename = filename; this.encryption = encryption; this.label = label; }
  // shortcut: remembered per key file for the whole process (every bot's snapshot asks on each window update, through
  // its own Providers); save() and remove() keep it current, so a key file another process adds or deletes shows after a
  // restart.
  get configured() {
    if (!saved.has(this.filename))
      saved.set(this.filename, fs.existsSync(this.filename));
    return saved.get(this.filename);
  }
  read() {
    if (!this.configured) throw new Error(`Add your ${this.label} API key in Settings first.`);
    if (!this.encryption.isEncryptionAvailable()) throw new Error('OS key protection is unavailable on this host.');
    try { return this.encryption.decryptString(fs.readFileSync(this.filename)); }
    catch { throw new Error(`The saved ${this.label} key could not be decrypted. Enter it again in Settings.`); }
  }
  save(key) {
    if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n]/.test(key.trim())) throw new Error(`Enter a valid ${this.label} API key.`);
    if (!this.encryption.isEncryptionAvailable()) throw new Error('OS key protection is unavailable on this host.');
    const encrypted = this.encryption.encryptString(key.trim());
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    fs.writeFileSync(this.filename + '.tmp', encrypted, { mode: 0o600 });
    fs.renameSync(this.filename + '.tmp', this.filename);
    saved.set(this.filename, true);
  }
  remove() {
    fs.rmSync(this.filename, { force: true });
    saved.set(this.filename, false);
  }
}

module.exports = { JevKey };
