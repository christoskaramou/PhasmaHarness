'use strict';
// Local dictation with Whisper: the renderer records 16 kHz mono 16-bit PCM while the user speaks; on Stop it hands the
// audio here, and a worker process (src/whisper-worker.cjs) transcribes it on the GPU when there is one, else the CPU.
// Nothing leaves the device but the one-time model download from Hugging Face, checked against pinned SHA-256 sums.
const { EventEmitter } = require('node:events');
const { fork } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const { gameEnvironment } = require('./artifacts.cjs');

const SAMPLE_RATE = 16000;
const MAX_SECONDS = 5 * 60;
const MAX_BYTES = SAMPLE_RATE * 2 * MAX_SECONDS;
// base runs everywhere; small is clearly better (Greek included) and only fast on a GPU, so only GPUs download it.
const MODELS = {
  base: { file: 'ggml-base-q5_1.bin', bytes: 59707625, sha256: '422f1ae452ade6f30a004d7e5c6a43195e4433bc370bf23fac9cc591f01a8898' },
  small: { file: 'ggml-small-q5_1.bin', bytes: 190085487, sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb' },
};
const MODEL_URL = file => `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${file}`;

// Speech, not silence or room noise: at least half a second, with a fifth of a second of 20 ms frames above about
// -36 dBFS. Whisper turns near-silence into "[BLANK_AUDIO]" or invented words, and noise can take a minute on the CPU.
// shortcut: fixed thresholds from a TTS clip and generated noise, tune them if quiet speakers lose words.
function voiced(pcm) {
  if (pcm.length < SAMPLE_RATE / 2)
    return false;

  let frames = 0;
  for (let start = 0; start + 320 <= pcm.length; start += 320) {
    let sum = 0;
    for (let index = start; index < start + 320; index++)
      sum += pcm[index] * pcm[index];
    if (Math.sqrt(sum / 320) > 500)
      frames++;
  }
  return frames >= 10;
}

// Whisper's tags ("[BLANK_AUDIO]", "(music)") go, and a result with no Latin or Greek letters is noise.
function cleanText(text) {
  const stripped = String(text || '').replace(/\[[^\]]*\]|\([^()]{0,40}\)|\*[^*]{0,40}\*/g, ' ').replace(/\s+/g, ' ').trim();
  return /[A-Za-zÀ-ɏͰ-Ͽἀ-῿]/.test(stripped) ? stripped : '';
}

// Electron's microphone: only the app's own page, audio only, while a dictation it started is recording.
function microphoneAllowed({ permission, mediaTypes = [], url, rendererURL, fromWindow, recording }) {
  return permission === 'media' && !!fromWindow && url === rendererURL && !!recording &&
    mediaTypes.length > 0 && mediaTypes.every(type => type === 'audio');
}

class Dictation extends EventEmitter {
  constructor({ platform = process.platform, arch = process.arch, modelDirectory = null, fetch = globalThis.fetch, launch = fork,
    workerFile = path.join(__dirname, 'whisper-worker.cjs'), resolve = require.resolve, stopMs = 5000, idleMs = 10 * 60000,
    maxMs = MAX_SECONDS * 1000, language = 'auto', models = MODELS } = {}) {
    super();
    Object.assign(this, { platform, arch, modelDirectory, fetch, launch, workerFile, resolve, stopMs, idleMs, maxMs, language, models });
    this.record = null;
    this.closed = false;
    this.worker = null;
    this.ready = null;
    this.queue = Promise.resolve();
    this.downloads = new Map();
    this.progress = null;
    this.abort = new AbortController();
  }

  get busy() { return !!this.record || this.downloads.size > 0; }
  get recording() { return this.record?.state === 'listening'; }

  snapshot() {
    const record = this.record;
    const progress = this.progress ? { progress: this.progress } : {};
    return record ? { id: record.id, sessionId: record.sessionId, state: record.state, error: record.error || null, ...progress } : { state: 'idle', ...progress };
  }

  event(type, value = {}) { this.emit('event', { ...this.snapshot(), type, ...value }); }

  engine() {
    for (const name of [`@fugood/node-whisper-${this.platform}-${this.arch}-vulkan`, `@fugood/node-whisper-${this.platform}-${this.arch}`]) {
      try {
        return this.resolve(name);
      } catch { /* the next build */ }
    }
    return null;
  }

