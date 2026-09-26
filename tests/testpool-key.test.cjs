'use strict';
// Jev key lookup: JEV_API_KEY, then JEV_API_KEY_FILE, then Windows Credential Manager. Run: node --test tests/testpool-key.test.cjs
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const tp = require('../skills/test-pool/scripts/testpool.cjs');

// Temporary folders made by these tests are removed at the end.
const made = [];
test.after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); });
const decode = b64 => Buffer.from(b64, 'base64').toString('utf16le');
const tmpKeyFile = text => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jevkey-'));
  made.push(dir);
  const file = path.join(dir, 'key.txt');
  fs.writeFileSync(file, text);
  return file;
};

test('JEV_API_KEY wins and the vault is not queried', () => {
  let vaultCalls = 0;
  const r = tp.jevKeySource({ JEV_API_KEY: ' k-env ', JEV_API_KEY_FILE: tmpKeyFile('k-file') }, () => { vaultCalls++; return 'k-vault'; });
  assert.deepEqual(r, { key: 'k-env', source: 'JEV_API_KEY' });
  assert.equal(vaultCalls, 0);
});

test('JEV_API_KEY_FILE is used when the variable is missing', () => {
  const r = tp.jevKeySource({ JEV_API_KEY: '  ', JEV_API_KEY_FILE: tmpKeyFile('k-file\n') }, () => 'k-vault');
  assert.deepEqual(r, { key: 'k-file', source: 'JEV_API_KEY_FILE' });
});

test('Credential Manager is used when neither variable gives a key', () => {
  assert.deepEqual(tp.jevKeySource({}, () => 'k-vault'), { key: 'k-vault', source: 'Windows Credential Manager' });
  assert.deepEqual(tp.jevKeySource({ JEV_API_KEY_FILE: tmpKeyFile('   ') }, () => 'k-vault').source, 'Windows Credential Manager');
  assert.deepEqual(tp.jevKeySource({ JEV_API_KEY_FILE: path.join(os.tmpdir(), 'no-such-jev-key') }, () => 'k-vault').source, 'Windows Credential Manager');
});

test('no key anywhere gives null, and jevKey mirrors it', () => {
  assert.deepEqual(tp.jevKeySource({}, () => null), { key: null, source: null });
  assert.equal(tp.jevKey({}, () => null), null);
  assert.equal(tp.jevKey({}, () => 'k-vault'), 'k-vault');
});

test('vaultKey reads the jev/api-key entry through Windows PowerShell and trims it', () => {
  let call;
  const key = tp.vaultKey({ platform: 'win32', run: (cmd, args, opts) => { call = { cmd, args, opts }; return { status: 0, stdout: 'k-vault\r\n' }; } });
  assert.equal(key, 'k-vault');
  assert.equal(call.cmd, 'powershell.exe');
  assert.ok(call.args.includes('-NonInteractive') && call.args.includes('-NoProfile'));
  assert.equal(call.args.at(-2), '-EncodedCommand');
  const script = decode(call.args.at(-1));
  assert.equal(script, tp.VAULT_READ);
  assert.match(script, /Windows\.Security\.Credentials\.PasswordVault/);
  assert.match(script, /Retrieve\('jev', 'api-key'\)/);
  assert.ok(call.opts.timeout > 0 && call.opts.windowsHide);
});

test('vaultKey returns null off Windows without starting PowerShell', () => {
  let started = false;
  assert.equal(tp.vaultKey({ platform: 'linux', run: () => { started = true; return { status: 0, stdout: 'x' }; } }), null);
  assert.equal(started, false);
});

test('vaultKey returns null when the entry is missing or PowerShell fails', () => {
  assert.equal(tp.vaultKey({ platform: 'win32', run: () => ({ status: 3, stdout: '' }) }), null);
  assert.equal(tp.vaultKey({ platform: 'win32', run: () => ({ error: new Error('ENOENT'), status: null }) }), null);
  assert.equal(tp.vaultKey({ platform: 'win32', run: () => ({ status: 0, stdout: '  \r\n' }) }), null);
  assert.equal(tp.vaultKey({ platform: 'win32', run: () => null }), null);
});

test('set-key prompts with a hidden SecureString, replaces the old entry and never prints the key', () => {
  const s = tp.VAULT_SET;
  assert.match(s, /Read-Host '[^']+' -AsSecureString/);
  assert.match(s, /\$v\.Remove\(\$c\)/);
  assert.match(s, /PasswordCredential\('jev', 'api-key', \$k\)/);
  assert.doesNotMatch(s, /Write-(Host|Output)\s+\$k|^\s*\$k\s*$/m);
  assert.equal(decode(tp.psEncode(s)), s);
});

test('scripts run by the pool never receive the Jev key', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jevpool-'));
  made.push(root);
  const prev = process.env.JEV_API_KEY;
  process.env.JEV_API_KEY = 'k-env';
  try {
    const r = await tp.runStep('env-probe', { command: 'node -e "process.exit(process.env.JEV_API_KEY ? 1 : 0)"', timeoutSec: 20 }, root, root, {});
    assert.equal(r.status, 'pass');
  } finally {
    if (prev === undefined) delete process.env.JEV_API_KEY; else process.env.JEV_API_KEY = prev;
  }
});
