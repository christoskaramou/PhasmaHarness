const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const zlib = require('node:zlib');
const { randomBytes, randomUUID } = require('node:crypto');
const { RemoteRunner, remoteKey, originValue } = require('../src/remote.cjs');
const { RemoteSettings } = require('../src/remote-settings.cjs');
const { ArtifactDownloads } = require('../src/artifact-downloads.cjs');
const { inspect } = require('../src/artifacts.cjs');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function fixture(t, invoke = async (method, args) => ({ method, args }), options = {}) {
  const key = randomBytes(32).toString('base64url');
  const remote = new RemoteRunner({ key, invoke, snapshot: () => ({ jobs: ['kept'] }) });
  await remote.listen({ port: 0, ...options });
  t.after(() => remote.close());
  const url = `http://127.0.0.1:${remote.port}`;
  const request = (route, value, token, headers = {}) => new Promise((resolve, reject) => {
    const body = value === undefined ? null : JSON.stringify(value);
    const req = http.request(url + route, {
      method: body === null ? 'GET' : 'POST', signal: AbortSignal.timeout(5000),
      headers: { Origin: remote.origin, Host: new URL(remote.origin).host,
        ...(body === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }),
        ...(token ? { Authorization: 'Bearer ' + token } : {}), ...headers },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers })));
    });
    req.on('error', reject); req.end(body);
  });
  const pair = async () => {
    const response = await request('/api/pair', { key });
    assert.equal(response.status, 200);
    return (await response.json()).token;
  };
  const call = (token, client, method, args = []) => request('/api/call', { client, method, args }, token);
  return { remote, key, url, request, pair, call };
}

async function stream(f, token, client) {
  const abort = new AbortController();
  const response = await fetch(`${f.url}/api/events?client=${client}`, { headers: { Authorization: 'Bearer ' + token }, signal: abort.signal });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  return { close() { abort.abort(); reader.cancel().catch(() => {}); }, async next() {
    for (;;) {
      const end = buffer.indexOf('\n\n');
      if (end >= 0) {
        const event = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (event.startsWith(':')) continue;
        return { type: /^event: (.+)$/m.exec(event)?.[1], value: JSON.parse(/^data: (.+)$/m.exec(event)[1]) };
      }
      let timer;
      try {
        const value = await Promise.race([reader.read(), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Timed out waiting for browser event.')), 3000);
        })]);
        if (value.done) return null;
        buffer += decoder.decode(value.value, { stream: true });
      } finally { clearTimeout(timer); }
    }
  } };
}

async function downloads(t, bytes = Buffer.from('published result')) {
  const f = await fixture(t);
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-remote-download-')));
  const workspace = path.join(directory, 'project'); fs.mkdirSync(workspace);
  const filename = path.join(workspace, 'Αποτέλεσμα.bin'); fs.writeFileSync(filename, bytes);
  const manager = new ArtifactDownloads(path.join(directory, 'credentials.artifact-downloads'));
  const record = await inspect(workspace, path.basename(filename));
  f.remote.artifactDownload = (_args, signal) => manager.prepare(record, signal);
  t.after(async () => {
    await f.remote.close(); await manager.close();
    assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('harness-remote-download-'));
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const token = await f.pair(), client = randomUUID();
  const prepare = async () => {
    const response = await f.call(token, client, 'artifactDownload', [{ action: 'download' }]);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).result;
  };
  return { ...f, manager, record, filename, token, client, prepare };
}

