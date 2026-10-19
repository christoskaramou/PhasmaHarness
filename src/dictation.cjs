'use strict';
const { EventEmitter } = require('node:events');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');
const { gameEnvironment } = require('./artifacts.cjs');
const execute = promisify(execFile);

class Dictation extends EventEmitter {
  constructor({ platform = process.platform, launch = spawn, command = execute, inputFile = null,
    stopMs = 2000, killMs = 2000, maxMs = 5 * 60000 } = {}) {
    super();
    this.platform = platform; this.launch = launch; this.command = command; this.inputFile = inputFile;
    this.stopMs = stopMs; this.killMs = killMs; this.maxMs = maxMs;
    this.record = null; this.closed = false; this.metadata = null; this.reading = false;
    this.abort = new AbortController();
    this.binary = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    this.script = path.join(__dirname, 'dictation.ps1');
  }

  get busy() { return !!this.record || this.reading; }
  args(mode) { return ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script, '-Mode', mode]; }
  snapshot() {
    const record = this.record;
    return record ? { id: record.id, sessionId: record.sessionId, state: record.state, language: record.language,
      error: record.error || null } : { state: 'idle' };
  }
  event(type, value = {}) { this.emit('event', { ...this.snapshot(), type, ...value }); }

  async info() {
    if (this.platform !== 'win32') return { supported: false, languages: [], reason: 'Local Windows dictation is unavailable on this device.' };
    if (this.closed) return { supported: false, languages: [], reason: 'Dictation is closed.' };
    if (!this.metadata) {
      this.reading = true;
      this.metadata = this.command(this.binary, this.args('Info'), { windowsHide: true, timeout: 8000,
        maxBuffer: 65536, env: gameEnvironment(), signal: this.abort.signal }).then(({ stdout }) => {
        const parsed = JSON.parse(stdout.trim());
        if (parsed.type !== 'info' || !Array.isArray(parsed.languages) || parsed.languages.length > 100 ||
            parsed.languages.some(language => !language || typeof language.id !== 'string' || language.id.length > 200 ||
              typeof language.name !== 'string' || typeof language.culture !== 'string')) throw new Error('The Windows speech language list is invalid.');
        return { supported: parsed.languages.length > 0, languages: parsed.languages,
          reason: parsed.languages.length ? null : 'Install a Windows speech language to use local dictation.' };
      }).catch(error => ({ supported: false, languages: [], reason: 'Windows dictation is unavailable: ' + error.message.slice(0, 500) }))
        .finally(() => { this.reading = false; });
    }
    return this.metadata;
  }

  start({ id, sessionId, recognizerId }) {
    if (this.closed) throw new Error('Dictation is closed.');
    if (this.record) throw new Error('Finish the current dictation before starting another.');
    if (!/^[a-f0-9-]{36}$/.test(id) || typeof sessionId !== 'string' || !sessionId) throw new Error('Choose a valid dictation and chat identity.');
    const record = { id, sessionId, state: 'starting', sequence: 0, child: null, error: null };
    this.record = record;
    record.starting = this.open(record, recognizerId);
    this.event('state');
    return record.starting;
  }

  async open(record, recognizerId) {
    try {
      const info = await this.info();
      if (this.closed || record.stopRequested) { this.finish(record); return { id: record.id, sessionId: record.sessionId, state: 'idle' }; }
      if (!info.supported) throw new Error(info.reason);
      const language = recognizerId ? info.languages.find(language => language.id === recognizerId) : info.languages[0];
      if (!language) throw new Error('Choose an installed speech language.');
      record.language = language.name;
      const args = [...this.args('Listen'), '-RecognizerId', language.id, ...(this.inputFile ? ['-InputFile', this.inputFile] : [])];
      const child = record.child = this.launch(this.binary, args, { windowsHide: true, shell: false,
        env: gameEnvironment(), stdio: ['pipe', 'pipe', 'pipe'] });
      record.decoder = new StringDecoder('utf8'); record.buffer = ''; record.stderr = '';
      record.exited = new Promise(resolve => { record.resolveExit = resolve; });
      child.stdout.on('data', chunk => this.output(record, record.decoder.write(chunk)));
      child.stderr.on('data', chunk => { record.stderr = (record.stderr + chunk.toString()).slice(-4000); });
      child.stdin.on('error', () => {});
      child.once('error', error => { record.error = error.message; if (!child.pid) this.finish(record); });
      child.once('close', code => {
        this.output(record, record.decoder.end() + '\n');
        if (code && !record.stopRequested && !record.error) record.error = record.stderr.trim() || 'Windows dictation stopped unexpectedly.';
        this.finish(record); record.resolveExit();
      });
      record.limit = setTimeout(() => this.stop(record.id).catch(() => {}), this.maxMs); record.limit.unref?.();
      return this.snapshot();
    } catch (error) { record.error = error.message; this.finish(record); throw error; }
  }

  output(record, text) {
    if (this.record !== record) return;
    record.buffer += text;
    if (record.buffer.length > 65536) { record.error = 'Dictation output exceeded its limit.'; this.stop(record.id).catch(() => {}); return; }
    let newline;
    while ((newline = record.buffer.indexOf('\n')) >= 0) {
      const line = record.buffer.slice(0, newline).trim(); record.buffer = record.buffer.slice(newline + 1);
      if (!line) continue;
      try {
        const message = JSON.parse(line);
        if (message.type === 'ready') {
          if (!record.stopRequested) record.state = 'listening';
          this.event('state');
        } else if (message.type === 'text' && typeof message.text === 'string' && message.text.trim()) {
          this.event('text', { text: message.text, sequence: ++record.sequence });
        } else if (message.type === 'error' && typeof message.message === 'string') {
          record.error = message.message.slice(0, 2000); this.event('state');
        } else throw new Error('Unexpected speech event.');
      } catch { record.error = 'Windows dictation returned an invalid event.'; this.stop(record.id).catch(() => {}); }
    }
  }

  finish(record) {
    clearTimeout(record.limit);
    if (this.record !== record) return;
    record.state = 'idle'; this.event('state'); this.record = null;
  }

  async wait(record, ms) {
    let timer;
    try { return await Promise.race([record.exited.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), ms); })]); }
    finally { clearTimeout(timer); }
  }

  stop(id) {
    const record = this.record;
    if (!record || (id && id !== record.id)) return Promise.resolve(this.snapshot());
    if (record.stopping) return record.stopping;
    record.stopRequested = true; record.state = 'stopping';
    record.stopping = (async () => {
      await record.starting.catch(() => {});
      if (!record.child || this.record !== record) return { id: record.id, sessionId: record.sessionId, state: 'idle' };
      try { record.child.stdin.end('stop\n'); } catch { /* Forced cleanup below still owns this child. */ }
      if (!await this.wait(record, this.stopMs)) {
        record.child.kill();
        if (!await this.wait(record, this.killMs)) {
          record.state = 'cleanup-blocked'; record.error = 'Dictation cleanup is not confirmed. Retry Stop before recording again.';
          record.stopping = null; this.event('state'); throw new Error(record.error);
        }
      }
      return { id: record.id, sessionId: record.sessionId, state: 'idle' };
    })();
    this.event('state');
    return record.stopping;
  }

  async close() {
    this.closed = true; this.abort.abort();
    await this.stop();
    await this.metadata;
  }
}

module.exports = { Dictation };
