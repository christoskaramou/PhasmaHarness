const fs = require('node:fs');
const path = require('node:path');

class JevKey {
  constructor(filename, encryption, label = 'Jev') { this.filename = filename; this.encryption = encryption; this.label = label; }
  get configured() { return fs.existsSync(this.filename); }
  read() {
    if (!this.configured) throw new Error(`Add your ${this.label} API key in Settings first.`);
    if (!this.encryption.isEncryptionAvailable()) throw new Error('Windows key protection is unavailable.');
    try { return this.encryption.decryptString(fs.readFileSync(this.filename)); }
    catch { throw new Error(`The saved ${this.label} key could not be decrypted. Enter it again in Settings.`); }
  }
  save(key) {
    if (typeof key !== 'string' || !key.trim() || key.length > 4096 || /[\r\n]/.test(key.trim())) throw new Error(`Enter a valid ${this.label} API key.`);
    if (!this.encryption.isEncryptionAvailable()) throw new Error('Windows key protection is unavailable.');
    const encrypted = this.encryption.encryptString(key.trim());
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    fs.writeFileSync(this.filename + '.tmp', encrypted, { mode: 0o600 });
    fs.renameSync(this.filename + '.tmp', this.filename);
  }
  remove() { fs.rmSync(this.filename, { force: true }); }
}

module.exports = { JevKey };
