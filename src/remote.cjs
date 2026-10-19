'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pipeline } = require('node:stream/promises');
const { randomBytes, randomUUID, createHmac, timingSafeEqual } = require('node:crypto');

const MAX_BODY = 16 * 1024 * 1024;
const MAX_EVENT = 32 * 1024 * 1024;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const CLIENT_ID = /^[a-f0-9-]{36}$/;
const REMOTE_METHODS = new Set([
  'bootstrap', 'saveAgent', 'renameHub', 'saveGroup', 'deleteAgent', 'workspaceWiki',
  'browseWorkspace', 'settings', 'benchmarkData', 'create', 'permissions', 'load', 'image', 'rename', 'archive',
  'deleteSession', 'findContext', 'cancelContext', 'preview', 'send', 'stop', 'reviseJob', 'reconcileJob', 'jobBudget',
  'stopArtifactRun', 'artifactAction', 'artifactDownload', 'stopDownloads', 'appInfo', 'runnerInfo', 'updateStatus', 'queuedMessage', 'compact',
  'clearConversation', 'acknowledgeTask', 'proposeWiki', 'answer', 'readDocument', 'answerConfirmation',
  'providerConnection', 'renewModels', 'providerModels',
]);

function failure(status, message) { return Object.assign(new Error(message), { status }); }
function same(a, b) {
  const left = Buffer.from(String(a)), right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}
function originValue(value) {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((!local && url.protocol !== 'https:') || !['http:', 'https:'].includes(url.protocol) ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('Use an HTTPS origin, or a loopback HTTP origin for local access.');
  return url.origin;
}

function remoteKey(directory, rotate = false, encryption = null) {
  if (encryption) return sealedKey(directory, rotate, encryption);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'credentials.phasma-remote');
  try { fs.writeFileSync(file, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 43 ||
      (process.platform !== 'win32' && (stat.mode & 0o077))) throw new Error('The remote key must be a private ordinary file.');
  const key = fs.readFileSync(file, 'utf8');
  if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('The saved remote key is invalid.');
  if (rotate) {
    const next = randomBytes(32).toString('base64url'), temporary = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, next, { flag: 'wx', mode: 0o600, flush: true });
      fs.renameSync(temporary, file);
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    return next;
  }
  return key;
}

// Desktop keys are sealed with OS key protection; a plaintext key from an earlier build is migrated and removed.
function sealedKey(directory, rotate, encryption) {
  if (!encryption.isEncryptionAvailable()) throw new Error('OS key protection is unavailable on this host.');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, 'credentials.phasma-remote.enc'), plain = path.join(directory, 'credentials.phasma-remote');
  let key;
  if (!rotate && fs.existsSync(file)) {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new Error('The remote key must be a private ordinary file.');
    try { key = encryption.decryptString(fs.readFileSync(file)); }
    catch { throw new Error('The saved remote key could not be decrypted. Reset the browser link.'); }
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('The saved remote key is invalid.');
  } else {
    key = !rotate && fs.existsSync(plain) ? remoteKey(directory) : randomBytes(32).toString('base64url');
    const temporary = file + '.' + randomUUID() + '.tmp';
    try {
      fs.writeFileSync(temporary, encryption.encryptString(key), { flag: 'wx', mode: 0o600, flush: true });
      fs.renameSync(temporary, file);
    } finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
  }
  fs.rmSync(plain, { force: true });
  return key;
}