test('browser downloads require authenticated preparation, expose only one immutable file and reject cross-origin or replayed links', async t => {
  const f = await downloads(t);
  assert.equal((await f.call(null, f.client, 'artifactDownload', [{ action: 'download' }])).status, 401);
  assert.equal((await f.call(f.token, f.client, 'artifactAction', [{ action: 'folder' }])).status, 400);
  const link = await f.prepare();
  assert.match(link.url, /^\/api\/download\/[A-Za-z0-9_-]{43}$/);
  assert.ok(link.expires > Date.now() && link.expires <= Date.now() + 60000);
  assert.equal((await f.request(link.url, undefined, null, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await f.request(link.url, undefined, null, { Host: 'attacker.example' })).status, 403);
  assert.equal((await f.request('/api/download/' + randomBytes(32).toString('base64url'))).status, 404);
  assert.equal((await f.request(link.url + '?path=../credentials.phasma-remote')).status, 404);
  fs.writeFileSync(f.filename, 'a later source change');
  const response = await f.request(link.url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'published result');
  assert.equal(response.headers.get('etag'), '"' + f.record.sha256 + '"');
  assert.equal(response.headers.get('content-length'), String(f.record.size));
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.match(response.headers.get('content-disposition'), /attachment;.*filename\*=UTF-8''%/);
  assert.equal((await f.request(link.url)).status, 404, 'a consumed capability cannot be reused');
  for (let i = 0; i < 40 && f.manager.busy; i++) await pause(25);
  assert.equal(f.manager.busy, false);
  assert.equal((await f.request('/api/status')).status, 401, 'the file capability grants no runner access');
});

test('expiry, logout, revocation and Stop release unused download snapshots without disabling future downloads', async t => {
  const f = await downloads(t);
  const expired = await f.prepare();
  f.remote.downloads.get(expired.url.split('/').at(-1)).expires = Date.now() - 1;
  assert.equal((await f.request(expired.url)).status, 410);
  assert.equal(f.manager.busy, false);
  const stopped = await f.prepare();
  await f.remote.stopDownloads();
  assert.equal((await f.request(stopped.url)).status, 404);
  assert.equal(f.manager.busy, false);
  const loggedOut = await f.prepare();
  assert.equal((await f.request('/api/logout', {}, f.token)).status, 200);
  assert.equal((await f.request(loggedOut.url)).status, 404);
  assert.equal(f.manager.busy, false);
  const token = await f.pair();
  const response = await f.call(token, f.client, 'artifactDownload', [{ action: 'download' }]);
  assert.equal(response.status, 200);
  const revoked = (await response.json()).result;
  await f.remote.revokeSessions();
  assert.equal((await f.request(revoked.url)).status, 404);
  assert.equal(f.manager.busy, false);
});

test('Stop and server shutdown cancel preparation, while logout interrupts an already streaming file', async t => {
  const f = await downloads(t, Buffer.alloc(16 * 1024 * 1024, 27));
  const prepare = f.remote.artifactDownload;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  f.remote.artifactDownload = (_args, signal) => new Promise((_, reject) => {
    entered(); signal.addEventListener('abort', () => reject(new Error('Preparation cancelled.')), { once: true });
  });
  const pending = f.call(f.token, f.client, 'artifactDownload', [{ action: 'download' }]);
  await started; await f.remote.stopDownloads();
  assert.equal((await pending).status, 400);
  assert.equal(f.remote.downloads.size, 0);
  f.remote.artifactDownload = prepare;
  const link = await f.prepare();
  let request;
  const response = await new Promise((resolve, reject) => {
    request = http.get(f.url + link.url, res => { res.pause(); res.on('error', () => {}); resolve(res); });
    request.once('error', reject);
  });
  t.after(() => request.destroy());
  assert.equal(response.statusCode, 200);
  assert.equal(f.manager.active.size, 1);
  assert.equal((await f.request(link.url)).status, 404, 'a capability is single-use even before its first stream finishes');
  const closed = new Promise(resolve => response.once('close', resolve));
  await f.request('/api/logout', {}, f.token);
  response.resume(); await closed;
  assert.equal(response.complete, false, 'revocation must end an incomplete transfer');
  assert.equal(f.manager.busy, false);
  const token = await f.pair();
  let closing;
  const shutdownEntered = new Promise(resolve => { closing = resolve; });
  f.remote.artifactDownload = (_args, signal) => new Promise((_, reject) => {
    closing(); signal.addEventListener('abort', () => reject(new Error('Shutdown cancelled.')), { once: true });
  });
  const shutdownRequest = f.call(token, f.client, 'artifactDownload', [{ action: 'download' }]).catch(() => null);
  await shutdownEntered; await f.remote.close(); await shutdownRequest;
  assert.equal(f.remote.downloads.size, 0);
  assert.equal(f.manager.busy, false);
});

test('a disconnected preparation request cancels its snapshot instead of retaining an unreachable download', async t => {
  const f = await downloads(t);
  let entered, cancelled;
  const started = new Promise(resolve => { entered = resolve; });
  const aborted = new Promise(resolve => { cancelled = resolve; });
  f.remote.artifactDownload = (_args, signal) => new Promise((_, reject) => {
    entered();
    signal.addEventListener('abort', () => { cancelled(); reject(new Error('Disconnected.')); }, { once: true });
  });
  const body = JSON.stringify({ client: f.client, method: 'artifactDownload', args: [{ action: 'download' }] });
  const request = http.request(f.url + '/api/call', { method: 'POST', headers: {
    Origin: f.remote.origin, Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
  } });
  request.on('error', () => {}); request.end(body);
  await started; request.destroy();
  await Promise.race([aborted, pause(1000).then(() => { throw new Error('Disconnected preparation was not cancelled.'); })]);
  for (let i = 0; i < 40 && f.remote.downloads.size; i++) await pause(25);
  assert.equal(f.remote.downloads.size, 0);
});

test('desktop remote keys are sealed with OS key protection and plaintext keys migrate', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-remote-sealed-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const flip = value => Buffer.from(String(value)).map(byte => byte ^ 0x5a);
  const encryption = { isEncryptionAvailable: () => true, encryptString: flip, decryptString: bytes => flip(bytes.toString('latin1')).toString() };
  const plain = path.join(directory, 'credentials.phasma-remote'), sealed = path.join(directory, 'credentials.phasma-remote.enc');
  const old = remoteKey(directory);
  const settings = new RemoteSettings(directory, encryption);
  assert.equal(settings.key(), old);
  assert.equal(fs.existsSync(plain), false);
  assert.equal(fs.readFileSync(sealed).includes(old), false);
  assert.equal(new RemoteSettings(directory, encryption).key(), old);
  const replacement = settings.resetKey();
  assert.notEqual(replacement, old);
  assert.equal(settings.key(), replacement);
  assert.equal(fs.existsSync(plain), false);
  assert.equal(fs.readFileSync(sealed).includes(replacement), false);
  assert.throws(() => new RemoteSettings(directory, { isEncryptionAvailable: () => false }).key(), /key protection is unavailable/);
  fs.writeFileSync(sealed, 'garbage');
  assert.throws(() => settings.key(), /could not be decrypted|invalid/);
  assert.match(settings.resetKey(), /^[A-Za-z0-9_-]{43}$/);
});

