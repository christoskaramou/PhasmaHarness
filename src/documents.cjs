'use strict';
const { fork, spawn } = require('node:child_process');
const path = require('node:path');
const { gameEnvironment } = require('./artifacts.cjs');
const MAX_SOURCE = 10 * 1024 * 1024;
// pdf.js and canvas buffers live outside the 192 MB V8 heap. On 2026-10-19 a 10 MB, 200-page PDF and a 25 MP image peaked
// at 150-250 MB committed, while a 3 KB double-Flate PDF reached 3.5 GB without an OS limit.
const MAX_MEMORY = 768 * 1024 * 1024;
const LIMIT_FAILED = 'Harness could not limit the reader memory, so the file was not read.';

class DocumentReader {
  constructor({ timeoutMs = 15000, workerFile = path.join(__dirname, 'document-worker.cjs') } = {}) {
    this.timeoutMs = timeoutMs; this.workerFile = workerFile; this.active = new Set(); this.closed = false;
  }
  get busy() { return this.active.size > 0; }

  read({ name, bytes } = {}) {
    const format = typeof name === 'string' && !/[\x00-\x1f/\\]/.test(name) && name.length <= 255 && /\.(pdf|docx)$/i.exec(name)?.[1].toLowerCase();
    if (!format || !(bytes instanceof Uint8Array) || bytes.byteLength < 4 || bytes.byteLength > MAX_SOURCE)
      return Promise.reject(new Error('Use a PDF or DOCX document under 10 MB.'));
    const signature = Buffer.from(bytes.subarray(0, 5)).toString('latin1');
    if ((format === 'pdf' && signature !== '%PDF-') || (format === 'docx' && !signature.startsWith('PK\x03\x04')))
      return Promise.reject(new Error('The document contents do not match its file type.'));
    return this.run({ format, bytes: new Uint8Array(bytes) });
  }

  image(url, signal) {
    if (typeof url !== 'string' || url.length > 12 * 1024 * 1024)
      return Promise.reject(new Error('Attach an image under 8 MB.'));
    const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(url);
    if (!match) return Promise.reject(new Error('Use PNG, JPEG or WebP images.'));
    return this.run({ format: 'image', mime: match[1], bytes: new Uint8Array(Buffer.from(match[2], 'base64')) }, signal)
      .then(result => result.url);
  }

  run(data, signal) {
    const label = data.format === 'image' ? 'Image validation' : 'Document reading';
    if (this.closed) return Promise.reject(new Error(label + ' is closed.'));
    if (this.busy) return Promise.reject(new Error('Wait for the current document or image to finish.'));
    if (signal?.aborted) return Promise.reject(new Error(label + ' cancelled.'));
    return new Promise((resolve, reject) => {
      // prlimit execs the worker, keeping its IPC channel and environment; RLIMIT_DATA covers buffers outside the heap.
      const options = process.platform === 'linux' ? { execPath: '/usr/bin/prlimit',
        execArgv: ['--data=' + MAX_MEMORY, '--', process.execPath, '--max-old-space-size=192'] } : { execArgv: ['--max-old-space-size=192'] };
      const child = fork(this.workerFile, [], { ...options, windowsHide: true,
        env: { ...gameEnvironment(), ELECTRON_RUN_AS_NODE: '1' }, serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      const entry = { child, label, error: null, result: null, limiting: false };
      entry.ended = new Promise(done => { entry.done = done; });
      // While its PID is with the limiter the worker stays alive, so the helper can never open a reused PID.
      entry.kill = () => entry.limiting ? this.limiter?.helper.kill() : child.kill();
      this.active.add(entry);
      const timer = setTimeout(() => {
        entry.error = new Error(label + ' timed out. Try a smaller file.');
        entry.kill();
      }, this.timeoutMs);
      timer.unref?.();
      const abort = () => { entry.error = new Error(label + ' cancelled.'); entry.kill(); };
      signal?.addEventListener('abort', abort, { once: true });
      child.stderr.on('data', () => {});
      child.once('message', result => {
        if (result.error) entry.error = new Error(result.error);
        else entry.result = result;
        child.kill();
      });
      child.once('error', error => { entry.error = error.code === 'ENOENT' && options.execPath ? new Error(LIMIT_FAILED + ' Install prlimit (util-linux).') : error; });
      child.once('close', () => {
        clearTimeout(timer); signal?.removeEventListener('abort', abort); this.active.delete(entry); entry.done();
        if (entry.error) reject(entry.error);
        else if (!entry.result) reject(new Error(label + ' stopped before returning a result. The file may need more memory than Harness allows; try a smaller file.'));
        else resolve(entry.result);
      });
      (process.platform === 'win32' ? this.limit(entry) : Promise.resolve()).then(() => {
        if (entry.error) return void child.kill();
        child.send(data, error => { if (error) { entry.error = error; child.kill(); } });
      }, error => { entry.error ??= error; child.kill(); });
    });
  }

  // Windows: one helper holds a job object that caps each worker's committed memory (document-job.ps1).
  async limit(entry) {
    const limiter = this.limiter ||= this.startLimiter();
    if (await limiter.ready !== 'ready') throw new Error(LIMIT_FAILED);
    const { child } = entry;
    if (entry.error || child.exitCode !== null || child.signalCode !== null) return;
    entry.limiting = true;
    const reply = await new Promise(resolve => { limiter.replies.push(resolve); limiter.helper.stdin.write(child.pid + '\n'); });
    entry.limiting = false;
    if (reply !== 'limited:' + child.pid) throw new Error(LIMIT_FAILED);
  }

  startLimiter() {
    const shell = path.join(process.env.WINDIR || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0');
    const helper = spawn(path.join(shell, 'powershell.exe'), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'document-job.ps1'), '-LimitBytes', String(MAX_MEMORY)],
      { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'], env: { ...gameEnvironment(), PSModulePath: path.join(shell, 'Modules') } });
    const limiter = { helper, replies: [] };
    limiter.ready = new Promise(resolve => limiter.replies.push(resolve));
    let buffer = '';
    helper.stdout.setEncoding('utf8');
    helper.stdout.on('data', text => {
      buffer += text;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        limiter.replies.shift()?.(buffer.slice(0, end).trim());
        buffer = buffer.slice(end + 1);
      }
    });
    const ended = () => {
      if (this.limiter === limiter) this.limiter = null;
      for (const reply of limiter.replies.splice(0)) reply(null);
    };
    helper.once('error', ended); helper.once('close', ended); helper.stdin.on('error', ended);
    // An idle helper must not keep the process alive; closing its input ends it and its job.
    helper.unref(); helper.stdout.unref?.(); helper.stdin.unref?.();
    return limiter;
  }

  async close() {
    this.closed = true;
    await Promise.all([...this.active].map(entry => {
      entry.error = new Error(entry.label + ' stopped because Harness is closing.');
      entry.kill();
      return entry.ended;
    }));
    this.limiter?.helper.stdin.end();
  }
}

module.exports = { DocumentReader, MAX_SOURCE };
