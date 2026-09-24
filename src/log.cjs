// Small rotating log file: events and errors only (never prompts, replies, file contents or keys).
const fs = require('node:fs');
const path = require('node:path');

const MAX_BYTES = 1024 * 1024; // rotate at 1 MB, keep harness.log + .1 + .2
const KEEP = 2;
const SECRET = /(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/-]{8,}|(?:api[_-]?key|token|password)["'=:\s]+[^\s"',}]{6,})/gi;

function redact(text) { return String(text).replace(SECRET, '[redacted]'); }

class Log {
  constructor(directory) {
    this.directory = directory;
    this.file = path.join(directory, 'harness.log');
    try { fs.mkdirSync(directory, { recursive: true }); } catch { /* logging is best effort */ }
  }
  write(level, message, data) {
    const line = `${new Date().toISOString()} ${level.toUpperCase()} ${redact(message)}${data === undefined ? '' : ' ' + redact(safeJson(data))}\n`;
    try {
      if (fs.existsSync(this.file) && fs.statSync(this.file).size + line.length > MAX_BYTES) this.rotate();
      fs.appendFileSync(this.file, line);
    } catch { /* never let logging break the app */ }
  }
  rotate() {
    for (let i = KEEP; i >= 1; i--) {
      const from = i === 1 ? this.file : `${this.file}.${i - 1}`;
      try { if (fs.existsSync(from)) fs.renameSync(from, `${this.file}.${i}`); } catch { /* keep going */ }
    }
  }
  info(message, data) { this.write('info', message, data); }
  warn(message, data) { this.write('warn', message, data); }
  error(message, data) { this.write('error', message, data); }
  tail(lines = 200) {
    try { return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).slice(-lines); } catch { return []; }
  }
}

function safeJson(value) {
  if (value instanceof Error) return JSON.stringify({ message: value.message, code: value.code });
  try { return JSON.stringify(value)?.slice(0, 2000) ?? ''; } catch { return String(value); }
}

// A logger that does nothing, for tests and before the app folder is known.
const NO_LOG = { info() {}, warn() {}, error() {}, tail: () => [] };

module.exports = { Log, NO_LOG, redact, MAX_BYTES };