test('remote keys persist privately, reject linked or malformed secrets and only allow HTTPS or local origins', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-remote-key-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const key = remoteKey(directory), file = path.join(directory, 'credentials.phasma-remote');
  assert.match(key, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(remoteKey(directory), key);
  await assert.rejects(require('../src/artifacts.cjs').inspect(directory, path.basename(file)), /private credential/);
  const replacement = remoteKey(directory, true);
  assert.notEqual(replacement, key);
  assert.equal(remoteKey(directory), replacement);
  fs.linkSync(file, path.join(directory, 'linked'));
  assert.throws(() => remoteKey(directory), /private ordinary file/);
  fs.unlinkSync(path.join(directory, 'linked'));
  fs.writeFileSync(file, 'wrong');
  assert.throws(() => remoteKey(directory), /private ordinary file/);
  assert.equal(originValue('https://runner.example/'), 'https://runner.example');
  assert.equal(originValue('http://127.0.0.1:8788'), 'http://127.0.0.1:8788');
  for (const origin of ['http://example.com', 'https://user:password@example.com', 'https://example.com/path',
    'https://example.com/?key=secret', 'https://example.com/#secret', 'file:///tmp/test'])
    assert.throws(() => originValue(origin));
});

test('remote pairing, tokens, origins and explicit command boundaries protect runner data and desktop-only operations', async t => {
  const calls = [];
  const f = await fixture(t, async (method, args) => { calls.push({ method, args }); return { saved: true }; });
  const client = randomUUID();
  assert.equal((await f.call(null, client, 'bootstrap')).status, 401);
  assert.equal((await f.request('/api/pair', { key: 'wrong' })).status, 401);
  assert.equal((await f.request('/api/pair', { key: f.key }, null, { Origin: 'https://attacker.example' })).status, 403);
  assert.equal((await f.request('/api/pair', { key: f.key }, null, { Origin: '' })).status, 403);
  assert.equal((await f.request('/api/pair', { key: f.key }, null, { Host: 'attacker.example' })).status, 403);
  assert.equal((await f.request('/api/pair', { key: f.key }, null, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await f.request('/api/pair', { key: 'x'.repeat(2048) })).status, 413);
  const paired = await f.request('/api/pair', { key: f.key });
  const token = (await paired.json()).token;
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(paired.headers.get('set-cookie'), null, 'loopback cookies must not expose access to other local ports');
  assert.equal(paired.headers.get('cache-control'), 'no-store');
  assert.equal((await f.request('/api/status', undefined, null, { Cookie: 'phasma_remote=' + token })).status, 401);
  const response = await f.call(token, client, 'send', [{ id: 'chat', text: 'saved request' }]);
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).result, { saved: true });
  assert.deepEqual(calls, [{ method: 'send', args: [{ id: 'chat', text: 'saved request' }] }]);
  for (const method of ['providerKey', 'installProvider', 'voiceStart', 'quitRunner', 'remoteInfo', '__proto__'])
    assert.equal((await f.call(token, client, method)).status, 403, method);
  assert.equal(calls.length, 1);
  assert.equal((await f.request('/api/call', { client, method: 'preview', args: [null, 'text', null], undefinedArgs: [2] }, token)).status, 200);
  assert.deepEqual(calls.at(-1), { method: 'preview', args: [null, 'text', undefined] });
  assert.equal((await f.request('/api/call', { client, method: 'preview', args: ['keep'], undefinedArgs: [0] }, token)).status, 400);
  assert.equal((await f.request('/api/status', undefined, token + 'x')).status, 401);
  const payload = Buffer.from(JSON.stringify({ id: randomUUID(), expires: Date.now() - 1 })).toString('base64url');
  assert.equal((await f.request('/api/status', undefined, `${payload}.${f.remote.sign(payload)}`)).status, 401);
  assert.equal((await f.request('/api/logout', {}, token)).status, 200);
  assert.equal((await f.request('/api/status', undefined, token)).status, 401, 'logout revokes the old token, not only its browser copy');
});

