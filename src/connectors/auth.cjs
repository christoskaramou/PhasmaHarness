const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { once } = require('node:events');
const { atomicWrite } = require('../session-store.cjs');

function webUrl(value) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || (url.protocol !== 'https:' &&
      !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
    throw new Error('Use an HTTPS server URL, or HTTP on localhost, without embedded credentials.');
  return url;
}

function identity(record) {
  return createHash('sha256').update(JSON.stringify([record.transport, record.url, record.command, record.args, record.cwd, record.auth, record.clientId])).digest('hex').slice(0, 24);
}

class ConnectorCredentials {
  constructor(directory, encryption) { Object.assign(this, { directory, encryption }); }
  file(record) { return path.join(this.directory, record.id + '-' + identity(record) + '.enc'); }
  has(record) { return fs.existsSync(this.file(record)); }
  read(record) {
    if (!this.has(record)) return {};
    if (!this.encryption?.isEncryptionAvailable()) throw new Error('OS key protection is unavailable on this host.');
    try {
      const value = JSON.parse(this.encryption.decryptString(Buffer.from(fs.readFileSync(this.file(record), 'utf8'), 'base64')));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid credentials.');
      return value;
    }
    catch { throw new Error('Connector credentials could not be decrypted. Enter them again.'); }
  }
  write(record, secrets) {
    if (!this.encryption?.isEncryptionAvailable()) throw new Error('OS key protection is unavailable on this host.');
    const json = JSON.stringify(secrets);
    if (Buffer.byteLength(json) > 2 * 1024 * 1024) throw new Error('Connector credentials exceed 2 MB.');
    atomicWrite(this.file(record), this.encryption.encryptString(json).toString('base64'));
  }
  remove(record) {
    if (!fs.existsSync(this.directory)) return;
    for (const filename of fs.readdirSync(this.directory))
      if (filename.startsWith(record.id + '-') && /^[a-f0-9-]+\.enc$/.test(filename)) fs.rmSync(path.join(this.directory, filename), { force: true });
  }
}

// One browser flow per connector. Persistent tokens are bound to its endpoint and authorization server.
class ConnectorOAuth {
  constructor(record, credentials, changed) {
    Object.assign(this, { record, credentials, changed }); this.lastState = null; this.url = null;
    this.redirectUrl = this.data().redirectUrl || 'http://127.0.0.1/mcp/oauth';
  }
  get clientMetadata() { return { client_name: 'Phasma Harness', redirect_uris: [this.redirectUrl], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none', application_type: 'native' }; }
  data() { return this.credentials.read(this.record).oauth || {}; }
  update(fn) { if (this.revoked) throw new Error('Sign-in was cancelled.'); const secrets = this.credentials.read(this.record); secrets.oauth ||= {}; fn(secrets.oauth); this.credentials.write(this.record, secrets); }
  clientInformation(ctx) { return this.record.clientId ? { client_id: this.record.clientId } : ctx && this.data().clients?.[ctx.issuer]; }
  saveClientInformation(value, ctx) { if (ctx) this.update(data => { data.clients ||= {}; data.clients[ctx.issuer] = value; }); }
  tokens(ctx) { const data = this.data(); return data.tokens?.[ctx?.issuer || data.issuer]; }
  saveTokens(value, ctx) { if (!ctx?.issuer) throw new Error('Authorization server identity is missing.'); this.update(data => { data.tokens ||= {}; data.tokens[ctx.issuer] = value; data.issuer = ctx.issuer; }); }
  saveCodeVerifier(value) { this.verifier = value; }
  codeVerifier() { if (!this.verifier) throw new Error('Sign-in expired. Start again.'); return this.verifier; }
  state() { return this.lastState = randomBytes(32).toString('hex'); }
  saveDiscoveryState(value) { this.discovery = value; }
  discoveryState() { return this.discovery; }
  redirectToAuthorization(value) {
    if (!this.server) throw new Error('Sign in from Settings > Connectors first.');
    this.url = webUrl(value).href; this.changed();
  }
  invalidateCredentials(scope) {
    if (scope === 'all') this.update(data => { delete data.tokens; delete data.clients; });
    if (scope === 'tokens' || scope === 'client') this.update(data => { delete data[scope === 'tokens' ? 'tokens' : 'clients']; });
    if (scope === 'all' || scope === 'verifier') this.verifier = null;
    if (scope === 'all' || scope === 'discovery') this.discovery = null;
  }
  async listen(finish) {
    this.close();
    this.server = http.createServer(async (req, res) => {
      const url = new URL(req.url, this.redirectUrl), supplied = Buffer.from(url.searchParams.get('state') || ''), expected = Buffer.from(this.lastState || '');
      if (req.method !== 'GET' || req.headers.host !== new URL(this.redirectUrl).host || url.pathname !== '/mcp/oauth' || !expected.length || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
        res.writeHead(400).end('Invalid sign-in callback.'); return;
      }
      this.lastState = null;
      try {
        if (url.searchParams.has('error')) throw new Error('Sign-in was declined.');
        if (!url.searchParams.get('code')) throw new Error('Authorization code is missing.');
        await finish(url.searchParams);
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Connected. You can return to Phasma Harness.');
      } catch { res.writeHead(400).end('Sign-in failed. Return to Harness and try again.'); }
      finally { this.close(); this.changed(); }
    });
    try {
      this.server.listen(0, '127.0.0.1'); await once(this.server, 'listening');
      this.redirectUrl = `http://127.0.0.1:${this.server.address().port}/mcp/oauth`;
      this.update(data => { if (data.redirectUrl !== this.redirectUrl) delete data.clients; data.redirectUrl = this.redirectUrl; });
    } catch (error) { this.close(); throw error; }
    this.timer = setTimeout(() => { this.close(); this.changed(); }, 5 * 60 * 1000); this.timer.unref();
  }
  close() { clearTimeout(this.timer); this.server?.close(); this.server = null; this.url = null; this.lastState = null; }
}
module.exports = { webUrl, identity, ConnectorCredentials, ConnectorOAuth };