  modelPath(name) { return path.join(this.modelDirectory, this.models[name].file); }

  modelPresent(name) {
    try {
      return fs.statSync(this.modelPath(name)).size === this.models[name].bytes;
    } catch {
      return false;
    }
  }

  async info() {
    if (!this.modelDirectory || !this.engine())
      return { supported: false, reason: 'Local dictation is not available on this system.' };
    if (this.closed)
      return { supported: false, reason: 'Dictation is closed.' };

    const firstUse = !this.modelPresent('base') && !this.modelPresent('small');
    return { supported: true, language: 'Greek and English, detected each time', firstUse,
      ...(firstUse ? { download: `${Math.round(this.models.base.bytes / 1e6)} MB` } : {}) };
  }

  // Opens a recording for the renderer and warms the model meanwhile, so the GPU warm-up overlaps the speaking.
  start({ id, sessionId }) {
    if (this.closed)
      throw new Error('Dictation is closed.');
    if (this.record)
      throw new Error('Finish the current dictation before starting another.');
    if (!/^[a-f0-9-]{36}$/.test(id) || typeof sessionId !== 'string' || !sessionId)
      throw new Error('Choose a valid dictation and chat identity.');
    if (!this.modelDirectory || !this.engine())
      throw new Error('Local dictation is not available on this system.');

    const record = { id, sessionId, state: 'listening', sequence: 0, error: null };
    this.record = record;
    record.limit = setTimeout(() => this.stop(id), this.maxMs + this.stopMs);
    record.limit.unref?.();
    this.prepare().catch(error => {
      if (this.record === record && !record.error) {
        record.error = error.message;
        this.event('state');
      }
    });
    this.event('state');
    return this.snapshot();
  }

  // The renderer's audio for the open recording: checked here, before anything reaches native code.
  async transcribe(id, data) {
    const record = this.record;
    if (!record || record.id !== id || !['listening', 'stopping'].includes(record.state))
      throw new Error('Choose the current dictation.');

    const bytes = ArrayBuffer.isView(data) ? data : data instanceof ArrayBuffer ? new Uint8Array(data) : null;
    if (!bytes || bytes.byteLength % 2 || bytes.byteLength > MAX_BYTES)
      throw new Error('The recording is not valid audio or is longer than five minutes.');

    const pcm = new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    record.state = 'transcribing';
    clearTimeout(record.stopTimer);
    this.event('state');
    try {
      if (voiced(pcm)) {
        await this.prepare();
        const text = cleanText(await this.request({ type: 'transcribe', pcm, language: this.language }));
        if (text && this.record === record)
          this.event('text', { text, sequence: ++record.sequence });
      }
    } catch (error) {
      record.error = error.message;
      this.event('state');
    } finally {
      this.finish(record);
      this.idleSoon();
    }
    return { id, sessionId: record.sessionId, state: 'idle', error: record.error };
  }

  // Asks the renderer to send what it recorded ("stopping"); with no audio in time, or with `discard`, the recording
  // ends without words.
  stop(id, { discard = false } = {}) {
    const record = this.record;
    if (!record || (id && id !== record.id) || record.state === 'transcribing')
      return Promise.resolve(this.snapshot());

    if (discard) {
      this.finish(record);
      return Promise.resolve(this.snapshot());
    }

    if (record.state === 'listening') {
      record.state = 'stopping';
      record.stopTimer = setTimeout(() => this.finish(record), this.stopMs);
      record.stopTimer.unref?.();
      this.event('state');
    }
    return Promise.resolve(this.snapshot());
  }

  finish(record) {
    clearTimeout(record.limit);
    clearTimeout(record.stopTimer);
    if (this.record !== record)
      return;

    record.state = 'idle';
    this.event('state');
    this.record = null;
  }

  // The worker with the best model this machine can run fast: small on a GPU, else base. A machine with a GPU starts on
  // base the first time and switches to small once it is downloaded.
  prepare() {
    if (this.ready)
      return this.ready;

    this.ready = (async () => {
      const small = this.modelPresent('small');
      const first = await this.load(small ? this.modelPath('small') : await this.ensureModel('base'));
      if (first.gpu && !small)
        this.ensureModel('small').then(file => this.load(file)).catch(() => { /* base keeps working */ });
      if (!first.gpu && small)
        await this.load(await this.ensureModel('base'));
    })();
    this.ready.catch(() => {
      this.ready = null;
      this.stopWorker();
    });
    return this.ready;
  }