test('public browser assets expose the UI with a network CSP, while source, keys, traversal and escaping links stay private', async t => {
  const f = await fixture(t);
  const redirected = await f.request('/');
  assert.equal(redirected.status, 302);
  assert.equal(redirected.headers.get('location'), '/ui/index.html');
  const response = await f.request('/ui/index.html');
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  const html = await response.text();
  assert.match(html, /remote-api\.js/);
  assert.match(html, /connectors\.js/);
  assert.equal((await f.request('/ui/connectors.js')).status, 200);
  assert.match(html, /connect-src 'self'/);
  assert.doesNotMatch(html, /connect-src 'none'/);
  // Installable on a phone: the page links a manifest, served with its type, and its icons are public UI assets.
  assert.match(html, /<link rel="manifest" href="manifest\.webmanifest">/);
  const manifest = await f.request('/ui/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal(manifest.headers.get('content-type'), 'application/manifest+json');
  const app = await manifest.json();
  assert.deepEqual([app.start_url, app.scope, app.display, app.icons.map(icon => icon.sizes)], ['/ui/index.html', '/ui/', 'standalone', ['192x192', '512x512']]);
  for (const icon of app.icons)
    assert.equal((await f.request('/ui/' + icon.src)).headers.get('content-type'), 'image/png', icon.src);
  assert.ok(!html.includes(f.key));
  for (const resource of ['/src/main.cjs', '/credentials.phasma-remote', '/ui/..%2fsrc/main.cjs', '/node_modules/../package.json',
    '/ui/%5c..%5csrc%5cmain.cjs', '/ui/%00'])
    assert.equal((await f.request(resource)).status, 404, resource);
  assert.equal((await f.request('/node_modules/marked/lib/marked.umd.js')).status, 200);
  const origin = await fixture(t, undefined, { origin: 'https://runner.example' });
  const paired = await origin.request('/api/pair', { key: origin.key });
  assert.equal(paired.status, 200);
  assert.ok((await paired.json()).token);
  assert.equal(paired.headers.get('set-cookie'), null);
  assert.equal((await origin.request('/api/status', undefined, undefined, { Origin: 'https://other.example' })).status, 403);
});

test('independent browser commands and state streams preserve asynchronous Stop and reconnect with current saved state', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async method => {
    if (method === 'send') return held;
    if (method === 'stop') { release({ stopped: true }); return { stopped: true }; }
  });
  const token = await f.pair(), client = randomUUID();
  const events = await stream(f, token, client); t.after(() => events.close());
  assert.deepEqual(await events.next(), { type: 'state', value: { jobs: ['kept'] } });
  const work = f.call(token, client, 'send', [{ id: 'chat', text: 'long job' }]);
  f.remote.broadcast('state', { jobs: ['active'], receipt: 'durable' });
  assert.equal((await events.next()).value.receipt, 'durable');
  assert.equal((await f.call(token, client, 'stop', ['chat'])).status, 200);
  assert.equal((await work).status, 200);
  events.close();
  await pause(20);
  const reconnected = await stream(f, token, client); t.after(() => reconnected.close());
  assert.deepEqual((await reconnected.next()).value.jobs, ['kept']);
});

