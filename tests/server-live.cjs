const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { renderService, quote } = require('../tools/linux-service.cjs');
const { serviceUnit } = require('../src/runner-linux.cjs');
const { unzipSync } = require('fflate');
const run = promisify(execFile), pause = ms => new Promise(resolve => setTimeout(resolve, ms));

if (process.platform !== 'linux' || process.getuid() === 0) { console.log('Headless acceptance requires a regular Linux user.'); process.exit(77); }
(async () => {
  try { await run('/usr/bin/systemctl', ['--user', 'show', '--property=Version'], { timeout: 5000 }); }
  catch { console.log('Headless acceptance requires a user systemd manager.'); process.exitCode = 77; return; }
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-server-live-')));
  const project = path.join(directory, 'source $literal% path'), data = path.join(directory, 'data $literal% path');
  fs.mkdirSync(project); fs.mkdirSync(data, { mode: 0o700 });
  const unit = serviceUnit(data), filename = path.join(directory, unit);
  let linked = false, success = false;
  try {
    const source = path.resolve(__dirname, '..');
    for (const name of ['src', 'ui', 'benchmarks', 'skills']) fs.cpSync(path.join(source, name), path.join(project, name), { recursive: true });
    for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(source, name), path.join(project, name));
    fs.mkdirSync(path.join(project, 'tools'));
    for (const name of ['fetch.cjs', 'manifest.json']) fs.copyFileSync(path.join(source, 'tools', name), path.join(project, 'tools', name));
    fs.mkdirSync(path.join(project, 'tests', 'fixtures'), { recursive: true });
    for (const name of ['server-native.cjs', 'documents.cjs', 'protected-pdf.base64'])
      fs.copyFileSync(path.join(__dirname, 'fixtures', name), path.join(project, 'tests', 'fixtures', name));
    for (const name of ['documents.test.cjs', 'attachments.test.cjs'])
      fs.copyFileSync(path.join(__dirname, name), path.join(project, 'tests', name));
    const npm = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
    await run(process.execPath, [npm, 'ci', '--omit=dev', '--no-audit', '--no-fund'],
      { cwd: project, timeout: 120000, maxBuffer: 32768 });
    for (const name of ['rtk', 'rg']) await run(path.join(project, 'tools', 'bin', name), ['--version'], { timeout: 5000 });
    await run(process.execPath, ['--test', 'tests/documents.test.cjs', 'tests/attachments.test.cjs'],
      { cwd: project, timeout: 20000, maxBuffer: 32768 });
    const entry = path.join(project, 'fixture-server.cjs');
    fs.writeFileSync(entry, "require('./tests/fixtures/server-native.cjs').install(require('./src/controller.cjs').Controller);\n" +
      "require('./src/server.cjs').main(process.argv.slice(2)).catch(error=>{console.error(error.stack);process.exitCode=1;});\n");
    const socket = net.createServer(); await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = socket.address().port; await new Promise(resolve => socket.close(resolve));
    const origin = `http://127.0.0.1:${port}`;
    const body = renderService({ data, port, root: project }).replace(quote(path.join(project, 'src/server.cjs')), quote(entry))
      .replace('[Unit]\n', '[Unit]\nStartLimitIntervalSec=1h\nStartLimitBurst=2\n')
      .replace('[Service]\n', '[Service]\nRuntimeMaxSec=60s\n');
    fs.writeFileSync(filename, body, { mode: 0o600 });
    await run('/usr/bin/systemd-analyze', ['--user', 'verify', filename], { timeout: 10000, maxBuffer: 16384 });
    await run('/usr/bin/systemctl', ['--user', 'link', '--runtime', filename], { timeout: 10000 }); linked = true;
    await run('/usr/bin/systemctl', ['--user', 'start', unit], { timeout: 10000 });
    const until = async predicate => {
      for (let index = 0; index < 200; index++) { if (await predicate()) return; await pause(100); }
      throw new Error('Headless server did not reach the expected state.');
    };
    const ready = async () => {
      try { return (await fetch(origin + '/api/status', { signal: AbortSignal.timeout(1000) })).status === 401; }
      catch { return false; }
    };
    await until(ready);
    const key = fs.readFileSync(path.join(data, 'credentials.phasma-remote'), 'utf8');
    const linkedURL = await run(process.execPath, [path.join(project, 'src/server.cjs'), '--data', data, '--connection-link'], { timeout: 5000 });
    assert.equal(linkedURL.stdout.trim(), `${origin}/ui/index.html#key=${key}`);
    const post = (route, value, token) => fetch(origin + route, { method: 'POST', signal: AbortSignal.timeout(15000),
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(value) });
    const paired = await post('/api/pair', { key }); assert.equal(paired.status, 200);
    const token = (await paired.json()).token, client = randomUUID();
    const call = async (method, args = []) => {
      const response = await post('/api/call', { client, method, args }, token), result = await response.json();
      assert.equal(response.status, 200, result.error); return result.result;
    };
    const state = await call('bootstrap'), session = state.sessions.find(chat => chat.items.some(item => item.id === 'artifact-fixture-export'));
    assert.ok(session); assert.equal(session.workspace, path.join(data, 'projects'));
    assert.equal((await call('providerConnection', ['native:muse', 'connect'])).nativeCLIs['native:muse'].enabled, true);
    assert.equal((await call('providerModels', ['native:muse']))[0].id, 'muse-fixture');
    assert.equal((await call('renewModels')).nativeCLIs['native:muse'].enabled, true);
    const disconnected = await call('providerConnection', ['native:muse', 'disconnect']);
    assert.equal(disconnected.nativeCLIs['native:muse'].enabled, false);
    assert.equal(disconnected.nativeCLIs['native:muse'].loggedIn, true);
    const unavailable = await post('/api/call', { client, method: 'providerConnection', args: ['native:deepseek', 'connect'] }, token);
    assert.notEqual(unavailable.status, 200); assert.match((await unavailable.json()).error, /runner host/);
    assert.ok((await (await fetch(origin + '/ui/index.html', { signal: AbortSignal.timeout(5000) })).text()).includes('remote-api.js'));
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAABHNCSVQICAgIfAhkiAAAAAFzUkdCAK7OHOkAAAAUSURBVAiZY2RgYPjPwMDAwMQABQAOKAEDtjjK0wAAAABJRU5ErkJggg==';
    const started = Date.now();
    await call('send', [{ id: session.id, clientId: randomUUID(), text: 'Held headless request', images: [image], mode: 'terra-light', task: 'off' }]);
    assert.ok(Date.now() - started < 1500, 'image validation and saved submission must not wait for the held model turn');
    assert.equal((await call('bootstrap')).busy, session.id);
    await call('stop', [session.id]);
    await until(async () => !(await call('bootstrap')).busy);
    const pdf = require('./fixtures/documents.cjs').pdf('Headless PDF proof');
    assert.match((await call('readDocument', [{ name: 'proof.pdf', base64: Buffer.from(pdf).toString('base64') }])).text, /Headless PDF proof/);
    const artifact = await call('artifactDownload', [{ action: 'download', sessionId: session.id, receiptId: 'artifact-fixture-export', artifactId: 'export', expectedVersion: 1 }]);
    const download = await fetch(origin + artifact.url, { signal: AbortSignal.timeout(15000) });
    assert.equal(download.status, 200);
    const files = unzipSync(new Uint8Array(await download.arrayBuffer()));
    assert.equal(Buffer.from(files['assets/data.txt']).toString(), 'required assets');
    const invocation = (await run('/usr/bin/systemctl', ['--user', 'show', unit, '--property=InvocationID', '--value'], { timeout: 5000 })).stdout.trim();
    await run('/usr/bin/systemctl', ['--user', 'kill', '--kill-whom=main', '--signal=SIGKILL', unit], { timeout: 5000 });
    await until(async () => {
      const next = (await run('/usr/bin/systemctl', ['--user', 'show', unit, '--property=InvocationID', '--value'], { timeout: 5000 })).stdout.trim();
      return next && next !== invocation && await ready();
    });
    const resumed = await call('bootstrap');
    assert.equal(resumed.sessions.find(chat => chat.id === session.id).items.filter(item => item.type === 'userMessage' &&
      item.content?.some(part => part.type === 'text' && part.text === 'Held headless request')).length, 1);
    await run('/usr/bin/systemctl', ['--user', 'stop', unit], { timeout: 30000 });
    assert.equal(await ready(), false);
    success = true;
    console.log('Headless service passed: production dependencies, literal paths, no display, authentication, owned image/PDF parsing, asynchronous chat/Stop, ZIP download, persisted session and forced restart.');
  } finally {
    if (!success && linked) {
      const log = await run('/usr/bin/journalctl', ['--user', '-u', unit, '-n', '35', '--no-pager'], { timeout: 5000 }).catch(() => ({ stdout: '' }));
      console.error(log.stdout);
    }
    if (linked) {
      await run('/usr/bin/systemctl', ['--user', 'stop', unit], { timeout: 30000 });
      await run('/usr/bin/systemctl', ['--user', 'disable', '--runtime', unit], { timeout: 10000 });
    }
    assert.equal(path.dirname(directory), fs.realpathSync(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('harness-server-live-'));
    fs.rmSync(directory, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