  load(filePath) { return this.request({ type: 'load', filePath }); }

  // One request at a time, so a model switch never releases a context that is transcribing.
  request(message) {
    const run = this.queue.then(() => this.send(message));
    this.queue = run.catch(() => {});
    return run;
  }

  send(message) {
    if (this.closed)
      return Promise.reject(new Error('Dictation is closed.'));

    const worker = this.startWorker();
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      worker.pending.set(id, { resolve, reject });
      worker.child.send({ ...message, id });
    });
  }

  startWorker() {
    if (this.worker)
      return this.worker;

    clearTimeout(this.idleTimer);
    const child = this.launch(this.workerFile, [], { windowsHide: true, env: { ...gameEnvironment(), ELECTRON_RUN_AS_NODE: '1' },
      serialization: 'advanced', stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    const worker = { child, pending: new Map(), stderr: '' };
    child.stderr?.on('data', chunk => { worker.stderr = (worker.stderr + chunk).slice(-2000); });
    child.on('message', message => {
      const entry = worker.pending.get(message?.id);
      if (!entry)
        return;

      worker.pending.delete(message.id);
      if (message.type === 'error')
        entry.reject(new Error(`Dictation failed: ${message.message}`));
      else
        entry.resolve(message.type === 'text' ? message.text : { gpu: !!message.gpu });
    });
    child.once('exit', () => {
      if (this.worker === worker) {
        this.worker = null;
        this.ready = null;
      }
      for (const entry of worker.pending.values())
        entry.reject(new Error('The dictation engine stopped unexpectedly.' + (worker.stderr ? ` ${worker.stderr.trim().slice(-300)}` : '')));
    });
    this.worker = worker;
    return worker;
  }

  stopWorker() {
    clearTimeout(this.idleTimer);
    this.worker?.child.kill();
    this.worker = null;
    this.ready = null;
  }

  // The model stays loaded for a while after use, then frees its memory.
  idleSoon() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (!this.record)
        this.stopWorker();
    }, this.idleMs);
    this.idleTimer.unref?.();
  }

  ensureModel(name) {
    if (this.modelPresent(name))
      return Promise.resolve(this.modelPath(name));
    if (!this.downloads.has(name)) {
      const download = this.download(name).finally(() => this.downloads.delete(name));
      this.downloads.set(name, download);
    }
    return this.downloads.get(name);
  }

  // Streams to a .part file while hashing, then renames only when size and SHA-256 match the pinned model.
  async download(name) {
    const model = this.models[name];
    const target = this.modelPath(name);
    const partial = target + '.part';
    fs.mkdirSync(this.modelDirectory, { recursive: true });
    const response = await this.fetch(MODEL_URL(model.file), { signal: this.abort.signal });
    if (!response.ok || !response.body)
      throw new Error(`The speech model could not be downloaded (HTTP ${response.status}).`);

    const hash = crypto.createHash('sha256');
    const output = fs.createWriteStream(partial);
    let received = 0;
    let shown = -1;
    try {
      for await (const chunk of Readable.fromWeb(response.body)) {
        hash.update(chunk);
        received += chunk.length;
        if (received > model.bytes)
          throw new Error('The speech model download is larger than expected.');
        if (!output.write(chunk))
          await new Promise(resolve => output.once('drain', resolve));
        const percent = Math.floor(received / model.bytes * 100);
        if (name === 'base' && percent !== shown) {
          shown = percent;
          this.progress = { model: name, percent };
          this.event('state');
        }
      }
      await new Promise((resolve, reject) => output.end(error => (error ? reject(error) : resolve())));
      if (received !== model.bytes || hash.digest('hex') !== model.sha256)
        throw new Error('The speech model download did not match its checksum, so it was deleted.');
      fs.renameSync(partial, target);
      return target;
    } catch (error) {
      output.destroy();
      fs.rmSync(partial, { force: true });
      throw error;
    } finally {
      if (this.progress?.model === name) {
        this.progress = null;
        this.event('state');
      }
    }
  }

  async close() {
    this.closed = true;
    this.abort.abort();
    if (this.record)
      this.finish(this.record);
    this.stopWorker();
    await Promise.allSettled([...this.downloads.values()]);
  }
}

module.exports = { Dictation, MODELS, voiced, cleanText, microphoneAllowed };