// 2026-10-26: every update sent the phone the whole fleet uncompressed (65 MB to it within minutes), while the desktop
// window already got only the bots that changed.
test('a browser gets only the bots whose chats changed, and one that falls behind gets the newest state with nothing skipped', async t => {
  const chat = (id, count) => ({ id, status: 'idle', items: Array.from({ length: count }, (_, i) => ({ id: `${id}-${i}`, text: 'x'.repeat(200) })) });
  const bot = (revision, chatId, count) => ({ stateRevision: revision, sessions: [chat(chatId, count)] });
  let current = { agentStates: { a: bot(1, 'a1', 2), b: bot(1, 'b1', 3) }, settings: {} };
  const f = await fixture(t);
  f.remote.snapshot = () => current;
  const token = await f.pair(), client = randomUUID();
  const events = await stream(f, token, client); t.after(() => events.close());
  const first = (await events.next()).value;
  assert.deepEqual([first.agentStates.a.sessions.length, first.agentStates.b.sessions.length], [1, 1], 'the first state is complete');

  current = { agentStates: { a: bot(2, 'a1', 3), b: bot(1, 'b1', 3) }, settings: {} };
  f.remote.broadcast('state', current);
  const next = (await events.next()).value;
  assert.equal(next.agentStates.a.sessions[0].items.length, 3, 'the changed bot comes in full');
  assert.deepEqual([next.agentStates.b.sessionsKept, next.agentStates.b.sessions], [true, undefined], 'the unchanged one is left out');

  // Behind: two states arrive while the connection is full; on drain only the newest is sent, with both changes in it.
  const [entry] = f.remote.clients.values();
  entry.blocked = true;
  f.remote.broadcast('state', { agentStates: { a: bot(3, 'a1', 4), b: bot(1, 'b1', 3) }, settings: {} });
  f.remote.broadcast('state', { agentStates: { a: bot(3, 'a1', 4), b: bot(2, 'b1', 4) }, settings: {} });
  entry.out.emit('drain');
  const caught = (await events.next()).value;
  assert.deepEqual([caught.agentStates.a.sessions?.[0].items.length, caught.agentStates.b.sessions?.[0].items.length], [4, 4],
    'a change made while behind is not lost to the state that replaced it');
});

test('the update stream, replies and UI files are gzip-compressed for a browser that accepts it, and plain otherwise', async t => {
  const f = await fixture(t, async () => ({ history: 'y'.repeat(5000) }));
  const token = await f.pair(), client = randomUUID();
  const raw = await new Promise((resolve, reject) => {
    const req = http.request(`${f.url}/api/events?client=${randomUUID()}`, { headers: { Host: new URL(f.remote.origin).host,
      Authorization: 'Bearer ' + token, 'Accept-Encoding': 'gzip' } }, resolve);
    req.on('error', reject); req.end();
  });
  t.after(() => raw.destroy());
  assert.equal(raw.headers['content-encoding'], 'gzip');
  const decoded = raw.pipe(zlib.createGunzip());
  const text = await new Promise(resolve => {
    let received = '';
    decoded.on('data', chunk => { received += chunk; if (received.includes('\n\n')) resolve(received); });
  });
  assert.match(text, /^event: state\ndata: \{"jobs":\["kept"\]\}\n\n/, 'each event arrives at once, not held for a full gzip block');

  const compressed = await f.request('/api/call', { client, method: 'bootstrap', args: [] }, token, { 'Accept-Encoding': 'gzip' });
  assert.equal(compressed.headers.get('content-encoding'), 'gzip');
  assert.equal(JSON.parse(zlib.gunzipSync(Buffer.from(await compressed.arrayBuffer()))).result.history.length, 5000);
  const plain = await f.call(token, client, 'bootstrap');
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal((await plain.json()).result.history.length, 5000);
  assert.equal((await f.request('/ui/app.js', undefined, null, { 'Accept-Encoding': 'gzip' })).headers.get('content-encoding'), 'gzip');
});