async function bodyJSON(req, limit = MAX_BODY) {
  if (String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json')
    throw failure(415, 'Use JSON requests.');
  if (Number(req.headers['content-length']) > limit) throw failure(413, 'The request is too large.');
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw failure(413, 'The request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw failure(400, 'Invalid JSON request.'); }
}

class RemoteRunner {
  constructor({ key, invoke, snapshot, artifactDownload, sessions = [], saveSessions = () => {}, root = path.join(__dirname, '..') }) {
    if (typeof key !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw new Error('A private 32-byte remote key is required.');
    this.key = key; this.invoke = invoke; this.snapshot = snapshot; this.root = root;
    this.artifactDownload = artifactDownload; this.downloads = new Map();
    if (!Array.isArray(sessions) || sessions.length > 64 || sessions.some(row => !Array.isArray(row) ||
        row.length !== 2 || typeof row[0] !== 'string' || !CLIENT_ID.test(row[0]) || !Number.isFinite(row[1])))
      throw new Error('The saved browser sessions are invalid.');
    this.sessions = new Map(sessions); this.saveSessions = saveSessions;
    this.clients = new Map(); this.pending = new Map(); this.server = null;
  }

  async listen({ port = 8788, origin = null } = {}) {
    if (this.server) throw new Error('Browser access is already running.');
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Choose a valid browser-access port.');
    this.origin = origin ? originValue(origin) : null;
    const server = http.createServer((req, res) => {
      this.route(req, res).catch(error => {
        if (res.headersSent) { res.destroy(); return; }
        this.json(res, error.status || 400, { error: String(error.message || 'Request failed.').slice(0, 400) });
      });
    });
    server.requestTimeout = 15000; server.headersTimeout = 10000; server.keepAliveTimeout = 5000;
    this.server = server;
    try {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
      this.port = server.address().port;
      this.origin ||= `http://127.0.0.1:${this.port}`;
      return this.info();
    } catch (error) { this.server = null; server.close(); throw error; }
  }

  info() { return { running: !!this.server, origin: this.origin || null, port: this.port || null }; }
  connectionURL() { return this.server ? `${this.origin}/ui/index.html#key=${this.key}` : null; }

  headers(res) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
  }

  json(res, status, value) {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > MAX_EVENT) throw failure(413, 'This response is too large for browser access.');
    this.headers(res); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(body);
  }

  sign(value) { return createHmac('sha256', this.key).update(value).digest('base64url'); }
  session(req) {
    // Cookies cross loopback ports; an explicit bearer keeps access inside this browser origin.
    const authorization = String(req.headers.authorization || '');
    const value = authorization.startsWith('Bearer ') ? authorization.slice(7) : null;
    if (!value || value.length > 1024) throw failure(401, 'Connect to this runner first.');
    const [payload, signature, extra] = value.split('.');
    if (extra !== undefined || !signature || !same(this.sign(payload), signature)) throw failure(401, 'Reconnect to this runner.');
    let session;
    try { session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch {}
    if (!session || typeof session.id !== 'string' || !CLIENT_ID.test(session.id) ||
        !Number.isFinite(session.expires) || session.expires <= Date.now() || this.sessions.get(session.id) !== session.expires)
      throw failure(401, 'Reconnect to this runner.');
    return session;
  }

  async pair(req, res) {
    const value = await bodyJSON(req, 1024);
    if (typeof value?.key !== 'string' || !same(value.key, this.key)) throw failure(401, 'The connection key is incorrect.');
    const session = { id: randomUUID(), expires: Date.now() + SESSION_MS };
    const sessions = new Map([...this.sessions].filter(([, expires]) => expires > Date.now()));
    if (sessions.size >= 64) throw failure(429, 'Disconnect old browser sessions on the runner before connecting another device.');
    sessions.set(session.id, session.expires); this.commitSessions(sessions);
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
    this.json(res, 200, { connected: true, token: payload + '.' + this.sign(payload) });
  }

  commitSessions(sessions) { this.saveSessions([...sessions]); this.sessions = sessions; }

  async revokeSessions() {
    this.commitSessions(new Map());
    for (const [key, client] of this.clients) this.disconnect(key, client);
    await this.stopDownloads();
  }

  async route(req, res) {
    this.headers(res);
    if (req.headers.host !== new URL(this.origin).host) throw failure(403, 'Unexpected runner address.');
    if (req.headers.origin && req.headers.origin !== this.origin) throw failure(403, 'Use the runner’s own address.');
    const url = new URL(req.url, this.origin);
    if (!url.pathname.startsWith('/api/')) {
      if (!['GET', 'HEAD'].includes(req.method)) throw failure(405, 'Use GET.');
      return this.asset(req, res, url);
    }
    if (req.method === 'POST' && req.headers.origin !== this.origin) throw failure(403, 'An origin is required.');
    if (url.pathname === '/api/pair' && req.method === 'POST') return this.pair(req, res);
    if (url.pathname.startsWith('/api/download/') && req.method === 'GET') return this.download(req, res, url);
    const session = this.session(req);
    if (url.pathname === '/api/status' && req.method === 'GET') return this.json(res, 200, { connected: true });
    if (url.pathname === '/api/events' && req.method === 'GET') return this.events(req, res, session, url.searchParams.get('client'));
    if (url.pathname === '/api/logout' && req.method === 'POST') {
      await bodyJSON(req, 1024);
      const sessions = new Map(this.sessions); sessions.delete(session.id); this.commitSessions(sessions);
      for (const [key, client] of this.clients) if (key.startsWith(session.id + '/')) this.disconnect(key, client);
      await this.stopDownloads(session.id);
      return this.json(res, 200, { connected: false });
    }
    if (url.pathname !== '/api/call' || req.method !== 'POST') throw failure(404, 'Unknown runner request.');
    return this.call(req, res, session);
  }

  async call(req, res, session) {
    const value = await bodyJSON(req);
    if (!value || typeof value.client !== 'string' || !CLIENT_ID.test(value.client) || typeof value.method !== 'string' ||
        !Array.isArray(value.args) || value.args.length > 16) throw failure(400, 'Invalid runner command.');
    const missing = value.undefinedArgs || [];
    if (!Array.isArray(missing) || missing.length > value.args.length || new Set(missing).size !== missing.length ||
        missing.some(index => !Number.isInteger(index) || index < 0 || index >= value.args.length || value.args[index] !== null))
      throw failure(400, 'Invalid optional arguments.');
    for (const index of missing) value.args[index] = undefined;
    if (!REMOTE_METHODS.has(value.method)) throw failure(403, 'Use the runner host for this action.');
    if (value.method === 'artifactDownload') return this.prepareDownload(req, res, session, value.args);
    if (value.method === 'artifactAction' && value.args[0]?.action !== 'run')
      throw failure(400, 'Download the artifact to open it on this device.');
    const client = session.id + '/' + value.client;
    if (value.method === 'answerConfirmation') {
      this.answer(client, ...value.args); return this.json(res, 200, { result: null });
    }
    if (value.method === 'readDocument') {
      const document = value.args[0];
      if (value.args.length !== 1 || typeof document?.name !== 'string' || typeof document.base64 !== 'string' ||
          document.base64.length > 14 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(document.base64))
        throw failure(400, 'Use a PDF or DOCX document under 10 MB.');
      value.args = [{ name: document.name, bytes: new Uint8Array(Buffer.from(document.base64, 'base64')) }];
    }
    let result;
    try { result = await this.invoke(value.method, value.args, options => this.ask(client, options)); }
    catch (error) { throw failure(400, error.message || 'Runner command failed.'); }
    return this.json(res, 200, { result: result ?? null });
  }

  async prepareDownload(req, res, session, args) {
    if (!this.artifactDownload || args.length !== 1) throw failure(400, 'Choose a published artifact.');
    if (this.closing || this.stoppingDownloads) throw failure(409, 'Downloads are stopping. Try again shortly.');
    const id = randomBytes(32).toString('base64url');
    const job = { session, abort: new AbortController() };
    job.prepared = new Promise(resolve => { job.resolve = resolve; });
    this.downloads.set(id, job); job.id = id;
    const abort = () => { if (!res.writableEnded) job.abort.abort(); };
    res.once('close', abort);
    let published = false;
    try {
      job.snapshot = await this.artifactDownload(args[0], job.abort.signal);
      if (job.abort.signal.aborted || this.closing || !this.validDownloadSession(job)) throw failure(410, 'Download cancelled.');
      const expires = Math.min(Date.now() + 60000, session.expires);
      job.timer = setTimeout(() => this.releaseDownload(job).catch(() => {}), Math.max(0, expires - Date.now()));
      job.timer.unref(); job.expires = expires;
      this.json(res, 200, { result: { url: '/api/download/' + id, filename: job.snapshot.filename, expires } });
      published = true;
    } finally {
      res.off('close', abort); job.resolve();
      if (!published) await this.releaseDownload(job);
    }
  }

  validDownloadSession(job) {
    return job.session.expires > Date.now() && this.sessions.get(job.session.id) === job.session.expires;
  }

  async download(req, res, url) {
    const id = url.pathname.slice('/api/download/'.length);
    const job = /^[A-Za-z0-9_-]{43}$/.test(id) && !url.search ? this.downloads.get(id) : null;
    if (!job || !job.snapshot || job.claimed) throw failure(404, 'This download link is unavailable. Request it again.');
    if (job.expires <= Date.now() || job.snapshot.closed || !this.validDownloadSession(job)) {
      await this.releaseDownload(job); throw failure(410, 'This download expired. Request it again.');
    }
    job.claimed = true; job.response = res; clearTimeout(job.timer);
    // A capability exposes one immutable file once; it never grants runner or filesystem access.
    job.timer = setTimeout(() => this.releaseDownload(job).catch(() => {}), Math.min(30 * 60000, job.session.expires - Date.now()));
    job.timer.unref(); res.setTimeout(60000, () => res.destroy());
    const filename = Buffer.from(job.snapshot.filename).toString('utf8');
    const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
    try {
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': job.snapshot.size,
        'Content-Disposition': `attachment; filename="artifact"; filename*=UTF-8''${encoded}`,
        ETag: '"' + job.snapshot.sha256 + '"' });
      await pipeline(job.snapshot.stream(), res);
    } finally { await this.releaseDownload(job); }
  }

  releaseDownload(job) {
    if (!job.releasing) job.releasing = (async () => {
      clearTimeout(job.timer);
      if (job.response && !job.response.writableFinished) job.response.destroy();
      try { await job.snapshot?.close(); }
      finally { this.downloads.delete(job.id); }
    })();
    return job.releasing;
  }

  async stopDownloads(sessionId) {
    if (!sessionId) this.stoppingDownloads = (this.stoppingDownloads || 0) + 1;
    try {
      const jobs = [...this.downloads.values()].filter(job => !sessionId || job.session.id === sessionId);
      for (const job of jobs) { job.abort.abort(); job.response?.destroy(); }
      const results = await Promise.allSettled(jobs.map(async job => { await job.prepared; await this.releaseDownload(job); }));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
    } finally { if (!sessionId) this.stoppingDownloads--; }
  }

  events(req, res, session, id) {
    if (!CLIENT_ID.test(id || '')) throw failure(400, 'Choose a browser session.');
    const key = session.id + '/' + id;
    const previous = this.clients.get(key);
    if (!previous && this.clients.size >= 8) throw failure(429, 'Too many connected browser views.');
    if (previous) this.disconnect(key, previous);
    const initial = this.event('state', this.snapshot());
    const client = { key, res, expires: session.expires, blocked: false, latest: new Map() };
    this.clients.set(key, client);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.setTimeout(0);
    client.timer = setInterval(() => {
      if (Date.now() >= client.expires) this.disconnect(key, client);
      else if (!client.blocked) client.blocked = !res.write(': heartbeat\n\n');
    }, 20000);
    client.timer.unref();
    res.on('drain', () => {
      client.blocked = false;
      for (const [type, event] of client.latest) {
        if (client.blocked) break;
        client.latest.delete(type); this.write(client, event, type);
      }
    });
    res.once('close', () => this.disconnect(key, client));
    this.write(client, initial, 'state');
  }

  event(type, value) {
    const data = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
    if (Buffer.byteLength(data) > MAX_EVENT) throw failure(413, 'This history is too large for browser access. Use the desktop to archive older conversations.');
    return data;
  }

  write(client, data, replaceable = null) {
    if (client.res.destroyed) return;
    if (Date.now() >= client.expires) { this.disconnect(client.key, client); return; }
    if (client.blocked) {
      if (replaceable) { client.latest.set(replaceable, data); return; }
      throw failure(503, 'The browser connection is busy. Retry after it reconnects.');
    }
    client.blocked = !client.res.write(data);
  }

  broadcast(type, value) {
    if (!['state', 'update'].includes(type)) throw new Error('Only runner state and update snapshots may be broadcast.');
    if (!this.clients.size) return;
    let event;
    try { event = this.event(type, value); }
    catch { for (const [key, client] of this.clients) this.disconnect(key, client); return; }
    for (const client of this.clients.values()) this.write(client, event, type);
  }

  ask(client, options) {
    const stream = this.clients.get(client);
    if (!stream || this.pending.size >= 32) return Promise.resolve(false);
    return new Promise(resolve => {
      const id = randomUUID();
      const timer = setTimeout(() => this.settle(id, false), 120000);
      timer.unref();
      this.pending.set(id, { client, timer, resolve });
      try { this.write(stream, this.event('confirmation', { ...options, id })); }
      catch { this.settle(id, false); }
    });
  }

  answer(client, id, accepted) {
    if (typeof id !== 'string' || typeof accepted !== 'boolean') throw failure(400, 'Invalid confirmation.');
    const pending = this.pending.get(id);
    if (!pending || pending.client !== client) throw failure(403, 'This confirmation belongs to another browser request.');
    this.settle(id, accepted);
  }

  settle(id, accepted) {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id); clearTimeout(pending.timer); pending.resolve(accepted);
  }

  disconnect(key, client) {
    if (this.clients.get(key) !== client) return;
    this.clients.delete(key); clearInterval(client.timer); client.res.end();
    for (const [id, pending] of this.pending) if (pending.client === key) this.settle(id, false);
  }

  async asset(req, res, url) {
    let pathname;
    try { pathname = decodeURIComponent(url.pathname); } catch { throw failure(400, 'Invalid path.'); }
    if (pathname === '/') { res.writeHead(302, { Location: '/ui/index.html' }); res.end(); return; }
    const vendors = new Set(['/node_modules/marked/lib/marked.umd.js', '/node_modules/dompurify/dist/purify.min.js',
      '/node_modules/katex/dist/katex.min.js', '/node_modules/katex/dist/katex.min.css']);
    const ui = pathname.startsWith('/ui/');
    const fonts = /^\/node_modules\/katex\/dist\/fonts\/[A-Za-z0-9_.-]+\.(woff2?|ttf)$/.test(pathname);
    if ((!ui && !fonts && !vendors.has(pathname)) || pathname.includes('\\') || pathname.includes('\0')) throw failure(404, 'Unknown asset.');
    const base = fs.realpathSync(path.join(this.root, ui ? 'ui' : 'node_modules'));
    let filename;
    try { filename = fs.realpathSync(path.join(this.root, pathname.slice(1))); } catch { throw failure(404, 'Unknown asset.'); }
    if (!filename.startsWith(base + path.sep) || !fs.statSync(filename).isFile()) throw failure(404, 'Unknown asset.');
    const extension = path.extname(filename).toLowerCase();
    const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
      '.png': 'image/png', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf' }[extension];
    if (!mime) throw failure(404, 'Unknown asset.');
    let body = await fs.promises.readFile(filename);
    if (ui && path.basename(filename) === 'index.html') body = Buffer.from(body.toString('utf8')
      .replace("connect-src 'none'", "connect-src 'self'")
      .replace('<script defer src="dialogs.js"></script>', '<script defer src="remote-api.js"></script>\n  <script defer src="dialogs.js"></script>'));
    res.writeHead(200, { 'Content-Type': mime + (['.html', '.js', '.css'].includes(extension) ? '; charset=utf-8' : ''),
      'Content-Length': body.length });
    res.end(req.method === 'HEAD' ? undefined : body);
  }

  async close() {
    this.closing = true;
    for (const [key, client] of this.clients) this.disconnect(key, client);
    for (const id of this.pending.keys()) this.settle(id, false);
    const server = this.server;
    this.server = null;
    if (server) server.closeAllConnections();
    const stopped = server ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
    await Promise.all([this.stopDownloads(), stopped]);
  }
}

module.exports = { RemoteRunner, remoteKey, originValue, REMOTE_METHODS };