test('remote confirmations belong to their originating authenticated view and disconnect declines pending changes', async t => {
  const f = await fixture(t, async (_method, _args, ask) => ({ accepted: await ask({ title: 'Confirm this view' }) }));
  const aCookie = await f.pair(), bCookie = await f.pair(), a = randomUUID(), b = randomUUID();
  const aStream = await stream(f, aCookie, a), bStream = await stream(f, bCookie, b);
  t.after(() => { aStream.close(); bStream.close(); });
  await aStream.next(); await bStream.next();
  const pending = f.call(aCookie, a, 'clearConversation', ['main']);
  const event = await aStream.next();
  assert.equal(event.type, 'confirmation');
  assert.equal((await f.call(bCookie, b, 'answerConfirmation', [event.value.id, true])).status, 403);
  assert.equal((await f.call(aCookie, a, 'answerConfirmation', [event.value.id, true])).status, 200);
  assert.deepEqual((await (await pending).json()).result, { accepted: true });
  const interrupted = f.call(aCookie, a, 'clearConversation', ['main']);
  await aStream.next(); aStream.close();
  assert.deepEqual((await (await interrupted).json()).result, { accepted: false });
  assert.equal(f.remote.pending.size, 0);
});

test('browser sessions persist before admission, survive restart and stay revoked after logout', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-remote-sessions-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const settings = new RemoteSettings(directory);
  settings.save({ enabled: true, port: 8788, origin: 'https://runner.example' });
  const first = new RemoteRunner({ key: settings.key(), snapshot: () => ({}), invoke: async () => null,
    sessions: settings.value.sessions, saveSessions: sessions => settings.save({ sessions }) });
  await first.listen({ port: 0 }); t.after(() => first.close());
  const response = await fetch(first.origin + '/api/pair', { method: 'POST',
    headers: { Origin: first.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: settings.key() }) });
  const token = (await response.json()).token;
  assert.equal(settings.value.sessions.length, 1);
  await first.close();
  const restored = new RemoteSettings(directory);
  assert.equal(restored.value.enabled, true);
  assert.equal(restored.value.origin, 'https://runner.example');
  const second = new RemoteRunner({ key: restored.key(), snapshot: () => ({}), invoke: async () => null,
    sessions: restored.value.sessions, saveSessions: sessions => restored.save({ sessions }) });
  await second.listen({ port: 0 }); t.after(() => second.close());
  const headers = { Origin: second.origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(second.origin + '/api/status', { headers })).status, 200);
  assert.equal((await fetch(second.origin + '/api/logout', { method: 'POST', headers, body: '{}' })).status, 200);
  assert.deepEqual(new RemoteSettings(directory).value.sessions, []);
  second.saveSessions = () => { throw new Error('fixture write refused'); };
  const rejected = await fetch(second.origin + '/api/pair', { method: 'POST',
    headers: { Origin: second.origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ key: restored.key() }) });
  assert.equal(rejected.status, 400);
  assert.equal(second.sessions.size, 0, 'a failed persistence cannot admit an unrecorded browser session');
  const saved = fs.readFileSync(settings.filename, 'utf8');
  assert.throws(() => restored.save({ origin: 'http://public.example' }));
  assert.equal(fs.readFileSync(settings.filename, 'utf8'), saved);
});

test('remote document bytes keep their type and provider authentication errors cannot invalidate browser access', async t => {
  let received;
  const f = await fixture(t, async (method, args) => {
    if (method === 'readDocument') { received = args[0]; return { text: 'Document proof', format: 'pdf' }; }
    throw Object.assign(new Error('Sign in to the native provider.'), { status: 401 });
  });
  const token = await f.pair(), client = randomUUID(), bytes = Buffer.from('%PDF-1.7\nproof');
  const response = await f.call(token, client, 'readDocument', [{ name: 'proof.pdf', base64: bytes.toString('base64') }]);
  assert.equal(response.status, 200);
  assert.equal(received.name, 'proof.pdf');
  assert.ok(received.bytes instanceof Uint8Array);
  assert.deepEqual(Buffer.from(received.bytes), bytes);
  assert.equal((await f.call(token, client, 'readDocument', [{ name: 'proof.pdf', base64: '#' }])).status, 400);
  assert.equal((await f.call(token, client, 'send', [{ text: 'hello' }])).status, 400);
  assert.equal((await f.request('/api/status', undefined, token)).status, 200);
});

// saved: the session ticket already on this device (local) or kept by the tab before tickets were per device (session).
function browserView(responses, saved = { local: 'saved-ticket', session: null }) {
  const timers = [], elements = [], requests = [];
  const store = initial => {
    const values = new Map(initial ? [['runner-session', initial]] : []);
    return { values, getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
  };
  const localStorage = store(saved.local), sessionStorage = store(saved.session);
  const node = () => {
    const value = { hidden: false, textContent: '', children: {}, setAttribute() {}, append() {}, focus() {}, addEventListener() {} };
    value.querySelector = selector => (value.children[selector] ||= node());
    elements.push(value);
    return value;
  };
  const context = {
    window: { addEventListener() {} }, crypto, TextDecoder, URLSearchParams, AbortController, console, navigator: {},
    document: { body: { classList: { add() {} }, append() {} }, createElement: node },
    localStorage, sessionStorage,
    location: { hash: '', pathname: '/ui/index.html', search: '' }, history: { replaceState() {} },
    setTimeout: callback => timers.push(callback),
    fetch: async url => { requests.push(url); return responses.shift()(); },
  };
  require('node:vm').runInNewContext(fs.readFileSync(path.join(__dirname, '../ui/remote-api.js'), 'utf8'), context);
  const [notice, login] = elements;
  return { timers, requests, notice, login, localStorage, sessionStorage, settle: async () => { for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve)); } };
}

// 2026-10-26: an installed phone app opens in a new context, so a per-tab ticket signed it out on every launch.
test('the browser view keeps its session on the device until the runner refuses it, and moves a tab session over', async () => {
  const reply = (status, body) => () => ({ ok: status < 300, status, json: async () => body });
  const moved = browserView([reply(200, { connected: true })], { local: null, session: 'tab-ticket' });
  await moved.settle();
  assert.deepEqual([moved.localStorage.values.get('runner-session'), moved.sessionStorage.values.has('runner-session')], ['tab-ticket', false]);
  assert.equal(moved.login.hidden, true, 'the moved ticket connects without the key');
  const refused = browserView([reply(401, { error: 'Unknown browser session.' })]);
  await refused.settle();
  assert.equal(refused.localStorage.values.has('runner-session'), false, 'a refused ticket is forgotten on the device');
  assert.equal(refused.login.hidden, false, 'and the connection key is asked for');
});

test('the browser view keeps its session through a network blip and shows runner refusals instead of looping', async () => {
  const reply = (status, body) => () => ({ ok: status < 300, status, json: async () => body });
  const blip = browserView([() => { throw new TypeError('Failed to fetch'); }, reply(200, { connected: true }),
    reply(413, { error: 'This history is too large for browser access.' })]);
  await blip.settle();
  assert.equal(blip.login.hidden, true);
  assert.equal(blip.notice.textContent, 'Disconnected. Reconnecting…');
  assert.equal(blip.timers.length, 1);
  blip.timers.shift()();
  await blip.settle();
  assert.equal(blip.login.hidden, true, 'a network blip must not ask for the connection key again');
  assert.match(blip.notice.textContent, /history is too large.*Reload this page/);
  assert.equal(blip.timers.length, 0, 'a refused stream is not retried in a loop');
  const busy = browserView([reply(200, { connected: true }), reply(503, { error: 'The browser connection is busy.' })]);
  await busy.settle();
  assert.match(busy.notice.textContent, /connection is busy\. Reconnecting/);
  assert.equal(busy.timers.length, 1);
});
